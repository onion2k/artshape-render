/**
 * The solids a toy's faceted scenery is cut from: a place, a flat face, a
 * frustum, a lump, a prism, a block, a slab, a rod, a dome, a disc, a ring
 * and the wall of a hole, each written face by face into a builder so that
 * every face is flat-shaded and shares no vertex with its neighbour. A
 * face's normal is worked out from where its points end up, so a solid
 * turned or moved is still lit right. Without these every game that wants a
 * low-poly tree, a cabin or a jetty would write its own cone and its own
 * box, and one of them would wind a face inside out. The trees, bushes and
 * boulders made of them are in `parts/lowpoly.ts`.
 *
 * Z is up, as the renderer has it, and chance is handed in: `seeded` is the
 * one tiny generator, so a seed gives the same mesh every time.
 */
import { MeshBuilder, type Mesh } from './types';
import type { Vec3 } from '../geom/types';

/** Where a solid's points go: a turn, a move, an even scale. Never a mirror, which would turn its faces inside out. */
export type Place = (p: Vec3) => Vec3;

/** A number in [0, 1) from a seed: a small linear congruential generator, the same everywhere. */
export function seeded(seed: number): () => number {
  let s = (seed * 2654435761 + 1) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Turned `yaw` about Z, then moved to (x, y, z). */
export function at(x: number, y: number, z: number, yaw = 0): Place {
  const c = Math.cos(yaw),
    s = Math.sin(yaw);
  return ([px, py, pz]) => [x + c * px - s * py, y + s * px + c * py, z + pz];
}

/** A mesh from what a builder was given. */
export function built(build: (b: MeshBuilder) => void): Mesh {
  const b = new MeshBuilder();
  build(b);
  return b.build();
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The unit normal of the triangle p0 p1 p2, wound counter-clockwise seen from the normal. */
function normalOf(p0: Vec3, p1: Vec3, p2: Vec3): Vec3 {
  const n = cross(sub(p1, p0), sub(p2, p0));
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}

/** One flat-shaded quad, wound counter-clockwise seen from the normal. */
export function face(b: MeshBuilder, p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3) {
  const [nx, ny, nz] = normalOf(p0, p1, p3);
  const a = b.vertex(p0[0], p0[1], p0[2], nx, ny, nz, 0, 0);
  b.vertex(p1[0], p1[1], p1[2], nx, ny, nz, 1, 0);
  b.vertex(p2[0], p2[1], p2[2], nx, ny, nz, 1, 1);
  b.vertex(p3[0], p3[1], p3[2], nx, ny, nz, 0, 1);
  b.quad(a, a + 1, a + 2, a + 3);
}

/** One flat-shaded triangle, wound counter-clockwise seen from the normal. */
export function tri(b: MeshBuilder, p0: Vec3, p1: Vec3, p2: Vec3) {
  const [nx, ny, nz] = normalOf(p0, p1, p2);
  const a = b.vertex(p0[0], p0[1], p0[2], nx, ny, nz, 0, 0);
  b.vertex(p1[0], p1[1], p1[2], nx, ny, nz, 1, 0);
  b.vertex(p2[0], p2[1], p2[2], nx, ny, nz, 0.5, 1);
  b.triangle(a, a + 1, a + 2);
}

/** A flat triangle or quad, wound so that it faces away from `inside`: for a convex solid, whose middle is inside every face. */
export function faceOut(b: MeshBuilder, pts: Vec3[], inside: Vec3) {
  const n = cross(sub(pts[1], pts[0]), sub(pts[2], pts[0]));
  const centre: Vec3 = [0, 0, 0];
  for (const p of pts) for (let a = 0; a < 3; a++) centre[a] += p[a] / pts.length;
  const q = dot(n, sub(centre, inside)) < 0 ? [...pts].reverse() : pts;
  if (q.length === 3) tri(b, q[0], q[1], q[2]);
  else face(b, q[0], q[1], q[2], q[3]);
}

/** The i-th of n points round a circle of radius r at height z, from `phase`. */
export function round(i: number, n: number, r: number, z: number, phase = 0): Vec3 {
  const a = phase + (i / n) * Math.PI * 2;
  return [Math.cos(a) * r, Math.sin(a) * r, z];
}

/**
 * A frustum of `n` sides from radius `r0` at `z0` to `r1` at `z1`: a
 * cylinder when they are equal, a cone when `r1` is nought. Its points are
 * on the circles, so it is never wider than its radius. The top is capped
 * unless it comes to a point or is told not to be; the bottom only if told,
 * since most things stand on the ground and it is never seen.
 */
export function frustum(
  b: MeshBuilder,
  place: Place,
  n: number,
  r0: number,
  r1: number,
  z0: number,
  z1: number,
  { top = true, bottom = false, phase = 0 } = {},
) {
  const p = (i: number, r: number, z: number) => place(round(i, n, r, z, phase));
  for (let i = 0; i < n; i++) {
    if (r1 <= 0) tri(b, p(i, r0, z0), p(i + 1, r0, z0), place([0, 0, z1]));
    else if (r0 <= 0) tri(b, place([0, 0, z0]), p(i + 1, r1, z1), p(i, r1, z1));
    else face(b, p(i, r0, z0), p(i + 1, r0, z0), p(i + 1, r1, z1), p(i, r1, z1));
  }
  if (top && r1 > 0) for (let i = 1; i < n - 1; i++) tri(b, p(0, r1, z1), p(i, r1, z1), p(i + 1, r1, z1));
  if (bottom && r0 > 0) for (let i = 1; i < n - 1; i++) tri(b, p(0, r0, z0), p(i + 1, r0, z0), p(i, r0, z0));
}

/**
 * A lump: a ball of `rings` and `segments` with every point pushed in by up
 * to `give` of its radius, from `random`, and its axes stretched to `rx`,
 * `ry` and `rz`. Its top stays where it is, so it is exactly `rz` tall above
 * its middle; nothing goes below `floor` of its middle, which flattens it
 * where it sits.
 */
export function lump(
  b: MeshBuilder,
  place: Place,
  random: () => number,
  rings: number,
  segments: number,
  [rx, ry, rz]: Vec3,
  { give = 0.22, floor = -Infinity } = {},
) {
  const push: number[] = [];
  for (let i = 0; i <= rings; i++)
    for (let j = 0; j < segments; j++) push.push(i === 0 ? 1 : i === rings ? 1 - give / 2 : 1 - random() * give);
  const p = (i: number, j: number): Vec3 => {
    const jj = ((j % segments) + segments) % segments;
    const k = push[i * segments + (i === 0 || i === rings ? 0 : jj)];
    const phi = (i / rings) * Math.PI,
      th = ((jj + (i % 2) * 0.5) / segments) * Math.PI * 2;
    return place([
      Math.sin(phi) * Math.cos(th) * rx * k,
      Math.sin(phi) * Math.sin(th) * ry * k,
      Math.max(floor, Math.cos(phi) * rz * k),
    ]);
  };
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < segments; j++) {
      if (i === 0) tri(b, p(0, 0), p(1, j), p(1, j + 1));
      else if (i === rings - 1) tri(b, p(rings, 0), p(i, j + 1), p(i, j));
      else {
        // an odd ring is half a step round from an even one, so the quad between them is split along its short way
        tri(b, p(i, j), p(i + 1, j), p(i + 1, j + 1));
        tri(b, p(i, j), p(i + 1, j + 1), p(i, j + 1));
      }
    }
}


/** The wall of a tube of `n` sides facing in, from `z0` up to `z1`: the inside of a hole. */
export function tubeIn(b: MeshBuilder, place: Place, n: number, r: number, z0: number, z1: number, phase = 0) {
  const p = (i: number, z: number) => place(round(i, n, r, z, phase));
  for (let i = 0; i < n; i++) face(b, p(i + 1, z0), p(i, z0), p(i, z1), p(i + 1, z1));
}

/** A flat ring facing up at height `z`, from radius `rIn` out to `rOut`. */
export function annulus(b: MeshBuilder, place: Place, n: number, rIn: number, rOut: number, z: number, phase = 0) {
  const p = (i: number, r: number) => place(round(i, n, r, z, phase));
  for (let i = 0; i < n; i++) face(b, p(i, rIn), p(i, rOut), p(i + 1, rOut), p(i + 1, rIn));
}

/** A flat disc of `n` sides facing up at height `z`, fanned from one of its points. */
export function disc(b: MeshBuilder, place: Place, n: number, r: number, z: number, phase = 0) {
  const p = (i: number) => place(round(i, n, r, z, phase));
  for (let i = 1; i < n - 1; i++) tri(b, p(0), p(i), p(i + 1));
}

/**
 * A convex outline, given anticlockwise as seen from above, stood up from
 * `z0` to `z1`. Capped on top, and underneath only if told.
 */
export function prism(
  b: MeshBuilder,
  place: Place,
  outline: readonly [number, number][],
  z0: number,
  z1: number,
  { top = true, bottom = false } = {},
) {
  const n = outline.length;
  const p = (i: number, z: number): Vec3 => place([outline[i % n][0], outline[i % n][1], z]);
  for (let i = 0; i < n; i++) face(b, p(i, z0), p(i + 1, z0), p(i + 1, z1), p(i, z1));
  if (top) for (let i = 1; i < n - 1; i++) tri(b, p(0, z1), p(i, z1), p(i + 1, z1));
  if (bottom) for (let i = 1; i < n - 1; i++) tri(b, p(0, z0), p(i + 1, z0), p(i, z0));
}

/** A box from (x0, y0, z0) to (x1, y1, z1), closed underneath only if told. */
export function block(
  b: MeshBuilder,
  place: Place,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  bottom = false,
) {
  prism(
    b,
    place,
    [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
    z0,
    z1,
    { bottom },
  );
}

/** A dome: the top half of a ball of `rings` rings to the equator, standing on z = 0. */
export function dome(b: MeshBuilder, place: Place, r: number, rings: number, segments: number) {
  const p = (i: number, j: number): Vec3 => {
    const phi = (i / rings) * (Math.PI / 2),
      th = (j / segments) * Math.PI * 2;
    return place([Math.sin(phi) * Math.cos(th) * r, Math.sin(phi) * Math.sin(th) * r, Math.cos(phi) * r]);
  };
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < segments; j++) {
      if (i === 0) tri(b, p(0, 0), p(1, j), p(1, j + 1));
      else face(b, p(i, j), p(i + 1, j), p(i + 1, j + 1), p(i, j + 1));
    }
}

/**
 * A slab: a convex outline in the XZ plane, given anticlockwise as seen from
 * -Y, made `t` thick along Y about y = 0. For a flag, a pennant or a picket.
 */
export function slab(b: MeshBuilder, place: Place, outline: readonly [number, number][], t: number) {
  const n = outline.length;
  const p = (i: number, y: number): Vec3 => place([outline[i % n][0], y, outline[i % n][1]]);
  const f = -t / 2,
    k = t / 2;
  for (let i = 1; i < n - 1; i++) {
    tri(b, p(0, f), p(i, f), p(i + 1, f));
    tri(b, p(0, k), p(i + 1, k), p(i, k));
  }
  for (let i = 0; i < n; i++) face(b, p(i, f), p(i, k), p(i + 1, k), p(i + 1, f));
}

/**
 * A rod of `n` sides and radius `r` from one point to another, at any slant:
 * for a string, a strut, a post or a stem. Open at its ends unless told
 * otherwise.
 */
export function rod(b: MeshBuilder, from: Vec3, to: Vec3, r: number, n: number, caps = false) {
  const d = sub(to, from);
  const len = Math.hypot(d[0], d[1], d[2]);
  const along: Vec3 = [d[0] / len, d[1] / len, d[2] / len];
  // across it level with the ground where it can be, and the third way so the three turn as X, Y and Z do
  let u = cross(along, [0, 0, 1]);
  if (Math.hypot(u[0], u[1], u[2]) < 1e-6) u = [1, 0, 0];
  const k = Math.hypot(u[0], u[1], u[2]);
  u = [u[0] / k, u[1] / k, u[2] / k];
  const v = cross(along, u);
  const place: Place = ([x, y, z]) => [
    from[0] + x * u[0] + y * v[0] + z * along[0],
    from[1] + x * u[1] + y * v[1] + z * along[1],
    from[2] + x * u[2] + y * v[2] + z * along[2],
  ];
  frustum(b, place, n, r, r, 0, len, { top: caps, bottom: caps });
}
