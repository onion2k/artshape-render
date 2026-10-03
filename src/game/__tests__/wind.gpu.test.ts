/**
 * The wind on the game renderer's particles, on a real device. A game that
 * sets none draws every particle as it did, to the pixel; smoke rides a wind
 * and drops hardly feel it; a lone particle goes where the update's own sum
 * says; the WGSL's air is the TypeScript's at a set of points; and the rungs,
 * `keep`, stepped time and a wind changed between frames each do what they
 * should.
 *
 * "As it did" is held two ways, as in `particlefog.gpu.test.ts`: in the run, a
 * wind set to nothing against none set, and against the code before the wind
 * by a hash of three scenes' pixels in `wind-golden.json`, written before the
 * change under the adapter's key and skipped, with a warning, where there is
 * none. `VITE_GOLDEN=1` writes this adapter's, and only on known-good code.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server } from '@vitest/browser/context';
import { createDevice, shader, type Gpu } from '../../gpu/context';
import { bakeEnvironment } from '../../render/env';
import { FULL_ECONOMY, GameRenderer } from '../renderer';
import { LightPool } from '../lights';
import type { Emit } from '../particles';
import { AIR_WGSL, WASH_CAPACITY, WASH_WGSL, airVelocity, washFollow, type Wash } from '../wash';
import { differing, readPixels, saveFrame, type Pixels } from './frame';

const SIZE = 193;
const GOLDEN = 'src/game/__tests__/wind-golden.json';
const WRITE_GOLDEN = !!import.meta.env.VITE_GOLDEN;
/** Frames of a sixtieth of a second a column is let drift for before it is read. */
const STEPS = 36;

/** A column of smoke at the middle of the frame, floating and rising. */
const SMOKE: Emit = { position: [0, 0, 0], velocity: [0, 0, 60], spread: 25, count: 300, life: 3, size: 12, colour: [1, 1, 1], alpha: 0.9, gravity: 0 };
/** The same burst as drops, which fall. */
const DROPS: Emit = { ...SMOKE, gravity: 1 };
/** Air from above the column, as in the wash's tests. */
const WASH: Wash = { position: [0, 0, 100], radius: 40, speed: 400, reach: 160 };
const WIND: [number, number, number] = [150, 0, 0];

function fnv(p: Pixels): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < p.rgb.length; i++) h = Math.imul(h ^ p.rgb[i], 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** Where the light is: its mean column and row, in pixels, and how much of it there is. */
function where(p: Pixels) {
  let sum = 0, sx = 0, sy = 0;
  for (let y = 0; y < p.height; y++)
    for (let x = 0; x < p.width; x++) {
      const i = (y * p.width + x) * 3;
      const l = p.rgb[i] + p.rgb[i + 1] + p.rgb[i + 2];
      sum += l; sx += l * x; sy += l * y;
    }
  return { light: sum, cx: sx / sum, cy: sy / sum };
}

describe('the wind on the game renderer', () => {
  let gpu: Gpu;
  let env: { specular: GPUTexture; brdf: GPUTexture; mips: number };
  const made: { r: GameRenderer; target: GPUTexture }[] = [];

  beforeAll(async () => {
    gpu = await createDevice();
    const baked = bakeEnvironment(gpu, 'studio', { size: 32, mips: 3 });
    await baked.samples;
    env = baked;
  });
  afterAll(() => {
    for (const x of made) { x.r.dispose(); x.target.destroy(); }
    gpu?.device.destroy();
  });

  interface Options { mm?: number; msaa?: boolean }

  /** A renderer over black, ready to draw what is emitted into it. */
  async function make(o: Options = {}) {
    const u = 1 / (o.mm ?? 1);
    const r = new GameRenderer(gpu, 8, 8, 4096, o.mm ?? 1);
    await r.ready;
    const target = gpu.device.createTexture({ size: [SIZE, SIZE], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    made.push({ r, target });
    r.setEnvironment(env.specular, env.brdf, env.mips);
    r.resize(SIZE, SIZE);
    r.setStatic([]);
    r.setDynamic([]);
    r.setLights(new LightPool(8));
    r.look = { ...r.look, ambient: 0, sunColour: [0, 0, 0], background: [0, 0, 0], ...(o.msaa ? { antialias: 'msaa' as const } : {}) };
    r.camera.position = [0, -400 * u, 200 * u];
    r.camera.target = [0, 0, 0];
    r.gravity = 40 * u;
    await r.prepare();
    return { r, target, view: target.createView(), u };
  }
  type Scene = Awaited<ReturnType<typeof make>>;

  const frames = (s: Scene, n: number, mode: 'redraw' | 'keep' = 'redraw') => { for (let i = 0; i < n; i++) s.r.frame(s.view, mode, 1 / 60); };

  /** `emits` on the first frame, then `STEPS` frames, read: after `setup` has set what it sets. */
  async function draw(emits: Emit[], setup: (r: GameRenderer) => void = () => {}, o: Options = {}, mode: 'redraw' | 'keep' = 'redraw', steps = STEPS): Promise<Pixels> {
    const s = await make(o);
    setup(s.r);
    for (const e of emits) s.r.emit(e);
    frames(s, steps, mode);
    return readPixels(gpu, s.target);
  }

  describe('a game that sets none', () => {
    const SCENES = ['plain', 'keep', 'msaa'] as const;
    const scene = (kind: (typeof SCENES)[number], wind?: [number, number, number]) =>
      draw([SMOKE, DROPS, { ...SMOKE, position: [40, 0, 0], gravity: 0.5, colour: [1, 0.5, 0.2] }], (r) => { if (wind) r.setWind(wind); r.setWash([{ ...WASH, position: [-60, 0, 100] }]); }, { msaa: kind === 'msaa' }, kind === 'keep' ? 'keep' : 'redraw');

    it('draws the same to the pixel with a wind of nothing, one set and unset, and none at all', async () => {
      for (const kind of SCENES) {
        const none = await scene(kind);
        expect(differing(none, await scene(kind, [0, 0, 0])), `${kind}, zero`).toBe(0);
        const back = await draw([SMOKE, DROPS, { ...SMOKE, position: [40, 0, 0], gravity: 0.5, colour: [1, 0.5, 0.2] }], (r) => { r.setWind(WIND); r.setWind([0, 0, 0]); r.setWash([{ ...WASH, position: [-60, 0, 100] }]); }, { msaa: kind === 'msaa' }, kind === 'keep' ? 'keep' : 'redraw');
        expect(differing(none, back), `${kind}, set and unset`).toBe(0);
      }
    });

    it('draws the same pixels as the code before the wind did, on an adapter with a record of them', async (ctx) => {
      const key = gpu.adapter.key;
      const found: Record<string, string> = {};
      for (const kind of SCENES) {
        const p = await scene(kind);
        await saveFrame(`wind-none-${kind}`, p);
        found[kind] = fnv(p);
      }
      const file = await server.commands.readFile(GOLDEN).catch(() => '');
      const all = file.trim() ? (JSON.parse(file) as Record<string, Record<string, string>>) : {};
      if (WRITE_GOLDEN) {
        all[key] = found;
        await server.commands.writeFile(GOLDEN, JSON.stringify(all, null, 2) + '\n');
        return;
      }
      if (!all[key]) { console.warn(`wind: no pixels from before the wind are kept for ${key}, so nothing was held to them`); return ctx.skip(); }
      expect(found).toEqual(all[key]);
    });
  });

  describe('a wind', () => {
    it('carries a rising column of smoke downwind, and the other way for the other way', async () => {
      const still = where(await draw([SMOKE]));
      const east = await draw([SMOKE], (r) => r.setWind(WIND));
      await saveFrame('wind-smoke', east);
      const e = where(east);
      const w = where(await draw([SMOKE], (r) => r.setWind([-WIND[0], 0, 0])));
      expect(e.light).toBeGreaterThan(5000);
      // a column that drifts a few tens of pixels in a bit over half a second
      expect(e.cx - still.cx).toBeGreaterThan(20);
      expect(still.cx - w.cx).toBeGreaterThan(20);
      expect(Math.abs((e.cx - still.cx) - (still.cx - w.cx))).toBeLessThan(1);
      expect(Math.abs(e.cy - still.cy)).toBeLessThan(2);
    });

    it('lifts a column with a wind that blows up', async () => {
      const still = where(await draw([SMOKE]));
      const up = where(await draw([SMOKE], (r) => r.setWind([0, 0, 120])));
      expect(still.cy - up.cy).toBeGreaterThan(10);
    });

    it('hardly moves falling drops, beside what it does to smoke', async () => {
      const smoke = where(await draw([SMOKE], (r) => r.setWind(WIND))).cx - where(await draw([SMOKE])).cx;
      const drops = where(await draw([DROPS], (r) => r.setWind(WIND))).cx - where(await draw([DROPS])).cx;
      expect(smoke).toBeGreaterThan(20);
      expect(drops).toBeGreaterThan(0);
      expect(drops).toBeLessThan(smoke * 0.2);
    });

    it('goes where the update\'s own sum puts a lone particle, with the wash\'s air on top', async () => {
      const g = 40, drag = 2.4, dt = 1 / 60;
      const wind: [number, number, number] = [60, -20, 30];
      for (const gravity of [0, 0.5, 1]) {
        const lone: Emit = { ...SMOKE, count: 1, spread: 0, velocity: [10, 0, 40], gravity };
        // the particle at the update's own arithmetic: the drag toward the air, then gravity, then the move
        let x = 0, y = 0, z = 0, vx = 10, vy = 0, vz = 40;
        const washes: Wash[] = [{ ...WASH, position: [0, 0, 400] }];
        for (let i = 0; i < STEPS; i++) {
          const d = drag * (0.15 + 0.85 * (1 - Math.min(1, Math.max(0, gravity))));
          const f = Math.exp(-d * dt), k = washFollow(gravity) * (1 - f);
          const air = airVelocity(wind, washes, [x, y, z], 0.5);
          vx = vx * f + air[0] * k; vy = vy * f + air[1] * k; vz = vz * f + air[2] * k;
          vz -= g * gravity * dt;
          x += vx * dt; y += vy * dt; z += vz * dt;
        }
        const still: Emit = { ...lone, position: [x, y, z], velocity: [0, 0, 0], gravity: 0 };
        const setup = (r: GameRenderer) => { r.gravity = g; };
        const moved = where(await draw([lone], (r) => { setup(r); r.setWind(wind); r.setWash(washes); }));
        const placed = where(await draw([still], setup, {}, 'redraw', 1));
        // the still particle is placed at its place and drawn for one frame, as old as the other is not: only its position is compared
        expect(Math.abs(moved.cx - placed.cx), `gravity ${gravity} x`).toBeLessThan(0.1);
        expect(Math.abs(moved.cy - placed.cy), `gravity ${gravity} y`).toBeLessThan(0.1);
        const wrong = where(await draw([{ ...still, position: [x + 1.5, y, z] }], setup, {}, 'redraw', 1));
        expect(Math.abs(wrong.cx - placed.cx)).toBeGreaterThan(0.5);
      }
    });

    it('blows with the wash\'s air, and on top of it', async () => {
      const washed = where(await draw([SMOKE], (r) => r.setWash([WASH])));
      const both = where(await draw([SMOKE], (r) => { r.setWash([WASH]); r.setWind(WIND); }));
      expect(both.cx - washed.cx).toBeGreaterThan(15);
    });

    it('is kept until set again, and a change between frames is blown on the next one', async () => {
      const a = await make(), b = await make();
      for (const s of [a, b]) { s.r.emit(SMOKE); frames(s, 10); }
      const before = await readPixels(gpu, a.target);
      expect(differing(before, await readPixels(gpu, b.target))).toBe(0);
      a.r.setWind(WIND);
      frames(a, 1); frames(b, 1);
      const pa = where(await readPixels(gpu, a.target)), pb = where(await readPixels(gpu, b.target));
      expect(pa.cx - pb.cx).toBeGreaterThan(0.05);
      // kept: no more is set, and it goes on blowing
      frames(a, 25); frames(b, 25);
      const later = where(await readPixels(gpu, a.target)).cx - where(await readPixels(gpu, b.target)).cx;
      expect(later).toBeGreaterThan(15);
      // and set to nothing again, it stops pulling: what it had given the smoke carries on a little, and no more is added
      const c = await make();
      c.r.emit(SMOKE); frames(c, 10); c.r.setWind(WIND); frames(c, 1 + 25);
      a.r.setWind([0, 0, 0]);
      frames(a, 30); frames(b, 30); frames(c, 30);
      const x = async (s: Scene) => where(await readPixels(gpu, s.target)).cx;
      const [xa, xb, xc] = [await x(a), await x(b), await x(c)];
      expect(xc - xa).toBeGreaterThan(8);
      expect(xa - xb).toBeGreaterThan(20);
    });

    it('is the same picture twice from the same steps, in a redrawn frame and a kept one', async () => {
      const a = await draw([SMOKE, DROPS], (r) => r.setWind(WIND));
      expect(differing(a, await draw([SMOKE, DROPS], (r) => r.setWind(WIND)))).toBe(0);
      expect(differing(a, await draw([SMOKE, DROPS], (r) => r.setWind(WIND), {}, 'keep'))).toBe(0);
      const msaa = where(await draw([SMOKE], (r) => r.setWind(WIND), { msaa: true })).cx - where(await draw([SMOKE], () => {}, { msaa: true })).cx;
      expect(msaa).toBeGreaterThan(20);
    });

    it('does no work, and moves nothing, with the particles rung off, and is the same column when it is back on', async () => {
      const s = await make();
      s.r.setWind(WIND);
      s.r.emit(SMOKE);
      frames(s, 1);
      s.r.economy = { ...FULL_ECONOMY, particles: false };
      frames(s, 10);
      expect(where(await readPixels(gpu, s.target)).light).toBe(0);
      s.r.economy = { ...FULL_ECONOMY, particles: true };
      frames(s, STEPS - 1);
      const back = where(await readPixels(gpu, s.target));
      const straight = where(await draw([SMOKE], (r) => r.setWind(WIND)));
      expect(Math.abs(back.cx - straight.cx)).toBeLessThan(0.1);
      expect(Math.abs(back.light / straight.light - 1)).toBeLessThan(0.01);
    });

    it('is the wind of the world\'s own units: the same scene a hundred times smaller drifts the same', async () => {
      const k = 1 / 100;
      const big = where(await draw([SMOKE], (r) => r.setWind(WIND))).cx - where(await draw([SMOKE])).cx;
      const scaled = (e: Emit): Emit => ({ ...e, position: e.position.map((v) => v * k) as [number, number, number], velocity: e.velocity.map((v) => v * k) as [number, number, number], spread: e.spread * k, size: e.size * k });
      const small = where(await draw([scaled(SMOKE)], (r) => r.setWind(WIND.map((v) => v * k) as [number, number, number]), { mm: 100 })).cx - where(await draw([scaled(SMOKE)], () => {}, { mm: 100 })).cx;
      expect(Math.abs(small - big)).toBeLessThan(2);
    });
  });

  describe('the air', () => {
    it('is the same in the WGSL as in the TypeScript, at a set of points', async () => {
      const washes: Wash[] = [WASH, { position: [30, -20, 140], radius: 15, speed: 220, reach: 120 }];
      const winds: [number, number, number][] = [[0, 0, 0], [40, -25, 12], [-300, 80, -50]];
      const points: [number, number, number][] = [
        [0, 0, 60], [0, 0, 100], [8, 0, 90], [8, 0, -70], [15, 0, 80], [25, 0, 0], [30, -20, 100], [35, -25, 60],
        [0, 0, -400], [100, 100, 50], [12, -7, 30], [-33, 40, -20],
      ];
      const eps = 0.5;
      const packed = new Float32Array(WASH_CAPACITY * 8);
      washes.forEach((w, i) => packed.set([...w.position, w.radius, w.speed, w.reach, 0, 0], i * 8));
      const { device } = gpu;
      const module = shader(device, `
        @group(0) @binding(0) var<uniform> washes: array<vec4f, ${WASH_CAPACITY * 2}>;
        @group(0) @binding(1) var<storage, read> points: array<vec4f>;
        @group(0) @binding(2) var<storage, read_write> result: array<vec4f>;
        @group(0) @binding(3) var<uniform> settings: vec4f;
        @group(0) @binding(4) var<uniform> winds: array<vec4f, 3>;
        ${WASH_WGSL}
        ${AIR_WGSL}
        @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
          let p = points[id.x];
          result[id.x] = vec4f(airAt(p.xyz, u32(settings.x), settings.y, winds[u32(p.w)].xyz), 0.0);
        }`, 'air probe');
      const pipe = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
      const buf = (data: Float32Array<ArrayBuffer>, usage: number) => {
        const b = device.createBuffer({ size: Math.max(16, data.byteLength), usage: usage | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(b, 0, data);
        return b;
      };
      const pts = new Float32Array(points.length * 4);
      points.forEach((p, i) => pts.set([...p, i % 3], i * 4));
      const wb = buf(packed, GPUBufferUsage.UNIFORM);
      const pb = buf(pts, GPUBufferUsage.STORAGE);
      const out = device.createBuffer({ size: pts.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const sb = buf(new Float32Array([washes.length, eps, 0, 0]), GPUBufferUsage.UNIFORM);
      const nb = buf(new Float32Array(winds.flatMap((w) => [...w, 0])), GPUBufferUsage.UNIFORM);
      const read = device.createBuffer({ size: pts.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const bind = device.createBindGroup({
        layout: pipe.getBindGroupLayout(0),
        entries: [wb, pb, out, sb, nb].map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipe); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(points.length); pass.end();
      enc.copyBufferToBuffer(out, 0, read, 0, pts.byteLength);
      device.queue.submit([enc.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const got = new Float32Array(read.getMappedRange().slice(0));
      read.unmap();
      for (const b of [wb, pb, out, sb, nb, read]) b.destroy();
      let blowing = 0;
      points.forEach((p, i) => {
        const want = airVelocity(winds[i % 3], washes, p, eps);
        if (Math.hypot(...want) > 1) blowing++;
        for (let k = 0; k < 3; k++) expect(got[i * 4 + k], `point ${i} ${p} component ${k}`).toBeCloseTo(want[k], 3);
      });
      // the check is not run over air that is nothing everywhere
      expect(blowing).toBeGreaterThan(8);
    });
  });
});
