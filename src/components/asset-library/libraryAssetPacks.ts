import type { AssetEntry } from "../../app/core/assets/assetRegistryTypes";
import {
  LIBRARY_ROOT,
  fetchLibrarySampleFiles,
  getLibrarySampleById,
  type LibrarySample,
} from "./librarySamples";

export type LibraryAssetPackItemTransform = {
  position?: { x: number; y: number; z: number };
  rotationDeg?: { x: number; y: number; z: number };
  scale?: { x: number; y: number; z: number };
};

export type LibraryAssetPackItem = {
  id: string;
  modelId: string;
  section: "links";
  label: string;
  description: string;
  sampleId: string;
  entry: string;
  files: string[];
  rootName?: string;
  sceneRole: "scene_asset" | "terrain";
};

export type LibraryAssetPackPresetPlacement = {
  itemId: string;
  transform: LibraryAssetPackItemTransform;
};

export type LibraryAssetPackPreset = {
  id: string;
  modelId: string;
  label: string;
  description: string;
  section: "links";
  placements: LibraryAssetPackPresetPlacement[];
};

const normalizePath = (value: string) => String(value ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
const hasLibraryPrefix = (value: string) => normalizePath(value).toLowerCase().startsWith(`${LIBRARY_ROOT.toLowerCase()}/`);
const unique = <T>(items: T[]) => Array.from(new Set(items));

const resolveWorkspaceKey = (sample: LibrarySample, path: string): string => {
  const normalized = normalizePath(path);
  if (!normalized) return "";
  if (hasLibraryPrefix(normalized)) return normalized;
  return `${LIBRARY_ROOT}/${sample.id}/${normalized}`;
};

const UR10_TABLE_FILES = [
  "environment/Props/Mounts/SeattleLabTable/table_instanceable.usd",
  "environment/Props/Mounts/SeattleLabTable/table.usd",
  "environment/Props/Mounts/SeattleLabTable/Materials/Textures/DemoTable_TableBase_BaseColor.png",
  "environment/Props/Mounts/SeattleLabTable/Materials/Textures/DemoTable_TableBase_Metallic.png",
  "environment/Props/Mounts/SeattleLabTable/Materials/Textures/DemoTable_TableBase_Normal.png",
  "environment/Props/Mounts/SeattleLabTable/Materials/Textures/DemoTable_TableBase_Roughness.png",
  "environment/Props/Mounts/SeattleLabTable/Materials/Textures/DemoTable_TableParts_BaseColor.png",
  "environment/Props/Mounts/SeattleLabTable/Materials/Textures/DemoTable_TableParts_Metallic.png",
  "environment/Props/Mounts/SeattleLabTable/Materials/Textures/DemoTable_TableParts_Normal.png",
  "environment/Props/Mounts/SeattleLabTable/Materials/Textures/DemoTable_TableParts_Roughness.png",
];

const UR10_BLOCK_SHARED_FILES = [
  "environment/Props/Blocks/Materials/Materials.usd",
  "environment/Props/Blocks/Materials/Textures/basic_block_blue1_BaseColor.png",
  "environment/Props/Blocks/Materials/Textures/basic_block_blue1_Normal.png",
  "environment/Props/Blocks/Materials/Textures/basic_block_blue1_Roughness.png",
  "environment/Props/Blocks/Materials/Textures/basic_block_red1_BaseColor.png",
  "environment/Props/Blocks/Materials/Textures/basic_block_red1_Normal.png",
  "environment/Props/Blocks/Materials/Textures/basic_block_red1_Roughness.png",
  "environment/Props/Blocks/Materials/Textures/basic_block_green1_BaseColor.png",
  "environment/Props/Blocks/Materials/Textures/basic_block_green1_Normal.png",
  "environment/Props/Blocks/Materials/Textures/basic_block_green1_Roughness.png",
  "environment/Props/Blocks/Materials/Textures/basic_block_yellow_BaseColor.png",
  "environment/Props/Blocks/Materials/Textures/basic_block_yellow_Normal.png",
  "environment/Props/Blocks/Materials/Textures/basic_block_yellow_Roughness.png",
];

const LIBRARY_ASSET_PACK_ITEMS: LibraryAssetPackItem[] = [
  {
    id: "ur10:table",
    modelId: "ur10",
    section: "links",
    label: "UR10 Table",
    description: "SeattleLab table used by the UR10 environment sample.",
    sampleId: "ur10",
    entry: "environment/Props/Mounts/SeattleLabTable/table_instanceable.usd",
    files: UR10_TABLE_FILES,
    rootName: "UR10 Table",
    sceneRole: "scene_asset",
  },
  {
    id: "ur10:cube_blue",
    modelId: "ur10",
    section: "links",
    label: "UR10 Cube Blue",
    description: "Blue training cube with imported material textures.",
    sampleId: "ur10",
    entry: "environment/Props/Blocks/blue_block.usd",
    files: unique(["environment/Props/Blocks/blue_block.usd", ...UR10_BLOCK_SHARED_FILES]),
    rootName: "UR10 Cube Blue",
    sceneRole: "scene_asset",
  },
  {
    id: "ur10:cube_red",
    modelId: "ur10",
    section: "links",
    label: "UR10 Cube Red",
    description: "Red training cube with imported material textures.",
    sampleId: "ur10",
    entry: "environment/Props/Blocks/red_block.usd",
    files: unique(["environment/Props/Blocks/red_block.usd", ...UR10_BLOCK_SHARED_FILES]),
    rootName: "UR10 Cube Red",
    sceneRole: "scene_asset",
  },
  {
    id: "ur10:cube_green",
    modelId: "ur10",
    section: "links",
    label: "UR10 Cube Green",
    description: "Green training cube with imported material textures.",
    sampleId: "ur10",
    entry: "environment/Props/Blocks/green_block.usd",
    files: unique(["environment/Props/Blocks/green_block.usd", ...UR10_BLOCK_SHARED_FILES]),
    rootName: "UR10 Cube Green",
    sceneRole: "scene_asset",
  },
];

const LIBRARY_ASSET_PACK_PRESETS: LibraryAssetPackPreset[] = [
  {
    id: "ur10:cube_stack_isaac_lab",
    modelId: "ur10",
    section: "links",
    label: "UR10 Cube Stack Scene",
    description: "Imports table + cubes with the same coordinates as Isaac Lab UR10 table/cubes scene.",
    placements: [
      {
        itemId: "ur10:table",
        transform: { position: { x: 0.5, y: 0.0, z: 0.0 } },
      },
      {
        itemId: "ur10:cube_blue",
        transform: { position: { x: 0.4, y: 0.0, z: 0.0203 } },
      },
      {
        itemId: "ur10:cube_red",
        transform: { position: { x: 0.55, y: 0.05, z: 0.0203 } },
      },
      {
        itemId: "ur10:cube_green",
        transform: { position: { x: 0.6, y: -0.1, z: 0.0203 } },
      },
    ],
  },
];

export function listLinkLibraryAssetPackItems(modelId?: string): LibraryAssetPackItem[] {
  const target = String(modelId ?? "").trim().toLowerCase();
  if (!target) return LIBRARY_ASSET_PACK_ITEMS.filter((item) => item.section === "links");
  return LIBRARY_ASSET_PACK_ITEMS.filter((item) => item.section === "links" && item.modelId.toLowerCase() === target);
}

export function listLinkLibraryAssetPackPresets(modelId?: string): LibraryAssetPackPreset[] {
  const target = String(modelId ?? "").trim().toLowerCase();
  if (!target) return LIBRARY_ASSET_PACK_PRESETS.filter((preset) => preset.section === "links");
  return LIBRARY_ASSET_PACK_PRESETS.filter(
    (preset) => preset.section === "links" && preset.modelId.toLowerCase() === target
  );
}

export function getLibraryAssetPackItemById(itemId: string): LibraryAssetPackItem | null {
  const normalized = String(itemId ?? "").trim();
  if (!normalized) return null;
  return LIBRARY_ASSET_PACK_ITEMS.find((item) => item.id === normalized) ?? null;
}

export function getLibraryAssetPackPresetById(presetId: string): LibraryAssetPackPreset | null {
  const normalized = String(presetId ?? "").trim();
  if (!normalized) return null;
  return LIBRARY_ASSET_PACK_PRESETS.find((preset) => preset.id === normalized) ?? null;
}

export function resolveLibraryAssetPackWorkspaceKey(item: LibraryAssetPackItem): string | null {
  const sample = getLibrarySampleById(item.sampleId);
  if (!sample) return null;
  const workspaceKey = resolveWorkspaceKey(sample, item.entry);
  return workspaceKey || null;
}

export async function ensureLibraryAssetPackItemImported(
  item: LibraryAssetPackItem,
  assetsProvider: () => Record<string, AssetEntry>,
  importFiles: (files: File[] | FileList) => void
): Promise<string | null> {
  const sample = getLibrarySampleById(item.sampleId);
  if (!sample) return null;
  const entryWorkspaceKey = resolveWorkspaceKey(sample, item.entry);
  if (!entryWorkspaceKey) return null;

  const expectedWorkspaceKeys = unique(
    [item.entry, ...item.files]
      .map((path) => resolveWorkspaceKey(sample, path))
      .filter((path) => path.length > 0)
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

