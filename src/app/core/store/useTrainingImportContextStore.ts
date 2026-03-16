import { create } from "zustand";
import type { EnvironmentDiagnostic, EnvironmentDoc } from "../editor/document/types";

export type TrainingTerrainMode = "none" | "usd" | "plane" | "generator";

type TrainingImportContextState = {
  robotUsdKey: string | null;
  terrainUsdKey: string | null;
  terrainMode: TrainingTerrainMode;
  environmentSnapshot: EnvironmentDoc | null;
  diagnostics: EnvironmentDiagnostic[];
  setRobotUsdKey: (usdKey: string | null) => void;
  setTerrainUsdKey: (usdKey: string | null) => void;
  setTerrainMode: (mode: TrainingTerrainMode | null | undefined) => void;
  setEnvironmentSnapshot: (snapshot: EnvironmentDoc | null) => void;
  setDiagnostics: (diagnostics: EnvironmentDiagnostic[] | null | undefined) => void;
  setImportContext: (input: {
    robotUsdKey?: string | null;
    terrainUsdKey?: string | null;
    terrainMode?: TrainingTerrainMode | null;
    environmentSnapshot?: EnvironmentDoc | null;
    diagnostics?: EnvironmentDiagnostic[] | null;
  }) => void;
  clear: () => void;
};

function normalizeKey(value: string | null | undefined): string | null {
  const token = String(value ?? "").trim();
  return token.length > 0 ? token : null;
}

function normalizeTerrainMode(value: TrainingTerrainMode | string | null | undefined): TrainingTerrainMode {
  const token = String(value ?? "")
    .trim()
    .toLowerCase();
  if (token === "usd" || token === "plane" || token === "generator") return token;
  return "none";
}

function normalizeDiagnostics(input: EnvironmentDiagnostic[] | null | undefined): EnvironmentDiagnostic[] {
  if (!Array.isArray(input)) return [];
  const diagnostics: EnvironmentDiagnostic[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const code = String(item.code ?? "").trim();
    const message = String(item.message ?? "").trim();
    const severity = item.severity === "error" ? "error" : "warning";
    const source =
      item.source === "import" || item.source === "document" || item.source === "simulation" || item.source === "training"
        ? item.source
        : "document";
    if (!code || !message) continue;
    const diagnostic: EnvironmentDiagnostic = {
      code,
      message,
      severity,
      source,
    };
    if (item.context && typeof item.context === "object" && !Array.isArray(item.context)) {
      diagnostic.context = item.context as Record<string, unknown>;
    }
    diagnostics.push(diagnostic);
  }
  return diagnostics;
}

function cloneEnvironmentSnapshot(snapshot: EnvironmentDoc | null | undefined): EnvironmentDoc | null {
  if (!snapshot) return null;
  return JSON.parse(JSON.stringify(snapshot)) as EnvironmentDoc;
}

export const useTrainingImportContextStore = create<TrainingImportContextState>((set) => ({
  robotUsdKey: null,
  terrainUsdKey: null,
  terrainMode: "none",
  environmentSnapshot: null,
  diagnostics: [],
  setRobotUsdKey: (usdKey) => set({ robotUsdKey: normalizeKey(usdKey) }),
  setTerrainUsdKey: (usdKey) => set({ terrainUsdKey: normalizeKey(usdKey) }),
  setTerrainMode: (mode) => set({ terrainMode: normalizeTerrainMode(mode) }),
  setEnvironmentSnapshot: (snapshot) => set({ environmentSnapshot: cloneEnvironmentSnapshot(snapshot) }),
  setDiagnostics: (diagnostics) => set({ diagnostics: normalizeDiagnostics(diagnostics) }),
  setImportContext: (input) =>
    set({
      robotUsdKey: normalizeKey(input.robotUsdKey),
      terrainUsdKey: normalizeKey(input.terrainUsdKey),
      terrainMode: normalizeTerrainMode(input.terrainMode),
      environmentSnapshot: cloneEnvironmentSnapshot(input.environmentSnapshot),
      diagnostics: normalizeDiagnostics(input.diagnostics),
    }),
  clear: () =>
    set({
      robotUsdKey: null,
      terrainUsdKey: null,
      terrainMode: "none",
      environmentSnapshot: null,
      diagnostics: [],
    }),
}));
