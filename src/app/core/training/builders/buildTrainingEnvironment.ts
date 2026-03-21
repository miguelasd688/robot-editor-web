import type { AssetEntry } from "../../assets/assetRegistryTypes";
import type { ActuatorDescriptor } from "../../physics/mujoco/ActuatorRegistry";
import type { EnvironmentDiagnostic, EnvironmentDoc, SceneNode } from "../../editor/document/types";
import type { SubmitTrainingJobInput } from "../../plugins/types";
import {
  buildSceneCompositionPlan,
  buildSceneCompositionSignature,
  composeAndUploadEnvironmentSceneAsset,
} from "../sceneUsdComposer";
import { useAssetStore } from "../../store/useAssetStore";
import { getCachedSceneCompositionAssetId, setCachedSceneCompositionAssetId } from "../services/sceneCompositionCache";
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
  TerrainLaunchPlan,
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
    terrainLaunchPlan?: TerrainLaunchPlan | null;
  };
  diagnostics: EnvironmentDiagnostic[];
  assets?: Record<string, AssetEntry>;
  buildSceneCompositionPlanFn?: typeof buildSceneCompositionPlan;
  buildSceneCompositionSignatureFn?: typeof buildSceneCompositionSignature;
  composeAndUploadEnvironmentSceneAssetFn?: typeof composeAndUploadEnvironmentSceneAsset;
  getCachedSceneAssetIdFn?: (signature: string) => string | undefined;
  setCachedSceneAssetIdFn?: (signature: string, sceneAssetId: string) => void;
  sceneEligibility?: SceneTrainingEligibility | null;
  sourceSceneNodes?: Record<string, SceneNode>;
  actuatorRegistryByRobot?: Record<string, ActuatorDescriptor[]>;
};

type SnapshotSceneTrainingAssetResolution = {
  sceneAssetId: string;
  sourceAssetId: string;
  entityId: string;
};

function buildSourceHints(snapshot: EnvironmentDoc | null): Record<string, unknown> {
  if (!snapshot) {
    return {
      assets: {},
      entities: {},
    };
  }
  const assets = toObjectOrEmpty(snapshot.assets) as Record<string, Record<string, unknown>>;
  const entities = toObjectOrEmpty(snapshot.entities) as Record<string, Record<string, unknown>>;
  const assetHints: Record<string, unknown> = {};
  const entityHints: Record<string, unknown> = {};

  for (const [assetId, rawAsset] of Object.entries(assets)) {
    const sourceKind = toTextOrEmpty(rawAsset.kind).toLowerCase() || "unknown";
    assetHints[assetId] = {
      kind: sourceKind,
      role: toTextOrEmpty(rawAsset.role) || undefined,
      trainingAssetId: toTextOrEmpty(rawAsset.trainingAssetId) || undefined,
      workspaceKey: toTextOrEmpty(rawAsset.workspaceKey) || undefined,
      isDirty:
        typeof rawAsset.isDirty === "boolean"
          ? rawAsset.isDirty
          : sourceKind === "usd"
            ? false
            : true,
    };
  }

  for (const [entityId, rawEntity] of Object.entries(entities)) {
    const sourceAssetId = toTextOrEmpty(rawEntity.sourceAssetId);
    entityHints[entityId] = {
      id: toTextOrEmpty(rawEntity.id) || entityId,
      kind: toTextOrEmpty(rawEntity.kind) || "unknown",
      sourceAssetId: sourceAssetId || undefined,
    };
  }

  return {
    assets: assetHints,
    entities: entityHints,
  };
}

function hasSceneKind(kind: unknown): boolean {
  const token = toTextOrEmpty(kind).toLowerCase();
  return token === "terrain" || token === "scene_asset";
}

function selectTopLevelSceneEntities(snapshot: EnvironmentDoc): Array<Record<string, unknown>> {
  const entitiesRaw = toObjectOrEmpty(snapshot.entities);
  const entities = entitiesRaw as Record<string, Record<string, unknown>>;
  const topLevelSceneEntities: Array<Record<string, unknown>> = [];
  for (const rawEntity of Object.values(entities)) {
    if (!rawEntity || typeof rawEntity !== "object") continue;
    if (!hasSceneKind(rawEntity.kind)) continue;
    const parentId = toTextOrEmpty(rawEntity.parentId);
    const parent = parentId ? entities[parentId] : null;
    if (!parent || !hasSceneKind(parent.kind)) {
      topLevelSceneEntities.push(rawEntity);
      continue;
    }
    const parentSourceAssetId = toTextOrEmpty(parent.sourceAssetId);
    const sourceAssetId = toTextOrEmpty(rawEntity.sourceAssetId);
    if (!parentSourceAssetId || !sourceAssetId || parentSourceAssetId !== sourceAssetId) {
      topLevelSceneEntities.push(rawEntity);
    }
  }
  return topLevelSceneEntities;
}

function resolveSceneAssetIdFromSnapshotTrainingAsset(
  snapshot: EnvironmentDoc | null
): SnapshotSceneTrainingAssetResolution | null {
  if (!snapshot) return null;
  const assets = toObjectOrEmpty(snapshot.assets) as Record<string, Record<string, unknown>>;
  const roots = Array.isArray(snapshot.roots) ? snapshot.roots.map((item) => toTextOrEmpty(item)) : [];
  const rootOrder = new Map<string, number>();
  roots.forEach((rootId, index) => {
    if (!rootId) return;
    rootOrder.set(rootId, index);
  });
  const candidates = selectTopLevelSceneEntities(snapshot)
    .map((entity) => {
      const entityId = toTextOrEmpty(entity.id);
      const sourceAssetId = toTextOrEmpty(entity.sourceAssetId);
      const sourceAsset = sourceAssetId ? assets[sourceAssetId] : null;
      const sourceRole = toTextOrEmpty(sourceAsset?.role).toLowerCase();
      if (sourceRole === "robot") return null;
      const sceneAssetId = toTextOrEmpty(sourceAsset?.trainingAssetId);
      if (!entityId || !sourceAssetId || !sceneAssetId) return null;
      return {
        entityId,
        sourceAssetId,
        sceneAssetId,
      };
    })
    .filter(
      (item): item is { entityId: string; sourceAssetId: string; sceneAssetId: string } => item !== null
    )
    .sort((a, b) => {
      const aRoot = rootOrder.has(a.entityId) ? (rootOrder.get(a.entityId) as number) : Number.MAX_SAFE_INTEGER;
      const bRoot = rootOrder.has(b.entityId) ? (rootOrder.get(b.entityId) as number) : Number.MAX_SAFE_INTEGER;
      if (aRoot !== bRoot) return aRoot - bRoot;
      return a.entityId.localeCompare(b.entityId);
    });

  if (candidates.length === 0) return null;
  const selected = candidates[0];
  return {
    sceneAssetId: selected.sceneAssetId,
    sourceAssetId: selected.sourceAssetId,
    entityId: selected.entityId,
  };
}

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
  const robotAssetId = toTextOrEmpty(configValues.robotAssetId) || toTextOrEmpty(environmentValues.robotAssetId);
  const explicitSceneAssetId =
    toTextOrEmpty(configValues.sceneAssetId) || toTextOrEmpty(environmentValues.sceneAssetId);
  const sceneAssetIdFromSnapshot = !explicitSceneAssetId
    ? resolveSceneAssetIdFromSnapshotTrainingAsset(snapshot)
    : null;
  const resolvedSceneAssetId = explicitSceneAssetId || sceneAssetIdFromSnapshot?.sceneAssetId || "";
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
  const environment: CustomTrainingEnvironmentPayload = {
    id:
      toTextOrEmpty(input.submit.envId) ||
      toTextOrEmpty(configValues.taskTemplate) ||
      input.submit.dataset ||
      "custom_environment",
    sourceOfTruth: "project_doc_environment_v1",
    snapshot,
    ...(placements.length > 0 ? { placements } : {}),
    robotAssetId: robotAssetId || undefined,
    sceneAssetId: resolvedSceneAssetId || undefined,
    robotUsdKey: input.context.robotUsdKey,
    terrainUsdKey: input.context.terrainUsdKey,
    terrainMode: input.context.terrainMode,
    ...(input.context.terrainLaunchPlan ? { terrainLaunchPlan: input.context.terrainLaunchPlan } : {}),
    robotUsdOverridePath: environmentOverrides.robotUsdOverridePath,
    sceneUsdOverridePath: environmentOverrides.sceneUsdOverridePath,
    sceneUsdTypeOverridePath: environmentOverrides.sceneUsdTypeOverridePath,
    runtimeWorldUsdOverridePath: environmentOverrides.runtimeWorldUsdOverridePath,
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
  if (environment.sceneAssetId) {
    applyUsdSceneExecutionDefaults(environment);
  }

  let sceneAssetResolution: Record<string, unknown> = {
    source: "none",
    sceneAssetId: environment.sceneAssetId ?? null,
  };
  if (explicitSceneAssetId) {
    sceneAssetResolution = {
      source: "explicit_override",
      sceneAssetId: explicitSceneAssetId,
    };
  } else if (sceneAssetIdFromSnapshot?.sceneAssetId) {
    sceneAssetResolution = {
      source: "snapshot_training_asset",
      sceneAssetId: sceneAssetIdFromSnapshot.sceneAssetId,
      sourceAssetId: sceneAssetIdFromSnapshot.sourceAssetId,
      entityId: sceneAssetIdFromSnapshot.entityId,
    };
  }

  if (!environment.sceneAssetId && environment.snapshot) {
    const assets = input.assets ?? useAssetStore.getState().assets;
    const buildSceneCompositionPlanFn = input.buildSceneCompositionPlanFn ?? buildSceneCompositionPlan;
    const buildSceneCompositionSignatureFn =
      input.buildSceneCompositionSignatureFn ?? buildSceneCompositionSignature;
    const composeAndUploadEnvironmentSceneAssetFn =
      input.composeAndUploadEnvironmentSceneAssetFn ?? composeAndUploadEnvironmentSceneAsset;
    const getCachedSceneAssetIdFn = input.getCachedSceneAssetIdFn ?? getCachedSceneCompositionAssetId;
    const setCachedSceneAssetIdFn = input.setCachedSceneAssetIdFn ?? setCachedSceneCompositionAssetId;

    const scenePlan = buildSceneCompositionPlanFn(environment.snapshot);
    const scenePlanSignature = buildSceneCompositionSignatureFn({
      nodes: scenePlan.nodes,
      sources: scenePlan.sources,
      assets,
    });
    const cachedSceneAssetId = getCachedSceneAssetIdFn(scenePlanSignature);
    if (cachedSceneAssetId) {
      environment.sceneAssetId = cachedSceneAssetId;
      applyUsdSceneExecutionDefaults(environment);
      environment.metadata = {
        ...(environment.metadata ?? {}),
        sceneAssetResolution: {
          source: "composition_cache",
          sceneAssetId: cachedSceneAssetId,
        },
        sceneComposition: {
          applied: true,
          fromCache: true,
          sceneAssetId: cachedSceneAssetId,
          sourceCount: scenePlan.sources.length,
          entityCount: scenePlan.nodes.length,
        },
      };
      sceneAssetResolution = {
        source: "composition_cache",
        sceneAssetId: cachedSceneAssetId,
      };
    } else {
      const sceneComposition = await composeAndUploadEnvironmentSceneAssetFn({
        environment: environment.snapshot,
        assets,
      });
      if (sceneComposition) {
        diagnostics = mergeDiagnostics(diagnostics, sceneComposition.diagnostics);
        if (sceneComposition.sceneAssetId) {
          environment.sceneAssetId = sceneComposition.sceneAssetId;
          applyUsdSceneExecutionDefaults(environment);
          environment.metadata = {
            ...(environment.metadata ?? {}),
            sceneAssetResolution: {
              source: "composition_upload",
              sceneAssetId: sceneComposition.sceneAssetId,
              sourceCount: sceneComposition.sourceCount,
              entityCount: sceneComposition.entityCount,
              entryPath: sceneComposition.entryPath,
            },
            sceneComposition: {
              applied: true,
              fromCache: false,
              sceneAssetId: sceneComposition.sceneAssetId,
              sourceCount: sceneComposition.sourceCount,
              entityCount: sceneComposition.entityCount,
              entryPath: sceneComposition.entryPath,
            },
          };
          sceneAssetResolution = {
            source: "composition_upload",
            sceneAssetId: sceneComposition.sceneAssetId,
          };
          setCachedSceneAssetIdFn(sceneComposition.signature, sceneComposition.sceneAssetId);
        }
      }
    }
  }

  environment.metadata = {
    ...(toObjectOrEmpty(environment.metadata) ?? {}),
    sceneTwinMode: environment.sceneAssetId ? "composed_scene_asset" : "robot_only",
    sceneAssetResolution,
  };

  return {
    environment,
    diagnostics,
  };
}
