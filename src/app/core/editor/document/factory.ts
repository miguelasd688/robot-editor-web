import type { EnvironmentDoc, ProjectDoc, SceneDoc } from "./types";

export function createEmptyScene(): SceneDoc {
  return {
    nodes: {},
    roots: [],
    selectedId: null,
  };
}

export function createEmptyEnvironmentDoc(nowIso = new Date().toISOString()): EnvironmentDoc {
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
    updatedAt: nowIso,
  };
}

export function createEmptyProject(): ProjectDoc {
  const nowIso = new Date().toISOString();
  return {
    version: 2,
    scene: createEmptyScene(),
    sources: {},
    environment: createEmptyEnvironmentDoc(nowIso),
    metadata: {
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  };
}
