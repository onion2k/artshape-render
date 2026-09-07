/**
 * The set drawn on every table the renderer offers.
 *
 * This is here for one bug. The reflection a polished face shows of the table
 * is worked out by running a ray from the face down to the disc and shading
 * the table where it lands. Every test guarding that ray — is it pointing
 * downward, is the distance positive, did it land inside the disc — was
 * written as a comparison that a NaN passes: "dir.z >= -1e-4" is false for a
 * NaN, so a ray that was not a direction at all went through to be
 * intersected, and the table was asked what it looked like at a point that
 * was not a point.
 *
 * Matte does not read the point it is given, so it answered anyway. Every
 * other table — the woods, the slate, the cloths — reads it and answered NaN.
 * That went into the light probe; the probe is prefiltered down a mip chain,
 * and that chain is what every reflective surface in the frame reads. One bad
 * ray turned the whole picture black, piece, table and all.
 *
 * What this test does NOT do is reproduce that. The failure was found with a
 * chess set on a board driven by a program of its own — men in groups that
 * move, standing where a game had put them — and it has not been cornered
 * into a scene small enough to keep here; the sketch below, drawn from the
 * same view, comes out right either way. So read this as what it is: a check
 * that every table draws something rather than nothing, which is the shape
 * the failure took, and a place to record it. If a table ever comes back
 * blank, this is the first thing to run and the note above is the first thing
 * to read.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { Renderer, tableNames } from '../renderer';
import { compile } from '../../dsl/index';
import { resolveSketch, sketches } from './fixtures';
import { groupByMesh } from '../../assembly/groups';
import { setDetail } from '../../mesh/detail';

const SIZE = 192;

/** The frame read back, as [r, g, b] per pixel whatever byte order the format has. */
async function readFrame(gpu: Gpu, texture: GPUTexture) {
  const bytesPerRow = Math.ceil((SIZE * 4) / 256) * 256;
  const buffer = gpu.device.createBuffer({ size: bytesPerRow * SIZE, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = gpu.device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [SIZE, SIZE, 1]);
  gpu.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const packed = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  const bgra = gpu.format.startsWith('bgra');
  const at = (x: number, y: number): [number, number, number] => {
    const i = y * bytesPerRow + x * 4;
    return bgra ? [packed[i + 2], packed[i + 1], packed[i]] : [packed[i], packed[i + 1], packed[i + 2]];
  };
  let lit = 0;
  const seen = new Set<string>();
  for (let y = 0; y < SIZE; y += 2) for (let x = 0; x < SIZE; x += 2) {
    const p = at(x, y);
    seen.add(p.join(','));
    // above the page's own dark ground, allowing for the film's grain
    if (p[0] + p[1] + p[2] > 60) lit++;
  }
  return { at, lit, colours: seen.size, sampled: (SIZE / 2) * (SIZE / 2) };
}

describe('every table the renderer offers', () => {
  let gpu: Gpu;
  let renderer: Renderer;
  let target: GPUTexture;
  const errors: string[] = [];
  const consoleError = console.error;

  beforeAll(async () => {
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); consoleError(...args); };
    setDetail(0.5);
    gpu = await createDevice();
    renderer = new Renderer(gpu);
    await renderer.ready;
    target = gpu.device.createTexture({
      label: 'table target', size: [SIZE, SIZE], format: gpu.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });

    const result = compile(sketches.chess, { resolve: resolveSketch });
    expect(result.error).toBeUndefined();
    const assembly = result.sketch!.assembly;
    renderer.setSize(SIZE, SIZE);
    renderer.setKeyLight({ elevation: Math.PI / 4, azimuth: -Math.PI / 4, strength: 1, warmth: 0.3, size: 0.08 });
    renderer.setMaterial('silver', 'satin');
    // the men move, as they do in a game: a dynamic group is left out of the
    // sky occlusion bake, and it was a dynamic group's shading that first
    // produced the ray this test is here for
    // the men move, as they do in a game: a dynamic group is left out of the
    // sky occlusion bake, which is how the scene that failed was arranged
    renderer.setInstanced(groupByMesh(assembly).map((g, i) => ({ ...g, dynamic: i > 5 })));
    renderer.frameBounds(assembly.bounds());
    // the view the bug was found from: down the board from behind one army,
    // which is where the reflection rays that went wrong were cast
    renderer.setLens(46);
    renderer.setEnvStrength(0.3);
    const elevation = 0.72, distance = 600;
    renderer.camera.target = [0, 0, 17];
    renderer.camera.position = [0, -Math.cos(elevation) * distance, 17 + Math.sin(elevation) * distance];
    renderer.setFocus(distance, distance);
    await renderer.setEnvironment('studio').samples;
  });

  afterAll(() => {
    console.error = consoleError;
    setDetail(1);
    renderer?.dispose();
    target?.destroy();
    gpu?.device.destroy();
  });

  /** Draw until the renderer says there is nothing more due, then read the frame. */
  async function settled() {
    for (let i = 0; i < 12 && renderer.pending; i++) {
      renderer.render(() => target.createView());
      await gpu.queue.onSubmittedWorkDone();
    }
    // one more, so the probe baked on the last tick is in the picture
    renderer.requestRender();
    renderer.render(() => target.createView());
    await gpu.queue.onSubmittedWorkDone();
    return readFrame(gpu, target);
  }

  it.each(tableNames)('draws the set on %s', async (table) => {
    renderer.setTable(table);
    const frame = await settled();
    // the whole picture went black on every table but matte, so what this
    // watches for is a frame that is nothing but the page behind it
    expect(frame.lit / frame.sampled).toBeGreaterThan(0.15);
    expect(frame.colours).toBeGreaterThan(50);
    // the board is lit and the corner is the page's own ground
    const centre = frame.at(SIZE / 2, SIZE / 2);
    expect(centre[0] + centre[1] + centre[2]).toBeGreaterThan(60);
  });

  it('says nothing to the console while drawing any of them', () => {
    expect(errors).toEqual([]);
  });
});
