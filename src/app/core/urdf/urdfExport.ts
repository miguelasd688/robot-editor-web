import * as THREE from "three";
import type { ProjectDoc, SceneNode, Transform } from "../editor/document/types";
import type { Pose, UrdfCollision, UrdfGeom, UrdfInertial, UrdfJoint } from "./urdfModel";

const DEG2RAD = Math.PI / 180;
const DIM_EPS = 1e-6;

const defaultTransform = (): Transform => ({
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
});

const clonePose = (pose: Pose): Pose => ({
  xyz: [...pose.xyz] as [number, number, number],
  rpy: [...pose.rpy] as [number, number, number],
});

const cloneGeom = (geom: UrdfGeom): UrdfGeom => {
  if (geom.kind === "box") return { kind: "box", size: [...geom.size] as [number, number, number] };
  if (geom.kind === "sphere") return { kind: "sphere", radius: geom.radius };
  if (geom.kind === "cylinder") return { kind: "cylinder", radius: geom.radius, length: geom.length };
  return { kind: "mesh", file: geom.file, scale: [...geom.scale] as [number, number, number] };
};

const cloneInertial = (item: UrdfInertial): UrdfInertial => ({
  origin: clonePose(item.origin),
  mass: item.mass,
  inertia: { ...item.inertia },
});

const finiteOr = (value: number | undefined | null, fallback: number) =>
  Number.isFinite(value) ? Number(value) : fallback;

const ensurePositive = (value: number, min = DIM_EPS) => {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.abs(value));
};

const resolveTransform = (node: SceneNode | undefined): Transform => node?.components?.transform ?? defaultTransform();

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

const matrixFromScale = (scale: Transform["scale"]) => new THREE.Matrix4().makeScale(scale.x, scale.y, scale.z);

const matrixFromRigidTransform = (transform: Transform) =>
  matrixFromTransform({
    position: { ...transform.position },
    rotation: { ...transform.rotation },
    scale: { x: 1, y: 1, z: 1 },
  });

const poseFromTransform = (transform: Transform): Pose => {
  const quat = new THREE.Quaternion();
  quat.setFromEuler(
    new THREE.Euler(transform.rotation.x * DEG2RAD, transform.rotation.y * DEG2RAD, transform.rotation.z * DEG2RAD, "XYZ")
  );
  const rpy = new THREE.Euler().setFromQuaternion(quat, "ZYX");
  return {
    xyz: [transform.position.x, transform.position.y, transform.position.z],
    rpy: [rpy.x, rpy.y, rpy.z],
  };
};

const isIdentityPose = (pose: Pose, eps = 1e-9) =>
  Math.abs(pose.xyz[0]) < eps &&
  Math.abs(pose.xyz[1]) < eps &&
  Math.abs(pose.xyz[2]) < eps &&
  Math.abs(pose.rpy[0]) < eps &&
  Math.abs(pose.rpy[1]) < eps &&
  Math.abs(pose.rpy[2]) < eps;

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

const matrixFromPose = (pose: Pose) => {
  const pos = new THREE.Vector3(pose.xyz[0], pose.xyz[1], pose.xyz[2]);
  const quat = new THREE.Quaternion();
  quat.setFromEuler(new THREE.Euler(pose.rpy[0], pose.rpy[1], pose.rpy[2], "ZYX"));
  return new THREE.Matrix4().compose(pos, quat, new THREE.Vector3(1, 1, 1));
};

const collectDescendants = (nodes: Record<string, SceneNode>, rootId: string) => {
  const out: string[] = [];
  const stack: string[] = [rootId];
  const visited = new Set<string>();
  while (stack.length) {
    const id = stack.pop() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    if (id !== rootId) out.push(id);
    const node = nodes[id];
    if (!node) continue;
    for (let i = (node.children?.length ?? 0) - 1; i >= 0; i -= 1) {
      stack.push(node.children[i]);
    }
  }
  return out;
};

const composeRelativeMatrix = (nodes: Record<string, SceneNode>, ancestorId: string, nodeId: string) => {
  const chain: string[] = [];
  let cur: string | null = nodeId;
  while (cur && cur !== ancestorId) {
    chain.push(cur);
    cur = nodes[cur]?.parentId ?? null;
  }
  if (cur !== ancestorId) return null;
  chain.reverse();
  const matrix = new THREE.Matrix4().identity();
  for (const id of chain) {
    const node = nodes[id];
    if (!node) return null;
    matrix.multiply(matrixFromTransform(resolveTransform(node)));
  }
  return matrix;
};

const resolvePrimitiveShape = (
  nodes: Record<string, SceneNode>,
  node: SceneNode,
  seen = new Set<string>()
): "cube" | "sphere" | "cylinder" | "plane" | null => {
  const source = node.source;
  if (!source) return null;
  if (source.kind === "primitive") return source.shape;
  if (source.kind === "clone") {
    if (seen.has(node.id)) return null;
    seen.add(node.id);
    const sourceNode = nodes[source.fromId];
    if (!sourceNode) return null;
    return resolvePrimitiveShape(nodes, sourceNode, seen);
  }
  return null;
};

const primitiveGeomFromScale = (
  shape: "cube" | "sphere" | "cylinder",
  scale: THREE.Vector3
): UrdfGeom => {
  const sx = ensurePositive(scale.x);
  const sy = ensurePositive(scale.y);
  const sz = ensurePositive(scale.z);
  if (shape === "cube") return { kind: "box", size: [sx, sy, sz] };
  if (shape === "sphere") {
    const radius = ensurePositive(Math.max(sx, sy, sz) * 0.5);
    return { kind: "sphere", radius };
  }
  const radius = ensurePositive(Math.max(sx, sz) * 0.5);
  const length = ensurePositive(sy);
  return { kind: "cylinder", radius, length };
};

const meshRoleForLink = (
  nodes: Record<string, SceneNode>,
  linkId: string,
  meshId: string
): "visual" | "collision" => {
  let cur = nodes[meshId]?.parentId ?? null;
  while (cur && cur !== linkId) {
    const node = nodes[cur];
    if (!node) break;
    if (node.kind === "visual") return "visual";
    if (node.kind === "collision") return "collision";
    cur = node.parentId ?? null;
  }
  return "visual";
};

const collectPrimitiveGeometries = (nodes: Record<string, SceneNode>, linkId: string) => {
  const visuals: UrdfCollision[] = [];
  const collisions: UrdfCollision[] = [];
  const link = nodes[linkId];
  if (!link) return { visuals, collisions };

  const stack = [...link.children];
  while (stack.length) {
    const id = stack.pop() as string;
    const node = nodes[id];
    if (!node) continue;
    if (node.kind === "link" || node.kind === "joint") continue;

    if (node.kind === "mesh") {
      const shape = resolvePrimitiveShape(nodes, node);
      if (shape && shape !== "plane") {
        const relative = composeRelativeMatrix(nodes, linkId, node.id);
        if (relative) {
          const origin = poseFromMatrix(relative);
          const pos = new THREE.Vector3();
          const quat = new THREE.Quaternion();
          const scale = new THREE.Vector3();
          relative.decompose(pos, quat, scale);
          const geom = primitiveGeomFromScale(shape, scale);
          const entry: UrdfCollision = {
            name: node.name || undefined,
            origin,
            geom,
          };
          const role = meshRoleForLink(nodes, linkId, node.id);
          if (role === "collision") collisions.push(entry);
          else visuals.push(entry);
        }
      }
    }

    for (let i = (node.children?.length ?? 0) - 1; i >= 0; i -= 1) {
      stack.push(node.children[i]);
    }
  }

  return { visuals, collisions };
};

const hasIncomingJoint = (nodes: Record<string, SceneNode>, linkId: string) => {
  const parentId = nodes[linkId]?.parentId ?? null;
  if (!parentId) return false;
  return nodes[parentId]?.kind === "joint";
};

const collectDirectChildrenByKind = (
  nodes: Record<string, SceneNode>,
  linkId: string,
  kind: "visual" | "collision"
) => {
  const link = nodes[linkId];
  if (!link) return [];
  return link.children
    .map((childId) => nodes[childId])
    .filter((child): child is SceneNode => !!child && child.kind === kind);
};

const withSceneOrigins = (
  nodes: Record<string, SceneNode>,
  linkId: string,
  kind: "visual" | "collision",
  items: UrdfCollision[]
) => {
  const nodesByKind = collectDirectChildrenByKind(nodes, linkId, kind);
  return items.map((item, index) => {
    const source = nodesByKind[index];
    const transform = resolveTransform(source);
    return {
      name: item.name,
      geom: cloneGeom(item.geom),
      origin: source ? poseFromTransform(transform) : clonePose(item.origin),
    };
  });
};

const scaleGeom = (geom: UrdfGeom, scale: THREE.Vector3): UrdfGeom => {
  const sx = ensurePositive(scale.x);
  const sy = ensurePositive(scale.y);
  const sz = ensurePositive(scale.z);
  if (geom.kind === "box") {
    return {
      kind: "box",
      size: [
        ensurePositive(geom.size[0] * sx),
        ensurePositive(geom.size[1] * sy),
        ensurePositive(geom.size[2] * sz),
      ],
    };
  }
  if (geom.kind === "sphere") {
    return {
      kind: "sphere",
      radius: ensurePositive(geom.radius * Math.max(sx, sy, sz)),
    };
  }
  if (geom.kind === "cylinder") {
    return {
      kind: "cylinder",
      radius: ensurePositive(geom.radius * Math.max(sx, sy)),
      length: ensurePositive(geom.length * sz),
    };
  }
  return {
    kind: "mesh",
    file: geom.file,
    scale: [
      ensurePositive(geom.scale[0] * sx),
      ensurePositive(geom.scale[1] * sy),
      ensurePositive(geom.scale[2] * sz),
    ],
  };
};

const transformCollision = (
  item: UrdfCollision,
  options: { frameMatrix?: THREE.Matrix4; linkScale?: Transform["scale"] }
): UrdfCollision => {
  const frameMatrix = options.frameMatrix ?? new THREE.Matrix4().identity();
  const scaleMatrix = matrixFromScale(options.linkScale ?? { x: 1, y: 1, z: 1 });
  const matrix = frameMatrix.clone().multiply(scaleMatrix).multiply(matrixFromPose(item.origin));
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(pos, quat, scale);
  return {
    name: item.name,
    origin: poseFromMatrix(matrix),
    geom: scaleGeom(item.geom, scale),
  };
};

const transformCollisionList = (
  items: UrdfCollision[],
  options: { frameMatrix?: THREE.Matrix4; linkScale?: Transform["scale"] }
) => items.map((item) => transformCollision(item, options));

const transformInertial = (
  inertial: UrdfInertial | undefined,
  options: { frameMatrix?: THREE.Matrix4; linkScale?: Transform["scale"] }
) => {
  if (!inertial) return undefined;
  const frameMatrix = options.frameMatrix ?? new THREE.Matrix4().identity();
  const scaleMatrix = matrixFromScale(options.linkScale ?? { x: 1, y: 1, z: 1 });
  const originMatrix = frameMatrix.clone().multiply(scaleMatrix).multiply(matrixFromPose(inertial.origin));
  return {
    ...inertial,
    origin: poseFromMatrix(originMatrix),
  };
};

const resolveLinkInertial = (node: SceneNode): UrdfInertial | undefined => {
  const urdf = node.components?.urdf;
  if (urdf?.kind === "link" && urdf.link.inertial) {
    return cloneInertial(urdf.link.inertial);
  }
  const physics = node.components?.physics;
  if (!physics) return undefined;
  if (!Number.isFinite(physics.mass)) return undefined;

  const mass = Math.max(0, Number(physics.mass));
  const tensor = physics.inertiaTensor;
  const ixx = finiteOr(tensor?.ixx, physics.inertia.x);
  const iyy = finiteOr(tensor?.iyy, physics.inertia.y);
  const izz = finiteOr(tensor?.izz, physics.inertia.z);
  const ixy = finiteOr(tensor?.ixy, 0);
  const ixz = finiteOr(tensor?.ixz, 0);
  const iyz = finiteOr(tensor?.iyz, 0);
  if (![ixx, iyy, izz, ixy, ixz, iyz].every(Number.isFinite)) return undefined;

  const com = physics.com ?? { x: 0, y: 0, z: 0 };
  return {
    origin: { xyz: [com.x, com.y, com.z], rpy: [0, 0, 0] },
    mass,
    inertia: { ixx, iyy, izz, ixy, ixz, iyz },
  };
};

const sanitizeName = (raw: string, fallback: string) => {
  const trimmed = raw.trim();
  const base = (trimmed || fallback).replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  const normalized = base.length ? base : fallback;
  if (/^[0-9]/.test(normalized)) return `n_${normalized}`;
  return normalized;
};

const claimUniqueName = (raw: string, fallback: string, used: Set<string>) => {
  const base = sanitizeName(raw, fallback);
  let next = base;
  let suffix = 2;
  while (used.has(next)) {
    next = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(next);
  return next;
};

const findAncestorLinkId = (nodes: Record<string, SceneNode>, startId: string | null) => {
  let cur = startId;
  while (cur) {
    const node = nodes[cur];
    if (!node) return null;
    if (node.kind === "link") return cur;
    cur = node.parentId ?? null;
  }
  return null;
};

const findDescendantLinkId = (nodes: Record<string, SceneNode>, jointId: string) => {
  const joint = nodes[jointId];
  if (!joint) return null;
  const stack = [...joint.children];
  while (stack.length) {
    const id = stack.pop() as string;
    const node = nodes[id];
    if (!node) continue;
    if (node.kind === "link") return node.id;
    if (node.kind === "joint") continue;
    for (let i = (node.children?.length ?? 0) - 1; i >= 0; i -= 1) {
      stack.push(node.children[i]);
    }
  }
  return null;
};

const escapeAttr = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const formatNumber = (value: number) => {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.abs(value) < 1e-12 ? 0 : value;
  const fixed = rounded.toFixed(6).replace(/\.?0+$/, "");
  return fixed === "-0" ? "0" : fixed;
};

const formatVec3 = (vec: [number, number, number]) =>
  `${formatNumber(vec[0])} ${formatNumber(vec[1])} ${formatNumber(vec[2])}`;

const appendGeometry = (lines: string[], indent: string, geom: UrdfGeom) => {
  if (geom.kind === "box") {
    lines.push(`${indent}<box size="${formatVec3(geom.size)}" />`);
    return;
  }
  if (geom.kind === "sphere") {
    lines.push(`${indent}<sphere radius="${formatNumber(geom.radius)}" />`);
    return;
  }
  if (geom.kind === "cylinder") {
    lines.push(
      `${indent}<cylinder radius="${formatNumber(geom.radius)}" length="${formatNumber(geom.length)}" />`
    );
    return;
  }
  lines.push(
    `${indent}<mesh filename="${escapeAttr(geom.file)}" scale="${formatVec3(geom.scale)}" />`
  );
};

const appendCollisionLike = (lines: string[], tag: "visual" | "collision", item: UrdfCollision, indent: string) => {
  const nameAttr = item.name ? ` name="${escapeAttr(item.name)}"` : "";
  lines.push(`${indent}<${tag}${nameAttr}>`);
  lines.push(`${indent}  <origin xyz="${formatVec3(item.origin.xyz)}" rpy="${formatVec3(item.origin.rpy)}" />`);
  lines.push(`${indent}  <geometry>`);
  appendGeometry(lines, `${indent}    `, item.geom);
  lines.push(`${indent}  </geometry>`);
  lines.push(`${indent}</${tag}>`);
};

const serializeUrdf = (robotName: string, links: Array<{ name: string; inertial?: UrdfInertial; visuals: UrdfCollision[]; collisions: UrdfCollision[] }>, joints: UrdfJoint[]) => {
  const lines: string[] = [];
  lines.push(`<?xml version="1.0"?>`);
  lines.push(`<robot name="${escapeAttr(robotName)}">`);

  for (const link of links) {
    lines.push(`  <link name="${escapeAttr(link.name)}">`);
    if (link.inertial) {
      lines.push(`    <inertial>`);
      lines.push(
        `      <origin xyz="${formatVec3(link.inertial.origin.xyz)}" rpy="${formatVec3(link.inertial.origin.rpy)}" />`
      );
      lines.push(`      <mass value="${formatNumber(link.inertial.mass)}" />`);
      lines.push(
        `      <inertia ixx="${formatNumber(link.inertial.inertia.ixx)}" ixy="${formatNumber(link.inertial.inertia.ixy)}" ixz="${formatNumber(link.inertial.inertia.ixz)}" iyy="${formatNumber(link.inertial.inertia.iyy)}" iyz="${formatNumber(link.inertial.inertia.iyz)}" izz="${formatNumber(link.inertial.inertia.izz)}" />`
      );
      lines.push(`    </inertial>`);
    }
    for (const visual of link.visuals) {
      appendCollisionLike(lines, "visual", visual, "    ");
    }
    for (const collision of link.collisions) {
      appendCollisionLike(lines, "collision", collision, "    ");
    }
    lines.push(`  </link>`);
  }

  for (const joint of joints) {
    lines.push(`  <joint name="${escapeAttr(joint.name)}" type="${escapeAttr(joint.type)}">`);
    lines.push(`    <origin xyz="${formatVec3(joint.origin.xyz)}" rpy="${formatVec3(joint.origin.rpy)}" />`);
    lines.push(`    <parent link="${escapeAttr(joint.parent)}" />`);
    lines.push(`    <child link="${escapeAttr(joint.child)}" />`);
    if (joint.type !== "fixed" && joint.type !== "floating") {
      lines.push(`    <axis xyz="${formatVec3(joint.axis)}" />`);
    }
    if (joint.limit) {
      const attrs: string[] = [];
      if (Number.isFinite(joint.limit.lower)) attrs.push(`lower="${formatNumber(Number(joint.limit.lower))}"`);
      if (Number.isFinite(joint.limit.upper)) attrs.push(`upper="${formatNumber(Number(joint.limit.upper))}"`);
      if (Number.isFinite(joint.limit.effort)) attrs.push(`effort="${formatNumber(Number(joint.limit.effort))}"`);
      if (Number.isFinite(joint.limit.velocity))
        attrs.push(`velocity="${formatNumber(Number(joint.limit.velocity))}"`);
      if (attrs.length) lines.push(`    <limit ${attrs.join(" ")} />`);
    }
    if (joint.dynamics) {
      const attrs: string[] = [];
      if (Number.isFinite(joint.dynamics.damping))
        attrs.push(`damping="${formatNumber(Number(joint.dynamics.damping))}"`);
      if (Number.isFinite(joint.dynamics.friction))
        attrs.push(`friction="${formatNumber(Number(joint.dynamics.friction))}"`);
      if (attrs.length) lines.push(`    <dynamics ${attrs.join(" ")} />`);
    }
    lines.push(`  </joint>`);
  }

  lines.push(`</robot>`);
  return lines.join("\n");
};

export type ExportRobotUrdfResult = {
  robotId: string;
  robotName: string;
  urdf: string;
  warnings: string[];
};

export function exportRobotToUrdf(doc: ProjectDoc, robotId: string): ExportRobotUrdfResult {
  const nodes = doc.scene.nodes;
  const robot = nodes[robotId];
  if (!robot || robot.kind !== "robot") {
    throw new Error("The selected node is not a robot.");
  }

  const descendants = collectDescendants(nodes, robotId);
  const linkNodes = descendants
    .map((id) => nodes[id])
    .filter((node): node is SceneNode => !!node && node.kind === "link");
  const jointNodes = descendants
    .map((id) => nodes[id])
    .filter((node): node is SceneNode => !!node && node.kind === "joint");

  if (!linkNodes.length) {
    throw new Error("The selected robot has no links to export.");
  }

  const warnings: string[] = [];
  const usedLinkNames = new Set<string>();
  const usedJointNames = new Set<string>();
  const linkNameById = new Map<string, string>();

  for (const link of linkNodes) {
    const urdf = link.components?.urdf;
    const preferred = urdf?.kind === "link" ? urdf.link.name : link.name;
    const unique = claimUniqueName(preferred || link.id, "link", usedLinkNames);
    linkNameById.set(link.id, unique);
  }

  const links = linkNodes.map((link) => {
    const urdf = link.components?.urdf;
    const linkUrdf = urdf?.kind === "link" ? urdf.link : null;
    const primitives = collectPrimitiveGeometries(nodes, link.id);
    const linkTransform = resolveTransform(link);
    const hasParentJoint = hasIncomingJoint(nodes, link.id);
    const frameMatrixBase = hasParentJoint
      ? new THREE.Matrix4().identity()
      : matrixFromRigidTransform(linkTransform);
    const fallbackOffsetPose = hasParentJoint ? poseFromTransform(linkTransform) : undefined;
    const linkOffsetPose = linkUrdf?.editorOffset ?? fallbackOffsetPose;
    const linkOffsetMatrix =
      linkOffsetPose && !isIdentityPose(linkOffsetPose)
        ? matrixFromPose(linkOffsetPose)
        : new THREE.Matrix4().identity();
    const frameMatrix = frameMatrixBase.clone().multiply(linkOffsetMatrix);
    const importedVisuals = linkUrdf ? withSceneOrigins(nodes, link.id, "visual", linkUrdf.visuals) : [];
    const importedCollisions = linkUrdf ? withSceneOrigins(nodes, link.id, "collision", linkUrdf.collisions) : [];
    const visuals = [
      ...transformCollisionList(importedVisuals, {
        frameMatrix,
        linkScale: linkTransform.scale,
      }),
      ...transformCollisionList(primitives.visuals, {
        frameMatrix,
        linkScale: linkTransform.scale,
      }),
    ];
    const collisions = [
      ...transformCollisionList(importedCollisions, {
        frameMatrix,
        linkScale: linkTransform.scale,
      }),
      ...transformCollisionList(primitives.collisions, {
        frameMatrix,
        linkScale: linkTransform.scale,
      }),
    ];
    return {
      name: linkNameById.get(link.id) as string,
      inertial: transformInertial(resolveLinkInertial(link), { frameMatrix, linkScale: linkTransform.scale }),
      visuals,
      collisions,
    };
  });

  const joints: UrdfJoint[] = [];
  for (const jointNode of jointNodes) {
    const parentLinkId = findAncestorLinkId(nodes, jointNode.parentId ?? null);
    const childLinkId = findDescendantLinkId(nodes, jointNode.id);
    if (!parentLinkId || !childLinkId) {
      warnings.push(
        `Skipped joint "${jointNode.name || jointNode.id}" because parent or child link could not be resolved.`
      );
      continue;
    }
    if (parentLinkId === childLinkId) {
      warnings.push(`Skipped joint "${jointNode.name || jointNode.id}" because it links the same link as parent and child.`);
      continue;
    }

    const parentName = linkNameById.get(parentLinkId);
    const childName = linkNameById.get(childLinkId);
    if (!parentName || !childName) {
      warnings.push(
        `Skipped joint "${jointNode.name || jointNode.id}" because mapped link names could not be resolved.`
      );
      continue;
    }

    const urdf = jointNode.components?.urdf;
    const jointUrdf = urdf?.kind === "joint" ? urdf.joint : null;
    const jointTransform = resolveTransform(jointNode);
    const parentLink = nodes[parentLinkId];
    const childLink = nodes[childLinkId];
    const childLinkTransform = resolveTransform(childLink);
    const parentLinkTransform = resolveTransform(parentLink);
    const parentLinkUrdf =
      parentLink?.components?.urdf?.kind === "link" ? parentLink.components.urdf.link : null;
    const uniqueName = claimUniqueName(jointUrdf?.name || jointNode.name || jointNode.id, "joint", usedJointNames);

    const parentFrameMatrix = hasIncomingJoint(nodes, parentLinkId)
      ? new THREE.Matrix4().identity()
      : matrixFromRigidTransform(parentLinkTransform);
    const parentScaleMatrix = matrixFromScale(parentLinkTransform.scale);
    const jointMatrix = matrixFromRigidTransform(jointTransform);
    const childRigidMatrix = matrixFromRigidTransform(childLinkTransform);
    const originMatrix = parentFrameMatrix
      .clone()
      .multiply(parentScaleMatrix)
      .multiply(jointMatrix)
      .multiply(childRigidMatrix);
    const baseOrigin = jointUrdf?.origin ? clonePose(jointUrdf.origin) : poseFromMatrix(originMatrix);
    const fallbackParentOffset = hasIncomingJoint(nodes, parentLinkId) ? poseFromTransform(parentLinkTransform) : undefined;
    const parentOffsetPose = parentLinkUrdf?.editorOffset ?? fallbackParentOffset;
    const origin = parentOffsetPose && !isIdentityPose(parentOffsetPose)
      ? poseFromMatrix(matrixFromPose(parentOffsetPose).multiply(matrixFromPose(baseOrigin)))
      : baseOrigin;

    const axisSeed: [number, number, number] = jointUrdf?.axis
      ? [
          finiteOr(jointUrdf.axis[0], 0),
          finiteOr(jointUrdf.axis[1], 0),
          finiteOr(jointUrdf.axis[2], 1),
        ]
      : [0, 0, 1];
    const axisVec = new THREE.Vector3(axisSeed[0], axisSeed[1], axisSeed[2]);
    if (axisVec.lengthSq() < 1e-12) axisVec.set(0, 0, 1);
    axisVec.normalize();
    const axis: [number, number, number] = [axisVec.x, axisVec.y, axisVec.z];

    joints.push({
      name: uniqueName,
      type: jointUrdf?.type ?? "fixed",
      parent: parentName,
      child: childName,
      origin,
      axis,
      limit: jointUrdf?.limit ? { ...jointUrdf.limit } : undefined,
      dynamics: jointUrdf?.dynamics ? { ...jointUrdf.dynamics } : undefined,
    });
  }

  const robotName = sanitizeName(robot.name || "robot", "robot");
  const urdf = serializeUrdf(robotName, links, joints);
  return { robotId, robotName, urdf, warnings };
}
