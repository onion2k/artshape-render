import { scaledCount } from '../mesh/detail';
import { resample, type Curve } from '../geom/curve';
import * as profile from '../geom/profile';
import { sweep } from '../mesh/sweep';
import { meshBounds, type Anchor, type Part } from './types';
import { enamelConcave, enamelWhole } from '../mesh/types';
import { normalize, sub } from '../geom/vec';
import type { Vec3 } from '../geom/types';

export type Section = 'round' | 'square' | 'hex' | 'octagon' | 'flat' | 'lens';

export interface WireSpec {
  name?: string;
  path: Curve;
  /** Section radius at the base. */
  radius: number;
  /** Cross-section. Round draws as wire, the flats as rolled or drawn bar. */
  section?: Section;
  /** Fraction of the base radius left at the tip. 0.15 is a fine drawn point. */
  tipScale?: number;
  /** Turns of twist along the whole run. Only visible on a non-round section. */
  twistTurns?: number;
  /** Flatten from round at the base to a lens section at the tip. */
  flatten?: boolean;
  sections?: number;
  sides?: number;
  closed?: boolean;
  up?: Vec3;
  /**
   * Enamel by colour name. A round wire is dipped whole; a flat or lens
   * section has faces, and takes it on the concave one as a blade does.
   */
  enamel?: string;
}

/**
 * A drawn line in metal: a section swept along a curve, thinning as it runs.
 *
 * The taper is the whole point. A constant-radius tube reads as plumbing; a line
 * that starts heavy and dies away to a point is what makes a tendril look drawn
 * rather than extruded.
 */
export function wire(spec: WireSpec): Part {
  const sections = scaledCount(spec.sections ?? 128);
  const sides = scaledCount(spec.sides ?? 12);
  const closed = spec.closed ?? false;
  const tip = spec.tipScale ?? 0.2;

  const path = resample(spec.path, sections);
  const section = spec.section ?? 'round';
  const base = sectionProfile(section, spec.radius, sides);
  // morphing needs matching point counts, so it only applies to the round section
  const flat = profile.lens(spec.radius * 2.6, spec.radius * 0.7, sides);

  const mesh = sweep(path, {
    profile: base,
    morphTo: spec.flatten && section === 'round' ? flat : undefined,
    // eased so the heavy end holds its weight instead of thinning immediately
    taper: closed ? () => 1 : (t) => 1 - (1 - tip) * Math.pow(t, 1.4),
    twist: spec.twistTurns ? (t) => t * spec.twistTurns! * Math.PI * 2 : undefined,
    morph: (t) => Math.pow(t, 1.6),
    closed,
    caps: true,
    up: spec.up,
  });

  const anchors: Anchor[] = [];
  if (!closed) {
    anchors.push({
      name: 'base',
      position: path[0],
      axis: normalize(sub(path[0], path[1])),
      tangent: normalize(sub(path[1], path[0])),
    });
    anchors.push({
      name: 'tip',
      position: path[path.length - 1],
      axis: normalize(sub(path[path.length - 1], path[path.length - 2])),
      tangent: normalize(sub(path[path.length - 1], path[path.length - 2])),
    });
  }

  if (spec.enamel) {
    const faced = section === 'flat' || section === 'lens' || spec.flatten;
    if (faced) enamelConcave(mesh, path);
    else enamelWhole(mesh);
  }

  return { name: spec.name ?? 'wire', mesh, bounds: meshBounds(mesh), anchors, enamel: spec.enamel };
}

function sectionProfile(section: Section, radius: number, sides: number) {
  switch (section) {
    case 'square': return profile.polygon(4, radius * 1.28, Math.PI / 4);
    case 'hex': return profile.polygon(6, radius * 1.1);
    case 'octagon': return profile.polygon(8, radius * 1.05);
    case 'flat': return profile.ribbon(radius * 2.6, radius * 0.85, 3);
    case 'lens': return profile.lens(radius * 2.6, radius * 0.8, sides);
    default: return profile.circle(radius, sides);
  }
}

/**
 * A curved blade — a lens section swept along an arc, widening then dying at the
 * tip. Petals and leaves that are not flat plates are this.
 */
export interface BladeSpec {
  name?: string;
  path: Curve;
  width: number;
  thickness: number;
  /** Section width along the run, t in [0,1]. Defaults to a leaf-like swell. */
  swell?: (t: number) => number;
  twistTurns?: number;
  sections?: number;
  sides?: number;
  up?: Vec3;
  /** Enamel on the concave face, the side the blade curls toward, by colour name. */
  enamel?: string;
}

export function blade(spec: BladeSpec): Part {
  const sections = scaledCount(spec.sections ?? 96);
  const sides = scaledCount(spec.sides ?? 16);
  const path = resample(spec.path, sections);
  const swell = spec.swell ?? ((t: number) => Math.pow(Math.sin(Math.PI * t), 0.7) * (1 - 0.25 * t) + 0.06);

  const mesh = sweep(path, {
    profile: profile.lens(spec.width, spec.thickness, sides),
    taper: swell,
    twist: spec.twistTurns ? (t) => t * spec.twistTurns! * Math.PI * 2 : undefined,
    caps: true,
    up: spec.up,
  });

  if (spec.enamel) enamelConcave(mesh, path);
  return {
    name: spec.name ?? 'blade',
    mesh,
    bounds: meshBounds(mesh),
    enamel: spec.enamel,
    anchors: [
      {
        name: 'base',
        position: path[0],
        axis: normalize(sub(path[0], path[1])),
        tangent: normalize(sub(path[1], path[0])),
      },
    ],
  };
}

export interface BandSpec {
  name?: string;
  radius: number;
  width: number;
  thickness: number;
  /** Tilt of the band's plane, in radians. Armillaries are a set of these. */
  segments?: number;
}

/**
 * An armillary band: a flat ribbon closed into a ring, standing on edge.
 *
 * Distinct from a wire ring — the band has a face, so it catches light along its
 * whole length rather than in a thin highlight, and a nest of them reads as an
 * instrument rather than as loops of wire.
 */
export function band(spec: BandSpec): Part {
  const segments = scaledCount(spec.segments ?? 128);
  const path: Vec3[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    path.push([Math.cos(a) * spec.radius, Math.sin(a) * spec.radius, 0]);
  }
  path.push(path[0]);

  const mesh = sweep(path, {
    profile: profile.ribbon(spec.width, spec.thickness, 3),
    closed: true,
    caps: false,
    // seed the frame so the band's width lies along the ring axis, standing it
    // on edge rather than laying it flat
    up: [0, 0, 1],
  });

  return {
    name: spec.name ?? 'band',
    mesh,
    bounds: meshBounds(mesh),
    anchors: [
      { name: 'north', position: [spec.radius, 0, 0], axis: [1, 0, 0], tangent: [0, 0, 1] },
      { name: 'south', position: [-spec.radius, 0, 0], axis: [-1, 0, 0], tangent: [0, 0, 1] },
    ],
  };
}
