import * as THREE from "three";
import {
  applyDefaultFloorAppearanceToMesh,
  applyRoughFloorAppearanceToMesh,
  createDefaultFloorMaterial,
  createRoughFloorMaterial,
} from "../../assets/floorAppearance";
import {
  normalizeBodyToken,
  normalizeAliasToken,
  normalizePathAliasToken,
  ISAAC_LAB_DEFAULT_SURFACE_FRICTION,
  ISAAC_LAB_DEFAULT_SURFACE_RESTITUTION,
} from "./types";
import type {
  NormalizedUsdMeshScene,
  NormalizedUsdMeshSceneBody,
  UsdLinkRenderGroupEntry,
} from "./types";
import {
  isLinkLikeNode,
  isVisualLikeNode,
  isCollisionLikeNode,
  configureVisualGroup,
  configureCollisionGroup,
  collectUsdLinkGroups,
} from "./hierarchy";

/* ------------------------------------------------------------------ */
/*  Scene-asset role inference                                        */
/* ------------------------------------------------------------------ */

export const inferSceneAssetSourceRole = (workspaceKey: string): "scene_asset" | "terrain" => {
  const normalized = String(workspaceKey ?? "").trim().replace(/\\/g, "/").toLowerCase();
  if (!normalized) return "scene_asset";
  if (normalized.includes("/terrain/")) return "terrain";
  if (/(^|\/)(floor|ground|terrain)[^/]*\.(usd|usda|usdc|usdz)$/i.test(normalized)) return "terrain";
  return "scene_asset";
};

/* ------------------------------------------------------------------ */
/*  Floor appearance helpers                                          */
/* ------------------------------------------------------------------ */

const isInsideCollisionBranch = (node: THREE.Object3D): boolean => {
  let current: THREE.Object3D | null = node;
  while (current) {
    const kind = String(current.userData?.editorKind ?? "")
      .trim()
      .toLowerCase();
    if (kind === "collision") return true;
    current = current.parent;
  }
  return false;
};

const applyManagedFloorAppearanceToSceneAsset = (
  root: THREE.Object3D,
  input: {
    materialName: string;
    materialSource: string;
    createMaterial: () => THREE.MeshPhysicalMaterial;
    applyToMesh: (mesh: THREE.Mesh, material: THREE.MeshPhysicalMaterial) => void;
  }
): number => {
  const sharedFloorMaterial = input.createMaterial();
  let styledMeshes = 0;

  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    if (isInsideCollisionBranch(node)) return;
    input.applyToMesh(node, sharedFloorMaterial);
    node.userData.usdMaterialInfo = {
      materialName: input.materialName,
      materialSource: input.materialSource,
      baseColorTexture: null,
      textureUrl: null,
      editable: false,
    };
    styledMeshes += 1;
  });

  return styledMeshes;
};

export const applyDefaultFloorAppearanceToSceneAsset = (root: THREE.Object3D): number =>
  applyManagedFloorAppearanceToSceneAsset(root, {
    materialName: "Default Floor",
    materialSource: "editor.default_floor",
    createMaterial: createDefaultFloorMaterial,
    applyToMesh: applyDefaultFloorAppearanceToMesh,
  });

export const applyRoughFloorAppearanceToSceneAsset = (root: THREE.Object3D): number =>
  applyManagedFloorAppearanceToSceneAsset(root, {
    materialName: "Rough Floor",
    materialSource: "editor.rough_floor",
    createMaterial: createRoughFloorMaterial,
    applyToMesh: applyRoughFloorAppearanceToMesh,
  });

/* ------------------------------------------------------------------ */
/*  Root retagging                                                    */
/* ------------------------------------------------------------------ */

export const retagUsdRootAsSceneAsset = (root: THREE.Object3D, sceneAssetName: string) => {
  const rootWithRobotFlag = root as THREE.Object3D & { isRobot?: boolean };
  if (rootWithRobotFlag.isRobot) {
    delete rootWithRobotFlag.isRobot;
  }
  root.name = sceneAssetName;
  if (root.userData && Object.prototype.hasOwnProperty.call(root.userData, "editorRobotRoot")) {
    delete root.userData.editorRobotRoot;
  }
  if (root.userData && Object.prototype.hasOwnProperty.call(root.userData, "robotModelSource")) {
    delete root.userData.robotModelSource;
  }
  root.userData.editorKind = "group";
  root.userData.usdSceneAsset = true;
};

/* ------------------------------------------------------------------ */
/*  Physics defaults                                                  */
/* ------------------------------------------------------------------ */

export const applySceneAssetPhysicsDefaults = (
  root: THREE.Object3D,
  options?: {
    forceRootCollider?: boolean;
    sourceRole?: "scene_asset" | "terrain";
    meshScene?: NormalizedUsdMeshScene | null;
  }
) => {
  const isTerrainAsset = options?.sourceRole === "terrain";
  const bodyByToken = new Map<string, NormalizedUsdMeshSceneBody>();
  for (const body of options?.meshScene?.bodies ?? []) {
    const token = normalizeBodyToken(body.name);
    if (!token || bodyByToken.has(token)) continue;
    bodyByToken.set(token, body);
  }

  const computeDynamicMassFallback = (node: THREE.Object3D) => {
    const bounds = new THREE.Box3().setFromObject(node);
    const size = new THREE.Vector3();
    bounds.getSize(size);
    const volume = Math.max(0.0005, Math.abs(size.x * size.y * size.z));
    return Math.min(20, Math.max(0.05, volume * 250));
  };

  let linkCount = 0;
  let meshUnderLinkCount = 0;
  let meshOutsideLinkCount = 0;
  const hasLinkAncestor = (node: THREE.Object3D) => {
    let current: THREE.Object3D | null = node.parent;
    while (current) {
      const isLink =
        current.userData?.editorKind === "link" ||
        Boolean((current as THREE.Object3D & { isURDFLink?: boolean }).isURDFLink);
      if (isLink) return true;
      if (current === root) break;
      current = current.parent;
    }
    return false;
  };
  root.traverse((node) => {
    const isLink = node.userData?.editorKind === "link" || Boolean((node as THREE.Object3D & { isURDFLink?: boolean }).isURDFLink);
    if (isLink) {
      linkCount += 1;
      const bodyToken = normalizeBodyToken(String(node.userData?.usdBodyToken ?? node.name));
      const bodyMeta = bodyToken ? bodyByToken.get(bodyToken) ?? null : null;
      const isDynamicBody =
        !isTerrainAsset &&
        Boolean(bodyMeta) &&
        bodyMeta?.rigidBodyEnabled !== false &&
        bodyMeta?.kinematicEnabled !== true;
      const resolvedMass = isDynamicBody
        ? (bodyMeta?.mass && bodyMeta.mass > 1e-6 ? bodyMeta.mass : computeDynamicMassFallback(node))
        : 0;
      const currentPhysics =
        node.userData?.physics && typeof node.userData.physics === "object" && !Array.isArray(node.userData.physics)
          ? (node.userData.physics as Record<string, unknown>)
          : {};
      node.userData.physics = {
        ...currentPhysics,
        mass: resolvedMass,
        fixed: !isDynamicBody,
        useDensity: false,
        collisionsEnabled: true,
        friction: ISAAC_LAB_DEFAULT_SURFACE_FRICTION,
        restitution: ISAAC_LAB_DEFAULT_SURFACE_RESTITUTION,
      };
    }

    const mesh = node as THREE.Mesh;
    if (mesh.isMesh) {
      if (hasLinkAncestor(node)) meshUnderLinkCount += 1;
      else meshOutsideLinkCount += 1;
    }
  });

  const shouldTagRoot =
    isTerrainAsset && (linkCount === 0 ||
    options?.forceRootCollider === true ||
    (meshOutsideLinkCount > 0 && meshUnderLinkCount === 0));

  // Some USD terrains attach meshes outside link wrappers (e.g. bodyCount=0 mesh payloads).
  // Tagging the root ensures MuJoCo sees the terrain mesh as a collision candidate.
  if (!shouldTagRoot) return;
  const rootPhysics =
    root.userData?.physics && typeof root.userData.physics === "object" && !Array.isArray(root.userData.physics)
      ? (root.userData.physics as Record<string, unknown>)
      : {};
  root.userData.physics = {
    ...rootPhysics,
    mass: 0,
    fixed: true,
    useDensity: false,
    collisionsEnabled: true,
    friction: ISAAC_LAB_DEFAULT_SURFACE_FRICTION,
    restitution: ISAAC_LAB_DEFAULT_SURFACE_RESTITUTION,
  };
};

/* ------------------------------------------------------------------ */
/*  Scene asset root hierarchy                                        */
/* ------------------------------------------------------------------ */

export const ensureSceneAssetRootHierarchy = (
  inputRoot: THREE.Object3D,
  options?: {
    sceneAssetName?: string;
    selfCollisionEnabled?: boolean;
    sourceRole?: "scene_asset" | "terrain";
  }
) => {
  const selfCollisionEnabled = options?.selfCollisionEnabled === true;
  const sceneAssetName = String(options?.sceneAssetName ?? "").trim() || inputRoot.name || "Scene Asset";
  const sourceRole = options?.sourceRole === "terrain" ? "terrain" : "scene_asset";
  let root = inputRoot;

  // Canonical asset structure in the editor should always start with a group root.
  if (isLinkLikeNode(root) || isVisualLikeNode(root) || isCollisionLikeNode(root) || root instanceof THREE.Mesh) {
    const wrapper = new THREE.Group();
    wrapper.name = sceneAssetName;
    wrapper.userData.editorKind = "group";
    wrapper.add(root);
    root = wrapper;
  }

  const directChildren = [...root.children];
  const strayDirectChildren = directChildren.filter((child) => {
    if (isLinkLikeNode(child)) return false;
    if (child.userData?.sceneAssetContainer === true) return false;
    if (child.userData?.usdOrphans === true) return false;
    if (child instanceof THREE.Mesh) return true;
    if (isVisualLikeNode(child) || isCollisionLikeNode(child)) return true;
    return false;
  });

  if (strayDirectChildren.length > 0) {
    const fallbackLink = new THREE.Group();
    fallbackLink.name = "Link";
    fallbackLink.userData.editorKind = "link";
    fallbackLink.userData.physics = {
      mass: 0,
      fixed: true,
      useDensity: false,
      collisionsEnabled: true,
      friction: ISAAC_LAB_DEFAULT_SURFACE_FRICTION,
      restitution: ISAAC_LAB_DEFAULT_SURFACE_RESTITUTION,
    };
    if (sourceRole === "terrain") {
      fallbackLink.userData.sceneAssetTerrainLink = true;
    }
    const fallbackVisual = new THREE.Group();
    configureVisualGroup(fallbackVisual, fallbackLink.name);
    const fallbackCollision = new THREE.Group();
    configureCollisionGroup(fallbackCollision, fallbackLink.name, selfCollisionEnabled);
    fallbackLink.add(fallbackVisual);
    fallbackLink.add(fallbackCollision);
    root.add(fallbackLink);

    for (const child of strayDirectChildren) {
      if (isCollisionLikeNode(child)) {
        fallbackCollision.add(child);
      } else {
        fallbackVisual.add(child);
      }
    }
  }

  return root;
};

/* ------------------------------------------------------------------ */
/*  Container grouping                                                */
/* ------------------------------------------------------------------ */

const toTitleFromToken = (token: string): string =>
  token
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());

const deriveSceneAssetContainerKey = (
  entry: UsdLinkRenderGroupEntry,
  rootPrimSegment: string | null
): { key: string; sourcePrimRoot: string | null } => {
  const primPathCandidates = Array.from(entry.sourcePrimPaths)
    .map((path) => normalizePathAliasToken(path))
    .filter((path): path is string => Boolean(path));
  for (const primPath of primPathCandidates) {
    const segments = primPath.split("/").filter(Boolean);
    if (!segments.length) continue;
    const trimmed =
      rootPrimSegment && segments[0] === rootPrimSegment
        ? segments.slice(1)
        : segments;
    if (!trimmed.length) continue;
    const key = trimmed[0];
    if (key) return { key, sourcePrimRoot: rootPrimSegment };
  }
  if (entry.bodyPath) {
    const key = entry.bodyPath.split("/").filter(Boolean).pop() ?? "";
    if (key) return { key, sourcePrimRoot: rootPrimSegment };
  }
  const fallback = normalizeBodyToken(entry.link.name) ?? normalizeAliasToken(entry.link.name) ?? "scene_asset";
  return { key: fallback, sourcePrimRoot: rootPrimSegment };
};

export const groupSceneAssetLinksUnderContainers = (
  root: THREE.Object3D
): { containerCount: number; groupedLinks: number } => {
  const lookup = collectUsdLinkGroups(root, false);
  const directEntries = lookup.entries.filter((entry) => entry.link.parent === root);
  if (directEntries.length < 2) return { containerCount: 0, groupedLinks: 0 };

  const allPrimPaths = directEntries.flatMap((entry) => Array.from(entry.sourcePrimPaths));
  const rootPrimSegment = (() => {
    const firstSegments = allPrimPaths
      .map((path) => normalizePathAliasToken(path))
      .filter((path): path is string => Boolean(path))
      .map((path) => path.split("/").filter(Boolean)[0])
      .filter((segment): segment is string => Boolean(segment));
    if (firstSegments.length < 2) return null;
    const first = firstSegments[0];
    return firstSegments.every((segment) => segment === first) ? first : null;
  })();

  const groups = new Map<string, UsdLinkRenderGroupEntry[]>();
  for (const entry of directEntries) {
    const { key } = deriveSceneAssetContainerKey(entry, rootPrimSegment);
    const normalizedKey = normalizeAliasToken(key) ?? "scene_asset";
    const bucket = groups.get(normalizedKey);
    if (!bucket) {
      groups.set(normalizedKey, [entry]);
    } else {
      bucket.push(entry);
    }
  }
  if (groups.size <= 1) return { containerCount: 0, groupedLinks: 0 };

  const containerByKey = new Map<string, THREE.Group>();
  for (const [groupKey, entries] of groups.entries()) {
    const container = new THREE.Group();
    container.name = toTitleFromToken(groupKey) || "Scene Asset";
    container.userData.editorKind = "group";
    container.userData.sceneAssetContainer = true;
    container.userData.sceneAssetContainerKey = groupKey;
    container.userData.sceneAssetContainerSource = "usd_prim_lineage";
    root.add(container);
    containerByKey.set(groupKey, container);

    for (const entry of entries) {
      if (entry.link.parent !== root) continue;
      const sourcePrimPaths = Array.from(entry.sourcePrimPaths);
      entry.link.userData.sceneAssetLineage = {
        groupKey,
        sourcePrimRoot: rootPrimSegment,
        sourcePrimPaths,
        bodyPath: entry.bodyPath,
      };
      container.add(entry.link);
    }
  }

  return {
    containerCount: containerByKey.size,
    groupedLinks: directEntries.length,
  };
};
