import React from "react";

export type PanelTab = {
  id: string;
  title: string;
  icon?: React.ReactNode;
};

export type PanelShellProps = {
  title?: string;                 // opcional, si quieres un título fijo
  tabs: PanelTab[];
  activeTabId: string;
  onTabChange: (id: string) => void;

  rightActions?: React.ReactNode; // botones en la cabecera (ej: +, ..., etc)
  children: React.ReactNode;

  // estilo/layout
  variant?: "side" | "main" | "bottom";
};

export default function PanelShell(props: PanelShellProps) {
  const { title, tabs, activeTabId, onTabChange, rightActions, children, variant = "side" } =
    props;

  const headerHeight = 34;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div
        style={{
          minHeight: headerHeight,
          display: "flex",
          alignItems: "flex-start",
          gap: 8,
          padding: "4px 10px",
          background: "#0d131a",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          userSelect: "none",
        }}
      >
        {title ? (
          <div style={{ fontWeight: 700, fontSize: 13, opacity: 0.9 }}>{title}</div>
        ) : null}

        {/* Tabs */}
        <div style={{ display: "flex", alignItems: "flex-start", flexWrap: "wrap", gap: 0, minWidth: 0, flex: 1 }}>
          {tabs.map((t) => {
            const active = t.id === activeTabId;
            return (
              <button
                key={t.id}
                onClick={() => onTabChange(t.id)}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 6,
                  minHeight: 26,
                  padding: "4px 10px",
                  border: "none",
                  background: "transparent",
                  color: active ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.60)",
                  borderBottom: active
                    ? "2px solid rgba(80, 160, 255, 0.95)"
                    : "2px solid transparent",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 600,
                  whiteSpace: "normal",
                  overflowWrap: "break-word",
                  wordBreak: "break-word",
                  lineHeight: 1.2,
                }}
                title={t.title}
              >
                {t.icon}
                {t.title}
              </button>
            );
          })}
        </div>

        {/* Right side actions */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>{rightActions}</div>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          background: variant === "main" ? "#0b0f14" : "#0d131a",
        }}
      >
        {children}
      </div>
    </div>
  );
}
