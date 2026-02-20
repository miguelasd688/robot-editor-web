import { useLoaderStore } from "../store/useLoaderStore";
import { loadURDFObject, type URDFLoaderParams } from "./urdfLoader";

export function registerCoreLoaders() {
  // URDF loader
  useLoaderStore.getState().registerLoader<URDFLoaderParams>("urdf", async (_ctx, params) => {
    return await loadURDFObject(params);
  });

  // aquí en el futuro:
  // - "mujoco" -> parse xml + meshes -> Object3D
  // - "usd" -> loader (probablemente server-side o wasm)
}
