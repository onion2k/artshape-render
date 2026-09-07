import { describe, expect, it } from 'vitest';
import { add, cross, dot, frameFrom, len, mul, normalize, perpendicular, sub, v3 } from '../vec';
import { expectVec } from './helpers';

describe('vec basics', () => {
  it('adds, subtracts and scales componentwise', () => {
    expect(add([1, 2, 3], [4, 5, 6])).toEqual([5, 7, 9]);
    expect(sub([4, 5, 6], [1, 2, 3])).toEqual([3, 3, 3]);
    expect(mul([1, 2, 3], 2)).toEqual([2, 4, 6]);
  });

  it('computes dot and length', () => {
    expect(dot([1, 0, 0], [0, 1, 0])).toBe(0);
    expect(dot([1, 2, 3], [1, 2, 3])).toBe(14);
    expect(len([3, 4, 0])).toBe(5);
  });

  it('v3 is just a labelled tuple constructor', () => {
    expect(v3(1, 2, 3)).toEqual([1, 2, 3]);
  });

  it('cross is perpendicular to both inputs and right-handed', () => {
    expect(cross([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1]);
    expect(cross([0, 1, 0], [1, 0, 0])).toEqual([0, 0, -1]);
  });

  it('normalize gives a unit vector in the same direction', () => {
    const n = normalize([3, 4, 0]);
    expect(len(n)).toBeCloseTo(1);
    expectVec(n, [0.6, 0.8, 0]);
  });

  it('normalize treats the zero vector as length 1 rather than dividing by zero', () => {
    expect(normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe('perpendicular', () => {
  it('returns a unit vector perpendicular to its input', () => {
    for (const a of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1], [0.9, 0, 0.436]] as const) {
      const p = perpendicular(a as [number, number, number]);
      expect(len(p)).toBeCloseTo(1);
      expect(dot(p, a as [number, number, number])).toBeCloseTo(0);
    }
  });
});

describe('frameFrom', () => {
  it('builds an orthonormal right-handed frame from z alone', () => {
    const { x, y, z } = frameFrom([0, 0, 1]);
    expect(len(x)).toBeCloseTo(1);
    expect(len(y)).toBeCloseTo(1);
    expect(dot(x, y)).toBeCloseTo(0);
    expect(dot(x, z)).toBeCloseTo(0);
    expect(dot(y, z)).toBeCloseTo(0);
    expectVec(cross(x, y), z);
  });

  it('leans x toward the hint when one is given', () => {
    const { x, z } = frameFrom([0, 0, 1], [1, 0.0001, 0]);
    expect(dot(x, [1, 0, 0])).toBeGreaterThan(0.99);
    expect(dot(x, z)).toBeCloseTo(0);
  });

  it('falls back to an arbitrary perpendicular when the hint is parallel to z', () => {
    const { x, y, z } = frameFrom([0, 0, 1], [0, 0, 5]);
    expect(len(x)).toBeCloseTo(1);
    expect(dot(x, z)).toBeCloseTo(0);
    expectVec(cross(x, y), z);
  });
});
