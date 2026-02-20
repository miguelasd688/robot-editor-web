import type { SceneNode } from "../document/types";

export function resolveLinkLabel(node: SceneNode): string {
  const urdf = node.components?.urdf;
  if (urdf?.kind === "link") return urdf.link.name || node.name || node.id;
  return node.name || node.id;
}

export function findAncestorIdByKind(
  nodes: Record<string, SceneNode>,
  startId: string | null,
  kind: SceneNode["kind"]
): string | null {
  let current: string | null = startId;
  while (current) {
    const node = nodes[current];
    if (!node) return null;
    if (node.kind === kind) return current;
    current = node.parentId ?? null;
  }
  return null;
}

export function findJointParentLinkId(nodes: Record<string, SceneNode>, jointId: string): string | null {
  const joint = nodes[jointId];
  if (!joint || joint.kind !== "joint") return null;
  return findAncestorIdByKind(nodes, joint.parentId ?? null, "link");
}

function findFirstDescendantLinkId(nodes: Record<string, SceneNode>, startId: string): string | null {
  const visited = new Set<string>();
  const stack: string[] = [startId];
  while (stack.length) {
    const id = stack.pop() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = nodes[id];
    if (!node) continue;
    if (node.kind === "link") return id;
    if (node.kind === "joint") continue;
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      stack.push(node.children[i]);
    }
  }
  return null;
}

export function collectJointChildLinkIds(nodes: Record<string, SceneNode>, jointId: string): string[] {
  const joint = nodes[jointId];
  if (!joint || joint.kind !== "joint") return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const childId of joint.children) {
    const linkId = findFirstDescendantLinkId(nodes, childId);
    if (!linkId || seen.has(linkId)) continue;
    seen.add(linkId);
    out.push(linkId);
  }
  return out;
}

export function findJointChildLinkId(nodes: Record<string, SceneNode>, jointId: string): string | null {
  return collectJointChildLinkIds(nodes, jointId)[0] ?? null;
}

