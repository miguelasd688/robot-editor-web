import type { Object3D } from "three";
import type { AssetEntry } from "../../assets/assetRegistryTypes";
import type { ProjectDoc, SceneNode } from "../../editor/document/types";
import type { UrdfImportOptions } from "../../urdf/urdfImportOptions";
import { exportRobotToUrdf } from "../../urdf/urdfExport";
import type { MujocoModelSource } from "./MujocoRuntime";
import type { MjcfNameMap } from "./mjcfNames";
import { buildModelSource, mergeMjcfSources } from "./mujocoModelSource";

type MjcfCollisionMode = "mesh" | "box" | "sphere" | "cylinder" | "fast";

export type MjcfExportUrdfOptions = {
  floatingBase: boolean;
  firstLinkIsWorldReferenceFrame: boolean;
  selfCollision: boolean;
  collisionMode: MjcfCollisionMode;
};

export type RobotRuntimeExportData = {
  urdfKey?: string | null;
  importOptions?: UrdfImportOptions | null;
  root?: Object3D | null;
};

type ExportUrdfOptions = {
  floatingBase: boolean;
  firstLinkIsWorldReferenceFrame: boolean;
  selfCollision: boolean;
  collisionMode: MjcfCollisionMode;
};

export type ExportRobotMjcfInput = {
  doc: ProjectDoc;
  robotId: string;
  assets: Record<string, AssetEntry>;
  defaultUrdfOptions: MjcfExportUrdfOptions;
  runtime?: RobotRuntimeExportData | null;
};

export type ExportRobotMjcfResult = {
  robotId: string;
  robotName: string;
  mjcf: string;
  warnings: string[];
};

export type ExportSceneMjcfInput = {
  doc: ProjectDoc;
  assets: Record<string, AssetEntry>;
  defaultUrdfOptions: MjcfExportUrdfOptions;
  resolveRuntimeRobotData?: (robotId: string) => RobotRuntimeExportData | null | undefined;
};

export type ExportSceneMjcfResult = {
  filename: string;
  mjcf: string;
  warnings: string[];
};

function resolveRobotNode(doc: ProjectDoc, robotId: string): SceneNode {
  const robot = doc.scene.nodes[robotId];
  if (!robot || robot.kind !== "robot") {
    throw new Error("The selected node is not a robot.");
  }
  return robot;
}

function resolveUrdfOptions(defaults: MjcfExportUrdfOptions, overrides?: UrdfImportOptions | null): ExportUrdfOptions {
  return {
    floatingBase: overrides?.floatingBase ?? defaults.floatingBase,
    firstLinkIsWorldReferenceFrame:
      overrides?.firstLinkIsWorldReferenceFrame ?? defaults.firstLinkIsWorldReferenceFrame,
    selfCollision: overrides?.selfCollision ?? defaults.selfCollision,
    collisionMode: overrides?.collisionMode ?? defaults.collisionMode,
  };
}

export async function exportRobotToMjcf(input: ExportRobotMjcfInput): Promise<ExportRobotMjcfResult> {
  const { doc, robotId, assets, defaultUrdfOptions, runtime } = input;
  const robot = resolveRobotNode(doc, robotId);
  const exported = exportRobotToUrdf(doc, robotId);
  const urdfKey = runtime?.urdfKey ?? robot.components?.urdfKey ?? null;
  const urdfOptions = resolveUrdfOptions(defaultUrdfOptions, runtime?.importOptions ?? robot.components?.urdfImportOptions);

  // Keep robot-local coordinates for per-robot export (same behavior as URDF export).
  const converted = await buildModelSource({
    assets,
    urdfKey,
    urdfSource: exported.urdf,
    urdfOptions,
  });

  if (converted.source.kind !== "mjcf") {
    throw new Error("Failed to generate MJCF from the selected robot.");
  }

  return {
    robotId,
    robotName: exported.robotName,
    mjcf: converted.source.content,
    warnings: [...exported.warnings, ...converted.warnings],
  };
}

export async function exportSceneToMjcf(input: ExportSceneMjcfInput): Promise<ExportSceneMjcfResult> {
  const { doc, assets, defaultUrdfOptions, resolveRuntimeRobotData } = input;
  const robotNodes = Object.values(doc.scene.nodes)
    .filter((node): node is SceneNode => node.kind === "robot")
    .sort((a, b) => a.id.localeCompare(b.id));

  if (!robotNodes.length) {
    throw new Error("No robot nodes found in the scene.");
  }

  const warnings: string[] = [];
  const sources: MujocoModelSource[] = [];
  const nameMaps: Array<MjcfNameMap | undefined> = [];

  for (const robot of robotNodes) {
    const runtime = resolveRuntimeRobotData?.(robot.id) ?? null;
    const exported = exportRobotToUrdf(doc, robot.id);
    const warnPrefix = `[robot:${exported.robotName}]`;
    warnings.push(...exported.warnings.map((warning) => `${warnPrefix} ${warning}`));

    const urdfKey = runtime?.urdfKey ?? robot.components?.urdfKey ?? null;
    const urdfOptions = resolveUrdfOptions(defaultUrdfOptions, runtime?.importOptions ?? robot.components?.urdfImportOptions);
    const roots = runtime?.root ? [runtime.root] : undefined;
    const converted = await buildModelSource({
      assets,
      urdfKey,
      urdfSource: exported.urdf,
      namePrefix: robot.id,
      urdfOptions,
      roots,
    });
    warnings.push(...converted.warnings.map((warning) => `${warnPrefix} ${warning}`));

    if (converted.source.kind !== "mjcf") {
      warnings.push(`${warnPrefix} Failed to generate MJCF for this robot.`);
      continue;
    }
    sources.push(converted.source);
    nameMaps.push(converted.source.nameMap);
  }

  if (!sources.length) {
    throw new Error("Failed to generate MJCF for the current scene.");
  }

  const merged = mergeMjcfSources({ sources, nameMaps });
  if (merged.source.kind !== "mjcf") {
    throw new Error("Failed to merge MJCF sources for the scene.");
  }

  return {
    filename: merged.source.filename || "scene.mjcf",
    mjcf: merged.source.content,
    warnings,
  };
}
