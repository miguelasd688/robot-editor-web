import type * as THREE from "three";

const SCENE_NODE_FLAG = "__sceneNode";

export function markSceneNode(obj: THREE.Object3D) {
  obj.userData[SCENE_NODE_FLAG] = true;
}

export function isManagedSceneObject(obj: THREE.Object3D) {
  const anyObj = obj as any;
  if (obj.userData?.[SCENE_NODE_FLAG]) return true;
  if (obj.userData?.editorRobotRoot) return true;
  if (typeof obj.userData?.editorKind === "string") return true;
  if (anyObj.isURDFLink || anyObj.isURDFJoint || anyObj.isURDFCollider || anyObj.isURDFVisual) return true;
  if (anyObj.isRobot) return true;
  return false;
}
