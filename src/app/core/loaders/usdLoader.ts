import * as THREE from "three";
import type { UsdImportOptions } from "../usd/usdImportOptions";
import type { UsdModelSource } from "../editor/document/types";
import type { Pose, UrdfCollision, UrdfGeom, UrdfJoint, UrdfLink } from "../urdf/urdfModel";
import { basename, createAssetResolver } from "./assetResolver";
import { logInfo, logWarn } from "../services/logger";
import { useLoaderStore } from "../store/useLoaderStore";

export type USDLoaderParams = {
  usdUrl: string;
  usdKey: string;
  usdFile?: File;
  /** Resolved asset name for display */
  usdName?: string;
  resolveResource?: (resourcePath: string) => string | null;
  importOptions?: UsdImportOptions;
  /**
   * Optional: assetId returned by the usd-converter service after upload.
   * When provided, `usdKey` is used as the local asset key and `converterAssetId`
   * as the remote identifier for conversion requests.
   */
  converterAssetId?: string;
};

type MjcfGeomDef = {
  name: string;
  type: string;
  size: [number, number, number];
  pos: [number, number, number];
  quat: THREE.Quaternion;
  rgba?: [number, number, number, number];
};

type MjcfJointDef = {
  name: string;
  type: string;
  axis: [number, number, number];
  pos: [number, number, number];
  range?: [number, number];
};

type MjcfBodyDef = {
  name: string;
  pos: [number, number, number];
  quat: THREE.Quaternion;
  inertial?: {
    mass: number;
    inertia: [number, number, number];
  };
  geoms: MjcfGeomDef[];
  joints: MjcfJointDef[];
  children: MjcfBodyDef[];
};

type ParsedMjcf = {
  bodies: MjcfBodyDef[];
  actuatorsByJoint: Map<string, { type?: "position" | "velocity" | "torque"; stiffness?: number; damping?: number }>;
};

type UsdConverterUploadResponse = {
  assetId?: string;
  filename?: string;
};

type UsdConverterToMjcfResponse = {
  mjcfAssetId?: string;
  meta?: { assetId?: string; filename?: string };
};

const DEFAULT_USD_CONVERTER_BASE_URL = "http://localhost:8095";
const rawConverterBaseUrl = String(import.meta.env.VITE_USD_CONVERTER_BASE_URL ?? DEFAULT_USD_CONVERTER_BASE_URL).trim();
const usdConverterBaseUrl = rawConverterBaseUrl.replace(/\/+$/, "");
const usdConverterEnabled = usdConverterBaseUrl.length > 0;

const MAX_USD_TREE_NODES = 240;
const PRINTABLE_MIN = 0x20;
const PRINTABLE_MAX = 0x7e;
const REFERENCE_EXT_RE = /(?:^|[./\\])[A-Za-z0-9_.-]+\.(usd|usda|usdc|usdz)$/i;
const JOINT_NAME_RE = /(joint|dof|haa|hfe|kfe|hinge|slider|prismatic|revolute|actuator)/i;
const LINK_NAME_RE = /(link|base|hip|thigh|shank|foot|body|chassis|arm|wheel|sensor|payload|camera|imu|lidar)/i;
const PATH_SKIP_SEGMENTS = new Set([
  "properties",
  "primChildren",
  "apiSchemas",
  "customData",
  "defaultPrim",
  "displayName",
  "physics",
  "references",
  "sublayers",
  "xformOpOrder",
  "xformOp:translate",
  "xformOp:orient",
  "xformOp:scale",
]);
const FILE_EXT_SKIP_RE = /\.(png|jpg|jpeg|webp|tiff|bmp|hdr|exr|mtl|obj|stl|dae|fbx|gltf|glb|xml|mjcf)$/i;
const DEFAULT_VISUAL_RGBA: [number, number, number, number] = [0.72, 0.79, 0.9, 1];

type UsdPrimNode = {
  path: string;
  name: string;
  parentPath: string | null;
  kind: "group" | "link" | "joint";
};

const toTuple3 = (value: string | null | undefined, fallback: [number, number, number]): [number, number, number] => {
  if (!value) return fallback;
  const parts = value
    .trim()
    .split(/\s+/)
    .map((item) => Number(item));
  return [
    Number.isFinite(parts[0]) ? parts[0] : fallback[0],
    Number.isFinite(parts[1]) ? parts[1] : fallback[1],
    Number.isFinite(parts[2]) ? parts[2] : fallback[2],
  ];
};

const toTuple2 = (value: string | null | undefined): [number, number] | undefined => {
  if (!value) return undefined;
  const parts = value
    .trim()
    .split(/\s+/)
    .map((item) => Number(item));
  const a = Number.isFinite(parts[0]) ? parts[0] : null;
  const b = Number.isFinite(parts[1]) ? parts[1] : null;
  if (a === null || b === null) return undefined;
  return [a, b];
};

const toTuple4 = (value: string | null | undefined, fallback: [number, number, number, number]): [number, number, number, number] => {
  if (!value) return fallback;
  const parts = value
    .trim()
    .split(/\s+/)
    .map((item) => Number(item));
  return [
    Number.isFinite(parts[0]) ? parts[0] : fallback[0],
    Number.isFinite(parts[1]) ? parts[1] : fallback[1],
    Number.isFinite(parts[2]) ? parts[2] : fallback[2],
    Number.isFinite(parts[3]) ? parts[3] : fallback[3],
  ];
};

const toQuaternionFromMjcf = (value: string | null | undefined) => {
  const [w, x, y, z] = toTuple4(value, [1, 0, 0, 0]);
  const quat = new THREE.Quaternion(x, y, z, w);
  if (quat.lengthSq() <= 0) return new THREE.Quaternion();
  quat.normalize();
  return quat;
};

const toPose = (pos: [number, number, number], quat: THREE.Quaternion): Pose => {
  const euler = new THREE.Euler().setFromQuaternion(quat, "ZYX");
  return {
    xyz: [pos[0], pos[1], pos[2]],
    rpy: [euler.x, euler.y, euler.z],
  };
};

const claimName = (base: string, used: Set<string>, fallbackPrefix: string) => {
  const seed = (base || fallbackPrefix).trim() || fallbackPrefix;
  let candidate = seed;
  let index = 1;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${seed}_${index}`;
  }
  used.add(candidate);
  return candidate;
};

const convertMjcfJointTypeToUrdf = (jointType: string): string => {
  const normalized = jointType.trim().toLowerCase();
  if (normalized === "hinge") return "revolute";
  if (normalized === "slide") return "prismatic";
  if (normalized === "ball") return "continuous";
  if (normalized === "free") return "floating";
  if (normalized === "fixed") return "fixed";
  return "fixed";
};

const parseActuatorType = (tagName: string): "position" | "velocity" | "torque" | undefined => {
  const normalized = tagName.toLowerCase();
  if (normalized === "position") return "position";
  if (normalized === "velocity") return "velocity";
  if (normalized === "motor") return "torque";
  return undefined;
};

const parseMjcfActuators = (doc: Document) => {
  const map = new Map<string, { type?: "position" | "velocity" | "torque"; stiffness?: number; damping?: number }>();
  const root = doc.querySelector("mujoco > actuator") ?? doc.querySelector("actuator");
  if (!root) return map;
  for (const child of Array.from(root.children)) {
    const jointName = child.getAttribute("joint")?.trim();
    if (!jointName) continue;
    const type = parseActuatorType(child.tagName);
    const kp = Number(child.getAttribute("kp"));
    const kv = Number(child.getAttribute("kv"));
    map.set(jointName, {
      type,
      stiffness: Number.isFinite(kp) ? kp : undefined,
      damping: Number.isFinite(kv) ? kv : undefined,
    });
  }
  return map;
};

const parseMjcfBody = (bodyEl: Element, fallbackIndexRef: { value: number }): MjcfBodyDef => {
  fallbackIndexRef.value += 1;
  const fallbackName = `link_${fallbackIndexRef.value}`;
  const name = (bodyEl.getAttribute("name") ?? "").trim() || fallbackName;

  const pos = toTuple3(bodyEl.getAttribute("pos"), [0, 0, 0]);
  const quat = toQuaternionFromMjcf(bodyEl.getAttribute("quat"));

  const geoms: MjcfBodyDef["geoms"] = [];
  const joints: MjcfBodyDef["joints"] = [];
  const children: MjcfBodyDef["children"] = [];
  let inertial: MjcfBodyDef["inertial"];

  for (const child of Array.from(bodyEl.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === "inertial") {
      const massNum = Number(child.getAttribute("mass"));
      const mass = Number.isFinite(massNum) ? massNum : 1;
      const diaginertia = toTuple3(child.getAttribute("diaginertia"), [0.01, 0.01, 0.01]);
      inertial = { mass, inertia: diaginertia };
      continue;
    }

    if (tag === "geom") {
      const sizeTuple = toTuple3(child.getAttribute("size"), [0.05, 0.05, 0.05]);
      const rgba = toTuple4(child.getAttribute("rgba"), [NaN, NaN, NaN, NaN]);
      geoms.push({
        name: (child.getAttribute("name") ?? "").trim(),
        type: (child.getAttribute("type") ?? "sphere").trim().toLowerCase(),
        size: sizeTuple,
        pos: toTuple3(child.getAttribute("pos"), [0, 0, 0]),
        quat: toQuaternionFromMjcf(child.getAttribute("quat")),
        rgba: Number.isFinite(rgba[0])
          ? [
              Math.max(0, Math.min(1, rgba[0])),
              Math.max(0, Math.min(1, rgba[1])),
              Math.max(0, Math.min(1, rgba[2])),
              Math.max(0, Math.min(1, rgba[3])),
            ]
          : undefined,
      });
      continue;
    }

    if (tag === "joint") {
      fallbackIndexRef.value += 1;
      joints.push({
        name: (child.getAttribute("name") ?? "").trim() || `joint_${fallbackIndexRef.value}`,
        type: (child.getAttribute("type") ?? "hinge").trim().toLowerCase(),
        axis: toTuple3(child.getAttribute("axis"), [0, 0, 1]),
        pos: toTuple3(child.getAttribute("pos"), [0, 0, 0]),
        range: toTuple2(child.getAttribute("range")),
      });
      continue;
    }

    if (tag === "freejoint") {
      fallbackIndexRef.value += 1;
      joints.push({
        name: (child.getAttribute("name") ?? "").trim() || `free_joint_${fallbackIndexRef.value}`,
        type: "free",
        axis: [0, 0, 1],
        pos: [0, 0, 0],
      });
      continue;
    }

    if (tag === "body") {
      children.push(parseMjcfBody(child, fallbackIndexRef));
    }
  }

  return {
    name,
    pos,
    quat,
    inertial,
    geoms,
    joints,
    children,
  };
};

const parseMjcf = (mjcfXml: string): ParsedMjcf => {
  const parser = new DOMParser();
  const doc = parser.parseFromString(mjcfXml, "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("Failed to parse converted MJCF XML.");
  }

  const worldbody = doc.querySelector("mujoco > worldbody") ?? doc.querySelector("worldbody");
  if (!worldbody) {
    throw new Error("Converted MJCF has no <worldbody>.");
  }

  const fallbackIndexRef = { value: 0 };
  const bodies = Array.from(worldbody.children)
    .filter((el) => el.tagName.toLowerCase() === "body")
    .map((bodyEl) => parseMjcfBody(bodyEl, fallbackIndexRef));

  return {
    bodies,
    actuatorsByJoint: parseMjcfActuators(doc),
  };
};

const buildGeomGeometry = (geom: MjcfGeomDef): THREE.BufferGeometry => {
  const type = geom.type;
  const [sx, sy, sz] = geom.size;
  if (type === "box") {
    return new THREE.BoxGeometry(Math.max(1e-4, sx * 2), Math.max(1e-4, sy * 2), Math.max(1e-4, sz * 2));
  }
  if (type === "sphere") {
    return new THREE.SphereGeometry(Math.max(1e-4, sx), 20, 16);
  }
  if (type === "cylinder") {
    const geometry = new THREE.CylinderGeometry(Math.max(1e-4, sx), Math.max(1e-4, sx), Math.max(1e-4, sy * 2), 18);
    geometry.rotateX(Math.PI / 2);
    return geometry;
  }
  if (type === "capsule") {
    const radius = Math.max(1e-4, sx);
    const cylinderLength = Math.max(1e-4, sy * 2);
    const geometry = new THREE.CapsuleGeometry(radius, cylinderLength, 8, 16);
    geometry.rotateX(Math.PI / 2);
    return geometry;
  }
  if (type === "plane") {
    return new THREE.PlaneGeometry(Math.max(0.1, sx * 2), Math.max(0.1, sy * 2));
  }
  return new THREE.BoxGeometry(Math.max(1e-4, sx * 2), Math.max(1e-4, sy * 2), Math.max(1e-4, sz * 2));
};

const mjcfGeomToUrdfGeom = (geom: MjcfGeomDef): UrdfGeom => {
  const [sx, sy, sz] = geom.size;
  if (geom.type === "box") {
    return { kind: "box", size: [Math.max(1e-4, sx * 2), Math.max(1e-4, sy * 2), Math.max(1e-4, sz * 2)] };
  }
  if (geom.type === "sphere") {
    return { kind: "sphere", radius: Math.max(1e-4, sx) };
  }
  if (geom.type === "cylinder") {
    return { kind: "cylinder", radius: Math.max(1e-4, sx), length: Math.max(1e-4, sy * 2) };
  }
  if (geom.type === "capsule") {
    return { kind: "cylinder", radius: Math.max(1e-4, sx), length: Math.max(1e-4, sy * 2) };
  }
  return { kind: "box", size: [Math.max(1e-4, sx * 2), Math.max(1e-4, sy * 2), Math.max(1e-4, sz * 2)] };
};

const addMjcfGeomMeshes = (
  visualGroup: THREE.Group,
  collisionGroup: THREE.Group,
  geoms: MjcfGeomDef[],
  linkName: string,
  usedMeshNames: Set<string>
): { visuals: UrdfCollision[]; collisions: UrdfCollision[] } => {
  const visuals: UrdfCollision[] = [];
  const collisions: UrdfCollision[] = [];

  geoms.forEach((geom, index) => {
    const meshName = claimName(geom.name || `${linkName}_geom_${index + 1}`, usedMeshNames, `${linkName}_geom`);
    const geometry = buildGeomGeometry(geom);

    const rgba = geom.rgba ?? DEFAULT_VISUAL_RGBA;
    const visualMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color(rgba[0], rgba[1], rgba[2]),
      transparent: rgba[3] < 1,
      opacity: Math.max(0.05, Math.min(1, rgba[3])),
      metalness: 0.05,
      roughness: 0.78,
    });

    const collisionMaterial = new THREE.MeshBasicMaterial({
      color: 0x8c5a2b,
      transparent: true,
      opacity: 0.38,
      wireframe: false,
      depthWrite: false,
    });

    const visualMesh = new THREE.Mesh(geometry, visualMaterial);
    visualMesh.name = meshName;
    visualMesh.userData.editorKind = "mesh";
    visualMesh.position.set(geom.pos[0], geom.pos[1], geom.pos[2]);
    visualMesh.quaternion.copy(geom.quat);
    visualGroup.add(visualMesh);

    const collisionMesh = new THREE.Mesh(geometry.clone(), collisionMaterial);
    collisionMesh.name = `${meshName}_collision`;
    collisionMesh.userData.editorKind = "mesh";
    collisionMesh.position.set(geom.pos[0], geom.pos[1], geom.pos[2]);
    collisionMesh.quaternion.copy(geom.quat);
    collisionGroup.add(collisionMesh);

    const origin = toPose(geom.pos, geom.quat);
    const urdfGeom = mjcfGeomToUrdfGeom(geom);

    visuals.push({
      name: meshName,
      origin,
      geom: urdfGeom,
      rgba,
    });

    collisions.push({
      name: `${meshName}_collision`,
      origin,
      geom: urdfGeom,
    });
  });

  return { visuals, collisions };
};

const buildRobotFromMjcf = (
  parsed: ParsedMjcf,
  robotName: string
): { root: THREE.Group; linkCount: number; jointCount: number } => {
  const robotRoot = new THREE.Group();
  const robotRootFlagged = robotRoot as THREE.Group & { isRobot?: boolean };
  robotRoot.name = robotName;
  robotRootFlagged.isRobot = true;
  robotRoot.userData.editorRobotRoot = true;

  const usedLinkNames = new Set<string>();
  const usedJointNames = new Set<string>();
  const usedMeshNames = new Set<string>();
  let linkCount = 0;
  let jointCount = 0;

  const createLinkNode = (body: MjcfBodyDef, forcedName?: string) => {
    const linkName = claimName(forcedName ?? body.name, usedLinkNames, "Link");
    const link = new THREE.Group();
    const linkFlags = link as THREE.Group & { isURDFLink?: boolean; urdfName?: string };
    link.name = linkName;
    linkFlags.isURDFLink = true;
    linkFlags.urdfName = linkName;
    link.userData.editorKind = "link";

    const visual = new THREE.Group();
    const visualFlags = visual as THREE.Group & { isURDFVisual?: boolean; urdfName?: string };
    visual.name = "Visual";
    visualFlags.isURDFVisual = true;
    visualFlags.urdfName = `${linkName}__visual`;
    visual.userData.editorKind = "visual";

    const collision = new THREE.Group();
    const collisionFlags = collision as THREE.Group & { isURDFCollider?: boolean; urdfName?: string };
    collision.name = "Collision";
    collisionFlags.isURDFCollider = true;
    collisionFlags.urdfName = `${linkName}__collision`;
    collision.userData.editorKind = "collision";
    collision.visible = false;

    const geomData = addMjcfGeomMeshes(visual, collision, body.geoms, linkName, usedMeshNames);

    link.add(visual);
    link.add(collision);

    const urdfLink: UrdfLink = {
      name: linkName,
      visuals: geomData.visuals,
      collisions: geomData.collisions,
      inertial: body.inertial
        ? {
            origin: { xyz: [0, 0, 0], rpy: [0, 0, 0] },
            mass: body.inertial.mass,
            inertia: {
              ixx: body.inertial.inertia[0],
              iyy: body.inertial.inertia[1],
              izz: body.inertial.inertia[2],
              ixy: 0,
              ixz: 0,
              iyz: 0,
            },
          }
        : undefined,
    };

    link.userData.urdf = { kind: "link", link: urdfLink };
    if (body.inertial) {
      link.userData.physics = {
        ...(link.userData.physics ?? {}),
        mass: body.inertial.mass,
        inertia: {
          x: body.inertial.inertia[0],
          y: body.inertial.inertia[1],
          z: body.inertial.inertia[2],
        },
      };
    }

    linkCount += 1;
    return { link, linkName };
  };

  const attachBody = (
    body: MjcfBodyDef,
    parentLink: THREE.Group | null,
    parentLinkName: string | null,
    forcePoseOnLink: boolean
  ) => {
    const { link, linkName } = createLinkNode(body);

    if (!parentLink || !parentLinkName) {
      link.position.set(body.pos[0], body.pos[1], body.pos[2]);
      link.quaternion.copy(body.quat);
      robotRoot.add(link);
    } else {
      const rawJoint = body.joints.find((joint) => joint.type !== "free") ?? body.joints[0] ?? null;
      const implicitName = `${parentLinkName}_${linkName}_fixed`;
      const jointName = claimName(rawJoint?.name ?? implicitName, usedJointNames, "Joint");
      const jointType = convertMjcfJointTypeToUrdf(rawJoint?.type ?? "fixed");
      const jointAxis = rawJoint?.axis ?? [0, 0, 1];
      const actuator = rawJoint ? parsed.actuatorsByJoint.get(rawJoint.name) : undefined;

      const joint = new THREE.Group();
      const jointFlags = joint as THREE.Group & { isURDFJoint?: boolean; urdfName?: string };
      joint.name = jointName;
      jointFlags.isURDFJoint = true;
      jointFlags.urdfName = jointName;
      joint.userData.editorKind = "joint";
      joint.position.set(body.pos[0], body.pos[1], body.pos[2]);
      joint.quaternion.copy(body.quat);

      const jointOrigin = toPose(body.pos, body.quat);
      const urdfJoint: UrdfJoint = {
        name: jointName,
        type: jointType,
        parent: parentLinkName,
        child: linkName,
        origin: jointOrigin,
        axis: [jointAxis[0], jointAxis[1], jointAxis[2]],
        limit: rawJoint?.range ? { lower: rawJoint.range[0], upper: rawJoint.range[1] } : undefined,
        actuator: actuator
          ? {
              enabled: true,
              type: actuator.type,
              stiffness: actuator.stiffness,
              damping: actuator.damping,
            }
          : undefined,
      };

      joint.userData.urdf = { kind: "joint", joint: urdfJoint };

      if (forcePoseOnLink) {
        link.position.set(body.pos[0], body.pos[1], body.pos[2]);
        link.quaternion.copy(body.quat);
      }

      if (!forcePoseOnLink) {
        link.position.set(0, 0, 0);
        link.quaternion.identity();
      }

      parentLink.add(joint);
      joint.add(link);
      jointCount += 1;
    }

    for (const child of body.children) {
      attachBody(child, link, linkName, false);
    }
  };

  for (const body of parsed.bodies) {
    attachBody(body, null, null, true);
  }

  return { root: robotRoot, linkCount, jointCount };
};

const normalizeSlashPath = (value: string) => value.replace(/\\/g, "/").replace(/\/+/g, "/");

const normalizePrimPath = (value: string): string | null => {
  const cleaned = normalizeSlashPath(value.trim())
    .replace(/^["']+|["']+$/g, "")
    .replace(/^[./]+/, "")
    .replace(/^\/+/, "");
  if (!cleaned) return null;
  if (cleaned.includes("://")) return null;
  if (FILE_EXT_SKIP_RE.test(cleaned)) return null;
  const parts = cleaned
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  if (parts.some((part) => PATH_SKIP_SEGMENTS.has(part.toLowerCase()))) return null;
  if (parts.some((part) => !/^[A-Za-z0-9_.:-]+$/.test(part))) return null;
  return `/${parts.join("/")}`;
};

const pathDepth = (path: string) => path.split("/").filter(Boolean).length;

const extractPrintableTokens = (bytes: Uint8Array): string[] => {
  const out: string[] = [];
  let start = -1;
  const pushToken = (from: number, to: number) => {
    if (to - from < 4) return;
    let token = "";
    for (let i = from; i < to; i += 1) token += String.fromCharCode(bytes[i]);
    out.push(token);
  };
  for (let i = 0; i < bytes.length; i += 1) {
    const code = bytes[i];
    const printable = code >= PRINTABLE_MIN && code <= PRINTABLE_MAX;
    if (printable) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0) pushToken(start, i);
    start = -1;
  }
  if (start >= 0) pushToken(start, bytes.length);
  return out;
};

const extractPathCandidates = (tokens: string[]): string[] => {
  const out = new Set<string>();
  for (const token of tokens) {
    const normalized = normalizeSlashPath(token);
    const matches = normalized.match(/(?:\/|\.\/)?[A-Za-z0-9_.:-]+(?:\/[A-Za-z0-9_.:-]+)+/g);
    if (!matches) continue;
    for (const match of matches) {
      const path = normalizePrimPath(match);
      if (path) out.add(path);
    }
  }
  return Array.from(out);
};

const extractReferences = (tokens: string[]): string[] => {
  const refs = new Set<string>();
  for (const token of tokens) {
    if (!REFERENCE_EXT_RE.test(token)) continue;
    const normalized = normalizeSlashPath(token).replace(/^["']+|["']+$/g, "");
    if (!normalized || FILE_EXT_SKIP_RE.test(normalized)) continue;
    refs.add(normalized);
  }
  return Array.from(refs);
};

const classifyPrimKind = (name: string, path: string): UsdPrimNode["kind"] => {
  if (JOINT_NAME_RE.test(name) || JOINT_NAME_RE.test(path)) return "joint";
  if (LINK_NAME_RE.test(name) || LINK_NAME_RE.test(path)) return "link";
  return "group";
};

const readUsdBytes = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load USD (${response.status} ${response.statusText})`);
  return new Uint8Array(await response.arrayBuffer());
};

const buildPrimNodes = (paths: string[], rootHint: string): UsdPrimNode[] => {
  const unique = new Set<string>();
  for (const path of paths) {
    const normalized = normalizePrimPath(path);
    if (!normalized) continue;
    const parts = normalized.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      unique.add(current);
    }
  }

  if (!unique.size) {
    unique.add(`/${rootHint}`);
  }

  const sorted = Array.from(unique).sort((a, b) => pathDepth(a) - pathDepth(b) || a.localeCompare(b));
  const nodes: UsdPrimNode[] = [];
  for (const path of sorted.slice(0, MAX_USD_TREE_NODES)) {
    const parts = path.split("/").filter(Boolean);
    const name = parts[parts.length - 1] ?? rootHint;
    const parentPath = parts.length > 1 ? `/${parts.slice(0, -1).join("/")}` : null;
    nodes.push({
      path,
      name,
      parentPath,
      kind: classifyPrimKind(name, path),
    });
  }

  const hasLink = nodes.some((node) => node.kind === "link");
  if (!hasLink) {
    const hasChild = new Set(nodes.map((node) => node.parentPath).filter(Boolean) as string[]);
    for (const node of nodes) {
      if (node.kind !== "group") continue;
      if (!hasChild.has(node.path)) node.kind = "link";
    }
  }

  return nodes;
};

const addUsdHierarchyFallback = (robotRoot: THREE.Group, nodes: UsdPrimNode[]) => {
  const objectByPath = new Map<string, THREE.Group>();
  for (const node of nodes) {
    const group = new THREE.Group();
    group.name = node.name;
    group.userData.usdPrimPath = node.path;
    group.userData.usdPrimKind = node.kind;
    if (node.kind === "link" || node.kind === "joint") {
      group.userData.editorKind = node.kind;
    }
    objectByPath.set(node.path, group);
  }

  for (const node of nodes) {
    const group = objectByPath.get(node.path);
    if (!group) continue;
    if (node.parentPath) {
      const parent = objectByPath.get(node.parentPath);
      if (parent) {
        parent.add(group);
        continue;
      }
    }
    robotRoot.add(group);
  }
};

const fallbackUsdHierarchyFromTokens = async (
  robotName: string,
  usdUrl: string,
  resolveResource?: (resourcePath: string) => string | null
) => {
  const robotRoot = new THREE.Group();
  const robotRootFlagged = robotRoot as THREE.Group & { isRobot?: boolean };
  robotRoot.name = robotName;
  robotRootFlagged.isRobot = true;
  robotRoot.userData.editorRobotRoot = true;

  const allTokens: string[] = [];
  const visited = new Set<string>();
  const queue: string[] = [usdUrl];

  while (queue.length && visited.size < 8) {
    const current = queue.shift() as string;
    if (visited.has(current)) continue;
    visited.add(current);

    try {
      const bytes = await readUsdBytes(current);
      const tokens = extractPrintableTokens(bytes);
      allTokens.push(...tokens);
      const refs = extractReferences(tokens);
      for (const ref of refs) {
        const resolved = resolveResource?.(ref) ?? null;
        if (resolved && !visited.has(resolved)) queue.push(resolved);
      }
    } catch (error) {
      logWarn("USD: failed to inspect referenced layer", {
        scope: "usd",
        data: { url: current, error: String((error as Error)?.message ?? error) },
      });
    }
  }

  const rootHint = robotName.replace(/\.[^/.]+$/, "").split("/").pop() || "UsdRobot";
  const primPaths = extractPathCandidates(allTokens);
  const primNodes = buildPrimNodes(primPaths, rootHint);

  addUsdHierarchyFallback(robotRoot, primNodes);
  logWarn("USD fallback hierarchy used (converter unavailable or conversion failed).", {
    scope: "usd",
    data: { primCount: primNodes.length, pathCount: primPaths.length },
  });

  const placeholderGeom = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  const placeholderMat = new THREE.MeshBasicMaterial({
    color: 0x4a90d9,
    wireframe: true,
    transparent: true,
    opacity: 0.6,
  });
  const placeholder = new THREE.Mesh(placeholderGeom, placeholderMat);
  placeholder.name = "__usd_placeholder__";
  placeholder.userData.editorKind = "mesh";
  robotRoot.add(placeholder);

  return robotRoot;
};

const buildUsdConverterUrl = (path: string) => `${usdConverterBaseUrl}${path}`;

const ensureUsdFileForUpload = async (params: { usdFile?: File; usdUrl: string; usdKey: string }) => {
  if (params.usdFile instanceof File) return params.usdFile;
  const response = await fetch(params.usdUrl);
  if (!response.ok) {
    throw new Error(`Failed to read local USD file (${response.status} ${response.statusText})`);
  }
  const blob = await response.blob();
  const filename = basename(params.usdKey) || "robot.usd";
  return new File([blob], filename, { type: blob.type || "application/octet-stream" });
};

const convertUsdToMjcf = async (params: {
  usdUrl: string;
  usdKey: string;
  usdFile?: File;
  importOptions?: UsdImportOptions;
}) => {
  const file = await ensureUsdFileForUpload({ usdFile: params.usdFile, usdUrl: params.usdUrl, usdKey: params.usdKey });

  const uploadForm = new FormData();
  uploadForm.append("file", file, file.name);
  const uploadRes = await fetch(buildUsdConverterUrl("/v1/assets/usd"), {
    method: "POST",
    body: uploadForm,
  });
  if (!uploadRes.ok) {
    const text = await uploadRes.text();
    throw new Error(`USD converter upload failed (${uploadRes.status}): ${text || uploadRes.statusText}`);
  }
  const uploaded = (await uploadRes.json()) as UsdConverterUploadResponse;
  const converterAssetId = String(uploaded.assetId ?? "").trim();
  if (!converterAssetId) {
    throw new Error("USD converter did not return assetId after upload.");
  }

  const query = new URLSearchParams();
  query.set("floating_base", String(params.importOptions?.floatingBase ?? false));
  query.set("self_collision", String(params.importOptions?.selfCollision ?? false));

  const convertRes = await fetch(
    buildUsdConverterUrl(`/v1/assets/${encodeURIComponent(converterAssetId)}:convert-usd-to-mjcf?${query.toString()}`),
    {
      method: "POST",
    }
  );
  if (!convertRes.ok) {
    const text = await convertRes.text();
    throw new Error(`USD converter conversion failed (${convertRes.status}): ${text || convertRes.statusText}`);
  }
  const converted = (await convertRes.json()) as UsdConverterToMjcfResponse;
  const mjcfAssetId = String(converted.mjcfAssetId ?? converted.meta?.assetId ?? "").trim();
  if (!mjcfAssetId) {
    throw new Error("USD converter did not return mjcfAssetId.");
  }

  const mjcfRes = await fetch(buildUsdConverterUrl(`/v1/assets/${encodeURIComponent(mjcfAssetId)}`), {
    method: "GET",
  });
  if (!mjcfRes.ok) {
    const text = await mjcfRes.text();
    throw new Error(`USD converter MJCF download failed (${mjcfRes.status}): ${text || mjcfRes.statusText}`);
  }
  const mjcfXml = await mjcfRes.text();

  return {
    converterAssetId,
    mjcfAssetId,
    mjcfXml,
  };
};

export async function loadUSDObject(params: USDLoaderParams): Promise<THREE.Object3D> {
  const { usdUrl, usdKey, usdFile, usdName, resolveResource, importOptions, converterAssetId } = params;
  const displayName = usdName ?? (basename(usdKey) || usdKey);

  logInfo(`USD load: ${usdKey}`, { scope: "usd" });

  let root: THREE.Object3D | null = null;
  let resolvedConverterAssetId = converterAssetId ?? null;
  let resolvedMjcfAssetId: string | undefined;
  let mjcfXml: string | undefined;

  if (usdConverterEnabled) {
    try {
      const converted = await convertUsdToMjcf({
        usdUrl,
        usdKey,
        usdFile,
        importOptions,
      });
      resolvedConverterAssetId = converted.converterAssetId;
      resolvedMjcfAssetId = converted.mjcfAssetId;
      mjcfXml = converted.mjcfXml;

      const parsed = parseMjcf(mjcfXml);
      const built = buildRobotFromMjcf(parsed, displayName);
      root = built.root;

      logInfo("USD conversion + render completed", {
        scope: "usd",
        data: {
          usdKey,
          converterAssetId: resolvedConverterAssetId,
          mjcfAssetId: resolvedMjcfAssetId,
          links: built.linkCount,
          joints: built.jointCount,
        },
      });
    } catch (error) {
      logWarn("USD converter path failed; falling back to token hierarchy.", {
        scope: "usd",
        data: {
          usdKey,
          error: String((error as Error)?.message ?? error),
        },
      });
    }
  } else {
    logWarn("USD converter is disabled (empty VITE_USD_CONVERTER_BASE_URL). Using fallback hierarchy.", {
      scope: "usd",
    });
  }

  if (!root) {
    root = await fallbackUsdHierarchyFromTokens(displayName, usdUrl, resolveResource);
  }

  const modelSource: UsdModelSource = {
    kind: "usd",
    usdKey: resolvedConverterAssetId ?? usdKey,
    mjcfKey: resolvedMjcfAssetId,
    importOptions: importOptions ?? {},
    isDirty: false,
  };

  root.userData.robotModelSource = modelSource;
  root.userData.usdUrl = usdUrl;
  root.userData.usdWorkspaceKey = usdKey;
  if (resolvedConverterAssetId) root.userData.converterAssetId = resolvedConverterAssetId;
  if (resolvedMjcfAssetId) root.userData.mjcfAssetId = resolvedMjcfAssetId;
  if (mjcfXml) root.userData.mjcfSource = mjcfXml;

  return root;
}

export type USDImportDeps = {
  usdKey: string | null;
  assets: Record<string, { url: string; key: string; file?: File }>;
  importOptions?: USDLoaderParams["importOptions"];
};

export async function loadWorkspaceUSDIntoViewer(deps: USDImportDeps) {
  const { usdKey, assets, importOptions } = deps;

  if (!usdKey) {
    logWarn("USD load requested but no USD selected.", { scope: "usd" });
    alert("No USD selected. Import a folder/files with a .usd file and select it.");
    return;
  }

  const entry = assets[usdKey];
  if (!entry) {
    logWarn("Selected USD not found in workspace.", { scope: "usd", data: { usdKey } });
    alert("Selected USD not found in workspace.");
    return;
  }

  logInfo(`USD load requested: ${usdKey}`, { scope: "usd" });
  const resolveResource = createAssetResolver(assets, usdKey);

  await useLoaderStore.getState().load(
    "usd",
    {
      usdUrl: entry.url,
      usdKey,
      usdFile: entry.file,
      usdName: basename(usdKey),
      resolveResource,
      importOptions,
    } satisfies USDLoaderParams
  );
}
