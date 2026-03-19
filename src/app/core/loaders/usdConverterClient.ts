type UsdConverterUploadResponse = {
  assetId?: string;
};

type UsdConverterToMjcfResponse = {
  mjcfAssetId?: string;
  meta?: { assetId?: string };
  diagnostics?: unknown;
};

const buildUsdConverterUrl = (baseUrl: string, path: string) => `${baseUrl}${path}`;

export type UploadedUsdBundle = {
  entryPath: string;
  files: Array<{ file: File; path: string }>;
};

export async function uploadUsdBundleAsset(params: {
  baseUrl: string;
  bundle: UploadedUsdBundle;
}): Promise<string> {
  const uploadForm = new FormData();
  uploadForm.append("entryPath", params.bundle.entryPath);
  for (const item of params.bundle.files) {
    uploadForm.append("files", item.file, item.path);
  }
  const uploadRes = await fetch(buildUsdConverterUrl(params.baseUrl, "/v1/assets/usd-bundle"), {
    method: "POST",
    body: uploadForm,
  });
  if (!uploadRes.ok) {
    const text = await uploadRes.text();
    throw new Error(`USD converter bundle upload failed (${uploadRes.status}): ${text || uploadRes.statusText}`);
  }
  const uploaded = (await uploadRes.json()) as UsdConverterUploadResponse;
  const converterAssetId = String(uploaded.assetId ?? "").trim();
  if (!converterAssetId) {
    throw new Error("USD converter did not return assetId after bundle upload.");
  }
  return converterAssetId;
}

export async function convertUsdAssetToMjcfAsset(params: {
  baseUrl: string;
  converterAssetId: string;
  floatingBase: boolean;
  selfCollision: boolean;
  collisionProfile: "authored" | "outer_hull";
}): Promise<{ mjcfAssetId: string; mjcfXml: string; diagnostics: unknown }> {
  const query = new URLSearchParams();
  query.set("floating_base", String(params.floatingBase));
  query.set("self_collision", String(params.selfCollision));
  query.set("collision_profile", params.collisionProfile);
  const convertRes = await fetch(
    buildUsdConverterUrl(
      params.baseUrl,
      `/v1/assets/${encodeURIComponent(params.converterAssetId)}:convert-usd-to-mjcf?${query.toString()}`
    ),
    {
      method: "POST",
    }
  );
  if (!convertRes.ok) {
    const text = await convertRes.text();
    throw new Error(`USD converter conversion failed (${convertRes.status}): ${text || convertRes.statusText}`);
  }
  const converted = (await convertRes.json()) as UsdConverterToMjcfResponse;
  const mjcfAssetId = String(converted.mjcfAssetId ?? converted.meta?.assetId ?? "").trim();
  if (!mjcfAssetId) {
    throw new Error("USD converter did not return mjcfAssetId.");
  }
  const mjcfRes = await fetch(buildUsdConverterUrl(params.baseUrl, `/v1/assets/${encodeURIComponent(mjcfAssetId)}`), {
    method: "GET",
  });
  if (!mjcfRes.ok) {
    const text = await mjcfRes.text();
    throw new Error(`USD converter MJCF download failed (${mjcfRes.status}): ${text || mjcfRes.statusText}`);
  }
  const mjcfXml = await mjcfRes.text();
  return {
    mjcfAssetId,
    mjcfXml,
    diagnostics: converted.diagnostics ?? null,
  };
}

export async function fetchUsdAssetIntrospectionPayload(params: {
  baseUrl: string;
  converterAssetId: string;
}): Promise<unknown> {
  const response = await fetch(
    buildUsdConverterUrl(params.baseUrl, `/v1/assets/${encodeURIComponent(params.converterAssetId)}/introspect`),
    {
      method: "GET",
    }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`USD converter introspection failed (${response.status}): ${text || response.statusText}`);
  }
  return await response.json();
}

export async function fetchUsdAssetMeshScenePayload(params: {
  baseUrl: string;
  converterAssetId: string;
  profile: "balanced" | "high_fidelity";
}): Promise<unknown> {
  const query = new URLSearchParams();
  query.set("profile", params.profile);
  const response = await fetch(
    buildUsdConverterUrl(
      params.baseUrl,
      `/v1/assets/${encodeURIComponent(params.converterAssetId)}/mesh-scene?${query.toString()}`
    ),
    {
      method: "GET",
    }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`USD mesh scene request failed (${response.status}): ${text || response.statusText}`);
  }
  return await response.json();
}
