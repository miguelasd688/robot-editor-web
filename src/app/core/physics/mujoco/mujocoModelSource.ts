import * as THREE from "three";
import { ColladaLoader, STLExporter, STLLoader, OBJLoader } from "three-stdlib";
import { dirname, relativePath, resolveAssetKey } from "../../loaders/assetResolver";
import { applyInitialTransform, ensureUserInstance } from "../../assets/assetInstance";
import type { AssetEntry } from "../../assets/assetRegistryTypes";
import type { MujocoModelSource } from "./MujocoRuntime";
import type { MjcfNameMap } from "./mjcfNames";
import { convertUrdfToMjcf } from "./urdfToMjcf";
import { logDebug, logInfo, logWarn } from "../../services/logger";

export type MujocoModelBuildInput = {
  assets: Record<string, AssetEntry>;
  urdfKey: string | null;
  urdfSource?: string | null;
  namePrefix?: string;
  urdfOptions: {
    floatingBase: boolean;
    firstLinkIsWorldReferenceFrame: boolean;
    selfCollision: boolean;
    collisionMode?: "mesh" | "box" | "sphere" | "cylinder" | "fast";
  };
  roots?: THREE.Object3D[];
};

export type MujocoModelBuildResult = {
  source: MujocoModelSource;
  warnings: string[];
};

type XmlModelSource = {
  kind: "urdf" | "mjcf";
  filename: string;
  content: string;
  files: Record<string, Uint8Array>;
  nameMap?: MjcfNameMap;
};

export type MjcfMergeInput = {
  sources: MujocoModelSource[];
  nameMaps: Array<MjcfNameMap | undefined>;
};

function extractTagContent(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? match[1].trim() : "";
}

function extractSingleTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}[^>]*>`, "i"));
  return match ? match[0] : null;
}

export function mergeMjcfSources(input: MjcfMergeInput): { source: MujocoModelSource; nameMap?: MjcfNameMap } {
  const { sources, nameMaps } = input;
  const mjcfSources = sources.filter((s): s is XmlModelSource => s.kind === "mjcf");
  if (mjcfSources.length === 0) {
    return { source: { kind: "generated" } };
  }

  const compiler =
    mjcfSources.map((s) => extractSingleTag(s.content, "compiler")).find(Boolean) ??
    `<compiler angle="radian" inertiafromgeom="false" meshdir="/working" />`;
  const option =
    mjcfSources.map((s) => extractSingleTag(s.content, "option")).find(Boolean) ??
    `<option gravity="0 -9.81 0" integrator="implicitfast" timestep="0.002" iterations="80" />`;

  const assets: string[] = [];
  const worldbody: string[] = [];
  const equality: string[] = [];
  const actuators: string[] = [];
  for (const source of mjcfSources) {
    assets.push(extractTagContent(source.content, "asset"));
    worldbody.push(extractTagContent(source.content, "worldbody"));
    equality.push(extractTagContent(source.content, "equality"));
    actuators.push(extractTagContent(source.content, "actuator"));
  }

  const mergedFiles: Record<string, Uint8Array> = {};
  for (const source of mjcfSources) {
    for (const [key, data] of Object.entries(source.files) as Array<[string, Uint8Array]>) {
      mergedFiles[key] = data;
    }
  }

  const lines: string[] = [];
  lines.push(`<mujoco model="scene">`);
  lines.push(`  ${compiler}`);
  lines.push(`  ${option}`);
  const assetBody = assets.filter(Boolean).join("\n");
  if (assetBody) {
    lines.push(`  <asset>`);
    lines.push(assetBody);
    lines.push(`  </asset>`);
  }
  lines.push(`  <worldbody>`);
  lines.push(worldbody.filter(Boolean).join("\n"));
  lines.push(`  </worldbody>`);
  const equalityBody = equality.filter(Boolean).join("\n");
  if (equalityBody) {
    lines.push(`  <equality>`);
    lines.push(equalityBody);
    lines.push(`  </equality>`);
  }
  const actuatorBody = actuators.filter(Boolean).join("\n");
  if (actuatorBody) {
    lines.push(`  <actuator>`);
    lines.push(actuatorBody);
    lines.push(`  </actuator>`);
  }
  lines.push(`</mujoco>`);

  const mergedNameMap = nameMaps.reduce<MjcfNameMap | undefined>((acc, entry) => {
    if (!entry) return acc;
    if (!acc) {
      acc = { links: {}, joints: {}, linksByMjcf: {}, jointsByMjcf: {} };
    }
    Object.assign(acc.links, entry.links ?? {});
    Object.assign(acc.joints, entry.joints ?? {});
    if (entry.linksByMjcf) {
      acc.linksByMjcf = { ...(acc.linksByMjcf ?? {}), ...entry.linksByMjcf };
    }
    if (entry.jointsByMjcf) {
      acc.jointsByMjcf = { ...(acc.jointsByMjcf ?? {}), ...entry.jointsByMjcf };
    }
    return acc;
  }, undefined);

  return {
    source: {
      kind: "mjcf",
      filename: "scene.mjcf",
      content: lines.join("\n"),
      files: mergedFiles,
      nameMap: mergedNameMap,
    },
    nameMap: mergedNameMap,
  };
}

export function restoreInitialTransforms(roots: THREE.Object3D[]) {
  for (const root of roots) {
    root.traverse((obj) => {
      applyInitialTransform(obj);
    });
    root.updateMatrixWorld(true);
  }
}

function findUrdfRootTransform(roots?: THREE.Object3D[]) {
  if (!roots || roots.length === 0) return null;
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();

  const isUrdfNode = (obj: THREE.Object3D) => {
    const anyObj = obj as any;
    return (
      anyObj.isURDFLink ||
      anyObj.isURDFJoint ||
      anyObj.isURDFCollider ||
      anyObj.isURDFVisual ||
      !!obj.userData?.urdf
    );
  };

  for (const root of roots) {
    let found = false;
    root.traverse((obj) => {
      if (found) return;
      if (isUrdfNode(obj)) found = true;
    });
    if (!found) continue;
    root.getWorldPosition(pos);
    root.getWorldQuaternion(quat);
    return {
      position: [pos.x, pos.y, pos.z] as [number, number, number],
      quaternion: [quat.x, quat.y, quat.z, quat.w] as [number, number, number, number],
    };
  }

  return null;
}

function buildLinkFrictionOverrides(roots: THREE.Object3D[]) {
  const map: Record<string, number> = {};
  for (const root of roots) {
    root.traverse((obj) => {
      const urdf = (obj as any).userData?.urdf as { kind?: string; link?: { name: string } } | undefined;
      if (!urdf || urdf.kind !== "link" || !urdf.link?.name) return;
      const friction = ensureUserInstance(obj).physics.friction;
      if (Number.isFinite(friction)) map[urdf.link.name] = friction;
    });
  }
  return map;
}

export async function buildModelSource(input: MujocoModelBuildInput): Promise<MujocoModelBuildResult> {
  const { assets, urdfKey, urdfSource, namePrefix, urdfOptions, roots } = input;
  const keys = Object.keys(assets);
  const warnings: string[] = [];
  const debug = String(import.meta.env.VITE_MUJOCO_DEBUG ?? "").toLowerCase() === "true";
  const forceDiagonalInertia =
    String(import.meta.env.VITE_MUJOCO_FORCE_DIAG_INERTIA ?? "true").toLowerCase() === "true";
  const selfCollision = urdfOptions.selfCollision === true;
  const parseEnvNumber = (value: string | undefined) => {
    if (value === undefined || value === "") return undefined;
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
  };
  const defaultJointDamping = parseEnvNumber(import.meta.env.VITE_URDF_DEFAULT_DAMPING);
  const defaultJointFriction = parseEnvNumber(import.meta.env.VITE_URDF_DEFAULT_FRICTION);
  const defaultJointArmature = parseEnvNumber(import.meta.env.VITE_URDF_DEFAULT_ARMATURE);
  const defaultGeomFrictionRaw = Number(import.meta.env.VITE_URDF_GEOM_FRICTION ?? "0.5");
  const defaultGeomFriction = Number.isFinite(defaultGeomFrictionRaw) ? defaultGeomFrictionRaw : 0.5;
  const geomFrictionByLink = roots ? buildLinkFrictionOverrides(roots) : null;
  const rootTransform = findUrdfRootTransform(roots);
  const debugLog = (message: string, data?: unknown) => {
    if (debug) logDebug(message, { scope: "mujoco", data });
  };

  if ((urdfSource && typeof urdfSource === "string") || (urdfKey && assets[urdfKey])) {
    let content = urdfSource && typeof urdfSource === "string" ? urdfSource : await assets[urdfKey as string].file.text();
    const label = urdfKey ?? "inline";
    logInfo(`MuJoCo: loading URDF (${label})`, { scope: "mujoco" });
    debugLog("urdf bytes", { bytes: content.length });
    if (/<\s*xacro:/i.test(content)) {
      try {
        const expanded = await expandXacroIfConfigured(content, assets, urdfKey ?? "");
        if (expanded) {
          content = expanded;
          logInfo("MuJoCo: xacro expanded", { scope: "mujoco" });
        } else {
          logWarn("MuJoCo: stripping xacro tags (no endpoint configured).", { scope: "mujoco" });
          content = stripXacroTags(content);
        }
      } catch (err: any) {
        logWarn("MuJoCo: xacro expansion failed, stripping tags instead.", {
          scope: "mujoco",
          data: { error: String(err?.message ?? err) },
        });
        content = stripXacroTags(content);
      }
    }
    const meshRefs = findMeshRefs(content, ["filename", "uri", "url"]);
    debugLog("mesh refs", meshRefs);
    const meshModeEnv = String(import.meta.env.VITE_URDF_MESH_MODE ?? "").toLowerCase();
    const envMeshMode: "mesh" | "box" | "sphere" | "cylinder" | "fast" | null =
      meshModeEnv === "mesh" ||
      meshModeEnv === "box" ||
      meshModeEnv === "sphere" ||
      meshModeEnv === "cylinder" ||
      meshModeEnv === "fast"
        ? meshModeEnv
        : null;
    const optionMode = urdfOptions.collisionMode;
    let meshMode: "mesh" | "box" | "sphere" | "cylinder" | "fast" =
      optionMode === "mesh" ||
      optionMode === "box" ||
      optionMode === "sphere" ||
      optionMode === "cylinder" ||
      optionMode === "fast"
        ? optionMode
        : envMeshMode ?? (meshRefs.length ? "mesh" : "sphere");
    let files: Record<string, Uint8Array> = {};
    let remap: Record<string, string> | undefined = undefined;
    const meshBounds =
      meshMode === "mesh" ? null : await computeMeshBounds(assets, urdfKey ?? "", meshRefs);

    if (meshMode === "mesh" && meshRefs.length > 0) {
      logInfo("MuJoCo: converting meshes", { scope: "mujoco", data: { count: meshRefs.length } });
      const { files: meshFiles, remap: meshRemap, missing, convertedWarnings } = await convertMeshesForMujoco(
        assets,
        urdfKey ?? "",
        meshRefs
      );
      warnings.push(...convertedWarnings);
      if (missing.length) {
        if (envMeshMode) {
          throw new Error(`Missing mesh files referenced by URDF: ${missing.join(", ")}`);
        }
        warnings.push(`Missing mesh files; falling back to sphere collisions.`);
        meshMode = "sphere";
      } else {
        files = meshFiles;
        remap = meshRemap;
      }
    }
    logInfo("MuJoCo: parsing URDF", { scope: "mujoco" });
    const { xml, warnings: urdfWarnings, nameMap } = convertUrdfToMjcf({
      urdf: content,
      assets,
      baseKey: urdfKey ?? "",
      namePrefix,
      remap,
      warnOnXacro: false,
      meshMode,
      meshBounds: meshBounds ?? undefined,
      rootFreeJoint: urdfOptions.floatingBase,
      rootTransform: rootTransform ?? undefined,
      debug,
      forceDiagonalInertia,
      firstLinkIsWorldReferenceFrame: urdfOptions.firstLinkIsWorldReferenceFrame,
      selfCollision,
      defaultJointDamping,
      defaultJointFriction,
      defaultJointArmature,
      defaultGeomFriction,
      geomFrictionByLink: geomFrictionByLink ?? undefined,
    });
    warnings.push(...urdfWarnings);
    if (!xml) {
      throw new Error(`Failed to convert URDF to MJCF.${urdfWarnings.length ? `\n${urdfWarnings.join("\n")}` : ""}`);
    }
    logInfo("MuJoCo: MJCF generated", { scope: "mujoco", data: { meshMode, xmlBytes: xml.length } });
    const mjcfKey = (urdfKey ?? "inline").replace(/\.[^/.]+$/, "") + ".mjcf";
    return {
      source: {
        kind: "mjcf",
        filename: mjcfKey,
        content: xml,
        files,
        nameMap,
      },
      warnings,
    };
  }

  const xmlKey = keys.find((k) => k.toLowerCase().endsWith(".xml") || k.toLowerCase().endsWith(".mjcf"));
  if (xmlKey && assets[xmlKey]) {
    logInfo(`MuJoCo: loading MJCF (${xmlKey})`, { scope: "mujoco" });
    const content = await assets[xmlKey].file.text();
    const meshRefs = findMeshRefs(content, "file");
    const { files, remap, missing, convertedWarnings } = await convertMeshesForMujoco(
      assets,
      xmlKey,
      meshRefs
    );
    warnings.push(...convertedWarnings);
    if (missing.length) {
      throw new Error(`Missing mesh files referenced by MJCF: ${missing.join(", ")}`);
    }
    const rewritten = rewriteAssetPaths(content, assets, xmlKey, "file", remap);
    return {
      source: {
        kind: "mjcf",
        filename: xmlKey,
        content: rewritten,
        files,
      },
      warnings,
    };
  }

  return { source: { kind: "generated" }, warnings };
}

async function readAllAssets(assets: Record<string, AssetEntry>): Promise<Record<string, Uint8Array>> {
  const entries = await Promise.all(
    Object.values(assets).map(async (entry) => [entry.key, new Uint8Array(await entry.file.arrayBuffer())] as const)
  );
  return Object.fromEntries(entries);
}

function encodeBase64(data: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function expandXacroIfConfigured(
  content: string,
  assets: Record<string, AssetEntry>,
  urdfKey: string
): Promise<string | null> {
  const endpoint = import.meta.env.VITE_XACRO_ENDPOINT as string | undefined;
  if (!endpoint) return null;
  const files = await readAllAssets(assets);
  const payload = {
    urdfKey,
    urdf: content,
    files: Object.fromEntries(Object.entries(files).map(([key, data]) => [key, encodeBase64(data)])),
  };
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Xacro endpoint failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { urdf?: string };
  if (!data?.urdf) {
    throw new Error("Xacro endpoint did not return expanded URDF.");
  }
  return String(data.urdf);
}

function stripXacroTags(content: string) {
  let next = content;
  next = next.replace(/\sxmlns:xacro="[^"]*"/gi, "");
  next = next.replace(/<\s*xacro:[^>]*\/\s*>/gi, "");
  next = next.replace(/<\s*xacro:[^>]*>/gi, "");
  next = next.replace(/<\/\s*xacro:[^>]*>/gi, "");
  return next;
}

type MeshBounds = { size: [number, number, number]; radius: number; center: [number, number, number] };

function boundsFromGeometry(geometry: THREE.BufferGeometry): MeshBounds | null {
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const box = geometry.boundingBox;
  if (!box) return null;
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  if (!Number.isFinite(size.x) || !Number.isFinite(size.y) || !Number.isFinite(size.z)) return null;
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y) || !Number.isFinite(center.z)) return null;
  const sphere = geometry.boundingSphere ?? new THREE.Sphere();
  if (!geometry.boundingSphere) box.getBoundingSphere(sphere);
  const radius = Number.isFinite(sphere.radius) ? sphere.radius : Math.max(size.x, size.y, size.z) * 0.5;
  return { size: [size.x, size.y, size.z], radius, center: [center.x, center.y, center.z] };
}

function boundsFromObject(obj: THREE.Object3D): MeshBounds | null {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  if (!Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) return null;
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  if (!Number.isFinite(size.x) || !Number.isFinite(size.y) || !Number.isFinite(size.z)) return null;
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y) || !Number.isFinite(center.z)) return null;
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  const radius = Number.isFinite(sphere.radius) ? sphere.radius : Math.max(size.x, size.y, size.z) * 0.5;
  return { size: [size.x, size.y, size.z], radius, center: [center.x, center.y, center.z] };
}

async function loadColladaScene(entry: AssetEntry): Promise<THREE.Object3D | null> {
  const loader = new ColladaLoader();
  return await new Promise((resolve) => {
    loader.load(
      entry.url,
      (data) => resolve(data.scene ?? null),
      undefined,
      () => resolve(null)
    );
  });
}

async function computeMeshBounds(
  assets: Record<string, AssetEntry>,
  baseKey: string,
  refs: string[]
): Promise<Record<string, MeshBounds>> {
  const result: Record<string, MeshBounds> = {};
  const uniqueKeys = new Set<string>();
  for (const ref of refs) {
    const key = resolveAssetKey(assets, ref, baseKey);
    if (key) uniqueKeys.add(key);
  }

  const stlLoader = new STLLoader();
  const objLoader = new OBJLoader();

  for (const key of uniqueKeys) {
    const entry = assets[key];
    if (!entry) continue;
    const lower = key.toLowerCase();
    try {
      if (lower.endsWith(".stl")) {
        const data = await entry.file.arrayBuffer();
        const geom = stlLoader.parse(data);
        const bounds = boundsFromGeometry(geom);
        if (bounds) result[key] = bounds;
        continue;
      }
      if (lower.endsWith(".obj")) {
        const data = await entry.file.text();
        const obj = objLoader.parse(data);
        const bounds = boundsFromObject(obj);
        if (bounds) result[key] = bounds;
        continue;
      }
      if (lower.endsWith(".dae")) {
        const scene = await loadColladaScene(entry);
        if (!scene) continue;
        const bounds = boundsFromObject(scene);
        if (bounds) result[key] = bounds;
      }
    } catch {
      // ignore bound failures, fall back to heuristic radii
    }
  }

  return result;
}

function rewriteAssetPaths(
  xml: string,
  assets: Record<string, AssetEntry>,
  baseKey: string,
  attrName: "filename" | "file",
  remap?: Record<string, string>
) {
  const baseDir = dirname(baseKey);
  const regex = new RegExp(`${attrName}\\s*=\\s*(["'])([^"']+)\\1`, "gi");
  return xml.replace(regex, (full, quote: string, raw: string) => {
    const key = resolveAssetKey(assets, raw, baseKey);
    if (!key) return full;
    const remapped = remap?.[key] ?? key;
    const rel = relativePath(baseDir, remapped);
    return `${attrName}=${quote}${rel}${quote}`;
  });
}

function findMeshRefs(xml: string, attrName: "filename" | "file" | Array<"filename" | "file" | "uri" | "url">) {
  const refs: string[] = [];
  const names = Array.isArray(attrName) ? attrName : [attrName];
  for (const name of names) {
    const regex = new RegExp(`<mesh[^>]*${name}\\s*=\\s*(["'])([^"']+)\\1`, "gi");
    let match: RegExpExecArray | null;
    while ((match = regex.exec(xml)) !== null) {
      refs.push(match[2]);
    }
  }
  return refs;
}

async function convertMeshesForMujoco(assets: Record<string, AssetEntry>, baseKey: string, refs: string[]) {
  const files: Record<string, Uint8Array> = {};
  const remap: Record<string, string> = {};
  const missing = new Set<string>();
  const warnings: string[] = [];
  const debug = String(import.meta.env.VITE_MUJOCO_DEBUG ?? "").toLowerCase() === "true";
  const loadFile = async (key: string) => {
    if (files[key]) return true;
    const entry = assets[key];
    if (!entry) return false;
    try {
      files[key] = new Uint8Array(await entry.file.arrayBuffer());
      return true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`Failed to read ${key}: ${message}`);
      return false;
    }
  };

  const uniqueKeys = new Set<string>();
  for (const ref of refs) {
    const key = resolveAssetKey(assets, ref, baseKey);
    if (debug) {
      logDebug("resolve mesh", { scope: "mujoco", data: { ref, key } });
    }
    if (!key) {
      missing.add(ref);
      continue;
    }
    uniqueKeys.add(key);
  }

  for (const key of uniqueKeys) {
    const loaded = await loadFile(key);
    if (!loaded) missing.add(key);
  }

  for (const key of uniqueKeys) {
    const lower = key.toLowerCase();
    if (!lower.endsWith(".dae")) continue;

    const stlKey = key.replace(/\.dae$/i, ".stl");
    if (await loadFile(stlKey)) {
      remap[key] = stlKey;
      continue;
    }

    const entry = assets[key];
    if (!entry || !files[key]) continue;

    try {
      const stlData = await convertDaeToStl(entry);
      files[stlKey] = stlData;
      remap[key] = stlKey;
      warnings.push(`Converted ${key} -> ${stlKey} for MuJoCo.`);
    } catch (err: any) {
      warnings.push(`Failed to convert ${key}: ${String(err?.message ?? err)}`);
    }
  }

  return { files, remap, missing: Array.from(missing), convertedWarnings: warnings };
}

async function convertDaeToStl(entry: AssetEntry): Promise<Uint8Array> {
  const loader = new ColladaLoader();
  const collada = await new Promise<any>((resolve, reject) => {
    loader.load(
      entry.url,
      (data) => resolve(data),
      undefined,
      (err) => reject(err)
    );
  });

  const exporter = new STLExporter();
  collada.scene.updateMatrixWorld(true);
  const stl = exporter.parse(collada.scene, { binary: false });
  const text = typeof stl === "string" ? stl : "";
  return new TextEncoder().encode(text);
}
