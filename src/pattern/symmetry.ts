import type { Vec3 } from '../geom/types';
import {
  frameAlong, fromBasis, identity, multiply, reflection, rotationAbout, translation,
  uniformScale, type Mat4,
} from '../geom/transform';
import { cross, dot, normalize, perpendicular, sub } from '../geom/vec';
import type { Curve } from '../geom/curve';

/**
 * A symmetry is just a list of placements.
 *
 * Keeping it that dumb is what makes it compose: a nested mandala is a ring of
 * rings, a mirrored rosette is a ring times a reflection, and every one of them
 * still comes out as a flat array the renderer can instance in a single draw.
 *
 * Convention: each transform's +X is the outward or growth direction and +Z is
 * the face normal, matching how parts are authored — leaves and wires run along
 * +X from their own origin — so a part drops into any of these without fixing up.
 */
export type Symmetry = Mat4[];

/** n copies rotated about Z. Each one's +X points radially outward. */
export function radial(count: number, phase = 0): Symmetry {
  const out: Symmetry = [];
  for (let i = 0; i < count; i++) {
    out.push(rotationAbout([0, 0, 1], phase + (i / count) * Math.PI * 2));
  }
  return out;
}

export interface RingOptions {
  phase?: number;
  /** Lift the whole ring along Z. */
  z?: number;
  /**
   * Tip each copy out of the plane, in radians, about the local tangential axis.
   *
   * Positive tilts the growth direction *down*, toward -Z — a drooping tepal, a
   * reflexed bract. Negative stands it up. Worth stating because it is the
   * opposite of what most people write first, and getting it backwards gives a
   * flower whose petals splay outward instead of forming a cup.
   */
  tilt?: number;
  scale?: number;
}

/** n copies on a circle of the given radius, each facing outward. */
export function ring(count: number, radius: number, opts: RingOptions = {}): Symmetry {
  const { phase = 0, z = 0, tilt = 0, scale = 1 } = opts;
  const out: Symmetry = [];
  for (let i = 0; i < count; i++) {
    const a = phase + (i / count) * Math.PI * 2;
    const spin = rotationAbout([0, 0, 1], a);
    const outward: Vec3 = [Math.cos(a), Math.sin(a), 0];
    const place = translation([outward[0] * radius, outward[1] * radius, z]);
    // tilt about the local tangential axis, so copies lift out of the plane together
    const tangent: Vec3 = [-Math.sin(a), Math.cos(a), 0];
    const lift = tilt ? rotationAbout(tangent, tilt) : identity();
    out.push(multiply(multiply(place, lift), multiply(spin, uniformScale(scale))));
  }
  return out;
}

/**
 * The dihedral group: n rotations plus their mirror images. The mirrored copies
 * have a negative determinant, which reverses their triangle winding — harmless
 * while backface culling is off, because shading uses the transformed vertex
 * normal rather than one derived from the winding.
 */
export function dihedral(count: number, mirrorNormal: Vec3 = [0, 1, 0]): Symmetry {
  const rot = radial(count);
  const mir = reflection(mirrorNormal);
  return [...rot, ...rot.map((m) => multiply(m, mir))];
}

export function mirror(normal: Vec3 = [0, 1, 0]): Symmetry {
  return [identity(), reflection(normal)];
}

/** A rising, turning stack — spiral staircases, twisted columns, stems. */
export function helical(
  count: number,
  radius: number,
  rise: number,
  turns = 1,
  opts: { tilt?: number; taper?: number } = {},
): Symmetry {
  const { tilt = 0, taper = 1 } = opts;
  const out: Symmetry = [];
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0;
    const a = t * turns * Math.PI * 2;
    const s = 1 + (taper - 1) * t;
    out.push(
      ...ring(1, radius * s, { phase: a, z: (t - 0.5) * rise, tilt, scale: s }),
    );
  }
  return out;
}

/**
 * Golden-angle spiral. The arrangement a sunflower head uses, and the reason a
 * scattered form still reads as ordered rather than random.
 */
export function phyllotaxis(
  count: number,
  spacing: number,
  opts: {
    rise?: number;
    /** Constant, or a function of the normalised index — a flower's inner petals
     *  stand up and its outer ones lie flat, which a single number cannot say. */
    tilt?: number | ((t: number) => number);
    taper?: number;
    startIndex?: number;
  } = {},
): Symmetry {
  const { rise = 0, tilt = 0, taper = 1, startIndex = 0 } = opts;
  const tiltAt = typeof tilt === 'function' ? tilt : () => tilt;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const out: Symmetry = [];
  for (let i = 0; i < count; i++) {
    const k = i + startIndex;
    const t = count > 1 ? i / (count - 1) : 0;
    const r = spacing * Math.sqrt(k);
    const a = k * golden;
    const s = 1 + (taper - 1) * t;
    out.push(...ring(1, r, { phase: a, z: rise * t, tilt: tiltAt(t), scale: s }));
  }
  return out;
}

export interface ShellOptions {
  /**
   * 'outward' points each copy straight out, which spikes — right for spines.
   * 'flat' lays it along the surface with its face outward, giving overlapping
   * scales or petals, and reads as a single body rather than a hedgehog.
   *
   * Named to avoid colliding with the symmetry called radial: a bare word in a
   * sketch is a value, and it should never be ambiguous whether it means one.
   */
  orient?: 'outward' | 'flat';
  /** Lift the far end off the surface, in radians. Gives scales their overlap. */
  lean?: number;
  turns?: number;
}

/**
 * Near-even points on a sphere about Z.
 *
 * A true icosahedral group gives only 60 placements at fixed positions; the
 * golden-angle spiral gives any count with almost the same evenness, which
 * matters more when the thing being placed is a leaf than a face of a solid.
 */
export function sphereShell(count: number, radius: number, opts: ShellOptions = {}): Symmetry {
  const { orient = 'outward', lean = 0, turns = 1 } = opts;
  const golden = Math.PI * (3 - Math.sqrt(5)) * turns;
  const out: Symmetry = [];

  for (let i = 0; i < count; i++) {
    const z = count > 1 ? 1 - (i / (count - 1)) * 2 : 0;
    const r = Math.sqrt(Math.max(1 - z * z, 0));
    const a = i * golden;
    const n = normalize([Math.cos(a) * r, Math.sin(a) * r, z]);
    const origin: Vec3 = [n[0] * radius, n[1] * radius, n[2] * radius];

    if (orient === 'outward') {
      out.push(frameAlong(origin, n, [0, 0, 1]));
      continue;
    }

    // growth direction runs up the sphere toward the pole; face normal points out
    let up: Vec3 = [0, 0, 1];
    let x = sub(up, [n[0] * dot(up, n), n[1] * dot(up, n), n[2] * dot(up, n)]);
    if (Math.hypot(x[0], x[1], x[2]) < 1e-6) {
      up = [1, 0, 0];
      x = sub(up, [n[0] * dot(up, n), n[1] * dot(up, n), n[2] * dot(up, n)]);
    }
    x = normalize(x);
    const y = cross(n, x);
    const base = fromBasis(origin, x, y, n);
    out.push(lean ? multiply(base, rotationAbout([0, 1, 0], -lean)) : base);
  }
  return out;
}

export interface AlongOptions {
  /** Parameter range of the curve to occupy. */
  from?: number;
  to?: number;
  /** Scale at the far end. Leaflets shrink toward a frond's tip. */
  taper?: number;
  /** Rotation about the local face normal, constant or a function of position. */
  tilt?: number | ((t: number) => number);
  /** Put successive copies on opposite sides, as most stems arrange their leaves. */
  alternate?: boolean;
  /** Plane the arrangement lies in. */
  up?: Vec3;
}

/**
 * Copies distributed along a curve, each facing outward from it.
 *
 * The arrangement every stem uses and none of the others can express: leaflets
 * up a fern's rachis, florets up a spike, leaves up a vine. Radial and spiral
 * symmetries all place things around a point, but a plant mostly places them
 * along a line, and that line is usually itself a curve.
 */
export function along(curve: Curve, count: number, opts: AlongOptions = {}): Symmetry {
  const { from = 0, to = 1, taper = 1, tilt = 0, alternate = false, up = [0, 0, 1] } = opts;
  const tiltAt = typeof tilt === 'function' ? tilt : () => tilt;

  const out: Symmetry = [];
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0.5;
    const u = from + (to - from) * t;

    const origin = curve.at(u);
    const step = Math.max((to - from) * 1e-3, 1e-4);
    const ahead = curve.at(Math.min(u + step, 1));
    const behind = curve.at(Math.max(u - step, 0));
    const tangent = normalize(sub(ahead, behind));

    // face normal is the arrangement plane, growth direction lies across the stem
    let z = sub(up, [tangent[0] * dot(up, tangent), tangent[1] * dot(up, tangent), tangent[2] * dot(up, tangent)]);
    if (Math.hypot(z[0], z[1], z[2]) < 1e-6) z = perpendicular(tangent);
    z = normalize(z);
    let x = normalize(cross(tangent, z));

    // A mirrored copy would reverse the winding, so alternate by turning the
    // frame about the face normal rather than negating an axis. Recomputing y
    // from the flipped x keeps the basis right-handed.
    if (alternate && i % 2 === 1) x = [-x[0], -x[1], -x[2]];
    const y = cross(z, x);

    const scale = 1 + (taper - 1) * t;
    const base = fromBasis(origin, x, y, z, scale);
    const lean = tiltAt(t);
    out.push(lean ? multiply(base, rotationAbout([0, 0, 1], lean)) : base);
  }
  return out;
}

/** Every combination of two symmetries — a ring of rings. */
export function compose(outer: Symmetry, inner: Symmetry): Symmetry {
  const out: Symmetry = [];
  for (const a of outer) for (const b of inner) out.push(multiply(a, b));
  return out;
}

/** Nested copies at shrinking scale, for concentric mandala courses. */
export function nested(count: number, factor: number, spin = 0): Symmetry {
  const out: Symmetry = [];
  for (let i = 0; i < count; i++) {
    out.push(multiply(rotationAbout([0, 0, 1], spin * i), uniformScale(Math.pow(factor, i))));
  }
  return out;
}

export interface SprayOptions {
  /** How far the outermost copy leans away from the axis, in radians. */
  lean?: number;
  /** Height of the dome the heads sit on. */
  rise?: number;
  /** Scale of the outermost copy. */
  taper?: number;
  /** Turn each copy about its own axis as well, so no two present the same face. */
  spin?: number;
}

/**
 * A hand-tied bunch: copies gathered at one point, fanning out and doming over.
 *
 * The odd one out in this file, and deliberately so. Every other symmetry orients
 * its copies by the convention that +X is the growth direction, because it places
 * parts — a leaf, a strut, a scale. This one places whole flowers, and a flower
 * stands up: it is built along +Z with its stem running down. So `spray` leans
 * +Z outward rather than +X, which is the only thing that makes
 * `repeat rose around spray(9, ...)` do what anyone would expect.
 *
 * The lean grows with the radius rather than being constant, which is what a
 * bunch does when it is gripped in one hand: the middle stands straight and the
 * outside falls away. The golden angle keeps the faces from lining up in rows.
 */
export function spray(count: number, radius: number, opts: SprayOptions = {}): Symmetry {
  const { lean = 0.5, rise = 0, taper = 1, spin = 0 } = opts;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const out: Symmetry = [];
  const maxK = Math.sqrt(Math.max(count - 1, 1));

  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0;
    const k = Math.sqrt(i) / maxK;                // 0 at the centre, 1 at the rim
    const a = i * golden;
    const r = radius * k;

    const place = translation([Math.cos(a) * r, Math.sin(a) * r, rise * (1 - k * k)]);
    // lean about the tangential axis, which tips the copy outward rather than
    // spinning it — the same construction ring() uses for tilt
    const tangential: Vec3 = [-Math.sin(a), Math.cos(a), 0];
    const fall = rotationAbout(tangential, lean * k);
    const turn = spin ? rotationAbout([0, 0, 1], spin * i) : identity();
    const s = 1 + (taper - 1) * t;
    out.push(multiply(multiply(place, fall), multiply(turn, uniformScale(s))));
  }
  return out;
}

/** A number, or a well of numbers drawn from afresh each time. */
export type Measure = number | (() => number);
const draw = (m: Measure) => (typeof m === 'function' ? m() : m);

export interface BranchingOptions {
  /** Roll about the parent's axis added each level, so successive forks turn; a quarter turn makes a flat fork three-dimensional. */
  twist?: Measure;
  /** Only the last level: where the buds and leaves go. */
  tipsOnly?: boolean;
  /** Roll of the first fork at the root. */
  phase?: number;
}

/**
 * Branching: a twig at the tip of each twig.
 *
 * The root is the identity. Each level places `count` children at the tip of
 * every twig of the level before — `length` along the parent's +X, in the
 * parent's own frame, so a shrunk twig's children sit at its shorter tip —
 * tilted away from the parent by `spread`, rolled round it evenly, and scaled
 * by `shrink`. A fork of two with no twist is a flat spray, a fern or a coral
 * fan; a twist of a quarter turn per level fills space, a tree.
 *
 * Total placements are 1 + count + count² + … so depth is small by nature.
 */
export function branching(
  depth: number,
  count: number,
  length: Measure,
  spread: Measure,
  shrink: Measure,
  opts: BranchingOptions = {},
): Symmetry {
  const { twist = 0, tipsOnly = false, phase = 0 } = opts;
  const levels = Math.max(0, Math.floor(depth));
  const n = Math.max(1, Math.floor(count));
  let current: Symmetry = [identity()];
  const out: Symmetry = tipsOnly && levels > 0 ? [] : [...current];
  for (let level = 1; level <= levels; level++) {
    const next: Symmetry = [];
    for (const parent of current) {
      // the length is the parent's: one twig, one tip, so it is drawn once per
      // parent. The rest is each child's own draw — with a plain number that
      // is the number, with an rnd() it is that child's
      const tip = draw(length);
      for (let k = 0; k < n; k++) {
        const roll = phase + draw(twist) * (level - 1) + (k / n) * Math.PI * 2;
        // tilt away from the parent's axis, then roll round it, then step to the tip
        const child = multiply(
          parent,
          multiply(
            translation([tip, 0, 0]),
            multiply(rotationAbout([1, 0, 0], roll), multiply(rotationAbout([0, 0, 1], draw(spread)), uniformScale(draw(shrink)))),
          ),
        );
        next.push(child);
      }
    }
    if (!tipsOnly || level === levels) out.push(...next);
    current = next;
  }
  return out;
}

/**
 * Play added to a symmetry: each copy turned about its own face normal,
 * tilted off it, shifted along each of its axes and scaled, by amounts
 * drawn for that copy alone within the limits given. Seeded, so the same
 * sketch shakes the same way every time.
 */
export function jitterSymmetry(
  sym: Symmetry,
  amounts: { turn?: number; tilt?: number; shift?: number; scale?: number },
  seed: number,
): Symmetry {
  const { turn = 0, tilt = 0, shift = 0, scale = 0 } = amounts;
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
  return sym.map((m) => {
    const play = multiply(
      translation([next() * shift, next() * shift, next() * shift]),
      multiply(
        rotationAbout([0, 0, 1], next() * turn),
        multiply(rotationAbout([0, 1, 0], next() * tilt), uniformScale(1 + next() * scale)),
      ),
    );
    return multiply(m, play);
  });
}
