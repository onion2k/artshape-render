import { detail } from './detail';
import earcut from 'earcut';
import type { Vec2 } from '../geom/types';
import { ensureWinding } from '../geom/outline';
import { MeshBuilder, type Mesh } from './types';

export interface ExtrudeOptions {
  /** Closed outer boundary, counter-clockwise. */
  outline: Vec2[];
  /** Closed hole boundaries, clockwise. */
  holes?: Vec2[][];
  thickness: number;
  /**
   * Edge break on both faces. Small but load-bearing: a plate with square edges
   * catches no light along its outline and reads as cut paper rather than metal.
   */
  bevel?: number;
  /**
   * Spacing of the interior vertices to give the cap, for a plate that is going
   * to be bent afterwards.
   *
   * Ear clipping is free to answer with long fans — one vertex joined to a run of
   * distant ones — and on a flat plate that is a perfectly good triangulation.
   * Bend it and those fans chord straight across the curve, so the middle of a
   * cupped leaf stays flat and creases where the fans meet — and every sliver
   * frays the highlight. Left undefined the cap is triangulated as before.
   */
  maxCapEdge?: number;
  /**
   * Enamel the top face. The cap inside the bevel is the cell; the bevel and
   * the walls stay metal, which is the rim a fired enamel always has.
   */
  enamelTop?: boolean;
}

/**
 * Extrude a pierced 2D outline into a plate.
 *
 * Caps are triangulated in 2D — the only triangulation this project needs, since
 * parts are separate pieces that overlap and are riveted rather than booleaned
 * together. Walls and bevels are quad strips that follow the outline.
 */
export function extrude(opts: ExtrudeOptions): Mesh {
  const holes = opts.holes ?? [];
  const bevel = Math.min(opts.bevel ?? 0, opts.thickness / 2 - 1e-4);
  const hz = opts.thickness / 2;
  const inner = hz - bevel;

  const loops = [opts.outline, ...holes];
  const insets = loops.map((l) => (bevel > 0 ? insetLoop(l, bevel) : l));

  const mb = new MeshBuilder();
  const span = boundsOf(opts.outline);
  let topCap: [number, number] = [0, 0];
  let bottomCap: [number, number] = [0, 0];

  // --- caps, from the inset outline so the bevel has somewhere to sit ---
  for (const top of [true, false]) {
    const range = cap(mb, insets, top ? hz : -hz, top, span, opts.maxCapEdge);
    if (top) topCap = range;
    else bottomCap = range;
  }

  // --- bevel bands and walls, one ring pair per loop ---
  for (let li = 0; li < loops.length; li++) {
    const loop = loops[li];
    const insetLoopPts = insets[li];
    const outward = outwardNormals(loop);
    const perimeter = perimeterParam(loop);

    if (bevel > 0) {
      band(mb, insetLoopPts, loop, hz, inner, outward, perimeter, 1);
      band(mb, insetLoopPts, loop, hz, inner, outward, perimeter, -1);
    }
    // the straight wall between the two bevels
    wall(mb, loop, inner, -inner, outward, perimeter);
  }

  const mesh = mb.build();
  mesh.uvSpan = [span.minX, span.minY, span.width, span.height];
  // engraving coordinates: the plate's own flat coordinates on the caps. The
  // walls and bevels carry uv of their own kind and are not engraved.
  mesh.engrave = new Float32Array(mesh.positions.length / 3 * 2);
  for (let i = 0; i < mesh.positions.length / 3; i++) {
    mesh.engrave[i * 2] = span.minX + mesh.uvs[i * 2] * span.width;
    mesh.engrave[i * 2 + 1] = span.minY + mesh.uvs[i * 2 + 1] * span.height;
  }
  mesh.cap = new Float32Array(mesh.positions.length / 3);
  mesh.cap.fill(1, topCap[0], topCap[1]);
  mesh.cap.fill(-1, bottomCap[0], bottomCap[1]);
  if (opts.enamelTop) {
    mesh.enamel = new Float32Array(mesh.positions.length / 3);
    mesh.enamel.fill(1, topCap[0], topCap[1]);
  }
  return mesh;
}

/**
 * One cap: the loops triangulated with earcut, seeded with interior points,
 * at height z facing up or down. Returns the vertex range it added.
 */
function cap(
  mb: MeshBuilder, loops: Vec2[][], z: number, top: boolean,
  span: ReturnType<typeof boundsOf>, maxCapEdge?: number,
): [number, number] {
  const nz = top ? 1 : -1;
  const flat: number[] = [];
  const holeIndices: number[] = [];
  for (let li = 0; li < loops.length; li++) {
    if (li > 0) holeIndices.push(flat.length / 2);
    for (const [x, y] of loops[li]) flat.push(x, y);
  }
  let tri = earcut(flat, holeIndices, 2);
  let points = flat;
  // A cap always gets some interior points, however flat it is. Per-vertex
  // shading — baked occlusion, curvature wear — interpolates across whatever
  // triangles exist, and a fan of slivers from rim to rim smears an edge value
  // over the whole face. Twenty or so points across the span is enough, and
  // still reaches the bars of a pierced leaf.
  // a draft takes fewer: at half the detail, half as many across and a quarter of the cap
  const spacing = Math.min(maxCapEdge ?? Infinity, (Math.max(span.width, span.height) * 0.05) / detail());
  if (Number.isFinite(spacing) && spacing > 0) {
    ({ points, tris: tri } = tessellateCap(points, tri, loops, spacing));
  }
  const base = mb.vertexCount;
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i], y = points[i + 1];
    mb.vertex(x, y, z, 0, 0, nz, (x - span.minX) / span.width, (y - span.minY) / span.height);
  }
  for (let i = 0; i < tri.length; i += 3) {
    // Every triangle is kept, including the occasional sliver earcut leaves
    // where an outline is nearly collinear. They are invisible, but they carry
    // edges: dropping them tears real holes in the cap around each piercing.
    if (top) mb.triangle(base + tri[i], base + tri[i + 1], base + tri[i + 2]);
    else mb.triangle(base + tri[i], base + tri[i + 2], base + tri[i + 1]);
  }
  return [base, mb.vertexCount];
}

export interface Tier {
  /** Closed outer boundary, counter-clockwise; must lie within the tier below. */
  outline: Vec2[];
  thickness: number;
}

export interface SteppedOptions {
  /** Tiers from the foot up. */
  tiers: Tier[];
  /** Edge break on every tier's top edge and the foot's bottom edge. */
  bevel?: number;
  maxCapEdge?: number;
  /** Enamel the treads: every tier's top face inside its bevel. */
  enamelTop?: boolean;
}

/**
 * A stepped plate: tiers of outlines stacked, each smaller than the one
 * below — the ziggurat of the deco vocabulary — built as one mesh with no
 * hidden faces. Each tier is its outer walls and a top bevel; its cap is the
 * tread, the ring the tier above leaves uncovered, and the top tier's cap is
 * whole. A tier's foot meets the tread below at a sharp inside corner, the
 * way a cast or machined step does, so it has no lower bevel.
 *
 * The foot sits at z = 0 and the stack rises along +Z.
 */
export function extrudeStepped(opts: SteppedOptions): Mesh {
  const tiers = opts.tiers;
  if (!tiers.length) throw new Error('a stepped plate needs at least one tier');
  const mb = new MeshBuilder();
  const span = boundsOf(tiers[0].outline);
  const treads: Array<[number, number]> = [];
  let bottomCap: [number, number] = [0, 0];

  let z = 0;
  for (let k = 0; k < tiers.length; k++) {
    const tier = tiers[k];
    const loop = ensureWinding(tier.outline, true);
    const bevel = Math.min(opts.bevel ?? 0, tier.thickness / 2 - 1e-4);
    const top = z + tier.thickness;
    const insetPts = bevel > 0 ? insetLoop(loop, bevel) : loop;
    const outward = outwardNormals(loop);
    const perimeter = perimeterParam(loop);

    const mid = z + tier.thickness / 2;
    const half = tier.thickness / 2;
    // the foot: a bevelled bottom cap on the first tier only
    if (k === 0) {
      bottomCap = cap(mb, [insetPts], z, false, span, opts.maxCapEdge);
      if (bevel > 0) band(mb, insetPts, loop, half, half - bevel, outward, perimeter, -1, 3, mid);
    }
    // the wall, from the foot (or the tread below) up to the top bevel
    const wallBottom = k === 0 && bevel > 0 ? z + bevel : z;
    wall(mb, loop, top - bevel, wallBottom, outward, perimeter);
    if (bevel > 0) band(mb, insetPts, loop, half, half - bevel, outward, perimeter, 1, 3, mid);

    // the tread: this tier's top inside its bevel, less the tier above
    const above = tiers[k + 1];
    const holes = above ? [ensureWinding(above.outline, false)] : [];
    treads.push(cap(mb, [insetPts, ...holes], top, true, span, opts.maxCapEdge));
    z = top;
  }

  const mesh = mb.build();
  mesh.uvSpan = [span.minX, span.minY, span.width, span.height];
  mesh.engrave = new Float32Array(mesh.positions.length / 3 * 2);
  for (let i = 0; i < mesh.positions.length / 3; i++) {
    mesh.engrave[i * 2] = span.minX + mesh.uvs[i * 2] * span.width;
    mesh.engrave[i * 2 + 1] = span.minY + mesh.uvs[i * 2 + 1] * span.height;
  }
  mesh.cap = new Float32Array(mesh.positions.length / 3);
  for (const [a, b] of treads) mesh.cap.fill(1, a, b);
  mesh.cap.fill(-1, bottomCap[0], bottomCap[1]);
  if (opts.enamelTop) {
    mesh.enamel = new Float32Array(mesh.positions.length / 3);
    for (const [a, b] of treads) mesh.enamel.fill(1, a, b);
  }
  return mesh;
}

/**
 * Give the cap interior vertices, then make its triangles well shaped.
 *
 * Ear clipping only ever uses the points it is given, and those are all on the
 * boundary. On a leaf that is a ribbon — a hundred points strung along two
 * margins ten millimetres apart — so every triangle it can possibly make is a
 * sliver: a fraction of a millimetre at one end and centimetres long. Flat, that
 * costs nothing, since a sliver in a plane is still exactly in the plane. Bend
 * the plate and those same slivers chord across the curve and tear the highlight
 * into a zigzag, which is what the eye actually notices.
 *
 * No amount of splitting existing edges fixes it, because splitting a sliver
 * gives two slivers. What is missing is points in the middle, so they are put
 * there directly: a lattice at the spacing the curvature asks for, each point
 * inserted into the triangle that contains it, then edges flipped toward Delaunay
 * and the interior relaxed. That is a mesh improvement pass rather than a mesher —
 * the boundary is never touched, so the cap still matches the bevel exactly.
 */
function tessellateCap(
  flat: number[], tris: number[], loops: Vec2[][], spacing: number,
): { points: number[]; tris: number[] } {
  const points = [...flat];
  const faces = [...tris];
  const boundaryVertices = flat.length / 2;

  const px = (i: number) => points[i * 2];
  const py = (i: number) => points[i * 2 + 1];
  const area2 = (a: number, b: number, c: number) =>
    (px(b) - px(a)) * (py(c) - py(a)) - (px(c) - px(a)) * (py(b) - py(a));

  // --- interior points, on a staggered lattice, clear of every boundary ---
  const inserted: number[] = [];
  {
    const outer = flatLoop(loops[0]);
    const holes = loops.slice(1).map(flatLoop);
    const clear = spacing * 0.62;
    const clear2 = clear * clear;
    const dy = spacing * Math.sqrt(3) / 2;
    for (let j = 0, y = outer.minY + dy; y < outer.maxY; j++, y += dy) {
      for (let x = outer.minX + (j % 2 ? spacing / 2 : 0); x < outer.maxX; x += spacing) {
        if (!insideFlat(x, y, outer)) continue;
        if (distance2Flat(x, y, outer) < clear2) continue;
        let ok = true;
        for (const h of holes) {
          // a hole only matters to points near its box
          if (x < h.minX - clear || x > h.maxX + clear || y < h.minY - clear || y > h.maxY + clear) continue;
          if (insideFlat(x, y, h) || distance2Flat(x, y, h) < clear2) { ok = false; break; }
        }
        if (ok) inserted.push(x, y);
      }
    }
  }
  if (!inserted.length) return { points, tris: faces };
  const stride = boundaryVertices + inserted.length / 2 + 1;

  // --- split the containing triangle three ways for each new point ---
  //
  // Finding that triangle is the whole cost of the step. Lattice points come
  // row by row, so each is a few triangles from the last, and a walk across
  // shared edges gets there in a handful of steps. The walk keeps a neighbour
  // per edge, patched at every split. It stops at the boundary, which a row
  // that crosses a piercing or a bay in the outline does; then, and only then,
  // every triangle is scanned.
  const adj: number[] = new Array(faces.length).fill(-1);
  {
    // an edge as one small integer, so the Map stays on its fast path
    const edgeKey = (a: number, b: number, stride: number) => (a < b ? a * stride + b : b * stride + a);
    const half = new Map<number, number>();
    for (let t = 0; t < faces.length; t += 3) {
      for (let i = 0; i < 3; i++) {
        const k = edgeKey(faces[t + i], faces[t + ((i + 1) % 3)], stride);
        const other = half.get(k);
        if (other === undefined) { half.set(k, t + i); continue; }
        adj[t + i] = other - (other % 3);
        adj[other] = t;
      }
    }
  }
  const side = (a: number, b: number, x: number, y: number) =>
    (px(b) - px(a)) * (y - py(a)) - (x - px(a)) * (py(b) - py(a));
  const locate = (from: number, x: number, y: number): number => {
    let t = from;
    const limit = faces.length / 3 + 8;
    for (let step = 0; step < limit; step++) {
      const a = faces[t], b = faces[t + 1], c = faces[t + 2];
      const s = Math.sign(area2(a, b, c)) || 1;
      const d0 = side(a, b, x, y) * s, d1 = side(b, c, x, y) * s, d2 = side(c, a, x, y) * s;
      if (d0 >= 0 && d1 >= 0 && d2 >= 0) return t;
      const i = d0 < d1 ? (d0 < d2 ? 0 : 2) : (d1 < d2 ? 1 : 2);
      const next = adj[t + i];
      if (next < 0) break;
      t = next;
    }
    for (let u = 0; u < faces.length; u += 3) {
      const a = faces[u], b = faces[u + 1], c = faces[u + 2];
      const s = Math.sign(area2(a, b, c)) || 1;
      if (side(a, b, x, y) * s >= 0 && side(b, c, x, y) * s >= 0 && side(c, a, x, y) * s >= 0) return u;
    }
    return -1;
  };
  const relink = (n: number, was: number, now: number) => {
    if (n < 0) return;
    if (adj[n] === was) adj[n] = now;
    else if (adj[n + 1] === was) adj[n + 1] = now;
    else if (adj[n + 2] === was) adj[n + 2] = now;
  };

  let start = 0;
  for (let k = 0; k < inserted.length; k += 2) {
    const x = inserted[k], y = inserted[k + 1];
    const target = locate(start, x, y);
    // a lattice point can miss every triangle where the inset outline has folded
    // over itself at a narrow tip; dropping it is right, it has nowhere to go
    if (target < 0) continue;
    const id = points.length / 2;
    points.push(x, y);
    const a = faces[target], b = faces[target + 1], c = faces[target + 2];
    const n1 = adj[target + 1], n2 = adj[target + 2];
    const t2 = faces.length, t3 = faces.length + 3;
    faces[target + 2] = id;
    faces.push(b, c, id, c, a, id);
    adj.push(n1, t3, target, n2, target, t2);
    adj[target + 1] = t2;
    adj[target + 2] = t3;
    relink(n1, target, t2);
    relink(n2, target, t3);
    start = target;
  }

  // --- flip toward Delaunay, relax the interior, repeat ---
  // the loops' own edges have no neighbour across them, which is what keeps
  // the flips off the boundary: the cap must still match the bevel exactly
  for (let pass = 0; pass < 4; pass++) {
    flipToDelaunay(points, faces, adj);
    relaxInterior(points, faces, boundaryVertices);
  }
  flipToDelaunay(points, faces, adj);

  return { points, tris: faces };
}

interface FlatLoop { x: Float64Array; y: Float64Array; minX: number; minY: number; maxX: number; maxY: number }

function flatLoop(loop: Vec2[]): FlatLoop {
  const x = new Float64Array(loop.length), y = new Float64Array(loop.length);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  loop.forEach(([lx, ly], i) => {
    x[i] = lx; y[i] = ly;
    if (lx < minX) minX = lx; if (lx > maxX) maxX = lx;
    if (ly < minY) minY = ly; if (ly > maxY) maxY = ly;
  });
  return { x, y, minX, minY, maxX, maxY };
}

function insideFlat(x: number, y: number, L: FlatLoop): boolean {
  let hit = false;
  const n = L.x.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = L.x[i], yi = L.y[i], xj = L.x[j], yj = L.y[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function distance2Flat(x: number, y: number, L: FlatLoop): number {
  let best = Infinity;
  const n = L.x.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = L.x[j], ay = L.y[j];
    const dx = L.x[i] - ax, dy = L.y[i] - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = x - (ax + dx * t), ey = y - (ay + dy * t);
    const d2 = ex * ex + ey * ey;
    if (d2 < best) best = d2;
  }
  return best;
}

/**
 * Flip every interior edge whose opposite vertex falls inside the other
 * triangle's circumcircle. Delaunay maximises the smallest angle, which is
 * exactly the property a sliver lacks. Works on the triangle adjacency, three
 * neighbours per triangle, and keeps it right through every flip.
 */
function flipToDelaunay(points: number[], faces: number[], adj: number[]) {
  const px = (i: number) => points[i * 2];
  const py = (i: number) => points[i * 2 + 1];
  const area2 = (a: number, b: number, c: number) =>
    (px(b) - px(a)) * (py(c) - py(a)) - (px(c) - px(a)) * (py(b) - py(a));

  const inCircle = (a: number, b: number, c: number, d: number) => {
    const ax = px(a) - px(d), ay = py(a) - py(d);
    const bx = px(b) - px(d), by = py(b) - py(d);
    const cx = px(c) - px(d), cy = py(c) - py(d);
    return (
      (ax * ax + ay * ay) * (bx * cy - by * cx) -
      (bx * bx + by * by) * (ax * cy - ay * cx) +
      (cx * cx + cy * cy) * (ax * by - ay * bx)
    );
  };
  const slotOf = (n: number, t: number) => (adj[n] === t ? 0 : adj[n + 1] === t ? 1 : 2);

  const dirty = new Uint8Array(faces.length / 3);
  for (let sweep = 0; sweep < 12; sweep++) {
    let flips = 0;
    dirty.fill(0);
    for (let t1 = 0; t1 < faces.length; t1 += 3) {
      if (dirty[t1 / 3]) continue;
      for (let i1 = 0; i1 < 3; i1++) {
        const t2 = adj[t1 + i1];
        // each interior edge once, from its lower triangle; a boundary edge has no t2
        if (t2 < t1 || dirty[t2 / 3]) continue;
        const i2 = slotOf(t2, t1);
        // t1 carries the edge u -> v, so t2 carries v -> u
        const u = faces[t1 + i1], v = faces[t1 + ((i1 + 1) % 3)], p = faces[t1 + ((i1 + 2) % 3)];
        const q = faces[t2 + ((i2 + 2) % 3)];

        // both halves of the flipped quad must stay wound the right way round
        if (area2(u, q, p) <= 1e-12 || area2(q, v, p) <= 1e-12) continue;
        if (inCircle(u, v, p, q) <= 0) continue;

        const A = adj[t1 + ((i1 + 1) % 3)], B = adj[t1 + ((i1 + 2) % 3)];
        const C = adj[t2 + ((i2 + 1) % 3)], D = adj[t2 + ((i2 + 2) % 3)];
        faces[t1] = u; faces[t1 + 1] = q; faces[t1 + 2] = p;
        adj[t1] = C; adj[t1 + 1] = t2; adj[t1 + 2] = B;
        faces[t2] = q; faces[t2 + 1] = v; faces[t2 + 2] = p;
        adj[t2] = D; adj[t2 + 1] = A; adj[t2 + 2] = t1;
        if (C >= 0) adj[C + slotOf(C, t2)] = t1;
        if (A >= 0) adj[A + slotOf(A, t1)] = t2;
        dirty[t1 / 3] = 1; dirty[t2 / 3] = 1;
        flips++;
        break;
      }
    }
    if (!flips) break;
  }
}

/**
 * Move each interior vertex to the average of its neighbours, but only when
 * every triangle it belongs to survives the move. Flipping fixes which points
 * are joined; this fixes where they are, and the two together are what turn a
 * lattice dropped into a fan triangulation into an even mesh.
 */
function relaxInterior(points: number[], faces: number[], boundaryVertices: number) {
  const count = points.length / 2;
  // neighbour sums and counts, with a triangle list per vertex; no sets
  const degree = new Int32Array(count);
  const incidentCount = new Int32Array(count);
  for (let t = 0; t < faces.length; t++) incidentCount[faces[t]]++;
  const incidentStart = new Int32Array(count + 1);
  for (let v = 0; v < count; v++) incidentStart[v + 1] = incidentStart[v] + incidentCount[v];
  const incident = new Int32Array(faces.length);
  const fill = new Int32Array(count);
  for (let t = 0; t < faces.length; t += 3) {
    for (let i = 0; i < 3; i++) {
      const a = faces[t + i];
      incident[incidentStart[a] + fill[a]++] = t;
    }
  }

  const px = (i: number) => points[i * 2];
  const py = (i: number) => points[i * 2 + 1];
  const area2 = (a: number, b: number, c: number) =>
    (px(b) - px(a)) * (py(c) - py(a)) - (px(c) - px(a)) * (py(b) - py(a));

  for (let v = boundaryVertices; v < count; v++) {
    const s0 = incidentStart[v], s1 = incidentStart[v + 1];
    if (s0 === s1) continue;
    // every triangle round an interior vertex contributes the vertex across
    // from it once: the neighbour after v in that triangle's winding
    let sx = 0, sy = 0;
    degree[v] = 0;
    for (let k = s0; k < s1; k++) {
      const t = incident[k];
      const n = faces[t] === v ? faces[t + 1] : faces[t + 1] === v ? faces[t + 2] : faces[t];
      sx += px(n); sy += py(n); degree[v]++;
    }
    const ox = px(v), oy = py(v);
    points[v * 2] = sx / degree[v];
    points[v * 2 + 1] = sy / degree[v];
    for (let k = s0; k < s1; k++) {
      const t = incident[k];
      if (area2(faces[t], faces[t + 1], faces[t + 2]) > 1e-12) continue;
      points[v * 2] = ox; points[v * 2 + 1] = oy;
      break;
    }
  }
}

/** A sloped ring-to-ring band; `dir` is +1 for the upper bevel, -1 for the lower. */
/**
 * The edge break, as a quarter-round rather than a chamfer.
 *
 * A single 45° facet reads as machined: one flat glint, then nothing. A rounded
 * edge carries a highlight that slides as the piece turns, which is what a filed
 * and polished edge does, and the curvature-driven wear sees a smooth convex
 * band rather than two creases. Three steps are enough at these sizes; a
 * draft takes two.
 */
function band(
  mb: MeshBuilder,
  cap: Vec2[], wallLoop: Vec2[],
  hz: number, inner: number,
  outward: Vec2[],
  perimeter: number[],
  dir: number,
  steps = Math.max(1, Math.round(3 * detail())),
  zMid = 0,
) {
  const n = cap.length;
  const base = mb.vertexCount;
  for (let k = 0; k <= steps; k++) {
    const theta = (k / steps) * (Math.PI / 2);
    const s = Math.sin(theta), c = Math.cos(theta);
    const z = zMid + dir * (inner + (hz - inner) * c);
    for (let i = 0; i < n; i++) {
      const [ox, oy] = outward[i];
      const x = cap[i][0] + (wallLoop[i][0] - cap[i][0]) * s;
      const y = cap[i][1] + (wallLoop[i][1] - cap[i][1]) * s;
      mb.vertex(x, y, z, ox * s, oy * s, dir * c, perimeter[i], k / steps);
    }
  }
  for (let k = 0; k < steps; k++) {
    const r0 = base + k * n, r1 = base + (k + 1) * n;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (dir > 0) mb.quad(r0 + i, r1 + i, r1 + j, r0 + j);
      else mb.quad(r0 + i, r0 + j, r1 + j, r1 + i);
    }
  }
}

function wall(mb: MeshBuilder, loop: Vec2[], topZ: number, botZ: number, outward: Vec2[], perimeter: number[]) {
  const n = loop.length;
  const base = mb.vertexCount;
  for (let i = 0; i < n; i++) {
    const [ox, oy] = outward[i];
    mb.vertex(loop[i][0], loop[i][1], topZ, ox, oy, 0, perimeter[i], 1);
  }
  for (let i = 0; i < n; i++) {
    const [ox, oy] = outward[i];
    mb.vertex(loop[i][0], loop[i][1], botZ, ox, oy, 0, perimeter[i], 0);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    mb.quad(base + i, base + n + i, base + n + j, base + j);
  }
}

/** Outward normal per vertex, averaged from the two adjacent edges. */
function outwardNormals(loop: Vec2[]): Vec2[] {
  const n = loop.length;
  return loop.map((_, i) => {
    const p = loop[(i - 1 + n) % n];
    const c = loop[i];
    const q = loop[(i + 1) % n];
    const e1: Vec2 = [c[0] - p[0], c[1] - p[1]];
    const e2: Vec2 = [q[0] - c[0], q[1] - c[1]];
    const l1 = Math.hypot(e1[0], e1[1]) || 1;
    const l2 = Math.hypot(e2[0], e2[1]) || 1;
    const nx = e1[1] / l1 + e2[1] / l2;
    const ny = -e1[0] / l1 - e2[0] / l2;
    const l = Math.hypot(nx, ny) || 1;
    return [nx / l, ny / l];
  });
}

/**
 * Move every vertex inward along its bisector. Uses the loop's own winding, so a
 * clockwise hole insets outward — which is what a bevel round a piercing does.
 */
function insetLoop(loop: Vec2[], dist: number): Vec2[] {
  const outward = outwardNormals(loop);
  return loop.map(([x, y], i) => [x - outward[i][0] * dist, y - outward[i][1] * dist] as Vec2);
}

function perimeterParam(loop: Vec2[]): number[] {
  const out = [0];
  let total = 0;
  for (let i = 1; i < loop.length; i++) {
    total += Math.hypot(loop[i][0] - loop[i - 1][0], loop[i][1] - loop[i - 1][1]);
    out.push(total);
  }
  return total > 0 ? out.map((d) => d / total) : out;
}

/**
 * The box the cap's uv is measured against: u = (x - minX) / width and
 * v = (y - minY) / height, so anything that knows this box can turn a cap
 * uv back into the flat plate's coordinates.
 */
export function outlineSpan(loop: Vec2[]) { return boundsOf(loop); }

function boundsOf(loop: Vec2[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of loop) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return { minX, minY, width: maxX - minX || 1, height: maxY - minY || 1 };
}
