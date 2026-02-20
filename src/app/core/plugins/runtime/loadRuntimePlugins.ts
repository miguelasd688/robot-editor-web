import { logError, logInfo, logWarn } from "../../services/logger";
import type { PluginDefinition } from "../types";
import { fetchRuntimePluginCatalog } from "./catalog";
import { runtimeEntryLoaders } from "./localEntryLoaders";

const LOG_SCOPE = "runtime-plugins";

export async function loadRuntimePlugins(): Promise<PluginDefinition[]> {
  const manifests = await fetchRuntimePluginCatalog();
  const enabled = manifests.filter((manifest) => manifest.enabled);
  const loaded: PluginDefinition[] = [];

  for (const manifest of enabled) {
    const entryLoader = runtimeEntryLoaders[manifest.entry as keyof typeof runtimeEntryLoaders];
    if (!entryLoader) {
      logWarn(`Runtime plugin entry loader not found: ${manifest.entry}`, {
        scope: LOG_SCOPE,
        data: manifest,
      });
      continue;
    }

    try {
      const mod = await entryLoader();
      const plugin = mod.default;
      if (!plugin) {
        logWarn(`Runtime plugin has no default export: ${manifest.id}`, {
          scope: LOG_SCOPE,
          data: manifest,
        });
        continue;
      }

      if (plugin.id !== manifest.id) {
        logWarn(`Runtime plugin id mismatch for entry ${manifest.entry}`, {
          scope: LOG_SCOPE,
          data: { manifestId: manifest.id, pluginId: plugin.id },
        });
      }

      loaded.push(plugin);
      logInfo(`Runtime plugin loaded: ${plugin.id}`, {
        scope: LOG_SCOPE,
        data: { entry: manifest.entry, version: plugin.version },
      });
    } catch (error) {
      logError(`Runtime plugin failed to load: ${manifest.id}`, {
        scope: LOG_SCOPE,
        data: error,
      });
    }
  }

  return loaded;
}
