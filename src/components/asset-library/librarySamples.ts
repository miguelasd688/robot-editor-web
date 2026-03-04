import type { AssetEntry } from "../../app/core/assets/assetRegistryTypes";
import type { UrdfImportOptions } from "../../app/core/urdf/urdfImportOptions";
import type { UsdImportOptions } from "../../app/core/usd/usdImportOptions";
import { getLibrarySamplePreviewImage } from "./browserPreviewCatalog";

export type LibrarySampleKind = "urdf" | "usd";

export type LibrarySampleTrainingDefaults = {
  templateId: string;
  recipeId: string;
  taskTemplate: string;
  task: string;
};

export type LibrarySampleUsdVariant = {
  id: string;
  label: string;
  entry: string;
  description?: string;
  bundleHintPaths?: string[];
  trainingDefaults?: LibrarySampleTrainingDefaults;
};

export type LibrarySampleTerrainOption = "none" | "flat" | "rough" | "full_scene";

export type LibrarySample = {
  id: string;
  label: string;
  description: string;
  kind: LibrarySampleKind;
  entry: string;
  /** For USD samples include entry + all referenced dependencies (layers/textures/meshes). */
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
    imageUrl?: string;
  };
  defaultImportOptions?: {
    urdf?: Partial<UrdfImportOptions>;
    usd?: Partial<UsdImportOptions>;
  };
  /** Optional alternate USD entries (modes/variants) for the same sample package. */
  usdVariants?: LibrarySampleUsdVariant[];
  /** Optional model-specific terrain options shown in the USD import dialog. */
  terrainOptions?: LibrarySampleTerrainOption[];
  trainingDefaults?: LibrarySampleTrainingDefaults;
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
      imageUrl: getLibrarySamplePreviewImage("cartpole"),
    },
    defaultImportOptions: {
      urdf: { floatingBase: false },
    },
    trainingDefaults: {
      templateId: "isaaclab.cartpole.manager.v1",
      recipeId: "isaaclab.cartpole.manager.v1",
      taskTemplate: "cartpole_manager",
      task: "Isaac-Cartpole-v0",
    },
  },
  {
    id: "ant",
    label: "Ant Sample",
    description: "Isaac Lab Ant USD sample.",
    kind: "usd",
    entry: "ant.usd",
    files: [
      "ant-LICENSE.txt",
      "ant.usd",
      "ant_colored.usd",
      "configuration/ant_colored_robot_schema.usd",
      "configuration/ant_robot_schema.usd",
    ],
    badge: "USD",
    importLabel: "Load sample",
    icon: "🐜",
    preview: {
      top: "rgba(109, 139, 179, 0.55)",
      bottom: "rgba(43, 58, 83, 0.92)",
      caption: "ANT",
      imageUrl: getLibrarySamplePreviewImage("ant"),
    },
    defaultImportOptions: {
      usd: {
        floatingBase: true,
        selfCollision: false,
      },
    },
    trainingDefaults: {
      templateId: "isaaclab.ant.manager.v1",
      recipeId: "isaaclab.ant.manager.v1",
      taskTemplate: "ant_manager",
      task: "Isaac-Ant-v0",
    },
    terrainOptions: ["none", "flat"],
    usdVariants: [
      {
        id: "standard",
        label: "Standard (default)",
        entry: "ant.usd",
      },
      {
        id: "colored",
        label: "Colored",
        entry: "ant_colored.usd",
      },
    ],
  },
  {
    id: "humanoid",
    label: "Humanoid Sample",
    description: "Isaac Lab Humanoid USD sample.",
    kind: "usd",
    entry: "humanoid.usd",
    files: [
      "configuration/humanoid_robot_schema.usd",
      "humanoid-LICENSE.txt",
      "humanoid.usd",
    ],
    badge: "USD",
    importLabel: "Load sample",
    icon: "🧍",
    preview: {
      top: "rgba(159, 126, 109, 0.56)",
      bottom: "rgba(84, 56, 43, 0.92)",
      caption: "HUMANOID",
      imageUrl: getLibrarySamplePreviewImage("humanoid"),
    },
    defaultImportOptions: {
      usd: {
        floatingBase: true,
        selfCollision: false,
      },
    },
    trainingDefaults: {
      templateId: "isaaclab.humanoid.manager.v1",
      recipeId: "isaaclab.humanoid.manager.v1",
      taskTemplate: "humanoid_manager",
      task: "Isaac-Humanoid-v0",
    },
    terrainOptions: ["none", "flat"],
  },
  {
    id: "anymal_c",
    label: "Anymal-C Sample",
    description: "Isaac Lab ANYmal-C USD sample.",
    kind: "usd",
    entry: "anymal_c.usd",
    files: [
      "Props/instanceable_meshes.usd",
      "Props/materials/base.jpg",
      "Props/materials/battery.jpg",
      "Props/materials/bottom_shell.jpg",
      "Props/materials/depth_camera.jpg",
      "Props/materials/drive.jpg",
      "Props/materials/face.jpg",
      "Props/materials/foot.jpg",
      "Props/materials/handle.jpg",
      "Props/materials/hatch.jpg",
      "Props/materials/hip.jpg",
      "Props/materials/lidar.jpg",
      "Props/materials/lidar_cage.jpg",
      "Props/materials/remote.jpg",
      "Props/materials/shank.jpg",
      "Props/materials/thigh.jpg",
      "Props/materials/top_shell.jpg",
      "Props/materials/wide_angle_camera.jpg",
      "anymal_c.usd",
      "configuration/anymal_c_robot_schema.usd",
      "legacy/anymal.usd",
      "legacy/anymal_base.usd",
      "legacy/anymal_c-LICENSE.txt",
      "legacy/anymal_instanceable.usd",
      "legacy/materials/base.jpg",
      "legacy/materials/battery.jpg",
      "legacy/materials/bottom_shell.jpg",
      "legacy/materials/depth_camera.jpg",
      "legacy/materials/drive.jpg",
      "legacy/materials/face.jpg",
      "legacy/materials/foot.jpg",
      "legacy/materials/handle.jpg",
      "legacy/materials/hatch.jpg",
      "legacy/materials/hip.jpg",
      "legacy/materials/lidar.jpg",
      "legacy/materials/lidar_cage.jpg",
      "legacy/materials/remote.jpg",
      "legacy/materials/shank.jpg",
      "legacy/materials/thigh.jpg",
      "legacy/materials/top_shell.jpg",
      "legacy/materials/wide_angle_camera.jpg",
    ],
    badge: "USD",
    importLabel: "Load sample",
    icon: "🐕",
    preview: {
      top: "rgba(121, 151, 117, 0.58)",
      bottom: "rgba(54, 76, 50, 0.92)",
      caption: "ANYMAL-C",
      imageUrl: getLibrarySamplePreviewImage("anymal_c"),
    },
    defaultImportOptions: {
      usd: {
        floatingBase: true,
        selfCollision: false,
      },
    },
    trainingDefaults: {
      templateId: "isaaclab.anymal_c.manager.v1",
      recipeId: "isaaclab.anymal_c.manager.v1",
      taskTemplate: "anymal_c_manager",
      task: "Isaac-Velocity-Rough-Anymal-C-v0",
    },
    terrainOptions: ["none", "flat", "rough"],
    usdVariants: [
      {
        id: "anymal_c",
        label: "ANYmal-C (default)",
        entry: "anymal_c.usd",
      },
      {
        id: "legacy",
        label: "Legacy",
        entry: "legacy/anymal.usd",
      },
    ],
  },
  {
    id: "open_arm",
    label: "Open Arm Sample",
    description: "OpenArm manipulator sample with unimanual/bimanual USD variants.",
    kind: "usd",
    entry: "openarm_unimanual/openarm_unimanual.usd",
    files: [
      "openarm_unimanual/openarm_unimanual.usd",
      "openarm_unimanual/configuration/openarm_unimanual_base.usd",
      "openarm_unimanual/configuration/openarm_unimanual_physics.usd",
      "openarm_unimanual/configuration/openarm_unimanual_sensor.usd",
      "openarm_bimanual/openarm_bimanual.usd",
      "openarm_bimanual/configuration/openarm_bimanual_base.usd",
      "openarm_bimanual/configuration/openarm_bimanual_physics.usd",
      "openarm_bimanual/configuration/openarm_bimanual_sensor.usd",
      "terrain/table_scene.usda",
    ],
    badge: "USD",
    importLabel: "Load sample",
    icon: "🦾",
    preview: {
      top: "rgba(112, 122, 158, 0.58)",
      bottom: "rgba(47, 57, 84, 0.92)",
      caption: "OPEN ARM",
      imageUrl: getLibrarySamplePreviewImage("open_arm"),
    },
    defaultImportOptions: {
      usd: {
        floatingBase: false,
        selfCollision: false,
      },
    },
    trainingDefaults: {
      templateId: "isaaclab.generic.manager.v1",
      recipeId: "isaaclab.generic.manager.v1",
      taskTemplate: "generic_manager",
      task: "Agent-Generic-Manager-v0",
    },
    terrainOptions: ["none"],
    usdVariants: [
      {
        id: "unimanual",
        label: "Unimanual (default)",
        entry: "openarm_unimanual/openarm_unimanual.usd",
      },
      {
        id: "bimanual",
        label: "Bimanual",
        entry: "openarm_bimanual/openarm_bimanual.usd",
      },
    ],
  },
];

export function getLibrarySampleById(sampleId: string): LibrarySample | null {
  return LIBRARY_SAMPLES.find((sample) => sample.id === sampleId) ?? null;
}

export function buildLibrarySampleEntryKey(sample: LibrarySample): string {
  return `${LIBRARY_ROOT}/${sample.id}/${sample.entry}`;
}

export function listLibrarySampleUsdEntries(sample: LibrarySample): string[] {
  if (sample.kind !== "usd") return [];
  const entries = [
    sample.entry,
    ...(Array.isArray(sample.usdVariants) ? sample.usdVariants.map((variant) => variant.entry) : []),
  ]
    .map((entry) => normalizeLibraryFile(String(entry ?? "").trim()))
    .filter((entry) => entry.length > 0);
  return Array.from(new Set(entries));
}

export function listLibrarySampleUsdWorkspaceKeys(sample: LibrarySample): string[] {
  return listLibrarySampleUsdEntries(sample).map((entry) => `${LIBRARY_ROOT}/${sample.id}/${entry}`);
}

export function findLibrarySampleKey(keys: string[], sample: LibrarySample): string | null {
  if (!keys.length) return null;
  const sampleEntryKeys = sample.kind === "usd"
    ? listLibrarySampleUsdWorkspaceKeys(sample)
    : [buildLibrarySampleEntryKey(sample)];
  for (const entryKey of sampleEntryKeys) {
    if (keys.includes(entryKey)) return entryKey;
  }

  const legacyKeys = sample.legacyKeys ?? [];
  for (const legacyKey of legacyKeys) {
    const normalizedLegacy = normalizeLibraryFile(legacyKey);
    const exact = keys.find((key) => key === normalizedLegacy);
    if (exact) return exact;
    const bySuffix = keys.find((key) => key.endsWith(`/${normalizedLegacy}`));
    if (bySuffix) return bySuffix;
  }

  const sampleEntries = sample.kind === "usd" ? listLibrarySampleUsdEntries(sample) : [sample.entry];
  for (const entry of sampleEntries) {
    const byEntry = keys.find((key) => key.endsWith(`/${entry}`));
    if (byEntry) return byEntry;
    const byName = keys.find((key) => key === entry);
    if (byName) return byName;
  }
  return null;
}

export function findLibrarySampleByWorkspaceKey(
  key: string,
  samples: LibrarySample[] = LIBRARY_SAMPLES
): LibrarySample | null {
  const normalized = normalizeLibraryFile(String(key ?? "").trim());
  if (!normalized) return null;
  for (const sample of samples) {
    const entryKeys = sample.kind === "usd"
      ? listLibrarySampleUsdWorkspaceKeys(sample)
      : [buildLibrarySampleEntryKey(sample)];
    for (const entryKeyRaw of entryKeys) {
      const entryKey = normalizeLibraryFile(entryKeyRaw);
      if (entryKey === normalized) return sample;
    }

    const sampleEntries = sample.kind === "usd" ? listLibrarySampleUsdEntries(sample) : [sample.entry];
    for (const entry of sampleEntries) {
      if (normalized === entry || normalized.endsWith(`/${entry}`)) return sample;
    }

    const legacyKeys = sample.legacyKeys ?? [];
    for (const legacyKey of legacyKeys) {
      const normalizedLegacy = normalizeLibraryFile(legacyKey);
      if (!normalizedLegacy) continue;
      if (normalized === normalizedLegacy || normalized.endsWith(`/${normalizedLegacy}`)) return sample;
    }
  }
  return null;
}

export function findLibrarySampleFromKeys(
  keys: string[],
  samples: LibrarySample[] = LIBRARY_SAMPLES
): { sample: LibrarySample; matchedKey: string } | null {
  for (const sample of samples) {
    const matchedKey = findLibrarySampleKey(keys, sample);
    if (matchedKey) return { sample, matchedKey };
  }
  return null;
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

export async function fetchLibrarySampleFiles(sample: LibrarySample, filePaths?: string[]): Promise<File[]> {
  const baseUrl = resolveLibraryBaseUrl();
  const sourcePaths =
    Array.isArray(filePaths) && filePaths.length > 0 ? filePaths : sample.files;
  const uniqueFiles = new Set<string>(sourcePaths.map((file) => normalizeLibraryFile(file)));
  const normalizedEntry = normalizeLibraryFile(sample.entry);
  if (!uniqueFiles.has(normalizedEntry)) uniqueFiles.add(normalizedEntry);
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
  const assetKeys = Object.keys(assetsProvider()).map((key) => normalizeLibraryFile(key));
  const existingKey = findLibrarySampleKey(assetKeys, sample);
  const knownAssetKeySet = new Set(assetKeys);
  const expectedFiles = new Set<string>(sample.files.map((file) => normalizeLibraryFile(file)));
  expectedFiles.add(normalizeLibraryFile(sample.entry));
  const missingFiles = Array.from(expectedFiles).filter(
    (filePath) => !knownAssetKeySet.has(`${LIBRARY_ROOT}/${sample.id}/${filePath}`)
  );
  if (existingKey && missingFiles.length === 0) return existingKey;
  const files = await fetchLibrarySampleFiles(sample, missingFiles.length > 0 ? missingFiles : undefined);
  importFiles(files);
  return findLibrarySampleKey(Object.keys(assetsProvider()), sample);
}
