import type { Box3, Vec3 } from '../geom/types';
import {
  determinant3, fromBasis, identity, multiply, transformDirection, transformPoint,
  rotationAbout, type Mat4,
} from '../geom/transform';
import { cross, dot, normalize, sub } from '../geom/vec';
import type { Anchor, Part } from '../parts/types';
import type { Symmetry } from '../pattern/symmetry';

/** Where in a sketch's source a placement came from. A DSL span satisfies this. */
export interface Origin {
  start: number;
  end: number;
}

/** One part, placed. `anchors` are already in assembly space. */
export interface Placement {
  part: Part;
  matrix: Mat4;
  anchors: Anchor[];
  anchor(name: string): Anchor;
  /**
   * The statements that made this placement, innermost first: the `place`
   * inside a unit, then the unit, then the `repeat` that copied it. Empty
   * when the assembly was built in TypeScript.
   */
  origins: Origin[];
}

export interface ConnectOptions {
  /**
   * How the two axes meet. Anchor axes point out of their own material, so a
   * fastener sitting on a face wants 'same' (both pointing away from the plate)
   * and two parts butted end to end want 'opposed'.
   */
  align?: 'same' | 'opposed';
  /** Spin about the mating axis, in radians. */
  roll?: number;
  /** Shift along the target axis. Negative sinks the part into the material. */
  offset?: number;
  /** Uniform scale applied to the placed part. */
  scale?: number;
}

/**
 * A built form: placements sharing a small set of parts.
 *
 * Nothing here merges geometry. Placements keep pointing at the part they came
 * from, so the renderer can group by mesh and draw sixty leaves in one call —
 * which is the entire reason parts are kept cheap and separate.
 */
export class Assembly {
  readonly placements: Placement[] = [];

  constructor(readonly name = 'assembly') {}

  place(part: Part, matrix: Mat4 = identity(), origin?: Origin): Placement {
    const p = makePlacement(part, matrix, origin ? [origin] : []);
    this.placements.push(p);
    return p;
  }

  /**
   * Seat `part` onto a world-space anchor by its own named anchor.
   *
   * The two anchors' positions are made to coincide and their axes aligned; the
   * remaining spin is taken from the anchors' tangents, so anything with a
   * direction — a leaf, a lens section, a hex head — lands the right way round
   * instead of at an arbitrary roll.
   */
  connect(target: Anchor, part: Part, anchorName: string, opts: ConnectOptions = {}, origin?: Origin): Placement {
    const source = part.anchors.find((a) => a.name === anchorName);
    if (!source) throw new Error(`part "${part.name}" has no anchor "${anchorName}"`);
    const p = makePlacement(part, mate(target, source, opts), origin ? [origin] : []);
    this.placements.push(p);
    return p;
  }

  /** Copy an assembly in under every transform of a symmetry. */
  repeat(sub: Assembly, symmetry: Symmetry, origin?: Origin): void {
    for (const t of symmetry) {
      for (const p of sub.placements) {
        this.placements.push(makePlacement(p.part, multiply(t, p.matrix), extend(p.origins, origin)));
      }
    }
  }

  merge(sub: Assembly, transform: Mat4 = identity(), origin?: Origin): void {
    for (const p of sub.placements) {
      this.placements.push(makePlacement(p.part, multiply(transform, p.matrix), extend(p.origins, origin)));
    }
  }

  /** Note a statement that encloses everything placed so far, such as the unit it was placed in. */
  enclose(origin: Origin): void {
    for (const p of this.placements) p.origins.push(origin);
  }

  bounds(): Box3 {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const p of this.placements) {
      const b = p.part.bounds;
      // all eight corners, since the placement rotates the local box
      for (let i = 0; i < 8; i++) {
        const corner: Vec3 = [
          i & 1 ? b.max[0] : b.min[0],
          i & 2 ? b.max[1] : b.min[1],
          i & 4 ? b.max[2] : b.min[2],
        ];
        const w = transformPoint(p.matrix, corner);
        for (let k = 0; k < 3; k++) {
          if (w[k] < min[k]) min[k] = w[k];
          if (w[k] > max[k]) max[k] = w[k];
        }
      }
    }
    return { min, max };
  }

  stats() {
    const meshes = new Set(this.placements.map((p) => p.part.mesh));
    let tris = 0;
    let uniqueTris = 0;
    for (const p of this.placements) tris += p.part.mesh.indices.length / 3;
    for (const m of meshes) uniqueTris += m.indices.length / 3;
    return {
      instances: this.placements.length,
      uniqueParts: meshes.size,
      drawnTriangles: tris,
      uniqueTriangles: uniqueTris,
      mirrored: this.placements.filter((p) => determinant3(p.matrix) < 0).length,
    };
  }
}

const extend = (origins: Origin[], origin?: Origin) => (origin ? [...origins, origin] : [...origins]);

function makePlacement(part: Part, matrix: Mat4, origins: Origin[]): Placement {
  const anchors = part.anchors.map((a) => ({
    ...a,
    position: transformPoint(matrix, a.position),
    axis: normalize(transformDirection(matrix, a.axis)),
    tangent: normalize(transformDirection(matrix, a.tangent)),
  }));
  return {
    part,
    matrix,
    anchors,
    origins,
    anchor(name: string) {
      const found = anchors.find((a) => a.name === name);
      if (!found) throw new Error(`placement of "${part.name}" has no anchor "${name}"`);
      return found;
    },
  };
}

/** The transform that carries `source` (in part space) onto `target` (in world space). */
function mate(target: Anchor, source: Anchor, opts: ConnectOptions): Mat4 {
  const { align = 'same', roll = 0, offset = 0, scale = 1 } = opts;

  const targetAxis = normalize(target.axis);
  const wanted: Vec3 = align === 'opposed'
    ? [-targetAxis[0], -targetAxis[1], -targetAxis[2]]
    : targetAxis;

  // Both frames are built right-handed from (tangent, axis), so the rotation that
  // carries one onto the other is proper — no accidental reflection, whichever way
  // the axes are pointing.
  const src = orthoFrame(source.axis, source.tangent);
  const dst = orthoFrame(wanted, target.tangent);

  // R = dst * src^T, with the basis vectors as columns
  const r = new Float32Array(16);
  r[15] = 1;
  for (let c = 0; c < 3; c++) {
    for (let rw = 0; rw < 3; rw++) {
      r[c * 4 + rw] =
        dst.t[rw] * src.t[c] + dst.b[rw] * src.b[c] + dst.a[rw] * src.a[c];
    }
  }

  const spin = roll ? rotationAbout(wanted, roll) : identity();
  const rotation = multiply(spin, r);

  const origin: Vec3 = [
    target.position[0] + targetAxis[0] * offset,
    target.position[1] + targetAxis[1] * offset,
    target.position[2] + targetAxis[2] * offset,
  ];

  // translate the source anchor to the origin, rotate, then move onto the target
  const scaled = scaleMat(rotation, scale);
  const moved = transformDirection(scaled, source.position);
  return fromBasis(
    sub(origin, moved),
    [scaled[0], scaled[1], scaled[2]],
    [scaled[4], scaled[5], scaled[6]],
    [scaled[8], scaled[9], scaled[10]],
  );
}

function scaleMat(m: Mat4, s: number): Mat4 {
  const out = new Float32Array(m);
  for (let i = 0; i < 12; i++) if (i % 4 !== 3) out[i] *= s;
  return out;
}

/** Right-handed frame from an axis and a tangent hint, tangent projected perpendicular. */
function orthoFrame(axis: Vec3, tangentHint: Vec3) {
  const a = normalize(axis);
  let t = sub(tangentHint, [a[0] * dot(tangentHint, a), a[1] * dot(tangentHint, a), a[2] * dot(tangentHint, a)]);
  if (Math.hypot(t[0], t[1], t[2]) < 1e-6) {
    t = normalize(cross(a, Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
  }
  t = normalize(t);
  return { t, b: cross(a, t), a };
}
