import { create } from "zustand";
import type {
  SubmitTrainingJobInput,
  TrainingJobStatus,
  TrainingJobSummary,
  TrainingRecordingSummary,
} from "../plugins/types";
import { logInfo } from "../services/logger";

type RuntimeTrainingState = {
  jobs: TrainingJobSummary[];
  recordings: TrainingRecordingSummary[];
  submitTrainingJob: (input: SubmitTrainingJobInput) => string;
  cancelTrainingJob: (jobId: string) => void;
};

const runningIntervals = new Map<string, number>();
let trainingJobCounter = 0;
let recordingCounter = 0;

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

export const useRuntimeTrainingStore = create<RuntimeTrainingState>((set, get) => ({
  jobs: [],
  recordings: [],

  submitTrainingJob: (input) => {
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
}));
