/**
 * The game path's frame, timed on this machine's GPU and held to the
 * baseline kept for it in `perf-baseline.json`, both ways, by `perf.ts`.
 *
 * Skipped unless VITE_PERF is set, so `npm run test:gpu` stays pixel checks
 * and no slower: `npm run perf:gpu` runs it, and `npm run perf:gpu:update`
 * writes this adapter's figures as its baseline. An adapter never measured
 * passes, and says it has nothing to be held to.
 *
 * The time is throughput: thirty frames submitted, the queue waited on, and
 * the wall time shared among them; the median of seven such runs after ten
 * to warm up. It includes the submission and not the display, which is the
 * part of a frame the renderer owns. Two runs of the same tree on an M4 Pro
 * agreed within 1–6%.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server } from '@vitest/browser/context';
import { createDevice, type Gpu } from '../../gpu/context';
import { MeshBuilder, type Mesh } from '../../mesh/types';
import { bakeEnvironment } from '../../render/env';
import { FULL_ECONOMY, GameRenderer, type GameGroup } from '../renderer';
import { noFog } from '../fog';
import { LightPool } from '../lights';
import { judge, median, recorded } from './perf';

const W = 1280, H = 800;
const BASELINE = 'src/game/__tests__/perf-baseline.json';
const UPDATE = !!import.meta.env.VITE_PERF_UPDATE;

/** A flat square of `size`, facing up. */
function plane(size: number): Mesh {
  const b = new MeshBuilder();
  const s = size / 2;
  b.vertex(-s, -s, 0, 0, 0, 1, 0, 0);
  b.vertex(s, -s, 0, 0, 0, 1, 1, 0);
  b.vertex(s, s, 0, 0, 0, 1, 1, 1);
  b.vertex(-s, s, 0, 0, 0, 1, 0, 1);
  b.quad(0, 1, 2, 3);
  return b.build();
}

/** A unit box standing on its base, each face its own four corners. */
function box(): Mesh {
  const b = new MeshBuilder();
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, -1, 0], [0, 0, 1]],
    [[0, 1, 0], [-1, 0, 0], [0, 0, 1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [n, u, v] of faces) {
    const base = b.vertexCount;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = [0, 1, 2].map((k) => (n[k] + su * u[k] + sv * v[k]) / 2 + (k === 2 ? 0.5 : 0));
      b.vertex(p[0], p[1], p[2], n[0], n[1], n[2], 0, 0);
    }
    b.quad(base, base + 1, base + 2, base + 3);
  }
  return b.build();
}

/**
 * The standard scene: a ground eighty units across with a grid of four
 * hundred boxes on it, in ooergolf's look (toon, a straight tone, daylight,
 * a sun shadow, occlusion and a thin haze) and from its home view. It holds
 * the game path as a whole, for every game on it, and is what a feature's
 * own scene is measured over.
 */
export function standardScene(): GameGroup[] {
  const boxes = new Float32Array(400 * 16);
  for (let i = 0; i < 400; i++) {
    const x = (i % 20) * 4 - 38, y = Math.floor(i / 20) * 4 - 38;
    boxes.set([1.2, 0, 0, 0, 0, 1.2, 0, 0, 0, 0, 1.6, 0, x, y, 0, 1], i * 16);
  }
  return [
    { mesh: plane(600), matrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), albedo: [0.1, 0.42, 0.08], roughness: 0.85 },
    { mesh: box(), matrices: boxes, albedo: [0.58, 0.3, 0.13], roughness: 0.55 },
  ];
}

describe.skipIf(!import.meta.env.VITE_PERF)('the game path, timed', () => {
  let gpu: Gpu;
  let r: GameRenderer;
  let target: GPUTexture;

  beforeAll(async () => {
    gpu = await createDevice();
    r = new GameRenderer(gpu, 32, 32, 1024, 100);
    await r.ready;
    target = gpu.device.createTexture({ size: [W, H], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const env = bakeEnvironment(gpu, 'daylight', { size: 128, mips: 6 });
    await env.samples;
    r.setEnvironment(env.specular, env.brdf, env.mips);
    r.resize(W, H);
    r.setLights(new LightPool(8));
    r.look = {
      ...r.look, shading: 'toon', sunDir: [0.35, -0.3, 0.89], sunColour: [2.5, 2.45, 2.35], ambient: 1,
      background: [0.45, 0.72, 0.98], occlusion: 2, occlusionRadius: 2.5, occlusionDirect: 0.3,
    };
    r.fog = { ...noFog(100), density: Math.LN2 / 900, base: -10, height: 1000, colour: [0.2, 0.3, 0.42], ambient: 0.4, anisotropy: 0, reach: 600, steps: 16, cones: 0 };
    r.post = { ...r.post, vignette: 0, tone: 'clamp' };
    r.economy = { ...FULL_ECONOMY, shadows: true };
    r.setSunShadow({ min: [-50, -50, -4], max: [50, 50, 12] });
    // ooergolf's home view: a lens of 40 degrees, 0.78 radians from straight down, 62 units back
    r.camera.fov = 40; r.camera.near = 2; r.camera.far = 800;
    r.camera.target = [0, 0, 0];
    r.camera.position = [0, -Math.sin(0.78) * 62, Math.cos(0.78) * 62];
    r.setStatic(standardScene());
    r.setDynamic([]);
  }, 60_000);

  afterAll(() => { r?.dispose(); target?.destroy(); gpu?.device.destroy(); });

  /** One scene's frame, in milliseconds: the median of seven runs of thirty, after ten to warm up. */
  async function time(): Promise<number> {
    const view = target.createView();
    for (let i = 0; i < 10; i++) r.frame(view);
    await gpu.queue.onSubmittedWorkDone();
    const runs: number[] = [];
    for (let k = 0; k < 7; k++) {
      const t0 = performance.now();
      for (let i = 0; i < 30; i++) r.frame(view);
      await gpu.queue.onSubmittedWorkDone();
      runs.push((performance.now() - t0) / 30);
    }
    return median(runs);
  }

  it('holds each scene to its baseline on this adapter', async () => {
    const measured: Record<string, number> = {};
    measured.standard = await time();

    const file = await server.commands.readFile(BASELINE).catch(() => '');
    const key = gpu.adapter.key;
    const verdicts = judge(measured, recorded(file, key));
    for (const v of verdicts) console.log(`${key} ${v.scene}: ${v.why}`);
    if (UPDATE) {
      const all = file.trim() ? (JSON.parse(file) as Record<string, Record<string, number>>) : {};
      all[key] = Object.fromEntries(Object.entries(measured).map(([s, ms]) => [s, Math.round(ms * 1000) / 1000]));
      await server.commands.writeFile(BASELINE, JSON.stringify(all, null, 2) + '\n');
      return;
    }
    expect(verdicts.filter((v) => !v.ok).map((v) => `${v.scene}: ${v.why}`)).toEqual([]);
  }, 180_000);
});
