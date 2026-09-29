/**
 * Rounded edges, made in the geometry: a box rounded at every edge and
 * corner, and the corners of a profile rounded for a lathe, a sweep or an
 * extrusion to take.
 *
 * A toy's edges are moulded, and a moulded edge catches the light: a band of
 * highlight runs along it and turns as the thing turns. A box with square
 * edges has none, and reads as a prototype's, however it is shaded. The
 * renderer cannot put the round back (a shading trick that bends normals
 * near an edge was tried on the game path, and left dashes where a face was
 * a few pixels tall and streaks where two things met), so it goes into the
 * mesh, where it is exact at every distance and its outline is round too.
 */
import type { Vec2, Vec3 } from '../geom/types';
import { detail } from './detail';
import { MeshBuilder, type Mesh } from './types';
import type { Silhouette } from './revolve';

export interface RoundOptions {
  /** How many steps each quarter turn of a round is drawn in. Left out, four at the detail the meshes are made at. */
  steps?: number;
}

const quarterSteps = (steps?: number) => Math.max(1, Math.round(steps ?? Math.max(2, 4 * detail())));

/**
 * A box `size` across, centred on the origin, with every edge and corner
 * rounded to `radius`: each point of it the radius out from a box that much
 * smaller, and facing straight out from it, so the faces are flat, the edges
 * quarter cylinders and the corners eighths of a sphere, and no edge anywhere
 * is hard. The radius is held to half the thinnest side, where that side is
 * all round; nought, or less, is a plain box with square edges.
 *
 * Each face is a grid on the unrounded box's face, carried onto the rounded
 * one: its middle is the flat face, and its edges cover half of each round,
 * out to where the unrounded box's edge is, which is exactly where the next
 * face's grid starts, so the two meet with no gap and no seam in the light.
 */
export function roundedBox(size: Vec3, radius: number, opts: RoundOptions = {}): Mesh {
  const h = size.map((s) => Math.abs(s) / 2) as Vec3;
  const r = Math.min(radius, h[0], h[1], h[2]);
  if (!(r > 0)) return plainBox(h);
  const inner = h.map((x) => x - r) as Vec3;
  // half a quarter turn a face: its round out to the unrounded box's edge, at even angles
  const half = Math.max(1, Math.ceil(quarterSteps(opts.steps) / 2));
  const along = (k: number): number[] => {
    const e = inner[k];
    const out: number[] = [];
    for (let i = half; i >= 1; i--) out.push(-e - r * Math.tan(((i / half) * Math.PI) / 4));
    out.push(-e);
    // a side that is all round has no flat between its rounds
    if (e > 0) out.push(e);
    for (let i = 1; i <= half; i++) out.push(e + r * Math.tan(((i / half) * Math.PI) / 4));
    return out;
  };
  const b = new MeshBuilder();
  // each face's axis and side, and the two axes across it, turned so they wind outward
  const faces: [number, number, number, number][] = [
    [0, 1, 1, 2], [0, -1, 2, 1], [1, 1, 2, 0], [1, -1, 0, 2], [2, 1, 0, 1], [2, -1, 1, 0],
  ];
  for (const [a, side, u, v] of faces) {
    const us = along(u), vs = along(v);
    const base = b.vertexCount;
    for (let j = 0; j < vs.length; j++)
      for (let i = 0; i < us.length; i++) {
        const q = [0, 0, 0];
        q[a] = side * h[a]; q[u] = us[i]; q[v] = vs[j];
        const c = q.map((x, k) => Math.max(-inner[k], Math.min(inner[k], x)));
        const d = q.map((x, k) => x - c[k]);
        const l = Math.hypot(d[0], d[1], d[2]);
        const n = d.map((x) => x / l);
        b.vertex(c[0] + r * n[0], c[1] + r * n[1], c[2] + r * n[2], n[0], n[1], n[2], i / (us.length - 1), j / (vs.length - 1));
      }
    const row = us.length;
    for (let j = 0; j + 1 < vs.length; j++)
      for (let i = 0; i + 1 < us.length; i++) {
        const o = base + j * row + i;
        b.quad(o, o + 1, o + row + 1, o + row);
      }
  }
  return b.build();
}

/** A box with square edges: six faces of four corners each, facing out. */
function plainBox(h: Vec3): Mesh {
  const b = new MeshBuilder();
  const faces: [number, number, number, number][] = [
    [0, 1, 1, 2], [0, -1, 2, 1], [1, 1, 2, 0], [1, -1, 0, 2], [2, 1, 0, 1], [2, -1, 1, 0],
  ];
  for (const [a, side, u, v] of faces) {
    const base = b.vertexCount;
    const n = [0, 0, 0];
    n[a] = side;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = [0, 0, 0];
      p[a] = side * h[a]; p[u] = su * h[u]; p[v] = sv * h[v];
      b.vertex(p[0], p[1], p[2], n[0], n[1], n[2], (su + 1) / 2, (sv + 1) / 2);
    }
    b.quad(base, base + 1, base + 2, base + 3);
  }
  return b.build();
}

/**
 * A profile with its corners rounded to `radius`: each corner replaced by an
 * arc tangent to the sides either side of it, of `steps` a quarter turn, for
 * `revolve` to turn, a sweep to carry or an extrusion to lift. An open
 * profile keeps its two ends where they were. A corner marked sharp is kept
 * as it is and stays marked; a corner with no turn in it is left alone.
 * Where a side is too short for the radius asked, the corners either end of
 * it share it, each taking no more than half, so two rounds never overlap;
 * where they meet, the one point they share is written once.
 *
 * Every point of a round is marked smooth, so `revolve` shades it as one
 * curve and not as its facets.
 */
export function roundCorners(sil: Silhouette, radius: number, opts: RoundOptions = {}): Silhouette {
  const pts = sil.points;
  const n = pts.length;
  const closed = !!sil.closed;
  const keep = sil.sharp;
  if (!(radius > 0) || n < 3) return { ...sil, points: pts.map((p) => [p[0], p[1]] as Vec2), sharp: keep ? [...keep] : undefined };
  const steps = quarterSteps(opts.steps);
  const points: Vec2[] = [];
  const sharp: boolean[] = [];
  const put = (p: Vec2, hard: boolean) => {
    const last = points[points.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 1e-9) {
      sharp[sharp.length - 1] = sharp[sharp.length - 1] || hard;
      return;
    }
    points.push(p);
    sharp.push(hard);
  };
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const end = !closed && (i === 0 || i === n - 1);
    const prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
    const inLen = Math.hypot(p[0] - prev[0], p[1] - prev[1]), outLen = Math.hypot(next[0] - p[0], next[1] - p[1]);
    if (end || keep?.[i] || inLen < 1e-12 || outLen < 1e-12) {
      put([p[0], p[1]], !!keep?.[i]);
      continue;
    }
    const d1: Vec2 = [(p[0] - prev[0]) / inLen, (p[1] - prev[1]) / inLen];
    const d2: Vec2 = [(next[0] - p[0]) / outLen, (next[1] - p[1]) / outLen];
    const turn = d1[0] * d2[1] - d1[1] * d2[0];
    const angle = Math.atan2(Math.abs(turn), d1[0] * d2[0] + d1[1] * d2[1]);
    // no turn worth rounding: a point along a straight run
    if (angle < 1e-4) {
      put([p[0], p[1]], false);
      continue;
    }
    const tan = Math.tan(angle / 2);
    const reach = Math.min(radius * tan, inLen / 2, outLen / 2);
    const r = reach / tan;
    const a: Vec2 = [p[0] - d1[0] * reach, p[1] - d1[1] * reach];
    // the centre is off the incoming side toward the way it turns
    const side = turn > 0 ? 1 : -1;
    const c: Vec2 = [a[0] - side * d1[1] * r, a[1] + side * d1[0] * r];
    const from = Math.atan2(a[1] - c[1], a[0] - c[0]);
    const count = Math.max(1, Math.ceil((steps * angle) / (Math.PI / 2)));
    for (let k = 0; k <= count; k++) {
      const t = from + side * angle * (k / count);
      put([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)], false);
    }
  }
  // a closed profile whose last round ends where its first begins
  if (closed && points.length > 1 && Math.hypot(points[0][0] - points[points.length - 1][0], points[0][1] - points[points.length - 1][1]) < 1e-9) {
    points.pop();
    sharp.pop();
  }
  return { ...sil, points, sharp };
}
