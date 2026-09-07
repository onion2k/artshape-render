import { scaledCount } from '../mesh/detail';
import { detail } from '../mesh/detail';
import {
  clearsOthers, ensureWinding, fitsInside, petalOutline, transformLoop, veinPiercings,
  circleOutline, type PetalEdge, type PetalShape,
} from '../geom/outline';
import { extrude, outlineSpan } from '../mesh/extrude';
import { chordLimit, deform, deformAnchor } from '../mesh/deform';
import { meshBounds, type Anchor, type Part, type PlateRelief } from './types';
import type { Vec2 } from '../geom/types';

export interface PetalSpec {
  name?: string;
  length: number;
  width: number;
  thickness: number;
  /** Silhouette: round, pointed, spoon, strap, lip or quill. */
  shape?: PetalShape;
  /** Margin: entire, toothed, fringed, crenate or notched. */
  edge?: PetalEdge;
  edgeDepth?: number;
  edgeCount?: number;
  bevel?: number;
  /** Angled slots either side of the midline. */
  veins?: number;
  /** Rise of each margin above the midline, in radians. */
  cup?: number;
  /** 0 a smooth cup, 1 a crease down the midline. */
  keel?: number;
  /** Total turn of the midline from claw to apex. Positive lifts the apex. */
  curl?: number;
  /** 1 curves evenly; above 2 the base stays straight and the apex reflexes. */
  curlBias?: number;
  twist?: number;
  /** Waves along the margin, for a frilled petal. */
  ruffle?: number;
  ruffleWaves?: number;
  droop?: number;
  /** Height of chased veins in relief. Defaults to a fifth of the thickness; 0 for a plain plate. */
  relief?: number;
  reliefVeins?: number;
  segments?: number;
  /** Rivet hole at the claw, and the anchor that goes with it. */
  bossBore?: number;
  /** Enamel fired into the top face, by colour name. The bevel stays metal. */
  enamel?: string;
  /** Metal wires along the veins of an enamelled face, by metal name. */
  veinMetal?: string;
}

/**
 * A petal: a cut plate, bent.
 *
 * The bending is the part that matters. A flat petal reads as a cut-out no matter
 * how good its outline is, because the thing the eye uses to tell a flower from a
 * paper flower is the way light runs across a curved surface — a cup catching a
 * highlight along its channel, an apex reflexed away into shadow. All of it is
 * one flat extrusion put through `deform`, so the pierced outline stays a 2D
 * problem and the bevel that draws the edge survives the bend.
 */
export function petal(spec: PetalSpec): Part {
  const segments = scaledCount(spec.segments ?? 72);
  const bevel = spec.bevel ?? Math.min(spec.thickness * 0.3, 0.35);

  const outline = petalOutline(spec.length, spec.width, {
    shape: spec.shape ?? 'round',
    edge: spec.edge ?? 'entire',
    edgeDepth: spec.edgeDepth ?? 0.06,
    edgeCount: spec.edgeCount ?? 0,
    droop: spec.droop ?? 0,
    segments,
  });

  const holes: Vec2[][] = [];
  if (spec.veins) {
    holes.push(...veinPiercings(spec.length, spec.width, spec.veins, {
      droop: spec.droop ?? 0, angle: 0.5, margin: 0.5,
    }));
  }

  const anchors: Anchor[] = [
    { name: 'claw', position: [0, 0, 0], axis: [-1, 0, 0], tangent: [0, 0, 1] },
  ];
  if (spec.bossBore) {
    const r = spec.bossBore / 2;
    const at = spec.length * 0.16;
    holes.push(ensureWinding(transformLoop(circleOutline(r, 16), at, 0), false));
    anchors.push({
      name: 'boss',
      position: [at, 0, spec.thickness / 2],
      axis: [0, 0, 1],
      tangent: [1, 0, 0],
      bore: spec.bossBore,
    });
  }

  const clearance = bevel + spec.thickness * 0.45;
  const fitted: Vec2[][] = [];
  for (const hole of holes) {
    if (fitsInside(hole, outline, clearance) && clearsOthers(hole, fitted, clearance)) {
      fitted.push(hole);
    }
  }

  const fields = {
    curl: spec.curl, curlBias: spec.curlBias,
    cup: spec.cup, keel: spec.keel,
    twist: spec.twist,
    ruffle: spec.ruffle, ruffleWaves: spec.ruffleWaves,
    length: spec.length,
    halfWidth: spec.width / 2,
    origin: 0,
    midline: (x: number) =>
      Math.sin(Math.PI * Math.min(Math.max(x / spec.length, 0), 1)) * (spec.droop ?? 0) * spec.length,
    relief: spec.relief ?? spec.thickness * 0.2,
    reliefVeins: spec.reliefVeins ?? 4,
  };
  // the chord a draft may take is longer by the detail's inverse: half the detail, twice the chord, a quarter of the cap
  const limit = chordLimit(fields, spec.length * 0.004) / detail();
  const mesh = extrude({
    outline, holes: fitted, thickness: spec.thickness, bevel,
    maxCapEdge: Number.isFinite(limit) ? limit : undefined,
    enamelTop: !!spec.enamel,
  });
  deform(mesh, fields);

  // the boss rides with the surface, so its anchor goes through the same fields
  const boss = anchors.find((a) => a.name === 'boss');
  if (boss) {
    const moved = deformAnchor(boss.position, boss.axis, { ...fields, origin: 0 });
    boss.position = moved.position;
    boss.axis = moved.axis;
  }

  const sp = outlineSpan(outline);
  const relief: PlateRelief = { height: fields.relief, veins: fields.reliefVeins, length: spec.length, halfWidth: fields.halfWidth, droop: spec.droop ?? 0, span: [sp.minX, sp.minY, sp.width, sp.height] };
  return { name: spec.name ?? 'petal', mesh, bounds: meshBounds(mesh), anchors, enamel: spec.enamel, relief, veinMetal: spec.veinMetal };
}
