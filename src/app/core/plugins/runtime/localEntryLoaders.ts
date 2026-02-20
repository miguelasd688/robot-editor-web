import type { RuntimePluginModule } from "./types";

export const runtimeEntryLoaders = {
  "training-panel": async () => (await import("@runtime-plugins/training-plugin")) as RuntimePluginModule,
  "recordings-panel": async () => (await import("@runtime-plugins/recordings-plugin")) as RuntimePluginModule,
} as const satisfies Record<string, () => Promise<RuntimePluginModule>>;
