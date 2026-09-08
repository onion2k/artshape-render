/**
 * The renderer without a page: a device with no canvas, a sketch from the
 * catalogue, frames into a texture, and the pixels read back. This is the
 * seam the library split made, exercised: everything here is what a program
 * without a DOM would do, and it runs in a headless Chrome (`npm run
 * test:gpu`), since node has no WebGPU.
 *
 * To look at what it drew, give it a directory: `VITE_FRAME_DIR=/tmp/frames
 * npm run test:gpu` writes each frame there as a PNG.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server } from '@vitest/browser/context';
import { createDevice, type Gpu } from '../../gpu/context';
import { Renderer, type InstanceGroup } from '../renderer';
import { economyAt } from '../calibrate';
import { compile } from '../../dsl/index';
import { sketches } from './fixtures';
import { groupByMesh } from '../../assembly/groups';

const SIZE = 256;
const FRAME_DIR: string | undefined = import.meta.env.VITE_FRAME_DIR;

/** Every pixel of the render target, rows unpadded, as [r, g, b] whatever the byte order the format has. */
class Frame {
  constructor(private px: Uint8Array, private format: GPUTextureFormat) {}

  static async read(gpu: Gpu, texture: GPUTexture): Promise<Frame> {
    const bytesPerRow = Math.ceil((SIZE * 4) / 256) * 256;
    const buffer = gpu.device.createBuffer({ size: bytesPerRow * SIZE, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = gpu.device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [SIZE, SIZE, 1]);
    gpu.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const packed = new Uint8Array(buffer.getMappedRange());
    const out = new Uint8Array(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; y++) out.set(packed.subarray(y * bytesPerRow, y * bytesPerRow + SIZE * 4), y * SIZE * 4);
    buffer.unmap();
    buffer.destroy();
    return new Frame(out, gpu.format);
  }

  at(x: number, y: number): [number, number, number] {
    const i = (y * SIZE + x) * 4;
    const p = this.px;
    return this.format.startsWith('bgra') ? [p[i + 2], p[i + 1], p[i]] : [p[i], p[i + 1], p[i + 2]];
  }
  sum(x: number, y: number) { return this.at(x, y).reduce((a, b) => a + b); }
  /** The mean colour of the block of pixels within `r` of a point: under the film's grain. */
  mean(x: number, y: number, r = 6): [number, number, number] {
    const acc = [0, 0, 0]; let n = 0;
    for (let j = y - r; j <= y + r; j++) for (let i = x - r; i <= x + r; i++) {
      const p = this.at(i, j); acc[0] += p[0]; acc[1] += p[1]; acc[2] += p[2]; n++;
    }
    return [acc[0] / n, acc[1] / n, acc[2] / n];
  }
  get corner() { return this.at(2, 2); }
  get centre() { return this.at(SIZE / 2, SIZE / 2); }
  /** How many distinct colours the middle row holds: a flat fill has one. */
  get colours() {
    const seen = new Set<string>();
    for (let x = 0; x < SIZE; x++) seen.add(this.at(x, SIZE / 2).join(','));
    return seen.size;
  }

  async save(name: string) {
    if (!FRAME_DIR) return;
    const c = document.createElement('canvas');
    c.width = SIZE; c.height = SIZE;
    const g = c.getContext('2d')!;
    const img = g.createImageData(SIZE, SIZE);
    for (let i = 0; i < SIZE * SIZE; i++) img.data.set([...this.at(i % SIZE, Math.floor(i / SIZE)), 255], i * 4);
    g.putImageData(img, 0, 0);
    await server.commands.writeFile(`${FRAME_DIR}/${name}.png`, c.toDataURL('image/png').split(',')[1], 'base64');
  }
}

/** Mean absolute difference per channel between two frames, 0..255. */
function difference(a: Frame, b: Frame): number {
  let sum = 0;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const pa = a.at(x, y), pb = b.at(x, y);
    sum += Math.abs(pa[0] - pb[0]) + Math.abs(pa[1] - pb[1]) + Math.abs(pa[2] - pb[2]);
  }
  return sum / (SIZE * SIZE * 3);
}

/** The rosette as the page builds it: compiled, grouped for drawing, and its bounds. */
function rosette() {
  const result = compile(sketches.rosette);
  expect(result.error).toBeUndefined();
  const assembly = result.sketch!.assembly;
  return { groups: groupByMesh(assembly), bounds: assembly.bounds() };
}

/** Light, material and camera as the first test sets them, on any renderer. */
function stage(renderer: Renderer, groups: ReturnType<typeof groupByMesh>, bounds: ReturnType<typeof rosette>['bounds']) {
  renderer.setSize(SIZE, SIZE);
  renderer.setEnvironment('studio');
  renderer.setKeyLight({ elevation: Math.PI / 4, azimuth: -Math.PI / 4, strength: 1, warmth: 0.3, size: 0.08 });
  renderer.setMaterial('gold', 'polished');
  renderer.setInstanced(groups);
  renderer.frameBounds(bounds);
  // what the viewer's orbit would tell it: the focus at the target
  const { position, target: at } = renderer.camera;
  const distance = Math.hypot(position[0] - at[0], position[1] - at[1], position[2] - at[2]);
  renderer.setFocus(distance, distance);
}

/** The frames the millimetre renderer drew, for the other units to be held against. */
const reference: { first?: Frame; baked?: Frame } = {};

describe('the renderer, headless', () => {
  let gpu: Gpu;
  let renderer: Renderer;
  let target: GPUTexture;
  const errors: string[] = [];
  const consoleError = console.error;
  const view = () => target.createView();

  /** Draw a frame if one is due, wait for it, and read it back. */
  async function frame(name: string): Promise<{ drew: boolean; frame: Frame }> {
    const drew = renderer.render(view);
    await gpu.queue.onSubmittedWorkDone();
    const f = await Frame.read(gpu, target);
    await f.save(name);
    return { drew, frame: f };
  }

  beforeAll(async () => {
    // the renderer reports shader diagnostics and uncaptured errors through console.error
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); consoleError(...args); };
    gpu = await createDevice();
    renderer = new Renderer(gpu);
    await renderer.ready;
    target = gpu.device.createTexture({ label: 'test target', size: [SIZE, SIZE], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  });

  afterAll(() => {
    console.error = consoleError;
    renderer?.dispose();
    target?.destroy();
    gpu?.device.destroy();
  });

  it('takes a sketch, a light and a view, and draws one frame when asked', async () => {
    const { groups, bounds } = rosette();
    expect(groups.length).toBeGreaterThan(0);
    stage(renderer, groups, bounds);

    // the piece is in front of the camera on the CPU before anything is drawn
    expect(renderer.pick(0, 0)).not.toBeNull();

    expect(renderer.pending).toBe(true);
    let views = 0;
    expect(renderer.render(() => { views++; return view(); })).toBe(true);
    expect(views).toBe(1);
    // nothing changed since: the next tick asks for no view and draws nothing
    expect(renderer.render(() => { views++; return view(); })).toBe(false);
    expect(views).toBe(1);
    expect(renderer.pending).toBe(false);
  });

  it('puts the piece in the middle of the frame and the background at the edges', async () => {
    const f = await Frame.read(gpu, target);
    await f.save('first');
    reference.first = f;
    // the page's own dark ground at the corner, never the magenta of a lost device
    for (const c of f.corner) expect(c).toBeLessThan(40);
    expect(f.sum(SIZE / 2, SIZE / 2)).toBeGreaterThan(f.sum(2, 2) + 60);
    // gold: warmer than it is blue, and shaded rather than flat
    expect(f.centre[0]).toBeGreaterThan(f.centre[2]);
    expect(f.colours).toBeGreaterThan(20);
  });

  it('draws again once the sky has been read back and the shadows baked', async () => {
    // the environment's samples arrive on a promise; shadows follow, and mark a frame due
    await renderer.setEnvironment('studio').samples;
    expect(renderer.pending).toBe(true);
    const { drew, frame: f } = await frame('baked');
    expect(drew).toBe(true);
    expect(f.sum(SIZE / 2, SIZE / 2)).toBeGreaterThan(f.sum(2, 2) + 60);
    reference.baked = f;
  });

  it('moves a dynamic part under the bake that stands, and bakes again for a static one', async () => {
    const groups: InstanceGroup[] = rosette().groups;
    // the heart is the one part placed once; it will be the moving part
    const heart = groups.findIndex((g) => g.matrices.length === 16);
    expect(heart).toBeGreaterThanOrEqual(0);
    groups[heart].dynamic = true;
    const bakes0 = renderer.occlusionBakes;
    renderer.setInstanced(groups);
    expect(renderer.occlusionBakes).toBe(bakes0 + 1);
    const before = await frame('dynamic-before');
    const bakes1 = renderer.occlusionBakes;

    // lift the heart: a frame, no bake
    const lifted = new Float32Array(groups[heart].matrices);
    lifted[14] += 6;
    renderer.move(heart, lifted);
    expect(renderer.occlusionBakes).toBe(bakes1);
    const after = await frame('dynamic-after');
    expect(after.drew).toBe(true);
    expect(difference(before.frame, after.frame)).toBeGreaterThan(0.3);

    // the same scene given again keeps its bake and reuses every mesh's buffers
    renderer.setInstanced(groups.map((g) => ({ ...g })));
    expect(renderer.occlusionBakes).toBe(bakes1);

    // a static part moved is a new bake
    const petal = groups.findIndex((g) => g.matrices.length > 16);
    renderer.move(petal, groups[petal].matrices);
    expect(renderer.occlusionBakes).toBe(bakes1 + 1);
    expect((await frame('static-moved')).drew).toBe(true);
    expect(() => renderer.move(heart, new Float32Array(32))).toThrow();
  });

  it('draws only the live end of a group, and picks only there', async () => {
    const groups: InstanceGroup[] = rosette().groups;
    // the petals: the one part placed many times, so it has a pool to cut
    const petal = groups.findIndex((g) => g.matrices.length > 16 * 4);
    expect(petal).toBeGreaterThanOrEqual(0);
    const room = groups[petal].matrices.length / 16;
    renderer.setInstanced(groups);
    const all = (await frame('count-all')).frame;

    // half of them, and the picture must change by more than the film's grain
    renderer.move(petal, groups[petal].matrices, room / 2);
    const half = await frame('count-half');
    expect(half.drew).toBe(true);
    expect(difference(all, half.frame)).toBeGreaterThan(0.3);

    // nothing beyond the live end is picked, wherever the ray is cast
    for (let y = -0.9; y <= 0.9; y += 0.3) {
      for (let x = -0.9; x <= 0.9; x += 0.3) {
        const hit = renderer.pick(x, y);
        if (hit?.group === petal) expect(hit.instance).toBeLessThan(room / 2);
      }
    }

    // none at all: the part goes, and the frame with it
    renderer.move(petal, groups[petal].matrices, 0);
    const none = await frame('count-none');
    expect(difference(half.frame, none.frame)).toBeGreaterThan(0.3);
    for (let y = -0.9; y <= 0.9; y += 0.3) {
      for (let x = -0.9; x <= 0.9; x += 0.3) {
        expect(renderer.pick(x, y)?.group).not.toBe(petal);
      }
    }

    // and back, which is the same picture it started as
    renderer.move(petal, groups[petal].matrices, room);
    const again = (await frame('count-again')).frame;
    expect(difference(all, again)).toBeLessThan(2);
  });

  it('counts past the ends the way a caller would hope', async () => {
    const groups: InstanceGroup[] = rosette().groups;
    const petal = groups.findIndex((g) => g.matrices.length > 16 * 4);
    const room = groups[petal].matrices.length / 16;
    renderer.setInstanced(groups);
    // more than there is room for is all of it; fewer than none is none
    renderer.move(petal, groups[petal].matrices, room + 50);
    expect((await frame('count-over')).drew).toBe(true);
    const over = await Frame.read(gpu, target);
    renderer.move(petal, groups[petal].matrices, -5);
    expect((await frame('count-under')).drew).toBe(true);
    const under = await Frame.read(gpu, target);
    expect(difference(over, under)).toBeGreaterThan(0.3);

    renderer.move(petal, groups[petal].matrices, room);
    const all = await frame('count-restored');
    expect(difference(over, all.frame)).toBeLessThan(2);
  });

  it('moves several groups as one change, and bakes once for the lot', async () => {
    const groups: InstanceGroup[] = rosette().groups.map((g) => ({ ...g, dynamic: false }));
    renderer.setInstanced(groups);
    await frame('moveall-before');
    const bakes = renderer.occlusionBakes;

    // two static groups in one call: one bake, not two
    const lift = (g: InstanceGroup) => {
      const m = new Float32Array(g.matrices);
      for (let i = 0; i < m.length; i += 16) m[i + 14] += 1.5;
      return m;
    };
    renderer.moveAll([
      { group: 0, matrices: lift(groups[0]) },
      { group: 1, matrices: lift(groups[1]) },
    ]);
    expect(renderer.occlusionBakes).toBe(bakes + 1);
    expect((await frame('moveall-after')).drew).toBe(true);

    // dynamic groups move under the bake that stands, however many of them
    renderer.setInstanced(groups.map((g) => ({ ...g, dynamic: true })));
    const bakes2 = renderer.occlusionBakes;
    renderer.moveAll([
      { group: 0, matrices: lift(groups[0]) },
      { group: 1, matrices: lift(groups[1]) },
    ]);
    expect(renderer.occlusionBakes).toBe(bakes2);
    expect(() => renderer.moveAll([{ group: 99, matrices: new Float32Array(16) }])).toThrow();
    renderer.setInstanced(rosette().groups);
    await frame('moveall-restored');
  });

  it('draws the debug views', async () => {
    for (const mode of [1, 2, 3]) {
      renderer.setDebug(mode);
      const { drew, frame: f } = await frame(`debug${mode}`);
      expect(drew).toBe(true);
      expect(f.colours).toBeGreaterThan(1);
    }
    renderer.setDebug(0);
  });

  it('draws the same piece with the table reflected and with it given up', async () => {
    // The ladder's reflection rung is a shader permutation, not a uniform: a
    // uniform branch around it saved nothing measurable, and compiling it out
    // saves about six milliseconds a megapixel. So the cheap variant is a
    // different pipeline, and this is what says it draws at all — `seen` is
    // where a NaN once turned every frame black, and the fallback path
    // through it is the one nothing else exercises.
    renderer.setTable('walnut');
    const shot = async (reflection: boolean) => {
      renderer.setEconomy({ ...economyAt(0), reflection });
      for (let i = 0; i < 300 && renderer.pending; i++) {
        renderer.render(view);
        await new Promise((r) => setTimeout(r, 10));
      }
      renderer.requestRender();
      renderer.render(view);
      return Frame.read(gpu, target);
    };
    const full = await shot(true);
    const flat = await shot(false);
    for (const f of [full, flat]) {
      // the piece is there and lit, not a black frame and not the background
      expect(f.sum(SIZE / 2, SIZE / 2)).toBeGreaterThan(f.sum(2, 2) + 60);
      expect(f.colours).toBeGreaterThan(20);
    }
    // and the two agree closely: the fallback is the probe's reading of the
    // same table, so giving it up moves the picture rather than losing it
    const mid = (f: typeof full) => f.sum(SIZE / 2, SIZE / 2);
    expect(Math.abs(mid(full) - mid(flat))).toBeLessThan(mid(full) * 0.5);
    renderer.setEconomy(economyAt(0));
    renderer.setTable('matte');
  });

  it('traces a sample once the view is still, having loaded the tracer only now', async () => {
    // every frame so far was raster: the tracer's module is fetched on the
    // first traced frame and not before, so nothing of it exists yet
    expect(renderer.pathTracer).toBeNull();
    renderer.setQuality('traced');
    renderer.setMoving(false);
    // the module is fetched and the scene built off the thread: raster frames
    // until both land, then a sample a frame
    for (let i = 0; i < 500 && renderer.traceSamples === 0; i++) {
      renderer.requestRender();
      renderer.render(view);
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(renderer.traceSamples).toBeGreaterThan(0);
    expect(renderer.pathTracer).not.toBeNull();
    await frame('traced');
    renderer.setQuality('draft');
  });

  it('traces the cushion under a piece on velvet', async () => {
    renderer.setTable('velvet');
    renderer.setQuality('traced');
    renderer.setMoving(false);
    for (let i = 0; i < 500 && renderer.traceSamples < 4; i++) {
      renderer.requestRender();
      renderer.render(view);
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(renderer.traceSamples).toBeGreaterThanOrEqual(4);
    const f = await Frame.read(gpu, target);
    await f.save('velvet-traced');
    // beside the piece is the cushion: velvet, a deep blue, where the page's ground at the corner is neutral
    const cloth = f.mean(Math.round(SIZE * 0.28), Math.round(SIZE * 0.6));
    const page = f.mean(8, 8);
    expect(cloth[2]).toBeGreaterThan(cloth[0] + 3);
    expect(Math.abs(page[2] - page[0])).toBeLessThan(3);
    renderer.setQuality('draft');
    renderer.setTable('matte');
  });

  it('compiled every shader and raised no GPU error', async () => {
    // shader diagnostics arrive on a promise after creation: give them a tick
    await new Promise((r) => setTimeout(r, 50));
    expect(errors.filter((e) => /shader|WebGPU/.test(e))).toEqual([]);
  });
});

describe('the renderer in other units', () => {
  let gpu: Gpu;
  let renderer: Renderer;
  let target: GPUTexture;
  const errors: string[] = [];
  const consoleError = console.error;

  beforeAll(async () => {
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); consoleError(...args); };
    gpu = await createDevice();
    renderer = new Renderer(gpu, { mmPerUnit: 1000 });
    await renderer.ready;
    target = gpu.device.createTexture({ label: 'metre target', size: [SIZE, SIZE], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  });

  afterAll(() => {
    console.error = consoleError;
    renderer?.dispose();
    target?.destroy();
    gpu?.device.destroy();
  });

  it('draws the rosette modelled in metres as it drew it in millimetres', async () => {
    const { groups, bounds } = rosette();
    // the same piece a thousand times smaller in number: metres, told as such
    const k = 1 / 1000;
    const metres = groups.map((g) => {
      const matrices = new Float32Array(g.matrices);
      for (let i = 12; i < matrices.length; i += 16) { matrices[i] *= k; matrices[i + 1] *= k; matrices[i + 2] *= k; }
      return { ...g, mesh: { ...g.mesh, positions: g.mesh.positions.map((v) => v * k) }, matrices };
    });
    const scaled = { min: bounds.min.map((v) => v * k) as typeof bounds.min, max: bounds.max.map((v) => v * k) as typeof bounds.max };
    stage(renderer, metres, scaled);

    expect(renderer.render(() => target.createView())).toBe(true);
    await gpu.queue.onSubmittedWorkDone();
    const first = await Frame.read(gpu, target);
    await first.save('metres-first');
    expect(reference.first).toBeDefined();
    expect(difference(first, reference.first!)).toBeLessThan(2);

    await renderer.setEnvironment('studio').samples;
    expect(renderer.render(() => target.createView())).toBe(true);
    await gpu.queue.onSubmittedWorkDone();
    const baked = await Frame.read(gpu, target);
    await baked.save('metres-baked');
    expect(difference(baked, reference.baked!)).toBeLessThan(2);
  });

  it('raised no GPU error', async () => {
    await new Promise((r) => setTimeout(r, 50));
    expect(errors.filter((e) => /shader|WebGPU/.test(e))).toEqual([]);
  });
});
