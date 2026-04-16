import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const workspaceRoot = path.resolve(projectRoot, "..");
const runtimePluginRoot = path.resolve(workspaceRoot, "runtime-plugin-suite/src");

export default defineConfig({
  resolve: {
    alias: [
      { find: "@runtime-plugins/catalog", replacement: path.resolve(runtimePluginRoot, "catalog/index.ts") },
      { find: "@runtime-plugins/catalog/profiles", replacement: path.resolve(runtimePluginRoot, "catalog/profiles/index.ts") },
      { find: "@runtime-plugins/catalog/types", replacement: path.resolve(runtimePluginRoot, "catalog/types.ts") },
      { find: "@runtime-plugins", replacement: runtimePluginRoot },
    ],
  },
  test: {
    include: ["src/**/*.test.ts", "../runtime-plugin-suite/src/**/*.test.ts"],
    environment: "node",
  },
});
