import { useEffect, useMemo, useRef, useState } from "react";
import type { DockId, PanelId } from "../core/dock/types";
import { getPanelById, getPanelRegistry } from "../core/dock/registry";
import { useDockStore } from "../core/store/useDockStore";
import TabBar from "./TabBar";

type Props = {
  dock: DockId;
  variant?: "side" | "main" | "bottom";
};

export default function DockArea({ dock, variant = "side" }: Props) {
  const area = useDockStore((s) => s.areas[dock]);
  const initFromPanels = useDockStore((s) => s.initFromPanels);
  const openPanel = useDockStore((s) => s.openPanel);
  const movePanel = useDockStore((s) => s.movePanel);

  const [menuOpen, setMenuOpen] = useState(false);

  // ✅ Ref para detectar clicks fuera
  const menuRootRef = useRef<HTMLDivElement | null>(null);

  const available = useMemo(() => getPanelRegistry(), []);
  const activePanel = area.active ? getPanelById(area.active) ?? null : null;
  const HeaderActions = activePanel?.headerActions ?? null;

  useEffect(() => {
    initFromPanels(available);
  }, [available, initFromPanels]);

  // ✅ Cerrar al click fuera + Escape
  useEffect(() => {
    if (!menuOpen) return;

    const onPointerDown = (e: PointerEvent) => {
      const root = menuRootRef.current;
      if (!root) return;

      // Si el click es dentro del menú/botón -> no cerrar
      if (root.contains(e.target as Node)) return;

      setMenuOpen(false);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };

    // capture=true para pillar el evento antes de stops
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const headerRight = (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {HeaderActions && activePanel && <HeaderActions dock={dock} panelId={activePanel.id} />}
      <div ref={menuRootRef} style={{ position: "relative" }}>
        <button
          // ✅ mejor en mouse/pointer down para evitar parpadeos
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          style={{
            height: 28,
            width: 28,
            borderRadius: 6,
            border: "none",
            background: "transparent",
            color: "rgba(255,255,255,0.75)",
            cursor: "pointer",
            display: "grid",
            placeItems: "center",
            padding: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(255,255,255,0.08)";
            e.currentTarget.style.color = "rgba(255,255,255,0.9)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "rgba(255,255,255,0.75)";
          }}
          title="Open panel"
        >
          <span style={{ fontSize: 18, lineHeight: 1, transform: "translateY(-1px)" }}>⋯</span>
        </button>

        {menuOpen && (
          <div
            style={{
              position: "absolute",
              right: 0,
              top: 32,
              width: 220,
              background: "#0d131a",
              border: "1px solid rgba(255,255,255,0.10)",
              borderRadius: 10,
              boxShadow: "0 10px 30px rgba(0,0,0,0.4)",
              padding: 6,
              zIndex: 50,
            }}
            // opcional: por si algún click burbujea raro
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div style={{ padding: "6px 8px", fontSize: 12, opacity: 0.7 }}>Open tab in this area</div>

            {available.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  openPanel(dock, p.id as PanelId);
                  setMenuOpen(false);
                }}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "none",
                  background: "transparent",
                  color: "rgba(255,255,255,0.9)",
                  cursor: "pointer",
                  fontSize: 13,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(255,255,255,0.06)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                {p.title}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div
      style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("application/x-panel-id")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData("application/x-panel-id") as PanelId;
        if (!id) return;
        e.preventDefault();
        movePanel(id, dock);
      }}
    >
      {/* Header */}
      <div
        style={{
          minHeight: 28,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "2px 10px",
          background: "#0d131a",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          userSelect: "none",
        }}
      >
        <TabBar dock={dock} />
        {headerRight}
      </div>

      {/* Content */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
          background: variant === "main" ? "#0b0f14" : "#0d131a",
        }}
      >
        {area.tabs.length ? (
          area.tabs.map((panelId) => {
            const contribution = getPanelById(panelId);
            if (!contribution) return null;
            const Comp = contribution.component;
            const isActive = panelId === area.active;
            if (!isActive && !contribution.keepAlive) return null;
            return (
              <div key={panelId} style={{ display: isActive ? "block" : "none", height: "100%" }}>
                <Comp />
              </div>
            );
          })
        ) : (
          <div style={{ padding: 12, opacity: 0.6, fontSize: 13 }}>
            Drop a tab here or open one via ⋯
          </div>
        )}
      </div>
    </div>
  );
}
