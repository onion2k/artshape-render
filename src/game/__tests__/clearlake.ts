/**
 * A lake for the clear water's detail layer tests, rebuilt as part 11's experiment rebuilt it from part 0's report: a
 * rounded outline holding a ramp of sand, a shallow rock standing in the water and one on the bank, five low-poly
 * conifers on the far bank for the mirror to show, ooerfish's water over it, and its shore field. Beside it, the pond's
 * two posts, and the far-water mask and shimmer count the experiment measured with, so the figures here can be laid
 * beside its figures. Without it each test would rebuild the lake its own way, and a count could not be compared.
 */
import { MeshBuilder, type Mesh } from '../../mesh/types';
import { boulder, conifer } from '../../parts/lowpoly';
import { FLOW_CLEAR, packFlow } from '../flow';
import { PATTERN_STRIDE, type GameGroup } from '../renderer';
import type { ShoreField } from '../shore';
import type { ClearWater } from '../clear';
import type { Pixels } from './frame';
import { bedAt, box } from './clearscene';
import { median } from './perf';

type Rgb = [number, number, number];
export type Cam = { position: [number, number, number]; target: [number, number, number]; fov: number };

const R = 10.5;
const outline = (a: number) => R * (1 + 0.06 * Math.sin(3 * a + 0.5) + 0.04 * Math.cos(2 * a));
const beyond = (x: number, y: number) => Math.hypot(x, y) - outline(Math.atan2(y, x));
const ramp = (x: number) => -0.2 + Math.min(Math.max((x + R) / (2 * R), 0), 1) * -5.8;
/** The lake's ground: the ramp of depth inside the outline, shelving up at 0.6 to a bank 0.6 high. */
export const ground = (x: number, y: number) => {
  const d = beyond(x, y);
  return d < 0 ? Math.max(ramp(x), 0.6 * d) : Math.min(0.6, 0.6 * d);
};
const SAND: Rgb = [0.75, 0.68, 0.5], GRASS: Rgb = [0.2, 0.42, 0.14], WEED: Rgb = [0.2, 0.4, 0.15], ROCK: Rgb = [0.55, 0.55, 0.52];
const ONE = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const translate = (x: number, y: number, z: number, k = 1) => new Float32Array([k, 0, 0, 0, 0, k, 0, 0, 0, 0, k, 0, x, y, z, 1]);

/** A grid over a square, heights by `h`, its quads sorted into the meshes `which` names. */
function terrain(half: number, step: number, h: (x: number, y: number) => number, which: (zMax: number) => number, count: number): Mesh[] {
  const bs = Array.from({ length: count }, () => new MeshBuilder());
  const n = Math.round((2 * half) / step);
  const e = 0.05;
  const v = (b: MeshBuilder, x: number, y: number) => {
    const nx = -(h(x + e, y) - h(x - e, y)) / (2 * e), ny = -(h(x, y + e) - h(x, y - e)) / (2 * e), l = Math.hypot(nx, ny, 1);
    b.vertex(x, y, h(x, y), nx / l, ny / l, 1 / l, 0, 0);
  };
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const x0 = -half + i * step, y0 = -half + j * step, x1 = x0 + step, y1 = y0 + step;
      const b = bs[which(Math.max(h(x0, y0), h(x1, y0), h(x1, y1), h(x0, y1)))];
      const a = b.vertexCount;
      v(b, x0, y0); v(b, x1, y0); v(b, x1, y1); v(b, x0, y1);
      b.quad(a, a + 1, a + 2, a + 3);
    }
  return bs.map((b) => b.build());
}

export const SHALLOW_ROCK = { x: 1.5, y: 8.2, across: 2.6, top: 0.4 };
const BANK_ROCK = { x: -4.5, y: 12.2, across: 2.4 };

function rock(across: number, seed: number) {
  const mesh = boulder(1, { seed }).parts[0].mesh;
  let lo = Infinity, hi = -Infinity, zMax = -Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    lo = Math.min(lo, mesh.positions[i]); hi = Math.max(hi, mesh.positions[i]);
    zMax = Math.max(zMax, mesh.positions[i + 2]);
  }
  return { mesh, k: across / (hi - lo), zMax };
}

/** The lake: its land and trees, its water, its shore field, and how far out from its middle the shallow rock meets the water. */
export function lake() {
  const [sand, grass] = terrain(24, 0.3, ground, (z) => (z < 0.03 ? 0 : 1), 2);
  const weed = terrain(2, 0.25, (x, y) => ground(x + 4, y - 3) + 0.03, () => 0, 1)[0];
  const shallow = rock(SHALLOW_ROCK.across, 3), bank = rock(BANK_ROCK.across, 5);
  const z0 = SHALLOW_ROCK.top - shallow.zMax * shallow.k;
  // where the shallow rock meets the water, from its own vertices near the surface
  let sum = 0, n = 0;
  for (let i = 0; i < shallow.mesh.positions.length; i += 3) {
    const z = z0 + shallow.mesh.positions[i + 2] * shallow.k;
    if (Math.abs(z) < 0.12) { sum += Math.hypot(shallow.mesh.positions[i], shallow.mesh.positions[i + 1]) * shallow.k; n++; }
  }
  const waterline = n ? sum / n : 0.7;
  const trees: GameGroup[] = [];
  const places: [number, number, number][] = [[-0.5, 13.4, 6], [3, 13.8, 7], [6.5, 12.6, 5.5], [-8.5, 9.8, 6.5], [9.5, 7.5, 5]];
  places.forEach(([x, y, height], i) => {
    for (const part of conifer({ height, seed: i + 1 }).parts)
      trees.push({ mesh: part.mesh, matrices: translate(x, y, ground(x, y) - 0.1), albedo: part.name === 'trunk' ? [0.25, 0.15, 0.08] : [0.08, 0.26, 0.12], roughness: 0.9 });
  });
  const land: GameGroup[] = [
    { mesh: sand, matrices: ONE, albedo: SAND, roughness: 0.9 },
    { mesh: grass, matrices: ONE, albedo: GRASS, roughness: 0.9 },
    { mesh: weed, matrices: translate(4, -3, 0), albedo: WEED, roughness: 0.9 },
    { mesh: shallow.mesh, matrices: translate(SHALLOW_ROCK.x, SHALLOW_ROCK.y, z0, shallow.k), albedo: ROCK, roughness: 0.8 },
    { mesh: bank.mesh, matrices: translate(BANK_ROCK.x, BANK_ROCK.y, ground(BANK_ROCK.x, BANK_ROCK.y) - 0.05, bank.k), albedo: ROCK, roughness: 0.8 },
    ...trees,
  ];
  // the water: a sheet cut fine enough for the swells, given ooerfish's flow
  const b = new MeshBuilder();
  const cuts = 128, half = 13;
  for (let j = 0; j <= cuts; j++) for (let i = 0; i <= cuts; i++) b.vertex(-half + (2 * half * i) / cuts, -half + (2 * half * j) / cuts, 0, 0, 0, 1, 0, 0);
  for (let j = 0; j < cuts; j++) for (let i = 0; i < cuts; i++) { const a = j * (cuts + 1) + i; b.quad(a, a + 1, a + cuts + 2, a + cuts + 1); }
  const patterns = packFlow(new Float32Array(PATTERN_STRIDE), 0, { kind: FLOW_CLEAR, scale: 2.4, speed: 0.12, glow: 0.3, second: [0.06, 0.26, 0.52] });
  const water: GameGroup = { mesh: b.build(), matrices: ONE, albedo: [0.08, 0.36, 0.7], roughness: 0.1, patterns };
  // the shore field: how far each point of the water is from the bank or the shallow rock
  const size = 192, lo = -13, hi = 13;
  const distances = new Float32Array(size * size);
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      const x = lo + ((hi - lo) * (i + 0.5)) / size, y = lo + ((hi - lo) * (j + 0.5)) / size;
      const toRock = Math.max(Math.hypot(x - SHALLOW_ROCK.x, y - SHALLOW_ROCK.y) - waterline, 0);
      distances[j * size + i] = ground(x, y) >= 0 ? 0 : Math.min(Math.max(-beyond(x, y), 0), toRock);
    }
  const field: ShoreField = { size, distances, min: [lo, lo], max: [hi, hi] };
  return { land, water, field, waterline };
}

/** ooerfish's clear water at b59aa0e and after, clean, with the scene mirrored: its CLEAR, CLEAR_WAVES and palette. */
export const LAKE_CLEAR: Partial<ClearWater> = {
  clarity: 0.8, foamWidth: 0.3, foamSoft: 0.02, foamGap: 0.35, foamWidth2: 0, glitter: 0, caustics: 0.12,
  waves: [
    { direction: 1.2, wavelength: 3, amplitude: 0.012, steepness: 0.38 },
    { direction: 2.1, wavelength: 2, amplitude: 0.008, steepness: 0.38 },
    { direction: 0.6, wavelength: 1.5, amplitude: 0.005, steepness: 0.15 },
    { direction: 1.7, wavelength: 4, amplitude: 0.012, steepness: 0.1 },
  ],
  near: [0.015, 0.09, 0.3], nearDistance: 45 * (R / 30), crest: [0.8, 0.97, 1], crestAmount: 0,
  sparkles: 0.3, sparkleCut: 0.45, sparkleBright: 24, sparkleSize: 9,
  mirrorTint: [0.35, 0.62, 0.92], mirrorNear: 0, mirror: 1.2, mirrorScene: true, mirrorDistort: 0.08,
  ripple: [0.28, 0.52, 0.88], rippleAmount: 0.3, rippleCut: 0.4,
};

/** The lake's day look, as the experiment drew it: toon at four samples, with the sky and the soft tone map. */
export const LAKE_LOOK = {
  shading: 'toon', antialias: 'msaa', sunDir: [0.45, -0.5, 0.74], sunColour: [2.9, 2.5, 1.9], exposure: 0.92, ambient: 1,
  background: [0.85, 0.9, 0.95], sky: { zenith: [0.55, 0.7, 0.88], horizon: [0.85, 0.9, 0.95], height: 0.25 },
  bandSoftness: 0.06, shadeColour: [0.13, 0.19, 0.34], rim: 0.4, rimColour: [1, 0.95, 0.85], rimWidth: 0.18, skyLight: [0.2, 0.25, 0.42],
  groundLight: [0.15, 0.17, 0.13], form: 4, shadowSoftness: 1.5, waterShadow: true,
} as const;

/** The golden's water over the pond, with the scene mirrored. */
export const POND_CLEAR: Partial<ClearWater> = { clarity: 1.5, foamWidth: 0.6, refraction: 1, glitter: 1, caustics: 1, causticScale: 1.5, mirrorScene: true };

/** The pond's two posts, 0.6 across, standing out of its far water: a white one at (-2.5, 4.5) and a dark one at (2.5, 5.5). */
export const POSTS = [
  { x: -2.5, y: 4.5, rise: 1.6, albedo: [0.9, 0.9, 0.9] as Rgb },
  { x: 2.5, y: 5.5, rise: 2.2, albedo: [0.12, 0.1, 0.09] as Rgb },
];
export const POST_HALF = 0.3;
export function posts(): GameGroup[] {
  const at = (x: number, y: number, rise: number) => new Float32Array([0.6, 0, 0, 0, 0, 0.6, 0, 0, 0, 0, rise - bedAt(x), 0, x, y, bedAt(x), 1]);
  return POSTS.map((p) => ({ mesh: box(), matrices: at(p.x, p.y, p.rise), albedo: p.albedo, roughness: 0.9 }));
}

const k = R / 30;
const spherical = (target: [number, number, number], azimuth: number, polar: number, radius: number): Cam => ({
  target,
  position: [target[0] + radius * Math.sin(polar) * Math.cos(azimuth), target[1] + radius * Math.sin(polar) * Math.sin(azimuth), target[2] + radius * Math.cos(polar)],
  fov: 40,
});
export const VIEWS = {
  pond: { position: [0, -12, 10], target: [0, 0, -1], fov: 40 } as Cam,
  'lake shore': spherical([0, 4 * k, 0], -1.57, 1.3, 62 * k),
};

/**
 * Which pixels of a view are open water, and which of those are the far water: the pixel's ray met the water's plane
 * inside the pond or the lake, clear of what stands in it, and further from the camera than the median of the water
 * seen. The near water moves with the swells anyway; the far water is where shimmer would be the layer's.
 */
export function masks(cam: Cam, w: number, h: number, inWater: (x: number, y: number) => boolean, standing: { x: number; y: number; z: number; r: number }[]) {
  const [px, py, pz] = cam.position;
  const f = cam.target.map((t, i) => t - cam.position[i]);
  const fl = Math.hypot(...f); f.forEach((_, i) => (f[i] /= fl));
  const right = [f[1], -f[0], 0]; const rl = Math.hypot(...right); right.forEach((_, i) => (right[i] /= rl));
  const up = [right[1] * f[2] - right[2] * f[1], right[2] * f[0] - right[0] * f[2], right[0] * f[1] - right[1] * f[0]];
  const t = Math.tan((cam.fov / 2) * (Math.PI / 180)), aspect = w / h;
  const dist = new Float32Array(w * h).fill(-1);
  const seen: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const nx = ((x + 0.5) / w) * 2 - 1, ny = 1 - ((y + 0.5) / h) * 2;
      const d = [0, 1, 2].map((i) => f[i] + right[i] * nx * t * aspect + up[i] * ny * t);
      if (d[2] >= 0) continue;
      const s = -pz / d[2];
      const wx = px + d[0] * s, wy = py + d[1] * s;
      if (!inWater(wx, wy)) continue;
      // clear of anything standing in the water: the ray's nearest approach to it is outside it
      const blocked = standing.some((o) => {
        const ox = o.x - px, oy = o.y - py, oz = o.z - pz;
        const dl = Math.hypot(...d);
        const along = (ox * d[0] + oy * d[1] + oz * d[2]) / dl;
        const off = Math.sqrt(Math.max(ox * ox + oy * oy + oz * oz - along * along, 0));
        return along < s * dl && off < o.r;
      });
      if (blocked) continue;
      dist[y * w + x] = s * Math.hypot(...d);
      seen.push(dist[y * w + x]);
    }
  const cut = median(seen);
  const all = new Uint8Array(w * h), far = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) { all[i] = dist[i] >= 0 ? 1 : 0; far[i] = dist[i] >= cut ? 1 : 0; }
  return { all, far, cut };
}

/** A pixel has shimmered between two frames when a channel moved by more than this many levels, as the experiment counted. */
export const SHIMMER_LEVELS = 4;

/** How many pixels in the mask moved by more than SHIMMER_LEVELS in a channel between two frames. */
export function shimmered(a: Pixels, b: Pixels, mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const j = i * 3;
    if (Math.abs(a.rgb[j] - b.rgb[j]) > SHIMMER_LEVELS || Math.abs(a.rgb[j + 1] - b.rgb[j + 1]) > SHIMMER_LEVELS || Math.abs(a.rgb[j + 2] - b.rgb[j + 2]) > SHIMMER_LEVELS) n++;
  }
  return n;
}
