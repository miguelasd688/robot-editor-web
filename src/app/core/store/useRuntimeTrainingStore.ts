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
  parseTrainingRecordingSyncSseEvent,
  type TrainingRecordingSyncSseEvent,
  type TrainingMetricBatchSummary,
  listTrainingJobsRemote,
  trainingApiEnabled,
} from "../services/trainingApiClient";
import { logError, logInfo, logWarn } from "../services/logger";
import {
  cacheTrainingJobs,
  cacheTrainingEvents,
  cacheMetricBatches,
  cacheMetricHistoryRows,
  deleteTrainingTelemetryForJob,
  hasHydratedTrainingEvents,
  listCachedMetricHistoryRows,
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
import { mergeMetricRowsByIteration, deriveVisibleMetricHistory } from "./training/metricHistory";
import {
  applyVisibleProgressWatermark,
  createVisibleProgressWatermark,
  type VisibleProgressWatermark,
} from "./training/progressWatermark";
import {
  createLivePulseSessionState,
  shouldAcceptLivePulse,
  updateLivePulseSession,
  type LivePulseSessionState,
} from "./training/livePulseSession";

export { mergeMetricRowsByIteration, deriveVisibleMetricHistory } from "./training/metricHistory";

type MetricHistorySource =
  string;

type TrainingMetricHistoryRow = {
  trainerIteration: number;
  metricStep: number;
  occurredAt: string;
  progressRatio: number | null;
  source: MetricHistorySource;
  sourceMarker: string | null;
  episodeIndex: number | null;
  reward?: number | null;
  episodeLength?: number | null;
  rewardMean: number | null;
  episodeLengthMean: number | null;
  loss: number | null;
  fps: number | null;
};

type RuntimeTrainingState = {
  jobs: TrainingJobSummary[];
  recordings: TrainingRecordingSummary[];
  metricHistoryByJob: Record<string, TrainingMetricHistoryRow[]>;
  transportDiagnosticsByJob: Record<string, RuntimeTrainingTransportDiagnostics>;
  trainingTokens: number;
  trainingTokenCost: number;
  startRemoteJobSync: () => () => void;
  submitTrainingJob: (input: SubmitTrainingJobInput) => string;
  cancelTrainingJob: (jobId: string) => void;
  deleteTrainingJob: (jobId: string, tenantId?: string) => void;
  listTrainingArtifacts: (jobId: string, kind?: TrainingArtifactKind) => Promise<TrainingArtifactSummary[]>;
  listTrainingJobEvents: (
    jobId: string,
    options?: number | { limit?: number; source?: "inspector" | "history_open" | "terminal_replay" }
  ) => Promise<TrainingJobEventSummary[]>;
  listTrainingMetricBatches: (
    jobId: string,
    options?:
      | number
      | {
          limit?: number;
          reason?: MetricBatchFetchReason;
          sseDisconnectMs?: number;
        }
  ) => Promise<TrainingMetricBatchSummary[]>;
  listTrainingRunnerLogs: (jobId: string, tail?: number) => Promise<TrainingRunnerLogsSummary>;
};

type MetricBatchFetchReason = "terminal_replay" | "history_open" | "manual_recovery";

type RuntimeTrainingTransportDiagnostics = {
  lastSseOpenAt?: number;
  lastSseDisconnectAt?: number;
  lastMetricBatchFetchReason?: MetricBatchFetchReason | null;
  lastMetricBatchRemoteFetchAt?: number | null;
  lastEmptyListCooldownHitAt?: number | null;
  lastRecordingSyncAt?: string | null;
  recordingFinalized?: boolean;
  recordingMetaPollingSuppressed?: boolean;
  recordingMetaHydrationReason?: string | null;
  recordingMetaHydrationCount?: number;
  recordingSyncSource?: string | null;
  recordingMetaHydrationStatus?: string | null;
  recordingMetaHydrationError?: string | null;
  recordingMetaHydrationRetryable?: boolean | null;
  recordingMetaProxyAttemptCount?: number;
  recordingMetaProxySuppressedReason?: string | null;
};

const runningIntervals = new Map<string, number>();
const optimisticJobIds = new Set<string>();
let remoteSyncConsumerCount = 0;
let remoteSyncInFlight = false;
const livePulseSources = new Map<string, EventSource>();
const livePulseReconnectTimers = new Map<string, number>();
const livePulseReconnectAttempts = new Map<string, number>();
const pendingCancelRequests = new Set<string>();
let trainingJobCounter = 0;
const initialTrainingTokens = readPositiveIntEnv(import.meta.env.VITE_TRAINING_INITIAL_TOKENS, 20);
const trainingTokenCost = readPositiveIntEnv(import.meta.env.VITE_TRAINING_JOB_TOKEN_COST, 1);
const ACTIVE_JOB_STATUSES = new Set<TrainingJobStatus>([
  "submitting",
  "queued",
  "provisioning",
  "running",
  "cancelling",
  "health_blocked_shutdown" as TrainingJobStatus,
]);
const MAX_JOB_HISTORY_ITEMS = 20_000;
const MAX_EVENT_HISTORY_ITEMS = 20_000;
const METRIC_HISTORY_PERSIST_FLUSH_MS = 1000;
const METRIC_HISTORY_PERSIST_MAX_ROWS = 16;
const ACTIVE_RECENT_METRIC_ROW_WINDOW = 64;
let localJobsHydrationPromise: Promise<void> | null = null;
const DELETED_JOBS_STORAGE_KEY = "runtime-training-deleted-jobs-v1";
const deletedTrainingJobKeys = readDeletedTrainingJobKeys();
const metricHistoryPersistQueue = new Map<string, {
  tenantId: string;
  jobId: string;
  runRef: string | null;
  rows: TrainingMetricHistoryRow[];
}>();
const metricHistoryPersistFingerprints = new Map<string, Map<number, string>>();
let metricHistoryPersistFlushTimer: number | null = null;
const MANUAL_RECOVERY_SSE_DISCONNECT_MS = 30_000;
const visibleProgressWatermarksByJob = new Map<string, VisibleProgressWatermark>();
const livePulseSessionsByJob = new Map<string, LivePulseSessionState>();

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

function shouldRecoverAfterDisconnect(disconnectedMs: number | null | undefined) {
  return typeof disconnectedMs === "number" && disconnectedMs >= MANUAL_RECOVERY_SSE_DISCONNECT_MS;
}

function shouldFetchRemoteMetricBatches(job: TrainingJobSummary | null | undefined, reason: MetricBatchFetchReason) {
  if (!job) return false;
  if (job.id.startsWith("local_job_")) return false;
  if (reason === "manual_recovery") {
    const diagnostics = useRuntimeTrainingStore.getState().transportDiagnosticsByJob[job.id] ?? null;
    return shouldRecoverAfterDisconnect(diagnostics?.lastSseDisconnectAt ? Date.now() - diagnostics.lastSseDisconnectAt : null);
  }
  return true;
}

async function recoverMetricBatchesForJob(jobId: string, reason: MetricBatchFetchReason) {
  if (!trainingApiEnabled) return;
  const state = useRuntimeTrainingStore.getState();
  const selectedJob = state.jobs.find((item) => item.id === jobId);
  if (!shouldFetchRemoteMetricBatches(selectedJob, reason)) return;
  const tenantId = resolveTrainingCacheTenantId(selectedJob?.tenantId);
  const diagnosticsAtStart = state.transportDiagnosticsByJob[jobId] ?? {};
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
    useRuntimeTrainingStore.setState((current) => ({
      transportDiagnosticsByJob: {
        ...current.transportDiagnosticsByJob,
        [jobId]: {
          ...(current.transportDiagnosticsByJob[jobId] ?? {}),
          lastMetricBatchFetchReason: reason,
          lastMetricBatchRemoteFetchAt: Date.now(),
          lastEmptyListCooldownHitAt: remoteBatches.length === 0 ? Date.now() : diagnosticsAtStart.lastEmptyListCooldownHitAt ?? null,
        },
      },
    }));
  } catch (error) {
    logWarn("Failed to recover metric batches", {
      scope: "runtime-training",
      data: { jobId, error },
    });
  }
}

function closeAllLivePulseSources() {
  for (const jobId of livePulseSources.keys()) closeLivePulseSource(jobId);
}

export function __resetRuntimeTrainingTransportStateForTests() {
  closeAllLivePulseSources();
  if (typeof window !== "undefined") {
    for (const timer of livePulseReconnectTimers.values()) {
      window.clearTimeout(timer);
    }
  }
  livePulseReconnectTimers.clear();
  livePulseReconnectAttempts.clear();
  livePulseSessionsByJob.clear();
  pendingCancelRequests.clear();
  remoteSyncConsumerCount = 0;
  remoteSyncInFlight = false;
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

function isDurableMetricHistorySource(source: MetricHistorySource) {
  return source === "durable" || source === "durable_metric_rows";
}

function isOverlayMetricHistorySource(source: MetricHistorySource) {
  return source === "accepted_canonical_metrics" || source === "live_overlay" || source === "terminal_flush";
}

function isPersistedMetricHistorySource(source: MetricHistorySource) {
  return source === "browser_persisted_cache";
}

function isTerminalReplayMetricHistorySource(source: MetricHistorySource) {
  return source === "terminal_replay";
}

function getAcceptedCanonicalRowsCount(job: TrainingJobSummary | null | undefined) {
  const ingestionSummary = job?.metricsIngestionSummary ?? null;
  const recentMetricRows = Array.isArray(ingestionSummary?.recentMetricRows) ? ingestionSummary.recentMetricRows.length : 0;
  const latestMetricRows = Array.isArray(ingestionSummary?.latestMetricRows) ? ingestionSummary.latestMetricRows.length : 0;
  return Math.max(recentMetricRows, latestMetricRows);
}

function latestMetricHistoryRow(rows: TrainingMetricHistoryRow[]) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return deriveVisibleMetricHistory(rows)[rows.length - 1] ?? null;
}

function mergeCanonicalMetricRowsByTrainerIteration(
  current: TrainingMetricHistoryRow[],
  incoming: TrainingMetricHistoryRow[]
) {
  return mergeMetricRowsByIteration(current, incoming);
}

function selectBrowserVisibleIteration(job: TrainingJobSummary | null | undefined) {
  const truth = isObject(job?.metricsTruth) ? job.metricsTruth : null;
  return toFiniteNumber(truth?.browserVisibleIteration ?? truth?.apiVisibleIteration ?? truth?.runnerLivePulseIteration);
}

function repairProgressAxisRatio(current: number | null, total: number | null, ratio: number | null) {
  if (current !== null && total !== null && total > 0) {
    return Math.min(1, Math.max(0, current / total));
  }
  return ratio;
}

function selectBrowserVisibleIterationSource(job: TrainingJobSummary | null | undefined) {
  const truth = isObject(job?.metricsTruth) ? job.metricsTruth : null;
  const sourceFromTruth = typeof truth?.browserVisibleIterationSource === "string" && truth.browserVisibleIterationSource.trim()
    ? truth.browserVisibleIterationSource.trim()
    : typeof truth?.apiVisibleIterationSource === "string" && truth.apiVisibleIterationSource.trim()
      ? truth.apiVisibleIterationSource.trim()
      : null;
  if (sourceFromTruth) return sourceFromTruth;
  const liveTelemetrySummary = job?.liveTelemetrySummary ?? null;
  if (
    toFiniteNumber(liveTelemetrySummary?.trainerIteration) !== null ||
    toFiniteNumber(liveTelemetrySummary?.latestLivePulseIteration) !== null ||
    toFiniteNumber(liveTelemetrySummary?.latestLivePulseStep) !== null
  ) {
    return "runner_live_pulse";
  }
  return "none";
}

function resolveTerminalVisibleIteration(job: TrainingJobSummary | null | undefined) {
  const truth = isObject(job?.metricsTruth) ? job.metricsTruth : null;
  const lifecycleStatus = String(job?.lifecycleStatus ?? job?.status ?? "").trim();
  const terminalBudgetComplete = truth?.terminalBudgetComplete === true || lifecycleStatus === "completed";
  if (!terminalBudgetComplete) return null;
  const terminalVisibleIteration = toFiniteNumber(
    truth?.terminalVisibleTrainingIteration ??
      truth?.apiVisibleIteration ??
      job?.currentEpoch
  );
  return terminalVisibleIteration !== null && terminalVisibleIteration > 0 ? terminalVisibleIteration : null;
}

function selectDisplayProgressState(job: TrainingJobSummary | null | undefined) {
  const progressSummary = job?.progressSummary?.trainingProgress ?? null;
  const truth = isObject(job?.metricsTruth) ? job.metricsTruth : null;
  const liveTelemetrySummary = job?.liveTelemetrySummary ?? null;
  const totalIterations = toFiniteNumber(progressSummary?.total ?? job?.maxSteps);
  const summaryCurrent = toFiniteNumber(progressSummary?.current);
  const summaryRatio = repairProgressAxisRatio(summaryCurrent, totalIterations, toFiniteNumber(progressSummary?.ratio));
  const currentEpoch = toFiniteNumber(job?.currentEpoch);
  const terminalVisibleIteration = resolveTerminalVisibleIteration(job);
  const apiVisibleIteration = toFiniteNumber(truth?.apiVisibleIteration);
  const livePulseIteration = toFiniteNumber(
    truth?.runnerLivePulseIteration ??
      liveTelemetrySummary?.latestLivePulseIteration ??
      liveTelemetrySummary?.latestLivePulseStep
  );
  const visibleIteration =
    terminalVisibleIteration !== null
      ? terminalVisibleIteration
      : summaryCurrent !== null && summaryCurrent > 0
      ? summaryCurrent
      : currentEpoch !== null && currentEpoch > 0
        ? currentEpoch
        : apiVisibleIteration !== null
          ? apiVisibleIteration
          : livePulseIteration !== null
            ? livePulseIteration
            : summaryCurrent ?? currentEpoch ?? apiVisibleIteration ?? livePulseIteration ?? null;
  const visibleProgressRatio =
    totalIterations !== null && totalIterations > 0 && visibleIteration !== null
      ? Math.min(1, Math.max(0, visibleIteration / totalIterations))
      : summaryRatio ??
        toFiniteNumber(truth?.apiVisibleProgressRatio) ??
        toFiniteNumber(liveTelemetrySummary?.latestLivePulseProgressRatio) ??
        null;
  const visibleProgressSource =
    typeof liveTelemetrySummary?.metricsTruth === "object" &&
    liveTelemetrySummary?.metricsTruth !== null &&
    !Array.isArray(liveTelemetrySummary.metricsTruth) &&
    typeof (liveTelemetrySummary.metricsTruth as Record<string, unknown>).apiVisibleIterationSource === "string" &&
    String((liveTelemetrySummary.metricsTruth as Record<string, unknown>).apiVisibleIterationSource).trim()
      ? String((liveTelemetrySummary.metricsTruth as Record<string, unknown>).apiVisibleIterationSource).trim()
      : terminalVisibleIteration !== null
      ? typeof truth?.terminalProgressSource === "string" && truth.terminalProgressSource.trim()
        ? truth.terminalProgressSource.trim()
        : "terminal_completed"
      : summaryCurrent !== null && summaryCurrent > 0
      ? typeof progressSummary?.source === "string" && progressSummary.source.trim()
        ? progressSummary.source.trim()
        : "job.current_epoch/job.max_steps"
      : currentEpoch !== null && currentEpoch > 0
        ? "job.current_epoch/job.max_steps"
        : typeof truth?.apiVisibleIterationSource === "string" && truth.apiVisibleIterationSource.trim()
          ? truth.apiVisibleIterationSource.trim()
          : (() => {
              const liveTelemetryTruth = isObject(liveTelemetrySummary?.metricsTruth)
                ? (liveTelemetrySummary.metricsTruth as Record<string, unknown>)
                : null;
              return typeof liveTelemetryTruth?.apiVisibleIterationSource === "string" &&
                liveTelemetryTruth.apiVisibleIterationSource.trim()
                ? liveTelemetryTruth.apiVisibleIterationSource.trim()
                : selectBrowserVisibleIterationSource(job);
            })();
  return {
    current: visibleIteration,
    total: totalIterations,
    ratio: visibleProgressRatio,
    source: visibleProgressSource,
  };
}

function deriveJobMetricHistory(job: TrainingJobSummary | null | undefined, currentRows: TrainingMetricHistoryRow[]) {
  const acceptedRows = buildMetricHistoryRowsFromIngestionSummary(job);
  const liveTelemetryRow = buildMetricHistoryRowFromLiveTelemetrySummary(job);
  const mergedAcceptedRows = deriveVisibleMetricHistory(acceptedRows);
  const currentAndLiveRows = liveTelemetryRow ? mergeCanonicalMetricRowsByTrainerIteration(currentRows, [liveTelemetryRow]) : currentRows;
  const hasDurableRows = currentRows.length > 0;
  const hasAcceptedRows = acceptedRows.length > 0;
  if (!hasDurableRows && !hasAcceptedRows && !liveTelemetryRow) {
    return deriveVisibleMetricHistory(currentRows);
  }
  if (hasDurableRows) {
    return mergeCanonicalMetricRowsByTrainerIteration(currentAndLiveRows, mergedAcceptedRows);
  }
  if (job && ACTIVE_JOB_STATUSES.has(job.status) && (hasAcceptedRows || liveTelemetryRow)) {
    return mergeCanonicalMetricRowsByTrainerIteration(currentAndLiveRows, mergedAcceptedRows);
  }
  return deriveVisibleMetricHistory(currentAndLiveRows);
}

function mergeAndTrimRecentMetricRows(
  current: TrainingMetricHistoryRow[],
  incoming: TrainingMetricHistoryRow[],
  maxRows = ACTIVE_RECENT_METRIC_ROW_WINDOW
) {
  const merged = mergeCanonicalMetricRowsByTrainerIteration(current, incoming);
  if (merged.length <= maxRows) return merged;
  return merged.slice(merged.length - maxRows);
}

export function deriveVisibleIterationTruth(job: TrainingJobSummary | null | undefined, rows: TrainingMetricHistoryRow[]) {
  const visibleHistory = deriveVisibleMetricHistory(rows);
  const latest = latestMetricHistoryRow(visibleHistory);
  const durableRows = visibleHistory.filter((row) => isDurableMetricHistorySource(row.source));
  const acceptedRows = visibleHistory.filter((row) => row.source === "accepted_canonical_metrics");
  const liveOverlayRows = visibleHistory.filter((row) => row.source === "live_overlay");
  const latestDurable = latestMetricHistoryRow(durableRows);
  const latestAccepted = latestMetricHistoryRow(acceptedRows);
  const latestOverlay = latestMetricHistoryRow(liveOverlayRows);
  const canonicalProgress = job?.progressSummary?.trainingProgress ?? null;
  const totalIterations = toFiniteNumber(job?.maxSteps);
  const requestedIteration =
    latestDurable?.trainerIteration ??
    latestAccepted?.trainerIteration ??
    latest?.trainerIteration ??
    null;
  const jobId = job?.id ?? "";
  const watermark = visibleProgressWatermarksByJob.get(jobId) ?? createVisibleProgressWatermark();
  const watermarkResult = applyVisibleProgressWatermark(
    watermark,
    toFiniteNumber(requestedIteration),
    canonicalProgress?.ratio ?? latest?.progressRatio ?? null,
    Date.now()
  );
  if (jobId) {
    visibleProgressWatermarksByJob.set(jobId, watermarkResult.next);
  }
  const browserVisibleIteration =
    watermarkResult.next.visibleProgressWatermarkIteration ?? requestedIteration;
  const browserVisibleProgressRatio =
    totalIterations && browserVisibleIteration !== null && browserVisibleIteration !== undefined
      ? Math.min(1, Math.max(0, browserVisibleIteration / totalIterations))
      : latest?.progressRatio ?? null;
  return {
    browserVisibleIteration,
    browserVisibleProgressRatio,
    source: latestDurable?.source ?? latestAccepted?.source ?? canonicalProgress?.source ?? latest?.source ?? latestOverlay?.source ?? "progress_unavailable",
    latestMetricRow: latestDurable ?? latestAccepted ?? latest ?? latestOverlay,
    visibleProgressWatermarkIteration: watermarkResult.next.visibleProgressWatermarkIteration,
    visibleProgressWatermarkRatio: watermarkResult.next.visibleProgressWatermarkRatio,
    visibleProgressWatermarkAt: watermarkResult.next.visibleProgressWatermarkAt,
    staleProgressPulseDroppedCount: watermarkResult.next.staleProgressPulseDroppedCount,
    lastDroppedPulseIteration: watermarkResult.next.lastDroppedPulseIteration,
    lastDroppedPulseOccurredAt: watermarkResult.next.lastDroppedPulseOccurredAt,
    nonMonotonicProgressUpdateSuppressed: watermarkResult.next.nonMonotonicProgressUpdateSuppressed,
  };
}

export function getVisibleCanonicalIteration(job: TrainingJobSummary | null | undefined) {
  const truth = isObject(job?.metricsTruth) ? job.metricsTruth : null;
  const browserVisibleIteration = toFiniteNumber(truth?.browserVisibleIteration ?? truth?.apiVisibleIteration);
  if (browserVisibleIteration !== null) return browserVisibleIteration;
  const durableRows = Array.isArray(job?.metricsIngestionSummary?.latestMetricRows)
    ? job.metricsIngestionSummary.latestMetricRows
    : [];
  for (let index = durableRows.length - 1; index >= 0; index -= 1) {
    const value = toFiniteNumber(durableRows[index]?.trainerIteration);
    if (value !== null) return Math.max(0, Math.round(value));
  }
  const acceptedRows = Array.isArray(job?.metricsIngestionSummary?.recentMetricRows)
    ? job.metricsIngestionSummary.recentMetricRows
    : [];
  for (let index = acceptedRows.length - 1; index >= 0; index -= 1) {
    const value = toFiniteNumber(acceptedRows[index]?.trainerIteration);
    if (value !== null) return Math.max(0, Math.round(value));
  }
  const liveTelemetrySummary = job?.liveTelemetrySummary ?? null;
  const liveIteration =
    toFiniteNumber(liveTelemetrySummary?.trainerIteration) ??
    toFiniteNumber(liveTelemetrySummary?.latestLivePulseIteration) ??
    toFiniteNumber(liveTelemetrySummary?.latestLivePulseStep);
  return liveIteration === null ? null : Math.max(0, Math.round(liveIteration));
}

export function getVisibleIterationSource(job: TrainingJobSummary | null | undefined) {
  const truth = isObject(job?.metricsTruth) ? job.metricsTruth : null;
  const truthSource = typeof truth?.browserVisibleIterationSource === "string" && truth.browserVisibleIterationSource.trim()
    ? truth.browserVisibleIterationSource.trim()
    : typeof truth?.apiVisibleIterationSource === "string" && truth.apiVisibleIterationSource.trim()
      ? truth.apiVisibleIterationSource.trim()
      : null;
  if (truthSource) return truthSource;
  const durableRows = Array.isArray(job?.metricsIngestionSummary?.latestMetricRows)
    ? job.metricsIngestionSummary.latestMetricRows
    : [];
  if (durableRows.some((row) => toFiniteNumber(row?.trainerIteration) !== null)) return "durable_metrics_batch";
  const acceptedRows = Array.isArray(job?.metricsIngestionSummary?.recentMetricRows)
    ? job.metricsIngestionSummary.recentMetricRows
    : [];
  if (acceptedRows.some((row) => toFiniteNumber(row?.trainerIteration) !== null)) return "accepted_canonical_metrics";
  const liveTelemetrySummary = job?.liveTelemetrySummary ?? null;
  if (
    toFiniteNumber(liveTelemetrySummary?.trainerIteration) !== null ||
    toFiniteNumber(liveTelemetrySummary?.latestLivePulseIteration) !== null ||
    toFiniteNumber(liveTelemetrySummary?.latestLivePulseStep) !== null
  ) {
    return "runner_live_pulse";
  }
  return "none";
}

function stampBrowserMetricsTruth(job: TrainingJobSummary): TrainingJobSummary {
  const liveTelemetrySummary = isObject(job.liveTelemetrySummary) ? job.liveTelemetrySummary : null;
  const apiTruth = isObject(job.metricsTruth)
    ? (job.metricsTruth as Record<string, unknown>)
    : isObject(liveTelemetrySummary?.metricsTruth)
      ? (liveTelemetrySummary.metricsTruth as Record<string, unknown>)
      : {};
  const browserVisibleIteration = getVisibleCanonicalIteration(job);
  const browserVisibleAt = new Date().toISOString();
  const browserVisibleIterationSource = getVisibleIterationSource(job);
  const metricsTruth = {
    ...apiTruth,
    browserVisibleIteration,
    browserVisibleAt,
    browserVisibleIterationSource,
  };
  return {
    ...job,
    metricsTruth,
    liveTelemetrySummary: liveTelemetrySummary
      ? {
          ...liveTelemetrySummary,
          metricsTruth,
        }
      : job.liveTelemetrySummary,
  };
}

export function buildMetricHistoryRowsFromIngestionSummary(job: TrainingJobSummary | null | undefined) {
  const ingestionSummary = job?.metricsIngestionSummary ?? null;
  const recentMetricRows = Array.isArray(ingestionSummary?.recentMetricRows) ? ingestionSummary.recentMetricRows : [];
  const latestMetricRows = Array.isArray(ingestionSummary?.latestMetricRows) ? ingestionSummary.latestMetricRows : [];
  const latestMetrics = toObjectOrEmpty(ingestionSummary?.latestMetrics);
  const acceptedCanonicalRowsCount = Number(ingestionSummary?.acceptedCount ?? 0);
  const rows: TrainingMetricHistoryRow[] = [];
  const preferredMetricRows = recentMetricRows.length > 0 ? recentMetricRows : latestMetricRows;
  for (const row of preferredMetricRows) {
    const canonicalMetrics = row.canonicalMetrics ?? null;
    const metrics = row.metrics ?? null;
    const rawMetrics = row.rawMetrics ?? null;
    const normalized = buildCanonicalMetricHistoryRow({
      trainerIteration: row.trainerIteration ?? row.metricStep,
      metricStep: row.trainerIteration ?? row.metricStep,
      occurredAt: row.occurredAt ?? new Date().toISOString(),
      progressRatio: row.progressRatio ?? null,
      source: "accepted_canonical_metrics",
      sourceMarker: row.sourceMarker ?? row.source ?? null,
      episodeIndex: row.episodeIndex ?? null,
      reward:
        resolvePreferredMetricValue(
          [row as Record<string, unknown>, canonicalMetrics, metrics, rawMetrics],
          ["reward", "rewardMean", "mean_reward", "Train/mean_reward/time", "Train/mean_reward"]
        ),
      episodeLength:
        resolvePreferredMetricValue(
          [row as Record<string, unknown>, canonicalMetrics, metrics, rawMetrics],
          ["episodeLength", "episodeLengthMean", "Train/mean_episode_length/time", "Train/mean_episode_length"]
        ),
      loss:
        resolvePreferredMetricValue(
          [row as Record<string, unknown>, canonicalMetrics, metrics, rawMetrics],
          ["loss", "valueLoss", "surrogateLoss", "Loss/value_function", "Loss/surrogate"]
        ),
      fps:
        resolvePreferredMetricValue(
          [row as Record<string, unknown>, canonicalMetrics, metrics, rawMetrics],
          ["fps", "Perf/total_fps", "Perf/fps", "Train/fps"]
        ),
    });
    if (normalized) rows.push(normalized);
  }
  if (rows.length === 0 && acceptedCanonicalRowsCount > 0 && Object.keys(latestMetrics).length > 0) {
    const fallbackStep =
      toFiniteNumber(ingestionSummary?.lastAcceptedStep) ??
      toFiniteNumber(job?.currentEpoch) ??
      0;
    const fallbackRow = buildCanonicalMetricHistoryRow({
      trainerIteration: fallbackStep,
      metricStep: fallbackStep,
      occurredAt: String(ingestionSummary?.lastAcceptedTimestamp ?? job?.updatedAt ?? new Date().toISOString()),
      progressRatio: toFiniteNumber(ingestionSummary?.latestMetrics?.progress ?? ingestionSummary?.latestMetrics?.progressRatio),
      source: "accepted_canonical_metrics",
      sourceMarker: ingestionSummary?.lastAcceptedTimestamp ?? ingestionSummary?.reasonCode ?? null,
      episodeIndex: toFiniteNumber(ingestionSummary?.latestMetrics?.episodeIndex),
      reward:
        resolvePreferredMetricValue(
          [latestMetrics],
          ["reward", "rewardMean", "mean_reward", "Train/mean_reward/time", "Train/mean_reward"]
        ),
      episodeLength:
        resolvePreferredMetricValue(
          [latestMetrics],
          ["episodeLength", "episodeLengthMean", "Train/mean_episode_length/time", "Train/mean_episode_length"]
        ),
      loss:
        resolvePreferredMetricValue(
          [latestMetrics],
          ["loss", "valueLoss", "surrogateLoss", "Loss/value_function", "Loss/surrogate"]
        ),
      fps:
        resolvePreferredMetricValue(
          [latestMetrics],
          ["fps", "Perf/total_fps", "Perf/fps", "Train/fps"]
        ),
    });
    if (fallbackRow) rows.push(fallbackRow);
  }
  return recentMetricRows.length > 0 ? mergeAndTrimRecentMetricRows([], rows) : rows;
}

function buildMetricAvailabilityDiagnostics(rows: TrainingMetricHistoryRow[]) {
  let latestLossIteration: number | null = null;
  let latestFpsIteration: number | null = null;
  let latestRewardIteration: number | null = null;
  let latestEpisodeLengthIteration: number | null = null;

  for (const row of rows) {
    if (row.loss !== null) latestLossIteration = row.trainerIteration;
    if (row.fps !== null) latestFpsIteration = row.trainerIteration;
    if (row.rewardMean !== null || row.reward !== null && row.reward !== undefined) {
      latestRewardIteration = row.trainerIteration;
    }
    if (row.episodeLengthMean !== null || row.episodeLength !== null && row.episodeLength !== undefined) {
      latestEpisodeLengthIteration = row.trainerIteration;
    }
  }

  return {
    latestLossAvailable: latestLossIteration !== null,
    latestFpsAvailable: latestFpsIteration !== null,
    latestRewardAvailable: latestRewardIteration !== null,
    latestEpisodeLengthAvailable: latestEpisodeLengthIteration !== null,
    latestLossIteration,
    latestFpsIteration,
  };
}

function buildRecentMetricWindowDiagnostics(
  rows: TrainingMetricHistoryRow[],
  job: TrainingJobSummary | null | undefined
) {
  const ingestionSummary = job?.metricsIngestionSummary ?? null;
  const recentMetricRows = Array.isArray(ingestionSummary?.recentMetricRows) ? ingestionSummary.recentMetricRows : [];
  const latestMetricRows = Array.isArray(ingestionSummary?.latestMetricRows) ? ingestionSummary.latestMetricRows : [];
  let latestLossSource: string | null = null;
  let latestFpsSource: string | null = null;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (latestLossSource === null && row.loss !== null) latestLossSource = row.source ?? null;
    if (latestFpsSource === null && row.fps !== null) latestFpsSource = row.source ?? null;
    if (latestLossSource !== null && latestFpsSource !== null) break;
  }
  return {
    recentLiveRowsCount: rows.length,
    recentLiveRowsLatestIteration: rows.length > 0 ? rows[rows.length - 1]?.trainerIteration ?? null : null,
    latestMetricRowsCount: latestMetricRows.length,
    latestMetricsFallbackUsed: recentMetricRows.length === 0 && latestMetricRows.length === 0 && Boolean(ingestionSummary?.latestMetrics),
    lossSeriesSource: latestLossSource,
    fpsSeriesSource: latestFpsSource,
    recentLiveRowsWindowActive: recentMetricRows.length > 0 || latestMetricRows.length > 0,
  };
}

export function deriveUnifiedVisibleTrainingState(
  job: TrainingJobSummary | null | undefined,
  rows: TrainingMetricHistoryRow[]
) {
  const acceptedRows = buildMetricHistoryRowsFromIngestionSummary(job);
  const durableRows = deriveVisibleMetricHistory(rows);
  const mergedRows = deriveJobMetricHistory(job, durableRows);
  const visibleTruth = deriveVisibleIterationTruth(job, mergedRows);
  const chartRows = mergedRows;
  const latestDurableRow = latestMetricHistoryRow(durableRows);
  const latestAcceptedRow = latestMetricHistoryRow(acceptedRows);
  const latestMergedRow = latestMetricHistoryRow(mergedRows);
  const latestPersistedRow = latestMetricHistoryRow(mergedRows.filter((row) => isPersistedMetricHistorySource(row.source)));
  const latestDurableIteration = latestDurableRow?.trainerIteration ?? null;
  const latestAcceptedIteration = latestAcceptedRow?.trainerIteration ?? null;
  const latestMergedIteration = latestMergedRow?.trainerIteration ?? null;
  const latestPersistedIteration = latestPersistedRow?.trainerIteration ?? null;
  const acceptedCanonicalRowsCount = getAcceptedCanonicalRowsCount(job);
  const availabilityDiagnostics = buildMetricAvailabilityDiagnostics(mergedRows);
  const persistedMetricRowsCount = mergedRows.filter((row) => isPersistedMetricHistorySource(row.source)).length;
  const durableMetricRowsCount = mergedRows.filter((row) => isDurableMetricHistorySource(row.source)).length;
  const overlayMetricRowsCount = mergedRows.filter((row) => isOverlayMetricHistorySource(row.source)).length;
  const terminalReplayRowsCount = mergedRows.filter((row) => isTerminalReplayMetricHistorySource(row.source)).length;
  const progressSummary = job?.progressSummary ?? null;
  const truth = isObject(job?.metricsTruth) ? job.metricsTruth : null;
  const progressSource = progressSummary?.trainingProgress?.source ?? null;
  const displayProgress = selectDisplayProgressState(job);
  const totalIterations = displayProgress.total;
  const terminalVisibleIteration = resolveTerminalVisibleIteration(job);
  const terminalVisibleProgressSource =
    terminalVisibleIteration !== null
      ? typeof truth?.terminalProgressSource === "string" && truth.terminalProgressSource.trim()
        ? truth.terminalProgressSource.trim()
        : "terminal_completed"
      : null;
  const durableVisibleSource =
    latestDurableRow &&
    (latestDurableRow.source === "durable" || latestDurableRow.source === "durable_metric_rows" || latestDurableRow.source === "browser_persisted_cache" || latestDurableRow.source === "terminal_flush")
      ? latestDurableRow.source
      : null;
  const acceptedVisibleSource = latestAcceptedRow?.trainerIteration !== null && latestAcceptedRow?.trainerIteration !== undefined
    ? latestAcceptedRow.source
    : null;
  const canonicalBrowserIteration = selectBrowserVisibleIteration(job);
  const canonicalBrowserIterationSource = selectBrowserVisibleIterationSource(job);
  const displayProgressHasPositiveIteration = displayProgress.current !== null && displayProgress.current > 0;
  const visibleSource =
    terminalVisibleProgressSource ??
    durableVisibleSource ??
    acceptedVisibleSource ??
    visibleTruth.source ??
    (displayProgressHasPositiveIteration ? displayProgress.source : null) ??
    canonicalBrowserIterationSource ??
    latestMergedRow?.source ??
    (acceptedCanonicalRowsCount > 0 ? "accepted_canonical_metrics" : "progress_unavailable");
  const visibleProgressSource =
    terminalVisibleProgressSource ??
    durableVisibleSource ??
    acceptedVisibleSource ??
    visibleTruth.source ??
    (displayProgressHasPositiveIteration ? displayProgress.source : null) ??
    canonicalBrowserIterationSource ??
    latestMergedRow?.source ??
    (acceptedCanonicalRowsCount > 0 ? "accepted_canonical_metrics" : "progress_unavailable");
  const recentWindowDiagnostics = buildRecentMetricWindowDiagnostics(mergedRows, job);
  const fallbackVisibleIteration =
    canonicalBrowserIteration !== null && canonicalBrowserIteration > 0
      ? canonicalBrowserIteration
      : visibleTruth.browserVisibleIteration ?? 0;
  const visibleTruthHasPositiveIteration = visibleTruth.browserVisibleIteration !== null && visibleTruth.browserVisibleIteration > 0;
  const terminalVisibleProgressRatio =
    terminalVisibleIteration !== null && totalIterations !== null && totalIterations > 0
      ? Math.min(1, Math.max(0, terminalVisibleIteration / totalIterations))
      : null;
  return {
    chartRows,
    visibleIteration: terminalVisibleIteration !== null
      ? terminalVisibleIteration
      : visibleTruthHasPositiveIteration
      ? visibleTruth.browserVisibleIteration
      : displayProgressHasPositiveIteration
        ? displayProgress.current
        : fallbackVisibleIteration,
    visibleProgressRatio:
      terminalVisibleProgressRatio !== null
        ? terminalVisibleProgressRatio
        : visibleTruthHasPositiveIteration
        ? visibleTruth.browserVisibleProgressRatio
        : displayProgressHasPositiveIteration
          ? displayProgress.ratio
          : displayProgress.total !== null && displayProgress.total > 0
            ? Math.min(1, Math.max(0, fallbackVisibleIteration / displayProgress.total))
            : visibleTruth.browserVisibleProgressRatio,
    visibleProgressSource,
    latestDurableTrainerIteration: latestDurableIteration,
    latestAcceptedCanonicalIteration: latestAcceptedIteration,
    livePulseIteration: toFiniteNumber(job?.liveTelemetrySummary?.latestLivePulseIteration),
    persistedProgressIteration: visibleTruthHasPositiveIteration
      ? visibleTruth.browserVisibleIteration
      : displayProgressHasPositiveIteration
        ? displayProgress.current
        : fallbackVisibleIteration,
    visibleMetricSummarySource: visibleSource,
    visibleChartSource: visibleSource,
    mergedMetricHistoryLength: mergedRows.length,
    chartRowsLength: chartRows.length,
    latestPersistedTrainerIteration: latestPersistedIteration,
    latestMergedTrainerIteration: latestMergedIteration,
    ...availabilityDiagnostics,
    ...recentWindowDiagnostics,
    zeroFallbackSuppressed: true,
    persistedMetricRowsCount,
    durableMetricRowsCount,
    overlayMetricRowsCount,
    terminalReplayRowsCount,
    chartFallbackActive:
      latestDurableIteration === null &&
      (acceptedCanonicalRowsCount > 0 || recentWindowDiagnostics.latestMetricsFallbackUsed),
    nonCanonicalChartFallbackDetected:
      chartRows.some(
        (row) =>
          row.source !== "durable" &&
          row.source !== "durable_metric_rows" &&
          row.source !== "accepted_canonical_metrics" &&
          row.source !== "live_overlay" &&
          row.source !== "browser_persisted_cache" &&
          row.source !== "terminal_replay" &&
          row.source !== "terminal_flush"
      ) || false,
    nonCanonicalProgressFallbackDetected:
      Boolean(progressSource) &&
      progressSource !== "durable_metric_rows" &&
      progressSource !== "durable" &&
      progressSource !== "accepted_canonical_metrics" &&
      progressSource !== "browser_persisted_cache",
  };
}

function buildMetricHistoryRowsFromBatches(batches: TrainingMetricBatchSummary[]) {
  const rows: TrainingMetricHistoryRow[] = [];
  for (const batch of batches) {
    for (const sample of batch.samples ?? []) {
      const normalized = buildCanonicalMetricHistoryRow({
        trainerIteration: sample.trainerIteration ?? sample.metricStep,
        metricStep: sample.trainerIteration ?? sample.metricStep,
        occurredAt: sample.occurredAt,
        progressRatio: sample.progressRatio ?? null,
        source: "durable_metric_rows",
        sourceMarker: batch.batchId,
        episodeIndex: sample.episodeIndex ?? null,
      reward:
        resolvePreferredMetricValue(
          [sample.canonicalMetrics, sample.metrics, sample.rawMetrics],
          ["reward", "rewardMean", "mean_reward", "Train/mean_reward/time", "Train/mean_reward"]
        ),
      episodeLength:
        resolvePreferredMetricValue(
          [sample.canonicalMetrics, sample.metrics, sample.rawMetrics],
          ["episodeLength", "episodeLengthMean", "Train/mean_episode_length/time", "Train/mean_episode_length"]
        ),
      loss:
        resolvePreferredMetricValue(
          [sample.canonicalMetrics, sample.metrics, sample.rawMetrics],
          ["loss", "valueLoss", "surrogateLoss", "Loss/value_function", "Loss/surrogate"]
        ),
      fps:
        resolvePreferredMetricValue(
          [sample.canonicalMetrics, sample.metrics, sample.rawMetrics],
          ["fps", "Perf/total_fps", "Perf/fps", "Train/fps"]
        ),
      });
      if (normalized) rows.push(normalized);
    }
  }
  return rows;
}

function buildMetricHistoryRowFromLivePulse(pulse: TrainingLivePulseSseEvent): TrainingMetricHistoryRow | null {
  return buildCanonicalMetricHistoryRow({
    trainerIteration: pulse.trainerIteration ?? pulse.metricStep,
    metricStep: pulse.trainerIteration ?? pulse.metricStep,
    occurredAt: pulse.occurredAt ?? new Date().toISOString(),
    progressRatio: pulse.progressRatio ?? null,
    source: "live_overlay",
    sourceMarker: pulse.eventId ?? null,
    episodeIndex: pulse.episodeIndex ?? null,
    reward:
      resolvePreferredMetricValue(
        [pulse.latestMetricSurface, pulse.latestMetricSample],
        ["reward", "rewardMean", "mean_reward", "Train/mean_reward/time", "Train/mean_reward"]
      ),
    episodeLength:
      resolvePreferredMetricValue(
        [pulse.latestMetricSurface, pulse.latestMetricSample],
        ["episodeLength", "episodeLengthMean", "Train/mean_episode_length/time", "Train/mean_episode_length"]
      ),
    loss:
      resolvePreferredMetricValue(
        [pulse.latestMetricSurface, pulse.latestMetricSample],
        ["loss", "valueLoss", "surrogateLoss", "Loss/value_function", "Loss/surrogate"]
      ),
    fps:
      resolvePreferredMetricValue(
        [pulse.latestMetricSurface, pulse.latestMetricSample],
        ["fps", "Perf/total_fps", "Perf/fps", "Train/fps"]
      ),
  });
}

function buildMetricHistoryRowFromLiveTelemetrySummary(
  job:
    | Pick<
        TrainingJobSummary,
        "liveTelemetrySummary" | "currentEpoch" | "currentEpisode" | "updatedAt" | "metricsIngestionSummary"
      >
    | null
    | undefined
) {
  const liveTelemetrySummary = toObjectOrEmpty(job?.liveTelemetrySummary);
  if (Object.keys(liveTelemetrySummary).length === 0) return null;

  const latestMetricSurface = toObjectOrEmpty(liveTelemetrySummary.latestMetricSurface);
  const latestMetricSample = toObjectOrEmpty(liveTelemetrySummary.latestMetricSample);
  const metrics = toObjectOrEmpty(liveTelemetrySummary.metrics);
  const latestMetrics = toObjectOrEmpty(job?.metricsIngestionSummary?.latestMetrics);
  const latestMetricStep =
    toFiniteNumber(liveTelemetrySummary.latestLivePulseIteration) ??
    toFiniteNumber(liveTelemetrySummary.latestAcceptedMetricIteration) ??
    toFiniteNumber(liveTelemetrySummary.latestLivePulseStep) ??
    toFiniteNumber(liveTelemetrySummary.latestAcceptedMetricStep) ??
    toFiniteNumber(liveTelemetrySummary.trainerIteration) ??
    toFiniteNumber(job?.currentEpoch) ??
    0;
  const latestEpisodeIndex =
    toFiniteNumber(liveTelemetrySummary.latestLivePulseEpisodeIndex) ??
    toFiniteNumber(liveTelemetrySummary.latestAcceptedMetricEpisodeIndex) ??
    toFiniteNumber(liveTelemetrySummary.episodeIndex) ??
    toFiniteNumber(job?.currentEpisode);
  const occurredAt = String(liveTelemetrySummary.occurredAt ?? new Date(job?.updatedAt ?? Date.now()).toISOString());

  return buildCanonicalMetricHistoryRow({
    trainerIteration: Math.max(0, Math.round(latestMetricStep)),
    metricStep: Math.max(0, Math.round(latestMetricStep)),
    occurredAt,
    progressRatio: toFiniteNumber(liveTelemetrySummary.progressRatio ?? liveTelemetrySummary.progress),
    source: "live_overlay",
    sourceMarker: String(liveTelemetrySummary.eventId ?? "live_telemetry_summary").trim() || null,
    episodeIndex: latestEpisodeIndex === null ? null : Math.max(0, Math.round(latestEpisodeIndex)),
    reward:
      resolvePreferredMetricValue(
        [latestMetricSurface, latestMetricSample, metrics, latestMetrics],
        ["reward", "rewardMean", "mean_reward", "Train/mean_reward/time", "Train/mean_reward"]
      ),
    episodeLength:
      resolvePreferredMetricValue(
        [latestMetricSurface, latestMetricSample, metrics, latestMetrics],
        ["episodeLength", "episodeLengthMean", "Train/mean_episode_length/time", "Train/mean_episode_length"]
      ),
    loss:
      resolvePreferredMetricValue(
        [latestMetricSurface, latestMetricSample, metrics, latestMetrics],
        ["loss", "valueLoss", "surrogateLoss", "Loss/value_function", "Loss/surrogate"]
      ),
    fps:
      resolvePreferredMetricValue(
        [latestMetricSurface, latestMetricSample, metrics, latestMetrics],
        ["fps", "Perf/total_fps", "Perf/fps", "Train/fps"]
      ),
  });
}

function buildMetricHistoryPersistKey(tenantId: string, jobId: string, runRef: string | null) {
  return `${tenantId}::${jobId}::${runRef ?? "active"}`;
}

function buildMetricHistoryPersistenceFingerprint(row: TrainingMetricHistoryRow) {
  return JSON.stringify({
    trainerIteration: row.trainerIteration,
    metricStep: row.metricStep,
    occurredAt: row.occurredAt,
    progressRatio: row.progressRatio,
    source: row.source,
    sourceMarker: row.sourceMarker,
    episodeIndex: row.episodeIndex,
    reward: row.reward,
    episodeLength: row.episodeLength,
    rewardMean: row.rewardMean,
    episodeLengthMean: row.episodeLengthMean,
    loss: row.loss,
    fps: row.fps,
  });
}

function getMetricHistoryFingerprintsForRun(key: string) {
  let fingerprints = metricHistoryPersistFingerprints.get(key);
  if (!fingerprints) {
    fingerprints = new Map<number, string>();
    metricHistoryPersistFingerprints.set(key, fingerprints);
  }
  return fingerprints;
}

function queuePersistMetricHistoryRows(input: {
  tenantId: string;
  jobId: string;
  runRef?: string | null;
  rows: TrainingMetricHistoryRow[];
}) {
  if (!Array.isArray(input.rows) || input.rows.length === 0) return;
  const runRef = typeof input.runRef === "string" && input.runRef.trim() ? input.runRef.trim() : null;
  const key = buildMetricHistoryPersistKey(input.tenantId, input.jobId, runRef);
  const existing = metricHistoryPersistQueue.get(key);
  const nextRows = existing ? [...existing.rows] : [];
  const fingerprints = getMetricHistoryFingerprintsForRun(key);
  let changed = false;

  for (const row of input.rows) {
    const normalized = buildCanonicalMetricHistoryRow({
      ...row,
      source: "browser_persisted_cache",
    });
    if (!normalized) continue;
    const fingerprint = buildMetricHistoryPersistenceFingerprint(normalized);
    const previousFingerprint = fingerprints.get(normalized.trainerIteration);
    if (previousFingerprint === fingerprint) continue;
    fingerprints.set(normalized.trainerIteration, fingerprint);
    const existingIndex = nextRows.findIndex((item) => item.trainerIteration === normalized.trainerIteration);
    if (existingIndex >= 0) {
      nextRows[existingIndex] = normalized;
    } else {
      nextRows.push(normalized);
    }
    changed = true;
  }

  if (!changed) return;
  nextRows.sort((a, b) => a.trainerIteration - b.trainerIteration);
  metricHistoryPersistQueue.set(key, {
    tenantId: input.tenantId,
    jobId: input.jobId,
    runRef,
    rows: nextRows,
  });
  if (nextRows.length >= METRIC_HISTORY_PERSIST_MAX_ROWS) {
    void flushMetricHistoryPersistQueue();
    return;
  }
  scheduleMetricHistoryPersistFlush();
}

function scheduleMetricHistoryPersistFlush() {
  if (typeof window === "undefined") return;
  if (metricHistoryPersistFlushTimer !== null) return;
  metricHistoryPersistFlushTimer = window.setTimeout(() => {
    metricHistoryPersistFlushTimer = null;
    void flushMetricHistoryPersistQueue();
  }, METRIC_HISTORY_PERSIST_FLUSH_MS);
}

async function flushMetricHistoryPersistQueue() {
  if (typeof window === "undefined") return;
  if (metricHistoryPersistFlushTimer !== null) {
    window.clearTimeout(metricHistoryPersistFlushTimer);
    metricHistoryPersistFlushTimer = null;
  }
  if (metricHistoryPersistQueue.size === 0) return;
  const pending = Array.from(metricHistoryPersistQueue.entries());
  metricHistoryPersistQueue.clear();
  for (const [key, entry] of pending) {
    try {
      await cacheMetricHistoryRows({
        tenantId: entry.tenantId,
        jobId: entry.jobId,
        runRef: entry.runRef,
        items: entry.rows,
      });
    } catch (error) {
      metricHistoryPersistQueue.set(key, entry);
      throw error;
    }
  }
}

function primeMetricHistoryFingerprintsForRun(key: string, rows: TrainingMetricHistoryRow[]) {
  const fingerprints = getMetricHistoryFingerprintsForRun(key);
  for (const row of rows) {
    fingerprints.set(row.trainerIteration, buildMetricHistoryPersistenceFingerprint(row));
  }
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
        currentEpisode: Number(job.currentEpisode ?? 0),
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
      const nextMetricHistoryByJob = { ...current.metricHistoryByJob };
      for (const job of mergedById.values()) {
        nextMetricHistoryByJob[job.id] = deriveJobMetricHistory(job, nextMetricHistoryByJob[job.id] ?? []);
      }

      let nextRecordings = current.recordings;
      for (const job of mergedById.values()) {
        nextRecordings = upsertRecordingFromCompletedJob(nextRecordings, job);
      }

      return {
        jobs: mergedJobs,
        recordings: nextRecordings,
        metricHistoryByJob: nextMetricHistoryByJob,
      };
    });
    for (const job of useRuntimeTrainingStore.getState().jobs) {
      queuePersistMetricHistoryRows({
        tenantId: resolveTrainingCacheTenantId(job.tenantId),
        jobId: job.id,
        runRef: job.runRef ?? null,
        rows: useRuntimeTrainingStore.getState().metricHistoryByJob[job.id] ?? [],
      });
    }
    ensureLivePulseSubscriptions(useRuntimeTrainingStore.getState().jobs);
    void hydrateMetricHistoryFromLocalCache(useRuntimeTrainingStore.getState().jobs);
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
    const nextMetricHistoryByJob = { ...current.metricHistoryByJob };
    for (const job of cachedWithContext) {
      nextMetricHistoryByJob[job.id] = deriveJobMetricHistory(job, nextMetricHistoryByJob[job.id] ?? []);
    }

    let nextRecordings = current.recordings;
    for (const job of cachedWithContext) {
      nextRecordings = upsertRecordingFromCompletedJob(nextRecordings, job);
    }

    return {
      jobs: mergedJobs,
      recordings: nextRecordings,
      metricHistoryByJob: nextMetricHistoryByJob,
    };
  });
  for (const job of useRuntimeTrainingStore.getState().jobs) {
    queuePersistMetricHistoryRows({
      tenantId: resolveTrainingCacheTenantId(job.tenantId),
      jobId: job.id,
      runRef: job.runRef ?? null,
      rows: useRuntimeTrainingStore.getState().metricHistoryByJob[job.id] ?? [],
    });
  }
  ensureLivePulseSubscriptions(useRuntimeTrainingStore.getState().jobs);
  void hydrateMetricHistoryFromLocalCache(useRuntimeTrainingStore.getState().jobs);
}

async function hydrateMetricHistoryFromLocalCache(jobs: TrainingJobSummary[]) {
  if (typeof window === "undefined") return;
  const relevantJobs = jobs.filter((job) => !job.id.startsWith("local_job_"));
  if (relevantJobs.length === 0) return;

  const hydratedRows = await Promise.all(
    relevantJobs.map(async (job) => {
      const tenantId = resolveTrainingCacheTenantId(job.tenantId);
      const persistedRows = await listCachedMetricHistoryRows({
        tenantId,
        jobId: job.id,
        runRef: job.runRef ?? null,
        limit: MAX_JOB_HISTORY_ITEMS,
      });
      const normalizedRows = persistedRows
        .map((row) =>
          buildCanonicalMetricHistoryRow({
            ...row,
            source: "browser_persisted_cache",
          })
        )
        .filter((row): row is TrainingMetricHistoryRow => row !== null);
      return {
        jobId: job.id,
        tenantId,
        runRef: job.runRef ?? null,
        rows: normalizedRows,
      };
    })
  );

  useRuntimeTrainingStore.setState((current) => {
    const nextMetricHistoryByJob = { ...current.metricHistoryByJob };
    for (const item of hydratedRows) {
      if (item.rows.length === 0) continue;
      const merged = mergeCanonicalMetricRowsByTrainerIteration(item.rows, nextMetricHistoryByJob[item.jobId] ?? []);
      nextMetricHistoryByJob[item.jobId] = deriveJobMetricHistory(
        current.jobs.find((job) => job.id === item.jobId) ?? null,
        merged
      );
      primeMetricHistoryFingerprintsForRun(
        buildMetricHistoryPersistKey(item.tenantId, item.jobId, item.runRef),
        item.rows
      );
    }
    return {
      metricHistoryByJob: nextMetricHistoryByJob,
    };
  });
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
    ? Math.max(Number(job.progress ?? 0), Math.max(0, Math.min(1, Number(pulse.progressRatio))))
    : job.progress;
  const nextLossRaw = latestMetricSample?.loss;
  const nextLoss = nextLossRaw === null || nextLossRaw === undefined
    ? job.loss
    : Number.isFinite(Number(nextLossRaw))
      ? Number(nextLossRaw)
      : job.loss;
  const updatedAt = Date.parse(String(pulse.occurredAt ?? "")) || Date.now();
  const nextIteration = Math.max(
    Number(job.liveTelemetrySummary?.trainerIteration ?? 0),
    Number(pulse.trainerIteration ?? pulse.metricStep ?? 0)
  );
  const session = livePulseSessionsByJob.get(job.id) ?? createLivePulseSessionState();
  if (!shouldAcceptLivePulse(session, job.runRef ?? null, nextIteration)) {
    return job;
  }
  livePulseSessionsByJob.set(job.id, updateLivePulseSession(session, job.runRef ?? null, nextIteration));
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
      trainerIteration: nextIteration,
      latestLivePulseIteration: Math.max(
        Number(job.liveTelemetrySummary?.latestLivePulseIteration ?? 0),
        Number(pulse.trainerIteration ?? pulse.metricStep ?? 0)
      ),
      latestLivePulseStep: Math.max(
        Number(job.liveTelemetrySummary?.latestLivePulseStep ?? 0),
        Number(pulse.metricStep ?? pulse.trainerIteration ?? 0)
      ),
      latestLivePulseEpisodeIndex:
        explicitEpisodeIndex === null
          ? job.liveTelemetrySummary?.latestLivePulseEpisodeIndex ?? null
          : Math.max(Number(job.liveTelemetrySummary?.latestLivePulseEpisodeIndex ?? 0), explicitEpisodeIndex),
      latestAcceptedMetricIteration: Math.max(
        Number(job.liveTelemetrySummary?.latestAcceptedMetricIteration ?? 0),
        Number(pulse.trainerIteration ?? pulse.metricStep ?? 0)
      ),
      latestAcceptedMetricStep: Math.max(
        Number(job.liveTelemetrySummary?.latestAcceptedMetricStep ?? 0),
        Number(pulse.metricStep ?? pulse.trainerIteration ?? 0)
      ),
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
  };
}

function applyRecordingSyncToJob(
  job: TrainingJobSummary,
  event: TrainingRecordingSyncSseEvent
): TrainingJobSummary {
  const existingSummary = isObject(job.recordingLiveSyncSummary) ? job.recordingLiveSyncSummary : {};
  const nextSummary = {
    ...existingSummary,
    eventType: event.eventType,
    jobId: event.jobId,
    runRef: event.runRef,
    clipCount: event.clipCount,
    latestClipIndex: event.latestClipIndex,
    visibleClipIndex: event.visibleClipIndex,
    latestVideoStep: event.latestVideoStep ?? null,
    visibleVideoStep: event.visibleVideoStep ?? null,
    durableEpisodeIndex: event.durableEpisodeIndex ?? null,
    visibleEpisodeIndex: event.visibleEpisodeIndex ?? null,
    clipSourceField: event.clipSourceField,
    latestSourceEpisodeIndex: event.latestSourceEpisodeIndex ?? null,
    visibleSourceEpisodeIndex: event.visibleSourceEpisodeIndex ?? null,
    latestSourceVideoStep: event.latestSourceVideoStep ?? null,
    visibleSourceVideoStep: event.visibleSourceVideoStep ?? null,
    displayClipIndex: event.displayClipIndex ?? null,
    effectiveNumStepsPerEnv: event.effectiveNumStepsPerEnv ?? null,
    effectiveNumStepsPerEnvSource: event.effectiveNumStepsPerEnvSource ?? null,
    sourceTrainerIterationApprox: event.sourceTrainerIterationApprox ?? null,
    sourceTrainerIterationApproxZeroBased: event.sourceTrainerIterationApproxZeroBased ?? null,
    sourceTrainerIterationApproxDisplay: event.sourceTrainerIterationApproxDisplay ?? null,
    sourceTrainerIterationMethod: event.sourceTrainerIterationMethod ?? null,
    mediaLabelWarnings: event.mediaLabelWarnings ?? [],
    views: event.views,
    availableViews: event.availableViews,
    missingViews: event.missingViews,
    recordingVisible: event.recordingVisible,
    recordingFinalized: event.recordingFinalized,
    jobTerminal: event.jobTerminal,
    source: event.source,
    occurredAt: event.occurredAt,
    signature: event.signature,
  };
  return {
    ...job,
    recordingLiveSyncSummary: nextSummary,
    recordingSyncEventCount: Number(job.recordingSyncEventCount ?? 0) + 1,
    lastRecordingSyncAt: event.occurredAt,
    lastRecordingSyncSignature: event.signature,
    recordingFinalized: event.recordingFinalized || job.recordingFinalized === true,
    recordingSyncSource: "sse_recording_sync",
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

function resolvePreferredMetricValue(
  surfaces: Array<Record<string, unknown> | null | undefined>,
  keys: string[]
) {
  for (const surface of surfaces) {
    if (!surface) continue;
    for (const key of keys) {
      if (!(key in surface)) continue;
      const raw = surface[key];
      if (raw === null || raw === undefined) continue;
      const value = toFiniteNumber(raw);
      if (value !== null) return value;
    }
  }
  return null;
}

function normalizeCanonicalMetricSource(source: unknown): MetricHistorySource {
  if (
    source === "terminal_replay" ||
    source === "browser_persisted_cache" ||
    source === "terminal_flush" ||
    source === "live_overlay" ||
    source === "accepted_canonical_metrics" ||
    source === "durable_metric_rows" ||
    source === "durable"
  ) {
    return source;
  }
  return "durable";
}

function buildCanonicalMetricHistoryRow(input: {
  trainerIteration: unknown;
  metricStep?: unknown;
  occurredAt?: unknown;
  progressRatio?: unknown;
  source?: unknown;
  sourceMarker?: unknown;
  episodeIndex?: unknown;
  reward?: unknown;
  rewardMean?: unknown;
  episodeLength?: unknown;
  episodeLengthMean?: unknown;
  loss?: unknown;
  fps?: unknown;
}): TrainingMetricHistoryRow | null {
  const rawTrainerIteration = input.trainerIteration ?? input.metricStep;
  if (rawTrainerIteration === null || rawTrainerIteration === undefined) return null;
  const trainerIterationNumber = Number(rawTrainerIteration);
  if (!Number.isFinite(trainerIterationNumber)) return null;
  const trainerIteration = Math.max(0, Math.round(trainerIterationNumber));
  if (trainerIteration < 0) return null;
  const occurredAt = String(input.occurredAt ?? "").trim();
  if (!occurredAt) return null;
  const reward = toFiniteNumber(input.reward ?? input.rewardMean);
  const episodeLength = toFiniteNumber(input.episodeLength ?? input.episodeLengthMean);
  const loss = input.loss === null || input.loss === undefined ? null : toFiniteNumber(input.loss);
  const fps = input.fps === null || input.fps === undefined ? null : toFiniteNumber(input.fps);
  return {
    trainerIteration,
    metricStep:
      input.metricStep === null || input.metricStep === undefined
        ? trainerIteration
        : Number.isFinite(Number(input.metricStep))
          ? Math.max(0, Math.round(Number(input.metricStep)))
          : trainerIteration,
    occurredAt,
    progressRatio: toFiniteNumber(input.progressRatio),
    source: normalizeCanonicalMetricSource(input.source),
    sourceMarker: typeof input.sourceMarker === "string" && input.sourceMarker.trim() ? input.sourceMarker.trim() : null,
    episodeIndex:
      toFiniteNumber(input.episodeIndex) === null ? null : Math.max(0, Math.round(Number(input.episodeIndex))),
    reward,
    episodeLength,
    rewardMean: reward,
    episodeLengthMean: episodeLength,
    loss,
    fps,
  };
}

function getStatusRank(status: TrainingJobStatus | string | null | undefined) {
  if (status === "queued" || status === "submitting") return 0;
  if (status === "provisioning") return 1;
  if (status === "running" || status === "cancelling" || status === "health_blocked_shutdown") return 2;
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
  const runtimeHealthSummary = isObject(liveSummary?.runtimeHealthSummary)
    ? (liveSummary.runtimeHealthSummary as Record<string, unknown>)
    : null;
  const runtimeSmokeSummary = isObject(liveSummary?.runtimeSmokeSummary)
    ? (liveSummary.runtimeSmokeSummary as Record<string, unknown>)
    : runtimeHealthSummary;
  const stopTruth = isObject(crossSurfaceTruth?.stopHandshakeSummary)
    ? (crossSurfaceTruth.stopHandshakeSummary as Record<string, unknown>)
    : crossSurfaceTruth;
  const failFastRequested = liveSummary?.failFastRequested === true || stopTruth?.shutdownRequested === true;
  const processExitObservedAt = stopTruth?.processExitObservedAt;
  const smokeStage = typeof runtimeSmokeSummary?.runtimeSmokeStage === "string"
    ? runtimeSmokeSummary.runtimeSmokeStage
    : typeof runtimeSmokeSummary?.healthEvaluationStage === "string"
      ? runtimeSmokeSummary.healthEvaluationStage
      : "";
  if (
    smokeStage === "fatal" &&
    (crossSurfaceTruth?.processAlive === true || (failFastRequested === true && processExitObservedAt == null)) &&
    incoming.status !== "completed" &&
    incoming.status !== "cancelled"
  ) {
    return "health_blocked_shutdown" as TrainingJobStatus;
  }
  if (failFastRequested === true && processExitObservedAt == null && incoming.status !== "completed" && incoming.status !== "cancelled") {
    return "health_blocked_shutdown" as TrainingJobStatus;
  }
  if ((stopTruth?.cancelRequested === true || stopTruth?.shutdownRequested === true) && incoming.status !== "completed" && incoming.status !== "cancelled") {
    return "cancelling";
  }
  const hasLiveTelemetryStep =
    toFiniteNumber(crossSurfaceTruth?.runnerLivePulseIteration) !== null ||
    toFiniteNumber(liveSummary?.latestLivePulseStep) !== null ||
    toFiniteNumber(liveSummary?.latestAcceptedMetricStep) !== null;
  const ownershipProven = Boolean(
    crossSurfaceTruth?.ownershipProven === true || hasLiveTelemetryStep
  );
  if (!ownershipProven) {
    return incoming.status === "provisioning" ? "provisioning" : "queued";
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

function hasVisibleCancelIntent(
  jobId: string,
  liveTelemetrySummary: TrainingJobSummary["liveTelemetrySummary"] | null | undefined
) {
  const liveSummary = isObject(liveTelemetrySummary) ? liveTelemetrySummary : null;
  const crossSurfaceTruth = isObject(liveSummary?.crossSurfaceTruthSummary)
    ? (liveSummary?.crossSurfaceTruthSummary as Record<string, unknown>)
    : null;
  const stopTruth = isObject(crossSurfaceTruth?.stopHandshakeSummary)
    ? (crossSurfaceTruth.stopHandshakeSummary as Record<string, unknown>)
    : crossSurfaceTruth;
  return Boolean(
    pendingCancelRequests.has(jobId) ||
      stopTruth?.cancelRequested === true ||
      stopTruth?.shutdownRequested === true ||
      crossSurfaceTruth?.cancelRequested === true ||
      crossSurfaceTruth?.shutdownRequested === true ||
      liveSummary?.shutdownRequested === true ||
      liveSummary?.cancelRequested === true
  );
}

function mergeActiveJobTruth(
  existing: TrainingJobSummary | undefined,
  incoming: TrainingJobSummary,
  latestLivePulse?: TrainingJobSummary["liveTelemetrySummary"] | null
): TrainingJobSummary {
  if (!existing) return stampBrowserMetricsTruth(incoming);

  const freshestLiveSummary = latestLivePulse ?? existing.liveTelemetrySummary ?? incoming.liveTelemetrySummary ?? null;
  const cancelIntentVisible = hasVisibleCancelIntent(incoming.id, freshestLiveSummary) || hasVisibleCancelIntent(existing.id, freshestLiveSummary);
  if (isTerminalJobStatus(incoming.status) && !(incoming.status === "failed" && cancelIntentVisible)) {
    return stampBrowserMetricsTruth(incoming);
  }
  if (isTerminalJobStatus(existing.status) && !(existing.status === "failed" && cancelIntentVisible)) {
    return stampBrowserMetricsTruth(existing);
  }
  const incomingFailedButCancelable = incoming.status === "failed" && cancelIntentVisible;
  if (!ACTIVE_JOB_STATUSES.has(existing.status) || (!ACTIVE_JOB_STATUSES.has(incoming.status) && !incomingFailedButCancelable)) {
    return stampBrowserMetricsTruth(incoming);
  }

  const freshestLiveAt = Math.max(
    parseLiveTelemetryTimestamp(freshestLiveSummary),
    parseLiveTelemetryTimestamp(incoming.liveTelemetrySummary),
    parseLiveTelemetryTimestamp(existing.liveTelemetrySummary)
  );
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
  const visibleLifecycleStatus =
    hasVisibleCancelIntent(incoming.id, freshestLiveSummary) && visibleStatus !== "completed" && visibleStatus !== "failed" && visibleStatus !== "cancelled"
      ? "cancelling"
      : visibleStatus;

  return stampBrowserMetricsTruth({
    ...incoming,
    status: visibleLifecycleStatus,
    lifecycleStatus: visibleLifecycleStatus,
    currentEpoch,
    currentEpisode,
    progress,
    loss,
    updatedAt: Math.max(Number(incoming.updatedAt ?? 0), Number(existing.updatedAt ?? 0), freshestLiveAt),
    liveTelemetrySummary: freshestLiveSummary ?? incoming.liveTelemetrySummary ?? existing.liveTelemetrySummary,
    recordingLiveSyncSummary: existing.recordingLiveSyncSummary ?? incoming.recordingLiveSyncSummary,
    recordingSyncEventCount: incoming.recordingSyncEventCount ?? existing.recordingSyncEventCount,
    lastRecordingSyncAt: incoming.lastRecordingSyncAt ?? existing.lastRecordingSyncAt,
    lastRecordingSyncSignature: incoming.lastRecordingSyncSignature ?? existing.lastRecordingSyncSignature,
    recordingFinalized: incoming.recordingFinalized ?? existing.recordingFinalized,
    recordingSyncSource: incoming.recordingSyncSource ?? existing.recordingSyncSource,
    recordingMetaPollingSuppressed: incoming.recordingMetaPollingSuppressed ?? existing.recordingMetaPollingSuppressed,
    recordingMetaHydrationReason: incoming.recordingMetaHydrationReason ?? existing.recordingMetaHydrationReason,
    recordingMetaHydrationCount: incoming.recordingMetaHydrationCount ?? existing.recordingMetaHydrationCount,
  });
}

function ensureLivePulseSubscriptions(jobs: TrainingJobSummary[]) {
  if (!trainingApiEnabled || typeof EventSource === "undefined") return;
  const activeJobIds = new Set(
    jobs
      .filter((job) => ["queued", "provisioning", "running", "cancelling"].includes(job.status))
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
        const historyRow = buildMetricHistoryRowFromLivePulse(pulse);
        useRuntimeTrainingStore.setState((current) => ({
          jobs: sortJobs(current.jobs.map((job) => (job.id === jobId ? applyLivePulseToJob(job, pulse) : job))),
          metricHistoryByJob: historyRow
            ? {
                ...current.metricHistoryByJob,
                ...(current.jobs.some((job) => job.id === jobId)
                  ? (() => {
                      const updatedJob = current.jobs
                        .map((job) => (job.id === jobId ? applyLivePulseToJob(job, pulse) : job))
                        .find((job) => job.id === jobId) ?? null;
                      return {
                        [jobId]: deriveJobMetricHistory(
                          updatedJob,
                          mergeCanonicalMetricRowsByTrainerIteration(current.metricHistoryByJob[jobId] ?? [], [historyRow])
                        ),
                      };
                    })()
                  : {}),
            }
            : current.metricHistoryByJob,
        }));
        if (historyRow) {
          const nextJob = useRuntimeTrainingStore.getState().jobs.find((job) => job.id === jobId) ?? null;
          queuePersistMetricHistoryRows({
            tenantId: resolveTrainingCacheTenantId(nextJob?.tenantId),
            jobId,
            runRef: nextJob?.runRef ?? null,
            rows: useRuntimeTrainingStore.getState().metricHistoryByJob[jobId] ?? [historyRow],
          });
        }
      } catch (error) {
        logWarn("Failed to parse live pulse event", {
          scope: "runtime-training",
          data: { jobId, error },
        });
      }
    });
    source.addEventListener("recording_sync", (event) => {
      try {
        const sync = parseTrainingRecordingSyncSseEvent((event as MessageEvent<string>).data);
        if (!sync) return;
        useRuntimeTrainingStore.setState((current) => {
          const existing = current.jobs.find((job) => job.id === jobId);
          const mergedJob = existing ? applyRecordingSyncToJob(existing, sync) : existing;
          if (!mergedJob) return current;
          return {
            jobs: sortJobs(current.jobs.map((item) => (item.id === jobId ? mergedJob : item))),
            transportDiagnosticsByJob: {
              ...current.transportDiagnosticsByJob,
              [jobId]: {
                ...(current.transportDiagnosticsByJob[jobId] ?? {}),
                recordingMetaPollingSuppressed: true,
                lastRecordingSyncAt: sync.occurredAt,
                recordingFinalized: sync.recordingFinalized,
                recordingSyncSource: "sse_recording_sync",
              },
            },
          };
        });
      } catch (error) {
        logWarn("Failed to parse recording sync event", {
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
          const nextRows = deriveJobMetricHistory(mergedJob, current.metricHistoryByJob[job.id] ?? []);
          return {
            jobs: sortJobs([
              mergedJob,
              ...current.jobs.filter((item) => item.id !== job.id),
            ]),
            recordings: upsertRecordingFromCompletedJob(current.recordings, mergedJob),
            metricHistoryByJob: {
              ...current.metricHistoryByJob,
              [job.id]: nextRows,
            },
          };
        });
        const nextJob = useRuntimeTrainingStore.getState().jobs.find((item) => item.id === job.id) ?? null;
        queuePersistMetricHistoryRows({
          tenantId: resolveTrainingCacheTenantId(nextJob?.tenantId),
          jobId: job.id,
          runRef: nextJob?.runRef ?? null,
          rows: useRuntimeTrainingStore.getState().metricHistoryByJob[job.id] ?? [],
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
      useRuntimeTrainingStore.setState((current) => ({
          transportDiagnosticsByJob: {
          ...current.transportDiagnosticsByJob,
          [jobId]: {
            ...(current.transportDiagnosticsByJob[jobId] ?? {}),
            lastSseOpenAt: Date.now(),
            recordingMetaPollingSuppressed: true,
          },
        },
      }));
    };
    source.onerror = () => {
      const now = Date.now();
      const diagnostics = useRuntimeTrainingStore.getState().transportDiagnosticsByJob[jobId] ?? null;
      useRuntimeTrainingStore.setState((current) => ({
        transportDiagnosticsByJob: {
          ...current.transportDiagnosticsByJob,
        [jobId]: {
          ...(current.transportDiagnosticsByJob[jobId] ?? {}),
          lastSseDisconnectAt: now,
          recordingMetaPollingSuppressed: false,
        },
      },
    }));
      if (shouldRecoverAfterDisconnect(diagnostics?.lastSseOpenAt ? now - diagnostics.lastSseOpenAt : null)) {
        void recoverMetricBatchesForJob(jobId, "manual_recovery");
      }
      scheduleLivePulseReconnect(jobId);
    };
    livePulseSources.set(jobId, source);
  }
}

export function __ensureLivePulseSubscriptionsForTests(jobs: TrainingJobSummary[]) {
  ensureLivePulseSubscriptions(jobs);
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

export { resolveVisibleActiveStatus, mergeActiveJobTruth, hasVisibleCancelIntent };

export const useRuntimeTrainingStore: UseBoundStore<StoreApi<RuntimeTrainingState>> = create<RuntimeTrainingState>(
  (set, get) => ({
    jobs: [],
    recordings: [],
    metricHistoryByJob: {},
    transportDiagnosticsByJob: {},
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
    }, queueDelayMs);

    return id;
    },

  cancelTrainingJob: (jobId) => {
    if (trainingApiEnabled) {
      if (pendingCancelRequests.has(jobId)) {
        return;
      }
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

      pendingCancelRequests.add(jobId);
      set((state) => ({
        jobs: state.jobs.map((item) =>
          item.id === jobId
            ? {
                ...item,
                status:
                  item.status === "running" || item.status === "provisioning"
                    ? ("cancelling" as TrainingJobStatus)
                    : item.status,
                lifecycleStatus:
                  item.status === "running" || item.status === "provisioning"
                    ? ("cancelling" as TrainingJobStatus)
                    : item.lifecycleStatus,
                updatedAt: Date.now(),
              }
            : item
        ),
      }));

      void cancelTrainingJobRemote(jobId)
        .catch((error) => {
          logWarn("Failed to cancel remote training job", {
            scope: "runtime-training",
            data: { jobId, error },
          });
        })
        .finally(() => {
          pendingCancelRequests.delete(jobId);
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
    const persistKey = buildMetricHistoryPersistKey(targetTenantId, jobId, targetJob.runRef ?? null);
    metricHistoryPersistQueue.delete(persistKey);
    metricHistoryPersistFingerprints.delete(persistKey);
    visibleProgressWatermarksByJob.delete(jobId);
    livePulseSessionsByJob.delete(jobId);

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
      metricHistoryByJob: (() => {
        const next = { ...state.metricHistoryByJob };
        delete next[jobId];
        return next;
      })(),
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

  listTrainingJobEvents: async (jobId, options = 100): Promise<TrainingJobEventSummary[]> => {
    const limit = typeof options === "number" ? options : options.limit ?? 100;
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
        const eventsHydrated = await hasHydratedTrainingEvents({ tenantId, jobId });
        if (!eventsHydrated) {
          const remoteEvents = await listTrainingJobEventsRemote(jobId, boundedLimit);
          if (remoteEvents.length > 0) {
            await cacheTrainingEvents({
              tenantId,
              jobId,
              items: remoteEvents,
            });
          }
          await markHydratedTrainingEvents({ tenantId, jobId });
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

  listTrainingMetricBatches: async (jobId, options = 100): Promise<TrainingMetricBatchSummary[]> => {
    const normalizedOptions = typeof options === "number" ? { limit: options } : options;
    const boundedLimit = Math.min(Math.max(1, Math.round(normalizedOptions.limit ?? 100)), MAX_EVENT_HISTORY_ITEMS);
    const reason = normalizedOptions.reason ?? null;

    if (isOptimisticLocalJobId(jobId)) {
      return [];
    }

    if (trainingApiEnabled) {
      const selectedJob = get().jobs.find((item) => item.id === jobId) ?? null;
      const tenantId = resolveTrainingCacheTenantId(selectedJob?.tenantId);
      try {
        const cached = await listCachedMetricBatches({
          tenantId,
          jobId,
          limit: boundedLimit,
        });
        if (reason !== null) {
          if (reason === "manual_recovery" && !shouldRecoverAfterDisconnect(normalizedOptions.sseDisconnectMs)) {
            return cached;
          }
          if (!shouldFetchRemoteMetricBatches(selectedJob, reason)) {
            return cached;
          }
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
          set((state) => ({
            transportDiagnosticsByJob: {
              ...state.transportDiagnosticsByJob,
              [jobId]: {
                ...(state.transportDiagnosticsByJob[jobId] ?? {}),
                lastMetricBatchFetchReason: reason,
                lastMetricBatchRemoteFetchAt: Date.now(),
              },
            },
          }));
        } else {
          return cached;
        }
        const metricBatches = await listCachedMetricBatches({
          tenantId,
          jobId,
          limit: boundedLimit,
        });
        const selectedJobForVisibleHistory = get().jobs.find((item) => item.id === jobId) ?? null;
        const visibleHistory = deriveJobMetricHistory(selectedJobForVisibleHistory, mergeCanonicalMetricRowsByTrainerIteration(
          get().metricHistoryByJob[jobId] ?? [],
          buildMetricHistoryRowsFromBatches(metricBatches)
        ));
        set((state) => ({
          metricHistoryByJob: {
            ...state.metricHistoryByJob,
            [jobId]: visibleHistory,
          },
        }));
        queuePersistMetricHistoryRows({
          tenantId,
          jobId,
          runRef: selectedJobForVisibleHistory?.runRef ?? null,
          rows: visibleHistory,
        });
        return metricBatches;
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
