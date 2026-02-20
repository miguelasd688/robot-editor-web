import * as THREE from "three";
import type { InertiaTensor } from "../assets/types";

type EigenDecomp = {
  values: [number, number, number];
  vectors: [number, number, number, number, number, number, number, number, number];
};

type InertiaBoxOptions = {
  mass?: number;
  minSize?: number;
  massScale?: "none" | "volume" | "linear";
};

export type InertiaBoxResult = {
  size: THREE.Vector3;
  rotation: THREE.Quaternion;
};

const jacobiEigenDecomposition = (matrix: readonly number[], maxIter = 32, eps = 1e-10): EigenDecomp => {
  const a = [...matrix];
  const v: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];

  for (let iter = 0; iter < maxIter; iter += 1) {
    let p = 0;
    let q = 1;
    let max = Math.abs(a[1]);
    const a02 = Math.abs(a[2]);
    const a12 = Math.abs(a[5]);
    if (a02 > max) {
      max = a02;
      p = 0;
      q = 2;
    }
    if (a12 > max) {
      max = a12;
      p = 1;
      q = 2;
    }

    if (max < eps) break;

    const app = a[p * 3 + p];
    const aqq = a[q * 3 + q];
    const apq = a[p * 3 + q];
    const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
    const c = Math.cos(phi);
    const s = Math.sin(phi);

    for (let i = 0; i < 3; i += 1) {
      if (i === p || i === q) continue;
      const aip = a[i * 3 + p];
      const aiq = a[i * 3 + q];
      a[i * 3 + p] = c * aip - s * aiq;
      a[i * 3 + q] = s * aip + c * aiq;
      a[p * 3 + i] = a[i * 3 + p];
      a[q * 3 + i] = a[i * 3 + q];
    }

    const appNew = c * c * app - 2 * s * c * apq + s * s * aqq;
    const aqqNew = s * s * app + 2 * s * c * apq + c * c * aqq;
    a[p * 3 + p] = appNew;
    a[q * 3 + q] = aqqNew;
    a[p * 3 + q] = 0;
    a[q * 3 + p] = 0;

    for (let i = 0; i < 3; i += 1) {
      const vip = v[i * 3 + p];
      const viq = v[i * 3 + q];
      v[i * 3 + p] = c * vip - s * viq;
      v[i * 3 + q] = s * vip + c * viq;
    }
  }

  const values: [number, number, number] = [a[0], a[4], a[8]];
  const vectors = v as EigenDecomp["vectors"];

  const order = [0, 1, 2].sort((i, j) => values[j] - values[i]);
  const sortedValues: [number, number, number] = [
    values[order[0]],
    values[order[1]],
    values[order[2]],
  ];
  const sortedVectors: EigenDecomp["vectors"] = [
    vectors[order[0]], vectors[order[1]], vectors[order[2]],
    vectors[3 + order[0]], vectors[3 + order[1]], vectors[3 + order[2]],
    vectors[6 + order[0]], vectors[6 + order[1]], vectors[6 + order[2]],
  ];

  const v0 = new THREE.Vector3(sortedVectors[0], sortedVectors[3], sortedVectors[6]);
  const v1 = new THREE.Vector3(sortedVectors[1], sortedVectors[4], sortedVectors[7]);
  const v2 = new THREE.Vector3(sortedVectors[2], sortedVectors[5], sortedVectors[8]);
  const cross = new THREE.Vector3().crossVectors(v0, v1);
  if (cross.dot(v2) < 0) {
    v2.multiplyScalar(-1);
    sortedVectors[2] = v2.x;
    sortedVectors[5] = v2.y;
    sortedVectors[8] = v2.z;
  }

  return { values: sortedValues, vectors: sortedVectors };
};

const normalizeTensor = (tensor: InertiaTensor) => {
  const ixy = 0.5 * (tensor.ixy + tensor.ixy);
  const ixz = 0.5 * (tensor.ixz + tensor.ixz);
  const iyz = 0.5 * (tensor.iyz + tensor.iyz);
  return {
    ixx: tensor.ixx,
    iyy: tensor.iyy,
    izz: tensor.izz,
    ixy,
    ixz,
    iyz,
  };
};

export const computeComRadius = (mass: number, base = 0.05, min = 0.01) => {
  if (!Number.isFinite(mass) || mass <= 0) return min;
  const scaled = base * Math.cbrt(Math.max(1e-6, mass));
  return Math.max(min, scaled);
};

export const computeInertiaBox = (tensor: InertiaTensor, options?: InertiaBoxOptions): InertiaBoxResult | null => {
  const minSize = options?.minSize ?? 0.01;
  const safeMass = Number.isFinite(options?.mass) && options?.mass && options.mass > 0 ? options.mass : 1;
  const massScaleMode = options?.massScale ?? "volume";

  const t = normalizeTensor(tensor);
  const values = [
    t.ixx,
    t.ixy,
    t.ixz,
    t.ixy,
    t.iyy,
    t.iyz,
    t.ixz,
    t.iyz,
    t.izz,
  ];
  if (values.some((v) => !Number.isFinite(v))) return null;

  const { values: principal, vectors } = jacobiEigenDecomposition(values);
  const i1 = Math.max(1e-9, Math.abs(principal[0]));
  const i2 = Math.max(1e-9, Math.abs(principal[1]));
  const i3 = Math.max(1e-9, Math.abs(principal[2]));
  const sx2 = (6 / safeMass) * Math.max(1e-9, i2 + i3 - i1);
  const sy2 = (6 / safeMass) * Math.max(1e-9, i1 + i3 - i2);
  const sz2 = (6 / safeMass) * Math.max(1e-9, i1 + i2 - i3);
  const size = new THREE.Vector3(
    Math.max(minSize, Math.sqrt(sx2)),
    Math.max(minSize, Math.sqrt(sy2)),
    Math.max(minSize, Math.sqrt(sz2))
  );

  let massScale = 1;
  if (massScaleMode === "linear") massScale = Math.max(1e-6, safeMass);
  if (massScaleMode === "volume") massScale = Math.cbrt(Math.max(1e-6, safeMass));
  size.multiplyScalar(massScale);

  const rotMat = new THREE.Matrix4().set(
    vectors[0], vectors[1], vectors[2], 0,
    vectors[3], vectors[4], vectors[5], 0,
    vectors[6], vectors[7], vectors[8], 0,
    0, 0, 0, 1
  );
  const rotation = new THREE.Quaternion().setFromRotationMatrix(rotMat);

  return { size, rotation };
};
