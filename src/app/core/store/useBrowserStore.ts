import { create } from "zustand";
import type { BrowserDirectoryId } from "../browser/directories";

export type BrowserLocation = BrowserDirectoryId | "root";

type BrowserState = {
  activeDirectory: BrowserLocation;
  setActiveDirectory: (directory: BrowserLocation) => void;
};

export const useBrowserStore = create<BrowserState>((set) => ({
  activeDirectory: "root",
  setActiveDirectory: (directory) => set({ activeDirectory: directory }),
}));
