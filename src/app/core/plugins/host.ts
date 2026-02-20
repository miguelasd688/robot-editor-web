import { PluginManager } from "./PluginManager";
import type { PluginHostAPI } from "./types";
import { plugins } from "../../../components";
import { useAppStore } from "../store/useAppStore";
import { useRuntimeTrainingStore } from "../store/useRuntimeTrainingStore";
import { loadRuntimePlugins } from "./runtime/loadRuntimePlugins";
import { logError } from "../services/logger";

export const pluginHostApi: PluginHostAPI = {
  getViewer: () => useAppStore.getState().viewer,
  training: {
    submitJob: (input) => useRuntimeTrainingStore.getState().submitTrainingJob(input),
    cancelJob: (jobId) => useRuntimeTrainingStore.getState().cancelTrainingJob(jobId),
    getJobs: () => useRuntimeTrainingStore.getState().jobs.map((job) => ({ ...job })),
    getRecordings: () => useRuntimeTrainingStore.getState().recordings.map((recording) => ({ ...recording })),
    listArtifacts: (jobId, kind) => useRuntimeTrainingStore.getState().listTrainingArtifacts(jobId, kind),
    listEvents: (jobId, limit) => useRuntimeTrainingStore.getState().listTrainingJobEvents(jobId, limit),
    subscribe: (listener) =>
      useRuntimeTrainingStore.subscribe(() => {
        listener();
      }),
  },
};

export const pluginManager = new PluginManager(plugins);

let startPromise: Promise<void> | null = null;

/** Arranca plugins 1 vez (idempotente) */
export function startPlugins() {
  if (startPromise) return startPromise;

  startPromise = (async () => {
    const runtimePlugins = await loadRuntimePlugins();
    for (const runtimePlugin of runtimePlugins) {
      try {
        pluginManager.registerPlugins([runtimePlugin]);
      } catch (error) {
        logError(`Failed to register runtime plugin: ${runtimePlugin.id}`, {
          scope: "runtime-plugins",
          data: error,
        });
      }
    }
    pluginManager.start(pluginHostApi);
  })();

  return startPromise;
}
