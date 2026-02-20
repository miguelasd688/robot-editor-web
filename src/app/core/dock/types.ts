import type React from "react";

export type DockId = "left" | "main" | "right" | "bottom";

export type PanelId = string;

export type PanelDef = {
  id: PanelId;
  title: string;
  defaultDock?: DockId;
  component: React.ComponentType;
  movable?: boolean; 
  closable?: boolean; // por si quieres fijar algunos
  headerActions?: React.ComponentType<{ dock: DockId; panelId: PanelId }>;
};
