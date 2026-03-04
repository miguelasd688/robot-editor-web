import { create } from "zustand";

export type BrowserWorkspacePreviewStatus = "loading" | "ready" | "failed";

export type BrowserWorkspacePreviewEntry = {
  status: BrowserWorkspacePreviewStatus;
  dataUrl?: string;
  updatedAt: number;
};

type BrowserPreviewState = {
  workspacePreviews: Record<string, BrowserWorkspacePreviewEntry>;
  markLoading: (key: string) => void;
  setReady: (key: string, dataUrl: string) => void;
  setFailed: (key: string) => void;
  touch: (key: string) => void;
  evictOverflow: (maxEntries: number) => void;
};

const normalizePreviewKey = (key: string) => String(key ?? "").replace(/\\/g, "/").replace(/^\/+/, "");

const now = () => Date.now();

export const useBrowserPreviewStore = create<BrowserPreviewState>((set, get) => ({
  workspacePreviews: {},
  markLoading: (key) => {
    const normalized = normalizePreviewKey(key);
    if (!normalized) return;
    set((state) => ({
      workspacePreviews: {
        ...state.workspacePreviews,
        [normalized]: {
          status: "loading",
          updatedAt: now(),
        },
      },
    }));
  },
  setReady: (key, dataUrl) => {
    const normalized = normalizePreviewKey(key);
    if (!normalized || !dataUrl) return;
    set((state) => ({
      workspacePreviews: {
        ...state.workspacePreviews,
        [normalized]: {
          status: "ready",
          dataUrl,
          updatedAt: now(),
        },
      },
    }));
  },
  setFailed: (key) => {
    const normalized = normalizePreviewKey(key);
    if (!normalized) return;
    set((state) => ({
      workspacePreviews: {
        ...state.workspacePreviews,
        [normalized]: {
          status: "failed",
          updatedAt: now(),
        },
      },
    }));
  },
  touch: (key) => {
    const normalized = normalizePreviewKey(key);
    if (!normalized) return;
    const current = get().workspacePreviews[normalized];
    if (!current) return;
    set((state) => ({
      workspacePreviews: {
        ...state.workspacePreviews,
        [normalized]: {
          ...current,
          updatedAt: now(),
        },
      },
    }));
  },
  evictOverflow: (maxEntries) => {
    const limit = Number.isFinite(maxEntries) ? Math.max(1, Math.floor(maxEntries)) : 1;
    const entries = Object.entries(get().workspacePreviews);
    if (entries.length <= limit) return;
    const sortedByOldest = [...entries].sort((a, b) => {
      const tsA = Number(a[1]?.updatedAt ?? 0);
      const tsB = Number(b[1]?.updatedAt ?? 0);
      return tsA - tsB;
    });
    const overflow = sortedByOldest.length - limit;
    const next = { ...get().workspacePreviews };
    for (let index = 0; index < overflow; index += 1) {
      delete next[sortedByOldest[index][0]];
    }
    set({ workspacePreviews: next });
  },
}));
