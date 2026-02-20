import { create } from "zustand";
import type { SceneSnapshot } from "../viewer/types";
import { editorEngine } from "../editor/engineSingleton";
import type { ProjectDoc, SceneNode } from "../editor/document/types";
import { sceneSnapshotToDoc } from "../editor/adapters/three/snapshotAdapter";
import { getThreeAdapter } from "../editor/adapters/three/adapterSingleton";

type SceneState = {
  nodes: Record<string, SceneNode>;
  roots: string[];
  selectedId: string | null;
  expandedById: Record<string, boolean>;

  setSelected: (id: string | null) => void;
  toggleExpanded: (id: string) => void;
  setExpanded: (id: string, value: boolean) => void;
  mergeExpanded: (patch: Record<string, boolean>) => void;

  // sincronización desde el Viewer (por ahora, una sola llamada)
  replaceFromSnapshot: (snapshot: SceneSnapshot) => void;
};

function syncFromDoc(doc: ProjectDoc, set: (next: Partial<SceneState>) => void) {
  set({
    nodes: doc.scene.nodes,
    roots: doc.scene.roots,
    selectedId: doc.scene.selectedId,
  });
}

export const useSceneStore = create<SceneState>((set) => {
  const initial = editorEngine.getDoc();
  editorEngine.on("doc:changed", (event) => {
    syncFromDoc(event.doc, set);
  });

  return {
    nodes: initial.scene.nodes,
    roots: initial.scene.roots,
    selectedId: initial.scene.selectedId,
    expandedById: {},

    setSelected: (id) => editorEngine.setSelection(id),
    toggleExpanded: (id) =>
      set((state) => ({ expandedById: { ...state.expandedById, [id]: !state.expandedById[id] } })),
    setExpanded: (id, value) =>
      set((state) => ({ expandedById: { ...state.expandedById, [id]: value } })),
    mergeExpanded: (patch) =>
      set((state) => ({ expandedById: { ...state.expandedById, ...patch } })),

    replaceFromSnapshot: (snapshot) => {
      const adapter = getThreeAdapter();
      if (adapter) {
        adapter.syncSceneFromViewer();
        return;
      }
      const scene = sceneSnapshotToDoc(snapshot);
      scene.selectedId = editorEngine.getDoc().scene.selectedId;
      editorEngine.replaceScene(scene, "viewer:snapshot");
    },
  };
});
