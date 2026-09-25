/**
 * Toon shading and a straight tone, on a real device. A look that says
 * nothing of shading, and one that says physically based, draw alike to the
 * pixel, so no game that has not asked for toon sees any change. A toon look
 * lights a ball in a few flat bands and keeps its colour, where the physically
 * based look shades it smoothly and pulls it toward grey; and a straight tone
 * lets a white thing lit brightly reach white, where the filmic curve holds it
 * to grey. Pixel checks, since a look has no other symptom.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server } from '@vitest/browser/context';
import { createDevice, type Gpu } from '../../gpu/context';
import { MeshBuilder, type Mesh } from '../../mesh/types';
import { bakeEnvironment } from '../../render/env';
import { DEFAULT_POST, GameRenderer, type Look } from '../renderer';
import { LightPool } from '../lights';

const SIZE = 192;
const FRAME_DIR: string | undefined = import.meta.env.VITE_FRAME_DIR;

function ball(): Mesh {
  const b = new MeshBuilder();
  const rings = 32,
    segments = 48;
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
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < segments; j++) b.quad(i * row + j, (i + 1) * row + j, (i + 1) * row + j + 1, i * row + j + 1);
  return b.build();
}

describe('toon shading and a straight tone on the game renderer', () => {
  let gpu: Gpu;
  let renderer: GameRenderer;
  let target: GPUTexture;
  let base: Look;
  const mesh = ball();
  const one = new Float32Array([40, 0, 0, 0, 0, 40, 0, 0, 0, 0, 40, 0, 0, 0, 0, 1]);

  beforeAll(async () => {
    gpu = await createDevice();
    renderer = new GameRenderer(gpu, 8, 8, 64);
    await renderer.ready;
    target = gpu.device.createTexture({
      size: [SIZE, SIZE], format: gpu.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const env = bakeEnvironment(gpu, 'daylight', { size: 32, mips: 3 });
    await env.samples;
    renderer.setEnvironment(env.specular, env.brdf, env.mips);
    renderer.resize(SIZE, SIZE);
    renderer.setStatic([]);
    renderer.setLights(new LightPool(8));
    renderer.camera.position = [0, -160, 60];
    renderer.camera.target = [0, 0, 0];
    base = { ...renderer.look, background: [0, 0, 0], sunDir: [0.4, -0.5, 0.75], sunColour: [2.5, 2.5, 2.5] };
  });

  afterAll(() => { renderer?.dispose(); target?.destroy(); gpu?.device.destroy(); });

  async function draw(look: Partial<Look>, albedo: [number, number, number], tone?: 'filmic' | 'clamp', name = ''): Promise<number[][]> {
    renderer.look = { ...base, ...look };
    renderer.post = { ...DEFAULT_POST, bloom: 0, vignette: 0, grain: 0, ...(tone ? { tone } : {}) };
    renderer.setDynamic([{ mesh, matrices: one, albedo, roughness: 0.6 }]);
    renderer.frame(target.createView());
    await gpu.queue.onSubmittedWorkDone();
    const bytesPerRow = Math.ceil((SIZE * 4) / 256) * 256;
    const buffer = gpu.device.createBuffer({ size: bytesPerRow * SIZE, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = gpu.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow, rowsPerImage: SIZE }, [SIZE, SIZE, 1]);
    gpu.queue.submit([enc.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(buffer.getMappedRange());
    const bgr = gpu.format.startsWith('bgra');
    const out: number[][] = [];
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        const o = y * bytesPerRow + x * 4;
        out.push(bgr ? [px[o + 2], px[o + 1], px[o]] : [px[o], px[o + 1], px[o + 2]]);
      }
    buffer.unmap();
    buffer.destroy();
    if (FRAME_DIR && name) await save(name, out);
    return out;
  }

  async function save(name: string, px: number[][]) {
    const c = document.createElement('canvas');
    c.width = SIZE;
    c.height = SIZE;
    const g = c.getContext('2d')!;
    const img = g.createImageData(SIZE, SIZE);
    px.forEach((p, i) => img.data.set([p[0], p[1], p[2], 255], i * 4));
    g.putImageData(img, 0, 0);
    await server.commands.writeFile(`${FRAME_DIR}/${name}.png`, c.toDataURL('image/png').split(',')[1], 'base64');
  }

  /** The pixels the ball covers: anything off the black background. */
  const onBall = (px: number[][]) => px.filter((p) => p[0] + p[1] + p[2] > 12);

  it('draws a look that says nothing of shading, and one that says physically based, alike to the pixel', async () => {
    const unsaid = await draw({}, [0.8, 0.1, 0.1]);
    const said = await draw({ shading: 'pbr' }, [0.8, 0.1, 0.1], 'filmic');
    let differ = 0;
    unsaid.forEach((p, i) => { if (p.some((c, k) => c !== said[i][k])) differ++; });
    expect(differ).toBe(0);
    expect(onBall(unsaid).length).toBeGreaterThan(2000);
  });

  it('lights a ball in a few flat bands in toon, where the physically based look shades it smoothly', async () => {
    const levels = (px: number[][]) => {
      // how many shades of red cover a fiftieth of the ball or more
      const count = new Map<number, number>();
      const lit = onBall(px);
      for (const p of lit) count.set(p[0] >> 2, (count.get(p[0] >> 2) ?? 0) + 1);
      return [...count.values()].filter((n) => n > lit.length / 50).length;
    };
    const pbr = levels(await draw({}, [0.8, 0.1, 0.1], undefined, 'pbr'));
    const toon = levels(await draw({ shading: 'toon' }, [0.8, 0.1, 0.1], 'clamp', 'toon'));
    expect(toon, 'a few bands').toBeLessThanOrEqual(5);
    expect(pbr, 'a smooth shade').toBeGreaterThan(toon * 2);
  });

  it('keeps a colour in toon with a straight tone, where the physically based look pulls it toward grey', async () => {
    const chroma = (px: number[][]) => {
      const lit = onBall(px);
      return lit.reduce((s, p) => s + Math.max(...p) - Math.min(...p), 0) / lit.length;
    };
    const pbr = chroma(await draw({}, [0.8, 0.1, 0.1]));
    const toon = chroma(await draw({ shading: 'toon' }, [0.8, 0.1, 0.1], 'clamp'));
    expect(toon).toBeGreaterThan(pbr * 1.3);
  });

  it('lets a white thing lit brightly reach white with a straight tone, where the filmic curve holds it grey', async () => {
    const brightest = (px: number[][]) => Math.max(...onBall(px).map((p) => Math.min(...p)));
    const filmic = brightest(await draw({ shading: 'toon' }, [0.95, 0.95, 0.95], 'filmic'));
    const clamp = brightest(await draw({ shading: 'toon' }, [0.95, 0.95, 0.95], 'clamp'));
    expect(clamp).toBeGreaterThan(240);
    expect(filmic).toBeLessThan(clamp - 25);
  });
});
