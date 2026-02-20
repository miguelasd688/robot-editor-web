export type UrdfImportOptions = {
  /**
   * If enabled, rotates the imported robot to map URDF Z-up (ROS convention) into the editor's Y-up world.
   * This keeps gravity and joint axes intuitive for typical ROS URDFs.
   */
  urdfZUp?: boolean;
  floatingBase?: boolean;
  firstLinkIsWorldReferenceFrame?: boolean;
  selfCollision?: boolean;
  collisionMode?: "mesh" | "box" | "sphere" | "cylinder" | "fast";
};
