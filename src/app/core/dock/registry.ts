import type { PanelContribution } from "../plugins/types";
import { pluginManager } from "../plugins/host";
import type { PanelId } from "./types";

export function getPanelRegistry(): PanelContribution[] {
  return pluginManager.getPanels();
}

export function getPanelById(panelId: PanelId): PanelContribution | undefined {
  return pluginManager.getPanelById(panelId);
}
