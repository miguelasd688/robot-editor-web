export type CanonicalMetricEventInput = {
  jobId: string;
  eventType: string;
  runnerJobId?: string | null;
  step: number;
  metrics: Record<string, unknown>;
  source?: string | null;
};

const METRIC_SOURCE_ALIASES: Record<string, string> = {
  structured_metrics_jsonl: "structured_metrics_file",
  stdout_compatibility_fallback: "stdout_fallback",
};

export function normalizeMetricSourceToken(source: unknown) {
  const token = String(source ?? "").trim();
  if (token.length === 0) return "none";
  return METRIC_SOURCE_ALIASES[token] ?? token;
}

function normalizeMetricToken(value: unknown) {
  const token = String(value ?? "").trim();
  return token.length > 0 ? token : "none";
}

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForStableJson(item));
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      normalized[key] = normalizeForStableJson(record[key]);
    }
    return normalized;
  }
  return value;
}

function stableJsonStringify(value: unknown) {
  return JSON.stringify(normalizeForStableJson(value));
}

function hashStableText(text: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function buildCanonicalMetricEventId(input: CanonicalMetricEventInput) {
  const jobToken = normalizeMetricToken(input.jobId);
  const eventTypeToken = normalizeMetricToken(input.eventType);
  const runnerJobToken = normalizeMetricToken(input.runnerJobId);
  const stepToken = Math.max(0, Math.round(Number(input.step) || 0));
  const sourceToken = normalizeMetricSourceToken(input.source);
  const metricsSignature = stableJsonStringify(input.metrics) ?? "null";
  const payloadSignature = [
    jobToken,
    eventTypeToken,
    runnerJobToken,
    String(stepToken),
    sourceToken,
    metricsSignature,
  ].join("|");
  return `metric_${hashStableText(payloadSignature)}`;
}
