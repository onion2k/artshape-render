import { scaledCount } from '../mesh/detail';
import * as profile from '../geom/profile';
import { sweep } from '../mesh/sweep';
import { meshBounds, type Anchor, type Part } from './types';
import type { Vec3 } from '../geom/types';

export interface JumpRingSpec {
  name?: string;
  /** Ring radius, to the wire's own centreline. */
  radius: number;
  /** Wire section radius. */
  wireRadius: number;
  /**
   * A gap left in the loop, in radians — an open jump ring, threaded onto
   * whatever it links before being closed and soldered. 0 is a closed,
   * soldered ring.
   */
  gap?: number;
  sections?: number;
  sides?: number;
}

/**
 * A jump ring: the plain closed loop of wire that links a clasp to a chain,
 * a drop to an ear wire, or one length of chain to another — the connector
 * that makes the rest of the catalogue's hooks and eyes into an actual
 * chain, rather than a set of parts that only ever fasten directly onto
 * each other.
 *
 * Same open-loop construction as shank's tension gap, for the same reason:
 * a jump ring is only ever fully closed at the bench, after whatever it
 * links has been threaded through the gap.
 */
export function jumpRing(spec: JumpRingSpec): Part {
  const sections = scaledCount(spec.sections ?? 64);
  const sides = scaledCount(spec.sides ?? 12);
  const gap = Math.max(spec.gap ?? 0, 0);
  const closed = gap < 1e-6;

  const from = gap / 2;
  const span = Math.PI * 2 - gap;
  const rows = closed ? sections : sections + 1;
  const path: Vec3[] = [];
  for (let i = 0; i < rows; i++) {
    const a = from + (i / sections) * span;
    path.push([Math.cos(a) * spec.radius, Math.sin(a) * spec.radius, 0]);
  }
  if (closed) path.push(path[0]);

  const mesh = sweep(path, {
    profile: profile.circle(spec.wireRadius, sides),
    closed,
    caps: !closed,
  });

  const anchors: Anchor[] = [
    // the gap's own centre, whether or not there is metal under it — where
    // a clasp's hook, or the last link of a chain, threads through
    { name: 'gate', position: [spec.radius, 0, 0], axis: [1, 0, 0], tangent: [0, 0, 1] },
  ];

  return { name: spec.name ?? 'jumpRing', mesh, bounds: meshBounds(mesh), anchors };
}
