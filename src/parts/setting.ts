import { scaledCount } from '../mesh/detail';
import type { Vec2, Vec3 } from '../geom/types';
import * as profile from '../geom/profile';
import { mergeMeshes, type Mesh } from '../mesh/types';
import { revolve } from '../mesh/revolve';
import { sweep } from '../mesh/sweep';
import { meshBounds, type Anchor, type Part } from './types';

export type SettingStyle = 'claw' | 'bezel';

export interface SettingSpec {
  name?: string;
  /** Girdle width of the stone this holds. The mount is built around it. */
  width: number;
  style?: SettingStyle;
  /** Prongs, for a claw setting. */
  claws?: number;
  /** Depth of the collet below the girdle — how far the stone's pavilion can sink. */
  height?: number;
  /** Thickness of the metal. */
  wall?: number;
  /** How far the metal stands above the girdle to hold the stone down. */
  grip?: number;
  segments?: number;
}

/**
 * The metal that holds a stone.
 *
 * A stone is not soldered to anything; it is trapped, and the two ways of
 * trapping it look entirely different. A bezel is a wall of metal round the
 * whole girdle with a ledge inside for the stone to sit on and a rim rubbed
 * over its edge — it protects the stone and shows the least of it. Claws hold
 * it at a few points on a collet ring, which shows nearly the whole stone and
 * lets light in underneath, which is why every stone meant to sparkle is set
 * that way.
 *
 * Its `seat` anchor is the girdle plane, so `fasten stone to mount.seat` drops
 * a stone of the same width into it; `base` is the underside, so the mount
 * itself fastens to a plate the way any other fitting does.
 */
export function setting(spec: SettingSpec): Part {
  const style = spec.style ?? 'claw';
  const r = spec.width / 2;
  // A bezel's wall and a claw's wire are not the same thing and should not
  // default to the same number: a wall is thin because it wraps the whole
  // girdle, a claw is thicker because it holds at four points.
  const bezelStyle = style === 'bezel';
  const wall = spec.wall ?? Math.max(spec.width * (bezelStyle ? 0.06 : 0.09), bezelStyle ? 0.16 : 0.25);
  const height = spec.height ?? spec.width * 0.42;
  const grip = spec.grip ?? Math.max(spec.width * (bezelStyle ? 0.04 : 0.06), bezelStyle ? 0.11 : 0.2);
  const segments = scaledCount(spec.segments ?? 32);

  const built = bezelStyle
    ? bezel(r, wall, height, grip, segments)
    : claws(r, wall, height, grip, spec.claws ?? 4, segments);

  const anchors: Anchor[] = [
    // first, so the mount stands on whatever it is fastened to
    { name: 'base', position: [0, 0, built.bottom], axis: [0, 0, 1], tangent: [1, 0, 0] },
    // the girdle plane: where a stone of this width comes to rest
    { name: 'seat', position: [0, 0, 0], axis: [0, 0, 1], tangent: [1, 0, 0], bore: spec.width },
  ];
  return { name: spec.name ?? style, mesh: built.mesh, bounds: meshBounds(built.mesh), anchors };
}

/**
 * A wall around the stone with a seat cut inside it.
 *
 * The profile is one closed loop in (radius, height): down the inside from the
 * rim to the seat, in across the ledge the stone rests on, down the bore, out
 * across the bottom and back up the outside. The rim leans in over where the
 * girdle will be, which is what actually holds the stone in.
 */
function bezel(r: number, wall: number, height: number, grip: number, segments: number) {
  const ledge = Math.max(wall * 0.5, r * 0.07);
  const lap = ledge * 0.5;
  // The outside tapers as it rises, so what shows above the girdle is half the
  // metal that carries the weight at the base. A bezel of one thickness all
  // the way up reads as a tin rim round a small stone.
  const points: Vec2[] = [
    [r - lap, grip],
    [r, 0],
    [r - ledge, 0],
    [r - ledge, -height],
    [r + wall, -height],
    [r + wall * 0.5, grip],
  ];
  const mesh = revolve({ points, sharp: points.map(() => true), closed: true }, { segments });
  return { mesh, bottom: -height };
}

/**
 * A collet ring with prongs standing off it.
 *
 * Each claw leaves the ring, leans out to clear the girdle, and hooks back
 * over it at the tip — the hook is the whole mechanism, and without it the
 * stone would simply lift out.
 */
function claws(r: number, wall: number, height: number, grip: number, count: number, segments: number) {
  const collet = r * 0.78;
  const section = wall * 0.42;
  const sides = Math.max(6, Math.round(segments / 4));

  const ring: Vec2[] = [];
  const ringSegments = 16;
  for (let i = 0; i < ringSegments; i++) {
    const a = (i / ringSegments) * Math.PI * 2;
    ring.push([collet + section * Math.cos(a), -height + section * Math.sin(a)]);
  }
  const meshes: Mesh[] = [revolve({ points: ring, closed: true }, { segments })];

  const steps = 12;
  for (let c = 0; c < count; c++) {
    const angle = (c / count) * Math.PI * 2;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const path: Vec3[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const lean = t * t * (3 - 2 * t);
      // the tip folds inward over the girdle: nothing until near the top, then
      // quickly, so the claw reads as a hook rather than a lean
      const hook = Math.max(0, (t - 0.7) / 0.3);
      const radius = collet + (r + wall * 0.12 - collet) * lean - hook * hook * wall * 0.6;
      path.push([radius * cos, radius * sin, -height + (height + grip) * t]);
    }
    meshes.push(sweep(path, {
      profile: profile.circle(section, sides),
      taper: (t) => 1 - 0.32 * t,
      caps: true,
    }));
  }

  return { mesh: mergeMeshes(meshes), bottom: -height - section };
}
