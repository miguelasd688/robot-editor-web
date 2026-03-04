import type { CreateNodeInput, DocId, Transform } from "../editor/document/types";
import type { InstancePhysics, PhysicsFields } from "../assets/types";
import { defaultPhysics } from "../assets/assetInstancePhysics";
import { createDocId } from "./docIds";

export type SceneAssetId =
  | "floor"
  | "floor:rough"
  | "robot"
  | "link"
  | "joint"
  | "joint:free"
  | "joint:actuator"
  | "joint:muscle"
  | "visual"
  | "collision"
  | "mesh:cube"
  | "mesh:sphere"
  | "mesh:cylinder";

export type SceneAssetDefinition = {
  id: SceneAssetId;
  name: string;
  description: string;
  icon: string;
  category: "structure" | "geometry" | "robotics";
};

export type SceneAssetTree = {
  rootId: DocId;
  nodes: CreateNodeInput[];
};

const defaultTransform = (overrides?: Partial<Transform>): Transform => ({
  position: { x: 0, y: 0, z: 0, ...(overrides?.position ?? {}) },
  rotation: { x: 0, y: 0, z: 0, ...(overrides?.rotation ?? {}) },
  scale: { x: 1, y: 1, z: 1, ...(overrides?.scale ?? {}) },
});

const allPhysicsFields: PhysicsFields = {
  mass: true,
  density: true,
  inertia: true,
  inertiaTensor: true,
  com: true,
  friction: true,
  restitution: true,
  collisionsEnabled: true,
  fixed: true,
  useDensity: true,
};

function withPhysics(patch?: Partial<InstancePhysics>) {
  return {
    physics: { ...defaultPhysics, ...(patch ?? {}) },
    physicsFields: { ...allPhysicsFields },
  };
}

type PrimitiveMeshShape = "cube" | "sphere" | "cylinder";

const primitiveNames: Record<PrimitiveMeshShape, string> = {
  cube: "Cube",
  sphere: "Sphere",
  cylinder: "Cylinder",
};

function createLinkNode(id: DocId, parentId: DocId | null): CreateNodeInput {
  return {
    id,
    name: "Link",
    kind: "link",
    parentId,
    components: {
      transform: defaultTransform(),
      ...withPhysics({ useDensity: true }),
    },
  };
}

function createVisualNode(id: DocId, parentId: DocId | null): CreateNodeInput {
  return {
    id,
    name: "Visual",
    kind: "visual",
    parentId,
    components: { transform: defaultTransform(), visual: { attachCollisions: true } },
  };
}

function createCollisionNode(id: DocId, parentId: DocId | null): CreateNodeInput {
  return {
    id,
    name: "Collision",
    kind: "collision",
    parentId,
    components: { transform: defaultTransform() },
  };
}

function createPrimitiveMeshNode(id: DocId, parentId: DocId, shape: PrimitiveMeshShape): CreateNodeInput {
  return {
    id,
    name: primitiveNames[shape],
    kind: "mesh",
    parentId,
    source: { kind: "primitive", shape },
    components: { transform: defaultTransform() },
  };
}

function createPrimitiveMeshTree(parentId: DocId, shape: PrimitiveMeshShape): SceneAssetTree {
  const meshId = createDocId();
  return {
    rootId: meshId,
    nodes: [createPrimitiveMeshNode(meshId, parentId, shape)],
  };
}

function createLinkTree(
  linkId: DocId,
  parentId: DocId | null,
  options?: { primitive?: PrimitiveMeshShape; embedUnderLink?: boolean }
): SceneAssetTree {
  const embedUnderLink = Boolean(parentId && options?.embedUnderLink);
  if (embedUnderLink && parentId) {
    const visualId = createDocId();
    const collisionId = createDocId();
    const meshId = options?.primitive ? createDocId() : null;
    const nodes: CreateNodeInput[] = [createVisualNode(visualId, parentId), createCollisionNode(collisionId, parentId)];
    if (meshId && options?.primitive) {
      nodes.push(createPrimitiveMeshNode(meshId, visualId, options.primitive));
    }
    return {
      rootId: meshId ?? visualId,
      nodes,
    };
  }

  const visualId = createDocId();
  const collisionId = createDocId();
  const nodes: CreateNodeInput[] = [
    createLinkNode(linkId, parentId),
    createVisualNode(visualId, linkId),
    createCollisionNode(collisionId, linkId),
  ];
  if (options?.primitive) {
    nodes.push(createPrimitiveMeshNode(createDocId(), visualId, options.primitive));
  }
  return {
    rootId: linkId,
    nodes,
  };
}

export const sceneAssetCatalog: SceneAssetDefinition[] = [
  {
    id: "floor",
    name: "Floor",
    description: "6m plane for grounding the scene",
    icon: "▦",
    category: "geometry",
  },
  {
    id: "floor:rough",
    name: "Rough Floor",
    description: "Floor with raised blocks for rough-terrain testing",
    icon: "▨",
    category: "geometry",
  },
  {
    id: "robot",
    name: "New Robot",
    description: "Create a new robot root for kinematic chains",
    icon: "🤖",
    category: "robotics",
  },
  {
    id: "link",
    name: "Empty Link",
    description: "Physical body container (mass, inertia, collisions)",
    icon: "🔗",
    category: "robotics",
  },
  {
    id: "joint",
    name: "Joint",
    description: "Connects two links in a chain",
    icon: "⚙️",
    category: "robotics",
  },
  {
    id: "joint:free",
    name: "Free Joint",
    description: "Joint without actuator (passive)",
    icon: "🧷",
    category: "robotics",
  },
  {
    id: "joint:actuator",
    name: "Actuator",
    description: "Joint with active actuator enabled",
    icon: "🎛️",
    category: "robotics",
  },
  {
    id: "joint:muscle",
    name: "Muscle Joint",
    description: "Joint with tendon+muscle actuator mode",
    icon: "🫀",
    category: "robotics",
  },
  {
    id: "mesh:cube",
    name: "Cube",
    description: "Link with cube mesh (Visual + Collision are auto-managed)",
    icon: "⬛",
    category: "geometry",
  },
  {
    id: "mesh:sphere",
    name: "Sphere",
    description: "Link with sphere mesh (Visual + Collision are auto-managed)",
    icon: "⚪",
    category: "geometry",
  },
  {
    id: "mesh:cylinder",
    name: "Cylinder",
    description: "Link with cylinder mesh (Visual + Collision are auto-managed)",
    icon: "🥫",
    category: "geometry",
  },
];

export function createSceneAssetTree(
  assetId: SceneAssetId,
  options?: { parentId?: DocId | null; parentKind?: string | null }
): SceneAssetTree {
  const parentId = options?.parentId ?? null;
  const rootId = createDocId();

  const base: Pick<CreateNodeInput, "parentId"> = { parentId };
  const embedUnderLink = Boolean(parentId && options?.parentKind === "link");
  const embedUnderContainer = Boolean(
    parentId && (options?.parentKind === "visual" || options?.parentKind === "collision")
  );

  if (assetId === "robot") {
    return {
      rootId,
      nodes: [
        {
          id: rootId,
          name: "Robot",
          kind: "robot",
          ...base,
          components: { transform: defaultTransform() },
        },
      ],
    };
  }

  if (assetId === "link") {
    return createLinkTree(rootId, parentId);
  }

  if (assetId === "joint" || assetId === "joint:free" || assetId === "joint:actuator" || assetId === "joint:muscle") {
    const jointName =
      assetId === "joint:actuator"
        ? "Actuator Joint"
        : assetId === "joint:free"
          ? "Free Joint"
          : assetId === "joint:muscle"
            ? "Muscle Joint"
            : "Joint";
    return {
      rootId,
      nodes: [
        {
          id: rootId,
          name: jointName,
          kind: "joint",
          ...base,
          components: { transform: defaultTransform() },
        },
      ],
    };
  }

  if (assetId === "visual") {
    return {
      rootId,
      nodes: [
        {
          id: rootId,
          name: "Visual",
          kind: "visual",
          ...base,
          components: { transform: defaultTransform() },
        },
      ],
    };
  }

  if (assetId === "collision") {
    return {
      rootId,
      nodes: [
        {
          id: rootId,
          name: "Collision",
          kind: "collision",
          ...base,
          components: { transform: defaultTransform() },
        },
      ],
    };
  }

  if (assetId === "mesh:cube") {
    if (embedUnderContainer && parentId) return createPrimitiveMeshTree(parentId, "cube");
    return createLinkTree(rootId, parentId, { primitive: "cube", embedUnderLink });
  }

  if (assetId === "mesh:sphere") {
    if (embedUnderContainer && parentId) return createPrimitiveMeshTree(parentId, "sphere");
    return createLinkTree(rootId, parentId, { primitive: "sphere", embedUnderLink });
  }

  if (assetId === "mesh:cylinder") {
    if (embedUnderContainer && parentId) return createPrimitiveMeshTree(parentId, "cylinder");
    return createLinkTree(rootId, parentId, { primitive: "cylinder", embedUnderLink });
  }

  if (assetId === "floor") {
    const floorTransform = defaultTransform({
      position: { x: 0, y: 0, z: -1.5 },
    });

    return {
      rootId,
      nodes: [
        {
          id: rootId,
          name: "Floor",
          kind: "mesh",
          parentId: null,
          source: { kind: "primitive", shape: "plane" },
          components: {
            transform: floorTransform,
            ...withPhysics({
              mass: 0,
              fixed: true,
              useDensity: false,
              friction: 1.1,
              restitution: 0.02,
              collisionsEnabled: true,
            }),
          },
        },
      ],
    };
  }

  if (assetId === "floor:rough") {
    const floorTransform = defaultTransform({
      position: { x: 0, y: 0, z: -1.5 },
    });
    const basePlaneId = rootId;
    const bumpSpecs: Array<{ x: number; y: number; z: number; sx: number; sy: number; sz: number }> = [
      { x: -1.8, y: -1.6, z: 0.11, sx: 0.45, sy: 0.45, sz: 0.22 },
      { x: -0.9, y: -0.9, z: 0.08, sx: 0.35, sy: 0.35, sz: 0.16 },
      { x: 0.0, y: -1.5, z: 0.1, sx: 0.4, sy: 0.55, sz: 0.2 },
      { x: 0.9, y: -0.8, z: 0.09, sx: 0.35, sy: 0.35, sz: 0.18 },
      { x: 1.7, y: -1.7, z: 0.12, sx: 0.5, sy: 0.4, sz: 0.24 },
      { x: -1.4, y: 0.2, z: 0.09, sx: 0.35, sy: 0.35, sz: 0.18 },
      { x: -0.4, y: 0.7, z: 0.1, sx: 0.4, sy: 0.35, sz: 0.2 },
      { x: 0.7, y: 0.4, z: 0.08, sx: 0.3, sy: 0.3, sz: 0.16 },
      { x: 1.6, y: 0.1, z: 0.1, sx: 0.45, sy: 0.35, sz: 0.2 },
      { x: -1.9, y: 1.6, z: 0.12, sx: 0.5, sy: 0.4, sz: 0.24 },
      { x: -0.6, y: 1.5, z: 0.09, sx: 0.35, sy: 0.45, sz: 0.18 },
      { x: 0.8, y: 1.4, z: 0.11, sx: 0.45, sy: 0.35, sz: 0.22 },
      { x: 1.8, y: 1.7, z: 0.13, sx: 0.5, sy: 0.5, sz: 0.26 },
    ];

    const nodes: CreateNodeInput[] = [
      {
        id: basePlaneId,
        name: "Rough Floor",
        kind: "mesh",
        parentId: null,
        source: { kind: "primitive", shape: "plane" },
        components: {
          transform: floorTransform,
          ...withPhysics({
            mass: 0,
            fixed: true,
            useDensity: false,
            friction: 1.2,
            restitution: 0.0,
            collisionsEnabled: true,
          }),
        },
      },
    ];

    for (const [index, bump] of bumpSpecs.entries()) {
      nodes.push({
        id: createDocId(),
        name: `Rough Bump ${index + 1}`,
        kind: "mesh",
        parentId: basePlaneId,
        source: { kind: "primitive", shape: "cube" },
        components: {
          transform: defaultTransform({
            position: { x: bump.x, y: bump.y, z: bump.z },
            scale: { x: bump.sx, y: bump.sy, z: bump.sz },
          }),
          ...withPhysics({
            mass: 0,
            fixed: true,
            useDensity: false,
            friction: 1.2,
            restitution: 0.0,
            collisionsEnabled: true,
          }),
        },
      });
    }

    return {
      rootId: basePlaneId,
      nodes,
    };
  }

  throw new Error(`Unknown asset id: ${assetId}`);
}
