/**
 * Clear water's finish on a real device: the near colour it lightens toward by the camera, its crests lighter than its
 * troughs, and its sparkles, round soft stars brighter than one before the tone map, so bloom haloes them. Each is
 * asked for, and a water that asks for none draws as before (held by `cleargolden`). Frames written by VITE_FRAME_DIR.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { bakeEnvironment } from '../../render/env';
import { DEFAULT_POST, FULL_ECONOMY, GameRenderer } from '../renderer';
import { LightPool } from '../lights';
import { GRAVITY_MM, type GerstnerWave } from '../waves';
import { meanIn, readPixels, saveFrame, type Pixels } from './frame';
import { sheet } from './clearscene';

const W = 192, H = 192;
const gap = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const NOTHING_ELSE = { foamWidth: 0, glitter: 0, refraction: 0, caustics: 0 };

describe('the finish of clear water', () => {
  let gpu: Gpu;
  let env: ReturnType<typeof bakeEnvironment>;
  let r: GameRenderer;
  let target: GPUTexture;

  beforeAll(async () => {
    gpu = await createDevice();
    env = bakeEnvironment(gpu, 'daylight', { size: 32, mips: 3 });
    await env.samples;
    target = gpu.device.createTexture({ size: [W, H], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    r = new GameRenderer(gpu, 8, 8, 256, 100);
    await r.ready;
    r.setEnvironment(env.specular, env.brdf, env.mips);
    r.resize(W, H);
    r.setLights(new LightPool(8));
  });

  afterAll(() => { r?.dispose(); target?.destroy(); gpu?.device.destroy(); });

  beforeEach(() => {
    r.look = { ...r.look, shading: 'pbr', antialias: undefined, background: [0.02, 0.02, 0.03], occlusion: 0, sunColour: [1, 1, 1], ambient: 1, exposure: 1 };
    r.post = { ...DEFAULT_POST, bloom: 0, vignette: 0, grain: 0, tone: 'clamp' };
    r.economy = { ...FULL_ECONOMY, shadows: false };
    r.camera.fov = 40; r.camera.near = 1; r.camera.far = 200;
    r.camera.position = [0, -12, 6];
    r.camera.target = [0, 2, 0];
    r.time = 1.5;
    r.setStatic([sheet(96)]);
  });

  async function draw(name: string): Promise<Pixels> {
    await r.prepare();
    gpu.device.pushErrorScope('validation');
    expect(r.frame(target.createView(), 'redraw', 0)).toBe(true);
    expect(r.frame(target.createView(), 'redraw', 0)).toBe(true);
    const error = await gpu.device.popErrorScope();
    expect(error?.message ?? null).toBeNull();
    const p = await readPixels(gpu, target);
    await saveFrame(`finish ${name}`, p);
    return p;
  }

  it('lightens toward the near colour by the camera, and not far off', async () => {
    r.look = { ...r.look, clear: NOTHING_ELSE };
    const before = await draw('near unset');
    r.look = { ...r.look, clear: { ...NOTHING_ELSE, near: [1, 0.55, 0.2], nearDistance: 12 } };
    const after = await draw('near');
    // the bottom of the frame is the water by the camera, the top of the water far off
    const near = (p: Pixels) => meanIn(p, 80, 176, 112, 188);
    const far = (p: Pixels) => meanIn(p, 80, 6, 112, 18);
    expect(gap(near(after), near(before)), 'the near water moved toward the near colour').toBeGreaterThan(25);
    expect(near(after)[0] - near(before)[0], 'and redder, as the near colour is').toBeGreaterThan(15);
    expect(gap(far(after), far(before)), 'the far water hardly moved').toBeLessThan(6);
  });

  it('is lighter on its crests than in its troughs, with a crest colour, and not without one', async () => {
    // a swell along x seen from straight above, with the crests and troughs where the sums put them
    const swell: GerstnerWave[] = [{ direction: 0, wavelength: 4, amplitude: 0.25, steepness: 0 }];
    r.camera.position = [0, -0.01, 30];
    r.camera.target = [0, 0, 0];
    r.camera.fov = 20;
    const t = 1.5, k = (2 * Math.PI) / 4, omega = Math.sqrt((GRAVITY_MM / 100) * k);
    // a crest where the phase is a quarter turn and a trough three quarters, on the screen; a unit is 192 / (2 * 30 * tan 10°) pixels
    const pxPerUnit = H / (2 * 30 * Math.tan((10 * Math.PI) / 180));
    const at = (phase: number) => {
      let x = (phase + omega * t) / k;
      x -= Math.round(x / 4) * 4;
      return Math.round(W / 2 + x * pxPerUnit);
    };
    const crestX = at(Math.PI / 2), troughX = at((3 * Math.PI) / 2);
    const luma = (p: Pixels, x: number) => { const c = meanIn(p, x - 2, 86, x + 2, 106); return c[0] + c[1] + c[2]; };
    r.look = { ...r.look, clear: { ...NOTHING_ELSE, waves: swell } };
    const plain = await draw('crest unset');
    expect(Math.abs(luma(plain, crestX) - luma(plain, troughX)), 'with no crest colour, crest and trough alike').toBeLessThan(12);
    r.look = { ...r.look, clear: { ...NOTHING_ELSE, waves: swell, crest: [0.9, 1, 1], crestAmount: 0.8 } };
    const crested = await draw('crest');
    expect(luma(crested, crestX) - luma(crested, troughX), 'the crest lighter than the trough').toBeGreaterThan(60);
  });

  /** The bright spots of a picture against one without them: each a group of touching pixels, with its box and size. */
  function spots(p: Pixels, without: Pixels, least: number) {
    const lit = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const d = p.rgb[i * 3] + p.rgb[i * 3 + 1] + p.rgb[i * 3 + 2] - (without.rgb[i * 3] + without.rgb[i * 3 + 1] + without.rgb[i * 3 + 2]);
      lit[i] = d > least ? 1 : 0;
    }
    const found: { x: number; y: number; w: number; h: number; n: number; peak: number; edge: boolean }[] = [];
    const seen = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      if (!lit[i] || seen[i]) continue;
      let x0 = W, x1 = 0, y0 = H, y1 = 0, n = 0, peak = 0;
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const j = stack.pop()!;
        const x = j % W, y = (j - x) / W;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        n++;
        peak = Math.max(peak, p.rgb[j * 3] + p.rgb[j * 3 + 1] + p.rgb[j * 3 + 2] - (without.rgb[j * 3] + without.rgb[j * 3 + 1] + without.rgb[j * 3 + 2]));
        for (const k of [j - 1, j + 1, j - W, j + W])
          if (k >= 0 && k < W * H && Math.abs((k % W) - x) <= 1 && lit[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
      }
      found.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, n, peak, edge: x0 === 0 || y0 === 0 || x1 === W - 1 || y1 === H - 1 });
    }
    return found;
  }

  it('sparkles in round soft stars, brighter than one before the tone map, and not at all unasked', async () => {
    // the camera looking toward the sun, low, where the sparkles are
    r.look = { ...r.look, sunDir: [0, 0.966, 0.26] };
    r.camera.position = [0, -12, 4];
    r.camera.target = [0, 4, 0];
    // a quarter of the exposure: a sparkle that still lifts a pixel by more than a quarter of white is more than one
    // a low cut, and three moments of the waves, for enough of them to measure: how many there are is the look's to choose
    const found: ReturnType<typeof spots> = [];
    for (const t of [1.5, 3.7, 6.1]) {
      r.time = t;
      r.look = { ...r.look, exposure: 0.25, clear: NOTHING_ELSE };
      const none = await draw(`sparkles unset at ${t}`);
      r.look = { ...r.look, exposure: 0.25, clear: { ...NOTHING_ELSE, sparkles: 1, sparkleCut: 0.1 } };
      const some = await draw(`sparkles at ${t}`);
      // a star the frame's own edge cuts is not its shape
      found.push(...spots(some, none, 30).filter((s) => s.n >= 5 && !s.edge));
    }
    expect(found.length, 'sparkles seen').toBeGreaterThanOrEqual(6);
    for (const s of found) {
      // round: as tall as it is wide, give or take a pixel, and filling most of the disc in its box
      expect(Math.abs(s.w - s.h), `a sparkle ${s.w} by ${s.h} at ${s.x}, ${s.y}`).toBeLessThanOrEqual(1);
      expect(s.n / (s.w * s.h), `a sparkle ${s.w} by ${s.h}, ${s.n} lit`).toBeGreaterThan(0.55);
    }
    // the brightest lift a pixel by more than a quarter of white, at a quarter of the exposure
    expect(Math.max(...found.map((s) => s.peak)) / 3, 'the brightest sparkle, at a quarter of the exposure').toBeGreaterThan(64);
  });
});
