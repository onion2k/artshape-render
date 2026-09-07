import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FULL_BUDGETS, Ladder, RUNGS, SLOW_MS_PER_MPX, TIERS, VERDICT_TTL, budgetsFor, median, slownessOf, startingScale, tierFor, verdicts } from '../calibrate';

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  removeItem(key: string) { this.map.delete(key); }
  setItem(key: string, value: string) { this.map.set(key, value); }
}

beforeEach(() => vi.stubGlobal('localStorage', new MemoryStorage()));
afterEach(() => vi.unstubAllGlobals());

describe('startingScale', () => {
  it('opens at full size on a machine with headroom', () => {
    // a desktop: 6 ms a megapixel, a 1.4 Mpx frame, a 60 Hz panel
    expect(startingScale(6, 1.4, 16.7)).toBe(1);
  });

  it('comes down on a slow machine, to the size that fits a tick and a half', () => {
    // an integrated GPU at 80 ms a megapixel: 112 ms a frame at full size
    const s = startingScale(80, 1.4, 16.7);
    expect(s).toBeLessThan(1);
    expect(s).toBeGreaterThanOrEqual(0.5);
    // the frame it opens at is inside the budget
    expect(80 * 1.4 * s * s).toBeLessThanOrEqual(16.7 * 1.5 + 6 + 1e-9);
  });

  it('never goes below the floor, however slow', () => {
    expect(startingScale(1000, 4, 16.7)).toBe(0.5);
    expect(startingScale(1000, 4, 16.7, 0.35)).toBe(0.35);
  });

  it('is full size when nothing was measured', () => {
    expect(startingScale(0, 1.4, 16.7)).toBe(1);
    expect(startingScale(NaN, 1.4, 16.7)).toBe(1);
    expect(startingScale(20, 0, 16.7)).toBe(1);
  });

  it('gives a 120 Hz panel less room, since its tick is shorter', () => {
    expect(startingScale(40, 1.4, 8.3)).toBeLessThan(startingScale(40, 1.4, 16.7));
  });
});

describe('tierFor', () => {
  it('suggests balanced for a desktop and fast for a slow laptop, never fine', () => {
    expect(tierFor(5)).toBe('balanced');
    expect(tierFor(SLOW_MS_PER_MPX)).toBe('balanced');
    expect(tierFor(SLOW_MS_PER_MPX + 1)).toBe('fast');
    expect(tierFor(500)).toBe('fast');
  });

  it('orders the tiers by what they ask', () => {
    expect(TIERS.fast.detail).toBeLessThan(TIERS.balanced.detail);
    expect(TIERS.balanced.detail).toBeLessThan(TIERS.fine.detail);
    expect(TIERS.fast.renderScale).toBeLessThan(TIERS.balanced.renderScale);
    expect(TIERS.fine.quality).toBe('final');
    expect(TIERS.fast.quality).toBe('draft');
  });
});

describe('median', () => {
  it('is the middle value, unmoved by one slow frame', () => {
    expect(median([5, 300, 6])).toBe(6);
    expect(median([4, 8])).toBe(6);
    expect(median([7])).toBe(7);
    expect(median([])).toBeNaN();
  });
});

describe('verdicts', () => {
  const v = { key: 'intel/gen-12lp', msPerMpx: 70, scale: 0.6, at: 1_000_000 };

  it('keeps a verdict against its adapter and gives it back', () => {
    verdicts.save(v);
    expect(verdicts.load('intel/gen-12lp', v.at + 1000)).toEqual(v);
    expect(verdicts.load('apple/m2', v.at + 1000)).toBeNull();
  });

  it('keeps one verdict per adapter', () => {
    verdicts.save(v);
    verdicts.save({ ...v, key: 'apple/m2', msPerMpx: 4, scale: 1 });
    verdicts.save({ ...v, scale: 0.7 });
    expect(verdicts.load('intel/gen-12lp', v.at + 1)!.scale).toBe(0.7);
    expect(verdicts.load('apple/m2', v.at + 1)!.msPerMpx).toBe(4);
  });

  it('forgets a verdict older than its shelf life', () => {
    verdicts.save(v);
    expect(verdicts.load(v.key, v.at + VERDICT_TTL - 1)).not.toBeNull();
    expect(verdicts.load(v.key, v.at + VERDICT_TTL)).toBeNull();
  });

  it('is empty when the shelf is missing, malformed, or unavailable', () => {
    expect(verdicts.load(v.key)).toBeNull();
    localStorage.setItem('artshape.gpu', '{not json');
    expect(verdicts.load(v.key)).toBeNull();
    localStorage.setItem('artshape.gpu', JSON.stringify({ [v.key]: { key: v.key, at: Date.now() } }));
    expect(verdicts.load(v.key)).toBeNull();
    vi.stubGlobal('localStorage', undefined);
    expect(verdicts.load(v.key)).toBeNull();
    expect(() => verdicts.save(v)).not.toThrow();
  });

  it('can be cleared', () => {
    verdicts.save(v);
    verdicts.clear();
    expect(verdicts.load(v.key, v.at + 1)).toBeNull();
  });
});

describe('Ladder', () => {
  const { FLOOR, RESET, FULL_FOR } = Ladder;

  it('comes down through the scale first, to the floor', () => {
    const l = new Ladder();
    expect(l.slower(0, 4)).toBe('scale');
    expect(l.scale).toBeCloseTo(0.5);
    expect(l.rung).toBe(0);
    expect(l.slower(400, 1.2)).toBe('scale');
    expect(l.scale).toBeLessThan(0.5);
    for (let t = 800; l.scale > FLOOR; t += 400) l.slower(t, 2);
    expect(l.scale).toBe(FLOOR);
    expect(l.rung).toBe(0);
  });

  it('then takes the rungs in order, resetting the scale to the middle each time', () => {
    const l = new Ladder(FLOOR);
    expect(l.slower(0, 2)).toBe('rung');
    expect(l.rung).toBe(1);
    expect(l.scale).toBe(RESET);
    expect(l.economy).toEqual({ supersample: false, shadowTaps: 1, contact: true, detail: 1 });
    l.scale = FLOOR;
    l.slower(1000, 2);
    expect(l.economy.shadowTaps).toBe(0.25);
    l.scale = FLOOR;
    l.slower(2000, 2);
    expect(l.economy.contact).toBe(false);
    l.scale = FLOOR;
    expect(l.slower(3000, 2)).toBe('rung');
    expect(l.economy.detail).toBe(0.7);
    expect(l.rung).toBe(RUNGS.length);
    l.scale = FLOOR;
    // the bottom: nothing more to give
    expect(l.slower(4000, 2)).toBeNull();
  });

  it('comes back up through the scale to full before it gives a rung back', () => {
    const l = new Ladder(FLOOR, 1);
    let t = 0;
    while (l.scale < 1) { expect(l.faster(t)).toBe('scale'); t += 300; }
    expect(l.rung).toBe(1);
    // at full, but not for long enough
    expect(l.faster(t + 100)).toBeNull();
    expect(l.faster(t + FULL_FOR + 1)).toBe('rung');
    expect(l.rung).toBe(0);
    expect(l.scale).toBe(RESET);
    // nothing above the top
    l.scale = 1;
    expect(l.faster(t + 2 * FULL_FOR + 10_000)).toBeNull();
  });

  it('holds a rung it has just taken, for twice as long each time', () => {
    const l = new Ladder(FLOOR);
    l.slower(0, 2);                  // rung 1 at t=0, held 2 s
    l.scale = 1; l.faster(0);        // full from t=0
    expect(l.faster(FULL_FOR + 1)).toBeNull();       // inside the hold
    expect(l.faster(2001)).toBe('rung');            // past it, and full long enough
    l.scale = FLOOR;
    l.slower(2100, 2);               // taken again: held 4 s now
    l.scale = 1; l.faster(2100);
    expect(l.faster(2100 + 2500)).toBeNull();
    expect(l.faster(2100 + 4001)).toBe('rung');
  });

  it('starts where a kept verdict left it, within bounds', () => {
    expect(new Ladder(0.1, 99)).toMatchObject({ scale: FLOOR, rung: RUNGS.length });
    expect(new Ladder(2, -1)).toMatchObject({ scale: 1, rung: 0 });
  });
});

describe('budgets', () => {
  it('is the desktop at a desktop verdict', () => {
    expect(slownessOf(8)).toBe(1);
    expect(budgetsFor(slownessOf(8))).toEqual(FULL_BUDGETS);
    expect(slownessOf(NaN)).toBe(1);
  });

  it('comes down by the square root for counts and sizes, and by the whole for a chunk', () => {
    // sixteen times slower: a quarter of the directions, half the size, a sixteenth of a chunk
    const b = budgetsFor(16);
    expect(b.occlusionDirections).toEqual({ draft: 16, full: 64 });
    expect(b.occlusionDepth).toEqual({ draft: 256, full: 512 });
    expect(b.triangleBudget).toBe(750_000);
    expect(b.probeSize).toBe(64);
    expect(b.probeBounces).toBe(1);
    expect(b.envSize).toBe(128);
    expect(b.keyShadow).toBe(512);
  });

  it('keeps floors under everything, however slow', () => {
    const b = budgetsFor(slownessOf(4000));
    expect(slownessOf(4000)).toBe(64);
    expect(b.occlusionDirections).toEqual({ draft: 16, full: 64 });
    expect(b.occlusionDepth).toEqual({ draft: 256, full: 512 });
    expect(b.triangleBudget).toBe(500_000);
    expect(b.probeSize).toBe(64);
    expect(b.envSize).toBe(128);
    expect(b.keyShadow).toBe(512);
  });

  it('keeps the second bounce until the machine is four times off', () => {
    expect(budgetsFor(3).probeBounces).toBe(2);
    expect(budgetsFor(4).probeBounces).toBe(1);
    // and sizes are powers of two on the way down
    expect(budgetsFor(2).probeSize).toBe(128);
    expect(budgetsFor(2).occlusionDepth.full).toBe(1024);
  });
});
