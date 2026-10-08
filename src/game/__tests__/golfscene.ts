/**
 * A small golf scene for the GPU tests of v0.28.0's settings: boxes, open water, and the toon look a golf game asks
 * for, in yards. Shared, so the test that holds a game which asks for nothing to v0.27.1's pixels and the tests of what
 * is asked for draw the same things.
 */
import { MeshBuilder, type Mesh } from '../../mesh/types';
import { GameRenderer, PATTERN_STRIDE, type GameGroup } from '../renderer';
import { FLOW_WATER, packFlow } from '../flow';
import type { Pixels } from './frame';

/** A unit box standing on its base, each face its own four corners. */
export function unitBox(): Mesh {
  const b = new MeshBuilder();
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, -1, 0], [0, 0, 1]],
    [[0, 1, 0], [-1, 0, 0], [0, 0, 1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [n, u, v] of faces) {
    const base = b.vertexCount;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = [0, 1, 2].map((k) => (n[k] + su * u[k] + sv * v[k]) / 2 + (k === 2 ? 0.5 : 0));
      b.vertex(p[0], p[1], p[2], n[0], n[1], n[2], 0, 0);
    }
    b.quad(base, base + 1, base + 2, base + 3);
  }
  return b.build();
}

/** A box `w` by `d` by `h`, its base centre at `x`, `y`, `z`. */
export function block(w: number, d: number, h: number, x: number, y: number, z: number, albedo: [number, number, number]): GameGroup {
  const m = new Float32Array(16);
  m[0] = w; m[5] = d; m[10] = h; m[12] = x; m[13] = y; m[14] = z; m[15] = 1;
  return { mesh: unitBox(), matrices: m, albedo, roughness: 0.9 };
}

/** Open water: a flat sheet `w` by `d` with its top at `z`, in the open-water kind. */
export function water(w: number, d: number, x: number, y: number, z: number): GameGroup {
  const g = block(w, d, 0.01, x, y, z - 0.01, [0.05, 0.4, 0.9]);
  const patterns = new Float32Array(PATTERN_STRIDE);
  packFlow(patterns, 0, { kind: FLOW_WATER, scale: 0.3, speed: 0.55, glow: 0.8, second: [0.7, 0.9, 1] });
  return { ...g, roughness: 0.08, patterns };
}

/** The scene: the ground, casters on it, a pond with a post over it, all in yards as a golf game is. */
export const GROUND: GameGroup[] = [
  block(400, 400, 1, 0, 100, -1, [0.1, 0.42, 0.03]),
  block(4, 4, 18, -12, 30, 0, [0.6, 0.3, 0.15]),
  block(8, 3, 6, 10, 45, 0, [0.8, 0.8, 0.8]),
  block(3, 3, 10, 2, 66, 0, [0.6, 0.3, 0.15]),
  water(30, 20, 0, 70, 0.02),
];

/** The toon look a golf game asks for, with nothing of v0.28.0's. */
export function golfLook(r: GameRenderer) {
  r.look = {
    ...r.look,
    sunDir: [0.35, -0.3, 0.89],
    sunColour: [2.55, 2.42, 2.22],
    ambient: 1,
    background: [0.45, 0.72, 0.98],
    shading: 'toon',
    occlusion: 0,
    bandSoftness: 0.06,
    shadeColour: [0.36, 0.38, 0.78],
    rim: 0.35,
    rimColour: [1, 0.95, 0.85],
    rimWidth: 0.18,
    skyLight: [0.5, 0.6, 0.75],
    groundLight: [0.38, 0.34, 0.22],
    form: 2.5,
  };
  r.post = { ...r.post, vignette: 0, grain: 0, tone: 'soft' };
}

/** A hash of the pixels, which says only whether two frames are the same. */
export function fnv(p: Pixels): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < p.rgb.length; i++) h = Math.imul(h ^ p.rgb[i], 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

