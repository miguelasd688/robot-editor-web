import * as THREE from "three";
import { createDefaultFloorGeometry, createDefaultFloorMaterial } from "./floorAppearance";

export type PrimitiveShape = "cube" | "sphere" | "cylinder" | "plane";

const NON_PICKABLE_KEY = "__nonPickable";

const createSurfaceLineOverlay = (mesh: THREE.Mesh, color = 0x1a2535, opacity = 0.2) => {
  const overlay = new THREE.Mesh(
    mesh.geometry,
    new THREE.MeshBasicMaterial({
      color,
      wireframe: true,
      transparent: true,
      opacity,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    })
  );
  overlay.name = "__primitive_surface_lines__";
  overlay.renderOrder = mesh.renderOrder + 1;
  overlay.castShadow = false;
  overlay.receiveShadow = false;
  overlay.userData[NON_PICKABLE_KEY] = true;
  mesh.add(overlay);
};

export function createPrimitiveObject(shape: PrimitiveShape): THREE.Object3D {
  if (shape === "cube") {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0x7aa2ff,
      roughness: 0.36,
      metalness: 0.12,
      clearcoat: 0.2,
      clearcoatRoughness: 0.28,
      envMapIntensity: 1.05,
    });
    const mesh = new THREE.Mesh(geo, mat);
    createSurfaceLineOverlay(mesh, 0x202c40, 0.26);
    return mesh;
  }
  if (shape === "sphere") {
    const geo = new THREE.SphereGeometry(0.5, 28, 18);
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0x7fd4ff,
      roughness: 0.3,
      metalness: 0.16,
      clearcoat: 0.26,
      clearcoatRoughness: 0.24,
      envMapIntensity: 1.08,
    });
    const mesh = new THREE.Mesh(geo, mat);
    createSurfaceLineOverlay(mesh, 0x1d2738, 0.14);
    return mesh;
  }
  if (shape === "cylinder") {
    const geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 28, 1);
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xf2b26b,
      roughness: 0.34,
      metalness: 0.14,
      clearcoat: 0.22,
      clearcoatRoughness: 0.3,
      envMapIntensity: 1.05,
    });
    const mesh = new THREE.Mesh(geo, mat);
    createSurfaceLineOverlay(mesh, 0x2a231f, 0.16);
    return mesh;
  }

  const geo = createDefaultFloorGeometry();
  const mat = createDefaultFloorMaterial();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  return mesh;
}
