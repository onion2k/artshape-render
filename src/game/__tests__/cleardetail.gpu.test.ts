/**
 * Clear water's detail layer on a real device: the fine waves read once more at a scale chosen per pixel, so their
 * cell is `detailPixels` across on the screen near and far, added to the normal, the bend and the mirror's read. It
 * holds that nought draws as plain; that the far water's normal is moved; that the layer is as strong far off as near,
 * which is what it is for; that its scale does not jump where the swells have moved a triangle's edge; that nothing
 * standing in the water is smeared at its waterline; and that it shimmers no more than the experiment chose. Without
 * these a change to the layer's scale or fade could put back the faults the experiment found, unseen. Frames written by
 * VITE_FRAME_DIR: the lake and the pond with the layer on and off, and the post's waterline four times the size.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { bakeEnvironment } from '../../render/env';
import { DEFAULT_POST, FULL_ECONOMY, GameRenderer, PATTERN_STRIDE, type GameGroup } from '../renderer';
import { LightPool } from '../lights';
import { FLOW_CLEAR, packFlow } from '../flow';
import { MeshBuilder } from '../../mesh/types';
import { GRAVITY_MM, gerstnerAt, type GerstnerWave } from '../waves';
import type { ClearWater } from '../clear';
import { differing, readPixels, saveFrame, type Pixels } from './frame';
import { bed, box, sheet } from './clearscene';
import { LAKE_CLEAR, LAKE_LOOK, POND_CLEAR, POSTS, POST_HALF, SHALLOW_ROCK, VIEWS, ground, lake, masks, posts, shimmered, type Cam } from './clearlake';

const W = 384, H = 384;
const MM_PER_UNIT = 100;
/** The setting the user chose from the films of 14 October 2026: a cell of eight pixels at an amount of one. */
const CHOSEN: Partial<ClearWater> = { detailPixels: 8, detailAmount: 1 };
const luma = (p: Pixels, i: number) => 0.2126 * p.rgb[i * 3] + 0.7152 * p.rgb[i * 3 + 1] + 0.0722 * p.rgb[i * 3 + 2];
const place = (r: GameRenderer, c: Cam) => { r.camera.position = [...c.position]; r.camera.target = [...c.target]; r.camera.fov = c.fov; };

// ---- the lit sea: a pixel's level is its normal's lean toward a low sun, at any distance ----------------------------

/**
 * Nothing but the water's own colour lit by the sun: no light through it (the least clarity), no mirror, foam, glitter,
 * caustics or bend, and no ambient. So a pixel is the body's colour times the normal's lean toward the sun, which does
 * not depend on how far off it is, and the layer's slope is read in it the same near and far.
 */
const LIT: Partial<ClearWater> = { clarity: 1e-4, mirror: 0, foamWidth: 0, glitter: 0, caustics: 0, refraction: 0 };
const SUN: [number, number, number] = [0.8, 0, 0.6];
const SEA_CAM: Cam = { position: [0, 0, 2.5], target: [0, 30, 0], fov: 40 };

/** A sheet of water from x −80 to 80 and y −10 to 150, cut into squares `step` across, its fine waves at a steepness of 0.3. */
function sea(step: number): GameGroup {
  const b = new MeshBuilder();
  const nx = Math.round(160 / step), ny = Math.round(160 / step);
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) b.vertex(-80 + i * step, -10 + j * step, 0, 0, 0, 1, 0, 0);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const a = j * (nx + 1) + i; b.quad(a, a + 1, a + nx + 2, a + nx + 1); }
  const patterns = packFlow(new Float32Array(PATTERN_STRIDE), 0, { kind: FLOW_CLEAR, scale: 0.4, speed: 0.5, glow: 0.3, second: [0.5, 0.5, 0.5] });
  return { mesh: b.build(), matrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), albedo: [0.5, 0.5, 0.5], roughness: 0.1, patterns };
}

/** The standard deviation of a row's levels, the layer's frame less plain's, over the columns 16 to W − 16, averaged over rows `from` to `to`. */
function rowSpread(on: Pixels, off: Pixels | null, from: number, to: number): number {
  let sum = 0;
  for (let y = from; y < to; y++) {
    const v: number[] = [];
    for (let x = 16; x < W - 16; x++) v.push(luma(on, y * W + x) - (off ? luma(off, y * W + x) : 0));
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    sum += Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  }
  return sum / (to - from);
}

describe('the detail layer on clear water', () => {
  let gpu: Gpu;
  let target: GPUTexture;

  beforeAll(async () => {
    gpu = await createDevice();
    target = gpu.device.createTexture({ size: [W, H], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  });
  afterAll(() => { target?.destroy(); gpu?.device.destroy(); });

  async function renderer(env: ReturnType<typeof bakeEnvironment>) {
    const r = new GameRenderer(gpu, 8, 8, 256, MM_PER_UNIT);
    await r.ready;
    r.setEnvironment(env.specular, env.brdf, env.mips);
    r.resize(W, H);
    r.setLights(new LightPool(8));
    return r;
  }

  async function draw(r: GameRenderer, clear: Partial<ClearWater>, name?: string, frames = 1, dt = 0): Promise<Pixels> {
    r.look = { ...r.look, clear };
    await r.prepare();
    gpu.device.pushErrorScope('validation');
    for (let i = 0; i < frames; i++) expect(r.frame(target.createView(), 'redraw', dt)).toBe(true);
    const error = await gpu.device.popErrorScope();
    expect(error?.message ?? null).toBeNull();
    const p = await readPixels(gpu, target);
    if (name) await saveFrame(`detail ${name}`, p);
    return p;
  }

  describe('on the lit sea', () => {
    let env: ReturnType<typeof bakeEnvironment>;
    let r: GameRenderer;
    beforeAll(async () => {
      env = bakeEnvironment(gpu, 'daylight', { size: 32, mips: 3 });
      await env.samples;
      r = await renderer(env);
      r.look = { ...r.look, shading: 'pbr', antialias: undefined, background: [0.02, 0.02, 0.03], occlusion: 0, sunColour: [10, 10, 10], sunDir: SUN, ambient: 0, exposure: 1 };
      r.post = { ...DEFAULT_POST, bloom: 0, vignette: 0, grain: 0, tone: 'clamp' };
      r.economy = { ...FULL_ECONOMY, shadows: false };
      r.camera.near = 0.5; r.camera.far = 400;
      place(r, SEA_CAM);
      r.time = 1.5;
    });
    afterAll(() => r?.dispose());

    // the far rows are some fifty to seventy units off and the near ones five to seven, at a height of two and a half
    const FAR: [number, number] = [166, 186], NEAR: [number, number] = [350, 380];

    it('moves the far water\'s normal with a cell asked for, and draws plain to the pixel with no cell or no amount', async () => {
      r.setStatic([sea(1)]);
      const plain = await draw(r, LIT, 'sea plain');
      const on = await draw(r, { ...LIT, ...CHOSEN }, 'sea 8px 1');
      expect(differing(await draw(r, { ...LIT, detailAmount: 1 }), plain), 'an amount with no cell').toBe(0);
      expect(differing(await draw(r, { ...LIT, detailPixels: 8, detailAmount: 0 }), plain), 'a cell with no amount').toBe(0);
      let moved = 0, n = 0;
      for (let y = FAR[0]; y < FAR[1]; y++) for (let x = 16; x < W - 16; x++) { moved += Math.abs(luma(on, y * W + x) - luma(plain, y * W + x)); n++; }
      console.log(`the far water moved by the layer: ${(moved / n).toFixed(2)} levels on average`);
      expect(moved / n, 'the far water moved by the layer, in levels on average').toBeGreaterThan(3);
    });

    it('is as strong at the far water as at the near, where the plain waves fade out', async () => {
      r.setStatic([sea(1)]);
      const plain = await draw(r, LIT);
      const on = await draw(r, { ...LIT, ...CHOSEN });
      const plainNear = rowSpread(plain, null, ...NEAR), plainFar = rowSpread(plain, null, ...FAR);
      const near = rowSpread(on, plain, ...NEAR), far = rowSpread(on, plain, ...FAR);
      console.log(`a row's spread of levels: plain ${plainNear.toFixed(2)} near and ${plainFar.toFixed(2)} far; the layer ${near.toFixed(2)} near and ${far.toFixed(2)} far`);
      // the scene shows what the layer is for: the twelve waves faded to under half far off
      expect(plainFar / plainNear, 'the plain waves fade with the distance').toBeLessThan(0.5);
      // and its finest wave survives: near the camera it is as rough as the twelve waves are there, unfaded. With their
      // own fade, as first specified (the experiment's variant A), it kept only its longest wave and read 0.75 of them
      expect(near / plainNear, 'the layer near, against the plain waves near').toBeGreaterThan(0.9);
      expect(far / near, 'the layer as strong far as near, within a factor of two').toBeGreaterThan(0.5);
      expect(far / near).toBeLessThan(2);
    });

    it('does not jump in scale across a triangle\'s edge where the swells have moved it', async () => {
      // one long swell across the line of sight, tilting each square two units across by its own share of its slope, so
      // a footprint taken from the moved triangles would change from one to the next at the far water's glancing angle
      const waves: GerstnerWave[] = [{ direction: Math.PI / 2, wavelength: 7, amplitude: 0.3, steepness: 0.4 }];
      const STEP = 2;
      r.setStatic([sea(STEP)]);
      const plain = await draw(r, { ...LIT, waves });
      const on = await draw(r, { ...LIT, waves, detailPixels: 16, detailAmount: 1 }, 'sea swells 16px 1');
      // which triangle of the moved sheet each pixel's centre lies in, rasterised here from the swells' own sums
      const vp = r.camera.viewProjection;
      const gravity = GRAVITY_MM / MM_PER_UNIT, at = new Float64Array(5);
      const screen = (x: number, y: number): [number, number] => {
        gerstnerAt(waves, x, y, r.time, gravity, at);
        const p = [x + at[0], y + at[1], at[2], 1];
        const c = [0, 1, 2, 3].map((row) => vp[row] * p[0] + vp[4 + row] * p[1] + vp[8 + row] * p[2] + vp[12 + row] * p[3]);
        return [(c[0] / c[3] * 0.5 + 0.5) * W, (0.5 - (c[1] / c[3]) * 0.5) * H];
      };
      const id = new Int32Array(W * H).fill(-1);
      const fill = (a: [number, number], b: [number, number], c: [number, number], name: number) => {
        const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
        const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
        const edge = (p: [number, number], q: [number, number], x: number, y: number) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
        const area = edge(a, b, c[0], c[1]);
        for (let y = y0; y <= y1; y++)
          for (let x = x0; x <= x1; x++) {
            const cx = x + 0.5, cy = y + 0.5;
            const e0 = edge(a, b, cx, cy) * area, e1 = edge(b, c, cx, cy) * area, e2 = edge(c, a, cx, cy) * area;
            if (e0 >= 0 && e1 >= 0 && e2 >= 0) id[y * W + x] = name;
          }
      };
      // the squares from two to twenty units out, where a triangle is several pixels tall
      for (let j = 6; j < 15; j++)
        for (let i = 30; i < 50; i++) {
          const x = -80 + i * STEP, y = -10 + j * STEP;
          const p00 = screen(x, y), p10 = screen(x + STEP, y), p11 = screen(x + STEP, y + STEP), p01 = screen(x, y + STEP);
          fill(p00, p10, p11, (j * 100 + i) * 2);
          fill(p00, p11, p01, (j * 100 + i) * 2 + 1);
        }
      // the step across a boundary between rows e − 1 and e, from two pixels either side: what is left of the change
      // across it once the run of the four pixels has been taken off, which is nought for a smooth texture and two
      // thirds of a jump for one that jumps there
      const D = (x: number, y: number) => luma(on, y * W + x) - luma(plain, y * W + x);
      const step = (x: number, e: number) => Math.abs(D(x, e) - D(x, e - 1) - (D(x, e + 1) - D(x, e - 2)) / 3);
      const across: number[] = [], inside: number[] = [];
      for (let x = 8; x < W - 8; x++) {
        const name = (y: number) => id[y * W + x];
        for (let e = 3; e < H - 3; e++) {
          const four = [name(e - 2), name(e - 1), name(e), name(e + 1)];
          if (four.some((v) => v < 0)) continue;
          if (four[0] === four[1] && four[2] === four[3] && four[1] !== four[2] && name(e - 3) === four[0] && name(e + 2) === four[3]) across.push(step(x, e));
          // inside a triangle: six rows of one name, the boundary taken at its middle
          else if (name(e - 3) === four[0] && four.every((v) => v === four[0]) && name(e + 2) === four[0]) inside.push(step(x, e));
        }
      }
      const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
      let moved = 0;
      for (let i = 0; i < W * H; i++) if (id[i] >= 0) moved += Math.abs(luma(on, i) - luma(plain, i));
      const covered = id.reduce((s, v) => s + (v >= 0 ? 1 : 0), 0);
      console.log(`edges ${across.length} and insides ${inside.length}: the step across an edge ${mean(across).toFixed(2)} levels, inside a triangle ${mean(inside).toFixed(2)}; the layer moves ${(moved / covered).toFixed(2)} levels there`);
      expect(across.length, 'edges were found').toBeGreaterThan(1000);
      expect(inside.length, 'and insides').toBeGreaterThan(1000);
      expect(moved / covered, 'the layer is there to jump').toBeGreaterThan(3);
      expect(mean(across) - mean(inside), 'the step across an edge, against inside a triangle, in levels').toBeLessThan(1);
    });
  });

  /**
   * How far the layer moves the water beside a thing's waterline: the pixels within a few of where its front and sides
   * meet the water, a patch of three by three at a time so a single pixel's rounding is not a fleck. Its brightness, the
   * worst patch and the mean, in levels; and how much redder it is, its red risen over its green, at the worst patch,
   * which is a red thing's colour come into the water and not the reflection broken up (that moves the blue against the
   * other two, and red over the more of green and blue counted it as red). Crops of both frames are
   * written four times the size.
   */
  async function besideWaterline(r: GameRenderer, plain: Pixels, on: Pixels, x: number, y: number, half: number, name: string) {
    const vp = r.camera.viewProjection;
    const screen = (wx: number, wy: number): [number, number] => {
      const c = [0, 1, 2, 3].map((row) => vp[row] * wx + vp[4 + row] * wy + vp[12 + row]);
      return [(c[0] / c[3] * 0.5 + 0.5) * W, (0.5 - (c[1] / c[3]) * 0.5) * H];
    };
    const fl = screen(x - half, y - half), fr = screen(x + half, y - half);
    const x0 = Math.floor(fl[0]) - 6, x1 = Math.ceil(fr[0]) + 6, row = Math.round((fl[1] + fr[1]) / 2);
    const red = (p: Pixels, i: number) => p.rgb[i * 3] - p.rgb[i * 3 + 1];
    let worst = 0, sum = 0, n = 0, redder = 0;
    for (let py = row - 6; py <= row + 8; py++)
      for (let px = x0; px <= x1; px++) {
        let d = 0, e = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const i = (py + dy) * W + px + dx;
            d += Math.abs(luma(on, i) - luma(plain, i));
            e += red(on, i) - red(plain, i);
          }
        worst = Math.max(worst, d / 9); sum += d / 9; n++;
        redder = Math.max(redder, e / 9);
      }
    await saveCrop(`detail waterline ${name} plain`, plain, x0 - 6, row - 14, x1 - x0 + 12, 30);
    await saveCrop(`detail waterline ${name} 8px 1`, on, x0 - 6, row - 14, x1 - x0 + 12, 30);
    console.log(`${name}: waterline at row ${row}, columns ${x0} to ${x1}; the layer moves the water beside it ${(sum / n).toFixed(2)} levels on average, ${worst.toFixed(2)} at the worst patch, and makes it ${redder.toFixed(2)} levels redder at the worst`);
    return { worst, redder };
  }

  /** The lake as the experiment drew it: toon at four samples, the scene mirrored, from the shore; and its far-water mask. */
  async function lakeScene(extra: GameGroup[] = []) {
    const env = bakeEnvironment(gpu, 'daylight', { size: 128, mips: 6 });
    await env.samples;
    const r = await renderer(env);
    r.camera.near = 0.5; r.camera.far = 400;
    const l = lake();
    r.look = { ...r.look, ...LAKE_LOOK, sunDir: [...LAKE_LOOK.sunDir], sunColour: [...LAKE_LOOK.sunColour], background: [...LAKE_LOOK.background], clear: LAKE_CLEAR } as typeof r.look;
    r.post = { ...DEFAULT_POST, vignette: 0, grain: 0, tone: 'soft' };
    r.economy = { ...FULL_ECONOMY, shadows: true };
    r.setSunShadow({ min: [-16, -16, -7], max: [16, 16, 9] });
    r.setShoreField(l.field);
    r.setStatic([...l.land, l.water, ...extra]);
    const cam = VIEWS['lake shore'];
    place(r, cam);
    const m = masks(cam, W, H, (x, y) => ground(x, y) < -0.02, [{ x: SHALLOW_ROCK.x, y: SHALLOW_ROCK.y, z: 0, r: l.waterline + 0.4 }]);
    return { r, m };
  }

  describe('beside a thing standing in the water', () => {
    it('leaves the water beside a post\'s waterline the colour it is without the layer, on the pond', async () => {
      const env = bakeEnvironment(gpu, 'daylight', { size: 128, mips: 6 });
      await env.samples;
      const r = await renderer(env);
      r.camera.near = 0.5; r.camera.far = 400;
      r.look = { ...r.look, background: [0.02, 0.02, 0.03], occlusion: 0, sunColour: [1, 1, 1], ambient: 1, shading: 'pbr', antialias: undefined };
      r.post = { ...DEFAULT_POST, bloom: 0, vignette: 0, grain: 0, tone: 'clamp' };
      r.economy = { ...FULL_ECONOMY, shadows: true };
      r.setSunShadow({ min: [-8, -8, -7], max: [8, 8, 3] });
      r.setStatic([...bed(), ...posts(), sheet(96, undefined, 0.3)]);
      place(r, VIEWS.pond);
      r.time = 2;
      const plain = await draw(r, POND_CLEAR, 'pond plain', 3);
      const on = await draw(r, { ...POND_CLEAR, ...CHOSEN }, 'pond 8px 1', 3);
      for (const post of POSTS) {
        const { worst } = await besideWaterline(r, plain, on, post.x, post.y, POST_HALF, `pond post ${post.x}`);
        expect(worst, `beside the post at (${post.x}, ${post.y}), the worst patch, in levels`).toBeLessThan(6);
      }
      r.dispose();
    });

    it('leaves the water beside a red bobber the colour it is without the layer, on the lake at four samples with the scene mirrored', async () => {
      // a red post a fifth of a unit across, standing a sixth of a unit out of the lake's middle, three units deep: the
      // game's bobber, beside which the films saw a purple-red smear
      const BOBBER = { x: 0, y: 0, half: 0.1 };
      const rise = 0.15, floor = ground(BOBBER.x, BOBBER.y);
      const bobber: GameGroup = {
        mesh: box(), albedo: [0.85, 0.08, 0.06], roughness: 0.6,
        matrices: new Float32Array([BOBBER.half * 2, 0, 0, 0, 0, BOBBER.half * 2, 0, 0, 0, 0, rise - floor, 0, BOBBER.x, BOBBER.y, floor, 1]),
      };
      const { r } = await lakeScene([bobber]);
      r.time = 2;
      const plain = await draw(r, LAKE_CLEAR, 'lake bobber plain', 3);
      const on = await draw(r, { ...LAKE_CLEAR, ...CHOSEN }, 'lake bobber 8px 1', 3);
      // the water here mirrors the trees, and the layer breaks that up beside the bobber as everywhere, so its brightness
      // moves by some eight levels at the worst patch whatever is done: what is held is that the bobber's red does not come into it
      const { redder } = await besideWaterline(r, plain, on, BOBBER.x, BOBBER.y, BOBBER.half, 'lake bobber');
      // the same band in open water a unit and a half to each side, where nothing stands: the layer's own lean on the
      // light, which warms the sky's reflection a little wherever it tilts the water toward the sun
      const left = await besideWaterline(r, plain, on, BOBBER.x - 1.5, BOBBER.y, BOBBER.half, 'lake open water left');
      const right = await besideWaterline(r, plain, on, BOBBER.x + 1.5, BOBBER.y, BOBBER.half, 'lake open water right');
      expect(left.redder + right.redder, 'the open water is reached and the layer moves its colour').toBeGreaterThan(0);
      expect(redder, 'beside the bobber, how much redder the worst patch is, in levels').toBeLessThan(Math.max(left.redder, right.redder) + 3);
      r.dispose();
    });
  });

  describe('on the lake, from the shore', () => {
    // The brief asked for no more than 1.3 times plain's. Built, the layer reads 1.074 (the counts repeat exactly from run
    // to run); with its fade taken out altogether, the fault the experiment checked its count against, 1.263, and with
    // its cell read at half what is asked, 1.180. So 1.3 would let both through, and the bound is 1.15, between them.
    it('shimmers on the far water over sixty stepped frames no more than 1.15 times plain', async () => {
      const { r, m } = await lakeScene();
      const T0 = 2, FRAMES = 60;
      const film = async (clear: Partial<ClearWater>, name: string) => {
        r.look = { ...r.look, clear };
        r.time = T0;
        await r.prepare();
        for (let i = 0; i < 3; i++) r.frame(target.createView(), 'redraw', 1 / 60);
        let last: Pixels | null = null;
        let total = 0;
        for (let f = 0; f < FRAMES; f++) {
          r.time = T0 + f / 60;
          r.frame(target.createView(), 'redraw', 1 / 60);
          const p = await readPixels(gpu, target);
          if (f === 0) await saveFrame(`detail lake ${name}`, p);
          if (last) total += shimmered(last, p, m.far);
          last = p;
        }
        return total / (FRAMES - 1);
      };
      const plain = await film(LAKE_CLEAR, 'plain');
      const on = await film({ ...LAKE_CLEAR, ...CHOSEN }, '8px 1');
      const far = m.far.reduce((s, v) => s + v, 0);
      console.log(`far-water pixels shimmering a frame, of ${far}: plain ${plain.toFixed(0)}, 8 px at 1.0 ${on.toFixed(0)} (${(on / plain).toFixed(3)} times)`);
      expect(plain, 'the instrument reached the water: plain shimmers somewhere').toBeGreaterThan(200);
      expect(on / plain, 'the layer\'s shimmer against plain\'s').toBeLessThanOrEqual(1.15);
      r.dispose();
    });
  });
});

/** A crop of a frame written four times the size, when a directory for frames was named. */
async function saveCrop(name: string, p: Pixels, x0: number, y0: number, w: number, h: number, zoom = 4) {
  const out = new Uint8Array(w * zoom * h * zoom * 3);
  for (let y = 0; y < h * zoom; y++)
    for (let x = 0; x < w * zoom; x++) {
      const sx = Math.min(Math.max(x0 + Math.floor(x / zoom), 0), p.width - 1), sy = Math.min(Math.max(y0 + Math.floor(y / zoom), 0), p.height - 1);
      out.set(p.rgb.subarray((sy * p.width + sx) * 3, (sy * p.width + sx) * 3 + 3), (y * w * zoom + x) * 3);
    }
  await saveFrame(name, { width: w * zoom, height: h * zoom, rgb: out });
}
