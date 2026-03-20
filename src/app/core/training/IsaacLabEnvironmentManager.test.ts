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
      config: { dryRun: true, experimentName: "exp-from-config" },
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
    };
    expect(buildEnvironmentArgs.compilationTarget).toBe("training");
    expect(buildEnvironmentArgs.diagnostics.map((item) => item.code)).toEqual(["CTX_WARN", "DOC_WARN"]);

    expect(buildTrainingAgentMock).toHaveBeenCalledTimes(1);
    expect(buildTrainingRuntimeMock).toHaveBeenCalledTimes(1);
    expect(buildTrainingRuntimeMock).toHaveBeenCalledWith({
      maxSteps: 500,
      configValues: { dryRun: true, experimentName: "exp-from-config" },
    });

    expect(result.request.tenantId).toBe("tenant-alpha");
    expect(result.request.experimentName).toBe("exp-alpha");
    expect(result.request.seed).toBe(9);
    expect(result.request.dryRun).toBe(true);
    expect(result.request.environment).toEqual({
      id: "custom_environment",
      sourceOfTruth: "project_doc_environment_v1",
      snapshot: null,
    });
    expect(result.request.agent).toEqual({
      trainer: "rsl_rl",
      policy: {},
    });
    expect(result.request.runtime).toEqual({
      backend: "isaac_lab",
      maxSteps: 500,
    });
    expect(result.diagnostics.map((item) => item.code)).toEqual(["ENV_WARN"]);
  });
});
