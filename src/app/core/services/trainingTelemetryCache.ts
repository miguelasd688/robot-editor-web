import type { TrainingJobEventSummary, TrainingJobSummary } from "../plugins/types";
import { buildCanonicalMetricEventId } from "./trainingMetricIdentity";

const DB_NAME = "runtime-training-telemetry-cache";
const DB_VERSION = 3;
const JOBS_STORE = "trainingJobs";
const EVENTS_STORE = "jobEvents";
const VIDEO_STORE = "videoClips";
const META_STORE = "cacheMeta";

const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CACHE_BYTES = 256 * 1024 * 1024;
const MIN_PRUNE_INTERVAL_MS = 20_000;
const METRIC_CACHE_STEP_INTERVAL = 16;
const DEFAULT_TENANT_ID = "local";
const META_KEY_EVENT_COUNT = "eventCount";
const META_KEY_JOB_COUNT = "jobCount";
const META_KEY_VIDEO_COUNT = "videoCount";
const META_KEY_TOTAL_BYTES = "totalBytes";
const META_KEY_LAST_PRUNED_AT = "lastPrunedAtMs";
const META_KEY_LAST_WRITE_AT = "lastWriteAtMs";
const META_KEY_EVENTS_HYDRATED_PREFIX = "eventsHydrated:";

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

type CachedVideoClipRow = {
  cacheKey: string;
  tenantId: string;
  jobId: string;
  jobKey: string;
  viewId: string;
  clipIndex: number;
  blob: Blob;
  contentType: string;
  sizeBytes: number;
  episodeNumber?: number;
  videoStep?: number;
  sourceEpisodeIndex?: number;
  sourceVideoStep?: number;
  createdAtMs: number;
  accessedAtMs: number;
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
  return rows.slice(0, boundedLimit).map(mapCachedEventRowToSummary);
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
      const updatedAtMs = Number.isFinite(Number(job.updatedAt))
        ? Math.max(0, Math.round(Number(job.updatedAt)))
        : now;
      const normalized: TrainingJobSummary = {
        ...job,
        id: jobId,
        tenantId,
        updatedAt: updatedAtMs,
      };
      const row: CachedTrainingJobRow = {
        cacheKey: buildJobCacheKey(tenantId, jobId),
        tenantId,
        jobId,
        updatedAtMs,
        sizeBytes: estimateJobSizeBytes(normalized),
        updatedAtCacheMs: now,
        job: normalized,
      };
      store.put(row);
    }
    await transactionDone(tx);
  });
  await pruneTrainingTelemetryCacheIfNeeded();
}

export async function hasHydratedTrainingEvents(input: { tenantId: string; jobId: string }): Promise<boolean> {
  const db = await openCacheDb();
  if (!db) return false;
  const tx = db.transaction(META_STORE, "readonly");
  const store = tx.objectStore(META_STORE);
  const row = (await requestToPromise(store.get(buildEventsHydratedMetaKey(input.tenantId, input.jobId)))) as
    | CachedCacheMetaRow
    | undefined;
  return Boolean(row && Number(row.value) > 0);
}

export async function markHydratedTrainingEvents(input: { tenantId: string; jobId: string }): Promise<void> {
  const db = await openCacheDb();
  if (!db) return;
  await writeMetaRows(db, [{ key: buildEventsHydratedMetaKey(input.tenantId, input.jobId), value: 1 }]);
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
      const createdAt = new Date(createdAtMs).toISOString();
      const payload = isRecord(item.payload) ? item.payload : {};
      const row: CachedJobEventRow = {
        cacheKey: buildEventCacheKey(input.tenantId, input.jobId, eventId),
        jobKey,
        tenantId: input.tenantId,
        jobId: input.jobId,
        eventId,
        eventType,
        payload,
        createdAt,
        createdAtMs,
        sizeBytes: estimateEventSizeBytes(eventType, payload),
        updatedAtMs: now,
      };
      store.put(row);
    }
    await transactionDone(tx);
  });
  await pruneTrainingTelemetryCacheIfNeeded();
}

export async function appendCachedMetricEvent(input: {
  tenantId: string;
  jobId: string;
  runnerJobId?: string | null;
  step: number;
  metrics: Record<string, unknown>;
  source?: string | null;
  progressSummary?: Record<string, unknown> | null;
  occurredAt?: string;
}): Promise<void> {
  const safeStep = Math.max(0, Math.round(Number(input.step) || 0));
  if (safeStep <= 0) return;
  if (safeStep > 5 && safeStep % METRIC_CACHE_STEP_INTERVAL !== 0) return;
  const occurredAtMs = parseCreatedAtMs(input.occurredAt, Date.now());
  const eventId = buildCanonicalMetricEventId({
    jobId: input.jobId,
    eventType: "runner.metrics",
    runnerJobId: input.runnerJobId ?? null,
    step: safeStep,
    metrics: isRecord(input.metrics) ? input.metrics : {},
    source: input.source ?? null,
  });
  const event: TrainingJobEventSummary = {
    id: eventId,
    jobId: input.jobId,
    eventType: "runner.metrics",
    payload: {
      runnerJobId: input.runnerJobId ?? null,
      step: safeStep,
      metrics: isRecord(input.metrics) ? input.metrics : {},
      source: input.source ?? null,
      ...(isRecord(input.progressSummary) ? { progressSummary: input.progressSummary } : {}),
    },
    createdAt: new Date(occurredAtMs).toISOString(),
  };
  await cacheTrainingEvents({
    tenantId: input.tenantId,
    jobId: input.jobId,
    items: [event],
  });
}

export async function getCachedVideoClip(input: {
  tenantId: string;
  jobId: string;
  viewId: string;
  clipIndex: number;
}): Promise<Blob | null> {
  const entry = await getCachedVideoClipEntry(input);
  return entry?.blob ?? null;
}

export async function getCachedVideoClipEntry(input: {
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
  const db = await openCacheDb();
  if (!db) return null;
  const cacheKey = buildVideoCacheKey(input.tenantId, input.jobId, input.viewId, input.clipIndex);

  const readTx = db.transaction(VIDEO_STORE, "readonly");
  const readStore = readTx.objectStore(VIDEO_STORE);
  const row = (await requestToPromise(readStore.get(cacheKey))) as CachedVideoClipRow | undefined;
  if (!row) return null;

  const writeTx = db.transaction(VIDEO_STORE, "readwrite");
  const writeStore = writeTx.objectStore(VIDEO_STORE);
  writeStore.put({
    ...row,
    accessedAtMs: Date.now(),
  });
  await transactionDone(writeTx);
  return {
    blob: row.blob,
    clipIndex: Math.max(1, Math.round(Number(row.clipIndex) || 1)),
    episodeNumber: Number.isFinite(Number(row.episodeNumber))
      ? Math.max(0, Math.round(Number(row.episodeNumber)))
      : null,
    videoStep: Number.isFinite(Number(row.videoStep))
      ? Math.max(0, Math.round(Number(row.videoStep)))
      : null,
    sourceEpisodeIndex: Number.isFinite(Number(row.sourceEpisodeIndex))
      ? Math.max(0, Math.round(Number(row.sourceEpisodeIndex)))
      : null,
    sourceVideoStep: Number.isFinite(Number(row.sourceVideoStep))
      ? Math.max(0, Math.round(Number(row.sourceVideoStep)))
      : null,
  };
}

export async function getCachedVideoClipForView(input: {
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
  const db = await openCacheDb();
  if (!db) return null;
  const tenantId = resolveTrainingCacheTenantId(input.tenantId);
  const jobId = String(input.jobId ?? "").trim();
  if (!jobId) return null;
  const viewId = String(input.viewId || "global").trim() || "global";
  const requestedClipIndex = Number(input.clipIndex);
  if (Number.isFinite(requestedClipIndex) && requestedClipIndex > 0) {
    const clipIndex = Math.max(1, Math.round(requestedClipIndex));
    return await getCachedVideoClipEntry({ tenantId, jobId, viewId, clipIndex });
  }

  const readTx = db.transaction(VIDEO_STORE, "readonly");
  const readStore = readTx.objectStore(VIDEO_STORE);
  const readIndex = readStore.index("byJobAccessedAt");
  const jobKey = buildJobKey(tenantId, jobId);
  const range = IDBKeyRange.bound([jobKey, 0], [jobKey, Number.MAX_SAFE_INTEGER]);
  const rows = (await requestToPromise(readIndex.getAll(range))) as CachedVideoClipRow[];
  const candidates = rows.filter((row) => row.viewId === viewId);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (b.clipIndex !== a.clipIndex) return b.clipIndex - a.clipIndex;
    return b.accessedAtMs - a.accessedAtMs;
  });
  const chosen = candidates[0];

  const writeTx = db.transaction(VIDEO_STORE, "readwrite");
  const writeStore = writeTx.objectStore(VIDEO_STORE);
  writeStore.put({
    ...chosen,
    accessedAtMs: Date.now(),
  });
  await transactionDone(writeTx);
  return {
    blob: chosen.blob,
    clipIndex: chosen.clipIndex,
    episodeNumber: Number.isFinite(Number(chosen.episodeNumber))
      ? Math.max(0, Math.round(Number(chosen.episodeNumber)))
      : null,
    videoStep: Number.isFinite(Number(chosen.videoStep))
      ? Math.max(0, Math.round(Number(chosen.videoStep)))
      : null,
    sourceEpisodeIndex: Number.isFinite(Number(chosen.sourceEpisodeIndex))
      ? Math.max(0, Math.round(Number(chosen.sourceEpisodeIndex)))
      : null,
    sourceVideoStep: Number.isFinite(Number(chosen.sourceVideoStep))
      ? Math.max(0, Math.round(Number(chosen.sourceVideoStep)))
      : null,
  };
}

export async function listCachedVideoClipIndexesForView(input: {
  tenantId: string;
  jobId: string;
  viewId: string;
  maxClipIndex?: number | null;
}): Promise<Set<number>> {
  const db = await openCacheDb();
  if (!db) return new Set<number>();
  const tenantId = resolveTrainingCacheTenantId(input.tenantId);
  const jobId = String(input.jobId ?? "").trim();
  if (!jobId) return new Set<number>();
  const viewId = String(input.viewId || "global").trim() || "global";
  const requestedMaxClipIndex = Number(input.maxClipIndex);
  const maxClipIndex =
    Number.isFinite(requestedMaxClipIndex) && requestedMaxClipIndex > 0
      ? Math.max(1, Math.round(requestedMaxClipIndex))
      : null;

  const tx = db.transaction(VIDEO_STORE, "readonly");
  const store = tx.objectStore(VIDEO_STORE);
  const index = store.index("byJobAccessedAt");
  const jobKey = buildJobKey(tenantId, jobId);
  const range = IDBKeyRange.bound([jobKey, 0], [jobKey, Number.MAX_SAFE_INTEGER]);
  const rows = (await requestToPromise(index.getAll(range))) as CachedVideoClipRow[];
  const clipIndexes = new Set<number>();
  for (const row of rows) {
    if (row.viewId !== viewId) continue;
    const clipIndex = Math.max(1, Math.round(Number(row.clipIndex) || 1));
    if (maxClipIndex !== null && clipIndex > maxClipIndex) continue;
    clipIndexes.add(clipIndex);
  }
  return clipIndexes;
}

export async function putCachedVideoClip(input: {
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
  await withCacheWrite(async (db) => {
    const now = Date.now();
    const tx = db.transaction(VIDEO_STORE, "readwrite");
    const store = tx.objectStore(VIDEO_STORE);
    const cacheKey = buildVideoCacheKey(input.tenantId, input.jobId, input.viewId, input.clipIndex);
    const existing = (await requestToPromise(store.get(cacheKey))) as CachedVideoClipRow | undefined;
    const normalizedEpisodeNumber = Number.isFinite(Number(input.episodeNumber))
      ? Math.max(0, Math.round(Number(input.episodeNumber)))
      : Number.isFinite(Number(existing?.episodeNumber))
        ? Math.max(0, Math.round(Number(existing?.episodeNumber)))
        : undefined;
    const normalizedVideoStep = Number.isFinite(Number(input.videoStep))
      ? Math.max(0, Math.round(Number(input.videoStep)))
      : Number.isFinite(Number(existing?.videoStep))
        ? Math.max(0, Math.round(Number(existing?.videoStep)))
        : undefined;
    const normalizedSourceEpisodeIndex = Number.isFinite(Number(input.sourceEpisodeIndex))
      ? Math.max(0, Math.round(Number(input.sourceEpisodeIndex)))
      : Number.isFinite(Number(existing?.sourceEpisodeIndex))
        ? Math.max(0, Math.round(Number(existing?.sourceEpisodeIndex)))
        : undefined;
    const normalizedSourceVideoStep = Number.isFinite(Number(input.sourceVideoStep))
      ? Math.max(0, Math.round(Number(input.sourceVideoStep)))
      : Number.isFinite(Number(existing?.sourceVideoStep))
        ? Math.max(0, Math.round(Number(existing?.sourceVideoStep)))
        : undefined;
    const row: CachedVideoClipRow = {
      cacheKey,
      tenantId: input.tenantId,
      jobId: input.jobId,
      jobKey: buildJobKey(input.tenantId, input.jobId),
      viewId: input.viewId,
      clipIndex: Math.max(1, Math.round(input.clipIndex)),
      blob: input.blob,
      contentType: String(input.contentType ?? input.blob.type ?? "application/octet-stream"),
      sizeBytes: Math.max(0, Number(input.blob.size || 0)),
      episodeNumber: normalizedEpisodeNumber,
      videoStep: normalizedVideoStep,
      sourceEpisodeIndex: normalizedSourceEpisodeIndex,
      sourceVideoStep: normalizedSourceVideoStep,
      createdAtMs: Number.isFinite(Number(existing?.createdAtMs))
        ? Math.max(0, Math.round(Number(existing?.createdAtMs)))
        : now,
      accessedAtMs: now,
    };
    store.put(row);
    await transactionDone(tx);
  });
  await pruneTrainingTelemetryCacheIfNeeded();
}

export async function clearTrainingTelemetryCache(): Promise<void> {
  nextPruneAllowedAtMs = Date.now() + MIN_PRUNE_INTERVAL_MS;
  const db = await openCacheDb();
  if (!db) return;
  const tx = db.transaction([JOBS_STORE, EVENTS_STORE, VIDEO_STORE, META_STORE], "readwrite");
  tx.objectStore(JOBS_STORE).clear();
  tx.objectStore(EVENTS_STORE).clear();
  tx.objectStore(VIDEO_STORE).clear();
  tx.objectStore(META_STORE).clear();
  await transactionDone(tx);
  await writeMetaRows(db, [
    { key: META_KEY_JOB_COUNT, value: 0 },
    { key: META_KEY_EVENT_COUNT, value: 0 },
    { key: META_KEY_VIDEO_COUNT, value: 0 },
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
  const videoRange = IDBKeyRange.bound([jobKey, 0], [jobKey, Number.MAX_SAFE_INTEGER]);

  const tx = db.transaction([JOBS_STORE, EVENTS_STORE, VIDEO_STORE, META_STORE], "readwrite");
  const jobStore = tx.objectStore(JOBS_STORE);
  const eventStore = tx.objectStore(EVENTS_STORE);
  const eventIndex = eventStore.index("byJobCreatedAt");
  const videoStore = tx.objectStore(VIDEO_STORE);
  const videoIndex = videoStore.index("byJobAccessedAt");
  const metaStore = tx.objectStore(META_STORE);

  jobStore.delete(buildJobCacheKey(tenantId, jobId));
  metaStore.delete(buildEventsHydratedMetaKey(tenantId, jobId));

  const [eventRows, videoRows] = await Promise.all([
    requestToPromise(eventIndex.getAll(eventRange)) as Promise<CachedJobEventRow[]>,
    requestToPromise(videoIndex.getAll(videoRange)) as Promise<CachedVideoClipRow[]>,
  ]);
  for (const row of eventRows) {
    eventStore.delete(row.cacheKey);
  }
  for (const row of videoRows) {
    videoStore.delete(row.cacheKey);
  }

  await transactionDone(tx);
  await pruneTrainingTelemetryCacheIfNeeded();
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
  const [jobRows, eventRows, videoRows] = await Promise.all([
    readAllJobRows(db),
    readAllEventRows(db),
    readAllVideoRows(db),
  ]);

  const expiredJobKeys = jobRows.filter((row) => row.updatedAtMs < maxAgeCutoff).map((row) => row.cacheKey);
  const expiredEventKeys = eventRows.filter((row) => row.createdAtMs < maxAgeCutoff).map((row) => row.cacheKey);
  const expiredVideoKeys = videoRows.filter((row) => row.accessedAtMs < maxAgeCutoff).map((row) => row.cacheKey);

  const activeJobs = jobRows.filter((row) => row.updatedAtMs >= maxAgeCutoff);
  const activeEvents = eventRows.filter((row) => row.createdAtMs >= maxAgeCutoff);
  const activeVideos = videoRows.filter((row) => row.accessedAtMs >= maxAgeCutoff);

  let totalBytes = 0;
  for (const row of activeJobs) totalBytes += Math.max(0, Number(row.sizeBytes || 0));
  for (const row of activeEvents) totalBytes += Math.max(0, Number(row.sizeBytes || 0));
  for (const row of activeVideos) totalBytes += Math.max(0, Number(row.sizeBytes || 0));

  const sizeTrimCandidates: Array<{
    store: typeof JOBS_STORE | typeof EVENTS_STORE | typeof VIDEO_STORE;
    cacheKey: string;
    size: number;
    time: number;
  }> = [];
  for (const row of activeJobs) {
    sizeTrimCandidates.push({
      store: JOBS_STORE,
      cacheKey: row.cacheKey,
      size: Math.max(0, Number(row.sizeBytes || 0)),
      time: row.updatedAtMs,
    });
  }
  for (const row of activeVideos) {
    sizeTrimCandidates.push({
      store: VIDEO_STORE,
      cacheKey: row.cacheKey,
      size: Math.max(0, Number(row.sizeBytes || 0)),
      time: row.accessedAtMs,
    });
  }
  for (const row of activeEvents) {
    sizeTrimCandidates.push({
      store: EVENTS_STORE,
      cacheKey: row.cacheKey,
      size: Math.max(0, Number(row.sizeBytes || 0)),
      time: row.createdAtMs,
    });
  }
  sizeTrimCandidates.sort((a, b) => a.time - b.time);

  const trimJobKeys: string[] = [];
  const trimEventKeys: string[] = [];
  const trimVideoKeys: string[] = [];
  for (const candidate of sizeTrimCandidates) {
    if (totalBytes <= MAX_CACHE_BYTES) break;
    totalBytes -= candidate.size;
    if (candidate.store === JOBS_STORE) {
      trimJobKeys.push(candidate.cacheKey);
    } else if (candidate.store === EVENTS_STORE) {
      trimEventKeys.push(candidate.cacheKey);
    } else {
      trimVideoKeys.push(candidate.cacheKey);
    }
  }

  const jobKeysToDelete = [...expiredJobKeys, ...trimJobKeys];
  const eventKeysToDelete = [...expiredEventKeys, ...trimEventKeys];
  const videoKeysToDelete = [...expiredVideoKeys, ...trimVideoKeys];
  if (jobKeysToDelete.length === 0 && eventKeysToDelete.length === 0 && videoKeysToDelete.length === 0) {
    await writeMetaRows(db, [
      { key: META_KEY_JOB_COUNT, value: activeJobs.length },
      { key: META_KEY_EVENT_COUNT, value: activeEvents.length },
      { key: META_KEY_VIDEO_COUNT, value: activeVideos.length },
      { key: META_KEY_TOTAL_BYTES, value: Math.max(0, Math.round(totalBytes)) },
      { key: META_KEY_LAST_PRUNED_AT, value: now },
    ]);
    return;
  }

  const tx = db.transaction([JOBS_STORE, EVENTS_STORE, VIDEO_STORE], "readwrite");
  const jobStore = tx.objectStore(JOBS_STORE);
  const eventStore = tx.objectStore(EVENTS_STORE);
  const videoStore = tx.objectStore(VIDEO_STORE);
  for (const cacheKey of jobKeysToDelete) {
    jobStore.delete(cacheKey);
  }
  for (const cacheKey of eventKeysToDelete) {
    eventStore.delete(cacheKey);
  }
  for (const cacheKey of videoKeysToDelete) {
    videoStore.delete(cacheKey);
  }
  await transactionDone(tx);

  const remainingJobCount = Math.max(0, activeJobs.length - trimJobKeys.length);
  const remainingEventCount = Math.max(0, activeEvents.length - trimEventKeys.length);
  const remainingVideoCount = Math.max(0, activeVideos.length - trimVideoKeys.length);
  await writeMetaRows(db, [
    { key: META_KEY_JOB_COUNT, value: remainingJobCount },
    { key: META_KEY_EVENT_COUNT, value: remainingEventCount },
    { key: META_KEY_VIDEO_COUNT, value: remainingVideoCount },
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
    if (pruneInFlight) {
      await pruneInFlight;
    }
    await pruneTrainingTelemetryCache();
    nextPruneAllowedAtMs = Date.now() + MIN_PRUNE_INTERVAL_MS;
    await operation(db);
    await writeMetaRows(db, [{ key: META_KEY_LAST_WRITE_AT, value: Date.now() }]);
  }
}

async function readAllJobRows(db: IDBDatabase): Promise<CachedTrainingJobRow[]> {
  const tx = db.transaction(JOBS_STORE, "readonly");
  const store = tx.objectStore(JOBS_STORE);
  const rows = (await requestToPromise(store.getAll())) as CachedTrainingJobRow[];
  return rows;
}

async function readAllEventRows(db: IDBDatabase): Promise<CachedJobEventRow[]> {
  const tx = db.transaction(EVENTS_STORE, "readonly");
  const store = tx.objectStore(EVENTS_STORE);
  const rows = (await requestToPromise(store.getAll())) as CachedJobEventRow[];
  return rows;
}

async function readAllVideoRows(db: IDBDatabase): Promise<CachedVideoClipRow[]> {
  const tx = db.transaction(VIDEO_STORE, "readonly");
  const store = tx.objectStore(VIDEO_STORE);
  const rows = (await requestToPromise(store.getAll())) as CachedVideoClipRow[];
  return rows;
}

function mapCachedEventRowToSummary(row: CachedJobEventRow): TrainingJobEventSummary {
  return {
    id: row.eventId,
    jobId: row.jobId,
    eventType: row.eventType,
    payload: isRecord(row.payload) ? row.payload : {},
    createdAt: row.createdAt,
  };
}

function estimateEventSizeBytes(eventType: string, payload: Record<string, unknown>) {
  const text = JSON.stringify({ eventType, payload });
  return Math.max(1, text.length);
}

function estimateJobSizeBytes(job: TrainingJobSummary) {
  const text = JSON.stringify(job);
  return Math.max(1, text.length);
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

function buildVideoCacheKey(tenantId: string, jobId: string, viewId: string, clipIndex: number) {
  const safeViewId = String(viewId || "global").trim() || "global";
  const safeClipIndex = Math.max(1, Math.round(clipIndex));
  return `clip:${tenantId}:${jobId}:${safeViewId}:${safeClipIndex}`;
}

function buildEventsHydratedMetaKey(tenantId: string, jobId: string) {
  return `${META_KEY_EVENTS_HYDRATED_PREFIX}${tenantId}:${jobId}`;
}

function parseCreatedAtMs(value: unknown, fallback: number) {
  const parsed = Date.parse(String(value ?? ""));
  if (Number.isFinite(parsed)) return parsed;
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isQuotaExceededError(error: unknown) {
  if (!(error instanceof DOMException)) return false;
  return error.name === "QuotaExceededError";
}

async function openCacheDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return null;
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error("indexeddb_open_failed"));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(JOBS_STORE)) {
        const jobsStore = db.createObjectStore(JOBS_STORE, { keyPath: "cacheKey" });
        jobsStore.createIndex("byUpdatedAtMs", "updatedAtMs", { unique: false });
      }
      if (!db.objectStoreNames.contains(EVENTS_STORE)) {
        const eventStore = db.createObjectStore(EVENTS_STORE, { keyPath: "cacheKey" });
        eventStore.createIndex("byJobCreatedAt", ["jobKey", "createdAtMs"], { unique: false });
        eventStore.createIndex("byCreatedAtMs", "createdAtMs", { unique: false });
      }
      if (!db.objectStoreNames.contains(VIDEO_STORE)) {
        const videoStore = db.createObjectStore(VIDEO_STORE, { keyPath: "cacheKey" });
        videoStore.createIndex("byJobAccessedAt", ["jobKey", "accessedAtMs"], { unique: false });
        videoStore.createIndex("byAccessedAtMs", "accessedAtMs", { unique: false });
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

async function writeMetaRows(
  db: IDBDatabase,
  entries: Array<{ key: string; value: number }>
): Promise<void> {
  if (!entries.length) return;
  const tx = db.transaction(META_STORE, "readwrite");
  const store = tx.objectStore(META_STORE);
  const now = Date.now();
  for (const entry of entries) {
    const row: CachedCacheMetaRow = {
      key: entry.key,
      value: Math.max(0, Number(entry.value) || 0),
      updatedAtMs: now,
    };
    store.put(row);
  }
  await transactionDone(tx);
}
