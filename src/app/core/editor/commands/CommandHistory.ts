import type { CommandRecord } from "./types";

export class CommandHistory {
  private past: CommandRecord[] = [];
  private future: CommandRecord[] = [];

  push(record: CommandRecord) {
    this.past.push(record);
    this.future = [];
  }

  undo(): CommandRecord | null {
    const record = this.past.pop();
    if (!record) return null;
    this.future.unshift(record);
    return record;
  }

  redo(): CommandRecord | null {
    const record = this.future.shift();
    if (!record) return null;
    this.past.push(record);
    return record;
  }

  canUndo() {
    return this.past.length > 0;
  }

  canRedo() {
    return this.future.length > 0;
  }

  clear() {
    this.past = [];
    this.future = [];
  }
}
