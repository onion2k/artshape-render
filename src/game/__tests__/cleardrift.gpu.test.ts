/**
 * Clear water's sparkles drifting, on a real device: the lattice their stars are the points of is carried by
 * `sparkleDrift`, so a star moves across the screen as the water does and a glint that comes round again at its point
 * comes round somewhere else. It holds that a drift of nought is the pinned lattice to the pixel; that a star moves by
 * the drift's own projection, frame to frame, and not at all without it; and that on the lake, filmed five seconds
 * stepped, the near water's stars return in their places with the lattice pinned (the blink ooerfish's films found)
 * and not with it drifting. Without these a drift could move the cells and not their points, or move nothing, unseen.
 * Frames written by VITE_FRAME_DIR: every frame of both films, for looking at.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { bakeEnvironment } from '../../render/env';
import { DEFAULT_POST, FULL_ECONOMY, GameRenderer } from '../renderer';
import { LightPool } from '../lights';
import type { ClearWater } from '../clear';
import { differing, readPixels, saveFrame, type Pixels } from './frame';
import { sheet } from './clearscene';
import { LAKE_CLEAR, LAKE_LOOK, VIEWS, lake, type Cam } from './clearlake';

const place = (r: GameRenderer, c: Cam) => { r.camera.position = [...c.position]; r.camera.target = [...c.target]; r.camera.fov = c.fov; };
const luma = (p: Pixels, i: number) => p.rgb[i * 3] + p.rgb[i * 3 + 1] + p.rgb[i * 3 + 2];

type Spot = { x: number; y: number; n: number };

/** The bright spots of a frame against the same moment with no sparkles: groups of touching lit pixels, each with its centre. */
function spots(p: Pixels, without: Pixels, least: number, fewest = 4): Spot[] {
  const { width: W, height: H } = p;
  const lit = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) lit[i] = luma(p, i) - luma(without, i) > least ? 1 : 0;
  const found: Spot[] = [];
  const seen = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (!lit[i] || seen[i]) continue;
    let sx = 0, sy = 0, n = 0;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % W, y = (j - x) / W;
      sx += x; sy += y; n++;
      for (const k of [j - 1, j + 1, j - W, j + W])
        if (k >= 0 && k < W * H && Math.abs((k % W) - x) <= 1 && lit[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
    }
    if (n >= fewest) found.push({ x: sx / n, y: sy / n, n });
  }
  return found;
}

/**
 * Stars tracked through stepped frames: a spot within `near` pixels of a known star's last place is that star again,
 * moved there. A star seen again after it had been dark for at least `dark` seconds has returned in its place.
 */
type Star = { x: number; y: number; first: number; last: number; returns: number; gaps: string[] };
function track(frames: Spot[][], fps: number, near: number, dark: number): Star[] {
  const stars: Star[] = [];
  frames.forEach((found, f) => {
    const t = f / fps;
    for (const s of found) {
      let best: Star | null = null, bestD = near;
      for (const star of stars) {
        const d = Math.hypot(star.x - s.x, star.y - s.y);
        if (d < bestD) { best = star; bestD = d; }
      }
      if (!best) { stars.push({ x: s.x, y: s.y, first: t, last: t, returns: 0, gaps: [] }); continue; }
      if (t - best.last >= dark) { best.returns++; best.gaps.push(`at (${best.x.toFixed(0)}, ${best.y.toFixed(0)}) lit ${best.first.toFixed(2)}-${best.last.toFixed(2)} s, again at ${t.toFixed(2)} s, ${bestD.toFixed(1)} px off`); }
      best.x = s.x; best.y = s.y; best.last = t;
    }
  });
  return stars;
}

describe("clear water's sparkles drifting", () => {
  let gpu: Gpu;

  beforeAll(async () => { gpu = await createDevice(); });
  afterAll(() => gpu?.device.destroy());

  async function renderer(size: number, env: ReturnType<typeof bakeEnvironment>) {
    const r = new GameRenderer(gpu, 8, 8, 256, 100);
    await r.ready;
    r.setEnvironment(env.specular, env.brdf, env.mips);
    r.resize(size, size);
    r.setLights(new LightPool(8));
    return r;
  }

  async function draw(r: GameRenderer, target: GPUTexture, clear: Partial<ClearWater>, time: number, dt = 0): Promise<Pixels> {
    r.look = { ...r.look, clear };
    r.time = time;
    await r.prepare();
    gpu.device.pushErrorScope('validation');
    expect(r.frame(target.createView(), 'redraw', dt)).toBe(true);
    const error = await gpu.device.popErrorScope();
    expect(error?.message ?? null).toBeNull();
    return readPixels(gpu, target);
  }

  describe('on a flat sheet, toward a low sun', () => {
    const W = 192;
    const CAM: Cam = { position: [0, -12, 4], target: [0, 4, 0], fov: 40 };
    const SPARKLING: Partial<ClearWater> = { foamWidth: 0, glitter: 0, refraction: 0, caustics: 0, sparkles: 1, sparkleCut: 0.1 };
    let r: GameRenderer;
    let target: GPUTexture;

    beforeAll(async () => {
      const env = bakeEnvironment(gpu, 'daylight', { size: 32, mips: 3 });
      await env.samples;
      r = await renderer(W, env);
      target = gpu.device.createTexture({ size: [W, W], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      r.look = { ...r.look, shading: 'pbr', antialias: undefined, background: [0.02, 0.02, 0.03], occlusion: 0, sunColour: [1, 1, 1], sunDir: [0, 0.966, 0.26], ambient: 1, exposure: 0.25 };
      r.post = { ...DEFAULT_POST, bloom: 0, vignette: 0, grain: 0, tone: 'clamp' };
      r.economy = { ...FULL_ECONOMY, shadows: false };
      r.camera.near = 1; r.camera.far = 200;
      place(r, CAM);
      r.setStatic([sheet(96)]);
    });
    afterAll(() => { r?.dispose(); target?.destroy(); });

    /** Where the ray through a pixel's centre meets the still water's plane, from the camera as placed. */
    function onPlane(px: number, py: number): [number, number] {
      const [cx, cy, cz] = CAM.position;
      const f = CAM.target.map((t, i) => t - CAM.position[i]);
      const fl = Math.hypot(...f); f.forEach((_, i) => (f[i] /= fl));
      const right = [f[1], -f[0], 0]; const rl = Math.hypot(...right); right.forEach((_, i) => (right[i] /= rl));
      const up = [right[1] * f[2] - right[2] * f[1], right[2] * f[0] - right[0] * f[2], right[0] * f[1] - right[1] * f[0]];
      const t = Math.tan((CAM.fov / 2) * (Math.PI / 180));
      const nx = ((px + 0.5) / W) * 2 - 1, ny = 1 - ((py + 0.5) / W) * 2;
      const d = [0, 1, 2].map((i) => f[i] + right[i] * nx * t + up[i] * ny * t);
      const s = -cz / d[2];
      return [cx + d[0] * s, cy + d[1] * s];
    }
    /** Where a point of the still water's plane is on the screen, through the renderer's own view and projection. */
    function onScreen(x: number, y: number): [number, number] {
      const vp = r.camera.viewProjection;
      const c = [0, 1, 2, 3].map((row) => vp[row] * x + vp[4 + row] * y + vp[12 + row]);
      return [(c[0] / c[3] * 0.5 + 0.5) * W - 0.5, (0.5 - (c[1] / c[3]) * 0.5) * W - 0.5];
    }

    it('draws a drift of nought as the pinned lattice, to the pixel', async () => {
      const pinned = await draw(r, target, SPARKLING, 1.5);
      const nought = await draw(r, target, { ...SPARKLING, sparkleDrift: [0, 0] }, 1.5);
      expect(differing(nought, pinned)).toBe(0);
      await saveFrame('drift sheet pinned', pinned);
    });

    /** Each star seen in two frames a step apart, with where it moved to and where the drift says it should have. */
    async function moved(drift: [number, number], name: string) {
      const DT = 1 / 30;
      const clear = { ...SPARKLING, sparkleDrift: drift };
      const pairs: { actual: number; error: number }[] = [];
      for (const T of [1.5, 3.7, 6.1]) {
      const before = spots(await draw(r, target, clear, T), await draw(r, target, { ...clear, sparkles: 0 }, T), 30, 3);
      const after = await draw(r, target, clear, T + DT);
      if (T === 1.5) await saveFrame(`drift sheet ${name}`, after);
      const found = spots(after, await draw(r, target, { ...clear, sparkles: 0 }, T + DT), 30, 3);
      for (const a of before) {
        const [wx, wy] = onPlane(a.x, a.y);
        const [ex, ey] = onScreen(wx + drift[0] * DT, wy + drift[1] * DT);
        // the nearest star of the next frame to where this one should be, within a few pixels; a star that went out is skipped
        let best: Spot | null = null, bestD = 6;
        for (const b of found) { const d = Math.hypot(b.x - ex, b.y - ey); if (d < bestD) { best = b; bestD = d; } }
        if (best) pairs.push({ actual: Math.hypot(best.x - a.x, best.y - a.y), error: bestD });
      }
      }
      const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
      return { pairs: pairs.length, actual: mean(pairs.map((p) => p.actual)), error: mean(pairs.map((p) => p.error)) };
    }

    it('places the still plane on the screen where the renderer does, so the drift\'s projection is to be trusted', () => {
      for (const [px, py] of [[40, 150], [96, 120], [150, 100]]) {
        const [x, y] = onPlane(px, py);
        const [sx, sy] = onScreen(x, y);
        expect(Math.hypot(sx - px, sy - py), `the pixel (${px}, ${py}) through the plane and back`).toBeLessThan(0.5);
      }
    });

    it('moves each star a frame on by the drift\'s own projection, and not at all with the lattice pinned', async () => {
      const still = await moved([0, 0], 'still');
      const drifting = await moved([3, 2], 'drifting');
      console.log(`stars matched a frame apart: pinned ${still.pairs}, moving ${still.actual.toFixed(2)} px; drifting ${drifting.pairs}, moving ${drifting.actual.toFixed(2)} px, ${drifting.error.toFixed(2)} px off where the drift puts them`);
      expect(still.pairs, 'stars matched with the lattice pinned').toBeGreaterThan(8);
      expect(still.actual, 'a pinned star stays put, in pixels').toBeLessThan(0.5);
      expect(drifting.pairs, 'stars matched with the lattice drifting').toBeGreaterThan(8);
      expect(drifting.actual, 'a drifting star moves, in pixels a frame').toBeGreaterThan(1.5);
      expect(drifting.error, 'how far from where the drift puts it, in pixels').toBeLessThan(0.75);
    });
  });

  describe('on the lake, from the shore, filmed five seconds', () => {
    const W = 576, FPS = 30, SECONDS = 5, T0 = 2;
    // a star within this many pixels of where one was is that one: a pinned star moves under a fifth of a pixel, but a
    // blip of one frame has its centre read at the threshold's edge and wobbles by three. Dark this long between, it
    // has returned. A different star lighting by chance within the radius counts too (some eighty near stars each
    // claim fifty pixels of eighty thousand), so with the lattice drifting a few are counted that are no return: the
    // count is held as a share of the pinned lattice's, and not at nought
    const NEAR = 4, DARK = 0.4;
    // the near water, where ooerfish's films saw the blink: the rows from the lake's middle down to the shore
    const NEAR_FROM = 400;
    const DRIFT = 0.5, SWELL = 1.2;

    it('returns stars to their places with the lattice pinned, and not with it drifting half a unit a second', { timeout: 120_000 }, async () => {
      const env = bakeEnvironment(gpu, 'daylight', { size: 128, mips: 6 });
      await env.samples;
      const r = await renderer(W, env);
      const target = gpu.device.createTexture({ size: [W, W], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      r.camera.near = 0.5; r.camera.far = 400;
      const l = lake();
      r.look = { ...r.look, ...LAKE_LOOK, sunDir: [...LAKE_LOOK.sunDir], sunColour: [...LAKE_LOOK.sunColour], background: [...LAKE_LOOK.background], clear: LAKE_CLEAR } as typeof r.look;
      r.post = { ...DEFAULT_POST, vignette: 0, grain: 0, tone: 'soft' };
      r.economy = { ...FULL_ECONOMY, shadows: true };
      r.setSunShadow({ min: [-16, -16, -7], max: [16, 16, 9] });
      r.setShoreField(l.field);
      r.setStatic([...l.land, l.water]);
      place(r, VIEWS['lake shore']);
      const film = async (clear: Partial<ClearWater>, name: string) => {
        const frames: Spot[][] = [];
        for (let f = 0; f < FPS * SECONDS; f++) {
          const t = T0 + f / FPS;
          const none = await draw(r, target, { ...clear, sparkles: 0 }, t, 1 / FPS);
          const some = await draw(r, target, clear, t, 1 / FPS);
          await saveFrame(`drift lake ${name} ${String(f).padStart(4, '0')}`, some);
          frames.push(spots(some, none, 40));
        }
        const stars = track(frames, FPS, NEAR, DARK);
        const near = stars.filter((s) => s.y >= NEAR_FROM);
        const returns = (v: Star[]) => v.reduce((s, x) => s + x.returns, 0);
        console.log(`${name}: ${stars.length} stars, ${returns(stars)} returns in place, ${near.length} near stars with ${returns(near)} returns`);
        for (const s of near) for (const g of s.gaps) console.log(`  ${g}`);
        return { stars: stars.length, returns: returns(stars), nearStars: near.length, nearReturns: returns(near) };
      };
      const pinned = await film(LAKE_CLEAR, 'pinned');
      const drifting = await film({ ...LAKE_CLEAR, sparkleDrift: [Math.cos(SWELL) * DRIFT, Math.sin(SWELL) * DRIFT] }, 'drifting');
      r.dispose(); target.destroy();
      expect(pinned.nearStars, 'the instrument reached the near water: stars were seen there pinned').toBeGreaterThan(3);
      expect(drifting.nearStars, 'and drifting').toBeGreaterThan(3);
      expect(pinned.nearReturns, 'the blink: a pinned star returning in its place in the near water').toBeGreaterThan(2);
      expect(drifting.nearReturns, 'near returns drifting, against pinned').toBeLessThanOrEqual(pinned.nearReturns / 2);
      expect(drifting.returns, 'returns anywhere, against pinned').toBeLessThan(pinned.returns / 3);
    });
  });
});
