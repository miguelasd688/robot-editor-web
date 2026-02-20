import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const workspaceRoot = path.resolve(projectRoot, "..");
const runtimePluginRoot = path.resolve(workspaceRoot, "runtime-plugin-suite/src");

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: "@runtime-plugins", replacement: runtimePluginRoot },
      { find: /^react$/, replacement: path.resolve(projectRoot, "node_modules/react/index.js") },
      {
        find: /^react\/jsx-runtime$/,
        replacement: path.resolve(projectRoot, "node_modules/react/jsx-runtime.js"),
      },
      { find: /^react-dom$/, replacement: path.resolve(projectRoot, "node_modules/react-dom/index.js") },
    ],
  },
  server: {
    fs: {
      allow: [workspaceRoot],
    },
  },
});
