import * as profile from '../geom/profile';
import { sweep } from '../mesh/sweep';
import type { Mesh } from '../mesh/types';
import type { Vec3 } from '../geom/types';

export interface BindingSpec {
  /** Radius of the shaft the strap is wound round. */
  shaftRadius: number;
  /** Where the binding starts along Z, and how far it runs. */
  z0: number;
  span: number;
  /** Full turns over the span; the strap is cut wide enough that they abut. */
  turns: number;
  /** Strap thickness, standing proud of the shaft. */
  thickness: number;
}

/**
 * A leather strap wound round a shaft — a sword's grip, an axe's hand
 * piece. A flat strap, not a round cord: cut to the pitch of its own helix
 * so each turn lies against the last and the shaft under it is covered,
 * the way a grip is actually bound.
 *
 * The strap lies flat against the shaft, thickness radial and width along
 * the helix's advance. A rotation-minimising frame drifts round a helix
 * (a helix has torsion), so the sweep is given the twist that undoes it —
 * the frame's own rotation relative to the shaft, c / (r² + c²) per unit of
 * length for pitch 2πc — leaving the strap flat the whole way up.
 */
export function leatherBinding(spec: BindingSpec): Mesh {
  const reach = spec.shaftRadius + spec.thickness * 0.5;
  const pitch = spec.span / spec.turns;
  const width = pitch * 0.94;
  const rows = Math.max(24, Math.round(spec.turns * 18));
  const path: Vec3[] = [];
  for (let i = 0; i <= rows; i++) {
    const t = i / rows;
    const a = t * spec.turns * Math.PI * 2;
    path.push([Math.cos(a) * reach, Math.sin(a) * reach, spec.z0 + t * spec.span]);
  }
  const c = pitch / (2 * Math.PI);
  const torsion = c / (reach * reach + c * c);
  const length = spec.turns * Math.sqrt((2 * Math.PI * reach) ** 2 + pitch ** 2);
  return sweep(path, {
    profile: profile.ribbon(width, spec.thickness, 3),
    caps: true,
    // seeded along the shaft, so the strap's width starts along the helix's
    // advance and its thickness starts radial
    up: [0, 0, 1],
    twist: (t) => torsion * length * t,
  });
}
