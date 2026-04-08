import type { CustomTrainingRuntimePayload } from "./trainingRequestTypes";
import {
  normalizeAssetPipelineOrUndefined,
  toNonNegativeIntOrUndefined,
  toObjectOrEmpty,
  toPositiveIntOrUndefined,
  toStringArrayOrUndefined,
  toTextOrEmpty,
} from "./trainingBuildUtils";

function pickFirstDefinedValue(source: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const value = source[key];
      if (value !== undefined && value !== null && value !== "") return value;
    }
  }
  return undefined;
}

function toPositiveIntFromAliases(source: Record<string, unknown>, keys: string[]): number | undefined {
  return toPositiveIntOrUndefined(pickFirstDefinedValue(source, keys));
}

function toNonNegativeIntFromAliases(source: Record<string, unknown>, keys: string[]): number | undefined {
  return toNonNegativeIntOrUndefined(pickFirstDefinedValue(source, keys));
}

export function buildTrainingRuntime(input: {
  maxSteps: number;
  configValues: Record<string, unknown>;
}): CustomTrainingRuntimePayload {
  const previewValues = toObjectOrEmpty(input.configValues.preview);
  return {
    backend: "isaac_lab",
    maxSteps: Math.max(1, Math.round(input.maxSteps)),
    numEnvs: toPositiveIntFromAliases(input.configValues, ["numEnvs", "num_envs", "numEnv"]),
    checkpoint: toNonNegativeIntFromAliases(input.configValues, ["checkpoint"]),
    stepsPerEpoch: toPositiveIntFromAliases(input.configValues, ["stepsPerEpoch", "steps_per_epoch"]),
    videoLengthSec:
      toPositiveIntFromAliases(previewValues, ["videoLengthSec", "video_length_sec", "clipLengthSec", "clip_length_sec"]) ??
      toPositiveIntFromAliases(input.configValues, ["videoLengthSec", "video_length_sec", "clipLengthSec", "clip_length_sec"]),
    videoLengthMs: toPositiveIntFromAliases(previewValues, ["videoLengthMs", "video_length_ms"]),
    videoLength: toPositiveIntFromAliases(previewValues, ["videoLength", "video_length"]),
    videoInterval: toPositiveIntFromAliases(previewValues, ["videoInterval", "video_interval"]),
    baseConstraintMode:
      toTextOrEmpty(input.configValues.baseConstraintMode) === "fix_base"
        ? "fix_base"
        : toTextOrEmpty(input.configValues.baseConstraintMode) === "source_weld"
          ? "source_weld"
          : undefined,
    assetPipeline: normalizeAssetPipelineOrUndefined(input.configValues.assetPipeline),
    extraArgs: toStringArrayOrUndefined(input.configValues.extraArgs),
    recordingViews: toObjectOrEmpty(previewValues.recordingViews),
    overrides: toObjectOrEmpty(input.configValues.overrides),
  };
}
