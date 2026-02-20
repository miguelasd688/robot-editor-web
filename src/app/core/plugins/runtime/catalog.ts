import type { RuntimePluginManifest } from "./types";

const runtimePluginsEnabled =
  String(import.meta.env.VITE_RUNTIME_PLUGINS_ENABLED ?? "true").toLowerCase() === "true";

const catalog: RuntimePluginManifest[] = [
  {
    id: "runtime.training.jobs",
    name: "Training Jobs",
    version: "0.1.0",
    entry: "training-panel",
    enabled: true,
    source: "workspace",
    entitlement: "training.pro",
  },
  {
    id: "runtime.training.recordings",
    name: "Training Recordings",
    version: "0.1.0",
    entry: "recordings-panel",
    enabled: true,
    source: "workspace",
    entitlement: "training.pro",
  },
];

export async function fetchRuntimePluginCatalog(): Promise<RuntimePluginManifest[]> {
  // POC:
  // Reemplaza este catálogo local por una llamada a tu API de entitlements.
  // Ejemplo futuro: GET /api/runtime-plugins -> manifiestos filtrados por usuario/licencia.
  if (!runtimePluginsEnabled) return [];
  return catalog;
}
