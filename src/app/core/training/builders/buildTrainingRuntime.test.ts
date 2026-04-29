import { describe, expect, it } from "vitest";

import { buildTrainingRuntime } from "./buildTrainingRuntime";

describe("buildTrainingRuntime", () => {
  it("maps alias config values to canonical runtime payload fields", () => {
    const runtime = buildTrainingRuntime({
      maxSteps: 128,
      configValues: {
        numEnv: 24,
        checkpoint: 3,
        steps_per_epoch: 16,
        baseConstraintMode: "source_weld",
        assetPipeline: { mode: "mjcf_conversion", reason: "alias test" },
        extraArgs: ["--foo", "--bar"],
        overrides: { headless: true },
        preview: {
          video_length_sec: 7,
          video_length_ms: 7000,
          video_length: 21,
          clip_interval_episodes: 13,
          video_interval: 12,
          recordingViews: {
            views: {
              global: {
                camera: {
                  eye: [1, 2, 3],
                  lookat: [4, 5, 6],
                },
              },
            },
          },
        },
      },
    });

    expect(runtime).toMatchObject({
      backend: "isaac_lab",
      maxSteps: 128,
      numEnvs: 24,
      checkpoint: 3,
      stepsPerEpoch: 16,
      videoLengthSec: 7,
      videoLengthMs: 7000,
      videoLength: 21,
      clipIntervalEpisodes: 13,
      videoInterval: 12,
      baseConstraintMode: "source_weld",
      assetPipeline: { mode: "mjcf_conversion", reason: "alias test" },
      extraArgs: ["--foo", "--bar"],
      overrides: { headless: true },
    });
    expect(runtime.recordingViews).toEqual({
      views: {
        global: {
          camera: {
            eye: [1, 2, 3],
            lookat: [4, 5, 6],
          },
        },
      },
    });
  });

  it("keeps unedited recording display defaults out of user override aliases", () => {
    const runtime = buildTrainingRuntime({
      maxSteps: 128,
      configValues: {
        recording: {
          clipLengthSec: 5,
          clipIntervalIterations: 92,
          clipLengthEdited: false,
          clipIntervalEdited: false,
          displayNumStepsPerEnv: 24,
          displayVideoIntervalSteps: 2208,
        },
      },
    });

    expect(runtime.recording).toMatchObject({
      displayClipLengthSec: 5,
      displayClipIntervalIterations: 92,
      displayNumStepsPerEnv: 24,
      displayVideoIntervalSteps: 2208,
    });
    expect(runtime.videoLengthSec).toBeUndefined();
    expect(runtime.clipIntervalEpisodes).toBeUndefined();
    expect(runtime.recording?.requestedClipLengthSec).toBeUndefined();
    expect(runtime.recording?.requestedClipIntervalIterations).toBeUndefined();
  });

  it("serializes edited recording interval as explicit requested intent", () => {
    const runtime = buildTrainingRuntime({
      maxSteps: 128,
      configValues: {
        recording: {
          clipLengthSec: 5,
          clipIntervalIterations: 50,
          clipLengthEdited: false,
          clipIntervalEdited: true,
          displayNumStepsPerEnv: 24,
        },
      },
    });

    expect(runtime.recording?.requestedClipIntervalIterations).toBe(50);
    expect(runtime.clipIntervalEpisodes).toBe(50);
  });
});
