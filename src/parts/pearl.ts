import { scaledCount } from '../mesh/detail';
import { revolve } from '../mesh/revolve';
import { meshBounds, type Part } from './types';
import type { Vec2 } from '../geom/types';

export interface PearlSpec {
  name?: string;
  radius: number;
  /** Flattening along the axis: 0 is round, 0.15 a button pearl. */
  oblate?: number;
  segments?: number;
}

/**
 * A pearl: the first thing in the vocabulary that is not metal.
 *
 * Geometrically it is nothing — a sphere, or a slightly flattened one — and it
 * is here for its material. Nacre is a stack of aragonite plates in a protein
 * matrix, translucent enough that light gets under the surface and comes back
 * out diffused, with a soft lustre on top and an iridescent sheen that turns
 * with the view. All of that lives in the shader; the part just declares that
 * it wants it.
 *
 * Origin at the centre, seat at the bottom pole, so it pegs onto a post the way
 * a pearl is set — glued over a pin rather than riveted through.
 */
export function pearl(spec: PearlSpec): Part {
  const r = spec.radius;
  const squash = 1 - Math.min(Math.max(spec.oblate ?? 0, 0), 0.5);
  const rows = 28;
  const points: Vec2[] = [];
  for (let i = 0; i <= rows; i++) {
    const a = (i / rows) * Math.PI;
    points.push([r * Math.sin(a), -r * Math.cos(a) * squash]);
  }
  const mesh = revolve({ points }, { segments: scaledCount(spec.segments ?? 48) });
  return {
    name: spec.name ?? 'pearl',
    mesh,
    bounds: meshBounds(mesh),
    // a pearl is cemented onto its peg; there is no solder anywhere near it
    solderable: false,
    anchors: [
      { name: 'seat', position: [0, 0, -r * squash], axis: [0, 0, -1], tangent: [1, 0, 0] },
      { name: 'crown', position: [0, 0, r * squash], axis: [0, 0, 1], tangent: [1, 0, 0] },
    ],
  };
}
