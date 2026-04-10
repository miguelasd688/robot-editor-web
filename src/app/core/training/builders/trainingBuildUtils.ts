import * as THREE from "three";
import type { EnvironmentDiagnostic, EnvironmentDoc, ProjectDoc } from "../../editor/document/types";
import { environmentCompilationManager } from "../../environment/EnvironmentCompilationManager";
import type { CustomTrainingEnvironmentPlacement } from "./trainingRequestTypes";

export type TrainingPlacementTransform = {
  position?: { x: number; y: number; z: number };
  rotationDeg?: { x: number; y: number; z: number };
  scale?: { x: number; y: number; z: number };
};

export function toObjectOrEmpty(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function toTextOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function toPositiveIntOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(1, Math.round(parsed));
}

export function toNonNegativeIntOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.round(parsed));
}

export function toStringArrayOrUndefined(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const next = value
    .map((item) => String(item ?? "").trim())
    .filter((item) => item.length > 0);
  return next.length > 0 ? next : undefined;
}

export function toArrayOfObjectsOrUndefined(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const next = value
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => item as Record<string, unknown>);
  return next.length > 0 ? next : undefined;
}

export function normalizeAssetPipelineOrUndefined(
  value: unknown
): { mode: "usd_passthrough" | "mjcf_conversion"; reason?: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const modeToken = toTextOrEmpty(record.mode).toLowerCase();
  if (modeToken !== "usd_passthrough" && modeToken !== "mjcf_conversion") return undefined;
  const reason = toTextOrEmpty(record.reason);
  return {
    mode: modeToken,
    ...(reason ? { reason } : {}),
  };
}

export function cloneEnvironmentSnapshot(snapshot: EnvironmentDoc | null): EnvironmentDoc | null {
  if (!snapshot) return null;
  return JSON.parse(JSON.stringify(snapshot)) as EnvironmentDoc;
}

export function normalizeBaseConstraintMode(value: unknown): "fix_base" | "source_weld" | undefined {
  const token = toTextOrEmpty(value).toLowerCase();
  if (token === "fix_base" || token === "source_weld") return token;
  return undefined;
}

function toCartpoleJointMapOrUndefined(value: unknown): Record<string, unknown> | undefined {
  const record = toObjectOrEmpty(value);
  const cartDofName = toTextOrEmpty(record.cartDofName);
  const poleDofName = toTextOrEmpty(record.poleDofName);
  if (!cartDofName || !poleDofName || cartDofName === poleDofName) return undefined;
  return {
    cartDofName,
    poleDofName,
  };
}

export function pickEnvironmentOverrides(value: Record<string, unknown>) {
  const baseConstraintMode = normalizeBaseConstraintMode(value.baseConstraintMode);
  return {
    robotUsdOverridePath: toTextOrEmpty(value.robotUsdOverridePath) || undefined,
    sceneUsdOverridePath: toTextOrEmpty(value.sceneUsdOverridePath) || undefined,
    sceneUsdTypeOverridePath: toTextOrEmpty(value.sceneUsdTypeOverridePath) || undefined,
    runtimeWorldUsdOverridePath: toTextOrEmpty(value.runtimeWorldUsdOverridePath) || undefined,
    sceneTerrainType: toTextOrEmpty(value.sceneTerrainType) || undefined,
    sceneUsdTypeValue: toTextOrEmpty(value.sceneUsdTypeValue) || undefined,
    controlMode: toTextOrEmpty(value.controlMode) || undefined,
    observables: toArrayOfObjectsOrUndefined(value.observables),
    actions: toArrayOfObjectsOrUndefined(value.actions),
    resets: toArrayOfObjectsOrUndefined(value.resets),
    ik:
      value.ik && typeof value.ik === "object" && !Array.isArray(value.ik)
        ? (value.ik as Record<string, unknown>)
        : undefined,
    cartpoleJointMap: toCartpoleJointMapOrUndefined(value.cartpoleJointMap),
    baseConstraintMode,
    resolvedLaunchPlan:
      value.resolvedLaunchPlan && typeof value.resolvedLaunchPlan === "object" && !Array.isArray(value.resolvedLaunchPlan)
        ? (value.resolvedLaunchPlan as Record<string, unknown>)
        : undefined,
  };
}

export function normalizeDiagnostics(value: unknown): EnvironmentDiagnostic[] {
  if (!Array.isArray(value)) return [];
  const diagnostics: EnvironmentDiagnostic[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const code = toTextOrEmpty(raw.code);
    const message = toTextOrEmpty(raw.message);
    if (!code || !message) continue;
    const severity = raw.severity === "error" ? "error" : "warning";
    const source =
      raw.source === "import" || raw.source === "document" || raw.source === "simulation" || raw.source === "training"
        ? raw.source
        : "document";
    const diagnostic: EnvironmentDiagnostic = {
      code,
      message,
      severity,
      source,
    };
    if (raw.context && typeof raw.context === "object" && !Array.isArray(raw.context)) {
      diagnostic.context = raw.context as Record<string, unknown>;
    }
    diagnostics.push(diagnostic);
  }
  return diagnostics;
}

export function mergeDiagnostics(...sources: Array<EnvironmentDiagnostic[]>): EnvironmentDiagnostic[] {
  const result: EnvironmentDiagnostic[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const diagnostic of source) {
      const key = `${diagnostic.code}|${diagnostic.severity}|${diagnostic.source}|${diagnostic.message}|${JSON.stringify(
        diagnostic.context ?? {}
      )}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(diagnostic);
    }
  }
  return result;
}

function toFiniteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function eulerDegreesToQuaternionXYZ(
  xDeg: number,
  yDeg: number,
  zDeg: number
): [number, number, number, number] {
  const deg2rad = Math.PI / 180;
  const x = xDeg * deg2rad;
  const y = yDeg * deg2rad;
  const z = zDeg * deg2rad;
  const c1 = Math.cos(x * 0.5);
  const c2 = Math.cos(y * 0.5);
  const c3 = Math.cos(z * 0.5);
  const s1 = Math.sin(x * 0.5);
  const s2 = Math.sin(y * 0.5);
  const s3 = Math.sin(z * 0.5);

  const qx = s1 * c2 * c3 + c1 * s2 * s3;
  const qy = c1 * s2 * c3 - s1 * c2 * s3;
  const qz = c1 * c2 * s3 + s1 * s2 * c3;
  const qw = c1 * c2 * c3 - s1 * s2 * s3;
  const norm = Math.hypot(qx, qy, qz, qw);
  if (norm <= 0) return [0, 0, 0, 1];
  return [qx / norm, qy / norm, qz / norm, qw / norm];
}

export function buildTrainingPlacementsFromSnapshot(
  snapshot: EnvironmentDoc | null
): CustomTrainingEnvironmentPlacement[] {
  if (!snapshot || !snapshot.entities || typeof snapshot.entities !== "object") return [];
  const placements: CustomTrainingEnvironmentPlacement[] = [];

  for (const [rawEntityId, rawEntity] of Object.entries(snapshot.entities)) {
    if (!rawEntity || typeof rawEntity !== "object" || Array.isArray(rawEntity)) continue;
    const entity = rawEntity as Record<string, unknown>;
    const entityId = toTextOrEmpty(entity.id) || rawEntityId;
    const sourceAssetId = toTextOrEmpty(entity.sourceAssetId);
    if (!entityId || !sourceAssetId) continue;

    const transform = toObjectOrEmpty(entity.transform);
    const position = toObjectOrEmpty(transform.position);
    const rotation = toObjectOrEmpty(transform.rotation);
    const scale = toObjectOrEmpty(transform.scale);
    const translation: [number, number, number] = [
      toFiniteNumber(position.x, 0),
      toFiniteNumber(position.y, 0),
      toFiniteNumber(position.z, 0),
    ];
    const rotationQuat = eulerDegreesToQuaternionXYZ(
      toFiniteNumber(rotation.x, 0),
      toFiniteNumber(rotation.y, 0),
      toFiniteNumber(rotation.z, 0)
    );
    const scaleTuple: [number, number, number] = [
      toFiniteNumber(scale.x, 1),
      toFiniteNumber(scale.y, 1),
      toFiniteNumber(scale.z, 1),
    ];

    placements.push({
      entityId,
      sourceAssetId,
      localTransform: {
        translation,
        rotationQuat,
        scale: scaleTuple,
      },
    });
  }

  placements.sort((a, b) => a.entityId.localeCompare(b.entityId));
  return placements;
}

function normalizeWorkspaceKey(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\\/g, "/").replace(/^\/+/, "") : "";
}

function toPlacementArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === "object" && !Array.isArray(item)) as Array<
    Record<string, unknown>
  >;
}

function quaternionToEulerDegreesXYZ(rotationQuat: unknown): TrainingPlacementTransform["rotationDeg"] | undefined {
  if (!Array.isArray(rotationQuat) || rotationQuat.length < 4) return undefined;
  const x = Number(rotationQuat[0]);
  const y = Number(rotationQuat[1]);
  const z = Number(rotationQuat[2]);
  const w = Number(rotationQuat[3]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(w)) return undefined;
  const quaternion = new THREE.Quaternion(x, y, z, w);
  const euler = new THREE.Euler().setFromQuaternion(quaternion, "XYZ");
  const rad2deg = 180 / Math.PI;
  return {
    x: euler.x * rad2deg,
    y: euler.y * rad2deg,
    z: euler.z * rad2deg,
  };
}

function placementToTrainingPlacementTransform(placement: Record<string, unknown>): TrainingPlacementTransform | undefined {
  const localTransform = toObjectOrEmpty(placement.localTransform);
  const translation = Array.isArray(localTransform.translation) ? localTransform.translation : [];
  const rotationQuat = Array.isArray(localTransform.rotationQuat) ? localTransform.rotationQuat : [];
  const scale = Array.isArray(localTransform.scale) ? localTransform.scale : [];
  const hasPosition = translation.some((value) => Number.isFinite(Number(value)));
  const hasScale = scale.some((value) => Number.isFinite(Number(value)));
  const rotationDeg = quaternionToEulerDegreesXYZ(rotationQuat);
  const hasRotation = Boolean(rotationDeg);

  if (!hasPosition && !hasRotation && !hasScale) return undefined;

  return {
    ...(hasPosition
      ? {
          position: {
            x: toFiniteNumber(translation[0], 0),
            y: toFiniteNumber(translation[1], 0),
            z: toFiniteNumber(translation[2], 0),
          },
        }
      : {}),
    ...(rotationDeg ? { rotationDeg } : {}),
    ...(hasScale
      ? {
          scale: {
            x: toFiniteNumber(scale[0], 1),
            y: toFiniteNumber(scale[1], 1),
            z: toFiniteNumber(scale[2], 1),
          },
        }
      : {}),
  };
}

function resolvePlacementFromContainer(input: {
  container: unknown;
  primaryRobotEntityId: string;
  primaryRobotAssetId: string;
  robotUsdKey: string;
}): TrainingPlacementTransform | undefined {
  const container = toObjectOrEmpty(input.container);
  const placements = toPlacementArray(container.placements);
  if (placements.length === 0) return undefined;

  for (const placement of placements) {
    const entityId = toTextOrEmpty(placement.entityId);
    const sourceAssetId = toTextOrEmpty(placement.sourceAssetId);
    if (input.primaryRobotEntityId && entityId === input.primaryRobotEntityId) {
      return placementToTrainingPlacementTransform(placement);
    }
    if (input.primaryRobotAssetId && sourceAssetId === input.primaryRobotAssetId) {
      return placementToTrainingPlacementTransform(placement);
    }
    if (input.robotUsdKey && sourceAssetId === input.robotUsdKey) {
      return placementToTrainingPlacementTransform(placement);
    }
  }

  return undefined;
}

function resolvePrimaryRobotIdentifiersFromCompiledEnvironment(input: {
  compiledTrainingEnvironment: Record<string, unknown>;
  snapshot: EnvironmentDoc | null;
}): {
  primaryRobotEntityId: string;
  primaryRobotAssetId: string;
} {
  const environment = input.compiledTrainingEnvironment;
  const editorSceneContract = toObjectOrEmpty(environment.editorSceneContract);
  const primaryRobot = toObjectOrEmpty(editorSceneContract.primaryRobot);
  const controlPolicy = toObjectOrEmpty(environment.controlPolicy);
  const metadata = toObjectOrEmpty(environment.metadata);
  const snapshotEntities =
    input.snapshot && typeof input.snapshot.entities === "object" && input.snapshot.entities
      ? (input.snapshot.entities as Record<string, Record<string, unknown>>)
      : {};

  const primaryRobotEntityId =
    toTextOrEmpty(primaryRobot.entityId) ||
    toTextOrEmpty(controlPolicy.primaryRobotEntityId) ||
    toTextOrEmpty(environment.primaryRobotEntityId) ||
    toTextOrEmpty(metadata.primaryRobotEntityId);
  const primaryRobotAssetId =
    toTextOrEmpty(primaryRobot.assetId) ||
    toTextOrEmpty(controlPolicy.primaryRobotAssetId) ||
    toTextOrEmpty(environment.robotAssetId) ||
    toTextOrEmpty(metadata.primaryRobotAssetId);

  if (primaryRobotEntityId || primaryRobotAssetId) {
    return {
      primaryRobotEntityId,
      primaryRobotAssetId,
    };
  }

  for (const entity of Object.values(snapshotEntities)) {
    if (!entity || typeof entity !== "object" || Array.isArray(entity)) continue;
    const record = entity as Record<string, unknown>;
    if (toTextOrEmpty(record.kind).toLowerCase() !== "robot") continue;
    return {
      primaryRobotEntityId: toTextOrEmpty(record.id),
      primaryRobotAssetId: toTextOrEmpty(record.sourceAssetId),
    };
  }

  return {
    primaryRobotEntityId: "",
    primaryRobotAssetId: "",
  };
}

function transformToTrainingPlacementTransform(transform: unknown): TrainingPlacementTransform | undefined {
  const record = toObjectOrEmpty(transform);
  const position = toObjectOrEmpty(record.position);
  const rotation = toObjectOrEmpty(record.rotation);
  const scale = toObjectOrEmpty(record.scale);
  const hasPosition =
    typeof position.x === "number" || typeof position.y === "number" || typeof position.z === "number";
  const hasRotation =
    typeof rotation.x === "number" || typeof rotation.y === "number" || typeof rotation.z === "number";
  const hasScale = typeof scale.x === "number" || typeof scale.y === "number" || typeof scale.z === "number";

  if (!hasPosition && !hasRotation && !hasScale) return undefined;

  return {
    ...(hasPosition
      ? {
          position: {
            x: toFiniteNumber(position.x, 0),
            y: toFiniteNumber(position.y, 0),
            z: toFiniteNumber(position.z, 0),
          },
        }
      : {}),
    ...(hasRotation
      ? {
          rotationDeg: {
            x: toFiniteNumber(rotation.x, 0),
            y: toFiniteNumber(rotation.y, 0),
            z: toFiniteNumber(rotation.z, 0),
          },
        }
      : {}),
    ...(hasScale
      ? {
          scale: {
            x: toFiniteNumber(scale.x, 1),
            y: toFiniteNumber(scale.y, 1),
            z: toFiniteNumber(scale.z, 1),
          },
        }
      : {}),
  };
}

export function resolvePrimaryRobotImportTransformFromSnapshot(input: {
  snapshot: EnvironmentDoc | null;
  robotUsdKey?: string | null;
}): TrainingPlacementTransform | undefined {
  const snapshot = input.snapshot;
  if (!snapshot || !snapshot.entities || typeof snapshot.entities !== "object") return undefined;

  const robotUsdKey = normalizeWorkspaceKey(input.robotUsdKey);
  const robotEntities = Object.values(snapshot.entities)
    .filter((entity) => Boolean(entity) && typeof entity === "object" && !Array.isArray(entity))
    .map((entity) => entity as Record<string, unknown>)
    .filter((entity) => toTextOrEmpty(entity.kind).toLowerCase() === "robot");

  if (robotEntities.length === 0) return undefined;

  const resolveAssetKeys = (entity: Record<string, unknown>) => {
    const keys = new Set<string>();
    const sourceAssetId = toTextOrEmpty(entity.sourceAssetId);
    if (sourceAssetId) {
      keys.add(normalizeWorkspaceKey(sourceAssetId));
      const asset = snapshot.assets && typeof snapshot.assets === "object" ? (snapshot.assets as Record<string, unknown>)[sourceAssetId] : undefined;
      if (asset && typeof asset === "object" && !Array.isArray(asset)) {
        const assetRecord = asset as Record<string, unknown>;
        keys.add(normalizeWorkspaceKey(assetRecord.workspaceKey));
        keys.add(normalizeWorkspaceKey(assetRecord.converterAssetId));
        keys.add(normalizeWorkspaceKey(assetRecord.trainingAssetId));
        keys.add(normalizeWorkspaceKey(assetRecord.usdKey));
      }
    }
    return Array.from(keys).filter((item) => item.length > 0);
  };

  const matchedByKey =
    robotUsdKey.length > 0
      ? robotEntities.find((entity) => resolveAssetKeys(entity).some((item) => item === robotUsdKey))
      : undefined;
  const matched = matchedByKey ?? (robotEntities.length === 1 ? robotEntities[0] : robotEntities.find((entity) => entity.parentId === null)) ?? robotEntities[0];
  return transformToTrainingPlacementTransform(matched.transform);
}

export function resolvePrimaryRobotImportTransformFromTrainingArtifacts(input: {
  snapshot: EnvironmentDoc | null;
  robotUsdKey?: string | null;
  compiledTrainingEnvironment?: Record<string, unknown> | null;
}): TrainingPlacementTransform | undefined {
  const robotUsdKey = normalizeWorkspaceKey(input.robotUsdKey);
  const compiledTrainingEnvironment =
    input.compiledTrainingEnvironment && typeof input.compiledTrainingEnvironment === "object" && !Array.isArray(input.compiledTrainingEnvironment)
      ? (input.compiledTrainingEnvironment as Record<string, unknown>)
      : null;

  if (compiledTrainingEnvironment) {
    const identifiers = resolvePrimaryRobotIdentifiersFromCompiledEnvironment({
      compiledTrainingEnvironment,
      snapshot: input.snapshot,
    });

    const scenePreparation = toObjectOrEmpty(compiledTrainingEnvironment.scenePreparation);
    const placements = [
      scenePreparation.placements,
      compiledTrainingEnvironment.placements,
      toObjectOrEmpty(compiledTrainingEnvironment.editorSceneContract).placements,
    ];
    for (const placementSource of placements) {
      const resolved = resolvePlacementFromContainer({
        container: { placements: placementSource },
        primaryRobotEntityId: identifiers.primaryRobotEntityId,
        primaryRobotAssetId: identifiers.primaryRobotAssetId,
        robotUsdKey,
      });
      if (resolved) return resolved;
    }
  }

  return resolvePrimaryRobotImportTransformFromSnapshot({
    snapshot: input.snapshot,
    robotUsdKey,
  });
}

export function resolvePrimaryRobotImportTransformFromProjectDoc(input: {
  projectDoc: ProjectDoc | null;
  robotUsdKey?: string | null;
}): TrainingPlacementTransform | undefined {
  if (!input.projectDoc) return undefined;
  const compiled = environmentCompilationManager.compileProjectDoc({
    doc: input.projectDoc,
    target: "training",
  });
  return resolvePrimaryRobotImportTransformFromSnapshot({
    snapshot: compiled.environment,
    robotUsdKey: input.robotUsdKey,
  });
}
