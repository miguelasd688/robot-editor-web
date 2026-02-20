/* eslint-disable @typescript-eslint/no-explicit-any */
import { create } from "zustand";
import type * as THREE from "three";
import type { Viewer } from "../viewer/Viewer";
import { useSceneStore } from "./useSceneStore";
import { useAppStore } from "./useAppStore";
import { getThreeAdapter } from "../editor/adapters/three/adapterSingleton";
import { useMujocoStore } from "./useMujocoStore";
import { logError, logInfo } from "../services/logger";

export type LoaderType = "urdf"; // luego: "mujoco" | "usd" | "gltf" | ...

export type LoadContext = { viewer: Viewer };
export type LoaderFn<TParams = unknown> = (ctx: LoadContext, params: TParams) => Promise<THREE.Object3D>;

type LoaderState = {
  loaders: Partial<Record<LoaderType, LoaderFn<any>>>;

  registerLoader: <TParams>(type: LoaderType, fn: LoaderFn<TParams>) => void;

  load: <TParams>(
    type: LoaderType,
    params: TParams,
    opts?: { name?: string; frame?: boolean }
  ) => Promise<{ rootId: string } | null>;
  remove: (rootId: string) => void;
  clear: () => void;

  isLoading: boolean;
  lastError: string | null;
};

async function loadWithViewer<TParams>(
  viewer: Viewer | null,
  type: LoaderType,
  params: TParams,
  opts?: { name?: string; frame?: boolean }
) {
  if (!viewer) {
    alert("Viewport not ready (viewer is not mounted). Open the Viewport tab first.");
    return null;
  }

  const loader = useLoaderStore.getState().loaders[type];
  if (!loader) throw new Error(`No loader registered for type "${type}"`);

  useLoaderStore.setState({ isLoading: true, lastError: null });
  logInfo(`Loader: ${type} start`, { scope: "loader" });
  try {
    const obj = await loader({ viewer }, params);

    const rootId = viewer.addToUserScene(obj, opts?.name, { frame: opts?.frame ?? false });
    const adapter = getThreeAdapter();
    adapter?.syncSceneFromViewer();
    if (!adapter) {
      const snap = viewer.getSceneSnapshot();
      useSceneStore.getState().replaceFromSnapshot(snap);
    }
    useSceneStore.getState().setSelected(rootId);
    useMujocoStore.getState().markSceneDirty();
    viewer.refreshUrdfDebug?.();

    if (type === "urdf") {
      useAppStore.getState().pause();
      await useMujocoStore.getState().reload();
    }

    logInfo(`Loader: ${type} completed`, { scope: "loader", data: { rootId } });
    return { rootId };
  } catch (e: any) {
    console.error(e);
    useLoaderStore.setState({ lastError: String(e?.message ?? e) });
    logError(`Loader: ${type} failed`, { scope: "loader", data: { error: String(e?.message ?? e) } });
    alert("Load failed. Check console.");
    return null;
  } finally {
    useLoaderStore.setState({ isLoading: false });
  }
}

function syncSnapshot(viewer: Viewer | null) {
  if (!viewer) return;
  const snap = viewer.getSceneSnapshot();
  useSceneStore.getState().replaceFromSnapshot(snap);
}

export const useLoaderStore = create<LoaderState>((set) => ({
  loaders: {},
  isLoading: false,
  lastError: null,

  registerLoader: (type, fn) => set((s) => ({ loaders: { ...s.loaders, [type]: fn } })),

  load: async (type, params, opts) => {
    const viewer = useAppStore.getState().viewer;
    return await loadWithViewer(viewer, type, params, opts);
  },

  remove: (rootId) => {
    const viewer = useAppStore.getState().viewer;
    if (!viewer) return;
    viewer.removeFromUserScene(rootId);
    useMujocoStore.getState().markSceneDirty();
    getThreeAdapter()?.syncSceneFromViewer();
    if (!getThreeAdapter()) syncSnapshot(viewer);
  },

  clear: () => {
    const viewer = useAppStore.getState().viewer;
    if (!viewer) return;
    viewer.clearUserScene();
    useMujocoStore.getState().markSceneDirty();
    getThreeAdapter()?.syncSceneFromViewer();
    if (!getThreeAdapter()) syncSnapshot(viewer);
  },
}));
