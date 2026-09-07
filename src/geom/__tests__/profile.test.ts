import { describe, expect, it } from 'vitest';
import {
  circle, dedupeClosed, ellipse, lens, morphProfile, polygon, ribbon, scaleProfile, teardrop,
} from '../profile';

describe('circle and ellipse', () => {
  it('circle produces `segments` points, all at the given radius, none sharp', () => {
    const p = circle(5, 12);
    expect(p.points).toHaveLength(12);
    expect(p.sharp).toEqual(p.sharp.map(() => false));
    for (const [x, y] of p.points) expect(Math.hypot(x, y)).toBeCloseTo(5);
  });

  it('ellipse scales x and y independently', () => {
    const p = ellipse(4, 2, 4);
    // at angle 0 the point is (rx, 0); the segment count of 4 also puts one at angle pi/2 -> (0, ry)
    expect(p.points[0][0]).toBeCloseTo(4);
    expect(p.points[0][1]).toBeCloseTo(0);
    expect(p.points[1][0]).toBeCloseTo(0);
    expect(p.points[1][1]).toBeCloseTo(2);
  });
});

describe('lens', () => {
  it('is symmetric about the x axis and comes to a point at each tip', () => {
    const p = lens(10, 3, 16);
    // the two sharp points are the tips at x = ±width/2
    const sharpXs = p.points.filter((_, i) => p.sharp[i]).map(([x]) => x);
    expect(sharpXs).toHaveLength(2);
    expect(Math.max(...sharpXs)).toBeCloseTo(5, 1);
    expect(Math.min(...sharpXs)).toBeCloseTo(-5, 1);
  });

  it('is at its thickest at the middle', () => {
    const p = lens(10, 3, 32);
    const nearMid = p.points.filter(([x]) => Math.abs(x) < 0.5);
    for (const [, y] of nearMid) expect(Math.abs(y)).toBeLessThanOrEqual(1.51);
  });
});

describe('polygon', () => {
  it('produces `sides` points at the given radius, all sharp', () => {
    const p = polygon(6, 4);
    expect(p.points).toHaveLength(6);
    expect(p.sharp.every(Boolean)).toBe(true);
    for (const [x, y] of p.points) expect(Math.hypot(x, y)).toBeCloseTo(4);
  });

  it('rotate offsets the first vertex', () => {
    const p = polygon(4, 1, Math.PI / 4);
    expect(p.points[0][0]).toBeCloseTo(Math.SQRT1_2);
    expect(p.points[0][1]).toBeCloseTo(Math.SQRT1_2);
  });
});

describe('ribbon', () => {
  it('stays within its stated width and thickness', () => {
    const p = ribbon(10, 3);
    for (const [x, y] of p.points) {
      expect(Math.abs(x)).toBeLessThanOrEqual(5 + 1e-6);
      expect(Math.abs(y)).toBeLessThanOrEqual(1.5 + 1e-6);
    }
  });

  it('has no duplicate consecutive points (the degenerate-edge bug dedupeClosed exists for)', () => {
    const p = ribbon(10, 3);
    for (let i = 0; i < p.points.length; i++) {
      const a = p.points[i];
      const b = p.points[(i + 1) % p.points.length];
      expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeGreaterThan(1e-6);
    }
  });
});

describe('teardrop', () => {
  it('comes to a sharp point beyond the radius', () => {
    const p = teardrop(4, 2, 20);
    expect(p.sharp[0]).toBe(true);
    expect(p.points[0]).toEqual([6, 0]);
  });

  it('pinches the waist just behind the point, and is unpinched on the far side', () => {
    const p = teardrop(4, 2, 20);
    // index 0 is overridden to the point itself; index 1 sits just behind it,
    // where the pinch factor is close to its maximum
    const waist = Math.hypot(...p.points[1]);
    expect(waist).toBeLessThan(4);
    // directly opposite the point (angle = pi) the pinch factor is zero
    const far = p.points[10];
    expect(Math.hypot(...far)).toBeCloseTo(4, 1);
  });
});

describe('dedupeClosed', () => {
  it('drops a point that coincides with its predecessor, wrapping at the seam', () => {
    const p = dedupeClosed({
      points: [[0, 0], [1, 0], [1, 0], [1, 1]],
      sharp: [false, false, false, false],
    });
    expect(p.points).toEqual([[0, 0], [1, 0], [1, 1]]);
  });

  it('keeps a crease when the point it merges into carried one', () => {
    const p = dedupeClosed({
      points: [[0, 0], [1, 0], [1, 0]],
      sharp: [false, false, true],
    });
    expect(p.sharp).toEqual([false, true]);
  });

  it('leaves a profile with no duplicates unchanged', () => {
    const src = circle(5, 8);
    expect(dedupeClosed(src).points).toEqual(src.points);
  });
});

describe('scaleProfile', () => {
  it('scales every point and leaves sharp flags untouched', () => {
    const src = polygon(4, 2);
    const scaled = scaleProfile(src, 3);
    expect(scaled.points[0]).toEqual([src.points[0][0] * 3, src.points[0][1] * 3]);
    expect(scaled.sharp).toBe(src.sharp);
  });

  it('a scale of 0 collapses every point to the origin', () => {
    const scaled = scaleProfile(circle(5, 6), 0);
    for (const [x, y] of scaled.points) { expect(x).toBeCloseTo(0); expect(y).toBeCloseTo(0); }
  });
});

describe('morphProfile', () => {
  it('is a at t=0 and b at t=1', () => {
    const a = circle(4, 8);
    const b = polygon(8, 6);
    expect(morphProfile(a, b, 0).points).toEqual(a.points);
    expect(morphProfile(a, b, 1).points).toEqual(b.points);
  });

  it('interpolates linearly in between', () => {
    const a = circle(4, 8);
    const b = polygon(8, 6);
    const mid = morphProfile(a, b, 0.5);
    for (let i = 0; i < mid.points.length; i++) {
      expect(mid.points[i][0]).toBeCloseTo((a.points[i][0] + b.points[i][0]) / 2);
      expect(mid.points[i][1]).toBeCloseTo((a.points[i][1] + b.points[i][1]) / 2);
    }
  });

  it('a crease survives if either end has one', () => {
    const round = circle(4, 8);
    const sharpSquare = polygon(8, 6);
    const mid = morphProfile(round, sharpSquare, 0.5);
    expect(mid.sharp.every(Boolean)).toBe(true);
  });

  it('rejects profiles with different point counts', () => {
    expect(() => morphProfile(circle(4, 8), circle(4, 6), 0.5)).toThrow(/equal point counts/);
  });
});
