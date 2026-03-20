import type { UsdImportOptions } from "../../usd/usdImportOptions";
import {
  collectUsdBundleFiles as collectUsdBundleFilesFromCollector,
  type UsdWorkspaceAssetEntry,
} from "../../usd/usdBundleCollector";
import {
  convertUsdAssetToMjcfAsset,
  fetchUsdAssetIntrospectionPayload,
  fetchUsdAssetMeshScenePayload,
  uploadUsdBundleAsset,
} from "../usdConverterClient";
import type {
  NormalizedUsdConverterDiagnostics,
  NormalizedUsdIntrospection,
  NormalizedUsdMeshScene,
  UsdConverterIntrospectionResponse,
  UsdConverterMeshSceneResponse,
} from "./types";
import { normalizeUsdIntrospection } from "./introspection";
import { normalizeUsdMeshScene } from "./meshScene";

/* ------------------------------------------------------------------ */
/*  Converter base-URL configuration                                   */
/* ------------------------------------------------------------------ */

export const DEFAULT_USD_CONVERTER_BASE_URL = "http://localhost:8095";
export const rawConverterBaseUrl = String(import.meta.env.VITE_USD_CONVERTER_BASE_URL ?? DEFAULT_USD_CONVERTER_BASE_URL).trim();
export const usdConverterBaseUrl = rawConverterBaseUrl.replace(/\/+$/, "");
export const usdConverterEnabled = usdConverterBaseUrl.length > 0;

/* ------------------------------------------------------------------ */
/*  Config resolution helpers                                          */
/* ------------------------------------------------------------------ */

export const resolveUsdMeshSceneProfile = (
  _usdKey: string,
  importOptions?: UsdImportOptions
): "balanced" | "high_fidelity" => {
  const explicit = importOptions?.meshSceneProfile;
  if (explicit === "balanced" || explicit === "high_fidelity") return explicit;
  return "balanced";
};

export const resolveUsdCollisionProfile = (
  usdKey: string,
  importOptions?: UsdImportOptions
): "authored" | "outer_hull" => {
  const explicit = importOptions?.collisionProfile;
  if (explicit === "authored" || explicit === "outer_hull") return explicit;
  const normalized = String(usdKey ?? "").trim().replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("/anymal") || normalized.endsWith("anymal.usd") || normalized.endsWith("anymal_c.usd")) {
    return "outer_hull";
  }
  return "authored";
};

export const resolveUsdImportDebugTrace = (
  importOptions?: UsdImportOptions
): "off" | "detailed" => {
  if (importOptions?.debugTrace === "detailed") return "detailed";
  const envToken = String(import.meta.env.VITE_USD_IMPORT_DEBUG ?? "")
    .trim()
    .toLowerCase();
  if (envToken === "1" || envToken === "true" || envToken === "yes") return "detailed";
  return "off";
};

export const createUsdImportTraceId = (usdKey: string) => {
  const seed = String(usdKey ?? "").split("/").pop() ?? "usd";
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${seed}:${ts}:${rand}`;
};

export const normalizeUsdConverterDiagnostics = (value: unknown): NormalizedUsdConverterDiagnostics => {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const asCount = (input: unknown) => {
    const next = Number(input);
    return Number.isFinite(next) && next > 0 ? Math.floor(next) : 0;
  };
  return {
    placeholderGeomBodies: asCount(record.placeholderGeomBodies),
    bodiesWithAnyGeom: asCount(record.bodiesWithAnyGeom),
    linkCount: asCount(record.linkCount),
    jointCount: asCount(record.jointCount),
  };
};

/* ------------------------------------------------------------------ */
/*  Converter orchestration                                            */
/* ------------------------------------------------------------------ */

export const resolveUsdConverterAssetId = async (params: {
  usdUrl: string;
  usdKey: string;
  usdFile?: File;
  resolveResource?: (resourcePath: string) => string | null;
  assetsByKey?: Record<string, UsdWorkspaceAssetEntry>;
  converterAssetId?: string | null;
  bundleHintPaths?: string[];
}) => {
  if (params.converterAssetId && params.converterAssetId.trim()) {
    return params.converterAssetId.trim();
  }

  const bundle = await collectUsdBundleFilesFromCollector({
    usdUrl: params.usdUrl,
    usdKey: params.usdKey,
    usdFile: params.usdFile,
    resolveResource: params.resolveResource,
    assetsByKey: params.assetsByKey,
    bundleHintPaths: params.bundleHintPaths,
  });
  return uploadUsdBundleAsset({
    baseUrl: usdConverterBaseUrl,
    bundle,
  });
};

export const convertUsdAssetToMjcf = async (params: {
  converterAssetId: string;
  usdKey: string;
  importOptions?: UsdImportOptions;
}) => {
  const converted = await convertUsdAssetToMjcfAsset({
    baseUrl: usdConverterBaseUrl,
    converterAssetId: params.converterAssetId,
    floatingBase: params.importOptions?.floatingBase ?? false,
    selfCollision: params.importOptions?.selfCollision ?? false,
    collisionProfile: resolveUsdCollisionProfile(params.usdKey, params.importOptions),
  });

  return {
    converterAssetId: params.converterAssetId,
    mjcfAssetId: converted.mjcfAssetId,
    mjcfXml: converted.mjcfXml,
    diagnostics: converted.diagnostics ?? null,
  };
};

export const introspectUsdAsset = async (converterAssetId: string): Promise<NormalizedUsdIntrospection | null> => {
  const payload = (await fetchUsdAssetIntrospectionPayload({
    baseUrl: usdConverterBaseUrl,
    converterAssetId,
  })) as UsdConverterIntrospectionResponse;
  return normalizeUsdIntrospection(payload, converterAssetId);
};

export const fetchUsdMeshScene = async (
  converterAssetId: string,
  profile: "balanced" | "high_fidelity"
): Promise<NormalizedUsdMeshScene | null> => {
  const payload = (await fetchUsdAssetMeshScenePayload({
    baseUrl: usdConverterBaseUrl,
    converterAssetId,
    profile,
  })) as UsdConverterMeshSceneResponse;
  return normalizeUsdMeshScene(payload, converterAssetId);
};
