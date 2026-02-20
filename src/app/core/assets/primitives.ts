import * as THREE from "three";

export type PrimitiveShape = "cube" | "sphere" | "cylinder" | "plane";

const NON_PICKABLE_KEY = "__nonPickable";

const createSurfaceLineOverlay = (mesh: THREE.Mesh, color = 0x1a2535, opacity = 0.2) => {
  const overlay = new THREE.Mesh(
    mesh.geometry,
    new THREE.MeshBasicMaterial({
      color,
      wireframe: true,
      transparent: true,
      opacity,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    })
  );
  overlay.name = "__primitive_surface_lines__";
  overlay.renderOrder = mesh.renderOrder + 1;
  overlay.castShadow = false;
  overlay.receiveShadow = false;
  overlay.userData[NON_PICKABLE_KEY] = true;
  mesh.add(overlay);
};

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
  texture.repeat.set(6, 6);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 16;
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
  texture.repeat.set(24, 24);
  texture.colorSpace = THREE.NoColorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
};

export function createPrimitiveObject(shape: PrimitiveShape): THREE.Object3D {
  if (shape === "cube") {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0x7aa2ff,
      roughness: 0.36,
      metalness: 0.12,
      clearcoat: 0.2,
      clearcoatRoughness: 0.28,
      envMapIntensity: 1.05,
    });
    const mesh = new THREE.Mesh(geo, mat);
    createSurfaceLineOverlay(mesh, 0x202c40, 0.26);
    return mesh;
  }
  if (shape === "sphere") {
    const geo = new THREE.SphereGeometry(0.5, 28, 18);
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0x7fd4ff,
      roughness: 0.3,
      metalness: 0.16,
      clearcoat: 0.26,
      clearcoatRoughness: 0.24,
      envMapIntensity: 1.08,
    });
    const mesh = new THREE.Mesh(geo, mat);
    createSurfaceLineOverlay(mesh, 0x1d2738, 0.14);
    return mesh;
  }
  if (shape === "cylinder") {
    const geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 28, 1);
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xf2b26b,
      roughness: 0.34,
      metalness: 0.14,
      clearcoat: 0.22,
      clearcoatRoughness: 0.3,
      envMapIntensity: 1.05,
    });
    const mesh = new THREE.Mesh(geo, mat);
    createSurfaceLineOverlay(mesh, 0x2a231f, 0.16);
    return mesh;
  }

  const geo = new THREE.PlaneGeometry(6, 6, 1, 1);
  const floorMap = createBlueFloorTexture();
  const floorNoise = createFloorNoiseTexture();
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: floorMap,
    roughnessMap: floorNoise,
    bumpMap: floorNoise,
    bumpScale: 0.02,
    roughness: 0.42,
    metalness: 0.2,
    clearcoat: 0.18,
    clearcoatRoughness: 0.62,
    reflectivity: 0.5,
    envMapIntensity: 0.62,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  return mesh;
}
