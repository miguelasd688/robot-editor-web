import { describe, expect, it } from "vitest";
import { resolveTaskTemplateCatalogEntry } from "@runtime-plugins/catalog";
import { resolveTrainingProfileMetadata as resolveCatalogProfileMetadata } from "@runtime-plugins/catalog/profiles";
import { resolveProfileIdForTaskTemplate, resolveTrainingProfileMetadata } from "./profiles";

describe("training profile metadata", () => {
  it("maps task templates to canonical sample profile metadata", () => {
    const template = resolveTaskTemplateCatalogEntry({ taskTemplate: "ant_manager" });
    const metadata = resolveTrainingProfileMetadata(template, "rsl_rl_ppo");
    const catalogMetadata = resolveCatalogProfileMetadata(template, "rsl_rl_ppo");

    expect(resolveProfileIdForTaskTemplate(template)).toBe("ant");
    expect(metadata.profileId).toBe("ant");
    expect(metadata.baseTaskId).toBe("isaaclab.ant.manager.v1");
    expect(metadata.displayName).toBe("Ant");
    expect(metadata.agentPresetId).toBe("rsl_rl_ppo");
    expect(catalogMetadata.profileId).toBe(metadata.profileId);
    expect(catalogMetadata.baseTaskId).toBe(metadata.baseTaskId);
  });
});
