import { scaledCount } from '../mesh/detail';
import * as profile from '../geom/profile';
import { sweep } from '../mesh/sweep';
import { MeshBuilder, enamelWhole, mergeMeshes, recomputeNormals, type Mesh } from '../mesh/types';
import { leatherBinding } from './binding';
import { meshBounds, type Anchor, type Part } from './types';

/**
 * A blade section with its thick, squared back on the origin and its sharp
 * edge out at +width: ground steel is a wedge, sharp on one side only.
 * Built at unit size and scaled per row, so the head's loft can give every
 * row its own reach and thickness.
 */
function edgeWedge(width: number, thickness: number, sides: number) {
  const n = Math.max(6, Math.round(sides / 2));
  const points: [number, number][] = [];
  const sharp: boolean[] = [];
  // u runs from the back (0) to the edge (1)
  const half = (u: number) => (thickness / 2) * Math.pow(1 - u, 0.45) * (0.9 + 0.1 * u);
  // counter-clockwise, the way every profile here is wound: out along the
  // underside to the edge, back along the top — the sweep takes its outward
  // direction from the winding, and a clockwise section turns inside out
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    points.push([u * width, -half(u)]);
    sharp.push(i === 0 || i === n);
  }
  for (let i = n - 1; i >= 1; i--) {
    const u = i / n;
    points.push([u * width, half(u)]);
    sharp.push(false);
  }
  points.push([0, half(0)]);
  sharp.push(true);
  return { points, sharp };
}

export interface AxeSpec {
  name?: string;
  /** Haft length, butt to head. */
  haftLength: number;
  haftRadius?: number;
  /** How far the head's edge reaches out from the haft. */
  headReach?: number;
  /** Height of the head's face, haft to the broad edge. */
  headHeight?: number;
  headThickness?: number;
  /** A second head, mirrored on the other side of the haft. */
  doubleBit?: boolean;
  /**
   * `false` leaves the haft out — head, socket and binding only, still hung
   * at `haftLength` — for a haft that is its own part: a stem or a branch in
   * wood, which a single-material part cannot be at the same time as steel.
   */
  haft?: boolean;
  /**
   * Turns of a leather binding round the hand piece, 0 for a bare haft. The
   * binding covers `wrapLength` of the haft starting `wrapFrom` up it, both
   * as fractions of the whole — a long haft is gripped in one place, not
   * bound end to end. A flat strap cut to its own pitch, so the turns abut;
   * `wrapRadius` is half its thickness.
   */
  wrapTurns?: number;
  wrapRadius?: number;
  wrapFrom?: number;
  wrapLength?: number;
  /** The binding's colour, by enamel name; only the binding takes it. */
  enamel?: string;
  segments?: number;
}

/**
 * An axe: a haft with one or two heads flared out near the top.
 *
 * A genuinely different silhouette from `sword` — there is no blade/guard/
 * pommel stack, just a haft and a head, and the head is not the haft's own
 * end the way a sword's point is; it flares out to the *side*.
 *
 * The first head was `wire`'s `blade()` swept straight out from the haft —
 * a plate with a flat cap for an edge, which is a paddle, not an axe. This
 * one sweeps the section *along the cutting edge*: a lens with its sharp
 * tip on the path and its back reaching in toward the haft, the path a
 * convex arc from the top horn down past the eye to the beard. Reach draws
 * in toward both horns, so the inner outline curls into a crescent, and the
 * sweep frame turns with the arc so the cheeks run square to the edge the
 * whole way round. Still all `sweep()`, so it stands in Z without any
 * `roll`/`pitch` at `place` (see `easel` for what that costs).
 */
export function axe(spec: AxeSpec): Part {
  const haftRadius = spec.haftRadius ?? spec.haftLength * 0.018;
  const headReach = spec.headReach ?? spec.haftLength * 0.26;
  const headHeight = spec.headHeight ?? spec.haftLength * 0.3;
  const headThickness = spec.headThickness ?? haftRadius * 1.4;
  const segments = scaledCount(spec.segments ?? 24);
  const sides = Math.max(8, Math.round(segments / 2));

  // haft: a plain taper, flared briefly at the butt so the grip doesn't
  // simply slide out of a closed fist
  const haft = sweep([[0, 0, 0], [0, 0, spec.haftLength]], {
    profile: profile.circle(haftRadius, sides),
    taper: (t) => 1 + 0.35 * Math.exp(-t * 10),
    caps: true,
  });

  // head: lofted row by row up the height of the head, each row a wedge
  // section laid flat in XZ from the back outline out to a convex cutting
  // edge, thickness across Y. Every row is horizontal, so no two can cross —
  // which they do, and fold the cheeks, when the section is *swept* along
  // either outline instead: a sweep's rays run square to its path, and both
  // the edge (convex) and the back (concave) turn them into one another
  // somewhere across a head this wide. A loft has no path to follow.
  const headZ = spec.haftLength;
  const standoff = haftRadius * 0.6;
  const bulge = headReach * 0.16;
  const zTop = headZ + headHeight * 0.4;
  const zBot = headZ - headHeight * 0.6;
  const zMid = (zTop + zBot) / 2;
  const halfH = (zTop - zBot) / 2;
  const edgeAt = (z: number) => {
    const u = (z - zMid) / halfH;
    return headReach - bulge * u * u;
  };
  // the back: flat against the haft across the socket band, sweeping out
  // above it to the top horn, curling out below it to the beard
  const socketTop = headZ + headHeight * 0.16;
  const socketBot = headZ - headHeight * 0.1;
  const hornBack = (z: number) => edgeAt(z) - headReach * 0.07;
  const backAt = (z: number) => {
    if (z > socketTop) return standoff + (hornBack(zTop) - standoff) * Math.pow((z - socketTop) / (zTop - socketTop), 1.3);
    if (z < socketBot) {
      // eased at both ends, so the beard leaves the socket and meets its own
      // tip without a kink in the cheek either side of it
      const u = (socketBot - z) / (socketBot - zBot);
      return standoff + (hornBack(zBot) - standoff) * u * u * (3 - 2 * u);
    }
    return standoff;
  };
  const widthMid = headReach - standoff;
  const headMesh = (side: 1 | -1): Mesh => {
    const rows = segments + 1;
    const section = edgeWedge(1, 1, sides);
    const cols = section.points.length;
    const mb = new MeshBuilder();
    for (let r = 0; r < rows; r++) {
      const z = zTop + (zBot - zTop) * (r / (rows - 1));
      const back = backAt(z);
      // never 0 at a horn: a row closing to a point is the degenerate every
      // blade swell elsewhere floors against
      const reach = Math.max(edgeAt(z) - back, widthMid * 0.05);
      const thick = headThickness * Math.min(1, reach / widthMid + 0.15);
      // the seam column is repeated, the way sweep and revolve lay out a grid
      for (let c = 0; c <= cols; c++) {
        const [px, py] = section.points[c % cols];
        mb.vertex(side * (back + px * reach), py * thick, z, 0, 0, 0, c / cols, r / (rows - 1));
      }
    }
    mb.grid(0, rows, cols + 1);
    // the horns: a fan across each end row, wound to face out along the head
    for (const [r, sign] of [[0, 1], [rows - 1, -1]] as const) {
      const base = r * (cols + 1);
      const z = zTop + (zBot - zTop) * (r / (rows - 1));
      const cx = side * (backAt(z) + Math.max(edgeAt(z) - backAt(z), widthMid * 0.05) / 2);
      const centre = mb.vertex(cx, 0, z, 0, 0, sign, 0.5, 0.5);
      for (let c = 0; c < cols; c++) {
        if (sign * side > 0) mb.triangle(centre, base + c, base + c + 1);
        else mb.triangle(centre, base + c + 1, base + c);
      }
    }
    const mesh = mb.build();
    recomputeNormals(mesh);
    return mesh;
  };
  const head = headMesh(1);

  // the eye: a short socket round the haft where the head is hung, since a
  // crescent only meets the haft along the middle of its own back
  const eye = sweep([[0, 0, headZ - headHeight * 0.3], [0, 0, headZ + headHeight * 0.22]], {
    profile: profile.circle(haftRadius * 1.7, sides),
    caps: true,
  });

  const pieces: Mesh[] = spec.haft === false ? [eye, head] : [haft, eye, head];

  // the hand piece: a flat strap wound round one stretch of the haft, each
  // turn lying against the last so the wood under it is covered
  const wrapTurns = spec.wrapTurns ?? 0;
  if (wrapTurns > 0) {
    const wrapFrom = Math.min(Math.max(spec.wrapFrom ?? 0.06, 0), 0.95);
    const wrapLength = Math.min(Math.max(spec.wrapLength ?? 0.3, 0.01), 1 - wrapFrom);
    const wrap = leatherBinding({
      shaftRadius: haftRadius,
      z0: wrapFrom * spec.haftLength,
      span: wrapLength * spec.haftLength,
      turns: wrapTurns,
      thickness: (spec.wrapRadius ?? haftRadius * 0.11) * 2,
    });
    if (spec.enamel) enamelWhole(wrap);
    pieces.push(wrap);
  }

  if (spec.doubleBit) pieces.push(headMesh(-1));

  const mesh = mergeMeshes(pieces);
  // the head's broad face is the XZ plane, so its cheeks look out along Y;
  // a jewel fastened to one sits where the face is widest, not at the eye
  const cheekX = standoff + widthMid * 0.55;
  // the wedge is thinner there than at its back — half the section's own
  // thickness at that reach, so a stone seated here sits on the cheek, not
  // floating clear of it
  const cheekY = (headThickness / 2) * Math.pow(1 - 0.55, 0.45) * (0.9 + 0.1 * 0.55);
  const anchors: Anchor[] = [
    { name: 'butt', position: [0, 0, 0], axis: [0, 0, -1], tangent: [1, 0, 0] },
    { name: 'edge', position: [headReach, 0, headZ], axis: [1, 0, 0], tangent: [0, 0, 1] },
    { name: 'top', position: [0, 0, spec.haftLength], axis: [0, 0, 1], tangent: [1, 0, 0] },
    { name: 'poll', position: [-standoff, 0, headZ], axis: [-1, 0, 0], tangent: [0, 0, 1] },
    { name: 'cheek', position: [cheekX, cheekY, headZ], axis: [0, 1, 0], tangent: [0, 0, 1] },
    { name: 'cheekBack', position: [cheekX, -cheekY, headZ], axis: [0, -1, 0], tangent: [0, 0, 1] },
  ];
  return { name: spec.name ?? 'axe', mesh, bounds: meshBounds(mesh), anchors, enamel: spec.enamel };
}
