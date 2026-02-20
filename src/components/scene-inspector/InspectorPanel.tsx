import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useAppStore } from "../../app/core/store/useAppStore";
import { useSceneStore } from "../../app/core/store/useSceneStore";
import type { SceneNode } from "../../app/core/editor/document/types";
import { reparentNode, renameNode } from "../../app/core/editor/actions/sceneHierarchyActions";
import { validateReparentTarget } from "../../app/core/editor/actions/hierarchyRules";

function iconForKind(kind: string) {
  switch (kind) {
    case "mesh":
      return "🧩";
    case "light":
      return "💡";
    case "camera":
      return "📷";
    case "group":
      return "📦";
    case "robot":
      return "🤖";
    case "link":
      return "🔗";
    case "joint":
      return "⚙️";
    case "visual":
      return "👁️";
    case "collision":
      return "🛡️";
    default:
      return "🔸";
  }
}

type SceneInspectorView = {
  childrenById: Record<string, string[]>;
  parentById: Record<string, string | null>;
};

function collectDescendants(nodes: Record<string, SceneNode>, rootId: string) {
  const out: string[] = [];
  const visited = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    out.push(id);
    const node = nodes[id];
    if (!node) continue;
    for (let i = (node.children?.length ?? 0) - 1; i >= 0; i -= 1) {
      const childId = node.children[i];
      if (!visited.has(childId)) stack.push(childId);
    }
  }
  return out;
}

const RENAMABLE_KINDS = new Set<SceneNode["kind"]>(["robot", "link", "mesh", "joint"]);

export default function InspectorPanel() {
  const viewer = useAppStore((s) => s.viewer);
  const setAppSelected = useAppStore((s) => s.setSelected);

  const nodes = useSceneStore((s) => s.nodes);
  const roots = useSceneStore((s) => s.roots);
  const selectedId = useSceneStore((s) => s.selectedId);
  const setSelectedId = useSceneStore((s) => s.setSelected);
  const expanded = useSceneStore((s) => s.expandedById);
  const toggleExpanded = useSceneStore((s) => s.toggleExpanded);
  const mergeExpanded = useSceneStore((s) => s.mergeExpanded);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const view = useMemo<SceneInspectorView>(() => {
    const childrenById: Record<string, string[]> = {};
    const parentById: Record<string, string | null> = {};

    const allNodes = Object.values(nodes) as SceneNode[];
    for (const n of allNodes) {
      parentById[n.id] = n.parentId;
      if (n.kind === "joint") childrenById[n.id] = [];
    }

    const getLinkName = (id: string) => {
      const node = nodes[id] as SceneNode | undefined;
      if (!node) return "";
      const urdf = node.components?.urdf;
      if (urdf?.kind === "link") return urdf.link.name || node.name || id;
      return node.name || id;
    };

    const getJointParentLinkName = (id: string) => {
      const node = nodes[id] as SceneNode | undefined;
      if (!node) return null;
      const urdf = node.components?.urdf;
      if (urdf?.kind === "joint") return urdf.joint.parent || null;
      return null;
    };

    const sortByName = (ids: string[]) =>
      ids.slice().sort((a, b) => {
        const na = (nodes[a] as SceneNode | undefined)?.name ?? a;
        const nb = (nodes[b] as SceneNode | undefined)?.name ?? b;
        return na.localeCompare(nb);
      });

    const robotNodes = allNodes.filter((n) => n.kind === "robot");
    for (const robot of robotNodes) {
      const descendantIds = collectDescendants(nodes, robot.id);

      const linkIds = descendantIds.filter((id) => (nodes[id] as SceneNode | undefined)?.kind === "link");
      if (linkIds.length === 0) continue;

      const jointIds = descendantIds.filter((id) => (nodes[id] as SceneNode | undefined)?.kind === "joint");
      const hasUrdfMetadata =
        linkIds.some((id) => (nodes[id] as SceneNode | undefined)?.components?.urdf?.kind === "link") ||
        jointIds.some((id) => (nodes[id] as SceneNode | undefined)?.components?.urdf?.kind === "joint");
      if (!hasUrdfMetadata) continue;
      const jointsByParentLink = new Map<string, string[]>();
      const linkNameSet = new Set(linkIds.map((id) => getLinkName(id)));
      for (const jointId of jointIds) {
        const parentLink = getJointParentLinkName(jointId);
        if (!parentLink || !linkNameSet.has(parentLink)) continue;
        const list = jointsByParentLink.get(parentLink) ?? [];
        list.push(jointId);
        jointsByParentLink.set(parentLink, list);
      }
      const mappedJointIds = new Set<string>();
      for (const list of jointsByParentLink.values()) {
        for (const jointId of list) mappedJointIds.add(jointId);
      }
      const unmappedJointsByParent = new Map<string, string[]>();
      for (const jointId of jointIds) {
        const parentLink = getJointParentLinkName(jointId);
        if (parentLink && linkNameSet.has(parentLink)) continue;
        const parentId = (nodes[jointId] as SceneNode | undefined)?.parentId;
        if (!parentId) continue;
        const list = unmappedJointsByParent.get(parentId) ?? [];
        list.push(jointId);
        unmappedJointsByParent.set(parentId, list);
      }

      // Preserve URDF traversal order (depth-first / branch-by-branch) by keeping the snapshot descendant order.
      // This is more intuitive than alphabetical sorting when the kinematic tree branches.
      const orderedLinks = linkIds;
      const robotDirectExtras = (robot.children ?? []).filter((cid) => {
        const kind = (nodes[cid] as SceneNode | undefined)?.kind;
        if (kind === "link") return false;
        if (kind === "joint" && mappedJointIds.has(cid)) return false;
        return true;
      });
      childrenById[robot.id] = [...orderedLinks, ...sortByName(robotDirectExtras)];
      for (const linkId of orderedLinks) {
        parentById[linkId] = robot.id;

        const linkNode = nodes[linkId] as SceneNode | undefined;
        if (!linkNode) continue;

        const directNonUrdfChildren = (linkNode.children ?? []).filter((cid) => {
          const kind = (nodes[cid] as SceneNode | undefined)?.kind;
          return kind !== "link" && kind !== "joint";
        });

        const linkName = getLinkName(linkId);
        const jointChildren = jointsByParentLink.get(linkName) ?? [];
        const fallbackJointChildren = sortByName(unmappedJointsByParent.get(linkId) ?? []);

        childrenById[linkId] = [
          ...sortByName(directNonUrdfChildren),
          ...jointChildren,
          ...fallbackJointChildren,
        ];

        for (const jid of jointChildren) {
          parentById[jid] = linkId;
          childrenById[jid] = [];
        }
        for (const jid of fallbackJointChildren) {
          childrenById[jid] = [];
        }
      }
    }

    return { childrenById, parentById };
  }, [nodes]);

  useEffect(() => {
    if (!roots.length) return;
    const patch: Record<string, boolean> = {};
    for (const r of roots) {
      if (expanded[r] === undefined) patch[r] = true;
    }
    if (!Object.keys(patch).length) return;
    mergeExpanded(patch);
  }, [expanded, mergeExpanded, roots]);

  useEffect(() => {
    if (!selectedId || !nodes[selectedId]) return;
    const nextExpanded: Record<string, boolean> = {};
    let currentId: string | null = view.parentById[selectedId] ?? null;
    while (currentId && nodes[currentId]) {
      nextExpanded[currentId] = true;
      currentId = view.parentById[currentId] ?? null;
    }
    if (!Object.keys(nextExpanded).length) return;
    mergeExpanded(nextExpanded);
  }, [mergeExpanded, nodes, selectedId, view.parentById]);

  useEffect(() => {
    if (!editingId) return;
    if (nodes[editingId]) return;
    setEditingId(null);
    setEditingName("");
  }, [editingId, nodes]);

  const hasAnyNode = useMemo(() => Object.keys(nodes).length > 0, [nodes]);
  const isValidDropTarget = (sourceId: string | null, targetId: string | null) => {
    if (!sourceId) return false;
    const doc = { scene: { nodes } };
    return validateReparentTarget(doc, sourceId, targetId).ok;
  };

  const clearSelection = () => {
    setSelectedId(null);
    viewer?.setSelected(null);
    setAppSelected(null);
  };

  const select = (id: string) => {
    const n = nodes[id];
    if (!n) {
      clearSelection();
      return;
    }
    setSelectedId(id);
    viewer?.setSelected(id);

    if (viewer && n) {
      const pos = viewer.getObjectWorldPosition?.(id);
      if (pos) {
        setAppSelected({
          id,
          name: n.name || id,
          position: pos,
        });
      } else {
        // fallback mínimo
        setAppSelected({
          id,
          name: n.name || id,
          position: { x: 0, y: 0, z: 0 },
        });
      }
    }
  };

  const startRename = (id: string) => {
    const node = nodes[id];
    if (!node || !RENAMABLE_KINDS.has(node.kind)) return;
    setEditingId(id);
    setEditingName(node.name || "");
  };

  const cancelRename = () => {
    setEditingId(null);
    setEditingName("");
  };

  const commitRename = (id: string, value: string) => {
    const node = nodes[id];
    if (!node) {
      cancelRename();
      return;
    }
    cancelRename();
    renameNode(id, value);
  };

  const renderNode = (id: string, depth: number): ReactNode => {
    const n = nodes[id];
    if (!n) return null;

    const isSelected = id === selectedId;
    const viewChildren = view.childrenById[id] ?? n.children ?? [];
    const hasChildren = viewChildren.length > 0;
    const isOpen = !!expanded[id];
    const isEditing = editingId === id;

    const canDrop = draggingId ? isValidDropTarget(draggingId, id) : false;
    const isDropTarget = dropTargetId === id;

    return (
      <div key={id}>
        <div
          onClick={() => select(id)}
          onDoubleClick={(e) => {
            e.stopPropagation();
            select(id);
            startRename(id);
          }}
          draggable={!isEditing}
          onDragStart={(e) => {
            if (isEditing) return;
            e.dataTransfer.setData("text/plain", id);
            e.dataTransfer.effectAllowed = "move";
            setDraggingId(id);
          }}
          onDragEnd={() => {
            setDraggingId(null);
            setDropTargetId(null);
          }}
          onDragOver={(e) => {
            if (!draggingId) return;
            if (!canDrop) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (dropTargetId !== id) setDropTargetId(id);
          }}
          onDragLeave={() => {
            if (dropTargetId === id) setDropTargetId(null);
          }}
          onDrop={(e) => {
            const sourceId = e.dataTransfer.getData("text/plain");
            if (!sourceId) return;
            if (!isValidDropTarget(sourceId, id)) return;
            e.preventDefault();
            e.stopPropagation();
            reparentNode(sourceId, id);
            setDropTargetId(null);
            setDraggingId(null);
          }}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            padding: "4px 8px",
            marginLeft: depth * 12,
            borderRadius: 8,
            cursor: isEditing ? "text" : "pointer",
            userSelect: "none",
            minWidth: 0,
            background: isDropTarget
              ? "rgba(80,160,255,0.22)"
              : isSelected
                ? "rgba(80,160,255,0.18)"
                : "transparent",
            border: isDropTarget
              ? "1px dashed rgba(80,160,255,0.6)"
              : isSelected
                ? "1px solid rgba(80,160,255,0.35)"
                : "1px solid transparent",
            color: "rgba(255,255,255,0.90)",
          }}
          title={`${n.kind} • ${n.name}`}
        >
          {/* caret */}
          <span
            onClick={(e) => {
              e.stopPropagation();
              if (hasChildren) toggleExpanded(id);
            }}
            style={{
              width: 14,
              display: "inline-block",
              opacity: hasChildren ? 0.9 : 0.25,
              transform: "translateY(-0.5px)",
            }}
          >
            {hasChildren ? (isOpen ? "▾" : "▸") : "•"}
          </span>

          <span style={{ opacity: 0.95 }}>{iconForKind(n.kind)} </span>

          <div
            style={{
              minWidth: 0,
              flex: 1,
              display: "flex",
              flexWrap: "wrap",
              alignItems: "baseline",
              columnGap: 6,
              rowGap: 2,
            }}
          >
            <span
              style={{
                minWidth: 0,
                whiteSpace: "normal",
                overflowWrap: "break-word",
                wordBreak: "break-word",
                lineHeight: 1.35,
                fontWeight: isSelected ? 650 : 520,
              }}
            >
              {isEditing ? (
                <input
                  autoFocus
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onBlur={(e) => commitRename(id, e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      e.stopPropagation();
                      commitRename(id, e.currentTarget.value);
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      cancelRename();
                    }
                  }}
                  style={{
                    width: "100%",
                    height: 22,
                    borderRadius: 6,
                    border: "1px solid rgba(80,160,255,0.75)",
                    background: "rgba(12,16,24,0.92)",
                    color: "rgba(255,255,255,0.94)",
                    padding: "0 6px",
                    fontSize: 12,
                  }}
                />
              ) : (
                n.name || "(unnamed)"
              )}
            </span>

            {!isEditing && (
              <span
                style={{
                  opacity: 0.48,
                  fontSize: 11,
                  lineHeight: 1.25,
                  whiteSpace: "normal",
                  overflowWrap: "break-word",
                  wordBreak: "break-word",
                }}
              >
                {n.kind}
              </span>
            )}
          </div>
        </div>

        {hasChildren && isOpen && (
          <div>
            {viewChildren.map((cid) => renderNode(cid, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      {/* mini-toolbar */}
      <div
        style={{
          padding: 10,
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          display: "flex",
          gap: 8,
          alignItems: "center",
        }}
      >
        <div style={{ opacity: 0.7, fontSize: 12 }}>
          Scene objects: {Object.keys(nodes).length}
        </div>

        <button
          onClick={clearSelection}
          style={{
            marginLeft: "auto",
            minHeight: 26,
            padding: "0 10px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.10)",
            background: "rgba(255,255,255,0.08)",
            color: "rgba(255,255,255,0.92)",
            cursor: "pointer",
            whiteSpace: "normal",
            lineHeight: 1.2,
          }}
          title="Clear selection"
        >
          Clear
        </button>
      </div>

      {/* tree */}
      <div
        style={{ padding: 12, overflow: "auto", flex: 1, minHeight: 0 }}
        onClick={(e) => {
          if (e.target === e.currentTarget) clearSelection();
        }}
        onDragOver={(e) => {
          if (!draggingId) return;
          if (!isValidDropTarget(draggingId, null)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (dropTargetId) setDropTargetId(null);
        }}
        onDrop={(e) => {
          const sourceId = e.dataTransfer.getData("text/plain");
          if (!sourceId) return;
          if (!isValidDropTarget(sourceId, null)) return;
          e.preventDefault();
          reparentNode(sourceId, null);
          setDropTargetId(null);
          setDraggingId(null);
        }}
      >
        {!hasAnyNode ? (
          <div style={{ opacity: 0.6, fontSize: 13, lineHeight: 1.6 }}>
            <div>(empty scene)</div>
            <div style={{ marginTop: 8, opacity: 0.7 }}>
              Import a URDF (or other asset) to populate the scene.
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            {roots.map((r) => renderNode(r, 0))}
          </div>
        )}
      </div>
    </div>
  );
}
