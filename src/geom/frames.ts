import type { Vec3 } from './types';
import { cross, dot, normalize, perpendicular, sub } from './vec';

export interface Frame {
  position: Vec3;
  tangent: Vec3;
  /** The two axes the profile is laid out in. */
  normal: Vec3;
  binormal: Vec3;
}

/**
 * Rotation-minimising frames along a polyline, by the double-reflection method.
 *
 * The obvious alternative — a Frenet frame from the curve's own second derivative —
 * flips violently through inflection points and is undefined on straight runs, which
 * for a whiplash curve means the swept profile spins on the spot. This carries one
 * frame along the curve instead, introducing no twist beyond what the path forces.
 */
export function frames(points: Vec3[], closed = false, seed?: Vec3): Frame[] {
  const n = points.length;
  const tangents: Vec3[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(i - 1, 0)];
    const b = points[Math.min(i + 1, n - 1)];
    tangents[i] = normalize(sub(b, a));
  }
  if (closed) {
    const t = normalize(sub(points[1], points[n - 2]));
    tangents[0] = t;
    tangents[n - 1] = t;
  }

  const out: Frame[] = new Array(n);
  let u = seed ? normalize(sub(seed, [0, 0, 0])) : perpendicular(tangents[0]);
  // make the seed strictly perpendicular to the first tangent
  u = normalize(sub(u, tangents[0].map((c) => c * dot(u, tangents[0])) as Vec3));
  if (!Number.isFinite(u[0]) || Math.hypot(u[0], u[1], u[2]) < 1e-6) u = perpendicular(tangents[0]);

  out[0] = { position: points[0], tangent: tangents[0], normal: u, binormal: cross(tangents[0], u) };

  for (let i = 0; i < n - 1; i++) {
    const prev = out[i];
    const v1 = sub(points[i + 1], points[i]);
    const c1 = dot(v1, v1);
    let r: Vec3;
    let tL: Vec3;
    if (c1 < 1e-18) {
      r = prev.normal;
      tL = prev.tangent;
    } else {
      const k1 = (2 / c1) * dot(v1, prev.normal);
      r = [prev.normal[0] - k1 * v1[0], prev.normal[1] - k1 * v1[1], prev.normal[2] - k1 * v1[2]];
      const k2 = (2 / c1) * dot(v1, prev.tangent);
      tL = [prev.tangent[0] - k2 * v1[0], prev.tangent[1] - k2 * v1[1], prev.tangent[2] - k2 * v1[2]];
    }
    const v2 = sub(tangents[i + 1], tL);
    const c2 = dot(v2, v2);
    let next: Vec3 = r;
    if (c2 > 1e-18) {
      const k3 = (2 / c2) * dot(v2, r);
      next = [r[0] - k3 * v2[0], r[1] - k3 * v2[1], r[2] - k3 * v2[2]];
    }
    next = normalize(next);
    out[i + 1] = {
      position: points[i + 1],
      tangent: tangents[i + 1],
      normal: next,
      binormal: cross(tangents[i + 1], next),
    };
  }

  if (closed) closeSeam(out);
  return out;
}

/**
 * A transported frame does not generally come back to itself around a loop. Spread
 * the mismatch evenly rather than dumping it at the seam, where it would show as a
 * visible kink in the surface parameterisation.
 */
function closeSeam(fr: Frame[]) {
  const n = fr.length;
  const first = fr[0];
  const last = fr[n - 1];
  const cosA = Math.min(Math.max(dot(first.normal, last.normal), -1), 1);
  let angle = Math.acos(cosA);
  if (dot(cross(last.normal, first.normal), last.tangent) < 0) angle = -angle;

  for (let i = 0; i < n; i++) {
    const a = (angle * i) / (n - 1);
    const c = Math.cos(a), s = Math.sin(a);
    const f = fr[i];
    const nx: Vec3 = [
      f.normal[0] * c + f.binormal[0] * s,
      f.normal[1] * c + f.binormal[1] * s,
      f.normal[2] * c + f.binormal[2] * s,
    ];
    f.normal = normalize(nx);
    f.binormal = cross(f.tangent, f.normal);
  }
}
