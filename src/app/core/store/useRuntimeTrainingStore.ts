import { create, type StoreApi, type UseBoundStore } from "zustand";
import type {
  SubmitTrainingJobInput,
  TrainingArtifactKind,
  TrainingArtifactSummary,
  TrainingJobEventSummary,
  TrainingRunnerLogsSummary,
  TrainingJobStatus,
  TrainingJobSummary,
  TrainingRecordingSummary,
} from "../plugins/types";
import {
  cancelTrainingJobRemote,
  getTrainingRunnerLogsRemote,
  submitTrainingTaskRemoteWithResponse,
  listTrainingArtifactsRemote,
  listTrainingJobEventsRemote,
  listTrainingJobsRemote,
  trainingApiEnabled,
} from "../services/trainingApiClient";
import { logError, logInfo, logWarn } from "../services/logger";
import {
  cacheTrainingJobs,
  cacheTrainingEvents,
  deleteTrainingTelemetryForJob,
  hasHydratedTrainingEvents,
  listCachedTrainingJobs,
  listCachedTrainingEvents,
  markHydratedTrainingEvents,
  resolveTrainingCacheTenantId,
} from "../services/trainingTelemetryCache";
import { isaacLabEnvironmentManager } from "../training/IsaacLabEnvironmentManager";
import { editorEngine } from "../editor/engineSingleton";

type RuntimeTrainingState = {
  jobs: TrainingJobSummary[];
  recordings: TrainingRecordingSummary[];
  trainingTokens: number;
  trainingTokenCost: number;
  startRemoteJobSync: () => () => void;
  submitTrainingJob: (input: SubmitTrainingJobInput) => string;
  cancelTrainingJob: (jobId: string) => void;
  deleteTrainingJob: (jobId: string, tenantId?: string) => void;
  listTrainingArtifacts: (jobId: string, kind?: TrainingArtifactKind) => Promise<TrainingArtifactSummary[]>;
  listTrainingJobEvents: (jobId: string, limit?: number) => Promise<TrainingJobEventSummary[]>;
  listTrainingRunnerLogs: (jobId: string, tail?: number) => Promise<TrainingRunnerLogsSummary>;
};

const runningIntervals = new Map<string, number>();
const optimisticJobIds = new Set<string>();
let remotePollingTimer: number | null = null;
let remoteSyncConsumerCount = 0;
let remoteSyncInFlight = false;
let trainingJobCounter = 0;
let recordingCounter = 0;
const initialTrainingTokens = readPositiveIntEnv(import.meta.env.VITE_TRAINING_INITIAL_TOKENS, 20);
const trainingTokenCost = readPositiveIntEnv(import.meta.env.VITE_TRAINING_JOB_TOKEN_COST, 1);
const ACTIVE_JOB_STATUSES = new Set<TrainingJobStatus>(["submitting", "queued", "provisioning", "running"]);
const MAX_JOB_HISTORY_ITEMS = 20_000;
const MAX_EVENT_HISTORY_ITEMS = 20_000;
let localJobsHydrationPromise: Promise<void> | null = null;
const DELETED_JOBS_STORAGE_KEY = "runtime-training-deleted-jobs-v1";
const deletedTrainingJobKeys = readDeletedTrainingJobKeys();

function readDeletedTrainingJobKeys() {
  if (typeof window === "undefined" || !window.localStorage) return new Set<string>();
  try {
    const raw = window.localStorage.getItem(DELETED_JOBS_STORAGE_KEY);
    if (!raw) return new Set<string>();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set<string>();
    const tokens = parsed
      .map((item) => String(item ?? "").trim())
      .filter((item) => item.length > 0);
    return new Set(tokens);
  } catch {
    return new Set<string>();
  }
}

function persistDeletedTrainingJobKeys() {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(DELETED_JOBS_STORAGE_KEY, JSON.stringify(Array.from(deletedTrainingJobKeys)));
  } catch {
    // Best-effort persistence. Runtime behavior remains correct for current session.
  }
}

function buildDeletedTrainingJobKey(tenantId: unknown, jobId: unknown) {
  const safeTenant = resolveTrainingCacheTenantId(tenantId);
  const safeJobId = String(jobId ?? "").trim();
  return `${safeTenant}::${safeJobId}`;
}

function isTrainingJobDeleted(job: { id: string; tenantId?: string }) {
  const key = buildDeletedTrainingJobKey(job.tenantId, job.id);
  if (deletedTrainingJobKeys.has(key)) return true;
  // Backward compatibility for entries written before tenant-aware keying.
  return deletedTrainingJobKeys.has(job.id);
}

function markTrainingJobDeleted(job: { id: string; tenantId?: string }) {
  deletedTrainingJobKeys.add(buildDeletedTrainingJobKey(job.tenantId, job.id));
  persistDeletedTrainingJobKeys();
}

function unmarkTrainingJobDeleted(job: { id: string; tenantId?: string }) {
  const removedTenantScoped = deletedTrainingJobKeys.delete(buildDeletedTrainingJobKey(job.tenantId, job.id));
  const removedLegacy = deletedTrainingJobKeys.delete(job.id);
  if (removedTenantScoped || removedLegacy) {
    persistDeletedTrainingJobKeys();
  }
}

function readPositiveIntEnv(rawValue: unknown, fallback: number) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.round(parsed));
}

function sortJobs(jobs: TrainingJobSummary[]) {
  return jobs
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((job) => ({ ...job }));
}

function buildRecordingFromJob(job: TrainingJobSummary): TrainingRecordingSummary {
  const finalLoss = Number((job.loss ?? 1).toFixed(4));
  const qualityScore = Number(Math.max(0, (1 - finalLoss) * 100).toFixed(1));
  return {
    id: `rec_${job.id}`,
    jobId: job.id,
    tenantId: resolveTrainingCacheTenantId(job.tenantId),
    title: `${job.modelName} · ${job.dataset}`,
    createdAt: job.updatedAt,
    previewUrl: null,
    finalLoss,
    qualityScore,
  };
}

function upsertRecordingFromCompletedJob(recordings: TrainingRecordingSummary[], job: TrainingJobSummary) {
  if (job.status !== "completed") return recordings;

  const next = buildRecordingFromJob(job);
  const nextTenantId = resolveTrainingCacheTenantId(next.tenantId);
  const exists = recordings.some(
    (recording) => recording.jobId === job.id && resolveTrainingCacheTenantId(recording.tenantId) === nextTenantId
  );
  if (exists) return recordings;
  return [next, ...recordings];
}

function buildLocalArtifacts(job: TrainingJobSummary): TrainingArtifactSummary[] {
  if (job.status !== "completed" && job.status !== "running") return [];

  const createdAt = new Date(job.updatedAt).toISOString();
  const artifacts: TrainingArtifactSummary[] = [
    {
      id: `artifact-log-${job.id}`,
      jobId: job.id,
      kind: "log",
      uri: `local://training/${job.id}/logs`,
      createdAt,
    },
  ];

  if (job.status === "completed") {
    artifacts.unshift({
      id: `artifact-video-${job.id}`,
      jobId: job.id,
      kind: "video",
      uri: `local://training/${job.id}/recording`,
      createdAt,
    });
  }

  return artifacts;
}

export function buildLocalEvents(job: TrainingJobSummary): TrainingJobEventSummary[] {
  const baseTime = job.startedAt;
  const updatedTime = job.updatedAt;
  const launchContext = toObjectOrEmpty(job.launchContext);
  const submissionStatus = String(launchContext.launchSubmissionStatus ?? "").trim();
  const submissionFailed = job.status === "failed" && submissionStatus === "submit_failed";
  const items: TrainingJobEventSummary[] = [];
  const pushEvent = (
    eventType: string,
    payload: Record<string, unknown>,
    createdAtMs: number
  ) => {
    items.push({
      id: `evt-${eventType.replace(/[^a-z0-9]+/gi, "_")}-${job.id}`,
      jobId: job.id,
      eventType,
      payload,
      createdAt: new Date(createdAtMs).toISOString(),
    });
  };

  if (
    job.status === "submitting" ||
    job.status === "queued" ||
    job.status === "provisioning" ||
    job.status === "running" ||
    job.status === "completed" ||
    job.status === "failed" ||
    job.status === "cancelled"
  ) {
    pushEvent(
      "job.submitting",
      {
        status: "submitting",
      },
      baseTime
    );
  }

  if (
    job.status === "queued" ||
    job.status === "provisioning" ||
    job.status === "running" ||
    job.status === "completed" ||
    (job.status === "failed" && !submissionFailed) ||
    job.status === "cancelled"
  ) {
    pushEvent(
      "job.queued",
      {
        status: "queued",
      },
      baseTime + 120
    );
  }

  if (
    job.status === "provisioning" ||
    job.status === "running" ||
    job.status === "completed" ||
    (job.status === "failed" && !submissionFailed) ||
    job.status === "cancelled"
  ) {
    pushEvent(
      "job.provisioning",
      {
        status: "provisioning",
      },
      Math.max(baseTime + 300, Math.min(updatedTime, baseTime + 1000))
    );
  }

  if (job.status === "running" || job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
    if (submissionFailed) {
      // A submission failure never reaches provisioning/running.
    } else {
      pushEvent(
        "job.running",
        {
          status: "running",
        },
        Math.max(baseTime + 600, Math.min(updatedTime, baseTime + 1400))
      );
    }
  }

  if (job.currentEpoch > 0 && !submissionFailed) {
    pushEvent(
      "job.metrics",
      {
        currentEpoch: job.currentEpoch,
        progress: job.progress,
        loss: job.loss,
      },
      updatedTime
    );
  }

  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
    const terminalEventType =
      submissionFailed ? "job.submit_failed" : `job.${job.status}`;
    pushEvent(
      terminalEventType,
      {
        status: job.status,
        ...(job.failureReason ? { failureReason: job.failureReason } : {}),
        ...(submissionStatus ? { launchSubmissionStatus: submissionStatus } : {}),
      },
      updatedTime
    );
  }

  return items
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((event) => ({ ...event }));
}

function buildLocalRunnerLogs(job: TrainingJobSummary): TrainingRunnerLogsSummary {
  return {
    jobId: job.id,
    runnerJobId: null,
    totalLines: 0,
    lines: [],
    highlights: [],
    runtime: null,
    unavailableReason: "runner_mode_not_remote",
  };
}

async function syncRemoteJobsOnce() {
  if (!trainingApiEnabled || remoteSyncInFlight) return;
  remoteSyncInFlight = true;

  try {
    const remoteJobs = (await listTrainingJobsRemote()).filter((job) => !isTrainingJobDeleted(job));
    if (remoteJobs.length > 0) {
      void cacheTrainingJobs({ items: remoteJobs }).catch((error) => {
        logWarn("Failed to cache remote jobs locally", {
          scope: "runtime-training",
          data: error,
        });
      });
    }

    useRuntimeTrainingStore.setState((current) => {
      const optimistic = current.jobs.filter((job) => optimisticJobIds.has(job.id));
      const existingById = new Map(current.jobs.map((job) => [job.id, job] as const));
      const remoteWithContext = remoteJobs.map((job) => {
        const existing = existingById.get(job.id);
        const launchContext = mergeLaunchContexts(existing?.launchContext, job.launchContext);
        if (!launchContext) return job;
        return {
          ...job,
          launchContext,
        };
      });
      const persistedLocal = current.jobs.filter((job) => !optimisticJobIds.has(job.id));
      const mergedById = new Map(persistedLocal.map((job) => [job.id, job] as const));
      for (const remoteJob of remoteWithContext) {
        mergedById.set(remoteJob.id, remoteJob);
      }
      const mergedJobs = sortJobs([...mergedById.values(), ...optimistic]);

      let nextRecordings = current.recordings;
      for (const job of mergedById.values()) {
        nextRecordings = upsertRecordingFromCompletedJob(nextRecordings, job);
      }

      return {
        jobs: mergedJobs,
        recordings: nextRecordings,
      };
    });
  } catch (error) {
    logWarn("Failed to sync jobs from training API", {
      scope: "runtime-training",
      data: error,
    });
    void hydrateJobsFromLocalCache({ forceMerge: false });
  } finally {
    remoteSyncInFlight = false;
  }
}

async function hydrateJobsFromLocalCache(input: { forceMerge: boolean }) {
  const cachedJobs = (await listCachedTrainingJobs(MAX_JOB_HISTORY_ITEMS)).filter((job) => !isTrainingJobDeleted(job));
  if (cachedJobs.length === 0) return;

  useRuntimeTrainingStore.setState((current) => {
    const optimistic = current.jobs.filter((job) => optimisticJobIds.has(job.id));
    const hasPersistedCurrent = current.jobs.some((job) => !optimisticJobIds.has(job.id));
    if (!input.forceMerge && hasPersistedCurrent) {
      return current;
    }

    const existingById = new Map(current.jobs.map((job) => [job.id, job] as const));
    const cachedWithContext = cachedJobs.map((job) => {
      const existing = existingById.get(job.id);
      const launchContext = mergeLaunchContexts(existing?.launchContext, job.launchContext);
      if (!launchContext) return job;
      return {
        ...job,
        launchContext,
      };
    });
    const mergedJobs = sortJobs([...cachedWithContext, ...optimistic]);

    let nextRecordings = current.recordings;
    for (const job of cachedWithContext) {
      nextRecordings = upsertRecordingFromCompletedJob(nextRecordings, job);
    }

    return {
      jobs: mergedJobs,
      recordings: nextRecordings,
    };
  });
}

function hydrateJobsFromLocalCacheOnce() {
  if (!trainingApiEnabled) return;
  if (localJobsHydrationPromise) return;
  localJobsHydrationPromise = hydrateJobsFromLocalCache({ forceMerge: false })
    .catch((error) => {
      logWarn("Failed to hydrate jobs from local cache", {
        scope: "runtime-training",
        data: error,
      });
    })
    .finally(() => {
      localJobsHydrationPromise = null;
    });
}

function ensureRemotePolling() {
  if (!trainingApiEnabled) return;
  if (remotePollingTimer !== null || remoteSyncConsumerCount <= 0) return;

  void syncRemoteJobsOnce();
  remotePollingTimer = window.setInterval(() => {
    void syncRemoteJobsOnce();
  }, 2000);
}

function stopRemotePollingIfIdle() {
  if (remoteSyncConsumerCount > 0) return;
  if (remotePollingTimer === null) return;
  window.clearInterval(remotePollingTimer);
  remotePollingTimer = null;
}

function requestRemoteJobsSyncOnce() {
  if (!trainingApiEnabled) return;
  void syncRemoteJobsOnce();
}

function startRemoteJobSyncSession() {
  if (!trainingApiEnabled) return () => {};

  hydrateJobsFromLocalCacheOnce();
  remoteSyncConsumerCount += 1;
  ensureRemotePolling();
  requestRemoteJobsSyncOnce();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    remoteSyncConsumerCount = Math.max(0, remoteSyncConsumerCount - 1);
    stopRemotePollingIfIdle();
  };
}

function clearTrainingTimer(jobId: string) {
  const timer = runningIntervals.get(jobId);
  if (timer !== undefined) {
    window.clearInterval(timer);
    runningIntervals.delete(jobId);
  }
}

function scheduleTrainingProgress(jobId: string) {
  const timer = window.setInterval(() => {
    const state = useRuntimeTrainingStore.getState();
    const job = state.jobs.find((item) => item.id === jobId);

    if (!job || job.status !== "running") {
      clearTrainingTimer(jobId);
      return;
    }

    const nextEpoch = Math.min(job.epochs, job.currentEpoch + 1);
    const nextProgress = nextEpoch / Math.max(1, job.epochs);
    const trend = 1.2 * (1 - nextProgress) + 0.05;
    const jitter = (Math.random() - 0.5) * 0.08;
    const nextLoss = Number(Math.max(0.02, trend + jitter).toFixed(4));
    const updatedAt = Date.now();
    const finished = nextEpoch >= job.epochs;
    const nextStatus: TrainingJobStatus = finished ? "completed" : "running";

    useRuntimeTrainingStore.setState((current) => {
      const updatedJobs = current.jobs.map((item) =>
        item.id === jobId
          ? {
              ...item,
              currentEpoch: nextEpoch,
              progress: nextProgress,
              loss: nextLoss,
              status: nextStatus,
              updatedAt,
            }
          : item
      );

      if (!finished) {
        return { jobs: updatedJobs };
      }

      const exists = current.recordings.some(
        (recording) =>
          recording.jobId === jobId &&
          resolveTrainingCacheTenantId(recording.tenantId) === resolveTrainingCacheTenantId(job.tenantId)
      );
      if (exists) {
        return { jobs: updatedJobs };
      }

      const qualityScore = Number(Math.max(0, (1 - nextLoss) * 100).toFixed(1));
      const recording: TrainingRecordingSummary = {
        id: `rec_${Date.now()}_${recordingCounter++}`,
        jobId,
        tenantId: resolveTrainingCacheTenantId(job.tenantId),
        title: `${job.modelName} · ${job.dataset}`,
        createdAt: updatedAt,
        previewUrl: null,
        finalLoss: nextLoss,
        qualityScore,
      };

      return {
        jobs: updatedJobs,
        recordings: [recording, ...current.recordings],
      };
    });

    if (finished) {
      clearTrainingTimer(jobId);
      logInfo("Training job completed", { scope: "runtime-training", data: { jobId } });
    }
  }, 900);

  runningIntervals.set(jobId, timer);
}

function toObjectOrEmpty(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function mergeLaunchContexts(
  existingValue: unknown,
  incomingValue: unknown
): Record<string, unknown> | undefined {
  const existing = toObjectOrEmpty(existingValue);
  const incoming = toObjectOrEmpty(incomingValue);
  if (Object.keys(existing).length === 0 && Object.keys(incoming).length === 0) return undefined;
  const merged: Record<string, unknown> = {
    ...existing,
    ...incoming,
  };
  const existingLaunchDiagnostics = toObjectOrEmpty(existing.launchDiagnostics);
  const incomingLaunchDiagnostics = toObjectOrEmpty(incoming.launchDiagnostics);
  if (Object.keys(existingLaunchDiagnostics).length > 0 || Object.keys(incomingLaunchDiagnostics).length > 0) {
    merged.launchDiagnostics = {
      ...existingLaunchDiagnostics,
      ...incomingLaunchDiagnostics,
    };
  }
  const existingLaunchDispatchTrace = toObjectOrEmpty(existing.launchDispatchTrace);
  const incomingLaunchDispatchTrace = toObjectOrEmpty(incoming.launchDispatchTrace);
  if (Object.keys(existingLaunchDispatchTrace).length > 0 || Object.keys(incomingLaunchDispatchTrace).length > 0) {
    merged.launchDispatchTrace = {
      ...existingLaunchDispatchTrace,
      ...incomingLaunchDispatchTrace,
    };
  }
  return merged;
}

function isOptimisticLocalJobId(jobId: string) {
  return jobId.startsWith("local_job_");
}

function buildLaunchContextFromInput(
  input: SubmitTrainingJobInput,
  configValues: Record<string, unknown>
): Record<string, unknown> {
  const context: Record<string, unknown> = {
    createdAt: new Date().toISOString(),
    modelName: input.modelName,
    dataset: input.dataset,
    experimentName: input.experimentName ?? input.modelName,
    envId: input.envId ?? input.dataset,
    trainer: input.trainer ?? "rsl_rl",
    epochs: input.epochs,
    maxSteps: input.maxSteps ?? input.epochs,
  };

  const keysToCopy = [
    "recipeId",
    "executionMode",
    "taskTemplate",
    "task",
    "agentId",
    "catalogVersion",
    "authoredProfileContract",
    "robotAssetId",
    "sceneAssetId",
    "baseConstraintMode",
    "assetPipeline",
    "environment",
    "policy",
    "policyRules",
    "extraArgs",
    "userModelMetadata",
    "launchDiagnostics",
    "launchDispatchTrace",
    "launchTraceId",
    "launchSubmissionStatus",
    "launchSubmissionError",
    "launchSubmissionResponseStatus",
  ];
  for (const key of keysToCopy) {
    const value = configValues[key];
    if (value === undefined) continue;
    context[key] = value;
  }

  return context;
}

export const useRuntimeTrainingStore: UseBoundStore<StoreApi<RuntimeTrainingState>> = create<RuntimeTrainingState>(
  (set, get) => ({
  jobs: [],
  recordings: [],
  trainingTokens: initialTrainingTokens,
  trainingTokenCost: trainingTokenCost,
  startRemoteJobSync: () => {
    return startRemoteJobSyncSession();
  },

  submitTrainingJob: (input) => {
    const modelName = input.modelName.trim() || "default-model";
    const dataset = input.dataset.trim() || "default-dataset";
    const activeForDataset = get().jobs.find(
      (job) => job.dataset === dataset && ACTIVE_JOB_STATUSES.has(job.status)
    );
    if (activeForDataset) {
      logWarn("Training job launch blocked: active job already exists for dataset", {
        scope: "runtime-training",
        data: {
          dataset,
          existingJobId: activeForDataset.id,
          status: activeForDataset.status,
        },
      });
      return activeForDataset.id;
    }

    const tokenCostPerJob = get().trainingTokenCost;
    if (get().trainingTokens < tokenCostPerJob) {
      logWarn("Training job launch blocked: not enough tokens", {
        scope: "runtime-training",
        data: {
          required: tokenCostPerJob,
          available: get().trainingTokens,
        },
      });
      return "";
    }

    set((state) => ({
      trainingTokens: Math.max(0, state.trainingTokens - state.trainingTokenCost),
    }));

    if (trainingApiEnabled) {
      requestRemoteJobsSyncOnce();

      const now = Date.now();
      const localId = `local_job_${now}_${trainingJobCounter++}`;
      const epochs = Math.max(1, Math.round(input.epochs));
      const experimentName = (input.experimentName ?? modelName).trim() || modelName;
      const maxSteps = Math.max(1, Math.round(input.maxSteps ?? epochs));
      const configObject = input.config ?? {};
      const configValues = toObjectOrEmpty(configObject);
      const launchContext = buildLaunchContextFromInput(input, configValues);
      const optimisticJob: TrainingJobSummary = {
        id: localId,
        modelName,
        dataset,
        epochs,
        status: "submitting",
        progress: 0,
        currentEpoch: 0,
        loss: null,
        startedAt: now,
        updatedAt: now,
        launchContext: {
          ...launchContext,
          launchSubmissionStatus: "submitting",
        },
      };

      optimisticJobIds.add(localId);
      set((state) => ({ jobs: sortJobs([optimisticJob, ...state.jobs]) }));

      const submissionPromise = Promise.resolve()
        .then(async () => {
          const customTaskBuild = await isaacLabEnvironmentManager.buildCustomTaskRequest({
            submit: {
              ...input,
              experimentName,
              maxSteps,
            },
            config: configValues,
            doc: editorEngine.getDoc(),
          });
          const taskWarnings = customTaskBuild.diagnostics.filter((item) => item.severity === "warning");
          if (taskWarnings.length > 0) {
            logWarn("Training request built with environment warnings", {
              scope: "runtime-training",
              data: {
                localId,
                warnings: taskWarnings.map((warning) => `${warning.code}: ${warning.message}`),
              },
            });
          }
          const taskErrors = customTaskBuild.diagnostics.filter((item) => item.severity === "error");
          if (taskErrors.length > 0) {
            throw new Error(
              taskErrors.map((item) => `${item.code}: ${item.message}`).join(" | ")
            );
          }
          const customTaskRequest = customTaskBuild.request;
          const taskResponse = await submitTrainingTaskRemoteWithResponse(customTaskRequest);
          if (taskResponse.status !== 202) {
            throw new Error(`Training API ${taskResponse.status}: launch was not accepted.`);
          }
          if (!taskResponse.response || typeof taskResponse.response !== "object" || !("job" in taskResponse.response)) {
            throw new Error("Custom training request returned an invalid launch payload.");
          }
          return taskResponse.response.job;
        });

      void submissionPromise
        .then((remoteJob) => {
          unmarkTrainingJobDeleted(remoteJob);
          optimisticJobIds.delete(localId);
          const launchContextWithSource = {
            ...mergeLaunchContexts(remoteJob.launchContext, launchContext),
            sourceLocalJobId: localId,
            launchSubmissionStatus: "accepted",
            launchSubmissionResponseStatus: 202,
          };
          const enrichedRemoteJob: TrainingJobSummary = {
            ...remoteJob,
            status: "queued",
            launchContext: launchContextWithSource,
          };
          set((state) => {
            const withoutLocal = state.jobs.filter((job) => job.id !== localId && job.id !== remoteJob.id);
            const merged = sortJobs([enrichedRemoteJob, ...withoutLocal]);
            return {
              jobs: merged,
              recordings: upsertRecordingFromCompletedJob(state.recordings, enrichedRemoteJob),
            };
          });
          void cacheTrainingJobs({ items: [enrichedRemoteJob] }).catch((cacheError) => {
            logWarn("Failed to cache submitted remote job locally", {
              scope: "runtime-training",
              data: { remoteId: remoteJob.id, error: cacheError },
            });
          });
          logInfo("Training job submitted to remote API", {
            scope: "runtime-training",
            data: { localId, remoteId: remoteJob.id },
          });
          requestRemoteJobsSyncOnce();
        })
        .catch((error) => {
          optimisticJobIds.delete(localId);
          const message = error instanceof Error ? error.message : String(error);
          set((state) => ({
            trainingTokens: state.trainingTokens + state.trainingTokenCost,
            jobs: state.jobs.map((job) =>
              job.id === localId
                ? {
                    ...job,
                    status: "failed",
                    failureReason: message,
                    launchContext: {
                      ...toObjectOrEmpty(job.launchContext),
                      launchSubmissionStatus: "submit_failed",
                      launchSubmissionError: message,
                    },
                    updatedAt: Date.now(),
                  }
                : job
            ),
          }));
          logError("Training job submission failed", {
            scope: "runtime-training",
            data: { localId, error: message },
          });
        });

      return localId;
    }

    const now = Date.now();
    const id = `job_${now}_${trainingJobCounter++}`;
    const epochs = Math.max(1, Math.round(input.epochs));
    const launchContext = buildLaunchContextFromInput(input, toObjectOrEmpty(input.config ?? {}));

    const job: TrainingJobSummary = {
      id,
      modelName,
      dataset,
      epochs,
      status: "queued",
      progress: 0,
      currentEpoch: 0,
      loss: null,
      startedAt: now,
      updatedAt: now,
      launchContext,
    };

    set((state) => ({ jobs: [job, ...state.jobs] }));
    logInfo("Training job queued", { scope: "runtime-training", data: { id, modelName, dataset, epochs } });

    const queueDelayMs = 500 + Math.round(Math.random() * 400);
    window.setTimeout(() => {
      const queued = get().jobs.find((item) => item.id === id);
      if (!queued || queued.status === "cancelled") return;

      set((state) => ({
        jobs: state.jobs.map((item) =>
          item.id === id
            ? {
                ...item,
                status: "running",
                startedAt: Date.now(),
                updatedAt: Date.now(),
              }
            : item
        ),
      }));

      logInfo("Training job started", { scope: "runtime-training", data: { jobId: id } });
      scheduleTrainingProgress(id);
    }, queueDelayMs);

    return id;
  },

  cancelTrainingJob: (jobId) => {
    if (trainingApiEnabled) {
      if (optimisticJobIds.has(jobId)) {
        optimisticJobIds.delete(jobId);
        set((state) => ({
          jobs: state.jobs.map((item) =>
            item.id === jobId
              ? {
                  ...item,
                  status: (item.status === "completed" ? "completed" : "cancelled") as TrainingJobStatus,
                  updatedAt: Date.now(),
                }
              : item
          ),
        }));
        return;
      }

      void cancelTrainingJobRemote(jobId)
        .catch((error) => {
          logWarn("Failed to cancel remote training job", {
            scope: "runtime-training",
            data: { jobId, error },
          });
        })
        .finally(() => {
          requestRemoteJobsSyncOnce();
        });
      return;
    }

    clearTrainingTimer(jobId);

    set((state) => ({
      jobs: state.jobs.map((item) =>
        item.id === jobId
          ? {
              ...item,
              status: (item.status === "completed" ? "completed" : "cancelled") as TrainingJobStatus,
              updatedAt: Date.now(),
            }
          : item
      ),
    }));

    logInfo("Training job cancelled", { scope: "runtime-training", data: { jobId } });
  },

  deleteTrainingJob: (jobId, tenantId) => {
    const requestedTenantId =
      typeof tenantId === "string" && tenantId.trim().length > 0
        ? resolveTrainingCacheTenantId(tenantId)
        : null;
    const targetJob =
      get().jobs.find(
        (job) =>
          job.id === jobId &&
          (requestedTenantId === null || resolveTrainingCacheTenantId(job.tenantId) === requestedTenantId)
      ) ?? null;
    if (!targetJob) return;

    markTrainingJobDeleted(targetJob);
    optimisticJobIds.delete(jobId);
    const targetTenantId = resolveTrainingCacheTenantId(targetJob.tenantId);

    set((state) => ({
      jobs: state.jobs.filter(
        (job) => !(job.id === jobId && resolveTrainingCacheTenantId(job.tenantId) === targetTenantId)
      ),
      recordings: state.recordings.filter(
        (recording) =>
          !(
            recording.jobId === jobId && resolveTrainingCacheTenantId(recording.tenantId) === targetTenantId
          )
      ),
    }));

    void deleteTrainingTelemetryForJob({ tenantId: targetTenantId, jobId }).catch((error) => {
      logWarn("Failed to delete local training telemetry for job", {
        scope: "runtime-training",
        data: { tenantId: targetTenantId, jobId, error },
      });
    });
  },

  listTrainingArtifacts: async (jobId, kind): Promise<TrainingArtifactSummary[]> => {
    if (isOptimisticLocalJobId(jobId)) {
      const job = get().jobs.find((item) => item.id === jobId) ?? null;
      if (!job) return [];
      const local = buildLocalArtifacts(job);
      if (!kind) return local;
      return local.filter((item) => item.kind === kind);
    }

    if (trainingApiEnabled) {
      try {
        return await listTrainingArtifactsRemote(jobId, kind);
      } catch (error) {
        logWarn("Failed to list training artifacts from remote API", {
          scope: "runtime-training",
          data: { jobId, kind, error },
        });
        return [];
      }
    }

    const job = get().jobs.find((item) => item.id === jobId) ?? null;
    if (!job) return [];
    const local = buildLocalArtifacts(job);
    if (!kind) return local;
    return local.filter((item) => item.kind === kind);
  },

  listTrainingJobEvents: async (jobId, limit = 100): Promise<TrainingJobEventSummary[]> => {
    const boundedLimit = Math.min(Math.max(1, Math.round(limit)), MAX_EVENT_HISTORY_ITEMS);

    if (isOptimisticLocalJobId(jobId)) {
      const job = get().jobs.find((item) => item.id === jobId) ?? null;
      if (!job) return [];
      return buildLocalEvents(job).slice(0, boundedLimit);
    }

    if (trainingApiEnabled) {
      const tenantId = resolveTrainingCacheTenantId(get().jobs.find((item) => item.id === jobId)?.tenantId);
      try {
        const cached = await listCachedTrainingEvents({
          tenantId,
          jobId,
          limit: boundedLimit,
        });
        if (cached.length > 0) return cached;

        const hydrated = await hasHydratedTrainingEvents({ tenantId, jobId });
        if (hydrated) return [];

        const remote = await listTrainingJobEventsRemote(jobId, boundedLimit);
        if (remote.length > 0) {
          try {
            await cacheTrainingEvents({
              tenantId,
              jobId,
              items: remote,
            });
          } catch (cacheError) {
            logWarn("Failed to cache training job events locally", {
              scope: "runtime-training",
              data: { tenantId, jobId, error: cacheError },
            });
          }
        }
        try {
          await markHydratedTrainingEvents({ tenantId, jobId });
        } catch (markError) {
          logWarn("Failed to mark training event hydration", {
            scope: "runtime-training",
            data: { tenantId, jobId, error: markError },
          });
        }
        return remote;
      } catch (error) {
        logWarn("Failed to list training job events from remote API", {
          scope: "runtime-training",
          data: { jobId, limit: boundedLimit, error },
        });
        return [];
      }
    }

    const job = get().jobs.find((item) => item.id === jobId) ?? null;
    if (!job) return [];
    return buildLocalEvents(job).slice(0, boundedLimit);
  },

  listTrainingRunnerLogs: async (jobId, tail = 250): Promise<TrainingRunnerLogsSummary> => {
    if (isOptimisticLocalJobId(jobId)) {
      const job = get().jobs.find((item) => item.id === jobId) ?? null;
      if (!job) {
        return {
          jobId,
          runnerJobId: null,
          totalLines: 0,
          lines: [],
          highlights: [],
          runtime: null,
          unavailableReason: "job_not_found",
        };
      }
      return buildLocalRunnerLogs(job);
    }

    if (trainingApiEnabled) {
      try {
        return await getTrainingRunnerLogsRemote(jobId, tail);
      } catch (error) {
        logWarn("Failed to read runner logs from remote API", {
          scope: "runtime-training",
          data: { jobId, tail, error },
        });
        return {
          jobId,
          runnerJobId: null,
          totalLines: 0,
          lines: [],
          highlights: [],
          runtime: null,
          unavailableReason: "runner_logs_fetch_failed",
        };
      }
    }

    const job = get().jobs.find((item) => item.id === jobId) ?? null;
    if (!job) {
      return {
        jobId,
        runnerJobId: null,
        totalLines: 0,
        lines: [],
        highlights: [],
        runtime: null,
        unavailableReason: "job_not_found",
      };
    }
    return buildLocalRunnerLogs(job);
  },
})
);
