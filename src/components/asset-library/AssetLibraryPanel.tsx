import { useMemo, useRef, useState, type DragEvent } from "react";
import { addSceneAsset } from "../../app/core/editor/actions/sceneAssetActions";
import { BROWSER_DIRECTORIES, type BrowserDirectoryId } from "../../app/core/browser/directories";
import { logInfo } from "../../app/core/services/logger";
import type { SceneAssetId } from "../../app/core/scene/sceneAssets";
import { useAssetStore } from "../../app/core/store/useAssetStore";
import { useBrowserStore } from "../../app/core/store/useBrowserStore";
import { useDockStore } from "../../app/core/store/useDockStore";
import { useFileViewerStore } from "../../app/core/store/useFileViewerStore";
import { useUrdfImportDialogStore } from "../../app/core/store/useUrdfImportDialogStore";
import {
  BROWSER_IMPORT_MIME,
  type BrowserImportPayload,
  encodeBrowserImportPayload,
} from "./browserDragDrop";
import { CARTPOLE_SAMPLE_URDF, CARTPOLE_SAMPLE_NAME, findCartpoleSampleKey } from "./cartpoleSample";
import { buildTree, type TreeNode } from "../explorer/model/tree";

type LibrarySectionId = Exclude<BrowserDirectoryId, "workspace">;

type BrowserItem = {
  id: string;
  label: string;
  pathName?: string;
  description: string;
  icon: string;
  badge?: string;
  assetId?: SceneAssetId;
  action?: "sample-cartpole";
  importLabel?: string;
  preview: {
    top: string;
    bottom: string;
    caption: string;
  };
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
  preview: {
    top: string;
    bottom: string;
    caption: string;
  };
};

type BreadcrumbItem = {
  label: string;
  onClick?: () => void;
};

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
      {
        id: "robot-cartpole",
        label: "Cartpole Sample",
        pathName: "CartpoleSample",
        description: "Imports the Cartpole sample URDF into workspace and loads it.",
        icon: "🧪",
        badge: "URDF",
        action: "sample-cartpole",
        importLabel: "Load sample",
        preview: {
          top: "rgba(101, 148, 117, 0.55)",
          bottom: "rgba(38, 74, 57, 0.9)",
          caption: "CARTPOLE",
        },
      },
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
        },
      },
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
    ],
  },
];

const ALL_ITEMS = LIBRARY_SECTIONS.flatMap((section) => section.items);

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

  const lower = name.toLowerCase();
  if (lower.endsWith(".urdf")) {
    return {
      top: "rgba(94, 150, 111, 0.58)",
      bottom: "rgba(37, 74, 53, 0.92)",
      caption: "URDF",
    };
  }
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
  const lower = name.toLowerCase();
  if (lower.endsWith(".urdf")) return "🤖";
  if (lower.endsWith(".stl") || lower.endsWith(".dae") || lower.endsWith(".obj")) return "🧊";
  return "📄";
}

export default function AssetLibraryPanel() {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(ALL_ITEMS[0]?.id ?? "");
  const [selectedRootDirectoryId, setSelectedRootDirectoryId] = useState<BrowserDirectoryId>("floors");
  const [workspacePath, setWorkspacePath] = useState("");
  const [selectedWorkspacePath, setSelectedWorkspacePath] = useState<string | null>(null);

  const activeDirectory = useBrowserStore((s) => s.activeDirectory);
  const setActiveDirectory = useBrowserStore((s) => s.setActiveDirectory);
  const assets = useAssetStore((s) => s.assets);
  const importFiles = useAssetStore((s) => s.importFiles);
  const setURDF = useAssetStore((s) => s.setURDF);
  const requestUrdfImport = useUrdfImportDialogStore((s) => s.requestImport);
  const setActiveFile = useFileViewerStore((s) => s.setActiveFile);
  const openPanel = useDockStore((s) => s.openPanel);
  const isOpen = useDockStore((s) => s.isOpen);

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
    return (
      visibleItems.find((item) => item.id === selectedId) ??
      activeSection.items.find((item) => item.id === selectedId) ??
      visibleItems[0] ??
      activeSection.items[0] ??
      null
    );
  }, [activeSection, selectedId, visibleItems]);

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
        const preview = workspaceEntryPreview(node.name, isDir);
        return {
          kind: isDir ? "dir" : "file",
          name: node.name,
          path: node.path,
          description: isDir ? "Directory" : node.path,
          icon: workspaceEntryIcon(node.name, isDir),
          actionLabel: isDir ? "Open" : node.name.toLowerCase().endsWith(".urdf") ? "Import" : "Open",
          preview,
        } satisfies WorkspaceEntry;
      });
  }, [workspaceDirNode, normalizedQuery]);

  const selectedWorkspaceEntry = useMemo(() => {
    if (!workspaceEntries.length) return null;
    return workspaceEntries.find((entry) => entry.path === selectedWorkspacePath) ?? workspaceEntries[0];
  }, [selectedWorkspacePath, workspaceEntries]);

  const visibleRootDirectories = useMemo(() => {
    if (!normalizedQuery) return BROWSER_DIRECTORIES;
    return BROWSER_DIRECTORIES.filter((directory) => {
      const searchText = `${directory.title} ${directory.description}`.toLowerCase();
      return searchText.includes(normalizedQuery);
    });
  }, [normalizedQuery]);

  const selectedRootDirectory = useMemo(() => {
    return (
      visibleRootDirectories.find((directory) => directory.id === selectedRootDirectoryId) ??
      visibleRootDirectories[0] ??
      null
    );
  }, [selectedRootDirectoryId, visibleRootDirectories]);

  const importSceneAsset = (assetId: SceneAssetId, label: string) => {
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
  };

  const openFileInEditor = (path: string) => {
    setActiveFile(path);
    const existing = isOpen("editor");
    const dock = existing?.dock ?? "main";
    openPanel(dock, "editor");
  };

  const importWorkspaceFile = (path: string) => {
    const lower = path.toLowerCase();
    if (lower.endsWith(".urdf")) {
      setURDF(path);
      requestUrdfImport({
        urdfKey: path,
        source: "browser",
      });
      logInfo("Browser import request: Workspace URDF", { scope: "assets", data: { urdfKey: path } });
      return;
    }
    openFileInEditor(path);
  };

  const importCartpoleSample = () => {
    const hasSample = Boolean(findCartpoleSampleKey(Object.keys(assets)));
    if (!hasSample) {
      const sampleFile = new File([CARTPOLE_SAMPLE_URDF], CARTPOLE_SAMPLE_NAME, { type: "application/xml" });
      importFiles([sampleFile]);
    }
    const store = useAssetStore.getState();
    const sampleKey = findCartpoleSampleKey(Object.keys(store.assets));
    if (!sampleKey) return;
    setURDF(sampleKey);
    requestUrdfImport({
      urdfKey: sampleKey,
      source: "browser",
      optionOverrides: { floatingBase: false },
    });
    logInfo("Browser import request: Cartpole sample URDF", { scope: "assets", data: { urdfKey: sampleKey } });
  };

  const importAssetItem = (item: BrowserItem | null) => {
    if (!item) return;
    if (item.assetId) {
      importSceneAsset(item.assetId, item.label);
      return;
    }
    if (item.action === "sample-cartpole") {
      importCartpoleSample();
    }
  };

  const openDirectoryFromRoot = (directoryId: BrowserDirectoryId) => {
    setSelectedRootDirectoryId(directoryId);
    setActiveDirectory(directoryId);
    if (directoryId === "workspace") {
      setWorkspacePath("");
      setSelectedWorkspacePath(null);
    }
  };

  const openWorkspaceDirectory = (path: string) => {
    setWorkspacePath(normalizeWorkspaceDir(path));
    setSelectedWorkspacePath(null);
  };

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
    importAssetItem(selectedItem);
  };

  const dragPayloadFromBrowserItem = (item: BrowserItem): BrowserImportPayload | null => {
    if (item.assetId) {
      return { kind: "asset", assetId: item.assetId, label: item.label };
    }
    if (item.action === "sample-cartpole") {
      return { kind: "sample", sample: "cartpole", label: item.label };
    }
    return null;
  };

  const dragPayloadFromWorkspaceEntry = (entry: WorkspaceEntry): BrowserImportPayload | null => {
    if (entry.kind !== "file") return null;
    if (!entry.path.toLowerCase().endsWith(".urdf")) return null;
    return { kind: "workspace-urdf", path: entry.path, label: entry.name };
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
        label: "Root",
        onClick: activeDirectory === "root" ? undefined : () => setActiveDirectory("root"),
      },
    ];

    if (activeDirectory === "workspace") {
      crumbs.push({
        label: "Workspace",
        onClick: workspacePath ? () => setWorkspacePath("") : undefined,
      });
      const parts = workspacePath.split("/").filter(Boolean);
      let acc = "";
      for (const part of parts) {
        acc = acc ? `${acc}${part}/` : `${part}/`;
        const target = acc;
        crumbs.push({
          label: part,
          onClick: target === workspacePath ? undefined : () => setWorkspacePath(target),
        });
      }
      return crumbs;
    }

    if (activeSection) {
      crumbs.push({
        label: activeSection.title,
        onClick: () => setActiveDirectory(activeSection.id),
      });
      if (selectedItem) {
        crumbs.push({ label: resolveItemPathName(selectedItem) });
      }
    }
    return crumbs;
  }, [activeDirectory, activeSection, selectedItem, setActiveDirectory, workspacePath]);

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
                  onClick={() => setSelectedRootDirectoryId(directory.id)}
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
                      gap: 5,
                      borderBottom: "1px solid rgba(255,255,255,0.08)",
                    }}
                  >
                    <span style={{ fontSize: 22, lineHeight: 1 }}>{directory.icon}</span>
                    <span style={{ fontSize: 10, letterSpacing: 0.8, opacity: 0.85 }}>DIRECTORY</span>
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
              return (
                <div
                  key={item.id}
                  onClick={() => setSelectedId(item.id)}
                  onDoubleClick={() => {
                    void importAssetItem(item);
                  }}
                  draggable={Boolean(dragPayload)}
                  onDragStart={(event) => onCardDragStart(event, dragPayload)}
                  style={{
                    border: selected ? "1px solid rgba(120,170,220,0.58)" : "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 11,
                    background: selected ? "rgba(95,150,230,0.14)" : "rgba(255,255,255,0.02)",
                    overflow: "hidden",
                    display: "grid",
                    gridTemplateRows: "60px auto 1fr auto",
                    minHeight: 166,
                    cursor: dragPayload ? "grab" : "pointer",
                  }}
                  title={`${activeSection?.title ?? ""}/${resolveItemPathName(item)}`}
                >
                  <div
                    style={{
                      background: `linear-gradient(160deg, ${item.preview.top} 0%, ${item.preview.bottom} 100%)`,
                      color: "rgba(255,255,255,0.92)",
                      display: "grid",
                      alignContent: "center",
                      justifyItems: "center",
                      gap: 5,
                      borderBottom: "1px solid rgba(255,255,255,0.08)",
                    }}
                  >
                    <span style={{ fontSize: 22, lineHeight: 1 }}>{item.icon}</span>
                    <span style={{ fontSize: 10, letterSpacing: 0.8, opacity: 0.85 }}>{item.preview.caption}</span>
                  </div>
                  <div style={{ padding: "8px 9px 0 9px", display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "rgba(255,255,255,0.93)" }}>{item.label}</div>
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
                  </div>
                  <div style={{ padding: "5px 9px 8px 9px", fontSize: 11, color: "rgba(255,255,255,0.67)", lineHeight: 1.35 }}>
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
                      background: "rgba(255,255,255,0.06)",
                      color: "rgba(240,248,255,0.95)",
                      height: 32,
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: "pointer",
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
                  return (
                    <div
                      key={entry.path}
                      onClick={() => setSelectedWorkspacePath(entry.path)}
                      onDoubleClick={() => {
                        void executeWorkspaceEntry(entry);
                      }}
                      draggable={Boolean(dragPayload)}
                      onDragStart={(event) => onCardDragStart(event, dragPayload)}
                      style={{
                        border: selected ? "1px solid rgba(120,170,220,0.58)" : "1px solid rgba(255,255,255,0.1)",
                        borderRadius: 11,
                        background: selected ? "rgba(95,150,230,0.14)" : "rgba(255,255,255,0.02)",
                        overflow: "hidden",
                        display: "grid",
                        gridTemplateRows: "60px auto 1fr auto",
                        minHeight: 166,
                        cursor: dragPayload ? "grab" : "pointer",
                      }}
                      title={entry.path}
                    >
                      <div
                        style={{
                          background: `linear-gradient(160deg, ${entry.preview.top} 0%, ${entry.preview.bottom} 100%)`,
                          color: "rgba(255,255,255,0.92)",
                          display: "grid",
                          alignContent: "center",
                          justifyItems: "center",
                          gap: 5,
                          borderBottom: "1px solid rgba(255,255,255,0.08)",
                        }}
                      >
                        <span style={{ fontSize: 22, lineHeight: 1 }}>{entry.icon}</span>
                        <span style={{ fontSize: 10, letterSpacing: 0.8, opacity: 0.85 }}>{entry.preview.caption}</span>
                      </div>
                      <div style={{ padding: "8px 9px 0 9px", fontSize: 13, fontWeight: 700, color: "rgba(255,255,255,0.93)" }}>
                        {entry.name}
                      </div>
                      <div style={{ padding: "5px 9px 8px 9px", fontSize: 11, color: "rgba(255,255,255,0.67)", lineHeight: 1.35 }}>
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
                          background: "rgba(255,255,255,0.06)",
                          color: "rgba(240,248,255,0.95)",
                          height: 32,
                          fontSize: 11,
                          fontWeight: 600,
                          cursor: "pointer",
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
