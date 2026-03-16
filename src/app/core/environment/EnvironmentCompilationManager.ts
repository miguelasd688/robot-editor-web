import type {
  EnvironmentDiagnostic,
  EnvironmentDoc,
  ProjectDoc,
} from "../editor/document/types";
import { environmentDocumentManager } from "./EnvironmentDocumentManager";

export type EnvironmentCompilationTarget = "runtime" | "training";

export type EnvironmentCompilationStats = {
  robots: number;
  terrain: number;
  sceneAssets: number;
  entities: number;
  assets: number;
};

export type CompiledEnvironmentSnapshot = {
  sourceOfTruth: "project_doc_environment_v1";
  target: EnvironmentCompilationTarget;
  normalizedDoc: ProjectDoc;
  environment: EnvironmentDoc;
  diagnostics: EnvironmentDiagnostic[];
  stats: EnvironmentCompilationStats;
};

function cloneEnvironment(snapshot: EnvironmentDoc): EnvironmentDoc {
  return JSON.parse(JSON.stringify(snapshot)) as EnvironmentDoc;
}

function normalizeDiagnostics(value: unknown): EnvironmentDiagnostic[] {
  if (!Array.isArray(value)) return [];
  const diagnostics: EnvironmentDiagnostic[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const code = String(raw.code ?? "").trim();
    const message = String(raw.message ?? "").trim();
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

function mergeDiagnostics(...sources: Array<EnvironmentDiagnostic[]>): EnvironmentDiagnostic[] {
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

function buildStats(environment: EnvironmentDoc): EnvironmentCompilationStats {
  const entities = Object.values(environment.entities);
  return {
    robots: entities.filter((entity) => entity.kind === "robot").length,
    terrain: entities.filter((entity) => entity.kind === "terrain").length,
    sceneAssets: entities.filter((entity) => entity.kind === "scene_asset").length,
    entities: entities.length,
    assets: Object.keys(environment.assets).length,
  };
}

export class EnvironmentCompilationManager {
  compileProjectDoc(input: {
    doc: ProjectDoc;
    target?: EnvironmentCompilationTarget;
  }): CompiledEnvironmentSnapshot {
    const target = input.target ?? "runtime";
    const normalizedDoc = environmentDocumentManager.normalizeProjectDoc(input.doc);
    const environment = cloneEnvironment(normalizedDoc.environment);
    const baseDiagnostics = normalizeDiagnostics(environment.diagnostics);
    const stats = buildStats(environment);
    const targetDiagnostics: EnvironmentDiagnostic[] = [];

    if (target === "training" && stats.terrain <= 0) {
      targetDiagnostics.push({
        code: "ENV_TERRAIN_NOT_FOUND",
        severity: "warning",
        source: "training",
        message:
          "No floor/terrain was detected in the current environment snapshot. Training manager will not auto-instantiate a floor.",
        context: {
          terrainEntities: stats.terrain,
          sceneAssetEntities: stats.sceneAssets,
        },
      });
    }

    return {
      sourceOfTruth: "project_doc_environment_v1",
      target,
      normalizedDoc,
      environment,
      diagnostics: mergeDiagnostics(baseDiagnostics, targetDiagnostics),
      stats,
    };
  }
}

export const environmentCompilationManager = new EnvironmentCompilationManager();
