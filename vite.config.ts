import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const workspaceRoot = path.resolve(projectRoot, "..");
const runtimePluginRoot = path.resolve(workspaceRoot, "runtime-plugin-suite/src");

function buildTrainingApiProxy(target: string) {
  return {
    target,
    changeOrigin: true,
    secure: false,
    configure(proxy) {
      proxy.on("proxyReq", (proxyReq, req) => {
        const range = req.headers.range;
        if (range) {
          proxyReq.setHeader("Range", range);
        }
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot, "");
  // The frontend container needs a target reachable from inside Docker; the host gateway is the workspace default.
  const trainingApiProxyTarget = String(env.VITE_TRAINING_API_PROXY_TARGET ?? "").trim() || "http://172.17.0.1:8082";

  return {
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
      proxy: {
        "/v1": buildTrainingApiProxy(trainingApiProxyTarget),
      },
    },
    preview: {
      proxy: {
        "/v1": buildTrainingApiProxy(trainingApiProxyTarget),
      },
    },
  };
});
