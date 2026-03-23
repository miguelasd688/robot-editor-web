import type { AssetEntry } from "../../assets/assetRegistryTypes";
import type { EnvironmentDoc } from "../../editor/document/types";
import type { CustomTrainingEnvironmentPlacement } from "../builders/trainingRequestTypes";
import { buildTrainingPlacementsFromSnapshot } from "../builders/trainingBuildUtils";
import {
  buildSceneCompositionPlan,
  buildSceneCompositionSignature,
  composeAndUploadEnvironmentSceneAsset,
  type SceneCompositionPlan,
} from "../sceneUsdComposer";
import {
  getCachedSceneComposition,
  setCachedSceneComposition,
} from "./sceneCompositionCache";
import { resolveSceneAssetIdFromSnapshotTrainingAsset } from "./sceneAssetResolution";

export type EditorScenePreparationDiagnostic = {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
};

export type EditorScenePreparationResult = {
  status: "ready" | "blocked";
  sceneAssetId?: string;
  scenePreparation?: Record<string, unknown>;
  fingerprint?: string;
  cacheHit: boolean;
  diagnostics: EditorScenePreparationDiagnostic[];
};

type PrepareEditorSceneForTrainingInput = {
  snapshot: EnvironmentDoc | null;
  assets: Record<string, AssetEntry>;
  sceneAssetId?: string | null;
  existingScenePreparation?: Record<string, unknown>;
  placements?: CustomTrainingEnvironmentPlacement[];
  profileId?: string;
  baseTaskId?: string;
  taskTemplate?: string;
  task?: string;
  recipeId?: string;
  envId?: string;
  buildSceneCompositionPlanFn?: typeof buildSceneCompositionPlan;
  buildSceneCompositionSignatureFn?: typeof buildSceneCompositionSignature;
  composeAndUploadEnvironmentSceneAssetFn?: typeof composeAndUploadEnvironmentSceneAsset;
  getCachedSceneCompositionFn?: typeof getCachedSceneComposition;
  setCachedSceneCompositionFn?: typeof setCachedSceneComposition;
};

function toTextOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function buildPreparationFingerprint(input: {
  compositionSignature: string;
  placements: CustomTrainingEnvironmentPlacement[];
  profileId?: string;
  baseTaskId?: string;
  taskTemplate?: string;
  task?: string;
  recipeId?: string;
  envId?: string;
}) {
  return JSON.stringify({
    version: "v1",
    compositionSignature: input.compositionSignature,
    profileId: toTextOrEmpty(input.profileId),
    baseTaskId: toTextOrEmpty(input.baseTaskId),
    taskTemplate: toTextOrEmpty(input.taskTemplate),
    task: toTextOrEmpty(input.task),
    recipeId: toTextOrEmpty(input.recipeId),
    envId: toTextOrEmpty(input.envId),
    placements: input.placements,
  });
}

function buildScenePreparationPayload(input: {
  source:
    | "explicit_override"
    | "snapshot_training_asset"
    | "composition_cache"
    | "composition_upload"
    | "composition_blocked";
  sceneAssetId?: string;
  fingerprint?: string;
  cacheHit: boolean;
  sourceCount?: number;
  entityCount?: number;
  entryPath?: string;
  sourceAssetId?: string;
  entityId?: string;
  compositionSignature?: string;
}) {
  return {
    source: input.source,
    status: input.sceneAssetId ? "ready" : "blocked",
    cacheHit: input.cacheHit,
    ...(input.sceneAssetId ? { sceneAssetId: input.sceneAssetId } : {}),
    ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}),
    ...(input.compositionSignature ? { compositionSignature: input.compositionSignature } : {}),
    ...(typeof input.sourceCount === "number" ? { sourceCount: input.sourceCount } : {}),
    ...(typeof input.entityCount === "number" ? { entityCount: input.entityCount } : {}),
    ...(input.entryPath ? { entryPath: input.entryPath } : {}),
    ...(input.sourceAssetId ? { sourceAssetId: input.sourceAssetId } : {}),
    ...(input.entityId ? { entityId: input.entityId } : {}),
  };
}

function buildBlockedNoSceneResult(input: {
  fingerprint?: string;
  scenePreparation?: Record<string, unknown>;
  diagnostics: EditorScenePreparationDiagnostic[];
}): EditorScenePreparationResult {
  return {
    status: "blocked",
    cacheHit: false,
    ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}),
    ...(input.scenePreparation ? { scenePreparation: input.scenePreparation } : {}),
    diagnostics: input.diagnostics,
  };
}

function toCompositionDiagnostics(plan: SceneCompositionPlan): EditorScenePreparationDiagnostic[] {
  return plan.diagnostics.map((item) => ({
    code: item.code,
    message: item.message,
    severity: item.severity === "error" ? "error" : "warning",
  }));
}

export async function prepareEditorSceneForTraining(
  input: PrepareEditorSceneForTrainingInput
): Promise<EditorScenePreparationResult> {
  const snapshot = input.snapshot ?? null;
  const assets = input.assets ?? {};
  const existingScenePreparation =
    input.existingScenePreparation &&
    typeof input.existingScenePreparation === "object" &&
    !Array.isArray(input.existingScenePreparation)
      ? cloneJson(input.existingScenePreparation)
      : {};
  const placements = Array.isArray(input.placements)
    ? input.placements.map((item) => cloneJson(item))
    : buildTrainingPlacementsFromSnapshot(snapshot);
  const explicitSceneAssetId = toTextOrEmpty(input.sceneAssetId);
  if (explicitSceneAssetId) {
    const preservedFingerprint = toTextOrEmpty(existingScenePreparation.fingerprint);
    const scenePreparation = {
      ...existingScenePreparation,
      ...buildScenePreparationPayload({
        source: "explicit_override",
        sceneAssetId: explicitSceneAssetId,
        fingerprint: preservedFingerprint || undefined,
        cacheHit: false,
      }),
    };
    return {
      status: "ready",
      sceneAssetId: explicitSceneAssetId,
      scenePreparation,
      ...(preservedFingerprint ? { fingerprint: preservedFingerprint } : {}),
      cacheHit: false,
      diagnostics: [],
    };
  }

  const sceneAssetIdFromSnapshot = resolveSceneAssetIdFromSnapshotTrainingAsset(snapshot);
  if (sceneAssetIdFromSnapshot?.sceneAssetId) {
    const preservedFingerprint = toTextOrEmpty(existingScenePreparation.fingerprint);
    const scenePreparation = {
      ...existingScenePreparation,
      ...buildScenePreparationPayload({
        source: "snapshot_training_asset",
        sceneAssetId: sceneAssetIdFromSnapshot.sceneAssetId,
        fingerprint: preservedFingerprint || undefined,
        cacheHit: false,
        sourceAssetId: sceneAssetIdFromSnapshot.sourceAssetId,
        entityId: sceneAssetIdFromSnapshot.entityId,
      }),
    };
    return {
      status: "ready",
      sceneAssetId: sceneAssetIdFromSnapshot.sceneAssetId,
      scenePreparation,
      ...(preservedFingerprint ? { fingerprint: preservedFingerprint } : {}),
      cacheHit: false,
      diagnostics: [],
    };
  }

  if (!snapshot) {
    return buildBlockedNoSceneResult({
      diagnostics: [
        {
          code: "EDITOR_SCENE_SNAPSHOT_MISSING",
          message: "A compiled editor scene snapshot is required before scene preparation can run.",
          severity: "error",
        },
      ],
    });
  }

  const buildSceneCompositionPlanFn = input.buildSceneCompositionPlanFn ?? buildSceneCompositionPlan;
  const buildSceneCompositionSignatureFn =
    input.buildSceneCompositionSignatureFn ?? buildSceneCompositionSignature;
  const composeAndUploadEnvironmentSceneAssetFn =
    input.composeAndUploadEnvironmentSceneAssetFn ?? composeAndUploadEnvironmentSceneAsset;
  const getCachedSceneCompositionFn = input.getCachedSceneCompositionFn ?? getCachedSceneComposition;
  const setCachedSceneCompositionFn = input.setCachedSceneCompositionFn ?? setCachedSceneComposition;

  const scenePlan = buildSceneCompositionPlanFn(snapshot);
  const compositionSignature = buildSceneCompositionSignatureFn({
    nodes: scenePlan.nodes,
    sources: scenePlan.sources,
    assets,
  });
  const fingerprint = buildPreparationFingerprint({
    compositionSignature,
    placements,
    profileId: input.profileId,
    baseTaskId: input.baseTaskId,
    taskTemplate: input.taskTemplate,
    task: input.task,
    recipeId: input.recipeId,
    envId: input.envId,
  });
  const diagnostics = toCompositionDiagnostics(scenePlan);
  const sourceCount = scenePlan.sources.length;
  const entityCount = scenePlan.nodes.length;

  if (entityCount === 0 || sourceCount === 0) {
    return buildBlockedNoSceneResult({
      fingerprint,
      scenePreparation: buildScenePreparationPayload({
        source: "composition_blocked",
        fingerprint,
        compositionSignature,
        cacheHit: false,
        sourceCount,
        entityCount,
      }),
      diagnostics: [
        ...diagnostics,
        {
          code: "EDITOR_SCENE_PREPARATION_NO_COMPOSABLE_SCENE",
          message: "Editor scene preparation finished without a composable scene asset.",
          severity: "error",
        },
      ],
    });
  }

  if (diagnostics.some((item) => item.severity === "error")) {
    return buildBlockedNoSceneResult({
      fingerprint,
      scenePreparation: buildScenePreparationPayload({
        source: "composition_blocked",
        fingerprint,
        compositionSignature,
        cacheHit: false,
        sourceCount,
        entityCount,
      }),
      diagnostics,
    });
  }

  const cachedComposition = getCachedSceneCompositionFn(compositionSignature);
  if (cachedComposition?.sceneAssetId) {
    const scenePreparation = {
      ...(cachedComposition.scenePreparation ? cloneJson(cachedComposition.scenePreparation) : {}),
      ...buildScenePreparationPayload({
        source: "composition_cache",
        sceneAssetId: cachedComposition.sceneAssetId,
        fingerprint: cachedComposition.fingerprint ?? fingerprint,
        compositionSignature,
        cacheHit: true,
        sourceCount,
        entityCount,
      }),
    };
    return {
      status: "ready",
      sceneAssetId: cachedComposition.sceneAssetId,
      scenePreparation,
      fingerprint: cachedComposition.fingerprint ?? fingerprint,
      cacheHit: true,
      diagnostics,
    };
  }

  const sceneComposition = await composeAndUploadEnvironmentSceneAssetFn({
    environment: snapshot,
    assets,
  });
  if (!sceneComposition?.sceneAssetId) {
    return buildBlockedNoSceneResult({
      fingerprint,
      scenePreparation: buildScenePreparationPayload({
        source: "composition_blocked",
        fingerprint,
        compositionSignature,
        cacheHit: false,
        sourceCount,
        entityCount,
      }),
      diagnostics: [
        ...diagnostics,
        {
          code: "EDITOR_SCENE_PREPARATION_FAILED",
          message: "Editor scene preparation did not produce a usable scene asset.",
          severity: "error",
        },
      ],
    });
  }

  const scenePreparation = buildScenePreparationPayload({
    source: "composition_upload",
    sceneAssetId: sceneComposition.sceneAssetId,
    fingerprint,
    compositionSignature: sceneComposition.signature,
    cacheHit: false,
    sourceCount: sceneComposition.sourceCount,
    entityCount: sceneComposition.entityCount,
    entryPath: sceneComposition.entryPath,
  });
  setCachedSceneCompositionFn(sceneComposition.signature, {
    sceneAssetId: sceneComposition.sceneAssetId,
    fingerprint,
    scenePreparation,
  });

  return {
    status: "ready",
    sceneAssetId: sceneComposition.sceneAssetId,
    scenePreparation,
    fingerprint,
    cacheHit: false,
    diagnostics: [
      ...diagnostics,
      ...sceneComposition.diagnostics.map((item) => ({
        code: item.code,
        message: item.message,
        severity: item.severity === "error" ? ("error" as const) : ("warning" as const),
      })),
    ],
  };
}
