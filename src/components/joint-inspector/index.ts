import type { PluginDefinition } from "../../app/core/plugins/types";
import JointInspectorPanel from "./JointInspectorPanel";

const jointInspector: PluginDefinition = {
  id: "joint-inspector",
  name: "Joint Inspector",
  version: "0.0.1",
  panels: [
    {
      id: "joint-inspector",
      title: "Joint",
      component: JointInspectorPanel,
      closable: true,
      defaultDock: "right",
    },
  ],
};

export default jointInspector;
