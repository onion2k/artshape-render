import type { Vec3 } from './types';
import { cross, dot, normalize } from './vec';

/** Column-major 4x4, laid out to hand straight to WebGL and to ogl. */
export type Mat4 = Float32Array;

export const identity = (): Mat4 =>
  new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Build a transform from an origin and an orthonormal basis. */
export function fromBasis(origin: Vec3, x: Vec3, y: Vec3, z: Vec3, scale = 1): Mat4 {
  return new Float32Array([
    x[0] * scale, x[1] * scale, x[2] * scale, 0,
    y[0] * scale, y[1] * scale, y[2] * scale, 0,
    z[0] * scale, z[1] * scale, z[2] * scale, 0,
    origin[0], origin[1], origin[2], 1,
  ]);
}

export function translation(t: Vec3): Mat4 {
  const m = identity();
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2];
  return m;
}

export function rotationAbout(axis: Vec3, angle: number): Mat4 {
  const [x, y, z] = normalize(axis);
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return new Float32Array([
    t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ]);
}

export function uniformScale(s: number): Mat4 {
  const m = identity();
  m[0] = s; m[5] = s; m[10] = s;
  return m;
}

/** Reflection through the plane with the given unit normal, through the origin. */
export function reflection(n: Vec3): Mat4 {
  const [x, y, z] = normalize(n);
  return new Float32Array([
    1 - 2 * x * x, -2 * x * y, -2 * x * z, 0,
    -2 * x * y, 1 - 2 * y * y, -2 * y * z, 0,
    -2 * x * z, -2 * y * z, 1 - 2 * z * z, 0,
    0, 0, 0, 1,
  ]);
}

/** a * b — b applies first. */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/** Rotate (and scale) a direction, ignoring translation. */
export function transformDirection(m: Mat4, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
  ];
}

/** Negative for reflections. Symmetry groups with mirrors produce these. */
export function determinant3(m: Mat4): number {
  return (
    m[0] * (m[5] * m[10] - m[9] * m[6]) -
    m[4] * (m[1] * m[10] - m[9] * m[2]) +
    m[8] * (m[1] * m[6] - m[5] * m[2])
  );
}

/**
 * A right-handed frame with `x` as the first axis, using `hint` to resolve the
 * remaining spin. Parts are authored growing along +X, so this is what places them.
 */
export function frameAlong(origin: Vec3, x: Vec3, hint: Vec3 = [0, 0, 1], scale = 1): Mat4 {
  const xa = normalize(x);
  let z = [hint[0] - xa[0] * dot(hint, xa), hint[1] - xa[1] * dot(hint, xa), hint[2] - xa[2] * dot(hint, xa)] as Vec3;
  if (Math.hypot(z[0], z[1], z[2]) < 1e-6) z = normalize(cross(xa, [1, 0, 0]));
  z = normalize(z);
  return fromBasis(origin, xa, cross(z, xa), z, scale);
}

/** General 4x4 inverse, for carrying a ray into a placed part's own space. */
export function invert(m: Mat4): Mat4 | null {
  const a = m;
  const b00 = a[0] * a[5] - a[1] * a[4], b01 = a[0] * a[6] - a[2] * a[4];
  const b02 = a[0] * a[7] - a[3] * a[4], b03 = a[1] * a[6] - a[2] * a[5];
  const b04 = a[1] * a[7] - a[3] * a[5], b05 = a[2] * a[7] - a[3] * a[6];
  const b06 = a[8] * a[13] - a[9] * a[12], b07 = a[8] * a[14] - a[10] * a[12];
  const b08 = a[8] * a[15] - a[11] * a[12], b09 = a[9] * a[14] - a[10] * a[13];
  const b10 = a[9] * a[15] - a[11] * a[13], b11 = a[10] * a[15] - a[11] * a[14];
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1 / det;
  const out = new Float32Array(16);
  out[0] = (a[5] * b11 - a[6] * b10 + a[7] * b09) * det;
  out[1] = (a[2] * b10 - a[1] * b11 - a[3] * b09) * det;
  out[2] = (a[13] * b05 - a[14] * b04 + a[15] * b03) * det;
  out[3] = (a[10] * b04 - a[9] * b05 - a[11] * b03) * det;
  out[4] = (a[6] * b08 - a[4] * b11 - a[7] * b07) * det;
  out[5] = (a[0] * b11 - a[2] * b08 + a[3] * b07) * det;
  out[6] = (a[14] * b02 - a[12] * b05 - a[15] * b01) * det;
  out[7] = (a[8] * b05 - a[10] * b02 + a[11] * b01) * det;
  out[8] = (a[4] * b10 - a[5] * b08 + a[7] * b06) * det;
  out[9] = (a[1] * b08 - a[0] * b10 - a[3] * b06) * det;
  out[10] = (a[12] * b04 - a[13] * b02 + a[15] * b00) * det;
  out[11] = (a[9] * b02 - a[8] * b04 - a[11] * b00) * det;
  out[12] = (a[5] * b07 - a[4] * b09 - a[6] * b06) * det;
  out[13] = (a[0] * b09 - a[1] * b07 + a[2] * b06) * det;
  out[14] = (a[13] * b01 - a[12] * b03 - a[14] * b00) * det;
  out[15] = (a[8] * b03 - a[9] * b01 + a[10] * b00) * det;
  return out;
}
