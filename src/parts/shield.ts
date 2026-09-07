import { scaledCount } from '../mesh/detail';
import type { Vec2 } from '../geom/types';
import * as profile from '../geom/profile';
import { revolve } from '../mesh/revolve';
import { sweep } from '../mesh/sweep';
import { mergeMeshes } from '../mesh/types';
import { meshBounds, type Anchor, type Part } from './types';

export interface ShieldSpec {
  name?: string;
  /** Radius of the shield's face. */
  radius: number;
  /** How far the whole face domes outward at the centre. */
  domeHeight?: number;
  /** Radius of the raised boss over the grip. */
  bossRadius?: number;
  /** How far the boss stands proud of the dome it sits on. */
  bossHeight?: number;
  /** Shell thickness — a shield is worked sheet, not solid stock. */
  wall?: number;
  /** Width of the handgrip, back of the boss. */
  gripWidth?: number;
  gripRadius?: number;
  segments?: number;
}

/**
 * A round shield: a shallow domed disc with a raised boss at the centre —
 * over the hand, on a real one — and a grip bar across the back of it.
 *
 * Built the way `bell` builds a thin turned shell: one centreline profile
 * in (radius, height), offset by half the wall thickness to a front and a
 * back curve, revolved as a single closed loop rather than two separate
 * discs. The boss is not a second merged piece the way a sword's pommel
 * is — it is a bump added to the same centreline function the dome itself
 * is, so the shell stays one continuous, uniformly-thick surface through
 * it, the way a boss actually is raised from the same sheet as the rest of
 * the face.
 *
 * Faces +Z, the way it would lying face-up on a table or a stand; `pitch
 * 90deg` at `place` turns it to face outward instead, the way it would
 * hang on a wall or be held.
 */
export function shield(spec: ShieldSpec): Part {
  const domeHeight = spec.domeHeight ?? spec.radius * 0.14;
  const bossRadius = spec.bossRadius ?? spec.radius * 0.22;
  const bossHeight = spec.bossHeight ?? spec.radius * 0.09;
  const wall = spec.wall ?? spec.radius * 0.035;
  const gripWidth = spec.gripWidth ?? spec.radius * 0.7;
  const gripRadius = spec.gripRadius ?? wall * 1.1;
  const segments = scaledCount(spec.segments ?? 48);
  const rows = 28;

  const centrelineZ = (r: number) => {
    const t = Math.min(r / spec.radius, 1);
    const dome = domeHeight * (1 - t * t);
    const boss = r < bossRadius ? bossHeight * Math.pow(1 - r / bossRadius, 2) : 0;
    return dome + boss;
  };

  // traversed back-face-out, then front-face-back, so the loop closes at
  // the rim on one side and at the two poles on the other — revolve()'s
  // own "material lies to the left" convention needs this order, not the
  // reverse, to land outward-facing normals (checked against the signed
  // volume `validate.ts` reports, not assumed from the winding alone)
  const back: Vec2[] = [];
  const front: Vec2[] = [];
  for (let i = 0; i <= rows; i++) {
    const t = i / rows;
    const r = t * spec.radius;
    const z = centrelineZ(r);
    back.push([r, z - wall / 2]);
    front.push([r, z + wall / 2]);
  }
  front.reverse();
  const points = [...back, ...front];
  const sharp = points.map((_, i) => i === back.length - 1 || i === points.length - 1);

  const face = revolve({ points, sharp, closed: true }, { segments });

  // grip: a plain bar across the back, behind the boss, standing clear of
  // the shell so a hand actually fits between them
  const backZ = centrelineZ(0) - wall / 2 - gripRadius * 1.6;
  const grip = sweep([[-gripWidth / 2, 0, backZ], [gripWidth / 2, 0, backZ]], {
    profile: profile.circle(gripRadius, 10),
    caps: true,
    up: [0, 0, 1],
  });

  const mesh = mergeMeshes([face, grip]);
  const anchors: Anchor[] = [
    { name: 'face', position: [0, 0, centrelineZ(0) + wall / 2], axis: [0, 0, 1], tangent: [1, 0, 0] },
    { name: 'back', position: [0, 0, backZ], axis: [0, 0, -1], tangent: [1, 0, 0] },
  ];
  return { name: spec.name ?? 'shield', mesh, bounds: meshBounds(mesh), anchors };
}
