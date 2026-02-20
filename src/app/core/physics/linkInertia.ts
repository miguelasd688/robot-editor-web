import * as THREE from "three";
import type { InertiaTensor, InstancePhysics, Vec3 } from "../assets/types";
import { computeInertiaFromGeom, computeVolumeFromGeom, inferGeomInfo } from "./geomUtils";

type LinkInertiaResult = {
  mass: number;
  com: Vec3;
  inertia: Vec3;
  inertiaTensor: InertiaTensor;
};

type MeshInfo = {
  geom: ReturnType<typeof inferGeomInfo>;
  volume: number;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
};

const EPS = 1e-9;

const zeroTensor = (): InertiaTensor => ({
  ixx: 0,
  iyy: 0,
  izz: 0,
  ixy: 0,
  ixz: 0,
  iyz: 0,
});

const tensorFromDiag = (diag: Vec3): InertiaTensor => ({
  ixx: diag.x,
  iyy: diag.y,
  izz: diag.z,
  ixy: 0,
  ixz: 0,
  iyz: 0,
});

const addTensor = (a: InertiaTensor, b: InertiaTensor): InertiaTensor => ({
  ixx: a.ixx + b.ixx,
  iyy: a.iyy + b.iyy,
  izz: a.izz + b.izz,
  ixy: a.ixy + b.ixy,
  ixz: a.ixz + b.ixz,
  iyz: a.iyz + b.iyz,
});

const rotationMatrixFromQuat = (q: THREE.Quaternion) => {
  const x = q.x;
  const y = q.y;
  const z = q.z;
  const w = q.w;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;

  return [
    1 - 2 * (yy + zz),
    2 * (xy - wz),
    2 * (xz + wy),
    2 * (xy + wz),
    1 - 2 * (xx + zz),
    2 * (yz - wx),
    2 * (xz - wy),
    2 * (yz + wx),
    1 - 2 * (xx + yy),
  ] as const;
};

const tensorToMatrix = (t: InertiaTensor) => [
  t.ixx,
  t.ixy,
  t.ixz,
  t.ixy,
  t.iyy,
  t.iyz,
  t.ixz,
  t.iyz,
  t.izz,
] as const;

const matrixToTensor = (m: readonly number[]): InertiaTensor => ({
  ixx: m[0],
  ixy: m[1],
  ixz: m[2],
  iyy: m[4],
  iyz: m[5],
  izz: m[8],
});

const transpose = (m: readonly number[]) =>
  [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]] as const;

const mul = (a: readonly number[], b: readonly number[]) => [
  a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
  a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
  a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
  a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
  a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
  a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
  a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
  a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
  a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
] as const;

const rotateTensor = (tensor: InertiaTensor, quat: THREE.Quaternion) => {
  const r = rotationMatrixFromQuat(quat);
  const i = tensorToMatrix(tensor);
  const rt = transpose(r);
  const tmp = mul(r, i);
  const out = mul(tmp, rt);
  return matrixToTensor(out);
};

const applyParallelAxis = (tensor: InertiaTensor, mass: number, offset: THREE.Vector3): InertiaTensor => {
  if (mass <= 0) return tensor;
  const dx = offset.x;
  const dy = offset.y;
  const dz = offset.z;
  const d2 = dx * dx + dy * dy + dz * dz;
  const add = {
    ixx: mass * (d2 - dx * dx),
    iyy: mass * (d2 - dy * dy),
    izz: mass * (d2 - dz * dz),
    ixy: -mass * dx * dy,
    ixz: -mass * dx * dz,
    iyz: -mass * dy * dz,
  };
  return addTensor(tensor, add);
};

const collectVisualMeshes = (linkObj: THREE.Object3D): THREE.Mesh[] => {
  const visuals: THREE.Object3D[] = [];
  const stack = [linkObj];
  while (stack.length) {
    const obj = stack.pop() as THREE.Object3D;
    if (obj !== linkObj && obj.userData?.editorKind === "link") continue;
    if (obj.userData?.editorKind === "collision") continue;
    if (obj.userData?.editorKind === "visual") {
      let cur = obj.parent;
      let hasVisualAncestor = false;
      while (cur && cur !== linkObj) {
        if (cur.userData?.editorKind === "visual") {
          hasVisualAncestor = true;
          break;
        }
        if (cur.userData?.editorKind === "link") break;
        cur = cur.parent;
      }
      if (!hasVisualAncestor) visuals.push(obj);
    }
    for (let i = obj.children.length - 1; i >= 0; i -= 1) {
      stack.push(obj.children[i]);
    }
  }

  const meshes: THREE.Mesh[] = [];
  for (const visual of visuals) {
    visual.traverse((child) => {
      if (child.userData?.editorKind === "collision") return;
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) meshes.push(mesh);
    });
  }
  return meshes;
};

export function computeLinkInertiaFromVisuals(
  linkObj: THREE.Object3D,
  physics: InstancePhysics
): LinkInertiaResult | null {
  if (physics.useDensity && !Number.isFinite(physics.density)) return null;
  linkObj.updateWorldMatrix(true, false);
  const linkWorldPos = new THREE.Vector3();
  const linkWorldQuat = new THREE.Quaternion();
  linkObj.getWorldPosition(linkWorldPos);
  linkObj.getWorldQuaternion(linkWorldQuat);
  const linkWorldQuatInv = linkWorldQuat.clone().invert();
  const meshes = collectVisualMeshes(linkObj);
  if (!meshes.length) return null;
  const infos: MeshInfo[] = [];

  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false);
    const geom = inferGeomInfo(mesh);
    const volume = computeVolumeFromGeom(geom) ?? 0;
    const meshWorldPos = new THREE.Vector3();
    const meshWorldQuat = new THREE.Quaternion();
    mesh.getWorldPosition(meshWorldPos);
    mesh.getWorldQuaternion(meshWorldQuat);
    const pos = meshWorldPos.sub(linkWorldPos).applyQuaternion(linkWorldQuatInv);
    const quat = linkWorldQuatInv.clone().multiply(meshWorldQuat);
    infos.push({ geom, volume, position: pos, quaternion: quat });
  }

  const totalVolume = infos.reduce((acc, item) => acc + Math.max(0, item.volume), 0);
  if (totalVolume <= EPS && !physics.useDensity) return null;

  let totalMass = physics.useDensity && Number.isFinite(physics.density) ? 0 : Math.max(0, physics.mass);
  if (!physics.useDensity && totalMass <= EPS) return null;

  const weightedPos = new THREE.Vector3();
  const perMeshMasses: number[] = [];

  let tensor = zeroTensor();

  for (const info of infos) {
    const volume = Math.max(0, info.volume);
    const mass = physics.useDensity
      ? Math.max(0, physics.density * volume)
      : totalVolume > EPS
        ? totalMass * (volume / totalVolume)
        : 0;
    perMeshMasses.push(mass);
    if (physics.useDensity) totalMass += mass;
    if (mass > 0) {
      weightedPos.addScaledVector(info.position, mass);
    }
  }

  if (totalMass <= EPS) return null;

  const comVec = weightedPos.multiplyScalar(1 / totalMass);

  for (let i = 0; i < infos.length; i += 1) {
    const info = infos[i];
    const mass = perMeshMasses[i] ?? 0;
    if (mass <= 0) continue;
    const diag = computeInertiaFromGeom(info.geom, mass);
    if (!diag) continue;
    let part = tensorFromDiag(diag);
    part = rotateTensor(part, info.quaternion);
    const offset = new THREE.Vector3().subVectors(info.position, comVec);
    part = applyParallelAxis(part, mass, offset);
    tensor = addTensor(tensor, part);
  }

  const inertia = {
    x: Math.max(EPS, tensor.ixx),
    y: Math.max(EPS, tensor.iyy),
    z: Math.max(EPS, tensor.izz),
  };

  return {
    mass: totalMass,
    com: { x: comVec.x, y: comVec.y, z: comVec.z },
    inertia,
    inertiaTensor: {
      ixx: inertia.x,
      iyy: inertia.y,
      izz: inertia.z,
      ixy: tensor.ixy,
      ixz: tensor.ixz,
      iyz: tensor.iyz,
    },
  };
}
