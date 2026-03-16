import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { Viewer } from "../../app/core/viewer/Viewer";
import { addSceneAsset } from "../../app/core/editor/actions/sceneAssetActions";
import { useAppStore } from "../../app/core/store/useAppStore";
import { useAssetStore } from "../../app/core/store/useAssetStore";
import { useSceneStore } from "../../app/core/store/useSceneStore";
import { useMujocoStore } from "../../app/core/store/useMujocoStore";
import { useLoaderStore } from "../../app/core/store/useLoaderStore";
import { useUrdfImportDialogStore } from "../../app/core/store/useUrdfImportDialogStore";
import { useUsdImportDialogStore } from "../../app/core/store/useUsdImportDialogStore";
import { useTrainingImportContextStore } from "../../app/core/store/useTrainingImportContextStore";
import { useBrowserPreviewStore } from "../../app/core/store/useBrowserPreviewStore";
import type { UsdImportOptions } from "../../app/core/usd/usdImportOptions";
import { logInfo, logWarn } from "../../app/core/services/logger";
import type { SceneAssetId } from "../../app/core/scene/sceneAssets";
import { isDefaultFloorWorkspaceKey } from "../../app/core/assets/floorAppearance";
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
  ensureLibrarySampleImported,
  findLibrarySampleByWorkspaceKey,
  getLibrarySampleById,
  listLibrarySampleEnvironmentWorkspaceKeys,
  listLibrarySampleUsdWorkspaceKeys,
  resolveDefaultSampleEnvironmentWorkspaceKey,
} from "../asset-library/librarySamples";
import { importManager } from "../../app/core/environment/ImportManager";
import { environmentDocumentManager } from "../../app/core/environment/EnvironmentDocumentManager";

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

function isTerrainLikeWorkspaceUsdKey(key: string): boolean {
  const normalized = normalizeWorkspaceFilePath(key).toLowerCase();
  if (!normalized) return false;
  if (/^library\/[^/]+\/terrain\/.+\.(usd|usda|usdc|usdz)$/i.test(normalized)) return true;
  return (
    normalized.includes("/terrain/") ||
    normalized.includes("/environment/") ||
    normalized.includes("flat_floor") ||
    normalized.includes("rough_preview") ||
    normalized.includes("table_scene")
  );
}

function collectTerrainRootsForReplacement(viewer: Viewer) {
  const roots = viewer.getUserRoots();
  const toRemove: Array<{ rootId: string; name: string; workspaceUsdKey: string; reason: string }> = [];
  for (const root of roots) {
    const userData =
      root?.userData && typeof root.userData === "object" && !Array.isArray(root.userData)
        ? (root.userData as Record<string, unknown>)
        : {};
    if (userData.editorRobotRoot === true) continue;
    const rootId = String(userData.docId ?? "").trim();
    if (!rootId) continue;

    const loweredName = String(root.name ?? "")
      .trim()
      .toLowerCase();
    const workspaceUsdKey = normalizeWorkspaceFilePath(String(userData.usdWorkspaceKey ?? "").trim());
    const flaggedTerrainPreview = userData.usdTerrainPreview === true;
    const sceneAssetTerrain = userData.usdSceneAsset === true && isTerrainLikeWorkspaceUsdKey(workspaceUsdKey);
    const legacyFloor = loweredName === "floor" || loweredName === "rough floor";
    if (!flaggedTerrainPreview && !sceneAssetTerrain && !legacyFloor) continue;

    toRemove.push({
      rootId,
      name: String(root.name ?? "").trim() || rootId,
      workspaceUsdKey,
      reason: flaggedTerrainPreview ? "usdTerrainPreview" : sceneAssetTerrain ? "usdSceneTerrain" : "legacyFloor",
    });
  }
  return toRemove;
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
    .filter((item) => item.length > 0);
  if (hints.length === 0) return undefined;
  const normalizedUsdKey = normalizeWorkspaceFilePath(usdKey);
  const usdDir = (() => {
    const idx = normalizedUsdKey.lastIndexOf("/");
    return idx >= 0 ? normalizedUsdKey.slice(0, idx) : "";
  })();
  const usdIsLibraryKey = normalizedUsdKey.startsWith(`${LIBRARY_ROOT}/`);

  const sample = findLibrarySampleByWorkspaceKey(usdKey);
  if (!sample || sample.kind !== "usd") {
    const scoped = hints.filter((item) => {
      const normalizedHint = normalizeWorkspaceFilePath(item);
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

  const samplePrefix = normalizeWorkspaceFilePath(`${LIBRARY_ROOT}/${sample.id}/`);
  if (!normalizedUsdKey.startsWith(samplePrefix)) return hints;
  const relativeEntry = normalizedUsdKey.slice(samplePrefix.length);
  const entryDir = relativeEntry.includes("/") ? relativeEntry.slice(0, relativeEntry.lastIndexOf("/") + 1) : "";
  if (!entryDir) return hints;
  const scoped = hints.filter((item) => {
    const normalizedHint = normalizeWorkspaceFilePath(item);
    if (!normalizedHint) return false;
    if (normalizedHint.startsWith(`${LIBRARY_ROOT}/`)) {
      if (normalizedHint === normalizedUsdKey) return true;
      if (usdDir && normalizedHint.startsWith(`${usdDir}/`)) return true;
      return false;
    }
    return normalizedHint.startsWith(entryDir) || normalizedHint.startsWith("terrain/") || normalizedHint.startsWith("environment/");
  });
  return scoped.length > 0 ? scoped : hints;
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

type UsdDialogTerrainMode = "none" | "usd" | "plane" | "generator";

type TerrainDialogOption = {
  value: string;
  mode: UsdDialogTerrainMode;
  usdKey: string | null;
  sceneAssetId: SceneAssetId | null;
  replaceFullScene: boolean;
  label: string;
  hint: string;
};

const TERRAIN_OPTION_NONE = "__terrain_none__";
const TERRAIN_OPTION_FLAT = "__terrain_flat__";
const TERRAIN_OPTION_ROUGH = "__terrain_rough__";

type TerrainOptionPolicy = {
  allowFlat: boolean;
  allowRough: boolean;
  allowFullScene: boolean;
};

function resolveTerrainOptionPolicy(selectedUsdKey: string): TerrainOptionPolicy {
  const sample = findLibrarySampleByWorkspaceKey(selectedUsdKey);
  const configured = Array.isArray(sample?.terrainOptions) ? new Set(sample.terrainOptions) : null;
  if (!configured) {
    return {
      allowFlat: false,
      allowRough: false,
      allowFullScene: false,
    };
  }
  return {
    allowFlat: configured.has("flat"),
    allowRough: configured.has("rough"),
    allowFullScene: configured.has("full_scene"),
  };
}

function buildTerrainDialogOptions(selectedUsdKey: string, terrainUsdKeys: string[]): TerrainDialogOption[] {
  const policy = resolveTerrainOptionPolicy(selectedUsdKey);

  const options: TerrainDialogOption[] = [
    {
      value: TERRAIN_OPTION_NONE,
      mode: "none",
      usdKey: null,
      sceneAssetId: null,
      replaceFullScene: false,
      label: "None (robot only)",
      hint: "No extra terrain/scene will be imported for training.",
    },
  ];

  const terrainUsdOptions = Array.from(
    new Set(
      [selectedUsdKey, ...(terrainUsdKeys ?? [])]
        .map((key) => String(key ?? "").trim())
        .filter((key) => key.length > 0)
    )
  );
  if (policy.allowFullScene && terrainUsdOptions.length > 0) {
    for (const terrainUsdKey of terrainUsdOptions) {
      const isSelectedVariant = terrainUsdKey === selectedUsdKey;
      options.push({
        value: terrainUsdKey,
        mode: "usd",
        usdKey: terrainUsdKey,
        sceneAssetId: null,
        replaceFullScene: true,
        label: isSelectedVariant ? "Full environment bundle (selected)" : "Full environment bundle",
        hint: "Replaces the entire scene and imports the environment USD bundle.",
      });
    }
  }

  if (policy.allowFlat) {
    const flatFloorUsdKey = terrainUsdOptions.find((key) => isDefaultFloorWorkspaceKey(key)) ?? null;
    if (flatFloorUsdKey) {
      options.push({
        value: TERRAIN_OPTION_FLAT,
        mode: "usd",
        usdKey: flatFloorUsdKey,
        sceneAssetId: null,
        replaceFullScene: false,
        label: "Flat floor (library)",
        hint: "Imports the managed Default Floor USD bundle and keeps it as terrain source-of-truth.",
      });
    } else {
      options.push({
        value: TERRAIN_OPTION_FLAT,
        mode: "plane",
        usdKey: null,
        sceneAssetId: "floor",
        replaceFullScene: false,
        label: "Flat floor (library)",
        hint: "Uses your Floor asset in viewport and built-in plane terrain mode for training.",
      });
    }
  }

  if (policy.allowRough) {
    options.push({
      value: TERRAIN_OPTION_ROUGH,
      mode: "plane",
      usdKey: null,
      sceneAssetId: "floor:rough",
      replaceFullScene: false,
      label: "Rough floor (library)",
      hint: "Uses your Rough Floor asset in viewport and built-in plane terrain mode for training.",
    });
  }
  return options;
}

function UsdImportDialogOverlay(props: {
  usdKey: string | null;
  variantUsdKeys: string[];
  terrainUsdKeys: string[];
  initialTerrainUsdKey: string | null;
  initialOptions: UsdDialogFormOptions;
  onCancel: () => void;
  onConfirm: (input: {
    options: UsdDialogFormOptions;
    usdKey: string;
    terrainUsdKey: string | null;
    terrainMode: UsdDialogTerrainMode;
    terrainAssetId: SceneAssetId | null;
    replaceFullScene: boolean;
  }) => void;
}) {
  const { usdKey, variantUsdKeys, terrainUsdKeys, initialTerrainUsdKey, initialOptions, onCancel, onConfirm } = props;
  const [floatingBase, setFloatingBase] = useState(initialOptions.floatingBase);
  const [selfCollision, setSelfCollision] = useState(initialOptions.selfCollision);
  const variantOptions = useMemo(() => {
    const cleaned = variantUsdKeys
      .map((item) => String(item ?? "").trim())
      .filter((item) => item.length > 0);
    if (cleaned.length > 0) return Array.from(new Set(cleaned));
    if (usdKey) return [usdKey];
    return [];
  }, [usdKey, variantUsdKeys]);
  const [selectedUsdKey, setSelectedUsdKey] = useState<string>(variantOptions[0] ?? usdKey ?? "");
  const terrainOptions = useMemo(() => buildTerrainDialogOptions(selectedUsdKey, terrainUsdKeys), [selectedUsdKey, terrainUsdKeys]);
  const [selectedTerrainOption, setSelectedTerrainOption] = useState<string>(
    initialTerrainUsdKey && initialTerrainUsdKey.trim().length > 0 ? initialTerrainUsdKey.trim() : TERRAIN_OPTION_NONE
  );

  useEffect(() => {
    if (terrainOptions.some((item) => item.value === selectedTerrainOption)) return;
    setSelectedTerrainOption(TERRAIN_OPTION_NONE);
  }, [selectedTerrainOption, terrainOptions]);

  const selectedTerrainEntry = useMemo(
    () => terrainOptions.find((item) => item.value === selectedTerrainOption) ?? terrainOptions[0] ?? null,
    [selectedTerrainOption, terrainOptions]
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
              {variantOptions.map((variantKey) => (
                <option key={variantKey} value={variantKey}>
                  {variantKey.split("/").pop() ?? variantKey}
                </option>
              ))}
            </DarkSelect>
          </label>
        )}
        {terrainOptions.length > 0 && (
          <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
            <span>Environment (optional)</span>
            <DarkSelect
              value={selectedTerrainOption}
              onChange={(event) => setSelectedTerrainOption(String(event.target.value ?? "").trim())}
              style={{ background: "rgba(12,16,22,0.98)" }}
            >
              {terrainOptions.map((terrainOption) => (
                <option key={terrainOption.value} value={terrainOption.value}>
                  {terrainOption.label}
                </option>
              ))}
            </DarkSelect>
            {selectedTerrainEntry ? (
              <div style={{ fontSize: 11, opacity: 0.7 }}>{selectedTerrainEntry.hint}</div>
            ) : null}
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
              {
                const resolvedTerrain = selectedTerrainEntry ?? terrainOptions[0] ?? null;
                onConfirm({
                  options: { floatingBase, selfCollision },
                  usdKey: selectedUsdKey || usdKey || "",
                  terrainUsdKey: resolvedTerrain?.usdKey ?? null,
                  terrainMode: resolvedTerrain?.mode ?? "none",
                  terrainAssetId: resolvedTerrain?.sceneAssetId ?? null,
                  replaceFullScene: resolvedTerrain?.replaceFullScene === true,
                });
              }
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
  const usdDialogOptionOverrides = useUsdImportDialogStore((s) => s.optionOverrides);
  const usdDialogBundleHintPaths = useUsdImportDialogStore((s) => s.bundleHintPaths);
  const usdDialogVariantUsdKeys = useUsdImportDialogStore((s) => s.variantUsdKeys);
  const usdDialogTerrainUsdKeys = useUsdImportDialogStore((s) => s.terrainUsdKeys);
  const usdDialogSelectedTerrainUsdKey = useUsdImportDialogStore((s) => s.selectedTerrainUsdKey);
  const closeUsdImportDialog = useUsdImportDialogStore((s) => s.close);
  const usdOptions = useAssetStore((s) => s.usdOptions);
  const setUSD = useAssetStore((s) => s.setUSD);
  const setUSDOptions = useAssetStore((s) => s.setUSDOptions);

  const viewer = useMemo(() => new Viewer(), []);
  const adapterRef = useRef<ThreeSceneAdapter | null>(null);
  const pointerInteractionRef = useRef<{ pointerId: number; depth: number } | null>(null);
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
        const variantUsdKeys = listLibrarySampleUsdWorkspaceKeys(sample).filter((key) => Boolean(assetStore.assets[key]));
        const terrainUsdKeys = listLibrarySampleEnvironmentWorkspaceKeys(sample).filter((key) => Boolean(assetStore.assets[key]));
        requestUsdImport({
          usdKey: sampleKey,
          source: "viewport-drop",
          optionOverrides: sample.defaultImportOptions?.usd,
          bundleHintPaths: sample.files,
          variantUsdKeys,
          terrainUsdKeys,
          selectedTerrainUsdKey: resolveDefaultSampleEnvironmentWorkspaceKey(sample, sampleKey),
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
        const assetStore = useAssetStore.getState();
        const entry = assetStore.assets[payload.path];
        if (!entry) return;
        assetStore.setUSD(payload.path);
        const sample = findLibrarySampleByWorkspaceKey(payload.path);
        const sampleVariantKeys = sample
          ? listLibrarySampleUsdWorkspaceKeys(sample).filter((key) => Boolean(assetStore.assets[key]))
          : [];
        const variantUsdKeys = sampleVariantKeys.length > 0 ? sampleVariantKeys : [normalizeWorkspaceFilePath(payload.path)];
        const terrainUsdKeys = sample
          ? listLibrarySampleEnvironmentWorkspaceKeys(sample).filter((key) => Boolean(assetStore.assets[key]))
          : [];
        requestUsdImport({
          usdKey: payload.path,
          source: "viewport-drop",
          optionOverrides: sample?.defaultImportOptions?.usd,
          bundleHintPaths: sample?.files,
          variantUsdKeys,
          terrainUsdKeys,
          selectedTerrainUsdKey: sample ? resolveDefaultSampleEnvironmentWorkspaceKey(sample, payload.path) : terrainUsdKeys[0] ?? null,
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

  const usdDialogVariantOptions = useMemo(() => {
    const cleaned = (usdDialogVariantUsdKeys ?? [])
      .map((item) => String(item ?? "").trim())
      .filter((item) => item.length > 0);
    if (cleaned.length > 0) {
      if (usdDialogKey && !cleaned.includes(usdDialogKey)) cleaned.unshift(usdDialogKey);
      return Array.from(new Set(cleaned));
    }
    return usdDialogKey ? [usdDialogKey] : [];
  }, [usdDialogKey, usdDialogVariantUsdKeys]);

  const usdDialogTerrainOptions = useMemo(() => {
    const cleaned = (usdDialogTerrainUsdKeys ?? [])
      .map((item) => String(item ?? "").trim())
      .filter((item) => item.length > 0);
    return Array.from(new Set(cleaned));
  }, [usdDialogTerrainUsdKeys]);

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
        const dataUrl = await viewer.captureThumbnail({
          maxWidth: 640,
          maxHeight: 360,
          mimeType: "image/webp",
          quality: 0.78,
        });
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

  const confirmLoadUSD = useCallback(async (input: {
    options: UsdDialogFormOptions;
    usdKey: string;
    terrainUsdKey: string | null;
    terrainMode: UsdDialogTerrainMode;
    terrainAssetId: SceneAssetId | null;
    replaceFullScene: boolean;
  }) => {
    const selectedUsdKey = String(input.usdKey ?? "").trim();
    if (!selectedUsdKey) return;
    const terrainMode = input.terrainMode ?? "none";
    const requestedTerrainUsdKey = String(input.terrainUsdKey ?? "").trim() || null;
    const shouldReplaceFullScene =
      input.replaceFullScene === true && terrainMode === "usd" && Boolean(requestedTerrainUsdKey);
    if (shouldReplaceFullScene) {
      const approved = window.confirm(
        "This environment bundle will replace the full current scene. Continue and overwrite all assets?"
      );
      if (!approved) return;
    }
    setUSD(selectedUsdKey);
    setUSDOptions(input.options);
    closeUsdImportDialog();
    const assetStore = useAssetStore.getState();
    if (shouldReplaceFullScene) {
      const sceneRootsBeforeReplace = collectAllSceneRootsForReplacement(viewer);
      useLoaderStore.getState().clear();
      logInfo("Viewport full-scene overwrite cleared all roots before USD environment import", {
        scope: "assets",
        data: {
          robotUsdKey: selectedUsdKey,
          requestedTerrainUsdKey,
          removedRoots: sceneRootsBeforeReplace,
        },
      });
    } else if (terrainMode !== "none") {
      const removedTerrainRoots = collectTerrainRootsForReplacement(viewer);
      for (const root of removedTerrainRoots) {
        useLoaderStore.getState().remove(root.rootId);
      }
      if (removedTerrainRoots.length > 0) {
        logInfo("Viewport terrain roots cleared before USD import", {
          scope: "assets",
          data: {
            robotUsdKey: selectedUsdKey,
            terrainMode,
            removedRoots: removedTerrainRoots,
          },
        });
      }
    }
    const diagnostics: ReturnType<typeof useTrainingImportContextStore.getState>["diagnostics"] = [];
    const robotLoadResult = await importManager.import_usd({
      usdKey: selectedUsdKey,
      assets: assetStore.assets,
      importOptions: input.options satisfies UsdImportOptions,
      bundleHintPaths: resolveScopedBundleHintPaths(selectedUsdKey, usdDialogBundleHintPaths),
    });
    diagnostics.push(...robotLoadResult.diagnostics);
    if (!robotLoadResult.ok) {
      logWarn("Viewport USD import rejected by import manager diagnostics", {
        scope: "assets",
        data: {
          usdKey: selectedUsdKey,
          diagnostics: robotLoadResult.diagnostics,
        },
      });
      useTrainingImportContextStore.getState().setImportContext({
        robotUsdKey: selectedUsdKey,
        terrainUsdKey: requestedTerrainUsdKey,
        terrainMode,
        diagnostics,
      });
      return;
    }
    const preferredRobotId = useSceneStore.getState().selectedId ?? useAppStore.getState().selected?.id ?? null;
    const restoreRobotSelection = () => {
      if (!preferredRobotId) return;
      const sceneState = useSceneStore.getState();
      const robotNode = sceneState.nodes[preferredRobotId];
      if (!robotNode) return;
      sceneState.setSelected(preferredRobotId);
      viewer.setSelected?.(preferredRobotId);
      const worldPosition =
        viewer.getObjectWorldPosition?.(preferredRobotId) ?? useAppStore.getState().selected?.position ?? { x: 0, y: 0, z: 0 };
      setSelected({
        id: preferredRobotId,
        name: robotNode.name || preferredRobotId,
        position: worldPosition,
      });
    };
    const terrainAssetId = terrainMode === "plane" ? (input.terrainAssetId ?? "floor") : null;
    const shouldSkipSecondaryUsdImport =
      terrainMode === "usd" &&
      Boolean(requestedTerrainUsdKey) &&
      normalizeWorkspaceFilePath(String(requestedTerrainUsdKey ?? "")) ===
        normalizeWorkspaceFilePath(String(selectedUsdKey ?? ""));
    if (terrainAssetId) {
      addSceneAsset(terrainAssetId);
      restoreRobotSelection();
      logInfo("Viewport terrain asset imported", {
        scope: "assets",
        data: {
          terrainMode,
          terrainAssetId,
          robotUsdKey: selectedUsdKey,
        },
      });
    } else if (terrainMode === "usd" && requestedTerrainUsdKey) {
      if (shouldSkipSecondaryUsdImport) {
        logInfo("Viewport environment bundle import reused selected USD entry; secondary import skipped", {
          scope: "assets",
          data: {
            usdKey: selectedUsdKey,
            terrainUsdKey: requestedTerrainUsdKey,
            replaceFullScene: shouldReplaceFullScene,
          },
        });
      } else {
        const envLoadResult = await importManager.import_usd({
          usdKey: requestedTerrainUsdKey,
          assets: assetStore.assets,
          importOptions: input.options satisfies UsdImportOptions,
          bundleHintPaths: resolveScopedBundleHintPaths(requestedTerrainUsdKey, usdDialogBundleHintPaths),
          sceneRole: "scene_asset",
          frameOnAdd: false,
        });
        diagnostics.push(...envLoadResult.diagnostics);
        if (!envLoadResult.ok) {
          logWarn("Viewport environment bundle import failed validation", {
            scope: "assets",
            data: {
              robotUsdKey: selectedUsdKey,
              environmentUsdKey: requestedTerrainUsdKey,
              diagnostics: envLoadResult.diagnostics,
            },
          });
        } else {
          restoreRobotSelection();
          logInfo("Viewport environment USD bundle imported", {
            scope: "assets",
            data: {
              robotUsdKey: selectedUsdKey,
              environmentUsdKey: requestedTerrainUsdKey,
              replaceFullScene: shouldReplaceFullScene,
            },
          });
        }
      }
    } else if (terrainMode === "generator") {
      logInfo("Viewport terrain visualization skipped for runtime generator mode", {
        scope: "assets",
        data: {
          terrainMode,
          robotUsdKey: selectedUsdKey,
        },
      });
    }
    const terrainContextUsdKey = terrainMode === "usd" || terrainMode === "generator" ? requestedTerrainUsdKey : null;
    const environmentSnapshot = environmentDocumentManager.getEnvironment(editorEngine.getDoc());
    useTrainingImportContextStore.getState().setImportContext({
      robotUsdKey: selectedUsdKey,
      terrainUsdKey: terrainContextUsdKey,
      terrainMode,
      environmentSnapshot,
      diagnostics,
    });
    logInfo("Viewport USD import confirmed", {
      scope: "assets",
      data: {
        usdKey: selectedUsdKey,
        requestedTerrainUsdKey,
        terrainUsdKey: terrainContextUsdKey,
        terrainMode,
        replaceFullScene: shouldReplaceFullScene,
        diagnosticsCount: diagnostics.length,
        options: input.options,
      },
    });
    await captureWorkspacePreviewIfNeeded(selectedUsdKey);
  }, [captureWorkspacePreviewIfNeeded, closeUsdImportDialog, setSelected, setUSD, setUSDOptions, usdDialogBundleHintPaths, viewer]);

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
            key={`${usdDialogKey ?? "usd-dialog"}-${usdDialogInitialOptions.floatingBase ? 1 : 0}-${usdDialogInitialOptions.selfCollision ? 1 : 0}-${usdDialogVariantOptions.length}-${usdDialogTerrainOptions.length}`}
            usdKey={usdDialogKey}
            variantUsdKeys={usdDialogVariantOptions}
            terrainUsdKeys={usdDialogTerrainOptions}
            initialTerrainUsdKey={usdDialogSelectedTerrainUsdKey}
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
