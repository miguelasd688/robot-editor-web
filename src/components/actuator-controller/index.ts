import type { PluginDefinition } from "../../app/core/plugins/types";
import ActuatorControllerPanel from "./ActuatorControllerPanel";

const actuatorController: PluginDefinition = {
  id: "actuator-controller",
  name: "Actuator Controller",
  version: "0.0.1",
  panels: [
    {
      id: "actuator-controller",
      title: "Actuators",
      component: ActuatorControllerPanel,
      closable: true,
      defaultDock: "right",
    },
  ],
};

export default actuatorController;
