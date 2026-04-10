import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { Viewer } from "../../app/core/viewer/Viewer";
import { addSceneAsset } from "../../app/core/editor/actions/sceneAssetActions";
import { useAppStore } from "../../app/core/store/useAppStore";
import { useAssetStore } from "../../app/core/store/useAssetStore";
import { useSceneStore } from "../../app/core/store/useSceneStore";
import { useMujocoStore } from "../../app/core/store/useMujocoStore";
import { useUrdfImportDialogStore } from "../../app/core/store/useUrdfImportDialogStore";
import { useUsdImportDialogStore } from "../../app/core/store/useUsdImportDialogStore";
import { useTrainingImportContextStore } from "../../app/core/store/useTrainingImportContextStore";
import { useBrowserPreviewStore } from "../../app/core/store/useBrowserPreviewStore";
import type { UsdImportOptions } from "../../app/core/usd/usdImportOptions";
import { logInfo, logWarn } from "../../app/core/services/logger";
import type { SceneAssetId } from "../../app/core/scene/sceneAssets";
import { isUrdfLikePath } from "../../app/core/urdf/urdfFileTypes";
import { DarkSelect } from "../../app/ui/DarkSelect";
import { tickSimulation } from "./services/simulationService";
import ViewportControls, { type UrdfDebugOptions } from "./ViewportControls";
import { editorEngine } from "../../app/core/editor/engineSingleton";
import { ThreeSceneAdapter } from "../../app/core/editor/adapters/three/ThreeSceneAdapter";
import { setThreeAdapter } from "../../app/core/editor/adapters/three/adapterSingleton";
import { hasBrowserImportPayload, payloadFromDataTransfer, type BrowserImportPayload } from "../asset-library/browserDragDrop";
import {
  LIBRARY_ROOT,
  ensureLibraryCatalogLoaded,
  ensureLibrarySampleImported,
  ensureLibraryWorkspaceKeysImported,
  findLibrarySampleByWorkspaceKey,
  getLibrarySampleVariantByWorkspaceKey,
  getLibrarySampleById,
  getLibrarySampleEnvironmentById,
  listLibrarySampleEnvironments,
  listLibrarySampleUsdVariants,
  resolveDefaultSampleEnvironmentId,
  resolveLibraryBundleRoot,
  resolveLibraryWorkspaceKey,
} from "../asset-library/librarySamples";
import {
  ensureLibraryAssetPackItemImported,
  getLibraryAssetPackItemById,
  getLibraryAssetPackPresetById,
} from "../asset-library/libraryAssetPacks";
import { importManager, type ImportExecutionAction } from "../../app/core/environment/ImportManager";
import { environmentDocumentManager } from "../../app/core/environment/EnvironmentDocumentManager";
import {
  resolvePrimaryRobotImportTransformFromProjectDoc,
  resolvePrimaryRobotImportTransformFromTrainingArtifacts,
} from "../../app/core/training/builders/trainingBuildUtils";

const pointerPointFromRay = (ray: { origin: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number } }, depth: number) => ({
  x: ray.origin.x + ray.direction.x * depth,
  y: ray.origin.y + ray.direction.y * depth,
  z: ray.origin.z + ray.direction.z * depth,
});

const dropHintFromPayload = (payload: BrowserImportPayload) => {
  if (payload.kind === "workspace-urdf") return `Drop to configure URDF import: ${payload.label}`;
  if (payload.kind === "workspace-usd") return `Drop to configure USD import: ${payload.label}`;
  if (payload.kind === "sample") return `Drop to configure sample import: ${payload.label}`;
  return `Drop to import: ${payload.label}`;
};

const isMeshAssetId = (assetId: SceneAssetId) => assetId.startsWith("mesh:");
const toUiCollisionMode = (mode: string | undefined) => (mode === "mesh" ? "mesh" : "fast");
const USD_EXTS = [".usd", ".usda", ".usdc", ".usdz"];
const isUsdPath = (path: string) => {
  const lower = String(path ?? "").toLowerCase();
  return USD_EXTS.some((ext) => lower.endsWith(ext));
};
const normalizeWorkspaceFilePath = (path: string) => path.replace(/\\/g, "/").replace(/^\/+/, "");
const isLibraryWorkspaceKey = (path: string) => normalizeWorkspaceFilePath(path).startsWith(`${LIBRARY_ROOT}/`);
const BROWSER_PREVIEW_CAPTURE = {
  maxWidth: 640,
  maxHeight: 360,
  mimeType: "image/webp",
  quality: 0.78,
} as const;
const DEFAULT_URDF_DEBUG_OPTIONS: UrdfDebugOptions = {
  showVisuals: true,
  showCollisions: false,
  showInertias: false,
  showCOM: false,
  showAxes: false,
  showJointAxes: false,
};

function isTerrainLikeWorkspaceUsdKey(key: string): boolean {
  const normalized = normalizeWorkspaceFilePath(key).toLowerCase();
  if (!normalized) return false;
  if (/^library\/[^/]+\/terrain\/.+\.(usd|usda|usdc|usdz)$/i.test(normalized)) return true;
  return (
    normalized.includes("/terrain/") ||
    normalized.includes("/environment/") ||
    normalized.includes("flat_floor") ||
    normalized.includes("rough_terrain") ||
    normalized.includes("rough_generator") ||
    normalized.includes("rough_preview") ||
    normalized.includes("table_scene")
  );
}

function collectAllSceneRootsForReplacement(viewer: Viewer) {
  const roots = viewer.getUserRoots();
  const toRemove: Array<{ rootId: string; name: string }> = [];
  for (const root of roots) {
    const userData =
      root?.userData && typeof root.userData === "object" && !Array.isArray(root.userData)
        ? (root.userData as Record<string, unknown>)
        : {};
    const rootId = String(userData.docId ?? "").trim();
    if (!rootId) continue;
    toRemove.push({
      rootId,
      name: String(root.name ?? "").trim() || rootId,
    });
  }
  return toRemove;
}

function resolveScopedBundleHintPaths(usdKey: string, bundleHintPaths: string[] | null | undefined): string[] | undefined {
  const hints = (bundleHintPaths ?? [])
    .map((item) => String(item ?? "").trim())
    .map((item) => normalizeWorkspaceFilePath(item))
    .filter((item) => item.length > 0);
  if (hints.length === 0) return undefined;
  const uniqueHints = Array.from(new Set(hints));
  const normalizedUsdKey = normalizeWorkspaceFilePath(usdKey);
  const usdDir = (() => {
    const idx = normalizedUsdKey.lastIndexOf("/");
    return idx >= 0 ? normalizedUsdKey.slice(0, idx) : "";
  })();
  const usdIsLibraryKey = normalizedUsdKey.startsWith(`${LIBRARY_ROOT}/`);

  const sample = findLibrarySampleByWorkspaceKey(usdKey);
  if (!sample || sample.kind !== "usd") {
    const scoped = uniqueHints.filter((normalizedHint) => {
      if (!normalizedHint) return false;
      if (normalizedHint === normalizedUsdKey) return true;

      // For shared library keys (for example library/floors/*.usda), only allow
      // absolute library hints in the same directory. This prevents unrelated
      // sample-relative hints from being rebased into library/floors/* and
      // causing missing-asset validation failures.
      if (usdIsLibraryKey) {
        if (!normalizedHint.startsWith(`${LIBRARY_ROOT}/`)) return false;
        return Boolean(usdDir && normalizedHint.startsWith(`${usdDir}/`));
      }

      if (usdDir && normalizedHint.startsWith(`${usdDir}/`)) return true;
      if (normalizedHint.startsWith(`${LIBRARY_ROOT}/`)) return false;
      const rebasedHint = normalizeWorkspaceFilePath(usdDir ? `${usdDir}/${normalizedHint}` : normalizedHint);
      return rebasedHint === normalizedUsdKey || (usdDir.length > 0 && rebasedHint.startsWith(`${usdDir}/`));
    });
    return scoped.length > 0 ? scoped : undefined;
  }

  const sampleRoot = normalizeWorkspaceFilePath(resolveLibraryBundleRoot(sample));
  const samplePrefix = `${sampleRoot}/`;
  if (!normalizedUsdKey.startsWith(samplePrefix)) return hints;
  // For catalog-backed USD samples keep full sample-relative hint scope.
  // Variants often reference sibling trees (for example `configuration/` and `grippers/`)
  // that should not be dropped just because the selected entry lives under `Legacy/`.
  const scoped = uniqueHints.filter((normalizedHint) => {
    if (!normalizedHint) return false;
    if (normalizedHint.startsWith(`${LIBRARY_ROOT}/`)) {
      return normalizedHint === normalizedUsdKey || normalizedHint.startsWith(samplePrefix);
    }
    return true;
  });
  return scoped.length > 0 ? scoped : uniqueHints;
}

type UrdfDialogFormOptions = {
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

type UsdDialogFormOptions = {
  floatingBase: boolean;
  selfCollision: boolean;
};

type UsdDialogEnvironmentOption = {
  value: string;
  label: string;
  hint: string;
};

function UsdImportDialogOverlay(props: {
  usdKey: string | null;
  sample: ReturnType<typeof getLibrarySampleById>;
  initialEnvironmentId: string | null;
  initialOptions: UsdDialogFormOptions;
  onCancel: () => void;
  onConfirm: (input: {
    options: UsdDialogFormOptions;
    usdKey: string;
    environmentId: string | null;
  }) => void;
}) {
  const { usdKey, sample, initialEnvironmentId, initialOptions, onCancel, onConfirm } = props;
  const [floatingBase, setFloatingBase] = useState(initialOptions.floatingBase);
  const [selfCollision, setSelfCollision] = useState(initialOptions.selfCollision);
  const variantOptions = useMemo(() => {
    if (!sample || sample.kind !== "usd") {
      return usdKey ? [{ value: usdKey, label: (usdKey.split("/").pop() ?? usdKey).trim() }] : [];
    }
    return listLibrarySampleUsdVariants(sample, { selectedWorkspaceKey: usdKey }).map((variant) => ({
      value: resolveLibraryWorkspaceKey(sample, variant.entry),
      label: variant.label,
      ...(variant.description ? { description: variant.description } : {}),
      ...(variant.importHints ? { importHints: { ...variant.importHints } } : {}),
    }));
  }, [sample, usdKey]);
  const [selectedUsdKey, setSelectedUsdKey] = useState<string>(variantOptions[0]?.value ?? usdKey ?? "");
  const environmentOptions = useMemo<UsdDialogEnvironmentOption[]>(() => {
    if (!sample || sample.kind !== "usd") return [];
    return listLibrarySampleEnvironments(sample).map((environment) => ({
      value: environment.id,
      label: environment.label,
      hint:
        environment.description?.trim() ||
        environment.hint?.trim() ||
        "Imports the environment actions defined by this sample bundle.",
    }));
  }, [sample]);
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<string>(
    initialEnvironmentId && initialEnvironmentId.trim().length > 0 ? initialEnvironmentId.trim() : ""
  );

  useEffect(() => {
    if (variantOptions.some((option) => option.value === selectedUsdKey)) return;
    setSelectedUsdKey(variantOptions[0]?.value ?? usdKey ?? "");
  }, [selectedUsdKey, usdKey, variantOptions]);

  useEffect(() => {
    if (!sample || sample.kind !== "usd") {
      if (selectedEnvironmentId) setSelectedEnvironmentId("");
      return;
    }
    if (selectedEnvironmentId && environmentOptions.some((option) => option.value === selectedEnvironmentId)) return;
    setSelectedEnvironmentId(resolveDefaultSampleEnvironmentId(sample, selectedUsdKey) ?? "");
  }, [environmentOptions, sample, selectedEnvironmentId, selectedUsdKey]);

  const selectedEnvironmentEntry = useMemo(
    () => environmentOptions.find((item) => item.value === selectedEnvironmentId) ?? null,
    [environmentOptions, selectedEnvironmentId]
  );

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
        <div style={{ fontSize: 14, fontWeight: 600 }}>Import USD options</div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>Configure how this USD file is loaded into the editor.</div>
        <div
          style={{
            fontSize: 11,
            opacity: 0.66,
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 8,
            padding: "6px 8px",
            background: "rgba(255,255,255,0.04)",
          }}
          title={usdKey ?? undefined}
        >
          {selectedUsdKey || usdKey || "No USD file selected"}
        </div>
        {variantOptions.length > 1 && (
          <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
            <span>Robot variant</span>
            <DarkSelect
              value={selectedUsdKey}
              onChange={(event) => setSelectedUsdKey(String(event.target.value ?? "").trim())}
              style={{ background: "rgba(12,16,22,0.98)" }}
            >
              {variantOptions.map((variantOption) => (
                <option key={variantOption.value} value={variantOption.value}>
                  {variantOption.label}
                </option>
              ))}
            </DarkSelect>
          </label>
        )}
        {environmentOptions.length > 0 && (
          <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
            <span>Environment (optional)</span>
            <DarkSelect
              value={selectedEnvironmentId}
              onChange={(event) => setSelectedEnvironmentId(String(event.target.value ?? "").trim())}
              style={{ background: "rgba(12,16,22,0.98)" }}
            >
              <option value="">None (robot only)</option>
              {environmentOptions.map((environmentOption) => (
                <option key={environmentOption.value} value={environmentOption.value}>
                  {environmentOption.label}
                </option>
              ))}
            </DarkSelect>
            {selectedEnvironmentEntry ? (
              <div style={{ fontSize: 11, opacity: 0.7 }}>{selectedEnvironmentEntry.hint}</div>
            ) : (
              <div style={{ fontSize: 11, opacity: 0.7 }}>No extra environment assets will be imported.</div>
            )}
          </label>
        )}
        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, lineHeight: 1.35 }}>
          <input type="checkbox" checked={floatingBase} onChange={(e) => setFloatingBase(e.target.checked)} />
          Floating base (free root joint)
        </label>
        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, lineHeight: 1.35 }}>
          <input type="checkbox" checked={selfCollision} onChange={(e) => setSelfCollision(e.target.checked)} />
          Enable self-collisions (robot vs robot)
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
                options: { floatingBase, selfCollision },
                usdKey: selectedUsdKey || usdKey || "",
                environmentId: selectedEnvironmentId || null,
              })
            }
            disabled={!selectedUsdKey && !usdKey}
            style={{
              height: 28,
              padding: "0 12px",
              borderRadius: 8,
              border: "1px solid rgba(130,90,255,0.4)",
              background: "rgba(130,90,255,0.25)",
              color: "rgba(255,255,255,0.95)",
              cursor: selectedUsdKey || usdKey ? "pointer" : "default",
              opacity: selectedUsdKey || usdKey ? 1 : 0.5,
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            Import USD
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
  const requestUsdImport = useUsdImportDialogStore((s) => s.requestImport);
  const usdDialogOpen = useUsdImportDialogStore((s) => s.isOpen);
  const usdDialogKey = useUsdImportDialogStore((s) => s.usdKey);
  const usdDialogLibrarySampleId = useUsdImportDialogStore((s) => s.librarySampleId);
  const usdDialogOptionOverrides = useUsdImportDialogStore((s) => s.optionOverrides);
  const usdDialogBundleHintPaths = useUsdImportDialogStore((s) => s.bundleHintPaths);
  const usdDialogSelectedEnvironmentId = useUsdImportDialogStore((s) => s.selectedEnvironmentId);
  const closeUsdImportDialog = useUsdImportDialogStore((s) => s.close);
  const usdOptions = useAssetStore((s) => s.usdOptions);
  const setUSD = useAssetStore((s) => s.setUSD);
  const setUSDOptions = useAssetStore((s) => s.setUSDOptions);
  const libraryCaptureQueue = useBrowserPreviewStore((s) => s.libraryCaptureQueue);

  const viewer = useMemo(() => new Viewer(), []);
  const adapterRef = useRef<ThreeSceneAdapter | null>(null);
  const pointerInteractionRef = useRef<{ pointerId: number; depth: number } | null>(null);
  const debugOptionsRef = useRef<UrdfDebugOptions>(DEFAULT_URDF_DEBUG_OPTIONS);
  const libraryPreviewCaptureInFlightRef = useRef<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [dropHint, setDropHint] = useState("Drop to import");
  const [transformMode, setTransformMode] = useState<"translate" | "rotate" | "scale">("translate");
  const [snapActive, setSnapActive] = useState(false);
  const [simFps, setSimFps] = useState<number | null>(null);
  const [viewerInitError, setViewerInitError] = useState<string | null>(null);
  const fpsAccumRef = useRef({ elapsedSec: 0, frames: 0 });
  const fpsLastFrameRef = useRef<number | null>(null);
  const handleDebugChange = useCallback(
    (options: UrdfDebugOptions) => {
      debugOptionsRef.current = options;
      viewer.setUrdfDebugOptions(options);
    },
    [viewer]
  );

  useEffect(() => {
    void ensureLibraryCatalogLoaded().catch((error) => {
      logWarn("Viewport failed to load generated library index.", {
        scope: "assets",
        data: { error: String((error as Error)?.message ?? error) },
      });
    });
  }, []);

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
    async (payload: BrowserImportPayload) => {
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

      if (payload.kind === "sample") {
        await ensureLibraryCatalogLoaded().catch(() => null);
        const sample = getLibrarySampleById(payload.sampleId);
        if (!sample) return;

        const sampleKey = await ensureLibrarySampleImported(
          sample,
          () => useAssetStore.getState().assets,
          useAssetStore.getState().importFiles
        );
        if (!sampleKey) return;

        const assetStore = useAssetStore.getState();
        if (sample.kind === "urdf") {
          assetStore.setURDF(sampleKey);
          requestUrdfImport({
            urdfKey: sampleKey,
            source: "viewport-drop",
            optionOverrides: sample.defaultImportOptions?.urdf,
          });
          logInfo(`Viewport drop import request: Library sample ${sample.id} (URDF)`, {
            scope: "assets",
            data: { sampleId: sample.id, urdfKey: sampleKey },
          });
          return;
        }

        assetStore.setUSD(sampleKey);
        requestUsdImport({
          usdKey: sampleKey,
          source: "viewport-drop",
          librarySampleId: sample.id,
          optionOverrides: sample.defaultImportOptions?.usd,
          bundleHintPaths: sample.files,
          selectedEnvironmentId: resolveDefaultSampleEnvironmentId(sample, sampleKey),
        });
        logInfo(`Viewport drop import request: Library sample ${sample.id} (USD)`, {
          scope: "assets",
          data: { sampleId: sample.id, usdKey: sampleKey },
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

      if (payload.kind === "workspace-usd") {
        await ensureLibraryCatalogLoaded().catch(() => null);
        const assetStore = useAssetStore.getState();
        const entry = assetStore.assets[payload.path];
        if (!entry) return;
        assetStore.setUSD(payload.path);
        const sample = findLibrarySampleByWorkspaceKey(payload.path);
        requestUsdImport({
          usdKey: payload.path,
          source: "viewport-drop",
          librarySampleId: sample?.id ?? null,
          optionOverrides: sample?.defaultImportOptions?.usd,
          bundleHintPaths: sample?.files,
          selectedEnvironmentId: sample ? resolveDefaultSampleEnvironmentId(sample, payload.path) : null,
        });
        logInfo(`Viewport drop USD import request: ${payload.path}`, { scope: "assets", data: { usdKey: payload.path } });
      }
    },
    [requestUrdfImport, requestUsdImport]
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
      floatingBase: overrides.floatingBase ?? urdfOptions.floatingBase,
      firstLinkIsWorldReferenceFrame:
        overrides.firstLinkIsWorldReferenceFrame ?? urdfOptions.firstLinkIsWorldReferenceFrame,
      selfCollision: overrides.selfCollision ?? urdfOptions.selfCollision,
      collisionMode: toUiCollisionMode(overrides.collisionMode ?? urdfOptions.collisionMode),
    };
  }, [urdfDialogOptionOverrides, urdfOptions]);

  const usdDialogInitialOptions = useMemo<UsdDialogFormOptions>(() => {
    const overrides = usdDialogOptionOverrides ?? {};
    return {
      floatingBase: overrides.floatingBase ?? usdOptions.floatingBase ?? false,
      selfCollision: overrides.selfCollision ?? usdOptions.selfCollision ?? false,
    };
  }, [usdDialogOptionOverrides, usdOptions]);

  const usdDialogSample = useMemo(
    () => getLibrarySampleById(usdDialogLibrarySampleId ?? ""),
    [usdDialogLibrarySampleId]
  );

  const captureWorkspacePreviewIfNeeded = useCallback(
    async (workspaceKey: string) => {
      const normalizedKey = normalizeWorkspaceFilePath(workspaceKey);
      if (!normalizedKey) return;
      if (isLibraryWorkspaceKey(normalizedKey)) return;
      if (!isUrdfLikePath(normalizedKey) && !isUsdPath(normalizedKey)) return;

      const previewStore = useBrowserPreviewStore.getState();
      const current = previewStore.workspacePreviews[normalizedKey];
      if (current?.status === "loading") return;
      if (current?.status === "ready") {
        previewStore.touch(normalizedKey);
        return;
      }

      previewStore.markLoading(normalizedKey);
      try {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        const dataUrl = await viewer.captureThumbnail(BROWSER_PREVIEW_CAPTURE);
        if (!dataUrl) {
          useBrowserPreviewStore.getState().setFailed(normalizedKey);
          return;
        }
        const nextStore = useBrowserPreviewStore.getState();
        nextStore.setReady(normalizedKey, dataUrl);
        nextStore.evictOverflow(60);
      } catch {
        useBrowserPreviewStore.getState().setFailed(normalizedKey);
      }
    },
    [viewer]
  );

  const captureLibraryItemPreviewIfNeeded = useCallback(
    async (libraryItemId: string) => {
      const normalizedKey = normalizeWorkspaceFilePath(libraryItemId);
      if (!normalizedKey) return;

      const previewStore = useBrowserPreviewStore.getState();
      const current = previewStore.libraryItemPreviews[normalizedKey];
      if (current?.status === "ready") {
        previewStore.touchLibraryItem(normalizedKey);
        return;
      }
      if (current?.status !== "loading") {
        previewStore.markLibraryItemLoading(normalizedKey);
      }

      try {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        const dataUrl = await viewer.captureThumbnail(BROWSER_PREVIEW_CAPTURE);
        if (!dataUrl) {
          useBrowserPreviewStore.getState().setLibraryItemFailed(normalizedKey);
          return;
        }
        const nextStore = useBrowserPreviewStore.getState();
        nextStore.setLibraryItemReady(normalizedKey, dataUrl);
        nextStore.evictLibraryItemOverflow(60);
      } catch {
        useBrowserPreviewStore.getState().setLibraryItemFailed(normalizedKey);
      }
    },
    [viewer]
  );

  useEffect(() => {
    if (libraryCaptureQueue.length === 0) return;
    if (libraryPreviewCaptureInFlightRef.current) return;
    const nextKey = libraryCaptureQueue[0];
    if (!nextKey) return;

    libraryPreviewCaptureInFlightRef.current = nextKey;
    void (async () => {
      try {
        await captureLibraryItemPreviewIfNeeded(nextKey);
      } finally {
        const previewStore = useBrowserPreviewStore.getState();
        previewStore.dequeueLibraryItemCapture(nextKey);
        libraryPreviewCaptureInFlightRef.current = null;
      }
    })();
  }, [captureLibraryItemPreviewIfNeeded, libraryCaptureQueue]);

  const resolveLibraryAssetPackItemImportAction = useCallback(
    async (
      itemId: string,
      options?: {
        transform?: {
          position?: { x: number; y: number; z: number };
          rotationDeg?: { x: number; y: number; z: number };
          scale?: { x: number; y: number; z: number };
        };
      }
    ) => {
      const item = getLibraryAssetPackItemById(itemId);
      if (!item) {
        return {
          ok: false,
          action: null as ImportExecutionAction | null,
          sceneRole: null as "scene_asset" | "terrain" | null,
          diagnostics: [
            environmentDocumentManager.buildImportDiagnostic({
              code: "USD_ENV_ASSET_PACK_ITEM_MISSING",
              severity: "error",
              message: "Environment import references an unknown asset-pack item.",
              context: { itemId },
            }),
          ],
        };
      }

      const workspaceKey = await ensureLibraryAssetPackItemImported(
        item,
        () => useAssetStore.getState().assets,
        useAssetStore.getState().importFiles
      );
      if (!workspaceKey) {
        return {
          ok: false,
          action: null as ImportExecutionAction | null,
          sceneRole: item.sceneRole,
          diagnostics: [
            environmentDocumentManager.buildImportDiagnostic({
              code: "USD_ENV_ASSET_PACK_IMPORT_FAILED",
              severity: "error",
              message: "Environment asset-pack item could not be hydrated into workspace assets.",
              context: { itemId: item.id },
            }),
          ],
        };
      }

      const action: ImportExecutionAction = {
        kind: "usd_bundle",
        usdKey: workspaceKey,
        bundleHintPaths: resolveScopedBundleHintPaths(workspaceKey, item.files),
        sceneRole: item.sceneRole,
        rootName: item.rootName ?? item.label,
        frameOnAdd: false,
        transform: options?.transform,
      };
      return {
        ok: true,
        action,
        sceneRole: item.sceneRole,
        diagnostics: [] as ReturnType<typeof useTrainingImportContextStore.getState>["diagnostics"],
      };
    },
    []
  );

  const resolveLibraryAssetPackPresetImportActions = useCallback(
    async (presetId: string) => {
      const preset = getLibraryAssetPackPresetById(presetId);
      if (!preset) {
        return {
          ok: false,
          terrainWorkspaceKey: null as string | null,
          terrainMode: "none" as const,
          diagnostics: [
            environmentDocumentManager.buildImportDiagnostic({
              code: "USD_ENV_ASSET_PACK_PRESET_MISSING",
              severity: "error",
              message: "Environment import references an unknown asset-pack preset.",
              context: { presetId },
            }),
          ],
        };
      }

      const diagnostics: ReturnType<typeof useTrainingImportContextStore.getState>["diagnostics"] = [];
      let importedAtLeastOne = false;
      let terrainWorkspaceKey: string | null = null;
      let terrainMode: "none" | "usd" = "none";
      const actions: ImportExecutionAction[] = [];
      for (const placement of preset.placements) {
        const result = await resolveLibraryAssetPackItemImportAction(placement.itemId, {
          transform: placement.transform,
        });
        diagnostics.push(...result.diagnostics);
        importedAtLeastOne = importedAtLeastOne || result.ok;
        if (result.ok && result.action) {
          actions.push(result.action);
        }
        if (result.sceneRole === "terrain" && result.action?.kind === "usd_bundle") {
          terrainWorkspaceKey = result.action.usdKey;
          terrainMode = "usd";
        }
      }
      return {
        ok: importedAtLeastOne,
        actions,
        terrainWorkspaceKey,
        terrainMode,
        diagnostics,
      };
    },
    [resolveLibraryAssetPackItemImportAction]
  );

  const confirmLoadUSD = useCallback(async (input: {
    options: UsdDialogFormOptions;
    usdKey: string;
    environmentId: string | null;
  }) => {
    await ensureLibraryCatalogLoaded().catch(() => null);
    const selectedUsdKey = String(input.usdKey ?? "").trim();
    if (!selectedUsdKey) return;
    const sample = usdDialogSample ?? findLibrarySampleByWorkspaceKey(selectedUsdKey);
    const selectedEnvironment = sample ? getLibrarySampleEnvironmentById(sample, input.environmentId) : null;
    const defaultEnvironmentId = sample ? resolveDefaultSampleEnvironmentId(sample, selectedUsdKey) : null;
    const selectedEnvironmentId = selectedEnvironment?.id ?? null;
    const environmentOverrideActive =
      sample !== null &&
      sample.kind === "usd" &&
      normalizeWorkspaceFilePath(defaultEnvironmentId ?? "") !== normalizeWorkspaceFilePath(selectedEnvironmentId ?? "");
    const resolvedImportOptions: UsdImportOptions = {
      ...(usdDialogOptionOverrides ?? {}),
      ...input.options,
    };
    const selectedVariant = sample && sample.kind === "usd"
      ? getLibrarySampleVariantByWorkspaceKey(sample, selectedUsdKey)
      : null;
    const variantImportHints = selectedVariant?.importHints ?? null;
    const referenceUsdKey = (() => {
      if (!sample || sample.kind !== "usd") return null;
      const referenceVariantId = String(variantImportHints?.referenceVariantId ?? "").trim();
      if (!referenceVariantId) return null;
      const referenceVariant =
        listLibrarySampleUsdVariants(sample, { includeHidden: true }).find((variant) => variant.id === referenceVariantId) ??
        null;
      if (!referenceVariant) return null;
      return resolveLibraryWorkspaceKey(sample, referenceVariant.entry);
    })();
    const variantExtraBundleWorkspaceKeys = sample && sample.kind === "usd"
      ? (variantImportHints?.extraBundleHintPaths ?? [])
          .map((item) => String(item ?? "").trim())
          .filter((item) => item.length > 0)
          .map((item) =>
            normalizeWorkspaceFilePath(item).startsWith(`${LIBRARY_ROOT}/`)
              ? normalizeWorkspaceFilePath(item)
              : resolveLibraryWorkspaceKey(sample, item)
          )
      : [];
    const variantHintWorkspaceKeys = Array.from(
      new Set([
        ...variantExtraBundleWorkspaceKeys,
        ...(referenceUsdKey ? [referenceUsdKey] : []),
      ])
    );
    if (variantHintWorkspaceKeys.length > 0) {
      const ready = await ensureLibraryWorkspaceKeysImported(
        variantHintWorkspaceKeys,
        () => useAssetStore.getState().assets,
        useAssetStore.getState().importFiles
      );
      if (!ready) {
        useTrainingImportContextStore.getState().setDiagnostics([
          environmentDocumentManager.buildImportDiagnostic({
            code: "USD_VARIANT_HINT_IMPORT_MISSING_ASSETS",
            severity: "error",
            message: "Variant import hints reference assets that could not be loaded into workspace assets.",
            context: {
              usdKey: selectedUsdKey,
              variantId: selectedVariant?.id ?? null,
              missingVariantHintAssets: variantHintWorkspaceKeys,
            },
          }),
        ]);
        return;
      }
    }
    const robotBundleHintPaths = resolveScopedBundleHintPaths(
      selectedUsdKey,
      [
        ...(usdDialogBundleHintPaths ?? []),
        ...variantExtraBundleWorkspaceKeys,
        ...(referenceUsdKey ? [referenceUsdKey] : []),
      ]
    );
    const robotVariantImportHints =
      variantImportHints || referenceUsdKey
        ? {
            ...(referenceUsdKey ? { referenceUsdKey } : {}),
            ...(variantImportHints?.posePolicy ? { posePolicy: variantImportHints.posePolicy } : {}),
          }
        : undefined;
    const shouldReplaceFullScene = selectedEnvironment !== null || environmentOverrideActive;
    const sceneRootsBeforeReplace = shouldReplaceFullScene ? collectAllSceneRootsForReplacement(viewer) : [];
    if (shouldReplaceFullScene && sceneRootsBeforeReplace.length > 0) {
      const approved = window.confirm(
        "This environment import will replace the full current scene. Continue and overwrite all assets?"
      );
      if (!approved) return;
    }
    const robotTransform =
      selectedEnvironment !== null
        ? resolvePrimaryRobotImportTransformFromTrainingArtifacts({
            snapshot: useTrainingImportContextStore.getState().environmentSnapshot,
            robotUsdKey: selectedUsdKey,
            compiledTrainingEnvironment: useTrainingImportContextStore.getState().compiledTrainingEnvironment,
          }) ??
          resolvePrimaryRobotImportTransformFromProjectDoc({
            projectDoc: editorEngine.getDoc(),
            robotUsdKey: selectedUsdKey,
          })
        : undefined;
    setUSD(selectedUsdKey);
    setUSDOptions(resolvedImportOptions);
    closeUsdImportDialog();
    const diagnostics: ReturnType<typeof useTrainingImportContextStore.getState>["diagnostics"] = [];
    const executionActions: ImportExecutionAction[] = [];
    if (selectedEnvironment && sample) {
      for (const action of selectedEnvironment.imports) {
        if (action.kind === "generated_scene_asset") {
          executionActions.push({
            kind: "generated_scene_asset",
            sceneAssetId: action.sceneAssetId,
          });
          continue;
        }

        if (action.kind === "usd_bundle") {
          const environmentWorkspaceKey = resolveLibraryWorkspaceKey(sample, action.entry);
          const bundleWorkspaceKeys = Array.from(
            new Set(
              [environmentWorkspaceKey, ...(action.files ?? []).map((file) => resolveLibraryWorkspaceKey(sample, file))]
                .map((file) => normalizeWorkspaceFilePath(file))
                .filter((file) => file.length > 0)
            )
          );
          const ready = await ensureLibraryWorkspaceKeysImported(
            bundleWorkspaceKeys,
            () => useAssetStore.getState().assets,
            useAssetStore.getState().importFiles
          );
          if (!ready) {
            diagnostics.push(
              environmentDocumentManager.buildImportDiagnostic({
                code: "USD_ENV_BUNDLE_IMPORT_MISSING_ASSETS",
                severity: "error",
                message: "Environment bundle files could not be loaded into workspace assets.",
                context: {
                  environmentId: selectedEnvironment.id,
                  entry: environmentWorkspaceKey,
                },
              })
            );
            continue;
          }
          executionActions.push({
            kind: "usd_bundle",
            usdKey: environmentWorkspaceKey,
            bundleHintPaths: resolveScopedBundleHintPaths(environmentWorkspaceKey, bundleWorkspaceKeys),
            sceneRole:
              action.sceneRole === "terrain" || isTerrainLikeWorkspaceUsdKey(environmentWorkspaceKey)
                ? "terrain"
                : "scene_asset",
            rootName: action.rootName,
            frameOnAdd: false,
          });
          continue;
        }

        if (action.kind === "asset_pack_item") {
          const itemResult = await resolveLibraryAssetPackItemImportAction(action.itemId, {
            transform: action.transform,
          });
          diagnostics.push(...itemResult.diagnostics);
          if (itemResult.ok && itemResult.action) {
            executionActions.push(itemResult.action);
          }
          continue;
        }

        if (action.kind === "asset_pack_preset") {
          const presetResult = await resolveLibraryAssetPackPresetImportActions(action.presetId);
          diagnostics.push(...presetResult.diagnostics);
          if (presetResult.ok) {
            executionActions.push(...(presetResult.actions ?? []));
          }
        }
      }
    }

    const latestAssets = useAssetStore.getState().assets;
    const executionResult = await importManager.executeUsdImportPlan({
      assets: latestAssets,
      robotUsdKey: selectedUsdKey,
      robotBundleHintPaths,
      robotVariantImportHints,
      options: resolvedImportOptions satisfies UsdImportOptions,
      robotTransform,
      environmentId: selectedEnvironment?.id ?? null,
      environmentOverrideActive,
      replaceFullScene: shouldReplaceFullScene,
      actions: executionActions,
      validateSceneAssetCollisions: selectedEnvironment !== null,
    });
    diagnostics.push(...executionResult.diagnostics);
    if (!executionResult.ok) {
      logWarn("Viewport USD import rejected by import manager execution plan", {
        scope: "assets",
        data: {
          usdKey: selectedUsdKey,
          environmentId: selectedEnvironment?.id ?? null,
          diagnostics: executionResult.diagnostics,
          runtimeBuildReport: executionResult.runtimeBuildReport,
        },
      });
      useTrainingImportContextStore.getState().setImportContext({
        robotUsdKey: selectedUsdKey,
        terrainUsdKey: null,
        terrainMode: "none",
        diagnostics,
      });
      return;
    }

    useTrainingImportContextStore.getState().setImportContext({
      robotUsdKey: selectedUsdKey,
      terrainUsdKey: executionResult.terrainUsdKey,
      terrainMode: executionResult.terrainMode,
      environmentSnapshot: executionResult.environment,
      compiledTrainingEnvironment: null,
      diagnostics,
    });
    logInfo("Viewport USD import confirmed", {
      scope: "assets",
      data: {
        usdKey: selectedUsdKey,
        environmentId: selectedEnvironment?.id ?? null,
        environmentOverrideActive,
        terrainUsdKey: executionResult.terrainUsdKey,
        terrainMode: executionResult.terrainMode,
        replaceFullScene: shouldReplaceFullScene,
        diagnosticsCount: diagnostics.length,
        variantId: selectedVariant?.id ?? null,
        variantImportHints: robotVariantImportHints ?? null,
        replacedRoots: executionResult.replacedRoots,
        runtimeBuildReport: executionResult.runtimeBuildReport,
        options: resolvedImportOptions,
      },
    });
    await captureWorkspacePreviewIfNeeded(selectedUsdKey);
  }, [
    captureWorkspacePreviewIfNeeded,
    closeUsdImportDialog,
    resolveLibraryAssetPackItemImportAction,
    resolveLibraryAssetPackPresetImportActions,
    setUSD,
    setUSDOptions,
    usdDialogBundleHintPaths,
    usdDialogOptionOverrides,
    usdDialogSample,
    viewer,
  ]);

  const confirmLoadURDF = useCallback(async (selectedOptions: UrdfDialogFormOptions) => {
    if (!urdfDialogKey) return;

    setURDF(urdfDialogKey);
    setURDFOptions(selectedOptions);
    closeUrdfImportDialog();
    const assetStore = useAssetStore.getState();
    const result = await importManager.import_urdf({
      urdfKey: urdfDialogKey,
      assets: assetStore.assets,
      importOptions: selectedOptions,
    });
    if (result.ok) {
      useTrainingImportContextStore.getState().setImportContext({
        robotUsdKey: null,
        terrainUsdKey: null,
        terrainMode: "none",
        environmentSnapshot: result.environment,
        compiledTrainingEnvironment: null,
        diagnostics: result.diagnostics,
      });
    } else {
      useTrainingImportContextStore.getState().setDiagnostics(result.diagnostics);
    }
    logInfo("Viewport URDF import confirmed", {
      scope: "assets",
      data: { urdfKey: urdfDialogKey, options: selectedOptions, diagnostics: result.diagnostics },
    });
    await captureWorkspacePreviewIfNeeded(urdfDialogKey);
  }, [captureWorkspacePreviewIfNeeded, closeUrdfImportDialog, setURDF, setURDFOptions, urdfDialogKey]);

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

      const showRuntimeColliders = debugOptionsRef.current.showCollisions;
      const runtimeColliders = showRuntimeColliders ? useMujocoStore.getState().getRuntimeColliderSnapshots() : null;
      viewer.setRuntimeCollisionSnapshots(showRuntimeColliders ? runtimeColliders : null);

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
      viewer.setRuntimeCollisionSnapshots(null);
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
    viewer.setRuntimeCollisionSnapshots(null);
  }, [simState, viewer]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    setViewerInitError(null);
    let unsubscribeDoc: (() => void) | null = null;
    let ro: ResizeObserver | null = null;

    try {
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
      unsubscribeDoc = editorEngine.on("doc:changed", (event) => {
        adapterRef.current?.applyDoc(event.doc, { reason: event.reason });
      });

      ro = new ResizeObserver(() => {
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
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error ?? "unknown");
      const webglBlocked = reason.toLowerCase().includes("webgl");
      setViewerInitError(
        webglBlocked
          ? "WebGL no esta disponible en esta sesion del navegador. Activa aceleracion por hardware o prueba otro navegador."
          : `No se pudo iniciar el visor: ${reason}`
      );
      logWarn("Viewport init failed", {
        scope: "viewer",
        data: { reason },
      });
      adapterRef.current = null;
      setThreeAdapter(null);
      pointerInteractionRef.current = null;
      useMujocoStore.getState().endPointerInteraction();
      viewer.dispose();
      setViewer(null);
      setTransformDragging(false);
      return;
    }

    return () => {
      ro?.disconnect();
      unsubscribeDoc?.();
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
        {viewerInitError && (
          <div
            style={{
              position: "absolute",
              inset: 12,
              borderRadius: 10,
              border: "1px solid rgba(255,150,140,0.48)",
              background: "rgba(34,8,8,0.84)",
              color: "rgba(255,238,234,0.94)",
              padding: 12,
              display: "grid",
              gap: 8,
              alignContent: "start",
              zIndex: 35,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 700 }}>Viewer unavailable</div>
            <div style={{ fontSize: 12, lineHeight: 1.4 }}>{viewerInitError}</div>
          </div>
        )}
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
            key={`${urdfDialogKey ?? "dialog"}-${urdfDialogInitialOptions.floatingBase ? 1 : 0}-${urdfDialogInitialOptions.firstLinkIsWorldReferenceFrame ? 1 : 0}-${urdfDialogInitialOptions.selfCollision ? 1 : 0}-${urdfDialogInitialOptions.collisionMode}`}
            urdfKey={urdfDialogKey}
            initialOptions={urdfDialogInitialOptions}
            onCancel={closeUrdfImportDialog}
            onConfirm={(options) => {
              void confirmLoadURDF(options);
            }}
          />
        )}
        {usdDialogOpen && (
          <UsdImportDialogOverlay
            key={`${usdDialogKey ?? "usd-dialog"}-${usdDialogLibrarySampleId ?? "standalone"}-${usdDialogInitialOptions.floatingBase ? 1 : 0}-${usdDialogInitialOptions.selfCollision ? 1 : 0}`}
            usdKey={usdDialogKey}
            sample={usdDialogSample}
            initialEnvironmentId={usdDialogSelectedEnvironmentId}
            initialOptions={usdDialogInitialOptions}
            onCancel={closeUsdImportDialog}
            onConfirm={(input) => {
              void confirmLoadUSD(input);
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
