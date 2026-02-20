import type { SceneSnapshot } from "../../../viewer/types";
import type { SceneDoc, SceneNode } from "../../document/types";

export function sceneSnapshotToDoc(snapshot: SceneSnapshot): SceneDoc {
  const nodes: Record<string, SceneNode> = {};
  for (const node of snapshot.nodes) {
    nodes[node.id] = {
      ...node,
      components: {},
    };
  }
  return {
    nodes,
    roots: [...snapshot.roots],
    selectedId: null,
  };
}
