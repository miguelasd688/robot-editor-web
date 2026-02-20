import type { PanelId } from "../dock/types";
import type { PluginDefinition, PluginHostAPI, PanelContribution } from "./types";

export class PluginManager {
  private plugins: PluginDefinition[] = [];
  private disposers: Array<() => void> = [];
  private panels = new Map<PanelId, PanelContribution>();
  private started = false;

  constructor(plugins: PluginDefinition[] = []) {
    this.registerPlugins(plugins);
  }

  registerPlugins(plugins: PluginDefinition[]) {
    if (this.started) {
      throw new Error("Cannot register plugins after manager start.");
    }

    for (const plugin of plugins) {
      if (this.plugins.some((existing) => existing.id === plugin.id)) {
        throw new Error(`Duplicate plugin id: ${plugin.id}`);
      }
      this.plugins.push(plugin);
    }
  }

  start(api: PluginHostAPI) {
    if (this.started) return;
    this.started = true;

    // 1) registrar panels
    for (const p of this.plugins) {
      for (const panel of p.panels ?? []) {
        if (this.panels.has(panel.id)) {
          // evita colisiones silenciosas
          // (si te interesa, aquí puedes permitir override por prioridad)
          throw new Error(`Duplicate panel id: ${panel.id} (plugin: ${p.id})`);
        }
        this.panels.set(panel.id, panel);
      }
    }

    // 2) activate plugins
    for (const p of this.plugins) {
      const dispose = p.activate?.(api);
      if (typeof dispose === "function") this.disposers.push(dispose);
    }
  }

  stop() {
    for (const d of this.disposers.splice(0)) d();
    this.panels.clear();
    this.started = false;
  }

  getPanels(): PanelContribution[] {
    return Array.from(this.panels.values());
  }

  getPanelById(id: PanelId): PanelContribution | undefined {
    return this.panels.get(id);
  }
}
