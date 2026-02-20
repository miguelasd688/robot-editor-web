import { useEffect, useMemo, useState } from "react";
import { useSceneStore } from "../../app/core/store/useSceneStore";
import { useAssetInstanceStore } from "../../app/core/store/useAssetInstanceStore";
import { useMujocoStore } from "../../app/core/store/useMujocoStore";
import type { JointActuatorConfig } from "../../app/core/physics/mujoco/MujocoRuntime";
import type { UrdfJoint } from "../../app/core/urdf/urdfModel";
import { editorEngine } from "../../app/core/editor/engineSingleton";
import { DarkSelect } from "../../app/ui/DarkSelect";
import { formatSignificant } from "../../app/ui/numberFormat";

const EMPTY_TARGETS: Record<string, number> = {};

const clamp = (value: number, min?: number, max?: number) => {
  if (Number.isFinite(min) && value < (min as number)) return min as number;
  if (Number.isFinite(max) && value > (max as number)) return max as number;
  return value;
};

const ACTUATOR_TYPES = ["position", "velocity", "torque"] as const;
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

type RangeEditState = { jointId: string; field: "min" | "max"; value: string };

export default function ActuatorControllerPanel() {
  const sceneNodes = useSceneStore((s) => s.nodes);
  const selectedId = useSceneStore((s) => s.selectedId);
  const instances = useAssetInstanceStore((s) => s.instances);

  const selectedRobotId = useMemo(() => {
    if (!selectedId) return null;
    let cur: string | null = selectedId;
    while (cur) {
      const node: (typeof sceneNodes)[string] | undefined = sceneNodes[cur];
      if (!node) return null;
      if (node.kind === "robot") return cur;
      cur = node.parentId;
    }
    return null;
  }, [selectedId, sceneNodes]);

  const actuatorTargetsByRobot = useMujocoStore((s) => s.actuatorTargetsByRobot);
  const actuatorVelocityTargetsByRobot = useMujocoStore((s) => s.actuatorVelocityTargetsByRobot);
  const actuatorTorqueTargetsByRobot = useMujocoStore((s) => s.actuatorTorqueTargetsByRobot);
  const actuatorInitialTargetsByRobot = useMujocoStore((s) => s.actuatorInitialTargetsByRobot);
  const actuatorRegistryByRobot = useMujocoStore((s) => s.actuatorRegistryByRobot);
  const actuatorTargets = useMemo(
    () =>
      selectedRobotId ? actuatorTargetsByRobot[selectedRobotId] ?? EMPTY_TARGETS : EMPTY_TARGETS,
    [actuatorTargetsByRobot, selectedRobotId]
  );
  const actuatorVelocityTargets = useMemo(
    () =>
      selectedRobotId
        ? actuatorVelocityTargetsByRobot[selectedRobotId] ?? EMPTY_TARGETS
        : EMPTY_TARGETS,
    [actuatorVelocityTargetsByRobot, selectedRobotId]
  );
  const actuatorTorqueTargets = useMemo(
    () =>
      selectedRobotId ? actuatorTorqueTargetsByRobot[selectedRobotId] ?? EMPTY_TARGETS : EMPTY_TARGETS,
    [actuatorTorqueTargetsByRobot, selectedRobotId]
  );
  const actuatorInitialTargets = useMemo(
    () =>
      selectedRobotId
        ? actuatorInitialTargetsByRobot[selectedRobotId] ?? EMPTY_TARGETS
        : EMPTY_TARGETS,
    [actuatorInitialTargetsByRobot, selectedRobotId]
  );
  const setRobotActuatorTargets = useMujocoStore((s) => s.setRobotActuatorTargets);
  const setRobotActuatorTarget = useMujocoStore((s) => s.setRobotActuatorTarget);
  const setRobotActuatorVelocityTargets = useMujocoStore((s) => s.setRobotActuatorVelocityTargets);
  const setRobotActuatorVelocityTarget = useMujocoStore((s) => s.setRobotActuatorVelocityTarget);
  const setRobotActuatorTorqueTargets = useMujocoStore((s) => s.setRobotActuatorTorqueTargets);
  const setRobotActuatorTorqueTarget = useMujocoStore((s) => s.setRobotActuatorTorqueTarget);
  const setRobotActuatorConfigs = useMujocoStore((s) => s.setRobotActuatorConfigs);
  const setRobotActuatorInitialTargets = useMujocoStore((s) => s.setRobotActuatorInitialTargets);
  const actuatorsArmed = useMujocoStore((s) => s.actuatorsArmed);
  const setActuatorsArmed = useMujocoStore((s) => s.setActuatorsArmed);
  const getJointPositions = useMujocoStore((s) => s.getJointPositions);
  const isReady = useMujocoStore((s) => s.isReady);
  const isLoading = useMujocoStore((s) => s.isLoading);
  const markSceneDirty = useMujocoStore((s) => s.markSceneDirty);

  const hasRobotSelection = Boolean(selectedRobotId);
  const [rangeEdit, setRangeEdit] = useState<RangeEditState | null>(null);

  const actuators = useMemo(() => {
    if (!selectedRobotId) return [];
    return actuatorRegistryByRobot[selectedRobotId] ?? [];
  }, [actuatorRegistryByRobot, selectedRobotId]);

  const configs = useMemo<Record<string, JointActuatorConfig>>(() => {
    const map: Record<string, JointActuatorConfig> = {};
    for (const entry of actuators) {
      map[entry.jointId] = {
        stiffness: entry.stiffness,
        damping: entry.damping,
        maxForce: Math.max(Math.abs(entry.effortRange.min), Math.abs(entry.effortRange.max)),
        continuous: entry.continuous,
        angular: entry.angular,
        mode: entry.actuatorType,
      };
    }
    return map;
  }, [actuators]);

  useEffect(() => {
    if (!selectedRobotId) return;
    setRobotActuatorConfigs(selectedRobotId, configs);
  }, [configs, setRobotActuatorConfigs, selectedRobotId]);

  const updateUrdfJoint = (jointId: string, mutate: (joint: UrdfJoint) => UrdfJoint, reason: string) => {
    const instanceUrdf = instances[jointId]?.urdf;
    if (!instanceUrdf || instanceUrdf.kind !== "joint") return false;
    const nextUrdf = { ...instanceUrdf, joint: mutate(instanceUrdf.joint) };
    editorEngine.setNodeUrdf(jointId, nextUrdf, { recordHistory: true, reason });
    markSceneDirty();
    return true;
  };

  const updateUrdfInitial = (jointId: string, value: number) => {
    const instanceUrdf = instances[jointId]?.urdf;
    if (!instanceUrdf || instanceUrdf.kind !== "joint") return;
    const isAngular = instanceUrdf.joint.type !== "prismatic" && instanceUrdf.joint.type !== "planar";
    const nextValue = isAngular ? value * DEG2RAD : value;
    const currentValue = instanceUrdf.joint.actuator?.initialPosition;
    if (currentValue === nextValue) return;
    const nextUrdf = {
      ...instanceUrdf,
      joint: {
        ...instanceUrdf.joint,
        actuator: {
          ...(instanceUrdf.joint.actuator ?? {}),
          initialPosition: nextValue,
        },
      },
    };
    editorEngine.setNodeUrdf(jointId, nextUrdf, { recordHistory: false, reason: "actuator.initial" });
  };

  const beginRangeEdit = (jointId: string, field: "min" | "max", current: number) => {
    setRangeEdit({ jointId, field, value: String(current) });
  };

  const cancelRangeEdit = () => setRangeEdit(null);

  const commitRangeEdit = (entry: (typeof actuators)[number]) => {
    if (!rangeEdit) return;
    if (rangeEdit.jointId !== entry.jointId) return;
    const nextValue = Number(rangeEdit.value);
    if (!Number.isFinite(nextValue)) {
      setRangeEdit(null);
      return;
    }

    const limitValue = entry.angular ? nextValue * DEG2RAD : nextValue;

    updateUrdfJoint(
      entry.jointId,
      (joint) => {
        const nextLimit = { ...(joint.limit ?? {}) };
        if (rangeEdit.field === "min") {
          nextLimit.lower = limitValue;
        } else {
          nextLimit.upper = limitValue;
        }
        if (Number.isFinite(nextLimit.lower) && Number.isFinite(nextLimit.upper)) {
          if ((nextLimit.lower as number) > (nextLimit.upper as number)) {
            if (rangeEdit.field === "min") {
              nextLimit.lower = nextLimit.upper;
            } else {
              nextLimit.upper = nextLimit.lower;
            }
          }
        }
        const hasAny = Object.values(nextLimit).some((v) => v !== undefined);
        return { ...joint, limit: hasAny ? nextLimit : undefined };
      },
      "actuator.limit"
    );

    setRangeEdit(null);
  };

  const handleActuatorTypeChange = (entry: (typeof actuators)[number], value: string) => {
    if (value === entry.actuatorType) return;
    if (entry.type === "revolute" && value === "velocity") return;
    if (selectedRobotId) {
      setRobotActuatorVelocityTargets(selectedRobotId, { ...actuatorVelocityTargets, [entry.jointId]: 0 });
      setRobotActuatorTorqueTargets(selectedRobotId, { ...actuatorTorqueTargets, [entry.jointId]: 0 });
    }
    updateUrdfJoint(
      entry.jointId,
      (joint) => ({
        ...joint,
        actuator: {
          ...(joint.actuator ?? {}),
          type: value as (typeof ACTUATOR_TYPES)[number],
        },
      }),
      "actuator.mode"
    );
  };

  useEffect(() => {
    if (!selectedRobotId) return;
    const valid = new Set(actuators.map((entry) => entry.jointId));
    const nextTargets = { ...actuatorTargets };
    let changed = false;

    for (const entry of actuators) {
      if (!Number.isFinite(nextTargets[entry.jointId])) {
        const initial =
          Number.isFinite(actuatorInitialTargets[entry.jointId])
            ? (actuatorInitialTargets[entry.jointId] as number)
            : entry.initialPosition;
        nextTargets[entry.jointId] = initial;
        changed = true;
      }
    }

    for (const name of Object.keys(nextTargets)) {
      if (!valid.has(name)) {
        delete nextTargets[name];
        changed = true;
      }
    }

    if (changed) {
      setRobotActuatorTargets(selectedRobotId, nextTargets);
    }
  }, [actuators, actuatorTargets, actuatorInitialTargets, selectedRobotId, setRobotActuatorTargets]);

  useEffect(() => {
    if (!selectedRobotId) return;
    const valid = new Set(actuators.map((entry) => entry.jointId));
    const nextVelocity = { ...actuatorVelocityTargets };
    const nextTorque = { ...actuatorTorqueTargets };
    let changedVelocity = false;
    let changedTorque = false;

    for (const entry of actuators) {
      if (!Number.isFinite(nextVelocity[entry.jointId])) {
        nextVelocity[entry.jointId] = 0;
        changedVelocity = true;
      }
      if (!Number.isFinite(nextTorque[entry.jointId])) {
        nextTorque[entry.jointId] = 0;
        changedTorque = true;
      }
    }

    for (const name of Object.keys(nextVelocity)) {
      if (!valid.has(name)) {
        delete nextVelocity[name];
        changedVelocity = true;
      }
    }

    for (const name of Object.keys(nextTorque)) {
      if (!valid.has(name)) {
        delete nextTorque[name];
        changedTorque = true;
      }
    }

    if (changedVelocity) {
      setRobotActuatorVelocityTargets(selectedRobotId, nextVelocity);
    }
    if (changedTorque) {
      setRobotActuatorTorqueTargets(selectedRobotId, nextTorque);
    }
  }, [
    actuators,
    actuatorVelocityTargets,
    actuatorTorqueTargets,
    selectedRobotId,
    setRobotActuatorVelocityTargets,
    setRobotActuatorTorqueTargets,
  ]);


  const statusMessage = useMemo(() => {
    if (!hasRobotSelection) {
      return "Selecciona un robot para ver los actuadores (las posiciones actuales se conservan).";
    }
    if (isLoading) return "Cargando MuJoCo...";
    if (!isReady) return "MuJoCo no está listo todavía. Espera a que termine la carga o pulsa Reset.";
    if (actuators.length === 0) return "El robot seleccionado no tiene actuadores.";
    return null;
  }, [actuators.length, hasRobotSelection, isLoading, isReady]);

  const handleSaveInitial = () => {
    if (!selectedRobotId) return;
    const names = actuators.map((entry) => entry.mjcfJoint);
    const livePositions = getJointPositions(names);
    const nextInitial = { ...actuatorInitialTargets };
    let changed = false;

    for (const entry of actuators) {
      const fallback = actuatorTargets[entry.jointId] ?? entry.initialPosition;
      const liveValue = livePositions[entry.mjcfJoint];
      const value = Number.isFinite(liveValue)
        ? entry.angular
          ? (liveValue as number) * RAD2DEG
          : (liveValue as number)
        : fallback;
      const adjusted = clamp(value, entry.range.min, entry.range.max);
      if (nextInitial[entry.jointId] !== adjusted) {
        nextInitial[entry.jointId] = adjusted;
        changed = true;
      }
    }

    if (changed) {
      setRobotActuatorInitialTargets(selectedRobotId, nextInitial);
      setRobotActuatorTargets(selectedRobotId, { ...actuatorTargets, ...nextInitial });
    }

    for (const entry of actuators) {
      const nextValue = nextInitial[entry.jointId];
      if (!Number.isFinite(nextValue)) continue;
      updateUrdfInitial(entry.jointId, nextValue);
    }

  };

  const handleResetTargets = () => {
    if (!selectedRobotId) return;
    const nextTargets = { ...actuatorTargets };
    const nextVelocity: Record<string, number> = {};
    const nextTorque: Record<string, number> = {};

    for (const entry of actuators) {
      const fallback = entry.initialPosition;
      const initial = Number.isFinite(actuatorInitialTargets[entry.jointId])
        ? (actuatorInitialTargets[entry.jointId] as number)
        : fallback;
      const adjusted = clamp(initial, entry.range.min, entry.range.max);
      nextTargets[entry.jointId] = adjusted;
      nextVelocity[entry.jointId] = 0;
      nextTorque[entry.jointId] = 0;
    }

    setRobotActuatorTargets(selectedRobotId, nextTargets);
    setRobotActuatorVelocityTargets(selectedRobotId, nextVelocity);
    setRobotActuatorTorqueTargets(selectedRobotId, nextTorque);
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div
        style={{
          padding: 10,
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontSize: 12, opacity: 0.7, marginRight: "auto" }}>Actuators: {actuators.length}</div>
        <button
          onClick={handleSaveInitial}
          disabled={!hasRobotSelection || actuators.length === 0}
          style={{
            minHeight: 26,
            padding: "0 10px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.10)",
            background: "rgba(255,255,255,0.08)",
            color: "rgba(255,255,255,0.92)",
            cursor: !hasRobotSelection || actuators.length === 0 ? "not-allowed" : "pointer",
            opacity: !hasRobotSelection || actuators.length === 0 ? 0.6 : 1,
            whiteSpace: "normal",
            lineHeight: 1.2,
          }}
          title="Guardar posición actual como posición inicial"
        >
          Guardar inicial
        </button>
        <button
          onClick={handleResetTargets}
          disabled={!hasRobotSelection || actuators.length === 0}
          style={{
            minHeight: 26,
            padding: "0 10px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.10)",
            background: "rgba(255,255,255,0.08)",
            color: "rgba(255,255,255,0.92)",
            cursor: !hasRobotSelection || actuators.length === 0 ? "not-allowed" : "pointer",
            opacity: !hasRobotSelection || actuators.length === 0 ? 0.6 : 1,
            whiteSpace: "normal",
            lineHeight: 1.2,
          }}
          title="Resetear sliders a la posición inicial"
        >
          Reset sliders
        </button>
        <button
          onClick={() => setActuatorsArmed(!actuatorsArmed)}
          disabled={!hasRobotSelection || actuators.length === 0}
          style={{
            minHeight: 26,
            padding: "0 10px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.12)",
            background: actuatorsArmed ? "rgba(80,180,120,0.18)" : "rgba(255,255,255,0.06)",
            color: "rgba(255,255,255,0.92)",
            cursor: !hasRobotSelection || actuators.length === 0 ? "not-allowed" : "pointer",
            opacity: !hasRobotSelection || actuators.length === 0 ? 0.6 : 1,
            whiteSpace: "normal",
            lineHeight: 1.2,
          }}
          title={actuatorsArmed ? "Desarmar actuadores" : "Armar actuadores"}
        >
          {actuatorsArmed ? "Actuadores armados" : "Armar actuadores"}
        </button>
      </div>

      <div style={{ padding: 12, overflow: "auto", flex: 1, minHeight: 0, display: "grid", gap: 12 }}>
        {statusMessage && <div style={{ opacity: 0.7, fontSize: 12 }}>{statusMessage}</div>}

        {hasRobotSelection &&
          actuators.map((entry) => {
          const hasPositionLimits = true;
          const rawTarget = actuatorTargets[entry.jointId];
          const target = Number.isFinite(rawTarget) ? (rawTarget as number) : entry.initialPosition;
          const safeTarget = hasPositionLimits ? clamp(target, entry.range.min, entry.range.max) : target;
          const isAngular = entry.angular;
          const unit = isAngular ? "deg" : "m";
          const velocityUnit = isAngular ? "rpm" : "m/s";
          const torqueUnit = isAngular ? "Nm" : "N";
          const rawInitial = actuatorInitialTargets[entry.jointId];
          const initialValue = Number.isFinite(rawInitial) ? (rawInitial as number) : entry.initialPosition;
          const safeInitial = hasPositionLimits ? clamp(initialValue, entry.range.min, entry.range.max) : initialValue;
          const rawVelocity = actuatorVelocityTargets[entry.jointId];
          const velocityTarget = Number.isFinite(rawVelocity) ? (rawVelocity as number) : 0;
          const velocityDisplayRange = isAngular
            ? { min: entry.velocityRange.min / 6, max: entry.velocityRange.max / 6 }
            : entry.velocityRange;
          const velocityDisplay = isAngular ? velocityTarget / 6 : velocityTarget;
          const safeVelocity = clamp(velocityDisplay, velocityDisplayRange.min, velocityDisplayRange.max);
          const rawTorque = actuatorTorqueTargets[entry.jointId];
          const torqueTarget = Number.isFinite(rawTorque) ? (rawTorque as number) : 0;
          const safeTorque = clamp(torqueTarget, entry.effortRange.min, entry.effortRange.max);
          const actuatorMode = entry.actuatorType;
          const showPosition = actuatorMode === "position" || actuatorMode === "torque";
          const showVelocity = actuatorMode === "velocity" || actuatorMode === "torque";
          const showTorque = actuatorMode === "torque";
          const showInitial = actuatorMode === "position";
          const headerIsVelocity = actuatorMode === "velocity";
          const headerRange = headerIsVelocity ? velocityDisplayRange : entry.range;
          const headerUnit = headerIsVelocity ? velocityUnit : unit;
          const handleChange = (raw: number) => {
            const next = hasPositionLimits ? clamp(raw, entry.range.min, entry.range.max) : raw;
            if (!Number.isFinite(next)) return;
            if (!selectedRobotId) return;
            setRobotActuatorTarget(selectedRobotId, entry.jointId, next);
          };
          const handleVelocityChange = (raw: number) => {
            const nextValue = isAngular ? raw * 6 : raw;
            const next = clamp(nextValue, entry.velocityRange.min, entry.velocityRange.max);
            if (!Number.isFinite(next)) return;
            if (!selectedRobotId) return;
            setRobotActuatorVelocityTarget(selectedRobotId, entry.jointId, next);
          };
          const handleTorqueChange = (raw: number) => {
            const next = clamp(raw, entry.effortRange.min, entry.effortRange.max);
            if (!Number.isFinite(next)) return;
            if (!selectedRobotId) return;
            setRobotActuatorTorqueTarget(selectedRobotId, entry.jointId, next);
          };
          const handleInitialChange = (raw: number) => {
            const next = hasPositionLimits ? clamp(raw, entry.range.min, entry.range.max) : raw;
            if (!Number.isFinite(next)) return;
            if (!selectedRobotId) return;
            setRobotActuatorInitialTargets(selectedRobotId, { ...actuatorInitialTargets, [entry.jointId]: next });
            setRobotActuatorTargets(selectedRobotId, { ...actuatorTargets, [entry.jointId]: next });
            updateUrdfInitial(entry.jointId, next);
          };

          return (
            <div
              key={entry.jointId}
              style={{
                padding: 10,
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.08)",
                background: "rgba(255,255,255,0.03)",
                display: "grid",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>{entry.jointName}</div>
                <DarkSelect
                  size="sm"
                  value={entry.actuatorType}
                  onChange={(e) => handleActuatorTypeChange(entry, e.target.value)}
                  title="Actuator type"
                >
                  {ACTUATOR_TYPES.map((type) => (
                    <option key={type} value={type} disabled={entry.type === "revolute" && type === "velocity"}>
                      {type}
                    </option>
                  ))}
                </DarkSelect>
                <div
                  style={{
                    fontSize: 10,
                    opacity: 0.6,
                    marginLeft: "auto",
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  {headerIsVelocity ? (
                    <>
                      <span>{formatSignificant(headerRange.min)}</span>
                      <span>→</span>
                      <span>
                        {formatSignificant(headerRange.max)} {headerUnit}
                      </span>
                    </>
                  ) : (
                    <>
                      {rangeEdit?.jointId === entry.jointId && rangeEdit.field === "min" ? (
                        <input
                          type="number"
                          step={0.001}
                          value={rangeEdit.value}
                          onChange={(e) => setRangeEdit((prev) => (prev ? { ...prev, value: e.target.value } : prev))}
                          onBlur={() => commitRangeEdit(entry)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRangeEdit(entry);
                            if (e.key === "Escape") cancelRangeEdit();
                          }}
                          autoFocus
                          style={{
                            width: 60,
                            height: 20,
                            padding: "0 4px",
                            borderRadius: 4,
                            border: "1px solid rgba(255,255,255,0.2)",
                            background: "rgba(255,255,255,0.06)",
                            color: "rgba(255,255,255,0.9)",
                            fontSize: 10,
                          }}
                        />
                      ) : (
                        <span
                          onDoubleClick={() => beginRangeEdit(entry.jointId, "min", entry.range.min)}
                          style={{ cursor: "pointer", textDecoration: "underline dotted" }}
                          title="Doble click para editar límite inferior"
                        >
                          {formatSignificant(entry.range.min)}
                        </span>
                      )}
                      <span>→</span>
                      {rangeEdit?.jointId === entry.jointId && rangeEdit.field === "max" ? (
                        <input
                          type="number"
                          step={0.001}
                          value={rangeEdit.value}
                          onChange={(e) => setRangeEdit((prev) => (prev ? { ...prev, value: e.target.value } : prev))}
                          onBlur={() => commitRangeEdit(entry)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRangeEdit(entry);
                            if (e.key === "Escape") cancelRangeEdit();
                          }}
                          autoFocus
                          style={{
                            width: 60,
                            height: 20,
                            padding: "0 4px",
                            borderRadius: 4,
                            border: "1px solid rgba(255,255,255,0.2)",
                            background: "rgba(255,255,255,0.06)",
                            color: "rgba(255,255,255,0.9)",
                            fontSize: 10,
                          }}
                        />
                      ) : (
                        <span
                          onDoubleClick={() => beginRangeEdit(entry.jointId, "max", entry.range.max)}
                          style={{ cursor: "pointer", textDecoration: "underline dotted" }}
                          title="Doble click para editar límite superior"
                        >
                          {formatSignificant(entry.range.max)}
                        </span>
                      )}
                      <span>{unit}</span>
                    </>
                  )}
                </div>
              </div>

              {showPosition && (
                <div style={{ display: "grid", gap: 4 }}>
                  <div style={{ fontSize: 11, opacity: 0.6 }}>Posición ({unit})</div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: hasPositionLimits ? "1fr 90px" : "90px",
                      gap: 8,
                      alignItems: "center",
                      justifyContent: hasPositionLimits ? "stretch" : "end",
                    }}
                  >
                    {hasPositionLimits && (
                      <input
                        type="range"
                        min={entry.range.min}
                        max={entry.range.max}
                        step={0.001}
                        value={safeTarget}
                        onChange={(e) => handleChange(Number(e.target.value))}
                      />
                    )}
                    <input
                      type="number"
                      step={0.001}
                      min={hasPositionLimits ? entry.range.min : undefined}
                      max={hasPositionLimits ? entry.range.max : undefined}
                      value={safeTarget}
                      onChange={(e) => handleChange(Number(e.target.value))}
                      style={{
                        height: 26,
                        padding: "0 6px",
                        borderRadius: 6,
                        border: "1px solid rgba(255,255,255,0.12)",
                        background: "rgba(255,255,255,0.06)",
                        color: "rgba(255,255,255,0.9)",
                        fontSize: 12,
                      }}
                    />
                  </div>
                </div>
              )}

              {showVelocity && (
                <div style={{ display: "grid", gap: 4 }}>
                  <div style={{ fontSize: 11, opacity: 0.6 }}>Velocidad ({velocityUnit})</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 90px", gap: 8, alignItems: "center" }}>
                    <input
                      type="range"
                      min={velocityDisplayRange.min}
                      max={velocityDisplayRange.max}
                      step={0.01}
                      value={safeVelocity}
                      onChange={(e) => handleVelocityChange(Number(e.target.value))}
                    />
                    <input
                      type="number"
                      step={0.01}
                      min={velocityDisplayRange.min}
                      max={velocityDisplayRange.max}
                      value={safeVelocity}
                      onChange={(e) => handleVelocityChange(Number(e.target.value))}
                      style={{
                        height: 26,
                        padding: "0 6px",
                        borderRadius: 6,
                        border: "1px solid rgba(255,255,255,0.12)",
                        background: "rgba(255,255,255,0.06)",
                        color: "rgba(255,255,255,0.9)",
                        fontSize: 12,
                      }}
                    />
                  </div>
                </div>
              )}

              {showTorque && (
                <div style={{ display: "grid", gap: 4 }}>
                  <div style={{ fontSize: 11, opacity: 0.6 }}>Torque ({torqueUnit})</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 90px", gap: 8, alignItems: "center" }}>
                    <input
                      type="range"
                      min={entry.effortRange.min}
                      max={entry.effortRange.max}
                      step={0.01}
                      value={safeTorque}
                      onChange={(e) => handleTorqueChange(Number(e.target.value))}
                    />
                    <input
                      type="number"
                      step={0.01}
                      min={entry.effortRange.min}
                      max={entry.effortRange.max}
                      value={safeTorque}
                      onChange={(e) => handleTorqueChange(Number(e.target.value))}
                      style={{
                        height: 26,
                        padding: "0 6px",
                        borderRadius: 6,
                        border: "1px solid rgba(255,255,255,0.12)",
                        background: "rgba(255,255,255,0.06)",
                        color: "rgba(255,255,255,0.9)",
                        fontSize: 12,
                      }}
                    />
                  </div>
                </div>
              )}
              {showInitial && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 90px", gap: 8, alignItems: "center" }}>
                  <div style={{ fontSize: 11, opacity: 0.6 }}>Inicial</div>
                  <input
                    type="number"
                    step={0.001}
                    min={hasPositionLimits ? entry.range.min : undefined}
                    max={hasPositionLimits ? entry.range.max : undefined}
                    value={safeInitial}
                    onChange={(e) => handleInitialChange(Number(e.target.value))}
                    style={{
                      height: 26,
                      padding: "0 6px",
                      borderRadius: 6,
                      border: "1px solid rgba(255,255,255,0.12)",
                      background: "rgba(255,255,255,0.06)",
                      color: "rgba(255,255,255,0.9)",
                      fontSize: 12,
                    }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
