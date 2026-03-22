import type { EnvironmentDiagnostic, EnvironmentDoc } from "../../editor/document/types";
import type { CustomTrainingEnvironmentPlacement } from "./trainingRequestTypes";

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
