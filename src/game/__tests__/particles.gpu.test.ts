/**
 * Particles, on a real device: a burst appears where it was emitted, dies
 * when its life is up, falls to its floor, and is not there at all when the
 * ladder turns the pool off. Pixel checks, because a particle that was not
 * drawn has no other symptom.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { bakeEnvironment } from '../../render/env';
import { GameRenderer } from '../renderer';
import { LightPool } from '../lights';

const SIZE = 256;

describe('particles on the game renderer', () => {
  let gpu: Gpu;
  let renderer: GameRenderer;
  let target: GPUTexture;
  const view = () => target.createView();

  beforeAll(async () => {
    gpu = await createDevice();
    renderer = new GameRenderer(gpu, 8, 8, 4096);
    await renderer.ready;
    target = gpu.device.createTexture({
      size: [SIZE, SIZE], format: gpu.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const env = bakeEnvironment(gpu, 'studio', { size: 32, mips: 3 });
    await env.samples;
    renderer.setEnvironment(env.specular, env.brdf, env.mips);
    renderer.resize(SIZE, SIZE);
    // nothing in the scene but the dark: what is bright is a particle
    renderer.setStatic([]);
    renderer.setDynamic([]);
    renderer.setLights(new LightPool(8));
    renderer.look = { ...renderer.look, ambient: 0, sunColour: [0, 0, 0], background: [0, 0, 0] };
    renderer.camera.position = [0, -400, 200];
    renderer.camera.target = [0, 0, 0];
    renderer.gravity = 981;
  });

  afterAll(() => { renderer?.dispose(); target?.destroy(); gpu?.device.destroy(); });

  /** Mean brightness over the frame, and over its top and bottom halves. */
  async function read(): Promise<{ mean: number; top: number; bottom: number }> {
    await gpu.queue.onSubmittedWorkDone();
    const bytesPerRow = Math.ceil((SIZE * 4) / 256) * 256;
    const buffer = gpu.device.createBuffer({ size: bytesPerRow * SIZE, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = gpu.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow, rowsPerImage: SIZE }, [SIZE, SIZE, 1]);
    gpu.queue.submit([enc.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(buffer.getMappedRange().slice(0));
    buffer.unmap(); buffer.destroy();
    let sum = 0, top = 0, bottom = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const o = y * bytesPerRow + x * 4;
        const l = (px[o] + px[o + 1] + px[o + 2]) / 3;
        sum += l;
        if (y < SIZE / 2) top += l; else bottom += l;
      }
    }
    const n = SIZE * SIZE;
    return { mean: sum / n, top: top / (n / 2), bottom: bottom / (n / 2) };
  }

  it('draws a burst where it was emitted, and nothing before one', async () => {
    renderer.frame(view());
    const before = await read();
    expect(before.mean).toBeLessThan(1);

    renderer.emit({ position: [0, 0, 40], velocity: [0, 0, 0], spread: 30, count: 400, life: 2, size: 20, colour: [1, 1, 1], alpha: 0.9, gravity: 0 });
    renderer.frame(view(), 'redraw', 1 / 60);
    const lit = await read();
    expect(lit.mean).toBeGreaterThan(before.mean + 1);
  });

  it('lets them die when their life is up', async () => {
    // four half-second steps: two seconds, and the burst above is gone
    for (let i = 0; i < 4; i++) renderer.frame(view(), 'redraw', 0.5);
    renderer.frame(view(), 'redraw', 1 / 60);
    const after = await read();
    expect(after.mean).toBeLessThan(1);
  });

  it('drops what falls onto its floor, and keeps what floats', async () => {
    // The same burst twice, a second apart, once falling under gravity onto
    // a floor just below it and once floating. Read a second after each: the
    // faller has gone and the floater has not. Separate runs, because a
    // particle fades in over its first tenth and a reading straight after
    // emission is dimmer than one later — the first version of this compared
    // the two moments and measured the fade, not the floor.
    const burst = { position: [0, 0, 90] as [number, number, number], velocity: [0, 0, 0] as [number, number, number], spread: 15, count: 300, life: 4, size: 14, colour: [1, 1, 1] as [number, number, number], alpha: 0.9 };
    const settle = async () => { for (let i = 0; i < 10; i++) renderer.frame(view(), 'redraw', 0.1); return read(); };
    const clear = () => { for (let i = 0; i < 10; i++) renderer.frame(view(), 'redraw', 0.5); };

    renderer.emit({ ...burst, gravity: 1, floor: 80 });
    renderer.frame(view(), 'redraw', 1 / 60);
    const fallen = await settle();
    clear();
    renderer.emit({ ...burst, gravity: 0 });
    renderer.frame(view(), 'redraw', 1 / 60);
    const floated = await settle();
    clear();

    expect(floated.mean).toBeGreaterThan(0.5);
    expect(fallen.mean).toBeLessThan(floated.mean * 0.2);
  });

  it('draws none when the ladder turns them off, and all of them again after', async () => {
    renderer.emit({ position: [0, 0, 40], velocity: [0, 0, 0], spread: 10, count: 400, life: 2, size: 12, colour: [1, 1, 1], alpha: 0, gravity: 0 });
    renderer.economy = { ...renderer.economy, particles: false };
    renderer.frame(view(), 'redraw', 1 / 60);
    const off = await read();
    renderer.economy = { ...renderer.economy, particles: true };
    renderer.frame(view(), 'redraw', 1 / 60);
    const on = await read();
    expect(off.mean).toBeLessThan(1);
    expect(on.mean).toBeGreaterThan(2);
    for (let i = 0; i < 6; i++) renderer.frame(view(), 'redraw', 0.5);
  });

  it('refuses a burst past the emitter list, and none before it', async () => {
    let accepted = 0;
    for (let i = 0; i < 200; i++) {
      if (renderer.emit({ position: [0, 0, 0], velocity: [0, 0, 0], spread: 0, count: 1, life: 1, size: 1, colour: [1, 1, 1], alpha: 1 })) accepted++;
    }
    expect(accepted).toBe(128);
    renderer.frame(view(), 'redraw', 1 / 60);
    for (let i = 0; i < 4; i++) renderer.frame(view(), 'redraw', 0.5);
  });
});
