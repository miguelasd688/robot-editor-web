export type Vec3 = { x: number; y: number; z: number };
export type Quat = { x: number; y: number; z: number; w: number };
export type InertiaTensor = { ixx: number; iyy: number; izz: number; ixy: number; ixz: number; iyz: number };

export type InstanceInitial = {
  position: Vec3;
  quaternion: Quat;
  scale: Vec3;
};

export type InstancePhysics = {
  mass: number;
  density: number;
  inertia: Vec3;
  inertiaTensor?: InertiaTensor;
  com?: Vec3;
  friction: number;
  restitution: number;
  collisionsEnabled: boolean;
  fixed: boolean;
  useDensity: boolean;
};

export type PhysicsFields = {
  mass?: boolean;
  density?: boolean;
  inertia?: boolean;
  inertiaTensor?: boolean;
  com?: boolean;
  friction?: boolean;
  restitution?: boolean;
  collisionsEnabled?: boolean;
  fixed?: boolean;
  useDensity?: boolean;
};

export type UserInstance = {
  initial: InstanceInitial;
  physics: InstancePhysics;
  fields: PhysicsFields;
};

export interface AssetUrlResolver {
  (resourceUrl: string): string | null;
}
