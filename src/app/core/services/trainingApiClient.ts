import type {
  SubmitTrainingJobInput,
  TrainingArtifactKind,
  TrainingArtifactSummary,
  TrainingJobEventSummary,
  TrainingRunnerLogsSummary,
  TrainingJobSummary,
} from "../plugins/types";

type TrainingJobListResponse = {
  items: TrainingJobSummary[];
};

type EmptyListCooldownKey = string;

type EmptyListCooldownEntry = {
  emptyAt: number;
};

type TrainingValidationError = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  status?: number;
};

export type TrainingRunnerAssetMeta = {
  assetId: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
  createdAt: string;
  uri: string;
};

export type TrainingUsdBundleFileInput = {
  path: string;
  contentBase64: string;
  contentType?: string;
};

export type TrainingMjcfToUsdConversionMeta = {
  sourceAssetId: string;
  sourceFilename: string;
  outputFilename: string;
  convertedAssetId: string;
  convertedAssetUri: string;
  mode: "dry_run" | "isaac_lab";
  stdoutTail?: string;
  stderrTail?: string;
};

export type UsdJointInfo = {
  name: string;
  type: "revolute" | "prismatic" | "fixed" | "other";
  axis: [number, number, number];
  parentBody?: string | null;
  childBody?: string | null;
  parentBodyPath?: string | null;
  childBodyPath?: string | null;
  localPos0?: [number, number, number] | null;
  localRot0?: [number, number, number, number] | null;
  localPos1?: [number, number, number] | null;
  localRot1?: [number, number, number, number] | null;
  frame0Local?: UsdFramePose | null;
  frame1Local?: UsdFramePose | null;
  frame0World?: UsdFramePose | null;
  frame1World?: UsdFramePose | null;
  axisLocal?: [number, number, number] | null;
  axisWorld?: [number, number, number] | null;
  sourceUpAxis?: StageUpAxis;
  normalizedToZUp?: boolean;
  frameMismatchDistance?: number;
  frameMismatchWarning?: string;
  muscle?: UsdMuscleInfo | null;
};

export type UsdFramePose = {
  position: [number, number, number];
  quaternion: [number, number, number, number]; // xyzw
};

export type UsdMuscleEndpoint = {
  body?: string | null;
  localPos: [number, number, number];
};

export type UsdMuscleInfo = {
  enabled: boolean;
  endA: UsdMuscleEndpoint;
  endB: UsdMuscleEndpoint;
  range?: [number, number];
  force?: number;
  scale?: number;
  damping?: number;
};

export type StageUpAxis = "X" | "Y" | "Z" | "unknown";
export type ConversionProfile = "generic" | "manager";
export type TrainingExecutionMode = "manager";

export type MassByBodyEntry = {
  path: string;
  mass: number;
};

export type InvalidRootJointEntry = {
  path: string;
  reason: string;
};

export type PhysicsDiagnostics = {
  totalMass: number;
  massByBody: MassByBodyEntry[];
  invalidRootJoints: InvalidRootJointEntry[];
  articulationRootCount: number;
  hasCloneRisk: boolean;
};

export type BaseConstraintDiagnostics = {
  hasFixedRootJoint: boolean;
  effectiveBaseConstraintMode: "fix_base" | "source_weld";
  forceFixRootLink: boolean;
};

export type UsdIntrospectionMeta = {
  assetId: string;
  filename: string;
  joints: UsdJointInfo[];
  rootBodies: string[];
  stageUpAxis?: StageUpAxis;
  totalMass?: number;
  massByBody?: MassByBodyEntry[];
  invalidRootJoints?: InvalidRootJointEntry[];
  articulationRootCount?: number;
  hasCloneRisk?: boolean;
};

export type DerivedTrainingConfig = {
  slider_dof_name?: string;
  pole_dof_name?: string;
  control_mode?: string;
  dof_count?: number;
};

export type EditorRobotModelJoint = {
  jointId: string;
  jointName: string;
  jointType: string;
  axis?: [number, number, number] | null;
  axisLabel?: string;
  rangeLabel?: string;
  actuated: boolean;
  note?: string;
};

export type EditorRobotModelActuator = {
  jointId: string;
  jointName: string;
  type?: string;
  actuatorType?: "position" | "velocity" | "torque" | "muscle";
  actuatorName?: string;
  enabled?: boolean;
  sourceType?: string;
  stiffness?: number | null;
  damping?: number | null;
  initialPosition?: number | null;
};

export type EditorRobotModel = {
  contractVersion: "editor_robot_model_v1";
  robotId: string;
  robotName: string;
  actuatorCount: number;
  dofCount: number;
  jointCount: number;
  freeAxisCount?: number;
  actuatedFreeAxisCount?: number;
  passiveCount?: number;
  rootBodies?: string[] | null;
  actuators: EditorRobotModelActuator[];
  joints: EditorRobotModelJoint[];
};

export type RobotDiagnosticsTrace = {
  canonicalSourceKind?: string | null;
  canonicalityReason?: string | null;
  evidenceChainId?: string | null;
  robotDiagnosticsMode?: "scene_driven_contract" | "raw_usd_contract" | string | null;
  assetProvenanceMode?: "raw_usd_optional" | "raw_usd_primary" | string | null;
  editorRobotModel?: {
    status?: "missing" | "accepted" | "malformed";
    sent?: boolean;
    accepted?: boolean;
    reason?: string | null;
    actuatorCount?: number | null;
    dofCount?: number | null;
    jointCount?: number | null;
    rootBodyCount?: number | null;
  } | null;
};

export type ConfigDerivationPreview = {
  assetId: string;
  introspection: {
    jointCount: number;
    joints: UsdJointInfo[];
    rootBodies: string[];
    stageUpAxis?: StageUpAxis;
  };
  derivedConfig: DerivedTrainingConfig;
  taskConfig: Record<string, unknown>;
  physicsDiagnostics?: PhysicsDiagnostics;
  baseDiagnostics?: BaseConstraintDiagnostics;
  expressionHints?: TrainingExpressionHints;
  message: string;
};

export type CustomTrainingEnvironmentPlacement = {
  entityId: string;
  sourceAssetId?: string;
  localTransform?: {
    translation?: [number, number, number];
    rotationQuat?: [number, number, number, number];
    scale?: [number, number, number];
  };
};

export type CustomTrainingEnvironmentPayload = Record<string, unknown> & {
  placements?: CustomTrainingEnvironmentPlacement[];
};

export type CustomTrainingTaskRequest = {
  sourcePayloadVersion?: string;
  tenantId?: string;
  experimentName?: string;
  seed?: number;
  dryRun?: boolean;
  environment: CustomTrainingEnvironmentPayload;
  agent: Record<string, unknown>;
  runtime: Record<string, unknown>;
  profileId?: string;
  profileVersion?: string;
  baseTaskId?: string;
  registrationId?: string;
  agentPresetId?: string;
  adapterId?: string;
  adapterVersion?: string;
  editorRobotModel?: EditorRobotModel;
  editorSceneContract?: Record<string, unknown>;
  experimentTaskSpec?: Record<string, unknown>;
  experimentTaskRegistration?: Record<string, unknown> | null;
  adapterSelection?: Record<string, unknown> | null;
  experimentContext?: Record<string, unknown> | null;
  sceneActivation?: Record<string, unknown> | null;
  robotEmbodimentSpec?: Record<string, unknown> | null;
  agentCompilation?: Record<string, unknown> | null;
  compiledTaskContractV2?: Record<string, unknown> | null;
  taskMaterializationSummary?: Record<string, unknown> | null;
  launchParitySummary?: Record<string, unknown> | null;
  agentInspectorSummary?: Record<string, unknown> | null;
  authoredProfileContract?: Record<string, unknown> | null;
  taskFingerprint?: string;
  experimentTaskId?: string;
  experimentId?: string;
  experimentRevisionId?: string;
  compatibilitySignature?: Record<string, unknown>;
};

export type TaskAutocompletePreview = {
  dryRun: true;
  recipeId?: string;
  executionMode?: TrainingExecutionMode;
  taskSpecId?: string;
  taskSpec?: Record<string, unknown>;
  task?: string;
  profileId?: string;
  profileVersion?: string;
  baseTaskId?: string;
  registrationId?: string;
  agentPresetId?: string;
  adapterId?: string;
  adapterVersion?: string;
  adapterSelection?: Record<string, unknown> | null;
  adapterCompatibility?: Record<string, unknown> | null;
  experimentId?: string;
  experimentRevisionId?: string;
  taskFingerprint?: string;
  experimentTaskId?: string;
  experimentTaskSpec?: Record<string, unknown>;
  experimentTaskRegistration?: Record<string, unknown> | null;
  editorSceneContract?: Record<string, unknown>;
  experimentContext?: Record<string, unknown> | null;
  resolvedLaunchPlan?: Record<string, unknown> | null;
  runtimeAssetManifest?: Record<string, unknown> | null;
  sceneActivation?: Record<string, unknown> | null;
  compatibilitySignature?: Record<string, unknown>;
  authoredProfileContract?: Record<string, unknown> | null;
  experiment?: Record<string, unknown> | null;
  experimentRevision?: Record<string, unknown> | null;
  taskTemplate: string;
  assetId: string;
  introspection: {
    jointCount: number;
    joints: UsdJointInfo[];
    rootBodies: string[];
    stageUpAxis?: StageUpAxis;
  };
  derivedConfig: DerivedTrainingConfig;
  taskConfig: Record<string, unknown>;
  physicsDiagnostics?: PhysicsDiagnostics;
  expressionHints?: TrainingExpressionHints;
  environmentPreview: Record<string, unknown>;
  resolvedAgent?: AgentVariant;
  warnings?: string[];
  validationErrors?: TrainingValidationError[];
  compatibility?: Array<{
    category: string;
    code: string;
    severity: "info" | "warning" | "error";
    message: string;
    context?: Record<string, unknown>;
  }>;
  featureCoverage?: Array<{
    feature: string;
    label: string;
    status: "supported" | "preview_only" | "blocked" | "not_applicable";
    severity: "info" | "warning" | "error";
    message: string;
    context?: Record<string, unknown>;
  }>;
  robotDiagnostics?: Record<string, unknown> | null;
  robotDiagnosticsTrace?: RobotDiagnosticsTrace | null;
  robotEmbodimentSpec?: Record<string, unknown> | null;
  agentCompilation?: Record<string, unknown> | null;
  compiledTaskContractV2?: Record<string, unknown> | null;
  taskMaterializationSummary?: Record<string, unknown> | null;
  launchParitySummary?: Record<string, unknown> | null;
  agentInspectorSummary?: Record<string, unknown> | null;
  launchParityTrace?: Record<string, unknown> | null;
  launchDiagnostics?: Record<string, unknown> | null;
  scenePreparation?: Record<string, unknown> | null;
  launchReadiness?: {
    status: "prepared" | "missing_but_preparable" | "blocked";
    blockers: string[];
    warnings: string[];
  } | null;
  catalogVersion?: string;
  message: string;
};

export type TaskAutocompleteLaunchResponse = {
  recipeId?: string;
  executionMode?: TrainingExecutionMode;
  taskSpecId?: string;
  profileId?: string;
  baseTaskId?: string;
  agentPresetId?: string;
  adapterId?: string;
  experimentTaskId?: string;
  taskFingerprint?: string;
  experimentTaskSpec?: Record<string, unknown>;
  editorSceneContract?: Record<string, unknown>;
  job: TrainingJobSummary;
  task: string;
  policy: Record<string, unknown>;
  deduplicated?: boolean;
  resolvedAgent?: AgentVariant;
  warnings?: string[];
  catalogVersion?: string;
  taskTemplate: string;
  autoConfig: {
    assetId: string;
    introspection: {
      jointCount: number;
      joints: UsdJointInfo[];
      rootBodies: string[];
      stageUpAxis?: StageUpAxis;
    };
    derivedConfig: DerivedTrainingConfig;
    expressionHints?: TrainingExpressionHints;
  };
};

export type CustomTrainingTaskLaunchResponse = {
  mode: "custom";
  job: TrainingJobSummary;
  profileId?: string;
  profileVersion?: string;
  baseTaskId?: string;
  registrationId?: string;
  agentPresetId?: string;
  adapterId?: string;
  adapterVersion?: string;
  adapterSelection?: Record<string, unknown> | null;
  adapterCompatibility?: Record<string, unknown> | null;
  experimentId?: string;
  experimentRevisionId?: string;
  experimentTaskId?: string;
  taskFingerprint?: string;
  experimentTaskSpec?: Record<string, unknown>;
  experimentTaskRegistration?: Record<string, unknown> | null;
  editorSceneContract?: Record<string, unknown>;
  compatibilitySignature?: Record<string, unknown>;
  authoredProfileContract?: Record<string, unknown> | null;
  experiment?: Record<string, unknown> | null;
  experimentRevision?: Record<string, unknown> | null;
  warnings?: string[];
  validationErrors?: TrainingValidationError[];
  diagnostics?: Array<{ code: string; severity: "warning" | "error"; message: string; context?: Record<string, unknown> }>;
  compatibility?: Array<{ category: string; code: string; severity: "info" | "warning" | "error"; message: string }>;
  featureCoverage?: Array<{
    feature: string;
    label: string;
    status: "supported" | "preview_only" | "blocked" | "not_applicable";
    severity: "info" | "warning" | "error";
    message: string;
    context?: Record<string, unknown>;
  }>;
  robotDiagnostics?: Record<string, unknown> | null;
  robotDiagnosticsTrace?: RobotDiagnosticsTrace | null;
  robotEmbodimentSpec?: Record<string, unknown> | null;
  compiledTaskContractV2?: Record<string, unknown> | null;
  taskMaterializationSummary?: Record<string, unknown> | null;
  launchParitySummary?: Record<string, unknown> | null;
  agentInspectorSummary?: Record<string, unknown> | null;
  launchParityTrace?: Record<string, unknown> | null;
  launchDiagnostics?: Record<string, unknown> | null;
  scenePreparation?: Record<string, unknown> | null;
};

export type TrainingTaskCatalogEntry = {
  id: string;
  type: "example" | "template";
  executionMode: "manager";
  recipeId?: string;
  taskTemplate: string;
  task: string;
  title: string;
  description?: string;
  modelId?: string;
  environmentId?: string;
  agents?: AgentVariant[];
  policyTerms?: PolicyTerm[];
  policyTermsStatus?: "full" | "partial" | "none";
  expressionHints?: TrainingExpressionHints;
  defaults: Record<string, unknown>;
};

type TrainingTaskCatalogResponse = {
  catalogVersion?: string;
  items: TrainingTaskCatalogEntry[];
};

export type PolicyTerm = {
  id: string;
  name: string;
  mode: "reward" | "penalty";
  expression: string;
  variable: string;
  weight: number;
  sample?: number;
  enabled: boolean;
};

export type TrainingExpressionFieldSymbols = {
  observables: string[];
  actions: string[];
  resets: string[];
  policyVariable: string[];
  policyExpression: string[];
};

export type TrainingExpressionHints = {
  commonSymbols: string[];
  fieldSymbols: TrainingExpressionFieldSymbols;
  resetOperators: Array<"==" | "!=" | ">" | ">=" | "<" | "<=">;
  typedSymbols?: Record<string, TrainingExpressionSymbolMetadata>;
};

export type TrainingExpressionSymbolMetadata = {
  type: string;
  source: string;
  arity?: number;
  description?: string;
};

export type AgentVariant = {
  agentId: string;
  title: string;
  trainer: string;
  algorithm: string;
  preset: string;
  entrypoint?: string;
  supportedByIsaacLab: boolean;
  executableByRunner: boolean;
  notes?: string;
};

export type AgentCatalogEnvironment = {
  environmentId: string;
  title: string;
  description?: string;
  taskTemplate: string;
  task: string;
  recipeId: string;
  executionMode: "manager";
  defaults: Record<string, unknown>;
  agents: AgentVariant[];
  policyTermsStatus: "full" | "partial" | "none";
  policyTerms: PolicyTerm[];
  expressionHints?: TrainingExpressionHints;
};

export type AgentCatalogModel = {
  modelId: string;
  title: string;
  description?: string;
  sample?: Record<string, unknown> | null;
  match?: Record<string, unknown> | null;
  environments: AgentCatalogEnvironment[];
};

export type AgentCatalogResponse = {
  schemaVersion: string;
  catalogVersion: string;
  isaacLabVersionPinned: string;
  generatedAt: string;
  models: AgentCatalogModel[];
  genericTemplate: AgentCatalogEnvironment;
  runnerCapabilities?: Record<string, unknown>;
};

export type TrainingProfileCatalogRegistration = {
  registrationId: string;
  profileId: string;
  adapterId: string;
  baseTaskId: string;
  taskTemplate: string;
  task: string;
  title?: string;
  description?: string;
  defaultAgentPresetId?: string;
  supportedAgentPresetIds?: string[];
  defaults?: Record<string, unknown>;
  policyTermsStatus?: "full" | "partial" | "none";
  policyTerms?: PolicyTerm[];
  expressionHints?: TrainingExpressionHints;
  launchCapabilities?: Record<string, unknown>;
  authoredProfileContract?: Record<string, unknown> | null;
  authoringSurface?: {
    source?: string;
    authoringSurfaceSource?: "canonical_profile_catalog" | "compatibility_backfill" | "template_defaults";
    profileId?: string;
    registrationId?: string;
    catalogVersion?: string | null;
    policyTermsStatus?: "full" | "partial" | "none" | string;
    sourceFilesUsed?: string[];
    observableCount?: number;
    actionCount?: number;
    resetCount?: number;
    terminationCount?: number;
    diagnostics?: string[];
    complete?: boolean;
  } | null;
};

export type TrainingProfileCatalogProfile = {
  profileId: string;
  profileVersion: string;
  displayName: string;
  description?: string;
  taskFamily?: string;
  baseTaskId: string;
  defaultAdapterId?: string;
  supports?: Record<string, unknown>;
  launchCapabilities?: Record<string, unknown>;
  agentPresets: AgentVariant[];
  registrations: TrainingProfileCatalogRegistration[];
  sample?: Record<string, unknown>;
  match?: Record<string, unknown>;
};

export type TrainingProfileCatalogResponse = {
  schemaVersion: string;
  catalogVersion: string;
  generatedAt: string;
  sourceKind?: string;
  degraded?: boolean;
  canonicalExampleAuthoringAvailable?: boolean;
  degradedReasonCode?: string | null;
  degradedMessage?: string | null;
  degradedRegistrations?: Array<{
    profileId: string;
    registrationId: string;
  }>;
  profiles: TrainingProfileCatalogProfile[];
  adapters?: Record<string, unknown>[];
  issues?: Array<{ code: string; message: string }>;
};

export type TrainingRunnerStatus = {
  runnerMode: string;
  requiresRunner: boolean;
  available: boolean;
  checkedAt: string;
  reason?: string;
  details?: Record<string, unknown>;
  error?: string;
};

export type AssetPipelineDecision = {
  mode: "usd_passthrough" | "mjcf_conversion";
  reason?: string;
};

export type AgentResolveRequest = {
  model?: Record<string, unknown>;
  preferences?: {
    modelId?: string;
    environmentId?: string;
    recipeId?: string;
    taskTemplate?: string;
    task?: string;
    agentId?: string;
  };
  agentId?: string;
  assetPipeline?: AssetPipelineDecision;
};

export type AgentResolveResponse = {
  catalogVersion: string;
  resolvedModelId: string;
  resolvedEnvironmentId: string;
  resolvedTaskTemplate: string;
  resolvedRecipeId?: string;
  resolvedTask: string;
  resolvedAgentId: string;
  resolvedAgent?: AgentVariant;
  availableAgents: AgentVariant[];
  environment: AgentCatalogEnvironment;
  assetPipeline: AssetPipelineDecision;
  warnings?: string[];
};

export type TrainingPreviewMeta = {
  jobId: string;
  runnerJobId: string | null;
  totalSteps: number;
  latestStep: number;
  visibleStep: number | null;
  frameCount: number;
  updatedAt: string;
  previewWidth?: number;
  previewHeight?: number;
  previewFps?: number;
  cameraPreset?: string;
  previewSource?: string;
  unavailableReason?: string;
  warning?: string;
};

export type TrainingRecordingViewMeta = {
  available: boolean;
  updatedAt: string;
  sizeBytes?: number;
  durationSec?: number;
  frameCount?: number;
  contentType?: string;
  recordingSource?: string;
  sourcePath?: string;
  latestSourcePath?: string;
  visibleSourcePath?: string;
  clipCount?: number;
  latestClipIndex?: number;
  visibleClipIndex?: number;
  lagClips?: number;
  stepsPerEpoch?: number;
  videoInterval?: number;
  visibleVideoStep?: number;
  visibleVideoEpoch?: number;
  visibleSourceEpisodeIndex?: number;
  visibleSourceVideoStep?: number;
  latestVideoStep?: number;
  latestVideoEpoch?: number;
  latestSourceEpisodeIndex?: number;
  latestSourceVideoStep?: number;
  currentClipIndex?: number;
  currentSourceEpisodeIndex?: number;
  states?: Array<{
    clipIndex: number;
    stateKey: string;
    stateName: string;
    videoStep?: number;
    videoEpoch?: number;
    sourceEpisodeIndex?: number;
    sourceVideoStep?: number;
    isLatest: boolean;
  }>;
  previewSource?: string;
  unavailableReason?: string;
  warning?: string;
};

export type TrainingRecordingMeta = {
  jobId: string;
  runnerJobId: string | null;
} & TrainingRecordingViewMeta & {
  defaultViewId?: string;
  viewOrder?: string[];
  views?: Record<string, TrainingRecordingViewMeta>;
};

export type TrainingLivePulseSseEvent = {
  jobId: string;
  runnerJobId?: string | null;
  status: string;
  trainerIteration?: number | null;
  metricStep: number;
  episodeIndex?: number | null;
  progressRatio?: number | null;
  source?: string | null;
  metrics?: {
    [key: string]: number | null | undefined;
  } | null;
  latestMetricSample: {
    rewardMean?: number | null;
    loss?: number | null;
    episodeLengthMean?: number | null;
    fps?: number | null;
  };
  latestMetricSurface?: {
    [key: string]: number | null | undefined;
  };
  latestRawMetricSample?: {
    [key: string]: number | null | undefined;
  } | null;
  visibleClipIndex?: number | null;
  latestClipIndex?: number | null;
  visibleVideoStep?: number | null;
  occurredAt?: string;
  eventId?: string | null;
};

export type TrainingMetricsSseEvent = TrainingLivePulseSseEvent;

export type TrainingMetricBatchSample = {
  trainerIteration?: number | null;
  metricStep: number;
  episodeIndex?: number | null;
  progressRatio?: number | null;
  occurredAt: string;
  canonicalMetrics: {
    rewardMean?: number | null;
    loss?: number | null;
    episodeLengthMean?: number | null;
    fps?: number | null;
    [key: string]: number | null | undefined;
  };
  rawMetrics: {
    [key: string]: number | null | undefined;
  };
  metrics: {
    [key: string]: number | null | undefined;
  };
};

export type TrainingMetricBatchSummary = {
  batchId: string;
  jobId: string;
  runnerJobId?: string | null;
  fromStep: number;
  toStep: number;
  sampleCount: number;
  samples: TrainingMetricBatchSample[];
  createdAt: string;
};

const rawBaseUrl = String(import.meta.env.VITE_TRAINING_API_BASE_URL ?? "").trim();
const baseUrl = rawBaseUrl.replace(/\/+$/, "");
const rawApiToken = String(import.meta.env.VITE_TRAINING_API_TOKEN ?? "").trim();

export const trainingApiEnabled = baseUrl.length > 0;
export const trainingApiBaseUrl = baseUrl;
export const trainingApiTokenEnabled = rawApiToken.length > 0;

function buildUrl(path: string) {
  return `${baseUrl}${path}`;
}

export function buildTrainingLivePulseStreamUrl(jobId: string) {
  const safeJobId = encodeURIComponent(jobId);
  if (!rawApiToken) {
    return buildUrl(`/v1/training/jobs/${safeJobId}/metrics/stream`);
  }
  const params = new URLSearchParams();
  params.set("access_token", rawApiToken);
  return buildUrl(`/v1/training/jobs/${safeJobId}/metrics/stream?${params.toString()}`);
}

function buildHeaders(headers: Record<string, string> = {}) {
  const next: Record<string, string> = { ...headers };
  if (rawApiToken) {
    next.authorization = `Bearer ${rawApiToken}`;
  }
  return next;
}

function formatLaunchErrorSuffix(details: Record<string, unknown> | null): string {
  if (!details) return "";
  const launchDiagnostics =
    isPlainRecord(details.launchDiagnostics) ? details.launchDiagnostics : null;
  const phase =
    String(details.launchPhase ?? launchDiagnostics?.currentPhase ?? "").trim();
  const traceId =
    String(details.launchTraceId ?? launchDiagnostics?.traceId ?? "").trim();
  const parts = [];
  if (phase) parts.push(`phase ${phase}`);
  if (traceId) parts.push(`trace ${traceId}`);
  return parts.length > 0 ? ` (${parts.join(" | ")})` : "";
}

function formatValidationErrorSuffix(details: Record<string, unknown> | null): string {
  if (!details) return "";
  const parts: string[] = [];
  const reasonCode = String(details.reasonCode ?? "").trim();
  const authoritySourceKind = String(details.authoritySourceKind ?? "").trim();
  const evidenceChainId = String(details.evidenceChainId ?? "").trim();
  const blockingDiagnostics = Array.isArray(details.blockingDiagnostics)
    ? details.blockingDiagnostics.map((item) => String(item).trim()).filter(Boolean)
    : [];
  const advisoryDiagnostics = Array.isArray(details.advisoryDiagnostics)
    ? details.advisoryDiagnostics.map((item) => String(item).trim()).filter(Boolean)
    : [];
  if (reasonCode) parts.push(`reason ${reasonCode}`);
  if (authoritySourceKind) parts.push(`authority ${authoritySourceKind}`);
  if (evidenceChainId) parts.push(`trace ${evidenceChainId}`);
  if (blockingDiagnostics.length > 0) parts.push(`blockers ${blockingDiagnostics.join(", ")}`);
  if (advisoryDiagnostics.length > 0) parts.push(`advisories ${advisoryDiagnostics.join(", ")}`);
  return parts.length > 0 ? ` (${parts.join(" | ")})` : "";
}

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    const fallback = `Training API ${response.status}: ${text || response.statusText}`;
    if (!text) {
      throw new Error(fallback);
    }
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(fallback);
    }
    if (isPlainRecord(parsed)) {
      const code = String(parsed.code ?? "").trim();
      const message = String(parsed.message ?? "").trim() || response.statusText;
      const details = isPlainRecord(parsed.details) ? parsed.details : null;
      const validationSuffix = formatValidationErrorSuffix(details);
      const launchSuffix = formatLaunchErrorSuffix(details);
      const persistence = details && isPlainRecord(details.persistence) ? details.persistence : null;
      if (persistence) {
        const field = String(persistence.field ?? "").trim();
        const path = String(persistence.path ?? "").trim();
        const reason = String(persistence.reason ?? "").trim();
        const segments = [field];
        if (path && path !== field) segments.push(path);
        if (reason) segments.push(reason);
        const suffix = segments.filter(Boolean).join(" | ");
        throw new Error(
          `Training API ${response.status}: ${code || "ERROR"}: ${message}${suffix ? ` (${suffix})` : ""}${launchSuffix}`
        );
      }
      throw new Error(
        `Training API ${response.status}: ${code || "ERROR"}: ${message}${validationSuffix}${launchSuffix}`
      );
    }
    throw new Error(fallback);
  }
  return (await response.json()) as T;
}

export async function submitTrainingJobRemote(input: SubmitTrainingJobInput): Promise<TrainingJobSummary> {
  const response = await fetch(buildUrl("/v1/training/jobs"), {
    method: "POST",
    headers: buildHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input),
  });
  return await parseJson<TrainingJobSummary>(response);
}

export async function submitTrainingJobRemoteWithResponse(
  input: SubmitTrainingJobInput
): Promise<{ status: number; job: TrainingJobSummary }> {
  const response = await fetch(buildUrl("/v1/training/jobs"), {
    method: "POST",
    headers: buildHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input),
  });
  const job = await parseJson<TrainingJobSummary>(response);
  return {
    status: response.status,
    job,
  };
}

export async function submitTrainingTaskRemoteWithResponse(
  input: CustomTrainingTaskRequest
): Promise<{
  status: number;
  response: TaskAutocompletePreview | TaskAutocompleteLaunchResponse | CustomTrainingTaskLaunchResponse;
}> {
  const response = await fetch(buildUrl("/v1/training/tasks"), {
    method: "POST",
    headers: buildHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input),
  });
  const parsed = await parseJson<TaskAutocompletePreview | TaskAutocompleteLaunchResponse | CustomTrainingTaskLaunchResponse>(
    response
  );
  return {
    status: response.status,
    response: parsed,
  };
}

export async function listTrainingJobsRemote(): Promise<TrainingJobSummary[]> {
  const response = await fetch(buildUrl("/v1/training/jobs"), {
    method: "GET",
    headers: buildHeaders({ accept: "application/json" }),
  });
  const payload = await parseJson<TrainingJobListResponse>(response);
  return payload.items;
}

export async function cancelTrainingJobRemote(jobId: string): Promise<{
  jobId: string;
  accepted: boolean;
  cancelRequested?: boolean;
  runnerCancelDispatchAttempted?: boolean;
  runnerCancelDispatchSucceeded?: boolean;
}> {
  const response = await fetch(buildUrl(`/v1/training/jobs/${encodeURIComponent(jobId)}:cancel`), {
    method: "POST",
    headers: buildHeaders({ accept: "application/json" }),
  });
  return parseJson<{
    jobId: string;
    accepted: boolean;
    cancelRequested?: boolean;
    runnerCancelDispatchAttempted?: boolean;
    runnerCancelDispatchSucceeded?: boolean;
  }>(response);
}

export async function listTrainingArtifactsRemote(
  jobId: string,
  kind?: TrainingArtifactKind
): Promise<TrainingArtifactSummary[]> {
  const params = new URLSearchParams();
  if (kind) params.set("kind", kind);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return fetchTrainingListWithEmptyCooldown<TrainingArtifactSummary>(
    "artifacts",
    jobId,
    suffix.replace(/^\?/, ""),
    buildUrl(`/v1/training/jobs/${encodeURIComponent(jobId)}/artifacts${suffix}`)
  );
}

const EMPTY_LIST_COOLDOWN_MS = 1500;
const emptyListCooldownEntries = new Map<EmptyListCooldownKey, EmptyListCooldownEntry>();

function buildEmptyListCooldownKey(endpoint: string, jobId: string, query: string) {
  return `${endpoint}::${jobId}::${query}`;
}

function shouldSkipEmptyListRemoteRead(key: EmptyListCooldownKey, now: number) {
  const entry = emptyListCooldownEntries.get(key);
  if (!entry) return false;
  return now - entry.emptyAt < EMPTY_LIST_COOLDOWN_MS;
}

function recordEmptyListRemoteRead(key: EmptyListCooldownKey, now: number) {
  emptyListCooldownEntries.set(key, { emptyAt: now });
}

function clearEmptyListRemoteRead(key: EmptyListCooldownKey) {
  emptyListCooldownEntries.delete(key);
}

export const emptyListCooldown = {
  shouldSkip: shouldSkipEmptyListRemoteRead,
  recordEmpty: recordEmptyListRemoteRead,
  clear: clearEmptyListRemoteRead,
  buildKey: buildEmptyListCooldownKey,
};

async function fetchTrainingListWithEmptyCooldown<T>(
  endpoint: string,
  jobId: string,
  query: string,
  request: RequestInfo | URL
): Promise<T[]> {
  const key = buildEmptyListCooldownKey(endpoint, jobId, query);
  const now = Date.now();
  if (shouldSkipEmptyListRemoteRead(key, now)) {
    return [];
  }
  const response = await fetch(request, {
    method: "GET",
    headers: buildHeaders({ accept: "application/json" }),
  });
  const payload = (await parseJson<{ items: T[] }>(response)).items;
  if (payload.length === 0) {
    recordEmptyListRemoteRead(key, now);
  } else {
    clearEmptyListRemoteRead(key);
  }
  return payload;
}

export async function listTrainingJobEventsRemote(jobId: string, limit = 100): Promise<TrainingJobEventSummary[]> {
  const bounded = Math.min(Math.max(1, Math.round(limit)), 20_000);
  return fetchTrainingListWithEmptyCooldown<TrainingJobEventSummary>(
    "events",
    jobId,
    `limit=${bounded}`,
    buildUrl(`/v1/training/jobs/${encodeURIComponent(jobId)}/events?limit=${bounded}`)
  );
}

export async function listTrainingMetricBatchesRemote(jobId: string, limit = 100): Promise<TrainingMetricBatchSummary[]> {
  const bounded = Math.min(Math.max(1, Math.round(limit)), 20_000);
  return fetchTrainingListWithEmptyCooldown<TrainingMetricBatchSummary>(
    "metrics/batches",
    jobId,
    `limit=${bounded}`,
    buildUrl(`/v1/training/jobs/${encodeURIComponent(jobId)}/metrics/batches?limit=${bounded}`)
  );
}

export async function getTrainingRunnerLogsRemote(jobId: string, tail = 250): Promise<TrainingRunnerLogsSummary> {
  const bounded = Math.min(Math.max(20, Math.round(tail)), 2000);
  const response = await fetch(
    buildUrl(`/v1/training/jobs/${encodeURIComponent(jobId)}/runner-logs?tail=${bounded}`),
    {
      method: "GET",
      headers: buildHeaders({ accept: "application/json" }),
    }
  );
  return await parseJson<TrainingRunnerLogsSummary>(response);
}

export async function getTrainingPreviewMetaRemote(jobId: string): Promise<TrainingPreviewMeta> {
  const response = await fetch(buildUrl(`/v1/training/jobs/${encodeURIComponent(jobId)}/preview/meta`), {
    method: "GET",
    headers: buildHeaders({ accept: "application/json" }),
  });
  return await parseJson<TrainingPreviewMeta>(response);
}

export async function getTrainingPreviewFrameRemote(jobId: string, step?: number): Promise<Blob> {
  const path =
    typeof step === "number" && Number.isFinite(step)
      ? `/v1/training/jobs/${encodeURIComponent(jobId)}/preview/frame/${Math.max(1, Math.round(step))}.svg`
      : `/v1/training/jobs/${encodeURIComponent(jobId)}/preview/latest.svg`;
  const response = await fetch(buildUrl(path), {
    method: "GET",
    headers: buildHeaders({ accept: "image/svg+xml" }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Training API ${response.status}: ${text || response.statusText}`);
  }
  return await response.blob();
}

export async function getTrainingRecordingMetaRemote(jobId: string): Promise<TrainingRecordingMeta> {
  const response = await fetch(buildUrl(`/v1/training/jobs/${encodeURIComponent(jobId)}/recording/meta`), {
    method: "GET",
    headers: buildHeaders({ accept: "application/json" }),
  });
  return await parseJson<TrainingRecordingMeta>(response);
}

export async function getTrainingRecordingLatestRemote(
  jobId: string,
  options?: { clipIndex?: number; state?: string; view?: string }
): Promise<Blob> {
  const params = new URLSearchParams();
  const clipIndex = Number(options?.clipIndex);
  if (Number.isFinite(clipIndex) && clipIndex > 0) {
    params.set("clipIndex", String(Math.max(1, Math.round(clipIndex))));
  }
  const state = String(options?.state ?? "").trim();
  if (state) {
    params.set("state", state);
  }
  const view = String(options?.view ?? "").trim();
  if (view) {
    params.set("view", view);
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const response = await fetch(buildUrl(`/v1/training/jobs/${encodeURIComponent(jobId)}/recording/latest${suffix}`), {
    method: "GET",
    headers: buildHeaders({ accept: "video/*,application/octet-stream" }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Training API ${response.status}: ${text || response.statusText}`);
  }
  return await response.blob();
}

export async function uploadMjcfTrainingAssetRemote(input: {
  filename: string;
  mjcf: string;
  contentType?: string;
}): Promise<TrainingRunnerAssetMeta> {
  const response = await fetch(buildUrl("/v1/training/assets/mjcf"), {
    method: "POST",
    headers: buildHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      filename: input.filename,
      mjcf: input.mjcf,
      contentType: input.contentType ?? "application/xml",
    }),
  });
  return await parseJson<TrainingRunnerAssetMeta>(response);
}

export async function uploadUsdTrainingAssetRemote(input: {
  entryPath: string;
  files: TrainingUsdBundleFileInput[];
}): Promise<TrainingRunnerAssetMeta> {
  const files = Array.isArray(input.files)
    ? input.files
        .map((item) => ({
          path: String(item.path ?? "").trim(),
          contentBase64: String(item.contentBase64 ?? "").trim(),
          contentType: String(item.contentType ?? "").trim() || undefined,
        }))
        .filter((item) => item.path.length > 0 && item.contentBase64.length > 0)
    : [];

  const response = await fetch(buildUrl("/v1/training/assets/usd"), {
    method: "POST",
    headers: buildHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      entryPath: String(input.entryPath ?? "").trim(),
      files,
    }),
  });
  return await parseJson<TrainingRunnerAssetMeta>(response);
}

export async function getTrainingAssetMetaRemote(assetId: string): Promise<TrainingRunnerAssetMeta> {
  const response = await fetch(buildUrl(`/v1/training/assets/${encodeURIComponent(assetId)}/meta`), {
    method: "GET",
    headers: buildHeaders({ accept: "application/json" }),
  });
  return await parseJson<TrainingRunnerAssetMeta>(response);
}

export async function convertTrainingMjcfAssetToUsdRemote(input: {
  assetId: string;
  outputFilename?: string;
  conversionProfile?: ConversionProfile;
  fixBase?: boolean;
  importSites?: boolean;
  makeInstanceable?: boolean;
  sanitizeRootJointArtifacts?: boolean;
}): Promise<TrainingMjcfToUsdConversionMeta> {
  const payload: Record<string, unknown> = {};
  const outputFilename = String(input.outputFilename ?? "").trim();
  if (outputFilename) payload.outputFilename = outputFilename;
  if (input.conversionProfile === "generic" || input.conversionProfile === "manager") {
    payload.conversionProfile = "generic";
  }
  if (typeof input.fixBase === "boolean") payload.fixBase = input.fixBase;
  if (typeof input.importSites === "boolean") payload.importSites = input.importSites;
  if (typeof input.makeInstanceable === "boolean") payload.makeInstanceable = input.makeInstanceable;
  if (typeof input.sanitizeRootJointArtifacts === "boolean") {
    payload.sanitizeRootJointArtifacts = input.sanitizeRootJointArtifacts;
  }

  const response = await fetch(
    buildUrl(`/v1/training/assets/${encodeURIComponent(input.assetId)}:convert-mjcf-to-usd`),
    {
      method: "POST",
      headers: buildHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(payload),
    }
  );
  return await parseJson<TrainingMjcfToUsdConversionMeta>(response);
}

export async function introspectTrainingAssetRemote(
  assetId: string
): Promise<UsdIntrospectionMeta> {
  const response = await fetch(
    buildUrl(`/v1/training/assets/${encodeURIComponent(assetId)}/introspect`),
    {
      method: "GET",
      headers: buildHeaders({ accept: "application/json" }),
    }
  );
  return await parseJson<UsdIntrospectionMeta>(response);
}

export async function deriveTrainingConfigRemote(input: {
  convertedAssetId?: string;
  assetId?: string;
  overrides?: Record<string, unknown>;
}): Promise<ConfigDerivationPreview> {
  const payload: Record<string, unknown> = {};
  const assetId = String(input.convertedAssetId ?? input.assetId ?? "").trim();
  if (assetId) payload.convertedAssetId = assetId;
  if (input.overrides && typeof input.overrides === "object") {
    payload.overrides = input.overrides;
  }

  const response = await fetch(buildUrl("/v1/training/tasks:derive-config"), {
    method: "POST",
    headers: buildHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(payload),
  });
  return await parseJson<ConfigDerivationPreview>(response);
}

export async function listTrainingTaskCatalogRemote(): Promise<TrainingTaskCatalogEntry[]> {
  const response = await fetch(buildUrl("/v1/training/tasks/catalog"), {
    method: "GET",
    headers: buildHeaders({ accept: "application/json" }),
  });
  const payload = await parseJson<TrainingTaskCatalogResponse>(response);
  return Array.isArray(payload.items) ? payload.items : [];
}

export async function getTrainingRunnerStatusRemote(): Promise<TrainingRunnerStatus> {
  const response = await fetch(buildUrl("/v1/training/runner/status"), {
    method: "GET",
    headers: buildHeaders({ accept: "application/json" }),
  });
  return await parseJson<TrainingRunnerStatus>(response);
}

export async function listAgentCatalogRemote(): Promise<AgentCatalogResponse> {
  const response = await fetch(buildUrl("/v1/agents/catalog"), {
    method: "GET",
    headers: buildHeaders({ accept: "application/json" }),
  });
  return await parseJson<AgentCatalogResponse>(response);
}

export async function listTrainingProfileCatalogRemote(): Promise<TrainingProfileCatalogResponse> {
  const response = await fetch(buildUrl("/v1/training/profiles/catalog"), {
    method: "GET",
    headers: buildHeaders({ accept: "application/json" }),
  });
  return await parseJson<TrainingProfileCatalogResponse>(response);
}

export async function resolveAgentRemote(input: AgentResolveRequest): Promise<AgentResolveResponse> {
  const payload: Record<string, unknown> = {};
  if (input.model && typeof input.model === "object") payload.model = input.model;
  if (input.preferences && typeof input.preferences === "object") payload.preferences = input.preferences;
  const agentId = String(input.agentId ?? "").trim();
  if (agentId) payload.agentId = agentId;
  if (input.assetPipeline && typeof input.assetPipeline === "object") payload.assetPipeline = input.assetPipeline;
  const response = await fetch(buildUrl("/v1/agents:resolve"), {
    method: "POST",
    headers: buildHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(payload),
  });
  return await parseJson<AgentResolveResponse>(response);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toStageUpAxis(value: unknown): StageUpAxis {
  const token = String(value ?? "").trim().toUpperCase();
  if (token === "X" || token === "Y" || token === "Z") return token;
  return "unknown";
}

function toPreviewIntrospection(
  input: unknown
): TaskAutocompletePreview["introspection"] {
  const introspection = isPlainRecord(input) ? input : {};
  const jointsRaw = Array.isArray(introspection.joints) ? introspection.joints : [];
  const rootBodiesRaw = Array.isArray(introspection.rootBodies) ? introspection.rootBodies : [];
  const joints = jointsRaw.filter((entry) => isPlainRecord(entry)) as UsdJointInfo[];
  const rootBodies = rootBodiesRaw.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0);
  const jointCountRaw = Number(introspection.jointCount);
  const jointCount = Number.isFinite(jointCountRaw) ? Math.max(0, Math.round(jointCountRaw)) : joints.length;
  const stageUpAxis = toStageUpAxis(introspection.stageUpAxis);
  return {
    jointCount,
    joints,
    rootBodies,
    stageUpAxis,
  };
}

function normalizeCustomDryRunPreview(input: {
  parsed: Record<string, unknown>;
  fallbackTaskTemplate: string;
  fallbackAssetId: string;
}): TaskAutocompletePreview {
  const parsed = input.parsed;
  const fallbackTaskTemplate = String(input.fallbackTaskTemplate ?? "").trim() || "custom_manager";
  const environmentPreview = isPlainRecord(parsed.environmentPreview)
    ? parsed.environmentPreview
    : isPlainRecord(parsed.environment)
      ? parsed.environment
      : {};
  const fallbackAssetIdFromPreview = String((environmentPreview as Record<string, unknown>).robotAssetId ?? "").trim();
  const experimentTaskSpec = isPlainRecord(parsed.experimentTaskSpec) ? parsed.experimentTaskSpec : undefined;
  const taskMaterializationSummary = isPlainRecord(parsed.taskMaterializationSummary)
    ? parsed.taskMaterializationSummary
    : isPlainRecord(experimentTaskSpec?.taskMaterializationSummary)
      ? (experimentTaskSpec.taskMaterializationSummary as Record<string, unknown>)
      : undefined;
  const launchParitySummary = isPlainRecord(parsed.launchParitySummary)
    ? parsed.launchParitySummary
    : isPlainRecord(experimentTaskSpec?.launchParitySummary)
      ? (experimentTaskSpec.launchParitySummary as Record<string, unknown>)
      : undefined;
  const agentInspectorSummary = isPlainRecord(parsed.agentInspectorSummary)
    ? parsed.agentInspectorSummary
    : isPlainRecord(experimentTaskSpec?.agentInspectorSummary)
      ? (experimentTaskSpec.agentInspectorSummary as Record<string, unknown>)
      : undefined;
  const assetId =
    String(parsed.assetId ?? "").trim() ||
    fallbackAssetIdFromPreview ||
    String(input.fallbackAssetId ?? "").trim() ||
    "custom-asset";
  return {
    dryRun: true,
    profileId: String(parsed.profileId ?? "").trim() || undefined,
    profileVersion: String(parsed.profileVersion ?? "").trim() || undefined,
    baseTaskId: String(parsed.baseTaskId ?? "").trim() || undefined,
    registrationId: String(parsed.registrationId ?? "").trim() || undefined,
    agentPresetId: String(parsed.agentPresetId ?? "").trim() || undefined,
    adapterId: String(parsed.adapterId ?? "").trim() || undefined,
    adapterVersion: String(parsed.adapterVersion ?? "").trim() || undefined,
    adapterSelection: isPlainRecord(parsed.adapterSelection) ? parsed.adapterSelection : undefined,
    adapterCompatibility: isPlainRecord(parsed.adapterCompatibility) ? parsed.adapterCompatibility : undefined,
    experimentId: String(parsed.experimentId ?? "").trim() || undefined,
    experimentRevisionId: String(parsed.experimentRevisionId ?? "").trim() || undefined,
    taskFingerprint: String(parsed.taskFingerprint ?? "").trim() || undefined,
    experimentTaskId: String(parsed.experimentTaskId ?? "").trim() || undefined,
    experimentTaskSpec: isPlainRecord(parsed.experimentTaskSpec) ? parsed.experimentTaskSpec : undefined,
    taskMaterializationSummary,
    launchParitySummary,
    agentInspectorSummary,
    compiledTaskContractV2: isPlainRecord(parsed.compiledTaskContractV2)
      ? parsed.compiledTaskContractV2
      : isPlainRecord(experimentTaskSpec?.compiledTaskContractV2)
        ? (experimentTaskSpec.compiledTaskContractV2 as Record<string, unknown>)
        : undefined,
    experimentTaskRegistration: isPlainRecord(parsed.experimentTaskRegistration)
      ? parsed.experimentTaskRegistration
      : undefined,
    authoredProfileContract: isPlainRecord(parsed.authoredProfileContract)
      ? parsed.authoredProfileContract
      : isPlainRecord(experimentTaskSpec?.authoredProfileContract)
        ? (experimentTaskSpec.authoredProfileContract as Record<string, unknown>)
        : undefined,
    editorSceneContract: isPlainRecord(parsed.editorSceneContract) ? parsed.editorSceneContract : undefined,
    resolvedLaunchPlan: isPlainRecord(parsed.resolvedLaunchPlan) ? parsed.resolvedLaunchPlan : null,
    runtimeAssetManifest: isPlainRecord(parsed.runtimeAssetManifest)
      ? parsed.runtimeAssetManifest
      : isPlainRecord((experimentTaskSpec as Record<string, unknown> | undefined)?.runtimeAssetManifest)
        ? ((experimentTaskSpec as Record<string, unknown>).runtimeAssetManifest as Record<string, unknown>)
        : undefined,
    sceneActivation: isPlainRecord(parsed.sceneActivation) ? parsed.sceneActivation : null,
    compatibilitySignature: isPlainRecord(parsed.compatibilitySignature)
      ? parsed.compatibilitySignature
      : undefined,
    experiment: isPlainRecord(parsed.experiment) ? parsed.experiment : undefined,
    experimentRevision: isPlainRecord(parsed.experimentRevision) ? parsed.experimentRevision : undefined,
    taskTemplate: String(parsed.taskTemplate ?? fallbackTaskTemplate).trim() || fallbackTaskTemplate,
    assetId,
    introspection: toPreviewIntrospection(parsed.introspection),
    derivedConfig: isPlainRecord(parsed.derivedConfig) ? (parsed.derivedConfig as DerivedTrainingConfig) : {},
    taskConfig: isPlainRecord(parsed.taskConfig) ? parsed.taskConfig : {},
    physicsDiagnostics: isPlainRecord(parsed.physicsDiagnostics)
      ? (parsed.physicsDiagnostics as PhysicsDiagnostics)
      : undefined,
    expressionHints: isPlainRecord(parsed.expressionHints)
      ? (parsed.expressionHints as TrainingExpressionHints)
      : undefined,
    environmentPreview,
    resolvedAgent: isPlainRecord(parsed.resolvedAgent) ? (parsed.resolvedAgent as AgentVariant) : undefined,
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map((item) => String(item)) : [],
    validationErrors: Array.isArray(parsed.validationErrors)
      ? parsed.validationErrors
          .filter((item) => isPlainRecord(item))
          .map((item) => ({
            code: String((item as Record<string, unknown>).code ?? "").trim() || "unknown",
            message: String((item as Record<string, unknown>).message ?? "").trim() || "validation",
            ...(isPlainRecord((item as Record<string, unknown>).details)
              ? { details: (item as Record<string, unknown>).details as Record<string, unknown> }
              : {}),
            ...(Number.isFinite(Number((item as Record<string, unknown>).status))
              ? { status: Math.max(0, Math.round(Number((item as Record<string, unknown>).status))) }
              : {}),
          }))
      : [],
    compatibility: Array.isArray(parsed.compatibility)
      ? parsed.compatibility
          .filter((item) => isPlainRecord(item))
          .map((item) => {
            const record = item as Record<string, unknown>;
            const severityToken = String(record.severity ?? "warning").trim().toLowerCase();
            const severity = severityToken === "error" || severityToken === "info" ? severityToken : "warning";
            return {
              category: String(record.category ?? "runtime_semantics").trim() || "runtime_semantics",
              code: String(record.code ?? "").trim() || "unknown",
              severity,
              message: String(record.message ?? "").trim() || "compatibility",
              context: isPlainRecord(record.context) ? record.context : undefined,
            };
          })
      : [],
    featureCoverage: Array.isArray(parsed.featureCoverage)
      ? parsed.featureCoverage
          .filter((item) => isPlainRecord(item))
          .map((item) => {
            const record = item as Record<string, unknown>;
            const severityToken = String(record.severity ?? "info").trim().toLowerCase();
            const severity =
              severityToken === "warning" || severityToken === "error" ? severityToken : "info";
            const statusToken = String(record.status ?? "not_applicable").trim().toLowerCase();
            const status =
              statusToken === "supported" ||
              statusToken === "preview_only" ||
              statusToken === "blocked" ||
              statusToken === "not_applicable"
                ? statusToken
                : "not_applicable";
            return {
              feature: String(record.feature ?? "").trim() || "unknown",
              label: String(record.label ?? record.feature ?? "Feature").trim() || "Feature",
              status,
              severity,
              message: String(record.message ?? "").trim() || "feature coverage",
              context: isPlainRecord(record.context) ? record.context : undefined,
            };
          })
      : [],
    robotDiagnostics: isPlainRecord(parsed.robotDiagnostics)
      ? parsed.robotDiagnostics
      : null,
    robotDiagnosticsTrace: isPlainRecord(parsed.robotDiagnosticsTrace)
      ? (parsed.robotDiagnosticsTrace as RobotDiagnosticsTrace)
      : null,
    robotEmbodimentSpec: isPlainRecord(parsed.robotEmbodimentSpec)
      ? parsed.robotEmbodimentSpec
      : null,
    agentCompilation: isPlainRecord(parsed.agentCompilation)
      ? parsed.agentCompilation
      : isPlainRecord(experimentTaskSpec?.agentCompilation)
        ? (experimentTaskSpec.agentCompilation as Record<string, unknown>)
        : null,
    launchParityTrace: isPlainRecord(parsed.launchParityTrace)
      ? parsed.launchParityTrace
      : null,
    launchDiagnostics: isPlainRecord(parsed.launchDiagnostics)
      ? parsed.launchDiagnostics
      : null,
    scenePreparation: isPlainRecord(parsed.scenePreparation)
      ? parsed.scenePreparation
      : null,
    launchReadiness: isPlainRecord(parsed.launchReadiness)
      ? {
          status: (() => {
            const launchReadinessRecord = parsed.launchReadiness as Record<string, unknown>;
            const rawStatus = String(launchReadinessRecord.status ?? "").trim();
            if (rawStatus === "launchable") return "prepared";
            if (rawStatus === "prepared" || rawStatus === "missing_but_preparable" || rawStatus === "blocked") {
              return rawStatus as "prepared" | "missing_but_preparable" | "blocked";
            }
            return "blocked";
          })(),
          blockers: Array.isArray((parsed.launchReadiness as Record<string, unknown>).blockers)
            ? ((parsed.launchReadiness as Record<string, unknown>).blockers as unknown[]).map((item: unknown) => String(item))
            : [],
          warnings: Array.isArray((parsed.launchReadiness as Record<string, unknown>).warnings)
            ? ((parsed.launchReadiness as Record<string, unknown>).warnings as unknown[]).map((item: unknown) => String(item))
            : [],
        }
      : null,
    catalogVersion: String(parsed.catalogVersion ?? "").trim() || undefined,
    message: String(parsed.message ?? "Custom payload validated."),
  } satisfies TaskAutocompletePreview;
}

export async function submitTrainingTaskRemote(
  input: CustomTrainingTaskRequest
): Promise<TaskAutocompletePreview | TaskAutocompleteLaunchResponse | CustomTrainingTaskLaunchResponse> {
  if (
    isPlainRecord((input as CustomTrainingTaskRequest).environment) &&
    isPlainRecord((input as CustomTrainingTaskRequest).agent) &&
    isPlainRecord((input as CustomTrainingTaskRequest).runtime)
  ) {
    const custom = input as CustomTrainingTaskRequest;
    const payload: Record<string, unknown> = {
      environment: custom.environment,
      agent: custom.agent,
      runtime: custom.runtime,
    };
    const sourcePayloadVersion = String(custom.sourcePayloadVersion ?? "").trim();
    if (sourcePayloadVersion) payload.sourcePayloadVersion = sourcePayloadVersion;
    const tenantId = String(custom.tenantId ?? "").trim();
    if (tenantId) payload.tenantId = tenantId;
    const experimentName = String(custom.experimentName ?? "").trim();
    if (experimentName) payload.experimentName = experimentName;
    if (typeof custom.seed === "number" && Number.isFinite(custom.seed)) payload.seed = Math.trunc(custom.seed);
    if (custom.dryRun === true) payload.dryRun = true;
    const profileId = String(custom.profileId ?? "").trim();
    if (profileId) payload.profileId = profileId;
    const profileVersion = String(custom.profileVersion ?? "").trim();
    if (profileVersion) payload.profileVersion = profileVersion;
    const baseTaskId = String(custom.baseTaskId ?? "").trim();
    if (baseTaskId) payload.baseTaskId = baseTaskId;
    const registrationId = String(custom.registrationId ?? "").trim();
    if (registrationId) payload.registrationId = registrationId;
    const agentPresetId = String(custom.agentPresetId ?? "").trim();
    if (agentPresetId) payload.agentPresetId = agentPresetId;
    const adapterId = String(custom.adapterId ?? "").trim();
    if (adapterId) payload.adapterId = adapterId;
    const adapterVersion = String(custom.adapterVersion ?? "").trim();
    if (adapterVersion) payload.adapterVersion = adapterVersion;
    const experimentId = String(custom.experimentId ?? "").trim();
    if (experimentId) payload.experimentId = experimentId;
    const experimentRevisionId = String(custom.experimentRevisionId ?? "").trim();
    if (experimentRevisionId) payload.experimentRevisionId = experimentRevisionId;
    const taskFingerprint = String(custom.taskFingerprint ?? "").trim();
    if (taskFingerprint) payload.taskFingerprint = taskFingerprint;
    const experimentTaskId = String(custom.experimentTaskId ?? "").trim();
    if (experimentTaskId) payload.experimentTaskId = experimentTaskId;
    if (custom.editorRobotModel && typeof custom.editorRobotModel === "object") {
      payload.editorRobotModel = custom.editorRobotModel;
    }
    if (custom.editorSceneContract && typeof custom.editorSceneContract === "object") {
      payload.editorSceneContract = custom.editorSceneContract;
    }
    if (custom.experimentTaskSpec && typeof custom.experimentTaskSpec === "object") {
      payload.experimentTaskSpec = custom.experimentTaskSpec;
    }
    if (custom.experimentTaskRegistration && typeof custom.experimentTaskRegistration === "object") {
      payload.experimentTaskRegistration = custom.experimentTaskRegistration;
    }
    if (custom.authoredProfileContract && typeof custom.authoredProfileContract === "object") {
      payload.authoredProfileContract = custom.authoredProfileContract;
    }
    if (custom.adapterSelection && typeof custom.adapterSelection === "object") {
      payload.adapterSelection = custom.adapterSelection;
    }
    if (custom.experimentContext && typeof custom.experimentContext === "object") {
      payload.experimentContext = custom.experimentContext;
    }
    if (custom.sceneActivation && typeof custom.sceneActivation === "object") {
      payload.sceneActivation = custom.sceneActivation;
    }
    if (custom.robotEmbodimentSpec && typeof custom.robotEmbodimentSpec === "object") {
      payload.robotEmbodimentSpec = custom.robotEmbodimentSpec;
    }
    if (custom.agentCompilation && typeof custom.agentCompilation === "object") {
      payload.agentCompilation = custom.agentCompilation;
    }
    if (custom.compatibilitySignature && typeof custom.compatibilitySignature === "object") {
      payload.compatibilitySignature = custom.compatibilitySignature;
    }

    const response = await fetch(buildUrl("/v1/training/tasks"), {
      method: "POST",
      headers: buildHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(payload),
    });
    const parsed = await parseJson<Record<string, unknown>>(response);
    if (isPlainRecord(parsed) && parsed.mode === "custom" && parsed.dryRun === true) {
      return normalizeCustomDryRunPreview({
        parsed,
        fallbackTaskTemplate: String((custom.environment as Record<string, unknown>)?.taskTemplate ?? "custom_manager"),
        fallbackAssetId: String((custom.environment as Record<string, unknown>)?.robotAssetId ?? "custom-asset"),
      });
    }
    return parsed as CustomTrainingTaskLaunchResponse;
  }

  throw new Error("Legacy training task requests are no longer supported.");
}
