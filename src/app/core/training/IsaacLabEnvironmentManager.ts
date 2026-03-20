import { editorEngine } from "../editor/engineSingleton";
import { environmentCompilationManager } from "../environment/EnvironmentCompilationManager";
import { useTrainingImportContextStore } from "../store/useTrainingImportContextStore";
import { buildTrainingAgent } from "./builders/buildTrainingAgent";
import { buildTrainingEnvironment } from "./builders/buildTrainingEnvironment";
import { buildTrainingRuntime } from "./builders/buildTrainingRuntime";
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
    const compiled = environmentCompilationManager.compileProjectDoc({
      doc: input.doc ?? editorEngine.getDoc(),
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
    const builtEnvironment = await buildTrainingEnvironment({
      submit: input.submit,
      configValues,
      compiledEnvironment: compiled.environment,
      compilationTarget: compiled.target,
      compilationStats: toObjectOrEmpty(compiled.stats),
      context: {
        robotUsdKey: context.robotUsdKey,
        terrainUsdKey: context.terrainUsdKey,
        terrainMode: context.terrainMode,
      },
      diagnostics,
    });
    const agent = buildTrainingAgent({ configValues });
    const runtime = buildTrainingRuntime({
      maxSteps,
      configValues,
    });

    const request: CustomTrainingTaskRequest = {
      tenantId: input.submit.tenantId,
      experimentName,
      seed: Number.isInteger(input.submit.seed) ? input.submit.seed : undefined,
      environment: builtEnvironment.environment,
      agent,
      runtime,
      dryRun: configValues.dryRun === true,
    };
    return {
      request,
      diagnostics: builtEnvironment.diagnostics,
    };
  }
}

export const isaacLabEnvironmentManager = new IsaacLabEnvironmentManager();
