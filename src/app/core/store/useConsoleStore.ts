import { create } from "zustand";

export type LogLevel = "info" | "warn" | "error" | "debug";

export type LogEntry = {
  id: string;
  time: number;
  level: LogLevel;
  message: string;
  scope?: string;
  data?: unknown;
};

type ConsoleState = {
  entries: LogEntry[];
  maxEntries: number;
  levels: Record<LogLevel, boolean>;
  search: string;
  push: (entry: LogEntry) => void;
  clear: () => void;
  toggleLevel: (level: LogLevel) => void;
  setSearch: (value: string) => void;
};

export const useConsoleStore = create<ConsoleState>((set, get) => ({
  entries: [],
  maxEntries: 400,
  levels: { info: true, warn: true, error: true, debug: false },
  search: "",
  push: (entry) =>
    set((state) => {
      const next = [...state.entries, entry];
      const overflow = next.length - get().maxEntries;
      if (overflow > 0) next.splice(0, overflow);
      return { entries: next };
    }),
  clear: () => set({ entries: [] }),
  toggleLevel: (level) =>
    set((state) => ({ levels: { ...state.levels, [level]: !state.levels[level] } })),
  setSearch: (value) => set({ search: value }),
}));
