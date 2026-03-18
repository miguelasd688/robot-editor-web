/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from "three";
import type { OrbitControls, TransformControls } from "three-stdlib";
import { Reflector } from "three/addons/objects/Reflector.js";
import type {
  ViewerEvents,
  PickResult,
  SceneSnapshot,
  SceneNodeKind,
  TransformSettings,
  PointerEventInfo,
  PointerMoveEventInfo,
  PointerSpringVisual,
} from "./types";
import { createSceneBundle } from "./sceneSetup";
import { SelectionManager } from "./selectionManager";
import { disposeObject3D, registerHierarchy, registerObject, unregisterHierarchy } from "./objectRegistry";
import { isManagedSceneObject, markSceneNode } from "./sceneObjectFlags";
import type { UrdfInstance } from "../urdf/urdfModel";
import type { InertiaTensor } from "../assets/types";
import { computeComRadius, computeInertiaBox } from "../physics/inertiaDebug";
import { ensureUserInstance } from "../assets/assetInstance";
import { getDocId } from "../scene/docIds";
import type { MujocoRuntimeColliderSnapshot } from "../physics/mujoco/MujocoRuntime";

type UrdfDebugOptions = {
  showVisuals: boolean;
  showCollisions: boolean;
  showInertias: boolean;
  showCOM: boolean;
  showAxes: boolean;
  showJointAxes: boolean;
};

type HelperKind = "axis" | "joint-axis" | "com" | "inertia";

const URDF_HELPER_KEY = "__urdfHelper";
const NON_PICKABLE_KEY = "__nonPickable";
const URDF_VISUAL_MATERIAL_KEY = "__urdfVisualMaterial";
const URDF_VISUAL_OPACITY = 0.9;
const URDF_COLLISION_MATERIAL_KEY = "__urdfCollisionMaterial";
const URDF_COLLISION_COLOR = 0x8c5a2b;
const URDF_COLLISION_OPACITY = 0.45;
const INERTIA_BOX_SCALE = 1.1;
const VIEWPORT_EDGE_OVERLAY_KEY = "__viewportEdgeOverlay";
const VIEWPORT_EDGE_OVERLAY_NAME = "__viewport_mesh_edges__";
const PRIMITIVE_SURFACE_LINES_NAME = "__primitive_surface_lines__";
const FLOOR_REFLECTOR_KEY = "__floorReflector";
const FLOOR_REFLECTOR_NAME = "__floor_reflector__";
const FLOOR_SHADOW_CATCHER_KEY = "__floorShadowCatcher";
const FLOOR_SHADOW_CATCHER_NAME = "__floor_shadow_catcher__";
const RUNTIME_COLLIDER_ROOT_NAME = "__runtime_collision_overlay__";
const RUNTIME_COLLIDER_OBJECT_KEY = "__runtime_collider_object__";
const RUNTIME_COLLIDER_GEOMETRY_KEY = "__runtime_collider_geometry__";
const HELPER_LAYER = 1;
const ORIENTATION_GIZMO_SIZE_MIN_PX = 92;
const ORIENTATION_GIZMO_SIZE_MAX_PX = 156;
const ORIENTATION_GIZMO_MARGIN_PX = 14;
const FLOOR_REFLECTOR_SHADER = {
  name: "FloorReflectorSoftShader",
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    reflectionStrength: { value: 0.2 },
    blurAmount: { value: 0.0024 },
    fadeNear: { value: 2.2 },
    fadeFar: { value: 18.0 },
    noiseAmount: { value: 0.34 },
    noiseScale: { value: 220.0 },
  },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec3 vWorldPos;
    varying vec3 vWorldNormal;

    #include <common>
    #include <logdepthbuf_pars_vertex>

    void main() {
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      vWorldPos = worldPos.xyz;
      vWorldNormal = normalize(mat3(modelMatrix) * normal);
      vUv = textureMatrix * vec4(position, 1.0);

      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);

      #include <logdepthbuf_vertex>
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 color;
    uniform sampler2D tDiffuse;
    uniform float reflectionStrength;
    uniform float blurAmount;
    uniform float fadeNear;
    uniform float fadeFar;
    uniform float noiseAmount;
    uniform float noiseScale;

    varying vec4 vUv;
    varying vec3 vWorldPos;
    varying vec3 vWorldNormal;

    #include <common>
    #include <logdepthbuf_pars_fragment>

    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 34.45);
      return fract(p.x * p.y);
    }

    void main() {
      #include <logdepthbuf_fragment>

      vec2 uv = vUv.xy / max(vUv.w, 1e-5);
      uv = clamp(uv, vec2(0.001), vec2(0.999));

      vec2 spread = vec2(blurAmount);
      vec3 c0 = texture2D(tDiffuse, uv).rgb;
      vec3 c1 = texture2D(tDiffuse, uv + vec2(spread.x, 0.0)).rgb;
      vec3 c2 = texture2D(tDiffuse, uv - vec2(spread.x, 0.0)).rgb;
      vec3 c3 = texture2D(tDiffuse, uv + vec2(0.0, spread.y)).rgb;
      vec3 c4 = texture2D(tDiffuse, uv - vec2(0.0, spread.y)).rgb;
      vec3 reflected = c0 * 0.50 + (c1 + c2 + c3 + c4) * 0.125;

      float camDist = distance(cameraPosition, vWorldPos);
      float distFade = 1.0 - smoothstep(fadeNear, fadeFar, camDist);

      vec3 viewDir = normalize(cameraPosition - vWorldPos);
      float facing = clamp(dot(viewDir, normalize(vWorldNormal)), 0.0, 1.0);
      float fresnel = pow(1.0 - facing, 1.45);

      float noise = hash21(floor(uv * noiseScale));
      float roughMask = mix(1.0 - noiseAmount, 0.96, noise);

      float alpha = reflectionStrength * distFade * (0.38 + 0.52 * fresnel) * roughMask;
      vec3 tint = mix(vec3(1.0), color, 0.55);
      vec3 outColor = reflected * tint;

      gl_FragColor = vec4(outColor, clamp(alpha, 0.0, 0.29));

      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
};

const isThreeMaterial = (value: unknown): value is THREE.Material =>
  Boolean(value) && typeof (value as THREE.Material).clone === "function";

const cloneTransparentMaterial = (mat: unknown) => {
  if (!isThreeMaterial(mat)) {
    const fallback = new THREE.MeshBasicMaterial({ color: 0xffffff });
    fallback.transparent = true;
    fallback.opacity = URDF_VISUAL_OPACITY;
    fallback.depthWrite = false;
    return fallback;
  }
  const clone = mat.clone();
  clone.transparent = true;
  clone.opacity = URDF_VISUAL_OPACITY;
  clone.depthWrite = false;
  return clone;
};

const disposeMaterialSafe = (mat: unknown) => {
  if (!mat || typeof (mat as { dispose?: unknown }).dispose !== "function") return;
  (mat as THREE.Material).dispose();
};

const quatFromRpy = (rpy: [number, number, number]) => {
  const euler = new THREE.Euler(rpy[0], rpy[1], rpy[2], "ZYX");
  const q = new THREE.Quaternion();
  q.setFromEuler(euler);
  return q;
};

const inverseWorldScale = (obj: THREE.Object3D) => {
  const scale = new THREE.Vector3();
  obj.getWorldScale(scale);
  const safeInv = (value: number) => (Math.abs(value) > 1e-6 ? 1 / value : 1);
  return new THREE.Vector3(safeInv(scale.x), safeInv(scale.y), safeInv(scale.z));
};

const computeInertiaBoxForDebug = (mass: number, tensor: InertiaTensor) =>
  computeInertiaBox(tensor, { mass, massScale: "volume" });

export class Viewer {
  private canvas: HTMLCanvasElement | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private controls: OrbitControls | null = null;

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private animId: number | null = null;
  private lastFrameTime = 0;
  private frameCallback: ((dt: number) => void) | null = null;
  private pointerDownPos: { x: number; y: number } | null = null;
  private activePointerId: number | null = null;
  private activePointerConsumed = false;
  private pointerMovePos: { x: number; y: number } | null = null;
  private pointerSpringGroup: THREE.Group | null = null;
  private pointerSpringArrow: THREE.ArrowHelper | null = null;
  private runtimeColliderRoot: THREE.Group | null = null;
  private runtimeColliderObjects = new Map<string, THREE.Object3D>();
  private runtimeColliderGeometryCache = new Map<string, THREE.BufferGeometry>();
  private runtimeColliderMaterial: THREE.MeshBasicMaterial | null = null;
  private orientationScene: THREE.Scene | null = null;
  private orientationCamera: THREE.OrthographicCamera | null = null;
  private orientationAxesRoot: THREE.Group | null = null;
  private orientationLabelResources: Array<{ texture: THREE.CanvasTexture; material: THREE.SpriteMaterial }> = [];
  private viewportMaterialCache = new WeakMap<THREE.Material, THREE.Material>();

  // mapping docId -> Object3D
  private objects = new Map<string, THREE.Object3D>();

  // selection
  private selection = new SelectionManager();

  // transform gizmo
  private transformControls: TransformControls | null = null;
  private isTransformDragging = false;
  private transformMode: "translate" | "rotate" | "scale" = "translate";
  private transformSpace: "local" | "world" = "world";
  private translationSnap: number | null = null;
  private rotationSnap: number | null = null;
  private transformEnabled = true;

  private events: ViewerEvents = {};

  private urdfDebugOptions: UrdfDebugOptions = {
    showVisuals: true,
    showCollisions: false,
    showInertias: false,
    showCOM: false,
    showAxes: false,
    showJointAxes: false,
  };

  // root donde colgamos “lo importado”
  private userRoot: THREE.Group | null = null;
  private userRoots = new Map<string, THREE.Object3D>(); // docId -> Object3D
  private mainShadowLight: THREE.DirectionalLight | null = null;

  init(canvas: HTMLCanvasElement, events?: ViewerEvents) {
    this.canvas = canvas;
    this.events = events ?? {};

    const { renderer, scene, camera, controls, transformControls, userRoot, baseRoots } = createSceneBundle(
      canvas,
      this.getTransformSettings(),
      (dragging: boolean) => {
        this.isTransformDragging = dragging;
        this.events.onTransformDragging?.(dragging);
      },
      (id) => this.events.onTransformChange?.(id),
      (id) => this.events.onTransformEnd?.(id)
    );

    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.controls = controls;
    this.userRoot = userRoot;
    this.transformControls = transformControls;
    this.setTransformControlsEnabled(this.transformEnabled);
    this.mainShadowLight =
      baseRoots.find(
        (root): root is THREE.DirectionalLight => (root as any).isDirectionalLight && (root as THREE.DirectionalLight).castShadow
      ) ?? null;
    this.initOrientationGizmo();

    this.selection.attach(scene, transformControls, this.objects, this.getTransformSettings);
    for (const root of baseRoots) registerObject(this.objects, root, getDocId);

    // events
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerCancel);
    window.addEventListener("resize", this.onResize);

    // start loop
    this.renderLoop();
    this.onResize();
  }

  resize(width: number, height: number) {
    if (!this.renderer || !this.camera) return;
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    if (this.animId != null) cancelAnimationFrame(this.animId);
    this.animId = null;

    if (this.canvas) {
      this.canvas.removeEventListener("pointerdown", this.onPointerDown);
      this.canvas.removeEventListener("pointermove", this.onPointerMove);
      this.canvas.removeEventListener("pointerup", this.onPointerUp);
      this.canvas.removeEventListener("pointercancel", this.onPointerCancel);
    }
    window.removeEventListener("resize", this.onResize);

    this.controls?.dispose();
    this.selection.dispose();

    // dispose SOLO user scene (y helpers creados)
    this.clearUserScene();
    this.clearPointerSpringVisual();
    this.clearRuntimeCollisionOverlay();
    this.disposeOrientationGizmo();

    this.renderer?.dispose();

    this.canvas = null;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.controls = null;
    this.transformControls = null;
    this.userRoot = null;
    this.frameCallback = null;
    this.pointerDownPos = null;
    this.activePointerId = null;
    this.activePointerConsumed = false;
    this.pointerMovePos = null;
    this.pointerSpringGroup = null;
    this.pointerSpringArrow = null;
    this.runtimeColliderRoot = null;
    this.runtimeColliderObjects = new Map<string, THREE.Object3D>();
    this.runtimeColliderGeometryCache = new Map<string, THREE.BufferGeometry>();
    this.runtimeColliderMaterial = null;
    this.orientationScene = null;
    this.orientationCamera = null;
    this.orientationAxesRoot = null;
    this.orientationLabelResources = [];
    this.viewportMaterialCache = new WeakMap<THREE.Material, THREE.Material>();
    this.mainShadowLight = null;
    this.objects.clear();
    this.userRoots.clear();
  }

  // -------------------------
  // Scene management API
  // -------------------------

  /**
   * Añade un Object3D bajo __USER_ROOT__. Devuelve rootId lógico (docId del root).
   */
  addToUserScene(obj: THREE.Object3D, name?: string, options?: { frame?: boolean }): string {
    if (!this.scene || !this.userRoot) throw new Error("Viewer not initialized");

    if (name) obj.name = name;
    markSceneNode(obj);
    this.applyViewportShading(obj);

    this.userRoot.add(obj);

    // register ids
    registerHierarchy(this.objects, obj, getDocId);

    const rootId = getDocId(obj);
    this.userRoots.set(rootId, obj);

    const frameOnAdd = options?.frame ?? true;
    if (frameOnAdd) {
      // encuadra cámara al añadir (MVP)
      this.frameObject(obj);
    }

    return rootId;
  }

  removeFromUserScene(rootId: string) {
    if (!this.userRoot) return;
    const root = this.userRoots.get(rootId);
    if (!root) return;

    root.removeFromParent();
    this.userRoots.delete(rootId);

    // limpia registro
    unregisterHierarchy(this.objects, root, getDocId);
    disposeObject3D(root);

    // si estaba seleccionado, deselecciona
    const selectedId = this.selection.getSelectedId();
    if (selectedId && !this.objects.has(selectedId)) {
      this.setSelected(null);
      this.events.onPick?.(null);
    }
  }

  moveToUserRoot(obj: THREE.Object3D, options?: { frame?: boolean }) {
    if (!this.userRoot) return;
    markSceneNode(obj);
    this.applyViewportShading(obj);
    obj.removeFromParent();
    this.userRoot.add(obj);
    registerHierarchy(this.objects, obj, getDocId);
    this.userRoots.set(getDocId(obj), obj);
    if (options?.frame) this.frameObject(obj);
  }

  clearUserScene() {
    if (!this.userRoot) return;

    // clonar la lista porque al remover cambia children
    const roots = [...this.userRoot.children];
    for (const r of roots) this.removeFromUserScene(getDocId(r));
  }

  getSceneSnapshot(): SceneSnapshot {
    if (!this.scene) return { nodes: [], roots: [] };

    const nodes: SceneSnapshot["nodes"] = [];
    const roots: string[] = [];
    const nodesById = new Map<string, SceneSnapshot["nodes"][number]>();

    const kindOf = (o: THREE.Object3D): SceneNodeKind => {
      // orden importante
      if (o.userData?.editorRobotRoot) return "robot";
      if (o.userData?.editorKind) return o.userData.editorKind as SceneNodeKind;
      if ((o as any).isURDFJoint) return "joint";
      if ((o as any).isURDFLink) return "link";
      if ((o as any).isURDFCollider) return "collision";
      if ((o as any).isURDFVisual) return "visual";
      if ((o as any).isMesh) return "mesh";
      if ((o as any).isLight) return "light";
      if ((o as any).isCamera) return "camera";
      if ((o as any).isGroup) return "group";
      return "other";
    };

    const upsert = (o: THREE.Object3D, parentId: string | null) => {
      const id = getDocId(o);
      let node = nodesById.get(id);
      if (!node) {
        node = {
          id,
          name: o.name || o.type,
          parentId,
          children: [],
          kind: kindOf(o),
        };
        nodesById.set(id, node);
        nodes.push(node);
      } else {
        node.name = o.name || o.type;
        node.parentId = parentId;
        node.kind = kindOf(o);
      }
      if (parentId) {
        const parent = nodesById.get(parentId);
        if (parent && !parent.children.includes(id)) parent.children.push(id);
      }
      return id;
    };

    const walkManaged = (o: THREE.Object3D, parentId: string | null, forceManaged = false) => {
      const managed = forceManaged || isManagedSceneObject(o);
      let nextParentId = parentId;
      if (managed) {
        nextParentId = upsert(o, parentId);
      }
      for (const c of o.children) {
        walkManaged(c, nextParentId);
      }
    };

    const rootObjects: THREE.Object3D[] = [];
    if (this.userRoot) rootObjects.push(...this.userRoot.children);

    for (const r of rootObjects) {
      const rootId = upsert(r, null);
      roots.push(rootId);
      for (const c of r.children) {
        walkManaged(c, rootId);
      }
    }

    return { nodes, roots };
  }

  // -------------------------
  // Selection / picking
  // -------------------------

  setSelected(id: string | null) {
    this.selection.setSelected(id);
    if (!this.transformEnabled && this.transformControls) {
      this.setTransformControlsEnabled(false);
      this.transformControls.detach();
      this.transformControls.visible = false;
    }
  }

  getObjectWorldPosition(id: string) {
    const obj = this.objects.get(id);
    if (!obj) return null;
    const v = new THREE.Vector3();
    obj.getWorldPosition(v);
    return { x: v.x, y: v.y, z: v.z };
  }

  getObjectById(id: string) {
    return this.objects.get(id) ?? null;
  }

  registerObject(obj: THREE.Object3D) {
    this.applyViewportShading(obj);
    registerHierarchy(this.objects, obj, getDocId);
  }

  unregisterObject(obj: THREE.Object3D) {
    unregisterHierarchy(this.objects, obj, getDocId);
  }

  getUserRoots(): THREE.Object3D[] {
    if (!this.userRoot) return [];
    return [...this.userRoot.children];
  }

  async captureThumbnail(options?: {
    maxWidth?: number;
    maxHeight?: number;
    mimeType?: "image/webp" | "image/jpeg";
    quality?: number;
  }): Promise<string | null> {
    if (!this.renderer || !this.scene || !this.camera) return null;

    const domCanvas = this.renderer.domElement;
    const sourceWidth = Math.max(1, Math.floor(domCanvas.width));
    const sourceHeight = Math.max(1, Math.floor(domCanvas.height));
    if (sourceWidth <= 0 || sourceHeight <= 0) return null;

    const maxWidth = Math.max(1, Math.floor(options?.maxWidth ?? 640));
    const maxHeight = Math.max(1, Math.floor(options?.maxHeight ?? 360));
    const mimeType = options?.mimeType ?? "image/webp";
    const quality = Number.isFinite(options?.quality) ? Math.min(1, Math.max(0.1, Number(options?.quality))) : 0.78;

    const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight, 1);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));

    this.controls?.update();
    this.selection.updateSelectionBox();
    this.renderer.render(this.scene, this.camera);

    const thumbnailCanvas = document.createElement("canvas");
    thumbnailCanvas.width = width;
    thumbnailCanvas.height = height;
    const context = thumbnailCanvas.getContext("2d");
    if (!context) return null;

    try {
      context.drawImage(domCanvas, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height);
      return thumbnailCanvas.toDataURL(mimeType, quality);
    } catch {
      return null;
    }
  }

  setTransformMode(mode: "translate" | "rotate" | "scale") {
    this.transformMode = mode;
    if (this.transformControls) {
      this.transformControls.setMode(mode);
    }
    const selectedId = this.selection.getSelectedId();
    if (selectedId) {
      this.selection.setSelected(selectedId);
    }
  }

  setTransformSpace(space: "local" | "world") {
    this.transformSpace = space;
    if (this.transformControls) {
      this.transformControls.setSpace(space);
    }
  }

  setTransformEnabled(enabled: boolean) {
    this.transformEnabled = enabled;
    if (!this.transformControls) return;
    this.setTransformControlsEnabled(enabled);
    if (!enabled) {
      this.transformControls.detach();
      this.transformControls.visible = false;
      return;
    }
    const selectedId = this.selection.getSelectedId();
    if (selectedId) {
      this.selection.setSelected(selectedId);
    }
  }

  setTranslationSnap(step: number | null) {
    this.translationSnap = step;
    if (this.transformControls) {
      this.transformControls.setTranslationSnap(step ?? 0);
    }
  }

  setRotationSnap(step: number | null) {
    this.rotationSnap = step;
    if (this.transformControls) {
      this.transformControls.setRotationSnap(step ?? 0);
    }
  }

  setUrdfDebugOptions(options: Partial<UrdfDebugOptions>) {
    this.urdfDebugOptions = { ...this.urdfDebugOptions, ...options };
    this.applyUrdfDebugOptions(true);
  }

  refreshUrdfDebug() {
    this.applyUrdfDebugOptions(true);
  }

  setFrameCallback(cb: ((dt: number) => void) | null) {
    this.frameCallback = cb;
  }

  setOrbitEnabled(enabled: boolean) {
    if (!this.controls) return;
    this.controls.enabled = enabled;
  }

  refreshViewportShading() {
    if (!this.userRoot) return;
    this.applyViewportShading(this.userRoot);
  }

  setPointerSpringVisual(visual: PointerSpringVisual | null) {
    if (!this.scene) return;
    this.ensurePointerSpringVisual();
    const group = this.pointerSpringGroup;
    const arrow = this.pointerSpringArrow;
    if (!group) return;
    if (!arrow) return;

    if (!visual) {
      group.visible = false;
      return;
    }

    const a = new THREE.Vector3(visual.anchor.x, visual.anchor.y, visual.anchor.z);
    const b = new THREE.Vector3(visual.target.x, visual.target.y, visual.target.z);

    const dir = b.clone().sub(a);
    const length = dir.length();
    if (length <= 1e-5) {
      group.visible = false;
      return;
    }
    dir.normalize();
    const headLength = Math.min(Math.max(length * 0.18, 0.03), 0.18);
    const headWidth = Math.min(Math.max(headLength * 0.6, 0.02), 0.12);
    arrow.position.copy(a);
    arrow.setDirection(dir);
    arrow.setLength(length, headLength, headWidth);

    group.visible = true;
  }

  setRuntimeCollisionSnapshots(snapshots: Array<MujocoRuntimeColliderSnapshot & { runtimeId: string }> | null) {
    if (!this.scene) return;
    if (!snapshots || snapshots.length === 0) {
      this.clearRuntimeCollisionObjects();
      return;
    }

    const root = this.ensureRuntimeCollisionRoot();
    if (!root) return;
    const nextKeys = new Set<string>();
    for (const snapshot of snapshots) {
      const key = `${snapshot.runtimeId}:${snapshot.geomId}`;
      nextKeys.add(key);
      const object = this.ensureRuntimeColliderObject(key, snapshot);
      if (!object) continue;
      object.position.set(snapshot.position.x, snapshot.position.y, snapshot.position.z);
      object.quaternion.set(
        snapshot.quaternion.x,
        snapshot.quaternion.y,
        snapshot.quaternion.z,
        snapshot.quaternion.w
      );
      object.visible = true;
    }

    for (const [key, object] of this.runtimeColliderObjects.entries()) {
      if (nextKeys.has(key)) continue;
      object.removeFromParent();
      this.runtimeColliderObjects.delete(key);
    }
  }

  // -------------------------
  // internals
  // -------------------------

  private ensureRuntimeCollisionMaterial() {
    if (this.runtimeColliderMaterial) return this.runtimeColliderMaterial;
    const material = new THREE.MeshBasicMaterial({
      color: 0xff7f50,
      transparent: true,
      opacity: 0.36,
      wireframe: true,
      depthWrite: false,
      depthTest: false,
    });
    this.runtimeColliderMaterial = material;
    return material;
  }

  private ensureRuntimeCollisionRoot() {
    if (!this.scene) return null;
    if (this.runtimeColliderRoot) return this.runtimeColliderRoot;
    const root = new THREE.Group();
    root.name = RUNTIME_COLLIDER_ROOT_NAME;
    root.userData[NON_PICKABLE_KEY] = true;
    root.renderOrder = 20;
    this.scene.add(root);
    this.runtimeColliderRoot = root;
    return root;
  }

  private clearRuntimeCollisionObjects() {
    for (const object of this.runtimeColliderObjects.values()) {
      object.removeFromParent();
    }
    this.runtimeColliderObjects.clear();
  }

  private clearRuntimeCollisionOverlay() {
    this.clearRuntimeCollisionObjects();
    if (this.runtimeColliderRoot) {
      this.runtimeColliderRoot.removeFromParent();
    }
    for (const geometry of this.runtimeColliderGeometryCache.values()) {
      geometry.dispose();
    }
    this.runtimeColliderGeometryCache.clear();
    if (this.runtimeColliderMaterial) {
      this.runtimeColliderMaterial.dispose();
      this.runtimeColliderMaterial = null;
    }
  }

  private buildRuntimeHfieldGeometry(snapshot: MujocoRuntimeColliderSnapshot) {
    const hfield = snapshot.hfield;
    if (!hfield) return null;
    const nrow = Math.max(1, Math.trunc(hfield.nrow));
    const ncol = Math.max(1, Math.trunc(hfield.ncol));
    const [sxRaw, syRaw, szRaw, baseRaw] = hfield.size;
    const sx = Math.max(1e-6, Math.abs(Number(sxRaw) || 1));
    const sy = Math.max(1e-6, Math.abs(Number(syRaw) || 1));
    const sz = Math.max(1e-6, Math.abs(Number(szRaw) || 0.2));
    const base = Math.max(1e-6, Math.abs(Number(baseRaw) || 0.1));
    const vertexCount = nrow * ncol;
    if (vertexCount < 4) return null;

    const positions = new Float32Array(vertexCount * 3);
    let cursor = 0;
    for (let row = 0; row < nrow; row += 1) {
      const v = nrow > 1 ? row / (nrow - 1) : 0;
      const y = -sy + v * sy * 2;
      for (let col = 0; col < ncol; col += 1) {
        const u = ncol > 1 ? col / (ncol - 1) : 0;
        const x = -sx + u * sx * 2;
        const idx = row * ncol + col;
        const rawHeight = Number(hfield.heights[idx] ?? 0);
        const normalized = Number.isFinite(rawHeight) ? rawHeight : 0;
        const z = normalized * sz - base;
        positions[cursor] = x;
        positions[cursor + 1] = y;
        positions[cursor + 2] = z;
        cursor += 3;
      }
    }

    const indices: number[] = [];
    for (let row = 0; row + 1 < nrow; row += 1) {
      for (let col = 0; col + 1 < ncol; col += 1) {
        const a = row * ncol + col;
        const b = a + 1;
        const c = a + ncol;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    if (indices.length < 3) return null;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }

  private buildRuntimeColliderGeometry(snapshot: MujocoRuntimeColliderSnapshot) {
    const [sx, sy, sz] = snapshot.size;
    if (snapshot.type === "plane") {
      return new THREE.PlaneGeometry(Math.max(0.01, sx * 2), Math.max(0.01, sy * 2), 1, 1);
    }
    if (snapshot.type === "box") {
      return new THREE.BoxGeometry(Math.max(1e-4, sx * 2), Math.max(1e-4, sy * 2), Math.max(1e-4, sz * 2));
    }
    if (snapshot.type === "sphere") {
      return new THREE.SphereGeometry(Math.max(1e-4, sx), 16, 12);
    }
    if (snapshot.type === "ellipsoid") {
      const geometry = new THREE.SphereGeometry(1, 16, 12);
      geometry.scale(Math.max(1e-4, sx), Math.max(1e-4, sy), Math.max(1e-4, sz));
      return geometry;
    }
    if (snapshot.type === "cylinder") {
      const geometry = new THREE.CylinderGeometry(
        Math.max(1e-4, sx),
        Math.max(1e-4, sx),
        Math.max(1e-4, sy * 2),
        18
      );
      geometry.rotateX(Math.PI / 2);
      return geometry;
    }
    if (snapshot.type === "capsule") {
      const geometry = new THREE.CapsuleGeometry(Math.max(1e-4, sx), Math.max(0, sy * 2), 8, 16);
      geometry.rotateX(Math.PI / 2);
      return geometry;
    }
    if (snapshot.type === "mesh" && snapshot.mesh) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(snapshot.mesh.vertices), 3));
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(snapshot.mesh.indices), 1));
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      return geometry;
    }
    if (snapshot.type === "hfield") {
      return this.buildRuntimeHfieldGeometry(snapshot) ?? new THREE.BoxGeometry(0.1, 0.1, 0.1);
    }
    return new THREE.BoxGeometry(0.08, 0.08, 0.08);
  }

  private runtimeColliderGeometryCacheKey(snapshot: MujocoRuntimeColliderSnapshot): string {
    if (snapshot.type === "mesh" && snapshot.meshId !== null) {
      return `mesh:${snapshot.meshId}`;
    }
    if (snapshot.type === "hfield" && snapshot.hfieldId !== null) {
      return `hfield:${snapshot.hfieldId}`;
    }
    const [sx, sy, sz] = snapshot.size;
    return `${snapshot.type}:${sx.toFixed(6)}:${sy.toFixed(6)}:${sz.toFixed(6)}`;
  }

  private ensureRuntimeColliderObject(key: string, snapshot: MujocoRuntimeColliderSnapshot) {
    const root = this.ensureRuntimeCollisionRoot();
    if (!root) return null;
    const geometryKey = this.runtimeColliderGeometryCacheKey(snapshot);
    const existing = this.runtimeColliderObjects.get(key);
    if (existing && existing.userData?.[RUNTIME_COLLIDER_GEOMETRY_KEY] === geometryKey) {
      return existing;
    }
    if (existing) {
      existing.removeFromParent();
      this.runtimeColliderObjects.delete(key);
    }

    let geometry = this.runtimeColliderGeometryCache.get(geometryKey);
    if (!geometry) {
      geometry = this.buildRuntimeColliderGeometry(snapshot);
      this.runtimeColliderGeometryCache.set(geometryKey, geometry);
    }

    const mesh = new THREE.Mesh(geometry, this.ensureRuntimeCollisionMaterial());
    mesh.name = snapshot.geomName || `RuntimeCollider_${snapshot.geomId}`;
    mesh.userData[NON_PICKABLE_KEY] = true;
    mesh.userData[RUNTIME_COLLIDER_OBJECT_KEY] = key;
    mesh.userData[RUNTIME_COLLIDER_GEOMETRY_KEY] = geometryKey;
    mesh.frustumCulled = false;
    mesh.renderOrder = 22;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    root.add(mesh);
    this.runtimeColliderObjects.set(key, mesh);
    return mesh;
  }

  private applyUrdfDebugOptions(rebuildHelpers: boolean) {
    if (!this.userRoot) return;
    const { showVisuals, showAxes, showJointAxes, showCOM } = this.urdfDebugOptions;
    const wantsVisualTransparency = showAxes || showJointAxes || showCOM;

    this.userRoot.traverse((obj) => {
      const anyObj = obj as any;
      const editorKind = obj.userData?.editorKind;
      if (anyObj.isURDFVisual || editorKind === "visual") obj.visible = showVisuals;
      if (anyObj.isURDFCollider || editorKind === "collision") obj.visible = false;
    });

    this.updateUrdfVisualTransparency(wantsVisualTransparency);
    this.updateUrdfCollisionMaterials(false);

    if (rebuildHelpers) {
      this.rebuildUrdfHelpers();
    }
  }

  private rebuildUrdfHelpers() {
    if (!this.userRoot) return;
    const { showAxes, showJointAxes, showCOM, showInertias } = this.urdfDebugOptions;

    this.userRoot.traverse((obj) => {
      const toRemove = obj.children.filter((child) => Boolean(child.userData?.[URDF_HELPER_KEY]));
      for (const child of toRemove) {
        obj.remove(child);
        disposeObject3D(child);
      }
    });

    if (!(showAxes || showJointAxes || showCOM || showInertias)) return;

    const debugScale = this.getUrdfDebugScale();
    const axisLength = debugScale * 0.8;
    const axisRadius = Math.max(0.003, axisLength * 0.05);

    this.userRoot.traverse((obj) => {
      const anyObj = obj as any;
      if (anyObj.isURDFLink || obj.userData?.editorKind === "link") {
        const urdf = obj.userData?.urdf as UrdfInstance | undefined;
        const link = urdf?.kind === "link" ? urdf.link : null;
        const invScale = inverseWorldScale(obj);
        if (showAxes) {
          const gizmo = this.createAxisGizmo(axisLength, axisRadius);
          this.markHelper(gizmo, "axis");
          obj.add(gizmo);
        }

        if (link && link.inertial) {
          const origin = link.inertial.origin;

          if (showCOM) {
            const mass = Number.isFinite(link.inertial.mass) ? Math.max(0, link.inertial.mass) : 0;
            const radius = computeComRadius(mass, 0.05, 0.01);
            const sphereGroup = new THREE.Group();
            sphereGroup.scale.copy(invScale);
            const solid = new THREE.Mesh(
              new THREE.SphereGeometry(radius, 16, 16),
              new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false })
            );
            const wire = new THREE.Mesh(
              new THREE.SphereGeometry(radius * 1.02, 12, 12),
              new THREE.MeshBasicMaterial({
                color: 0x111111,
                wireframe: true,
                transparent: true,
                opacity: 0.6,
                depthTest: false,
              })
            );
            sphereGroup.add(solid, wire);
            sphereGroup.position.set(
              origin.xyz[0] * invScale.x,
              origin.xyz[1] * invScale.y,
              origin.xyz[2] * invScale.z
            );
            sphereGroup.renderOrder = 3;
            this.markHelper(sphereGroup, "com");
            obj.add(sphereGroup);
          }

          if (showInertias) {
            const inertia = link.inertial.inertia;
            const mass = link.inertial.mass;
            const safeMass = Number.isFinite(mass) && mass > 0 ? mass : 1;
            const qOrigin = quatFromRpy(origin.rpy);
            const boxData = computeInertiaBoxForDebug(safeMass, {
              ixx: inertia.ixx,
              iyy: inertia.iyy,
              izz: inertia.izz,
              ixy: inertia.ixy,
              ixz: inertia.ixz,
              iyz: inertia.iyz,
            });
            if (!boxData) return;

            const boxGroup = new THREE.Group();
            boxGroup.position.set(
              origin.xyz[0] * invScale.x,
              origin.xyz[1] * invScale.y,
              origin.xyz[2] * invScale.z
            );
            boxGroup.scale.copy(invScale);
            const box = new THREE.Mesh(
              new THREE.BoxGeometry(1, 1, 1),
              new THREE.MeshBasicMaterial({
                color: 0x4aa3ff,
                transparent: true,
                opacity: 0.25,
                depthWrite: false,
                side: THREE.DoubleSide,
              })
            );
            box.quaternion.copy(qOrigin).multiply(boxData.rotation);
            box.scale.copy(boxData.size).multiplyScalar(INERTIA_BOX_SCALE);
            box.renderOrder = 2;
            boxGroup.add(box);
            this.markHelper(boxGroup, "inertia");
            obj.add(boxGroup);
          }
        } else if (obj.userData?.editorKind === "link") {
          const instance = ensureUserInstance(obj);
          const mass = Number.isFinite(instance.physics.mass) ? Math.max(0, instance.physics.mass) : 0;
          const com = instance.physics.com ?? { x: 0, y: 0, z: 0 };
          if (showCOM) {
            const radius = computeComRadius(mass, 0.05, 0.01);
            const sphereGroup = new THREE.Group();
            sphereGroup.scale.copy(invScale);
            const solid = new THREE.Mesh(
              new THREE.SphereGeometry(radius, 16, 16),
              new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false })
            );
            const wire = new THREE.Mesh(
              new THREE.SphereGeometry(radius * 1.02, 12, 12),
              new THREE.MeshBasicMaterial({
                color: 0x111111,
                wireframe: true,
                transparent: true,
                opacity: 0.6,
                depthTest: false,
              })
            );
            sphereGroup.add(solid, wire);
            sphereGroup.position.set(com.x * invScale.x, com.y * invScale.y, com.z * invScale.z);
            sphereGroup.renderOrder = 3;
            this.markHelper(sphereGroup, "com");
            obj.add(sphereGroup);
          }

          if (showInertias && mass > 0) {
            const safeMass = mass > 0 ? mass : 1;
            const inertiaDiag = instance.physics.inertia;
            const tensor =
              instance.physics.inertiaTensor ?? {
                ixx: inertiaDiag.x,
                iyy: inertiaDiag.y,
                izz: inertiaDiag.z,
                ixy: 0,
                ixz: 0,
                iyz: 0,
              };
            const boxData = computeInertiaBoxForDebug(safeMass, tensor);
            if (!boxData) return;

            const boxGroup = new THREE.Group();
            boxGroup.position.set(com.x * invScale.x, com.y * invScale.y, com.z * invScale.z);
            boxGroup.scale.copy(invScale);
            const box = new THREE.Mesh(
              new THREE.BoxGeometry(1, 1, 1),
              new THREE.MeshBasicMaterial({
                color: 0x4aa3ff,
                transparent: true,
                opacity: 0.25,
                depthWrite: false,
                side: THREE.DoubleSide,
              })
            );
            box.quaternion.copy(boxData.rotation);
            box.scale.copy(boxData.size).multiplyScalar(INERTIA_BOX_SCALE);
            box.renderOrder = 2;
            boxGroup.add(box);
            this.markHelper(boxGroup, "inertia");
            obj.add(boxGroup);
          }
        }
      }

      if (showJointAxes && (anyObj.isURDFJoint || obj.userData?.editorKind === "joint")) {
        const urdf = obj.userData?.urdf as UrdfInstance | undefined;
        const joint = urdf?.kind === "joint" ? urdf.joint : null;
        const axis = joint?.axis ?? [1, 0, 0];
        const dir = new THREE.Vector3(axis[0], axis[1], axis[2]);
        if (dir.lengthSq() > 0) dir.normalize();
        const length = axisLength;
        const radius = axisRadius;
        const arrow = this.createAxisArrow(dir, length, radius * 0.8, 0xec42f5);
        const arc = this.createRotationArc(dir, length * 0.6, radius * 0.8, 0xec42f5);
        this.markHelper(arrow, "joint-axis");
        this.markHelper(arc, "joint-axis");
        obj.add(arrow);
        obj.add(arc);
      }
    });
  }

  private getUrdfDebugScale() {
    if (!this.userRoot) return 0.2;
    const box = new THREE.Box3().setFromObject(this.userRoot);
    if (box.isEmpty()) return 0.2;
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    if (!Number.isFinite(maxDim) || maxDim <= 0) return 0.2;
    return Math.min(0.6, Math.max(0.12, maxDim * 0.08));
  }

  private updateUrdfVisualTransparency(enable: boolean) {
    if (!this.userRoot) return;
    this.userRoot.traverse((obj) => {
      const anyObj = obj as any;
      if (!anyObj.isURDFVisual && obj.userData?.editorKind !== "visual") return;
      obj.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;

        if (enable) {
          if (mesh.userData?.[URDF_VISUAL_MATERIAL_KEY]) return;
          const original = mesh.material;
          const clone = Array.isArray(original)
            ? original.map((mat) => cloneTransparentMaterial(mat))
            : cloneTransparentMaterial(original);
          mesh.material = clone as typeof mesh.material;
          mesh.userData[URDF_VISUAL_MATERIAL_KEY] = { original, clone };
        } else {
          const state = mesh.userData?.[URDF_VISUAL_MATERIAL_KEY] as
            | { original: THREE.Material | THREE.Material[]; clone: THREE.Material | THREE.Material[] }
            | undefined;
          if (!state) return;
          mesh.material = state.original as typeof mesh.material;
          if (Array.isArray(state.clone)) {
            state.clone.forEach(disposeMaterialSafe);
          } else {
            disposeMaterialSafe(state.clone);
          }
          delete mesh.userData[URDF_VISUAL_MATERIAL_KEY];
        }
      });
    });
  }

  private updateUrdfCollisionMaterials(enable: boolean) {
    if (!this.userRoot) return;
    const createCollisionMaterial = () =>
      new THREE.MeshBasicMaterial({
        color: URDF_COLLISION_COLOR,
        transparent: true,
        opacity: URDF_COLLISION_OPACITY,
        wireframe: false,
        depthWrite: false,
        depthTest: false,
      });

    this.userRoot.traverse((obj) => {
      if (obj.userData?.editorKind !== "collision") return;
      obj.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;

        if (enable) {
          if (mesh.userData?.[URDF_COLLISION_MATERIAL_KEY]) return;
          const original = mesh.material;
          const clone = Array.isArray(original)
            ? original.map(() => createCollisionMaterial())
            : createCollisionMaterial();
          mesh.material = clone as typeof mesh.material;
          mesh.renderOrder = 10;
          mesh.userData[URDF_COLLISION_MATERIAL_KEY] = { original, clone };
        } else {
          const state = mesh.userData?.[URDF_COLLISION_MATERIAL_KEY] as
            | { original: THREE.Material | THREE.Material[]; clone: THREE.Material | THREE.Material[] }
            | undefined;
          if (!state) return;
          mesh.material = state.original as typeof mesh.material;
          if (Array.isArray(state.clone)) {
            state.clone.forEach(disposeMaterialSafe);
          } else {
            disposeMaterialSafe(state.clone);
          }
          delete mesh.userData[URDF_COLLISION_MATERIAL_KEY];
        }
      });
    });
  }

  private createAxisGizmo(length: number, radius: number) {
    const group = new THREE.Group();
    const axes = [
      { dir: new THREE.Vector3(1, 0, 0), color: 0xff4a4a },
      { dir: new THREE.Vector3(0, 1, 0), color: 0x4ad16b },
      { dir: new THREE.Vector3(0, 0, 1), color: 0x4a6bff },
    ];
    const shaftLen = length * 0.75;
    const headLen = length * 0.25;
    const baseUp = new THREE.Vector3(0, 1, 0);

    for (const axis of axes) {
      const mat = new THREE.MeshBasicMaterial({
        color: axis.color,
        transparent: true,
        opacity: 0.9,
        depthTest: true,
      });
      const axisGroup = new THREE.Group();
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, Math.max(0.001, shaftLen), 8),
        mat
      );
      shaft.position.y = shaftLen / 2;
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(radius * 2.4, Math.max(0.001, headLen), 10),
        mat
      );
      cone.position.y = shaftLen + headLen / 2;
      axisGroup.add(shaft, cone);
      axisGroup.quaternion.setFromUnitVectors(baseUp, axis.dir);
      axisGroup.renderOrder = -1;
      group.add(axisGroup);
    }
    return group;
  }

  private createAxisArrow(dir: THREE.Vector3, length: number, radius: number, color: number) {
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
      depthTest: true,
    });
    const shaftLen = length * 2.00;
    const headLen = length * 0.25;
    const baseUp = new THREE.Vector3(0, 1, 0);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, Math.max(0.001, shaftLen), 10), mat);
    shaft.position.y = shaftLen / 2;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(radius * 2.6, Math.max(0.001, headLen), 12), mat);
    cone.position.y = shaftLen + headLen / 2;
    group.add(shaft, cone);
    group.quaternion.setFromUnitVectors(baseUp, dir.clone().normalize());
    group.renderOrder = -1;
    return group;
  }

  private createRotationArc(dir: THREE.Vector3, radius: number, tube: number, color: number) {
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      depthTest: true,
    });
    const arc = Math.PI * 0.65;
    const torus = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 10, 48, arc), mat);
    torus.renderOrder = -1;
    group.add(torus);

    const endAngle = arc;
    const endPos = new THREE.Vector3(radius * Math.cos(endAngle), radius * Math.sin(endAngle), 0);
    const tangent = new THREE.Vector3(-Math.sin(endAngle), Math.cos(endAngle), 0).normalize();
    const cone = new THREE.Mesh(new THREE.ConeGeometry(tube * 2.2, tube * 4, 10), mat);
    cone.position.copy(endPos);
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent);
    cone.renderOrder = -1;
    group.add(cone);

    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize());
    group.quaternion.copy(q);
    return group;
  }

  private ensurePointerSpringVisual() {
    if (!this.scene) return;
    if (this.pointerSpringGroup) return;

    const group = new THREE.Group();
    group.name = "__pointer_spring_visual__";
    group.visible = false;
    group.layers.set(HELPER_LAYER);
    group.userData[NON_PICKABLE_KEY] = true;

    const dir = new THREE.Vector3(1, 0, 0);
    const origin = new THREE.Vector3();
    const arrow = new THREE.ArrowHelper(dir, origin, 0.001, 0x9ca3af, 0.05, 0.03);
    arrow.layers.set(HELPER_LAYER);
    arrow.userData[NON_PICKABLE_KEY] = true;
    arrow.line.layers.set(HELPER_LAYER);
    arrow.line.userData[NON_PICKABLE_KEY] = true;
    arrow.cone.layers.set(HELPER_LAYER);
    arrow.cone.userData[NON_PICKABLE_KEY] = true;
    const lineMat = arrow.line.material as THREE.LineBasicMaterial;
    const coneMat = arrow.cone.material as THREE.MeshBasicMaterial;
    lineMat.depthTest = false;
    coneMat.depthTest = false;
    lineMat.transparent = true;
    coneMat.transparent = true;
    lineMat.opacity = 0.92;
    coneMat.opacity = 0.92;
    arrow.line.renderOrder = 20;
    arrow.cone.renderOrder = 21;
    group.add(arrow);

    this.scene.add(group);
    this.pointerSpringGroup = group;
    this.pointerSpringArrow = arrow;
  }

  private clearPointerSpringVisual() {
    if (!this.pointerSpringGroup) return;
    this.pointerSpringGroup.removeFromParent();
    disposeObject3D(this.pointerSpringGroup);
    this.pointerSpringGroup = null;
    this.pointerSpringArrow = null;
  }

  private createOrientationLabelSprite(label: string, color: number) {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      const fallbackTexture = new THREE.CanvasTexture(canvas);
      const fallbackMaterial = new THREE.SpriteMaterial({
        map: fallbackTexture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      });
      const fallback = new THREE.Sprite(fallbackMaterial);
      fallback.scale.set(0.36, 0.36, 1);
      this.orientationLabelResources.push({ texture: fallbackTexture, material: fallbackMaterial });
      return fallback;
    }

    const colorHex = `#${color.toString(16).padStart(6, "0")}`;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = "700 76px 'IBM Plex Sans', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 10;
    ctx.strokeStyle = "rgba(8,12,18,0.9)";
    ctx.strokeText(label, canvas.width / 2, canvas.height / 2);
    ctx.fillStyle = colorHex;
    ctx.fillText(label, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(0.36, 0.36, 1);
    this.orientationLabelResources.push({ texture, material });
    return sprite;
  }

  private initOrientationGizmo() {
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1.35, 1.35, 1.35, -1.35, 0.1, 10);
    camera.position.set(0, 0, 3);
    // Keep widget camera in canonical camera space (Y-up) to avoid roll artifacts.
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);

    const root = new THREE.Group();
    const axisLen = 0.9;
    const labelRadius = 1.2;
    const axisSpec = [
      { label: "X", dir: new THREE.Vector3(1, 0, 0), color: 0xff3b3b },
      { label: "Y", dir: new THREE.Vector3(0, 1, 0), color: 0x35d06b },
      { label: "Z", dir: new THREE.Vector3(0, 0, 1), color: 0x3f70ff },
    ];

    for (const axis of axisSpec) {
      const arrow = new THREE.ArrowHelper(axis.dir, new THREE.Vector3(), axisLen, axis.color, 0.23, 0.11);
      const lineMat = arrow.line.material as THREE.LineBasicMaterial;
      const coneMat = arrow.cone.material as THREE.MeshBasicMaterial;
      lineMat.depthTest = false;
      coneMat.depthTest = false;
      lineMat.toneMapped = false;
      coneMat.toneMapped = false;
      lineMat.transparent = true;
      coneMat.transparent = true;
      lineMat.opacity = 0.94;
      coneMat.opacity = 0.94;
      root.add(arrow);

      const label = this.createOrientationLabelSprite(axis.label, axis.color);
      label.position.copy(axis.dir).multiplyScalar(labelRadius);
      root.add(label);
    }

    const center = new THREE.Mesh(
      new THREE.SphereGeometry(0.06, 14, 10),
      new THREE.MeshBasicMaterial({
        color: 0xcbd5e1,
        transparent: true,
        opacity: 0.9,
        toneMapped: false,
        depthTest: false,
      })
    );
    root.add(center);

    scene.add(root);
    this.orientationScene = scene;
    this.orientationCamera = camera;
    this.orientationAxesRoot = root;
  }

  private disposeOrientationGizmo() {
    if (this.orientationAxesRoot) {
      this.orientationAxesRoot.removeFromParent();
      disposeObject3D(this.orientationAxesRoot);
    }
    for (const resource of this.orientationLabelResources) {
      resource.material.dispose();
      resource.texture.dispose();
    }
    this.orientationScene = null;
    this.orientationCamera = null;
    this.orientationAxesRoot = null;
    this.orientationLabelResources = [];
  }

  private updateOrientationGizmoFromCamera() {
    if (!this.camera || !this.orientationAxesRoot) return;
    this.orientationAxesRoot.quaternion.copy(this.camera.quaternion).invert();
  }

  private renderOrientationGizmo() {
    if (!this.renderer || !this.canvas || !this.orientationScene || !this.orientationCamera) return;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (width <= 0 || height <= 0) return;

    this.updateOrientationGizmoFromCamera();

    const idealSize = Math.round(
      Math.min(ORIENTATION_GIZMO_SIZE_MAX_PX, Math.max(ORIENTATION_GIZMO_SIZE_MIN_PX, Math.min(width, height) * 0.18))
    );
    const maxAllowedSize = Math.floor(Math.min(width, height) - ORIENTATION_GIZMO_MARGIN_PX * 2);
    if (maxAllowedSize < 36) return;
    const gizmoSize = Math.min(idealSize, maxAllowedSize);
    const x = Math.max(0, width - gizmoSize - ORIENTATION_GIZMO_MARGIN_PX);
    const y = ORIENTATION_GIZMO_MARGIN_PX;

    const prevAutoClear = this.renderer.autoClear;
    const prevScissorTest = this.renderer.getScissorTest();
    const prevViewport = new THREE.Vector4();
    const prevScissor = new THREE.Vector4();
    this.renderer.getViewport(prevViewport);
    this.renderer.getScissor(prevScissor);

    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.setScissorTest(true);
    this.renderer.setViewport(x, y, gizmoSize, gizmoSize);
    this.renderer.setScissor(x, y, gizmoSize, gizmoSize);
    this.renderer.render(this.orientationScene, this.orientationCamera);

    this.renderer.setViewport(prevViewport);
    this.renderer.setScissor(prevScissor);
    this.renderer.setScissorTest(prevScissorTest);
    this.renderer.autoClear = prevAutoClear;
  }

  private markHelper(obj: THREE.Object3D, kind: HelperKind) {
    obj.userData[URDF_HELPER_KEY] = kind;
    obj.userData[NON_PICKABLE_KEY] = true;
  }

  private getTransformSettings = (): TransformSettings => ({
    mode: this.transformMode,
    space: this.transformSpace,
    translationSnap: this.translationSnap,
    rotationSnap: this.rotationSnap,
  });

  private tuneViewportMaterial(material: THREE.Material) {
    const cached = this.viewportMaterialCache.get(material);
    if (cached) return cached;

    if ((material as any).isMeshBasicMaterial) {
      const basic = material as THREE.MeshBasicMaterial;
      const replacement = new THREE.MeshPhysicalMaterial({
        name: basic.name,
        color: basic.color?.clone() ?? new THREE.Color(0xd1d6dc),
        map: basic.map,
        alphaMap: basic.alphaMap,
        transparent: basic.transparent,
        opacity: basic.opacity,
        side: basic.side,
        wireframe: basic.wireframe,
        roughness: 0.4,
        metalness: 0.08,
        envMapIntensity: 1.05,
        clearcoat: 0.2,
        clearcoatRoughness: 0.26,
      });
      replacement.alphaTest = basic.alphaTest;
      replacement.depthWrite = basic.depthWrite;
      replacement.depthTest = basic.depthTest;
      replacement.visible = basic.visible;
      replacement.fog = basic.fog;
      if (replacement.map) replacement.map.colorSpace = THREE.SRGBColorSpace;
      this.viewportMaterialCache.set(material, replacement);
      return replacement;
    }

    if ((material as any).isMeshPhysicalMaterial) {
      const pbr = material as THREE.MeshPhysicalMaterial;
      const surfaceProfile = String((pbr.userData as Record<string, unknown> | undefined)?.viewportSurfaceProfile ?? "")
        .trim()
        .toLowerCase();
      if (surfaceProfile === "usd_pbr") {
        pbr.envMapIntensity = Math.min(0.18, Math.max(0.02, pbr.envMapIntensity ?? 0.08));
        pbr.roughness = Math.min(1.0, Math.max(0.85, pbr.roughness ?? 0.94));
        pbr.metalness = Math.min(0.04, Math.max(0, pbr.metalness ?? 0));
        pbr.clearcoat = 0;
        pbr.clearcoatRoughness = Math.max(0.9, pbr.clearcoatRoughness ?? 0.94);
      } else {
        pbr.envMapIntensity = Math.max(1.0, pbr.envMapIntensity ?? 0);
        pbr.roughness = Math.min(0.82, Math.max(0.18, pbr.roughness ?? 0.5));
        pbr.metalness = Math.min(0.4, Math.max(0, pbr.metalness ?? 0));
        pbr.clearcoat = Math.max(0.2, pbr.clearcoat ?? 0);
        pbr.clearcoatRoughness = Math.min(0.45, Math.max(0.12, pbr.clearcoatRoughness ?? 0.24));
      }
      if (pbr.map) pbr.map.colorSpace = THREE.SRGBColorSpace;
      pbr.needsUpdate = true;
      this.viewportMaterialCache.set(material, material);
      return material;
    }

    if ((material as any).isMeshStandardMaterial) {
      const std = material as THREE.MeshStandardMaterial;
      const surfaceProfile = String((std.userData as Record<string, unknown> | undefined)?.viewportSurfaceProfile ?? "")
        .trim()
        .toLowerCase();
      if (surfaceProfile === "usd_pbr") {
        std.envMapIntensity = Math.min(0.18, Math.max(0.02, std.envMapIntensity ?? 0.08));
        std.roughness = Math.min(1.0, Math.max(0.85, std.roughness ?? 0.94));
        std.metalness = Math.min(0.04, Math.max(0, std.metalness ?? 0));
      } else {
        std.envMapIntensity = Math.max(1.0, std.envMapIntensity ?? 0);
        std.roughness = Math.min(0.82, Math.max(0.18, std.roughness ?? 0.5));
        std.metalness = Math.min(0.4, Math.max(0, std.metalness ?? 0));
      }
      if (std.map) std.map.colorSpace = THREE.SRGBColorSpace;
      std.needsUpdate = true;
      this.viewportMaterialCache.set(material, material);
      return material;
    }

    if ((material as any).isMeshPhongMaterial) {
      const phong = material as THREE.MeshPhongMaterial;
      phong.shininess = Math.max(40, phong.shininess);
      phong.specular = phong.specular?.clone().lerp(new THREE.Color(0x4b5563), 0.35) ?? new THREE.Color(0x4b5563);
      phong.needsUpdate = true;
      this.viewportMaterialCache.set(material, material);
      return material;
    }

    this.viewportMaterialCache.set(material, material);
    return material;
  }

  private ensureMeshEdgeOverlay(mesh: THREE.Mesh) {
    const geom = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geom || (geom.attributes.position?.count ?? 0) < 3) return;
    if (geom.type === "PlaneGeometry") return;
    if (mesh.children.some((child) => child.name === PRIMITIVE_SURFACE_LINES_NAME)) return;

    const cached = mesh.userData?.[VIEWPORT_EDGE_OVERLAY_KEY] as THREE.LineSegments | undefined;
    const disableOverlay = mesh.userData?.disableViewportEdgeOverlay === true;
    if (disableOverlay) {
      if (cached) {
        cached.removeFromParent();
        disposeObject3D(cached);
        delete mesh.userData[VIEWPORT_EDGE_OVERLAY_KEY];
      }
      return;
    }
    const sourceGeomId = geom.uuid;
    if (cached?.userData?.sourceGeometry === sourceGeomId) return;
    if (cached) {
      cached.removeFromParent();
      disposeObject3D(cached);
    }

    const edgeGeometry = new THREE.EdgesGeometry(geom, 24);
    if ((edgeGeometry.attributes.position?.count ?? 0) === 0) {
      edgeGeometry.dispose();
      return;
    }

    const baseMaterial = Array.isArray(mesh.material) ? mesh.material.find(Boolean) : mesh.material;
    const edgeColor = new THREE.Color(0x182231);
    if (baseMaterial && "color" in baseMaterial && (baseMaterial as THREE.Material & { color?: THREE.Color }).color) {
      const baseColor = (baseMaterial as THREE.Material & { color: THREE.Color }).color;
      edgeColor.copy(baseColor).multiplyScalar(0.34).lerp(new THREE.Color(0x0f1928), 0.46);
    }

    const edgeLines = new THREE.LineSegments(
      edgeGeometry,
      new THREE.LineBasicMaterial({
        color: edgeColor,
        transparent: true,
        opacity: 0.62,
        depthWrite: false,
        toneMapped: false,
      })
    );
    edgeLines.name = VIEWPORT_EDGE_OVERLAY_NAME;
    edgeLines.renderOrder = mesh.renderOrder + 2;
    edgeLines.userData[NON_PICKABLE_KEY] = true;
    edgeLines.userData.sourceGeometry = sourceGeomId;
    mesh.userData[VIEWPORT_EDGE_OVERLAY_KEY] = edgeLines;
    mesh.add(edgeLines);
  }

  private isFloorMesh(mesh: THREE.Mesh) {
    const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geometry || geometry.type !== "PlaneGeometry") return false;
    const name = String(mesh.name ?? "").toLowerCase();
    const parentName = String(mesh.parent?.name ?? "").toLowerCase();
    return name.includes("floor") || parentName.includes("floor");
  }

  private tuneFloorSurfaceMaterial(mesh: THREE.Mesh) {
    const tuneMaterial = (material: THREE.Material | null | undefined) => {
      if (!material) return;

      if ((material as any).isMeshPhysicalMaterial) {
        const pbr = material as THREE.MeshPhysicalMaterial;
        pbr.roughness = Math.max(0.58, pbr.roughness ?? 0.62);
        pbr.metalness = Math.min(0.24, Math.max(0.06, pbr.metalness ?? 0.16));
        pbr.envMapIntensity = Math.min(0.72, pbr.envMapIntensity ?? 0.62);
        pbr.clearcoat = Math.min(0.12, pbr.clearcoat ?? 0.08);
        pbr.clearcoatRoughness = Math.max(0.62, pbr.clearcoatRoughness ?? 0.72);
        if (typeof pbr.reflectivity === "number") {
          pbr.reflectivity = Math.min(0.42, Math.max(0.18, pbr.reflectivity));
        }
        pbr.needsUpdate = true;
        return;
      }

      if ((material as any).isMeshStandardMaterial) {
        const std = material as THREE.MeshStandardMaterial;
        std.roughness = Math.max(0.58, std.roughness ?? 0.62);
        std.metalness = Math.min(0.22, Math.max(0.05, std.metalness ?? 0.15));
        std.envMapIntensity = Math.min(0.72, std.envMapIntensity ?? 0.62);
        std.needsUpdate = true;
        return;
      }

      if ((material as any).isMeshPhongMaterial) {
        const phong = material as THREE.MeshPhongMaterial;
        phong.shininess = Math.min(26, phong.shininess);
        phong.needsUpdate = true;
      }
    };

    if (Array.isArray(mesh.material)) {
      mesh.material.forEach((material) => tuneMaterial(material ?? null));
      return;
    }
    tuneMaterial(mesh.material ?? null);
  }

  private ensureFloorReflector(mesh: THREE.Mesh) {
    if (!this.renderer) return;
    if (!this.isFloorMesh(mesh)) return;
    const geometry = mesh.geometry as THREE.BufferGeometry;

    const existing = mesh.userData[FLOOR_REFLECTOR_KEY] as Reflector | undefined;
    if (existing?.parent === mesh && existing.userData?.sourceGeometry === geometry.uuid) return;
    if (existing) {
      existing.removeFromParent();
      if (typeof (existing as any).dispose === "function") (existing as any).dispose();
      delete mesh.userData[FLOOR_REFLECTOR_KEY];
    }

    const maxTexSize = this.renderer.capabilities.maxTextureSize || 2048;
    const textureSize = Math.max(384, Math.min(maxTexSize, 768));
    const reflector = new Reflector(geometry, {
      clipBias: 0.001,
      textureWidth: textureSize,
      textureHeight: textureSize,
      color: 0xa2bbd4,
      multisample: 2,
      shader: FLOOR_REFLECTOR_SHADER,
    });
    reflector.name = FLOOR_REFLECTOR_NAME;
    reflector.position.z = 0.0012;
    reflector.layers.set(0);
    reflector.camera.layers.set(0);
    reflector.renderOrder = mesh.renderOrder + 3;
    reflector.userData[NON_PICKABLE_KEY] = true;
    reflector.userData.sourceGeometry = geometry.uuid;
    reflector.matrixAutoUpdate = true;
    const reflectorMaterial = reflector.material as THREE.ShaderMaterial;
    reflectorMaterial.transparent = true;
    reflectorMaterial.depthWrite = false;
    reflectorMaterial.polygonOffset = true;
    reflectorMaterial.polygonOffsetFactor = -1;
    reflectorMaterial.polygonOffsetUnits = -1;
    const uniforms = reflectorMaterial.uniforms as Record<string, THREE.IUniform | undefined>;
    if (uniforms.blurAmount) uniforms.blurAmount.value = 2.15 / textureSize;
    if (uniforms.reflectionStrength) uniforms.reflectionStrength.value = 0.2;
    if (uniforms.fadeNear) uniforms.fadeNear.value = 2.6;
    if (uniforms.fadeFar) uniforms.fadeFar.value = 17.5;
    if (uniforms.noiseAmount) uniforms.noiseAmount.value = 0.36;
    if (uniforms.noiseScale) uniforms.noiseScale.value = 205.0;
    mesh.userData[FLOOR_REFLECTOR_KEY] = reflector;
    mesh.add(reflector);
  }

  private ensureFloorShadowCatcher(mesh: THREE.Mesh) {
    if (!this.isFloorMesh(mesh)) return;
    const geometry = mesh.geometry as THREE.BufferGeometry;

    const existing = mesh.userData[FLOOR_SHADOW_CATCHER_KEY] as THREE.Mesh | undefined;
    if (existing?.parent === mesh && existing.userData?.sourceGeometry === geometry.uuid) return;
    if (existing) {
      existing.removeFromParent();
      disposeObject3D(existing);
      delete mesh.userData[FLOOR_SHADOW_CATCHER_KEY];
    }

    const shadowMaterial = new THREE.ShadowMaterial({
      color: 0x000000,
      opacity: 0.34,
    });
    shadowMaterial.depthWrite = false;
    shadowMaterial.transparent = true;
    shadowMaterial.polygonOffset = true;
    shadowMaterial.polygonOffsetFactor = -1;
    shadowMaterial.polygonOffsetUnits = -2;

    const shadowCatcher = new THREE.Mesh(geometry, shadowMaterial);
    shadowCatcher.name = FLOOR_SHADOW_CATCHER_NAME;
    shadowCatcher.position.z = 0.00055;
    shadowCatcher.renderOrder = mesh.renderOrder + 2;
    shadowCatcher.layers.set(0);
    shadowCatcher.castShadow = false;
    shadowCatcher.receiveShadow = true;
    shadowCatcher.userData[NON_PICKABLE_KEY] = true;
    shadowCatcher.userData.sourceGeometry = geometry.uuid;

    mesh.userData[FLOOR_SHADOW_CATCHER_KEY] = shadowCatcher;
    mesh.add(shadowCatcher);
  }

  private applyViewportShading(root: THREE.Object3D) {
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const anyMesh = mesh as any;
      if (anyMesh.isURDFCollider || obj.userData?.editorKind === "collision") {
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        return;
      }
      if (obj.userData?.[URDF_HELPER_KEY] || obj.userData?.[NON_PICKABLE_KEY]) {
        mesh.castShadow = false;
        return;
      }

      const isFloorPlane = (mesh.geometry as THREE.BufferGeometry | undefined)?.type === "PlaneGeometry";
      mesh.castShadow = !isFloorPlane;
      mesh.receiveShadow = true;

      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map((mat) => (mat ? this.tuneViewportMaterial(mat) : mat)) as typeof mesh.material;
      } else if (mesh.material) {
        mesh.material = this.tuneViewportMaterial(mesh.material) as typeof mesh.material;
      }

      if (this.isFloorMesh(mesh)) {
        this.tuneFloorSurfaceMaterial(mesh);
      }

      this.ensureMeshEdgeOverlay(mesh);
      this.ensureFloorShadowCatcher(mesh);
      this.ensureFloorReflector(mesh);
    });
  }

  private updateMainShadowFrustum() {
    if (!this.mainShadowLight || !this.userRoot) return;
    const shadowCamera = this.mainShadowLight.shadow.camera as THREE.OrthographicCamera;
    const bounds = new THREE.Box3().setFromObject(this.userRoot);
    if (bounds.isEmpty()) return;

    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    bounds.getCenter(center);
    bounds.getSize(size);

    const radius = Math.max(2.5, Math.max(size.x, size.y) * 0.75 + 2.2);
    const height = Math.max(2.0, size.z + 4.0);
    const direction = (
      (this.mainShadowLight.userData?.shadowDirection as THREE.Vector3 | undefined)?.clone() ??
      new THREE.Vector3(0.52, 0.78, 0.34)
    ).normalize();

    const lightDistance = radius + height * 0.9 + 6.0;
    this.mainShadowLight.position.copy(center).addScaledVector(direction, lightDistance);
    this.mainShadowLight.target.position.copy(center);
    this.mainShadowLight.target.updateMatrixWorld();
    this.mainShadowLight.updateMatrixWorld();

    shadowCamera.left = -radius;
    shadowCamera.right = radius;
    shadowCamera.top = radius;
    shadowCamera.bottom = -radius;
    shadowCamera.near = 0.2;
    shadowCamera.far = Math.max(20, lightDistance * 2.4 + height);
    shadowCamera.updateProjectionMatrix();
  }

  private isTransformControlObject(obj: THREE.Object3D | null) {
    let cur: any = obj;
    while (cur) {
      if (cur.isTransformControls || cur.isTransformControlsGizmo || cur.isTransformControlsPlane) return true;
      cur = cur.parent;
    }
    return false;
  }

  private isUnderUserRoot(obj: THREE.Object3D | null) {
    let cur: THREE.Object3D | null = obj;
    while (cur) {
      if (cur === this.userRoot) return true;
      cur = cur.parent;
    }
    return false;
  }

  private isSelectionHelperObject(obj: THREE.Object3D | null) {
    return this.selection.isSelectionHelperObject(obj);
  }

  private isNonPickableObject(obj: THREE.Object3D | null) {
    let cur: THREE.Object3D | null = obj;
    while (cur) {
      if (cur.userData?.[NON_PICKABLE_KEY]) return true;
      cur = cur.parent;
    }
    return false;
  }

  private resolvePickObject(obj: THREE.Object3D) {
    let cur: THREE.Object3D | null = obj;
    let foundEditorLink: THREE.Object3D | null = null;
    let isEditorChild = false;
    while (cur) {
      const anyCur = cur as any;
      if (anyCur.isURDFLink) {
        if (cur.userData?.__nonPickableSelf) {
          cur = cur.parent;
          continue;
        }
        return cur;
      }
      const editorKind = cur.userData?.editorKind;
      if (editorKind === "mesh" || editorKind === "visual" || editorKind === "collision") {
        isEditorChild = true;
      }
      if (!foundEditorLink && editorKind === "link") {
        foundEditorLink = cur;
      }
      cur = cur.parent;
    }
    if (foundEditorLink && isEditorChild) return foundEditorLink;
    return obj;
  }

  private setTransformControlsEnabled(enabled: boolean) {
    if (!this.transformControls) return;
    (this.transformControls as unknown as { enabled: boolean }).enabled = enabled;
  }

  private frameObject(obj: THREE.Object3D) {
    if (!this.camera || !this.controls) return;

    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty()) return;

    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const maxDim = Math.max(size.x, size.y, size.z);
    const dist = maxDim * 1.6 + 1.0;

    this.controls.target.copy(center);
    this.camera.position.set(center.x + dist, center.y + dist * 0.7, center.z + dist);
    this.camera.lookAt(center);
    this.controls.update();
  }

  private buildPointerRay(clientX: number, clientY: number) {
    if (!this.canvas || !this.camera) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -(((clientY - rect.top) / rect.height) * 2 - 1);
    this.pointer.set(x, y);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return {
      origin: this.raycaster.ray.origin.clone(),
      direction: this.raycaster.ray.direction.clone(),
    };
  }

  private pickFromCurrentRay() {
    if (!this.scene) return null;

    const hits = this.raycaster.intersectObjects(this.scene.children, true);
    if (!hits.length) return null;

    const pickFromHits = (preferUserRoot: boolean) => {
      for (const hit of hits) {
        const obj = hit.object;
        if (this.isTransformControlObject(obj)) continue;
        if (this.isSelectionHelperObject(obj)) continue;
        if (this.isNonPickableObject(obj)) continue;
        if (preferUserRoot && this.userRoot && !this.isUnderUserRoot(obj)) continue;
        return hit;
      }
      return null;
    };

    const selectedHit = pickFromHits(true) ?? pickFromHits(false);
    if (!selectedHit) return null;

    const target = this.resolvePickObject(selectedHit.object);
    if (target.userData?.__nonPickableSelf) return null;

    const worldPosition = new THREE.Vector3();
    target.getWorldPosition(worldPosition);
    const normal = selectedHit.face
      ? selectedHit.face.normal.clone().transformDirection(selectedHit.object.matrixWorld).normalize()
      : this.raycaster.ray.direction.clone().negate();

    return {
      id: getDocId(target),
      name: target.name || target.type,
      position: { x: worldPosition.x, y: worldPosition.y, z: worldPosition.z },
      point: { x: selectedHit.point.x, y: selectedHit.point.y, z: selectedHit.point.z },
      normal: { x: normal.x, y: normal.y, z: normal.z },
      distance: selectedHit.distance,
    };
  }

  private buildPointerEventInfo(ev: PointerEvent): PointerEventInfo {
    const ray = this.buildPointerRay(ev.clientX, ev.clientY);
    const pick = ray ? this.pickFromCurrentRay() : null;
    return {
      pointerId: ev.pointerId,
      button: ev.button,
      buttons: ev.buttons,
      clientX: ev.clientX,
      clientY: ev.clientY,
      altKey: ev.altKey,
      ctrlKey: ev.ctrlKey,
      shiftKey: ev.shiftKey,
      metaKey: ev.metaKey,
      ray: ray
        ? {
            origin: { x: ray.origin.x, y: ray.origin.y, z: ray.origin.z },
            direction: { x: ray.direction.x, y: ray.direction.y, z: ray.direction.z },
          }
        : null,
      pick,
    };
  }

  private buildPointerMoveEventInfo(ev: PointerEvent): PointerMoveEventInfo {
    const prev = this.pointerMovePos ?? { x: ev.clientX, y: ev.clientY };
    const base = this.buildPointerEventInfo(ev);
    return {
      ...base,
      deltaX: ev.clientX - prev.x,
      deltaY: ev.clientY - prev.y,
    };
  }

  private clearActivePointer(pointerId?: number) {
    const releasePointerId = pointerId ?? this.activePointerId ?? undefined;
    if (this.canvas && releasePointerId !== undefined) {
      try {
        this.canvas.releasePointerCapture(releasePointerId);
      } catch {
        // ignore
      }
    }
    this.activePointerId = null;
    this.activePointerConsumed = false;
    this.pointerMovePos = null;
  }

  private onPointerDown = (ev: PointerEvent) => {
    if (!this.canvas || !this.camera || !this.scene) return;
    if (ev.button !== 0) return;
    if (this.isTransformDragging) return;

    const info = this.buildPointerEventInfo(ev);
    const consumed = this.events.onPointerDown?.(info) === true;
    if (consumed) {
      this.activePointerId = ev.pointerId;
      this.activePointerConsumed = true;
      this.pointerMovePos = { x: ev.clientX, y: ev.clientY };
      this.pointerDownPos = null;
      try {
        this.canvas.setPointerCapture(ev.pointerId);
      } catch {
        // ignore
      }
      ev.preventDefault();
      return;
    }

    this.clearActivePointer();
    this.pointerDownPos = { x: ev.clientX, y: ev.clientY };
  };

  private onPointerMove = (ev: PointerEvent) => {
    if (!this.activePointerConsumed) return;
    if (this.activePointerId !== ev.pointerId) return;
    const info = this.buildPointerMoveEventInfo(ev);
    this.pointerMovePos = { x: ev.clientX, y: ev.clientY };
    this.events.onPointerMove?.(info);
  };

  private onPointerUp = (ev: PointerEvent) => {
    if (!this.canvas || !this.camera || !this.scene) return;
    if (ev.button !== 0) return;

    if (this.activePointerConsumed && this.activePointerId === ev.pointerId) {
      const info = this.buildPointerEventInfo(ev);
      this.events.onPointerUp?.(info);
      this.pointerDownPos = null;
      this.clearActivePointer(ev.pointerId);
      return;
    }

    if (this.isTransformDragging) return;

    const start = this.pointerDownPos;
    this.pointerDownPos = null;
    if (!start) return;

    const dx = ev.clientX - start.x;
    const dy = ev.clientY - start.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 4) return;

    const info = this.buildPointerEventInfo(ev);
    if (!info.pick) {
      this.events.onPick?.(null);
      return;
    }

    const pick: PickResult = {
      id: info.pick.id,
      name: info.pick.name,
      position: info.pick.position,
    };

    this.events.onPick?.(pick);
  };

  private onPointerCancel = (ev: PointerEvent) => {
    if (!(this.activePointerConsumed && this.activePointerId === ev.pointerId)) return;
    const info = this.buildPointerEventInfo(ev);
    this.events.onPointerCancel?.(info);
    this.pointerDownPos = null;
    this.clearActivePointer(ev.pointerId);
  };

  private onResize = () => {
    if (!this.canvas || !this.renderer || !this.camera) return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w <= 0 || h <= 0) return;

    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private renderLoop = () => {
    this.animId = requestAnimationFrame(this.renderLoop);
    if (!this.renderer || !this.scene || !this.camera) return;

    this.controls?.update();
    if (!this.lastFrameTime) this.lastFrameTime = performance.now();
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0, (now - this.lastFrameTime) / 1000));
    this.lastFrameTime = now;
    this.frameCallback?.(dt);
    this.updateMainShadowFrustum();

    this.selection.updateSelectionBox();

    this.renderer.render(this.scene, this.camera);
    this.renderOrientationGizmo();
  };
}
