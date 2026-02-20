import type { PluginDefinition } from "../types";

export type RuntimePluginManifest = {
  id: string;
  name: string;
  version: string;
  entry: string;
  enabled: boolean;
  source: "workspace" | "remote";
  entitlement?: string;
};

export type RuntimePluginModule = {
  default: PluginDefinition;
};
