import { describe, expect, it } from "vitest";
import type { EnvironmentDoc } from "../editor/document/types";
import {
  buildComposedSceneUsda,
  buildSceneCompositionPlan,
  buildSceneCompositionSignature,
} from "./sceneUsdComposer";

function createEnvironmentDocFixture(): EnvironmentDoc {
  return {
    version: 1,
    assets: {
      floor_asset: {
        id: "floor_asset",
        kind: "usd",
        role: "terrain",
        workspaceKey: "library/floors/flat_floor/flat_floor.usda",
      },
      table_asset: {
        id: "table_asset",
        kind: "usd",
        role: "scene_asset",
        workspaceKey: "library/links/ur10_environment/Props/Mounts/SeattleLabTable/table_instanceable.usd",
      },
      blue_cube_asset: {
        id: "blue_cube_asset",
        kind: "usd",
        role: "scene_asset",
        workspaceKey: "library/links/ur10_environment/Props/Blocks/blue_block.usd",
      },
    },
    entities: {
      terrain_floor: {
        id: "terrain_floor",
        name: "Floor",
        kind: "terrain",
        sourceRole: "terrain",
        parentId: null,
        children: [],
        sourceAssetId: "floor_asset",
        transform: {
          position: { x: 0, y: 0, z: -0.6 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
      },
      scene_table: {
        id: "scene_table",
        name: "UR10 Table",
        kind: "scene_asset",
        sourceRole: "scene_asset",
        parentId: null,
        children: ["scene_cube_blue"],
        sourceAssetId: "table_asset",
        transform: {
          position: { x: 0.5, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
      },
      scene_cube_blue: {
        id: "scene_cube_blue",
        name: "Cube Blue",
        kind: "scene_asset",
        sourceRole: "scene_asset",
        parentId: "scene_table",
        children: [],
        sourceAssetId: "blue_cube_asset",
        transform: {
          position: { x: 0.4, y: 0, z: 0.0203 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
      },
      duplicated_table_transform: {
        id: "duplicated_table_transform",
        name: "UR10 Table Copy",
        kind: "scene_asset",
        sourceRole: "scene_asset",
        parentId: null,
        children: [],
        sourceAssetId: "table_asset",
        transform: {
          position: { x: 0.2, y: 0.1, z: 0 },
          rotation: { x: 0, y: 0, z: 90 },
          scale: { x: 1, y: 1, z: 1 },
        },
      },
    },
    roots: ["terrain_floor", "scene_table", "duplicated_table_transform"],
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

describe("sceneUsdComposer", () => {
  it("builds scene composition plan with source dedup", () => {
    const plan = buildSceneCompositionPlan(createEnvironmentDocFixture());
    expect(plan.diagnostics).toHaveLength(0);
    expect(plan.nodes).toHaveLength(4);
    expect(plan.sources).toHaveLength(3);
    expect(plan.sources.find((item) => item.sourceAssetId === "table_asset")).toBeTruthy();
  });

  it("builds deterministic USDA with references and transforms", () => {
    const plan = buildSceneCompositionPlan(createEnvironmentDocFixture());
    const sourceEntryByAssetId = Object.fromEntries(
      plan.sources.map((source) => [
        source.sourceAssetId,
        { alias: source.alias, entryPath: source.workspaceKey.split("/").pop() || "entry.usd" },
      ])
    );
    const usda = buildComposedSceneUsda({
      nodes: plan.nodes,
      sourceEntryByAssetId,
    });
    expect(usda).toContain('#usda 1.0');
    expect(usda).toContain('defaultPrim = "World"');
    expect(usda).toContain("prepend references = @sources/");
    expect(usda).toContain("xformOp:translate = (0.5, 0, 0)");
    expect(usda).toContain("xformOp:rotateXYZ = (0, 0, 90)");
  });

  it("generates stable signature for equivalent plan", () => {
    const environment = createEnvironmentDocFixture();
    const planA = buildSceneCompositionPlan(environment);
    const planB = buildSceneCompositionPlan(environment);
    const fakeAssets = Object.fromEntries(
      planA.sources.map((source, index) => [
        source.workspaceKey,
        {
          key: source.workspaceKey,
          url: `memory://${source.workspaceKey}`,
          file: new File([`source-${index}`], source.workspaceKey.split("/").pop() || "source.usd", {
            type: "application/octet-stream",
          }),
        },
      ])
    );
    const signatureA = buildSceneCompositionSignature({
      nodes: planA.nodes,
      sources: planA.sources,
      assets: fakeAssets,
    });
    const signatureB = buildSceneCompositionSignature({
      nodes: planB.nodes,
      sources: planB.sources,
      assets: fakeAssets,
    });
    expect(signatureA).toBe(signatureB);
  });

  it("defers generated terrain compatibility to backend scene prep", () => {
    const environment = createEnvironmentDocFixture();
    environment.assets.floor_asset.kind = "generated";
    environment.assets.floor_asset.workspaceKey = null;
    const plan = buildSceneCompositionPlan(environment);
    expect(plan.sources).toHaveLength(2);
    const deferred = plan.diagnostics.find((item) => item.code === "CUSTOM_ENV_SCENE_SOURCE_DEFERRED");
    expect(deferred).toBeTruthy();
    expect(deferred?.severity).toBe("warning");
    expect(plan.diagnostics.find((item) => item.severity === "error")).toBeFalsy();
  });

  it("defers generated scene_asset compatibility to backend scene prep", () => {
    const environment = createEnvironmentDocFixture();
    environment.assets.table_asset.kind = "generated";
    environment.assets.table_asset.workspaceKey = null;
    const plan = buildSceneCompositionPlan(environment);
    const deferred = plan.diagnostics.find((item) => item.code === "CUSTOM_ENV_SCENE_SOURCE_DEFERRED");
    expect(deferred).toBeTruthy();
    expect(deferred?.severity).toBe("warning");
    expect(plan.diagnostics.find((item) => item.severity === "error")).toBeFalsy();
  });

  it("ignores scene entities backed by robot-role assets", () => {
    const environment = createEnvironmentDocFixture();
    environment.assets.floor_asset.role = "robot";
    const plan = buildSceneCompositionPlan(environment);
    expect(plan.nodes.find((item) => item.entityId === "terrain_floor")).toBeFalsy();
    expect(plan.sources.find((item) => item.sourceAssetId === "floor_asset")).toBeFalsy();
  });
});
