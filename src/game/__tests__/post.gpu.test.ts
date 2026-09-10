/**
 * The post chain, on a real device: bloom spreads a bright thing past its
 * edge, the vignette darkens the corners and not the middle, the grain
 * changes a flat frame from one frame to the next by about its amplitude,
 * and with the rung off the frame is what it was before any of this.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { bakeEnvironment } from '../../render/env';
import { DEFAULT_POST, EFFECT_STRIDE, GameRenderer } from '../renderer';
import { LightPool } from '../lights';

const SIZE = 256;

describe('post-processing on the game renderer', () => {
  let gpu: Gpu;
  let renderer: GameRenderer;
  let target: GPUTexture;
  const view = () => target.createView();

  beforeAll(async () => {
    gpu = await createDevice();
    renderer = new GameRenderer(gpu, 8, 8, 64);
    await renderer.ready;
    target = gpu.device.createTexture({
      size: [SIZE, SIZE], format: gpu.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const env = bakeEnvironment(gpu, 'studio', { size: 32, mips: 3 });
    await env.samples;
    renderer.setEnvironment(env.specular, env.brdf, env.mips);
    renderer.resize(SIZE, SIZE);
    renderer.setStatic([]);
    renderer.setDynamic([]);
    renderer.setLights(new LightPool(8));
    renderer.camera.position = [0, -400, 0];
    renderer.camera.target = [0, 0, 0];
  });

  afterAll(() => { renderer?.dispose(); target?.destroy(); gpu?.device.destroy(); });

  /** The frame's channels, as bytes. */
  async function read(): Promise<{ px: Uint8Array; row: number }> {
    await gpu.queue.onSubmittedWorkDone();
    const row = Math.ceil((SIZE * 4) / 256) * 256;
    const buffer = gpu.device.createBuffer({ size: row * SIZE, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = gpu.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow: row, rowsPerImage: SIZE }, [SIZE, SIZE, 1]);
    gpu.queue.submit([enc.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(buffer.getMappedRange().slice(0));
    buffer.unmap(); buffer.destroy();
    return { px, row };
  }
  const lum = (f: { px: Uint8Array; row: number }, x: number, y: number) => {
    const o = y * f.row + x * 4;
    return (f.px[o] + f.px[o + 1] + f.px[o + 2]) / 3;
  };
  /** Mean brightness over a square patch. */
  const patch = (f: { px: Uint8Array; row: number }, x0: number, y0: number, n: number) => {
    let s = 0;
    for (let y = y0; y < y0 + n; y++) for (let x = x0; x < x0 + n; x++) s += lum(f, x, y);
    return s / (n * n);
  };

  /** A flat frame: the background alone, at a chosen brightness. */
  function flat(level: number) {
    renderer.look = { ...renderer.look, ambient: 0, sunColour: [0, 0, 0], background: [level, level, level] };
  }

  it('leaves a flat frame alone with the rung off, and with everything at nothing', async () => {
    flat(0.5);
    renderer.economy = { ...renderer.economy, post: false };
    renderer.frame(view());
    const off = await read();
    renderer.economy = { ...renderer.economy, post: true };
    renderer.post = { bloom: 0, threshold: 1, knee: 0.5, vignette: 0, grain: 0 };
    renderer.frame(view());
    const nothing = await read();
    // the same everywhere: the middle and a corner, to within a level
    expect(Math.abs(patch(off, 120, 120, 16) - patch(nothing, 120, 120, 16))).toBeLessThan(1.5);
    expect(Math.abs(patch(off, 4, 4, 16) - patch(nothing, 4, 4, 16))).toBeLessThan(1.5);
    // and a corner is the middle: no vignette
    expect(Math.abs(patch(off, 4, 4, 16) - patch(off, 120, 120, 16))).toBeLessThan(1.5);
  });

  it('darkens the corners and not the middle with the vignette', async () => {
    flat(0.5);
    renderer.post = { bloom: 0, threshold: 1, knee: 0.5, vignette: 0, grain: 0 };
    renderer.frame(view());
    const plain = await read();
    renderer.post = { ...renderer.post, vignette: 0.6 };
    renderer.frame(view());
    const shaded = await read();
    expect(Math.abs(patch(shaded, 120, 120, 16) - patch(plain, 120, 120, 16))).toBeLessThan(2);
    // the corner is over nine tenths of the way out, and the vignette
    // works on the tonemapped value under the gamma: 0.6 there shows as
    // about 0.7 of plain once the gamma has flattened it
    expect(patch(shaded, 4, 4, 16)).toBeLessThan(patch(plain, 4, 4, 16) * 0.8);
  });

  it('spreads a bright glow past its edge with bloom, and not without', async () => {
    // A hot glow at the middle of a black frame, well over the threshold:
    // with bloom, a ring outside its radius lights up. Read a band of pixels
    // well outside the glow's own footprint.
    flat(0);
    // one effect quad in the middle of the screen: a twelfth of the frame
    // wide, forty times white, with a hard core
    renderer.setEffects(new Float32Array([0, 0, 1 / 12, 40, 1, 1, 1, 3]), 1);
    renderer.post = { bloom: 0, threshold: 1, knee: 0.5, vignette: 0, grain: 0 };
    renderer.frame(view());
    const sharp = await read();
    renderer.post = { ...renderer.post, bloom: 1 };
    renderer.frame(view());
    const bloomed = await read();
    renderer.setEffects(new Float32Array(EFFECT_STRIDE), 0);
    // the quad is a twelfth of the frame — 21 pixels — to its edge, and its
    // fade is inside that; sample a ring 32 pixels out from the middle
    const ring = (f: { px: Uint8Array; row: number }) => {
      let s = 0, n = 0;
      for (let a = 0; a < 16; a++) {
        const x = Math.round(128 + 32 * Math.cos((a / 16) * Math.PI * 2));
        const y = Math.round(128 + 32 * Math.sin((a / 16) * Math.PI * 2));
        s += lum(f, x, y); n++;
      }
      return s / n;
    };
    expect(lum(sharp, 128, 128)).toBeGreaterThan(200);
    expect(ring(sharp)).toBeLessThan(2);
    expect(ring(bloomed)).toBeGreaterThan(ring(sharp) + 4);
  });

  it('does not bloom what is under the threshold', async () => {
    flat(0.3);
    renderer.post = { bloom: 1, threshold: 1, knee: 0.5, vignette: 0, grain: 0 };
    renderer.frame(view());
    const under = await read();
    renderer.post = { ...renderer.post, bloom: 0 };
    renderer.frame(view());
    const plain = await read();
    expect(Math.abs(patch(under, 120, 120, 16) - patch(plain, 120, 120, 16))).toBeLessThan(1.5);
  });

  it('leaves the black alone under the grain', async () => {
    flat(0);
    renderer.post = { bloom: 0, threshold: 1, knee: 0.5, vignette: 0, grain: 0.1 };
    renderer.frame(view(), 'redraw', 1 / 60);
    const black = await read();
    expect(patch(black, 64, 64, 64)).toBeLessThan(0.5);
  });

  it('rolls the grain from frame to frame, by about its amplitude', async () => {
    flat(0.5);
    renderer.post = { bloom: 0, threshold: 1, knee: 0.5, vignette: 0, grain: 0.1 };
    renderer.frame(view(), 'redraw', 1 / 60);
    const a = await read();
    renderer.frame(view(), 'redraw', 1 / 60);
    const b = await read();
    // mean unchanged, spread within a frame is a good part of the amplitude,
    // and the pattern moved
    expect(Math.abs(patch(a, 64, 64, 64) - patch(b, 64, 64, 64))).toBeLessThan(1.5);
    let dev = 0, moved = 0;
    const mean = patch(a, 64, 64, 64);
    for (let y = 64; y < 128; y++) for (let x = 64; x < 128; x++) {
      dev += Math.abs(lum(a, x, y) - mean);
      moved += Math.abs(lum(a, x, y) - lum(b, x, y));
    }
    dev /= 64 * 64; moved /= 64 * 64;
    expect(dev).toBeGreaterThan(3);
    expect(moved).toBeGreaterThan(3);
    renderer.post = { ...DEFAULT_POST };
  });
});
