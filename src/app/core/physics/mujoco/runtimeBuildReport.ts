export type SceneAssetCollisionCoverage = {
  objectId: string;
  objectName: string;
  sourceRole: "scene_asset" | "terrain" | "robot" | "unknown";
  attemptedTargets: number;
  emittedGeoms: number;
  skippedTargets: number;
  hfieldGeoms: number;
  meshGeoms: number;
  primitiveGeoms: number;
  incomplete: boolean;
};

export type RuntimeBuildReport = {
  warnings: string[];
  terrainCollisionCoverage: SceneAssetCollisionCoverage[];
};
