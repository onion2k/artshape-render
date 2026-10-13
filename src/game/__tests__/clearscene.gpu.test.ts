/**
 * Clear water mirroring the scene itself (`ClearWater.mirrorScene`), on a real device: the opaque groups drawn once more
 * before the scene pass with the view turned over in the water's plane, clipped at it, into a half-size HDR texture of
 * their own, which the clear pass reads in place of the sky where something was drawn. A white post stands in the pond
 * and is mirrored in the pixels beneath it, offset by the swells' normal and tinted as the sky is, with a soft edge
 * where it meets the sky; the bed under the water is clipped away and mirrors nothing; and a water that does not ask
 * runs no pass and makes no texture (its pixels are held by `cleargolden.gpu.test.ts`). Frames are written by
 * VITE_FRAME_DIR.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { bakeEnvironment } from '../../render/env';
import { DEFAULT_POST, FULL_ECONOMY, GameRenderer, PATTERN_STRIDE, type GameGroup } from '../renderer';
import { LightPool } from '../lights';
import { gerstnerAt, heightAt, type GerstnerWave } from '../waves';
import { FLOW_RIPPLE, packFlow } from '../flow';
import { packTexture } from '../texture';
import { painted, split } from '../../mesh/paint';
import { meanIn, readPixels, saveFrame, type Pixels } from './frame';
import { HALF, MUD, WHITE, box, one, quad, sheet } from './clearscene';

const W = 192, H = 192;
const NOTHING_ELSE = { foamWidth: 0, glitter: 0, refraction: 0, caustics: 0 };
/** Water that mirrors at a strength that leaves the post plain to see against the sky: what is under test is where the scene lands, not how much of it the Fresnel lets through. */
const BASE = { ...NOTHING_ELSE, mirror: 1.8 };
/** Where the post stands, and how far it rises over the water. */
const POST = { x: -1.5, y: 3, rise: 2 };
/** The renderer's gravity for a world of tenths of a metre (`mmPerUnit` 100), which the swells' speeds go by. */
const GRAVITY = 9810 / 100;
const SWELL: GerstnerWave[] = [{ direction: 0, wavelength: 9, amplitude: 0.05, steepness: 0 }];

/** How far under the water the bed lies: a flat of mud so shallow that, seen from under the water's plane, it hangs over the view and would fill it. */
const BED = -0.3;

/** The flat of mud, and a white post standing on it that comes up out of the water. */
function pond(): GameGroup[] {
  const bed = quad([[-HALF, -HALF, BED], [HALF, -HALF, BED], [HALF, HALF, BED], [-HALF, HALF, BED]]);
  const post = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, POST.rise - BED, 0, POST.x, POST.y, BED, 1]);
  return [
    { mesh: bed, matrices: one, albedo: MUD, roughness: 0.9 },
    { mesh: box(), matrices: post, albedo: WHITE, roughness: 0.9 },
  ];
}

describe('clear water mirroring the scene', () => {
  let gpu: Gpu;
  let env: ReturnType<typeof bakeEnvironment>;
  let r: GameRenderer;
  let target: GPUTexture;
  /** What the device was asked for, by the label the renderer gave it: mirror passes begun, and mirror textures made. */
  let passes: number;
  let textures: { label: string; size: unknown; format: string }[];
  /** How many of those the renderer has let go of. */
  let destroyed: number;

  beforeAll(async () => {
    gpu = await createDevice();
    env = bakeEnvironment(gpu, 'dusk', { size: 32, mips: 3 });
    await env.samples;
    target = gpu.device.createTexture({ size: [W, H], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const d = gpu.device;
    const encoder = d.createCommandEncoder.bind(d);
    d.createCommandEncoder = ((x?: GPUCommandEncoderDescriptor) => {
      const e = encoder(x);
      const begin = e.beginRenderPass.bind(e);
      e.beginRenderPass = ((p: GPURenderPassDescriptor) => { if (p.label === 'game mirror') passes++; return begin(p); }) as typeof e.beginRenderPass;
      return e;
    }) as typeof d.createCommandEncoder;
    const texture = d.createTexture.bind(d);
    d.createTexture = ((x: GPUTextureDescriptor) => {
      const t = texture(x);
      if (x.label?.startsWith('game mirror')) {
        textures.push({ label: x.label, size: x.size, format: x.format });
        const destroy = t.destroy.bind(t);
        t.destroy = () => { destroyed++; destroy(); };
      }
      return t;
    }) as typeof d.createTexture;
    r = new GameRenderer(gpu, 8, 8, 256, 100);
    await r.ready;
    r.setEnvironment(env.specular, env.brdf, env.mips);
    r.resize(W, H);
    r.setLights(new LightPool(8));
  });

  afterAll(() => { r?.dispose(); target?.destroy(); gpu?.device.destroy(); });

  beforeEach(() => {
    passes = 0;
    destroyed = 0;
    textures = [];
    r.resize(W, H);
    r.look = { ...r.look, shading: 'pbr', antialias: undefined, background: [0.02, 0.02, 0.03], occlusion: 0, sunColour: [4, 4, 4], ambient: 1, exposure: 1, clear: BASE };
    r.post = { ...DEFAULT_POST, bloom: 0, vignette: 0, grain: 0, tone: 'clamp' };
    r.economy = { ...FULL_ECONOMY, shadows: false };
    r.camera.fov = 40; r.camera.near = 1; r.camera.far = 200;
    r.camera.position = [0, -12, 1.2];
    r.camera.target = [0, 6, 0];
    r.time = 1.5;
    r.setStatic([...pond(), sheet(96)]);
  });

  const asked = (extra: object = {}) => { r.look = { ...r.look, clear: { ...BASE, mirrorScene: true, ...extra } }; };

  async function draw(name: string): Promise<Pixels> {
    await r.prepare();
    gpu.device.pushErrorScope('validation');
    expect(r.frame(target.createView(), 'redraw', 0)).toBe(true);
    expect(r.frame(target.createView(), 'redraw', 0)).toBe(true);
    const error = await gpu.device.popErrorScope();
    expect(error?.message ?? null).toBeNull();
    const p = await readPixels(gpu, target);
    await saveFrame(`scene mirror ${name}`, p);
    return p;
  }

  /** Where a world point is on the 192 by 192 frame, in pixels. */
  function project([x, y, z]: [number, number, number]): [number, number] {
    r.camera.update();
    const m = r.camera.viewProjection;
    const c = [0, 1, 2, 3].map((row) => m[row] * x + m[4 + row] * y + m[8 + row] * z + m[12 + row]);
    return [(c[0] / c[3] * 0.5 + 0.5) * W, (0.5 - c[1] / c[3] * 0.5) * H];
  }

  /** The post's reflection, as a rectangle of pixels well inside it: under its waterline, down to the mirror image of its top. */
  function reflection(at = POST.x): { x0: number; x1: number; y0: number; y1: number } {
    const front = POST.y - 0.5;
    const [xl, yw] = project([at - 0.5, front, 0]);
    const [xr] = project([at + 0.5, front, 0]);
    const [, yt] = project([at, front, -POST.rise]);
    return { x0: Math.ceil(xl) + 2, x1: Math.floor(xr) - 2, y0: Math.ceil(yw) + 3, y1: Math.floor(yt) - 3 };
  }
  const sideways = (a: { x0: number; x1: number; y0: number; y1: number }, by: number) => ({ ...a, x0: a.x0 + by, x1: a.x1 + by });
  const mean = (p: Pixels, a: { x0: number; x1: number; y0: number; y1: number }) => meanIn(p, a.x0, a.y0, a.x1, a.y1);
  const sum = (c: number[]) => c[0] + c[1] + c[2];
  const same = (a: Pixels, b: Pixels) => a.rgb.every((v, i) => v === b.rgb[i]);

  it('has a reflection to look for: the post stands out of the water and its mirror image is a few pixels deep', () => {
    const a = reflection();
    expect(a.x1 - a.x0, 'wide enough to sample').toBeGreaterThanOrEqual(3);
    expect(a.y1 - a.y0, 'deep enough to sample').toBeGreaterThanOrEqual(8);
    expect(a.y1, 'on the frame').toBeLessThan(H);
  });

  it('mirrors the white post standing in the water in the pixels beneath it, and in no other', async () => {
    const off = await draw('off');
    asked({ mirrorDistort: 0 });
    const on = await draw('on');
    const under = reflection();
    const aside = sideways(under, 40);
    // the post is whiter than the sky and the water it is seen against: the water under it lightens, in every channel
    const gain = [0, 1, 2].map((c) => mean(on, under)[c] - mean(off, under)[c]);
    expect(Math.min(...gain), 'the reflection of a white post, in each channel').toBeGreaterThan(8);
    expect(gain[0] + gain[1] + gain[2], 'and in all').toBeGreaterThan(60);
    // the post itself, above its waterline, is the opaque pass's and is not touched
    const [xl, yw] = project([POST.x - 0.5, POST.y - 0.5, 0]);
    const body = { x0: Math.ceil(xl) + 2, x1: Math.ceil(xl) + 5, y0: Math.floor(yw) - 20, y1: Math.floor(yw) - 8 };
    expect(mean(on, body)).toEqual(mean(off, body));
    // beside it nothing stands to be mirrored, and the bed beneath the water, which would milk it, is clipped away
    // at the plane, so the water there is the sky's as before, to the bit
    for (let y = aside.y0; y < aside.y1; y++)
      for (let x = aside.x0; x < aside.x1; x++) {
        const i = (y * W + x) * 3;
        expect([on.rgb[i], on.rgb[i + 1], on.rgb[i + 2]], `the water beside the post at ${x},${y}`).toEqual([off.rgb[i], off.rgb[i + 1], off.rgb[i + 2]]);
      }
  });

  it('mirrors and clips in the plane it is told: a plane over everything draws nothing, and the reflection runs as far as the plane puts it', async () => {
    const off = await draw('plane off');
    // a plane above the post's top has everything under it, all of which is clipped away: nothing is mirrored
    asked({ mirrorDistort: 0, mirrorPlane: POST.rise + 1 });
    expect(same(await draw('plane above'), off), 'everything under the plane is discarded').toBe(true);
    // the rows of the post's reflection: where the water in its columns is lightened by it
    const a = reflection();
    const front = POST.y - 0.5;
    const [, waterline] = project([POST.x, front, 0]);
    const span = (on: Pixels) => {
      const lit: number[] = [];
      for (let y = Math.ceil(waterline) + 1; y < H; y++) {
        const delta = sum(meanIn(on, a.x0, y, a.x1, y + 1)) - sum(meanIn(off, a.x0, y, a.x1, y + 1));
        if (delta > 30) lit.push(y);
      }
      return [lit[0], lit[lit.length - 1]];
    };
    // the plane at the water, over it and a little under it: the post's image reaches down to the mirror of its top (two
    // above the plane is two below it), and starts at the mirror of the lowest of it that is over the plane
    for (const plane of [0, 0.5, -0.25]) {
      asked({ mirrorDistort: 0, mirrorPlane: plane });
      const [first, last] = span(await draw(`plane ${plane}`));
      const [, bottom] = project([POST.x, front, 2 * plane - POST.rise]);
      expect(last, `the reflection's last row, mirrored in ${plane}`).toBeGreaterThanOrEqual(Math.floor(bottom) - 6);
      expect(last).toBeLessThanOrEqual(Math.ceil(bottom) + 1);
      // under a plane that is under the water the post is cut there, and its image starts at that plane's own image of it
      if (plane < 0) {
        const [, top] = project([POST.x, front, plane]);
        expect(first, `the reflection's first row, clipped at ${plane}`).toBeLessThanOrEqual(Math.ceil(top) + 1);
        expect(first).toBeGreaterThanOrEqual(Math.floor(top) - 1);
      }
    }
  });

  it('shifts the reflection by the swells\' normal times mirrorDistort: in proportion, against the tilt, and by about as far as the sums say', async () => {
    const a0 = reflection();
    const row = Math.round((a0.y0 + a0.y1) / 2);
    const edge = async (distort: number) => {
      asked({ waves: SWELL, mirrorDistort: distort });
      const p = await draw(`distort ${distort}`);
      // the left edge of the post's reflection in the middle of its depth: where the row first goes brighter than half way
      const level = (px: number) => sum([p.rgb[(row * W + px) * 3], p.rgb[(row * W + px) * 3 + 1], p.rgb[(row * W + px) * 3 + 2]]);
      const dark = level(a0.x0 - 14), bright = level(Math.round((a0.x0 + a0.x1) / 2));
      expect(bright - dark, 'an edge to find').toBeGreaterThan(40);
      let px = a0.x0 - 14;
      while (level(px) < (dark + bright) / 2) px++;
      // linear between the two pixels that cross the half way
      return px - 1 + (((dark + bright) / 2 - level(px - 1)) / (level(px) - level(px - 1)));
    };
    const still = await edge(0);
    const small = (await edge(0.3)) - still;
    const large = (await edge(0.6)) - still;
    // the water point that pixel is, on the surface the swell has lifted: found by walking out along y until it projects to the row,
    // and across along x until it projects to the column
    let near = -HALF, far = POST.y;
    let x = 0;
    for (let i = 0; i < 40; i++) {
      const y = (near + far) / 2;
      let left = -HALF, right = HALF;
      for (let j = 0; j < 40; j++) {
        x = (left + right) / 2;
        if (project([x, y, heightAt(SWELL, x, y, r.time, GRAVITY)])[0] > still) right = x; else left = x;
      }
      if (project([x, y, heightAt(SWELL, x, y, r.time, GRAVITY)])[1] > row) near = y; else far = y;
    }
    const slope = new Float64Array(5);
    gerstnerAt(SWELL, x, near, r.time, GRAVITY, slope);
    // the swell's normal there, as the water's vertex stage makes it (the waves are not steep, so the points are not carried)
    const tilt = -slope[3] / Math.hypot(1, slope[3], slope[4]);
    expect(Math.abs(tilt), 'a slope to measure the shift by').toBeGreaterThan(0.01);
    // the screen is read further along where the tilt points, so the picture moves the other way
    expect(Math.sign(small), 'moved against the tilt').toBe(-Math.sign(tilt));
    expect(large / small, 'twice the distortion, twice the shift').toBeGreaterThan(1.8);
    expect(large / small).toBeLessThan(2.2);
    // by the tilt, projected on the screen's x, a share of the screen: half of clip space is the whole of it
    r.camera.update();
    const predicted = 0.5 * r.camera.viewProjection[0] * Math.abs(tilt) * 0.3 * W;
    expect(Math.abs(small) / predicted, 'the shift the sums give').toBeGreaterThan(0.8);
    expect(Math.abs(small) / predicted).toBeLessThan(1.25);
  });

  it('tints the reflected post as it tints the reflected sky, and keeps the strength to both', async () => {
    asked({ mirrorDistort: 0 });
    const plain = await draw('tint none');
    asked({ mirrorDistort: 0, mirrorTint: [0, 0, 1] });
    const blue = await draw('tint blue');
    const under = reflection();
    // a white post through a blue tint is blue: the red and the green it lent the water are gone, the blue is not
    const lent = (p: Pixels) => [0, 1, 2].map((c) => mean(p, under)[c]);
    expect(lent(plain)[0] - lent(blue)[0], 'red out of the mirrored post').toBeGreaterThan(40);
    expect(lent(plain)[1] - lent(blue)[1], 'green out of it').toBeGreaterThan(20);
    expect(Math.abs(lent(plain)[2] - lent(blue)[2]), 'the blue kept').toBeLessThan(lent(plain)[0] - lent(blue)[0]);
    // and the sky beside it is tinted too, as it always was
    const aside = sideways(under, 40);
    expect(mean(plain, aside)[0] - mean(blue, aside)[0], 'red out of the mirrored sky').toBeGreaterThan(15);
    // the mirror's strength is both: nought brings back the water with nothing mirrored, post or sky
    asked({ mirrorDistort: 0, mirror: 0 });
    const none = await draw('strength 0');
    r.look = { ...r.look, clear: { ...NOTHING_ELSE, mirror: 0 } };
    expect(same(none, await draw('off, strength 0')), 'with no strength the scene is mirrored as much as it is without it: not at all').toBe(true);
    asked({ mirrorDistort: 0, mirror: 2 });
    const strong = await draw('strength 2');
    expect(sum(mean(strong, under)), 'twice the strength, the post brighter').toBeGreaterThan(sum(mean(plain, under)) + 10);
  });

  it('softens the edge where the post meets the sky over more than a pixel, and does not step', async () => {
    asked({ mirrorDistort: 0, mirror: 1.5 });
    const p = await draw('edge');
    const a = reflection();
    const row = Math.round((a.y0 + a.y1) / 2);
    const level = (x: number) => sum([p.rgb[(row * W + x) * 3], p.rgb[(row * W + x) * 3 + 1], p.rgb[(row * W + x) * 3 + 2]]);
    // across the post's left edge, from the sky on its left to the post
    const profile: number[] = [];
    for (let x = a.x0 - 12; x <= a.x0 + 4; x++) profile.push(level(x));
    const lo = profile[0], hi = profile[profile.length - 1];
    expect(hi - lo, 'a contrast to soften').toBeGreaterThan(60);
    const steps = profile.slice(1).map((v, i) => Math.abs(v - profile[i]));
    expect(Math.max(...steps), 'no one pixel takes the edge whole').toBeLessThan(0.6 * (hi - lo));
    const between = profile.filter((v) => v > lo + 0.1 * (hi - lo) && v < hi - 0.1 * (hi - lo)).length;
    expect(between, 'at least two pixels of the edge between the two').toBeGreaterThanOrEqual(2);
  });

  it('has a frame uniform of its own with the view turned over in the plane, the eye with it, no occlusion and the plane to clip by', async () => {
    const uniform = async (): Promise<Float32Array> => {
      const buffer = (r as unknown as { mirrorFrameBuffer: GPUBuffer }).mirrorFrameBuffer;
      const read = gpu.device.createBuffer({ size: buffer.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const e = gpu.device.createCommandEncoder();
      e.copyBufferToBuffer(buffer, 0, read, 0, buffer.size);
      gpu.queue.submit([e.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const out = new Float32Array(read.getMappedRange().slice(0));
      read.unmap();
      read.destroy();
      return out;
    };
    for (const plane of [0, 0.7, -1.3]) {
      // occlusion on, so that its flag is one in the camera's own frame and the mirror's has to say nought
      r.look = { ...r.look, occlusion: 1, occlusionRadius: 1.5 };
      asked({ mirrorPlane: plane });
      await draw(`uniform plane ${plane}`);
      const f = await uniform();
      r.camera.update();
      const m = r.camera.viewProjection;
      // a point seen through the turned-over view is the point turned over, seen through the camera's own
      const at = (v: ArrayLike<number>, [x, y, z]: number[]) => [0, 1, 2, 3].map((row) => v[row] * x + v[4 + row] * y + v[8 + row] * z + v[12 + row]);
      for (const p of [[0, 0, 0], [1.5, -2, 3], [-4, 6, -0.5], [2, 9, 1]]) {
        const turned = at(m, [p[0], p[1], 2 * plane - p[2]]);
        const seen = at(f, p);
        for (let i = 0; i < 4; i++) expect(seen[i], `the view turned over in ${plane}, row ${i} at ${p}`).toBeCloseTo(turned[i], 3);
      }
      expect(f[16], 'the eye over x').toBeCloseTo(r.camera.position[0], 5);
      expect(f[17], 'the eye over y').toBeCloseTo(r.camera.position[1], 5);
      expect(f[18], 'the eye under the plane as far as it is over it').toBeCloseTo(2 * plane - r.camera.position[2], 5);
      expect(f[29], 'no occlusion: it is the camera\'s').toBe(0);
      expect(f[32 + 21 + 1], 'the plane to clip by, in the second spare').toBe(Math.fround(plane));
      // the camera's own frame is what it was, and keeps its occlusion
      expect(f.slice(20, 23), 'the sun is the world\'s').toEqual(new Float32Array(r.look.sunDir).slice(0, 3));
    }
  });

  it('mirrors every kind of group the scene draws, on every rung of the ladder it is drawn on: plain, patterned, flowing, textured, carded and painted', async () => {
    const bitmap = () => createImageBitmap(new ImageData(new Uint8ClampedArray(16 * 16 * 4).fill(220), 16, 16), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    r.setGroundTexture([await bitmap()]);
    r.setCardImages([await bitmap()]);
    const at = [-4.5, -2.7, -0.9, 0.9, 2.7, 4.5];
    const post = (x: number): Float32Array => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, POST.rise - BED, 0, x, POST.y, BED, 1]);
    const group = (i: number, extra: Partial<GameGroup>): GameGroup => ({ mesh: box(), matrices: post(at[i]), albedo: WHITE, roughness: 0.9, ...extra });
    const kinds = ['plain', 'patterned', 'flowing', 'textured', 'carded', 'painted'];
    const groups = [
      group(0, {}),
      group(1, { patterns: Float32Array.from([1, 2, 0.3, 0, 0.9, 0.9, 0.9, 0]) }),
      group(2, { patterns: packFlow(new Float32Array(PATTERN_STRIDE), 0, { kind: FLOW_RIPPLE, scale: 1, speed: 0, glow: 0, second: [1, 1, 1] }) }),
      group(3, { texture: packTexture(new Float32Array(4), 0, { layer: 1, repeat: 1, albedo: 0.5, shade: 0.5 }) }),
      group(4, { card: { layer: 1 } }),
      group(5, { mesh: painted(split(box()), { choice: 'gate' }) }),
    ];
    const build = (extra: Partial<GameGroup>[]) => [...pond().slice(0, 1), ...groups.map((g, i) => ({ ...g, ...extra[i] })), sheet(96)];
    r.setStatic(build([]));
    const pipelines = () => (r as unknown as { mirrorPipelines: Map<number, GPURenderPipeline> }).mirrorPipelines.size;
    // what other tests have built for this renderer is not this test's: it counts what it adds
    const had = pipelines();
    for (const points of [true, false]) {
      r.look = { ...r.look, shading: 'toon', clear: BASE };
      r.economy = { ...FULL_ECONOMY, shadows: false, points };
      const off = await draw(`kinds off ${points}`);
      asked({ mirrorDistort: 0 });
      gpu.device.pushErrorScope('validation');
      const on = await draw(`kinds on ${points}`);
      expect((await gpu.device.popErrorScope())?.message ?? null).toBeNull();
      kinds.forEach((kind, i) => {
        const a = reflection(at[i]);
        const delta = sum(mean(on, a)) - sum(mean(off, a));
        expect(Math.abs(delta), `the ${kind} post mirrored, points ${points}`).toBeGreaterThan(25);
      });
      // a build for each kind, and a second set for the second rung, made when asked and not before
      expect(pipelines() - had, `builds with points ${points}`).toBe(points ? 6 : 12);
    }
    r.setGroundTexture(null);
    r.setCardImages(null);
  });

  it('runs no pass and makes no texture while the option is off, whatever else about the mirror is named', async () => {
    await draw('count off');
    r.look = { ...r.look, clear: { ...NOTHING_ELSE, mirrorScene: false, mirrorPlane: 0.5, mirrorDistort: 0.3 } };
    await draw('count off named');
    r.resize(160, 160);
    r.resize(W, H);
    await draw('count off resized');
    expect(passes, 'mirror passes begun').toBe(0);
    expect(textures, 'mirror textures made').toEqual([]);
  });

  it('runs one pass a frame once asked, into half the frame in half floats with a depth of its own, made once and again on a resize', async () => {
    asked();
    await r.prepare();
    for (let i = 0; i < 3; i++) r.frame(target.createView(), 'redraw', 0);
    expect(passes, 'one pass a frame').toBe(3);
    const half = [Math.ceil(W / 2), Math.ceil(H / 2)];
    expect(textures.map((t) => t.label).sort(), 'a colour and a depth, once').toEqual(['game mirror', 'game mirror depth']);
    const colour = textures.find((t) => t.label === 'game mirror')!;
    expect(colour.size).toEqual(half);
    expect(colour.format).toBe('rgba16float');
    // a resize makes them again at the new size, and an odd size rounds up
    r.resize(101, 77);
    r.frame(target.createView(), 'redraw', 0);
    const again = textures.filter((t) => t.label === 'game mirror');
    expect(again.length, 'made again').toBe(2);
    expect(again[1].size).toEqual([51, 39]);
    // and a frame of one pixel still draws
    r.resize(1, 1);
    const tiny = gpu.device.createTexture({ size: [1, 1], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    gpu.device.pushErrorScope('validation');
    expect(r.frame(tiny.createView(), 'redraw', 0)).toBe(true);
    expect((await gpu.device.popErrorScope())?.message ?? null).toBeNull();
    tiny.destroy();
  });

  it('is skipped again when it is turned off, and the water is what it was before it was asked for', async () => {
    // a frame with it off first, which lets go of any the last test left, so what is counted is this test's
    const before = await draw('before');
    destroyed = 0;
    textures = [];
    asked();
    await draw('asked');
    const ran = passes;
    expect(ran).toBeGreaterThan(0);
    r.look = { ...r.look, clear: BASE };
    const after = await draw('after');
    expect(passes, 'no pass once it is off').toBe(ran);
    expect(same(after, before), 'the pixels it was').toBe(true);
    // and the frame and depth it made are let go of, and made again when it is asked for again
    expect(destroyed, 'the mirror\'s frame and its depth, destroyed').toBe(2);
    asked();
    await draw('asked again');
    expect(textures.filter((t) => t.label === 'game mirror').length, 'made again').toBe(2);
    expect(destroyed, 'and not let go of while it is on').toBe(2);
  });

  it('draws no pass for a frame with no clear water in it, whatever the look asks, and lets go of what it made when the renderer is disposed', async () => {
    asked();
    r.setStatic(pond());
    await draw('no water');
    expect(passes, 'no water to show a mirror in, no mirror').toBe(0);
    expect(textures).toEqual([]);
    // a renderer of its own, so that what disposing lets go of is counted alone
    const own = new GameRenderer(gpu, 8, 8, 256, 100);
    await own.ready;
    own.setEnvironment(env.specular, env.brdf, env.mips);
    own.resize(W, H);
    own.setLights(new LightPool(8));
    own.look = { ...r.look, clear: { ...BASE, mirrorScene: true } };
    own.post = r.post;
    own.economy = r.economy;
    own.camera.fov = 40; own.camera.near = 1; own.camera.far = 200;
    own.camera.position = [0, -12, 1.2];
    own.camera.target = [0, 6, 0];
    own.setStatic([...pond(), sheet(96)]);
    await own.prepare();
    own.frame(target.createView(), 'redraw', 0);
    destroyed = 0;
    own.dispose();
    expect(destroyed, 'the mirror\'s frame and its depth, destroyed with the renderer').toBe(2);
  });

  it('draws in each frame mode, at four samples, with the shadows on, and in the toon look, the post mirrored in each', async () => {
    for (const [mode, antialias, shading, shadows] of [['keep', undefined, 'pbr', false], ['redraw', 'msaa', 'pbr', false], ['redraw', undefined, 'toon', true], ['keep', 'msaa', 'toon', true]] as const) {
      const name = `${mode} ${antialias} ${shading} ${shadows ? 'shadowed' : 'flat'}`;
      r.look = { ...r.look, antialias, shading, clear: BASE };
      r.economy = { ...FULL_ECONOMY, shadows };
      if (shadows) r.setSunShadow({ min: [-8, -8, -7], max: [8, 8, 3] });
      const shot = async (label: string) => {
        await r.prepare();
        gpu.device.pushErrorScope('validation');
        for (let i = 0; i < 2; i++) expect(r.frame(target.createView(), mode, 0), name).toBe(true);
        expect((await gpu.device.popErrorScope())?.message ?? null, name).toBeNull();
        const p = await readPixels(gpu, target);
        await saveFrame(`scene mirror ${name} ${label}`, p);
        return p;
      };
      const off = await shot('off');
      asked({ mirrorDistort: 0 });
      const on = await shot('on');
      expect(sum(mean(on, reflection())) - sum(mean(off, reflection())), `the post mirrored in ${name}`).toBeGreaterThan(40);
    }
  });
});
