import type { TaskTemplateCatalogEntry } from "@runtime-plugins/catalog/types";
import { materializeTrainingProfileAuthoringSurface } from "./authoringSurface";

export type TrainingProfileMetadata = {
  profileId: string;
  baseTaskId: string;
  registrationId: string;
  agentPresetId?: string;
  profileVersion: string;
  displayName: string;
  taskTemplate: string;
  task: string;
};

export type TrainingProfileAuthoredTrace = {
  source: string;
  authoringSurfaceSource: "canonical_profile_catalog" | "compatibility_backfill" | "template_defaults";
  profileId: string;
  registrationId: string;
  catalogVersion: string | null;
  policyTermsStatus: string;
  sourceFilesUsed: string[];
  observableCount: number;
  actionCount: number;
  resetCount: number;
  terminationCount: number;
  diagnostics: string[];
};

function normalizeToken(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function formatProfileCatalogName(displayName: string, profileId: string) {
  const trimmedDisplayName = String(displayName ?? "").trim();
  const cleanedDisplayName = trimmedDisplayName.replace(/\s+(sample|manager)$/i, "").trim();
  if (cleanedDisplayName) return cleanedDisplayName;
  const trimmedProfileId = String(profileId ?? "").trim();
  if (!trimmedProfileId) return "Profile";
  return trimmedProfileId
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase())
    .trim();
}

export function resolveProfileIdForTaskTemplate(template: Pick<TaskTemplateCatalogEntry, "modelId" | "taskTemplate">) {
  const modelId = normalizeToken(template.modelId);
  if (modelId) return modelId;
  const taskTemplate = normalizeToken(template.taskTemplate);
  if (!taskTemplate) return "generic";
  if (taskTemplate.endsWith("_manager")) return taskTemplate.replace(/_manager$/, "") || "generic";
  return taskTemplate;
}

export function resolveTrainingProfileMetadata(
  template: TaskTemplateCatalogEntry,
  agentPresetId?: string | null
): TrainingProfileMetadata {
  return {
    profileId: resolveProfileIdForTaskTemplate(template),
    baseTaskId: String(template.recipeId ?? template.id ?? "").trim(),
    registrationId: String(template.environmentId ?? template.id ?? template.recipeId ?? "").trim(),
    ...(String(agentPresetId ?? "").trim() ? { agentPresetId: String(agentPresetId ?? "").trim() } : {}),
    profileVersion: "v1",
    displayName:
      String(template.title ?? "").trim() ||
      formatProfileCatalogName(String(template.profileDisplayName ?? ""), String(template.modelId ?? "")) ||
      String(template.taskTemplate ?? "").trim() ||
      "Profile",
    taskTemplate: String(template.taskTemplate ?? "").trim(),
    task: String(template.task ?? "").trim(),
  };
}

export function buildTrainingProfileAuthoredTrace(
  template: TaskTemplateCatalogEntry
): TrainingProfileAuthoredTrace {
  const surface = materializeTrainingProfileAuthoringSurface(template);
  return {
    source: surface.source,
    authoringSurfaceSource: surface.authoringSurfaceSource,
    profileId: surface.profileId,
    registrationId: surface.registrationId,
    catalogVersion: surface.catalogVersion,
    policyTermsStatus: surface.policyTermsStatus,
    sourceFilesUsed: surface.sourceFilesUsed,
    observableCount: surface.observables,
    actionCount: surface.actions,
    resetCount: surface.resets,
    terminationCount: surface.terminations,
    diagnostics: surface.diagnostics,
  };
}
