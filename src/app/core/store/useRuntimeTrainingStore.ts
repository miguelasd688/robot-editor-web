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
  buildTrainingLivePulseStreamUrl,
  cancelTrainingJobRemote,
  getTrainingRunnerLogsRemote,
  listTrainingMetricBatchesRemote,
  submitTrainingTaskRemoteWithResponse,
  listTrainingArtifactsRemote,
  listTrainingJobEventsRemote,
  type TrainingLivePulseSseEvent,
  type TrainingMetricBatchSummary,
  listTrainingJobsRemote,
  trainingApiEnabled,
} from "../services/trainingApiClient";
import { logError, logInfo, logWarn } from "../services/logger";
import {
  cacheTrainingJobs,
  cacheTrainingEvents,
  cacheMetricBatches,
  deleteTrainingTelemetryForJob,
  hasHydratedTrainingEvents,
  hasHydratedMetricBatches,
  listCachedTrainingJobs,
  listCachedTrainingEvents,
  listCachedMetricBatches,
  markHydratedTrainingEvents,
  markHydratedMetricBatches,
  resolveTrainingCacheTenantId,
} from "../services/trainingTelemetryCache";
import { isaacLabEnvironmentManager } from "../training/IsaacLabEnvironmentManager";
import { editorEngine } from "../editor/engineSingleton";
import { useTrainingImportContextStore } from "./useTrainingImportContextStore";

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
  listTrainingMetricBatches: (jobId: string, limit?: number) => Promise<TrainingMetricBatchSummary[]>;
  listTrainingRunnerLogs: (jobId: string, tail?: number) => Promise<TrainingRunnerLogsSummary>;
};

const runningIntervals = new Map<string, number>();
const optimisticJobIds = new Set<string>();
let remoteSyncConsumerCount = 0;
let remoteSyncInFlight = false;
const livePulseSources = new Map<string, EventSource>();
const livePulseReconnectTimers = new Map<string, number>();
const livePulseReconnectAttempts = new Map<string, number>();
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

function closeLivePulseSource(jobId: string) {
  const reconnectTimer = livePulseReconnectTimers.get(jobId);
  if (reconnectTimer !== undefined) {
    window.clearTimeout(reconnectTimer);
    livePulseReconnectTimers.delete(jobId);
  }
  livePulseReconnectAttempts.delete(jobId);
  const existing = livePulseSources.get(jobId);
  if (!existing) return;
  existing.close();
  livePulseSources.delete(jobId);
}

function scheduleLivePulseReconnect(jobId: string) {
  if (typeof window === "undefined") return;
  if (livePulseReconnectTimers.has(jobId)) return;
  const attempt = (livePulseReconnectAttempts.get(jobId) ?? 0) + 1;
  livePulseReconnectAttempts.set(jobId, attempt);
  const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 4));
  const timer = window.setTimeout(() => {
    livePulseReconnectTimers.delete(jobId);
    const state = useRuntimeTrainingStore.getState();
    const job = state.jobs.find((item) => item.id === jobId);
    if (!job || !ACTIVE_JOB_STATUSES.has(job.status) || !trainingApiEnabled || typeof EventSource === "undefined") {
      return;
    }
    closeLivePulseSource(jobId);
    ensureLivePulseSubscriptions(state.jobs);
  }, delay);
  livePulseReconnectTimers.set(jobId, timer);
}

async function catchUpMetricBatchesForJob(jobId: string) {
  if (!trainingApiEnabled) return;
  if (jobId.startsWith("local_job_")) return;
  const state = useRuntimeTrainingStore.getState();
  const selectedJob = state.jobs.find((item) => item.id === jobId);
  if (!selectedJob || !ACTIVE_JOB_STATUSES.has(selectedJob.status)) return;
  const tenantId = resolveTrainingCacheTenantId(selectedJob.tenantId);
  try {
    const cached = await listCachedMetricBatches({ tenantId, jobId, limit: 1 });
    const cachedLatestStep = cached[0]?.toStep ?? 0;
    const remoteBatches = await listTrainingMetricBatchesRemote(jobId, 50);
    const remoteLatestStep = remoteBatches[0]?.toStep ?? 0;
    if (remoteLatestStep <= cachedLatestStep) return;
    await cacheMetricBatches({ tenantId, jobId, items: remoteBatches });
    if (shouldPersistMetricBatchHydration(selectedJob, remoteBatches)) {
      await markHydratedMetricBatches({ tenantId, jobId });
    }
  } catch (error) {
    logWarn("Failed to catch up metric batches", {
      scope: "runtime-training",
      data: { jobId, error },
    });
  }
}

function closeAllLivePulseSources() {
  for (const jobId of livePulseSources.keys()) closeLivePulseSource(jobId);
}

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

function shouldPersistMetricBatchHydration(
  job: TrainingJobSummary | null | undefined,
  remoteBatches: TrainingMetricBatchSummary[]
) {
  return remoteBatches.length > 0 || !job || !ACTIVE_JOB_STATUSES.has(job.status);
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

  const currentEpoch = Number(job.currentEpoch ?? 0);
  if (currentEpoch > 0 && !submissionFailed) {
    pushEvent(
      "runner.metrics",
      {
        step: currentEpoch,
        currentEpoch,
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

function resolveEpisodeBudget(job: Pick<TrainingJobSummary, "episodeTarget" | "maxSteps">) {
  return Math.max(1, Math.round(job.episodeTarget ?? job.maxSteps ?? 1));
}

function buildMetricEventsFromBatches(jobId: string, batches: TrainingMetricBatchSummary[]): TrainingJobEventSummary[] {
  const items: TrainingJobEventSummary[] = [];
  const orderedBatches = batches
    .slice()
    .sort((a, b) => {
      if (a.toStep !== b.toStep) return a.toStep - b.toStep;
      return Date.parse(a.createdAt) - Date.parse(b.createdAt);
    });
  for (const batch of orderedBatches) {
    const orderedSamples = (batch.samples ?? [])
      .slice()
      .sort((a, b) => {
        if (a.metricStep !== b.metricStep) return a.metricStep - b.metricStep;
        return Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
      });
    for (const sample of orderedSamples) {
      items.push({
        id: `${batch.batchId}:${sample.metricStep}:${sample.occurredAt}`,
        jobId,
        eventType: "runner.metrics",
        payload: {
          batchId: batch.batchId,
          source: "metrics_batch",
          metricStep: sample.metricStep,
          progressRatio: sample.progressRatio ?? null,
          canonicalMetrics: sample.canonicalMetrics ?? {},
          rawMetrics: sample.rawMetrics ?? {},
          metrics: {
            ...(sample.rawMetrics ?? {}),
            ...(sample.metrics ?? {}),
            ...(sample.canonicalMetrics ?? {}),
          },
          ...(sample.episodeIndex === null || sample.episodeIndex === undefined
            ? {}
            : {
                currentEpisode: sample.episodeIndex,
                episodeIndex: sample.episodeIndex,
              }),
        },
        createdAt: sample.occurredAt,
      });
    }
  }
  items.sort((a, b) => {
    const leftStep = Number((a.payload as Record<string, unknown>).metricStep ?? 0);
    const rightStep = Number((b.payload as Record<string, unknown>).metricStep ?? 0);
    const stepDiff = leftStep - rightStep;
    if (stepDiff !== 0) return stepDiff;
    return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  });
  return items;
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
        const withContext = !launchContext
          ? job
          : {
              ...job,
              launchContext,
            };
        return mergeActiveJobTruth(existing, withContext, existing?.liveTelemetrySummary ?? null);
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
    ensureLivePulseSubscriptions(useRuntimeTrainingStore.getState().jobs);
    void Promise.all(
      useRuntimeTrainingStore
        .getState()
        .jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status))
        .filter((job) => !job.id.startsWith("local_job_"))
        .map((job) => catchUpMetricBatchesForJob(job.id))
    );
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
      const withContext = !launchContext
        ? job
        : {
            ...job,
            launchContext,
          };
      return mergeActiveJobTruth(existing, withContext, existing?.liveTelemetrySummary ?? null);
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
  ensureLivePulseSubscriptions(useRuntimeTrainingStore.getState().jobs);
}

function applyLivePulseToJob(job: TrainingJobSummary, pulse: TrainingLivePulseSseEvent): TrainingJobSummary {
  const nextStatus = (pulse.status ?? job.status) as TrainingJobStatus;
  const latestMetricSurface = pulse.latestMetricSurface ?? pulse.metrics ?? pulse.latestMetricSample ?? null;
  const latestMetricSample = pulse.latestMetricSample ?? latestMetricSurface ?? null;
  const explicitEpisodeIndex =
    pulse.episodeIndex === null || pulse.episodeIndex === undefined
      ? null
      : Math.max(0, Math.round(Number(pulse.episodeIndex) || 0));
  const currentEpoch = Math.max(Number(job.currentEpoch ?? 0), Math.round(Number(pulse.metricStep ?? 0)));
  const currentEpisode =
    explicitEpisodeIndex === null
      ? job.currentEpisode
      : Math.max(Number(job.currentEpisode ?? 0), explicitEpisodeIndex);
  const nextProgress = Number.isFinite(Number(pulse.progressRatio))
    ? Math.max(0, Math.min(1, Number(pulse.progressRatio)))
    : job.progress;
  const nextLossRaw = Number(latestMetricSample?.loss);
  const nextLoss = Number.isFinite(nextLossRaw) ? nextLossRaw : job.loss;
  const updatedAt = Date.parse(String(pulse.occurredAt ?? "")) || Date.now();
  return {
    ...job,
    status: nextStatus,
    lifecycleStatus: nextStatus,
    currentEpoch,
    currentEpisode,
    progress: nextProgress,
    loss: nextLoss,
    updatedAt,
    liveTelemetrySummary: {
      ...(job.liveTelemetrySummary ?? {}),
      latestLivePulseStep: pulse.metricStep ?? null,
      latestLivePulseEpisodeIndex:
        explicitEpisodeIndex === null ? job.liveTelemetrySummary?.latestLivePulseEpisodeIndex ?? null : explicitEpisodeIndex,
      latestMetricSample,
      latestRawMetricSample: pulse.latestRawMetricSample ?? null,
      latestMetricSurface,
      source: pulse.source ?? null,
      latestVisibleClipIndex: pulse.visibleClipIndex ?? null,
      latestClipIndex: pulse.latestClipIndex ?? null,
      latestVisibleVideoStep: pulse.visibleVideoStep ?? null,
      eventId: pulse.eventId ?? null,
      occurredAt: pulse.occurredAt ?? null,
    },
    recordingLiveSyncSummary: {
      ...(job.recordingLiveSyncSummary ?? {}),
      visibleClipIndex: pulse.visibleClipIndex ?? null,
      latestClipIndex: pulse.latestClipIndex ?? null,
      visibleVideoStep: pulse.visibleVideoStep ?? null,
      occurredAt: pulse.occurredAt ?? null,
    },
  };
}

function parseLiveTelemetryTimestamp(summary: TrainingJobSummary["liveTelemetrySummary"] | null | undefined) {
  const occurredAt = String((summary as Record<string, unknown> | null | undefined)?.occurredAt ?? "").trim();
  const parsed = Date.parse(occurredAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isTerminalJobStatus(status: TrainingJobStatus) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toFiniteNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getStatusRank(status: TrainingJobStatus | string | null | undefined) {
  if (status === "queued" || status === "submitting") return 0;
  if (status === "provisioning") return 1;
  if (status === "running") return 2;
  return -1;
}

function resolveVisibleActiveStatus(
  existing: TrainingJobSummary | undefined,
  incoming: TrainingJobSummary,
  freshestLiveSummary: TrainingJobSummary["liveTelemetrySummary"] | null
): TrainingJobStatus {
  const liveSummary = isObject(freshestLiveSummary) ? freshestLiveSummary : null;
  const crossSurfaceTruth = isObject(liveSummary?.crossSurfaceTruthSummary)
    ? (liveSummary?.crossSurfaceTruthSummary as Record<string, unknown>)
    : null;
  const hasLiveTelemetryStep =
    toFiniteNumber(crossSurfaceTruth?.runnerLivePulseIteration) !== null ||
    toFiniteNumber(liveSummary?.latestLivePulseStep) !== null ||
    toFiniteNumber(liveSummary?.latestAcceptedMetricStep) !== null;
  const ownershipProven = Boolean(
    crossSurfaceTruth?.ownershipProven === true ||
      hasLiveTelemetryStep ||
      toFiniteNumber(existing?.metricsIngestionSummary?.lastAcceptedStep) !== null ||
      toFiniteNumber(incoming.metricsIngestionSummary?.lastAcceptedStep) !== null
  );
  if (!ownershipProven) {
    return incoming.status;
  }

  const livePulseStep =
    toFiniteNumber(crossSurfaceTruth?.runnerLivePulseIteration) ??
    toFiniteNumber(liveSummary?.latestLivePulseStep) ??
    toFiniteNumber(liveSummary?.latestAcceptedMetricStep) ??
    0;
  if (livePulseStep > 0) {
    return "running";
  }

  const strongestActiveRank = Math.max(getStatusRank(existing?.status), getStatusRank(incoming.status));
  if (strongestActiveRank >= 2) {
    return "running";
  }
  if (strongestActiveRank === 1) {
    return "provisioning";
  }
  return "provisioning";
}

function mergeActiveJobTruth(
  existing: TrainingJobSummary | undefined,
  incoming: TrainingJobSummary,
  latestLivePulse?: TrainingJobSummary["liveTelemetrySummary"] | null
): TrainingJobSummary {
  if (!existing) return incoming;

  if (isTerminalJobStatus(incoming.status)) {
    return incoming;
  }
  if (isTerminalJobStatus(existing.status)) {
    return existing;
  }
  if (!ACTIVE_JOB_STATUSES.has(existing.status) || !ACTIVE_JOB_STATUSES.has(incoming.status)) {
    return incoming;
  }

  const freshestLiveSummary = latestLivePulse ?? existing.liveTelemetrySummary ?? incoming.liveTelemetrySummary ?? null;
  const freshestLiveAt = parseLiveTelemetryTimestamp(freshestLiveSummary);
  const incomingLiveAt = parseLiveTelemetryTimestamp(incoming.liveTelemetrySummary);
  if (incomingLiveAt > freshestLiveAt) {
    return incoming;
  }

  const currentEpoch = Math.max(Number(existing.currentEpoch ?? 0), Number(incoming.currentEpoch ?? 0));
  const currentEpisode = Math.max(Number(existing.currentEpisode ?? 0), Number(incoming.currentEpisode ?? 0));
  const progress = Math.max(Number(existing.progress ?? 0), Number(incoming.progress ?? 0));
  const existingLoss = Number(existing.loss);
  const incomingLoss = Number(incoming.loss);
  const loss =
    Number.isFinite(existingLoss) && existingLoss >= 0
      ? existing.loss
      : Number.isFinite(incomingLoss) && incomingLoss >= 0
        ? incoming.loss
        : incoming.loss;
  const visibleStatus = resolveVisibleActiveStatus(existing, incoming, freshestLiveSummary);

  return {
    ...incoming,
    status: visibleStatus,
    lifecycleStatus: visibleStatus,
    currentEpoch,
    currentEpisode,
    progress,
    loss,
    updatedAt: Math.max(Number(incoming.updatedAt ?? 0), Number(existing.updatedAt ?? 0), freshestLiveAt),
    liveTelemetrySummary: freshestLiveSummary ?? incoming.liveTelemetrySummary ?? existing.liveTelemetrySummary,
    recordingLiveSyncSummary: existing.recordingLiveSyncSummary ?? incoming.recordingLiveSyncSummary,
  };
}

function ensureLivePulseSubscriptions(jobs: TrainingJobSummary[]) {
  if (!trainingApiEnabled || typeof EventSource === "undefined") return;
  const activeJobIds = new Set(
    jobs
      .filter((job) => ["queued", "provisioning", "running"].includes(job.status))
      .filter((job) => !job.id.startsWith("local_job_"))
      .map((job) => job.id)
  );
  for (const jobId of Array.from(livePulseSources.keys())) {
    if (!activeJobIds.has(jobId)) closeLivePulseSource(jobId);
  }
  for (const jobId of activeJobIds) {
    if (livePulseSources.has(jobId)) continue;
    const source = new EventSource(buildTrainingLivePulseStreamUrl(jobId));
    source.addEventListener("live_pulse", (event) => {
      const reconnectTimer = livePulseReconnectTimers.get(jobId);
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
        livePulseReconnectTimers.delete(jobId);
      }
      livePulseReconnectAttempts.delete(jobId);
      try {
        const pulse = JSON.parse((event as MessageEvent<string>).data) as TrainingLivePulseSseEvent;
        useRuntimeTrainingStore.setState((current) => ({
          jobs: sortJobs(
            current.jobs.map((job) => (job.id === jobId ? applyLivePulseToJob(job, pulse) : job))
          ),
        }));
      } catch (error) {
        logWarn("Failed to parse live pulse event", {
          scope: "runtime-training",
          data: { jobId, error },
        });
      }
    });
    source.addEventListener("job", (event) => {
      try {
        const job = JSON.parse((event as MessageEvent<string>).data) as TrainingJobSummary;
        useRuntimeTrainingStore.setState((current) => {
          const existing = current.jobs.find((item) => item.id === job.id);
          const mergedJob = mergeActiveJobTruth(existing, job, existing?.liveTelemetrySummary ?? null);
          return {
            jobs: sortJobs([
              mergedJob,
              ...current.jobs.filter((item) => item.id !== job.id),
            ]),
            recordings: upsertRecordingFromCompletedJob(current.recordings, mergedJob),
          };
        });
      } catch (error) {
        logWarn("Failed to parse job stream event", {
          scope: "runtime-training",
          data: { jobId, error },
        });
      }
    });
    source.onopen = () => {
      const reconnectTimer = livePulseReconnectTimers.get(jobId);
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
        livePulseReconnectTimers.delete(jobId);
      }
      livePulseReconnectAttempts.delete(jobId);
      void catchUpMetricBatchesForJob(jobId);
    };
    source.onerror = () => {
      scheduleLivePulseReconnect(jobId);
    };
    livePulseSources.set(jobId, source);
  }
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

function requestRemoteJobsSyncOnce() {
  if (!trainingApiEnabled) return;
  void syncRemoteJobsOnce();
}

function startRemoteJobSyncSession() {
  if (!trainingApiEnabled) return () => {};

  hydrateJobsFromLocalCacheOnce();
  remoteSyncConsumerCount += 1;
  requestRemoteJobsSyncOnce();

  return () => {
    remoteSyncConsumerCount = Math.max(0, remoteSyncConsumerCount - 1);
    if (remoteSyncConsumerCount === 0) {
      closeAllLivePulseSources();
    }
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

    const episodeBudget = resolveEpisodeBudget(job);
    const nextIteration = Math.min(episodeBudget, Number(job.currentEpoch ?? 0) + 1);
    const nextProgress = nextIteration / Math.max(1, episodeBudget);
    const trend = 1.2 * (1 - nextProgress) + 0.05;
    const jitter = (Math.random() - 0.5) * 0.08;
    const nextLoss = Number(Math.max(0.02, trend + jitter).toFixed(4));
    const updatedAt = Date.now();
    const finished = nextIteration >= episodeBudget;
    const nextStatus: TrainingJobStatus = finished ? "completed" : "running";

    useRuntimeTrainingStore.setState((current) => {
      const updatedJobs = current.jobs.map((item) =>
        item.id === jobId
          ? {
              ...item,
              currentEpoch: nextIteration,
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
    maxSteps: input.maxSteps,
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
      const experimentName = (input.experimentName ?? modelName).trim() || modelName;
      const maxSteps = Math.max(1, Math.round(input.maxSteps ?? 100));
      const configObject = input.config ?? {};
      const configValues = toObjectOrEmpty(configObject);
      const launchContext = buildLaunchContextFromInput(input, configValues);
      const optimisticJob: TrainingJobSummary = {
        id: localId,
        modelName,
        dataset,
        maxSteps,
        episodeTarget: maxSteps,
        status: "submitting",
        progress: 0,
        currentEpoch: 0,
        currentEpisode: 0,
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
          useTrainingImportContextStore.getState().setCompiledTrainingEnvironment(customTaskRequest.environment);
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
          const optimisticJob = useRuntimeTrainingStore.getState().jobs.find((job) => job.id === localId) ?? null;
          const launchContextWithSource = {
            ...mergeLaunchContexts(remoteJob.launchContext, launchContext),
            sourceLocalJobId: localId,
            launchSubmissionStatus: "accepted",
            launchSubmissionResponseStatus: 202,
          };
          const optimisticCurrentEpoch = Number(optimisticJob?.currentEpoch ?? 0);
          const optimisticCurrentEpisode = Number(optimisticJob?.currentEpisode ?? 0);
          const optimisticProgress = Number(optimisticJob?.progress ?? 0);
          const optimisticLoss = optimisticJob?.loss ?? null;
          const enrichedRemoteJob: TrainingJobSummary = {
            ...remoteJob,
            episodeTarget: Math.max(
              Number(remoteJob.episodeTarget ?? 0),
              Number(remoteJob.maxSteps ?? 0),
              Number(optimisticJob?.episodeTarget ?? 0),
              Number(optimisticJob?.maxSteps ?? maxSteps)
            ),
            maxSteps: Math.max(
              Number(remoteJob.maxSteps ?? 0),
              Number(optimisticJob?.maxSteps ?? maxSteps)
            ),
            status: "queued",
            launchContext: launchContextWithSource,
            currentEpoch: Math.max(Number(remoteJob.currentEpoch ?? 0), optimisticCurrentEpoch),
            currentEpisode: Math.max(Number(remoteJob.currentEpisode ?? 0), optimisticCurrentEpisode),
            progress: Math.max(Number(remoteJob.progress ?? 0), optimisticProgress),
            loss:
              Number.isFinite(Number(remoteJob.loss))
                ? remoteJob.loss
                : Number.isFinite(Number(optimisticLoss))
                  ? Number(optimisticLoss)
                  : remoteJob.loss,
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
          ensureLivePulseSubscriptions(useRuntimeTrainingStore.getState().jobs);
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
    const maxSteps = Math.max(1, Math.round(input.maxSteps ?? 100));
    const launchContext = buildLaunchContextFromInput(input, toObjectOrEmpty(input.config ?? {}));

    const job: TrainingJobSummary = {
      id,
      modelName,
      dataset,
      maxSteps,
      episodeTarget: maxSteps,
      status: "queued",
      progress: 0,
      currentEpoch: 0,
      currentEpisode: 0,
      loss: null,
      startedAt: now,
      updatedAt: now,
      launchContext,
    };

    set((state) => ({ jobs: [job, ...state.jobs] }));
    logInfo("Training job queued", {
      scope: "runtime-training",
      data: { id, modelName, dataset, maxSteps },
    });

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
    closeLivePulseSource(jobId);
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
      const selectedJob = get().jobs.find((item) => item.id === jobId) ?? null;
      if (!selectedJob) return [];
      return buildLocalEvents(selectedJob).slice(0, boundedLimit);
    }

    if (trainingApiEnabled) {
      const selectedJob = get().jobs.find((item) => item.id === jobId) ?? null;
      const tenantId = resolveTrainingCacheTenantId(selectedJob?.tenantId);
      try {
        const [eventsHydrated, metricBatchesHydrated] = await Promise.all([
          hasHydratedTrainingEvents({ tenantId, jobId }),
          hasHydratedMetricBatches({ tenantId, jobId }),
        ]);
        if (!eventsHydrated || !metricBatchesHydrated) {
          const [remoteEvents, remoteBatches] = await Promise.all([
            eventsHydrated ? Promise.resolve([]) : listTrainingJobEventsRemote(jobId, boundedLimit),
            metricBatchesHydrated ? Promise.resolve([]) : listTrainingMetricBatchesRemote(jobId, boundedLimit),
          ]);
          if (remoteEvents.length > 0) {
            await cacheTrainingEvents({
              tenantId,
              jobId,
              items: remoteEvents,
            });
          }
          if (remoteBatches.length > 0) {
            await cacheMetricBatches({
              tenantId,
              jobId,
              items: remoteBatches,
            });
          }
          if (!eventsHydrated) {
            await markHydratedTrainingEvents({ tenantId, jobId });
          }
          if (!metricBatchesHydrated && shouldPersistMetricBatchHydration(selectedJob, remoteBatches)) {
            await markHydratedMetricBatches({ tenantId, jobId });
          }
        }
        const [mergedEvents, mergedBatches] = await Promise.all([
          listCachedTrainingEvents({
            tenantId,
            jobId,
            limit: boundedLimit,
          }),
          listCachedMetricBatches({
            tenantId,
            jobId,
            limit: boundedLimit,
          }),
        ]);
        const merged = [
          ...mergedEvents,
          ...buildMetricEventsFromBatches(jobId, mergedBatches),
        ]
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
          .slice(0, boundedLimit);
        return merged;
      } catch (error) {
        logWarn("Failed to list training job events from remote API", {
          scope: "runtime-training",
          data: { jobId, limit: boundedLimit, error },
        });
        return [];
      }
    }

    const selectedJob = get().jobs.find((item) => item.id === jobId) ?? null;
    if (!selectedJob) return [];
    return buildLocalEvents(selectedJob).slice(0, boundedLimit);
  },

  listTrainingMetricBatches: async (jobId, limit = 100): Promise<TrainingMetricBatchSummary[]> => {
    const boundedLimit = Math.min(Math.max(1, Math.round(limit)), MAX_EVENT_HISTORY_ITEMS);

    if (isOptimisticLocalJobId(jobId)) {
      return [];
    }

    if (trainingApiEnabled) {
      const selectedJob = get().jobs.find((item) => item.id === jobId) ?? null;
      const tenantId = resolveTrainingCacheTenantId(selectedJob?.tenantId);
      try {
        const hydrated = await hasHydratedMetricBatches({ tenantId, jobId });
        const cached = await listCachedMetricBatches({
          tenantId,
          jobId,
          limit: boundedLimit,
        });
        if (!hydrated || (cached.length === 0 && selectedJob && ACTIVE_JOB_STATUSES.has(selectedJob.status))) {
          const remoteBatches = await listTrainingMetricBatchesRemote(jobId, boundedLimit);
          if (remoteBatches.length > 0) {
            await cacheMetricBatches({
              tenantId,
              jobId,
              items: remoteBatches,
            });
          }
          if (shouldPersistMetricBatchHydration(selectedJob, remoteBatches)) {
            await markHydratedMetricBatches({ tenantId, jobId });
          }
        }
        return await listCachedMetricBatches({
          tenantId,
          jobId,
          limit: boundedLimit,
        });
      } catch (error) {
        logWarn("Failed to list training metric batches from remote API", {
          scope: "runtime-training",
          data: { jobId, limit: boundedLimit, error },
        });
        return [];
      }
    }

    return [];
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
