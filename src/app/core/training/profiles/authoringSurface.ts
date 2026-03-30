type PlainRecord = Record<string, unknown>;

export type TrainingProfileAuthoringSurfaceCounts = {
  observables: number;
  actions: number;
  resets: number;
  terminations: number;
};

export type TrainingProfileAuthoringSurfaceDiagnostics =
  | "AUTHORING_SURFACE_MISSING_FROM_SELECTED_REGISTRATION"
  | "AUTHORING_SURFACE_EMPTY_FOR_EXAMPLE_PROFILE"
  | "AUTHORING_SURFACE_FIELD_MISMATCH";

export type TrainingProfileAuthoringSurfaceTrace = TrainingProfileAuthoringSurfaceCounts & {
  source: string;
  authoringSurfaceSource: "canonical_profile_catalog" | "compatibility_backfill" | "template_defaults";
  policyTermsStatus: string;
  sourceFilesUsed: string[];
  diagnostics: TrainingProfileAuthoringSurfaceDiagnostics[];
  complete: boolean;
};

export type TrainingProfileAuthoringSurfaceMaterialization = TrainingProfileAuthoringSurfaceTrace & {
  profileId: string;
  profileVersion: string | null;
  registrationId: string;
  baseTaskId: string | null;
  taskTemplate: string | null;
  task: string | null;
  sourceMode: "profile_example" | "scene_driven_generic" | "hybrid_profile_scene_driven";
  authoredObservables: Array<{ id: string; expr: string; enabled: boolean }>;
  authoredActions: Array<{ id: string; expr: string; enabled: boolean }>;
  authoredResets: Array<{ id: string; expr: string; enabled: boolean }>;
  authoredTerminations: Array<{ id: string; expr: string; enabled: boolean }>;
  canonicalCounts: TrainingProfileAuthoringSurfaceCounts;
};

type AuthoredRuleDraft = {
  id: string;
  expr: string;
  enabled: boolean;
};

type AuthoringSurfaceTemplate = {
  profileId?: string;
  profileVersion?: string;
  registrationId?: string;
  baseTaskId?: string;
  taskTemplate?: string;
  task?: string;
  profileSourceMode?: string;
  policyTermsStatus?: string;
  authoredProfileContract?: PlainRecord | null;
  authoringSurface?: {
    sourceFilesUsed?: unknown[];
    diagnostics?: unknown[];
    observableCount?: number;
    actionCount?: number;
    resetCount?: number;
    terminationCount?: number;
  } | null;
  sourceFilesUsed?: unknown[];
  defaults?: {
    environment?: {
      observables?: AuthoredRuleDraft[];
      actions?: AuthoredRuleDraft[];
      resets?: AuthoredRuleDraft[];
      terminations?: AuthoredRuleDraft[];
    };
  };
};

function asText(value: unknown, fallback = "") {
  if (typeof value !== "string") return fallback;
  const token = value.trim();
  return token.length > 0 ? token : fallback;
}

function isRecord(value: unknown): value is PlainRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function toTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asText(item, "")).filter((item) => item.length > 0);
}

function normalizeRuleList(
  primary: unknown,
  fallback: AuthoredRuleDraft[] = []
): AuthoredRuleDraft[] {
  const normalizedPrimary = normalizeRuleItems(primary);
  if (normalizedPrimary.length > 0) return normalizedPrimary;
  return normalizeRuleItems(fallback);
}

function normalizeRuleItems(items: unknown): AuthoredRuleDraft[] {
  if (!Array.isArray(items)) return [];
  const next: AuthoredRuleDraft[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const id = asText(item.id, "");
    const expr = asText(item.expr, "");
    if (!id || !expr) continue;
    next.push({
      id,
      expr,
      enabled: item.enabled !== false,
    });
  }
  return next;
}

function countRules(items: unknown): number {
  return normalizeRuleItems(items).length;
}

function normalizeSourceMode(value: unknown): TrainingProfileAuthoringSurfaceMaterialization["sourceMode"] {
  const token = asText(value, "");
  if (token === "scene_driven_generic" || token === "hybrid_profile_scene_driven") return token;
  return "profile_example";
}

function summarizeDiagnostics({
  profileId,
  sourceMode,
  explicitCounts,
  materializedCounts,
}: {
  profileId: string;
  sourceMode: TrainingProfileAuthoringSurfaceMaterialization["sourceMode"];
  explicitCounts: TrainingProfileAuthoringSurfaceCounts;
  materializedCounts: TrainingProfileAuthoringSurfaceCounts;
}): TrainingProfileAuthoringSurfaceDiagnostics[] {
  const diagnostics: TrainingProfileAuthoringSurfaceDiagnostics[] = [];
  const explicitSurfaceMissing =
    explicitCounts.observables === 0 &&
    explicitCounts.actions === 0 &&
    explicitCounts.resets === 0 &&
    explicitCounts.terminations === 0;
  const materializedSurfaceMissing =
    materializedCounts.observables === 0 &&
    materializedCounts.actions === 0 &&
    materializedCounts.resets === 0 &&
    materializedCounts.terminations === 0;

  if (explicitSurfaceMissing && !materializedSurfaceMissing) {
    diagnostics.push("AUTHORING_SURFACE_MISSING_FROM_SELECTED_REGISTRATION");
  } else if (materializedSurfaceMissing) {
    diagnostics.push(
      sourceMode === "profile_example" && profileId !== "generic"
        ? "AUTHORING_SURFACE_EMPTY_FOR_EXAMPLE_PROFILE"
        : "AUTHORING_SURFACE_FIELD_MISMATCH"
    );
  }

  return diagnostics;
}

function normalizeSourceFilesUsed(template: AuthoringSurfaceTemplate): string[] {
  const authoringSurfaceRecord = isRecord(template.authoringSurface) ? template.authoringSurface : {};
  return [
    ...toTextArray(authoringSurfaceRecord.sourceFilesUsed),
    ...toTextArray(template.sourceFilesUsed),
  ];
}

export function materializeTrainingProfileAuthoringSurface(
  template: AuthoringSurfaceTemplate
): TrainingProfileAuthoringSurfaceMaterialization {
  const authoredRecord = isRecord(template.authoredProfileContract) ? template.authoredProfileContract : {};
  const authoringSurfaceRecord = isRecord(template.authoringSurface) ? template.authoringSurface : {};
  const profileId = asText(authoredRecord.profileId, asText(template.profileId, ""));
  const profileVersion = asText(authoredRecord.profileVersion, asText(template.profileVersion, "")) || null;
  const registrationId = asText(
    authoredRecord.registrationId,
    asText(template.registrationId, template.registrationId ?? "")
  );
  const baseTaskId = asText(authoredRecord.baseTaskId, asText(template.baseTaskId, "")) || null;
  const taskTemplate = asText(authoredRecord.taskTemplate, asText(template.taskTemplate, "")) || null;
  const task = asText(authoredRecord.task, asText(template.task, "")) || null;
  const sourceMode = normalizeSourceMode(authoredRecord.sourceMode ?? template.profileSourceMode);
  const canonicalCounts: TrainingProfileAuthoringSurfaceCounts = {
    observables: countRules(authoredRecord.authoredObservables),
    actions: countRules(authoredRecord.authoredActions),
    resets: countRules(authoredRecord.authoredResets),
    terminations: countRules(authoredRecord.authoredTerminations),
  };
  const observables = normalizeRuleList(authoredRecord.authoredObservables, template.defaults?.environment?.observables ?? []);
  const actions = normalizeRuleList(authoredRecord.authoredActions, template.defaults?.environment?.actions ?? []);
  const resets = normalizeRuleList(authoredRecord.authoredResets, template.defaults?.environment?.resets ?? []);
  const terminations = normalizeRuleList(authoredRecord.authoredTerminations, template.defaults?.environment?.terminations ?? []);
  const materializedCounts: TrainingProfileAuthoringSurfaceCounts = {
    observables: observables.length,
    actions: actions.length,
    resets: resets.length,
    terminations: terminations.length,
  };
  const sourceFilesUsed = normalizeSourceFilesUsed(template);
  const authoringSurfaceSource =
    canonicalCounts.observables > 0 ||
    canonicalCounts.actions > 0 ||
    canonicalCounts.resets > 0 ||
    canonicalCounts.terminations > 0
      ? "canonical_profile_catalog"
      : (
            Number(authoringSurfaceRecord.observableCount ?? 0) > 0 ||
            Number(authoringSurfaceRecord.actionCount ?? 0) > 0 ||
            Number(authoringSurfaceRecord.resetCount ?? 0) > 0 ||
            Number(authoringSurfaceRecord.terminationCount ?? 0) > 0
          )
        ? "canonical_profile_catalog"
      : materializedCounts.observables > 0 ||
          materializedCounts.actions > 0 ||
          materializedCounts.resets > 0 ||
          materializedCounts.terminations > 0
        ? "compatibility_backfill"
        : "template_defaults";
  const diagnostics = summarizeDiagnostics({
    profileId,
    sourceMode,
    explicitCounts: canonicalCounts,
    materializedCounts,
  });

  return {
    source: authoringSurfaceSource,
    authoringSurfaceSource,
    policyTermsStatus: asText(template.policyTermsStatus, "none") || "none",
    sourceFilesUsed,
    diagnostics,
    observables: materializedCounts.observables,
    actions: materializedCounts.actions,
    resets: materializedCounts.resets,
    terminations: materializedCounts.terminations,
    complete:
      materializedCounts.observables > 0 &&
      materializedCounts.actions > 0 &&
      materializedCounts.resets > 0 &&
      materializedCounts.terminations > 0,
    profileId,
    profileVersion,
    registrationId,
    baseTaskId,
    taskTemplate,
    task,
    sourceMode,
    authoredObservables: cloneJson(observables),
    authoredActions: cloneJson(actions),
    authoredResets: cloneJson(resets),
    authoredTerminations: cloneJson(terminations),
    canonicalCounts,
  };
}
