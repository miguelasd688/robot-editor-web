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

function pickRecordingValues(source: Record<string, unknown>): {
  clipLengthSec?: number;
  clipIntervalIterations?: number;
  displayNumStepsPerEnv?: number;
  displayVideoIntervalSteps?: number;
  clipLengthEdited: boolean;
  clipIntervalEdited: boolean;
} | undefined {
  const recording = toObjectOrEmpty(source.recording);
  const preview = toObjectOrEmpty(source.preview);
  const hasRequestedClipLength =
    Object.prototype.hasOwnProperty.call(recording, "requestedClipLengthSec") ||
    Object.prototype.hasOwnProperty.call(recording, "requested_clip_length_sec") ||
    Object.prototype.hasOwnProperty.call(source, "requestedClipLengthSec") ||
    Object.prototype.hasOwnProperty.call(source, "requested_clip_length_sec") ||
    Object.prototype.hasOwnProperty.call(preview, "requestedClipLengthSec");
  const hasRequestedClipInterval =
    Object.prototype.hasOwnProperty.call(recording, "requestedClipIntervalIterations") ||
    Object.prototype.hasOwnProperty.call(recording, "requested_clip_interval_iterations") ||
    Object.prototype.hasOwnProperty.call(source, "requestedClipIntervalIterations") ||
    Object.prototype.hasOwnProperty.call(source, "requested_clip_interval_iterations") ||
    Object.prototype.hasOwnProperty.call(preview, "requestedClipIntervalIterations");
  const clipLengthEdited =
    recording.clipLengthEdited === true ||
    recording.clip_length_edited === true ||
    source.clipLengthEdited === true ||
    source.clip_length_edited === true ||
    preview.clipLengthEdited === true ||
    preview.clip_length_edited === true ||
    hasRequestedClipLength;
  const clipIntervalEdited =
    recording.clipIntervalEdited === true ||
    recording.clip_interval_edited === true ||
    source.clipIntervalEdited === true ||
    source.clip_interval_edited === true ||
    preview.clipIntervalEdited === true ||
    preview.clip_interval_edited === true ||
    hasRequestedClipInterval;
  const clipLengthSec =
    toPositiveIntFromAliases(recording, [
      "requestedClipLengthSec",
      "requested_clip_length_sec",
      "clipLengthSec",
      "clip_length_sec",
      "displayClipLengthSec",
      "display_clip_length_sec",
    ]) ??
    toPositiveIntFromAliases(source, [
      "requestedClipLengthSec",
      "requested_clip_length_sec",
      "clipLengthSec",
      "clip_length_sec",
      "videoLengthSec",
      "video_length_sec",
      "videoLength",
      "video_length",
    ]);
  const clipIntervalIterations =
    toPositiveIntFromAliases(recording, [
      "requestedClipIntervalIterations",
      "requested_clip_interval_iterations",
      "clipIntervalIterations",
      "clip_interval_iterations",
      "displayClipIntervalIterations",
      "display_clip_interval_iterations",
      "clipIntervalTrainerIterations",
      "clip_interval_trainer_iterations",
      "clipIntervalEpisodes",
      "clip_interval_episodes",
    ]) ??
    toPositiveIntFromAliases(source, [
      "requestedClipIntervalIterations",
      "requested_clip_interval_iterations",
      "clipIntervalIterations",
      "clip_interval_iterations",
      "clipIntervalTrainerIterations",
      "clip_interval_trainer_iterations",
      "clipIntervalEpisodes",
      "clip_interval_episodes",
    ]) ??
    toPositiveIntFromAliases(preview, [
      "requestedClipIntervalIterations",
      "requested_clip_interval_iterations",
      "clipIntervalIterations",
      "clip_interval_iterations",
      "displayClipIntervalIterations",
      "display_clip_interval_iterations",
      "clipIntervalTrainerIterations",
      "clip_interval_trainer_iterations",
      "clipIntervalEpisodes",
      "clip_interval_episodes",
    ]);
  const displayNumStepsPerEnv =
    toPositiveIntFromAliases(recording, [
      "displayNumStepsPerEnv",
      "display_num_steps_per_env",
      "numStepsPerEnv",
      "num_steps_per_env",
    ]) ??
    toPositiveIntFromAliases(source, ["stepsPerEpoch", "steps_per_epoch"]);
  if (
    clipLengthSec === undefined &&
    clipIntervalIterations === undefined &&
    displayNumStepsPerEnv === undefined &&
    !Object.prototype.hasOwnProperty.call(recording, "clipLengthEdited") &&
    !Object.prototype.hasOwnProperty.call(recording, "clip_length_edited") &&
    !Object.prototype.hasOwnProperty.call(recording, "clipIntervalEdited") &&
    !Object.prototype.hasOwnProperty.call(recording, "clip_interval_edited") &&
    !hasRequestedClipLength &&
    !hasRequestedClipInterval
  ) {
    return undefined;
  }
  return {
    clipLengthSec,
    clipIntervalIterations,
    displayNumStepsPerEnv,
    displayVideoIntervalSteps:
      toPositiveIntFromAliases(recording, ["displayVideoIntervalSteps", "videoIntervalSteps"]) ??
      (clipIntervalIterations !== undefined && displayNumStepsPerEnv !== undefined
        ? clipIntervalIterations * displayNumStepsPerEnv
        : undefined),
    clipLengthEdited,
    clipIntervalEdited,
  };
}

export function buildTrainingRuntime(input: {
  maxSteps: number;
  configValues: Record<string, unknown>;
}): CustomTrainingRuntimePayload {
  const previewValues = toObjectOrEmpty(input.configValues.preview);
  const recording = pickRecordingValues(input.configValues);
  const requestedClipLengthSec =
    recording?.clipLengthEdited === true ? recording.clipLengthSec : undefined;
  const requestedClipIntervalIterations =
    recording?.clipIntervalEdited === true ? recording.clipIntervalIterations : undefined;
  return {
    backend: "isaac_lab",
    maxSteps: Math.max(1, Math.round(input.maxSteps)),
    numEnvs: toPositiveIntFromAliases(input.configValues, ["numEnvs", "num_envs", "numEnv"]),
    checkpoint: toNonNegativeIntFromAliases(input.configValues, ["checkpoint"]),
    stepsPerEpoch: toPositiveIntFromAliases(input.configValues, ["stepsPerEpoch", "steps_per_epoch"]),
    recording:
      recording
        ? {
            clipLengthSec: recording.clipLengthSec,
            clipIntervalIterations: recording.clipIntervalIterations,
            displayClipLengthSec: recording.clipLengthSec,
            displayClipIntervalIterations: recording.clipIntervalIterations,
            displayNumStepsPerEnv: recording.displayNumStepsPerEnv,
            displayVideoIntervalSteps: recording.displayVideoIntervalSteps,
            requestedClipLengthSec,
            requestedClipIntervalIterations,
            clipLengthEdited: recording.clipLengthEdited,
            clipIntervalEdited: recording.clipIntervalEdited,
          }
        : undefined,
    videoLengthSec: requestedClipLengthSec,
    videoLengthMs: toPositiveIntFromAliases(previewValues, ["videoLengthMs", "video_length_ms"]),
    videoLength: toPositiveIntFromAliases(previewValues, ["videoLength", "video_length"]),
    clipIntervalEpisodes: requestedClipIntervalIterations,
    clipLengthSec: recording?.clipLengthSec,
    clipIntervalIterations: recording?.clipIntervalIterations,
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
