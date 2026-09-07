/**
 * The furnace: the raster path and the tracer under skies whose light is
 * known, so each can be held to the answer and to each other. A Lambertian
 * table under a sky gives off its albedo times the sky's cosine-weighted
 * irradiance over pi; the sample cube the environment reads back lets that
 * integral be taken on the CPU, and a uniform sky of the same value gives
 * the pixel it should map to through the film. Under a uniform sky the two
 * paths must agree; under a band of light overhead, where a wrong
 * integration shows, both must land near the integral.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { Renderer } from '../renderer';
import { compile } from '../../dsl/index';
import { groupByMesh } from '../../assembly/groups';
import { cubeDirection, texelSolidAngle, type EnvSamples } from '../env';

const SIZE = 256;

/** Irradiance over pi on an upward face, from the baked sample cube. */
function upIrradiance(env: EnvSamples): number {
  let e = 0;
  for (let f = 0; f < 6; f++) for (let y = 0; y < env.size; y++) for (let x = 0; x < env.size; x++) {
    const d = cubeDirection(f, (2 * (x + 0.5)) / env.size - 1, (2 * (y + 0.5)) / env.size - 1);
    if (d[2] <= 0) continue;
    const i = (y * env.size + x) * 4;
    e += (0.2126 * env.faces[f][i] + 0.7152 * env.faces[f][i + 1] + 0.0722 * env.faces[f][i + 2]) * d[2] * texelSolidAngle(x, y, env.size);
  }
  return e / Math.PI;
}

describe('the furnace', () => {
  let gpu: Gpu; let renderer: Renderer; let target: GPUTexture;
  const view = () => target.createView();

  beforeAll(async () => {
    gpu = await createDevice();
    renderer = new Renderer(gpu);
    await renderer.ready;
    target = gpu.device.createTexture({ size: [SIZE, SIZE], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const r = compile('part b = bead(radius: 6, point: 3) in silver satin\nform f {\n  place b at (0, 0, 3)\n}\n');
    renderer.setSize(SIZE, SIZE);
    renderer.setKeyLight({ elevation: 1, azimuth: 0, strength: 0, warmth: 0, size: 0.1 });
    renderer.setTable('linen');
    renderer.setInstanced(groupByMesh(r.sketch!.assembly));
    renderer.frameBounds({ min: [-20, -20, 0], max: [20, 20, 10] });
    renderer.setFocus(60, 60);
  });
  afterAll(() => { renderer.dispose(); target.destroy(); gpu.device.destroy(); });

  async function pixels(): Promise<Uint8Array> {
    await gpu.queue.onSubmittedWorkDone();
    const buffer = gpu.device.createBuffer({ size: SIZE * 4 * SIZE, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = gpu.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow: SIZE * 4 }, [SIZE, SIZE, 1]);
    gpu.queue.submit([enc.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(buffer.getMappedRange()).slice();
    buffer.unmap(); buffer.destroy();
    return px;
  }
  /** The mean red of a block of the table just below the bead. */
  function table(px: Uint8Array): number {
    let sum = 0, n = 0;
    for (let y = 185; y <= 195; y++) for (let x = 123; x <= 133; x++) { sum += px[(y * SIZE + x) * 4 + 2]; n++; }
    return sum / n;
  }
  /** A lat-long sky: a level everywhere, and a band of rows lit brighter. */
  function sky(base: number, lit: (row: number) => boolean, bright: number) {
    const w = 64, h = 32, data = new Float32Array(w * h * 4).fill(base);
    for (let y = 0; y < h; y++) if (lit(y)) data.fill(bright, y * w * 4, (y + 1) * w * 4);
    return { width: w, height: h, data };
  }
  async function raster(): Promise<Uint8Array> {
    renderer.setQuality('final'); renderer.setMoving(false);
    // until the renderer has nothing more to do — bakes between chunks included — not for a guessed number of frames
    const deadline = performance.now() + 20_000;
    do { renderer.render(view); await new Promise((r) => setTimeout(r, 10)); } while (renderer.pending && performance.now() < deadline);
    renderer.requestRender(); renderer.render(view);
    return pixels();
  }
  async function traced(samples: number): Promise<Uint8Array> {
    renderer.setQuality('traced'); renderer.setMoving(false);
    for (let i = 0; i < 20000 && renderer.traceSamples < samples; i++) { renderer.requestRender(); renderer.render(view); await new Promise((r) => setTimeout(r, 1)); }
    const px = await pixels();
    renderer.setQuality('draft');
    return px;
  }

  it('under a uniform sky the two paths agree on the table', async () => {
    renderer.setEnvironmentImage(sky(1, () => false, 1), 1);
    await renderer.setEnvironment('image').samples;
    const a = table(await raster()), b = table(await traced(200));
    expect(Math.abs(a - b)).toBeLessThan(2.5);
  });

  it('a polished bead reflects the table where the tracer does', async () => {
    const r = compile('part b = bead(radius: 8, point: 0) in silver polished\nform f {\n  place b at (0, 0, 8)\n}\n');
    renderer.setEnvironmentImage(sky(1, () => false, 1), 1);
    renderer.setTable('matte');
    renderer.setInstanced(groupByMesh(r.sketch!.assembly));
    renderer.camera.target = [0, 0, 8]; renderer.camera.position = [0, -60, 40]; renderer.camera.near = 1; renderer.camera.far = 300;
    renderer.setFocus(70, 70);
    await renderer.setEnvironment('image').samples;
    const a = await raster(), b = await traced(200);
    // red down the bead's centre line: the sky above, the dark table reflected below, the same rows in both
    const column = (px: Uint8Array, y: number) => { let s = 0; for (let x = 124; x < 132; x++) s += px[(y * SIZE + x) * 4 + 2]; return s / 8; };
    for (const y of [88, 104, 120, 152, 168, 184]) expect(Math.abs(column(a, y) - column(b, y)), `row ${y}`).toBeLessThan(14);
    expect(column(a, 104)).toBeGreaterThan(120);
    expect(column(a, 168)).toBeLessThan(60);
    // and at twice the exposure the reflected table is exposed once, as the tracer exposes it: it read 193 against 170 while the probe was exposed twice
    renderer.setTable('linen'); renderer.setExposure(2);
    const a2 = await raster(), b2 = await traced(200);
    for (const y of [152, 168]) expect(Math.abs(column(a2, y) - column(b2, y)), `row ${y} at exposure 2`).toBeLessThan(16);
    renderer.setExposure(1);
    // and back to the table and bead the other cases use
    renderer.setTable('linen');
    const again = compile('part b = bead(radius: 6, point: 3) in silver satin\nform f {\n  place b at (0, 0, 3)\n}\n');
    renderer.setTable('linen');
    renderer.setInstanced(groupByMesh(again.sketch!.assembly));
    renderer.frameBounds({ min: [-20, -20, 0], max: [20, 20, 10] });
    renderer.setFocus(60, 60);
  });

  it('under a band of light overhead both land by the cosine integral, which a uniform sky of the same value calibrates', async () => {
    // the calibrating sky: uniform, at the irradiance the band will give
    const band = sky(0.02, (row) => row < 6, 4);
    renderer.setEnvironmentImage(band, 1);
    const bandSamples = await renderer.setEnvironment('image').samples;
    const e = upIrradiance(bandSamples);
    const a = table(await raster()), b = table(await traced(300));
    // uniform: the image's mean is scaled to a preset radiance, so the one asked for is set by the mean passed
    renderer.setEnvironmentImage(sky(1, () => false, 1), 1);
    const flat = await renderer.setEnvironment('image').samples;
    const unit = upIrradiance(flat);
    renderer.setEnvironmentImage(sky(1, () => false, 1), unit / e);
    await renderer.setEnvironment('image').samples;
    const expected = table(await raster());
    // the band's is a fifth again the uniform sky's: a table reading double, as it did once, is far outside this
    expect(Math.abs(a - expected)).toBeLessThan(4);
    expect(Math.abs(b - expected)).toBeLessThan(4);
  });
});
