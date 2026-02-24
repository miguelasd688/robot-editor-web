import { useConsoleStore, type LogLevel } from "../../app/core/store/useConsoleStore";

const levelOrder: Array<{ level: LogLevel; label: string }> = [
  { level: "error", label: "E" },
  { level: "warn", label: "W" },
  { level: "info", label: "I" },
  { level: "debug", label: "D" },
];

export default function ConsoleHeaderActions() {
  const levels = useConsoleStore((s) => s.levels);
  const toggleLevel = useConsoleStore((s) => s.toggleLevel);
  const clear = useConsoleStore((s) => s.clear);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {levelOrder.map(({ level, label }) => {
          const active = levels[level];
          return (
            <button
              key={level}
              onClick={() => toggleLevel(level)}
              title={`Toggle ${level}`}
              style={{
                height: 22,
                width: 22,
                borderRadius: 6,
                border: "1px solid rgba(255,255,255,0.12)",
                background: active ? "rgba(80,160,255,0.25)" : "rgba(255,255,255,0.04)",
                color: active ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.55)",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 700,
                display: "grid",
                placeItems: "center",
                padding: 0,
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      <button
        onClick={clear}
        style={{
          height: 22,
          padding: "0 8px",
          borderRadius: 6,
          border: "1px solid rgba(255,255,255,0.10)",
          background: "rgba(255,255,255,0.06)",
          color: "rgba(255,255,255,0.85)",
          cursor: "pointer",
          fontSize: 11,
        }}
      >
        Clear
      </button>

      <div style={{ fontSize: 11, opacity: 0.68, marginLeft: 4, whiteSpace: "nowrap" }}>
        Find: Ctrl/Cmd + F
      </div>
    </div>
  );
}
