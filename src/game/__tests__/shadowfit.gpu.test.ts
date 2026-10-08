/**
 * The sun's shadow as v0.28.0 lets a game ask for it, on a real device: the map fitted to the view and not the whole box,
 * so a thin thing on a long hole casts a shadow and not a smudge; its shadows faded out toward the fitted square's edge
 * rather than stopping there; its edge softened over a wider kernel; and open water darkened where something stands
 * between it and the sun. That none of it changes a game that does not ask is `unasked.gpu.test.ts`.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { bakeEnvironment } from '../../render/env';
import { GameRenderer, type GameGroup } from '../renderer';
import { LightPool } from '../lights';
import { readPixels, saveFrame, type Pixels } from './frame';
import { block, golfLook, water } from './golfscene';

const SIZE = 200;

describe('the sun shadow fitted to the view', () => {
  let gpu: Gpu;
  let env: { specular: GPUTexture; brdf: GPUTexture; mips: number };
  const made: { r: GameRenderer; target: GPUTexture }[] = [];

  beforeAll(async () => {
    gpu = await createDevice();
    const baked = bakeEnvironment(gpu, 'daylight', { size: 32, mips: 3 });
    await baked.samples;
    env = baked;
  });
  afterAll(() => {
    for (const x of made) { x.r.dispose(); x.target.destroy(); }
    gpu?.device.destroy();
  });

  /** A renderer in the golf look over `groups`, the camera at `eye` looking at `at`, ready. */
  async function make(groups: GameGroup[], eye: [number, number, number], at: [number, number, number]) {
    const r = new GameRenderer(gpu, 8, 8, 4096, 100);
    await r.ready;
    const target = gpu.device.createTexture({ size: [SIZE, SIZE], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    made.push({ r, target });
    r.setEnvironment(env.specular, env.brdf, env.mips);
    r.resize(SIZE, SIZE);
    r.setLights(new LightPool(8));
    r.setStatic(groups);
    r.setDynamic([]);
    golfLook(r);
    r.time = 1.5;
    r.camera.position = eye;
    r.camera.target = at;
    r.camera.near = 0.5;
    r.camera.far = 3000;
    await r.prepare();
    return { r, view: target.createView(), target };
  }
  type Scene = Awaited<ReturnType<typeof make>>;

  async function shot(s: Scene, name?: string): Promise<Pixels> {
    for (let i = 0; i < 2; i++) s.r.frame(s.view, 'redraw', 1 / 60);
    const p = await readPixels(gpu, s.target);
    if (name) await saveFrame(name, p);
    return p;
  }

  /** Where a world point lands on the frame, in pixels. */
  function pixelOf(s: Scene, p: [number, number, number]): [number, number] {
    s.r.camera.update();
    const m = s.r.camera.viewProjection;
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    return [Math.round(((x / w) * 0.5 + 0.5) * SIZE), Math.round((0.5 - (y / w) * 0.5) * SIZE)];
  }
  /** The brightness of a 3×3 patch round a world point. */
  function at(s: Scene, p: Pixels, w: [number, number, number]): number {
    const [cx, cy] = pixelOf(s, w);
    let sum = 0;
    for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
      const i = (y * p.width + x) * 3;
      sum += p.rgb[i] + p.rgb[i + 1] + p.rgb[i + 2];
    }
    return sum / 27;
  }

  /** The darkest 3×3 patch within a few pixels of a world point: a thin shadow need not land on the pixel worked out for it. */
  function darkest(s: Scene, p: Pixels, w: [number, number, number], r = 4): number {
    const [cx, cy] = pixelOf(s, w);
    let best = Infinity;
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
      let sum = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        const k = ((y + j) * p.width + x + i) * 3;
        sum += p.rgb[k] + p.rgb[k + 1] + p.rgb[k + 2];
      }
      best = Math.min(best, sum / 27);
    }
    return best;
  }

  // the sun of the golf look: its shadows fall toward -x and +y, a little over a third of a thing's height each way
  const SHADE = (x: number, y: number, z: number): [number, number, number] => [x - (0.35 / 0.89) * z, y + (0.3 / 0.89) * z, 0];

  // a hole two thousand long, and a pole as thin as a flag's near the camera
  const LONG = { min: [-60, -20, -4] as [number, number, number], max: [60, 2000, 24] as [number, number, number] };
  const POLE = block(0.3, 0.3, 12, 0, 40, 0, [0.9, 0.9, 0.9]);
  const GROUND = block(200, 2400, 1, 0, 1000, -1, [0.1, 0.42, 0.03]);

  it('casts a thin thing\'s shadow fitted to the view, where the whole box smudged it to nothing', async () => {
    const s = await make([GROUND, POLE], [6, 18, 14], [-2, 44, 0]);
    const inShade = SHADE(0, 40, 6),
      open = [inShade[0] + 4, inShade[1], 0] as [number, number, number];
    s.r.setSunShadow(LONG);
    const box = await shot(s, 'fit-box');
    s.r.setSunShadow(LONG, { reach: 80 });
    const fitted = await shot(s, 'fit-view');
    const boxDepth = 1 - darkest(s, box, inShade) / at(s, box, open);
    const fitDepth = 1 - darkest(s, fitted, inShade) / at(s, fitted, open);
    // the fitted map's shadow is a shadow, as deep as the look's shade goes; the whole box's is a fraction of it
    expect(fitDepth).toBeGreaterThan(0.15);
    expect(boxDepth).toBeLessThan(fitDepth * 0.75);
  });

  it('fades its shadows out toward the square\'s edge, and leaves the open ground as it was', async () => {
    // a row of posts from the middle of the square out past its edge, along the light's own right, which the square is
    // laid square to: the sun's horizontal is (0.35, -0.3), so its right across the ground is (0.65, 0.76)
    const along = [0, 8, 14, 17, 18.5, 24];
    const R: [number, number] = [0.3 / 0.461, 0.35 / 0.461];
    const posts = along.map((t) => block(1.5, 1.5, 8, 10 + t * R[0], t * R[1], 0, [0.9, 0.9, 0.9]));
    const s = await make([block(200, 200, 1, 0, 0, -1, [0.1, 0.42, 0.03]), ...posts], [10, 0.01, 90], [10, 0, 0]);
    const BOX = { min: [-80, -80, -4] as [number, number, number], max: [80, 80, 24] as [number, number, number] };
    s.r.setSunShadow(BOX);
    const whole = await shot(s, 'fit-fade-box');
    s.r.setSunShadow(BOX, { reach: 40, fade: 0.25 });
    const p = await shot(s, 'fit-fade');
    // how much of the whole box's shadow on the ground beside each post the fitted map keeps: the posts' own sides are the
    // same in both frames, so only the ground's shade is compared
    const kept = (t: number) => {
      const d = SHADE(10 + t * R[0], t * R[1], 4);
      // open ground well away from the posts and their shadows, lit alike everywhere on the flat
      const open = at(s, whole, [0, -15, 0]);
      return (open - at(s, p, d)) / (open - at(s, whole, d));
    };
    // the square is forty across round its middle (snapped): full to fifteen out, easing to its edge at twenty, and
    // nothing past it
    expect(kept(0)).toBeGreaterThan(0.9);
    expect(kept(8)).toBeGreaterThan(0.9);
    expect(kept(24)).toBeLessThan(0.05);
    // and it eases, not steps: a post in the band is shaded less than one inside it and more than one past it
    expect(kept(18.5)).toBeLessThan(0.85);
    expect(kept(18.5)).toBeGreaterThan(0.05);
  });

  it('softens the edge of a shadow over more pixels as the look asks', async () => {
    const wall = block(1, 20, 10, 0, 30, 0, [0.9, 0.9, 0.9]);
    const s = await make([block(200, 200, 1, 0, 30, -1, [0.1, 0.42, 0.03]), wall], [-4, 30.01, 40], [-4, 30, 0]);
    // a coarse map, so a texel is a good part of a unit and a softening of three of them is seen from here
    s.r.setSunShadow({ min: [-30, 0, -4], max: [30, 60, 24] }, { reach: 1000 });
    // a line across the wall's shadow's edge, along x, counting the pixels between dark and light
    const between = (p: Pixels) => {
      const [x0, y] = pixelOf(s, [-8, 30, 0]),
        [x1] = pixelOf(s, [-1, 30, 0]);
      const row: number[] = [];
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
        const i = (y * p.width + x) * 3;
        row.push(p.rgb[i] + p.rgb[i + 1] + p.rgb[i + 2]);
      }
      const lo = Math.min(...row), hi = Math.max(...row);
      return row.filter((v) => v > lo + 0.1 * (hi - lo) && v < hi - 0.1 * (hi - lo)).length;
    };
    const sharp = between(await shot(s, 'soft-0'));
    s.r.look = { ...s.r.look, shadowSoftness: 3 };
    const soft = between(await shot(s, 'soft-3'));
    expect(soft).toBeGreaterThan(sharp * 1.5);
    // nought said out loud is the sharp edge to the pixel
    s.r.look = { ...s.r.look, shadowSoftness: 0 };
    expect(between(await shot(s))).toBe(sharp);
  });

  it('darkens open water in a shadow when the look asks, and nowhere else', async () => {
    const pond = water(40, 40, 0, 40, 0.02);
    const post = block(3, 3, 12, 0, 40, 0, [0.9, 0.9, 0.9]);
    const s = await make([block(200, 200, 1, 0, 40, -1, [0.1, 0.42, 0.03]), pond, post], [0, 10, 30], [0, 42, 0]);
    s.r.setSunShadow({ min: [-30, 10, -4], max: [30, 70, 24] }, { reach: 120 });
    // left of the post as the camera sees it, inside its shadow and not behind it
    const shade: [number, number, number] = [-4.5, 42, 0],
      clear: [number, number, number] = [8, 30, 0];
    const lit = await shot(s, 'water-lit');
    s.r.look = { ...s.r.look, waterShadow: true };
    const shaded = await shot(s, 'water-shaded');
    // about as much darker as the ground goes in a shadow (0.82 of its light in this look), and at least a tenth
    expect(at(s, shaded, shade)).toBeLessThan(at(s, lit, shade) * 0.9);
    // water the post does not shade is the same either way
    expect(Math.abs(at(s, shaded, clear) - at(s, lit, clear))).toBeLessThan(0.5);
  });

  it('is off on the rung that turns shadows off, fitted or not', async () => {
    const s = await make([GROUND, POLE], [6, 18, 14], [-2, 44, 0]);
    s.r.setSunShadow(LONG, { reach: 80 });
    s.r.economy = { ...s.r.economy, shadows: false };
    const p = await shot(s);
    const inShade = SHADE(0, 40, 6);
    expect(1 - darkest(s, p, inShade) / at(s, p, [inShade[0] + 4, inShade[1], 0])).toBeLessThan(0.03);
  });
});
