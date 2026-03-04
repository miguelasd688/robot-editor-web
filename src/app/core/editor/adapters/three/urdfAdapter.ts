import * as THREE from "three";
import type { UrdfInstance } from "../../../urdf/urdfModel";
import { setInitialFromObject } from "../../../assets/assetInstance";

const tmpEuler = new THREE.Euler();
const tmpQuat = new THREE.Quaternion();
const tmpWorldA = new THREE.Vector3();
const tmpWorldB = new THREE.Vector3();
const tmpLocalA = new THREE.Vector3();
const tmpLocalB = new THREE.Vector3();
const tmpMid = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const TUBE_RADIUS = 0.01;
const Y_AXIS = new THREE.Vector3(0, 1, 0);

type MuscleHelperState = {
  root: THREE.Group;
  line: THREE.Line;
  lineGeometry: THREE.BufferGeometry;
  lineMaterial: THREE.LineBasicMaterial;
  tube: THREE.Mesh | null;
  tubeMaterial: THREE.MeshBasicMaterial | null;
};

const clearMuscleHelper = (obj: THREE.Object3D) => {
  const state = obj.userData.muscleHelper as MuscleHelperState | undefined;
  if (!state) return;
  state.lineGeometry.dispose();
  state.lineMaterial.dispose();
  if (state.tube) {
    const tubeGeom = state.tube.geometry;
    if (tubeGeom && "dispose" in tubeGeom) (tubeGeom as THREE.BufferGeometry).dispose();
  }
  state.tubeMaterial?.dispose();
  state.root.removeFromParent();
  delete obj.userData.muscleHelper;
};

const resolveJointLinks = (jointObj: THREE.Object3D) => {
  const parent = jointObj.parent;
  const parentLink =
    parent instanceof THREE.Group && parent.userData?.editorKind === "link"
      ? parent
      : null;
  const childLink = jointObj.children.find(
    (child): child is THREE.Group => child instanceof THREE.Group && child.userData?.editorKind === "link"
  ) ?? null;
  return { parentLink, childLink };
};

const ensureMuscleHelper = (obj: THREE.Object3D, next: Extract<UrdfInstance, { kind: "joint" }>) => {
  const actuatorEnabled = next.joint.actuator?.enabled !== false;
  const isMuscle = next.joint.actuator?.type === "muscle";
  const muscle = next.joint.muscle;
  const showLine = muscle?.showLine !== false;
  const showTube = muscle?.showTube === true;
  if (!actuatorEnabled || !isMuscle || !muscle || (!showLine && !showTube)) {
    clearMuscleHelper(obj);
    return;
  }

  let state = obj.userData.muscleHelper as MuscleHelperState | undefined;
  if (!state) {
    const root = new THREE.Group();
    root.name = "__muscle_helper__";
    root.userData.editorKind = "muscle-helper";
    root.userData.ignoreSelection = true;
    root.renderOrder = 20;

    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    const lineMaterial = new THREE.LineBasicMaterial({
      color: 0x808080,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    const line = new THREE.Line(lineGeometry, lineMaterial);
    line.frustumCulled = false;
    line.userData.ignoreSelection = true;
    root.add(line);

    const tubeMaterial = new THREE.MeshBasicMaterial({
      color: 0x808080,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 8, 1, true), tubeMaterial);
    tube.visible = false;
    tube.frustumCulled = false;
    tube.userData.ignoreSelection = true;
    root.add(tube);

    obj.add(root);
    state = { root, line, lineGeometry, lineMaterial, tube, tubeMaterial };
    obj.userData.muscleHelper = state;
  }

  state.line.visible = showLine;
  if (state.tube) state.tube.visible = showTube;

  state.root.onBeforeRender = () => {
    const links = resolveJointLinks(obj);
    if (!links.parentLink || !links.childLink) {
      state!.root.visible = false;
      return;
    }
    state!.root.visible = true;
    tmpWorldA.set(
      muscle.endA.localPos[0],
      muscle.endA.localPos[1],
      muscle.endA.localPos[2]
    );
    tmpWorldB.set(
      muscle.endB.localPos[0],
      muscle.endB.localPos[1],
      muscle.endB.localPos[2]
    );
    links.parentLink.localToWorld(tmpWorldA);
    links.childLink.localToWorld(tmpWorldB);
    tmpLocalA.copy(tmpWorldA);
    tmpLocalB.copy(tmpWorldB);
    obj.worldToLocal(tmpLocalA);
    obj.worldToLocal(tmpLocalB);

    const positionAttr = state!.lineGeometry.getAttribute("position") as THREE.BufferAttribute;
    positionAttr.setXYZ(0, tmpLocalA.x, tmpLocalA.y, tmpLocalA.z);
    positionAttr.setXYZ(1, tmpLocalB.x, tmpLocalB.y, tmpLocalB.z);
    positionAttr.needsUpdate = true;
    state!.lineGeometry.computeBoundingSphere();

    if (!state!.tube || !showTube) return;
    tmpMid.copy(tmpLocalA).add(tmpLocalB).multiplyScalar(0.5);
    tmpDir.copy(tmpLocalB).sub(tmpLocalA);
    const length = tmpDir.length();
    if (length < 1e-6) {
      state!.tube.visible = false;
      return;
    }
    state!.tube.visible = true;
    state!.tube.position.copy(tmpMid);
    tmpDir.normalize();
    state!.tube.quaternion.setFromUnitVectors(Y_AXIS, tmpDir);
    state!.tube.scale.set(TUBE_RADIUS, length, TUBE_RADIUS);
  };
};

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
    ensureMuscleHelper(obj, next);
  } else {
    clearMuscleHelper(obj);
  }
}
