import { create } from "zustand";
import type { AssetEntry } from "../../app/core/assets/assetRegistryTypes";
import type { SceneAssetId } from "../../app/core/scene/sceneAssets";
import type { UrdfImportOptions } from "../../app/core/urdf/urdfImportOptions";
import type { UsdImportOptions } from "../../app/core/usd/usdImportOptions";

export type LibrarySampleKind = "urdf" | "usd";
export type LibrarySampleSection = "floors" | "robots" | "links";

export type LibrarySampleTrainingDefaults = {
  templateId: string;
  recipeId: string;
  taskTemplate: string;
  task: string;
  ikModelId?: string;
};

export type LibrarySampleDataArtifact = {
  id: string;
  label: string;
  workspaceKey: string;
  kind: "training_checkpoint" | "rl_model" | "policy" | "dataset" | "metadata";
  description?: string;
};

export type LibrarySampleDataContract = {
  artifacts?: LibrarySampleDataArtifact[];
  metadata?: Record<string, unknown>;
};

export type LibraryCardPreview = {
  top: string;
  bottom: string;
  caption: string;
  imageUrl?: string;
};

export type LibraryAssetPackItemTransform = {
  position?: { x: number; y: number; z: number };
  rotationDeg?: { x: number; y: number; z: number };
  scale?: { x: number; y: number; z: number };
};

export type LibraryAssetPackItemDefinition = {
  id: string;
  modelId: string;
  section: "links" | "floors";
  label: string;
  description: string;
  entry: string;
  files: string[];
  rootName?: string;
  sceneRole: "scene_asset" | "terrain";
  preview?: LibraryCardPreview;
};

export type LibraryAssetPackItem = LibraryAssetPackItemDefinition & {
  sampleId: string;
};

export type LibraryAssetPackPresetPlacement = {
  itemId: string;
  transform: LibraryAssetPackItemTransform;
};

export type LibraryAssetPackPresetDefinition = {
  id: string;
  modelId: string;
  label: string;
  description: string;
  section: "links" | "floors";
  placements: LibraryAssetPackPresetPlacement[];
  preview?: LibraryCardPreview;
};

export type LibraryAssetPackPreset = LibraryAssetPackPresetDefinition & {
  sampleId: string;
};

export type LibrarySampleUsdVariant = {
  id: string;
  label: string;
  entry: string;
  description?: string;
  defaultEnvironmentId?: string;
  trainingDefaults?: LibrarySampleTrainingDefaults;
  hidden?: boolean;
  preview?: LibraryCardPreview;
};

export type LibrarySampleEnvironmentAction =
  | {
      kind: "usd_bundle";
      entry: string;
      files?: string[];
      sceneRole?: "scene_asset" | "terrain";
      rootName?: string;
    }
  | {
      kind: "generated_scene_asset";
      sceneAssetId: SceneAssetId;
      label?: string;
    }
  | {
      kind: "asset_pack_item";
      itemId: string;
      transform?: LibraryAssetPackItemTransform;
    }
  | {
      kind: "asset_pack_preset";
      presetId: string;
    };

export type LibrarySampleEnvironment = {
  id: string;
  label: string;
  description?: string;
  hint?: string;
  hidden?: boolean;
  replaceFullScene?: boolean;
  trainingDefaults?: LibrarySampleTrainingDefaults;
  preview?: LibraryCardPreview;
  imports: LibrarySampleEnvironmentAction[];
};

export type LibrarySample = {
  id: string;
  section: LibrarySampleSection;
  label: string;
  description: string;
  kind: LibrarySampleKind;
  entry: string;
  files: string[];
  bundlePath?: string;
  legacyKeys?: string[];
  badge?: string;
  importLabel?: string;
  icon?: string;
  preview: LibraryCardPreview;
  defaultImportOptions?: {
    urdf?: Partial<UrdfImportOptions>;
    usd?: Partial<UsdImportOptions>;
  };
  usdVariants?: LibrarySampleUsdVariant[];
  environments?: LibrarySampleEnvironment[];
  trainingDefaults?: LibrarySampleTrainingDefaults;
  sampleData?: LibrarySampleDataContract;
  assetPack?: {
    items?: LibraryAssetPackItemDefinition[];
    presets?: LibraryAssetPackPresetDefinition[];
  };
};

export type LibraryCatalogIndex = {
  schemaVersion: string;
  samples: LibrarySample[];
};

type LibraryCatalogStatus = "idle" | "loading" | "ready" | "error";

type LibraryCatalogState = {
  status: LibraryCatalogStatus;
  schemaVersion: string;
  samples: LibrarySample[];
  error: string | null;
  setLoading: () => void;
  setReady: (catalog: LibraryCatalogIndex) => void;
  setError: (message: string) => void;
};

export const LIBRARY_ROOT = "library";
export const MANAGED_FLAT_FLOOR_WORKSPACE_KEY = "library/floors/flat_floor/flat_floor.usda";
export const MANAGED_ROUGH_FLOOR_WORKSPACE_KEY = "library/floors/rough_terrain/rough_terrain.usda";

const DEFAULT_LIBRARY_INDEX: LibraryCatalogIndex = {
  schemaVersion: "library.index.v1",
  samples: [],
};

const normalizePath = (value: string) => String(value ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
const uniqueStrings = (values: string[]) => Array.from(new Set(values.map((value) => normalizePath(value)).filter(Boolean)));

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const asText = (value: unknown) => String(value ?? "").trim();
const asOptionalText = (value: unknown) => {
  const token = asText(value);
  return token ? token : undefined;
};

const asStringArray = (value: unknown) =>
  Array.isArray(value) ? uniqueStrings(value.map((item) => String(item ?? "").trim())) : [];

const asBoolean = (value: unknown) => value === true;

function clonePreview(value: unknown, fallbackCaption = ""): LibraryCardPreview {
  const record = asRecord(value);
  return {
    top: asText(record.top) || "rgba(92, 112, 142, 0.56)",
    bottom: asText(record.bottom) || "rgba(40, 48, 62, 0.92)",
    caption: asText(record.caption) || fallbackCaption,
    ...(asOptionalText(record.imageUrl) ? { imageUrl: asText(record.imageUrl) } : {}),
  };
}

function cloneTrainingDefaults(value: unknown): LibrarySampleTrainingDefaults | undefined {
  const record = asRecord(value);
  const templateId = asText(record.templateId);
  const recipeId = asText(record.recipeId);
  const taskTemplate = asText(record.taskTemplate);
  const task = asText(record.task);
  if (!templateId || !recipeId || !taskTemplate || !task) return undefined;
  return {
    templateId,
    recipeId,
    taskTemplate,
    task,
    ...(asOptionalText(record.ikModelId) ? { ikModelId: asText(record.ikModelId) } : {}),
  };
}

function cloneTransform(value: unknown): LibraryAssetPackItemTransform {
  const record = asRecord(value);
  const vector = (input: unknown) => {
    const entry = asRecord(input);
    const x = Number(entry.x);
    const y = Number(entry.y);
    const z = Number(entry.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return undefined;
    return { x, y, z };
  };
  return {
    ...(vector(record.position) ? { position: vector(record.position) } : {}),
    ...(vector(record.rotationDeg) ? { rotationDeg: vector(record.rotationDeg) } : {}),
    ...(vector(record.scale) ? { scale: vector(record.scale) } : {}),
  };
}

function cloneAssetPackItemDefinition(value: unknown): LibraryAssetPackItemDefinition | null {
  const record = asRecord(value);
  const id = asText(record.id);
  const entry = asText(record.entry);
  const label = asText(record.label);
  const description = asText(record.description);
  const modelId = asText(record.modelId);
  if (!id || !entry || !label || !description || !modelId) return null;
  const sectionToken = asText(record.section);
  const section: "links" | "floors" = sectionToken === "floors" ? "floors" : "links";
  return {
    id,
    modelId,
    section,
    label,
    description,
    entry,
    files: asStringArray(record.files),
    ...(asOptionalText(record.rootName) ? { rootName: asText(record.rootName) } : {}),
    sceneRole: asText(record.sceneRole) === "terrain" ? "terrain" : "scene_asset",
    ...(Object.keys(asRecord(record.preview)).length > 0 ? { preview: clonePreview(record.preview, label.toUpperCase()) } : {}),
  };
}

function cloneAssetPackPresetDefinition(value: unknown): LibraryAssetPackPresetDefinition | null {
  const record = asRecord(value);
  const id = asText(record.id);
  const label = asText(record.label);
  const description = asText(record.description);
  const modelId = asText(record.modelId);
  if (!id || !label || !description || !modelId) return null;
  const sectionToken = asText(record.section);
  const section: "links" | "floors" = sectionToken === "floors" ? "floors" : "links";
  const placements = Array.isArray(record.placements)
    ? record.placements
        .map((placement) => {
          const entry = asRecord(placement);
          const itemId = asText(entry.itemId);
          if (!itemId) return null;
          return {
            itemId,
            transform: cloneTransform(entry.transform),
          } satisfies LibraryAssetPackPresetPlacement;
        })
        .filter((item): item is LibraryAssetPackPresetPlacement => Boolean(item))
    : [];
  return {
    id,
    modelId,
    label,
    description,
    section,
    placements,
    ...(Object.keys(asRecord(record.preview)).length > 0 ? { preview: clonePreview(record.preview, label.toUpperCase()) } : {}),
  };
}

function cloneEnvironmentAction(value: unknown): LibrarySampleEnvironmentAction | null {
  const record = asRecord(value);
  const kind = asText(record.kind);
  if (kind === "usd_bundle") {
    const entry = asText(record.entry);
    if (!entry) return null;
    return {
      kind: "usd_bundle",
      entry,
      ...(Array.isArray(record.files) ? { files: asStringArray(record.files) } : {}),
      ...(asText(record.sceneRole) === "terrain" ? { sceneRole: "terrain" } : {}),
      ...(asOptionalText(record.rootName) ? { rootName: asText(record.rootName) } : {}),
    };
  }
  if (kind === "generated_scene_asset") {
    const sceneAssetId = asText(record.sceneAssetId) as SceneAssetId;
    if (!sceneAssetId) return null;
    return {
      kind: "generated_scene_asset",
      sceneAssetId,
      ...(asOptionalText(record.label) ? { label: asText(record.label) } : {}),
    };
  }
  if (kind === "asset_pack_item") {
    const itemId = asText(record.itemId);
    if (!itemId) return null;
    return {
      kind: "asset_pack_item",
      itemId,
      ...(Object.keys(asRecord(record.transform)).length > 0 ? { transform: cloneTransform(record.transform) } : {}),
    };
  }
  if (kind === "asset_pack_preset") {
    const presetId = asText(record.presetId);
    if (!presetId) return null;
    return {
      kind: "asset_pack_preset",
      presetId,
    };
  }
  return null;
}

function cloneEnvironment(value: unknown): LibrarySampleEnvironment | null {
  const record = asRecord(value);
  const id = asText(record.id);
  const label = asText(record.label);
  if (!id || !label) return null;
  const imports = Array.isArray(record.imports)
    ? record.imports.map(cloneEnvironmentAction).filter((item): item is LibrarySampleEnvironmentAction => Boolean(item))
    : [];
  if (imports.length === 0) return null;
  return {
    id,
    label,
    ...(asOptionalText(record.description) ? { description: asText(record.description) } : {}),
    ...(asOptionalText(record.hint) ? { hint: asText(record.hint) } : {}),
    ...(asBoolean(record.hidden) ? { hidden: true } : {}),
    ...(asBoolean(record.replaceFullScene) ? { replaceFullScene: true } : {}),
    ...(cloneTrainingDefaults(record.trainingDefaults) ? { trainingDefaults: cloneTrainingDefaults(record.trainingDefaults) } : {}),
    ...(Object.keys(asRecord(record.preview)).length > 0 ? { preview: clonePreview(record.preview, label.toUpperCase()) } : {}),
    imports,
  };
}

function cloneVariant(value: unknown): LibrarySampleUsdVariant | null {
  const record = asRecord(value);
  const id = asText(record.id);
  const label = asText(record.label);
  const entry = asText(record.entry);
  if (!id || !label || !entry) return null;
  return {
    id,
    label,
    entry,
    ...(asOptionalText(record.description) ? { description: asText(record.description) } : {}),
    ...(asOptionalText(record.defaultEnvironmentId) ? { defaultEnvironmentId: asText(record.defaultEnvironmentId) } : {}),
    ...(cloneTrainingDefaults(record.trainingDefaults) ? { trainingDefaults: cloneTrainingDefaults(record.trainingDefaults) } : {}),
    ...(asBoolean(record.hidden) ? { hidden: true } : {}),
    ...(Object.keys(asRecord(record.preview)).length > 0 ? { preview: clonePreview(record.preview, label.toUpperCase()) } : {}),
  };
}

function cloneSampleData(value: unknown): LibrarySampleDataContract | undefined {
  const record = asRecord(value);
  const artifacts = Array.isArray(record.artifacts)
    ? record.artifacts
        .map((artifact) => {
          const item = asRecord(artifact);
          const id = asText(item.id);
          const label = asText(item.label);
          const workspaceKey = asText(item.workspaceKey);
          const kindToken = asText(item.kind);
          if (!id || !label || !workspaceKey) return null;
          if (
            kindToken !== "training_checkpoint" &&
            kindToken !== "rl_model" &&
            kindToken !== "policy" &&
            kindToken !== "dataset" &&
            kindToken !== "metadata"
          ) {
            return null;
          }
          return {
            id,
            label,
            workspaceKey,
            kind: kindToken,
            ...(asOptionalText(item.description) ? { description: asText(item.description) } : {}),
          } satisfies LibrarySampleDataArtifact;
        })
        .filter((item): item is LibrarySampleDataArtifact => Boolean(item))
    : [];
  const metadata = asRecord(record.metadata);
  if (artifacts.length === 0 && Object.keys(metadata).length === 0) return undefined;
  return {
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function cloneLibrarySample(value: unknown): LibrarySample | null {
  const record = asRecord(value);
  const id = asText(record.id);
  const label = asText(record.label);
  const description = asText(record.description);
  const kind = asText(record.kind);
  const entry = asText(record.entry);
  const sectionToken = asText(record.section);
  if (!id || !label || !description || !entry) return null;
  if (kind !== "urdf" && kind !== "usd") return null;
  if (sectionToken !== "floors" && sectionToken !== "robots" && sectionToken !== "links") return null;

  const assetPackRecord = asRecord(record.assetPack);
  const items = Array.isArray(assetPackRecord.items)
    ? assetPackRecord.items
        .map(cloneAssetPackItemDefinition)
        .filter((item): item is LibraryAssetPackItemDefinition => Boolean(item))
    : [];
  const presets = Array.isArray(assetPackRecord.presets)
    ? assetPackRecord.presets
        .map(cloneAssetPackPresetDefinition)
        .filter((item): item is LibraryAssetPackPresetDefinition => Boolean(item))
    : [];

  return {
    id,
    section: sectionToken,
    label,
    description,
    kind,
    entry,
    files: asStringArray(record.files),
    ...(asOptionalText(record.bundlePath) ? { bundlePath: asText(record.bundlePath) } : {}),
    ...(asStringArray(record.legacyKeys).length > 0 ? { legacyKeys: asStringArray(record.legacyKeys) } : {}),
    ...(asOptionalText(record.badge) ? { badge: asText(record.badge) } : {}),
    ...(asOptionalText(record.importLabel) ? { importLabel: asText(record.importLabel) } : {}),
    ...(asOptionalText(record.icon) ? { icon: asText(record.icon) } : {}),
    preview: clonePreview(record.preview, label.toUpperCase()),
    ...(Object.keys(asRecord(record.defaultImportOptions)).length > 0
      ? {
          defaultImportOptions: {
            ...(Object.keys(asRecord(asRecord(record.defaultImportOptions).urdf)).length > 0
              ? { urdf: asRecord(asRecord(record.defaultImportOptions).urdf) as Partial<UrdfImportOptions> }
              : {}),
            ...(Object.keys(asRecord(asRecord(record.defaultImportOptions).usd)).length > 0
              ? { usd: asRecord(asRecord(record.defaultImportOptions).usd) as Partial<UsdImportOptions> }
              : {}),
          },
        }
      : {}),
    ...(Array.isArray(record.variants)
      ? {
          usdVariants: record.variants.map(cloneVariant).filter((item): item is LibrarySampleUsdVariant => Boolean(item)),
        }
      : {}),
    ...(Array.isArray(record.environments)
      ? {
          environments: record.environments
            .map(cloneEnvironment)
            .filter((item): item is LibrarySampleEnvironment => Boolean(item)),
        }
      : {}),
    ...(cloneTrainingDefaults(record.trainingDefaults) ? { trainingDefaults: cloneTrainingDefaults(record.trainingDefaults) } : {}),
    ...(cloneSampleData(record.sampleData) ? { sampleData: cloneSampleData(record.sampleData) } : {}),
    ...((items.length > 0 || presets.length > 0)
      ? {
          assetPack: {
            ...(items.length > 0 ? { items } : {}),
            ...(presets.length > 0 ? { presets } : {}),
          },
        }
      : {}),
  };
}

function normalizeLibraryCatalogIndex(value: unknown): LibraryCatalogIndex {
  const record = asRecord(value);
  const samples = Array.isArray(record.samples)
    ? record.samples.map(cloneLibrarySample).filter((item): item is LibrarySample => Boolean(item))
    : [];
  return {
    schemaVersion: asText(record.schemaVersion) || DEFAULT_LIBRARY_INDEX.schemaVersion,
    samples: samples.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export const useLibraryCatalogStore = create<LibraryCatalogState>((set) => ({
  status: "idle",
  schemaVersion: DEFAULT_LIBRARY_INDEX.schemaVersion,
  samples: DEFAULT_LIBRARY_INDEX.samples,
  error: null,
  setLoading: () => set((state) => (state.status === "ready" ? state : { ...state, status: "loading", error: null })),
  setReady: (catalog) =>
    set({
      status: "ready",
      schemaVersion: catalog.schemaVersion,
      samples: catalog.samples,
      error: null,
    }),
  setError: (message) =>
    set({
      status: "error",
      schemaVersion: DEFAULT_LIBRARY_INDEX.schemaVersion,
      samples: DEFAULT_LIBRARY_INDEX.samples,
      error: message,
    }),
}));

let catalogCache: LibraryCatalogIndex | null = null;
let catalogPromise: Promise<LibraryCatalogIndex> | null = null;

const resolveLibraryBaseUrl = () => {
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
  return base.endsWith("/") ? base : `${base}/`;
};

export async function ensureLibraryCatalogLoaded(): Promise<LibraryCatalogIndex> {
  if (catalogCache) return catalogCache;
  if (catalogPromise) return catalogPromise;
  useLibraryCatalogStore.getState().setLoading();
  catalogPromise = (async () => {
    const url = `${resolveLibraryBaseUrl()}library/index.json`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load library index: ${url} (${response.status} ${response.statusText})`);
    }
    const payload = normalizeLibraryCatalogIndex(await response.json());
    catalogCache = payload;
    useLibraryCatalogStore.getState().setReady(payload);
    return payload;
  })()
    .catch((error) => {
      useLibraryCatalogStore.getState().setError(String((error as Error)?.message ?? error));
      throw error;
    })
    .finally(() => {
      catalogPromise = null;
    });
  return catalogPromise;
}

export function getLoadedLibrarySamples(): LibrarySample[] {
  if (catalogCache) return catalogCache.samples;
  return useLibraryCatalogStore.getState().samples;
}

const hasLibraryWorkspacePrefix = (path: string) =>
  normalizePath(path).toLowerCase().startsWith(`${LIBRARY_ROOT.toLowerCase()}/`);

const dirnamePath = (path: string): string => {
  const normalized = normalizePath(path);
  const idx = normalized.lastIndexOf("/");
  if (idx < 0) return "";
  return normalized.slice(0, idx);
};

export function resolveLibraryBundleRoot(sample: Pick<LibrarySample, "id" | "bundlePath">): string {
  const bundlePath = normalizePath(sample.bundlePath ?? "");
  if (bundlePath && hasLibraryWorkspacePrefix(bundlePath)) {
    const root = dirnamePath(bundlePath);
    if (root) return root;
  }
  return `${LIBRARY_ROOT}/${sample.id}`;
}

export function resolveLibraryWorkspaceKey(sample: Pick<LibrarySample, "id" | "bundlePath">, path: string): string {
  const normalized = normalizePath(path);
  if (!normalized) return "";
  if (hasLibraryWorkspacePrefix(normalized)) return normalized;
  return `${resolveLibraryBundleRoot(sample)}/${normalized}`;
}

export function buildLibrarySampleEntryKey(sample: LibrarySample): string {
  return resolveLibraryWorkspaceKey(sample, sample.entry);
}

export function getLibrarySampleById(sampleId: string, samples: LibrarySample[] = getLoadedLibrarySamples()): LibrarySample | null {
  const normalized = asText(sampleId);
  if (!normalized) return null;
  return samples.find((sample) => sample.id === normalized) ?? null;
}

export function listLibrarySamples(samples: LibrarySample[] = getLoadedLibrarySamples()): LibrarySample[] {
  return [...samples];
}

function createFallbackUsdVariant(sample: LibrarySample): LibrarySampleUsdVariant {
  return {
    id: "default",
    label: "Default",
    entry: sample.entry,
    ...(sample.trainingDefaults ? { trainingDefaults: sample.trainingDefaults } : {}),
  };
}

export function listLibrarySampleUsdVariants(
  sample: LibrarySample,
  options?: { includeHidden?: boolean; selectedWorkspaceKey?: string | null }
): LibrarySampleUsdVariant[] {
  if (sample.kind !== "usd") return [];
  const selectedWorkspaceKey = normalizePath(options?.selectedWorkspaceKey ?? "");
  const baseVariants = sample.usdVariants && sample.usdVariants.length > 0 ? sample.usdVariants : [createFallbackUsdVariant(sample)];
  const visible = baseVariants.filter((variant) => {
    if (options?.includeHidden) return true;
    if (!variant.hidden) return true;
    if (!selectedWorkspaceKey) return false;
    return resolveLibraryWorkspaceKey(sample, variant.entry) === selectedWorkspaceKey;
  });
  return visible.length > 0 ? visible : [createFallbackUsdVariant(sample)];
}

export function listLibrarySampleUsdEntries(
  sample: LibrarySample,
  options?: { includeHidden?: boolean; selectedWorkspaceKey?: string | null }
): string[] {
  return listLibrarySampleUsdVariants(sample, options).map((variant) => normalizePath(variant.entry)).filter(Boolean);
}

export function listLibrarySampleUsdWorkspaceKeys(
  sample: LibrarySample,
  options?: { includeHidden?: boolean; selectedWorkspaceKey?: string | null }
): string[] {
  return uniqueStrings(
    listLibrarySampleUsdEntries(sample, options).map((entry) => resolveLibraryWorkspaceKey(sample, entry))
  );
}

export function getLibrarySampleVariantByWorkspaceKey(
  sample: LibrarySample,
  workspaceKey: string | null | undefined
): LibrarySampleUsdVariant | null {
  if (sample.kind !== "usd") return null;
  const normalized = normalizePath(workspaceKey ?? "");
  if (!normalized) return null;
  const variants = sample.usdVariants && sample.usdVariants.length > 0 ? sample.usdVariants : [createFallbackUsdVariant(sample)];
  return variants.find((variant) => resolveLibraryWorkspaceKey(sample, variant.entry) === normalized) ?? null;
}

export function listLibrarySampleEnvironments(
  sample: LibrarySample,
  options?: { includeHidden?: boolean }
): LibrarySampleEnvironment[] {
  if (sample.kind !== "usd") return [];
  const environments = sample.environments ?? [];
  if (options?.includeHidden) return [...environments];
  return environments.filter((environment) => environment.hidden !== true);
}

export function getLibrarySampleEnvironmentById(
  sample: LibrarySample,
  environmentId: string | null | undefined
): LibrarySampleEnvironment | null {
  const normalized = asText(environmentId);
  if (!normalized || sample.kind !== "usd") return null;
  return (sample.environments ?? []).find((environment) => environment.id === normalized) ?? null;
}

export function resolveDefaultSampleEnvironmentId(
  sample: LibrarySample,
  selectedUsdWorkspaceKey: string | null | undefined
): string | null {
  if (sample.kind !== "usd") return null;
  const environments = listLibrarySampleEnvironments(sample, { includeHidden: false });
  if (environments.length === 0) return null;
  const variant = getLibrarySampleVariantByWorkspaceKey(sample, selectedUsdWorkspaceKey);
  const defaultEnvironmentId = asText(variant?.defaultEnvironmentId ?? "");
  if (defaultEnvironmentId && environments.some((environment) => environment.id === defaultEnvironmentId)) {
    return defaultEnvironmentId;
  }
  return environments[0]?.id ?? null;
}

export function hasLibrarySampleEnvironment(sample: LibrarySample): boolean {
  return listLibrarySampleEnvironments(sample).length > 0;
}

export function findLibrarySampleKey(keys: string[], sample: LibrarySample): string | null {
  const normalizedKeys = uniqueStrings(keys);
  if (normalizedKeys.length === 0) return null;

  const sampleEntryKeys =
    sample.kind === "usd"
      ? listLibrarySampleUsdWorkspaceKeys(sample, { includeHidden: true })
      : [buildLibrarySampleEntryKey(sample)];
  for (const entryKey of sampleEntryKeys) {
    if (normalizedKeys.includes(entryKey)) return entryKey;
  }

  const legacyKeys = sample.legacyKeys ?? [];
  for (const legacyKey of legacyKeys) {
    const normalizedLegacy = normalizePath(legacyKey);
    const exact = normalizedKeys.find((key) => key === normalizedLegacy);
    if (exact) return exact;
    const bySuffix = normalizedKeys.find((key) => key.endsWith(`/${normalizedLegacy}`));
    if (bySuffix) return bySuffix;
  }

  const sampleEntries =
    sample.kind === "usd"
      ? listLibrarySampleUsdEntries(sample, { includeHidden: true })
      : [normalizePath(sample.entry)];
  for (const entry of sampleEntries) {
    const byEntry = normalizedKeys.find((key) => key.endsWith(`/${entry}`));
    if (byEntry) return byEntry;
    const byName = normalizedKeys.find((key) => key === entry);
    if (byName) return byName;
  }
  return null;
}

export function findLibrarySampleByWorkspaceKey(
  key: string,
  samples: LibrarySample[] = getLoadedLibrarySamples()
): LibrarySample | null {
  const normalized = normalizePath(key);
  if (!normalized) return null;
  for (const sample of samples) {
    const entryKeys =
      sample.kind === "usd"
        ? listLibrarySampleUsdWorkspaceKeys(sample, { includeHidden: true })
        : [buildLibrarySampleEntryKey(sample)];
    if (entryKeys.some((entryKey) => normalizePath(entryKey) === normalized)) return sample;

    const sampleEntries =
      sample.kind === "usd"
        ? listLibrarySampleUsdEntries(sample, { includeHidden: true })
        : [normalizePath(sample.entry)];
    if (sampleEntries.some((entry) => normalized === entry || normalized.endsWith(`/${entry}`))) return sample;

    const legacyKeys = sample.legacyKeys ?? [];
    for (const legacyKey of legacyKeys) {
      const normalizedLegacy = normalizePath(legacyKey);
      if (!normalizedLegacy) continue;
      if (normalized === normalizedLegacy || normalized.endsWith(`/${normalizedLegacy}`)) return sample;
    }
  }
  return null;
}

export function findLibrarySampleFromKeys(
  keys: string[],
  samples: LibrarySample[] = getLoadedLibrarySamples()
): { sample: LibrarySample; matchedKey: string } | null {
  for (const sample of samples) {
    const matchedKey = findLibrarySampleKey(keys, sample);
    if (matchedKey) return { sample, matchedKey };
  }
  return null;
}

const createFileWithRelativePath = (blob: Blob, filename: string, relativePath: string) => {
  const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
  const normalized = normalizePath(relativePath);
  Object.defineProperty(file, "webkitRelativePath", {
    value: normalized,
    configurable: true,
  });
  return file;
};

export async function fetchLibraryWorkspaceFiles(workspaceKeys: string[]): Promise<File[]> {
  const baseUrl = resolveLibraryBaseUrl();
  const normalizedWorkspaceKeys = uniqueStrings(workspaceKeys);
  const responses = await Promise.all(
    normalizedWorkspaceKeys.map(async (workspaceKey) => {
      const url = `${baseUrl}${workspaceKey}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to load library file: ${url} (${response.status} ${response.statusText})`);
      }
      const blob = await response.blob();
      const filename = workspaceKey.split("/").pop() ?? workspaceKey;
      return createFileWithRelativePath(blob, filename, workspaceKey);
    })
  );
  return responses;
}

export async function fetchLibrarySampleFiles(sample: LibrarySample, filePaths?: string[]): Promise<File[]> {
  const sourcePaths = Array.isArray(filePaths) && filePaths.length > 0 ? filePaths : sample.files;
  const workspaceKeys = uniqueStrings(
    sourcePaths
      .map((filePath) => resolveLibraryWorkspaceKey(sample, String(filePath ?? "").trim()))
      .filter(Boolean)
  );
  const entryWorkspaceKey = buildLibrarySampleEntryKey(sample);
  if (entryWorkspaceKey) workspaceKeys.push(entryWorkspaceKey);
  return fetchLibraryWorkspaceFiles(uniqueStrings(workspaceKeys));
}

export async function ensureLibraryWorkspaceKeysImported(
  workspaceKeys: string[],
  assetsProvider: () => Record<string, AssetEntry>,
  importFiles: (files: File[] | FileList) => void
): Promise<boolean> {
  const requestedKeys = uniqueStrings(workspaceKeys);
  if (requestedKeys.length === 0) return true;
  const knownKeys = new Set(
    Object.keys(assetsProvider())
      .map((key) => normalizePath(key))
      .filter(Boolean)
  );
  const missing = requestedKeys.filter((key) => !knownKeys.has(key));
  if (missing.length === 0) return true;
  const files = await fetchLibraryWorkspaceFiles(missing);
  importFiles(files);
  const finalKnown = new Set(
    Object.keys(assetsProvider())
      .map((key) => normalizePath(key))
      .filter(Boolean)
  );
  return requestedKeys.every((key) => finalKnown.has(key));
}

export async function ensureLibrarySampleImported(
  sample: LibrarySample,
  assetsProvider: () => Record<string, AssetEntry>,
  importFiles: (files: File[] | FileList) => void
): Promise<string | null> {
  const assetKeys = Object.keys(assetsProvider()).map((key) => normalizePath(key));
  const existingKey = findLibrarySampleKey(assetKeys, sample);
  const knownAssetKeySet = new Set(assetKeys);
  const expectedFiles = new Set<string>(
    sample.files
      .map((file) => resolveLibraryWorkspaceKey(sample, file))
      .filter(Boolean)
  );
  expectedFiles.add(buildLibrarySampleEntryKey(sample));
  const missingFiles = Array.from(expectedFiles).filter((workspaceKey) => !knownAssetKeySet.has(workspaceKey));
  if (existingKey && missingFiles.length === 0) return existingKey;

  const files = await fetchLibrarySampleFiles(sample, missingFiles.length > 0 ? missingFiles : undefined);
  importFiles(files);
  return findLibrarySampleKey(Object.keys(assetsProvider()), sample);
}
