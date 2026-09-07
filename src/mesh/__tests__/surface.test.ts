import { describe, expect, it } from 'vitest';
import { bezierPatch, helicoid, mobius, ripple, saddle, shell, surface } from '../surface';
import { expectWellFormed, boundsOf } from './helpers';
import type { Mesh } from '../types';
import type { Vec3 } from '../../geom/types';

/** Every triangle's winding agrees with its vertices' normals: nothing is inside out. */
function expectConsistentWinding(mesh: Mesh) {
  const p = mesh.positions, n = mesh.normals, idx = mesh.indices;
  let bad = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
    const e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const g = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const nn = [n[a] + n[b] + n[c], n[a + 1] + n[b + 1] + n[c + 1], n[a + 2] + n[b + 2] + n[c + 2]];
    if (g[0] * nn[0] + g[1] * nn[1] + g[2] * nn[2] < 0) bad++;
  }
  expect(bad).toBe(0);
}

const flat = (u: number, v: number): Vec3 => [(u - 0.5) * 20, (v - 0.5) * 10, 0];

describe('surface', () => {
  it('thickens a flat sheet into a slab of the right size', () => {
    const mesh = surface(flat, { thickness: 2, segmentsU: 8, segmentsV: 4 });
    expectWellFormed(mesh);
    expectConsistentWinding(mesh);
    const b = boundsOf(mesh);
    expect(b.max[2] - b.min[2]).toBeCloseTo(2);
    expect(b.max[0] - b.min[0]).toBeCloseTo(20);
    expect(b.max[1] - b.min[1]).toBeCloseTo(10);
  });

  it('winds every surface right side out, rims included', () => {
    for (const f of [saddle(20, 12, 4), ripple(20, 20, 2, 2), helicoid(6, 20, 1.5), bezierPatch(Array.from({ length: 16 }, (_, i) => [(i % 4) * 5, Math.floor(i / 4) * 5, Math.sin(i)] as Vec3))]) {
      const mesh = surface(f, { thickness: 1 });
      expectWellFormed(mesh);
      expectConsistentWinding(mesh);
    }
  });

  it('leaves the rim off a closed direction', () => {
    const open = surface(mobius(10, 3), { thickness: 0.8, segmentsU: 60, segmentsV: 6 });
    const closed = surface(mobius(10, 3), { thickness: 0.8, segmentsU: 60, segmentsV: 6, closedU: true });
    expect(closed.indices.length).toBeLessThan(open.indices.length);
    expectConsistentWinding(closed);
  });

  it('a Möbius band meets itself flipped: the top sheet at the end is the bottom at the start', () => {
    const f = mobius(10, 3);
    const end = f(1, 0.2), start = f(0, 0.8);
    for (let k = 0; k < 3; k++) expect(end[k]).toBeCloseTo(start[k], 6);
  });

  it('a seashell closes round its tube and grows by its factor each turn', () => {
    const f = shell(8, 3, 3, 2, 12);
    const a = f(0.3, 0), b = f(0.3, 1);
    for (let k = 0; k < 3; k++) expect(a[k]).toBeCloseTo(b[k], 6);
    const r = (u: number) => { const p = f(u, 0.25); return Math.hypot(p[0], p[1]); };
    expect(r(2 / 3) / r(1 / 3)).toBeCloseTo(2, 3);
  });

  it('carries engraving coordinates in millimetres along and across', () => {
    const mesh = surface(flat, { thickness: 1, segmentsU: 10, segmentsV: 5 });
    const e = mesh.engrave!;
    let maxX = 0, maxY = 0;
    for (let i = 0; i < e.length; i += 2) { maxX = Math.max(maxX, e[i]); maxY = Math.max(maxY, e[i + 1]); }
    expect(maxX).toBeCloseTo(20);
    expect(maxY).toBeCloseTo(10);
  });

  it('a patch interpolates its corner points', () => {
    const net = Array.from({ length: 16 }, (_, i) => [(i % 4) * 3, Math.floor(i / 4) * 3, i === 5 ? 4 : 0] as Vec3);
    const f = bezierPatch(net);
    expect(f(0, 0)).toEqual([0, 0, 0]);
    expect(f(1, 1)[0]).toBeCloseTo(9);
    expect(f(1, 1)[1]).toBeCloseTo(9);
    expect(f(0.5, 0.5)[2]).toBeGreaterThan(0);
    expect(() => bezierPatch(net.slice(0, 9))).toThrow(/16 control points/);
  });
});
