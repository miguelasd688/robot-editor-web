import { describe, expect, it } from "vitest";
import { deriveVisibleMetricHistory } from "./metricHistory";

describe("metricHistory", () => {
  it("keeps merged canonical rows ordered by trainer iteration", () => {
    const rows = deriveVisibleMetricHistory([
      { trainerIteration: 5, metricStep: 5, occurredAt: "2026-04-22T00:00:00Z", progressRatio: 0.5, source: "live_overlay", sourceMarker: null, episodeIndex: 5, rewardMean: null, episodeLengthMean: null, loss: null, fps: null },
      { trainerIteration: 8, metricStep: 8, occurredAt: "2026-04-22T00:00:01Z", progressRatio: 0.8, source: "durable_metric_rows", sourceMarker: null, episodeIndex: 8, rewardMean: null, episodeLengthMean: null, loss: null, fps: null },
    ]);

    expect(rows[0]?.trainerIteration).toBe(5);
    expect(rows[1]?.trainerIteration).toBe(8);
  });
});
