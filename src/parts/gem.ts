import { scaledCount } from '../mesh/detail';
import type { Vec2, Vec3 } from '../geom/types';
import { MeshBuilder, type Mesh } from '../mesh/types';
import { revolve } from '../mesh/revolve';
import { meshBounds, type Anchor, type Part } from './types';

/**
 * Every cut, as the language names it: one word each. The brilliants first,
 * then the step cuts, then the rest.
 */
export const GEM_CUTS = [
  'brilliant', 'oval', 'pear', 'marquise', 'heart', 'trillion', 'cushion', 'princess', 'radiant',
  'oldEuropean', 'oldMine', 'eight', 'swiss',
  'step', 'asscher', 'baguette', 'tapered', 'carre', 'tableCut', 'french',
  'hexagon', 'octagon', 'kite', 'lozenge', 'shield', 'halfMoon', 'bullet',
  'rose', 'doubleRose', 'briolette', 'checkerboard', 'cabochon', 'doubleCabochon',
] as const;
export type GemCut = (typeof GEM_CUTS)[number];

export interface GemSpec {
  name?: string;
  /** Which cut. The outline and the tiers of facets both come from it. */
  cut?: GemCut;
  /** Girdle width across the stone. */
  width: number;
  /** Length along the stone. Defaults to the cut's own proportion of the width. */
  length?: number;
  /** Total depth, table to culet. Defaults to the cut's own; anything else squashes it. */
  depth?: number;
  /** Facets around the girdle. The step cuts take theirs from their outline instead. */
  facets?: number;
  /** Table width as a fraction of the girdle. */
  table?: number;
  segments?: number;
  /**
   * The brilliant's own proportions, for the round and the oval, which are
   * built from the trade's facet layout rather than from tiers. Angles in
   * degrees from the girdle plane; the lengths are the trade's ratios.
   */
  /** The bezel facets' angle. Tolkowsky's is 34.5. */
  crownAngle?: number;
  /** The pavilion mains' angle. 40.75 is the modern ideal. */
  pavilionAngle?: number;
  /** How far the star facets reach from the table edge toward the girdle, of the way. */
  star?: number;
  /** How far the lower-girdle facets reach from the girdle toward the culet, of the way. */
  lowerHalf?: number;
  /** Culet width as a fraction of the girdle width; 0 is a point. */
  culet?: number;
}

/**
 * A cut stone.
 *
 * Every facet is flat, and that is the whole point: a gem is read by the way
 * adjacent facets return quite different things at once, so a vertex normal
 * shared between two of them would turn the stone to soap. Each facet is
 * therefore emitted with its own vertices and its own normal, and the cost of
 * that — a few hundred triangles — is what a stone is worth.
 *
 * The cuts are built from two ingredients: an outline at the girdle, and a
 * stack of tiers that scale it and lift it. Where consecutive tiers share a
 * phase the band between them comes out as quadrilateral step facets; where
 * they are offset by half a step it comes out as the zigzag of triangles that
 * makes a brilliant a brilliant. Everything else is proportions.
 *
 * The origin is the girdle plane and `seat` points up through the crown, so a
 * stone seats into a setting exactly as a rivet seats into a plate.
 */
export function gem(spec: GemSpec): Part {
  const cut = spec.cut ?? 'brilliant';
  const p = CUTS[cut];

  const halfW = spec.width / 2;
  const halfL = (spec.length ?? spec.width * p.ratio) / 2;

  // the cut's own depth, unless one was asked for; the girdle stays thin either way
  const girdleT = p.girdle * spec.width;
  const natural = (p.crown + p.pavilion) * spec.width;
  const squash = natural > 0 ? Math.max(((spec.depth ?? (natural + girdleT)) - girdleT) / natural, 0.05) : 1;
  const crown = p.crown * spec.width * squash;
  const pavilion = p.pavilion * spec.width * squash;
  const table = spec.table ?? p.table;

  const planes: number[] = [];
  let mesh: Mesh;
  let top = crown, bottom = -pavilion;
  let mains = p.mains;
  if (p.style === 'cabochon') {
    mesh = cabochon(halfW, crown, scaledCount(spec.segments ?? 40));
  } else if (p.style === 'lens') {
    mesh = lens(halfW, crown, scaledCount(spec.segments ?? 40));
    bottom = -crown;
  } else if (p.style === 'briolette') {
    // a drop hangs: its length is its height, and it is round about that axis
    const height = spec.length ?? spec.width * p.ratio;
    mesh = faceted(cut, p, halfW, halfW, height / 2, height / 2, 0, 0, spec.facets, planes);
    top = height / 2; bottom = -height / 2;
  } else if (p.style === 'layout') {
    // the trade's layout, at the cut's own depth unless one was asked for:
    // a depth squashes the angles, as it squashes the tiers of the others
    const b = brilliant(halfL, halfW, {
      table, girdle: p.girdle, squash,
      mains: Math.max(3, Math.round((spec.facets ?? p.facets) / 2)),
      crownAngle: spec.crownAngle ?? 34.5, pavilionAngle: spec.pavilionAngle ?? 40.75,
      star: spec.star ?? 0.5, lowerHalf: spec.lowerHalf ?? 0.78, culet: spec.culet ?? 0,
    }, planes);
    mesh = b.mesh; top = b.top; bottom = b.bottom; mains = b.mains;
  } else {
    mesh = faceted(cut, p, halfL, halfW, crown, pavilion, girdleT, table, spec.facets, planes);
  }

  const anchors: Anchor[] = [
    // first, so fastening a stone to a mount seats it by its girdle
    { name: 'seat', position: [0, 0, 0], axis: [0, 0, 1], tangent: [1, 0, 0] },
    { name: 'table', position: [0, 0, top], axis: [0, 0, 1], tangent: [1, 0, 0] },
    { name: 'culet', position: [0, 0, bottom], axis: [0, 0, -1], tangent: [1, 0, 0] },
  ];
  // solder wets metal; a stone is held, not joined
  return {
    name: spec.name ?? cut, mesh, bounds: meshBounds(mesh), anchors,
    solderable: false, pavilionFacets: mains,
    // every facet as a plane, for the shader to trace light through the stone;
    // a cabochon's dome is no facet and keeps the folded-room approximation
    gemPlanes: planes.length ? new Float32Array(planes) : undefined,
    gemSize: spec.width,
  };
}

/** How the girdle is drawn: a curve sampled round, or a polygon whose corners are the corners. */
type OutlineKind =
  | 'round' | 'pear' | 'marquise' | 'trillion' | 'heart' | 'cushion'
  | 'rectangle' | 'square8' | 'hexagon' | 'kite' | 'lozenge' | 'shield' | 'halfMoon' | 'trapezoid' | 'bullet';

/** Which stack of tiers is put over the outline; see `tiersOf`. */
type Style =
  | 'layout' | 'brilliant' | 'old' | 'eight' | 'princess'
  | 'step' | 'asscher' | 'baguette' | 'tableCut' | 'french'
  | 'rose' | 'doubleRose' | 'briolette' | 'checkerboard' | 'cabochon' | 'lens';

interface Proportions {
  outline: OutlineKind;
  style: Style;
  /** All as fractions of the girdle width. */
  table: number;
  crown: number;
  pavilion: number;
  girdle: number;
  facets: number;
  /** Length over width. */
  ratio: number;
  /**
   * Facets round the pavilion. The shader gives the light one of these to
   * bounce off, so a step cut's four break its table into quarters where a
   * brilliant's eight break it into a rosette.
   */
  mains: number;
  /** For a rectangle: how much of the shorter half-side each corner is cut off by. */
  corner?: number;
}

const CUTS: Record<GemCut, Proportions> = {
  // the round and the oval are built from the trade's layout (see `brilliant`
  // below); their crown and pavilion here are what Tolkowsky's angles give
  // over a 56 % table, and set the depth a `depth` is squashed against
  brilliant: { outline: 'round', style: 'layout', table: 0.56, crown: 0.151, pavilion: 0.431, girdle: 0.03, facets: 16, ratio: 1, mains: 8 },
  oval: { outline: 'round', style: 'layout', table: 0.56, crown: 0.151, pavilion: 0.431, girdle: 0.03, facets: 16, ratio: 1.4, mains: 8 },
  // the fancy outlines: the brilliant's tiers over a curve
  pear: { outline: 'pear', style: 'brilliant', table: 0.56, crown: 0.15, pavilion: 0.42, girdle: 0.03, facets: 16, ratio: 1.5, mains: 8 },
  marquise: { outline: 'marquise', style: 'brilliant', table: 0.55, crown: 0.14, pavilion: 0.40, girdle: 0.03, facets: 16, ratio: 2.0, mains: 8 },
  heart: { outline: 'heart', style: 'brilliant', table: 0.56, crown: 0.15, pavilion: 0.42, girdle: 0.03, facets: 16, ratio: 1.0, mains: 8 },
  trillion: { outline: 'trillion', style: 'brilliant', table: 0.58, crown: 0.15, pavilion: 0.40, girdle: 0.03, facets: 18, ratio: 1, mains: 6 },
  cushion: { outline: 'cushion', style: 'brilliant', table: 0.58, crown: 0.14, pavilion: 0.45, girdle: 0.03, facets: 16, ratio: 1.1, mains: 8 },
  // the square brilliants: chevrons under a bevelled crown
  princess: { outline: 'square8', style: 'princess', table: 0.68, crown: 0.11, pavilion: 0.60, girdle: 0.03, facets: 8, ratio: 1, mains: 4 },
  radiant: { outline: 'rectangle', style: 'princess', table: 0.64, crown: 0.13, pavilion: 0.52, girdle: 0.03, facets: 8, ratio: 1.25, mains: 4, corner: 0.22 },
  // the old cuts: a small table, a high crown, an open culet
  oldEuropean: { outline: 'round', style: 'old', table: 0.42, crown: 0.19, pavilion: 0.45, girdle: 0.03, facets: 16, ratio: 1, mains: 8 },
  oldMine: { outline: 'cushion', style: 'old', table: 0.40, crown: 0.20, pavilion: 0.46, girdle: 0.03, facets: 16, ratio: 1.05, mains: 8 },
  eight: { outline: 'round', style: 'eight', table: 0.55, crown: 0.14, pavilion: 0.43, girdle: 0.03, facets: 8, ratio: 1, mains: 8 },
  swiss: { outline: 'round', style: 'brilliant', table: 0.55, crown: 0.15, pavilion: 0.43, girdle: 0.03, facets: 8, ratio: 1, mains: 8 },
  // the step cuts: rows round a rectangle, and the shapes cut in rows
  step: { outline: 'rectangle', style: 'step', table: 0.62, crown: 0.14, pavilion: 0.45, girdle: 0.03, facets: 8, ratio: 1.35, mains: 4, corner: 0.26 },
  asscher: { outline: 'rectangle', style: 'asscher', table: 0.58, crown: 0.16, pavilion: 0.50, girdle: 0.03, facets: 8, ratio: 1, mains: 4, corner: 0.32 },
  baguette: { outline: 'rectangle', style: 'baguette', table: 0.72, crown: 0.10, pavilion: 0.34, girdle: 0.03, facets: 4, ratio: 2.2, mains: 4, corner: 0 },
  tapered: { outline: 'trapezoid', style: 'baguette', table: 0.70, crown: 0.10, pavilion: 0.34, girdle: 0.03, facets: 4, ratio: 2.0, mains: 4 },
  carre: { outline: 'rectangle', style: 'step', table: 0.60, crown: 0.14, pavilion: 0.46, girdle: 0.03, facets: 4, ratio: 1, mains: 4, corner: 0 },
  tableCut: { outline: 'rectangle', style: 'tableCut', table: 0.62, crown: 0.16, pavilion: 0.44, girdle: 0.03, facets: 4, ratio: 1, mains: 4, corner: 0.12 },
  french: { outline: 'rectangle', style: 'french', table: 0.50, crown: 0.20, pavilion: 0.45, girdle: 0.03, facets: 4, ratio: 1, mains: 4, corner: 0 },
  hexagon: { outline: 'hexagon', style: 'step', table: 0.60, crown: 0.14, pavilion: 0.45, girdle: 0.03, facets: 6, ratio: 1.15, mains: 6 },
  octagon: { outline: 'rectangle', style: 'step', table: 0.60, crown: 0.14, pavilion: 0.45, girdle: 0.03, facets: 8, ratio: 1, mains: 8, corner: 0.586 },
  kite: { outline: 'kite', style: 'step', table: 0.55, crown: 0.14, pavilion: 0.42, girdle: 0.03, facets: 4, ratio: 1.6, mains: 4 },
  lozenge: { outline: 'lozenge', style: 'step', table: 0.55, crown: 0.14, pavilion: 0.42, girdle: 0.03, facets: 4, ratio: 1.5, mains: 4 },
  shield: { outline: 'shield', style: 'step', table: 0.58, crown: 0.14, pavilion: 0.42, girdle: 0.03, facets: 5, ratio: 1.3, mains: 5 },
  halfMoon: { outline: 'halfMoon', style: 'step', table: 0.58, crown: 0.13, pavilion: 0.40, girdle: 0.03, facets: 10, ratio: 0.55, mains: 5 },
  bullet: { outline: 'bullet', style: 'step', table: 0.58, crown: 0.13, pavilion: 0.42, girdle: 0.03, facets: 5, ratio: 1.8, mains: 5 },
  // no pavilion, or no table, or no facets
  rose: { outline: 'round', style: 'rose', table: 0, crown: 0.34, pavilion: 0, girdle: 0, facets: 12, ratio: 1, mains: 8 },
  doubleRose: { outline: 'round', style: 'doubleRose', table: 0, crown: 0.30, pavilion: 0.30, girdle: 0, facets: 12, ratio: 1, mains: 8 },
  briolette: { outline: 'round', style: 'briolette', table: 0, crown: 0.9, pavilion: 0.9, girdle: 0, facets: 12, ratio: 1.8, mains: 8 },
  checkerboard: { outline: 'cushion', style: 'checkerboard', table: 0.25, crown: 0.22, pavilion: 0.42, girdle: 0.03, facets: 12, ratio: 1.1, mains: 8 },
  cabochon: { outline: 'round', style: 'cabochon', table: 0, crown: 0.42, pavilion: 0, girdle: 0, facets: 0, ratio: 1, mains: 24 },
  doubleCabochon: { outline: 'round', style: 'lens', table: 0, crown: 0.3, pavilion: 0.3, girdle: 0, facets: 0, ratio: 1, mains: 24 },
};

/** One tier of the stone: the outline scaled and lifted, and how far it is turned. */
interface Tier {
  /** 0 collapses the tier to a point — a culet or an apex. */
  scale: number;
  z: number;
  /** In steps around the outline. A half step is what makes triangular facets. */
  phase: number;
}

function tiersOf(style: Style, crown: number, pavilion: number, girdleT: number, table: number): Tier[] {
  const g = girdleT / 2;
  switch (style) {
    case 'step':
      return [
        { scale: 0.22, z: -pavilion, phase: 0 },
        { scale: 0.60, z: -pavilion * 0.60, phase: 0 },
        { scale: 0.86, z: -pavilion * 0.26, phase: 0 },
        { scale: 1, z: -g, phase: 0 },
        { scale: 1, z: g, phase: 0 },
        { scale: 0.88, z: crown * 0.52, phase: 0 },
        { scale: table, z: crown, phase: 0 },
      ];
    case 'asscher':
      // three rows each side and a high crown: the windmill seen through the table
      return [
        { scale: 0.18, z: -pavilion, phase: 0 },
        { scale: 0.50, z: -pavilion * 0.66, phase: 0 },
        { scale: 0.80, z: -pavilion * 0.30, phase: 0 },
        { scale: 1, z: -g, phase: 0 },
        { scale: 1, z: g, phase: 0 },
        { scale: 0.90, z: crown * 0.36, phase: 0 },
        { scale: 0.76, z: crown * 0.72, phase: 0 },
        { scale: table, z: crown, phase: 0 },
      ];
    case 'baguette':
      return [
        { scale: 0.34, z: -pavilion, phase: 0 },
        { scale: 0.78, z: -pavilion * 0.45, phase: 0 },
        { scale: 1, z: -g, phase: 0 },
        { scale: 1, z: g, phase: 0 },
        { scale: table, z: crown, phase: 0 },
      ];
    case 'tableCut':
      // the oldest faceting: one bevel to a table, one to a flat back
      return [
        { scale: 0.45, z: -pavilion, phase: 0 },
        { scale: 1, z: -g, phase: 0 },
        { scale: 1, z: g, phase: 0 },
        { scale: table, z: crown, phase: 0 },
      ];
    case 'french':
      // the table turned through half a step: four triangles rise to each of its edges
      return [
        { scale: 0, z: -pavilion, phase: 0 },
        { scale: 1, z: -g, phase: 0 },
        { scale: 1, z: g, phase: 0 },
        { scale: table, z: crown, phase: 0.5 },
      ];
    case 'eight':
      // a single cut: eight facets over, eight under, and the table
      return [
        { scale: 0, z: -pavilion, phase: 0 },
        { scale: 1, z: -g, phase: 0 },
        { scale: 1, z: g, phase: 0 },
        { scale: table, z: crown, phase: 0 },
      ];
    case 'old':
      // the old cuts: a culet you can see, and the crown's break high and steep
      return [
        { scale: 0.10, z: -pavilion, phase: 0 },
        { scale: 0.55, z: -pavilion * 0.45, phase: 0.5 },
        { scale: 1, z: -g, phase: 0 },
        { scale: 1, z: g, phase: 0 },
        { scale: 0.74, z: crown * 0.5, phase: 0.5 },
        { scale: table, z: crown, phase: 0 },
      ];
    case 'princess':
      // chevrons: the pavilion's tiers turned half a step against a square
      return [
        { scale: 0, z: -pavilion, phase: 0 },
        { scale: 0.42, z: -pavilion * 0.55, phase: 0.5 },
        { scale: 1, z: -g, phase: 0 },
        { scale: 1, z: g, phase: 0 },
        { scale: table, z: crown, phase: 0 },
      ];
    case 'rose':
      // no pavilion at all: a flat back, and a dome of triangles over it
      return [
        { scale: 1, z: 0, phase: 0 },
        { scale: 0.58, z: crown * 0.5, phase: 0.5 },
        { scale: 0, z: crown, phase: 0 },
      ];
    case 'doubleRose':
      return [
        { scale: 0, z: -pavilion, phase: 0 },
        { scale: 0.58, z: -pavilion * 0.5, phase: 0.5 },
        { scale: 1, z: 0, phase: 0 },
        { scale: 0.58, z: crown * 0.5, phase: 0.5 },
        { scale: 0, z: crown, phase: 0 },
      ];
    case 'briolette':
      // a drop: rings of triangles from the rounded end to the point, no girdle and no table
      // the widest ring on the whole step, so the drop is the width it was asked for
      return [
        { scale: 0, z: -pavilion, phase: 0 },
        { scale: 0.55, z: -pavilion * 0.78, phase: 0 },
        { scale: 0.88, z: -pavilion * 0.42, phase: 0.5 },
        { scale: 1, z: -pavilion * 0.05, phase: 0 },
        { scale: 0.92, z: crown * 0.28, phase: 0.5 },
        { scale: 0.70, z: crown * 0.56, phase: 0 },
        { scale: 0.40, z: crown * 0.80, phase: 0.5 },
        { scale: 0, z: crown, phase: 0 },
      ];
    case 'checkerboard':
      // steps under, and over the girdle rows turned against each other to a small table
      return [
        { scale: 0.30, z: -pavilion, phase: 0 },
        { scale: 0.68, z: -pavilion * 0.5, phase: 0 },
        { scale: 1, z: -g, phase: 0 },
        { scale: 1, z: g, phase: 0 },
        { scale: 0.86, z: crown * 0.32, phase: 0.5 },
        { scale: 0.68, z: crown * 0.62, phase: 0 },
        { scale: 0.46, z: crown * 0.86, phase: 0.5 },
        { scale: table, z: crown, phase: 0 },
      ];
    default:
      // the brilliant, and the outlines that borrow its tiers
      return [
        { scale: 0, z: -pavilion, phase: 0 },
        { scale: 0.52, z: -pavilion * 0.45, phase: 0.5 },
        { scale: 1, z: -g, phase: 0 },
        { scale: 1, z: g, phase: 0 },
        { scale: 0.80, z: crown * 0.45, phase: 0.5 },
        { scale: table, z: crown, phase: 0 },
      ];
  }
}

/** The widest the teardrop curve gets, so a pear comes out the width it was asked for. */
const PEAR_PEAK = 0.7698;
/** The widest the heart curve gets, and how far its centre sits from the cleft, so a heart comes out the size it was asked for. */
const HEART_PEAK = 16;
const HEART_SPAN: [number, number] = [-17, 12];

/** A point on a curved outline at parameter t round it, in units of the half-width and half-length. */
function curvePoint(kind: OutlineKind, t: number, halfL: number, halfW: number): Vec2 {
  const c = Math.cos(t), sn = Math.sin(t);
  switch (kind) {
    case 'marquise':
      // both ends drawn to a point: the exponent flattens the curve into a cusp
      return [halfL * c, halfW * Math.sign(sn) * Math.pow(Math.abs(sn), 1.6)];
    case 'pear':
      // The teardrop curve: a cusp at one end and a full round shoulder at
      // the other, widest about a third of the way back from the point,
      // which is what separates a pear from an oval with one end pinched.
      return [halfL * c, halfW * sn * Math.sin(t / 2) / PEAR_PEAK];
    case 'trillion': {
      const r = 1 / (1 + 0.24 * Math.cos(3 * t));
      return [halfL * c * r, halfW * sn * r];
    }
    case 'heart': {
      // the classic heart, its point along +x and its cleft along -x, scaled to the box asked for
      const hx = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      const hy = 16 * Math.pow(Math.sin(t), 3);
      const x = ((hx - HEART_SPAN[0]) / (HEART_SPAN[1] - HEART_SPAN[0])) * 2 - 1;
      return [x * halfL, (hy / HEART_PEAK) * halfW];
    }
    case 'cushion': {
      // a superellipse: a square with its corners rounded to a pillow
      const n = 2.7;
      return [halfL * Math.sign(c) * Math.pow(Math.abs(c), 2 / n), halfW * Math.sign(sn) * Math.pow(Math.abs(sn), 2 / n)];
    }
    default:
      return [halfL * c, halfW * sn];
  }
}

/** The corners of a straight-sided outline, or null for a curve. */
function polygonOutline(kind: OutlineKind, halfL: number, halfW: number, corner = 0): Vec2[] | null {
  switch (kind) {
    case 'rectangle': {
      const c = Math.min(halfL, halfW) * corner;
      if (c <= 0) return [[halfL, -halfW], [halfL, halfW], [-halfL, halfW], [-halfL, -halfW]];
      return [
        [halfL - c, -halfW], [halfL, -halfW + c], [halfL, halfW - c], [halfL - c, halfW],
        [-halfL + c, halfW], [-halfL, halfW - c], [-halfL, -halfW + c], [-halfL + c, -halfW],
      ];
    }
    case 'square8':
      // a square with its sides' midpoints as corners too, so the chevrons have somewhere to meet
      return [[halfL, 0], [halfL, halfW], [0, halfW], [-halfL, halfW], [-halfL, 0], [-halfL, -halfW], [0, -halfW], [halfL, -halfW]];
    case 'hexagon':
      return [[halfL, 0], [halfL / 2, halfW], [-halfL / 2, halfW], [-halfL, 0], [-halfL / 2, -halfW], [halfL / 2, -halfW]];
    case 'kite':
      return [[halfL, 0], [-halfL * 0.2, halfW], [-halfL, 0], [-halfL * 0.2, -halfW]];
    case 'lozenge':
      return [[halfL, 0], [0, halfW], [-halfL, 0], [0, -halfW]];
    case 'shield':
      return [[halfL, -halfW * 0.85], [halfL, halfW * 0.85], [0, halfW], [-halfL, 0], [0, -halfW]];
    case 'halfMoon': {
      // a chord along the width and an arc bulging to the length
      const pts: Vec2[] = [];
      for (let i = 0; i <= 8; i++) {
        const t = -Math.PI / 2 + (i / 8) * Math.PI;
        pts.push([-halfL + 2 * halfL * Math.cos(t), halfW * Math.sin(t)]);
      }
      return pts;
    }
    case 'trapezoid':
      return [[halfL, -halfW * 0.6], [halfL, halfW * 0.6], [-halfL, halfW], [-halfL, -halfW]];
    case 'bullet':
      return [[halfL, 0], [halfL * 0.35, halfW], [-halfL, halfW], [-halfL, -halfW], [halfL * 0.35, -halfW]];
    default:
      return null;
  }
}

/**
 * The girdle outline, sampled at `n` points, turned by `phase` steps.
 *
 * A straight-sided outline returns its corners instead and ignores `n`,
 * because a rectangle's facets are its corners: sampling it would round
 * them off. A half-step phase on one takes the midpoints of its sides,
 * which is what an antiprism band needs to meet.
 */
function girdleOutline(kind: OutlineKind, n: number, halfL: number, halfW: number, phase: number, corner = 0): Vec2[] {
  const poly = polygonOutline(kind, halfL, halfW, corner);
  if (poly) {
    if (phase < 1e-6) return poly;
    return poly.map((p, i) => { const q = poly[(i + 1) % poly.length]; return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] as Vec2; });
  }
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) pts.push(curvePoint(kind, ((i + phase) / n) * Math.PI * 2, halfL, halfW));
  return pts;
}

interface BrilliantSpec {
  /** Table vertex radius, as a fraction of the girdle radius. */
  table: number;
  /** Half the girdle thickness, as a fraction of the girdle radius. */
  girdle: number;
  /** What a `depth` asks: 1 leaves the angles as given. */
  squash: number;
  mains: number;
  crownAngle: number;
  pavilionAngle: number;
  star: number;
  lowerHalf: number;
  culet: number;
}

/**
 * The round brilliant as the trade cuts it, and the oval as its stretch.
 *
 * Eight-fold, ordinarily: a table with a vertex toward each main, a star
 * facet on each table edge, a bezel (kite) under each vertex reaching the
 * girdle, and a pair of upper-girdle facets between each two bezels; then,
 * under the girdle, a pair of lower-girdle facets between each two pavilion
 * mains, and the mains meeting at the culet. Fifty-seven facets, fifty-eight
 * with a culet, and sixteen more round the girdle.
 *
 * What fixes it is not tiers but two planes and four ratios. The bezel's
 * plane is set by the crown angle through the girdle edge and the table
 * vertex; the star's tip sits on that plane at the star length, and so do
 * the upper halves' apexes, which is why a bezel is a kite and not a fan.
 * The main's plane is set the same way by the pavilion angle through the
 * girdle and the culet, and the lower halves' meeting points lie on it at
 * the lower-half length. Everything is laid out on a circle of the girdle's
 * half-width and then scaled along the length: an ellipse is the circle's
 * affine image, so every facet stays a plane, which is what an oval is.
 */
function brilliant(halfL: number, halfW: number, b: BrilliantSpec, planes: number[]): { mesh: Mesh; top: number; bottom: number; mains: number } {
  const m = b.mains;
  const step = Math.PI / m;                // half a main: the azimuth of a star tip or an upper-half apex
  const g = b.girdle;
  const rt = Math.min(Math.max(b.table, 0.05), 0.95);
  const rc = Math.min(Math.max(b.culet, 0), 0.9);
  const tanA = Math.tan((b.crownAngle * Math.PI) / 180) * b.squash;
  const tanB = Math.tan((b.pavilionAngle * Math.PI) / 180) * b.squash;
  const hc = (1 - rt) * tanA;              // crown height over the girdle's top
  // a point, in unit-circle terms, placed on the stone: x along the length, y across the width
  const at = (r: number, theta: number, z: number): Vec3 => [r * Math.cos(theta) * halfL, r * Math.sin(theta) * halfW, z * halfW];
  // heights on the bezel's and the main's planes, by projection onto their axes
  const onBezel = (rho: number) => g + hc - (rho - rt) * tanA;
  const onMain = (rho: number) => -g - (1 - rho) * tanB;
  const cosHalf = Math.cos(step);
  const rs = Math.min(rt * cosHalf + b.star * (1 - rt * cosHalf), 0.98);
  const rl = Math.max(1 - b.lowerHalf * (1 - rc), rc + 0.02);
  const zs = onBezel(rs * cosHalf);
  const zl = onMain(rl * cosHalf);
  const zc = onMain(rc);

  const mb = new MeshBuilder();
  const minZ = zc, span = Math.max(g + hc - zc, 1e-6);
  const uvOf = (q: Vec3): Vec2 => [Math.atan2(q[1], q[0]) / (Math.PI * 2) + 0.5, (q[2] * (1 / halfW) - minZ) / span];
  const record = (normal: Vec3, point: Vec3) => {
    const d = normal[0] * point[0] + normal[1] * point[1] + normal[2] * point[2];
    for (let i = 0; i < planes.length; i += 4) {
      if (Math.abs(planes[i] - normal[0]) < 1e-5 && Math.abs(planes[i + 1] - normal[1]) < 1e-5 && Math.abs(planes[i + 2] - normal[2]) < 1e-5 && Math.abs(planes[i + 3] - d) < 1e-4) return;
    }
    planes.push(normal[0], normal[1], normal[2], d);
  };
  const emit = (pts: Vec3[], outward?: Vec3) => facet(mb, pts, uvOf, outward, record);

  const tableRing: Vec3[] = [];
  for (let k = 0; k < m; k++) {
    const t0 = k * 2 * step, t1 = (k + 1) * 2 * step, th = t0 + step;
    const T0 = at(rt, t0, g + hc), T1 = at(rt, t1, g + hc);
    const S = at(rs, th, zs), Sprev = at(rs, t0 - step, zs);
    const G0 = at(1, t0, g), Gh = at(1, th, g), G1 = at(1, t1, g);
    tableRing.push(T0);
    emit([T0, T1, S]);                    // star
    emit([T0, S, G0, Sprev]);             // bezel: a kite on its plane
    emit([S, G0, Gh]); emit([S, Gh, G1]); // upper-girdle facets
    // the girdle, two facets a main
    const B0 = at(1, t0, -g), Bh = at(1, th, -g), B1 = at(1, t1, -g);
    emit([G0, Gh, Bh, B0]); emit([Gh, G1, B1, Bh]);
    // the pavilion
    const L = at(rl, th, zl), Lprev = at(rl, t0 - step, zl);
    const C = at(rc, t0, zc);
    emit([B0, L, C, Lprev]);              // main: a kite on its plane, to the culet
    emit([L, B0, Bh]); emit([L, Bh, B1]); // lower-girdle facets
  }
  emit(tableRing, [0, 0, 1]);
  if (rc > 0) {
    const culet: Vec3[] = [];
    for (let k = m - 1; k >= 0; k--) culet.push(at(rc, k * 2 * step, zc));
    emit(culet, [0, 0, -1]);
  }
  return { mesh: mb.build(), top: (g + hc) * halfW, bottom: zc * halfW, mains: m };
}

function faceted(
  _cut: GemCut, p: Proportions,
  halfL: number, halfW: number,
  crown: number, pavilion: number, girdleT: number, table: number,
  requested: number | undefined,
  planes: number[] = [],
): Mesh {
  const polygon = polygonOutline(p.outline, halfL, halfW, p.corner ?? 0);
  const n = polygon ? polygon.length : Math.max(4, Math.round((requested ?? p.facets) / 2) * 2);
  const tiers = tiersOf(p.style, crown, pavilion, girdleT, table);
  const mb = new MeshBuilder();

  const minZ = tiers[0].z;
  const span = Math.max(tiers[tiers.length - 1].z - minZ, 1e-6);
  const uvOf = (q: Vec3): Vec2 => [Math.atan2(q[1], q[0]) / (Math.PI * 2) + 0.5, (q[2] - minZ) / span];

  const ringOf = (t: Tier): Vec3[] | null => {
    if (t.scale < 1e-6) return null;
    return girdleOutline(p.outline, n, halfL, halfW, t.phase, p.corner ?? 0).map(([x, y]) => [x * t.scale, y * t.scale, t.z] as Vec3);
  };
  const rings = tiers.map(ringOf);
  const record = (normal: Vec3, point: Vec3) => {
    // one plane per facet: normal and offset, so n·x = d on it and n·x < d inside
    const d = normal[0] * point[0] + normal[1] * point[1] + normal[2] * point[2];
    for (let i = 0; i < planes.length; i += 4) {
      if (Math.abs(planes[i] - normal[0]) < 1e-5 && Math.abs(planes[i + 1] - normal[1]) < 1e-5 && Math.abs(planes[i + 2] - normal[2]) < 1e-5 && Math.abs(planes[i + 3] - d) < 1e-4) return;
    }
    planes.push(normal[0], normal[1], normal[2], d);
  };

  for (let k = 0; k + 1 < tiers.length; k++) {
    const a = rings[k], b = rings[k + 1];
    if (!a && b) {
      const apex: Vec3 = [0, 0, tiers[k].z];
      for (let i = 0; i < b.length; i++) facet(mb, [apex, b[(i + 1) % b.length], b[i]], uvOf, undefined, record);
    } else if (a && !b) {
      const apex: Vec3 = [0, 0, tiers[k + 1].z];
      for (let i = 0; i < a.length; i++) facet(mb, [apex, a[i], a[(i + 1) % a.length]], uvOf, undefined, record);
    } else if (a && b) {
      const offset = Math.abs(tiers[k + 1].phase - tiers[k].phase) > 1e-6;
      for (let i = 0; i < a.length; i++) {
        const j = (i + 1) % a.length;
        if (offset) {
          // an antiprism band: b[i] sits between a[i] and a[j], so the band
          // tiles as alternating triangles pointing up and down
          facet(mb, [a[i], a[j], b[i]], uvOf, undefined, record);
          facet(mb, [b[i], b[j], a[j]], uvOf, undefined, record);
        } else {
          facet(mb, [a[i], a[j], b[j], b[i]], uvOf, undefined, record);
        }
      }
    }
  }

  // the table, and the flat back of a cut that has one
  const top = rings[rings.length - 1];
  if (top) facet(mb, top, uvOf, [0, 0, 1], record);
  const bottom = rings[0];
  if (bottom) facet(mb, [...bottom].reverse(), uvOf, [0, 0, -1], record);

  return mb.build();
}

/**
 * One flat facet, wound so its normal points out of the stone.
 *
 * The winding is checked rather than trusted: the tiers are built by several
 * different rules and a facet that came out inside-out would read as a hole in
 * the stone. `outward` is the direction the facet ought to face; for a side
 * facet that is simply away from the axis.
 */
function facet(mb: MeshBuilder, pts: Vec3[], uvOf: (p: Vec3) => Vec2, outward?: Vec3, onPlane?: (normal: Vec3, point: Vec3) => void) {
  // Newell's normal, which is right for a polygon that is only nearly planar
  let nx = 0, ny = 0, nz = 0;
  let cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
    cx += a[0]; cy += a[1];
  }
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-12) return;   // a sliver with no area: nothing to draw
  let normal: Vec3 = [nx / len, ny / len, nz / len];

  const hint = outward ?? radial(cx / pts.length, cy / pts.length);
  let order = pts;
  if (normal[0] * hint[0] + normal[1] * hint[1] + normal[2] * hint[2] < 0) {
    normal = [-normal[0], -normal[1], -normal[2]];
    order = [...pts].reverse();
  }

  onPlane?.(normal, order[0]);
  const base = mb.vertexCount;
  for (const q of order) {
    const [u, v] = uvOf(q);
    mb.vertex(q[0], q[1], q[2], normal[0], normal[1], normal[2], u, v);
  }
  for (let i = 1; i + 1 < order.length; i++) mb.triangle(base, base + i, base + i + 1);
}

function radial(x: number, y: number): Vec3 {
  const l = Math.hypot(x, y);
  return l < 1e-9 ? [0, 0, 1] : [x / l, y / l, 0];
}

/** A double cabochon: a lens, domed both sides, sharp only at its equator. */
function lens(radius: number, height: number, segments: number): Mesh {
  const rows = 16;
  const points: Vec2[] = [[0, -height]];
  for (let i = 1; i < 2 * rows; i++) {
    const a = -Math.PI / 2 + (i / (2 * rows)) * Math.PI;
    points.push([radius * Math.cos(a), height * Math.sin(a)]);
  }
  points.push([0, height]);
  const sharp = points.map((_, i) => i === rows);
  return revolve({ points, sharp }, { segments });
}

/** A cabochon: no facets at all, a flat back under a polished dome. */
function cabochon(radius: number, height: number, segments: number): Mesh {
  const rows = 16;
  const points: Vec2[] = [[0, 0]];
  for (let i = 0; i <= rows; i++) {
    const a = (i / rows) * (Math.PI / 2);
    points.push([radius * Math.cos(a), height * Math.sin(a)]);
  }
  // hard only where the dome meets its back, which is a cut edge on a real stone
  const sharp = points.map((_, i) => i === 1);
  return revolve({ points, sharp }, { segments });
}
