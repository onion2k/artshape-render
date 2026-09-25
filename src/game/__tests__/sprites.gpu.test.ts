/**
 * Sprites, on a real device: soft camera-facing puffs the game places itself
 * every frame, where particles are born and aged on the GPU. A sprite is drawn
 * where it is put, lets what is behind it show through by as much as its alpha
 * leaves, is hidden by what stands in front of it, and is gone when the list is
 * empty or the ladder turns particles off. Pixel checks.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { MeshBuilder } from '../../mesh/types';
import { bakeEnvironment } from '../../render/env';
import { GameRenderer } from '../renderer';
import { LightPool } from '../lights';
import { SPRITE_STRIDE } from '../particles';

const SIZE = 128;

/** A flat square facing the camera, `half` across from its middle, at depth `y`. */
function wall(half: number, y: number) {
  const b = new MeshBuilder();
  const a = b.vertex(-half, y, -half, 0, -1, 0, 0, 0);
  b.vertex(half, y, -half, 0, -1, 0, 1, 0);
  b.vertex(half, y, half, 0, -1, 0, 1, 1);
  b.vertex(-half, y, half, 0, -1, 0, 0, 1);
  b.quad(a, a + 1, a + 2, a + 3);
  return b.build();
}

describe('sprites on the game renderer', () => {
  let gpu: Gpu;
  let renderer: GameRenderer;
  let target: GPUTexture;
  const view = () => target.createView();
  const one = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

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
    renderer.setDynamic([]);
    renderer.setLights(new LightPool(8));
    renderer.look = { ...renderer.look, background: [0, 0, 0] };
    // the grain moves every frame, and frames are compared here
    renderer.post = { bloom: 0, threshold: 1, knee: 0.5, vignette: 0, grain: 0 };
    renderer.camera.position = [0, -200, 0];
    renderer.camera.target = [0, 0, 0];
  });

  afterAll(() => { renderer?.dispose(); target?.destroy(); gpu?.device.destroy(); });

  /** The mean of the middle of the frame, a tenth of it across, 0 to 255. */
  async function middle(): Promise<number> {
    await gpu.queue.onSubmittedWorkDone();
    const bytesPerRow = Math.ceil((SIZE * 4) / 256) * 256;
    const buffer = gpu.device.createBuffer({ size: bytesPerRow * SIZE, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = gpu.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow, rowsPerImage: SIZE }, [SIZE, SIZE, 1]);
    gpu.queue.submit([enc.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(buffer.getMappedRange().slice(0));
    buffer.unmap();
    buffer.destroy();
    let sum = 0,
      n = 0;
    const r = Math.round(SIZE / 20);
    for (let y = SIZE / 2 - r; y < SIZE / 2 + r; y++)
      for (let x = SIZE / 2 - r; x < SIZE / 2 + r; x++) {
        const o = y * bytesPerRow + x * 4;
        sum += (px[o] + px[o + 1] + px[o + 2]) / 3;
        n++;
      }
    return sum / n;
  }

  /** One grey puff at `y` along the camera's line, `size` across, `alpha` solid. */
  function puff(y: number, alpha: number, size = 30): Float32Array {
    const s = new Float32Array(SPRITE_STRIDE);
    s.set([0, y, 0, size, 0.8, 0.8, 0.8, alpha]);
    return s;
  }

  it('has eight floats a sprite: where, how big, what colour and how solid', () => {
    expect(SPRITE_STRIDE).toBe(8);
  });

  it('draws a puff where it is put, and nothing with none', async () => {
    renderer.setStatic([]);
    renderer.setSprites(new Float32Array(0), 0);
    renderer.frame(view());
    const none = await middle();
    renderer.setSprites(puff(0, 0.9), 1);
    renderer.frame(view());
    const one = await middle();
    expect(none).toBeLessThan(2);
    expect(one).toBeGreaterThan(40);
  });

  it('lets what is behind it show through, by as much as its alpha leaves', async () => {
    // a bright wall behind the puff: seen alone, through a thin puff, and through a thick one
    renderer.setStatic([{ mesh: wall(60, 40), matrices: one, albedo: [0.05, 0.05, 0.9], roughness: 0.6 }]);
    renderer.setSprites(new Float32Array(0), 0);
    renderer.frame(view());
    const bare = await middle();
    renderer.setSprites(puff(0, 0.3), 1);
    renderer.frame(view());
    const thin = await middle();
    renderer.setSprites(puff(0, 0.95), 1);
    renderer.frame(view());
    const thick = await middle();
    expect(Math.abs(thin - bare)).toBeGreaterThan(2);
    expect(Math.abs(thick - bare)).toBeGreaterThan(Math.abs(thin - bare) * 1.5);
  });

  it('is hidden by what stands in front of it', async () => {
    // the same wall between the camera and the puff: a puff behind it changes nothing
    renderer.setStatic([{ mesh: wall(60, -40), matrices: one, albedo: [0.05, 0.05, 0.9], roughness: 0.6 }]);
    renderer.setSprites(new Float32Array(0), 0);
    renderer.frame(view());
    const bare = await middle();
    renderer.setSprites(puff(0, 0.95), 1);
    renderer.frame(view());
    expect(Math.abs((await middle()) - bare)).toBeLessThan(1);
  });

  it('draws none when the ladder turns particles off, and again after', async () => {
    renderer.setStatic([]);
    renderer.setSprites(puff(0, 0.9), 1);
    renderer.economy = { ...renderer.economy, particles: false };
    renderer.frame(view());
    const off = await middle();
    renderer.economy = { ...renderer.economy, particles: true };
    renderer.frame(view());
    const on = await middle();
    expect(off).toBeLessThan(2);
    expect(on).toBeGreaterThan(40);
  });

  it('keeps no more than it has room for, and says how many that is', () => {
    const many = new Float32Array((renderer.spriteCapacity + 10) * SPRITE_STRIDE);
    expect(() => renderer.setSprites(many, renderer.spriteCapacity + 10)).not.toThrow();
    expect(renderer.spriteCapacity).toBeGreaterThanOrEqual(256);
  });
});
