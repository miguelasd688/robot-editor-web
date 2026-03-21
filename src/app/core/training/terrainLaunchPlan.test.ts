/**
 * Tests for terrain launch plan computation.
 * Covers the ant_manager + default floor case (no scene asset → template_default).
 */
import { describe, expect, it } from "vitest";
import {
  computeTerrainLaunchPlan,
  terrainLaunchReadiness,
  type TerrainLaunchPlan,
} from "../../../../../runtime-plugin-suite/src/training/terrainLaunchPlan";
import type { TaskTemplateCatalogEntry } from "../../../../../runtime-plugin-suite/src/catalog/types";

function makeTemplate(overrides: Partial<{
  sceneInjectionMode: string;
  runtimeWorldUsdOverridePath: string;
  runtimeOverlay: boolean;
}>): TaskTemplateCatalogEntry {
  return {
    id: "test.template.v1",
    title: "Test Template",
    description: "Test",
    executionMode: "manager",
    recipeId: "test.template.v1",
    taskTemplate: "test_manager",
    task: "Isaac-Test-v0",
    defaults: {
      training: { numEnvs: 64, maxSteps: 1024, stepsPerEpoch: 24, clipLengthSec: 4, checkpoint: 0, videoInterval: 100 },
      environment: { controlMode: "effort", observables: [], actions: [], resets: [] },
      policy: { agent: { trainer: "rsl_rl", algorithm: "ppo", preset: "rsl_rl_ppo" }, rules: [] },
      launch: {
        extraArgs: [],
        stepsPerEnvHydraKey: "agent.num_steps_per_env",
        sceneInjectionMode: (overrides.sceneInjectionMode ?? "world_overlay") as "world_overlay" | "none" | "terrain_usd_hook",
        runtimeWorldUsdOverridePath: overrides.runtimeWorldUsdOverridePath ?? "env.scene.world.usd_path",
      },
    },
    runtimeRequirements: {
      managerMode: "manager",
      robotRequired: true,
      terrainRequired: "optional",
      requiredManagerGroups: {
        observationManagers: { required: true },
        actionManagers: { required: true },
        commandManagers: { required: false },
        rewardManagers: { required: true },
        eventManagers: { required: true },
        curriculumManagers: { required: false },
      },
      sceneSupport: {
        usdPassthrough: true,
        mjcfConvertedRobot: true,
        customSceneAssets: true,
        runtimeOverlay: overrides.runtimeOverlay ?? true,
      },
    },
  };
}

describe("computeTerrainLaunchPlan", () => {
  describe("template_default: no scene asset", () => {
    it("returns template_default when sceneAssetId is empty", () => {
      const template = makeTemplate({});
      const plan = computeTerrainLaunchPlan({ sceneAssetId: "", template });
      expect(plan.strategy).toBe("template_default");
      expect(plan.reasonCode).toBe("no_scene_asset");
      expect(plan.warningMessage).toBeTruthy();
      expect(plan.blockerMessage).toBeUndefined();
    });

    it("ant_manager + default floor (plane) → template_default", () => {
      // Simulates Ant + default flat floor. ant_manager has runtimeOverlay: false.
      const antTemplate = makeTemplate({
        sceneInjectionMode: "world_overlay",
        runtimeWorldUsdOverridePath: "env.scene.world.usd_path",
        runtimeOverlay: false,
      });
      // No scene asset uploaded (terrainMode = plane → terrainAssetId = "")
      const plan = computeTerrainLaunchPlan({ sceneAssetId: "", template: antTemplate });
      expect(plan.strategy).toBe("template_default");
    });
  });

  describe("runtime_world_overlay: scene asset + overlay support", () => {
    it("returns runtime_world_overlay when scene asset + overlay configured + template supports it", () => {
      const template = makeTemplate({ runtimeOverlay: true });
      const plan = computeTerrainLaunchPlan({ sceneAssetId: "scene_asset_123", template });
      expect(plan.strategy).toBe("runtime_world_overlay");
      expect(plan.overlayAssetId).toBe("scene_asset_123");
    });
  });

  describe("blocked: scene asset but no overlay support", () => {
    it("returns blocked when template runtimeOverlay is false but scene asset present", () => {
      const template = makeTemplate({ runtimeOverlay: false });
      const plan = computeTerrainLaunchPlan({ sceneAssetId: "scene_asset_abc", template });
      expect(plan.strategy).toBe("blocked");
      expect(plan.blockerMessage).toBeTruthy();
    });

    it("returns blocked when template has no runtimeWorldUsdOverridePath but scene asset present", () => {
      const template = makeTemplate({ runtimeWorldUsdOverridePath: "", runtimeOverlay: true });
      const plan = computeTerrainLaunchPlan({ sceneAssetId: "scene_asset_abc", template });
      expect(plan.strategy).toBe("blocked");
    });

    it("returns blocked when sceneInjectionMode is not world_overlay but scene asset present", () => {
      const template = makeTemplate({ sceneInjectionMode: "none", runtimeOverlay: true });
      const plan = computeTerrainLaunchPlan({ sceneAssetId: "scene_asset_abc", template });
      expect(plan.strategy).toBe("blocked");
    });
  });
});

describe("terrainLaunchReadiness", () => {
  it("launchable for runtime_world_overlay", () => {
    const plan: TerrainLaunchPlan = { strategy: "runtime_world_overlay", reasonCode: "scene_asset_with_overlay" };
    expect(terrainLaunchReadiness(plan)).toBe("launchable");
  });

  it("launchable_with_warning for template_default", () => {
    const plan: TerrainLaunchPlan = { strategy: "template_default", reasonCode: "no_scene_asset", warningMessage: "..." };
    expect(terrainLaunchReadiness(plan)).toBe("launchable_with_warning");
  });

  it("blocked for blocked strategy", () => {
    const plan: TerrainLaunchPlan = { strategy: "blocked", reasonCode: "template_no_overlay_support", blockerMessage: "..." };
    expect(terrainLaunchReadiness(plan)).toBe("blocked");
  });
});
