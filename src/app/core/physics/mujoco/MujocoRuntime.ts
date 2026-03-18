/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from "three";
import loadMujoco, { type MainModule, type MjData, type MjModel } from "mujoco-js";
import type { SceneSnapshot } from "../../viewer/types";
import { ensureUserInstance } from "../../assets/assetInstance";
import type { InstancePhysics } from "../../assets/types";
import { computeInertiaFromGeom, inferGeomInfo, isValidInertia } from "../geomUtils";
import { sanitizeMjcfName, type MjcfNameMap } from "./mjcfNames";
import { getDocId } from "../../scene/docIds";
import { logInfo } from "../../services/logger";

export type MujocoConfig = {
  noiseRate: number;
  noiseScale: number;
};

export type JointActuatorConfig = {
  stiffness: number;
  damping: number;
  velocityGain?: number;
  maxForce?: number;
  actuatorName?: string;
  continuous?: boolean;
  angular?: boolean;
  mode?: "position" | "velocity" | "torque" | "muscle";
};

export type MujocoModelSource =
  | { kind: "generated" }
  | {
      kind: "urdf" | "mjcf";
      filename: string;
      content: string;
      files: Record<string, Uint8Array>;
      nameMap?: MjcfNameMap;
    };

export type PointerWorldPoint = { x: number; y: number; z: number };
export type PointerInteractionMode = "none" | "grab" | "cursor";
export type PointerForceConfig = {
  stiffnessNPerMeter: number;
  maxForceN: number;
};
export type PointerSpringDebugState = {
  anchor: PointerWorldPoint;
  target: PointerWorldPoint;
  force: PointerWorldPoint;
  forceMagnitudeN: number;
  distanceMeters: number;
  stiffnessNPerMeter: number;
  maxForceN: number;
};

export type MujocoRuntimeColliderType =
  | "plane"
  | "sphere"
  | "capsule"
  | "ellipsoid"
  | "cylinder"
  | "box"
  | "mesh"
  | "hfield"
  | "sdf"
  | "unknown";

export type MujocoRuntimeMeshColliderAsset = {
  meshId: number;
  vertices: number[];
  indices: number[];
};

export type MujocoRuntimeHfieldColliderAsset = {
  hfieldId: number;
  nrow: number;
  ncol: number;
  size: [number, number, number, number];
  heights: number[];
};

export type MujocoRuntimeColliderSnapshot = {
  geomId: number;
  geomName: string;
  bodyId: number;
  bodyName: string | null;
  type: MujocoRuntimeColliderType;
  size: [number, number, number];
  position: { x: number; y: number; z: number };
  quaternion: { w: number; x: number; y: number; z: number };
  contype: number;
  conaffinity: number;
  meshId: number | null;
  hfieldId: number | null;
  mesh: MujocoRuntimeMeshColliderAsset | null;
  hfield: MujocoRuntimeHfieldColliderAsset | null;
};

export type MujocoRuntime = {
  loadFromScene: (
    snapshot: SceneSnapshot,
    roots: THREE.Object3D[],
    config: MujocoConfig,
    source: MujocoModelSource
  ) => Promise<{ warnings: string[] }>;
  step: (dt: number) => void;
  setNoiseRate: (value: number) => void;
  setNoiseScale: (value: number) => void;
  getActuatorNames: () => string[];
  setActuatorControls: (controls: Record<string, number> | ArrayLike<number>) => void;
  setActuatorTargets: (targets: Record<string, number>) => void;
  setActuatorVelocityTargets: (targets: Record<string, number>) => void;
  setActuatorTorqueTargets: (targets: Record<string, number>) => void;
  setActuatorConfigs: (configs: Record<string, JointActuatorConfig>) => void;
  setActuatorsArmed: (armed: boolean) => void;
  getJointPositions: (names?: string[]) => Record<string, number>;
  setJointPositions: (positions: Record<string, number>) => void;
  setPointerForceConfig: (config: Partial<PointerForceConfig>) => void;
  beginPointerInteraction: (objectId: string | null, worldPoint: PointerWorldPoint) => PointerInteractionMode;
  updatePointerTarget: (worldPoint: PointerWorldPoint | null) => void;
  endPointerInteraction: () => void;
  getPointerSpringDebugState: () => PointerSpringDebugState | null;
  getRuntimeColliderSnapshots: () => MujocoRuntimeColliderSnapshot[];
  getLastXML: () => string | null;
  dispose: () => void;
};

type BodyBinding = {
  bodyId: number;
  object: THREE.Object3D;
  baseScale: THREE.Vector3;
  bodyToObject: THREE.Matrix4;
};

let modulePromise: Promise<MainModule> | null = null;
const MUJOCO_DEBUG = String(import.meta.env.VITE_MUJOCO_DEBUG ?? "").toLowerCase() === "true";
const MUJOCO_DUMP_XML = String(import.meta.env.VITE_MUJOCO_DUMP_XML ?? "").toLowerCase() === "true";
const MUJOCO_SELF_COLLIDE = String(import.meta.env.VITE_URDF_SELF_COLLIDE ?? "false").toLowerCase() === "true";
const DEFAULT_ACTUATOR_VELOCITY_GAIN = Number(import.meta.env.VITE_ACTUATOR_VELOCITY_GAIN ?? "4");
const ACTUATOR_ARM_RAMP_SEC = Number(import.meta.env.VITE_ACTUATOR_ARM_RAMP_SEC ?? "0.25");
const ACTUATOR_CTRL_FILTER_SEC = Number(import.meta.env.VITE_ACTUATOR_CTRL_FILTER_SEC ?? "0.03");
const ACTUATOR_DAMPING_RATIO_FLOOR_RAW = Number(import.meta.env.VITE_ACTUATOR_DAMPING_RATIO_FLOOR ?? "0.85");
const ACTUATOR_MAX_ANGULAR_ERROR_DEG_RAW = Number(import.meta.env.VITE_ACTUATOR_MAX_ANGULAR_ERROR_DEG ?? "45");
const ACTUATOR_MAX_LINEAR_ERROR_RAW = Number(import.meta.env.VITE_ACTUATOR_MAX_LINEAR_ERROR ?? "0.25");
const DEFAULT_SCENE_JOINT_DAMPING = Number(import.meta.env.VITE_MUJOCO_SCENE_JOINT_DAMPING ?? "0.2");
const DEFAULT_SCENE_JOINT_ARMATURE = Number(import.meta.env.VITE_MUJOCO_SCENE_JOINT_ARMATURE ?? "0.01");
const DEFAULT_CONTACT_SOLREF = String(import.meta.env.VITE_MUJOCO_CONTACT_SOLREF ?? "0.02 1.2");
const DEFAULT_CONTACT_SOLIMP = String(import.meta.env.VITE_MUJOCO_CONTACT_SOLIMP ?? "0.9 0.95 0.001");
const TERRAIN_CONTACT_SOLREF = String(import.meta.env.VITE_MUJOCO_TERRAIN_CONTACT_SOLREF ?? "0.008 1.3");
const TERRAIN_CONTACT_SOLIMP = String(import.meta.env.VITE_MUJOCO_TERRAIN_CONTACT_SOLIMP ?? "0.95 0.99 0.0005");
const TERRAIN_TORSIONAL_FRICTION_RAW = Number(import.meta.env.VITE_MUJOCO_TERRAIN_TORSIONAL_FRICTION ?? "0.02");
const TERRAIN_ROLLING_FRICTION_RAW = Number(import.meta.env.VITE_MUJOCO_TERRAIN_ROLLING_FRICTION ?? "0.001");
const MUJOCO_MIN_SOLVER_ITERATIONS_RAW = Number(import.meta.env.VITE_MUJOCO_MIN_SOLVER_ITERATIONS ?? "120");
const MUJOCO_MIN_NOSLIP_ITERATIONS_RAW = Number(import.meta.env.VITE_MUJOCO_MIN_NOSLIP_ITERATIONS ?? "8");
const MUJOCO_MIN_IMPRATIO_RAW = Number(import.meta.env.VITE_MUJOCO_MIN_IMPRATIO ?? "5");
const TERRAIN_MESH_VERTEX_LIMIT_RAW = Number(import.meta.env.VITE_MUJOCO_TERRAIN_MESH_VERTEX_LIMIT ?? "600000");
const TERRAIN_MESH_FACE_LIMIT_RAW = Number(import.meta.env.VITE_MUJOCO_TERRAIN_MESH_FACE_LIMIT ?? "1200000");
const TERRAIN_HEIGHTMAP_GRID_RAW = Number(import.meta.env.VITE_MUJOCO_TERRAIN_HEIGHTMAP_GRID ?? "96");
const TERRAIN_HEIGHTMAP_MIN_COVERAGE_RAW = Number(import.meta.env.VITE_MUJOCO_TERRAIN_HEIGHTMAP_MIN_COVERAGE ?? "0.02");
const TERRAIN_COLLISION_SIMPLIFIED_CODE = "MUJOCO_TERRAIN_COLLISION_SIMPLIFIED";
const POINTER_CURSOR_BODY_NAME = "__pointer_cursor_body";
const POINTER_CURSOR_PARK_Z_RAW = Number(import.meta.env.VITE_MUJOCO_POINTER_PARK_Z ?? "-1000");
const POINTER_CURSOR_RADIUS_RAW = Number(import.meta.env.VITE_MUJOCO_POINTER_RADIUS ?? "0.06");
const POINTER_DRAG_STIFFNESS_RAW = Number(import.meta.env.VITE_MUJOCO_POINTER_DRAG_STIFFNESS ?? "200");
const POINTER_DRAG_MAX_FORCE_RAW = Number(import.meta.env.VITE_MUJOCO_POINTER_DRAG_MAX_FORCE ?? "160");
const POINTER_DRAG_DAMPING_RATIO_RAW = Number(import.meta.env.VITE_MUJOCO_POINTER_DRAG_DAMPING_RATIO ?? "1");
const POINTER_CURSOR_PARK_Z = Number.isFinite(POINTER_CURSOR_PARK_Z_RAW) ? POINTER_CURSOR_PARK_Z_RAW : -1000;
const POINTER_CURSOR_RADIUS = Number.isFinite(POINTER_CURSOR_RADIUS_RAW) ? POINTER_CURSOR_RADIUS_RAW : 0.06;
const POINTER_DRAG_STIFFNESS = Number.isFinite(POINTER_DRAG_STIFFNESS_RAW) ? POINTER_DRAG_STIFFNESS_RAW : 200;
const POINTER_DRAG_MAX_FORCE = Number.isFinite(POINTER_DRAG_MAX_FORCE_RAW) ? POINTER_DRAG_MAX_FORCE_RAW : 160;
const POINTER_DRAG_DAMPING_RATIO = Number.isFinite(POINTER_DRAG_DAMPING_RATIO_RAW)
  ? Math.max(0, POINTER_DRAG_DAMPING_RATIO_RAW)
  : 1;
const ACTUATOR_DAMPING_RATIO_FLOOR = Number.isFinite(ACTUATOR_DAMPING_RATIO_FLOOR_RAW)
  ? Math.max(0, ACTUATOR_DAMPING_RATIO_FLOOR_RAW)
  : 0.85;
const ACTUATOR_MAX_ANGULAR_ERROR_RAD = Number.isFinite(ACTUATOR_MAX_ANGULAR_ERROR_DEG_RAW)
  ? Math.max(1, ACTUATOR_MAX_ANGULAR_ERROR_DEG_RAW) * (Math.PI / 180)
  : Math.PI / 4;
const ACTUATOR_MAX_LINEAR_ERROR = Number.isFinite(ACTUATOR_MAX_LINEAR_ERROR_RAW)
  ? Math.max(0.01, ACTUATOR_MAX_LINEAR_ERROR_RAW)
  : 0.25;
const TERRAIN_TORSIONAL_FRICTION = Number.isFinite(TERRAIN_TORSIONAL_FRICTION_RAW)
  ? Math.max(0, TERRAIN_TORSIONAL_FRICTION_RAW)
  : 0.02;
const TERRAIN_ROLLING_FRICTION = Number.isFinite(TERRAIN_ROLLING_FRICTION_RAW)
  ? Math.max(0, TERRAIN_ROLLING_FRICTION_RAW)
  : 0.001;
const MUJOCO_MIN_SOLVER_ITERATIONS = Number.isFinite(MUJOCO_MIN_SOLVER_ITERATIONS_RAW)
  ? Math.max(40, Math.round(MUJOCO_MIN_SOLVER_ITERATIONS_RAW))
  : 120;
const MUJOCO_MIN_NOSLIP_ITERATIONS = Number.isFinite(MUJOCO_MIN_NOSLIP_ITERATIONS_RAW)
  ? Math.max(0, Math.round(MUJOCO_MIN_NOSLIP_ITERATIONS_RAW))
  : 8;
const MUJOCO_MIN_IMPRATIO = Number.isFinite(MUJOCO_MIN_IMPRATIO_RAW) ? Math.max(1, MUJOCO_MIN_IMPRATIO_RAW) : 5;
const TERRAIN_MESH_VERTEX_LIMIT = Number.isFinite(TERRAIN_MESH_VERTEX_LIMIT_RAW)
  ? Math.max(10000, Math.floor(TERRAIN_MESH_VERTEX_LIMIT_RAW))
  : 600000;
const TERRAIN_MESH_FACE_LIMIT = Number.isFinite(TERRAIN_MESH_FACE_LIMIT_RAW)
  ? Math.max(20000, Math.floor(TERRAIN_MESH_FACE_LIMIT_RAW))
  : 1200000;
const TERRAIN_HEIGHTMAP_GRID = Number.isFinite(TERRAIN_HEIGHTMAP_GRID_RAW)
  ? Math.max(16, Math.min(256, Math.round(TERRAIN_HEIGHTMAP_GRID_RAW)))
  : 96;
const TERRAIN_HEIGHTMAP_MIN_COVERAGE = Number.isFinite(TERRAIN_HEIGHTMAP_MIN_COVERAGE_RAW)
  ? Math.max(0.001, Math.min(0.5, TERRAIN_HEIGHTMAP_MIN_COVERAGE_RAW))
  : 0.02;
const TERRAIN_NAME_RE = /(floor|ground|terrain|rough)/i;
const debugLog = (...args: unknown[]) => {
  if (MUJOCO_DEBUG) console.info("[mujoco][runtime]", ...args);
};

async function getModule() {
  if (!modulePromise) {
    modulePromise = loadMujoco({
      locateFile: (path: string) => new URL(path, import.meta.url).toString(),
    });
  }
  return await modulePromise;
}

function ensureWorkingFs(mujoco: MainModule) {
  const fs = (mujoco as any).FS;
  const exists = fs.analyzePath?.("/working")?.exists;
  if (exists) {
    try {
      fs.unmount("/working");
    } catch {
      // ignore
    }
  }
  if (!fs.analyzePath?.("/working")?.exists) {
    fs.mkdir("/working");
  }
  fs.mount((mujoco as any).MEMFS, { root: "." }, "/working");
}

function tryGetLoadError(mujoco: MainModule, xmlPath: string) {
  const runtime = mujoco as any;
  if (typeof runtime.ccall !== "function" || typeof runtime._malloc !== "function") return null;
  const bufSize = 8192;
  const ptr = runtime._malloc(bufSize);
  if (!ptr) return null;
  try {
    if (runtime.HEAPU8) runtime.HEAPU8.fill(0, ptr, ptr + bufSize);
    const modelPtr = runtime.ccall(
      "mj_loadXML",
      "number",
      ["string", "number", "number", "number"],
      [xmlPath, 0, ptr, bufSize]
    );
    const message = typeof runtime.UTF8ToString === "function" ? runtime.UTF8ToString(ptr) : "";
    if (modelPtr) {
      try {
        runtime.ccall("mj_deleteModel", null, ["number"], [modelPtr]);
      } catch {
        // ignore
      }
    }
    return message || null;
  } catch {
    return null;
  } finally {
    try {
      runtime._free(ptr);
    } catch {
      // ignore
    }
  }
}

function writeFileTree(mujoco: MainModule, files: Record<string, Uint8Array>) {
  const fs = (mujoco as any).FS;
  for (const [key, data] of Object.entries(files)) {
    const path = `/working/${key}`;
    const parts = key.split("/").filter(Boolean);
    let dir = "/working";
    for (let i = 0; i < parts.length - 1; i += 1) {
      dir += `/${parts[i]}`;
      if (!fs.analyzePath(dir).exists) fs.mkdir(dir);
    }
    fs.writeFile(path, data);
  }
}

function writeTextFileUtf8(mujoco: MainModule, path: string, content: string) {
  const text = String(content ?? "");
  const bytes = new TextEncoder().encode(text);
  (mujoco as any).FS.writeFile(path, bytes);
  return bytes.length;
}

function ensureDirForPath(mujoco: MainModule, path: string) {
  const fs = (mujoco as any).FS;
  const parts = path.split("/").filter(Boolean);
  let dir = "";
  for (let i = 0; i < parts.length - 1; i += 1) {
    dir += `/${parts[i]}`;
    if (!fs.analyzePath(dir).exists) fs.mkdir(dir);
  }
}

function getBufferView(buffer: any): Float64Array {
  if (!buffer) return new Float64Array();
  if (buffer instanceof Float64Array) return buffer;
  if (buffer instanceof Float32Array) return buffer as unknown as Float64Array;
  if (typeof buffer.GetView === "function") return buffer.GetView();
  return buffer;
}

function getIntView(buffer: any): Int32Array {
  if (!buffer) return new Int32Array();
  if (buffer instanceof Int32Array) return buffer;
  if (buffer instanceof Uint32Array) return buffer as unknown as Int32Array;
  if (typeof buffer.GetView === "function") return buffer.GetView();
  if (Array.isArray(buffer)) return Int32Array.from(buffer.map((v) => (Number.isFinite(v) ? v : 0)));
  return buffer as Int32Array;
}

function mjtObjValue(raw: any) {
  if (typeof raw === "number") return raw;
  if (raw && typeof raw.value === "number") return raw.value;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

type CollisionMask = { contype: number; conaffinity: number };

function resolveExtraSceneCollisionMask(selfCollisionEnabled: boolean): CollisionMask {
  if (selfCollisionEnabled) {
    return { contype: 1, conaffinity: 1 };
  }
  // Extra scene roots (floor/terrain/props) must collide with:
  // - URDF-converted robots (commonly contype=1, conaffinity=2)
  // - direct MJCF robots (commonly contype=1, conaffinity=1)
  // Using dual-bit masks keeps compatibility across both pipelines.
  return { contype: 3, conaffinity: 3 };
}

function buildGeomContactAttr(solrefRaw: string, solimpRaw: string): string {
  const solref = String(solrefRaw ?? "").trim();
  const solimp = String(solimpRaw ?? "").trim();
  return `${solref ? ` solref="${solref}"` : ""}${solimp ? ` solimp="${solimp}"` : ""}`;
}

function isSceneAssetRoot(root: THREE.Object3D): boolean {
  if (root.userData?.usdSceneAsset === true) return true;
  const source = root.userData?.sceneAssetSource as
    | {
        role?: string;
        workspaceKey?: string | null;
        metadata?: { managedTerrainAssetId?: string | null };
      }
    | undefined;
  const role = String(source?.role ?? "").trim().toLowerCase();
  if (role === "terrain" || role === "scene_asset") return true;
  const managedTerrainAssetId = String(source?.metadata?.managedTerrainAssetId ?? "")
    .trim()
    .toLowerCase();
  if (managedTerrainAssetId === "floor" || managedTerrainAssetId === "floor:rough") return true;
  const workspaceKey = String(source?.workspaceKey ?? root.userData?.usdWorkspaceKey ?? "")
    .trim()
    .toLowerCase();
  return Boolean(workspaceKey && /(terrain|rough|floor|ground)/.test(workspaceKey));
}

function hasTerrainSourceInChain(obj: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = obj;
  while (current) {
    if (isSceneAssetRoot(current)) return true;
    const source = current.userData?.sceneAssetSource as
      | {
          role?: string;
          workspaceKey?: string | null;
          metadata?: { managedTerrainAssetId?: string | null };
        }
      | undefined;
    const role = String(source?.role ?? "").trim().toLowerCase();
    if (role === "terrain") return true;
    const managedTerrainAssetId = String(source?.metadata?.managedTerrainAssetId ?? "")
      .trim()
      .toLowerCase();
    if (managedTerrainAssetId === "floor" || managedTerrainAssetId === "floor:rough") return true;
    const workspaceKey = String(source?.workspaceKey ?? current.userData?.usdWorkspaceKey ?? "")
      .trim()
      .toLowerCase();
    if (workspaceKey && /(terrain|rough|floor|ground)/.test(workspaceKey)) return true;
    current = current.parent;
  }
  return false;
}

function readTerrainSourceInChain(
  obj: THREE.Object3D
): { managedTerrainAssetId: string; workspaceKey: string } | null {
  let current: THREE.Object3D | null = obj;
  while (current) {
    const source = current.userData?.sceneAssetSource as
      | {
          role?: string;
          workspaceKey?: string | null;
          metadata?: { managedTerrainAssetId?: string | null };
        }
      | undefined;
    const managedTerrainAssetId = String(source?.metadata?.managedTerrainAssetId ?? "")
      .trim()
      .toLowerCase();
    const workspaceKey = String(source?.workspaceKey ?? current.userData?.usdWorkspaceKey ?? "")
      .trim()
      .toLowerCase();
    const role = String(source?.role ?? "").trim().toLowerCase();
    if (role === "terrain" || managedTerrainAssetId.length > 0 || workspaceKey.length > 0) {
      return {
        managedTerrainAssetId,
        workspaceKey,
      };
    }
    current = current.parent;
  }
  return null;
}

function isManagedRoughTerrainObject(obj: THREE.Object3D): boolean {
  const source = readTerrainSourceInChain(obj);
  if (source?.managedTerrainAssetId === "floor:rough") return true;
  if (source?.workspaceKey?.includes("rough_terrain") || source?.workspaceKey?.includes("rough_generator")) {
    return true;
  }
  let current: THREE.Object3D | null = obj;
  while (current) {
    const name = String(current.name ?? "")
      .trim()
      .toLowerCase();
    if (name.includes("rough")) return true;
    const docId = String(getDocId(current) ?? "")
      .trim()
      .toLowerCase();
    if (docId.includes("rough")) return true;
    const workspaceHint = String(current.userData?.usdWorkspaceKey ?? "")
      .trim()
      .toLowerCase();
    if (workspaceHint.includes("rough_terrain") || workspaceHint.includes("rough_generator")) return true;
    current = current.parent;
  }
  return false;
}

function isSimplePrimitiveMesh(mesh: THREE.Mesh): boolean {
  const geoType = String((mesh.geometry as { type?: string } | undefined)?.type ?? "");
  return (
    geoType === "BoxGeometry" ||
    geoType === "SphereGeometry" ||
    geoType === "CylinderGeometry" ||
    geoType === "PlaneGeometry"
  );
}

function isTerrainObject(obj: THREE.Object3D): boolean {
  if (hasTerrainSourceInChain(obj)) return true;
  const name = String(obj.name ?? "").trim();
  if (TERRAIN_NAME_RE.test(name)) return true;
  const instance = ensureUserInstance(obj);
  if (instance.physics.fixed === true && instance.physics.mass <= 0 && TERRAIN_NAME_RE.test(String(getDocId(obj)))) {
    return true;
  }
  return false;
}

function maybePromoteTerrainMeshToPlane(
  obj: THREE.Object3D,
  inferred: ReturnType<typeof inferGeomInfo>
): ReturnType<typeof inferGeomInfo> {
  if (inferred.type === "plane") return inferred;
  if (!(obj as any).isMesh) return inferred;
  if (!isTerrainObject(obj)) return inferred;
  if (isManagedRoughTerrainObject(obj)) return inferred;

  obj.updateWorldMatrix(true, false);
  const bounds = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3();
  bounds.getSize(size);
  const dims = [Math.abs(size.x), Math.abs(size.y), Math.abs(size.z)].filter((v) => Number.isFinite(v) && v > 0);
  if (dims.length < 3) return inferred;
  const sorted = dims.slice().sort((a, b) => a - b);
  const thickness = sorted[0] ?? 0;
  const spanA = sorted[1] ?? 0;
  const spanB = sorted[2] ?? 0;
  if (spanA <= 0 || spanB <= 0) return inferred;
  const flatRatio = thickness / Math.max(spanA, spanB);
  if (!Number.isFinite(flatRatio) || flatRatio > 0.08) return inferred;

  const hx = Math.max(0.25, Math.abs(size.x) * 0.5);
  const hy = Math.max(0.25, Math.abs(size.y) * 0.5);
  return {
    type: "plane",
    size: `${hx.toFixed(4)} ${hy.toFixed(4)} 0.1`,
    halfSize: new THREE.Vector3(hx, hy, 0.001),
  };
}

function tightenSolverPrecision(model: MjModel): void {
  const opt = (model as any).opt as Record<string, unknown> | undefined;
  if (!opt) return;
  const changes: Array<{ key: string; value: number }> = [];

  const setMin = (key: string, minValue: number) => {
    if (!Object.prototype.hasOwnProperty.call(opt, key)) return;
    const current = Number(opt[key]);
    if (Number.isFinite(current) && current >= minValue) return;
    (opt as any)[key] = minValue;
    changes.push({ key, value: minValue });
  };

  setMin("iterations", MUJOCO_MIN_SOLVER_ITERATIONS);
  setMin("noslip_iterations", MUJOCO_MIN_NOSLIP_ITERATIONS);
  setMin("impratio", MUJOCO_MIN_IMPRATIO);

  if (changes.length > 0) {
    debugLog("solver precision upgraded", { changes });
  }
}

type TerrainColliderFailureReason =
  | "target_not_buffer_mesh"
  | "primitive_geometry"
  | "invalid_position_attribute"
  | "no_faces"
  | "mesh_limit_exceeded"
  | "no_valid_face_indices"
  | "heightmap_bounds_degenerate"
  | "heightmap_sparse_coverage"
  | "hfield_height_degenerate";

type TerrainAssetBuildResult = {
  reason: TerrainColliderFailureReason | null;
  detail?: Record<string, unknown>;
};

type MeshAssetBuildResult = TerrainAssetBuildResult & {
  meshName: string | null;
};

type HfieldAssetBuildResult = TerrainAssetBuildResult & {
  hfieldName: string | null;
  pos?: THREE.Vector3;
  quat?: THREE.Quaternion;
};

function formatWarningDetail(detail: Record<string, unknown> | undefined): string {
  if (!detail) return "";
  const parts = Object.entries(detail).flatMap(([key, value]) => {
    if (typeof value === "number") {
      if (Number.isFinite(value)) return `${key}=${value}`;
      return [];
    }
    if (typeof value === "string") {
      const token = value.trim();
      if (token.length) return `${key}=${token}`;
      return [];
    }
    if (typeof value === "boolean") {
      return `${key}=${value ? "true" : "false"}`;
    }
    return [];
  });
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function buildTerrainSimplifiedWarning(input: {
  objectLabel: string;
  mode: "mesh" | "primitive";
  hfieldFailure: TerrainAssetBuildResult;
  meshFailure?: TerrainAssetBuildResult;
}): string {
  const base = `[${TERRAIN_COLLISION_SIMPLIFIED_CODE}] '${input.objectLabel}' collision simplified to ${
    input.mode === "mesh" ? "mesh fallback" : "primitive fallback"
  } because hfield collider generation failed (${input.hfieldFailure.reason ?? "unknown"}${formatWarningDetail(
    input.hfieldFailure.detail
  )}).`;
  if (input.mode === "mesh") return base;
  if (!input.meshFailure) return base;
  return `${base} Mesh fallback also failed (${input.meshFailure.reason ?? "unknown"}${formatWarningDetail(
    input.meshFailure.detail
  )}).`;
}

function buildSceneMJCF(roots: THREE.Object3D[], collisionMask?: CollisionMask) {
  type GeomEntry =
    | {
        kind: "primitive";
        info: ReturnType<typeof inferGeomInfo>;
        pos?: THREE.Vector3;
        quat?: THREE.Quaternion;
      }
    | {
        kind: "mesh";
        meshName: string;
      }
    | {
        kind: "hfield";
        hfieldName: string;
        pos?: THREE.Vector3;
        quat?: THREE.Quaternion;
      };

  const bodies: Array<{ name: string; object: THREE.Object3D }> = [];
  const lines: string[] = [];
  const jointActuators: string[] = [];
  const collisionAssetLines: string[] = [];
  const warnings: string[] = [];
  let inlineMeshCounter = 0;
  const safe = (value: number, fallback = 0) => (Number.isFinite(value) ? value : fallback);
  const sceneJointDamping = Number.isFinite(DEFAULT_SCENE_JOINT_DAMPING) ? Math.max(0, DEFAULT_SCENE_JOINT_DAMPING) : 0;
  const sceneJointArmature =
    Number.isFinite(DEFAULT_SCENE_JOINT_ARMATURE) && DEFAULT_SCENE_JOINT_ARMATURE > 0
      ? DEFAULT_SCENE_JOINT_ARMATURE
      : 0;
  const contactAttr = buildGeomContactAttr(DEFAULT_CONTACT_SOLREF, DEFAULT_CONTACT_SOLIMP);
  const terrainContactAttr = buildGeomContactAttr(TERRAIN_CONTACT_SOLREF, TERRAIN_CONTACT_SOLIMP);

  lines.push(`<mujoco model="scene">`);
  lines.push(`  <option gravity="0 0 -9.81" integrator="implicitfast" timestep="0.002" iterations="80" />`);
  lines.push(`  <worldbody>`);

  const tmpPos = new THREE.Vector3();
  const tmpQuat = new THREE.Quaternion();
  const tmpScale = new THREE.Vector3();
  const tmpMat = new THREE.Matrix4();
  const tmpMatInv = new THREE.Matrix4();
  const tmpVertex = new THREE.Vector3();
  const tmpRelative = new THREE.Matrix4();
  const cylinderYToZ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

  const candidates: THREE.Object3D[] = [];
  const linkCandidates: THREE.Object3D[] = [];
  const jointCandidates: THREE.Object3D[] = [];
  const visited = new Set<THREE.Object3D>();

  const hasUsdSceneAssetAncestor = (obj: THREE.Object3D) => {
    let cur: THREE.Object3D | null = obj;
    while (cur) {
      if (isSceneAssetRoot(cur)) return true;
      cur = cur.parent;
    }
    return false;
  };

  const shouldSimulate = (obj: THREE.Object3D) => {
    const isUrdfTagged = (obj as any).isURDFLink || (obj as any).isURDFJoint || (obj as any).isURDFCollider || (obj as any).isURDFVisual;
    if (isUrdfTagged && !hasUsdSceneAssetAncestor(obj)) {
      return false;
    }
    if (obj.userData?.editorRobotRoot) return false;
    if (obj.userData?.editorKind === "joint") return false;
    if (obj.userData?.editorKind === "visual" || obj.userData?.editorKind === "collision") return false;
    if (hasTerrainSourceInChain(obj)) return true;
    if (TERRAIN_NAME_RE.test(String(obj.name ?? ""))) return true;
    const instance = ensureUserInstance(obj);
    return Object.values(instance.fields ?? {}).some(Boolean);
  };

  for (const root of roots) {
    root.traverse((obj) => {
      if (visited.has(obj)) return;
      visited.add(obj);
      if (shouldSimulate(obj)) {
        candidates.push(obj);
        if (obj.userData?.editorKind === "link") linkCandidates.push(obj);
      }
      if (obj.userData?.editorKind === "joint" && !(obj as any).isURDFJoint) {
        jointCandidates.push(obj);
      }
    });
  }

  const hasLinkAncestor = (obj: THREE.Object3D) => {
    let cur = obj.parent;
    while (cur) {
      if (cur.userData?.editorKind === "link") return true;
      cur = cur.parent;
    }
    return false;
  };

  const linkDescendantCache = new WeakMap<THREE.Object3D, boolean>();
  const hasLinkDescendant = (obj: THREE.Object3D) => {
    const cached = linkDescendantCache.get(obj);
    if (cached !== undefined) return cached;
    const stack = [...obj.children];
    while (stack.length > 0) {
      const current = stack.pop() as THREE.Object3D;
      if (current.userData?.editorKind === "link") {
        linkDescendantCache.set(obj, true);
        return true;
      }
      for (let i = current.children.length - 1; i >= 0; i -= 1) {
        stack.push(current.children[i]);
      }
    }
    linkDescendantCache.set(obj, false);
    return false;
  };

  const findCollisionNodes = (root: THREE.Object3D) => {
    const nodes: THREE.Object3D[] = [];
    const stack = [root];
    while (stack.length) {
      const obj = stack.pop() as THREE.Object3D;
      if (obj !== root && obj.userData?.editorKind === "link") continue;
      if (obj.userData?.editorKind === "collision") nodes.push(obj);
      for (let i = obj.children.length - 1; i >= 0; i -= 1) {
        stack.push(obj.children[i]);
      }
    }
    return nodes;
  };

  const findMeshLikes = (root: THREE.Object3D) => {
    const meshes: THREE.Object3D[] = [];
    root.traverse((obj) => {
      if ((obj as any).isMesh) meshes.push(obj);
    });
    return meshes;
  };

  const findVisualMeshesForLink = (linkObj: THREE.Object3D) => {
    const meshes: THREE.Object3D[] = [];
    const stack = [linkObj];
    while (stack.length) {
      const obj = stack.pop() as THREE.Object3D;
      if (obj !== linkObj && obj.userData?.editorKind === "link") continue;
      if (obj.userData?.editorKind === "collision") continue;

      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        let cur = obj.parent;
        let insideVisual = false;
        let insideCollision = false;
        while (cur && cur !== linkObj) {
          const kind = cur.userData?.editorKind;
          if (kind === "collision") {
            insideCollision = true;
            break;
          }
          if (kind === "visual") {
            insideVisual = true;
            break;
          }
          cur = cur.parent;
        }
        if (insideVisual && !insideCollision) {
          meshes.push(obj);
        }
      }

      for (let i = obj.children.length - 1; i >= 0; i -= 1) {
        stack.push(obj.children[i]);
      }
    }
    return meshes;
  };

  const getMeshVertexCount = (target: THREE.Object3D) => {
    const mesh = target as THREE.Mesh;
    if (!mesh.isMesh || !(mesh.geometry instanceof THREE.BufferGeometry)) return -1;
    const positionAttr = mesh.geometry.getAttribute("position");
    return positionAttr && typeof positionAttr.count === "number" && Number.isFinite(positionAttr.count)
      ? positionAttr.count
      : 0;
  };

  const pickDominantMeshTarget = (targets: THREE.Object3D[]): THREE.Object3D | null => {
    let best: THREE.Object3D | null = null;
    let bestNonPrimitive = -1;
    let bestVertexCount = -1;
    for (const target of targets) {
      const mesh = target as THREE.Mesh;
      if (!mesh.isMesh || !(mesh.geometry instanceof THREE.BufferGeometry)) continue;
      const vertexCount = getMeshVertexCount(target);
      const nonPrimitive = isSimplePrimitiveMesh(mesh) ? 0 : 1;
      if (
        nonPrimitive > bestNonPrimitive ||
        (nonPrimitive === bestNonPrimitive && vertexCount > bestVertexCount)
      ) {
        best = target;
        bestNonPrimitive = nonPrimitive;
        bestVertexCount = vertexCount;
      }
    }
    return best;
  };

  const findDominantMeshTarget = (root: THREE.Object3D): THREE.Object3D | null => {
    const meshTargets: THREE.Object3D[] = [];
    root.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) meshTargets.push(obj);
    });
    return pickDominantMeshTarget(meshTargets);
  };

  const resolveRelativeTransform = (body: THREE.Object3D, target: THREE.Object3D) => {
    body.updateWorldMatrix(true, false);
    target.updateWorldMatrix(true, false);
    tmpMatInv.copy(body.matrixWorld).invert();
    tmpMat.copy(tmpMatInv).multiply(target.matrixWorld);
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    tmpMat.decompose(pos, quat, tmpScale);
    return { pos, quat };
  };

  const buildInlineMeshAsset = (bodyObj: THREE.Object3D, targetObj: THREE.Object3D): MeshAssetBuildResult => {
    const mesh = targetObj as THREE.Mesh;
    if (!mesh.isMesh || !(mesh.geometry instanceof THREE.BufferGeometry)) {
      debugLog("inline terrain mesh collision skipped: target is not BufferGeometry mesh", {
        meshName: targetObj.name,
      });
      return {
        meshName: null,
        reason: "target_not_buffer_mesh",
      };
    }
    if (isSimplePrimitiveMesh(mesh)) {
      const geometryType = (mesh.geometry as { type?: string } | undefined)?.type ?? "unknown";
      debugLog("inline terrain mesh collision skipped: primitive geometry", {
        meshName: targetObj.name,
        geometryType,
      });
      return {
        meshName: null,
        reason: "primitive_geometry",
        detail: { geometryType },
      };
    }
    const geometry = mesh.geometry;
    const positionAttr = geometry.getAttribute("position");
    if (
      !positionAttr ||
      typeof (positionAttr as THREE.BufferAttribute).getX !== "function" ||
      typeof (positionAttr as THREE.BufferAttribute).getY !== "function" ||
      typeof (positionAttr as THREE.BufferAttribute).getZ !== "function" ||
      positionAttr.itemSize < 3 ||
      positionAttr.count < 3
    ) {
      debugLog("inline terrain mesh collision skipped: invalid position attribute", {
        meshName: targetObj.name,
        itemSize: (positionAttr as { itemSize?: number } | null)?.itemSize ?? null,
        count: (positionAttr as { count?: number } | null)?.count ?? null,
      });
      return {
        meshName: null,
        reason: "invalid_position_attribute",
        detail: {
          itemSize: (positionAttr as { itemSize?: number } | null)?.itemSize ?? null,
          count: (positionAttr as { count?: number } | null)?.count ?? null,
        },
      };
    }
    const positionReader = positionAttr as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;

    const indexAttr = geometry.getIndex();
    const indexedFaceCount = indexAttr ? Math.floor(indexAttr.count / 3) : 0;
    const nonIndexedFaceCount = Math.floor(positionAttr.count / 3);
    const faceCount = indexAttr ? indexedFaceCount : nonIndexedFaceCount;
    if (faceCount <= 0) {
      debugLog("inline terrain mesh collision skipped: no faces", {
        meshName: targetObj.name,
      });
      return {
        meshName: null,
        reason: "no_faces",
      };
    }

    const vertexCount = positionAttr.count;
    const indexCount = indexAttr?.count ?? 0;
    if (vertexCount > TERRAIN_MESH_VERTEX_LIMIT || faceCount > TERRAIN_MESH_FACE_LIMIT) {
      debugLog("inline terrain mesh collision skipped due size", {
        meshName: targetObj.name,
        vertexCount,
        faceCount,
        vertexLimit: TERRAIN_MESH_VERTEX_LIMIT,
        faceLimit: TERRAIN_MESH_FACE_LIMIT,
      });
      return {
        meshName: null,
        reason: "mesh_limit_exceeded",
        detail: {
          vertexCount,
          faceCount,
          vertexLimit: TERRAIN_MESH_VERTEX_LIMIT,
          faceLimit: TERRAIN_MESH_FACE_LIMIT,
        },
      };
    }
    bodyObj.updateWorldMatrix(true, false);
    targetObj.updateWorldMatrix(true, false);
    tmpMatInv.copy(bodyObj.matrixWorld).invert();
    tmpRelative.copy(tmpMatInv).multiply(targetObj.matrixWorld);

    const vertexValues: string[] = [];
    vertexValues.length = vertexCount * 3;
    let vertexOffset = 0;
    for (let i = 0; i < vertexCount; i += 1) {
      tmpVertex
        .set(positionReader.getX(i), positionReader.getY(i), positionReader.getZ(i))
        .applyMatrix4(tmpRelative);
      vertexValues[vertexOffset] = safe(tmpVertex.x).toFixed(6);
      vertexValues[vertexOffset + 1] = safe(tmpVertex.y).toFixed(6);
      vertexValues[vertexOffset + 2] = safe(tmpVertex.z).toFixed(6);
      vertexOffset += 3;
    }

    const faceValues: string[] = [];
    if (indexAttr) {
      for (let i = 0; i + 2 < indexCount; i += 3) {
        const a = indexAttr.getX(i);
        const b = indexAttr.getX(i + 1);
        const c = indexAttr.getX(i + 2);
        if (a < 0 || b < 0 || c < 0 || a >= vertexCount || b >= vertexCount || c >= vertexCount) continue;
        faceValues.push(`${a}`, `${b}`, `${c}`);
      }
    } else {
      for (let i = 0; i + 2 < vertexCount; i += 3) {
        faceValues.push(`${i}`, `${i + 1}`, `${i + 2}`);
      }
    }
    if (faceValues.length === 0) {
      debugLog("inline terrain mesh collision skipped: no valid face indices", {
        meshName: targetObj.name,
        vertexCount,
        indexCount,
      });
      return {
        meshName: null,
        reason: "no_valid_face_indices",
        detail: {
          vertexCount,
          indexCount,
        },
      };
    }

    inlineMeshCounter += 1;
    const meshName = sanitizeMjcfName(`${getDocId(targetObj)}_terrain_mesh_${inlineMeshCounter}`, "mesh");
    collisionAssetLines.push(`    <mesh name="${meshName}" vertex="${vertexValues.join(" ")}" face="${faceValues.join(" ")}" />`);
    debugLog("inline terrain mesh collision emitted", {
      meshName: targetObj.name,
      mjcfMeshName: meshName,
      vertexCount,
      faceCount: Math.floor(faceValues.length / 3),
    });
    return {
      meshName,
      reason: null,
      detail: {
        vertexCount,
        faceCount: Math.floor(faceValues.length / 3),
      },
    };
  };

  const fillSparseHeightGrid = (heights: Float64Array, rows: number, cols: number, fallbackHeight: number) => {
    for (let row = 0; row < rows; row += 1) {
      let last = Number.NaN;
      for (let col = 0; col < cols; col += 1) {
        const idx = row * cols + col;
        if (Number.isFinite(heights[idx])) {
          last = heights[idx];
        } else if (Number.isFinite(last)) {
          heights[idx] = last;
        }
      }
      last = Number.NaN;
      for (let col = cols - 1; col >= 0; col -= 1) {
        const idx = row * cols + col;
        if (Number.isFinite(heights[idx])) {
          last = heights[idx];
        } else if (Number.isFinite(last)) {
          heights[idx] = last;
        }
      }
    }
    for (let col = 0; col < cols; col += 1) {
      let last = Number.NaN;
      for (let row = 0; row < rows; row += 1) {
        const idx = row * cols + col;
        if (Number.isFinite(heights[idx])) {
          last = heights[idx];
        } else if (Number.isFinite(last)) {
          heights[idx] = last;
        }
      }
      last = Number.NaN;
      for (let row = rows - 1; row >= 0; row -= 1) {
        const idx = row * cols + col;
        if (Number.isFinite(heights[idx])) {
          last = heights[idx];
        } else if (Number.isFinite(last)) {
          heights[idx] = last;
        }
      }
    }
    for (let i = 0; i < heights.length; i += 1) {
      if (!Number.isFinite(heights[i])) heights[i] = fallbackHeight;
    }
  };

  const buildHeightfieldAsset = (bodyObj: THREE.Object3D, targetObj: THREE.Object3D): HfieldAssetBuildResult => {
    const mesh = targetObj as THREE.Mesh;
    if (!mesh.isMesh || !(mesh.geometry instanceof THREE.BufferGeometry)) {
      return {
        hfieldName: null,
        reason: "target_not_buffer_mesh",
      };
    }
    if (isSimplePrimitiveMesh(mesh)) {
      const geometryType = (mesh.geometry as { type?: string } | undefined)?.type ?? "unknown";
      return {
        hfieldName: null,
        reason: "primitive_geometry",
        detail: { geometryType },
      };
    }
    const geometry = mesh.geometry;
    const positionAttr = geometry.getAttribute("position");
    if (
      !positionAttr ||
      typeof (positionAttr as THREE.BufferAttribute).getX !== "function" ||
      typeof (positionAttr as THREE.BufferAttribute).getY !== "function" ||
      typeof (positionAttr as THREE.BufferAttribute).getZ !== "function" ||
      positionAttr.itemSize < 3 ||
      positionAttr.count < 3
    ) {
      return {
        hfieldName: null,
        reason: "invalid_position_attribute",
        detail: {
          itemSize: (positionAttr as { itemSize?: number } | null)?.itemSize ?? null,
          count: (positionAttr as { count?: number } | null)?.count ?? null,
        },
      };
    }
    const indexAttr = geometry.getIndex();
    const indexedFaceCount = indexAttr ? Math.floor(indexAttr.count / 3) : 0;
    const nonIndexedFaceCount = Math.floor(positionAttr.count / 3);
    const faceCount = indexAttr ? indexedFaceCount : nonIndexedFaceCount;
    if (faceCount <= 0) {
      return {
        hfieldName: null,
        reason: "no_faces",
      };
    }

    bodyObj.updateWorldMatrix(true, false);
    targetObj.updateWorldMatrix(true, false);
    tmpMatInv.copy(bodyObj.matrixWorld).invert();
    tmpRelative.copy(tmpMatInv).multiply(targetObj.matrixWorld);

    const positionReader = positionAttr as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    const vertexCount = positionReader.count;
    const transformed = new Float64Array(vertexCount * 3);
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;

    let cursor = 0;
    for (let i = 0; i < vertexCount; i += 1) {
      tmpVertex
        .set(positionReader.getX(i), positionReader.getY(i), positionReader.getZ(i))
        .applyMatrix4(tmpRelative);
      const x = safe(tmpVertex.x);
      const y = safe(tmpVertex.y);
      const z = safe(tmpVertex.z);
      transformed[cursor] = x;
      transformed[cursor + 1] = y;
      transformed[cursor + 2] = z;
      cursor += 3;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
    }

    const spanX = maxX - minX;
    const spanY = maxY - minY;
    if (!Number.isFinite(spanX) || !Number.isFinite(spanY) || spanX <= 1e-6 || spanY <= 1e-6) {
      return {
        hfieldName: null,
        reason: "heightmap_bounds_degenerate",
        detail: {
          spanX: Number.isFinite(spanX) ? spanX : 0,
          spanY: Number.isFinite(spanY) ? spanY : 0,
        },
      };
    }

    const cols = TERRAIN_HEIGHTMAP_GRID;
    const rows = TERRAIN_HEIGHTMAP_GRID;
    const cellCount = cols * rows;
    const heights = new Float64Array(cellCount);
    heights.fill(Number.NEGATIVE_INFINITY);

    for (let i = 0; i < vertexCount; i += 1) {
      const base = i * 3;
      const x = transformed[base];
      const y = transformed[base + 1];
      const z = transformed[base + 2];
      const u = Math.max(0, Math.min(1, (x - minX) / spanX));
      const v = Math.max(0, Math.min(1, (y - minY) / spanY));
      const col = Math.max(0, Math.min(cols - 1, Math.round(u * (cols - 1))));
      const row = Math.max(0, Math.min(rows - 1, Math.round(v * (rows - 1))));
      const index = row * cols + col;
      if (!Number.isFinite(heights[index]) || z > heights[index]) {
        heights[index] = z;
      }
    }

    let covered = 0;
    for (let i = 0; i < cellCount; i += 1) {
      if (Number.isFinite(heights[i])) covered += 1;
    }
    const coverage = covered / Math.max(1, cellCount);
    if (!Number.isFinite(coverage) || coverage < TERRAIN_HEIGHTMAP_MIN_COVERAGE) {
      return {
        hfieldName: null,
        reason: "heightmap_sparse_coverage",
        detail: {
          coverage: Number.isFinite(coverage) ? Number(coverage.toFixed(4)) : 0,
          minCoverage: TERRAIN_HEIGHTMAP_MIN_COVERAGE,
        },
      };
    }

    const fallbackHeight = Number.isFinite(minZ) ? minZ : 0;
    fillSparseHeightGrid(heights, rows, cols, fallbackHeight);

    let minHeight = Number.POSITIVE_INFINITY;
    let maxHeight = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < cellCount; i += 1) {
      const value = heights[i] as number;
      if (value < minHeight) minHeight = value;
      if (value > maxHeight) maxHeight = value;
    }
    const heightSpan = maxHeight - minHeight;
    if (!Number.isFinite(heightSpan) || heightSpan <= 1e-6) {
      return {
        hfieldName: null,
        reason: "hfield_height_degenerate",
        detail: {
          minHeight: Number.isFinite(minHeight) ? Number(minHeight.toFixed(6)) : 0,
          maxHeight: Number.isFinite(maxHeight) ? Number(maxHeight.toFixed(6)) : 0,
        },
      };
    }

    const radiusX = Math.max(0.001, spanX * 0.5);
    const radiusY = Math.max(0.001, spanY * 0.5);
    const heightScale = Math.max(0.001, heightSpan);
    const baseDepth = Math.max(0.05, Math.min(2, heightScale * 0.25));
    const invHeightSpan = 1 / heightSpan;
    const elevationValues: string[] = [];
    elevationValues.length = cellCount;
    for (let i = 0; i < cellCount; i += 1) {
      const normalized = Math.max(0, Math.min(1, (heights[i] - minHeight) * invHeightSpan));
      elevationValues[i] = safe(normalized).toFixed(6);
    }

    inlineMeshCounter += 1;
    const hfieldName = sanitizeMjcfName(`${getDocId(targetObj)}_terrain_hfield_${inlineMeshCounter}`, "hfield");
    collisionAssetLines.push(
      `    <hfield name="${hfieldName}" nrow="${rows}" ncol="${cols}" size="${radiusX.toFixed(6)} ${radiusY.toFixed(6)} ${heightScale.toFixed(6)} ${baseDepth.toFixed(6)}" elevation="${elevationValues.join(" ")}" />`
    );
    debugLog("terrain hfield collision emitted", {
      meshName: targetObj.name,
      hfieldName,
      sourceVertexCount: vertexCount,
      gridRows: rows,
      gridCols: cols,
      coverage: Number(coverage.toFixed(4)),
      radiusX,
      radiusY,
      heightScale,
      baseDepth,
    });
    return {
      hfieldName,
      pos: new THREE.Vector3(minX + spanX * 0.5, minY + spanY * 0.5, minHeight),
      reason: null,
      detail: {
        sourceVertexCount: vertexCount,
        gridRows: rows,
        gridCols: cols,
        coverage: Number(coverage.toFixed(4)),
        radiusX: Number(radiusX.toFixed(6)),
        radiusY: Number(radiusY.toFixed(6)),
        heightScale: Number(heightScale.toFixed(6)),
        baseDepth: Number(baseDepth.toFixed(6)),
      },
    };
  };

  const resolveManagedRoughTerrainEntry = (
    bodyObj: THREE.Object3D,
    geomTarget: THREE.Object3D
  ): { entry: GeomEntry; warning?: string } => {
    const hfield = buildHeightfieldAsset(bodyObj, geomTarget);
    if (hfield.hfieldName) {
      return {
        entry: {
          kind: "hfield",
          hfieldName: hfield.hfieldName,
          pos: hfield.pos,
          quat: hfield.quat,
        },
      };
    }

    const fullMesh = buildInlineMeshAsset(bodyObj, geomTarget);
    if (fullMesh.meshName) {
      return {
        entry: { kind: "mesh", meshName: fullMesh.meshName },
        warning: buildTerrainSimplifiedWarning({
          objectLabel: geomTarget.name || getDocId(geomTarget),
          mode: "mesh",
          hfieldFailure: hfield,
        }),
      };
    }

    const inferred = inferGeomInfo(geomTarget);
    const info = maybePromoteTerrainMeshToPlane(geomTarget, inferred);
    const relative = resolveRelativeTransform(bodyObj, geomTarget);
    return {
      entry: { kind: "primitive", info, pos: relative.pos, quat: relative.quat },
      warning: buildTerrainSimplifiedWarning({
        objectLabel: geomTarget.name || getDocId(geomTarget),
        mode: "primitive",
        hfieldFailure: hfield,
        meshFailure: fullMesh,
      }),
    };
  };

  const linkSet = new Set(linkCandidates);

  const resolveLinkName = (linkObj: THREE.Object3D) => {
    const urdf = linkObj.userData?.urdf as { kind?: string; link?: { name?: string } } | undefined;
    if (urdf?.kind === "link" && urdf.link?.name) return urdf.link.name;
    return linkObj.name || getDocId(linkObj);
  };

  const linkByName = new Map<string, THREE.Object3D>();
  for (const link of linkCandidates) {
    const name = resolveLinkName(link);
    if (!linkByName.has(name)) linkByName.set(name, link);
  }

  const linkInfo = new Map<
    THREE.Object3D,
    { parent: THREE.Object3D | null; joint: THREE.Object3D | null }
  >();
  const linkChildren = new Map<THREE.Object3D, THREE.Object3D[]>();

  for (const joint of jointCandidates) {
    const urdf = joint.userData?.urdf as { kind?: string; joint?: { parent?: string; child?: string } } | undefined;
    if (urdf?.kind !== "joint") continue;
    const parentName = urdf.joint?.parent ?? "";
    const childName = urdf.joint?.child ?? "";
    if (!parentName || !childName) continue;
    const parentLink = linkByName.get(parentName);
    const childLink = linkByName.get(childName);
    if (!parentLink || !childLink) continue;
    if (linkInfo.has(childLink)) continue;
    linkInfo.set(childLink, { parent: parentLink, joint });
    const list = linkChildren.get(parentLink) ?? [];
    list.push(childLink);
    linkChildren.set(parentLink, list);
  }

  for (const link of linkCandidates) {
    if (!linkInfo.has(link)) {
      linkInfo.set(link, { parent: null, joint: null });
    }
  }

  const rootLinks = linkCandidates.filter((link) => !(linkInfo.get(link)?.parent));
  const otherCandidates = candidates.filter((obj) => {
    if (linkSet.has(obj)) return false;
    if (hasLinkAncestor(obj)) return false;
    // Structural USD scene containers (for example terrain roots) may wrap link bodies.
    // Simulating those containers duplicates collision geometry at world origin.
    if (hasLinkDescendant(obj)) return false;
    return true;
  });

  const normalizeAxis = (axis: [number, number, number]) => {
    const vec = new THREE.Vector3(axis[0], axis[1], axis[2]);
    if (!Number.isFinite(vec.x) || !Number.isFinite(vec.y) || !Number.isFinite(vec.z)) {
      return new THREE.Vector3(1, 0, 0);
    }
    if (vec.lengthSq() < 1e-8) return new THREE.Vector3(1, 0, 0);
    return vec.normalize();
  };

  const resolveRobotId = (obj: THREE.Object3D) => {
    let cur: THREE.Object3D | null = obj;
    while (cur) {
      if (cur.userData?.editorRobotRoot) return getDocId(cur);
      cur = cur.parent;
    }
    return null;
  };

  const resolveJointName = (jointObj: THREE.Object3D, jointName: string) => {
    const robotId = resolveRobotId(jointObj);
    if (robotId) {
      return {
        name: `${sanitizeMjcfName(robotId)}_${sanitizeMjcfName(jointName)}`,
        robotId,
      };
    }
    return { name: sanitizeMjcfName(jointName, "joint"), robotId: null };
  };

  const buildGeomEntriesForLink = (linkObj: THREE.Object3D, terrainLike: boolean) => {
    const collisionNodes = findCollisionNodes(linkObj);
    const geomEntries: GeomEntry[] = [];
    const managedRoughTerrainLink = terrainLike && isManagedRoughTerrainObject(linkObj);
    const appendEntry = (geomTarget: THREE.Object3D) => {
      const managedRoughTerrain = terrainLike && isManagedRoughTerrainObject(geomTarget);
      if (managedRoughTerrain) {
        const resolved = resolveManagedRoughTerrainEntry(linkObj, geomTarget);
        geomEntries.push(resolved.entry);
        if (resolved.warning) warnings.push(resolved.warning);
        return;
      }
      const inferred = inferGeomInfo(geomTarget);
      const info = terrainLike ? maybePromoteTerrainMeshToPlane(geomTarget, inferred) : inferred;
      const { pos, quat } = resolveRelativeTransform(linkObj, geomTarget);
      geomEntries.push({ kind: "primitive", info, pos, quat });
    };

    const collisionTargets: THREE.Object3D[] = [];
    for (const collisionNode of collisionNodes) {
      const geomTargets = findMeshLikes(collisionNode);
      for (const geomTarget of geomTargets) {
        collisionTargets.push(geomTarget);
      }
    }

    if (managedRoughTerrainLink) {
      const visualTargets = findVisualMeshesForLink(linkObj);
      const primaryTarget = pickDominantMeshTarget([...collisionTargets, ...visualTargets]);
      if (primaryTarget) appendEntry(primaryTarget);
      return geomEntries;
    }

    for (const geomTarget of collisionTargets) {
      appendEntry(geomTarget);
    }

    // If collision nodes exist but do not have real geometry children,
    // fall back to visual meshes so the link keeps a meaningful collider.
    if (!geomEntries.length) {
      const visualTargets = findVisualMeshesForLink(linkObj);
      for (const geomTarget of visualTargets) {
        appendEntry(geomTarget);
      }
    }

    return geomEntries;
  };

  const appendBodyHeader = (
    pad: string,
    bodyName: string,
    pos: THREE.Vector3,
    quat: THREE.Quaternion
  ) => {
    const posAttr = `${safe(pos.x).toFixed(4)} ${safe(pos.y).toFixed(4)} ${safe(pos.z).toFixed(4)}`;
    const quatAttr = `${safe(quat.w, 1).toFixed(6)} ${safe(quat.x).toFixed(6)} ${safe(quat.y).toFixed(6)} ${safe(quat.z).toFixed(6)}`;
    lines.push(`${pad}<body name="${bodyName}" pos="${posAttr}" quat="${quatAttr}">`);
  };

  const appendGeomLines = (
    pad: string,
    bodyName: string,
    entries: GeomEntry[],
    frictionAttr: string,
    collisionAttr: string
  ) => {
    entries.forEach((entry, index) => {
      const geomName = entries.length === 1 ? `${bodyName}_geom` : `${bodyName}_geom_${index + 1}`;
      if (entry.kind === "mesh") {
        lines.push(
          `${pad}<geom name="${geomName}" type="mesh" mesh="${entry.meshName}"${frictionAttr}${collisionAttr} />`
        );
        return;
      }
      if (entry.kind === "hfield") {
        const posAttr = entry.pos
          ? ` pos="${safe(entry.pos.x).toFixed(4)} ${safe(entry.pos.y).toFixed(4)} ${safe(entry.pos.z).toFixed(4)}"`
          : "";
        const quatAttr = entry.quat
          ? ` quat="${safe(entry.quat.w, 1).toFixed(6)} ${safe(entry.quat.x).toFixed(6)} ${safe(entry.quat.y).toFixed(6)} ${safe(entry.quat.z).toFixed(6)}"`
          : "";
        lines.push(
          `${pad}<geom name="${geomName}" type="hfield" hfield="${entry.hfieldName}"${posAttr}${quatAttr}${frictionAttr}${collisionAttr} />`
        );
        return;
      }
      const posAttr = entry.pos
        ? ` pos="${safe(entry.pos.x).toFixed(4)} ${safe(entry.pos.y).toFixed(4)} ${safe(entry.pos.z).toFixed(4)}"`
        : "";
      // MuJoCo cylinders are aligned to local +Z, while Three.js CylinderGeometry is +Y.
      // Rotate inferred editor cylinders so physical collision matches the rendered mesh.
      const quatForGeom = (() => {
        if (entry.info.type !== "cylinder" || entry.info.axis !== "y") return entry.quat ?? null;
        const base = entry.quat ? entry.quat.clone() : new THREE.Quaternion();
        return base.multiply(cylinderYToZ);
      })();
      const quatAttr = quatForGeom
        ? ` quat="${safe(quatForGeom.w, 1).toFixed(6)} ${safe(quatForGeom.x).toFixed(6)} ${safe(quatForGeom.y).toFixed(6)} ${safe(quatForGeom.z).toFixed(6)}"`
        : "";
      lines.push(
        `${pad}<geom name="${geomName}" type="${entry.info.type}" size="${entry.info.size}"${posAttr}${quatAttr}${frictionAttr}${collisionAttr} />`
      );
    });
  };

  const appendInertialLine = (pad: string, physics: InstancePhysics, mass: number, computed?: { x: number; y: number; z: number } | null) => {
    if (mass <= 0) return;
    const inertia = physics.inertia;
    const inertialSource = isValidInertia(inertia) ? inertia : computed ?? inertia;
    const inertiaVals = [
      Math.max(1e-6, safe(inertialSource?.x ?? 0, 0)),
      Math.max(1e-6, safe(inertialSource?.y ?? 0, 0)),
      Math.max(1e-6, safe(inertialSource?.z ?? 0, 0)),
    ];
    const tensor = physics.inertiaTensor;
    const hasOffDiag =
      !!tensor && (Math.abs(tensor.ixy) > 0 || Math.abs(tensor.ixz) > 0 || Math.abs(tensor.iyz) > 0);
    const inertialAttr =
      hasOffDiag && tensor
        ? `fullinertia="${tensor.ixx.toFixed(6)} ${tensor.iyy.toFixed(6)} ${tensor.izz.toFixed(6)} ${tensor.ixy.toFixed(6)} ${tensor.ixz.toFixed(6)} ${tensor.iyz.toFixed(6)}"`
        : `diaginertia="${inertiaVals.map((v) => v.toFixed(6)).join(" ")}"`;
    const com = physics.com ?? { x: 0, y: 0, z: 0 };
    const comAttr = `${safe(com.x).toFixed(4)} ${safe(com.y).toFixed(4)} ${safe(com.z).toFixed(4)}`;
    lines.push(`${pad}<inertial pos="${comAttr}" mass="${mass.toFixed(4)}" ${inertialAttr} />`);
  };

  const buildLinkBody = (linkObj: THREE.Object3D, indent: number) => {
    const pad = " ".repeat(indent);
    const padInner = " ".repeat(indent + 2);
    const info = linkInfo.get(linkObj);
    const parent = info?.parent ?? null;
    const jointObj = info?.joint ?? null;

    let bodyPos = new THREE.Vector3();
    let bodyQuat = new THREE.Quaternion();
    if (parent) {
      const rel = resolveRelativeTransform(parent, linkObj);
      bodyPos = rel.pos;
      bodyQuat = rel.quat;
    } else {
      linkObj.updateWorldMatrix(true, false);
      linkObj.getWorldPosition(tmpPos);
      linkObj.getWorldQuaternion(tmpQuat);
      bodyPos = tmpPos.clone();
      bodyQuat = tmpQuat.clone();
    }

    const instance = ensureUserInstance(linkObj);
    const physics = instance.physics;
    const terrainLike = isTerrainObject(linkObj);
    const geomEntries = buildGeomEntriesForLink(linkObj, terrainLike);
    const geomInfo =
      geomEntries.find((entry): entry is Extract<GeomEntry, { kind: "primitive" }> => entry.kind === "primitive")
        ?.info ?? null;
    const rawMass = safe(physics.mass, 0);
    const mass = physics.fixed ? 0 : Math.max(0, rawMass);
    const safeMass = mass < 1e-4 ? 0 : mass;
    const friction = Math.max(0, safe(physics.friction, terrainLike ? 1 : 0.5));
    const collisionsEnabled = physics.collisionsEnabled !== false && geomEntries.length > 0;
    const bodyName = sanitizeMjcfName(getDocId(linkObj), "body");
    bodies.push({ name: bodyName, object: linkObj });

    appendBodyHeader(pad, bodyName, bodyPos, bodyQuat);

    if (!parent && safeMass > 0) {
      lines.push(`${padInner}<freejoint />`);
    }

    if (jointObj) {
      const urdf = jointObj.userData?.urdf as { kind?: string; joint?: any } | undefined;
      const joint = urdf?.kind === "joint" ? urdf.joint : null;
      if (joint) {
        if (joint.type === "floating") {
          lines.push(`${padInner}<freejoint />`);
        } else if (joint.type !== "fixed") {
          const { name: jointName, robotId } = resolveJointName(jointObj, joint.name ?? jointObj.name ?? "joint");
          let type = "hinge";
          if (joint.type === "prismatic" || joint.type === "planar") type = "slide";
          const axis = normalizeAxis(joint.axis ?? [1, 0, 0]);
          const jointRel = resolveRelativeTransform(linkObj, jointObj);
          const axisInBody = axis.clone().applyQuaternion(jointRel.quat.clone().invert());
          const axisAttr = `${safe(axisInBody.x).toFixed(6)} ${safe(axisInBody.y).toFixed(6)} ${safe(axisInBody.z).toFixed(6)}`;
          const posAttr = `${safe(jointRel.pos.x).toFixed(4)} ${safe(jointRel.pos.y).toFixed(4)} ${safe(jointRel.pos.z).toFixed(4)}`;
          const attrs: string[] = [
            `name="${jointName}"`,
            `type="${type}"`,
            `axis="${axisAttr}"`,
            `pos="${posAttr}"`,
          ];
          if (joint.limit && joint.type !== "continuous") {
            const lower = joint.limit.lower;
            const upper = joint.limit.upper;
            if (Number.isFinite(lower) && Number.isFinite(upper)) {
              attrs.push(`limited="true"`);
              attrs.push(`range="${Number(lower).toFixed(6)} ${Number(upper).toFixed(6)}"`);
            }
          }
          if (joint.dynamics?.damping !== undefined) {
            attrs.push(`damping="${Number(joint.dynamics.damping).toFixed(6)}"`);
          } else if (sceneJointDamping > 0) {
            attrs.push(`damping="${sceneJointDamping.toFixed(6)}"`);
          }
          if (joint.dynamics?.friction !== undefined) {
            attrs.push(`frictionloss="${Number(joint.dynamics.friction).toFixed(6)}"`);
          }
          if (joint.dynamics?.armature !== undefined) {
            attrs.push(`armature="${Number(joint.dynamics.armature).toFixed(6)}"`);
          } else if (sceneJointArmature > 0) {
            attrs.push(`armature="${sceneJointArmature.toFixed(6)}"`);
          }
          lines.push(`${padInner}<joint ${attrs.join(" ")} />`);

          if (robotId && joint.actuator?.enabled !== false) {
            jointActuators.push(`    <motor name="${jointName}_motor" joint="${jointName}" gear="1" />`);
          }
        }
      }
    }

    const frictionAttr = terrainLike
      ? ` friction="${friction.toFixed(4)} ${TERRAIN_TORSIONAL_FRICTION.toFixed(6)} ${TERRAIN_ROLLING_FRICTION.toFixed(6)}"${terrainContactAttr}`
      : ` friction="${friction.toFixed(4)} 0.005 0.0001"${contactAttr}`;
    const collisionAttr = collisionsEnabled
      ? collisionMask
        ? ` contype="${collisionMask.contype}" conaffinity="${collisionMask.conaffinity}"`
        : ""
      : ` contype="0" conaffinity="0"`;

    const inertiaGeom =
      geomInfo && geomInfo.type === "cylinder" && geomInfo.axis === "y" ? { ...geomInfo, axis: "z" as const } : geomInfo;
    const computedInertia = inertiaGeom ? computeInertiaFromGeom(inertiaGeom, safeMass) : null;
    appendInertialLine(padInner, physics, safeMass, computedInertia);

    if (geomEntries.length) {
      appendGeomLines(padInner, bodyName, geomEntries, frictionAttr, collisionAttr);
    }

    const children = linkChildren.get(linkObj) ?? [];
    for (const child of children) {
      buildLinkBody(child, indent + 2);
    }

    lines.push(`${pad}</body>`);
  };

  const buildSimpleBody = (obj: THREE.Object3D) => {
    obj.updateWorldMatrix(true, false);
    obj.getWorldPosition(tmpPos);
    obj.getWorldQuaternion(tmpQuat);

    const instance = ensureUserInstance(obj);
    const physics = instance.physics;
    const terrainLike = isTerrainObject(obj);
    const managedRoughTerrain = terrainLike && isManagedRoughTerrainObject(obj);
    const primaryGeomTarget = managedRoughTerrain ? findDominantMeshTarget(obj) ?? obj : obj;
    const geomEntries: GeomEntry[] = [];
    if (managedRoughTerrain) {
      const resolved = resolveManagedRoughTerrainEntry(obj, primaryGeomTarget);
      geomEntries.push(resolved.entry);
      if (resolved.warning) warnings.push(resolved.warning);
    } else {
      const inferred = inferGeomInfo(primaryGeomTarget);
      const geomInfo = terrainLike ? maybePromoteTerrainMeshToPlane(primaryGeomTarget, inferred) : inferred;
      const relative = primaryGeomTarget !== obj ? resolveRelativeTransform(obj, primaryGeomTarget) : null;
      geomEntries.push({
        kind: "primitive",
        info: geomInfo,
        pos: relative?.pos,
        quat: relative?.quat,
      });
    }
    const primitiveInfo =
      geomEntries.find((entry): entry is Extract<GeomEntry, { kind: "primitive" }> => entry.kind === "primitive")
        ?.info ?? null;
    const isPlane = primitiveInfo?.type === "plane";
    const rawMass = safe(physics.mass, 0);
    const mass = physics.fixed || isPlane ? 0 : Math.max(0, rawMass);
    const safeMass = mass < 1e-4 ? 0 : mass;
    const friction = Math.max(0, safe(physics.friction, terrainLike ? 1 : 0.5));
    const collisionsEnabled = physics.collisionsEnabled !== false;
    const bodyName = sanitizeMjcfName(getDocId(obj), "body");
    bodies.push({ name: bodyName, object: obj });

    const pos = tmpPos.clone();
    const quat = tmpQuat.clone();
    const posAttr = `${safe(pos.x).toFixed(4)} ${safe(pos.y).toFixed(4)} ${safe(pos.z).toFixed(4)}`;
    const quatAttr = `${safe(quat.w, 1).toFixed(6)} ${safe(quat.x).toFixed(6)} ${safe(quat.y).toFixed(6)} ${safe(quat.z).toFixed(6)}`;
    const frictionAttr = terrainLike
      ? ` friction="${friction.toFixed(4)} ${TERRAIN_TORSIONAL_FRICTION.toFixed(6)} ${TERRAIN_ROLLING_FRICTION.toFixed(6)}"${terrainContactAttr}`
      : ` friction="${friction.toFixed(4)} 0.005 0.0001"${contactAttr}`;
    const collisionAttr = collisionsEnabled
      ? collisionMask
        ? ` contype="${collisionMask.contype}" conaffinity="${collisionMask.conaffinity}"`
        : ""
      : ` contype="0" conaffinity="0"`;
    const inertiaGeom =
      primitiveInfo && primitiveInfo.type === "cylinder" && primitiveInfo.axis === "y"
        ? { ...primitiveInfo, axis: "z" as const }
        : primitiveInfo;
    const computedInertia = inertiaGeom ? computeInertiaFromGeom(inertiaGeom, safeMass) : null;

    if (safeMass <= 0 && primitiveInfo?.type === "plane") {
      lines.push(
        `    <geom name="${bodyName}_geom" type="plane" size="${primitiveInfo.size}" pos="${posAttr}" quat="${quatAttr}"${frictionAttr}${collisionAttr} />`
      );
      return;
    }

    lines.push(`    <body name="${bodyName}" pos="${posAttr}" quat="${quatAttr}">`);
    if (safeMass > 0) lines.push(`      <freejoint />`);
    appendInertialLine("      ", physics, safeMass, computedInertia);
    appendGeomLines(
      "      ",
      bodyName,
      geomEntries,
      frictionAttr,
      collisionAttr
    );
    lines.push(`    </body>`);
  };

  for (const obj of otherCandidates) {
    buildSimpleBody(obj);
  }

  for (const link of rootLinks) {
    buildLinkBody(link, 4);
  }

  if (collisionAssetLines.length > 0) {
    lines.splice(2, 0, `  <asset>`, ...collisionAssetLines, `  </asset>`);
  }

  lines.push(`  </worldbody>`);
  if (jointActuators.length) {
    lines.push(`  <actuator>`);
    lines.push(...jointActuators);
    lines.push(`  </actuator>`);
  }
  lines.push(`</mujoco>`);

  return { xml: lines.join("\n"), bodies, warnings: Array.from(new Set(warnings)) };
}

function buildNameMap(roots: THREE.Object3D[]) {
  const map = new Map<string, THREE.Object3D>();
  for (const root of roots) {
    root.traverse((obj) => {
      if (obj.name) {
        if (!map.has(obj.name)) map.set(obj.name, obj);
      }
      const docId = getDocId(obj);
      if (!map.has(docId)) map.set(docId, obj);
      if (!map.has(obj.uuid)) map.set(obj.uuid, obj);
    });
  }
  return map;
}

function buildRootNameMaps(roots: THREE.Object3D[]) {
  const prefixes: string[] = [];
  const maps = new Map<string, Map<string, THREE.Object3D>>();
  for (const root of roots) {
    const prefix = sanitizeMjcfName(getDocId(root));
    prefixes.push(prefix);
    const map = new Map<string, THREE.Object3D>();
    root.traverse((obj) => {
      if (obj.name && !map.has(obj.name)) {
        map.set(obj.name, obj);
      }
    });
    maps.set(prefix, map);
  }
  return { prefixes, maps };
}

function setGravity(model: MjModel, gravity: [number, number, number]) {
  const raw = (model.opt as any).gravity;
  const g = getBufferView(raw);
  if (!g || g.length < 3) return;
  g[0] = gravity[0];
  g[1] = gravity[1];
  g[2] = gravity[2];
}

function isUrdfRoot(root: THREE.Object3D) {
  if (isSceneAssetRoot(root)) return false;
  // Imported URDF roots are tagged at root level; editor-built robots can also
  // carry `userData.urdf` on joints, so we must not classify them as imported.
  if (typeof root.userData?.urdfSource === "string" && root.userData.urdfSource.length > 0) return true;
  if (typeof root.userData?.urdfKey === "string" && root.userData.urdfKey.length > 0) return true;
  if (root.userData?.editorRobotRoot) return true;
  const modelSource = root.userData?.robotModelSource as { kind?: string } | undefined;
  if (modelSource?.kind === "usd" || modelSource?.kind === "urdf") return true;

  let found = false;
  root.traverse((obj) => {
    const anyObj = obj as any;
    if (
      anyObj.isURDFLink ||
      anyObj.isURDFJoint ||
      anyObj.isURDFCollider ||
      anyObj.isURDFVisual
    ) {
      found = true;
    }
  });
  return found;
}

function extractWorldbodyContent(xml: string) {
  const match = xml.match(/<worldbody[^>]*>([\s\S]*?)<\/worldbody>/i);
  if (!match) return "";
  return match[1].trim();
}

function extractAssetContent(xml: string) {
  const match = xml.match(/<asset[^>]*>([\s\S]*?)<\/asset>/i);
  if (!match) return "";
  return match[1].trim();
}

function extractActuatorContent(xml: string) {
  const match = xml.match(/<actuator[^>]*>([\s\S]*?)<\/actuator>/i);
  if (!match) return "";
  return match[1].trim();
}

function mergeAsset(xml: string, extraAsset: string) {
  const extra = extraAsset.trim();
  if (!extra) return xml;
  if (!/<asset/i.test(xml)) {
    if (/<worldbody/i.test(xml)) {
      return xml.replace(/<worldbody/i, `  <asset>\n${extra}\n  </asset>\n  <worldbody`);
    }
    return xml.replace(/<\/mujoco>/i, `  <asset>\n${extra}\n  </asset>\n</mujoco>`);
  }
  return xml.replace(/<\/asset>/i, `\n${extra}\n  </asset>`);
}

function mergeWorldbody(xml: string, extraWorld: string) {
  const extra = extraWorld.trim();
  if (!extra) return xml;
  if (!/<worldbody/i.test(xml)) {
    return xml.replace(/<\/mujoco>/i, `  <worldbody>\n${extra}\n  </worldbody>\n</mujoco>`);
  }
  return xml.replace(/<\/worldbody>/i, `\n${extra}\n  </worldbody>`);
}

function mergeActuator(xml: string, extraActuator: string) {
  const extra = extraActuator.trim();
  if (!extra) return xml;
  if (!/<actuator/i.test(xml)) {
    return xml.replace(/<\/mujoco>/i, `  <actuator>\n${extra}\n  </actuator>\n</mujoco>`);
  }
  return xml.replace(/<\/actuator>/i, `\n${extra}\n  </actuator>`);
}

function buildPointerCursorWorldbody() {
  const radius = Number.isFinite(POINTER_CURSOR_RADIUS) && POINTER_CURSOR_RADIUS > 0 ? POINTER_CURSOR_RADIUS : 0.06;
  const parkedZ = Number.isFinite(POINTER_CURSOR_PARK_Z) ? POINTER_CURSOR_PARK_Z : -1000;
  return [
    `<body name="${POINTER_CURSOR_BODY_NAME}" mocap="true" pos="0 0 ${parkedZ.toFixed(3)}">`,
    `  <geom name="${POINTER_CURSOR_BODY_NAME}_geom" type="sphere" size="${radius.toFixed(4)}"`,
    `        density="1" contype="8" conaffinity="65535" friction="0.001 0.0001 0.0001"`,
    `        solref="0.002 1.2" solimp="0.95 0.995 0.0001" rgba="1 0.3 0.3 0.15" />`,
    `</body>`,
  ].join("\n");
}

function finiteOr(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function resolveRuntimeGeomTypeFromEnumName(name: string): MujocoRuntimeColliderType {
  switch (name) {
    case "mjGEOM_PLANE":
      return "plane";
    case "mjGEOM_SPHERE":
      return "sphere";
    case "mjGEOM_CAPSULE":
      return "capsule";
    case "mjGEOM_ELLIPSOID":
      return "ellipsoid";
    case "mjGEOM_CYLINDER":
      return "cylinder";
    case "mjGEOM_BOX":
      return "box";
    case "mjGEOM_MESH":
      return "mesh";
    case "mjGEOM_HFIELD":
      return "hfield";
    case "mjGEOM_SDF":
      return "sdf";
    default:
      return "unknown";
  }
}

function buildRuntimeGeomTypeLookup(mujoco: MainModule): Map<number, MujocoRuntimeColliderType> {
  const lookup = new Map<number, MujocoRuntimeColliderType>();
  const enumBag = (mujoco as any).mjtGeom as Record<string, unknown> | undefined;
  if (!enumBag) return lookup;
  for (const [name, rawValue] of Object.entries(enumBag)) {
    if (!name.startsWith("mjGEOM_")) continue;
    const enumValue = mjtObjValue(rawValue);
    if (!Number.isFinite(enumValue)) continue;
    lookup.set(enumValue, resolveRuntimeGeomTypeFromEnumName(name));
  }
  return lookup;
}

export function createMujocoRuntime(): MujocoRuntime {
  let mujoco: MainModule | null = null;
  let model: MjModel | null = null;
  let data: MjData | null = null;
  let bindings: BodyBinding[] = [];
  let xpos: Float64Array = new Float64Array();
  let xquat: Float64Array = new Float64Array();
  let qposView: Float64Array = new Float64Array();
  let qvelView: Float64Array = new Float64Array();
  let jntQposAdr: Int32Array = new Int32Array();
  let jntDofAdr: Int32Array = new Int32Array();
  let objJointType = 0;
  let accumulator = 0;
  let noiseRate = 0;
  let noiseScale = 0;
  let noiseHoldTimerSec = 0;
  let noiseHoldForces: Float64Array | null = null;
  let lastXML: string | null = null;
  let actuatorNames: string[] = [];
  let actuatorByName = new Map<string, number>();
  let actuatorTargets: Record<string, number> = {};
  let actuatorVelocityTargets: Record<string, number> = {};
  let actuatorTorqueTargets: Record<string, number> = {};
  let actuatorConfigs: Record<string, JointActuatorConfig> = {};
  let actuatorTrnIdView: Int32Array = new Int32Array();
  let actuatorsArmed = false;
  let actuatorArmBlend = 0;
  let filteredActuatorCtrl = new Map<number, number>();
  let jointIdCache = new Map<string, number>();
  let actuatorIdCache = new Map<string, number>();
  let jointNameMap: MjcfNameMap | null = null;
  let ctrlView: Float64Array = new Float64Array();
  let qfrcAppliedView: Float64Array = new Float64Array();
  let bodyMassView: Float64Array = new Float64Array();
  let bodyMocapIdView: Int32Array = new Int32Array();
  let mocapPosView: Float64Array = new Float64Array();
  let mocapQuatView: Float64Array = new Float64Array();
  let bodyIdByObjectId = new Map<string, number>();
  let pointerMode: PointerInteractionMode = "none";
  let pointerTarget: THREE.Vector3 | null = null;
  let pointerDragState: { bodyId: number; localPoint: THREE.Vector3 } | null = null;
  let pointerCursorMocapId = -1;
  let pointerSpringStiffness = Math.max(1, POINTER_DRAG_STIFFNESS);
  let pointerSpringMaxForce = Math.max(1, POINTER_DRAG_MAX_FORCE);
  let pointerSpringDebugState: PointerSpringDebugState | null = null;
  let pointerPrevValid = false;
  let objBodyType = 0;
  let objGeomType = 0;
  let geomTypeByEnum = new Map<number, MujocoRuntimeColliderType>();
  let geomTypeView: Int32Array = new Int32Array();
  let geomSizeView: Float64Array = new Float64Array();
  let geomDataIdView: Int32Array = new Int32Array();
  let geomContypeView: Int32Array = new Int32Array();
  let geomConaffinityView: Int32Array = new Int32Array();
  let geomBodyIdView: Int32Array = new Int32Array();
  let geomXposView: Float64Array = new Float64Array();
  let geomXmatView: Float64Array = new Float64Array();
  let meshColliderAssets = new Map<number, MujocoRuntimeMeshColliderAsset>();
  let hfieldColliderAssets = new Map<number, MujocoRuntimeHfieldColliderAsset>();
  const pointerPrevWorldPoint = new THREE.Vector3();
  const pointerPrevTarget = new THREE.Vector3();
  const tmpBodyPos = new THREE.Vector3();
  const tmpBodyQuat = new THREE.Quaternion();
  const tmpBodyQuatInv = new THREE.Quaternion();
  const tmpLocalPoint = new THREE.Vector3();
  const tmpWorldPoint = new THREE.Vector3();
  const tmpForce = new THREE.Vector3();
  const tmpWorldVel = new THREE.Vector3();
  const tmpTargetVel = new THREE.Vector3();

  const disposeModel = () => {
    if (data) data.delete();
    if (model) model.delete();
    data = null;
    model = null;
    bindings = [];
    xpos = new Float64Array();
    xquat = new Float64Array();
    qposView = new Float64Array();
    qvelView = new Float64Array();
    jntQposAdr = new Int32Array();
    jntDofAdr = new Int32Array();
    objJointType = 0;
    objBodyType = 0;
    objGeomType = 0;
    geomTypeByEnum = new Map();
    geomTypeView = new Int32Array();
    geomSizeView = new Float64Array();
    geomDataIdView = new Int32Array();
    geomContypeView = new Int32Array();
    geomConaffinityView = new Int32Array();
    geomBodyIdView = new Int32Array();
    geomXposView = new Float64Array();
    geomXmatView = new Float64Array();
    meshColliderAssets = new Map();
    hfieldColliderAssets = new Map();
    ctrlView = new Float64Array();
    qfrcAppliedView = new Float64Array();
    bodyMassView = new Float64Array();
    bodyMocapIdView = new Int32Array();
    mocapPosView = new Float64Array();
    mocapQuatView = new Float64Array();
    bodyIdByObjectId = new Map();
    pointerMode = "none";
    pointerTarget = null;
    pointerDragState = null;
    pointerCursorMocapId = -1;
    pointerSpringDebugState = null;
    pointerPrevValid = false;
    noiseHoldTimerSec = 0;
    noiseHoldForces = null;
    actuatorNames = [];
    actuatorByName = new Map();
    actuatorTargets = {};
    actuatorVelocityTargets = {};
    actuatorTorqueTargets = {};
    actuatorConfigs = {};
    actuatorTrnIdView = new Int32Array();
    actuatorsArmed = false;
    actuatorArmBlend = 0;
    filteredActuatorCtrl = new Map();
    jointIdCache = new Map();
    actuatorIdCache = new Map();
    jointNameMap = null;
    accumulator = 0;
  };

  const syncBindings = () => {
    if (!model || !data || !mujoco) return;
    const tmpPos = new THREE.Vector3();
    const tmpQuat = new THREE.Quaternion();
    const worldMatrix = new THREE.Matrix4();
    const invParent = new THREE.Matrix4();
    for (const binding of bindings) {
      const i3 = binding.bodyId * 3;
      const i4 = binding.bodyId * 4;
      tmpPos.set(xpos[i3], xpos[i3 + 1], xpos[i3 + 2]);
      tmpQuat.set(xquat[i4 + 1], xquat[i4 + 2], xquat[i4 + 3], xquat[i4]);
      worldMatrix.compose(tmpPos, tmpQuat, new THREE.Vector3(1, 1, 1));
      worldMatrix.multiply(binding.bodyToObject);

      const obj = binding.object;
      if (obj.parent) {
        obj.parent.updateMatrixWorld(true);
        invParent.copy(obj.parent.matrixWorld).invert();
        worldMatrix.premultiply(invParent);
        worldMatrix.decompose(obj.position, obj.quaternion, obj.scale);
      } else {
        worldMatrix.decompose(obj.position, obj.quaternion, obj.scale);
      }
    }
  };

  const captureBindingOffsets = () => {
    if (!model || !data || !mujoco) return;
    const tmpPos = new THREE.Vector3();
    const tmpQuat = new THREE.Quaternion();
    const bodyWorld = new THREE.Matrix4();
    const invBody = new THREE.Matrix4();
    const objWorld = new THREE.Matrix4();

    for (const binding of bindings) {
      const i3 = binding.bodyId * 3;
      const i4 = binding.bodyId * 4;
      if (i3 + 2 >= xpos.length || i4 + 3 >= xquat.length) {
        binding.bodyToObject.identity();
        continue;
      }
      tmpPos.set(xpos[i3], xpos[i3 + 1], xpos[i3 + 2]);
      tmpQuat.set(xquat[i4 + 1], xquat[i4 + 2], xquat[i4 + 3], xquat[i4]);
      bodyWorld.compose(tmpPos, tmpQuat, new THREE.Vector3(1, 1, 1));
      invBody.copy(bodyWorld).invert();

      binding.object.updateMatrixWorld(true);
      objWorld.copy(binding.object.matrixWorld);
      binding.bodyToObject.copy(invBody.multiply(objWorld));
      if (MUJOCO_DEBUG) {
        const pos = new THREE.Vector3();
        const quat = new THREE.Quaternion();
        const scl = new THREE.Vector3();
        binding.bodyToObject.decompose(pos, quat, scl);
        const offsetNorm = Math.hypot(pos.x, pos.y, pos.z);
        if (offsetNorm > 1e-6) {
          debugLog("binding offset", {
            bodyId: binding.bodyId,
            objectId: getDocId(binding.object),
            offsetPosition: { x: pos.x, y: pos.y, z: pos.z },
            offsetScale: { x: scl.x, y: scl.y, z: scl.z },
          });
        }
      }
    }
  };

  const rebuildRuntimeColliderAssets = () => {
    if (!model) {
      meshColliderAssets = new Map();
      hfieldColliderAssets = new Map();
      return;
    }

    const nextMeshAssets = new Map<number, MujocoRuntimeMeshColliderAsset>();
    const nmesh = Math.max(0, Math.trunc(finiteOr((model as any).nmesh, 0)));
    const meshVertAdrView = getIntView((model as any).mesh_vertadr);
    const meshVertNumView = getIntView((model as any).mesh_vertnum);
    const meshFaceAdrView = getIntView((model as any).mesh_faceadr);
    const meshFaceNumView = getIntView((model as any).mesh_facenum);
    const meshVertView = getBufferView((model as any).mesh_vert);
    const meshFaceView = getIntView((model as any).mesh_face);
    for (let meshId = 0; meshId < nmesh; meshId += 1) {
      const vertAdr = Math.max(0, Math.trunc(meshVertAdrView[meshId] ?? 0));
      const vertNum = Math.max(0, Math.trunc(meshVertNumView[meshId] ?? 0));
      const faceAdr = Math.max(0, Math.trunc(meshFaceAdrView[meshId] ?? 0));
      const faceNum = Math.max(0, Math.trunc(meshFaceNumView[meshId] ?? 0));
      if (vertNum <= 0 || faceNum <= 0) continue;

      const vertices: number[] = [];
      const indices: number[] = [];
      const vertBase = vertAdr * 3;
      const vertLimit = vertBase + vertNum * 3;
      for (let i = vertBase; i + 2 < vertLimit && i + 2 < meshVertView.length; i += 3) {
        vertices.push(finiteOr(meshVertView[i]), finiteOr(meshVertView[i + 1]), finiteOr(meshVertView[i + 2]));
      }

      const faceBase = faceAdr * 3;
      const faceLimit = faceBase + faceNum * 3;
      for (let i = faceBase; i + 2 < faceLimit && i + 2 < meshFaceView.length; i += 3) {
        const a = Math.trunc(finiteOr(meshFaceView[i], -1));
        const b = Math.trunc(finiteOr(meshFaceView[i + 1], -1));
        const c = Math.trunc(finiteOr(meshFaceView[i + 2], -1));
        if (a < 0 || b < 0 || c < 0 || a >= vertNum || b >= vertNum || c >= vertNum) continue;
        indices.push(a, b, c);
      }
      if (vertices.length < 9 || indices.length < 3) continue;
      nextMeshAssets.set(meshId, { meshId, vertices, indices });
    }
    meshColliderAssets = nextMeshAssets;

    const nextHfieldAssets = new Map<number, MujocoRuntimeHfieldColliderAsset>();
    const nhfield = Math.max(0, Math.trunc(finiteOr((model as any).nhfield, 0)));
    const hfieldRowView = getIntView((model as any).hfield_nrow);
    const hfieldColView = getIntView((model as any).hfield_ncol);
    const hfieldAdrView = getIntView((model as any).hfield_adr);
    const hfieldSizeView = getBufferView((model as any).hfield_size);
    const hfieldDataView = getBufferView((model as any).hfield_data);
    for (let hfieldId = 0; hfieldId < nhfield; hfieldId += 1) {
      const nrow = Math.max(0, Math.trunc(hfieldRowView[hfieldId] ?? 0));
      const ncol = Math.max(0, Math.trunc(hfieldColView[hfieldId] ?? 0));
      if (nrow <= 0 || ncol <= 0) continue;
      const adr = Math.max(0, Math.trunc(hfieldAdrView[hfieldId] ?? 0));
      const count = nrow * ncol;
      const heights: number[] = [];
      heights.length = count;
      for (let i = 0; i < count; i += 1) {
        const raw = hfieldDataView[adr + i];
        heights[i] = finiteOr(raw);
      }
      const sizeBase = hfieldId * 4;
      const size: [number, number, number, number] = [
        Math.max(1e-6, Math.abs(finiteOr(hfieldSizeView[sizeBase], 1))),
        Math.max(1e-6, Math.abs(finiteOr(hfieldSizeView[sizeBase + 1], 1))),
        Math.max(1e-6, Math.abs(finiteOr(hfieldSizeView[sizeBase + 2], 0.2))),
        Math.max(1e-6, Math.abs(finiteOr(hfieldSizeView[sizeBase + 3], 0.1))),
      ];
      nextHfieldAssets.set(hfieldId, {
        hfieldId,
        nrow,
        ncol,
        size,
        heights,
      });
    }
    hfieldColliderAssets = nextHfieldAssets;
  };

  const collectRuntimeColliderSnapshots = (): MujocoRuntimeColliderSnapshot[] => {
    if (!mujoco || !model || !data) return [];
    const geomCount = Math.max(0, Math.trunc(finiteOr((model as any).ngeom, 0)));
    if (geomCount <= 0) return [];

    const snapshots: MujocoRuntimeColliderSnapshot[] = [];
    const rotMat = new THREE.Matrix4();
    const rotQuat = new THREE.Quaternion();
    for (let geomId = 0; geomId < geomCount; geomId += 1) {
      const contype = Math.max(0, Math.trunc(finiteOr(geomContypeView[geomId], 0)));
      const conaffinity = Math.max(0, Math.trunc(finiteOr(geomConaffinityView[geomId], 0)));
      if (contype === 0 && conaffinity === 0) continue;

      const typeEnum = Math.trunc(finiteOr(geomTypeView[geomId], -1));
      const type = geomTypeByEnum.get(typeEnum) ?? "unknown";
      const sizeBase = geomId * 3;
      const sizeFromModel: [number, number, number] = [
        Math.abs(finiteOr(geomSizeView[sizeBase], 0)),
        Math.abs(finiteOr(geomSizeView[sizeBase + 1], 0)),
        Math.abs(finiteOr(geomSizeView[sizeBase + 2], 0)),
      ];
      const bodyId = Math.max(0, Math.trunc(finiteOr(geomBodyIdView[geomId], 0)));
      const geomName = (objGeomType ? mujoco.mj_id2name(model, objGeomType, geomId) : "") || `geom_${geomId}`;
      const bodyName = objBodyType ? mujoco.mj_id2name(model, objBodyType, bodyId) : null;
      if (geomName.startsWith(`${POINTER_CURSOR_BODY_NAME}_`) || bodyName === POINTER_CURSOR_BODY_NAME) {
        continue;
      }

      const posBase = geomId * 3;
      const position = {
        x: finiteOr(geomXposView[posBase]),
        y: finiteOr(geomXposView[posBase + 1]),
        z: finiteOr(geomXposView[posBase + 2]),
      };

      const matBase = geomId * 9;
      if (matBase + 8 < geomXmatView.length) {
        rotMat.set(
          finiteOr(geomXmatView[matBase]),
          finiteOr(geomXmatView[matBase + 1]),
          finiteOr(geomXmatView[matBase + 2]),
          0,
          finiteOr(geomXmatView[matBase + 3]),
          finiteOr(geomXmatView[matBase + 4]),
          finiteOr(geomXmatView[matBase + 5]),
          0,
          finiteOr(geomXmatView[matBase + 6]),
          finiteOr(geomXmatView[matBase + 7]),
          finiteOr(geomXmatView[matBase + 8]),
          0,
          0,
          0,
          0,
          1
        );
        rotQuat.setFromRotationMatrix(rotMat);
      } else {
        rotQuat.set(0, 0, 0, 1);
      }

      const dataIdRaw = Math.trunc(finiteOr(geomDataIdView[geomId], -1));
      const mesh = type === "mesh" && dataIdRaw >= 0 ? (meshColliderAssets.get(dataIdRaw) ?? null) : null;
      const hfield = type === "hfield" && dataIdRaw >= 0 ? (hfieldColliderAssets.get(dataIdRaw) ?? null) : null;
      const size = hfield
        ? [hfield.size[0], hfield.size[1], hfield.size[2]] as [number, number, number]
        : sizeFromModel;
      snapshots.push({
        geomId,
        geomName,
        bodyId,
        bodyName,
        type,
        size,
        position,
        quaternion: {
          w: finiteOr(rotQuat.w, 1),
          x: finiteOr(rotQuat.x),
          y: finiteOr(rotQuat.y),
          z: finiteOr(rotQuat.z),
        },
        contype,
        conaffinity,
        meshId: mesh ? mesh.meshId : null,
        hfieldId: hfield ? hfield.hfieldId : null,
        mesh,
        hfield,
      });
    }

    return snapshots;
  };

  const normalizeAngle = (value: number) => {
    const twoPi = Math.PI * 2;
    let next = value % twoPi;
    if (next > Math.PI) next -= twoPi;
    if (next < -Math.PI) next += twoPi;
    return next;
  };

  const resolveJointId = (rawName: string) => {
    if (!model || !mujoco || !objJointType) return -1;
    const cached = jointIdCache.get(rawName);
    if (cached !== undefined) return cached;
    const mapped = jointNameMap?.joints?.[rawName] ?? rawName;
    let id = mujoco.mj_name2id(model, objJointType, mapped);
    if (id < 0 && mapped !== rawName) {
      id = mujoco.mj_name2id(model, objJointType, rawName);
    }
    jointIdCache.set(rawName, id);
    return id;
  };

  const buildActuatorCandidates = (rawName: string, preferredName?: string) => {
    const candidates: string[] = [];
    if (preferredName) candidates.push(preferredName);
    candidates.push(rawName, `${rawName}_motor`, `${rawName}_act`);
    const mappedJoint = jointNameMap?.joints?.[rawName];
    if (mappedJoint) {
      candidates.push(mappedJoint, `${mappedJoint}_motor`, `${mappedJoint}_act`);
    }
    return candidates;
  };

  const resolveActuatorId = (rawName: string, preferredName?: string) => {
    const cacheKey = preferredName ? `${rawName}|${preferredName}` : rawName;
    const cached = actuatorIdCache.get(cacheKey);
    if (cached !== undefined) return cached;
    let resolved: number | undefined;
    for (const candidate of buildActuatorCandidates(rawName, preferredName)) {
      const id = actuatorByName.get(candidate);
      if (id !== undefined) {
        resolved = id;
        break;
      }
    }
    const id = resolved ?? -1;
    actuatorIdCache.set(cacheKey, id);
    return id;
  };

  const resolveJointIdForActuator = (actuatorId: number, rawJointName: string) => {
    if (actuatorId >= 0) {
      const base = actuatorId * 2;
      if (base + 1 < actuatorTrnIdView.length) {
        const linkedJointId = actuatorTrnIdView[base];
        if (Number.isFinite(linkedJointId) && linkedJointId >= 0) {
          return linkedJointId;
        }
      }
    }
    return resolveJointId(rawJointName);
  };

  const resolveControlledJointId = (rawJointName: string, preferredActuatorName?: string) => {
    const actuatorId = resolveActuatorId(rawJointName, preferredActuatorName);
    return resolveJointIdForActuator(actuatorId, rawJointName);
  };

  const applyActuatorTargets = () => {
    if (!actuatorsArmed || !model || !data || !mujoco) return;
    if (!ctrlView || ctrlView.length === 0) return;
    if (!qposView || !qvelView || !jntQposAdr || !jntDofAdr) return;

    ctrlView.fill(0);

    const DEG2RAD = Math.PI / 180;
    const controlStep = Math.max(1e-4, model.opt.timestep || 0.01);
    const filterAlpha =
      Number.isFinite(ACTUATOR_CTRL_FILTER_SEC) && ACTUATOR_CTRL_FILTER_SEC > 1e-6
        ? Math.min(1, controlStep / ACTUATOR_CTRL_FILTER_SEC)
        : 1;

    for (const [jointName, config] of Object.entries(actuatorConfigs)) {
      if (!config) continue;
      const stiffness = Number.isFinite(config.stiffness) ? config.stiffness : 0;
      const dampingInput = Number.isFinite(config.damping) ? config.damping : 0;
      const dampingFloor = stiffness > 0 ? 2 * Math.sqrt(stiffness) * ACTUATOR_DAMPING_RATIO_FLOOR : 0;
      const damping = Math.max(dampingInput, dampingFloor);
      const velocityGain = Number.isFinite(config.velocityGain)
        ? Math.max(0, config.velocityGain as number)
        : Math.max(0.1, DEFAULT_ACTUATOR_VELOCITY_GAIN);
      const mode = config.mode ?? "position";
      if (mode === "muscle") continue;
      const angular = config.angular ?? false;
      const usePos = mode === "position" || mode === "torque";
      const useVel = mode === "velocity" || mode === "torque";
      const rawPosTarget = actuatorTargets[jointName];
      const rawVelTarget = actuatorVelocityTargets[jointName];
      const rawTorqueTarget = actuatorTorqueTargets[jointName];
      const posTarget = usePos && Number.isFinite(rawPosTarget) ? (rawPosTarget as number) : undefined;
      const velTarget = useVel && Number.isFinite(rawVelTarget) ? (rawVelTarget as number) : 0;
      const torqueTarget = mode === "torque" && Number.isFinite(rawTorqueTarget) ? (rawTorqueTarget as number) : 0;
      const maxForce = Number.isFinite(config.maxForce) ? Math.max(0, config.maxForce as number) : null;

      if (stiffness === 0 && damping === 0 && velocityGain === 0 && torqueTarget === 0) continue;

      const actuatorId = resolveActuatorId(jointName, config.actuatorName);
      if (actuatorId < 0) continue;
      const jointId = resolveJointIdForActuator(actuatorId, jointName);
      if (jointId < 0) continue;
      const qposAdr = jntQposAdr[jointId];
      const qvelAdr = jntDofAdr[jointId];
      if (!Number.isFinite(qposAdr) || !Number.isFinite(qvelAdr)) continue;

      const pos = qposView[qposAdr] ?? 0;
      const vel = qvelView[qvelAdr] ?? 0;
      const posTargetValue = angular && posTarget !== undefined ? posTarget * DEG2RAD : posTarget;
      const velTargetValue = angular && velTarget !== undefined ? velTarget * DEG2RAD : velTarget;
      let errorPos = 0;
      if (posTargetValue !== undefined) {
        errorPos = posTargetValue - pos;
        if (config.continuous) {
          errorPos = normalizeAngle(errorPos);
        }
        const maxError = angular ? ACTUATOR_MAX_ANGULAR_ERROR_RAD : ACTUATOR_MAX_LINEAR_ERROR;
        if (Number.isFinite(maxError) && maxError > 0) {
          if (errorPos > maxError) errorPos = maxError;
          if (errorPos < -maxError) errorPos = -maxError;
        }
      }
      const holdVelError = -vel;
      const targetVelError = (velTargetValue ?? 0) - vel;
      let torque = 0;
      if (usePos) {
        torque += stiffness * errorPos;
      }
      if (mode === "position") {
        torque += damping * holdVelError;
      } else if (useVel) {
        torque += velocityGain * targetVelError;
      }
      torque += torqueTarget;
      if (maxForce !== null && maxForce > 0) {
        torque = Math.max(-maxForce, Math.min(maxForce, torque));
      }
      torque *= actuatorArmBlend;
      const prevTorque = filteredActuatorCtrl.get(actuatorId) ?? 0;
      const filteredTorque = prevTorque + (torque - prevTorque) * filterAlpha;
      filteredActuatorCtrl.set(actuatorId, filteredTorque);
      ctrlView[actuatorId] = filteredTorque;
    }
  };

  const setPointerCursorPosition = (target: THREE.Vector3) => {
    if (pointerCursorMocapId < 0) return;
    const basePos = pointerCursorMocapId * 3;
    if (basePos + 2 < mocapPosView.length) {
      mocapPosView[basePos] = target.x;
      mocapPosView[basePos + 1] = target.y;
      mocapPosView[basePos + 2] = target.z;
    }
    const baseQuat = pointerCursorMocapId * 4;
    if (baseQuat + 3 < mocapQuatView.length) {
      mocapQuatView[baseQuat] = 1;
      mocapQuatView[baseQuat + 1] = 0;
      mocapQuatView[baseQuat + 2] = 0;
      mocapQuatView[baseQuat + 3] = 0;
    }
  };

  const parkPointerCursor = () => {
    if (pointerCursorMocapId < 0) return;
    const basePos = pointerCursorMocapId * 3;
    if (basePos + 2 < mocapPosView.length) {
      mocapPosView[basePos] = 0;
      mocapPosView[basePos + 1] = 0;
      mocapPosView[basePos + 2] = POINTER_CURSOR_PARK_Z;
    }
    const baseQuat = pointerCursorMocapId * 4;
    if (baseQuat + 3 < mocapQuatView.length) {
      mocapQuatView[baseQuat] = 1;
      mocapQuatView[baseQuat + 1] = 0;
      mocapQuatView[baseQuat + 2] = 0;
      mocapQuatView[baseQuat + 3] = 0;
    }
  };

  const randomNormal = (() => {
    let spare: number | null = null;
    return () => {
      if (spare !== null) {
        const value = spare;
        spare = null;
        return value;
      }
      // Box–Muller transform
      let u = 0;
      let v = 0;
      while (u === 0) u = Math.random();
      while (v === 0) v = Math.random();
      const mag = Math.sqrt(-2 * Math.log(u));
      const z0 = mag * Math.cos(2 * Math.PI * v);
      const z1 = mag * Math.sin(2 * Math.PI * v);
      spare = z1;
      return z0;
    };
  })();

  const applyNoiseForces = (stepSec: number) => {
    if (!qfrcAppliedView.length) return;
    if (!Number.isFinite(stepSec) || stepSec <= 0) return;
    if (!Number.isFinite(noiseRate) || noiseRate <= 0) return;
    if (!Number.isFinite(noiseScale) || noiseScale <= 0) return;

    const holdSec = 1 / Math.max(1e-6, noiseRate);
    noiseHoldTimerSec -= stepSec;
    if (!noiseHoldForces || noiseHoldForces.length !== qfrcAppliedView.length || noiseHoldTimerSec <= 0) {
      noiseHoldTimerSec = holdSec;
      if (!noiseHoldForces || noiseHoldForces.length !== qfrcAppliedView.length) {
        noiseHoldForces = new Float64Array(qfrcAppliedView.length);
      }
      for (let i = 0; i < noiseHoldForces.length; i += 1) {
        noiseHoldForces[i] = randomNormal() * noiseScale;
      }
    }

    for (let i = 0; i < qfrcAppliedView.length; i += 1) {
      qfrcAppliedView[i] += noiseHoldForces[i] as number;
    }
  };

  const applyPointerDragForces = (stepSec: number) => {
    if (!mujoco || !model || !data) return;
    if (pointerMode !== "grab") return;
    if (!pointerDragState || !pointerTarget) return;

    const { bodyId, localPoint } = pointerDragState;
    if (bodyId <= 0 || bodyId >= model.nbody) return;
    if ((bodyMassView[bodyId] ?? 0) <= 1e-6) return;

    const i3 = bodyId * 3;
    const i4 = bodyId * 4;
    if (i3 + 2 >= xpos.length || i4 + 3 >= xquat.length) return;

    tmpBodyPos.set(xpos[i3], xpos[i3 + 1], xpos[i3 + 2]);
    tmpBodyQuat.set(xquat[i4 + 1], xquat[i4 + 2], xquat[i4 + 3], xquat[i4]);
    tmpWorldPoint.copy(localPoint).applyQuaternion(tmpBodyQuat).add(tmpBodyPos);
    tmpForce.copy(pointerTarget).sub(tmpWorldPoint);

    const stiffness =
      Number.isFinite(pointerSpringStiffness) && pointerSpringStiffness > 0 ? pointerSpringStiffness : 600;
    const maxForce =
      Number.isFinite(pointerSpringMaxForce) && pointerSpringMaxForce > 0 ? pointerSpringMaxForce : 1000;

    if (pointerPrevValid && Number.isFinite(stepSec) && stepSec > 0) {
      tmpWorldVel.copy(tmpWorldPoint).sub(pointerPrevWorldPoint).multiplyScalar(1 / stepSec);
      tmpTargetVel.copy(pointerTarget).sub(pointerPrevTarget).multiplyScalar(1 / stepSec);
      tmpWorldVel.sub(tmpTargetVel);
      const mass = bodyMassView[bodyId] ?? 0;
      if (Number.isFinite(mass) && mass > 1e-6) {
        const damping = 2 * POINTER_DRAG_DAMPING_RATIO * Math.sqrt(Math.max(0, stiffness) * mass);
        tmpWorldVel.multiplyScalar(-damping);
        tmpForce.multiplyScalar(stiffness).add(tmpWorldVel);
      } else {
        tmpForce.multiplyScalar(stiffness);
      }
    } else {
      tmpForce.multiplyScalar(stiffness);
    }

    pointerPrevWorldPoint.copy(tmpWorldPoint);
    pointerPrevTarget.copy(pointerTarget);
    pointerPrevValid = true;

    const forceLength = tmpForce.length();
    if (forceLength <= 1e-8) return;
    if (forceLength > maxForce) {
      tmpForce.multiplyScalar(maxForce / forceLength);
    }

    mujoco.mj_applyFT(
      model,
      data,
      [tmpForce.x, tmpForce.y, tmpForce.z],
      [0, 0, 0],
      [tmpWorldPoint.x, tmpWorldPoint.y, tmpWorldPoint.z],
      bodyId,
      (data as any).qfrc_applied
    );

    pointerSpringDebugState = {
      anchor: { x: tmpWorldPoint.x, y: tmpWorldPoint.y, z: tmpWorldPoint.z },
      target: { x: pointerTarget.x, y: pointerTarget.y, z: pointerTarget.z },
      force: { x: tmpForce.x, y: tmpForce.y, z: tmpForce.z },
      forceMagnitudeN: tmpForce.length(),
      distanceMeters: tmpWorldPoint.distanceTo(pointerTarget),
      stiffnessNPerMeter: stiffness,
      maxForceN: maxForce,
    };
  };

  const applyPointerInteractions = (stepSec: number) => {
    if (!model || !data) return;
    if (qfrcAppliedView.length) qfrcAppliedView.fill(0);
    applyNoiseForces(stepSec);
    pointerSpringDebugState = null;

    if (pointerMode === "cursor") {
      if (pointerTarget) setPointerCursorPosition(pointerTarget);
      else parkPointerCursor();
      return;
    }

    parkPointerCursor();
    if (pointerMode === "grab") applyPointerDragForces(stepSec);
  };

  return {
    async loadFromScene(_snapshot, roots, config, source) {
      noiseRate = config.noiseRate;
      noiseScale = config.noiseScale;

      if (!mujoco) mujoco = await getModule();
      ensureWorkingFs(mujoco);
      disposeModel();
      jointNameMap = source.kind === "generated" ? null : source.nameMap ?? null;
      debugLog("loadFromScene", {
        kind: source.kind,
        filename: source.kind === "generated" ? "generated.xml" : source.filename,
        files: source.kind === "generated" ? 0 : Object.keys(source.files).length,
      });

      let xmlPath = "/working/generated.xml";
      let generatedBodies: Array<{ name: string; object: THREE.Object3D }> | null = null;
      let extraBodies: Array<{ name: string; object: THREE.Object3D }> | null = null;
      let xmlToWrite = "";
      const loadWarnings: string[] = [];

      if (source.kind === "generated") {
        const built = buildSceneMJCF(roots);
        generatedBodies = built.bodies;
        xmlToWrite = built.xml;
        loadWarnings.push(...built.warnings);
      } else {
        xmlPath = `/working/${source.filename}`;
        xmlToWrite = source.content;
        const extraRoots = roots.filter((root) => {
          if (root.userData?.editorRobotRoot === true) return false;
          const modelSource = root.userData?.robotModelSource as { kind?: string } | undefined;
          if (modelSource?.kind === "usd" || modelSource?.kind === "urdf") return false;
          if (isSceneAssetRoot(root)) return true;
          const workspaceKey = String(root.userData?.usdWorkspaceKey ?? "")
            .trim()
            .toLowerCase();
          if (workspaceKey && /(terrain|rough|floor|ground)/.test(workspaceKey)) return true;
          const rootName = String(root.name ?? "").trim().toLowerCase();
          if (rootName && /(terrain|rough|floor|ground)/.test(rootName)) return true;
          return !isUrdfRoot(root);
        });
        logInfo("MuJoCo: extra root classification", {
          scope: "mujoco",
          data: {
            sourceKind: source.kind,
            totalRoots: roots.length,
            extraRoots: extraRoots.length,
            roots: roots.map((root) => ({
              id: getDocId(root),
              name: root.name,
              editorRobotRoot: root.userData?.editorRobotRoot === true,
              usdSceneAsset: root.userData?.usdSceneAsset === true,
              workspaceKey: String(root.userData?.usdWorkspaceKey ?? ""),
              sceneRole: String((root.userData?.sceneAssetSource as { role?: string } | undefined)?.role ?? ""),
              modelSourceKind: String((root.userData?.robotModelSource as { kind?: string } | undefined)?.kind ?? ""),
              classifiedAsUrdfRoot: isUrdfRoot(root),
              classifiedAsSceneAssetRoot: isSceneAssetRoot(root),
            })),
          },
        });
        if (extraRoots.length) {
          const extraCollisionMask = resolveExtraSceneCollisionMask(MUJOCO_SELF_COLLIDE);
          const built = buildSceneMJCF(extraRoots, extraCollisionMask);
          extraBodies = built.bodies;
          loadWarnings.push(...built.warnings);
          const extraAsset = extractAssetContent(built.xml);
          const extraWorld = extractWorldbodyContent(built.xml);
          const extraActuator = extractActuatorContent(built.xml);
          xmlToWrite = mergeAsset(xmlToWrite, extraAsset);
          xmlToWrite = mergeWorldbody(xmlToWrite, extraWorld);
          xmlToWrite = mergeActuator(xmlToWrite, extraActuator);
          logInfo("MuJoCo: merged extra scene roots", {
            scope: "mujoco",
            data: {
              extraRootCount: extraRoots.length,
              extraBodyCount: built.bodies.length,
              extraWarningCount: built.warnings.length,
              hasExtraAsset: extraAsset.length > 0,
              hasExtraWorld: extraWorld.length > 0,
            },
          });
          debugLog("merged extra roots", {
            count: extraRoots.length,
            extraBodies: built.bodies.length,
            extraAssetEntries: extraAsset
              ? extraAsset
                  .split("\n")
                  .filter((line) => line.includes("<mesh ") || line.includes("<hfield "))
                  .length
              : 0,
          });
        }
        writeFileTree(mujoco, source.files);
      }

      xmlToWrite = mergeWorldbody(xmlToWrite, buildPointerCursorWorldbody());
      lastXML = xmlToWrite;
      ensureDirForPath(mujoco, xmlPath);
      const xmlChars = xmlToWrite.length;
      let xmlBytes = 0;
      try {
        xmlBytes = writeTextFileUtf8(mujoco, xmlPath, xmlToWrite);
      } catch (error) {
        throw new Error(
          `Failed to write MJCF XML to MuJoCo FS (${xmlPath}, chars=${xmlChars}): ${String((error as Error)?.message ?? error)}`
        );
      }

      if (MUJOCO_DEBUG) {
        try {
          const fs = (mujoco as any).FS;
          const exists = fs.analyzePath?.(xmlPath)?.exists;
          const size = exists ? fs.stat(xmlPath).size : 0;
          debugLog("xml file", { path: xmlPath, exists, size, xmlChars, xmlBytes });
        } catch (err) {
          debugLog("xml file check failed", err);
        }
      }
      if (MUJOCO_DUMP_XML && lastXML) {
        console.info("[mujoco] MJCF xml\n" + lastXML);
      }

      try {
        model = mujoco.MjModel.loadFromXML(xmlPath);
      } catch (err) {
        if (lastXML) {
          console.error("[mujoco] MJCF parse failed. Generated XML:");
          console.error(lastXML);
        }
        const loadError = tryGetLoadError(mujoco, xmlPath);
        if (loadError) {
          console.error("[mujoco] MJCF load error:", loadError);
          throw new Error(loadError);
        }
        debugLog("mj_loadXML failed with no message");
        throw err;
      }
      if (!model) throw new Error("Failed to load MuJoCo model.");

      data = new mujoco.MjData(model);
      if (!data) throw new Error("Failed to create MuJoCo data.");

      setGravity(model, [0, 0, -9.81]);
      tightenSolverPrecision(model);
      mujoco.mj_forward(model, data);

      debugLog("model stats", {
        nbody: model.nbody,
        njnt: model.njnt,
        ngeom: model.ngeom,
        nu: model.nu,
      });

      xpos = getBufferView((data as any).xpos);
      xquat = getBufferView((data as any).xquat);
      qposView = getBufferView((data as any).qpos);
      qvelView = getBufferView((data as any).qvel);
      jntQposAdr = getIntView((model as any).jnt_qposadr);
      jntDofAdr = getIntView((model as any).jnt_dofadr);
      actuatorTrnIdView = getIntView((model as any).actuator_trnid);
      ctrlView = getBufferView((data as any).ctrl);
      qfrcAppliedView = getBufferView((data as any).qfrc_applied);
      bodyMassView = getBufferView((model as any).body_mass);
      bodyMocapIdView = getIntView((model as any).body_mocapid);
      mocapPosView = getBufferView((data as any).mocap_pos);
      mocapQuatView = getBufferView((data as any).mocap_quat);

      actuatorNames = [];
      actuatorByName = new Map();
      actuatorIdCache = new Map();
      jointIdCache = new Map();
      geomTypeByEnum = buildRuntimeGeomTypeLookup(mujoco);
      geomTypeView = getIntView((model as any).geom_type);
      geomSizeView = getBufferView((model as any).geom_size);
      geomDataIdView = getIntView((model as any).geom_dataid);
      geomContypeView = getIntView((model as any).geom_contype);
      geomConaffinityView = getIntView((model as any).geom_conaffinity);
      geomBodyIdView = getIntView((model as any).geom_bodyid);
      geomXposView = getBufferView((data as any).geom_xpos);
      geomXmatView = getBufferView((data as any).geom_xmat);
      rebuildRuntimeColliderAssets();
      objJointType = mjtObjValue((mujoco as any).mjtObj?.mjOBJ_JOINT);
      objBodyType = mjtObjValue((mujoco as any).mjtObj?.mjOBJ_BODY);
      objGeomType = mjtObjValue((mujoco as any).mjtObj?.mjOBJ_GEOM);
      const objAct = mjtObjValue((mujoco as any).mjtObj?.mjOBJ_ACTUATOR);
      if (objAct && model.nu > 0) {
        for (let i = 0; i < model.nu; i += 1) {
          const name = mujoco.mj_id2name(model, objAct, i);
          if (!name) continue;
          actuatorNames.push(name);
          actuatorByName.set(name, i);
        }
      }

      const nameMap = buildNameMap(roots);
      const { prefixes: rootPrefixes, maps: rootNameMaps } = buildRootNameMaps(roots);
      const linkNameByMjcf = new Map<string, string>();
      if (jointNameMap?.linksByMjcf) {
        for (const [mjcf, raw] of Object.entries(jointNameMap.linksByMjcf)) {
          linkNameByMjcf.set(mjcf, raw);
        }
      } else if (jointNameMap?.links) {
        for (const [raw, mjcf] of Object.entries(jointNameMap.links)) {
          linkNameByMjcf.set(mjcf, raw);
        }
      }
      if (generatedBodies) {
        for (const entry of generatedBodies) {
          const bodyId = mujoco.mj_name2id(model, objBodyType, entry.name);
          if (bodyId >= 0) {
            bindings.push({
              bodyId,
              object: entry.object,
              baseScale: entry.object.scale.clone(),
              bodyToObject: new THREE.Matrix4().identity(),
            });
          }
        }
      } else {
        if (extraBodies) {
          for (const entry of extraBodies) {
            const bodyId = mujoco.mj_name2id(model, objBodyType, entry.name);
            if (bodyId >= 0) {
              bindings.push({
                bodyId,
                object: entry.object,
                baseScale: entry.object.scale.clone(),
                bodyToObject: new THREE.Matrix4().identity(),
              });
            }
          }
        }
        for (let i = 1; i < model.nbody; i += 1) {
          const name = mujoco.mj_id2name(model, objBodyType, i);
          if (!name) continue;
          const lookup = linkNameByMjcf.get(name) ?? name;
          let obj: THREE.Object3D | null | undefined = null;
          if (rootPrefixes.length) {
            const prefix = rootPrefixes.find((p) => name.startsWith(`${p}_`));
            if (prefix) {
              const map = rootNameMaps.get(prefix);
              obj = map?.get(lookup) ?? null;
            }
          }
          if (!obj) {
            obj = nameMap.get(lookup);
          }
          if (!obj) continue;
          bindings.push({
            bodyId: i,
            object: obj,
            baseScale: obj.scale.clone(),
            bodyToObject: new THREE.Matrix4().identity(),
          });
        }
      }

      captureBindingOffsets();

      bodyIdByObjectId = new Map();
      for (const binding of bindings) {
        binding.object.traverse((obj) => {
          bodyIdByObjectId.set(getDocId(obj), binding.bodyId);
        });
      }

      pointerCursorMocapId = -1;
      const pointerBodyId = mujoco.mj_name2id(model, objBodyType, POINTER_CURSOR_BODY_NAME);
      if (pointerBodyId >= 0 && pointerBodyId < bodyMocapIdView.length) {
        pointerCursorMocapId = bodyMocapIdView[pointerBodyId] ?? -1;
      }
      pointerMode = "none";
      pointerTarget = null;
      pointerDragState = null;
      pointerPrevValid = false;
      parkPointerCursor();

      syncBindings();
      return { warnings: Array.from(new Set(loadWarnings)) };
    },
    step(dt) {
      if (!mujoco || !model || !data) return;
      if (!dt) return;
      const step = model.opt.timestep || 0.01;
      accumulator += dt;
      let steps = 0;
      while (accumulator >= step && steps < 8) {
        applyPointerInteractions(step);
        if (actuatorsArmed) {
          if (Number.isFinite(ACTUATOR_ARM_RAMP_SEC) && ACTUATOR_ARM_RAMP_SEC > 1e-6) {
            actuatorArmBlend = Math.min(1, actuatorArmBlend + step / ACTUATOR_ARM_RAMP_SEC);
          } else {
            actuatorArmBlend = 1;
          }
          applyActuatorTargets();
        }
        mujoco.mj_step(model, data);
        accumulator -= step;
        steps += 1;
      }
      if (steps > 0) syncBindings();
    },
    setNoiseRate(value) {
      noiseRate = value;
      noiseHoldTimerSec = 0;
    },
    setNoiseScale(value) {
      noiseScale = value;
      noiseHoldTimerSec = 0;
    },
    getActuatorNames() {
      return actuatorNames.slice();
    },
    setActuatorControls(controls) {
      if (!data || !ctrlView || ctrlView.length === 0) return;
      if (Array.isArray(controls) || ArrayBuffer.isView(controls)) {
        const count = Math.min(ctrlView.length, (controls as ArrayLike<number>).length);
        for (let i = 0; i < count; i += 1) {
          const value = (controls as ArrayLike<number>)[i];
          if (Number.isFinite(value)) ctrlView[i] = value;
        }
        return;
      }

      for (const [rawName, value] of Object.entries(controls)) {
        if (!Number.isFinite(value)) continue;
        const id = resolveActuatorId(rawName);
        if (id < 0) continue;
        ctrlView[id] = value;
      }
    },
    setActuatorTargets(targets) {
      actuatorTargets = { ...targets };
      if (actuatorsArmed) applyActuatorTargets();
    },
    setActuatorVelocityTargets(targets) {
      actuatorVelocityTargets = { ...targets };
      if (actuatorsArmed) applyActuatorTargets();
    },
    setActuatorTorqueTargets(targets) {
      actuatorTorqueTargets = { ...targets };
      if (actuatorsArmed) applyActuatorTargets();
    },
    setActuatorConfigs(configs) {
      const previousConfigs = actuatorConfigs;
      actuatorConfigs = { ...configs };
      if (!actuatorsArmed) return;
      const RAD2DEG = 180 / Math.PI;
      for (const [jointName, config] of Object.entries(actuatorConfigs)) {
        if (!config) continue;
        const prevMode = previousConfigs[jointName]?.mode ?? "position";
        const nextMode = config.mode ?? "position";
        if (prevMode === nextMode) continue;
        if (nextMode === "muscle") {
          actuatorTargets[jointName] = 0;
          actuatorVelocityTargets[jointName] = 0;
          actuatorTorqueTargets[jointName] = 0;
          continue;
        }
        if (nextMode !== "velocity") {
          const jointId = resolveControlledJointId(jointName, config.actuatorName);
          if (jointId >= 0) {
            const qposAdr = jntQposAdr[jointId];
            if (Number.isFinite(qposAdr)) {
              const current = qposView[qposAdr] ?? 0;
              actuatorTargets[jointName] = config.angular ? current * RAD2DEG : current;
            }
          }
        }
        if (nextMode !== "torque") {
          actuatorTorqueTargets[jointName] = 0;
        }
        if (nextMode === "position") {
          actuatorVelocityTargets[jointName] = 0;
        }
      }
      filteredActuatorCtrl.clear();
      applyActuatorTargets();
    },
    setActuatorsArmed(armed) {
      actuatorsArmed = armed;
      if (!armed) {
        actuatorArmBlend = 0;
        if (ctrlView && ctrlView.length) ctrlView.fill(0);
        filteredActuatorCtrl.clear();
        return;
      }
      actuatorArmBlend = 0;
      filteredActuatorCtrl.clear();
      // Preserve existing targets when arming so the controller tracks the
      // current slider command immediately instead of snapping targets to qpos.
      applyActuatorTargets();
    },
    getJointPositions(names) {
      const result: Record<string, number> = {};
      if (!model || !data || !mujoco || !objJointType) return result;
      const list = names?.length ? names : Object.keys(actuatorTargets);
      for (const name of list) {
        const jointId = resolveJointId(name);
        if (jointId < 0) continue;
        const qposAdr = jntQposAdr[jointId];
        if (!Number.isFinite(qposAdr)) continue;
        result[name] = qposView[qposAdr] ?? 0;
      }
      return result;
    },
    setJointPositions(positions) {
      if (!model || !data || !mujoco || !objJointType) return;
      let changed = false;
      for (const [name, value] of Object.entries(positions)) {
        if (!Number.isFinite(value)) continue;
        const jointId = resolveJointId(name);
        if (jointId < 0) continue;
        const qposAdr = jntQposAdr[jointId];
        const qvelAdr = jntDofAdr[jointId];
        if (!Number.isFinite(qposAdr)) continue;
        qposView[qposAdr] = value;
        if (Number.isFinite(qvelAdr)) qvelView[qvelAdr] = 0;
        changed = true;
      }
      if (changed) {
        mujoco.mj_forward(model, data);
        syncBindings();
      }
    },
    setPointerForceConfig(config) {
      const rawStiffness = config.stiffnessNPerMeter;
      if (Number.isFinite(rawStiffness)) {
        pointerSpringStiffness = Math.max(1, Number(rawStiffness));
      }
      const rawMaxForce = config.maxForceN;
      if (Number.isFinite(rawMaxForce)) {
        pointerSpringMaxForce = Math.max(1, Number(rawMaxForce));
      }
    },
    beginPointerInteraction(objectId, worldPoint) {
      if (!model || !data || !mujoco) return "none";
      if (!Number.isFinite(worldPoint.x) || !Number.isFinite(worldPoint.y) || !Number.isFinite(worldPoint.z)) {
        return "none";
      }

      if (!pointerTarget) pointerTarget = new THREE.Vector3();
      pointerTarget.set(worldPoint.x, worldPoint.y, worldPoint.z);
      pointerDragState = null;
      pointerMode = "none";
      pointerSpringDebugState = null;
      pointerPrevValid = false;

      if (objectId) {
        const bodyId = bodyIdByObjectId.get(objectId);
        if (bodyId !== undefined && bodyId > 0 && bodyId < model.nbody) {
          const i3 = bodyId * 3;
          const i4 = bodyId * 4;
          if (i3 + 2 < xpos.length && i4 + 3 < xquat.length) {
            const mass = bodyMassView[bodyId] ?? 0;
            if (Number.isFinite(mass) && mass > 1e-6) {
              tmpBodyPos.set(xpos[i3], xpos[i3 + 1], xpos[i3 + 2]);
              tmpBodyQuat.set(xquat[i4 + 1], xquat[i4 + 2], xquat[i4 + 3], xquat[i4]);
              tmpBodyQuatInv.copy(tmpBodyQuat).invert();
              tmpLocalPoint.set(worldPoint.x, worldPoint.y, worldPoint.z).sub(tmpBodyPos).applyQuaternion(tmpBodyQuatInv);
              pointerDragState = {
                bodyId,
                localPoint: tmpLocalPoint.clone(),
              };
              pointerMode = "grab";
              parkPointerCursor();
              return "grab";
            }
          }
        }
      }

      if (pointerCursorMocapId >= 0) {
        pointerMode = "cursor";
        setPointerCursorPosition(pointerTarget);
        return "cursor";
      }

      pointerTarget = null;
      return "none";
    },
    updatePointerTarget(worldPoint) {
      if (!worldPoint) {
        pointerTarget = null;
        pointerSpringDebugState = null;
        pointerPrevValid = false;
        if (pointerMode === "cursor") parkPointerCursor();
        return;
      }
      if (!Number.isFinite(worldPoint.x) || !Number.isFinite(worldPoint.y) || !Number.isFinite(worldPoint.z)) {
        return;
      }
      if (!pointerTarget) pointerTarget = new THREE.Vector3();
      pointerTarget.set(worldPoint.x, worldPoint.y, worldPoint.z);
      if (pointerMode === "cursor") setPointerCursorPosition(pointerTarget);
    },
    endPointerInteraction() {
      pointerMode = "none";
      pointerTarget = null;
      pointerDragState = null;
      if (qfrcAppliedView.length) qfrcAppliedView.fill(0);
      pointerSpringDebugState = null;
      pointerPrevValid = false;
      parkPointerCursor();
    },
    getPointerSpringDebugState() {
      if (!pointerSpringDebugState) return null;
      return {
        anchor: { ...pointerSpringDebugState.anchor },
        target: { ...pointerSpringDebugState.target },
        force: { ...pointerSpringDebugState.force },
        forceMagnitudeN: pointerSpringDebugState.forceMagnitudeN,
        distanceMeters: pointerSpringDebugState.distanceMeters,
        stiffnessNPerMeter: pointerSpringDebugState.stiffnessNPerMeter,
        maxForceN: pointerSpringDebugState.maxForceN,
      };
    },
    getRuntimeColliderSnapshots() {
      return collectRuntimeColliderSnapshots();
    },
    getLastXML() {
      return lastXML;
    },
    dispose() {
      disposeModel();
    },
  };
}
