import type { SceneNodeKind } from "../../viewer/types";
import type { InstancePhysics, PhysicsFields } from "../../assets/types";
import type { UrdfInstance } from "../../urdf/urdfModel";
import type { UrdfImportOptions } from "../../urdf/urdfImportOptions";

export type DocId = string;

export type Vec3 = { x: number; y: number; z: number };

export type Transform = {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
};

export type VisualComponent = {
  attachCollisions?: boolean;
};

export type MirrorComponent = {
  sourceId: DocId;
};

export type NodeComponents = {
  transform?: Transform;
  physics?: InstancePhysics;
  physicsFields?: PhysicsFields;
  urdf?: UrdfInstance;
  urdfSource?: string;
  urdfKey?: string | null;
  urdfImportOptions?: UrdfImportOptions;
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
