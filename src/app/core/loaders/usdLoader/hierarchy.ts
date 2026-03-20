import * as THREE from "three";
import { logInfo } from "../../services/logger";
import { disposeObject3D } from "../../viewer/objectRegistry";
import {
  normalizeBodyToken,
  normalizeAliasToken,
  normalizePathAliasToken,
  claimName,
  toPose,
  IDENTITY_QUAT,
  resolveMeshSceneBodyLocalPose,
  shouldTreatMeshScenePoseAsWorld,
} from "./types";
import type {
  UsdLinkRenderGroupEntry,
  UsdLinkLookup,
  NormalizedUsdMeshScene,
  NormalizedUsdMeshSceneBody,
  UsdMaterialChannelKey,
  UrdfJoint,
  UrdfLink,
} from "./types";
import { resolveUsdMaterialTextures } from "./materials";
import {
  createUsdVisualMesh,
  createUsdCollisionMeshFromVisual,
  createUsdVisualPrimitive,
} from "./meshScene";

/* ------------------------------------------------------------------ */
/*  Visual / collision group helpers                                   */
/* ------------------------------------------------------------------ */

export const configureVisualGroup = (group: THREE.Group, linkName: string) => {
  const visualFlags = group as THREE.Group & { isURDFVisual?: boolean; isURDFCollider?: boolean; urdfName?: string };
  group.name = "Visual";
  visualFlags.isURDFVisual = true;
  visualFlags.isURDFCollider = false;
  visualFlags.urdfName = `${linkName}__visual`;
  group.userData.editorKind = "visual";
  group.userData.urdfRole = "visual";
};

export const configureCollisionGroup = (group: THREE.Group, linkName: string, selfCollisionEnabled: boolean) => {
  const collisionFlags = group as THREE.Group & { isURDFVisual?: boolean; isURDFCollider?: boolean; urdfName?: string };
  group.name = "Collision";
  collisionFlags.isURDFVisual = false;
  collisionFlags.isURDFCollider = true;
  collisionFlags.urdfName = `${linkName}__collision`;
  group.userData.editorKind = "collision";
  group.userData.urdfRole = "collision";
  group.userData.selfCollisionEnabled = selfCollisionEnabled;
  group.visible = false;
};

export const isLinkLikeNode = (node: THREE.Object3D) =>
  node.userData?.editorKind === "link" || Boolean((node as THREE.Object3D & { isURDFLink?: boolean }).isURDFLink);

export const isVisualLikeNode = (node: THREE.Object3D) =>
  node.userData?.editorKind === "visual" || Boolean((node as THREE.Object3D & { isURDFVisual?: boolean }).isURDFVisual);

export const isCollisionLikeNode = (node: THREE.Object3D) =>
  node.userData?.editorKind === "collision" || Boolean((node as THREE.Object3D & { isURDFCollider?: boolean }).isURDFCollider);

const groupLooksVisual = (group: THREE.Group) => {
  const anyGroup = group as THREE.Group & { isURDFVisual?: boolean };
  return anyGroup.isURDFVisual === true || group.userData.editorKind === "visual" || group.name === "Visual" || group.name === "USDVisual";
};

const groupLooksCollision = (group: THREE.Group) => {
  const anyGroup = group as THREE.Group & { isURDFCollider?: boolean };
  return (
    anyGroup.isURDFCollider === true ||
    group.userData.editorKind === "collision" ||
    group.name === "Collision" ||
    group.name === "USDCollision"
  );
};

export const clearGroupChildren = (group: THREE.Group) => {
  const children = [...group.children];
  for (const child of children) {
    group.remove(child);
    disposeObject3D(child);
  }
};

export const ensureStandardLinkRenderGroups = (
  link: THREE.Group,
  selfCollisionEnabled: boolean
): { visual: THREE.Group; collision: THREE.Group } => {
  const directGroups = link.children.filter((child): child is THREE.Group => child instanceof THREE.Group);
  const visualCandidates = directGroups.filter(groupLooksVisual);
  const collisionCandidates = directGroups.filter(groupLooksCollision);

  const visual = visualCandidates[0] ?? new THREE.Group();
  if (!visual.parent) link.add(visual);
  configureVisualGroup(visual, link.name);

  const collisionSeed = collisionCandidates[0] ?? new THREE.Group();
  const collision = collisionSeed === visual ? new THREE.Group() : collisionSeed;
  if (!collision.parent) link.add(collision);
  configureCollisionGroup(collision, link.name, selfCollisionEnabled);

  for (const candidate of visualCandidates.slice(1)) {
    candidate.removeFromParent();
    disposeObject3D(candidate);
  }
  for (const candidate of collisionCandidates.slice(1)) {
    candidate.removeFromParent();
    disposeObject3D(candidate);
  }

  return { visual, collision };
};

/* ------------------------------------------------------------------ */
/*  USD link group collection                                          */
/* ------------------------------------------------------------------ */

export const collectUsdLinkGroups = (root: THREE.Object3D, selfCollisionEnabled: boolean): UsdLinkLookup => {
  const byAlias = new Map<string, UsdLinkRenderGroupEntry[]>();
  const entries: UsdLinkRenderGroupEntry[] = [];
  let aliasCollisionCount = 0;

  const bindAlias = (alias: string | null, entry: UsdLinkRenderGroupEntry) => {
    const normalized = normalizeAliasToken(alias);
    if (!normalized) return;
    const existing = byAlias.get(normalized);
    if (!existing) {
      byAlias.set(normalized, [entry]);
      return;
    }
    if (!existing.includes(entry)) {
      existing.push(entry);
      aliasCollisionCount += 1;
    }
  };

  root.traverse((node) => {
    if (!(node instanceof THREE.Group)) return;
    if (node.userData.editorKind !== "link") return;

    const ensured = ensureStandardLinkRenderGroups(node, selfCollisionEnabled);
    const bodyToken = normalizeBodyToken(String(node.userData?.usdBodyToken ?? node.name));
    const bodyPath = normalizePathAliasToken(String(node.userData?.usdBodyPath ?? node.userData?.usdPrimPath ?? ""));
    const sourcePrimPaths = Array.isArray(node.userData?.usdSourcePrimPaths)
      ? (node.userData.usdSourcePrimPaths as unknown[])
          .map((path) => normalizePathAliasToken(String(path ?? "")))
          .filter((path): path is string => Boolean(path))
      : [];
    const entry: UsdLinkRenderGroupEntry = {
      link: node,
      visual: ensured.visual,
      collision: ensured.collision,
      preparedForUsd: false,
      aliases: [],
      bodyToken,
      bodyPath,
      sourcePrimPaths: new Set<string>(sourcePrimPaths),
    };

    const register = (alias: string | null) => {
      const normalized = normalizeAliasToken(alias);
      if (!normalized) return;
      if (!entry.aliases.includes(normalized)) entry.aliases.push(normalized);
      bindAlias(normalized, entry);
    };

    register(node.name);
    register(normalizeBodyToken(node.name));
    register(bodyToken);
    register(bodyPath);
    register(`__link__${node.uuid}`);

    const urdfName = String((node as THREE.Group & { urdfName?: string }).urdfName ?? "").trim();
    if (urdfName) {
      register(urdfName);
      register(normalizeBodyToken(urdfName));
    }
    if (bodyPath) {
      const tail = bodyPath.split("/").pop() ?? "";
      register(tail);
      register(normalizeBodyToken(tail));
    }
    entries.push(entry);
  });

  return {
    byAlias,
    entries,
    aliasCollisionCount,
  };
};

/* ------------------------------------------------------------------ */
/*  Hierarchy augmentation from mesh-scene bodies                      */
/* ------------------------------------------------------------------ */

export const augmentRobotHierarchyFromMeshSceneBodies = (
  root: THREE.Object3D,
  meshScene: NormalizedUsdMeshScene | null,
  options?: {
    selfCollisionEnabled?: boolean;
    traceId?: string | null;
    detailedTrace?: boolean;
  }
) => {
  if (!meshScene || meshScene.bodies.length === 0) {
    return { createdLinks: 0, createdJoints: 0, unresolvedBodies: 0 };
  }

  const selfCollisionEnabled = options?.selfCollisionEnabled === true;
  const lookup = collectUsdLinkGroups(root, selfCollisionEnabled);
  const bodyByToken = new Map(
    meshScene.bodies
      .map((body) => {
        const token = normalizeBodyToken(body.name);
        return token ? ([token, body] as const) : null;
      })
      .filter((entry): entry is readonly [string, NormalizedUsdMeshSceneBody] => Boolean(entry))
  );

  const usedLinkNames = new Set<string>();
  const usedJointNames = new Set<string>();
  root.traverse((node) => {
    const name = String(node.name ?? "").trim();
    if (name) usedLinkNames.add(name);
    if (node.userData?.editorKind === "joint" && name) usedJointNames.add(name);
  });

  const tokenToEntry = new Map<string, UsdLinkRenderGroupEntry>();
  const registerEntry = (entry: UsdLinkRenderGroupEntry) => {
    const registerToken = (tokenValue: string | null | undefined) => {
      const token = normalizeBodyToken(tokenValue);
      if (!token || tokenToEntry.has(token)) return;
      tokenToEntry.set(token, entry);
    };
    registerToken(entry.bodyToken);
    registerToken(entry.link.name);
    const urdfName = String((entry.link as THREE.Group & { urdfName?: string }).urdfName ?? "").trim();
    if (urdfName) registerToken(urdfName);
  };

  for (const entry of lookup.entries) registerEntry(entry);

  let createdLinks = 0;
  let createdJoints = 0;
  const pendingBodies = new Map(
    Array.from(bodyByToken.entries()).filter(([token]) => !tokenToEntry.has(token))
  );
  const rootLevelEntries = lookup.entries.filter((entry) => entry.link.parent === root);
  const standaloneAnchorEntry = rootLevelEntries.length === 1 ? rootLevelEntries[0] : null;

  const synthesizeBodyLink = (input: {
    bodyToken: string;
    body: NormalizedUsdMeshSceneBody;
    parentEntry: UsdLinkRenderGroupEntry;
    expectedParentToken: string | null;
    fallbackToAnchor: boolean;
  }) => {
    const resolvedLocalPose = resolveMeshSceneBodyLocalPose({
      body: input.body,
      expectedParentToken: input.expectedParentToken,
      bodyByToken,
    });
    if (!resolvedLocalPose) return false;

    const joint = new THREE.Group();
    const jointFlags = joint as THREE.Group & { isURDFJoint?: boolean; urdfName?: string };
    const jointName = claimName(`${input.parentEntry.link.name}_${input.bodyToken}_fixed`, usedJointNames, "Joint");
    joint.name = jointName;
    jointFlags.isURDFJoint = true;
    jointFlags.urdfName = jointName;
    joint.userData.editorKind = "joint";
    joint.position.set(
      resolvedLocalPose.localPose.position[0],
      resolvedLocalPose.localPose.position[1],
      resolvedLocalPose.localPose.position[2]
    );
    joint.quaternion.copy(resolvedLocalPose.localPose.quaternion);

    const link = new THREE.Group();
    const linkFlags = link as THREE.Group & { isURDFLink?: boolean; urdfName?: string };
    const linkName = claimName(input.body.name || input.bodyToken, usedLinkNames, "Link");
    link.name = linkName;
    linkFlags.isURDFLink = true;
    linkFlags.urdfName = linkName;
    link.userData.editorKind = "link";
    link.userData.usdBodyToken = input.bodyToken;
    const bodyPath = normalizePathAliasToken(input.body.primPath);
    if (bodyPath) link.userData.usdBodyPath = bodyPath;
    link.position.set(0, 0, 0);
    link.quaternion.identity();
    link.scale.set(input.body.scale[0], input.body.scale[1], input.body.scale[2]);

    const visual = new THREE.Group();
    configureVisualGroup(visual, linkName);
    clearGroupChildren(visual);
    link.add(visual);

    const collision = new THREE.Group();
    configureCollisionGroup(collision, linkName, selfCollisionEnabled);
    clearGroupChildren(collision);
    link.add(collision);

    const urdfLink: UrdfLink = {
      name: linkName,
      visuals: [],
      collisions: [],
    };
    link.userData.urdf = { kind: "link", link: urdfLink };
    const urdfJoint: UrdfJoint = {
      name: jointName,
      type: "fixed",
      parent: input.parentEntry.link.name,
      child: linkName,
      origin: toPose(
        resolvedLocalPose.localPose.position,
        resolvedLocalPose.localPose.quaternion
      ),
      axis: [0, 0, 1],
    };
    joint.userData.urdf = { kind: "joint", joint: urdfJoint };

    input.parentEntry.link.add(joint);
    joint.add(link);

    const newEntry: UsdLinkRenderGroupEntry = {
      link,
      visual,
      collision,
      preparedForUsd: true,
      aliases: [],
      bodyToken: input.bodyToken,
      bodyPath,
      sourcePrimPaths: new Set<string>(),
    };
    registerEntry(newEntry);
    pendingBodies.delete(input.bodyToken);
    createdLinks += 1;
    createdJoints += 1;

    if (options?.detailedTrace) {
      logInfo("USD mesh-scene body link synthesized", {
        scope: "usd",
        data: {
          traceId: options.traceId ?? null,
          bodyToken: input.bodyToken,
          payloadParentToken: normalizeBodyToken(input.body.parentBody),
          expectedParentToken: input.expectedParentToken,
          fallbackToAnchor: input.fallbackToAnchor,
          parentLinkName: input.parentEntry.link.name,
          linkName,
          jointName,
          localPoseSource: resolvedLocalPose.source,
        },
      });
    }
    return true;
  };

  while (pendingBodies.size > 0) {
    let progressed = false;
    for (const [bodyToken, body] of Array.from(pendingBodies.entries())) {
      const parentToken = normalizeBodyToken(body.parentBody);
      if (!parentToken) continue;
      const parentEntry = tokenToEntry.get(parentToken);
      if (!parentEntry) continue;
      const synthesized = synthesizeBodyLink({
        bodyToken,
        body,
        parentEntry,
        expectedParentToken: parentToken,
        fallbackToAnchor: false,
      });
      if (synthesized) progressed = true;
    }
    if (!progressed) break;
  }

  if (standaloneAnchorEntry && pendingBodies.size > 0) {
    while (pendingBodies.size > 0) {
      let progressed = false;
      for (const [bodyToken, body] of Array.from(pendingBodies.entries())) {
        const parentToken = normalizeBodyToken(body.parentBody);
        let parentEntry = parentToken ? tokenToEntry.get(parentToken) ?? null : null;
        let expectedParentToken = parentToken;

        if (!parentEntry) {
          const parentIsKnownOnlyInMeshScene = Boolean(parentToken && bodyByToken.has(parentToken));
          if (parentIsKnownOnlyInMeshScene) continue;
          parentEntry = standaloneAnchorEntry;
          expectedParentToken =
            standaloneAnchorEntry.bodyToken ?? normalizeBodyToken(standaloneAnchorEntry.link.name);
        }

        const synthesized = synthesizeBodyLink({
          bodyToken,
          body,
          parentEntry,
          expectedParentToken,
          fallbackToAnchor: parentEntry === standaloneAnchorEntry && parentToken !== normalizeBodyToken(standaloneAnchorEntry.link.name),
        });
        if (synthesized) progressed = true;
      }
      if (!progressed) break;
    }
  }

  return {
    createdLinks,
    createdJoints,
    unresolvedBodies: pendingBodies.size,
  };
};

/* ------------------------------------------------------------------ */
/*  Collapsed joint detection and pose correction                      */
/* ------------------------------------------------------------------ */

const hasLikelyCollapsedJointLayout = (root: THREE.Object3D) => {
  let jointCount = 0;
  let jointsWithPose = 0;
  root.traverse((node) => {
    if (!(node instanceof THREE.Group)) return;
    if (node.userData.editorKind !== "joint") return;
    jointCount += 1;
    const hasPosition = node.position.lengthSq() > 1e-10;
    const hasRotation = node.quaternion.angleTo(IDENTITY_QUAT) > 1e-4;
    if (hasPosition || hasRotation) jointsWithPose += 1;
  });
  if (jointCount === 0) return false;
  return jointsWithPose / jointCount < 0.1;
};

export const applyUsdBodyPosesToCollapsedLinks = (root: THREE.Object3D, meshScene: NormalizedUsdMeshScene | null) => {
  if (!meshScene || meshScene.bodies.length === 0) return 0;
  const collected = collectUsdLinkGroups(root, false);
  const links = new Map<string, UsdLinkRenderGroupEntry>();
  const bindLink = (tokenValue: string | null | undefined, entry: UsdLinkRenderGroupEntry) => {
    const token = normalizeBodyToken(tokenValue);
    if (!token || links.has(token)) return;
    links.set(token, entry);
  };
  for (const entry of collected.entries) {
    bindLink(entry.link.name, entry);
    const urdfName = String((entry.link as THREE.Group & { urdfName?: string }).urdfName ?? "").trim();
    if (urdfName) bindLink(urdfName, entry);
    if (entry.bodyToken) bindLink(entry.bodyToken, entry);
  }
  const resolveLinkEntry = (bodyToken: string | null): UsdLinkRenderGroupEntry | null => {
    const normalized = normalizeBodyToken(bodyToken);
    if (!normalized) return null;
    return links.get(normalized) ?? null;
  };
  const bodyByName = new Map(meshScene.bodies.map((body) => [normalizeBodyToken(body.name) ?? body.name, body]));
  const introspectionJoints = Array.isArray(root.userData?.usdIntrospection?.joints)
    ? (root.userData.usdIntrospection.joints as Array<{ frame0Local?: unknown; frame1Local?: unknown }>)
    : [];
  const jointsWithExplicitFramePair = introspectionJoints.filter(
    (joint) => Boolean(joint?.frame0Local) && Boolean(joint?.frame1Local)
  ).length;
  const hasRichJointFrames =
    introspectionJoints.length > 0 &&
    jointsWithExplicitFramePair >= Math.max(2, Math.ceil(introspectionJoints.length * 0.4));

  const resolveSceneParentLinkToken = (link: THREE.Group): string | null => {
    let current: THREE.Object3D | null = link.parent;
    while (current) {
      if (current instanceof THREE.Group && current.userData.editorKind === "link") {
        return normalizeBodyToken(current.name);
      }
      current = current.parent;
    }
    return null;
  };

  const resolveTargetLocalPose = (
    body: NormalizedUsdMeshSceneBody,
    parentToken: string | null
  ): { position: [number, number, number]; quaternion: THREE.Quaternion } => {
    const resolved = resolveMeshSceneBodyLocalPose({
      body,
      expectedParentToken: parentToken,
      bodyByToken: bodyByName,
    });
    if (resolved) return resolved.localPose;
    return { position: body.position, quaternion: body.quaternion };
  };

  const hasCollapsedLayout = hasLikelyCollapsedJointLayout(root);
  let comparableJoints = 0;
  let currentToLocalError = 0;
  let currentToGlobalError = 0;

  for (const body of meshScene.bodies) {
    const bodyToken = normalizeBodyToken(body.name);
    if (!bodyToken) continue;
    const linkEntry = resolveLinkEntry(bodyToken);
    if (!linkEntry) continue;
    const link = linkEntry.link;
    if (!(link.parent instanceof THREE.Group) || link.parent.userData.editorKind !== "joint") continue;
    const joint = link.parent;

    const sceneParentToken = resolveSceneParentLinkToken(link);
    const payloadParentToken = normalizeBodyToken(body.parentBody);
    const parentToken = payloadParentToken ?? sceneParentToken;
    const targetLocal = resolveTargetLocalPose(body, parentToken);

    const currentPos = joint.position;
    const localPos = new THREE.Vector3(targetLocal.position[0], targetLocal.position[1], targetLocal.position[2]);
    const globalPos = new THREE.Vector3(body.position[0], body.position[1], body.position[2]);

    currentToLocalError += currentPos.distanceTo(localPos) + joint.quaternion.angleTo(targetLocal.quaternion) * 0.25;
    currentToGlobalError += currentPos.distanceTo(globalPos) + joint.quaternion.angleTo(body.quaternion) * 0.25;
    comparableJoints += 1;
  }

  const looksGlobalInLocalSlots =
    comparableJoints >= 3 &&
    currentToLocalError > comparableJoints * 0.05 &&
    currentToGlobalError + 1e-6 < currentToLocalError * 0.9;
  // When explicit joint frame pairs exist on an already posed chain, re-applying
  // mesh body poses can double-transform downstream links.
  // Keep pose recovery enabled for genuinely collapsed skeletons.
  if (hasRichJointFrames && !hasCollapsedLayout) return 0;
  if (!hasCollapsedLayout && !looksGlobalInLocalSlots) return 0;

  let applied = 0;

  for (const body of meshScene.bodies) {
    const bodyToken = normalizeBodyToken(body.name);
    if (!bodyToken) continue;
    const linkEntry = resolveLinkEntry(bodyToken);
    if (!linkEntry) continue;
    const link = linkEntry.link;

    const sceneParentToken = resolveSceneParentLinkToken(link);
    const payloadParentToken = normalizeBodyToken(body.parentBody);
    const parentToken = payloadParentToken ?? sceneParentToken;
    const hasKnownParent = Boolean(parentToken && links.has(parentToken));

    const targetLocal = resolveTargetLocalPose(body, parentToken);
    const localPosition = targetLocal.position;
    const localQuaternion = targetLocal.quaternion;

    if (hasKnownParent && link.parent instanceof THREE.Group && link.parent.userData.editorKind === "joint") {
      const joint = link.parent;
      joint.position.set(localPosition[0], localPosition[1], localPosition[2]);
      joint.quaternion.copy(localQuaternion);
      link.position.set(0, 0, 0);
      link.quaternion.identity();
    } else {
      link.position.set(localPosition[0], localPosition[1], localPosition[2]);
      link.quaternion.copy(localQuaternion);
    }
    link.scale.set(body.scale[0], body.scale[1], body.scale[2]);
    applied += 1;
  }

  return applied;
};

/* ------------------------------------------------------------------ */
/*  Mesh scene attachment                                              */
/* ------------------------------------------------------------------ */

export const attachUsdMeshSceneToRoot = (
  root: THREE.Object3D,
  meshScene: NormalizedUsdMeshScene | null,
  options?: {
    selfCollisionEnabled?: boolean;
    resolveResource?: (resourcePath: string) => string | null;
    attachCollisionProxies?: boolean;
    replaceExisting?: boolean;
    traceId?: string;
    detailedTrace?: boolean;
  }
) => {
  if (!meshScene || (meshScene.meshes.length === 0 && meshScene.primitives.length === 0)) {
    return {
      attachedMeshes: 0,
      attachedPrimitives: 0,
      attachedToLinks: 0,
      attachedToRoot: 0,
      materialsBound: 0,
      texturedMaterials: 0,
      referencedTextures: 0,
      unresolvedTextureBindings: 0,
      unresolvedTextureBindingsByChannel: {
        baseColor: 0,
        normal: 0,
        metallic: 0,
        roughness: 0,
        metallicRoughness: 0,
        occlusion: 0,
        emissive: 0,
        opacity: 0,
      },
      aliasCollisionCount: 0,
      parentPoseWorldFallbacks: 0,
      bodyFrameCorrections: 0,
      materialTraceEntries: [] as Array<Record<string, unknown>>,
    };
  }

  const selfCollisionEnabled = options?.selfCollisionEnabled === true;
  const attachCollisionProxies = options?.attachCollisionProxies !== false;
  const replaceExisting = options?.replaceExisting === true;
  const links = collectUsdLinkGroups(root, selfCollisionEnabled);
  const uniqueEntries = Array.from(new Set(links.entries));
  const singleLinkEntry = uniqueEntries.length === 1 ? uniqueEntries[0] : null;
  const prefersRobotTokenMatching = Boolean(
    (root as THREE.Object3D & { isRobot?: boolean }).isRobot || root.userData?.editorRobotRoot === true
  );
  const robotTokenLookup = new Map<string, UsdLinkRenderGroupEntry>();
  const bindRobotToken = (tokenValue: string | null | undefined, entry: UsdLinkRenderGroupEntry) => {
    const token = normalizeBodyToken(tokenValue);
    if (!token || robotTokenLookup.has(token)) return;
    robotTokenLookup.set(token, entry);
  };
  if (prefersRobotTokenMatching) {
    for (const entry of uniqueEntries) {
      bindRobotToken(entry.link.name, entry);
      const urdfName = String((entry.link as THREE.Group & { urdfName?: string }).urdfName ?? "").trim();
      if (urdfName) bindRobotToken(urdfName, entry);
      if (entry.bodyToken) bindRobotToken(entry.bodyToken, entry);
    }
  }
  const bodyPoseByToken = new Map(
    meshScene.bodies
      .map((body) => {
        const token = normalizeBodyToken(body.name);
        return token ? ([token, body] as const) : null;
      })
      .filter((entry): entry is readonly [string, NormalizedUsdMeshSceneBody] => Boolean(entry))
  );
  const usedNodeNames = new Set<string>();
  root.traverse((node) => {
    const name = String(node.name ?? "").trim();
    if (name) usedNodeNames.add(name);
  });

  const rootOrphansByKey = new Map<string, { container: THREE.Group; visual: THREE.Group; collision: THREE.Group }>();
  let attachedMeshes = 0;
  let attachedPrimitives = 0;
  let attachedToLinks = 0;
  let attachedToRoot = 0;
  let materialsBound = 0;
  let texturedMaterials = 0;
  let referencedTextures = 0;
  let unresolvedTextureBindings = 0;
  const unresolvedTextureBindingsByChannel: Record<UsdMaterialChannelKey, number> = {
    baseColor: 0,
    normal: 0,
    metallic: 0,
    roughness: 0,
    metallicRoughness: 0,
    occlusion: 0,
    emissive: 0,
    opacity: 0,
  };
  let parentPoseWorldFallbacks = 0;
  let bodyFrameCorrections = 0;
  const materialTraceEntries: Array<Record<string, unknown>> = [];
  const targetsWithMeshVisual = new Set<string>();
  const seenUsdItems = new Set<string>();
  const targetPrimaryMeshCount = new Map<string, number>();

  if (replaceExisting) {
    for (const entry of uniqueEntries) {
      clearGroupChildren(entry.visual);
      configureVisualGroup(entry.visual, entry.link.name);
      if (attachCollisionProxies) {
        clearGroupChildren(entry.collision);
        configureCollisionGroup(entry.collision, entry.link.name, selfCollisionEnabled);
      }
      entry.preparedForUsd = true;
    }
  }

  const isAuxiliaryVisualCandidate = (value: { name: string; primPath: string }) => {
    const token = `${value.name} ${value.primPath}`.toLowerCase();
    const hasCollisionToken =
      /(^|[\/_.:-])(collision|collider|proxy|physics|physx|contact|approx)($|[\/_.:-])/.test(token);
    return hasCollisionToken;
  };

  const toOrphanContainerName = (key: string) =>
    key
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\w/g, (char) => char.toUpperCase()) || "Scene Asset";

  const deriveOrphanContainerKey = (sourcePrimPath: string): string => {
    if (prefersRobotTokenMatching) return "__USDOrphans__";
    const normalized = normalizePathAliasToken(sourcePrimPath);
    if (!normalized) return "scene_asset_orphans";
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length >= 2) {
      return normalizeAliasToken(parts[1]) ?? parts[1].toLowerCase();
    }
    if (parts.length === 1) {
      return normalizeAliasToken(parts[0]) ?? parts[0].toLowerCase();
    }
    return "scene_asset_orphans";
  };

  const ensureRootOrphans = (sourcePrimPath: string) => {
    const orphanKey = deriveOrphanContainerKey(sourcePrimPath);
    const existing = rootOrphansByKey.get(orphanKey);
    if (existing) return existing;
    const container = new THREE.Group();
    container.name = orphanKey === "__USDOrphans__" ? "__USDOrphans__" : toOrphanContainerName(orphanKey);
    container.userData.usdOrphans = true;
    container.userData.usdOrphanGroupKey = orphanKey;
    if (!prefersRobotTokenMatching) {
      container.userData.sceneAssetContainer = true;
      container.userData.sceneAssetContainerKey = orphanKey;
      container.userData.sceneAssetContainerSource = "usd_orphan_lineage";
    }

    const visual = new THREE.Group();
    configureVisualGroup(visual, "__usd_orphans__");
    clearGroupChildren(visual);
    container.add(visual);

    const collision = new THREE.Group();
    configureCollisionGroup(collision, "__usd_orphans__", selfCollisionEnabled);
    clearGroupChildren(collision);
    container.add(collision);

    root.add(container);
    const next = { container, visual, collision };
    rootOrphansByKey.set(orphanKey, next);
    return next;
  };

  const pickEntryFromCandidates = (
    candidates: UsdLinkRenderGroupEntry[],
    pathHints: Array<string | null | undefined>
  ): UsdLinkRenderGroupEntry | null => {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    const normalizedHints = pathHints
      .map((hint) => normalizePathAliasToken(hint))
      .filter((hint): hint is string => Boolean(hint));
    for (const hint of normalizedHints) {
      const byBodyPath = candidates.find((candidate) =>
        Boolean(candidate.bodyPath && (hint.endsWith(candidate.bodyPath) || candidate.bodyPath.endsWith(hint)))
      );
      if (byBodyPath) return byBodyPath;
    }
    for (const hint of normalizedHints) {
      const segments = hint.split("/").filter(Boolean);
      for (let i = segments.length - 1; i >= 0; i -= 1) {
        const alias = normalizeAliasToken(segments[i]);
        if (!alias) continue;
        const byAlias = candidates.find((candidate) => candidate.aliases.includes(alias));
        if (byAlias) return byAlias;
      }
    }
    return candidates[0];
  };

  const inferEntryFromPrimPath = (primPath: string): UsdLinkRenderGroupEntry | null => {
    const tokenized = String(primPath ?? "")
      .split("/")
      .map((item) => normalizeBodyToken(item))
      .filter((item): item is string => Boolean(item));
    for (let i = tokenized.length - 1; i >= 0; i -= 1) {
      const token = tokenized[i];
      const candidates = links.byAlias.get(token) ?? [];
      const picked = pickEntryFromCandidates(candidates, [primPath]);
      if (picked) return picked;
    }
    return singleLinkEntry;
  };

  const findEntryByBodyPathPrefix = (
    candidatePath: string | null | undefined
  ): UsdLinkRenderGroupEntry | null => {
    const normalizedPath = normalizePathAliasToken(candidatePath);
    if (!normalizedPath) return null;
    let best: UsdLinkRenderGroupEntry | null = null;
    let bestLength = -1;
    for (const entry of uniqueEntries) {
      const bodyPath = normalizePathAliasToken(entry.bodyPath);
      if (!bodyPath) continue;
      if (!normalizedPath.startsWith(bodyPath)) continue;
      if (bodyPath.length <= bestLength) continue;
      best = entry;
      bestLength = bodyPath.length;
    }
    return best;
  };

  const resolveTargetEntry = (input: {
    parentBody: string | null;
    parentBodyPath: string | null;
    primPath: string;
  }): UsdLinkRenderGroupEntry | null => {
    if (prefersRobotTokenMatching) {
      const parentToken = normalizeBodyToken(input.parentBody);
      if (parentToken) {
        const byParentToken = robotTokenLookup.get(parentToken);
        if (byParentToken) return byParentToken;
      }
      const tokenized = String(input.primPath ?? "")
        .split("/")
        .map((item) => normalizeBodyToken(item))
        .filter((item): item is string => Boolean(item));
      for (let i = tokenized.length - 1; i >= 0; i -= 1) {
        const token = tokenized[i];
        const byPrimToken = robotTokenLookup.get(token);
        if (byPrimToken) return byPrimToken;
      }
      return singleLinkEntry;
    }

    const parentToken = normalizeBodyToken(input.parentBody);
    if (parentToken) {
      const candidates = links.byAlias.get(parentToken) ?? [];
      const picked = pickEntryFromCandidates(candidates, [input.parentBodyPath, input.primPath]);
      if (picked) return picked;
    }
    const byParentBodyPath = findEntryByBodyPathPrefix(input.parentBodyPath);
    if (byParentBodyPath) return byParentBodyPath;
    const byPrimPath = findEntryByBodyPathPrefix(input.primPath);
    if (byPrimPath) return byPrimPath;
    return inferEntryFromPrimPath(input.primPath);
  };

  const rebaseWorldPoseToTargetLocal = (
    pose: {
      position: [number, number, number];
      quaternion: THREE.Quaternion;
      scale: [number, number, number];
      parentBody: string | null;
      parentBodyPath?: string | null;
    },
    targetEntry: UsdLinkRenderGroupEntry | null
  ): {
    position: [number, number, number];
    quaternion: THREE.Quaternion;
    scale: [number, number, number];
    source: "payload_local" | "world_rebased";
  } => {
    const payloadParentToken = normalizeBodyToken(pose.parentBody);
    const expectedParentToken = targetEntry?.bodyToken ?? null;
    if (!targetEntry || (prefersRobotTokenMatching && payloadParentToken)) {
      return {
        position: [pose.position[0], pose.position[1], pose.position[2]],
        quaternion: pose.quaternion.clone(),
        scale: [pose.scale[0], pose.scale[1], pose.scale[2]],
        source: "payload_local",
      };
    }

    const shouldTreatAsWorldPose = shouldTreatMeshScenePoseAsWorld({
      payloadParentToken,
      expectedParentToken,
      position: pose.position,
      quaternion: pose.quaternion,
      bodyPoseByToken,
    });

    if (!shouldTreatAsWorldPose) {
      return {
        position: [pose.position[0], pose.position[1], pose.position[2]],
        quaternion: pose.quaternion.clone(),
        scale: [pose.scale[0], pose.scale[1], pose.scale[2]],
        source: "payload_local",
      };
    }
    if (payloadParentToken) {
      parentPoseWorldFallbacks += 1;
    }

    const parentObject = targetEntry.visual;
    parentObject.updateWorldMatrix(true, false);
    const parentInv = new THREE.Matrix4().copy(parentObject.matrixWorld).invert();
    const worldMatrix = new THREE.Matrix4().compose(
      new THREE.Vector3(pose.position[0], pose.position[1], pose.position[2]),
      pose.quaternion.clone(),
      new THREE.Vector3(pose.scale[0], pose.scale[1], pose.scale[2])
    );
    const localMatrix = new THREE.Matrix4().multiplyMatrices(parentInv, worldMatrix);
    const localPos = new THREE.Vector3();
    const localQuat = new THREE.Quaternion();
    const localScale = new THREE.Vector3();
    localMatrix.decompose(localPos, localQuat, localScale);
    if (localQuat.lengthSq() <= 1e-10) {
      localQuat.identity();
    } else {
      localQuat.normalize();
    }
    return {
      position: [localPos.x, localPos.y, localPos.z],
      quaternion: localQuat,
      scale: [localScale.x, localScale.y, localScale.z],
      source: "world_rebased",
    };
  };

  const applyBodyFrameCorrectionToLocalPose = (input: {
    localPose: {
      position: [number, number, number];
      quaternion: THREE.Quaternion;
      scale: [number, number, number];
      source: "payload_local" | "world_rebased";
    };
    parentBodyToken: string | null;
    targetEntry: UsdLinkRenderGroupEntry | null;
    primPath: string;
    nodeName: string;
    kind: "mesh" | "primitive";
  }) => {
    if (!input.targetEntry) return input.localPose;
    if (input.localPose.source !== "payload_local") return input.localPose;
    const parentBodyToken = normalizeBodyToken(input.parentBodyToken);
    if (!parentBodyToken) return input.localPose;
    const parentBodyPose = bodyPoseByToken.get(parentBodyToken);
    if (!parentBodyPose) return input.localPose;
    if (normalizeBodyToken(parentBodyPose.parentBody)) return input.localPose;

    input.targetEntry.link.updateWorldMatrix(true, false);
    const linkWorld = input.targetEntry.link.matrixWorld;
    const linkWorldInv = new THREE.Matrix4().copy(linkWorld).invert();
    const bodyWorld = new THREE.Matrix4().compose(
      new THREE.Vector3(parentBodyPose.position[0], parentBodyPose.position[1], parentBodyPose.position[2]),
      parentBodyPose.quaternion.clone(),
      new THREE.Vector3(parentBodyPose.scale[0], parentBodyPose.scale[1], parentBodyPose.scale[2])
    );
    const correction = new THREE.Matrix4().multiplyMatrices(linkWorldInv, bodyWorld);
    const correctionPos = new THREE.Vector3();
    const correctionQuat = new THREE.Quaternion();
    const correctionScale = new THREE.Vector3();
    correction.decompose(correctionPos, correctionQuat, correctionScale);
    if (correctionQuat.lengthSq() <= 1e-10) correctionQuat.identity();
    else correctionQuat.normalize();
    const correctionPositionMagnitude = correctionPos.length();
    const correctionRotationError = correctionQuat.angleTo(IDENTITY_QUAT);
    const correctionScaleError = Math.max(
      Math.abs(correctionScale.x - 1),
      Math.abs(correctionScale.y - 1),
      Math.abs(correctionScale.z - 1)
    );
    const needsCorrection =
      correctionPositionMagnitude > 1e-4 ||
      correctionRotationError > 1e-3 ||
      correctionScaleError > 1e-4;
    if (!needsCorrection) return input.localPose;

    const localMatrix = new THREE.Matrix4().compose(
      new THREE.Vector3(
        input.localPose.position[0],
        input.localPose.position[1],
        input.localPose.position[2]
      ),
      input.localPose.quaternion.clone(),
      new THREE.Vector3(input.localPose.scale[0], input.localPose.scale[1], input.localPose.scale[2])
    );
    const correctedLocal = new THREE.Matrix4().multiplyMatrices(correction, localMatrix);
    const correctedPos = new THREE.Vector3();
    const correctedQuat = new THREE.Quaternion();
    const correctedScale = new THREE.Vector3();
    correctedLocal.decompose(correctedPos, correctedQuat, correctedScale);
    if (correctedQuat.lengthSq() <= 1e-10) correctedQuat.identity();
    else correctedQuat.normalize();

    bodyFrameCorrections += 1;
    if (options?.detailedTrace) {
      logInfo("USD mesh local pose corrected from body frame to link frame", {
        scope: "usd",
        data: {
          traceId: options.traceId ?? null,
          kind: input.kind,
          nodeName: input.nodeName,
          primPath: input.primPath,
          parentBodyToken,
          targetLinkName: input.targetEntry.link.name,
          correctionPositionMagnitude,
          correctionRotationErrorRad: correctionRotationError,
          correctionScaleError,
        },
      });
    }

    return {
      position: [correctedPos.x, correctedPos.y, correctedPos.z] as [number, number, number],
      quaternion: correctedQuat,
      scale: [correctedScale.x, correctedScale.y, correctedScale.z] as [number, number, number],
      source: "world_rebased" as const,
    };
  };

  for (const mesh of meshScene.meshes) {
    const targetEntry = resolveTargetEntry({
      parentBody: mesh.parentBody,
      parentBodyPath: mesh.parentBodyPath,
      primPath: mesh.primPath,
    });
    const targetKey = targetEntry ? `link:${targetEntry.link.uuid}` : "__root__";
    if (isAuxiliaryVisualCandidate({ name: mesh.name, primPath: mesh.primPath })) continue;
    targetPrimaryMeshCount.set(targetKey, (targetPrimaryMeshCount.get(targetKey) ?? 0) + 1);
  }

  const ensurePreparedEntry = (entry: UsdLinkRenderGroupEntry) => {
    if (entry.preparedForUsd) return;
    clearGroupChildren(entry.visual);
    configureVisualGroup(entry.visual, entry.link.name);
    if (attachCollisionProxies) {
      clearGroupChildren(entry.collision);
      configureCollisionGroup(entry.collision, entry.link.name, selfCollisionEnabled);
    }
    entry.preparedForUsd = true;
  };

  const attachPair = (
    visual: THREE.Mesh,
    collision: THREE.Mesh | null,
    targetEntry: UsdLinkRenderGroupEntry | null,
    sourcePrimPath: string
  ) => {
    const visualName = claimName(visual.name || "usd_mesh", usedNodeNames, "usd_mesh");
    visual.name = visualName;
    if (collision) {
      collision.name = claimName(`${visualName}_collision`, usedNodeNames, "usd_collision");
      collision.userData.selfCollisionEnabled = selfCollisionEnabled;
    }

    if (targetEntry) {
      ensurePreparedEntry(targetEntry);
      targetEntry.visual.add(visual);
      if (collision && attachCollisionProxies) targetEntry.collision.add(collision);
      const normalizedPrimPath = normalizePathAliasToken(sourcePrimPath);
      if (normalizedPrimPath) {
        targetEntry.sourcePrimPaths.add(normalizedPrimPath);
        targetEntry.link.userData.usdSourcePrimPaths = Array.from(targetEntry.sourcePrimPaths);
      }
      attachedToLinks += 1;
      return;
    }

    const orphans = ensureRootOrphans(sourcePrimPath);
    orphans.visual.add(visual);
    if (collision && attachCollisionProxies) orphans.collision.add(collision);
    attachedToRoot += 1;
  };

  const numericSignature = (values: number[]) => values.map((value) => value.toFixed(6)).join(",");
  const meshTransformKey = (obj: {
    position: [number, number, number];
    quaternion: THREE.Quaternion;
    scale: [number, number, number];
  }) =>
    `${numericSignature(obj.position)}|${numericSignature([
      obj.quaternion.w,
      obj.quaternion.x,
      obj.quaternion.y,
      obj.quaternion.z,
    ])}|${numericSignature(obj.scale)}`;

  const accountTextureBinding = (channel: UsdMaterialChannelKey, reference: string | null, resolvedUrl: string | null) => {
    if (!reference) return;
    referencedTextures += 1;
    if (!resolvedUrl) {
      unresolvedTextureBindings += 1;
      unresolvedTextureBindingsByChannel[channel] += 1;
    }
  };

  for (const mesh of meshScene.meshes) {
    const targetEntry = resolveTargetEntry({
      parentBody: mesh.parentBody,
      parentBodyPath: mesh.parentBodyPath,
      primPath: mesh.primPath,
    });
    const targetKey = targetEntry ? `link:${targetEntry.link.uuid}` : "__root__";
    const auxiliary = isAuxiliaryVisualCandidate({ name: mesh.name, primPath: mesh.primPath });
    if (auxiliary && (targetPrimaryMeshCount.get(targetKey) ?? 0) > 0) continue;

    const meshNameKey = String(mesh.name || mesh.primPath || "").trim().toLowerCase();
    const dedupeKey = `mesh|${targetKey}|${meshNameKey}|${meshTransformKey(mesh)}|${mesh.points.length}|${mesh.triangles.length}`;
    if (seenUsdItems.has(dedupeKey)) continue;
    seenUsdItems.add(dedupeKey);

    const materialTextures = resolveUsdMaterialTextures(
      {
        baseColorTexture: mesh.baseColorTexture,
        normalTexture: mesh.normalTexture,
        metallicTexture: mesh.metallicTexture,
        roughnessTexture: mesh.roughnessTexture,
        metallicRoughnessTexture: mesh.metallicRoughnessTexture,
        occlusionTexture: mesh.occlusionTexture,
        emissiveTexture: mesh.emissiveTexture,
        opacityTexture: mesh.opacityTexture,
      },
      options?.resolveResource
    );
    const textureReferencesByChannel: Record<UsdMaterialChannelKey, string | null> = {
      baseColor: mesh.baseColorTexture,
      normal: mesh.normalTexture,
      metallic: mesh.metallicTexture,
      roughness: mesh.roughnessTexture,
      metallicRoughness: mesh.metallicRoughnessTexture,
      occlusion: mesh.occlusionTexture,
      emissive: mesh.emissiveTexture,
      opacity: mesh.opacityTexture,
    };
    const resolvedTextureByChannel: Record<UsdMaterialChannelKey, string | null> = {
      baseColor: materialTextures.baseColorUrl,
      normal: materialTextures.normalUrl,
      metallic: materialTextures.metallicUrl,
      roughness: materialTextures.roughnessUrl,
      metallicRoughness: materialTextures.metallicRoughnessUrl,
      occlusion: materialTextures.occlusionUrl,
      emissive: materialTextures.emissiveUrl,
      opacity: materialTextures.opacityUrl,
    };
    const textureReferences = Object.values(textureReferencesByChannel).filter((value): value is string => Boolean(value));
    const resolvedTextureCount = Object.values(resolvedTextureByChannel).filter((value) => Boolean(value)).length;
    const hasMaterialBinding = Boolean(
      mesh.materialName ||
        mesh.materialSource ||
        textureReferences.length > 0 ||
        resolvedTextureCount > 0 ||
        mesh.metallicFactor !== null ||
        mesh.roughnessFactor !== null ||
        mesh.emissiveFactor !== null ||
        mesh.opacityFactor !== null
    );
    if (hasMaterialBinding) materialsBound += 1;
    (Object.keys(textureReferencesByChannel) as UsdMaterialChannelKey[]).forEach((channel) => {
      accountTextureBinding(channel, textureReferencesByChannel[channel], resolvedTextureByChannel[channel]);
    });
    if (resolvedTextureCount > 0) texturedMaterials += 1;
    if (options?.detailedTrace) {
      materialTraceEntries.push({
        traceId: options.traceId ?? null,
        primPath: mesh.primPath,
        nodeName: mesh.name,
        kind: "mesh",
        materialName: mesh.materialName,
        channelSources: mesh.materialChannelSources,
        referencedByChannel: textureReferencesByChannel,
        resolvedByChannel: resolvedTextureByChannel,
      });
    }
    const rebasedLocalPose = rebaseWorldPoseToTargetLocal(
      {
        position: mesh.position,
        quaternion: mesh.quaternion,
        scale: mesh.scale,
        parentBody: mesh.parentBody,
        parentBodyPath: mesh.parentBodyPath,
      },
      targetEntry
    );
    const localPose = applyBodyFrameCorrectionToLocalPose({
      localPose: rebasedLocalPose,
      parentBodyToken: mesh.parentBody,
      targetEntry,
      primPath: mesh.primPath,
      nodeName: mesh.name,
      kind: "mesh",
    });
    const visual = createUsdVisualMesh(
      {
        ...mesh,
        position: localPose.position,
        quaternion: localPose.quaternion,
        scale: localPose.scale,
      },
      { materialTextures }
    );
    const collision = attachCollisionProxies ? createUsdCollisionMeshFromVisual(visual) : null;
    attachPair(visual, collision, targetEntry, mesh.primPath);
    targetsWithMeshVisual.add(targetKey);
    attachedMeshes += 1;
  }
  for (const primitive of meshScene.primitives) {
    const targetEntry = resolveTargetEntry({
      parentBody: primitive.parentBody,
      parentBodyPath: primitive.parentBodyPath,
      primPath: primitive.primPath,
    });
    const targetKey = targetEntry ? `link:${targetEntry.link.uuid}` : "__root__";
    if ((targetPrimaryMeshCount.get(targetKey) ?? 0) > 0 && targetsWithMeshVisual.has(targetKey)) continue;
    if (isAuxiliaryVisualCandidate({ name: primitive.name, primPath: primitive.primPath })) continue;

    const primitiveDims = primitive.size
      ? primitive.size.map((value) => value.toFixed(6)).join(",")
      : `${primitive.radius?.toFixed(6) ?? "na"}:${primitive.height?.toFixed(6) ?? "na"}`;
    const primitiveNameKey = String(primitive.name || primitive.primPath || "").trim().toLowerCase();
    const dedupeKey = `primitive|${targetKey}|${primitiveNameKey}|${primitive.kind}|${meshTransformKey(primitive)}|${primitiveDims}`;
    if (seenUsdItems.has(dedupeKey)) continue;
    seenUsdItems.add(dedupeKey);

    const materialTextures = resolveUsdMaterialTextures(
      {
        baseColorTexture: primitive.baseColorTexture,
        normalTexture: primitive.normalTexture,
        metallicTexture: primitive.metallicTexture,
        roughnessTexture: primitive.roughnessTexture,
        metallicRoughnessTexture: primitive.metallicRoughnessTexture,
        occlusionTexture: primitive.occlusionTexture,
        emissiveTexture: primitive.emissiveTexture,
        opacityTexture: primitive.opacityTexture,
      },
      options?.resolveResource
    );
    const textureReferencesByChannel: Record<UsdMaterialChannelKey, string | null> = {
      baseColor: primitive.baseColorTexture,
      normal: primitive.normalTexture,
      metallic: primitive.metallicTexture,
      roughness: primitive.roughnessTexture,
      metallicRoughness: primitive.metallicRoughnessTexture,
      occlusion: primitive.occlusionTexture,
      emissive: primitive.emissiveTexture,
      opacity: primitive.opacityTexture,
    };
    const resolvedTextureByChannel: Record<UsdMaterialChannelKey, string | null> = {
      baseColor: materialTextures.baseColorUrl,
      normal: materialTextures.normalUrl,
      metallic: materialTextures.metallicUrl,
      roughness: materialTextures.roughnessUrl,
      metallicRoughness: materialTextures.metallicRoughnessUrl,
      occlusion: materialTextures.occlusionUrl,
      emissive: materialTextures.emissiveUrl,
      opacity: materialTextures.opacityUrl,
    };
    const textureReferences = Object.values(textureReferencesByChannel).filter((value): value is string => Boolean(value));
    const resolvedTextureCount = Object.values(resolvedTextureByChannel).filter((value) => Boolean(value)).length;
    const hasMaterialBinding = Boolean(
      primitive.materialName ||
        primitive.materialSource ||
        textureReferences.length > 0 ||
        resolvedTextureCount > 0 ||
        primitive.metallicFactor !== null ||
        primitive.roughnessFactor !== null ||
        primitive.emissiveFactor !== null ||
        primitive.opacityFactor !== null
    );
    if (hasMaterialBinding) materialsBound += 1;
    (Object.keys(textureReferencesByChannel) as UsdMaterialChannelKey[]).forEach((channel) => {
      accountTextureBinding(channel, textureReferencesByChannel[channel], resolvedTextureByChannel[channel]);
    });
    if (resolvedTextureCount > 0) texturedMaterials += 1;
    if (options?.detailedTrace) {
      materialTraceEntries.push({
        traceId: options.traceId ?? null,
        primPath: primitive.primPath,
        nodeName: primitive.name,
        kind: "primitive",
        materialName: primitive.materialName,
        channelSources: primitive.materialChannelSources,
        referencedByChannel: textureReferencesByChannel,
        resolvedByChannel: resolvedTextureByChannel,
      });
    }
    const rebasedLocalPose = rebaseWorldPoseToTargetLocal(
      {
        position: primitive.position,
        quaternion: primitive.quaternion,
        scale: primitive.scale,
        parentBody: primitive.parentBody,
        parentBodyPath: primitive.parentBodyPath,
      },
      targetEntry
    );
    const localPose = applyBodyFrameCorrectionToLocalPose({
      localPose: rebasedLocalPose,
      parentBodyToken: primitive.parentBody,
      targetEntry,
      primPath: primitive.primPath,
      nodeName: primitive.name,
      kind: "primitive",
    });
    const visualPrimitive = createUsdVisualPrimitive(
      {
        ...primitive,
        position: localPose.position,
        quaternion: localPose.quaternion,
        scale: localPose.scale,
      },
      { materialTextures }
    );
    if (!visualPrimitive) continue;
    const collisionPrimitive = attachCollisionProxies ? createUsdCollisionMeshFromVisual(visualPrimitive) : null;
    attachPair(visualPrimitive, collisionPrimitive, targetEntry, primitive.primPath);
    attachedPrimitives += 1;
  }

  root.userData.usdMeshScene = {
    assetId: meshScene.assetId,
    filename: meshScene.filename,
    stageUpAxis: meshScene.stageUpAxis,
    normalizedToZUp: meshScene.normalizedToZUp,
    meshCount: meshScene.meshCount,
    primitiveCount: meshScene.primitiveCount,
    bodyCount: meshScene.bodyCount,
    truncated: meshScene.truncated,
    attachedMeshes,
    attachedPrimitives,
    attachedToLinks,
    attachedToRoot,
    selfCollisionEnabled,
    attachCollisionProxies,
    materialsBound,
    texturedMaterials,
    referencedTextures,
    unresolvedTextureBindings,
    unresolvedTextureBindingsByChannel,
    aliasCollisionCount: links.aliasCollisionCount,
    parentPoseWorldFallbacks,
    bodyFrameCorrections,
    materialTraceCount: materialTraceEntries.length,
  };

  if (options?.detailedTrace && materialTraceEntries.length > 0) {
    logInfo("USD material binding trace", {
      scope: "usd",
      data: {
        traceId: options.traceId ?? null,
        entries: materialTraceEntries,
      },
    });
  }

  return {
    attachedMeshes,
    attachedPrimitives,
    attachedToLinks,
    attachedToRoot,
    materialsBound,
    texturedMaterials,
    referencedTextures,
    unresolvedTextureBindings,
    unresolvedTextureBindingsByChannel,
    aliasCollisionCount: links.aliasCollisionCount,
    parentPoseWorldFallbacks,
    bodyFrameCorrections,
    materialTraceEntries,
  };
};
