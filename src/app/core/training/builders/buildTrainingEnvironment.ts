import type { AssetEntry } from "../../assets/assetRegistryTypes";
import type { ActuatorDescriptor } from "../../physics/mujoco/ActuatorRegistry";
import type { EnvironmentDiagnostic, EnvironmentDoc, SceneNode } from "../../editor/document/types";
import type { SubmitTrainingJobInput } from "../../plugins/types";
import { useAssetStore } from "../../store/useAssetStore";
import { buildSourceHints } from "../services/sceneAssetResolution";
import { prepareEditorSceneForTraining } from "../services/editorScenePreparationService";
import { compileEditorSceneContract } from "../editorScene";
import { resolveTaskTemplateCatalogEntry } from "@runtime-plugins/catalog";
import { resolveTrainingProfileMetadata } from "../profiles";
import {
  buildTrainingPlacementsFromSnapshot,
  cloneEnvironmentSnapshot,
  mergeDiagnostics,
  pickEnvironmentOverrides,
  toObjectOrEmpty,
  toTextOrEmpty,
} from "./trainingBuildUtils";
import type {
  CustomTrainingEnvironmentPayload,
  CustomTrainingRobotRuntimeSemantics,
} from "./trainingRequestTypes";
import type { SceneTrainingEligibility } from "../sceneTrainingEligibility";

type BuildTrainingEnvironmentInput = {
  submit: SubmitTrainingJobInput;
  configValues: Record<string, unknown>;
  compiledEnvironment: EnvironmentDoc | null;
  compilationTarget: string;
  compilationStats: Record<string, unknown>;
  context: {
    robotUsdKey?: string | null;
    terrainUsdKey?: string | null;
    terrainMode?: string;
  };
  diagnostics: EnvironmentDiagnostic[];
  assets?: Record<string, AssetEntry>;
  prepareEditorSceneForTrainingFn?: typeof prepareEditorSceneForTraining;
  sceneEligibility?: SceneTrainingEligibility | null;
  sourceSceneNodes?: Record<string, SceneNode>;
  actuatorRegistryByRobot?: Record<string, ActuatorDescriptor[]>;
};

function applyUsdSceneExecutionDefaults(environment: CustomTrainingEnvironmentPayload): void {
  environment.terrainMode = "usd";
  environment.sceneTerrainType = "usd";
  environment.sceneUsdTypeValue = "usd";
}

function normalizeRobotCount(raw: unknown, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.round(parsed));
}

function toVector3Tuple(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const x = Number(value[0]);
  const y = Number(value[1]);
  const z = Number(value[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}

function toFiniteNumberOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toRecordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function resolvePrimaryRobotNodeId(input: {
  snapshot: EnvironmentDoc | null;
  primaryRobotEntityId: string | null;
  sourceSceneNodes?: Record<string, SceneNode>;
}): string {
  const snapshotEntities =
    input.snapshot && typeof input.snapshot.entities === "object" && input.snapshot.entities
      ? (input.snapshot.entities as Record<string, Record<string, unknown>>)
      : {};
  const sourceSceneNodes = input.sourceSceneNodes ?? {};
  const primaryEntity =
    input.primaryRobotEntityId && snapshotEntities[input.primaryRobotEntityId]
      ? snapshotEntities[input.primaryRobotEntityId]
      : null;
  const candidateNodeIds = [
    toTextOrEmpty(primaryEntity?.nodeId),
    toTextOrEmpty(primaryEntity?.id),
    toTextOrEmpty(input.primaryRobotEntityId),
  ].filter((item) => item.length > 0);
  for (const candidate of candidateNodeIds) {
    if (sourceSceneNodes[candidate]?.kind === "robot") return candidate;
  }
  return "";
}

function buildRobotRuntimeSemantics(input: {
  sourceSceneNodes?: Record<string, SceneNode>;
  actuatorRegistryByRobot?: Record<string, ActuatorDescriptor[]>;
  robotNodeId: string;
}): CustomTrainingRobotRuntimeSemantics | undefined {
  const sourceSceneNodes = input.sourceSceneNodes ?? {};
  const robotNode = sourceSceneNodes[input.robotNodeId];
  if (!robotNode || robotNode.kind !== "robot") return undefined;

  const jointNodesById = new Map<string, SceneNode>();
  const jointNodesByName = new Map<string, SceneNode>();
  const stack = [robotNode.id];
  while (stack.length > 0) {
    const nodeId = stack.pop() as string;
    const node = sourceSceneNodes[nodeId];
    if (!node) continue;
    for (const childId of node.children) stack.push(childId);
    const urdf = node.components?.urdf;
    if (!urdf || urdf.kind !== "joint") continue;
    jointNodesById.set(node.id, node);
    jointNodesByName.set(urdf.joint.name, node);
  }

  const rawActuators = (input.actuatorRegistryByRobot?.[input.robotNodeId] ?? [])
    .filter((entry) => entry && String(entry.jointName ?? "").trim().length > 0)
    .sort((a, b) => a.jointName.localeCompare(b.jointName));

  const actuators = rawActuators.map((entry) => {
    const jointNode = jointNodesById.get(entry.jointId) ?? jointNodesByName.get(entry.jointName);
    const urdfJoint =
      jointNode?.components?.urdf && jointNode.components.urdf.kind === "joint"
        ? jointNode.components.urdf.joint
        : null;
    return {
      jointId: entry.jointId,
      jointName: entry.jointName,
      actuatorName: entry.actuatorName,
      type: entry.actuatorType,
      enabled: true,
      sourceType: toTextOrEmpty(urdfJoint?.actuator?.sourceType) || undefined,
      stiffness: toFiniteNumberOrUndefined(urdfJoint?.actuator?.stiffness) ?? entry.stiffness,
      damping: toFiniteNumberOrUndefined(urdfJoint?.actuator?.damping) ?? entry.damping,
      initialPosition:
        toFiniteNumberOrUndefined(urdfJoint?.actuator?.initialPosition) ?? entry.initialPosition,
    };
  });

  const tendons = Array.from(jointNodesById.values())
    .map((node) => {
      const urdf = node.components?.urdf;
      if (!urdf || urdf.kind !== "joint") return null;
      const joint = urdf.joint;
      if (joint.actuator?.enabled === false || joint.actuator?.type !== "muscle" || !joint.muscle) {
        return null;
      }
      const endA = toVector3Tuple(joint.muscle.endA.localPos);
      const endB = toVector3Tuple(joint.muscle.endB.localPos);
      if (!endA || !endB) return null;
      const range =
        Array.isArray(joint.muscle.range) &&
        joint.muscle.range.length >= 2 &&
        Number.isFinite(Number(joint.muscle.range[0])) &&
        Number.isFinite(Number(joint.muscle.range[1]))
          ? ([Number(joint.muscle.range[0]), Number(joint.muscle.range[1])] as [number, number])
          : undefined;
      return {
        jointId: node.id,
        jointName: joint.name,
        kind: "muscle" as const,
        range,
        force: toFiniteNumberOrUndefined(joint.muscle.force),
        scale: toFiniteNumberOrUndefined(joint.muscle.scale),
        damping: toFiniteNumberOrUndefined(joint.muscle.damping),
        endA: {
          body: toTextOrEmpty(joint.muscle.endA.body) || undefined,
          localPos: endA,
        },
        endB: {
          body: toTextOrEmpty(joint.muscle.endB.body) || undefined,
          localPos: endB,
        },
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => a.jointName.localeCompare(b.jointName));

  if (!actuators.length && !tendons.length) return undefined;
  return {
    ...(actuators.length > 0 ? { actuators } : {}),
    ...(tendons.length > 0 ? { tendons } : {}),
  };
}

export async function buildTrainingEnvironment(
  input: BuildTrainingEnvironmentInput
): Promise<{
  environment: CustomTrainingEnvironmentPayload;
  diagnostics: EnvironmentDiagnostic[];
}> {
  const configValues = input.configValues;
  const environmentValues = toObjectOrEmpty(configValues.environment);
  const environmentOverrides = pickEnvironmentOverrides(environmentValues);
  const snapshot = cloneEnvironmentSnapshot(input.compiledEnvironment);
  const placements = buildTrainingPlacementsFromSnapshot(snapshot);
  const templateId = toTextOrEmpty(configValues.templateId) || toTextOrEmpty(environmentValues.templateId);
  const template = resolveTaskTemplateCatalogEntry({
    templateId,
    taskTemplate: toTextOrEmpty(configValues.taskTemplate) || toTextOrEmpty(environmentValues.taskTemplate),
  });
  const authoredProfileContractFromConfig = toRecordOrUndefined(configValues.authoredProfileContract);
  const authoredProfileContractFromTemplate = toRecordOrUndefined(template.authoredProfileContract);
  const authoredProfileContract =
    authoredProfileContractFromConfig && Object.keys(authoredProfileContractFromConfig).length > 0
      ? authoredProfileContractFromConfig
      : authoredProfileContractFromTemplate && Object.keys(authoredProfileContractFromTemplate).length > 0
        ? authoredProfileContractFromTemplate
        : undefined;
  const profileMetadata = resolveTrainingProfileMetadata(template, toTextOrEmpty(configValues.agentPresetId) || toTextOrEmpty(configValues.agentId));
  const profileId =
    toTextOrEmpty(configValues.profileId) ||
    toTextOrEmpty(authoredProfileContract?.profileId) ||
    profileMetadata.profileId;
  const baseTaskId =
    toTextOrEmpty(configValues.baseTaskId) ||
    toTextOrEmpty(authoredProfileContract?.baseTaskId) ||
    profileMetadata.baseTaskId;
  const profileVersion =
    toTextOrEmpty(configValues.profileVersion) ||
    toTextOrEmpty(authoredProfileContract?.profileVersion) ||
    profileMetadata.profileVersion;
  const registrationId =
    toTextOrEmpty(configValues.registrationId) ||
    toTextOrEmpty(authoredProfileContract?.registrationId) ||
    profileMetadata.registrationId;
  const adapterId = toTextOrEmpty(configValues.adapterId);
  const agentPresetId =
    toTextOrEmpty(configValues.agentPresetId) ||
    toTextOrEmpty(configValues.agentId) ||
    profileMetadata.agentPresetId ||
    "";
  const robotAssetId = toTextOrEmpty(configValues.robotAssetId) || toTextOrEmpty(environmentValues.robotAssetId);
  const sceneEligibility = input.sceneEligibility ?? null;
  const environmentMetadata = toObjectOrEmpty(environmentValues.metadata);
  const userModelMetadata = toObjectOrEmpty(configValues.userModelMetadata);
  const resolvedPrimaryRobotEntityId =
    sceneEligibility?.primaryRobotEntityId ??
    (toTextOrEmpty(environmentMetadata.primaryRobotEntityId) || null);
  const resolvedRobotCount = normalizeRobotCount(
    sceneEligibility?.robotCount,
    normalizeRobotCount(environmentMetadata.robotCount, 0)
  );
  const primaryRobotNodeId = resolvePrimaryRobotNodeId({
    snapshot,
    primaryRobotEntityId: resolvedPrimaryRobotEntityId,
    sourceSceneNodes: input.sourceSceneNodes,
  });
  const robotRuntimeSemantics = buildRobotRuntimeSemantics({
    sourceSceneNodes: input.sourceSceneNodes,
    actuatorRegistryByRobot: input.actuatorRegistryByRobot,
    robotNodeId: primaryRobotNodeId,
  });

  let diagnostics = input.diagnostics;
  const resolvedLaunchPlan = environmentOverrides.resolvedLaunchPlan as
    | { terrainPlan?: { strategy?: string }; overlayPlan?: { emitWorldUsdOverride?: boolean } }
    | undefined;
  const resolvedPlanSuppressesOverlay = resolvedLaunchPlan?.overlayPlan?.emitWorldUsdOverride === false;

  const environment: CustomTrainingEnvironmentPayload = {
    id:
      toTextOrEmpty(input.submit.envId) ||
      toTextOrEmpty(configValues.taskTemplate) ||
      input.submit.dataset ||
      "custom_environment",
    sourceOfTruth: "project_doc_environment_v1",
    profileId: profileId || undefined,
    profileVersion: profileVersion || undefined,
    baseTaskId: baseTaskId || undefined,
    registrationId: registrationId || undefined,
    agentPresetId: agentPresetId || undefined,
    ...(adapterId ? { adapterId } : {}),
    snapshot,
    ...(authoredProfileContract ? { authoredProfileContract: JSON.parse(JSON.stringify(authoredProfileContract)) } : {}),
    ...(placements.length > 0 ? { placements } : {}),
    robotAssetId: robotAssetId || undefined,
    robotUsdKey: input.context.robotUsdKey,
    terrainUsdKey: input.context.terrainUsdKey,
    terrainMode: input.context.terrainMode,
    ...(resolvedLaunchPlan ? { resolvedLaunchPlan: resolvedLaunchPlan as CustomTrainingEnvironmentPayload["resolvedLaunchPlan"] } : {}),
    robotUsdOverridePath: environmentOverrides.robotUsdOverridePath,
    sceneUsdOverridePath: environmentOverrides.sceneUsdOverridePath,
    sceneUsdTypeOverridePath: environmentOverrides.sceneUsdTypeOverridePath,
    // Suppress runtimeWorldUsdOverridePath when resolvedLaunchPlan governs overlay.
    runtimeWorldUsdOverridePath: resolvedPlanSuppressesOverlay ? undefined : environmentOverrides.runtimeWorldUsdOverridePath,
    sceneTerrainType: environmentOverrides.sceneTerrainType,
    sceneUsdTypeValue: environmentOverrides.sceneUsdTypeValue,
    baseConstraintMode: environmentOverrides.baseConstraintMode,
    cartpoleJointMap: environmentOverrides.cartpoleJointMap,
    controlMode: environmentOverrides.controlMode,
    observables: environmentOverrides.observables,
    actions: environmentOverrides.actions,
    resets: environmentOverrides.resets,
    ik: environmentOverrides.ik,
    metadata: {
      ...userModelMetadata,
      ...environmentMetadata,
      ...(profileId ? { profileId } : {}),
      ...(profileVersion ? { profileVersion } : {}),
      ...(baseTaskId ? { baseTaskId } : {}),
      ...(registrationId ? { registrationId } : {}),
      ...(agentPresetId ? { agentPresetId } : {}),
      ...(adapterId ? { adapterId } : {}),
      ...(resolvedPrimaryRobotEntityId ? { primaryRobotEntityId: resolvedPrimaryRobotEntityId } : {}),
      robotCount: resolvedRobotCount,
      ...(resolvedPrimaryRobotEntityId ? { primaryRobotSelection: "auto" } : {}),
      compilationTarget: input.compilationTarget,
      compilationStats: input.compilationStats,
    },
    sourceHints: buildSourceHints(snapshot),
    ...(robotRuntimeSemantics ? { robotRuntimeSemantics } : {}),
    controlPolicy:
      resolvedPrimaryRobotEntityId
        ? {
            mode: "single_agent_primary_robot",
            primaryRobotEntityId: resolvedPrimaryRobotEntityId,
          }
        : undefined,
  };
  const prepareEditorSceneForTrainingFn = input.prepareEditorSceneForTrainingFn ?? prepareEditorSceneForTraining;
  const preparedScene = await prepareEditorSceneForTrainingFn({
    snapshot: environment.snapshot,
    assets: input.assets ?? useAssetStore.getState().assets,
    sceneAssetId: toTextOrEmpty(configValues.sceneAssetId) || toTextOrEmpty(environmentValues.sceneAssetId),
    existingScenePreparation: toObjectOrEmpty(environmentValues.scenePreparation),
    placements,
    profileId,
    baseTaskId,
    taskTemplate: toTextOrEmpty(configValues.taskTemplate) || toTextOrEmpty(environmentValues.taskTemplate),
    task: toTextOrEmpty(configValues.task) || toTextOrEmpty(environmentValues.task) || input.submit.modelName || "",
    recipeId: baseTaskId,
    envId:
      toTextOrEmpty(input.submit.envId) ||
      toTextOrEmpty(configValues.taskTemplate) ||
      input.submit.dataset ||
      "custom_environment",
  });
  diagnostics = mergeDiagnostics(
    diagnostics,
    preparedScene.diagnostics
      .filter((item) => item.severity !== "info")
      .map((item) => ({
        code: item.code,
        message: item.message,
        severity: item.severity === "error" ? "error" : "warning",
        source: "training" as const,
      }))
  );
  if (preparedScene.scenePreparation) {
    environment.scenePreparation = preparedScene.scenePreparation;
  }
  if (preparedScene.sceneAssetId) {
    environment.sceneAssetId = preparedScene.sceneAssetId;
    applyUsdSceneExecutionDefaults(environment);
  }

  const scenePreparationRecord = toObjectOrEmpty(preparedScene.scenePreparation);
  const sceneAssetResolution: Record<string, unknown> = {
    source: toTextOrEmpty(scenePreparationRecord.source) || "none",
    sceneAssetId: environment.sceneAssetId ?? null,
    ...(preparedScene.fingerprint ? { fingerprint: preparedScene.fingerprint } : {}),
    ...(typeof scenePreparationRecord.sourceCount === "number" ? { sourceCount: scenePreparationRecord.sourceCount } : {}),
    ...(typeof scenePreparationRecord.entityCount === "number" ? { entityCount: scenePreparationRecord.entityCount } : {}),
    ...(toTextOrEmpty(scenePreparationRecord.entryPath) ? { entryPath: scenePreparationRecord.entryPath } : {}),
    ...(preparedScene.cacheHit ? { cacheHit: true } : {}),
  };

  environment.metadata = {
    ...(toObjectOrEmpty(environment.metadata) ?? {}),
    sceneTwinMode: environment.sceneAssetId ? "composed_scene_asset" : "robot_only",
    sceneAssetResolution,
  };

  environment.editorSceneContract = compileEditorSceneContract({
    environment,
    profileId,
    baseTaskId,
    taskTemplate: toTextOrEmpty(configValues.taskTemplate) || toTextOrEmpty(environmentValues.taskTemplate),
    task: toTextOrEmpty(configValues.task) || toTextOrEmpty(environmentValues.task) || input.submit.modelName || "",
    generatedAt: new Date().toISOString(),
  });

  return {
    environment,
    diagnostics,
  };
}
