import type { SceneAssetId } from "../../app/core/scene/sceneAssets";

export const BROWSER_IMPORT_MIME = "application/x-browser-import";

export type BrowserImportPayload =
  | {
      kind: "asset";
      assetId: SceneAssetId;
      label: string;
    }
  | {
      kind: "sample";
      sample: "cartpole";
      label: string;
    }
  | {
      kind: "workspace-urdf";
      path: string;
      label: string;
    };

export function encodeBrowserImportPayload(payload: BrowserImportPayload) {
  return JSON.stringify(payload);
}

export function decodeBrowserImportPayload(raw: string | null | undefined): BrowserImportPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<BrowserImportPayload>;
    if (parsed.kind === "asset" && typeof parsed.assetId === "string" && typeof parsed.label === "string") {
      return {
        kind: "asset",
        assetId: parsed.assetId as SceneAssetId,
        label: parsed.label,
      };
    }
    if (parsed.kind === "sample" && parsed.sample === "cartpole" && typeof parsed.label === "string") {
      return {
        kind: "sample",
        sample: "cartpole",
        label: parsed.label,
      };
    }
    if (parsed.kind === "workspace-urdf" && typeof parsed.path === "string" && typeof parsed.label === "string") {
      return {
        kind: "workspace-urdf",
        path: parsed.path,
        label: parsed.label,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function payloadFromDataTransfer(dataTransfer: DataTransfer | null): BrowserImportPayload | null {
  if (!dataTransfer) return null;
  const raw = dataTransfer.getData(BROWSER_IMPORT_MIME);
  return decodeBrowserImportPayload(raw);
}

export function hasBrowserImportPayload(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  const types = Array.from(dataTransfer.types ?? []);
  return types.includes(BROWSER_IMPORT_MIME);
}
