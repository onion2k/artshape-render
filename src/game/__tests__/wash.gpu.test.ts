/**
 * The particles' wash and their colour over life, on a real device. A game
 * that sets neither draws the same pixels it always did; a wash pushes smoke
 * down and out and hardly moves drops; a fade turns red to blue as the
 * particle ages; and the WGSL's field is the TypeScript's, at a set of points.
 *
 * Every picture is drawn by a renderer of its own, so that the pool's ring and
 * the burst's seed begin the same each time and two pictures can be compared
 * to the pixel. `VITE_FRAME_DIR=/some/dir npm run test:gpu` writes them out.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevice, shader, type Gpu } from '../../gpu/context';
import { bakeEnvironment } from '../../render/env';
import { GameRenderer } from '../renderer';
import { LightPool } from '../lights';
import type { Emit } from '../particles';
import { WASH_CAPACITY, WASH_WGSL, washFollow, washVelocity, type Wash } from '../wash';
import { differing, readPixels, saveFrame, type Pixels } from './frame';

const SIZE = 192;

/** A column of smoke at the middle of the frame, rising. */
const SMOKE: Emit = { position: [0, 0, 0], velocity: [0, 0, 60], spread: 25, count: 300, life: 3, size: 12, colour: [1, 1, 1], alpha: 0.9, gravity: 0 };
/** The same burst as drops, which fall. */
const DROPS: Emit = { ...SMOKE, gravity: 1 };
/** Air from above the column, wide enough to take all of it. */
const WASH: Wash = { position: [0, 0, 100], radius: 40, speed: 400, reach: 160 };
/** Frames of a sixtieth of a second a column is let rise or fall for before it is read. */
const STEPS = 36;

describe('the wash and the fade on the game renderer', () => {
  let gpu: Gpu;
  let env: { specular: GPUTexture; brdf: GPUTexture; mips: number };

  beforeAll(async () => {
    gpu = await createDevice();
    const baked = bakeEnvironment(gpu, 'studio', { size: 32, mips: 3 });
    await baked.samples;
    env = baked;
  });
  afterAll(() => { gpu?.device.destroy(); });

  interface Options {
    mmPerUnit?: number;
    msaa?: boolean;
    mode?: 'redraw' | 'keep';
  }

  /** A renderer over black, ready to draw what is emitted into it. */
  async function make(o: Options = {}) {
    const r = new GameRenderer(gpu, 8, 8, 4096, o.mmPerUnit ?? 1);
    await r.ready;
    const target = gpu.device.createTexture({ size: [SIZE, SIZE], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    r.setEnvironment(env.specular, env.brdf, env.mips);
    r.resize(SIZE, SIZE);
    r.setStatic([]);
    r.setDynamic([]);
    r.setLights(new LightPool(8));
    r.look = { ...r.look, ambient: 0, sunColour: [0, 0, 0], background: [0, 0, 0], ...(o.msaa ? { antialias: 'msaa' as const } : {}) };
    r.camera.position = [0, -400, 200];
    r.camera.target = [0, 0, 0];
    r.gravity = 981;
    if (o.msaa) await r.prepare();
    return { r, target, view: target.createView() };
  }

  /** Draw: `emits` on the first frame, then `steps` frames of a sixtieth, and read the last. */
  async function draw(emits: Emit[], setup: (r: GameRenderer) => void = () => {}, o: Options = {}, steps = STEPS): Promise<Pixels> {
    const { r, target, view } = await make(o);
    setup(r);
    for (const e of emits) r.emit(e);
    for (let i = 0; i < steps; i++) r.frame(view, o.mode ?? 'redraw', 1 / 60);
    const p = await readPixels(gpu, target);
    r.dispose();
    target.destroy();
    return p;
  }

  /** Where the light is: its mean row and column, and how widely it is spread across, in pixels. */
  function where(p: Pixels) {
    let sum = 0, sx = 0, sy = 0, sxx = 0;
    for (let y = 0; y < p.height; y++)
      for (let x = 0; x < p.width; x++) {
        const i = (y * p.width + x) * 3;
        const l = p.rgb[i] + p.rgb[i + 1] + p.rgb[i + 2];
        sum += l; sx += l * x; sy += l * y; sxx += l * x * x;
      }
    const cx = sx / sum;
    return { light: sum, cx, cy: sy / sum, spreadX: Math.sqrt(sxx / sum - cx * cx) };
  }

  /** The share of the light that is blue, over the pixels that are lit at all. */
  function blueness(p: Pixels) {
    let r = 0, b = 0;
    for (let i = 0; i < p.rgb.length; i += 3) { r += p.rgb[i]; b += p.rgb[i + 2]; }
    return { light: r + b, blue: b / (r + b) };
  }

  describe('nothing asked', () => {
    it('draws a column the same with no wash, an empty one, one that says nothing, and one the column never reaches', async () => {
      const plain = await draw([SMOKE]);
      await saveFrame('wash-none', plain);
      expect(where(plain).light).toBeGreaterThan(5000);
      const away: Wash = { ...WASH, position: [300, 0, 100] };
      const quiet: Wash = { ...WASH, speed: 0 };
      for (const [name, washes] of [['empty', []], ['zero speed', [quiet]], ['elsewhere', [away]]] as const) {
        const p = await draw([SMOKE], (r) => r.setWash(washes));
        expect(differing(plain, p), name).toBe(0);
      }
    });

    it('moves a particle exactly as the update always did, wash or no wash', async () => {
      // Two renderers in step cannot show an update that has changed for both,
      // so each particle is held to where its own arithmetic puts it: a lone
      // particle drag and gravity have worked on for the steps, against one
      // placed there to begin with and left still, the same age and the same size.
      const g = 40, drag = 2.4, dt = 1 / 60;
      const lone = (gravity: number): Emit => ({ ...SMOKE, count: 1, spread: 0, velocity: [30, 0, 60], gravity });
      for (const gravity of [0, 1]) {
        let x = 0, z = 0, vx = 30, vz = 60;
                for (let i = 0; i < STEPS; i++) {
          const f = Math.exp(-drag * (gravity > 0 ? 0.15 : 1) * dt);
          vx *= f; vz = vz * f - g * gravity * dt;
          x += vx * dt; z += vz * dt;
        }
        const still: Emit = { ...lone(0), position: [x, 0, z], velocity: [0, 0, 0] };
        const slow = (r: GameRenderer) => { r.gravity = g; };
        const moved = where(await draw([lone(gravity)], slow));
        const placed = where(await draw([still], slow));
        for (const washes of [[], [{ ...WASH, speed: 0 }], [{ ...WASH, position: [300, 0, 100] }]] as Wash[][]) {
          const m = where(await draw([lone(gravity)], (r) => { slow(r); r.setWash(washes); }));
          expect(Math.abs(m.cx - placed.cx), `gravity ${gravity} x`).toBeLessThan(0.05);
          expect(Math.abs(m.cy - placed.cy), `gravity ${gravity} y`).toBeLessThan(0.05);
        }
        expect(Math.abs(moved.cy - placed.cy)).toBeLessThan(0.05);
        // and the check can tell a particle that went elsewhere from one that went there
        const wrong = where(await draw([{ ...still, position: [x, 0, z + 1] }], slow));
        expect(Math.abs(wrong.cy - placed.cy)).toBeGreaterThan(0.5);
      }
    });

    it('draws drops, sparks and a fade-free burst the same with a wash set that they are not under', async () => {
      const sparks: Emit = { ...SMOKE, alpha: 0, colour: [1, 0.6, 0.1], gravity: 1, size: 4, spread: 60 };
      const away: Wash = { ...WASH, position: [300, 0, 100] };
      for (const e of [DROPS, sparks]) {
        const plain = await draw([e]);
        const p = await draw([e], (r) => r.setWash([away]));
        expect(differing(plain, p)).toBe(0);
      }
    });

    it('draws a burst with no fade as it was, whatever the colour is', async () => {
      const a = await draw([SMOKE]);
      const b = await draw([{ ...SMOKE, fade: undefined }]);
      expect(differing(a, b)).toBe(0);
    });

    it('draws the same frames at four samples a pixel', async () => {
      const plain = await draw([SMOKE], () => {}, { msaa: true });
      const empty = await draw([SMOKE], (r) => r.setWash([]), { msaa: true });
      const quiet = await draw([SMOKE], (r) => r.setWash([{ ...WASH, speed: 0 }]), { msaa: true });
      expect(differing(plain, empty)).toBe(0);
      expect(differing(plain, quiet)).toBe(0);
    });
  });

  describe('a wash', () => {
    it('pushes a column of smoke down and out', async () => {
      const plain = where(await draw([SMOKE]));
      const washed = await draw([SMOKE], (r) => r.setWash([WASH]));
      await saveFrame('wash-smoke', washed);
      const w = where(washed);
      // a row is a pixel down the frame
      expect(w.cy - plain.cy).toBeGreaterThan(10);
      expect(w.spreadX).toBeGreaterThan(plain.spreadX * 1.15);
    });

    it('hardly moves drops, which fall, beside what it does to smoke', async () => {
      // a gravity small enough that the drops are still in the frame at the end, where at the world's own they would have left it
      const slow = (r: GameRenderer) => { r.gravity = 40; };
      const drops = where(await draw([DROPS], slow)).cy;
      const dropsWashed = where(await draw([DROPS], (r) => { slow(r); r.setWash([WASH]); })).cy;
      const smoke = where(await draw([SMOKE], slow)).cy;
      const smokeWashed = where(await draw([SMOKE], (r) => { slow(r); r.setWash([WASH]); })).cy;
      const smokeMoved = smokeWashed - smoke, dropsMoved = dropsWashed - drops;
      expect(smokeMoved).toBeGreaterThan(10);
      expect(dropsMoved).toBeGreaterThan(0);
      expect(dropsMoved).toBeLessThan(smokeMoved * 0.25);
    });

    it('is the sum of washes, and the one with the nearer source pushes more', async () => {
      const one = where(await draw([SMOKE], (r) => r.setWash([WASH]))).cy;
      const two = where(await draw([SMOKE], (r) => r.setWash([WASH, { ...WASH, position: [5, 0, 100] }]))).cy;
      expect(two).toBeGreaterThan(one);
    });

    it('is the same picture twice from the same steps, and is kept until it is set again', async () => {
      const a = await draw([SMOKE], (r) => r.setWash([WASH]));
      const b = await draw([SMOKE], (r) => r.setWash([WASH]));
      expect(differing(a, b)).toBe(0);
      // set once, it blows on every frame after: set to nothing again, it stops
      const { r, target, view } = await make();
      r.setWash([WASH]);
      r.emit(SMOKE);
      for (let i = 0; i < STEPS; i++) r.frame(view, 'redraw', 1 / 60);
      const kept = where(await readPixels(gpu, target)).cy;
      r.dispose(); target.destroy();
      expect(kept).toBeCloseTo(where(a).cy, 6);
      const off = await draw([SMOKE], (r2) => { r2.setWash([WASH]); r2.setWash([]); });
      expect(differing(off, await draw([SMOKE]))).toBe(0);
    });

    it('works in the kept frame as in a redrawn one', async () => {
      const plain = where(await draw([SMOKE], () => {}, { mode: 'keep' })).cy;
      const washed = where(await draw([SMOKE], (r) => r.setWash([WASH]), { mode: 'keep' })).cy;
      expect(washed - plain).toBeGreaterThan(10);
      const redrawn = await draw([SMOKE], (r) => r.setWash([WASH]));
      const kept = await draw([SMOKE], (r) => r.setWash([WASH]), { mode: 'keep' });
      expect(differing(redrawn, kept)).toBe(0);
    });

    it('works at four samples a pixel', async () => {
      const plain = where(await draw([SMOKE], () => {}, { msaa: true })).cy;
      const washed = where(await draw([SMOKE], (r) => r.setWash([WASH]), { msaa: true })).cy;
      expect(washed - plain).toBeGreaterThan(10);
    });

    it('does no work, and moves nothing, with the particles rung off, and is the same frame after it is back on', async () => {
      const { r, target, view } = await make();
      r.setWash([WASH]);
      r.emit(SMOKE);
      r.frame(view, 'redraw', 1 / 60);
      r.economy = { ...r.economy, particles: false };
      for (let i = 0; i < 10; i++) r.frame(view, 'redraw', 1 / 60);
      expect(where(await readPixels(gpu, target)).light).toBe(0);
      r.economy = { ...r.economy, particles: true };
      for (let i = 0; i < STEPS - 1; i++) r.frame(view, 'redraw', 1 / 60);
      const back = await readPixels(gpu, target);
      r.dispose(); target.destroy();
      // not to the pixel: the frame's own count and time reach the grain, and the off frames were counted
      const straight = where(await draw([SMOKE], (r2) => r2.setWash([WASH])));
      const b = where(back);
      expect(Math.abs(b.cy - straight.cy)).toBeLessThan(0.05);
      expect(Math.abs(b.spreadX - straight.spreadX)).toBeLessThan(0.05);
      expect(Math.abs(b.light / straight.light - 1)).toBeLessThan(0.01);
    });

    it('takes the capacity of washes and drops the rest, saying so', async () => {
      const { r, target } = await make();
      expect(r.setWash([])).toBe(true);
      expect(r.setWash(Array.from({ length: WASH_CAPACITY }, () => WASH))).toBe(true);
      expect(r.setWash(Array.from({ length: WASH_CAPACITY + 1 }, () => WASH))).toBe(false);
      r.dispose(); target.destroy();
      // the fifth and sixth are the only ones over the column, and never blow
      const away: Wash = { ...WASH, position: [300, 0, 100] };
      const plain = await draw([SMOKE]);
      const six = await draw([SMOKE], (r2) => r2.setWash([away, away, away, away, WASH, WASH]));
      expect(differing(plain, six)).toBe(0);
      const fourth = await draw([SMOKE], (r2) => r2.setWash([away, away, away, WASH, WASH]));
      expect(where(fourth).cy - where(plain).cy).toBeGreaterThan(10);
    });

    it('keeps the length of its epsilon in millimetres, whatever the world\'s unit', async () => {
      const mm = await make();
      const m = await make({ mmPerUnit: 100 });
      expect(mm.r.particles.washEpsilon).toBeCloseTo(m.r.particles.washEpsilon * 100, 9);
      for (const x of [mm, m]) { x.r.dispose(); x.target.destroy(); }
    });

    it('is the wash of the world\'s own units: the same scene a hundred times smaller is the same picture', async () => {
      const k = 1 / 100;
      const scaled = (e: Emit): Emit => ({ ...e, position: e.position.map((v) => v * k) as [number, number, number], velocity: e.velocity.map((v) => v * k) as [number, number, number], spread: e.spread * k, size: e.size * k });
      const w: Wash = { position: WASH.position.map((v) => v * k) as [number, number, number], radius: WASH.radius * k, speed: WASH.speed * k, reach: WASH.reach * k };
      const big = await draw([SMOKE], (r) => r.setWash([WASH]));
      const { r, target, view } = await make({ mmPerUnit: 100 });
      r.camera.position = [0, -4, 2];
      r.gravity = 9.81;
      r.setWash([w]);
      r.emit(scaled(SMOKE));
      for (let i = 0; i < STEPS; i++) r.frame(view, 'redraw', 1 / 60);
      const small = await readPixels(gpu, target);
      r.dispose(); target.destroy();
      // clip planes and the hash-drawn spread differ with the unit; the picture's middle is what must agree
      expect(Math.abs(where(small).cy - where(big).cy)).toBeLessThan(2);
    });

    it('is dropped with the pool: its buffer is destroyed', async () => {
      const { r, target } = await make();
      const buffer = (r.particles as unknown as { washBuffer: GPUBuffer }).washBuffer;
      r.dispose();
      gpu.device.pushErrorScope('validation');
      gpu.device.queue.writeBuffer(buffer, 0, new Float32Array(4));
      const error = await gpu.device.popErrorScope();
      target.destroy();
      expect(error).not.toBeNull();
    });
  });

  describe('a fade', () => {
    /** Particles of the same colour at every age, drifting nowhere, read at two stepped times. */
    const RED_TO_BLUE: Emit = { ...SMOKE, velocity: [0, 0, 0], spread: 30, life: 2, colour: [1, 0, 0], fade: [0, 0, 1], count: 200, alpha: 0.9 };

    it('turns a red particle bluer as it ages', async () => {
      const early = await draw([RED_TO_BLUE], () => {}, {}, 18);
      const late = await draw([RED_TO_BLUE], () => {}, {}, 84);
      await saveFrame('fade-early', early);
      await saveFrame('fade-late', late);
      expect(blueness(early).light).toBeGreaterThan(2000);
      expect(blueness(late).light).toBeGreaterThan(500);
      expect(blueness(early).blue).toBeLessThan(0.4);
      expect(blueness(late).blue).toBeGreaterThan(0.6);
    });

    it('keeps its colour for life when it has no fade', async () => {
      const plain = { ...RED_TO_BLUE, fade: undefined };
      const early = await draw([plain], () => {}, {}, 18);
      const late = await draw([plain], () => {}, {}, 84);
      // the post chain's grain leaves a hair of blue on a red frame, and never more than that
      expect(blueness(early).blue).toBeLessThan(0.02);
      expect(blueness(late).blue).toBeLessThan(0.02);
    });

    it('fades the additive kind as well as the translucent', async () => {
      const spark: Emit = { ...RED_TO_BLUE, alpha: 0 };
      const early = blueness(await draw([spark], () => {}, {}, 18));
      const late = blueness(await draw([spark], () => {}, {}, 84));
      expect(late.blue).toBeGreaterThan(early.blue + 0.2);
    });

    it('fades each burst by its own colours, in one frame', async () => {
      const left: Emit = { ...RED_TO_BLUE, position: [-60, 0, 0], colour: [1, 0, 0], fade: [0, 0, 1] };
      const right: Emit = { ...RED_TO_BLUE, position: [60, 0, 0], colour: [1, 0, 0], fade: undefined };
      const p = await draw([left, right], () => {}, {}, 84);
      const half = (x0: number, x1: number) => {
        let r = 0, b = 0;
        for (let y = 0; y < p.height; y++) for (let x = x0; x < x1; x++) { const i = (y * p.width + x) * 3; r += p.rgb[i]; b += p.rgb[i + 2]; }
        return { r, b };
      };
      const l = half(0, SIZE / 2), rt = half(SIZE / 2, SIZE);
      expect(l.b).toBeGreaterThan(l.r);
      expect(rt.b).toBeLessThan(rt.r * 0.02);
      expect(rt.r).toBeGreaterThan(0);
    });
  });

  describe('the field', () => {
    it('is the same in the WGSL as in the TypeScript, at a set of points', async () => {
      const washes: Wash[] = [
        WASH,
        { position: [30, -20, 140], radius: 15, speed: 220, reach: 120 },
        { position: [-40, 25, 60], radius: 60, speed: -80, reach: 300 },
      ];
      const points: [number, number, number][] = [
        [0, 0, 60], [0, 0, 100], [0, 0, 101], [8, 0, 90], [8, 0, -70], [-8, 3, -70], [15, 0, 80], [25, 0, 0],
        [30, -20, 100], [35, -25, 60], [30, -20, 20], [-40, 25, 0], [-20, 25, 0], [0, 0, -140], [0, 0, -400],
        [20, 0, 100], [100, 100, 50], [12, -7, 30], [0.001, 0, 90], [-33, 40, -20],
      ];
      const eps = 0.5;
      // the third is a speed below nothing, which the packer leaves out, so the shader is told of two
      const packed = new Float32Array(WASH_CAPACITY * 8);
      const kept = washes.filter((w) => w.speed > 0);
      kept.forEach((w, i) => packed.set([...w.position, w.radius, w.speed, w.reach, 0, 0], i * 8));
      const { device } = gpu;
      const module = shader(device, `
        @group(0) @binding(0) var<uniform> washes: array<vec4f, ${WASH_CAPACITY * 2}>;
        @group(0) @binding(1) var<storage, read> points: array<vec4f>;
        @group(0) @binding(2) var<storage, read_write> result: array<vec4f>;
        @group(0) @binding(3) var<uniform> settings: vec4f;
        ${WASH_WGSL}
        @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
          let p = points[id.x];
          result[id.x] = vec4f(washAt(p.xyz, u32(settings.x), settings.y), washFollow(p.w));
        }`, 'wash probe');
      const pipe = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
      const make1 = (data: Float32Array<ArrayBuffer>, usage: number) => {
        const b = device.createBuffer({ size: Math.max(16, data.byteLength), usage: usage | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(b, 0, data);
        return b;
      };
      const pts = new Float32Array(points.length * 4);
      points.forEach((p, i) => pts.set([...p, (i % 7) / 3 - 0.5], i * 4));
      const wb = make1(packed, GPUBufferUsage.UNIFORM);
      const pb = make1(pts, GPUBufferUsage.STORAGE);
      const out = device.createBuffer({ size: pts.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const sb = make1(new Float32Array([kept.length, eps, 0, 0]), GPUBufferUsage.UNIFORM);
      const read = device.createBuffer({ size: pts.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const bind = device.createBindGroup({
        layout: pipe.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: wb } }, { binding: 1, resource: { buffer: pb } }, { binding: 2, resource: { buffer: out } }, { binding: 3, resource: { buffer: sb } }],
      });
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipe); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(points.length); pass.end();
      enc.copyBufferToBuffer(out, 0, read, 0, pts.byteLength);
      device.queue.submit([enc.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const got = new Float32Array(read.getMappedRange().slice(0));
      read.unmap();
      for (const b of [wb, pb, out, sb, read]) b.destroy();
      let live = 0;
      points.forEach((p, i) => {
        const want = washVelocity(kept, p, eps);
        for (let k = 0; k < 3; k++) expect(got[i * 4 + k], `point ${i} ${p} axis ${k}`).toBeCloseTo(want[k], 2);
        expect(got[i * 4 + 3], `follow ${i}`).toBeCloseTo(washFollow(pts[i * 4 + 3]), 5);
        if (Math.hypot(...want) > 1) live++;
      });
      // a check that found the field nowhere would pass in silence
      expect(live).toBeGreaterThan(8);
    });
  });
});
