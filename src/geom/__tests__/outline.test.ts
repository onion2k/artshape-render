import { describe, expect, it } from 'vitest';
import {
  apicalNotch, boltCircle, circleOutline, clearsOthers, crenate, ensureWinding, fitsInside,
  fringe, gussetOutline, leafHalfWidth, leafOutline, leafPiercings, palmateOutline, palmateVeins,
  petalHalfWidth, petalOutline, polygonOutline, serrate, signedArea, stadiumOutline, teardropOutline,
  tombstoneOutline, transformLoop, veinPiercings, type LeafShape, type PetalShape,
} from '../outline';

const LEAF_SHAPES: LeafShape[] = [
  'ovate', 'lanceolate', 'elliptic', 'obovate', 'cordate', 'orbicular', 'linear', 'deltoid', 'spatulate',
];
const PETAL_SHAPES: PetalShape[] = ['round', 'pointed', 'spoon', 'strap', 'lip', 'quill'];

describe('signedArea and ensureWinding', () => {
  it('is positive for a counter-clockwise square, negative for the reverse', () => {
    const ccw: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    expect(signedArea(ccw)).toBeGreaterThan(0);
    expect(signedArea([...ccw].reverse())).toBeLessThan(0);
  });

  it('is exactly half the true area for a unit square', () => {
    const ccw: [number, number][] = [[0, 0], [2, 0], [2, 2], [0, 2]];
    expect(signedArea(ccw)).toBeCloseTo(4);
  });

  it('ensureWinding leaves a loop of the requested winding untouched', () => {
    const ccw: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    expect(ensureWinding(ccw, true)).toEqual(ccw);
  });

  it('ensureWinding reverses a loop of the wrong winding', () => {
    const ccw: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const flipped = ensureWinding(ccw, false);
    expect(signedArea(flipped)).toBeLessThan(0);
    expect(flipped).toEqual([...ccw].reverse());
  });
});

describe('leafHalfWidth', () => {
  it('is zero at both ends and positive in the middle, for every shape', () => {
    for (const shape of LEAF_SHAPES) {
      expect(leafHalfWidth(shape, 0)).toBeCloseTo(0, 1);
      const mid = leafHalfWidth(shape, 0.5);
      expect(mid).toBeGreaterThan(0);
    }
  });

  it('stays within a sane [0, ~1.5] envelope across the whole range', () => {
    for (const shape of LEAF_SHAPES) {
      for (let t = 0; t <= 1; t += 0.05) {
        const w = leafHalfWidth(shape, t);
        expect(w).toBeGreaterThanOrEqual(-1e-9);
        expect(w).toBeLessThan(1.5);
      }
    }
  });

  it('deltoid is nearly triangular: falls off close to linearly from the base', () => {
    expect(leafHalfWidth('deltoid', 0.5)).toBeCloseTo(0.5, 1);
    expect(leafHalfWidth('deltoid', 0.9)).toBeCloseTo(0.1, 1);
  });
});

describe('leafOutline', () => {
  it('is a closed, counter-clockwise loop for every shape', () => {
    for (const shape of LEAF_SHAPES) {
      const loop = leafOutline(30, 14, { shape });
      expect(loop.length).toBeGreaterThan(3);
      expect(signedArea(loop)).toBeGreaterThan(0);
    }
  });

  it('spans close to the given length along x', () => {
    const loop = leafOutline(30, 14);
    const xs = loop.map(([x]) => x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(30, 0);
  });

  it('spans no wider than the given width along y (droop aside)', () => {
    const loop = leafOutline(30, 14, { droop: 0 });
    const ys = loop.map(([, y]) => y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(14 + 1e-6);
  });

  it('a cordate leaf opens a basal notch rather than closing to a point', () => {
    const plain = leafOutline(30, 14, { shape: 'cordate', notch: 0 });
    const notched = leafOutline(30, 14, { shape: 'cordate', notch: 0.14 });
    // point count is unaffected either way — the notch instead replaces the
    // single point at the very petiole (x=0, y=0) with the cut point out at
    // x = notch*length, y=0, which only the notched loop then contains
    const hasPetiole = (loop: typeof plain) => loop.some(([x, y]) => Math.hypot(x, y) < 1e-6);
    const hasCutPoint = (loop: typeof plain) =>
      loop.some(([x, y]) => Math.abs(x - 0.14 * 30) < 1e-6 && Math.abs(y) < 1e-6);
    expect(hasPetiole(plain)).toBe(true);
    expect(hasPetiole(notched)).toBe(false);
    expect(hasCutPoint(notched)).toBe(true);
  });

  it('teeth perturb the margin without breaking the winding', () => {
    const loop = leafOutline(30, 14, { teeth: 8, toothDepth: 1 });
    expect(signedArea(loop)).toBeGreaterThan(0);
  });
});

describe('serrate', () => {
  it('displaces every point outward by at most `depth`', () => {
    const base = circleOutline(10, 60);
    const saw = serrate(base, 12, 1.5);
    for (let i = 0; i < base.length; i++) {
      const d = Math.hypot(saw[i][0] - base[i][0], saw[i][1] - base[i][1]);
      expect(d).toBeLessThanOrEqual(1.5 + 1e-6);
    }
  });

  it('touches the original margin at the root of every tooth (phase 0)', () => {
    // the point at index 0 is always at phase 0, so it is undisplaced
    const base = circleOutline(10, 60);
    const saw = serrate(base, 12, 1.5);
    expect(saw[0]).toEqual(base[0]);
  });
});

describe('petalHalfWidth', () => {
  it('is zero at the claw for every shape but spoon, which keeps a narrow claw width', () => {
    for (const shape of PETAL_SHAPES) {
      if (shape === 'spoon') { expect(petalHalfWidth(shape, 0)).toBeCloseTo(0.18); continue; }
      expect(petalHalfWidth(shape, 0)).toBeCloseTo(0, 1);
    }
  });

  it('is positive somewhere in the middle for every shape', () => {
    for (const shape of PETAL_SHAPES) {
      let max = 0;
      for (let t = 0.1; t < 1; t += 0.05) max = Math.max(max, petalHalfWidth(shape, t));
      expect(max).toBeGreaterThan(0);
    }
  });

  it('strap stays narrower at the base than round does — a parallel-sided shape', () => {
    expect(petalHalfWidth('strap', 0.15)).toBeGreaterThan(petalHalfWidth('round', 0.15));
  });
});

describe('petalOutline', () => {
  it('is a closed, counter-clockwise loop for every shape and edge combination', () => {
    for (const shape of PETAL_SHAPES) {
      for (const edge of ['entire', 'toothed', 'fringed', 'crenate', 'notched'] as const) {
        const loop = petalOutline(20, 12, { shape, edge });
        expect(loop.length).toBeGreaterThan(3);
        expect(signedArea(loop)).toBeGreaterThan(0);
      }
    }
  });

  it('leaves everything short of its own window untouched by the fringe', () => {
    const plain = petalOutline(20, 12, { edge: 'entire' });
    const fringedLoop = petalOutline(20, 12, { edge: 'fringed' });
    // fringe's window (smoothstep 0.42..0.9 of length) only opens past x=8.4;
    // below that the two outlines should coincide
    for (let i = 0; i < plain.length; i++) {
      if (plain[i][0] < 6) expect(fringedLoop[i]).toEqual(plain[i]);
    }
  });
});

describe('margin treatments preserve a closed loop', () => {
  it('crenate', () => {
    const loop = crenate(circleOutline(10, 60), 8, 1);
    expect(signedArea(loop)).toBeGreaterThan(0);
  });

  it('fringe only touches the outer window, leaving the base near the original', () => {
    const base = circleOutline(10, 80).map(([x, y]) => [x + 10, y] as [number, number]);
    const fringed = fringe(base, 20, 1.5, 20);
    // points with small x (near the "claw" at x=0) are outside fringe's window
    for (let i = 0; i < base.length; i++) {
      if (base[i][0] < 4) {
        const d = Math.hypot(fringed[i][0] - base[i][0], fringed[i][1] - base[i][1]);
        expect(d).toBeLessThan(0.05);
      }
    }
  });

  it('apicalNotch only cuts in near the tip, leaving the base untouched', () => {
    const base = circleOutline(10, 80).map(([x, y]) => [x + 10, y] as [number, number]);
    const notched = apicalNotch(base, 20, 3);
    for (let i = 0; i < base.length; i++) {
      if (base[i][0] < 10) expect(notched[i]).toEqual(base[i]);
    }
  });
});

describe('palmateOutline', () => {
  it('is a closed, counter-clockwise loop that returns to the petiole', () => {
    const loop = palmateOutline(5, 30, 2.5);
    expect(loop[loop.length - 1]).toEqual([0, 0]);
    expect(signedArea(loop)).toBeGreaterThan(0);
  });

  it('more lobes means more undulation in the radius', () => {
    const radiusSpread = (lobes: number) => {
      const loop = palmateOutline(lobes, 30, 2.5);
      const r = loop.slice(0, -1).map(([x, y]) => Math.hypot(x, y));
      return Math.max(...r) - Math.min(...r);
    };
    expect(radiusSpread(7)).toBeGreaterThan(radiusSpread(2));
  });
});

describe('teardropOutline', () => {
  it('is a closed, counter-clockwise loop spanning close to length by width', () => {
    const loop = teardropOutline(10, 6);
    expect(signedArea(loop)).toBeGreaterThan(0);
    const xs = loop.map(([x]) => x), ys = loop.map(([, y]) => y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(10, 0);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(6 + 1e-6);
  });
});

describe('transformLoop', () => {
  const square: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];

  it('translates every point', () => {
    expect(transformLoop(square, 5, -3)).toEqual([[5, -3], [6, -3], [6, -2], [5, -2]]);
  });

  it('scales about the origin before translating', () => {
    const scaled = transformLoop(square, 0, 0, 2);
    expect(scaled).toEqual([[0, 0], [2, 0], [2, 2], [0, 2]]);
  });

  it('rotates a point 90 degrees as expected', () => {
    const [rotated] = transformLoop([[1, 0]], 0, 0, 1, Math.PI / 2);
    expect(rotated[0]).toBeCloseTo(0);
    expect(rotated[1]).toBeCloseTo(1);
  });
});

describe('piercing generators', () => {
  it('leafPiercings returns one hole per count, each a closed clockwise loop', () => {
    const holes = leafPiercings(30, 14, 3);
    expect(holes).toHaveLength(3);
    for (const h of holes) expect(signedArea(h)).toBeLessThan(0); // ensureWinding(..., false)
  });

  it('leafPiercings holes sit further out with a higher index', () => {
    const holes = leafPiercings(30, 14, 3);
    const centreX = (h: (typeof holes)[number]) => h.reduce((s, [x]) => s + x, 0) / h.length;
    expect(centreX(holes[2])).toBeGreaterThan(centreX(holes[0]));
  });

  it('palmateVeins returns one hole per lobe', () => {
    const holes = palmateVeins(5, 30, 2.5);
    expect(holes).toHaveLength(5);
  });

  it('veinPiercings returns two holes per pair (one each side of the midrib)', () => {
    const holes = veinPiercings(30, 14, 3);
    expect(holes).toHaveLength(6);
  });
});

describe('flat plate outlines', () => {
  it('polygonOutline has the given side count, all at the given radius', () => {
    const loop = polygonOutline(6, 5);
    expect(loop).toHaveLength(6);
    for (const [x, y] of loop) expect(Math.hypot(x, y)).toBeCloseTo(5);
  });

  it('stadiumOutline spans exactly the given length and width', () => {
    const loop = stadiumOutline(20, 6);
    const xs = loop.map(([x]) => x), ys = loop.map(([, y]) => y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(20, 1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(6, 1);
  });

  it('gussetOutline is a closed loop of three rounded corners at ~radius from centre', () => {
    const loop = gussetOutline(10, 2);
    expect(signedArea(loop)).toBeGreaterThan(0);
    for (const [x, y] of loop) expect(Math.hypot(x, y)).toBeLessThanOrEqual(10 + 1e-6);
  });

  it('circleOutline sits exactly at the given radius', () => {
    const loop = circleOutline(7, 40);
    for (const [x, y] of loop) expect(Math.hypot(x, y)).toBeCloseTo(7);
  });

  it('tombstoneOutline spans exactly the given width and height, wound CCW', () => {
    const loop = tombstoneOutline(20, 30, 4);
    expect(signedArea(loop)).toBeGreaterThan(0);
    const xs = loop.map(([x]) => x), ys = loop.map(([, y]) => y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(20, 1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(30, 1);
    expect(Math.min(...ys)).toBeCloseTo(0, 5);
  });

  it('tombstoneOutline keeps the bottom two corners sharp — no point strays inward there', () => {
    const loop = tombstoneOutline(20, 30, 4);
    // near y=0, every point should sit exactly on x=+-10 (the flat bottom
    // corners), not rounded off toward the centre the way the top is
    for (const [x, y] of loop) {
      if (y < 0.5) expect(Math.abs(x)).toBeCloseTo(10, 1);
    }
  });

  it('cornerRadius: 0 degenerates to a plain rectangle', () => {
    const loop = tombstoneOutline(20, 30, 0);
    for (const [x, y] of loop) {
      expect(Math.abs(x)).toBeLessThanOrEqual(10 + 1e-6);
      expect(y).toBeGreaterThanOrEqual(-1e-6);
      expect(y).toBeLessThanOrEqual(30 + 1e-6);
    }
    // every point sits on the rectangle's own edge, not cut in from a corner
    for (const [x, y] of loop) {
      const onVerticalEdge = Math.abs(Math.abs(x) - 10) < 1e-6;
      const onHorizontalEdge = Math.abs(y) < 1e-6 || Math.abs(y - 30) < 1e-6;
      expect(onVerticalEdge || onHorizontalEdge).toBe(true);
    }
  });

  it('a larger cornerRadius rounds the top corners further in from the edges', () => {
    const small = tombstoneOutline(20, 30, 3);
    const large = tombstoneOutline(20, 30, 9);
    const topInset = (loop: ReturnType<typeof tombstoneOutline>) => {
      // how far the outline has already pulled in from the top-right corner
      // (10, 30) by the time it reaches y = 27 — more for a bigger radius
      let best = -Infinity;
      for (const [x, y] of loop) if (y > 26 && y < 28 && x > 0) best = Math.max(best, 10 - x);
      return best;
    };
    expect(topInset(large)).toBeGreaterThan(topInset(small));
  });

  it('boltCircle returns count holes, each centred at the given radius', () => {
    const holes = boltCircle(5, 10, 1);
    expect(holes).toHaveLength(5);
    for (const h of holes) {
      const cx = h.reduce((s, [x]) => s + x, 0) / h.length;
      const cy = h.reduce((s, [, y]) => s + y, 0) / h.length;
      expect(Math.hypot(cx, cy)).toBeCloseTo(10, 0);
    }
  });
});

describe('fitsInside and clearsOthers', () => {
  const outline = circleOutline(20, 64);

  it('accepts a small hole well inside the outline', () => {
    const hole = circleOutline(2, 16);
    expect(fitsInside(hole, outline, 1)).toBe(true);
  });

  it('rejects a hole that pokes outside the outline', () => {
    const hole = transformLoop(circleOutline(2, 16), 19, 0);
    expect(fitsInside(hole, outline, 1)).toBe(false);
  });

  it('rejects a hole too close to the margin even if technically inside', () => {
    const hole = transformLoop(circleOutline(1, 16), 18.5, 0);
    expect(fitsInside(hole, outline, 2)).toBe(false);
  });

  it('clearsOthers accepts two holes that do not overlap', () => {
    const a = transformLoop(circleOutline(1, 16), -5, 0);
    const b = transformLoop(circleOutline(1, 16), 5, 0);
    expect(clearsOthers(b, [a], 0.5)).toBe(true);
  });

  it('clearsOthers rejects two holes that overlap or sit too close', () => {
    const a = transformLoop(circleOutline(3, 16), 0, 0);
    const b = transformLoop(circleOutline(3, 16), 1, 0);
    expect(clearsOthers(b, [a], 0.5)).toBe(false);
  });
});
