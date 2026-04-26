import { describe, expect, it } from "vitest";
import { buildTrainingRecordingLatestUrl, parseTrainingRecordingSyncSseEvent } from "./trainingApiClient";

describe("parseTrainingRecordingSyncSseEvent", () => {
  it("parses valid recording_sync payloads", () => {
    const event = parseTrainingRecordingSyncSseEvent(
      JSON.stringify({
        eventType: "recording_sync",
        jobId: "job-1",
        runRef: "run-1",
        clipCount: 4,
        latestClipIndex: 4,
        visibleClipIndex: 3,
        latestVideoStep: 40,
        visibleVideoStep: 30,
        durableEpisodeIndex: 4,
        visibleEpisodeIndex: 3,
        clipSourceField: "sourceEpisodeIndex",
        views: [],
        availableViews: ["global"],
        missingViews: [],
        recordingVisible: true,
        recordingFinalized: false,
        jobTerminal: false,
        source: "runner_recording_watcher",
        occurredAt: "2026-04-24T00:00:00.000Z",
        signature: "sig-1",
      })
    );

    expect(event?.eventType).toBe("recording_sync");
    expect(event?.signature).toBe("sig-1");
  });

  it("returns null for malformed recording_sync payloads", () => {
    expect(parseTrainingRecordingSyncSseEvent("not-json")).toBeNull();
    expect(parseTrainingRecordingSyncSseEvent(JSON.stringify({ eventType: "live_pulse" }))).toBeNull();
  });

  it("builds latest recording urls from job id clip and view", () => {
    expect(buildTrainingRecordingLatestUrl("job-1", 2, "global")).toContain(
      "/v1/training/jobs/job-1/recording/latest?clipIndex=2&view=global"
    );
  });
});
