/**
 * Clear water as v0.29.0 drew it, held to the hash of its pixels: a clear group that asks for none of what came after
 * (its colour toward the camera and on the crests, its Gerstner waves, its foam lines from a shore field, its round
 * sparkles) draws exactly as it did. The record is kept in `clear-golden.json` under the adapter's key; an adapter with
 * none skips and says so; `VITE_GOLDEN=1` writes this adapter's, which is only to be done on the old code (it was
 * written from 926ce21, v0.29.0).
 */
/// <reference types="vite/client" />
import { server } from '@vitest/browser/context';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { bakeEnvironment } from '../../render/env';
import { DEFAULT_POST, FULL_ECONOMY, GameRenderer } from '../renderer';
import { LightPool } from '../lights';
import { bed, water } from './clearscene';
import { readPixels, saveFrame } from './frame';
import { fnv } from './golfscene';

const GOLDEN = 'src/game/__tests__/clear-golden.json';
const WRITE_GOLDEN = !!import.meta.env.VITE_GOLDEN;
const W = 160, H = 160;

describe('clear water that asks for nothing new', () => {
  let gpu: Gpu;
  let target: GPUTexture;
  let env: ReturnType<typeof bakeEnvironment>;

  beforeAll(async () => {
    gpu = await createDevice();
    env = bakeEnvironment(gpu, 'daylight', { size: 32, mips: 3 });
    await env.samples;
    target = gpu.device.createTexture({ size: [W, H], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  });
  afterAll(() => { target?.destroy(); gpu?.device.destroy(); });

  async function scene(kind: 'plain' | 'msaa' | 'toon') {
    const r = new GameRenderer(gpu, 8, 8, 256, 100);
    await r.ready;
    r.setEnvironment(env.specular, env.brdf, env.mips);
    r.resize(W, H);
    r.setLights(new LightPool(8));
    r.look = {
      ...r.look, background: [0.02, 0.02, 0.03], occlusion: 0, sunColour: [1, 1, 1], ambient: 1,
      shading: kind === 'toon' ? 'toon' : 'pbr', antialias: kind === 'msaa' ? 'msaa' : undefined,
      clear: { clarity: 1.5, foamWidth: 0.6, refraction: 1, glitter: 1, caustics: 1, causticScale: 1.5 },
    };
    r.post = { ...DEFAULT_POST, bloom: 0, vignette: 0, grain: 0, tone: 'clamp' };
    r.economy = { ...FULL_ECONOMY, shadows: true };
    r.setSunShadow({ min: [-8, -8, -7], max: [8, 8, 2] });
    r.camera.fov = 40; r.camera.near = 1; r.camera.far = 400;
    r.camera.target = [0, 0, -1];
    r.camera.position = [0, -12, 10];
    r.setStatic([...bed(), water(undefined, 0.3)]);
    r.time = 1.5;
    await r.prepare();
    const view = target.createView();
    for (let i = 0; i < 3; i++) r.frame(view, 'redraw', 1 / 60);
    const p = await readPixels(gpu, target);
    r.dispose();
    return p;
  }

  it('draws the same pixels as the code at v0.29.0 did, on an adapter with a record of them', async (ctx) => {
    const key = gpu.adapter.key;
    const found: Record<string, string> = {};
    for (const kind of ['plain', 'msaa', 'toon'] as const) {
      const p = await scene(kind);
      await saveFrame(`clear-golden-${kind}`, p);
      found[kind] = fnv(p);
    }
    const file = await server.commands.readFile(GOLDEN).catch(() => '');
    const all = file.trim() ? (JSON.parse(file) as Record<string, Record<string, string>>) : {};
    if (WRITE_GOLDEN) {
      all[key] = found;
      await server.commands.writeFile(GOLDEN, JSON.stringify(all, null, 2) + '\n');
      return;
    }
    if (!all[key]) { console.warn(`clear golden: no pixels of v0.29.0 are kept for ${key}, so nothing was held to them`); return ctx.skip(); }
    expect(found).toEqual(all[key]);
  });
});
