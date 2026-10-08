/**
 * A game that asks for none of v0.28.0's settings draws the pixels it drew at v0.27.1: no sky, the sun's map fitted to
 * its box, its shadow edge sharp and open water lit everywhere. The scene has everything those settings reach, a toon
 * look as a golf game sets it, boxes casting on the ground, open water with a box over it, the haze, and sky past the
 * ground, drawn plain, at four samples a pixel, kept, and without the fog.
 *
 * A hash of each frame's pixels was written from the code at 7561228 (v0.27.1), before any of the change, into
 * `unasked-golden.json` under the adapter's key, and is checked here. A hash is a fact about one GPU's rounding, so an
 * adapter with none skips and says so; `VITE_GOLDEN=1` writes this adapter's, which is only to be done on the old code.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server } from '@vitest/browser/context';
import { createDevice, type Gpu } from '../../gpu/context';
import { bakeEnvironment } from '../../render/env';
import { GameRenderer } from '../renderer';
import { LightPool } from '../lights';
import { NO_FOG } from '../fog';
import { readPixels, saveFrame, type Pixels } from './frame';
import { GROUND, fnv, golfLook } from './golfscene';

const SIZE = 160;
const GOLDEN = 'src/game/__tests__/unasked-golden.json';
const WRITE_GOLDEN = !!import.meta.env.VITE_GOLDEN;

describe('a game that asks for none of v0.28.0', () => {
  let gpu: Gpu;
  let env: { specular: GPUTexture; brdf: GPUTexture; mips: number };
  const made: { r: GameRenderer; target: GPUTexture }[] = [];

  beforeAll(async () => {
    gpu = await createDevice();
    const baked = bakeEnvironment(gpu, 'daylight', { size: 32, mips: 3 });
    await baked.samples;
    env = baked;
  });
  afterAll(() => {
    for (const x of made) { x.r.dispose(); x.target.destroy(); }
    gpu?.device.destroy();
  });

  async function scene(kind: 'plain' | 'msaa' | 'keep' | 'fogless'): Promise<Pixels> {
    const r = new GameRenderer(gpu, 8, 8, 4096, 100);
    await r.ready;
    const target = gpu.device.createTexture({ size: [SIZE, SIZE], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    made.push({ r, target });
    r.setEnvironment(env.specular, env.brdf, env.mips);
    r.resize(SIZE, SIZE);
    r.setLights(new LightPool(8));
    r.setStatic(GROUND);
    r.setDynamic([]);
    golfLook(r);
    if (kind === 'msaa') r.look = { ...r.look, antialias: 'msaa' };
    if (kind !== 'fogless') r.fog = { ...NO_FOG, density: Math.LN2 / 3000, base: -10, height: 1000, colour: [0.2, 0.3, 0.42], ambient: 0.4, anisotropy: 0, reach: 600, steps: 16, cones: 0 };
    // tight round the casters, so the edge of the map has shadow on it
    r.setSunShadow({ min: [-16, 26, -4], max: [14, 72, 24] });
    r.time = 1.5;
    // low behind the scene, looking past it to the sky
    r.camera.position = [10, -25, 17];
    r.camera.target = [-4, 55, 0];
    r.camera.near = 0.5;
    r.camera.far = 800;
    await r.prepare();
    const view = target.createView();
    for (let i = 0; i < 3; i++) r.frame(view, kind === 'keep' ? 'keep' : 'redraw', 1 / 60);
    return readPixels(gpu, target);
  }

  it('draws the same pixels as the code at v0.27.1 did, on an adapter with a record of them', async (ctx) => {
    const key = gpu.adapter.key;
    const found: Record<string, string> = {};
    for (const kind of ['plain', 'msaa', 'keep', 'fogless'] as const) {
      const p = await scene(kind);
      await saveFrame(`unasked-${kind}`, p);
      found[kind] = fnv(p);
    }
    const file = await server.commands.readFile(GOLDEN).catch(() => '');
    const all = file.trim() ? (JSON.parse(file) as Record<string, Record<string, string>>) : {};
    if (WRITE_GOLDEN) {
      all[key] = found;
      await server.commands.writeFile(GOLDEN, JSON.stringify(all, null, 2) + '\n');
      return;
    }
    if (!all[key]) { console.warn(`unasked: no pixels of v0.27.1 are kept for ${key}, so nothing was held to them`); return ctx.skip(); }
    expect(found).toEqual(all[key]);
  });
});
