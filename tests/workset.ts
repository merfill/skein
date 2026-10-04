// Working-set metrics, shared by the offline policy simulation and the live scenario
// report. Pure: they look only at the projection's `shown` per turn and what the model
// requested, so they can run on captured contexts without touching the engine.

export interface WorkingSetTurn {
  shown: readonly { id?: string | undefined; output?: string | undefined }[];
  requested: readonly string[];
}

export interface WorkingSetStats {
  // Peak number of bodies shown at once.
  peakCount: number;
  // Peak total characters of the shown bodies.
  peakChars: number;
  // Distinct bodies the model asked for again after they had left the shown set
  // (re-acquisition after eviction/expiry) — the churn TTL/cap cause.
  reacquired: number;
  reacquiredIds: string[];
  // Total re-acquisition events (not deduplicated): how much churn actually happened.
  reacquiredTotal: number;
  // Turns on which the shown set was non-empty.
  turnsWithShown: number;
}

export function workingSetStats(turns: readonly WorkingSetTurn[]): WorkingSetStats {
  const everShown = new Set<string>();
  const reacquired = new Set<string>();
  let reacquiredTotal = 0;
  let peakCount = 0;
  let peakChars = 0;
  let turnsWithShown = 0;

  for (const turn of turns) {
    const shownIds = new Set<string>();
    let chars = 0;
    for (const view of turn.shown) {
      if (view.id !== undefined) shownIds.add(view.id);
      chars += view.output?.length ?? 0;
    }
    peakCount = Math.max(peakCount, shownIds.size);
    peakChars = Math.max(peakChars, chars);
    if (shownIds.size > 0) turnsWithShown += 1;
    for (const id of turn.requested) {
      if (everShown.has(id) && !shownIds.has(id)) {
        reacquired.add(id);
        reacquiredTotal += 1;
      }
    }
    for (const id of shownIds) everShown.add(id);
  }

  return {
    peakCount,
    peakChars,
    reacquired: reacquired.size,
    reacquiredIds: [...reacquired],
    reacquiredTotal,
    turnsWithShown,
  };
}
