import * as THREE from "three";
import type { UsdImportOptions } from "../../usd/usdImportOptions";
import type { UsdWorkspaceAssetEntry } from "../../usd/usdBundleCollector";
import type { UsdModelSource } from "../../editor/document/types";
import type { Pose, UrdfCollision, UrdfGeom, UrdfJoint, UrdfLink } from "../../urdf/urdfModel";
import type { UsdJointPoseDecision, UsdJointPoseError, UsdJointPosePolicy } from "../usdPosePolicy";

// ── Re-exports so sibling modules can import from types.ts ──────────────
export type { Pose, UrdfCollision, UrdfGeom, UrdfJoint, UrdfLink };
export type { UsdJointPoseDecision, UsdJointPoseError, UsdJointPosePolicy };
export type { UsdImportOptions };
export type { UsdWorkspaceAssetEntry };
export type { UsdModelSource };

// ── Exported type definitions ───────────────────────────────────────────

export type UsdVariantImportHints = {
  referenceUsdKey?: string | null;
  posePolicy?: UsdJointPosePolicy;
};

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
  variantImportHints?: UsdVariantImportHints;
};

export type MjcfGeomDef = {
  name: string;
  type: string;
  size: [number, number, number];
  mesh?: string;
  pos: [number, number, number];
  quat: THREE.Quaternion;
  rgba?: [number, number, number, number];
};

export type MjcfMeshAssetDef = {
  vertices: Float32Array;
  faces: Uint32Array;
};

export type MjcfJointDef = {
  name: string;
  type: string;
  axis: [number, number, number];
  pos: [number, number, number];
  range?: [number, number];
  damping?: number;
  friction?: number;
  armature?: number;
};

export type MjcfBodyDef = {
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

export type ParsedMjcf = {
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

export type NormalizedUsdConverterDiagnostics = {
  placeholderGeomBodies: number;
  bodiesWithAnyGeom: number;
  linkCount: number;
  jointCount: number;
};

export type UsdConverterIntrospectionJoint = {
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

export type UsdConverterIntrospectionResponse = {
  assetId?: string;
  filename?: string;
  joints?: UsdConverterIntrospectionJoint[];
  rootBodies?: string[];
  stageUpAxis?: string;
};

export type UsdConverterMeshSceneMesh = {
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
  normalTexture?: unknown;
  metallicTexture?: unknown;
  roughnessTexture?: unknown;
  metallicRoughnessTexture?: unknown;
  occlusionTexture?: unknown;
  emissiveTexture?: unknown;
  opacityTexture?: unknown;
  metallicFactor?: unknown;
  roughnessFactor?: unknown;
  emissiveFactor?: unknown;
  opacityFactor?: unknown;
  materialChannelSources?: unknown;
};

export type UsdConverterMeshScenePrimitive = {
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
  normalTexture?: unknown;
  metallicTexture?: unknown;
  roughnessTexture?: unknown;
  metallicRoughnessTexture?: unknown;
  occlusionTexture?: unknown;
  emissiveTexture?: unknown;
  opacityTexture?: unknown;
  metallicFactor?: unknown;
  roughnessFactor?: unknown;
  emissiveFactor?: unknown;
  opacityFactor?: unknown;
  materialChannelSources?: unknown;
};

export type UsdConverterMeshSceneBody = {
  name?: string;
  primPath?: string;
  parentBody?: string | null;
  parentBodyPath?: string | null;
  position?: unknown;
  quaternion?: unknown;
  scale?: unknown;
  rigidBodyEnabled?: unknown;
  kinematicEnabled?: unknown;
  mass?: unknown;
};

export type UsdConverterMeshSceneResponse = {
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

export type NormalizedIntrospectionJoint = {
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

export type NormalizedUsdIntrospection = {
  assetId: string;
  filename: string;
  joints: NormalizedIntrospectionJoint[];
  rootBodies: string[];
  stageUpAxis: "X" | "Y" | "Z" | "unknown";
};

export type NormalizedUsdMaterialChannelSources = {
  baseColor: "explicit" | "generic_fallback" | null;
  normal: "explicit" | "generic_fallback" | null;
  metallic: "explicit" | "generic_fallback" | null;
  roughness: "explicit" | "generic_fallback" | null;
  metallicRoughness: "explicit" | "generic_fallback" | null;
  occlusion: "explicit" | "generic_fallback" | null;
  emissive: "explicit" | "generic_fallback" | null;
  opacity: "explicit" | "generic_fallback" | null;
};

export type NormalizedUsdMeshSceneMesh = {
  name: string;
  primPath: string;
  parentBody: string | null;
  parentBodyPath: string | null;
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
  normalTexture: string | null;
  metallicTexture: string | null;
  roughnessTexture: string | null;
  metallicRoughnessTexture: string | null;
  occlusionTexture: string | null;
  emissiveTexture: string | null;
  opacityTexture: string | null;
  metallicFactor: number | null;
  roughnessFactor: number | null;
  emissiveFactor: [number, number, number] | null;
  opacityFactor: number | null;
  materialChannelSources: NormalizedUsdMaterialChannelSources | null;
};

export type NormalizedUsdMeshScenePrimitiveKind = "sphere" | "capsule" | "cylinder" | "cone" | "cube";

export type NormalizedUsdMeshScenePrimitive = {
  name: string;
  primPath: string;
  parentBody: string | null;
  parentBodyPath: string | null;
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
  normalTexture: string | null;
  metallicTexture: string | null;
  roughnessTexture: string | null;
  metallicRoughnessTexture: string | null;
  occlusionTexture: string | null;
  emissiveTexture: string | null;
  opacityTexture: string | null;
  metallicFactor: number | null;
  roughnessFactor: number | null;
  emissiveFactor: [number, number, number] | null;
  opacityFactor: number | null;
  materialChannelSources: NormalizedUsdMaterialChannelSources | null;
};

export type NormalizedUsdMeshSceneBody = {
  name: string;
  primPath: string;
  parentBody: string | null;
  parentBodyPath: string | null;
  position: [number, number, number];
  quaternion: THREE.Quaternion;
  scale: [number, number, number];
  rigidBodyEnabled: boolean | null;
  kinematicEnabled: boolean | null;
  mass: number | null;
};

export type NormalizedUsdMeshScene = {
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

export type UsdImportWarning = {
  code: string;
  message: string;
  context?: Record<string, unknown>;
};

export type UsdPrimNode = {
  path: string;
  name: string;
  parentPath: string | null;
  kind: "group" | "link" | "joint";
};

export type UsdJointPoseDecisionRecord = {
  jointName: string;
  parentLinkName: string;
  childLinkName: string;
  source: "frame_pair" | "mjcf_body";
  reason: UsdJointPoseDecision["reason"];
  framePairMismatchDistance: number | null;
  framePairErrorToMjcf: UsdJointPoseError | null;
  framePairErrorToMesh: UsdJointPoseError | null;
  mjcfErrorToMesh: UsdJointPoseError | null;
  meshReferenceSource: "payload_local" | "world_rebased" | "none";
};

export type UsdJointPoseDecisionSummary = {
  totalDecisions: number;
  framePairDecisions: number;
  mjcfDecisions: number;
  fallbackCount: number;
  fallbackJoints: string[];
  decisions: UsdJointPoseDecisionRecord[];
};

export type UsdTextureColorSpace = "srgb" | "linear";

export type ResolvedUsdMaterialTextures = {
  baseColorUrl: string | null;
  normalUrl: string | null;
  metallicUrl: string | null;
  roughnessUrl: string | null;
  metallicRoughnessUrl: string | null;
  occlusionUrl: string | null;
  emissiveUrl: string | null;
  opacityUrl: string | null;
};

export type UsdMaterialChannelKey = keyof NormalizedUsdMaterialChannelSources;

export type UsdLinkRenderGroupEntry = {
  link: THREE.Group;
  visual: THREE.Group;
  collision: THREE.Group;
  preparedForUsd: boolean;
  aliases: string[];
  bodyToken: string | null;
  bodyPath: string | null;
  sourcePrimPaths: Set<string>;
};

export type UsdLinkLookup = {
  byAlias: Map<string, UsdLinkRenderGroupEntry[]>;
  entries: UsdLinkRenderGroupEntry[];
  aliasCollisionCount: number;
};

export type USDImportDeps = {
  usdKey: string | null;
  assets: Record<string, UsdWorkspaceAssetEntry>;
  importOptions?: USDLoaderParams["importOptions"];
  bundleHintPaths?: string[];
  variantImportHints?: USDLoaderParams["variantImportHints"];
  rootName?: string;
  sceneRole?: USDLoaderParams["sceneRole"];
  frameOnAdd?: boolean;
  skipPostLoadHook?: boolean;
};

// ── Shared constants ────────────────────────────────────────────────────

export const DEFAULT_VISUAL_RGBA: [number, number, number, number] = [0.72, 0.79, 0.9, 1];
export const ISAAC_LAB_DEFAULT_SURFACE_FRICTION = 1.0;
export const ISAAC_LAB_DEFAULT_SURFACE_RESTITUTION = 0.0;
export const IDENTITY_QUAT = new THREE.Quaternion(0, 0, 0, 1);

export const REFERENCE_EXT_RE = /(?:^|[./\\])[A-Za-z0-9_.-]+\.(usd|usda|usdc|usdz)$/i;
export const JOINT_NAME_RE = /(joint|dof|haa|hfe|kfe|hinge|slider|prismatic|revolute|actuator)/i;
export const LINK_NAME_RE = /(link|base|hip|thigh|shank|foot|body|chassis|arm|wheel|sensor|payload|camera|imu|lidar)/i;
export const PATH_SKIP_SEGMENTS = new Set([
  "properties",
  "props",
  "config",
  "state",
  "children",
  "component",
  "components",
  "metadata",
  "settings",
  "constructor",
  "prototype",
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
export const FILE_EXT_SKIP_RE = /\.(png|jpg|jpeg|webp|tiff|bmp|hdr|exr|mtl|obj|stl|dae|fbx|gltf|glb|xml|mjcf)$/i;

// ── Shared utility functions ────────────────────────────────────────────

export const normalizeBodyToken = (value: unknown): string | null => {
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

export const normalizeAliasToken = (value: string | null | undefined): string | null => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  return raw.toLowerCase();
};

export const normalizePathAliasToken = (value: string | null | undefined): string | null => {
  const raw = String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (!raw) return null;
  return raw.toLowerCase();
};

export const stripFileExtension = (name: string) => name.replace(/\.[^/.]+$/, "");

export const claimName = (base: string, used: Set<string>, fallbackPrefix: string) => {
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

export const toPose = (pos: [number, number, number], quat: THREE.Quaternion): Pose => {
  const euler = new THREE.Euler().setFromQuaternion(quat, "ZYX");
  return {
    xyz: [pos[0], pos[1], pos[2]],
    rpy: [euler.x, euler.y, euler.z],
  };
};

export const normalizeAxisTuple = (axis: [number, number, number]): [number, number, number] => {
  const vec = new THREE.Vector3(
    Number.isFinite(axis[0]) ? axis[0] : 0,
    Number.isFinite(axis[1]) ? axis[1] : 0,
    Number.isFinite(axis[2]) ? axis[2] : 1
  );
  if (vec.lengthSq() <= 1e-12) return [0, 0, 1];
  vec.normalize();
  return [vec.x, vec.y, vec.z];
};

export const axisInJointFrame = (
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

export const computeRelativePoseFromWorld = (
  childPose: { position: [number, number, number]; quaternion: THREE.Quaternion },
  parentPose: { position: [number, number, number]; quaternion: THREE.Quaternion }
): { position: [number, number, number]; quaternion: THREE.Quaternion } => {
  const childPos = new THREE.Vector3(childPose.position[0], childPose.position[1], childPose.position[2]);
  const parentPos = new THREE.Vector3(parentPose.position[0], parentPose.position[1], parentPose.position[2]);
  const parentInv = parentPose.quaternion.clone().invert();
  const relPos = childPos.sub(parentPos).applyQuaternion(parentInv);
  const relQuat = parentInv.multiply(childPose.quaternion.clone()).normalize();
  return {
    position: [relPos.x, relPos.y, relPos.z],
    quaternion: relQuat,
  };
};

export const shouldTreatMeshScenePoseAsWorld = (input: {
  payloadParentToken: string | null;
  expectedParentToken: string | null;
  position: [number, number, number];
  quaternion: THREE.Quaternion;
  bodyPoseByToken: Map<string, NormalizedUsdMeshSceneBody>;
}): boolean => {
  const payloadParentToken = normalizeBodyToken(input.payloadParentToken);
  const expectedParentToken = normalizeBodyToken(input.expectedParentToken);
  if (!payloadParentToken) return true;
  if (expectedParentToken && payloadParentToken !== expectedParentToken) return true;
  const parentBodyPose = input.bodyPoseByToken.get(payloadParentToken);
  if (!parentBodyPose) return false;
  const localMagnitude = Math.hypot(input.position[0], input.position[1], input.position[2]);
  const payloadPosition = new THREE.Vector3(input.position[0], input.position[1], input.position[2]);
  const parentPosition = new THREE.Vector3(
    parentBodyPose.position[0],
    parentBodyPose.position[1],
    parentBodyPose.position[2]
  );
  const distanceToBodyWorld = payloadPosition.distanceTo(parentPosition);
  const angleToBodyWorld = input.quaternion.angleTo(parentBodyPose.quaternion);
  const positionLooksWorld = localMagnitude >= 0.2 && distanceToBodyWorld < 0.18 && angleToBodyWorld < 0.5;
  const orientationLooksWorld = localMagnitude < 0.2 && distanceToBodyWorld < 0.25 && angleToBodyWorld < 0.25;
  return positionLooksWorld || orientationLooksWorld;
};

export const resolveMeshSceneBodyLocalPose = (input: {
  body: NormalizedUsdMeshSceneBody;
  expectedParentToken: string | null;
  bodyByToken: Map<string, NormalizedUsdMeshSceneBody>;
}): {
  localPose: { position: [number, number, number]; quaternion: THREE.Quaternion };
  source: "payload_local" | "world_rebased";
  payloadParentToken: string | null;
} | null => {
  const expectedParentToken = normalizeBodyToken(input.expectedParentToken);
  const payloadParentToken = normalizeBodyToken(input.body.parentBody);
  const expectedParentBody = expectedParentToken ? input.bodyByToken.get(expectedParentToken) ?? null : null;

  const useWorldFallback = shouldTreatMeshScenePoseAsWorld({
    payloadParentToken,
    expectedParentToken,
    position: input.body.position,
    quaternion: input.body.quaternion,
    bodyPoseByToken: input.bodyByToken,
  });

  if (useWorldFallback && expectedParentBody) {
    return {
      localPose: computeRelativePoseFromWorld(
        { position: input.body.position, quaternion: input.body.quaternion },
        { position: expectedParentBody.position, quaternion: expectedParentBody.quaternion }
      ),
      source: "world_rebased",
      payloadParentToken,
    };
  }

  if (payloadParentToken) {
    if (expectedParentToken && payloadParentToken !== expectedParentToken && expectedParentBody) {
      return {
        localPose: computeRelativePoseFromWorld(
          { position: input.body.position, quaternion: input.body.quaternion },
          { position: expectedParentBody.position, quaternion: expectedParentBody.quaternion }
        ),
        source: "world_rebased",
        payloadParentToken,
      };
    }
    return {
      localPose: {
        position: [input.body.position[0], input.body.position[1], input.body.position[2]],
        quaternion: input.body.quaternion.clone(),
      },
      source: "payload_local",
      payloadParentToken,
    };
  }

  if (expectedParentBody) {
    return {
      localPose: computeRelativePoseFromWorld(
        { position: input.body.position, quaternion: input.body.quaternion },
        { position: expectedParentBody.position, quaternion: expectedParentBody.quaternion }
      ),
      source: "world_rebased",
      payloadParentToken: null,
    };
  }

  return {
    localPose: {
      position: [input.body.position[0], input.body.position[1], input.body.position[2]],
      quaternion: input.body.quaternion.clone(),
    },
    source: "payload_local",
    payloadParentToken,
  };
};
