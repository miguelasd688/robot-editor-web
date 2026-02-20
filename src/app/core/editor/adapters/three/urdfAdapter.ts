import * as THREE from "three";
import type { UrdfInstance } from "../../../urdf/urdfModel";
import { setInitialFromObject } from "../../../assets/assetInstance";

const tmpEuler = new THREE.Euler();
const tmpQuat = new THREE.Quaternion();

export function applyUrdfToObject(obj: THREE.Object3D, next: UrdfInstance) {
  obj.userData.urdf = next;

  if (next.kind === "link" && next.link.inertial) {
    obj.userData.physics = {
      ...(obj.userData.physics ?? {}),
      mass: next.link.inertial.mass,
      inertia: {
        x: next.link.inertial.inertia.ixx,
        y: next.link.inertial.inertia.iyy,
        z: next.link.inertial.inertia.izz,
      },
    };
  }

  if (next.kind === "joint") {
    const axis = new THREE.Vector3(next.joint.axis[0], next.joint.axis[1], next.joint.axis[2]);
    if (axis.lengthSq() > 0 && (obj as any).axis) {
      axis.normalize();
      (obj as any).axis.copy(axis);
    }
    const origin = next.joint.origin;
    obj.position.set(origin.xyz[0], origin.xyz[1], origin.xyz[2]);
    tmpEuler.set(origin.rpy[0], origin.rpy[1], origin.rpy[2], "ZYX");
    tmpQuat.setFromEuler(tmpEuler);
    obj.quaternion.copy(tmpQuat);
    obj.updateMatrixWorld(true);
    setInitialFromObject(obj);
  }
}
