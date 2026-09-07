import { scaledCount } from '../mesh/detail';
import type { Vec2, Vec3 } from '../geom/types';
import * as profile from '../geom/profile';
import { tombstoneOutline } from '../geom/outline';
import { extrude } from '../mesh/extrude';
import { revolve } from '../mesh/revolve';
import { sweep } from '../mesh/sweep';
import { mergeMeshes } from '../mesh/types';
import { meshBounds, type Anchor, type Part } from './types';

const ease = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * A run of eased waypoints in (radius, height), sampled into rows for
 * `revolve()`. Consecutive waypoints at the same height are a deliberate
 * corner — a cap or a step — and are never smoothed into their neighbours;
 * everything else blends by `ease` the way a lathed or moulded profile
 * actually rounds over between diameters.
 */
function profileRows(waypoints: Vec2[], perSpan: number): { points: Vec2[]; sharp: boolean[] } {
  const points: Vec2[] = [waypoints[0]];
  const sharp: boolean[] = [false];
  for (let w = 1; w < waypoints.length; w++) {
    const [r0, z0] = waypoints[w - 1];
    const [r1, z1] = waypoints[w];
    const corner = Math.abs(z1 - z0) < 1e-9;
    const steps = corner ? 1 : perSpan;
    for (let i = 1; i <= steps; i++) {
      const t = corner ? 1 : ease(i / steps);
      points.push([lerp(r0, r1, t), lerp(z0, z1, t)]);
      sharp.push(i === 1 && (corner || Math.abs(z0 - (waypoints[w - 2]?.[1] ?? z0)) < 1e-9));
    }
  }
  return { points, sharp };
}

export interface RingStandSpec {
  name?: string;
  /** Radius of the flat foot the stand rests on. */
  baseRadius: number;
  /** Height of the foot. */
  baseHeight?: number;
  /** Radius of the post a ring sits round. */
  postRadius?: number;
  /** Height of the post's straight run, before it tapers to a rounded tip. */
  postHeight?: number;
  segments?: number;
}

/**
 * A ring display stand: a flat foot and a post to slide a ring's own bore
 * onto. Plain plastic prop geometry — see the "plastic" material family in
 * `src/render/materials.ts` for how it's meant to be finished, in `matte` or
 * `flock`, never mistaken for the piece it is holding.
 */
export function ringStand(spec: RingStandSpec): Part {
  const baseHeight = spec.baseHeight ?? spec.baseRadius * 0.18;
  const postRadius = spec.postRadius ?? spec.baseRadius * 0.32;
  const postHeight = spec.postHeight ?? spec.baseRadius * 1.6;
  const segments = scaledCount(spec.segments ?? 48);
  const tipRows = 10;

  const waypoints: Vec2[] = [
    [0, 0],
    [spec.baseRadius, 0],
    [spec.baseRadius, baseHeight],
    [postRadius, baseHeight],
    [postRadius, baseHeight + postHeight],
  ];
  const { points, sharp } = profileRows(waypoints, 10);

  const tipBase = baseHeight + postHeight;
  for (let i = 1; i <= tipRows; i++) {
    const t = i / tipRows;
    points.push([postRadius * Math.cos((t * Math.PI) / 2), tipBase + postRadius * Math.sin((t * Math.PI) / 2)]);
    sharp.push(false);
  }

  const mesh = revolve({ points, sharp }, { segments });
  const top = tipBase + postRadius;
  const anchors: Anchor[] = [
    { name: 'base', position: [0, 0, 0], axis: [0, 0, -1], tangent: [1, 0, 0] },
    { name: 'peg', position: [0, 0, top], axis: [0, 0, 1], tangent: [1, 0, 0] },
  ];
  return { name: spec.name ?? 'ringStand', mesh, bounds: meshBounds(mesh), anchors };
}

export interface EarringStandSpec {
  name?: string;
  /** Radius of the flat foot the stand rests on. */
  baseRadius: number;
  /** Height of the foot. */
  baseHeight?: number;
  /** Radius of the post carrying the bar. */
  postRadius?: number;
  /** Height from the foot to the underside of the bar. */
  postHeight?: number;
  /** Length of the bar earrings hang from, end to end. */
  barLength?: number;
  /** Thickness of the bar. */
  barRadius?: number;
  segments?: number;
}

/**
 * An earring stand: a T-bar on a post, for a hook or a lever-back to hang
 * from by its own loop the way it would from a lobe — unlike a ring's bore
 * or a pendant's own weight, nothing here is a good fit for `fasten`'s
 * anchor matching (an earring is a whole hand-placed unit, not a single
 * `Part` with a compatible anchor of its own), so `left`/`right` are
 * reference points for hand placement, the same as `ringStand`'s `peg`.
 */
export function earringStand(spec: EarringStandSpec): Part {
  const baseHeight = spec.baseHeight ?? spec.baseRadius * 0.18;
  const postRadius = spec.postRadius ?? spec.baseRadius * 0.22;
  const postHeight = spec.postHeight ?? spec.baseRadius * 2.2;
  const barLength = spec.barLength ?? spec.baseRadius * 2.6;
  const barRadius = spec.barRadius ?? postRadius * 0.85;
  const segments = scaledCount(spec.segments ?? 48);
  const sides = Math.max(8, Math.round(segments / 3));

  const waypoints: Vec2[] = [
    [0, 0],
    [spec.baseRadius, 0],
    [spec.baseRadius, baseHeight],
    [postRadius, baseHeight],
    [postRadius, baseHeight + postHeight],
    // closes the post's top with a flat cap; without it the tube's open end
    // is bare, and merging in the bar (which shares no vertices with it)
    // leaves a hole rather than sealing one
    [0, baseHeight + postHeight],
  ];
  const { points, sharp } = profileRows(waypoints, 10);
  const post = revolve({ points, sharp }, { segments });

  const barZ = baseHeight + postHeight + barRadius;
  const half = barLength / 2;
  const barPath: Vec3[] = [[-half, 0, barZ], [half, 0, barZ]];
  const bar = sweep(barPath, { profile: profile.circle(barRadius, sides), caps: true, up: [0, 0, 1] });

  const mesh = mergeMeshes([post, bar]);
  const anchors: Anchor[] = [
    { name: 'base', position: [0, 0, 0], axis: [0, 0, -1], tangent: [1, 0, 0] },
    { name: 'left', position: [-half, 0, barZ], axis: [-1, 0, 0], tangent: [0, 1, 0] },
    { name: 'right', position: [half, 0, barZ], axis: [1, 0, 0], tangent: [0, 1, 0] },
  ];
  return { name: spec.name ?? 'earringStand', mesh, bounds: meshBounds(mesh), anchors };
}

export interface BustSpec {
  name?: string;
  /** Height from the base to the cut top of the neck. */
  height: number;
  /** Radius of the base it stands on. */
  baseRadius?: number;
  /** Radius at the shoulders, the widest point. */
  shoulderRadius?: number;
  /** Fraction of the height the shoulders sit at. */
  shoulderSpan?: number;
  /** Radius of the neck, the narrowest point. */
  neckRadius?: number;
  segments?: number;
}

/**
 * A neck bust: a plain stand for a necklace or a pair of earrings, cut off
 * at the neck rather than modelled as a head. Built as one body of
 * revolution — the same abstraction a real jeweller's bust makes, since it
 * is a prop to hang things on rather than a likeness of anyone.
 *
 * The `neck` anchor sits at the front, where a pendant naturally falls;
 * `base` is the underside, for standing it on a surface.
 */
export function bust(spec: BustSpec): Part {
  const height = spec.height;
  const baseRadius = spec.baseRadius ?? height * 0.36;
  const shoulderRadius = spec.shoulderRadius ?? height * 0.52;
  const shoulderSpan = Math.min(Math.max(spec.shoulderSpan ?? 0.34, 0.05), 0.9);
  const neckRadius = spec.neckRadius ?? height * 0.17;
  const segments = scaledCount(spec.segments ?? 64);

  const shoulderHeight = height * shoulderSpan;
  // the neck itself is a short cylinder, not one long taper all the way to
  // the cut top — without it the whole thing reads as a plain cone
  const neckHeight = lerp(shoulderHeight, height, 0.55);
  const waypoints: Vec2[] = [
    [0, 0],
    [baseRadius, 0],
    [shoulderRadius, shoulderHeight],
    [neckRadius, neckHeight],
    [neckRadius, height],
    [0, height],
  ];
  const { points, sharp } = profileRows(waypoints, 14);

  const mesh = revolve({ points, sharp }, { segments });
  const anchors: Anchor[] = [
    { name: 'base', position: [0, 0, 0], axis: [0, 0, -1], tangent: [1, 0, 0] },
    // pointing back toward the centreline, not out away from it: `connect`'s
    // "same" alignment carries a fastened part's own bulk opposite whatever
    // axis it lands on, so an anchor meant to hold something *outward* has
    // to point *inward* itself — checked against the shipped `display`
    // example, where a pearl fastened here sits properly proud of the neck.
    { name: 'neck', position: [neckRadius, 0, height * 0.94], axis: [-1, 0, 0], tangent: [0, 0, 1] },
  ];
  return { name: spec.name ?? 'bust', mesh, bounds: meshBounds(mesh), anchors };
}

export interface EaselSpec {
  name?: string;
  /** Width of the card. */
  width: number;
  /** Height of the card, its foot to its rounded top. */
  height: number;
  /** Radius of the two top corners. */
  cornerRadius?: number;
  /** Card thickness. */
  thickness?: number;
  bevel?: number;
  /** Radius of the peg a chain's own hook loops over. */
  pegRadius?: number;
  pegLength?: number;
  /** How far the back leg reaches behind the card, propping it upright. */
  legDepth?: number;
  segments?: number;
}

/**
 * A necklace card: a flat, velvet-flocked board with a peg near the top for
 * a chain's own hook or clasp to loop over, propped up by a simple back leg
 * — the trade's answer for a chain too fine or too delicate to drape over a
 * `bust`'s own neck.
 *
 * Built flat, like `extrude()` builds everything: width up its own local Y,
 * width across local X, thickness along local Z. Unlike `ringStand` and
 * `bust`, which stand in Z as drawn, an easel wants `roll 90deg` at the
 * `place` that puts it in a sketch — `roll` turns around X, which is the one
 * rotation that swings the card's own height (Y) up into world Z without
 * touching its width; `pitch` (around Y) would spin it on the spot instead,
 * since Y is exactly the axis a card's own height already lies along.
 */
export function easel(spec: EaselSpec): Part {
  const cornerRadius = spec.cornerRadius ?? Math.min(spec.width, spec.height) * 0.22;
  const thickness = spec.thickness ?? Math.min(spec.width, spec.height) * 0.06;
  const bevel = spec.bevel ?? Math.min(thickness * 0.3, 0.4);
  // chunkier than the card's own thickness alone would suggest — a peg has
  // to read clearly enough at a glance to show where a piece actually hangs
  const pegRadius = spec.pegRadius ?? thickness * 1.2;
  const pegLength = spec.pegLength ?? pegRadius * 3;
  const legDepth = spec.legDepth ?? spec.height * 0.55;
  const segments = scaledCount(spec.segments ?? 10);

  const card = extrude({
    outline: tombstoneOutline(spec.width, spec.height, cornerRadius, segments),
    thickness,
    bevel,
  });

  // the peg: a short stub off the front face, tapered so a loop can't walk
  // back off the tip the way it could off a plain cylinder
  const pegY = spec.height * 0.86;
  const peg = sweep(
    [[0, pegY, thickness / 2], [0, pegY, thickness / 2 + pegLength]],
    { profile: profile.circle(pegRadius, 12), taper: (t) => 1 - 0.3 * t, caps: true },
  );

  // the leg: a flat strut from partway up the back face down to the ground
  // the card's own foot already stands on, propping the whole thing back at
  // an angle rather than leaving it to balance on its edge
  const legWidth = spec.width * 0.18;
  const legThickness = thickness * 0.7;
  const leg = sweep(
    [[0, spec.height * 0.24, -thickness / 2], [0, 0, -legDepth]],
    { profile: profile.ribbon(legWidth, legThickness, 3), caps: true, up: [1, 0, 0] },
  );

  const mesh = mergeMeshes([card, peg, leg]);
  const anchors: Anchor[] = [
    { name: 'base', position: [0, 0, 0], axis: [0, -1, 0], tangent: [1, 0, 0] },
    // a landmark, not a fasten target — a necklace is a hand-built unit, the
    // same reasoning as earringStand's left/right
    { name: 'hook', position: [0, pegY, thickness / 2 + pegLength], axis: [0, 0, 1], tangent: [0, 1, 0] },
  ];
  return { name: spec.name ?? 'easel', mesh, bounds: meshBounds(mesh), anchors };
}
