import { describe, expect, it } from "vitest";
import { compileEditorSceneContract } from "./editorScene";

function createEnvironment() {
  return {
    snapshot: {
      assets: {
        robot_asset: { id: "robot_asset", kind: "usd", role: "robot" },
        terrain_asset: { id: "terrain_asset", kind: "usd", role: "terrain" },
      },
      entities: {
        robot_root: {
          id: "robot_root",
          kind: "robot",
          sourceAssetId: "robot_asset",
          parentId: null,
          children: [],
        },
        terrain_floor: {
          id: "terrain_floor",
          kind: "terrain",
          sourceAssetId: "terrain_asset",
          parentId: null,
          children: [],
        },
      },
    },
    robotAssetId: "robot_asset",
    sceneAssetId: "scene_asset",
    placements: [
      {
        entityId: "robot_root",
        sourceAssetId: "robot_asset",
      },
    ],
    sourceHints: {
      assets: {
        robot_asset: { kind: "usd" },
        scene_asset: { kind: "usd" },
      },
    },
    resolvedLaunchPlan: {
      recipeId: "isaaclab.ant.manager.v1",
      envId: "Isaac-Ant-v0",
      terrainPlan: {
        strategy: "runtime_world_overlay",
        reasonCode: "scene_asset_with_overlay",
      },
      overlayPlan: {
        emitWorldUsdOverride: true,
      },
    },
    effectiveScenePolicy: {
      terrainStrategy: "runtime_world_overlay",
      sceneOwnership: "editor",
      sceneAssetAllowed: true,
      sceneAssetRequired: true,
      ignoreSceneAssetForLaunch: false,
      reasonCode: "scene_asset_with_overlay",
    },
    terrainMode: "usd",
    sceneTerrainType: "usd",
    sceneInjectionMode: "scene_driven",
    scenePreparation: {
      sceneAssetId: "scene_asset",
    },
    sourceOfTruth: "project_doc_environment_v1",
  };
}

describe("editor scene contract compilation", () => {
  it("summarizes the editor scene and launch policy", () => {
    const contract = compileEditorSceneContract({
      environment: createEnvironment(),
      profileId: "ant",
      baseTaskId: "isaaclab.ant.manager.v1",
      taskTemplate: "ant_manager",
      task: "Isaac-Ant-v0",
      generatedAt: "2026-03-22T00:00:00Z",
    });

    expect(contract.profileId).toBe("ant");
    expect(contract.baseTaskId).toBe("isaaclab.ant.manager.v1");
    expect(contract.robotAssetId).toBe("robot_asset");
    expect(contract.primaryRobot.assetId).toBe("robot_asset");
    expect(contract.primaryRobot.sourceKind).toBe("usd");
    expect(contract.sceneAssetId).toBe("scene_asset");
    expect(contract.placements).toHaveLength(1);
    expect(contract.sceneEntitiesSummary.entityCount).toBe(2);
    expect(contract.sceneEntitiesSummary.robotCount).toBe(1);
    expect(contract.sceneEntitiesSummary.terrainCount).toBe(1);
    expect(contract.sourceKinds.robot).toBe("usd");
    expect(contract.sourceKinds.scene).toBe("usd");
    expect(contract.sourcePipeline.placementSource).toBe("project_doc_environment_v1");
    expect(contract.sceneInjectionMode).toBe("scene_driven");
  });
});
