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
};

export type StageUpAxis = "X" | "Y" | "Z" | "unknown";
export type ConversionProfile = "cartpole_direct" | "generic";

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
  executionMode?: "recipe" | "generic";
  taskSpecId?: string;
  taskSpec?: Record<string, unknown>;
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
  extraArgs?: string[];
  overrides?: Record<string, unknown>;
  dryRun?: boolean;
};

export type TaskAutocompletePreview = {
  dryRun: true;
  recipeId?: string;
  executionMode?: "recipe" | "generic";
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
  message: string;
};

export type TaskAutocompleteLaunchResponse = {
  recipeId?: string;
  executionMode?: "recipe" | "generic";
  taskSpecId?: string;
  job: TrainingJobSummary;
  task: string;
  policy: Record<string, unknown>;
  deduplicated?: boolean;
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
  executionMode: "recipe" | "generic";
  recipeId?: string;
  taskTemplate: string;
  task: string;
  title: string;
  description?: string;
  defaults: Record<string, unknown>;
};

type TrainingTaskCatalogResponse = {
  items: TrainingTaskCatalogEntry[];
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
  if (input.conversionProfile === "cartpole_direct" || input.conversionProfile === "generic") {
    payload.conversionProfile = input.conversionProfile;
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

export async function submitTrainingTaskRemote(
  input: TaskAutocompleteRequest
): Promise<TaskAutocompletePreview | TaskAutocompleteLaunchResponse> {
  const payload: Record<string, unknown> = {
    robotAssetId: String(input.robotAssetId ?? "").trim(),
  };

  const recipeId = String(input.recipeId ?? "").trim();
  if (recipeId) payload.recipeId = recipeId;
  if (input.executionMode === "recipe" || input.executionMode === "generic") {
    payload.executionMode = input.executionMode;
  }
  const taskSpecId = String(input.taskSpecId ?? "").trim();
  if (taskSpecId) payload.taskSpecId = taskSpecId;
  if (input.taskSpec && typeof input.taskSpec === "object") payload.taskSpec = input.taskSpec;

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
