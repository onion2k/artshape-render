import { describe, expect, it } from 'vitest';
import {
  boltCircle, circleOutline, clearsOthers, ensureWinding, fitsInside, gussetOutline, leafOutline,
  palmateOutline, palmateVeins, polygonOutline, signedArea, stadiumOutline, teardropOutline,
  transformLoop,
} from '../outline';

describe('outline edge cases: degenerate counts', () => {
  it('polygonOutline(0, r) is an empty loop rather than throwing', () => {
    expect(polygonOutline(0, 5)).toEqual([]);
  });

  it('polygonOutline(1, r) is a single point', () => {
    expect(polygonOutline(1, 5)).toHaveLength(1);
  });

  it('polygonOutline(2, r) is two coincident-ish points, not a real polygon', () => {
    // sides=2 places both points at angle 0 and pi, i.e. opposite ends of a
    // diameter rather than a closed area — signedArea is (numerically) zero
    const loop = polygonOutline(2, 5);
    expect(loop).toHaveLength(2);
    expect(Math.abs(signedArea(loop))).toBeLessThan(1e-6);
  });

  it('boltCircle(0, ...) returns no holes', () => {
    expect(boltCircle(0, 10, 1)).toEqual([]);
  });

  it('leafOutline with segments=1 is degenerate but finite, not NaN', () => {
    const loop = leafOutline(30, 14, { segments: 1 });
    for (const [x, y] of loop) { expect(Number.isFinite(x)).toBe(true); expect(Number.isFinite(y)).toBe(true); }
  });

  it('leafOutline with width=0 collapses upper and lower margins onto the same drooped spine', () => {
    // width=0 does not mean y=0 — droop still bows the midrib sideways, so
    // "collapsed to a line" means the two margins coincide with each other,
    // not that the line sits on the x axis
    const withWidth = leafOutline(30, 14, { droop: 0.18 });
    const zeroWidth = leafOutline(30, 0, { droop: 0.18 });
    for (const [x, y] of zeroWidth) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
    // every point's y should match the pure spine formula (no half-width term)
    for (const [x, y] of zeroWidth) {
      const spine = Math.sin(Math.PI * Math.min(Math.max(x / 30, 0), 1)) * 0.18 * 30;
      expect(y).toBeCloseTo(spine, 1);
    }
    expect(withWidth).not.toEqual(zeroWidth);
  });
});

describe('outline edge cases: palmateVeins at a single lobe', () => {
  it('palmateOutline(1, ...) itself stays finite — the silhouette has no lobes-1 division', () => {
    const loop = palmateOutline(1, 30, 2.5);
    for (const [x, y] of loop) { expect(Number.isFinite(x)).toBe(true); expect(Number.isFinite(y)).toBe(true); }
  });

  it('palmateVeins(1, ...) places its one vein straight out along the midline (theta = 0)', () => {
    // a single lobe has no spread to distribute a vein's angle across, so
    // theta is 0 rather than the lobes>1 formula's 0/0
    const holes = palmateVeins(1, 30, 2.5);
    expect(holes).toHaveLength(1);
    for (const [x, y] of holes[0]) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
    const centreY = holes[0].reduce((s, [, y]) => s + y, 0) / holes[0].length;
    expect(centreY).toBeCloseTo(0, 1);
  });

  it('palmateVeins(2, ...) — two lobes — does not divide by zero and stays finite', () => {
    const holes = palmateVeins(2, 30, 2.5);
    for (const hole of holes) for (const [x, y] of hole) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
  });
});

describe('outline edge cases: gusset with an oversized fillet', () => {
  it('does not throw when fillet equals the radius (zero core)', () => {
    expect(() => gussetOutline(10, 10)).not.toThrow();
  });

  it('does not throw when fillet exceeds the radius, though the corners then overlap', () => {
    const loop = gussetOutline(10, 15);
    for (const [x, y] of loop) { expect(Number.isFinite(x)).toBe(true); expect(Number.isFinite(y)).toBe(true); }
  });
});

describe('outline edge cases: zero-ish inputs elsewhere', () => {
  it('teardropOutline with point=0 is a plain closed loop, no special case needed', () => {
    const loop = teardropOutline(10, 6);
    expect(signedArea(loop)).toBeGreaterThan(0);
  });

  it('stadiumOutline where width exceeds length collapses gracefully (half clamped to 0)', () => {
    // half = Math.max(length/2 - r, 0): a stadium wider than it is long has
    // no straight run at all, just the two end caps meeting
    const loop = stadiumOutline(4, 10);
    for (const [x, y] of loop) { expect(Number.isFinite(x)).toBe(true); expect(Number.isFinite(y)).toBe(true); }
  });

  it('transformLoop with scale=0 collapses every point onto the translation', () => {
    const loop = transformLoop([[1, 1], [2, 2], [-3, 4]], 5, 5, 0);
    for (const p of loop) expect(p).toEqual([5, 5]);
  });

  it('signedArea of an empty loop is 0, not NaN', () => {
    expect(signedArea([])).toBe(0);
  });

  it('signedArea of a single point is 0', () => {
    expect(signedArea([[3, 4]])).toBe(0);
  });

  it('ensureWinding on a zero-area loop does not throw (signedArea === 0 counts as not-CCW)', () => {
    expect(() => ensureWinding([[0, 0], [0, 0]], true)).not.toThrow();
  });
});

describe('outline edge cases: fitsInside / clearsOthers on empty input', () => {
  it('an empty hole trivially fits inside anything', () => {
    expect(fitsInside([], circleOutline(10), 1)).toBe(true);
  });

  it('clearsOthers with no other holes always clears', () => {
    expect(clearsOthers(circleOutline(2), [], 1)).toBe(true);
  });

  it('a hole that IS the outline itself does not fit (zero clearance everywhere)', () => {
    const outline = circleOutline(10, 32);
    expect(fitsInside(outline, outline, 0.5)).toBe(false);
  });
});
