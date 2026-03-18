import { useCallback, useMemo, useRef, useState, type DragEvent } from "react";
import { addSceneAsset } from "../../app/core/editor/actions/sceneAssetActions";
import { setNodeTransformCommand } from "../../app/core/editor/commands/sceneCommands";
import { editorEngine } from "../../app/core/editor/engineSingleton";
import { BROWSER_DIRECTORIES, type BrowserDirectoryId } from "../../app/core/browser/directories";
import { importManager } from "../../app/core/environment/ImportManager";
import { logInfo, logWarn } from "../../app/core/services/logger";
import type { SceneAssetId } from "../../app/core/scene/sceneAssets";
import { useAssetStore } from "../../app/core/store/useAssetStore";
import { useBrowserStore } from "../../app/core/store/useBrowserStore";
import { useBrowserPreviewStore, type BrowserWorkspacePreviewEntry } from "../../app/core/store/useBrowserPreviewStore";
import { useDockStore } from "../../app/core/store/useDockStore";
import { useFileViewerStore } from "../../app/core/store/useFileViewerStore";
import { useUrdfImportDialogStore } from "../../app/core/store/useUrdfImportDialogStore";
import { useUsdImportDialogStore } from "../../app/core/store/useUsdImportDialogStore";
import { isUrdfLikePath } from "../../app/core/urdf/urdfFileTypes";
import {
  BROWSER_IMPORT_MIME,
  type BrowserImportPayload,
  encodeBrowserImportPayload,
} from "./browserDragDrop";
import {
  MANAGED_FLAT_FLOOR_WORKSPACE_KEY,
  ensureLibrarySampleImported,
  findLibrarySampleByWorkspaceKey,
  getLibrarySampleById,
  hasLibrarySampleEnvironment,
  LIBRARY_SAMPLES,
  listLibrarySampleEnvironmentWorkspaceKeys,
  listLibrarySampleUsdWorkspaceKeys,
  resolveDefaultSampleEnvironmentWorkspaceKey,
} from "./librarySamples";
import {
  ensureLibraryAssetPackItemImported,
  getLibraryAssetPackItemById,
  getLibraryAssetPackPresetById,
  listLinkLibraryAssetPackItems,
  listLinkLibraryAssetPackPresets,
} from "./libraryAssetPacks";
import { getBrowserItemPreviewImage } from "./browserPreviewCatalog";
import { buildTree, type TreeNode } from "../explorer/model/tree";

type LibrarySectionId = Exclude<BrowserDirectoryId, "workspace">;

type BrowserCardPreview = {
  top: string;
  bottom: string;
  caption: string;
  imageUrl?: string;
};

type BrowserItem = {
  id: string;
  label: string;
  pathName?: string;
  description: string;
  icon: string;
  badge?: string;
  envBadge?: boolean;
  assetId?: SceneAssetId;
  sampleId?: string;
  assetPackItemId?: string;
  assetPackPresetId?: string;
  importLabel?: string;
  preview: BrowserCardPreview;
};

type BrowserSection = {
  id: LibrarySectionId;
  title: string;
  items: BrowserItem[];
};

type WorkspaceEntry = {
  kind: "dir" | "file";
  name: string;
  path: string;
  description: string;
  icon: string;
  actionLabel: string;
  preview: BrowserCardPreview;
  previewStatus?: BrowserWorkspacePreviewEntry;
};

type BreadcrumbItem = {
  label: string;
  onClick?: () => void;
};

type NavigationSelection<TValue> = {
  value: TValue;
  navigationVersion: number;
};

const USD_EXTS = [".usd", ".usda", ".usdc", ".usdz"];

const isUsdPath = (path: string) => {
  const lower = path.toLowerCase();
  return USD_EXTS.some((ext) => lower.endsWith(ext));
};

const normalizeWorkspaceFilePath = (path: string) => path.replace(/\\/g, "/").replace(/^\/+/, "");

const xacroCaption = (path: string) => (path.toLowerCase().endsWith(".xacro") ? "XACRO" : "URDF");

const resolvePublicBaseUrl = () => {
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
  return base.endsWith("/") ? base : `${base}/`;
};

const createWorkspaceFile = (blob: Blob, workspaceKey: string) => {
  const filename = workspaceKey.split("/").pop() ?? workspaceKey;
  const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
  Object.defineProperty(file, "webkitRelativePath", {
    value: normalizeWorkspaceFilePath(workspaceKey),
    configurable: true,
  });
  return file;
};

const LIBRARY_SAMPLE_ITEMS: BrowserItem[] = LIBRARY_SAMPLES.map((sample) => ({
  id: `robot-sample-${sample.id}`,
  label: sample.label,
  pathName: sample.label.replace(/\s+/g, ""),
  description: sample.description,
  icon: sample.icon ?? (sample.kind === "usd" ? "🔷" : "🧪"),
  badge: sample.badge ?? sample.kind.toUpperCase(),
  envBadge: hasLibrarySampleEnvironment(sample),
  sampleId: sample.id,
  importLabel: sample.importLabel ?? "Load sample",
  preview: {
    ...sample.preview,
    imageUrl: sample.preview.imageUrl ?? getBrowserItemPreviewImage(`robot-sample-${sample.id}`),
  },
}));

const UR10_LINK_PACK_ITEMS: BrowserItem[] = listLinkLibraryAssetPackItems("ur10").map((item) => ({
  id: `link-pack-${item.id}`,
  label: item.label,
  pathName: item.label.replace(/\s+/g, ""),
  description: item.description,
  icon: "🧩",
  badge: "USD",
  assetPackItemId: item.id,
  importLabel: "Import asset",
  preview: {
    top: "rgba(116, 138, 157, 0.56)",
    bottom: "rgba(46, 57, 73, 0.9)",
    caption: "UR10 LINK",
    imageUrl: getBrowserItemPreviewImage(`link-pack-${item.id}`),
  },
}));

const UR10_LINK_PACK_PRESET_ITEMS: BrowserItem[] = listLinkLibraryAssetPackPresets("ur10").map((preset) => ({
  id: `link-pack-preset-${preset.id}`,
  label: preset.label,
  pathName: preset.label.replace(/\s+/g, ""),
  description: preset.description,
  icon: "📦",
  badge: "PRESET",
  assetPackPresetId: preset.id,
  importLabel: "Import preset",
  preview: {
    top: "rgba(132, 152, 104, 0.56)",
    bottom: "rgba(51, 66, 40, 0.9)",
    caption: "SCENE",
    imageUrl: getBrowserItemPreviewImage(`link-pack-preset-${preset.id}`),
  },
}));

const LIBRARY_SECTIONS: BrowserSection[] = [
  {
    id: "floors",
    title: "Floors",
    items: [
      {
        id: "floor-default",
        label: "Default Floor",
        pathName: "DefaultFloor",
        description: "Adds the existing 6m floor plane.",
        icon: "▦",
        assetId: "floor",
        preview: {
          top: "rgba(78, 117, 151, 0.55)",
          bottom: "rgba(32, 47, 64, 0.88)",
          caption: "PLANE",
          imageUrl: getBrowserItemPreviewImage("floor-default"),
        },
      },
      {
        id: "floor-rough",
        label: "Rough Floor",
        pathName: "RoughFloor",
        description: "Adds a rough floor profile for locomotion previews.",
        icon: "▨",
        assetId: "floor:rough",
        preview: {
          top: "rgba(121, 146, 98, 0.55)",
          bottom: "rgba(51, 68, 39, 0.88)",
          caption: "ROUGH",
          imageUrl: getBrowserItemPreviewImage("floor-rough"),
        },
      },
    ],
  },
  {
    id: "robots",
    title: "Robots",
    items: [
      {
        id: "robot-new",
        label: "New Robot",
        pathName: "NewRobot",
        description: "Creates a robot root in the current scene.",
        icon: "🤖",
        assetId: "robot",
        preview: {
          top: "rgba(118, 130, 166, 0.56)",
          bottom: "rgba(40, 44, 67, 0.9)",
          caption: "ROBOT",
        },
      },
      ...LIBRARY_SAMPLE_ITEMS,
    ],
  },
  {
    id: "links",
    title: "Links",
    items: [
      {
        id: "link-empty",
        label: "Empty Link",
        pathName: "EmptyLink",
        description: "Creates a link container with visual and collision nodes.",
        icon: "🔗",
        assetId: "link",
        preview: {
          top: "rgba(137, 117, 180, 0.56)",
          bottom: "rgba(62, 46, 92, 0.9)",
          caption: "LINK",
        },
      },
      {
        id: "link-cube",
        label: "Cube Link",
        pathName: "CubeLink",
        description: "Link with a cube primitive.",
        icon: "⬛",
        assetId: "mesh:cube",
        preview: {
          top: "rgba(120, 125, 134, 0.56)",
          bottom: "rgba(56, 61, 70, 0.92)",
          caption: "CUBE",
          imageUrl: getBrowserItemPreviewImage("link-cube"),
        },
      },
      {
        id: "link-sphere",
        label: "Sphere Link",
        pathName: "SphereLink",
        description: "Link with a sphere primitive.",
        icon: "⚪",
        assetId: "mesh:sphere",
        preview: {
          top: "rgba(133, 159, 170, 0.6)",
          bottom: "rgba(53, 65, 73, 0.93)",
          caption: "SPHERE",
          imageUrl: getBrowserItemPreviewImage("link-sphere"),
        },
      },
      {
        id: "link-cylinder",
        label: "Cylinder Link",
        pathName: "CylinderLink",
        description: "Link with a cylinder primitive.",
        icon: "🥫",
        assetId: "mesh:cylinder",
        preview: {
          top: "rgba(171, 131, 107, 0.58)",
          bottom: "rgba(83, 59, 46, 0.92)",
          caption: "CYLINDER",
          imageUrl: getBrowserItemPreviewImage("link-cylinder"),
        },
      },
      ...UR10_LINK_PACK_ITEMS,
      ...UR10_LINK_PACK_PRESET_ITEMS,
    ],
  },
  {
    id: "joints",
    title: "Joints",
    items: [
      {
        id: "joint-free",
        label: "Free Joint",
        pathName: "FreeJoint",
        description: "Joint without actuator (passive).",
        icon: "🧷",
        assetId: "joint:free",
        preview: {
          top: "rgba(104, 132, 181, 0.56)",
          bottom: "rgba(40, 53, 87, 0.9)",
          caption: "PASSIVE",
        },
      },
      {
        id: "joint-actuator",
        label: "Actuator",
        pathName: "Actuator",
        description: "Joint with actuator enabled by default.",
        icon: "🎛️",
        assetId: "joint:actuator",
        preview: {
          top: "rgba(165, 122, 178, 0.58)",
          bottom: "rgba(72, 40, 90, 0.92)",
          caption: "ACTIVE",
        },
      },
      {
        id: "joint-muscle",
        label: "Muscle Joint",
        pathName: "MuscleJoint",
        description: "Joint using tendon+muscle actuator mode.",
        icon: "🫀",
        assetId: "joint:muscle",
        preview: {
          top: "rgba(148, 146, 126, 0.58)",
          bottom: "rgba(70, 67, 52, 0.92)",
          caption: "MUSCLE",
        },
      },
    ],
  },
];

function isMeshAssetId(assetId: SceneAssetId) {
  return assetId.startsWith("mesh:");
}

function resolveItemPathName(item: BrowserItem) {
  return item.pathName ?? item.label.replace(/\s+/g, "");
}

function normalizeWorkspaceDir(path: string) {
  if (!path) return "";
  const norm = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!norm) return "";
  return norm.endsWith("/") ? norm : `${norm}/`;
}

type WorkspaceDirNode = Extract<TreeNode, { kind: "dir" }>;

function resolveWorkspaceDirectoryNode(root: TreeNode, workspacePath: string) {
  if (root.kind !== "dir") return null;
  if (!workspacePath) return root;
  const target = normalizeWorkspaceDir(workspacePath);
  const parts = target.split("/").filter(Boolean);

  let current: WorkspaceDirNode = root;
  let currentPath = "";
  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}${part}/` : `${part}/`;
    const next = current.children.find(
      (node): node is WorkspaceDirNode => node.kind === "dir" && node.path === currentPath
    );
    if (!next) return null;
    current = next;
  }
  return current;
}

function workspaceEntryPreview(name: string, isDir: boolean) {
  if (isDir) {
    return {
      top: "rgba(89, 124, 168, 0.56)",
      bottom: "rgba(38, 53, 74, 0.92)",
      caption: "FOLDER",
    };
  }

  if (isUrdfLikePath(name)) {
    return {
      top: "rgba(94, 150, 111, 0.58)",
      bottom: "rgba(37, 74, 53, 0.92)",
      caption: xacroCaption(name),
    };
  }
  if (isUsdPath(name)) {
    return {
      top: "rgba(120, 100, 180, 0.58)",
      bottom: "rgba(55, 35, 95, 0.92)",
      caption: "USD",
    };
  }
  const lower = name.toLowerCase();
  if (lower.endsWith(".stl") || lower.endsWith(".dae") || lower.endsWith(".obj")) {
    return {
      top: "rgba(140, 134, 112, 0.58)",
      bottom: "rgba(75, 68, 48, 0.93)",
      caption: "MESH",
    };
  }
  return {
    top: "rgba(120, 128, 142, 0.56)",
    bottom: "rgba(52, 57, 71, 0.92)",
    caption: "FILE",
  };
}

function workspaceEntryIcon(name: string, isDir: boolean) {
  if (isDir) return "📁";
  if (isUrdfLikePath(name)) return name.toLowerCase().endsWith(".xacro") ? "🧩" : "🤖";
  if (isUsdPath(name)) return "🔷";
  const lower = name.toLowerCase();
  if (lower.endsWith(".stl") || lower.endsWith(".dae") || lower.endsWith(".obj")) return "🧊";
  return "📄";
}

export default function AssetLibraryPanel() {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<NavigationSelection<string> | null>(null);
  const [selectedRootDirectoryId, setSelectedRootDirectoryId] =
    useState<NavigationSelection<BrowserDirectoryId> | null>(null);
  const [workspacePath, setWorkspacePath] = useState("");
  const [selectedWorkspacePath, setSelectedWorkspacePath] =
    useState<NavigationSelection<string> | null>(null);

  const activeDirectory = useBrowserStore((s) => s.activeDirectory);
  const navigationVersion = useBrowserStore((s) => s.navigationVersion);
  const setActiveDirectory = useBrowserStore((s) => s.setActiveDirectory);
  const assets = useAssetStore((s) => s.assets);
  const importFiles = useAssetStore((s) => s.importFiles);
  const setURDF = useAssetStore((s) => s.setURDF);
  const requestUrdfImport = useUrdfImportDialogStore((s) => s.requestImport);
  const requestUsdImport = useUsdImportDialogStore((s) => s.requestImport);
  const setActiveFile = useFileViewerStore((s) => s.setActiveFile);
  const openPanel = useDockStore((s) => s.openPanel);
  const isOpen = useDockStore((s) => s.isOpen);
  const workspacePreviews = useBrowserPreviewStore((s) => s.workspacePreviews);
  const touchWorkspacePreview = useBrowserPreviewStore((s) => s.touch);
  const libraryItemPreviews = useBrowserPreviewStore((s) => s.libraryItemPreviews);
  const touchLibraryItemPreview = useBrowserPreviewStore((s) => s.touchLibraryItem);
  const enqueueLibraryItemCapture = useBrowserPreviewStore((s) => s.enqueueLibraryItemCapture);

  const spawnIndex = useRef(0);
  const normalizedQuery = query.trim().toLowerCase();

  const activeSection = useMemo(
    () =>
      activeDirectory === "root" || activeDirectory === "workspace"
        ? null
        : LIBRARY_SECTIONS.find((section) => section.id === activeDirectory) ?? null,
    [activeDirectory]
  );

  const visibleItems = useMemo(() => {
    if (!activeSection) return [] as BrowserItem[];
    if (!normalizedQuery) return activeSection.items;
    return activeSection.items.filter((item) => {
      const searchText = `${activeSection.title} ${item.label} ${item.description}`.toLowerCase();
      return searchText.includes(normalizedQuery);
    });
  }, [activeSection, normalizedQuery]);

  const selectedItem = useMemo(() => {
    if (!activeSection) return null;
    if (!selectedId) return null;
    if (selectedId.navigationVersion !== navigationVersion) return null;
    return activeSection.items.find((item) => item.id === selectedId.value) ?? null;
  }, [activeSection, navigationVersion, selectedId]);

  const workspaceTree = useMemo(() => buildTree(Object.keys(assets).sort()), [assets]);
  const workspaceDirNode = useMemo(
    () => resolveWorkspaceDirectoryNode(workspaceTree, workspacePath),
    [workspaceTree, workspacePath]
  );

  const workspaceEntries = useMemo(() => {
    if (!workspaceDirNode) return [] as WorkspaceEntry[];
    return workspaceDirNode.children
      .filter((node) => {
        if (!normalizedQuery) return true;
        return node.name.toLowerCase().includes(normalizedQuery);
      })
      .map((node) => {
        const isDir = node.kind === "dir";
        const normalizedPath = normalizeWorkspaceFilePath(node.path);
        const previewStatus = workspacePreviews[normalizedPath];
        const sample = isDir ? null : findLibrarySampleByWorkspaceKey(normalizedPath);
        const sampleImageUrl = sample?.preview.imageUrl;
        const preview = {
          ...workspaceEntryPreview(node.name, isDir),
          imageUrl: previewStatus?.status === "ready" ? previewStatus.dataUrl : sampleImageUrl,
        };
        return {
          kind: isDir ? "dir" : "file",
          name: node.name,
          path: node.path,
          description: isDir ? "Directory" : node.path,
          icon: workspaceEntryIcon(node.name, isDir),
          actionLabel: isDir ? "Open" : isUrdfLikePath(node.name) || isUsdPath(node.name) ? "Import" : "Open",
          preview,
          previewStatus,
        } satisfies WorkspaceEntry;
      });
  }, [normalizedQuery, workspaceDirNode, workspacePreviews]);

  const selectedWorkspaceEntry = useMemo(() => {
    if (!selectedWorkspacePath) return null;
    if (selectedWorkspacePath.navigationVersion !== navigationVersion) return null;
    return workspaceEntries.find((entry) => entry.path === selectedWorkspacePath.value) ?? null;
  }, [navigationVersion, selectedWorkspacePath, workspaceEntries]);

  const visibleRootDirectories = useMemo(() => {
    if (!normalizedQuery) return BROWSER_DIRECTORIES;
    return BROWSER_DIRECTORIES.filter((directory) => {
      const searchText = `${directory.title} ${directory.description}`.toLowerCase();
      return searchText.includes(normalizedQuery);
    });
  }, [normalizedQuery]);

  const selectedRootDirectory = useMemo(() => {
    if (!selectedRootDirectoryId) return null;
    if (selectedRootDirectoryId.navigationVersion !== navigationVersion) return null;
    return BROWSER_DIRECTORIES.find((directory) => directory.id === selectedRootDirectoryId.value) ?? null;
  }, [navigationVersion, selectedRootDirectoryId]);

  const ensureWorkspaceLibraryFilesImported = useCallback(
    async (workspaceKeys: string[]) => {
      const normalizedRequested = workspaceKeys
        .map((key) => normalizeWorkspaceFilePath(key))
        .filter((key) => key.length > 0);
      if (normalizedRequested.length === 0) return true;
      const known = new Set(
        Object.keys(useAssetStore.getState().assets)
          .map((key) => normalizeWorkspaceFilePath(key))
          .filter((key) => key.length > 0)
      );
      const missing = normalizedRequested.filter((key) => !known.has(key));
      if (missing.length === 0) return true;

      const baseUrl = resolvePublicBaseUrl();
      const files: File[] = [];
      for (const workspaceKey of missing) {
        const url = `${baseUrl}${workspaceKey}`;
        const response = await fetch(url);
        if (!response.ok) {
          logWarn("Browser managed library asset download failed", {
            scope: "assets",
            data: {
              workspaceKey,
              status: response.status,
              statusText: response.statusText,
            },
          });
          return false;
        }
        const blob = await response.blob();
        files.push(createWorkspaceFile(blob, workspaceKey));
      }
      importFiles(files);
      return true;
    },
    [importFiles]
  );

  const applyImportedRootTransform = useCallback((rootId: string, transform: {
    position?: { x: number; y: number; z: number };
    rotationDeg?: { x: number; y: number; z: number };
    scale?: { x: number; y: number; z: number };
  }) => {
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
  }, []);

  const importManagedTerrainAssetIfAvailable = useCallback(
    async (assetId: SceneAssetId, label: string) => {
      const managedWorkspaceKeys =
        assetId === "floor"
          ? [MANAGED_FLAT_FLOOR_WORKSPACE_KEY]
          : assetId === "floor:rough"
            ? []
            : [];
      if (managedWorkspaceKeys.length === 0) return false;

      for (const managedWorkspaceKey of managedWorkspaceKeys) {
        const ready = await ensureWorkspaceLibraryFilesImported([managedWorkspaceKey]);
        if (!ready) continue;

        const assetStore = useAssetStore.getState();
        const result = await importManager.import_usd({
          usdKey: managedWorkspaceKey,
          assets: assetStore.assets,
          importOptions: assetStore.usdOptions,
          bundleHintPaths: [managedWorkspaceKey],
          sceneRole: "scene_asset",
          rootName: label,
        });
        if (!result.ok) {
          logWarn("Browser managed terrain import failed; trying next managed terrain candidate.", {
            scope: "assets",
            data: {
              assetId,
              managedWorkspaceKey,
              diagnostics: result.diagnostics,
            },
          });
          continue;
        }
        logInfo(`Browser import: ${label} (managed terrain)`, {
          scope: "assets",
          data: {
            assetId,
            managedWorkspaceKey,
            rootId: result.rootId,
          },
        });
        return true;
      }

      logWarn("Browser managed terrain import unavailable; using generated fallback.", {
        scope: "assets",
        data: {
          assetId,
          managedWorkspaceKeys,
        },
      });
      return false;
    },
    [ensureWorkspaceLibraryFilesImported]
  );

  const importSceneAsset = useCallback(
    async (assetId: SceneAssetId, label: string) => {
      if (assetId === "floor" || assetId === "floor:rough") {
        const managedImported = await importManagedTerrainAssetIfAvailable(assetId, label);
        if (managedImported) return true;
      }
      const isMesh = isMeshAssetId(assetId);
      const idx = isMesh ? spawnIndex.current++ : spawnIndex.current;
      const position = isMesh
        ? {
            x: idx * 1.5,
            y: 1.5,
            z: assetId === "mesh:sphere" ? -0.2 : 0,
          }
        : undefined;
      addSceneAsset(assetId, { position });
      logInfo(`Browser import: ${label}`, { scope: "assets", data: { assetId } });
      return true;
    },
    [importManagedTerrainAssetIfAvailable]
  );

  const openFileInEditor = (path: string) => {
    setActiveFile(path);
    const existing = isOpen("editor");
    const dock = existing?.dock ?? "main";
    openPanel(dock, "editor");
  };

  const importWorkspaceFile = (path: string) => {
    if (isUrdfLikePath(path)) {
      setURDF(path);
      requestUrdfImport({
        urdfKey: path,
        source: "browser",
      });
      logInfo("Browser import request: Workspace URDF", { scope: "assets", data: { urdfKey: path } });
      return;
    }
    if (isUsdPath(path)) {
      const store = useAssetStore.getState();
      store.setUSD(path);
      const sample = findLibrarySampleByWorkspaceKey(path);
      const sampleVariantKeys = sample
        ? listLibrarySampleUsdWorkspaceKeys(sample).filter((key) => Boolean(store.assets[key]))
        : [];
      const variantUsdKeys = sampleVariantKeys.length > 0 ? sampleVariantKeys : [normalizeWorkspaceFilePath(path)];
      const terrainUsdKeys = sample ? listLibrarySampleEnvironmentWorkspaceKeys(sample).filter((key) => Boolean(store.assets[key])) : [];
      requestUsdImport({
        usdKey: path,
        source: "browser",
        optionOverrides: sample?.defaultImportOptions?.usd,
        bundleHintPaths: sample?.files,
        variantUsdKeys,
        terrainUsdKeys,
        selectedTerrainUsdKey: sample ? resolveDefaultSampleEnvironmentWorkspaceKey(sample, path) : terrainUsdKeys[0] ?? null,
      });
      logInfo("Browser import request: Workspace USD", { scope: "assets", data: { usdKey: path } });
      return;
    }
    openFileInEditor(path);
  };

  const importLibrarySample = useCallback(
    async (sampleId: string) => {
      const sample = getLibrarySampleById(sampleId);
      if (!sample) return false;

      const sampleKey = await ensureLibrarySampleImported(
        sample,
        () => useAssetStore.getState().assets,
        importFiles
      );
      if (!sampleKey) return false;

      const store = useAssetStore.getState();
      if (sample.kind === "urdf") {
        store.setURDF(sampleKey);
        requestUrdfImport({
          urdfKey: sampleKey,
          source: "browser",
          optionOverrides: sample.defaultImportOptions?.urdf,
        });
        logInfo(`Browser import request: Library sample ${sample.id} (URDF)`, {
          scope: "assets",
          data: { sampleId: sample.id, urdfKey: sampleKey },
        });
        return false;
      }

      store.setUSD(sampleKey);
      const variantUsdKeys = listLibrarySampleUsdWorkspaceKeys(sample).filter((key) => Boolean(store.assets[key]));
      const terrainUsdKeys = listLibrarySampleEnvironmentWorkspaceKeys(sample).filter((key) => Boolean(store.assets[key]));
      requestUsdImport({
        usdKey: sampleKey,
        source: "browser",
        optionOverrides: sample.defaultImportOptions?.usd,
        bundleHintPaths: sample.files,
        variantUsdKeys,
        terrainUsdKeys,
        selectedTerrainUsdKey: resolveDefaultSampleEnvironmentWorkspaceKey(sample, sampleKey),
      });
      logInfo(`Browser import request: Library sample ${sample.id} (USD)`, {
        scope: "assets",
        data: { sampleId: sample.id, usdKey: sampleKey },
      });
      return false;
    },
    [importFiles, requestUrdfImport, requestUsdImport]
  );

  const importLibraryAssetPackItem = useCallback(
    async (
      itemId: string,
      options?: {
        transform?: {
          position?: { x: number; y: number; z: number };
          rotationDeg?: { x: number; y: number; z: number };
          scale?: { x: number; y: number; z: number };
        };
      }
    ) => {
      const item = getLibraryAssetPackItemById(itemId);
      if (!item) return false;

      const workspaceKey = await ensureLibraryAssetPackItemImported(
        item,
        () => useAssetStore.getState().assets,
        importFiles
      );
      if (!workspaceKey) {
        logWarn("Library asset-pack import failed to hydrate workspace files", {
          scope: "assets",
          data: { itemId: item.id },
        });
        return false;
      }
      const assetStore = useAssetStore.getState();
      const result = await importManager.import_usd({
        usdKey: workspaceKey,
        assets: assetStore.assets,
        importOptions: assetStore.usdOptions,
        bundleHintPaths: item.files,
        sceneRole: item.sceneRole === "terrain" ? "scene_asset" : item.sceneRole,
        rootName: item.rootName ?? item.label,
      });
      if (!result.ok) {
        logWarn("Library asset-pack USD import failed", {
          scope: "assets",
          data: {
            itemId: item.id,
            workspaceKey,
            diagnostics: result.diagnostics,
          },
        });
        return false;
      }
      if (result.rootId && options?.transform) {
        applyImportedRootTransform(result.rootId, options.transform);
      }
      logInfo("Library asset-pack imported", {
        scope: "assets",
        data: {
          itemId: item.id,
          workspaceKey,
          rootId: result.rootId,
        },
      });
      return true;
    },
    [applyImportedRootTransform, importFiles]
  );

  const importLibraryAssetPackPreset = useCallback(
    async (presetId: string) => {
      const preset = getLibraryAssetPackPresetById(presetId);
      if (!preset) return false;
      let importedAtLeastOne = false;
      for (const placement of preset.placements) {
        const imported = await importLibraryAssetPackItem(placement.itemId, {
          transform: placement.transform,
        });
        importedAtLeastOne = importedAtLeastOne || imported;
      }
      logInfo("Library asset-pack preset imported", {
        scope: "assets",
        data: {
          presetId: preset.id,
          placementCount: preset.placements.length,
        },
      });
      return importedAtLeastOne;
    },
    [importLibraryAssetPackItem]
  );

  const importAssetItem = useCallback(
    async (item: BrowserItem | null) => {
      if (!item) return;
      let importedNow = false;
      if (item.assetId) {
        importedNow = await importSceneAsset(item.assetId, item.label);
      } else if (item.sampleId) {
        importedNow = await importLibrarySample(item.sampleId);
      } else if (item.assetPackItemId) {
        importedNow = await importLibraryAssetPackItem(item.assetPackItemId);
      } else if (item.assetPackPresetId) {
        importedNow = await importLibraryAssetPackPreset(item.assetPackPresetId);
      }
      if (importedNow) {
        enqueueLibraryItemCapture(item.id);
      }
    },
    [enqueueLibraryItemCapture, importLibraryAssetPackItem, importLibraryAssetPackPreset, importLibrarySample, importSceneAsset]
  );

  const openDirectoryFromRoot = (directoryId: BrowserDirectoryId) => {
    setActiveDirectory(directoryId);
    setSelectedId(null);
    setSelectedWorkspacePath(null);
    if (directoryId === "workspace") {
      setWorkspacePath("");
    }
  };

  const openWorkspaceDirectory = useCallback((path: string) => {
    setWorkspacePath(normalizeWorkspaceDir(path));
    setSelectedWorkspacePath(null);
  }, []);

  const executeWorkspaceEntry = (entry: WorkspaceEntry | null) => {
    if (!entry) return;
    if (entry.kind === "dir") {
      openWorkspaceDirectory(entry.path);
      return;
    }
    importWorkspaceFile(entry.path);
  };

  const onImportSelected = () => {
    if (activeDirectory === "root") return;
    if (activeDirectory === "workspace") {
      executeWorkspaceEntry(selectedWorkspaceEntry);
      return;
    }
    void importAssetItem(selectedItem);
  };

  const dragPayloadFromBrowserItem = (item: BrowserItem): BrowserImportPayload | null => {
    if (item.assetId) {
      return { kind: "asset", assetId: item.assetId, label: item.label };
    }
    if (item.sampleId) {
      return { kind: "sample", sampleId: item.sampleId, label: item.label };
    }
    return null;
  };

  const dragPayloadFromWorkspaceEntry = (entry: WorkspaceEntry): BrowserImportPayload | null => {
    if (entry.kind !== "file") return null;
    if (isUrdfLikePath(entry.path)) return { kind: "workspace-urdf", path: entry.path, label: entry.name };
    if (isUsdPath(entry.path)) return { kind: "workspace-usd", path: entry.path, label: entry.name };
    return null;
  };

  const onCardDragStart = (event: DragEvent<HTMLElement>, payload: BrowserImportPayload | null) => {
    if (!payload) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(BROWSER_IMPORT_MIME, encodeBrowserImportPayload(payload));
    event.dataTransfer.setData("text/plain", payload.label);
  };

  const breadcrumbItems = useMemo(() => {
    const crumbs: BreadcrumbItem[] = [
      {
        label: "Directories",
        onClick:
          activeDirectory === "root"
            ? undefined
            : () => {
                setActiveDirectory("root");
                setSelectedRootDirectoryId(null);
              },
      },
    ];

    if (activeDirectory === "root") {
      if (selectedRootDirectory) {
        crumbs.push({ label: selectedRootDirectory.title });
      }
      return crumbs;
    }

    if (activeDirectory === "workspace") {
      crumbs.push({
        label: "Workspace",
        onClick: workspacePath ? () => openWorkspaceDirectory("") : undefined,
      });
      const parts = workspacePath.split("/").filter(Boolean);
      let acc = "";
      for (const part of parts) {
        acc = acc ? `${acc}${part}/` : `${part}/`;
        const target = acc;
        crumbs.push({
          label: part,
          onClick: target === workspacePath ? undefined : () => openWorkspaceDirectory(target),
        });
      }
      return crumbs;
    }

    if (activeSection) {
      crumbs.push({
        label: activeSection.title,
        onClick: () => setSelectedId(null),
      });
      if (selectedItem) {
        crumbs.push({ label: resolveItemPathName(selectedItem) });
      }
    }
    return crumbs;
  }, [activeDirectory, activeSection, openWorkspaceDirectory, selectedItem, selectedRootDirectory, setActiveDirectory, workspacePath]);

  const importDisabled =
    activeDirectory === "root"
      ? true
      : activeDirectory === "workspace"
        ? !selectedWorkspaceEntry
        : !selectedItem;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div
        style={{
          padding: "10px 12px",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "linear-gradient(180deg, rgba(22,28,37,0.95) 0%, rgba(13,19,26,1) 100%)",
          minWidth: 0,
        }}
      >
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 6,
            overflow: "hidden",
            whiteSpace: "nowrap",
          }}
        >
          {breadcrumbItems.map((crumb, index) => {
            const last = index === breadcrumbItems.length - 1;
            return (
              <div key={`${crumb.label}-${index}`} style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                {crumb.onClick && !last ? (
                  <button
                    onClick={crumb.onClick}
                    style={{
                      border: "none",
                      background: "transparent",
                      color: "rgba(200,220,242,0.95)",
                      cursor: "pointer",
                      padding: 0,
                      fontSize: 12,
                    }}
                  >
                    {crumb.label}
                  </button>
                ) : (
                  <span style={{ fontSize: 12, color: last ? "rgba(245,250,255,0.96)" : "rgba(200,220,242,0.95)" }}>{crumb.label}</span>
                )}
                {!last && <span style={{ fontSize: 12, opacity: 0.5 }}>/</span>}
              </div>
            );
          })}
        </div>

        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search..."
          style={{
            width: 150,
            minWidth: 120,
            height: 28,
            borderRadius: 7,
            border: "1px solid rgba(255,255,255,0.12)",
            background: "rgba(255,255,255,0.05)",
            color: "rgba(255,255,255,0.92)",
            padding: "0 9px",
            fontSize: 12,
          }}
        />

        <button
          onClick={() => {
            void onImportSelected();
          }}
          disabled={importDisabled}
          style={{
            height: 28,
            borderRadius: 8,
            border: "1px solid rgba(120,170,220,0.45)",
            background: "rgba(80,160,255,0.18)",
            color: "rgba(245,250,255,0.95)",
            padding: "0 10px",
            fontSize: 12,
            fontWeight: 600,
            cursor: importDisabled ? "default" : "pointer",
            opacity: importDisabled ? 0.5 : 1,
          }}
        >
          Import selected
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 12 }}>
        {activeDirectory === "root" && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 12 }}>
            {visibleRootDirectories.map((directory) => {
              const selected = directory.id === selectedRootDirectory?.id;
              return (
                <div
                  key={directory.id}
                  onClick={() =>
                    setSelectedRootDirectoryId({
                      value: directory.id,
                      navigationVersion,
                    })
                  }
                  onDoubleClick={() => openDirectoryFromRoot(directory.id)}
                  style={{
                    border: selected ? "1px solid rgba(120,170,220,0.58)" : "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 11,
                    background: selected ? "rgba(95,150,230,0.14)" : "rgba(255,255,255,0.02)",
                    overflow: "hidden",
                    display: "grid",
                    gridTemplateRows: "60px auto 1fr auto",
                    minHeight: 166,
                    cursor: "pointer",
                  }}
                >
                  <div
                    style={{
                      background: "linear-gradient(160deg, rgba(86,120,171,0.55) 0%, rgba(37,53,77,0.92) 100%)",
                      color: "rgba(255,255,255,0.92)",
                      display: "grid",
                      alignContent: "center",
                      justifyItems: "center",
                      gap: 2,
                      borderBottom: "1px solid rgba(255,255,255,0.08)",
                    }}
                  >
                    <span style={{ fontSize: 22, lineHeight: 1 }}>{directory.icon}</span>
                  </div>
                  <div style={{ padding: "8px 9px 0 9px", fontSize: 13, fontWeight: 700, color: "rgba(255,255,255,0.93)" }}>
                    {directory.title}
                  </div>
                  <div style={{ padding: "5px 9px 8px 9px", fontSize: 11, color: "rgba(255,255,255,0.67)", lineHeight: 1.35 }}>
                    {directory.description}
                  </div>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      openDirectoryFromRoot(directory.id);
                    }}
                    style={{
                      border: "none",
                      borderTop: "1px solid rgba(255,255,255,0.08)",
                      background: "rgba(255,255,255,0.06)",
                      color: "rgba(240,248,255,0.95)",
                      height: 32,
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Open
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {activeDirectory !== "root" && activeDirectory !== "workspace" && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 12 }}>
            {visibleItems.map((item) => {
              const selected = item.id === selectedItem?.id;
              const dragPayload = dragPayloadFromBrowserItem(item);
              const previewStatus = libraryItemPreviews[item.id];
              const previewImageUrl = previewStatus?.status === "ready" ? previewStatus.dataUrl : item.preview.imageUrl;
              const hasImage = Boolean(previewImageUrl);
              const isCapturing = previewStatus?.status === "loading";
              return (
                <div
                  key={item.id}
                  onClick={() => {
                    setSelectedId({
                      value: item.id,
                      navigationVersion,
                    });
                    if (previewStatus?.status === "ready") {
                      touchLibraryItemPreview(item.id);
                    }
                  }}
                  onDoubleClick={() => {
                    void importAssetItem(item);
                  }}
                  draggable={Boolean(dragPayload)}
                  onDragStart={(event) => onCardDragStart(event, dragPayload)}
                  style={{
                    border: selected ? "1px solid rgba(120,170,220,0.58)" : "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 11,
                    background: selected ? "rgba(95,150,230,0.08)" : "rgba(255,255,255,0.01)",
                    overflow: "hidden",
                    display: "grid",
                    gridTemplateRows: "60px auto 1fr auto",
                    minHeight: 166,
                    position: "relative",
                    cursor: dragPayload ? "grab" : "pointer",
                  }}
                  title={`${activeSection?.title ?? ""}/${resolveItemPathName(item)}`}
                >
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      zIndex: 0,
                    }}
                  >
                    {hasImage ? (
                      <img
                        src={previewImageUrl}
                        alt={item.label}
                        style={{
                          position: "absolute",
                          inset: 0,
                          width: "100%",
                          height: "100%",
                          objectFit: "cover",
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          position: "absolute",
                          inset: 0,
                          background: `linear-gradient(160deg, ${item.preview.top} 0%, ${item.preview.bottom} 100%)`,
                        }}
                      />
                    )}
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        background: "linear-gradient(180deg, rgba(7,10,14,0.00) 0%, rgba(7,10,14,0.12) 45%, rgba(7,10,14,0.24) 100%)",
                      }}
                    />
                  </div>
                  <div
                    style={{
                      position: "relative",
                      borderBottom: "1px solid rgba(255,255,255,0.08)",
                      zIndex: 1,
                    }}
                  >
                  </div>
                  <div
                    style={{
                      padding: "8px 9px 0 9px",
                      position: "relative",
                      zIndex: 1,
                      background: "rgba(8,12,18,0.42)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                      <span style={{ fontSize: 14, lineHeight: 1 }}>{item.icon}</span>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "rgba(255,255,255,0.95)" }}>{item.label}</div>
                      {item.badge && (
                        <span
                          style={{
                            fontSize: 10,
                            letterSpacing: 0.4,
                            padding: "1px 6px",
                            borderRadius: 999,
                            border: "1px solid rgba(160,200,240,0.45)",
                            color: "rgba(210,230,250,0.95)",
                            background: "rgba(74,124,176,0.15)",
                          }}
                        >
                          {item.badge}
                        </span>
                      )}
                      {item.envBadge && (
                        <span
                          style={{
                            fontSize: 10,
                            letterSpacing: 0.4,
                            padding: "1px 6px",
                            borderRadius: 999,
                            border: "1px solid rgba(116,214,136,0.56)",
                            color: "rgba(205,245,213,0.98)",
                            background: "rgba(46,120,60,0.22)",
                          }}
                        >
                          Env
                        </span>
                      )}
                      {isCapturing && (
                        <span
                          style={{
                            fontSize: 10,
                            letterSpacing: 0.4,
                            padding: "1px 6px",
                            borderRadius: 999,
                            border: "1px solid rgba(160,200,240,0.45)",
                            color: "rgba(210,230,250,0.95)",
                            background: "rgba(74,124,176,0.15)",
                          }}
                        >
                          CAPTURING
                        </span>
                      )}
                    </div>
                  </div>
                  <div
                    style={{
                      padding: "5px 9px 8px 9px",
                      fontSize: 11,
                      color: "rgba(236,244,255,0.82)",
                      lineHeight: 1.35,
                      position: "relative",
                      zIndex: 1,
                      background: "rgba(8,12,18,0.34)",
                    }}
                  >
                    {item.description}
                  </div>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      void importAssetItem(item);
                    }}
                    style={{
                      border: "none",
                      borderTop: "1px solid rgba(255,255,255,0.08)",
                      background: "#243447",
                      color: "rgba(240,248,255,0.95)",
                      height: 32,
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: "pointer",
                      position: "relative",
                      zIndex: 1,
                    }}
                  >
                    {item.importLabel ?? "Import"}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {activeDirectory === "workspace" && (
          workspaceDirNode ? (
            workspaceEntries.length ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 12 }}>
                {workspaceEntries.map((entry) => {
                  const selected = entry.path === selectedWorkspaceEntry?.path;
                  const dragPayload = dragPayloadFromWorkspaceEntry(entry);
                  const hasImage = Boolean(entry.preview.imageUrl);
                  const isCapturing = entry.previewStatus?.status === "loading";
                  return (
                    <div
                      key={entry.path}
                      onClick={() => {
                        setSelectedWorkspacePath({
                          value: entry.path,
                          navigationVersion,
                        });
                        if (entry.previewStatus?.status === "ready") {
                          touchWorkspacePreview(normalizeWorkspaceFilePath(entry.path));
                        }
                      }}
                      onDoubleClick={() => {
                        void executeWorkspaceEntry(entry);
                      }}
                      draggable={Boolean(dragPayload)}
                      onDragStart={(event) => onCardDragStart(event, dragPayload)}
                      style={{
                        border: selected ? "1px solid rgba(120,170,220,0.58)" : "1px solid rgba(255,255,255,0.1)",
                        borderRadius: 11,
                        background: selected ? "rgba(95,150,230,0.08)" : "rgba(255,255,255,0.01)",
                        overflow: "hidden",
                        display: "grid",
                        gridTemplateRows: "60px auto 1fr auto",
                        minHeight: 166,
                        position: "relative",
                        cursor: dragPayload ? "grab" : "pointer",
                      }}
                      title={entry.path}
                    >
                      <div
                        style={{
                          position: "absolute",
                          inset: 0,
                          zIndex: 0,
                        }}
                      >
                        {hasImage ? (
                          <img
                            src={entry.preview.imageUrl}
                            alt={entry.name}
                            style={{
                              position: "absolute",
                              inset: 0,
                              width: "100%",
                              height: "100%",
                              objectFit: "cover",
                            }}
                          />
                        ) : (
                          <div
                            style={{
                              position: "absolute",
                              inset: 0,
                              background: `linear-gradient(160deg, ${entry.preview.top} 0%, ${entry.preview.bottom} 100%)`,
                            }}
                          />
                        )}
                        <div
                          style={{
                            position: "absolute",
                            inset: 0,
                            background: "linear-gradient(180deg, rgba(7,10,14,0.00) 0%, rgba(7,10,14,0.12) 45%, rgba(7,10,14,0.24) 100%)",
                          }}
                        />
                      </div>
                      <div
                        style={{
                          position: "relative",
                          borderBottom: "1px solid rgba(255,255,255,0.08)",
                          zIndex: 1,
                        }}
                      >
                      </div>
                      <div
                        style={{
                          padding: "8px 9px 0 9px",
                          position: "relative",
                          zIndex: 1,
                          background: "rgba(8,12,18,0.42)",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                          <span style={{ fontSize: 14, lineHeight: 1 }}>{entry.icon}</span>
                          <div style={{ fontSize: 13, fontWeight: 700, color: "rgba(255,255,255,0.95)" }}>{entry.name}</div>
                          {isCapturing && (
                            <span
                              style={{
                                fontSize: 10,
                                letterSpacing: 0.4,
                                padding: "1px 6px",
                                borderRadius: 999,
                                border: "1px solid rgba(160,200,240,0.45)",
                                color: "rgba(210,230,250,0.95)",
                                background: "rgba(74,124,176,0.15)",
                              }}
                            >
                              CAPTURING
                            </span>
                          )}
                        </div>
                      </div>
                      <div
                        style={{
                          padding: "5px 9px 8px 9px",
                          fontSize: 11,
                          color: "rgba(236,244,255,0.82)",
                          lineHeight: 1.35,
                          position: "relative",
                          zIndex: 1,
                          background: "rgba(8,12,18,0.34)",
                        }}
                      >
                        {entry.description}
                      </div>
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          void executeWorkspaceEntry(entry);
                        }}
                        style={{
                          border: "none",
                          borderTop: "1px solid rgba(255,255,255,0.08)",
                          background: "#243447",
                          color: "rgba(240,248,255,0.95)",
                          height: 32,
                          fontSize: 11,
                          fontWeight: 600,
                          cursor: "pointer",
                          position: "relative",
                          zIndex: 1,
                        }}
                      >
                        {entry.actionLabel}
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ fontSize: 12, opacity: 0.68 }}>No items in this workspace directory.</div>
            )
          ) : (
            <div style={{ fontSize: 12, opacity: 0.68 }}>Workspace path does not exist.</div>
          )
        )}
      </div>
    </div>
  );
}
