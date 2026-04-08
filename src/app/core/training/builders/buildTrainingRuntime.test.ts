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
});
