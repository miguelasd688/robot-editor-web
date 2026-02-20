import EditorPanel from "./EditorPanel";
import type { PluginDefinition } from "../../app/core/plugins/types";

const plugin: PluginDefinition = {
  id: "editor",
  name: "Editor",
  version: "0.1.0",
  panels: [
    {
      id: "editor",
      title: "Editor",
      component: EditorPanel,
      closable: true,
    },
  ],
};

export default plugin;
