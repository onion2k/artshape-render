/**
 * A group that opts out of the shadow maps and the occlusion prepass, on a real device. A game's far woodland is
 * hundreds of trees that cast no shadow the camera could see and darken no corner it could see, and each is drawn
 * three times (the sun's map, the occlusion's depth, the colour) unless it says otherwise. Here a flat square held
 * over flat ground under a high sun stands for the tree: with `shadow: false` the ground under it is as lit as the
 * open floor, with `occlusion: false` the ground beside it is not darkened, both still draw it in colour, and
 * saying both true is the default to the last byte. The shaded and the lit values are measured in the same scene,
 * so the check is against the floor's own two values and not a number written here. VITE_FRAME_DIR writes the frames.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { MeshBuilder, type Mesh } from '../../mesh/types';
import { bakeEnvironment } from '../../render/env';
import { DEFAULT_POST, FULL_ECONOMY, GameRenderer, type FrameMode, type GameGroup } from '../renderer';
import { LightPool } from '../lights';
import { meanIn, readPixels, saveFrame, type Pixels } from './frame';

const W = 192, H = 192;
const SIDE = 8;
const GREEN: [number, number, number] = [0.3, 0.5, 0.2];
const GROUND: [number, number, number] = [0.7, 0.7, 0.7];

function square(): Mesh {
  const b = new MeshBuilder();
  const s = SIDE / 2;
  b.vertex(-s, -s, 0, 0, 0, 1, 0, 0);
  b.vertex(s, -s, 0, 0, 0, 1, 1, 0);
  b.vertex(s, s, 0, 0, 0, 1, 1, 1);
  b.vertex(-s, s, 0, 0, 0, 1, 0, 1);
  b.quad(0, 1, 2, 3);
  return b.build();
}

function floor(): Mesh {
  const b = new MeshBuilder();
  b.vertex(-50, -50, 0, 0, 0, 1, 0, 0);
  b.vertex(50, -50, 0, 0, 0, 1, 1, 0);
  b.vertex(50, 50, 0, 0, 0, 1, 1, 1);
  b.vertex(-50, 50, 0, 0, 0, 1, 0, 1);
  b.quad(0, 1, 2, 3);
  return b.build();
}

const at = (x: number, y: number, z: number) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);

describe('a group that opts out of the shadow and the occlusion passes', () => {
  let gpu: Gpu;
  let env: ReturnType<typeof bakeEnvironment>;
  let r: GameRenderer;
  let target: GPUTexture;

  beforeAll(async () => {
    gpu = await createDevice();
    env = bakeEnvironment(gpu, 'daylight', { size: 32, mips: 3 });
    await env.samples;
    target = gpu.device.createTexture({ size: [W, H], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    r = new GameRenderer(gpu, 16, 8, 256, 1);
    await r.ready;
    r.setEnvironment(env.specular, env.brdf, env.mips);
    r.resize(W, H);
    r.post = { ...DEFAULT_POST, bloom: 0, vignette: 0, grain: 0, tone: 'clamp' };
    r.camera.fov = 6; r.camera.near = 100; r.camera.far = 600;
    r.camera.target = [0, 0, 0];
    r.camera.position = [0, -5, 300];
  });

  afterAll(() => { r?.dispose(); target?.destroy(); gpu?.device.destroy(); });

  beforeEach(() => {
    r.look = { ...r.look, shading: 'pbr', antialias: undefined, background: [0.02, 0.02, 0.03], occlusion: 0, sunColour: [0, 0, 0], ambient: 0.2, exposure: 1, falloffHalf: 600 };
    r.economy = { ...FULL_ECONOMY, shadows: true };
    r.setLights(new LightPool(16));
    r.setSunShadow(null);
    r.setStatic([]);
    r.setDynamic([]);
  });

  function pixelOf(p: [number, number, number]): [number, number] {
    r.camera.update();
    const m = r.camera.viewProjection;
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    return [Math.round((x / w * 0.5 + 0.5) * W), Math.round((0.5 - y / w * 0.5) * H)];
  }

  function value(p: Pixels, point: [number, number, number], size = 3): number {
    const [x, y] = pixelOf(point);
    const [a, b, c] = meanIn(p, x - size, y - size, x + size + 1, y + size + 1);
    return (a + b + c) / 3;
  }

  async function draw(name = '', mode: FrameMode = 'redraw'): Promise<Pixels> {
    gpu.device.pushErrorScope('validation');
    const drew = r.frame(target.createView(), mode, 0);
    const error = await gpu.device.popErrorScope();
    expect(error?.message ?? null).toBeNull();
    expect(drew).toBe(true);
    const px = await readPixels(gpu, target);
    if (name) await saveFrame(`passoptout ${name}`, px);
    return px;
  }

  const ground = (): GameGroup => ({ mesh: floor(), matrices: at(0, 0, 0), albedo: GROUND, roughness: 0.9 });
  const held = (z: number, flags: Pick<GameGroup, 'shadow' | 'occlusion'> = {}): GameGroup => ({ mesh: square(), matrices: at(0, 0, z), albedo: GREEN, roughness: 0.9, ...flags });

  async function drawn(groups: GameGroup[], name = '', mode: FrameMode = 'redraw'): Promise<Pixels> {
    r.setStatic(groups);
    await r.prepare();
    return draw(name, mode);
  }

  describe('the shadow', () => {
    // The sun is up and a little to +x: a flat square held at Z throws its shadow Z * 0.4 / 0.9165 to -x.
    const Z = 20;
    const SHADOW: [number, number, number] = [-(Z * 0.4) / 0.9165, 0, 0];
    const OPEN: [number, number, number] = [12, 9, 0];
    const lit = () => {
      r.look = { ...r.look, sunDir: [0.4, 0, 0.9165], sunColour: [3, 3, 3] };
      r.setSunShadow({ min: [-60, -60, -10], max: [60, 60, 60] });
    };

    it('is cast by default, and not by a group that says shadow: false (the ground under it is as lit as the open floor)', async () => {
      lit();
      const cast = await drawn([ground(), held(Z)], 'shadow default');
      const none = await drawn([ground(), held(Z, { shadow: false })], 'shadow off');
      const open = value(cast, OPEN);
      expect(open - value(cast, SHADOW), 'the default group\'s shadow is darker than the open floor').toBeGreaterThan(25);
      expect(Math.abs(value(none, SHADOW) - open), 'the opted-out group\'s is not there').toBeLessThan(open * 0.04 + 1);
    });

    it('is cast by a spot too, unless the group says shadow: false', async () => {
      const LAMP: [number, number, number] = [50, 0, 120];
      const scale = LAMP[2] / (LAMP[2] - Z);
      const middle: [number, number, number] = [LAMP[0] + (0 - LAMP[0]) * scale, 0, 0];
      const pool = new LightPool(16);
      pool.add({ position: LAMP, radius: 900, colour: [1, 1, 1], intensity: 12, direction: [middle[0] - LAMP[0], 0, -LAMP[2]], cone: [16, 24] });
      r.setLights(pool, [0]);
      r.look = { ...r.look, spotSoftness: 0 };
      const cast = await drawn([ground(), held(Z)], 'spot default');
      const none = await drawn([ground(), held(Z, { shadow: false })], 'spot off');
      const open = value(cast, [6, -9, 0]);
      expect(open - value(cast, middle), 'the default group\'s spot shadow is there').toBeGreaterThan(25);
      expect(Math.abs(value(none, middle) - open), 'the opted-out group casts none from the spot').toBeLessThan(open * 0.04 + 1);
    });

    it('still draws the group in colour, kept or redrawn', async () => {
      lit();
      const bare = await drawn([ground()]);
      const on = await drawn([ground(), held(Z, { shadow: false })], '', 'redraw');
      const kept = await drawn([ground(), held(Z, { shadow: false })], '', 'keep');
      expect(Math.abs(value(on, [0, 0, Z]) - value(bare, [0, 0, 0])), 'the square is seen over the ground').toBeGreaterThan(20);
      expect(value(kept, [0, 0, Z])).toBeCloseTo(value(on, [0, 0, Z]), 0);
    });
  });

  describe('the contact occlusion', () => {
    const Z = 1;
    const FAR: [number, number, number] = [-20, 14, 0];
    // read by a block of one pixel, so that the square's own edge is not in it
    const edge: [number, number, number][] = [[SIDE / 2 + 0.8, 0, 0], [-SIDE / 2 - 0.8, 0, 0], [0, SIDE / 2 + 0.8, 0], [0, -SIDE / 2 - 0.8, 0]];
    const occluded = () => { r.look = { ...r.look, ambient: 0.8, occlusion: 3, occlusionRadius: 2.5, occlusionDirect: 0 }; };

    it('darkens the ground beside a group by default, and not beside one that says occlusion: false', async () => {
      occluded();
      const without = await drawn([ground()], 'occlusion none');
      const dark = await drawn([ground(), held(Z)], 'occlusion default');
      const free = await drawn([ground(), held(Z, { occlusion: false })], 'occlusion off');
      expect(Math.abs(value(without, edge[0], 1) - value(without, FAR, 1)), 'the open ground is level').toBeLessThan(value(without, FAR) * 0.08 + 1);
      expect(Math.min(...edge.map((c) => value(without, c, 1) - value(dark, c, 1))), 'the default group darkens the ground beside it').toBeGreaterThan(5);
      for (const c of edge) expect(Math.abs(value(free, c, 1) - value(without, c, 1)), `the ground at (${c[0]}, ${c[1]}) is as with no group`).toBeLessThan(1);
    });

    it('still draws the group in colour', async () => {
      occluded();
      const bare = await drawn([ground()]);
      const free = await drawn([ground(), held(Z, { occlusion: false, shadow: false })]);
      expect(Math.abs(value(free, [0, 0, Z]) - value(bare, [0, 0, 0]))).toBeGreaterThan(20);
    });
  });

  it('draws the same with both flags said true as with neither said, to the byte', async () => {
    r.look = { ...r.look, sunDir: [0.4, 0, 0.9165], sunColour: [3, 3, 3], ambient: 0.8, occlusion: 3, occlusionRadius: 2.5, occlusionDirect: 0 };
    r.setSunShadow({ min: [-60, -60, -10], max: [60, 60, 60] });
    const plain = await drawn([ground(), held(10), { ...held(1), matrices: at(20, 10, 1) }]);
    const said = await drawn([ground(), held(10, { shadow: true, occlusion: true }), { ...held(1, { shadow: true, occlusion: true }), matrices: at(20, 10, 1) }]);
    expect(said.rgb.length).toBe(plain.rgb.length);
    expect(said.rgb.every((v, k) => v === plain.rgb[k]), 'every byte of the frame').toBe(true);
  });
});
