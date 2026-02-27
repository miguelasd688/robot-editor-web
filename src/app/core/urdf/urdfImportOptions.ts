export type UrdfImportOptions = {
  floatingBase?: boolean;
  firstLinkIsWorldReferenceFrame?: boolean;
  selfCollision?: boolean;
  collisionMode?: "mesh" | "box" | "sphere" | "cylinder" | "fast";
};

type UnknownRecord = Record<string, unknown>;

const URDF_COLLISION_MODE_SET = new Set(["mesh", "box", "sphere", "cylinder", "fast"]);

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function normalizeUrdfImportOptions(value: unknown): UrdfImportOptions | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const next: UrdfImportOptions = {};
  if (typeof record.floatingBase === "boolean") next.floatingBase = record.floatingBase;
  if (typeof record.firstLinkIsWorldReferenceFrame === "boolean") {
    next.firstLinkIsWorldReferenceFrame = record.firstLinkIsWorldReferenceFrame;
  }
  if (typeof record.selfCollision === "boolean") next.selfCollision = record.selfCollision;
  if (typeof record.collisionMode === "string" && URDF_COLLISION_MODE_SET.has(record.collisionMode)) {
    next.collisionMode = record.collisionMode as UrdfImportOptions["collisionMode"];
  }

  return Object.keys(next).length ? next : undefined;
}

export function resolveUrdfImportOptionsFromSources(input: {
  urdfImportOptions?: unknown;
  robotModelSource?: unknown;
}): UrdfImportOptions | undefined {
  const legacy = normalizeUrdfImportOptions(input.urdfImportOptions);
  const modelSource = asRecord(input.robotModelSource);
  const fromModel =
    modelSource?.kind === "urdf" ? normalizeUrdfImportOptions(modelSource.importOptions) : undefined;
  const merged = { ...(legacy ?? {}), ...(fromModel ?? {}) };
  return Object.keys(merged).length ? merged : undefined;
}
