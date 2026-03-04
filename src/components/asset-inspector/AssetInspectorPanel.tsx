import { useEffect, useMemo, type CSSProperties } from "react";
import { useAppStore } from "../../app/core/store/useAppStore";
import { useSceneStore } from "../../app/core/store/useSceneStore";
import { useAssetInstanceStore } from "../../app/core/store/useAssetInstanceStore";
import { useMujocoStore } from "../../app/core/store/useMujocoStore";
import type { SceneNode, RgbaColor } from "../../app/core/editor/document/types";
import type { UrdfInstance, UrdfJoint, UrdfLink } from "../../app/core/urdf/urdfModel";
import { reparentNode } from "../../app/core/editor/actions/sceneHierarchyActions";
import { editorEngine } from "../../app/core/editor/engineSingleton";
import { DarkSelect } from "../../app/ui/DarkSelect";
import {
  findJointChildLinkId,
  findJointParentLinkId,
  resolveLinkLabel,
} from "../../app/core/editor/kinematics/jointKinematics";

type Vec3 = { x: number; y: number; z: number };
type InertiaKey = keyof NonNullable<UrdfLink["inertial"]>["inertia"];

const inputStyle: CSSProperties = {
  width: 64,
  height: 26,
  borderRadius: 6,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(255,255,255,0.06)",
  color: "rgba(255,255,255,0.9)",
  padding: "0 6px",
  fontSize: 12,
};

const inputWideStyle: CSSProperties = {
  ...inputStyle,
  width: "100%",
};

const jointAxisPresets = [
  { axis: "x", label: "X", color: "#ff4a4a", value: [1, 0, 0] as const },
  { axis: "y", label: "Y", color: "#4ad16b", value: [0, 1, 0] as const },
  { axis: "z", label: "Z", color: "#4a6bff", value: [0, 0, 1] as const },
] as const;

const JOINT_AXIS_PRESET_EPSILON = 1e-6;

function clampNumber(value: string) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function rgbaToHex(rgba: RgbaColor): string {
  const r = Math.round(Math.min(1, Math.max(0, rgba[0])) * 255).toString(16).padStart(2, "0");
  const g = Math.round(Math.min(1, Math.max(0, rgba[1])) * 255).toString(16).padStart(2, "0");
  const b = Math.round(Math.min(1, Math.max(0, rgba[2])) * 255).toString(16).padStart(2, "0");
  return `#${r}${g}${b}`;
}

function hexToRgba(hex: string, alpha: number): RgbaColor {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return [r, g, b, Math.min(1, Math.max(0, alpha))];
}

function findRobotAncestorId(nodes: Record<string, SceneNode>, startId: string | null | undefined): string | null {
  let cur = startId ?? null;
  while (cur) {
    const node = nodes[cur];
    if (!node) return null;
    if (node.kind === "robot") return cur;
    cur = node.parentId;
  }
  return null;
}

export default function AssetInspectorPanel() {
  const viewer = useAppStore((s) => s.viewer);
  const setAppSelected = useAppStore((s) => s.setSelected);
  const selectedId = useSceneStore((s) => s.selectedId);
  const setSceneSelected = useSceneStore((s) => s.setSelected);
  const nodes = useSceneStore((s) => s.nodes);
  const instances = useAssetInstanceStore((s) => s.instances);
  const updateTransform = useAssetInstanceStore((s) => s.updateTransform);
  const updatePhysics = useAssetInstanceStore((s) => s.updatePhysics);
  const updateUrdf = useAssetInstanceStore((s) => s.updateUrdf);
  const markSceneDirty = useMujocoStore((s) => s.markSceneDirty);

  const instance = useMemo(() => (selectedId ? instances[selectedId] : null), [instances, selectedId]);
  const jointParentId = useMemo(() => {
    if (!instance || instance.kind !== "link") return null;
    const node = nodes[instance.id];
    if (!node?.parentId) return null;
    return nodes[node.parentId]?.kind === "joint" ? node.parentId : null;
  }, [instance, nodes]);
  const scaleTargetId = useMemo(() => {
    if (!instance || instance.kind !== "link") return null;
    const node = nodes[instance.id];
    if (!node) return null;
    const inJointChain =
      jointParentId !== null || node.children.some((childId) => nodes[childId]?.kind === "joint");
    if (!inJointChain) return null;
    const visualChildren = node.children
      .map((childId) => nodes[childId])
      .filter((child): child is SceneNode => !!child && child.kind === "visual");
    if (visualChildren.length) {
      const withSync = visualChildren.find((child) => child.components?.visual?.attachCollisions);
      return (withSync ?? visualChildren[0]).id;
    }
    const meshChild = node.children
      .map((childId) => nodes[childId])
      .find((child) => child?.kind === "mesh");
    return meshChild?.id ?? null;
  }, [instance, nodes, jointParentId]);
  const scaleTarget = useMemo(() => (scaleTargetId ? instances[scaleTargetId] ?? null : null), [instances, scaleTargetId]);
  const linkVisualChildren = useMemo(() => {
    if (!instance || instance.kind !== "link") return [];
    const node = nodes[instance.id];
    if (!node) return [];
    return node.children
      .map((childId) => nodes[childId])
      .filter((child): child is SceneNode => !!child && child.kind === "visual");
  }, [instance, nodes]);
  const linkCollisionSyncEnabled = useMemo(
    () => linkVisualChildren.some((visual) => visual.components?.visual?.attachCollisions === true),
    [linkVisualChildren]
  );

  useEffect(() => {
    if (!viewer || !selectedId) return;
    if (!instances[selectedId]) {
      useAssetInstanceStore.getState().syncFromViewer();
    }
  }, [viewer, selectedId, instances]);

  const fields = instance?.fields ?? {};
  const physicsEligible =
    instance?.kind !== "joint" &&
    instance?.kind !== "light" &&
    instance?.kind !== "camera" &&
    instance?.kind !== "visual" &&
    instance?.kind !== "collision";
  const hasPhysicsFields = Object.values(fields).some(Boolean) || !!instance?.physics.useDensity;
  const showPhysics = !!instance && physicsEligible && hasPhysicsFields;
  const showMass = showPhysics && (!!fields.mass || !!instance?.physics.useDensity);
  const showDensity = showPhysics && (!!fields.density || !!instance?.physics.useDensity);
  const showUseDensity = showPhysics && (!!fields.useDensity || !!instance?.physics.useDensity);
  const showInertia = showPhysics && !!fields.inertia;
  const showFriction = showPhysics && (!!fields.friction || instance?.kind === "link");
  const showRestitution = showPhysics && (!!fields.restitution || instance?.kind === "link");
  const showFixed = showPhysics && (!!fields.fixed || instance?.kind === "link");
  const showCollisions = showPhysics && (!!fields.collisionsEnabled || instance?.kind === "link");
  const urdf = instance?.urdf;
  const jointActuatorEnabled = urdf?.kind === "joint" ? urdf.joint.actuator?.enabled !== false : false;
  const jointActuatorType =
    urdf?.kind === "joint"
      ? (urdf.joint.actuator?.type ?? "position")
      : ("position" as "position" | "velocity" | "torque" | "muscle");
  const actuatorDefaults = {
    stiffness: Number(import.meta.env.VITE_URDF_ACTUATOR_STIFFNESS ?? "120"),
    damping: Number(import.meta.env.VITE_URDF_ACTUATOR_DAMPING ?? "4"),
    initialPosition: 0,
  } as const;
  const muscleDefaults = {
    range: [0, 1] as [number, number],
    force: 1,
    scale: 1,
    damping: 0,
    showLine: true,
    showTube: false,
  } as const;
  const dynamicsDefaults = {
    damping: Number(import.meta.env.VITE_URDF_DEFAULT_DAMPING ?? "0.05"),
    friction: Number(import.meta.env.VITE_URDF_DEFAULT_FRICTION ?? "0.01"),
    armature: Number(import.meta.env.VITE_URDF_DEFAULT_ARMATURE ?? "0.01"),
  } as const;
  const limitDefaults = {
    effort: Number(import.meta.env.VITE_URDF_DEFAULT_EFFORT ?? "60"),
    velocity: Number(import.meta.env.VITE_URDF_DEFAULT_VELOCITY ?? "100"),
    revoluteRange: 180,
    prismaticRange: 1,
  } as const;

  const axisPatch = (axis: "x" | "y" | "z", value: number): Partial<Vec3> =>
    ({ [axis]: value } as Partial<Vec3>);

  const updateVec = (
    field: "position" | "rotation" | "scale",
    axis: "x" | "y" | "z",
    value: number,
    targetId?: string
  ) => {
    if (!instance) return;
    const patch =
      field === "position"
        ? { position: axisPatch(axis, value) }
        : field === "rotation"
          ? { rotation: axisPatch(axis, value) }
          : { scale: axisPatch(axis, value) };
    markSceneDirty();
    updateTransform(targetId ?? instance.id, patch);
  };

  const updateInertia = (key: InertiaKey, value: number) => {
    if (!instance) return;
    const current = instance.physics.inertiaTensor ?? {
      ixx: instance.physics.inertia.x,
      iyy: instance.physics.inertia.y,
      izz: instance.physics.inertia.z,
      ixy: 0,
      ixz: 0,
      iyz: 0,
    };
    const nextTensor = { ...current, [key]: value };
    const nextInertia = { x: nextTensor.ixx, y: nextTensor.iyy, z: nextTensor.izz };
    updatePhysics(instance.id, { inertia: nextInertia, inertiaTensor: nextTensor });
    markSceneDirty();
  };

  const updateUrdfInstance = (next: UrdfInstance) => {
    if (!instance) return;
    updateUrdf(instance.id, next);
    markSceneDirty();
  };

  const updateLink = (mutate: (link: UrdfLink) => UrdfLink) => {
    if (!instance || !instance.urdf || instance.urdf.kind !== "link") return;
    updateUrdfInstance({ kind: "link", link: mutate(instance.urdf.link) });
  };

  const updateJoint = (mutate: (joint: UrdfJoint) => UrdfJoint) => {
    if (!instance || !instance.urdf || instance.urdf.kind !== "joint") return;
    updateUrdfInstance({ kind: "joint", joint: mutate(instance.urdf.joint) });
  };

  const resolveJointLabel = (node: SceneNode) => {
    const nodeUrdf = node.components?.urdf;
    if (nodeUrdf?.kind === "joint") return nodeUrdf.joint.name || node.name || node.id;
    return node.name || node.id;
  };

  const selectedRobotId = useMemo(() => {
    if (!instance) return null;
    return findRobotAncestorId(nodes, instance.id);
  }, [instance, nodes]);

  const linkOptions = useMemo(() => {
    const list = Object.values(nodes)
      .filter(
        (node) =>
          node.kind === "link" &&
          findRobotAncestorId(nodes, node.id) === selectedRobotId
      )
      .map((node) => ({ id: node.id, name: resolveLinkLabel(node) }));
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }, [nodes, selectedRobotId]);

  const selectableObjectOptions = useMemo(() => {
    if (!instance || !selectedRobotId) return [];
    if (instance.kind !== "link" && instance.kind !== "joint") return [];
    const resolveLabel = instance.kind === "link" ? resolveLinkLabel : resolveJointLabel;
    const list = Object.values(nodes)
      .filter(
        (node) =>
          node.kind === instance.kind &&
          findRobotAncestorId(nodes, node.id) === selectedRobotId
      )
      .map((node) => ({ id: node.id, name: resolveLabel(node) }));
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }, [instance, nodes, selectedRobotId]);

  const handleSelectableObjectChange = (value: string) => {
    if (!instance || !value || value === instance.id) return;
    const nextNode = nodes[value];
    if (!nextNode || nextNode.kind !== instance.kind) return;
    if (selectedRobotId && findRobotAncestorId(nodes, value) !== selectedRobotId) return;

    setSceneSelected(value);
    viewer?.setSelected(value);
    const worldPosition = viewer?.getObjectWorldPosition?.(value);
    setAppSelected({
      id: value,
      name: nextNode.name || value,
      position: worldPosition ?? { x: 0, y: 0, z: 0 },
    });
  };

  const jointContext = useMemo(() => {
    if (!instance || !instance.urdf || instance.urdf.kind !== "joint") return null;
    const node = nodes[instance.id];
    if (!node) return null;
    const resolveByName = (name: string) =>
      linkOptions.find((candidate) => candidate.name === name)?.id ?? null;
    const parentLinkId = findJointParentLinkId(nodes, instance.id) ?? resolveByName(instance.urdf.joint.parent);
    const childLinkId = findJointChildLinkId(nodes, instance.id) ?? resolveByName(instance.urdf.joint.child);
    const parentName = parentLinkId ? resolveLinkLabel(nodes[parentLinkId]) : instance.urdf.joint.parent;
    const childName = childLinkId ? resolveLinkLabel(nodes[childLinkId]) : instance.urdf.joint.child;
    return { parentLinkId, childLinkId, parentName, childName };
  }, [instance, linkOptions, nodes]);

  useEffect(() => {
    if (!instance || !instance.urdf || instance.urdf.kind !== "joint") return;
    const joint = instance.urdf.joint;
    let changed = false;
    let next = joint;

    const supportsActuator = joint.type !== "fixed" && joint.type !== "floating";

    if (joint.type !== "fixed" && joint.type !== "floating") {
      const dynamics = joint.dynamics ?? {};
      const nextDynamics = { ...dynamics };
      let changedDynamics = false;
      if (!Number.isFinite(dynamics.damping)) {
        nextDynamics.damping = dynamicsDefaults.damping;
        changedDynamics = true;
      }
      if (!Number.isFinite(dynamics.friction)) {
        nextDynamics.friction = dynamicsDefaults.friction;
        changedDynamics = true;
      }
      if (!Number.isFinite(dynamics.armature)) {
        nextDynamics.armature = dynamicsDefaults.armature;
        changedDynamics = true;
      }
      if (changedDynamics) {
        next = { ...next, dynamics: nextDynamics };
        changed = true;
      }
    }

    if (joint.type === "revolute" || joint.type === "prismatic" || joint.type === "planar") {
      const limit = joint.limit ?? {};
      const nextLimit = { ...limit };
      const range =
        joint.type === "prismatic" || joint.type === "planar"
          ? limitDefaults.prismaticRange
          : limitDefaults.revoluteRange;
      let changedLimit = false;
      if (!Number.isFinite(limit.lower)) {
        nextLimit.lower = -range;
        changedLimit = true;
      }
      if (!Number.isFinite(limit.upper)) {
        nextLimit.upper = range;
        changedLimit = true;
      }
      if (!Number.isFinite(limit.effort)) {
        nextLimit.effort = limitDefaults.effort;
        changedLimit = true;
      }
      if (!Number.isFinite(limit.velocity)) {
        nextLimit.velocity = limitDefaults.velocity;
        changedLimit = true;
      }
      if (changedLimit) {
        next = { ...next, limit: nextLimit };
        changed = true;
      }
    }

    if (supportsActuator) {
      const actuator = joint.actuator ?? {};
      const nextActuator = { ...actuator };
      let changedActuator = false;
      if (!Number.isFinite(actuator.stiffness)) {
        nextActuator.stiffness = actuatorDefaults.stiffness;
        changedActuator = true;
      }
      if (!Number.isFinite(actuator.damping)) {
        nextActuator.damping = actuatorDefaults.damping;
        changedActuator = true;
      }
      if (changedActuator) {
        next = { ...next, actuator: nextActuator };
        changed = true;
      }
      if ((nextActuator.type ?? joint.actuator?.type ?? "position") === "muscle") {
        const muscle = next.muscle ?? joint.muscle;
        const frame0Pos =
          joint.sourceFrames?.frame0Local?.position ?? ([0, 0, 0] as [number, number, number]);
        const frame1Pos =
          joint.sourceFrames?.frame1Local?.position ?? ([0, 0, 0] as [number, number, number]);
        const endA = muscle?.endA ?? {
          body: joint.parent,
          localPos: [frame0Pos[0], frame0Pos[1], frame0Pos[2]] as [number, number, number],
        };
        const endB = muscle?.endB ?? {
          body: joint.child,
          localPos: [frame1Pos[0], frame1Pos[1], frame1Pos[2]] as [number, number, number],
        };
        const nextMuscle = {
          enabled: muscle?.enabled ?? false,
          endA: {
            body: endA.body || joint.parent,
            localPos: [endA.localPos[0], endA.localPos[1], endA.localPos[2]] as [number, number, number],
          },
          endB: {
            body: endB.body || joint.child,
            localPos: [endB.localPos[0], endB.localPos[1], endB.localPos[2]] as [number, number, number],
          },
          range: muscle?.range ? ([...muscle.range] as [number, number]) : ([...muscleDefaults.range] as [number, number]),
          force: Number.isFinite(muscle?.force) ? muscle?.force : muscleDefaults.force,
          scale: Number.isFinite(muscle?.scale) ? muscle?.scale : muscleDefaults.scale,
          damping: Number.isFinite(muscle?.damping) ? muscle?.damping : muscleDefaults.damping,
          showLine: muscle?.showLine ?? muscleDefaults.showLine,
          showTube: muscle?.showTube ?? muscleDefaults.showTube,
        };
        if (!joint.muscle) {
          next = { ...next, muscle: nextMuscle };
          changed = true;
        }
      }
    }

    if (changed) {
      updateUrdfInstance({ kind: "joint", joint: next });
    }
  }, [instance, actuatorDefaults, dynamicsDefaults, limitDefaults, muscleDefaults]);

  const updateVecArray = (value: [number, number, number], index: number, nextValue: number) => {
    const next = [...value] as [number, number, number];
    next[index] = nextValue;
    return next;
  };

  const parseOptionalNumber = (value: string) => (value === "" ? undefined : clampNumber(value));

  const renderVecRow = (
    label: string,
    value: [number, number, number],
    onChange: (next: [number, number, number]) => void,
    step = 0.01
  ) => (
    <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 8, marginBottom: 8 }}>
      <div style={{ fontSize: 12, opacity: 0.75 }}>{label}</div>
      <div style={{ display: "flex", gap: 6 }}>
        {(["x", "y", "z"] as const).map((axis, index) => (
          <input
            key={axis}
            type="number"
            step={step}
            value={value[index]}
            onChange={(e) => onChange(updateVecArray(value, index, clampNumber(e.target.value)))}
            style={inputStyle}
          />
        ))}
      </div>
    </div>
  );

  const renderJointAxisRow = (
    label: string,
    value: [number, number, number],
    onChange: (next: [number, number, number]) => void,
    step = 0.01
  ) => (
    <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 8, marginBottom: 8 }}>
      <div style={{ fontSize: 12, opacity: 0.75 }}>{label}</div>
      <div style={{ display: "grid", gap: 6 }}>
        <div style={{ display: "flex", gap: 6 }}>
          {jointAxisPresets.map((preset) => {
            const isActive = value.every(
              (component, index) => Math.abs(component - preset.value[index]) <= JOINT_AXIS_PRESET_EPSILON
            );
            return (
              <button
                key={preset.axis}
                type="button"
                onClick={() => onChange([preset.value[0], preset.value[1], preset.value[2]])}
                style={{
                  height: 26,
                  minWidth: 56,
                  borderRadius: 6,
                  border: isActive ? `1px solid ${preset.color}` : "1px solid rgba(255,255,255,0.12)",
                  background: isActive ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.08)",
                  color: "rgba(255,255,255,0.95)",
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: 600,
                  padding: "0 8px",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                }}
                aria-label={`Set ${label} to ${preset.label} axis`}
              >
                <span>{preset.label}</span>
                <span
                  aria-hidden
                  style={{
                    width: 14,
                    height: 2,
                    borderRadius: 999,
                    background: preset.color,
                  }}
                />
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {(["x", "y", "z"] as const).map((axis, index) => (
            <input
              key={axis}
              type="number"
              step={step}
              value={value[index]}
              onChange={(e) => onChange(updateVecArray(value, index, clampNumber(e.target.value)))}
              style={inputStyle}
            />
          ))}
        </div>
      </div>
    </div>
  );

  const renderInertiaMatrix = (inertia: NonNullable<UrdfLink["inertial"]>["inertia"], onChange: (key: InertiaKey, value: number) => void) => {
    const cells: Array<{ label: InertiaKey; value: number } | null> = [
      { label: "ixx", value: inertia.ixx },
      { label: "ixy", value: inertia.ixy },
      { label: "ixz", value: inertia.ixz },
      null,
      { label: "iyy", value: inertia.iyy },
      { label: "iyz", value: inertia.iyz },
      null,
      null,
      { label: "izz", value: inertia.izz },
    ];

    return (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6 }}>
        {cells.map((cell, index) => {
          if (!cell) return <div key={`empty-${index}`} />;
          return (
            <div key={cell.label} style={{ display: "grid", gap: 4 }}>
              <div style={{ fontSize: 10, opacity: 0.6 }}>{cell.label}</div>
              <input
                type="number"
                step={0.001}
                value={cell.value}
                onChange={(e) => onChange(cell.label, clampNumber(e.target.value))}
                style={inputWideStyle}
              />
            </div>
          );
        })}
      </div>
    );
  };

  const renderPoseEditor = (
    pose: { xyz: [number, number, number]; rpy: [number, number, number] },
    onChange: (next: { xyz: [number, number, number]; rpy: [number, number, number] }) => void
  ) => (
    <div style={{ display: "grid", gap: 4, marginBottom: 8 }}>
      {renderVecRow("xyz", pose.xyz, (next) => onChange({ ...pose, xyz: next }), 0.01)}
      {renderVecRow("rpy", pose.rpy, (next) => onChange({ ...pose, rpy: next }), 0.01)}
    </div>
  );

  const renderGeomEditor = (
    geom: UrdfLink["collisions"][number]["geom"],
    onChange: (next: UrdfLink["collisions"][number]["geom"]) => void
  ) => {
    if (geom.kind === "box") {
      return renderVecRow("size", geom.size, (next) => onChange({ ...geom, size: next }), 0.01);
    }
    if (geom.kind === "sphere") {
      return (
        <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 8, marginBottom: 8 }}>
          <div style={{ fontSize: 12, opacity: 0.75 }}>radius</div>
          <input
            type="number"
            step={0.01}
            value={geom.radius}
            onChange={(e) => onChange({ ...geom, radius: clampNumber(e.target.value) })}
            style={inputStyle}
          />
        </div>
      );
    }
    if (geom.kind === "cylinder") {
      return (
        <div style={{ display: "grid", gap: 8, marginBottom: 8 }}>
          <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 8 }}>
            <div style={{ fontSize: 12, opacity: 0.75 }}>radius</div>
            <input
              type="number"
              step={0.01}
              value={geom.radius}
              onChange={(e) => onChange({ ...geom, radius: clampNumber(e.target.value) })}
              style={inputStyle}
            />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 8 }}>
            <div style={{ fontSize: 12, opacity: 0.75 }}>length</div>
            <input
              type="number"
              step={0.01}
              value={geom.length}
              onChange={(e) => onChange({ ...geom, length: clampNumber(e.target.value) })}
              style={inputStyle}
            />
          </div>
        </div>
      );
    }
    return (
      <div style={{ display: "grid", gap: 8, marginBottom: 8 }}>
        <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 8 }}>
          <div style={{ fontSize: 12, opacity: 0.75 }}>mesh</div>
          <input
            type="text"
            value={geom.file}
            onChange={(e) => onChange({ ...geom, file: e.target.value })}
            style={inputWideStyle}
          />
        </div>
        {renderVecRow("scale", geom.scale, (next) => onChange({ ...geom, scale: next }), 0.01)}
      </div>
    );
  };

  const updateLinkCollision = (
    index: number,
    mutate: (item: UrdfLink["collisions"][number]) => UrdfLink["collisions"][number]
  ) => {
    updateLink((link) => ({
      ...link,
      collisions: link.collisions.map((item, i) => (i === index ? mutate(item) : item)),
    }));
  };

  const updateLinkVisual = (
    index: number,
    mutate: (item: UrdfLink["visuals"][number]) => UrdfLink["visuals"][number]
  ) => {
    updateLink((link) => ({
      ...link,
      visuals: link.visuals.map((item, i) => (i === index ? mutate(item) : item)),
    }));
  };

  const updateJointLimitField = (field: keyof NonNullable<UrdfJoint["limit"]>, value: number | undefined) => {
    updateJoint((joint) => {
      const next = { ...(joint.limit ?? {}) };
      if (value === undefined) {
        delete next[field];
      } else {
        next[field] = value;
      }
      const hasAny = Object.values(next).some((v) => v !== undefined);
      return { ...joint, limit: hasAny ? next : undefined };
    });
  };

  const updateJointDynamicsField = (field: keyof NonNullable<UrdfJoint["dynamics"]>, value: number | undefined) => {
    updateJoint((joint) => {
      const next = { ...(joint.dynamics ?? {}) };
      if (value === undefined) {
        delete next[field];
      } else {
        next[field] = value;
      }
      const hasAny = Object.values(next).some((v) => v !== undefined);
      return { ...joint, dynamics: hasAny ? next : undefined };
    });
  };

  type JointActuatorNumericField = "stiffness" | "damping" | "initialPosition";

  const updateJointActuatorField = (field: JointActuatorNumericField, value: number | undefined) => {
    updateJoint((joint) => {
      const next = { ...(joint.actuator ?? {}) };
      if (value === undefined) {
        delete next[field];
      } else {
        next[field] = value;
      }
      const hasAny = Object.values(next).some((v) => v !== undefined);
      return { ...joint, actuator: hasAny ? next : undefined };
    });
  };

  const updateJointMuscle = (
    mutate: (muscle: NonNullable<UrdfJoint["muscle"]>, joint: UrdfJoint) => NonNullable<UrdfJoint["muscle"]>
  ) => {
    updateJoint((joint) => {
      const parentBody = joint.parent || "";
      const childBody = joint.child || "";
      const base = joint.muscle ?? {
        enabled: false,
        endA: { body: parentBody, localPos: [0, 0, 0] as [number, number, number] },
        endB: { body: childBody, localPos: [0, 0, 0] as [number, number, number] },
        range: [...muscleDefaults.range] as [number, number],
        force: muscleDefaults.force,
        scale: muscleDefaults.scale,
        damping: muscleDefaults.damping,
        showLine: muscleDefaults.showLine,
        showTube: muscleDefaults.showTube,
      };
      return { ...joint, muscle: mutate(base, joint) };
    });
  };

  const handleJointChildChange = (value: string) => {
    if (!instance || !instance.urdf || instance.urdf.kind !== "joint") return;
    if (!value) {
      updateJoint((joint) => ({ ...joint, child: "" }));
      return;
    }
    const nextNode = nodes[value];
    if (!nextNode || nextNode.kind !== "link") return;
    if (findRobotAncestorId(nodes, nextNode.id) !== selectedRobotId) return;
    const parentLinkId = jointContext?.parentLinkId ?? null;
    let nextOrigin = instance.urdf.joint.origin;
    if (nextNode.parentId !== instance.id) {
      const reparented = reparentNode(value, instance.id);
      if (!reparented) return;
      const refreshedDoc = editorEngine.getDoc();
      const refreshedJoint = refreshedDoc.scene.nodes[instance.id];
      const refreshedUrdf = refreshedJoint?.components?.urdf;
      if (refreshedUrdf?.kind === "joint") {
        nextOrigin = refreshedUrdf.joint.origin;
      }
    }
    const parentName =
      parentLinkId && nodes[parentLinkId]
        ? resolveLinkLabel(nodes[parentLinkId])
        : instance.urdf.joint.parent;
    const nextJoint: UrdfJoint = {
      ...instance.urdf.joint,
      parent: parentName ?? instance.urdf.joint.parent,
      child: resolveLinkLabel(nextNode),
      origin: nextOrigin,
      muscle: instance.urdf.joint.muscle
        ? {
            ...instance.urdf.joint.muscle,
            endA: {
              ...instance.urdf.joint.muscle.endA,
              body: parentName ?? instance.urdf.joint.parent,
            },
            endB: {
              ...instance.urdf.joint.muscle.endB,
              body: resolveLinkLabel(nextNode),
            },
          }
        : instance.urdf.joint.muscle,
    };
    editorEngine.setNodeUrdf(instance.id, { kind: "joint", joint: nextJoint }, { recordHistory: true, reason: "joint.child" });
    markSceneDirty();

  };

  const handleLinkCollisionSyncChange = (enabled: boolean) => {
    if (!instance || instance.kind !== "link") return;
    if (!linkVisualChildren.length) return;
    const currentActive =
      linkVisualChildren.find((visual) => visual.components?.visual?.attachCollisions === true)?.id ??
      linkVisualChildren[0].id;
    let shouldRecordHistory = true;
    let changed = false;
    for (const visual of linkVisualChildren) {
      const current = visual.components?.visual ?? {};
      const nextAttach = enabled ? visual.id === currentActive : false;
      if ((current.attachCollisions ?? false) === nextAttach) continue;
      editorEngine.setNodeVisual(
        visual.id,
        { ...current, attachCollisions: nextAttach },
        { recordHistory: shouldRecordHistory, reason: "link.collisionSync" }
      );
      shouldRecordHistory = false;
      changed = true;
    }
    if (changed) markSceneDirty();
  };

  const handleVisualColorChange = (visualNodeId: string, rgba: RgbaColor | undefined) => {
    const node = nodes[visualNodeId];
    const current = node?.components?.visual ?? {};
    editorEngine.setNodeVisual(visualNodeId, { ...current, rgba }, { recordHistory: true, reason: "visual.rgba" });
    markSceneDirty();
  };

  if (!selectedId) {
    return (
      <div style={{ padding: 12, opacity: 0.7, fontSize: 13 }}>
        Select an object in the Scene panel to edit its properties.
      </div>
    );
  }

  if (!instance) {
    return (
      <div style={{ padding: 12, opacity: 0.7, fontSize: 13 }}>
        No data for the selected object.
      </div>
    );
  }

  const selectedObjectName =
    selectableObjectOptions.find((option) => option.id === instance.id)?.name ??
    instance.name ??
    "(unnamed)";

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div
        style={{
          padding: 10,
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <div
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            minHeight: 28,
            minWidth: 0,
            paddingRight: selectableObjectOptions.length > 0 ? 16 : 0,
            cursor: selectableObjectOptions.length > 0 ? "pointer" : "default",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0, flex: 1, overflow: "hidden" }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "rgba(255,255,255,0.92)",
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {selectedObjectName}
            </div>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", textTransform: "capitalize", flexShrink: 0 }}>
              {instance.kind}
            </div>
          </div>
          {selectableObjectOptions.length > 0 && (
            <>
              <span
                aria-hidden
                style={{
                  position: "absolute",
                  right: 0,
                  top: "50%",
                  transform: "translateY(-50%)",
                  fontSize: 12,
                  lineHeight: 1,
                  opacity: 0.72,
                  pointerEvents: "none",
                }}
              >
                ▾
              </span>
              <select
                value={instance.id}
                onChange={(e) => handleSelectableObjectChange(e.target.value)}
                aria-label="Select object"
                style={{
                  position: "absolute",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                  margin: 0,
                  opacity: 0,
                  cursor: "pointer",
                  border: "none",
                  background: "transparent",
                  appearance: "none",
                  minWidth: 0,
                }}
              >
                {selectableObjectOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
      </div>

      <div style={{ padding: 12, overflow: "auto", flex: 1, minHeight: 0, display: "grid", gap: 14 }}>
        <div>
          <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 8, textTransform: "uppercase" }}>
            Transform (local)
          </div>

          {(["position", "rotation", "scale"] as const).map((field) => {
            const transformTarget =
              field === "scale"
                ? scaleTarget ?? instance
                : instance;
            const transformForField = transformTarget.transform;
            return (
            <div key={field} style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 8, marginBottom: 8 }}>
              <div style={{ fontSize: 12, opacity: 0.75 }}>{field}</div>
              <div style={{ display: "flex", gap: 6 }}>
                {(["x", "y", "z"] as const).map((axis) => (
                  <input
                    key={axis}
                    type="number"
                    step={field === "rotation" ? 1 : 0.01}
                    value={transformForField[field][axis]}
                    onChange={(e) => updateVec(field, axis, clampNumber(e.target.value), transformTarget.id)}
                    style={inputStyle}
                  />
                ))}
              </div>
            </div>
            );
          })}
        </div>

        <div>
          <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 8, textTransform: "uppercase" }}>Physics</div>
          {!showPhysics && (
            <div style={{ fontSize: 12, opacity: 0.6 }}>No explicit physics parameters.</div>
          )}

          {showMass && (
            <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 8, marginBottom: 8 }}>
              <div style={{ fontSize: 12, opacity: 0.75 }}>Mass</div>
              <input
                type="number"
                step={0.1}
                value={instance.physics.mass}
                onChange={(e) => {
                  updatePhysics(instance.id, { mass: clampNumber(e.target.value) });
                  markSceneDirty();
                }}
                disabled={instance.physics.fixed || instance.physics.useDensity}
                style={inputStyle}
              />
            </div>
          )}

          {showDensity && (
            <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 8, marginBottom: 8 }}>
              <div style={{ fontSize: 12, opacity: 0.75 }}>Density</div>
              <input
                type="number"
                step={0.01}
                value={instance.physics.density}
                onChange={(e) => {
                  updatePhysics(instance.id, { density: clampNumber(e.target.value) });
                  markSceneDirty();
                }}
                style={inputStyle}
              />
            </div>
          )}

          {showUseDensity && (
            <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 8, marginBottom: 8 }}>
              <div style={{ fontSize: 12, opacity: 0.75 }}>Use ρ</div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={instance.physics.useDensity}
                  onChange={(e) => {
                    updatePhysics(instance.id, { useDensity: e.target.checked });
                    markSceneDirty();
                  }}
                />
                Density-based mass
              </label>
            </div>
          )}

          {showInertia && (
            <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 8, marginBottom: 8 }}>
              <div style={{ fontSize: 12, opacity: 0.75 }}>Inertia</div>
              <div style={{ display: "grid", gap: 6 }}>
                {renderInertiaMatrix(
                  instance.physics.inertiaTensor ?? {
                    ixx: instance.physics.inertia.x,
                    iyy: instance.physics.inertia.y,
                    izz: instance.physics.inertia.z,
                    ixy: 0,
                    ixz: 0,
                    iyz: 0,
                  },
                  (label, nextValue) => updateInertia(label, nextValue)
                )}
              </div>
            </div>
          )}

          {showFriction && (
            <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 8, marginBottom: 8 }}>
              <div style={{ fontSize: 12, opacity: 0.75 }}>Geom fric.</div>
              <input
                type="number"
                step={0.01}
                value={instance.physics.friction}
                onChange={(e) => {
                  updatePhysics(instance.id, { friction: clampNumber(e.target.value) });
                  markSceneDirty();
                }}
                style={inputStyle}
              />
            </div>
          )}

          {showRestitution && (
            <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 8 }}>
              <div style={{ fontSize: 12, opacity: 0.75 }}>Restit.</div>
              <input
                type="number"
                step={0.01}
                value={instance.physics.restitution}
                onChange={(e) => {
                  updatePhysics(instance.id, { restitution: clampNumber(e.target.value) });
                  markSceneDirty();
                }}
                style={inputStyle}
              />
            </div>
          )}

          {showFixed && (
            <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 8, marginTop: 10 }}>
              <div style={{ fontSize: 12, opacity: 0.75 }}>Fixed</div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={instance.physics.fixed}
                  onChange={(e) => {
                    updatePhysics(instance.id, { fixed: e.target.checked });
                    markSceneDirty();
                  }}
                />
                Static body
              </label>
            </div>
          )}

          {showCollisions && (
            <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 8, marginTop: 8 }}>
              <div style={{ fontSize: 12, opacity: 0.75 }}>Collide</div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={instance.physics.collisionsEnabled}
                  onChange={(e) => {
                    updatePhysics(instance.id, { collisionsEnabled: e.target.checked });
                    markSceneDirty();
                  }}
                />
                Enable collisions
              </label>
            </div>
          )}

          {instance.kind === "link" && (
            <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 8, marginTop: 8 }}>
              <div style={{ fontSize: 12, opacity: 0.75 }}>Sync col.</div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={linkCollisionSyncEnabled}
                  disabled={!linkVisualChildren.length}
                  onChange={(e) => handleLinkCollisionSyncChange(e.target.checked)}
                />
                Sync collision mesh with visuals
              </label>
            </div>
          )}
        </div>

        {urdf && (
          <div>
            <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 8, textTransform: "uppercase" }}>URDF</div>

            {urdf.kind === "link" && (
              <div style={{ display: "grid", gap: 12 }}>
                <div style={{ fontSize: 12, opacity: 0.8 }}>Link: {urdf.link.name}</div>

                <div>
                  <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6, textTransform: "uppercase" }}>
                    Inertial
                  </div>
                  {urdf.link.inertial ? (
                    <div style={{ display: "grid", gap: 8 }}>
                      {renderVecRow("xyz", urdf.link.inertial.origin.xyz, (next) =>
                        updateLink((link) => ({
                          ...link,
                          inertial: link.inertial ? { ...link.inertial, origin: { ...link.inertial.origin, xyz: next } } : link.inertial,
                        }))
                      )}
                      {renderVecRow("rpy", urdf.link.inertial.origin.rpy, (next) =>
                        updateLink((link) => ({
                          ...link,
                          inertial: link.inertial ? { ...link.inertial, origin: { ...link.inertial.origin, rpy: next } } : link.inertial,
                        }))
                      )}
                      <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 8 }}>
                        <div style={{ fontSize: 12, opacity: 0.75 }}>mass</div>
                        <input
                          type="number"
                          step={0.01}
                          value={urdf.link.inertial.mass}
                          onChange={(e) =>
                            updateLink((link) => ({
                              ...link,
                              inertial: link.inertial ? { ...link.inertial, mass: clampNumber(e.target.value) } : link.inertial,
                            }))
                          }
                          style={inputStyle}
                        />
                      </div>
                      <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>Inertia</div>
                      {renderInertiaMatrix(urdf.link.inertial.inertia, (label, nextValue) =>
                        updateLink((link) => {
                          if (!link.inertial) return link;
                          return {
                            ...link,
                            inertial: {
                              ...link.inertial,
                              inertia: {
                                ...link.inertial.inertia,
                                [label]: nextValue,
                              },
                            },
                          };
                        })
                      )}
                    </div>
                  ) : (
                    <button
                      onClick={() =>
                        updateLink((link) => ({
                          ...link,
                          inertial: {
                            origin: { xyz: [0, 0, 0], rpy: [0, 0, 0] },
                            mass: 0,
                            inertia: { ixx: 0, iyy: 0, izz: 0, ixy: 0, ixz: 0, iyz: 0 },
                          },
                        }))
                      }
                      style={{
                        height: 26,
                        padding: "0 10px",
                        borderRadius: 8,
                        border: "1px solid rgba(255,255,255,0.10)",
                        background: "rgba(255,255,255,0.08)",
                        color: "rgba(255,255,255,0.92)",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      Add inertial
                    </button>
                  )}
                </div>

                <div>
                  <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6, textTransform: "uppercase" }}>
                    Collisions ({urdf.link.collisions.length})
                  </div>
                  {urdf.link.collisions.length === 0 && (
                    <div style={{ fontSize: 12, opacity: 0.6 }}>No collision elements.</div>
                  )}
                  {urdf.link.collisions.map((collision, index) => (
                    <div key={`collision-${index}`} style={{ marginBottom: 10, paddingBottom: 6, borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                      <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>
                        Collision {index + 1} • {collision.geom.kind}
                      </div>
                      {renderPoseEditor(collision.origin, (nextPose) =>
                        updateLinkCollision(index, (item) => ({ ...item, origin: nextPose }))
                      )}
                      {renderGeomEditor(collision.geom, (nextGeom) =>
                        updateLinkCollision(index, (item) => ({ ...item, geom: nextGeom }))
                      )}
                    </div>
                  ))}
                </div>

                <div>
                  <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6, textTransform: "uppercase" }}>
                    Visuals ({urdf.link.visuals.length})
                  </div>
                  {urdf.link.visuals.length === 0 && (
                    <div style={{ fontSize: 12, opacity: 0.6 }}>No visual elements.</div>
                  )}
                  {urdf.link.visuals.map((visual, index) => {
                    const visualNode = linkVisualChildren[index];
                    const currentRgba = visualNode?.components?.visual?.rgba;
                    const materialInfo = visualNode?.components?.visual?.materialInfo;
                    const materialEditable = materialInfo?.editable !== false;
                    return (
                      <div key={`visual-${index}`} style={{ marginBottom: 10, paddingBottom: 6, borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                        <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>
                          Visual {index + 1} • {visual.geom.kind}
                        </div>
                        {renderPoseEditor(visual.origin, (nextPose) =>
                          updateLinkVisual(index, (item) => ({ ...item, origin: nextPose }))
                        )}
                        {renderGeomEditor(visual.geom, (nextGeom) =>
                          updateLinkVisual(index, (item) => ({ ...item, geom: nextGeom }))
                        )}
                        {visualNode && (
                          <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 8, marginTop: 4 }}>
                            <div style={{ fontSize: 12, opacity: 0.75 }}>Color</div>
                            <div style={{ display: "grid", gap: 6 }}>
                              {materialInfo && (
                                <div style={{ fontSize: 11, opacity: 0.68 }}>
                                  USD material
                                  {materialInfo.materialName ? `: ${materialInfo.materialName}` : ""}
                                  {materialInfo.texturePath ? ` • texture: ${materialInfo.texturePath}` : ""}
                                  {!materialEditable ? " • read-only" : ""}
                                </div>
                              )}
                              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <input
                                type="color"
                                value={currentRgba ? rgbaToHex(currentRgba) : "#888888"}
                                disabled={!materialEditable}
                                onChange={(e) => {
                                  const alpha = currentRgba?.[3] ?? 1;
                                  handleVisualColorChange(visualNode.id, hexToRgba(e.target.value, alpha));
                                }}
                                style={{ width: 32, height: 24, borderRadius: 4, border: "1px solid rgba(255,255,255,0.12)", cursor: "pointer", padding: 2, background: "transparent" }}
                              />
                              <input
                                type="number"
                                min={0}
                                max={1}
                                step={0.05}
                                value={(currentRgba?.[3] ?? 1).toFixed(2)}
                                disabled={!materialEditable}
                                onChange={(e) => {
                                  const alpha = Math.min(1, Math.max(0, parseFloat(e.target.value) || 1));
                                  const hex = currentRgba ? rgbaToHex(currentRgba) : "#888888";
                                  handleVisualColorChange(visualNode.id, hexToRgba(hex, alpha));
                                }}
                                style={{ ...inputStyle, width: 52 }}
                                title="Opacity (0–1)"
                              />
                              {currentRgba && (
                                <button
                                  onClick={() => handleVisualColorChange(visualNode.id, undefined)}
                                  disabled={!materialEditable}
                                  style={{
                                    height: 24,
                                    padding: "0 8px",
                                    borderRadius: 4,
                                    border: "1px solid rgba(255,255,255,0.12)",
                                    background: "rgba(255,255,255,0.06)",
                                    color: "rgba(255,255,255,0.7)",
                                    cursor: "pointer",
                                    fontSize: 11,
                                  }}
                                  title="Reset to default color"
                                >
                                  Reset
                                </button>
                              )}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {urdf.kind === "joint" && (
              <div style={{ display: "grid", gap: 12 }}>
                <div style={{ fontSize: 12, opacity: 0.8 }}>Joint: {urdf.joint.name}</div>

                <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 8 }}>
                  <div style={{ fontSize: 12, opacity: 0.75 }}>Type</div>
                  <DarkSelect
                    value={urdf.joint.type}
                    onChange={(e) =>
                      updateJoint((joint) => ({
                        ...joint,
                        type: e.target.value,
                      }))
                    }
                    style={{ ...inputStyle, width: 120, height: 28 }}
                  >
                    {["fixed", "continuous", "revolute", "prismatic", "planar", "floating"].map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </DarkSelect>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 8 }}>
                  <div style={{ fontSize: 12, opacity: 0.75 }}>Parent</div>
                  <input
                    type="text"
                    value={jointContext?.parentName ?? urdf.joint.parent}
                    readOnly
                    style={inputWideStyle}
                  />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 8 }}>
                  <div style={{ fontSize: 12, opacity: 0.75 }}>Child</div>
                  <DarkSelect
                    value={jointContext?.childLinkId ?? ""}
                    onChange={(e) => handleJointChildChange(e.target.value)}
                    style={{ ...inputWideStyle, height: 28 }}
                  >
                    <option value="">Select link...</option>
                    {linkOptions
                      .filter((opt) => opt.id !== jointContext?.parentLinkId)
                      .map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.name}
                        </option>
                      ))}
                  </DarkSelect>
                </div>

                {renderPoseEditor(urdf.joint.origin, (nextPose) =>
                  updateJoint((joint) => ({ ...joint, origin: nextPose }))
                )}

                {renderJointAxisRow("axis", urdf.joint.axis, (next) => updateJoint((joint) => ({ ...joint, axis: next })), 0.01)}

                <div>
                  <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6, textTransform: "uppercase" }}>Limits</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
                    {([
                      ["lower", urdf.joint.limit?.lower],
                      ["upper", urdf.joint.limit?.upper],
                      ["effort", urdf.joint.limit?.effort],
                      ["velocity", urdf.joint.limit?.velocity],
                    ] as const).map(([label, value]) => (
                      <div key={label} style={{ display: "grid", gap: 4 }}>
                        <div style={{ fontSize: 10, opacity: 0.6 }}>{label}</div>
                        <input
                          type="number"
                          step={0.01}
                          value={value ?? ""}
                          onChange={(e) => updateJointLimitField(label, parseOptionalNumber(e.target.value))}
                          style={inputStyle}
                        />
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6, textTransform: "uppercase" }}>Joint simulation</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
                    {([
                      ["damping", urdf.joint.dynamics?.damping],
                      ["friction", urdf.joint.dynamics?.friction],
                      ["armature", urdf.joint.dynamics?.armature],
                    ] as const).map(([label, value]) => (
                      <div key={label} style={{ display: "grid", gap: 4 }}>
                        <div style={{ fontSize: 10, opacity: 0.6 }}>{label}</div>
                        <input
                          type="number"
                          step={0.01}
                          value={value ?? ""}
                          placeholder={String(dynamicsDefaults[label])}
                          onChange={(e) => updateJointDynamicsField(label, parseOptionalNumber(e.target.value))}
                          style={inputStyle}
                        />
                      </div>
                    ))}
                  </div>
                </div>

                {urdf.joint.type !== "fixed" && urdf.joint.type !== "floating" && (
                  <div>
                    <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6, textTransform: "uppercase" }}>
                      Actuators
                    </div>
                    <div style={{ display: "grid", gap: 8 }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                        <input
                          type="checkbox"
                          checked={jointActuatorEnabled}
                          onChange={(e) =>
                            updateJoint((joint) => ({
                              ...joint,
                              actuator: {
                                ...(joint.actuator ?? {}),
                                enabled: e.target.checked,
                              },
                            }))
                          }
                        />
                        Actuator enabled
                      </label>
                      <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 8, alignItems: "center" }}>
                        <div style={{ fontSize: 12, opacity: 0.75 }}>Mode</div>
                        <DarkSelect
                          value={jointActuatorType}
                          onChange={(e) =>
                            updateJoint((joint) => {
                              const nextType = e.target.value as "position" | "velocity" | "torque" | "muscle";
                              const nextActuator = {
                                ...(joint.actuator ?? {}),
                                type: nextType,
                              };
                              if (nextType !== "muscle") {
                                return { ...joint, actuator: nextActuator };
                              }
                              const parentBody = joint.parent || "";
                              const childBody = joint.child || "";
                              const frame0Pos =
                                joint.sourceFrames?.frame0Local?.position ?? ([0, 0, 0] as [number, number, number]);
                              const frame1Pos =
                                joint.sourceFrames?.frame1Local?.position ?? ([0, 0, 0] as [number, number, number]);
                              const nextMuscle = joint.muscle ?? {
                                enabled: false,
                                endA: {
                                  body: parentBody,
                                  localPos: [frame0Pos[0], frame0Pos[1], frame0Pos[2]] as [number, number, number],
                                },
                                endB: {
                                  body: childBody,
                                  localPos: [frame1Pos[0], frame1Pos[1], frame1Pos[2]] as [number, number, number],
                                },
                                range: [...muscleDefaults.range] as [number, number],
                                force: muscleDefaults.force,
                                scale: muscleDefaults.scale,
                                damping: muscleDefaults.damping,
                                showLine: muscleDefaults.showLine,
                                showTube: muscleDefaults.showTube,
                              };
                              return { ...joint, actuator: nextActuator, muscle: nextMuscle };
                            })
                          }
                          style={{ ...inputStyle, width: 150, height: 28 }}
                        >
                          <option value="position">position</option>
                          <option value="velocity">velocity</option>
                          <option value="torque">torque</option>
                          <option value="muscle">muscle</option>
                        </DarkSelect>
                      </div>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                          gap: 8,
                          opacity: jointActuatorEnabled ? 1 : 0.55,
                        }}
                      >
                        {jointActuatorType !== "muscle" &&
                          ([
                            ["stiffness", urdf.joint.actuator?.stiffness],
                            ["damping", urdf.joint.actuator?.damping],
                            ["initialPosition", urdf.joint.actuator?.initialPosition],
                          ] as const).map(([label, value]) => (
                            <div key={label} style={{ display: "grid", gap: 4 }}>
                              <div style={{ fontSize: 10, opacity: 0.6 }}>{label}</div>
                              <input
                                type="number"
                                step={0.01}
                                value={value ?? ""}
                                placeholder={
                                  Number.isFinite((actuatorDefaults as Record<string, number>)[label])
                                    ? String(actuatorDefaults[label])
                                    : undefined
                                }
                                onChange={(e) => updateJointActuatorField(label, parseOptionalNumber(e.target.value))}
                                disabled={!jointActuatorEnabled}
                                style={inputStyle}
                              />
                            </div>
                          ))}
                        {jointActuatorType === "muscle" && (
                          <>
                            <div style={{ display: "grid", gap: 4 }}>
                              <div style={{ fontSize: 10, opacity: 0.6 }}>range min</div>
                              <input
                                type="number"
                                step={0.01}
                                value={urdf.joint.muscle?.range?.[0] ?? muscleDefaults.range[0]}
                                onChange={(e) =>
                                  updateJointMuscle((muscle) => ({
                                    ...muscle,
                                    range: [clampNumber(e.target.value), muscle.range?.[1] ?? muscleDefaults.range[1]],
                                  }))
                                }
                                disabled={!jointActuatorEnabled}
                                style={inputStyle}
                              />
                            </div>
                            <div style={{ display: "grid", gap: 4 }}>
                              <div style={{ fontSize: 10, opacity: 0.6 }}>range max</div>
                              <input
                                type="number"
                                step={0.01}
                                value={urdf.joint.muscle?.range?.[1] ?? muscleDefaults.range[1]}
                                onChange={(e) =>
                                  updateJointMuscle((muscle) => ({
                                    ...muscle,
                                    range: [muscle.range?.[0] ?? muscleDefaults.range[0], clampNumber(e.target.value)],
                                  }))
                                }
                                disabled={!jointActuatorEnabled}
                                style={inputStyle}
                              />
                            </div>
                            {([
                              ["force", urdf.joint.muscle?.force ?? muscleDefaults.force],
                              ["scale", urdf.joint.muscle?.scale ?? muscleDefaults.scale],
                              ["damping", urdf.joint.muscle?.damping ?? muscleDefaults.damping],
                            ] as const).map(([label, value]) => (
                              <div key={label} style={{ display: "grid", gap: 4 }}>
                                <div style={{ fontSize: 10, opacity: 0.6 }}>{label}</div>
                                <input
                                  type="number"
                                  step={0.01}
                                  value={value}
                                  onChange={(e) =>
                                    updateJointMuscle((muscle) => ({
                                      ...muscle,
                                      [label]: clampNumber(e.target.value),
                                    }))
                                  }
                                  disabled={!jointActuatorEnabled}
                                  style={inputStyle}
                                />
                              </div>
                            ))}
                          </>
                        )}
                      </div>
                      {jointActuatorType === "muscle" && (
                        <div style={{ display: "grid", gap: 8, opacity: jointActuatorEnabled ? 1 : 0.55 }}>
                          <div style={{ fontSize: 11, opacity: 0.7, textTransform: "uppercase" }}>Muscle Endpoints</div>
                          {renderVecRow(
                            "endA",
                            urdf.joint.muscle?.endA.localPos ?? [0, 0, 0],
                            (next) =>
                              updateJointMuscle((muscle, joint) => ({
                                ...muscle,
                                endA: { body: muscle.endA.body || joint.parent, localPos: next },
                              })),
                            0.001
                          )}
                          {renderVecRow(
                            "endB",
                            urdf.joint.muscle?.endB.localPos ?? [0, 0, 0],
                            (next) =>
                              updateJointMuscle((muscle, joint) => ({
                                ...muscle,
                                endB: { body: muscle.endB.body || joint.child, localPos: next },
                              })),
                            0.001
                          )}
                          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                            <input
                              type="checkbox"
                              checked={urdf.joint.muscle?.showLine !== false}
                              onChange={(e) =>
                                updateJointMuscle((muscle) => ({
                                  ...muscle,
                                  showLine: e.target.checked,
                                }))
                              }
                              disabled={!jointActuatorEnabled}
                            />
                            Show gray line
                          </label>
                          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                            <input
                              type="checkbox"
                              checked={urdf.joint.muscle?.showTube === true}
                              onChange={(e) =>
                                updateJointMuscle((muscle) => ({
                                  ...muscle,
                                  showTube: e.target.checked,
                                }))
                              }
                              disabled={!jointActuatorEnabled}
                            />
                            Tube rendering
                          </label>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
