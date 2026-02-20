import * as THREE from "three";

export type GeomInfo = {
  type: "box" | "sphere" | "cylinder" | "plane";
  size: string;
  halfSize?: THREE.Vector3;
  radius?: number;
  height?: number;
  // Axis convention for inferred primitives in editor space.
  // Three.js cylinders are built around local +Y.
  axis?: "x" | "y" | "z";
};

const EPS = 1e-6;

const clampPositive = (value: number, min = EPS) =>
  Number.isFinite(value) ? Math.max(min, value) : min;

export function inferGeomInfo(obj: THREE.Object3D): GeomInfo {
  const scale = new THREE.Vector3();
  obj.getWorldScale(scale);
  const sx = Math.abs(scale.x);
  const sy = Math.abs(scale.y);
  const sz = Math.abs(scale.z);
  const mesh = obj as THREE.Mesh;
  if ((mesh as any).isMesh && mesh.geometry) {
    const geo: any = mesh.geometry;
    if (geo.type === "BoxGeometry") {
      const w = geo.parameters?.width ?? 1;
      const h = geo.parameters?.height ?? 1;
      const d = geo.parameters?.depth ?? 1;
      const hx = Math.max(0.001, (w * sx) / 2);
      const hy = Math.max(0.001, (h * sy) / 2);
      const hz = Math.max(0.001, (d * sz) / 2);
      return {
        type: "box",
        size: `${hx.toFixed(4)} ${hy.toFixed(4)} ${hz.toFixed(4)}`,
        halfSize: new THREE.Vector3(hx, hy, hz),
      };
    }
    if (geo.type === "SphereGeometry") {
      const r = geo.parameters?.radius ?? 0.5;
      const maxScale = Math.max(sx, sy, sz);
      const radius = Math.max(0.001, r * maxScale);
      return { type: "sphere", size: `${radius.toFixed(4)}`, radius };
    }
    if (geo.type === "CylinderGeometry") {
      const radiusTop = geo.parameters?.radiusTop ?? 0.5;
      const radiusBottom = geo.parameters?.radiusBottom ?? radiusTop;
      const radius = Math.max(radiusTop, radiusBottom);
      const height = geo.parameters?.height ?? 1;
      const radiusScale = Math.max(sx, sz);
      const scaledRadius = Math.max(0.001, radius * radiusScale);
      const scaledHeight = Math.max(0.001, height * sy);
      return {
        type: "cylinder",
        size: `${scaledRadius.toFixed(4)} ${(scaledHeight / 2).toFixed(4)}`,
        radius: scaledRadius,
        height: scaledHeight,
        axis: "y",
      };
    }
    if (geo.type === "PlaneGeometry") {
      const w = geo.parameters?.width ?? 6;
      const h = geo.parameters?.height ?? 6;
      const hx = Math.max(0.001, (w * sx) / 2);
      const hy = Math.max(0.001, (h * sy) / 2);
      return {
        type: "plane",
        size: `${hx.toFixed(4)} ${hy.toFixed(4)} 0.1`,
        halfSize: new THREE.Vector3(hx, hy, 0.001),
      };
    }
  }

  const box = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3();
  box.getSize(size);
  const hx = Math.max(0.01, size.x / 2);
  const hy = Math.max(0.01, size.y / 2);
  const hz = Math.max(0.01, size.z / 2);
  return {
    type: "box",
    size: `${hx.toFixed(4)} ${hy.toFixed(4)} ${hz.toFixed(4)}`,
    halfSize: new THREE.Vector3(hx, hy, hz),
  };
}

export function computeInertiaFromGeom(geom: GeomInfo, mass: number): { x: number; y: number; z: number } | null {
  if (!Number.isFinite(mass) || mass <= 0) return null;

  if (geom.type === "sphere") {
    const r = clampPositive(geom.radius ?? 0);
    const i = 0.4 * mass * r * r;
    return { x: clampPositive(i), y: clampPositive(i), z: clampPositive(i) };
  }
  if (geom.type === "cylinder") {
    const r = clampPositive(geom.radius ?? 0);
    const h = clampPositive(geom.height ?? 0);
    const r2 = r * r;
    const h2 = h * h;
    const iAxis = (1 / 12) * mass * (3 * r2 + h2);
    const iLong = 0.5 * mass * r2;
    const axis = geom.axis ?? "z";
    if (axis === "x") {
      return { x: clampPositive(iLong), y: clampPositive(iAxis), z: clampPositive(iAxis) };
    }
    if (axis === "y") {
      return { x: clampPositive(iAxis), y: clampPositive(iLong), z: clampPositive(iAxis) };
    }
    return { x: clampPositive(iAxis), y: clampPositive(iAxis), z: clampPositive(iLong) };
  }

  const half = geom.halfSize;
  if (!half) return null;
  const hx = clampPositive(half.x);
  const hy = clampPositive(half.y);
  const hz = clampPositive(half.z);
  const factor = mass / 3;
  const ix = factor * (hy * hy + hz * hz);
  const iy = factor * (hx * hx + hz * hz);
  const iz = factor * (hx * hx + hy * hy);
  return {
    x: clampPositive(ix),
    y: clampPositive(iy),
    z: clampPositive(iz),
  };
}

export function computeVolumeFromGeom(geom: GeomInfo): number | null {
  if (geom.type === "sphere") {
    const r = clampPositive(geom.radius ?? 0, 0);
    if (r <= 0) return 0;
    return (4 / 3) * Math.PI * r * r * r;
  }
  if (geom.type === "cylinder") {
    const r = clampPositive(geom.radius ?? 0, 0);
    const h = clampPositive(geom.height ?? 0, 0);
    if (r <= 0 || h <= 0) return 0;
    return Math.PI * r * r * h;
  }
  if (geom.type === "plane") {
    return 0;
  }
  const half = geom.halfSize;
  if (!half) return null;
  const hx = clampPositive(half.x, 0);
  const hy = clampPositive(half.y, 0);
  const hz = clampPositive(half.z, 0);
  if (hx <= 0 || hy <= 0 || hz <= 0) return 0;
  return 8 * hx * hy * hz;
}

export function isValidInertia(inertia?: { x: number; y: number; z: number } | null) {
  if (!inertia) return false;
  const { x, y, z } = inertia;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
  if (x <= 0 || y <= 0 || z <= 0) return false;
  if (x > y + z || y > x + z || z > x + y) return false;
  return true;
}
