import type { ProjectDoc } from "../document/types";

export type EditorCommand = {
  id: string;
  label: string;
  apply: (doc: ProjectDoc) => ProjectDoc;
};

export type CommandRecord = {
  command: EditorCommand;
  before: ProjectDoc;
  after: ProjectDoc;
  timestamp: number;
};
