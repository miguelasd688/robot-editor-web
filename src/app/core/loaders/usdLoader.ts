import * as THREE from "three";
import type { UsdImportOptions } from "../usd/usdImportOptions";
import type { UsdModelSource } from "../editor/document/types";
import type { Pose, UrdfCollision, UrdfGeom, UrdfJoint, UrdfLink } from "../urdf/urdfModel";
import { basename, createAssetResolver } from "./assetResolver";
import { logInfo, logWarn } from "../services/logger";
import { useLoaderStore } from "../store/useLoaderStore";
import { disposeObject3D } from "../viewer/objectRegistry";

export type USDLoaderParams = {
  usdUrl: string;
  usdKey: string;
  usdFile?: File;
  /** Resolved asset name for display */
  usdName?: string;
  /** Import role controls whether the root is treated as a robot or a generic scene asset. */
  sceneRole?: "robot" | "scene_asset";
  resolveResource?: (resourcePath: string) => string | null;
  importOptions?: UsdImportOptions;
  /**
   * Optional: assetId returned by the usd-converter service after upload.
   * When provided, `usdKey` is used as the local asset key and `converterAssetId`
   * as the remote identifier for conversion requests.
   */
  converterAssetId?: string;
  assetsByKey?: Record<string, UsdWorkspaceAssetEntry>;
  bundleHintPaths?: string[];
};

export type UsdWorkspaceAssetEntry = {
  url: string;
  key: string;
  file?: File;
};

type MjcfGeomDef = {
  name: string;
  type: string;
  size: [number, number, number];
  mesh?: string;
  pos: [number, number, number];
  quat: THREE.Quaternion;
  rgba?: [number, number, number, number];
};

type MjcfMeshAssetDef = {
  vertices: Float32Array;
  faces: Uint32Array;
};

type MjcfJointDef = {
  name: string;
  type: string;
  axis: [number, number, number];
  pos: [number, number, number];
  range?: [number, number];
  damping?: number;
  friction?: number;
  armature?: number;
};

type MjcfBodyDef = {
  name: string;
  pos: [number, number, number];
  quat: THREE.Quaternion;
  inertial?: {
    mass: number;
    origin: Pose;
    inertia: {
      ixx: number;
      iyy: number;
      izz: number;
      ixy: number;
      ixz: number;
      iyz: number;
    };
  };
  geoms: MjcfGeomDef[];
  joints: MjcfJointDef[];
  children: MjcfBodyDef[];
};

type ParsedMjcf = {
  bodies: MjcfBodyDef[];
  meshAssets: Map<string, MjcfMeshAssetDef>;
  actuatorsByJoint: Map<
    string,
    {
      type?: "position" | "velocity" | "torque" | "muscle";
      stiffness?: number;
      damping?: number;
      name?: string;
      sourceType?: string;
    }
  >;
};

type UsdConverterUploadResponse = {
  assetId?: string;
  filename?: string;
  entryFilename?: string;
};

type UsdConverterToMjcfResponse = {
  mjcfAssetId?: string;
  meta?: { assetId?: string; filename?: string };
  diagnostics?: unknown;
};

type UsdConverterIntrospectionJoint = {
  name?: string;
  type?: string;
  axis?: unknown;
  parentBody?: string | null;
  childBody?: string | null;
  parentBodyPath?: string | null;
  childBodyPath?: string | null;
  localPos0?: unknown;
  localRot0?: unknown;
  localPos1?: unknown;
  localRot1?: unknown;
  frame0Local?: unknown;
  frame1Local?: unknown;
  frame0World?: unknown;
  frame1World?: unknown;
  axisLocal?: unknown;
  axisWorld?: unknown;
  sourceUpAxis?: unknown;
  normalizedToZUp?: unknown;
  frameMismatchDistance?: unknown;
  frameMismatchWarning?: unknown;
  muscle?: unknown;
};

type UsdConverterIntrospectionResponse = {
  assetId?: string;
  filename?: string;
  joints?: UsdConverterIntrospectionJoint[];
  rootBodies?: string[];
  stageUpAxis?: string;
};

type UsdConverterMeshSceneMesh = {
  name?: string;
  primPath?: string;
  parentBody?: string | null;
  parentBodyPath?: string | null;
  position?: unknown;
  quaternion?: unknown;
  scale?: unknown;
  points?: unknown;
  triangles?: unknown;
  normals?: unknown;
  uvs?: unknown;
  rgba?: unknown;
  materialName?: unknown;
  materialSource?: unknown;
  baseColorTexture?: unknown;
};

type UsdConverterMeshScenePrimitive = {
  name?: string;
  primPath?: string;
  parentBody?: string | null;
  parentBodyPath?: string | null;
  kind?: string;
  position?: unknown;
  quaternion?: unknown;
  scale?: unknown;
  axis?: unknown;
  radius?: unknown;
  height?: unknown;
  size?: unknown;
  rgba?: unknown;
  materialName?: unknown;
  materialSource?: unknown;
  baseColorTexture?: unknown;
};

type UsdConverterMeshSceneBody = {
  name?: string;
  primPath?: string;
  parentBody?: string | null;
  parentBodyPath?: string | null;
  position?: unknown;
  quaternion?: unknown;
  scale?: unknown;
};

type UsdConverterMeshSceneResponse = {
  assetId?: string;
  filename?: string;
  stageUpAxis?: string;
  normalizedToZUp?: unknown;
  meshCount?: number;
  primitiveCount?: number;
  bodyCount?: number;
  truncated?: boolean;
  meshes?: UsdConverterMeshSceneMesh[];
  primitives?: UsdConverterMeshScenePrimitive[];
  bodies?: UsdConverterMeshSceneBody[];
};

type NormalizedIntrospectionJoint = {
  name: string;
  type: "revolute" | "prismatic" | "fixed" | "other";
  axis: [number, number, number];
  parentBody: string | null;
  childBody: string | null;
  parentBodyPath: string | null;
  childBodyPath: string | null;
  localPos0: [number, number, number] | null;
  localRot0: [number, number, number, number] | null; // xyzw
  localPos1: [number, number, number] | null;
  localRot1: [number, number, number, number] | null; // xyzw
  frame0Local: { position: [number, number, number]; quaternion: [number, number, number, number] } | null;
  frame1Local: { position: [number, number, number]; quaternion: [number, number, number, number] } | null;
  frame0World: { position: [number, number, number]; quaternion: [number, number, number, number] } | null;
  frame1World: { position: [number, number, number]; quaternion: [number, number, number, number] } | null;
  axisLocal: [number, number, number] | null;
  axisWorld: [number, number, number] | null;
  sourceUpAxis: "X" | "Y" | "Z" | "unknown";
  normalizedToZUp: boolean;
  frameMismatchDistance: number | null;
  frameMismatchWarning: string | null;
  muscle:
    | {
        enabled: boolean;
        endA: { body: string | null; localPos: [number, number, number] };
        endB: { body: string | null; localPos: [number, number, number] };
        range?: [number, number];
        force?: number;
        scale?: number;
        damping?: number;
      }
    | null;
};

type NormalizedUsdIntrospection = {
  assetId: string;
  filename: string;
  joints: NormalizedIntrospectionJoint[];
  rootBodies: string[];
  stageUpAxis: "X" | "Y" | "Z" | "unknown";
};

type NormalizedUsdMeshSceneMesh = {
  name: string;
  primPath: string;
  parentBody: string | null;
  position: [number, number, number];
  quaternion: THREE.Quaternion;
  scale: [number, number, number];
  points: Float32Array;
  triangles: Uint32Array;
  normals: Float32Array | null;
  uvs: Float32Array | null;
  rgba: [number, number, number, number] | null;
  materialName: string | null;
  materialSource: string | null;
  baseColorTexture: string | null;
};

type NormalizedUsdMeshScenePrimitiveKind = "sphere" | "capsule" | "cylinder" | "cone" | "cube";

type NormalizedUsdMeshScenePrimitive = {
  name: string;
  primPath: string;
  parentBody: string | null;
  kind: NormalizedUsdMeshScenePrimitiveKind;
  position: [number, number, number];
  quaternion: THREE.Quaternion;
  scale: [number, number, number];
  axis: "X" | "Y" | "Z";
  radius: number | null;
  height: number | null;
  size: [number, number, number] | null;
  rgba: [number, number, number, number] | null;
  materialName: string | null;
  materialSource: string | null;
  baseColorTexture: string | null;
};

type NormalizedUsdMeshSceneBody = {
  name: string;
  primPath: string;
  parentBody: string | null;
  position: [number, number, number];
  quaternion: THREE.Quaternion;
  scale: [number, number, number];
};

type NormalizedUsdMeshScene = {
  assetId: string;
  filename: string;
  stageUpAxis: "X" | "Y" | "Z" | "unknown";
  normalizedToZUp: boolean;
  meshCount: number;
  primitiveCount: number;
  bodyCount: number;
  truncated: boolean;
  meshes: NormalizedUsdMeshSceneMesh[];
  primitives: NormalizedUsdMeshScenePrimitive[];
  bodies: NormalizedUsdMeshSceneBody[];
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
const ISAAC_LAB_DEFAULT_SURFACE_FRICTION = 1.0;
const ISAAC_LAB_DEFAULT_SURFACE_RESTITUTION = 0.0;
const BUNDLE_FALLBACK_INCLUDE_EXT_RE = /\.(usd|usda|usdc|usdz|png|jpg|jpeg|webp|tif|tiff|bmp|hdr|exr|mtl|obj|stl|dae|fbx|gltf|glb)$/i;
const ABSOLUTE_URL_RE = /^(?:https?:\/\/|blob:|data:)/i;
const usdTextureLoader = new THREE.TextureLoader();
const usdTextureCache = new Map<string, THREE.Texture>();

type UsdPrimNode = {
  path: string;
  name: string;
  parentPath: string | null;
  kind: "group" | "link" | "joint";
};

const stripFileExtension = (name: string) => name.replace(/\.[^/.]+$/, "");

const retagUsdRootAsSceneAsset = (root: THREE.Object3D, sceneAssetName: string) => {
  const rootWithRobotFlag = root as THREE.Object3D & { isRobot?: boolean };
  if (rootWithRobotFlag.isRobot) {
    delete rootWithRobotFlag.isRobot;
  }
  root.name = sceneAssetName;
  if (root.userData && Object.prototype.hasOwnProperty.call(root.userData, "editorRobotRoot")) {
    delete root.userData.editorRobotRoot;
  }
  if (root.userData && Object.prototype.hasOwnProperty.call(root.userData, "robotModelSource")) {
    delete root.userData.robotModelSource;
  }
  root.userData.editorKind = "group";
  root.userData.usdSceneAsset = true;
};

const applySceneAssetPhysicsDefaults = (root: THREE.Object3D) => {
  root.traverse((node) => {
    const isLink = node.userData?.editorKind === "link" || Boolean((node as THREE.Object3D & { isURDFLink?: boolean }).isURDFLink);
    if (!isLink) return;
    const currentPhysics =
      node.userData?.physics && typeof node.userData.physics === "object" && !Array.isArray(node.userData.physics)
        ? (node.userData.physics as Record<string, unknown>)
        : {};
    node.userData.physics = {
      ...currentPhysics,
      mass: 0,
      fixed: true,
      useDensity: false,
      collisionsEnabled: true,
      friction: ISAAC_LAB_DEFAULT_SURFACE_FRICTION,
      restitution: ISAAC_LAB_DEFAULT_SURFACE_RESTITUTION,
    };
  });
};

export type CollectedUsdBundleFile = {
  path: string;
  file: File;
  contentType: string;
};

export type CollectedUsdBundle = {
  entryPath: string;
  files: CollectedUsdBundleFile[];
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

const normalizeAxisTuple = (axis: [number, number, number]): [number, number, number] => {
  const vec = new THREE.Vector3(
    Number.isFinite(axis[0]) ? axis[0] : 0,
    Number.isFinite(axis[1]) ? axis[1] : 0,
    Number.isFinite(axis[2]) ? axis[2] : 1
  );
  if (vec.lengthSq() <= 1e-12) return [0, 0, 1];
  vec.normalize();
  return [vec.x, vec.y, vec.z];
};

const axisInJointFrame = (
  axisParentLocal: [number, number, number],
  jointFrameQuat: THREE.Quaternion | null | undefined
): [number, number, number] => {
  const normalized = normalizeAxisTuple(axisParentLocal);
  if (!jointFrameQuat || jointFrameQuat.lengthSq() <= 1e-12) return normalized;
  const axisVec = new THREE.Vector3(normalized[0], normalized[1], normalized[2]);
  axisVec.applyQuaternion(jointFrameQuat.clone().invert());
  if (axisVec.lengthSq() <= 1e-12) return [0, 0, 1];
  axisVec.normalize();
  return [axisVec.x, axisVec.y, axisVec.z];
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

const convertMjcfJointTypeToUrdf = (jointType: string, hasRange: boolean): string => {
  const normalized = jointType.trim().toLowerCase();
  if (normalized === "hinge") return hasRange ? "revolute" : "continuous";
  if (normalized === "slide") return "prismatic";
  if (normalized === "ball") return "continuous";
  if (normalized === "free") return "floating";
  if (normalized === "fixed") return "fixed";
  return "fixed";
};

const parseActuatorType = (tagName: string): "position" | "velocity" | "torque" | "muscle" | undefined => {
  const normalized = tagName.toLowerCase();
  if (normalized === "position") return "position";
  if (normalized === "velocity") return "velocity";
  if (normalized === "muscle") return "muscle";
  if (normalized === "motor" || normalized === "general") return "torque";
  return undefined;
};

const parseMjcfActuators = (doc: Document) => {
  const map = new Map<
    string,
    {
      type?: "position" | "velocity" | "torque" | "muscle";
      stiffness?: number;
      damping?: number;
      name?: string;
      sourceType?: string;
    }
  >();
  const root = doc.querySelector("mujoco > actuator") ?? doc.querySelector("actuator");
  if (!root) return map;
  for (const child of Array.from(root.children)) {
    const jointName = child.getAttribute("joint")?.trim() || child.getAttribute("jointinparent")?.trim();
    if (!jointName) continue;
    if (map.has(jointName)) continue;
    const type = parseActuatorType(child.tagName);
    const kp = Number(child.getAttribute("kp"));
    const kv = Number(child.getAttribute("kv"));
    map.set(jointName, {
      type,
      stiffness: Number.isFinite(kp) ? kp : undefined,
      damping: Number.isFinite(kv) ? kv : undefined,
      name: child.getAttribute("name")?.trim() || undefined,
      sourceType: child.tagName.toLowerCase(),
    });
  }
  return map;
};

const parseNumericArray = (value: string | null | undefined): number[] => {
  if (!value) return [];
  return value
    .trim()
    .split(/\s+/)
    .map((token) => Number(token))
    .filter((num) => Number.isFinite(num));
};

const parseMjcfMeshAssets = (doc: Document): Map<string, MjcfMeshAssetDef> => {
  const out = new Map<string, MjcfMeshAssetDef>();
  const assetRoot = doc.querySelector("mujoco > asset") ?? doc.querySelector("asset");
  if (!assetRoot) return out;
  for (const child of Array.from(assetRoot.children)) {
    if (child.tagName.toLowerCase() !== "mesh") continue;
    const meshName = String(child.getAttribute("name") ?? "").trim();
    if (!meshName || out.has(meshName)) continue;
    const vertexData = parseNumericArray(child.getAttribute("vertex"));
    const faceData = parseNumericArray(child.getAttribute("face"));
    if (vertexData.length < 9 || faceData.length < 3) continue;
    const vertexCount = Math.floor(vertexData.length / 3);
    const faceCount = Math.floor(faceData.length / 3);
    if (vertexCount < 3 || faceCount < 1) continue;

    const vertices = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount * 3; i += 1) vertices[i] = Number(vertexData[i] ?? 0);

    const faces = new Uint32Array(faceCount * 3);
    let valid = true;
    for (let i = 0; i < faceCount * 3; i += 1) {
      const idx = Math.floor(Number(faceData[i] ?? -1));
      if (!Number.isFinite(idx) || idx < 0 || idx >= vertexCount) {
        valid = false;
        break;
      }
      faces[i] = idx;
    }
    if (!valid) continue;
    out.set(meshName, { vertices, faces });
  }
  return out;
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
      const inertialPos = toTuple3(child.getAttribute("pos"), [0, 0, 0]);
      const inertialQuat = toQuaternionFromMjcf(child.getAttribute("quat"));
      const diaginertia = toTuple3(child.getAttribute("diaginertia"), [0.01, 0.01, 0.01]);
      const fullInertiaRaw = (child.getAttribute("fullinertia") ?? "")
        .trim()
        .split(/\s+/)
        .map((value) => Number(value));
      const hasFullInertia = fullInertiaRaw.length >= 6 && fullInertiaRaw.slice(0, 6).every((value) => Number.isFinite(value));
      inertial = {
        mass,
        origin: toPose(inertialPos, inertialQuat),
        inertia: hasFullInertia
          ? {
              ixx: fullInertiaRaw[0],
              iyy: fullInertiaRaw[1],
              izz: fullInertiaRaw[2],
              ixy: fullInertiaRaw[3],
              ixz: fullInertiaRaw[4],
              iyz: fullInertiaRaw[5],
            }
          : {
              ixx: diaginertia[0],
              iyy: diaginertia[1],
              izz: diaginertia[2],
              ixy: 0,
              ixz: 0,
              iyz: 0,
            },
      };
      continue;
    }

    if (tag === "geom") {
      const geomType = (child.getAttribute("type") ?? "sphere").trim().toLowerCase();
      const sizeTuple = toTuple3(child.getAttribute("size"), geomType === "mesh" ? [1, 1, 1] : [0.05, 0.05, 0.05]);
      const rgba = toTuple4(child.getAttribute("rgba"), [NaN, NaN, NaN, NaN]);
      geoms.push({
        name: (child.getAttribute("name") ?? "").trim(),
        type: geomType,
        size: sizeTuple,
        mesh: child.getAttribute("mesh")?.trim() || undefined,
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
      const damping = Number(child.getAttribute("damping"));
      const friction = Number(child.getAttribute("frictionloss"));
      const armature = Number(child.getAttribute("armature"));
      joints.push({
        name: (child.getAttribute("name") ?? "").trim() || `joint_${fallbackIndexRef.value}`,
        type: (child.getAttribute("type") ?? "hinge").trim().toLowerCase(),
        axis: toTuple3(child.getAttribute("axis"), [0, 0, 1]),
        pos: toTuple3(child.getAttribute("pos"), [0, 0, 0]),
        range: toTuple2(child.getAttribute("range")),
        damping: Number.isFinite(damping) ? damping : undefined,
        friction: Number.isFinite(friction) ? friction : undefined,
        armature: Number.isFinite(armature) ? armature : undefined,
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
  const meshAssets = parseMjcfMeshAssets(doc);

  return {
    bodies,
    meshAssets,
    actuatorsByJoint: parseMjcfActuators(doc),
  };
};

const formatMjcfNumber = (value: number) => (Number.isFinite(value) ? value : 0).toFixed(6);

const formatMjcfVec3 = (value: [number, number, number]) =>
  `${formatMjcfNumber(value[0])} ${formatMjcfNumber(value[1])} ${formatMjcfNumber(value[2])}`;

const formatMjcfQuatWxyz = (value: THREE.Quaternion) =>
  `${formatMjcfNumber(value.w)} ${formatMjcfNumber(value.x)} ${formatMjcfNumber(value.y)} ${formatMjcfNumber(value.z)}`;

const applyMeshSceneBodyPosesToMjcf = (
  mjcfXml: string,
  meshScene: NormalizedUsdMeshScene | null
): { mjcfXml: string; updatedBodyCount: number } => {
  if (!meshScene || meshScene.bodies.length === 0) return { mjcfXml, updatedBodyCount: 0 };

  const parser = new DOMParser();
  const doc = parser.parseFromString(mjcfXml, "application/xml");
  if (doc.querySelector("parsererror")) return { mjcfXml, updatedBodyCount: 0 };

  const bodyLookup = new Map<string, NormalizedUsdMeshSceneBody>();
  for (const body of meshScene.bodies) {
    const token = normalizeBodyToken(body.name) ?? body.name;
    if (!token) continue;
    if (!bodyLookup.has(token)) bodyLookup.set(token, body);
  }

  let updatedBodyCount = 0;
  for (const element of Array.from(doc.querySelectorAll("body"))) {
    const name = String(element.getAttribute("name") ?? "").trim();
    if (!name) continue;
    const token = normalizeBodyToken(name) ?? name;
    const source = bodyLookup.get(token);
    if (!source) continue;
    element.setAttribute("pos", formatMjcfVec3(source.position));
    element.setAttribute("quat", formatMjcfQuatWxyz(source.quaternion));
    updatedBodyCount += 1;
  }

  if (updatedBodyCount === 0) return { mjcfXml, updatedBodyCount: 0 };

  return {
    mjcfXml: new XMLSerializer().serializeToString(doc),
    updatedBodyCount,
  };
};

const buildGeomGeometry = (
  geom: MjcfGeomDef,
  meshAssets?: Map<string, MjcfMeshAssetDef>
): THREE.BufferGeometry => {
  const type = geom.type;
  const [sx, sy, sz] = geom.size;
  if (type === "mesh" && geom.mesh && meshAssets?.has(geom.mesh)) {
    const meshAsset = meshAssets.get(geom.mesh) as MjcfMeshAssetDef;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(meshAsset.vertices), 3));
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(meshAsset.faces), 1));
    geometry.scale(Math.max(1e-8, sx), Math.max(1e-8, sy), Math.max(1e-8, sz));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }
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
  if (geom.type === "mesh" && geom.mesh) {
    return {
      kind: "mesh",
      file: geom.mesh,
      scale: [Math.max(1e-8, sx), Math.max(1e-8, sy), Math.max(1e-8, sz)],
    };
  }
  return { kind: "box", size: [Math.max(1e-4, sx * 2), Math.max(1e-4, sy * 2), Math.max(1e-4, sz * 2)] };
};

const addMjcfGeomMeshes = (
  visualGroup: THREE.Group | null,
  collisionGroup: THREE.Group | null,
  geoms: MjcfGeomDef[],
  meshAssets: Map<string, MjcfMeshAssetDef> | undefined,
  linkName: string,
  usedMeshNames: Set<string>
): { visuals: UrdfCollision[]; collisions: UrdfCollision[] } => {
  const visuals: UrdfCollision[] = [];
  const collisions: UrdfCollision[] = [];

  geoms.forEach((geom, index) => {
    const meshName = claimName(geom.name || `${linkName}_geom_${index + 1}`, usedMeshNames, `${linkName}_geom`);
    const geometry = buildGeomGeometry(geom, meshAssets);

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

    if (visualGroup) {
      const visualMesh = new THREE.Mesh(geometry, visualMaterial);
      visualMesh.name = meshName;
      visualMesh.userData.editorKind = "mesh";
      visualMesh.position.set(geom.pos[0], geom.pos[1], geom.pos[2]);
      visualMesh.quaternion.copy(geom.quat);
      visualGroup.add(visualMesh);
    }

    if (collisionGroup) {
      const collisionMesh = new THREE.Mesh(geometry.clone(), collisionMaterial);
      collisionMesh.name = `${meshName}_collision`;
      collisionMesh.userData.editorKind = "mesh";
      collisionMesh.position.set(geom.pos[0], geom.pos[1], geom.pos[2]);
      collisionMesh.quaternion.copy(geom.quat);
      collisionGroup.add(collisionMesh);
    }

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
  robotName: string,
  options?: { instantiateRenderGroups?: boolean; introspection?: NormalizedUsdIntrospection | null }
): { root: THREE.Group; linkCount: number; jointCount: number } => {
  const robotRoot = new THREE.Group();
  const robotRootFlagged = robotRoot as THREE.Group & { isRobot?: boolean };
  robotRoot.name = robotName;
  robotRootFlagged.isRobot = true;
  robotRoot.userData.editorRobotRoot = true;

  const usedLinkNames = new Set<string>();
  const usedJointNames = new Set<string>();
  const usedMeshNames = new Set<string>();
  const instantiateRenderGroups = options?.instantiateRenderGroups !== false;
  const introspectionJoints = options?.introspection?.joints ?? [];
  const usedIntrospectionJointIndexes = new Set<number>();
  let linkCount = 0;
  let jointCount = 0;

  const normalizeJointToken = (value: string | null | undefined) => {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    return raw.replace(/[^A-Za-z0-9_.:-]/g, "_");
  };

  const toNormalizedFrameLocal = (
    frame:
      | { position: [number, number, number]; quaternion: [number, number, number, number] }
      | null
      | undefined
  ): { position: [number, number, number]; quaternion: THREE.Quaternion } | null => {
    if (!frame) return null;
    const quat = new THREE.Quaternion(
      frame.quaternion[0],
      frame.quaternion[1],
      frame.quaternion[2],
      frame.quaternion[3]
    );
    if (quat.lengthSq() <= 1e-9) {
      quat.identity();
    } else {
      quat.normalize();
    }
    return {
      position: [frame.position[0], frame.position[1], frame.position[2]],
      quaternion: quat,
    };
  };

  const resolveIntrospectionJoint = (
    rawJoint: MjcfJointDef | null,
    parentLinkName: string,
    childLinkName: string
  ): { index: number; joint: NormalizedIntrospectionJoint } | null => {
    const tryMatchByIndex = (index: number) => {
      if (usedIntrospectionJointIndexes.has(index)) return null;
      return { index, joint: introspectionJoints[index] };
    };

    const rawJointNameToken = normalizeJointToken(rawJoint?.name);
    if (rawJointNameToken) {
      for (let index = 0; index < introspectionJoints.length; index += 1) {
        const candidate = introspectionJoints[index];
        if (normalizeJointToken(candidate.name) !== rawJointNameToken) continue;
        const matched = tryMatchByIndex(index);
        if (matched) return matched;
      }
    }

    const parentToken = normalizeBodyToken(parentLinkName) ?? parentLinkName;
    const childToken = normalizeBodyToken(childLinkName) ?? childLinkName;
    for (let index = 0; index < introspectionJoints.length; index += 1) {
      const candidate = introspectionJoints[index];
      const candidateParent = normalizeBodyToken(candidate.parentBody) ?? candidate.parentBody ?? "";
      const candidateChild = normalizeBodyToken(candidate.childBody) ?? candidate.childBody ?? "";
      if (candidateParent !== parentToken || candidateChild !== childToken) continue;
      const matched = tryMatchByIndex(index);
      if (matched) return matched;
    }

    return null;
  };

  const createLinkNode = (body: MjcfBodyDef, forcedName?: string) => {
    const linkName = claimName(forcedName ?? body.name, usedLinkNames, "Link");
    const link = new THREE.Group();
    const linkFlags = link as THREE.Group & { isURDFLink?: boolean; urdfName?: string };
    link.name = linkName;
    linkFlags.isURDFLink = true;
    linkFlags.urdfName = linkName;
    link.userData.editorKind = "link";

    const visual = instantiateRenderGroups ? new THREE.Group() : null;
    if (visual) {
      const visualFlags = visual as THREE.Group & { isURDFVisual?: boolean; urdfName?: string };
      visual.name = "Visual";
      visualFlags.isURDFVisual = true;
      visualFlags.urdfName = `${linkName}__visual`;
      visual.userData.editorKind = "visual";
    }

    const collision = instantiateRenderGroups ? new THREE.Group() : null;
    if (collision) {
      const collisionFlags = collision as THREE.Group & { isURDFCollider?: boolean; urdfName?: string };
      collision.name = "Collision";
      collisionFlags.isURDFCollider = true;
      collisionFlags.urdfName = `${linkName}__collision`;
      collision.userData.editorKind = "collision";
      collision.visible = false;
    }

    const geomData = addMjcfGeomMeshes(visual, collision, body.geoms, parsed.meshAssets, linkName, usedMeshNames);

    if (visual) link.add(visual);
    if (collision) link.add(collision);

    const urdfLink: UrdfLink = {
      name: linkName,
      visuals: geomData.visuals,
      collisions: geomData.collisions,
      inertial: body.inertial
        ? {
            origin: body.inertial.origin,
            mass: body.inertial.mass,
            inertia: {
              ixx: body.inertial.inertia.ixx,
              iyy: body.inertial.inertia.iyy,
              izz: body.inertial.inertia.izz,
              ixy: body.inertial.inertia.ixy,
              ixz: body.inertial.inertia.ixz,
              iyz: body.inertial.inertia.iyz,
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
          x: body.inertial.inertia.ixx,
          y: body.inertial.inertia.iyy,
          z: body.inertial.inertia.izz,
        },
        inertiaTensor: {
          ixx: body.inertial.inertia.ixx,
          iyy: body.inertial.inertia.iyy,
          izz: body.inertial.inertia.izz,
          ixy: body.inertial.inertia.ixy,
          ixz: body.inertial.inertia.ixz,
          iyz: body.inertial.inertia.iyz,
        },
        com: {
          x: body.inertial.origin.xyz[0],
          y: body.inertial.origin.xyz[1],
          z: body.inertial.origin.xyz[2],
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
      const jointType = convertMjcfJointTypeToUrdf(rawJoint?.type ?? "fixed", Boolean(rawJoint?.range));
      const introspectionMatch = resolveIntrospectionJoint(rawJoint, parentLinkName, linkName);
      const introspectionJoint = introspectionMatch?.joint ?? null;
      if (introspectionMatch) usedIntrospectionJointIndexes.add(introspectionMatch.index);
      const frame0Local = toNormalizedFrameLocal(
        introspectionJoint?.frame0Local ??
          (introspectionJoint?.localPos0 && introspectionJoint.localRot0
            ? { position: introspectionJoint.localPos0, quaternion: introspectionJoint.localRot0 }
            : null)
      );
      const frame1Local = toNormalizedFrameLocal(
        introspectionJoint?.frame1Local ??
          (introspectionJoint?.localPos1 && introspectionJoint.localRot1
            ? { position: introspectionJoint.localPos1, quaternion: introspectionJoint.localRot1 }
            : null)
      );
      const hasFramePair = Boolean(frame0Local && frame1Local);
      const rawJointAxis = introspectionJoint?.axisLocal ?? introspectionJoint?.axis ?? rawJoint?.axis ?? [0, 0, 1];
      const jointAxis = frame0Local
        ? axisInJointFrame([rawJointAxis[0], rawJointAxis[1], rawJointAxis[2]], frame0Local.quaternion)
        : normalizeAxisTuple([rawJointAxis[0], rawJointAxis[1], rawJointAxis[2]]);
      const actuator = rawJoint ? parsed.actuatorsByJoint.get(rawJoint.name) : undefined;
      const muscleFromActuator =
        actuator?.type === "muscle"
          ? {
              enabled: true,
              endA: { body: parentLinkName, localPos: [0, 0, 0] as [number, number, number] },
              endB: { body: linkName, localPos: [0, 0, 0] as [number, number, number] },
              range: [0, 1] as [number, number],
              force: 1,
              scale: 1,
              damping: 0,
              showLine: true,
              showTube: false,
            }
          : undefined;

      const joint = new THREE.Group();
      const jointFlags = joint as THREE.Group & { isURDFJoint?: boolean; urdfName?: string };
      joint.name = jointName;
      jointFlags.isURDFJoint = true;
      jointFlags.urdfName = jointName;
      joint.userData.editorKind = "joint";
      const jointPosePosition = frame0Local?.position ?? body.pos;
      const jointPoseQuaternion = frame0Local?.quaternion ?? body.quat;
      joint.position.set(jointPosePosition[0], jointPosePosition[1], jointPosePosition[2]);
      joint.quaternion.copy(jointPoseQuaternion);

      const jointOrigin = toPose(jointPosePosition, jointPoseQuaternion);
      const sourceFrames = introspectionJoint
        ? {
            frame0Local: introspectionJoint.frame0Local ?? undefined,
            frame1Local: introspectionJoint.frame1Local ?? undefined,
            frame0World: introspectionJoint.frame0World ?? undefined,
            frame1World: introspectionJoint.frame1World ?? undefined,
            axisLocal: introspectionJoint.axisLocal ?? undefined,
            axisWorld: introspectionJoint.axisWorld ?? undefined,
            sourceUpAxis: introspectionJoint.sourceUpAxis,
            normalizedToZUp: introspectionJoint.normalizedToZUp,
            frameMismatchDistance: introspectionJoint.frameMismatchDistance ?? undefined,
            frameMismatchWarning: introspectionJoint.frameMismatchWarning ?? undefined,
          }
        : undefined;
      const urdfJoint: UrdfJoint = {
        name: jointName,
        type: jointType,
        parent: parentLinkName,
        child: linkName,
        origin: jointOrigin,
        axis: [jointAxis[0], jointAxis[1], jointAxis[2]],
        limit: rawJoint?.range ? { lower: rawJoint.range[0], upper: rawJoint.range[1] } : undefined,
        dynamics:
          Number.isFinite(rawJoint?.damping) || Number.isFinite(rawJoint?.friction) || Number.isFinite(rawJoint?.armature)
            ? {
                damping: rawJoint?.damping,
                friction: rawJoint?.friction,
                armature: rawJoint?.armature,
              }
            : undefined,
        actuator: actuator
          ? {
              enabled: true,
              name: actuator.name,
              sourceType: actuator.sourceType,
              type: actuator.type,
              stiffness: actuator.stiffness,
              damping: actuator.damping,
            }
          : undefined,
        sourceFrames,
        muscle: muscleFromActuator,
      };

      joint.userData.urdf = { kind: "joint", joint: urdfJoint };

      if (hasFramePair && frame1Local) {
        const childQuat = frame1Local.quaternion.clone().invert();
        const childPos = new THREE.Vector3(
          -frame1Local.position[0],
          -frame1Local.position[1],
          -frame1Local.position[2]
        ).applyQuaternion(childQuat);
        link.position.set(childPos.x, childPos.y, childPos.z);
        link.quaternion.copy(childQuat);
      } else if (forcePoseOnLink) {
        link.position.set(body.pos[0], body.pos[1], body.pos[2]);
        link.quaternion.copy(body.quat);
      } else {
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

const buildUsdMeshGeometry = (mesh: NormalizedUsdMeshSceneMesh) => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(mesh.points, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.triangles, 1));
  if (mesh.normals && mesh.normals.length === mesh.points.length) {
    geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
  } else {
    geometry.computeVertexNormals();
  }
  if (mesh.uvs && mesh.uvs.length * 3 === mesh.points.length * 2) {
    geometry.setAttribute("uv", new THREE.BufferAttribute(mesh.uvs, 2));
  }
  geometry.computeBoundingSphere();
  return geometry;
};

const resolveUsdTextureUrl = (
  texturePath: string | null,
  resolveResource?: (resourcePath: string) => string | null
) => {
  const normalized = normalizeTextureAssetPath(texturePath);
  if (!normalized) return null;
  if (ABSOLUTE_URL_RE.test(normalized)) return normalized;
  return resolveResource?.(normalized) ?? null;
};

const getOrLoadUsdTexture = (url: string) => {
  const cached = usdTextureCache.get(url);
  if (cached) return cached;
  const texture = usdTextureLoader.load(url);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  usdTextureCache.set(url, texture);
  return texture;
};

const createUsdVisualMaterial = (
  rgba: [number, number, number, number] | null,
  options?: { textureUrl?: string | null; materialName?: string | null }
) => {
  const colorRgba = rgba ?? DEFAULT_VISUAL_RGBA;
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(colorRgba[0], colorRgba[1], colorRgba[2]),
    transparent: colorRgba[3] < 1,
    opacity: Math.max(0.05, Math.min(1, colorRgba[3])),
    metalness: 0.05,
    roughness: 0.78,
    side: THREE.DoubleSide,
  });

  const textureUrl = options?.textureUrl ?? null;
  if (textureUrl) {
    material.map = getOrLoadUsdTexture(textureUrl);
    material.needsUpdate = true;
  }
  if (options?.materialName) {
    material.name = options.materialName;
  }
  return material;
};

const createUsdCollisionMaterial = () =>
  new THREE.MeshBasicMaterial({
    color: 0x8c5a2b,
    transparent: true,
    opacity: 0.38,
    wireframe: false,
    depthWrite: false,
  });

const createUsdVisualMesh = (
  mesh: NormalizedUsdMeshSceneMesh,
  options?: { textureUrl?: string | null }
) => {
  const geometry = buildUsdMeshGeometry(mesh);
  const material = createUsdVisualMaterial(mesh.rgba, {
    textureUrl: options?.textureUrl ?? null,
    materialName: mesh.materialName,
  });
  const visualMesh = new THREE.Mesh(geometry, material);
  visualMesh.name = mesh.name;
  visualMesh.userData.editorKind = "mesh";
  visualMesh.userData.usdPrimPath = mesh.primPath;
  visualMesh.userData.usdMaterialInfo = {
    materialName: mesh.materialName,
    materialSource: mesh.materialSource,
    baseColorTexture: mesh.baseColorTexture,
    textureUrl: options?.textureUrl ?? null,
    editable: !options?.textureUrl,
  };
  visualMesh.position.set(mesh.position[0], mesh.position[1], mesh.position[2]);
  visualMesh.quaternion.copy(mesh.quaternion);
  visualMesh.scale.set(mesh.scale[0], mesh.scale[1], mesh.scale[2]);
  return visualMesh;
};

const createUsdCollisionMeshFromVisual = (visualMesh: THREE.Mesh) => {
  const collisionMesh = new THREE.Mesh(visualMesh.geometry.clone(), createUsdCollisionMaterial());
  collisionMesh.name = `${visualMesh.name}_collision`;
  collisionMesh.userData.editorKind = "mesh";
  collisionMesh.userData.usdPrimPath = visualMesh.userData?.usdPrimPath;
  collisionMesh.position.copy(visualMesh.position);
  collisionMesh.quaternion.copy(visualMesh.quaternion);
  collisionMesh.scale.copy(visualMesh.scale);
  return collisionMesh;
};

const buildUsdPrimitiveGeometry = (primitive: NormalizedUsdMeshScenePrimitive): THREE.BufferGeometry | null => {
  if (primitive.kind === "sphere" && primitive.radius) {
    return new THREE.SphereGeometry(Math.max(1e-5, primitive.radius), 24, 18);
  }
  if (primitive.kind === "capsule" && primitive.radius && primitive.height) {
    return new THREE.CapsuleGeometry(Math.max(1e-5, primitive.radius), Math.max(0, primitive.height), 10, 18);
  }
  if (primitive.kind === "cylinder" && primitive.radius && primitive.height) {
    return new THREE.CylinderGeometry(
      Math.max(1e-5, primitive.radius),
      Math.max(1e-5, primitive.radius),
      Math.max(1e-6, primitive.height),
      20,
      1
    );
  }
  if (primitive.kind === "cone" && primitive.radius && primitive.height) {
    return new THREE.ConeGeometry(Math.max(1e-5, primitive.radius), Math.max(1e-6, primitive.height), 20, 1);
  }
  if (primitive.kind === "cube" && primitive.size) {
    return new THREE.BoxGeometry(
      Math.max(1e-6, primitive.size[0]),
      Math.max(1e-6, primitive.size[1]),
      Math.max(1e-6, primitive.size[2])
    );
  }
  return null;
};

const axisTokenToVector = (axis: "X" | "Y" | "Z") => {
  if (axis === "X") return new THREE.Vector3(1, 0, 0);
  if (axis === "Y") return new THREE.Vector3(0, 1, 0);
  return new THREE.Vector3(0, 0, 1);
};

const createUsdVisualPrimitive = (
  primitive: NormalizedUsdMeshScenePrimitive,
  options?: { textureUrl?: string | null }
) => {
  const geometry = buildUsdPrimitiveGeometry(primitive);
  if (!geometry) return null;

  const visualMesh = new THREE.Mesh(
    geometry,
    createUsdVisualMaterial(primitive.rgba, {
      textureUrl: options?.textureUrl ?? null,
      materialName: primitive.materialName,
    })
  );
  visualMesh.name = primitive.name;
  visualMesh.userData.editorKind = "mesh";
  visualMesh.userData.usdPrimPath = primitive.primPath;
  visualMesh.userData.usdMaterialInfo = {
    materialName: primitive.materialName,
    materialSource: primitive.materialSource,
    baseColorTexture: primitive.baseColorTexture,
    textureUrl: options?.textureUrl ?? null,
    editable: !options?.textureUrl,
  };
  visualMesh.position.set(primitive.position[0], primitive.position[1], primitive.position[2]);

  const orientByAxis = primitive.kind === "capsule" || primitive.kind === "cylinder" || primitive.kind === "cone";
  if (orientByAxis) {
    const axisQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axisTokenToVector(primitive.axis));
    visualMesh.quaternion.copy(primitive.quaternion).multiply(axisQuat);
  } else {
    visualMesh.quaternion.copy(primitive.quaternion);
  }

  visualMesh.scale.set(primitive.scale[0], primitive.scale[1], primitive.scale[2]);
  return visualMesh;
};

type UsdLinkRenderGroupEntry = {
  link: THREE.Group;
  visual: THREE.Group;
  collision: THREE.Group;
  preparedForUsd: boolean;
};

const configureVisualGroup = (group: THREE.Group, linkName: string) => {
  const visualFlags = group as THREE.Group & { isURDFVisual?: boolean; isURDFCollider?: boolean; urdfName?: string };
  group.name = "Visual";
  visualFlags.isURDFVisual = true;
  visualFlags.isURDFCollider = false;
  visualFlags.urdfName = `${linkName}__visual`;
  group.userData.editorKind = "visual";
  group.userData.urdfRole = "visual";
};

const configureCollisionGroup = (group: THREE.Group, linkName: string, selfCollisionEnabled: boolean) => {
  const collisionFlags = group as THREE.Group & { isURDFVisual?: boolean; isURDFCollider?: boolean; urdfName?: string };
  group.name = "Collision";
  collisionFlags.isURDFVisual = false;
  collisionFlags.isURDFCollider = true;
  collisionFlags.urdfName = `${linkName}__collision`;
  group.userData.editorKind = "collision";
  group.userData.urdfRole = "collision";
  group.userData.selfCollisionEnabled = selfCollisionEnabled;
  group.visible = false;
};

const groupLooksVisual = (group: THREE.Group) => {
  const anyGroup = group as THREE.Group & { isURDFVisual?: boolean };
  return anyGroup.isURDFVisual === true || group.userData.editorKind === "visual" || group.name === "Visual" || group.name === "USDVisual";
};

const groupLooksCollision = (group: THREE.Group) => {
  const anyGroup = group as THREE.Group & { isURDFCollider?: boolean };
  return (
    anyGroup.isURDFCollider === true ||
    group.userData.editorKind === "collision" ||
    group.name === "Collision" ||
    group.name === "USDCollision"
  );
};

const clearGroupChildren = (group: THREE.Group) => {
  const children = [...group.children];
  for (const child of children) {
    group.remove(child);
    disposeObject3D(child);
  }
};

const ensureStandardLinkRenderGroups = (
  link: THREE.Group,
  selfCollisionEnabled: boolean
): { visual: THREE.Group; collision: THREE.Group } => {
  const directGroups = link.children.filter((child): child is THREE.Group => child instanceof THREE.Group);
  const visualCandidates = directGroups.filter(groupLooksVisual);
  const collisionCandidates = directGroups.filter(groupLooksCollision);

  const visual = visualCandidates[0] ?? new THREE.Group();
  if (!visual.parent) link.add(visual);
  configureVisualGroup(visual, link.name);

  const collisionSeed = collisionCandidates[0] ?? new THREE.Group();
  const collision = collisionSeed === visual ? new THREE.Group() : collisionSeed;
  if (!collision.parent) link.add(collision);
  configureCollisionGroup(collision, link.name, selfCollisionEnabled);

  for (const candidate of visualCandidates.slice(1)) {
    candidate.removeFromParent();
    disposeObject3D(candidate);
  }
  for (const candidate of collisionCandidates.slice(1)) {
    candidate.removeFromParent();
    disposeObject3D(candidate);
  }

  return { visual, collision };
};

const collectUsdLinkGroups = (root: THREE.Object3D, selfCollisionEnabled: boolean) => {
  const links = new Map<string, UsdLinkRenderGroupEntry>();
  const bind = (token: string | null, entry: UsdLinkRenderGroupEntry) => {
    if (!token) return;
    if (!links.has(token)) links.set(token, entry);
  };

  root.traverse((node) => {
    if (!(node instanceof THREE.Group)) return;
    if (node.userData.editorKind !== "link") return;

    const ensured = ensureStandardLinkRenderGroups(node, selfCollisionEnabled);
    const entry: UsdLinkRenderGroupEntry = {
      link: node,
      visual: ensured.visual,
      collision: ensured.collision,
      preparedForUsd: false,
    };

    bind(node.name, entry);
    bind(normalizeBodyToken(node.name), entry);

    const urdfName = String((node as THREE.Group & { urdfName?: string }).urdfName ?? "").trim();
    if (urdfName) {
      bind(urdfName, entry);
      bind(normalizeBodyToken(urdfName), entry);
    }
  });
  return links;
};

const IDENTITY_QUAT = new THREE.Quaternion(0, 0, 0, 1);

const hasLikelyCollapsedJointLayout = (root: THREE.Object3D) => {
  let jointCount = 0;
  let jointsWithPose = 0;
  root.traverse((node) => {
    if (!(node instanceof THREE.Group)) return;
    if (node.userData.editorKind !== "joint") return;
    jointCount += 1;
    const hasPosition = node.position.lengthSq() > 1e-10;
    const hasRotation = node.quaternion.angleTo(IDENTITY_QUAT) > 1e-4;
    if (hasPosition || hasRotation) jointsWithPose += 1;
  });
  if (jointCount === 0) return false;
  return jointsWithPose / jointCount < 0.1;
};

const applyUsdBodyPosesToCollapsedLinks = (root: THREE.Object3D, meshScene: NormalizedUsdMeshScene | null) => {
  if (!meshScene || meshScene.bodies.length === 0) return 0;
  const links = collectUsdLinkGroups(root, false);
  const bodyByName = new Map(meshScene.bodies.map((body) => [normalizeBodyToken(body.name) ?? body.name, body]));

  const resolveSceneParentLinkToken = (link: THREE.Group): string | null => {
    let current: THREE.Object3D | null = link.parent;
    while (current) {
      if (current instanceof THREE.Group && current.userData.editorKind === "link") {
        return normalizeBodyToken(current.name);
      }
      current = current.parent;
    }
    return null;
  };

  const computeRelativePose = (
    child: NormalizedUsdMeshSceneBody,
    parent: NormalizedUsdMeshSceneBody
  ): { position: [number, number, number]; quaternion: THREE.Quaternion } => {
    const childPos = new THREE.Vector3(child.position[0], child.position[1], child.position[2]);
    const parentPos = new THREE.Vector3(parent.position[0], parent.position[1], parent.position[2]);
    const parentInv = parent.quaternion.clone().invert();
    const relPos = childPos.sub(parentPos).applyQuaternion(parentInv);
    const relQuat = parentInv.multiply(child.quaternion.clone()).normalize();
    return {
      position: [relPos.x, relPos.y, relPos.z],
      quaternion: relQuat,
    };
  };

  const resolveTargetLocalPose = (
    body: NormalizedUsdMeshSceneBody,
    parentToken: string | null
  ): { position: [number, number, number]; quaternion: THREE.Quaternion } => {
    const payloadParentToken = normalizeBodyToken(body.parentBody);
    if (payloadParentToken) {
      // Converter payload is already local-to-parent when explicit parentBody is present.
      return { position: body.position, quaternion: body.quaternion };
    }
    if (!parentToken) {
      return { position: body.position, quaternion: body.quaternion };
    }
    const parentBody = bodyByName.get(parentToken);
    if (!parentBody) {
      return { position: body.position, quaternion: body.quaternion };
    }
    return computeRelativePose(body, parentBody);
  };

  const hasCollapsedLayout = hasLikelyCollapsedJointLayout(root);
  let comparableJoints = 0;
  let currentToLocalError = 0;
  let currentToGlobalError = 0;

  for (const body of meshScene.bodies) {
    const bodyToken = normalizeBodyToken(body.name);
    if (!bodyToken) continue;
    const linkEntry = links.get(bodyToken);
    if (!linkEntry) continue;
    const link = linkEntry.link;
    if (!(link.parent instanceof THREE.Group) || link.parent.userData.editorKind !== "joint") continue;
    const joint = link.parent;

    const sceneParentToken = resolveSceneParentLinkToken(link);
    const payloadParentToken = normalizeBodyToken(body.parentBody);
    const parentToken = payloadParentToken ?? sceneParentToken;
    const targetLocal = resolveTargetLocalPose(body, parentToken);

    const currentPos = joint.position;
    const localPos = new THREE.Vector3(targetLocal.position[0], targetLocal.position[1], targetLocal.position[2]);
    const globalPos = new THREE.Vector3(body.position[0], body.position[1], body.position[2]);

    currentToLocalError += currentPos.distanceTo(localPos) + joint.quaternion.angleTo(targetLocal.quaternion) * 0.25;
    currentToGlobalError += currentPos.distanceTo(globalPos) + joint.quaternion.angleTo(body.quaternion) * 0.25;
    comparableJoints += 1;
  }

  const looksGlobalInLocalSlots =
    comparableJoints >= 3 &&
    currentToLocalError > comparableJoints * 0.05 &&
    currentToGlobalError + 1e-6 < currentToLocalError * 0.9;
  if (!hasCollapsedLayout && !looksGlobalInLocalSlots) return 0;

  let applied = 0;

  for (const body of meshScene.bodies) {
    const bodyToken = normalizeBodyToken(body.name);
    if (!bodyToken) continue;
    const linkEntry = links.get(bodyToken);
    if (!linkEntry) continue;
    const link = linkEntry.link;

    const sceneParentToken = resolveSceneParentLinkToken(link);
    const payloadParentToken = normalizeBodyToken(body.parentBody);
    const parentToken = payloadParentToken ?? sceneParentToken;
    const hasKnownParent = Boolean(parentToken && links.has(parentToken));

    const targetLocal = resolveTargetLocalPose(body, parentToken);
    const localPosition = targetLocal.position;
    const localQuaternion = targetLocal.quaternion;

    if (hasKnownParent && link.parent instanceof THREE.Group && link.parent.userData.editorKind === "joint") {
      const joint = link.parent;
      joint.position.set(localPosition[0], localPosition[1], localPosition[2]);
      joint.quaternion.copy(localQuaternion);
      link.position.set(0, 0, 0);
      link.quaternion.identity();
    } else {
      link.position.set(localPosition[0], localPosition[1], localPosition[2]);
      link.quaternion.copy(localQuaternion);
    }
    link.scale.set(body.scale[0], body.scale[1], body.scale[2]);
    applied += 1;
  }

  return applied;
};

const attachUsdMeshSceneToRoot = (
  root: THREE.Object3D,
  meshScene: NormalizedUsdMeshScene | null,
  options?: {
    selfCollisionEnabled?: boolean;
    resolveResource?: (resourcePath: string) => string | null;
    attachCollisionProxies?: boolean;
    replaceExisting?: boolean;
  }
) => {
  if (!meshScene || (meshScene.meshes.length === 0 && meshScene.primitives.length === 0)) {
    return { attachedMeshes: 0, attachedPrimitives: 0, attachedToLinks: 0, attachedToRoot: 0 };
  }

  const selfCollisionEnabled = options?.selfCollisionEnabled === true;
  const attachCollisionProxies = options?.attachCollisionProxies !== false;
  const replaceExisting = options?.replaceExisting === true;
  const links = collectUsdLinkGroups(root, selfCollisionEnabled);
  const uniqueLinks = new Set(Array.from(links.values()).map((entry) => entry.link));
  const singleLinkToken = uniqueLinks.size === 1 ? normalizeBodyToken(Array.from(uniqueLinks)[0]?.name) : null;
  const usedNodeNames = new Set<string>();
  root.traverse((node) => {
    const name = String(node.name ?? "").trim();
    if (name) usedNodeNames.add(name);
  });

  let rootOrphans: { container: THREE.Group; visual: THREE.Group; collision: THREE.Group } | null = null;
  let attachedMeshes = 0;
  let attachedPrimitives = 0;
  let attachedToLinks = 0;
  let attachedToRoot = 0;
  let materialsBound = 0;
  let texturedMaterials = 0;
  const targetsWithMeshVisual = new Set<string>();
  const seenUsdItems = new Set<string>();
  const targetPrimaryMeshCount = new Map<string, number>();

  if (replaceExisting) {
    const preparedEntries = new Set(Array.from(links.values()));
    for (const entry of preparedEntries) {
      clearGroupChildren(entry.visual);
      configureVisualGroup(entry.visual, entry.link.name);
      if (attachCollisionProxies) {
        clearGroupChildren(entry.collision);
        configureCollisionGroup(entry.collision, entry.link.name, selfCollisionEnabled);
      }
      entry.preparedForUsd = true;
    }
  }

  const isAuxiliaryVisualCandidate = (value: { name: string; primPath: string }) => {
    const token = `${value.name} ${value.primPath}`.toLowerCase();
    const hasAuxToken = /(^|[\/_.:-])aux(\d+)?($|[\/_.:-])/.test(token);
    const hasCollisionToken =
      /(^|[\/_.:-])(collision|collider|proxy|physics|physx|contact|approx)($|[\/_.:-])/.test(token);
    return hasAuxToken || hasCollisionToken;
  };

  const ensureRootOrphans = () => {
    if (rootOrphans) return rootOrphans;
    const container = new THREE.Group();
    container.name = "__USDOrphans__";
    container.userData.usdOrphans = true;

    const visual = new THREE.Group();
    configureVisualGroup(visual, "__usd_orphans__");
    clearGroupChildren(visual);
    container.add(visual);

    const collision = new THREE.Group();
    configureCollisionGroup(collision, "__usd_orphans__", selfCollisionEnabled);
    clearGroupChildren(collision);
    container.add(collision);

    root.add(container);
    rootOrphans = { container, visual, collision };
    return rootOrphans;
  };

  const inferTokenFromPrimPath = (primPath: string) => {
    const tokenized = String(primPath ?? "")
      .split("/")
      .map((item) => normalizeBodyToken(item))
      .filter((item): item is string => Boolean(item));
    for (let i = tokenized.length - 1; i >= 0; i -= 1) {
      const token = tokenized[i];
      if (links.has(token)) return token;
    }
    return singleLinkToken;
  };

  const resolveTargetToken = (parentBody: string | null, primPath: string) => {
    const parentToken = normalizeBodyToken(parentBody);
    if (parentToken && links.has(parentToken)) return parentToken;
    const inferred = inferTokenFromPrimPath(primPath);
    if (inferred && links.has(inferred)) return inferred;
    return null;
  };

  for (const mesh of meshScene.meshes) {
    const targetToken = resolveTargetToken(mesh.parentBody, mesh.primPath);
    const targetKey = targetToken ?? "__root__";
    if (isAuxiliaryVisualCandidate({ name: mesh.name, primPath: mesh.primPath })) continue;
    targetPrimaryMeshCount.set(targetKey, (targetPrimaryMeshCount.get(targetKey) ?? 0) + 1);
  }

  const ensurePreparedEntry = (entry: UsdLinkRenderGroupEntry) => {
    if (entry.preparedForUsd) return;
    clearGroupChildren(entry.visual);
    configureVisualGroup(entry.visual, entry.link.name);
    if (attachCollisionProxies) {
      clearGroupChildren(entry.collision);
      configureCollisionGroup(entry.collision, entry.link.name, selfCollisionEnabled);
    }
    entry.preparedForUsd = true;
  };

  const attachPair = (visual: THREE.Mesh, collision: THREE.Mesh | null, targetToken: string | null) => {
    const visualName = claimName(visual.name || "usd_mesh", usedNodeNames, "usd_mesh");
    visual.name = visualName;
    if (collision) {
      collision.name = claimName(`${visualName}_collision`, usedNodeNames, "usd_collision");
      collision.userData.selfCollisionEnabled = selfCollisionEnabled;
    }

    if (targetToken && links.has(targetToken)) {
      const entry = links.get(targetToken) as UsdLinkRenderGroupEntry;
      ensurePreparedEntry(entry);
      entry.visual.add(visual);
      if (collision && attachCollisionProxies) entry.collision.add(collision);
      attachedToLinks += 1;
      return;
    }

    const orphans = ensureRootOrphans();
    orphans.visual.add(visual);
    if (collision && attachCollisionProxies) orphans.collision.add(collision);
    attachedToRoot += 1;
  };

  const numericSignature = (values: number[]) => values.map((value) => value.toFixed(6)).join(",");
  const meshTransformKey = (obj: {
    position: [number, number, number];
    quaternion: THREE.Quaternion;
    scale: [number, number, number];
  }) =>
    `${numericSignature(obj.position)}|${numericSignature([
      obj.quaternion.w,
      obj.quaternion.x,
      obj.quaternion.y,
      obj.quaternion.z,
    ])}|${numericSignature(obj.scale)}`;

  for (const mesh of meshScene.meshes) {
    const targetToken = resolveTargetToken(mesh.parentBody, mesh.primPath);
    const targetKey = targetToken ?? "__root__";
    const auxiliary = isAuxiliaryVisualCandidate({ name: mesh.name, primPath: mesh.primPath });
    if (auxiliary && (targetPrimaryMeshCount.get(targetKey) ?? 0) > 0) continue;

    const meshNameKey = String(mesh.name || mesh.primPath || "").trim().toLowerCase();
    const dedupeKey = `mesh|${targetKey}|${meshNameKey}|${meshTransformKey(mesh)}|${mesh.points.length}|${mesh.triangles.length}`;
    if (seenUsdItems.has(dedupeKey)) continue;
    seenUsdItems.add(dedupeKey);

    const textureUrl = resolveUsdTextureUrl(mesh.baseColorTexture, options?.resolveResource);
    if (mesh.materialName || mesh.materialSource || textureUrl) materialsBound += 1;
    if (textureUrl) texturedMaterials += 1;
    const visual = createUsdVisualMesh(mesh, { textureUrl });
    const collision = attachCollisionProxies ? createUsdCollisionMeshFromVisual(visual) : null;
    attachPair(visual, collision, targetToken);
    targetsWithMeshVisual.add(targetKey);
    attachedMeshes += 1;
  }
  for (const primitive of meshScene.primitives) {
    const targetToken = resolveTargetToken(primitive.parentBody, primitive.primPath);
    const targetKey = targetToken ?? "__root__";
    if ((targetPrimaryMeshCount.get(targetKey) ?? 0) > 0 && targetsWithMeshVisual.has(targetKey)) continue;
    if (isAuxiliaryVisualCandidate({ name: primitive.name, primPath: primitive.primPath })) continue;

    const primitiveDims = primitive.size
      ? primitive.size.map((value) => value.toFixed(6)).join(",")
      : `${primitive.radius?.toFixed(6) ?? "na"}:${primitive.height?.toFixed(6) ?? "na"}`;
    const primitiveNameKey = String(primitive.name || primitive.primPath || "").trim().toLowerCase();
    const dedupeKey = `primitive|${targetKey}|${primitiveNameKey}|${primitive.kind}|${meshTransformKey(primitive)}|${primitiveDims}`;
    if (seenUsdItems.has(dedupeKey)) continue;
    seenUsdItems.add(dedupeKey);

    const textureUrl = resolveUsdTextureUrl(primitive.baseColorTexture, options?.resolveResource);
    if (primitive.materialName || primitive.materialSource || textureUrl) materialsBound += 1;
    if (textureUrl) texturedMaterials += 1;
    const visualPrimitive = createUsdVisualPrimitive(primitive, { textureUrl });
    if (!visualPrimitive) continue;
    const collisionPrimitive = attachCollisionProxies ? createUsdCollisionMeshFromVisual(visualPrimitive) : null;
    attachPair(visualPrimitive, collisionPrimitive, targetToken);
    attachedPrimitives += 1;
  }

  root.userData.usdMeshScene = {
    assetId: meshScene.assetId,
    filename: meshScene.filename,
    stageUpAxis: meshScene.stageUpAxis,
    normalizedToZUp: meshScene.normalizedToZUp,
    meshCount: meshScene.meshCount,
    primitiveCount: meshScene.primitiveCount,
    bodyCount: meshScene.bodyCount,
    truncated: meshScene.truncated,
    attachedMeshes,
    attachedPrimitives,
    attachedToLinks,
    attachedToRoot,
    selfCollisionEnabled,
    attachCollisionProxies,
    materialsBound,
    texturedMaterials,
  };

  return { attachedMeshes, attachedPrimitives, attachedToLinks, attachedToRoot };
};

const normalizeSlashPath = (value: string) => value.replace(/\\/g, "/").replace(/\/+/g, "/");

const stripQueryAndHash = (value: string) => value.replace(/[?#].*$/, "");

const normalizeBundlePath = (value: string): string | null => {
  const normalized = normalizeSlashPath(stripQueryAndHash(value).trim());
  if (!normalized) return null;
  const rawParts = normalized.replace(/^\/+/, "").split("/");
  const parts: string[] = [];
  for (const rawPart of rawParts) {
    const part = rawPart.trim();
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0) {
        parts.pop();
      }
      continue;
    }
    parts.push(part);
  }
  if (!parts.length) return null;
  return parts.join("/");
};

const dirnameBundlePath = (value: string) => {
  const normalized = normalizeBundlePath(value);
  if (!normalized) return "";
  const slash = normalized.lastIndexOf("/");
  if (slash < 0) return "";
  return normalized.slice(0, slash);
};

const resolveReferenceBundlePath = (basePath: string, reference: string): string | null => {
  const normalizedRef = normalizeSlashPath(stripQueryAndHash(reference).trim());
  if (!normalizedRef) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalizedRef)) return null;
  if (normalizedRef.startsWith("//")) return null;
  if (normalizedRef.startsWith("/")) return normalizeBundlePath(normalizedRef);
  const baseDir = dirnameBundlePath(basePath);
  return normalizeBundlePath(baseDir ? `${baseDir}/${normalizedRef}` : normalizedRef);
};

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

const createFileFromBytes = (bytes: Uint8Array, path: string, fallbackType = "application/octet-stream") => {
  const name = path.split("/").pop() ?? "asset.usd";
  // Create a non-shared backing buffer to satisfy DOM File BlobPart typing.
  const stable = new Uint8Array(bytes.byteLength);
  stable.set(bytes);
  return new File([stable], name, { type: fallbackType });
};

const resolveWorkspaceKeyFromUrl = (
  urlToKey: Map<string, string>,
  resolvedUrl: string,
  basePath: string,
  reference: string
) => {
  const fromUrl = urlToKey.get(resolvedUrl);
  if (fromUrl) return fromUrl;
  const fromReference = resolveReferenceBundlePath(basePath, reference);
  return fromReference;
};

const hasHiddenBundleSegment = (path: string) =>
  path
    .split("/")
    .map((item) => item.trim())
    .filter(Boolean)
    .some((item) => item.startsWith("."));

const isBundleFallbackCandidatePath = (path: string) => {
  if (hasHiddenBundleSegment(path)) return false;
  return BUNDLE_FALLBACK_INCLUDE_EXT_RE.test(path.toLowerCase());
};

const parseStageUpAxis = (value: unknown): "X" | "Y" | "Z" | "unknown" => {
  const axis = String(value ?? "").trim().toUpperCase();
  if (axis === "X" || axis === "Y" || axis === "Z") return axis;
  return "unknown";
};

const parseJointType = (value: unknown): NormalizedIntrospectionJoint["type"] => {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "revolute" || raw === "prismatic" || raw === "fixed") return raw;
  return "other";
};

const parseJointAxis = (value: unknown): [number, number, number] => {
  const raw = Array.isArray(value) ? value : [];
  const x = Number(raw[0]);
  const y = Number(raw[1]);
  const z = Number(raw[2]);
  const axis: [number, number, number] = [
    Number.isFinite(x) ? x : 0,
    Number.isFinite(y) ? y : 0,
    Number.isFinite(z) ? z : 1,
  ];
  const length = Math.sqrt(axis[0] ** 2 + axis[1] ** 2 + axis[2] ** 2);
  if (!Number.isFinite(length) || length <= 1e-9) return [0, 0, 1];
  return [axis[0] / length, axis[1] / length, axis[2] / length];
};

const parseOptionalTriplet = (value: unknown): [number, number, number] | null => {
  if (!Array.isArray(value)) return null;
  const x = Number(value[0]);
  const y = Number(value[1]);
  const z = Number(value[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
};

const parseOptionalQuartet = (value: unknown): [number, number, number, number] | null => {
  if (!Array.isArray(value)) return null;
  const a = Number(value[0]);
  const b = Number(value[1]);
  const c = Number(value[2]);
  const d = Number(value[3]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || !Number.isFinite(d)) return null;
  return [a, b, c, d];
};

const parseFramePose = (
  value: unknown
): { position: [number, number, number]; quaternion: [number, number, number, number] } | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as { position?: unknown; quaternion?: unknown };
  const position = parseOptionalTriplet(raw.position);
  const quaternion = parseOptionalQuartet(raw.quaternion);
  if (!position || !quaternion) return null;
  return { position, quaternion };
};

const parseOptionalBoolean = (value: unknown): boolean | null => {
  if (typeof value === "boolean") return value;
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return null;
};

const parseOptionalNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseJointMuscle = (value: unknown): NormalizedIntrospectionJoint["muscle"] => {
  if (!value || typeof value !== "object") return null;
  const raw = value as {
    enabled?: unknown;
    endA?: unknown;
    endB?: unknown;
    range?: unknown;
    force?: unknown;
    scale?: unknown;
    damping?: unknown;
  };
  const parseEndpoint = (input: unknown) => {
    if (!input || typeof input !== "object") return null;
    const endpoint = input as { body?: unknown; localPos?: unknown };
    const localPos = parseOptionalTriplet(endpoint.localPos);
    if (!localPos) return null;
    return {
      body: normalizeBodyToken(endpoint.body),
      localPos,
    };
  };
  const endA = parseEndpoint(raw.endA);
  const endB = parseEndpoint(raw.endB);
  if (!endA || !endB) return null;
  const rangeRaw = Array.isArray(raw.range) ? raw.range : [];
  const rangeA = Number(rangeRaw[0]);
  const rangeB = Number(rangeRaw[1]);
  return {
    enabled: parseOptionalBoolean(raw.enabled) ?? false,
    endA,
    endB,
    range:
      Number.isFinite(rangeA) && Number.isFinite(rangeB)
        ? [rangeA, rangeB]
        : undefined,
    force: parseOptionalNumber(raw.force) ?? undefined,
    scale: parseOptionalNumber(raw.scale) ?? undefined,
    damping: parseOptionalNumber(raw.damping) ?? undefined,
  };
};

const normalizeBodyToken = (value: unknown): string | null => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const token = raw
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .pop();
  if (!token) return null;
  return token.replace(/[^A-Za-z0-9_.:-]/g, "_");
};

const parseNumberTriplet = (
  value: unknown,
  fallback: [number, number, number]
): [number, number, number] => {
  const source = Array.isArray(value) ? value : [];
  const x = Number(source[0]);
  const y = Number(source[1]);
  const z = Number(source[2]);
  return [
    Number.isFinite(x) ? x : fallback[0],
    Number.isFinite(y) ? y : fallback[1],
    Number.isFinite(z) ? z : fallback[2],
  ];
};

const parseNumberQuartet = (
  value: unknown,
  fallback: [number, number, number, number]
): [number, number, number, number] => {
  const source = Array.isArray(value) ? value : [];
  const a = Number(source[0]);
  const b = Number(source[1]);
  const c = Number(source[2]);
  const d = Number(source[3]);
  return [
    Number.isFinite(a) ? a : fallback[0],
    Number.isFinite(b) ? b : fallback[1],
    Number.isFinite(c) ? c : fallback[2],
    Number.isFinite(d) ? d : fallback[3],
  ];
};

const parseMeshPoints = (value: unknown): Float32Array | null => {
  if (!Array.isArray(value) || value.length < 3) return null;
  const out = new Float32Array(value.length * 3);
  let cursor = 0;
  for (const item of value) {
    if (!Array.isArray(item)) return null;
    const x = Number(item[0]);
    const y = Number(item[1]);
    const z = Number(item[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    out[cursor] = x;
    out[cursor + 1] = y;
    out[cursor + 2] = z;
    cursor += 3;
  }
  return cursor >= 9 ? out : null;
};

const parseMeshIndexArray = (value: unknown, pointsCount: number): Uint32Array | null => {
  if (!Array.isArray(value) || value.length < 3 || pointsCount < 3) return null;
  const out: number[] = [];
  for (const item of value) {
    const index = Number(item);
    if (!Number.isFinite(index)) continue;
    const integer = Math.trunc(index);
    if (integer < 0 || integer >= pointsCount) continue;
    out.push(integer);
  }
  const usable = Math.floor(out.length / 3) * 3;
  if (usable < 3) return null;
  return Uint32Array.from(out.slice(0, usable));
};

const parseMeshNormals = (value: unknown, pointsCount: number): Float32Array | null => {
  if (!Array.isArray(value) || value.length !== pointsCount) return null;
  const out = new Float32Array(pointsCount * 3);
  let cursor = 0;
  for (const item of value) {
    if (!Array.isArray(item)) return null;
    const x = Number(item[0]);
    const y = Number(item[1]);
    const z = Number(item[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    out[cursor] = x;
    out[cursor + 1] = y;
    out[cursor + 2] = z;
    cursor += 3;
  }
  return out;
};

const parseMeshUvs = (value: unknown, pointsCount: number): Float32Array | null => {
  if (!Array.isArray(value) || value.length !== pointsCount) return null;
  const out = new Float32Array(pointsCount * 2);
  let cursor = 0;
  for (const item of value) {
    if (!Array.isArray(item)) return null;
    const u = Number(item[0]);
    const v = Number(item[1]);
    if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
    out[cursor] = u;
    out[cursor + 1] = v;
    cursor += 2;
  }
  return out;
};

const parseMeshRgba = (value: unknown): [number, number, number, number] | null => {
  if (!Array.isArray(value) || value.length < 3) return null;
  const [r, g, b, a] = parseNumberQuartet(value, [1, 1, 1, 1]);
  return [
    Math.max(0, Math.min(1, r)),
    Math.max(0, Math.min(1, g)),
    Math.max(0, Math.min(1, b)),
    Math.max(0, Math.min(1, a)),
  ];
};

const parseOptionalText = (value: unknown): string | null => {
  const text = String(value ?? "").trim();
  return text ? text : null;
};

const normalizeTextureAssetPath = (value: string | null): string | null => {
  if (!value) return null;
  const normalized = value.replace(/^@+|@+$/g, "").trim();
  if (!normalized) return null;
  return normalized;
};

const parsePrimitiveKind = (value: unknown): NormalizedUsdMeshScenePrimitiveKind | null => {
  const token = String(value ?? "").trim().toLowerCase();
  if (token === "sphere" || token === "capsule" || token === "cylinder" || token === "cone" || token === "cube") {
    return token;
  }
  return null;
};

const parseAxisToken = (value: unknown): "X" | "Y" | "Z" => {
  const token = String(value ?? "").trim().toUpperCase();
  if (token === "X" || token === "Y" || token === "Z") return token;
  return "Z";
};

const parsePositiveNumberOrNull = (value: unknown): number | null => {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
};

const normalizeUsdMeshScene = (
  payload: UsdConverterMeshSceneResponse,
  fallbackAssetId: string
): NormalizedUsdMeshScene | null => {
  const meshesRaw = Array.isArray(payload.meshes) ? payload.meshes : [];
  const primitivesRaw = Array.isArray(payload.primitives) ? payload.primitives : [];
  const bodiesRaw = Array.isArray(payload.bodies) ? payload.bodies : [];
  const meshes: NormalizedUsdMeshSceneMesh[] = [];
  const primitives: NormalizedUsdMeshScenePrimitive[] = [];
  const bodies: NormalizedUsdMeshSceneBody[] = [];

  for (const item of meshesRaw) {
    const points = parseMeshPoints(item?.points);
    if (!points) continue;
    const pointsCount = points.length / 3;
    const triangles = parseMeshIndexArray(item?.triangles, pointsCount);
    if (!triangles) continue;

    const [px, py, pz] = parseNumberTriplet(item?.position, [0, 0, 0]);
    const [qw, qx, qy, qz] = parseNumberQuartet(item?.quaternion, [1, 0, 0, 0]);
    const [sx, sy, sz] = parseNumberTriplet(item?.scale, [1, 1, 1]);
    const quat = new THREE.Quaternion(qx, qy, qz, qw);
    if (quat.lengthSq() <= 1e-9) {
      quat.identity();
    } else {
      quat.normalize();
    }

    meshes.push({
      name: String(item?.name ?? "").trim() || `mesh_${meshes.length + 1}`,
      primPath: String(item?.primPath ?? "").trim(),
      parentBody: normalizeBodyToken(item?.parentBody),
      position: [px, py, pz],
      quaternion: quat,
      scale: [
        Math.max(1e-6, Number.isFinite(sx) ? sx : 1),
        Math.max(1e-6, Number.isFinite(sy) ? sy : 1),
        Math.max(1e-6, Number.isFinite(sz) ? sz : 1),
      ],
      points,
      triangles,
      normals: parseMeshNormals(item?.normals, pointsCount),
      uvs: parseMeshUvs(item?.uvs, pointsCount),
      rgba: parseMeshRgba(item?.rgba),
      materialName: parseOptionalText(item?.materialName),
      materialSource: parseOptionalText(item?.materialSource),
      baseColorTexture: normalizeTextureAssetPath(parseOptionalText(item?.baseColorTexture)),
    });
  }

  for (const item of primitivesRaw) {
    const kind = parsePrimitiveKind(item?.kind);
    if (!kind) continue;

    const [px, py, pz] = parseNumberTriplet(item?.position, [0, 0, 0]);
    const [qw, qx, qy, qz] = parseNumberQuartet(item?.quaternion, [1, 0, 0, 0]);
    const [sx, sy, sz] = parseNumberTriplet(item?.scale, [1, 1, 1]);
    const quat = new THREE.Quaternion(qx, qy, qz, qw);
    if (quat.lengthSq() <= 1e-9) {
      quat.identity();
    } else {
      quat.normalize();
    }

    const radius = parsePositiveNumberOrNull(item?.radius);
    const height = parsePositiveNumberOrNull(item?.height);
    const size =
      kind === "cube"
        ? parseNumberTriplet(item?.size, [0.1, 0.1, 0.1]).map((value) =>
            Math.max(1e-6, Number.isFinite(value) ? value : 0.1)
          ) as [number, number, number]
        : null;

    if ((kind === "sphere" || kind === "capsule" || kind === "cylinder" || kind === "cone") && !radius) {
      continue;
    }
    if ((kind === "capsule" || kind === "cylinder" || kind === "cone") && !height) {
      continue;
    }

    primitives.push({
      name: String(item?.name ?? "").trim() || `primitive_${primitives.length + 1}`,
      primPath: String(item?.primPath ?? "").trim(),
      parentBody: normalizeBodyToken(item?.parentBody),
      kind,
      position: [px, py, pz],
      quaternion: quat,
      scale: [
        Math.max(1e-6, Number.isFinite(sx) ? sx : 1),
        Math.max(1e-6, Number.isFinite(sy) ? sy : 1),
        Math.max(1e-6, Number.isFinite(sz) ? sz : 1),
      ],
      axis: parseAxisToken(item?.axis),
      radius,
      height,
      size,
      rgba: parseMeshRgba(item?.rgba),
      materialName: parseOptionalText(item?.materialName),
      materialSource: parseOptionalText(item?.materialSource),
      baseColorTexture: normalizeTextureAssetPath(parseOptionalText(item?.baseColorTexture)),
    });
  }

  for (const item of bodiesRaw) {
    const name = normalizeBodyToken(item?.name) ?? String(item?.name ?? "").trim();
    if (!name) continue;
    const [px, py, pz] = parseNumberTriplet(item?.position, [0, 0, 0]);
    const [qw, qx, qy, qz] = parseNumberQuartet(item?.quaternion, [1, 0, 0, 0]);
    const [sx, sy, sz] = parseNumberTriplet(item?.scale, [1, 1, 1]);
    const quat = new THREE.Quaternion(qx, qy, qz, qw);
    if (quat.lengthSq() <= 1e-9) {
      quat.identity();
    } else {
      quat.normalize();
    }

    bodies.push({
      name,
      primPath: String(item?.primPath ?? "").trim(),
      parentBody: normalizeBodyToken(item?.parentBody),
      position: [px, py, pz],
      quaternion: quat,
      scale: [
        Math.max(1e-6, Number.isFinite(sx) ? sx : 1),
        Math.max(1e-6, Number.isFinite(sy) ? sy : 1),
        Math.max(1e-6, Number.isFinite(sz) ? sz : 1),
      ],
    });
  }

  if (meshes.length === 0 && primitives.length === 0 && bodies.length === 0) return null;

  return {
    assetId: String(payload.assetId ?? "").trim() || fallbackAssetId,
    filename: String(payload.filename ?? "").trim(),
    stageUpAxis: parseStageUpAxis(payload.stageUpAxis),
    normalizedToZUp: parseOptionalBoolean(payload.normalizedToZUp) ?? false,
    meshCount: Number.isFinite(Number(payload.meshCount)) ? Math.max(0, Math.trunc(Number(payload.meshCount))) : meshes.length,
    primitiveCount: Number.isFinite(Number(payload.primitiveCount))
      ? Math.max(0, Math.trunc(Number(payload.primitiveCount)))
      : primitives.length,
    bodyCount: Number.isFinite(Number(payload.bodyCount)) ? Math.max(0, Math.trunc(Number(payload.bodyCount))) : bodies.length,
    truncated: Boolean(payload.truncated),
    meshes,
    primitives,
    bodies,
  };
};

const normalizeUsdIntrospection = (
  payload: UsdConverterIntrospectionResponse,
  fallbackAssetId: string
): NormalizedUsdIntrospection | null => {
  const jointsRaw = Array.isArray(payload.joints) ? payload.joints : [];
  const rootBodiesRaw = Array.isArray(payload.rootBodies) ? payload.rootBodies : [];

  const joints = jointsRaw
    .map((joint, index) => {
      const name = String(joint?.name ?? "").trim() || `joint_${index + 1}`;
      const sourceUpAxis = parseStageUpAxis(joint?.sourceUpAxis);
      const normalizedToZUp = parseOptionalBoolean(joint?.normalizedToZUp) ?? false;
      return {
        name,
        type: parseJointType(joint?.type),
        axis: parseJointAxis(joint?.axis),
        parentBody: normalizeBodyToken(joint?.parentBody),
        childBody: normalizeBodyToken(joint?.childBody),
        parentBodyPath: parseOptionalText(joint?.parentBodyPath),
        childBodyPath: parseOptionalText(joint?.childBodyPath),
        localPos0: parseOptionalTriplet(joint?.localPos0),
        localRot0: parseOptionalQuartet(joint?.localRot0),
        localPos1: parseOptionalTriplet(joint?.localPos1),
        localRot1: parseOptionalQuartet(joint?.localRot1),
        frame0Local: parseFramePose(joint?.frame0Local),
        frame1Local: parseFramePose(joint?.frame1Local),
        frame0World: parseFramePose(joint?.frame0World),
        frame1World: parseFramePose(joint?.frame1World),
        axisLocal: parseOptionalTriplet(joint?.axisLocal),
        axisWorld: parseOptionalTriplet(joint?.axisWorld),
        sourceUpAxis,
        normalizedToZUp,
        frameMismatchDistance: parseOptionalNumber(joint?.frameMismatchDistance),
        frameMismatchWarning: parseOptionalText(joint?.frameMismatchWarning),
        muscle: parseJointMuscle(joint?.muscle),
      } satisfies NormalizedIntrospectionJoint;
    })
    .filter((joint) => joint.name.length > 0);

  const rootBodies = rootBodiesRaw
    .map((item) => normalizeBodyToken(item))
    .filter((item): item is string => Boolean(item));

  if (joints.length === 0 && rootBodies.length === 0) return null;

  return {
    assetId: String(payload.assetId ?? "").trim() || fallbackAssetId,
    filename: String(payload.filename ?? "").trim() || "",
    joints,
    rootBodies,
    stageUpAxis: parseStageUpAxis(payload.stageUpAxis),
  };
};

export async function collectUsdBundleFiles(params: {
  usdUrl: string;
  usdKey: string;
  usdFile?: File;
  resolveResource?: (resourcePath: string) => string | null;
  assetsByKey?: Record<string, UsdWorkspaceAssetEntry>;
  bundleHintPaths?: string[];
  maxFiles?: number;
}): Promise<CollectedUsdBundle> {
  const entryPath = normalizeBundlePath(params.usdKey);
  if (!entryPath) {
    throw new Error(`Invalid USD workspace key '${params.usdKey}'.`);
  }

  const assetsByKey = params.assetsByKey ?? {};
  const urlToKey = new Map<string, string>();
  const keyToAsset = new Map<string, UsdWorkspaceAssetEntry>();
  for (const [key, entry] of Object.entries(assetsByKey)) {
    const normalizedKey = normalizeBundlePath(key);
    if (!normalizedKey) continue;
    keyToAsset.set(normalizedKey, entry);
    urlToKey.set(entry.url, normalizedKey);
  }

  const queue: Array<{ url: string; path: string; file?: File }> = [];
  queue.push({
    url: params.usdUrl,
    path: entryPath,
    file: params.usdFile ?? keyToAsset.get(entryPath)?.file,
  });

  const visitedUrls = new Set<string>();
  const filesByPath = new Map<string, CollectedUsdBundleFile>();
  const maxFiles = Math.max(1, Math.min(256, params.maxFiles ?? 128));
  const entryDir = dirnameBundlePath(entryPath);

  while (queue.length > 0 && filesByPath.size < maxFiles) {
    const current = queue.shift() as { url: string; path: string; file?: File };
    if (visitedUrls.has(current.url)) continue;
    visitedUrls.add(current.url);

    let bytes: Uint8Array;
    let contentType = current.file?.type || "application/octet-stream";
    if (current.file instanceof File) {
      bytes = new Uint8Array(await current.file.arrayBuffer());
      contentType = current.file.type || contentType;
    } else {
      bytes = await readUsdBytes(current.url);
      const fromAsset = keyToAsset.get(current.path);
      contentType = fromAsset?.file?.type || contentType;
    }

    if (!filesByPath.has(current.path)) {
      const file = current.file instanceof File ? current.file : createFileFromBytes(bytes, current.path, contentType);
      filesByPath.set(current.path, {
        path: current.path,
        file,
        contentType,
      });
    }

    if (!params.resolveResource) continue;

    const tokens = extractPrintableTokens(bytes);
    const references = extractReferences(tokens);
    for (const reference of references) {
      const resolvedUrl = params.resolveResource(reference);
      if (!resolvedUrl || visitedUrls.has(resolvedUrl)) continue;

      const resolvedKey = resolveWorkspaceKeyFromUrl(urlToKey, resolvedUrl, current.path, reference);
      const normalizedKey = normalizeBundlePath(resolvedKey ?? "");
      if (!normalizedKey) continue;
      const fromAsset = keyToAsset.get(normalizedKey);
      queue.push({
        url: resolvedUrl,
        path: normalizedKey,
        file: fromAsset?.file,
      });
    }
  }

  const addBundleFileByPath = async (candidatePath: string) => {
    if (filesByPath.size >= maxFiles || filesByPath.has(candidatePath)) return;
    const fromAsset = keyToAsset.get(candidatePath);
    const fromAssetUrl = fromAsset?.url ?? "";

    let resolvedUrl = fromAssetUrl;
    if (!resolvedUrl && params.resolveResource) {
      const relativeCandidate =
        entryDir && candidatePath.startsWith(`${entryDir}/`)
          ? candidatePath.slice(entryDir.length + 1)
          : candidatePath;
      resolvedUrl = params.resolveResource(relativeCandidate) ?? params.resolveResource(candidatePath) ?? "";
    }
    if (!resolvedUrl) return;

    let file: File;
    let contentType = fromAsset?.file?.type || "application/octet-stream";
    if (fromAsset?.file instanceof File) {
      file = fromAsset.file;
      contentType = fromAsset.file.type || contentType;
    } else {
      const bytes = await readUsdBytes(resolvedUrl);
      file = createFileFromBytes(bytes, candidatePath, contentType);
    }

    filesByPath.set(candidatePath, {
      path: candidatePath,
      file,
      contentType,
    });
  };

  const normalizedHintPaths = Array.isArray(params.bundleHintPaths)
    ? params.bundleHintPaths
        .map((rawPath) => String(rawPath ?? "").trim())
        .filter((rawPath) => rawPath.length > 0)
        .map((rawPath) => {
          const relativeCandidate = normalizeBundlePath(resolveReferenceBundlePath(entryPath, rawPath) ?? "");
          if (relativeCandidate && keyToAsset.has(relativeCandidate)) return relativeCandidate;
          return normalizeBundlePath(rawPath);
        })
        .filter((item): item is string => Boolean(item))
    : [];

  const missingHints = normalizedHintPaths.filter((path) => !filesByPath.has(path));
  const referenceDiscoveryLooksIncomplete = filesByPath.size <= 1 || missingHints.length > 0;
  if (referenceDiscoveryLooksIncomplete) {
    const baselineCount = filesByPath.size;
    const fallbackCandidates = new Set<string>();
    for (const hintPath of missingHints) fallbackCandidates.add(hintPath);
    for (const candidatePath of keyToAsset.keys()) {
      if (!isBundleFallbackCandidatePath(candidatePath)) continue;
      if (entryDir) {
        if (!candidatePath.startsWith(`${entryDir}/`)) continue;
      } else if (candidatePath.includes("/")) {
        continue;
      }
      fallbackCandidates.add(candidatePath);
    }

    const orderedCandidates = Array.from(fallbackCandidates).sort((a, b) => a.localeCompare(b));
    for (const candidatePath of orderedCandidates) {
      if (filesByPath.size >= maxFiles) break;
      await addBundleFileByPath(candidatePath);
    }

    logInfo("USD bundle fallback enrichment applied", {
      scope: "usd",
      data: {
        entryPath,
        originalCount: baselineCount,
        finalCount: filesByPath.size,
        missingHints: missingHints.length,
      },
    });
  }

  const files = Array.from(filesByPath.values()).sort((a, b) => a.path.localeCompare(b.path));
  if (!files.find((item) => item.path === entryPath)) {
    throw new Error(`USD entry '${entryPath}' missing from resolved bundle.`);
  }

  return { entryPath, files };
}

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

const createPlaceholderLinkNode = (linkName: string) => {
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

  const visualMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 0.08, 0.08),
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(0.45, 0.62, 0.84),
      metalness: 0.02,
      roughness: 0.88,
    })
  );
  visualMesh.name = `${linkName}_visual`;
  visualMesh.userData.editorKind = "mesh";
  visual.add(visualMesh);

  const collisionMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 0.08, 0.08),
    new THREE.MeshBasicMaterial({
      color: 0x8c5a2b,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    })
  );
  collisionMesh.name = `${linkName}_collision`;
  collisionMesh.userData.editorKind = "mesh";
  collision.add(collisionMesh);

  link.add(visual);
  link.add(collision);

  const linkGeom: UrdfGeom = { kind: "box", size: [0.18, 0.08, 0.08] };
  const linkPose: Pose = { xyz: [0, 0, 0], rpy: [0, 0, 0] };
  const visuals: UrdfCollision[] = [
    {
      name: `${linkName}_visual`,
      origin: linkPose,
      geom: linkGeom,
      rgba: [0.45, 0.62, 0.84, 1],
    },
  ];
  const collisions: UrdfCollision[] = [
    {
      name: `${linkName}_collision`,
      origin: linkPose,
      geom: linkGeom,
    },
  ];

  const urdfLink: UrdfLink = {
    name: linkName,
    visuals,
    collisions,
  };
  link.userData.urdf = { kind: "link", link: urdfLink };
  return link;
};

const buildRobotFromIntrospection = (introspection: NormalizedUsdIntrospection, robotName: string) => {
  const robotRoot = new THREE.Group();
  const robotRootFlagged = robotRoot as THREE.Group & { isRobot?: boolean };
  robotRoot.name = robotName;
  robotRootFlagged.isRobot = true;
  robotRoot.userData.editorRobotRoot = true;

  const linksByName = new Map<string, THREE.Group>();
  const ensureLink = (rawName: string) => {
    const key = (normalizeBodyToken(rawName) ?? rawName.trim()) || "link";
    const existing = linksByName.get(key);
    if (existing) return existing;
    const created = createPlaceholderLinkNode(key);
    linksByName.set(key, created);
    return created;
  };

  const parentBodies = new Set<string>();
  const childBodies = new Set<string>();
  for (const joint of introspection.joints) {
    if (joint.parentBody) parentBodies.add(joint.parentBody);
    if (joint.childBody) childBodies.add(joint.childBody);
  }
  const explicitRootNames = introspection.rootBodies.filter(
    (name) => parentBodies.has(name) || childBodies.has(name)
  );
  const derivedRootNames = Array.from(parentBodies).filter((name) => !childBodies.has(name));
  const rootNames =
    explicitRootNames.length > 0
      ? explicitRootNames
      : derivedRootNames.length > 0
        ? derivedRootNames
        : introspection.rootBodies.length > 0
          ? introspection.rootBodies
          : ["base"];
  for (const rootName of rootNames) ensureLink(rootName);
  for (const joint of introspection.joints) {
    if (joint.parentBody) ensureLink(joint.parentBody);
    if (joint.childBody) ensureLink(joint.childBody);
  }

  const attachedChildren = new Set<string>();
  const jointNames = new Set<string>();
  let jointCount = 0;

  for (const [index, joint] of introspection.joints.entries()) {
    const fallbackRootName = rootNames[0] ?? "base";
    const parentName =
      joint.parentBody ??
      (joint.childBody && fallbackRootName === joint.childBody
        ? `${joint.childBody}_root`
        : fallbackRootName);
    const childSeed = joint.childBody ?? `${joint.name || `joint_${index + 1}`}_link`;
    const childName = childSeed === parentName ? `${childSeed}_child` : childSeed;
    if (attachedChildren.has(childName)) continue;

    const parentLink = ensureLink(parentName);
    const childLink = ensureLink(childName);

    const rawJointName = joint.name.trim() || `${parentName}_${childName}_joint`;
    const jointName = claimName(rawJointName, jointNames, "joint");
    const jointNode = new THREE.Group();
    const jointFlags = jointNode as THREE.Group & { isURDFJoint?: boolean; urdfName?: string };
    jointNode.name = jointName;
    jointFlags.isURDFJoint = true;
    jointFlags.urdfName = jointName;
    jointNode.userData.editorKind = "joint";

    const frame0Local =
      joint.frame0Local ??
      (joint.localPos0 && joint.localRot0 ? { position: joint.localPos0, quaternion: joint.localRot0 } : null);
    const frame1Local =
      joint.frame1Local ??
      (joint.localPos1 && joint.localRot1 ? { position: joint.localPos1, quaternion: joint.localRot1 } : null);
    const frame0Quat = frame0Local
      ? new THREE.Quaternion(
          frame0Local.quaternion[0],
          frame0Local.quaternion[1],
          frame0Local.quaternion[2],
          frame0Local.quaternion[3]
        )
      : new THREE.Quaternion();
    if (frame0Quat.lengthSq() <= 1e-9) frame0Quat.identity();
    else frame0Quat.normalize();
    const frame0Euler = new THREE.Euler().setFromQuaternion(frame0Quat, "ZYX");
    const origin = frame0Local
      ? {
          xyz: [frame0Local.position[0], frame0Local.position[1], frame0Local.position[2]] as [number, number, number],
          rpy: [frame0Euler.x, frame0Euler.y, frame0Euler.z] as [number, number, number],
        }
      : ({ xyz: [0, 0, 0], rpy: [0, 0, 0] } as Pose);
    const axisSource = joint.axisLocal ?? joint.axis;
    const axisLocal = axisInJointFrame(
      [axisSource[0], axisSource[1], axisSource[2]],
      frame0Local ? frame0Quat : null
    );
    const sourceFrames = {
      frame0Local: frame0Local ?? undefined,
      frame1Local: frame1Local ?? undefined,
      frame0World: joint.frame0World ?? undefined,
      frame1World: joint.frame1World ?? undefined,
      axisLocal: joint.axisLocal ?? undefined,
      axisWorld: joint.axisWorld ?? undefined,
      sourceUpAxis: joint.sourceUpAxis,
      normalizedToZUp: joint.normalizedToZUp,
      frameMismatchDistance: joint.frameMismatchDistance ?? undefined,
      frameMismatchWarning: joint.frameMismatchWarning ?? undefined,
    };
    const derivedMuscle = joint.muscle
      ? {
          enabled: joint.muscle.enabled,
          endA: {
            body: joint.muscle.endA.body ?? parentLink.name,
            localPos: [...joint.muscle.endA.localPos] as [number, number, number],
          },
          endB: {
            body: joint.muscle.endB.body ?? childLink.name,
            localPos: [...joint.muscle.endB.localPos] as [number, number, number],
          },
          range: joint.muscle.range ? ([...joint.muscle.range] as [number, number]) : ([0, 1] as [number, number]),
          force: Number.isFinite(joint.muscle.force) ? joint.muscle.force : 1,
          scale: Number.isFinite(joint.muscle.scale) ? joint.muscle.scale : 1,
          damping: Number.isFinite(joint.muscle.damping) ? joint.muscle.damping : 0,
          showLine: true,
          showTube: false,
        }
      : undefined;

    const urdfJoint: UrdfJoint = {
      name: jointName,
      type: joint.type === "revolute" || joint.type === "prismatic" || joint.type === "fixed" ? joint.type : "fixed",
      parent: parentLink.name,
      child: childLink.name,
      origin,
      axis: [axisLocal[0], axisLocal[1], axisLocal[2]],
      sourceFrames,
      actuator: derivedMuscle
        ? {
            enabled: false,
            type: "muscle",
          }
        : undefined,
      muscle: derivedMuscle,
    };
    jointNode.userData.urdf = { kind: "joint", joint: urdfJoint };

    parentLink.add(jointNode);
    jointNode.add(childLink);
    attachedChildren.add(childName);
    jointCount += 1;
  }

  for (const rootName of rootNames) {
    const link = linksByName.get(rootName);
    if (link && !link.parent) robotRoot.add(link);
  }

  for (const link of linksByName.values()) {
    if (!link.parent) robotRoot.add(link);
  }

  return {
    root: robotRoot,
    linkCount: linksByName.size,
    jointCount,
  };
};

const attachUsdIntrospectionMetadata = (
  root: THREE.Object3D,
  introspection: NormalizedUsdIntrospection | null
) => {
  if (!introspection) return;
  root.userData.usdIntrospection = {
    assetId: introspection.assetId,
    filename: introspection.filename,
    stageUpAxis: introspection.stageUpAxis,
    jointCount: introspection.joints.length,
    joints: introspection.joints.map((joint) => ({
      name: joint.name,
      type: joint.type,
      axis: [...joint.axis],
      axisLocal: joint.axisLocal ? [...joint.axisLocal] : null,
      axisWorld: joint.axisWorld ? [...joint.axisWorld] : null,
      frame0Local: joint.frame0Local,
      frame1Local: joint.frame1Local,
      frame0World: joint.frame0World,
      frame1World: joint.frame1World,
      parentBody: joint.parentBody,
      childBody: joint.childBody,
      sourceUpAxis: joint.sourceUpAxis,
      normalizedToZUp: joint.normalizedToZUp,
      frameMismatchDistance: joint.frameMismatchDistance,
      frameMismatchWarning: joint.frameMismatchWarning,
      muscle: joint.muscle,
    })),
    rootBodies: [...introspection.rootBodies],
  };
};

const buildUsdConverterUrl = (path: string) => `${usdConverterBaseUrl}${path}`;

const uploadUsdBundle = async (bundle: CollectedUsdBundle) => {
  const uploadForm = new FormData();
  uploadForm.append("entryPath", bundle.entryPath);
  for (const item of bundle.files) {
    uploadForm.append("files", item.file, item.path);
  }
  const uploadRes = await fetch(buildUsdConverterUrl("/v1/assets/usd-bundle"), {
    method: "POST",
    body: uploadForm,
  });
  if (!uploadRes.ok) {
    const text = await uploadRes.text();
    throw new Error(`USD converter bundle upload failed (${uploadRes.status}): ${text || uploadRes.statusText}`);
  }
  const uploaded = (await uploadRes.json()) as UsdConverterUploadResponse;
  const converterAssetId = String(uploaded.assetId ?? "").trim();
  if (!converterAssetId) {
    throw new Error("USD converter did not return assetId after bundle upload.");
  }
  return converterAssetId;
};

const resolveUsdConverterAssetId = async (params: {
  usdUrl: string;
  usdKey: string;
  usdFile?: File;
  resolveResource?: (resourcePath: string) => string | null;
  assetsByKey?: Record<string, UsdWorkspaceAssetEntry>;
  converterAssetId?: string | null;
  bundleHintPaths?: string[];
}) => {
  if (params.converterAssetId && params.converterAssetId.trim()) {
    return params.converterAssetId.trim();
  }

  const bundle = await collectUsdBundleFiles({
    usdUrl: params.usdUrl,
    usdKey: params.usdKey,
    usdFile: params.usdFile,
    resolveResource: params.resolveResource,
    assetsByKey: params.assetsByKey,
    bundleHintPaths: params.bundleHintPaths,
  });
  return uploadUsdBundle(bundle);
};

const convertUsdAssetToMjcf = async (params: {
  converterAssetId: string;
  importOptions?: UsdImportOptions;
}) => {
  const query = new URLSearchParams();
  query.set("floating_base", String(params.importOptions?.floatingBase ?? false));
  query.set("self_collision", String(params.importOptions?.selfCollision ?? false));

  const convertRes = await fetch(
    buildUsdConverterUrl(`/v1/assets/${encodeURIComponent(params.converterAssetId)}:convert-usd-to-mjcf?${query.toString()}`),
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
    converterAssetId: params.converterAssetId,
    mjcfAssetId,
    mjcfXml,
    diagnostics: converted.diagnostics ?? null,
  };
};

const introspectUsdAsset = async (converterAssetId: string): Promise<NormalizedUsdIntrospection | null> => {
  const response = await fetch(
    buildUsdConverterUrl(`/v1/assets/${encodeURIComponent(converterAssetId)}/introspect`),
    {
      method: "GET",
    }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`USD converter introspection failed (${response.status}): ${text || response.statusText}`);
  }
  const payload = (await response.json()) as UsdConverterIntrospectionResponse;
  return normalizeUsdIntrospection(payload, converterAssetId);
};

const fetchUsdMeshScene = async (converterAssetId: string): Promise<NormalizedUsdMeshScene | null> => {
  const response = await fetch(
    buildUsdConverterUrl(`/v1/assets/${encodeURIComponent(converterAssetId)}/mesh-scene`),
    {
      method: "GET",
    }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`USD mesh scene request failed (${response.status}): ${text || response.statusText}`);
  }
  const payload = (await response.json()) as UsdConverterMeshSceneResponse;
  return normalizeUsdMeshScene(payload, converterAssetId);
};

export async function loadUSDObject(params: USDLoaderParams): Promise<THREE.Object3D> {
  const {
    usdUrl,
    usdKey,
    usdFile,
    usdName,
    resolveResource,
    importOptions,
    converterAssetId,
    assetsByKey,
    bundleHintPaths,
    sceneRole,
  } = params;
  const importSceneRole = sceneRole === "scene_asset" ? "scene_asset" : "robot";
  const displayName = usdName ?? (basename(usdKey) || usdKey);

  logInfo(`USD load: ${usdKey}`, { scope: "usd" });

  let root: THREE.Object3D | null = null;
  let resolvedConverterAssetId = converterAssetId ?? null;
  let resolvedMjcfAssetId: string | undefined;
  let mjcfXml: string | undefined;
  const useVisualCollisionSync = true;
  let introspection: NormalizedUsdIntrospection | null = null;
  let meshScene: NormalizedUsdMeshScene | null = null;
  let detectedFloatingBase: boolean | undefined;

  if (usdConverterEnabled) {
    if (!resolvedConverterAssetId) {
      try {
        resolvedConverterAssetId = await resolveUsdConverterAssetId({
          usdUrl,
          usdKey,
          usdFile,
          resolveResource,
          assetsByKey,
          bundleHintPaths,
        });
      } catch (error) {
        logWarn("USD converter upload path failed; using fallback import path.", {
          scope: "usd",
          data: {
            usdKey,
            error: String((error as Error)?.message ?? error),
          },
        });
      }
    }

    if (resolvedConverterAssetId) {
      try {
        introspection = await introspectUsdAsset(resolvedConverterAssetId);
        if (
          introspection &&
          introspection.joints.length > 0 &&
          introspection.joints.some((joint) => !joint.frame0Local)
        ) {
          logWarn("USD introspection payload missing frame0Local on one or more joints; using compatibility fallback.", {
            scope: "usd",
            data: {
              usdKey,
              converterAssetId: resolvedConverterAssetId,
            },
          });
        }
      } catch (error) {
        logWarn("USD introspection failed for converter asset.", {
          scope: "usd",
          data: {
            usdKey,
            converterAssetId: resolvedConverterAssetId,
            error: String((error as Error)?.message ?? error),
          },
        });
      }

      try {
        meshScene = await fetchUsdMeshScene(resolvedConverterAssetId);
      } catch (error) {
        logWarn("USD mesh scene extraction failed for converter asset.", {
          scope: "usd",
          data: {
            usdKey,
            converterAssetId: resolvedConverterAssetId,
            error: String((error as Error)?.message ?? error),
          },
        });
      }
    }

    try {
      if (!resolvedConverterAssetId) throw new Error("converter asset id unavailable after upload.");
      const converted = await convertUsdAssetToMjcf({
        converterAssetId: resolvedConverterAssetId,
        importOptions,
      });
      resolvedConverterAssetId = converted.converterAssetId;
      resolvedMjcfAssetId = converted.mjcfAssetId;
      mjcfXml = converted.mjcfXml;
      const introspectionJointCount = introspection?.joints.length ?? 0;
      const mjcfHasBodyHierarchy = /<body(?:\s|>)/i.test(mjcfXml);

      if (!mjcfHasBodyHierarchy && introspection && introspectionJointCount > 0) {
        const built = buildRobotFromIntrospection(introspection, displayName);
        root = built.root;
        logWarn("USD MJCF is missing body hierarchy; using introspection skeleton.", {
          scope: "usd",
          data: {
            usdKey,
            converterAssetId: resolvedConverterAssetId,
            mjcfAssetId: resolvedMjcfAssetId,
            introspectionJoints: introspectionJointCount,
          },
        });
        logInfo("USD conversion + render completed", {
          scope: "usd",
          data: {
            usdKey,
            converterAssetId: resolvedConverterAssetId,
            mjcfAssetId: resolvedMjcfAssetId,
            links: built.linkCount,
            joints: built.jointCount,
            hierarchySource: "introspection",
            diagnostics: converted.diagnostics ?? null,
          },
        });
      } else {
        const parsed = parseMjcf(mjcfXml);
        detectedFloatingBase = parsed.bodies.some((body) => body.joints.some((joint) => joint.type === "free"));
        const builtFromMjcf = buildRobotFromMjcf(parsed, displayName, { introspection });
        const introspectionBodyCount = introspection
          ? new Set(
              introspection.joints
                .flatMap((joint) => [joint.parentBody, joint.childBody])
                .filter((name): name is string => Boolean(name))
            ).size
          : 0;
        const mjcfHierarchyIncomplete =
          introspectionJointCount > 0 &&
          (
            builtFromMjcf.linkCount <= 1 ||
            builtFromMjcf.jointCount === 0 ||
            (introspectionJointCount >= 4 &&
              builtFromMjcf.jointCount < Math.ceil(introspectionJointCount * 0.4)) ||
            (introspectionBodyCount >= 3 &&
              builtFromMjcf.linkCount < Math.ceil(introspectionBodyCount * 0.4))
          );
        if (mjcfHierarchyIncomplete && introspection) {
          const built = buildRobotFromIntrospection(introspection, displayName);
          root = built.root;
          logWarn("USD MJCF hierarchy appears incomplete; using introspection skeleton.", {
            scope: "usd",
            data: {
              usdKey,
              converterAssetId: resolvedConverterAssetId,
              mjcfAssetId: resolvedMjcfAssetId,
              introspectionJoints: introspectionJointCount,
              introspectionBodies: introspectionBodyCount,
              mjcfLinks: builtFromMjcf.linkCount,
              mjcfJoints: builtFromMjcf.jointCount,
            },
          });
          logInfo("USD conversion + render completed", {
            scope: "usd",
            data: {
              usdKey,
              converterAssetId: resolvedConverterAssetId,
              mjcfAssetId: resolvedMjcfAssetId,
              links: built.linkCount,
              joints: built.jointCount,
              hierarchySource: "introspection",
              diagnostics: converted.diagnostics ?? null,
            },
          });
        } else {
          root = builtFromMjcf.root;
          logInfo("USD conversion + render completed", {
            scope: "usd",
            data: {
              usdKey,
              converterAssetId: resolvedConverterAssetId,
              mjcfAssetId: resolvedMjcfAssetId,
              links: builtFromMjcf.linkCount,
              joints: builtFromMjcf.jointCount,
              hierarchySource: "mjcf",
              diagnostics: converted.diagnostics ?? null,
            },
          });
        }
      }

      logInfo("USD visual->collision sync enabled by default.", {
        scope: "usd",
        data: {
          usdKey,
          converterAssetId: resolvedConverterAssetId,
        },
      });
    } catch (error) {
      logWarn("USD conversion failed; checking introspection fallback.", {
        scope: "usd",
        data: {
          usdKey,
          converterAssetId: resolvedConverterAssetId,
          error: String((error as Error)?.message ?? error),
        },
      });
    }
  } else {
    logWarn("USD converter is disabled (empty VITE_USD_CONVERTER_BASE_URL). Using fallback hierarchy.", {
      scope: "usd",
    });
  }

  if (!root && introspection) {
    const built = buildRobotFromIntrospection(introspection, displayName);
    root = built.root;
    logInfo("USD introspection fallback hierarchy used.", {
      scope: "usd",
      data: {
        usdKey,
        converterAssetId: resolvedConverterAssetId,
        links: built.linkCount,
        joints: built.jointCount,
      },
    });
  }

  if (!root) {
    root = await fallbackUsdHierarchyFromTokens(displayName, usdUrl, resolveResource);
  }

  attachUsdIntrospectionMetadata(root, introspection);
  const bodyPosesApplied = applyUsdBodyPosesToCollapsedLinks(root, meshScene);
  let mjcfBodiesPatchedFromMeshScene = 0;
  if (bodyPosesApplied > 0) {
    logInfo("USD body poses applied to collapsed link layout", {
      scope: "usd",
      data: {
        usdKey,
        converterAssetId: resolvedConverterAssetId,
        bodyPosesApplied,
        meshSceneBodyCount: meshScene?.bodyCount ?? 0,
      },
    });
    if (mjcfXml) {
      const patched = applyMeshSceneBodyPosesToMjcf(mjcfXml, meshScene);
      if (patched.updatedBodyCount > 0) {
        mjcfXml = patched.mjcfXml;
        mjcfBodiesPatchedFromMeshScene = patched.updatedBodyCount;
        logInfo("USD MJCF body poses patched from mesh scene", {
          scope: "usd",
          data: {
            usdKey,
            converterAssetId: resolvedConverterAssetId,
            patchedBodies: patched.updatedBodyCount,
          },
        });
      } else {
        logWarn("USD body poses were adjusted in viewer but MJCF body patch found no matching names.", {
          scope: "usd",
          data: {
            usdKey,
            converterAssetId: resolvedConverterAssetId,
            bodyPosesApplied,
            meshSceneBodyCount: meshScene?.bodyCount ?? 0,
          },
        });
      }
    }
  }
  const meshAttach = attachUsdMeshSceneToRoot(root, meshScene, {
    selfCollisionEnabled: importOptions?.selfCollision === true,
    resolveResource,
    attachCollisionProxies: useVisualCollisionSync,
    replaceExisting: importSceneRole === "scene_asset" && Boolean(meshScene && meshScene.meshes.length > 0),
  });
  if (meshScene && meshScene.meshes.length > 0 && meshAttach.attachedMeshes === 0) {
    logWarn("USD mesh scene contains meshes but none were attached; keeping fallback geometry.", {
      scope: "usd",
      data: {
        usdKey,
        converterAssetId: resolvedConverterAssetId,
        meshCount: meshScene.meshes.length,
        primitiveCount: meshScene.primitives.length,
        bodyCount: meshScene.bodyCount,
      },
    });
  }
  if (meshAttach.attachedMeshes > 0 || meshAttach.attachedPrimitives > 0) {
    logInfo("USD mesh scene attached", {
      scope: "usd",
      data: {
        usdKey,
        converterAssetId: resolvedConverterAssetId,
        attachedMeshes: meshAttach.attachedMeshes,
        attachedPrimitives: meshAttach.attachedPrimitives,
        bodyCount: meshScene?.bodyCount ?? 0,
        attachedToLinks: meshAttach.attachedToLinks,
        attachedToRoot: meshAttach.attachedToRoot,
        meshSceneTruncated: Boolean(meshScene?.truncated),
        materialsBound: Number(root.userData?.usdMeshScene?.materialsBound ?? 0),
        texturedMaterials: Number(root.userData?.usdMeshScene?.texturedMaterials ?? 0),
      },
    });
  }

  if (importSceneRole === "scene_asset") {
    retagUsdRootAsSceneAsset(root, stripFileExtension(displayName) || displayName);
    applySceneAssetPhysicsDefaults(root);
    root.userData.usdUrl = usdUrl;
    root.userData.usdWorkspaceKey = usdKey;
    if (resolvedConverterAssetId) root.userData.converterAssetId = resolvedConverterAssetId;
    if (resolvedMjcfAssetId) root.userData.mjcfAssetId = resolvedMjcfAssetId;
    if (mjcfXml) root.userData.mjcfSource = mjcfXml;
    if (mjcfBodiesPatchedFromMeshScene > 0) root.userData.mjcfBodyPosePatchCount = mjcfBodiesPatchedFromMeshScene;
    logInfo("USD scene asset import completed", {
      scope: "usd",
      data: {
        usdKey,
        sceneAssetName: root.name,
        converterAssetId: resolvedConverterAssetId,
        attachedMeshes: meshAttach.attachedMeshes,
        attachedPrimitives: meshAttach.attachedPrimitives,
      },
    });
    return root;
  }

  const modelSource: UsdModelSource = {
    kind: "usd",
    usdKey: resolvedConverterAssetId ?? usdKey,
    workspaceKey: usdKey,
    converterAssetId: resolvedConverterAssetId,
    trainingAssetId: null,
    // Keep the converted MJCF reference even when visual/collision sync is enabled.
    // MuJoCo runtime reload depends on this cached source for clean USD models.
    mjcfKey: resolvedMjcfAssetId,
    importOptions: {
      ...(importOptions ?? {}),
      floatingBase:
        typeof importOptions?.floatingBase === "boolean"
          ? importOptions.floatingBase
          : (detectedFloatingBase ?? false),
    },
    // Visual/collision sync is part of the default import pipeline and should not
    // mark the source as user-edited. Edits are tracked later via markSceneDirty.
    isDirty: false,
  };

  root.userData.robotModelSource = modelSource;
  root.userData.usdUrl = usdUrl;
  root.userData.usdWorkspaceKey = usdKey;
  if (resolvedConverterAssetId) root.userData.converterAssetId = resolvedConverterAssetId;
  if (resolvedMjcfAssetId) root.userData.mjcfAssetId = resolvedMjcfAssetId;
  if (mjcfXml) root.userData.mjcfSource = mjcfXml;
  if (mjcfBodiesPatchedFromMeshScene > 0) root.userData.mjcfBodyPosePatchCount = mjcfBodiesPatchedFromMeshScene;

  return root;
}

export type USDImportDeps = {
  usdKey: string | null;
  assets: Record<string, UsdWorkspaceAssetEntry>;
  importOptions?: USDLoaderParams["importOptions"];
  bundleHintPaths?: string[];
  rootName?: string;
  sceneRole?: USDLoaderParams["sceneRole"];
  frameOnAdd?: boolean;
};

export async function loadWorkspaceUSDIntoViewer(deps: USDImportDeps) {
  const { usdKey, assets, importOptions, bundleHintPaths, rootName, sceneRole, frameOnAdd } = deps;

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

  return await useLoaderStore.getState().load(
    "usd",
    {
      usdUrl: entry.url,
      usdKey,
      usdFile: entry.file,
      usdName: rootName?.trim() || basename(usdKey),
      sceneRole,
      resolveResource,
      assetsByKey: assets,
      importOptions,
      bundleHintPaths,
    } satisfies USDLoaderParams,
    {
      name: rootName?.trim() || undefined,
      frame: frameOnAdd ?? true,
    }
  );
}
