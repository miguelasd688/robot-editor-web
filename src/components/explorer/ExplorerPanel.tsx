import { BROWSER_DIRECTORIES, type BrowserDirectoryId } from "../../app/core/browser/directories";
import { useAssetStore } from "../../app/core/store/useAssetStore";
import { useBrowserStore } from "../../app/core/store/useBrowserStore";
import { useDockStore } from "../../app/core/store/useDockStore";
import { useUrdfImportDialogStore } from "../../app/core/store/useUrdfImportDialogStore";
import { ExplorerToolbar } from "./ui/Toolbar";
import { useWorkspaceImport } from "./services/workspaceImport";

export default function ExplorerPanel() {
  const assets = useAssetStore((s) => s.assets);
  const urdfKey = useAssetStore((s) => s.urdfKey);
  const importFiles = useAssetStore((s) => s.importFiles);
  const openPanel = useDockStore((s) => s.openPanel);
  const isOpen = useDockStore((s) => s.isOpen);
  const activeDirectory = useBrowserStore((s) => s.activeDirectory);
  const setActiveDirectory = useBrowserStore((s) => s.setActiveDirectory);
  const requestUrdfImport = useUrdfImportDialogStore((s) => s.requestImport);

  const { fileInputRef, onImportClick, onImportChange } = useWorkspaceImport(importFiles);

  const onLoadURDF = () => {
    if (!urdfKey) {
      alert("No URDF selected. Import a folder/files with a .urdf and select it.");
      return;
    }

    const entry = assets[urdfKey];
    if (!entry) {
      alert("Selected URDF not found in workspace.");
      return;
    }
    requestUrdfImport({
      urdfKey,
      source: "directories",
    });
  };

  const onDirectoryClick = (directoryId: BrowserDirectoryId) => {
    setActiveDirectory(directoryId);
    const existing = isOpen("browser");
    const dock = existing?.dock ?? "bottom";
    openPanel(dock, "browser");
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0, position: "relative" }}>
      <ExplorerToolbar
        onImportClick={onImportClick}
        onLoadURDF={onLoadURDF}
        fileInput={
          <input
            ref={fileInputRef}
            type="file"
            multiple
            // @ts-expect-error webkitdirectory is a non-standard browser attribute.
            webkitdirectory="true"
            style={{ display: "none" }}
            onChange={onImportChange}
          />
        }
      />

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          background: "rgba(10,14,20,0.68)",
          padding: 8,
        }}
      >
        <div style={{ display: "grid", gap: 6 }}>
          {BROWSER_DIRECTORIES.map((directory) => {
            const active = directory.id === activeDirectory;
            return (
              <button
                key={directory.id}
                onClick={() => onDirectoryClick(directory.id)}
                style={{
                  borderRadius: 9,
                  border: active ? "1px solid rgba(110,164,224,0.55)" : "1px solid rgba(255,255,255,0.1)",
                  background: active ? "rgba(75,129,196,0.18)" : "rgba(255,255,255,0.03)",
                  color: "rgba(255,255,255,0.92)",
                  cursor: "pointer",
                  padding: "8px 9px",
                  textAlign: "left",
                }}
                title={directory.description}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 15 }}>{directory.icon}</span>
                  <span style={{ fontSize: 12, fontWeight: 700 }}>{directory.title}</span>
                </div>
                <div style={{ marginTop: 4, fontSize: 11, opacity: 0.63, lineHeight: 1.3 }}>{directory.description}</div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
