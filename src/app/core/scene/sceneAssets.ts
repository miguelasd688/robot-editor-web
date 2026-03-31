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

const primitiveAssetIds: Record<PrimitiveMeshShape, SceneAssetId> = {
  cube: "mesh:cube",
  sphere: "mesh:sphere",
  cylinder: "mesh:cylinder",
};

function createGeneratedSceneAssetRootNode(
  id: DocId,
  name: string,
  assetId: SceneAssetId,
  role: "scene_asset" | "terrain",
  options?: {
    transform?: Transform;
    metadata?: Record<string, unknown>;
  }
): CreateNodeInput {
  return {
    id,
    name,
    kind: "group",
    parentId: null,
    components: {
      transform: options?.transform ?? defaultTransform(),
      sceneAssetSource: {
        kind: "generated",
        role,
        metadata: {
          generatedFrom: "scene_asset_catalog",
          sceneAssetId: assetId,
          ...(options?.metadata ?? {}),
        },
      },
    },
  };
}

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

function createPrimitiveSceneAssetTree(rootId: DocId, shape: PrimitiveMeshShape): SceneAssetTree {
  const linkId = createDocId();
  const visualId = createDocId();
  const collisionId = createDocId();
  const meshId = createDocId();
  return {
    rootId,
    nodes: [
      createGeneratedSceneAssetRootNode(rootId, primitiveNames[shape], primitiveAssetIds[shape], "scene_asset"),
      createLinkNode(linkId, rootId),
      createVisualNode(visualId, linkId),
      createCollisionNode(collisionId, linkId),
      createPrimitiveMeshNode(meshId, visualId, shape),
    ],
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
    description: "Procedural multi-zone rough terrain (stairs, irregular patch, cube field)",
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
    if (!parentId) return createPrimitiveSceneAssetTree(rootId, "cube");
    return createLinkTree(rootId, parentId, { primitive: "cube", embedUnderLink });
  }

  if (assetId === "mesh:sphere") {
    if (embedUnderContainer && parentId) return createPrimitiveMeshTree(parentId, "sphere");
    if (!parentId) return createPrimitiveSceneAssetTree(rootId, "sphere");
    return createLinkTree(rootId, parentId, { primitive: "sphere", embedUnderLink });
  }

  if (assetId === "mesh:cylinder") {
    if (embedUnderContainer && parentId) return createPrimitiveMeshTree(parentId, "cylinder");
    if (!parentId) return createPrimitiveSceneAssetTree(rootId, "cylinder");
    return createLinkTree(rootId, parentId, { primitive: "cylinder", embedUnderLink });
  }

  if (assetId === "floor") {
    const floorGroupId = rootId;
    const floorLinkId = createDocId();
    const floorVisualId = createDocId();
    const floorCollisionId = createDocId();
    const floorMeshId = createDocId();
    const floorTransform = defaultTransform({
      position: { x: 0, y: 0, z: -0.6 },
    });

    return {
      rootId: floorGroupId,
      nodes: [
        createGeneratedSceneAssetRootNode(floorGroupId, "Floor", "floor", "terrain", {
          transform: floorTransform,
          metadata: {
            managedTerrainAssetId: "floor",
          },
        }),
        {
          id: floorLinkId,
          name: "Link",
          kind: "link",
          parentId: floorGroupId,
          components: {
            transform: defaultTransform(),
            ...withPhysics({
              mass: 0,
              fixed: true,
              useDensity: false,
              friction: 1.0,
              restitution: 0.0,
              collisionsEnabled: true,
            }),
          },
        },
        createVisualNode(floorVisualId, floorLinkId),
        createCollisionNode(floorCollisionId, floorLinkId),
        {
          id: floorMeshId,
          name: "Floor Mesh",
          kind: "mesh",
          parentId: floorVisualId,
          source: { kind: "primitive", shape: "plane" },
          components: { transform: defaultTransform() },
        },
      ],
    };
  }

  if (assetId === "floor:rough") {
    const floorGroupId = rootId;
    const floorLinkId = createDocId();
    const floorVisualId = createDocId();
    const floorCollisionId = createDocId();
    const floorMeshId = createDocId();
    const floorTransform = defaultTransform({
      position: { x: 0, y: 0, z: -0.6 },
    });
    const createSeededRandom = (seed: number) => {
      let state = seed >>> 0;
      return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
      };
    };
    const random = createSeededRandom(20260317);
    const pushRoughCube = (
      nodes: CreateNodeInput[],
      name: string,
      x: number,
      y: number,
      height: number,
      sx: number,
      sy: number
    ) => {
      const sz = Math.max(0.02, height);
      nodes.push({
        id: createDocId(),
        name,
        kind: "mesh",
        parentId: floorVisualId,
        source: { kind: "primitive", shape: "cube" },
        components: {
          transform: defaultTransform({
            position: { x, y, z: sz * 0.5 },
            scale: { x: Math.max(0.08, sx), y: Math.max(0.08, sy), z: sz },
          }),
        },
      });
    };

    const nodes: CreateNodeInput[] = [
      createGeneratedSceneAssetRootNode(floorGroupId, "Rough Floor", "floor:rough", "terrain", {
        transform: floorTransform,
        metadata: {
          managedTerrainAssetId: "floor:rough",
        },
      }),
      {
        id: floorLinkId,
        name: "Link",
        kind: "link",
        parentId: floorGroupId,
        components: {
          transform: defaultTransform(),
          ...withPhysics({
            mass: 0,
            fixed: true,
            useDensity: false,
            friction: 1.0,
            restitution: 0.0,
            collisionsEnabled: true,
          }),
        },
      },
      createVisualNode(floorVisualId, floorLinkId),
      createCollisionNode(floorCollisionId, floorLinkId),
      {
        id: floorMeshId,
        name: "Rough Floor Base",
        kind: "mesh",
        parentId: floorVisualId,
        source: { kind: "primitive", shape: "plane" },
        components: { transform: defaultTransform() },
      },
    ];

    // zone_stairs_up: pyramid-like ascending steps.
    for (let level = 0; level < 6; level += 1) {
      const t = level / 5;
      const span = 1.6 - t * 1.1;
      const height = 0.045 + level * 0.018;
      pushRoughCube(nodes, `zone_stairs_up_${level + 1}`, -1.65, 1.65, height, span, span);
    }

    // zone_stairs_down: inverse pyramid-like descending profile.
    for (let level = 0; level < 6; level += 1) {
      const t = level / 5;
      const span = 0.5 + t * 1.1;
      const height = 0.045 + (5 - level) * 0.018;
      pushRoughCube(nodes, `zone_stairs_down_${level + 1}`, -1.65, -1.65, height, span, span);
    }

    // zone_irregular: low-amplitude gravel/hills patch on a fixed grid.
    const irregularRows = 8;
    const irregularCols = 8;
    const irregularStep = 0.24;
    for (let row = 0; row < irregularRows; row += 1) {
      for (let col = 0; col < irregularCols; col += 1) {
        const localX = (col - (irregularCols - 1) * 0.5) * irregularStep;
        const localY = (row - (irregularRows - 1) * 0.5) * irregularStep;
        const radial = Math.hypot(localX, localY);
        const wave = Math.sin(localX * 4.3) * Math.cos(localY * 5.1);
        const noise = (random() - 0.5) * 0.04;
        const height = Math.max(0.025, 0.07 + wave * 0.02 - radial * 0.015 + noise);
        pushRoughCube(
          nodes,
          `zone_irregular_${row + 1}_${col + 1}`,
          1.45 + localX,
          1.45 + localY,
          height,
          0.16,
          0.16
        );
      }
    }

    // zone_cube_field: scattered cubes at different heights.
    const cubeFieldCount = 40;
    for (let i = 0; i < cubeFieldCount; i += 1) {
      const x = 1.45 + (random() * 2 - 1) * 0.9;
      const y = -1.45 + (random() * 2 - 1) * 0.9;
      const height = 0.05 + random() * 0.26;
      const sx = 0.1 + random() * 0.16;
      const sy = 0.1 + random() * 0.16;
      pushRoughCube(nodes, `zone_cube_field_${i + 1}`, x, y, height, sx, sy);
    }

    return {
      rootId: floorGroupId,
      nodes,
    };
  }

  throw new Error(`Unknown asset id: ${assetId}`);
}
