/**
 * Clear water on a real device: a surface seen through, drawn in a pass of its own after the opaque scene, which
 * reads what is under it from a copy of the opaque frame and its depth. What is under shallow water shows through it;
 * under deep water it is lost to the deep colour, the more the deeper; a group that mixes clear water with anything
 * else is refused. Pixel checks under an error scope, the frames written by VITE_FRAME_DIR.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { MeshBuilder } from '../../mesh/types';
import { bakeEnvironment } from '../../render/env';
import { DEFAULT_POST, FULL_ECONOMY, GameRenderer, PATTERN_STRIDE, type Antialias, type GameGroup } from '../renderer';
import { LightPool } from '../lights';
import { FLOW_CLEAR, FLOW_GLOW, FLOW_WATER, packFlow } from '../flow';
import { meanIn, readPixels, saveFrame, type Pixels } from './frame';
import { HALF, bed, box, one, quad, water } from './clearscene';

const W = 192, H = 192;
/** Far off and long in the lens, as the flow tests' camera, so the picture is close to a plan of the water. */
const DISTANCE = 301.5, FOV = 3;
const PX_PER_UNIT = H / (2 * DISTANCE * Math.tan((FOV / 2) * (Math.PI / 180)));
/** Where a point of the world's x and y falls in the frame, near enough for a camera this far off. */
const px = (x: number, y: number) => [Math.round(W / 2 + x * PX_PER_UNIT), Math.round(H / 2 - y * PX_PER_UNIT)] as const;
/** The mean colour of a few pixels round a point of the world. */
const around = (p: Pixels, x: number, y: number, r = 3) => {
  const [cx, cy] = px(x, y);
  return meanIn(p, cx - r, cy - r, cx + r, cy + r);
};
const gap = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('clear water on the game renderer', () => {
  let gpu: Gpu;
  let env: ReturnType<typeof bakeEnvironment>;
  let r: GameRenderer;
  let target: GPUTexture;

  beforeAll(async () => {
    gpu = await createDevice();
    env = bakeEnvironment(gpu, 'daylight', { size: 32, mips: 3 });
    await env.samples;
    target = gpu.device.createTexture({ size: [W, H], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    r = new GameRenderer(gpu, 8, 8, 256, 100);
    await r.ready;
    r.setEnvironment(env.specular, env.brdf, env.mips);
    r.resize(W, H);
    r.setLights(new LightPool(8));
    r.camera.fov = FOV; r.camera.near = 100; r.camera.far = 600;
    r.camera.target = [0, 0, 0];
    r.camera.position = [0, -30, 300];
  });

  afterAll(() => { r?.dispose(); target?.destroy(); gpu?.device.destroy(); });

  beforeEach(() => {
    r.look = { ...r.look, shading: 'pbr', antialias: undefined, background: [0.02, 0.02, 0.03], occlusion: 0, sunColour: [1, 1, 1], ambient: 1, exposure: 1, clear: { clarity: 1 } };
    r.post = { ...DEFAULT_POST, bloom: 0, vignette: 0, grain: 0, tone: 'clamp' };
    r.economy = { ...FULL_ECONOMY, shadows: true };
    r.camera.fov = FOV; r.camera.near = 100;
    r.camera.position = [0, -30, 300];
    r.time = 0;
    r.setStatic([]);
    r.setDynamic([]);
  });

  /** One frame, read back, under an error scope that fails the test on a validation error. */
  async function draw(name: string, antialias?: Antialias): Promise<Pixels> {
    r.look = { ...r.look, antialias };
    await r.prepare();
    gpu.device.pushErrorScope('validation');
    expect(r.frame(target.createView(), 'redraw', 0)).toBe(true);
    // a second frame: the four-sample builds and the clear pass's targets are in by now
    expect(r.frame(target.createView(), 'redraw', 0)).toBe(true);
    const error = await gpu.device.popErrorScope();
    expect(error?.message ?? null).toBeNull();
    const p = await readPixels(gpu, target);
    await saveFrame(`clear ${name}`, p);
    return p;
  }

  for (const antialias of [undefined, 'fxaa', 'msaa'] as const)
    it(`shows what is under shallow water and loses what is under deep water to the deep colour, ${antialias ?? 'no antialiasing'}`, async () => {
      // a clarity of 0.7 against a box four units down: blue lasts longest, half again the clarity, and is still nearly gone
      r.look = { ...r.look, clear: { clarity: 0.7, foamWidth: 0, glitter: 0, refraction: 0 } };
      r.setStatic([...bed(), water()]);
      const p = await draw(`shallow and deep ${antialias ?? 'plain'}`, antialias);
      // the box in the shallows stands out from the mud beside it, as it does with no water at all
      const shallowBox = around(p, -4.5, 2), shallowMud = around(p, -4.5, -1.5);
      expect(gap(shallowBox, shallowMud), 'the shallow box seen through the water').toBeGreaterThan(40);
      // the box in the deep is all but lost: as the deep water beside it
      const deepBox = around(p, 4.5, 2), deepMud = around(p, 4.5, -1.5);
      expect(gap(deepBox, deepMud), 'the deep box lost in the water').toBeLessThan(12);
      // and the deep water is the deep colour's own hue: bluer than it is red
      expect(deepMud[2]).toBeGreaterThan(deepMud[0] + 10);
    });

  it('goes over to the deep colour steadily, the deeper the bed', async () => {
    r.look = { ...r.look, clear: { clarity: 1, foamWidth: 0, glitter: 0, refraction: 0 } };
    r.setStatic([...bed(), water()]);
    const p = await draw('ramp');
    const deep = around(p, 6.5, -4);
    let was = Infinity;
    for (let x = -6; x <= 5; x += 1) {
      const now = gap(around(p, x, -4), deep);
      expect(now, `the bed at x = ${x}`).toBeLessThanOrEqual(was + 1.5);
      was = now;
    }
    expect(gap(around(p, -6, -4), deep), 'the shallowest is far from the deep colour').toBeGreaterThan(40);
  });

  it('has foam where the water is thin, and none where it is deep', async () => {
    const plain = { clarity: 1, glitter: 0, refraction: 0 };
    r.setStatic([...bed(), water()]);
    r.look = { ...r.look, clear: { ...plain, foamWidth: 0 } };
    const none = await draw('no foam');
    r.look = { ...r.look, clear: { ...plain, foamWidth: 2 } };
    const foam = await draw('foam');
    // in the shallows, half a unit deep, it is whiter: brighter, and nearer grey than the water is
    const bright = (c: number[]) => c[0] + c[1] + c[2];
    expect(bright(around(foam, -6.3, -3, 4)) - bright(around(none, -6.3, -3, 4)), 'the foam in the shallows').toBeGreaterThan(60);
    // where the water is deeper than the foam reaches, however its noise breaks it, not a pixel moves
    const [x0] = px(3, 0), [x1] = px(6, 0), [, y0] = px(0, 4), [, y1] = px(0, -4);
    let moved = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = (y * W + x) * 3;
        if (foam.rgb[i] !== none.rgb[i] || foam.rgb[i + 1] !== none.rgb[i + 1] || foam.rgb[i + 2] !== none.rgb[i + 2]) moved++;
      }
    expect(moved, 'pixels moved by the foam in the deep').toBe(0);
  });

  it('bends what is under the water by its waves, and nothing that stands out of it', async () => {
    // black and cyan stripes flat on a bed two units down, where a bend moves an edge and nothing else changes much;
    // and a red block held just above the water beside them
    const stripes = new Float32Array(16 * 7);
    for (let k = 0; k < 7; k++) stripes.set([0.8, 0, 0, 0, 0, 12, 0, 0, 0, 0, 0.02, 0, -4.8 + k * 1.6, 0, -2, 1], k * 16);
    const sand = quad([[-HALF, -HALF, -2.05], [HALF, -HALF, -2.05], [HALF, HALF, -2.05], [-HALF, HALF, -2.05]]);
    // all of it above the water, so any of its red in the water beside it is a bend landing out of the water
    const post: GameGroup = { mesh: box(), matrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.9, 0, 0.8, -2, 0.05, 1]), albedo: [0.9, 0.1, 0.05], roughness: 0.9 };
    r.setStatic([
      { mesh: sand, matrices: one, albedo: [0.02, 0.02, 0.02], roughness: 0.9 },
      // cyan, with no red in them, so any red in the water can only be the block's
      { mesh: box(), matrices: stripes, albedo: [0, 0.95, 0.95], roughness: 0.9 },
      post,
      water(FLOW_CLEAR, 0.4),
    ]);
    r.time = 2;
    r.look = { ...r.look, clear: { clarity: 4, foamWidth: 0, glitter: 0, refraction: 0, caustics: 0 } };
    const straight = await draw('unbent');
    r.look = { ...r.look, clear: { clarity: 4, foamWidth: 0, glitter: 0, refraction: 4, caustics: 0 } };
    const bent = await draw('bent');
    // the stripes' edges are moved about: pixels that went from black to cyan or back
    let flipped = 0;
    for (let i = 0; i < bent.rgb.length; i += 3) if (Math.abs(bent.rgb[i + 1] - straight.rgb[i + 1]) > 60) flipped++;
    expect(flipped, 'pixels of the stripes moved by the bend').toBeGreaterThan(40);
    // and the water beside the block never shows its red: it is out of the water, not under it
    const [cx, cy] = px(0.8, -2);
    const half = Math.round(1.6 * PX_PER_UNIT);
    let red = 0;
    for (let y = cy - half; y < cy + half; y++)
      for (let x = cx - half; x < cx + half; x++) {
        const i = (y * W + x) * 3;
        // turned red, which nothing under the water is: the water takes red first, so even a little is the block's
        if (bent.rgb[i] - straight.rgb[i] > 25) red++;
      }
    expect(red, 'the block\'s red bent into the water beside it').toBe(0);
  });

  it('lays the fog over the water, not under it, at four samples as at one', async () => {
    // near, in a thick fog: the bed is five units further than the water's surface, which a fog half gone in three shows
    r.camera.fov = 40; r.camera.near = 1;
    r.camera.position = [0, -9, 9];
    r.look = { ...r.look, clear: { clarity: 1, foamWidth: 0, glitter: 0, refraction: 0, caustics: 0 } };
    r.setStatic([...bed(), water()]);
    r.fog = { ...r.fog, density: Math.LN2 / 3, base: -10, height: 100, colour: [0.9, 0.9, 0.9], reach: 200, steps: 16 };
    const plain = await draw('fog plain');
    const four = await draw('fog msaa', 'msaa');
    r.fog = { ...r.fog, density: 0 };
    const none = await draw('no fog', 'msaa');
    // the fog shows on the deep water, and as much at four samples as at one
    expect(gap(around(plain, 4, 0), around(none, 4, 0)), 'the fog on the deep water').toBeGreaterThan(20);
    expect(gap(around(four, 4, 0), around(plain, 4, 0)), 'four samples against one').toBeLessThan(6);
  });

  it('glitters only by brightening the water, here and there as the waves pass', async () => {
    r.setStatic([...bed(), water(FLOW_CLEAR, 0.3)]);
    // the glitter is open water's glint, the camera's own and lifted toward the horizon, so it is seen at an angle and
    // hardly ever from straight overhead; and its waves are finer than a pixel from the long lens far off, and quieted, as
    // far water's should be: the camera is put near and at forty-five degrees, as a player's is
    r.camera.fov = 40; r.camera.near = 1;
    r.camera.position = [0, -9, 9];
    let brighter = 0, darker = 0;
    // the dashes are sparse, so a patch of water this small is looked at over several moments
    for (let t = 1; t <= 8; t++) {
      r.time = t * 0.7;
      r.look = { ...r.look, clear: { clarity: 1, foamWidth: 0, refraction: 0, glitter: 0 } };
      const none = await draw('');
      r.look = { ...r.look, clear: { clarity: 1, foamWidth: 0, refraction: 0, glitter: 1 } };
      const glitter = await draw(t === 1 ? 'glitter' : '');
      for (let i = 0; i < none.rgb.length; i += 3) {
        const d = glitter.rgb[i] + glitter.rgb[i + 1] + glitter.rgb[i + 2] - (none.rgb[i] + none.rgb[i + 1] + none.rgb[i + 2]);
        if (d > 0) brighter++;
        if (d < 0) darker++;
      }
    }
    expect(darker, 'pixels the glitter darkened').toBe(0);
    expect(brighter, 'pixels the glitter lit').toBeGreaterThan(0);
  });

  it('lights a shallow bed with caustics that move, none at nought, and none in the sun\'s shadow', async () => {
    // a flat bed of sand half a unit down, the sun from the east and high, and a slab held over the water that shades the middle of it
    const sand = quad([[-HALF, -HALF, -0.5], [HALF, -HALF, -0.5], [HALF, HALF, -0.5], [-HALF, HALF, -0.5]]);
    const slab: GameGroup = { mesh: box(), matrices: new Float32Array([2.5, 0, 0, 0, 0, 14, 0, 0, 0, 0, 0.3, 0, 4.2, 0, 3, 1]), albedo: [0.3, 0.3, 0.3], roughness: 0.9 };
    r.setStatic([{ mesh: sand, matrices: one, albedo: [0.7, 0.62, 0.42], roughness: 0.9 }, slab, water()]);
    r.look = { ...r.look, sunDir: [0.6, 0, 0.8] };
    r.setSunShadow({ min: [-8, -8, -1], max: [8, 8, 4] });
    const lum = (p: Pixels, x: number, y: number, half = 10) => {
      // how much the brightness varies over a patch: a lit pattern varies, a plain bed does not
      const [cx, cy] = px(x, y);
      const ls: number[] = [];
      for (let j = cy - half; j < cy + half; j++)
        for (let i = cx - half; i < cx + half; i++) {
          const k = (j * W + i) * 3;
          ls.push(0.2126 * p.rgb[k] + 0.7152 * p.rgb[k + 1] + 0.0722 * p.rgb[k + 2]);
        }
      const mean = ls.reduce((a, b) => a + b, 0) / ls.length;
      return Math.sqrt(ls.reduce((a, b) => a + (b - mean) ** 2, 0) / ls.length);
    };
    const flat = { clarity: 1.6, foamWidth: 0, glitter: 0, refraction: 0 };
    r.time = 1;
    r.look = { ...r.look, clear: { ...flat, caustics: 0 } };
    const none = await draw('no caustics');
    r.look = { ...r.look, clear: { ...flat, caustics: 1, causticScale: 1.5 } };
    const lit = await draw('caustics');
    r.time = 4;
    const later = await draw('caustics later');
    r.setSunShadow(null);
    // in the sun, west of the slab's shadow, a pattern where there was none
    expect(lum(none, -3.5, 0), 'the plain bed').toBeLessThan(2);
    expect(lum(lit, -3.5, 0), 'the bed in the sun, with caustics: twice what the plain bed may be').toBeGreaterThan(4);
    // and it moves with the clock
    let moved = 0;
    const [cx, cy] = px(-3.5, 0);
    for (let j = cy - 10; j < cy + 10; j++)
      for (let i = cx - 10; i < cx + 10; i++) {
        const k = (j * W + i) * 3;
        if (Math.abs(lit.rgb[k] - later.rgb[k]) > 4) moved++;
      }
    expect(moved, 'pixels the caustics moved in three seconds').toBeGreaterThan(20);
    // in the slab's shadow, half a unit east of the middle, as plain as the bed with none
    expect(lum(lit, 1.6, 0, 6), 'the bed in shadow').toBeLessThan(lum(none, 1.6, 0, 6) + 1.5);
  });

  it('draws a particle above the water over it, and one under it as the water tints it', async () => {
    r.look = { ...r.look, clear: { clarity: 1, foamWidth: 0, glitter: 0, refraction: 0, caustics: 0 } };
    const blob = (z: number, x: number) => ({ position: [x, -3, z] as [number, number, number], velocity: [0, 0, 0] as [number, number, number], spread: 0, count: 1, life: 0.2, size: 0.8, colour: [1, 0.15, 0.1] as [number, number, number], alpha: 1, gravity: 0 });
    const shoot = async (groups: GameGroup[], name: string, antialias?: Antialias) => {
      r.setStatic(groups);
      r.look = { ...r.look, antialias };
      await r.prepare();
      r.emit(blob(1, -3));
      r.emit(blob(-3, 3));
      gpu.device.pushErrorScope('validation');
      for (let f = 0; f < 3; f++) r.frame(target.createView(), 'redraw', 1 / 60);
      expect((await gpu.device.popErrorScope())?.message ?? null).toBeNull();
      const p = await readPixels(gpu, target);
      await saveFrame(`clear particles ${name}`, p);
      return p;
    };
    for (const antialias of [undefined, 'msaa'] as const) {
      const bare = await shoot(bed(), `bare ${antialias ?? 'plain'}`, antialias);
      const wet = await shoot([...bed(), water()], `wet ${antialias ?? 'plain'}`, antialias);
      // above the water, the red particle is as red over the water as over the bare bed: drawn on top of it
      const above = around(wet, -3, -3, 2), aboveBare = around(bare, -3, -3, 2);
      expect(above[0], 'the particle above the water, red').toBeGreaterThan(above[2] + 80);
      expect(Math.abs(above[0] - aboveBare[0]), 'as red as over the bare bed').toBeLessThan(20);
      // under three units of water, it is lost toward the deep colour: far less red than it is in the air
      const under = around(wet, 3, -3, 2), underBare = around(bare, 3, -3, 2);
      expect(underBare[0], 'the particle under where the water will be, red').toBeGreaterThan(underBare[2] + 80);
      expect(under[0], 'tinted by the water over it').toBeLessThan(underBare[0] - 60);
    }
    // the particles' lives run out, so no test after this one sees them
    for (let f = 0; f < 30; f++) r.frame(target.createView(), 'redraw', 1 / 60);
  });

  it('draws in every frame mode, antialiasing and rung, a rung stepped down and back giving the same frame', async () => {
    r.look = { ...r.look, clear: { clarity: 1, foamWidth: 0.4, glitter: 1, refraction: 0.5, caustics: 1 } };
    r.fog = { ...r.fog, density: Math.LN2 / 40, height: 100, colour: [0.3, 0.4, 0.5] };
    r.setStatic([...bed(), water(FLOW_CLEAR, 0.3)]);
    r.setSunShadow({ min: [-8, -8, -7], max: [8, 8, 2] });
    r.time = 2;
    const rungs = ['shadows', 'points', 'particles', 'post', 'fog', 'occlusion', 'effects', 'cullLights'] as const;
    for (const antialias of [undefined, 'fxaa', 'msaa'] as const)
      for (const mode of ['redraw', 'keep'] as const) {
        r.look = { ...r.look, antialias };
        await r.prepare();
        const frame = async () => {
          gpu.device.pushErrorScope('validation');
          for (let f = 0; f < 3; f++) expect(r.frame(target.createView(), mode, 0)).toBe(true);
          expect((await gpu.device.popErrorScope())?.message ?? null, `${antialias ?? 'plain'} ${mode}`).toBeNull();
          return readPixels(gpu, target);
        };
        const full = await frame();
        // the deep box is lost in the water, whatever the mode: the water is drawn
        expect(gap(around(full, 4.5, 2), around(full, 4.5, -1.5)), `${antialias ?? 'plain'} ${mode}: the water drawn`).toBeLessThan(20);
        for (const rung of rungs) {
          r.economy = { ...FULL_ECONOMY, shadows: true, [rung]: rung === 'effects' ? 0 : false };
          await frame();
          r.economy = { ...FULL_ECONOMY, shadows: true };
          const back = await frame();
          let moved = 0;
          for (let i = 0; i < back.rgb.length; i++) if (back.rgb[i] !== full.rgb[i]) moved++;
          expect(moved, `${antialias ?? 'plain'} ${mode}: ${rung} stepped down and back`).toBe(0);
        }
      }
    r.fog = { ...r.fog, density: 0 };
    r.setSunShadow(null);
  });

  it('draws at a pixel, at an odd size and resized as it runs, and is put away whole', async () => {
    r.setStatic([...bed(), water()]);
    for (const [w, h] of [[1, 1], [37, 23], [W, H]]) {
      r.resize(w, h);
      const t = gpu.device.createTexture({ size: [w, h], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      await r.prepare();
      gpu.device.pushErrorScope('validation');
      expect(r.frame(t.createView(), 'redraw', 0)).toBe(true);
      expect((await gpu.device.popErrorScope())?.message ?? null, `${w} by ${h}`).toBeNull();
      t.destroy();
    }
    // a renderer of its own, handed clear water, drawn, and disposed of, with no error
    const other = new GameRenderer(gpu, 8, 8, 256, 100);
    await other.ready;
    other.setEnvironment(env.specular, env.brdf, env.mips);
    other.resize(W, H);
    other.setStatic([...bed(), water()]);
    await other.prepare();
    gpu.device.pushErrorScope('validation');
    other.frame(target.createView(), 'redraw', 0);
    other.dispose();
    expect((await gpu.device.popErrorScope())?.message ?? null).toBeNull();
  });

  it('is the mud and the boxes as they are, where there is no clear water', async () => {
    r.setStatic(bed());
    const bare = await draw('bare');
    // the deep box shows as plainly as the shallow one with nothing over it
    expect(gap(around(bare, 4.5, 2), around(bare, 4.5, -1.5))).toBeGreaterThan(40);
  });

  it('refuses a group that has clear water and anything else in it', () => {
    const mixed = water();
    const two = new Float32Array(PATTERN_STRIDE * 2);
    two.set(mixed.patterns!.subarray(0, PATTERN_STRIDE), 0);
    two.set(packFlow(new Float32Array(PATTERN_STRIDE), 0, { kind: FLOW_WATER, scale: 1, speed: 1, second: [1, 1, 1] }), PATTERN_STRIDE);
    const matrices = new Float32Array(32);
    matrices.set(one, 0);
    matrices.set(one, 16);
    expect(() => r.setStatic([{ ...mixed, matrices, patterns: two }])).toThrow(/all clear water/);
  });
});

/**
 * A sheet for choosing by: a pond's bank, bed and stones seen at an angle in the toon daylight look, through clear
 * water, plain and with everything on. Only when frames are being written; it asserts nothing but that it drew.
 */
describe.skipIf(!import.meta.env.VITE_FRAME_DIR)('a sheet of clear water', () => {
  it('draws the pond, plain and with its foam, bend and glitter', async () => {
    const gpu = await createDevice();
    const env = bakeEnvironment(gpu, 'daylight', { size: 128, mips: 6 });
    await env.samples;
    const SW = 640, SH = 400;
    const tex = gpu.device.createTexture({ size: [SW, SH], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const r = new GameRenderer(gpu, 8, 8, 256, 100);
    await r.ready;
    r.setEnvironment(env.specular, env.brdf, env.mips);
    r.resize(SW, SH);
    r.setLights(new LightPool(8));
    r.look = {
      ...r.look, shading: 'toon', sunDir: [0.45, -0.5, 0.74], sunColour: [2.6, 2.45, 2.2], ambient: 1, exposure: 0.92,
      background: [0.62, 0.84, 0.98], sky: { zenith: [0.16, 0.45, 0.92], horizon: [0.62, 0.84, 0.98], height: 0.25 },
      antialias: 'msaa', bandSoftness: 0.06, shadeColour: [0.36, 0.55, 0.66], rim: 0.2, skyLight: [0.55, 0.7, 0.92], groundLight: [0.4, 0.45, 0.2], form: 4,
    };
    r.post = { ...DEFAULT_POST, vignette: 0, grain: 0, tone: 'soft' };
    r.economy = { ...FULL_ECONOMY, shadows: true };
    r.setSunShadow({ min: [-30, -30, -8], max: [30, 30, 8] });
    // a bowl of a pond: sand under the shallows going to mud in the deep, a grass bank round it, and stones on the bed
    const b = new MeshBuilder();
    const n = 64, R = 30;
    const heightAt = (x: number, y: number) => {
      const k = Math.hypot(x / 1.3, y) / 14;
      return k < 1 ? -5 * (1 - k * k) : Math.min(1.5, (k - 1) * 3);
    };
    for (let j = 0; j <= n; j++)
      for (let i = 0; i <= n; i++) {
        const x = -R + (2 * R * i) / n, y = -R + (2 * R * j) / n, e = 0.05;
        const dx = (heightAt(x + e, y) - heightAt(x - e, y)) / (2 * e), dy = (heightAt(x, y + e) - heightAt(x, y - e)) / (2 * e);
        const l = Math.hypot(dx, dy, 1);
        b.vertex(x, y, heightAt(x, y), -dx / l, -dy / l, 1 / l, 0, 0);
      }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = j * (n + 1) + i; b.quad(a, a + 1, a + n + 2, a + n + 1); }
    const ground = b.build();
    const stones = new Float32Array(16 * 24);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let i = 0; i < 24; i++) {
      const a = rnd() * Math.PI * 2, d = rnd() * 13, x = Math.cos(a) * d * 1.3, y = Math.sin(a) * d, s = 0.6 + rnd() * 1.4;
      stones.set([s * 1.3, 0, 0, 0, 0, s, 0, 0, 0, 0, s * (0.6 + rnd()), 0, x, y, heightAt(x, y) - 0.2, 1], i * 16);
    }
    const lake = water();
    const surface: GameGroup = { ...lake, mesh: quad([[-22, -18, 0], [22, -18, 0], [22, 18, 0], [-22, 18, 0]]), albedo: [0.45, 0.85, 0.8], patterns: packFlow(new Float32Array(PATTERN_STRIDE), 0, { kind: FLOW_CLEAR, scale: 0.35, speed: 0.55, glow: 0.12, second: [0.02, 0.2, 0.32] }) };
    r.setStatic([
      { mesh: ground, matrices: one, albedo: [0.5, 0.42, 0.26], roughness: 0.9 },
      { mesh: box(), matrices: stones, albedo: [0.55, 0.58, 0.6], roughness: 0.8 },
      surface,
    ]);
    r.camera.fov = 40; r.camera.near = 1; r.camera.far = 400;
    r.camera.target = [0, 2, -1];
    r.camera.position = [0, -30, 26];
    r.time = 3;
    const shots: [string, Partial<NonNullable<typeof r.look.clear>>, number, [number, number, number]][] = [
      ['plain', { clarity: 1.6, refraction: 0, foamWidth: 0, glitter: 0, caustics: 0 }, 3, [0, -30, 26]],
      ['all', { clarity: 1.6, foamWidth: 0.3, refraction: 1, glitter: 1 }, 3, [0, -30, 26]],
      ['all a second on', { clarity: 1.6, foamWidth: 0.3, refraction: 1, glitter: 1 }, 4, [0, -30, 26]],
      ['all near', { clarity: 1.6, foamWidth: 0.3, refraction: 1, glitter: 1 }, 3, [-6, -14, 9]],
      ['no caustics near', { clarity: 1.6, foamWidth: 0.3, refraction: 1, glitter: 1, caustics: 0 }, 3, [-6, -14, 9]],
    ];
    for (const [name, clear, time, position] of shots) {
      r.look = { ...r.look, clear };
      r.time = time;
      r.camera.position = position;
      await r.prepare();
      for (let f = 0; f < 3; f++) r.frame(tex.createView(), 'redraw', 0);
      await saveFrame(`sheet ${name}`, await readPixels(gpu, tex));
    }
    r.dispose();
    tex.destroy();
  });
});

describe('a glow on the game renderer', () => {
  it('lights a thing by its own light where no other reaches it, and is seen under clear water tinted by it', async () => {
    const gpu = await createDevice();
    const env = bakeEnvironment(gpu, 'daylight', { size: 32, mips: 3 });
    await env.samples;
    const tex = gpu.device.createTexture({ size: [W, H], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const r = new GameRenderer(gpu, 8, 8, 256, 100);
    await r.ready;
    r.setEnvironment(env.specular, env.brdf, env.mips);
    r.resize(W, H);
    r.setLights(new LightPool(8));
    r.camera.fov = FOV; r.camera.near = 100; r.camera.far = 600;
    r.camera.target = [0, 0, 0];
    r.camera.position = [0, -30, 300];
    // a dark scene: no sun and hardly any light from all round, so what glows is what is seen
    r.look = { ...r.look, background: [0, 0, 0], occlusion: 0, sunColour: [0, 0, 0], ambient: 0.02, exposure: 1, clear: { clarity: 1, foamWidth: 0, glitter: 0, refraction: 0, caustics: 0 } };
    r.post = { ...DEFAULT_POST, bloom: 0, vignette: 0, grain: 0, tone: 'clamp' };
    r.economy = { ...FULL_ECONOMY, shadows: true };
    const fish = (glow: number, z: number): GameGroup => ({
      mesh: box(), matrices: new Float32Array([3, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 0, 0, z, 1]), albedo: [0.2, 0.2, 0.2], roughness: 0.9,
      patterns: packFlow(new Float32Array(PATTERN_STRIDE), 0, { kind: FLOW_GLOW, scale: 0, speed: 0, glow, second: [0.4, 1, 0.2] }),
    });
    const shot = async (groups: GameGroup[], name: string) => {
      r.setStatic(groups);
      await r.prepare();
      gpu.device.pushErrorScope('validation');
      r.frame(tex.createView(), 'redraw', 0);
      r.frame(tex.createView(), 'redraw', 0);
      expect((await gpu.device.popErrorScope())?.message ?? null).toBeNull();
      const p = await readPixels(gpu, tex);
      await saveFrame(`glow ${name}`, p);
      return around(p, 0, 0);
    };
    // a slab a unit tall, its top a unit under where the water will be
    const dark = await shot([fish(0, -2)], 'none');
    const lit = await shot([fish(0.5, -2)], 'half');
    // its own light, the second colour times the glow: green the most, red and blue less, as the second colour has them
    expect(lit[1] - dark[1], 'green, lit by its own glow').toBeGreaterThan(100);
    expect(lit[1]).toBeGreaterThan(lit[0]);
    expect(lit[1]).toBeGreaterThan(lit[2]);
    // under clear water a unit deep it is still seen, dimmer and bluer for the water over it
    const under = await shot([fish(0.5, -2), water()], 'under water');
    expect(under[1], 'seen through the water').toBeGreaterThan(dark[1] + 30);
    expect(under[1], 'dimmed by the water over it').toBeLessThan(lit[1]);
    expect(under[2] - under[1], 'tinted by the deep colour').toBeGreaterThan(lit[2] - lit[1]);
    r.dispose();
    tex.destroy();
    gpu.device.destroy();
  });
});
