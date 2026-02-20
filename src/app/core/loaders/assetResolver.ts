/* eslint-disable @typescript-eslint/no-explicit-any */

import type { AssetUrlResolver } from "../assets/types";

export type AssetEntryLike = {
  url: string; // blob url
  key: string; // normalized path key
};

export type AssetMapLike = Record<string, AssetEntryLike>;

export function normPath(p: string) {
  const cleaned = p.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
  const parts = cleaned.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (stack.length && stack[stack.length - 1] !== "..") stack.pop();
      else stack.push("..");
      continue;
    }
    stack.push(part);
  }
  return stack.join("/");
}

const SCHEME_RE = /^([a-z]+):\/\//i;
const FIND_RE = /\$\(\s*find\s+([^)]+)\)/gi;

const normalizeResourceUrl = (resourceUrl: string) =>
  resourceUrl.trim().replace(FIND_RE, (_match, pkg) => String(pkg ?? "").trim());

const candidatePaths = (resourceUrl: string, baseKey?: string | null) => {
  const candidates: string[] = [];
  const add = (value: string | null | undefined) => {
    if (!value) return;
    const normalized = normPath(value);
    if (!normalized) return;
    if (!candidates.includes(normalized)) candidates.push(normalized);
  };

  const normalized = normalizeResourceUrl(resourceUrl);
  const schemeMatch = normalized.match(SCHEME_RE);
  const scheme = schemeMatch?.[1]?.toLowerCase();
  let stripped = normalized;

  if (scheme) {
    stripped = normalized.slice(scheme.length + 3);
  }

  if (scheme === "file") {
    const filePath = stripped.replace(/^\/+/, "/");
    add(filePath);
    add(filePath.replace(/^\/+/, ""));
  } else if (scheme === "package" || scheme === "model" || scheme === "gazebo" || scheme === "ros") {
    add(stripped);
    const parts = stripped.split("/").filter(Boolean);
    if (parts.length > 1) add(parts.slice(1).join("/"));
  } else {
    add(stripped);
  }

  if (baseKey) {
    const baseDir = dirname(baseKey);
    for (const cand of [...candidates]) {
      add(baseDir + cand);
    }
  }

  return candidates;
};

const matchByCandidates = (assets: AssetMapLike, candidates: string[]) => {
  if (!candidates.length) return null;
  for (const cand of candidates) {
    if (assets[cand]) return assets[cand];
  }

  for (const cand of candidates) {
    const match = Object.keys(assets).find((k) => k === cand || k.endsWith(`/${cand}`));
    if (match) return assets[match];
  }

  for (const cand of candidates) {
    const b = basename(cand);
    if (!b) continue;
    const match = Object.keys(assets).find((k) => basename(k) === b);
    if (match) return assets[match];
  }

  return null;
};

export function dirname(p: string) {
  const n = normPath(p);
  const i = n.lastIndexOf("/");
  return i >= 0 ? n.slice(0, i + 1) : "";
}

export function basename(p: string) {
  const n = normPath(p);
  const i = n.lastIndexOf("/");
  return i >= 0 ? n.slice(i + 1) : n;
}

/**
 * Resolver genérico para urdf-loader / three loaders.
 * - soporta http(s)
 * - soporta package:// (MVP: strip)
 * - match directo por path
 * - relativo al baseKey (normalmente el URDF seleccionado)
 * - fallback por basename
 */
export function resolveAssetUrl(
  assets: AssetMapLike,
  resourceUrl: string,
  baseKey?: string | null
): string | null {
  if (!resourceUrl) return null;

  // urdf-loader a veces pasa http(s), data:, blob:
  if (/^(https?:)?\/\//i.test(resourceUrl)) return resourceUrl;
  if (/^(data:|blob:)/i.test(resourceUrl)) return resourceUrl;
  const candidates = candidatePaths(resourceUrl, baseKey);
  const match = matchByCandidates(assets, candidates);
  return match?.url ?? null;
}

export function resolveAssetKey(
  assets: AssetMapLike,
  resourceUrl: string,
  baseKey?: string | null
): string | null {
  if (!resourceUrl) return null;

  // urdf-loader a veces pasa http(s), data:, blob:
  if (/^(https?:)?\/\//i.test(resourceUrl)) return null;
  if (/^(data:|blob:)/i.test(resourceUrl)) return null;
  const candidates = candidatePaths(resourceUrl, baseKey);
  const match = matchByCandidates(assets, candidates);
  return match?.key ?? null;
}

export function relativePath(fromDir: string, toPath: string) {
  const from = normPath(fromDir).replace(/\/+$/, "");
  const to = normPath(toPath);
  const fromParts = from ? from.split("/") : [];
  const toParts = to.split("/");

  while (fromParts.length && toParts.length && fromParts[0] === toParts[0]) {
    fromParts.shift();
    toParts.shift();
  }

  const up = fromParts.map(() => "..");
  return [...up, ...toParts].join("/") || ".";
}

/**
 * Factory cómoda para pasar a viewer.loadURDF(...):
 * devuelve (resourceUrl) => string | null
 */
export function createAssetResolver(assets: AssetMapLike, baseKey?: string | null): AssetUrlResolver {
  return (resourceUrl: string) => resolveAssetUrl(assets, resourceUrl, baseKey);
}
