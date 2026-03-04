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
  /** RGBA color parsed from <material><color rgba="..."/> — only present on visual elements. */
  rgba?: [number, number, number, number];
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
    name?: string;
    sourceType?: string;
    type?: "position" | "velocity" | "torque" | "muscle";
  };
  sourceFrames?: {
    frame0Local?: { position: [number, number, number]; quaternion: [number, number, number, number] };
    frame1Local?: { position: [number, number, number]; quaternion: [number, number, number, number] };
    frame0World?: { position: [number, number, number]; quaternion: [number, number, number, number] };
    frame1World?: { position: [number, number, number]; quaternion: [number, number, number, number] };
    axisLocal?: [number, number, number];
    axisWorld?: [number, number, number];
    sourceUpAxis?: "X" | "Y" | "Z" | "unknown";
    normalizedToZUp?: boolean;
    frameMismatchDistance?: number;
    frameMismatchWarning?: string;
  };
  muscle?: {
    enabled?: boolean;
    endA: { body: string; localPos: [number, number, number] };
    endB: { body: string; localPos: [number, number, number] };
    range?: [number, number];
    force?: number;
    scale?: number;
    damping?: number;
    showLine?: boolean;
    showTube?: boolean;
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
type UrdfRgba = [number, number, number, number];

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

const parseBoolean = (value: string | null | undefined): boolean | undefined => {
  if (value === null || value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  return undefined;
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

function parseRgbaAttr(value: string | null | undefined): UrdfRgba | undefined {
  const parts = (value ?? "").trim().split(/\s+/).map(Number);
  if (parts.length < 3) return undefined;
  return [
    Number.isFinite(parts[0]) ? Math.max(0, Math.min(1, parts[0])) : 1,
    Number.isFinite(parts[1]) ? Math.max(0, Math.min(1, parts[1])) : 1,
    Number.isFinite(parts[2]) ? Math.max(0, Math.min(1, parts[2])) : 1,
    Number.isFinite(parts[3]) ? Math.max(0, Math.min(1, parts[3])) : 1,
  ];
}

function readMaterialColor(materialNode: Element | null): UrdfRgba | undefined {
  if (!materialNode) return undefined;
  const colorEl = materialNode.querySelector("color");
  if (!colorEl) return undefined;
  return parseRgbaAttr(colorEl.getAttribute("rgba"));
}

function extractRobotMaterialColors(robotEl: Element): Map<string, UrdfRgba> {
  const map = new Map<string, UrdfRgba>();
  for (const child of Array.from(robotEl.children)) {
    if (child.tagName.toLowerCase() !== "material") continue;
    const name = (child.getAttribute("name") ?? "").trim();
    if (!name) continue;
    const rgba = readMaterialColor(child);
    if (rgba) map.set(name, rgba);
  }
  return map;
}

function readVisualRgba(node: Element, materialMap: ReadonlyMap<string, UrdfRgba>): UrdfRgba | undefined {
  const materialEl = node.querySelector("material");
  const inline = readMaterialColor(materialEl);
  if (inline) return inline;
  const materialName = (materialEl?.getAttribute("name") ?? "").trim();
  if (!materialName) return undefined;
  return materialMap.get(materialName);
}

function readCollisions(
  link: Element,
  tagName: "collision" | "visual",
  materialMap: ReadonlyMap<string, UrdfRgba>
): UrdfCollision[] {
  const collisions: UrdfCollision[] = [];
  for (const node of Array.from(link.querySelectorAll(tagName))) {
    const origin = readPose(node.querySelector("origin"));
    const geom = readGeom(node.querySelector("geometry"));
    if (!geom) continue;
    const name = node.getAttribute("name") ?? undefined;
    const rgba = tagName === "visual" ? readVisualRgba(node, materialMap) : undefined;
    collisions.push({ name, origin, geom, rgba });
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
  const parseTuple = (value: string | null | undefined, size: number): number[] | undefined => {
    if (!value) return undefined;
    const parts = value
      .trim()
      .split(/\s+/)
      .map((item) => Number(item))
      .slice(0, size);
    if (parts.length !== size || parts.some((item) => !Number.isFinite(item))) return undefined;
    return parts;
  };
  const actuatorNode = node.querySelector("actuator");
  const actuatorTypeRaw = actuatorNode?.getAttribute("type")?.trim().toLowerCase();
  let actuatorType: "position" | "velocity" | "torque" | "muscle" | undefined;
  if (actuatorTypeRaw === "position" || actuatorTypeRaw === "velocity" || actuatorTypeRaw === "torque" || actuatorTypeRaw === "muscle") {
    actuatorType = actuatorTypeRaw;
  }
  const actuatorEnabled = parseBoolean(actuatorNode?.getAttribute("enabled"));
  const actuatorStiffness = parseNumber(actuatorNode?.getAttribute("stiffness"), undefined);
  const actuatorDamping = parseNumber(actuatorNode?.getAttribute("damping"), undefined);
  const actuatorInitialPosition = parseNumber(actuatorNode?.getAttribute("initialPosition"), undefined);
  const actuatorName = actuatorNode?.getAttribute("name")?.trim() || undefined;
  const actuatorSourceType = actuatorNode?.getAttribute("sourceType")?.trim() || undefined;
  const actuator =
    actuatorNode &&
    (actuatorEnabled !== undefined ||
      Number.isFinite(actuatorStiffness) ||
      Number.isFinite(actuatorDamping) ||
      Number.isFinite(actuatorInitialPosition) ||
      actuatorName ||
      actuatorSourceType ||
      actuatorType)
      ? {
          enabled: actuatorEnabled,
          stiffness: actuatorStiffness,
          damping: actuatorDamping,
          initialPosition: actuatorInitialPosition,
          name: actuatorName,
          sourceType: actuatorSourceType,
          type: actuatorType,
        }
      : undefined;
  const sourceFramesNode = node.querySelector("sourceFrames");
  const readFrame = (frameName: string) => {
    const frameNode = sourceFramesNode?.querySelector(frameName);
    const pos = parseTuple(frameNode?.getAttribute("position"), 3) as [number, number, number] | undefined;
    const quat = parseTuple(frameNode?.getAttribute("quaternion"), 4) as [number, number, number, number] | undefined;
    if (!pos || !quat) return undefined;
    return { position: pos, quaternion: quat };
  };
  const readAxis = (key: "axisLocal" | "axisWorld") => {
    const parsed = parseTuple(sourceFramesNode?.getAttribute(key), 3) as [number, number, number] | undefined;
    return parsed;
  };
  const sourceFrames =
    sourceFramesNode &&
    (
      readFrame("frame0Local") ||
      readFrame("frame1Local") ||
      readFrame("frame0World") ||
      readFrame("frame1World") ||
      readAxis("axisLocal") ||
      readAxis("axisWorld") ||
      sourceFramesNode.getAttribute("sourceUpAxis") ||
      sourceFramesNode.getAttribute("normalizedToZUp") ||
      sourceFramesNode.getAttribute("frameMismatchDistance") ||
      sourceFramesNode.getAttribute("frameMismatchWarning")
    )
      ? {
          frame0Local: readFrame("frame0Local"),
          frame1Local: readFrame("frame1Local"),
          frame0World: readFrame("frame0World"),
          frame1World: readFrame("frame1World"),
          axisLocal: readAxis("axisLocal"),
          axisWorld: readAxis("axisWorld"),
          sourceUpAxis:
            sourceFramesNode.getAttribute("sourceUpAxis") === "X" ||
            sourceFramesNode.getAttribute("sourceUpAxis") === "Y" ||
            sourceFramesNode.getAttribute("sourceUpAxis") === "Z" ||
            sourceFramesNode.getAttribute("sourceUpAxis") === "unknown"
              ? (sourceFramesNode.getAttribute("sourceUpAxis") as "X" | "Y" | "Z" | "unknown")
              : undefined,
          normalizedToZUp: parseBoolean(sourceFramesNode.getAttribute("normalizedToZUp")),
          frameMismatchDistance: parseNumber(sourceFramesNode.getAttribute("frameMismatchDistance"), undefined),
          frameMismatchWarning: sourceFramesNode.getAttribute("frameMismatchWarning") ?? undefined,
        }
      : undefined;
  const muscleNode = node.querySelector("muscle");
  const readMuscleEndpoint = (tagName: "endA" | "endB", fallbackBody: string) => {
    const endpointNode = muscleNode?.querySelector(tagName);
    const localPos = parseTuple(endpointNode?.getAttribute("localPos"), 3) as [number, number, number] | undefined;
    if (!localPos) return undefined;
    return {
      body: endpointNode?.getAttribute("body")?.trim() || fallbackBody,
      localPos,
    };
  };
  const muscleRange = parseTuple(muscleNode?.getAttribute("range"), 2) as [number, number] | undefined;
  const muscleEndA = readMuscleEndpoint("endA", parent);
  const muscleEndB = readMuscleEndpoint("endB", child);
  const muscle =
    muscleNode && muscleEndA && muscleEndB
      ? {
          enabled: parseBoolean(muscleNode.getAttribute("enabled")),
          endA: muscleEndA,
          endB: muscleEndB,
          range: muscleRange,
          force: parseNumber(muscleNode.getAttribute("force"), undefined),
          scale: parseNumber(muscleNode.getAttribute("scale"), undefined),
          damping: parseNumber(muscleNode.getAttribute("damping"), undefined),
          showLine: parseBoolean(muscleNode.getAttribute("showLine")),
          showTube: parseBoolean(muscleNode.getAttribute("showTube")),
        }
      : undefined;
  return { name, type, parent, child, origin, axis, limit, dynamics, actuator, sourceFrames, muscle };
}

export function parseUrdfElement(robotEl: Element | null): UrdfParseResult {
  if (!robotEl) {
    return { robot: null, warnings: ["No <robot> root found in URDF."] };
  }

  const robotName = robotEl.getAttribute("name") || "urdf_robot";
  const robotMaterialMap = extractRobotMaterialColors(robotEl);

  const links = new Map<string, UrdfLink>();
  for (const link of Array.from(robotEl.querySelectorAll("link"))) {
    const name = link.getAttribute("name");
    if (!name) continue;
    const inertial = readInertial(link);
    const collisions = readCollisions(link, "collision", robotMaterialMap);
    const visuals = readCollisions(link, "visual", robotMaterialMap);
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
