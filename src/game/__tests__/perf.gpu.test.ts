/**
 * The game path's frame, timed on this machine's GPU and held to the
 * baseline kept for it in `perf-baseline.json`, both ways, by `perf.ts`.
 *
 * Skipped unless VITE_PERF is set, so `npm run test:gpu` stays pixel checks
 * and no slower: `npm run perf:gpu` runs it, and `npm run perf:gpu:update`
 * writes this adapter's figures as its baseline. An adapter never measured
 * passes, and says it has nothing to be held to.
 *
 * The time is throughput: thirty frames submitted, the queue waited on, and
 * the wall time shared among them; the median of seven such runs after ten
 * to warm up, and three hundred before the first scene of all. It includes the submission and not the display, which is the
 * part of a frame the renderer owns. Two runs of the same tree on an M4 Pro
 * agreed within 1–6%.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server } from '@vitest/browser/context';
import { createDevice, type Gpu } from '../../gpu/context';
import { MeshBuilder, type Mesh } from '../../mesh/types';
import { bakeEnvironment } from '../../render/env';
import { FULL_ECONOMY, GameRenderer, type GameGroup, type Look } from '../renderer';
import { noFog } from '../fog';
import { LightPool } from '../lights';
import { grassGround, type GrassField, type GrassKind } from '../grass';
import { FLOW_CLEAR, FLOW_CRUST, FLOW_DRIFT, FLOW_RIPPLE, FLOW_WATER, packFlow } from '../flow';
import { packTexture } from '../texture';
import leafAlpha from './fixtures/leaf-alpha-256.b64?raw';
import { judge, median, recorded } from './perf';
import type { Emit } from '../particles';
import type { Wash } from '../wash';

const W = 1280, H = 800;
const BASELINE = 'src/game/__tests__/perf-baseline.json';
const UPDATE = !!import.meta.env.VITE_PERF_UPDATE;
/** What the golf field may add to the standard scene's frame, on the reference adapter: the spec's budget. */
const GRASS_BUDGET_MS = 2.0;
const REFERENCE = 'apple/metal-3';
/**
 * Frames drawn before the first scene is timed. A GPU that has sat idle
 * while the renderer was set up runs slow for a while: the scene timed
 * first read 0.70 ms against its 0.60 in four of eight runs on a quiet
 * machine, and every scene after it read steady. Three hundred frames
 * first held it at 0.59-0.60 in six of six. Each scene's own ten are enough
 * once the GPU is going.
 */
const WARM_UP = 300;

/** The particle pool's size: room for a fire's twelve thousand live particles. The standard scene has none of them, and an idle pool costs a frame nothing. */
const FIRE_POOL = 16384;
/**
 * A forest fire's worth of particles, in the golf's units (a tenth of a metre):
 * smoke that rises from one place and swells, dark at its start and pale at
 * its end, and embers that fly off it and fall. Each frame emits 45 smoke, which
 * lives four seconds, and 12 embers of a second and a half, which is about
 * 11,900 live once it has filled.
 */
const FIRE: Emit[] = [
  { position: [0, 0, 0.5], velocity: [0, 0, 5], spread: 2, count: 45, life: 4, size: 1.2, growth: 0.5, colour: [0.08, 0.07, 0.07], fade: [0.75, 0.75, 0.78], alpha: 0.7, gravity: -0.1, floor: 0 },
  { position: [0, 0, 0.5], velocity: [0, 0, 6], spread: 5, count: 12, life: 1.5, size: 0.15, colour: [1, 0.55, 0.1], fade: [0.5, 0.05, 0.02], alpha: 0, gravity: 0.3, floor: 0 },
];
/** A rotor's air over the fire: a hub a few units above the smoke's top, blowing it down and out. */
const FIRE_WASH: Wash = { position: [0, 0, 14], radius: 5, speed: 15, reach: 20 };
/** The same air at a thousandth of the speed: the particles are where they would be with none, and the update does all its sums. */
const FIRE_WASH_COST: Wash = { ...FIRE_WASH, speed: 0.015 };

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

/** A flat rectangle `w` along x and `h` along y, facing up, its mesh units the world's own. */
function strip(w: number, h: number): Mesh {
  const b = new MeshBuilder();
  b.vertex(-w / 2, -h / 2, 0, 0, 0, 1, 0, 0);
  b.vertex(w / 2, -h / 2, 0, 0, 0, 1, 1, 0);
  b.vertex(w / 2, h / 2, 0, 0, 0, 1, 1, 1);
  b.vertex(-w / 2, h / 2, 0, 0, 0, 1, 0, 1);
  b.quad(0, 1, 2, 3);
  return b.build();
}

/** The same rectangle cut `nx` by `ny`, fine enough for the clear pass's swells to bend: ooerfish's pond is 24 by 128. */
function sheet(w: number, h: number, nx: number, ny: number): Mesh {
  const b = new MeshBuilder();
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx; i++) b.vertex(-w / 2 + (w * i) / nx, -h / 2 + (h * j) / ny, 0, 0, 0, 1, i / nx, j / ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      b.quad(a, a + 1, a + nx + 2, a + nx + 1);
    }
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
 * A bush of cards: two thousand small squares (four thousand triangles) scattered through a ball of about a unit
 * across, each turned and tilted by a hash of its number so that the same mesh is made every run, their uvs running
 * nought to one. It is a game's leaf cluster, which is what the cut is for.
 */
export function cardBush(): Mesh {
  const b = new MeshBuilder();
  const hash = (n: number) => { let h = Math.imul(n + 1, 374761393); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  for (let i = 0; i < 2000; i++) {
    const [u, v, w, yaw, tilt] = [1, 2, 3, 4, 5].map((k) => hash(i * 8 + k));
    const cx = (u - 0.5) * 1.2, cy = (v - 0.5) * 1.2, cz = 0.2 + w * 1.2;
    const [cyaw, syaw, ct, st] = [Math.cos(yaw * 6.283), Math.sin(yaw * 6.283), Math.cos(tilt * 1.5), Math.sin(tilt * 1.5)];
    // the square's edge along (cos yaw, sin yaw, 0) and its other along the tilt, a half unit across
    const ex = [cyaw * 0.1, syaw * 0.1, 0], fy = [-syaw * ct * 0.1, cyaw * ct * 0.1, st * 0.1];
    const n = [ex[1] * fy[2] - ex[2] * fy[1], ex[2] * fy[0] - ex[0] * fy[2], ex[0] * fy[1] - ex[1] * fy[0]];
    const len = Math.hypot(n[0], n[1], n[2]);
    const base = b.vertexCount;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]])
      b.vertex(cx + su * ex[0] + sv * fy[0], cy + su * ex[1] + sv * fy[1], cz + su * ex[2] + sv * fy[2], n[0] / len, n[1] / len, n[2] / len, (su + 1) / 2, (sv + 1) / 2);
    b.quad(base, base + 1, base + 2, base + 3);
  }
  return b.build();
}

/** The real leaf's alpha, 256 across, as a white image: a game's mask, made with its alpha unfolded. */
async function leafMask(): Promise<ImageBitmap> {
  const alpha = Uint8Array.from(atob(leafAlpha.trim()), (c) => c.charCodeAt(0));
  const data = new Uint8ClampedArray(256 * 256 * 4).fill(255);
  for (let i = 0; i < alpha.length; i++) data[i * 4 + 3] = alpha[i];
  return createImageBitmap(new ImageData(data, 256, 256), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

/** A layer of two-tone noise in blocks of two texels, colour and height alike, about mid-grey: made here, since a game's is its own. */
async function noiseLayer(side: number): Promise<ImageBitmap> {
  const data = new ImageData(side, side);
  const hash = (x: number, y: number) => { let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const v = hash(x >> 1, y >> 1) < 0.5 ? 90 : 166;
      data.data.set([v, v, v, v], (y * side + x) * 4);
    }
  return createImageBitmap(data, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

/** The toon light's four settings together, as a sunny game would have them: see `Look`. */
export const TOON_LIGHT: Partial<Look> = {
  bandSoftness: 0.06, shadeColour: [0.5, 0.52, 0.8], rim: 0.5, rimColour: [1, 0.95, 0.85], rimWidth: 0.3,
  skyLight: [0.42, 0.5, 0.62], groundLight: [0.45, 0.4, 0.28],
};

const GREEN: GrassKind = { density: 150, height: 0.15, width: 0.05, base: [0.05, 0.3, 0.04], tip: [0.25, 0.7, 0.15], lean: 0.25, give: 0.1, stripes: { width: 6, angle: 0, shade: 0.2 } };
const ROUGH: GrassKind = { density: 12, height: 0.8, width: 0.09, base: [0.04, 0.2, 0.05], tip: [0.2, 0.5, 0.12], lean: 0.15, give: 1 };

/**
 * The standard golf field: ooergolf's largest green, 27 by 39 units, with
 * the cup cut from it, in a grid eighty units square at a quarter unit a
 * cell, rough everywhere else and beyond it to the far distance.
 */
export function golfField(): GrassField {
  const cols = 320, rows = 320;
  const mask = new Uint8Array(cols * rows).fill(2);
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const x = -40 + (i + 0.5) * 0.25, y = -40 + (j + 0.5) * 0.25;
      if (Math.abs(x) < 13.5 && Math.abs(y) < 19.5) mask[j * cols + i] = Math.hypot(x, y - 12) < 1.45 ? 0 : 1;
    }
  return { origin: [-40, -40], cell: 0.25, cols, rows, mask, heights: new Float32Array(cols * rows), kinds: [GREEN, ROUGH], outside: { kind: 1, height: 0 }, seed: 1 };
}

describe.skipIf(!import.meta.env.VITE_PERF)('the game path, timed', () => {
  let gpu: Gpu;
  let r: GameRenderer;
  let target: GPUTexture;

  beforeAll(async () => {
    gpu = await createDevice();
    r = new GameRenderer(gpu, 32, 32, FIRE_POOL, 100);
    await r.ready;
    target = gpu.device.createTexture({ size: [W, H], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const env = bakeEnvironment(gpu, 'daylight', { size: 128, mips: 6 });
    await env.samples;
    r.setEnvironment(env.specular, env.brdf, env.mips);
    r.resize(W, H);
    r.setLights(new LightPool(8));
    r.look = {
      ...r.look, shading: 'toon', sunDir: [0.35, -0.3, 0.89], sunColour: [2.5, 2.45, 2.35], ambient: 1,
      background: [0.45, 0.72, 0.98], occlusion: 2, occlusionRadius: 2.5, occlusionDirect: 0.3,
    };
    r.fog = { ...noFog(100), density: Math.LN2 / 900, base: -10, height: 1000, colour: [0.2, 0.3, 0.42], ambient: 0.4, anisotropy: 0, reach: 600, steps: 16, cones: 0 };
    r.post = { ...r.post, vignette: 0, tone: 'clamp' };
    r.economy = { ...FULL_ECONOMY, shadows: true };
    r.setSunShadow({ min: [-50, -50, -4], max: [50, 50, 12] });
    // ooergolf's home view: a lens of 40 degrees, 0.78 radians from straight down, 62 units back
    r.camera.fov = 40; r.camera.near = 2; r.camera.far = 800;
    r.camera.target = [0, 0, 0];
    r.camera.position = [0, -Math.sin(0.78) * 62, Math.cos(0.78) * 62];
    r.setStatic(standardScene());
    r.setDynamic([]);
  }, 60_000);

  afterAll(() => { r?.dispose(); target?.destroy(); gpu?.device.destroy(); });

  /** One scene's frame, in milliseconds: the median of seven runs of thirty, after ten to warm up. */
  async function time(): Promise<number> {
    const view = target.createView();
    for (let i = 0; i < 10; i++) r.frame(view);
    await gpu.queue.onSubmittedWorkDone();
    const runs: number[] = [];
    for (let k = 0; k < 7; k++) {
      const t0 = performance.now();
      for (let i = 0; i < 30; i++) r.frame(view);
      await gpu.queue.onSubmittedWorkDone();
      runs.push((performance.now() - t0) / 30);
    }
    return median(runs);
  }

  /** The same, with a frame's fire emitted before each frame drawn. */
  async function timeFire(): Promise<number> {
    const view = target.createView();
    const frame = () => { for (const e of FIRE) r.emit(e); r.frame(view, 'redraw', 1 / 60); };
    for (let i = 0; i < 10; i++) frame();
    await gpu.queue.onSubmittedWorkDone();
    const runs: number[] = [];
    for (let k = 0; k < 7; k++) {
      const t0 = performance.now();
      for (let i = 0; i < 30; i++) frame();
      await gpu.queue.onSubmittedWorkDone();
      runs.push((performance.now() - t0) / 30);
    }
    return median(runs);
  }

  it('holds each scene to its baseline on this adapter', async () => {
    const measured: Record<string, number> = {};
    const view = target.createView();
    for (let i = 0; i < WARM_UP; i++) r.frame(view);
    await gpu.queue.onSubmittedWorkDone();
    measured.standard = await time();

    // the golf field over the same scene, its ground painted the rough's colour as a game would
    const [ground, boxes] = standardScene();
    r.setStatic([{ ...ground, albedo: grassGround(ROUGH) }, boxes]);
    await r.setGrass(golfField());
    measured.golf = await time();
    const home = await r.grassDrawn();
    r.wind = { direction: [1, 0.3], strength: 1, gustSize: 20, gustSpeed: 4 };
    r.time = 37.5;
    measured['golf windy'] = await time();
    r.wind = { ...r.wind, strength: 0 };
    r.camera.position = [0, -Math.sin(0.78) * 30, Math.cos(0.78) * 30];
    measured['golf near'] = await time();
    r.camera.position = [0, -Math.sin(0.78) * 62, Math.cos(0.78) * 62];
    r.economy = { ...FULL_ECONOMY, shadows: true, grass: 0.5 };
    measured['golf half'] = await time();
    r.economy = { ...FULL_ECONOMY, shadows: true };
    // the field at four samples a pixel, which draw every blade into them: the heaviest scene there is
    const plain = r.look;
    r.look = { ...plain, antialias: 'msaa' };
    await r.prepare();
    measured['golf msaa'] = await time();
    r.look = plain;
    await r.setGrass(null);
    r.setStatic(standardScene());
    // the look's own settings over the standard scene, each alone: four samples, FXAA, and the toon light's four
    r.look = { ...plain, antialias: 'msaa' };
    measured['standard msaa'] = await time();
    r.look = { ...plain, antialias: 'fxaa' };
    measured['standard fxaa'] = await time();
    r.look = { ...plain, ...TOON_LIGHT };
    measured['standard toon light'] = await time();
    r.look = plain;
    // the flow kinds over the standard scene: three strips, a ripple, a crust and a drift, thirty units by eight on the ground between the boxes, through the flowing builds
    const strips: GameGroup[] = [[FLOW_RIPPLE, -12, [0.01, 0.12, 0.2]], [FLOW_CRUST, 0, [1, 0.25, 0.02]], [FLOW_DRIFT, 12, [1, 1, 1]]].map(([kind, y, second]) => {
      const patterns = packFlow(new Float32Array(8), 0, { kind: kind as number, scale: 1, speed: 3, glow: kind === FLOW_CRUST ? 2 : 0, second: second as [number, number, number] });
      return { mesh: strip(30, 8), matrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, y as number, 0.05, 1]), albedo: [0.05, 0.08, 0.1], roughness: 0.3, patterns };
    });
    r.setStatic([...standardScene(), ...strips]);
    await r.prepare();
    r.time = 12.5;
    measured['standard flow'] = await time();
    r.look = { ...plain, antialias: 'msaa' };
    await r.prepare();
    measured['standard flow msaa'] = await time();
    r.look = plain;
    // one strip of ripple and one of open water, the same thirty units by eight, so the price of the water's twelve waves, mirror and glint is read against the ripple's
    const lone = (kind: number, scale: number, glow: number): GameGroup => ({
      mesh: strip(30, 8), matrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0.05, 1]), albedo: [0.05, 0.08, 0.1], roughness: 0.3,
      patterns: packFlow(new Float32Array(8), 0, { kind, scale, speed: 3, glow, second: [0.6, 0.8, 1] }),
    });
    r.setStatic([...standardScene(), lone(FLOW_RIPPLE, 1, 0)]);
    await r.prepare();
    measured['standard ripple'] = await time();
    r.setStatic([...standardScene(), lone(FLOW_WATER, 0.4, 0.3)]);
    await r.prepare();
    measured['standard water'] = await time();
    r.look = { ...plain, antialias: 'msaa' };
    await r.prepare();
    measured['standard water msaa'] = await time();
    r.look = plain;
    // the same strip as clear water, seen through to the ground and its boxes: the depth made readable, the frame copied,
    // and the clear pass over it, at one sample a pixel and at four
    r.setStatic([...standardScene(), lone(FLOW_CLEAR, 0.4, 0.3)]);
    await r.prepare();
    measured['standard clear'] = await time();
    r.look = { ...plain, antialias: 'msaa' };
    await r.prepare();
    measured['standard clear msaa'] = await time();
    r.look = plain;
    // the same water cut 128 by 24, still and then swelling by four waves, so the swells' price is read against the same mesh
    r.setStatic([...standardScene(), { ...lone(FLOW_CLEAR, 0.4, 0.3), mesh: sheet(30, 8, 128, 24) }]);
    await r.prepare();
    measured['standard clear sheet'] = await time();
    r.look = {
      ...plain,
      clear: {
        waves: [
          { direction: 0.3, wavelength: 9, amplitude: 0.08, steepness: 0.3 },
          { direction: 1.9, wavelength: 5.5, amplitude: 0.05, steepness: 0.25 },
          { direction: -1.1, wavelength: 3.2, amplitude: 0.03, steepness: 0.2 },
          { direction: 2.7, wavelength: 13, amplitude: 0.1, steepness: 0.15 },
        ],
      },
    };
    await r.prepare();
    measured['standard clear waves'] = await time();
    // and everything the finish has, together: the swells, the near colour, the crests, the sparkles and the foam
    // lines round the strip's edges from a shore field, as ooerfish's see-through water asks for them
    const size = 128, distances = new Float32Array(size * size);
    for (let j = 0; j < size; j++)
      for (let i = 0; i < size; i++) {
        const x = -15 + ((i + 0.5) / size) * 30, y = -4 + ((j + 0.5) / size) * 8;
        distances[j * size + i] = Math.min(15 - Math.abs(x), 4 - Math.abs(y));
      }
    r.setShoreField({ size, distances, min: [-15, -4], max: [15, 4] });
    r.look = {
      ...r.look,
      clear: {
        ...r.look.clear,
        glitter: 0,
        near: [0.15, 0.55, 0.9],
        nearDistance: 18,
        crest: [0.8, 0.97, 1],
        crestAmount: 0.4,
        sparkles: 1,
        sparkleCut: 0.4,
        sparkleBright: 8,
        sparkleSize: 4,
        foamWidth: 0.35,
        foamGap: 0.4,
        foamWidth2: 0.2,
      },
    };
    await r.prepare();
    measured['standard clear finish'] = await time();
    r.setShoreField(null);
    r.look = plain;
    // v0.28.0's settings together over the same water: the sky, the sun's map fitted to the view and softened over nine
    // taps, and the water darkened in its shadow
    r.look = { ...plain, sky: { zenith: [0.03, 0.33, 0.9], horizon: [0.6, 0.85, 1] }, shadowSoftness: 2, waterShadow: true };
    r.setSunShadow({ min: [-50, -50, -4], max: [50, 50, 12] }, { reach: 60 });
    await r.prepare();
    measured['standard sky fit'] = await time();
    r.look = plain;
    r.setSunShadow({ min: [-50, -50, -4], max: [50, 50, 12] });
    r.time = 0;
    // the ground texture over the standard scene: its ground wears a 256-square two-tone noise, colour and height, at four metres a tile, through the textured builds
    r.setGroundTexture([await noiseLayer(256)]);
    const [floor, crates] = standardScene();
    r.setStatic([{ ...floor, texture: packTexture(new Float32Array(4), 0, { layer: 1, repeat: 0.25, albedo: 0.5, shade: 0.5 }) }, crates]);
    await r.prepare();
    measured['standard textured'] = await time();
    r.setGroundTexture(null);
    r.setStatic(standardScene());
    // the cards over the standard scene: four hundred bushes of two thousand leaf cards each (four thousand triangles a
    // bush, 1.6 million a frame) between the boxes, cut by a real leaf's alpha, at one sample a pixel and at four
    r.setCardImages([await leafMask()]);
    const bush = cardBush();
    const bushes = new Float32Array(400 * 16);
    for (let i = 0; i < 400; i++) bushes.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, (i % 20) * 4 - 36, Math.floor(i / 20) * 4 - 36, 0, 1], i * 16);
    r.setStatic([...standardScene(), { mesh: bush, matrices: bushes, albedo: [0.1, 0.5, 0.1], roughness: 0.8, card: { layer: 1 } }]);
    await r.prepare();
    measured['standard cards'] = await time();
    r.look = { ...plain, antialias: 'msaa' };
    await r.prepare();
    measured['standard cards msaa'] = await time();
    r.look = plain;
    r.setCardImages(null);
    r.setStatic(standardScene());
    // the fire over the standard scene: four seconds of it let fill the pool first, then timed as it burns, with a wash, and with a wash that blows too gently to move anything
    for (let i = 0; i < 300; i++) { for (const e of FIRE) r.emit(e); r.frame(view, 'redraw', 1 / 60); }
    await gpu.queue.onSubmittedWorkDone();
    console.log(`particles live in the fire: ${r.particles.live} slots in the run`);
    measured['standard fire'] = await timeFire();
    r.setWash([FIRE_WASH]);
    measured['standard fire washed'] = await timeFire();
    console.log(`particles live washed: ${r.particles.live} slots in the run`);
    // the wash's own sums over the same particles, which it hardly moves, so its cost is not hidden by what it does to the overdraw
    r.setWash([FIRE_WASH_COST]);
    measured['standard fire wash cost'] = await timeFire();
    r.setWash([]);
    // a wind of three units a second over the fire: the update's sums for it in every particle, and the smoke carried where it blows
    r.setWind([3, 0, 0]);
    measured['standard fire windy'] = await timeFire();
    r.setWind([0, 0, 0]);
    // the same fire in the standard scene's haze, its smoke fogged by what is behind it (as above) and by its own distance, at one sample a pixel and at four
    r.particleFog = 'own';
    await r.prepare();
    measured['standard fire own'] = await timeFire();
    r.look = { ...plain, antialias: 'msaa' };
    await r.prepare();
    measured['standard fire own msaa'] = await timeFire();
    r.particleFog = 'behind';
    measured['standard fire msaa'] = await timeFire();
    r.look = plain;
    console.log(`blades drawn at the home view: ${home.near} near, ${home.far} far`);

    const file = await server.commands.readFile(BASELINE).catch(() => '');
    const key = gpu.adapter.key;
    const verdicts = judge(measured, recorded(file, key));
    for (const v of verdicts) console.log(`${key} ${v.scene}: ${v.why}`);
    if (UPDATE) {
      const all = file.trim() ? (JSON.parse(file) as Record<string, Record<string, number>>) : {};
      all[key] = Object.fromEntries(Object.entries(measured).map(([s, ms]) => [s, Math.round(ms * 1000) / 1000]));
      await server.commands.writeFile(BASELINE, JSON.stringify(all, null, 2) + '\n');
      return;
    }
    expect(verdicts.filter((v) => !v.ok).map((v) => `${v.scene}: ${v.why}`)).toEqual([]);
    if (key === REFERENCE) expect(measured.golf - measured.standard, 'the golf field over the standard scene, in ms').toBeLessThanOrEqual(GRASS_BUDGET_MS);
  }, 180_000);
});
