import { create } from "zustand";

export type BrowserWorkspacePreviewStatus = "loading" | "ready" | "failed";

export type BrowserPreviewEntry = {
  status: BrowserWorkspacePreviewStatus;
  dataUrl?: string;
  updatedAt: number;
};

export type BrowserWorkspacePreviewEntry = BrowserPreviewEntry;
export type BrowserLibraryItemPreviewEntry = BrowserPreviewEntry;

type BrowserPreviewState = {
  workspacePreviews: Record<string, BrowserPreviewEntry>;
  markLoading: (key: string) => void;
  setReady: (key: string, dataUrl: string) => void;
  setFailed: (key: string) => void;
  touch: (key: string) => void;
  evictOverflow: (maxEntries: number) => void;
  libraryItemPreviews: Record<string, BrowserPreviewEntry>;
  libraryCaptureQueue: string[];
  markLibraryItemLoading: (key: string) => void;
  setLibraryItemReady: (key: string, dataUrl: string) => void;
  setLibraryItemFailed: (key: string) => void;
  touchLibraryItem: (key: string) => void;
  evictLibraryItemOverflow: (maxEntries: number) => void;
  enqueueLibraryItemCapture: (key: string) => void;
  dequeueLibraryItemCapture: (key: string) => void;
};

const normalizePreviewKey = (key: string) => String(key ?? "").replace(/\\/g, "/").replace(/^\/+/, "");

const now = () => Date.now();

export const useBrowserPreviewStore = create<BrowserPreviewState>((set, get) => ({
  workspacePreviews: {},
  libraryItemPreviews: {},
  libraryCaptureQueue: [],
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
  markLibraryItemLoading: (key) => {
    const normalized = normalizePreviewKey(key);
    if (!normalized) return;
    set((state) => ({
      libraryItemPreviews: {
        ...state.libraryItemPreviews,
        [normalized]: {
          status: "loading",
          updatedAt: now(),
        },
      },
    }));
  },
  setLibraryItemReady: (key, dataUrl) => {
    const normalized = normalizePreviewKey(key);
    if (!normalized || !dataUrl) return;
    set((state) => ({
      libraryItemPreviews: {
        ...state.libraryItemPreviews,
        [normalized]: {
          status: "ready",
          dataUrl,
          updatedAt: now(),
        },
      },
    }));
  },
  setLibraryItemFailed: (key) => {
    const normalized = normalizePreviewKey(key);
    if (!normalized) return;
    set((state) => ({
      libraryItemPreviews: {
        ...state.libraryItemPreviews,
        [normalized]: {
          status: "failed",
          updatedAt: now(),
        },
      },
    }));
  },
  touchLibraryItem: (key) => {
    const normalized = normalizePreviewKey(key);
    if (!normalized) return;
    const current = get().libraryItemPreviews[normalized];
    if (!current) return;
    set((state) => ({
      libraryItemPreviews: {
        ...state.libraryItemPreviews,
        [normalized]: {
          ...current,
          updatedAt: now(),
        },
      },
    }));
  },
  evictLibraryItemOverflow: (maxEntries) => {
    const limit = Number.isFinite(maxEntries) ? Math.max(1, Math.floor(maxEntries)) : 1;
    const entries = Object.entries(get().libraryItemPreviews);
    if (entries.length <= limit) return;
    const sortedByOldest = [...entries].sort((a, b) => {
      const tsA = Number(a[1]?.updatedAt ?? 0);
      const tsB = Number(b[1]?.updatedAt ?? 0);
      return tsA - tsB;
    });
    const overflow = sortedByOldest.length - limit;
    const next = { ...get().libraryItemPreviews };
    for (let index = 0; index < overflow; index += 1) {
      delete next[sortedByOldest[index][0]];
    }
    set({ libraryItemPreviews: next });
  },
  enqueueLibraryItemCapture: (key) => {
    const normalized = normalizePreviewKey(key);
    if (!normalized) return;
    const current = get().libraryItemPreviews[normalized];
    if (current?.status === "ready") {
      get().touchLibraryItem(normalized);
      return;
    }
    set((state) => {
      const alreadyQueued = state.libraryCaptureQueue.includes(normalized);
      return {
        libraryItemPreviews: {
          ...state.libraryItemPreviews,
          [normalized]: {
            status: "loading",
            updatedAt: now(),
          },
        },
        libraryCaptureQueue: alreadyQueued ? state.libraryCaptureQueue : [...state.libraryCaptureQueue, normalized],
      };
    });
  },
  dequeueLibraryItemCapture: (key) => {
    const normalized = normalizePreviewKey(key);
    if (!normalized) return;
    set((state) => ({
      libraryCaptureQueue: state.libraryCaptureQueue.filter((queuedKey) => queuedKey !== normalized),
    }));
  },
}));
