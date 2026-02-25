/* eslint-disable @typescript-eslint/no-explicit-any */
import { create } from "zustand";
import { normPath, resolveAssetUrl } from "../loaders/assetResolver";
import type { AssetEntry } from "../assets/assetRegistryTypes";
import type { UsdImportOptions } from "../usd/usdImportOptions";
import { logInfo } from "../services/logger";

const USD_EXTENSIONS = [".usd", ".usda", ".usdc", ".usdz"];

function isUsdFile(name: string) {
  const lower = name.toLowerCase();
  return USD_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

type AssetState = {
  assets: Record<string, AssetEntry>; // key -> entry
  urdfKey: string | null;
  urdfOptions: {
    urdfZUp: boolean;
    floatingBase: boolean;
    firstLinkIsWorldReferenceFrame: boolean;
    selfCollision: boolean;
    collisionMode: "mesh" | "fast";
  };
  usdKey: string | null;
  usdOptions: UsdImportOptions;

  importFiles: (files: FileList | File[]) => void;
  setURDF: (key: string) => void;
  setURDFOptions: (opts: Partial<AssetState["urdfOptions"]>) => void;
  setUSD: (key: string) => void;
  setUSDOptions: (opts: Partial<UsdImportOptions>) => void;
  clear: () => void;

  // conserva firma para no romper código existente
  resolve: (resourceUrl: string, baseKey?: string | null) => string | null;
};

export const useAssetStore = create<AssetState>((set, get) => ({
  assets: {},
  urdfKey: null,
  urdfOptions: {
    urdfZUp: String(import.meta.env.VITE_URDF_Z_UP ?? "false").toLowerCase() === "true",
    floatingBase: false,
    firstLinkIsWorldReferenceFrame: false,
    selfCollision: String(import.meta.env.VITE_URDF_SELF_COLLIDE ?? "false").toLowerCase() === "true",
    collisionMode: (() => {
      const raw = String(import.meta.env.VITE_URDF_MESH_MODE ?? "").toLowerCase();
      if (raw === "mesh") return "mesh";
      if (raw === "fast" || raw === "box" || raw === "sphere" || raw === "cylinder") return "fast";
      return "mesh";
    })(),
  },
  usdKey: null,
  usdOptions: {
    floatingBase: false,
    selfCollision: false,
    sourceUpAxis: "auto",
  },

  importFiles: (files) => {
    const list = Array.isArray(files) ? files : Array.from(files);
    const next: Record<string, AssetEntry> = { ...get().assets };

    for (const f of list) {
      const rawKey = (f as any).webkitRelativePath || f.name;
      const key = normPath(rawKey);
      if (!next[key]) {
        next[key] = { file: f, url: URL.createObjectURL(f), key };
      }
    }

    // auto-detect urdf si no hay
    let urdfKey = get().urdfKey;
    if (!urdfKey) {
      const found = Object.keys(next).find((k) => k.toLowerCase().endsWith(".urdf"));
      if (found) urdfKey = found;
    }

    // auto-detect usd si no hay
    let usdKey = get().usdKey;
    if (!usdKey) {
      const found = Object.keys(next).find((k) => isUsdFile(k));
      if (found) usdKey = found;
    }

    set({ assets: next, urdfKey, usdKey });
    if (list.length) {
      logInfo(`Workspace import: ${list.length} file(s)`, {
        scope: "assets",
        data: { urdfKey: urdfKey ?? null, usdKey: usdKey ?? null },
      });
    }
  },

  setURDF: (key) => set({ urdfKey: normPath(key) }),
  setURDFOptions: (opts) => set((state) => ({ urdfOptions: { ...state.urdfOptions, ...opts } })),

  setUSD: (key) => set({ usdKey: normPath(key) }),
  setUSDOptions: (opts) => set((state) => ({ usdOptions: { ...state.usdOptions, ...opts } })),

  clear: () => {
    const { assets } = get();
    Object.values(assets).forEach((e) => URL.revokeObjectURL(e.url));
    set({ assets: {}, urdfKey: null, usdKey: null });
  },

  resolve: (resourceUrl, baseKey) => {
    const { assets } = get();
    return resolveAssetUrl(assets, resourceUrl, baseKey);
  },
}));
