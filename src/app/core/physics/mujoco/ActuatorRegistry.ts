import type { ProjectDoc } from "../../editor/document/types";
import type { UrdfJoint } from "../../urdf/urdfModel";
import type { JointActuatorConfig } from "./MujocoRuntime";
import type { MjcfNameMap } from "./mjcfNames";
import { resolveJointKey } from "./PoseBufferService";

export type ActuatorDescriptor = {
  robotId: string;
  jointId: string;
  jointName: string;
  type: UrdfJoint["type"];
  mjcfJoint: string;
  actuatorName: string;
  range: { min: number; max: number };
  velocityRange: { min: number; max: number };
  effortRange: { min: number; max: number };
  initialPosition: number;
  stiffness: number;
  damping: number;
  continuous: boolean;
  actuatorType: "position" | "velocity" | "torque";
  angular: boolean;
};

export type ActuatorRegistryResult = {
  registryByRobot: Record<string, ActuatorDescriptor[]>;
  initialTargetsByRobot: Record<string, Record<string, number>>;
  configsByRobot: Record<string, Record<string, JointActuatorConfig>>;
};

const DEFAULT_RANGE_RAD = Math.PI;
const DEFAULT_CONTINUOUS_RANGE_DEG = Number(import.meta.env.VITE_ACTUATOR_CONTINUOUS_RANGE_DEG ?? "360.00");
const DEFAULT_PRISMATIC_RANGE = 1;
const DEFAULT_STIFFNESS = Number(import.meta.env.VITE_URDF_ACTUATOR_STIFFNESS ?? "40");
const DEFAULT_DAMPING = Number(import.meta.env.VITE_URDF_ACTUATOR_DAMPING ?? "2");
const DEFAULT_EFFORT = Number(import.meta.env.VITE_URDF_DEFAULT_EFFORT ?? "60");
const DEFAULT_ANGULAR_VELOCITY_RPM = Number(import.meta.env.VITE_ACTUATOR_DEFAULT_VELOCITY_RPM ?? "200");
const DEFAULT_CONTINUOUS_VELOCITY_RPM = Number(import.meta.env.VITE_ACTUATOR_CONTINUOUS_VELOCITY_RPM ?? "100");
const DEFAULT_LINEAR_VELOCITY = Number(import.meta.env.VITE_URDF_DEFAULT_VELOCITY ?? "1");
const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

const clamp = (value: number, min: number, max: number) => {
  if (value < min) return min;
  if (value > max) return max;
  return value;
};

const isAngularType = (type: UrdfJoint["type"]) => type !== "prismatic" && type !== "planar";

const toDegrees = (value: number) => value * RAD2DEG;
const rpmToDegPerSec = (value: number) => (value * 360) / 60;
const ANGULAR_DEG_AS_RAD_THRESHOLD = Math.PI * 2 + 1e-3;

const normalizeAngularLimitToRad = (value: number | undefined) => {
  if (!Number.isFinite(value)) return undefined;
  const numeric = value as number;
  // Backward compatibility:
  // Some joints may store angular limits in degrees (e.g. +/-180).
  // If the magnitude is clearly larger than a full turn in radians, treat it as degrees.
  if (Math.abs(numeric) > ANGULAR_DEG_AS_RAD_THRESHOLD) {
    return numeric * DEG2RAD;
  }
  return numeric;
};

const resolveRange = (joint: UrdfJoint) => {
  if (joint.type === "continuous") {
    const min = normalizeAngularLimitToRad(joint.limit?.lower) ?? -DEFAULT_CONTINUOUS_RANGE_DEG * DEG2RAD;
    const max = normalizeAngularLimitToRad(joint.limit?.upper) ?? DEFAULT_CONTINUOUS_RANGE_DEG * DEG2RAD;
    return min <= max ? { min, max } : { min: max, max: min };
  }
  if (joint.type === "prismatic" || joint.type === "planar") {
    const min = Number.isFinite(joint.limit?.lower) ? (joint.limit?.lower as number) : -DEFAULT_PRISMATIC_RANGE;
    const max = Number.isFinite(joint.limit?.upper) ? (joint.limit?.upper as number) : DEFAULT_PRISMATIC_RANGE;
    return min <= max ? { min, max } : { min: max, max: min };
  }
  const min = normalizeAngularLimitToRad(joint.limit?.lower) ?? -DEFAULT_RANGE_RAD;
  const max = normalizeAngularLimitToRad(joint.limit?.upper) ?? DEFAULT_RANGE_RAD;
  return min <= max ? { min, max } : { min: max, max: min };
};

const resolveInitialPosition = (joint: UrdfJoint, range: { min: number; max: number }) => {
  const raw = Number.isFinite(joint.actuator?.initialPosition) ? (joint.actuator?.initialPosition as number) : 0;
  if (joint.type === "continuous") return raw;
  return clamp(raw, range.min, range.max);
};

const resolveActuatorDefaults = (joint: UrdfJoint) => {
  const stiffness = Number.isFinite(joint.actuator?.stiffness) ? (joint.actuator?.stiffness as number) : DEFAULT_STIFFNESS;
  const damping = Number.isFinite(joint.actuator?.damping) ? (joint.actuator?.damping as number) : DEFAULT_DAMPING;
  return { stiffness, damping };
};

const resolveVelocityRange = (joint: UrdfJoint, angular: boolean) => {
  if (joint.type === "continuous") {
    const value = rpmToDegPerSec(DEFAULT_CONTINUOUS_VELOCITY_RPM);
    return { min: -value, max: value };
  }
  const limit = Number.isFinite(joint.limit?.velocity)
    ? (joint.limit?.velocity as number)
    : angular
      ? rpmToDegPerSec(DEFAULT_ANGULAR_VELOCITY_RPM) / RAD2DEG
      : DEFAULT_LINEAR_VELOCITY;
  const value = angular ? toDegrees(limit) : limit;
  return { min: -value, max: value };
};

const resolveEffortRange = (joint: UrdfJoint) => {
  const limit = Number.isFinite(joint.limit?.effort) ? (joint.limit?.effort as number) : DEFAULT_EFFORT;
  return { min: -limit, max: limit };
};

const usesContinuousError = (joint: UrdfJoint) => joint.type === "continuous" || joint.type === "revolute";
const isActuatorEnabled = (joint: UrdfJoint) => joint.actuator?.enabled !== false;

export function buildActuatorRegistry(
  doc: ProjectDoc,
  nameMapsByRobot: Record<string, MjcfNameMap>
): ActuatorRegistryResult {
  const nodes = doc.scene.nodes;
  const registryByRobot: Record<string, ActuatorDescriptor[]> = {};
  const initialTargetsByRobot: Record<string, Record<string, number>> = {};
  const configsByRobot: Record<string, Record<string, JointActuatorConfig>> = {};

  for (const node of Object.values(nodes)) {
    if (node.kind !== "robot") continue;
    const robotId = node.id;
    const list: ActuatorDescriptor[] = [];
    const initialTargets: Record<string, number> = {};
    const configs: Record<string, JointActuatorConfig> = {};
    const stack = [robotId];
    const nameMap = nameMapsByRobot[robotId];

    while (stack.length) {
      const id = stack.pop() as string;
      const current = nodes[id];
      if (!current) continue;
      for (const child of current.children) stack.push(child);
      const urdf = current.components?.urdf;
      if (!urdf || urdf.kind !== "joint") continue;
      const joint = urdf.joint;
      if (joint.type === "fixed" || joint.type === "floating") continue;
      if (!isActuatorEnabled(joint)) continue;

      const angular = isAngularType(joint.type);
      const rangeRad = resolveRange(joint);
      const range = angular
        ? { min: toDegrees(rangeRad.min), max: toDegrees(rangeRad.max) }
        : rangeRad;
      const initialRad = resolveInitialPosition(joint, rangeRad);
      const initial = angular ? toDegrees(initialRad) : initialRad;
      const { stiffness, damping } = resolveActuatorDefaults(joint);
      const mjcfJoint = resolveJointKey(robotId, joint.name, nameMap);
      const actuatorName = `${mjcfJoint}_motor`;
      // Revolute follows the same angular error path as continuous joints, but with joint limits.
      const continuous = usesContinuousError(joint);
      const rawActuatorType = joint.actuator?.type ?? "position";
      const actuatorType =
        joint.type === "revolute" && rawActuatorType === "velocity" ? "position" : rawActuatorType;
      const velocityRange = resolveVelocityRange(joint, angular);
      const effortRange = resolveEffortRange(joint);
      list.push({
        robotId,
        jointId: id,
        jointName: joint.name,
        type: joint.type,
        mjcfJoint,
        actuatorName,
        range,
        velocityRange,
        effortRange,
        initialPosition: initial,
        stiffness,
        damping,
        continuous,
        actuatorType,
        angular,
      });
      initialTargets[id] = initial;
      const maxForce = Math.max(Math.abs(effortRange.min), Math.abs(effortRange.max));
      configs[id] = { stiffness, damping, continuous, angular, mode: actuatorType, maxForce };
    }

    list.sort((a, b) => a.jointName.localeCompare(b.jointName));
    registryByRobot[robotId] = list;
    initialTargetsByRobot[robotId] = initialTargets;
    configsByRobot[robotId] = configs;
  }

  return { registryByRobot, initialTargetsByRobot, configsByRobot };
}
