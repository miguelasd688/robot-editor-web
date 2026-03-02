import type { AssetEntry } from "../assets/assetRegistryTypes";

const XACRO_TAG_RE = /<\s*xacro:/i;

const encodeBase64 = (data: Uint8Array) => {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < data.length; i += chunkSize) {
    binary += String.fromCharCode(...data.subarray(i, i + chunkSize));
  }
  return btoa(binary);
};

const readAllAssets = async (assets: Record<string, AssetEntry>): Promise<Record<string, Uint8Array>> => {
  const entries = await Promise.all(
    Object.values(assets).map(async (entry) => [entry.key, new Uint8Array(await entry.file.arrayBuffer())] as const)
  );
  return Object.fromEntries(entries);
};

export function hasXacroTags(content: string): boolean {
  return XACRO_TAG_RE.test(content);
}

export async function expandXacroIfConfigured(params: {
  content: string;
  assets: Record<string, AssetEntry>;
  urdfKey: string;
  endpoint?: string | null;
}): Promise<string | null> {
  const endpoint = (params.endpoint ?? (import.meta.env.VITE_XACRO_ENDPOINT as string | undefined) ?? "").trim();
  if (!endpoint) return null;

  const files = await readAllAssets(params.assets);
  const payload = {
    urdfKey: params.urdfKey,
    urdf: params.content,
    files: Object.fromEntries(Object.entries(files).map(([key, data]) => [key, encodeBase64(data)])),
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Xacro endpoint failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { urdf?: string };
  if (!data?.urdf) {
    throw new Error("Xacro endpoint did not return expanded URDF.");
  }

  return String(data.urdf);
}

export function stripXacroTags(content: string): string {
  let next = content;
  next = next.replace(/\sxmlns:xacro="[^"]*"/gi, "");
  next = next.replace(/<\s*xacro:[^>]*\/\s*>/gi, "");
  next = next.replace(/<\s*xacro:[^>]*>/gi, "");
  next = next.replace(/<\/\s*xacro:[^>]*>/gi, "");
  return next;
}
