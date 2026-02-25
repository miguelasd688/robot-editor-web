import { create } from "zustand";
import type { UsdImportOptions } from "../usd/usdImportOptions";

type UsdImportDialogSource = "directories" | "browser" | "viewport-drop";

type UsdImportDialogRequest = {
  usdKey: string;
  source: UsdImportDialogSource;
  optionOverrides?: Partial<UsdImportOptions>;
};

type UsdImportDialogState = {
  isOpen: boolean;
  usdKey: string | null;
  source: UsdImportDialogSource | null;
  optionOverrides: Partial<UsdImportOptions> | null;
  requestImport: (request: UsdImportDialogRequest) => void;
  close: () => void;
};

export const useUsdImportDialogStore = create<UsdImportDialogState>((set) => ({
  isOpen: false,
  usdKey: null,
  source: null,
  optionOverrides: null,
  requestImport: (request) =>
    set({
      isOpen: true,
      usdKey: request.usdKey,
      source: request.source,
      optionOverrides: request.optionOverrides ?? null,
    }),
  close: () =>
    set({
      isOpen: false,
      usdKey: null,
      source: null,
      optionOverrides: null,
    }),
}));
