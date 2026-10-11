/**
 * The solids faceted scenery is cut from. What each must be: flat-shaded
 * (no vertex shared between faces, every normal its face's), wound outward,
 * exactly the size asked, and the same for the same seed.
 */
import { describe, expect, it } from 'vitest';
import { at, built, face, faceOut, frustum, lump, seeded, tri } from '../lowpoly';
import { MeshBuilder } from '../types';
import { boundsOf, expectWellFormed } from './helpers';

describe('seeded', () => {
  it('gives numbers in [0, 1), the same for the same seed and others for another', () => {
    const a = seeded(5),
      b = seeded(5),
      c = seeded(6);
    const run = (r: () => number) => Array.from({ length: 50 }, r);
    const xs = run(a);
    expect(xs).toEqual(run(b));
    expect(xs).not.toEqual(run(c));
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe('at', () => {
  it('turns about Z and then moves', () => {
    const [x, y, z] = at(1, 2, 3, Math.PI / 2)([1, 0, 4]);
    expect(x).toBeCloseTo(1, 12);
    expect(y).toBeCloseTo(3, 12);
    expect(z).toBeCloseTo(7, 12);
  });
});

describe('face and tri', () => {
  it('are flat-shaded with a unit normal facing the way they are wound', () => {
    const b = new MeshBuilder();
    face(b, [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]);
    tri(b, [0, 0, 1], [1, 0, 1], [0, 1, 1]);
    const m = b.build();
    expectWellFormed(m);
    expect(m.indices.length / 3).toBe(3);
    // a quad has four vertices of its own and a triangle three: nothing is shared
    expect(m.positions.length / 3).toBe(7);
    for (let v = 0; v < 7; v++) expect([m.normals[v * 3], m.normals[v * 3 + 1], m.normals[v * 3 + 2]]).toEqual([0, 0, 1]);
  });
});

describe('faceOut', () => {
  it('winds a face away from the inside whichever way it was given', () => {
    const pts: [number, number, number][] = [
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ];
    for (const p of [pts, [...pts].reverse()]) {
      const b = new MeshBuilder();
      faceOut(b, p, [0.5, 0.5, 0]);
      expect(b.build().normals[2]).toBe(1);
    }
    const b = new MeshBuilder();
    faceOut(b, [pts[0], pts[1], pts[2]], [0.5, 0.5, 2]);
    expect(b.build().normals[2]).toBe(-1);
  });
});

describe('frustum', () => {
  it('is the triangles it should be: sides, a cap on top, one underneath only if told', () => {
    const count = (opts: object, r1 = 1) => built((b) => frustum(b, at(0, 0, 0), 6, 1, r1, 0, 2, opts)).indices.length / 3;
    expect(count({})).toBe(6 * 2 + 4);
    expect(count({ top: false })).toBe(12);
    expect(count({ bottom: true })).toBe(12 + 4 + 4);
    // a cone comes to a point: one triangle a side, no cap
    expect(count({ bottom: true }, 0)).toBe(6 + 4);
  });

  it('is exactly the size asked and faces outward, as a frustum and as a cone', () => {
    for (const r1 of [1, 0]) {
      const m = built((b) => frustum(b, at(3, 4, 5), 8, 2, r1, 0, 3, { bottom: true }));
      expectWellFormed(m);
      const { min, max } = boundsOf(m);
      expect(min[2]).toBeCloseTo(5, 6);
      expect(max[2]).toBeCloseTo(8, 6);
      expect(max[0]).toBeCloseTo(5, 6);
      // every side face leans away from the axis
      let sides = 0;
      for (let t = 0; t < m.indices.length; t += 3) {
        const v = m.indices[t] * 3;
        const [nx, ny, nz] = [m.normals[v], m.normals[v + 1], m.normals[v + 2]];
        if (Math.abs(nz) > 0.99) continue;
        sides++;
        expect((m.positions[v] - 3) * nx + (m.positions[v + 1] - 4) * ny).toBeGreaterThan(0);
      }
      expect(sides).toBeGreaterThan(0);
    }
  });
});

describe('lump', () => {
  const make = (seed: number, opts = {}) =>
    built((b) => lump(b, at(0, 0, 10), seeded(seed), 4, 8, [2, 3, 4], opts));

  it('is well formed, and its top stays exactly rz above its middle', () => {
    for (const seed of [1, 2, 3]) {
      const m = make(seed, { give: 0.3 });
      expectWellFormed(m);
      expect(boundsOf(m).max[2]).toBeCloseTo(14, 5);
    }
  });

  it('is the same for a seed and another for another', () => {
    expect(make(1)).toEqual(make(1));
    expect(make(1).positions).not.toEqual(make(2).positions);
  });

  it('is flat underneath where told: nothing goes below the floor', () => {
    expect(boundsOf(make(1, { floor: -1 })).min[2]).toBeGreaterThanOrEqual(10 - 1 - 1e-6);
  });
});
