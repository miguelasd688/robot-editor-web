import { create } from "zustand";
import type { UrdfImportOptions } from "../urdf/urdfImportOptions";

type UrdfImportDialogSource = "directories" | "browser" | "viewport-drop";

type UrdfImportDialogRequest = {
  urdfKey: string;
  source: UrdfImportDialogSource;
  optionOverrides?: Partial<UrdfImportOptions>;
};

type UrdfImportDialogState = {
  isOpen: boolean;
  urdfKey: string | null;
  source: UrdfImportDialogSource | null;
  optionOverrides: Partial<UrdfImportOptions> | null;
  requestImport: (request: UrdfImportDialogRequest) => void;
  close: () => void;
};

export const useUrdfImportDialogStore = create<UrdfImportDialogState>((set) => ({
  isOpen: false,
  urdfKey: null,
  source: null,
  optionOverrides: null,
  requestImport: (request) =>
    set({
      isOpen: true,
      urdfKey: request.urdfKey,
      source: request.source,
      optionOverrides: request.optionOverrides ?? null,
    }),
  close: () =>
    set({
      isOpen: false,
      urdfKey: null,
      source: null,
      optionOverrides: null,
    }),
}));
