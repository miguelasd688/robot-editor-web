import type { SubmitTrainingJobInput } from "../plugins/types";
import type { EnvironmentDiagnostic, EnvironmentDoc, ProjectDoc } from "../editor/document/types";
import { editorEngine } from "../editor/engineSingleton";
import { useTrainingImportContextStore } from "../store/useTrainingImportContextStore";
import { environmentCompilationManager } from "../environment/EnvironmentCompilationManager";

type CustomTrainingEnvironmentPayload = {
  id: string;
  sourceOfTruth: "project_doc_environment_v1";
  snapshot: EnvironmentDoc | null;
  robotAssetId?: string;
  sceneAssetId?: string;
  robotUsdKey?: string | null;
  terrainUsdKey?: string | null;
  terrainMode?: string;
  metadata?: Record<string, unknown>;
};

type CustomTrainingAgentPayload = {
  agentId?: string;
  trainer?: string;
  algorithm?: string;
  preset?: string;
  policy?: Record<string, unknown>;
  policyRules?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

type CustomTrainingRuntimePayload = {
  backend: "isaac_lab";
  maxSteps: number;
  numEnvs?: number;
  checkpoint?: number;
  stepsPerEpoch?: number;
  videoLengthSec?: number;
  videoLengthMs?: number;
  videoLength?: number;
  videoInterval?: number;
  baseConstraintMode?: "fix_base" | "source_weld";
  assetPipeline?: { mode: "usd_passthrough" | "mjcf_conversion"; reason?: string };
  extraArgs?: string[];
  recordingViews?: Record<string, unknown>;
  overrides?: Record<string, unknown>;
};

export type CustomTrainingTaskRequest = {
  tenantId?: string;
  experimentName: string;
  seed?: number;
  dryRun?: boolean;
  environment: CustomTrainingEnvironmentPayload;
  agent: CustomTrainingAgentPayload;
  runtime: CustomTrainingRuntimePayload;
};

export type CustomTrainingTaskBuildResult = {
  request: CustomTrainingTaskRequest;
  diagnostics: EnvironmentDiagnostic[];
};

function toObjectOrEmpty(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function toTextOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toPositiveIntOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(1, Math.round(parsed));
}

function toNonNegativeIntOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.round(parsed));
}

function toStringArrayOrUndefined(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const next = value.map((item) => String(item ?? "").trim()).filter((item) => item.length > 0);
  return next.length > 0 ? next : undefined;
}

function normalizeAssetPipelineOrUndefined(value: unknown): { mode: "usd_passthrough" | "mjcf_conversion"; reason?: string } | undefined {
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

function cloneEnvironmentSnapshot(snapshot: EnvironmentDoc | null): EnvironmentDoc | null {
  if (!snapshot) return null;
  return JSON.parse(JSON.stringify(snapshot)) as EnvironmentDoc;
}

function normalizeDiagnostics(value: unknown): EnvironmentDiagnostic[] {
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

export class IsaacLabEnvironmentManager {
  buildCustomTaskRequest(input: {
    submit: SubmitTrainingJobInput;
    config: Record<string, unknown>;
    doc?: ProjectDoc;
  }): CustomTrainingTaskBuildResult {
    const configValues = toObjectOrEmpty(input.config);
    const previewValues = toObjectOrEmpty(configValues.preview);
    const environmentValues = toObjectOrEmpty(configValues.environment);
    const context = useTrainingImportContextStore.getState();
    const compiled = environmentCompilationManager.compileProjectDoc({
      doc: input.doc ?? editorEngine.getDoc(),
      target: "training",
    });
    const diagnostics = mergeDiagnostics(
      normalizeDiagnostics(context.diagnostics),
      normalizeDiagnostics(compiled.diagnostics)
    );
    const experimentName =
      toTextOrEmpty(input.submit.experimentName) || toTextOrEmpty(configValues.experimentName) || input.submit.modelName || "custom-experiment";
    const maxSteps = Math.max(1, Math.round(input.submit.maxSteps ?? input.submit.epochs));
    const robotAssetId = toTextOrEmpty(configValues.robotAssetId);
    const sceneAssetId = toTextOrEmpty(configValues.sceneAssetId);
    const metadata = toObjectOrEmpty(configValues.userModelMetadata);
    const policy = toObjectOrEmpty(configValues.policy);
    const policyRules = toObjectOrEmpty(configValues.policyRules);
    const runtime: CustomTrainingRuntimePayload = {
      backend: "isaac_lab",
      maxSteps,
      numEnvs: toPositiveIntOrUndefined(configValues.numEnvs),
      checkpoint: toNonNegativeIntOrUndefined(configValues.checkpoint),
      stepsPerEpoch: toPositiveIntOrUndefined(configValues.stepsPerEpoch),
      videoLengthSec:
        toPositiveIntOrUndefined(previewValues.videoLengthSec) ??
        toPositiveIntOrUndefined(configValues.videoLengthSec),
      videoLengthMs: toPositiveIntOrUndefined(previewValues.videoLengthMs),
      videoLength: toPositiveIntOrUndefined(previewValues.videoLength),
      videoInterval: toPositiveIntOrUndefined(previewValues.videoInterval),
      baseConstraintMode:
        toTextOrEmpty(configValues.baseConstraintMode) === "fix_base"
          ? "fix_base"
          : toTextOrEmpty(configValues.baseConstraintMode) === "source_weld"
            ? "source_weld"
            : undefined,
      assetPipeline: normalizeAssetPipelineOrUndefined(configValues.assetPipeline),
      extraArgs: toStringArrayOrUndefined(configValues.extraArgs),
      recordingViews: toObjectOrEmpty(previewValues.recordingViews),
      overrides: toObjectOrEmpty(configValues.overrides),
    };

    const environment: CustomTrainingEnvironmentPayload = {
      id: toTextOrEmpty(input.submit.envId) || toTextOrEmpty(configValues.taskTemplate) || input.submit.dataset || "custom_environment",
      sourceOfTruth: "project_doc_environment_v1",
      snapshot: cloneEnvironmentSnapshot(compiled.environment),
      robotAssetId: robotAssetId || undefined,
      sceneAssetId: sceneAssetId || undefined,
      robotUsdKey: context.robotUsdKey,
      terrainUsdKey: context.terrainUsdKey,
      terrainMode: context.terrainMode,
      metadata: {
        ...metadata,
        ...environmentValues,
        compilationTarget: compiled.target,
        compilationStats: compiled.stats,
      },
    };

    const agent: CustomTrainingAgentPayload = {
      agentId: toTextOrEmpty(configValues.agentId) || undefined,
      trainer: toTextOrEmpty(policy.trainer) || undefined,
      algorithm: toTextOrEmpty(policy.algorithm) || undefined,
      preset: toTextOrEmpty(policy.preset) || undefined,
      policy: Object.keys(policy).length > 0 ? policy : undefined,
      policyRules: Object.keys(policyRules).length > 0 ? policyRules : undefined,
      metadata: toObjectOrEmpty(configValues.agent),
    };

    const request: CustomTrainingTaskRequest = {
      tenantId: input.submit.tenantId,
      experimentName,
      seed: Number.isInteger(input.submit.seed) ? input.submit.seed : undefined,
      environment,
      agent,
      runtime,
      dryRun: configValues.dryRun === true,
    };
    return {
      request,
      diagnostics,
    };
  }
}

export const isaacLabEnvironmentManager = new IsaacLabEnvironmentManager();
