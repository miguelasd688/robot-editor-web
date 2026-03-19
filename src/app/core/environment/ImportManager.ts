import * as THREE from "three";
import type { AssetEntry } from "../assets/assetRegistryTypes";
import { addSceneAsset } from "../editor/actions/sceneAssetActions";
import { getThreeAdapter } from "../editor/adapters/three/adapterSingleton";
import { setNodeTransformCommand } from "../editor/commands/sceneCommands";
import { editorEngine } from "../editor/engineSingleton";
import type { EnvironmentDiagnostic, EnvironmentDoc } from "../editor/document/types";
import { loadWorkspaceURDFIntoViewer } from "../loaders/urdfLoader";
import { loadWorkspaceUSDIntoViewer } from "../loaders/usdLoader";
import { getDocId } from "../scene/docIds";
import type { SceneAssetId } from "../scene/sceneAssets";
import { logInfo } from "../services/logger";
import { useAppStore } from "../store/useAppStore";
import { useLoaderStore } from "../store/useLoaderStore";
import { useMujocoStore } from "../store/useMujocoStore";
import { useSceneStore } from "../store/useSceneStore";
import type { UrdfImportOptions } from "../urdf/urdfImportOptions";
import type { UsdImportOptions } from "../usd/usdImportOptions";
import type { RuntimeBuildReport, SceneAssetCollisionCoverage } from "../physics/mujoco/runtimeBuildReport";
import { environmentDocumentManager } from "./EnvironmentDocumentManager";

export type ImportManagerResult = {
  ok: boolean;
  rootId: string | null;
  environment: EnvironmentDoc | null;
  diagnostics: EnvironmentDiagnostic[];
};

export type ImportExecutionAction =
  | {
      kind: "generated_scene_asset";
      sceneAssetId: SceneAssetId;
    }
  | {
      kind: "usd_bundle";
      usdKey: string;
      bundleHintPaths?: string[];
      rootName?: string;
      sceneRole?: "scene_asset" | "terrain";
      frameOnAdd?: boolean;
      transform?: ImportRootTransform;
    };

export type ImportRootTransform = {
  position?: { x: number; y: number; z: number };
  rotationDeg?: { x: number; y: number; z: number };
  scale?: { x: number; y: number; z: number };
};

export type ImportExecutionPlan = {
  assets: Record<string, AssetEntry>;
  robotUsdKey: string;
  robotBundleHintPaths?: string[];
  options: Partial<UsdImportOptions>;
  environmentId?: string | null;
  environmentOverrideActive?: boolean;
  replaceFullScene: boolean;
  actions: ImportExecutionAction[];
  validateSceneAssetCollisions?: boolean;
};

export type ImportExecutionResult = ImportManagerResult & {
  terrainMode: "none" | "usd" | "plane" | "generator";
  terrainUsdKey: string | null;
  runtimeBuildReport: RuntimeBuildReport | null;
  replacedRoots: Array<{ rootId: string; name: string }>;
};

type ImportTransactionSnapshot = {
  replaceFullScene: boolean;
  baselineRootIds: Set<string>;
  detachedRoots: THREE.Object3D[];
  replacedRoots: Array<{ rootId: string; name: string }>;
  selectedSceneId: string | null;
  selectedApp: { id: string; name: string; position: { x: number; y: number; z: number } } | null;
};

function normalizePathToken(value: string | null | undefined): string {
  const raw = String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (!raw) return "";
  const next: string[] = [];
  for (const part of raw.split("/")) {
    const token = part.trim();
    if (!token || token === ".") continue;
    if (token === "..") {
      if (next.length > 0) next.pop();
      continue;
    }
    next.push(token);
  }
  return next.join("/");
}

function dirnamePath(value: string): string {
  const normalized = normalizePathToken(value);
  const idx = normalized.lastIndexOf("/");
  if (idx < 0) return "";
  return normalized.slice(0, idx);
}

function resolveRelativePath(baseFilePath: string, reference: string): string {
  const token = String(reference ?? "").trim();
  if (!token) return "";
  const normalizedRef = token.replace(/\\/g, "/");
  if (/^[a-zA-Z]+:\/\//.test(normalizedRef) || normalizedRef.startsWith("//")) return "";
  if (normalizedRef.startsWith("/")) return normalizePathToken(normalizedRef);
  const baseDir = dirnamePath(baseFilePath);
  return normalizePathToken(baseDir ? `${baseDir}/${normalizedRef}` : normalizedRef);
}

function deriveLibrarySampleRoot(usdKey: string | null | undefined): string {
  const normalized = normalizePathToken(usdKey);
  const parts = normalized.split("/").filter((part) => part.length > 0);
  if (parts.length >= 3 && parts[0] === "library") {
    return `${parts[0]}/${parts[1]}`;
  }
  return "";
}

function resolveBundleHintCandidates(input: {
  hint: string;
  usdKey: string | null | undefined;
  sampleRoot: string;
}): string[] {
  const hintToken = String(input.hint ?? "").trim();
  if (!hintToken) return [];
  const normalizedHint = normalizePathToken(hintToken);
  const normalizedUsdKey = normalizePathToken(input.usdKey);
  const sampleRoot = normalizePathToken(input.sampleRoot);
  const candidates = new Set<string>();
  if (normalizedHint) candidates.add(normalizedHint);
  const relativeFromEntry = resolveRelativePath(normalizedUsdKey, hintToken);
  if (relativeFromEntry) candidates.add(relativeFromEntry);
  if (sampleRoot && normalizedHint) {
    candidates.add(normalizePathToken(`${sampleRoot}/${normalizedHint}`));
  }
  if (sampleRoot) {
    const relativeFromSampleRoot = resolveRelativePath(`${sampleRoot}/entry.usd`, hintToken);
    if (relativeFromSampleRoot) candidates.add(relativeFromSampleRoot);
  }
  return Array.from(candidates).filter((item) => item.length > 0);
}

function snapshotEnvironment() {
  return environmentDocumentManager.getEnvironment(editorEngine.getDoc());
}

function collectImportDiagnostics(environment: EnvironmentDoc | null): EnvironmentDiagnostic[] {
  if (!environment) return [];
  return environment.diagnostics.filter((diagnostic) => diagnostic.source === "import");
}

function successResult(rootId: string | null, diagnostics: EnvironmentDiagnostic[] = []): ImportManagerResult {
  const environment = snapshotEnvironment();
  const importDiagnostics = collectImportDiagnostics(environment);
  const mergedDiagnostics = [...diagnostics, ...importDiagnostics];
  return {
    ok: true,
    rootId,
    environment,
    diagnostics: mergedDiagnostics,
  };
}

function errorResult(diagnostics: EnvironmentDiagnostic[]): ImportManagerResult {
  return {
    ok: false,
    rootId: null,
    environment: snapshotEnvironment(),
    diagnostics,
  };
}

function ensureBundleAssetsExist(
  assets: Record<string, AssetEntry>,
  bundleHintPaths: string[] | null | undefined,
  usdKey: string | null | undefined
): string[] {
  if (!Array.isArray(bundleHintPaths) || bundleHintPaths.length === 0) return [];
  const available = new Set(
    Object.keys(assets)
      .map((key) => normalizePathToken(key))
      .filter((key) => key.length > 0)
  );
  const sampleRoot = deriveLibrarySampleRoot(usdKey);
  const missing: string[] = [];
  for (const hintRaw of bundleHintPaths) {
    const hint = String(hintRaw ?? "").trim();
    if (!hint) continue;
    const candidates = resolveBundleHintCandidates({
      hint,
      usdKey,
      sampleRoot,
    });
    const resolved = candidates.some((candidate) => available.has(candidate));
    if (!resolved) {
      missing.push(normalizePathToken(hint) || hint);
    }
  }
  return missing;
}

function syncSceneFromViewer() {
  const viewer = useAppStore.getState().viewer;
  if (!viewer) return;
  const adapter = getThreeAdapter();
  if (adapter) {
    adapter.syncSceneFromViewer();
    return;
  }
  const snapshot = viewer.getSceneSnapshot();
  useSceneStore.getState().replaceFromSnapshot(snapshot);
}

function captureImportTransactionSnapshot(replaceFullScene: boolean): ImportTransactionSnapshot | null {
  const viewer = useAppStore.getState().viewer;
  if (!viewer) return null;
  const existingRoots = viewer.getUserRoots();
  const replacedRoots = existingRoots.map((root) => ({
    rootId: getDocId(root),
    name: String(root.name ?? "").trim() || getDocId(root),
  }));
  const baselineRootIds = new Set(existingRoots.map((root) => getDocId(root)));
  const detachedRoots = replaceFullScene ? viewer.detachUserRoots() : [];
  return {
    replaceFullScene,
    baselineRootIds,
    detachedRoots,
    replacedRoots,
    selectedSceneId: useSceneStore.getState().selectedId,
    selectedApp: useAppStore.getState().selected,
  };
}

function restoreSelection(selectedId: string | null) {
  if (!selectedId) return;
  const sceneState = useSceneStore.getState();
  if (!sceneState.nodes[selectedId]) return;
  const viewer = useAppStore.getState().viewer;
  sceneState.setSelected(selectedId);
  viewer?.setSelected?.(selectedId);
}

function restoreImportTransactionSnapshot(snapshot: ImportTransactionSnapshot | null): boolean {
  const viewer = useAppStore.getState().viewer;
  if (!viewer || !snapshot) return false;
  if (snapshot.replaceFullScene) {
    useLoaderStore.getState().clear();
    viewer.restoreDetachedUserRoots(snapshot.detachedRoots);
  } else {
    const currentRoots = viewer.getUserRoots();
    for (const root of currentRoots) {
      const rootId = getDocId(root);
      if (snapshot.baselineRootIds.has(rootId)) continue;
      viewer.removeFromUserScene(rootId);
    }
  }
  syncSceneFromViewer();
  restoreSelection(snapshot.selectedSceneId);
  useAppStore.getState().setSelected(snapshot.selectedApp);
  return true;
}

function discardImportTransactionSnapshot(snapshot: ImportTransactionSnapshot | null) {
  const viewer = useAppStore.getState().viewer;
  if (!viewer || !snapshot || !snapshot.replaceFullScene || snapshot.detachedRoots.length === 0) return;
  viewer.disposeDetachedUserRoots(snapshot.detachedRoots);
  snapshot.detachedRoots = [];
}

function extractSceneAssetCollisionFailures(
  report: RuntimeBuildReport | null | undefined
): SceneAssetCollisionCoverage[] {
  if (!report) return [];
  return report.terrainCollisionCoverage.filter(
    (entry) => entry.incomplete && (entry.sourceRole === "scene_asset" || entry.sourceRole === "terrain")
  );
}

function applyImportedRootTransform(rootId: string, transform: ImportRootTransform) {
  const doc = editorEngine.getDoc();
  const node = doc.scene.nodes[rootId];
  if (!node) return;
  const current = node.components?.transform ?? {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  };
  editorEngine.execute(
    setNodeTransformCommand(rootId, {
      position: transform.position ? { ...transform.position } : current.position,
      rotation: transform.rotationDeg ? { ...transform.rotationDeg } : current.rotation,
      scale: transform.scale ? { ...transform.scale } : current.scale,
    })
  );
}

export class ImportManager {
  async import_urdf(input: {
    urdfKey: string | null;
    assets: Record<string, AssetEntry>;
    importOptions?: Partial<UrdfImportOptions>;
  }): Promise<ImportManagerResult> {
    await loadWorkspaceURDFIntoViewer({
      urdfKey: input.urdfKey,
      assets: input.assets,
      importOptions: input.importOptions,
    });
    return successResult(null);
  }

  async import_usd(input: {
    usdKey: string | null;
    assets: Record<string, AssetEntry>;
    importOptions?: Partial<UsdImportOptions>;
    bundleHintPaths?: string[];
    rootName?: string;
    sceneRole?: "robot" | "scene_asset";
    frameOnAdd?: boolean;
    skipPostLoadHook?: boolean;
  }): Promise<ImportManagerResult> {
    const missingBundleAssets = ensureBundleAssetsExist(input.assets, input.bundleHintPaths, input.usdKey);
    if (missingBundleAssets.length > 0) {
      return errorResult([
        environmentDocumentManager.buildImportDiagnostic({
          code: "USD_ENV_BUNDLE_MISSING_ASSETS",
          severity: "error",
          message: "USD environment bundle references files that are not available in workspace assets.",
          context: { missingBundleAssets },
        }),
      ]);
    }

    const loaded = await loadWorkspaceUSDIntoViewer({
      usdKey: input.usdKey,
      assets: input.assets,
      importOptions: input.importOptions,
      bundleHintPaths: input.bundleHintPaths,
      rootName: input.rootName,
      sceneRole: input.sceneRole,
      frameOnAdd: input.frameOnAdd,
      skipPostLoadHook: input.skipPostLoadHook,
    });
    return successResult(loaded?.rootId ?? null);
  }

  async executeUsdImportPlan(plan: ImportExecutionPlan): Promise<ImportExecutionResult> {
    const diagnostics: EnvironmentDiagnostic[] = [];
    const transactionSnapshot = captureImportTransactionSnapshot(plan.replaceFullScene);
    const viewer = useAppStore.getState().viewer;
    const replacedRoots: Array<{ rootId: string; name: string }> = [...(transactionSnapshot?.replacedRoots ?? [])];
    let terrainMode: ImportExecutionResult["terrainMode"] = "none";
    let terrainUsdKey: string | null = null;
    const strictCollisionValidation = plan.validateSceneAssetCollisions !== false;

    if (plan.replaceFullScene && viewer && transactionSnapshot) {
      syncSceneFromViewer();
      logInfo("Import manager: full-scene overwrite applied for USD execution plan", {
        scope: "assets",
        data: {
          robotUsdKey: plan.robotUsdKey,
          environmentId: plan.environmentId ?? null,
          environmentOverrideActive: plan.environmentOverrideActive === true,
          removedRoots: replacedRoots,
        },
      });
    }

    const rollbackWithDiagnostic = (): EnvironmentDiagnostic => {
      const restored = restoreImportTransactionSnapshot(transactionSnapshot);
      if (restored) {
        void useMujocoStore.getState().reload();
      }
      return environmentDocumentManager.buildImportDiagnostic({
        code: "USD_ENV_IMPORT_ROLLBACK_APPLIED",
        severity: restored ? "warning" : "error",
        message: restored
          ? "Environment import rolled back after collision validation/runtime failure."
          : "Environment import rollback failed; scene may be partially updated.",
        context: {
          environmentId: plan.environmentId ?? null,
          robotUsdKey: plan.robotUsdKey,
          replaceFullScene: plan.replaceFullScene,
        },
      });
    };

    const robotImport = await this.import_usd({
      usdKey: plan.robotUsdKey,
      assets: plan.assets,
      importOptions: plan.options,
      bundleHintPaths: plan.robotBundleHintPaths,
      skipPostLoadHook: true,
    });
    diagnostics.push(...robotImport.diagnostics);
    if (!robotImport.ok) {
      diagnostics.push(rollbackWithDiagnostic());
      return {
        ...errorResult(diagnostics),
        terrainMode,
        terrainUsdKey,
        runtimeBuildReport: null,
        replacedRoots,
      };
    }

    for (const action of plan.actions) {
      if (action.kind === "generated_scene_asset") {
        addSceneAsset(action.sceneAssetId);
        if (action.sceneAssetId === "floor") {
          terrainMode = "plane";
          terrainUsdKey = null;
        } else if (action.sceneAssetId === "floor:rough") {
          terrainMode = "generator";
          terrainUsdKey = null;
        }
        continue;
      }

      const envImport = await this.import_usd({
        usdKey: action.usdKey,
        assets: plan.assets,
        importOptions: plan.options,
        bundleHintPaths: action.bundleHintPaths,
        rootName: action.rootName,
        sceneRole: "scene_asset",
        frameOnAdd: action.frameOnAdd ?? false,
        skipPostLoadHook: true,
      });
      diagnostics.push(...envImport.diagnostics);
      if (!envImport.ok) {
        diagnostics.push(rollbackWithDiagnostic());
        return {
          ...errorResult(diagnostics),
          terrainMode,
          terrainUsdKey,
          runtimeBuildReport: null,
          replacedRoots,
        };
      }
      if (envImport.rootId && action.transform) {
        applyImportedRootTransform(envImport.rootId, action.transform);
      }
      if (action.sceneRole === "terrain") {
        terrainMode = "usd";
        terrainUsdKey = action.usdKey;
      }
    }

    await useMujocoStore.getState().reload();
    const runtimeBuildReport = useMujocoStore.getState().lastRuntimeBuildReport;
    const coverageFailures = strictCollisionValidation ? extractSceneAssetCollisionFailures(runtimeBuildReport) : [];
    if (coverageFailures.length > 0) {
      diagnostics.push(
        environmentDocumentManager.buildImportDiagnostic({
          code: "USD_ENV_SCENE_ASSET_COLLISION_REQUIRED",
          severity: "error",
          message: "Scene asset import failed collision completeness validation.",
          context: {
            environmentId: plan.environmentId ?? null,
            failures: coverageFailures,
          },
        })
      );
      diagnostics.push(rollbackWithDiagnostic());
      return {
        ...errorResult(diagnostics),
        terrainMode: "none",
        terrainUsdKey: null,
        runtimeBuildReport,
        replacedRoots,
      };
    }

    restoreSelection(transactionSnapshot?.selectedSceneId ?? null);
    syncSceneFromViewer();
    discardImportTransactionSnapshot(transactionSnapshot);
    return {
      ...successResult(robotImport.rootId, diagnostics),
      terrainMode,
      terrainUsdKey,
      runtimeBuildReport,
      replacedRoots,
    };
  }

  async import_mjcf(): Promise<ImportManagerResult> {
    return errorResult([
      environmentDocumentManager.buildImportDiagnostic({
        code: "MJCF_IMPORT_NOT_IMPLEMENTED",
        severity: "error",
        message: "MJCF direct import is not available yet. Convert/import through URDF or USD paths.",
      }),
    ]);
  }
}

export const importManager = new ImportManager();
