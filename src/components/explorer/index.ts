import ExplorerPanel from "./ExplorerPanel";
import type { PluginDefinition } from "../../app/core/plugins/types";

const plugin: PluginDefinition = {
  id: "explorer",
  name: "Directories",
  version: "0.1.0",
  panels: [
    {
      id: "files",
      title: "Directories",
      component: ExplorerPanel,
      defaultDock: "left",
      closable: false,
    },
  ],
};

export default plugin;
