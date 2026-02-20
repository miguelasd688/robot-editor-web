import * as THREE from "three";
import { computeInertiaFromGeom, computeVolumeFromGeom, inferGeomInfo, isValidInertia } from "../physics/geomUtils";
import type { InertiaTensor, InstancePhysics, PhysicsFields, Vec3 } from "./types";

export const defaultPhysics: InstancePhysics = {
  mass: 1,
  density: 100,
  inertia: { x: 1, y: 1, z: 1 },
  inertiaTensor: { ixx: 1, iyy: 1, izz: 1, ixy: 0, ixz: 0, iyz: 0 },
  com: { x: 0, y: 0, z: 0 },
  friction: 0.8,
  restitution: 0,
  collisionsEnabled: true,
  fixed: false,
  useDensity: false,
};

export function collectPhysicsFields(physicsData: Record<string, unknown>): PhysicsFields {
  const fields: PhysicsFields = {};
  if (Object.prototype.hasOwnProperty.call(physicsData, "mass")) fields.mass = true;
  if (Object.prototype.hasOwnProperty.call(physicsData, "density")) fields.density = true;
  if (Object.prototype.hasOwnProperty.call(physicsData, "inertia")) fields.inertia = true;
  if (Object.prototype.hasOwnProperty.call(physicsData, "inertiaTensor")) fields.inertiaTensor = true;
  if (Object.prototype.hasOwnProperty.call(physicsData, "com")) fields.com = true;
  if (Object.prototype.hasOwnProperty.call(physicsData, "friction")) fields.friction = true;
  if (Object.prototype.hasOwnProperty.call(physicsData, "restitution")) fields.restitution = true;
  if (Object.prototype.hasOwnProperty.call(physicsData, "collisionsEnabled")) fields.collisionsEnabled = true;
  if (Object.prototype.hasOwnProperty.call(physicsData, "fixed")) fields.fixed = true;
  if (Object.prototype.hasOwnProperty.call(physicsData, "useDensity")) fields.useDensity = true;
  return fields;
}

export function resolvePhysics(obj: THREE.Object3D, existing?: InstancePhysics): InstancePhysics {
  const physicsData = obj.userData?.physics ?? {};
  const useDensity =
    typeof physicsData?.useDensity === "boolean"
      ? physicsData.useDensity
      : existing?.useDensity ?? defaultPhysics.useDensity;
  const density = typeof physicsData?.density === "number" ? physicsData.density : existing?.density ?? defaultPhysics.density;
  const fromPhysics = typeof physicsData?.mass === "number" ? physicsData.mass : undefined;
  const fromMass = typeof obj.userData?.mass === "number" ? obj.userData.mass : undefined;
  const inertiaData = physicsData?.inertia as Vec3 | undefined;
  const inertiaTensorData = physicsData?.inertiaTensor as InertiaTensor | undefined;
  const comData = physicsData?.com as Vec3 | undefined;
  const geomInfo = inferGeomInfo(obj);
  const volume = computeVolumeFromGeom(geomInfo);
  const massFromDensity =
    useDensity && Number.isFinite(density) && volume !== null ? Math.max(0, density * volume) : undefined;
  const mass = massFromDensity ?? fromPhysics ?? fromMass ?? existing?.mass ?? defaultPhysics.mass;
  const autoInertia = computeInertiaFromGeom(geomInfo, mass);
  const autoTensor: InertiaTensor | undefined = autoInertia
    ? { ixx: autoInertia.x, iyy: autoInertia.y, izz: autoInertia.z, ixy: 0, ixz: 0, iyz: 0 }
    : undefined;
  const collisionsEnabled =
    typeof physicsData?.collisionsEnabled === "boolean"
      ? physicsData.collisionsEnabled
      : existing?.collisionsEnabled ?? defaultPhysics.collisionsEnabled;
  let fixed = typeof physicsData?.fixed === "boolean" ? physicsData.fixed : existing?.fixed ?? defaultPhysics.fixed;
  if (typeof physicsData?.fixed !== "boolean" && existing?.fixed === undefined && mass <= 0) {
    fixed = true;
  }
  let inertia = inertiaData
    ? {
        x: Number.isFinite(inertiaData.x) ? inertiaData.x : existing?.inertia?.x ?? defaultPhysics.inertia.x,
        y: Number.isFinite(inertiaData.y) ? inertiaData.y : existing?.inertia?.y ?? defaultPhysics.inertia.y,
        z: Number.isFinite(inertiaData.z) ? inertiaData.z : existing?.inertia?.z ?? defaultPhysics.inertia.z,
      }
    : autoInertia && isValidInertia(autoInertia)
      ? autoInertia
      : existing?.inertia ?? defaultPhysics.inertia;

  if (inertiaTensorData) {
    inertia = {
      x: Number.isFinite(inertiaTensorData.ixx) ? inertiaTensorData.ixx : inertia.x,
      y: Number.isFinite(inertiaTensorData.iyy) ? inertiaTensorData.iyy : inertia.y,
      z: Number.isFinite(inertiaTensorData.izz) ? inertiaTensorData.izz : inertia.z,
    };
  }

  const inertiaTensor: InertiaTensor | undefined = inertiaTensorData
    ? {
        ixx: Number.isFinite(inertiaTensorData.ixx) ? inertiaTensorData.ixx : inertia.x,
        iyy: Number.isFinite(inertiaTensorData.iyy) ? inertiaTensorData.iyy : inertia.y,
        izz: Number.isFinite(inertiaTensorData.izz) ? inertiaTensorData.izz : inertia.z,
        ixy: Number.isFinite(inertiaTensorData.ixy) ? inertiaTensorData.ixy : 0,
        ixz: Number.isFinite(inertiaTensorData.ixz) ? inertiaTensorData.ixz : 0,
        iyz: Number.isFinite(inertiaTensorData.iyz) ? inertiaTensorData.iyz : 0,
      }
    : autoTensor
      ? autoTensor
      : existing?.inertiaTensor
        ? { ...existing.inertiaTensor }
        : { ixx: inertia.x, iyy: inertia.y, izz: inertia.z, ixy: 0, ixz: 0, iyz: 0 };

  const com: Vec3 =
    comData && Number.isFinite(comData.x) && Number.isFinite(comData.y) && Number.isFinite(comData.z)
      ? { x: comData.x, y: comData.y, z: comData.z }
      : existing?.com ?? defaultPhysics.com ?? { x: 0, y: 0, z: 0 };

  return {
    mass,
    density,
    inertia,
    inertiaTensor,
    com,
    friction: typeof physicsData?.friction === "number" ? physicsData.friction : existing?.friction ?? defaultPhysics.friction,
    restitution:
      typeof physicsData?.restitution === "number"
        ? physicsData.restitution
        : existing?.restitution ?? defaultPhysics.restitution,
    collisionsEnabled,
    fixed,
    useDensity,
  };
}

export function applyDensityToPhysics(obj: THREE.Object3D, physics: InstancePhysics): InstancePhysics {
  if (!physics.useDensity) return physics;
  const geomInfo = inferGeomInfo(obj);
  const volume = computeVolumeFromGeom(geomInfo);
  if (volume === null || !Number.isFinite(physics.density)) return physics;
  const mass = Math.max(0, physics.density * volume);
  const inertia = computeInertiaFromGeom(geomInfo, mass) ?? physics.inertia;
  const inertiaTensor: InertiaTensor | undefined = inertia
    ? { ixx: inertia.x, iyy: inertia.y, izz: inertia.z, ixy: 0, ixz: 0, iyz: 0 }
    : physics.inertiaTensor;
  return {
    ...physics,
    mass,
    inertia,
    inertiaTensor,
  };
}
