/**
 * A sheet of the painted edge's settled recipe, for looking at: boulders large, a row of them from a pebble's size to a
 * boulder's, a cliff of leaning slabs and a pile, each plain and painted, in the dusk-cool light the recipe was chosen
 * under, at four samples a pixel. It holds nothing but that each frame drew and that the paint changed it, since whether
 * a few ridges carry a crisp stroke that fades where they crowd and as a rock shrinks is a thing to see and not to sum.
 * Without it the recipe would only ever be seen in the shape of a test's knob moved one at a time.
 *
 * It writes only where VITE_FRAME_DIR names a directory, as `sheet <subject> <plain|painted>.png`, and is skipped,
 * saying so, where it does not.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { at as place, built, frustum, prism, seeded, type Place } from '../../mesh/lowpoly';
import { painted, split } from '../../mesh/paint';
import type { Mesh } from '../../mesh/types';
import { boulder } from '../../parts/lowpoly';
import { bakeEnvironment, type Environment } from '../../render/env';
import { DEFAULT_POST, FULL_ECONOMY, GameRenderer, type GameGroup, type Look } from '../renderer';
import { LightPool } from '../lights';
import { PAINT_DEFAULT, type PaintSet } from '../paint';
import { differing, readPixels, saveFrame, type Pixels } from './frame';

const FRAME_DIR: string | undefined = import.meta.env.VITE_FRAME_DIR;
if (!FRAME_DIR) console.log('painted sheet: VITE_FRAME_DIR is not set, so no sheet is drawn');

type C = [number, number, number];
const mix = (a: C, b: C, k: number): C => [a[0] * (1 - k) + b[0] * k, a[1] * (1 - k) + b[1] * k, a[2] * (1 - k) + b[2] * k];

const ROCK: C = [0.13, 0.12, 0.11];
const GRASS: C = [0.06235, 0.18412, 0.03765];
const SUN: C = [0.45, -0.5, 0.74];
const ZENITH: C = [0.55, 0.7, 0.88];
const HORIZON: C = [0.85, 0.9, 0.95];
const SUN_COLOUR: C = [2.9, 2.5, 1.9];

/** E12 D's "all" light: a cool deep shade, a cool fill at four tenths of the game's, a warm sun, occlusion tinted to the shade. */
const LOOK: Partial<Look> = {
  sunDir: SUN, sunColour: SUN_COLOUR, exposure: 0.92, ambient: 1,
  background: HORIZON, sky: { zenith: ZENITH, horizon: HORIZON, height: 0.25 },
  shading: 'toon', antialias: 'msaa', bandSoftness: 0.06, shadeColour: [0.13, 0.19, 0.34],
  rim: 0.4, rimColour: [1, 0.95, 0.85], rimWidth: 0.18, form: 3, shadowSoftness: 1.5,
  skyLight: [0.2, 0.25, 0.42], groundLight: [0.15, 0.17, 0.13],
  occlusion: 4, occlusionRadius: 12, occlusionTint: 1, occlusionDirect: 0.25,
};

/** The game's sky for the day, as an image to bake the environment from: zenith to horizon, a glow round the sun, grass below. */
function skyImage() {
  const S = 64, width = S * 2, height = S;
  const data = new Float32Array(width * height * 4);
  const [sx, sy, sz] = SUN;
  const sl = Math.hypot(sx, sy, sz);
  for (let row = 0; row < height; row++) {
    const up = Math.cos(((row + 0.5) / height) * Math.PI);
    const across = Math.sqrt(Math.max(0, 1 - up * up));
    for (let col = 0; col < width; col++) {
      const round = ((col + 0.5) / width) * Math.PI * 2;
      const toSun = Math.max(0, (Math.cos(round) * across * sx + Math.sin(round) * across * sy + up * sz) / sl);
      let c = up >= 0 ? mix(HORIZON, ZENITH, Math.min(1, up / 0.9) ** 0.8) : mix(HORIZON, GRASS, Math.min(1, -up * 3));
      c = mix(c, SUN_COLOUR, toSun ** 24 * 0.5);
      data.set([c[0], c[1], c[2], 1], (row * width + col) * 4);
    }
  }
  return { width, height, data, scale: 1 };
}

/** A placement: scaled by s, turned by `turn` about z, at (x, y, z). */
const at = (s: number, x: number, y: number, z: number, turn = 0) => {
  const c = Math.cos(turn), n = Math.sin(turn);
  return new Float32Array([c * s, n * s, 0, 0, -n * s, c * s, 0, 0, 0, 0, s, 0, x, y, z, 1]);
};

/** One thing to draw: its mesh and where it stands, and the paint it has for the painted frame. */
interface Thing { mesh: Mesh; matrix: Float32Array; paint: (mesh: Mesh) => Mesh }
interface Shot { w: number; h: number; things: Thing[]; fill: number; sets?: PaintSet[]; pull?: number }

/** The ridge choice at a budget, the settled recipe's spacing. */
const ridges = (budget: number) => (mesh: Mesh) => painted(split(mesh), { choice: 'ridge', ridge: { budget, spacing: 0.4 } });

/** The bounds of every thing, in the world. */
function bounds(things: Thing[]) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const t of things) {
    const m = t.matrix, p = t.mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      const w = [m[0] * p[i] + m[4] * p[i + 1] + m[8] * p[i + 2] + m[12], m[1] * p[i] + m[5] * p[i + 1] + m[9] * p[i + 2] + m[13], m[2] * p[i] + m[6] * p[i + 1] + m[10] * p[i + 2] + m[14]];
      for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], w[a]); hi[a] = Math.max(hi[a], w[a]); }
    }
  }
  return { lo, hi };
}

/** The convex hull of points in the plane: a prism's outline must be convex, and a jittered ring is not always. */
function hull(points: [number, number][]): [number, number][] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const turn = (o: [number, number], a: [number, number], c: [number, number]) => (a[0] - o[0]) * (c[1] - o[1]) - (a[1] - o[1]) * (c[0] - o[0]);
  const lower: [number, number][] = [], upper: [number, number][] = [];
  for (const q of p) {
    while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** An irregular convex outline of `n` points about a middle, `rx` by `ry`. */
function outline(random: () => number, n: number, rx: number, ry: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = ((i + 0.5 * random()) / n) * Math.PI * 2;
    const k = 0.6 + random() * 0.4;
    pts.push([Math.cos(a) * rx * k, Math.sin(a) * ry * k]);
  }
  return hull(pts);
}

/** Leaning `ax` about x and `ay` about y, then turned and moved: a turn, never a mirror. */
const leaning = (x: number, y: number, ax: number, ay: number, yaw = 0): Place => ([px, py, pz]) => {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  [px, py] = [c * px - s * py, s * px + c * py];
  const cy = Math.cos(ay), sy = Math.sin(ay), cx = Math.cos(ax), sx = Math.sin(ax);
  const x1 = cy * px + sy * pz, z1 = -sy * px + cy * pz;
  return [x + x1, y + cx * py - sx * z1, sx * py + cx * z1];
};

/** A cliff of ten broad prisms in three rows, each further back and taller, every one leaning back and sideways and sunk below the ground. */
function cliff(width = 16, height = 9, seed = 1): Mesh {
  const random = seeded(seed * 3571 + 29);
  const depth = width * 0.34;
  const rows = [
    { n: 4, y: -depth * 0.18, h: [0.42, 0.6] },
    { n: 3, y: depth * 0.02, h: [0.68, 0.85] },
    { n: 3, y: depth * 0.24, h: [0.88, 1.0] },
  ];
  return built((b) => {
    for (const [i, row] of rows.entries())
      for (let k = 0; k < row.n; k++) {
        const share = width / row.n;
        const cx = -width / 2 + share * (k + 0.5) + (random() - 0.5) * share * 0.25 + (i % 2) * share * 0.15;
        const h = height * (row.h[0] + random() * (row.h[1] - row.h[0]));
        const lean = leaning(cx, row.y + (random() - 0.5) * depth * 0.08, -(0.2 + random() * 0.2), (random() < 0.5 ? -1 : 1) * (0.15 + random() * 0.2), (random() - 0.5) * 0.25);
        prism(b, lean, outline(random, 8 + Math.floor(random() * 3), share * 0.9, depth * 0.34), -3, h);
      }
  });
}

const rock = (seed: number) => boulder(1, { seed, rings: 5, segments: 8 }).parts[0].mesh;
const GROUND = split(built((b) => frustum(b, place(0, 0, -1), 4, 4000, 4000, 0, 1, { top: true })));
const HIGH_TURN = 0.7;

describe.skipIf(!FRAME_DIR)('the painted edge, drawn for looking at', () => {
  let gpu: Gpu;
  let env: Environment;
  let r: GameRenderer;
  const targets = new Map<string, GPUTexture>();

  beforeAll(async () => {
    gpu = await createDevice();
    env = bakeEnvironment(gpu, 'daylight', { size: 128, mips: 6, image: skyImage() });
    await env.samples;
    r = new GameRenderer(gpu, 8, 8, 64);
    await r.ready;
    r.setEnvironment(env.specular, env.brdf, env.mips);
    r.setStatic([]);
    r.setLights(new LightPool(8));
    r.economy = { ...FULL_ECONOMY, shadows: true };
  });

  afterAll(() => {
    r?.dispose();
    for (const t of targets.values()) t.destroy();
    gpu?.device.destroy();
  });

  const targetFor = (w: number, h: number) => {
    const key = `${w}x${h}`;
    let t = targets.get(key);
    if (!t) {
      t = gpu.device.createTexture({ size: [w, h], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      targets.set(key, t);
    }
    return t;
  };

  /** The high camera, from straight behind and above at a distance that has the things fill `fill` of the frame. */
  function camera(things: Thing[], w: number, h: number, fill: number, pull = 1, lift = 0) {
    const { lo, hi } = bounds(things);
    const mid: C = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    const dir = [0, -0.6, 0.8];
    const fwd = dir.map((v) => -v), right = [1, 0, 0];
    const up = [fwd[1] * right[2] - fwd[2] * right[1], fwd[2] * right[0] - fwd[0] * right[2], fwd[0] * right[1] - fwd[1] * right[0]];
    const fov = 32, t = Math.tan((fov * Math.PI) / 360), aspect = w / h;
    const reach = (d: number) => {
      let m = 0;
      for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) {
        const v = [x - mid[0] - dir[0] * d, y - mid[1] - dir[1] * d, z - mid[2] - dir[2] * d];
        const depth = v[0] * fwd[0] + v[1] * fwd[1] + v[2] * fwd[2];
        m = Math.max(m, Math.abs(v[0] * right[0] / depth / (t * aspect)), Math.abs((v[0] * up[0] + v[1] * up[1] + v[2] * up[2]) / depth / t));
      }
      return m;
    };
    let d = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 2;
    for (let i = 0; i < 6; i++) d *= reach(d) / fill;
    const target: C = [mid[0], mid[1], mid[2] + lift];
    const radius = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
    return {
      fov, target,
      position: [target[0] + dir[0] * d * pull, target[1] + dir[1] * d * pull, target[2] + dir[2] * d * pull] as C,
      box: { min: [mid[0] - 3 * radius, mid[1] - 3 * radius, -5] as C, max: [mid[0] + 3 * radius, mid[1] + 3 * radius, hi[2] + radius] as C },
    };
  }

  /** One frame of a shot: its things plain or painted, on the ground, under the look. */
  async function frame(shot: Shot, cam: ReturnType<typeof camera>, paint: boolean, bare = false): Promise<Pixels> {
    const target = targetFor(shot.w, shot.h);
    r.resize(shot.w, shot.h);
    r.setSunShadow(cam.box);
    r.camera.fov = cam.fov; r.camera.near = 1; r.camera.far = 8000;
    r.camera.target = cam.target;
    r.camera.position = cam.position;
    r.look = { ...r.look, ...LOOK, paint: shot.sets };
    r.post = { ...DEFAULT_POST, bloom: 0.35, vignette: 0, grain: 0, tone: 'soft' };
    const groups: GameGroup[] = [{ mesh: GROUND, matrices: at(1, 0, 0, 0), albedo: GRASS, roughness: 0.9 }];
    if (!bare) for (const t of shot.things) groups.push({ mesh: paint ? t.paint(t.mesh) : split(t.mesh), matrices: t.matrix, albedo: ROCK, roughness: 0.9 });
    r.setDynamic(groups);
    await r.prepare();
    r.frame(target.createView());
    return readPixels(gpu, target);
  }

  /** Draws a subject plain and painted, writes both, and holds that each drew and the paint changed it. */
  async function sheet(subject: string, shot: Shot) {
    const cam = camera(shot.things, shot.w, shot.h, shot.fill, shot.pull, shot.pull ? 6 : 0);
    const empty = await frame(shot, cam, false, true);
    const plain = await frame(shot, cam, false);
    const paint = await frame(shot, cam, true);
    await saveFrame(`sheet ${subject} plain`, plain);
    await saveFrame(`sheet ${subject} painted`, paint);
    const covered = differing(empty, plain);
    const changed = differing(plain, paint);
    console.log(`sheet ${subject}: ${covered} pixels of the thing, ${changed} changed by the paint`);
    expect(covered, `${subject}: pixels the thing covers`).toBeGreaterThan(0);
    expect(changed, `${subject}: pixels the paint changed`).toBeGreaterThan(0);
  }

  it('draws a boulder, from the high camera and from a close one', async () => {
    const things: Thing[] = [{ mesh: rock(2), matrix: at(40, 0, 0, 0, HIGH_TURN), paint: ridges(3) }];
    await sheet('boulder high', { w: 512, h: 512, things, fill: 0.67, sets: [{ ...PAINT_DEFAULT }] });
    await sheet('boulder close', { w: 512, h: 512, things, fill: 0.67, pull: 0.4, sets: [{ ...PAINT_DEFAULT }] });
  });

  it('draws a row of eight boulders from a pebble to a boulder', async () => {
    const things: Thing[] = [];
    let x = 0;
    for (let i = 0; i < 8; i++) {
      const scale = 6 + (14 * i) / 7;
      x += i ? scale * 1.05 : 0;
      things.push({ mesh: rock(i + 1), matrix: at(scale, x, 0, 0, HIGH_TURN), paint: ridges(i < 2 ? 1 : i < 5 ? 2 : 3) });
      x += scale * 1.05;
    }
    await sheet('row', { w: 1024, h: 384, things, fill: 0.8, sets: [{ ...PAINT_DEFAULT }] });
  });

  it('draws a cliff of ten leaning prisms, painted by the gate on a set of its own', async () => {
    const things: Thing[] = [{ mesh: cliff(), matrix: at(10, 0, 0, 0, 0.15), paint: (mesh) => painted(split(mesh), { set: 1, choice: 'gate' }) }];
    await sheet('cliff', { w: 768, h: 512, things, fill: 0.7, sets: [{}, { widthFacet: 0.06, gate: 0.45 }] });
  });

  it('draws a pile of five boulders, each its own group with its own budget', async () => {
    const lumps: [number, number, number, number, number][] = [
      // seed, scale, x, y, z
      [11, 30, 0, 0, 0], [12, 22, 24, 6, 0], [13, 20, -22, 8, 0], [14, 18, 8, -22, 0], [15, 16, -10, 20, 14],
    ];
    const things: Thing[] = lumps.map(([seed, scale, x, y, z], k) => ({ mesh: rock(seed), matrix: at(scale, x, y, z, HIGH_TURN + k), paint: ridges(2) }));
    await sheet('pile', { w: 512, h: 512, things, fill: 0.7, sets: [{ ...PAINT_DEFAULT }] });
  });
});
