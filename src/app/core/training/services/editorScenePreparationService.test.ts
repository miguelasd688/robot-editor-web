import { describe, expect, it, vi } from "vitest";
import type { AssetEntry } from "../../assets/assetRegistryTypes";
import type { EnvironmentDoc } from "../../editor/document/types";
import { prepareEditorSceneForTraining } from "./editorScenePreparationService";

function createSnapshot(): EnvironmentDoc {
  return {
    version: 1,
    assets: {
      scene_asset: {
        id: "scene_asset",
        kind: "usd",
        role: "scene_asset",
        workspaceKey: "library/scene/table.usd",
      },
    },
    entities: {
      table: {
        id: "table",
        kind: "scene_asset",
        sourceAssetId: "scene_asset",
        parentId: null,
        children: [],
        transform: {
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
      },
    },
    roots: ["table"],
    simulation: {
      gravity: [0, 0, -9.81],
      timestep: 0.002,
      substeps: 1,
      solver: "auto",
      contactModel: "auto",
    },
    diagnostics: [],
    updatedAt: "2026-03-23T00:00:00.000Z",
  };
}

describe("prepareEditorSceneForTraining", () => {
  it("reuses cached composed scene assets by fingerprint", async () => {
    const composeAndUploadEnvironmentSceneAssetFn = vi.fn();
    const result = await prepareEditorSceneForTraining({
      snapshot: createSnapshot(),
      assets: {} as Record<string, AssetEntry>,
      buildSceneCompositionPlanFn: () => ({
        nodes: [
          {
            entityId: "table",
            name: "Table",
            role: "scene_asset",
            sourceAssetId: "scene_asset",
            workspaceKey: "library/scene/table.usd",
            transform: {
              position: { x: 0, y: 0, z: 0 },
              rotation: { x: 0, y: 0, z: 0 },
              scale: { x: 1, y: 1, z: 1 },
            },
          },
        ],
        sources: [
          {
            sourceAssetId: "scene_asset",
            workspaceKey: "library/scene/table.usd",
            alias: "table_1",
          },
        ],
        diagnostics: [],
      }),
      buildSceneCompositionSignatureFn: () => "scene_signature_v1",
      composeAndUploadEnvironmentSceneAssetFn,
      getCachedSceneCompositionFn: () => ({
        sceneAssetId: "asset_scene_cached",
        fingerprint: "scene_fingerprint_v1",
        scenePreparation: { source: "composition_cache" },
      }),
    });

    expect(result.status).toBe("ready");
    expect(result.sceneAssetId).toBe("asset_scene_cached");
    expect(result.cacheHit).toBe(true);
    expect(result.fingerprint).toBe("scene_fingerprint_v1");
    expect(result.scenePreparation).toMatchObject({
      source: "composition_cache",
      sceneAssetId: "asset_scene_cached",
      cacheHit: true,
    });
    expect(composeAndUploadEnvironmentSceneAssetFn).not.toHaveBeenCalled();
  });

  it("blocks after preparation when no composable scene asset can be produced", async () => {
    const result = await prepareEditorSceneForTraining({
      snapshot: createSnapshot(),
      assets: {} as Record<string, AssetEntry>,
      buildSceneCompositionPlanFn: () => ({
        nodes: [],
        sources: [],
        diagnostics: [],
      }),
      buildSceneCompositionSignatureFn: () => "scene_signature_empty",
    });

    expect(result.status).toBe("blocked");
    expect(result.sceneAssetId).toBeUndefined();
    expect(result.cacheHit).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "EDITOR_SCENE_PREPARATION_NO_COMPOSABLE_SCENE",
        severity: "error",
      })
    );
  });
});
