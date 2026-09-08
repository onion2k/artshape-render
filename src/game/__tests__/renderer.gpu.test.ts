/**
 * The game renderer, on a real device.
 *
 * These are pixel checks rather than timings, and deliberately so: six
 * separate faults in the spike that produced these decisions had no symptom
 * except a plausible number, and every one of them was caught by rendering
 * it and asking whether the image changed. So does this.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { bakeEnvironment } from '../../render/env';
import { compile } from '../../dsl/index';
import { groupByMesh } from '../../assembly/groups';
import { GameRenderer, type GameGroup } from '../renderer';
import { LightPool } from '../lights';

const SIZE = 256;

/** An arena and something to move over it, from the shared geometry half. */
function build(source: string): GameGroup[] {
  const { sketch, error } = compile(source);
  if (error) throw new Error(error.formatted);
  return groupByMesh(sketch!.assembly).map((g) => ({ mesh: g.mesh, matrices: g.matrices }));
}

const ARENA = `material silver satin
part floor = plate(card(width: 400, height: 400, corner: 10), thickness: 6)
form arena { place floor }
`;
const DRONES = `material gold polished
part drone = bead(radius: 14, point: 6)
form drones { repeat drone around ring(12, radius: 120) }
`;

describe('the game renderer', () => {
  let gpu: Gpu;
  let renderer: GameRenderer;
  let target: GPUTexture;
  const view = () => target.createView();

  beforeAll(async () => {
    gpu = await createDevice();
    renderer = new GameRenderer(gpu, 64, 32);
    await renderer.ready;
    target = gpu.device.createTexture({
      size: [SIZE, SIZE], format: gpu.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const env = bakeEnvironment(gpu, 'studio', { size: 128, mips: 5 });
    await env.samples;
    renderer.setEnvironment(env.specular, env.brdf, env.mips);
    renderer.resize(SIZE, SIZE);
    renderer.setStatic(build(ARENA));
    renderer.setDynamic(build(DRONES));
    renderer.camera.position = [0, -320, 300];
    renderer.camera.target = [0, 0, 0];
  });

  afterAll(() => { renderer?.dispose(); target?.destroy(); gpu?.device.destroy(); });

  /** Mean brightness over the frame, and how many distinct colours are in it. */
  async function read(): Promise<{ mean: number; colours: number }> {
    await gpu.queue.onSubmittedWorkDone();
    const bytesPerRow = Math.ceil((SIZE * 4) / 256) * 256;
    const buffer = gpu.device.createBuffer({ size: bytesPerRow * SIZE, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = gpu.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow, rowsPerImage: SIZE }, [SIZE, SIZE, 1]);
    gpu.queue.submit([enc.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(buffer.getMappedRange().slice(0));
    buffer.unmap(); buffer.destroy();
    let sum = 0; let n = 0;
    const seen = new Set<number>();
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const o = y * bytesPerRow + x * 4;
        sum += px[o] + px[o + 1] + px[o + 2];
        n++;
        seen.add((px[o] << 16) | (px[o + 1] << 8) | px[o + 2]);
      }
    }
    return { mean: sum / n / 3, colours: seen.size };
  }

  it('draws the arena and the movers, lit and shaded', async () => {
    expect(renderer.frame(view())).toBe(true);
    const f = await read();
    expect(f.mean).toBeGreaterThan(8);
    expect(f.colours).toBeGreaterThan(50);
  });

  it('draws nothing before its pipelines exist', async () => {
    const fresh = new GameRenderer(gpu, 4, 4);
    expect(fresh.frame(view())).toBe(false);
    await fresh.ready;
    // still nothing: it has no environment, so its bind group is unmade
    expect(fresh.frame(view())).toBe(false);
    fresh.dispose();
  });

  it('lights the scene more the more lights it is given', async () => {
    const pool = new LightPool(64);
    renderer.setLights(pool);
    renderer.frame(view());
    const dark = await read();

    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      pool.add({ position: [Math.cos(a) * 120, Math.sin(a) * 120, 60], radius: 200, colour: [1, 0.8, 0.5], intensity: 8 });
    }
    renderer.setLights(pool);
    renderer.frame(view());
    const lit = await read();
    expect(lit.mean).toBeGreaterThan(dark.mean + 1);
  });

  it('gives the same picture with the radius cull as without it', async () => {
    // The cull fades a light to nothing at its radius before skipping it, so
    // it is exact. If that ever stops being true this is what says so.
    const pool = new LightPool(64);
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      pool.add({ position: [Math.cos(a) * 150, Math.sin(a) * 150, 50], radius: 130, colour: [0.9, 0.9, 1], intensity: 10 });
    }
    renderer.setLights(pool);

    renderer.economy = { ...renderer.economy, cullLights: true };
    renderer.frame(view());
    const culled = await read();
    renderer.economy = { ...renderer.economy, cullLights: false };
    renderer.frame(view());
    const naive = await read();
    renderer.economy = { ...renderer.economy, cullLights: true };

    expect(culled.mean).toBeCloseTo(naive.mean, 1);
  });

  it('gives up the point lights when the ladder asks, and takes them back', async () => {
    const pool = new LightPool(64);
    for (let i = 0; i < 16; i++) {
      pool.add({ position: [0, 0, 80], radius: 400, colour: [1, 1, 1], intensity: 12 });
    }
    renderer.setLights(pool);
    renderer.frame(view());
    const withPoints = await read();

    renderer.economy = { ...renderer.economy, points: false };
    renderer.frame(view());
    const without = await read();
    renderer.economy = { ...renderer.economy, points: true };
    renderer.frame(view());
    const again = await read();

    expect(without.mean).toBeLessThan(withPoints.mean - 1);
    expect(again.mean).toBeCloseTo(withPoints.mean, 1);
  });

  it('keeps the static half and draws the same frame as redrawing it', async () => {
    const pool = new LightPool(64);
    renderer.setLights(pool);
    renderer.frame(view(), 'redraw');
    const redrawn = await read();
    renderer.frame(view(), 'keep');
    const kept = await read();
    // the kept path copies a frame drawn by the same shader, so it must agree
    expect(kept.mean).toBeCloseTo(redrawn.mean, 1);
  });

  it('moves a group without rebuilding it, and draws fewer when told', async () => {
    const groups = build(DRONES);
    renderer.setDynamic(groups);
    renderer.frame(view());
    const all = await read();

    // the same pool, half of it live
    const half = Math.floor(groups[0].matrices.length / 16 / 2);
    renderer.move(0, groups[0].matrices, half);
    renderer.frame(view());
    const fewer = await read();
    expect(fewer.mean).toBeLessThan(all.mean);

    renderer.move(0, groups[0].matrices, groups[0].matrices.length / 16);
    renderer.frame(view());
    const back = await read();
    expect(back.mean).toBeCloseTo(all.mean, 1);
  });

  it('colours each placement from its own material, not one for the scene', async () => {
    // The look carries a fallback; a group that names a colour overrides it,
    // and `tint` overrides that per placement without moving anything. A demo
    // wanting a gold player among silver enemies found this missing.
    const groups = build(DRONES);
    const capacity = groups[0].matrices.length / 16;
    renderer.setLights(new LightPool(4));
    renderer.setEffects(new Float32Array(4), 0);

    renderer.setDynamic([{ ...groups[0], albedo: [0.02, 0.02, 0.02], roughness: 0.9 }]);
    renderer.frame(view());
    const dull = await read();

    renderer.setDynamic([{ ...groups[0], albedo: [1, 0.78, 0.34], roughness: 0.15 }]);
    renderer.frame(view());
    const gold = await read();
    expect(gold.mean).toBeGreaterThan(dull.mean + 1);

    // half the pool dulled again, in place: the picture must land between them
    const mixed = new Float32Array(capacity * 4);
    for (let i = 0; i < capacity; i++) {
      mixed.set(i < capacity / 2 ? [0.02, 0.02, 0.02, 0.9] : [1, 0.78, 0.34, 0.15], i * 4);
    }
    renderer.tint(0, mixed);
    renderer.frame(view());
    const half = await read();
    expect(half.mean).toBeLessThan(gold.mean);
    expect(half.mean).toBeGreaterThan(dull.mean);
  });

  it('brightens with each effect layer, and dims as the ladder takes them away', async () => {
    renderer.setDynamic(build(DRONES));
    renderer.setEffects(new Float32Array([0, 0, 0.9, 1]), 0);
    renderer.frame(view());
    const none = await read();

    const quads = new Float32Array(8 * 4);
    for (let i = 0; i < 8; i++) { quads.set([0, 0, 0.9, 0.5], i * 4); }
    renderer.setEffects(quads, 8);
    renderer.frame(view());
    const eight = await read();
    expect(eight.mean).toBeGreaterThan(none.mean + 1);

    renderer.economy = { ...renderer.economy, effects: 0 };
    renderer.frame(view());
    const off = await read();
    renderer.economy = { ...renderer.economy, effects: 1 };
    expect(off.mean).toBeCloseTo(none.mean, 1);
  });
});
