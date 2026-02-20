import { useEffect, useMemo, useState } from "react";
import { useAssetStore } from "../../app/core/store/useAssetStore";
import { useFileViewerStore } from "../../app/core/store/useFileViewerStore";
import { useMujocoStore } from "../../app/core/store/useMujocoStore";
import { MJCF_VIRTUAL_KEY, MJCF_VIRTUAL_LABEL } from "../../app/core/physics/mujoco/mjcfVirtual";

const textExtensions = new Set([".urdf", ".xacro", ".xml", ".mjcf", ".dae", ".obj", ".mtl", ".txt", ".json", ".yaml", ".yml"]);

const isTextFile = (path: string) => {
  const lower = path.toLowerCase();
  for (const ext of textExtensions) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
};

const editorStyle: React.CSSProperties = {
  flex: 1,
  width: "100%",
  resize: "none",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 10,
  background: "rgba(12,16,22,0.95)",
  color: "rgba(255,255,255,0.9)",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  fontSize: 12,
  lineHeight: 1.5,
  padding: 12,
  outline: "none",
  minHeight: 0,
};

export default function EditorPanel() {
  const activeFile = useFileViewerStore((s) => s.activeFile);
  const assets = useAssetStore((s) => s.assets);
  const isReady = useMujocoStore((s) => s.isReady);
  const isLoading = useMujocoStore((s) => s.isLoading);

  const [content, setContent] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "missing" | "binary">("idle");

  const headerLabel = useMemo(() => {
    if (!activeFile) return "No file selected";
    if (activeFile === MJCF_VIRTUAL_KEY) return `${activeFile} • ${MJCF_VIRTUAL_LABEL}`;
    return activeFile;
  }, [activeFile]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!activeFile) {
        setStatus("idle");
        setContent("");
        return;
      }

      if (activeFile === MJCF_VIRTUAL_KEY) {
        const xml = useMujocoStore.getState().getLastMJCF();
        if (!xml) {
          setStatus(isLoading ? "loading" : "missing");
          setContent("");
          return;
        }
        setStatus("ready");
        setContent(xml);
        return;
      }

      const entry = assets[activeFile];
      if (!entry) {
        setStatus("missing");
        setContent("");
        return;
      }

      if (!isTextFile(activeFile)) {
        setStatus("binary");
        setContent("");
        return;
      }

      setStatus("loading");
      try {
        const text = await entry.file.text();
        if (cancelled) return;
        setStatus("ready");
        setContent(text);
      } catch (err) {
        if (cancelled) return;
        setStatus("missing");
        setContent(String(err ?? "Failed to read file."));
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, [activeFile, assets, isReady, isLoading]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 10, padding: 12 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ fontSize: 12, opacity: 0.8, whiteSpace: "normal", overflowWrap: "anywhere", wordBreak: "break-word", lineHeight: 1.35 }}>
          {headerLabel}
        </div>
        {status === "ready" && (
          <button
            onClick={() => navigator.clipboard.writeText(content)}
            style={{
              height: 26,
              padding: "0 10px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.06)",
              color: "rgba(255,255,255,0.9)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Copy
          </button>
        )}
      </div>

      {status === "idle" && (
        <div style={{ opacity: 0.6, fontSize: 12 }}>Select a file in the Directories panel to preview it.</div>
      )}
      {status === "loading" && (
        <div style={{ opacity: 0.7, fontSize: 12 }}>Loading…</div>
      )}
      {status === "missing" && (
        <div style={{ opacity: 0.7, fontSize: 12 }}>File content not available.</div>
      )}
      {status === "binary" && (
        <div style={{ opacity: 0.7, fontSize: 12 }}>Binary file. Use a mesh viewer instead.</div>
      )}

      {status === "ready" && (
        <textarea readOnly value={content} spellCheck={false} style={editorStyle} />
      )}
    </div>
  );
}
