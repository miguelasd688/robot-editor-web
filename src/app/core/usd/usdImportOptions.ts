export type UsdImportOptions = {
  floatingBase?: boolean;
  selfCollision?: boolean;
  meshSceneProfile?: "balanced" | "high_fidelity";
  collisionProfile?: "authored" | "outer_hull";
};
