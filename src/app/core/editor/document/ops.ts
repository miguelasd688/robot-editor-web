import type { CreateNodeInput, DocId, ProjectDoc, SceneDoc, SceneNode, Transform, VisualComponent } from "./types";
import type { InstancePhysics, PhysicsFields } from "../../assets/types";
import type { UrdfInstance } from "../../urdf/urdfModel";
import { createDocId } from "../../scene/docIds";
import { findJointChildLinkId, findJointParentLinkId, resolveLinkLabel } from "../kinematics/jointKinematics";

export type ClonePayload = {
  rootId: DocId;
  nodes: SceneNode[];
};

function stripIndexSuffix(name: string) {
  const match = name.match(/^(.*)_\d+$/);
  return match ? match[1] : name;
}

function stripCopySuffix(name: string) {
  const trimmed = name.trim();
  if (trimmed.endsWith(" Copy")) return trimmed.slice(0, -5);
  if (trimmed.endsWith(" Paste")) return trimmed.slice(0, -6);
  return trimmed;
}

function resolveUniqueName(doc: ProjectDoc, baseName: string, exceptId?: DocId): string {
  const clean = baseName.trim() || "Object";
  let hasBase = false;
  let maxIndex = 0;
  for (const node of Object.values(doc.scene.nodes)) {
    if (exceptId && node.id === exceptId) continue;
    const name = node.name;
    if (name === clean) {
      hasBase = true;
      continue;
    }
    if (name.startsWith(`${clean}_`)) {
      const suffix = name.slice(clean.length + 1);
      const n = Number(suffix);
      if (Number.isFinite(n)) maxIndex = Math.max(maxIndex, n);
    }
  }
  if (!hasBase && maxIndex === 0) return clean;
  return `${clean}_${Math.max(1, maxIndex + 1)}`;
}

const isAllowedLinkParentKind = (kind: SceneNode["kind"] | null | undefined) =>
  kind === "robot" || kind === "joint";

const isFixedContainerKind = (kind: SceneNode["kind"]) => kind === "visual" || kind === "collision";

const canonicalNameForKind = (kind: SceneNode["kind"], fallback: string) => {
  if (kind === "visual") return "Visual";
  if (kind === "collision") return "Collision";
  return fallback;
};

function resolveNodeName(doc: ProjectDoc, kind: SceneNode["kind"], baseName: string, exceptId?: DocId) {
  if (isFixedContainerKind(kind)) {
    return canonicalNameForKind(kind, baseName);
  }
  return resolveUniqueName(doc, baseName, exceptId);
}

function sanitizeParentForKind(
  nodes: Record<DocId, SceneNode>,
  parentId: DocId | null,
  kind: SceneNode["kind"]
): DocId | null {
  if (kind === "robot") return null;
  if (kind !== "link" || !parentId) return parentId;
  const parentKind = nodes[parentId]?.kind;
  if (!parentKind) return parentId;
  return isAllowedLinkParentKind(parentKind) ? parentId : null;
}

function resolveNearestAllowedLinkParentId(doc: ProjectDoc, startId: DocId | null): DocId | null {
  let cur: DocId | null = startId;
  while (cur) {
    const node = doc.scene.nodes[cur];
    if (!node) return null;
    if (isAllowedLinkParentKind(node.kind)) return node.id;
    cur = node.parentId ?? null;
  }
  return null;
}

export function touchMetadata(doc: ProjectDoc): ProjectDoc {
  return {
    ...doc,
    metadata: {
      ...doc.metadata,
      updatedAt: new Date().toISOString(),
    },
  };
}

export function replaceScene(doc: ProjectDoc, scene: SceneDoc): ProjectDoc {
  const next: ProjectDoc = {
    ...doc,
    scene: {
      nodes: scene.nodes,
      roots: scene.roots,
      selectedId: scene.selectedId ?? null,
    },
  };
  return touchMetadata(next);
}

export function setSelection(doc: ProjectDoc, id: DocId | null): ProjectDoc {
  if (doc.scene.selectedId === id) return doc;
  const next: ProjectDoc = {
    ...doc,
    scene: {
      ...doc.scene,
      selectedId: id,
    },
  };
  return touchMetadata(next);
}

export function upsertNodeTransform(doc: ProjectDoc, id: DocId, transform: Transform): ProjectDoc {
  const node = doc.scene.nodes[id];
  if (!node) return doc;
  const nextNode = {
    ...node,
    components: {
      ...node.components,
      transform,
    },
  };
  const next: ProjectDoc = {
    ...doc,
    scene: {
      ...doc.scene,
      nodes: {
        ...doc.scene.nodes,
        [id]: nextNode,
      },
    },
  };
  return touchMetadata(next);
}

export function upsertNodePhysics(
  doc: ProjectDoc,
  id: DocId,
  physics: InstancePhysics,
  fields?: PhysicsFields
): ProjectDoc {
  const node = doc.scene.nodes[id];
  if (!node) return doc;
  const nextNode = {
    ...node,
    components: {
      ...node.components,
      physics,
      physicsFields: fields ?? node.components?.physicsFields,
    },
  };
  const next: ProjectDoc = {
    ...doc,
    scene: {
      ...doc.scene,
      nodes: {
        ...doc.scene.nodes,
        [id]: nextNode,
      },
    },
  };
  return touchMetadata(next);
}

export function upsertNodeUrdf(doc: ProjectDoc, id: DocId, urdf: UrdfInstance): ProjectDoc {
  const node = doc.scene.nodes[id];
  if (!node) return doc;
  const nextNode = {
    ...node,
    components: {
      ...node.components,
      urdf,
    },
  };
  const next: ProjectDoc = {
    ...doc,
    scene: {
      ...doc.scene,
      nodes: {
        ...doc.scene.nodes,
        [id]: nextNode,
      },
    },
  };
  return touchMetadata(next);
}

export function upsertNodeVisual(doc: ProjectDoc, id: DocId, visual: VisualComponent): ProjectDoc {
  const node = doc.scene.nodes[id];
  if (!node) return doc;
  const nextNode = {
    ...node,
    components: {
      ...node.components,
      visual,
    },
  };
  const next: ProjectDoc = {
    ...doc,
    scene: {
      ...doc.scene,
      nodes: {
        ...doc.scene.nodes,
        [id]: nextNode,
      },
    },
  };
  return touchMetadata(next);
}

export function setNodeName(doc: ProjectDoc, id: DocId, name: string): ProjectDoc {
  const node = doc.scene.nodes[id];
  if (!node) return doc;

  const previousLinkLabel = node.kind === "link" ? resolveLinkLabel(node) : null;
  const fallback =
    node.kind === "robot"
      ? "Robot"
      : node.kind === "link"
        ? "Link"
        : node.kind === "joint"
          ? "Joint"
          : node.kind === "mesh"
            ? "Mesh"
            : node.name || "Object";
  const desired = name.trim() || fallback;
  const nextName = resolveNodeName(doc, node.kind, desired, id);
  const urdf = node.components?.urdf;
  const needsLinkUrdfRename = urdf?.kind === "link" && urdf.link.name !== nextName;
  const needsJointUrdfRename = urdf?.kind === "joint" && urdf.joint.name !== nextName;
  if (nextName === node.name && !needsLinkUrdfRename && !needsJointUrdfRename) return doc;

  let nextNode: SceneNode = { ...node, name: nextName };
  if (urdf?.kind === "link" && urdf.link.name !== nextName) {
    nextNode = {
      ...nextNode,
      components: {
        ...(nextNode.components ?? {}),
        urdf: {
          ...urdf,
          link: {
            ...urdf.link,
            name: nextName,
          },
        },
      },
    };
  } else if (urdf?.kind === "joint" && urdf.joint.name !== nextName) {
    nextNode = {
      ...nextNode,
      components: {
        ...(nextNode.components ?? {}),
        urdf: {
          ...urdf,
          joint: {
            ...urdf.joint,
            name: nextName,
          },
        },
      },
    };
  }

  const nextNodes: Record<DocId, SceneNode> = {
    ...doc.scene.nodes,
    [id]: nextNode,
  };

  const nextLinkLabel = node.kind === "link" ? resolveLinkLabel(nextNode) : null;
  if (previousLinkLabel && nextLinkLabel && previousLinkLabel !== nextLinkLabel) {
    for (const candidate of Object.values(doc.scene.nodes)) {
      if (candidate.id === id || candidate.kind !== "joint") continue;
      const candidateUrdf = candidate.components?.urdf;
      if (!candidateUrdf || candidateUrdf.kind !== "joint") continue;

      const currentJoint = candidateUrdf.joint;
      const parent = currentJoint.parent === previousLinkLabel ? nextLinkLabel : currentJoint.parent;
      const child = currentJoint.child === previousLinkLabel ? nextLinkLabel : currentJoint.child;
      if (parent === currentJoint.parent && child === currentJoint.child) continue;

      nextNodes[candidate.id] = {
        ...candidate,
        components: {
          ...(candidate.components ?? {}),
          urdf: {
            ...candidateUrdf,
            joint: {
              ...currentJoint,
              parent,
              child,
            },
          },
        },
      };
    }
  }

  const next: ProjectDoc = {
    ...doc,
    scene: {
      ...doc.scene,
      nodes: nextNodes,
    },
  };
  return touchMetadata(next);
}

export function setNodeParent(doc: ProjectDoc, id: DocId, parentId: DocId | null): ProjectDoc {
  const node = doc.scene.nodes[id];
  if (!node) return doc;
  const nextParentId = parentId && doc.scene.nodes[parentId] ? parentId : null;
  if (nextParentId === id) return doc;
  if (nextParentId === node.parentId) return doc;
  if (node.kind === "robot" && nextParentId !== null) return doc;
  if (node.kind === "link" && nextParentId && !isAllowedLinkParentKind(doc.scene.nodes[nextParentId]?.kind ?? null)) {
    return doc;
  }
  if (nextParentId) {
    let current: DocId | null = nextParentId;
    while (current) {
      if (current === id) return doc;
      current = doc.scene.nodes[current]?.parentId ?? null;
    }
  }

  const nodes = { ...doc.scene.nodes };
  let roots = doc.scene.roots.filter((rid) => rid !== id);

  if (node.parentId && nodes[node.parentId]) {
    const prevParent = nodes[node.parentId];
    nodes[node.parentId] = {
      ...prevParent,
      children: prevParent.children.filter((cid) => cid !== id),
    };
  }

  if (nextParentId && nodes[nextParentId]) {
    const parent = nodes[nextParentId];
    if (!parent.children.includes(id)) {
      nodes[nextParentId] = { ...parent, children: [...parent.children, id] };
    }
  } else {
    if (!roots.includes(id)) roots = [...roots, id];
  }

  nodes[id] = { ...node, parentId: nextParentId };

  const next: ProjectDoc = {
    ...doc,
    scene: {
      ...doc.scene,
      nodes,
      roots,
    },
  };
  return touchMetadata(next);
}

export function addNode(doc: ProjectDoc, input: CreateNodeInput): ProjectDoc {
  const id = input.id ?? createDocId();
  if (doc.scene.nodes[id]) return doc;
  const requestedParentId = input.parentId ?? null;
  const parentId = sanitizeParentForKind(doc.scene.nodes, requestedParentId, input.kind);
  const uniqueName = resolveNodeName(doc, input.kind, input.name);
  let components = input.components ?? {};
  if (components.urdf?.kind === "joint") {
    components = {
      ...components,
      urdf: {
        ...components.urdf,
        joint: {
          ...components.urdf.joint,
          name: uniqueName,
        },
      },
    };
  }
  const node: SceneNode = {
    id,
    name: uniqueName,
    parentId,
    children: [],
    kind: input.kind,
    components,
    source: input.source,
  };

  const nodes = { ...doc.scene.nodes, [id]: node };
  let roots = [...doc.scene.roots];
  if (parentId) {
    const parent = nodes[parentId];
    if (parent) {
      nodes[parentId] = { ...parent, children: [...parent.children, id] };
    } else {
      roots = [...roots, id];
    }
  } else {
    roots = [...roots, id];
  }

  const next: ProjectDoc = {
    ...doc,
    scene: {
      ...doc.scene,
      nodes,
      roots,
      selectedId: id,
    },
  };
  return touchMetadata(next);
}

export function addNodes(
  doc: ProjectDoc,
  inputs: CreateNodeInput[],
  options?: { selectId?: DocId }
): ProjectDoc {
  if (!inputs.length) return doc;

  const nodesCopy: Record<DocId, SceneNode> = { ...doc.scene.nodes };
  const roots = [...doc.scene.roots];
  const created: SceneNode[] = [];

  for (const input of inputs) {
    const id = input.id ?? createDocId();
    if (nodesCopy[id]) continue;
    const requestedParentId = input.parentId ?? null;
    const parentId = sanitizeParentForKind(nodesCopy, requestedParentId, input.kind);
    const docForName: ProjectDoc = {
      ...doc,
      scene: {
        ...doc.scene,
        nodes: nodesCopy,
      },
    };
    const uniqueName = resolveNodeName(docForName, input.kind, input.name);
    let components = input.components ?? {};
    if (components.urdf?.kind === "joint") {
      components = {
        ...components,
        urdf: {
          ...components.urdf,
          joint: {
            ...components.urdf.joint,
            name: uniqueName,
          },
        },
      };
    }
    const node: SceneNode = {
      id,
      name: uniqueName,
      parentId,
      children: [],
      kind: input.kind,
      components,
      source: input.source,
    };
    nodesCopy[id] = node;
    created.push(node);
  }

  for (const node of created) {
    const parentId = node.parentId;
    if (parentId && nodesCopy[parentId]) {
      const parent = nodesCopy[parentId];
      if (node.kind === "link" && !isAllowedLinkParentKind(parent.kind)) {
        nodesCopy[node.id] = { ...node, parentId: null };
        if (!roots.includes(node.id)) roots.push(node.id);
        continue;
      }
      if (!parent.children.includes(node.id)) {
        nodesCopy[parentId] = { ...parent, children: [...parent.children, node.id] };
      }
    } else {
      if (node.parentId) {
        nodesCopy[node.id] = { ...node, parentId: null };
      }
      if (!roots.includes(node.id)) roots.push(node.id);
    }
  }

  const selectId = options?.selectId ?? created[0]?.id ?? doc.scene.selectedId ?? null;
  const next: ProjectDoc = {
    ...doc,
    scene: {
      ...doc.scene,
      nodes: nodesCopy,
      roots,
      selectedId: selectId,
    },
  };
  return touchMetadata(next);
}

export function collectSubtree(doc: ProjectDoc, rootId: DocId): ClonePayload | null {
  const root = doc.scene.nodes[rootId];
  if (!root) return null;
  const nodes: SceneNode[] = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop() as DocId;
    const node = doc.scene.nodes[id];
    if (!node) continue;
    nodes.push(node);
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      stack.push(node.children[i]);
    }
  }
  return { rootId, nodes };
}

const cloneVec3 = (v: { x: number; y: number; z: number }) => ({ x: v.x, y: v.y, z: v.z });

function cloneNode(node: SceneNode): SceneNode {
  const components = node.components;
  const transform = components?.transform
    ? {
        position: cloneVec3(components.transform.position),
        rotation: cloneVec3(components.transform.rotation),
        scale: cloneVec3(components.transform.scale),
      }
    : undefined;
  const physics = components?.physics
    ? {
        ...components.physics,
        inertia: cloneVec3(components.physics.inertia),
        inertiaTensor: components.physics.inertiaTensor
          ? { ...components.physics.inertiaTensor }
          : undefined,
        com: components.physics.com ? cloneVec3(components.physics.com) : undefined,
      }
    : undefined;
  const urdf = components?.urdf ? (JSON.parse(JSON.stringify(components.urdf)) as UrdfInstance) : undefined;
  const physicsFields = components?.physicsFields ? { ...components.physicsFields } : undefined;
  return {
    ...node,
    components: {
      ...(components ?? {}),
      transform,
      physics,
      physicsFields,
      urdf,
    },
  };
}

function insertAfter(list: DocId[], targetId: DocId, nextId: DocId) {
  const index = list.indexOf(targetId);
  if (index === -1) return [...list, nextId];
  return [...list.slice(0, index + 1), nextId, ...list.slice(index + 1)];
}

export function cloneSubtree(
  doc: ProjectDoc,
  rootId: DocId,
  options?: { offset?: { x: number; y: number; z: number } }
): ProjectDoc {
  const payload = collectSubtree(doc, rootId);
  if (!payload) return doc;
  return pasteSubtree(doc, payload, {
    offset: options?.offset,
    nameSuffix: " Copy",
    insertAfterId: rootId,
  });
}

export function pasteSubtree(
  doc: ProjectDoc,
  payload: ClonePayload,
  options?: {
    offset?: { x: number; y: number; z: number };
    nameSuffix?: string;
    insertAfterId?: DocId;
    parentId?: DocId | null;
  }
): ProjectDoc {
  const idMap = new Map<DocId, DocId>();
  for (const node of payload.nodes) {
    idMap.set(node.id, createDocId());
  }
  const newRootId = idMap.get(payload.rootId) as DocId;
  const nodesCopy: Record<DocId, SceneNode> = { ...doc.scene.nodes };
  const parentOverride =
    Object.prototype.hasOwnProperty.call(options ?? {}, "parentId") ? options?.parentId : undefined;
  const rootTemplate = payload.nodes.find((node) => node.id === payload.rootId) ?? null;
  const requestedRootParent =
    parentOverride !== undefined ? parentOverride : doc.scene.nodes[payload.rootId]?.parentId ?? null;
  const resolvedRootParent =
    rootTemplate?.kind === "robot"
      ? null
      : rootTemplate?.kind === "link"
        ? resolveNearestAllowedLinkParentId(doc, requestedRootParent)
        : requestedRootParent;

  for (const node of payload.nodes) {
    const cloned = cloneNode(node);
    const nextId = idMap.get(node.id) as DocId;
    const mappedParentId = node.parentId && idMap.get(node.parentId) ? (idMap.get(node.parentId) as DocId) : node.parentId;
    const rawParentId = node.id === payload.rootId ? resolvedRootParent : mappedParentId;
    const parentId = sanitizeParentForKind(nodesCopy, rawParentId, node.kind);
    const children = node.children.filter((child) => idMap.has(child)).map((child) => idMap.get(child) as DocId);
    let name = canonicalNameForKind(node.kind, node.name);
    if (node.id === payload.rootId) {
      if (!isFixedContainerKind(node.kind)) {
        if (options?.nameSuffix) name = `${name}${options.nameSuffix}`;
        const base = stripIndexSuffix(stripCopySuffix(name));
        name = resolveUniqueName(doc, base);
      }
    }
    if (node.kind === "joint" && node.id !== payload.rootId) {
      const base = stripIndexSuffix(stripCopySuffix(name));
      const docForName: ProjectDoc = {
        ...doc,
        scene: {
          ...doc.scene,
          nodes: nodesCopy,
        },
      };
      name = resolveUniqueName(docForName, base);
    }

    let components = cloned.components;
    if (node.id === payload.rootId && options?.offset) {
      const transform = components?.transform ?? {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      };
      transform.position = {
        x: transform.position.x + options.offset.x,
        y: transform.position.y + options.offset.y,
        z: transform.position.z + options.offset.z,
      };
      components = { ...(components ?? {}), transform };
    }

    if (node.kind === "joint" && components?.urdf?.kind === "joint") {
      components = {
        ...(components ?? {}),
        urdf: {
          ...components.urdf,
          joint: {
            ...components.urdf.joint,
            name,
          },
        },
      };
    }

    nodesCopy[nextId] = {
      ...cloned,
      id: nextId,
      parentId,
      children,
      name,
      components,
      source: { kind: "clone", fromId: node.id },
    };
  }

  let roots = [...doc.scene.roots];
  const rootParent = resolvedRootParent;
  if (!rootParent) {
    if (options?.insertAfterId && roots.includes(options.insertAfterId)) {
      roots = insertAfter(roots, options.insertAfterId, newRootId);
    } else {
      roots = [...roots, newRootId];
    }
  } else {
    const parent = nodesCopy[rootParent];
    if (parent) {
      const updatedChildren =
        options?.insertAfterId && parent.children.includes(options.insertAfterId)
          ? insertAfter(parent.children, options.insertAfterId, newRootId)
          : [...parent.children, newRootId];
      nodesCopy[rootParent] = { ...parent, children: updatedChildren };
    } else {
      roots = [...roots, newRootId];
    }
  }

  const next: ProjectDoc = {
    ...doc,
    scene: {
      ...doc.scene,
      nodes: nodesCopy,
      roots,
      selectedId: newRootId,
    },
  };
  return touchMetadata(next);
}

export function removeSubtree(doc: ProjectDoc, rootId: DocId): ProjectDoc {
  const payload = collectSubtree(doc, rootId);
  if (!payload) return doc;
  const toRemove = new Set(payload.nodes.map((n) => n.id));
  const nextNodes: Record<DocId, SceneNode> = {};
  for (const [id, node] of Object.entries(doc.scene.nodes)) {
    if (!toRemove.has(id)) nextNodes[id] = node;
  }

  const roots = doc.scene.roots.filter((id) => !toRemove.has(id));
  const parentId = doc.scene.nodes[rootId]?.parentId ?? null;
  if (parentId && nextNodes[parentId]) {
    const parent = nextNodes[parentId];
    nextNodes[parentId] = {
      ...parent,
      children: parent.children.filter((id) => !toRemove.has(id)),
    };
  }

  const selectedId = doc.scene.selectedId && toRemove.has(doc.scene.selectedId) ? null : doc.scene.selectedId;

  const next: ProjectDoc = {
    ...doc,
    scene: {
      ...doc.scene,
      nodes: nextNodes,
      roots,
      selectedId,
    },
  };
  return touchMetadata(next);
}

const defaultTransform = (): Transform => ({
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
});

const cloneTransform = (t: Transform): Transform => ({
  position: cloneVec3(t.position),
  rotation: cloneVec3(t.rotation),
  scale: cloneVec3(t.scale),
});

const sameTransform = (a: Transform, b: Transform) =>
  a.position.x === b.position.x &&
  a.position.y === b.position.y &&
  a.position.z === b.position.z &&
  a.rotation.x === b.rotation.x &&
  a.rotation.y === b.rotation.y &&
  a.rotation.z === b.rotation.z &&
  a.scale.x === b.scale.x &&
  a.scale.y === b.scale.y &&
  a.scale.z === b.scale.z;

const cloneSource = (source: SceneNode["source"] | undefined): SceneNode["source"] | undefined =>
  source ? (JSON.parse(JSON.stringify(source)) as SceneNode["source"]) : undefined;

const isMirrorableKind = (kind: SceneNode["kind"]) => kind === "mesh" || kind === "group";

function syncJointMetadata(doc: ProjectDoc): ProjectDoc {
  const nodes = doc.scene.nodes;
  let changed = false;
  const nodesCopy: Record<DocId, SceneNode> = { ...nodes };

  for (const node of Object.values(nodes)) {
    if (node.kind !== "joint") continue;
    const urdf = node.components?.urdf;
    if (!urdf || urdf.kind !== "joint") continue;

    let nextJoint = urdf.joint;
    let jointChanged = false;

    const parentId = findJointParentLinkId(nodes, node.id);
    const parent = parentId ? nodes[parentId] : null;
    if (parent?.kind === "link") {
      const parentName = resolveLinkLabel(parent);
      if (nextJoint.parent !== parentName) {
        nextJoint = { ...nextJoint, parent: parentName };
        jointChanged = true;
      }
    }

    const childId = findJointChildLinkId(nodes, node.id);
    if (childId) {
      const child = nodes[childId];
      const childName = child ? resolveLinkLabel(child) : "";
      if (childName && nextJoint.child !== childName) {
        nextJoint = { ...nextJoint, child: childName };
        jointChanged = true;
      }
    }

    if (jointChanged) {
      nodesCopy[node.id] = {
        ...node,
        components: {
          ...(node.components ?? {}),
          urdf: {
            ...urdf,
            joint: nextJoint,
          },
        },
      };
      changed = true;
    }
  }

  if (!changed) return doc;
  return {
    ...doc,
    scene: {
      ...doc.scene,
      nodes: nodesCopy,
    },
  };
}

export function syncVisualCollisions(doc: ProjectDoc): ProjectDoc {
  const sourceNodes = doc.scene.nodes;
  const visuals = Object.values(sourceNodes).filter(
    (node) => node.kind === "visual" && node.components?.visual?.attachCollisions
  );
  if (!visuals.length) return syncJointMetadata(doc);

  let next = doc;
  for (const visual of visuals) {
    const visualTransform = visual.components?.transform ?? defaultTransform();
    const visualDescIds = new Set<DocId>();
    const visualStack: DocId[] = [visual.id];
    while (visualStack.length) {
      const id = visualStack.pop() as DocId;
      const node = sourceNodes[id];
      if (!node) continue;
      if (id !== visual.id) visualDescIds.add(id);
      for (let i = node.children.length - 1; i >= 0; i -= 1) {
        visualStack.push(node.children[i]);
      }
    }

    const findCollisionSibling = () => {
      const parentId = visual.parentId ?? null;
      if (parentId) {
        const parent = next.scene.nodes[parentId];
        if (!parent) return null;
        for (const childId of parent.children) {
          const child = next.scene.nodes[childId];
          if (child?.kind === "collision") return child;
        }
        return null;
      }
      for (const rootId of next.scene.roots) {
        const root = next.scene.nodes[rootId];
        if (root?.kind === "collision") return root;
      }
      return null;
    };

    const findCollisionByMirrorSources = () => {
      for (const node of Object.values(next.scene.nodes)) {
        if (node.kind !== "collision") continue;
        const stack: DocId[] = [node.id];
        while (stack.length) {
          const id = stack.pop() as DocId;
          const child = next.scene.nodes[id];
          if (!child) continue;
          const sourceId = child.components?.mirror?.sourceId;
          if (sourceId && visualDescIds.has(sourceId)) {
            return node;
          }
          for (let i = child.children.length - 1; i >= 0; i -= 1) {
            stack.push(child.children[i]);
          }
        }
      }
      return null;
    };

    let collision = findCollisionSibling();
    if (!collision) {
      collision = findCollisionByMirrorSources();
      if (collision && collision.parentId !== visual.parentId) {
        next = setNodeParent(next, collision.id, visual.parentId ?? null);
        collision = next.scene.nodes[collision.id] ?? collision;
      }
    }
    if (!collision) {
      const collisionId = createDocId();
      next = addNodes(
        next,
        [
          {
            id: collisionId,
            name: "Collision",
            kind: "collision",
            parentId: visual.parentId ?? null,
            components: { transform: cloneTransform(visualTransform) },
          },
        ],
        { selectId: next.scene.selectedId ?? undefined }
      );
      collision = next.scene.nodes[collisionId] ?? null;
    }
    if (!collision) continue;

    const collisionTransform = collision.components?.transform ?? defaultTransform();
    if (!sameTransform(collisionTransform, visualTransform)) {
      next = upsertNodeTransform(next, collision.id, cloneTransform(visualTransform));
    }

    const mirrorMap = new Map<DocId, DocId>();
    const mirrorSourceById = new Map<DocId, DocId>();
    const collisionDescIds: DocId[] = [];
    const mirrorStack = [collision.id];
    while (mirrorStack.length) {
      const id = mirrorStack.pop() as DocId;
      const node = next.scene.nodes[id];
      if (!node) continue;
      if (id !== collision.id) collisionDescIds.push(id);
      const sourceId = node.components?.mirror?.sourceId;
      if (sourceId) {
        mirrorMap.set(sourceId, id);
        mirrorSourceById.set(id, sourceId);
      }
      for (let i = node.children.length - 1; i >= 0; i -= 1) {
        mirrorStack.push(node.children[i]);
      }
    }

    const usedMirrorIds = new Set<DocId>();
    const parentMirrorByVisual = new Map<DocId, DocId>();
    parentMirrorByVisual.set(visual.id, collision.id);
    const stack: DocId[] = [visual.id];

    while (stack.length) {
      const id = stack.pop() as DocId;
      const node = sourceNodes[id];
      if (!node) continue;
      const parentMirrorId = parentMirrorByVisual.get(id) ?? collision.id;

      for (let i = node.children.length - 1; i >= 0; i -= 1) {
        const childId = node.children[i];
        const child = sourceNodes[childId];
        if (!child) continue;

        if (isMirrorableKind(child.kind)) {
          let mirrorId = mirrorMap.get(childId);
          const childTransform = child.components?.transform ?? defaultTransform();
          if (!mirrorId) {
            mirrorId = createDocId();
            next = addNodes(
              next,
              [
                {
                  id: mirrorId,
                  name: child.name,
                  kind: child.kind,
                  parentId: parentMirrorId,
                  source: cloneSource(child.source),
                  components: {
                    transform: cloneTransform(childTransform),
                    mirror: { sourceId: childId },
                  },
                },
              ],
              { selectId: next.scene.selectedId ?? undefined }
            );
          }

          if (mirrorId) {
            usedMirrorIds.add(mirrorId);
            parentMirrorByVisual.set(childId, mirrorId);
            const mirrorNode = next.scene.nodes[mirrorId];
            if (mirrorNode) {
              if (mirrorNode.parentId !== parentMirrorId) {
                next = setNodeParent(next, mirrorId, parentMirrorId);
              }

              let nextComponents = mirrorNode.components ?? {};
              let changed = false;

              if (!sameTransform(nextComponents.transform ?? defaultTransform(), childTransform)) {
                nextComponents = { ...nextComponents, transform: cloneTransform(childTransform) };
                changed = true;
              }

              if (nextComponents.mirror?.sourceId !== childId) {
                nextComponents = { ...nextComponents, mirror: { sourceId: childId } };
                changed = true;
              }

              const nextName = mirrorNode.name === child.name ? mirrorNode.name : child.name;
              const nextKind = mirrorNode.kind === child.kind ? mirrorNode.kind : child.kind;
              const sourceEqual =
                JSON.stringify(mirrorNode.source ?? null) === JSON.stringify(child.source ?? null);
              const nextSource = sourceEqual ? mirrorNode.source : cloneSource(child.source);
              if (nextName !== mirrorNode.name || nextKind !== mirrorNode.kind || !sourceEqual || changed) {
                const updated: SceneNode = {
                  ...mirrorNode,
                  name: nextName,
                  kind: nextKind,
                  source: nextSource,
                  components: nextComponents,
                };
                next = touchMetadata({
                  ...next,
                  scene: {
                    ...next.scene,
                    nodes: {
                      ...next.scene.nodes,
                      [mirrorId]: updated,
                    },
                  },
                });
              }
            }
          }
        } else {
          parentMirrorByVisual.set(childId, parentMirrorId);
        }

        stack.push(childId);
      }
    }

    if (collisionDescIds.length) {
      const toRemove = new Set<DocId>();
      for (const id of collisionDescIds) {
        const sourceId = mirrorSourceById.get(id);
        if (sourceId) {
          const sourceNode = sourceNodes[sourceId];
          const sourceInVisual = visualDescIds.has(sourceId);
          const shouldKeep = Boolean(sourceNode) && sourceInVisual && usedMirrorIds.has(id);
          if (!shouldKeep) toRemove.add(id);
        } else {
          toRemove.add(id);
        }
      }

      if (toRemove.size) {
        const hasAncestorInSet = (id: DocId) => {
          let cur: DocId | null = next.scene.nodes[id]?.parentId ?? null;
          while (cur) {
            if (toRemove.has(cur)) return true;
            cur = next.scene.nodes[cur]?.parentId ?? null;
          }
          return false;
        };

        const rootsToRemove = Array.from(toRemove).filter((id) => !hasAncestorInSet(id));
        for (const id of rootsToRemove) {
          next = removeSubtree(next, id);
        }
      }
    }
  }

  return syncJointMetadata(next);
}
