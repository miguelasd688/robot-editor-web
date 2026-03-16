import type * as THREE from "three";
import type { AssetEntry } from "../../assets/assetRegistryTypes";
import type { Viewer } from "../../viewer/Viewer";
import type { ProjectDoc, SceneNode } from "../../editor/document/types";
import type { CompiledEnvironmentSnapshot } from "../../environment/EnvironmentCompilationManager";
import type { MujocoModelSource } from "./MujocoRuntime";
import type { MjcfNameMap } from "./mjcfNames";
import { buildModelSource, mergeMjcfSources } from "./mujocoModelSource";
import { exportRobotToUrdf } from "../../urdf/urdfExport";
import { resolveUrdfImportOptionsFromSources } from "../../urdf/urdfImportOptions";
import { logWarn } from "../../services/logger";

type UrdfRuntimeDefaults = {
  floatingBase: boolean;
  firstLinkIsWorldReferenceFrame: boolean;
  selfCollision: boolean;
  collisionMode?: "mesh" | "box" | "sphere" | "cylinder" | "fast";
};

export type MujocoEnvironmentBuildInput = {
  compilation: CompiledEnvironmentSnapshot;
  viewer: Viewer;
  roots: THREE.Object3D[];
  assets: Record<string, AssetEntry>;
  urdfDefaults: UrdfRuntimeDefaults;
};

export type MujocoEnvironmentBuildResult = {
  source: MujocoModelSource;
  nameMapsByRobot: Record<string, MjcfNameMap>;
  warnings: string[];
};

function listRobotNodes(doc: ProjectDoc): SceneNode[] {
  return Object.values(doc.scene.nodes).filter((node) => node.kind === "robot");
}

function listNonRobotRoots(roots: THREE.Object3D[], robotNodeIds: Set<string>): THREE.Object3D[] {
  return roots.filter((root) => {
    const docId = String(root.userData?.docId ?? "").trim();
    if (!docId) return true;
    return !robotNodeIds.has(docId);
  });
}

async function buildRobotSource(input: {
  node: SceneNode;
  root: THREE.Object3D;
  doc: ProjectDoc;
  assets: Record<string, AssetEntry>;
  urdfDefaults: UrdfRuntimeDefaults;
}): Promise<{ source: MujocoModelSource | null; nameMap?: MjcfNameMap; warnings: string[] }> {
  const { node, root, doc, assets, urdfDefaults } = input;
  const warnings: string[] = [];
  const sourceUrdf = node.components?.urdfSource ?? (root.userData?.urdfSource as string | undefined);
  let urdfSource = sourceUrdf;
  const urdfKeyForRobot = node.components?.urdfKey ?? (root.userData?.urdfKey as string | undefined) ?? null;
  const modelSource = node.components?.robotModelSource ?? (root.userData?.robotModelSource as Record<string, unknown> | undefined);
  const sourceIsCleanUsd = modelSource?.kind === "usd" && modelSource?.isDirty !== true;
  const usdIntrospection = root.userData?.usdIntrospection as
    | {
        joints?: Array<{ frame0Local?: unknown; frame1Local?: unknown }>;
      }
    | undefined;
  const hasUsdFrameIntrospection =
    sourceIsCleanUsd &&
    Array.isArray(usdIntrospection?.joints) &&
    usdIntrospection.joints.some((joint) => Boolean(joint?.frame0Local || joint?.frame1Local));
  // Preserve kinematic alignment for imports that expose explicit USD joint frames.
  // In those cases, direct converter MJCF can drift from the editor link/joint layout.
  const canUseDirectMjcf = sourceIsCleanUsd && !hasUsdFrameIntrospection;
  const cachedDirectMjcfSource =
    sourceIsCleanUsd && typeof root.userData?.mjcfSource === "string" && root.userData.mjcfSource.trim()
      ? (root.userData.mjcfSource as string)
      : null;
  const cachedDirectMjcfKey =
    sourceIsCleanUsd && typeof root.userData?.mjcfAssetId === "string" && root.userData.mjcfAssetId.trim()
      ? (root.userData.mjcfAssetId as string)
      : null;
  const directMjcfSource = canUseDirectMjcf ? cachedDirectMjcfSource : null;
  const directMjcfKey = canUseDirectMjcf ? cachedDirectMjcfKey : null;
  const hasDirectMjcf = Boolean(directMjcfSource || directMjcfKey);
  const shouldRegenerateUrdf =
    Boolean(sourceUrdf) ||
    Boolean(urdfKeyForRobot) ||
    (modelSource?.kind === "usd" && (sourceIsCleanUsd !== true || !hasDirectMjcf));
  if (sourceIsCleanUsd && hasUsdFrameIntrospection && (cachedDirectMjcfSource || cachedDirectMjcfKey)) {
    warnings.push(
      `[robot:${node.name || node.id}] USD introspection frames detected; regenerating URDF from posed scene for joint/link coherence.`
    );
  }
  if (shouldRegenerateUrdf) {
    try {
      const exported = exportRobotToUrdf(doc, node.id);
      urdfSource = exported.urdf;
      warnings.push(...exported.warnings.map((warning) => `[robot:${node.name || node.id}] ${warning}`));
    } catch (error) {
      logWarn("MuJoCo: failed to regenerate robot URDF from scene; using source URDF.", {
        scope: "mujoco",
        data: {
          robotId: node.id,
          error: String((error as Error)?.message ?? error),
        },
      });
    }
  }

  const importOptions = resolveUrdfImportOptionsFromSources({
    urdfImportOptions: node.components?.urdfImportOptions ?? root.userData?.urdfImportOptions,
    robotModelSource: node.components?.robotModelSource ?? root.userData?.robotModelSource,
  });
  const perRobotUrdfOptions = {
    floatingBase: importOptions?.floatingBase ?? urdfDefaults.floatingBase,
    firstLinkIsWorldReferenceFrame:
      importOptions?.firstLinkIsWorldReferenceFrame ?? urdfDefaults.firstLinkIsWorldReferenceFrame,
    selfCollision: importOptions?.selfCollision ?? urdfDefaults.selfCollision,
    collisionMode: importOptions?.collisionMode ?? urdfDefaults.collisionMode,
  };
  const built = await buildModelSource({
    assets,
    urdfKey: urdfKeyForRobot,
    urdfSource,
    mjcfKey: directMjcfKey,
    mjcfSource: directMjcfSource,
    namePrefix: node.id,
    urdfOptions: perRobotUrdfOptions,
    roots: [root],
  });
  warnings.push(...built.warnings);
  if (built.source.kind !== "mjcf") {
    return {
      source: null,
      warnings,
    };
  }
  return {
    source: built.source,
    nameMap: built.source.nameMap,
    warnings,
  };
}

export class MujocoEnvironmentManager {
  async buildRuntimeSource(input: MujocoEnvironmentBuildInput): Promise<MujocoEnvironmentBuildResult> {
    const doc = input.compilation.normalizedDoc;
    const environmentWarnings = input.compilation.diagnostics.map((diagnostic) => `[${diagnostic.code}] ${diagnostic.message}`);
    const robotNodes = listRobotNodes(doc);
    if (robotNodes.length === 0) {
      const built = await buildModelSource({
        assets: input.assets,
        urdfKey: null,
        urdfOptions: input.urdfDefaults,
        roots: input.roots,
      });
      return {
        source: built.source,
        nameMapsByRobot: {},
        warnings: [...environmentWarnings, ...built.warnings],
      };
    }

    const warnings: string[] = [...environmentWarnings];
    const sources: MujocoModelSource[] = [];
    const nameMaps: Array<MjcfNameMap | undefined> = [];
    const nameMapsByRobot: Record<string, MjcfNameMap> = {};
    const robotNodeIds = new Set(robotNodes.map((node) => node.id));
    for (const node of robotNodes) {
      const root = input.viewer.getObjectById(node.id);
      if (!root) continue;
      const result = await buildRobotSource({
        node,
        root,
        doc,
        assets: input.assets,
        urdfDefaults: input.urdfDefaults,
      });
      warnings.push(...result.warnings);
      if (!result.source || result.source.kind !== "mjcf") continue;
      sources.push(result.source);
      nameMaps.push(result.nameMap);
      if (result.nameMap) {
        nameMapsByRobot[node.id] = result.nameMap;
      }
    }

    const nonRobotRoots = listNonRobotRoots(input.roots, robotNodeIds);
    if (nonRobotRoots.length > 0) {
      const sceneBuilt = await buildModelSource({
        assets: input.assets,
        urdfKey: null,
        urdfOptions: input.urdfDefaults,
        roots: nonRobotRoots,
      });
      warnings.push(...sceneBuilt.warnings.map((warning) => `[scene] ${warning}`));
      if (sceneBuilt.source.kind === "mjcf") {
        sources.push(sceneBuilt.source);
        nameMaps.push(undefined);
      }
    }

    if (!sources.length) {
      return {
        source: { kind: "generated" },
        nameMapsByRobot,
        warnings,
      };
    }
    const merged = mergeMjcfSources({ sources, nameMaps });
    return {
      source: merged.source,
      nameMapsByRobot,
      warnings,
    };
  }
}

export const mujocoEnvironmentManager = new MujocoEnvironmentManager();
