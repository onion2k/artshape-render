/**
 * Clear water's mirror on a real device, from a low camera over a water with a near colour: the reflected sky taken
 * through a tint, kept by the camera where the near colour would ease it away, and scaled in strength. Each is asked
 * for, and a water that asks for none draws as before (held by `cleargolden`). Frames written by VITE_FRAME_DIR.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { bakeEnvironment } from '../../render/env';
import { DEFAULT_POST, FULL_ECONOMY, GameRenderer } from '../renderer';
import { LightPool } from '../lights';
import { meanIn, readPixels, saveFrame, type Pixels } from './frame';
import { sheet } from './clearscene';

const W = 192, H = 192;
const gap = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const PROBE_FAR = [98, 108];
const NEAR = { near: [0.2, 0.5, 0.6] as [number, number, number], nearDistance: 14 };
const NOTHING_ELSE = { foamWidth: 0, glitter: 0, refraction: 0, caustics: 0 };

describe('the mirror of clear water', () => {
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
    await saveFrame(`mirror ${name}`, p);
    return p;
  }


  // the far water is seen edge-on and mirrors strongly; the bottom of the frame is the water by the camera
  const far = (p: Pixels) => meanIn(p, 60, PROBE_FAR[0], 132, PROBE_FAR[1]);
  const near = (p: Pixels) => meanIn(p, 60, 128, 132, 138);
  const same = (a: Pixels, b: Pixels) => a.rgb.every((v, i) => v === b.rgb[i]);

  it('takes the reflected sky through a tint: cyan takes the red out of what is mirrored', async () => {
    r.look = { ...r.look, clear: { ...NOTHING_ELSE, ...NEAR } };
    const plain = await draw('tint unset');
    r.look = { ...r.look, clear: { ...NOTHING_ELSE, ...NEAR, mirrorTint: [0, 1, 1] } };
    const cyan = await draw('tint cyan');
    expect(plain.rgb.length).toBeGreaterThan(0);
    expect(far(plain)[0] - far(cyan)[0], 'the mirrored red, lost to the tint').toBeGreaterThan(15);
    expect(Math.abs(far(plain)[2] - far(cyan)[2]), 'the blue, which the tint keeps').toBeLessThan(2);
    r.look = { ...r.look, clear: { ...NOTHING_ELSE, ...NEAR, mirrorTint: [1, 1, 1] } };
    expect(same(await draw('tint white'), plain), 'a white tint is none').toBe(true);
  });

  it('keeps the mirror by the camera as far as mirrorNear says, and none of it at nought, as before', async () => {
    r.look = { ...r.look, clear: { ...NOTHING_ELSE, ...NEAR } };
    const plain = await draw('near share unset');
    r.look = { ...r.look, clear: { ...NOTHING_ELSE, ...NEAR, mirrorNear: 0 } };
    expect(same(await draw('near share 0'), plain), 'nought is today').toBe(true);
    r.look = { ...r.look, clear: { ...NOTHING_ELSE, ...NEAR, mirrorNear: 1 } };
    const kept = await draw('near share 1');
    expect(gap(near(kept), near(plain)), 'the mirror kept by the camera').toBeGreaterThan(8);
    r.look = { ...r.look, clear: { ...NOTHING_ELSE, ...NEAR, mirrorNear: 0.5 } };
    const half = await draw('near share half');
    const d = (p: Pixels) => gap(near(p), near(plain));
    expect(d(half), 'half the share, between').toBeGreaterThan(2);
    expect(d(half)).toBeLessThan(d(kept));
  });

  it('scales the mirror: nought removes it, one is as before', async () => {
    r.look = { ...r.look, clear: { ...NOTHING_ELSE, ...NEAR } };
    const plain = await draw('strength unset');
    r.look = { ...r.look, clear: { ...NOTHING_ELSE, ...NEAR, mirror: 1 } };
    expect(same(await draw('strength 1'), plain), 'one is today').toBe(true);
    r.look = { ...r.look, clear: { ...NOTHING_ELSE, ...NEAR, mirror: 0 } };
    const none = await draw('strength 0');
    const sum = (c: number[]) => c[0] + c[1] + c[2];
    expect(sum(far(plain)) - sum(far(none)), 'the sky gone from the far water').toBeGreaterThan(40);
    // with no mirror at all the water is the same however the near share is set
    r.look = { ...r.look, clear: { ...NOTHING_ELSE, ...NEAR, mirror: 0, mirrorNear: 1, mirrorTint: [1, 0, 0] } };
    expect(same(await draw('strength 0 with the rest'), none), 'nothing mirrored, nothing tinted or kept').toBe(true);
  });
});
