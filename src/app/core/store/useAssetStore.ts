/* eslint-disable @typescript-eslint/no-explicit-any */
import { create } from "zustand";
import { normPath, resolveAssetUrl } from "../loaders/assetResolver";
import type { AssetEntry } from "../assets/assetRegistryTypes";
import { logInfo } from "../services/logger";

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

  importFiles: (files: FileList | File[]) => void;
  setURDF: (key: string) => void;
  setURDFOptions: (opts: Partial<AssetState["urdfOptions"]>) => void;
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

    set({ assets: next, urdfKey });
    if (list.length) {
      logInfo(`Workspace import: ${list.length} file(s)`, {
        scope: "assets",
        data: { urdfKey: urdfKey ?? null },
      });
    }
  },

  setURDF: (key) => set({ urdfKey: normPath(key) }),
  setURDFOptions: (opts) => set((state) => ({ urdfOptions: { ...state.urdfOptions, ...opts } })),

  clear: () => {
    const { assets } = get();
    Object.values(assets).forEach((e) => URL.revokeObjectURL(e.url));
    set({ assets: {}, urdfKey: null });
  },

  resolve: (resourceUrl, baseKey) => {
    const { assets } = get();
    return resolveAssetUrl(assets, resourceUrl, baseKey);
  },
}));
