import type { SceneNodeKind } from "../../viewer/types";
import type { InstancePhysics, PhysicsFields } from "../../assets/types";
import type { UrdfInstance } from "../../urdf/urdfModel";
import type { UrdfImportOptions } from "../../urdf/urdfImportOptions";
import type { UsdImportOptions } from "../../usd/usdImportOptions";

export type DocId = string;

export type Vec3 = { x: number; y: number; z: number };

export type Transform = {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
};

/** RGBA color tuple, each channel in [0, 1]. Applied to visual meshes and exported to MJCF. */
export type RgbaColor = [number, number, number, number];

export type VisualComponent = {
  attachCollisions?: boolean;
  /** Per-visual override color. When set, replaces the default Three.js + MJCF material color. */
  rgba?: RgbaColor;
  /** Optional metadata for imported non-trivial materials (for example textured USD materials). */
  materialInfo?: {
    source?: string;
    materialName?: string | null;
    texturePath?: string | null;
    editable?: boolean;
  };
};

export type MirrorComponent = {
  sourceId: DocId;
};

// Discriminated union for robot model import sources.
// urdf* fields kept for backward compat — prefer robotModelSource for new code.
export type UrdfModelSource = {
  kind: "urdf";
  source: string;
  key: string | null;
  importOptions: UrdfImportOptions;
};

export type UsdModelSource = {
  kind: "usd";
  /**
   * Backward compatibility field.
   * For new code prefer workspaceKey/converterAssetId/trainingAssetId.
   */
  usdKey: string;
  /** Workspace asset key/path of the source USD entry file. */
  workspaceKey?: string | null;
  /** Source USD assetId on usd-converter service. */
  converterAssetId?: string | null;
  /** Source USD assetId on training-runner service. */
  trainingAssetId?: string | null;
  /** assetId of the derived MJCF (set after conversion) */
  mjcfKey?: string;
  importOptions: UsdImportOptions;
  /** true if any property was edited after import; triggers MJCF→USD re-conversion on training launch */
  isDirty: boolean;
};

export type RobotModelSource = UrdfModelSource | UsdModelSource;

export type NodeComponents = {
  transform?: Transform;
  physics?: InstancePhysics;
  physicsFields?: PhysicsFields;
  urdf?: UrdfInstance;
  /** @deprecated use robotModelSource */
  urdfSource?: string;
  /** @deprecated use robotModelSource */
  urdfKey?: string | null;
  /** @deprecated use robotModelSource */
  urdfImportOptions?: UrdfImportOptions;
  /** Generic robot model source — set for robots imported from any format (urdf, usd, …) */
  robotModelSource?: RobotModelSource;
  visual?: VisualComponent;
  mirror?: MirrorComponent;
};

export type NodeSource =
  | { kind: "clone"; fromId: DocId }
  | { kind: "primitive"; shape: "cube" | "sphere" | "cylinder" | "plane" };

export type CreateNodeInput = {
  id?: DocId;
  name: string;
  kind: SceneNode["kind"];
  parentId?: DocId | null;
  source?: SceneNode["source"];
  components?: SceneNode["components"];
};

export type SceneNode = {
  id: DocId;
  name: string;
  parentId: DocId | null;
  children: DocId[];
  kind: SceneNodeKind;
  components?: NodeComponents;
  source?: NodeSource;
};

export type SceneDoc = {
  nodes: Record<DocId, SceneNode>;
  roots: DocId[];
  selectedId: DocId | null;
};

export type ProjectSources = {
  urdf?: string;
  mjcf?: string;
  usd?: string;
};

export type ProjectDoc = {
  version: 1;
  scene: SceneDoc;
  sources: ProjectSources;
  metadata?: {
    name?: string;
    createdAt?: string;
    updatedAt?: string;
  };
};
