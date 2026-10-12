/**
 * The solids faceted scenery is cut from. What each must be: flat-shaded
 * (no vertex shared between faces, every normal its face's), wound outward,
 * exactly the size asked, and the same for the same seed.
 */
import { describe, expect, it } from 'vitest';
import {
  annulus,
  at,
  block,
  built,
  disc,
  dome,
  face,
  faceOut,
  frustum,
  lump,
  prism,
  rod,
  round,
  seeded,
  slab,
  tri,
  tubeIn,
} from '../lowpoly';
import { MeshBuilder, type Mesh } from '../types';
import type { Vec3 } from '../../geom/types';
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

/** The triangles of a mesh, each with its stored normal, its winding's normal and its middle. */
function triangles(m: Mesh) {
  const out: { stored: Vec3; wound: Vec3; centre: Vec3 }[] = [];
  const P = (i: number): Vec3 => [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [P(m.indices[t]), P(m.indices[t + 1]), P(m.indices[t + 2])];
    const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      v: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const wound: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const i = m.indices[t] * 3;
    out.push({
      stored: [m.normals[i], m.normals[i + 1], m.normals[i + 2]],
      wound,
      centre: [0, 1, 2].map((d) => (a[d] + b[d] + c[d]) / 3) as Vec3,
    });
  }
  return out;
}

/** Every face leans away from `middle`, by its normal and by its winding, which agree. */
function expectOutward(m: Mesh, middle: Vec3) {
  expectWellFormed(m);
  for (const { stored, wound, centre } of triangles(m)) {
    const out: Vec3 = [centre[0] - middle[0], centre[1] - middle[1], centre[2] - middle[2]];
    expect(stored[0] * out[0] + stored[1] * out[1] + stored[2] * out[2]).toBeGreaterThan(0);
    expect(wound[0] * stored[0] + wound[1] * stored[1] + wound[2] * stored[2]).toBeGreaterThan(0);
  }
}

const tris = (build: (b: MeshBuilder) => void) => built(build).indices.length / 3;
const home = at(0, 0, 0);

describe('round', () => {
  it('is the i-th of n points on a circle, at its height and from its phase', () => {
    expect(round(0, 4, 2, 5)).toEqual([2, 0, 5]);
    const [x, y, z] = round(1, 4, 2, 5, Math.PI / 2);
    expect(x).toBeCloseTo(-2, 12);
    expect(y).toBeCloseTo(0, 12);
    expect(z).toBe(5);
  });
});

describe('prism', () => {
  const outline = (n: number) =>
    Array.from({ length: n }, (_, i): [number, number] => [Math.cos((i / n) * 6.2832), Math.sin((i / n) * 6.2832)]);

  it('is 2n triangles of side, n - 2 of top, and n - 2 underneath only if told', () => {
    for (const n of [3, 4, 5, 8]) {
      expect(tris((b) => prism(b, home, outline(n), 0, 1))).toBe(2 * n + (n - 2));
      expect(tris((b) => prism(b, home, outline(n), 0, 1, { top: false }))).toBe(2 * n);
      expect(tris((b) => prism(b, home, outline(n), 0, 1, { bottom: true }))).toBe(2 * n + 2 * (n - 2));
    }
  });

  it('faces outward when closed, and stands from z0 to z1 placed', () => {
    const m = built((b) => prism(b, at(5, 6, 7), outline(6), 0, 2, { bottom: true }));
    expectOutward(m, [5, 6, 8]);
    const { min, max } = boundsOf(m);
    expect(min[2]).toBeCloseTo(7, 9);
    expect(max[2]).toBeCloseTo(9, 9);
  });
});

describe('block', () => {
  it('is 10 triangles open underneath and 12 closed', () => {
    expect(tris((b) => block(b, home, 0, 1, 0, 1, 0, 1))).toBe(10);
    expect(tris((b) => block(b, home, 0, 1, 0, 1, 0, 1, true))).toBe(12);
  });

  it('is exactly the corners asked, every face of it facing out from its middle', () => {
    const m = built((b) => block(b, at(1, 2, 3), -1, 3, -2, 2, 0, 5, true));
    expectOutward(m, [1 + 1, 2, 3 + 2.5]);
    const { min, max } = boundsOf(m);
    expect(min).toEqual([0, 0, 3]);
    expect(max).toEqual([4, 4, 8]);
  });

  it('faces out when turned', () => {
    expectOutward(
      built((b) => block(b, at(0, 0, 0, 1.1), 0, 2, 0, 3, 0, 1, true)),
      [Math.cos(1.1) - 1.5 * Math.sin(1.1), Math.sin(1.1) + 1.5 * Math.cos(1.1), 0.5],
    );
  });
});

describe('rod', () => {
  it('is 2n triangles open and 2n + 2(n - 2) capped', () => {
    for (const n of [3, 4, 6]) {
      expect(tris((b) => rod(b, [0, 0, 0], [0, 0, 1], 0.1, n))).toBe(2 * n);
      expect(tris((b) => rod(b, [0, 0, 0], [0, 0, 1], 0.1, n, true))).toBe(2 * n + 2 * (n - 2));
    }
  });

  it('faces out from its middle when capped, at any slant, upright and flat included', () => {
    for (const [from, to] of [
      [[0, 0, 0], [0, 0, 4]],
      [[0, 0, 4], [0, 0, 0]],
      [[1, 2, 3], [4, -2, 9]],
      [[0, 0, 0], [5, 0, 0]],
    ] as [Vec3, Vec3][])
      expectOutward(
        built((b) => rod(b, from, to, 0.3, 5, true)),
        [0, 1, 2].map((d) => (from[d] + to[d]) / 2) as Vec3,
      );
  });

  it('runs from one point to the other', () => {
    const { min, max } = boundsOf(built((b) => rod(b, [0, 0, 1], [0, 0, 5], 0.5, 8, true)));
    expect(min[2]).toBeCloseTo(1, 9);
    expect(max[2]).toBeCloseTo(5, 9);
    expect(max[0]).toBeCloseTo(0.5, 9);
  });
});

describe('dome', () => {
  it('is rings * segments * 2 - segments triangles', () => {
    for (const [rings, segments] of [
      [1, 6],
      [3, 8],
      [4, 5],
    ])
      expect(tris((b) => dome(b, home, 1, rings, segments))).toBe(rings * segments * 2 - segments);
  });

  it('stands on z = 0, as tall as its radius, every face facing out from its middle', () => {
    const m = built((b) => dome(b, at(2, 3, 4), 2, 4, 8));
    expectOutward(m, [2, 3, 4]);
    const { min, max } = boundsOf(m);
    expect(min[2]).toBeCloseTo(4, 9);
    expect(max[2]).toBeCloseTo(6, 9);
  });
});

describe('slab', () => {
  const flag: [number, number][] = [
    [0, 0],
    [2, 0],
    [2, 1],
    [0, 1],
  ];

  it('is 2(n - 2) triangles of face and 2n of edge', () => {
    expect(tris((b) => slab(b, home, flag, 0.2))).toBe(2 * 2 + 2 * 4);
    expect(tris((b) => slab(b, home, flag.slice(0, 3), 0.2))).toBe(2 * 1 + 2 * 3);
  });

  it('is t thick about y = 0 and faces out from its middle', () => {
    const m = built((b) => slab(b, home, flag, 0.2));
    expectOutward(m, [1, 0, 0.5]);
    const { min, max } = boundsOf(m);
    expect(min[1]).toBeCloseTo(-0.1, 6);
    expect(max[1]).toBeCloseTo(0.1, 6);
  });
});

describe('disc and annulus', () => {
  it('are n - 2 and 2n triangles, facing up at their height', () => {
    expect(tris((b) => disc(b, home, 7, 1, 2))).toBe(5);
    expect(tris((b) => annulus(b, home, 7, 0.5, 1, 2))).toBe(14);
    for (const m of [built((b) => disc(b, home, 7, 1, 2)), built((b) => annulus(b, home, 7, 0.5, 1, 2))]) {
      expectWellFormed(m);
      for (const { stored, centre } of triangles(m)) {
        expect(stored[2]).toBeCloseTo(1, 9);
        expect(centre[2]).toBeCloseTo(2, 9);
      }
    }
  });
});

describe('tubeIn', () => {
  it('is 2n triangles whose faces look in at the axis', () => {
    const m = built((b) => tubeIn(b, home, 6, 1, 0, 2));
    expect(m.indices.length / 3).toBe(12);
    expectWellFormed(m);
    for (const { stored, centre } of triangles(m)) expect(stored[0] * centre[0] + stored[1] * centre[1]).toBeLessThan(0);
  });
});
