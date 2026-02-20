import { useEffect, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useAppStore } from "../core/store/useAppStore";
import { useSceneStore } from "../core/store/useSceneStore";
import DockArea from "../ui/DockArea";
import { copySelection, deleteSelection, duplicateSelection, pasteSelection, redo, undo } from "../core/editor/actions/editorActions";
import { editorEngine } from "../core/editor/engineSingleton";
import { exportRobotToUrdf } from "../core/urdf/urdfExport";
import type { SceneNode } from "../core/editor/document/types";

function ResizeHandle() {
  return (
    <Separator
      style={{
        width: 6,
        background: "rgba(255,255,255,0.06)",
        cursor: "col-resize",
      }}
    />
  );
}

function ResizeHandleRow() {
  return (
    <Separator
      style={{
        height: 6,
        background: "rgba(255,255,255,0.06)",
        cursor: "row-resize",
      }}
    />
  );
}

//function MiniRestoreButton(props: { label: string; onClick: () => void }) {
//  return (
//    <button
//      onClick={props.onClick}
//      style={{
//        height: 28,
//        padding: "0 10px",
//        borderRadius: 8,
//        border: "1px solid rgba(255,255,255,0.10)",
//        background: "rgba(255,255,255,0.08)",
//        color: "rgba(255,255,255,0.85)",
//        cursor: "pointer",
//        fontSize: 12,
//      }}
//    >
//      Show {props.label}
//    </button>
//  );
//}

export default function EditorLayout() {
  const vis = useAppStore((s) => s.panelVisible);
  const toggle = useAppStore((s) => s.togglePanel);
  const selectedId = useSceneStore((s) => s.selectedId);
  const nodes = useSceneStore((s) => s.nodes);
  const [menuOpen, setMenuOpen] = useState<"file" | "edit" | null>(null);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const robotsForExport = listRobotsForExport(nodes, selectedId);

  const exportRobotUrdf = (robotId: string) => {
    try {
      const { robotName, urdf, warnings } = exportRobotToUrdf(editorEngine.getDoc(), robotId);
      downloadText(`${robotName}.urdf`, urdf, "application/xml");
      if (warnings.length > 0) {
        console.warn("[urdf:export] Export completed with warnings:", warnings);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to export URDF.";
      alert(message);
    }
  };

  const openExportDialog = () => {
    setMenuOpen(null);
    setShowExportDialog(true);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "c") {
        e.preventDefault();
        copySelection();
        return;
      }
      if (mod && key === "v") {
        e.preventDefault();
        pasteSelection();
        return;
      }
      if (mod && key === "d") {
        e.preventDefault();
        duplicateSelection();
        return;
      }
      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && key === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (key === "delete" || key === "backspace") {
        e.preventDefault();
        deleteSelection();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (menuRef.current && target && menuRef.current.contains(target)) return;
      setMenuOpen(null);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, []);

  useEffect(() => {
    if (!showExportDialog) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowExportDialog(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showExportDialog]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          height: 44,
          display: "flex",
          alignItems: "center",
          padding: "0 12px",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          background: "#0d131a",
        }}
      >
        <div style={{ fontWeight: 700, letterSpacing: 0.2 }}>agent-inspector-web</div>

        <div ref={menuRef} style={{ marginLeft: 16, display: "flex", gap: 6 }}>
          <div style={{ position: "relative" }}>
            <button onClick={() => setMenuOpen(menuOpen === "file" ? null : "file")} style={menuBtn()}>
              File
            </button>
            {menuOpen === "file" && (
              <div style={menuList()}>
                <button style={menuItem()} onClick={openExportDialog}>
                  Export robot as URDF...
                </button>
              </div>
            )}
          </div>
          <div style={{ position: "relative" }}>
            <button onClick={() => setMenuOpen(menuOpen === "edit" ? null : "edit")} style={menuBtn()}>
              Edit
            </button>
            {menuOpen === "edit" && (
              <div style={menuList()}>
                <button style={menuItem()} onClick={() => { undo(); setMenuOpen(null); }}>
                  Undo
                </button>
                <button style={menuItem()} onClick={() => { redo(); setMenuOpen(null); }}>
                  Redo
                </button>
                <div style={menuSeparator()} />
                <button style={menuItem()} onClick={() => { copySelection(); setMenuOpen(null); }}>
                  Copy
                </button>
                <button style={menuItem()} onClick={() => { pasteSelection(); setMenuOpen(null); }}>
                  Paste
                </button>
                <button style={menuItem()} onClick={() => { duplicateSelection(); setMenuOpen(null); }}>
                  Duplicate
                </button>
                <button style={menuItem()} onClick={() => { deleteSelection(); setMenuOpen(null); }}>
                  Delete
                </button>
              </div>
            )}
          </div>
        </div>

        <div style={{ marginLeft: 12, display: "flex", gap: 8 }}>
          <button onClick={() => toggle("left")} style={topBtn()}>
            {vis.left ? "Hide Left" : "Show Left"}
          </button>
          <button onClick={() => toggle("right")} style={topBtn()}>
            {vis.right ? "Hide Right" : "Show Right"}
          </button>
          <button onClick={() => toggle("bottom")} style={topBtn()}>
            {vis.bottom ? "Hide Bottom" : "Show Bottom"}
          </button>
        </div>

        <div style={{ marginLeft: "auto" }} />
      </div>

      <div style={{ flex: 1, minHeight: 0, width: "100%" }}>
        <Group orientation="vertical" style={{ height: "100%", width: "100%" }}>
          <Panel defaultSize={vis.bottom ? 75 : 100} minSize={40}>
            <Group orientation="horizontal" style={{ height: "100%", width: "100%" }}>
              <Panel defaultSize={9} minSize={5}>
                <DockArea dock="left" variant="side" />
              </Panel>

              <ResizeHandle />

              <Panel defaultSize={72} minSize={38}>
                <DockArea dock="main" variant="main" />
              </Panel>

              <ResizeHandle />

              <Panel defaultSize={18} minSize={6}>
                <DockArea dock="right" variant="side" />
              </Panel>
            </Group>
          </Panel>

          {vis.bottom && <ResizeHandleRow />}

          <Panel defaultSize={35} minSize={10}>
            <DockArea dock="bottom" variant="bottom" />
          </Panel>
        </Group>
      </div>

      {showExportDialog && (
        <div style={exportOverlayStyle()} onMouseDown={() => setShowExportDialog(false)}>
          <div style={exportDialogStyle()} onMouseDown={(e) => e.stopPropagation()}>
            <div style={exportHeaderStyle()}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>Export Robots as URDF</div>
                <div style={{ fontSize: 12, opacity: 0.72 }}>Choose one robot from the current scene.</div>
              </div>
              <button style={dialogCloseBtn()} onClick={() => setShowExportDialog(false)}>
                Close
              </button>
            </div>

            <div style={exportBodyStyle()}>
              {robotsForExport.length === 0 ? (
                <div style={{ fontSize: 12, opacity: 0.78 }}>No robot nodes found in the scene.</div>
              ) : (
                robotsForExport.map((robot) => (
                  <div key={robot.id} style={robotRowStyle(robot.isSelected)}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{robot.name}</div>
                      <div style={{ fontSize: 11, opacity: 0.6, whiteSpace: "normal", overflowWrap: "anywhere", wordBreak: "break-word" }}>
                        {robot.id}
                      </div>
                    </div>
                    <button style={exportActionBtn()} onClick={() => exportRobotUrdf(robot.id)}>
                      Export URDF
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function findSelectedRobotId(nodes: Record<string, SceneNode>, selectedId: string | null) {
  let cur = selectedId;
  while (cur) {
    const node = nodes[cur];
    if (!node) return null;
    if (node.kind === "robot") return node.id;
    cur = node.parentId ?? null;
  }
  return null;
}

function listRobotsForExport(nodes: Record<string, SceneNode>, selectedId: string | null) {
  const selectedRobotId = findSelectedRobotId(nodes, selectedId);
  const out: Array<{ id: string; name: string; isSelected: boolean }> = [];

  for (const id of Object.keys(nodes)) {
    const node = nodes[id];
    if (!node || node.kind !== "robot") continue;
    out.push({
      id: node.id,
      name: (node.name || "Robot").trim() || "Robot",
      isSelected: node.id === selectedRobotId,
    });
  }

  out.sort((a, b) => {
    if (a.isSelected !== b.isSelected) return a.isSelected ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

function downloadText(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function topBtn(): React.CSSProperties {
  return {
    height: 28,
    padding: "0 10px",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(255,255,255,0.08)",
    color: "rgba(255,255,255,0.85)",
    cursor: "pointer",
    fontSize: 12,
  };
}

function menuBtn(): React.CSSProperties {
  return {
    height: 28,
    padding: "0 10px",
    borderRadius: 6,
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(255,255,255,0.04)",
    color: "rgba(255,255,255,0.9)",
    cursor: "pointer",
    fontSize: 12,
  };
}

function menuList(): React.CSSProperties {
  return {
    position: "absolute",
    top: 34,
    left: 0,
    minWidth: 170,
    padding: 6,
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(10,14,20,0.98)",
    display: "grid",
    gap: 4,
    zIndex: 50,
    boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
  };
}

function menuItem(): React.CSSProperties {
  return {
    height: 28,
    padding: "0 10px",
    borderRadius: 6,
    border: "1px solid transparent",
    background: "transparent",
    color: "rgba(255,255,255,0.92)",
    textAlign: "left",
    cursor: "pointer",
    fontSize: 12,
  };
}

function menuSeparator(): React.CSSProperties {
  return {
    height: 1,
    background: "rgba(255,255,255,0.08)",
    margin: "4px 2px",
  };
}

function exportOverlayStyle(): React.CSSProperties {
  return {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.52)",
    display: "grid",
    placeItems: "center",
    zIndex: 120,
    padding: 16,
  };
}

function exportDialogStyle(): React.CSSProperties {
  return {
    width: "min(560px, 100%)",
    maxHeight: "min(78vh, 720px)",
    display: "grid",
    gridTemplateRows: "auto 1fr",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(12,16,22,0.98)",
    boxShadow: "0 24px 60px rgba(0,0,0,0.5)",
    overflow: "hidden",
  };
}

function exportHeaderStyle(): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    padding: "14px 16px",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
  };
}

function exportBodyStyle(): React.CSSProperties {
  return {
    padding: 12,
    overflow: "auto",
    display: "grid",
    gap: 8,
  };
}

function robotRowStyle(selected: boolean): React.CSSProperties {
  return {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    alignItems: "start",
    gap: 10,
    padding: 10,
    borderRadius: 10,
    border: selected ? "1px solid rgba(80,160,255,0.45)" : "1px solid rgba(255,255,255,0.10)",
    background: selected ? "rgba(80,160,255,0.12)" : "rgba(255,255,255,0.04)",
  };
}

function exportActionBtn(): React.CSSProperties {
  return {
    height: 28,
    padding: "0 10px",
    borderRadius: 8,
    border: "1px solid rgba(120,190,120,0.50)",
    background: "rgba(70,150,90,0.25)",
    color: "rgba(255,255,255,0.96)",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
  };
}

function dialogCloseBtn(): React.CSSProperties {
  return {
    height: 28,
    padding: "0 10px",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.05)",
    color: "rgba(255,255,255,0.9)",
    cursor: "pointer",
    fontSize: 12,
  };
}
