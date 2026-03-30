import type { DockId, PanelId } from "../dock/types";
import type React from "react";

export type TrainingJobStatus = "submitting" | "queued" | "provisioning" | "running" | "completed" | "failed" | "cancelled";
export type TrainingTrainer = "rsl_rl" | "rllib" | "sb3";
export type LearningTrend = "improving" | "flat" | "degrading" | "unknown";
export type LearningHealthReasonCode =
  | "LEARNING_SIGNAL_PRESENT"
  | "INSUFFICIENT_TRAINING_WINDOW"
  | "REWARD_FLAT"
  | "EPISODE_LENGTH_FLAT"
  | "METRICS_INCOMPLETE"
  | "CHECKPOINT_NOT_OBSERVED";
export type AgentArtifactReasonCode =
  | "CHECKPOINT_READY"
  | "CHECKPOINT_NOT_OBSERVED"
  | "CHECKPOINT_MANIFEST_MISSING"
  | "COMPATIBILITY_SIGNATURE_MISSING"
  | "ARTIFACT_PATH_MISSING";

export type LearningHealthSummary = {
  metricsSource: string;
  firstMetricStep: number;
  latestMetricStep: number;
  rewardTrend: LearningTrend;
  episodeLengthTrend: LearningTrend;
  valueLossTrend: LearningTrend;
  isLearningSignalPresent: boolean;
  reasonCode: LearningHealthReasonCode;
};

export type AgentArtifactSummary = {
  checkpointObserved: boolean;
  latestCheckpointStep: number;
  checkpointManifestPresent: boolean;
  compatibilitySignaturePresent: boolean;
  artifactReady: boolean;
  reasonCode: AgentArtifactReasonCode;
  artifactUri?: string | null;
  checkpointManifestPath?: string | null;
  experimentRevisionId?: string | null;
  registrationId?: string | null;
  taskFingerprint?: string | null;
  profileId?: string | null;
  agentPresetId?: string | null;
  adapterId?: string | null;
  backend?: string | null;
  algorithm?: string | null;
};

export type SubmitTrainingJobInput = {
  modelName: string;
  dataset: string;
  epochs: number;
  tenantId?: string;
  experimentName?: string;
  envId?: string;
  trainer?: TrainingTrainer;
  maxSteps?: number;
  seed?: number;
  config?: Record<string, unknown>;
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
  runRef?: string | null;
  failureReason?: string | null;
  tenantId?: string;
  experimentName?: string;
  experimentId?: string | null;
  experimentRevisionId?: string | null;
  envId?: string;
  maxSteps?: number;
  launchContext?: Record<string, unknown>;
  episodeTruthSummary?: Record<string, unknown> | null;
  episodeTruthMissing?: Record<string, unknown> | null;
  structuredMetricsTelemetry?: Record<string, unknown> | null;
  learningHealthSummary?: LearningHealthSummary | null;
  agentArtifactSummary?: AgentArtifactSummary | null;
};

export type TrainingArtifactKind = "checkpoint" | "model" | "metrics" | "log" | "video" | "dataset";

export type TrainingArtifactSummary = {
  id: string;
  jobId: string;
  kind: TrainingArtifactKind;
  uri: string;
  sizeBytes?: number;
  checksumSha256?: string;
  createdAt: string;
};

export type TrainingJobEventSummary = {
  id: string;
  jobId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type TrainingRunnerLogsSummary = {
  jobId: string;
  runnerJobId: string | null;
  totalLines: number;
  lines: string[];
  highlights: string[];
  runtime: Record<string, unknown> | null;
  unavailableReason?: string;
};

export type TrainingRecordingSummary = {
  id: string;
  jobId: string;
  tenantId?: string;
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
    deleteJob: (jobId: string, tenantId?: string) => void;
    startJobSync: () => () => void;
    getJobs: () => TrainingJobSummary[];
    getRecordings: () => TrainingRecordingSummary[];
    getTrainingTokens: () => number;
    getTrainingTokenCost: () => number;
    listArtifacts: (jobId: string, kind?: TrainingArtifactKind) => Promise<TrainingArtifactSummary[]>;
    listEvents: (jobId: string, limit?: number) => Promise<TrainingJobEventSummary[]>;
    listRunnerLogs: (jobId: string, tail?: number) => Promise<TrainingRunnerLogsSummary>;
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
