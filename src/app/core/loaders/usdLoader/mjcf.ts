import * as THREE from "three";
import { logInfo, logWarn } from "../../services/logger";
import {
  buildJointPoseError,
  chooseUsdJointPoseSource,
} from "../usdPosePolicy";
import {
  normalizeBodyToken,
  normalizePathAliasToken,
  claimName,
  toPose,
  normalizeAxisTuple,
  axisInJointFrame,
  DEFAULT_VISUAL_RGBA,
  resolveMeshSceneBodyLocalPose,
} from "./types";
import type {
  MjcfBodyDef,
  MjcfGeomDef,
  MjcfMeshAssetDef,
  MjcfJointDef,
  ParsedMjcf,
  NormalizedUsdIntrospection,
  NormalizedIntrospectionJoint,
  NormalizedUsdMeshScene,
  NormalizedUsdMeshSceneBody,
  UsdJointPoseDecisionRecord,
  UsdJointPoseDecisionSummary,
  UrdfCollision,
  UrdfGeom,
  UrdfJoint,
  UrdfLink,
  UsdJointPosePolicy,
} from "./types";

// ---------------------------------------------------------------------------
// MJCF tuple / quaternion parsing
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// MJCF joint / actuator helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// MJCF parsing
// ---------------------------------------------------------------------------

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

export const parseMjcf = (mjcfXml: string): ParsedMjcf => {
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

// ---------------------------------------------------------------------------
// MJCF formatting
// ---------------------------------------------------------------------------

const formatMjcfNumber = (value: number) => (Number.isFinite(value) ? value : 0).toFixed(6);

const formatMjcfVec3 = (value: [number, number, number]) =>
  `${formatMjcfNumber(value[0])} ${formatMjcfNumber(value[1])} ${formatMjcfNumber(value[2])}`;

const formatMjcfQuatWxyz = (value: THREE.Quaternion) =>
  `${formatMjcfNumber(value.w)} ${formatMjcfNumber(value.x)} ${formatMjcfNumber(value.y)} ${formatMjcfNumber(value.z)}`;

// ---------------------------------------------------------------------------
// MJCF body pose patching
// ---------------------------------------------------------------------------

export const applyMeshSceneBodyPosesToMjcf = (
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

// ---------------------------------------------------------------------------
// Geometry creation for MJCF
// ---------------------------------------------------------------------------

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
      metalness: 0.02,
      roughness: 0.9,
      envMapIntensity: 0.26,
    });
    (visualMaterial.userData ??= {}).viewportSurfaceProfile = "usd_pbr";

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

// ---------------------------------------------------------------------------
// Robot build from MJCF
// ---------------------------------------------------------------------------

export const buildRobotFromMjcf = (
  parsed: ParsedMjcf,
  robotName: string,
  options?: {
    instantiateRenderGroups?: boolean;
    introspection?: NormalizedUsdIntrospection | null;
    meshScene?: NormalizedUsdMeshScene | null;
    posePolicy?: UsdJointPosePolicy;
    traceId?: string;
    debugTraceDetailed?: boolean;
  }
): { root: THREE.Group; linkCount: number; jointCount: number; poseSummary: UsdJointPoseDecisionSummary } => {
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
  const bodyPathByToken = new Map<string, string>();
  for (const joint of introspectionJoints) {
    const parentToken = normalizeBodyToken(joint.parentBody);
    const parentPath = normalizePathAliasToken(joint.parentBodyPath);
    if (parentToken && parentPath && !bodyPathByToken.has(parentToken)) bodyPathByToken.set(parentToken, parentPath);
    const childToken = normalizeBodyToken(joint.childBody);
    const childPath = normalizePathAliasToken(joint.childBodyPath);
    if (childToken && childPath && !bodyPathByToken.has(childToken)) bodyPathByToken.set(childToken, childPath);
  }
  const usedIntrospectionJointIndexes = new Set<number>();
  let linkCount = 0;
  let jointCount = 0;
  const posePolicy: UsdJointPosePolicy = options?.posePolicy ?? "auto";
  const debugTraceDetailed = options?.debugTraceDetailed === true;
  const traceId = String(options?.traceId ?? "").trim() || null;
  const meshSceneBodyByToken = new Map(
    (options?.meshScene?.bodies ?? [])
      .map((body) => {
        const token = normalizeBodyToken(body.name);
        return token ? ([token, body] as const) : null;
      })
      .filter((entry): entry is readonly [string, NormalizedUsdMeshSceneBody] => Boolean(entry))
  );
  const poseDecisionRecords: UsdJointPoseDecisionRecord[] = [];
  const poseFallbackJoints: string[] = [];

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

  const FRAME_PAIR_WORLD_MISMATCH_TOLERANCE_M = 0.01;

  const computeChildPoseFromFrame1 = (frame1: { position: [number, number, number]; quaternion: THREE.Quaternion }) => {
    const childQuat = frame1.quaternion.clone().invert();
    const childPos = new THREE.Vector3(-frame1.position[0], -frame1.position[1], -frame1.position[2]).applyQuaternion(childQuat);
    return { position: childPos, quaternion: childQuat };
  };

  const compareFramePairAgainstBodyPose = (
    frame0: { position: [number, number, number]; quaternion: THREE.Quaternion },
    frame1: { position: [number, number, number]; quaternion: THREE.Quaternion },
    bodyDef: MjcfBodyDef
  ) => {
    const childPoseInJoint = computeChildPoseFromFrame1(frame1);
    const frame0Pos = new THREE.Vector3(frame0.position[0], frame0.position[1], frame0.position[2]);
    const impliedChildPos = frame0Pos.add(childPoseInJoint.position.clone().applyQuaternion(frame0.quaternion));
    const impliedChildQuat = frame0.quaternion.clone().multiply(childPoseInJoint.quaternion).normalize();
    const bodyPos = new THREE.Vector3(bodyDef.pos[0], bodyDef.pos[1], bodyDef.pos[2]);
    const bodyQuat = bodyDef.quat.clone().normalize();
    return {
      positionError: impliedChildPos.distanceTo(bodyPos),
      rotationError: impliedChildQuat.angleTo(bodyQuat),
      impliedChildPose: {
        position: [impliedChildPos.x, impliedChildPos.y, impliedChildPos.z] as [number, number, number],
        quaternion: impliedChildQuat,
      },
      mjcfPose: {
        position: [bodyPos.x, bodyPos.y, bodyPos.z] as [number, number, number],
        quaternion: bodyQuat,
      },
      childPoseInJoint,
    };
  };

  const resolveMeshReferencePose = (parentLinkName: string, childLinkName: string) => {
    const childToken = normalizeBodyToken(childLinkName);
    if (!childToken) return null;
    const childBody = meshSceneBodyByToken.get(childToken);
    if (!childBody) return null;
    const expectedParentToken = normalizeBodyToken(parentLinkName);
    const resolved = resolveMeshSceneBodyLocalPose({
      body: childBody,
      expectedParentToken,
      bodyByToken: meshSceneBodyByToken,
    });
    if (!resolved) return null;
    return {
      ...resolved.localPose,
      source: resolved.source,
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
    const bodyToken = normalizeBodyToken(body.name) ?? normalizeBodyToken(linkName);
    if (bodyToken) {
      link.userData.usdBodyToken = bodyToken;
      const bodyPath = bodyPathByToken.get(bodyToken);
      if (bodyPath) link.userData.usdBodyPath = bodyPath;
    }

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
      const frameMismatchDistanceToken = Number(introspectionJoint?.frameMismatchDistance);
      const frameMismatchDistance = Number.isFinite(frameMismatchDistanceToken) ? frameMismatchDistanceToken : null;
      const framePairMismatchOk =
        frameMismatchDistance === null || frameMismatchDistance <= FRAME_PAIR_WORLD_MISMATCH_TOLERANCE_M;
      const framePairComparison =
        frame0Local && frame1Local ? compareFramePairAgainstBodyPose(frame0Local, frame1Local, body) : null;
      const meshReferencePose = resolveMeshReferencePose(parentLinkName, linkName);
      const framePairErrorToMesh =
        framePairComparison && meshReferencePose
          ? buildJointPoseError(
              new THREE.Vector3(
                framePairComparison.impliedChildPose.position[0],
                framePairComparison.impliedChildPose.position[1],
                framePairComparison.impliedChildPose.position[2]
              ).distanceTo(
                new THREE.Vector3(
                  meshReferencePose.position[0],
                  meshReferencePose.position[1],
                  meshReferencePose.position[2]
                )
              ),
              framePairComparison.impliedChildPose.quaternion.angleTo(meshReferencePose.quaternion)
            )
          : null;
      const mjcfErrorToMesh = meshReferencePose
        ? buildJointPoseError(
            new THREE.Vector3(body.pos[0], body.pos[1], body.pos[2]).distanceTo(
              new THREE.Vector3(
                meshReferencePose.position[0],
                meshReferencePose.position[1],
                meshReferencePose.position[2]
              )
            ),
            body.quat.clone().normalize().angleTo(meshReferencePose.quaternion)
          )
        : null;
      const poseDecision = chooseUsdJointPoseSource({
        policy: posePolicy,
        hasFramePair,
        framePairMismatchOk,
        meshReferenceAvailable: Boolean(meshReferencePose),
        framePairErrorToMesh,
        mjcfErrorToMesh,
        severePositionThresholdM: 0.08,
        severeRotationThresholdRad: 0.75,
      });
      const useFramePairFinal = poseDecision.source === "frame_pair" && Boolean(frame0Local && frame1Local);

      if (hasFramePair && !framePairMismatchOk) {
        logWarn("USD joint frame pair reports large frame mismatch; falling back to MJCF local pose for this joint.", {
          scope: "usd",
          data: {
            jointName,
            parentLinkName,
            childLinkName: linkName,
            frameMismatchDistance,
            frameMismatchTolerance: FRAME_PAIR_WORLD_MISMATCH_TOLERANCE_M,
          },
        });
      } else if (
        useFramePairFinal &&
        framePairComparison &&
        (framePairComparison.positionError > 1e-4 || framePairComparison.rotationError > 1e-3)
      ) {
        logWarn("USD frame pair and MJCF body pose diverge; keeping USD frame pair for local chain coherence.", {
          scope: "usd",
          data: {
            jointName,
            parentLinkName,
            childLinkName: linkName,
            mjcfBodyPositionError: framePairComparison.positionError,
            mjcfBodyRotationErrorRad: framePairComparison.rotationError,
          },
        });
      } else if (hasFramePair && poseDecision.source === "mjcf_body") {
        logWarn("USD joint pose switched to MJCF body local pose based on policy/evidence.", {
          scope: "usd",
          data: {
            traceId,
            jointName,
            parentLinkName,
            childLinkName: linkName,
            reason: poseDecision.reason,
            frameMismatchDistance,
            framePairErrorToMesh,
            mjcfErrorToMesh,
          },
        });
      }
      if (hasFramePair && poseDecision.source === "mjcf_body") {
        poseFallbackJoints.push(jointName);
      }
      poseDecisionRecords.push({
        jointName,
        parentLinkName,
        childLinkName: linkName,
        source: poseDecision.source,
        reason: poseDecision.reason,
        framePairMismatchDistance: frameMismatchDistance,
        framePairErrorToMjcf: framePairComparison
          ? buildJointPoseError(framePairComparison.positionError, framePairComparison.rotationError)
          : null,
        framePairErrorToMesh,
        mjcfErrorToMesh,
        meshReferenceSource: meshReferencePose?.source ?? "none",
      });
      if (debugTraceDetailed) {
        logInfo("USD joint pose decision", {
          scope: "usd",
          data: {
            traceId,
            jointName,
            parentLinkName,
            childLinkName: linkName,
            policy: posePolicy,
            source: poseDecision.source,
            reason: poseDecision.reason,
            framePairMismatchDistance: frameMismatchDistance,
            framePairErrorToMjcf: framePairComparison
              ? {
                  positionErrorM: framePairComparison.positionError,
                  rotationErrorRad: framePairComparison.rotationError,
                }
              : null,
            framePairErrorToMesh,
            mjcfErrorToMesh,
            meshReferenceSource: meshReferencePose?.source ?? "none",
          },
        });
      }
      const rawJointAxis = introspectionJoint?.axisLocal ?? introspectionJoint?.axis ?? rawJoint?.axis ?? [0, 0, 1];
      const fallbackAxis = rawJoint?.axis ?? introspectionJoint?.axisLocal ?? introspectionJoint?.axis ?? [0, 0, 1];
      const jointAxis = useFramePairFinal && frame0Local
        ? axisInJointFrame([rawJointAxis[0], rawJointAxis[1], rawJointAxis[2]], frame0Local.quaternion)
        : normalizeAxisTuple([fallbackAxis[0], fallbackAxis[1], fallbackAxis[2]]);
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
      const jointPosePosition = useFramePairFinal && frame0Local ? frame0Local.position : body.pos;
      const jointPoseQuaternion = useFramePairFinal && frame0Local ? frame0Local.quaternion : body.quat;
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

      if (useFramePairFinal && framePairComparison) {
        link.position.copy(framePairComparison.childPoseInJoint.position);
        link.quaternion.copy(framePairComparison.childPoseInJoint.quaternion);
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

  const framePairDecisions = poseDecisionRecords.filter((item) => item.source === "frame_pair").length;
  const mjcfDecisions = poseDecisionRecords.length - framePairDecisions;
  const poseSummary: UsdJointPoseDecisionSummary = {
    totalDecisions: poseDecisionRecords.length,
    framePairDecisions,
    mjcfDecisions,
    fallbackCount: poseFallbackJoints.length,
    fallbackJoints: [...poseFallbackJoints],
    decisions: poseDecisionRecords,
  };

  if (debugTraceDetailed) {
    logInfo("USD joint pose decision trace summary", {
      scope: "usd",
      data: {
        traceId,
        robotName,
        policy: posePolicy,
        totalDecisions: poseSummary.totalDecisions,
        framePairDecisions: poseSummary.framePairDecisions,
        mjcfDecisions: poseSummary.mjcfDecisions,
        fallbackCount: poseSummary.fallbackCount,
      },
    });
  }

  return { root: robotRoot, linkCount, jointCount, poseSummary };
};
