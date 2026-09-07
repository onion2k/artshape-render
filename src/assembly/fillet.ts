/**
 * Solder fillets: the meniscus where one part is fastened to another.
 *
 * Two parts that merely intersect look glued. Real joins are soldered, and the
 * solder wets both surfaces and pulls into a concave sweep from the thinner
 * member onto the face it meets. That sweep is small and it is everywhere, and
 * its absence is one of the things that makes an assembly read as parts stacked
 * in software.
 *
 * A fillet is a revolved quarter-round placed at the mating anchor: it wraps the
 * post — whichever of the two members is thinner at the join — and flares onto
 * the plate. Nothing is cut or merged; the ring simply overlaps both, which is
 * exactly what solder does.
 */

import type { Assembly, Placement } from './assembly';
import { fromBasis, transformDirection } from '../geom/transform';
import type { Vec3 } from '../geom/types';
import { dot, frameFrom, normalize } from '../geom/vec';
import { revolve } from '../mesh/revolve';
import { meshBounds, type Anchor, type Part } from '../parts/types';

/** Fillet parts by size, so identical joins share one mesh and one draw call. */
export type FilletCache = Map<string, Part>;

/**
 * Add a fillet for the placement just fastened onto `target`.
 *
 * `target` is the owner's anchor in world space; `placed` is the fastened part's
 * placement and `anchorName` the anchor it was fastened by.
 */
export function solderFillet(
  assembly: Assembly,
  owner: Placement,
  target: Anchor,
  placed: Placement,
  anchorName: string,
  cache: FilletCache,
): Placement | null {
  // Solder wets metal. A stone sits in its setting and a pearl is cemented on
  // its peg, and a meniscus round either would be a claim about the making of
  // the piece that is not true.
  if (placed.part.solderable === false || owner.part.solderable === false) return null;

  const ownerAnchor = owner.part.anchors.find((a) => a.name === target.name);
  const partAnchor = placed.part.anchors.find((a) => a.name === anchorName);
  if (!ownerAnchor || !partAnchor) return null;

  const plateSide = contact(owner.part, ownerAnchor, scaleOf(owner));
  const postSide = contact(placed.part, partAnchor, scaleOf(placed));
  if (!plateSide || !postSide) return null;

  // the thinner member is the post; the fillet sits on the other and wraps it
  let post = postSide, plate = plateSide;
  let postPlacement = placed, postLocal = partAnchor;
  if (plateSide.radius < postSide.radius) {
    post = plateSide; plate = postSide;
    postPlacement = owner; postLocal = ownerAnchor;
  }
  // The fillet rises from the plate's face toward the post's material, so its
  // axis is the post's material direction in world space.
  const postAxis = normalize(transformDirection(postPlacement.matrix, postLocal.axis));
  const dir: Vec3 = [postAxis[0] * post.side, postAxis[1] * post.side, postAxis[2] * post.side];
  const frame = frameFrom(dir);
  const matrix = fromBasis(target.position, frame.x, frame.y, frame.z);

  // solder finishes to the metal it joins; borrow the post's material
  const material = postPlacement.part.material;

  // Members of a size are butted, not seated: there is no face for the solder to
  // flow onto, so it sits as a bead around the joint instead — an anther on the
  // end of its filament, a wire spliced to a wire.
  if (plate.radius - post.radius < Math.max(0.08, post.radius * 0.3)) {
    const r = Math.max(post.radius, plate.radius);
    const b = Math.min(Math.max(r * 0.3, 0.1), 0.5);
    return assembly.place(beadPart(r, b, material, cache), matrix);
  }

  const r = post.radius;
  const f = Math.min(Math.max(r * 0.35, 0.12), 0.7, (plate.radius - r) * 0.9);
  return assembly.place(filletPart(r, f, material, cache), matrix);
}

interface Contact {
  radius: number;
  /** +1 when the part's material lies along its anchor axis, -1 against it. */
  side: 1 | -1;
}

/**
 * How wide a part is where it meets its anchor plane.
 *
 * Parts do not declare this, so it is read off the mesh: the material lies on
 * whichever side of the plane holds the vertices, and the contact radius is the
 * widest the part gets within a thin slab against the plane on that side.
 */
function contact(part: Part, anchor: Anchor, scale: number): Contact | null {
  const p = part.mesh.positions;
  const axis = normalize(anchor.axis);
  const extent = Math.hypot(
    part.bounds.max[0] - part.bounds.min[0],
    part.bounds.max[1] - part.bounds.min[1],
    part.bounds.max[2] - part.bounds.min[2],
  );
  const slab = Math.max(0.25, extent * 0.03);

  let along = 0;
  for (let i = 0; i < p.length; i += 3) {
    along += (p[i] - anchor.position[0]) * axis[0]
      + (p[i + 1] - anchor.position[1]) * axis[1]
      + (p[i + 2] - anchor.position[2]) * axis[2];
  }
  const side: 1 | -1 = along >= 0 ? 1 : -1;

  // A wire or a stem tapers to a point at its tip, so the slab against the plane
  // may hold nothing but that point. Widen it until the member shows its width.
  for (const widen of [1, 2, 4, 8]) {
    const depth = slab * widen;
    let radius = 0;
    for (let i = 0; i < p.length; i += 3) {
      const d: Vec3 = [p[i] - anchor.position[0], p[i + 1] - anchor.position[1], p[i + 2] - anchor.position[2]];
      const t = dot(d, axis) * side;
      if (t < -1e-4 || t > depth) continue;
      const rx = d[0] - axis[0] * t * side;
      const ry = d[1] - axis[1] * t * side;
      const rz = d[2] - axis[2] * t * side;
      radius = Math.max(radius, Math.hypot(rx, ry, rz));
    }
    if (radius >= 0.05) return { radius: radius * scale, side };
  }
  return null;
}

function scaleOf(placement: Placement) {
  const m = placement.matrix;
  return Math.hypot(m[0], m[1], m[2]) || 1;
}

/** A convex bead of height b around a butt joint of radius r at the plane z = 0. */
function beadPart(r: number, b: number, material: Part['material'], cache: FilletCache): Part {
  const key = `bead:${r.toFixed(2)}:${b.toFixed(2)}:${material?.metal ?? ''}:${material?.finish ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const points: [number, number][] = [];
  const steps = 8;
  // a half-ellipse standing off the joint, sunk a little into both members at its ends
  points.push([r * 0.96, -b * 1.1]);
  for (let i = 0; i <= steps; i++) {
    const a = -Math.PI / 2 + (i / steps) * Math.PI;
    points.push([r + b * 0.75 * Math.cos(a), b * Math.sin(a)]);
  }
  points.push([r * 0.96, b * 1.1]);

  const mesh = revolve({ points }, { segments: 28 });
  const part: Part = { name: 'solder', mesh, bounds: meshBounds(mesh), anchors: [], material };
  cache.set(key, part);
  return part;
}

/** A concave quarter-round ring, radius r inside, flaring by f onto the plane z = 0. */
function filletPart(r: number, f: number, material: Part['material'], cache: FilletCache): Part {
  const key = `${r.toFixed(2)}:${f.toFixed(2)}:${material?.metal ?? ''}:${material?.finish ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const points: [number, number][] = [];
  const steps = 5;
  // from the plate outward-edge, up the concave arc, into the post: the same
  // sense as a revolved profile that runs from its base to its top, so the
  // normals face the open side of the sweep
  points.push([r + f * 1.02, -f * 0.03]);
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * (Math.PI / 2);
    points.push([r + f - f * Math.sin(a), f - f * Math.cos(a)]);
  }
  points.push([r * 0.96, f * 1.02]);

  const mesh = revolve({ points }, { segments: 28 });
  const part: Part = {
    name: 'solder',
    mesh,
    bounds: meshBounds(mesh),
    anchors: [],
    material,
  };
  cache.set(key, part);
  return part;
}
