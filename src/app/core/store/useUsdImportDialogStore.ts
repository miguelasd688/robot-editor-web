import { create } from "zustand";
import type { UsdImportOptions } from "../usd/usdImportOptions";

type UsdImportDialogSource = "directories" | "browser" | "viewport-drop";

type UsdImportDialogRequest = {
  usdKey: string;
  source: UsdImportDialogSource;
  optionOverrides?: Partial<UsdImportOptions>;
  bundleHintPaths?: string[];
};

type UsdImportDialogState = {
  isOpen: boolean;
  usdKey: string | null;
  source: UsdImportDialogSource | null;
  optionOverrides: Partial<UsdImportOptions> | null;
  bundleHintPaths: string[] | null;
  requestImport: (request: UsdImportDialogRequest) => void;
  close: () => void;
};

export const useUsdImportDialogStore = create<UsdImportDialogState>((set) => ({
  isOpen: false,
  usdKey: null,
  source: null,
  optionOverrides: null,
  bundleHintPaths: null,
  requestImport: (request) =>
    set({
      isOpen: true,
      usdKey: request.usdKey,
      source: request.source,
      optionOverrides: request.optionOverrides ?? null,
      bundleHintPaths: Array.isArray(request.bundleHintPaths) ? request.bundleHintPaths : null,
    }),
  close: () =>
    set({
      isOpen: false,
      usdKey: null,
      source: null,
      optionOverrides: null,
      bundleHintPaths: null,
    }),
}));
