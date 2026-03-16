import * as THREE from "three";

const DEFAULT_FLOOR_SIZE = 6;
const FLOOR_MAP_REPEAT = 6;
const FLOOR_NOISE_REPEAT = 24;
const FLOOR_MAP_ANISOTROPY = 16;
const FLOOR_NOISE_ANISOTROPY = 8;
const UV_EPSILON = 1e-9;

let cachedFloorMap: THREE.Texture | null = null;
let cachedFloorNoise: THREE.Texture | null = null;

const normalizeWorkspaceKey = (value: string): string =>
  String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^[./]+/, "")
    .replace(/^\/+/, "")
    .replace(/[?#].*$/, "")
    .toLowerCase();

export function isDefaultFloorWorkspaceKey(workspaceKey: string): boolean {
  const normalized = normalizeWorkspaceKey(workspaceKey);
  return (
    normalized === "library/floors/flat_floor.usda" ||
    normalized === "library/floors/flat_floor.usd" ||
    normalized === "library/floors/flat_floor.usdc" ||
    normalized === "library/floors/flat_floor.usdz"
  );
}

const createBlueFloorTexture = () => {
  const size = 1024;
  const tile = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    const fallback = new THREE.Texture();
    fallback.needsUpdate = true;
    return fallback;
  }

  ctx.fillStyle = "#274f79";
  ctx.fillRect(0, 0, size, size);

  for (let y = 0; y < size; y += tile) {
    for (let x = 0; x < size; x += tile) {
      const isEven = ((x / tile + y / tile) & 1) === 0;
      ctx.fillStyle = isEven ? "#336190" : "#2a557f";
      ctx.fillRect(x, y, tile, tile);
    }
  }

  ctx.strokeStyle = "rgba(16,34,52,0.26)";
  ctx.lineWidth = 1;
  for (let p = 0; p <= size; p += tile) {
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.stroke();
  }

  const major = tile * 2;
  ctx.strokeStyle = "rgba(12,26,40,0.4)";
  ctx.lineWidth = 2;
  for (let p = 0; p <= size; p += major) {
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(FLOOR_MAP_REPEAT, FLOOR_MAP_REPEAT);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = FLOOR_MAP_ANISOTROPY;
  texture.needsUpdate = true;
  return texture;
};

const createFloorNoiseTexture = () => {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    const fallback = new THREE.Texture();
    fallback.needsUpdate = true;
    return fallback;
  }

  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const seed = Math.sin((x + 17.3) * 12.9898 + (y + 3.7) * 78.233) * 43758.5453123;
      const noise = seed - Math.floor(seed);
      const value = Math.floor(98 + noise * 94);
      image.data[i] = value;
      image.data[i + 1] = value;
      image.data[i + 2] = value;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(FLOOR_NOISE_REPEAT, FLOOR_NOISE_REPEAT);
  texture.colorSpace = THREE.NoColorSpace;
  texture.anisotropy = FLOOR_NOISE_ANISOTROPY;
  texture.needsUpdate = true;
  return texture;
};

const getSharedFloorMap = () => {
  if (cachedFloorMap) return cachedFloorMap;
  cachedFloorMap = createBlueFloorTexture();
  return cachedFloorMap;
};

const getSharedFloorNoise = () => {
  if (cachedFloorNoise) return cachedFloorNoise;
  cachedFloorNoise = createFloorNoiseTexture();
  return cachedFloorNoise;
};

const ensurePlanarUv = (geometry: THREE.BufferGeometry) => {
  const position = geometry.getAttribute("position");
  if (!(position instanceof THREE.BufferAttribute)) return;
  const hasUv = geometry.getAttribute("uv");
  if (hasUv instanceof THREE.BufferAttribute && hasUv.count === position.count) return;

  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox;
  if (!bbox) return;
  const spanX = Math.max(UV_EPSILON, bbox.max.x - bbox.min.x);
  const spanY = Math.max(UV_EPSILON, bbox.max.y - bbox.min.y);
  const uv = new Float32Array(position.count * 2);

  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    uv[i * 2] = (x - bbox.min.x) / spanX;
    uv[i * 2 + 1] = (y - bbox.min.y) / spanY;
  }

  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geometry.attributes.uv.needsUpdate = true;
}

export function createDefaultFloorGeometry(): THREE.PlaneGeometry {
  return new THREE.PlaneGeometry(DEFAULT_FLOOR_SIZE, DEFAULT_FLOOR_SIZE, 1, 1);
}

export function createDefaultFloorMaterial(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: getSharedFloorMap(),
    roughnessMap: getSharedFloorNoise(),
    bumpMap: getSharedFloorNoise(),
    bumpScale: 0.02,
    roughness: 0.42,
    metalness: 0.2,
    clearcoat: 0.18,
    clearcoatRoughness: 0.62,
    reflectivity: 0.5,
    envMapIntensity: 0.62,
  });
}

export function applyDefaultFloorAppearanceToMesh(
  mesh: THREE.Mesh,
  sharedMaterial?: THREE.MeshPhysicalMaterial
): void {
  ensurePlanarUv(mesh.geometry);
  mesh.material = sharedMaterial ?? createDefaultFloorMaterial();
  mesh.receiveShadow = true;
  mesh.castShadow = false;
}

