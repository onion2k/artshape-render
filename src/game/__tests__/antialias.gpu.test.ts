/**
 * Antialiasing on a real device. A black square turned on a grey ground,
 * lit by nothing, so that a frame without antialiasing has exactly two
 * colours in it and an edge is a stair: four samples a pixel, and FXAA,
 * each put colours between the two along the edge and change nothing off
 * it. Then everything else that draws into the scene, drawn with four
 * samples: grass, particles and sprites, effect layers, the kept static
 * half, the fog that reads the depth, and the occlusion beside it; the
 * ladder stepping down and back; a resize to a pixel and to an odd size;
 * and no pipeline made for any of it until a look asks. Pixel checks, under
 * an error scope, since a pass that is wrongly put together draws nothing
 * and says so only to the console. VITE_FRAME_DIR writes the frames.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { MeshBuilder, type Mesh } from '../../mesh/types';
import { bakeEnvironment } from '../../render/env';
import { DEFAULT_POST, EFFECT_STRIDE, FULL_ECONOMY, GameRenderer, type Antialias, type FrameMode, type GameEconomy, type GameGroup } from '../renderer';
import { LightPool } from '../lights';
import { noFog } from '../fog';
import { SPRITE_STRIDE } from '../particles';
import type { GrassField, GrassKind } from '../grass';
import { differing, meanIn, readPixels, saveFrame, type Pixels } from './frame';

const W = 192, H = 144;
/** The pipelines a renderer makes before `ready`, as v0.19.0's did: a game asking for no antialiasing makes no more. */
const PIPELINES_AT_0_19 = 46;
const GREY: [number, number, number] = [0.5, 0.5, 0.5];

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

function ball(): Mesh {
  const b = new MeshBuilder();
  const rings = 16, segments = 24;
  for (let i = 0; i <= rings; i++) {
    const phi = (i / rings) * Math.PI;
    for (let j = 0; j <= segments; j++) {
      const th = (j / segments) * Math.PI * 2;
      const x = Math.sin(phi) * Math.cos(th), y = Math.sin(phi) * Math.sin(th), z = Math.cos(phi);
      b.vertex(x, y, z, x, y, z, 0, 0);
    }
  }
  const row = segments + 1;
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < segments; j++) b.quad(i * row + j, (i + 1) * row + j, (i + 1) * row + j + 1, i * row + j + 1);
  return b.build();
}

/** A square turned about the up axis by `turn` radians, and lifted a little off the ground. */
function turned(turn: number, size: number, x = 0, y = 0, z = 0.01): Float32Array {
  const c = Math.cos(turn) * size, s = Math.sin(turn) * size;
  return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, size, 0, x, y, z, 1]);
}

const GREEN: GrassKind = { density: 60, height: 0.6, width: 0.08, base: [0.05, 0.3, 0.04], tip: [0.25, 0.7, 0.15], lean: 0.2, give: 0.3 };
function field(): GrassField {
  const cols = 24, rows = 24;
  return { origin: [6, -6], cell: 0.25, cols, rows, mask: new Uint8Array(cols * rows).fill(1), heights: new Float32Array(cols * rows), kinds: [GREEN], seed: 7 };
}

describe('antialiasing on the game renderer', () => {
  let gpu: Gpu;
  let env: ReturnType<typeof bakeEnvironment>;
  let r: GameRenderer;
  let target: GPUTexture;
  const ground: GameGroup = { mesh: plane(1), matrices: new Float32Array([400, 0, 0, 0, 0, 400, 0, 0, 0, 0, 1, 0, 0, 0, -0.5, 1]), albedo: [1, 1, 1], roughness: 1 };
  const square: GameGroup = { mesh: plane(1), matrices: turned(0.5, 10), albedo: [0, 0, 0], roughness: 1 };

  /** A renderer over the square, the ground lit by nothing and the sky grey, so an unsmoothed frame has two colours. */
  async function make(): Promise<GameRenderer> {
    const renderer = new GameRenderer(gpu, 8, 8, 1024, 100);
    await renderer.ready;
    renderer.setEnvironment(env.specular, env.brdf, env.mips);
    renderer.resize(W, H);
    renderer.setLights(new LightPool(8));
    renderer.look = { ...renderer.look, sunColour: [0, 0, 0], ambient: 0, background: GREY, occlusion: 0 };
    renderer.post = { ...DEFAULT_POST, bloom: 0, vignette: 0, grain: 0, tone: 'clamp' };
    renderer.economy = { ...FULL_ECONOMY, shadows: true };
    renderer.camera.fov = 40; renderer.camera.near = 1; renderer.camera.far = 400;
    renderer.camera.target = [0, 0, 0];
    renderer.camera.position = [0, -24, 30];
    // the ground far below the square, out of the camera's way: what is not the square is the sky
    renderer.setStatic([square]);
    renderer.setDynamic([]);
    return renderer;
  }

  beforeAll(async () => {
    gpu = await createDevice();
    env = bakeEnvironment(gpu, 'daylight', { size: 32, mips: 3 });
    await env.samples;
    target = gpu.device.createTexture({ size: [W, H], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    r = await make();
  });

  afterAll(() => { r?.dispose(); target?.destroy(); gpu?.device.destroy(); });

  beforeEach(() => {
    r.look = { ...r.look, antialias: undefined, sunColour: [0, 0, 0], ambient: 0, occlusion: 0 };
    r.economy = { ...FULL_ECONOMY, shadows: true };
    r.fog = noFog(100);
    r.setStatic([square]);
    r.setDynamic([]);
    r.setEffects(new Float32Array(EFFECT_STRIDE), 0);
    r.setSprites(new Float32Array(SPRITE_STRIDE), 0);
  });

  /** One frame, read back, under an error scope that fails the test on a validation error. */
  async function draw(name = '', mode: FrameMode = 'redraw', renderer = r, dt = 1 / 60): Promise<Pixels> {
    gpu.device.pushErrorScope('validation');
    const drew = renderer.frame(target.createView(), mode, dt);
    const error = await gpu.device.popErrorScope();
    expect(error?.message ?? null).toBeNull();
    expect(drew).toBe(true);
    const px = await readPixels(gpu, target);
    if (name) await saveFrame(`antialias ${name}`, px);
    return px;
  }

  /** How many distinct values of red the frame has, and how many pixels are strictly between the two a stair has. */
  function between(px: Pixels, lo: number, hi: number): number {
    let n = 0;
    for (let i = 0; i < px.rgb.length; i += 3) if (px.rgb[i] > lo + 4 && px.rgb[i] < hi - 4) n++;
    return n;
  }

  /**
   * Pixels on the stair: those with a neighbour of another colour, by more
   * than `step` levels, in a frame drawn without antialiasing, and those
   * within `reach` of them. A step above nothing leaves out the smooth
   * gradients of a lit scene, which would otherwise mark every pixel.
   */
  function edges(px: Pixels, reach = 1, step = 0): Uint8Array {
    const on = new Uint8Array(px.width * px.height);
    for (let y = 0; y < px.height; y++)
      for (let x = 0; x < px.width; x++) {
        const v = px.rgb[(y * px.width + x) * 3];
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < px.width && yy < px.height && Math.abs(px.rgb[(yy * px.width + xx) * 3] - v) > step) on[y * px.width + x] = 1;
          }
      }
    const grown = new Uint8Array(on);
    for (let y = 0; y < px.height; y++)
      for (let x = 0; x < px.width; x++)
        if (on[y * px.width + x])
          for (let dy = -reach; dy <= reach; dy++)
            for (let dx = -reach; dx <= reach; dx++) {
              const xx = x + dx, yy = y + dy;
              if (xx >= 0 && yy >= 0 && xx < px.width && yy < px.height) grown[yy * px.width + xx] = 1;
            }
    return grown;
  }

  /** How many pixels differ between two frames off the stair `mask` marks. */
  function differOff(a: Pixels, b: Pixels, mask: Uint8Array): number {
    let n = 0;
    for (let i = 0, p = 0; i < a.rgb.length; i += 3, p++)
      if (!mask[p] && (a.rgb[i] !== b.rgb[i] || a.rgb[i + 1] !== b.rgb[i + 1] || a.rgb[i + 2] !== b.rgb[i + 2])) n++;
    return n;
  }

  async function withAntialias(antialias: Antialias, name = '', mode: FrameMode = 'redraw'): Promise<Pixels> {
    r.look = { ...r.look, antialias };
    await r.prepare();
    return draw(name, mode);
  }

  it('makes no pipeline for antialiasing until a look asks, and makes them when one does', async () => {
    const device = gpu.device as unknown as Record<string, (...a: unknown[]) => unknown>;
    let made = 0;
    const originals: Record<string, (...a: unknown[]) => unknown> = {};
    for (const m of ['createRenderPipelineAsync', 'createComputePipelineAsync', 'createRenderPipeline', 'createComputePipeline']) {
      originals[m] = device[m];
      device[m] = function (this: unknown, ...a: unknown[]) { made++; return originals[m].apply(this, a); };
    }
    try {
      const fresh = await make();
      expect(made, 'pipelines made before ready').toBe(PIPELINES_AT_0_19);
      await draw('', 'redraw', fresh);
      await fresh.prepare();
      fresh.look = { ...fresh.look, antialias: 'none' };
      await fresh.prepare();
      await draw('', 'redraw', fresh);
      expect(made, 'pipelines made by a look asking for none').toBe(PIPELINES_AT_0_19);
      fresh.look = { ...fresh.look, antialias: 'fxaa' };
      await fresh.prepare();
      expect(made, 'pipelines made once FXAA is asked for').toBe(PIPELINES_AT_0_19 + 1);
      fresh.look = { ...fresh.look, antialias: 'msaa' };
      await fresh.prepare();
      // the scene's 32 builds, the effect layers, the fog's march, the particles and the sprites
      expect(made, 'pipelines made once four samples are asked for').toBe(PIPELINES_AT_0_19 + 1 + 32 + 1 + 1 + 2);
      fresh.dispose();
    } finally {
      for (const m of Object.keys(originals)) device[m] = originals[m];
    }
  });

  it('draws a look that says none, and a rung that allows all, as a look that says nothing', async () => {
    const nothing = await draw();
    const none = await withAntialias('none');
    expect(differing(nothing, none)).toBe(0);
    r.look = { ...r.look, antialias: undefined };
    r.economy = { ...FULL_ECONOMY, shadows: true, antialias: 'msaa' };
    expect(differing(nothing, await draw())).toBe(0);
  });

  it('has only the two colours along the square without antialiasing, and colours between them with four samples', async () => {
    const hard = await draw('none');
    const soft = await withAntialias('msaa', 'msaa');
    const [lo, hi] = [0, hard.rgb[0]];
    expect(hi, 'the sky, grey and shown straight').toBeGreaterThan(150);
    expect(between(hard, lo, hi), 'pixels between black and grey without antialiasing').toBe(0);
    // the square's four edges run some 150 pixels, and a turned edge crosses a pixel partly all along it
    expect(between(soft, lo, hi), 'pixels between black and grey with four samples').toBeGreaterThan(100);
    // and nothing changes off the stair: the inside of the square and the sky are as they were
    expect(differOff(hard, soft, edges(hard, 0))).toBe(0);
  });

  it('puts colours between the two along the square with FXAA, and changes nothing off it', async () => {
    const hard = await draw();
    const soft = await withAntialias('fxaa', 'fxaa');
    expect(between(soft, 0, hard.rgb[0])).toBeGreaterThan(100);
    expect(differOff(hard, soft, edges(hard, 0))).toBe(0);
  });

  it('draws a kept static half with four samples as it draws it afresh', async () => {
    r.look = { ...r.look, sunColour: [2, 2, 2], ambient: 1 };
    r.setStatic([square, ground]);
    r.setDynamic([{ mesh: ball(), matrices: new Float32Array([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 3, 3, 2, 1]), albedo: [0.9, 0.2, 0.1], roughness: 0.5 }]);
    const fresh = await withAntialias('msaa', 'msaa redraw');
    await draw('', 'keep');
    const kept = await draw('msaa keep', 'keep');
    expect(differing(fresh, kept)).toBe(0);
    // and the kept frame moves with a mover: a kept half must not freeze what moves
    r.move(0, new Float32Array([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, -3, 3, 2, 1]));
    const moved = await draw('', 'keep');
    r.move(0, new Float32Array([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 3, 3, 2, 1]));
    expect(differing(kept, moved)).toBeGreaterThan(100);
  });

  it('draws grass, particles, sprites and effect layers into four samples as into one', async () => {
    await r.setGrass(field());
    const quads = new Float32Array(EFFECT_STRIDE);
    quads.set([-0.6, 0.5, 0.12, 3, 1, 0.6, 0.2, 2]);
    r.setEffects(quads, 1);
    const sprites = new Float32Array(SPRITE_STRIDE);
    sprites.set([-6, -4, 2, 1.5, 0.2, 0.4, 1, 1]);
    r.setSprites(sprites, 1);
    r.look = { ...r.look, sunColour: [2, 2, 2], ambient: 1 };
    const one = await withAntialias('none', 'things one sample');
    const four = await withAntialias('msaa', 'things four samples');
    // each is there, where it is without them
    const around = (px: Pixels, x0: number, y0: number, x1: number, y1: number) => meanIn(px, x0, y0, x1, y1);
    const grass = [one, four].map((px) => around(px, 136, 76, 176, 100));
    for (const g of grass) expect(g[1], 'the grass is green').toBeGreaterThan(g[0] * 1.2);
    expect(Math.abs(grass[1][1] - grass[0][1]), 'as green with four samples').toBeLessThan(12);
    const quad = [one, four].map((px) => around(px, 30, 25, 45, 40));
    expect(quad[1][0], 'the effect layer').toBeGreaterThan(200);
    expect(Math.abs(quad[1][0] - quad[0][0])).toBeLessThan(6);
    await r.setGrass(null);
    const bare = await draw();
    expect(differing(four, bare), 'the grass, the layer and the sprite drew into the frame').toBeGreaterThan(500);
  });

  it('marches the fog over the multisampled depth as over the plain one', async () => {
    r.look = { ...r.look, sunColour: [2, 2, 2], ambient: 1 };
    r.setStatic([square, ground]);
    // thin, so the square shows through it: a thick one is the fog's colour everywhere, and says nothing
    r.fog = { ...noFog(100), density: 0.006, base: -10, height: 1000, colour: [0.3, 0.3, 0.36], ambient: 0.5, anisotropy: 0, reach: 200, steps: 16, cones: 0 };
    r.economy = { ...FULL_ECONOMY, shadows: true, fog: false };
    const clear = await withAntialias('msaa');
    r.economy = { ...FULL_ECONOMY, shadows: true };
    const four = await draw('fog four samples');
    const one = await withAntialias('none', 'fog one sample');
    expect(differing(clear, four), 'the fog is there with four samples').toBeGreaterThan(W * H * 0.5);
    // the same fog either way, off the square's edge: its march is at half the frame, and dithered, so within a level or two
    const mask = edges(one, 2);
    let worst = 0;
    for (let i = 0, p = 0; i < one.rgb.length; i += 3, p++) if (!mask[p]) worst = Math.max(worst, Math.abs(one.rgb[i] - four.rgb[i]));
    expect(worst).toBeLessThanOrEqual(2);
  });

  it('shades with the occlusion under four samples as under one', async () => {
    r.look = { ...r.look, sunColour: [2, 2, 2], ambient: 1, occlusion: 2, occlusionRadius: 3 };
    r.setStatic([square, ground, { mesh: ball(), matrices: new Float32Array([3, 0, 0, 0, 0, 3, 0, 0, 0, 0, 3, 0, 0, 0, 2.5, 1]), albedo: [0.8, 0.8, 0.8], roughness: 0.5 }]);
    const one = await withAntialias('none');
    const four = await withAntialias('msaa', 'occlusion four samples');
    r.look = { ...r.look, occlusion: 0 };
    const none = await draw();
    expect(differing(four, none), 'the occlusion shades with four samples').toBeGreaterThan(200);
    const mask = edges(one, 1);
    expect(differOff(one, four, mask)).toBeLessThan(W * H * 0.01);
  });

  it('steps down the ladder to FXAA and to none, and back up to the same frame', async () => {
    const top = await withAntialias('msaa');
    r.economy = { ...FULL_ECONOMY, shadows: true, antialias: 'fxaa' };
    const cheaper = await draw();
    r.economy = { ...FULL_ECONOMY, shadows: true, antialias: 'none' };
    const off = await draw();
    r.economy = { ...FULL_ECONOMY, shadows: true };
    const back = await draw();
    expect(differing(top, back)).toBe(0);
    // each rung is the look it names
    expect(differing(cheaper, await withAntialias('fxaa'))).toBe(0);
    r.look = { ...r.look, antialias: 'none' };
    expect(differing(off, await draw())).toBe(0);
    expect(differing(top, cheaper)).toBeGreaterThan(0);
  });

  it('draws every rung of the ladder with four samples as with one, off the edges, and back up to the same frame', async () => {
    r.look = { ...r.look, sunColour: [2, 2, 2], ambient: 1, occlusion: 2, occlusionRadius: 3 };
    // a grey square, so the ball's shadow on it shows: on black it would be black on black, and a rung's wrong build unseen
    r.setStatic([{ ...square, albedo: [0.5, 0.5, 0.5] }, ground]);
    r.setDynamic([{ mesh: ball(), matrices: new Float32Array([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 3, 3, 2, 1]), albedo: [0.9, 0.2, 0.1], roughness: 0.5 }]);
    r.setSunShadow({ min: [-30, -30, -1], max: [30, 30, 10] });
    r.fog = { ...noFog(100), density: 0.006, base: -10, height: 1000, colour: [0.3, 0.3, 0.36], ambient: 0.5, anisotropy: 0, reach: 200, steps: 16, cones: 0 };
    r.look = { ...r.look, antialias: 'msaa' };
    await r.prepare();
    // the time held still, since the fog's march is dithered by it and moves every frame it moves
    const top = await draw('every rung at the top', 'redraw', r, 0);
    const rungs: Partial<GameEconomy>[] = [
      {}, { shadows: false }, { points: false }, { cullLights: false }, { post: false },
      { fog: false }, { occlusion: false }, { effects: 0 }, { particles: false },
    ];
    for (const rung of rungs) {
      r.economy = { ...FULL_ECONOMY, shadows: true, ...rung, antialias: 'none' };
      const one = await draw('', 'redraw', r, 0);
      r.economy = { ...FULL_ECONOMY, shadows: true, ...rung };
      const four = await draw('', 'redraw', r, 0);
      // off an edge, the same shading either way: only the fog, which reads each pixel's first sample, may move a level or two
      const mask = edges(one, 1, 6);
      let worst = 0;
      for (let i = 0, p = 0; i < one.rgb.length; i++, p = Math.floor(i / 3)) if (!mask[p]) worst = Math.max(worst, Math.abs(one.rgb[i] - four.rgb[i]));
      expect(worst, JSON.stringify(rung)).toBeLessThanOrEqual(2);
    }
    r.economy = { ...FULL_ECONOMY, shadows: true };
    expect(differing(top, await draw('', 'redraw', r, 0))).toBe(0);
    r.setSunShadow(null);
  });

  it('draws with four samples at a pixel, at an odd size, and resized back', async () => {
    await withAntialias('msaa');
    for (const [w, h] of [[1, 1], [37, 23], [W, H]]) {
      r.resize(w, h);
      const t = gpu.device.createTexture({ size: [w, h], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      gpu.device.pushErrorScope('validation');
      expect(r.frame(t.createView(), 'redraw')).toBe(true);
      expect(r.frame(t.createView(), 'keep')).toBe(true);
      expect((await gpu.device.popErrorScope())?.message ?? null).toBeNull();
      t.destroy();
    }
    r.look = { ...r.look, antialias: 'fxaa' };
    r.resize(33, 17);
    r.resize(W, H);
    await draw();
  });

  it('draws without antialiasing until its builds are in, and with it after', async () => {
    const fresh = await make();
    const plain = await draw('', 'redraw', fresh);
    fresh.look = { ...fresh.look, antialias: 'msaa' };
    // asked for, not waited on: the frame is drawn as it can be, and never not drawn
    const asked = await draw('', 'redraw', fresh);
    expect(differing(plain, asked) === 0 || between(asked, 0, plain.rgb[0]) > 100).toBe(true);
    await fresh.prepare();
    const after = await draw('', 'redraw', fresh);
    expect(between(after, 0, plain.rgb[0])).toBeGreaterThan(100);
    fresh.dispose();
  });
});
