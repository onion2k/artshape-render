import { scaledCount } from '../mesh/detail';
import { detail } from '../mesh/detail';
import {
  clearsOthers, ensureWinding, fitsInside, leafOutline, leafPiercings, palmateOutline, palmateVeins,
  teardropOutline, transformLoop, veinPiercings, type LeafShape,
} from '../geom/outline';
import { extrude, outlineSpan } from '../mesh/extrude';
import { chordLimit, deform, deformAnchor } from '../mesh/deform';
import { meshBounds, type Anchor, type Part, type PlateRelief } from './types';
import type { Vec2 } from '../geom/types';

export interface LeafSpec {
  name?: string;
  length: number;
  width: number;
  thickness: number;
  /** Edge break. Without it the outline catches no light and reads as cut paper. */
  bevel?: number;
  /** Teardrop piercings along the midrib. */
  piercings?: number;
  /** Angled slots either side of the midrib, pierced as venation. */
  veins?: number;
  /** Silhouette family: ovate, lanceolate, elliptic, obovate, cordate. */
  shape?: LeafShape;
  /** Marginal teeth. */
  teeth?: number;
  toothDepth?: number;
  /** Palmate lobes radiating from the petiole, as a maple. 0 gives a simple leaf. */
  lobes?: number;
  /** Angular spread of a palmate leaf, in radians. */
  spread?: number;
  /** Sideways bend of the midrib. */
  droop?: number;
  /** Rise of each margin above the midrib, in radians — the leaf's channel. */
  cup?: number;
  /** 0 a smooth channel, 1 a crease along the midrib. Grasses and tulips are keeled. */
  keel?: number;
  /** Total turn of the midrib from base to tip. Positive lifts the tip. */
  curl?: number;
  /** 1 curves evenly; above 2 the base stays straight and the tip arches over. */
  curlBias?: number;
  /** Turns of twist about the midrib, in radians. */
  twist?: number;
  /** Height of chased veins in relief. Defaults to a quarter of the thickness; 0 for a plain plate. */
  relief?: number;
  reliefVeins?: number;
  segments?: number;
  /** Rivet hole at the base, and the anchor that goes with it. */
  bossBore?: number;
  /** Enamel fired into the top face, by colour name. The bevel stays metal. */
  enamel?: string;
  /** Metal wires along the veins of an enamelled face, by metal name. */
  veinMetal?: string;
}

/**
 * A pierced leaf plate: the flat counterpart to a blade, and the piece that
 * carries fasteners. Cut, pierced and edge-broken — no boolean anywhere, because
 * a pierced outline is a 2D problem and only the caps need triangulating.
 */
export function leaf(spec: LeafSpec): Part {
  const segments = scaledCount(spec.segments ?? 64);
  const droop = spec.droop ?? 0.18;
  const bevel = spec.bevel ?? Math.min(spec.thickness * 0.28, 0.4);

  const shape = spec.shape ?? 'ovate';
  const outline = spec.lobes
    ? palmateOutline(spec.lobes, spec.length, spec.spread ?? 2.5, 0.42, segments * 2)
    : leafOutline(spec.length, spec.width, {
        shape, segments, droop,
        notch: shape === 'cordate' ? 0.14 : 0,
        teeth: spec.teeth ?? 0,
        toothDepth: spec.toothDepth ?? spec.width * 0.035,
      });

  const spread = spec.spread ?? 2.5;
  const holes: Vec2[][] = [];
  if (spec.lobes) {
    // a palmate leaf's venation is radial, so the axial pattern does not apply
    if (spec.veins || spec.piercings) holes.push(...palmateVeins(spec.lobes, spec.length, spread));
  } else {
    if (spec.piercings) {
      holes.push(...leafPiercings(spec.length, spec.width, spec.piercings, droop, 0.62, shape));
    }
    if (spec.veins) {
      holes.push(...veinPiercings(spec.length, spec.width, spec.veins, { droop, shape }));
    }
  }

  // Where the leaf joins whatever carries it. First, so that fastening a leaf
  // somewhere means fastening it by its base — the boss is for a rivet landing
  // on the leaf, which is a different job and is always named.
  const anchors: Anchor[] = [
    { name: 'base', position: [0, 0, 0], axis: [-1, 0, 0], tangent: [0, 0, 1] },
  ];
  if (spec.bossBore) {
    const r = spec.bossBore / 2;
    // a palmate leaf attaches at its polar centre, so the boss sits just inside it
    const t = spec.lobes ? 0.15 : bossPosition(spec.length, spec.width, r, bevel + spec.thickness * 0.7);
    const at: Vec2 = spec.lobes
      ? [spec.length * t, 0]
      : [t * spec.length, Math.sin(Math.PI * t) * droop * spec.length];
    holes.push(ensureWinding(transformLoop(teardropOutline(r * 2, r * 2, 16), at[0], at[1]), false));
    anchors.push({
      name: 'boss',
      position: [at[0], at[1], spec.thickness / 2],
      axis: [0, 0, 1],
      tangent: [1, 0, 0],
      bore: spec.bossBore,
    });
  }

  // Anything that would break the margin is dropped rather than drawn through it.
  const clearance = bevel + spec.thickness * 0.45;
  const fitted: Vec2[][] = [];
  for (const hole of holes) {
    if (fitsInside(hole, outline, clearance) && clearsOthers(hole, fitted, clearance)) {
      fitted.push(hole);
    }
  }

  // A flat leaf reads as a cut-out. Cup and curl are what make the surface carry
  // a highlight along its length rather than flashing all at once.
  const fields = {
    cup: spec.cup, keel: spec.keel,
    curl: spec.curl, curlBias: spec.curlBias,
    twist: spec.twist,
    length: spec.length,
    halfWidth: (spec.lobes ? spec.length : spec.width) / 2,
    origin: 0,
    // the cup folds about the midrib, which droop has already bowed sideways
    midline: spec.lobes
      ? undefined
      : (x: number) => Math.sin(Math.PI * Math.min(Math.max(x / spec.length, 0), 1)) * droop * spec.length,
    // a palmate leaf has no single midrib to chase
    relief: spec.lobes ? 0 : spec.relief ?? spec.thickness * 0.25,
    reliefVeins: spec.reliefVeins ?? 5,
  };
  // A flat cap can be a fan of long triangles; a bent one cannot, so the plate is
  // refined while it is still planar and cheap to cut.
  // the chord a draft may take is longer by the detail's inverse: half the detail, twice the chord, a quarter of the cap
  const limit = chordLimit(fields, spec.length * 0.004) / detail();
  const mesh = extrude({
    outline, holes: fitted, thickness: spec.thickness, bevel,
    maxCapEdge: Number.isFinite(limit) ? limit : undefined,
    enamelTop: !!spec.enamel,
  });

  if (spec.cup || spec.curl || spec.twist || fields.relief) {
    deform(mesh, fields);
    for (const anchor of anchors) {
      const moved = deformAnchor(anchor.position, anchor.axis, fields);
      anchor.position = moved.position;
      anchor.axis = moved.axis;
    }
  }

  const sp = outlineSpan(outline);
  // recorded even at zero height: the vein wires of an enamelled leaf are drawn from the same field
  const relief: PlateRelief = { height: fields.relief, veins: fields.reliefVeins, length: spec.length, halfWidth: fields.halfWidth, droop, span: [sp.minX, sp.minY, sp.width, sp.height] };
  return { name: spec.name ?? 'leaf', mesh, bounds: meshBounds(mesh), anchors, enamel: spec.enamel, relief, veinMetal: spec.veinMetal };
}

const halfWidthAt = (width: number, t: number) =>
  (width / 2) * Math.pow(Math.sin(Math.PI * Math.min(Math.max(t, 0), 1)), 0.75) * (1 - 0.3 * t);

/**
 * Slide the rivet boss along the leaf until there is metal all round it.
 *
 * A leaf narrows to nothing at its base, and the bevel insets the cap outline
 * while growing the piercing, so a hole placed by eye near the stem breaks
 * through the edge on the faces but not on the walls — a cap that no longer
 * matches its own outline. Solving for the position removes the whole class.
 */
function bossPosition(length: number, width: number, bore: number, wall: number): number {
  const need = bore + wall;
  const back = bore / length;
  for (let t = 0.02; t < 0.6; t += 0.004) {
    if (halfWidthAt(width, t - back) >= need && halfWidthAt(width, t) >= need) {
      return t;
    }
  }
  return 0.35;
}
