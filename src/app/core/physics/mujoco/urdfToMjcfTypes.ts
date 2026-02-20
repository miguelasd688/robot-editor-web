import type { AssetEntryLike } from "../../loaders/assetResolver";
import type { MjcfNameMap } from "./mjcfNames";

export type UrdfToMjcfOptions = {
  urdf: string;
  assets: Record<string, AssetEntryLike>;
  baseKey: string;
  namePrefix?: string;
  remap?: Record<string, string>;
  rootFreeJoint?: boolean;
  firstLinkIsWorldReferenceFrame?: boolean;
  rootTransform?: { position: [number, number, number]; quaternion: [number, number, number, number] };
  warnOnXacro?: boolean;
  meshMode?: "mesh" | "sphere" | "box" | "cylinder" | "fast";
  debug?: boolean;
  forceDiagonalInertia?: boolean;
  selfCollision?: boolean;
  defaultJointDamping?: number;
  defaultJointFriction?: number;
  defaultJointArmature?: number;
  defaultGeomFriction?: number;
  geomFrictionByLink?: Record<string, number>;
  meshBounds?: Record<string, { size: [number, number, number]; radius: number; center: [number, number, number] }>;
};

export type UrdfToMjcfResult = {
  xml: string;
  warnings: string[];
  nameMap: MjcfNameMap;
};
