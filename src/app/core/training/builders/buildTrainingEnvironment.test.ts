import { describe, expect, it } from "vitest";
import type { EnvironmentDoc } from "../../editor/document/types";
import type { SubmitTrainingJobInput } from "../../plugins/types";
import { buildTrainingEnvironment } from "./buildTrainingEnvironment";

function createSubmitInput(): SubmitTrainingJobInput {
  return {
    modelName: "custom-model",
    dataset: "custom-dataset",
    epochs: 256,
    envId: "custom_environment",
  };
}

function createEnvironmentSnapshot(): EnvironmentDoc {
  return {
    version: 1,
    assets: {
      robot_asset: {
        id: "robot_asset",
        kind: "usd",
        role: "robot",
        workspaceKey: "library/robots/ur10/Legacy/ur10.usd",
      },
      table_asset: {
        id: "table_asset",
        kind: "usd",
        role: "scene_asset",
        workspaceKey: "library/links/ur10_environment/Props/Mounts/SeattleLabTable/table_instanceable.usd",
      },
    },
    entities: {
      robot_root: {
        id: "robot_root",
        name: "Robot",
        kind: "robot",
        sourceRole: "robot",
        parentId: null,
        children: [],
        sourceAssetId: "robot_asset",
        transform: {
          position: { x: 1.2, y: 0.3, z: 0.4 },
          rotation: { x: 0, y: 0, z: 90 },
          scale: { x: 1, y: 1, z: 1 },
        },
      },
      scene_table: {
        id: "scene_table",
        name: "Table",
        kind: "scene_asset",
        sourceRole: "scene_asset",
        parentId: null,
        children: [],
        sourceAssetId: "table_asset",
        transform: {
          position: { x: 0.5, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
      },
    },
    roots: ["robot_root", "scene_table"],
    simulation: {
      gravity: [0, 0, -9.81],
      timestep: 0.002,
      substeps: 1,
      solver: "auto",
      contactModel: "auto",
    },
    diagnostics: [],
    updatedAt: new Date().toISOString(),
  };
}

describe("buildTrainingEnvironment", () => {
  it("preserves payload defaults and serializes placements with quaternion rotation", async () => {
    const snapshot = createEnvironmentSnapshot();
    const result = await buildTrainingEnvironment({
      submit: createSubmitInput(),
      configValues: {
        robotAssetId: "asset_robot_123",
        sceneAssetId: "asset_scene_456",
        environment: {
          sceneAssetId: "asset_scene_456",
        },
        userModelMetadata: {
          source: "test",
        },
      },
      compiledEnvironment: snapshot,
      compilationTarget: "training",
      compilationStats: { nodeCount: 2 },
      context: {
        robotUsdKey: "library/robots/ur10/Legacy/ur10.usd",
        terrainUsdKey: null,
        terrainMode: "usd",
      },
      diagnostics: [],
      sceneEligibility: {
        canCreateExperiment: true,
        robotCount: 1,
        primaryRobotEntityId: "robot_root",
        primaryRobotAssetId: "asset_robot_123",
        robotCandidates: [
          {
            entityId: "robot_root",
            assetId: "asset_robot_123",
            label: "Robot",
            sourceKind: "usd",
          },
        ],
      },
    });

    expect(result.environment.robotAssetId).toBe("asset_robot_123");
    expect(result.environment.sceneAssetId).toBe("asset_scene_456");
    expect(result.environment.sceneTerrainType).toBe("usd");
    expect(result.environment.metadata?.compilationTarget).toBe("training");
    expect(result.environment.metadata?.compilationStats).toEqual({ nodeCount: 2 });
    expect(result.environment.metadata?.primaryRobotEntityId).toBe("robot_root");
    expect(result.environment.metadata?.robotCount).toBe(1);
    expect(result.environment.metadata?.sceneTwinMode).toBe("composed_scene_asset");
    expect((result.environment.metadata?.sceneAssetResolution as Record<string, unknown>).source).toBe("explicit_override");
    expect(result.environment.controlPolicy).toEqual({
      mode: "single_agent_primary_robot",
      primaryRobotEntityId: "robot_root",
    });
    expect(result.environment.sourceHints).toBeTruthy();
    expect(result.environment.placements).toBeTruthy();
    expect(result.environment.placements?.length).toBe(2);

    const robotPlacement = result.environment.placements?.find((item) => item.entityId === "robot_root");
    expect(robotPlacement).toBeTruthy();
    expect(robotPlacement?.localTransform?.translation).toEqual([1.2, 0.3, 0.4]);
    expect(robotPlacement?.localTransform?.scale).toEqual([1, 1, 1]);
    const rotationQuat = robotPlacement?.localTransform?.rotationQuat;
    expect(rotationQuat).toBeTruthy();
    expect(Math.abs((rotationQuat?.[2] ?? 0) - Math.SQRT1_2)).toBeLessThan(1e-9);
    expect(Math.abs((rotationQuat?.[3] ?? 0) - Math.SQRT1_2)).toBeLessThan(1e-9);
  });

  it("prefers snapshot-attached training scene asset before composition upload", async () => {
    const snapshot = createEnvironmentSnapshot();
    snapshot.assets.table_asset.trainingAssetId = "asset_scene_from_snapshot";
    let composeCalled = false;

    const result = await buildTrainingEnvironment({
      submit: createSubmitInput(),
      configValues: {
        robotAssetId: "asset_robot_123",
        environment: {},
      },
      compiledEnvironment: snapshot,
      compilationTarget: "training",
      compilationStats: { nodeCount: 2 },
      context: {},
      diagnostics: [],
      composeAndUploadEnvironmentSceneAssetFn: async () => {
        composeCalled = true;
        return null;
      },
    });

    expect(result.environment.sceneAssetId).toBe("asset_scene_from_snapshot");
    expect(result.environment.sceneTerrainType).toBe("usd");
    expect(composeCalled).toBe(false);
    expect((result.environment.metadata?.sceneAssetResolution as Record<string, unknown>).source).toBe(
      "snapshot_training_asset"
    );
  });

  it("falls back to composed scene upload when no explicit or snapshot scene asset is available", async () => {
    const snapshot = createEnvironmentSnapshot();
    const result = await buildTrainingEnvironment({
      submit: createSubmitInput(),
      configValues: {
        robotAssetId: "asset_robot_123",
        environment: {},
      },
      compiledEnvironment: snapshot,
      compilationTarget: "training",
      compilationStats: { nodeCount: 2 },
      context: {},
      diagnostics: [],
      composeAndUploadEnvironmentSceneAssetFn: async () => ({
        sceneAssetId: "asset_scene_composed",
        entryPath: "composed_scene.usda",
        diagnostics: [],
        sourceCount: 1,
        entityCount: 1,
        signature: "sig_123",
      }),
    });

    expect(result.environment.sceneAssetId).toBe("asset_scene_composed");
    expect(result.environment.sceneTerrainType).toBe("usd");
    expect((result.environment.metadata?.sceneAssetResolution as Record<string, unknown>).source).toBe(
      "composition_upload"
    );
  });
});
