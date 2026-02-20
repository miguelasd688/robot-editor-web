import type {
  SubmitTrainingJobInput,
  TrainingArtifactKind,
  TrainingArtifactSummary,
  TrainingJobEventSummary,
  TrainingJobSummary,
} from "../plugins/types";

type TrainingJobListResponse = {
  items: TrainingJobSummary[];
};

type TrainingArtifactListResponse = {
  items: TrainingArtifactSummary[];
};

type TrainingJobEventListResponse = {
  items: TrainingJobEventSummary[];
};

const rawBaseUrl = String(import.meta.env.VITE_TRAINING_API_BASE_URL ?? "").trim();
const baseUrl = rawBaseUrl.replace(/\/+$/, "");
const rawApiToken = String(import.meta.env.VITE_TRAINING_API_TOKEN ?? "").trim();

export const trainingApiEnabled = baseUrl.length > 0;
export const trainingApiBaseUrl = baseUrl;
export const trainingApiTokenEnabled = rawApiToken.length > 0;

function buildUrl(path: string) {
  return `${baseUrl}${path}`;
}

function buildHeaders(headers: Record<string, string> = {}) {
  const next: Record<string, string> = { ...headers };
  if (rawApiToken) {
    next.authorization = `Bearer ${rawApiToken}`;
  }
  return next;
}

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Training API ${response.status}: ${text || response.statusText}`);
  }
  return (await response.json()) as T;
}

export async function submitTrainingJobRemote(input: SubmitTrainingJobInput): Promise<TrainingJobSummary> {
  const response = await fetch(buildUrl("/v1/training/jobs"), {
    method: "POST",
    headers: buildHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input),
  });
  return await parseJson<TrainingJobSummary>(response);
}

export async function listTrainingJobsRemote(): Promise<TrainingJobSummary[]> {
  const response = await fetch(buildUrl("/v1/training/jobs"), {
    method: "GET",
    headers: buildHeaders({ accept: "application/json" }),
  });
  const payload = await parseJson<TrainingJobListResponse>(response);
  return payload.items;
}

export async function cancelTrainingJobRemote(jobId: string): Promise<void> {
  const response = await fetch(buildUrl(`/v1/training/jobs/${encodeURIComponent(jobId)}:cancel`), {
    method: "POST",
    headers: buildHeaders({ accept: "application/json" }),
  });
  await parseJson<{ jobId: string; accepted: boolean }>(response);
}

export async function listTrainingArtifactsRemote(
  jobId: string,
  kind?: TrainingArtifactKind
): Promise<TrainingArtifactSummary[]> {
  const params = new URLSearchParams();
  params.set("jobId", jobId);
  if (kind) params.set("kind", kind);
  const response = await fetch(buildUrl(`/v1/artifacts?${params.toString()}`), {
    method: "GET",
    headers: buildHeaders({ accept: "application/json" }),
  });
  const payload = await parseJson<TrainingArtifactListResponse>(response);
  return payload.items;
}

export async function listTrainingJobEventsRemote(jobId: string, limit = 100): Promise<TrainingJobEventSummary[]> {
  const bounded = Math.min(Math.max(1, Math.round(limit)), 500);
  const response = await fetch(
    buildUrl(`/v1/debug/jobs/${encodeURIComponent(jobId)}/events?limit=${bounded}`),
    {
      method: "GET",
      headers: buildHeaders({ accept: "application/json" }),
    }
  );
  const payload = await parseJson<TrainingJobEventListResponse>(response);
  return payload.items;
}
