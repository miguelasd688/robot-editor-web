export type SceneCompositionCacheEntry = {
  sceneAssetId: string;
  fingerprint?: string;
  scenePreparation?: Record<string, unknown>;
};

const sceneCompositionCache = new Map<string, SceneCompositionCacheEntry>();

export function getCachedSceneComposition(signature: string): SceneCompositionCacheEntry | undefined {
  return sceneCompositionCache.get(signature);
}

export function setCachedSceneComposition(signature: string, entry: SceneCompositionCacheEntry): void {
  if (!signature || !entry.sceneAssetId) return;
  sceneCompositionCache.set(signature, {
    sceneAssetId: entry.sceneAssetId,
    ...(entry.fingerprint ? { fingerprint: entry.fingerprint } : {}),
    ...(entry.scenePreparation ? { scenePreparation: entry.scenePreparation } : {}),
  });
}

export function getCachedSceneCompositionAssetId(signature: string): string | undefined {
  return sceneCompositionCache.get(signature)?.sceneAssetId;
}

export function setCachedSceneCompositionAssetId(signature: string, sceneAssetId: string): void {
  if (!signature || !sceneAssetId) return;
  setCachedSceneComposition(signature, { sceneAssetId, fingerprint: signature });
}

export function clearSceneCompositionCache(): void {
  sceneCompositionCache.clear();
}
