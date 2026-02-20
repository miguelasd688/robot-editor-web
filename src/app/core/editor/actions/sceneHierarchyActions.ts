import * as THREE from "three";
import { editorEngine } from "../engineSingleton";
import { setNodeParentCommand } from "../commands/sceneCommands";
import type { SceneNode, Transform } from "../document/types";
import { useAppStore } from "../../store/useAppStore";
import { useMujocoStore } from "../../store/useMujocoStore";
import { logWarn } from "../../services/logger";
import { validateReparentTarget } from "./hierarchyRules";
import { resolveLinkLabel } from "../kinematics/jointKinematics";

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;
const TRANSFORM_DEBUG = String(import.meta.env.VITE_EDITOR_TRANSFORM_DEBUG ?? "true").toLowerCase() !== "false";
const RENAMABLE_KINDS = new Set<SceneNode["kind"]>(["robot", "link", "mesh", "joint"]);

const debugTransform = (event: string, data?: Record<string, unknown>) => {
  if (!TRANSFORM_DEBUG) return;
  console.debug(`[editor:transform] ${event}`, data ?? {});
};

const isMeshLike = (kind?: string | null) => kind === "mesh" || kind === "group";

const defaultTransform = (): Transform => ({
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
});

const isIdentityScale = (scale?: Transform["scale"]) =>
  !!scale && scale.x === 1 && scale.y === 1 && scale.z === 1;

const matrixFromTransform = (transform: Transform) => {
  const pos = new THREE.Vector3(transform.position.x, transform.position.y, transform.position.z);
  const quat = new THREE.Quaternion();
  quat.setFromEuler(
    new THREE.Euler(
      transform.rotation.x * DEG2RAD,
      transform.rotation.y * DEG2RAD,
      transform.rotation.z * DEG2RAD,
      "XYZ"
    )
  );
  const scale = new THREE.Vector3(transform.scale.x, transform.scale.y, transform.scale.z);
  return new THREE.Matrix4().compose(pos, quat, scale);
};

const transformFromMatrix = (matrix: THREE.Matrix4): Transform => {
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(pos, quat, scale);
  const euler = new THREE.Euler().setFromQuaternion(quat, "XYZ");
  return {
    position: { x: pos.x, y: pos.y, z: pos.z },
    rotation: { x: euler.x * RAD2DEG, y: euler.y * RAD2DEG, z: euler.z * RAD2DEG },
    scale: { x: scale.x, y: scale.y, z: scale.z },
  };
};

function bakeLinkScale(linkId: string) {
  const doc = editorEngine.getDoc();
  const linkNode = doc.scene.nodes[linkId];
  if (!linkNode || linkNode.kind !== "link") return;
  const linkTransform = linkNode.components?.transform ?? defaultTransform();
  if (isIdentityScale(linkTransform.scale)) return;

  const linkMat = matrixFromTransform(linkTransform);
  const linkPos = new THREE.Vector3();
  const linkQuat = new THREE.Quaternion();
  linkMat.decompose(linkPos, linkQuat, new THREE.Vector3());
  const linkNoScaleMat = new THREE.Matrix4().compose(linkPos, linkQuat, new THREE.Vector3(1, 1, 1));
  const invNoScale = new THREE.Matrix4().copy(linkNoScaleMat).invert();

  const updates: Array<{ id: string; transform: Transform }> = [];
  for (const childId of linkNode.children) {
    const childNode = doc.scene.nodes[childId];
    if (!childNode) continue;
    const childTransform = childNode.components?.transform ?? defaultTransform();
    const childMat = matrixFromTransform(childTransform);
    const childWorld = new THREE.Matrix4().multiplyMatrices(linkMat, childMat);
    const nextLocal = new THREE.Matrix4().multiplyMatrices(invNoScale, childWorld);
    const nextTransform = transformFromMatrix(nextLocal);
    if (childNode.kind === "joint") {
      nextTransform.scale = { x: 1, y: 1, z: 1 };
    }
    updates.push({ id: childId, transform: nextTransform });
  }

  for (const update of updates) {
    editorEngine.setNodeTransform(update.id, update.transform, { recordHistory: false, reason: "joint:bakeScale" });
  }

  editorEngine.setNodeTransform(
    linkId,
    { ...linkTransform, scale: { x: 1, y: 1, z: 1 } },
    { recordHistory: false, reason: "joint:bakeScale" }
  );
}

function findVisualChild(doc: ReturnType<typeof editorEngine.getDoc>, linkId: string) {
  const link = doc.scene.nodes[linkId];
  if (!link) return null;
  const visuals = link.children
    .map((cid) => doc.scene.nodes[cid])
    .filter((node) => node?.kind === "visual") as Array<typeof link>;
  if (!visuals.length) return null;
  const withSync = visuals.find((node) => node.components?.visual?.attachCollisions);
  return (withSync ?? visuals[0]).id;
}

function findVisualSiblingForCollision(doc: ReturnType<typeof editorEngine.getDoc>, collisionId: string) {
  const collision = doc.scene.nodes[collisionId];
  if (!collision) return null;
  const parentId = collision.parentId ?? null;
  const siblingIds = parentId ? doc.scene.nodes[parentId]?.children ?? [] : doc.scene.roots;
  const visuals = siblingIds
    .map((id) => doc.scene.nodes[id])
    .filter((node) => node?.kind === "visual") as Array<typeof collision>;
  if (!visuals.length) return null;
  const withSync = visuals.find((node) => node.components?.visual?.attachCollisions);
  return (withSync ?? visuals[0]).id;
}

function findCollisionRoot(doc: ReturnType<typeof editorEngine.getDoc>, nodeId: string) {
  let cur: string | null = nodeId;
  while (cur) {
    const node: SceneNode | undefined = doc.scene.nodes[cur];
    if (!node) return null;
    if (node.kind === "collision") return node;
    cur = node.parentId ?? null;
  }
  return null;
}

function computeLocalTransform(child: THREE.Object3D, parent: THREE.Object3D | null): Transform {
  child.updateMatrixWorld(true);
  if (parent) parent.updateMatrixWorld(true);

  const localMatrix = new THREE.Matrix4();
  if (parent) {
    localMatrix.copy(parent.matrixWorld).invert().multiply(child.matrixWorld);
  } else {
    localMatrix.copy(child.matrixWorld);
  }

  const temp = new THREE.Object3D();
  temp.applyMatrix4(localMatrix);
  const euler = new THREE.Euler().setFromQuaternion(temp.quaternion, "XYZ");

  return {
    position: { x: temp.position.x, y: temp.position.y, z: temp.position.z },
    rotation: { x: euler.x * RAD2DEG, y: euler.y * RAD2DEG, z: euler.z * RAD2DEG },
    scale: { x: temp.scale.x, y: temp.scale.y, z: temp.scale.z },
  };
}

function poseFromWorld(parent: THREE.Object3D, child: THREE.Object3D) {
  parent.updateMatrixWorld(true);
  child.updateMatrixWorld(true);
  const invParent = new THREE.Matrix4().copy(parent.matrixWorld).invert();
  const local = new THREE.Matrix4().multiplyMatrices(invParent, child.matrixWorld);
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  local.decompose(pos, quat, scale);
  const euler = new THREE.Euler().setFromQuaternion(quat, "ZYX");
  return {
    xyz: [pos.x, pos.y, pos.z] as [number, number, number],
    rpy: [euler.x, euler.y, euler.z] as [number, number, number],
  };
}

const worldPoseForLog = (obj: THREE.Object3D | null | undefined) => {
  if (!obj) return null;
  obj.updateMatrixWorld(true);
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  obj.matrixWorld.decompose(pos, quat, scale);
  return {
    position: { x: pos.x, y: pos.y, z: pos.z },
    quaternion: { x: quat.x, y: quat.y, z: quat.z, w: quat.w },
    scale: { x: scale.x, y: scale.y, z: scale.z },
  };
};

export function reparentNode(id: string, parentId: string | null, options?: { keepWorld?: boolean }) {
  let doc = editorEngine.getDoc();
  const initialSource = doc.scene.nodes[id];
  if (!initialSource) return false;

  if (parentId) {
    const target = doc.scene.nodes[parentId];
    if (target?.kind === "joint") {
      const source = doc.scene.nodes[id];
      if (source?.kind !== "link") {
        logWarn("Only links can be parented to joints. Use the joint child selector for links.", {
          scope: "scene",
        });
        return false;
      }
    }
  }

  let sourceId = id;
  const collisionRoot = findCollisionRoot(doc, id);
  if (initialSource.components?.mirror?.sourceId && collisionRoot) {
    const visualId = findVisualSiblingForCollision(doc, collisionRoot.id);
    const visualNode = visualId ? doc.scene.nodes[visualId] : null;
    if (visualNode?.components?.visual?.attachCollisions) {
      sourceId = initialSource.components.mirror.sourceId;
    }
  }

  let nextParentId = parentId;
  if (nextParentId) {
    const target = doc.scene.nodes[nextParentId];
    if (target?.kind === "collision") {
      const visualId = findVisualSiblingForCollision(doc, target.id);
      const visualNode = visualId ? doc.scene.nodes[visualId] : null;
      if (visualNode?.components?.visual?.attachCollisions) {
        nextParentId = visualId;
      }
    } else if (target?.kind === "link") {
      const sourceNode = doc.scene.nodes[sourceId];
      if (isMeshLike(sourceNode?.kind)) {
        const visualId = findVisualChild(doc, target.id);
        if (visualId) nextParentId = visualId;
      }
    }
  }

  if (!doc.scene.nodes[sourceId]) return false;
  if (nextParentId === sourceId) return false;

  const validation = validateReparentTarget(doc, sourceId, nextParentId ?? null);
  if (!validation.ok) {
    logWarn(validation.reason, { scope: "scene" });
    return false;
  }

  let target = nextParentId ? doc.scene.nodes[nextParentId] : null;
  let sourceNode = doc.scene.nodes[sourceId];
  const isLinkToJoint = target?.kind === "joint" && sourceNode?.kind === "link";
  let jointUpdate:
    | {
        jointId: string;
        origin?: { xyz: [number, number, number]; rpy: [number, number, number] };
        parentName?: string;
        childName?: string;
      }
    | null = null;

  if (isLinkToJoint) {
    const parentLinkId =
      target?.parentId && doc.scene.nodes[target.parentId]?.kind === "link" ? target.parentId : null;
    if (parentLinkId) bakeLinkScale(parentLinkId);
    bakeLinkScale(sourceId);
    doc = editorEngine.getDoc();
    target = nextParentId ? doc.scene.nodes[nextParentId] : null;
    sourceNode = doc.scene.nodes[sourceId];

    const refreshedParentLinkId =
      target?.parentId && doc.scene.nodes[target.parentId]?.kind === "link" ? target.parentId : null;
    const viewer = useAppStore.getState().viewer;
    const parentObj = refreshedParentLinkId ? viewer?.getObjectById(refreshedParentLinkId) : null;
    const childObj = viewer?.getObjectById(sourceId) ?? null;
    const origin = parentObj && childObj ? poseFromWorld(parentObj, childObj) : undefined;
    if (target) {
      jointUpdate = {
        jointId: target.id,
        origin,
        parentName: refreshedParentLinkId ? resolveLinkLabel(doc.scene.nodes[refreshedParentLinkId]) : undefined,
        childName: sourceNode ? resolveLinkLabel(sourceNode) : undefined,
      };
      debugTransform("joint.reparent.originComputed", {
        sourceId,
        jointId: target.id,
        parentLinkId: refreshedParentLinkId,
        origin,
      });
    }
  }

  let transform: Transform | undefined;
  if (options?.keepWorld !== false) {
    const viewer = useAppStore.getState().viewer;
    const child = viewer?.getObjectById(sourceId);
    if (child && isLinkToJoint && jointUpdate?.origin) {
      // When assigning a child link to a joint, the joint origin is updated to the current child world pose.
      // Keeping the child local transform at identity avoids world-space jumps.
      transform = defaultTransform();
    } else if (child) {
      const parent = nextParentId ? viewer?.getObjectById(nextParentId) : null;
      transform = computeLocalTransform(child, parent ?? null);
    }
  }

  const viewer = useAppStore.getState().viewer;
  const sourceObjBefore = viewer?.getObjectById(sourceId) ?? null;
  const targetObjBefore = nextParentId ? viewer?.getObjectById(nextParentId) ?? null : null;
  debugTransform("reparent.start", {
    sourceId,
    requestedParentId: parentId,
    resolvedParentId: nextParentId,
    keepWorld: options?.keepWorld !== false,
    isLinkToJoint,
    computedLocal: transform,
    sourceWorldBefore: worldPoseForLog(sourceObjBefore),
    targetWorldBefore: worldPoseForLog(targetObjBefore),
  });

  editorEngine.execute(setNodeParentCommand(sourceId, nextParentId ?? null, transform));

  if (jointUpdate) {
    const nextDoc = editorEngine.getDoc();
    const jointNode = nextDoc.scene.nodes[jointUpdate.jointId];
    const urdf = jointNode?.components?.urdf;
    if (jointNode && urdf?.kind === "joint") {
      const nextUrdf = {
        ...urdf,
        joint: {
          ...urdf.joint,
          parent: jointUpdate.parentName ?? urdf.joint.parent,
          child: jointUpdate.childName ?? urdf.joint.child,
          origin: jointUpdate.origin ?? urdf.joint.origin,
        },
      };
      editorEngine.setNodeUrdf(jointUpdate.jointId, nextUrdf, { recordHistory: false, reason: "joint:reparent" });
    }

  }

  const sourceObjAfter = viewer?.getObjectById(sourceId) ?? null;
  const targetObjAfter = nextParentId ? viewer?.getObjectById(nextParentId) ?? null : null;
  debugTransform("reparent.end", {
    sourceId,
    resolvedParentId: nextParentId,
    sourceWorldAfter: worldPoseForLog(sourceObjAfter),
    targetWorldAfter: worldPoseForLog(targetObjAfter),
    jointUpdate,
  });

  useMujocoStore.getState().markSceneDirty();
  return true;
}

export function renameNode(id: string, name: string) {
  const doc = editorEngine.getDoc();
  const node = doc.scene.nodes[id];
  if (!node || !RENAMABLE_KINDS.has(node.kind)) return false;

  let targetId = id;
  const collisionRoot = findCollisionRoot(doc, id);
  if (node.components?.mirror?.sourceId && collisionRoot) {
    const visualId = findVisualSiblingForCollision(doc, collisionRoot.id);
    const visualNode = visualId ? doc.scene.nodes[visualId] : null;
    if (visualNode?.components?.visual?.attachCollisions) {
      targetId = node.components.mirror.sourceId;
    }
  }

  const targetNode = doc.scene.nodes[targetId];
  if (!targetNode) return false;
  const prevName = targetNode.name;
  editorEngine.setNodeName(targetId, name, { reason: "scene.rename" });
  const nextName = editorEngine.getDoc().scene.nodes[targetId]?.name ?? prevName;
  if (nextName === prevName) return false;
  useMujocoStore.getState().markSceneDirty();
  return true;
}
