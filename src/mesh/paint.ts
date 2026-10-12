/**
 * The mesh pass of the painted edge. A faceted solid is drawn flat, so the only place a ridge exists is where two of
 * its triangles meet, and a fragment cannot see across that join. This measures it ahead of time and writes it into the
 * mesh: for each triangle its three edges' signed folds (positive where the surface bends away, a ridge, and negative
 * where it bends in, a crease), the height from each corner to the edge opposite so that a fragment's barycentrics give
 * its distance to each edge, the face the triangle belongs to (coplanar triangles merged, so a quad's diagonal and a
 * cap's fan are not seen), and how far each corner's crowd of ridges and each edge's lean toward the sky go. Without it
 * the fragment would have to guess a ridge from derivatives, which dash and wander on a flat-shaded mesh.
 *
 * The mesh must be split first (`split`): a vertex carries one corner index, and the solids write a quad as four
 * vertices and two triangles, which share two across the diagonal.
 *
 * What a vertex carries, `PAINT_STRIDE` floats, the same in a triangle's three vertices but for the corner. Edge i is
 * the one opposite corner i.
 *
 * | floats | holds |
 * | --- | --- |
 * | 0..2 | the signed fold of edge i, radians; positive convex, nought where flat or open |
 * | 3 | the corner index, 0, 1 or 2 |
 * | 4..6 | the height from corner i to edge i, in the mesh's own units |
 * | 7, 8, 9 | the lowest and highest z of the face, and the face's id (its index plus a hash of its first position) |
 * | 10, 11 | quiet (0 or 1), and which set of knobs the fragment reads, 0 to 3 |
 * | 12..14 | for corner i, its crowd (the convex edges over `CROWD_GATE` meeting at its position) plus edge i's up-share as (share + 1) / 4 |
 * | 15 | the chosen bits: bit i set if edge i carries the stroke under the `choice` |
 * | 16..18 | the place along the chosen ridgeline at corner i, 0 at its higher end and 1 at its lower; nought if none |
 * | 19 | spare, written nought |
 *
 * The up-share and the crowd share a float because the vertex stage has five vec4 locations free and no more: the
 * crowd is a whole number, so the share rides in the fraction, which is at most a half.
 */
import type { Mesh } from "./types";

/** Floats a vertex carries in `paint`: five vec4s. */
export const PAINT_STRIDE = 20;

/** The fold a convex edge must pass to count toward a corner's crowd: the gate the stroke is drawn at. */
export const CROWD_GATE = 0.3;

/** Normals agreeing within this many radians are one face cut in two, a quad's diagonal or a cap's fan. */
const FLAT = 1e-3;

/**
 * How the edges that carry the stroke are chosen: `'gate'` is every edge (the fragment's own gate decides), `'agree'`
 * an edge both of whose faces pick it as their best, and `'ridge'` the few ridgelines of the mesh's budget.
 */
export type PaintChoice = "gate" | "agree" | "ridge";

export interface PaintOptions {
  /** Which set of knobs the fragment reads for this mesh, 0 to 3. Default 0. */
  set?: number;
  /** Every layer at nought for this mesh, as a ground is drawn. Default false. */
  quiet?: boolean;
  /** How the edges that carry the stroke are chosen. Default `'gate'`. */
  choice?: PaintChoice;
  /**
   * The ridgelines under `'ridge'`, which throws without them. `floor` is the least fold a ridge edge may have (default
   * 0.15 radians), `maxTurn` the sharpest bend a line may take at a vertex, in radians (default 50 degrees), `budget`
   * how many lines are drawn, a count the caller sizes to the mesh's place in the world, and `spacing` how far apart
   * two lines must stay, as a share of the mesh's bounding radius (default 0.4).
   */
  ridge?: {
    floor?: number;
    maxTurn?: number;
    budget: number;
    spacing?: number;
  };
  /** How near two positions must be to be one, in the mesh's own units. Default 1e-5. */
  tolerance?: number;
}

/** What the pass found, counted by triangle edge (a ridge between two triangles is counted once from each). */
export interface PaintStats {
  triangles: number;
  /** Coplanar triangles merged by flood fill: a quad's two, a cap's fan. */
  faces: number;
  edges: {
    /** Folded away from the surface, a ridge. */
    convex: number;
    /** Folded into it, a crease. */
    concave: number;
    /** Neighbour in the same plane, or a triangle with no area. */
    flat: number;
    /** No other triangle on the two positions. */
    open: number;
  };
  /** Under `'ridge'`: the lines chained, and the lines taken within the budget and spacing. */
  ridges?: { found: number; chosen: number };
}

/**
 * The mesh with every triangle its own three vertices, each keeping the position, normal and uv it had. A vertex can
 * carry only one corner index, so the solids' quads, which share two vertices across the diagonal, have to come apart.
 */
export function split(mesh: Mesh): Mesh {
  const idx = mesh.indices,
    k = idx.length;
  const positions = new Float32Array(k * 3),
    normals = new Float32Array(k * 3),
    uvs = new Float32Array(k * 2);
  for (let i = 0; i < k; i++) {
    const v = idx[i];
    for (let a = 0; a < 3; a++) {
      positions[i * 3 + a] = mesh.positions[v * 3 + a];
      normals[i * 3 + a] = mesh.normals[v * 3 + a];
    }
    uvs[i * 2] = mesh.uvs[v * 2] ?? 0;
    uvs[i * 2 + 1] = mesh.uvs[v * 2 + 1] ?? 0;
  }
  return {
    positions,
    normals,
    uvs,
    indices: Uint32Array.from({ length: k }, (_, i) => i),
  };
}

/**
 * The mesh with its `paint` written, and what was found. It throws if two triangles use one index (call `split`
 * first), and under `'ridge'` without a `budget`. The mesh given is not changed.
 */
export function painted(
  mesh: Mesh,
  options: PaintOptions = {},
): Mesh & { paint: Float32Array; paintStats: PaintStats } {
  const { set = 0, quiet = false, choice = "gate", tolerance = 1e-5 } = options;
  if (choice !== "gate" && choice !== "agree" && choice !== "ridge")
    throw new Error(`painted: the '${choice}' choice is not known`);
  const ridgeOptions = options.ridge;
  if (choice === "ridge" && !(Number(ridgeOptions?.budget) >= 0))
    throw new Error("painted: the 'ridge' choice needs a ridge budget");
  const idx = mesh.indices,
    p = mesh.positions;
  const verts = p.length / 3,
    tris = idx.length / 3;
  const seen = new Uint8Array(verts);
  for (const v of idx) {
    if (seen[v])
      throw new Error(
        `painted: vertex ${v} is used by two triangles; split the mesh first`,
      );
    seen[v] = 1;
  }

  // A position's number: positions that agree to the tolerance get one, so the triangles of one corner find each other
  // however their vertices were written. The quantised key is a string, which no float rounding can split.
  const ids = new Map<string, number>();
  const place = new Int32Array(verts);
  for (let v = 0; v < verts; v++) {
    const key = [0, 1, 2]
      .map((k) => Math.round(p[v * 3 + k] / tolerance) + 0)
      .join(",");
    let id = ids.get(key);
    if (id === undefined) ids.set(key, (id = ids.size));
    place[v] = id;
  }
  const points = ids.size;
  // An edge's number from its two positions' numbers, the smaller first.
  const edgeOf = (a: number, b: number) =>
    a < b ? a * points + b : b * points + a;

  const normal = new Float64Array(tris * 3),
    centre = new Float64Array(tris * 3),
    heights = new Float64Array(tris * 3);
  const edgeKey = new Float64Array(tris * 3);
  const onEdge = new Map<number, number[]>();
  for (let t = 0; t < tris; t++) {
    const [a, b, c] = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]];
    const e1 = [0, 1, 2].map((k) => p[b * 3 + k] - p[a * 3 + k]);
    const e2 = [0, 1, 2].map((k) => p[c * 3 + k] - p[a * 3 + k]);
    const n = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const twiceArea = Math.hypot(n[0], n[1], n[2]);
    for (let k = 0; k < 3; k++) {
      normal[t * 3 + k] = twiceArea > 0 ? n[k] / twiceArea : 0;
      centre[t * 3 + k] = (p[a * 3 + k] + p[b * 3 + k] + p[c * 3 + k]) / 3;
    }
    const corner = [a, b, c];
    for (let i = 0; i < 3; i++) {
      // edge i runs between the other two corners
      const u = corner[(i + 1) % 3],
        w = corner[(i + 2) % 3];
      const length = Math.hypot(
        p[u * 3] - p[w * 3],
        p[u * 3 + 1] - p[w * 3 + 1],
        p[u * 3 + 2] - p[w * 3 + 2],
      );
      heights[t * 3 + i] = length > 0 ? twiceArea / length : 0;
      const key = edgeOf(place[u], place[w]);
      edgeKey[t * 3 + i] = key;
      const list = onEdge.get(key);
      if (list) list.push(t);
      else onEdge.set(key, [t]);
    }
  }
  // The triangle across edge i of t, the first found where more than two meet, or -1 where none does.
  const across = (t: number, i: number) =>
    onEdge.get(edgeKey[t * 3 + i])!.find((o) => o !== t) ?? -1;

  const stats: PaintStats = {
    triangles: tris,
    faces: 0,
    edges: { convex: 0, concave: 0, flat: 0, open: 0 },
  };
  const folds = new Float64Array(tris * 3);
  const up = new Float64Array(tris * 3);
  const flatWith: number[][] = Array.from({ length: tris }, () => []);
  for (let t = 0; t < tris; t++)
    for (let i = 0; i < 3; i++) {
      const o = across(t, i);
      if (o < 0) {
        stats.edges.open++;
        up[t * 3 + i] = normal[t * 3 + 2];
        continue;
      }
      up[t * 3 + i] = (normal[t * 3 + 2] + normal[o * 3 + 2]) / 2;
      const dot =
        normal[t * 3] * normal[o * 3] +
        normal[t * 3 + 1] * normal[o * 3 + 1] +
        normal[t * 3 + 2] * normal[o * 3 + 2];
      const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
      const degenerate = !(
        Math.hypot(normal[t * 3], normal[t * 3 + 1], normal[t * 3 + 2]) > 0 &&
        Math.hypot(normal[o * 3], normal[o * 3 + 1], normal[o * 3 + 2]) > 0
      );
      if (degenerate || angle < FLAT) {
        stats.edges.flat++;
        if (!degenerate) flatWith[t].push(o);
        continue;
      }
      // The neighbour's middle is below this triangle's plane where the surface bends away from it, a ridge.
      let below = 0;
      for (let k = 0; k < 3; k++)
        below += normal[t * 3 + k] * (centre[o * 3 + k] - centre[t * 3 + k]);
      folds[t * 3 + i] = below < 0 ? angle : -angle;
      if (below < 0) stats.edges.convex++;
      else stats.edges.concave++;
    }

  // The faces, by flood fill over the flat neighbours: each takes the z extent of all its triangles and an id, its
  // index plus a hash of its first position under one, so that two faces never share an id and a fragment can tell them apart.
  const faceOf = new Int32Array(tris).fill(-1);
  const faceZ: [number, number][] = [];
  const faceId: number[] = [];
  for (let first = 0; first < tris; first++) {
    if (faceOf[first] >= 0) continue;
    const f = faceZ.length;
    let zMin = Infinity,
      zMax = -Infinity;
    const stack = [first];
    faceOf[first] = f;
    while (stack.length) {
      const t = stack.pop()!;
      for (let c = 0; c < 3; c++) {
        const z = p[idx[t * 3 + c] * 3 + 2];
        zMin = Math.min(zMin, z);
        zMax = Math.max(zMax, z);
      }
      for (const o of flatWith[t])
        if (faceOf[o] < 0) {
          faceOf[o] = f;
          stack.push(o);
        }
    }
    faceZ.push([zMin, zMax]);
    const v = idx[first * 3];
    const hash =
      Math.abs(
        Math.sin(
          p[v * 3] * 12.9898 + p[v * 3 + 1] * 78.233 + p[v * 3 + 2] * 37.719,
        ) * 43758.5453,
      ) % 1;
    faceId.push(f + hash);
  }
  stats.faces = faceZ.length;

  // The crowd at each position: the convex edges over the gate meeting there, each counted once however many triangles
  // share it, so that a corner where several ridges meet can let its stroke fade and the star of strokes with it.
  const crowd = new Int32Array(points);
  const counted = new Set<number>();
  for (let t = 0; t < tris; t++)
    for (let i = 0; i < 3; i++) {
      const key = edgeKey[t * 3 + i];
      if (folds[t * 3 + i] <= CROWD_GATE || counted.has(key)) continue;
      counted.add(key);
      crowd[Math.floor(key / points)]++;
      crowd[key % points]++;
    }

  // The edges that carry the stroke, as a set of edge numbers (all of them under the gate), and under `'ridge'` the
  // place along its line of each position on one.
  let chosen: Set<number> | null = null;
  let alongPlace: Map<number, number> | null = null;
  const placePosition = new Float64Array(points * 3);
  for (let v = verts - 1; v >= 0; v--)
    for (let k = 0; k < 3; k++) placePosition[place[v] * 3 + k] = p[v * 3 + k];
  if (choice === "agree") {
    chosen = agreedEdges({ tris, faceOf, edgeKey, onEdge, folds, up, p, idx });
  } else if (choice === "ridge") {
    const r = ridgeLines({
      tris,
      points,
      edgeKey,
      folds,
      up,
      at: placePosition,
      options: ridgeOptions!,
    });
    chosen = r.chosen;
    alongPlace = r.along;
    stats.ridges = { found: r.found, chosen: r.taken };
  }

  const paint = new Float32Array(verts * PAINT_STRIDE);
  for (let t = 0; t < tris; t++) {
    const [zMin, zMax] = faceZ[faceOf[t]];
    let bits = 7;
    const along = [0, 0, 0];
    if (chosen) {
      bits = 0;
      for (let i = 0; i < 3; i++) {
        if (!chosen.has(edgeKey[t * 3 + i])) continue;
        bits |= 1 << i;
        if (alongPlace)
          for (const c of [(i + 1) % 3, (i + 2) % 3])
            along[c] = alongPlace.get(place[idx[t * 3 + c]]) ?? 0;
      }
    }
    const crowds = [0, 1, 2].map(
      (c) => crowd[place[idx[t * 3 + c]]] + (up[t * 3 + c] + 1) / 4,
    );
    for (let corner = 0; corner < 3; corner++)
      paint.set(
        [
          folds[t * 3],
          folds[t * 3 + 1],
          folds[t * 3 + 2],
          corner,
          heights[t * 3],
          heights[t * 3 + 1],
          heights[t * 3 + 2],
          zMin,
          zMax,
          faceId[faceOf[t]],
          quiet ? 1 : 0,
          set,
          crowds[0],
          crowds[1],
          crowds[2],
          bits,
          along[0],
          along[1],
          along[2],
          0,
        ],
        idx[t * 3 + corner] * PAINT_STRIDE,
      );
  }
  return { ...mesh, paint, paintStats: stats };
}

/**
 * The edges two faces agree on (E20). Each face scores its border edges, those whose neighbour is in another face or
 * is none, by convex fold times up-share (each clamped at nought) times length, and picks the best, the first found
 * where two tie. An edge is chosen only where every face on it picked it, since a pick by one face alone is seldom its
 * neighbour's and the union of picks is most of the strong edges. An edge scoring nought is never picked.
 */
function agreedEdges(a: {
  tris: number;
  faceOf: Int32Array;
  edgeKey: Float64Array;
  onEdge: Map<number, number[]>;
  folds: Float64Array;
  up: Float64Array;
  p: Float32Array;
  idx: Uint32Array;
}): Set<number> {
  const { tris, faceOf, edgeKey, onEdge, folds, up, p, idx } = a;
  const best = new Map<number, { key: number; score: number }>();
  for (let t = 0; t < tris; t++)
    for (let i = 0; i < 3; i++) {
      const key = edgeKey[t * 3 + i];
      const across = onEdge.get(key)!.find((o) => o !== t);
      if (across !== undefined && faceOf[across] === faceOf[t]) continue;
      const u = idx[t * 3 + ((i + 1) % 3)],
        w = idx[t * 3 + ((i + 2) % 3)];
      const length = Math.hypot(
        p[u * 3] - p[w * 3],
        p[u * 3 + 1] - p[w * 3 + 1],
        p[u * 3 + 2] - p[w * 3 + 2],
      );
      const score =
        Math.max(folds[t * 3 + i], 0) * Math.max(up[t * 3 + i], 0) * length;
      const was = best.get(faceOf[t]);
      if (score > 0 && (!was || score > was.score))
        best.set(faceOf[t], { key, score });
    }
  const picks = new Map<number, number>();
  for (const { key } of best.values())
    picks.set(key, (picks.get(key) ?? 0) + 1);
  const chosen = new Set<number>();
  for (const [key, n] of picks) {
    const faces = new Set(onEdge.get(key)!.map((t) => faceOf[t]));
    if (n === faces.size) chosen.add(key);
  }
  return chosen;
}

/** The distance from point q to the segment ab. */
function segmentDistance(q: number[], a: number[], b: number[]): number {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
    aq = [q[0] - a[0], q[1] - a[1], q[2] - a[2]];
  const span = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  const s = Math.max(
    0,
    Math.min(
      1,
      (ab[0] * aq[0] + ab[1] * aq[1] + ab[2] * aq[2]) / Math.max(span, 1e-12),
    ),
  );
  return Math.hypot(aq[0] - s * ab[0], aq[1] - s * ab[1], aq[2] - s * ab[2]);
}

/**
 * The ridgelines (E21). The convex edges over the floor are chained, each into one line only: from the strongest edge
 * left, at each end on into the unused convex edge that turns least, if under the greatest turn, never back onto a
 * vertex the line has. A line scores its length times its mean fold times its mean up-share (by length, the share
 * clamped at nought), and the best are taken one by one up to the budget, passing over any whose nearest point to a
 * line already taken is nearer than `spacing` times the mesh's bounding radius. For each line taken it gives each
 * position's place along it by length, nought at the higher end (the greater z, the first where level) and one at the
 * lower, since a stroke is loaded at its head and runs dry along its tail, and a painter starts a ridge from the top.
 */
function ridgeLines(a: {
  tris: number;
  points: number;
  edgeKey: Float64Array;
  folds: Float64Array;
  up: Float64Array;
  at: Float64Array;
  options: NonNullable<PaintOptions["ridge"]>;
}): {
  chosen: Set<number>;
  along: Map<number, number>;
  found: number;
  taken: number;
} {
  const { tris, points, edgeKey, folds, up, at, options } = a;
  const floor = options.floor ?? 0.15,
    maxTurn = options.maxTurn ?? (50 * Math.PI) / 180,
    spacing = options.spacing ?? 0.4;
  const pos = (v: number) => [at[v * 3], at[v * 3 + 1], at[v * 3 + 2]];
  interface Edge {
    key: number;
    a: number;
    b: number;
    fold: number;
    up: number;
    length: number;
  }
  const edges = new Map<number, Edge>();
  for (let t = 0; t < tris; t++)
    for (let i = 0; i < 3; i++) {
      const key = edgeKey[t * 3 + i];
      if (edges.has(key) || !(folds[t * 3 + i] > floor)) continue;
      const u = Math.floor(key / points),
        w = key % points;
      edges.set(key, {
        key,
        a: u,
        b: w,
        fold: folds[t * 3 + i],
        up: up[t * 3 + i],
        length: Math.hypot(
          at[u * 3] - at[w * 3],
          at[u * 3 + 1] - at[w * 3 + 1],
          at[u * 3 + 2] - at[w * 3 + 2],
        ),
      });
    }
  const atVertex = new Map<number, Edge[]>();
  for (const e of edges.values())
    for (const v of [e.a, e.b]) {
      const list = atVertex.get(v);
      if (list) list.push(e);
      else atVertex.set(v, [e]);
    }
  const direction = (from: number, to: number) => {
    const d = [0, 1, 2].map((k) => at[to * 3 + k] - at[from * 3 + k]);
    const n = Math.hypot(d[0], d[1], d[2]) || 1;
    return [d[0] / n, d[1] / n, d[2] / n];
  };
  const strength = (e: Edge) => e.fold * Math.max(e.up, 0) * e.length;

  interface Line {
    verts: number[];
    edges: Edge[];
  }
  const used = new Set<number>();
  const lines: Line[] = [];
  const seeds = [...edges.values()].sort((x, y) => strength(y) - strength(x));
  for (const seed of seeds) {
    if (used.has(seed.key)) continue;
    used.add(seed.key);
    const verts = [seed.a, seed.b],
      along = [seed];
    const on = new Set(verts);
    for (const forward of [true, false])
      for (;;) {
        const end = forward ? verts[verts.length - 1] : verts[0];
        const prev = forward ? verts[verts.length - 2] : verts[1];
        const d = direction(prev, end);
        let next: Edge | null = null,
          turnLeast = maxTurn;
        for (const e of atVertex.get(end) ?? []) {
          const far = e.a === end ? e.b : e.a;
          if (used.has(e.key) || on.has(far)) continue;
          const n = direction(end, far);
          const turn = Math.acos(
            Math.max(-1, Math.min(1, d[0] * n[0] + d[1] * n[1] + d[2] * n[2])),
          );
          if (turn < turnLeast) {
            turnLeast = turn;
            next = e;
          }
        }
        if (!next) break;
        used.add(next.key);
        const far = next.a === end ? next.b : next.a;
        on.add(far);
        if (forward) {
          verts.push(far);
          along.push(next);
        } else {
          verts.unshift(far);
          along.unshift(next);
        }
      }
    lines.push({ verts, edges: along });
  }

  // The mesh's bounding radius about the middle of its box, which spacing is a share of.
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < points; v++)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], at[v * 3 + k]);
      hi[k] = Math.max(hi[k], at[v * 3 + k]);
    }
  let radius = 0;
  for (let v = 0; v < points; v++)
    radius = Math.max(
      radius,
      Math.hypot(
        at[v * 3] - (lo[0] + hi[0]) / 2,
        at[v * 3 + 1] - (lo[1] + hi[1]) / 2,
        at[v * 3 + 2] - (lo[2] + hi[2]) / 2,
      ),
    );

  const scoreOf = (l: Line) => {
    const length = l.edges.reduce((s, e) => s + e.length, 0);
    const fold = l.edges.reduce((s, e) => s + e.fold * e.length, 0) / length;
    const share =
      l.edges.reduce((s, e) => s + Math.max(e.up, 0) * e.length, 0) / length;
    return length * fold * share;
  };
  // The nearest two lines come, from each segment's ends and middle of one to the segments of the other.
  const nearest = (x: Line, y: Line) => {
    let d = Infinity;
    for (const e of x.edges) {
      const [pa, pb] = [pos(e.a), pos(e.b)];
      const mid = [0, 1, 2].map((k) => (pa[k] + pb[k]) / 2);
      for (const f of y.edges)
        for (const q of [pa, pb, mid])
          d = Math.min(d, segmentDistance(q, pos(f.a), pos(f.b)));
    }
    return d;
  };
  const ranked = lines
    .map((line) => ({ line, score: scoreOf(line) }))
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score);
  const taken: Line[] = [];
  for (const { line } of ranked) {
    if (taken.length >= options.budget) break;
    if (taken.some((o) => nearest(line, o) < spacing * radius)) continue;
    taken.push(line);
  }

  const chosen = new Set<number>(),
    along = new Map<number, number>();
  for (const line of taken) {
    for (const e of line.edges) chosen.add(e.key);
    const head =
      at[line.verts[0] * 3 + 2] >=
      at[line.verts[line.verts.length - 1] * 3 + 2];
    const verts = head ? line.verts : [...line.verts].reverse();
    const total = line.edges.reduce((s, e) => s + e.length, 0) || 1;
    let run = 0;
    along.set(verts[0], 0);
    for (let k = 1; k < verts.length; k++) {
      const [pa, pb] = [pos(verts[k - 1]), pos(verts[k])];
      run += Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);
      along.set(verts[k], run / total);
    }
  }
  return { chosen, along, found: lines.length, taken: taken.length };
}
