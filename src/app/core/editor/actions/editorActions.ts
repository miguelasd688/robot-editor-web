import { editorEngine } from "../engineSingleton";
import { collectSubtree, type ClonePayload } from "../document/ops";
import type { SceneNode } from "../document/types";
import { duplicateSubtreeCommand, pasteSubtreeCommand, removeSubtreeCommand } from "../commands/sceneCommands";
import { useMujocoStore } from "../../store/useMujocoStore";
import { resolveNearestRobotAncestor } from "./hierarchyRules";

let clipboard: ClonePayload | null = null;

const DEFAULT_OFFSET = { x: 0.4, y: 0, z: 0.2 };

function resolveSelection(selectedId: string | null) {
  if (!selectedId) return null;
  const doc = editorEngine.getDoc();
  const node: SceneNode | undefined = doc.scene.nodes[selectedId];
  if (!node) return null;
  return node;
}

function markSceneDirty() {
  useMujocoStore.getState().markSceneDirty();
}

export function copySelection() {
  const doc = editorEngine.getDoc();
  const node = resolveSelection(doc.scene.selectedId);
  if (!node) return;
  const payload = collectSubtree(doc, node.id);
  if (!payload) return;
  clipboard = payload;
}

export function pasteSelection() {
  const clipboardData = clipboard;
  if (!clipboardData) return;
  const doc = editorEngine.getDoc();
  const node = resolveSelection(doc.scene.selectedId);
  const rootNode = clipboardData.nodes.find((candidate) => candidate.id === clipboardData.rootId) ?? null;
  let parentId = node?.id ?? null;
  if (rootNode?.kind === "robot") {
    parentId = null;
  } else if (rootNode?.kind === "link") {
    parentId = resolveNearestRobotAncestor(doc, node?.id ?? null)?.id ?? null;
  }
  editorEngine.execute(
    pasteSubtreeCommand(clipboardData, {
      offset: DEFAULT_OFFSET,
      parentId,
    })
  );
  markSceneDirty();
}

export function duplicateSelection() {
  const doc = editorEngine.getDoc();
  const node = resolveSelection(doc.scene.selectedId);
  if (!node) return;
  editorEngine.execute(duplicateSubtreeCommand(node.id, { offset: DEFAULT_OFFSET }));
  markSceneDirty();
}

export function deleteSelection() {
  const doc = editorEngine.getDoc();
  const node = resolveSelection(doc.scene.selectedId);
  if (!node) return;
  editorEngine.execute(removeSubtreeCommand(node.id));
  markSceneDirty();
}

export function undo() {
  editorEngine.undo();
  markSceneDirty();
}

export function redo() {
  editorEngine.redo();
  markSceneDirty();
}

export function hasClipboard() {
  return clipboard !== null;
}
