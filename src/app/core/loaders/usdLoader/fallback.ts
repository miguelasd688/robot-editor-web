import * as THREE from "three";
import { logWarn } from "../../services/logger";
import {
  normalizeBodyToken,
  normalizePathAliasToken,
  claimName,
  toPose,
  stripFileExtension,
  IDENTITY_QUAT,
  JOINT_NAME_RE,
  LINK_NAME_RE,
  PATH_SKIP_SEGMENTS,
  FILE_EXT_SKIP_RE,
  REFERENCE_EXT_RE,
} from "./types";
import type {
  UsdPrimNode,
  NormalizedUsdMeshScene,
  NormalizedUsdMeshSceneBody,
  Pose,
  UrdfCollision,
  UrdfGeom,
  UrdfJoint,
  UrdfLink,
} from "./types";
import { collectMeshSceneStructureTokens } from "./meshScene";

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const MAX_USD_TREE_NODES = 240;
const PRINTABLE_MIN = 0x20;
const PRINTABLE_MAX = 0x7e;

/* ------------------------------------------------------------------ */
/*  Path / token parsing                                              */
/* ------------------------------------------------------------------ */

const normalizeSlashPath = (value: string) => value.replace(/\\/g, "/").replace(/\/+/g, "/");

const normalizePrimPath = (value: string): string | null => {
  const cleaned = normalizeSlashPath(value.trim())
    .replace(/^["']+|["']+$/g, "")
    .replace(/^[./]+/, "")
    .replace(/^\/+/, "");
  if (!cleaned) return null;
  if (cleaned.includes("://")) return null;
  if (FILE_EXT_SKIP_RE.test(cleaned)) return null;
  const parts = cleaned
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  if (parts.some((part) => PATH_SKIP_SEGMENTS.has(part.toLowerCase()))) return null;
  if (parts.some((part) => !/^[A-Za-z0-9_.:-]+$/.test(part))) return null;
  return `/${parts.join("/")}`;
};

const pathDepth = (path: string) => path.split("/").filter(Boolean).length;

const isSemanticUsdPathCandidate = (path: string): boolean => {
  const segments = path.split("/").filter(Boolean);
  if (!segments.length) return false;
  if (segments.some((segment) => LINK_NAME_RE.test(segment) || JOINT_NAME_RE.test(segment))) return true;
  return segments.some((segment) => /[A-Za-z]/.test(segment) && /\d/.test(segment) && segment.length >= 3);
};

const extractPrintableTokens = (bytes: Uint8Array): string[] => {
  const out: string[] = [];
  let start = -1;
  const pushToken = (from: number, to: number) => {
    if (to - from < 4) return;
    let token = "";
    for (let i = from; i < to; i += 1) token += String.fromCharCode(bytes[i]);
    out.push(token);
  };
  for (let i = 0; i < bytes.length; i += 1) {
    const code = bytes[i];
    const printable = code >= PRINTABLE_MIN && code <= PRINTABLE_MAX;
    if (printable) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0) pushToken(start, i);
    start = -1;
  }
  if (start >= 0) pushToken(start, bytes.length);
  return out;
};

const extractPathCandidates = (tokens: string[]): string[] => {
  const out = new Set<string>();
  for (const token of tokens) {
    const normalized = normalizeSlashPath(token);
    const matches = normalized.match(/(?:\/|\.\/)?[A-Za-z0-9_.:-]+(?:\/[A-Za-z0-9_.:-]+)+/g);
    if (!matches) continue;
    for (const match of matches) {
      const path = normalizePrimPath(match);
      if (path) out.add(path);
    }
  }
  return Array.from(out);
};

const extractReferences = (tokens: string[]): string[] => {
  const refs = new Set<string>();
  for (const token of tokens) {
    if (!REFERENCE_EXT_RE.test(token)) continue;
    const normalized = normalizeSlashPath(token).replace(/^["']+|["']+$/g, "");
    if (!normalized || FILE_EXT_SKIP_RE.test(normalized)) continue;
    refs.add(normalized);
  }
  return Array.from(refs);
};

/* ------------------------------------------------------------------ */
/*  Prim classification                                               */
/* ------------------------------------------------------------------ */

const classifyPrimKind = (name: string, path: string): UsdPrimNode["kind"] => {
  if (JOINT_NAME_RE.test(name) || JOINT_NAME_RE.test(path)) return "joint";
  if (LINK_NAME_RE.test(name) || LINK_NAME_RE.test(path)) return "link";
  return "group";
};

/* ------------------------------------------------------------------ */
/*  Raw USD reading                                                   */
/* ------------------------------------------------------------------ */

const readUsdBytes = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load USD (${response.status} ${response.statusText})`);
  return new Uint8Array(await response.arrayBuffer());
};

/* ------------------------------------------------------------------ */
/*  Prim node building                                                */
/* ------------------------------------------------------------------ */

const buildPrimNodes = (paths: string[], rootHint: string): UsdPrimNode[] => {
  const unique = new Set<string>();
  for (const path of paths) {
    const normalized = normalizePrimPath(path);
    if (!normalized) continue;
    const parts = normalized.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      unique.add(current);
    }
  }

  if (!unique.size) {
    unique.add(`/${rootHint}`);
  }

  const sorted = Array.from(unique).sort((a, b) => pathDepth(a) - pathDepth(b) || a.localeCompare(b));
  const nodes: UsdPrimNode[] = [];
  for (const path of sorted.slice(0, MAX_USD_TREE_NODES)) {
    const parts = path.split("/").filter(Boolean);
    const name = parts[parts.length - 1] ?? rootHint;
    const parentPath = parts.length > 1 ? `/${parts.slice(0, -1).join("/")}` : null;
    nodes.push({
      path,
      name,
      parentPath,
      kind: classifyPrimKind(name, path),
    });
  }

  const hasLink = nodes.some((node) => node.kind === "link");
  if (!hasLink) {
    const hasChild = new Set(nodes.map((node) => node.parentPath).filter(Boolean) as string[]);
    for (const node of nodes) {
      if (node.kind !== "group") continue;
      if (!hasChild.has(node.path)) node.kind = "link";
    }
  }

  return nodes;
};

/* ------------------------------------------------------------------ */
/*  Fallback hierarchy                                                */
/* ------------------------------------------------------------------ */

const addUsdHierarchyFallback = (robotRoot: THREE.Group, nodes: UsdPrimNode[]) => {
  const objectByPath = new Map<string, THREE.Group>();
  for (const node of nodes) {
    const group = new THREE.Group();
    group.name = node.name;
    group.userData.usdPrimPath = node.path;
    group.userData.usdPrimKind = node.kind;
    if (node.kind === "link" || node.kind === "joint") {
      group.userData.editorKind = node.kind;
      if (node.kind === "link") {
        const bodyToken = normalizeBodyToken(node.name);
        if (bodyToken) group.userData.usdBodyToken = bodyToken;
        const bodyPath = normalizePathAliasToken(node.path);
        if (bodyPath) group.userData.usdBodyPath = bodyPath;
      }
    }
    objectByPath.set(node.path, group);
  }

  for (const node of nodes) {
    const group = objectByPath.get(node.path);
    if (!group) continue;
    if (node.parentPath) {
      const parent = objectByPath.get(node.parentPath);
      if (parent) {
        parent.add(group);
        continue;
      }
    }
    robotRoot.add(group);
  }
};

export const fallbackUsdHierarchyFromTokens = async (
  robotName: string,
  usdUrl: string,
  resolveResource?: (resourcePath: string) => string | null
) => {
  const robotRoot = new THREE.Group();
  const robotRootFlagged = robotRoot as THREE.Group & { isRobot?: boolean };
  robotRoot.name = robotName;
  robotRootFlagged.isRobot = true;
  robotRoot.userData.editorRobotRoot = true;

  const allTokens: string[] = [];
  const visited = new Set<string>();
  const queue: string[] = [usdUrl];

  while (queue.length && visited.size < 8) {
    const current = queue.shift() as string;
    if (visited.has(current)) continue;
    visited.add(current);

    try {
      const bytes = await readUsdBytes(current);
      const tokens = extractPrintableTokens(bytes);
      allTokens.push(...tokens);
      const refs = extractReferences(tokens);
      for (const ref of refs) {
        const resolved = resolveResource?.(ref) ?? null;
        if (resolved && !visited.has(resolved)) queue.push(resolved);
      }
    } catch (error) {
      logWarn("USD: failed to inspect referenced layer", {
        scope: "usd",
        data: { url: current, error: String((error as Error)?.message ?? error) },
      });
    }
  }

  const rootHint = robotName.replace(/\.[^/.]+$/, "").split("/").pop() || "UsdRobot";
  const primPaths = extractPathCandidates(allTokens);
  const semanticPrimPaths = primPaths.filter((path) => isSemanticUsdPathCandidate(path));
  const primNodes = buildPrimNodes(semanticPrimPaths, rootHint);

  addUsdHierarchyFallback(robotRoot, primNodes);
  logWarn("USD fallback hierarchy used (converter unavailable or conversion failed).", {
    scope: "usd",
    data: { primCount: primNodes.length, pathCount: primPaths.length, semanticPathCount: semanticPrimPaths.length },
  });

  return robotRoot;
};

/* ------------------------------------------------------------------ */
/*  Placeholder link node                                             */
/* ------------------------------------------------------------------ */

export const createPlaceholderLinkNode = (linkName: string, bodyPath?: string | null) => {
  const link = new THREE.Group();
  const linkFlags = link as THREE.Group & { isURDFLink?: boolean; urdfName?: string };
  link.name = linkName;
  linkFlags.isURDFLink = true;
  linkFlags.urdfName = linkName;
  link.userData.editorKind = "link";
  const bodyToken = normalizeBodyToken(linkName);
  if (bodyToken) link.userData.usdBodyToken = bodyToken;
  const normalizedBodyPath = normalizePathAliasToken(bodyPath);
  if (normalizedBodyPath) link.userData.usdBodyPath = normalizedBodyPath;

  const visual = new THREE.Group();
  const visualFlags = visual as THREE.Group & { isURDFVisual?: boolean; urdfName?: string };
  visual.name = "Visual";
  visualFlags.isURDFVisual = true;
  visualFlags.urdfName = `${linkName}__visual`;
  visual.userData.editorKind = "visual";

  const collision = new THREE.Group();
  const collisionFlags = collision as THREE.Group & { isURDFCollider?: boolean; urdfName?: string };
  collision.name = "Collision";
  collisionFlags.isURDFCollider = true;
  collisionFlags.urdfName = `${linkName}__collision`;
  collision.userData.editorKind = "collision";
  collision.visible = false;

  const visualMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 0.08, 0.08),
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(0.45, 0.62, 0.84),
      metalness: 0.02,
      roughness: 0.88,
    })
  );
  visualMesh.name = `${linkName}_visual`;
  visualMesh.userData.editorKind = "mesh";
  visual.add(visualMesh);

  const collisionMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 0.08, 0.08),
    new THREE.MeshBasicMaterial({
      color: 0x8c5a2b,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    })
  );
  collisionMesh.name = `${linkName}_collision`;
  collisionMesh.userData.editorKind = "mesh";
  collision.add(collisionMesh);

  link.add(visual);
  link.add(collision);

  const linkGeom: UrdfGeom = { kind: "box", size: [0.18, 0.08, 0.08] };
  const linkPose: Pose = { xyz: [0, 0, 0], rpy: [0, 0, 0] };
  const visuals: UrdfCollision[] = [
    {
      name: `${linkName}_visual`,
      origin: linkPose,
      geom: linkGeom,
      rgba: [0.45, 0.62, 0.84, 1],
    },
  ];
  const collisions: UrdfCollision[] = [
    {
      name: `${linkName}_collision`,
      origin: linkPose,
      geom: linkGeom,
    },
  ];

  const urdfLink: UrdfLink = {
    name: linkName,
    visuals,
    collisions,
  };
  link.userData.urdf = { kind: "link", link: urdfLink };
  return link;
};

/* ------------------------------------------------------------------ */
/*  Build robot from mesh-scene bodies                                */
/* ------------------------------------------------------------------ */

export const buildRobotFromMeshSceneBodies = (meshScene: NormalizedUsdMeshScene, robotName: string) => {
  const robotRoot = new THREE.Group();
  const robotRootFlagged = robotRoot as THREE.Group & { isRobot?: boolean };
  robotRoot.name = robotName;
  robotRootFlagged.isRobot = true;
  robotRoot.userData.editorRobotRoot = true;

  const bodyByToken = new Map<string, NormalizedUsdMeshSceneBody>();
  for (const body of meshScene.bodies) {
    const token = normalizeBodyToken(body.name) ?? String(body.name ?? "").trim();
    if (!token || bodyByToken.has(token)) continue;
    bodyByToken.set(token, {
      ...body,
      name: token,
    });
  }
  const structureTokens = collectMeshSceneStructureTokens(meshScene);
  for (const token of structureTokens) {
    if (bodyByToken.has(token)) continue;
    bodyByToken.set(token, {
      name: token,
      primPath: "",
      parentBody: null,
      parentBodyPath: null,
      position: [0, 0, 0],
      quaternion: new THREE.Quaternion(0, 0, 0, 1),
      scale: [1, 1, 1],
      rigidBodyEnabled: null,
      kinematicEnabled: null,
      mass: null,
    });
  }

  if (bodyByToken.size === 0) {
    return { root: robotRoot, linkCount: 0, jointCount: 0 };
  }

  const linksByToken = new Map<string, THREE.Group>();
  const ensureLink = (token: string) => {
    const existing = linksByToken.get(token);
    if (existing) return existing;
    const body = bodyByToken.get(token);
    const hintedBodyPath = normalizePathAliasToken(body?.primPath ?? body?.parentBodyPath ?? null);
    const created = createPlaceholderLinkNode(token, hintedBodyPath);
    created.userData.usdBodyToken = token;
    if (hintedBodyPath) created.userData.usdBodyPath = hintedBodyPath;
    linksByToken.set(token, created);
    return created;
  };

  for (const token of bodyByToken.keys()) {
    ensureLink(token);
  }

  const jointNames = new Set<string>();
  let jointCount = 0;

  for (const [token, body] of bodyByToken.entries()) {
    const parentToken = normalizeBodyToken(body.parentBody);
    if (!parentToken || !bodyByToken.has(parentToken) || parentToken === token) continue;
    const parentLink = ensureLink(parentToken);
    const childLink = ensureLink(token);
    if (childLink.parent) continue;

    const jointName = claimName(`${parentToken}_${token}_fixed`, jointNames, "joint");
    const jointNode = new THREE.Group();
    const jointFlags = jointNode as THREE.Group & { isURDFJoint?: boolean; urdfName?: string };
    jointNode.name = jointName;
    jointFlags.isURDFJoint = true;
    jointFlags.urdfName = jointName;
    jointNode.userData.editorKind = "joint";
    jointNode.position.set(body.position[0], body.position[1], body.position[2]);
    jointNode.quaternion.copy(body.quaternion);
    jointNode.userData.urdf = {
      kind: "joint",
      joint: {
        name: jointName,
        type: "fixed",
        parent: parentLink.name,
        child: childLink.name,
        origin: toPose(body.position, body.quaternion),
        axis: [0, 0, 1],
      } satisfies UrdfJoint,
    };

    parentLink.add(jointNode);
    jointNode.add(childLink);
    childLink.position.set(0, 0, 0);
    childLink.quaternion.identity();
    childLink.scale.set(body.scale[0], body.scale[1], body.scale[2]);
    jointCount += 1;
  }

  for (const [token, link] of linksByToken.entries()) {
    if (link.parent) continue;
    const body = bodyByToken.get(token);
    if (body) {
      link.position.set(body.position[0], body.position[1], body.position[2]);
      link.quaternion.copy(body.quaternion);
      link.scale.set(body.scale[0], body.scale[1], body.scale[2]);
    }
    robotRoot.add(link);
  }

  let effectiveLinkCount = linksByToken.size;
  const modelToken = normalizeBodyToken(stripFileExtension(robotName));
  if (modelToken && linksByToken.size > 1) {
    const modelLink = linksByToken.get(modelToken);
    if (modelLink && modelLink.parent === robotRoot) {
      const nearIdentityScale =
        Math.abs(modelLink.scale.x - 1) <= 1e-4 &&
        Math.abs(modelLink.scale.y - 1) <= 1e-4 &&
        Math.abs(modelLink.scale.z - 1) <= 1e-4;
      const nearIdentityPose =
        modelLink.position.lengthSq() <= 1e-10 &&
        modelLink.quaternion.angleTo(IDENTITY_QUAT) <= 1e-4 &&
        nearIdentityScale;
      if (nearIdentityPose) {
        const children = [...modelLink.children];
        for (const child of children) {
          modelLink.remove(child);
          robotRoot.add(child);
        }
        robotRoot.remove(modelLink);
        effectiveLinkCount -= 1;
      }
    }
  }

  return {
    root: robotRoot,
    linkCount: effectiveLinkCount,
    jointCount,
  };
};
