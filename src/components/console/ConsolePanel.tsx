import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConsoleStore, type LogEntry } from "../../app/core/store/useConsoleStore";

const levelColor: Record<string, string> = {
  info: "rgba(180,210,255,0.9)",
  warn: "rgba(255,200,120,0.95)",
  error: "rgba(255,120,120,0.95)",
  debug: "rgba(160,160,160,0.9)",
};

function stringifyForSearch(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function matchesEntry(entry: LogEntry, query: string, caseSensitive: boolean): boolean {
  if (!query) return false;
  const scope = entry.scope ?? "";
  const data = stringifyForSearch(entry.data);
  const haystack = `${entry.message}\n${scope}\n${data}`;
  if (caseSensitive) return haystack.includes(query);
  return haystack.toLowerCase().includes(query.toLowerCase());
}

export default function ConsolePanel() {
  const entries = useConsoleStore((s) => s.entries);
  const levels = useConsoleStore((s) => s.levels);
  const search = useConsoleStore((s) => s.search);
  const setSearch = useConsoleStore((s) => s.setSearch);
  const searchCaseSensitive = useConsoleStore((s) => s.searchCaseSensitive);
  const toggleSearchCaseSensitive = useConsoleStore((s) => s.toggleSearchCaseSensitive);
  const [isFindOpen, setIsFindOpen] = useState(false);
  const [isConsoleContext, setIsConsoleContext] = useState(false);
  const [activeMatchCursor, setActiveMatchCursor] = useState(-1);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const lineRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const tailRef = useRef<HTMLDivElement | null>(null);
  const query = search.trim();

  const visibleEntries = useMemo(
    () => entries.filter((entry) => levels[entry.level]),
    [entries, levels]
  );

  const matchedEntryIndexes = useMemo(() => {
    if (!query) return [];
    return visibleEntries.reduce<number[]>((acc, entry, index) => {
      if (matchesEntry(entry, query, searchCaseSensitive)) acc.push(index);
      return acc;
    }, []);
  }, [query, searchCaseSensitive, visibleEntries]);

  const matchedIndexSet = useMemo(
    () => new Set<number>(matchedEntryIndexes),
    [matchedEntryIndexes]
  );

  const lines = useMemo(
    () =>
      visibleEntries.map((entry) => {
        const time = new Date(entry.time).toLocaleTimeString();
        return { ...entry, time };
      }),
    [visibleEntries]
  );

  const goToMatch = useCallback(
    (direction: 1 | -1) => {
      if (matchedEntryIndexes.length === 0) return;
      setActiveMatchCursor((previous) => {
        if (previous < 0 || previous >= matchedEntryIndexes.length) {
          return direction === 1 ? 0 : matchedEntryIndexes.length - 1;
        }
        return (previous + direction + matchedEntryIndexes.length) % matchedEntryIndexes.length;
      });
    },
    [matchedEntryIndexes]
  );

  const effectiveActiveMatchCursor =
    matchedEntryIndexes.length === 0
      ? -1
      : activeMatchCursor < 0 || activeMatchCursor >= matchedEntryIndexes.length
      ? 0
      : activeMatchCursor;

  const activeEntryIndex =
    effectiveActiveMatchCursor >= 0 && effectiveActiveMatchCursor < matchedEntryIndexes.length
      ? matchedEntryIndexes[effectiveActiveMatchCursor]
      : -1;

  useEffect(() => {
    if (query) return;
    tailRef.current?.scrollIntoView({ block: "end" });
  }, [entries.length, query]);

  useEffect(() => {
    if (activeEntryIndex < 0) return;
    const activeEntry = lines[activeEntryIndex];
    if (!activeEntry) return;
    const node = lineRefs.current.get(activeEntry.id);
    node?.scrollIntoView({ block: "nearest" });
  }, [activeEntryIndex, lines]);

  useEffect(() => {
    if (!isFindOpen) return;
    const timeout = window.setTimeout(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [isFindOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root) return;

      const key = event.key.toLowerCase();
      const mod = event.ctrlKey || event.metaKey;
      const eventTarget = event.target as Node | null;
      const targetInside = Boolean(eventTarget && root.contains(eventTarget));
      const activeInside = root.contains(document.activeElement);
      const shouldHandle = targetInside || activeInside || isConsoleContext || isFindOpen;

      if (mod && key === "f" && shouldHandle) {
        event.preventDefault();
        setIsFindOpen(true);
        return;
      }

      if (!shouldHandle) return;

      if (isFindOpen && key === "escape") {
        event.preventDefault();
        setIsFindOpen(false);
        root.focus();
        return;
      }

      if (mod && key === "g") {
        event.preventDefault();
        goToMatch(event.shiftKey ? -1 : 1);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goToMatch, isConsoleContext, isFindOpen]);

  const matchCounter = query
    ? `${matchedEntryIndexes.length === 0 ? 0 : effectiveActiveMatchCursor + 1}/${matchedEntryIndexes.length}`
    : "0/0";

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onFocusCapture={() => setIsConsoleContext(true)}
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget as Node | null;
        if (nextTarget && rootRef.current?.contains(nextTarget)) return;
        setIsConsoleContext(false);
      }}
      onPointerEnter={() => setIsConsoleContext(true)}
      onPointerLeave={() => {
        const root = rootRef.current;
        if (!root) return;
        if (!root.contains(document.activeElement)) setIsConsoleContext(false);
      }}
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        userSelect: "text",
        position: "relative",
        outline: "none",
      }}
    >
      {isFindOpen && (
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 10,
            zIndex: 8,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 8px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.14)",
            background: "#0a0f15",
            boxShadow: "0 8px 20px rgba(0,0,0,0.35)",
          }}
        >
          <input
            ref={findInputRef}
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                goToMatch(event.shiftKey ? -1 : 1);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setIsFindOpen(false);
                rootRef.current?.focus();
              }
            }}
            placeholder="Find in Console"
            style={{
              height: 24,
              width: 220,
              borderRadius: 6,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(0,0,0,0.35)",
              color: "rgba(255,255,255,0.92)",
              padding: "0 8px",
              fontSize: 12,
              outline: "none",
            }}
          />

          <button
            onClick={() => goToMatch(-1)}
            title="Previous match (Shift+Enter)"
            style={findButtonStyle(false)}
          >
            ↑
          </button>
          <button
            onClick={() => goToMatch(1)}
            title="Next match (Enter)"
            style={findButtonStyle(false)}
          >
            ↓
          </button>

          <button
            onClick={toggleSearchCaseSensitive}
            title="Match case"
            style={findButtonStyle(searchCaseSensitive)}
          >
            Aa
          </button>

          <div style={{ fontSize: 11, opacity: 0.72, minWidth: 44, textAlign: "right" }}>{matchCounter}</div>

          <button
            onClick={() => setIsFindOpen(false)}
            title="Close"
            style={findButtonStyle(false)}
          >
            ×
          </button>
        </div>
      )}

      <div style={{ padding: 10, overflow: "auto", flex: 1, minHeight: 0, fontSize: 12, userSelect: "text" }}>
        {entries.length === 0 && <div style={{ opacity: 0.5 }}>[info] no logs yet</div>}
        {entries.length > 0 && lines.length === 0 && (
          <div style={{ opacity: 0.5 }}>[info] no logs match current filters</div>
        )}
        {lines.map((entry, index) => {
          const isMatched = matchedIndexSet.has(index);
          const isActiveMatch = activeEntryIndex === index;
          return (
            <div
              key={entry.id}
              ref={(node) => {
                if (node) lineRefs.current.set(entry.id, node);
                else lineRefs.current.delete(entry.id);
              }}
              style={{
                display: "grid",
                gap: 4,
                marginBottom: 6,
                padding: "4px 6px",
                borderRadius: 6,
                border: isActiveMatch
                  ? "1px solid rgba(80,160,255,0.85)"
                  : "1px solid transparent",
                background: isActiveMatch
                  ? "rgba(80,160,255,0.18)"
                  : isMatched
                  ? "rgba(255,255,255,0.06)"
                  : "transparent",
              }}
            >
              <div style={{ color: levelColor[entry.level] ?? "rgba(255,255,255,0.9)" }}>
                [{entry.time}] [{entry.level}]
                {entry.scope ? ` [${entry.scope}]` : ""} {entry.message}
              </div>
              {entry.data !== undefined && (
                <div style={{ opacity: 0.6, whiteSpace: "pre-wrap" }}>{JSON.stringify(entry.data)}</div>
              )}
            </div>
          );
        })}
        <div ref={tailRef} />
      </div>
    </div>
  );
}

function findButtonStyle(active: boolean) {
  return {
    height: 22,
    minWidth: 22,
    padding: "0 6px",
    borderRadius: 6,
    border: "1px solid rgba(255,255,255,0.12)",
    background: active ? "rgba(80,160,255,0.25)" : "rgba(255,255,255,0.04)",
    color: active ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.75)",
    cursor: "pointer",
    fontSize: 11,
    fontWeight: 700,
    display: "grid",
    placeItems: "center",
  } as const;
}
