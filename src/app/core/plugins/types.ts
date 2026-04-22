import type { DockId, PanelId } from "../dock/types";
import type React from "react";
import type { TrainingMetricBatchSummary } from "../services/trainingApiClient";

export type TrainingJobStatus = "submitting" | "queued" | "provisioning" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
export type TrainingTrainer = "rsl_rl" | "rllib" | "sb3";
export type LearningTrend = "improving" | "flat" | "degrading" | "unknown";
export type LearningHealthReasonCode =
  | "LEARNING_SIGNAL_PRESENT"
  | "INSUFFICIENT_TRAINING_WINDOW"
  | "REWARD_FLAT"
  | "EPISODE_LENGTH_FLAT"
  | "METRICS_INCOMPLETE"
  | "CHECKPOINT_NOT_OBSERVED"
  | "TRAINER_NOT_STARTED";
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

export type MetricsIngestionMetricRow = {
  trainerIteration: number;
  metricStep: number;
  occurredAt: string;
  progressRatio?: number | null;
  source?: string | null;
  sourceMarker?: string | null;
  episodeIndex?: number | null;
  rewardMean?: number | null;
  episodeLengthMean?: number | null;
  loss?: number | null;
  fps?: number | null;
  canonicalMetrics?: Record<string, unknown> | null;
  rawMetrics?: Record<string, unknown> | null;
  metrics?: Record<string, unknown> | null;
};
export type PolicyProgressReasonCode =
  | "VISIBLE_POLICY_DELTA"
  | "NO_VISIBLE_DELTA"
  | "EVAL_NOT_RUN"
  | "CHECKPOINT_MISSING"
  | "METRICS_TRUST_REQUIRED"
  | "TRAINER_NOT_STARTED";
export type EvaluationArtifactReasonCode =
  | "COMPARISON_READY"
  | "BASELINE_VIDEO_MISSING"
  | "CANDIDATE_VIDEO_MISSING"
  | "CHECKPOINT_NOT_READY"
  | "EVAL_NOT_RUN"
  | "TRAINER_NOT_STARTED";
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
  | "PARITY_EVAL_NOT_RUN"
  | "LIVE_RESET_AUTHORITY_NOT_REALIZED"
  | "LIVE_SCENE_BINDING_NOT_REALIZED"
  | "LIVE_OBSERVATION_NORMALIZATION_DRIFT";
export type TaskCompletenessReasonCode =
  | "COMPLETE_MANAGER_BASED_MDP"
  | "CANONICAL_TASK_ONLY"
  | "CANONICAL_TASK_WITH_RUNTIME_PATCH"
  | "AUTHORED_SURFACE_INCOMPLETE"
  | "MANAGER_CONTRACT_INCOMPLETE"
  | "EFFECTIVE_RUNTIME_INCOMPLETE"
  | "RESET_CONTRACT_INCOMPLETE"
  | "LIVE_ENV_UNRESOLVED"
  | "EPISODE_EVIDENCE_PENDING"
  | "SCENE_OWNERSHIP_UNSTABLE"
  | "RESET_OWNERSHIP_UNSTABLE"
  | "RESET_FALLBACK_OBSERVED"
  | "TASK_COMPLETENESS_UNCLEAR";
export type RuntimeConfigArtifactReasonCode =
  | "CONFIG_ARTIFACTS_READY"
  | "TASK_CONFIG_MISSING"
  | "MANAGER_CONFIG_MISSING"
  | "CANONICAL_COMPARISON_MISSING"
  | "ARTIFACT_WRITE_FAILED";

export type TaskMaterializationBlockerCode =
  | "TASK_MATERIALIZATION_PREFLIGHT_FAILED"
  | "TASK_MATERIALIZATION_TASK_CLASS_UNRESOLVED"
  | "TASK_MATERIALIZATION_ENV_CFG_INVALID"
  | "TASK_MATERIALIZATION_SCENE_BINDING_UNRESOLVED"
  | "TASK_MATERIALIZATION_PRIMARY_ROBOT_UNRESOLVED"
  | "TASK_MATERIALIZATION_ARTICULATION_UNRESOLVED"
  | "TASK_MATERIALIZATION_ACTION_MANAGER_MISSING"
  | "TASK_MATERIALIZATION_OBSERVATION_MANAGER_MISSING"
  | "TASK_MATERIALIZATION_POLICY_OBS_GROUP_MISSING"
  | "TASK_MATERIALIZATION_REWARD_MANAGER_MISSING"
  | "TASK_MATERIALIZATION_TERMINATION_MANAGER_MISSING"
  | "TASK_MATERIALIZATION_EVENT_MANAGER_MISSING"
  | "TASK_MATERIALIZATION_MANAGER_SURFACE_INCOMPLETE"
  | "TASK_MATERIALIZATION_LAUNCH_PARITY_MISSING";

export type TaskMaterializationSurface = {
  taskClassResolved: boolean;
  envCfgValid: boolean;
  sceneBindingReady: boolean;
  primaryRobotReady: boolean;
  articulationReady: boolean;
  actionManagerReady: boolean;
  observationManagerReady: boolean;
  policyObsGroupReady: boolean;
  rewardManagerReady: boolean;
  terminationManagerReady: boolean;
  eventManagerReady: boolean;
  managerSurfaceComplete: boolean;
};

export type TaskMaterializationSummary = {
  contractVersion: string;
  ready: boolean;
  reasonCode: TaskMaterializationBlockerCode | string;
  blockerCodes: string[];
  diagnostics: Array<{
    code: string;
    message: string;
    details?: Record<string, unknown>;
    severity?: string;
  }>;
  surface: TaskMaterializationSurface;
};

export type LaunchParitySummary = {
  contractVersion: string;
  ready: boolean;
  reasonCode: string;
  sameRegistration: boolean;
  sameTaskFingerprint: boolean;
  previewRegistrationId?: string | null;
  launchRegistrationId?: string | null;
  previewTaskFingerprint?: string | null;
  launchTaskFingerprint?: string | null;
  details?: Record<string, unknown>;
};

export type AgentInspectorReadiness = {
  sourceReady: boolean;
  sceneCompilationReady: boolean;
  embodimentReady: boolean;
  taskMaterializationReady: boolean;
  launchParityReady: boolean;
  admissionReady: boolean | null;
  trainingReady: boolean;
};

export type AgentInspectorSummary = {
  contractVersion: string;
  readiness: AgentInspectorReadiness;
  sourceReady: boolean;
  sceneCompilationReady: boolean;
  embodimentReady: boolean;
  taskMaterializationReady: boolean;
  launchParityReady: boolean;
  admissionReady: boolean | null;
  trainingReady: boolean;
  agentCompilationSummary?: Record<string, unknown> | null;
  taskMaterializationSummary?: TaskMaterializationSummary | null;
  launchParitySummary?: LaunchParitySummary | null;
};

export type CompiledTaskContractV2 = {
  contractVersion: "compiled_task_contract_v2";
  registrationId: string;
  taskFingerprint: string;
  authority: {
    sourceKind: "prepared_scene_primary_robot_embodiment";
    reason: string;
    evidenceChainId: string;
  };
  primaryRobot: {
    entityId: string;
    assetId: string;
    primPath: string;
    jointCount: number;
    rigidBodyCount: number;
    totalMass: number | null;
    cloneCompatibility: "compatible" | "incompatible" | "unknown";
  };
  sceneBindings: {
    robotAlias: "robot";
    resolvedEntities: Array<{
      managerDomain: "observations" | "actions" | "events" | "rewards" | "terminations" | "commands";
      termName: string;
      binding: string;
      resolved: boolean;
      details?: string;
    }>;
  };
  managerDomains: Record<string, unknown>;
  readiness: {
    validationReady: boolean;
    launchReady: boolean;
    blockingCodes: string[];
    advisoryCodes: string[];
  };
};

export type EpisodeRuntimeTraceEntry = {
  eventKind: string;
  phase: string;
  episodeIndex: number;
  resetCount: number;
  selectedResetSource: string;
  terminationKind: string;
  terminationTerms: string[];
  fallbackUsed: boolean | null;
  fallbackReason: string;
  scenePlacementRetained: boolean | null;
  scenePlacementConsumed: boolean | null;
  sceneAuthorityRetained: boolean | null;
  expectedResetAuthority?: string | null;
  observedResetAuthority?: string | null;
  expectedTerminationAuthority?: string | null;
  observedTerminationAuthority?: string | null;
  rootPoseApplied?: boolean | null;
  rootStateValid?: boolean | null;
  jointStateApplied?: boolean | null;
  rootDriftDetected?: boolean | null;
  jointDriftDetected?: boolean | null;
  causeCode: string;
  reasonCodes: string[];
  summary: string;
};

export type EpisodeRuntimeTraceSummary = {
  episodeRuntimeTraceSummaryVersion: string;
  traceMode: string;
  maxEntries: number;
  entryCount: number;
  firstEpisodeIndex: number | null;
  latestEpisodeIndex: number | null;
  entries: EpisodeRuntimeTraceEntry[];
  reasonCode: string;
  details: Record<string, unknown>;
};

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
  latestMetrics?: Record<string, unknown> | null;
  latestMetricRows?: MetricsIngestionMetricRow[];
  recentMetricRows?: MetricsIngestionMetricRow[];
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
  embodimentStatus: string;
  embodimentMismatchCodes: string[];
  embodimentBlockingCodes: string[];
  embodimentWarningCodes: string[];
  blockingCodes: string[];
  runtimeBindingMissing: boolean;
  managerParityReasonCode: string;
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
  domainMismatchReasons: Record<string, string>;
  reasonCode: ManagerParityReasonCode;
  details?: Record<string, unknown> | null;
};

export type TaskCompletenessSummary = {
  taskCompletenessSummaryVersion: string;
  taskName: string;
  profileId: string;
  registrationId: string;
  adapterId: string;
  realizationMode: string;
  observationsComplete: boolean;
  actionsComplete: boolean;
  rewardsComplete: boolean;
  resetsComplete: boolean;
  terminationsComplete: boolean;
  sceneOwnershipStable: boolean;
  resetOwnershipStable: boolean;
  episodeEvidenceObserved: boolean;
  terminationDrivenResets: boolean;
  upstreamResetFallbackObserved: boolean;
  missingDomains: string[];
  upstreamOwnedDomains: string[];
  reasonCode: TaskCompletenessReasonCode;
  resetBehaviorReasonCode: string;
  details?: Record<string, unknown> | null;
};

export type RuntimeConfigArtifactSummary = {
  effectiveTaskConfigPath: string;
  effectiveManagerConfigPath: string;
  effectiveLaunchSpecPath: string;
  canonicalComparisonPath: string;
  episodeRuntimeTraceSummaryPath: string;
  taskRealizationSummaryPath: string;
  taskCompletenessSummaryPath: string;
  managerParitySummaryPath: string;
  runtimeConfigArtifactSummaryPath: string;
  artifactsReady: boolean;
  reasonCode: RuntimeConfigArtifactReasonCode;
};

export type ProgressAxisSummary = {
  unit: string;
  current: number | null;
  total: number | null;
  ratio: number | null;
  source?: string;
};

export type RecordingProgressSummary = {
  unit: string;
  currentClipIndex: number | null;
  totalClipCount: number | null;
  sourceEpisodeIndex?: number | null;
  sourceVideoStep?: number | null;
  source?: string;
};

export type TrainingProgressSummary = {
  contractVersion: string;
  episodeAxisUnit: string;
  clipSourceField: string;
  trainingProgress: ProgressAxisSummary;
  episodeProgress: ProgressAxisSummary;
  iterationProgress: ProgressAxisSummary;
  checkpointProgress: ProgressAxisSummary;
  recordingProgress?: RecordingProgressSummary | null;
};

export type SubmitTrainingJobInput = {
  modelName: string;
  dataset: string;
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
  status: TrainingJobStatus;
  lifecycleStatus?: TrainingJobStatus;
  progress: number;
  currentEpoch: number;
  currentEpisode?: number;
  progressSummary?: TrainingProgressSummary | null;
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
  episodeTarget?: number;
  launchContext?: Record<string, unknown>;
  episodeTruthSummary?: Record<string, unknown> | null;
  episodeTruthMissing?: Record<string, unknown> | null;
  episodeRuntimeTraceSummary?: EpisodeRuntimeTraceSummary | null;
  structuredMetricsTelemetry?: Record<string, unknown> | null;
  liveTelemetrySummary?: Record<string, unknown> | null;
  metricsTruth?: Record<string, unknown> | null;
  recordingLiveSyncSummary?: Record<string, unknown> | null;
  learningHealthSummary?: LearningHealthSummary | null;
  agentArtifactSummary?: AgentArtifactSummary | null;
  metricsIngestionSummary?: MetricsIngestionSummary | null;
  policyProgressSummary?: PolicyProgressSummary | null;
  evaluationArtifactSummary?: EvaluationArtifactSummary | null;
  taskRealizationSummary?: TaskRealizationSummary | null;
  taskCompletenessSummary?: TaskCompletenessSummary | null;
  managerParitySummary?: ManagerParitySummary | null;
  runtimeConfigArtifactSummary?: RuntimeConfigArtifactSummary | null;
  taskMaterializationSummary?: TaskMaterializationSummary | null;
  launchParitySummary?: LaunchParitySummary | null;
  agentInspectorSummary?: AgentInspectorSummary | null;
  runtimeLaunchGateSummary?: Record<string, unknown> | null;
  embodimentAdmissionSummary?: Record<string, unknown> | null;
  preTrainerFailureSummary?: Record<string, unknown> | null;
  trainerFailureSummary?: Record<string, unknown> | null;
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

export type TrainingMetricHistoryRow = {
  trainerIteration: number;
  metricStep: number;
  occurredAt: string;
  progressRatio: number | null;
  source: string;
  sourceMarker: string | null;
  episodeIndex: number | null;
  reward?: number | null;
  episodeLength?: number | null;
  rewardMean: number | null;
  episodeLengthMean: number | null;
  loss: number | null;
  fps: number | null;
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
    getMetricHistoryByJob: () => Record<string, TrainingMetricHistoryRow[]>;
    listArtifacts: (jobId: string, kind?: TrainingArtifactKind) => Promise<TrainingArtifactSummary[]>;
    listEvents: (
      jobId: string,
      options?: number | { limit?: number; source?: "inspector" | "history_open" | "terminal_replay" }
    ) => Promise<TrainingJobEventSummary[]>;
    listMetricBatches: (
      jobId: string,
      options?:
        | number
        | {
            limit?: number;
            reason?: "terminal_replay" | "history_open" | "manual_recovery";
            sseDisconnectMs?: number;
          }
    ) => Promise<TrainingMetricBatchSummary[]>;
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
