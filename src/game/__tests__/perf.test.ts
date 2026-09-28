/**
 * The performance gate's own working parts, under node: a bug in the
 * middle of a gate does not throw, it passes a frame it should have failed,
 * so the median, the comparison and the keying by adapter are held here and
 * not only by a run on a device.
 */
import { describe, expect, it } from 'vitest';
import { TOLERANCE, judge, median, recorded } from './perf';

describe('the median of a set of runs', () => {
  it('is the middle one, whatever order they came in', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([9, 2, 7, 4, 1, 8, 3])).toBe(4);
  });

  it('is the mean of the middle two of an even number', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('leaves the runs it was handed in their order', () => {
    const runs = [3, 1, 2];
    median(runs);
    expect(runs).toEqual([3, 1, 2]);
  });
});

describe('a frame judged against its baseline', () => {
  it('passes within the tolerance either way', () => {
    const v = judge({ arena: 1.1, field: 0.9 }, { arena: 1, field: 1 });
    expect(v.every((x) => x.ok)).toBe(true);
  });

  it('fails a frame slower than the baseline by more than the tolerance', () => {
    const [v] = judge({ arena: 1 + TOLERANCE + 0.01 }, { arena: 1 });
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/slower/);
  });

  it('fails a frame quicker by more than the tolerance, which is as much a change', () => {
    const [v] = judge({ arena: 1 - TOLERANCE - 0.01 }, { arena: 1 });
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/quicker/);
  });

  it('passes a scene with no baseline, and says it has none', () => {
    const [v] = judge({ arena: 3 }, undefined);
    expect(v.ok).toBe(true);
    expect(v.baseline).toBeUndefined();
    expect(v.why).toMatch(/no baseline/);
  });

  it('passes a scene the baseline does not name, and says so', () => {
    const [v] = judge({ field: 3 }, { arena: 1 });
    expect(v.ok).toBe(true);
    expect(v.why).toMatch(/no baseline/);
  });
});

describe('the baseline kept for an adapter', () => {
  const file = { 'apple/metal-3': { arena: 0.6 }, 'nvidia/ampere': { arena: 0.3 } };

  it('is the one recorded under its key', () => {
    expect(recorded(JSON.stringify(file), 'apple/metal-3')).toEqual({ arena: 0.6 });
  });

  it('is none for an adapter never measured, or a file not written yet', () => {
    expect(recorded(JSON.stringify(file), 'intel/gen-12')).toBeUndefined();
    expect(recorded('', 'apple/metal-3')).toBeUndefined();
  });
});
