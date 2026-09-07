import { scaledCount } from '../mesh/detail';
import type { Vec2, Vec3 } from '../geom/types';
import { line } from '../geom/curve';
import * as profile from '../geom/profile';
import { blade as bladePart } from './wire';
import { revolve } from '../mesh/revolve';
import { sweep } from '../mesh/sweep';
import { enamelWhole, mergeMeshes, type Mesh } from '../mesh/types';
import { leatherBinding } from './binding';
import { meshBounds, type Anchor, type Part } from './types';

export interface SwordSpec {
  name?: string;
  /** Blade length, guard to tip. */
  bladeLength: number;
  /** Blade width at its widest, just above the guard. */
  bladeWidth?: number;
  bladeThickness?: number;
  /** How much of the blade's length stays near full width before it tapers to the point, 0 to 1. */
  bladeTaper?: number;
  /** Raised marks down the blade's centre, near the guard — a fantasy piece's own sigils. 0 for none. */
  runeCount?: number;
  /** Length of each mark along the blade. */
  runeSize?: number;
  /** Grip length, pommel to guard. */
  gripLength?: number;
  gripRadius?: number;
  /**
   * Turns of a leather binding wound round the grip, 0 for a bare grip.
   * A flat strap cut to the pitch of its own helix, so the turns abut and
   * the grip under them is covered. Texture is the strap's own pitch and
   * thickness — `wrapTurns` for how many turns it takes, `wrapRadius` for
   * half its thickness; there are no images anywhere in this renderer, so
   * "texture" is geometry.
   */
  wrapTurns?: number;
  wrapRadius?: number;
  /** Crossguard length, tip to tip. */
  guardWidth?: number;
  guardThickness?: number;
  pommelRadius?: number;
  /**
   * The leather binding's colour, by the same enamel names every other
   * coloured part uses. Only the binding takes it — the rest of the sword
   * is whatever metal the sketch or the part itself is placed `in`.
   */
  enamel?: string;
  segments?: number;
}

/**
 * A straight sword: pommel, grip (with an optional leather binding),
 * crossguard and blade, stacked bottom to top along Z the way every other
 * standing part in this catalogue is — unlike `easel`, nothing here is
 * built from a flat `extrude()` outline, so it needs no `roll`/`pitch` at
 * `place` to stand up correctly.
 *
 * The blade itself is `wire`'s own `blade()` — a lens section swept along a
 * straight run — rather than a shape reinvented here, with a `swell` tuned
 * to hold its width most of the way rather than curving down from the base
 * the way a leaf does. The same function draws the crossguard's finials and
 * the blade's own rune marks: everything on this part that isn't a plain
 * revolved knob is a swept lens, just at a different scale. Dagger
 * proportions are this with a short `bladeLength` and `gripLength`; nothing
 * else about the part is sword-specific.
 */
export function sword(spec: SwordSpec): Part {
  const bladeWidth = spec.bladeWidth ?? spec.bladeLength * 0.09;
  const bladeThickness = spec.bladeThickness ?? bladeWidth * 0.13;
  const bladeTaper = Math.min(Math.max(spec.bladeTaper ?? 0.7, 0.05), 0.95);
  const gripLength = spec.gripLength ?? spec.bladeLength * 0.16;
  const gripRadius = spec.gripRadius ?? bladeWidth * 0.42;
  const guardWidth = spec.guardWidth ?? bladeWidth * 3.2;
  const guardThickness = spec.guardThickness ?? gripRadius * 0.9;
  // a fist-sized knob reads as ornament; a sword's own pommel is barely
  // wider than the grip it caps, just enough to stop a hand sliding off
  const pommelRadius = spec.pommelRadius ?? gripRadius * 1.1;
  const segments = scaledCount(spec.segments ?? 24);
  const sides = Math.max(8, Math.round(segments / 2));

  // pommel: a plain oblate knob, pole to pole, widest at half its own height
  const pommelHeight = pommelRadius * 1.3;
  const pommelRows = 14;
  const pommelPts: Vec2[] = [];
  for (let i = 0; i <= pommelRows; i++) {
    const a = (i / pommelRows) * Math.PI;
    pommelPts.push([pommelRadius * Math.sin(a), (pommelHeight / 2) * (1 - Math.cos(a))]);
  }
  const pommel = revolve({ points: pommelPts }, { segments });

  // grip: a barrel — slightly fatter at the middle than at either end, the
  // way a hand actually wants to close round it
  const gripBase = pommelHeight;
  const guardZ = gripBase + gripLength;
  const grip = sweep([[0, 0, gripBase], [0, 0, guardZ]], {
    profile: profile.circle(gripRadius, sides),
    taper: (t) => 1 + 0.12 * Math.sin(Math.PI * t),
    caps: true,
  });

  const pieces: Mesh[] = [pommel, grip];

  // the leather: a flat strap wound round the grip, each turn against the
  // last, so the grip under it is covered — a binding, not a decal
  const wrapTurns = spec.wrapTurns ?? 7;
  if (wrapTurns > 0) {
    const wrap = leatherBinding({
      shaftRadius: gripRadius,
      z0: gripBase,
      span: gripLength,
      turns: wrapTurns,
      thickness: (spec.wrapRadius ?? gripRadius * 0.11) * 2,
    });
    if (spec.enamel) enamelWhole(wrap);
    pieces.push(wrap);
  }

  // guard: curves toward the blade at both ends and tapers thinner there,
  // with a small finial at each tip — a plain straight bar reads as a
  // placeholder, not as forged steel
  const guardSpan = guardWidth / 2;
  const guardRise = guardThickness * 2.2;
  const guardRows = 16;
  const guardPath: Vec3[] = [];
  for (let i = 0; i <= guardRows; i++) {
    const s = (i / guardRows) * 2 - 1;
    guardPath.push([s * guardSpan, 0, guardZ + guardRise * s * s]);
  }
  const guard = sweep(guardPath, {
    profile: profile.ribbon(guardThickness, gripRadius * 1.3, 4),
    taper: (t) => 1 - 0.35 * Math.pow(Math.abs(t * 2 - 1), 1.4),
    caps: true,
    up: [0, 0, 1],
  });
  pieces.push(guard);

  const finialRadius = guardThickness * 0.95;
  const finialPts: Vec2[] = [];
  const finialRows = 10;
  for (let i = 0; i <= finialRows; i++) {
    const a = (i / finialRows) * Math.PI;
    finialPts.push([finialRadius * Math.sin(a), -finialRadius * Math.cos(a)]);
  }
  for (const side of [-1, 1]) {
    const finial = revolve({ points: finialPts }, { segments: 16 });
    // revolve always centres on the local origin; a plain sphere has no
    // pole direction to get wrong, so a position-only offset is safe here
    // in a way it would not be for a shape a rotation could still be needed
    for (let i = 0; i < finial.positions.length; i += 3) {
      finial.positions[i] += side * guardSpan;
      finial.positions[i + 2] += guardZ + guardRise;
    }
    pieces.push(finial);
  }

  // blade: held near full width for `bladeTaper` of its own length, then
  // eased down to a point — a straight taper reads as ground steel, the
  // leaf-like curve wire's own blade() defaults to reads as grown, not forged
  const swell = (t: number) => {
    const past = Math.max(0, (t - bladeTaper) / (1 - bladeTaper));
    // never quite zero: a swept cross-section that actually closes to a true
    // point is degenerate (several faces sharing one coincident vertex,
    // which fails watertightness), the same reason wire's own default swell
    // floors at a small constant rather than easing all the way to nothing
    return (1 - 0.08 * t) * (1 - Math.pow(past, 1.6) * 0.97);
  };
  const bladeMesh = bladePart({
    path: line([0, 0, guardZ], [0, 0, guardZ + spec.bladeLength]),
    width: bladeWidth,
    thickness: bladeThickness,
    swell,
    sections: segments * 2,
    sides,
    // the path runs along Z itself, so the seed has to be a horizontal
    // vector — one parallel to the path's own tangent leaves the sweep
    // frame undefined rather than merely unrotated
    up: [1, 0, 0],
  }).mesh;
  pieces.push(bladeMesh);

  // runes: short raised dashes down the blade's own centreline, standing
  // proud of the front face — plain metal, not enamelled, so they read as
  // struck or engraved rather than painted
  const runeCount = spec.runeCount ?? 0;
  if (runeCount > 0) {
    const runeSize = spec.runeSize ?? bladeWidth * 0.4;
    const runeWidth = runeSize * 0.32;
    const runeThickness = runeSize * 0.22;
    const runeSwell = (t: number) => 0.06 + 0.94 * Math.pow(Math.sin(Math.PI * t), 0.8);
    const runeY = bladeThickness * 0.3;
    const spacing = runeSize * 1.7;
    const clearOf = guardZ + spec.bladeLength * bladeTaper;
    for (let i = 0; i < runeCount; i++) {
      const z = guardZ + spacing * (i + 1);
      if (z + runeSize > clearOf) break;
      const rune = bladePart({
        path: line([0, runeY, z], [0, runeY, z + runeSize]),
        width: runeWidth,
        thickness: runeThickness,
        swell: runeSwell,
        sections: 8,
        sides: 8,
        up: [1, 0, 0],
      }).mesh;
      pieces.push(rune);
    }
  }

  const mesh = mergeMeshes(pieces);
  const anchors: Anchor[] = [
    { name: 'base', position: [0, 0, 0], axis: [0, 0, -1], tangent: [1, 0, 0] },
    { name: 'tip', position: [0, 0, guardZ + spec.bladeLength], axis: [0, 0, 1], tangent: [1, 0, 0] },
  ];
  return { name: spec.name ?? 'sword', mesh, bounds: meshBounds(mesh), anchors, enamel: spec.enamel };
}
