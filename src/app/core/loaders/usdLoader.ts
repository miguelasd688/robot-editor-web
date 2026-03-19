import * as THREE from "three";
import type { UsdImportOptions } from "../usd/usdImportOptions";
import {
  collectUsdBundleFiles as collectUsdBundleFilesFromCollector,
  type CollectedUsdBundle,
  type UsdWorkspaceAssetEntry,
} from "../usd/usdBundleCollector";
import type { UsdModelSource } from "../editor/document/types";
import type { Pose, UrdfCollision, UrdfGeom, UrdfJoint, UrdfLink } from "../urdf/urdfModel";
import { basename, createAssetResolver } from "./assetResolver";
import { logInfo, logWarn } from "../services/logger";
import { useLoaderStore } from "../store/useLoaderStore";
import { disposeObject3D } from "../viewer/objectRegistry";
import {
  convertUsdAssetToMjcfAsset,
  fetchUsdAssetIntrospectionPayload,
  fetchUsdAssetMeshScenePayload,
  uploadUsdBundleAsset,
} from "./usdConverterClient";
import {
  applyDefaultFloorAppearanceToMesh,
  createDefaultFloorMaterial,
  isDefaultFloorWorkspaceKey,
  isManagedRoughFloorWorkspaceKey,
} from "../assets/floorAppearance";

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

type NormalizedUsdConverterDiagnostics = {
  placeholderGeomBodies: number;
  bodiesWithAnyGeom: number;
  linkCount: number;
  jointCount: number;
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
};

type UsdConverterMeshSceneBody = {
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
};

type NormalizedUsdMeshScenePrimitiveKind = "sphere" | "capsule" | "cylinder" | "cone" | "cube";

type NormalizedUsdMeshScenePrimitive = {
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
};

type NormalizedUsdMeshSceneBody = {
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

type UsdImportWarning = {
  code: string;
  message: string;
  context?: Record<string, unknown>;
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
const FILE_EXT_SKIP_RE = /\.(png|jpg|jpeg|webp|tiff|bmp|hdr|exr|mtl|obj|stl|dae|fbx|gltf|glb|xml|mjcf)$/i;
const DEFAULT_VISUAL_RGBA: [number, number, number, number] = [0.72, 0.79, 0.9, 1];
const ISAAC_LAB_DEFAULT_SURFACE_FRICTION = 1.0;
const ISAAC_LAB_DEFAULT_SURFACE_RESTITUTION = 0.0;
const ABSOLUTE_URL_RE = /^(?:https?:\/\/|blob:|data:)/i;
const OPACITY_TEXTURE_HINT_RE = /(opacity|alpha|transparen|cutout|mask|coverage)/i;
const TRANSPARENT_MATERIAL_HINT_RE =
  /(glass|transparen|window|windscreen|visor|lens|screen|clear|acrylic|polycarbonate|water|liquid)/i;
const NORMAL_TEXTURE_HINT_RE = /(normal|normalmap|normal_map|normals|nrm)/i;
const EMISSIVE_TEXTURE_HINT_RE = /(emissive|emission|self[_-]?illum|glow)/i;
const OCCLUSION_TEXTURE_HINT_RE = /(occlusion|ambient[_-]?occlusion|ao|orm|rma|arm)/i;
const METALLIC_TEXTURE_HINT_RE = /(metal|metalness|metallic|orm|rma|arm|mrao)/i;
const ROUGHNESS_TEXTURE_HINT_RE = /(rough|roughness|orm|rma|arm|mrao)/i;
const METALLIC_INTENT_HINT_RE = /(metal|metallic|chrome|steel|iron|aluminum|aluminium|brass|copper|gold|silver)/i;
const usdTextureLoader = new THREE.TextureLoader();
const usdTextureCache = new Map<string, THREE.Texture>();

const resolveUsdMeshSceneProfile = (
  usdKey: string,
  importOptions?: UsdImportOptions
): "balanced" | "high_fidelity" => {
  const explicit = importOptions?.meshSceneProfile;
  if (explicit === "balanced" || explicit === "high_fidelity") return explicit;
  return "balanced";
};

const resolveUsdCollisionProfile = (
  usdKey: string,
  importOptions?: UsdImportOptions
): "authored" | "outer_hull" => {
  const explicit = importOptions?.collisionProfile;
  if (explicit === "authored" || explicit === "outer_hull") return explicit;
  const normalized = String(usdKey ?? "").trim().replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("/anymal") || normalized.endsWith("anymal.usd") || normalized.endsWith("anymal_c.usd")) {
    return "outer_hull";
  }
  return "authored";
};

const normalizeUsdConverterDiagnostics = (value: unknown): NormalizedUsdConverterDiagnostics => {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const asCount = (input: unknown) => {
    const next = Number(input);
    return Number.isFinite(next) && next > 0 ? Math.floor(next) : 0;
  };
  return {
    placeholderGeomBodies: asCount(record.placeholderGeomBodies),
    bodiesWithAnyGeom: asCount(record.bodiesWithAnyGeom),
    linkCount: asCount(record.linkCount),
    jointCount: asCount(record.jointCount),
  };
};

type UsdPrimNode = {
  path: string;
  name: string;
  parentPath: string | null;
  kind: "group" | "link" | "joint";
};

const stripFileExtension = (name: string) => name.replace(/\.[^/.]+$/, "");

const inferSceneAssetSourceRole = (workspaceKey: string): "scene_asset" | "terrain" => {
  const normalized = String(workspaceKey ?? "").trim().replace(/\\/g, "/").toLowerCase();
  if (!normalized) return "scene_asset";
  if (normalized.includes("/terrain/")) return "terrain";
  if (/(^|\/)(floor|ground|terrain)[^/]*\.(usd|usda|usdc|usdz)$/i.test(normalized)) return "terrain";
  return "scene_asset";
};

const isInsideCollisionBranch = (node: THREE.Object3D): boolean => {
  let current: THREE.Object3D | null = node;
  while (current) {
    const kind = String(current.userData?.editorKind ?? "")
      .trim()
      .toLowerCase();
    if (kind === "collision") return true;
    current = current.parent;
  }
  return false;
};

const applyManagedFloorAppearanceToSceneAsset = (
  root: THREE.Object3D,
  input: {
    materialName: string;
    materialSource: string;
    createMaterial: () => THREE.MeshPhysicalMaterial;
    applyToMesh: (mesh: THREE.Mesh, material: THREE.MeshPhysicalMaterial) => void;
  }
): number => {
  const sharedFloorMaterial = input.createMaterial();
  let styledMeshes = 0;

  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    if (isInsideCollisionBranch(node)) return;
    input.applyToMesh(node, sharedFloorMaterial);
    node.userData.usdMaterialInfo = {
      materialName: input.materialName,
      materialSource: input.materialSource,
      baseColorTexture: null,
      textureUrl: null,
      editable: false,
    };
    styledMeshes += 1;
  });

  return styledMeshes;
};

const applyDefaultFloorAppearanceToSceneAsset = (root: THREE.Object3D): number =>
  applyManagedFloorAppearanceToSceneAsset(root, {
    materialName: "Default Floor",
    materialSource: "editor.default_floor",
    createMaterial: createDefaultFloorMaterial,
    applyToMesh: applyDefaultFloorAppearanceToMesh,
  });

const applyRoughFloorAppearanceToSceneAsset = (root: THREE.Object3D): number =>
  applyManagedFloorAppearanceToSceneAsset(root, {
    materialName: "Rough Floor",
    materialSource: "editor.rough_floor",
    createMaterial: createDefaultFloorMaterial,
    applyToMesh: applyDefaultFloorAppearanceToMesh,
  });

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

const applySceneAssetPhysicsDefaults = (
  root: THREE.Object3D,
  options?: {
    forceRootCollider?: boolean;
    sourceRole?: "scene_asset" | "terrain";
    meshScene?: NormalizedUsdMeshScene | null;
  }
) => {
  const isTerrainAsset = options?.sourceRole === "terrain";
  const bodyByToken = new Map<string, NormalizedUsdMeshSceneBody>();
  for (const body of options?.meshScene?.bodies ?? []) {
    const token = normalizeBodyToken(body.name);
    if (!token || bodyByToken.has(token)) continue;
    bodyByToken.set(token, body);
  }

  const computeDynamicMassFallback = (node: THREE.Object3D) => {
    const bounds = new THREE.Box3().setFromObject(node);
    const size = new THREE.Vector3();
    bounds.getSize(size);
    const volume = Math.max(0.0005, Math.abs(size.x * size.y * size.z));
    return Math.min(20, Math.max(0.05, volume * 250));
  };

  let linkCount = 0;
  let meshUnderLinkCount = 0;
  let meshOutsideLinkCount = 0;
  const hasLinkAncestor = (node: THREE.Object3D) => {
    let current: THREE.Object3D | null = node.parent;
    while (current) {
      const isLink =
        current.userData?.editorKind === "link" ||
        Boolean((current as THREE.Object3D & { isURDFLink?: boolean }).isURDFLink);
      if (isLink) return true;
      if (current === root) break;
      current = current.parent;
    }
    return false;
  };
  root.traverse((node) => {
    const isLink = node.userData?.editorKind === "link" || Boolean((node as THREE.Object3D & { isURDFLink?: boolean }).isURDFLink);
    if (isLink) {
      linkCount += 1;
      const bodyToken = normalizeBodyToken(String(node.userData?.usdBodyToken ?? node.name));
      const bodyMeta = bodyToken ? bodyByToken.get(bodyToken) ?? null : null;
      const isDynamicBody =
        !isTerrainAsset &&
        Boolean(bodyMeta) &&
        bodyMeta?.rigidBodyEnabled !== false &&
        bodyMeta?.kinematicEnabled !== true;
      const resolvedMass = isDynamicBody
        ? (bodyMeta?.mass && bodyMeta.mass > 1e-6 ? bodyMeta.mass : computeDynamicMassFallback(node))
        : 0;
      const currentPhysics =
        node.userData?.physics && typeof node.userData.physics === "object" && !Array.isArray(node.userData.physics)
          ? (node.userData.physics as Record<string, unknown>)
          : {};
      node.userData.physics = {
        ...currentPhysics,
        mass: resolvedMass,
        fixed: !isDynamicBody,
        useDensity: false,
        collisionsEnabled: true,
        friction: ISAAC_LAB_DEFAULT_SURFACE_FRICTION,
        restitution: ISAAC_LAB_DEFAULT_SURFACE_RESTITUTION,
      };
    }

    const mesh = node as THREE.Mesh;
    if (mesh.isMesh) {
      if (hasLinkAncestor(node)) meshUnderLinkCount += 1;
      else meshOutsideLinkCount += 1;
    }
  });

  const shouldTagRoot =
    isTerrainAsset && (linkCount === 0 ||
    options?.forceRootCollider === true ||
    (meshOutsideLinkCount > 0 && meshUnderLinkCount === 0));

  // Some USD terrains attach meshes outside link wrappers (e.g. bodyCount=0 mesh payloads).
  // Tagging the root ensures MuJoCo sees the terrain mesh as a collision candidate.
  if (!shouldTagRoot) return;
  const rootPhysics =
    root.userData?.physics && typeof root.userData.physics === "object" && !Array.isArray(root.userData.physics)
      ? (root.userData.physics as Record<string, unknown>)
      : {};
  root.userData.physics = {
    ...rootPhysics,
    mass: 0,
    fixed: true,
    useDensity: false,
    collisionsEnabled: true,
    friction: ISAAC_LAB_DEFAULT_SURFACE_FRICTION,
    restitution: ISAAC_LAB_DEFAULT_SURFACE_RESTITUTION,
  };
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
      childPoseInJoint,
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
      const frameMismatchDistance = Number(introspectionJoint?.frameMismatchDistance);
      const framePairMismatchOk =
        !Number.isFinite(frameMismatchDistance) || frameMismatchDistance <= FRAME_PAIR_WORLD_MISMATCH_TOLERANCE_M;
      const useFramePair = hasFramePair && framePairMismatchOk;
      const framePairComparison =
        frame0Local && frame1Local ? compareFramePairAgainstBodyPose(frame0Local, frame1Local, body) : null;

      if (hasFramePair && !useFramePair) {
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
      } else if (useFramePair && framePairComparison && framePairComparison.positionError > 1e-4) {
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
      }
      const rawJointAxis = introspectionJoint?.axisLocal ?? introspectionJoint?.axis ?? rawJoint?.axis ?? [0, 0, 1];
      const fallbackAxis = rawJoint?.axis ?? introspectionJoint?.axisLocal ?? introspectionJoint?.axis ?? [0, 0, 1];
      const jointAxis = useFramePair && frame0Local
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
      const jointPosePosition = useFramePair && frame0Local ? frame0Local.position : body.pos;
      const jointPoseQuaternion = useFramePair && frame0Local ? frame0Local.quaternion : body.quat;
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

      if (useFramePair && framePairComparison) {
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
    geometry.setAttribute("uv2", new THREE.BufferAttribute(mesh.uvs.slice(), 2));
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

const resolveUsdMaterialTextures = (
  input: {
    baseColorTexture: string | null;
    normalTexture: string | null;
    metallicTexture: string | null;
    roughnessTexture: string | null;
    metallicRoughnessTexture: string | null;
    occlusionTexture: string | null;
    emissiveTexture: string | null;
    opacityTexture: string | null;
  },
  resolveResource?: (resourcePath: string) => string | null
): ResolvedUsdMaterialTextures => ({
  baseColorUrl: resolveUsdTextureUrl(input.baseColorTexture, resolveResource),
  normalUrl: resolveUsdTextureUrl(input.normalTexture, resolveResource),
  metallicUrl: resolveUsdTextureUrl(input.metallicTexture, resolveResource),
  roughnessUrl: resolveUsdTextureUrl(input.roughnessTexture, resolveResource),
  metallicRoughnessUrl: resolveUsdTextureUrl(input.metallicRoughnessTexture, resolveResource),
  occlusionUrl: resolveUsdTextureUrl(input.occlusionTexture, resolveResource),
  emissiveUrl: resolveUsdTextureUrl(input.emissiveTexture, resolveResource),
  opacityUrl: resolveUsdTextureUrl(input.opacityTexture, resolveResource),
});

type UsdTextureColorSpace = "srgb" | "linear";

type ResolvedUsdMaterialTextures = {
  baseColorUrl: string | null;
  normalUrl: string | null;
  metallicUrl: string | null;
  roughnessUrl: string | null;
  metallicRoughnessUrl: string | null;
  occlusionUrl: string | null;
  emissiveUrl: string | null;
  opacityUrl: string | null;
};

const maxColorComponent = (value: [number, number, number] | null | undefined) =>
  value ? Math.max(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0) : 0;

const looksLikeOpacityTexture = (url: string | null | undefined) =>
  typeof url === "string" && OPACITY_TEXTURE_HINT_RE.test(url.toLowerCase());

const looksLikeTransparentMaterialName = (name: string | null | undefined) =>
  typeof name === "string" && TRANSPARENT_MATERIAL_HINT_RE.test(name.toLowerCase());

const looksLikeNormalTexture = (url: string | null | undefined) =>
  typeof url === "string" && NORMAL_TEXTURE_HINT_RE.test(url.toLowerCase());

const looksLikeEmissiveTexture = (url: string | null | undefined) =>
  typeof url === "string" && EMISSIVE_TEXTURE_HINT_RE.test(url.toLowerCase());

const looksLikeOcclusionTexture = (url: string | null | undefined) =>
  typeof url === "string" && OCCLUSION_TEXTURE_HINT_RE.test(url.toLowerCase());

const looksLikeMetallicTexture = (url: string | null | undefined) =>
  typeof url === "string" && METALLIC_TEXTURE_HINT_RE.test(url.toLowerCase());

const looksLikeRoughnessTexture = (url: string | null | undefined) =>
  typeof url === "string" && ROUGHNESS_TEXTURE_HINT_RE.test(url.toLowerCase());

const looksLikeMetallicIntent = (value: string | null | undefined) =>
  typeof value === "string" && METALLIC_INTENT_HINT_RE.test(value.toLowerCase());

const sameTextureReference = (left: string | null | undefined, right: string | null | undefined) =>
  typeof left === "string" &&
  typeof right === "string" &&
  left.trim().toLowerCase() === right.trim().toLowerCase();

const getOrLoadUsdTexture = (url: string, colorSpace: UsdTextureColorSpace) => {
  const cacheKey = `${colorSpace}:${url}`;
  const cached = usdTextureCache.get(cacheKey);
  if (cached) return cached;
  const texture = usdTextureLoader.load(url);
  texture.colorSpace = colorSpace === "srgb" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  usdTextureCache.set(cacheKey, texture);
  return texture;
};

const createUsdVisualMaterial = (
  rgba: [number, number, number, number] | null,
  options?: {
    textures?: ResolvedUsdMaterialTextures;
    materialName?: string | null;
    metallicFactor?: number | null;
    roughnessFactor?: number | null;
    emissiveFactor?: [number, number, number] | null;
    opacityFactor?: number | null;
  }
) => {
  const colorRgba = rgba ?? DEFAULT_VISUAL_RGBA;
  const hasResolvedOpacityTexture = Boolean(options?.textures?.opacityUrl);
  const hasOpacityTextureIntent = looksLikeOpacityTexture(options?.textures?.opacityUrl ?? null);
  const hasTransparentMaterialName = looksLikeTransparentMaterialName(options?.materialName ?? null);
  const rawOpacityFactor = options?.opacityFactor;
  const normalizedOpacityFactor =
    typeof rawOpacityFactor === "number" && Number.isFinite(rawOpacityFactor)
      ? Math.max(0, Math.min(1, rawOpacityFactor))
      : null;
  const baseAlpha = Math.max(0, Math.min(1, colorRgba[3]));
  const opacityChannelEnabled =
    (hasResolvedOpacityTexture && hasOpacityTextureIntent) || hasTransparentMaterialName;
  let opacity = Math.max(0.02, Math.min(1, opacityChannelEnabled ? normalizedOpacityFactor ?? baseAlpha : 1));
  if (!opacityChannelEnabled) {
    opacity = 1;
  }
  if (opacity < 0.15 && !hasOpacityTextureIntent && !hasTransparentMaterialName) {
    opacity = 1;
  }
  const textures = options?.textures;
  const baseColorUrl = textures?.baseColorUrl ?? null;
  const hasNormalTextureIntent = looksLikeNormalTexture(textures?.normalUrl ?? null);
  const hasMetallicTextureIntent =
    looksLikeMetallicTexture(textures?.metallicUrl ?? null) ||
    looksLikeMetallicTexture(textures?.metallicRoughnessUrl ?? null);
  const hasRoughnessTextureIntent =
    looksLikeRoughnessTexture(textures?.roughnessUrl ?? null) ||
    looksLikeRoughnessTexture(textures?.metallicRoughnessUrl ?? null);
  const hasUsableNormalTexture =
    Boolean(textures?.normalUrl) &&
    hasNormalTextureIntent &&
    !sameTextureReference(textures?.normalUrl, baseColorUrl);
  const hasUsableMetallicTexture =
    Boolean(textures?.metallicUrl) &&
    hasMetallicTextureIntent &&
    !sameTextureReference(textures?.metallicUrl, baseColorUrl);
  const hasUsableRoughnessTexture =
    Boolean(textures?.roughnessUrl) &&
    hasRoughnessTextureIntent &&
    !sameTextureReference(textures?.roughnessUrl, baseColorUrl);
  const hasUsablePackedMetallicRoughnessTexture =
    Boolean(textures?.metallicRoughnessUrl) &&
    (hasMetallicTextureIntent || hasRoughnessTextureIntent) &&
    !sameTextureReference(textures?.metallicRoughnessUrl, baseColorUrl);
  const hasMetallicTexture =
    hasUsableMetallicTexture || (hasUsablePackedMetallicRoughnessTexture && hasMetallicTextureIntent);
  const hasMetallicIntent =
    hasMetallicTexture ||
    looksLikeMetallicIntent(options?.materialName ?? null) ||
    (typeof options?.metallicFactor === "number" && options.metallicFactor >= 0.4);
  const metallic = hasMetallicIntent ? Math.max(0, Math.min(0.08, options?.metallicFactor ?? 0.02)) : 0;
  const roughness = Math.max(0.72, Math.min(1, options?.roughnessFactor ?? 0.94));
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(colorRgba[0], colorRgba[1], colorRgba[2]),
    transparent: opacityChannelEnabled && opacity < 0.999,
    opacity,
    metalness: metallic,
    roughness,
    envMapIntensity: 0.08,
    side: THREE.DoubleSide,
  });

  if (textures?.baseColorUrl) {
    material.map = getOrLoadUsdTexture(textures.baseColorUrl, "srgb");
  }
  if (hasUsableNormalTexture && textures?.normalUrl) {
    material.normalMap = getOrLoadUsdTexture(textures.normalUrl, "linear");
  }
  if (hasUsablePackedMetallicRoughnessTexture && textures?.metallicRoughnessUrl) {
    const orm = getOrLoadUsdTexture(textures.metallicRoughnessUrl, "linear");
    if (hasRoughnessTextureIntent) {
      material.roughnessMap = orm;
    }
    if (hasMetallicIntent && hasMetallicTextureIntent) {
      material.metalnessMap = orm;
    }
  } else {
    if (hasMetallicIntent && hasUsableMetallicTexture && textures?.metallicUrl) {
      material.metalnessMap = getOrLoadUsdTexture(textures.metallicUrl, "linear");
    }
    if (hasUsableRoughnessTexture && textures?.roughnessUrl) {
      material.roughnessMap = getOrLoadUsdTexture(textures.roughnessUrl, "linear");
    }
  }
  if (textures?.occlusionUrl) {
    if (looksLikeOcclusionTexture(textures.occlusionUrl)) {
      material.aoMap = getOrLoadUsdTexture(textures.occlusionUrl, "linear");
      material.aoMapIntensity = 0.42;
    }
  }
  const hasEmissiveFactor = maxColorComponent(options?.emissiveFactor) > 0.01;
  const hasEmissiveMapIntent = looksLikeEmissiveTexture(textures?.emissiveUrl ?? null);
  if (textures?.emissiveUrl && hasEmissiveMapIntent) {
    material.emissiveMap = getOrLoadUsdTexture(textures.emissiveUrl, "srgb");
  }
  if (hasEmissiveFactor || hasEmissiveMapIntent) {
    if (options?.emissiveFactor) {
      material.emissive = new THREE.Color(
        options.emissiveFactor[0],
        options.emissiveFactor[1],
        options.emissiveFactor[2]
      );
      material.emissiveIntensity = 1.0;
    } else {
      material.emissive = new THREE.Color(1, 1, 1);
      material.emissiveIntensity = 0.28;
    }
  }
  if (textures?.opacityUrl && opacityChannelEnabled && hasOpacityTextureIntent) {
    material.alphaMap = getOrLoadUsdTexture(textures.opacityUrl, "linear");
    material.transparent = true;
    material.alphaTest = 0.08;
    material.depthWrite = false;
  }
  (material.userData ??= {}).viewportSurfaceProfile = "usd_pbr";
  if (options?.materialName) {
    material.name = options.materialName;
  }
  material.needsUpdate = true;
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
  options?: { materialTextures?: ResolvedUsdMaterialTextures }
) => {
  const geometry = buildUsdMeshGeometry(mesh);
  const material = createUsdVisualMaterial(mesh.rgba, {
    textures: options?.materialTextures,
    materialName: mesh.materialName,
    metallicFactor: mesh.metallicFactor,
    roughnessFactor: mesh.roughnessFactor,
    emissiveFactor: mesh.emissiveFactor,
    opacityFactor: mesh.opacityFactor,
  });
  const visualMesh = new THREE.Mesh(geometry, material);
  visualMesh.name = mesh.name;
  visualMesh.userData.editorKind = "mesh";
  visualMesh.userData.usdPrimPath = mesh.primPath;
  visualMesh.userData.disableViewportEdgeOverlay = true;
  visualMesh.userData.usdMaterialInfo = {
    materialName: mesh.materialName,
    materialSource: mesh.materialSource,
    baseColorTexture: mesh.baseColorTexture,
    normalTexture: mesh.normalTexture,
    metallicTexture: mesh.metallicTexture,
    roughnessTexture: mesh.roughnessTexture,
    metallicRoughnessTexture: mesh.metallicRoughnessTexture,
    occlusionTexture: mesh.occlusionTexture,
    emissiveTexture: mesh.emissiveTexture,
    opacityTexture: mesh.opacityTexture,
    textureUrls: options?.materialTextures ?? null,
    editable: !Object.values(options?.materialTextures ?? {}).some((value) => Boolean(value)),
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
  options?: { materialTextures?: ResolvedUsdMaterialTextures }
) => {
  const geometry = buildUsdPrimitiveGeometry(primitive);
  if (!geometry) return null;
  const uvAttr = geometry.getAttribute("uv");
  if (uvAttr && !geometry.getAttribute("uv2")) {
    geometry.setAttribute("uv2", uvAttr.clone());
  }

  const visualMesh = new THREE.Mesh(
    geometry,
    createUsdVisualMaterial(primitive.rgba, {
      textures: options?.materialTextures,
      materialName: primitive.materialName,
      metallicFactor: primitive.metallicFactor,
      roughnessFactor: primitive.roughnessFactor,
      emissiveFactor: primitive.emissiveFactor,
      opacityFactor: primitive.opacityFactor,
    })
  );
  visualMesh.name = primitive.name;
  visualMesh.userData.editorKind = "mesh";
  visualMesh.userData.usdPrimPath = primitive.primPath;
  visualMesh.userData.disableViewportEdgeOverlay = true;
  visualMesh.userData.usdMaterialInfo = {
    materialName: primitive.materialName,
    materialSource: primitive.materialSource,
    baseColorTexture: primitive.baseColorTexture,
    normalTexture: primitive.normalTexture,
    metallicTexture: primitive.metallicTexture,
    roughnessTexture: primitive.roughnessTexture,
    metallicRoughnessTexture: primitive.metallicRoughnessTexture,
    occlusionTexture: primitive.occlusionTexture,
    emissiveTexture: primitive.emissiveTexture,
    opacityTexture: primitive.opacityTexture,
    textureUrls: options?.materialTextures ?? null,
    editable: !Object.values(options?.materialTextures ?? {}).some((value) => Boolean(value)),
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
  aliases: string[];
  bodyToken: string | null;
  bodyPath: string | null;
  sourcePrimPaths: Set<string>;
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

const isLinkLikeNode = (node: THREE.Object3D) =>
  node.userData?.editorKind === "link" || Boolean((node as THREE.Object3D & { isURDFLink?: boolean }).isURDFLink);

const isVisualLikeNode = (node: THREE.Object3D) =>
  node.userData?.editorKind === "visual" || Boolean((node as THREE.Object3D & { isURDFVisual?: boolean }).isURDFVisual);

const isCollisionLikeNode = (node: THREE.Object3D) =>
  node.userData?.editorKind === "collision" || Boolean((node as THREE.Object3D & { isURDFCollider?: boolean }).isURDFCollider);

const ensureSceneAssetRootHierarchy = (
  inputRoot: THREE.Object3D,
  options?: {
    sceneAssetName?: string;
    selfCollisionEnabled?: boolean;
    sourceRole?: "scene_asset" | "terrain";
  }
) => {
  const selfCollisionEnabled = options?.selfCollisionEnabled === true;
  const sceneAssetName = String(options?.sceneAssetName ?? "").trim() || inputRoot.name || "Scene Asset";
  const sourceRole = options?.sourceRole === "terrain" ? "terrain" : "scene_asset";
  let root = inputRoot;

  // Canonical asset structure in the editor should always start with a group root.
  if (isLinkLikeNode(root) || isVisualLikeNode(root) || isCollisionLikeNode(root) || root instanceof THREE.Mesh) {
    const wrapper = new THREE.Group();
    wrapper.name = sceneAssetName;
    wrapper.userData.editorKind = "group";
    wrapper.add(root);
    root = wrapper;
  }

  const directChildren = [...root.children];
  const strayDirectChildren = directChildren.filter((child) => {
    if (isLinkLikeNode(child)) return false;
    if (child.userData?.sceneAssetContainer === true) return false;
    if (child.userData?.usdOrphans === true) return false;
    if (child instanceof THREE.Mesh) return true;
    if (isVisualLikeNode(child) || isCollisionLikeNode(child)) return true;
    return false;
  });

  if (strayDirectChildren.length > 0) {
    const fallbackLink = new THREE.Group();
    fallbackLink.name = "Link";
    fallbackLink.userData.editorKind = "link";
    fallbackLink.userData.physics = {
      mass: 0,
      fixed: true,
      useDensity: false,
      collisionsEnabled: true,
      friction: ISAAC_LAB_DEFAULT_SURFACE_FRICTION,
      restitution: ISAAC_LAB_DEFAULT_SURFACE_RESTITUTION,
    };
    if (sourceRole === "terrain") {
      fallbackLink.userData.sceneAssetTerrainLink = true;
    }
    const fallbackVisual = new THREE.Group();
    configureVisualGroup(fallbackVisual, fallbackLink.name);
    const fallbackCollision = new THREE.Group();
    configureCollisionGroup(fallbackCollision, fallbackLink.name, selfCollisionEnabled);
    fallbackLink.add(fallbackVisual);
    fallbackLink.add(fallbackCollision);
    root.add(fallbackLink);

    for (const child of strayDirectChildren) {
      if (isCollisionLikeNode(child)) {
        fallbackCollision.add(child);
      } else {
        fallbackVisual.add(child);
      }
    }
  }

  return root;
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

type UsdLinkLookup = {
  byAlias: Map<string, UsdLinkRenderGroupEntry[]>;
  entries: UsdLinkRenderGroupEntry[];
  aliasCollisionCount: number;
};

const normalizeAliasToken = (value: string | null | undefined): string | null => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  return raw.toLowerCase();
};

const normalizePathAliasToken = (value: string | null | undefined): string | null => {
  const raw = String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (!raw) return null;
  return raw.toLowerCase();
};

const collectUsdLinkGroups = (root: THREE.Object3D, selfCollisionEnabled: boolean): UsdLinkLookup => {
  const byAlias = new Map<string, UsdLinkRenderGroupEntry[]>();
  const entries: UsdLinkRenderGroupEntry[] = [];
  let aliasCollisionCount = 0;

  const bindAlias = (alias: string | null, entry: UsdLinkRenderGroupEntry) => {
    const normalized = normalizeAliasToken(alias);
    if (!normalized) return;
    const existing = byAlias.get(normalized);
    if (!existing) {
      byAlias.set(normalized, [entry]);
      return;
    }
    if (!existing.includes(entry)) {
      existing.push(entry);
      aliasCollisionCount += 1;
    }
  };

  root.traverse((node) => {
    if (!(node instanceof THREE.Group)) return;
    if (node.userData.editorKind !== "link") return;

    const ensured = ensureStandardLinkRenderGroups(node, selfCollisionEnabled);
    const bodyToken = normalizeBodyToken(String(node.userData?.usdBodyToken ?? node.name));
    const bodyPath = normalizePathAliasToken(String(node.userData?.usdBodyPath ?? node.userData?.usdPrimPath ?? ""));
    const sourcePrimPaths = Array.isArray(node.userData?.usdSourcePrimPaths)
      ? (node.userData.usdSourcePrimPaths as unknown[])
          .map((path) => normalizePathAliasToken(String(path ?? "")))
          .filter((path): path is string => Boolean(path))
      : [];
    const entry: UsdLinkRenderGroupEntry = {
      link: node,
      visual: ensured.visual,
      collision: ensured.collision,
      preparedForUsd: false,
      aliases: [],
      bodyToken,
      bodyPath,
      sourcePrimPaths: new Set<string>(sourcePrimPaths),
    };

    const register = (alias: string | null) => {
      const normalized = normalizeAliasToken(alias);
      if (!normalized) return;
      if (!entry.aliases.includes(normalized)) entry.aliases.push(normalized);
      bindAlias(normalized, entry);
    };

    register(node.name);
    register(normalizeBodyToken(node.name));
    register(bodyToken);
    register(bodyPath);
    register(`__link__${node.uuid}`);

    const urdfName = String((node as THREE.Group & { urdfName?: string }).urdfName ?? "").trim();
    if (urdfName) {
      register(urdfName);
      register(normalizeBodyToken(urdfName));
    }
    if (bodyPath) {
      const tail = bodyPath.split("/").pop() ?? "";
      register(tail);
      register(normalizeBodyToken(tail));
    }
    entries.push(entry);
  });

  return {
    byAlias,
    entries,
    aliasCollisionCount,
  };
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
  const collected = collectUsdLinkGroups(root, false);
  const links = new Map<string, UsdLinkRenderGroupEntry>();
  const bindLink = (tokenValue: string | null | undefined, entry: UsdLinkRenderGroupEntry) => {
    const token = normalizeBodyToken(tokenValue);
    if (!token || links.has(token)) return;
    links.set(token, entry);
  };
  for (const entry of collected.entries) {
    bindLink(entry.link.name, entry);
    const urdfName = String((entry.link as THREE.Group & { urdfName?: string }).urdfName ?? "").trim();
    if (urdfName) bindLink(urdfName, entry);
    if (entry.bodyToken) bindLink(entry.bodyToken, entry);
  }
  const resolveLinkEntry = (bodyToken: string | null): UsdLinkRenderGroupEntry | null => {
    const normalized = normalizeBodyToken(bodyToken);
    if (!normalized) return null;
    return links.get(normalized) ?? null;
  };
  const bodyByName = new Map(meshScene.bodies.map((body) => [normalizeBodyToken(body.name) ?? body.name, body]));
  const introspectionJoints = Array.isArray(root.userData?.usdIntrospection?.joints)
    ? (root.userData.usdIntrospection.joints as Array<{ frame0Local?: unknown; frame1Local?: unknown }>)
    : [];
  const jointsWithExplicitFramePair = introspectionJoints.filter(
    (joint) => Boolean(joint?.frame0Local) && Boolean(joint?.frame1Local)
  ).length;
  const hasRichJointFrames =
    introspectionJoints.length > 0 &&
    jointsWithExplicitFramePair >= Math.max(2, Math.ceil(introspectionJoints.length * 0.4));

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
    const linkEntry = resolveLinkEntry(bodyToken);
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
  // When explicit joint frame pairs exist on an already posed chain, re-applying
  // mesh body poses can double-transform downstream links.
  // Keep pose recovery enabled for genuinely collapsed skeletons.
  if (hasRichJointFrames && !hasCollapsedLayout) return 0;
  if (!hasCollapsedLayout && !looksGlobalInLocalSlots) return 0;

  let applied = 0;

  for (const body of meshScene.bodies) {
    const bodyToken = normalizeBodyToken(body.name);
    if (!bodyToken) continue;
    const linkEntry = resolveLinkEntry(bodyToken);
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
    return {
      attachedMeshes: 0,
      attachedPrimitives: 0,
      attachedToLinks: 0,
      attachedToRoot: 0,
      materialsBound: 0,
      texturedMaterials: 0,
      referencedTextures: 0,
      unresolvedTextureBindings: 0,
      aliasCollisionCount: 0,
      parentPoseWorldFallbacks: 0,
    };
  }

  const selfCollisionEnabled = options?.selfCollisionEnabled === true;
  const attachCollisionProxies = options?.attachCollisionProxies !== false;
  const replaceExisting = options?.replaceExisting === true;
  const links = collectUsdLinkGroups(root, selfCollisionEnabled);
  const uniqueEntries = Array.from(new Set(links.entries));
  const singleLinkEntry = uniqueEntries.length === 1 ? uniqueEntries[0] : null;
  const prefersRobotTokenMatching = Boolean(
    (root as THREE.Object3D & { isRobot?: boolean }).isRobot || root.userData?.editorRobotRoot === true
  );
  const robotTokenLookup = new Map<string, UsdLinkRenderGroupEntry>();
  const bindRobotToken = (tokenValue: string | null | undefined, entry: UsdLinkRenderGroupEntry) => {
    const token = normalizeBodyToken(tokenValue);
    if (!token || robotTokenLookup.has(token)) return;
    robotTokenLookup.set(token, entry);
  };
  if (prefersRobotTokenMatching) {
    for (const entry of uniqueEntries) {
      bindRobotToken(entry.link.name, entry);
      const urdfName = String((entry.link as THREE.Group & { urdfName?: string }).urdfName ?? "").trim();
      if (urdfName) bindRobotToken(urdfName, entry);
      if (entry.bodyToken) bindRobotToken(entry.bodyToken, entry);
    }
  }
  const bodyPoseByToken = new Map(
    meshScene.bodies
      .map((body) => {
        const token = normalizeBodyToken(body.name);
        return token ? ([token, body] as const) : null;
      })
      .filter((entry): entry is readonly [string, NormalizedUsdMeshSceneBody] => Boolean(entry))
  );
  const usedNodeNames = new Set<string>();
  root.traverse((node) => {
    const name = String(node.name ?? "").trim();
    if (name) usedNodeNames.add(name);
  });

  const rootOrphansByKey = new Map<string, { container: THREE.Group; visual: THREE.Group; collision: THREE.Group }>();
  let attachedMeshes = 0;
  let attachedPrimitives = 0;
  let attachedToLinks = 0;
  let attachedToRoot = 0;
  let materialsBound = 0;
  let texturedMaterials = 0;
  let referencedTextures = 0;
  let unresolvedTextureBindings = 0;
  let parentPoseWorldFallbacks = 0;
  const targetsWithMeshVisual = new Set<string>();
  const seenUsdItems = new Set<string>();
  const targetPrimaryMeshCount = new Map<string, number>();

  if (replaceExisting) {
    for (const entry of uniqueEntries) {
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
    const hasCollisionToken =
      /(^|[\/_.:-])(collision|collider|proxy|physics|physx|contact|approx)($|[\/_.:-])/.test(token);
    return hasCollisionToken;
  };

  const toOrphanContainerName = (key: string) =>
    key
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\w/g, (char) => char.toUpperCase()) || "Scene Asset";

  const deriveOrphanContainerKey = (sourcePrimPath: string): string => {
    if (prefersRobotTokenMatching) return "__USDOrphans__";
    const normalized = normalizePathAliasToken(sourcePrimPath);
    if (!normalized) return "scene_asset_orphans";
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length >= 2) {
      return normalizeAliasToken(parts[1]) ?? parts[1].toLowerCase();
    }
    if (parts.length === 1) {
      return normalizeAliasToken(parts[0]) ?? parts[0].toLowerCase();
    }
    return "scene_asset_orphans";
  };

  const ensureRootOrphans = (sourcePrimPath: string) => {
    const orphanKey = deriveOrphanContainerKey(sourcePrimPath);
    const existing = rootOrphansByKey.get(orphanKey);
    if (existing) return existing;
    const container = new THREE.Group();
    container.name = orphanKey === "__USDOrphans__" ? "__USDOrphans__" : toOrphanContainerName(orphanKey);
    container.userData.usdOrphans = true;
    container.userData.usdOrphanGroupKey = orphanKey;
    if (!prefersRobotTokenMatching) {
      container.userData.sceneAssetContainer = true;
      container.userData.sceneAssetContainerKey = orphanKey;
      container.userData.sceneAssetContainerSource = "usd_orphan_lineage";
    }

    const visual = new THREE.Group();
    configureVisualGroup(visual, "__usd_orphans__");
    clearGroupChildren(visual);
    container.add(visual);

    const collision = new THREE.Group();
    configureCollisionGroup(collision, "__usd_orphans__", selfCollisionEnabled);
    clearGroupChildren(collision);
    container.add(collision);

    root.add(container);
    const next = { container, visual, collision };
    rootOrphansByKey.set(orphanKey, next);
    return next;
  };

  const pickEntryFromCandidates = (
    candidates: UsdLinkRenderGroupEntry[],
    pathHints: Array<string | null | undefined>
  ): UsdLinkRenderGroupEntry | null => {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    const normalizedHints = pathHints
      .map((hint) => normalizePathAliasToken(hint))
      .filter((hint): hint is string => Boolean(hint));
    for (const hint of normalizedHints) {
      const byBodyPath = candidates.find((candidate) =>
        Boolean(candidate.bodyPath && (hint.endsWith(candidate.bodyPath) || candidate.bodyPath.endsWith(hint)))
      );
      if (byBodyPath) return byBodyPath;
    }
    for (const hint of normalizedHints) {
      const segments = hint.split("/").filter(Boolean);
      for (let i = segments.length - 1; i >= 0; i -= 1) {
        const alias = normalizeAliasToken(segments[i]);
        if (!alias) continue;
        const byAlias = candidates.find((candidate) => candidate.aliases.includes(alias));
        if (byAlias) return byAlias;
      }
    }
    return candidates[0];
  };

  const inferEntryFromPrimPath = (primPath: string): UsdLinkRenderGroupEntry | null => {
    const tokenized = String(primPath ?? "")
      .split("/")
      .map((item) => normalizeBodyToken(item))
      .filter((item): item is string => Boolean(item));
    for (let i = tokenized.length - 1; i >= 0; i -= 1) {
      const token = tokenized[i];
      const candidates = links.byAlias.get(token) ?? [];
      const picked = pickEntryFromCandidates(candidates, [primPath]);
      if (picked) return picked;
    }
    return singleLinkEntry;
  };

  const findEntryByBodyPathPrefix = (
    candidatePath: string | null | undefined
  ): UsdLinkRenderGroupEntry | null => {
    const normalizedPath = normalizePathAliasToken(candidatePath);
    if (!normalizedPath) return null;
    let best: UsdLinkRenderGroupEntry | null = null;
    let bestLength = -1;
    for (const entry of uniqueEntries) {
      const bodyPath = normalizePathAliasToken(entry.bodyPath);
      if (!bodyPath) continue;
      if (!normalizedPath.startsWith(bodyPath)) continue;
      if (bodyPath.length <= bestLength) continue;
      best = entry;
      bestLength = bodyPath.length;
    }
    return best;
  };

  const resolveTargetEntry = (input: {
    parentBody: string | null;
    parentBodyPath: string | null;
    primPath: string;
  }): UsdLinkRenderGroupEntry | null => {
    if (prefersRobotTokenMatching) {
      const parentToken = normalizeBodyToken(input.parentBody);
      if (parentToken) {
        const byParentToken = robotTokenLookup.get(parentToken);
        if (byParentToken) return byParentToken;
      }
      const tokenized = String(input.primPath ?? "")
        .split("/")
        .map((item) => normalizeBodyToken(item))
        .filter((item): item is string => Boolean(item));
      for (let i = tokenized.length - 1; i >= 0; i -= 1) {
        const token = tokenized[i];
        const byPrimToken = robotTokenLookup.get(token);
        if (byPrimToken) return byPrimToken;
      }
      return singleLinkEntry;
    }

    const parentToken = normalizeBodyToken(input.parentBody);
    if (parentToken) {
      const candidates = links.byAlias.get(parentToken) ?? [];
      const picked = pickEntryFromCandidates(candidates, [input.parentBodyPath, input.primPath]);
      if (picked) return picked;
    }
    const byParentBodyPath = findEntryByBodyPathPrefix(input.parentBodyPath);
    if (byParentBodyPath) return byParentBodyPath;
    const byPrimPath = findEntryByBodyPathPrefix(input.primPath);
    if (byPrimPath) return byPrimPath;
    return inferEntryFromPrimPath(input.primPath);
  };

  const rebaseWorldPoseToTargetLocal = (
    pose: {
      position: [number, number, number];
      quaternion: THREE.Quaternion;
      scale: [number, number, number];
      parentBody: string | null;
      parentBodyPath?: string | null;
    },
    targetEntry: UsdLinkRenderGroupEntry | null
  ): {
    position: [number, number, number];
    quaternion: THREE.Quaternion;
    scale: [number, number, number];
  } => {
    const payloadParentToken = normalizeBodyToken(pose.parentBody);
    if (!targetEntry || (prefersRobotTokenMatching && payloadParentToken)) {
      return {
        position: [pose.position[0], pose.position[1], pose.position[2]],
        quaternion: pose.quaternion.clone(),
        scale: [pose.scale[0], pose.scale[1], pose.scale[2]],
      };
    }

    const shouldTreatAsWorldPose = (() => {
      if (!payloadParentToken) return true;
      const parentBodyPose = bodyPoseByToken.get(payloadParentToken);
      if (!parentBodyPose) return false;
      const localMagnitude = Math.hypot(pose.position[0], pose.position[1], pose.position[2]);
      if (localMagnitude < 0.2) return false;
      const payloadPosition = new THREE.Vector3(pose.position[0], pose.position[1], pose.position[2]);
      const parentPosition = new THREE.Vector3(
        parentBodyPose.position[0],
        parentBodyPose.position[1],
        parentBodyPose.position[2]
      );
      const distanceToBodyWorld = payloadPosition.distanceTo(parentPosition);
      const angleToBodyWorld = pose.quaternion.angleTo(parentBodyPose.quaternion);
      return distanceToBodyWorld < 0.18 && angleToBodyWorld < 0.5;
    })();

    if (!shouldTreatAsWorldPose) {
      return {
        position: [pose.position[0], pose.position[1], pose.position[2]],
        quaternion: pose.quaternion.clone(),
        scale: [pose.scale[0], pose.scale[1], pose.scale[2]],
      };
    }
    if (payloadParentToken) parentPoseWorldFallbacks += 1;

    const parentObject = targetEntry.visual;
    parentObject.updateWorldMatrix(true, false);
    const parentInv = new THREE.Matrix4().copy(parentObject.matrixWorld).invert();
    const worldMatrix = new THREE.Matrix4().compose(
      new THREE.Vector3(pose.position[0], pose.position[1], pose.position[2]),
      pose.quaternion.clone(),
      new THREE.Vector3(pose.scale[0], pose.scale[1], pose.scale[2])
    );
    const localMatrix = new THREE.Matrix4().multiplyMatrices(parentInv, worldMatrix);
    const localPos = new THREE.Vector3();
    const localQuat = new THREE.Quaternion();
    const localScale = new THREE.Vector3();
    localMatrix.decompose(localPos, localQuat, localScale);
    if (localQuat.lengthSq() <= 1e-10) {
      localQuat.identity();
    } else {
      localQuat.normalize();
    }
    return {
      position: [localPos.x, localPos.y, localPos.z],
      quaternion: localQuat,
      scale: [localScale.x, localScale.y, localScale.z],
    };
  };

  for (const mesh of meshScene.meshes) {
    const targetEntry = resolveTargetEntry({
      parentBody: mesh.parentBody,
      parentBodyPath: mesh.parentBodyPath,
      primPath: mesh.primPath,
    });
    const targetKey = targetEntry ? `link:${targetEntry.link.uuid}` : "__root__";
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

  const attachPair = (
    visual: THREE.Mesh,
    collision: THREE.Mesh | null,
    targetEntry: UsdLinkRenderGroupEntry | null,
    sourcePrimPath: string
  ) => {
    const visualName = claimName(visual.name || "usd_mesh", usedNodeNames, "usd_mesh");
    visual.name = visualName;
    if (collision) {
      collision.name = claimName(`${visualName}_collision`, usedNodeNames, "usd_collision");
      collision.userData.selfCollisionEnabled = selfCollisionEnabled;
    }

    if (targetEntry) {
      ensurePreparedEntry(targetEntry);
      targetEntry.visual.add(visual);
      if (collision && attachCollisionProxies) targetEntry.collision.add(collision);
      const normalizedPrimPath = normalizePathAliasToken(sourcePrimPath);
      if (normalizedPrimPath) {
        targetEntry.sourcePrimPaths.add(normalizedPrimPath);
        targetEntry.link.userData.usdSourcePrimPaths = Array.from(targetEntry.sourcePrimPaths);
      }
      attachedToLinks += 1;
      return;
    }

    const orphans = ensureRootOrphans(sourcePrimPath);
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
    const targetEntry = resolveTargetEntry({
      parentBody: mesh.parentBody,
      parentBodyPath: mesh.parentBodyPath,
      primPath: mesh.primPath,
    });
    const targetKey = targetEntry ? `link:${targetEntry.link.uuid}` : "__root__";
    const auxiliary = isAuxiliaryVisualCandidate({ name: mesh.name, primPath: mesh.primPath });
    if (auxiliary && (targetPrimaryMeshCount.get(targetKey) ?? 0) > 0) continue;

    const meshNameKey = String(mesh.name || mesh.primPath || "").trim().toLowerCase();
    const dedupeKey = `mesh|${targetKey}|${meshNameKey}|${meshTransformKey(mesh)}|${mesh.points.length}|${mesh.triangles.length}`;
    if (seenUsdItems.has(dedupeKey)) continue;
    seenUsdItems.add(dedupeKey);

    const materialTextures = resolveUsdMaterialTextures(
      {
        baseColorTexture: mesh.baseColorTexture,
        normalTexture: mesh.normalTexture,
        metallicTexture: mesh.metallicTexture,
        roughnessTexture: mesh.roughnessTexture,
        metallicRoughnessTexture: mesh.metallicRoughnessTexture,
        occlusionTexture: mesh.occlusionTexture,
        emissiveTexture: mesh.emissiveTexture,
        opacityTexture: mesh.opacityTexture,
      },
      options?.resolveResource
    );
    const textureReferences = [
      mesh.baseColorTexture,
      mesh.normalTexture,
      mesh.metallicTexture,
      mesh.roughnessTexture,
      mesh.metallicRoughnessTexture,
      mesh.occlusionTexture,
      mesh.emissiveTexture,
      mesh.opacityTexture,
    ].filter((value): value is string => Boolean(value));
    const resolvedTextureCount = Object.values(materialTextures).filter((value) => Boolean(value)).length;
    const hasMaterialBinding = Boolean(
      mesh.materialName ||
        mesh.materialSource ||
        textureReferences.length > 0 ||
        resolvedTextureCount > 0 ||
        mesh.metallicFactor !== null ||
        mesh.roughnessFactor !== null ||
        mesh.emissiveFactor !== null ||
        mesh.opacityFactor !== null
    );
    if (hasMaterialBinding) materialsBound += 1;
    referencedTextures += textureReferences.length;
    if (resolvedTextureCount > 0) texturedMaterials += 1;
    unresolvedTextureBindings += Math.max(0, textureReferences.length - resolvedTextureCount);
    const localPose = rebaseWorldPoseToTargetLocal(
      {
        position: mesh.position,
        quaternion: mesh.quaternion,
        scale: mesh.scale,
        parentBody: mesh.parentBody,
        parentBodyPath: mesh.parentBodyPath,
      },
      targetEntry
    );
    const visual = createUsdVisualMesh(
      {
        ...mesh,
        position: localPose.position,
        quaternion: localPose.quaternion,
        scale: localPose.scale,
      },
      { materialTextures }
    );
    const collision = attachCollisionProxies ? createUsdCollisionMeshFromVisual(visual) : null;
    attachPair(visual, collision, targetEntry, mesh.primPath);
    targetsWithMeshVisual.add(targetKey);
    attachedMeshes += 1;
  }
  for (const primitive of meshScene.primitives) {
    const targetEntry = resolveTargetEntry({
      parentBody: primitive.parentBody,
      parentBodyPath: primitive.parentBodyPath,
      primPath: primitive.primPath,
    });
    const targetKey = targetEntry ? `link:${targetEntry.link.uuid}` : "__root__";
    if ((targetPrimaryMeshCount.get(targetKey) ?? 0) > 0 && targetsWithMeshVisual.has(targetKey)) continue;
    if (isAuxiliaryVisualCandidate({ name: primitive.name, primPath: primitive.primPath })) continue;

    const primitiveDims = primitive.size
      ? primitive.size.map((value) => value.toFixed(6)).join(",")
      : `${primitive.radius?.toFixed(6) ?? "na"}:${primitive.height?.toFixed(6) ?? "na"}`;
    const primitiveNameKey = String(primitive.name || primitive.primPath || "").trim().toLowerCase();
    const dedupeKey = `primitive|${targetKey}|${primitiveNameKey}|${primitive.kind}|${meshTransformKey(primitive)}|${primitiveDims}`;
    if (seenUsdItems.has(dedupeKey)) continue;
    seenUsdItems.add(dedupeKey);

    const materialTextures = resolveUsdMaterialTextures(
      {
        baseColorTexture: primitive.baseColorTexture,
        normalTexture: primitive.normalTexture,
        metallicTexture: primitive.metallicTexture,
        roughnessTexture: primitive.roughnessTexture,
        metallicRoughnessTexture: primitive.metallicRoughnessTexture,
        occlusionTexture: primitive.occlusionTexture,
        emissiveTexture: primitive.emissiveTexture,
        opacityTexture: primitive.opacityTexture,
      },
      options?.resolveResource
    );
    const textureReferences = [
      primitive.baseColorTexture,
      primitive.normalTexture,
      primitive.metallicTexture,
      primitive.roughnessTexture,
      primitive.metallicRoughnessTexture,
      primitive.occlusionTexture,
      primitive.emissiveTexture,
      primitive.opacityTexture,
    ].filter((value): value is string => Boolean(value));
    const resolvedTextureCount = Object.values(materialTextures).filter((value) => Boolean(value)).length;
    const hasMaterialBinding = Boolean(
      primitive.materialName ||
        primitive.materialSource ||
        textureReferences.length > 0 ||
        resolvedTextureCount > 0 ||
        primitive.metallicFactor !== null ||
        primitive.roughnessFactor !== null ||
        primitive.emissiveFactor !== null ||
        primitive.opacityFactor !== null
    );
    if (hasMaterialBinding) materialsBound += 1;
    referencedTextures += textureReferences.length;
    if (resolvedTextureCount > 0) texturedMaterials += 1;
    unresolvedTextureBindings += Math.max(0, textureReferences.length - resolvedTextureCount);
    const localPose = rebaseWorldPoseToTargetLocal(
      {
        position: primitive.position,
        quaternion: primitive.quaternion,
        scale: primitive.scale,
        parentBody: primitive.parentBody,
        parentBodyPath: primitive.parentBodyPath,
      },
      targetEntry
    );
    const visualPrimitive = createUsdVisualPrimitive(
      {
        ...primitive,
        position: localPose.position,
        quaternion: localPose.quaternion,
        scale: localPose.scale,
      },
      { materialTextures }
    );
    if (!visualPrimitive) continue;
    const collisionPrimitive = attachCollisionProxies ? createUsdCollisionMeshFromVisual(visualPrimitive) : null;
    attachPair(visualPrimitive, collisionPrimitive, targetEntry, primitive.primPath);
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
    referencedTextures,
    unresolvedTextureBindings,
    aliasCollisionCount: links.aliasCollisionCount,
    parentPoseWorldFallbacks,
  };

  return {
    attachedMeshes,
    attachedPrimitives,
    attachedToLinks,
    attachedToRoot,
    materialsBound,
    texturedMaterials,
    referencedTextures,
    unresolvedTextureBindings,
    aliasCollisionCount: links.aliasCollisionCount,
    parentPoseWorldFallbacks,
  };
};

const toTitleFromToken = (token: string): string =>
  token
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());

const deriveSceneAssetContainerKey = (
  entry: UsdLinkRenderGroupEntry,
  rootPrimSegment: string | null
): { key: string; sourcePrimRoot: string | null } => {
  const primPathCandidates = Array.from(entry.sourcePrimPaths)
    .map((path) => normalizePathAliasToken(path))
    .filter((path): path is string => Boolean(path));
  for (const primPath of primPathCandidates) {
    const segments = primPath.split("/").filter(Boolean);
    if (!segments.length) continue;
    const trimmed =
      rootPrimSegment && segments[0] === rootPrimSegment
        ? segments.slice(1)
        : segments;
    if (!trimmed.length) continue;
    const key = trimmed[0];
    if (key) return { key, sourcePrimRoot: rootPrimSegment };
  }
  if (entry.bodyPath) {
    const key = entry.bodyPath.split("/").filter(Boolean).pop() ?? "";
    if (key) return { key, sourcePrimRoot: rootPrimSegment };
  }
  const fallback = normalizeBodyToken(entry.link.name) ?? normalizeAliasToken(entry.link.name) ?? "scene_asset";
  return { key: fallback, sourcePrimRoot: rootPrimSegment };
};

const groupSceneAssetLinksUnderContainers = (
  root: THREE.Object3D
): { containerCount: number; groupedLinks: number } => {
  const lookup = collectUsdLinkGroups(root, false);
  const directEntries = lookup.entries.filter((entry) => entry.link.parent === root);
  if (directEntries.length < 2) return { containerCount: 0, groupedLinks: 0 };

  const allPrimPaths = directEntries.flatMap((entry) => Array.from(entry.sourcePrimPaths));
  const rootPrimSegment = (() => {
    const firstSegments = allPrimPaths
      .map((path) => normalizePathAliasToken(path))
      .filter((path): path is string => Boolean(path))
      .map((path) => path.split("/").filter(Boolean)[0])
      .filter((segment): segment is string => Boolean(segment));
    if (firstSegments.length < 2) return null;
    const first = firstSegments[0];
    return firstSegments.every((segment) => segment === first) ? first : null;
  })();

  const groups = new Map<string, UsdLinkRenderGroupEntry[]>();
  for (const entry of directEntries) {
    const { key } = deriveSceneAssetContainerKey(entry, rootPrimSegment);
    const normalizedKey = normalizeAliasToken(key) ?? "scene_asset";
    const bucket = groups.get(normalizedKey);
    if (!bucket) {
      groups.set(normalizedKey, [entry]);
    } else {
      bucket.push(entry);
    }
  }
  if (groups.size <= 1) return { containerCount: 0, groupedLinks: 0 };

  const containerByKey = new Map<string, THREE.Group>();
  for (const [groupKey, entries] of groups.entries()) {
    const container = new THREE.Group();
    container.name = toTitleFromToken(groupKey) || "Scene Asset";
    container.userData.editorKind = "group";
    container.userData.sceneAssetContainer = true;
    container.userData.sceneAssetContainerKey = groupKey;
    container.userData.sceneAssetContainerSource = "usd_prim_lineage";
    root.add(container);
    containerByKey.set(groupKey, container);

    for (const entry of entries) {
      if (entry.link.parent !== root) continue;
      const sourcePrimPaths = Array.from(entry.sourcePrimPaths);
      entry.link.userData.sceneAssetLineage = {
        groupKey,
        sourcePrimRoot: rootPrimSegment,
        sourcePrimPaths,
        bodyPath: entry.bodyPath,
      };
      container.add(entry.link);
    }
  }

  return {
    containerCount: containerByKey.size,
    groupedLinks: directEntries.length,
  };
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

const isSemanticUsdPathCandidate = (path: string): boolean => {
  const segments = path.split("/").filter(Boolean);
  if (!segments.length) return false;
  if (segments.some((segment) => LINK_NAME_RE.test(segment) || JOINT_NAME_RE.test(segment))) return true;
  return segments.some((segment) => /[A-Za-z]/.test(segment) && /\d/.test(segment) && segment.length >= 3);
};

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

const parseUnitNumberOrNull = (value: unknown): number | null => {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(1, num));
};

const parseColorTriplet = (value: unknown): [number, number, number] | null => {
  if (!Array.isArray(value) || value.length < 3) return null;
  const r = Number(value[0]);
  const g = Number(value[1]);
  const b = Number(value[2]);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  return [
    Math.max(0, Math.min(1, r)),
    Math.max(0, Math.min(1, g)),
    Math.max(0, Math.min(1, b)),
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

const MESH_SCENE_PATH_TOKEN_SKIP_RE =
  /^(world|root|scene|env|environment|robot|robots|xform|scope|geom|geometry|mesh|meshes|material|materials|looks|visual|collision|collider|physics|render|model|default)$/i;

const deriveMeshSceneTokenFromPath = (value: string | null | undefined): string | null => {
  const normalized = normalizePathAliasToken(value);
  if (!normalized) return null;
  const segments = normalized.split("/").filter(Boolean);
  if (!segments.length) return null;

  const pickToken = (segment: string) => {
    const token = normalizeBodyToken(segment);
    if (!token) return null;
    const lower = token.toLowerCase();
    if (PATH_SKIP_SEGMENTS.has(lower)) return null;
    if (MESH_SCENE_PATH_TOKEN_SKIP_RE.test(lower)) return null;
    if (JOINT_NAME_RE.test(token)) return null;
    return token;
  };

  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const token = pickToken(segments[i]);
    if (!token) continue;
    if (LINK_NAME_RE.test(token)) return token;
  }
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const token = pickToken(segments[i]);
    if (!token) continue;
    if (/[A-Za-z]/.test(token) && (/\d/.test(token) || /[_-]/.test(token))) return token;
  }
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const token = pickToken(segments[i]);
    if (!token) continue;
    return token;
  }
  return null;
};

const collectMeshSceneStructureTokens = (meshScene: NormalizedUsdMeshScene): Set<string> => {
  const out = new Set<string>();
  const register = (value: string | null | undefined) => {
    const token = normalizeBodyToken(value);
    if (!token) return;
    const lower = token.toLowerCase();
    if (PATH_SKIP_SEGMENTS.has(lower)) return;
    if (MESH_SCENE_PATH_TOKEN_SKIP_RE.test(lower)) return;
    out.add(token);
  };
  const registerPath = (value: string | null | undefined) => {
    const token = deriveMeshSceneTokenFromPath(value);
    if (!token) return;
    out.add(token);
  };

  for (const body of meshScene.bodies) {
    register(body.name);
    register(body.parentBody);
    registerPath(body.primPath);
    registerPath(body.parentBodyPath);
  }
  for (const mesh of meshScene.meshes) {
    register(mesh.parentBody);
    registerPath(mesh.parentBodyPath);
    registerPath(mesh.primPath);
  }
  for (const primitive of meshScene.primitives) {
    register(primitive.parentBody);
    registerPath(primitive.parentBodyPath);
    registerPath(primitive.primPath);
  }
  return out;
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
      parentBodyPath: parseOptionalText(item?.parentBodyPath),
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
      normalTexture: normalizeTextureAssetPath(parseOptionalText(item?.normalTexture)),
      metallicTexture: normalizeTextureAssetPath(parseOptionalText(item?.metallicTexture)),
      roughnessTexture: normalizeTextureAssetPath(parseOptionalText(item?.roughnessTexture)),
      metallicRoughnessTexture: normalizeTextureAssetPath(parseOptionalText(item?.metallicRoughnessTexture)),
      occlusionTexture: normalizeTextureAssetPath(parseOptionalText(item?.occlusionTexture)),
      emissiveTexture: normalizeTextureAssetPath(parseOptionalText(item?.emissiveTexture)),
      opacityTexture: normalizeTextureAssetPath(parseOptionalText(item?.opacityTexture)),
      metallicFactor: parseUnitNumberOrNull(item?.metallicFactor),
      roughnessFactor: parseUnitNumberOrNull(item?.roughnessFactor),
      emissiveFactor: parseColorTriplet(item?.emissiveFactor),
      opacityFactor: parseUnitNumberOrNull(item?.opacityFactor),
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
      parentBodyPath: parseOptionalText(item?.parentBodyPath),
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
      normalTexture: normalizeTextureAssetPath(parseOptionalText(item?.normalTexture)),
      metallicTexture: normalizeTextureAssetPath(parseOptionalText(item?.metallicTexture)),
      roughnessTexture: normalizeTextureAssetPath(parseOptionalText(item?.roughnessTexture)),
      metallicRoughnessTexture: normalizeTextureAssetPath(parseOptionalText(item?.metallicRoughnessTexture)),
      occlusionTexture: normalizeTextureAssetPath(parseOptionalText(item?.occlusionTexture)),
      emissiveTexture: normalizeTextureAssetPath(parseOptionalText(item?.emissiveTexture)),
      opacityTexture: normalizeTextureAssetPath(parseOptionalText(item?.opacityTexture)),
      metallicFactor: parseUnitNumberOrNull(item?.metallicFactor),
      roughnessFactor: parseUnitNumberOrNull(item?.roughnessFactor),
      emissiveFactor: parseColorTriplet(item?.emissiveFactor),
      opacityFactor: parseUnitNumberOrNull(item?.opacityFactor),
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
      parentBodyPath: parseOptionalText(item?.parentBodyPath),
      position: [px, py, pz],
      quaternion: quat,
      scale: [
        Math.max(1e-6, Number.isFinite(sx) ? sx : 1),
        Math.max(1e-6, Number.isFinite(sy) ? sy : 1),
        Math.max(1e-6, Number.isFinite(sz) ? sz : 1),
      ],
      rigidBodyEnabled:
        typeof item?.rigidBodyEnabled === "boolean" ? item.rigidBodyEnabled : null,
      kinematicEnabled:
        typeof item?.kinematicEnabled === "boolean" ? item.kinematicEnabled : null,
      mass: Number.isFinite(Number(item?.mass)) ? Math.max(0, Number(item?.mass)) : null,
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
  return await collectUsdBundleFilesFromCollector(params);
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
      if (node.kind === "link") {
        const bodyToken = normalizeBodyToken(node.name);
        if (bodyToken) group.userData.usdBodyToken = bodyToken;
        const bodyPath = normalizePathAliasToken(node.path);
        if (bodyPath) group.userData.usdBodyPath = bodyPath;
      }
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
  const semanticPrimPaths = primPaths.filter((path) => isSemanticUsdPathCandidate(path));
  const primNodes = buildPrimNodes(semanticPrimPaths, rootHint);

  addUsdHierarchyFallback(robotRoot, primNodes);
  logWarn("USD fallback hierarchy used (converter unavailable or conversion failed).", {
    scope: "usd",
    data: { primCount: primNodes.length, pathCount: primPaths.length, semanticPathCount: semanticPrimPaths.length },
  });

  return robotRoot;
};

const createPlaceholderLinkNode = (linkName: string, bodyPath?: string | null) => {
  const link = new THREE.Group();
  const linkFlags = link as THREE.Group & { isURDFLink?: boolean; urdfName?: string };
  link.name = linkName;
  linkFlags.isURDFLink = true;
  linkFlags.urdfName = linkName;
  link.userData.editorKind = "link";
  const bodyToken = normalizeBodyToken(linkName);
  if (bodyToken) link.userData.usdBodyToken = bodyToken;
  const normalizedBodyPath = normalizePathAliasToken(bodyPath);
  if (normalizedBodyPath) link.userData.usdBodyPath = normalizedBodyPath;

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

  const bodyPathByToken = new Map<string, string>();
  for (const joint of introspection.joints) {
    const parentToken = normalizeBodyToken(joint.parentBody);
    const parentPath = normalizePathAliasToken(joint.parentBodyPath);
    if (parentToken && parentPath && !bodyPathByToken.has(parentToken)) bodyPathByToken.set(parentToken, parentPath);
    const childToken = normalizeBodyToken(joint.childBody);
    const childPath = normalizePathAliasToken(joint.childBodyPath);
    if (childToken && childPath && !bodyPathByToken.has(childToken)) bodyPathByToken.set(childToken, childPath);
  }

  const linksByName = new Map<string, THREE.Group>();
  const ensureLink = (rawName: string, bodyPathHint?: string | null) => {
    const key = (normalizeBodyToken(rawName) ?? rawName.trim()) || "link";
    const existing = linksByName.get(key);
    if (existing) return existing;
    const hintedBodyPath =
      normalizePathAliasToken(bodyPathHint) ??
      bodyPathByToken.get(key) ??
      null;
    const created = createPlaceholderLinkNode(key, hintedBodyPath);
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
    if (joint.parentBody) ensureLink(joint.parentBody, joint.parentBodyPath);
    if (joint.childBody) ensureLink(joint.childBody, joint.childBodyPath);
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

    const parentLink = ensureLink(parentName, joint.parentBodyPath);
    const childLink = ensureLink(childName, joint.childBodyPath);

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

const buildRobotFromMeshSceneBodies = (meshScene: NormalizedUsdMeshScene, robotName: string) => {
  const robotRoot = new THREE.Group();
  const robotRootFlagged = robotRoot as THREE.Group & { isRobot?: boolean };
  robotRoot.name = robotName;
  robotRootFlagged.isRobot = true;
  robotRoot.userData.editorRobotRoot = true;

  const bodyByToken = new Map<string, NormalizedUsdMeshSceneBody>();
  for (const body of meshScene.bodies) {
    const token = normalizeBodyToken(body.name) ?? String(body.name ?? "").trim();
    if (!token || bodyByToken.has(token)) continue;
    bodyByToken.set(token, {
      ...body,
      name: token,
    });
  }
  const structureTokens = collectMeshSceneStructureTokens(meshScene);
  for (const token of structureTokens) {
    if (bodyByToken.has(token)) continue;
    bodyByToken.set(token, {
      name: token,
      primPath: "",
      parentBody: null,
      parentBodyPath: null,
      position: [0, 0, 0],
      quaternion: new THREE.Quaternion(0, 0, 0, 1),
      scale: [1, 1, 1],
      rigidBodyEnabled: null,
      kinematicEnabled: null,
      mass: null,
    });
  }

  if (bodyByToken.size === 0) {
    return { root: robotRoot, linkCount: 0, jointCount: 0 };
  }

  const linksByToken = new Map<string, THREE.Group>();
  const ensureLink = (token: string) => {
    const existing = linksByToken.get(token);
    if (existing) return existing;
    const body = bodyByToken.get(token);
    const hintedBodyPath = normalizePathAliasToken(body?.primPath ?? body?.parentBodyPath ?? null);
    const created = createPlaceholderLinkNode(token, hintedBodyPath);
    created.userData.usdBodyToken = token;
    if (hintedBodyPath) created.userData.usdBodyPath = hintedBodyPath;
    linksByToken.set(token, created);
    return created;
  };

  for (const token of bodyByToken.keys()) {
    ensureLink(token);
  }

  const jointNames = new Set<string>();
  let jointCount = 0;

  for (const [token, body] of bodyByToken.entries()) {
    const parentToken = normalizeBodyToken(body.parentBody);
    if (!parentToken || !bodyByToken.has(parentToken) || parentToken === token) continue;
    const parentLink = ensureLink(parentToken);
    const childLink = ensureLink(token);
    if (childLink.parent) continue;

    const jointName = claimName(`${parentToken}_${token}_fixed`, jointNames, "joint");
    const jointNode = new THREE.Group();
    const jointFlags = jointNode as THREE.Group & { isURDFJoint?: boolean; urdfName?: string };
    jointNode.name = jointName;
    jointFlags.isURDFJoint = true;
    jointFlags.urdfName = jointName;
    jointNode.userData.editorKind = "joint";
    jointNode.position.set(body.position[0], body.position[1], body.position[2]);
    jointNode.quaternion.copy(body.quaternion);
    jointNode.userData.urdf = {
      kind: "joint",
      joint: {
        name: jointName,
        type: "fixed",
        parent: parentLink.name,
        child: childLink.name,
        origin: toPose(body.position, body.quaternion),
        axis: [0, 0, 1],
      } satisfies UrdfJoint,
    };

    parentLink.add(jointNode);
    jointNode.add(childLink);
    childLink.position.set(0, 0, 0);
    childLink.quaternion.identity();
    childLink.scale.set(body.scale[0], body.scale[1], body.scale[2]);
    jointCount += 1;
  }

  for (const [token, link] of linksByToken.entries()) {
    if (link.parent) continue;
    const body = bodyByToken.get(token);
    if (body) {
      link.position.set(body.position[0], body.position[1], body.position[2]);
      link.quaternion.copy(body.quaternion);
      link.scale.set(body.scale[0], body.scale[1], body.scale[2]);
    }
    robotRoot.add(link);
  }

  let effectiveLinkCount = linksByToken.size;
  const modelToken = normalizeBodyToken(stripFileExtension(robotName));
  if (modelToken && linksByToken.size > 1) {
    const modelLink = linksByToken.get(modelToken);
    if (modelLink && modelLink.parent === robotRoot) {
      const nearIdentityScale =
        Math.abs(modelLink.scale.x - 1) <= 1e-4 &&
        Math.abs(modelLink.scale.y - 1) <= 1e-4 &&
        Math.abs(modelLink.scale.z - 1) <= 1e-4;
      const nearIdentityPose =
        modelLink.position.lengthSq() <= 1e-10 &&
        modelLink.quaternion.angleTo(IDENTITY_QUAT) <= 1e-4 &&
        nearIdentityScale;
      if (nearIdentityPose) {
        const children = [...modelLink.children];
        for (const child of children) {
          modelLink.remove(child);
          robotRoot.add(child);
        }
        robotRoot.remove(modelLink);
        effectiveLinkCount -= 1;
      }
    }
  }

  return {
    root: robotRoot,
    linkCount: effectiveLinkCount,
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
  return uploadUsdBundleAsset({
    baseUrl: usdConverterBaseUrl,
    bundle,
  });
};

const convertUsdAssetToMjcf = async (params: {
  converterAssetId: string;
  usdKey: string;
  importOptions?: UsdImportOptions;
}) => {
  const converted = await convertUsdAssetToMjcfAsset({
    baseUrl: usdConverterBaseUrl,
    converterAssetId: params.converterAssetId,
    floatingBase: params.importOptions?.floatingBase ?? false,
    selfCollision: params.importOptions?.selfCollision ?? false,
    collisionProfile: resolveUsdCollisionProfile(params.usdKey, params.importOptions),
  });

  return {
    converterAssetId: params.converterAssetId,
    mjcfAssetId: converted.mjcfAssetId,
    mjcfXml: converted.mjcfXml,
    diagnostics: converted.diagnostics ?? null,
  };
};

const introspectUsdAsset = async (converterAssetId: string): Promise<NormalizedUsdIntrospection | null> => {
  const payload = (await fetchUsdAssetIntrospectionPayload({
    baseUrl: usdConverterBaseUrl,
    converterAssetId,
  })) as UsdConverterIntrospectionResponse;
  return normalizeUsdIntrospection(payload, converterAssetId);
};

const fetchUsdMeshScene = async (
  converterAssetId: string,
  profile: "balanced" | "high_fidelity"
): Promise<NormalizedUsdMeshScene | null> => {
  const payload = (await fetchUsdAssetMeshScenePayload({
    baseUrl: usdConverterBaseUrl,
    converterAssetId,
    profile,
  })) as UsdConverterMeshSceneResponse;
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
  let useVisualCollisionSync = true;
  let introspection: NormalizedUsdIntrospection | null = null;
  let meshScene: NormalizedUsdMeshScene | null = null;
  let detectedFloatingBase: boolean | undefined;
  let converterDiagnostics = normalizeUsdConverterDiagnostics(null);
  const normalizedUsdKey = String(usdKey ?? "").trim().replace(/\\/g, "/").toLowerCase();
  const importWarnings: UsdImportWarning[] = [];

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
          importWarnings.push({
            code: "USD_IMPORT_FRAME_MISMATCH_FALLBACK",
            message: "USD introspection omitted frame0Local on some joints; compatibility fallback was applied.",
            context: {
              usdKey,
              converterAssetId: resolvedConverterAssetId,
            },
          });
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
        meshScene = await fetchUsdMeshScene(
          resolvedConverterAssetId,
          resolveUsdMeshSceneProfile(usdKey, importOptions)
        );
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
        usdKey,
        importOptions,
      });
      converterDiagnostics = normalizeUsdConverterDiagnostics(converted.diagnostics);
      if (converterDiagnostics.placeholderGeomBodies > 0) {
        useVisualCollisionSync = false;
        importWarnings.push({
          code: "USD_IMPORT_PLACEHOLDER_COLLISION_GEOMS",
          message: "USD conversion synthesized placeholder collision geometry; visual collision proxy sync was disabled to preserve authored collision diagnostics.",
          context: {
            usdKey,
            placeholderGeomBodies: converterDiagnostics.placeholderGeomBodies,
            bodiesWithAnyGeom: converterDiagnostics.bodiesWithAnyGeom,
          },
        });
      }
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
        const eeLinkBody = parsed.bodies.find((body) => body.name === "ee_link") ?? null;
        const eeLinkOnlyPlaceholderBox =
          !!eeLinkBody && eeLinkBody.geoms.length > 0 && eeLinkBody.geoms.every((geom) => geom.type === "box");
        const meshSceneHasEeLinkGeometry = Boolean(
          meshScene?.meshes.some((mesh) => mesh.parentBody === "ee_link") ||
          meshScene?.primitives.some((primitive) => primitive.parentBody === "ee_link")
        );
        if (
          eeLinkOnlyPlaceholderBox &&
          meshSceneHasEeLinkGeometry &&
          (normalizedUsdKey.includes("/ur10") || normalizedUsdKey.endsWith("ur10.usd"))
        ) {
          importWarnings.push({
            code: "USD_IMPORT_EE_LINK_PLACEHOLDER_COLLISION",
            message: "ee_link imported with placeholder box collision geometry while mesh-scene data still exposes end-effector visuals.",
            context: {
              usdKey,
              placeholderGeomBodies: converterDiagnostics.placeholderGeomBodies,
              eeLinkGeomTypes: eeLinkBody?.geoms.map((geom) => geom.type) ?? [],
            },
          });
        }
        detectedFloatingBase = parsed.bodies.some((body) => body.joints.some((joint) => joint.type === "free"));
        const builtFromMjcf = buildRobotFromMjcf(parsed, displayName, { introspection });
        const introspectionBodyCount = introspection
          ? new Set(
              introspection.joints
                .flatMap((joint) => [joint.parentBody, joint.childBody])
                .filter((name): name is string => Boolean(name))
            ).size
          : 0;
        const meshSceneBodyCount = meshScene?.bodies.length ?? 0;
        const meshSceneStructureTokenCount = meshScene ? collectMeshSceneStructureTokens(meshScene).size : 0;
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
          const mjcfLikelyCorruptedAgainstMeshScene =
            !introspection &&
            meshSceneStructureTokenCount >= 3 &&
            (
              builtFromMjcf.linkCount < Math.max(2, Math.ceil(meshSceneStructureTokenCount * 0.25)) ||
              (meshSceneStructureTokenCount >= 2 && builtFromMjcf.jointCount === 0)
            );
          if (mjcfLikelyCorruptedAgainstMeshScene && meshScene) {
            const builtFromMeshScene = buildRobotFromMeshSceneBodies(meshScene, displayName);
            if (builtFromMeshScene.linkCount > 0) {
              root = builtFromMeshScene.root;
              logWarn("USD MJCF hierarchy appears incompatible with mesh-scene body graph; using mesh-scene skeleton.", {
                scope: "usd",
                data: {
                  usdKey,
                  converterAssetId: resolvedConverterAssetId,
                  mjcfAssetId: resolvedMjcfAssetId,
                  mjcfLinks: builtFromMjcf.linkCount,
                  mjcfJoints: builtFromMjcf.jointCount,
                  meshSceneBodies: meshSceneBodyCount,
                  meshSceneStructureTokens: meshSceneStructureTokenCount,
                },
              });
              logInfo("USD conversion + render completed", {
                scope: "usd",
                data: {
                  usdKey,
                  converterAssetId: resolvedConverterAssetId,
                  mjcfAssetId: resolvedMjcfAssetId,
                  links: builtFromMeshScene.linkCount,
                  joints: builtFromMeshScene.jointCount,
                  hierarchySource: "mesh_scene",
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
      }

      if (useVisualCollisionSync) {
        logInfo("USD visual->collision sync enabled by default.", {
          scope: "usd",
          data: {
            usdKey,
            converterAssetId: resolvedConverterAssetId,
          },
        });
      } else {
        logWarn("USD visual->collision sync disabled to avoid masking authored placeholder collision diagnostics.", {
          scope: "usd",
          data: {
            usdKey,
            converterAssetId: resolvedConverterAssetId,
            placeholderGeomBodies: converterDiagnostics.placeholderGeomBodies,
          },
        });
      }
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

  const meshSceneStructureTokenCount = meshScene ? collectMeshSceneStructureTokens(meshScene).size : 0;
  if (!root && importSceneRole === "robot" && meshScene && meshSceneStructureTokenCount > 0) {
    const built = buildRobotFromMeshSceneBodies(meshScene, displayName);
    if (built.linkCount > 0) {
      root = built.root;
      logInfo("USD mesh-scene body fallback hierarchy used.", {
        scope: "usd",
        data: {
          usdKey,
          converterAssetId: resolvedConverterAssetId,
          links: built.linkCount,
          joints: built.jointCount,
          bodyCount: meshScene.bodies.length,
          structureTokenCount: meshSceneStructureTokenCount,
        },
      });
    }
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
  const shouldReplaceExistingVisuals = Boolean(
    meshScene &&
      !meshScene.truncated &&
      (meshScene.meshes.length > 0 || meshScene.primitives.length > 0)
  );
  const meshAttach = attachUsdMeshSceneToRoot(root, meshScene, {
    selfCollisionEnabled: importOptions?.selfCollision === true,
    resolveResource,
    attachCollisionProxies: useVisualCollisionSync,
    replaceExisting: shouldReplaceExistingVisuals,
  });
  if (meshScene && meshScene.meshes.length > 0 && meshAttach.attachedMeshes === 0) {
    importWarnings.push({
      code: "USD_IMPORT_MESH_ATTACH_DROP",
      message: "USD mesh-scene contained meshes but no visual mesh could be attached.",
      context: {
        usdKey,
        converterAssetId: resolvedConverterAssetId,
        meshCount: meshScene.meshes.length,
        primitiveCount: meshScene.primitives.length,
      },
    });
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
  if (meshAttach.attachedToRoot > 0 || meshAttach.aliasCollisionCount > 0) {
    importWarnings.push({
      code: "USD_IMPORT_HIERARCHY_FLATTEN_FALLBACK",
      message: "Some USD visuals could not be matched to a unique link lineage and were attached to root fallback containers.",
      context: {
        usdKey,
        attachedToRoot: meshAttach.attachedToRoot,
        aliasCollisionCount: meshAttach.aliasCollisionCount,
      },
    });
  }
  if (meshAttach.parentPoseWorldFallbacks > 0) {
    importWarnings.push({
      code: "USD_IMPORT_FRAME_MISMATCH_FALLBACK",
      message: "Detected likely world-space body-relative mesh poses; applied compatibility rebasing to local link frames.",
      context: {
        usdKey,
        parentPoseWorldFallbacks: meshAttach.parentPoseWorldFallbacks,
      },
    });
  }
  if (meshAttach.unresolvedTextureBindings > 0) {
    importWarnings.push({
      code: "USD_IMPORT_OPTIONAL_MATERIAL_BINDING_MISSING",
      message: "Some USD material texture references were missing in the resolved bundle; fallback material bindings were used.",
      context: {
        usdKey,
        unresolvedTextureBindings: meshAttach.unresolvedTextureBindings,
        referencedTextures: meshAttach.referencedTextures,
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
        unresolvedTextureBindings: Number(root.userData?.usdMeshScene?.unresolvedTextureBindings ?? 0),
        aliasCollisionCount: Number(root.userData?.usdMeshScene?.aliasCollisionCount ?? 0),
      },
    });
  }
  const uniqueImportWarnings = Array.from(
    new Map(
      importWarnings.map((warning) => [
        `${warning.code}|${warning.message}|${JSON.stringify(warning.context ?? {})}`,
        warning,
      ])
    ).values()
  );

  if (importSceneRole === "scene_asset") {
    const sceneAssetRole = inferSceneAssetSourceRole(usdKey);
    const sceneAssetName = stripFileExtension(displayName) || displayName;
    const sceneAssetRoot = ensureSceneAssetRootHierarchy(root, {
      sceneAssetName,
      selfCollisionEnabled: importOptions?.selfCollision === true,
      sourceRole: sceneAssetRole,
    });
    const usesManagedDefaultFloor = sceneAssetRole === "terrain" && isDefaultFloorWorkspaceKey(usdKey);
    const usesManagedRoughFloor = sceneAssetRole === "terrain" && isManagedRoughFloorWorkspaceKey(usdKey);
    const grouping = groupSceneAssetLinksUnderContainers(sceneAssetRoot);
    let styledFloorMeshes = 0;
    if (usesManagedDefaultFloor) {
      styledFloorMeshes = applyDefaultFloorAppearanceToSceneAsset(sceneAssetRoot);
    } else if (usesManagedRoughFloor) {
      styledFloorMeshes = applyRoughFloorAppearanceToSceneAsset(sceneAssetRoot);
    }
    const sceneAssetMetadata: Record<string, unknown> = {
      importSceneRole,
      sceneAssetLinkContainers: grouping.containerCount,
      sceneAssetGroupedLinks: grouping.groupedLinks,
      importWarnings: uniqueImportWarnings,
    };
    if (usesManagedDefaultFloor) {
      sceneAssetMetadata.managedTerrainAssetId = "floor";
      sceneAssetMetadata.visualStyle = "default_floor";
      sceneAssetMetadata.styledMeshCount = styledFloorMeshes;
    } else if (usesManagedRoughFloor) {
      sceneAssetMetadata.managedTerrainAssetId = "floor:rough";
      sceneAssetMetadata.visualStyle = "rough_floor";
      sceneAssetMetadata.styledMeshCount = styledFloorMeshes;
    }
    retagUsdRootAsSceneAsset(sceneAssetRoot, sceneAssetName);
    applySceneAssetPhysicsDefaults(sceneAssetRoot, {
      forceRootCollider: meshAttach.attachedToRoot > 0 || (sceneAssetRoot.userData?.usdMeshScene?.bodyCount ?? 0) <= 0,
      sourceRole: sceneAssetRole,
      meshScene,
    });
    sceneAssetRoot.userData.usdUrl = usdUrl;
    sceneAssetRoot.userData.usdWorkspaceKey = usdKey;
    sceneAssetRoot.userData.usdImportWarnings = uniqueImportWarnings;
    sceneAssetRoot.userData.usdConverterDiagnostics = converterDiagnostics;
    sceneAssetRoot.userData.sceneAssetSource = {
      kind: "usd",
      role: sceneAssetRole,
      workspaceKey: usdKey,
      converterAssetId: resolvedConverterAssetId ?? null,
      trainingAssetId: null,
      sourceUrl: usdUrl,
      importOptions: importOptions ? { ...importOptions } : null,
      metadata: sceneAssetMetadata,
    };
    if (resolvedConverterAssetId) sceneAssetRoot.userData.converterAssetId = resolvedConverterAssetId;
    if (resolvedMjcfAssetId) sceneAssetRoot.userData.mjcfAssetId = resolvedMjcfAssetId;
    if (mjcfXml) sceneAssetRoot.userData.mjcfSource = mjcfXml;
    if (mjcfBodiesPatchedFromMeshScene > 0) sceneAssetRoot.userData.mjcfBodyPosePatchCount = mjcfBodiesPatchedFromMeshScene;
    if (usesManagedDefaultFloor) {
      logInfo("USD default floor scene asset restyled to editor floor material", {
        scope: "usd",
        data: {
          usdKey,
          styledFloorMeshes,
          managedTerrainAssetId: "floor",
        },
      });
    } else if (usesManagedRoughFloor) {
      logInfo("USD rough floor scene asset restyled to editor rough-floor material", {
        scope: "usd",
        data: {
          usdKey,
          styledFloorMeshes,
          managedTerrainAssetId: "floor:rough",
        },
      });
    }
    logInfo("USD scene asset import completed", {
      scope: "usd",
      data: {
        usdKey,
        sceneAssetName: sceneAssetRoot.name,
        converterAssetId: resolvedConverterAssetId,
        attachedMeshes: meshAttach.attachedMeshes,
        attachedPrimitives: meshAttach.attachedPrimitives,
        usesManagedDefaultFloor,
        usesManagedRoughFloor,
        sceneAssetLinkContainers: grouping.containerCount,
        importWarningCount: uniqueImportWarnings.length,
      },
    });
    return sceneAssetRoot;
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
    importWarnings: uniqueImportWarnings,
  };

  root.userData.robotModelSource = modelSource;
  root.userData.usdUrl = usdUrl;
  root.userData.usdWorkspaceKey = usdKey;
  root.userData.usdImportWarnings = uniqueImportWarnings;
  root.userData.usdConverterDiagnostics = converterDiagnostics;
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
  skipPostLoadHook?: boolean;
};

export async function loadWorkspaceUSDIntoViewer(deps: USDImportDeps) {
  const { usdKey, assets, importOptions, bundleHintPaths, rootName, sceneRole, frameOnAdd, skipPostLoadHook } = deps;

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
      skipPostLoadHook: skipPostLoadHook === true,
    }
  );
}
