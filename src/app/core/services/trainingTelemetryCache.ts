import type {
  TrainingJobEventSummary,
  TrainingJobSummary,
  TrainingMetricHistoryRow,
} from "../plugins/types";
import type { TrainingMetricBatchSummary } from "./trainingApiClient";

const DB_NAME = "runtime-training-telemetry-cache";
const DB_VERSION = 6;
const JOBS_STORE = "trainingJobs";
const EVENTS_STORE = "jobEvents";
const METRIC_BATCHES_STORE = "metricBatches";
const METRIC_HISTORY_ROWS_STORE = "metricHistoryRows";
const META_STORE = "cacheMeta";

const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CACHE_BYTES = 256 * 1024 * 1024;
const MIN_PRUNE_INTERVAL_MS = 20_000;
const DEFAULT_TENANT_ID = "local";
const META_KEY_EVENT_COUNT = "eventCount";
const META_KEY_JOB_COUNT = "jobCount";
const META_KEY_METRIC_BATCH_COUNT = "metricBatchCount";
const META_KEY_METRIC_HISTORY_ROW_COUNT = "metricHistoryRowCount";
const META_KEY_TOTAL_BYTES = "totalBytes";
const META_KEY_LAST_PRUNED_AT = "lastPrunedAtMs";
const META_KEY_LAST_WRITE_AT = "lastWriteAtMs";
const META_KEY_EVENTS_HYDRATED_PREFIX = "eventsHydrated:";
const META_KEY_METRIC_BATCHES_HYDRATED_PREFIX = "metricBatchesHydrated:";

type CachedTrainingJobRow = {
  cacheKey: string;
  tenantId: string;
  jobId: string;
  updatedAtMs: number;
  sizeBytes: number;
  updatedAtCacheMs: number;
  job: TrainingJobSummary;
};

type CachedJobEventRow = {
  cacheKey: string;
  jobKey: string;
  tenantId: string;
  jobId: string;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
  createdAtMs: number;
  sizeBytes: number;
  updatedAtMs: number;
};

type CachedMetricBatchRow = {
  cacheKey: string;
  jobKey: string;
  tenantId: string;
  jobId: string;
  batchId: string;
  fromStep: number;
  toStep: number;
  sampleCount: number;
  samples: TrainingMetricBatchSummary["samples"];
  createdAt: string;
  createdAtMs: number;
  sizeBytes: number;
  updatedAtMs: number;
};

type CachedMetricHistoryRow = {
  cacheKey: string;
  jobKey: string;
  runKey: string;
  tenantId: string;
  jobId: string;
  runRef: string | null;
  trainerIteration: number;
  occurredAt: string;
  row: TrainingMetricHistoryRow;
  sizeBytes: number;
  updatedAtMs: number;
};

type CachedCacheMetaRow = {
  key: string;
  value: number;
  updatedAtMs: number;
};

let dbPromise: Promise<IDBDatabase | null> | null = null;
let nextPruneAllowedAtMs = 0;
let pruneInFlight: Promise<void> | null = null;

export function resolveTrainingCacheTenantId(tenantId: unknown): string {
  const token = String(tenantId ?? "").trim();
  return token.length > 0 ? token : DEFAULT_TENANT_ID;
}

export async function listCachedTrainingEvents(input: {
  tenantId: string;
  jobId: string;
  limit: number;
}): Promise<TrainingJobEventSummary[]> {
  const db = await openCacheDb();
  if (!db) return [];
  const boundedLimit = Math.min(Math.max(1, Math.round(input.limit)), 20_000);
  const jobKey = buildJobKey(input.tenantId, input.jobId);
  const tx = db.transaction(EVENTS_STORE, "readonly");
  const store = tx.objectStore(EVENTS_STORE);
  const index = store.index("byJobCreatedAt");
  const range = IDBKeyRange.bound([jobKey, 0], [jobKey, Number.MAX_SAFE_INTEGER]);
  const rows = (await requestToPromise(index.getAll(range))) as CachedJobEventRow[];
  rows.sort((a, b) => b.createdAtMs - a.createdAtMs);
  return rows.slice(0, boundedLimit).map((row) => ({
    id: row.eventId,
    jobId: row.jobId,
    eventType: row.eventType,
    payload: isRecord(row.payload) ? row.payload : {},
    createdAt: row.createdAt,
  }));
}

export async function listCachedMetricBatches(input: {
  tenantId: string;
  jobId: string;
  limit: number;
}): Promise<TrainingMetricBatchSummary[]> {
  const db = await openCacheDb();
  if (!db) return [];
  const boundedLimit = Math.min(Math.max(1, Math.round(input.limit)), 20_000);
  const jobKey = buildJobKey(input.tenantId, input.jobId);
  const tx = db.transaction(METRIC_BATCHES_STORE, "readonly");
  const store = tx.objectStore(METRIC_BATCHES_STORE);
  const index = store.index("byJobStep");
  const range = IDBKeyRange.bound([jobKey, 0, 0], [jobKey, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]);
  const rows = (await requestToPromise(index.getAll(range))) as CachedMetricBatchRow[];
  rows.sort((a, b) => {
    if (b.toStep !== a.toStep) return b.toStep - a.toStep;
    return b.createdAtMs - a.createdAtMs;
  });
  return rows.slice(0, boundedLimit).map((row) => ({
    batchId: row.batchId,
    jobId: row.jobId,
    fromStep: row.fromStep,
    toStep: row.toStep,
    sampleCount: row.sampleCount,
    samples: Array.isArray(row.samples) ? row.samples : [],
    createdAt: row.createdAt,
  }));
}

export async function listCachedMetricHistoryRows(input: {
  tenantId: string;
  jobId: string;
  runRef?: string | null;
  limit: number;
}): Promise<TrainingMetricHistoryRow[]> {
  const db = await openCacheDb();
  if (!db) return [];
  const boundedLimit = Math.min(Math.max(1, Math.round(input.limit)), 20_000);
  const tenantId = resolveTrainingCacheTenantId(input.tenantId);
  const jobId = String(input.jobId ?? "").trim();
  if (!jobId) return [];
  const runKey = buildMetricHistoryRunKey(jobId, input.runRef);
  const jobKey = buildJobKey(tenantId, jobId);
  const tx = db.transaction(METRIC_HISTORY_ROWS_STORE, "readonly");
  const store = tx.objectStore(METRIC_HISTORY_ROWS_STORE);
  const index = store.index("byJobRunIteration");
  const range = IDBKeyRange.bound([jobKey, runKey, 0], [jobKey, runKey, Number.MAX_SAFE_INTEGER]);
  const rows = (await requestToPromise(index.getAll(range))) as CachedMetricHistoryRow[];
  rows.sort((a, b) => {
    if (a.trainerIteration !== b.trainerIteration) return a.trainerIteration - b.trainerIteration;
    return a.updatedAtMs - b.updatedAtMs;
  });
  return rows.slice(-boundedLimit).map((row) => ({ ...row.row }));
}

export async function listCachedTrainingJobs(limit = 2000): Promise<TrainingJobSummary[]> {
  const db = await openCacheDb();
  if (!db) return [];
  const boundedLimit = Math.min(Math.max(1, Math.round(limit)), 20_000);
  const tx = db.transaction(JOBS_STORE, "readonly");
  const store = tx.objectStore(JOBS_STORE);
  const rows = (await requestToPromise(store.getAll())) as CachedTrainingJobRow[];
  rows.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  return rows.slice(0, boundedLimit).map((row) => ({ ...row.job }));
}

export async function cacheTrainingJobs(input: { items: TrainingJobSummary[] }): Promise<void> {
  if (!Array.isArray(input.items) || input.items.length === 0) return;
  await withCacheWrite(async (db) => {
    const tx = db.transaction(JOBS_STORE, "readwrite");
    const store = tx.objectStore(JOBS_STORE);
    const now = Date.now();
    for (const job of input.items) {
      if (!job || typeof job !== "object") continue;
      const jobId = String(job.id ?? "").trim();
      if (!jobId) continue;
      const tenantId = resolveTrainingCacheTenantId(job.tenantId);
      const updatedAtMs = Number.isFinite(Number(job.updatedAt)) ? Math.max(0, Math.round(Number(job.updatedAt))) : now;
      const normalized: TrainingJobSummary = { ...job, id: jobId, tenantId, updatedAt: updatedAtMs };
      store.put({
        cacheKey: buildJobCacheKey(tenantId, jobId),
        tenantId,
        jobId,
        updatedAtMs,
        sizeBytes: estimateSizeBytes(normalized),
        updatedAtCacheMs: now,
        job: normalized,
      } satisfies CachedTrainingJobRow);
    }
    await transactionDone(tx);
  });
  await pruneTrainingTelemetryCacheIfNeeded();
}

export async function hasHydratedTrainingEvents(input: { tenantId: string; jobId: string }): Promise<boolean> {
  return await hasHydratedMetaKey(buildEventsHydratedMetaKey(input.tenantId, input.jobId));
}

export async function markHydratedTrainingEvents(input: { tenantId: string; jobId: string }): Promise<void> {
  const db = await openCacheDb();
  if (!db) return;
  await writeMetaRows(db, [{ key: buildEventsHydratedMetaKey(input.tenantId, input.jobId), value: 1 }]);
}

export async function hasHydratedMetricBatches(input: { tenantId: string; jobId: string }): Promise<boolean> {
  return await hasHydratedMetaKey(buildMetricBatchesHydratedMetaKey(input.tenantId, input.jobId));
}

export async function markHydratedMetricBatches(input: { tenantId: string; jobId: string }): Promise<void> {
  const db = await openCacheDb();
  if (!db) return;
  await writeMetaRows(db, [{ key: buildMetricBatchesHydratedMetaKey(input.tenantId, input.jobId), value: 1 }]);
}

export async function cacheTrainingEvents(input: {
  tenantId: string;
  jobId: string;
  items: TrainingJobEventSummary[];
}): Promise<void> {
  if (!Array.isArray(input.items) || input.items.length === 0) return;
  await withCacheWrite(async (db) => {
    const tx = db.transaction(EVENTS_STORE, "readwrite");
    const store = tx.objectStore(EVENTS_STORE);
    const now = Date.now();
    const jobKey = buildJobKey(input.tenantId, input.jobId);
    for (const item of input.items) {
      if (!item || typeof item !== "object") continue;
      const eventId = String(item.id ?? "").trim();
      const eventType = String(item.eventType ?? "").trim();
      if (!eventId || !eventType) continue;
      const createdAtMs = parseCreatedAtMs(item.createdAt, now);
      const payload = isRecord(item.payload) ? item.payload : {};
      store.put({
        cacheKey: buildEventCacheKey(input.tenantId, input.jobId, eventId),
        jobKey,
        tenantId: input.tenantId,
        jobId: input.jobId,
        eventId,
        eventType,
        payload,
        createdAt: new Date(createdAtMs).toISOString(),
        createdAtMs,
        sizeBytes: estimateSizeBytes({ eventType, payload }),
        updatedAtMs: now,
      } satisfies CachedJobEventRow);
    }
    await transactionDone(tx);
  });
  await pruneTrainingTelemetryCacheIfNeeded();
}

export async function cacheMetricBatches(input: {
  tenantId: string;
  jobId: string;
  items: TrainingMetricBatchSummary[];
}): Promise<void> {
  if (!Array.isArray(input.items) || input.items.length === 0) return;
  await withCacheWrite(async (db) => {
    const tx = db.transaction(METRIC_BATCHES_STORE, "readwrite");
    const store = tx.objectStore(METRIC_BATCHES_STORE);
    const now = Date.now();
    const jobKey = buildJobKey(input.tenantId, input.jobId);
    for (const item of input.items) {
      if (!item || typeof item !== "object") continue;
      const batchId = String(item.batchId ?? "").trim();
      if (!batchId) continue;
      const fromStep = Math.max(0, Math.round(Number(item.fromStep) || 0));
      const toStep = Math.max(0, Math.round(Number(item.toStep) || 0));
      const samples = Array.isArray(item.samples) ? item.samples : [];
      store.put({
        cacheKey: buildMetricBatchCacheKey(input.tenantId, input.jobId, batchId),
        jobKey,
        tenantId: input.tenantId,
        jobId: input.jobId,
        batchId,
        fromStep,
        toStep,
        sampleCount: Math.max(0, Math.round(Number(item.sampleCount) || samples.length)),
        samples,
        createdAt: new Date(parseCreatedAtMs(item.createdAt, now)).toISOString(),
        createdAtMs: parseCreatedAtMs(item.createdAt, now),
        sizeBytes: estimateSizeBytes({ fromStep, toStep, sampleCount: item.sampleCount, samples }),
        updatedAtMs: now,
      } satisfies CachedMetricBatchRow);
    }
    await transactionDone(tx);
  });
  await pruneTrainingTelemetryCacheIfNeeded();
}

export async function cacheMetricHistoryRows(input: {
  tenantId: string;
  jobId: string;
  runRef?: string | null;
  items: TrainingMetricHistoryRow[];
}): Promise<void> {
  if (!Array.isArray(input.items) || input.items.length === 0) return;
  const tenantId = resolveTrainingCacheTenantId(input.tenantId);
  const jobId = String(input.jobId ?? "").trim();
  if (!jobId) return;
  const runKey = buildMetricHistoryRunKey(jobId, input.runRef);
  await withCacheWrite(async (db) => {
    const tx = db.transaction(METRIC_HISTORY_ROWS_STORE, "readwrite");
    const store = tx.objectStore(METRIC_HISTORY_ROWS_STORE);
    const now = Date.now();
    for (const item of input.items) {
      if (!item || typeof item !== "object") continue;
      const trainerIteration = Math.max(0, Math.round(Number(item.trainerIteration) || 0));
      if (!trainerIteration) continue;
      const occurredAt = String(item.occurredAt ?? "").trim();
      if (!occurredAt) continue;
      const normalized: TrainingMetricHistoryRow = {
        ...item,
        trainerIteration,
        metricStep: Math.max(0, Math.round(Number(item.metricStep ?? trainerIteration) || trainerIteration)),
        occurredAt,
      };
      store.put({
        cacheKey: buildMetricHistoryCacheKey(tenantId, jobId, runKey, trainerIteration),
        jobKey: buildJobKey(tenantId, jobId),
        runKey,
        tenantId,
        jobId,
        runRef: typeof input.runRef === "string" && input.runRef.trim() ? input.runRef.trim() : null,
        trainerIteration,
        occurredAt,
        row: normalized,
        sizeBytes: estimateSizeBytes(normalized),
        updatedAtMs: now,
      } satisfies CachedMetricHistoryRow);
    }
    await transactionDone(tx);
  });
  await pruneTrainingTelemetryCacheIfNeeded();
}

export async function clearTrainingTelemetryCache(): Promise<void> {
  nextPruneAllowedAtMs = Date.now() + MIN_PRUNE_INTERVAL_MS;
  const db = await openCacheDb();
  if (!db) return;
  const tx = db.transaction([JOBS_STORE, EVENTS_STORE, METRIC_BATCHES_STORE, METRIC_HISTORY_ROWS_STORE, META_STORE], "readwrite");
  tx.objectStore(JOBS_STORE).clear();
  tx.objectStore(EVENTS_STORE).clear();
  tx.objectStore(METRIC_BATCHES_STORE).clear();
  tx.objectStore(METRIC_HISTORY_ROWS_STORE).clear();
  tx.objectStore(META_STORE).clear();
  await transactionDone(tx);
  await writeMetaRows(db, [
    { key: META_KEY_JOB_COUNT, value: 0 },
    { key: META_KEY_EVENT_COUNT, value: 0 },
    { key: META_KEY_METRIC_BATCH_COUNT, value: 0 },
    { key: META_KEY_METRIC_HISTORY_ROW_COUNT, value: 0 },
    { key: META_KEY_TOTAL_BYTES, value: 0 },
    { key: META_KEY_LAST_PRUNED_AT, value: Date.now() },
  ]);
}

export async function deleteTrainingTelemetryForJob(input: { tenantId: string; jobId: string }): Promise<void> {
  const db = await openCacheDb();
  if (!db) return;
  const tenantId = resolveTrainingCacheTenantId(input.tenantId);
  const jobId = String(input.jobId ?? "").trim();
  if (!jobId) return;
  const jobKey = buildJobKey(tenantId, jobId);
  const eventRange = IDBKeyRange.bound([jobKey, 0], [jobKey, Number.MAX_SAFE_INTEGER]);
  const batchRange = IDBKeyRange.bound([jobKey, 0, 0], [jobKey, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]);
  const historyRange = IDBKeyRange.bound([jobKey, "", 0], [jobKey, "\uffff", Number.MAX_SAFE_INTEGER]);
  const tx = db.transaction([JOBS_STORE, EVENTS_STORE, METRIC_BATCHES_STORE, METRIC_HISTORY_ROWS_STORE, META_STORE], "readwrite");
  const jobStore = tx.objectStore(JOBS_STORE);
  const eventStore = tx.objectStore(EVENTS_STORE);
  const batchStore = tx.objectStore(METRIC_BATCHES_STORE);
  const historyStore = tx.objectStore(METRIC_HISTORY_ROWS_STORE);
  const metaStore = tx.objectStore(META_STORE);
  jobStore.delete(buildJobCacheKey(tenantId, jobId));
  metaStore.delete(buildEventsHydratedMetaKey(tenantId, jobId));
  metaStore.delete(buildMetricBatchesHydratedMetaKey(tenantId, jobId));
  const [eventRows, batchRows] = await Promise.all([
    requestToPromise(eventStore.index("byJobCreatedAt").getAll(eventRange)) as Promise<CachedJobEventRow[]>,
    requestToPromise(batchStore.index("byJobStep").getAll(batchRange)) as Promise<CachedMetricBatchRow[]>,
  ]);
  const historyRows = (await requestToPromise(historyStore.index("byJobRunIteration").getAll(historyRange))) as CachedMetricHistoryRow[];
  for (const row of eventRows) eventStore.delete(row.cacheKey);
  for (const row of batchRows) batchStore.delete(row.cacheKey);
  for (const row of historyRows) historyStore.delete(row.cacheKey);
  await transactionDone(tx);
  await pruneTrainingTelemetryCacheIfNeeded();
}

export async function getCachedVideoClipEntry(_input: {
  tenantId: string;
  jobId: string;
  viewId: string;
  clipIndex: number;
}): Promise<{
  blob: Blob;
  clipIndex: number;
  episodeNumber: number | null;
  videoStep: number | null;
  sourceEpisodeIndex: number | null;
  sourceVideoStep: number | null;
} | null> {
  return null;
}

export async function getCachedVideoClipForView(_input: {
  tenantId: string;
  jobId: string;
  viewId: string;
  clipIndex?: number | null;
}): Promise<{
  blob: Blob;
  clipIndex: number;
  episodeNumber: number | null;
  videoStep: number | null;
  sourceEpisodeIndex: number | null;
  sourceVideoStep: number | null;
} | null> {
  return null;
}

export async function listCachedVideoClipIndexesForView(_input: {
  tenantId: string;
  jobId: string;
  viewId: string;
  maxClipIndex?: number | null;
}): Promise<Set<number>> {
  return new Set<number>();
}

export async function putCachedVideoClip(_input: {
  tenantId: string;
  jobId: string;
  viewId: string;
  clipIndex: number;
  blob: Blob;
  contentType?: string;
  episodeNumber?: number | null;
  videoStep?: number | null;
  sourceEpisodeIndex?: number | null;
  sourceVideoStep?: number | null;
}): Promise<void> {
  return;
}

async function hasHydratedMetaKey(key: string): Promise<boolean> {
  const db = await openCacheDb();
  if (!db) return false;
  const tx = db.transaction(META_STORE, "readonly");
  const store = tx.objectStore(META_STORE);
  const row = (await requestToPromise(store.get(key))) as CachedCacheMetaRow | undefined;
  return Boolean(row && Number(row.value) > 0);
}

async function pruneTrainingTelemetryCacheIfNeeded(): Promise<void> {
  const now = Date.now();
  if (now < nextPruneAllowedAtMs) return;
  if (pruneInFlight) {
    await pruneInFlight;
    return;
  }
  nextPruneAllowedAtMs = now + MIN_PRUNE_INTERVAL_MS;
  pruneInFlight = pruneTrainingTelemetryCache()
    .catch(() => {})
    .finally(() => {
      pruneInFlight = null;
      nextPruneAllowedAtMs = Date.now() + MIN_PRUNE_INTERVAL_MS;
    });
  await pruneInFlight;
}

export async function pruneTrainingTelemetryCache(): Promise<void> {
  const db = await openCacheDb();
  if (!db) return;
  const now = Date.now();
  const maxAgeCutoff = now - MAX_EVENT_AGE_MS;
  const [jobRows, eventRows, metricBatchRows, metricHistoryRows] = await Promise.all([
    readAllRows<CachedTrainingJobRow>(db, JOBS_STORE),
    readAllRows<CachedJobEventRow>(db, EVENTS_STORE),
    readAllRows<CachedMetricBatchRow>(db, METRIC_BATCHES_STORE),
    readAllRows<CachedMetricHistoryRow>(db, METRIC_HISTORY_ROWS_STORE),
  ]);

  const expiredJobKeys = jobRows.filter((row) => row.updatedAtMs < maxAgeCutoff).map((row) => row.cacheKey);
  const expiredEventKeys = eventRows.filter((row) => row.createdAtMs < maxAgeCutoff).map((row) => row.cacheKey);
  const expiredMetricBatchKeys = metricBatchRows.filter((row) => row.createdAtMs < maxAgeCutoff).map((row) => row.cacheKey);
  const expiredMetricHistoryKeys = metricHistoryRows.filter((row) => row.updatedAtMs < maxAgeCutoff).map((row) => row.cacheKey);

  const activeJobs = jobRows.filter((row) => row.updatedAtMs >= maxAgeCutoff);
  const activeEvents = eventRows.filter((row) => row.createdAtMs >= maxAgeCutoff);
  const activeMetricBatches = metricBatchRows.filter((row) => row.createdAtMs >= maxAgeCutoff);
  const activeMetricHistoryRows = metricHistoryRows.filter((row) => row.updatedAtMs >= maxAgeCutoff);

  let totalBytes = 0;
  for (const row of activeJobs) totalBytes += Math.max(0, Number(row.sizeBytes || 0));
  for (const row of activeEvents) totalBytes += Math.max(0, Number(row.sizeBytes || 0));
  for (const row of activeMetricBatches) totalBytes += Math.max(0, Number(row.sizeBytes || 0));
  for (const row of activeMetricHistoryRows) totalBytes += Math.max(0, Number(row.sizeBytes || 0));

  const trimCandidates: Array<{ store: string; cacheKey: string; size: number; time: number }> = [];
  for (const row of activeJobs) trimCandidates.push({ store: JOBS_STORE, cacheKey: row.cacheKey, size: row.sizeBytes, time: row.updatedAtMs });
  for (const row of activeEvents) trimCandidates.push({ store: EVENTS_STORE, cacheKey: row.cacheKey, size: row.sizeBytes, time: row.createdAtMs });
  for (const row of activeMetricBatches) trimCandidates.push({ store: METRIC_BATCHES_STORE, cacheKey: row.cacheKey, size: row.sizeBytes, time: row.createdAtMs });
  for (const row of activeMetricHistoryRows) trimCandidates.push({ store: METRIC_HISTORY_ROWS_STORE, cacheKey: row.cacheKey, size: row.sizeBytes, time: row.updatedAtMs });
  trimCandidates.sort((a, b) => a.time - b.time);

  const trimJobKeys: string[] = [];
  const trimEventKeys: string[] = [];
  const trimMetricBatchKeys: string[] = [];
  const trimMetricHistoryKeys: string[] = [];
  for (const candidate of trimCandidates) {
    if (totalBytes <= MAX_CACHE_BYTES) break;
    totalBytes -= Math.max(0, Number(candidate.size || 0));
    if (candidate.store === JOBS_STORE) trimJobKeys.push(candidate.cacheKey);
    else if (candidate.store === EVENTS_STORE) trimEventKeys.push(candidate.cacheKey);
    else if (candidate.store === METRIC_BATCHES_STORE) trimMetricBatchKeys.push(candidate.cacheKey);
    else if (candidate.store === METRIC_HISTORY_ROWS_STORE) trimMetricHistoryKeys.push(candidate.cacheKey);
  }

  const jobKeysToDelete = [...expiredJobKeys, ...trimJobKeys];
  const eventKeysToDelete = [...expiredEventKeys, ...trimEventKeys];
  const metricBatchKeysToDelete = [...expiredMetricBatchKeys, ...trimMetricBatchKeys];
  const metricHistoryKeysToDelete = [...expiredMetricHistoryKeys, ...trimMetricHistoryKeys];

  if (jobKeysToDelete.length > 0 || eventKeysToDelete.length > 0 || metricBatchKeysToDelete.length > 0 || metricHistoryKeysToDelete.length > 0) {
    const tx = db.transaction([JOBS_STORE, EVENTS_STORE, METRIC_BATCHES_STORE, METRIC_HISTORY_ROWS_STORE], "readwrite");
    const jobStore = tx.objectStore(JOBS_STORE);
    const eventStore = tx.objectStore(EVENTS_STORE);
    const metricBatchStore = tx.objectStore(METRIC_BATCHES_STORE);
    const metricHistoryStore = tx.objectStore(METRIC_HISTORY_ROWS_STORE);
    for (const cacheKey of jobKeysToDelete) jobStore.delete(cacheKey);
    for (const cacheKey of eventKeysToDelete) eventStore.delete(cacheKey);
    for (const cacheKey of metricBatchKeysToDelete) metricBatchStore.delete(cacheKey);
    for (const cacheKey of metricHistoryKeysToDelete) metricHistoryStore.delete(cacheKey);
    await transactionDone(tx);
  }

  await writeMetaRows(db, [
    { key: META_KEY_JOB_COUNT, value: Math.max(0, activeJobs.length - trimJobKeys.length) },
    { key: META_KEY_EVENT_COUNT, value: Math.max(0, activeEvents.length - trimEventKeys.length) },
    { key: META_KEY_METRIC_BATCH_COUNT, value: Math.max(0, activeMetricBatches.length - trimMetricBatchKeys.length) },
    { key: META_KEY_METRIC_HISTORY_ROW_COUNT, value: Math.max(0, activeMetricHistoryRows.length - trimMetricHistoryKeys.length) },
    { key: META_KEY_TOTAL_BYTES, value: Math.max(0, Math.round(totalBytes)) },
    { key: META_KEY_LAST_PRUNED_AT, value: now },
  ]);
}

async function withCacheWrite(operation: (db: IDBDatabase) => Promise<void>): Promise<void> {
  const db = await openCacheDb();
  if (!db) return;
  try {
    await operation(db);
    await writeMetaRows(db, [{ key: META_KEY_LAST_WRITE_AT, value: Date.now() }]);
  } catch (error) {
    if (!isQuotaExceededError(error)) throw error;
    if (pruneInFlight) await pruneInFlight;
    await pruneTrainingTelemetryCache();
    nextPruneAllowedAtMs = Date.now() + MIN_PRUNE_INTERVAL_MS;
    await operation(db);
    await writeMetaRows(db, [{ key: META_KEY_LAST_WRITE_AT, value: Date.now() }]);
  }
}

async function readAllRows<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  const tx = db.transaction(storeName, "readonly");
  const store = tx.objectStore(storeName);
  return (await requestToPromise(store.getAll())) as T[];
}

function estimateSizeBytes(value: unknown) {
  return Math.max(1, JSON.stringify(value).length);
}

function buildJobCacheKey(tenantId: string, jobId: string) {
  return `job:${tenantId}:${jobId}`;
}

function buildJobKey(tenantId: string, jobId: string) {
  return `${tenantId}:${jobId}`;
}

function buildEventCacheKey(tenantId: string, jobId: string, eventId: string) {
  return `evt:${tenantId}:${jobId}:${eventId}`;
}

function buildMetricBatchCacheKey(tenantId: string, jobId: string, batchId: string) {
  return `metric-batch:${tenantId}:${jobId}:${batchId}`;
}

function buildMetricHistoryRunKey(jobId: string, runRef?: string | null) {
  const normalizedRunRef = typeof runRef === "string" && runRef.trim() ? runRef.trim() : "active";
  return `${jobId}:${normalizedRunRef}`;
}

function buildMetricHistoryCacheKey(tenantId: string, jobId: string, runKey: string, trainerIteration: number) {
  return `metric-history:${tenantId}:${jobId}:${runKey}:${trainerIteration}`;
}

function buildEventsHydratedMetaKey(tenantId: string, jobId: string) {
  return `${META_KEY_EVENTS_HYDRATED_PREFIX}${tenantId}:${jobId}`;
}

function buildMetricBatchesHydratedMetaKey(tenantId: string, jobId: string) {
  return `${META_KEY_METRIC_BATCHES_HYDRATED_PREFIX}${tenantId}:${jobId}`;
}

function parseCreatedAtMs(value: unknown, fallback: number) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isQuotaExceededError(error: unknown) {
  return error instanceof DOMException && error.name === "QuotaExceededError";
}

async function openCacheDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return null;
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error("indexeddb_open_failed"));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains("videoClips")) {
        db.deleteObjectStore("videoClips");
      }
      if (!db.objectStoreNames.contains(JOBS_STORE)) {
        const jobsStore = db.createObjectStore(JOBS_STORE, { keyPath: "cacheKey" });
        jobsStore.createIndex("byUpdatedAtMs", "updatedAtMs", { unique: false });
      }
      if (!db.objectStoreNames.contains(EVENTS_STORE)) {
        const eventStore = db.createObjectStore(EVENTS_STORE, { keyPath: "cacheKey" });
        eventStore.createIndex("byJobCreatedAt", ["jobKey", "createdAtMs"], { unique: false });
        eventStore.createIndex("byCreatedAtMs", "createdAtMs", { unique: false });
      }
      if (!db.objectStoreNames.contains(METRIC_BATCHES_STORE)) {
        const metricBatchStore = db.createObjectStore(METRIC_BATCHES_STORE, { keyPath: "cacheKey" });
        metricBatchStore.createIndex("byJobStep", ["jobKey", "toStep", "createdAtMs"], { unique: false });
        metricBatchStore.createIndex("byCreatedAtMs", "createdAtMs", { unique: false });
      }
      if (!db.objectStoreNames.contains(METRIC_HISTORY_ROWS_STORE)) {
        const metricHistoryStore = db.createObjectStore(METRIC_HISTORY_ROWS_STORE, { keyPath: "cacheKey" });
        metricHistoryStore.createIndex("byJobRunIteration", ["jobKey", "runKey", "trainerIteration"], {
          unique: false,
        });
        metricHistoryStore.createIndex("byUpdatedAtMs", "updatedAtMs", { unique: false });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
  }).catch((error) => {
    console.warn("[training-cache] indexeddb unavailable", error);
    dbPromise = null;
    return null;
  });
  return dbPromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexeddb_request_failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("indexeddb_transaction_aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("indexeddb_transaction_failed"));
  });
}

async function writeMetaRows(db: IDBDatabase, entries: Array<{ key: string; value: number }>): Promise<void> {
  if (!entries.length) return;
  const tx = db.transaction(META_STORE, "readwrite");
  const store = tx.objectStore(META_STORE);
  const now = Date.now();
  for (const entry of entries) {
    store.put({
      key: entry.key,
      value: Math.max(0, Number(entry.value) || 0),
      updatedAtMs: now,
    } satisfies CachedCacheMetaRow);
  }
  await transactionDone(tx);
}
