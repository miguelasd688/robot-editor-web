import * as THREE from "three";
import { DEFAULT_VISUAL_RGBA } from "./types";
import type {
  NormalizedUsdMaterialChannelSources,
  UsdMaterialChannelKey,
  UsdTextureColorSpace,
  ResolvedUsdMaterialTextures,
} from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ABSOLUTE_URL_RE = /^(?:https?:\/\/|blob:|data:)/i;
export const OPACITY_TEXTURE_HINT_RE = /(opacity|alpha|transparen|cutout|mask|coverage)/i;
export const TRANSPARENT_MATERIAL_HINT_RE =
  /(glass|transparen|window|windscreen|visor|lens|screen|clear|acrylic|polycarbonate|water|liquid)/i;
export const NORMAL_TEXTURE_HINT_RE = /(normal|normalmap|normal_map|normals|nrm)/i;
export const EMISSIVE_TEXTURE_HINT_RE = /(emissive|emission|self[_-]?illum|glow)/i;
export const OCCLUSION_TEXTURE_HINT_RE = /(occlusion|ambient[_-]?occlusion|ao|orm|rma|arm)/i;
export const METALLIC_TEXTURE_HINT_RE = /(metal|metalness|metallic|orm|rma|arm|mrao)/i;
export const ROUGHNESS_TEXTURE_HINT_RE = /(rough|roughness|orm|rma|arm|mrao)/i;
export const METALLIC_INTENT_HINT_RE = /(metal|metallic|chrome|steel|iron|aluminum|aluminium|brass|copper|gold|silver)/i;
export const usdTextureLoader = new THREE.TextureLoader();
export const usdTextureCache = new Map<string, THREE.Texture>();

// ---------------------------------------------------------------------------
// Texture helpers
// ---------------------------------------------------------------------------

export const normalizeTextureAssetPath = (value: string | null): string | null => {
  if (!value) return null;
  const normalized = value.replace(/^@+|@+$/g, "").trim();
  if (!normalized) return null;
  return normalized;
};

export const resolveUsdTextureUrl = (
  texturePath: string | null,
  resolveResource?: (resourcePath: string) => string | null
) => {
  const normalized = normalizeTextureAssetPath(texturePath);
  if (!normalized) return null;
  if (ABSOLUTE_URL_RE.test(normalized)) return normalized;
  return resolveResource?.(normalized) ?? null;
};

export const resolveUsdMaterialTextures = (
  input: {
    baseColorTexture: string | null;
    normalTexture: string | null;
    metallicTexture: string | null;
    roughnessTexture: string | null;
    metallicRoughnessTexture: string | null;
    occlusionTexture: string | null;
    emissiveTexture: string | null;
    opacityTexture: string | null;
  },
  resolveResource?: (resourcePath: string) => string | null
): ResolvedUsdMaterialTextures => ({
  baseColorUrl: resolveUsdTextureUrl(input.baseColorTexture, resolveResource),
  normalUrl: resolveUsdTextureUrl(input.normalTexture, resolveResource),
  metallicUrl: resolveUsdTextureUrl(input.metallicTexture, resolveResource),
  roughnessUrl: resolveUsdTextureUrl(input.roughnessTexture, resolveResource),
  metallicRoughnessUrl: resolveUsdTextureUrl(input.metallicRoughnessTexture, resolveResource),
  occlusionUrl: resolveUsdTextureUrl(input.occlusionTexture, resolveResource),
  emissiveUrl: resolveUsdTextureUrl(input.emissiveTexture, resolveResource),
  opacityUrl: resolveUsdTextureUrl(input.opacityTexture, resolveResource),
});

// ---------------------------------------------------------------------------
// Channel intent heuristics
// ---------------------------------------------------------------------------

export const maxColorComponent = (value: [number, number, number] | null | undefined) =>
  value ? Math.max(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0) : 0;

export const looksLikeOpacityTexture = (url: string | null | undefined) =>
  typeof url === "string" && OPACITY_TEXTURE_HINT_RE.test(url.toLowerCase());

export const looksLikeTransparentMaterialName = (name: string | null | undefined) =>
  typeof name === "string" && TRANSPARENT_MATERIAL_HINT_RE.test(name.toLowerCase());

export const looksLikeNormalTexture = (url: string | null | undefined) =>
  typeof url === "string" && NORMAL_TEXTURE_HINT_RE.test(url.toLowerCase());

export const looksLikeEmissiveTexture = (url: string | null | undefined) =>
  typeof url === "string" && EMISSIVE_TEXTURE_HINT_RE.test(url.toLowerCase());

export const looksLikeOcclusionTexture = (url: string | null | undefined) =>
  typeof url === "string" && OCCLUSION_TEXTURE_HINT_RE.test(url.toLowerCase());

export const looksLikeMetallicTexture = (url: string | null | undefined) =>
  typeof url === "string" && METALLIC_TEXTURE_HINT_RE.test(url.toLowerCase());

export const looksLikeRoughnessTexture = (url: string | null | undefined) =>
  typeof url === "string" && ROUGHNESS_TEXTURE_HINT_RE.test(url.toLowerCase());

export const looksLikeMetallicIntent = (value: string | null | undefined) =>
  typeof value === "string" && METALLIC_INTENT_HINT_RE.test(value.toLowerCase());

export const sameTextureReference = (left: string | null | undefined, right: string | null | undefined) =>
  typeof left === "string" &&
  typeof right === "string" &&
  left.trim().toLowerCase() === right.trim().toLowerCase();

export const isExplicitMaterialChannel = (
  sources: NormalizedUsdMaterialChannelSources | null | undefined,
  channel: UsdMaterialChannelKey
) => sources?.[channel] === "explicit";

export const hasMaterialChannelIntent = (
  channel: UsdMaterialChannelKey,
  textureUrl: string | null | undefined,
  sources: NormalizedUsdMaterialChannelSources | null | undefined
): boolean => {
  if (isExplicitMaterialChannel(sources, channel)) return true;
  if (channel === "baseColor") return true;
  if (channel === "normal") return looksLikeNormalTexture(textureUrl);
  if (channel === "metallic") return looksLikeMetallicTexture(textureUrl);
  if (channel === "roughness") return looksLikeRoughnessTexture(textureUrl);
  if (channel === "metallicRoughness") {
    return looksLikeMetallicTexture(textureUrl) || looksLikeRoughnessTexture(textureUrl);
  }
  if (channel === "occlusion") return looksLikeOcclusionTexture(textureUrl);
  if (channel === "emissive") return looksLikeEmissiveTexture(textureUrl);
  if (channel === "opacity") return looksLikeOpacityTexture(textureUrl);
  return false;
};

export const __testOnlyHasMaterialChannelIntent = hasMaterialChannelIntent;

// ---------------------------------------------------------------------------
// Texture loading
// ---------------------------------------------------------------------------

export const getOrLoadUsdTexture = (url: string, colorSpace: UsdTextureColorSpace) => {
  const cacheKey = `${colorSpace}:${url}`;
  const cached = usdTextureCache.get(cacheKey);
  if (cached) return cached;
  const texture = usdTextureLoader.load(url);
  texture.colorSpace = colorSpace === "srgb" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  usdTextureCache.set(cacheKey, texture);
  return texture;
};

// ---------------------------------------------------------------------------
// Material creation
// ---------------------------------------------------------------------------

export const createUsdVisualMaterial = (
  rgba: [number, number, number, number] | null,
  options?: {
    textures?: ResolvedUsdMaterialTextures;
    materialName?: string | null;
    materialChannelSources?: NormalizedUsdMaterialChannelSources | null;
    metallicFactor?: number | null;
    roughnessFactor?: number | null;
    emissiveFactor?: [number, number, number] | null;
    opacityFactor?: number | null;
  }
) => {
  const colorRgba = rgba ?? DEFAULT_VISUAL_RGBA;
  const channelSources = options?.materialChannelSources ?? null;
  const hasResolvedOpacityTexture = Boolean(options?.textures?.opacityUrl);
  const hasOpacityTextureIntent = hasMaterialChannelIntent("opacity", options?.textures?.opacityUrl ?? null, channelSources);
  const hasTransparentMaterialName = looksLikeTransparentMaterialName(options?.materialName ?? null);
  const rawOpacityFactor = options?.opacityFactor;
  const normalizedOpacityFactor =
    typeof rawOpacityFactor === "number" && Number.isFinite(rawOpacityFactor)
      ? Math.max(0, Math.min(1, rawOpacityFactor))
      : null;
  const baseAlpha = Math.max(0, Math.min(1, colorRgba[3]));
  const opacityChannelEnabled =
    (hasResolvedOpacityTexture && hasOpacityTextureIntent) || hasTransparentMaterialName;
  let opacity = Math.max(0.02, Math.min(1, opacityChannelEnabled ? normalizedOpacityFactor ?? baseAlpha : 1));
  if (!opacityChannelEnabled) {
    opacity = 1;
  }
  if (opacity < 0.15 && !hasOpacityTextureIntent && !hasTransparentMaterialName) {
    opacity = 1;
  }
  const textures = options?.textures;
  const baseColorUrl = textures?.baseColorUrl ?? null;
  const hasNormalTextureIntent = hasMaterialChannelIntent("normal", textures?.normalUrl ?? null, channelSources);
  const hasMetallicTextureIntent =
    hasMaterialChannelIntent("metallic", textures?.metallicUrl ?? null, channelSources) ||
    hasMaterialChannelIntent("metallicRoughness", textures?.metallicRoughnessUrl ?? null, channelSources);
  const hasRoughnessTextureIntent =
    hasMaterialChannelIntent("roughness", textures?.roughnessUrl ?? null, channelSources) ||
    hasMaterialChannelIntent("metallicRoughness", textures?.metallicRoughnessUrl ?? null, channelSources);
  const hasUsableNormalTexture =
    Boolean(textures?.normalUrl) &&
    hasNormalTextureIntent &&
    !sameTextureReference(textures?.normalUrl, baseColorUrl);
  const hasUsableMetallicTexture =
    Boolean(textures?.metallicUrl) &&
    hasMetallicTextureIntent &&
    !sameTextureReference(textures?.metallicUrl, baseColorUrl);
  const hasUsableRoughnessTexture =
    Boolean(textures?.roughnessUrl) &&
    hasRoughnessTextureIntent &&
    !sameTextureReference(textures?.roughnessUrl, baseColorUrl);
  const hasUsablePackedMetallicRoughnessTexture =
    Boolean(textures?.metallicRoughnessUrl) &&
    (hasMetallicTextureIntent || hasRoughnessTextureIntent) &&
    !sameTextureReference(textures?.metallicRoughnessUrl, baseColorUrl);
  const hasMetallicTexture =
    hasUsableMetallicTexture || (hasUsablePackedMetallicRoughnessTexture && hasMetallicTextureIntent);
  const hasMetallicIntent =
    hasMetallicTexture ||
    looksLikeMetallicIntent(options?.materialName ?? null) ||
    (typeof options?.metallicFactor === "number" && options.metallicFactor >= 0.4);
  const metallic = hasMetallicIntent ? Math.max(0, Math.min(0.08, options?.metallicFactor ?? 0.02)) : 0;
  const roughness = Math.max(0.72, Math.min(1, options?.roughnessFactor ?? 0.94));
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(colorRgba[0], colorRgba[1], colorRgba[2]),
    transparent: opacityChannelEnabled && opacity < 0.999,
    opacity,
    metalness: metallic,
    roughness,
    envMapIntensity: 0.08,
    side: THREE.DoubleSide,
  });

  if (textures?.baseColorUrl) {
    material.map = getOrLoadUsdTexture(textures.baseColorUrl, "srgb");
  }
  if (hasUsableNormalTexture && textures?.normalUrl) {
    material.normalMap = getOrLoadUsdTexture(textures.normalUrl, "linear");
  }
  if (hasUsablePackedMetallicRoughnessTexture && textures?.metallicRoughnessUrl) {
    const orm = getOrLoadUsdTexture(textures.metallicRoughnessUrl, "linear");
    if (hasRoughnessTextureIntent) {
      material.roughnessMap = orm;
    }
    if (hasMetallicIntent && hasMetallicTextureIntent) {
      material.metalnessMap = orm;
    }
  } else {
    if (hasMetallicIntent && hasUsableMetallicTexture && textures?.metallicUrl) {
      material.metalnessMap = getOrLoadUsdTexture(textures.metallicUrl, "linear");
    }
    if (hasUsableRoughnessTexture && textures?.roughnessUrl) {
      material.roughnessMap = getOrLoadUsdTexture(textures.roughnessUrl, "linear");
    }
  }
  if (textures?.occlusionUrl) {
    if (hasMaterialChannelIntent("occlusion", textures.occlusionUrl, channelSources)) {
      material.aoMap = getOrLoadUsdTexture(textures.occlusionUrl, "linear");
      material.aoMapIntensity = 0.42;
    }
  }
  const hasEmissiveFactor = maxColorComponent(options?.emissiveFactor) > 0.01;
  const hasEmissiveMapIntent = hasMaterialChannelIntent("emissive", textures?.emissiveUrl ?? null, channelSources);
  if (textures?.emissiveUrl && hasEmissiveMapIntent) {
    material.emissiveMap = getOrLoadUsdTexture(textures.emissiveUrl, "srgb");
  }
  if (hasEmissiveFactor || hasEmissiveMapIntent) {
    if (options?.emissiveFactor) {
      material.emissive = new THREE.Color(
        options.emissiveFactor[0],
        options.emissiveFactor[1],
        options.emissiveFactor[2]
      );
      material.emissiveIntensity = 1.0;
    } else {
      material.emissive = new THREE.Color(1, 1, 1);
      material.emissiveIntensity = 0.28;
    }
  }
  if (textures?.opacityUrl && opacityChannelEnabled && hasOpacityTextureIntent) {
    material.alphaMap = getOrLoadUsdTexture(textures.opacityUrl, "linear");
    material.transparent = true;
    material.alphaTest = 0.08;
    material.depthWrite = false;
  }
  (material.userData ??= {}).viewportSurfaceProfile = "usd_pbr";
  if (options?.materialName) {
    material.name = options.materialName;
  }
  material.needsUpdate = true;
  return material;
};

export const createUsdCollisionMaterial = () =>
  new THREE.MeshBasicMaterial({
    color: 0x8c5a2b,
    transparent: true,
    opacity: 0.38,
    wireframe: false,
    depthWrite: false,
  });
