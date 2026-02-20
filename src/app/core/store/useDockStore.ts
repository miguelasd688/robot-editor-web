import { create } from "zustand";
import type { DockId, PanelId } from "../dock/types";

type DockAreaState = {
  tabs: PanelId[];
  active: PanelId | null;
};

type DockState = {
  areas: Record<DockId, DockAreaState>;
  initialized: boolean;

  setActive: (dock: DockId, panel: PanelId) => void;

  initFromPanels: (panels: Array<{ id: PanelId; defaultDock?: DockId }>) => void;
  openPanel: (dock: DockId, panel: PanelId) => void;
  closePanel: (dock: DockId, panel: PanelId) => void;

  movePanel: (panel: PanelId, toDock: DockId, toIndex?: number) => void;

  isOpen: (panel: PanelId) => { dock: DockId; index: number } | null;
};

// helpers
function removeFromAll(areas: DockState["areas"], panel: PanelId) {
  (Object.keys(areas) as DockId[]).forEach((d) => {
    const a = areas[d];
    const idx = a.tabs.indexOf(panel);
    if (idx >= 0) {
      a.tabs.splice(idx, 1);
      if (a.active === panel) a.active = a.tabs[0] ?? null;
    }
  });
}

const emptyAreas: Record<DockId, DockAreaState> = {
  left: { tabs: [], active: null },
  main: { tabs: [], active: null },
  right: { tabs: [], active: null },
  bottom: { tabs: [], active: null },
};

const buildAreasFromPanels = (panels: Array<{ id: PanelId; defaultDock?: DockId }>) => {
  const areas: Record<DockId, DockAreaState> = structuredClone(emptyAreas);
  for (const p of panels) {
    if (!p.defaultDock) continue;
    areas[p.defaultDock].tabs.push(p.id);
    areas[p.defaultDock].active ??= p.id;
  }
  return areas;
};

export const useDockStore = create<DockState>((set, get) => ({
  areas: structuredClone(emptyAreas),
  initialized: false,

  setActive: (dock, panel) =>
    set((s) => {
      const area = s.areas[dock];
      if (!area.tabs.includes(panel)) return s;
      return { areas: { ...s.areas, [dock]: { ...area, active: panel } } };
    }),

  initFromPanels: (panels) =>
    set((s) => {
      if (s.initialized) return s;
      const hasTabs = Object.values(s.areas).some((a) => a.tabs.length > 0);
      if (hasTabs) return { ...s, initialized: true };
      return { areas: buildAreasFromPanels(panels), initialized: true };
    }),

  openPanel: (dock, panel) =>
    set((s) => {
      const areas = structuredClone(s.areas);
      removeFromAll(areas, panel);
      const target = areas[dock];
      if (!target.tabs.includes(panel)) target.tabs.push(panel);
      target.active = panel;
      return { areas };
    }),

  closePanel: (dock, panel) =>
    set((s) => {
      const areas = structuredClone(s.areas);
      const a = areas[dock];
      const idx = a.tabs.indexOf(panel);
      if (idx < 0) return s;

      a.tabs.splice(idx, 1);
      if (a.active === panel) a.active = a.tabs[0] ?? null;
      return { areas };
    }),

  movePanel: (panel, toDock, toIndex) =>
    set((s) => {
      const areas = structuredClone(s.areas);
      removeFromAll(areas, panel);

      const target = areas[toDock];
      const idx =
        typeof toIndex === "number"
          ? Math.max(0, Math.min(target.tabs.length, toIndex))
          : target.tabs.length;

      target.tabs.splice(idx, 0, panel);
      target.active = panel;
      return { areas };
    }),

  isOpen: (panel) => {
    const areas = get().areas;
    for (const dock of Object.keys(areas) as DockId[]) {
      const idx = areas[dock].tabs.indexOf(panel);
      if (idx >= 0) return { dock, index: idx };
    }
    return null;
  },
}));
