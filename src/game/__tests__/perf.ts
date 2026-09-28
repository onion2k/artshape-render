/**
 * The performance gate's arithmetic: the median of a set of timed runs, a
 * frame judged against the baseline kept for the adapter it was measured
 * on, and the baseline found in the file. Pure, so it is tested under node;
 * `perf.gpu.test.ts` does the timing on a device and hands its figures here.
 *
 * Without it the game path has no figure held at all: the costs quoted in
 * its comments were measured once, in a spike, and a change that doubled a
 * frame would pass every test there is.
 */

/**
 * How far a frame may move from its baseline, either way, as a fraction.
 * Two runs of the same tree agreed within 1–6% on an M4 Pro; this is about
 * three times that, wide enough not to fail on a busy machine and narrow
 * enough that a fifth more work is seen.
 */
export const TOLERANCE = 0.15;

/** What the gate says of one scene. */
export interface Verdict {
  scene: string;
  measured: number;
  baseline?: number;
  ok: boolean;
  why: string;
}

/** The middle of a set of runs, without disturbing their order. */
export function median(runs: number[]): number {
  const s = [...runs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Each scene's frame against its baseline. Quicker by more than the
 * tolerance fails as slower does: a frame that has got cheaper by a fifth
 * has stopped drawing something, or the baseline is out of date, and either
 * is worth a look. A scene with no baseline passes and says so, since a
 * machine never measured has nothing to be held to.
 */
export function judge(measured: Record<string, number>, baseline?: Record<string, number>, tolerance = TOLERANCE): Verdict[] {
  return Object.entries(measured).map(([scene, ms]) => {
    const was = baseline?.[scene];
    if (was === undefined) return { scene, measured: ms, ok: true, why: `${ms.toFixed(2)} ms, no baseline for this adapter` };
    const change = ms / was - 1;
    const pct = `${(Math.abs(change) * 100).toFixed(0)}%`;
    if (change > tolerance) return { scene, measured: ms, baseline: was, ok: false, why: `${ms.toFixed(2)} ms, ${pct} slower than ${was.toFixed(2)}` };
    if (change < -tolerance) return { scene, measured: ms, baseline: was, ok: false, why: `${ms.toFixed(2)} ms, ${pct} quicker than ${was.toFixed(2)}` };
    return { scene, measured: ms, baseline: was, ok: true, why: `${ms.toFixed(2)} ms against ${was.toFixed(2)}` };
  });
}

/** The baselines kept for `adapter` in the file's text, or none: an empty file is one not written yet. */
export function recorded(file: string, adapter: string): Record<string, number> | undefined {
  if (!file.trim()) return undefined;
  const all = JSON.parse(file) as Record<string, Record<string, number>>;
  return all[adapter];
}
