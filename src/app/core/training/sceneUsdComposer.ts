import type { AssetEntry } from "../assets/assetRegistryTypes";
import type { EnvironmentDiagnostic, EnvironmentDoc, EnvironmentEntity, Transform } from "../editor/document/types";
import { createAssetResolver } from "../loaders/assetResolver";
import { uploadUsdTrainingAssetRemote, type TrainingUsdBundleFileInput } from "../services/trainingApiClient";
import { collectUsdBundleFiles, type CollectedUsdBundleFile } from "../usd/usdBundleCollector";

type SceneSourceRole = "terrain" | "scene_asset";

export type SceneCompositionNode = {
  entityId: string;
  name: string;
  role: SceneSourceRole;
  sourceAssetId: string;
  workspaceKey: string;
  transform: Transform;
};

export type SceneCompositionSource = {
  sourceAssetId: string;
  workspaceKey: string;
  alias: string;
};

export type SceneCompositionPlan = {
  nodes: SceneCompositionNode[];
  sources: SceneCompositionSource[];
  diagnostics: EnvironmentDiagnostic[];
};

export type SceneCompositionUploadResult = {
  sceneAssetId: string;
  entryPath: string;
  diagnostics: EnvironmentDiagnostic[];
  sourceCount: number;
  entityCount: number;
  signature: string;
};

const SOURCE_DIAGNOSTIC = "training" as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTransform(raw: unknown): Transform {
  const record = isRecord(raw) ? raw : {};
  const positionRaw = isRecord(record.position) ? record.position : {};
  const rotationRaw = isRecord(record.rotation) ? record.rotation : {};
  const scaleRaw = isRecord(record.scale) ? record.scale : {};
  return {
    position: {
      x: toNumber(positionRaw.x, 0),
      y: toNumber(positionRaw.y, 0),
      z: toNumber(positionRaw.z, 0),
    },
    rotation: {
      x: toNumber(rotationRaw.x, 0),
      y: toNumber(rotationRaw.y, 0),
      z: toNumber(rotationRaw.z, 0),
    },
    scale: {
      x: toNumber(scaleRaw.x, 1),
      y: toNumber(scaleRaw.y, 1),
      z: toNumber(scaleRaw.z, 1),
    },
  };
}

function normalizeIdentifier(value: string, fallback: string) {
  const normalized = value.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!normalized) return fallback;
  if (!/^[A-Za-z_]/.test(normalized)) return `_${normalized}`;
  return normalized;
}

function normalizePathToken(value: string) {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function hasSceneRole(kind: unknown): kind is SceneSourceRole {
  return kind === "terrain" || kind === "scene_asset";
}

function isTopLevelSceneEntity(entity: EnvironmentEntity, allEntities: Record<string, EnvironmentEntity>) {
  if (!hasSceneRole(entity.kind)) return false;
  const parent = entity.parentId ? allEntities[entity.parentId] : null;
  if (!parent || !hasSceneRole(parent.kind)) return true;
  const parentSource = toText(parent.sourceAssetId ?? "");
  const selfSource = toText(entity.sourceAssetId ?? "");
  return parentSource !== selfSource;
}

function pushDiagnostic(
  diagnostics: EnvironmentDiagnostic[],
  diagnostic: EnvironmentDiagnostic
) {
  diagnostics.push(diagnostic);
}

export function buildSceneCompositionPlan(environment: EnvironmentDoc): SceneCompositionPlan {
  const diagnostics: EnvironmentDiagnostic[] = [];
  const assets = isRecord(environment.assets) ? environment.assets : {};
  const entities = isRecord(environment.entities) ? environment.entities : {};
  const nodes: SceneCompositionNode[] = [];
  const sourceByAssetId = new Map<string, SceneCompositionSource>();
  const sourceCountByWorkspace = new Map<string, number>();

  for (const rawEntity of Object.values(entities)) {
    if (!isRecord(rawEntity)) continue;
    const entity = rawEntity as unknown as EnvironmentEntity;
    if (!isTopLevelSceneEntity(entity, entities as Record<string, EnvironmentEntity>)) continue;
    if (!hasSceneRole(entity.kind)) continue;

    const sourceAssetId = toText(entity.sourceAssetId ?? "");
    if (!sourceAssetId) {
      pushDiagnostic(diagnostics, {
        code: "CUSTOM_ENV_SCENE_SOURCE_MISSING",
        severity: "error",
        source: SOURCE_DIAGNOSTIC,
        message: "Scene entity is missing sourceAssetId.",
        context: {
          entityId: entity.id,
          name: entity.name,
          kind: entity.kind,
        },
      });
      continue;
    }

    const sourceAssetRaw = isRecord(assets[sourceAssetId]) ? assets[sourceAssetId] : null;
    if (!sourceAssetRaw) {
      pushDiagnostic(diagnostics, {
        code: "CUSTOM_ENV_SCENE_SOURCE_ASSET_MISSING",
        severity: "error",
        source: SOURCE_DIAGNOSTIC,
        message: "Scene entity source asset is missing in environment snapshot.",
        context: {
          entityId: entity.id,
          sourceAssetId,
        },
      });
      continue;
    }

    const sourceRole = toText(sourceAssetRaw.role).toLowerCase();
    if (sourceRole === "robot") {
      continue;
    }

    const sourceKind = toText(sourceAssetRaw.kind).toLowerCase();
    if (sourceKind !== "usd") {
      const isGeneratedSource = sourceKind === "generated";
      pushDiagnostic(diagnostics, {
        code: isGeneratedSource ? "CUSTOM_ENV_SCENE_SOURCE_DEFERRED" : "CUSTOM_ENV_SCENE_SOURCE_UNSUPPORTED",
        severity: isGeneratedSource ? "warning" : "error",
        source: SOURCE_DIAGNOSTIC,
        message: isGeneratedSource
          ? "Generated scene source is deferred to backend scene preparation/runtime compatibility checks."
          : `Scene source kind '${sourceKind || "unknown"}' is not supported for Isaac Lab scene composition.`,
        context: {
          entityId: entity.id,
          sourceAssetId,
          sourceKind: sourceKind || null,
          role: entity.kind,
        },
      });
      continue;
    }

    const workspaceKey = toText(sourceAssetRaw.workspaceKey);
    if (!workspaceKey) {
      pushDiagnostic(diagnostics, {
        code: "CUSTOM_ENV_SCENE_WORKSPACE_KEY_MISSING",
        severity: "error",
        source: SOURCE_DIAGNOSTIC,
        message: "USD scene source is missing workspaceKey, cannot compose bundle.",
        context: {
          entityId: entity.id,
          sourceAssetId,
          role: entity.kind,
        },
      });
      continue;
    }

    const normalizedWorkspace = normalizePathToken(workspaceKey);
    const existingCount = sourceCountByWorkspace.get(normalizedWorkspace) ?? 0;
    sourceCountByWorkspace.set(normalizedWorkspace, existingCount + 1);
    if (sourceByAssetId.has(sourceAssetId)) {
      const existing = sourceByAssetId.get(sourceAssetId) as SceneCompositionSource;
      nodes.push({
        entityId: toText(entity.id),
        name: toText(entity.name) || toText(entity.id),
        role: entity.kind,
        sourceAssetId,
        workspaceKey: existing.workspaceKey,
        transform: normalizeTransform(entity.transform),
      });
      continue;
    }

    const aliasBase =
      normalizeIdentifier(toText(entity.name) || toText(entity.id) || sourceAssetId, "scene_asset") +
      `_${sourceByAssetId.size + 1}`;
    const source: SceneCompositionSource = {
      sourceAssetId,
      workspaceKey: normalizedWorkspace,
      alias: aliasBase.toLowerCase(),
    };
    sourceByAssetId.set(sourceAssetId, source);
    nodes.push({
      entityId: toText(entity.id),
      name: toText(entity.name) || toText(entity.id),
      role: entity.kind,
      sourceAssetId,
      workspaceKey: source.workspaceKey,
      transform: normalizeTransform(entity.transform),
    });
  }

  nodes.sort((a, b) => a.entityId.localeCompare(b.entityId));
  const sources = Array.from(sourceByAssetId.values()).sort((a, b) => a.sourceAssetId.localeCompare(b.sourceAssetId));
  return {
    nodes,
    sources,
    diagnostics,
  };
}

function formatUsdNumber(value: number) {
  if (!Number.isFinite(value)) return "0";
  const normalized = Math.abs(value) < 1e-12 ? 0 : value;
  return Number(normalized.toFixed(9)).toString();
}

function formatUsdVec3(x: number, y: number, z: number) {
  return `(${formatUsdNumber(x)}, ${formatUsdNumber(y)}, ${formatUsdNumber(z)})`;
}

function buildReferencePathForAlias(alias: string, entryPath: string) {
  const normalizedEntryPath = normalizePathToken(entryPath);
  return `sources/${alias}/${normalizedEntryPath}`;
}

function escapeUsdString(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function buildComposedSceneUsda(input: {
  nodes: SceneCompositionNode[];
  sourceEntryByAssetId: Record<string, { alias: string; entryPath: string }>;
}) {
  const lines: string[] = [];
  lines.push("#usda 1.0");
  lines.push("(");
  lines.push('    defaultPrim = "World"');
  lines.push('    upAxis = "Z"');
  lines.push(")");
  lines.push("");
  lines.push('def Xform "World"');
  lines.push("{");
  for (const node of input.nodes) {
    const source = input.sourceEntryByAssetId[node.sourceAssetId];
    if (!source) continue;
    const referencePath = buildReferencePathForAlias(source.alias, source.entryPath);
    const primName = normalizeIdentifier(node.name || node.entityId, `Entity_${node.entityId}`);
    lines.push(`    def Xform "${escapeUsdString(primName)}" (`);
    lines.push(`        prepend references = @${referencePath}@`);
    lines.push("    )");
    lines.push("    {");
    lines.push(
      `        double3 xformOp:translate = ${formatUsdVec3(
        node.transform.position.x,
        node.transform.position.y,
        node.transform.position.z
      )}`
    );
    lines.push(
      `        float3 xformOp:rotateXYZ = ${formatUsdVec3(
        node.transform.rotation.x,
        node.transform.rotation.y,
        node.transform.rotation.z
      )}`
    );
    lines.push(
      `        float3 xformOp:scale = ${formatUsdVec3(
        node.transform.scale.x,
        node.transform.scale.y,
        node.transform.scale.z
      )}`
    );
    lines.push('        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:rotateXYZ", "xformOp:scale"]');
    lines.push("    }");
    lines.push("");
  }
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

function extractEntryDir(path: string) {
  const normalized = normalizePathToken(path);
  if (!normalized.includes("/")) return "";
  return normalized.slice(0, normalized.lastIndexOf("/"));
}

function remapBundleFilePath(entryPath: string, sourcePath: string) {
  const normalizedEntryPath = normalizePathToken(entryPath);
  const normalizedSourcePath = normalizePathToken(sourcePath);
  const entryDir = extractEntryDir(normalizedEntryPath);
  if (entryDir && normalizedSourcePath.startsWith(`${entryDir}/`)) {
    return normalizedSourcePath.slice(entryDir.length + 1);
  }
  return normalizedSourcePath;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, Math.min(bytes.length, index + chunkSize));
    binary += String.fromCharCode(...chunk);
  }
  if (typeof btoa === "function") return btoa(binary);
  throw new Error("Base64 encoding is unavailable in this runtime.");
}

async function encodeFileToBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return bytesToBase64(bytes);
}

async function buildBundleUploadFiles(input: {
  sources: SceneCompositionSource[];
  assets: Record<string, AssetEntry>;
}): Promise<{
  sourceEntryByAssetId: Record<string, { alias: string; entryPath: string }>;
  files: TrainingUsdBundleFileInput[];
}> {
  const filesByPath = new Map<string, TrainingUsdBundleFileInput>();
  const sourceEntryByAssetId: Record<string, { alias: string; entryPath: string }> = {};

  for (const source of input.sources) {
    const entryAsset = input.assets[source.workspaceKey];
    if (!entryAsset) {
      throw new Error(`Scene source workspace asset not found: ${source.workspaceKey}`);
    }

    const resolveResource = createAssetResolver(input.assets, source.workspaceKey);
    const bundle = await collectUsdBundleFiles({
      usdUrl: entryAsset.url,
      usdKey: source.workspaceKey,
      usdFile: entryAsset.file,
      resolveResource,
      assetsByKey: input.assets,
      maxFiles: 256,
    });

    const remappedEntryPath = remapBundleFilePath(bundle.entryPath, bundle.entryPath);
    sourceEntryByAssetId[source.sourceAssetId] = {
      alias: source.alias,
      entryPath: remappedEntryPath,
    };

    for (const file of bundle.files) {
      const nextFile = await mapBundleFileToUploadInput({
        file,
        bundle,
        alias: source.alias,
      });
      if (filesByPath.has(nextFile.path)) continue;
      filesByPath.set(nextFile.path, nextFile);
    }
  }

  return {
    sourceEntryByAssetId,
    files: Array.from(filesByPath.values()).sort((a, b) => a.path.localeCompare(b.path)),
  };
}

async function mapBundleFileToUploadInput(input: {
  file: CollectedUsdBundleFile;
  bundle: { entryPath: string };
  alias: string;
}): Promise<TrainingUsdBundleFileInput> {
  const normalized = remapBundleFilePath(input.bundle.entryPath, input.file.path);
  const prefixed = `sources/${input.alias}/${normalized}`;
  return {
    path: prefixed,
    contentBase64: await encodeFileToBase64(input.file.file),
    contentType: input.file.contentType || input.file.file.type || "application/octet-stream",
  };
}

export function buildSceneCompositionSignature(input: {
  nodes: SceneCompositionNode[];
  sources: SceneCompositionSource[];
  assets: Record<string, AssetEntry>;
}) {
  const payload = {
    nodes: input.nodes.map((node) => ({
      entityId: node.entityId,
      sourceAssetId: node.sourceAssetId,
      workspaceKey: node.workspaceKey,
      position: node.transform.position,
      rotation: node.transform.rotation,
      scale: node.transform.scale,
    })),
    sources: input.sources.map((source) => {
      const entry = input.assets[source.workspaceKey];
      return {
        sourceAssetId: source.sourceAssetId,
        workspaceKey: source.workspaceKey,
        alias: source.alias,
        fileSize: Number(entry?.file?.size ?? 0),
        fileModifiedAt: Number(entry?.file?.lastModified ?? 0),
      };
    }),
  };
  return JSON.stringify(payload);
}

export async function composeAndUploadEnvironmentSceneAsset(input: {
  environment: EnvironmentDoc;
  assets: Record<string, AssetEntry>;
}): Promise<SceneCompositionUploadResult | null> {
  const plan = buildSceneCompositionPlan(input.environment);
  const blocking = plan.diagnostics.filter((item) => item.severity === "error");
  if (blocking.length > 0) {
    return {
      sceneAssetId: "",
      entryPath: "",
      diagnostics: plan.diagnostics,
      sourceCount: plan.sources.length,
      entityCount: plan.nodes.length,
      signature: buildSceneCompositionSignature({
        nodes: plan.nodes,
        sources: plan.sources,
        assets: input.assets,
      }),
    };
  }
  if (plan.nodes.length === 0 || plan.sources.length === 0) {
    return null;
  }

  const signature = buildSceneCompositionSignature({
    nodes: plan.nodes,
    sources: plan.sources,
    assets: input.assets,
  });
  const bundleUpload = await buildBundleUploadFiles({
    sources: plan.sources,
    assets: input.assets,
  });

  const composedUsda = buildComposedSceneUsda({
    nodes: plan.nodes,
    sourceEntryByAssetId: bundleUpload.sourceEntryByAssetId,
  });
  const composedBytes = new TextEncoder().encode(composedUsda);
  const entryPath = "composed_scene.usda";
  bundleUpload.files.push({
    path: entryPath,
    contentBase64: bytesToBase64(composedBytes),
    contentType: "application/octet-stream",
  });

  const uploaded = await uploadUsdTrainingAssetRemote({
    entryPath,
    files: bundleUpload.files,
  });

  return {
    sceneAssetId: uploaded.assetId,
    entryPath,
    diagnostics: plan.diagnostics,
    sourceCount: plan.sources.length,
    entityCount: plan.nodes.length,
    signature,
  };
}
