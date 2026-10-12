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

/** How the edges that carry the stroke are chosen. Only `'gate'`, every edge, is made so far. */
export type PaintChoice = "gate" | "agree" | "ridge";

export interface PaintOptions {
  /** Which set of knobs the fragment reads for this mesh, 0 to 3. Default 0. */
  set?: number;
  /** Every layer at nought for this mesh, as a ground is drawn. Default false. */
  quiet?: boolean;
  /** How the edges that carry the stroke are chosen. Default `'gate'`. */
  choice?: PaintChoice;
  /** The ridgelines under `'ridge'`: `budget` is a count, which the caller sizes to the mesh's place in the world. */
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
 * first), and for a `choice` that is not made yet. The mesh given is not changed.
 */
export function painted(
  mesh: Mesh,
  options: PaintOptions = {},
): Mesh & { paint: Float32Array; paintStats: PaintStats } {
  const { set = 0, quiet = false, choice = "gate", tolerance = 1e-5 } = options;
  if (choice !== "gate")
    throw new Error(`painted: the '${choice}' choice is not yet made`);
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

  const paint = new Float32Array(verts * PAINT_STRIDE);
  for (let t = 0; t < tris; t++) {
    const [zMin, zMax] = faceZ[faceOf[t]];
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
          7,
          0,
          0,
          0,
          0,
        ],
        idx[t * 3 + corner] * PAINT_STRIDE,
      );
  }
  return { ...mesh, paint, paintStats: stats };
}
