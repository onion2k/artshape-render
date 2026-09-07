/**
 * A parametric surface, thickened into a shell.
 *
 * The fourth way to make a mesh, beside extrude, sweep and revolve: any
 * function of (u, v) over the unit square becomes a sheet, and the sheet is
 * given thickness by offsetting along its own normal, with the two sheets
 * joined at their rims. That covers saddles, ripples, helicoids, Möbius
 * bands, seashells and bezier patches — the mathematical solids of the
 * roadmap — without a generator each.
 *
 * A surface closed in a direction (a tube, a band) has no rim there: the
 * function is asked to meet itself, and the sampled seam rows coincide. A
 * Möbius band closes on itself with a flip — its top sheet at u = 1 is its
 * bottom sheet at u = 0 — and that too is just the function meeting itself,
 * so it needs nothing from here beyond leaving the rim off.
 */
import type { Vec3 } from '../geom/types';
import { add, cross, mul, normalize, sub } from '../geom/vec';
import { MeshBuilder, type Mesh } from './types';

export type SurfaceFn = (u: number, v: number) => Vec3;

export interface SurfaceOptions {
  /** Sheet thickness, split either side of the surface. */
  thickness: number;
  segmentsU?: number;
  segmentsV?: number;
  /** The function meets itself at u = 0 and u = 1: no rim there. */
  closedU?: boolean;
  closedV?: boolean;
  /** Enamel the top sheet. */
  enamelTop?: boolean;
}

export function surface(f: SurfaceFn, opts: SurfaceOptions): Mesh {
  const nu = Math.max(1, Math.floor(opts.segmentsU ?? 48));
  const nv = Math.max(1, Math.floor(opts.segmentsV ?? 24));
  const half = opts.thickness / 2;
  const h = 1e-4;

  // sample the sheet: position, normal, and the two tangents for the rims
  const rows = nu + 1, cols = nv + 1;
  const P: Vec3[] = new Array(rows * cols);
  const N: Vec3[] = new Array(rows * cols);
  const Tu: Vec3[] = new Array(rows * cols);
  const Tv: Vec3[] = new Array(rows * cols);
  for (let i = 0; i < rows; i++) {
    const u = i / nu;
    for (let j = 0; j < cols; j++) {
      const v = j / nv;
      const k = i * cols + j;
      P[k] = f(u, v);
      // central differences, pulled inside the square at its edges
      const u0 = Math.max(u - h, 0), u1 = Math.min(u + h, 1);
      const v0 = Math.max(v - h, 0), v1 = Math.min(v + h, 1);
      const du = mul(sub(f(u1, v), f(u0, v)), 1 / (u1 - u0));
      const dv = mul(sub(f(u, v1), f(u, v0)), 1 / (v1 - v0));
      Tu[k] = normalize(du);
      Tv[k] = normalize(dv);
      N[k] = normalize(cross(du, dv));
    }
  }

  // engraving coordinates in millimetres: arc length along the middle row and column
  const lengthU = polylineLength(Array.from({ length: rows }, (_, i) => P[i * cols + Math.floor(nv / 2)]));
  const lengthV = polylineLength(Array.from({ length: cols }, (_, j) => P[Math.floor(nu / 2) * cols + j]));

  const mb = new MeshBuilder();
  const engrave: number[] = [];
  const sheet = (sign: number) => {
    const base = mb.vertexCount;
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const k = i * cols + j;
        const p = add(P[k], mul(N[k], sign * half));
        const n = mul(N[k], sign);
        mb.vertex(p[0], p[1], p[2], n[0], n[1], n[2], i / nu, j / nv);
        engrave.push((i / nu) * lengthU, (j / nv) * lengthV);
      }
    }
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        const a = base + i * cols + j, b = a + cols, c = b + 1, d = a + 1;
        if (sign > 0) mb.quad(a, b, c, d);
        else mb.quad(a, d, c, b);
      }
    }
    return base;
  };
  const topBase = sheet(1);
  const topEnd = mb.vertexCount;
  sheet(-1);

  // rims: a strip between the two sheets along each open edge, facing out
  const rim = (indices: number[], outward: Vec3[], along: number[]) => {
    const base = mb.vertexCount;
    for (let s = 0; s < indices.length; s++) {
      const k = indices[s];
      const o = outward[s];
      const top = add(P[k], mul(N[k], half));
      const bot = sub(P[k], mul(N[k], half));
      mb.vertex(top[0], top[1], top[2], o[0], o[1], o[2], along[s], 1);
      mb.vertex(bot[0], bot[1], bot[2], o[0], o[1], o[2], along[s], 0);
      engrave.push(along[s] * lengthU, 0, along[s] * lengthU, 0);
    }
    for (let s = 0; s < indices.length - 1; s++) {
      const a = base + s * 2;
      mb.quad(a, a + 2, a + 3, a + 1);
    }
  };
  if (!opts.closedV) {
    const along = Array.from({ length: rows }, (_, i) => i / nu);
    const at = (j: number) => Array.from({ length: rows }, (_, i) => i * cols + j);
    // v = 0 edge faces -Tv; the strip is wound so its face looks that way
    rim(at(0).reverse(), at(0).reverse().map((k) => mul(Tv[k], -1)), along.slice().reverse());
    rim(at(nv), at(nv).map((k) => Tv[k]), along);
  }
  if (!opts.closedU) {
    const along = Array.from({ length: cols }, (_, j) => j / nv);
    const at = (i: number) => Array.from({ length: cols }, (_, j) => i * cols + j);
    rim(at(0), at(0).map((k) => mul(Tu[k], -1)), along);
    rim(at(nu).reverse(), at(nu).reverse().map((k) => Tu[k]), along.slice().reverse());
  }

  const mesh = mb.build();
  mesh.engrave = new Float32Array(engrave);
  if (opts.enamelTop) {
    mesh.enamel = new Float32Array(mesh.positions.length / 3);
    mesh.enamel.fill(1, topBase, topEnd);
  }
  return mesh;
}

function polylineLength(pts: Vec3[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return total;
}

/*
 * The surfaces themselves, as functions over the unit square, each centred
 * on the origin with its face toward +Z where that means anything.
 */

/** A hyperbolic paraboloid: `width` along X, `depth` along Y, rising `rise` at the X ends and falling at the Y ends. */
export const saddle = (width: number, depth: number, rise: number): SurfaceFn => (u, v) => {
  const x = (u - 0.5) * width, y = (v - 0.5) * depth;
  return [x, y, rise * ((2 * (u - 0.5)) ** 2 - (2 * (v - 0.5)) ** 2)];
};

/** A sheet rippled by a standing wave: `waves` cycles across each way, `amplitude` high. */
export const ripple = (width: number, depth: number, amplitude: number, waves: number): SurfaceFn => (u, v) => {
  const x = (u - 0.5) * width, y = (v - 0.5) * depth;
  return [x, y, amplitude * Math.sin(u * waves * Math.PI * 2) * Math.sin(v * waves * Math.PI * 2)];
};

/** A helicoid: a blade of width `radius` spiralling up `height` through `turns`, about Z. */
export const helicoid = (radius: number, height: number, turns: number): SurfaceFn => (u, v) => {
  const a = u * turns * Math.PI * 2;
  const r = (v - 0.5) * 2 * radius;
  return [Math.cos(a) * r, Math.sin(a) * r, (u - 0.5) * height];
};

/** A Möbius band of `radius` and `width`, one half-twist round Z; closed in u with a flip. */
export const mobius = (radius: number, width: number, twists = 1): SurfaceFn => (u, v) => {
  const a = u * Math.PI * 2;
  const t = a * twists / 2;
  const w = (v - 0.5) * width;
  const r = radius + w * Math.cos(t);
  return [Math.cos(a) * r, Math.sin(a) * r, w * Math.sin(t)];
};

/**
 * A seashell: a tube of growing radius wound on a growing helix. `turns`
 * round the axis, the radius multiplying by `growth` each turn, the tube
 * `tube` wide at the mouth, rising `height`. Closed in v.
 */
export const shell = (radius: number, tube: number, turns: number, growth: number, height: number): SurfaceFn => (u, v) => {
  const a = u * turns * Math.PI * 2;
  const s = Math.pow(growth, a / (Math.PI * 2)) / Math.pow(growth, turns);   // 0..1 exponential growth
  const b = v * Math.PI * 2;
  const rr = radius * s;
  const tt = tube * s;
  const x = (rr + tt * Math.cos(b)) * Math.cos(a);
  const y = (rr + tt * Math.cos(b)) * Math.sin(a);
  const z = tt * Math.sin(b) + height * (s - 0.5);
  return [x, y, z];
};

/** A bicubic bezier patch over a 4 x 4 net of control points, row by row. */
export const bezierPatch = (net: Vec3[]): SurfaceFn => {
  if (net.length !== 16) throw new Error(`a bezier patch needs 16 control points, got ${net.length}`);
  const bern = (t: number): [number, number, number, number] => {
    const s = 1 - t;
    return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
  };
  return (u, v) => {
    const bu = bern(u), bv = bern(v);
    const out: Vec3 = [0, 0, 0];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const w = bu[i] * bv[j];
        const p = net[i * 4 + j];
        out[0] += p[0] * w; out[1] += p[1] * w; out[2] += p[2] * w;
      }
    }
    return out;
  };
};
