import * as THREE from "three";
import {
  normalizeBodyToken,
  normalizePathAliasToken,
  claimName,
  axisInJointFrame,
} from "./types";
import type {
  NormalizedIntrospectionJoint,
  NormalizedUsdIntrospection,
  UsdConverterIntrospectionResponse,
  Pose,
  UrdfJoint,
} from "./types";
import { createPlaceholderLinkNode } from "./fallback";
import { parseOptionalBoolean, parseOptionalNumber, parseOptionalText } from "./meshScene";

// ---------------------------------------------------------------------------
// Introspection parsing helpers
// ---------------------------------------------------------------------------

const parseStageUpAxis = (value: unknown): "X" | "Y" | "Z" | "unknown" => {
  const axis = String(value ?? "").trim().toUpperCase();
  if (axis === "X" || axis === "Y" || axis === "Z") return axis;
  return "unknown";
};

const parseJointType = (value: unknown): NormalizedIntrospectionJoint["type"] => {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "revolute" || raw === "prismatic" || raw === "fixed") return raw;
  return "other";
};

const parseJointAxis = (value: unknown): [number, number, number] => {
  const raw = Array.isArray(value) ? value : [];
  const x = Number(raw[0]);
  const y = Number(raw[1]);
  const z = Number(raw[2]);
  const axis: [number, number, number] = [
    Number.isFinite(x) ? x : 0,
    Number.isFinite(y) ? y : 0,
    Number.isFinite(z) ? z : 1,
  ];
  const length = Math.sqrt(axis[0] ** 2 + axis[1] ** 2 + axis[2] ** 2);
  if (!Number.isFinite(length) || length <= 1e-9) return [0, 0, 1];
  return [axis[0] / length, axis[1] / length, axis[2] / length];
};

const parseOptionalTriplet = (value: unknown): [number, number, number] | null => {
  if (!Array.isArray(value)) return null;
  const x = Number(value[0]);
  const y = Number(value[1]);
  const z = Number(value[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
};

const parseOptionalQuartet = (value: unknown): [number, number, number, number] | null => {
  if (!Array.isArray(value)) return null;
  const a = Number(value[0]);
  const b = Number(value[1]);
  const c = Number(value[2]);
  const d = Number(value[3]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || !Number.isFinite(d)) return null;
  return [a, b, c, d];
};

const parseFramePose = (
  value: unknown
): { position: [number, number, number]; quaternion: [number, number, number, number] } | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as { position?: unknown; quaternion?: unknown };
  const position = parseOptionalTriplet(raw.position);
  const quaternion = parseOptionalQuartet(raw.quaternion);
  if (!position || !quaternion) return null;
  return { position, quaternion };
};

const parseJointMuscle = (value: unknown): NormalizedIntrospectionJoint["muscle"] => {
  if (!value || typeof value !== "object") return null;
  const raw = value as {
    enabled?: unknown;
    endA?: unknown;
    endB?: unknown;
    range?: unknown;
    force?: unknown;
    scale?: unknown;
    damping?: unknown;
  };
  const parseEndpoint = (input: unknown) => {
    if (!input || typeof input !== "object") return null;
    const endpoint = input as { body?: unknown; localPos?: unknown };
    const localPos = parseOptionalTriplet(endpoint.localPos);
    if (!localPos) return null;
    return {
      body: normalizeBodyToken(endpoint.body),
      localPos,
    };
  };
  const endA = parseEndpoint(raw.endA);
  const endB = parseEndpoint(raw.endB);
  if (!endA || !endB) return null;
  const rangeRaw = Array.isArray(raw.range) ? raw.range : [];
  const rangeA = Number(rangeRaw[0]);
  const rangeB = Number(rangeRaw[1]);
  return {
    enabled: parseOptionalBoolean(raw.enabled) ?? false,
    endA,
    endB,
    range:
      Number.isFinite(rangeA) && Number.isFinite(rangeB)
        ? [rangeA, rangeB]
        : undefined,
    force: parseOptionalNumber(raw.force) ?? undefined,
    scale: parseOptionalNumber(raw.scale) ?? undefined,
    damping: parseOptionalNumber(raw.damping) ?? undefined,
  };
};

// ---------------------------------------------------------------------------
// Introspection normalization
// ---------------------------------------------------------------------------

export const normalizeUsdIntrospection = (
  payload: UsdConverterIntrospectionResponse,
  fallbackAssetId: string
): NormalizedUsdIntrospection | null => {
  const jointsRaw = Array.isArray(payload.joints) ? payload.joints : [];
  const rootBodiesRaw = Array.isArray(payload.rootBodies) ? payload.rootBodies : [];

  const joints = jointsRaw
    .map((joint, index) => {
      const name = String(joint?.name ?? "").trim() || `joint_${index + 1}`;
      const sourceUpAxis = parseStageUpAxis(joint?.sourceUpAxis);
      const normalizedToZUp = parseOptionalBoolean(joint?.normalizedToZUp) ?? false;
      return {
        name,
        type: parseJointType(joint?.type),
        axis: parseJointAxis(joint?.axis),
        parentBody: normalizeBodyToken(joint?.parentBody),
        childBody: normalizeBodyToken(joint?.childBody),
        parentBodyPath: parseOptionalText(joint?.parentBodyPath),
        childBodyPath: parseOptionalText(joint?.childBodyPath),
        localPos0: parseOptionalTriplet(joint?.localPos0),
        localRot0: parseOptionalQuartet(joint?.localRot0),
        localPos1: parseOptionalTriplet(joint?.localPos1),
        localRot1: parseOptionalQuartet(joint?.localRot1),
        frame0Local: parseFramePose(joint?.frame0Local),
        frame1Local: parseFramePose(joint?.frame1Local),
        frame0World: parseFramePose(joint?.frame0World),
        frame1World: parseFramePose(joint?.frame1World),
        axisLocal: parseOptionalTriplet(joint?.axisLocal),
        axisWorld: parseOptionalTriplet(joint?.axisWorld),
        sourceUpAxis,
        normalizedToZUp,
        frameMismatchDistance: parseOptionalNumber(joint?.frameMismatchDistance),
        frameMismatchWarning: parseOptionalText(joint?.frameMismatchWarning),
        muscle: parseJointMuscle(joint?.muscle),
      } satisfies NormalizedIntrospectionJoint;
    })
    .filter((joint) => joint.name.length > 0);

  const rootBodies = rootBodiesRaw
    .map((item) => normalizeBodyToken(item))
    .filter((item): item is string => Boolean(item));

  if (joints.length === 0 && rootBodies.length === 0) return null;

  return {
    assetId: String(payload.assetId ?? "").trim() || fallbackAssetId,
    filename: String(payload.filename ?? "").trim() || "",
    joints,
    rootBodies,
    stageUpAxis: parseStageUpAxis(payload.stageUpAxis),
  };
};

// ---------------------------------------------------------------------------
// Introspection metadata attachment
// ---------------------------------------------------------------------------

export const attachUsdIntrospectionMetadata = (
  root: THREE.Object3D,
  introspection: NormalizedUsdIntrospection | null
) => {
  if (!introspection) return;
  root.userData.usdIntrospection = {
    assetId: introspection.assetId,
    filename: introspection.filename,
    stageUpAxis: introspection.stageUpAxis,
    jointCount: introspection.joints.length,
    joints: introspection.joints.map((joint) => ({
      name: joint.name,
      type: joint.type,
      axis: [...joint.axis],
      axisLocal: joint.axisLocal ? [...joint.axisLocal] : null,
      axisWorld: joint.axisWorld ? [...joint.axisWorld] : null,
      frame0Local: joint.frame0Local,
      frame1Local: joint.frame1Local,
      frame0World: joint.frame0World,
      frame1World: joint.frame1World,
      parentBody: joint.parentBody,
      childBody: joint.childBody,
      sourceUpAxis: joint.sourceUpAxis,
      normalizedToZUp: joint.normalizedToZUp,
      frameMismatchDistance: joint.frameMismatchDistance,
      frameMismatchWarning: joint.frameMismatchWarning,
      muscle: joint.muscle,
    })),
    rootBodies: [...introspection.rootBodies],
  };
};

// ---------------------------------------------------------------------------
// Build robot skeleton from introspection
// ---------------------------------------------------------------------------

export const buildRobotFromIntrospection = (introspection: NormalizedUsdIntrospection, robotName: string) => {
  const robotRoot = new THREE.Group();
  const robotRootFlagged = robotRoot as THREE.Group & { isRobot?: boolean };
  robotRoot.name = robotName;
  robotRootFlagged.isRobot = true;
  robotRoot.userData.editorRobotRoot = true;

  const bodyPathByToken = new Map<string, string>();
  for (const joint of introspection.joints) {
    const parentToken = normalizeBodyToken(joint.parentBody);
    const parentPath = normalizePathAliasToken(joint.parentBodyPath);
    if (parentToken && parentPath && !bodyPathByToken.has(parentToken)) bodyPathByToken.set(parentToken, parentPath);
    const childToken = normalizeBodyToken(joint.childBody);
    const childPath = normalizePathAliasToken(joint.childBodyPath);
    if (childToken && childPath && !bodyPathByToken.has(childToken)) bodyPathByToken.set(childToken, childPath);
  }

  const linksByName = new Map<string, THREE.Group>();
  const ensureLink = (rawName: string, bodyPathHint?: string | null) => {
    const key = (normalizeBodyToken(rawName) ?? rawName.trim()) || "link";
    const existing = linksByName.get(key);
    if (existing) return existing;
    const hintedBodyPath =
      normalizePathAliasToken(bodyPathHint) ??
      bodyPathByToken.get(key) ??
      null;
    const created = createPlaceholderLinkNode(key, hintedBodyPath);
    linksByName.set(key, created);
    return created;
  };

  const parentBodies = new Set<string>();
  const childBodies = new Set<string>();
  for (const joint of introspection.joints) {
    if (joint.parentBody) parentBodies.add(joint.parentBody);
    if (joint.childBody) childBodies.add(joint.childBody);
  }
  const explicitRootNames = introspection.rootBodies.filter(
    (name) => parentBodies.has(name) || childBodies.has(name)
  );
  const derivedRootNames = Array.from(parentBodies).filter((name) => !childBodies.has(name));
  const rootNames =
    explicitRootNames.length > 0
      ? explicitRootNames
      : derivedRootNames.length > 0
        ? derivedRootNames
        : introspection.rootBodies.length > 0
          ? introspection.rootBodies
          : ["base"];
  for (const rootName of rootNames) ensureLink(rootName);
  for (const joint of introspection.joints) {
    if (joint.parentBody) ensureLink(joint.parentBody, joint.parentBodyPath);
    if (joint.childBody) ensureLink(joint.childBody, joint.childBodyPath);
  }

  const attachedChildren = new Set<string>();
  const jointNames = new Set<string>();
  let jointCount = 0;

  for (const [index, joint] of introspection.joints.entries()) {
    const fallbackRootName = rootNames[0] ?? "base";
    const parentName =
      joint.parentBody ??
      (joint.childBody && fallbackRootName === joint.childBody
        ? `${joint.childBody}_root`
        : fallbackRootName);
    const childSeed = joint.childBody ?? `${joint.name || `joint_${index + 1}`}_link`;
    const childName = childSeed === parentName ? `${childSeed}_child` : childSeed;
    if (attachedChildren.has(childName)) continue;

    const parentLink = ensureLink(parentName, joint.parentBodyPath);
    const childLink = ensureLink(childName, joint.childBodyPath);

    const rawJointName = joint.name.trim() || `${parentName}_${childName}_joint`;
    const jointName = claimName(rawJointName, jointNames, "joint");
    const jointNode = new THREE.Group();
    const jointFlags = jointNode as THREE.Group & { isURDFJoint?: boolean; urdfName?: string };
    jointNode.name = jointName;
    jointFlags.isURDFJoint = true;
    jointFlags.urdfName = jointName;
    jointNode.userData.editorKind = "joint";

    const frame0Local =
      joint.frame0Local ??
      (joint.localPos0 && joint.localRot0 ? { position: joint.localPos0, quaternion: joint.localRot0 } : null);
    const frame1Local =
      joint.frame1Local ??
      (joint.localPos1 && joint.localRot1 ? { position: joint.localPos1, quaternion: joint.localRot1 } : null);
    const frame0Quat = frame0Local
      ? new THREE.Quaternion(
          frame0Local.quaternion[0],
          frame0Local.quaternion[1],
          frame0Local.quaternion[2],
          frame0Local.quaternion[3]
        )
      : new THREE.Quaternion();
    if (frame0Quat.lengthSq() <= 1e-9) frame0Quat.identity();
    else frame0Quat.normalize();
    const frame0Euler = new THREE.Euler().setFromQuaternion(frame0Quat, "ZYX");
    const origin = frame0Local
      ? {
          xyz: [frame0Local.position[0], frame0Local.position[1], frame0Local.position[2]] as [number, number, number],
          rpy: [frame0Euler.x, frame0Euler.y, frame0Euler.z] as [number, number, number],
        }
      : ({ xyz: [0, 0, 0], rpy: [0, 0, 0] } as Pose);
    const axisSource = joint.axisLocal ?? joint.axis;
    const axisLocal = axisInJointFrame(
      [axisSource[0], axisSource[1], axisSource[2]],
      frame0Local ? frame0Quat : null
    );
    const sourceFrames = {
      frame0Local: frame0Local ?? undefined,
      frame1Local: frame1Local ?? undefined,
      frame0World: joint.frame0World ?? undefined,
      frame1World: joint.frame1World ?? undefined,
      axisLocal: joint.axisLocal ?? undefined,
      axisWorld: joint.axisWorld ?? undefined,
      sourceUpAxis: joint.sourceUpAxis,
      normalizedToZUp: joint.normalizedToZUp,
      frameMismatchDistance: joint.frameMismatchDistance ?? undefined,
      frameMismatchWarning: joint.frameMismatchWarning ?? undefined,
    };
    const derivedMuscle = joint.muscle
      ? {
          enabled: joint.muscle.enabled,
          endA: {
            body: joint.muscle.endA.body ?? parentLink.name,
            localPos: [...joint.muscle.endA.localPos] as [number, number, number],
          },
          endB: {
            body: joint.muscle.endB.body ?? childLink.name,
            localPos: [...joint.muscle.endB.localPos] as [number, number, number],
          },
          range: joint.muscle.range ? ([...joint.muscle.range] as [number, number]) : ([0, 1] as [number, number]),
          force: Number.isFinite(joint.muscle.force) ? joint.muscle.force : 1,
          scale: Number.isFinite(joint.muscle.scale) ? joint.muscle.scale : 1,
          damping: Number.isFinite(joint.muscle.damping) ? joint.muscle.damping : 0,
          showLine: true,
          showTube: false,
        }
      : undefined;

    const urdfJoint: UrdfJoint = {
      name: jointName,
      type: joint.type === "revolute" || joint.type === "prismatic" || joint.type === "fixed" ? joint.type : "fixed",
      parent: parentLink.name,
      child: childLink.name,
      origin,
      axis: [axisLocal[0], axisLocal[1], axisLocal[2]],
      sourceFrames,
      actuator: derivedMuscle
        ? {
            enabled: false,
            type: "muscle",
          }
        : undefined,
      muscle: derivedMuscle,
    };
    jointNode.userData.urdf = { kind: "joint", joint: urdfJoint };

    parentLink.add(jointNode);
    jointNode.add(childLink);
    attachedChildren.add(childName);
    jointCount += 1;
  }

  for (const rootName of rootNames) {
    const link = linksByName.get(rootName);
    if (link && !link.parent) robotRoot.add(link);
  }

  for (const link of linksByName.values()) {
    if (!link.parent) robotRoot.add(link);
  }

  return {
    root: robotRoot,
    linkCount: linksByName.size,
    jointCount,
  };
};
