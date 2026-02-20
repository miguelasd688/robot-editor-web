import React, { useCallback, useEffect, useState } from "react";
import type { TreeNode } from "../model/tree";
import { dirAncestors } from "../model/tree";
import { Row } from "./Row";
import { isURDF } from "../model/fileTypes";
import { MJCF_VIRTUAL_KEY, MJCF_VIRTUAL_LABEL } from "../../../app/core/physics/mujoco/mjcfVirtual";

export function TreeView(props: {
  tree: TreeNode;
  urdfKey: string | null;
  setURDF: (k: string) => void;
  activeFile?: string | null;
  onOpenFile?: (path: string) => void;
}) {
  const { tree, urdfKey, setURDF, activeFile, onOpenFile } = props;

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!urdfKey) return;
    const dirs = dirAncestors(urdfKey);
    if (dirs.length === 0) return;
    setExpanded((prev) => {
      const next = { ...prev };
      for (const d of dirs) next[d] = true;
      return next;
    });
  }, [urdfKey]);

  const toggleDir = useCallback((path: string) => {
    setExpanded((prev) => ({ ...prev, [path]: !prev[path] }));
  }, []);

  const renderNode = useCallback(
    (node: TreeNode, depth: number): React.ReactNode => {
      if (node.kind === "dir") {
        if (node.path === "") {
          return node.children.map((c) => renderNode(c, 0));
        }

        const isOpen = !!expanded[node.path];
        return (
          <div key={node.path}>
            <Row indent={depth} onClick={() => toggleDir(node.path)} title={node.path} bold>
              <span style={{ width: 14, display: "inline-block", opacity: 0.85 }}>
                {isOpen ? "▾" : "▸"}
              </span>
              <span style={{ opacity: 0.95 }}>📁 {node.name}</span>
            </Row>

            {isOpen && node.children.map((c) => renderNode(c, depth + 1))}
          </div>
        );
      }

      const active = node.path === urdfKey || (!!activeFile && node.path === activeFile);
      const selectable = isURDF(node.path);

      const onClick = selectable || onOpenFile
        ? () => {
            if (selectable) setURDF(node.path);
            if (onOpenFile) onOpenFile(node.path);
          }
        : undefined;

      return (
        <div key={node.path}>
          <Row
            indent={depth}
            active={active}
            onClick={onClick}
            title={node.path}
          >
            <span style={{ width: 14, display: "inline-block", opacity: 0.0 }}>•</span>
            <span style={{ opacity: selectable ? 1 : 0.75 }}>
              📄 {node.name}
              {node.path === MJCF_VIRTUAL_KEY && (
                <span style={{ marginLeft: 8, opacity: 0.6, fontSize: 12 }}>{MJCF_VIRTUAL_LABEL}</span>
              )}
              {selectable && node.path === urdfKey && (
                <span style={{ marginLeft: 10, opacity: 0.55, fontSize: 12 }}>selected</span>
              )}
            </span>
          </Row>
        </div>
      );
    },
    [expanded, setURDF, toggleDir, urdfKey, activeFile, onOpenFile]
  );

  return <div style={{ fontSize: 13, lineHeight: 1.8 }}>{renderNode(tree, 0)}</div>;
}
