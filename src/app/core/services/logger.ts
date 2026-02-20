import { useConsoleStore, type LogEntry, type LogLevel } from "../store/useConsoleStore";

export type LogOptions = {
  scope?: string;
  data?: unknown;
};

type LogSink = (entry: LogEntry) => void;

let counter = 0;
const sinks: LogSink[] = [];

const consoleEnabled = String(import.meta.env.VITE_LOG_CONSOLE ?? "true").toLowerCase() === "true";

function formatConsoleMessage(entry: LogEntry) {
  const scope = entry.scope ? `[${entry.scope}] ` : "";
  return `[${entry.level}] ${scope}${entry.message}`;
}

function consoleSink(entry: LogEntry) {
  if (!consoleEnabled) return;
  const message = formatConsoleMessage(entry);
  const method =
    entry.level === "error" ? "error" : entry.level === "warn" ? "warn" : entry.level === "debug" ? "debug" : "info";
  if (entry.data !== undefined) {
    console[method](message, entry.data);
  } else {
    console[method](message);
  }
}

function storeSink(entry: LogEntry) {
  useConsoleStore.getState().push(entry);
}

addLogSink(consoleSink);
addLogSink(storeSink);

export function addLogSink(sink: LogSink) {
  sinks.push(sink);
  return () => {
    const index = sinks.indexOf(sink);
    if (index >= 0) sinks.splice(index, 1);
  };
}

export function log(level: LogLevel, message: string, options?: LogOptions) {
  const entry: LogEntry = {
    id: `${Date.now()}_${counter++}`,
    time: Date.now(),
    level,
    message,
    scope: options?.scope,
    data: options?.data,
  };
  for (const sink of sinks) {
    sink(entry);
  }
}

export function logInfo(message: string, options?: LogOptions) {
  log("info", message, options);
}

export function logWarn(message: string, options?: LogOptions) {
  log("warn", message, options);
}

export function logError(message: string, options?: LogOptions) {
  log("error", message, options);
}

export function logDebug(message: string, options?: LogOptions) {
  log("debug", message, options);
}
