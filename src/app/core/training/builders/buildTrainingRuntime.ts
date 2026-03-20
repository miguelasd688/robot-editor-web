import type { CustomTrainingRuntimePayload } from "./trainingRequestTypes";
import {
  normalizeAssetPipelineOrUndefined,
  toNonNegativeIntOrUndefined,
  toObjectOrEmpty,
  toPositiveIntOrUndefined,
  toStringArrayOrUndefined,
  toTextOrEmpty,
} from "./trainingBuildUtils";

export function buildTrainingRuntime(input: {
  maxSteps: number;
  configValues: Record<string, unknown>;
}): CustomTrainingRuntimePayload {
  const previewValues = toObjectOrEmpty(input.configValues.preview);
  return {
    backend: "isaac_lab",
    maxSteps: Math.max(1, Math.round(input.maxSteps)),
    numEnvs: toPositiveIntOrUndefined(input.configValues.numEnvs),
    checkpoint: toNonNegativeIntOrUndefined(input.configValues.checkpoint),
    stepsPerEpoch: toPositiveIntOrUndefined(input.configValues.stepsPerEpoch),
    videoLengthSec:
      toPositiveIntOrUndefined(previewValues.videoLengthSec) ??
      toPositiveIntOrUndefined(input.configValues.videoLengthSec),
    videoLengthMs: toPositiveIntOrUndefined(previewValues.videoLengthMs),
    videoLength: toPositiveIntOrUndefined(previewValues.videoLength),
    videoInterval: toPositiveIntOrUndefined(previewValues.videoInterval),
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
