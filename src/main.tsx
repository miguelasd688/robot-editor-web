import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerCoreLoaders } from "./app/core/loaders/registerCoreLoaders";
import { startPlugins } from "./app/core/plugins/host";
import "./index.css";

registerCoreLoaders();
await startPlugins();
const { default: App } = await import("./App.tsx");

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
