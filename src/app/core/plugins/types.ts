import type { DockId, PanelId } from "../dock/types";
import type React from "react";

export type TrainingJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type SubmitTrainingJobInput = {
  modelName: string;
  dataset: string;
  epochs: number;
};

export type TrainingJobSummary = {
  id: string;
  modelName: string;
  dataset: string;
  epochs: number;
  status: TrainingJobStatus;
  progress: number;
  currentEpoch: number;
  loss: number | null;
  startedAt: number;
  updatedAt: number;
};

export type TrainingRecordingSummary = {
  id: string;
  jobId: string;
  title: string;
  createdAt: number;
  previewUrl: string | null;
  finalLoss: number;
  qualityScore: number;
};

export type PluginHostAPI = {
  // stores / servicios que sí quieres exponer
  getViewer: () => unknown; // luego tipas Viewer
  training: {
    submitJob: (input: SubmitTrainingJobInput) => string;
    cancelJob: (jobId: string) => void;
    getJobs: () => TrainingJobSummary[];
    getRecordings: () => TrainingRecordingSummary[];
    subscribe: (listener: () => void) => () => void;
  };
};

export type PanelContribution = {
  id: PanelId;
  title: string;
  component: React.ComponentType;
  icon?: React.ReactNode;
  closable?: boolean;
  keepAlive?: boolean;
  defaultDock?: "left" | "main" | "right" | "bottom";
  headerActions?: React.ComponentType<{ dock: DockId; panelId: PanelId }>;
};

export type PluginDefinition = {
  id: string;
  name: string;
  version: string;
  panels?: PanelContribution[];
  // futuro:
  // commands?: CommandContribution[];
  // inspectorTabs?: InspectorTabContribution[];
  // toolbarItems?: ToolbarContribution[];
  activate?: (api: PluginHostAPI) => void | (() => void);
};
