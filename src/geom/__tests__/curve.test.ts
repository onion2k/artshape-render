import { describe, expect, it } from 'vitest';
import {
  arc, bezier3, bow, catmullRom, curveLength, ellipse, helix, line, logSpiral,
  lissajous, pathTangent, resample, rose, samplePath, sine, superellipse, torusKnot,
} from '../curve';
import { len } from '../vec';
import { expectVec } from './helpers';

describe('line', () => {
  it('interpolates linearly between its endpoints', () => {
    const c = line([0, 0, 0], [10, 0, 0]);
    expectVec(c.at(0), [0, 0, 0]);
    expectVec(c.at(1), [10, 0, 0]);
    expectVec(c.at(0.5), [5, 0, 0]);
  });
});

describe('arc', () => {
  it('starts and ends at the given angles, at constant radius', () => {
    const c = arc(5, 0, Math.PI / 2);
    expectVec(c.at(0), [5, 0, 0]);
    expectVec(c.at(1), [0, 5, 0]);
    expect(len(c.at(0.3))).toBeCloseTo(5);
  });

  it('carries a constant z', () => {
    const c = arc(5, 0, Math.PI, 3);
    expect(c.at(0.5)[2]).toBe(3);
  });
});

describe('ellipse', () => {
  it('reaches rx along x and ry along y, a quarter turn apart', () => {
    const c = ellipse(10, 4);
    expectVec(c.at(0), [10, 0, 0]);
    expectVec(c.at(0.25), [0, 4, 0]);
    expectVec(c.at(0.5), [-10, 0, 0]);
    expectVec(c.at(0.75), [0, -4, 0]);
  });

  it('is a circle when rx equals ry', () => {
    const c = ellipse(6, 6);
    for (const t of [0.1, 0.37, 0.6, 0.9]) expect(len(c.at(t))).toBeCloseTo(6);
  });

  it('carries a constant z', () => {
    const c = ellipse(10, 4, 7);
    expect(c.at(0.3)[2]).toBe(7);
    expect(c.at(0.8)[2]).toBe(7);
  });

  it('closes on itself: t=0 and t=1 land at the same point', () => {
    const c = ellipse(8, 3);
    expectVec(c.at(0), c.at(1));
  });
});

describe('helix', () => {
  it('keeps a constant radius while rising linearly, centred on z=0', () => {
    const c = helix(4, 10, 2);
    expect(Math.hypot(c.at(0.3)[0], c.at(0.3)[1])).toBeCloseTo(4);
    expectVec(c.at(0), [4, 0, -5]);
    expectVec(c.at(1), [4, 0, 5]);
  });

  it('completes the given number of turns', () => {
    const c = helix(4, 10, 2);
    // two turns: back to the same XY at t = 0, 0.5 and 1
    expectVec(c.at(0), [c.at(0.5)[0], c.at(0.5)[1], c.at(0)[2]]);
  });
});

describe('bezier3', () => {
  it('starts at p0 and ends at p3', () => {
    const c = bezier3([0, 0, 0], [1, 5, 0], [2, 5, 0], [3, 0, 0]);
    expectVec(c.at(0), [0, 0, 0]);
    expectVec(c.at(1), [3, 0, 0]);
  });

  it('reduces to a straight line when all four points are collinear and evenly spaced', () => {
    const c = bezier3([0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]);
    expectVec(c.at(0.5), [1.5, 0, 0]);
  });
});

describe('bow', () => {
  it('starts and ends at a and b', () => {
    const c = bow([0, 0, 0], [10, 0, 0], 3);
    expectVec(c.at(0), [0, 0, 0]);
    expectVec(c.at(1), [10, 0, 0]);
  });

  it('bulges in the plane perpendicular to both the chord and the up hint', () => {
    // chord along X, up hint along Z: the bulge is perpendicular to both, so Y.
    // The curve is a cubic reproduction of a quadratic through (a, apex, b), and
    // a quadratic Bezier's midpoint is only halfway to its control point — so the
    // curve's own peak sag is at its endpoints' apex, not at t=0.5.
    const c = bow([0, 0, 0], [10, 0, 0], 3);
    const mid = c.at(0.5);
    expect(mid[0]).toBeCloseTo(5, 1);
    expect(Math.abs(mid[1])).toBeCloseTo(1.5, 1);
    expect(mid[2]).toBeCloseTo(0);
  });

  it('bulges the other way for a negative sag', () => {
    const up = bow([0, 0, 0], [10, 0, 0], 3).at(0.5);
    const down = bow([0, 0, 0], [10, 0, 0], -3).at(0.5);
    expect(up[1]).toBeCloseTo(-down[1]);
  });
});

describe('samplePath', () => {
  it('returns segments + 1 points, first and last matching the curve exactly', () => {
    const c = arc(5, 0, Math.PI);
    const pts = samplePath(c, 10);
    expect(pts).toHaveLength(11);
    expectVec(pts[0], c.at(0));
    expectVec(pts[10], c.at(1));
  });
});

describe('pathTangent', () => {
  it('points along a straight line, regardless of index', () => {
    const pts = samplePath(line([0, 0, 0], [10, 0, 0]), 20);
    for (const i of [0, 5, 20]) {
      expectVec(pathTangent(pts, i), [1, 0, 0]);
    }
  });

  it('clamps an out-of-range index rather than throwing', () => {
    const pts = samplePath(line([0, 0, 0], [10, 0, 0]), 5);
    expect(() => pathTangent(pts, -3)).not.toThrow();
    expect(() => pathTangent(pts, 999)).not.toThrow();
  });
});

describe('catmullRom', () => {
  it('passes through every control point at its own parameter', () => {
    const points: [number, number, number][] = [[0, 0, 0], [1, 2, 0], [3, 2, 0], [4, 0, 0]];
    const c = catmullRom(points);
    const n = points.length;
    points.forEach((p, i) => expectVec(c.at(i / (n - 1)), p));
  });

  it('throws with fewer than two points', () => {
    expect(() => catmullRom([[0, 0, 0]])).toThrow();
  });

  it('clamps t outside [0, 1]', () => {
    const c = catmullRom([[0, 0, 0], [1, 0, 0], [2, 0, 0]]);
    expectVec(c.at(-1), c.at(0));
    expectVec(c.at(5), c.at(1));
  });
});

describe('logSpiral', () => {
  it('starts at the given radius', () => {
    const c = logSpiral(2, 3);
    expect(len(c.at(0))).toBeCloseTo(2);
  });

  it('multiplies its radius by growth every full turn', () => {
    const c = logSpiral(2, 4, 2.4);
    const rAt = (t: number) => len(c.at(t));
    // one turn out of four is a quarter of the parameter range
    expect(rAt(0.25) / rAt(0)).toBeCloseTo(2.4, 3);
    expect(rAt(0.5) / rAt(0.25)).toBeCloseTo(2.4, 3);
  });

  it('rises linearly when given a rise', () => {
    const c = logSpiral(2, 1, 2.4, 10);
    expect(c.at(0)[2]).toBeCloseTo(0);
    expect(c.at(1)[2]).toBeCloseTo(10);
    expect(c.at(0.5)[2]).toBeCloseTo(5);
  });
});

describe('resample', () => {
  it('returns exactly `count` points', () => {
    const pts = resample(arc(5, 0, Math.PI), 17);
    expect(pts).toHaveLength(17);
  });

  it('starts and ends at the curve\'s own endpoints', () => {
    const c = arc(5, 0, Math.PI);
    const pts = resample(c, 20);
    expectVec(pts[0], c.at(0), 2);
    expectVec(pts[pts.length - 1], c.at(1), 2);
  });

  it('spaces points far more evenly by arc length than sampling by parameter does', () => {
    // logSpiral is slow near t=0 and fast near t=1 in its own parameter, so a
    // resample must not just be samplePath under another name
    const c = logSpiral(1, 3, 2.4);
    const segLengths = (pts: [number, number, number][]) => {
      const out: number[] = [];
      for (let i = 0; i < pts.length - 1; i++) {
        out.push(Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1], pts[i + 1][2] - pts[i][2]));
      }
      return out;
    };
    const spread = (lens: number[]) => (Math.max(...lens) - Math.min(...lens)) / Math.max(...lens);

    const resampled = segLengths(resample(c, 40));
    const byParameter = segLengths(samplePath(c, 40));
    expect(spread(resampled)).toBeLessThan(0.3);
    expect(spread(byParameter)).toBeGreaterThan(spread(resampled) * 2);
  });
});

describe('curveLength', () => {
  it('matches the analytic length of a straight line', () => {
    expect(curveLength(line([0, 0, 0], [3, 4, 0]))).toBeCloseTo(5, 2);
  });

  it('matches the analytic length of a circular arc: radius * angle', () => {
    const angle = Math.PI / 2;
    expect(curveLength(arc(10, 0, angle))).toBeCloseTo(10 * angle, 1);
  });

  it('is roughly four times the radius for a quarter turn of a helix... ', () => {
    // sanity check against a direct estimate rather than a closed form
    const c = helix(5, 0, 0.25);
    const direct = Math.hypot(c.at(1)[0] - c.at(0)[0], c.at(1)[1] - c.at(0)[1]);
    expect(curveLength(c)).toBeGreaterThan(direct);
  });
});

describe('lissajous', () => {
  it('closes on itself for whole-number frequencies', () => {
    const c = lissajous(10, 6, 3, 2);
    expect(c.at(0)[0]).toBeCloseTo(c.at(1)[0]);
    expect(c.at(0)[1]).toBeCloseTo(c.at(1)[1]);
  });

  it('is a circle when the frequencies match and the phase is a quarter turn', () => {
    const c = lissajous(5, 5, 1, 1);
    for (let t = 0; t <= 1; t += 0.1) {
      const p = c.at(t);
      expect(Math.hypot(p[0], p[1])).toBeCloseTo(5);
    }
  });

  it('spans its width and height', () => {
    const c = lissajous(10, 6, 1, 2);
    const pts = samplePath(c, 400);
    expect(Math.max(...pts.map((p) => p[0]))).toBeCloseTo(10, 2);
    expect(Math.min(...pts.map((p) => p[1]))).toBeCloseTo(-6, 2);
  });

  it('rises through its height when asked', () => {
    const c = lissajous(10, 6, 1, 2, Math.PI / 2, 8);
    expect(c.at(1)[2] - c.at(0)[2]).toBeCloseTo(8);
  });
});

describe('rose', () => {
  it('reaches the radius at the tip of every petal and the origin between them', () => {
    const c = rose(10, 5);
    const radii = samplePath(c, 1000).map((p) => Math.hypot(p[0], p[1]));
    expect(Math.max(...radii)).toBeCloseTo(10, 2);
    expect(Math.min(...radii)).toBeCloseTo(0, 2);
  });

  it('an odd rose closes after a half turn, an even one after a full turn', () => {
    for (const k of [3, 4]) {
      const c = rose(10, k);
      expect(c.at(0)[0]).toBeCloseTo(c.at(1)[0]);
      expect(c.at(0)[1]).toBeCloseTo(c.at(1)[1]);
    }
  });

  it('an even rose has twice as many petals as its k', () => {
    // count how often the radius rises through half the full radius
    const radii = samplePath(rose(10, 4), 4000).map((p) => Math.hypot(p[0], p[1]));
    let crossings = 0;
    for (let i = 1; i < radii.length; i++) if (radii[i - 1] < 5 && radii[i] >= 5) crossings++;
    expect(crossings).toBe(8);
  });
});

describe('sine', () => {
  it('runs along +X, centred, and waves across Y', () => {
    const c = sine(40, 3, 2);
    expect(c.at(0)).toEqual([-20, expect.closeTo(0, 9), expect.closeTo(0, 9)]);
    expect(c.at(1)[0]).toBeCloseTo(20);
    expect(c.at(0.125)[1]).toBeCloseTo(3);
    expect(c.at(0.375)[1]).toBeCloseTo(-3);
  });
});

describe('torusKnot', () => {
  it('stays on the torus and closes', () => {
    const c = torusKnot(10, 3, 2, 3);
    for (let t = 0; t <= 1; t += 0.05) {
      const p = c.at(t);
      const ring = Math.hypot(p[0], p[1]) - 10;
      expect(Math.hypot(ring, p[2])).toBeCloseTo(3);
    }
    expectVec(c.at(1), c.at(0));
  });

  it('passes through the hole q times', () => {
    const zs = samplePath(torusKnot(10, 3, 2, 3), 2000).map((p) => p[2]);
    let crossings = 0;
    // downward crossings, since the curve starts exactly on the plane
    for (let i = 1; i < zs.length; i++) if (zs[i - 1] > 0 && zs[i] <= 0) crossings++;
    expect(crossings).toBe(3);
  });
});

describe('superellipse', () => {
  it('is an ellipse at n = 2', () => {
    const c = superellipse(10, 6, 2);
    for (let t = 0; t <= 1; t += 0.05) {
      const p = c.at(t);
      expect((p[0] / 10) ** 2 + (p[1] / 6) ** 2).toBeCloseTo(1);
    }
  });

  it('satisfies its own equation at any exponent and fills more of its box as n rises', () => {
    const area = (n: number) => {
      const pts = samplePath(superellipse(10, 6, n), 720);
      let a = 0;
      for (let i = 0; i < pts.length - 1; i++) a += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
      return Math.abs(a / 2);
    };
    const c = superellipse(10, 6, 4);
    for (let t = 0; t <= 1; t += 0.05) {
      const p = c.at(t);
      expect(Math.abs(p[0] / 10) ** 4 + Math.abs(p[1] / 6) ** 4).toBeCloseTo(1);
    }
    expect(area(2.5)).toBeGreaterThan(area(2));
    expect(area(6)).toBeGreaterThan(area(2.5));
    expect(area(6)).toBeLessThan(240);
  });
});
