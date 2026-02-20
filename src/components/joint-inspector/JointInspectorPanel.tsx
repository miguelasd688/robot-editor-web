import { useMemo, type CSSProperties } from "react";
import { useAppStore } from "../../app/core/store/useAppStore";
import { useSceneStore } from "../../app/core/store/useSceneStore";
import { useAssetInstanceStore } from "../../app/core/store/useAssetInstanceStore";
import type { UrdfJoint } from "../../app/core/urdf/urdfModel";
import { formatSignificant } from "../../app/ui/numberFormat";

const readOnlyInput: CSSProperties = {
  width: "100%",
  height: 28,
  borderRadius: 6,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(255,255,255,0.06)",
  color: "rgba(255,255,255,0.9)",
  padding: "0 8px",
  fontSize: 12,
};

type JointValue = { value: number; source: "urdf" | "default" };

const resolveValue = (raw: number | undefined, fallback: number): JointValue => {
  if (Number.isFinite(raw)) return { value: Number(raw), source: "urdf" };
  return { value: fallback, source: "default" };
};

export default function JointInspectorPanel() {
  const viewer = useAppStore((s) => s.viewer);
  const setAppSelected = useAppStore((s) => s.setSelected);
  const selectedId = useSceneStore((s) => s.selectedId);
  const setSceneSelected = useSceneStore((s) => s.setSelected);
  const nodes = useSceneStore((s) => s.nodes);
  const roots = useSceneStore((s) => s.roots);
  const instances = useAssetInstanceStore((s) => s.instances);

  const joint = useMemo<UrdfJoint | null>(() => {
    if (!selectedId) return null;
    const instance = instances[selectedId];
    if (!instance?.urdf || instance.urdf.kind !== "joint") return null;
    return instance.urdf.joint;
  }, [instances, selectedId]);

  const defaults = {
    damping: Number(import.meta.env.VITE_URDF_DEFAULT_DAMPING ?? "0.05"),
    friction: Number(import.meta.env.VITE_URDF_DEFAULT_FRICTION ?? "0.01"),
    armature: Number(import.meta.env.VITE_URDF_DEFAULT_ARMATURE ?? "0"),
  };

  const activeRootId = useMemo(() => {
    if (selectedId && nodes[selectedId]) {
      let currentId: string | null = selectedId;
      let parentId = nodes[selectedId].parentId;
      while (parentId && nodes[parentId]) {
        currentId = parentId;
        parentId = nodes[parentId].parentId;
      }
      return currentId;
    }
    if (roots.length === 1) return roots[0];
    return null;
  }, [nodes, roots, selectedId]);

  const jointOptions = useMemo(() => {
    if (!activeRootId) return [];
    const stack = [activeRootId];
    const results: Array<{ id: string; name: string }> = [];
    while (stack.length) {
      const id = stack.pop() as string;
      const node = nodes[id];
      if (!node) continue;
      if (node.kind === "joint") {
        const instance = instances[id];
        const name =
          instance?.urdf?.kind === "joint"
            ? instance.urdf.joint.name
            : node.name || id;
        results.push({ id, name });
      }
      for (const child of node.children ?? []) stack.push(child);
    }
    return results.sort((a, b) => a.name.localeCompare(b.name));
  }, [activeRootId, instances, nodes]);

  const handleSelect = (id: string) => {
    setSceneSelected(id);
    viewer?.setSelected?.(id);
    const node = nodes[id];
    const pos = viewer?.getObjectWorldPosition?.(id);
    if (node && pos) {
      setAppSelected({ id, name: node.name || id, position: pos });
    } else if (node) {
      setAppSelected({ id, name: node.name || id, position: { x: 0, y: 0, z: 0 } });
    }
  };

  const damping = resolveValue(joint?.dynamics?.damping, defaults.damping);
  const friction = resolveValue(joint?.dynamics?.friction, defaults.friction);
  const armature = resolveValue(undefined, defaults.armature);

  const renderRow = (label: string, data: JointValue) => (
    <div style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 8, alignItems: "center" }}>
      <div style={{ fontSize: 12, opacity: 0.75 }}>{label}</div>
      <div style={{ display: "grid", gap: 4 }}>
        <input type="text" readOnly value={formatSignificant(data.value)} style={readOnlyInput} />
        <div style={{ fontSize: 10, opacity: 0.5 }}>
          {data.source === "urdf" ? "URDF override" : "default"}
        </div>
      </div>
    </div>
  );

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 12, padding: 12 }}>
      <div>
        <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6, textTransform: "uppercase" }}>
          Joints
        </div>
        {!activeRootId && (
          <div style={{ fontSize: 12, opacity: 0.6 }}>
            Select a model in the Scene panel to list its joints.
          </div>
        )}
        {activeRootId && jointOptions.length === 0 && (
          <div style={{ fontSize: 12, opacity: 0.6 }}>
            No joints found in the selected model.
          </div>
        )}
        {activeRootId && jointOptions.length > 0 && (
          <div style={{ display: "grid", gap: 6 }}>
            {jointOptions.map((opt) => {
              const isActive = opt.id === selectedId;
              return (
                <button
                  key={opt.id}
                  onClick={() => handleSelect(opt.id)}
                  style={{
                    height: 28,
                    padding: "0 10px",
                    borderRadius: 8,
                    border: isActive ? "1px solid rgba(80,160,255,0.45)" : "1px solid rgba(255,255,255,0.10)",
                    background: isActive ? "rgba(80,160,255,0.16)" : "rgba(255,255,255,0.06)",
                    color: "rgba(255,255,255,0.92)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 12,
                  }}
                >
                  {opt.name}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {!joint && (
        <div style={{ fontSize: 12, opacity: 0.6 }}>
          Select a joint from the list to inspect its parameters.
        </div>
      )}

      {joint && (
        <>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{joint.name}</div>
          <div style={{ fontSize: 11, opacity: 0.6 }}>
            Joint parameters (read-only for now). Future edits will write back to URDF.
          </div>

          <div style={{ display: "grid", gap: 10 }}>
            {renderRow("Damping", damping)}
            {renderRow("Friction", friction)}
            {renderRow("Armature", armature)}
          </div>
        </>
      )}
    </div>
  );
}
