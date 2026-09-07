import { scaledCount } from '../mesh/detail';
import { catmullRom, pathTangent, resample, type Curve } from '../geom/curve';
import * as profile from '../geom/profile';
import { sweep } from '../mesh/sweep';
import { enamelWhole, mergeMeshes } from '../mesh/types';
import { cross, normalize, sub, dot } from '../geom/vec';
import { meshBounds, type Anchor, type Part } from './types';
import type { Vec3 } from '../geom/types';

export interface StemSpec {
  name?: string;
  path: Curve;
  /** Section radius at the base. */
  radius: number;
  /** Fraction of the base radius left at the tip. */
  tipScale?: number;
  /**
   * Nodes along the stem — the points a leaf or a side shoot comes off. Each gets
   * a slight swelling and an anchor, which is the whole reason to have a stem part
   * rather than reaching for `wire`.
   */
  nodes?: number;
  /** Size of the swelling at each node, as a fraction of the radius. */
  nodeSwell?: number;
  /** Parameter range the nodes occupy. */
  from?: number;
  to?: number;
  sections?: number;
  sides?: number;
  up?: Vec3;
  /** Enamel by colour name: a stem is round, so it is dipped whole. */
  enamel?: string;
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/**
 * A stem: a tapering run of metal with declared attachment points.
 *
 * `wire` already sweeps a tapering section along a curve, and for a tendril that
 * is all a stem is. What a stem adds is where things join it. A plant does not
 * scatter its leaves — it puts them at nodes, and it turns each one about the
 * axis from the last by roughly the golden angle, which is why a real stem never
 * looks like a row of leaves stuck on one side. Declaring those nodes as anchors
 * means `fasten leaf to stem.n2` lands the leaf on the metal and pointing out of
 * it, rather than being positioned by eye and hoping.
 */
export function stem(spec: StemSpec): Part {
  const sections = scaledCount(spec.sections ?? 96);
  const sides = scaledCount(spec.sides ?? 10);
  const tip = spec.tipScale ?? 0.35;
  const nodes = spec.nodes ?? 0;
  const swell = spec.nodeSwell ?? 0.28;
  const from = spec.from ?? 0.12;
  const to = spec.to ?? 0.92;

  const path = resample(spec.path, sections);
  const nodeAt = (i: number) => (nodes > 1 ? from + ((to - from) * i) / (nodes - 1) : (from + to) / 2);

  // the swelling is a bump in the taper, so the node is a thickening of the stem
  // itself rather than a collar sitting on top of it
  const taper = (t: number) => {
    let s = 1 - (1 - tip) * Math.pow(t, 1.25);
    for (let i = 0; i < nodes; i++) {
      const d = (t - nodeAt(i)) / 0.045;
      if (Math.abs(d) < 3) s *= 1 + swell * Math.exp(-d * d);
    }
    return s;
  };

  const mesh = sweep(path, {
    profile: profile.circle(spec.radius, sides),
    taper,
    caps: true,
    up: spec.up,
  });

  const anchors: Anchor[] = [
    { name: 'base', position: path[0], axis: normalize(sub(path[0], path[1])), tangent: normalize(sub(path[1], path[0])) },
    {
      name: 'tip',
      position: path[path.length - 1],
      axis: normalize(sub(path[path.length - 1], path[path.length - 2])),
      tangent: normalize(sub(path[path.length - 1], path[path.length - 2])),
    },
  ];

  for (let i = 0; i < nodes; i++) {
    const t = nodeAt(i);
    const index = Math.round(t * (path.length - 1));
    const tangent = pathTangent(path, index);
    const out = outwardAt(tangent, i * GOLDEN, spec.up ?? [0, 0, 1]);
    const r = spec.radius * taper(t);
    anchors.push({
      name: `n${i}`,
      position: [
        path[index][0] + out[0] * r,
        path[index][1] + out[1] * r,
        path[index][2] + out[2] * r,
      ],
      axis: out,
      tangent,
    });
  }

  if (spec.enamel) enamelWhole(mesh);
  return { name: spec.name ?? 'stem', mesh, bounds: meshBounds(mesh), anchors, enamel: spec.enamel };
}

/** A direction perpendicular to the stem, turned `angle` about it from the up reference. */
function outwardAt(tangent: Vec3, angle: number, up: Vec3): Vec3 {
  let ref = sub(up, [tangent[0] * dot(up, tangent), tangent[1] * dot(up, tangent), tangent[2] * dot(up, tangent)]);
  if (Math.hypot(ref[0], ref[1], ref[2]) < 1e-6) ref = [1, 0, 0];
  const a = normalize(ref);
  const b = cross(tangent, a);
  const c = Math.cos(angle), s = Math.sin(angle);
  return normalize([a[0] * c + b[0] * s, a[1] * c + b[1] * s, a[2] * c + b[2] * s]);
}

export interface BranchSpec extends StemSpec {
  /** Side shoots leaving the trunk, one per node. */
  limbs?: number;
  /** Length of each shoot, as a fraction of the trunk's own extent. */
  limbLength?: number;
  /** How far each shoot turns from the trunk, in radians. 0 is parallel to it. */
  limbAngle?: number;
  /** Sideways bow of each shoot. Straight limbs read as a TV aerial. */
  limbSag?: number;
  /** Length multiplier from the first shoot to the last. */
  limbTaper?: number;
}

/**
 * A branch: a trunk and its shoots, as one piece of metal.
 *
 * Everything else in this vocabulary stays a separate part, overlapped and
 * riveted, because that is what the sculpture is. A branch is the exception — a
 * limb leaves its trunk continuously, and a rivet at the fork would read as a
 * repair. So the sweeps are merged into a single mesh, which also means a branch
 * is instanced as one part however many limbs it has.
 */
export function branch(spec: BranchSpec): Part {
  const limbs = spec.limbs ?? 3;
  const trunk = stem({ ...spec, nodes: Math.max(spec.nodes ?? limbs, limbs) });
  const sections = Math.max(Math.round((scaledCount(spec.sections ?? 96)) / 3), 16);
  const sides = scaledCount(spec.sides ?? 10);
  const angle = spec.limbAngle ?? 0.85;
  const sag = spec.limbSag ?? 0.18;
  const taper = spec.limbTaper ?? 0.55;

  const span = Math.hypot(
    trunk.bounds.max[0] - trunk.bounds.min[0],
    trunk.bounds.max[1] - trunk.bounds.min[1],
    trunk.bounds.max[2] - trunk.bounds.min[2],
  );
  const reach = (spec.limbLength ?? 0.42) * span;

  const meshes = [trunk.mesh];
  const anchors: Anchor[] = trunk.anchors.filter((a) => !/^n\d+$/.test(a.name));

  for (let i = 0; i < limbs; i++) {
    const node = trunk.anchors.find((a) => a.name === `n${i}`);
    if (!node) continue;
    const t = limbs > 1 ? i / (limbs - 1) : 0;
    const length = reach * (1 + (taper - 1) * t);

    // the shoot leaves along a direction between the trunk and straight out of it,
    // then bows: three points through a Catmull-Rom rather than a straight line
    const dir = normalize([
      node.tangent[0] * Math.cos(angle) + node.axis[0] * Math.sin(angle),
      node.tangent[1] * Math.cos(angle) + node.axis[1] * Math.sin(angle),
      node.tangent[2] * Math.cos(angle) + node.axis[2] * Math.sin(angle),
    ]);
    const side = normalize(cross(dir, node.tangent));
    const pts: Vec3[] = [0, 0.5, 1].map((u) => [
      node.position[0] + dir[0] * length * u + side[0] * sag * length * Math.sin(Math.PI * u),
      node.position[1] + dir[1] * length * u + side[1] * sag * length * Math.sin(Math.PI * u),
      node.position[2] + dir[2] * length * u + side[2] * sag * length * Math.sin(Math.PI * u),
    ]);

    const dense = resample(catmullRom(pts), sections + 1);

    const r = spec.radius * 0.62 * (1 + (taper - 1) * t);
    meshes.push(sweep(dense, {
      profile: profile.circle(r, sides),
      taper: (u) => 1 - 0.72 * Math.pow(u, 1.2),
      caps: true,
    }));

    anchors.push({
      name: `t${i}`,
      position: dense[dense.length - 1],
      axis: normalize(sub(dense[dense.length - 1], dense[dense.length - 2])),
      tangent: normalize(sub(dense[dense.length - 1], dense[dense.length - 2])),
    });
  }

  const mesh = mergeMeshes(meshes);
  // trunk and limbs alike: a branch is dipped as one piece
  if (spec.enamel) enamelWhole(mesh);
  return { name: spec.name ?? 'branch', mesh, bounds: meshBounds(mesh), anchors, enamel: spec.enamel };
}
