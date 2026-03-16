const PRINTABLE_MIN = 0x20;
const PRINTABLE_MAX = 0x7e;
const REFERENCE_EXT_RE = /(?:^|[./\\])[A-Za-z0-9_.-]+\.(usd|usda|usdc|usdz)$/i;
const FILE_EXT_SKIP_RE = /\.(png|jpg|jpeg|webp|tiff|bmp|hdr|exr|mtl|obj|stl|dae|fbx|gltf|glb|xml|mjcf)$/i;
const BUNDLE_FALLBACK_INCLUDE_EXT_RE = /\.(usd|usda|usdc|usdz|png|jpg|jpeg|webp|tif|tiff|bmp|hdr|exr|mtl|obj|stl|dae|fbx|gltf|glb)$/i;

export type UsdWorkspaceAssetEntry = {
  url: string;
  key: string;
  file?: File;
};

export type CollectedUsdBundleFile = {
  path: string;
  file: File;
  contentType: string;
};

export type CollectedUsdBundle = {
  entryPath: string;
  files: CollectedUsdBundleFile[];
};

export type CollectUsdBundleFilesParams = {
  usdUrl: string;
  usdKey: string;
  usdFile?: File;
  resolveResource?: (resourcePath: string) => string | null;
  assetsByKey?: Record<string, UsdWorkspaceAssetEntry>;
  bundleHintPaths?: string[];
  maxFiles?: number;
};

const normalizeSlashPath = (value: string) => value.replace(/\\/g, "/").replace(/\/+/g, "/");
const stripQueryAndHash = (value: string) => value.replace(/[?#].*$/, "");

const normalizeBundlePath = (value: string): string | null => {
  const normalized = normalizeSlashPath(stripQueryAndHash(value).trim());
  if (!normalized) return null;
  const rawParts = normalized.replace(/^\/+/, "").split("/");
  const parts: string[] = [];
  for (const rawPart of rawParts) {
    const part = rawPart.trim();
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.length > 0 ? parts.join("/") : null;
};

const dirnameBundlePath = (value: string) => {
  const normalized = normalizeBundlePath(value);
  if (!normalized) return "";
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? "" : normalized.slice(0, slash);
};

const resolveReferenceBundlePath = (basePath: string, reference: string): string | null => {
  const normalizedRef = normalizeSlashPath(stripQueryAndHash(reference).trim());
  if (!normalizedRef) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalizedRef)) return null;
  if (normalizedRef.startsWith("//")) return null;
  if (normalizedRef.startsWith("/")) return normalizeBundlePath(normalizedRef);
  const baseDir = dirnameBundlePath(basePath);
  return normalizeBundlePath(baseDir ? `${baseDir}/${normalizedRef}` : normalizedRef);
};

const extractPrintableTokens = (bytes: Uint8Array): string[] => {
  const out: string[] = [];
  let start = -1;
  const pushToken = (from: number, to: number) => {
    if (to - from < 4) return;
    let token = "";
    for (let i = from; i < to; i += 1) token += String.fromCharCode(bytes[i]);
    out.push(token);
  };
  for (let i = 0; i < bytes.length; i += 1) {
    const code = bytes[i];
    const printable = code >= PRINTABLE_MIN && code <= PRINTABLE_MAX;
    if (printable) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0) pushToken(start, i);
    start = -1;
  }
  if (start >= 0) pushToken(start, bytes.length);
  return out;
};

const extractReferences = (tokens: string[]): string[] => {
  const refs = new Set<string>();
  for (const token of tokens) {
    if (!REFERENCE_EXT_RE.test(token)) continue;
    const normalized = normalizeSlashPath(token).replace(/^["']+|["']+$/g, "");
    if (!normalized || FILE_EXT_SKIP_RE.test(normalized)) continue;
    refs.add(normalized);
  }
  return Array.from(refs);
};

const createFileFromBytes = (bytes: Uint8Array, path: string, fallbackType = "application/octet-stream") => {
  const name = path.split("/").pop() ?? "asset.usd";
  const stable = new Uint8Array(bytes.byteLength);
  stable.set(bytes);
  return new File([stable], name, { type: fallbackType });
};

const resolveWorkspaceKeyFromUrl = (
  urlToKey: Map<string, string>,
  resolvedUrl: string,
  basePath: string,
  reference: string
) => {
  const fromUrl = urlToKey.get(resolvedUrl);
  if (fromUrl) return fromUrl;
  return resolveReferenceBundlePath(basePath, reference);
};

const hasHiddenBundleSegment = (path: string) =>
  path
    .split("/")
    .map((item) => item.trim())
    .filter(Boolean)
    .some((item) => item.startsWith("."));

const isBundleFallbackCandidatePath = (path: string) => {
  if (hasHiddenBundleSegment(path)) return false;
  return BUNDLE_FALLBACK_INCLUDE_EXT_RE.test(path.toLowerCase());
};

const readUsdBytes = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load USD (${response.status} ${response.statusText})`);
  return new Uint8Array(await response.arrayBuffer());
};

export async function collectUsdBundleFiles(params: CollectUsdBundleFilesParams): Promise<CollectedUsdBundle> {
  const entryPath = normalizeBundlePath(params.usdKey);
  if (!entryPath) {
    throw new Error(`Invalid USD workspace key '${params.usdKey}'.`);
  }

  const assetsByKey = params.assetsByKey ?? {};
  const urlToKey = new Map<string, string>();
  const keyToAsset = new Map<string, UsdWorkspaceAssetEntry>();
  for (const [key, entry] of Object.entries(assetsByKey)) {
    const normalizedKey = normalizeBundlePath(key);
    if (!normalizedKey) continue;
    keyToAsset.set(normalizedKey, entry);
    urlToKey.set(entry.url, normalizedKey);
  }

  const queue: Array<{ url: string; path: string; file?: File }> = [];
  queue.push({
    url: params.usdUrl,
    path: entryPath,
    file: params.usdFile ?? keyToAsset.get(entryPath)?.file,
  });

  const visitedUrls = new Set<string>();
  const filesByPath = new Map<string, CollectedUsdBundleFile>();
  const maxFiles = Math.max(1, Math.min(256, params.maxFiles ?? 128));
  const entryDir = dirnameBundlePath(entryPath);

  while (queue.length > 0 && filesByPath.size < maxFiles) {
    const current = queue.shift() as { url: string; path: string; file?: File };
    if (visitedUrls.has(current.url)) continue;
    visitedUrls.add(current.url);

    let bytes: Uint8Array;
    let contentType = current.file?.type || "application/octet-stream";
    if (current.file instanceof File) {
      bytes = new Uint8Array(await current.file.arrayBuffer());
      contentType = current.file.type || contentType;
    } else {
      bytes = await readUsdBytes(current.url);
      const fromAsset = keyToAsset.get(current.path);
      contentType = fromAsset?.file?.type || contentType;
    }

    if (!filesByPath.has(current.path)) {
      const file = current.file instanceof File ? current.file : createFileFromBytes(bytes, current.path, contentType);
      filesByPath.set(current.path, {
        path: current.path,
        file,
        contentType,
      });
    }

    if (!params.resolveResource) continue;
    const tokens = extractPrintableTokens(bytes);
    const references = extractReferences(tokens);
    for (const reference of references) {
      const resolvedUrl = params.resolveResource(reference);
      if (!resolvedUrl || visitedUrls.has(resolvedUrl)) continue;

      const resolvedKey = resolveWorkspaceKeyFromUrl(urlToKey, resolvedUrl, current.path, reference);
      const normalizedKey = normalizeBundlePath(resolvedKey ?? "");
      if (!normalizedKey) continue;
      const fromAsset = keyToAsset.get(normalizedKey);
      queue.push({
        url: resolvedUrl,
        path: normalizedKey,
        file: fromAsset?.file,
      });
    }
  }

  const addBundleFileByPath = async (candidatePath: string) => {
    if (filesByPath.size >= maxFiles || filesByPath.has(candidatePath)) return;
    const fromAsset = keyToAsset.get(candidatePath);
    const fromAssetUrl = fromAsset?.url ?? "";

    let resolvedUrl = fromAssetUrl;
    if (!resolvedUrl && params.resolveResource) {
      const relativeCandidate =
        entryDir && candidatePath.startsWith(`${entryDir}/`)
          ? candidatePath.slice(entryDir.length + 1)
          : candidatePath;
      resolvedUrl = params.resolveResource(relativeCandidate) ?? params.resolveResource(candidatePath) ?? "";
    }
    if (!resolvedUrl) return;

    let file: File;
    let contentType = fromAsset?.file?.type || "application/octet-stream";
    if (fromAsset?.file instanceof File) {
      file = fromAsset.file;
      contentType = fromAsset.file.type || contentType;
    } else {
      const bytes = await readUsdBytes(resolvedUrl);
      file = createFileFromBytes(bytes, candidatePath, contentType);
    }

    filesByPath.set(candidatePath, {
      path: candidatePath,
      file,
      contentType,
    });
  };

  const normalizedHintPaths = Array.isArray(params.bundleHintPaths)
    ? params.bundleHintPaths
        .map((rawPath) => String(rawPath ?? "").trim())
        .filter((rawPath) => rawPath.length > 0)
        .map((rawPath) => {
          const relativeCandidate = normalizeBundlePath(resolveReferenceBundlePath(entryPath, rawPath) ?? "");
          if (relativeCandidate && keyToAsset.has(relativeCandidate)) return relativeCandidate;
          return normalizeBundlePath(rawPath);
        })
        .filter((item): item is string => Boolean(item))
    : [];

  const missingHints = normalizedHintPaths.filter((path) => !filesByPath.has(path));
  const referenceDiscoveryLooksIncomplete = filesByPath.size <= 1 || missingHints.length > 0;
  if (referenceDiscoveryLooksIncomplete) {
    const fallbackCandidates = new Set<string>();
    for (const hintPath of missingHints) fallbackCandidates.add(hintPath);
    for (const candidatePath of keyToAsset.keys()) {
      if (!isBundleFallbackCandidatePath(candidatePath)) continue;
      if (entryDir) {
        if (!candidatePath.startsWith(`${entryDir}/`)) continue;
      } else if (candidatePath.includes("/")) {
        continue;
      }
      fallbackCandidates.add(candidatePath);
    }

    const orderedCandidates = Array.from(fallbackCandidates).sort((a, b) => a.localeCompare(b));
    for (const candidatePath of orderedCandidates) {
      if (filesByPath.size >= maxFiles) break;
      await addBundleFileByPath(candidatePath);
    }
  }

  const files = Array.from(filesByPath.values()).sort((a, b) => a.path.localeCompare(b.path));
  if (!files.find((item) => item.path === entryPath)) {
    throw new Error(`USD entry '${entryPath}' missing from resolved bundle.`);
  }

  return { entryPath, files };
}
