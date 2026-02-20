import type { PluginDefinition } from "../../app/core/plugins/types";
import ViewportPanel from "./ViewportPanel";

const viewport: PluginDefinition = {
  id: "viewport",
  name: "Viewport",
  version: "0.0.1",
  panels: [
    {
      id: "viewport",
      title: "Viewport",
      component: ViewportPanel,
      closable: false,
      keepAlive: true,
      defaultDock: "main",
    },
  ],
};

export default viewport;
