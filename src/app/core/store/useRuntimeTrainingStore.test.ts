import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildTrainingLivePulseStreamUrl: vi.fn(),
  listTrainingJobEventsRemote: vi.fn(),
  listTrainingMetricBatchesRemote: vi.fn(),
  listTrainingArtifactsRemote: vi.fn(),
  listTrainingJobsRemote: vi.fn(),
  cancelTrainingJobRemote: vi.fn(),
}));

vi.mock("../services/trainingApiClient", () => ({
  trainingApiEnabled: true,
  buildTrainingLivePulseStreamUrl: mocks.buildTrainingLivePulseStreamUrl,
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

import {
  __ensureLivePulseSubscriptionsForTests,
  __resetRuntimeTrainingTransportStateForTests,
  deriveUnifiedVisibleTrainingState,
  mergeActiveJobTruth,
  resolveVisibleActiveStatus,
  useRuntimeTrainingStore,
} from "./useRuntimeTrainingStore";

describe("useRuntimeTrainingStore transport ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRuntimeTrainingTransportStateForTests();
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

  it("keeps cancelling active for live-pulse subscription and visible-state derivation", async () => {
    const createdUrls: string[] = [];
    const previousEventSource = globalThis.EventSource;
    class FakeEventSource {
      constructor(url: string) {
        createdUrls.push(url);
      }
      addEventListener() {}
      close() {}
    }

    try {
      (globalThis as typeof globalThis & { EventSource?: typeof EventSource }).EventSource = FakeEventSource as never;
      mocks.buildTrainingLivePulseStreamUrl.mockImplementation((jobId: string) => `/stream/${jobId}`);
      mocks.listTrainingJobsRemote.mockResolvedValueOnce([
        {
          id: "job-cancelling",
          tenantId: "tenant-a",
          status: "cancelling",
          liveTelemetrySummary: {
            crossSurfaceTruthSummary: {
              stopHandshakeSummary: {
                cancelRequested: true,
                shutdownRequested: true,
                processAlive: true,
              },
            },
          },
        } as never,
      ]);
      useRuntimeTrainingStore.setState({
        jobs: [
          {
            id: "job-cancelling",
            tenantId: "tenant-a",
            status: "cancelling",
            lifecycleStatus: "cancelling",
            updatedAt: Date.now(),
            liveTelemetrySummary: {
              crossSurfaceTruthSummary: {
                stopHandshakeSummary: {
                  cancelRequested: true,
                  shutdownRequested: true,
                  processAlive: true,
                },
              },
            },
          } as never,
        ],
      });

      __ensureLivePulseSubscriptionsForTests(useRuntimeTrainingStore.getState().jobs);

      expect(createdUrls).toEqual(["/stream/job-cancelling"]);
      expect(
        mergeActiveJobTruth(
          {
            id: "job-cancelling",
            status: "running",
            tenantId: "tenant-a",
            updatedAt: Date.now(),
          } as never,
          {
            id: "job-cancelling",
            status: "failed",
            tenantId: "tenant-a",
            updatedAt: Date.now(),
            liveTelemetrySummary: {
              crossSurfaceTruthSummary: {
                stopHandshakeSummary: {
                  cancelRequested: true,
                  shutdownRequested: true,
                  processAlive: true,
                },
              },
            },
          } as never,
          {
            crossSurfaceTruthSummary: {
              stopHandshakeSummary: {
                cancelRequested: true,
                shutdownRequested: true,
                processAlive: true,
              },
            },
          } as never
        ).status
      ).toBe("cancelling");
      expect(
        resolveVisibleActiveStatus(
          {
            id: "job-health",
            status: "running",
            tenantId: "tenant-a",
          } as never,
          {
            id: "job-health",
            status: "failed",
            tenantId: "tenant-a",
            liveTelemetrySummary: {
              crossSurfaceTruthSummary: {
                processAlive: true,
              },
              runtimeHealthSummary: {
                healthEvaluationStage: "blocked",
              },
            },
          } as never,
          {
            crossSurfaceTruthSummary: {
              processAlive: true,
            },
            runtimeHealthSummary: {
              healthEvaluationStage: "blocked",
            },
          } as never
        )
      ).toBe("queued");
      expect(
        resolveVisibleActiveStatus(
          {
            id: "job-health",
            status: "failed",
            tenantId: "tenant-a",
          } as never,
          {
            id: "job-health",
            status: "failed",
            tenantId: "tenant-a",
            liveTelemetrySummary: {
              failFastRequested: true,
              crossSurfaceTruthSummary: {
                processAlive: false,
                shutdownRequested: true,
                processExitObservedAt: "2026-04-20T00:00:02.000Z",
              },
              runtimeHealthSummary: {
                healthEvaluationStage: "blocked",
              },
            },
          } as never,
          {
            failFastRequested: true,
            crossSurfaceTruthSummary: {
              processAlive: false,
              shutdownRequested: true,
              processExitObservedAt: "2026-04-20T00:00:02.000Z",
            },
            runtimeHealthSummary: {
              healthEvaluationStage: "blocked",
            },
          } as never
        )
      ).toBe("cancelling");
  } finally {
      (globalThis as typeof globalThis & { EventSource?: typeof EventSource }).EventSource = previousEventSource as never;
    }
  });

  it("prefers durable canonical metric rows over stale live overlay rows", () => {
    const visible = deriveUnifiedVisibleTrainingState(
      {
        id: "job-visible",
        tenantId: "tenant-a",
        status: "running",
        maxSteps: 100,
        metricsIngestionSummary: {
          acceptedCount: 1,
          lastAcceptedStep: 42,
          latestMetricRows: [
            {
              trainerIteration: 42,
              metricStep: 42,
              occurredAt: "2026-04-20T00:00:00.000Z",
              source: "durable_metric_rows",
              rewardMean: 3.5,
            },
          ],
        },
        liveTelemetrySummary: {
          latestLivePulseIteration: 18,
          latestLivePulseProgressRatio: 0.18,
          currentFailureSource: "RUNTIME_LAUNCH_GATE_ALLOWED",
        },
        progressSummary: {
          trainingProgress: { current: 18, total: 100, ratio: 0.18, source: "live_overlay" },
        },
      } as never,
      [
        {
          trainerIteration: 18,
          metricStep: 18,
          occurredAt: "2026-04-20T00:00:01.000Z",
          source: "live_overlay",
          rewardMean: 1.0,
        } as never,
      ]
    );

    expect(visible.visibleMetricSummarySource).toBe("accepted_canonical_metrics");
    expect(visible.visibleChartSource).toBe("accepted_canonical_metrics");
    expect(visible.visibleProgressSource).toBe("accepted_canonical_metrics");
    expect(visible.visibleIteration).toBe(42);
  });

  it("keeps visible iteration keyed by trainerIteration instead of canonical row count", () => {
    const rows = [
      {
        trainerIteration: 0,
        metricStep: 0,
        occurredAt: "2026-04-22T00:00:00Z",
        progressRatio: 0,
        source: "durable_metric_rows",
        sourceMarker: "batch-0",
        episodeIndex: 0,
        rewardMean: 1.0,
        episodeLengthMean: null,
        loss: null,
        fps: null,
      },
      {
        trainerIteration: 6,
        metricStep: 6,
        occurredAt: "2026-04-22T00:00:01Z",
        progressRatio: 6 / 1024,
        source: "durable_metric_rows",
        sourceMarker: "batch-6",
        episodeIndex: 6,
        rewardMean: 1.5,
        episodeLengthMean: null,
        loss: null,
        fps: null,
      },
      {
        trainerIteration: 12,
        metricStep: 12,
        occurredAt: "2026-04-22T00:00:02Z",
        progressRatio: 12 / 1024,
        source: "durable_metric_rows",
        sourceMarker: "batch-12",
        episodeIndex: 12,
        rewardMean: 2.0,
        episodeLengthMean: null,
        loss: null,
        fps: null,
      },
      {
        trainerIteration: 18,
        metricStep: 18,
        occurredAt: "2026-04-22T00:00:03Z",
        progressRatio: 18 / 1024,
        source: "durable_metric_rows",
        sourceMarker: "batch-18",
        episodeIndex: 18,
        rewardMean: 2.5,
        episodeLengthMean: null,
        loss: null,
        fps: null,
      },
    ] as never[];

    const visible = deriveUnifiedVisibleTrainingState(
      {
        id: "job-iteration-identity",
        tenantId: "tenant-a",
        status: "running",
        maxSteps: 1024,
        currentEpoch: 4,
        progressSummary: {
          trainingProgress: {
            current: 4,
            total: 1024,
            ratio: 4 / 1024,
            source: "job.current_epoch/job.max_steps",
          },
        },
        metricsIngestionSummary: {
          acceptedCount: 4,
          lastAcceptedStep: 18,
          latestMetrics: {
            rewardMean: 2.5,
          },
          latestMetricRows: rows,
          recentMetricRows: rows,
        },
        liveTelemetrySummary: {
          latestLivePulseIteration: 18,
          latestAcceptedMetricIteration: 18,
        },
      } as never,
      rows
    );

    expect(visible.visibleIteration).toBe(18);
    expect(visible.chartRowsLength).toBe(4);
    expect(visible.mergedMetricHistoryLength).toBe(4);
    expect(visible.visibleMetricSummarySource).toBe("durable_metric_rows");
  });

  it("repairs stale zero progress scalars from the API shape before rendering", () => {
    const visible = deriveUnifiedVisibleTrainingState(
      {
        id: "job-progress-fallback",
        tenantId: "tenant-a",
        status: "running",
        maxSteps: 100,
        currentEpoch: 96,
        progressSummary: {
          trainingProgress: {
            current: 0,
            total: 100,
            ratio: 0,
            source: "job.current_epoch/job.max_steps",
          },
          iterationProgress: {
            current: 0,
            total: 100,
            ratio: 0,
            source: "live_pulse.metricStep",
          },
        },
        metricsTruth: {
          apiVisibleIteration: 96,
          apiVisibleIterationSource: "runner_live_pulse",
          apiVisibleProgressRatio: 0.96,
        },
        liveTelemetrySummary: {
          latestLivePulseIteration: 96,
          latestLivePulseProgressRatio: 0.96,
          metricsTruth: {
            apiVisibleIteration: 96,
            apiVisibleIterationSource: "runner_live_pulse",
          },
        },
      } as never,
      []
    );

    expect(visible.visibleIteration).toBe(96);
    expect(visible.visibleProgressRatio).toBe(0.96);
    expect(visible.persistedProgressIteration).toBe(96);
    expect(visible.visibleProgressSource).toBe("job.current_epoch/job.max_steps");
  });
});
