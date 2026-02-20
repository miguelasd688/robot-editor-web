/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from "three";
import URDFLoader from "urdf-loader";
import type { Viewer } from "../viewer/Viewer";
import { createAssetResolver } from "./assetResolver";
import {
  parseUrdfElement,
  parseUrdfString,
  type UrdfGeom,
  type UrdfInstance,
  type UrdfJoint,
  type UrdfLink,
  type UrdfRobot,
} from "../urdf/urdfModel";
import type { UrdfImportOptions } from "../urdf/urdfImportOptions";
import { useLoaderStore } from "../store/useLoaderStore";
import { logInfo, logWarn } from "../services/logger";

export type URDFLoaderParams = {
  urdfUrl: string;
  urdfKey?: string | null;
  resolveResource?: (resourceUrl: string) => string | null;
  importOptions?: UrdfImportOptions;
};

type CollisionMaterial = THREE.MeshBasicMaterial;

const createCollisionMaterial = (): CollisionMaterial =>
  new THREE.MeshBasicMaterial({
    color: 0x8c5a2b,
    transparent: true,
    opacity: 0.45,
    wireframe: false,
    depthWrite: false,
    depthTest: false,
  });

const clonePose = (pose: { xyz: [number, number, number]; rpy: [number, number, number] }) => ({
  xyz: [...pose.xyz] as [number, number, number],
  rpy: [...pose.rpy] as [number, number, number],
});

const cloneGeom = (geom: UrdfGeom): UrdfGeom => {
  if (geom.kind === "box") return { kind: "box", size: [...geom.size] as [number, number, number] };
  if (geom.kind === "sphere") return { kind: "sphere", radius: geom.radius };
  if (geom.kind === "cylinder") return { kind: "cylinder", radius: geom.radius, length: geom.length };
  return { kind: "mesh", file: geom.file, scale: [...geom.scale] as [number, number, number] };
};

const cloneCollision = (item: UrdfLink["collisions"][number]) => ({
  name: item.name,
  origin: clonePose(item.origin),
  geom: cloneGeom(item.geom),
});

const cloneLink = (link: UrdfLink): UrdfLink => ({
  name: link.name,
  inertial: link.inertial
    ? {
        origin: clonePose(link.inertial.origin),
        mass: link.inertial.mass,
        inertia: { ...link.inertial.inertia },
      }
    : undefined,
  collisions: link.collisions.map(cloneCollision),
  visuals: link.visuals.map(cloneCollision),
});

const cloneJoint = (joint: UrdfJoint): UrdfJoint => ({
  name: joint.name,
  type: joint.type,
  parent: joint.parent,
  child: joint.child,
  origin: clonePose(joint.origin),
  axis: [...joint.axis] as [number, number, number],
  limit: joint.limit ? { ...joint.limit } : undefined,
  dynamics: joint.dynamics ? { ...joint.dynamics } : undefined,
  actuator: joint.actuator ? { ...joint.actuator } : undefined,
});

const applyCollisionMaterial = (root: THREE.Object3D, material: CollisionMaterial) => {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.material = material;
      mesh.renderOrder = 10;
    }
  });
};

const computeLocalBounds = (root: THREE.Object3D) => {
  root.updateMatrixWorld(true);
  const invRoot = root.matrixWorld.clone().invert();
  const box = new THREE.Box3();
  let hasBounds = false;

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geom = mesh.geometry as THREE.BufferGeometry;
    if (!geom) return;
    geom.computeBoundingBox();
    const geomBox = geom.boundingBox;
    if (!geomBox) return;
    const childBox = geomBox.clone();
    const toLocal = mesh.matrixWorld.clone().multiply(invRoot);
    childBox.applyMatrix4(toLocal);
    if (!hasBounds) {
      box.copy(childBox);
      hasBounds = true;
    } else {
      box.union(childBox);
    }
  });

  if (!hasBounds) return null;
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  if (!Number.isFinite(size.x) || !Number.isFinite(size.y) || !Number.isFinite(size.z)) return null;
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y) || !Number.isFinite(center.z)) return null;
  return { size, center };
};

const classifyFastShape = (size: THREE.Vector3) => {
  const dims = [Math.abs(size.x), Math.abs(size.y), Math.abs(size.z)].map((v) => Math.max(1e-6, v));
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

const applyCollisionProxy = (
  collider: THREE.Object3D,
  mode: "mesh" | "box" | "sphere" | "cylinder" | "fast",
  material: CollisionMaterial
) => {
  if (mode === "mesh") return;
  const bounds = computeLocalBounds(collider);
  if (!bounds) return;

  const { size, center } = bounds;
  const dims = [size.x, size.y, size.z];
  const radius = Math.max(1e-4, Math.max(size.x, size.y, size.z) / 2);
  let geometry: THREE.BufferGeometry;
  let rotation: THREE.Euler | null = null;
  let resolvedMode = mode;
  let axisIndex = 1;

  if (mode === "fast") {
    const classification = classifyFastShape(size);
    resolvedMode = classification.type;
    axisIndex = classification.axisIndex;
  }

  if (resolvedMode === "box") {
    geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
  } else if (resolvedMode === "cylinder") {
    if (mode !== "fast") {
      axisIndex = dims[0] <= dims[1] && dims[0] <= dims[2] ? 0 : dims[1] <= dims[2] ? 1 : 2;
    }
    const other = [0, 1, 2].filter((idx) => idx !== axisIndex);
    const cylRadius = Math.max(1e-4, Math.max(dims[other[0]], dims[other[1]]) / 2);
    const cylLen = Math.max(1e-4, dims[axisIndex]);
    geometry = new THREE.CylinderGeometry(cylRadius, cylRadius, cylLen, 16);
    if (axisIndex === 0) rotation = new THREE.Euler(0, 0, Math.PI / 2);
    if (axisIndex === 2) rotation = new THREE.Euler(Math.PI / 2, 0, 0);
  } else {
    geometry = new THREE.SphereGeometry(radius, 16, 12);
  }

  if (rotation) {
    geometry.rotateX(rotation.x);
    geometry.rotateY(rotation.y);
    geometry.rotateZ(rotation.z);
  }
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 10;

  collider.traverse((obj) => {
    if (obj === collider) return;
    obj.visible = false;
  });

  if ((collider as any).isMesh) {
    const asMesh = collider as THREE.Mesh;
    geometry.translate(center.x, center.y, center.z);
    asMesh.geometry = geometry;
    asMesh.material = material;
  } else {
    collider.clear();
    mesh.position.copy(center);
    collider.add(mesh);
  }
};

const refreshCollisionProxies = (
  root: THREE.Object3D,
  collisionMode: "mesh" | "box" | "sphere" | "cylinder" | "fast",
  collisionMaterial: CollisionMaterial
) => {
  root.traverse((obj) => {
    const anyObj = obj as any;
    if (!anyObj.isURDFCollider) return;
    applyCollisionMaterial(obj, collisionMaterial);
    applyCollisionProxy(obj, collisionMode, collisionMaterial);
  });
};

const applyUrdfMetadata = (
  root: THREE.Object3D,
  links: Map<string, UrdfLink>,
  joints: UrdfJoint[],
  collisionMode: "mesh" | "box" | "sphere" | "cylinder" | "fast",
  collisionMaterial: CollisionMaterial
) => {
  const jointMap = new Map(joints.map((joint) => [joint.name, joint]));

  root.traverse((obj) => {
    const anyObj = obj as any;
    const urdfName = typeof anyObj.urdfName === "string" ? anyObj.urdfName : obj.name;

    if (anyObj.isURDFLink) {
      const link = links.get(urdfName);
      if (link) {
        const data: UrdfInstance = { kind: "link", link: cloneLink(link) };
        obj.userData.urdf = data;

        if (link.inertial) {
          obj.userData.physics = {
            ...(obj.userData.physics ?? {}),
            mass: link.inertial.mass,
            inertia: {
              x: link.inertial.inertia.ixx,
              y: link.inertial.inertia.iyy,
              z: link.inertial.inertia.izz,
            },
          };
        }
      }
    } else if (anyObj.isURDFJoint) {
      const joint = jointMap.get(urdfName);
      if (joint) {
        const data: UrdfInstance = { kind: "joint", joint: cloneJoint(joint) };
        obj.userData.urdf = data;
      }
    } else if (anyObj.isURDFCollider) {
      obj.userData.urdfRole = "collision";
      obj.visible = false;
      obj.renderOrder = 10;
      applyCollisionMaterial(obj, collisionMaterial);
      applyCollisionProxy(obj, collisionMode, collisionMaterial);
    } else if (anyObj.isURDFVisual) {
      obj.userData.urdfRole = "visual";
      // Robustness: URDF meshes (especially STLs) can have inconsistent winding / normals.
      // Make visuals double-sided and avoid culling issues that can make parts "disappear" at certain angles.
      obj.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.frustumCulled = false;
        const geom = mesh.geometry as THREE.BufferGeometry | undefined;
        if (geom) {
          if (!geom.boundingSphere) geom.computeBoundingSphere();
          if (!geom.boundingBox) geom.computeBoundingBox();
        }
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          if (!material) continue;
          (material as any).side = THREE.DoubleSide;
          (material as any).needsUpdate = true;
        }
      });
    }
  });
};

const findRootLinkName = (robot: UrdfRobot) => {
  const children = new Set(robot.joints.map((joint) => joint.child));
  for (const name of robot.links.keys()) {
    if (!children.has(name)) return name;
  }
  return robot.links.keys().next().value ?? "base_link";
};

const resolveUrdfName = (obj: THREE.Object3D) => String((obj as any).urdfName ?? obj.name ?? "");

const findUrdfNode = (
  root: THREE.Object3D,
  predicate: (obj: THREE.Object3D) => boolean
): THREE.Object3D | null => {
  let found: THREE.Object3D | null = null;
  root.traverse((obj) => {
    if (found) return;
    if (predicate(obj)) found = obj;
  });
  return found;
};

const stripWorldReferenceFrame = (robotObj: THREE.Object3D, parsed: UrdfRobot) => {
  const worldLinkName = findRootLinkName(parsed);
  const rootJoints = parsed.joints.filter((joint) => joint.parent === worldLinkName);
  if (rootJoints.length === 0) return;

  const worldLinkObj = findUrdfNode(robotObj, (obj) => (obj as any).isURDFLink && resolveUrdfName(obj) === worldLinkName);
  if (!worldLinkObj) return;

  robotObj.updateMatrixWorld(true);
  worldLinkObj.updateMatrixWorld(true);

  for (const joint of rootJoints) {
    const jointObj = findUrdfNode(
      worldLinkObj,
      (obj) => (obj as any).isURDFJoint && resolveUrdfName(obj) === joint.name
    );
    if (!jointObj) continue;

    const childLinkObj = findUrdfNode(
      jointObj,
      (obj) => (obj as any).isURDFLink && resolveUrdfName(obj) === joint.child
    );
    if (childLinkObj) {
      childLinkObj.updateMatrixWorld(true);
      robotObj.attach(childLinkObj);
    }

    jointObj.removeFromParent();
  }

  worldLinkObj.removeFromParent();
};

export async function loadURDFObject(params: URDFLoaderParams): Promise<THREE.Object3D> {
  const { urdfUrl, urdfKey, resolveResource, importOptions } = params;

  const manager = new THREE.LoadingManager();
  let resourcesStarted = false;
  let resourcesCompleted = false;
  let resolveResourcesLoaded: (() => void) | null = null;
  const resourcesLoaded = new Promise<void>((resolve) => {
    resolveResourcesLoaded = resolve;
  });
  const previousOnStart = manager.onStart;
  const previousOnLoad = manager.onLoad;
  manager.onStart = (url: string, itemsLoaded: number, itemsTotal: number) => {
    resourcesStarted = true;
    previousOnStart?.(url, itemsLoaded, itemsTotal);
  };
  manager.onLoad = () => {
    resourcesCompleted = true;
    previousOnLoad?.();
    resolveResourcesLoaded?.();
  };
  manager.setURLModifier((resourceUrl) => {
    if (resolveResource) {
      const mapped = resolveResource(resourceUrl);
      return mapped ?? resourceUrl;
    }

    const baseUrl = urdfUrl.substring(0, urdfUrl.lastIndexOf("/") + 1);
    if (resourceUrl.startsWith("package://")) return resourceUrl;
    if (/^https?:\/\//i.test(resourceUrl)) return resourceUrl;
    return baseUrl + resourceUrl.replace(/^\/+/, "");
  });

  const loader = new URDFLoader(manager);
  (loader as any).packages = "";
  loader.parseCollision = true;

  const response = await fetch(urdfUrl);
  if (!response.ok) {
    throw new Error(`Failed to load URDF (${response.status} ${response.statusText})`);
  }
  const urdfText = await response.text();
  const robot = loader.parse(urdfText);

  const parsed = (robot as any).urdfRobotNode
    ? parseUrdfElement((robot as any).urdfRobotNode as Element)
    : parseUrdfString(urdfText);
  const urdfZUp = importOptions?.urdfZUp ?? false;
  const firstLinkIsWorldReferenceFrame = importOptions?.firstLinkIsWorldReferenceFrame ?? false;
  let root: THREE.Object3D = robot;
  const collisionMode = importOptions?.collisionMode ?? "mesh";
  let collisionMaterial: CollisionMaterial | null = null;
  const runPostLoadPass = () => {
    if (!collisionMaterial) return;
    refreshCollisionProxies(root, collisionMode, collisionMaterial);
  };

  if (parsed.robot) {
    // urdf-loader represents the kinematic root link using the URDFRobot object itself (URDFRobot extends URDFLink).
    // We wrap it in an editor "Robot" group so the root link can appear as a regular link in the Scene tree.
    const robotRoot = new THREE.Group();
    robotRoot.name = parsed.robot.name || (robot as any).robotName || "Robot";
    (robotRoot as any).isRobot = true;
    robotRoot.userData.editorRobotRoot = true;
    if (urdfZUp) {
      // URDFs (ROS) are typically Z-up; the editor world is Y-up.
      // Rotate the robot root so "up" maps to Y.
      robotRoot.rotation.x = -Math.PI / 2;
    }
    robotRoot.add(robot);
    root = robotRoot;

    if (firstLinkIsWorldReferenceFrame) stripWorldReferenceFrame(robotRoot, parsed.robot);

    collisionMaterial = createCollisionMaterial();
    applyUrdfMetadata(root, parsed.robot.links, parsed.robot.joints, collisionMode, collisionMaterial);
  }

  if (resourcesCompleted) {
    runPostLoadPass();
  } else {
    const chainedOnLoad = manager.onLoad;
    manager.onLoad = () => {
      runPostLoadPass();
      chainedOnLoad?.();
    };
  }

  if (resourcesStarted && !resourcesCompleted) {
    await resourcesLoaded;
  }

  root.userData.urdfSource = urdfText;
  if (importOptions) {
    root.userData.urdfImportOptions = { ...importOptions } satisfies UrdfImportOptions;
  }
  if (urdfKey) root.userData.urdfKey = urdfKey;
  root.position.set(0, 0, 0);
  return root;
}

export type URDFImportDeps = {
  viewer: Viewer | null;
  urdfKey: string | null;
  assets: Record<string, { url: string; key: string }>;
  importOptions?: URDFLoaderParams["importOptions"];
};

export async function loadWorkspaceURDFIntoViewer(deps: URDFImportDeps) {
  const { urdfKey, assets, importOptions } = deps;

  if (!urdfKey) {
    logWarn("URDF load requested but no URDF selected.", { scope: "urdf" });
    alert("No URDF selected. Import a folder/files with a .urdf and select it.");
    return;
  }

  const entry = assets[urdfKey];
  if (!entry) {
    logWarn("Selected URDF not found in workspace.", { scope: "urdf", data: { urdfKey } });
    alert("Selected URDF not found in workspace.");
    return;
  }

  logInfo(`URDF load requested: ${urdfKey}`, { scope: "urdf" });
  const resolveResource = createAssetResolver(assets, urdfKey);

  // ✅ aquí ya usas el store (viewer lo coge de useAppStore dentro del store)
  await useLoaderStore.getState().load(
    "urdf",
    { urdfUrl: entry.url, urdfKey, resolveResource, importOptions } satisfies URDFLoaderParams
  );
}
