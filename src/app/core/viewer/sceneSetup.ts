import * as THREE from "three";
import { OrbitControls, TransformControls } from "three-stdlib";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { TransformSettings } from "./types";
import { getDocId } from "../scene/docIds";

type PlaneScaleAxis = "XY" | "XZ" | "YZ";

const SCALE_EPS = 1e-6;
const TRANSFORM_DEBUG = String(import.meta.env.VITE_EDITOR_TRANSFORM_DEBUG ?? "true").toLowerCase() !== "false";

const isPlaneScaleAxis = (axis: string | null | undefined): axis is PlaneScaleAxis =>
  axis === "XY" || axis === "XZ" || axis === "YZ";

const safeScaleRatio = (to: number, from: number) => (Math.abs(from) > SCALE_EPS ? to / from : 1);

const computeUniformPlaneRatio = (current: THREE.Vector3, start: THREE.Vector3, axis: PlaneScaleAxis) => {
  const rawRatios =
    axis === "XY"
      ? [safeScaleRatio(current.x, start.x), safeScaleRatio(current.y, start.y)]
      : axis === "XZ"
        ? [safeScaleRatio(current.x, start.x), safeScaleRatio(current.z, start.z)]
        : [safeScaleRatio(current.y, start.y), safeScaleRatio(current.z, start.z)];
  const ratios = rawRatios.filter((ratio) => Number.isFinite(ratio) && Math.abs(ratio) > SCALE_EPS);
  if (!ratios.length) return 1;
  const signSeed = ratios.reduce((sum, ratio) => sum + ratio, 0);
  const sign = signSeed === 0 ? 1 : Math.sign(signSeed);
  const logAvg = ratios.reduce((sum, ratio) => sum + Math.log(Math.abs(ratio)), 0) / ratios.length;
  return sign * Math.exp(logAvg);
};

const applyUniformPlaneScale = (obj: THREE.Object3D, axis: PlaneScaleAxis, startScale: THREE.Vector3) => {
  const ratio = computeUniformPlaneRatio(obj.scale, startScale, axis);
  if (!Number.isFinite(ratio)) return;
  if (axis === "XY") {
    obj.scale.x = startScale.x * ratio;
    obj.scale.y = startScale.y * ratio;
    return;
  }
  if (axis === "XZ") {
    obj.scale.x = startScale.x * ratio;
    obj.scale.z = startScale.z * ratio;
    return;
  }
  obj.scale.y = startScale.y * ratio;
  obj.scale.z = startScale.z * ratio;
};

const debugTransform = (event: string, data?: Record<string, unknown>) => {
  if (!TRANSFORM_DEBUG) return;
  console.debug(`[viewer:gizmo] ${event}`, data ?? {});
};

const localPoseForLog = (obj: THREE.Object3D) => ({
  position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
  rotation: { x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z },
  scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z },
});

export type SceneSetupResult = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  transformControls: TransformControls;
  userRoot: THREE.Group;
  baseRoots: THREE.Object3D[];
};

export function createSceneBundle(
  canvas: HTMLCanvasElement,
  settings: TransformSettings,
  onTransformChange?: (id: string) => void,
  onTransformEnd?: (id: string) => void
): SceneSetupResult;
export function createSceneBundle(
  canvas: HTMLCanvasElement,
  settings: TransformSettings,
  onDraggingChange?: (dragging: boolean) => void,
  onTransformChange?: (id: string) => void,
  onTransformEnd?: (id: string) => void
): SceneSetupResult;
export function createSceneBundle(
  canvas: HTMLCanvasElement,
  settings: TransformSettings,
  arg3?: ((dragging: boolean) => void) | ((id: string) => void),
  arg4?: (id: string) => void,
  arg5?: (id: string) => void
): SceneSetupResult {
  const argCount = arguments.length;
  const onDraggingChange = argCount >= 5 ? (arg3 as (dragging: boolean) => void) : undefined;
  const onTransformChange = argCount >= 5 ? arg4 : (arg3 as (id: string) => void | undefined);
  const onTransformEnd = argCount >= 5 ? arg5 : arg4;
  const getTransformObject = (controls: TransformControls) =>
    (controls as unknown as { object?: THREE.Object3D }).object;
  const getTransformAxis = (controls: TransformControls) =>
    (controls as unknown as { axis?: string | null }).axis ?? null;
  let activePlaneScaleAxis: PlaneScaleAxis | null = null;
  let isDragging = false;
  const planeScaleStart = new THREE.Vector3(1, 1, 1);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio ?? 1, 2));
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.03;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;
  renderer.setClearColor(0x091425, 1);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1930);
  scene.fog = new THREE.Fog(0x0b1930, 30, 190);

  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  const environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = environment.texture;
  pmremGenerator.dispose();

  const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 2000);
  camera.layers.enable(1);
  camera.position.set(2.5, 2.0, 3.5);
  camera.lookAt(0, 0, 0);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.target.set(0, 0.75, 0);

  const transformControls = new TransformControls(camera, canvas);
  transformControls.setMode(settings.mode);
  transformControls.setSpace(settings.space);
  transformControls.setTranslationSnap(settings.translationSnap ?? 0);
  transformControls.setRotationSnap(settings.rotationSnap ?? 0);
  transformControls.visible = false;
  transformControls.layers.set(1);
  transformControls.traverse((child) => child.layers.set(1));
  const transformRaycaster =
    (
      transformControls as unknown as {
        getRaycaster?: () => THREE.Raycaster;
      }
    ).getRaycaster?.() ??
    (
      transformControls as unknown as {
        raycaster?: THREE.Raycaster;
      }
    ).raycaster;
  transformRaycaster?.layers.enable(1);
  const addControlListener = <TEvent = unknown>(type: string, handler: (event: TEvent) => void) => {
    (
      transformControls as unknown as {
        addEventListener: (t: string, cb: (event: TEvent) => void) => void;
      }
    ).addEventListener(type, handler);
  };
  addControlListener<{ value: boolean }>("dragging-changed", (event) => {
    isDragging = event.value;
    controls.enabled = !event.value;
    if (!event.value) activePlaneScaleAxis = null;
    onDraggingChange?.(event.value);
  });
  addControlListener("mouseDown", () => {
    const obj = getTransformObject(transformControls);
    const axis = getTransformAxis(transformControls);
    if (obj) {
      debugTransform("drag.start", {
        id: getDocId(obj),
        mode: transformControls.getMode(),
        axis,
        local: localPoseForLog(obj),
      });
    }
    if (obj && transformControls.getMode() === "scale" && isPlaneScaleAxis(axis)) {
      activePlaneScaleAxis = axis;
      planeScaleStart.copy(obj.scale);
      return;
    }
    activePlaneScaleAxis = null;
  });
  addControlListener("objectChange", () => {
    if (!isDragging) return;
    const obj = getTransformObject(transformControls);
    if (obj && transformControls.getMode() === "scale" && activePlaneScaleAxis) {
      applyUniformPlaneScale(obj, activePlaneScaleAxis, planeScaleStart);
    }
    if (obj) {
      debugTransform("drag.change", {
        id: getDocId(obj),
        mode: transformControls.getMode(),
        axis: getTransformAxis(transformControls),
        local: localPoseForLog(obj),
      });
      onTransformChange?.(getDocId(obj));
    }
  });
  addControlListener("mouseUp", () => {
    const obj = getTransformObject(transformControls);
    activePlaneScaleAxis = null;
    if (obj) {
      debugTransform("drag.end", {
        id: getDocId(obj),
        mode: transformControls.getMode(),
        local: localPoseForLog(obj),
      });
      onTransformEnd?.(getDocId(obj));
    }
  });
  scene.add(transformControls);

  const hemi = new THREE.HemisphereLight(0x9dbde0, 0x0a1524, 0.28);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xf8fcff, 1.8);
  key.position.set(8, 12, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.camera.near = 0.1;
  key.shadow.camera.far = 80;
  key.shadow.camera.left = -24;
  key.shadow.camera.right = 24;
  key.shadow.camera.top = 24;
  key.shadow.camera.bottom = -24;
  key.shadow.normalBias = 0.02;
  key.shadow.bias = -0.0003;
  key.shadow.radius = 2.4;
  key.shadow.blurSamples = 8;
  key.userData.shadowDirection = key.position.clone().normalize();
  key.target.position.set(0, 0, 0);
  scene.add(key.target);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x5f89b8, 0.2);
  fill.position.set(-8, 6, -5);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0x8db0d4, 0.16);
  rim.position.set(6, 4, -8);
  scene.add(rim);

  const userRoot = new THREE.Group();
  userRoot.name = "__USER_ROOT__";
  scene.add(userRoot);

  return {
    renderer,
    scene,
    camera,
    controls,
    transformControls,
    userRoot,
    baseRoots: [camera, hemi, key, key.target, fill, rim],
  };
}
