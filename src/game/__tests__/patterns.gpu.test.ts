/**
 * Patterns on a placement, on a real device: a patterned ball shows its
 * second colour as well as its first, the pattern is fixed to the ball and
 * turns with it, and a group with no patterns draws exactly as it did
 * before patterns were there. Pixel checks, since a pattern that was not
 * drawn has no other symptom.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server } from '@vitest/browser/context';
import { createDevice, type Gpu } from '../../gpu/context';
import { MeshBuilder, type Mesh } from '../../mesh/types';
import { bakeEnvironment } from '../../render/env';
import { GameRenderer, PATTERN_STRIDE, type GameGroup } from '../renderer';
import { LightPool } from '../lights';

const SIZE = 192;
const FRAME_DIR: string | undefined = import.meta.env.VITE_FRAME_DIR;

/** A smooth ball of radius one, centred. */
function ball(): Mesh {
  const b = new MeshBuilder();
  const rings = 24,
    segments = 32;
  for (let i = 0; i <= rings; i++) {
    const phi = (i / rings) * Math.PI;
    for (let j = 0; j <= segments; j++) {
      const th = (j / segments) * Math.PI * 2;
      const x = Math.sin(phi) * Math.cos(th),
        y = Math.sin(phi) * Math.sin(th),
        z = Math.cos(phi);
      b.vertex(x, y, z, x, y, z, j / segments, i / rings);
    }
  }
  const row = segments + 1;
  for (let i = 0; i < rings; i++) for (let j = 0; j < segments; j++) b.quad(i * row + j, (i + 1) * row + j, (i + 1) * row + j + 1, i * row + j + 1);
  return b.build();
}

/** One placement at the origin, scaled by 40 and turned `angle` about the axis (1, 1, 1). */
function placed(angle: number): Float32Array {
  const [x, y, z] = [1, 1, 1].map((v) => v / Math.sqrt(3));
  const c = Math.cos(angle),
    s = Math.sin(angle),
    k = 1 - c,
    r = 40;
  return new Float32Array([
    (c + x * x * k) * r, (y * x * k + z * s) * r, (z * x * k - y * s) * r, 0,
    (x * y * k - z * s) * r, (c + y * y * k) * r, (z * y * k + x * s) * r, 0,
    (x * z * k + y * s) * r, (y * z * k - x * s) * r, (c + z * z * k) * r, 0,
    0, 0, 0, 1,
  ]);
}

describe('patterns on the game renderer', () => {
  let gpu: Gpu;
  let renderer: GameRenderer;
  let target: GPUTexture;
  const mesh = ball();
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
    renderer.setLights(new LightPool(8));
    renderer.look = { ...renderer.look, background: [0, 0, 0] };
    // the grain moves every frame, and two frames of the same thing are compared here
    renderer.post = { bloom: 0, threshold: 1, knee: 0.5, vignette: 0, grain: 0 };
    renderer.camera.position = [0, -160, 60];
    renderer.camera.target = [0, 0, 0];
  });

  afterAll(() => { renderer?.dispose(); target?.destroy(); gpu?.device.destroy(); });

  async function pixels(): Promise<Uint8Array> {
    await gpu.queue.onSubmittedWorkDone();
    const bytesPerRow = Math.ceil((SIZE * 4) / 256) * 256;
    const buffer = gpu.device.createBuffer({ size: bytesPerRow * SIZE, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = gpu.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow, rowsPerImage: SIZE }, [SIZE, SIZE, 1]);
    gpu.queue.submit([enc.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const out = new Uint8Array(SIZE * SIZE * 4);
    const px = new Uint8Array(buffer.getMappedRange());
    for (let y = 0; y < SIZE; y++) out.set(px.subarray(y * bytesPerRow, y * bytesPerRow + SIZE * 4), y * SIZE * 4);
    buffer.unmap();
    buffer.destroy();
    return out;
  }

  /** The ball drawn once, red, with `pattern` over it or none, turned `angle`. */
  async function draw(pattern: number[] | null, angle = 0): Promise<Uint8Array> {
    const group: GameGroup = { mesh, matrices: placed(angle), albedo: [0.7, 0.05, 0.05], roughness: 0.5 };
    if (pattern) group.patterns = new Float32Array(pattern);
    renderer.setDynamic([group]);
    renderer.frame(view());
    return pixels();
  }

  /** How many pixels lean red, and how many lean blue, over the frame; a format that is bgra swaps them, so both ways. */
  function hues(px: Uint8Array): { red: number; blue: number } {
    let a = 0,
      b = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] > px[i + 2] + 40) a++;
      if (px[i + 2] > px[i] + 40) b++;
    }
    return { red: Math.max(a, b), blue: Math.min(a, b) };
  }

  const differing = (a: Uint8Array, b: Uint8Array) => {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 12) n++;
    return n;
  };

  it('has eight floats a placement: kind, scale and seed, then the second colour', () => {
    expect(PATTERN_STRIDE).toBe(8);
  });

  it('draws a group with no patterns, and one whose patterns are all none, the same to the pixel', async () => {
    const plain = await draw(null);
    const none = await draw([0, 1, 0, 0, 0.1, 0.1, 0.9, 0]);
    expect(differing(plain, none)).toBe(0);
    expect(hues(plain).red).toBeGreaterThan(1000);
  });

  for (const kind of [1, 2, 3, 4])
    it(`shows the second colour as well as the first, in pattern ${kind}`, async () => {
      const px = await draw([kind, 1, 0.3, 0, 0.05, 0.1, 0.8, 0]);
      const { red, blue } = hues(px);
      await save(`pattern-${kind}`, px);
      expect(red, 'the first colour still shows').toBeGreaterThan(300);
      expect(blue, 'and the second shows too').toBeGreaterThan(300);
    });

  it('keeps its pattern on the ball as it turns, where a plain ball looks the same turned', async () => {
    // a plain ball turned is not quite the same, since its facets turn with it: the pattern has to move far more
    const pattern = [1, 1, 0.3, 0, 0.05, 0.1, 0.8, 0];
    const patterned = differing(await draw(pattern, 0), await draw(pattern, 0.8));
    const plain = differing(await draw(null, 0), await draw(null, 0.8));
    expect(patterned).toBeGreaterThan(400);
    expect(patterned).toBeGreaterThan(plain * 5);
  });

  /** The frame, for looking at, where VITE_FRAME_DIR asks for it. */
  async function save(name: string, px: Uint8Array) {
    if (!FRAME_DIR) return;
    const c = document.createElement('canvas');
    c.width = SIZE;
    c.height = SIZE;
    const g = c.getContext('2d')!;
    const img = g.createImageData(SIZE, SIZE);
    const bgr = gpu.format.startsWith('bgra');
    for (let i = 0; i < SIZE * SIZE; i++) {
      const o = i * 4;
      img.data.set(bgr ? [px[o + 2], px[o + 1], px[o], 255] : [px[o], px[o + 1], px[o + 2], 255], o);
    }
    g.putImageData(img, 0, 0);
    await server.commands.writeFile(`${FRAME_DIR}/${name}.png`, c.toDataURL('image/png').split(',')[1], 'base64');
  }
});
