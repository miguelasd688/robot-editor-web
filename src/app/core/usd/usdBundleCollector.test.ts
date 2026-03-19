import { describe, expect, it } from "vitest";
import { __testOnlyResolveBundleHintCandidates } from "./usdBundleCollector";

describe("usdBundleCollector hint resolution", () => {
  it("resolves UR10 legacy hints from sample root and entry-relative paths", () => {
    const entryPath = "library/robots/ur10/Legacy/ur10_long_suction.usd";
    const siblingHint = "configuration/grippers/short_suction.usd";
    const legacyHint = "Legacy/Props/Materials/Metal/ur10_materials.usda";

    const siblingCandidates = __testOnlyResolveBundleHintCandidates(entryPath, siblingHint);
    const legacyCandidates = __testOnlyResolveBundleHintCandidates(entryPath, legacyHint);

    expect(siblingCandidates).toContain("library/robots/ur10/configuration/grippers/short_suction.usd");
    expect(legacyCandidates).toContain("library/robots/ur10/Legacy/Props/Materials/Metal/ur10_materials.usda");
  });

  it("keeps absolute library hints stable for anymal and floors", () => {
    const anymalEntry = "library/robots/anymal_c/anymal_c.usd";
    const floorEntry = "library/floors/rough_terrain/rough_terrain.usda";
    const absoluteHint = "library/robots/anymal_c/Props/instanceable_meshes.usd";
    const floorAbsoluteHint = "library/floors/rough_terrain/rough_terrain.usda";

    const anymalCandidates = __testOnlyResolveBundleHintCandidates(anymalEntry, absoluteHint);
    const floorCandidates = __testOnlyResolveBundleHintCandidates(floorEntry, floorAbsoluteHint);

    expect(anymalCandidates[0]).toBe(absoluteHint);
    expect(floorCandidates[0]).toBe(floorAbsoluteHint);
  });
});
