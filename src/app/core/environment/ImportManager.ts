import type { AssetEntry } from "../assets/assetRegistryTypes";
import { editorEngine } from "../editor/engineSingleton";
import type { EnvironmentDiagnostic, EnvironmentDoc } from "../editor/document/types";
import { loadWorkspaceURDFIntoViewer } from "../loaders/urdfLoader";
import { loadWorkspaceUSDIntoViewer } from "../loaders/usdLoader";
import type { UrdfImportOptions } from "../urdf/urdfImportOptions";
import type { UsdImportOptions } from "../usd/usdImportOptions";
import { environmentDocumentManager } from "./EnvironmentDocumentManager";

export type ImportManagerResult = {
  ok: boolean;
  rootId: string | null;
  environment: EnvironmentDoc | null;
  diagnostics: EnvironmentDiagnostic[];
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
    });
    return successResult(loaded?.rootId ?? null);
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
