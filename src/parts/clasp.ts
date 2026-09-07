import { scaledCount } from '../mesh/detail';
import { arc, resample } from '../geom/curve';
import * as profile from '../geom/profile';
import { sweep } from '../mesh/sweep';
import { normalize, sub } from '../geom/vec';
import { meshBounds, type Anchor, type Part } from './types';

export interface ClaspSpec {
  name?: string;
  /** Wire radius the hook is drawn from. */
  radius: number;
  /** Radius of the hook's own curl. */
  hookRadius: number;
  /**
   * How far round the hook curls, in radians. Past a half turn it starts to
   * close back over the wire it left from, which is what lets it catch —
   * much past that and it closes on itself instead of leaving room for the
   * eye it hooks into.
   */
  sweep?: number;
  /** Fraction of radius left at the very tip, drawn down for the catch. */
  tip?: number;
  sections?: number;
  sides?: number;
}

/**
 * A hook clasp: a curled length of wire that catches on a plain ring at the
 * other end of whatever it closes.
 *
 * The ring it hooks into is not this part — it is a jump ring, `wire(path:
 * circle(...), closed: yes)`, the same as any other closed loop of wire. A
 * clasp is only ever the half of the closure that has to curl.
 */
export function clasp(spec: ClaspSpec): Part {
  const sections = scaledCount(spec.sections ?? 64);
  const sides = scaledCount(spec.sides ?? 12);
  const sweepAngle = spec.sweep ?? Math.PI * 2 * 0.72;
  const tip = spec.tip ?? 0.55;

  const path = resample(arc(spec.hookRadius, 0, sweepAngle), sections);

  const mesh = sweep(path, {
    profile: profile.circle(spec.radius, sides),
    // full gauge at the base, where it is soldered on; drawn down toward the
    // catch, as a hook that is thick right to its tip does not spring shut
    taper: (t) => 1 - (1 - tip) * Math.pow(t, 1.5),
    caps: true,
  });

  const anchors: Anchor[] = [
    {
      name: 'base',
      position: path[0],
      axis: normalize(sub(path[0], path[1])),
      tangent: normalize(sub(path[1], path[0])),
    },
    {
      name: 'tip',
      position: path[path.length - 1],
      axis: normalize(sub(path[path.length - 1], path[path.length - 2])),
      tangent: normalize(sub(path[path.length - 1], path[path.length - 2])),
    },
  ];

  return { name: spec.name ?? 'clasp', mesh, bounds: meshBounds(mesh), anchors };
}
