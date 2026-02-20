import React from "react";

export function ExplorerToolbar(props: {
  onImportClick: () => void;
  onLoadURDF: () => void;
  fileInput: React.ReactNode;
}) {
  const { onImportClick, onLoadURDF, fileInput } = props;

  return (
    <div
      style={{
        padding: 10,
        borderBottom: "1px solid rgba(255,255,255,0.08)",
        display: "flex",
        gap: 8,
        alignItems: "center",
        flexWrap: "wrap", // docks estrechos
      }}
    >
      <button
        onClick={onImportClick}
        style={{
          minHeight: 26,
          padding: "0 10px",
          borderRadius: 8,
          border: "1px solid rgba(255,255,255,0.10)",
          background: "rgba(255,255,255,0.10)",
          color: "rgba(255,255,255,0.92)",
          cursor: "pointer",
          whiteSpace: "normal",
          lineHeight: 1.2,
          flex: "0 0 auto",
        }}
      >
        Import workspace
      </button>

      <button
        onClick={onLoadURDF}
        style={{
          minHeight: 26,
          padding: "0 10px",
          borderRadius: 8,
          border: "1px solid rgba(80,160,255,0.35)",
          background: "rgba(80,160,255,0.18)",
          color: "rgba(255,255,255,0.92)",
          cursor: "pointer",
          whiteSpace: "normal",
          lineHeight: 1.2,
          flex: "0 0 auto",
        }}
        title="Load selected URDF from workspace"
      >
        Load URDF
      </button>

      {fileInput}
    </div>
  );
}
