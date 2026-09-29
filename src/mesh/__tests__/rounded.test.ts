/**
 * Rounded edges made in the geometry: a box rounded at every edge and
 * corner, and the corners of a profile rounded for a lathe, a sweep or an
 * extrusion to take. A toy's edges are moulded and catch the light; a box
 * with square edges catches none along them and reads as a prototype's.
 *
 * What each must be: closed where its shape is closed, smooth over every
 * round and flat on every face, exactly the size asked, and round at the
 * radius asked, or at the most the shape has room for.
 */
import { describe, expect, it } from 'vitest';
import { roundCorners, roundedBox } from '../rounded';
import { revolve } from '../revolve';
import { expectWatertight, expectWellFormed, boundsOf } from './helpers';
import type { Vec2 } from '../../geom/types';

const SIZE: [number, number, number] = [4, 2, 1.2];

/** Every vertex, with its normal. */
const verts = (m: ReturnType<typeof roundedBox>) =>
  Array.from({ length: m.positions.length / 3 }, (_, i) => ({
    p: [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]],
    n: [m.normals[i * 3], m.normals[i * 3 + 1], m.normals[i * 3 + 2]],
  }));

describe('a rounded box', () => {
  it('is a closed, well-formed mesh', () => {
    for (const radius of [0, 0.05, 0.3, 0.6]) {
      const m = roundedBox(SIZE, radius);
      expectWellFormed(m);
      expectWatertight(m);
    }
  });

  it('is exactly the size asked, centred where it is placed', () => {
    for (const radius of [0, 0.2, 0.6]) {
      const b = boundsOf(roundedBox(SIZE, radius));
      for (let k = 0; k < 3; k++) {
        expect(b.min[k]).toBeCloseTo(-SIZE[k] / 2, 6);
        expect(b.max[k]).toBeCloseTo(SIZE[k] / 2, 6);
      }
    }
  });

  it('keeps every point of its surface the radius from a box that much smaller, so every edge is a true round', () => {
    const r = 0.3;
    const inner = SIZE.map((s) => s / 2 - r);
    for (const { p, n } of verts(roundedBox(SIZE, r))) {
      const c = p.map((x, k) => Math.max(-inner[k], Math.min(inner[k], x)));
      expect(Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])).toBeCloseTo(r, 6);
      // and faces straight out from it, which is what makes the round smooth
      const out = p.map((x, k) => (x - c[k]) / r);
      for (let k = 0; k < 3; k++) expect(n[k]).toBeCloseTo(out[k], 5);
    }
  });

  it('has no hard edge anywhere: wherever two vertices meet, their normals agree', () => {
    const at = new Map<string, number[][]>();
    for (const { p, n } of verts(roundedBox(SIZE, 0.3))) {
      const key = p.map((x) => x.toFixed(5)).join(',');
      at.set(key, [...(at.get(key) ?? []), n]);
    }
    for (const [key, normals] of at) for (const n of normals) for (let k = 0; k < 3; k++) expect(n[k], key).toBeCloseTo(normals[0][k], 5);
  });

  it('is flat across each face inside its rounds', () => {
    const m = roundedBox(SIZE, 0.3);
    // the flat of the top is one quad, so its vertices are its corners, where the rounds begin
    const top = verts(m).filter(({ p }) => Math.abs(p[0]) <= SIZE[0] / 2 - 0.3 + 1e-6 && Math.abs(p[1]) <= SIZE[1] / 2 - 0.3 + 1e-6 && p[2] > 0);
    expect(top.length, 'vertices across the top').toBeGreaterThan(0);
    for (const { p, n } of top) {
      expect(p[2]).toBeCloseTo(SIZE[2] / 2, 6);
      expect(n).toEqual([0, 0, 1]);
    }
  });

  it('rounds no more than half its thinnest side, and a radius of nothing is a plain box of twelve triangles', () => {
    const b = boundsOf(roundedBox(SIZE, 5));
    expect(b.max[2] - b.min[2]).toBeCloseTo(SIZE[2], 6);
    expectWatertight(roundedBox(SIZE, 5));
    expect(roundedBox(SIZE, 0).indices.length / 3).toBe(12);
    expect(roundedBox(SIZE, -1).indices.length / 3).toBe(12);
  });

  it('takes more steps round each edge when asked, and the same number whatever its size', () => {
    const tris = (steps: number, size = SIZE) => roundedBox(size, 0.2, { steps }).indices.length / 3;
    expect(tris(8)).toBeGreaterThan(tris(2));
    expect(tris(4, [40, 20, 12])).toBe(tris(4));
  });
});

describe('a profile\'s corners rounded', () => {
  const square: Vec2[] = [[0, 0], [2, 0], [2, 2], [0, 2]];
  const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  /** The distance from p to the segment ab. */
  const toSegment = (p: Vec2, a: Vec2, b: Vec2) => {
    const d: Vec2 = [b[0] - a[0], b[1] - a[1]];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / (d[0] * d[0] + d[1] * d[1])));
    return dist(p, [a[0] + d[0] * t, a[1] + d[1] * t]);
  };

  it('puts each corner on an arc of the radius asked, tangent to the sides either side of it', () => {
    const r = 0.5;
    const out = roundCorners({ points: square, closed: true }, r, { steps: 6 });
    // every point is within reach of the original outline, and none is outside it
    for (const p of out.points) {
      expect(Math.min(...square.map((a, i) => toSegment(p, a, square[(i + 1) % 4])))).toBeLessThan(r * (1 - Math.SQRT1_2) + 1e-9);
      expect(p[0]).toBeGreaterThanOrEqual(-1e-9);
      expect(p[0]).toBeLessThanOrEqual(2 + 1e-9);
    }
    // the corner at (2, 2): its arc's centre is (1.5, 1.5), and every point near the corner is r from it
    const near = out.points.filter((p) => p[0] > 1.5 - 1e-9 && p[1] > 1.5 - 1e-9);
    expect(near.length).toBe(7);
    for (const p of near) expect(dist(p, [1.5, 1.5])).toBeCloseTo(r, 9);
    // and it starts and ends on the sides, where they are tangent to it
    expect(near.some((p) => Math.abs(p[0] - 2) < 1e-9 && Math.abs(p[1] - 1.5) < 1e-9)).toBe(true);
    expect(near.some((p) => Math.abs(p[1] - 2) < 1e-9 && Math.abs(p[0] - 1.5) < 1e-9)).toBe(true);
  });

  it('keeps an open profile\'s ends where they were, and rounds only the corners between, whichever way each turns', () => {
    // a step: a left turn up, then a right turn along
    const open: Vec2[] = [[0, 0], [1, 0], [1, 1], [2, 1]];
    const r = 0.2;
    const out = roundCorners({ points: open }, r, { steps: 4 });
    expect(out.points[0]).toEqual([0, 0]);
    expect(out.points[out.points.length - 1]).toEqual([2, 1]);
    expect(out.points.length).toBe(2 + 2 * 5);
    expect(out.closed).toBeFalsy();
    // every point within a round's depth of the step, on the inside of each turn: a round bulging the wrong way is
    // a radius out
    for (const p of out.points) {
      expect(Math.min(...open.slice(0, -1).map((a, i) => toSegment(p, a, open[i + 1])))).toBeLessThan(r * (1 - Math.SQRT1_2) + 1e-9);
    }
    // the right turn's round, about (1, 1): its centre is (1.2, 0.8), below and beyond the corner
    for (const p of out.points.filter((q) => q[1] > 0.5 && q[0] <= 1.2 + 1e-9 && q[0] >= 1 - 1e-9 && q[1] <= 1 + 1e-9)) {
      expect(dist(p, [1.2, 0.8])).toBeCloseTo(r, 9);
    }
  });

  it('rounds a corner no more than its shorter side leaves room for, so two rounds never overlap', () => {
    const thin: Vec2[] = [[0, 0], [4, 0], [4, 0.2], [0, 0.2]];
    const out = roundCorners({ points: thin, closed: true }, 1, { steps: 4 });
    const n = out.points.length;
    for (let i = 0; i < n; i++) {
      const p = out.points[i], q = out.points[(i + 1) % n];
      expect(dist(p, q), `step ${i}`).toBeGreaterThan(1e-9);
      expect(p[1]).toBeGreaterThanOrEqual(-1e-9);
      expect(p[1]).toBeLessThanOrEqual(0.2 + 1e-9);
    }
    // and the outline never crosses itself: no two sides that do not share an end meet
    const cross = (a: Vec2, b: Vec2, c: Vec2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const meet = (a: Vec2, b: Vec2, c: Vec2, d: Vec2) => cross(a, b, c) * cross(a, b, d) < -1e-12 && cross(c, d, a) * cross(c, d, b) < -1e-12;
    for (let i = 0; i < n; i++)
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        expect(meet(out.points[i], out.points[(i + 1) % n], out.points[j], out.points[(j + 1) % n]), `sides ${i} and ${j}`).toBe(false);
      }
  });

  it('leaves a straight run, a radius of nothing and a corner it was told to keep as they were', () => {
    const line: Vec2[] = [[0, 0], [1, 0], [2, 0]];
    expect(roundCorners({ points: line }, 0.3).points).toEqual(line);
    expect(roundCorners({ points: square, closed: true }, 0).points).toEqual(square);
    const kept = roundCorners({ points: square, closed: true, sharp: [true, false, false, false] }, 0.5, { steps: 3 });
    expect(kept.points).toContainEqual([0, 0]);
    expect(kept.sharp?.[kept.points.findIndex((p) => p[0] === 0 && p[1] === 0)]).toBe(true);
  });

  it('turns a lathe\'s silhouette into a solid with rounded rims that is still closed', () => {
    // a puck: up the axis-side of nothing, out along the bottom, up the side, back in along the top
    const puck = roundCorners({ points: [[0, 0], [1.5, 0], [1.5, 0.6], [0, 0.6]], sharp: [false, false, false, false] }, 0.15, { steps: 4 });
    // its two corners, each an arc of five points in place of one
    expect(puck.points.length).toBe(2 + 2 * 5);
    const m = revolve(puck, { segments: 32 });
    expectWellFormed(m);
    const b = boundsOf(m);
    expect(b.max[0]).toBeCloseTo(1.5, 6);
    expect(b.max[2]).toBeCloseTo(0.6, 6);
  });
});
