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
};

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
  const robotAssetId = toTextOrEmpty(configValues.robotAssetId);
  const sceneAssetId = toTextOrEmpty(configValues.sceneAssetId) || toTextOrEmpty(environmentValues.sceneAssetId);
  const metadata = toObjectOrEmpty(configValues.userModelMetadata);

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
    sceneAssetId: sceneAssetId || undefined,
    robotUsdKey: input.context.robotUsdKey,
    terrainUsdKey: input.context.terrainUsdKey,
    terrainMode: input.context.terrainMode,
    robotUsdOverridePath: environmentOverrides.robotUsdOverridePath,
    sceneUsdOverridePath: environmentOverrides.sceneUsdOverridePath,
    sceneUsdTypeOverridePath: environmentOverrides.sceneUsdTypeOverridePath,
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
      ...metadata,
      ...environmentValues,
      compilationTarget: input.compilationTarget,
      compilationStats: input.compilationStats,
    },
  };

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
      environment.terrainMode = "usd";
      environment.sceneTerrainType = "usd";
      environment.sceneUsdTypeValue = "usd";
      environment.metadata = {
        ...(environment.metadata ?? {}),
        sceneComposition: {
          applied: true,
          fromCache: true,
          sceneAssetId: cachedSceneAssetId,
          sourceCount: scenePlan.sources.length,
          entityCount: scenePlan.nodes.length,
        },
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
          environment.terrainMode = "usd";
          environment.sceneTerrainType = "usd";
          environment.sceneUsdTypeValue = "usd";
          environment.metadata = {
            ...(environment.metadata ?? {}),
            sceneComposition: {
              applied: true,
              fromCache: false,
              sceneAssetId: sceneComposition.sceneAssetId,
              sourceCount: sceneComposition.sourceCount,
              entityCount: sceneComposition.entityCount,
              entryPath: sceneComposition.entryPath,
            },
          };
          setCachedSceneAssetIdFn(sceneComposition.signature, sceneComposition.sceneAssetId);
        }
      }
    }
  }

  return {
    environment,
    diagnostics,
  };
}
