import type { AssetEntry } from "../../assets/assetRegistryTypes";
import type { EnvironmentDiagnostic, EnvironmentDoc } from "../../editor/document/types";
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
import type { CustomTrainingEnvironmentPayload } from "./trainingRequestTypes";
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
  buildSceneCompositionPlanFn?: typeof buildSceneCompositionPlan;
  buildSceneCompositionSignatureFn?: typeof buildSceneCompositionSignature;
  composeAndUploadEnvironmentSceneAssetFn?: typeof composeAndUploadEnvironmentSceneAsset;
  getCachedSceneAssetIdFn?: (signature: string) => string | undefined;
  setCachedSceneAssetIdFn?: (signature: string, sceneAssetId: string) => void;
  sceneEligibility?: SceneTrainingEligibility | null;
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
