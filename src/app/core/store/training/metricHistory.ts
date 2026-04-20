export type CanonicalMetricHistoryRow = {
  trainerIteration: number;
  metricStep: number;
  occurredAt: string;
  progressRatio: number | null;
  source: string;
  sourceMarker: string | null;
  episodeIndex: number | null;
  reward?: number | null;
  episodeLength?: number | null;
  rewardMean: number | null;
  episodeLengthMean: number | null;
  loss: number | null;
  fps: number | null;
};

function preferValue(existing: number | null | undefined, incoming: number | null | undefined) {
  if (incoming === null || incoming === undefined) return existing ?? null;
  if (existing === null || existing === undefined) return incoming;
  if (existing === 0 && incoming !== 0) return incoming;
  return existing;
}

function normalizeRow(row: CanonicalMetricHistoryRow): CanonicalMetricHistoryRow {
  return {
    ...row,
    rewardMean: row.rewardMean ?? row.reward ?? null,
    episodeLengthMean: row.episodeLengthMean ?? row.episodeLength ?? null,
  };
}

export function mergeMetricRowsByIteration(
  current: CanonicalMetricHistoryRow[],
  incoming: CanonicalMetricHistoryRow[]
) {
  const byIteration = new Map<number, CanonicalMetricHistoryRow>();
  for (const row of current) {
    byIteration.set(row.trainerIteration, normalizeRow(row));
  }
  for (const row of incoming) {
    const existing = byIteration.get(row.trainerIteration);
    if (!existing) {
      byIteration.set(row.trainerIteration, normalizeRow(row));
      continue;
    }
    byIteration.set(row.trainerIteration, {
      ...existing,
      ...row,
      progressRatio: row.progressRatio ?? existing.progressRatio,
      episodeIndex: row.episodeIndex ?? existing.episodeIndex,
      reward: preferValue(existing.reward, row.reward),
      episodeLength: preferValue(existing.episodeLength, row.episodeLength),
      rewardMean: preferValue(existing.rewardMean, row.rewardMean ?? row.reward),
      episodeLengthMean: preferValue(existing.episodeLengthMean, row.episodeLengthMean ?? row.episodeLength),
      loss: preferValue(existing.loss, row.loss),
      fps: preferValue(existing.fps, row.fps),
      sourceMarker: row.sourceMarker ?? existing.sourceMarker,
      source: row.source ?? existing.source,
    });
  }
  return Array.from(byIteration.values()).sort((a, b) => a.trainerIteration - b.trainerIteration);
}

export function deriveVisibleMetricHistory(rows: CanonicalMetricHistoryRow[]) {
  return rows.slice().sort((a, b) => a.trainerIteration - b.trainerIteration);
}

