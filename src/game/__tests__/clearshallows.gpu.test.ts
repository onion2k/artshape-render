/**
 * Clear water's shallows on a real device: the knee, a depth of path through which nothing is lost to the deep colour,
 * so a box under thin water is seen in its own colour while one in the deep is still lost; the same knee on the
 * caustics' fade; and a narrower caustic line, crisper across a row of the bed. Each is asked for, and a water that
 * asks for neither draws as before (held by `cleargolden`). Without these a game could not have a pale bed seen bright
 * through its shallows, and a change to the absorption or the caustics could move them unseen. Frames written by
 * VITE_FRAME_DIR, with a sheet of the pond with each on and off.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { bakeEnvironment } from '../../render/env';
import { DEFAULT_POST, FULL_ECONOMY, GameRenderer, PATTERN_STRIDE, type GameGroup } from '../renderer';
import { LightPool } from '../lights';
import { FLOW_CLEAR, packFlow } from '../flow';
import { differing, meanIn, readPixels, saveFrame, type Pixels } from './frame';
import { HALF, bed, one, quad, water } from './clearscene';

const W = 192, H = 192;
/** Far off and long in the lens, as the clear water tests' camera, so the picture is close to a plan of the water. */
const DISTANCE = 301.5, FOV = 3;
const PX_PER_UNIT = H / (2 * DISTANCE * Math.tan((FOV / 2) * (Math.PI / 180)));
const px = (x: number, y: number) => [Math.round(W / 2 + x * PX_PER_UNIT), Math.round(H / 2 - y * PX_PER_UNIT)] as const;
const around = (p: Pixels, x: number, y: number, r = 3) => {
  const [cx, cy] = px(x, y);
  return meanIn(p, cx - r, cy - r, cx + r, cy + r);
};
const gap = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const bright = (c: number[]) => c[0] + c[1] + c[2];
const luma = (p: Pixels, i: number) => 0.2126 * p.rgb[i * 3] + 0.7152 * p.rgb[i * 3 + 1] + 0.0722 * p.rgb[i * 3 + 2];
/**
 * Nothing but the absorption and, where asked, the caustics: no foam, glitter or bend, and no mirror, so a pixel whose
 * light lost nothing is the opaque frame's own, to the level.
 */
const ONLY = { foamWidth: 0, glitter: 0, refraction: 0, caustics: 0, mirror: 0 };

/** A flat bed of sand `depth` under the water, and the water over it with a deep colour of `deep`. */
function sandUnder(depth: number, deep: [number, number, number]): GameGroup[] {
  const sand = quad([[-HALF, -HALF, -depth], [HALF, -HALF, -depth], [HALF, HALF, -depth], [-HALF, HALF, -depth]]);
  const surface = water();
  return [
    { mesh: sand, matrices: one, albedo: [0.7, 0.62, 0.42], roughness: 0.9 },
    { ...surface, patterns: packFlow(new Float32Array(PATTERN_STRIDE), 0, { kind: FLOW_CLEAR, scale: 0.4, speed: 0.5, glow: 0, second: deep }) },
  ];
}

describe('the shallows of clear water', () => {
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
  });

  afterAll(() => { r?.dispose(); target?.destroy(); gpu?.device.destroy(); });

  beforeEach(() => {
    r.look = { ...r.look, shading: 'pbr', antialias: undefined, background: [0.02, 0.02, 0.03], occlusion: 0, sunColour: [1, 1, 1], sunDir: [0.3, 0, 0.95], ambient: 1, exposure: 1, clear: ONLY };
    r.post = { ...DEFAULT_POST, bloom: 0, vignette: 0, grain: 0, tone: 'clamp' };
    r.economy = { ...FULL_ECONOMY, shadows: false };
    r.camera.fov = FOV; r.camera.near = 100; r.camera.far = 600;
    r.camera.target = [0, 0, 0];
    r.camera.position = [0, -30, 300];
    r.time = 1;
    r.setStatic([]);
  });

  async function draw(name: string): Promise<Pixels> {
    await r.prepare();
    gpu.device.pushErrorScope('validation');
    expect(r.frame(target.createView(), 'redraw', 0)).toBe(true);
    expect(r.frame(target.createView(), 'redraw', 0)).toBe(true);
    const error = await gpu.device.popErrorScope();
    expect(error?.message ?? null).toBeNull();
    const p = await readPixels(gpu, target);
    await saveFrame(`shallows ${name}`, p);
    return p;
  }

  it('shows a box under thin water in its own colour with a knee past its depth, and still loses the one in the deep', async () => {
    // the pond's shallow box stands with its top a third of a unit under, its deep one four units under; a clarity of
    // 0.7 tints the shallow one plainly and all but loses the deep one
    r.setStatic(bed());
    const dry = await draw('knee dry');
    r.setStatic([...bed(), water()]);
    r.look = { ...r.look, clear: { ...ONLY, clarity: 0.7 } };
    const plain = await draw('knee none');
    r.look = { ...r.look, clear: { ...ONLY, clarity: 0.7, clearKnee: 0.6 } };
    const kneed = await draw('knee 0.6');
    const shallow = (p: Pixels) => around(p, -4.5, 2), deep = (p: Pixels) => around(p, 4.5, 2);
    expect(gap(shallow(plain), shallow(dry)), 'with no knee the shallow box is tinted by the water').toBeGreaterThan(40);
    expect(gap(shallow(kneed), shallow(dry)), 'with a knee past its depth it is its own colour, as with no water').toBeLessThan(1.5);
    // the deep box is under three and a half units more than the knee, and is still the water's
    expect(bright(shallow(kneed)) - bright(deep(kneed)), 'the deep box darker than the shallow one').toBeGreaterThan(150);
    expect(gap(deep(kneed), deep(dry)), 'the deep box far from its own colour').toBeGreaterThan(100);
    expect(deep(kneed)[2], 'and the deep colour\'s hue: bluer than it is red').toBeGreaterThan(deep(kneed)[0] + 10);
  });

  it('fades the caustics by the same knee, so they are as bright under it as at the surface', async () => {
    // over a black deep colour and no mirror, a pixel is the bed times what is kept, with the caustics or without: the
    // share the caustics add is their own strength alone, whatever the absorption keeps, so only their fade moves it.
    // A unit under, at a clarity of two, they fade to 2^(-1/1.2) of their brightest with no knee and not at all with one
    // of a unit.
    r.setStatic(sandUnder(1, [0, 0, 0]));
    // at half the exposure, so the brightest line is not held at white, which would understate it
    r.look = { ...r.look, exposure: 0.5 };
    const share = async (knee: number) => {
      r.look = { ...r.look, clear: { ...ONLY, clarity: 2, clearKnee: knee, causticScale: 1.5 } };
      const off = await draw(`fade off, knee ${knee}`);
      r.look = { ...r.look, clear: { ...ONLY, clarity: 2, clearKnee: knee, causticScale: 1.5, caustics: 3 } };
      const on = await draw(`fade on, knee ${knee}`);
      const a = bright(around(on, -2, 0, 24)), b = bright(around(off, -2, 0, 24));
      expect(Math.max(...on.rgb), `nothing clipped at the top, knee ${knee}`).toBeLessThan(255);
      return a / b - 1;
    };
    const none = await share(0), kneed = await share(1);
    console.log(`the caustics' share of the bed a unit under: ${none.toFixed(3)} with no knee, ${kneed.toFixed(3)} with a knee of a unit`);
    expect(none, 'caustics seen with no knee').toBeGreaterThan(0.05);
    // 1 / 2^(-1/1.2) is 1.78
    expect(kneed / none, 'the caustics unfaded under the knee').toBeGreaterThan(1.5);
    expect(kneed / none, 'and by about what the fade took').toBeLessThan(2.1);
  });

  it('draws a crisper caustic line when it is narrower: a row across the bed has a higher contrast at 0.08 than at 0.16', async () => {
    // sand a third of a unit under clear water, and cells four units across, so a line of 0.16 is some eight pixels wide
    r.setStatic(sandUnder(0.3, [0.02, 0.12, 0.28]));
    const at = (line?: number) => ({ ...ONLY, clarity: 4, causticScale: 4, caustics: 1, ...(line === undefined ? {} : { causticLine: line }) });
    r.look = { ...r.look, clear: { ...ONLY, clarity: 4, causticScale: 4 } };
    const off = await draw('line off');
    r.look = { ...r.look, clear: at() };
    const wide = await draw('line unnamed');
    r.look = { ...r.look, clear: at(0.16) };
    const named = await draw('line 0.16');
    r.look = { ...r.look, clear: at(0.08) };
    const narrow = await draw('line 0.08');
    expect(differing(named, wide), 'the line named at its default draws as one unnamed').toBe(0);
    // the light the caustics add along three rows across the middle of the bed, and how much it varies against its mean
    const row = (p: Pixels) => {
      const added: number[] = [];
      for (const y of [H / 2 - 20, H / 2, H / 2 + 20])
        for (let x = 8; x < W - 8; x++) added.push(luma(p, y * W + x) - luma(off, y * W + x));
      const mean = added.reduce((s, a) => s + a, 0) / added.length;
      const sd = Math.sqrt(added.reduce((s, a) => s + (a - mean) ** 2, 0) / added.length);
      return { mean, contrast: sd / mean };
    };
    const w16 = row(wide), w08 = row(narrow);
    console.log(`the caustics along a row: 0.16 mean ${w16.mean.toFixed(1)}, contrast ${w16.contrast.toFixed(2)}; 0.08 mean ${w08.mean.toFixed(1)}, contrast ${w08.contrast.toFixed(2)}`);
    expect(w16.mean, 'caustics seen at today\'s line').toBeGreaterThan(3);
    expect(w08.contrast, 'a higher contrast at the narrower line').toBeGreaterThan(w16.contrast * 1.2);
    // a narrower line covers less of the bed, so at the same strength it adds less light in all
    expect(w08.mean, 'less light in all').toBeLessThan(w16.mean);
  });
});

/**
 * A sheet for looking at: the pond from the side, at the toon daylight, with the knee and the narrow line each off and
 * on. Only when frames are being written; it asserts nothing but that it drew.
 */
describe.skipIf(!import.meta.env.VITE_FRAME_DIR)('a sheet of the shallows', () => {
  it('draws the pond with the knee and the narrow line, each on and off', async () => {
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
    r.look = { ...r.look, shading: 'toon', sunDir: [0.45, -0.5, 0.74], sunColour: [2.6, 2.45, 2.2], ambient: 1, exposure: 0.92, background: [0.62, 0.84, 0.98], occlusion: 0 };
    r.post = { ...DEFAULT_POST, vignette: 0, grain: 0, tone: 'soft' };
    r.economy = { ...FULL_ECONOMY, shadows: true };
    r.setSunShadow({ min: [-8, -8, -7], max: [8, 8, 2] });
    r.camera.fov = 40; r.camera.near = 1; r.camera.far = 400;
    r.camera.target = [0, 0, -1];
    r.camera.position = [0, -12, 8];
    r.setStatic([...bed(), water(undefined, 0.3)]);
    r.time = 2;
    const base = { clarity: 1.5, foamWidth: 0.3, refraction: 1, glitter: 0, causticScale: 1.5 };
    const shots: [string, NonNullable<typeof r.look.clear>][] = [
      ['plain', { ...base, caustics: 1 }],
      ['knee', { ...base, caustics: 1, clearKnee: 0.75 }],
      ['line', { ...base, caustics: 3, causticLine: 0.08 }],
      ['both', { ...base, caustics: 3, causticLine: 0.08, clearKnee: 0.75 }],
    ];
    for (const [name, clear] of shots) {
      r.look = { ...r.look, clear };
      await r.prepare();
      for (let f = 0; f < 3; f++) r.frame(tex.createView(), 'redraw', 0);
      await saveFrame(`shallows sheet ${name}`, await readPixels(gpu, tex));
    }
    r.dispose();
    tex.destroy();
    gpu.device.destroy();
  });
});
