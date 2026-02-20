import * as THREE from "three";
import type { CreateNodeInput, DocId, Transform, VisualComponent } from "../document/types";
import type { EditorCommand } from "./types";
import { addNode, addNodes, cloneSubtree, pasteSubtree, removeSubtree, setNodeName, setNodeParent, setSelection, upsertNodePhysics, upsertNodeTransform, upsertNodeUrdf, upsertNodeVisual, type ClonePayload } from "../document/ops";
import type { InstancePhysics, PhysicsFields } from "../../assets/types";
import type { UrdfInstance } from "../../urdf/urdfModel";
import { defaultPhysics } from "../../assets/assetInstancePhysics";

export function setSelectionCommand(id: DocId | null): EditorCommand {
  return {
    id: "scene.select",
    label: "Select",
    apply: (doc) => setSelection(doc, id),
  };
}

export function setNodeNameCommand(id: DocId, name: string): EditorCommand {
  return {
    id: "scene.rename",
    label: "Rename",
    apply: (doc) => setNodeName(doc, id, name),
  };
}

export function setNodeTransformCommand(id: DocId, transform: Transform): EditorCommand {
  return {
    id: "scene.transform",
    label: "Transform",
    apply: (doc) => upsertNodeTransform(doc, id, transform),
  };
}

export function setNodePhysicsCommand(
  id: DocId,
  physics: InstancePhysics,
  fields?: PhysicsFields
): EditorCommand {
  return {
    id: "scene.physics",
    label: "Physics",
    apply: (doc) => upsertNodePhysics(doc, id, physics, fields),
  };
}

const RAD2DEG = 180 / Math.PI;

function transformFromUrdf(origin: { xyz: [number, number, number]; rpy: [number, number, number] }) {
  const quat = new THREE.Quaternion();
  quat.setFromEuler(new THREE.Euler(origin.rpy[0], origin.rpy[1], origin.rpy[2], "ZYX"));
  const euler = new THREE.Euler().setFromQuaternion(quat, "XYZ");
  return {
    position: { x: origin.xyz[0], y: origin.xyz[1], z: origin.xyz[2] },
    rotation: {
      x: euler.x * RAD2DEG,
      y: euler.y * RAD2DEG,
      z: euler.z * RAD2DEG,
    },
    scale: { x: 1, y: 1, z: 1 },
  };
}

export function setNodeUrdfCommand(id: DocId, urdf: UrdfInstance): EditorCommand {
  return {
    id: "scene.urdf",
    label: "URDF",
    apply: (doc) => {
      let next = upsertNodeUrdf(doc, id, urdf);
      const node = next.scene.nodes[id];
      if (!node) return next;

      if (urdf.kind === "joint") {
        const currentScale = node.components?.transform?.scale ?? { x: 1, y: 1, z: 1 };
        const base = transformFromUrdf(urdf.joint.origin);
        const transform = {
          ...base,
          scale: currentScale,
        };
        next = upsertNodeTransform(next, id, transform);
      }

      if (urdf.kind === "link" && urdf.link.inertial) {
        const currentPhysics = node.components?.physics ?? defaultPhysics;
        const currentFields = node.components?.physicsFields ?? {};
        const nextPhysics: InstancePhysics = {
          ...currentPhysics,
          mass: urdf.link.inertial.mass,
          inertia: {
            x: urdf.link.inertial.inertia.ixx,
            y: urdf.link.inertial.inertia.iyy,
            z: urdf.link.inertial.inertia.izz,
          },
        };
        const nextFields: PhysicsFields = {
          ...currentFields,
          mass: true,
          inertia: true,
        };
        next = upsertNodePhysics(next, id, nextPhysics, nextFields);
      }

      return next;
    },
  };
}

export function setNodeVisualCommand(id: DocId, visual: VisualComponent): EditorCommand {
  return {
    id: "scene.visual",
    label: "Visual",
    apply: (doc) => upsertNodeVisual(doc, id, visual),
  };
}

export function removeSubtreeCommand(rootId: DocId): EditorCommand {
  return {
    id: "scene.remove",
    label: "Remove",
    apply: (doc) => removeSubtree(doc, rootId),
  };
}

export function addNodeCommand(input: CreateNodeInput): EditorCommand {
  return {
    id: "scene.add",
    label: "Add Node",
    apply: (doc) => addNode(doc, input),
  };
}

export function addNodesCommand(inputs: CreateNodeInput[], options?: { selectId?: DocId }): EditorCommand {
  return {
    id: "scene.addNodes",
    label: "Add Nodes",
    apply: (doc) => addNodes(doc, inputs, options),
  };
}

export function setNodeParentCommand(id: DocId, parentId: DocId | null, transform?: Transform): EditorCommand {
  return {
    id: "scene.reparent",
    label: "Reparent",
    apply: (doc) => {
      let next = setNodeParent(doc, id, parentId);
      if (transform) {
        next = upsertNodeTransform(next, id, transform);
      }
      return next;
    },
  };
}

export function duplicateSubtreeCommand(
  rootId: DocId,
  options?: { offset?: { x: number; y: number; z: number } }
): EditorCommand {
  return {
    id: "scene.duplicate",
    label: "Duplicate",
    apply: (doc) => cloneSubtree(doc, rootId, { offset: options?.offset }),
  };
}

export function pasteSubtreeCommand(
  payload: ClonePayload,
  options?: { offset?: { x: number; y: number; z: number }; parentId?: DocId | null; insertAfterId?: DocId }
): EditorCommand {
  return {
    id: "scene.paste",
    label: "Paste",
    apply: (doc) =>
      pasteSubtree(doc, payload, {
        offset: options?.offset,
        nameSuffix: " Paste",
        parentId: options?.parentId,
        insertAfterId: options?.insertAfterId,
      }),
  };
}
