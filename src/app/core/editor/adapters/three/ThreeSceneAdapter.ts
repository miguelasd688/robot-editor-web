import * as THREE from "three";
import type { Viewer } from "../../../viewer/Viewer";
import type { EditorEngine } from "../../EditorEngine";
import { sceneSnapshotToDoc } from "./snapshotAdapter";
import { applyTransformToObject, objectToTransform } from "./transformAdapter";
import { ensureUserInstance, setInitialFromObject } from "../../../assets/assetInstance";
import type { ProjectDoc, SceneNode, Transform } from "../../document/types";
import type { InstancePhysics, PhysicsFields } from "../../../assets/types";
import type { Pose, UrdfInstance } from "../../../urdf/urdfModel";
import type { UrdfImportOptions } from "../../../urdf/urdfImportOptions";
import { applyUrdfToObject } from "./urdfAdapter";
import { scalePhysicsForTransform } from "./scalePhysics";
import { getDocId } from "../../../scene/docIds";
import { createPrimitiveObject } from "../../../assets/primitives";
import { useAppStore } from "../../../store/useAppStore";
import { disposeObject3D } from "../../../viewer/objectRegistry";
import { isManagedSceneObject, markSceneNode } from "../../../viewer/sceneObjectFlags";
import { computeLinkInertiaFromVisuals } from "../../../physics/linkInertia";
import {
  collectJointChildLinkIds,
  findJointParentLinkId,
  resolveLinkLabel,
} from "../../kinematics/jointKinematics";

const degToRad = (value: number) => (value * Math.PI) / 180;
const radToDeg = (value: number) => (value * 180) / Math.PI;
const TRANSFORM_DEBUG = String(import.meta.env.VITE_EDITOR_TRANSFORM_DEBUG ?? "true").toLowerCase() !== "false";

const debugTransform = (event: string, data?: Record<string, unknown>) => {
  if (!TRANSFORM_DEBUG) return;
  console.debug(`[editor:sync] ${event}`, data ?? {});
};

const worldPoseForLog = (obj: THREE.Object3D | null) => {
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

const poseFromTransform = (transform: {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
}) => {
  const quat = new THREE.Quaternion();
  quat.setFromEuler(
    new THREE.Euler(
      degToRad(transform.rotation.x),
      degToRad(transform.rotation.y),
      degToRad(transform.rotation.z),
      "XYZ"
    )
  );
  const rpy = new THREE.Euler().setFromQuaternion(quat, "ZYX");
  return {
    xyz: [transform.position.x, transform.position.y, transform.position.z] as [number, number, number],
    rpy: [rpy.x, rpy.y, rpy.z] as [number, number, number],
  };
};

const matrixFromTransform = (transform: Transform) => {
  const pos = new THREE.Vector3(transform.position.x, transform.position.y, transform.position.z);
  const quat = new THREE.Quaternion();
  quat.setFromEuler(
    new THREE.Euler(
      degToRad(transform.rotation.x),
      degToRad(transform.rotation.y),
      degToRad(transform.rotation.z),
      "XYZ"
    )
  );
  const scale = new THREE.Vector3(transform.scale.x, transform.scale.y, transform.scale.z);
  return new THREE.Matrix4().compose(pos, quat, scale);
};

const identityPose = (): Pose => ({ xyz: [0, 0, 0], rpy: [0, 0, 0] });

const matrixFromPose = (pose: Pose) => {
  const pos = new THREE.Vector3(pose.xyz[0], pose.xyz[1], pose.xyz[2]);
  const quat = new THREE.Quaternion();
  quat.setFromEuler(new THREE.Euler(pose.rpy[0], pose.rpy[1], pose.rpy[2], "ZYX"));
  return new THREE.Matrix4().compose(pos, quat, new THREE.Vector3(1, 1, 1));
};

const poseFromMatrix = (matrix: THREE.Matrix4): Pose => {
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(pos, quat, scale);
  const rpy = new THREE.Euler().setFromQuaternion(quat, "ZYX");
  return {
    xyz: [pos.x, pos.y, pos.z],
    rpy: [rpy.x, rpy.y, rpy.z],
  };
};

const samePose = (a: Pose, b: Pose, eps = 1e-9) =>
  Math.abs(a.xyz[0] - b.xyz[0]) < eps &&
  Math.abs(a.xyz[1] - b.xyz[1]) < eps &&
  Math.abs(a.xyz[2] - b.xyz[2]) < eps &&
  Math.abs(a.rpy[0] - b.rpy[0]) < eps &&
  Math.abs(a.rpy[1] - b.rpy[1]) < eps &&
  Math.abs(a.rpy[2] - b.rpy[2]) < eps;

const normalizeOffsetPose = (pose: Pose): Pose | undefined => (samePose(pose, identityPose()) ? undefined : pose);

const composePoseWithDelta = (current: Pose | undefined, delta: THREE.Matrix4): Pose | undefined => {
  const next = poseFromMatrix(delta.clone().multiply(matrixFromPose(current ?? identityPose())));
  return normalizeOffsetPose(next);
};

const transformFromMatrix = (matrix: THREE.Matrix4): Transform => {
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(pos, quat, scale);
  const euler = new THREE.Euler().setFromQuaternion(quat, "XYZ");
  return {
    position: { x: pos.x, y: pos.y, z: pos.z },
    rotation: { x: radToDeg(euler.x), y: radToDeg(euler.y), z: radToDeg(euler.z) },
    scale: { x: scale.x, y: scale.y, z: scale.z },
  };
};

const sameTransform = (a: Transform, b: Transform) =>
  a.position.x === b.position.x &&
  a.position.y === b.position.y &&
  a.position.z === b.position.z &&
  a.rotation.x === b.rotation.x &&
  a.rotation.y === b.rotation.y &&
  a.rotation.z === b.rotation.z &&
  a.scale.x === b.scale.x &&
  a.scale.y === b.scale.y &&
  a.scale.z === b.scale.z;

const findAncestorIdByKind = (
  nodes: Record<string, SceneNode>,
  startId: string | null,
  kind: SceneNode["kind"]
) => {
  let cur: string | null = startId;
  while (cur) {
    const node = nodes[cur];
    if (!node) return null;
    if (node.kind === kind) return cur;
    cur = node.parentId ?? null;
  }
  return null;
};

const getDirectVisualChildren = (nodes: Record<string, SceneNode>, linkId: string) => {
  const link = nodes[linkId];
  if (!link) return [];
  return link.children
    .map((childId) => nodes[childId])
    .filter((child): child is SceneNode => !!child && child.kind === "visual");
};

const isCollisionSyncEnabledForLink = (nodes: Record<string, SceneNode>, linkId: string) =>
  getDirectVisualChildren(nodes, linkId).some((visual) => visual.components?.visual?.attachCollisions === true);

const ensureCollisionSyncSourceVisual = (
  engine: EditorEngine,
  nodes: Record<string, SceneNode>,
  linkId: string,
  visualId: string
) => {
  if (!isCollisionSyncEnabledForLink(nodes, linkId)) return;
  const visuals = getDirectVisualChildren(nodes, linkId);
  for (const visual of visuals) {
    const current = visual.components?.visual ?? {};
    const nextAttach = visual.id === visualId;
    if ((current.attachCollisions ?? false) === nextAttach) continue;
    engine.setNodeVisual(
      visual.id,
      { ...current, attachCollisions: nextAttach },
      { recordHistory: false, reason: "collision.syncSource" }
    );
  }
};

export class ThreeSceneAdapter {
  private engine: EditorEngine;
  private viewer: Viewer;
  private lastSelectedId: string | null = null;

  constructor(engine: EditorEngine, viewer: Viewer) {
    this.engine = engine;
    this.viewer = viewer;
  }

  syncSceneFromViewer() {
    const snapshot = this.viewer.getSceneSnapshot();
    const scene = sceneSnapshotToDoc(snapshot);
    this.populateComponents(scene.nodes);
    this.engine.replaceScene(scene, "viewer:snapshot");
    this.lastSelectedId = scene.selectedId ?? null;
  }

  syncTransformFromViewer(id: string, options?: { recordHistory?: boolean }) {
    if (useAppStore.getState().simState === "playing") return;
    const doc = this.engine.getDoc();
    const initialNode = doc.scene.nodes[id];
    if (!initialNode) return;
    let targetId = id;
    let node = initialNode;
    const mirrorSourceId = initialNode.components?.mirror?.sourceId ?? null;
    if (mirrorSourceId && doc.scene.nodes[mirrorSourceId]) {
      const mirrorLinkId = findAncestorIdByKind(doc.scene.nodes, mirrorSourceId, "link");
      if (mirrorLinkId && isCollisionSyncEnabledForLink(doc.scene.nodes, mirrorLinkId)) {
        targetId = mirrorSourceId;
        node = doc.scene.nodes[mirrorSourceId];
      }
    }

    const linkId = findAncestorIdByKind(doc.scene.nodes, targetId, "link");
    const visualId = findAncestorIdByKind(doc.scene.nodes, targetId, "visual");
    if (linkId && visualId) {
      ensureCollisionSyncSourceVisual(this.engine, doc.scene.nodes, linkId, visualId);
    }

    const obj = this.viewer.getObjectById(id);
    if (!obj) return;
    const transform = objectToTransform(obj);
    debugTransform("viewer.transform.read", {
      id,
      targetId,
      nodeKind: node?.kind,
      recordHistory: options?.recordHistory ?? false,
      local: transform,
      world: worldPoseForLog(obj),
      parentId: obj.parent?.userData?.docId ? String(obj.parent.userData.docId) : null,
      parentWorld: worldPoseForLog(obj.parent),
    });
    setInitialFromObject(obj);
    if (node?.components?.physics) {
      const currentScale = node.components.transform?.scale ?? { x: 1, y: 1, z: 1 };
      const nextScale = transform.scale;
      const scaled = scalePhysicsForTransform(obj, node.components.physics, currentScale, nextScale);
      if (scaled) {
        this.engine.setNodePhysics(targetId, scaled, node.components.physicsFields, {
          recordHistory: false,
          reason: "viewer:physics",
        });
      }
    }
    this.syncLinkPhysicsFromNode(targetId);

    const currentTransform = node?.components?.transform ?? {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    };
    if (node?.kind === "joint" && node.children.length && !sameTransform(currentTransform, transform)) {
      const childLinks = collectJointChildLinkIds(doc.scene.nodes, targetId)
        .map((childId) => doc.scene.nodes[childId])
        .filter((child): child is SceneNode => !!child && child.kind === "link");
      if (childLinks.length) {
        const oldMat = matrixFromTransform(currentTransform);
        const newMat = matrixFromTransform(transform);
        const delta = new THREE.Matrix4().copy(newMat).invert().multiply(oldMat);
        for (const child of childLinks) {
          const childTransform = child.components?.transform ?? {
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },
            scale: { x: 1, y: 1, z: 1 },
          };
          const childMat = matrixFromTransform(childTransform);
          childMat.premultiply(delta);
          const nextChild = transformFromMatrix(childMat);
          if (!sameTransform(childTransform, nextChild)) {
            debugTransform("viewer.transform.jointCompensate", {
              jointId: targetId,
              childId: child.id,
              previous: childTransform,
              next: nextChild,
            });
            this.engine.setNodeTransform(child.id, nextChild, {
              recordHistory: false,
              reason: "joint:compensate",
            });
            const childUrdf = child.components?.urdf;
            if (childUrdf?.kind === "link") {
              const nextOffset = composePoseWithDelta(childUrdf.link.editorOffset, delta);
              const previousOffset = childUrdf.link.editorOffset ?? identityPose();
              const nextOffsetPose = nextOffset ?? identityPose();
              if (!samePose(previousOffset, nextOffsetPose)) {
                this.engine.setNodeUrdf(
                  child.id,
                  {
                    kind: "link",
                    link: {
                      ...childUrdf.link,
                      editorOffset: nextOffset,
                    },
                  },
                  { recordHistory: false, reason: "joint:compensate" }
                );
              }
            }
          }
        }
      }
    }

    this.engine.setNodeTransform(targetId, transform, { recordHistory: options?.recordHistory, reason: "viewer:transform" });
    if (node?.kind === "link" && node.components?.urdf?.kind === "link") {
      const hasIncomingJoint = Boolean(findAncestorIdByKind(doc.scene.nodes, node.parentId ?? null, "joint"));
      const nextOffset = hasIncomingJoint ? normalizeOffsetPose(poseFromTransform(transform)) : undefined;
      const previousOffset = node.components.urdf.link.editorOffset ?? identityPose();
      const nextOffsetPose = nextOffset ?? identityPose();
      if (!samePose(previousOffset, nextOffsetPose)) {
        this.engine.setNodeUrdf(
          targetId,
          {
            kind: "link",
            link: {
              ...node.components.urdf.link,
              editorOffset: nextOffset,
            },
          },
          { recordHistory: false, reason: "viewer:transform" }
        );
        debugTransform("viewer.transform.writeLinkOffset", {
          linkId: targetId,
          hasIncomingJoint,
          previous: previousOffset,
          next: nextOffset,
        });
      }
    }
    debugTransform("viewer.transform.write", {
      id,
      targetId,
      written: transform,
    });
    if (options?.recordHistory && node?.kind === "joint" && node.components?.urdf?.kind === "joint") {
      const parentLinkId = findJointParentLinkId(doc.scene.nodes, targetId);
      const parentLink = parentLinkId ? doc.scene.nodes[parentLinkId] : null;
      const childLinkId = collectJointChildLinkIds(doc.scene.nodes, targetId)[0] ?? null;
      const childLink = childLinkId ? doc.scene.nodes[childLinkId] : null;
      const urdf = node.components.urdf;
      this.engine.setNodeUrdf(
        targetId,
        {
          kind: "joint",
          joint: {
            ...urdf.joint,
            parent: parentLink ? resolveLinkLabel(parentLink) : urdf.joint.parent,
            child: childLink ? resolveLinkLabel(childLink) : urdf.joint.child,
            origin: poseFromTransform(transform),
          },
        },
        { recordHistory: false, reason: "viewer:transform" }
      );
      debugTransform("viewer.transform.writeJointUrdf", {
        jointId: targetId,
        parentLinkId: parentLink?.id ?? null,
        origin: poseFromTransform(transform),
      });
    }
  }

  applyDoc(doc: ProjectDoc, options?: { reason?: string }) {
    const reason = options?.reason ?? "";
    const structuralChange =
      reason.includes("scene.add") ||
      reason.includes("scene.addNodes") ||
      reason.includes("scene.remove") ||
      reason.includes("scene.paste") ||
      reason.includes("scene.duplicate") ||
      reason.includes("scene.reparent") ||
      reason.includes("scene.replace");

    if (reason === "scene.select") {
      if (doc.scene.selectedId !== undefined) {
        this.viewer.setSelected(doc.scene.selectedId);
        this.lastSelectedId = doc.scene.selectedId ?? null;
      }
      return;
    }

    this.syncRoots(doc);
    this.syncHierarchy(doc);
    if (structuralChange) {
      this.pruneMissingNodes(doc);
    }

    const selectedId = doc.scene.selectedId ?? null;
    if (doc.scene.selectedId !== undefined) {
      const shouldRefreshSelection = structuralChange || selectedId !== this.lastSelectedId;
      if (shouldRefreshSelection) {
        this.viewer.setSelected(selectedId);
      }
      this.lastSelectedId = selectedId;
    }
    const { simState } = useAppStore.getState();
    const allowUrdfTransform = simState !== "playing";
    for (const node of Object.values(doc.scene.nodes)) {
      const obj = this.viewer.getObjectById(node.id);
      if (!obj) continue;
      if (obj.name !== node.name) {
        obj.name = node.name;
      }
      markSceneNode(obj);
      const components = node.components;
      if (components?.transform) {
        const isUrdfNode = Boolean(components.urdf);
        if (!isUrdfNode || allowUrdfTransform) {
          applyTransformToObject(obj, components.transform);
          setInitialFromObject(obj);
        }
      }
      if (components?.physics) {
        applyPhysicsFromDoc(obj, components.physics, components.physicsFields);
      }
      if (components?.urdf) {
        const sameUrdf = obj.userData?.urdf === components.urdf;
        if (!sameUrdf) {
          applyUrdfToObject(obj, components.urdf);
        }
      }
      if (components?.urdfSource) {
        obj.userData.urdfSource = components.urdfSource;
      }
      if (components?.urdfKey !== undefined) {
        obj.userData.urdfKey = components.urdfKey;
      }
      if (components?.urdfImportOptions !== undefined) {
        obj.userData.urdfImportOptions = components.urdfImportOptions;
      }
    }
    this.viewer.refreshViewportShading?.();
    this.viewer.refreshUrdfDebug?.();

    if (structuralChange && !reason.includes("viewer:physics")) {
      this.syncAllLinkPhysicsFromVisuals();
    }
  }

  syncLinkPhysicsFromNode(nodeId: string) {
    const doc = this.engine.getDoc();
    const linkId = this.findLinkAncestorId(doc, nodeId);
    if (!linkId) return;
    const linkNode = doc.scene.nodes[linkId];
    if (!linkNode?.components?.physics) return;
    if (linkNode.components.urdf) return;
    const linkObj = this.viewer.getObjectById(linkId);
    if (!linkObj) return;
    const computed = computeLinkInertiaFromVisuals(linkObj, linkNode.components.physics);
    if (!computed) return;

    const nextPhysics: InstancePhysics = {
      ...linkNode.components.physics,
      mass: linkNode.components.physics.useDensity ? computed.mass : linkNode.components.physics.mass,
      com: computed.com,
      inertia: computed.inertia,
      inertiaTensor: computed.inertiaTensor,
    };

    const prev = linkNode.components.physics;
    const same =
      Math.abs(prev.mass - nextPhysics.mass) < 1e-6 &&
      (!nextPhysics.com ||
        (prev.com &&
          Math.abs(prev.com.x - nextPhysics.com.x) < 1e-6 &&
          Math.abs(prev.com.y - nextPhysics.com.y) < 1e-6 &&
          Math.abs(prev.com.z - nextPhysics.com.z) < 1e-6)) &&
      Math.abs(prev.inertia.x - nextPhysics.inertia.x) < 1e-6 &&
      Math.abs(prev.inertia.y - nextPhysics.inertia.y) < 1e-6 &&
      Math.abs(prev.inertia.z - nextPhysics.inertia.z) < 1e-6 &&
      (!nextPhysics.inertiaTensor ||
        (prev.inertiaTensor &&
          Math.abs(prev.inertiaTensor.ixx - nextPhysics.inertiaTensor.ixx) < 1e-6 &&
          Math.abs(prev.inertiaTensor.iyy - nextPhysics.inertiaTensor.iyy) < 1e-6 &&
          Math.abs(prev.inertiaTensor.izz - nextPhysics.inertiaTensor.izz) < 1e-6 &&
          Math.abs(prev.inertiaTensor.ixy - nextPhysics.inertiaTensor.ixy) < 1e-6 &&
          Math.abs(prev.inertiaTensor.ixz - nextPhysics.inertiaTensor.ixz) < 1e-6 &&
          Math.abs(prev.inertiaTensor.iyz - nextPhysics.inertiaTensor.iyz) < 1e-6));
    if (same) return;

    this.engine.setNodePhysics(linkId, nextPhysics, linkNode.components.physicsFields, {
      recordHistory: false,
      reason: "viewer:physics",
    });
  }

  private syncAllLinkPhysicsFromVisuals() {
    const doc = this.engine.getDoc();
    const linkIds = Object.values(doc.scene.nodes)
      .filter((node) => node.kind === "link")
      .map((node) => node.id);
    for (const id of linkIds) {
      this.syncLinkPhysicsFromNode(id);
    }
  }

  private findLinkAncestorId(doc: ProjectDoc, nodeId: string): string | null {
    let cur: string | null = nodeId;
    while (cur) {
      const node: SceneNode | undefined = doc.scene.nodes[cur];
      if (!node) return null;
      if (node.kind === "link") return cur;
      cur = node.parentId ?? null;
    }
    return null;
  }

  private pruneMissingNodes(doc: ProjectDoc) {
    const validIds = new Set(Object.keys(doc.scene.nodes));
    const roots = this.viewer.getUserRoots();
    const toRemove: THREE.Object3D[] = [];

    const stack = [...roots];
    while (stack.length) {
      const obj = stack.pop() as THREE.Object3D;
      if (obj.userData?.__urdfHelper) continue;
      if (!isManagedSceneObject(obj)) {
        for (let i = obj.children.length - 1; i >= 0; i -= 1) {
          stack.push(obj.children[i]);
        }
        continue;
      }
      const docId = obj.userData?.docId ? String(obj.userData.docId) : null;
      if (docId && !validIds.has(docId)) {
        toRemove.push(obj);
        continue;
      }
      for (let i = obj.children.length - 1; i >= 0; i -= 1) {
        stack.push(obj.children[i]);
      }
    }

    for (const obj of toRemove) {
      const parent = obj.parent as { name?: string } | null;
      if (parent?.name === "__USER_ROOT__") {
        this.viewer.removeFromUserScene(getDocId(obj));
        continue;
      }
      obj.removeFromParent();
      this.viewer.unregisterObject(obj);
      disposeObject3D(obj);
    }
  }

  private populateComponents(nodes: Record<string, SceneNode>) {
    for (const node of Object.values(nodes)) {
      const obj = this.viewer.getObjectById(node.id);
      if (!obj) continue;
      const instance = ensureUserInstance(obj);
      node.components = {
        ...(node.components ?? {}),
        transform: objectToTransform(obj),
        physics: instance.physics,
        physicsFields: instance.fields,
        urdf: obj.userData?.urdf as UrdfInstance | undefined,
        urdfSource: obj.userData?.urdfSource as string | undefined,
        urdfKey: obj.userData?.urdfKey as string | undefined,
        urdfImportOptions: obj.userData?.urdfImportOptions as UrdfImportOptions | undefined,
      };
    }
  }

  private syncRoots(doc: ProjectDoc) {
    const docRootSet = new Set(doc.scene.roots);
    const userRoots = this.viewer.getUserRoots();
    for (const root of userRoots) {
      const rootId = getDocId(root);
      if (!docRootSet.has(rootId)) {
        this.viewer.removeFromUserScene(rootId);
      }
    }

    const createdCloneRoots: string[] = [];

    for (const rootId of doc.scene.roots) {
      const existing = this.viewer.getObjectById(rootId);
      if (existing) continue;
      const node = doc.scene.nodes[rootId];
      if (!node) continue;

      if (node.source?.kind === "clone") {
        const created = this.cloneFromSource(doc, rootId);
        if (created) {
          createdCloneRoots.push(rootId);
          continue;
        }
      }

      const created = this.createFromNode(node);
      const group = created ?? new THREE.Group();
      group.name = node.name || group.name || "Group";
      group.userData.docId = rootId;
      markSceneNode(group);
      this.viewer.addToUserScene(group, group.name, { frame: false });
    }

    const cloneNodes = new Set<string>();
    for (const rootId of createdCloneRoots) {
      const stack = [rootId];
      while (stack.length) {
        const id = stack.pop() as string;
        const node = doc.scene.nodes[id];
        if (!node) continue;
        cloneNodes.add(id);
        for (let i = node.children.length - 1; i >= 0; i -= 1) {
          stack.push(node.children[i]);
        }
      }
    }

    for (const nodeId of Object.keys(doc.scene.nodes)) {
      if (this.viewer.getObjectById(nodeId)) continue;
      if (cloneNodes.has(nodeId)) continue;
      this.ensureEmptyNode(doc, nodeId);
    }
  }

  private syncHierarchy(doc: ProjectDoc) {
    for (const node of Object.values(doc.scene.nodes)) {
      const obj = this.viewer.getObjectById(node.id);
      if (!obj) continue;
      if (node.parentId) {
        const parent = this.viewer.getObjectById(node.parentId);
        if (parent && obj.parent !== parent) {
          parent.add(obj);
        }
      } else {
        const parentIsUserRoot = obj.parent && (obj.parent as any).name === "__USER_ROOT__";
        if (!parentIsUserRoot) {
          this.viewer.moveToUserRoot(obj, { frame: false });
        }
      }
    }
  }

  private ensureEmptyNode(doc: ProjectDoc, nodeId: string) {
    if (this.viewer.getObjectById(nodeId)) return;
    const node = doc.scene.nodes[nodeId];
    if (!node) return;
    if (node.parentId) {
      this.ensureEmptyNode(doc, node.parentId);
    }
    const cloned = node.source?.kind === "clone" ? this.buildCloneObject(doc, nodeId) : null;
    const created = cloned ?? this.createFromNode(node);
    const obj = created ?? new THREE.Group();
    obj.name = node.name || obj.name || "Group";
    obj.userData.docId = nodeId;
    markSceneNode(obj);
    if (node.parentId) {
      const parent = this.viewer.getObjectById(node.parentId);
      if (parent) {
        parent.add(obj);
        this.viewer.registerObject(obj);
      }
      else this.viewer.addToUserScene(obj, obj.name, { frame: false });
    } else {
      this.viewer.addToUserScene(obj, obj.name, { frame: false });
    }
  }

  private cloneFromSource(doc: ProjectDoc, rootCloneId: string) {
    const clone = this.buildCloneObject(doc, rootCloneId);
    if (!clone) return false;
    const rootNode = doc.scene.nodes[rootCloneId];
    clone.name = rootNode?.name || clone.name || "Group";
    this.viewer.addToUserScene(clone, clone.name, { frame: false });
    return true;
  }

  private buildCloneObject(doc: ProjectDoc, rootCloneId: string) {
    const rootNode = doc.scene.nodes[rootCloneId];
    if (!rootNode?.source || rootNode.source.kind !== "clone") return null;
    const sourceRootId = rootNode.source.fromId;
    const sourceRoot = this.viewer.getObjectById(sourceRootId);
    if (!sourceRoot) return null;

    const mapping = this.buildCloneMapping(doc, rootCloneId);
    if (!mapping.size) return null;

    const clone = sourceRoot.clone(true);
    if ((sourceRoot as any).isRobot) {
      (clone as any).isRobot = true;
    }
    this.assignCloneIds(sourceRoot, clone, mapping);
    return clone;
  }

  private createFromNode(node: SceneNode): THREE.Object3D | null {
    if (node.source?.kind === "primitive") {
      const obj = createPrimitiveObject(node.source.shape);
      obj.name = node.name || obj.name || "Primitive";
      if (node.kind === "visual" || node.kind === "collision") {
        obj.userData.editorKind = node.kind;
      } else if (node.kind === "mesh") {
        obj.userData.editorKind = "mesh";
      }
      return obj;
    }
    if (node.kind === "robot") {
      const group = new THREE.Group();
      group.name = node.name || "Robot";
      (group as any).isRobot = true;
      group.userData.editorRobotRoot = true;
      return group;
    }
    if (node.kind === "link" || node.kind === "joint" || node.kind === "visual" || node.kind === "collision") {
      const group = new THREE.Group();
      group.name =
        node.name ||
        (node.kind === "link"
          ? "Link"
          : node.kind === "joint"
            ? "Joint"
            : node.kind === "visual"
              ? "Visual"
              : "Collision");
      group.userData.editorKind = node.kind;
      return group;
    }
    if (node.kind === "mesh") {
      const group = new THREE.Group();
      group.name = node.name || "Mesh";
      group.userData.editorKind = "mesh";
      return group;
    }
    return null;
  }

  private buildCloneMapping(doc: ProjectDoc, rootCloneId: string) {
    const mapping = new Map<string, string>();
    const stack = [rootCloneId];
    while (stack.length) {
      const id = stack.pop() as string;
      const node = doc.scene.nodes[id];
      if (!node) continue;
      if (node.source?.kind === "clone") {
        mapping.set(node.source.fromId, node.id);
      }
      for (let i = node.children.length - 1; i >= 0; i -= 1) {
        stack.push(node.children[i]);
      }
    }
    return mapping;
  }

  private assignCloneIds(source: THREE.Object3D, clone: THREE.Object3D, mapping: Map<string, string>) {
    const sourceId = getDocId(source);
    const mapped = mapping.get(sourceId);
    if (mapped) {
      clone.userData.docId = mapped;
    }
    const sourceAny = source as any;
    const cloneAny = clone as any;
    const urdfFlags = ["isURDFLink", "isURDFJoint", "isURDFCollider", "isURDFVisual", "isRobot"];
    for (const key of urdfFlags) {
      if (sourceAny[key]) cloneAny[key] = sourceAny[key];
    }
    if (source.userData) {
      clone.userData = { ...source.userData, ...clone.userData };
      if (mapped) clone.userData.docId = mapped;
    }
    const childCount = Math.min(source.children.length, clone.children.length);
    for (let i = 0; i < childCount; i += 1) {
      this.assignCloneIds(source.children[i], clone.children[i], mapping);
    }
  }
}

function applyPhysicsFromDoc(
  obj: THREE.Object3D,
  physics: InstancePhysics,
  fields?: PhysicsFields
) {
  const physicsData: Record<string, unknown> = {};
  if (fields) {
    if (fields.mass) physicsData.mass = physics.mass;
    if (fields.density) physicsData.density = physics.density;
    if (fields.inertia) physicsData.inertia = { ...physics.inertia };
    if (fields.inertiaTensor && physics.inertiaTensor) physicsData.inertiaTensor = { ...physics.inertiaTensor };
    if (fields.com && physics.com) physicsData.com = { ...physics.com };
    if (fields.friction) physicsData.friction = physics.friction;
    if (fields.restitution) physicsData.restitution = physics.restitution;
    if (fields.collisionsEnabled) physicsData.collisionsEnabled = physics.collisionsEnabled;
    if (fields.fixed) physicsData.fixed = physics.fixed;
    if (fields.useDensity) physicsData.useDensity = physics.useDensity;
  } else {
    physicsData.mass = physics.mass;
    physicsData.density = physics.density;
    physicsData.inertia = { ...physics.inertia };
    if (physics.inertiaTensor) physicsData.inertiaTensor = { ...physics.inertiaTensor };
    if (physics.com) physicsData.com = { ...physics.com };
    physicsData.friction = physics.friction;
    physicsData.restitution = physics.restitution;
    physicsData.collisionsEnabled = physics.collisionsEnabled;
    physicsData.fixed = physics.fixed;
    physicsData.useDensity = physics.useDensity;
  }

  obj.userData.physics = physicsData;
  const instance = ensureUserInstance(obj);
  instance.physics = { ...physics, inertia: { ...physics.inertia } };
  if (fields) {
    instance.fields = { ...fields };
  }
  obj.userData.instance = instance;
}
