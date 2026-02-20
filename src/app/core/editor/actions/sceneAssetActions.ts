import * as THREE from "three";
import type { Vec3 } from "../../assets/types";
import { useMujocoStore } from "../../store/useMujocoStore";
import { useDockStore } from "../../store/useDockStore";
import { logWarn } from "../../services/logger";
import { editorEngine } from "../engineSingleton";
import { addNodesCommand } from "../commands/sceneCommands";
import { createSceneAssetTree, type SceneAssetId } from "../../scene/sceneAssets";
import type { UrdfInstance } from "../../urdf/urdfModel";
import { resolveNearestLinkAncestor, resolveNearestRobotAncestor } from "./hierarchyRules";

const jointAssetIds = new Set<SceneAssetId>(["joint", "joint:free", "joint:actuator"]);

function mergePosition(current: Vec3, next?: Vec3): Vec3 {
  if (!next) return current;
  return {
    x: current.x + next.x,
    y: current.y + next.y,
    z: current.z + next.z,
  };
}

const degToRad = (value: number) => (value * Math.PI) / 180;

const poseFromTransform = (transform: { position: Vec3; rotation: Vec3 }) => {
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

const findRobotAncestor = (doc: ReturnType<typeof editorEngine.getDoc>, startId: string | null) => {
  let cur: string | null = startId;
  while (cur) {
    const node = doc.scene.nodes[cur];
    if (!node) return null;
    if (node.kind === "robot") return node;
    cur = node.parentId ?? null;
  }
  return null;
};

const findPreferredVisualContainer = (doc: ReturnType<typeof editorEngine.getDoc>, linkId: string) => {
  const link = doc.scene.nodes[linkId];
  if (!link) return null;
  const visuals = link.children
    .map((childId) => doc.scene.nodes[childId])
    .filter((node) => node?.kind === "visual");
  if (!visuals.length) return null;
  const withSync = visuals.find((node) => node?.components?.visual?.attachCollisions);
  return (withSync ?? visuals[0])?.id ?? null;
};

const findVisualSiblingForCollision = (doc: ReturnType<typeof editorEngine.getDoc>, collisionId: string) => {
  const collision = doc.scene.nodes[collisionId];
  if (!collision) return null;
  const parentId = collision.parentId ?? null;
  const siblingIds = parentId ? doc.scene.nodes[parentId]?.children ?? [] : doc.scene.roots;
  const visuals = siblingIds
    .map((id) => doc.scene.nodes[id])
    .filter((node) => node?.kind === "visual");
  if (!visuals.length) return null;
  const withSync = visuals.find((node) => node?.components?.visual?.attachCollisions);
  return (withSync ?? visuals[0])?.id ?? null;
};

function resolveParentForAsset(doc: ReturnType<typeof editorEngine.getDoc>, assetId: SceneAssetId, selectedId: string | null) {
  const selected = selectedId ? doc.scene.nodes[selectedId] : null;
  const nearestRobot = resolveNearestRobotAncestor(doc, selectedId);
  const nearestLink = resolveNearestLinkAncestor(doc, selectedId);

  if (assetId === "robot") {
    return { parentId: null, parentKind: null as string | null };
  }

  if (assetId === "link") {
    const parent = nearestRobot;
    return {
      parentId: parent?.id ?? null,
      parentKind: parent?.kind ?? null,
    };
  }

  if (assetId.startsWith("mesh:")) {
    if (selected?.kind === "visual") {
      return {
        parentId: selected.id,
        parentKind: selected.kind,
      };
    }
    if (selected?.kind === "collision") {
      const visualId = findVisualSiblingForCollision(doc, selected.id);
      if (visualId) {
        return {
          parentId: visualId,
          parentKind: "visual",
        };
      }
    }
    if (nearestLink) {
      const visualId = findPreferredVisualContainer(doc, nearestLink.id);
      if (visualId) {
        return {
          parentId: visualId,
          parentKind: "visual",
        };
      }
    }
    const parent = nearestLink ?? nearestRobot;
    return {
      parentId: parent?.id ?? null,
      parentKind: parent?.kind ?? null,
    };
  }

  return {
    parentId: selected?.id ?? null,
    parentKind: selected?.kind ?? null,
  };
}

export function addSceneAsset(assetId: SceneAssetId, options?: { position?: Vec3 }) {
  const doc = editorEngine.getDoc();
  const selectedId = doc.scene.selectedId ?? null;
  const selectedKind = selectedId ? doc.scene.nodes[selectedId]?.kind ?? null : null;
  const effectiveAssetId: SceneAssetId =
    assetId === "link" && selectedKind === "link" ? "mesh:cube" : assetId;
  const { parentId, parentKind } = resolveParentForAsset(doc, effectiveAssetId, selectedId);
  const isJointAsset = jointAssetIds.has(effectiveAssetId);

  if (isJointAsset) {
    if (!selectedId || selectedKind !== "link") {
      logWarn("Joint assets must be created inside a Link. Select a Link and try again.", {
        scope: "assets",
      });
      return;
    }
    const robot = findRobotAncestor(doc, selectedId);
    if (!robot) {
      logWarn("Joint created outside a Robot. Joints can work independently, but a Robot container is recommended.", {
        scope: "assets",
      });
    }
  }

  const tree = createSceneAssetTree(effectiveAssetId, { parentId, parentKind });

  if (isJointAsset) {
    const rootIndex = tree.nodes.findIndex((node) => node.id === tree.rootId);
    if (rootIndex >= 0) {
      const root = tree.nodes[rootIndex];
      const transform = root.components?.transform ?? {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      };
      const parentName = parentId ? doc.scene.nodes[parentId]?.name ?? parentId : "parent";
      const jointType = effectiveAssetId === "joint:free" ? "continuous" : "revolute";
      const actuator =
        effectiveAssetId === "joint:free"
          ? { enabled: false }
          : effectiveAssetId === "joint:actuator"
            ? {
                enabled: true,
                type: "position" as const,
                stiffness: 50,
                damping: 5,
              }
            : undefined;
      const urdf: UrdfInstance = {
        kind: "joint",
        joint: {
          name: root.name,
          type: jointType,
          parent: parentName,
          child: "",
          origin: poseFromTransform(transform),
          axis: [0, 0, 1],
          limit: { lower: -180, upper: 180 },
          actuator,
        },
      };
      tree.nodes[rootIndex] = {
        ...root,
        components: {
          ...(root.components ?? {}),
          transform,
          urdf,
        },
      };
    }
  }

  const rootIndex = tree.nodes.findIndex((node) => node.id === tree.rootId);
  if (rootIndex >= 0 && options?.position && !parentId) {
    const root = tree.nodes[rootIndex];
    const transform = root.components?.transform ?? {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    };
    tree.nodes[rootIndex] = {
      ...root,
      components: {
        ...(root.components ?? {}),
        transform: {
          ...transform,
          position: mergePosition(transform.position, options.position),
        },
      },
    };
  }

  editorEngine.execute(addNodesCommand(tree.nodes, { selectId: tree.rootId }));

  if (isJointAsset) {
    const dock = useDockStore.getState();
    const opened = dock.isOpen("asset-inspector");
    if (opened) {
      dock.setActive(opened.dock, "asset-inspector");
    } else {
      dock.openPanel("right", "asset-inspector");
    }
  }

  useMujocoStore.getState().markSceneDirty();
}
