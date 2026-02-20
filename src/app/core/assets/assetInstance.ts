import * as THREE from "three";
import type { InertiaTensor, InstanceInitial, InstancePhysics, PhysicsFields, Quat, UserInstance, Vec3 } from "./types";
import { applyDensityToPhysics, collectPhysicsFields, resolvePhysics } from "./assetInstancePhysics";

const toVec3 = (v: THREE.Vector3): Vec3 => ({ x: v.x, y: v.y, z: v.z });
const toQuat = (q: THREE.Quaternion): Quat => ({ x: q.x, y: q.y, z: q.z, w: q.w });

const cloneVec3 = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });

export function ensureUserInstance(obj: THREE.Object3D): UserInstance {
  const existing = obj.userData?.instance as UserInstance | undefined;
  const initial =
    existing?.initial ?? {
      position: toVec3(obj.position),
      quaternion: toQuat(obj.quaternion),
      scale: toVec3(obj.scale),
    };
  const physics = resolvePhysics(obj, existing?.physics);
  const physicsData = obj.userData?.physics ?? {};
  const fields = { ...(existing?.fields ?? {}), ...collectPhysicsFields(physicsData) };
  const instance: UserInstance = { initial, physics, fields };

  obj.userData.instance = instance;

  return instance;
}

export function setInitialFromObject(obj: THREE.Object3D): InstanceInitial {
  const instance = ensureUserInstance(obj);
  instance.initial = {
    position: toVec3(obj.position),
    quaternion: toQuat(obj.quaternion),
    scale: toVec3(obj.scale),
  };
  obj.userData.instance = instance;
  return instance.initial;
}

export function applyInitialTransform(obj: THREE.Object3D) {
  const instance = ensureUserInstance(obj);
  const { position, quaternion, scale } = instance.initial;
  obj.position.set(position.x, position.y, position.z);
  obj.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
  obj.scale.set(scale.x, scale.y, scale.z);
}

export function updateInstancePhysics(
  obj: THREE.Object3D,
  patch: Partial<InstancePhysics> & { inertia?: Partial<Vec3>; inertiaTensor?: Partial<InertiaTensor> },
  options?: { markExplicit?: boolean }
): InstancePhysics {
  const instance = ensureUserInstance(obj);
  const markExplicit = options?.markExplicit ?? true;
  let next: InstancePhysics = {
    ...instance.physics,
    ...patch,
    inertia: { ...instance.physics.inertia, ...(patch.inertia ?? {}) },
    inertiaTensor: instance.physics.inertiaTensor
      ? { ...instance.physics.inertiaTensor, ...(patch.inertiaTensor ?? {}) }
      : patch.inertiaTensor
        ? {
            ixx: patch.inertiaTensor.ixx ?? instance.physics.inertia.x,
            iyy: patch.inertiaTensor.iyy ?? instance.physics.inertia.y,
            izz: patch.inertiaTensor.izz ?? instance.physics.inertia.z,
            ixy: patch.inertiaTensor.ixy ?? 0,
            ixz: patch.inertiaTensor.ixz ?? 0,
            iyz: patch.inertiaTensor.iyz ?? 0,
          }
        : undefined,
  };
  if (patch.inertia && !patch.inertiaTensor) {
    const tensor = next.inertiaTensor ?? {
      ixx: next.inertia.x,
      iyy: next.inertia.y,
      izz: next.inertia.z,
      ixy: 0,
      ixz: 0,
      iyz: 0,
    };
    next.inertiaTensor = { ...tensor, ixx: next.inertia.x, iyy: next.inertia.y, izz: next.inertia.z };
  }

  next = applyDensityToPhysics(obj, next);
  const nextFields: PhysicsFields = { ...instance.fields };
  if (markExplicit) {
    if (patch.mass !== undefined) nextFields.mass = true;
    if (patch.density !== undefined) nextFields.density = true;
    if (patch.inertia !== undefined) nextFields.inertia = true;
    if (patch.inertiaTensor !== undefined) nextFields.inertiaTensor = true;
    if (patch.com !== undefined) nextFields.com = true;
    if (patch.friction !== undefined) nextFields.friction = true;
    if (patch.restitution !== undefined) nextFields.restitution = true;
    if (patch.collisionsEnabled !== undefined) nextFields.collisionsEnabled = true;
    if (patch.fixed !== undefined) nextFields.fixed = true;
    if (patch.useDensity !== undefined) nextFields.useDensity = true;
  }
  instance.physics = next;
  instance.fields = nextFields;
  obj.userData.instance = instance;
  if (markExplicit) {
    const physicsData = { ...(obj.userData.physics ?? {}) };
    if (nextFields.mass) physicsData.mass = next.mass;
    if (nextFields.density) physicsData.density = next.density;
    if (nextFields.inertia) physicsData.inertia = cloneVec3(next.inertia);
    if (nextFields.inertiaTensor && next.inertiaTensor) physicsData.inertiaTensor = { ...next.inertiaTensor };
    if (nextFields.com && next.com) physicsData.com = cloneVec3(next.com);
    if (nextFields.friction) physicsData.friction = next.friction;
    if (nextFields.restitution) physicsData.restitution = next.restitution;
    if (nextFields.collisionsEnabled) physicsData.collisionsEnabled = next.collisionsEnabled;
    if (nextFields.fixed) physicsData.fixed = next.fixed;
    if (nextFields.useDensity) physicsData.useDensity = next.useDensity;
    obj.userData.physics = physicsData;
  }
  return next;
}
