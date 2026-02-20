import * as THREE from "three";
import type { InstancePhysics, Vec3 } from "../../../assets/types";
import { computeInertiaFromGeom, computeVolumeFromGeom, inferGeomInfo } from "../../../physics/geomUtils";

const EPS = 1e-6;

const safeRatio = (to: number, from: number) => {
  if (Math.abs(from) < EPS) return 1;
  return to / from;
};

const computeScaleRatios = (from: Vec3, to: Vec3) => ({
  x: Math.abs(safeRatio(to.x, from.x)),
  y: Math.abs(safeRatio(to.y, from.y)),
  z: Math.abs(safeRatio(to.z, from.z)),
});

export function scalePhysicsForTransform(
  obj: THREE.Object3D,
  physics: InstancePhysics,
  fromScale: Vec3,
  toScale: Vec3
): InstancePhysics | null {
  const scaleChanged =
    Math.abs(toScale.x - fromScale.x) > EPS ||
    Math.abs(toScale.y - fromScale.y) > EPS ||
    Math.abs(toScale.z - fromScale.z) > EPS;
  if (!scaleChanged) return null;

  const ratios = computeScaleRatios(fromScale, toScale);
  const volumeScale = Math.abs(ratios.x * ratios.y * ratios.z);
  const geomInfo = inferGeomInfo(obj);
  const volume = computeVolumeFromGeom(geomInfo);
  const mass =
    physics.useDensity && Number.isFinite(physics.density) && volume !== null
      ? Math.max(0, physics.density * volume)
      : physics.mass * volumeScale;
  const inertia = computeInertiaFromGeom(geomInfo, mass) ?? physics.inertia;
  const inertiaTensor = inertia
    ? { ixx: inertia.x, iyy: inertia.y, izz: inertia.z, ixy: 0, ixz: 0, iyz: 0 }
    : physics.inertiaTensor;
  const com = physics.com
    ? { x: physics.com.x * ratios.x, y: physics.com.y * ratios.y, z: physics.com.z * ratios.z }
    : physics.com;
  return { ...physics, mass, inertia, inertiaTensor, com };
}
