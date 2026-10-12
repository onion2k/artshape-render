/**
 * A game that asks for none of the painted edge draws the pixels it drew at v0.37.0: the standard scene of `perf.ts`,
 * the golf scene and the toy ball, each in a toon look and a physically based one, at one sample a pixel and four,
 * redrawn and kept, twenty-four frames in all. The painted edge adds an attribute, a uniform and a build to the
 * renderer, and each of those has to cost a game that never hands in a painted mesh nothing but the bytes it was.
 *
 * A hash of each frame's pixels was written from the code at bd26e65 (v0.37.0), before any of the change, into
 * `painted-golden.json` under the adapter's key, and is checked here after every later part. A hash is a fact about
 * one GPU's rounding, so an adapter with none skips and says so; `VITE_GOLDEN=1` writes this adapter's, which is only
 * to be done on the old code.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server } from '@vitest/browser/context';
import { createDevice, type Gpu } from '../../gpu/context';
import { MeshBuilder, type Mesh } from '../../mesh/types';
import { bakeEnvironment } from '../../render/env';
import { DEFAULT_POST, FULL_ECONOMY, GameRenderer, type GameGroup, type Look } from '../renderer';
import { LightPool } from '../lights';
import { NO_FOG, noFog } from '../fog';
import { readPixels, saveFrame } from './frame';
import { GROUND, fnv, golfLook } from './golfscene';
import { standardScene } from './scenes';

const SIZE = 160;
const GOLDEN = 'src/game/__tests__/painted-golden.json';
const WRITE_GOLDEN = !!import.meta.env.VITE_GOLDEN;

/** The toy test's ball, a smooth sphere of 48 rings and 64 segments with its normals true. */
function ballMesh(): Mesh {
  const b = new MeshBuilder();
  const rings = 48, segments = 64;
  for (let i = 0; i <= rings; i++) {
    const phi = (i / rings) * Math.PI;
    for (let j = 0; j <= segments; j++) {
      const th = (j / segments) * Math.PI * 2;
      const x = Math.sin(phi) * Math.cos(th), y = Math.sin(phi) * Math.sin(th), z = Math.cos(phi);
      b.vertex(x, y, z, x, y, z, j / segments, i / rings);
    }
  }
  const row = segments + 1;
  for (let i = 0; i < rings; i++) for (let j = 0; j < segments; j++) b.quad(i * row + j, (i + 1) * row + j, (i + 1) * row + j + 1, i * row + j + 1);
  return b.build();
}

function floorMesh(size: number): Mesh {
  const b = new MeshBuilder();
  const s = size / 2;
  b.vertex(-s, -s, 0, 0, 0, 1, 0, 0);
  b.vertex(s, -s, 0, 0, 0, 1, 1, 0);
  b.vertex(s, s, 0, 0, 0, 1, 1, 1);
  b.vertex(-s, s, 0, 0, 0, 1, 0, 1);
  b.quad(0, 1, 2, 3);
  return b.build();
}

const scaled = (s: number, z: number) => new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, z, 1]);
const GREY: [number, number, number] = [0.6, 0.6, 0.6];

const SCENES = ['standard', 'golf', 'ball'] as const;
type Scene = (typeof SCENES)[number];

describe('a game that asks for none of the painted edge', () => {
  let gpu: Gpu;
  let env: ReturnType<typeof bakeEnvironment>;
  let target: GPUTexture;

  beforeAll(async () => {
    gpu = await createDevice();
    env = bakeEnvironment(gpu, 'daylight', { size: 32, mips: 3 });
    await env.samples;
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC;
    target = gpu.device.createTexture({ size: [SIZE, SIZE], format: gpu.format, usage });
  }, 60_000);
  afterAll(() => { target?.destroy(); gpu?.device.destroy(); });

  /** One frame of a scene: its look and camera as the scene's own game would set them, then three frames drawn. */
  async function frame(scene: Scene, shading: 'toon' | 'pbr', samples: 1 | 4, kept: boolean) {
    const r = new GameRenderer(gpu, 8, 8, 4096, 100);
    await r.ready;
    r.setEnvironment(env.specular, env.brdf, env.mips);
    r.resize(SIZE, SIZE);
    r.setLights(new LightPool(8));
    let groups: GameGroup[];
    if (scene === 'standard') {
      groups = standardScene();
      r.look = {
        ...r.look, shading: 'toon', sunDir: [0.35, -0.3, 0.89], sunColour: [2.5, 2.45, 2.35], ambient: 1,
        background: [0.45, 0.72, 0.98], occlusion: 2, occlusionRadius: 2.5, occlusionDirect: 0.3,
      };
      r.fog = { ...noFog(100), density: Math.LN2 / 900, base: -10, height: 1000, colour: [0.2, 0.3, 0.42], ambient: 0.4, anisotropy: 0, reach: 600, steps: 16, cones: 0 };
      r.post = { ...r.post, vignette: 0, tone: 'clamp' };
      r.economy = { ...FULL_ECONOMY, shadows: true };
      r.setSunShadow({ min: [-50, -50, -4], max: [50, 50, 12] });
      r.camera.fov = 40; r.camera.near = 2; r.camera.far = 800;
      r.camera.target = [0, 0, 0];
      r.camera.position = [0, -Math.sin(0.78) * 62, Math.cos(0.78) * 62];
    } else if (scene === 'golf') {
      groups = GROUND;
      golfLook(r);
      r.fog = { ...NO_FOG, density: Math.LN2 / 3000, base: -10, height: 1000, colour: [0.2, 0.3, 0.42], ambient: 0.4, anisotropy: 0, reach: 600, steps: 16, cones: 0 };
      r.setSunShadow({ min: [-16, 26, -4], max: [14, 72, 24] });
      r.camera.position = [10, -25, 17];
      r.camera.target = [-4, 55, 0];
      r.camera.near = 0.5;
      r.camera.far = 800;
    } else {
      groups = [
        { mesh: ballMesh(), matrices: scaled(40, 0), albedo: GREY, roughness: 0.3 },
        { mesh: floorMesh(600), matrices: scaled(1, -40), albedo: GREY, roughness: 0.9 },
      ];
      r.look = { ...r.look, background: [0, 0, 0], sunDir: [0.4, -0.5, 0.75], sunColour: [2, 2, 2] };
      r.post = { ...DEFAULT_POST, bloom: 0, vignette: 0, grain: 0, tone: 'soft' };
      r.economy = { ...FULL_ECONOMY, shadows: true };
      r.setSunShadow({ min: [-60, -60, -45], max: [60, 60, 45] });
      r.camera.fov = 32; r.camera.near = 0.5; r.camera.far = 4000;
      r.camera.position = [0, -160, 60];
      r.camera.target = [0, 0, -10];
    }
    const look: Look = { ...r.look, shading };
    r.look = samples === 4 ? { ...look, antialias: 'msaa' } : look;
    r.setStatic(groups);
    r.setDynamic([]);
    r.time = 1.5;
    await r.prepare();
    const view = target.createView();
    for (let i = 0; i < 3; i++) r.frame(view, kept ? 'keep' : 'redraw', 1 / 60);
    const p = await readPixels(gpu, target);
    r.dispose();
    return p;
  }

  it('draws the same pixels as the code at v0.37.0 did, on an adapter with a record of them', async (ctx) => {
    const key = gpu.adapter.key;
    const found: Record<string, string> = {};
    for (const scene of SCENES)
      for (const shading of ['toon', 'pbr'] as const)
        for (const samples of [1, 4] as const)
          for (const kept of [false, true]) {
            const name = `${scene} ${shading} ${samples} ${kept ? 'kept' : 'redrawn'}`;
            const p = await frame(scene, shading, samples, kept);
            await saveFrame(`painted-unasked ${name}`, p);
            found[name] = fnv(p);
          }
    const file = await server.commands.readFile(GOLDEN).catch(() => '');
    const all = file.trim() ? (JSON.parse(file) as Record<string, Record<string, string>>) : {};
    if (WRITE_GOLDEN) {
      all[key] = found;
      await server.commands.writeFile(GOLDEN, JSON.stringify(all, null, 2) + '\n');
      return;
    }
    if (!all[key]) { console.warn(`painted-unasked: no pixels of v0.37.0 are kept for ${key}, so nothing was held to them`); return ctx.skip(); }
    expect(found).toEqual(all[key]);
  }, 120_000);
});
