/**
 * A stone under the tracer: the light that comes back out through the
 * crown is what a path finds after several reflections inside, so the
 * bounce budget a stone's paths are given decides how bright it is. A
 * diamond is traced with the ordinary budget and with its own, and the
 * crown must come out brighter with the longer one; and with a longer
 * one still it must move less than it did, so the budget is enough.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { Renderer } from '../renderer';
import { compile } from '../../dsl/index';
import { groupByMesh } from '../../assembly/groups';

const SIZE = 256;

describe('a stone under the tracer', () => {
  let gpu: Gpu; let renderer: Renderer; let target: GPUTexture;
  const view = () => target.createView();

  beforeAll(async () => {
    gpu = await createDevice();
    renderer = new Renderer(gpu);
    await renderer.ready;
    target = gpu.device.createTexture({ size: [SIZE, SIZE], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    // a brilliant standing on its culet in the middle of the frame, with only the sky to light it
    const r = compile('part s = gem(cut: brilliant, width: 6.5) in diamond\nform f {\n  place s at (0, 0, 2.9)\n}\n');
    renderer.setSize(SIZE, SIZE);
    renderer.setKeyLight({ elevation: 1, azimuth: 0, strength: 0, warmth: 0, size: 0.1 });
    renderer.setTable('slate');
    renderer.setInstanced(groupByMesh(r.sketch!.assembly));
    renderer.frameBounds({ min: [-4, -4, 0], max: [4, 4, 4] });
    renderer.setFocus(40, 40);
  });
  afterAll(() => { renderer.dispose(); target.destroy(); gpu.device.destroy(); });

  /** The mean of the three channels over a block round a point, whatever the byte order. */
  async function block(x: number, y: number, r: number): Promise<number> {
    await gpu.queue.onSubmittedWorkDone();
    const bytesPerRow = Math.ceil((SIZE * 4) / 256) * 256;
    const buffer = gpu.device.createBuffer({ size: bytesPerRow * SIZE, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = gpu.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow }, [SIZE, SIZE, 1]);
    gpu.queue.submit([enc.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(buffer.getMappedRange());
    let sum = 0, n = 0;
    for (let j = y - r; j <= y + r; j++) for (let i = x - r; i <= x + r; i++) {
      const k = j * bytesPerRow + i * 4;
      sum += px[k] + px[k + 1] + px[k + 2]; n += 3;
    }
    buffer.unmap(); buffer.destroy();
    return sum / n;
  }

  /** Trace the still view to a count of samples with the stone's paths allowed so many bounces. */
  async function traced(gemBounces: number, samples: number): Promise<number> {
    renderer.setQuality('traced'); renderer.setMoving(false);
    // the tracer is fetched on the first traced frame: raster frames until it lands
    for (let i = 0; i < 2000 && !renderer.pathTracer?.compiled; i++) { renderer.requestRender(); renderer.render(view); await new Promise((r) => setTimeout(r, 10)); }
    const tracer = renderer.pathTracer!;
    tracer.gemBounces = gemBounces;
    tracer.reset();
    for (let i = 0; i < 20000 && renderer.traceSamples < samples; i++) { renderer.requestRender(); renderer.render(view); await new Promise((r) => setTimeout(r, 1)); }
    expect(renderer.traceSamples).toBeGreaterThanOrEqual(samples);
    return block(SIZE / 2, SIZE / 2 - 8, 28);
  }

  it('a diamond comes out brighter with its own bounce budget than with the ordinary six, and a longer one moves it less', async () => {
    const six = await traced(6, 48);
    const sixteen = await traced(16, 48);
    const twentyFour = await traced(24, 48);
    console.info(`diamond crown, mean of the block: 6 bounces ${six.toFixed(1)}, 16 ${sixteen.toFixed(1)}, 24 ${twentyFour.toFixed(1)}`);
    // the paths cut short at six were the ones carrying the light back out
    expect(sixteen).toBeGreaterThan(six * 1.05);
    // and sixteen has most of it: past there the picture settles
    expect(Math.abs(twentyFour - sixteen)).toBeLessThan((sixteen - six) * 0.5);
    renderer.setQuality('draft');
  }, 120_000);
});
