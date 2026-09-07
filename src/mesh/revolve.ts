import type { Vec2 } from '../geom/types';
import { MeshBuilder, type Mesh } from './types';

/**
 * A silhouette to revolve about Z, as [radius, z] points.
 *
 * Traversed so that material lies to the left, which fixes the outward direction
 * as (dz, -dr) and removes all winding guesswork. For a solid of revolution that
 * means running bottom to top; for a tube, down the bore and back up the outside
 * with `closed` set, so the rims are generated too.
 */
export interface Silhouette {
  points: Vec2[];
  /** Corners that should stay hard. Defaults to all-smooth. */
  sharp?: boolean[];
  closed?: boolean;
}

export interface RevolveOptions {
  segments?: number;
  /** Sweep less than a full turn, in radians. */
  arc?: number;
  /**
   * Radius multiplier as a function of position around the axis.
   *
   * Without it a revolve can only vary along its silhouette, so flutes come out
   * as rings around the form rather than running its length — the compromise
   * `pod` was making when it called them whorls. A warp restores the missing
   * degree of freedom: longitudinal ribs on a seed pod, lobes on a bud, a
   * scalloped rim on a corolla. `v` is the fraction along the silhouette.
   */
  warp?: (angle: number, v: number, r: number, z: number) => number;
}

export function revolve(sil: Silhouette, opts: RevolveOptions = {}): Mesh {
  const segments = opts.segments ?? 32;
  // every row angle divides by segments; anything under 1 is 0/0 or an empty
  // loop rather than a shape, so fail here instead of downstream as NaN
  if (segments < 1) throw new Error(`revolve needs at least 1 segment, got ${segments}`);
  const arc = opts.arc ?? Math.PI * 2;
  const rows = segments + 1;
  const closedRing = Math.abs(arc - Math.PI * 2) < 1e-9;
  const cols = columnsOf(sil);
  const n = cols.points.length;

  const warp = opts.warp;
  const mb = new MeshBuilder();
  const at = (i: number, k: number): [number, number, number] => {
    const a = (i / segments) * arc;
    const [r, z] = cols.points[k];
    const w = warp ? warp(a, cols.v[k], r, z) : 1;
    return [Math.cos(a) * r * w, Math.sin(a) * r * w, z];
  };

  // engraving coordinates: round the form at its local radius, and up the
  // silhouette by distance, both in millimetres. Measured from the middle of
  // the arc, so where the radius changes the pattern shears half as far at
  // the seam as it would measured from one end
  const engrave: number[] = [];
  for (let i = 0; i < rows; i++) {
    const u = i / segments;
    const a = u * arc;
    const ca = Math.cos(a), sa = Math.sin(a);
    for (let k = 0; k < n; k++) {
      const [r, z] = cols.points[k];
      const [nr, nz] = cols.normals[k];
      if (!warp) {
        mb.vertex(ca * r, sa * r, z, ca * nr, sa * nr, nz, u, cols.v[k]);
        engrave.push((a - arc / 2) * r, cols.v[k] * cols.length);
        continue;
      }
      const [x, y, zz] = at(i, k);
      engrave.push((a - arc / 2) * Math.hypot(x, y), cols.v[k] * cols.length);
      const nrm = warpedNormal(at, cols, i, k, rows, n, closedRing);
      mb.vertex(
        x, y, zz,
        nrm ? nrm[0] : ca * nr, nrm ? nrm[1] : sa * nr, nrm ? nrm[2] : nz,
        u, cols.v[k],
      );
    }
  }

  for (let i = 0; i < rows - 1; i++) {
    for (let k = 0; k < n - 1; k++) {
      if (cols.skip[k]) continue;
      const a = i * n + k;
      const b = (i + 1) * n + k;
      const poleLow = cols.points[k][0] < 1e-9;
      const poleHigh = cols.points[k + 1][0] < 1e-9;
      if (poleLow && poleHigh) continue;
      // wound (u then v): the face normal is cross(dTheta, dSilhouette), which is
      // the (dz, -dr) outward direction the silhouette contract promises
      if (poleLow) mb.triangle(a, b + 1, a + 1);
      else if (poleHigh) mb.triangle(a, b, b + 1);
      else mb.quad(a, b, b + 1, a + 1);
    }
  }

  const mesh = mb.build();
  mesh.engrave = new Float32Array(engrave);
  return mesh;
}

/**
 * Normal of the warped surface, as the cross product of its two parametric
 * tangents taken by difference on the grid that is actually emitted.
 *
 * Differencing rather than differentiating is what keeps the seam invisible: the
 * column at u = 1 is a duplicate of the one at u = 0, and a numeric difference
 * that wraps gives both of them the same answer, where an analytic one derived
 * from the silhouette alone would not know the warp had tilted the surface.
 *
 * Creases survive because the difference along the silhouette is taken one-sided
 * whenever the central one would straddle a duplicated column — a hard rim stays
 * hard instead of being averaged into a roll.
 */
function warpedNormal(
  at: (i: number, k: number) => [number, number, number],
  cols: Columns,
  i: number, k: number, rows: number, n: number,
  closedRing: boolean,
): [number, number, number] | null {
  const segments = rows - 1;
  const wrap = (j: number) => (closedRing ? (j + segments) % segments : Math.min(Math.max(j, 0), rows - 1));
  const a0 = at(wrap(i - 1), k);
  const a1 = at(wrap(i + 1), k);
  const ta: [number, number, number] = [a1[0] - a0[0], a1[1] - a0[1], a1[2] - a0[2]];

  const same = (p: number, q: number) =>
    Math.abs(cols.points[p][0] - cols.points[q][0]) < 1e-12 &&
    Math.abs(cols.points[p][1] - cols.points[q][1]) < 1e-12;

  let lo = Math.max(k - 1, 0);
  let hi = Math.min(k + 1, n - 1);
  if (hi > k && same(k, hi)) hi = k;
  if (lo < k && same(k, lo)) lo = k;
  if (lo === hi) return null;
  const b0 = at(i, lo);
  const b1 = at(i, hi);
  const tk: [number, number, number] = [b1[0] - b0[0], b1[1] - b0[1], b1[2] - b0[2]];

  // wound (u then v), so the outward face normal is cross(dTheta, dSilhouette)
  const nx = ta[1] * tk[2] - ta[2] * tk[1];
  const ny = ta[2] * tk[0] - ta[0] * tk[2];
  const nz = ta[0] * tk[1] - ta[1] * tk[0];
  const l = Math.hypot(nx, ny, nz);
  if (l < 1e-12) return null;
  return [nx / l, ny / l, nz / l];
}

interface Columns {
  points: Vec2[];
  normals: Vec2[];
  v: number[];
  /** skip[k] = the band between column k and k+1 is a crease pair with no area. */
  skip: boolean[];
  /** Length of the silhouette. */
  length: number;
}

/**
 * Expand a silhouette into shading columns, duplicating hard corners so a rim
 * shades as an edge rather than a soft roll. Mirrors the way sweep profiles work.
 */
function columnsOf(sil: Silhouette): Columns {
  const src = sil.points;
  const m = src.length;
  const closed = sil.closed ?? false;
  const sharp = sil.sharp ?? src.map(() => false);

  const edgeNormal = (a: Vec2, b: Vec2): Vec2 => {
    const dr = b[0] - a[0];
    const dz = b[1] - a[1];
    const l = Math.hypot(dr, dz) || 1;
    return [dz / l, -dr / l];
  };

  let total = 0;
  const cum: number[] = [0];
  for (let k = 1; k < m; k++) {
    total += Math.hypot(src[k][0] - src[k - 1][0], src[k][1] - src[k - 1][1]);
    cum.push(total);
  }
  if (closed) total += Math.hypot(src[0][0] - src[m - 1][0], src[0][1] - src[m - 1][1]);

  const points: Vec2[] = [];
  const normals: Vec2[] = [];
  const v: number[] = [];
  const skip: boolean[] = [];

  for (let k = 0; k < m; k++) {
    const hasPrev = closed || k > 0;
    const hasNext = closed || k < m - 1;
    const nPrev = hasPrev ? edgeNormal(src[(k - 1 + m) % m], src[k]) : null;
    const nNext = hasNext ? edgeNormal(src[k], src[(k + 1) % m]) : null;
    const vv = total > 0 ? cum[k] / total : 0;

    if (sharp[k] && nPrev && nNext) {
      points.push(src[k]); normals.push(nPrev); v.push(vv); skip.push(true);
      points.push(src[k]); normals.push(nNext); v.push(vv); skip.push(false);
    } else {
      const a = nPrev ?? nNext!;
      const b = nNext ?? nPrev!;
      const mx = a[0] + b[0], my = a[1] + b[1];
      const l = Math.hypot(mx, my) || 1;
      points.push(src[k]); normals.push([mx / l, my / l]); v.push(vv); skip.push(false);
    }
  }

  if (closed) {
    // repeat the first column so v runs to 1 and the loop stitches without wrapping
    points.push(points[0]); normals.push(normals[0]); v.push(1); skip.push(false);
  }

  return { points, normals, v, skip, length: total };
}
