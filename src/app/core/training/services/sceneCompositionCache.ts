const sceneCompositionCache = new Map<string, string>();

export function getCachedSceneCompositionAssetId(signature: string): string | undefined {
  return sceneCompositionCache.get(signature);
}

export function setCachedSceneCompositionAssetId(signature: string, sceneAssetId: string): void {
  if (!signature || !sceneAssetId) return;
  sceneCompositionCache.set(signature, sceneAssetId);
}

export function clearSceneCompositionCache(): void {
  sceneCompositionCache.clear();
}
