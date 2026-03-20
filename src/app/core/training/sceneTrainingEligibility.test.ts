import { describe, expect, it } from "vitest";
import type { EnvironmentDoc } from "../editor/document/types";
import { deriveSceneTrainingEligibility } from "./sceneTrainingEligibility";

function createEnvironment(input?: Partial<EnvironmentDoc>): EnvironmentDoc {
  return {
    version: 1,
    assets: {},
    entities: {},
    roots: [],
    simulation: {
      gravity: [0, 0, -9.81],
      timestep: 0.002,
      substeps: 1,
      solver: "auto",
      contactModel: "auto",
    },
    diagnostics: [],
    updatedAt: new Date().toISOString(),
    ...(input ?? {}),
  };
}

describe("deriveSceneTrainingEligibility", () => {
  it("returns disabled eligibility when no robots are present", () => {
    const result = deriveSceneTrainingEligibility(
      createEnvironment({
        entities: {
          terrain_a: {
            id: "terrain_a",
            name: "Terrain",
            kind: "terrain",
            parentId: null,
            children: [],
            sourceAssetId: "terrain_asset",
          },
        },
      })
    );

    expect(result.canCreateExperiment).toBe(false);
    expect(result.reason).toBe("No robot found in the scene");
    expect(result.robotCount).toBe(0);
    expect(result.primaryRobotEntityId).toBeNull();
    expect(result.robotCandidates).toEqual([]);
  });

  it("selects a root robot first when multiple robots exist", () => {
    const environment = createEnvironment({
      assets: {
        robot_a_asset: {
          id: "robot_a_asset",
          kind: "usd",
          role: "robot",
          trainingAssetId: "asset_robot_a",
        },
        robot_b_asset: {
          id: "robot_b_asset",
          kind: "usd",
          role: "robot",
          trainingAssetId: "asset_robot_b",
        },
      },
      entities: {
        robot_b: {
          id: "robot_b",
          name: "Robot B",
          kind: "robot",
          parentId: null,
          children: [],
          sourceAssetId: "robot_b_asset",
        },
        robot_a: {
          id: "robot_a",
          name: "Robot A",
          kind: "robot",
          parentId: null,
          children: [],
          sourceAssetId: "robot_a_asset",
        },
      },
      roots: ["robot_b", "robot_a"],
    });

    const result = deriveSceneTrainingEligibility(environment);
    expect(result.canCreateExperiment).toBe(true);
    expect(result.robotCount).toBe(2);
    expect(result.primaryRobotEntityId).toBe("robot_b");
    expect(result.primaryRobotAssetId).toBe("asset_robot_b");
  });

  it("falls back to first top-level robot when no robot appears in roots", () => {
    const environment = createEnvironment({
      assets: {
        robot_top_asset: { id: "robot_top_asset", kind: "usd", role: "robot", trainingAssetId: "asset_top" },
        robot_nested_asset: { id: "robot_nested_asset", kind: "usd", role: "robot", trainingAssetId: "asset_nested" },
      },
      entities: {
        group_a: {
          id: "group_a",
          name: "Group",
          kind: "prop",
          parentId: null,
          children: ["robot_nested"],
        },
        robot_nested: {
          id: "robot_nested",
          name: "Nested",
          kind: "robot",
          parentId: "group_a",
          children: [],
          sourceAssetId: "robot_nested_asset",
        },
        robot_top: {
          id: "robot_top",
          name: "Top",
          kind: "robot",
          parentId: null,
          children: [],
          sourceAssetId: "robot_top_asset",
        },
      },
      roots: ["group_a"],
    });

    const result = deriveSceneTrainingEligibility(environment);
    expect(result.primaryRobotEntityId).toBe("robot_top");
    expect(result.primaryRobotAssetId).toBe("asset_top");
  });

  it("falls back to lexical entity id when all robots are nested", () => {
    const environment = createEnvironment({
      assets: {
        robot_y_asset: { id: "robot_y_asset", kind: "mjcf", role: "robot", trainingAssetId: "asset_y" },
        robot_x_asset: { id: "robot_x_asset", kind: "urdf", role: "robot", trainingAssetId: "asset_x" },
      },
      entities: {
        group_a: {
          id: "group_a",
          name: "Group A",
          kind: "prop",
          parentId: null,
          children: ["robot_y"],
        },
        group_b: {
          id: "group_b",
          name: "Group B",
          kind: "prop",
          parentId: null,
          children: ["robot_x"],
        },
        robot_y: {
          id: "robot_y",
          name: "Robot Y",
          kind: "robot",
          parentId: "group_a",
          children: [],
          sourceAssetId: "robot_y_asset",
        },
        robot_x: {
          id: "robot_x",
          name: "Robot X",
          kind: "robot",
          parentId: "group_b",
          children: [],
          sourceAssetId: "robot_x_asset",
        },
      },
      roots: ["group_a", "group_b"],
    });

    const result = deriveSceneTrainingEligibility(environment);
    expect(result.primaryRobotEntityId).toBe("robot_x");
    expect(result.primaryRobotAssetId).toBe("asset_x");
    expect(result.robotCandidates.map((item) => item.sourceKind)).toEqual(["urdf", "mjcf"]);
  });
});
