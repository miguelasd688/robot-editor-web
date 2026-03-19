import { describe, expect, it } from "vitest";
import { buildJointPoseError, chooseUsdJointPoseSource } from "./usdPosePolicy";

describe("usdPosePolicy", () => {
  it("keeps frame-pair when divergence is below thresholds", () => {
    const decision = chooseUsdJointPoseSource({
      policy: "auto",
      hasFramePair: true,
      framePairMismatchOk: true,
      meshReferenceAvailable: true,
      framePairErrorToMesh: buildJointPoseError(0.02, 0.1),
      mjcfErrorToMesh: buildJointPoseError(0.03, 0.15),
    });

    expect(decision.source).toBe("frame_pair");
    expect(decision.reason).toBe("auto_keep_frame_pair");
  });

  it("falls back to MJCF only for strongly divergent frame-pair joints", () => {
    const decision = chooseUsdJointPoseSource({
      policy: "auto",
      hasFramePair: true,
      framePairMismatchOk: true,
      meshReferenceAvailable: true,
      framePairErrorToMesh: buildJointPoseError(0.12, 1.1),
      mjcfErrorToMesh: buildJointPoseError(0.01, 0.1),
      severePositionThresholdM: 0.08,
      severeRotationThresholdRad: 0.75,
    });

    expect(decision.source).toBe("mjcf_body");
    expect(decision.reason).toBe("auto_mesh_evidence_mjcf");
    expect(decision.switchedFromFramePair).toBe(true);
  });
});
