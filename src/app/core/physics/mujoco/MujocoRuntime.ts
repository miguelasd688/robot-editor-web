/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from "three";
import loadMujoco, { type MainModule, type MjData, type MjModel } from "mujoco-js";
import type { SceneSnapshot } from "../../viewer/types";
import { ensureUserInstance } from "../../assets/assetInstance";
import type { InstancePhysics } from "../../assets/types";
import { computeInertiaFromGeom, inferGeomInfo, isValidInertia } from "../geomUtils";
import { sanitizeMjcfName, type MjcfNameMap } from "./mjcfNames";
import { getDocId } from "../../scene/docIds";

export type MujocoConfig = {
  noiseRate: number;
  noiseScale: number;
};

export type JointActuatorConfig = {
  stiffness: number;
  damping: number;
  velocityGain?: number;
  maxForce?: number;
  continuous?: boolean;
  angular?: boolean;
  mode?: "position" | "velocity" | "torque";
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

export type MujocoRuntime = {
  loadFromScene: (
    snapshot: SceneSnapshot,
    roots: THREE.Object3D[],
    config: MujocoConfig,
    source: MujocoModelSource
  ) => Promise<void>;
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
const DEFAULT_SCENE_JOINT_DAMPING = Number(import.meta.env.VITE_MUJOCO_SCENE_JOINT_DAMPING ?? "0.2");
const DEFAULT_SCENE_JOINT_ARMATURE = Number(import.meta.env.VITE_MUJOCO_SCENE_JOINT_ARMATURE ?? "0.01");
const DEFAULT_CONTACT_SOLREF = String(import.meta.env.VITE_MUJOCO_CONTACT_SOLREF ?? "0.02 1.2");
const DEFAULT_CONTACT_SOLIMP = String(import.meta.env.VITE_MUJOCO_CONTACT_SOLIMP ?? "0.9 0.95 0.001");
const POINTER_CURSOR_BODY_NAME = "__pointer_cursor_body";
const POINTER_CURSOR_PARK_Y_RAW = Number(import.meta.env.VITE_MUJOCO_POINTER_PARK_Y ?? "-1000");
const POINTER_CURSOR_RADIUS_RAW = Number(import.meta.env.VITE_MUJOCO_POINTER_RADIUS ?? "0.06");
const POINTER_DRAG_STIFFNESS_RAW = Number(import.meta.env.VITE_MUJOCO_POINTER_DRAG_STIFFNESS ?? "200");
const POINTER_DRAG_MAX_FORCE_RAW = Number(import.meta.env.VITE_MUJOCO_POINTER_DRAG_MAX_FORCE ?? "160");
const POINTER_DRAG_DAMPING_RATIO_RAW = Number(import.meta.env.VITE_MUJOCO_POINTER_DRAG_DAMPING_RATIO ?? "1");
const POINTER_CURSOR_PARK_Y = Number.isFinite(POINTER_CURSOR_PARK_Y_RAW) ? POINTER_CURSOR_PARK_Y_RAW : -1000;
const POINTER_CURSOR_RADIUS = Number.isFinite(POINTER_CURSOR_RADIUS_RAW) ? POINTER_CURSOR_RADIUS_RAW : 0.06;
const POINTER_DRAG_STIFFNESS = Number.isFinite(POINTER_DRAG_STIFFNESS_RAW) ? POINTER_DRAG_STIFFNESS_RAW : 200;
const POINTER_DRAG_MAX_FORCE = Number.isFinite(POINTER_DRAG_MAX_FORCE_RAW) ? POINTER_DRAG_MAX_FORCE_RAW : 160;
const POINTER_DRAG_DAMPING_RATIO = Number.isFinite(POINTER_DRAG_DAMPING_RATIO_RAW)
  ? Math.max(0, POINTER_DRAG_DAMPING_RATIO_RAW)
  : 1;
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

function buildSceneMJCF(roots: THREE.Object3D[], collisionMask?: CollisionMask) {
  const bodies: Array<{ name: string; object: THREE.Object3D }> = [];
  const lines: string[] = [];
  const jointActuators: string[] = [];
  const safe = (value: number, fallback = 0) => (Number.isFinite(value) ? value : fallback);
  const sceneJointDamping = Number.isFinite(DEFAULT_SCENE_JOINT_DAMPING) ? Math.max(0, DEFAULT_SCENE_JOINT_DAMPING) : 0;
  const sceneJointArmature =
    Number.isFinite(DEFAULT_SCENE_JOINT_ARMATURE) && DEFAULT_SCENE_JOINT_ARMATURE > 0
      ? DEFAULT_SCENE_JOINT_ARMATURE
      : 0;
  const contactSolref = DEFAULT_CONTACT_SOLREF.trim();
  const contactSolimp = DEFAULT_CONTACT_SOLIMP.trim();
  const contactAttr = `${contactSolref ? ` solref="${contactSolref}"` : ""}${contactSolimp ? ` solimp="${contactSolimp}"` : ""}`;

  lines.push(`<mujoco model="scene">`);
  lines.push(`  <option gravity="0 -9.81 0" integrator="implicitfast" timestep="0.002" iterations="80" />`);
  lines.push(`  <worldbody>`);

  const tmpPos = new THREE.Vector3();
  const tmpQuat = new THREE.Quaternion();
  const tmpScale = new THREE.Vector3();
  const tmpMat = new THREE.Matrix4();
  const tmpMatInv = new THREE.Matrix4();
  const cylinderYToZ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

  const candidates: THREE.Object3D[] = [];
  const linkCandidates: THREE.Object3D[] = [];
  const jointCandidates: THREE.Object3D[] = [];
  const visited = new Set<THREE.Object3D>();

  const shouldSimulate = (obj: THREE.Object3D) => {
    if ((obj as any).isURDFLink || (obj as any).isURDFJoint || (obj as any).isURDFCollider || (obj as any).isURDFVisual) {
      return false;
    }
    if (obj.userData?.editorRobotRoot) return false;
    if (obj.userData?.editorKind === "joint") return false;
    if (obj.userData?.editorKind === "visual" || obj.userData?.editorKind === "collision") return false;
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
  const otherCandidates = candidates.filter((obj) => !linkSet.has(obj) && !hasLinkAncestor(obj));

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

  const buildGeomEntriesForLink = (linkObj: THREE.Object3D) => {
    const collisionNodes = findCollisionNodes(linkObj);
    const geomEntries: Array<{
      info: ReturnType<typeof inferGeomInfo>;
      pos?: THREE.Vector3;
      quat?: THREE.Quaternion;
    }> = [];
    const appendEntry = (geomTarget: THREE.Object3D) => {
      const info = inferGeomInfo(geomTarget);
      const { pos, quat } = resolveRelativeTransform(linkObj, geomTarget);
      geomEntries.push({ info, pos, quat });
    };

    for (const collisionNode of collisionNodes) {
      const geomTargets = findMeshLikes(collisionNode);
      for (const geomTarget of geomTargets) {
        appendEntry(geomTarget);
      }
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
    entries: Array<{ info: ReturnType<typeof inferGeomInfo>; pos?: THREE.Vector3; quat?: THREE.Quaternion }>,
    frictionAttr: string,
    collisionAttr: string
  ) => {
    entries.forEach((entry, index) => {
      const geomName = entries.length === 1 ? `${bodyName}_geom` : `${bodyName}_geom_${index + 1}`;
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
    const geomEntries = buildGeomEntriesForLink(linkObj);
    const geomInfo = geomEntries[0]?.info;
    const rawMass = safe(physics.mass, 0);
    const mass = physics.fixed ? 0 : Math.max(0, rawMass);
    const safeMass = mass < 1e-4 ? 0 : mass;
    const friction = Math.max(0, safe(physics.friction, 0.5));
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

    const frictionAttr = ` friction="${friction.toFixed(4)} 0.005 0.0001"${contactAttr}`;
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
    const geomInfo = inferGeomInfo(obj);
    const isPlane = geomInfo.type === "plane";
    const rawMass = safe(physics.mass, 0);
    const mass = physics.fixed || isPlane ? 0 : Math.max(0, rawMass);
    const safeMass = mass < 1e-4 ? 0 : mass;
    const friction = Math.max(0, safe(physics.friction, 0.5));
    const collisionsEnabled = physics.collisionsEnabled !== false;
    const bodyName = sanitizeMjcfName(getDocId(obj), "body");
    bodies.push({ name: bodyName, object: obj });

    const pos = tmpPos.clone();
    const quat = tmpQuat.clone();
    const posAttr = `${safe(pos.x).toFixed(4)} ${safe(pos.y).toFixed(4)} ${safe(pos.z).toFixed(4)}`;
    const quatAttr = `${safe(quat.w, 1).toFixed(6)} ${safe(quat.x).toFixed(6)} ${safe(quat.y).toFixed(6)} ${safe(quat.z).toFixed(6)}`;
    const frictionAttr = ` friction="${friction.toFixed(4)} 0.005 0.0001"${contactAttr}`;
    const collisionAttr = collisionsEnabled
      ? collisionMask
        ? ` contype="${collisionMask.contype}" conaffinity="${collisionMask.conaffinity}"`
        : ""
      : ` contype="0" conaffinity="0"`;

    const inertiaGeom =
      geomInfo.type === "cylinder" && geomInfo.axis === "y" ? { ...geomInfo, axis: "z" as const } : geomInfo;
    const computedInertia = computeInertiaFromGeom(inertiaGeom, safeMass);

    if (safeMass <= 0 && geomInfo.type === "plane") {
      lines.push(
        `    <geom name="${bodyName}_geom" type="plane" size="${geomInfo.size}" pos="${posAttr}" quat="${quatAttr}"${frictionAttr}${collisionAttr} />`
      );
      return;
    }

    lines.push(`    <body name="${bodyName}" pos="${posAttr}" quat="${quatAttr}">`);
    if (safeMass > 0) lines.push(`      <freejoint />`);
    appendInertialLine("      ", physics, safeMass, computedInertia);
    appendGeomLines(
      "      ",
      bodyName,
      [{ info: geomInfo }],
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

  lines.push(`  </worldbody>`);
  if (jointActuators.length) {
    lines.push(`  <actuator>`);
    lines.push(...jointActuators);
    lines.push(`  </actuator>`);
  }
  lines.push(`</mujoco>`);

  return { xml: lines.join("\n"), bodies };
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
  // Imported URDF roots are tagged at root level; editor-built robots can also
  // carry `userData.urdf` on joints, so we must not classify them as imported.
  if (typeof root.userData?.urdfSource === "string" && root.userData.urdfSource.length > 0) return true;
  if (typeof root.userData?.urdfKey === "string" && root.userData.urdfKey.length > 0) return true;

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

function extractActuatorContent(xml: string) {
  const match = xml.match(/<actuator[^>]*>([\s\S]*?)<\/actuator>/i);
  if (!match) return "";
  return match[1].trim();
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
  const parkedY = Number.isFinite(POINTER_CURSOR_PARK_Y) ? POINTER_CURSOR_PARK_Y : -1000;
  return [
    `<body name="${POINTER_CURSOR_BODY_NAME}" mocap="true" pos="0 ${parkedY.toFixed(3)} 0">`,
    `  <geom name="${POINTER_CURSOR_BODY_NAME}_geom" type="sphere" size="${radius.toFixed(4)}"`,
    `        density="1" contype="8" conaffinity="65535" friction="0.001 0.0001 0.0001"`,
    `        solref="0.002 1.2" solimp="0.95 0.995 0.0001" rgba="1 0.3 0.3 0.15" />`,
    `</body>`,
  ].join("\n");
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

  const resolveActuatorId = (rawName: string) => {
    const cached = actuatorIdCache.get(rawName);
    if (cached !== undefined) return cached;
    let actuatorName = rawName;
    if (!actuatorByName.has(actuatorName)) {
      const rawCandidate = `${rawName}_motor`;
      if (actuatorByName.has(rawCandidate)) {
        actuatorName = rawCandidate;
      } else {
      const mappedJoint = jointNameMap?.joints?.[rawName];
      if (mappedJoint) {
        const candidate = `${mappedJoint}_motor`;
        if (actuatorByName.has(candidate)) actuatorName = candidate;
        else if (actuatorByName.has(mappedJoint)) actuatorName = mappedJoint;
      }
      }
    }
    const id = actuatorByName.get(actuatorName);
    actuatorIdCache.set(rawName, id ?? -1);
    return id ?? -1;
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
      const damping = Number.isFinite(config.damping) ? config.damping : 0;
      const velocityGain = Number.isFinite(config.velocityGain)
        ? Math.max(0, config.velocityGain as number)
        : Math.max(0.1, DEFAULT_ACTUATOR_VELOCITY_GAIN);
      const mode = config.mode ?? "position";
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

      const jointId = resolveJointId(jointName);
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
      const actuatorId = resolveActuatorId(jointName);
      if (actuatorId < 0) continue;
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
      mocapPosView[basePos + 1] = POINTER_CURSOR_PARK_Y;
      mocapPosView[basePos + 2] = 0;
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

      if (source.kind === "generated") {
        const built = buildSceneMJCF(roots);
        generatedBodies = built.bodies;
        xmlToWrite = built.xml;
      } else {
        xmlPath = `/working/${source.filename}`;
        xmlToWrite = source.content;
        const extraRoots = roots.filter((root) => !isUrdfRoot(root));
        if (extraRoots.length) {
          const extraCollisionMask = MUJOCO_SELF_COLLIDE
            ? { contype: 1, conaffinity: 1 }
            : { contype: 2, conaffinity: 3 };
          const built = buildSceneMJCF(extraRoots, extraCollisionMask);
          extraBodies = built.bodies;
          const extraWorld = extractWorldbodyContent(built.xml);
          const extraActuator = extractActuatorContent(built.xml);
          xmlToWrite = mergeWorldbody(xmlToWrite, extraWorld);
          xmlToWrite = mergeActuator(xmlToWrite, extraActuator);
          debugLog("merged extra roots", { count: extraRoots.length, extraBodies: built.bodies.length });
        }
        writeFileTree(mujoco, source.files);
      }

      xmlToWrite = mergeWorldbody(xmlToWrite, buildPointerCursorWorldbody());
      lastXML = xmlToWrite;
      ensureDirForPath(mujoco, xmlPath);
      (mujoco as any).FS.writeFile(xmlPath, xmlToWrite);

      if (MUJOCO_DEBUG) {
        try {
          const fs = (mujoco as any).FS;
          const exists = fs.analyzePath?.(xmlPath)?.exists;
          const size = exists ? fs.stat(xmlPath).size : 0;
          debugLog("xml file", { path: xmlPath, exists, size });
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

      setGravity(model, [0, -9.81, 0]);
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
      objJointType = mjtObjValue((mujoco as any).mjtObj?.mjOBJ_JOINT);
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
      const objBody = mjtObjValue((mujoco as any).mjtObj?.mjOBJ_BODY);
      if (generatedBodies) {
        for (const entry of generatedBodies) {
          const bodyId = mujoco.mj_name2id(model, objBody, entry.name);
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
            const bodyId = mujoco.mj_name2id(model, objBody, entry.name);
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
          const name = mujoco.mj_id2name(model, objBody, i);
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
      const pointerBodyId = mujoco.mj_name2id(model, objBody, POINTER_CURSOR_BODY_NAME);
      if (pointerBodyId >= 0 && pointerBodyId < bodyMocapIdView.length) {
        pointerCursorMocapId = bodyMocapIdView[pointerBodyId] ?? -1;
      }
      pointerMode = "none";
      pointerTarget = null;
      pointerDragState = null;
      pointerPrevValid = false;
      parkPointerCursor();

      syncBindings();
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
        let actuatorName = rawName;
        if (!actuatorByName.has(actuatorName)) {
          const mappedJoint = jointNameMap?.joints?.[rawName];
          if (mappedJoint) {
            const candidate = `${mappedJoint}_motor`;
            if (actuatorByName.has(candidate)) actuatorName = candidate;
            else if (actuatorByName.has(mappedJoint)) actuatorName = mappedJoint;
          }
        }
        const id = actuatorByName.get(actuatorName);
        if (id === undefined) continue;
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
        if (nextMode !== "velocity") {
          const jointId = resolveJointId(jointName);
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
      const RAD2DEG = 180 / Math.PI;
      for (const [jointName, config] of Object.entries(actuatorConfigs)) {
        if (!config) continue;
        const mode = config.mode ?? "position";
        if (mode === "velocity") continue;
        const jointId = resolveJointId(jointName);
        if (jointId < 0) continue;
        const qposAdr = jntQposAdr[jointId];
        if (!Number.isFinite(qposAdr)) continue;
        const current = qposView[qposAdr] ?? 0;
        actuatorTargets[jointName] = config.angular ? current * RAD2DEG : current;
      }
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
    getLastXML() {
      return lastXML;
    },
    dispose() {
      disposeModel();
    },
  };
}
