import { describe, expect, it } from "vitest";
import type { ProjectDoc } from "../editor/document/types";
import { EnvironmentCompilationManager } from "./EnvironmentCompilationManager";

function createProjectDocWithReferenceTerrain(): ProjectDoc {
  return {
    version: 2,
    scene: {
      nodes: {
        robot_root: {
          id: "robot_root",
          name: "Robot",
          parentId: null,
          children: [],
          kind: "robot",
          components: {},
        },
      },
      roots: ["robot_root"],
      selectedId: null,
    },
    sources: {},
    environment: {
      version: 1,
      assets: {
        floor_asset: {
          id: "floor_asset",
          kind: "usd",
          role: "terrain",
          workspaceKey: "library/floors/flat_floor/flat_floor.usda",
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
        },
      },
      roots: ["terrain_floor"],
      simulation: {
        gravity: [0, 0, -9.81],
        timestep: 0.002,
        substeps: 1,
        solver: "auto",
        contactModel: "auto",
      },
      diagnostics: [],
      updatedAt: new Date().toISOString(),
    },
  };
}

describe("EnvironmentCompilationManager", () => {
  it("preserves reference terrain entities from the canonical environment", () => {
    const manager = new EnvironmentCompilationManager();
    const compiled = manager.compileProjectDoc({
      doc: createProjectDocWithReferenceTerrain(),
      target: "training",
    });

    expect(compiled.environment.entities.terrain_floor).toBeTruthy();
    expect(compiled.environment.assets.floor_asset).toBeTruthy();
    expect(compiled.environment.roots).toEqual(["robot_root", "terrain_floor"]);
    expect(compiled.stats.terrain).toBe(1);
    expect(compiled.diagnostics.find((item) => item.code === "ENV_TERRAIN_NOT_FOUND")).toBeFalsy();
  });
});
