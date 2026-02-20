import { create } from "zustand";
import type { Viewer } from "../viewer/Viewer";

export type Vec3 = { x: number; y: number; z: number };

export type SelectedInfo = {
  id: string;
  name: string;
  position: Vec3;
};

export type SimState = "paused" | "playing";

type DockId = "left" | "main" | "right" | "bottom";

type AppState = {
  // sim
  simState: SimState;
  play: () => void;
  pause: () => void;
  reset: () => void;

  // selection
  selected: SelectedInfo | null;
  setSelected: (info: SelectedInfo | null) => void;
  setSelectedPosition: (pos: Vec3) => void;

  // panel tabs
  activeTabs: Record<DockId, string>;
  setActiveTab: (dock: DockId, tabId: string) => void;

  viewer: Viewer | null;
  setViewer: (v: Viewer | null) => void;
  isTransformDragging: boolean;
  setTransformDragging: (dragging: boolean) => void;
  // collapsible panels
  panelVisible: Record<Exclude<DockId, "main">, boolean>;
  togglePanel: (dock: Exclude<DockId, "main">) => void;
  setPanelVisible: (dock: Exclude<DockId, "main">, v: boolean) => void;
};

export const useAppStore = create<AppState>((set, get) => ({
  simState: "paused",
  play: () => set({ simState: "playing" }),
  pause: () => set({ simState: "paused" }),
  reset: () => set({ simState: "paused" }),

  selected: null,
  setSelected: (info) => set({ selected: info }),
  setSelectedPosition: (pos) => {
    const cur = get().selected;
    if (!cur) return;
    set({ selected: { ...cur, position: pos } });
  },
  viewer: null,
  setViewer: (v) => set({ viewer: v }),
  isTransformDragging: false,
  setTransformDragging: (dragging) => set({ isTransformDragging: dragging }),

  activeTabs: {
    left: "files",
    main: "viewport",
    right: "inspector",
    bottom: "console",
  },
  setActiveTab: (dock, tabId) =>
    set((s) => ({ activeTabs: { ...s.activeTabs, [dock]: tabId } })),

  panelVisible: {
    left: true,
    right: true,
    bottom: true,
  },
  togglePanel: (dock) =>
    set((s) => ({ panelVisible: { ...s.panelVisible, [dock]: !s.panelVisible[dock] } })),
  setPanelVisible: (dock, v) =>
    set((s) => ({ panelVisible: { ...s.panelVisible, [dock]: v } })),
}));
