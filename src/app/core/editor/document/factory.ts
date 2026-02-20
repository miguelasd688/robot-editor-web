import type { ProjectDoc, SceneDoc } from "./types";

export function createEmptyScene(): SceneDoc {
  return {
    nodes: {},
    roots: [],
    selectedId: null,
  };
}

export function createEmptyProject(): ProjectDoc {
  return {
    version: 1,
    scene: createEmptyScene(),
    sources: {},
    metadata: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}
