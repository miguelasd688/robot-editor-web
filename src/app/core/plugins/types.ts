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
export type MetricsIngestionReasonCode =
  | "ADVANCING_SERIES"
  | "STALLED_SERIES"
  | "REPEATED_IDENTITY"
  | "FIELDS_MISSING"
  | "PARSE_REJECTED";
export type PolicyProgressReasonCode =
  | "VISIBLE_POLICY_DELTA"
  | "NO_VISIBLE_DELTA"
  | "EVAL_NOT_RUN"
  | "CHECKPOINT_MISSING"
  | "METRICS_TRUST_REQUIRED";
export type EvaluationArtifactReasonCode =
  | "COMPARISON_READY"
  | "BASELINE_VIDEO_MISSING"
  | "CANDIDATE_VIDEO_MISSING"
  | "CHECKPOINT_NOT_READY"
  | "EVAL_NOT_RUN";
export type TaskRealizationReasonCode =
  | "FULL_EXPERIMENT_REALIZATION"
  | "PARTIAL_EXPERIMENT_REALIZATION"
  | "CANONICAL_TASK_ONLY"
  | "MISSING_RUNTIME_BINDING"
  | "TASK_REALIZATION_UNCLEAR";
export type ManagerParityReasonCode =
  | "FULL_PARITY"
  | "EXPECTED_EXPERIMENT_DELTAS_ONLY"
  | "UNEXPECTED_MANAGER_DRIFT"
  | "CANONICAL_SAMPLE_NOT_RESOLVED"
  | "PARITY_EVAL_NOT_RUN";
export type RuntimeConfigArtifactReasonCode =
  | "CONFIG_ARTIFACTS_READY"
  | "TASK_CONFIG_MISSING"
  | "MANAGER_CONFIG_MISSING"
  | "CANONICAL_COMPARISON_MISSING"
  | "ARTIFACT_WRITE_FAILED";

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

export type MetricsIngestionSummary = {
  lastAcceptedStep: number;
  lastAcceptedTimestamp?: string | null;
  acceptedCount: number;
  dedupedCount: number;
  rejectedCount: number;
  reasonCode: MetricsIngestionReasonCode;
};

export type PolicyProgressSummary = {
  baselineCheckpointStep: number;
  candidateCheckpointStep: number;
  evaluationMode: string;
  behaviorDeltaObserved: boolean;
  reasonCode: PolicyProgressReasonCode;
};

export type EvaluationArtifactSummary = {
  baselineCheckpointStep: number;
  candidateCheckpointStep: number;
  baselineVideoPath?: string | null;
  candidateVideoPath?: string | null;
  comparisonReady: boolean;
  reasonCode: EvaluationArtifactReasonCode;
};

export type TaskRealizationSummary = {
  taskName: string;
  recipeId: string;
  registrationId: string;
  adapterId: string;
  realizationMode: string;
  sceneApplicationMode: string;
  sceneApplicationTarget: string;
  robotBindingApplied: boolean;
  terrainBindingApplied: boolean;
  managerBindingApplied: boolean;
  reasonCode: TaskRealizationReasonCode;
};

export type ManagerParitySummary = {
  taskParity: boolean;
  observationParity: boolean;
  actionParity: boolean;
  rewardParity: boolean;
  terminationParity: boolean;
  commandParity: boolean;
  resetParity: boolean;
  sceneBindingParity: boolean;
  diffDomains: string[];
  reasonCode: ManagerParityReasonCode;
};

export type RuntimeConfigArtifactSummary = {
  effectiveTaskConfigPath: string;
  effectiveManagerConfigPath: string;
  effectiveLaunchSpecPath: string;
  canonicalComparisonPath: string;
  taskRealizationSummaryPath: string;
  managerParitySummaryPath: string;
  runtimeConfigArtifactSummaryPath: string;
  artifactsReady: boolean;
  reasonCode: RuntimeConfigArtifactReasonCode;
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
  metricsIngestionSummary?: MetricsIngestionSummary | null;
  policyProgressSummary?: PolicyProgressSummary | null;
  evaluationArtifactSummary?: EvaluationArtifactSummary | null;
  taskRealizationSummary?: TaskRealizationSummary | null;
  managerParitySummary?: ManagerParitySummary | null;
  runtimeConfigArtifactSummary?: RuntimeConfigArtifactSummary | null;
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
