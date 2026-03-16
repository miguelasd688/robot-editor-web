import { createEmptyEnvironmentDoc } from "../editor/document/factory";
import type {
  EnvironmentAsset,
  EnvironmentDiagnostic,
  EnvironmentDoc,
  EnvironmentEntity,
  EnvironmentEntityKind,
  ProjectDoc,
  RobotModelSource,
  SceneNode,
} from "../editor/document/types";

const DEFAULT_ENV_DIAGNOSTICS_SOURCE = "document" as const;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function safeArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? "").trim())
    .filter((item) => item.length > 0);
}

function mapNodeKindToEnvironmentKind(kind: SceneNode["kind"]): EnvironmentEntityKind {
  if (kind === "robot") return "robot";
  if (kind === "floor") return "terrain";
  if (kind === "joint" || kind === "link" || kind === "mesh" || kind === "visual" || kind === "collision") {
    return "prop";
  }
  return "unknown";
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

function createEntityFromNode(node: SceneNode, sourceAssetId: string | null): EnvironmentEntity {
  return {
    id: node.id,
    nodeId: node.id,
    name: node.name,
    kind: mapNodeKindToEnvironmentKind(node.kind),
    parentId: node.parentId ?? null,
    children: safeArray(node.children),
    sourceAssetId,
    transform: node.components?.transform,
    physics: node.components?.physics,
    physicsFields: node.components?.physicsFields,
    robotModelSource: node.components?.robotModelSource,
    urdfImportOptions: node.components?.urdfImportOptions,
    tags: node.kind === "robot" ? ["robot"] : undefined,
  };
}

function normalizeDiagnostics(value: unknown): EnvironmentDiagnostic[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const raw = asRecord(item);
      const code = String(raw.code ?? "").trim();
      const message = String(raw.message ?? "").trim();
      const severityToken = String(raw.severity ?? "warning").trim().toLowerCase();
      const sourceToken = String(raw.source ?? DEFAULT_ENV_DIAGNOSTICS_SOURCE).trim().toLowerCase();
      if (!code || !message) return null;
      const severity = severityToken === "error" ? "error" : "warning";
      const source =
        sourceToken === "import" ||
        sourceToken === "simulation" ||
        sourceToken === "training" ||
        sourceToken === "document"
          ? sourceToken
          : DEFAULT_ENV_DIAGNOSTICS_SOURCE;
      return {
        code,
        message,
        severity,
        source,
        context: asRecord(raw.context),
      } satisfies EnvironmentDiagnostic;
    })
    .filter((item): item is EnvironmentDiagnostic => Boolean(item));
}

function buildDocumentDiagnostics(doc: ProjectDoc): EnvironmentDiagnostic[] {
  const nodes = Object.values(doc.scene.nodes);
  const hasRobot = nodes.some((node) => node.kind === "robot");
  const diagnostics: EnvironmentDiagnostic[] = [];
  if (!hasRobot) {
    diagnostics.push({
      code: "ENV_NO_ROBOT",
      severity: "warning",
      source: DEFAULT_ENV_DIAGNOSTICS_SOURCE,
      message: "Environment has no robot root. Simulation/training managers may be limited.",
    });
  }
  if (doc.scene.roots.length === 0) {
    diagnostics.push({
      code: "ENV_EMPTY_SCENE",
      severity: "warning",
      source: DEFAULT_ENV_DIAGNOSTICS_SOURCE,
      message: "Environment scene is empty.",
    });
  }
  return diagnostics;
}

function buildEnvironmentFromProjectDoc(doc: ProjectDoc, previous?: EnvironmentDoc): EnvironmentDoc {
  const assets: Record<string, EnvironmentAsset> = {};
  const entities: Record<string, EnvironmentEntity> = {};

  for (const node of Object.values(doc.scene.nodes)) {
    let sourceAssetId: string | null = null;
    if (node.kind === "robot") {
      const assetId = `asset:${node.id}`;
      const sourceAsset = createAssetFromRobotModelSource(
        assetId,
        node.components?.robotModelSource,
        node.components?.urdfImportOptions
      );
      if (sourceAsset) {
        assets[assetId] = sourceAsset;
        sourceAssetId = assetId;
      }
    }
    entities[node.id] = createEntityFromNode(node, sourceAssetId);
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
  const documentDiagnostics = buildDocumentDiagnostics(doc);
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
