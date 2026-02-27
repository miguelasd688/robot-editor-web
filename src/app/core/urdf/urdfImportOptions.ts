export type UrdfImportOptions = {
  floatingBase?: boolean;
  firstLinkIsWorldReferenceFrame?: boolean;
  selfCollision?: boolean;
  collisionMode?: "mesh" | "box" | "sphere" | "cylinder" | "fast";
};
