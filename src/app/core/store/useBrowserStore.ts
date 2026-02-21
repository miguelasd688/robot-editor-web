import { create } from "zustand";
import type { BrowserDirectoryId } from "../browser/directories";

export type BrowserLocation = BrowserDirectoryId | "root";

type BrowserState = {
  activeDirectory: BrowserLocation;
  navigationVersion: number;
  setActiveDirectory: (directory: BrowserLocation) => void;
};

export const useBrowserStore = create<BrowserState>((set) => ({
  activeDirectory: "root",
  navigationVersion: 0,
  setActiveDirectory: (directory) =>
    set((state) => ({
      activeDirectory: directory,
      navigationVersion: state.navigationVersion + 1,
    })),
}));
