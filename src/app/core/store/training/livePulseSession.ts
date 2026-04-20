export type LivePulseSessionState = {
  currentRunRef: string | null;
  currentLatestIteration: number | null;
};

export function createLivePulseSessionState(): LivePulseSessionState {
  return {
    currentRunRef: null,
    currentLatestIteration: null,
  };
}

export function shouldAcceptLivePulse(
  session: LivePulseSessionState,
  runRef: string | null,
  iteration: number | null
) {
  if (runRef && session.currentRunRef && runRef !== session.currentRunRef) {
    return false;
  }
  if (iteration === null || iteration === undefined) return true;
  const current = session.currentLatestIteration ?? -1;
  return iteration >= current;
}

export function updateLivePulseSession(
  session: LivePulseSessionState,
  runRef: string | null,
  iteration: number | null
) {
  return {
    currentRunRef: runRef ?? session.currentRunRef,
    currentLatestIteration: iteration === null || iteration === undefined ? session.currentLatestIteration : Math.max(session.currentLatestIteration ?? -1, iteration),
  };
}
