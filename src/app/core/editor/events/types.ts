import type { ProjectDoc } from "../document/types";

export type EditorEvent =
  | {
      type: "doc:changed";
      doc: ProjectDoc;
      reason: string;
    }
  | {
      type: "history:changed";
      canUndo: boolean;
      canRedo: boolean;
    };
