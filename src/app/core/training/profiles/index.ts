import type { TaskTemplateCatalogEntry } from "@runtime-plugins/catalog/types";

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
  registrationId: string;
  observableCount: number;
  actionCount: number;
  resetCount: number;
  terminationCount: number;
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
  const authoredProfileContract = template.authoredProfileContract && typeof template.authoredProfileContract === "object" && !Array.isArray(template.authoredProfileContract)
    ? (template.authoredProfileContract as Record<string, unknown>)
    : {};
  const toCount = (value: unknown) => (Array.isArray(value) ? value.length : 0);
  return {
    source: String(authoredProfileContract.sourceMode ?? template.profileSourceMode ?? "profile_example").trim() || "profile_example",
    registrationId: String(
      authoredProfileContract.registrationId ??
        template.registrationId ??
        template.environmentId ??
        template.id ??
        ""
    ).trim(),
    observableCount: toCount(authoredProfileContract.authoredObservables),
    actionCount: toCount(authoredProfileContract.authoredActions),
    resetCount: toCount(authoredProfileContract.authoredResets),
    terminationCount: toCount(authoredProfileContract.authoredTerminations),
  };
}
