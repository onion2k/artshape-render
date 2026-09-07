import type { Vec2, Vec3 } from '../geom/types';
import { frames, type Frame } from '../geom/frames';
import { morphProfile, scaleProfile, type Profile } from '../geom/profile';
import { MeshBuilder, type Mesh } from './types';

export interface SweepOptions {
  /** Cross-section. Constant unless `morphTo` is given. */
  profile: Profile;
  /** Blend towards this section along the sweep — round wire into a flat blade. */
  morphTo?: Profile;
  /** Section scale along the sweep, t in [0,1]. This is where the life is. */
  taper?: (t: number) => number;
  /** Section rotation in radians along the sweep. */
  twist?: (t: number) => number;
  /** Blend factor for `morphTo`; defaults to t. */
  morph?: (t: number) => number;
  /** Close the sweep into a loop. Suppresses caps. */
  closed?: boolean;
  /** Cap the open ends with a fan. */
  caps?: boolean;
  /** Seed direction for the first frame, to control which way a flat section faces. */
  up?: Vec3;
}

/**
 * Sweep a cross-section along a path.
 *
 * This is the primitive nearly everything here is built from: wire, tendrils,
 * blades, rings, bands. Its whole value over a swept distance field is that the
 * section can change as it travels — taper, twist, morph — which is the difference
 * between a length of tube and a drawn line.
 */
export function sweep(pathIn: Vec3[], opts: SweepOptions): Mesh {
  const closed = opts.closed ?? false;

  // A full-turn curve sampled inclusively repeats its first point at the end. Left
  // in, that is a zero-length section: degenerate quads, and a second seam ring on
  // top of the first.
  let path = pathIn;
  if (closed && path.length > 2) {
    const a = path[0], b = path[path.length - 1];
    if (Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) < 1e-9) path = path.slice(0, -1);
  }

  const fr = frames(path, closed, opts.up);
  const sections = fr.length;

  const taper = opts.taper ?? (() => 1);
  const twist = opts.twist ?? (() => 0);
  const morph = opts.morph ?? ((t: number) => t);

  // Column layout is shared by every section: same point count, same creases, so
  // the whole sweep stitches as one regular grid. It has to be taken from the
  // morphed profile, whose crease set is the union of both ends — otherwise the
  // sections carry more columns than the layout expects and the surface tears.
  const layoutProfile = opts.morphTo ? morphProfile(opts.profile, opts.morphTo, 0) : opts.profile;
  const layout = columnsOf(layoutProfile);
  const cols = layout.count;

  const positions = new Float64Array(sections * cols * 3);
  const edgeDirs = new Float64Array(sections * cols * 2);
  const outward = new Float64Array(sections * cols * 2);
  const vCoord = new Float64Array(cols);
  // the perimeter of each section, so a pattern drawn round the tube keeps
  // its pitch where the tube tapers
  const perimeter = new Float64Array(sections);

  for (let s = 0; s < sections; s++) {
    const t = sections > 1 ? s / (sections - 1) : 0;
    let profile = layoutProfile;
    if (opts.morphTo) profile = morphProfile(opts.profile, opts.morphTo, morph(t));
    profile = scaleProfile(profile, taper(t));

    const cl = columnsOf(profile);
    perimeter[s] = cl.length;
    const a = twist(t);
    const ca = Math.cos(a), sa = Math.sin(a);
    const f = fr[s];

    for (let c = 0; c < cols; c++) {
      const [px, py] = cl.points[c];
      const x = px * ca - py * sa;
      const y = px * sa + py * ca;
      const o = (s * cols + c) * 3;
      positions[o] = f.position[0] + f.normal[0] * x + f.binormal[0] * y;
      positions[o + 1] = f.position[1] + f.normal[1] * x + f.binormal[1] * y;
      positions[o + 2] = f.position[2] + f.normal[2] * x + f.binormal[2] * y;

      const e = (s * cols + c) * 2;
      const [ex, ey] = cl.edges[c];
      edgeDirs[e] = ex * ca - ey * sa;
      edgeDirs[e + 1] = ex * sa + ey * ca;
      const [ox, oy] = cl.outward[c];
      outward[e] = ox * ca - oy * sa;
      outward[e + 1] = ox * sa + oy * ca;
      if (s === 0) vCoord[c] = cl.v[c];
    }
  }

  const mb = new MeshBuilder();
  const base = 0;
  const uCoord = arcLengthParam(path);
  const pathLength = pathLengthOf(path);
  // a closed path's last section steps back to its first: the way round is
  // the path's length and that closing step
  const first = path[0], end = path[path.length - 1];
  const period = pathLength + (closed ? Math.hypot(first[0] - end[0], first[1] - end[1], first[2] - end[2]) : 0);
  const engrave: number[] = [];

  for (let s = 0; s < sections; s++) {
    for (let c = 0; c < cols; c++) {
      const o = (s * cols + c) * 3;
      const n = surfaceNormal(positions, edgeDirs, outward, fr, sections, cols, s, c);
      mb.vertex(
        positions[o], positions[o + 1], positions[o + 2],
        n[0], n[1], n[2],
        uCoord[s], vCoord[c],
      );
      // v runs the wrong way for a right-handed (along, across, out) frame, and
      // lettering has to read the right way round from outside
      engrave.push(uCoord[s] * pathLength, (0.5 - vCoord[c]) * perimeter[s]);
    }
  }
  // Wound (v then u) so the face normal comes out as cross(dv, du), which is the
  // outward direction for a counter-clockwise profile swept along +tangent.
  // Crease columns sit on top of each other, so the quad between them has no area.
  for (let s2 = 0; s2 < sections - 1; s2++) {
    for (let c = 0; c < cols - 1; c++) {
      if (layout.skip[c]) continue;
      const i = base + s2 * cols + c;
      mb.quad(i, i + 1, i + cols + 1, i + cols);
    }
  }

  if (closed) {
    // The first ring again, at the far end of the way round, for the closing
    // quads to stitch to: on the ring itself the surface coordinate would run
    // back to nought across one quad, smearing a whole loop of pattern into
    // it, and lettering could never cross the seam. Same positions, same
    // normals, so nothing shows but the coordinate carrying on. u carries on
    // past 1 by the same step: the shader's tangent frame is taken from uv,
    // and a quad whose u ran from 1 to 1 would have none.
    const seam = sections * cols;
    const uSeam = pathLength > 0 ? period / pathLength : 1;
    for (let c = 0; c < cols; c++) {
      const o = c * 3;
      const n = surfaceNormal(positions, edgeDirs, outward, fr, sections, cols, 0, c);
      mb.vertex(positions[o], positions[o + 1], positions[o + 2], n[0], n[1], n[2], uSeam, vCoord[c]);
      engrave.push(period, (0.5 - vCoord[c]) * perimeter[0]);
    }
    const last = (sections - 1) * cols;
    for (let c = 0; c < cols - 1; c++) {
      if (layout.skip[c]) continue;
      mb.quad(base + last + c, base + last + c + 1, base + seam + c + 1, base + seam + c);
    }
  } else if (opts.caps ?? true) {
    capRing(mb, positions, cols, 0, fr[0], -1);
    capRing(mb, positions, cols, sections - 1, fr[sections - 1], 1);
  }

  const mesh = mb.build();
  // the caps' vertices have no place in the unrolled surface; give them the
  // end they sit on, so a pattern simply runs out there
  const engraveAll = new Float32Array(mesh.positions.length / 3 * 2);
  engraveAll.set(engrave);
  for (let i = engrave.length; i < engraveAll.length; i += 2) {
    engraveAll[i] = i < engraveAll.length / 2 + engrave.length / 2 ? 0 : pathLength;
    engraveAll[i + 1] = 0;
  }
  mesh.engrave = engraveAll;
  if (closed) mesh.engravePeriod = period;
  return mesh;
}

interface Columns {
  count: number;
  points: Vec2[];
  /** Direction of the profile edge this column shades against. */
  edges: Vec2[];
  outward: Vec2[];
  v: number[];
  /** skip[c] = the quad between column c and c+1 is a crease pair, and has no area. */
  skip: boolean[];
  /** The profile's perimeter. */
  length: number;
}

/**
 * Expand a profile into shading columns: creases get two columns at the same
 * position with different normals, and the seam is duplicated so v runs 0..1
 * without wrapping the index buffer.
 */
function columnsOf(p: Profile): Columns {
  const n = p.points.length;
  const points: Vec2[] = [];
  const edges: Vec2[] = [];
  const outward: Vec2[] = [];
  const v: number[] = [];
  const skip: boolean[] = [];

  const dir = (a: Vec2, b: Vec2): Vec2 => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  };
  // outward normal of a CCW edge
  const rightOf = (d: Vec2): Vec2 => [d[1], -d[0]];

  let perimeter = 0;
  const cumulative: number[] = [0];
  for (let i = 1; i <= n; i++) {
    const a = p.points[i - 1], b = p.points[i % n];
    perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
    cumulative.push(perimeter);
  }

  for (let i = 0; i < n; i++) {
    const prev = dir(p.points[(i - 1 + n) % n], p.points[i]);
    const next = dir(p.points[i], p.points[(i + 1) % n]);
    const nPrev = rightOf(prev);
    const nNext = rightOf(next);
    const vv = perimeter > 0 ? cumulative[i] / perimeter : 0;

    if (p.sharp[i]) {
      points.push(p.points[i]); edges.push(prev); outward.push(nPrev); v.push(vv); skip.push(true);
      points.push(p.points[i]); edges.push(next); outward.push(nNext); v.push(vv); skip.push(false);
    } else {
      const mx = nPrev[0] + nNext[0], my = nPrev[1] + nNext[1];
      const ml = Math.hypot(mx, my) || 1;
      const avg: Vec2 = [(prev[0] + next[0]) / 2, (prev[1] + next[1]) / 2];
      points.push(p.points[i]); edges.push(avg); outward.push([mx / ml, my / ml]); v.push(vv); skip.push(false);
    }
  }

  // seam duplicate: same as the first column, at v = 1
  points.push(points[0]); edges.push(edges[0]); outward.push(outward[0]); v.push(1);

  return { count: points.length, points, edges, outward, v, skip, length: perimeter };
}

function surfaceNormal(
  positions: Float64Array,
  edgeDirs: Float64Array,
  outward: Float64Array,
  fr: Frame[],
  sections: number,
  cols: number,
  s: number,
  c: number,
): Vec3 {
  // along the sweep, by central difference — this is what makes taper and twist
  // produce correct normals without deriving the surface analytically
  const sPrev = Math.max(s - 1, 0);
  const sNext = Math.min(s + 1, sections - 1);
  const a = (sPrev * cols + c) * 3;
  const b = (sNext * cols + c) * 3;
  let du: Vec3 = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
  if (Math.hypot(du[0], du[1], du[2]) < 1e-12) du = fr[s].tangent;

  // across the sweep, from this column's own profile edge, so creases stay hard
  const f = fr[s];
  const e = (s * cols + c) * 2;
  const ex = edgeDirs[e], ey = edgeDirs[e + 1];
  const dv: Vec3 = [
    f.normal[0] * ex + f.binormal[0] * ey,
    f.normal[1] * ex + f.binormal[1] * ey,
    f.normal[2] * ex + f.binormal[2] * ey,
  ];

  let nx = du[1] * dv[2] - du[2] * dv[1];
  let ny = du[2] * dv[0] - du[0] * dv[2];
  let nz = du[0] * dv[1] - du[1] * dv[0];
  const l = Math.hypot(nx, ny, nz);
  if (l < 1e-12) {
    const ox = outward[e], oy = outward[e + 1];
    return [
      f.normal[0] * ox + f.binormal[0] * oy,
      f.normal[1] * ox + f.binormal[1] * oy,
      f.normal[2] * ox + f.binormal[2] * oy,
    ];
  }
  nx /= l; ny /= l; nz /= l;

  // orient against the profile's own outward direction rather than guessing signs
  const ox = outward[e], oy = outward[e + 1];
  const wx = f.normal[0] * ox + f.binormal[0] * oy;
  const wy = f.normal[1] * ox + f.binormal[1] * oy;
  const wz = f.normal[2] * ox + f.binormal[2] * oy;
  if (nx * wx + ny * wy + nz * wz < 0) return [-nx, -ny, -nz];
  return [nx, ny, nz];
}

function capRing(
  mb: MeshBuilder,
  positions: Float64Array,
  cols: number,
  section: number,
  frame: Frame,
  sign: number,
) {
  const n: Vec3 = [frame.tangent[0] * sign, frame.tangent[1] * sign, frame.tangent[2] * sign];
  let cx = 0, cy = 0, cz = 0;
  for (let c = 0; c < cols - 1; c++) {
    const o = (section * cols + c) * 3;
    cx += positions[o]; cy += positions[o + 1]; cz += positions[o + 2];
  }
  cx /= cols - 1; cy /= cols - 1; cz /= cols - 1;

  const centre = mb.vertex(cx, cy, cz, n[0], n[1], n[2], 0.5, 0.5);
  const ring: number[] = [];
  for (let c = 0; c < cols; c++) {
    const o = (section * cols + c) * 3;
    ring.push(mb.vertex(positions[o], positions[o + 1], positions[o + 2], n[0], n[1], n[2], c / (cols - 1), 0));
  }
  for (let c = 0; c < cols - 1; c++) {
    // crease columns are coincident, so their fan wedge has no area
    const o1 = (section * cols + c) * 3;
    const o2 = (section * cols + c + 1) * 3;
    const d = Math.hypot(
      positions[o2] - positions[o1],
      positions[o2 + 1] - positions[o1 + 1],
      positions[o2 + 2] - positions[o1 + 2],
    );
    if (d < 1e-9) continue;
    if (sign > 0) mb.triangle(centre, ring[c], ring[c + 1]);
    else mb.triangle(centre, ring[c + 1], ring[c]);
  }
}

function pathLengthOf(path: Vec3[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return total;
}

function arcLengthParam(path: Vec3[]): number[] {
  const out = [0];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    out.push(total);
  }
  return total > 0 ? out.map((d) => d / total) : out;
}
