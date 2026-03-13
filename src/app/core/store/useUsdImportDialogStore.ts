import { create } from "zustand";
import type { UsdImportOptions } from "../usd/usdImportOptions";
import { useDockStore } from "./useDockStore";

type UsdImportDialogSource = "directories" | "browser" | "viewport-drop";

type UsdImportDialogRequest = {
  usdKey: string;
  source: UsdImportDialogSource;
  optionOverrides?: Partial<UsdImportOptions>;
  bundleHintPaths?: string[];
  variantUsdKeys?: string[];
  terrainUsdKeys?: string[];
  selectedTerrainUsdKey?: string | null;
};

type UsdImportDialogState = {
  isOpen: boolean;
  usdKey: string | null;
  source: UsdImportDialogSource | null;
  optionOverrides: Partial<UsdImportOptions> | null;
  bundleHintPaths: string[] | null;
  variantUsdKeys: string[] | null;
  terrainUsdKeys: string[] | null;
  selectedTerrainUsdKey: string | null;
  requestImport: (request: UsdImportDialogRequest) => void;
  setSelectedTerrainUsdKey: (usdKey: string | null) => void;
  close: () => void;
};

export const useUsdImportDialogStore = create<UsdImportDialogState>((set) => ({
  isOpen: false,
  usdKey: null,
  source: null,
  optionOverrides: null,
  bundleHintPaths: null,
  variantUsdKeys: null,
  terrainUsdKeys: null,
  selectedTerrainUsdKey: null,
  requestImport: (request) => {
    useDockStore.getState().revealPanel("viewport", "main");
    set({
      isOpen: true,
      usdKey: request.usdKey,
      source: request.source,
      optionOverrides: request.optionOverrides ?? null,
      bundleHintPaths: Array.isArray(request.bundleHintPaths) ? request.bundleHintPaths : null,
      variantUsdKeys: Array.isArray(request.variantUsdKeys)
        ? request.variantUsdKeys.map((item) => String(item ?? "").trim()).filter((item) => item.length > 0)
        : null,
      terrainUsdKeys: Array.isArray(request.terrainUsdKeys)
        ? request.terrainUsdKeys.map((item) => String(item ?? "").trim()).filter((item) => item.length > 0)
        : null,
      selectedTerrainUsdKey: request.selectedTerrainUsdKey ? String(request.selectedTerrainUsdKey).trim() : null,
    });
  },
  setSelectedTerrainUsdKey: (usdKey) =>
    set({
      selectedTerrainUsdKey: usdKey ? String(usdKey).trim() : null,
    }),
  close: () =>
    set({
      isOpen: false,
      usdKey: null,
      source: null,
      optionOverrides: null,
      bundleHintPaths: null,
      variantUsdKeys: null,
      terrainUsdKeys: null,
      selectedTerrainUsdKey: null,
    }),
}));
