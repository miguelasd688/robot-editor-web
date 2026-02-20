import * as THREE from "three";
import type { Transform } from "../../document/types";

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

export function objectToTransform(obj: THREE.Object3D): Transform {
  const euler = new THREE.Euler().setFromQuaternion(obj.quaternion, "XYZ");
  return {
    position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
    rotation: { x: euler.x * RAD2DEG, y: euler.y * RAD2DEG, z: euler.z * RAD2DEG },
    scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z },
  };
}

export function applyTransformToObject(obj: THREE.Object3D, transform: Transform) {
  obj.position.set(transform.position.x, transform.position.y, transform.position.z);
  obj.rotation.set(
    transform.rotation.x * DEG2RAD,
    transform.rotation.y * DEG2RAD,
    transform.rotation.z * DEG2RAD
  );
  obj.scale.set(transform.scale.x, transform.scale.y, transform.scale.z);
  obj.updateMatrixWorld(true);
}
