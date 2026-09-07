import { scaledCount } from '../mesh/detail';
import * as profile from '../geom/profile';
import { sweep } from '../mesh/sweep';
import { meshBounds, type Anchor, type Part } from './types';
import type { Vec3 } from '../geom/types';

export interface ShankSpec {
  name?: string;
  /** Inner diameter — this is what "ring size" means here. */
  size: number;
  /** Band width, front to back along the finger, at the back of the shank. */
  width: number;
  /** Band thickness, radially. */
  thickness: number;
  /**
   * How much wider the shank swells toward the crown, as a fraction of
   * width. 0 is a plain wedding band; a stone wants somewhere to sit.
   */
  shoulder?: number;
  /** Angular reach of the shoulder swell either side of the crown, in radians. */
  shoulderSpread?: number;
  /**
   * A gap left at the crown, in radians — the two cut ends of a tension
   * setting, gripping a stone directly rather than through a claw or a
   * bezel. 0 is a closed band.
   */
  gap?: number;
  segments?: number;
}

/**
 * A ring shank: a band sized to a finger, with a crown anchor to fasten a
 * setting onto — or, with a gap, to seat a stone gripped directly between
 * the two cut ends.
 *
 * `size` is the inner diameter, the thing a ring's own size actually means —
 * everything else (width, thickness, the shoulder) is built outward from it,
 * the way a shank is cut from stock rather than drawn from a centreline.
 * Without a gap the crown sits at the seam the closed sweep starts and ends
 * on, angle zero, so a shoulder swell has to straddle both ends of the taper
 * table rather than just the start of it. With a gap the sweep runs open
 * instead, from one side of the crown round to the other, and the same
 * straddling shoulder now falls exactly at its two cut ends — which is where
 * a tension setting wants its own swell anyway, since that is where the
 * spring of the metal actually does the gripping.
 */
export function shank(spec: ShankSpec): Part {
  const segments = scaledCount(spec.segments ?? 96);
  const shoulder = spec.shoulder ?? 0;
  const spread = Math.max(spec.shoulderSpread ?? 0.9, 1e-3);
  const gap = Math.max(spec.gap ?? 0, 0);
  const closed = gap < 1e-6;
  const radius = spec.size / 2 + spec.thickness / 2;

  const from = gap / 2;
  const span = Math.PI * 2 - gap;
  const rows = closed ? segments : segments + 1;
  const path: Vec3[] = [];
  for (let i = 0; i < rows; i++) {
    const a = from + (i / segments) * span;
    path.push([Math.cos(a) * radius, Math.sin(a) * radius, 0]);
  }
  if (closed) path.push(path[0]);

  // distance from the nearest end of the taper table: the seam both ends
  // meet at when closed, or either cut jaw when open — a tension setting's
  // own ends are exactly where the swell belongs, so the same formula serves
  const bump = (t: number) => {
    const d = Math.min(t, 1 - t);
    return Math.exp(-(d * d) / (spread * spread));
  };

  const mesh = sweep(path, {
    profile: profile.ribbon(spec.width, spec.thickness, 4),
    taper: shoulder ? (t) => 1 + shoulder * bump(t) : undefined,
    closed,
    caps: !closed,
    // seeds the frame so width lies along the ring's own axis, the same
    // construction band() uses to stand a ribbon on edge
    up: [0, 0, 1],
  });

  const anchors: Anchor[] = [
    // the crown sits here whether or not there is metal under it: closed, it
    // is the seam; gapped, it is the empty space a tension-set stone occupies
    { name: 'crown', position: [radius, 0, 0], axis: [1, 0, 0], tangent: [0, 0, 1] },
  ];

  return { name: spec.name ?? 'shank', mesh, bounds: meshBounds(mesh), anchors };
}
