import { describe, expect, it } from "vitest";
import { createSceneAssetTree } from "./sceneAssets";

function expectOriginTransform(transform: unknown) {
  expect(transform).toMatchObject({
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  });
}

describe("scene asset trees", () => {
  it("keeps managed floor assets aligned to the scene origin", () => {
    const floorTree = createSceneAssetTree("floor");
    const floorRoot = floorTree.nodes.find((node) => node.id === floorTree.rootId);
    expect(floorRoot?.components?.transform).toBeDefined();
    expectOriginTransform(floorRoot?.components?.transform);

    const roughFloorTree = createSceneAssetTree("floor:rough");
    const roughFloorRoot = roughFloorTree.nodes.find((node) => node.id === roughFloorTree.rootId);
    expect(roughFloorRoot?.components?.transform).toBeDefined();
    expectOriginTransform(roughFloorRoot?.components?.transform);
  });
});
