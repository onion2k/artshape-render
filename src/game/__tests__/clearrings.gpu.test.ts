/**
 * Clear water's splash rings on a real device (October 2026, for ooerfish's splashes): a game hands over where
 * something landed, how long ago and how big, and the water's own normal carries a train of ripples out from there, so
 * the light, the bed seen through it and the mirror are bent as each ring passes, and nothing is painted. Each is asked
 * for, and a water that asks for none, or asks with no strength, draws as v0.43.0 did (held by `cleargolden` as well).
 * Without these a ring could bend the water where no ring is, live on past its life, vanish from a far camera or
 * shimmer to noise near one, or draw over what stands out of the water, all unseen. Frames written by VITE_FRAME_DIR.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { bakeEnvironment } from '../../render/env';
import { DEFAULT_POST, FULL_ECONOMY, GameRenderer } from '../renderer';
import { LightPool } from '../lights';
import type { ClearWater } from '../clear';
import { differing, readPixels, saveFrame, type Pixels } from './frame';
import { HALF, bed, water } from './clearscene';

const W = 192;
/** Nothing but the rings in the difference between two frames: no foam, glitter or caustics. */
const ONLY: Partial<ClearWater> = { foamWidth: 0, glitter: 0, caustics: 0 };
/** The rings as ooerfish asks for them, at a hundred millimetres a unit. */
const RINGS: Partial<ClearWater> = { ringStrength: 2.5, ringWavelength: 0.5, ringSpeed: 3, ringTrain: 0.5, ringGrowth: 0.6, ringLife: 3.5, ringPixels: 6 };

interface Cam {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

describe("clear water's splash rings", () => {
  let gpu: Gpu;
  let r: GameRenderer;
  let target: GPUTexture;

  beforeAll(async () => {
    gpu = await createDevice();
    const env = bakeEnvironment(gpu, 'daylight', { size: 32, mips: 3 });
    await env.samples;
    target = gpu.device.createTexture({ size: [W, W], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    r = new GameRenderer(gpu, 8, 8, 256, 100);
    await r.ready;
    r.setEnvironment(env.specular, env.brdf, env.mips);
    r.resize(W, W);
    r.setLights(new LightPool(8));
    r.look = { ...r.look, shading: 'pbr', antialias: undefined, background: [0.02, 0.02, 0.03], occlusion: 0, sunColour: [1, 1, 1], sunDir: [0.3, 0.5, 0.8], ambient: 1, exposure: 0.6 };
    r.post = { ...DEFAULT_POST, bloom: 0, vignette: 0, grain: 0, tone: 'clamp' };
    r.economy = { ...FULL_ECONOMY, shadows: false };
    r.camera.near = 0.5; r.camera.far = 400;
    r.setStatic([...bed(), water()]);
  });
  afterAll(() => { r?.dispose(); target?.destroy(); gpu?.device.destroy(); });

  const OVER: Cam = { position: [0, -6, 14], target: [0, 0, 0], fov: 40 };
  let cam = OVER;
  beforeEach(() => {
    cam = OVER;
    place(OVER);
    r.look = { ...r.look, clear: { ...ONLY } };
    r.setRings(new Float32Array(0), 0);
    r.time = 1;
  });

  function place(c: Cam) {
    cam = c;
    r.camera.fov = c.fov;
    r.camera.position = [...c.position];
    r.camera.target = [...c.target];
  }

  async function draw(name: string): Promise<Pixels> {
    await r.prepare();
    gpu.device.pushErrorScope('validation');
    expect(r.frame(target.createView(), 'redraw', 0)).toBe(true);
    expect(r.frame(target.createView(), 'redraw', 0)).toBe(true);
    expect((await gpu.device.popErrorScope())?.message ?? null).toBeNull();
    const p = await readPixels(gpu, target);
    await saveFrame(`rings ${name}`, p);
    return p;
  }

  /** Where the ray through a pixel's centre meets the still water's plane, from the camera as placed. */
  function onPlane(px: number, py: number): [number, number] {
    const [cx, cy, cz] = cam.position;
    const f = cam.target.map((t, i) => t - cam.position[i]);
    const fl = Math.hypot(...f); f.forEach((_, i) => (f[i] /= fl));
    const right = [f[1], -f[0], 0]; const rl = Math.hypot(...right); right.forEach((_, i) => (right[i] /= rl));
    const up = [right[1] * f[2] - right[2] * f[1], right[2] * f[0] - right[0] * f[2], right[0] * f[1] - right[1] * f[0]];
    const t = Math.tan((cam.fov / 2) * (Math.PI / 180));
    const nx = ((px + 0.5) / W) * 2 - 1, ny = 1 - ((py + 0.5) / W) * 2;
    const d = [0, 1, 2].map((i) => f[i] + right[i] * nx * t + up[i] * ny * t);
    const s = -cz / d[2];
    return [cx + d[0] * s, cy + d[1] * s];
  }

  /** The pixels that differ between two frames by more than a level, each with where it lies on the water's plane. */
  function changed(a: Pixels, b: Pixels): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < W * W; i++) {
      let most = 0;
      for (let c = 0; c < 3; c++) most = Math.max(most, Math.abs(a.rgb[i * 3 + c] - b.rgb[i * 3 + c]));
      if (most > 1) {
        const [x, y] = onPlane(i % W, Math.floor(i / W));
        out.push({ x, y });
      }
    }
    return out;
  }

  it('draws a water with rings handed over but no strength, or a strength and no rings, as the water without them, to the pixel', async () => {
    const none = await draw('none');
    r.setRings(new Float32Array([0, 0, 0.5, 1]), 1);
    expect(differing(await draw('no strength'), none), 'rings with no strength').toBe(0);
    r.setRings(new Float32Array(0), 0);
    r.look = { ...r.look, clear: { ...ONLY, ...RINGS } };
    expect(differing(await draw('no rings'), none), 'a strength with no rings').toBe(0);
  });

  it('bends the water within the ring\'s train and nowhere outside it', async () => {
    const none = await draw('ring off');
    r.look = { ...r.look, clear: { ...ONLY, ...RINGS } };
    const age = 0.5;
    r.setRings(new Float32Array([0, 0, age, 1]), 1);
    const on = await draw('ring on');
    const moved = changed(on, none);
    // the front three tenths of a wavelength out at the landing and then at the speed; the train behind it its length
    // and its growth by the age; a wavelength's grace either side, where the train's ends ease in and out
    const front = 0.3 * 0.5 + 3 * age, train = 0.5 + 0.6 * age, grace = 0.5;
    const far = moved.filter((p) => Math.hypot(p.x, p.y) > front + grace || Math.hypot(p.x, p.y) < front - train - grace);
    console.log(`the ring at ${age} s: ${moved.length} pixels moved, ${far.length} outside its band (${(front - train).toFixed(2)} to ${front.toFixed(2)})`);
    expect(moved.length, 'a ring that can be seen').toBeGreaterThan(400);
    expect(far.length, 'nothing bent outside the ring').toBe(0);
    // and it goes out all the way round, not to one side
    const quarters = [0, 0, 0, 0];
    for (const p of moved) quarters[(p.x >= 0 ? 1 : 0) + (p.y >= 0 ? 2 : 0)]++;
    expect(Math.min(...quarters), 'every quarter of the ring').toBeGreaterThan(moved.length / 8);
  });

  it('draws nothing of a ring past its life, before its age begins, or of no size', async () => {
    const none = await draw('ages none');
    r.look = { ...r.look, clear: { ...ONLY, ...RINGS } };
    // so that nothing drawn is not simply a ring that is never drawn
    r.setRings(new Float32Array([0, 0, 1, 1]), 1);
    expect(differing(await draw('ages precondition'), none), 'a ring a second old is drawn').toBeGreaterThan(400);
    for (const [age, size, what] of [[3.6, 1, 'past its life'], [-0.5, 1, 'before it began'], [1, 0, 'of no size']] as const) {
      r.setRings(new Float32Array([0, 0, age, size]), 1);
      expect(differing(await draw(`ages ${what}`), none), what).toBe(0);
    }
  });

  it('keeps a far ring seen at its least pixels, and lets a ring too fine for the screen fade rather than shimmer', async () => {
    // from far off and low, a ring a twentieth of a unit across is a fraction of a pixel
    place({ position: [0, -60, 8], target: [0, 0, 0], fov: 30 });
    const fine = { ...ONLY, ...RINGS, ringWavelength: 0.05, ringSpeed: 1 };
    const none = await draw('far none');
    r.setRings(new Float32Array([0, 0, 1.5, 1]), 1);
    r.look = { ...r.look, clear: { ...fine, ringPixels: 0 } };
    const unkept = differing(await draw('far fine unkept'), none);
    r.look = { ...r.look, clear: { ...fine, ringPixels: 6 } };
    const kept = differing(await draw('far fine kept'), none);
    console.log(`a fine ring from far off: ${unkept} pixels moved with no least, ${kept} at six pixels`);
    expect(unkept, 'too fine to draw, so faded and not aliased').toBeLessThan(20);
    expect(kept, 'drawn at its least pixels').toBeGreaterThan(100);
  });

  it('stops at the water\'s edge: nothing past the water is touched by a ring that reaches over it', async () => {
    const none = await draw('edge none');
    r.look = { ...r.look, clear: { ...ONLY, ...RINGS } };
    r.setRings(new Float32Array([HALF - 0.5, 0, 0.6, 1]), 1);
    const moved = changed(await draw('edge on'), none);
    const past = moved.filter((p) => p.x > HALF + 0.05);
    expect(moved.length, 'the ring is drawn on the water').toBeGreaterThan(200);
    expect(past.length, 'none past the edge').toBe(0);
  });

  it('draws twelve rings at once, and no more than twelve of the rings handed over', async () => {
    r.look = { ...r.look, clear: { ...ONLY, ...RINGS } };
    const many = new Float32Array(13 * 4);
    for (let i = 0; i < 13; i++) many.set([-5 + (i % 4) * 3.3, -4 + Math.floor(i / 4) * 3.3, 0.3, 0.6], i * 4);
    expect(r.setRings(many, 13), 'more than the slots: refused past the twelfth').toBe(false);
    const thirteen = await draw('thirteen');
    expect(r.setRings(many, 12)).toBe(true);
    expect(differing(await draw('twelve'), thirteen), 'the thirteenth is not drawn').toBe(0);
    r.setRings(new Float32Array(0), 0);
    r.look = { ...r.look, clear: { ...ONLY } };
    expect(differing(await draw('twelve none'), thirteen), 'twelve are drawn').toBeGreaterThan(1000);
  });
});
