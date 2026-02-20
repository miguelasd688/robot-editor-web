import { useEffect, useMemo, useRef } from "react";
import { useConsoleStore } from "../../app/core/store/useConsoleStore";

const levelColor: Record<string, string> = {
  info: "rgba(180,210,255,0.9)",
  warn: "rgba(255,200,120,0.95)",
  error: "rgba(255,120,120,0.95)",
  debug: "rgba(160,160,160,0.9)",
};

export default function ConsolePanel() {
  const entries = useConsoleStore((s) => s.entries);
  const levels = useConsoleStore((s) => s.levels);
  const search = useConsoleStore((s) => s.search);
  const tailRef = useRef<HTMLDivElement | null>(null);

  const lines = useMemo(() => {
    const query = search.trim().toLowerCase();
    return entries
      .filter((entry) => levels[entry.level])
      .filter((entry) => {
        if (!query) return true;
        const scope = entry.scope ? entry.scope.toLowerCase() : "";
        return entry.message.toLowerCase().includes(query) || scope.includes(query);
      })
      .map((entry) => {
      const time = new Date(entry.time).toLocaleTimeString();
      return { ...entry, time };
    });
  }, [entries, levels, search]);

  useEffect(() => {
    tailRef.current?.scrollIntoView({ block: "end" });
  }, [entries.length]);

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      }}
    >
      <div style={{ padding: 10, overflow: "auto", flex: 1, minHeight: 0, fontSize: 12 }}>
        {entries.length === 0 && <div style={{ opacity: 0.5 }}>[info] no logs yet</div>}
        {entries.length > 0 && lines.length === 0 && (
          <div style={{ opacity: 0.5 }}>[info] no logs match current filters</div>
        )}
        {lines.map((entry) => (
          <div key={entry.id} style={{ display: "grid", gap: 4, marginBottom: 6 }}>
            <div style={{ color: levelColor[entry.level] ?? "rgba(255,255,255,0.9)" }}>
              [{entry.time}] [{entry.level}]
              {entry.scope ? ` [${entry.scope}]` : ""} {entry.message}
            </div>
            {entry.data !== undefined && (
              <div style={{ opacity: 0.6, whiteSpace: "pre-wrap" }}>{JSON.stringify(entry.data)}</div>
            )}
          </div>
        ))}
        <div ref={tailRef} />
      </div>
    </div>
  );
}
