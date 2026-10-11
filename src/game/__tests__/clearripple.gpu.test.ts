/**
 * Clear water's ripples on a real device, from a low camera over a rippled water: the body lightened toward a colour of
 * its own on the fine waves' slopes, by an amount and above a cut. Each is asked for, and a water that asks for none
 * draws as before (held by `cleargolden`). Frames written by VITE_FRAME_DIR.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { bakeEnvironment } from '../../render/env';
import { DEFAULT_POST, FULL_ECONOMY, GameRenderer } from '../renderer';
import { LightPool } from '../lights';
import { readPixels, saveFrame, type Pixels } from './frame';
import { sheet } from './clearscene';
import { FLOW_CLEAR } from '../flow';

const W = 192, H = 192;
// the sky mirrored in no part, so that what is added is the ripples' alone
const NOTHING_ELSE = { foamWidth: 0, glitter: 0, refraction: 0, caustics: 0, mirror: 0 };
const WHITE: [number, number, number] = [1, 1, 1];
// the stretch of water measured: the middle of the frame, where the fine waves are still resolved
const X0 = 40, X1 = 152, Y0 = 100, Y1 = 170;

describe('the ripples of clear water', () => {
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
    r.camera.position = [0, -12, 1.2];
    r.camera.target = [0, 6, 0];
    r.time = 1.5;
    r.setStatic([sheet(96, FLOW_CLEAR, 0.5)]);
  });

  async function draw(name: string): Promise<Pixels> {
    await r.prepare();
    gpu.device.pushErrorScope('validation');
    expect(r.frame(target.createView(), 'redraw', 0)).toBe(true);
    expect(r.frame(target.createView(), 'redraw', 0)).toBe(true);
    const error = await gpu.device.popErrorScope();
    expect(error?.message ?? null).toBeNull();
    const p = await readPixels(gpu, target);
    await saveFrame(`ripple ${name}`, p);
    return p;
  }


  const luma = (p: Pixels, x: number, y: number) => {
    const i = (y * p.width + x) * 3;
    return 0.2126 * p.rgb[i] + 0.7152 * p.rgb[i + 1] + 0.0722 * p.rgb[i + 2];
  };
  const lumas = (p: Pixels) => {
    const out: number[] = [];
    for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) out.push(luma(p, x, y));
    return out;
  };
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const spread = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
  const same = (a: Pixels, b: Pixels) => a.rgb.every((v, i) => v === b.rgb[i]);
  const brighterThan = (p: Pixels, level: number) => lumas(p).filter((v) => v > level).length;

  it('lightens the body toward its colour and puts texture in it, and nothing is added with no colour, or an amount of nought', async () => {
    r.look = { ...r.look, clear: { ...NOTHING_ELSE } };
    const plain = await draw('unset');
    expect(plain.rgb.length).toBeGreaterThan(0);
    r.look = { ...r.look, clear: { ...NOTHING_ELSE, ripple: WHITE, rippleAmount: 1 } };
    const lit = await draw('white full');
    expect(mean(lumas(lit)) - mean(lumas(plain)), 'the ripples lighten the water').toBeGreaterThan(5);
    expect(spread(lumas(lit)) - spread(lumas(plain)), 'and are texture in it').toBeGreaterThan(3);

    r.look = { ...r.look, clear: { ...NOTHING_ELSE, ripple: null, rippleAmount: 1, rippleCut: 0 } };
    expect(same(await draw('no colour'), plain), 'no colour is today').toBe(true);
    r.look = { ...r.look, clear: { ...NOTHING_ELSE, ripple: WHITE, rippleAmount: 0 } };
    expect(same(await draw('amount 0'), plain), 'an amount of nought is today').toBe(true);
    r.look = { ...r.look, clear: { ...NOTHING_ELSE, ripple: WHITE, rippleAmount: 0.4 } };
    const less = mean(lumas(await draw('amount 0.4')));
    expect(less, 'a smaller amount, between').toBeGreaterThan(mean(lumas(plain)) + 1);
    expect(less).toBeLessThan(mean(lumas(lit)));
  });

  it('lightens only the steeper slopes as the cut rises: a high cut lightens fewer pixels than a low one', async () => {
    r.look = { ...r.look, clear: { ...NOTHING_ELSE } };
    const plain = await draw('cut base');
    const top = Math.max(...lumas(plain));
    r.look = { ...r.look, clear: { ...NOTHING_ELSE, ripple: WHITE, rippleAmount: 1, rippleCut: 0.1 } };
    const low = brighterThan(await draw('cut 0.1'), top);
    r.look = { ...r.look, clear: { ...NOTHING_ELSE, ripple: WHITE, rippleAmount: 1, rippleCut: 0.6 } };
    const high = brighterThan(await draw('cut 0.6'), top);
    expect(low, 'a low cut lightens a good many pixels past the plain water\'s brightest').toBeGreaterThan(50);
    expect(high, 'a high cut lightens fewer').toBeLessThan(low * 0.5);
  });
});
