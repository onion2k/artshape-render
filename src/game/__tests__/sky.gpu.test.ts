/**
 * The sky, on a real device: each pixel the colour `skyColour` gives for how high its ray looks, read before the tone map;
 * under the scene, which stands over it as over the clear colour; the same at four samples a pixel and in a kept frame as
 * drawn plain; and nothing of it compiled for a look that does not ask. That a game which does not ask draws the pixels it
 * drew at v0.27.1 is `unasked.gpu.test.ts`.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { bakeEnvironment } from '../../render/env';
import { GameRenderer } from '../renderer';
import { LightPool } from '../lights';
import { invertInto, skyColour, type Sky } from '../sky';
import { differing, readPixels, saveFrame } from './frame';
import { block, golfLook } from './golfscene';

const SIZE = 96;
const SKY: Sky = { zenith: [0.03, 0.33, 0.9], horizon: [0.6, 0.85, 1], below: [0.25, 0.4, 0.1] };

/** The decoded half float. */
function half(h: number): number {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

describe('the sky', () => {
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

  /** A renderer looking out level from ten up, the fog and the post chain off, with what it is given to draw. */
  async function make(o: { sky?: Sky; msaa?: boolean; groups?: Parameters<GameRenderer['setStatic']>[0] } = {}) {
    const r = new GameRenderer(gpu, 8, 8, 4096, 100);
    await r.ready;
    const target = gpu.device.createTexture({ size: [SIZE, SIZE], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    made.push({ r, target });
    r.setEnvironment(env.specular, env.brdf, env.mips);
    r.resize(SIZE, SIZE);
    r.setLights(new LightPool(8));
    r.setStatic(o.groups ?? []);
    r.setDynamic([]);
    golfLook(r);
    r.look = { ...r.look, background: [1, 0, 1], ...(o.sky ? { sky: o.sky } : {}), ...(o.msaa ? { antialias: 'msaa' as const } : {}) };
    r.post = { ...r.post, bloom: 0, tone: 'clamp' };
    r.camera.position = [0, 0, 10];
    r.camera.target = [0, 100, 18];
    r.camera.near = 0.5;
    r.camera.far = 800;
    await r.prepare();
    return { r, target, view: target.createView() };
  }

  /** The frame before the tone map, a row's middle pixel, as floats. */
  async function hdrAt(r: GameRenderer, x: number, y: number): Promise<[number, number, number]> {
    const tex = r.hdr.colour!;
    await gpu.queue.onSubmittedWorkDone();
    const bytesPerRow = Math.ceil((tex.width * 8) / 256) * 256;
    const buffer = gpu.device.createBuffer({ size: bytesPerRow * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = gpu.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: tex }, { buffer, bytesPerRow, rowsPerImage: tex.height }, [tex.width, tex.height, 1]);
    gpu.queue.submit([enc.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const raw = new Uint16Array(buffer.getMappedRange().slice(0));
    buffer.unmap(); buffer.destroy();
    const o = y * (bytesPerRow / 2) + x * 4;
    return [half(raw[o]), half(raw[o + 1]), half(raw[o + 2])];
  }

  /** How high the ray through the middle of pixel row `y` looks, worked out from the camera as the shader works it. */
  function upAt(r: GameRenderer, y: number): number {
    r.camera.update();
    const inv = new Float32Array(16);
    invertInto(inv, r.camera.viewProjection);
    const ndc = [((SIZE / 2 + 0.5) / SIZE) * 2 - 1, 1 - ((y + 0.5) / SIZE) * 2];
    const v = [0, 1, 2, 3].map((k) => inv[k] * ndc[0] + inv[4 + k] * ndc[1] + inv[8 + k] + inv[12 + k]);
    const p = [v[0] / v[3], v[1] / v[3], v[2] / v[3]];
    const d = p.map((c, k) => c - r.camera.position[k]);
    return d[2] / Math.hypot(d[0], d[1], d[2]);
  }

  it('is the colour skyColour gives for each row\'s ray, top to bottom, before the tone map', async () => {
    const s = await make({ sky: SKY });
    s.r.frame(s.view);
    await saveFrame('sky-plain', await readPixels(gpu, s.target));
    const mid = SIZE / 2;
    for (const y of [0, 10, 25, 40, 47, 52, 60, 80, 95]) {
      const want = skyColour(SKY, upAt(s.r, y));
      const got = await hdrAt(s.r, mid, y);
      // a half float's rounding, and the gradient across the pixel's own height
      for (let k = 0; k < 3; k++) expect(Math.abs(got[k] - want[k]), `row ${y}`).toBeLessThan(0.012);
    }
  });

  it('is under the scene: a block in front of it is the block', async () => {
    const wall = block(20, 2, 30, 0, 60, -5, [0.8, 0.2, 0.1]);
    const s = await make({ sky: SKY, groups: [wall] });
    s.r.frame(s.view);
    const c = await hdrAt(s.r, SIZE / 2, SIZE / 2);
    const sky = skyColour(SKY, upAt(s.r, SIZE / 2));
    // the block's red, not the sky's blue
    expect(c[0]).toBeGreaterThan(c[2]);
    expect(Math.abs(c[2] - sky[2])).toBeGreaterThan(0.3);
  });

  it('is the same at four samples a pixel and in a kept frame as drawn plain', async () => {
    const plain = await make({ sky: SKY });
    plain.r.frame(plain.view);
    const p = await readPixels(gpu, plain.target);
    const msaa = await make({ sky: SKY, msaa: true });
    msaa.r.frame(msaa.view);
    const m = await readPixels(gpu, msaa.target);
    // the gradient has no edge to resolve: every pixel the same
    expect(differing(p, m)).toBe(0);
    const kept = await make({ sky: SKY });
    kept.r.frame(kept.view, 'keep');
    kept.r.frame(kept.view, 'keep');
    expect(differing(p, await readPixels(gpu, kept.target))).toBe(0);
    const keptMsaa = await make({ sky: SKY, msaa: true });
    keptMsaa.r.frame(keptMsaa.view, 'keep');
    keptMsaa.r.frame(keptMsaa.view, 'keep');
    expect(differing(p, await readPixels(gpu, keptMsaa.target))).toBe(0);
  });

  it('compiles nothing for a look that does not ask, and is the clear colour there', async () => {
    const s = await make();
    s.r.frame(s.view);
    expect((s.r as unknown as { skyPipeline: unknown }).skyPipeline).toBeNull();
    expect((s.r as unknown as { skyBuild: unknown }).skyBuild).toBeNull();
    const c = await hdrAt(s.r, SIZE / 2, 5);
    expect(c[0]).toBeCloseTo(1, 2);
    expect(c[1]).toBeCloseTo(0, 2);
    expect(c[2]).toBeCloseTo(1, 2);
  });

  it('is asked for and dropped again: the clear colour comes back', async () => {
    const s = await make({ sky: SKY });
    s.r.frame(s.view);
    s.r.look = { ...s.r.look, sky: undefined };
    s.r.frame(s.view);
    const c = await hdrAt(s.r, SIZE / 2, 5);
    expect(c[1]).toBeCloseTo(0, 2);
  });
});
