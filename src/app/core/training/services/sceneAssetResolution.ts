import type { EnvironmentDoc } from "../../editor/document/types";

function toTextOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toObjectOrEmpty(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export type SnapshotSceneTrainingAssetResolution = {
  sceneAssetId: string;
  sourceAssetId: string;
  entityId: string;
};

export function buildSourceHints(snapshot: EnvironmentDoc | null): Record<string, unknown> {
  if (!snapshot) {
    return {
      assets: {},
      entities: {},
    };
  }
  const assets = toObjectOrEmpty(snapshot.assets) as Record<string, Record<string, unknown>>;
  const entities = toObjectOrEmpty(snapshot.entities) as Record<string, Record<string, unknown>>;
  const assetHints: Record<string, unknown> = {};
  const entityHints: Record<string, unknown> = {};

  for (const [assetId, rawAsset] of Object.entries(assets)) {
    const sourceKind = toTextOrEmpty(rawAsset.kind).toLowerCase() || "unknown";
    assetHints[assetId] = {
      kind: sourceKind,
      role: toTextOrEmpty(rawAsset.role) || undefined,
      trainingAssetId: toTextOrEmpty(rawAsset.trainingAssetId) || undefined,
      workspaceKey: toTextOrEmpty(rawAsset.workspaceKey) || undefined,
      isDirty:
        typeof rawAsset.isDirty === "boolean"
          ? rawAsset.isDirty
          : sourceKind === "usd"
            ? false
            : true,
    };
  }

  for (const [entityId, rawEntity] of Object.entries(entities)) {
    const sourceAssetId = toTextOrEmpty(rawEntity.sourceAssetId);
    entityHints[entityId] = {
      id: toTextOrEmpty(rawEntity.id) || entityId,
      kind: toTextOrEmpty(rawEntity.kind) || "unknown",
      sourceAssetId: sourceAssetId || undefined,
    };
  }

  return {
    assets: assetHints,
    entities: entityHints,
  };
}

function hasSceneKind(kind: unknown): boolean {
  const token = toTextOrEmpty(kind).toLowerCase();
  return token === "terrain" || token === "scene_asset";
}

function selectTopLevelSceneEntities(snapshot: EnvironmentDoc): Array<Record<string, unknown>> {
  const entitiesRaw = toObjectOrEmpty(snapshot.entities);
  const entities = entitiesRaw as Record<string, Record<string, unknown>>;
  const topLevelSceneEntities: Array<Record<string, unknown>> = [];
  for (const rawEntity of Object.values(entities)) {
    if (!rawEntity || typeof rawEntity !== "object") continue;
    if (!hasSceneKind(rawEntity.kind)) continue;
    const parentId = toTextOrEmpty(rawEntity.parentId);
    const parent = parentId ? entities[parentId] : null;
    if (!parent || !hasSceneKind(parent.kind)) {
      topLevelSceneEntities.push(rawEntity);
      continue;
    }
    const parentSourceAssetId = toTextOrEmpty(parent.sourceAssetId);
    const sourceAssetId = toTextOrEmpty(rawEntity.sourceAssetId);
    if (!parentSourceAssetId || !sourceAssetId || parentSourceAssetId !== sourceAssetId) {
      topLevelSceneEntities.push(rawEntity);
    }
  }
  return topLevelSceneEntities;
}

export function resolveSceneAssetIdFromSnapshotTrainingAsset(
  snapshot: EnvironmentDoc | null
): SnapshotSceneTrainingAssetResolution | null {
  if (!snapshot) return null;
  const assets = toObjectOrEmpty(snapshot.assets) as Record<string, Record<string, unknown>>;
  const roots = Array.isArray(snapshot.roots) ? snapshot.roots.map((item) => toTextOrEmpty(item)) : [];
  const rootOrder = new Map<string, number>();
  roots.forEach((rootId, index) => {
    if (!rootId) return;
    rootOrder.set(rootId, index);
  });
  const candidates = selectTopLevelSceneEntities(snapshot)
    .map((entity) => {
      const entityId = toTextOrEmpty(entity.id);
      const sourceAssetId = toTextOrEmpty(entity.sourceAssetId);
      const sourceAsset = sourceAssetId ? assets[sourceAssetId] : null;
      const sourceRole = toTextOrEmpty(sourceAsset?.role).toLowerCase();
      if (sourceRole === "robot") return null;
      const sceneAssetId = toTextOrEmpty(sourceAsset?.trainingAssetId);
      if (!entityId || !sourceAssetId || !sceneAssetId) return null;
      return {
        entityId,
        sourceAssetId,
        sceneAssetId,
      };
    })
    .filter((item): item is SnapshotSceneTrainingAssetResolution => item !== null)
    .sort((a, b) => {
      const aRoot = rootOrder.has(a.entityId) ? (rootOrder.get(a.entityId) as number) : Number.MAX_SAFE_INTEGER;
      const bRoot = rootOrder.has(b.entityId) ? (rootOrder.get(b.entityId) as number) : Number.MAX_SAFE_INTEGER;
      if (aRoot !== bRoot) return aRoot - bRoot;
      return a.entityId.localeCompare(b.entityId);
    });

  return candidates[0] ?? null;
}
