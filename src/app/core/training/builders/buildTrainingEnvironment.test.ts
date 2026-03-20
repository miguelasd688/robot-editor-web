import { describe, expect, it } from "vitest";
import type { EnvironmentDoc, SceneNode } from "../../editor/document/types";
import type { ActuatorDescriptor } from "../../physics/mujoco/ActuatorRegistry";
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

function createSourceSceneNodes(): Record<string, SceneNode> {
  return {
    robot_root: {
      id: "robot_root",
      name: "Robot",
      kind: "robot",
      parentId: null,
      children: ["hip_joint", "muscle_joint"],
      components: {},
    },
    hip_joint: {
      id: "hip_joint",
      name: "Hip Joint",
      kind: "joint",
      parentId: "robot_root",
      children: [],
      components: {
        urdf: {
          kind: "joint",
          joint: {
            name: "hip_joint",
            type: "revolute",
            parent: "base",
            child: "leg",
            origin: { xyz: [0, 0, 0], rpy: [0, 0, 0] },
            axis: [1, 0, 0],
            actuator: {
              enabled: true,
              type: "position",
              sourceType: "authored",
              stiffness: 12,
              damping: 3,
              initialPosition: 0.25,
            },
          },
        },
      },
    },
    muscle_joint: {
      id: "muscle_joint",
      name: "Muscle Joint",
      kind: "joint",
      parentId: "robot_root",
      children: [],
      components: {
        urdf: {
          kind: "joint",
          joint: {
            name: "muscle_joint",
            type: "revolute",
            parent: "leg",
            child: "foot",
            origin: { xyz: [0, 0, 0], rpy: [0, 0, 0] },
            axis: [0, 1, 0],
            actuator: {
              enabled: true,
              type: "muscle",
              sourceType: "authored_muscle",
            },
            muscle: {
              enabled: true,
              endA: { body: "leg", localPos: [0.1, 0.2, 0.3] },
              endB: { body: "foot", localPos: [0.4, 0.5, 0.6] },
              range: [0.2, 1.4],
              force: 18,
              scale: 1.2,
              damping: 0.8,
            },
          },
        },
      },
    },
  };
}

function createActuatorRegistryByRobot(): Record<string, ActuatorDescriptor[]> {
  return {
    robot_root: [
      {
        robotId: "robot_root",
        jointId: "hip_joint",
        jointName: "hip_joint",
        type: "revolute",
        mjcfJoint: "hip_joint",
        actuatorName: "hip_motor",
        range: { min: -1, max: 1 },
        velocityRange: { min: -2, max: 2 },
        effortRange: { min: -3, max: 3 },
        initialPosition: 0.25,
        stiffness: 12,
        damping: 3,
        continuous: false,
        actuatorType: "position",
        angular: true,
      },
      {
        robotId: "robot_root",
        jointId: "muscle_joint",
        jointName: "muscle_joint",
        type: "revolute",
        mjcfJoint: "muscle_joint",
        actuatorName: "muscle_drive",
        range: { min: -1, max: 1 },
        velocityRange: { min: -2, max: 2 },
        effortRange: { min: -3, max: 3 },
        initialPosition: 0,
        stiffness: 4,
        damping: 1,
        continuous: false,
        actuatorType: "muscle",
        angular: true,
      },
    ],
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

  it("serializes robot runtime semantics from primary robot actuators and muscle joints", async () => {
    const snapshot = createEnvironmentSnapshot();
    const result = await buildTrainingEnvironment({
      submit: createSubmitInput(),
      configValues: {
        robotAssetId: "asset_robot_123",
        sceneAssetId: "asset_scene_456",
        environment: {},
      },
      compiledEnvironment: snapshot,
      compilationTarget: "training",
      compilationStats: { nodeCount: 2 },
      context: {},
      diagnostics: [],
      sceneEligibility: {
        canCreateExperiment: true,
        robotCount: 1,
        primaryRobotEntityId: "robot_root",
        primaryRobotAssetId: "asset_robot_123",
        robotCandidates: [],
      },
      sourceSceneNodes: createSourceSceneNodes(),
      actuatorRegistryByRobot: createActuatorRegistryByRobot(),
    });

    expect(result.environment.robotRuntimeSemantics?.actuators).toEqual([
      {
        jointId: "hip_joint",
        jointName: "hip_joint",
        actuatorName: "hip_motor",
        type: "position",
        enabled: true,
        sourceType: "authored",
        stiffness: 12,
        damping: 3,
        initialPosition: 0.25,
      },
      {
        jointId: "muscle_joint",
        jointName: "muscle_joint",
        actuatorName: "muscle_drive",
        type: "muscle",
        enabled: true,
        sourceType: "authored_muscle",
        stiffness: 4,
        damping: 1,
        initialPosition: 0,
      },
    ]);
    expect(result.environment.robotRuntimeSemantics?.tendons).toEqual([
      {
        jointId: "muscle_joint",
        jointName: "muscle_joint",
        kind: "muscle",
        range: [0.2, 1.4],
        force: 18,
        scale: 1.2,
        damping: 0.8,
        endA: { body: "leg", localPos: [0.1, 0.2, 0.3] },
        endB: { body: "foot", localPos: [0.4, 0.5, 0.6] },
      },
    ]);
  });
});
