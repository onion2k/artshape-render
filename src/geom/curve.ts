import type { Vec3 } from './types';
import { add, mul, normalize, sub } from './vec';

/** A parametric space curve on [0, 1]. Wire paths are authored as these. */
export interface Curve {
  at(t: number): Vec3;
}

export const line = (a: Vec3, b: Vec3): Curve => ({
  at: (t) => add(a, mul(sub(b, a), t)),
});

/** Circular arc in the XY plane, swept from `from` to `to` radians. */
export const arc = (radius: number, from: number, to: number, z = 0): Curve => ({
  at: (t) => {
    const a = from + (to - from) * t;
    return [Math.cos(a) * radius, Math.sin(a) * radius, z];
  },
});

/** Ellipse in the XY plane, its own full turn — an oval jump ring or a stretched loop. */
export const ellipse = (rx: number, ry: number, z = 0): Curve => ({
  at: (t) => {
    const a = t * Math.PI * 2;
    return [Math.cos(a) * rx, Math.sin(a) * ry, z];
  },
});

export const helix = (radius: number, height: number, turns: number): Curve => ({
  at: (t) => {
    const a = t * turns * Math.PI * 2;
    return [Math.cos(a) * radius, Math.sin(a) * radius, (t - 0.5) * height];
  },
});

export const bezier3 = (p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3): Curve => ({
  at: (t) => {
    const u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    return [
      a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
      a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
      a * p0[2] + b * p1[2] + c * p2[2] + d * p3[2],
    ];
  },
});

/**
 * An arc that starts at `a`, ends at `b` and bulges by `sag` perpendicular to the
 * chord. The most useful authoring form for a strut spanning two anchors.
 */
export const bow = (a: Vec3, b: Vec3, sag: number, upHint: Vec3 = [0, 0, 1]): Curve => {
  const mid = mul(add(a, b), 0.5);
  const chord = sub(b, a);
  const n = normalize([
    chord[1] * upHint[2] - chord[2] * upHint[1],
    chord[2] * upHint[0] - chord[0] * upHint[2],
    chord[0] * upHint[1] - chord[1] * upHint[0],
  ]);
  const apex = add(mid, mul(n, sag));
  // quadratic through a, apex, b, expressed as a cubic
  const c1 = add(a, mul(sub(apex, a), 2 / 3));
  const c2 = add(b, mul(sub(apex, b), 2 / 3));
  return bezier3(a, c1, c2, b);
};

/** Sample a curve into a polyline of `segments + 1` points. */
export function samplePath(curve: Curve, segments: number): Vec3[] {
  const pts: Vec3[] = new Array(segments + 1);
  for (let i = 0; i <= segments; i++) pts[i] = curve.at(i / segments);
  return pts;
}

export function pathTangent(pts: Vec3[], index: number): Vec3 {
  const i = Math.min(Math.max(index, 0), pts.length - 1);
  const a = pts[Math.max(i - 1, 0)];
  const b = pts[Math.min(i + 1, pts.length - 1)];
  return normalize(sub(b, a));
}

/**
 * Catmull-Rom through the given points. The natural authoring form for a drawn
 * line: you place the points the curve actually passes through, rather than
 * control points it merely leans towards.
 */
export const catmullRom = (points: Vec3[], tension = 0.5): Curve => {
  const n = points.length;
  if (n < 2) throw new Error('catmullRom needs at least two points');
  return {
    at: (t) => {
      const s = Math.min(Math.max(t, 0), 1) * (n - 1);
      const i = Math.min(Math.floor(s), n - 2);
      const f = s - i;
      const p0 = points[Math.max(i - 1, 0)];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[Math.min(i + 2, n - 1)];
      const out: Vec3 = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        const m1 = tension * (p2[k] - p0[k]);
        const m2 = tension * (p3[k] - p1[k]);
        const f2 = f * f, f3 = f2 * f;
        out[k] =
          (2 * f3 - 3 * f2 + 1) * p1[k] +
          (f3 - 2 * f2 + f) * m1 +
          (-2 * f3 + 3 * f2) * p2[k] +
          (f3 - f2) * m2;
      }
      return out;
    },
  };
};

/**
 * Logarithmic spiral — the whiplash line art nouveau is built on. `growth` is the
 * radius multiplier per full turn, so 2.4 means each turn is a bit over twice the
 * last, which is the range that reads as a natural scroll rather than a coil.
 */
export const logSpiral = (
  startRadius: number,
  turns: number,
  growth = 2.4,
  rise = 0,
): Curve => {
  const b = Math.log(growth) / (Math.PI * 2);
  return {
    at: (t) => {
      const a = t * turns * Math.PI * 2;
      const r = startRadius * Math.exp(b * a);
      return [Math.cos(a) * r, Math.sin(a) * r, t * rise];
    },
  };
};

/** Uniform arc-length resampling, so sections and tapers space evenly along a curve. */
export function resample(curve: Curve, count: number, oversample = 16): Vec3[] {
  const dense = Math.max(count * oversample, 64);
  const pts: Vec3[] = new Array(dense + 1);
  const cum = new Float64Array(dense + 1);
  for (let i = 0; i <= dense; i++) pts[i] = curve.at(i / dense);
  for (let i = 1; i <= dense; i++) {
    const a = pts[i - 1], b = pts[i];
    cum[i] = cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  const total = cum[dense];

  const out: Vec3[] = new Array(count);
  let j = 0;
  for (let i = 0; i < count; i++) {
    const target = (i / (count - 1)) * total;
    while (j < dense && cum[j + 1] < target) j++;
    const span = cum[j + 1] - cum[j];
    const f = span > 1e-12 ? (target - cum[j]) / span : 0;
    const a = pts[j], b = pts[Math.min(j + 1, dense)];
    out[i] = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }
  return out;
}

export function curveLength(curve: Curve, samples = 512): number {
  let total = 0;
  let prev = curve.at(0);
  for (let i = 1; i <= samples; i++) {
    const p = curve.at(i / samples);
    total += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
    prev = p;
  }
  return total;
}

/*
 * Mathematical curves.
 *
 * These are the figures a plotter or a harmonograph draws: closed, exact, and
 * unlike anything grown. Each is a Curve like the rest, so a wire follows it,
 * a blade twists along it, and `along` scatters parts down it. All lie in the
 * XY plane unless given a height, which lifts them into a third harmonic.
 */

/**
 * Lissajous figure: x and y oscillate at frequencies `a` and `b`, offset by
 * `phase`. Whole-number frequencies close the figure; a phase of a quarter
 * turn with a = b is a circle, and with a = 1, b = 2 a figure of eight.
 */
export const lissajous = (
  width: number, height: number, a: number, b: number, phase = Math.PI / 2, rise = 0,
): Curve => ({
  at: (t) => {
    const s = t * Math.PI * 2;
    return [Math.sin(a * s + phase) * width, Math.sin(b * s) * height, (t - 0.5) * rise];
  },
});

/**
 * Rose curve, r = cos(k theta). With `petals` odd the figure has that many
 * petals over a half turn; even, twice as many over a full turn. Sampled
 * over a full turn either way, so an odd rose traces itself twice — which
 * `resample` handles, since it spaces by arc length.
 */
export const rose = (radius: number, petals: number, rise = 0): Curve => {
  const k = petals;
  // an odd rose closes at pi, an even one at 2pi; a fractional one is left
  // to run a full turn and stay open
  const closesAt = Number.isInteger(k) ? (k % 2 === 1 ? Math.PI : Math.PI * 2) : Math.PI * 2;
  return {
    at: (t) => {
      const a = t * closesAt;
      const r = Math.cos(k * a) * radius;
      return [Math.cos(a) * r, Math.sin(a) * r, (t - 0.5) * rise];
    },
  };
};

/** A sine wave along +X: `length` long, `waves` cycles of `amplitude`, rising `rise`. */
export const sine = (length: number, amplitude: number, waves: number, rise = 0): Curve => ({
  at: (t) => [
    (t - 0.5) * length,
    Math.sin(t * waves * Math.PI * 2) * amplitude,
    (t - 0.5) * rise,
  ],
});

/**
 * Torus knot (p, q): winds `p` times round the torus's axis while passing
 * `q` times through its hole. (2, 3) is the trefoil. `radius` is the torus's
 * major radius and `tube` how far the curve strays from that ring.
 */
export const torusKnot = (radius: number, tube: number, p: number, q: number): Curve => ({
  at: (t) => {
    const a = t * Math.PI * 2;
    const r = radius + tube * Math.cos(q * a);
    return [Math.cos(p * a) * r, Math.sin(p * a) * r, tube * Math.sin(q * a)];
  },
});

/**
 * Superellipse, |x/rx|^n + |y/ry|^n = 1. n = 2 is an ellipse; higher rounds a
 * rectangle's corners ever more tightly, and Piet Hein's 2.5 is the shape a
 * deco frame is cut to. Below 2 it pinches toward a star.
 */
export const superellipse = (rx: number, ry: number, n = 2.5, z = 0): Curve => {
  const e = 2 / n;
  const sgnPow = (v: number) => Math.sign(v) * Math.pow(Math.abs(v), e);
  return {
    at: (t) => {
      const a = t * Math.PI * 2;
      return [sgnPow(Math.cos(a)) * rx, sgnPow(Math.sin(a)) * ry, z];
    },
  };
};
