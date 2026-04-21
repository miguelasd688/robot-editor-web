import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listTrainingJobEventsRemote: vi.fn(),
  listTrainingMetricBatchesRemote: vi.fn(),
  listTrainingArtifactsRemote: vi.fn(),
  listTrainingJobsRemote: vi.fn(),
  cancelTrainingJobRemote: vi.fn(),
}));

vi.mock("../services/trainingApiClient", () => ({
  trainingApiEnabled: true,
  buildTrainingLivePulseStreamUrl: vi.fn(),
  cancelTrainingJobRemote: mocks.cancelTrainingJobRemote,
  getTrainingRunnerLogsRemote: vi.fn(),
  listTrainingArtifactsRemote: mocks.listTrainingArtifactsRemote,
  listTrainingJobEventsRemote: mocks.listTrainingJobEventsRemote,
  listTrainingMetricBatchesRemote: mocks.listTrainingMetricBatchesRemote,
  listTrainingJobsRemote: mocks.listTrainingJobsRemote,
  submitTrainingTaskRemoteWithResponse: vi.fn(),
}));

vi.mock("../services/trainingTelemetryCache", () => ({
  resolveTrainingCacheTenantId: (tenantId: unknown) => String(tenantId ?? "local"),
  cacheTrainingJobs: vi.fn(),
  cacheTrainingEvents: vi.fn(),
  cacheMetricBatches: vi.fn(),
  cacheMetricHistoryRows: vi.fn(),
  deleteTrainingTelemetryForJob: vi.fn(),
  hasHydratedTrainingEvents: vi.fn(),
  hasHydratedMetricBatches: vi.fn(),
  listCachedMetricHistoryRows: vi.fn().mockResolvedValue([]),
  listCachedTrainingJobs: vi.fn().mockResolvedValue([]),
  listCachedTrainingEvents: vi.fn().mockResolvedValue([]),
  listCachedMetricBatches: vi.fn().mockResolvedValue([]),
  markHydratedTrainingEvents: vi.fn(),
  markHydratedMetricBatches: vi.fn(),
}));

vi.mock("../services/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("../training/IsaacLabEnvironmentManager", () => ({
  isaacLabEnvironmentManager: {
    buildCustomTaskRequest: vi.fn(),
  },
}));

vi.mock("../editor/engineSingleton", () => ({
  editorEngine: {
    getDoc: vi.fn(),
  },
}));

vi.mock("./useTrainingImportContextStore", () => ({
  useTrainingImportContextStore: {
    getState: () => ({
      setCompiledTrainingEnvironment: vi.fn(),
    }),
  },
}));

import { useRuntimeTrainingStore } from "./useRuntimeTrainingStore";

describe("useRuntimeTrainingStore transport ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRuntimeTrainingStore.setState({
      jobs: [],
      recordings: [],
      metricHistoryByJob: {},
      transportDiagnosticsByJob: {},
      trainingTokens: 20,
      trainingTokenCost: 1,
    });
  });

  it("shows cancelling immediately and suppresses duplicate remote cancels", async () => {
    useRuntimeTrainingStore.setState({
      jobs: [
        {
          id: "job-cancel",
          tenantId: "tenant-a",
          status: "running",
          lifecycleStatus: "running",
          updatedAt: Date.now(),
        } as never,
      ],
    });
    mocks.cancelTrainingJobRemote.mockResolvedValueOnce({
      jobId: "job-cancel",
      accepted: true,
      cancelRequested: true,
      runnerCancelDispatchAttempted: true,
      runnerCancelDispatchSucceeded: true,
    });

    useRuntimeTrainingStore.getState().cancelTrainingJob("job-cancel");
    useRuntimeTrainingStore.getState().cancelTrainingJob("job-cancel");

    const job = useRuntimeTrainingStore.getState().jobs.find((item) => item.id === "job-cancel");
    expect(job?.status).toBe("cancelling");
    expect(job?.lifecycleStatus).toBe("cancelling");
    expect(mocks.cancelTrainingJobRemote).toHaveBeenCalledTimes(1);
  });

  it("does not cross-fetch metric batches when listing events", async () => {
    useRuntimeTrainingStore.setState({
      jobs: [{ id: "job-1", tenantId: "tenant-a", status: "running" } as never],
    });
    mocks.listTrainingJobEventsRemote.mockResolvedValueOnce([
      { id: "event-1", jobId: "job-1", eventType: "x", payload: {}, createdAt: "2026-04-16T00:00:00.000Z" },
    ]);

    await useRuntimeTrainingStore.getState().listTrainingJobEvents("job-1", 10);

    expect(mocks.listTrainingJobEventsRemote).toHaveBeenCalledTimes(1);
    expect(mocks.listTrainingMetricBatchesRemote).not.toHaveBeenCalled();
  });

  it("only fetches metric batches when an explicit reason is supplied", async () => {
    useRuntimeTrainingStore.setState({
      jobs: [{ id: "job-2", tenantId: "tenant-a", status: "completed" } as never],
    });
    mocks.listTrainingMetricBatchesRemote.mockResolvedValueOnce([]);

    await useRuntimeTrainingStore.getState().listTrainingMetricBatches("job-2");

    expect(mocks.listTrainingMetricBatchesRemote).not.toHaveBeenCalled();

    await useRuntimeTrainingStore.getState().listTrainingMetricBatches("job-2", {
      reason: "terminal_replay",
      limit: 10,
    });

    expect(mocks.listTrainingMetricBatchesRemote).toHaveBeenCalledTimes(1);
  });
});
