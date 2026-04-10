import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../../editor/document/factory";
import type { EnvironmentDoc, ProjectDoc, SceneNode } from "../../editor/document/types";
import {
  resolvePrimaryRobotImportTransformFromSnapshot,
  resolvePrimaryRobotImportTransformFromProjectDoc,
  resolvePrimaryRobotImportTransformFromTrainingArtifacts,
} from "./trainingBuildUtils";

function createSnapshot(): EnvironmentDoc {
  return {
    version: 1,
    assets: {
      robot_asset: {
        id: "robot_asset",
        kind: "usd",
        role: "robot",
        workspaceKey: "library/robots/ant/ant.usd",
      },
      floor_asset: {
        id: "floor_asset",
        kind: "usd",
        role: "terrain",
        workspaceKey: "library/floors/flat_floor/flat_floor.usda",
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
          position: { x: 0.25, y: -0.5, z: 0.42 },
          rotation: { x: 0, y: 0, z: 90 },
          scale: { x: 1, y: 1, z: 1 },
        },
      },
      floor_root: {
        id: "floor_root",
        name: "Floor",
        kind: "terrain",
        sourceRole: "terrain",
        parentId: null,
        children: [],
        sourceAssetId: "floor_asset",
      },
    },
    roots: ["robot_root", "floor_root"],
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

function createProjectDoc(): ProjectDoc {
  const project = createEmptyProject();
  const robotNode: SceneNode = {
    id: "robot_root",
    name: "Robot",
    kind: "robot",
    parentId: null,
    children: [],
    components: {
      transform: {
        position: { x: 0.5, y: -0.25, z: 0.75 },
        rotation: { x: 0, y: 45, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      robotModelSource: {
        kind: "usd",
        usdKey: "library/robots/ant/ant.usd",
        workspaceKey: "library/robots/ant/ant.usd",
        importOptions: {},
        isDirty: false,
      },
    },
  };
  project.scene.nodes = {
    robot_root: robotNode,
  };
  project.scene.roots = ["robot_root"];
  return project;
}

describe("resolvePrimaryRobotImportTransformFromSnapshot", () => {
  it("resolves the robot root transform from the environment snapshot using the robot workspace key", () => {
    const transform = resolvePrimaryRobotImportTransformFromSnapshot({
      snapshot: createSnapshot(),
      robotUsdKey: "library/robots/ant/ant.usd",
    });

    expect(transform).toEqual({
      position: { x: 0.25, y: -0.5, z: 0.42 },
      rotationDeg: { x: 0, y: 0, z: 90 },
      scale: { x: 1, y: 1, z: 1 },
    });
  });

  it("falls back to the only robot when the robot USD key does not match", () => {
    const transform = resolvePrimaryRobotImportTransformFromSnapshot({
      snapshot: createSnapshot(),
      robotUsdKey: "library/robots/anymal_c/anymal_c.usd",
    });

    expect(transform).toEqual({
      position: { x: 0.25, y: -0.5, z: 0.42 },
      rotationDeg: { x: 0, y: 0, z: 90 },
      scale: { x: 1, y: 1, z: 1 },
    });
  });
});

describe("resolvePrimaryRobotImportTransformFromTrainingArtifacts", () => {
  it("prefers profile-example placements from compiled training artifacts over snapshot transforms", () => {
    const transform = resolvePrimaryRobotImportTransformFromTrainingArtifacts({
      snapshot: createSnapshot(),
      robotUsdKey: "library/robots/ant/ant.usd",
      compiledTrainingEnvironment: {
        id: "custom_environment",
        sourceOfTruth: "project_doc_environment_v1",
        snapshot: null,
        placements: [
          {
            entityId: "robot_root",
            sourceAssetId: "robot_asset",
            localTransform: {
              translation: [0.11, -0.22, 0.42],
              rotationQuat: [0, 0, 0, 1],
              scale: [1, 1, 1],
            },
          },
        ],
        scenePreparation: {
          placements: [
            {
              entityId: "robot_root",
              sourceAssetId: "robot_asset",
              localTransform: {
                translation: [0.11, -0.22, 0.42],
                rotationQuat: [0, 0, 0, 1],
                scale: [1, 1, 1],
              },
            },
          ],
        },
        editorSceneContract: {
          contractVersion: "v1",
          profileId: "ant",
          baseTaskId: "isaaclab.ant.manager.v1",
          taskTemplate: "ant_manager",
          task: "Isaac-Ant-v0",
          robotAssetId: "robot_asset",
          primaryRobot: {
            entityId: "robot_root",
            name: "Robot",
            assetId: "robot_asset",
            sourceKind: "usd",
          },
          sceneAssetId: "floor_asset",
          placements: [],
          terrain: {
            mode: "usd",
            sourceKind: "usd",
            assetId: "floor_asset",
            entityCount: 0,
          },
          sceneEntitiesSummary: {},
          sourceKinds: {},
          sourcePipeline: {},
          resolvedLaunchPlan: {},
          effectiveScenePolicy: {},
          sourceHints: {},
          scenePreparation: {},
          generatedAt: new Date().toISOString(),
        },
        controlPolicy: {
          mode: "single_agent_primary_robot",
          primaryRobotEntityId: "robot_root",
        },
        robotAssetId: "robot_asset",
      },
    });

    expect(transform?.position).toEqual({ x: 0.11, y: -0.22, z: 0.42 });
    expect(transform?.rotationDeg).toBeDefined();
    expect(transform?.rotationDeg?.x).toBeCloseTo(0);
    expect(transform?.rotationDeg?.y).toBeCloseTo(0);
    expect(transform?.rotationDeg?.z).toBeCloseTo(0);
    expect(transform?.scale).toEqual({ x: 1, y: 1, z: 1 });
  });

  it("falls back to the snapshot transform when compiled training artifacts do not include placements", () => {
    const transform = resolvePrimaryRobotImportTransformFromTrainingArtifacts({
      snapshot: createSnapshot(),
      robotUsdKey: "library/robots/ant/ant.usd",
      compiledTrainingEnvironment: {
        id: "custom_environment",
        sourceOfTruth: "project_doc_environment_v1",
        snapshot: null,
        editorSceneContract: {
          contractVersion: "v1",
          profileId: "ant",
          baseTaskId: "isaaclab.ant.manager.v1",
          taskTemplate: "ant_manager",
          task: "Isaac-Ant-v0",
          robotAssetId: "robot_asset",
          primaryRobot: {
            entityId: "robot_root",
            name: "Robot",
            assetId: "robot_asset",
            sourceKind: "usd",
          },
          sceneAssetId: "floor_asset",
          placements: [],
          terrain: {
            mode: "usd",
            sourceKind: "usd",
            assetId: "floor_asset",
            entityCount: 0,
          },
          sceneEntitiesSummary: {},
          sourceKinds: {},
          sourcePipeline: {},
          resolvedLaunchPlan: {},
          effectiveScenePolicy: {},
          sourceHints: {},
          scenePreparation: {},
          generatedAt: new Date().toISOString(),
        },
      },
    });

    expect(transform).toEqual({
      position: { x: 0.25, y: -0.5, z: 0.42 },
      rotationDeg: { x: 0, y: 0, z: 90 },
      scale: { x: 1, y: 1, z: 1 },
    });
  });
});

describe("resolvePrimaryRobotImportTransformFromProjectDoc", () => {
  it("resolves the robot transform from the live project doc when validation artifacts are missing", () => {
    const transform = resolvePrimaryRobotImportTransformFromProjectDoc({
      projectDoc: createProjectDoc(),
      robotUsdKey: "library/robots/ant/ant.usd",
    });

    expect(transform).toEqual({
      position: { x: 0.5, y: -0.25, z: 0.75 },
      rotationDeg: { x: 0, y: 45, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    });
  });
});
