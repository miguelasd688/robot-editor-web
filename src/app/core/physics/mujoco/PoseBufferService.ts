import { sanitizeMjcfName, type MjcfNameMap } from "./mjcfNames";
import type { JointActuatorConfig, MujocoRuntime } from "./MujocoRuntime";

export type PoseTargets = Record<string, number>;
export type PoseTargetsByRobot = Record<string, PoseTargets>;
export type PoseConfigsByRobot = Record<string, Record<string, JointActuatorConfig>>;

export type JointKeyResolver = (robotId: string, jointId: string) => string | null;

export function resolveJointKey(robotId: string, jointName: string, nameMap?: MjcfNameMap | null) {
  const safeRobot = sanitizeMjcfName(robotId);
  const safeJoint = sanitizeMjcfName(jointName);
  return nameMap?.joints?.[jointName] ?? `${safeRobot}_${safeJoint}`;
}

export function mapPoseByRobot<T>(
  byRobot: Record<string, Record<string, T>>,
  resolver: JointKeyResolver
): Record<string, T> {
  const merged: Record<string, T> = {};
  for (const [robotId, entries] of Object.entries(byRobot)) {
    for (const [jointId, value] of Object.entries(entries)) {
      const key = resolver(robotId, jointId);
      if (!key) continue;
      merged[key] = value as T;
    }
  }
  return merged;
}

export function applyPose(
  runtimes: Iterable<MujocoRuntime>,
  targets: PoseTargets,
  options?: { preview?: boolean; previewTargets?: PoseTargets }
) {
  for (const rt of runtimes) {
    rt.setActuatorTargets(targets);
    if (options?.preview) {
      rt.setJointPositions(options.previewTargets ?? targets);
    }
  }
}
