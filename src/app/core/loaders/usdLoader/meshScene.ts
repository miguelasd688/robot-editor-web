import * as THREE from "three";
import {
  normalizeBodyToken,
  normalizePathAliasToken,
  PATH_SKIP_SEGMENTS,
  JOINT_NAME_RE,
  LINK_NAME_RE,
} from "./types";
import type {
  NormalizedUsdMaterialChannelSources,
  NormalizedUsdMeshScene,
  NormalizedUsdMeshSceneBody,
  NormalizedUsdMeshSceneMesh,
  NormalizedUsdMeshScenePrimitive,
  NormalizedUsdMeshScenePrimitiveKind,
  ResolvedUsdMaterialTextures,
  UsdConverterMeshSceneResponse,
} from "./types";
import { createUsdVisualMaterial, createUsdCollisionMaterial, normalizeTextureAssetPath } from "./materials";

// ---------------------------------------------------------------------------
// Small parsing helpers
// ---------------------------------------------------------------------------

export const parseOptionalBoolean = (value: unknown): boolean | null => {
  if (typeof value === "boolean") return value;
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return null;
};

export const parseOptionalNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const parseOptionalText = (value: unknown): string | null => {
  const text = String(value ?? "").trim();
  return text ? text : null;
};

export const parseNumberTriplet = (
  value: unknown,
  fallback: [number, number, number]
): [number, number, number] => {
  const source = Array.isArray(value) ? value : [];
  const x = Number(source[0]);
  const y = Number(source[1]);
  const z = Number(source[2]);
  return [
    Number.isFinite(x) ? x : fallback[0],
    Number.isFinite(y) ? y : fallback[1],
    Number.isFinite(z) ? z : fallback[2],
  ];
};

export const parseNumberQuartet = (
  value: unknown,
  fallback: [number, number, number, number]
): [number, number, number, number] => {
  const source = Array.isArray(value) ? value : [];
  const a = Number(source[0]);
  const b = Number(source[1]);
  const c = Number(source[2]);
  const d = Number(source[3]);
  return [
    Number.isFinite(a) ? a : fallback[0],
    Number.isFinite(b) ? b : fallback[1],
    Number.isFinite(c) ? c : fallback[2],
    Number.isFinite(d) ? d : fallback[3],
  ];
};

// ---------------------------------------------------------------------------
// Mesh data parsers
// ---------------------------------------------------------------------------

const parseMeshPoints = (value: unknown): Float32Array | null => {
  if (!Array.isArray(value) || value.length < 3) return null;
  const out = new Float32Array(value.length * 3);
  let cursor = 0;
  for (const item of value) {
    if (!Array.isArray(item)) return null;
    const x = Number(item[0]);
    const y = Number(item[1]);
    const z = Number(item[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    out[cursor] = x;
    out[cursor + 1] = y;
    out[cursor + 2] = z;
    cursor += 3;
  }
  return cursor >= 9 ? out : null;
};

const parseMeshIndexArray = (value: unknown, pointsCount: number): Uint32Array | null => {
  if (!Array.isArray(value) || value.length < 3 || pointsCount < 3) return null;
  const out: number[] = [];
  for (const item of value) {
    const index = Number(item);
    if (!Number.isFinite(index)) continue;
    const integer = Math.trunc(index);
    if (integer < 0 || integer >= pointsCount) continue;
    out.push(integer);
  }
  const usable = Math.floor(out.length / 3) * 3;
  if (usable < 3) return null;
  return Uint32Array.from(out.slice(0, usable));
};

const parseMeshNormals = (value: unknown, pointsCount: number): Float32Array | null => {
  if (!Array.isArray(value) || value.length !== pointsCount) return null;
  const out = new Float32Array(pointsCount * 3);
  let cursor = 0;
  for (const item of value) {
    if (!Array.isArray(item)) return null;
    const x = Number(item[0]);
    const y = Number(item[1]);
    const z = Number(item[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    out[cursor] = x;
    out[cursor + 1] = y;
    out[cursor + 2] = z;
    cursor += 3;
  }
  return out;
};

const parseMeshUvs = (value: unknown, pointsCount: number): Float32Array | null => {
  if (!Array.isArray(value) || value.length !== pointsCount) return null;
  const out = new Float32Array(pointsCount * 2);
  let cursor = 0;
  for (const item of value) {
    if (!Array.isArray(item)) return null;
    const u = Number(item[0]);
    const v = Number(item[1]);
    if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
    out[cursor] = u;
    out[cursor + 1] = v;
    cursor += 2;
  }
  return out;
};

const parseMeshRgba = (value: unknown): [number, number, number, number] | null => {
  if (!Array.isArray(value) || value.length < 3) return null;
  const [r, g, b, a] = parseNumberQuartet(value, [1, 1, 1, 1]);
  return [
    Math.max(0, Math.min(1, r)),
    Math.max(0, Math.min(1, g)),
    Math.max(0, Math.min(1, b)),
    Math.max(0, Math.min(1, a)),
  ];
};

const parseUnitNumberOrNull = (value: unknown): number | null => {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(1, num));
};

const parseColorTriplet = (value: unknown): [number, number, number] | null => {
  if (!Array.isArray(value) || value.length < 3) return null;
  const r = Number(value[0]);
  const g = Number(value[1]);
  const b = Number(value[2]);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  return [
    Math.max(0, Math.min(1, r)),
    Math.max(0, Math.min(1, g)),
    Math.max(0, Math.min(1, b)),
  ];
};

const parseMaterialChannelSourceToken = (
  value: unknown
): "explicit" | "generic_fallback" | null => {
  const token = String(value ?? "").trim().toLowerCase();
  if (token === "explicit") return "explicit";
  if (token === "generic_fallback" || token === "generic") return "generic_fallback";
  return null;
};

const parseMaterialChannelSources = (value: unknown): NormalizedUsdMaterialChannelSources | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const parsed: NormalizedUsdMaterialChannelSources = {
    baseColor: parseMaterialChannelSourceToken(raw.baseColor),
    normal: parseMaterialChannelSourceToken(raw.normal),
    metallic: parseMaterialChannelSourceToken(raw.metallic),
    roughness: parseMaterialChannelSourceToken(raw.roughness),
    metallicRoughness: parseMaterialChannelSourceToken(raw.metallicRoughness),
    occlusion: parseMaterialChannelSourceToken(raw.occlusion),
    emissive: parseMaterialChannelSourceToken(raw.emissive),
    opacity: parseMaterialChannelSourceToken(raw.opacity),
  };
  const hasAny = Object.values(parsed).some((item) => item !== null);
  return hasAny ? parsed : null;
};

const parsePrimitiveKind = (value: unknown): NormalizedUsdMeshScenePrimitiveKind | null => {
  const token = String(value ?? "").trim().toLowerCase();
  if (token === "sphere" || token === "capsule" || token === "cylinder" || token === "cone" || token === "cube") {
    return token;
  }
  return null;
};

const parseAxisToken = (value: unknown): "X" | "Y" | "Z" => {
  const token = String(value ?? "").trim().toUpperCase();
  if (token === "X" || token === "Y" || token === "Z") return token;
  return "Z";
};

const parsePositiveNumberOrNull = (value: unknown): number | null => {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
};

const parseStageUpAxis = (value: unknown): "X" | "Y" | "Z" | "unknown" => {
  const axis = String(value ?? "").trim().toUpperCase();
  if (axis === "X" || axis === "Y" || axis === "Z") return axis;
  return "unknown";
};

// ---------------------------------------------------------------------------
// Mesh geometry builders
// ---------------------------------------------------------------------------

export const buildUsdMeshGeometry = (mesh: NormalizedUsdMeshSceneMesh) => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(mesh.points, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.triangles, 1));
  if (mesh.normals && mesh.normals.length === mesh.points.length) {
    geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
  } else {
    geometry.computeVertexNormals();
  }
  if (mesh.uvs && mesh.uvs.length * 3 === mesh.points.length * 2) {
    geometry.setAttribute("uv", new THREE.BufferAttribute(mesh.uvs, 2));
    geometry.setAttribute("uv2", new THREE.BufferAttribute(mesh.uvs.slice(), 2));
  }
  geometry.computeBoundingSphere();
  return geometry;
};

export const buildUsdPrimitiveGeometry = (primitive: NormalizedUsdMeshScenePrimitive): THREE.BufferGeometry | null => {
  if (primitive.kind === "sphere" && primitive.radius) {
    return new THREE.SphereGeometry(Math.max(1e-5, primitive.radius), 24, 18);
  }
  if (primitive.kind === "capsule" && primitive.radius && primitive.height) {
    return new THREE.CapsuleGeometry(Math.max(1e-5, primitive.radius), Math.max(0, primitive.height), 10, 18);
  }
  if (primitive.kind === "cylinder" && primitive.radius && primitive.height) {
    return new THREE.CylinderGeometry(
      Math.max(1e-5, primitive.radius),
      Math.max(1e-5, primitive.radius),
      Math.max(1e-6, primitive.height),
      20,
      1
    );
  }
  if (primitive.kind === "cone" && primitive.radius && primitive.height) {
    return new THREE.ConeGeometry(Math.max(1e-5, primitive.radius), Math.max(1e-6, primitive.height), 20, 1);
  }
  if (primitive.kind === "cube" && primitive.size) {
    return new THREE.BoxGeometry(
      Math.max(1e-6, primitive.size[0]),
      Math.max(1e-6, primitive.size[1]),
      Math.max(1e-6, primitive.size[2])
    );
  }
  return null;
};

const axisTokenToVector = (axis: "X" | "Y" | "Z") => {
  if (axis === "X") return new THREE.Vector3(1, 0, 0);
  if (axis === "Y") return new THREE.Vector3(0, 1, 0);
  return new THREE.Vector3(0, 0, 1);
};

// ---------------------------------------------------------------------------
// Visual mesh creation
// ---------------------------------------------------------------------------

export const createUsdVisualMesh = (
  mesh: NormalizedUsdMeshSceneMesh,
  options?: { materialTextures?: ResolvedUsdMaterialTextures }
) => {
  const geometry = buildUsdMeshGeometry(mesh);
  const material = createUsdVisualMaterial(mesh.rgba, {
    textures: options?.materialTextures,
    materialName: mesh.materialName,
    materialChannelSources: mesh.materialChannelSources,
    metallicFactor: mesh.metallicFactor,
    roughnessFactor: mesh.roughnessFactor,
    emissiveFactor: mesh.emissiveFactor,
    opacityFactor: mesh.opacityFactor,
  });
  const visualMesh = new THREE.Mesh(geometry, material);
  visualMesh.name = mesh.name;
  visualMesh.userData.editorKind = "mesh";
  visualMesh.userData.usdPrimPath = mesh.primPath;
  visualMesh.userData.disableViewportEdgeOverlay = true;
  visualMesh.userData.usdMaterialInfo = {
    materialName: mesh.materialName,
    materialSource: mesh.materialSource,
    baseColorTexture: mesh.baseColorTexture,
    normalTexture: mesh.normalTexture,
    metallicTexture: mesh.metallicTexture,
    roughnessTexture: mesh.roughnessTexture,
    metallicRoughnessTexture: mesh.metallicRoughnessTexture,
    occlusionTexture: mesh.occlusionTexture,
    emissiveTexture: mesh.emissiveTexture,
    opacityTexture: mesh.opacityTexture,
    materialChannelSources: mesh.materialChannelSources,
    textureUrls: options?.materialTextures ?? null,
    editable: !Object.values(options?.materialTextures ?? {}).some((value) => Boolean(value)),
  };
  visualMesh.position.set(mesh.position[0], mesh.position[1], mesh.position[2]);
  visualMesh.quaternion.copy(mesh.quaternion);
  visualMesh.scale.set(mesh.scale[0], mesh.scale[1], mesh.scale[2]);
  return visualMesh;
};

// ---------------------------------------------------------------------------
// Collision proxy
// ---------------------------------------------------------------------------

export const createUsdCollisionMeshFromVisual = (visualMesh: THREE.Mesh) => {
  const collisionMesh = new THREE.Mesh(visualMesh.geometry.clone(), createUsdCollisionMaterial());
  collisionMesh.name = `${visualMesh.name}_collision`;
  collisionMesh.userData.editorKind = "mesh";
  collisionMesh.userData.usdPrimPath = visualMesh.userData?.usdPrimPath;
  collisionMesh.position.copy(visualMesh.position);
  collisionMesh.quaternion.copy(visualMesh.quaternion);
  collisionMesh.scale.copy(visualMesh.scale);
  return collisionMesh;
};

// ---------------------------------------------------------------------------
// Visual primitive creation
// ---------------------------------------------------------------------------

export const createUsdVisualPrimitive = (
  primitive: NormalizedUsdMeshScenePrimitive,
  options?: { materialTextures?: ResolvedUsdMaterialTextures }
) => {
  const geometry = buildUsdPrimitiveGeometry(primitive);
  if (!geometry) return null;
  const uvAttr = geometry.getAttribute("uv");
  if (uvAttr && !geometry.getAttribute("uv2")) {
    geometry.setAttribute("uv2", uvAttr.clone());
  }

  const visualMesh = new THREE.Mesh(
    geometry,
    createUsdVisualMaterial(primitive.rgba, {
      textures: options?.materialTextures,
      materialName: primitive.materialName,
      materialChannelSources: primitive.materialChannelSources,
      metallicFactor: primitive.metallicFactor,
      roughnessFactor: primitive.roughnessFactor,
      emissiveFactor: primitive.emissiveFactor,
      opacityFactor: primitive.opacityFactor,
    })
  );
  visualMesh.name = primitive.name;
  visualMesh.userData.editorKind = "mesh";
  visualMesh.userData.usdPrimPath = primitive.primPath;
  visualMesh.userData.disableViewportEdgeOverlay = true;
  visualMesh.userData.usdMaterialInfo = {
    materialName: primitive.materialName,
    materialSource: primitive.materialSource,
    baseColorTexture: primitive.baseColorTexture,
    normalTexture: primitive.normalTexture,
    metallicTexture: primitive.metallicTexture,
    roughnessTexture: primitive.roughnessTexture,
    metallicRoughnessTexture: primitive.metallicRoughnessTexture,
    occlusionTexture: primitive.occlusionTexture,
    emissiveTexture: primitive.emissiveTexture,
    opacityTexture: primitive.opacityTexture,
    materialChannelSources: primitive.materialChannelSources,
    textureUrls: options?.materialTextures ?? null,
    editable: !Object.values(options?.materialTextures ?? {}).some((value) => Boolean(value)),
  };
  visualMesh.position.set(primitive.position[0], primitive.position[1], primitive.position[2]);

  const orientByAxis = primitive.kind === "capsule" || primitive.kind === "cylinder" || primitive.kind === "cone";
  if (orientByAxis) {
    const axisQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axisTokenToVector(primitive.axis));
    visualMesh.quaternion.copy(primitive.quaternion).multiply(axisQuat);
  } else {
    visualMesh.quaternion.copy(primitive.quaternion);
  }

  visualMesh.scale.set(primitive.scale[0], primitive.scale[1], primitive.scale[2]);
  return visualMesh;
};

// ---------------------------------------------------------------------------
// Mesh scene structure analysis
// ---------------------------------------------------------------------------

const MESH_SCENE_PATH_TOKEN_SKIP_RE =
  /^(world|root|scene|env|environment|robot|robots|xform|scope|geom|geometry|mesh|meshes|material|materials|looks|visual|collision|collider|physics|render|model|default)$/i;

const deriveMeshSceneTokenFromPath = (value: string | null | undefined): string | null => {
  const normalized = normalizePathAliasToken(value);
  if (!normalized) return null;
  const segments = normalized.split("/").filter(Boolean);
  if (!segments.length) return null;

  const pickToken = (segment: string) => {
    const token = normalizeBodyToken(segment);
    if (!token) return null;
    const lower = token.toLowerCase();
    if (PATH_SKIP_SEGMENTS.has(lower)) return null;
    if (MESH_SCENE_PATH_TOKEN_SKIP_RE.test(lower)) return null;
    if (JOINT_NAME_RE.test(token)) return null;
    return token;
  };

  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const token = pickToken(segments[i]);
    if (!token) continue;
    if (LINK_NAME_RE.test(token)) return token;
  }
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const token = pickToken(segments[i]);
    if (!token) continue;
    if (/[A-Za-z]/.test(token) && (/\d/.test(token) || /[_-]/.test(token))) return token;
  }
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const token = pickToken(segments[i]);
    if (!token) continue;
    return token;
  }
  return null;
};

export const collectMeshSceneStructureTokens = (meshScene: NormalizedUsdMeshScene): Set<string> => {
  const out = new Set<string>();
  const register = (value: string | null | undefined) => {
    const token = normalizeBodyToken(value);
    if (!token) return;
    const lower = token.toLowerCase();
    if (PATH_SKIP_SEGMENTS.has(lower)) return;
    if (MESH_SCENE_PATH_TOKEN_SKIP_RE.test(lower)) return;
    out.add(token);
  };
  const registerPath = (value: string | null | undefined) => {
    const token = deriveMeshSceneTokenFromPath(value);
    if (!token) return;
    out.add(token);
  };

  for (const body of meshScene.bodies) {
    register(body.name);
    register(body.parentBody);
    registerPath(body.primPath);
    registerPath(body.parentBodyPath);
  }
  for (const mesh of meshScene.meshes) {
    register(mesh.parentBody);
    registerPath(mesh.parentBodyPath);
    registerPath(mesh.primPath);
  }
  for (const primitive of meshScene.primitives) {
    register(primitive.parentBody);
    registerPath(primitive.parentBodyPath);
    registerPath(primitive.primPath);
  }
  return out;
};

// ---------------------------------------------------------------------------
// Mesh scene normalization
// ---------------------------------------------------------------------------

export const normalizeUsdMeshScene = (
  payload: UsdConverterMeshSceneResponse,
  fallbackAssetId: string
): NormalizedUsdMeshScene | null => {
  const meshesRaw = Array.isArray(payload.meshes) ? payload.meshes : [];
  const primitivesRaw = Array.isArray(payload.primitives) ? payload.primitives : [];
  const bodiesRaw = Array.isArray(payload.bodies) ? payload.bodies : [];
  const meshes: NormalizedUsdMeshSceneMesh[] = [];
  const primitives: NormalizedUsdMeshScenePrimitive[] = [];
  const bodies: NormalizedUsdMeshSceneBody[] = [];

  for (const item of meshesRaw) {
    const points = parseMeshPoints(item?.points);
    if (!points) continue;
    const pointsCount = points.length / 3;
    const triangles = parseMeshIndexArray(item?.triangles, pointsCount);
    if (!triangles) continue;

    const [px, py, pz] = parseNumberTriplet(item?.position, [0, 0, 0]);
    const [qw, qx, qy, qz] = parseNumberQuartet(item?.quaternion, [1, 0, 0, 0]);
    const [sx, sy, sz] = parseNumberTriplet(item?.scale, [1, 1, 1]);
    const quat = new THREE.Quaternion(qx, qy, qz, qw);
    if (quat.lengthSq() <= 1e-9) {
      quat.identity();
    } else {
      quat.normalize();
    }

    meshes.push({
      name: String(item?.name ?? "").trim() || `mesh_${meshes.length + 1}`,
      primPath: String(item?.primPath ?? "").trim(),
      parentBody: normalizeBodyToken(item?.parentBody),
      parentBodyPath: parseOptionalText(item?.parentBodyPath),
      position: [px, py, pz],
      quaternion: quat,
      scale: [
        Math.max(1e-6, Number.isFinite(sx) ? sx : 1),
        Math.max(1e-6, Number.isFinite(sy) ? sy : 1),
        Math.max(1e-6, Number.isFinite(sz) ? sz : 1),
      ],
      points,
      triangles,
      normals: parseMeshNormals(item?.normals, pointsCount),
      uvs: parseMeshUvs(item?.uvs, pointsCount),
      rgba: parseMeshRgba(item?.rgba),
      materialName: parseOptionalText(item?.materialName),
      materialSource: parseOptionalText(item?.materialSource),
      baseColorTexture: normalizeTextureAssetPath(parseOptionalText(item?.baseColorTexture)),
      normalTexture: normalizeTextureAssetPath(parseOptionalText(item?.normalTexture)),
      metallicTexture: normalizeTextureAssetPath(parseOptionalText(item?.metallicTexture)),
      roughnessTexture: normalizeTextureAssetPath(parseOptionalText(item?.roughnessTexture)),
      metallicRoughnessTexture: normalizeTextureAssetPath(parseOptionalText(item?.metallicRoughnessTexture)),
      occlusionTexture: normalizeTextureAssetPath(parseOptionalText(item?.occlusionTexture)),
      emissiveTexture: normalizeTextureAssetPath(parseOptionalText(item?.emissiveTexture)),
      opacityTexture: normalizeTextureAssetPath(parseOptionalText(item?.opacityTexture)),
      metallicFactor: parseUnitNumberOrNull(item?.metallicFactor),
      roughnessFactor: parseUnitNumberOrNull(item?.roughnessFactor),
      emissiveFactor: parseColorTriplet(item?.emissiveFactor),
      opacityFactor: parseUnitNumberOrNull(item?.opacityFactor),
      materialChannelSources: parseMaterialChannelSources(item?.materialChannelSources),
    });
  }

  for (const item of primitivesRaw) {
    const kind = parsePrimitiveKind(item?.kind);
    if (!kind) continue;

    const [px, py, pz] = parseNumberTriplet(item?.position, [0, 0, 0]);
    const [qw, qx, qy, qz] = parseNumberQuartet(item?.quaternion, [1, 0, 0, 0]);
    const [sx, sy, sz] = parseNumberTriplet(item?.scale, [1, 1, 1]);
    const quat = new THREE.Quaternion(qx, qy, qz, qw);
    if (quat.lengthSq() <= 1e-9) {
      quat.identity();
    } else {
      quat.normalize();
    }

    const radius = parsePositiveNumberOrNull(item?.radius);
    const height = parsePositiveNumberOrNull(item?.height);
    const size =
      kind === "cube"
        ? parseNumberTriplet(item?.size, [0.1, 0.1, 0.1]).map((value) =>
            Math.max(1e-6, Number.isFinite(value) ? value : 0.1)
          ) as [number, number, number]
        : null;

    if ((kind === "sphere" || kind === "capsule" || kind === "cylinder" || kind === "cone") && !radius) {
      continue;
    }
    if ((kind === "capsule" || kind === "cylinder" || kind === "cone") && !height) {
      continue;
    }

    primitives.push({
      name: String(item?.name ?? "").trim() || `primitive_${primitives.length + 1}`,
      primPath: String(item?.primPath ?? "").trim(),
      parentBody: normalizeBodyToken(item?.parentBody),
      parentBodyPath: parseOptionalText(item?.parentBodyPath),
      kind,
      position: [px, py, pz],
      quaternion: quat,
      scale: [
        Math.max(1e-6, Number.isFinite(sx) ? sx : 1),
        Math.max(1e-6, Number.isFinite(sy) ? sy : 1),
        Math.max(1e-6, Number.isFinite(sz) ? sz : 1),
      ],
      axis: parseAxisToken(item?.axis),
      radius,
      height,
      size,
      rgba: parseMeshRgba(item?.rgba),
      materialName: parseOptionalText(item?.materialName),
      materialSource: parseOptionalText(item?.materialSource),
      baseColorTexture: normalizeTextureAssetPath(parseOptionalText(item?.baseColorTexture)),
      normalTexture: normalizeTextureAssetPath(parseOptionalText(item?.normalTexture)),
      metallicTexture: normalizeTextureAssetPath(parseOptionalText(item?.metallicTexture)),
      roughnessTexture: normalizeTextureAssetPath(parseOptionalText(item?.roughnessTexture)),
      metallicRoughnessTexture: normalizeTextureAssetPath(parseOptionalText(item?.metallicRoughnessTexture)),
      occlusionTexture: normalizeTextureAssetPath(parseOptionalText(item?.occlusionTexture)),
      emissiveTexture: normalizeTextureAssetPath(parseOptionalText(item?.emissiveTexture)),
      opacityTexture: normalizeTextureAssetPath(parseOptionalText(item?.opacityTexture)),
      metallicFactor: parseUnitNumberOrNull(item?.metallicFactor),
      roughnessFactor: parseUnitNumberOrNull(item?.roughnessFactor),
      emissiveFactor: parseColorTriplet(item?.emissiveFactor),
      opacityFactor: parseUnitNumberOrNull(item?.opacityFactor),
      materialChannelSources: parseMaterialChannelSources(item?.materialChannelSources),
    });
  }

  for (const item of bodiesRaw) {
    const name = normalizeBodyToken(item?.name) ?? String(item?.name ?? "").trim();
    if (!name) continue;
    const [px, py, pz] = parseNumberTriplet(item?.position, [0, 0, 0]);
    const [qw, qx, qy, qz] = parseNumberQuartet(item?.quaternion, [1, 0, 0, 0]);
    const [sx, sy, sz] = parseNumberTriplet(item?.scale, [1, 1, 1]);
    const quat = new THREE.Quaternion(qx, qy, qz, qw);
    if (quat.lengthSq() <= 1e-9) {
      quat.identity();
    } else {
      quat.normalize();
    }

    bodies.push({
      name,
      primPath: String(item?.primPath ?? "").trim(),
      parentBody: normalizeBodyToken(item?.parentBody),
      parentBodyPath: parseOptionalText(item?.parentBodyPath),
      position: [px, py, pz],
      quaternion: quat,
      scale: [
        Math.max(1e-6, Number.isFinite(sx) ? sx : 1),
        Math.max(1e-6, Number.isFinite(sy) ? sy : 1),
        Math.max(1e-6, Number.isFinite(sz) ? sz : 1),
      ],
      rigidBodyEnabled:
        typeof item?.rigidBodyEnabled === "boolean" ? item.rigidBodyEnabled : null,
      kinematicEnabled:
        typeof item?.kinematicEnabled === "boolean" ? item.kinematicEnabled : null,
      mass: Number.isFinite(Number(item?.mass)) ? Math.max(0, Number(item?.mass)) : null,
    });
  }

  if (meshes.length === 0 && primitives.length === 0 && bodies.length === 0) return null;

  return {
    assetId: String(payload.assetId ?? "").trim() || fallbackAssetId,
    filename: String(payload.filename ?? "").trim(),
    stageUpAxis: parseStageUpAxis(payload.stageUpAxis),
    normalizedToZUp: parseOptionalBoolean(payload.normalizedToZUp) ?? false,
    meshCount: Number.isFinite(Number(payload.meshCount)) ? Math.max(0, Math.trunc(Number(payload.meshCount))) : meshes.length,
    primitiveCount: Number.isFinite(Number(payload.primitiveCount))
      ? Math.max(0, Math.trunc(Number(payload.primitiveCount)))
      : primitives.length,
    bodyCount: Number.isFinite(Number(payload.bodyCount)) ? Math.max(0, Math.trunc(Number(payload.bodyCount))) : bodies.length,
    truncated: Boolean(payload.truncated),
    meshes,
    primitives,
    bodies,
  };
};
