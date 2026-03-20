import type { SubmitTrainingJobInput } from "../../plugins/types";
import type { EnvironmentDiagnostic, EnvironmentDoc, ProjectDoc } from "../../editor/document/types";

export type CustomTrainingEnvironmentPlacement = {
  entityId: string;
  sourceAssetId?: string;
  localTransform?: {
    translation?: [number, number, number];
    rotationQuat?: [number, number, number, number];
    scale?: [number, number, number];
  };
};

export type CustomTrainingEnvironmentPayload = {
  id: string;
  sourceOfTruth: "project_doc_environment_v1";
  snapshot: EnvironmentDoc | null;
  placements?: CustomTrainingEnvironmentPlacement[];
  controlPolicy?: {
    mode: "single_agent_primary_robot" | "future_multi_agent";
    primaryRobotEntityId?: string;
    robots?: string[];
  };
  sourceHints?: Record<string, unknown>;
  scenePreparation?: Record<string, unknown>;
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
};

export type CustomTrainingAgentPayload = {
  agentId?: string;
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
  sourcePayloadVersion: "training_task_source_v1" | "training_task_source_v2";
  tenantId?: string;
  experimentName: string;
  seed?: number;
  dryRun?: boolean;
  environment: CustomTrainingEnvironmentPayload;
  agent: CustomTrainingAgentPayload;
  runtime: CustomTrainingRuntimePayload;
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
