import { scaledCount } from '../mesh/detail';
import type { Vec2, Vec3 } from '../geom/types';
import { MeshBuilder, type Mesh } from '../mesh/types';
import { revolve } from '../mesh/revolve';
import { meshBounds, type Anchor, type Part } from './types';

export type GemCut =
  | 'brilliant' | 'oval' | 'pear' | 'marquise' | 'trillion'
  | 'step' | 'baguette' | 'rose' | 'cabochon';

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
  if (cut === 'cabochon') {
    mesh = cabochon(halfW, crown, scaledCount(spec.segments ?? 40));
  } else if (cut === 'brilliant' || cut === 'oval') {
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

interface Proportions {
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
}

const CUTS: Record<GemCut, Proportions> = {
  // the round and the oval are built from the trade's layout (see `brilliant`
  // below); their crown and pavilion here are what Tolkowsky's angles give
  // over a 56 % table, and set the depth a `depth` is squashed against
  brilliant: { table: 0.56, crown: 0.151, pavilion: 0.431, girdle: 0.03, facets: 16, ratio: 1, mains: 8 },
  oval: { table: 0.56, crown: 0.151, pavilion: 0.431, girdle: 0.03, facets: 16, ratio: 1.4, mains: 8 },
  pear: { table: 0.56, crown: 0.15, pavilion: 0.42, girdle: 0.03, facets: 16, ratio: 1.5, mains: 8 },
  marquise: { table: 0.55, crown: 0.14, pavilion: 0.40, girdle: 0.03, facets: 16, ratio: 2.0, mains: 8 },
  trillion: { table: 0.58, crown: 0.15, pavilion: 0.40, girdle: 0.03, facets: 18, ratio: 1, mains: 6 },
  step: { table: 0.62, crown: 0.14, pavilion: 0.45, girdle: 0.03, facets: 8, ratio: 1.35, mains: 4 },
  baguette: { table: 0.72, crown: 0.10, pavilion: 0.34, girdle: 0.03, facets: 4, ratio: 2.2, mains: 4 },
  rose: { table: 0, crown: 0.34, pavilion: 0, girdle: 0, facets: 12, ratio: 1, mains: 8 },
  cabochon: { table: 0, crown: 0.42, pavilion: 0, girdle: 0, facets: 0, ratio: 1, mains: 24 },
};

/** One tier of the stone: the outline scaled and lifted, and how far it is turned. */
interface Tier {
  /** 0 collapses the tier to a point — a culet or an apex. */
  scale: number;
  z: number;
  /** In steps around the outline. A half step is what makes triangular facets. */
  phase: number;
}

function tiersOf(cut: GemCut, crown: number, pavilion: number, girdleT: number, table: number): Tier[] {
  const g = girdleT / 2;
  switch (cut) {
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
    case 'baguette':
      return [
        { scale: 0.34, z: -pavilion, phase: 0 },
        { scale: 0.78, z: -pavilion * 0.45, phase: 0 },
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

/**
 * The girdle outline, sampled at `n` points, turned by `phase` steps.
 *
 * The step cuts return their corners instead and ignore both, because a
 * rectangle's facets are its corners: sampling it would round them off, and a
 * half-step phase would put a facet where the corner should be.
 */
function girdleOutline(cut: GemCut, n: number, halfL: number, halfW: number, phase: number): Vec2[] {
  if (cut === 'step' || cut === 'baguette') {
    const c = cut === 'step' ? Math.min(halfL, halfW) * 0.26 : 0;
    if (c <= 0) return [[halfL, -halfW], [halfL, halfW], [-halfL, halfW], [-halfL, -halfW]];
    return [
      [halfL - c, -halfW], [halfL, -halfW + c], [halfL, halfW - c], [halfL - c, halfW],
      [-halfL + c, halfW], [-halfL, halfW - c], [-halfL, -halfW + c], [-halfL + c, -halfW],
    ];
  }
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const t = ((i + phase) / n) * Math.PI * 2;
    const c = Math.cos(t), s = Math.sin(t);
    switch (cut) {
      case 'marquise':
        // both ends drawn to a point: the exponent flattens the curve into a cusp
        pts.push([halfL * c, halfW * Math.sign(s) * Math.pow(Math.abs(s), 1.6)]);
        break;
      case 'pear':
        // The teardrop curve: a cusp at one end and a full round shoulder at
        // the other, widest about a third of the way back from the point,
        // which is what separates a pear from an oval with one end pinched.
        pts.push([halfL * c, halfW * s * Math.sin(t / 2) / PEAR_PEAK]);
        break;
      case 'trillion': {
        const r = 1 / (1 + 0.24 * Math.cos(3 * t));
        pts.push([halfL * c * r, halfW * s * r]);
        break;
      }
      default:
        pts.push([halfL * c, halfW * s]);
    }
  }
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
  cut: GemCut, p: Proportions,
  halfL: number, halfW: number,
  crown: number, pavilion: number, girdleT: number, table: number,
  requested: number | undefined,
  planes: number[] = [],
): Mesh {
  const n = cut === 'step' || cut === 'baguette'
    ? girdleOutline(cut, 0, halfL, halfW, 0).length
    : Math.max(4, Math.round((requested ?? p.facets) / 2) * 2);
  const tiers = tiersOf(cut, crown, pavilion, girdleT, table);
  const mb = new MeshBuilder();

  const minZ = tiers[0].z;
  const span = Math.max(tiers[tiers.length - 1].z - minZ, 1e-6);
  const uvOf = (q: Vec3): Vec2 => [Math.atan2(q[1], q[0]) / (Math.PI * 2) + 0.5, (q[2] - minZ) / span];

  const ringOf = (t: Tier): Vec3[] | null => {
    if (t.scale < 1e-6) return null;
    return girdleOutline(cut, n, halfL, halfW, t.phase).map(([x, y]) => [x * t.scale, y * t.scale, t.z] as Vec3);
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
