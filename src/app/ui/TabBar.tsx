import { useMemo, useRef, useState } from "react";
import type { DockId } from "../core/dock/types";
import { getPanelById } from "../core/dock/registry";
import { useDockStore } from "../core/store/useDockStore";

type Props = {
  dock: DockId;
};

type DropIndicator = { index: number; left: number; top: number; height: number };

function hasPanelIdType(dt: DataTransfer) {
  return Array.from(dt.types ?? []).includes("application/x-panel-id");
}

function findTabRoot(el: EventTarget | null) {
  let cur = el as HTMLElement | null;
  while (cur) {
    if (cur.dataset && cur.dataset.tabId) return cur;
    cur = cur.parentElement;
  }
  return null;
}

export default function TabBar({ dock }: Props) {
  const area = useDockStore((s) => s.areas[dock]);
  const setActive = useDockStore((s) => s.setActive);
  const closePanel = useDockStore((s) => s.closePanel);
  const movePanel = useDockStore((s) => s.movePanel);
  const isOpen = useDockStore((s) => s.isOpen);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);

  const tabs = area.tabs;
  const tabIndexById = useMemo(() => new Map(tabs.map((t, i) => [t, i] as const)), [tabs]);

  return (
    <div
      ref={rootRef}
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 0,
        minWidth: 0,
        flex: 1,
        overflow: "visible",
        position: "relative",
      }}
      onDragOver={(e) => {
        if (!hasPanelIdType(e.dataTransfer)) return;
        e.preventDefault();

        const root = rootRef.current;
        if (!root) return;
        const rootRect = root.getBoundingClientRect();

        const tabRoot = findTabRoot(e.target);
        if (tabRoot) {
          const tabId = tabRoot.dataset.tabId;
          const idx = tabId ? tabIndexById.get(tabId) : undefined;
          if (typeof idx === "number") {
            const tabRect = tabRoot.getBoundingClientRect();
            const before = e.clientX < tabRect.left + tabRect.width / 2;
            const index = before ? idx : idx + 1;
            const left = (before ? tabRect.left : tabRect.right) - rootRect.left;
            setDropIndicator({ index, left, top: tabRect.top - rootRect.top, height: tabRect.height });
            return;
          }
        }

        // Fallback: si estás en el hueco del final, insert al final
        if (tabs.length === 0) {
          setDropIndicator({ index: 0, left: 0, top: 0, height: rootRect.height });
          return;
        }
        const lastTabEl = root.querySelector<HTMLElement>('[data-tab-id]:last-of-type');
        if (!lastTabEl) return;
        const rect = lastTabEl.getBoundingClientRect();
        setDropIndicator({ index: tabs.length, left: rect.right - rootRect.left, top: rect.top - rootRect.top, height: rect.height });
      }}
      onDragLeave={(e) => {
        const root = rootRef.current;
        if (!root) return;
        const rect = root.getBoundingClientRect();
        const outside =
          e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom;
        if (outside) setDropIndicator(null);
      }}
      onDrop={(e) => {
        if (!hasPanelIdType(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();

        const id = e.dataTransfer.getData("application/x-panel-id");
        if (!id) return;

        const from = isOpen(id);
        let toIndex = dropIndicator?.index ?? tabs.length;
        if (from && from.dock === dock && toIndex > from.index) {
          toIndex -= 1;
        }

        movePanel(id, dock, toIndex);
        setDropIndicator(null);
      }}
    >
      {dropIndicator && (
        <div
          style={{
            position: "absolute",
            left: Math.max(0, dropIndicator.left - 1),
            top: dropIndicator.top,
            height: dropIndicator.height,
            width: 2,
            background: "rgba(80,160,255,0.95)",
            borderRadius: 2,
            boxShadow: "0 0 0 1px rgba(0,0,0,0.35)",
            pointerEvents: "none",
          }}
        />
      )}
      {area.tabs.map((id) => {
        const def = getPanelById(id);
        if (!def) return null;
        const active = area.active === id;

        // OJO: si en tu registry pones closable:false, aquí nunca saldrá la X.
        const canClose = def.closable !== false;

        return (
          <div
            key={id}
            data-tab-id={id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("application/x-panel-id", id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => setDropIndicator(null)}
            onMouseDown={() => setActive(dock, id)}
            style={{
              display: "flex",
              alignItems: "center",
              minHeight: 22,
              padding: "2px 8px 2px 10px",
              minWidth: 0,
              maxWidth: 280,
              borderBottom: active
                ? "2px solid rgba(80,160,255,0.95)"
                : "2px solid transparent",
              color: active ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.60)",
              cursor: "pointer",
              userSelect: "none",
              gap: 8,
              position: "relative",

              // VSCode-ish hover
              background: "transparent",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(255,255,255,0.03)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
          >
            {/* Title */}
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                minWidth: 0,
                flex: "1 1 auto",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                lineHeight: 1.15,
              }}
            >
              {def.title}
            </span>

            {/* Close button */}
            {canClose && (
              <button
                type="button"
                aria-label={`Close ${def.title}`}
                title="Close tab"
                onPointerDown={(e) => {
                  // IMPORTANT: evita que active el tab / empiece drag desde la X
                  e.stopPropagation();
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  closePanel(dock, id);
                }}
                style={{
                  flex: "0 0 auto",
                  height: 20,
                  width: 20,
                  display: "grid",
                  placeItems: "center",
                  alignSelf: "center",
                  borderRadius: 4,
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  background: "transparent",
                  lineHeight: 1,
                  fontSize: 16,

                  // VSCode behavior: visible if active OR hover tab
                  opacity: active ? 1 : 0,
                  color: active ? "rgba(255,255,255,0.80)" : "rgba(255,255,255,0.60)",
                  transition: "opacity 120ms ease, background 120ms ease, color 120ms ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(255,255,255,0.08)";
                  e.currentTarget.style.color = "rgba(255,255,255,0.90)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.color = active
                    ? "rgba(255,255,255,0.80)"
                    : "rgba(255,255,255,0.60)";
                }}
              >
                ×
              </button>
            )}

            {/* Trick: hacer que el botón aparezca al hover del tab */}
            {/* (sin CSS externo) */}
            {canClose && !active && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  pointerEvents: "none",
                }}
                onMouseEnter={() => {
                  /* noop */
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
