import { create } from "zustand";
import type { UsdImportOptions } from "../usd/usdImportOptions";
import { useDockStore } from "./useDockStore";

type UsdImportDialogSource = "directories" | "browser" | "viewport-drop";

type UsdImportDialogRequest = {
  usdKey: string;
  source: UsdImportDialogSource;
  librarySampleId?: string | null;
  optionOverrides?: Partial<UsdImportOptions>;
  bundleHintPaths?: string[];
  selectedEnvironmentId?: string | null;
};

type UsdImportDialogState = {
  isOpen: boolean;
  usdKey: string | null;
  source: UsdImportDialogSource | null;
  librarySampleId: string | null;
  optionOverrides: Partial<UsdImportOptions> | null;
  bundleHintPaths: string[] | null;
  selectedEnvironmentId: string | null;
  requestImport: (request: UsdImportDialogRequest) => void;
  setSelectedEnvironmentId: (environmentId: string | null) => void;
  close: () => void;
};

export const useUsdImportDialogStore = create<UsdImportDialogState>((set) => ({
  isOpen: false,
  usdKey: null,
  source: null,
  librarySampleId: null,
  optionOverrides: null,
  bundleHintPaths: null,
  selectedEnvironmentId: null,
  requestImport: (request) => {
    useDockStore.getState().revealPanel("viewport", "main");
    set({
      isOpen: true,
      usdKey: request.usdKey,
      source: request.source,
      librarySampleId: request.librarySampleId ? String(request.librarySampleId).trim() : null,
      optionOverrides: request.optionOverrides ?? null,
      bundleHintPaths: Array.isArray(request.bundleHintPaths) ? request.bundleHintPaths : null,
      selectedEnvironmentId: request.selectedEnvironmentId ? String(request.selectedEnvironmentId).trim() : null,
    });
  },
  setSelectedEnvironmentId: (environmentId) =>
    set({
      selectedEnvironmentId: environmentId ? String(environmentId).trim() : null,
    }),
  close: () =>
    set({
      isOpen: false,
      usdKey: null,
      source: null,
      librarySampleId: null,
      optionOverrides: null,
      bundleHintPaths: null,
      selectedEnvironmentId: null,
    }),
}));
