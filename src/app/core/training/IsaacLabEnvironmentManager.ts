import { editorEngine } from "../editor/engineSingleton";
import { environmentCompilationManager } from "../environment/EnvironmentCompilationManager";
import { useMujocoStore } from "../store/useMujocoStore";
import { useTrainingImportContextStore } from "../store/useTrainingImportContextStore";
import { buildTrainingAgent } from "./builders/buildTrainingAgent";
import { buildTrainingEnvironment } from "./builders/buildTrainingEnvironment";
import { buildTrainingRuntime } from "./builders/buildTrainingRuntime";
import { deriveSceneTrainingEligibility } from "./sceneTrainingEligibility";
import type {
  BuildCustomTaskRequestInput,
  CustomTrainingTaskBuildResult,
  CustomTrainingTaskRequest,
} from "./builders/trainingRequestTypes";
import {
  mergeDiagnostics,
  normalizeDiagnostics,
  toObjectOrEmpty,
  toTextOrEmpty,
} from "./builders/trainingBuildUtils";

export type {
  BuildCustomTaskRequestInput,
  CustomTrainingTaskBuildResult,
  CustomTrainingTaskRequest,
} from "./builders/trainingRequestTypes";

export class IsaacLabEnvironmentManager {
  async buildCustomTaskRequest(input: BuildCustomTaskRequestInput): Promise<CustomTrainingTaskBuildResult> {
    const configValues = toObjectOrEmpty(input.config);
    const context = useTrainingImportContextStore.getState();
    const sourceDoc = input.doc ?? editorEngine.getDoc();
    const compiled = environmentCompilationManager.compileProjectDoc({
      doc: sourceDoc,
      target: "training",
    });
    const diagnostics = mergeDiagnostics(
      normalizeDiagnostics(context.diagnostics),
      normalizeDiagnostics(compiled.diagnostics)
    );
    const experimentName =
      toTextOrEmpty(input.submit.experimentName) ||
      toTextOrEmpty(configValues.experimentName) ||
      input.submit.modelName ||
      "custom-experiment";
    const maxSteps = Math.max(1, Math.round(input.submit.maxSteps ?? input.submit.epochs));
    const sceneEligibility = deriveSceneTrainingEligibility(compiled);
    const builtEnvironment = await buildTrainingEnvironment({
      submit: input.submit,
      configValues,
      compiledEnvironment: compiled.environment,
      compilationTarget: compiled.target,
      compilationStats: toObjectOrEmpty(compiled.stats),
      sceneEligibility,
      context: {
        robotUsdKey: context.robotUsdKey,
        terrainUsdKey: context.terrainUsdKey,
        terrainMode: context.terrainMode,
      },
      sourceSceneNodes: sourceDoc.scene.nodes,
      actuatorRegistryByRobot: useMujocoStore.getState().actuatorRegistryByRobot,
      diagnostics,
    });
    const agent = buildTrainingAgent({ configValues });
    const runtime = buildTrainingRuntime({
      maxSteps,
      configValues,
    });
    const sourcePayloadVersion: CustomTrainingTaskRequest["sourcePayloadVersion"] = "training_task_source_v2";

    const request: CustomTrainingTaskRequest = {
      sourcePayloadVersion,
      tenantId: input.submit.tenantId,
      experimentName,
      seed: Number.isInteger(input.submit.seed) ? input.submit.seed : undefined,
      environment: builtEnvironment.environment,
      agent,
      runtime,
      dryRun: configValues.dryRun === true,
      profileId: builtEnvironment.environment.profileId,
      profileVersion: builtEnvironment.environment.profileVersion,
      baseTaskId: builtEnvironment.environment.baseTaskId,
      registrationId: builtEnvironment.environment.registrationId,
      agentPresetId: builtEnvironment.environment.agentPresetId,
      ...(builtEnvironment.environment.adapterId ? { adapterId: builtEnvironment.environment.adapterId } : {}),
      editorSceneContract: builtEnvironment.environment.editorSceneContract,
    };
    return {
      request,
      diagnostics: builtEnvironment.diagnostics,
    };
  }
}

export const isaacLabEnvironmentManager = new IsaacLabEnvironmentManager();
