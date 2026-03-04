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

type TrainingArtifactListResponse = {
  items: TrainingArtifactSummary[];
};

type TrainingJobEventListResponse = {
  items: TrainingJobEventSummary[];
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
  message: string;
};

export type TaskAutocompleteRequest = {
  recipeId?: string;
  executionMode?: TrainingExecutionMode;
  taskSpecId?: string;
  taskSpec?: Record<string, unknown>;
  agentId?: string;
  catalogVersion?: string;
  taskTemplate?: string;
  task?: string;
  robotAssetId: string;
  sceneAssetId?: string;
  tenantId?: string;
  experimentName?: string;
  maxSteps?: number;
  numEnvs?: number;
  checkpoint?: number;
  stepsPerEpoch?: number;
  videoLengthSec?: number;
  videoLengthMs?: number;
  videoLength?: number;
  videoInterval?: number;
  seed?: number;
  policy?: Record<string, unknown>;
  policyRules?: Record<string, unknown>;
  baseConstraintMode?: "fix_base" | "source_weld";
  userModelMetadata?: Record<string, unknown>;
  environment?: Record<string, unknown>;
  assetPipeline?: AssetPipelineDecision;
  extraArgs?: string[];
  overrides?: Record<string, unknown>;
  dryRun?: boolean;
};

export type TaskAutocompletePreview = {
  dryRun: true;
  recipeId?: string;
  executionMode?: TrainingExecutionMode;
  taskSpecId?: string;
  taskSpec?: Record<string, unknown>;
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
  environmentPreview: Record<string, unknown>;
  resolvedAgent?: AgentVariant;
  warnings?: string[];
  catalogVersion?: string;
  message: string;
};

export type TaskAutocompleteLaunchResponse = {
  recipeId?: string;
  executionMode?: TrainingExecutionMode;
  taskSpecId?: string;
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
  };
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

export type TrainingRecordingMeta = {
  jobId: string;
  runnerJobId: string | null;
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
  latestVideoStep?: number;
  latestVideoEpoch?: number;
  currentClipIndex?: number;
  states?: Array<{
    clipIndex: number;
    stateKey: string;
    stateName: string;
    videoStep?: number;
    videoEpoch?: number;
    isLatest: boolean;
  }>;
  previewSource?: string;
  unavailableReason?: string;
  warning?: string;
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

export function buildTrainingMetricsStreamUrl(jobId: string) {
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

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Training API ${response.status}: ${text || response.statusText}`);
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

export async function listTrainingJobsRemote(): Promise<TrainingJobSummary[]> {
  const response = await fetch(buildUrl("/v1/training/jobs"), {
    method: "GET",
    headers: buildHeaders({ accept: "application/json" }),
  });
  const payload = await parseJson<TrainingJobListResponse>(response);
  return payload.items;
}

export async function cancelTrainingJobRemote(jobId: string): Promise<void> {
  const response = await fetch(buildUrl(`/v1/training/jobs/${encodeURIComponent(jobId)}:cancel`), {
    method: "POST",
    headers: buildHeaders({ accept: "application/json" }),
  });
  await parseJson<{ jobId: string; accepted: boolean }>(response);
}

export async function listTrainingArtifactsRemote(
  jobId: string,
  kind?: TrainingArtifactKind
): Promise<TrainingArtifactSummary[]> {
  const params = new URLSearchParams();
  params.set("jobId", jobId);
  if (kind) params.set("kind", kind);
  const response = await fetch(buildUrl(`/v1/artifacts?${params.toString()}`), {
    method: "GET",
    headers: buildHeaders({ accept: "application/json" }),
  });
  const payload = await parseJson<TrainingArtifactListResponse>(response);
  return payload.items;
}

export async function listTrainingJobEventsRemote(jobId: string, limit = 100): Promise<TrainingJobEventSummary[]> {
  const bounded = Math.min(Math.max(1, Math.round(limit)), 20_000);
  const response = await fetch(
    buildUrl(`/v1/debug/jobs/${encodeURIComponent(jobId)}/events?limit=${bounded}`),
    {
      method: "GET",
      headers: buildHeaders({ accept: "application/json" }),
    }
  );
  const payload = await parseJson<TrainingJobEventListResponse>(response);
  return payload.items;
}

export async function getTrainingRunnerLogsRemote(jobId: string, tail = 250): Promise<TrainingRunnerLogsSummary> {
  const bounded = Math.min(Math.max(20, Math.round(tail)), 2000);
  const response = await fetch(
    buildUrl(`/v1/debug/jobs/${encodeURIComponent(jobId)}/runner-logs?tail=${bounded}`),
    {
      method: "GET",
      headers: buildHeaders({ accept: "application/json" }),
    }
  );
  return await parseJson<TrainingRunnerLogsSummary>(response);
}

export async function getTrainingPreviewMetaRemote(jobId: string): Promise<TrainingPreviewMeta> {
  const response = await fetch(buildUrl(`/v1/debug/jobs/${encodeURIComponent(jobId)}/preview/meta`), {
    method: "GET",
    headers: buildHeaders({ accept: "application/json" }),
  });
  return await parseJson<TrainingPreviewMeta>(response);
}

export async function getTrainingPreviewFrameRemote(jobId: string, step?: number): Promise<Blob> {
  const path =
    typeof step === "number" && Number.isFinite(step)
      ? `/v1/debug/jobs/${encodeURIComponent(jobId)}/preview/frame/${Math.max(1, Math.round(step))}.svg`
      : `/v1/debug/jobs/${encodeURIComponent(jobId)}/preview/latest.svg`;
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
  const response = await fetch(buildUrl(`/v1/debug/jobs/${encodeURIComponent(jobId)}/recording/meta`), {
    method: "GET",
    headers: buildHeaders({ accept: "application/json" }),
  });
  return await parseJson<TrainingRecordingMeta>(response);
}

export async function getTrainingRecordingLatestRemote(
  jobId: string,
  options?: { clipIndex?: number; state?: string }
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
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const response = await fetch(buildUrl(`/v1/debug/jobs/${encodeURIComponent(jobId)}/recording/latest${suffix}`), {
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

export async function listAgentCatalogRemote(): Promise<AgentCatalogResponse> {
  const response = await fetch(buildUrl("/v1/agents/catalog"), {
    method: "GET",
    headers: buildHeaders({ accept: "application/json" }),
  });
  return await parseJson<AgentCatalogResponse>(response);
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

export async function submitTrainingTaskRemote(
  input: TaskAutocompleteRequest
): Promise<TaskAutocompletePreview | TaskAutocompleteLaunchResponse> {
  const payload: Record<string, unknown> = {
    robotAssetId: String(input.robotAssetId ?? "").trim(),
  };

  const recipeId = String(input.recipeId ?? "").trim();
  if (recipeId) payload.recipeId = recipeId;
  if (input.executionMode === "manager") {
    payload.executionMode = input.executionMode;
  }
  const taskSpecId = String(input.taskSpecId ?? "").trim();
  if (taskSpecId) payload.taskSpecId = taskSpecId;
  if (input.taskSpec && typeof input.taskSpec === "object") payload.taskSpec = input.taskSpec;
  const agentId = String(input.agentId ?? "").trim();
  if (agentId) payload.agentId = agentId;
  const catalogVersion = String(input.catalogVersion ?? "").trim();
  if (catalogVersion) payload.catalogVersion = catalogVersion;

  const taskTemplate = String(input.taskTemplate ?? "").trim();
  if (taskTemplate) payload.taskTemplate = taskTemplate;
  const task = String(input.task ?? "").trim();
  if (task) payload.task = task;
  const sceneAssetId = String(input.sceneAssetId ?? "").trim();
  if (sceneAssetId) payload.sceneAssetId = sceneAssetId;
  const tenantId = String(input.tenantId ?? "").trim();
  if (tenantId) payload.tenantId = tenantId;
  const experimentName = String(input.experimentName ?? "").trim();
  if (experimentName) payload.experimentName = experimentName;

  for (const [key, value] of Object.entries({
    maxSteps: input.maxSteps,
    numEnvs: input.numEnvs,
    checkpoint: input.checkpoint,
    stepsPerEpoch: input.stepsPerEpoch,
    videoLengthSec: input.videoLengthSec,
    videoLengthMs: input.videoLengthMs,
    videoLength: input.videoLength,
    videoInterval: input.videoInterval,
    seed: input.seed,
  })) {
    if (typeof value === "number" && Number.isFinite(value)) {
      payload[key] = value;
    }
  }

  if (input.policy && typeof input.policy === "object") payload.policy = input.policy;
  if (input.policyRules && typeof input.policyRules === "object") payload.policyRules = input.policyRules;
  if (input.baseConstraintMode === "fix_base" || input.baseConstraintMode === "source_weld") {
    payload.baseConstraintMode = input.baseConstraintMode;
  }
  if (input.userModelMetadata && typeof input.userModelMetadata === "object") {
    payload.userModelMetadata = input.userModelMetadata;
  }
  if (input.environment && typeof input.environment === "object") payload.environment = input.environment;
  if (input.assetPipeline && typeof input.assetPipeline === "object") payload.assetPipeline = input.assetPipeline;
  if (input.overrides && typeof input.overrides === "object") payload.overrides = input.overrides;
  if (Array.isArray(input.extraArgs)) payload.extraArgs = input.extraArgs.map((item) => String(item));
  if (input.dryRun === true) payload.dryRun = true;

  const response = await fetch(buildUrl("/v1/training/tasks"), {
    method: "POST",
    headers: buildHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(payload),
  });
  return await parseJson<TaskAutocompletePreview | TaskAutocompleteLaunchResponse>(response);
}
