import { createEmptyProject } from "./document/factory";
import { replaceScene, syncVisualCollisions } from "./document/ops";
import type { ProjectDoc, SceneDoc, Transform, VisualComponent } from "./document/types";
import { EventBus } from "./events/bus";
import type { EditorEvent } from "./events/types";
import { CommandHistory } from "./commands/CommandHistory";
import type { EditorCommand } from "./commands/types";
import { setNodeNameCommand, setNodePhysicsCommand, setNodeTransformCommand, setNodeUrdfCommand, setNodeVisualCommand, setSelectionCommand } from "./commands/sceneCommands";
import type { InstancePhysics, PhysicsFields } from "../assets/types";
import type { UrdfInstance } from "../urdf/urdfModel";

export type EditorEngine = {
  getDoc: () => ProjectDoc;
  setDoc: (doc: ProjectDoc, reason: string) => void;
  execute: (command: EditorCommand, options?: { recordHistory?: boolean; reason?: string }) => void;
  undo: () => void;
  redo: () => void;
  replaceScene: (scene: SceneDoc, reason?: string) => void;
  setSelection: (id: string | null) => void;
  setNodeName: (id: string, name: string, options?: { recordHistory?: boolean; reason?: string }) => void;
  setNodeTransform: (id: string, transform: Transform, options?: { recordHistory?: boolean; reason?: string }) => void;
  setNodePhysics: (id: string, physics: InstancePhysics, fields?: PhysicsFields, options?: { recordHistory?: boolean; reason?: string }) => void;
  setNodeUrdf: (id: string, urdf: UrdfInstance, options?: { recordHistory?: boolean; reason?: string }) => void;
  setNodeVisual: (id: string, visual: VisualComponent, options?: { recordHistory?: boolean; reason?: string }) => void;
  on: EventBus<EditorEvent>["on"];
};

export function createEditorEngine(initialDoc: ProjectDoc = createEmptyProject()): EditorEngine {
  let doc = initialDoc;
  const bus = new EventBus<EditorEvent>();
  const history = new CommandHistory();

  const emitDoc = (next: ProjectDoc, reason: string) => {
    doc = next;
    bus.emit({ type: "doc:changed", doc, reason });
  };

  const emitHistory = () => {
    bus.emit({ type: "history:changed", canUndo: history.canUndo(), canRedo: history.canRedo() });
  };

  const execute = (command: EditorCommand, options?: { recordHistory?: boolean; reason?: string }) => {
    const before = doc;
    let after = command.apply(before);
    after = syncVisualCollisions(after);
    if (after === before) return;
    emitDoc(after, options?.reason ?? command.id);
    const recordHistory = options?.recordHistory ?? true;
    if (recordHistory) {
      history.push({ command, before, after, timestamp: Date.now() });
      emitHistory();
    }
  };

  const undo = () => {
    const record = history.undo();
    if (!record) return;
    emitDoc(record.before, `undo:${record.command.id}`);
    emitHistory();
  };

  const redo = () => {
    const record = history.redo();
    if (!record) return;
    emitDoc(record.after, `redo:${record.command.id}`);
    emitHistory();
  };

  return {
    getDoc: () => doc,
    setDoc: (next, reason) => emitDoc(syncVisualCollisions(next), reason),
    execute,
    undo,
    redo,
    replaceScene: (scene, reason = "scene.replace") =>
      emitDoc(syncVisualCollisions(replaceScene(doc, scene)), reason),
    setSelection: (id) => execute(setSelectionCommand(id), { recordHistory: false }),
    setNodeName: (id, name, options) =>
      execute(setNodeNameCommand(id, name), { recordHistory: options?.recordHistory ?? true, reason: options?.reason }),
    setNodeTransform: (id, transform, options) =>
      execute(setNodeTransformCommand(id, transform), { recordHistory: options?.recordHistory ?? false, reason: options?.reason }),
    setNodePhysics: (id, physics, fields, options) =>
      execute(setNodePhysicsCommand(id, physics, fields), { recordHistory: options?.recordHistory ?? true, reason: options?.reason }),
    setNodeUrdf: (id, urdf, options) =>
      execute(setNodeUrdfCommand(id, urdf), { recordHistory: options?.recordHistory ?? true, reason: options?.reason }),
    setNodeVisual: (id, visual, options) =>
      execute(setNodeVisualCommand(id, visual), { recordHistory: options?.recordHistory ?? true, reason: options?.reason }),
    on: bus.on.bind(bus),
  };
}
