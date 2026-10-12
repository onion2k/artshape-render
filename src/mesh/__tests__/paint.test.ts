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

  it("refuses a choice it does not know, and a ridge choice with no budget", () => {
    expect(() =>
      painted(split(BLOCK), { choice: "wander" as unknown as "gate" }),
    ).toThrow(/choice/);
    expect(() => painted(split(BLOCK), { choice: "ridge" })).toThrow(/budget/);
    expect(() =>
      painted(split(BLOCK), {
        choice: "ridge",
        ridge: {} as unknown as { budget: number },
      }),
    ).toThrow(/budget/);
    expect(() => painted(split(BLOCK), { choice: "gate" })).not.toThrow();
  });
});

/** The edges a painted mesh chose, each as the sorted pair of its end positions, with the bits counted by triangle edge. */
function chosenEdges(m: Mesh & { paint: Float32Array }) {
  const edges = new Map<
    string,
    { ends: number[][]; bits: number; along: Map<string, number> }
  >();
  let bits = 0;
  const at = (q: number[]) => q.map((x) => x.toFixed(4)).join(",");
  for (let t = 0; t < m.indices.length / 3; t++) {
    const { f, corner } = triangle(m, t);
    for (let i = 0; i < 3; i++) {
      if (!(f(0, 15) & (1 << i))) continue;
      bits++;
      const ends = [corner[(i + 1) % 3], corner[(i + 2) % 3]];
      const key = ends.map(at).sort().join("|");
      const e = edges.get(key) ?? { ends, bits: 0, along: new Map() };
      e.bits++;
      for (const c of [(i + 1) % 3, (i + 2) % 3])
        e.along.set(at(corner[c]), f(0, 16 + c));
      edges.set(key, e);
    }
  }
  return { edges, bits };
}

describe("painted, choosing by agreement", () => {
  const m = painted(split(BLOCK), { choice: "agree" });

  it("chooses one top edge of a block, and no other, with nothing along it", () => {
    // Each side face's best edge is its top one, the only one with up-share over nought. The top face scores its four
    // edges alike, so it picks the first it finds, and only that edge is agreed on; the other three top edges are
    // picked by their side alone. Each edge is two triangle edges, one in each face.
    const { edges, bits } = chosenEdges(m);
    expect(bits).toBe(2);
    expect(edges.size).toBe(1);
    const [only] = [...edges.values()];
    expect(only.bits).toBe(2);
    for (const q of only.ends) expect(q[2]).toBe(2);
    for (let v = 0; v < m.positions.length / 3; v++)
      expect(
        [16, 17, 18, 19].map((k) => m.paint[v * PAINT_STRIDE + k]),
      ).toEqual([0, 0, 0, 0]);
  });

  it("writes the same bits in the two triangles of a face, and in both faces of an edge", () => {
    for (let t = 0; t < 12; t++) {
      const { f } = triangle(m, t);
      for (let v = 1; v < 3; v++) expect(f(v, 15)).toBe(f(0, 15));
    }
  });

  it("chooses on a boulder only edges both of whose faces picked them, fewer than a face's own picks", () => {
    const rock = boulder(1, { seed: 3 }).parts[0].mesh;
    const { edges, bits } = chosenEdges(
      painted(split(rock), { choice: "agree" }),
    );
    expect(bits).toBe(2 * edges.size);
    expect(edges.size).toBe(2);
    for (const e of edges.values()) expect(e.bits).toBe(2);
  });
});

describe("painted, choosing ridgelines", () => {
  const radius = Math.sqrt(3);
  const block = (ridge: { budget: number; spacing?: number }) =>
    painted(split(BLOCK), { choice: "ridge", ridge });

  it("chains a block's right angles no further than the turn it allows, so a line is one edge, of its top", () => {
    // Every corner of a block turns ninety degrees, over the fifty a line may bend, so each of its twelve convex edges
    // is a line alone, and budget 1 takes the best, a top edge (up-share a half, where a side's is nought).
    const m = block({ budget: 1 });
    expect(m.paintStats.ridges).toEqual({ found: 12, chosen: 1 });
    const { edges, bits } = chosenEdges(m);
    expect(bits).toBe(2);
    const [only] = [...edges.values()];
    for (const q of only.ends) expect(q[2]).toBe(2);
    // the corners on it run 0 to 1, a level edge starting at its first end, and the corner off it is nought
    expect([...only.along.values()].sort()).toEqual([0, 1]);
    for (let t = 0; t < 12; t++) {
      const { f } = triangle(m, t);
      const bit = f(0, 15);
      for (let i = 0; i < 3; i++)
        if (bit === 1 << i) expect(f(0, 16 + i)).toBe(0);
    }
  });

  it("lets no line bend at a turn of nought: every convex edge over the floor is a line alone", () => {
    const rock = boulder(1, { seed: 3 }).parts[0].mesh;
    const m = painted(split(rock), {
      choice: "ridge",
      ridge: { budget: 3, maxTurn: 0, spacing: 0 },
    });
    expect(m.paintStats.ridges!.found).toBeGreaterThan(23);
    expect(m.paintStats.ridges!.chosen).toBe(3);
    expect(chosenEdges(m).edges.size).toBe(3);
  });

  it("keeps lines spacing apart: opposite top edges at 0.4 of the radius, only one at twice the radius", () => {
    // The four top edges are the only lines with a score. The two on opposite sides are 2 apart, over 0.4 * sqrt(3),
    // and the neighbours of either touch it, so budget 4 takes two; at a spacing of 2 radii none is far enough.
    const near = block({ budget: 4 });
    expect(near.paintStats.ridges).toEqual({ found: 12, chosen: 2 });
    expect(chosenEdges(near).edges.size).toBe(2);
    const far = block({ budget: 4, spacing: 2 });
    expect(far.paintStats.ridges).toEqual({ found: 12, chosen: 1 });
    expect(chosenEdges(far).edges.size).toBe(1);
    expect(radius).toBeGreaterThan(1.7);
  });

  it("still leaves one at budget 1 and twice the radius of spacing", () => {
    const m = block({ budget: 1, spacing: 2 });
    expect(m.paintStats.ridges).toEqual({ found: 12, chosen: 1 });
  });

  describe("on a boulder", () => {
    const rock = boulder(1, { seed: 3 }).parts[0].mesh;
    const m = painted(split(rock), { choice: "ridge", ridge: { budget: 3 } });
    const { edges, bits } = chosenEdges(m);

    it("finds twenty-three lines, takes three and chooses four edges", () => {
      // E21 saw 22 lines found; the production chaining goes on over the same convex edges but an edge exactly at the
      // floor is left out here, and a tie between two turns is settled by the first found, so a line more is found. E21's eight edges were counted by triangle edge, which is four edges.
      expect(m.paintStats.ridges).toEqual({ found: 23, chosen: 3 });
      expect(edges.size).toBe(4);
    });

    it("puts no edge in two lines: each is chosen from both its triangles, and the lines' edges add up to the bits", () => {
      for (const e of edges.values()) expect(e.bits).toBe(2);
      // join the chosen edges at their positions into lines
      const parent = new Map<string, string>();
      const root = (a: string): string => {
        while ((parent.get(a) ?? a) !== a) a = parent.get(a)!;
        return a;
      };
      const at = (q: number[]) => q.map((x) => x.toFixed(4)).join(",");
      for (const e of edges.values()) {
        const [a, b] = e.ends.map(at);
        parent.set(root(a), root(b));
        if (!parent.has(root(b))) parent.set(root(b), root(b));
      }
      const lines = new Map<
        string,
        typeof edges extends Map<string, infer V> ? V[] : never
      >();
      for (const e of edges.values()) {
        const r = root(at(e.ends[0]));
        lines.set(r, [...(lines.get(r) ?? []), e]);
      }
      expect(lines.size).toBe(3);
      let total = 0;
      for (const line of lines.values()) {
        total += line.length;
        // a position's place along its line is the same from every edge that has it, and runs from 0 to 1
        const place = new Map<string, number>();
        for (const e of line)
          for (const [k, v] of e.along) {
            expect(place.get(k) ?? v).toBeCloseTo(v, 6);
            place.set(k, v);
          }
        const values = [...place.values()];
        expect(Math.min(...values)).toBe(0);
        expect(Math.max(...values)).toBeCloseTo(1, 6);
        // the higher end is the head: nought sits at a z no lower than the one at 1
        const zOf = (value: number) => {
          const k = [...place].find(([, v]) => Math.abs(v - value) < 1e-6)![0];
          return Number(k.split(",")[2]);
        };
        expect(zOf(0)).toBeGreaterThanOrEqual(zOf(1));
      }
      expect(total).toBe(bits / 2);
    });
  });
});
