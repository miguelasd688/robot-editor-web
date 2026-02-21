import { create, type StoreApi, type UseBoundStore } from "zustand";
import type {
  SubmitTrainingJobInput,
  TrainingArtifactKind,
  TrainingArtifactSummary,
  TrainingJobEventSummary,
  TrainingJobStatus,
  TrainingJobSummary,
  TrainingRecordingSummary,
} from "../plugins/types";
import {
  cancelTrainingJobRemote,
  listTrainingArtifactsRemote,
  listTrainingJobEventsRemote,
  listTrainingJobsRemote,
  submitTrainingJobRemote,
  trainingApiEnabled,
} from "../services/trainingApiClient";
import { logError, logInfo, logWarn } from "../services/logger";

type RuntimeTrainingState = {
  jobs: TrainingJobSummary[];
  recordings: TrainingRecordingSummary[];
  trainingTokens: number;
  trainingTokenCost: number;
  submitTrainingJob: (input: SubmitTrainingJobInput) => string;
  cancelTrainingJob: (jobId: string) => void;
  listTrainingArtifacts: (jobId: string, kind?: TrainingArtifactKind) => Promise<TrainingArtifactSummary[]>;
  listTrainingJobEvents: (jobId: string, limit?: number) => Promise<TrainingJobEventSummary[]>;
};

const runningIntervals = new Map<string, number>();
const optimisticJobIds = new Set<string>();
let remotePollingTimer: number | null = null;
let remoteSyncInFlight = false;
let trainingJobCounter = 0;
let recordingCounter = 0;
const initialTrainingTokens = readPositiveIntEnv(import.meta.env.VITE_TRAINING_INITIAL_TOKENS, 20);
const trainingTokenCost = readPositiveIntEnv(import.meta.env.VITE_TRAINING_JOB_TOKEN_COST, 1);

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
  const exists = recordings.some((recording) => recording.jobId === job.id);
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

function buildLocalEvents(job: TrainingJobSummary): TrainingJobEventSummary[] {
  const baseTime = job.startedAt;
  const updatedTime = job.updatedAt;
  const items: TrainingJobEventSummary[] = [
    {
      id: `evt-queued-${job.id}`,
      jobId: job.id,
      eventType: "job.queued",
      payload: {
        status: "queued",
      },
      createdAt: new Date(baseTime).toISOString(),
    },
  ];

  if (job.status !== "queued") {
    items.push({
      id: `evt-running-${job.id}`,
      jobId: job.id,
      eventType: "job.running",
      payload: {
        status: job.status === "provisioning" ? "provisioning" : "running",
      },
      createdAt: new Date(Math.max(baseTime + 300, Math.min(updatedTime, baseTime + 1000))).toISOString(),
    });
  }

  if (job.currentEpoch > 0) {
    items.push({
      id: `evt-metrics-${job.id}`,
      jobId: job.id,
      eventType: "job.metrics",
      payload: {
        currentEpoch: job.currentEpoch,
        progress: job.progress,
        loss: job.loss,
      },
      createdAt: new Date(updatedTime).toISOString(),
    });
  }

  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
    items.push({
      id: `evt-terminal-${job.id}`,
      jobId: job.id,
      eventType: `job.${job.status}`,
      payload: {
        status: job.status,
        failureReason: job.failureReason ?? undefined,
      },
      createdAt: new Date(updatedTime).toISOString(),
    });
  }

  return items
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((event) => ({ ...event }));
}

async function syncRemoteJobsOnce() {
  if (!trainingApiEnabled || remoteSyncInFlight) return;
  remoteSyncInFlight = true;

  try {
    const remoteJobs = await listTrainingJobsRemote();
    useRuntimeTrainingStore.setState((current) => {
      const optimistic = current.jobs.filter((job) => optimisticJobIds.has(job.id));
      const mergedJobs = sortJobs([...remoteJobs, ...optimistic]);

      let nextRecordings = current.recordings;
      for (const job of remoteJobs) {
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
  } finally {
    remoteSyncInFlight = false;
  }
}

function ensureRemotePolling() {
  if (!trainingApiEnabled) return;
  if (remotePollingTimer !== null) return;

  void syncRemoteJobsOnce();
  remotePollingTimer = window.setInterval(() => {
    void syncRemoteJobsOnce();
  }, 2000);
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

      const exists = current.recordings.some((recording) => recording.jobId === jobId);
      if (exists) {
        return { jobs: updatedJobs };
      }

      const qualityScore = Number(Math.max(0, (1 - nextLoss) * 100).toFixed(1));
      const recording: TrainingRecordingSummary = {
        id: `rec_${Date.now()}_${recordingCounter++}`,
        jobId,
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

export const useRuntimeTrainingStore: UseBoundStore<StoreApi<RuntimeTrainingState>> = create<RuntimeTrainingState>(
  (set, get) => ({
  jobs: [],
  recordings: [],
  trainingTokens: initialTrainingTokens,
  trainingTokenCost: trainingTokenCost,

  submitTrainingJob: (input) => {
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
      ensureRemotePolling();

      const now = Date.now();
      const localId = `local_job_${now}_${trainingJobCounter++}`;
      const epochs = Math.max(1, Math.round(input.epochs));
      const modelName = input.modelName.trim() || "default-model";
      const dataset = input.dataset.trim() || "default-dataset";
      const experimentName = (input.experimentName ?? modelName).trim() || modelName;
      const envId = (input.envId ?? dataset).trim() || dataset;
      const trainer = input.trainer ?? "rsl_rl";
      const maxSteps = Math.max(1, Math.round(input.maxSteps ?? epochs));
      const optimisticJob: TrainingJobSummary = {
        id: localId,
        modelName,
        dataset,
        epochs,
        status: "queued",
        progress: 0,
        currentEpoch: 0,
        loss: null,
        startedAt: now,
        updatedAt: now,
      };

      optimisticJobIds.add(localId);
      set((state) => ({ jobs: sortJobs([optimisticJob, ...state.jobs]) }));

      void submitTrainingJobRemote({
        modelName,
        dataset,
        epochs,
        tenantId: input.tenantId,
        experimentName,
        envId,
        trainer,
        maxSteps,
        seed: input.seed,
        config: input.config ?? {},
      })
        .then((remoteJob) => {
          optimisticJobIds.delete(localId);
          set((state) => {
            const withoutLocal = state.jobs.filter((job) => job.id !== localId && job.id !== remoteJob.id);
            const merged = sortJobs([remoteJob, ...withoutLocal]);
            return {
              jobs: merged,
              recordings: upsertRecordingFromCompletedJob(state.recordings, remoteJob),
            };
          });
          logInfo("Training job submitted to remote API", {
            scope: "runtime-training",
            data: { localId, remoteId: remoteJob.id },
          });
          void syncRemoteJobsOnce();
        })
        .catch((error) => {
          optimisticJobIds.delete(localId);
          set((state) => ({
            trainingTokens: state.trainingTokens + state.trainingTokenCost,
            jobs: state.jobs.map((job) =>
              job.id === localId
                ? {
                    ...job,
                    status: "failed",
                    updatedAt: Date.now(),
                  }
                : job
            ),
          }));
          logError("Training job submission failed", {
            scope: "runtime-training",
            data: error,
          });
        });

      return localId;
    }

    const now = Date.now();
    const id = `job_${now}_${trainingJobCounter++}`;
    const epochs = Math.max(1, Math.round(input.epochs));
    const modelName = input.modelName.trim() || "default-model";
    const dataset = input.dataset.trim() || "default-dataset";

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
      } else {
        void cancelTrainingJobRemote(jobId).catch((error) => {
          logWarn("Failed to cancel remote training job", {
            scope: "runtime-training",
            data: { jobId, error },
          });
        });
      }

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

  listTrainingArtifacts: async (jobId, kind): Promise<TrainingArtifactSummary[]> => {
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
    if (trainingApiEnabled) {
      try {
        return await listTrainingJobEventsRemote(jobId, limit);
      } catch (error) {
        logWarn("Failed to list training job events from remote API", {
          scope: "runtime-training",
          data: { jobId, limit, error },
        });
        return [];
      }
    }

    const job = get().jobs.find((item) => item.id === jobId) ?? null;
    if (!job) return [];
    return buildLocalEvents(job).slice(0, Math.min(Math.max(1, Math.round(limit)), 500));
  },
})
);
