/**
 * The piece's own lights cast shadows whose softness follows the light's
 * size and the blocker's distance: a fin standing high under a diode
 * throws a broad faint penumbra on the plate below, a fin nearly touching
 * the plate a tight dark one. Measured on the raster alone, as the width
 * of the shadow's edge down a column through it.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { Renderer } from '../renderer';
import { compile } from '../../dsl/index';
import { groupByMesh } from '../../assembly/groups';

const SIZE = 384;

describe('shadows from the piece\'s own lights', () => {
  let gpu: Gpu; let renderer: Renderer; let target: GPUTexture;
  const view = () => target.createView();

  beforeAll(async () => {
    gpu = await createDevice();
    renderer = new Renderer(gpu);
    await renderer.ready;
    target = gpu.device.createTexture({ size: [SIZE, SIZE], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
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

  /** A diode over an ivory plate, a fin standing under it at a height; the plate's red down the column through the fin's shadow. */
  async function shadowColumn(finHeight: number): Promise<number[]> {
    const r = compile(`material blackened steel brushed
part plate = plate(card(width: 30, height: 30, corner: 2), thickness: 1.5, enamel: ivory)
part lamp  = bead(radius: 2, point: 0) in amber diode glow 6
part fin   = plate(card(width: 8, height: 2.5, corner: 0.2), thickness: 0.5)
form f {
  place plate
  place lamp at (4, 17, 12)
  place fin at (0, 15, ${finHeight}) roll 90deg
}
`);
    if (r.error) throw new Error(r.error.message);
    renderer.setSize(SIZE, SIZE);
    renderer.setEnvironment('dusk');
    renderer.setKeyLight({ elevation: 1, azimuth: 0, strength: 0, warmth: 0, size: 0.1 });
    renderer.setTable('matte');
    renderer.setInstanced(groupByMesh(r.sketch!.assembly));
    renderer.frameBounds({ min: [-15, 0, 0], max: [15, 30, 2] });
    renderer.camera.position = [0, -22, 44]; renderer.camera.update();
    renderer.setFocus(50, 50);
    await renderer.setEnvironment('dusk').samples;
    renderer.setQuality('final'); renderer.setMoving(false);
    // draw until the renderer has nothing more to do: the draft bake, the
    // full one 350 ms on, its chunks, and the probe after the last of them.
    // `pending` covers a bake between chunks, so this is the renderer's own
    // word and not a guess at how long it takes on a busy GPU
    const deadline = performance.now() + 20_000;
    do { renderer.render(view); await new Promise((res) => setTimeout(res, 10)); } while (renderer.pending && performance.now() < deadline);
    expect(renderer.pending).toBe(false);
    renderer.requestRender(); renderer.render(view);
    const px = await pixels();
    const out: number[] = [];
    for (let y = 100; y < 260; y++) { let v = 0; for (let x = 150; x < 158; x++) v += px[(y * SIZE + x) * 4 + 2]; out.push(v / 8); }
    return out;
  }

  /** The part of the column below the fin itself: the fin is the run of near-black rows, and its shadow lies past it. */
  function belowFin(column: number[]): number[] {
    let last = -1;
    column.forEach((v, i) => { if (v < 30) last = i; });
    return column.slice(last + 4);
  }
  /** Rows the shadow's two edges spend between a quarter and three quarters of the way from lit to darkest: their width together. */
  function edgeWidth(column: number[]): number {
    const lit = Math.max(...column), dark = Math.min(...column);
    const lo = dark + 0.25 * (lit - dark), hi = dark + 0.75 * (lit - dark);
    return column.filter((v) => v > lo && v < hi).length;
  }

  it('a fin high above the plate throws a broader, fainter shadow than one nearly on it', async () => {
    const high = belowFin(await shadowColumn(5));
    const low = belowFin(await shadowColumn(1.75));
    const wHigh = edgeWidth(high), wLow = edgeWidth(low);
    // both throw a shadow at all: the fin is wide enough for a full umbra at either height
    expect(Math.max(...high) - Math.min(...high)).toBeGreaterThan(25);
    expect(Math.max(...low) - Math.min(...low)).toBeGreaterThan(25);
    // the high fin's edges are the wider; a fixed filter gave the two the same edge
    expect(wHigh).toBeGreaterThan(wLow + 4);
  });
});
