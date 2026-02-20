export type Pose = { xyz: [number, number, number]; rpy: [number, number, number] };

export type UrdfGeom =
  | { kind: "box"; size: [number, number, number] }
  | { kind: "sphere"; radius: number }
  | { kind: "cylinder"; radius: number; length: number }
  | { kind: "mesh"; file: string; scale: [number, number, number] };

export type UrdfCollision = {
  name?: string;
  origin: Pose;
  geom: UrdfGeom;
};

export type UrdfInertia = {
  ixx: number;
  iyy: number;
  izz: number;
  ixy: number;
  ixz: number;
  iyz: number;
};

export type UrdfInertial = {
  origin: Pose;
  mass: number;
  inertia: UrdfInertia;
};

export type UrdfLink = {
  name: string;
  inertial?: UrdfInertial;
  collisions: UrdfCollision[];
  visuals: UrdfCollision[];
  // Editor-only offset used to preserve child-link world pose while moving parent joints.
  // This is not part of URDF and is folded into exported poses.
  editorOffset?: Pose;
};

export type UrdfJoint = {
  name: string;
  type: string;
  parent: string;
  child: string;
  origin: Pose;
  axis: [number, number, number];
  limit?: { lower?: number; upper?: number; effort?: number; velocity?: number };
  dynamics?: { damping?: number; friction?: number; armature?: number };
  actuator?: {
    enabled?: boolean;
    stiffness?: number;
    damping?: number;
    initialPosition?: number;
    type?: "position" | "velocity" | "torque";
  };
};

export type UrdfRobot = {
  name: string;
  links: Map<string, UrdfLink>;
  joints: UrdfJoint[];
};

export type UrdfInstance =
  | { kind: "link"; link: UrdfLink }
  | { kind: "joint"; joint: UrdfJoint };

export type UrdfParseResult = { robot: UrdfRobot | null; warnings: string[] };

const defaultPose = (): Pose => ({ xyz: [0, 0, 0], rpy: [0, 0, 0] });

const parseVector = (value: string | null | undefined, fallback: [number, number, number]) => {
  if (!value) return fallback;
  const parts = value.trim().split(/\s+/).map((v) => Number(v));
  return [
    Number.isFinite(parts[0]) ? parts[0] : fallback[0],
    Number.isFinite(parts[1]) ? parts[1] : fallback[1],
    Number.isFinite(parts[2]) ? parts[2] : fallback[2],
  ] as [number, number, number];
};

const parseNumber = (value: string | null | undefined, fallback?: number): number | undefined => {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

function readPose(node: Element | null): Pose {
  if (!node) return defaultPose();
  const xyz = parseVector(node.getAttribute("xyz"), [0, 0, 0]);
  const rpy = parseVector(node.getAttribute("rpy"), [0, 0, 0]);
  return { xyz, rpy };
}

function readInertial(link: Element): UrdfInertial | undefined {
  const inertial = link.querySelector("inertial");
  if (!inertial) return undefined;
  const origin = readPose(inertial.querySelector("origin"));
  const mass = parseNumber(inertial.querySelector("mass")?.getAttribute("value"), 0) ?? 0;
  const inertiaNode = inertial.querySelector("inertia");
  const inertia = {
    ixx: parseNumber(inertiaNode?.getAttribute("ixx"), 0) ?? 0,
    iyy: parseNumber(inertiaNode?.getAttribute("iyy"), 0) ?? 0,
    izz: parseNumber(inertiaNode?.getAttribute("izz"), 0) ?? 0,
    ixy: parseNumber(inertiaNode?.getAttribute("ixy"), 0) ?? 0,
    ixz: parseNumber(inertiaNode?.getAttribute("ixz"), 0) ?? 0,
    iyz: parseNumber(inertiaNode?.getAttribute("iyz"), 0) ?? 0,
  };
  return { origin, mass, inertia };
}

function readGeom(node: Element | null): UrdfGeom | null {
  if (!node) return null;
  const box = node.querySelector("box");
  if (box) {
    const size = parseVector(box.getAttribute("size"), [1, 1, 1]);
    return { kind: "box", size };
  }
  const sphere = node.querySelector("sphere");
  if (sphere) {
    const radius = parseNumber(sphere.getAttribute("radius"), 0.5) ?? 0.5;
    return { kind: "sphere", radius };
  }
  const cylinder = node.querySelector("cylinder");
  if (cylinder) {
    const radius = parseNumber(cylinder.getAttribute("radius"), 0.5) ?? 0.5;
    const length = parseNumber(cylinder.getAttribute("length"), 1) ?? 1;
    return { kind: "cylinder", radius, length };
  }
  const mesh = node.querySelector("mesh");
  if (mesh) {
    const filename = mesh.getAttribute("filename") ?? "";
    const scale = parseVector(mesh.getAttribute("scale"), [1, 1, 1]);
    return { kind: "mesh", file: filename, scale };
  }
  return null;
}

function readCollisions(link: Element, tagName: "collision" | "visual"): UrdfCollision[] {
  const collisions: UrdfCollision[] = [];
  for (const node of Array.from(link.querySelectorAll(tagName))) {
    const origin = readPose(node.querySelector("origin"));
    const geom = readGeom(node.querySelector("geometry"));
    if (!geom) continue;
    const name = node.getAttribute("name") ?? undefined;
    collisions.push({ name, origin, geom });
  }
  return collisions;
}

function readJoint(node: Element): UrdfJoint | null {
  const name = node.getAttribute("name");
  const type = node.getAttribute("type");
  const parent = node.querySelector("parent")?.getAttribute("link");
  const child = node.querySelector("child")?.getAttribute("link");
  if (!name || !type || !parent || !child) return null;
  const origin = readPose(node.querySelector("origin"));
  const axis = parseVector(node.querySelector("axis")?.getAttribute("xyz"), [1, 0, 0]);
  const limitNode = node.querySelector("limit");
  const limit =
    limitNode &&
    (limitNode.getAttribute("lower") ||
      limitNode.getAttribute("upper") ||
      limitNode.getAttribute("effort") ||
      limitNode.getAttribute("velocity"))
      ? {
          lower: parseNumber(limitNode.getAttribute("lower"), undefined),
          upper: parseNumber(limitNode.getAttribute("upper"), undefined),
          effort: parseNumber(limitNode.getAttribute("effort"), undefined),
          velocity: parseNumber(limitNode.getAttribute("velocity"), undefined),
        }
      : undefined;
  const dynamicsNode = node.querySelector("dynamics");
  const dynamics =
    dynamicsNode &&
    (dynamicsNode.getAttribute("damping") ||
      dynamicsNode.getAttribute("friction") ||
      dynamicsNode.getAttribute("armature"))
      ? {
          damping: parseNumber(dynamicsNode.getAttribute("damping"), undefined),
          friction: parseNumber(dynamicsNode.getAttribute("friction"), undefined),
          armature: parseNumber(dynamicsNode.getAttribute("armature"), undefined),
        }
      : undefined;
  return { name, type, parent, child, origin, axis, limit, dynamics };
}

export function parseUrdfElement(robotEl: Element | null): UrdfParseResult {
  if (!robotEl) {
    return { robot: null, warnings: ["No <robot> root found in URDF."] };
  }

  const robotName = robotEl.getAttribute("name") || "urdf_robot";

  const links = new Map<string, UrdfLink>();
  for (const link of Array.from(robotEl.querySelectorAll("link"))) {
    const name = link.getAttribute("name");
    if (!name) continue;
    const inertial = readInertial(link);
    const collisions = readCollisions(link, "collision");
    const visuals = readCollisions(link, "visual");
    links.set(name, { name, inertial, collisions, visuals });
  }

  const joints: UrdfJoint[] = [];
  for (const jointEl of Array.from(robotEl.querySelectorAll("joint"))) {
    const joint = readJoint(jointEl);
    if (joint) joints.push(joint);
  }

  return { robot: { name: robotName, links, joints }, warnings: [] };
}

export function parseUrdfString(urdf: string): UrdfParseResult {
  const parser = new DOMParser();
  const doc = parser.parseFromString(urdf, "application/xml");
  if (doc.querySelector("parsererror")) {
    return { robot: null, warnings: ["Failed to parse URDF XML."] };
  }

  const robotEl = doc.querySelector("robot");
  return parseUrdfElement(robotEl);
}
