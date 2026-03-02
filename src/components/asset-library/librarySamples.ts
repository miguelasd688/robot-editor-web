import type { AssetEntry } from "../../app/core/assets/assetRegistryTypes";
import type { UrdfImportOptions } from "../../app/core/urdf/urdfImportOptions";
import type { UsdImportOptions } from "../../app/core/usd/usdImportOptions";

export type LibrarySampleKind = "urdf" | "usd";

export type LibrarySample = {
  id: string;
  label: string;
  description: string;
  kind: LibrarySampleKind;
  entry: string;
  files: string[];
  /**
   * Optional compatibility keys used by older imports before the /public/library contract.
   * If found in workspace, the sample is considered already imported.
   */
  legacyKeys?: string[];
  badge?: string;
  importLabel?: string;
  icon?: string;
  preview: {
    top: string;
    bottom: string;
    caption: string;
  };
  defaultImportOptions?: {
    urdf?: Partial<UrdfImportOptions>;
    usd?: Partial<UsdImportOptions>;
  };
};

export const LIBRARY_ROOT = "library";
// Library sample files are served from: /public/library/<sampleId>/<entry and dependencies>

export const LIBRARY_SAMPLES: LibrarySample[] = [
  {
    id: "cartpole",
    label: "Cartpole Sample",
    description: "Cartpole URDF with simple material colors.",
    kind: "urdf",
    entry: "Cartpole_robot.urdf",
    files: ["Cartpole_robot.urdf"],
    legacyKeys: ["samples/cartpole/Cartpole_robot.urdf"],
    badge: "URDF",
    importLabel: "Load sample",
    icon: "🧪",
    preview: {
      top: "rgba(101, 148, 117, 0.55)",
      bottom: "rgba(38, 74, 57, 0.9)",
      caption: "CARTPOLE",
    },
    defaultImportOptions: {
      urdf: { floatingBase: false },
    },
  },
];

export function getLibrarySampleById(sampleId: string): LibrarySample | null {
  return LIBRARY_SAMPLES.find((sample) => sample.id === sampleId) ?? null;
}

export function buildLibrarySampleEntryKey(sample: LibrarySample): string {
  return `${LIBRARY_ROOT}/${sample.id}/${sample.entry}`;
}

export function findLibrarySampleKey(keys: string[], sample: LibrarySample): string | null {
  if (!keys.length) return null;
  const entryKey = buildLibrarySampleEntryKey(sample);
  if (keys.includes(entryKey)) return entryKey;

  const legacyKeys = sample.legacyKeys ?? [];
  for (const legacyKey of legacyKeys) {
    const normalizedLegacy = normalizeLibraryFile(legacyKey);
    const exact = keys.find((key) => key === normalizedLegacy);
    if (exact) return exact;
    const bySuffix = keys.find((key) => key.endsWith(`/${normalizedLegacy}`));
    if (bySuffix) return bySuffix;
  }

  const byEntry = keys.find((key) => key.endsWith(`/${sample.entry}`));
  if (byEntry) return byEntry;
  const byName = keys.find((key) => key === sample.entry);
  return byName ?? null;
}

const resolveLibraryBaseUrl = () => {
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
  return base.endsWith("/") ? base : `${base}/`;
};

const normalizeLibraryFile = (path: string) => path.replace(/^\/+/, "");

const createFileWithRelativePath = (blob: Blob, filename: string, relativePath: string) => {
  const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
  const normalized = normalizeLibraryFile(relativePath);
  Object.defineProperty(file, "webkitRelativePath", {
    value: normalized,
    configurable: true,
  });
  return file;
};

export async function fetchLibrarySampleFiles(sample: LibrarySample): Promise<File[]> {
  const baseUrl = resolveLibraryBaseUrl();
  const uniqueFiles = new Set<string>(sample.files.map((file) => normalizeLibraryFile(file)));
  if (!uniqueFiles.has(sample.entry)) uniqueFiles.add(sample.entry);
  const files = Array.from(uniqueFiles);

  const responses = await Promise.all(
    files.map(async (filePath) => {
      const url = `${baseUrl}${LIBRARY_ROOT}/${sample.id}/${filePath}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to load library file: ${url} (${res.status} ${res.statusText})`);
      }
      const blob = await res.blob();
      const filename = filePath.split("/").pop() ?? filePath;
      const relativePath = `${LIBRARY_ROOT}/${sample.id}/${filePath}`;
      return createFileWithRelativePath(blob, filename, relativePath);
    })
  );

  return responses;
}

export async function ensureLibrarySampleImported(
  sample: LibrarySample,
  assetsProvider: () => Record<string, AssetEntry>,
  importFiles: (files: File[] | FileList) => void
): Promise<string | null> {
  const existingKey = findLibrarySampleKey(Object.keys(assetsProvider()), sample);
  if (existingKey) return existingKey;
  const files = await fetchLibrarySampleFiles(sample);
  importFiles(files);
  return findLibrarySampleKey(Object.keys(assetsProvider()), sample);
}
