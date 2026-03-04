import { create } from "zustand";

export type TrainingTerrainMode = "none" | "usd" | "plane" | "generator";

type TrainingImportContextState = {
  robotUsdKey: string | null;
  terrainUsdKey: string | null;
  terrainMode: TrainingTerrainMode;
  setRobotUsdKey: (usdKey: string | null) => void;
  setTerrainUsdKey: (usdKey: string | null) => void;
  setTerrainMode: (mode: TrainingTerrainMode | null | undefined) => void;
  setImportContext: (input: {
    robotUsdKey?: string | null;
    terrainUsdKey?: string | null;
    terrainMode?: TrainingTerrainMode | null;
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

export const useTrainingImportContextStore = create<TrainingImportContextState>((set) => ({
  robotUsdKey: null,
  terrainUsdKey: null,
  terrainMode: "none",
  setRobotUsdKey: (usdKey) => set({ robotUsdKey: normalizeKey(usdKey) }),
  setTerrainUsdKey: (usdKey) => set({ terrainUsdKey: normalizeKey(usdKey) }),
  setTerrainMode: (mode) => set({ terrainMode: normalizeTerrainMode(mode) }),
  setImportContext: (input) =>
    set({
      robotUsdKey: normalizeKey(input.robotUsdKey),
      terrainUsdKey: normalizeKey(input.terrainUsdKey),
      terrainMode: normalizeTerrainMode(input.terrainMode),
    }),
  clear: () =>
    set({
      robotUsdKey: null,
      terrainUsdKey: null,
      terrainMode: "none",
    }),
}));
