export type EditorScenePlacement = {
  entityId: string;
  sourceAssetId?: string;
  localTransform?: {
    translation?: [number, number, number];
    rotationQuat?: [number, number, number, number];
    scale?: [number, number, number];
  };
};

export type EditorScenePrimaryRobot = {
  entityId: string;
  name: string;
  assetId: string;
  sourceKind: string;
};

export type EditorSceneContract = {
  contractVersion: string;
  profileId: string;
  baseTaskId: string;
  taskTemplate: string;
  task: string;
  robotAssetId: string;
  primaryRobot: EditorScenePrimaryRobot;
  sceneAssetId: string | null;
  placements: EditorScenePlacement[];
  terrain: {
    mode: string;
    sourceKind: string;
    assetId: string;
    entityCount: number;
  };
  sceneEntitiesSummary: Record<string, unknown>;
  sourceKinds: Record<string, unknown>;
  sourcePipeline: Record<string, unknown>;
  resolvedLaunchPlan: Record<string, unknown>;
  effectiveScenePolicy: Record<string, unknown>;
  sourceHints: Record<string, unknown>;
  scenePreparation: Record<string, unknown>;
  sceneInjectionMode: string;
  generatedAt: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toText(value: unknown, fallback = "") {
  if (typeof value !== "string") return fallback;
  const token = value.trim();
  return token.length > 0 ? token : fallback;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function summarizeSceneEntities(snapshot: unknown) {
  const snapshotRecord = isObject(snapshot) ? snapshot : {};
  const entities = isObject(snapshotRecord.entities) ? snapshotRecord.entities : {};
  const assets = isObject(snapshotRecord.assets) ? snapshotRecord.assets : {};
  const sourceAssetIds = new Set<string>();
  let robotCount = 0;
  let terrainCount = 0;
  let sceneAssetCount = 0;
  for (const entity of Object.values(entities)) {
    if (!isObject(entity)) continue;
    const kind = toText(entity.kind, "").toLowerCase();
    if (kind === "robot") robotCount += 1;
    if (kind === "terrain") terrainCount += 1;
    if (kind === "scene_asset") sceneAssetCount += 1;
    const sourceAssetId = toText(entity.sourceAssetId, "");
    if (sourceAssetId) sourceAssetIds.add(sourceAssetId);
  }
  return {
    entityCount: Object.keys(entities).length,
    robotCount,
    terrainCount,
    sceneAssetCount,
    sourceAssetCount: sourceAssetIds.size,
    sourceAssetIds: Array.from(sourceAssetIds.values()).sort(),
    assetCount: Object.keys(assets).length,
  };
}

function summarizeSourceKinds(environment: Record<string, unknown>, robotAssetId: string, sceneAssetId: string) {
  const sourceHints = isObject(environment.sourceHints) ? environment.sourceHints : {};
  const assets = isObject(sourceHints.assets) ? (sourceHints.assets as Record<string, Record<string, unknown>>) : {};
  const robotAsset = assets[robotAssetId];
  const sceneAsset = assets[sceneAssetId];
  return {
    robot: toText(isObject(robotAsset) ? (robotAsset as Record<string, unknown>).kind : "", ""),
    scene: toText(isObject(sceneAsset) ? (sceneAsset as Record<string, unknown>).kind : "", ""),
    assetPipeline: toText(isObject(environment.assetPipeline) ? environment.assetPipeline.mode : "", ""),
  };
}

function buildSourcePipeline(environment: Record<string, unknown>) {
  return {
    robotAssetKind: toText(environment.robotAssetKind, ""),
    sceneAssetKind: toText(environment.sceneAssetKind, ""),
    assetPipelineMode: toText(isObject(environment.assetPipeline) ? environment.assetPipeline.mode : "", ""),
    placementSource: toText(environment.sourceOfTruth, "project_doc_environment_v1"),
  };
}

export function compileEditorSceneContract(input: {
  environment: Record<string, unknown>;
  profileId?: string;
  baseTaskId?: string;
  taskTemplate?: string;
  task?: string;
  generatedAt?: string;
}): EditorSceneContract {
  const environment = isObject(input.environment) ? input.environment : {};
  const snapshot = environment.snapshot;
  const placements = Array.isArray(environment.placements)
    ? (environment.placements as EditorScenePlacement[]).map((item) => cloneJson(item))
    : [];
  const robotAssetId = toText(environment.robotAssetId, "");
  const sceneAssetId = toText(environment.sceneAssetId, "");
  const primaryRobotEntityId = toText(
    (isObject(environment.controlPolicy) ? environment.controlPolicy.primaryRobotEntityId : undefined) ?? "",
    toText(isObject(environment.metadata) ? environment.metadata.primaryRobotEntityId : "", "")
  );
  const primaryRobotName = toText(
    isObject(environment.metadata) ? environment.metadata.primaryRobotSelection : "",
    ""
  );
  const sourceHints = isObject(environment.sourceHints) ? environment.sourceHints : {};
  const sourceAssets = isObject(sourceHints.assets) ? (sourceHints.assets as Record<string, Record<string, unknown>>) : {};
  const scenePreparation = isObject(environment.scenePreparation) ? environment.scenePreparation : {};
  const resolvedLaunchPlan = isObject(environment.resolvedLaunchPlan) ? environment.resolvedLaunchPlan : {};
  const effectiveScenePolicy = isObject(environment.effectiveScenePolicy) ? environment.effectiveScenePolicy : {};
  const scene = sceneAssetId || toText(scenePreparation.sceneAssetId, "");
  const sceneEntitiesSummary = summarizeSceneEntities(snapshot);
  const primaryRobotSourceAsset = sourceAssets[robotAssetId];
  return {
    contractVersion: "v1",
    profileId: toText(input.profileId, ""),
    baseTaskId: toText(input.baseTaskId, ""),
    taskTemplate: toText(input.taskTemplate, ""),
    task: toText(input.task, ""),
    robotAssetId,
    primaryRobot: {
      entityId: primaryRobotEntityId,
      name: primaryRobotName,
      assetId: robotAssetId,
      sourceKind: toText(isObject(primaryRobotSourceAsset) ? (primaryRobotSourceAsset as Record<string, unknown>).kind : "", ""),
    },
    sceneAssetId: scene || null,
    placements,
    terrain: {
      mode: toText(environment.terrainMode, ""),
      sourceKind: toText(environment.sceneTerrainType, toText(environment.sceneUsdTypeValue, "")),
      assetId: scene || "",
      entityCount: sceneEntitiesSummary.terrainCount,
    },
    sceneEntitiesSummary,
    sourceKinds: summarizeSourceKinds(environment, robotAssetId, scene),
    sourcePipeline: buildSourcePipeline(environment),
    resolvedLaunchPlan: cloneJson(resolvedLaunchPlan),
    effectiveScenePolicy: cloneJson(effectiveScenePolicy),
    sourceHints: cloneJson(sourceHints),
    scenePreparation: cloneJson(scenePreparation),
    sceneInjectionMode: toText(environment.sceneInjectionMode, ""),
    generatedAt: toText(input.generatedAt, new Date().toISOString()),
  };
}
