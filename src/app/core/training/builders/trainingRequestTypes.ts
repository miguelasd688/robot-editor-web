import type { SubmitTrainingJobInput } from "../../plugins/types";
import type { EnvironmentDiagnostic, EnvironmentDoc, ProjectDoc } from "../../editor/document/types";
import type { EditorRobotModel } from "../../services/trainingApiClient";
import type { EditorSceneContract } from "../editorScene";

export type TerrainLaunchStrategy = "runtime_world_overlay" | "scene_driven_adapter" | "blocked";

export type TerrainLaunchPlan = {
  strategy: TerrainLaunchStrategy;
  reasonCode: string;
  warningMessage?: string;
  blockerMessage?: string;
  overlayAssetId?: string;
  overlayAssetPath?: string;
};

export type CustomTrainingActuatorSemantic = {
  jointId: string;
  jointName: string;
  actuatorName: string;
  type: "position" | "velocity" | "torque" | "muscle";
  enabled: boolean;
  sourceType?: string;
  stiffness?: number;
  damping?: number;
  initialPosition?: number;
};

export type CustomTrainingTendonSemantic = {
  jointId: string;
  jointName: string;
  kind: "muscle";
  range?: [number, number];
  force?: number;
  scale?: number;
  damping?: number;
  endA: {
    body?: string;
    localPos: [number, number, number];
  };
  endB: {
    body?: string;
    localPos: [number, number, number];
  };
};

export type CustomTrainingRobotRuntimeSemantics = {
  actuators?: CustomTrainingActuatorSemantic[];
  tendons?: CustomTrainingTendonSemantic[];
};

export type CustomTrainingEnvironmentPlacement = {
  entityId: string;
  sourceAssetId?: string;
  localTransform?: {
    translation?: [number, number, number];
    rotationQuat?: [number, number, number, number];
    scale?: [number, number, number];
  };
};

export type CustomTrainingPrimaryRobotPlacement = CustomTrainingEnvironmentPlacement & {
  source: string;
  placementSelection?: {
    matchReason: string;
    entityId: string;
    sourceAssetId: string;
  } | null;
  poseFrame: "editor_scene_local";
  placementsConsumed: boolean;
  placementsPresent: number;
};

export type CustomTrainingEnvironmentPayload = {
  id: string;
  sourceOfTruth: "project_doc_environment_v1";
  profileId?: string;
  profileVersion?: string;
  baseTaskId?: string;
  registrationId?: string;
  agentPresetId?: string;
  adapterId?: string;
  authoredProfileContract?: Record<string, unknown>;
  snapshot: EnvironmentDoc | null;
  placements?: CustomTrainingEnvironmentPlacement[];
  primaryRobotPlacement?: CustomTrainingPrimaryRobotPlacement;
  controlPolicy?: {
    mode: "single_agent_primary_robot" | "future_multi_agent";
    primaryRobotEntityId?: string;
    robots?: string[];
  };
  sourceHints?: Record<string, unknown>;
  scenePreparation?: Record<string, unknown>;
  robotRuntimeSemantics?: CustomTrainingRobotRuntimeSemantics;
  robotAssetId?: string;
  sceneAssetId?: string;
  robotUsdKey?: string | null;
  terrainUsdKey?: string | null;
  terrainMode?: string;
  sceneTerrainType?: string;
  sceneUsdTypeValue?: string;
  robotUsdOverridePath?: string;
  sceneUsdOverridePath?: string;
  sceneUsdTypeOverridePath?: string;
  runtimeWorldUsdOverridePath?: string;
  baseConstraintMode?: "fix_base" | "source_weld";
  cartpoleJointMap?: Record<string, unknown>;
  controlMode?: string;
  observables?: Array<Record<string, unknown>>;
  actions?: Array<Record<string, unknown>>;
  resets?: Array<Record<string, unknown>>;
  ik?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  resolvedLaunchPlan?: {
    recipeId: string;
    envId: string;
    terrainPlan: TerrainLaunchPlan;
    overlayPlan: {
      emitWorldUsdOverride: boolean;
      hydraKey?: string;
      envVarName?: string;
      sceneUsdOverridePath?: string;
      sceneUsdTypeOverridePath?: string;
    };
    sceneActivation?: {
      mode: "runtime_world_overlay" | "scene_driven_adapter" | "blocked";
      reasonCode: string;
      runtimeOverlayAllowed: boolean;
      adapterId?: string;
      sceneDrivenTemplateId?: string;
      sceneDrivenTaskTemplate?: string;
      sceneDrivenTask?: string;
      blockerMessage?: string;
      warningMessage?: string;
    };
  };
  editorSceneContract?: EditorSceneContract;
  experimentTaskSpec?: ExperimentTaskSpec;
  taskFingerprint?: string;
  experimentTaskId?: string;
};

export type CustomTrainingAgentPayload = {
  agentId?: string;
  agentPresetId?: string;
  trainer?: string;
  algorithm?: string;
  preset?: string;
  policy?: Record<string, unknown>;
  policyRules?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type CustomTrainingRuntimePayload = {
  backend: "isaac_lab";
  maxSteps: number;
  numEnvs?: number;
  checkpoint?: number;
  stepsPerEpoch?: number;
  videoLengthSec?: number;
  videoLengthMs?: number;
  videoLength?: number;
  videoInterval?: number;
  baseConstraintMode?: "fix_base" | "source_weld";
  assetPipeline?: { mode: "usd_passthrough" | "mjcf_conversion"; reason?: string };
  extraArgs?: string[];
  recordingViews?: Record<string, unknown>;
  overrides?: Record<string, unknown>;
};

export type CustomTrainingTaskRequest = {
  sourcePayloadVersion: "training_task_source_v2";
  tenantId?: string;
  experimentName: string;
  seed?: number;
  dryRun?: boolean;
  environment: CustomTrainingEnvironmentPayload;
  agent: CustomTrainingAgentPayload;
  runtime: CustomTrainingRuntimePayload;
  profileId?: string;
  profileVersion?: string;
  baseTaskId?: string;
  registrationId?: string;
  agentPresetId?: string;
  adapterId?: string;
  adapterVersion?: string;
  editorRobotModel?: EditorRobotModel;
  editorSceneContract?: EditorSceneContract;
  experimentTaskSpec?: ExperimentTaskSpec;
  experimentTaskRegistration?: Record<string, unknown>;
  authoredProfileContract?: Record<string, unknown>;
  adapterSelection?: Record<string, unknown>;
  experimentContext?: Record<string, unknown>;
  sceneActivation?: Record<string, unknown>;
  robotEmbodimentSpec?: Record<string, unknown>;
  agentCompilation?: Record<string, unknown>;
  taskFingerprint?: string;
  experimentTaskId?: string;
  experimentId?: string;
  experimentRevisionId?: string;
  compatibilitySignature?: Record<string, unknown>;
};

export type ExperimentTaskSpec = {
  experimentTaskId: string;
  derivedTaskId: string;
  profileId: string;
  profileVersion: string;
  agentPresetId: string;
  adapterId: string;
  baseTaskId: string;
  registrationId: string;
  taskFingerprint: string;
  editorSceneContract: EditorSceneContract;
  sceneActivation: {
    mode: "runtime_world_overlay" | "scene_driven_adapter" | "blocked";
    reasonCode: string;
    runtimeOverlayAllowed: boolean;
    adapterId?: string;
    sceneDrivenTemplateId?: string;
    sceneDrivenTaskTemplate?: string;
    sceneDrivenTask?: string;
    blockerMessage?: string;
    warningMessage?: string;
  };
  adapterPayload: Record<string, unknown>;
  envCfgPatch: Record<string, unknown>;
  lifecycle: Record<string, unknown>;
};

export type CustomTrainingTaskBuildResult = {
  request: CustomTrainingTaskRequest;
  diagnostics: EnvironmentDiagnostic[];
};

export type BuildCustomTaskRequestInput = {
  submit: SubmitTrainingJobInput;
  config: Record<string, unknown>;
  doc?: ProjectDoc;
};
