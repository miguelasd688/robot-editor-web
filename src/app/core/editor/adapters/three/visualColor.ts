import * as THREE from "three";
import type { RgbaColor } from "../../document/types";

/**
 * Apply an RGBA color to all mesh materials inside a Three.js object.
 * Also stores the value in `userData.visualRgba` so the adapter can read it back.
 */
export function applyRgbaToObject(obj: THREE.Object3D, rgba: RgbaColor | undefined) {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of materials) {
      if (!mat) continue;
      const m = mat as THREE.MeshStandardMaterial | THREE.MeshPhongMaterial | THREE.MeshBasicMaterial;
      if ("color" in m && rgba) {
        m.color.setRGB(rgba[0], rgba[1], rgba[2]);
      }
      if ("opacity" in m && rgba) {
        m.opacity = rgba[3];
        m.transparent = rgba[3] < 0.999;
      }
      m.needsUpdate = true;
    }
  });
  obj.userData.visualRgba = rgba ?? null;
}

/**
 * Read the material color of the first mesh found inside `obj`.
 * Returns undefined if no mesh or material is found.
 */
export function readRgbaFromObject(obj: THREE.Object3D): RgbaColor | undefined {
  let found: RgbaColor | undefined;
  obj.traverse((child) => {
    if (found) return;
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (!mat) return;
    const m = mat as THREE.MeshStandardMaterial | THREE.MeshPhongMaterial;
    if ("color" in m) {
      const opacity = "opacity" in m ? (m as THREE.MeshStandardMaterial).opacity : 1;
      found = [m.color.r, m.color.g, m.color.b, opacity];
    }
  });
  return found;
}
