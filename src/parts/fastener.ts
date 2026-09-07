import { scaledCount } from '../mesh/detail';
import { revolve, type Silhouette } from '../mesh/revolve';
import { enamelInside, enamelWhole } from '../mesh/types';
import { meshBounds, type Part } from './types';
import type { Vec2 } from '../geom/types';

export interface RivetSpec {
  name?: string;
  headDiameter: number;
  headHeight: number;
  shankDiameter: number;
  grip: number;
  /** Bucked tail spread on the far side. 0 leaves the shank cut flush. */
  tailSpread?: number;
  segments?: number;
}

/**
 * A dome rivet, as a silhouette revolved about its own axis.
 *
 * Origin sits at the seat — the face the head lands on — so placing one is just
 * aligning that origin to an anchor. Around 700 triangles, which is what a part
 * appearing two hundred times in a sculpture ought to cost.
 */
export function rivet(spec: RivetSpec): Part {
  const hr = spec.headDiameter / 2;
  const hh = spec.headHeight;
  const sr = spec.shankDiameter / 2;
  const spread = spec.tailSpread ?? sr * 0.5;
  const domeSegments = 8;

  const points: Vec2[] = [];
  const sharp: boolean[] = [];
  const at = (r: number, z: number, hard = false) => { points.push([r, z]); sharp.push(hard); };

  const tailHeight = spread > 0 ? sr * 0.7 : 0;
  const tailBottom = -spec.grip - tailHeight;

  at(0, tailBottom);
  if (spread > 0) {
    // the last arc point already lands on (sr + spread, -grip); repeating it as an
    // explicit corner would be a zero-length edge and a band of degenerate quads
    for (let i = 1; i <= 4; i++) {
      const a = (i / 4) * (Math.PI / 2);
      at((sr + spread) * Math.sin(a), tailBottom + tailHeight * (1 - Math.cos(a)), i === 4);
    }
    at(sr, -spec.grip + sr * 0.1, true);
  }
  at(sr, 0, true);
  at(hr, 0, true);

  // circular cap: base radius hr at the seat, apex at z = hh. The head meets the
  // seat at a hard corner on purpose: the assembly adds a solder fillet there.
  const r = (hr * hr + hh * hh) / (2 * hh);
  const zc = hh - r;
  for (let i = 1; i <= domeSegments; i++) {
    const z = (i / domeSegments) * hh;
    at(Math.sqrt(Math.max(r * r - (z - zc) * (z - zc), 0)), z);
  }

  const mesh = revolve({ points, sharp }, { segments: scaledCount(spec.segments ?? 24) });
  return {
    name: spec.name ?? 'rivet',
    mesh,
    bounds: meshBounds(mesh),
    anchors: [
      { name: 'seat', position: [0, 0, 0], axis: [0, 0, 1], tangent: [1, 0, 0], bore: spec.shankDiameter },
      { name: 'tail', position: [0, 0, -spec.grip], axis: [0, 0, -1], tangent: [1, 0, 0] },
    ],
  };
}

export interface BeadSpec {
  name?: string;
  radius: number;
  /** Length of the drawn point at the top. 0 gives a plain ovoid. */
  point?: number;
  bore?: number;
  /** Enamel fired over the whole body, by colour name. */
  enamel?: string;
  segments?: number;
}

/** A teardrop bead — the terminal that finishes a tendril without an engineering joint. */
export function bead(spec: BeadSpec): Part {
  const r = spec.radius;
  const point = spec.point ?? r * 1.4;
  const bore = spec.bore ?? 0;
  const rows = 20;

  const outer: Vec2[] = [];
  for (let i = 0; i <= rows; i++) {
    const a = (i / rows) * Math.PI; // 0 at the bottom pole, pi at the tip
    const pinch = Math.pow((1 - Math.cos(a)) / 2, 1.8);
    const rr = r * Math.sin(a) * (1 - 0.85 * pinch);
    const z = -Math.cos(a) * r + pinch * point;
    outer.push([Math.max(rr, bore / 2), z]);
  }

  let sil: Silhouette;
  if (bore > 0) {
    // Keep only the part of the ovoid that is actually wider than the hole, then
    // close across a real rim at each end. Clamping the outer profile to the bore
    // radius instead would leave duplicated points and zero-length edges, which
    // produce null normals and degenerate bands.
    const kept = outer.filter(([rr]) => rr > bore / 2 + 1e-6);
    const zBot = kept[0][1];
    const zTop = kept[kept.length - 1][1];
    const points: Vec2[] = [[bore / 2, zBot], ...kept, [bore / 2, zTop]];
    const sharp = points.map((_, i) => i <= 1 || i >= points.length - 2);
    sil = { points, sharp, closed: true };
  } else {
    sil = { points: outer };
  }

  const mesh = revolve(sil, { segments: scaledCount(spec.segments ?? 24) });
  if (spec.enamel) enamelWhole(mesh);
  return {
    name: spec.name ?? 'bead',
    mesh,
    bounds: meshBounds(mesh),
    enamel: spec.enamel,
    anchors: [{ name: 'seat', position: [0, 0, -r], axis: [0, 0, -1], tangent: [1, 0, 0], bore: spec.bore }],
  };
}

export interface EggSpec {
  name?: string;
  /** Half the width at the widest point. */
  radius: number;
  /** Half the height, pole to pole. Defaults to a real egg's proportion. */
  height?: number;
  /**
   * How much narrower the top is than the bottom. 0 gives an ellipsoid; a hen's
   * egg is about a third, and it is the only thing that separates an egg from a
   * ball — the widest point sits below the middle, and the eye reads that at
   * once even when it cannot say why.
   */
  taper?: number;
  /** Enamel fired over the whole body, by colour name. */
  enamel?: string;
  segments?: number;
}

/**
 * An egg.
 *
 * A bead can be made ovoid, but it draws to a point because it is meant to
 * finish a tendril. An egg does not: it closes at both ends on a smooth dome,
 * and the asymmetry is a gentle bias down the length rather than a spike.
 */
export function egg(spec: EggSpec): Part {
  const r = spec.radius;
  const h = spec.height ?? r * 1.28;
  const taper = Math.min(Math.max(spec.taper ?? 0.34, 0), 0.85);
  const rows = 40;

  const points: Vec2[] = [];
  for (let i = 0; i <= rows; i++) {
    const t = (i / rows) * Math.PI;   // 0 at the bottom pole
    const bias = (1 - Math.cos(t)) / 2;
    points.push([r * Math.sin(t) * (1 - taper * bias), -h * Math.cos(t)]);
  }

  const mesh = revolve({ points }, { segments: scaledCount(spec.segments ?? 48) });
  if (spec.enamel) enamelWhole(mesh);
  return {
    name: spec.name ?? 'egg',
    mesh,
    bounds: meshBounds(mesh),
    enamel: spec.enamel,
    anchors: [
      { name: 'base', position: [0, 0, -h], axis: [0, 0, -1], tangent: [1, 0, 0] },
      { name: 'apex', position: [0, 0, h], axis: [0, 0, 1], tangent: [1, 0, 0] },
    ],
  };
}

export interface CollarSpec {
  name?: string;
  innerRadius: number;
  wall: number;
  length: number;
  /** Swell at the middle, as a fraction of the wall. Gives a cast ferrule look. */
  belly?: number;
  segments?: number;
}

/** A ferrule that binds wires where they cross — this vocabulary's rivet. */
export function collar(spec: CollarSpec): Part {
  const rows = 12;
  const belly = spec.belly ?? 0.6;
  const half = spec.length / 2;

  // down the bore, then back up the outside, closed so the two rims are made too
  const inner: Vec2[] = [];
  for (let i = 0; i <= rows; i++) {
    inner.push([spec.innerRadius, half - (i / rows) * spec.length]);
  }
  const outer: Vec2[] = [];
  for (let i = 0; i <= rows; i++) {
    const t = i / rows;
    outer.push([
      spec.innerRadius + spec.wall * (1 + belly * Math.sin(Math.PI * t)),
      -half + t * spec.length,
    ]);
  }
  const points = [...inner, ...outer];
  const sharp = points.map((_, i) => i === inner.length - 1 || i === points.length - 1);

  const mesh = revolve({ points, sharp, closed: true }, { segments: scaledCount(spec.segments ?? 24) });
  return {
    name: spec.name ?? 'collar',
    mesh,
    bounds: meshBounds(mesh),
    anchors: [
      { name: 'a', position: [0, 0, -half], axis: [0, 0, -1], tangent: [1, 0, 0], bore: spec.innerRadius * 2 },
      { name: 'b', position: [0, 0, half], axis: [0, 0, 1], tangent: [1, 0, 0], bore: spec.innerRadius * 2 },
    ],
  };
}

export interface PodSpec {
  name?: string;
  length: number;
  width: number;
  /** Number of whorls — rings around the pod. 0 leaves it smooth. */
  whorls?: number;
  whorlDepth?: number;
  /** Ribs running the length of the pod, as a melon or a poppy capsule has. */
  ribs?: number;
  ribDepth?: number;
  segments?: number;
}

/**
 * A seed pod: an ovoid drawn to a point at both ends.
 *
 * It can be cut two ways, and they are genuinely different things. Whorls are
 * rings around the pod, cut into the silhouette — a shell or a cone. Ribs run
 * its length, which a silhouette cannot express at all and which needs the
 * revolve to be warped as it turns. A melon is ribbed; a shell is whorled; the
 * two together is a poppy capsule.
 */
export function pod(spec: PodSpec): Part {
  const rows = 48;
  const whorls = spec.whorls ?? 0;
  const depth = spec.whorlDepth ?? spec.width * 0.06;

  const points: Vec2[] = [];
  for (let i = 0; i <= rows; i++) {
    const t = i / rows;
    const a = t * Math.PI;
    // pointed at both ends, fullest a little below the middle
    const swell = Math.pow(Math.sin(a), 0.78) * (1 - 0.12 * Math.cos(a));
    const flute = whorls > 0 ? Math.cos(t * whorls * Math.PI * 2) * depth * Math.sin(a) : 0;
    points.push([Math.max(spec.width * 0.5 * swell + flute, 0), (t - 0.5) * spec.length]);
  }

  const ribs = spec.ribs ?? 0;
  const ribDepth = (spec.ribDepth ?? 0.12) ;
  const mesh = revolve({ points }, {
    segments: scaledCount(spec.segments ?? 32),
    warp: ribs > 0
      // faded out at the ends so the ribs die into the points rather than
      // crossing them, which is what leaves a pole looking screwed on
      ? (a, v) => 1 + ribDepth * Math.cos(ribs * a) * Math.sin(Math.PI * v)
      : undefined,
  });
  return {
    name: spec.name ?? 'pod',
    mesh,
    bounds: meshBounds(mesh),
    anchors: [
      { name: 'base', position: [0, 0, -spec.length / 2], axis: [0, 0, -1], tangent: [1, 0, 0] },
      { name: 'tip', position: [0, 0, spec.length / 2], axis: [0, 0, 1], tangent: [1, 0, 0] },
    ],
  };
}

export interface BellSpec {
  name?: string;
  length: number;
  /** Opening at the wide end. */
  mouth: number;
  /** Opening at the narrow end, where it joins the flower. */
  throat: number;
  wall?: number;
  /** Flare exponent: 1 is a straight cone, above 2 a trumpet. */
  flare?: number;
  /** Lobes of the rim. A corolla is fused petals, and the lobes are where they show. */
  lobes?: number;
  lobeDepth?: number;
  rows?: number;
  segments?: number;
  /** Enamel fired on the inside of the corolla, by colour name. The rim stays metal. */
  enamel?: string;
}

/**
 * A flared corolla: a trumpet or bell, open at both ends.
 *
 * The daffodil's corona, the foxglove's tube, a bellflower. Modelled as a thin
 * wall — up the outside, across the rim and back down the inside — because a
 * solid cone reads as a funnel and a flower's is visibly a shell you can see
 * into. The flare exponent is what distinguishes them: near 1 a campanula, near
 * 3 a narcissus.
 */
export function bell(spec: BellSpec): Part {
  const rows = spec.rows ?? 24;
  const wall = spec.wall ?? Math.max(spec.mouth * 0.03, 0.25);
  const flare = spec.flare ?? 2.2;

  const radiusAt = (t: number) =>
    spec.throat / 2 + (spec.mouth / 2 - spec.throat / 2) * Math.pow(t, flare);

  const outer: Vec2[] = [];
  const inner: Vec2[] = [];
  for (let i = 0; i <= rows; i++) {
    const t = i / rows;
    const z = t * spec.length;
    outer.push([radiusAt(t) + wall / 2, z]);
    inner.push([Math.max(radiusAt(t) - wall / 2, 0.02), z]);
  }
  inner.reverse();

  const points = [...outer, ...inner];
  const sharp = points.map((_, i) => i === outer.length - 1 || i === points.length - 1);

  const lobes = spec.lobes ?? 0;
  const lobeDepth = spec.lobeDepth ?? 0.16;
  const mesh = revolve({ points, sharp, closed: true }, {
    segments: scaledCount(spec.segments ?? 40),
    // A plain circular rim is the tell that a corolla was turned on a lathe. The
    // lobes grow with height so the throat stays round where it joins the flower.
    warp: lobes > 0
      ? (a, _v, _r, z) =>
          1 + lobeDepth * Math.cos(lobes * a) * Math.pow(Math.max(z, 0) / spec.length, 2)
      : undefined,
  });
  if (spec.enamel) enamelInside(mesh);
  return {
    name: spec.name ?? 'bell',
    mesh,
    bounds: meshBounds(mesh),
    enamel: spec.enamel,
    anchors: [
      { name: 'throat', position: [0, 0, 0], axis: [0, 0, -1], tangent: [1, 0, 0], bore: spec.throat },
      { name: 'mouth', position: [0, 0, spec.length], axis: [0, 0, 1], tangent: [1, 0, 0], bore: spec.mouth },
    ],
  };
}

export interface BudSpec {
  name?: string;
  length: number;
  width: number;
  /** Sepals wrapped round the bud, seen as flutes running its length. */
  lobes?: number;
  lobeDepth?: number;
  /** Length of the drawn point, as a fraction of the whole. */
  point?: number;
  /** Fullness. Below 1 a slim spindle, above 1 an urn about to open. */
  swell?: number;
  rows?: number;
  segments?: number;
}

/**
 * A bud: sepals wrapped over a point, before it opens.
 *
 * The thing that makes a bud read as a bud rather than as a bead is that the
 * sepals wrapping it are visible as flutes running its whole length, and they
 * twist very slightly — which is why it needed the revolve to be warped rather
 * than being another silhouette. A bouquet without buds looks arranged; with a
 * few it looks picked.
 */
export function bud(spec: BudSpec): Part {
  const rows = spec.rows ?? 40;
  const lobes = spec.lobes ?? 5;
  const depth = spec.lobeDepth ?? 0.1;
  const point = spec.point ?? 0.22;
  const swell = spec.swell ?? 1;

  const points: Vec2[] = [];
  for (let i = 0; i <= rows; i++) {
    const t = i / rows;
    const a = t * Math.PI;
    // full and round at the base, drawn out to a point at the top
    const body = Math.pow(Math.sin(a), 0.62 / swell) * (1 - 0.35 * Math.pow(t, 2.2));
    const tipPull = Math.pow(Math.max(t - (1 - point), 0) / point, 1.8);
    points.push([
      Math.max(spec.width * 0.5 * body * (1 - 0.9 * tipPull), 0),
      t * spec.length,
    ]);
  }

  const mesh = revolve({ points }, {
    segments: scaledCount(spec.segments ?? 36),
    warp: (angle, v) =>
      1 + depth * Math.cos(lobes * (angle + v * 0.55)) * Math.sin(Math.PI * v),
  });

  return {
    name: spec.name ?? 'bud',
    mesh,
    bounds: meshBounds(mesh),
    anchors: [
      { name: 'base', position: [0, 0, 0], axis: [0, 0, -1], tangent: [1, 0, 0] },
      { name: 'tip', position: [0, 0, spec.length], axis: [0, 0, 1], tangent: [1, 0, 0] },
    ],
  };
}
