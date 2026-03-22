import type { TaskTemplateCatalogEntry } from "@runtime-plugins/catalog/types";

export type TrainingProfileMetadata = {
  profileId: string;
  baseTaskId: string;
  agentPresetId?: string;
  profileVersion: string;
  displayName: string;
  taskTemplate: string;
  task: string;
};

function normalizeToken(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
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
    ...(String(agentPresetId ?? "").trim() ? { agentPresetId: String(agentPresetId ?? "").trim() } : {}),
    profileVersion: "v1",
    displayName: String(template.title ?? "").trim() || String(template.taskTemplate ?? "").trim() || "Profile",
    taskTemplate: String(template.taskTemplate ?? "").trim(),
    task: String(template.task ?? "").trim(),
  };
}
