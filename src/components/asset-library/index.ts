import type { PluginDefinition } from "../../app/core/plugins/types";
import AssetLibraryPanel from "./AssetLibraryPanel";

const assetLibrary: PluginDefinition = {
  id: "browser",
  name: "Browser",
  version: "0.0.1",
  panels: [
    {
      id: "browser",
      title: "Browser",
      component: AssetLibraryPanel,
      closable: true,
      defaultDock: "bottom",
    },
  ],
};

export default assetLibrary;
