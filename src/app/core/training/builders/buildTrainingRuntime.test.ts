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
      videoLengthSec: undefined,
      videoLengthMs: 7000,
      videoLength: 21,
      clipIntervalEpisodes: undefined,
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

    expect(runtime.recording).toMatchObject({
      clipLengthSec: 5,
      clipIntervalIterations: 50,
      displayClipLengthSec: 5,
      displayClipIntervalIterations: 50,
      displayNumStepsPerEnv: 24,
    });
    expect(runtime.recording?.requestedClipIntervalIterations).toBe(50);
    expect(runtime.clipIntervalEpisodes).toBe(50);
  });

  it("serializes edited clip length as explicit requested intent", () => {
    const runtime = buildTrainingRuntime({
      maxSteps: 128,
      configValues: {
        recording: {
          displayClipLengthSec: 2,
          displayClipIntervalIterations: 92,
          displayNumStepsPerEnv: 24,
          displayVideoIntervalSteps: 2208,
          clipLengthEdited: true,
          clipIntervalEdited: false,
          requestedClipLengthSec: 2,
        },
      },
    });

    expect(runtime.recording).toMatchObject({
      displayClipLengthSec: 2,
      displayClipIntervalIterations: 92,
      displayNumStepsPerEnv: 24,
      displayVideoIntervalSteps: 2208,
      requestedClipLengthSec: 2,
    });
    expect(runtime.videoLengthSec).toBe(2);
  });

  it("serializes edited recording interval from display aliases as explicit requested intent", () => {
    const runtime = buildTrainingRuntime({
      maxSteps: 128,
      configValues: {
        stepsPerEpoch: 48,
        recording: {
          displayClipIntervalIterations: 46,
          clipIntervalEdited: true,
          displayNumStepsPerEnv: 48,
          displayVideoIntervalSteps: 2208,
        },
      },
    });

    expect(runtime.recording).toMatchObject({
      clipIntervalIterations: 46,
      displayClipIntervalIterations: 46,
      displayNumStepsPerEnv: 48,
      displayVideoIntervalSteps: 2208,
      clipIntervalEdited: true,
      requestedClipIntervalIterations: 46,
    });
    expect(runtime.clipIntervalEpisodes).toBe(46);
  });

  it("serializes edited recording interval from snake_case aliases as explicit requested intent", () => {
    const runtime = buildTrainingRuntime({
      maxSteps: 128,
      configValues: {
        steps_per_epoch: 48,
        recording: {
          display_clip_interval_iterations: 46,
          clip_interval_edited: true,
          display_num_steps_per_env: 48,
          display_video_interval_steps: 2208,
        },
      },
    });

    expect(runtime.recording).toMatchObject({
      clipIntervalIterations: 46,
      displayClipIntervalIterations: 46,
      displayNumStepsPerEnv: 48,
      displayVideoIntervalSteps: 2208,
      clipIntervalEdited: true,
      requestedClipIntervalIterations: 46,
    });
    expect(runtime.clipIntervalEpisodes).toBe(46);
  });

  it("keeps the default clip interval as display-only until edited", () => {
    const runtime = buildTrainingRuntime({
      maxSteps: 128,
      configValues: {
        stepsPerEpoch: 48,
        recording: {
          clipIntervalIterations: 92,
          clipIntervalEdited: false,
          displayNumStepsPerEnv: 48,
          displayVideoIntervalSteps: 4416,
        },
      },
    });

    expect(runtime.recording).toMatchObject({
      clipIntervalIterations: 92,
      displayClipIntervalIterations: 92,
      displayNumStepsPerEnv: 48,
      displayVideoIntervalSteps: 4416,
      clipIntervalEdited: false,
    });
    expect(runtime.recording?.requestedClipIntervalIterations).toBeUndefined();
    expect(runtime.clipIntervalEpisodes).toBeUndefined();
  });
});
