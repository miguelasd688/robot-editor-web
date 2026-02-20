/* eslint-disable @typescript-eslint/no-explicit-any */
import { create } from "zustand";
import { useAppStore } from "./useAppStore";
import { useAssetStore } from "./useAssetStore";
import { setInitialFromObject } from "../assets/assetInstance";
import {
  createMujocoRuntime,
  type MujocoRuntime,
  type JointActuatorConfig,
  type PointerInteractionMode,
  type PointerSpringDebugState,
  type PointerWorldPoint,
} from "../physics/mujoco/MujocoRuntime";
import { buildModelSource, mergeMjcfSources, restoreInitialTransforms } from "../physics/mujoco/mujocoModelSource";
import { logError, logInfo, logWarn } from "../services/logger";
import { editorEngine } from "../editor/engineSingleton";
import { objectToTransform } from "../editor/adapters/three/transformAdapter";
import { upsertNodeTransform } from "../editor/document/ops";
import type { ProjectDoc, SceneNode, Transform } from "../editor/document/types";
import { applyPose, mapPoseByRobot } from "../physics/mujoco/PoseBufferService";
import { NameRegistry, sanitizeMjcfName } from "../physics/mujoco/mjcfNames";
import { buildActuatorRegistry, type ActuatorDescriptor } from "../physics/mujoco/ActuatorRegistry";
import type { UrdfImportOptions } from "../urdf/urdfImportOptions";
import { exportRobotToUrdf } from "../urdf/urdfExport";

type MujocoState = {
  noiseRate: number;
  noiseScale: number;
  pointerSpringStiffnessNPerM: number;
  pointerMaxForceN: number;
  isReady: boolean;
  isLoading: boolean;
  isDirty: boolean;
  lastError: string | null;
  actuatorsArmed: boolean;
  actuatorTargets: Record<string, number>;
  actuatorVelocityTargets: Record<string, number>;
  actuatorTorqueTargets: Record<string, number>;
  actuatorInitialTargets: Record<string, number>;
  actuatorConfigs: Record<string, JointActuatorConfig>;
  nameMapsByRobot: Record<string, import("../physics/mujoco/mjcfNames").MjcfNameMap>;
  actuatorTargetsByRobot: Record<string, Record<string, number>>;
  actuatorVelocityTargetsByRobot: Record<string, Record<string, number>>;
  actuatorTorqueTargetsByRobot: Record<string, Record<string, number>>;
  actuatorInitialTargetsByRobot: Record<string, Record<string, number>>;
  actuatorConfigsByRobot: Record<string, Record<string, JointActuatorConfig>>;
  actuatorRegistryByRobot: Record<string, ActuatorDescriptor[]>;

  setNoiseRate: (value: number) => void;
  setNoiseScale: (value: number) => void;
  setPointerSpringStiffnessNPerM: (value: number) => void;
  setPointerMaxForceN: (value: number) => void;
  getActuatorNames: () => string[];
  setActuatorControls: (controls: Record<string, number> | ArrayLike<number>) => void;
  setActuatorTargets: (targets: Record<string, number>) => void;
  setActuatorTarget: (joint: string, value: number) => void;
  setActuatorVelocityTargets: (targets: Record<string, number>) => void;
  setActuatorVelocityTarget: (joint: string, value: number) => void;
  setActuatorTorqueTargets: (targets: Record<string, number>) => void;
  setActuatorTorqueTarget: (joint: string, value: number) => void;
  setActuatorInitialTargets: (targets: Record<string, number>) => void;
  setActuatorConfigs: (configs: Record<string, JointActuatorConfig>) => void;
  setRobotActuatorTargets: (robotId: string, targets: Record<string, number>) => void;
  setRobotActuatorTarget: (robotId: string, joint: string, value: number) => void;
  setRobotActuatorVelocityTargets: (robotId: string, targets: Record<string, number>) => void;
  setRobotActuatorVelocityTarget: (robotId: string, joint: string, value: number) => void;
  setRobotActuatorTorqueTargets: (robotId: string, targets: Record<string, number>) => void;
  setRobotActuatorTorqueTarget: (robotId: string, joint: string, value: number) => void;
  setRobotActuatorInitialTargets: (robotId: string, targets: Record<string, number>) => void;
  setRobotActuatorConfigs: (robotId: string, configs: Record<string, JointActuatorConfig>) => void;
  setActuatorsArmed: (armed: boolean) => void;
  getJointPositions: (names?: string[]) => Record<string, number>;
  setJointPositions: (positions: Record<string, number>) => void;
  beginPointerInteraction: (objectId: string | null, worldPoint: PointerWorldPoint) => PointerInteractionMode;
  updatePointerTarget: (worldPoint: PointerWorldPoint | null) => void;
  endPointerInteraction: () => void;
  getPointerSpringDebugState: () => PointerSpringDebugState | null;
  getLastMJCF: () => string | null;
  updateInitialFromScene: () => void;
  markSceneDirty: () => void;
  captureCurrentPoseAsTargets: () => void;
  preview: () => void;
  applyInitialPose: () => void;

  reload: () => Promise<void>;
  tick: (dt: number) => void;
};

const runtimes = new Map<string, MujocoRuntime>();
let reloadChain: Promise<void> = Promise.resolve();
let reloadTimer: ReturnType<typeof setTimeout> | null = null;

function findRobotAncestorId(nodes: Record<string, SceneNode>, startId: string): string | null {
  let cur: string | null = startId;
  while (cur) {
    const node: SceneNode | undefined = nodes[cur];
    if (!node) return null;
    if (node.kind === "robot") return cur;
    cur = node.parentId ?? null;
  }
  return null;
}

function ensureUniqueJointNames(doc: ProjectDoc): ProjectDoc {
  const nodes = doc.scene.nodes;
  const registries = new Map<string, NameRegistry>();
  const nodesCopy: Record<string, SceneNode> = { ...nodes };
  let changed = false;

  const getRegistry = (robotId: string | null) => {
    const key = robotId ?? "__root__";
    let reg = registries.get(key);
    if (!reg) {
      reg = new NameRegistry("joint");
      registries.set(key, reg);
    }
    return reg;
  };

  const ordered = Object.values(nodes).sort((a, b) => a.id.localeCompare(b.id));
  for (const node of ordered) {
    const urdf = node.components?.urdf;
    if (!urdf || urdf.kind !== "joint") continue;
    const robotId = findRobotAncestorId(nodes, node.id);
    const registry = getRegistry(robotId);
    const rawName = urdf.joint.name || node.name || node.id;
    const unique = registry.claim(rawName);
    if (unique === urdf.joint.name && unique === node.name) continue;

    const nextUrdf = {
      ...urdf,
      joint: {
        ...urdf.joint,
        name: unique,
      },
    };
    nodesCopy[node.id] = {
      ...node,
      name: unique,
      components: {
        ...(node.components ?? {}),
        urdf: nextUrdf,
      },
    };
    changed = true;
  }

  if (!changed) return doc;
  return {
    ...doc,
    scene: {
      ...doc.scene,
      nodes: nodesCopy,
    },
  };
}

function resolveJointName(jointId: string): string | null {
  const node = editorEngine.getDoc().scene.nodes[jointId];
  const urdf = node?.components?.urdf;
  if (urdf?.kind === "joint") return urdf.joint.name;
  return null;
}

function resolveMjcfKey(
  robotId: string,
  jointId: string,
  nameMapsByRobot: Record<string, import("../physics/mujoco/mjcfNames").MjcfNameMap>
): string | null {
  const jointName = resolveJointName(jointId);
  if (!jointName) return null;
  const nameMap = nameMapsByRobot[robotId];
  return nameMap?.joints?.[jointName] ?? `${sanitizeMjcfName(robotId)}_${sanitizeMjcfName(jointName)}`;
}

function mapTargetsToMjcf<T>(
  byRobot: Record<string, Record<string, T>>,
  nameMapsByRobot: Record<string, import("../physics/mujoco/mjcfNames").MjcfNameMap>
) {
  return mapPoseByRobot(byRobot, (robotId, jointId) => resolveMjcfKey(robotId, jointId, nameMapsByRobot));
}

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

function buildAngularKeySet(registryByRobot: Record<string, ActuatorDescriptor[]>) {
  const keys = new Set<string>();
  for (const entries of Object.values(registryByRobot)) {
    for (const entry of entries) {
      if (entry.angular) keys.add(entry.mjcfJoint);
    }
  }
  return keys;
}

function convertTargetsToRadians(targets: Record<string, number>, angularKeys: Set<string>) {
  if (!angularKeys.size) return targets;
  const next: Record<string, number> = { ...targets };
  for (const [key, value] of Object.entries(next)) {
    if (!Number.isFinite(value)) continue;
    if (angularKeys.has(key)) {
      next[key] = value * DEG2RAD;
    }
  }
  return next;
}

function mergeByRobot<T>(
  primary: Record<string, Record<string, T>>,
  secondary: Record<string, Record<string, T>>
) {
  const result: Record<string, Record<string, T>> = {};
  const ids = new Set<string>([...Object.keys(primary), ...Object.keys(secondary)]);
  for (const id of ids) {
    const next = { ...(primary[id] ?? {}) } as Record<string, T>;
    const previous = secondary[id] ?? {};
    for (const key of Object.keys(next)) {
      if (Object.prototype.hasOwnProperty.call(previous, key)) {
        next[key] = previous[key] as T;
      }
    }
    result[id] = next;
  }
  return result;
}

function cloneByRobot<T>(byRobot: Record<string, Record<string, T>>) {
  const result: Record<string, Record<string, T>> = {};
  for (const [robotId, values] of Object.entries(byRobot)) {
    result[robotId] = { ...values };
  }
  return result;
}

function buildZeroTargetsByRobot(registryByRobot: Record<string, ActuatorDescriptor[]>) {
  const byRobot: Record<string, Record<string, number>> = {};
  for (const [robotId, entries] of Object.entries(registryByRobot)) {
    const targets: Record<string, number> = {};
    for (const entry of entries) {
      targets[entry.jointId] = 0;
    }
    byRobot[robotId] = targets;
  }
  return byRobot;
}

function applyPoseTargets(targets: Record<string, number>, preview: boolean, previewTargets?: Record<string, number>) {
  applyPose(runtimes.values(), targets, { preview, previewTargets });
}

function getRuntimeFor(key: string) {
  const existing = runtimes.get(key);
  if (existing) return existing;
  const created = createMujocoRuntime();
  runtimes.set(key, created);
  return created;
}

function disposeRuntimes(except: Set<string>) {
  for (const [key, rt] of runtimes.entries()) {
    if (except.has(key)) continue;
    rt.dispose();
    runtimes.delete(key);
  }
}

function isSameVec3(a?: { x: number; y: number; z: number }, b?: { x: number; y: number; z: number }) {
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function isSameTransform(a?: Transform, b?: Transform) {
  if (!a || !b) return false;
  return isSameVec3(a.position, b.position) && isSameVec3(a.rotation, b.rotation) && isSameVec3(a.scale, b.scale);
}

function syncSceneTransformsFromViewer(viewer: ReturnType<typeof useAppStore.getState>["viewer"]) {
  if (!viewer) return;
  const doc = editorEngine.getDoc();
  let nextDoc = doc;
  let changed = false;
  for (const node of Object.values(doc.scene.nodes)) {
    const obj = viewer.getObjectById(node.id);
    if (!obj) continue;
    const transform = objectToTransform(obj);
    if (isSameTransform(node.components?.transform, transform)) continue;
    nextDoc = upsertNodeTransform(nextDoc, node.id, transform);
    changed = true;
  }
  if (changed) {
    editorEngine.setDoc(nextDoc, "mujoco:reload-sync");
  }
}

export const useMujocoStore = create<MujocoState>((set, get) => {
  editorEngine.on("doc:changed", (event) => {
    const { registryByRobot } = buildActuatorRegistry(event.doc, get().nameMapsByRobot);
    set({ actuatorRegistryByRobot: registryByRobot });
  });

  const shouldPreview = () => {
    const { simState } = useAppStore.getState();
    const { isLoading, isReady } = get();
    return simState === "paused" && isReady && !isLoading;
  };

  const scheduleReload = () => {
    const { simState } = useAppStore.getState();
    if (simState !== "paused") return;
    if (get().isLoading) return;
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      if (get().isLoading) return;
      void get().reload();
    }, 250);
  };

  return {
  noiseRate: 1.2,
  noiseScale: 0.07,
  pointerSpringStiffnessNPerM: 200,
  pointerMaxForceN: 160,
  isReady: false,
  isLoading: false,
  isDirty: false,
  lastError: null,
  actuatorsArmed: false,
  actuatorTargets: {},
  actuatorVelocityTargets: {},
  actuatorTorqueTargets: {},
  actuatorInitialTargets: {},
  actuatorConfigs: {},
  nameMapsByRobot: {},
  actuatorTargetsByRobot: {},
  actuatorVelocityTargetsByRobot: {},
  actuatorTorqueTargetsByRobot: {},
  actuatorInitialTargetsByRobot: {},
  actuatorConfigsByRobot: {},
  actuatorRegistryByRobot: {},

  setNoiseRate: (value) => {
    set({ noiseRate: value });
    for (const rt of runtimes.values()) {
      rt.setNoiseRate(value);
    }
  },
  setNoiseScale: (value) => {
    set({ noiseScale: value });
    for (const rt of runtimes.values()) {
      rt.setNoiseScale(value);
    }
  },
  setPointerSpringStiffnessNPerM: (value) =>
    set((state) => {
      const next = Number.isFinite(value) ? Math.max(1, Number(value)) : state.pointerSpringStiffnessNPerM;
      for (const rt of runtimes.values()) {
        rt.setPointerForceConfig({
          stiffnessNPerMeter: next,
          maxForceN: state.pointerMaxForceN,
        });
      }
      return { pointerSpringStiffnessNPerM: next };
    }),
  setPointerMaxForceN: (value) =>
    set((state) => {
      const next = Number.isFinite(value) ? Math.max(1, Number(value)) : state.pointerMaxForceN;
      for (const rt of runtimes.values()) {
        rt.setPointerForceConfig({
          stiffnessNPerMeter: state.pointerSpringStiffnessNPerM,
          maxForceN: next,
        });
      }
      return { pointerMaxForceN: next };
    }),
  getActuatorNames: () => {
    const names = new Set<string>();
    for (const rt of runtimes.values()) {
      rt.getActuatorNames().forEach((name) => names.add(name));
    }
    return Array.from(names);
  },
  setActuatorControls: (controls) => {
    for (const rt of runtimes.values()) {
      rt.setActuatorControls(controls);
    }
  },
  setActuatorTargets: (targets) => {
    set({ actuatorTargets: targets });
    const preview = shouldPreview();
    const angularKeys = buildAngularKeySet(get().actuatorRegistryByRobot);
    const previewTargets = preview ? convertTargetsToRadians(targets, angularKeys) : undefined;
    applyPoseTargets(targets, preview, previewTargets);
  },
  setActuatorTarget: (joint, value) =>
    set((state) => {
      const next = { ...state.actuatorTargets, [joint]: value };
      const preview = shouldPreview();
      const angularKeys = buildAngularKeySet(state.actuatorRegistryByRobot);
      const previewTargets = preview ? convertTargetsToRadians(next, angularKeys) : undefined;
      applyPoseTargets(next, preview, previewTargets);
      return { actuatorTargets: next };
    }),
  setActuatorVelocityTargets: (targets) => {
    set({ actuatorVelocityTargets: targets });
    for (const rt of runtimes.values()) {
      rt.setActuatorVelocityTargets(targets);
    }
  },
  setActuatorVelocityTarget: (joint, value) =>
    set((state) => {
      const next = { ...state.actuatorVelocityTargets, [joint]: value };
      for (const rt of runtimes.values()) {
        rt.setActuatorVelocityTargets(next);
      }
      return { actuatorVelocityTargets: next };
    }),
  setActuatorTorqueTargets: (targets) => {
    set({ actuatorTorqueTargets: targets });
    for (const rt of runtimes.values()) {
      rt.setActuatorTorqueTargets(targets);
    }
  },
  setActuatorTorqueTarget: (joint, value) =>
    set((state) => {
      const next = { ...state.actuatorTorqueTargets, [joint]: value };
      for (const rt of runtimes.values()) {
        rt.setActuatorTorqueTargets(next);
      }
      return { actuatorTorqueTargets: next };
    }),
  setActuatorInitialTargets: (targets) => set({ actuatorInitialTargets: targets }),
  setActuatorConfigs: (configs) => {
    set({ actuatorConfigs: configs });
    for (const rt of runtimes.values()) {
      rt.setActuatorConfigs(configs);
    }
  },
  setRobotActuatorTargets: (robotId, targets) =>
    set((state) => {
      const byRobot = { ...state.actuatorTargetsByRobot, [robotId]: { ...targets } };
      const merged = mapTargetsToMjcf(byRobot, state.nameMapsByRobot);
      const preview = shouldPreview();
      const angularKeys = buildAngularKeySet(state.actuatorRegistryByRobot);
      const previewTargets = preview ? convertTargetsToRadians(merged, angularKeys) : undefined;
      applyPoseTargets(merged, preview, previewTargets);
      return { actuatorTargetsByRobot: byRobot, actuatorTargets: merged };
    }),
  setRobotActuatorTarget: (robotId, joint, value) =>
    set((state) => {
      const current = { ...(state.actuatorTargetsByRobot[robotId] ?? {}) };
      current[joint] = value;
      const byRobot = { ...state.actuatorTargetsByRobot, [robotId]: current };
      const merged = mapTargetsToMjcf(byRobot, state.nameMapsByRobot);
      const preview = shouldPreview();
      const angularKeys = buildAngularKeySet(state.actuatorRegistryByRobot);
      const previewTargets = preview ? convertTargetsToRadians(merged, angularKeys) : undefined;
      applyPoseTargets(merged, preview, previewTargets);
      return { actuatorTargetsByRobot: byRobot, actuatorTargets: merged };
    }),
  setRobotActuatorVelocityTargets: (robotId, targets) =>
    set((state) => {
      const byRobot = { ...state.actuatorVelocityTargetsByRobot, [robotId]: { ...targets } };
      const merged = mapTargetsToMjcf(byRobot, state.nameMapsByRobot);
      for (const rt of runtimes.values()) {
        rt.setActuatorVelocityTargets(merged);
      }
      return { actuatorVelocityTargetsByRobot: byRobot, actuatorVelocityTargets: merged };
    }),
  setRobotActuatorVelocityTarget: (robotId, joint, value) =>
    set((state) => {
      const current = { ...(state.actuatorVelocityTargetsByRobot[robotId] ?? {}) };
      current[joint] = value;
      const byRobot = { ...state.actuatorVelocityTargetsByRobot, [robotId]: current };
      const merged = mapTargetsToMjcf(byRobot, state.nameMapsByRobot);
      for (const rt of runtimes.values()) {
        rt.setActuatorVelocityTargets(merged);
      }
      return { actuatorVelocityTargetsByRobot: byRobot, actuatorVelocityTargets: merged };
    }),
  setRobotActuatorTorqueTargets: (robotId, targets) =>
    set((state) => {
      const byRobot = { ...state.actuatorTorqueTargetsByRobot, [robotId]: { ...targets } };
      const merged = mapTargetsToMjcf(byRobot, state.nameMapsByRobot);
      for (const rt of runtimes.values()) {
        rt.setActuatorTorqueTargets(merged);
      }
      return { actuatorTorqueTargetsByRobot: byRobot, actuatorTorqueTargets: merged };
    }),
  setRobotActuatorTorqueTarget: (robotId, joint, value) =>
    set((state) => {
      const current = { ...(state.actuatorTorqueTargetsByRobot[robotId] ?? {}) };
      current[joint] = value;
      const byRobot = { ...state.actuatorTorqueTargetsByRobot, [robotId]: current };
      const merged = mapTargetsToMjcf(byRobot, state.nameMapsByRobot);
      for (const rt of runtimes.values()) {
        rt.setActuatorTorqueTargets(merged);
      }
      return { actuatorTorqueTargetsByRobot: byRobot, actuatorTorqueTargets: merged };
    }),
  setRobotActuatorInitialTargets: (robotId, targets) =>
    set((state) => {
      const byRobot = { ...state.actuatorInitialTargetsByRobot, [robotId]: { ...targets } };
      const merged = mapTargetsToMjcf(byRobot, state.nameMapsByRobot);
      return { actuatorInitialTargetsByRobot: byRobot, actuatorInitialTargets: merged };
    }),
  setRobotActuatorConfigs: (robotId, configs) =>
    set((state) => {
      const byRobot = { ...state.actuatorConfigsByRobot, [robotId]: { ...configs } };
      const merged = mapTargetsToMjcf(byRobot, state.nameMapsByRobot);
      for (const rt of runtimes.values()) {
        rt.setActuatorConfigs(merged);
      }
      return { actuatorConfigsByRobot: byRobot, actuatorConfigs: merged };
    }),
  setActuatorsArmed: (armed) => {
    set({ actuatorsArmed: armed });
    for (const rt of runtimes.values()) {
      rt.setActuatorsArmed(armed);
    }
  },
  getJointPositions: (names) => {
    const result: Record<string, number> = {};
    for (const rt of runtimes.values()) {
      Object.assign(result, rt.getJointPositions(names));
    }
    return result;
  },
  setJointPositions: (positions) => {
    for (const rt of runtimes.values()) {
      rt.setJointPositions(positions);
    }
  },
  beginPointerInteraction: (objectId, worldPoint) => {
    const { simState } = useAppStore.getState();
    const { isReady, isLoading } = get();
    if (simState !== "playing" || !isReady || isLoading) return "none";

    let mode: PointerInteractionMode = "none";
    for (const rt of runtimes.values()) {
      const next = rt.beginPointerInteraction(objectId, worldPoint);
      if (next === "grab") return "grab";
      if (next === "cursor") mode = "cursor";
    }
    return mode;
  },
  updatePointerTarget: (worldPoint) => {
    for (const rt of runtimes.values()) {
      rt.updatePointerTarget(worldPoint);
    }
  },
  endPointerInteraction: () => {
    for (const rt of runtimes.values()) {
      rt.endPointerInteraction();
    }
  },
  getPointerSpringDebugState: () => {
    for (const rt of runtimes.values()) {
      const state = rt.getPointerSpringDebugState();
      if (state) return state;
    }
    return null;
  },
  getLastMJCF: () => {
    for (const rt of runtimes.values()) {
      const xml = rt.getLastXML();
      if (xml) return xml;
    }
    return null;
  },
  updateInitialFromScene: () => {
    const viewer = useAppStore.getState().viewer;
    if (!viewer) return;
    for (const root of viewer.getUserRoots()) {
      root.traverse((obj) => {
        setInitialFromObject(obj);
      });
    }
    set({ isDirty: true });
  },
  markSceneDirty: () => {
    set({ isDirty: true });
    scheduleReload();
  },
  captureCurrentPoseAsTargets: () => {
    const state = get();
    if (!state.isReady || state.isLoading) return;
    if (!Object.keys(state.actuatorRegistryByRobot).length) return;

    const jointNames = Object.values(state.actuatorRegistryByRobot)
      .flat()
      .map((entry) => entry.mjcfJoint);
    if (!jointNames.length) return;

    const livePositions = state.getJointPositions(jointNames);
    if (!Object.keys(livePositions).length) return;

    const nextTargetsByRobot = cloneByRobot(state.actuatorTargetsByRobot);
    let changed = false;

    for (const [robotId, entries] of Object.entries(state.actuatorRegistryByRobot)) {
      const nextRobotTargets = { ...(nextTargetsByRobot[robotId] ?? {}) };
      for (const entry of entries) {
        const live = livePositions[entry.mjcfJoint];
        if (!Number.isFinite(live)) continue;
        const nextValue = entry.angular ? (live as number) * RAD2DEG : (live as number);
        if (!Number.isFinite(nextValue)) continue;
        if (nextRobotTargets[entry.jointId] === nextValue) continue;
        nextRobotTargets[entry.jointId] = nextValue;
        changed = true;
      }
      nextTargetsByRobot[robotId] = nextRobotTargets;
    }

    if (!changed) return;

    const mergedTargets = mapTargetsToMjcf(nextTargetsByRobot, state.nameMapsByRobot);
    for (const rt of runtimes.values()) {
      rt.setActuatorTargets(mergedTargets);
    }
    set({ actuatorTargetsByRobot: nextTargetsByRobot, actuatorTargets: mergedTargets });
  },
  preview: () => {
    const state = get();
    if (!state.isReady || state.isDirty || state.isLoading) return;
    const { actuatorTargetsByRobot, nameMapsByRobot, actuatorRegistryByRobot } = state;
    const mergedTargets = mapTargetsToMjcf(actuatorTargetsByRobot, nameMapsByRobot);
    if (!Object.keys(mergedTargets).length) return;
    const angularKeys = buildAngularKeySet(actuatorRegistryByRobot);
    const previewTargets = convertTargetsToRadians(mergedTargets, angularKeys);
    applyPose(runtimes.values(), mergedTargets, { preview: true, previewTargets });
  },
  applyInitialPose: () => {
    if (!get().isReady) return;
    const { nameMapsByRobot } = get();
    const registryResult = buildActuatorRegistry(editorEngine.getDoc(), nameMapsByRobot);
    const nextInitialByRobot = registryResult.initialTargetsByRobot;
    const mergedInitial = mapTargetsToMjcf(nextInitialByRobot, nameMapsByRobot);
    if (!Object.keys(mergedInitial).length) return;
    const angularKeys = buildAngularKeySet(registryResult.registryByRobot);
    const mergedInitialRad = convertTargetsToRadians(mergedInitial, angularKeys);
    for (const rt of runtimes.values()) {
      rt.setJointPositions(mergedInitialRad);
    }
    set({ actuatorInitialTargetsByRobot: nextInitialByRobot, actuatorInitialTargets: mergedInitial });
  },

  reload: async () => {
    const run = async () => {
      const viewer = useAppStore.getState().viewer;
      if (!viewer) {
        logWarn("MuJoCo reload requested but viewer is not ready.", { scope: "mujoco" });
        alert("Viewport not ready (viewer is not mounted). Open the Viewport tab first.");
        return;
      }

      // Always reload with motors disarmed; users can arm explicitly from Actuators panel.
      get().setActuatorsArmed(false);

      const roots = viewer.getUserRoots();
      restoreInitialTransforms(roots);
      syncSceneTransformsFromViewer(viewer);
      const snapshot = viewer.getSceneSnapshot();
      const { noiseRate, noiseScale } = get();
      const { assets, urdfKey, urdfOptions } = useAssetStore.getState();
      const beforeDoc = editorEngine.getDoc();
      const sanitized = ensureUniqueJointNames(beforeDoc);
      if (sanitized !== beforeDoc) {
        editorEngine.setDoc(sanitized, "mujoco:joint-rename");
      }
      const doc = editorEngine.getDoc();
      const robotNodes = Object.values(doc.scene.nodes).filter((node) => node.kind === "robot");
      const warnings: string[] = [];

      set({ isLoading: true, lastError: null, isReady: false });
      try {
        if (robotNodes.length) {
          const nameMapsByRobot: Record<string, import("../physics/mujoco/mjcfNames").MjcfNameMap> = {};
          const sources = [];
          const nameMaps = [];
          for (const node of robotNodes) {
            const root = viewer.getObjectById(node.id);
            if (!root) continue;
            const sourceUrdf = node.components?.urdfSource ?? (root.userData?.urdfSource as string | undefined);
            let urdfSource = sourceUrdf;
            const urdfKeyForRobot =
              node.components?.urdfKey ?? (root.userData?.urdfKey as string | undefined) ?? null;
            const shouldRegenerateUrdf = Boolean(sourceUrdf) || Boolean(urdfKeyForRobot);
            if (shouldRegenerateUrdf) {
              try {
                const exported = exportRobotToUrdf(doc, node.id);
                urdfSource = exported.urdf;
                warnings.push(
                  ...exported.warnings.map(
                    (warning) => `[robot:${node.name || node.id}] ${warning}`
                  )
                );
              } catch (error) {
                logWarn("MuJoCo: failed to regenerate robot URDF from scene; using source URDF.", {
                  scope: "mujoco",
                  data: {
                    robotId: node.id,
                    error: String((error as Error)?.message ?? error),
                  },
                });
              }
            }
            const importOptions =
              node.components?.urdfImportOptions ??
              (root.userData?.urdfImportOptions as UrdfImportOptions | undefined);
            const perRobotUrdfOptions = {
              floatingBase: importOptions?.floatingBase ?? urdfOptions.floatingBase,
              firstLinkIsWorldReferenceFrame:
                importOptions?.firstLinkIsWorldReferenceFrame ?? urdfOptions.firstLinkIsWorldReferenceFrame,
              selfCollision: importOptions?.selfCollision ?? urdfOptions.selfCollision,
              collisionMode: importOptions?.collisionMode ?? urdfOptions.collisionMode,
            };
            logInfo("MuJoCo: building model source", { scope: "mujoco", data: { robotId: node.id } });
            const { source, warnings: localWarnings } = await buildModelSource({
              assets,
              urdfKey: urdfKeyForRobot,
              urdfSource,
              namePrefix: node.id,
              urdfOptions: perRobotUrdfOptions,
              roots: [root],
            });
            warnings.push(...localWarnings);
            if (source.kind === "mjcf") {
              sources.push(source);
              nameMaps.push(source.nameMap);
              if (source.nameMap) {
                nameMapsByRobot[node.id] = source.nameMap;
              }
            }
          }

          logInfo("MuJoCo: merging robot sources", { scope: "mujoco", data: { count: sources.length } });
          const merged = mergeMjcfSources({ sources, nameMaps });
          logInfo("MuJoCo: loading runtime", { scope: "mujoco", data: { mode: "single" } });
          const runtimeInstance = getRuntimeFor("default");
          await runtimeInstance.loadFromScene(snapshot, roots, { noiseRate, noiseScale }, merged.source);
          {
            const { pointerSpringStiffnessNPerM, pointerMaxForceN } = get();
            runtimeInstance.setPointerForceConfig({
              stiffnessNPerMeter: pointerSpringStiffnessNPerM,
              maxForceN: pointerMaxForceN,
            });
          }
          set({ nameMapsByRobot });

          const {
            actuatorConfigsByRobot,
            actuatorsArmed,
          } = get();
          const registryResult = buildActuatorRegistry(doc, nameMapsByRobot);
          const nextInitialByRobot = registryResult.initialTargetsByRobot;
          const nextTargetsByRobot = cloneByRobot(nextInitialByRobot);
          const nextVelocityByRobot = buildZeroTargetsByRobot(registryResult.registryByRobot);
          const nextTorqueByRobot = buildZeroTargetsByRobot(registryResult.registryByRobot);
          const nextConfigsByRobot = mergeByRobot(
            registryResult.configsByRobot,
            actuatorConfigsByRobot
          );
          const mergedTargets = mapTargetsToMjcf(nextTargetsByRobot, nameMapsByRobot);
          const mergedVelocity = mapTargetsToMjcf(nextVelocityByRobot, nameMapsByRobot);
          const mergedTorque = mapTargetsToMjcf(nextTorqueByRobot, nameMapsByRobot);
          const mergedInitial = mapTargetsToMjcf(nextInitialByRobot, nameMapsByRobot);
          const mergedConfigs = mapTargetsToMjcf(nextConfigsByRobot, nameMapsByRobot);
          runtimeInstance.setActuatorConfigs(mergedConfigs);
          runtimeInstance.setActuatorTargets(mergedTargets);
          runtimeInstance.setActuatorVelocityTargets(mergedVelocity);
          runtimeInstance.setActuatorTorqueTargets(mergedTorque);
          if (Object.keys(mergedTargets).length) {
            const angularKeys = buildAngularKeySet(registryResult.registryByRobot);
            runtimeInstance.setJointPositions(convertTargetsToRadians(mergedTargets, angularKeys));
          }
          runtimeInstance.setActuatorsArmed(actuatorsArmed);
          set({
            actuatorInitialTargetsByRobot: nextInitialByRobot,
            actuatorTargetsByRobot: nextTargetsByRobot,
            actuatorTargets: mergedTargets,
            actuatorVelocityTargetsByRobot: nextVelocityByRobot,
            actuatorVelocityTargets: mergedVelocity,
            actuatorTorqueTargetsByRobot: nextTorqueByRobot,
            actuatorTorqueTargets: mergedTorque,
            actuatorInitialTargets: mergedInitial,
            actuatorConfigsByRobot: nextConfigsByRobot,
            actuatorConfigs: mergedConfigs,
            actuatorRegistryByRobot: registryResult.registryByRobot,
          });

          const runtimeActuators = runtimeInstance.getActuatorNames();
          const expected = Object.values(registryResult.registryByRobot)
            .flat()
            .map((entry) => entry.actuatorName);
          const missing = expected.filter((name) => !runtimeActuators.includes(name));
          const extra = runtimeActuators.filter((name) => !expected.includes(name));
          logInfo("MuJoCo: actuator registry", {
            scope: "mujoco",
            data: {
              robots: Object.entries(registryResult.registryByRobot).map(([robotId, entries]) => ({
                robotId,
                count: entries.length,
                actuators: entries.map((entry) => ({
                  joint: entry.jointName,
                  mjcf: entry.mjcfJoint,
                  actuator: entry.actuatorName,
                  stiffness: entry.stiffness,
                  damping: entry.damping,
                  range: entry.range,
                })),
              })),
            },
          });
          logInfo("MuJoCo: actuators loaded", {
            scope: "mujoco",
            data: {
              runtimeCount: runtimeActuators.length,
              expectedCount: expected.length,
              missing: missing.slice(0, 16),
              extra: extra.slice(0, 16),
            },
          });

          disposeRuntimes(new Set(["default"]));
        } else {
          logInfo("MuJoCo: building model source", { scope: "mujoco" });
          const { source, warnings: localWarnings } = await buildModelSource({ assets, urdfKey, urdfOptions, roots });
          warnings.push(...localWarnings);
          logInfo("MuJoCo: loading runtime", { scope: "mujoco" });
          const runtimeInstance = getRuntimeFor("default");
          await runtimeInstance.loadFromScene(snapshot, roots, { noiseRate, noiseScale }, source);
          {
            const { pointerSpringStiffnessNPerM, pointerMaxForceN } = get();
            runtimeInstance.setPointerForceConfig({
              stiffnessNPerMeter: pointerSpringStiffnessNPerM,
              maxForceN: pointerMaxForceN,
            });
          }
          const nameMapsByRobot: Record<string, import("../physics/mujoco/mjcfNames").MjcfNameMap> = {};
          set({ nameMapsByRobot });

          const {
            actuatorConfigsByRobot,
            actuatorsArmed,
          } = get();
          const registryResult = buildActuatorRegistry(doc, nameMapsByRobot);
          const nextInitialByRobot = registryResult.initialTargetsByRobot;
          const nextTargetsByRobot = cloneByRobot(nextInitialByRobot);
          const nextVelocityByRobot = buildZeroTargetsByRobot(registryResult.registryByRobot);
          const nextTorqueByRobot = buildZeroTargetsByRobot(registryResult.registryByRobot);
          const nextConfigsByRobot = mergeByRobot(
            registryResult.configsByRobot,
            actuatorConfigsByRobot
          );
          const mergedTargets = mapTargetsToMjcf(nextTargetsByRobot, nameMapsByRobot);
          const mergedVelocity = mapTargetsToMjcf(nextVelocityByRobot, nameMapsByRobot);
          const mergedTorque = mapTargetsToMjcf(nextTorqueByRobot, nameMapsByRobot);
          const mergedInitial = mapTargetsToMjcf(nextInitialByRobot, nameMapsByRobot);
          const mergedConfigs = mapTargetsToMjcf(nextConfigsByRobot, nameMapsByRobot);
          runtimeInstance.setActuatorConfigs(mergedConfigs);
          runtimeInstance.setActuatorTargets(mergedTargets);
          runtimeInstance.setActuatorVelocityTargets(mergedVelocity);
          runtimeInstance.setActuatorTorqueTargets(mergedTorque);
          if (Object.keys(mergedTargets).length) {
            const angularKeys = buildAngularKeySet(registryResult.registryByRobot);
            runtimeInstance.setJointPositions(convertTargetsToRadians(mergedTargets, angularKeys));
          }
          runtimeInstance.setActuatorsArmed(actuatorsArmed);
          set({
            actuatorInitialTargetsByRobot: nextInitialByRobot,
            actuatorTargetsByRobot: nextTargetsByRobot,
            actuatorTargets: mergedTargets,
            actuatorVelocityTargetsByRobot: nextVelocityByRobot,
            actuatorVelocityTargets: mergedVelocity,
            actuatorTorqueTargetsByRobot: nextTorqueByRobot,
            actuatorTorqueTargets: mergedTorque,
            actuatorInitialTargets: mergedInitial,
            actuatorConfigsByRobot: nextConfigsByRobot,
            actuatorConfigs: mergedConfigs,
            actuatorRegistryByRobot: registryResult.registryByRobot,
          });

          const runtimeActuators = runtimeInstance.getActuatorNames();
          const expected = Object.values(registryResult.registryByRobot)
            .flat()
            .map((entry) => entry.actuatorName);
          const missing = expected.filter((name) => !runtimeActuators.includes(name));
          const extra = runtimeActuators.filter((name) => !expected.includes(name));
          logInfo("MuJoCo: actuator registry", {
            scope: "mujoco",
            data: {
              robots: Object.entries(registryResult.registryByRobot).map(([robotId, entries]) => ({
                robotId,
                count: entries.length,
                actuators: entries.map((entry) => ({
                  joint: entry.jointName,
                  mjcf: entry.mjcfJoint,
                  actuator: entry.actuatorName,
                  stiffness: entry.stiffness,
                  damping: entry.damping,
                  range: entry.range,
                })),
              })),
            },
          });
          logInfo("MuJoCo: actuators loaded", {
            scope: "mujoco",
            data: {
              runtimeCount: runtimeActuators.length,
              expectedCount: expected.length,
              missing: missing.slice(0, 16),
              extra: extra.slice(0, 16),
            },
          });
        }

        set({ isReady: true, isDirty: false });
        if (warnings.length) {
          logWarn("MuJoCo: asset conversion warnings", { scope: "mujoco", data: warnings });
        }
        logInfo("MuJoCo: ready", { scope: "mujoco" });
      } catch (e: any) {
        console.error(e);
        const msg = String(e?.message ?? e);
        const extra = warnings.length ? `\n${warnings.join("\n")}` : "";
        set({ lastError: `${msg}${extra}` });
        logError("MuJoCo: load failed", { scope: "mujoco", data: { message: msg } });
        alert("MuJoCo load failed. Check console.");
      } finally {
        set({ isLoading: false });
      }
    };

    const queued = reloadChain.then(run, run);
    reloadChain = queued.catch(() => {});
    await queued;
  },

  tick: (dt) => {
    if (useAppStore.getState().simState !== "playing") return;
    for (const rt of runtimes.values()) {
      rt.step(dt);
    }
  },
  };
});
