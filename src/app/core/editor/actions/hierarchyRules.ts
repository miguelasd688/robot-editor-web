import type { SceneNode } from "../document/types";

type SceneGraph = {
  scene: {
    nodes: Record<string, SceneNode>;
  };
};

const LINK_ANCESTOR_KINDS = new Set<SceneNode["kind"]>(["link"]);
const ROBOT_ANCESTOR_KINDS = new Set<SceneNode["kind"]>(["robot"]);

export function isAllowedLinkParentKind(kind: SceneNode["kind"] | null | undefined) {
  return kind === "robot" || kind === "joint";
}

export function findNearestAncestorByKinds(
  doc: SceneGraph,
  startId: string | null,
  kinds: ReadonlySet<SceneNode["kind"]>
): SceneNode | null {
  let cur: string | null = startId;
  while (cur) {
    const node = doc.scene.nodes[cur];
    if (!node) return null;
    if (kinds.has(node.kind)) return node;
    cur = node.parentId ?? null;
  }
  return null;
}

export function resolveNearestLinkAncestor(doc: SceneGraph, startId: string | null): SceneNode | null {
  return findNearestAncestorByKinds(doc, startId, LINK_ANCESTOR_KINDS);
}

export function resolveNearestRobotAncestor(doc: SceneGraph, startId: string | null): SceneNode | null {
  return findNearestAncestorByKinds(doc, startId, ROBOT_ANCESTOR_KINDS);
}

export function validateReparentTarget(
  doc: SceneGraph,
  sourceId: string,
  targetId: string | null
): { ok: true } | { ok: false; reason: string } {
  const source = doc.scene.nodes[sourceId];
  if (!source) return { ok: false, reason: "Source node not found." };
  if (targetId === sourceId) return { ok: false, reason: "A node cannot be parented to itself." };

  if (targetId) {
    let cur: string | null = targetId;
    while (cur) {
      if (cur === sourceId) {
        return { ok: false, reason: "Cannot parent a node inside its own descendants." };
      }
      cur = doc.scene.nodes[cur]?.parentId ?? null;
    }
  }

  if (source.kind === "robot" && targetId !== null) {
    return { ok: false, reason: "Robots are primary roots and must stay at scene root." };
  }

  const target = targetId ? doc.scene.nodes[targetId] : null;

  if (source.kind === "link" && targetId) {
    if (!isAllowedLinkParentKind(target?.kind ?? null)) {
      return { ok: false, reason: "Links can only be parented to Robot, Joint or scene root." };
    }
  }

  return { ok: true };
}
