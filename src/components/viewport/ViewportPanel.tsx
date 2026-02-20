import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { Viewer } from "../../app/core/viewer/Viewer";
import { addSceneAsset } from "../../app/core/editor/actions/sceneAssetActions";
import { useAppStore } from "../../app/core/store/useAppStore";
import { useAssetStore } from "../../app/core/store/useAssetStore";
import { useSceneStore } from "../../app/core/store/useSceneStore";
import { useMujocoStore } from "../../app/core/store/useMujocoStore";
import { useUrdfImportDialogStore } from "../../app/core/store/useUrdfImportDialogStore";
import { loadWorkspaceURDFIntoViewer } from "../../app/core/loaders/urdfLoader";
import { logInfo } from "../../app/core/services/logger";
import type { SceneAssetId } from "../../app/core/scene/sceneAssets";
import { DarkSelect } from "../../app/ui/DarkSelect";
import { tickSimulation } from "./services/simulationService";
import ViewportControls, { type UrdfDebugOptions } from "./ViewportControls";
import { editorEngine } from "../../app/core/editor/engineSingleton";
import { ThreeSceneAdapter } from "../../app/core/editor/adapters/three/ThreeSceneAdapter";
import { setThreeAdapter } from "../../app/core/editor/adapters/three/adapterSingleton";
import { hasBrowserImportPayload, payloadFromDataTransfer, type BrowserImportPayload } from "../asset-library/browserDragDrop";
import { CARTPOLE_SAMPLE_URDF, CARTPOLE_SAMPLE_NAME, findCartpoleSampleKey } from "../asset-library/cartpoleSample";

const pointerPointFromRay = (ray: { origin: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number } }, depth: number) => ({
  x: ray.origin.x + ray.direction.x * depth,
  y: ray.origin.y + ray.direction.y * depth,
  z: ray.origin.z + ray.direction.z * depth,
});

const dropHintFromPayload = (payload: BrowserImportPayload) => {
  if (payload.kind === "workspace-urdf") return `Drop to configure URDF import: ${payload.label}`;
  if (payload.kind === "sample") return `Drop to configure sample import: ${payload.label}`;
  return `Drop to import: ${payload.label}`;
};

const isMeshAssetId = (assetId: SceneAssetId) => assetId.startsWith("mesh:");
const toUiCollisionMode = (mode: string | undefined) => (mode === "mesh" ? "mesh" : "fast");

type UrdfDialogFormOptions = {
  urdfZUp: boolean;
  floatingBase: boolean;
  firstLinkIsWorldReferenceFrame: boolean;
  selfCollision: boolean;
  collisionMode: "mesh" | "fast";
};

function UrdfImportDialogOverlay(props: {
  urdfKey: string | null;
  initialOptions: UrdfDialogFormOptions;
  onCancel: () => void;
  onConfirm: (options: UrdfDialogFormOptions) => void;
}) {
  const { urdfKey, initialOptions, onCancel, onConfirm } = props;
  const [urdfZUp, setUrdfZUp] = useState(initialOptions.urdfZUp);
  const [floatingBase, setFloatingBase] = useState(initialOptions.floatingBase);
  const [firstLinkIsWorldReferenceFrame, setFirstLinkIsWorldReferenceFrame] = useState(
    initialOptions.firstLinkIsWorldReferenceFrame
  );
  const [selfCollision, setSelfCollision] = useState(initialOptions.selfCollision);
  const [collisionMode, setCollisionMode] = useState<"mesh" | "fast">(initialOptions.collisionMode);

  return (
    <div
      onMouseDown={() => onCancel()}
      style={{
        position: "absolute",
        inset: 0,
        background: "rgba(4,8,12,0.52)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 40,
        padding: 16,
      }}
    >
      <div
        onMouseDown={(event) => event.stopPropagation()}
        style={{
          width: "min(352px, 100%)",
          borderRadius: 12,
          background: "rgba(12,16,22,0.98)",
          border: "1px solid rgba(255,255,255,0.08)",
          color: "rgba(255,255,255,0.9)",
          boxShadow: "0 14px 40px rgba(0,0,0,0.45)",
          padding: 16,
          display: "grid",
          gap: 12,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600 }}>Import URDF options</div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>Configure how this URDF is loaded into the editor and MuJoCo.</div>
        <div
          style={{
            fontSize: 11,
            opacity: 0.66,
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 8,
            padding: "6px 8px",
            background: "rgba(255,255,255,0.04)",
          }}
          title={urdfKey ?? undefined}
        >
          {urdfKey ?? "No URDF selected"}
        </div>
        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, lineHeight: 1.35 }}>
          <input type="checkbox" checked={urdfZUp} onChange={(e) => setUrdfZUp(e.target.checked)} />
          URDF uses Z-up (ROS) and should rotate to editor Y-up
        </label>
        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, lineHeight: 1.35 }}>
          <input type="checkbox" checked={floatingBase} onChange={(e) => setFloatingBase(e.target.checked)} />
          Floating base (free root joint)
        </label>
        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, lineHeight: 1.35 }}>
          <input
            type="checkbox"
            checked={firstLinkIsWorldReferenceFrame}
            onChange={(e) => setFirstLinkIsWorldReferenceFrame(e.target.checked)}
          />
          First link is world reference frame (ignore it)
        </label>
        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, lineHeight: 1.35 }}>
          <input type="checkbox" checked={selfCollision} onChange={(e) => setSelfCollision(e.target.checked)} />
          Enable self-collisions (robot vs robot)
        </label>
        <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
          <span>Collision mode for meshes</span>
          <DarkSelect
            value={collisionMode}
            onChange={(e) => setCollisionMode(e.target.value as "mesh" | "fast")}
            style={{ background: "rgba(12,16,22,0.98)" }}
          >
            <option value="mesh">Precise (source mesh)</option>
            <option value="fast">Fast (auto box/cylinder)</option>
          </DarkSelect>
        </label>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button
            onClick={() => onCancel()}
            style={{
              height: 28,
              padding: "0 12px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.06)",
              color: "rgba(255,255,255,0.9)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Cancel
          </button>
          <button
            onClick={() =>
              onConfirm({
                urdfZUp,
                floatingBase,
                firstLinkIsWorldReferenceFrame,
                selfCollision,
                collisionMode,
              })
            }
            disabled={!urdfKey}
            style={{
              height: 28,
              padding: "0 12px",
              borderRadius: 8,
              border: "1px solid rgba(80,160,255,0.4)",
              background: "rgba(80,160,255,0.25)",
              color: "rgba(255,255,255,0.95)",
              cursor: urdfKey ? "pointer" : "default",
              opacity: urdfKey ? 1 : 0.5,
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            Import URDF
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ViewportPanel() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dropDragCounterRef = useRef(0);
  const dropSpawnIndexRef = useRef(0);

  const setSelected = useAppStore((s) => s.setSelected);
  const selected = useAppStore((s) => s.selected);
  const simState = useAppStore((s) => s.simState);
  const setViewer = useAppStore((s) => s.setViewer);
  const setTransformDragging = useAppStore((s) => s.setTransformDragging);
  const setSceneSelected = useSceneStore((s) => s.setSelected);
  const selectedKind = useSceneStore((s) => (s.selectedId ? s.nodes[s.selectedId]?.kind : null));
  const urdfDialogOpen = useUrdfImportDialogStore((s) => s.isOpen);
  const urdfDialogKey = useUrdfImportDialogStore((s) => s.urdfKey);
  const urdfDialogOptionOverrides = useUrdfImportDialogStore((s) => s.optionOverrides);
  const requestUrdfImport = useUrdfImportDialogStore((s) => s.requestImport);
  const closeUrdfImportDialog = useUrdfImportDialogStore((s) => s.close);
  const urdfOptions = useAssetStore((s) => s.urdfOptions);
  const setURDF = useAssetStore((s) => s.setURDF);
  const setURDFOptions = useAssetStore((s) => s.setURDFOptions);

  const viewer = useMemo(() => new Viewer(), []);
  const adapterRef = useRef<ThreeSceneAdapter | null>(null);
  const pointerInteractionRef = useRef<{ pointerId: number; depth: number } | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [dropHint, setDropHint] = useState("Drop to import");
  const [transformMode, setTransformMode] = useState<"translate" | "rotate" | "scale">("translate");
  const [snapActive, setSnapActive] = useState(false);
  const [simFps, setSimFps] = useState<number | null>(null);
  const fpsAccumRef = useRef({ elapsedSec: 0, frames: 0 });
  const fpsLastFrameRef = useRef<number | null>(null);
  const handleDebugChange = useCallback(
    (options: UrdfDebugOptions) => {
      viewer.setUrdfDebugOptions(options);
    },
    [viewer]
  );

  const selectRobotWorldReferenceFromLink = useCallback(() => {
    const scene = useSceneStore.getState();
    const currentId = scene.selectedId;
    if (!currentId) return;
    const currentNode = scene.nodes[currentId];
    if (!currentNode || currentNode.kind !== "link") return;

    const parentKind = currentNode.parentId ? scene.nodes[currentNode.parentId]?.kind ?? null : null;
    const hasJointParent = parentKind === "joint";
    const hasJointChild = currentNode.children.some((childId) => scene.nodes[childId]?.kind === "joint");
    if (!hasJointParent && !hasJointChild) return;

    let ancestorId: string | null = currentNode.id;
    while (ancestorId) {
      const ancestorNode = scene.nodes[ancestorId] as typeof currentNode | undefined;
      if (!ancestorNode) return;
      if (ancestorNode.kind === "robot") break;
      ancestorId = ancestorNode.parentId ?? null;
    }
    if (!ancestorId || ancestorId === currentId) return;

    const app = useAppStore.getState();
    const viewerInstance = app.viewer;
    const robotNode = scene.nodes[ancestorId];
    scene.setSelected(ancestorId);
    viewerInstance?.setSelected?.(ancestorId);
    const pos = viewerInstance?.getObjectWorldPosition?.(ancestorId);
    app.setSelected({
      id: ancestorId,
      name: robotNode?.name || ancestorId,
      position: pos ?? { x: 0, y: 0, z: 0 },
    });
  }, []);

  const resetDropState = useCallback(() => {
    dropDragCounterRef.current = 0;
    setDropActive(false);
    setDropHint("Drop to import");
  }, []);

  const importDroppedPayload = useCallback(
    (payload: BrowserImportPayload) => {
      if (payload.kind === "asset") {
        const assetId = payload.assetId;
        const isMesh = isMeshAssetId(assetId);
        const idx = isMesh ? dropSpawnIndexRef.current++ : dropSpawnIndexRef.current;
        const position = isMesh
          ? {
              x: idx * 1.5,
              y: 1.5,
              z: assetId === "mesh:sphere" ? -0.2 : 0,
            }
          : undefined;
        addSceneAsset(assetId, { position });
        logInfo(`Viewport drop import: ${payload.label}`, { scope: "assets", data: { assetId } });
        return;
      }

      if (payload.kind === "sample" && payload.sample === "cartpole") {
        let assetStore = useAssetStore.getState();
        let sampleKey = findCartpoleSampleKey(Object.keys(assetStore.assets));
        if (!sampleKey) {
          const sampleFile = new File([CARTPOLE_SAMPLE_URDF], CARTPOLE_SAMPLE_NAME, { type: "application/xml" });
          assetStore.importFiles([sampleFile]);
          assetStore = useAssetStore.getState();
          sampleKey = findCartpoleSampleKey(Object.keys(assetStore.assets));
        }
        if (!sampleKey) return;
        assetStore.setURDF(sampleKey);
        requestUrdfImport({
          urdfKey: sampleKey,
          source: "viewport-drop",
          optionOverrides: { floatingBase: false },
        });
        logInfo("Viewport drop import request: Cartpole sample URDF", {
          scope: "assets",
          data: { urdfKey: sampleKey },
        });
        return;
      }

      if (payload.kind === "workspace-urdf") {
        const assetStore = useAssetStore.getState();
        const entry = assetStore.assets[payload.path];
        if (!entry) return;
        assetStore.setURDF(payload.path);
        requestUrdfImport({
          urdfKey: payload.path,
          source: "viewport-drop",
        });
        logInfo(`Viewport drop import request: ${payload.path}`, { scope: "assets", data: { urdfKey: payload.path } });
      }
    },
    [requestUrdfImport]
  );

  const onViewportDragEnter = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasBrowserImportPayload(event.dataTransfer)) return;
    event.preventDefault();
    dropDragCounterRef.current += 1;
    setDropActive(true);
    const payload = payloadFromDataTransfer(event.dataTransfer);
    setDropHint(payload ? dropHintFromPayload(payload) : "Drop to import");
  }, []);

  const onViewportDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasBrowserImportPayload(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropActive(true);
    const payload = payloadFromDataTransfer(event.dataTransfer);
    setDropHint(payload ? dropHintFromPayload(payload) : "Drop to import");
  }, []);

  const onViewportDragLeave = useCallback(() => {
    dropDragCounterRef.current = Math.max(0, dropDragCounterRef.current - 1);
    if (dropDragCounterRef.current === 0) {
      setDropActive(false);
      setDropHint("Drop to import");
    }
  }, []);

  const onViewportDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      resetDropState();
      if (!hasBrowserImportPayload(event.dataTransfer)) return;
      event.preventDefault();
      const payload = payloadFromDataTransfer(event.dataTransfer);
      if (!payload) return;
      void importDroppedPayload(payload);
    },
    [importDroppedPayload, resetDropState]
  );

  const urdfDialogInitialOptions = useMemo<UrdfDialogFormOptions>(() => {
    const overrides = urdfDialogOptionOverrides ?? {};
    return {
      urdfZUp: overrides.urdfZUp ?? urdfOptions.urdfZUp,
      floatingBase: overrides.floatingBase ?? urdfOptions.floatingBase,
      firstLinkIsWorldReferenceFrame:
        overrides.firstLinkIsWorldReferenceFrame ?? urdfOptions.firstLinkIsWorldReferenceFrame,
      selfCollision: overrides.selfCollision ?? urdfOptions.selfCollision,
      collisionMode: toUiCollisionMode(overrides.collisionMode ?? urdfOptions.collisionMode),
    };
  }, [urdfDialogOptionOverrides, urdfOptions]);

  const confirmLoadURDF = useCallback(async (selectedOptions: UrdfDialogFormOptions) => {
    if (!urdfDialogKey) return;

    setURDF(urdfDialogKey);
    setURDFOptions(selectedOptions);
    closeUrdfImportDialog();
    const assetStore = useAssetStore.getState();
    await loadWorkspaceURDFIntoViewer({
      viewer,
      urdfKey: urdfDialogKey,
      assets: assetStore.assets,
      importOptions: selectedOptions,
    });
    logInfo("Viewport URDF import confirmed", {
      scope: "assets",
      data: { urdfKey: urdfDialogKey, options: selectedOptions },
    });
  }, [closeUrdfImportDialog, setURDF, setURDFOptions, urdfDialogKey, viewer]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (e.repeat) return;

      const key = e.key.toLowerCase();
      if (key === "w") setTransformMode("translate");
      if (key === "e") setTransformMode("rotate");
      if (key === "r") setTransformMode("scale");
      if (key === "q") selectRobotWorldReferenceFromLink();
      if (e.key === "Shift") setSnapActive(true);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") setSnapActive(false);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [selectRobotWorldReferenceFromLink]);

  useEffect(() => {
    viewer.setTransformMode(transformMode);
  }, [viewer, transformMode]);

  useEffect(() => {
    viewer.setTransformEnabled(simState !== "playing");
  }, [viewer, simState]);

  useEffect(() => {
    const nextSpace =
      selectedKind === "mesh" || selectedKind === "link" || selectedKind === "joint" ? "local" : "world";
    viewer.setTransformSpace(nextSpace);
  }, [viewer, selectedKind]);

  useEffect(() => {
    viewer.setTranslationSnap(snapActive ? 0.25 : null);
    viewer.setRotationSnap(snapActive ? Math.PI / 12 : null);
  }, [viewer, snapActive]);

  useEffect(() => {
    viewer.setFrameCallback((dt) => {
      tickSimulation(dt);

      const now = performance.now();
      const last = fpsLastFrameRef.current;
      fpsLastFrameRef.current = now;
      const frameDt = last !== null ? Math.max(0, (now - last) / 1000) : 0;
      const fpsAccum = fpsAccumRef.current;
      if (frameDt > 0) {
        fpsAccum.elapsedSec += frameDt;
        fpsAccum.frames += 1;
        if (fpsAccum.elapsedSec >= 0.5) {
          setSimFps(fpsAccum.frames / fpsAccum.elapsedSec);
          fpsAccum.elapsedSec = 0;
          fpsAccum.frames = 0;
        }
      }

      const spring = useMujocoStore.getState().getPointerSpringDebugState();
      if (spring) {
        viewer.setPointerSpringVisual({
          anchor: spring.anchor,
          target: spring.target,
          forceMagnitudeN: spring.forceMagnitudeN,
          maxForceN: spring.maxForceN,
          distanceMeters: spring.distanceMeters,
        });
      } else {
        viewer.setPointerSpringVisual(null);
      }
    });
    return () => {
      viewer.setFrameCallback(null);
      viewer.setPointerSpringVisual(null);
      fpsLastFrameRef.current = null;
    };
  }, [viewer]);

  useEffect(() => {
    if (simState === "playing") return;
    if (!pointerInteractionRef.current) return;
    pointerInteractionRef.current = null;
    useMujocoStore.getState().endPointerInteraction();
    viewer.setOrbitEnabled(true);
    viewer.setPointerSpringVisual(null);
  }, [simState, viewer]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    viewer.init(canvas, {
      onPick: (pick) => {
        if (!pick) {
          viewer.setSelected?.(null);
          setSelected(null);
          setSceneSelected(null);
          return;
        }
        viewer.setSelected?.(pick.id);
        setSelected(pick);
        setSceneSelected(pick.id);
      },
      onTransformDragging: (dragging) => {
        setTransformDragging(dragging);
      },
      onTransformChange: (id) => {
        if (useAppStore.getState().simState === "playing") return;
        adapterRef.current?.syncTransformFromViewer(id, { recordHistory: false });
      },
      onTransformEnd: (id) => {
        if (useAppStore.getState().simState === "playing") return;
        useMujocoStore.getState().markSceneDirty();
        if (id) adapterRef.current?.syncTransformFromViewer(id, { recordHistory: true });
      },
      onPointerDown: (event) => {
        if (useAppStore.getState().simState !== "playing") return false;
        if (!event.altKey) return false;
        if (!event.ray) return false;

        const depth = Number.isFinite(event.pick?.distance)
          ? Math.max(0.2, Math.min(50, event.pick?.distance ?? 2.5))
          : 2.5;
        const startPoint = event.pick?.point ?? pointerPointFromRay(event.ray, depth);
        const mode = useMujocoStore.getState().beginPointerInteraction(event.pick?.id ?? null, startPoint);
        if (mode === "none") return false;

        pointerInteractionRef.current = { pointerId: event.pointerId, depth };
        viewer.setOrbitEnabled(false);
        useMujocoStore.getState().updatePointerTarget(startPoint);
        return true;
      },
      onPointerMove: (event) => {
        const active = pointerInteractionRef.current;
        if (!active) return;
        if (active.pointerId !== event.pointerId) return;
        if (!event.ray) return;
        const nextPoint = pointerPointFromRay(event.ray, active.depth);
        useMujocoStore.getState().updatePointerTarget(nextPoint);
      },
      onPointerUp: (event) => {
        const active = pointerInteractionRef.current;
        if (!active || active.pointerId !== event.pointerId) return;
        pointerInteractionRef.current = null;
        useMujocoStore.getState().endPointerInteraction();
        viewer.setOrbitEnabled(true);
        viewer.setPointerSpringVisual(null);
      },
      onPointerCancel: (event) => {
        const active = pointerInteractionRef.current;
        if (!active || active.pointerId !== event.pointerId) return;
        pointerInteractionRef.current = null;
        useMujocoStore.getState().endPointerInteraction();
        viewer.setOrbitEnabled(true);
        viewer.setPointerSpringVisual(null);
      },
    });
    setViewer(viewer);
    adapterRef.current = new ThreeSceneAdapter(editorEngine, viewer);
    setThreeAdapter(adapterRef.current);
    adapterRef.current.applyDoc(editorEngine.getDoc(), { reason: "viewport:init" });
    const unsubscribeDoc = editorEngine.on("doc:changed", (event) => {
      adapterRef.current?.applyDoc(event.doc, { reason: event.reason });
    });

    const ro = new ResizeObserver(() => {
      const r = container.getBoundingClientRect();
      viewer.resize(r.width, r.height);
    });
    ro.observe(container);

    const r0 = container.getBoundingClientRect();
    viewer.resize(r0.width, r0.height);

    const mujoco = useMujocoStore.getState();
    if (!mujoco.isLoading && (!mujoco.isReady || mujoco.isDirty)) {
      void mujoco.reload();
    }

    return () => {
      ro.disconnect();
      unsubscribeDoc();
      adapterRef.current = null;
      setThreeAdapter(null);
      pointerInteractionRef.current = null;
      useMujocoStore.getState().endPointerInteraction();
      viewer.setOrbitEnabled(true);
      viewer.setPointerSpringVisual(null);
      setTransformDragging(false);
      setViewer(null);
      viewer.dispose();
    };
  }, [viewer, setSelected, setViewer, setSceneSelected, setTransformDragging]);

  return (
    <div style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column" }}>
      {/* mini-toolbar del panel (porque el header del DockArea es genérico) */}
      <div
        style={{
          height: 34,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 10px",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          background: "rgba(0,0,0,0.10)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <div style={{ opacity: 0.65, fontSize: 12 }}>sim: {simState}</div>
          <div style={{ opacity: 0.65, fontSize: 12 }}>tool: {transformMode}</div>
          <div style={{ opacity: 0.65, fontSize: 12 }}>
            space: {selectedKind === "mesh" || selectedKind === "link" || selectedKind === "joint" ? "local" : "world"}
          </div>
          {snapActive && (
            <div
              style={{
                fontSize: 11,
                padding: "2px 6px",
                borderRadius: 999,
                border: "1px solid rgba(120,200,255,0.28)",
                background: "rgba(120,200,255,0.12)",
                color: "rgba(225,245,255,0.92)",
              }}
            >
              snap
            </div>
          )}
          <div
            style={{
              opacity: 0.65,
              fontSize: 12,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={selected?.id ?? undefined}
          >
            sel: {selected?.name ?? "none"}
          </div>
        </div>
        <div style={{ opacity: 0.78, fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
          fps: {simFps ? Math.round(simFps) : "--"}
        </div>
      </div>

      <div
        ref={containerRef}
        style={{ flex: 1, minHeight: 0, position: "relative" }}
        onDragEnter={onViewportDragEnter}
        onDragOver={onViewportDragOver}
        onDragLeave={onViewportDragLeave}
        onDrop={onViewportDrop}
      >
        <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
        {dropActive && (
          <div
            style={{
              position: "absolute",
              inset: 10,
              borderRadius: 12,
              border: "2px dashed rgba(120,190,255,0.9)",
              background: "linear-gradient(160deg, rgba(70,130,195,0.22) 0%, rgba(20,32,48,0.42) 100%)",
              boxShadow: "0 0 0 1px rgba(130,200,255,0.28), 0 20px 50px rgba(8,20,34,0.55)",
              animation: "viewportDropPulse 1.1s ease-in-out infinite",
              pointerEvents: "none",
              display: "grid",
              placeItems: "center",
              textAlign: "center",
            }}
          >
            <div
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid rgba(190,230,255,0.35)",
                background: "rgba(8,16,28,0.78)",
                color: "rgba(230,244,255,0.96)",
                fontSize: 13,
                fontWeight: 600,
                maxWidth: 340,
              }}
            >
              {dropHint}
            </div>
          </div>
        )}
        {urdfDialogOpen && (
          <UrdfImportDialogOverlay
            key={`${urdfDialogKey ?? "dialog"}-${urdfDialogInitialOptions.urdfZUp ? 1 : 0}-${urdfDialogInitialOptions.floatingBase ? 1 : 0}-${urdfDialogInitialOptions.firstLinkIsWorldReferenceFrame ? 1 : 0}-${urdfDialogInitialOptions.selfCollision ? 1 : 0}-${urdfDialogInitialOptions.collisionMode}`}
            urdfKey={urdfDialogKey}
            initialOptions={urdfDialogInitialOptions}
            onCancel={closeUrdfImportDialog}
            onConfirm={(options) => {
              void confirmLoadURDF(options);
            }}
          />
        )}
        <ViewportControls onDebugChange={handleDebugChange} />
        <div
          style={{
            position: "absolute",
            left: 10,
            bottom: 10,
            padding: "8px 10px",
            borderRadius: 8,
            background: "rgba(8,12,18,0.72)",
            border: "1px solid rgba(255,255,255,0.08)",
            color: "rgba(255,255,255,0.78)",
            fontSize: 11,
            lineHeight: 1.5,
            backdropFilter: "blur(6px)",
            maxWidth: 220,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Gizmo</div>
          <div>W: Move</div>
          <div>E: Rotate</div>
          <div>R: Scale</div>
          <div>Q: Parent Robot Ref</div>
          <div>Shift: Snap (grid/rot)</div>
          <div>Alt + Right-Click drag: Grab robot (playing)</div>
        </div>
        <style>{`
          @keyframes viewportDropPulse {
            0% { box-shadow: 0 0 0 1px rgba(130,200,255,0.18), 0 18px 44px rgba(8,20,34,0.45); }
            50% { box-shadow: 0 0 0 2px rgba(160,220,255,0.40), 0 26px 60px rgba(8,20,34,0.66); }
            100% { box-shadow: 0 0 0 1px rgba(130,200,255,0.18), 0 18px 44px rgba(8,20,34,0.45); }
          }
        `}</style>
      </div>
    </div>
  );
}
