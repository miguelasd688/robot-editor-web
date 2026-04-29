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
  const clipLengthSec = toPositiveIntFromAliases(recording, ["clipLengthSec", "displayClipLengthSec"]);
  const clipIntervalIterations = toPositiveIntFromAliases(recording, [
    "clipIntervalIterations",
    "displayClipIntervalIterations",
  ]);
  if (clipLengthSec === undefined && clipIntervalIterations === undefined) return undefined;
  const displayNumStepsPerEnv = toPositiveIntFromAliases(recording, ["displayNumStepsPerEnv", "numStepsPerEnv"]);
  return {
    clipLengthSec,
    clipIntervalIterations,
    displayNumStepsPerEnv,
    displayVideoIntervalSteps:
      toPositiveIntFromAliases(recording, ["displayVideoIntervalSteps", "videoIntervalSteps"]) ??
      (clipIntervalIterations !== undefined && displayNumStepsPerEnv !== undefined
        ? clipIntervalIterations * displayNumStepsPerEnv
        : undefined),
    clipLengthEdited: recording.clipLengthEdited === true,
    clipIntervalEdited: recording.clipIntervalEdited === true,
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
      recording && recording.clipLengthSec !== undefined && recording.clipIntervalIterations !== undefined
        ? {
            displayClipLengthSec: recording.clipLengthSec,
            displayClipIntervalIterations: recording.clipIntervalIterations,
            displayNumStepsPerEnv: recording.displayNumStepsPerEnv,
            displayVideoIntervalSteps: recording.displayVideoIntervalSteps,
            requestedClipLengthSec,
            requestedClipIntervalIterations,
          }
        : undefined,
    videoLengthSec:
      requestedClipLengthSec ??
      toPositiveIntFromAliases(previewValues, ["videoLengthSec", "video_length_sec", "clipLengthSec", "clip_length_sec"]) ??
      toPositiveIntFromAliases(input.configValues, ["videoLengthSec", "video_length_sec", "clipLengthSec", "clip_length_sec"]),
    videoLengthMs: toPositiveIntFromAliases(previewValues, ["videoLengthMs", "video_length_ms"]),
    videoLength: toPositiveIntFromAliases(previewValues, ["videoLength", "video_length"]),
    clipIntervalEpisodes:
      requestedClipIntervalIterations ??
      toPositiveIntFromAliases(previewValues, [
        "clipIntervalEpisodes",
        "clip_interval_episodes",
        "clipIntervalTrainerIterations",
      ]) ?? toPositiveIntFromAliases(input.configValues, ["clipIntervalEpisodes", "clip_interval_episodes"]),
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
