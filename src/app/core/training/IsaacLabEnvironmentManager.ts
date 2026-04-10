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

function resolvePositiveIntAlias(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) continue;
    return Math.max(1, Math.round(parsed));
  }
  return undefined;
}

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
    const maxSteps =
      resolvePositiveIntAlias(configValues, [
        "numberEpisodes",
        "number_episodes",
        "numberOfEpisodes",
        "maxSteps",
        "max_steps",
      ]) ??
      resolvePositiveIntAlias(input.submit as unknown as Record<string, unknown>, ["maxSteps"]) ??
      1;
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
    const editorRobotModel =
      configValues.editorRobotModel && typeof configValues.editorRobotModel === "object"
        ? (configValues.editorRobotModel as CustomTrainingTaskRequest["editorRobotModel"])
        : undefined;

    const request: CustomTrainingTaskRequest = {
      sourcePayloadVersion,
      tenantId: input.submit.tenantId,
      experimentName,
      seed: Number.isInteger(input.submit.seed) ? input.submit.seed : undefined,
      environment: builtEnvironment.environment,
      agent,
      runtime,
      dryRun: configValues.dryRun === true,
      ...(builtEnvironment.environment.authoredProfileContract
        ? { authoredProfileContract: builtEnvironment.environment.authoredProfileContract }
        : {}),
      profileId: builtEnvironment.environment.profileId,
      profileVersion: builtEnvironment.environment.profileVersion,
      baseTaskId: builtEnvironment.environment.baseTaskId,
      registrationId: builtEnvironment.environment.registrationId,
      agentPresetId: builtEnvironment.environment.agentPresetId,
      ...(builtEnvironment.environment.adapterId ? { adapterId: builtEnvironment.environment.adapterId } : {}),
      ...(configValues.adapterVersion ? { adapterVersion: String(configValues.adapterVersion) } : {}),
      ...(editorRobotModel ? { editorRobotModel } : {}),
      editorSceneContract: builtEnvironment.environment.editorSceneContract,
      // Pass canonical compiled artifacts from dry-run preview when present in configValues.
      // These become the launch authority for registrationId / taskFingerprint / embodiment.
      ...(configValues.experimentTaskRegistration && typeof configValues.experimentTaskRegistration === "object"
        ? { experimentTaskRegistration: configValues.experimentTaskRegistration as Record<string, unknown> }
        : {}),
      ...(configValues.experimentTaskSpec && typeof configValues.experimentTaskSpec === "object"
        ? {
            experimentTaskSpec: configValues.experimentTaskSpec as CustomTrainingTaskRequest["experimentTaskSpec"],
          }
        : {}),
      ...(configValues.adapterSelection && typeof configValues.adapterSelection === "object"
        ? { adapterSelection: configValues.adapterSelection as Record<string, unknown> }
        : {}),
      ...(configValues.experimentContext && typeof configValues.experimentContext === "object"
        ? { experimentContext: configValues.experimentContext as Record<string, unknown> }
        : {}),
      ...(configValues.sceneActivation && typeof configValues.sceneActivation === "object"
        ? { sceneActivation: configValues.sceneActivation as Record<string, unknown> }
        : {}),
      ...(configValues.robotEmbodimentSpec && typeof configValues.robotEmbodimentSpec === "object"
        ? { robotEmbodimentSpec: configValues.robotEmbodimentSpec as Record<string, unknown> }
        : {}),
      ...(configValues.taskFingerprint ? { taskFingerprint: String(configValues.taskFingerprint) } : {}),
      ...(configValues.experimentTaskId ? { experimentTaskId: String(configValues.experimentTaskId) } : {}),
      ...(configValues.experimentId ? { experimentId: String(configValues.experimentId) } : {}),
      ...(configValues.experimentRevisionId ? { experimentRevisionId: String(configValues.experimentRevisionId) } : {}),
      ...(configValues.compatibilitySignature && typeof configValues.compatibilitySignature === "object"
        ? { compatibilitySignature: configValues.compatibilitySignature as Record<string, unknown> }
        : {}),
    };
    return {
      request,
      diagnostics: builtEnvironment.diagnostics,
    };
  }
}

export const isaacLabEnvironmentManager = new IsaacLabEnvironmentManager();
