import type { EnvironmentAsset, EnvironmentDoc, EnvironmentEntity } from "../editor/document/types";
import type { CompiledEnvironmentSnapshot } from "../environment/EnvironmentCompilationManager";
import type { TemplateRuntimeRequirements } from "@runtime-plugins/catalog/types";

export type SceneTrainingRobotSourceKind = "usd" | "mjcf" | "urdf" | "unknown";

export type SceneTrainingRobotCandidate = {
  entityId: string;
  assetId: string;
  label: string;
  sourceKind: SceneTrainingRobotSourceKind;
};

export type SceneTrainingEligibility = {
  canCreateExperiment: boolean;
  reason?: string;
  robotCount: number;
  primaryRobotEntityId: string | null;
  primaryRobotAssetId: string | null;
  robotCandidates: SceneTrainingRobotCandidate[];
};

function toText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeSourceKind(asset: EnvironmentAsset | null): SceneTrainingRobotSourceKind {
  const token = toText(asset?.kind).toLowerCase();
  if (token === "usd" || token === "mjcf" || token === "urdf") return token;
  return "unknown";
}

function resolveCandidateAssetId(entity: EnvironmentEntity, asset: EnvironmentAsset | null): string {
  const attachedTrainingAssetId = toText(asset?.trainingAssetId);
  if (attachedTrainingAssetId) return attachedTrainingAssetId;
  return toText(entity.sourceAssetId);
}

function findRobotCandidates(snapshot: EnvironmentDoc | null): SceneTrainingRobotCandidate[] {
  if (!snapshot) return [];
  const entities = isObject(snapshot.entities) ? (snapshot.entities as Record<string, EnvironmentEntity>) : {};
  const assets = isObject(snapshot.assets) ? (snapshot.assets as Record<string, EnvironmentAsset>) : {};
  const candidates: SceneTrainingRobotCandidate[] = [];
  for (const rawEntity of Object.values(entities)) {
    if (!rawEntity || typeof rawEntity !== "object") continue;
    const entity = rawEntity as EnvironmentEntity;
    if (entity.kind !== "robot") continue;
    const entityId = toText(entity.id);
    if (!entityId) continue;
    const sourceAssetId = toText(entity.sourceAssetId);
    const sourceAsset = sourceAssetId && assets[sourceAssetId] ? assets[sourceAssetId] : null;
    const resolvedAssetId = resolveCandidateAssetId(entity, sourceAsset);
    if (!resolvedAssetId) continue;
    candidates.push({
      entityId,
      assetId: resolvedAssetId,
      label: toText(entity.name) || entityId,
      sourceKind: normalizeSourceKind(sourceAsset),
    });
  }
  candidates.sort((a, b) => a.entityId.localeCompare(b.entityId));
  return candidates;
}

function findRobotEntityById(snapshot: EnvironmentDoc | null, entityId: string): EnvironmentEntity | null {
  if (!snapshot) return null;
  const entities = isObject(snapshot.entities) ? (snapshot.entities as Record<string, EnvironmentEntity>) : {};
  const raw = entities[entityId];
  if (!raw || typeof raw !== "object") return null;
  return raw;
}

function selectPrimaryRobot(
  candidates: SceneTrainingRobotCandidate[],
  snapshot: EnvironmentDoc | null
): SceneTrainingRobotCandidate {
  if (snapshot) {
    const roots = Array.isArray(snapshot.roots) ? snapshot.roots.map((item) => toText(item)).filter(Boolean) : [];
    for (const rootId of roots) {
      const match = candidates.find((candidate) => candidate.entityId === rootId);
      if (match) return match;
    }
  }

  const topLevel = candidates.filter((candidate) => {
    const entity = findRobotEntityById(snapshot, candidate.entityId);
    return toText(entity?.parentId).length === 0;
  });
  if (topLevel.length > 0) {
    topLevel.sort((a, b) => a.entityId.localeCompare(b.entityId));
    return topLevel[0];
  }

  return candidates.slice().sort((a, b) => a.entityId.localeCompare(b.entityId))[0];
}

function resolveEnvironmentSnapshot(input: CompiledEnvironmentSnapshot | EnvironmentDoc | null): EnvironmentDoc | null {
  if (!input) return null;
  if ("environment" in input) {
    const environment = input.environment;
    return environment ?? null;
  }
  return input;
}

export type TemplateReadinessStatus = {
  status: "launchable" | "blocked";
  blockers: string[];
  warnings: string[];
};

export function deriveTemplateReadiness(
  eligibility: SceneTrainingEligibility,
  requirements: TemplateRuntimeRequirements
): TemplateReadinessStatus {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (requirements.robotRequired && !eligibility.canCreateExperiment) {
    blockers.push(eligibility.reason ?? "No robot found in the scene");
  }

  if (requirements.terrainRequired === true) {
    warnings.push("Template requires terrain — ensure a terrain asset is configured before launch");
  }

  if (!requirements.sceneSupport.mjcfConvertedRobot && !requirements.sceneSupport.usdPassthrough) {
    blockers.push("Template does not support any robot asset pipeline (usdPassthrough or mjcfConvertedRobot required)");
  }

  return {
    status: blockers.length > 0 ? "blocked" : "launchable",
    blockers,
    warnings,
  };
}

export function deriveSceneTrainingEligibility(
  input: CompiledEnvironmentSnapshot | EnvironmentDoc | null
): SceneTrainingEligibility {
  const snapshot = resolveEnvironmentSnapshot(input);
  const robotCandidates = findRobotCandidates(snapshot);
  if (robotCandidates.length === 0) {
    return {
      canCreateExperiment: false,
      reason: "No robot found in the scene",
      robotCount: 0,
      primaryRobotEntityId: null,
      primaryRobotAssetId: null,
      robotCandidates: [],
    };
  }

  const primary = selectPrimaryRobot(robotCandidates, snapshot);
  return {
    canCreateExperiment: true,
    robotCount: robotCandidates.length,
    primaryRobotEntityId: primary.entityId,
    primaryRobotAssetId: primary.assetId || null,
    robotCandidates,
  };
}
