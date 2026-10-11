/**
 * The faceted scenery. What each tree must be: the triangles it is held to,
 * the same for the same seed, standing on the ground with its top at the
 * height asked, flat-shaded and well formed, and the same shape at any
 * height, so a game can make one mesh and instance it.
 */
import { describe, expect, it } from 'vitest';
import { boulder, broadleaf, bush, conifer, farTree, fern, type Scenery } from '../lowpoly';
import { boundsOf, expectWellFormed } from '../../mesh/__tests__/helpers';
import type { Mesh } from '../../mesh/types';

const part = (m: Scenery, name: string): Mesh => {
  const p = m.parts.find((q) => q.name === name);
  if (!p) throw new Error(`no part ${name} in ${m.name}`);
  return p.mesh;
};
const triangles = (m: Scenery) => m.parts.reduce((n, p) => n + p.mesh.indices.length / 3, 0);
const extent = (m: Scenery) => {
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (const p of m.parts) {
    const { min, max } = boundsOf(p.mesh);
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], min[k]);
      hi[k] = Math.max(hi[k], max[k]);
    }
  }
  return { min: lo, max: hi };
};
const bytes = (m: Scenery) =>
  m.parts.map((p) => [p.name, Array.from(p.mesh.positions), Array.from(p.mesh.normals), Array.from(p.mesh.indices)]);

const MODELS: [string, (seed: number) => Scenery][] = [
  ['broadleaf', (seed) => broadleaf({ height: 7, seed })],
  ['conifer', (seed) => conifer({ height: 8, seed })],
  ['boulder', (seed) => boulder(1.4, { seed })],
  ['bush', (seed) => bush(1.8, { seed })],
  ['fern', (seed) => fern(2.2, { seed })],
];

describe('the faceted scenery', () => {
  it('holds its triangle counts exactly', () => {
    expect(triangles(broadleaf())).toBe(204);
    expect(triangles(broadleaf({ height: 12, seed: 9 }))).toBe(204);
    expect(triangles(conifer())).toBe(50);
    expect(triangles(conifer({ tiers: 2 }))).toBe(30);
    expect(triangles(farTree('conifer'))).toBe(16);
    expect(triangles(farTree('broadleaf'))).toBe(10);
    expect(triangles(bush(1.8))).toBe(72);
    expect(triangles(fern(2.2))).toBe(27);
    expect(triangles(boulder(1.4))).toBe(20);
  });

  it('names its parts, which a game colours by name, and carries no colour of its own', () => {
    const names = (m: Scenery) => m.parts.map((p) => p.name);
    expect(names(broadleaf())).toEqual(['trunk', 'leaves', 'crown']);
    expect(names(conifer())).toEqual(['trunk', 'leaves']);
    expect(names(farTree('conifer'))).toEqual(['leaves']);
    expect(names(bush(1))).toEqual(['bush']);
    expect(names(fern(1))).toEqual(['fern']);
    expect(names(boulder(1))).toEqual(['rock']);
    expect(broadleaf().name).toBe('broadleaf');
    expect(farTree('conifer').name).toBe('far conifer');
    for (const [, make] of MODELS) for (const p of make(1).parts) expect(Object.keys(p).sort()).toEqual(['mesh', 'name']);
  });

  it('is well formed: indices in range, unit normals, no NaN anywhere', () => {
    const all: [string, Scenery][] = [
      ...MODELS.flatMap(([n, make]): [string, Scenery][] => [0, 1, 7, 99].map((s) => [`${n} ${s}`, make(s)])),
      ['far conifer', farTree('conifer')],
      ['far broadleaf', farTree('broadleaf')],
      ['tall conifer, two tiers', conifer({ height: 5, tiers: 2, seed: 3 })],
    ];
    for (const [name, m] of all)
      for (const p of m.parts) {
        expectWellFormed(p.mesh);
        for (const a of [p.mesh.positions, p.mesh.normals, p.mesh.uvs]) for (const x of a) expect(Number.isNaN(x), name).toBe(false);
        const n = p.mesh.positions.length / 3;
        for (const i of p.mesh.indices) expect(i, name).toBeLessThan(n);
        for (let v = 0; v < n; v++)
          expect(Math.hypot(p.mesh.normals[v * 3], p.mesh.normals[v * 3 + 1], p.mesh.normals[v * 3 + 2]), name).toBeCloseTo(1, 5);
      }
  });

  it('is cut with flat faces: every corner of every triangle faces exactly as its triangle does', () => {
    for (const [name, make] of MODELS)
      for (const p of make(3).parts) {
        const { normals: n, indices: ix } = p.mesh;
        for (let t = 0; t < ix.length; t += 3) {
          const [a, b, c] = [ix[t] * 3, ix[t + 1] * 3, ix[t + 2] * 3];
          for (const [i, j] of [
            [a, b],
            [b, c],
          ])
            expect(n[i] * n[j] + n[i + 1] * n[j + 1] + n[i + 2] * n[j + 2], `${name} ${p.name}`).toBeGreaterThan(0.9999);
        }
      }
  });

  it('is the same bytes for a seed and different for another seed', () => {
    for (const [name, make] of MODELS) {
      expect(bytes(make(5)), name).toEqual(bytes(make(5)));
      expect(bytes(make(5)), name).not.toEqual(bytes(make(6)));
    }
    expect(bytes(farTree('conifer'))).toEqual(bytes(farTree('conifer')));
    expect(bytes(farTree('broadleaf'))).toEqual(bytes(farTree('broadleaf')));
  });

  it('keeps every seed to its triangle count', () => {
    for (let seed = 0; seed < 20; seed++) {
      expect(triangles(broadleaf({ seed }))).toBe(204);
      expect(triangles(conifer({ seed }))).toBe(50);
    }
  });

  it('stands a tree on the ground with its top at the height asked', () => {
    for (const [make, heights] of [
      [(height: number, seed: number) => broadleaf({ height, seed }), [1, 5, 7, 12]],
      [(height: number, seed: number) => conifer({ height, seed }), [1, 5, 8, 14]],
    ] as const)
      for (const height of heights)
        for (const seed of [1, 2, 3]) {
          const m = make(height, seed);
          expect(boundsOf(part(m, 'trunk')).min[2]).toBeGreaterThanOrEqual(-1e-6);
          const all = extent(m);
          expect(all.min[2]).toBeCloseTo(0, 5);
          expect(all.max[2]).toBeCloseTo(height, 4);
        }
  });

  it('puts a broadleaf’s canopy clear of the ground on a trunk that goes up into it', () => {
    const m = broadleaf({ height: 10, seed: 4 });
    const canopy = Math.min(boundsOf(part(m, 'leaves')).min[2], boundsOf(part(m, 'crown')).min[2]);
    expect(canopy).toBeGreaterThan(3);
    expect(boundsOf(part(m, 'trunk')).max[2]).toBeGreaterThan(canopy);
    // the crown is the top of the tree
    expect(boundsOf(part(m, 'crown')).max[2]).toBeCloseTo(10, 4);
  });

  it('narrows a conifer’s tiers as they rise', () => {
    const m = conifer({ height: 10, seed: 2 });
    const pts = part(m, 'leaves').positions;
    const wide = (lo: number, hi: number) => {
      let w = 0;
      for (let i = 0; i < pts.length; i += 3) if (pts[i + 2] >= lo && pts[i + 2] < hi) w = Math.max(w, Math.hypot(pts[i], pts[i + 1]));
      return w;
    };
    expect(wide(1.5, 3)).toBeGreaterThan(wide(6, 9));
  });

  it('makes a unit-tall tree at height 1 and the same tree at 10, within float error', () => {
    for (const make of [(height: number) => broadleaf({ height, seed: 4 }), (height: number) => conifer({ height, seed: 4 })]) {
      const one = make(1),
        ten = make(10);
      expect(one.parts.map((p) => p.name)).toEqual(ten.parts.map((p) => p.name));
      for (let k = 0; k < one.parts.length; k++) {
        const a = one.parts[k].mesh,
          b = ten.parts[k].mesh;
        expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
        for (let i = 0; i < a.positions.length; i++) expect(a.positions[i] * 10).toBeCloseTo(b.positions[i], 4);
        // directions do not scale
        for (let i = 0; i < a.normals.length; i++) expect(a.normals[i]).toBeCloseTo(b.normals[i], 5);
      }
    }
  });

  it('makes a far tree a unit tall, on the ground', () => {
    for (const kind of ['conifer', 'broadleaf'] as const) {
      const { min, max } = extent(farTree(kind));
      expect(max[2], kind).toBeCloseTo(1, 5);
      expect(min[2], kind).toBeGreaterThanOrEqual(-1e-6);
      expect(Math.max(max[0], max[1], -min[0], -min[1]), kind).toBeLessThanOrEqual(0.4);
    }
  });

  it('sinks a boulder into the ground, no wider than asked, and lower than it is wide', () => {
    for (const size of [0.6, 1.4, 3]) {
      const b = extent(boulder(size, { seed: 7 }));
      expect(b.min[2]).toBeLessThan(0);
      expect(b.min[2]).toBeGreaterThan(-0.3 * size);
      expect(Math.max(-b.min[0], b.max[0], -b.min[1], b.max[1])).toBeLessThanOrEqual(size * 1.0001);
      expect(b.max[2]).toBeLessThan(size);
    }
  });

  it('stands a fern and a bush on the ground, no taller or wider than asked', () => {
    for (const m of [fern(2.2), bush(1.8)]) expect(extent(m).min[2]).toBeGreaterThan(-0.5);
    expect(extent(fern(2.2)).max[2]).toBeLessThanOrEqual(2.2);
    expect(extent(fern(2.2, { blades: 3 })).max[2]).toBeLessThanOrEqual(2.2);
    expect(triangles(fern(2.2, { blades: 3 }))).toBe(9);
  });
});
