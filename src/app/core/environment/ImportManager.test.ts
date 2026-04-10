import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  loadWorkspaceUSDIntoViewerMock,
  getEnvironmentMock,
  buildImportDiagnosticMock,
  editorExecuteMock,
  editorGetDocMock,
  editorOnMock,
  useAppStoreGetStateMock,
  useMujocoStoreGetStateMock,
  setNodeTransformCommandMock,
} = vi.hoisted(() => ({
  loadWorkspaceUSDIntoViewerMock: vi.fn(),
  getEnvironmentMock: vi.fn(),
  buildImportDiagnosticMock: vi.fn(),
  editorExecuteMock: vi.fn(),
  editorGetDocMock: vi.fn(() => ({
    scene: {
      nodes: {},
      roots: [],
      selectedId: null,
    },
  })),
  editorOnMock: vi.fn(() => vi.fn()),
  useAppStoreGetStateMock: vi.fn(),
  useMujocoStoreGetStateMock: vi.fn(),
  setNodeTransformCommandMock: vi.fn((rootId: string, transform: unknown) => ({
    rootId,
    transform,
  })),
}));

vi.mock("../loaders/usdLoader", () => ({
  loadWorkspaceUSDIntoViewer: loadWorkspaceUSDIntoViewerMock,
}));

vi.mock("../environment/EnvironmentDocumentManager", () => ({
  environmentDocumentManager: {
    getEnvironment: getEnvironmentMock,
    buildImportDiagnostic: buildImportDiagnosticMock,
  },
}));

vi.mock("../editor/engineSingleton", () => ({
  editorEngine: {
    execute: editorExecuteMock,
    getDoc: editorGetDocMock,
    on: editorOnMock,
  },
}));

vi.mock("../editor/commands/sceneCommands", () => ({
  setNodeTransformCommand: setNodeTransformCommandMock,
}));

vi.mock("../store/useAppStore", () => ({
  useAppStore: {
    getState: useAppStoreGetStateMock,
  },
}));

vi.mock("../store/useMujocoStore", () => ({
  useMujocoStore: {
    getState: useMujocoStoreGetStateMock,
  },
}));

vi.mock("../editor/actions/sceneAssetActions", () => ({
  addSceneAsset: vi.fn(),
}));

import { importManager } from "./ImportManager";

function createDoc() {
  return {
    scene: {
      nodes: {
        robot_root: {
          id: "robot_root",
          name: "Robot",
          components: {
            transform: {
              position: { x: 0, y: 0, z: 0 },
              rotation: { x: 0, y: 0, z: 0 },
              scale: { x: 1, y: 1, z: 1 },
            },
          },
        },
        floor_root: {
          id: "floor_root",
          name: "Floor",
          components: {
            transform: {
              position: { x: 0, y: 0, z: 0 },
              rotation: { x: 0, y: 0, z: 0 },
              scale: { x: 1, y: 1, z: 1 },
            },
          },
        },
      },
    },
  };
}

describe("ImportManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    editorGetDocMock.mockReturnValue(createDoc());
    useAppStoreGetStateMock.mockReturnValue({
      viewer: null,
      selected: null,
      setSelected: vi.fn(),
    });
    useMujocoStoreGetStateMock.mockReturnValue({
      reload: vi.fn().mockResolvedValue(undefined),
      lastRuntimeBuildReport: null,
    });
    getEnvironmentMock.mockReturnValue(null);
    buildImportDiagnosticMock.mockImplementation(({ code, severity, message, context }) => ({
      code,
      severity,
      source: "import",
      message,
      context,
    }));
  });

  it("applies the compiled profile-example robot pose before importing other scene assets", async () => {
    loadWorkspaceUSDIntoViewerMock
      .mockResolvedValueOnce({ rootId: "robot_root" })
      .mockResolvedValueOnce({ rootId: "floor_root" });

    const result = await importManager.executeUsdImportPlan({
      assets: {
        "library/robots/ant/ant.usd": {
          id: "robot_asset",
          kind: "usd",
          role: "robot",
          workspaceKey: "library/robots/ant/ant.usd",
        },
        "library/floors/flat_floor/flat_floor.usda": {
          id: "floor_asset",
          kind: "usd",
          role: "terrain",
          workspaceKey: "library/floors/flat_floor/flat_floor.usda",
        },
      } as any,
      robotUsdKey: "library/robots/ant/ant.usd",
      robotTransform: {
        position: { x: 0.11, y: -0.22, z: 0.42 },
        rotationDeg: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      replaceFullScene: false,
      actions: [
        {
          kind: "usd_bundle",
          usdKey: "library/floors/flat_floor/flat_floor.usda",
          sceneRole: "terrain",
          rootName: "floor_root",
        },
      ],
      options: {},
    });

    expect(result.ok).toBe(true);
    expect(loadWorkspaceUSDIntoViewerMock).toHaveBeenCalledTimes(2);
    expect(loadWorkspaceUSDIntoViewerMock.mock.calls[0]?.[0]).toMatchObject({
      usdKey: "library/robots/ant/ant.usd",
      skipPostLoadHook: true,
    });
    expect(loadWorkspaceUSDIntoViewerMock.mock.calls[1]?.[0]).toMatchObject({
      usdKey: "library/floors/flat_floor/flat_floor.usda",
      skipPostLoadHook: true,
      sceneRole: "scene_asset",
      rootName: "floor_root",
    });

    expect(setNodeTransformCommandMock).toHaveBeenCalledTimes(1);
    expect(setNodeTransformCommandMock).toHaveBeenCalledWith("robot_root", {
      position: { x: 0.11, y: -0.22, z: 0.42 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    });
    expect(editorExecuteMock).toHaveBeenCalledTimes(1);
    expect(editorExecuteMock).toHaveBeenCalledWith({
      rootId: "robot_root",
      transform: {
        position: { x: 0.11, y: -0.22, z: 0.42 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
  });
});
