import type { AssetEntry } from "../../app/core/assets/assetRegistryTypes";
import {
  fetchLibrarySampleFiles,
  getLibrarySampleById,
  getLoadedLibrarySamples,
  resolveLibraryWorkspaceKey,
  type LibraryAssetPackItem,
  type LibraryAssetPackPreset,
  type LibrarySampleSection,
  type LibrarySample,
} from "./librarySamples";

const normalizePath = (value: string) => String(value ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");

function flattenAssetPackItems(samples: LibrarySample[] = getLoadedLibrarySamples()): LibraryAssetPackItem[] {
  return samples.flatMap((sample) =>
    (sample.assetPack?.items ?? []).map((item) => ({
      ...item,
      sampleId: sample.id,
    }))
  );
}

function flattenAssetPackPresets(samples: LibrarySample[] = getLoadedLibrarySamples()): LibraryAssetPackPreset[] {
  return samples.flatMap((sample) =>
    (sample.assetPack?.presets ?? []).map((preset) => ({
      ...preset,
      sampleId: sample.id,
    }))
  );
}

export function listLinkLibraryAssetPackItems(modelId?: string): LibraryAssetPackItem[] {
  return listLibraryAssetPackItems({ section: "links", modelId });
}

export function listLinkLibraryAssetPackPresets(modelId?: string): LibraryAssetPackPreset[] {
  return listLibraryAssetPackPresets({ section: "links", modelId });
}

export function listLibraryAssetPackItems(options?: {
  section?: Extract<LibrarySampleSection, "floors" | "links">;
  modelId?: string;
}): LibraryAssetPackItem[] {
  const section = options?.section;
  const target = String(options?.modelId ?? "").trim().toLowerCase();
  const items = flattenAssetPackItems().filter((item) => (section ? item.section === section : true));
  if (!target) return items;
  return items.filter((item) => item.modelId.toLowerCase() === target);
}

export function listLibraryAssetPackPresets(options?: {
  section?: Extract<LibrarySampleSection, "floors" | "links">;
  modelId?: string;
}): LibraryAssetPackPreset[] {
  const section = options?.section;
  const target = String(options?.modelId ?? "").trim().toLowerCase();
  const presets = flattenAssetPackPresets().filter((preset) => (section ? preset.section === section : true));
  if (!target) return presets;
  return presets.filter((preset) => preset.modelId.toLowerCase() === target);
}

export function getLibraryAssetPackItemById(itemId: string): LibraryAssetPackItem | null {
  const normalized = String(itemId ?? "").trim();
  if (!normalized) return null;
  return flattenAssetPackItems().find((item) => item.id === normalized) ?? null;
}

export function getLibraryAssetPackPresetById(presetId: string): LibraryAssetPackPreset | null {
  const normalized = String(presetId ?? "").trim();
  if (!normalized) return null;
  return flattenAssetPackPresets().find((preset) => preset.id === normalized) ?? null;
}

export function resolveLibraryAssetPackWorkspaceKey(item: LibraryAssetPackItem): string | null {
  const sample = getLibrarySampleById(item.sampleId);
  if (!sample) return null;
  const workspaceKey = resolveLibraryWorkspaceKey(sample, item.entry);
  return workspaceKey || null;
}

export async function ensureLibraryAssetPackItemImported(
  item: LibraryAssetPackItem,
  assetsProvider: () => Record<string, AssetEntry>,
  importFiles: (files: File[] | FileList) => void
): Promise<string | null> {
  const sample = getLibrarySampleById(item.sampleId);
  if (!sample) return null;
  const entryWorkspaceKey = resolveLibraryWorkspaceKey(sample, item.entry);
  if (!entryWorkspaceKey) return null;

  const expectedWorkspaceKeys = Array.from(
    new Set(
      [item.entry, ...item.files]
        .map((path) => resolveLibraryWorkspaceKey(sample, path))
        .filter((path) => path.length > 0)
    )
  );
  if (!expectedWorkspaceKeys.includes(entryWorkspaceKey)) expectedWorkspaceKeys.push(entryWorkspaceKey);

  const knownKeys = new Set(
    Object.keys(assetsProvider())
      .map((key) => normalizePath(key))
      .filter((key) => key.length > 0)
  );
  const missing = expectedWorkspaceKeys.filter((key) => !knownKeys.has(normalizePath(key)));
  if (missing.length === 0) return entryWorkspaceKey;

  const files = await fetchLibrarySampleFiles(sample, missing);
  importFiles(files);
  const finalKnown = new Set(
    Object.keys(assetsProvider())
      .map((key) => normalizePath(key))
      .filter((key) => key.length > 0)
  );
  return finalKnown.has(normalizePath(entryWorkspaceKey)) ? entryWorkspaceKey : null;
}
