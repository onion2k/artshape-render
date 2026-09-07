import { scaledCount } from '../mesh/detail';
import * as profile from '../geom/profile';
import { sweep } from '../mesh/sweep';
import { mergeMeshes } from '../mesh/types';
import { meshBounds, type Anchor, type Part } from './types';
import type { Vec3 } from '../geom/types';

export interface LeverBackSpec {
  name?: string;
  /** Loop radius — the wire that passes through the lobe. */
  radius: number;
  /** Loop wire gauge. */
  wireRadius?: number;
  /** Gap left at the front for the lever and its catch, in radians. */
  gap?: number;
  /** Width of the lever paddle at its widest, where a fingertip presses it. */
  leverWidth?: number;
  /** Thickness of the lever paddle. */
  leverThickness?: number;
  sections?: number;
  sides?: number;
}

/**
 * A lever-back earring finding: a wire loop through the lobe, closed by a
 * hinged paddle pressed across the gap rather than left open like a fish
 * hook or squeezed shut like a jump ring — the secure fastening most studs
 * and small drops actually use.
 *
 * There is no real hinge here, only its resting, worn silhouette: the loop
 * is shank's gap construction again, and the lever is a second, shorter arc
 * bridging the same gap the short way, pinched down to wire gauge at both
 * ends so it reads as pivoting from the loop rather than welded across it.
 * The `seat` anchor sits at the gap's own centre, in front of both — where a
 * stud or a small drop mounts to hide the hinge and catch, the way a
 * rivet's `seat` hides its head.
 */
export function leverBack(spec: LeverBackSpec): Part {
  const wireRadius = spec.wireRadius ?? spec.radius * 0.12;
  const gap = Math.max(spec.gap ?? 0.8, 0.05);
  const sections = scaledCount(spec.sections ?? 64);
  const sides = scaledCount(spec.sides ?? 12);
  const leverWidth = spec.leverWidth ?? wireRadius * 3.2;
  const leverThickness = spec.leverThickness ?? wireRadius * 1.4;

  const from = gap / 2;
  const span = Math.PI * 2 - gap;
  const loopPath: Vec3[] = [];
  for (let i = 0; i <= sections; i++) {
    const a = from + (i / sections) * span;
    loopPath.push([Math.cos(a) * spec.radius, Math.sin(a) * spec.radius, 0]);
  }
  const loop = sweep(loopPath, {
    profile: profile.circle(wireRadius, sides),
    caps: true,
  });

  // bridges the gap the short way, standing slightly proud of the loop so it
  // reads as a separate part pressed against it rather than fused on
  const leverSections = Math.max(8, Math.round(sections * 0.25));
  const leverPath: Vec3[] = [];
  for (let i = 0; i <= leverSections; i++) {
    const t = i / leverSections;
    const a = from - gap * t;
    const r = spec.radius + wireRadius * 0.4;
    leverPath.push([Math.cos(a) * r, Math.sin(a) * r, 0]);
  }
  const lever = sweep(leverPath, {
    profile: profile.lens(leverWidth, leverThickness, sides),
    // full paddle width across the middle of the gap, pinched down to
    // near-nothing at the hinge and the catch so both ends tuck under the loop
    taper: (t) => 0.3 + 0.7 * Math.sin(Math.PI * t),
    caps: true,
  });

  const mesh = mergeMeshes([loop, lever]);

  const anchors: Anchor[] = [
    { name: 'seat', position: [spec.radius, 0, 0], axis: [1, 0, 0], tangent: [0, 0, 1] },
  ];

  return { name: spec.name ?? 'leverBack', mesh, bounds: meshBounds(mesh), anchors };
}
