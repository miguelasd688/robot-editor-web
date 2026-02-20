import * as THREE from "three";
import { basename, resolveAssetKey } from "../../loaders/assetResolver";
import { parseUrdfString, type UrdfCollision, type UrdfJoint } from "../../urdf/urdfModel";
import { NameRegistry, sanitizeMjcfName } from "./mjcfNames";
import { logDebug } from "../../services/logger";
import type { UrdfToMjcfOptions, UrdfToMjcfResult } from "./urdfToMjcfTypes";

const formatVec = (v: [number, number, number], digits = 6) =>
  v.map((n) => (Number.isFinite(n) ? n : 0).toFixed(digits)).join(" ");

const formatQuat = (q: THREE.Quaternion, digits = 6) =>
  `${(Number.isFinite(q.w) ? q.w : 1).toFixed(digits)} ${(Number.isFinite(q.x) ? q.x : 0).toFixed(
    digits
  )} ${(Number.isFinite(q.y) ? q.y : 0).toFixed(digits)} ${(Number.isFinite(q.z) ? q.z : 0).toFixed(
    digits
  )}`;

const quatFromRpy = (rpy: [number, number, number]) => {
  const euler = new THREE.Euler(rpy[0], rpy[1], rpy[2], "ZYX");
  const q = new THREE.Quaternion();
  q.setFromEuler(euler);
  return q;
};

const hasXacro = (urdf: string) => /<\s*xacro:/i.test(urdf);

const normalizeAxis = (
  axis: [number, number, number],
  jointName: string,
  warn: (message: string) => void
): [number, number, number] => {
  const ax = Number.isFinite(axis[0]) ? axis[0] : 0;
  const ay = Number.isFinite(axis[1]) ? axis[1] : 0;
  const az = Number.isFinite(axis[2]) ? axis[2] : 0;
  const len = Math.hypot(ax, ay, az);
  if (!Number.isFinite(len) || len < 1e-6) {
    warn(`Joint '${jointName}' has invalid axis; defaulting to 1 0 0.`);
    return [1, 0, 0];
  }
  return [ax / len, ay / len, az / len];
};

type FallbackInertial = {
  mass: number;
  inertia: { x: number; y: number; z: number };
};

const DEFAULT_DENSITY = 500;
const MIN_MASS = 0.01;
const MIN_INERTIA = 1e-9;
const DEFAULT_CONTACT_SOLREF = String(import.meta.env.VITE_MUJOCO_CONTACT_SOLREF ?? "0.02 1.2");
const DEFAULT_CONTACT_SOLIMP = String(import.meta.env.VITE_MUJOCO_CONTACT_SOLIMP ?? "0.9 0.95 0.001");

const estimateFallbackInertial = (geoms: UrdfCollision[], fallbackRadius: number): FallbackInertial => {
  const fallbackMass = MIN_MASS;
  const fallbackInertia = { x: MIN_INERTIA, y: MIN_INERTIA, z: MIN_INERTIA };
  if (!geoms.length) return { mass: fallbackMass, inertia: fallbackInertia };

  let bestVolume = -1;
  let best: FallbackInertial | null = null;

  for (const entry of geoms) {
    const geom = entry.geom;

    if (geom.kind === "box") {
      const sx = Math.max(1e-6, geom.size[0]);
      const sy = Math.max(1e-6, geom.size[1]);
      const sz = Math.max(1e-6, geom.size[2]);
      const volume = sx * sy * sz;
      const mass = Math.max(MIN_MASS, volume * DEFAULT_DENSITY);
      const ixx = (mass / 12) * (sy * sy + sz * sz);
      const iyy = (mass / 12) * (sx * sx + sz * sz);
      const izz = (mass / 12) * (sx * sx + sy * sy);
      if (volume > bestVolume) {
        bestVolume = volume;
        best = {
          mass,
          inertia: {
            x: Math.max(MIN_INERTIA, ixx),
            y: Math.max(MIN_INERTIA, iyy),
            z: Math.max(MIN_INERTIA, izz),
          },
        };
      }
      continue;
    }

    if (geom.kind === "sphere") {
      const r = Math.max(1e-6, geom.radius);
      const volume = (4 / 3) * Math.PI * r * r * r;
      const mass = Math.max(MIN_MASS, volume * DEFAULT_DENSITY);
      const inertiaVal = 0.4 * mass * r * r;
      if (volume > bestVolume) {
        bestVolume = volume;
        best = {
          mass,
          inertia: {
            x: Math.max(MIN_INERTIA, inertiaVal),
            y: Math.max(MIN_INERTIA, inertiaVal),
            z: Math.max(MIN_INERTIA, inertiaVal),
          },
        };
      }
      continue;
    }

    if (geom.kind === "cylinder") {
      const r = Math.max(1e-6, geom.radius);
      const h = Math.max(1e-6, geom.length);
      const volume = Math.PI * r * r * h;
      const mass = Math.max(MIN_MASS, volume * DEFAULT_DENSITY);
      const ixx = (mass / 12) * (3 * r * r + h * h);
      const iyy = ixx;
      const izz = 0.5 * mass * r * r;
      if (volume > bestVolume) {
        bestVolume = volume;
        best = {
          mass,
          inertia: {
            x: Math.max(MIN_INERTIA, ixx),
            y: Math.max(MIN_INERTIA, iyy),
            z: Math.max(MIN_INERTIA, izz),
          },
        };
      }
      continue;
    }

    if (geom.kind === "mesh") {
      const scale = geom.scale ?? [1, 1, 1];
      const scaleMax = Math.max(1e-6, Math.abs(scale[0]), Math.abs(scale[1]), Math.abs(scale[2]));
      const r = Math.max(1e-6, fallbackRadius * scaleMax);
      const volume = (4 / 3) * Math.PI * r * r * r;
      const mass = Math.max(MIN_MASS, volume * DEFAULT_DENSITY);
      const inertiaVal = 0.4 * mass * r * r;
      if (volume > bestVolume) {
        bestVolume = volume;
        best = {
          mass,
          inertia: {
            x: Math.max(MIN_INERTIA, inertiaVal),
            y: Math.max(MIN_INERTIA, inertiaVal),
            z: Math.max(MIN_INERTIA, inertiaVal),
          },
        };
      }
    }
  }

  return best ?? { mass: fallbackMass, inertia: fallbackInertia };
};

export function convertUrdfToMjcf(options: UrdfToMjcfOptions): UrdfToMjcfResult {
  const { urdf, assets, baseKey, remap, rootFreeJoint = true } = options;
  const warnings: string[] = [];
  const meshMode = options.meshMode ?? "mesh";
  const warn = (message: string) => warnings.push(message);
  // When the user requests a fixed base, we still add a root freejoint and weld it to the world.
  // This avoids root-link special cases and keeps kinematics consistent across robots.
  const fixedBaseWeld = rootFreeJoint === false;
  // MuJoCo equality constraints are soft by default; tune weld params to behave like a rigid attachment.
  const fixedBaseWeldSolref = "0.001 1";
  const fixedBaseWeldSolimp = "0.999 0.9999 0.001 0.5 2";
  const debug = options.debug === true;
  const forceDiagonalInertia = options.forceDiagonalInertia === true;
  const selfCollision = options.selfCollision === true;
  const defaultJointDamping =
    typeof options.defaultJointDamping === "number" && Number.isFinite(options.defaultJointDamping)
      ? options.defaultJointDamping
      : null;
  const defaultJointFriction =
    typeof options.defaultJointFriction === "number" && Number.isFinite(options.defaultJointFriction)
      ? options.defaultJointFriction
      : null;
  const defaultJointArmature =
    typeof options.defaultJointArmature === "number" && Number.isFinite(options.defaultJointArmature)
      ? options.defaultJointArmature
      : null;
  const defaultGeomFriction =
    typeof options.defaultGeomFriction === "number" && Number.isFinite(options.defaultGeomFriction)
      ? options.defaultGeomFriction
      : null;
  const geomFrictionByLink = options.geomFrictionByLink ?? null;
  const rootTransform = options.rootTransform ?? null;
  const meshBounds = options.meshBounds ?? null;
  const debugLog = (message: string, data?: unknown) => {
    if (debug) logDebug(message, { scope: "mujoco", data });
  };
  if (meshMode === "mesh") {
    warn("Mesh collisions enabled. Prefer convex/clean meshes for stable contacts and performance.");
  }

  if (options.warnOnXacro !== false && hasXacro(urdf)) {
    warnings.push("URDF contains xacro tags; ensure the file is fully expanded before simulation.");
  }

  const parsed = parseUrdfString(urdf);
  warnings.push(...parsed.warnings);
  if (!parsed.robot) {
    return { xml: "", warnings, nameMap: { links: {}, joints: {} } };
  }

  const namePrefix = options.namePrefix ? sanitizeMjcfName(options.namePrefix) : "";
  const withPrefix = (raw: string) => (namePrefix ? `${namePrefix}_${raw}` : raw);
  const robotName = parsed.robot.name;
  const links = new Map(parsed.robot.links);
  let joints = parsed.robot.joints.slice();

  const computeRootLinks = (linkMap: Map<string, unknown>, jointList: UrdfJoint[]) => {
    const children = new Set(jointList.map((joint) => joint.child));
    return Array.from(linkMap.keys()).filter((name) => !children.has(name));
  };

  if (options.firstLinkIsWorldReferenceFrame) {
    const rootLinksBefore = computeRootLinks(links, joints);
    const worldLink = rootLinksBefore[0] ?? null;
    if (!worldLink) {
      warnings.push("First-link world reference flag enabled but no root link was detected; keeping URDF unchanged.");
    } else {
      const rootJoints = joints.filter((joint) => joint.parent === worldLink);
      if (rootJoints.length === 0) {
        warnings.push(
          `First-link world reference flag enabled but root link '${worldLink}' has no outgoing joints; keeping URDF unchanged.`
        );
      } else {
        warnings.push(`Ignoring root link '${worldLink}' as world reference frame (and its outgoing joints).`);
        links.delete(worldLink);
        joints = joints.filter((joint) => joint.parent !== worldLink);
      }
    }
  }

  for (const joint of joints) {
    if (joint.type === "planar") {
      warnings.push(`Joint '${joint.name}' is planar; converting to 1-DOF slide as a fallback.`);
    }
  }

  const childToJoint = new Map<string, UrdfJoint>();
  const childrenByParent = new Map<string, string[]>();
  for (const joint of joints) {
    childToJoint.set(joint.child, joint);
    const list = childrenByParent.get(joint.parent) ?? [];
    list.push(joint.child);
    childrenByParent.set(joint.parent, list);
  }

  const rootLinks = computeRootLinks(links, joints);

  const nameMap: UrdfToMjcfResult["nameMap"] = { links: {}, joints: {}, linksByMjcf: {}, jointsByMjcf: {} };
  const linkNames = new NameRegistry("link", warn, "link");
  const jointNames = new NameRegistry("joint", warn, "joint");
  for (const name of links.keys()) {
    const claimed = linkNames.claim(withPrefix(name));
    nameMap.links[name] = claimed;
    nameMap.linksByMjcf![claimed] = name;
  }
  for (const joint of joints) {
    const claimed = jointNames.claim(withPrefix(joint.name));
    nameMap.joints[joint.name] = claimed;
    nameMap.jointsByMjcf![claimed] = joint.name;
  }

  const rootBodyNames = rootLinks.map((name) => nameMap.links[name] ?? sanitizeMjcfName(withPrefix(name)));

  debugLog("parsed", {
    robot: robotName,
    links: links.size,
    joints: joints.length,
    rootLinks,
  });

  const meshAssets: Array<{ name: string; file: string; scale: [number, number, number] }> = [];
  const meshMap = new Map<string, string>();

  const resolveMeshFile = (raw: string): string | null => {
    const key = resolveAssetKey(assets, raw, baseKey);
    if (!key) return null;
    const mapped = remap?.[key] ?? key;
    return mapped;
  };

  const resolveMeshBounds = (raw: string, scale: [number, number, number]) => {
    if (!meshBounds) return null;
    const key = resolveMeshFile(raw);
    if (!key) return null;
    const bounds = meshBounds[key];
    if (!bounds) return null;
    const sx = Math.max(1e-6, Math.abs(scale[0] ?? 1));
    const sy = Math.max(1e-6, Math.abs(scale[1] ?? 1));
    const sz = Math.max(1e-6, Math.abs(scale[2] ?? 1));
    return {
      size: [bounds.size[0] * sx, bounds.size[1] * sy, bounds.size[2] * sz] as [number, number, number],
      radius: bounds.radius * Math.max(sx, sy, sz),
      center: [bounds.center[0] * sx, bounds.center[1] * sy, bounds.center[2] * sz] as [number, number, number],
    };
  };

  const classifyFastShape = (size: [number, number, number]) => {
    const dims = size.map((v) => Math.max(1e-6, Math.abs(v)));
    const indexed = dims.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const small = indexed[0];
    const mid = indexed[1];
    const large = indexed[2];
    const similar = (a: number, b: number) => Math.abs(a - b) / Math.max(a, b) < 0.2;

    if (similar(mid.v, large.v) && mid.v / small.v > 1.6) {
      return { type: "cylinder" as const, axisIndex: small.i };
    }
    if (similar(mid.v, small.v) && large.v / mid.v > 1.6) {
      return { type: "cylinder" as const, axisIndex: large.i };
    }
    return { type: "box" as const, axisIndex: 1 };
  };

  const cylinderAxisRotation = (axisIndex: number) => {
    if (axisIndex === 2) return null;
    if (axisIndex === 0) return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    if (axisIndex === 1) return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    return null;
  };

  const getMeshName = (file: string, scale: [number, number, number]) => {
    const base = sanitizeMjcfName(basename(file));
    const sig = `${namePrefix}|${base}|${scale.join(",")}`;
    if (meshMap.has(sig)) return meshMap.get(sig) as string;
    const name = namePrefix ? `${namePrefix}_${base}_${meshMap.size}` : `${base}_${meshMap.size}`;
    meshMap.set(sig, name);
    meshAssets.push({ name, file, scale });
    return name;
  };

  const lines: string[] = [];
  const worldLines: string[] = [];
  const modelName = sanitizeMjcfName(withPrefix(robotName));
  const contactSolref = DEFAULT_CONTACT_SOLREF.trim();
  const contactSolimp = DEFAULT_CONTACT_SOLIMP.trim();
  const contactAttr = `${contactSolref ? ` solref="${contactSolref}"` : ""}${contactSolimp ? ` solimp="${contactSolimp}"` : ""}`;
  lines.push(`<mujoco model="${modelName}">`);
  lines.push(`  <compiler angle="radian" inertiafromgeom="false" meshdir="/working" />`);
  lines.push(`  <option gravity="0 -9.81 0" integrator="implicitfast" timestep="0.002" iterations="80" />`);

  const rootOffset = rootTransform
    ? {
        pos: new THREE.Vector3(rootTransform.position[0], rootTransform.position[1], rootTransform.position[2]),
        quat: new THREE.Quaternion(
          rootTransform.quaternion[0],
          rootTransform.quaternion[1],
          rootTransform.quaternion[2],
          rootTransform.quaternion[3]
        ).normalize(),
      }
    : null;

  const buildBody = (linkName: string, indent: number, isRoot: boolean) => {
    const link = links.get(linkName);
    if (!link) return;
    const mjcfLinkName = nameMap.links[linkName] ?? sanitizeMjcfName(linkName);
    const joint = childToJoint.get(linkName);
    const bodyPos: [number, number, number] = joint ? joint.origin.xyz : [0, 0, 0];
    const bodyQuat = joint ? quatFromRpy(joint.origin.rpy) : new THREE.Quaternion();
    const pad = " ".repeat(indent);

    let posVec = new THREE.Vector3(bodyPos[0], bodyPos[1], bodyPos[2]);
    let quat = bodyQuat;
    if (isRoot && rootOffset) {
      posVec = posVec.applyQuaternion(rootOffset.quat).add(rootOffset.pos);
      quat = rootOffset.quat.clone().multiply(bodyQuat);
    }

    const bodyAttr = `name="${mjcfLinkName}" pos="${formatVec([posVec.x, posVec.y, posVec.z])}" quat="${formatQuat(quat)}"`;
    worldLines.push(`${pad}<body ${bodyAttr}>`);

    if (isRoot && (rootFreeJoint || fixedBaseWeld)) {
      worldLines.push(`${pad}  <freejoint />`);
    }

    if (joint && joint.type !== "fixed") {
      if (joint.type === "floating") {
        worldLines.push(`${pad}  <freejoint />`);
      } else {
        const jointName = nameMap.joints[joint.name] ?? sanitizeMjcfName(joint.name);
        let type = "hinge";
        if (joint.type === "prismatic") type = "slide";
        if (joint.type === "planar") type = "slide";
        const axis = formatVec(normalizeAxis(joint.axis, joint.name, warn));
        const attrs: string[] = [`name="${jointName}"`, `type="${type}"`, `axis="${axis}"`];
        if (joint.limit && joint.type !== "continuous") {
          const lower = joint.limit.lower;
          const upper = joint.limit.upper;
          if (Number.isFinite(lower) && Number.isFinite(upper)) {
            attrs.push(`limited="true"`);
            attrs.push(`range="${Number(lower).toFixed(6)} ${Number(upper).toFixed(6)}"`);
          }
        }
        if (joint.dynamics?.damping !== undefined) {
          attrs.push(`damping="${Number(joint.dynamics.damping).toFixed(6)}"`);
        } else if (defaultJointDamping !== null) {
          attrs.push(`damping="${Number(defaultJointDamping).toFixed(6)}"`);
          debugLog("default joint damping", { joint: joint.name, value: defaultJointDamping });
        }
        if (joint.dynamics?.friction !== undefined) {
          attrs.push(`frictionloss="${Number(joint.dynamics.friction).toFixed(6)}"`);
        } else if (defaultJointFriction !== null) {
          attrs.push(`frictionloss="${Number(defaultJointFriction).toFixed(6)}"`);
          debugLog("default joint friction", { joint: joint.name, value: defaultJointFriction });
        }
        if (joint.dynamics?.armature !== undefined) {
          attrs.push(`armature="${Number(joint.dynamics.armature).toFixed(6)}"`);
        } else if (defaultJointArmature !== null) {
          attrs.push(`armature="${Number(defaultJointArmature).toFixed(6)}"`);
          debugLog("default joint armature", { joint: joint.name, value: defaultJointArmature });
        }
        worldLines.push(`${pad}  <joint ${attrs.join(" ")} />`);
      }
    }

    const geoms = link.collisions.length ? link.collisions : link.visuals;
    const fallbackRadius = (() => {
      if (meshMode === "mesh") return null;
      const inertial = link.inertial;
      if (!inertial || inertial.mass <= 0) return 0.05;
      const ixx = Math.abs(inertial.inertia.ixx);
      const iyy = Math.abs(inertial.inertia.iyy);
      const izz = Math.abs(inertial.inertia.izz);
      const mean = (ixx + iyy + izz) / 3;
      const r = Math.sqrt(Math.max(1e-9, mean) / (0.4 * Math.max(1e-6, inertial.mass)));
      return Number.isFinite(r) ? Math.max(0.01, r) : 0.05;
    })();

    const fallbackInertial =
      link.inertial && link.inertial.mass > 0
        ? null
        : estimateFallbackInertial(geoms, fallbackRadius ?? 0.05);

    if (link.inertial && link.inertial.mass > 0) {
      const inertia = link.inertial.inertia;
      const pos = formatVec(link.inertial.origin.xyz);
      const quat = formatQuat(quatFromRpy(link.inertial.origin.rpy));
      const hasOffDiag = Math.abs(inertia.ixy) > 0 || Math.abs(inertia.ixz) > 0 || Math.abs(inertia.iyz) > 0;
      const ixx = inertia.ixx;
      const iyy = inertia.iyy;
      const izz = inertia.izz;
      const ixy = inertia.ixy;
      const ixz = inertia.ixz;
      const iyz = inertia.iyz;
      const positiveDefinite = (() => {
        if (!(ixx > 0 && iyy > 0 && izz > 0)) return false;
        const minor2 = ixx * iyy - ixy * ixy;
        if (minor2 <= 0) return false;
        const det =
          ixx * (iyy * izz - iyz * iyz) -
          ixy * (ixy * izz - iyz * ixz) +
          ixz * (ixy * iyz - iyy * ixz);
        return det > 0;
      })();
      let inertiaAttr = `diaginertia="${Math.max(1e-9, Math.abs(ixx)).toFixed(6)} ${Math.max(1e-9, Math.abs(iyy)).toFixed(6)} ${Math.max(1e-9, Math.abs(izz)).toFixed(6)}"`;
      if (!forceDiagonalInertia && hasOffDiag && positiveDefinite) {
        inertiaAttr = `fullinertia="${ixx.toFixed(6)} ${iyy.toFixed(6)} ${izz.toFixed(6)} ${ixy.toFixed(6)} ${ixz.toFixed(6)} ${iyz.toFixed(6)}"`;
      } else if (hasOffDiag && !positiveDefinite) {
        warnings.push(`Inertia for link '${link.name}' is not positive definite; using diagonal only.`);
      } else if (hasOffDiag && forceDiagonalInertia) {
        warnings.push(`Inertia for link '${link.name}' forced to diagonal only (debug mode).`);
      }
      worldLines.push(
        `${pad}  <inertial pos="${pos}" quat="${quat}" mass="${link.inertial.mass.toFixed(6)}" ${inertiaAttr} />`
      );
    } else if (fallbackInertial) {
      if (joint && joint.type !== "fixed") {
        warn(`Link '${link.name}' missing inertial; using fallback mass/inertia.`);
      }
      debugLog("fallback inertial", {
        link: link.name,
        mass: fallbackInertial.mass,
        inertia: fallbackInertial.inertia,
      });
      worldLines.push(
        `${pad}  <inertial pos="0 0 0" quat="1 0 0 0" mass="${fallbackInertial.mass.toFixed(
          6
        )}" diaginertia="${fallbackInertial.inertia.x.toFixed(6)} ${fallbackInertial.inertia.y.toFixed(
          6
        )} ${fallbackInertial.inertia.z.toFixed(6)}" />`
      );
    }
    for (let i = 0; i < geoms.length; i += 1) {
      const { origin, geom } = geoms[i];
      const basePosVec = new THREE.Vector3(origin.xyz[0], origin.xyz[1], origin.xyz[2]);
      const pos = formatVec(origin.xyz);
      const baseQuat = quatFromRpy(origin.rpy);
      const quat = formatQuat(baseQuat);
      const geomName = `${mjcfLinkName}_${i}_geom`;
      const collisionAttr = selfCollision ? "" : ` contype="1" conaffinity="2"`;
      const rawFriction =
        geomFrictionByLink && Number.isFinite(geomFrictionByLink[link.name])
          ? geomFrictionByLink[link.name]
          : defaultGeomFriction;
      const frictionValue = Number(rawFriction);
      const frictionAttr =
        rawFriction !== null
          ? ` friction="${Math.max(0, Number.isFinite(frictionValue) ? frictionValue : 0.5).toFixed(6)} 0.005 0.0001"${contactAttr}`
          : "";
      if (geom.kind === "box") {
        const hx = geom.size[0] / 2;
        const hy = geom.size[1] / 2;
        const hz = geom.size[2] / 2;
        worldLines.push(
          `${pad}  <geom name="${geomName}" type="box" pos="${pos}" quat="${quat}" size="${hx.toFixed(6)} ${hy.toFixed(6)} ${hz.toFixed(6)}"${collisionAttr}${frictionAttr} />`
        );
      } else if (geom.kind === "sphere") {
        worldLines.push(
          `${pad}  <geom name="${geomName}" type="sphere" pos="${pos}" quat="${quat}" size="${geom.radius.toFixed(6)}"${collisionAttr}${frictionAttr} />`
        );
      } else if (geom.kind === "cylinder") {
        const half = geom.length / 2;
        worldLines.push(
          `${pad}  <geom name="${geomName}" type="cylinder" pos="${pos}" quat="${quat}" size="${geom.radius.toFixed(6)} ${half.toFixed(6)}"${collisionAttr}${frictionAttr} />`
        );
      } else if (geom.kind === "mesh") {
        if (meshMode === "mesh") {
          const file = resolveMeshFile(geom.file);
          if (!file) {
            warnings.push(`Mesh not found for ${geom.file}`);
            continue;
          }
          const meshName = getMeshName(file, geom.scale);
          worldLines.push(
            `${pad}  <geom name="${geomName}" type="mesh" pos="${pos}" quat="${quat}" mesh="${meshName}"${collisionAttr}${frictionAttr} />`
          );
        } else {
          const scale = geom.scale ?? [1, 1, 1];
          const bounds = resolveMeshBounds(geom.file, scale);
          const size = bounds?.size ?? null;
          const radius = bounds?.radius ?? fallbackRadius ?? 0.05;
          const center = bounds?.center ?? null;
          const offset = center
            ? new THREE.Vector3(center[0], center[1], center[2]).applyQuaternion(baseQuat)
            : null;
          const proxyPosVec = offset ? basePosVec.clone().add(offset) : basePosVec;
          const proxyPos = formatVec([proxyPosVec.x, proxyPosVec.y, proxyPosVec.z]);

          let proxyMode = meshMode;
          let axisIndex = 1;
          if (meshMode === "fast" && size) {
            const classification = classifyFastShape(size);
            proxyMode = classification.type;
            axisIndex = classification.axisIndex;
          }

          if (proxyMode === "box") {
            const hx = size ? Math.max(1e-6, size[0] / 2) : radius;
            const hy = size ? Math.max(1e-6, size[1] / 2) : radius;
            const hz = size ? Math.max(1e-6, size[2] / 2) : radius;
            worldLines.push(
              `${pad}  <geom name="${geomName}" type="box" pos="${proxyPos}" quat="${quat}" size="${hx.toFixed(
                6
              )} ${hy.toFixed(6)} ${hz.toFixed(6)}"${collisionAttr}${frictionAttr} />`
            );
          } else if (proxyMode === "cylinder") {
            const dims = size ?? [radius * 2, radius * 2, radius * 2];
            if (meshMode !== "fast") {
              axisIndex =
                dims[0] <= dims[1] && dims[0] <= dims[2] ? 0 : dims[1] <= dims[2] ? 1 : 2;
            }
            const other = [0, 1, 2].filter((idx) => idx !== axisIndex);
            const cylRadius = Math.max(1e-6, Math.max(dims[other[0]], dims[other[1]]) / 2);
            const cylHalf = Math.max(1e-6, dims[axisIndex] / 2);
            const extra = cylinderAxisRotation(axisIndex);
            const proxyQuat = extra ? baseQuat.clone().multiply(extra) : baseQuat;
            const proxyQuatStr = formatQuat(proxyQuat);
            worldLines.push(
              `${pad}  <geom name="${geomName}" type="cylinder" pos="${proxyPos}" quat="${proxyQuatStr}" size="${cylRadius.toFixed(
                6
              )} ${cylHalf.toFixed(6)}"${collisionAttr}${frictionAttr} />`
            );
          } else {
            worldLines.push(
              `${pad}  <geom name="${geomName}" type="sphere" pos="${proxyPos}" quat="${quat}" size="${radius.toFixed(6)}"${collisionAttr}${frictionAttr} />`
            );
          }
        }
      }
    }

    const children = childrenByParent.get(linkName) ?? [];
    for (const child of children) {
      buildBody(child, indent + 2, false);
    }

    worldLines.push(`${pad}</body>`);
  };

  for (const root of rootLinks) {
    buildBody(root, 4, true);
  }

  if (meshMode === "mesh" && meshAssets.length) {
    lines.push(`  <asset>`);
    for (const mesh of meshAssets) {
      lines.push(`    <mesh name="${mesh.name}" file="${mesh.file}" scale="${formatVec(mesh.scale)}" />`);
    }
    lines.push(`  </asset>`);
  }

  lines.push(`  <worldbody>`);
  lines.push(...worldLines);
  lines.push(`  </worldbody>`);

  if (fixedBaseWeld && rootBodyNames.length) {
    lines.push(`  <equality>`);
    for (const bodyName of rootBodyNames) {
      lines.push(
        `    <weld body1="${bodyName}" body2="world" solref="${fixedBaseWeldSolref}" solimp="${fixedBaseWeldSolimp}" />`
      );
    }
    lines.push(`  </equality>`);
  }

  const jointActuators: string[] = [];
  for (const joint of joints) {
    if (joint.type === "fixed" || joint.type === "floating") continue;
    if (joint.actuator?.enabled === false) continue;
    const jointName = nameMap.joints[joint.name] ?? sanitizeMjcfName(joint.name);
    jointActuators.push(`    <motor name="${jointName}_motor" joint="${jointName}" gear="1" />`);
  }

  if (jointActuators.length) {
    lines.push(`  <actuator>`);
    lines.push(...jointActuators);
    lines.push(`  </actuator>`);
  }

  lines.push(`</mujoco>`);

  debugLog("mjcf built", {
    bodies: worldLines.filter((line) => line.includes("<body ")).length,
    geoms: worldLines.filter((line) => line.includes("<geom ")).length,
    actuators: jointActuators.length,
  });

  return { xml: lines.join("\n"), warnings, nameMap };
}
