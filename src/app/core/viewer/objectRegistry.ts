import * as THREE from "three";

export type ObjectIdResolver = (obj: THREE.Object3D) => string;

export function registerObject(
  objects: Map<string, THREE.Object3D>,
  obj: THREE.Object3D,
  getId: ObjectIdResolver
) {
  objects.set(getId(obj), obj);
}

export function registerHierarchy(
  objects: Map<string, THREE.Object3D>,
  root: THREE.Object3D,
  getId: ObjectIdResolver
) {
  root.traverse((o) => registerObject(objects, o, getId));
}

export function unregisterHierarchy(
  objects: Map<string, THREE.Object3D>,
  root: THREE.Object3D,
  getId: ObjectIdResolver
) {
  root.traverse((o) => objects.delete(getId(o)));
}

export function disposeObject3D(root: THREE.Object3D) {
  const disposeIfPossible = (value: unknown) => {
    if (!value || typeof (value as { dispose?: unknown }).dispose !== "function") return;
    (value as { dispose: () => void }).dispose();
  };

  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    disposeIfPossible(mesh.geometry);
    const material = mesh.material as unknown;
    if (material) {
      const mats = Array.isArray(material) ? material : [material];
      mats.forEach(disposeIfPossible);
    }
  });
}
