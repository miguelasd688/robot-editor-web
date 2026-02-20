import type { PluginDefinition } from "../app/core/plugins/types";

import files from "./explorer";
import assetLibrary from "./asset-library";
import viewport from "./viewport";
import consolePlugin from "./console";
import sceneInspector from "./scene-inspector";
import assetInspector from "./asset-inspector";
import editor from "./editor";
import actuatorController from "./actuator-controller";

export const plugins: PluginDefinition[] = [
  files,
  assetLibrary,
  viewport,
  consolePlugin,
  sceneInspector,
  assetInspector,
  editor,
  actuatorController,
];
