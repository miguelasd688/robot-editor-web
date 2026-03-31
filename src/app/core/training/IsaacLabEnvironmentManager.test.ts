import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentDoc } from "../editor/document/types";
import type { SubmitTrainingJobInput } from "../plugins/types";

const compileProjectDocMock = vi.fn();
const getTrainingContextMock = vi.fn();
const getEditorDocMock = vi.fn();
const buildTrainingEnvironmentMock = vi.fn();
const buildTrainingAgentMock = vi.fn();
const buildTrainingRuntimeMock = vi.fn();

vi.mock("../environment/EnvironmentCompilationManager", () => ({
  environmentCompilationManager: {
    compileProjectDoc: compileProjectDocMock,
  },
}));

vi.mock("../store/useTrainingImportContextStore", () => ({
  useTrainingImportContextStore: {
    getState: getTrainingContextMock,
  },
}));

vi.mock("../editor/engineSingleton", () => ({
  editorEngine: {
    getDoc: getEditorDocMock,
  },
}));

vi.mock("./builders/buildTrainingEnvironment", () => ({
  buildTrainingEnvironment: buildTrainingEnvironmentMock,
}));

vi.mock("./builders/buildTrainingAgent", () => ({
  buildTrainingAgent: buildTrainingAgentMock,
}));

vi.mock("./builders/buildTrainingRuntime", () => ({
  buildTrainingRuntime: buildTrainingRuntimeMock,
}));

import { IsaacLabEnvironmentManager } from "./IsaacLabEnvironmentManager";

function createSnapshot(): EnvironmentDoc {
  return {
    version: 1,
    assets: {},
    entities: {},
    roots: [],
    simulation: {
      gravity: [0, 0, -9.81],
      timestep: 0.002,
      substeps: 1,
      solver: "auto",
      contactModel: "auto",
    },
    diagnostics: [],
    updatedAt: new Date().toISOString(),
  };
}

function createSubmitInput(): SubmitTrainingJobInput {
  return {
    modelName: "model-a",
    dataset: "dataset-a",
    epochs: 200,
    maxSteps: 500,
    tenantId: "tenant-alpha",
    experimentName: "exp-alpha",
    seed: 9,
  };
}

describe("IsaacLabEnvironmentManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEditorDocMock.mockReturnValue({ version: 2 });
    getTrainingContextMock.mockReturnValue({
      robotUsdKey: "library/robots/ur10/Legacy/ur10.usd",
      terrainUsdKey: "library/floors/flat_floor/flat_floor.usda",
      terrainMode: "usd",
      diagnostics: [{ code: "CTX_WARN", severity: "warning", source: "training", message: "ctx warning" }],
    });
    compileProjectDocMock.mockReturnValue({
      target: "training",
      stats: { nodeCount: 1 },
      diagnostics: [{ code: "DOC_WARN", severity: "warning", source: "document", message: "doc warning" }],
      environment: createSnapshot(),
    });
    buildTrainingEnvironmentMock.mockResolvedValue({
      environment: {
        id: "custom_environment",
        sourceOfTruth: "project_doc_environment_v1",
        snapshot: null,
        profileId: "ant",
        profileVersion: "v1",
        baseTaskId: "isaaclab.ant.manager.v1",
        registrationId: "ant_manager",
        agentPresetId: "rsl_rl_ppo",
        authoredProfileContract: {
          profileId: "ant",
          profileVersion: "v1",
          registrationId: "ant_manager",
          catalogVersion: "2026-03-23",
          baseTaskId: "isaaclab.ant.manager.v1",
          taskTemplate: "ant_manager",
          task: "Isaac-Ant-v0",
          sourceMode: "profile_example",
          authoringSurfaceSource: "canonical_profile_catalog",
          policyTermsStatus: "partial",
          sourceFilesUsed: ["training-examples/ant/sample.yaml"],
          diagnostics: [],
          authoredObservables: [{ id: "joint_pos", expr: "robot.joint_pos", enabled: true }],
          authoredActions: [{ id: "joint_targets", expr: "continuous[-1,1]", enabled: true }],
          authoredResets: [{ id: "reset_root_state_uniform", expr: "pose_range(...)", enabled: true }],
          authoredTerminations: [{ id: "time_out", expr: "episode.step >= max_steps", enabled: true }],
        },
        editorSceneContract: {
          contractVersion: "v1",
          profileId: "ant",
          baseTaskId: "isaaclab.ant.manager.v1",
          taskTemplate: "ant_manager",
          task: "Isaac-Ant-v0",
          robotAssetId: "robot_asset",
          primaryRobot: {
            entityId: "robot_root",
            name: "Robot",
            assetId: "robot_asset",
            sourceKind: "usd",
          },
          sceneAssetId: "scene_asset",
          placements: [],
          terrain: {
            mode: "usd",
            sourceKind: "usd",
            assetId: "scene_asset",
            entityCount: 0,
          },
          sceneEntitiesSummary: {},
          sourceKinds: {},
          sourcePipeline: {},
          resolvedLaunchPlan: {},
          effectiveScenePolicy: {},
          sourceHints: {},
          scenePreparation: {},
          generatedAt: new Date().toISOString(),
        },
      },
      diagnostics: [{ code: "ENV_WARN", severity: "warning", source: "training", message: "env warning" }],
    });
    buildTrainingAgentMock.mockReturnValue({
      trainer: "rsl_rl",
      policy: {},
    });
    buildTrainingRuntimeMock.mockReturnValue({
      backend: "isaac_lab",
      maxSteps: 500,
    });
  });

  it("orchestrates compile + builders and returns assembled custom request", async () => {
    const manager = new IsaacLabEnvironmentManager();
    const submit = createSubmitInput();
    const result = await manager.buildCustomTaskRequest({
      submit,
      config: {
        dryRun: true,
        experimentName: "exp-from-config",
        editorRobotModel: {
          contractVersion: "editor_robot_model_v1",
          robotId: "robot_root",
          robotName: "Robot",
          actuatorCount: 8,
          dofCount: 8,
          jointCount: 8,
          actuators: [],
          joints: [],
        },
      },
    });

    expect(compileProjectDocMock).toHaveBeenCalledTimes(1);
    expect(compileProjectDocMock).toHaveBeenCalledWith({
      doc: { version: 2 },
      target: "training",
    });
    expect(buildTrainingEnvironmentMock).toHaveBeenCalledTimes(1);
    const buildEnvironmentArgs = buildTrainingEnvironmentMock.mock.calls[0]?.[0] as {
      diagnostics: Array<{ code: string }>;
      compilationTarget: string;
      sceneEligibility?: {
        primaryRobotEntityId: string | null;
        robotCount: number;
      };
    };
    expect(buildEnvironmentArgs.compilationTarget).toBe("training");
    expect(buildEnvironmentArgs.diagnostics.map((item) => item.code)).toEqual(["CTX_WARN", "DOC_WARN"]);
    expect(buildEnvironmentArgs.sceneEligibility?.primaryRobotEntityId).toBeNull();
    expect(buildEnvironmentArgs.sceneEligibility?.robotCount).toBe(0);

    expect(buildTrainingAgentMock).toHaveBeenCalledTimes(1);
    expect(buildTrainingRuntimeMock).toHaveBeenCalledTimes(1);
    expect(buildTrainingRuntimeMock).toHaveBeenCalledWith({
      maxSteps: 500,
      configValues: { dryRun: true, experimentName: "exp-from-config" },
    });

    expect(result.request.sourcePayloadVersion).toBe("training_task_source_v2");
    expect(result.request.tenantId).toBe("tenant-alpha");
    expect(result.request.experimentName).toBe("exp-alpha");
    expect(result.request.seed).toBe(9);
    expect(result.request.dryRun).toBe(true);
      expect(result.request.environment).toEqual({
        id: "custom_environment",
        sourceOfTruth: "project_doc_environment_v1",
        snapshot: null,
        profileId: "ant",
        profileVersion: "v1",
        baseTaskId: "isaaclab.ant.manager.v1",
        registrationId: "ant_manager",
        agentPresetId: "rsl_rl_ppo",
        authoredProfileContract: {
          profileId: "ant",
          profileVersion: "v1",
          registrationId: "ant_manager",
          catalogVersion: "2026-03-23",
          baseTaskId: "isaaclab.ant.manager.v1",
          taskTemplate: "ant_manager",
          task: "Isaac-Ant-v0",
          sourceMode: "profile_example",
          authoringSurfaceSource: "canonical_profile_catalog",
          policyTermsStatus: "partial",
          sourceFilesUsed: ["training-examples/ant/sample.yaml"],
          diagnostics: [],
          authoredObservables: [{ id: "joint_pos", expr: "robot.joint_pos", enabled: true }],
          authoredActions: [{ id: "joint_targets", expr: "continuous[-1,1]", enabled: true }],
          authoredResets: [{ id: "reset_root_state_uniform", expr: "pose_range(...)", enabled: true }],
          authoredTerminations: [{ id: "time_out", expr: "episode.step >= max_steps", enabled: true }],
        },
        editorSceneContract: {
          contractVersion: "v1",
          profileId: "ant",
          baseTaskId: "isaaclab.ant.manager.v1",
        taskTemplate: "ant_manager",
        task: "Isaac-Ant-v0",
        robotAssetId: "robot_asset",
        primaryRobot: {
          entityId: "robot_root",
          name: "Robot",
          assetId: "robot_asset",
          sourceKind: "usd",
        },
        sceneAssetId: "scene_asset",
        placements: [],
        terrain: {
          mode: "usd",
          sourceKind: "usd",
          assetId: "scene_asset",
          entityCount: 0,
        },
        sceneEntitiesSummary: {},
        sourceKinds: {},
        sourcePipeline: {},
        resolvedLaunchPlan: {},
        effectiveScenePolicy: {},
        sourceHints: {},
        scenePreparation: {},
        generatedAt: result.request.environment.editorSceneContract.generatedAt,
      },
    });
    expect(result.request.agent).toEqual({
      trainer: "rsl_rl",
      policy: {},
    });
    expect(result.request.runtime).toEqual({
      backend: "isaac_lab",
      maxSteps: 500,
    });
    expect(result.request.profileId).toBe("ant");
    expect(result.request.profileVersion).toBe("v1");
    expect(result.request.baseTaskId).toBe("isaaclab.ant.manager.v1");
    expect(result.request.registrationId).toBe("ant_manager");
    expect(result.request.authoredProfileContract).toMatchObject({
      profileId: "ant",
      registrationId: "ant_manager",
      catalogVersion: "2026-03-23",
      policyTermsStatus: "partial",
    });
    expect(result.request.environment.authoredProfileContract).toMatchObject({
      profileId: "ant",
      registrationId: "ant_manager",
      catalogVersion: "2026-03-23",
      policyTermsStatus: "partial",
    });
    expect(result.request.authoredProfileContract?.authoredObservables).toHaveLength(1);
    expect(result.request.authoredProfileContract?.authoredActions).toHaveLength(1);
    expect(result.request.authoredProfileContract?.authoredResets).toHaveLength(1);
    expect(result.request.authoredProfileContract?.authoredTerminations).toHaveLength(1);
    expect(result.request.environment.authoredProfileContract?.authoredObservables).toHaveLength(1);
    expect(result.request.environment.authoredProfileContract?.authoredActions).toHaveLength(1);
    expect(result.request.environment.authoredProfileContract?.authoredResets).toHaveLength(1);
    expect(result.request.environment.authoredProfileContract?.authoredTerminations).toHaveLength(1);
    expect(result.request.agentPresetId).toBe("rsl_rl_ppo");
    expect(result.request.editorRobotModel).toEqual({
      contractVersion: "editor_robot_model_v1",
      robotId: "robot_root",
      robotName: "Robot",
      actuatorCount: 8,
      dofCount: 8,
      jointCount: 8,
      actuators: [],
      joints: [],
    });
    expect(result.request.editorSceneContract?.profileId).toBe("ant");
    expect(result.request.editorSceneContract?.baseTaskId).toBe("isaaclab.ant.manager.v1");
    expect(result.diagnostics.map((item) => item.code)).toEqual(["ENV_WARN"]);
  });
});
