/**
 * The scenes the perf gate times and the goldens draw: the standard scene, the shore and the painted standard. They are
 * here and not in `perf.gpu.test.ts` so that a test which imports them does not register the perf suite in its own file.
 */
import { MeshBuilder, type Mesh } from '../../mesh/types';
import { painted, split } from '../../mesh/paint';
import { boulder } from '../../parts/lowpoly';
import type { GameGroup } from '../renderer';

/** A flat square of `size`, facing up. */
function plane(size: number): Mesh {
  const b = new MeshBuilder();
  const s = size / 2;
  b.vertex(-s, -s, 0, 0, 0, 1, 0, 0);
  b.vertex(s, -s, 0, 0, 0, 1, 1, 0);
  b.vertex(s, s, 0, 0, 0, 1, 1, 1);
  b.vertex(-s, s, 0, 0, 0, 1, 0, 1);
  b.quad(0, 1, 2, 3);
  return b.build();
}

/** A unit box standing on its base, each face its own four corners. */
function box(): Mesh {
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

/**
 * The standard scene: a ground eighty units across with a grid of four
 * hundred boxes on it, in ooergolf's look (toon, a straight tone, daylight,
 * a sun shadow, occlusion and a thin haze) and from its home view. It holds
 * the game path as a whole, for every game on it, and is what a feature's
 * own scene is measured over.
 */
export function standardScene(): GameGroup[] {
  const boxes = new Float32Array(400 * 16);
  for (let i = 0; i < 400; i++) {
    const x = (i % 20) * 4 - 38, y = Math.floor(i / 20) * 4 - 38;
    boxes.set([1.2, 0, 0, 0, 0, 1.2, 0, 0, 0, 0, 1.6, 0, x, y, 0, 1], i * 16);
  }
  return [
    { mesh: plane(600), matrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), albedo: [0.1, 0.42, 0.08], roughness: 0.85 },
    { mesh: box(), matrices: boxes, albedo: [0.58, 0.3, 0.13], roughness: 0.55 },
  ];
}

/**
 * The shore: two hundred boulders (`boulder(1, { seed, rings: 5, segments: 8 })` at seeds one to two hundred, scaled two
 * to six by seed) scattered over the standard ground in a square sixty units across by a hash of their seed, each its own
 * group, with the standard ground under them and nothing else. Painted, each carries the ridge choice at a budget of
 * three; plain, each is the same mesh cut apart and unpainted, so the paint's own cost is the pair's difference.
 */
export function shoreScene(paint: boolean): GameGroup[] {
  const hash = (n: number) => { let h = Math.imul(n + 1, 374761393); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  const groups: GameGroup[] = [standardScene()[0]];
  for (let seed = 1; seed <= 200; seed++) {
    const scale = 2 + (4 * (seed - 1)) / 199;
    const x = (hash(seed * 4 + 1) - 0.5) * 60, y = (hash(seed * 4 + 2) - 0.5) * 60, turn = hash(seed * 4 + 3) * Math.PI * 2;
    const [c, n] = [Math.cos(turn) * scale, Math.sin(turn) * scale];
    const mesh = split(boulder(1, { seed, rings: 5, segments: 8 }).parts[0].mesh);
    groups.push({
      mesh: paint ? painted(mesh, { choice: 'ridge', ridge: { budget: 3, spacing: 0.4 } }) : mesh,
      matrices: new Float32Array([c, n, 0, 0, -n, c, 0, 0, 0, 0, scale, 0, x, y, 0, 1]),
      albedo: [0.13, 0.12, 0.11], roughness: 0.9,
    });
  }
  return groups;
}

/** The standard scene with its boxes' meshes cut apart and painted by the gate's choice, the default set, and the ground plain. */
export function paintedStandard(): GameGroup[] {
  const [ground, boxes] = standardScene();
  return [ground, { ...boxes, mesh: painted(split(boxes.mesh), { choice: 'gate' }) }];
}
