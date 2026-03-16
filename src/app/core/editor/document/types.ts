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

export type EnvironmentSourceRole = "robot" | "scene_asset" | "terrain";
export type SceneAssetSourceKind = "usd" | "mjcf" | "mesh" | "generated";

export type SceneAssetSource = {
  kind: SceneAssetSourceKind;
  role: Exclude<EnvironmentSourceRole, "robot">;
  workspaceKey?: string | null;
  converterAssetId?: string | null;
  trainingAssetId?: string | null;
  sourceUrl?: string | null;
  importOptions?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
};

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
  /** Source metadata for imported non-robot scene/environment assets (USD terrain/full-scene bundles). */
  sceneAssetSource?: SceneAssetSource;
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

export type EnvironmentAssetKind = "urdf" | "xacro" | "mjcf" | "usd" | "mesh" | "generated";

export type EnvironmentEntityKind =
  | "robot"
  | "terrain"
  | "prop"
  | "sensor"
  | "camera"
  | "light"
  | "scene_asset"
  | "unknown";

export type EnvironmentDiagnosticSeverity = "warning" | "error";
export type EnvironmentDiagnosticSource = "import" | "document" | "simulation" | "training";

export type EnvironmentDiagnostic = {
  code: string;
  severity: EnvironmentDiagnosticSeverity;
  source: EnvironmentDiagnosticSource;
  message: string;
  context?: Record<string, unknown>;
};

export type EnvironmentAsset = {
  id: string;
  kind: EnvironmentAssetKind;
  role?: EnvironmentSourceRole;
  workspaceKey?: string | null;
  converterAssetId?: string | null;
  trainingAssetId?: string | null;
  inlineSource?: string | null;
  importOptions?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
};

export type EnvironmentEntity = {
  id: string;
  nodeId?: string | null;
  name: string;
  kind: EnvironmentEntityKind;
  sourceRole?: EnvironmentSourceRole;
  parentId: string | null;
  children: string[];
  sourceAssetId?: string | null;
  transform?: Transform;
  physics?: InstancePhysics;
  physicsFields?: PhysicsFields;
  robotModelSource?: RobotModelSource;
  urdfImportOptions?: UrdfImportOptions;
  tags?: string[];
  metadata?: Record<string, unknown>;
};

export type EnvironmentSimulationConfig = {
  gravity: [number, number, number];
  timestep: number;
  substeps: number;
  solver: "pgs" | "cg" | "newton" | "auto";
  contactModel: "pyramidal" | "elliptic" | "auto";
};

export type EnvironmentTrainingHints = {
  templateId?: string;
  taskTemplate?: string;
  task?: string;
  recipeId?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
};

export type EnvironmentDoc = {
  version: 1;
  assets: Record<string, EnvironmentAsset>;
  entities: Record<string, EnvironmentEntity>;
  roots: string[];
  simulation: EnvironmentSimulationConfig;
  trainingHints?: EnvironmentTrainingHints;
  diagnostics: EnvironmentDiagnostic[];
  updatedAt: string;
};

export type ProjectDoc = {
  version: 1 | 2;
  scene: SceneDoc;
  /** Legacy source pointers maintained for old exports/imports. */
  sources: ProjectSources;
  /** Canonical environment source of truth for editor/simulation/training managers. */
  environment: EnvironmentDoc;
  metadata?: {
    name?: string;
    createdAt?: string;
    updatedAt?: string;
  };
};
