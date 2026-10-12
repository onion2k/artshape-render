/**
 * The mesh pass of the painted edge: what it measures of a faceted solid so that a fragment can find its edge. Each
 * test holds a figure that could be worked out by hand from the solid (a block's twelve edges, a hole's lip and its
 * floor join), since a pass that measured the wrong thing would still run and only the picture would be wrong.
 */
import { describe, expect, it } from "vitest";
import { annulus, at, block, built, disc, frustum, tubeIn } from "../lowpoly";
import { boulder } from "../../parts/lowpoly";
import { PAINT_STRIDE, painted, split } from "../paint";
import type { Mesh } from "../types";

const BLOCK = built((b) => block(b, at(0, 0, 0), -1, 1, -1, 1, 0, 2, true));
const HOLE = { n: 10, rIn: 0.75, rOut: 1.5, top: 1, floor: 0.6 };
const HOLE_SLAB = built((b) => {
  const o = at(0, 0, 0);
  annulus(b, o, HOLE.n, HOLE.rIn, HOLE.rOut, HOLE.top);
  tubeIn(b, o, HOLE.n, HOLE.rIn, HOLE.floor, HOLE.top);
  disc(b, o, HOLE.n, HOLE.rIn, HOLE.floor);
  frustum(b, o, HOLE.n, HOLE.rOut, HOLE.rOut, 0, HOLE.top, {
    top: false,
    bottom: true,
  });
});

/** The painted mesh of a solid the way a game makes it: split first, since the solids' quads share two vertices. */
const paintedSolid = (m: Mesh) => painted(split(m));

/** One triangle's record: the same in each of its three vertices but the corner, so the first is read. */
function triangle(m: Mesh & { paint: Float32Array }, t: number) {
  const f = (v: number, k: number) => m.paint[(t * 3 + v) * PAINT_STRIDE + k];
  const corner = (v: number) =>
    [0, 1, 2].map((k) => m.positions[(t * 3 + v) * 3 + k]);
  return { f, corner: [corner(0), corner(1), corner(2)] };
}

/** The unit normal of triangle t from its winding. */
function windingNormal(m: Mesh, t: number): number[] {
  const p = (v: number) =>
    [0, 1, 2].map((k) => m.positions[m.indices[t * 3 + v] * 3 + k]);
  const [a, b, c] = [p(0), p(1), p(2)];
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
    w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [
    u[1] * w[2] - u[2] * w[1],
    u[2] * w[0] - u[0] * w[2],
    u[0] * w[1] - u[1] * w[0],
  ];
  const l = Math.hypot(n[0], n[1], n[2]);
  return n.map((x) => x / l);
}

/** Every triangle edge of a painted mesh, with its signed fold and the positions at its two ends. */
function edgesOf(m: Mesh & { paint: Float32Array }) {
  const out: { t: number; fold: number; ends: number[][] }[] = [];
  for (let t = 0; t < m.indices.length / 3; t++) {
    const { f, corner } = triangle(m, t);
    for (let i = 0; i < 3; i++)
      out.push({
        t,
        fold: f(0, i),
        ends: [corner[(i + 1) % 3], corner[(i + 2) % 3]],
      });
  }
  return out;
}

/** The up-share written into the fraction of crowd float `i` of a triangle's vertex. */
const upShare = (m: Mesh & { paint: Float32Array }, t: number, i: number) => {
  const v = triangle(m, t).f(0, 12 + i);
  return 4 * (v - Math.floor(v)) - 1;
};

describe("split", () => {
  it("gives every triangle its own three vertices, each keeping what it had", () => {
    const s = split(BLOCK);
    expect(s.indices.length).toBe(BLOCK.indices.length);
    expect(s.positions.length / 3).toBe(BLOCK.indices.length);
    expect(Array.from(s.indices)).toEqual(Array.from(s.indices, (_, i) => i));
    for (let i = 0; i < BLOCK.indices.length; i++) {
      const v = BLOCK.indices[i];
      for (let k = 0; k < 3; k++) {
        expect(s.positions[i * 3 + k]).toBe(BLOCK.positions[v * 3 + k]);
        expect(s.normals[i * 3 + k]).toBe(BLOCK.normals[v * 3 + k]);
      }
      expect(s.uvs[i * 2]).toBe(BLOCK.uvs[v * 2]);
    }
  });
});

describe("painted, on a block", () => {
  const m = paintedSolid(BLOCK);

  it("is twelve triangles in six faces, with the stride a vertex carries", () => {
    expect(m.paintStats.triangles).toBe(12);
    expect(m.paintStats.faces).toBe(6);
    expect(PAINT_STRIDE).toBe(20);
    expect(m.paint.length).toBe(PAINT_STRIDE * (m.positions.length / 3));
    expect(m.paint.length).toBe(PAINT_STRIDE * 36);
  });

  it("counts twenty-four convex triangle edges and twelve flat ones, with none concave or open", () => {
    expect(m.paintStats.edges).toEqual({
      convex: 24,
      concave: 0,
      flat: 12,
      open: 0,
    });
  });

  it("folds every convex edge a right angle and leaves a face's diagonal at nought", () => {
    let convex = 0,
      flat = 0;
    for (const e of edgesOf(m)) {
      if (e.fold === 0) flat++;
      else {
        convex++;
        expect(Math.abs(e.fold - Math.PI / 2)).toBeLessThan(1e-6);
      }
    }
    expect([convex, flat]).toEqual([24, 12]);
  });

  it("writes the corner index, the heights, and the quiet and set it was asked for, the same in a triangle's vertices", () => {
    for (let t = 0; t < 12; t++) {
      const { f, corner } = triangle(m, t);
      for (let v = 0; v < 3; v++) {
        expect(f(v, 3)).toBe(v);
        for (let k of [
          0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
        ])
          expect(f(v, k)).toBe(f(0, k));
      }
      for (let i = 0; i < 3; i++) {
        // the height from corner i to the edge opposite it, worked out here from the positions
        const a = corner[i],
          b = corner[(i + 1) % 3],
          c = corner[(i + 2) % 3];
        const e = [c[0] - b[0], c[1] - b[1], c[2] - b[2]],
          d = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
        const cr = [
          e[1] * d[2] - e[2] * d[1],
          e[2] * d[0] - e[0] * d[2],
          e[0] * d[1] - e[1] * d[0],
        ];
        expect(f(0, 4 + i)).toBeCloseTo(
          Math.hypot(...cr) / Math.hypot(...e),
          5,
        );
        expect(f(0, 4 + i)).toBeGreaterThan(0);
      }
      expect([f(0, 10), f(0, 11)]).toEqual([0, 0]);
    }
    const quiet = painted(split(BLOCK), { quiet: true, set: 2 });
    expect([quiet.paint[10], quiet.paint[11]]).toEqual([1, 2]);
  });

  it("chooses every edge by the gate alone, and puts nothing along a ridgeline", () => {
    for (let t = 0; t < 12; t++) {
      const { f } = triangle(m, t);
      expect(f(0, 15)).toBe(7);
      expect([f(0, 16), f(0, 17), f(0, 18), f(0, 19)]).toEqual([0, 0, 0, 0]);
    }
  });

  it("merges coplanar triangles into faces, each with its own id and the height range of the whole face", () => {
    const faces = new Map<
      number,
      { zMin: number; zMax: number; count: number }
    >();
    for (let t = 0; t < 12; t++) {
      const { f } = triangle(m, t);
      const was = faces.get(f(0, 9));
      if (was) {
        expect([was.zMin, was.zMax]).toEqual([f(0, 7), f(0, 8)]);
        was.count++;
      } else faces.set(f(0, 9), { zMin: f(0, 7), zMax: f(0, 8), count: 1 });
    }
    expect(faces.size).toBe(6);
    for (const face of faces.values()) expect(face.count).toBe(2);
    const extents = [...faces.values()]
      .map((x) => `${x.zMin},${x.zMax}`)
      .sort();
    expect(extents).toEqual(["0,0", "0,2", "0,2", "0,2", "0,2", "2,2"]);
  });

  it("counts three convex edges at every corner", () => {
    for (let t = 0; t < 12; t++) {
      const { f } = triangle(m, t);
      for (let i = 0; i < 3; i++) expect(Math.floor(f(0, 12 + i))).toBe(3);
    }
  });

  it("shares up half and half across a top edge, wholly across a diagonal, and none across the bottom", () => {
    let top = 0,
      topDiagonal = 0,
      bottomDiagonal = 0;
    for (let t = 0; t < 12; t++) {
      const { f, corner } = triangle(m, t);
      for (let i = 0; i < 3; i++) {
        const a = corner[(i + 1) % 3],
          b = corner[(i + 2) % 3];
        const up = upShare(m, t, i);
        if (a[2] === 2 && b[2] === 2) {
          if (f(0, i) === 0) {
            expect(up).toBeCloseTo(1, 5);
            topDiagonal++;
          } else {
            expect(up).toBeCloseTo(0.5, 5);
            top++;
          }
        }
        if (a[2] === 0 && b[2] === 0 && f(0, i) === 0) {
          expect(up).toBeCloseTo(-1, 5);
          bottomDiagonal++;
        }
      }
    }
    expect([top, topDiagonal, bottomDiagonal]).toEqual([8, 2, 2]);
  });
});

describe("painted, on a hole slab", () => {
  const m = paintedSolid(HOLE_SLAB);

  it("is wound as a slab should be: a top and a floor that face up, a wall that faces the hole, sides that face out", () => {
    for (let t = 0; t < HOLE_SLAB.indices.length / 3; t++) {
      const n = windingNormal(HOLE_SLAB, t);
      const p = [0, 1, 2].map((v) =>
        [0, 1, 2].map(
          (k) => HOLE_SLAB.positions[HOLE_SLAB.indices[t * 3 + v] * 3 + k],
        ),
      );
      const z = p[0][2];
      const mid = [0, 1].map((k) => (p[0][k] + p[1][k] + p[2][k]) / 3);
      const radial =
        (n[0] * mid[0] + n[1] * mid[1]) / Math.hypot(mid[0], mid[1]);
      if (p.every((q) => q[2] === z)) {
        expect(n[2], "a flat piece faces up, or down for the base").toBeCloseTo(
          z === 0 ? -1 : 1,
          5,
        );
      } else if (Math.hypot(mid[0], mid[1]) < 1)
        expect(radial, "the hole's wall faces the axis").toBeLessThan(-0.9);
      else expect(radial, "the slab's side faces out").toBeGreaterThan(0.9);
    }
  });

  it("folds the wall's join with the hole's floor negative and the annulus's join with the wall positive", () => {
    // the disc's fan has chords between the same ring's points, flat and not joins, so only folded edges are taken
    const ring = (
      e: { fold: number; ends: number[][] },
      z: number,
      r: number,
    ) =>
      e.fold !== 0 &&
      e.ends.every(
        (q) =>
          Math.abs(q[2] - z) < 1e-6 &&
          Math.abs(Math.hypot(q[0], q[1]) - r) < 1e-6,
      );
    const floorJoin = edgesOf(m).filter((e) => ring(e, HOLE.floor, HOLE.rIn));
    const lip = edgesOf(m).filter((e) => ring(e, HOLE.top, HOLE.rIn));
    // each of the ten sides has its edge twice, once from each face it joins
    expect(floorJoin.length).toBe(2 * HOLE.n);
    expect(lip.length).toBe(2 * HOLE.n);
    for (const e of floorJoin) expect(e.fold).toBeCloseTo(-Math.PI / 2, 5);
    for (const e of lip) expect(e.fold).toBeCloseTo(Math.PI / 2, 5);
  });

  it("is a closed solid with no edge open, whose creases are the floor join and the wall's own corners", () => {
    expect(m.paintStats.edges.open).toBe(0);
    // twenty triangle edges along the floor join, and twenty down the corners between the wall's ten sides
    expect(m.paintStats.edges.concave).toBe(4 * HOLE.n);
    const corner = edgesOf(m).filter(
      (e) => e.fold < 0 && e.ends[0][2] !== e.ends[1][2],
    );
    expect(corner.length).toBe(2 * HOLE.n);
    for (const e of corner)
      expect(e.fold).toBeCloseTo(-(2 * Math.PI) / HOLE.n, 5);
  });
});

describe("painted, on a boulder", () => {
  it("has no open edge, and a crowd and an up-share in range", () => {
    const rock = boulder(1, { seed: 3 });
    expect(rock.parts.length).toBeGreaterThan(0);
    for (const part of rock.parts) {
      const m = paintedSolid(part.mesh);
      expect(m.paintStats.edges.open).toBe(0);
      const { convex, concave, flat } = m.paintStats.edges;
      expect(convex + concave + flat).toBe(3 * m.paintStats.triangles);
      for (let t = 0; t < m.paintStats.triangles; t++)
        for (let i = 0; i < 3; i++) {
          expect(upShare(m, t, i)).toBeGreaterThanOrEqual(-1 - 1e-6);
          expect(upShare(m, t, i)).toBeLessThanOrEqual(1 + 1e-6);
        }
    }
  });
});

describe("painted, in general", () => {
  it("keeps every up-share in [-1, 1], on every solid", () => {
    for (const solid of [BLOCK, HOLE_SLAB]) {
      const m = paintedSolid(solid);
      for (let t = 0; t < m.paintStats.triangles; t++)
        for (let i = 0; i < 3; i++) {
          expect(upShare(m, t, i)).toBeGreaterThanOrEqual(-1 - 1e-6);
          expect(upShare(m, t, i)).toBeLessThanOrEqual(1 + 1e-6);
        }
    }
  });

  it("refuses a mesh with an index used by two triangles, and takes it once it is split", () => {
    expect(new Set(BLOCK.indices).size).toBeLessThan(BLOCK.indices.length);
    expect(() => painted(BLOCK)).toThrow(/used by two triangles/);
    expect(() => painted(split(BLOCK))).not.toThrow();
  });

  it("is the same bytes from the same mesh, and leaves the mesh it was given as it was", () => {
    const before = Array.from(BLOCK.positions);
    const a = paintedSolid(HOLE_SLAB),
      b = paintedSolid(HOLE_SLAB);
    expect(Array.from(new Uint8Array(a.paint.buffer))).toEqual(
      Array.from(new Uint8Array(b.paint.buffer)),
    );
    painted(split(BLOCK));
    expect(Array.from(BLOCK.positions)).toEqual(before);
    expect((BLOCK as { paint?: unknown }).paint).toBeUndefined();
  });

  it("says plainly that the choices it does not yet make are not yet made", () => {
    expect(() => painted(split(BLOCK), { choice: "agree" })).toThrow(/not yet/);
    expect(() =>
      painted(split(BLOCK), { choice: "ridge", ridge: { budget: 1 } }),
    ).toThrow(/not yet/);
    expect(() => painted(split(BLOCK), { choice: "gate" })).not.toThrow();
  });
});
