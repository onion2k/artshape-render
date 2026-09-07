import type { Vec2 } from './types';

/**
 * A closed 2D cross-section, wound counter-clockwise.
 *
 * `sharp` marks vertices that are real creases rather than tessellation of a curve.
 * A swept lens has two hard tips and a smooth belly; without that distinction the
 * tips shade round and the whole section reads as a soft tube.
 */
export interface Profile {
  points: Vec2[];
  sharp: boolean[];
}

const smooth = (points: Vec2[]): Profile => ({ points, sharp: points.map(() => false) });

export function circle(radius: number, segments = 16): Profile {
  const points: Vec2[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    points.push([Math.cos(a) * radius, Math.sin(a) * radius]);
  }
  return smooth(points);
}

export function ellipse(rx: number, ry: number, segments = 16): Profile {
  const points: Vec2[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    points.push([Math.cos(a) * rx, Math.sin(a) * ry]);
  }
  return smooth(points);
}

/**
 * Lens: two circular arcs meeting at points. The section of a beaten leaf or a
 * forged blade, and the reason `sharp` exists.
 */
export function lens(width: number, thickness: number, segments = 16): Profile {
  const half = segments % 2 === 0 ? segments / 2 : (segments + 1) / 2;
  const points: Vec2[] = [];
  const sharp: boolean[] = [];
  for (let side = 0; side < 2; side++) {
    const sign = side === 0 ? 1 : -1;
    for (let i = 0; i < half; i++) {
      const t = i / half;
      const x = (0.5 - t) * width * (side === 0 ? 2 : -2) / 2;
      const belly = Math.cos((x / (width / 2)) * (Math.PI / 2));
      points.push([x, sign * (thickness / 2) * belly]);
      sharp.push(i === 0);
    }
  }
  return { points, sharp };
}

/** Flat ribbon with rounded edges — drawn strip, banding, straps. */
export function ribbon(width: number, thickness: number, roundSegments = 4): Profile {
  const points: Vec2[] = [];
  const sharp: boolean[] = [];
  const r = Math.min(thickness / 2, width / 2);
  const hx = width / 2 - r;
  const corners: Array<[number, number, number]> = [
    [hx, thickness / 2 - r, 0],
    [-hx, thickness / 2 - r, Math.PI / 2],
    [-hx, -(thickness / 2 - r), Math.PI],
    [hx, -(thickness / 2 - r), Math.PI * 1.5],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= roundSegments; i++) {
      const a = a0 + (i / roundSegments) * (Math.PI / 2);
      points.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
      sharp.push(false);
    }
  }
  // With the default corner radius the straight sides have zero length, so each
  // arc ends exactly where the next begins. Left in, those duplicates are
  // zero-length edges and a band of degenerate quads all the way along a sweep.
  return dedupeClosed({ points, sharp });
}

/**
 * Regular polygon, every corner hard.
 *
 * Rolled and drawn bar stock has flats, and the flats are the point: a square
 * strut catches the light in three distinct planes where a round one gives a
 * single smeared highlight. That difference is most of what separates a
 * constructivist member from a piece of wire.
 */
export function polygon(sides: number, radius: number, rotate = 0): Profile {
  const points: Vec2[] = [];
  for (let i = 0; i < sides; i++) {
    const a = rotate + (i / sides) * Math.PI * 2;
    points.push([Math.cos(a) * radius, Math.sin(a) * radius]);
  }
  return { points, sharp: points.map(() => true) };
}

/** Drop points that coincide with their predecessor, wrapping at the seam. */
export function dedupeClosed(p: Profile, epsilon = 1e-7): Profile {
  const points: Vec2[] = [];
  const sharp: boolean[] = [];
  for (let i = 0; i < p.points.length; i++) {
    const previous = points[points.length - 1] ?? p.points[p.points.length - 1];
    const [x, y] = p.points[i];
    if (Math.hypot(x - previous[0], y - previous[1]) < epsilon) {
      // keep the crease if either of the merged points carried one
      if (p.sharp[i] && sharp.length) sharp[sharp.length - 1] = true;
      continue;
    }
    points.push(p.points[i]);
    sharp.push(p.sharp[i]);
  }
  return { points, sharp };
}

/** Teardrop, for beads and finial sections. */
export function teardrop(radius: number, point: number, segments = 20): Profile {
  const points: Vec2[] = [];
  const sharp: boolean[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const pinch = (1 + Math.cos(a)) / 2;
    points.push([Math.cos(a) * radius * (1 - 0.35 * pinch), Math.sin(a) * radius]);
    sharp.push(false);
  }
  points[0] = [radius + point, 0];
  sharp[0] = true;
  return { points, sharp };
}

/** Scale a profile without rebuilding it — the workhorse for tapers. */
export const scaleProfile = (p: Profile, s: number): Profile => ({
  points: p.points.map(([x, y]) => [x * s, y * s] as Vec2),
  sharp: p.sharp,
});

/**
 * Blend two profiles with matching point counts. Lets a sweep start as a round
 * wire and finish as a flat leaf without any boolean or blend operation.
 */
export function morphProfile(a: Profile, b: Profile, t: number): Profile {
  if (a.points.length !== b.points.length) {
    throw new Error('morphProfile needs profiles with equal point counts');
  }
  return {
    points: a.points.map(([x, y], i) => [
      x + (b.points[i][0] - x) * t,
      y + (b.points[i][1] - y) * t,
    ] as Vec2),
    sharp: a.sharp.map((s, i) => s || b.sharp[i]),
  };
}
