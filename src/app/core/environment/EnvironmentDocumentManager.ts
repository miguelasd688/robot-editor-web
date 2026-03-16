import { createEmptyEnvironmentDoc } from "../editor/document/factory";
import type {
  EnvironmentAsset,
  EnvironmentDiagnostic,
  EnvironmentDoc,
  EnvironmentEntity,
  EnvironmentEntityKind,
  EnvironmentSourceRole,
  ProjectDoc,
  RobotModelSource,
  SceneAssetSource,
  SceneNode,
} from "../editor/document/types";

const DEFAULT_ENV_DIAGNOSTICS_SOURCE = "document" as const;
const TERRAIN_NAME_RE = /(floor|ground|terrain|rough)/i;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function toOptionalText(value: unknown): string | null {
  const token = String(value ?? "").trim();
  return token.length > 0 ? token : null;
}

function safeArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? "").trim())
    .filter((item) => item.length > 0);
}

function mapBaseNodeKind(kind: SceneNode["kind"]): EnvironmentEntityKind {
  if (kind === "robot") return "robot";
  if (kind === "camera") return "camera";
  if (kind === "light") return "light";
  if (
    kind === "group" ||
    kind === "joint" ||
    kind === "link" ||
    kind === "mesh" ||
    kind === "visual" ||
    kind === "collision"
  ) {
    return "prop";
  }
  return "unknown";
}

function roleFromEntityKind(kind: EnvironmentEntityKind): EnvironmentSourceRole | undefined {
  if (kind === "robot") return "robot";
  if (kind === "scene_asset") return "scene_asset";
  if (kind === "terrain") return "terrain";
  return undefined;
}

function hasPrimitivePlaneSource(node: SceneNode): boolean {
  return node.source?.kind === "primitive" && node.source.shape === "plane";
}

function isTerrainLikeNode(node: SceneNode): boolean {
  if (hasPrimitivePlaneSource(node)) return true;
  return TERRAIN_NAME_RE.test(String(node.name ?? "").trim());
}

function isTerrainChainNodeKind(kind: SceneNode["kind"]): boolean {
  return (
    kind === "group" ||
    kind === "link" ||
    kind === "visual" ||
    kind === "collision" ||
    kind === "mesh"
  );
}

function classifyNodeKind(input: {
  nodeId: string;
  nodesById: Record<string, SceneNode>;
  memo: Map<string, EnvironmentEntityKind>;
  visiting: Set<string>;
}): EnvironmentEntityKind {
  const cached = input.memo.get(input.nodeId);
  if (cached) return cached;
  if (input.visiting.has(input.nodeId)) return "unknown";
  input.visiting.add(input.nodeId);

  const node = input.nodesById[input.nodeId];
  if (!node) {
    input.memo.set(input.nodeId, "unknown");
    input.visiting.delete(input.nodeId);
    return "unknown";
  }

  const sceneSourceRole = String(node.components?.sceneAssetSource?.role ?? "").trim().toLowerCase();
  if (sceneSourceRole === "terrain") {
    input.memo.set(input.nodeId, "terrain");
    input.visiting.delete(input.nodeId);
    return "terrain";
  }
  if (sceneSourceRole === "scene_asset") {
    input.memo.set(input.nodeId, "scene_asset");
    input.visiting.delete(input.nodeId);
    return "scene_asset";
  }

  if (node.kind === "robot") {
    input.memo.set(input.nodeId, "robot");
    input.visiting.delete(input.nodeId);
    return "robot";
  }

  if (node.kind === "mesh" && isTerrainLikeNode(node)) {
    input.memo.set(input.nodeId, "terrain");
    input.visiting.delete(input.nodeId);
    return "terrain";
  }

  const parentId = toOptionalText(node.parentId);
  if (parentId) {
    const parentKind = classifyNodeKind({
      nodeId: parentId,
      nodesById: input.nodesById,
      memo: input.memo,
      visiting: input.visiting,
    });
    if (parentKind === "terrain" && isTerrainChainNodeKind(node.kind)) {
      input.memo.set(input.nodeId, "terrain");
      input.visiting.delete(input.nodeId);
      return "terrain";
    }
    if (parentKind === "scene_asset") {
      input.memo.set(input.nodeId, "scene_asset");
      input.visiting.delete(input.nodeId);
      return "scene_asset";
    }
  }

  const fallback = mapBaseNodeKind(node.kind);
  input.memo.set(input.nodeId, fallback);
  input.visiting.delete(input.nodeId);
  return fallback;
}

function createAssetFromRobotModelSource(
  assetId: string,
  modelSource: RobotModelSource | undefined,
  fallbackUrdfImportOptions: unknown
): EnvironmentAsset | null {
  if (!modelSource) return null;
  if (modelSource.kind === "urdf") {
    return {
      id: assetId,
      kind: "urdf",
      role: "robot",
      workspaceKey: modelSource.key ?? null,
      inlineSource: modelSource.source ?? null,
      importOptions: asRecord(modelSource.importOptions ?? fallbackUrdfImportOptions),
      metadata: {
        modelKind: "urdf",
      },
    };
  }

  if (modelSource.kind === "usd") {
    return {
      id: assetId,
      kind: "usd",
      role: "robot",
      workspaceKey: modelSource.workspaceKey ?? modelSource.usdKey ?? null,
      converterAssetId: modelSource.converterAssetId ?? null,
      trainingAssetId: modelSource.trainingAssetId ?? null,
      importOptions: asRecord(modelSource.importOptions ?? null),
      metadata: {
        modelKind: "usd",
        mjcfKey: modelSource.mjcfKey ?? null,
        isDirty: modelSource.isDirty === true,
      },
    };
  }
  return null;
}

function createAssetFromSceneAssetSource(assetId: string, source: SceneAssetSource | undefined): EnvironmentAsset | null {
  if (!source) return null;
  const kind = source.kind === "usd" || source.kind === "mjcf" || source.kind === "mesh" || source.kind === "generated"
    ? source.kind
    : "generated";
  return {
    id: assetId,
    kind,
    role: source.role,
    workspaceKey: source.workspaceKey ?? null,
    converterAssetId: source.converterAssetId ?? null,
    trainingAssetId: source.trainingAssetId ?? null,
    importOptions: asOptionalRecord(source.importOptions ?? null) ?? null,
    metadata: {
      ...(asOptionalRecord(source.metadata) ?? {}),
      sourceKind: source.kind,
      sourceUrl: source.sourceUrl ?? null,
    },
  };
}

function createGeneratedTerrainAsset(assetId: string, node: SceneNode): EnvironmentAsset {
  return {
    id: assetId,
    kind: "generated",
    role: "terrain",
    metadata: {
      generatedFrom: "scene_primitive",
      nodeId: node.id,
      nodeName: node.name,
      primitiveShape: node.source?.kind === "primitive" ? node.source.shape : null,
    },
  };
}

function createEntityFromNode(
  node: SceneNode,
  kind: EnvironmentEntityKind,
  sourceAssetId: string | null
): EnvironmentEntity {
  return {
    id: node.id,
    nodeId: node.id,
    name: node.name,
    kind,
    sourceRole: roleFromEntityKind(kind),
    parentId: node.parentId ?? null,
    children: safeArray(node.children),
    sourceAssetId,
    transform: node.components?.transform,
    physics: node.components?.physics,
    physicsFields: node.components?.physicsFields,
    robotModelSource: node.components?.robotModelSource,
    urdfImportOptions: node.components?.urdfImportOptions,
    tags: node.kind === "robot" ? ["robot"] : undefined,
    metadata: node.components?.sceneAssetSource
      ? {
          sceneAssetSource: {
            ...node.components.sceneAssetSource,
          },
        }
      : undefined,
  };
}

function normalizeDiagnostics(value: unknown): EnvironmentDiagnostic[] {
  if (!Array.isArray(value)) return [];
  const diagnostics: EnvironmentDiagnostic[] = [];
  for (const item of value) {
    const raw = asRecord(item);
    const code = String(raw.code ?? "").trim();
    const message = String(raw.message ?? "").trim();
    const severityToken = String(raw.severity ?? "warning").trim().toLowerCase();
    const sourceToken = String(raw.source ?? DEFAULT_ENV_DIAGNOSTICS_SOURCE).trim().toLowerCase();
    if (!code || !message) continue;
    const severity = severityToken === "error" ? "error" : "warning";
    const source =
      sourceToken === "import" ||
      sourceToken === "simulation" ||
      sourceToken === "training" ||
      sourceToken === "document"
        ? sourceToken
        : DEFAULT_ENV_DIAGNOSTICS_SOURCE;
    const diagnostic: EnvironmentDiagnostic = {
      code,
      message,
      severity,
      source,
    };
    const context = asOptionalRecord(raw.context);
    if (context) diagnostic.context = context;
    diagnostics.push(diagnostic);
  }
  return diagnostics;
}

function buildDocumentDiagnostics(input: {
  doc: ProjectDoc;
  assets: Record<string, EnvironmentAsset>;
  entities: Record<string, EnvironmentEntity>;
}): EnvironmentDiagnostic[] {
  const diagnostics: EnvironmentDiagnostic[] = [];
  const nodes = Object.values(input.doc.scene.nodes);
  const hasRobot = nodes.some((node) => node.kind === "robot");
  if (!hasRobot) {
    diagnostics.push({
      code: "ENV_NO_ROBOT",
      severity: "warning",
      source: DEFAULT_ENV_DIAGNOSTICS_SOURCE,
      message: "Environment has no robot root. Simulation/training managers may be limited.",
    });
  }
  if (input.doc.scene.roots.length === 0) {
    diagnostics.push({
      code: "ENV_EMPTY_SCENE",
      severity: "warning",
      source: DEFAULT_ENV_DIAGNOSTICS_SOURCE,
      message: "Environment scene is empty.",
    });
  }

  const seen = new Set<string>();
  const pushOnce = (diagnostic: EnvironmentDiagnostic) => {
    const key = `${diagnostic.code}|${diagnostic.severity}|${diagnostic.message}|${JSON.stringify(diagnostic.context ?? {})}`;
    if (seen.has(key)) return;
    seen.add(key);
    diagnostics.push(diagnostic);
  };

  for (const entity of Object.values(input.entities)) {
    if (entity.kind !== "terrain" && entity.kind !== "scene_asset") continue;
    const parent = entity.parentId ? input.entities[entity.parentId] : null;
    const isNestedSameKind = parent?.kind === entity.kind;
    if (isNestedSameKind) continue;
    if (!entity.sourceAssetId) {
      pushOnce({
        code: entity.kind === "terrain" ? "ENV_TERRAIN_SOURCE_MISSING" : "ENV_SCENE_ASSET_SOURCE_MISSING",
        severity: "warning",
        source: DEFAULT_ENV_DIAGNOSTICS_SOURCE,
        message:
          entity.kind === "terrain"
            ? "Terrain entity has no source metadata. Runtime/training may not reconstruct this terrain deterministically."
            : "Scene asset entity has no source metadata. Runtime/training may not reconstruct this scene bundle deterministically.",
        context: {
          entityId: entity.id,
          nodeId: entity.nodeId ?? null,
          name: entity.name,
          kind: entity.kind,
        },
      });
      continue;
    }
    const sourceAsset = input.assets[entity.sourceAssetId];
    if (!sourceAsset) {
      pushOnce({
        code: "ENV_ENTITY_SOURCE_ASSET_MISSING",
        severity: "error",
        source: DEFAULT_ENV_DIAGNOSTICS_SOURCE,
        message: "Entity references a missing source asset.",
        context: {
          entityId: entity.id,
          sourceAssetId: entity.sourceAssetId,
          kind: entity.kind,
        },
      });
    }
  }

  for (const asset of Object.values(input.assets)) {
    if ((asset.role === "scene_asset" || asset.role === "terrain") && asset.kind === "usd") {
      const hasWorkspaceKey = String(asset.workspaceKey ?? "").trim().length > 0;
      const hasConverterAssetId = String(asset.converterAssetId ?? "").trim().length > 0;
      if (!hasWorkspaceKey && !hasConverterAssetId) {
        pushOnce({
          code: "ENV_SCENE_USD_SOURCE_MISSING",
          severity: "warning",
          source: DEFAULT_ENV_DIAGNOSTICS_SOURCE,
          message: "USD scene/terrain asset is missing workspaceKey and converterAssetId.",
          context: {
            assetId: asset.id,
            role: asset.role,
          },
        });
      }
    }
  }

  return diagnostics;
}

function buildEnvironmentFromProjectDoc(doc: ProjectDoc, previous?: EnvironmentDoc): EnvironmentDoc {
  const assets: Record<string, EnvironmentAsset> = {};
  const entities: Record<string, EnvironmentEntity> = {};
  const directSourceAssetIdByNode = new Map<string, string>();
  const kindMemo = new Map<string, EnvironmentEntityKind>();
  const nodesById = doc.scene.nodes;

  for (const nodeId of Object.keys(nodesById)) {
    classifyNodeKind({
      nodeId,
      nodesById,
      memo: kindMemo,
      visiting: new Set<string>(),
    });
  }

  for (const node of Object.values(nodesById)) {
    const assetId = `asset:${node.id}`;
    if (node.kind === "robot") {
      const sourceAsset = createAssetFromRobotModelSource(
        assetId,
        node.components?.robotModelSource,
        node.components?.urdfImportOptions
      );
      if (sourceAsset) {
        assets[assetId] = sourceAsset;
        directSourceAssetIdByNode.set(node.id, assetId);
      }
      continue;
    }

    const sceneSource = node.components?.sceneAssetSource;
    if (sceneSource) {
      const sourceAsset = createAssetFromSceneAssetSource(assetId, sceneSource);
      if (sourceAsset) {
        assets[assetId] = sourceAsset;
        directSourceAssetIdByNode.set(node.id, assetId);
      }
      continue;
    }

    const nodeKind = kindMemo.get(node.id) ?? mapBaseNodeKind(node.kind);
    const parentKind = node.parentId ? kindMemo.get(node.parentId) : undefined;
    const isTerrainRoot = nodeKind === "terrain" && parentKind !== "terrain";
    if (isTerrainRoot) {
      assets[assetId] = createGeneratedTerrainAsset(assetId, node);
      directSourceAssetIdByNode.set(node.id, assetId);
    }
  }

  const visited = new Set<string>();
  const visitNode = (nodeId: string, inheritedSourceAssetId: string | null) => {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const node = nodesById[nodeId];
    if (!node) return;

    const kind = kindMemo.get(nodeId) ?? mapBaseNodeKind(node.kind);
    const directAssetId = directSourceAssetIdByNode.get(nodeId) ?? null;
    const sourceAssetId =
      directAssetId ?? ((kind === "terrain" || kind === "scene_asset") ? inheritedSourceAssetId : null);

    entities[node.id] = createEntityFromNode(node, kind, sourceAssetId);

    const nextInheritedSourceAssetId =
      sourceAssetId && (kind === "terrain" || kind === "scene_asset") ? sourceAssetId : null;
    for (const childId of safeArray(node.children)) {
      visitNode(childId, nextInheritedSourceAssetId);
    }
  };

  for (const rootId of safeArray(doc.scene.roots)) {
    visitNode(rootId, null);
  }
  for (const nodeId of Object.keys(nodesById)) {
    if (!visited.has(nodeId)) visitNode(nodeId, null);
  }

  const legacySources = asRecord(doc.sources);
  const legacyUrdf = String(legacySources.urdf ?? "").trim();
  if (legacyUrdf) {
    assets["legacy:project:urdf"] = {
      id: "legacy:project:urdf",
      kind: "urdf",
      workspaceKey: legacyUrdf,
      metadata: { legacyProjectSource: true },
    };
  }
  const legacyMjcf = String(legacySources.mjcf ?? "").trim();
  if (legacyMjcf) {
    assets["legacy:project:mjcf"] = {
      id: "legacy:project:mjcf",
      kind: "mjcf",
      workspaceKey: legacyMjcf,
      metadata: { legacyProjectSource: true },
    };
  }
  const legacyUsd = String(legacySources.usd ?? "").trim();
  if (legacyUsd) {
    assets["legacy:project:usd"] = {
      id: "legacy:project:usd",
      kind: "usd",
      workspaceKey: legacyUsd,
      metadata: { legacyProjectSource: true },
    };
  }

  const preservedDiagnostics = normalizeDiagnostics(previous?.diagnostics).filter(
    (item) => item.source !== DEFAULT_ENV_DIAGNOSTICS_SOURCE
  );
  const documentDiagnostics = buildDocumentDiagnostics({ doc, assets, entities });
  const previousSimulation = previous?.simulation;
  const simulation = {
    gravity:
      Array.isArray(previousSimulation?.gravity) && previousSimulation.gravity.length === 3
        ? (previousSimulation.gravity as [number, number, number])
        : ([0, 0, -9.81] as [number, number, number]),
    timestep:
      typeof previousSimulation?.timestep === "number" && Number.isFinite(previousSimulation.timestep)
        ? previousSimulation.timestep
        : 0.002,
    substeps:
      typeof previousSimulation?.substeps === "number" && Number.isFinite(previousSimulation.substeps)
        ? Math.max(1, Math.round(previousSimulation.substeps))
        : 1,
    solver:
      previousSimulation?.solver === "pgs" ||
      previousSimulation?.solver === "cg" ||
      previousSimulation?.solver === "newton" ||
      previousSimulation?.solver === "auto"
        ? previousSimulation.solver
        : "auto",
    contactModel:
      previousSimulation?.contactModel === "pyramidal" ||
      previousSimulation?.contactModel === "elliptic" ||
      previousSimulation?.contactModel === "auto"
        ? previousSimulation.contactModel
        : "auto",
  };

  return {
    version: 1,
    assets,
    entities,
    roots: safeArray(doc.scene.roots).filter((rootId) => Boolean(entities[rootId])),
    simulation,
    trainingHints: previous?.trainingHints,
    diagnostics: [...preservedDiagnostics, ...documentDiagnostics],
    updatedAt: doc.metadata?.updatedAt ?? new Date().toISOString(),
  };
}

function hasSameEnvironment(a: EnvironmentDoc | undefined, b: EnvironmentDoc): boolean {
  if (!a) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export class EnvironmentDocumentManager {
  normalizeProjectDoc(doc: ProjectDoc): ProjectDoc {
    const nextEnvironment = buildEnvironmentFromProjectDoc(doc, doc.environment);
    const alreadyNormalized = doc.version === 2 && hasSameEnvironment(doc.environment, nextEnvironment);
    if (alreadyNormalized) return doc;
    return {
      ...doc,
      version: 2,
      sources: doc.sources ?? {},
      environment: nextEnvironment,
    };
  }

  getEnvironment(doc: ProjectDoc): EnvironmentDoc {
    if (doc.version === 2 && doc.environment) {
      return this.normalizeProjectDoc(doc).environment;
    }
    return buildEnvironmentFromProjectDoc(
      {
        ...doc,
        version: doc.version ?? 1,
        sources: doc.sources ?? {},
        environment: doc.environment ?? createEmptyEnvironmentDoc(),
      },
      doc.environment
    );
  }

  withDiagnostics(doc: ProjectDoc, diagnostics: EnvironmentDiagnostic[]): ProjectDoc {
    const normalized = this.normalizeProjectDoc(doc);
    const merged = {
      ...normalized.environment,
      diagnostics: normalizeDiagnostics(diagnostics),
      updatedAt: normalized.metadata?.updatedAt ?? new Date().toISOString(),
    };
    return {
      ...normalized,
      environment: merged,
    };
  }

  buildImportDiagnostic(input: {
    code: string;
    severity?: EnvironmentDiagnostic["severity"];
    message: string;
    source?: EnvironmentDiagnostic["source"];
    context?: Record<string, unknown>;
  }): EnvironmentDiagnostic {
    return {
      code: String(input.code ?? "").trim() || "ENV_IMPORT_DIAGNOSTIC",
      severity: input.severity === "error" ? "error" : "warning",
      source: input.source ?? "import",
      message: String(input.message ?? "").trim() || "Import diagnostic",
      context: input.context,
    };
  }
}

export const environmentDocumentManager = new EnvironmentDocumentManager();
