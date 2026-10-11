/**
 * The solids a toy's faceted scenery is cut from: a place, a flat face, a
 * frustum and a lump, each written face by face into a builder so that every
 * face is flat-shaded and shares no vertex with its neighbour. A face's
 * normal is worked out from where its points end up, so a solid turned or
 * moved is still lit right. Without these every game that wants a low-poly
 * tree would write its own cone, and one of them would wind a face inside
 * out. The trees, bushes and boulders made of them are in `parts/lowpoly.ts`.
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
function round(i: number, n: number, r: number, z: number, phase = 0): Vec3 {
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
