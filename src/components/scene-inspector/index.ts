import type { PluginDefinition } from "../../app/core/plugins/types";
import InspectorPanel from "./InspectorPanel";

const sceneInspector: PluginDefinition = {
  id: "scene-inspector",
  name: "Scene Inspector",
  version: "0.0.1",
  panels: [
    {
      id: "inspector",
      title: "Scene",
      component: InspectorPanel,
      closable: true,
      defaultDock: "right",
    },
  ],
};

export default sceneInspector;
