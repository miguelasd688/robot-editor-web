import { useLoaderStore } from "../store/useLoaderStore";
import { useAppStore } from "../store/useAppStore";
import { useMujocoStore } from "../store/useMujocoStore";
import { loadURDFObject, type URDFLoaderParams } from "./urdfLoader";
import { loadUSDObject, type USDLoaderParams } from "./usdLoader";

export function registerCoreLoaders() {
  // URDF loader
  useLoaderStore.getState().registerLoader<URDFLoaderParams>("urdf", async (_ctx, params) => {
    return await loadURDFObject(params);
  });

  // URDF post-load hook: pause simulation and reload MuJoCo physics
  useLoaderStore.getState().registerPostLoadHook("urdf", async () => {
    useAppStore.getState().pause();
    await useMujocoStore.getState().reload();
  });

  // USD loader (stub — full rendering requires usd-converter service integration)
  useLoaderStore.getState().registerLoader<USDLoaderParams>("usd", async (_ctx, params) => {
    return await loadUSDObject(params);
  });

  // USD post-load hook: same physics reload as URDF
  useLoaderStore.getState().registerPostLoadHook("usd", async () => {
    useAppStore.getState().pause();
    await useMujocoStore.getState().reload();
  });

  // future loaders:
  // - "mujoco" -> parse xml + meshes -> Object3D
  // - "gltf" -> GLTFLoader -> Object3D
}
