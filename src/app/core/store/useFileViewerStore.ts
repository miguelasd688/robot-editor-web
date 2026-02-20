import { create } from "zustand";

type FileViewerState = {
  activeFile: string | null;
  setActiveFile: (key: string | null) => void;
};

export const useFileViewerStore = create<FileViewerState>((set) => ({
  activeFile: null,
  setActiveFile: (key) => set({ activeFile: key }),
}));
