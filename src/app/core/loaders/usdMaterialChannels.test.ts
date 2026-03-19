import { describe, expect, it } from "vitest";
import { __testOnlyHasMaterialChannelIntent } from "./usdLoader";

describe("usd material channel intent", () => {
  it("honors explicit bindings even without filename hints", () => {
    const sources = {
      baseColor: null,
      normal: "explicit",
      metallic: null,
      roughness: null,
      metallicRoughness: null,
      occlusion: null,
      emissive: null,
      opacity: null,
    } as const;

    expect(__testOnlyHasMaterialChannelIntent("normal", "Textures/gripper_aux.png", sources)).toBe(true);
  });

  it("keeps heuristic guards for generic fallback channels", () => {
    const sources = {
      baseColor: null,
      normal: "generic_fallback",
      metallic: null,
      roughness: null,
      metallicRoughness: null,
      occlusion: null,
      emissive: null,
      opacity: null,
    } as const;

    expect(__testOnlyHasMaterialChannelIntent("normal", "Textures/gripper_aux.png", sources)).toBe(false);
    expect(__testOnlyHasMaterialChannelIntent("normal", "Textures/gripper_normal.png", sources)).toBe(true);
  });
});
