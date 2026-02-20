import type { PluginDefinition } from "../../app/core/plugins/types";
import ConsolePanel from "./ConsolePanel";
import ConsoleHeaderActions from "./ConsoleHeaderActions";

const consolePlugin: PluginDefinition = {
  id: "console",
  name: "Console",
  version: "0.0.1",
  panels: [
    {
      id: "console",
      title: "Console",
      component: ConsolePanel,
      closable: false,
      defaultDock: "bottom",
      headerActions: ConsoleHeaderActions,
    },
  ],
};

export default consolePlugin;
