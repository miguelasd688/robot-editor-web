import React from "react";

export function Row(props: {
  indent: number;
  active?: boolean;
  onClick?: () => void;
  title?: string;
  bold?: boolean;
  children: React.ReactNode;
}) {
  const { indent, active, onClick, title, bold, children } = props;

  return (
    <div
      onClick={onClick}
      title={title}
      style={{
        display: "flex",
        alignItems: "flex-start",
        flexWrap: "wrap",
        gap: 8,
        rowGap: 2,
        padding: "4px 8px",
        marginLeft: indent * 12,
        borderRadius: 8,
        cursor: onClick ? "pointer" : "default",
        background: active ? "rgba(80,160,255,0.18)" : "transparent",
        border: active ? "1px solid rgba(80,160,255,0.35)" : "1px solid transparent",
        color: "rgba(255,255,255,0.90)",
        userSelect: "none",
        minWidth: 0,
      }}
    >
      <div
        style={{
          minWidth: 0,
          whiteSpace: "normal",
          overflowWrap: "break-word",
          wordBreak: "break-word",
          lineHeight: 1.35,
          fontWeight: bold ? 600 : 500,
        }}
      >
        {children}
      </div>
    </div>
  );
}
