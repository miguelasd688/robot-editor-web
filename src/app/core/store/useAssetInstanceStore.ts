/* eslint-disable @typescript-eslint/no-explicit-any */
import { create } from "zustand";
import * as THREE from "three";
import type { InstancePhysics, PhysicsFields, Vec3 } from "../assets/types";
import { defaultPhysics } from "../assets/assetInstancePhysics";
import { editorEngine } from "../editor/engineSingleton";
import type { ProjectDoc, SceneNode, Transform, VisualComponent } from "../editor/document/types";
import type { Pose, UrdfInstance } from "../urdf/urdfModel";
import { getThreeAdapter } from "../editor/adapters/three/adapterSingleton";
import { useAppStore } from "./useAppStore";
import {
  collectJointChildLinkIds,
  findJointParentLinkId,
  resolveLinkLabel,
} from "../editor/kinematics/jointKinematics";

type AssetTransform = Transform;

type TransformPatch = {
  position?: Partial<Vec3>;
  rotation?: Partial<Vec3>;
  scale?: Partial<Vec3>;
};

export type AssetInstance = {
  id: string;
  name: string;
  kind: SceneNode["kind"];
  transform: AssetTransform;
  physics: InstancePhysics;
  fields: PhysicsFields;
  urdf?: UrdfInstance;
  visual?: VisualComponent;
};

type AssetInstanceState = {
  instances: Record<string, AssetInstance>;
  syncFromViewer: () => void; // legacy: now syncs from doc
  registerRoot: () => void; // legacy no-op
  removeRoot: () => void; // legacy no-op
  clear: () => void;
  updateFromObject: () => void; // legacy no-op
  updateTransform: (id: string, patch: TransformPatch) => void;
  updatePhysics: (id: string, patch: Partial<InstancePhysics>) => void;
  updateUrdf: (id: string, next: UrdfInstance) => void;
  updateVisual: (id: string, patch: Partial<VisualComponent>) => void;
};

const defaultTransform = (): AssetTransform => ({
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
});

const clonePhysics = (physics: InstancePhysics): InstancePhysics => ({
  mass: physics.mass,
  density: physics.density,
  inertia: { ...physics.inertia },
  inertiaTensor: physics.inertiaTensor ? { ...physics.inertiaTensor } : undefined,
  com: physics.com ? { ...physics.com } : undefined,
  friction: physics.friction,
  restitution: physics.restitution,
  collisionsEnabled: physics.collisionsEnabled,
  fixed: physics.fixed,
  useDensity: physics.useDensity,
});

const mergeTransform = (current: AssetTransform, patch: TransformPatch): AssetTransform => ({
  position: { ...current.position, ...(patch.position ?? {}) },
  rotation: { ...current.rotation, ...(patch.rotation ?? {}) },
  scale: { ...current.scale, ...(patch.scale ?? {}) },
});

const degToRad = (value: number) => (value * Math.PI) / 180;
const radToDeg = (value: number) => (value * 180) / Math.PI;
const TRANSFORM_DEBUG = String(import.meta.env.VITE_EDITOR_TRANSFORM_DEBUG ?? "true").toLowerCase() !== "false";

const debugTransform = (event: string, data?: Record<string, unknown>) => {
  if (!TRANSFORM_DEBUG) return;
  console.debug(`[asset:transform] ${event}`, data ?? {});
};

const poseFromTransform = (transform: AssetTransform) => {
  const quat = new THREE.Quaternion();
  quat.setFromEuler(
    new THREE.Euler(degToRad(transform.rotation.x), degToRad(transform.rotation.y), degToRad(transform.rotation.z), "XYZ")
  );
  const rpy = new THREE.Euler().setFromQuaternion(quat, "ZYX");
  return {
    xyz: [transform.position.x, transform.position.y, transform.position.z] as [number, number, number],
    rpy: [rpy.x, rpy.y, rpy.z] as [number, number, number],
  };
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

const samePoseWithEps = (a: Pose, b: Pose, eps = 1e-9) =>
  Math.abs(a.xyz[0] - b.xyz[0]) < eps &&
  Math.abs(a.xyz[1] - b.xyz[1]) < eps &&
  Math.abs(a.xyz[2] - b.xyz[2]) < eps &&
  Math.abs(a.rpy[0] - b.rpy[0]) < eps &&
  Math.abs(a.rpy[1] - b.rpy[1]) < eps &&
  Math.abs(a.rpy[2] - b.rpy[2]) < eps;

const normalizeOffsetPose = (pose: Pose): Pose | undefined =>
  samePoseWithEps(pose, identityPose()) ? undefined : pose;

const composePoseWithDelta = (current: Pose | undefined, delta: THREE.Matrix4): Pose | undefined => {
  const next = poseFromMatrix(delta.clone().multiply(matrixFromPose(current ?? identityPose())));
  return normalizeOffsetPose(next);
};

const transformFromPose = (
  pose: { xyz: [number, number, number]; rpy: [number, number, number] },
  current?: AssetTransform
): AssetTransform => {
  const quat = new THREE.Quaternion();
  quat.setFromEuler(new THREE.Euler(pose.rpy[0], pose.rpy[1], pose.rpy[2], "ZYX"));
  const euler = new THREE.Euler().setFromQuaternion(quat, "XYZ");
  return {
    position: { x: pose.xyz[0], y: pose.xyz[1], z: pose.xyz[2] },
    rotation: { x: radToDeg(euler.x), y: radToDeg(euler.y), z: radToDeg(euler.z) },
    scale: current?.scale ?? { x: 1, y: 1, z: 1 },
  };
};

const matrixFromTransform = (transform: AssetTransform) => {
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

const transformFromMatrix = (matrix: THREE.Matrix4): AssetTransform => {
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

const isSameVec3 = (a?: Vec3, b?: Vec3) => !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z;

const isSameTransform = (a?: AssetTransform, b?: AssetTransform) =>
  !!a &&
  !!b &&
  isSameVec3(a.position, b.position) &&
  isSameVec3(a.rotation, b.rotation) &&
  isSameVec3(a.scale, b.scale);

const isSamePose = (
  a: { xyz: [number, number, number]; rpy: [number, number, number] },
  b: { xyz: [number, number, number]; rpy: [number, number, number] }
) =>
  a.xyz[0] === b.xyz[0] &&
  a.xyz[1] === b.xyz[1] &&
  a.xyz[2] === b.xyz[2] &&
  a.rpy[0] === b.rpy[0] &&
  a.rpy[1] === b.rpy[1] &&
  a.rpy[2] === b.rpy[2];

const compensateJointChildLinks = (
  doc: ProjectDoc,
  jointNode: SceneNode,
  previousTransform: AssetTransform,
  nextTransform: AssetTransform,
  reason = "joint:compensate"
) => {
  if (jointNode.kind !== "joint") return;
  if (isSameTransform(previousTransform, nextTransform)) return;

  const childLinks = collectJointChildLinkIds(doc.scene.nodes, jointNode.id)
    .map((childId) => doc.scene.nodes[childId])
    .filter((child): child is SceneNode => !!child && child.kind === "link");
  if (!childLinks.length) return;

  const oldMat = matrixFromTransform(previousTransform);
  const newMat = matrixFromTransform(nextTransform);
  const delta = new THREE.Matrix4().copy(newMat).invert().multiply(oldMat);
  for (const child of childLinks) {
    const childTransform = child.components?.transform ?? defaultTransform();
    const childMat = matrixFromTransform(childTransform);
    childMat.premultiply(delta);
    const nextChild = transformFromMatrix(childMat);
    if (!isSameTransform(childTransform, nextChild)) {
      debugTransform("panel.update.jointCompensate", {
        jointId: jointNode.id,
        childId: child.id,
        previous: childTransform,
        next: nextChild,
      });
      editorEngine.setNodeTransform(child.id, nextChild, { recordHistory: false, reason });
      const childUrdf = child.components?.urdf;
      if (childUrdf?.kind === "link") {
        const nextOffset = composePoseWithDelta(childUrdf.link.editorOffset, delta);
        const previousOffset = childUrdf.link.editorOffset ?? identityPose();
        const nextOffsetPose = nextOffset ?? identityPose();
        if (!samePoseWithEps(previousOffset, nextOffsetPose)) {
          editorEngine.setNodeUrdf(
            child.id,
            {
              kind: "link",
              link: {
                ...childUrdf.link,
                editorOffset: nextOffset,
              },
            },
            { recordHistory: false, reason }
          );
        }
      }
    }
  }
};

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
    editorEngine.setNodeVisual(
      visual.id,
      { ...current, attachCollisions: nextAttach },
      { recordHistory: false, reason: "collision.syncSource" }
    );
  }
};

const buildInstancesFromDoc = (doc: ProjectDoc): Record<string, AssetInstance> => {
  const instances: Record<string, AssetInstance> = {};
  for (const node of Object.values(doc.scene.nodes)) {
    const components = node.components ?? {};
    const transform = components.transform ?? defaultTransform();
    const physics = components.physics ? clonePhysics(components.physics) : clonePhysics(defaultPhysics);
    const fields = { ...(components.physicsFields ?? {}) };
    instances[node.id] = {
      id: node.id,
      name: node.name,
      kind: node.kind,
      transform,
      physics,
      fields,
      urdf: components.urdf,
      visual: components.visual,
    };
  }
  return instances;
};

const mergePhysics = (current: InstancePhysics, patch: Partial<InstancePhysics>): InstancePhysics => {
  const inertia = { ...current.inertia, ...(patch.inertia ?? {}) };
  let inertiaTensor = patch.inertiaTensor
    ? {
        ixx: patch.inertiaTensor.ixx ?? inertia.x,
        iyy: patch.inertiaTensor.iyy ?? inertia.y,
        izz: patch.inertiaTensor.izz ?? inertia.z,
        ixy: patch.inertiaTensor.ixy ?? current.inertiaTensor?.ixy ?? 0,
        ixz: patch.inertiaTensor.ixz ?? current.inertiaTensor?.ixz ?? 0,
        iyz: patch.inertiaTensor.iyz ?? current.inertiaTensor?.iyz ?? 0,
      }
    : current.inertiaTensor
      ? { ...current.inertiaTensor }
      : undefined;
  if (patch.inertia && !patch.inertiaTensor) {
    inertiaTensor = inertiaTensor
      ? { ...inertiaTensor, ixx: inertia.x, iyy: inertia.y, izz: inertia.z }
      : { ixx: inertia.x, iyy: inertia.y, izz: inertia.z, ixy: 0, ixz: 0, iyz: 0 };
  }
  return {
    ...current,
    ...patch,
    inertia,
    inertiaTensor,
  };
};

const nextFieldsFromPatch = (current: PhysicsFields, patch: Partial<InstancePhysics>): PhysicsFields => {
  const next = { ...current };
  if (patch.mass !== undefined) next.mass = true;
  if (patch.density !== undefined) next.density = true;
  if (patch.inertia !== undefined) next.inertia = true;
  if (patch.inertiaTensor !== undefined) next.inertiaTensor = true;
  if (patch.com !== undefined) next.com = true;
  if (patch.friction !== undefined) next.friction = true;
  if (patch.restitution !== undefined) next.restitution = true;
  if (patch.collisionsEnabled !== undefined) next.collisionsEnabled = true;
  if (patch.fixed !== undefined) next.fixed = true;
  if (patch.useDensity !== undefined) next.useDensity = true;
  return next;
};

export const useAssetInstanceStore = create<AssetInstanceState>((set) => {
  const initial = editorEngine.getDoc();
  editorEngine.on("doc:changed", (event) => {
    set({ instances: buildInstancesFromDoc(event.doc) });
  });

  return {
    instances: buildInstancesFromDoc(initial),

    syncFromViewer: () => {
      set({ instances: buildInstancesFromDoc(editorEngine.getDoc()) });
    },
    registerRoot: () => {
      set({ instances: buildInstancesFromDoc(editorEngine.getDoc()) });
    },
    removeRoot: () => {
      set({ instances: buildInstancesFromDoc(editorEngine.getDoc()) });
    },
    clear: () => set({ instances: {} }),

    updateFromObject: () => {
      set({ instances: buildInstancesFromDoc(editorEngine.getDoc()) });
    },

    updateTransform: (id, patch) => {
      if (useAppStore.getState().simState === "playing") return;
      const doc = editorEngine.getDoc();
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
        ensureCollisionSyncSourceVisual(doc.scene.nodes, linkId, visualId);
      }

      const current = node.components?.transform ?? defaultTransform();
      const next = mergeTransform(current, patch);
      debugTransform("panel.update.start", {
        id,
        targetId,
        nodeKind: node.kind,
        patch,
        current,
        next,
      });
      if (node.kind === "joint") {
        compensateJointChildLinks(doc, node, current, next);
      }
      editorEngine.setNodeTransform(targetId, next, { recordHistory: true });
      if (node.kind === "link" && node.components?.urdf?.kind === "link") {
        const hasIncomingJoint = Boolean(findAncestorIdByKind(doc.scene.nodes, node.parentId ?? null, "joint"));
        const nextOffset = hasIncomingJoint ? normalizeOffsetPose(poseFromTransform(next)) : undefined;
        const previousOffset = node.components.urdf.link.editorOffset ?? identityPose();
        const nextOffsetPose = nextOffset ?? identityPose();
        if (!samePoseWithEps(previousOffset, nextOffsetPose)) {
          editorEngine.setNodeUrdf(
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
          debugTransform("panel.update.writeLinkOffset", {
            linkId: targetId,
            hasIncomingJoint,
            previous: previousOffset,
            next: nextOffset,
          });
        }
      }
      debugTransform("panel.update.write", {
        id,
        targetId,
        written: next,
      });
      if (node.kind === "joint" && node.components?.urdf?.kind === "joint") {
        const parentLinkId = findJointParentLinkId(doc.scene.nodes, targetId);
        const parentLink = parentLinkId ? doc.scene.nodes[parentLinkId] : null;
        const childLinkId = collectJointChildLinkIds(doc.scene.nodes, targetId)[0] ?? null;
        const childLink = childLinkId ? doc.scene.nodes[childLinkId] : null;
        const urdf = node.components.urdf;
        editorEngine.setNodeUrdf(
          targetId,
          {
            kind: "joint",
            joint: {
              ...urdf.joint,
              parent: parentLink ? resolveLinkLabel(parentLink) : urdf.joint.parent,
              child: childLink ? resolveLinkLabel(childLink) : urdf.joint.child,
              origin: poseFromTransform(next),
            },
          },
          { recordHistory: false, reason: "viewer:transform" }
        );
        debugTransform("panel.update.writeJointUrdf", {
          jointId: targetId,
          parentLinkId: parentLink?.id ?? null,
          origin: poseFromTransform(next),
        });
      }
      getThreeAdapter()?.syncLinkPhysicsFromNode(targetId);
    },

    updatePhysics: (id, patch) => {
      const doc = editorEngine.getDoc();
      const node = doc.scene.nodes[id];
      if (!node) return;
      const current = node.components?.physics ?? clonePhysics(defaultPhysics);
      const next = mergePhysics(current, patch);
      const fields = nextFieldsFromPatch(node.components?.physicsFields ?? {}, patch);
      editorEngine.setNodePhysics(id, next, fields);
      const shouldSync =
        patch.mass !== undefined ||
        patch.density !== undefined ||
        patch.useDensity !== undefined ||
        patch.inertia !== undefined ||
        patch.inertiaTensor !== undefined ||
        patch.com !== undefined;
      if (shouldSync) getThreeAdapter()?.syncLinkPhysicsFromNode(id);
    },

    updateUrdf: (id, next) => {
      const doc = editorEngine.getDoc();
      const node = doc.scene.nodes[id];
      if (!node) return;
      const simRunning = useAppStore.getState().simState === "playing";
      const currentUrdf = node.components?.urdf;
      if (
        simRunning &&
        next.kind === "joint" &&
        currentUrdf?.kind === "joint" &&
        !isSamePose(next.joint.origin, currentUrdf.joint.origin)
      ) {
        return;
      }

      editorEngine.setNodeUrdf(id, next);
      if (next.kind === "joint") {
        if (simRunning) return;
        const currentTransform = node.components?.transform ?? defaultTransform();
        const pose = next.joint.origin;
        const nextTransform = transformFromPose(pose, currentTransform);
        if (!isSameTransform(currentTransform, nextTransform)) {
          compensateJointChildLinks(doc, node, currentTransform, nextTransform, "joint:compensate:urdf");
          editorEngine.setNodeTransform(id, nextTransform, { recordHistory: false, reason: "urdf:sync" });
        }
      }
    },
    updateVisual: (id, patch) => {
      const doc = editorEngine.getDoc();
      const node = doc.scene.nodes[id];
      if (!node) return;
      const current = node.components?.visual ?? {};
      const next = { ...current, ...patch };
      editorEngine.setNodeVisual(id, next);
    },
  };
});
