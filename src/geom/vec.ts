import type { Vec3 } from './types';

export const v3 = (x: number, y: number, z: number): Vec3 => [x, y, z];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const normalize = (a: Vec3): Vec3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Any unit vector perpendicular to `a`, chosen to stay well-conditioned. */
export const perpendicular = (a: Vec3): Vec3 => {
  const ref: Vec3 = Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  return normalize(cross(a, ref));
};

/** Orthonormal frame with `z` as the third axis. */
export function frameFrom(z: Vec3, hint?: Vec3): { x: Vec3; y: Vec3; z: Vec3 } {
  const zn = normalize(z);
  let x = hint ? sub(hint, mul(zn, dot(hint, zn))) : perpendicular(zn);
  if (len(x) < 1e-6) x = perpendicular(zn);
  x = normalize(x);
  return { x, y: cross(zn, x), z: zn };
}
