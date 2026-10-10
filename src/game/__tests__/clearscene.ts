/**
 * The clear water tests' pond: a ramp of mud from just under the surface at the west to six units down at the east, a
 * white box on it in the shallows and another in the deep, and the water over it all. Shared by the tests that hold
 * what clear water draws and by the golden that holds it to its pixels at v0.29.0.
 */
import { MeshBuilder, type Mesh } from '../../mesh/types';
import { PATTERN_STRIDE, type GameGroup } from '../renderer';
import { FLOW_CLEAR, packFlow } from '../flow';

export const SHALLOW: [number, number, number] = [0.3, 0.75, 0.75];
export const DEEP: [number, number, number] = [0.02, 0.12, 0.28];
export const MUD: [number, number, number] = [0.45, 0.35, 0.2];
export const WHITE: [number, number, number] = [0.9, 0.9, 0.9];
/** The bed: a ramp from just under the surface at the west edge to six units down at the east. */
export const BED_WEST = -0.2, BED_EAST = -6, HALF = 7;
export const bedAt = (x: number) => BED_WEST + ((x + HALF) / (2 * HALF)) * (BED_EAST - BED_WEST);

/** A flat quad, given its four corners, facing up. */
export function quad(corners: [number, number, number][]): Mesh {
  const b = new MeshBuilder();
  for (const [x, y, z] of corners) b.vertex(x, y, z, 0, 0, 1, 0, 0);
  b.quad(0, 1, 2, 3);
  return b.build();
}

/** A box one unit each way, standing on z = 0, centred in x and y. */
export function box(): Mesh {
  const b = new MeshBuilder();
  const f = (p: [number, number, number][], n: [number, number, number]) => {
    const a = b.vertexCount;
    for (const [x, y, z] of p) b.vertex(x, y, z, n[0], n[1], n[2], 0, 0);
    b.quad(a, a + 1, a + 2, a + 3);
  };
  const h = 0.5;
  f([[-h, -h, 1], [h, -h, 1], [h, h, 1], [-h, h, 1]], [0, 0, 1]);
  f([[-h, -h, 0], [h, -h, 0], [h, -h, 1], [-h, -h, 1]], [0, -1, 0]);
  f([[h, h, 0], [-h, h, 0], [-h, h, 1], [h, h, 1]], [0, 1, 0]);
  f([[h, -h, 0], [h, h, 0], [h, h, 1], [h, -h, 1]], [1, 0, 0]);
  f([[-h, h, 0], [-h, -h, 0], [-h, -h, 1], [-h, h, 1]], [-1, 0, 0]);
  return b.build();
}

export const one = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
export const boxAt = (x: number, y: number) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.9, 0, x, y, bedAt(x), 1]);

/** The ramp of mud, and a white box on it in the shallows and another in the deep. */
export function bed(): GameGroup[] {
  const ramp = quad([[-HALF, -HALF, BED_WEST], [HALF, -HALF, BED_EAST], [HALF, HALF, BED_EAST], [-HALF, HALF, BED_WEST]]);
  const boxes = new Float32Array(32);
  boxes.set(boxAt(-4.5, 2), 0);
  boxes.set(boxAt(4.5, 2), 16);
  return [
    { mesh: ramp, matrices: one, albedo: MUD, roughness: 0.9 },
    { mesh: box(), matrices: boxes, albedo: WHITE, roughness: 0.9 },
  ];
}

/** The water over it all, flat, at nought. */
export function water(kind = FLOW_CLEAR, steepness = 0): GameGroup {
  const patterns = packFlow(new Float32Array(PATTERN_STRIDE), 0, { kind, scale: 0.4, speed: 0.5, glow: steepness, second: DEEP });
  return { mesh: quad([[-HALF, -HALF, 0], [HALF, -HALF, 0], [HALF, HALF, 0], [-HALF, HALF, 0]]), matrices: one, albedo: SHALLOW, roughness: 0.1, patterns };
}


/** The same water cut `n` by `n`, fine enough for its swells to bend, over nothing. */
export function sheet(n: number, kind = FLOW_CLEAR, steepness = 0): GameGroup {
  const b = new MeshBuilder();
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) b.vertex(-HALF + (2 * HALF * i) / n, -HALF + (2 * HALF * j) / n, 0, 0, 0, 1, 0, 0);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      b.quad(a, a + 1, a + n + 2, a + n + 1);
    }
  return { ...water(kind, steepness), mesh: b.build() };
}
