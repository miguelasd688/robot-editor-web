import { plugins } from "../../../components";
import { PluginManager } from "./PluginManager";
import { useLoaderStore } from "../store/useLoaderStore";
import { loadURDFObject, type URDFLoaderParams } from "../loaders/urdfLoader";

export function registerCoreLoaders() {
  useLoaderStore.getState().registerLoader("urdf", async (_ctx, params: URDFLoaderParams) => {
    return await loadURDFObject(params);
  });
}
export const pluginManager = new PluginManager(plugins);
