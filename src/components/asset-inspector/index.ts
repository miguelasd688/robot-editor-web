import type { PluginDefinition } from "../../app/core/plugins/types";
import AssetInspectorPanel from "./AssetInspectorPanel";

const assetInspector: PluginDefinition = {
  id: "asset-inspector",
  name: "Properties Inspector",
  version: "0.0.1",
  panels: [
    {
      id: "asset-inspector",
      title: "Properties",
      component: AssetInspectorPanel,
      closable: true,
      defaultDock: "right",
    },
  ],
};

export default assetInspector;
