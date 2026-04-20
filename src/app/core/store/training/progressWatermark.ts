export type VisibleProgressWatermark = {
  visibleProgressWatermarkIteration: number | null;
  visibleProgressWatermarkRatio: number | null;
  visibleProgressWatermarkAt: number | null;
  staleProgressPulseDroppedCount: number;
  lastDroppedPulseIteration: number | null;
  lastDroppedPulseOccurredAt: number | null;
  nonMonotonicProgressUpdateSuppressed: boolean;
};

export function createVisibleProgressWatermark(): VisibleProgressWatermark {
  return {
    visibleProgressWatermarkIteration: null,
    visibleProgressWatermarkRatio: null,
    visibleProgressWatermarkAt: null,
    staleProgressPulseDroppedCount: 0,
    lastDroppedPulseIteration: null,
    lastDroppedPulseOccurredAt: null,
    nonMonotonicProgressUpdateSuppressed: false,
  };
}

export function applyVisibleProgressWatermark(
  current: VisibleProgressWatermark,
  nextIteration: number | null,
  nextRatio: number | null,
  occurredAtMs: number
) {
  if (nextIteration === null || nextIteration === undefined) {
    return { next: current, accepted: false };
  }
  const currentIteration = current.visibleProgressWatermarkIteration ?? -1;
  if (nextIteration < currentIteration) {
    return {
      next: {
        ...current,
        staleProgressPulseDroppedCount: current.staleProgressPulseDroppedCount + 1,
        lastDroppedPulseIteration: nextIteration,
        lastDroppedPulseOccurredAt: occurredAtMs,
        nonMonotonicProgressUpdateSuppressed: true,
      },
      accepted: false,
    };
  }
  return {
    next: {
      ...current,
      visibleProgressWatermarkIteration: nextIteration,
      visibleProgressWatermarkRatio:
        nextRatio === null || nextRatio === undefined
          ? current.visibleProgressWatermarkRatio
          : Math.max(current.visibleProgressWatermarkRatio ?? 0, nextRatio),
      visibleProgressWatermarkAt: occurredAtMs,
      nonMonotonicProgressUpdateSuppressed: false,
    },
    accepted: true,
  };
}

