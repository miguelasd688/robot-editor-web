export type UsdJointPosePolicy = "auto" | "prefer_frame_pair" | "prefer_mjcf";
export type UsdJointPoseSource = "frame_pair" | "mjcf_body";

export type UsdJointPoseError = {
  positionErrorM: number;
  rotationErrorRad: number;
  score: number;
};

export type UsdJointPoseDecisionInput = {
  policy: UsdJointPosePolicy;
  hasFramePair: boolean;
  framePairMismatchOk: boolean;
  meshReferenceAvailable: boolean;
  framePairErrorToMesh: UsdJointPoseError | null;
  mjcfErrorToMesh: UsdJointPoseError | null;
  severePositionThresholdM?: number;
  severeRotationThresholdRad?: number;
  scoreMargin?: number;
};

export type UsdJointPoseDecision = {
  source: UsdJointPoseSource;
  reason:
    | "no_frame_pair"
    | "policy_prefer_mjcf"
    | "policy_prefer_frame_pair"
    | "frame_pair_mismatch"
    | "auto_keep_frame_pair"
    | "auto_mesh_evidence_mjcf";
  switchedFromFramePair: boolean;
  usedMeshEvidence: boolean;
};

const DEFAULT_SEVERE_POSITION_THRESHOLD_M = 0.08;
const DEFAULT_SEVERE_ROTATION_THRESHOLD_RAD = 0.75;
const DEFAULT_SCORE_MARGIN = 0.05;
const ROTATION_WEIGHT = 0.25;

export function computePoseErrorScore(positionErrorM: number, rotationErrorRad: number): number {
  const safePosition = Number.isFinite(positionErrorM) ? Math.max(0, positionErrorM) : Number.POSITIVE_INFINITY;
  const safeRotation = Number.isFinite(rotationErrorRad) ? Math.max(0, rotationErrorRad) : Number.POSITIVE_INFINITY;
  return safePosition + safeRotation * ROTATION_WEIGHT;
}

export function buildJointPoseError(positionErrorM: number, rotationErrorRad: number): UsdJointPoseError {
  return {
    positionErrorM,
    rotationErrorRad,
    score: computePoseErrorScore(positionErrorM, rotationErrorRad),
  };
}

export function chooseUsdJointPoseSource(input: UsdJointPoseDecisionInput): UsdJointPoseDecision {
  const severePositionThresholdM = Number.isFinite(input.severePositionThresholdM)
    ? Math.max(0, Number(input.severePositionThresholdM))
    : DEFAULT_SEVERE_POSITION_THRESHOLD_M;
  const severeRotationThresholdRad = Number.isFinite(input.severeRotationThresholdRad)
    ? Math.max(0, Number(input.severeRotationThresholdRad))
    : DEFAULT_SEVERE_ROTATION_THRESHOLD_RAD;
  const scoreMargin = Number.isFinite(input.scoreMargin)
    ? Math.max(0, Number(input.scoreMargin))
    : DEFAULT_SCORE_MARGIN;

  if (!input.hasFramePair) {
    return {
      source: "mjcf_body",
      reason: "no_frame_pair",
      switchedFromFramePair: false,
      usedMeshEvidence: false,
    };
  }

  if (input.policy === "prefer_mjcf") {
    return {
      source: "mjcf_body",
      reason: "policy_prefer_mjcf",
      switchedFromFramePair: true,
      usedMeshEvidence: false,
    };
  }

  if (!input.framePairMismatchOk) {
    return {
      source: "mjcf_body",
      reason: "frame_pair_mismatch",
      switchedFromFramePair: true,
      usedMeshEvidence: false,
    };
  }

  if (input.policy === "prefer_frame_pair") {
    return {
      source: "frame_pair",
      reason: "policy_prefer_frame_pair",
      switchedFromFramePair: false,
      usedMeshEvidence: false,
    };
  }

  if (
    input.meshReferenceAvailable &&
    input.framePairErrorToMesh &&
    input.mjcfErrorToMesh &&
    Number.isFinite(input.framePairErrorToMesh.score) &&
    Number.isFinite(input.mjcfErrorToMesh.score)
  ) {
    const severeFrameDivergence =
      input.framePairErrorToMesh.positionErrorM >= severePositionThresholdM ||
      input.framePairErrorToMesh.rotationErrorRad >= severeRotationThresholdRad;
    const mjcfWins = input.mjcfErrorToMesh.score + scoreMargin < input.framePairErrorToMesh.score;
    if (severeFrameDivergence && mjcfWins) {
      return {
        source: "mjcf_body",
        reason: "auto_mesh_evidence_mjcf",
        switchedFromFramePair: true,
        usedMeshEvidence: true,
      };
    }
  }

  return {
    source: "frame_pair",
    reason: "auto_keep_frame_pair",
    switchedFromFramePair: false,
    usedMeshEvidence: Boolean(input.meshReferenceAvailable),
  };
}

