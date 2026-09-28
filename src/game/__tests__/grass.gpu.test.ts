/**
 * Grass on a real device: that a game which never asks for it draws as it
 * did and compiles nothing more; that a field grows only where its mask
 * says, and grows the very blades `grass.ts` grows; that it thins with
 * distance without popping and not past its far distance; that the
 * economy's share is a subset; that capacity holds; that the kept frame
 * does not freeze it; that the sun's shadow and the fog reach it; and that
 * everything it made is destroyed. Pixel checks and read-back blades, since
 * a field has no other symptom. VITE_FRAME_DIR writes the pictures of each
 * kind, to be looked at.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDevice, type Gpu } from '../../gpu/context';
import { MeshBuilder, type Mesh } from '../../mesh/types';
import { bakeEnvironment } from '../../render/env';
import { FULL_ECONOMY, GameRenderer, type GameGroup } from '../renderer';
import { LightPool } from '../lights';
import { noFog } from '../fog';
import { CHUNK, bladesIn, grassGround, type GrassField, type GrassKind, type GrassOptions } from '../grass';
import { differing, meanIn, readPixels, saveFrame, type Pixels } from './frame';

const SIZE = 256;
/** The pipelines v0.18.0's constructor makes, counted on that commit: a game that does not ask for grass makes no more. */
const PIPELINES_AT_0_18 = 46;

const GREEN: GrassKind = { density: 150, height: 0.15, width: 0.05, base: [0.05, 0.3, 0.04], tip: [0.25, 0.7, 0.15], lean: 0.25, give: 0.1 };
const FAIRWAY: GrassKind = { density: 60, height: 0.3, width: 0.06, base: [0.06, 0.28, 0.05], tip: [0.3, 0.65, 0.18], lean: 0.2, give: 0.4 };
const ROUGH: GrassKind = { density: 12, height: 0.8, width: 0.09, base: [0.04, 0.2, 0.05], tip: [0.2, 0.5, 0.12], lean: 0.15, give: 1 };
const EARTH: [number, number, number] = [0.3, 0.16, 0.08];

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

function box(): Mesh {
  const b = new MeshBuilder();
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, -1, 0], [0, 0, 1]],
    [[0, 1, 0], [-1, 0, 0], [0, 0, 1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
  ];
  for (const [n, u, v] of faces) {
    const base = b.vertexCount;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = [0, 1, 2].map((k) => (n[k] + su * u[k] + sv * v[k]) / 2 + (k === 2 ? 0.5 : 0));
      b.vertex(p[0], p[1], p[2], n[0], n[1], n[2], 0, 0);
    }
    b.quad(base, base + 1, base + 2, base + 3);
  }
  return b.build();
}

const at = (x: number, y: number, z: number, sx = 1, sy = 1, sz = 1) => new Float32Array([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, x, y, z, 1]);

/** A field eight units square of quarter-unit cells, green, with the cup's disc cut from its middle. */
function field(over: Partial<GrassField> = {}, cup = true): GrassField {
  const cols = 32, rows = 32;
  const mask = new Uint8Array(cols * rows).fill(1);
  if (cup)
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) if (Math.hypot((i + 0.5) * 0.25 - 4, (j + 0.5) * 0.25 - 4) < 1.45) mask[j * cols + i] = 0;
  return { origin: [0, 0], cell: 0.25, cols, rows, mask, heights: new Float32Array(cols * rows), kinds: [GREEN, FAIRWAY, ROUGH], seed: 3, ...over };
}

describe('grass on the game renderer', () => {
  let gpu: Gpu;
  let r: GameRenderer;
  let target: GPUTexture;
  let env: ReturnType<typeof bakeEnvironment>;
  const ground: GameGroup = { mesh: plane(400), matrices: at(0, 0, 0), albedo: EARTH, roughness: 0.9 };
  const errors: string[] = [];
  const consoleError = console.error;

  function setUp(renderer: GameRenderer) {
    renderer.setEnvironment(env.specular, env.brdf, env.mips);
    renderer.resize(SIZE, SIZE);
    renderer.setLights(new LightPool(8));
    renderer.look = {
      ...renderer.look, shading: 'toon', sunDir: [-0.35, 0.3, 0.89], sunColour: [2.5, 2.45, 2.35], ambient: 1,
      background: [0.45, 0.72, 0.98], occlusion: 0,
    };
    renderer.post = { ...renderer.post, bloom: 0, vignette: 0, grain: 0, tone: 'clamp' };
    renderer.economy = { ...FULL_ECONOMY, shadows: true };
    renderer.setStatic([ground]);
    renderer.setDynamic([]);
    look(renderer, 4, 4, 12);
  }

  /** The camera at the golf's three-quarter view, `distance` back from (x, y). */
  function look(renderer: GameRenderer, x: number, y: number, distance: number) {
    renderer.camera.fov = 40; renderer.camera.near = 0.2; renderer.camera.far = 800;
    renderer.camera.target = [x, y, 0];
    renderer.camera.position = [x, y - Math.sin(0.78) * distance, Math.cos(0.78) * distance];
  }

  /** Where world point p falls on the frame, in pixels. */
  function toScreen(renderer: GameRenderer, p: [number, number, number]): [number, number] {
    renderer.camera.update();
    const m = renderer.camera.viewProjection;
    const o = [0, 1, 3].map((row) => m[row] * p[0] + m[4 + row] * p[1] + m[8 + row] * p[2] + m[12 + row]);
    return [Math.round(((o[0] / o[2]) * 0.5 + 0.5) * SIZE), Math.round((0.5 - (o[1] / o[2]) * 0.5) * SIZE)];
  }

  async function draw(renderer = r, mode: 'redraw' | 'keep' = 'redraw', name = ''): Promise<Pixels> {
    renderer.frame(target.createView(), mode);
    const px = await readPixels(gpu, target);
    if (name) await saveFrame(name, px);
    return px;
  }

  /** The share of the pixels round world point p, a few pixels each way, that are grass: green over the brown earth. */
  function grassy(px: Pixels, p: [number, number, number], half = 4, renderer = r): number {
    const [cx, cy] = toScreen(renderer, p);
    if (cx - half < 0 || cy - half < 0 || cx + half >= SIZE || cy + half >= SIZE) throw new Error(`${p} is off the frame, at ${cx}, ${cy}`);
    let n = 0, g = 0;
    for (let y = cy - half; y <= cy + half; y++)
      for (let x = cx - half; x <= cx + half; x++) {
        const i = (y * SIZE + x) * 3;
        const [R, G, B] = [px.rgb[i], px.rgb[i + 1], px.rgb[i + 2]];
        n++;
        if (G > R * 1.2 && G > B * 1.2) g++;
      }
    return g / n;
  }

  /** How bright the blades' own pixels are round world point p, leaving out the earth between them; or the earth's alone. */
  function bladeLight(px: Pixels, p: [number, number, number], halfW: number, halfH: number, earth = false): number {
    const [cx, cy] = toScreen(r, p);
    let sum = 0, n = 0;
    for (let y = cy - halfH; y <= cy + halfH; y++)
      for (let x = cx - halfW; x <= cx + halfW; x++) {
        const i = (y * SIZE + x) * 3;
        const [R, G, B] = [px.rgb[i], px.rgb[i + 1], px.rgb[i + 2]];
        if ((G > R * 1.2 && G > B * 1.2) !== earth) { sum += R + G + B; n++; }
      }
    if (n < 5) throw new Error(`no ${earth ? 'earth' : 'blades'} round ${p}`);
    return sum / n;
  }

  beforeAll(async () => {
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); consoleError(...args); };
    gpu = await createDevice();
    env = bakeEnvironment(gpu, 'daylight', { size: 32, mips: 3 });
    await env.samples;
    r = new GameRenderer(gpu, 8, 8, 64, 100);
    await r.ready;
    target = gpu.device.createTexture({ size: [SIZE, SIZE], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    setUp(r);
  });

  // every test starts from the same frame, whatever the one before left
  beforeEach(() => {
    r.time = 0;
    r.wind = { direction: [1, 0], strength: 0, gustSize: 20, gustSpeed: 4 };
    r.setStatic([ground]);
    r.setSunShadow(null);
    r.fog = noFog(100);
    r.economy = { ...FULL_ECONOMY, shadows: true };
    look(r, 4, 4, 12);
  });

  afterAll(() => { console.error = consoleError; r?.dispose(); target?.destroy(); gpu?.device.destroy(); });

  it('draws a game that never asks for grass as before, and compiles nothing more for it until it does', async () => {
    const d = gpu.device as unknown as Record<string, (...a: unknown[]) => unknown>;
    let made = 0;
    const kept: Record<string, (...a: unknown[]) => unknown> = {};
    for (const m of ['createRenderPipelineAsync', 'createComputePipelineAsync', 'createRenderPipeline', 'createComputePipeline']) {
      kept[m] = d[m];
      const f = d[m].bind(d);
      d[m] = (...a: unknown[]) => { made++; return f(...a); };
    }
    try {
      const fresh = new GameRenderer(gpu, 8, 8, 64, 100);
      await fresh.ready;
      expect(made, 'pipelines made before ready').toBe(PIPELINES_AT_0_18);
      setUp(fresh);
      const never = await draw(fresh);
      await fresh.setGrass(field());
      expect(made, 'pipelines made once grass is asked for').toBeGreaterThan(PIPELINES_AT_0_18);
      const grown = await draw(fresh);
      expect(differing(grown, never)).toBeGreaterThan(1000);
      await fresh.setGrass(null);
      expect(differing(await draw(fresh), never), 'grass set and cleared, against never set').toBe(0);
      fresh.dispose();
    } finally {
      Object.assign(d, kept);
    }
  });

  it('grows a field only where its mask gives a kind: not in the cup, and not off the field', async () => {
    await r.setGrass(field());
    const px = await draw(r, 'redraw', 'grass-mask');
    for (const [x, y] of [[4, 6.2], [1.5, 4], [6.5, 4], [4, 2], [2, 6.5]] as const) expect(grassy(px, [x, y, 0]), `grass at ${x}, ${y}`).toBeGreaterThan(0.3);
    expect(grassy(px, [4, 4, 0], 3), 'in the cup').toBeLessThan(0.02);
    for (const [x, y] of [[4, 8.8], [1, 9], [7, 9]] as const) expect(grassy(px, [x, y, 0], 3), `off the field at ${x}, ${y}`).toBeLessThan(0.02);
    expect(errors).toEqual([]);
  });

  it('grows the very blades grass.ts grows, in number exactly and in place', async () => {
    const f = field({ mask: new Uint8Array(32 * 32).map((_, i) => (i % 32 < 16 ? 1 : 3)) }, false);
    await r.setGrass(f, { near: 1000, mid: 1000, far: 2000 });
    look(r, 4, 4, 30);
    await draw(r);
    const drawn = await r.grassBlades();
    const twin = [];
    for (let cy = 0; cy * CHUNK < 32; cy++) for (let cx = 0; cx * CHUNK < 32; cx++) for (let k = 0; k < 3; k++) twin.push(...bladesIn(f, cx, cy, k));
    expect(drawn.far.length).toBe(0);
    expect(drawn.near.length).toBe(twin.length);
    const byId = new Map(twin.map((b) => [b.id, b]));
    let worst = 0;
    for (const b of drawn.near) {
      const t = byId.get(b.id);
      expect(t, `blade ${b.id} grown on the GPU and not by grass.ts`).toBeDefined();
      worst = Math.max(worst, Math.abs(b.x - t!.x), Math.abs(b.y - t!.y), Math.abs(b.z - t!.z));
    }
    expect(worst).toBeLessThan(1e-4);
    look(r, 4, 4, 12);
  });

  it('grows another field from another seed', async () => {
    await r.setGrass(field());
    const a = await draw(r);
    await r.setGrass(field({ seed: 4 }));
    expect(differing(await draw(r), a)).toBeGreaterThan(500);
  });

  it('shows a mown green in stripes, lighter and darker in turn', async () => {
    const striped: GrassKind = { ...GREEN, stripes: { width: 2, angle: 0, shade: 0.3 } };
    await r.setGrass(field({ kinds: [striped] }, false));
    const px = await draw(r, 'redraw', 'grass-stripes');
    // bands two units deep running across the view: y in [0, 2) is band 0, [2, 4) band 1, and so on; the blades' own
    // pixels, since between them is the earth, which is the same in every band
    const light = (y: number) => bladeLight(px, [4, y, 0], 30, 2);
    const bands = [1, 3, 5, 7].map(light);
    expect(bands[1] / bands[0], 'odd bands are lighter').toBeGreaterThan(1.1);
    expect(bands[1] / bands[2], 'and again').toBeGreaterThan(1.1);
    expect(bands[3] / bands[2], 'and again').toBeGreaterThan(1.1);
  });

  it('thins with distance without a step, and grows nothing past its far distance', async () => {
    const f = field({ outside: { kind: 2, height: 0 } });
    const levels = { near: 10, mid: 20, far: 60 };
    await r.setGrass(f, levels);
    const counts: number[] = [];
    const frames: Pixels[] = [];
    try {
    for (let d = 8; d < 90; d *= 1.015) {
      look(r, 4, 4, d);
      frames.push(await draw(r));
      const n = await r.grassDrawn();
      counts.push(n.near + n.far);
      const { near, far } = await r.grassBlades();
      const eye = r.camera.position;
      for (const b of [...near, ...far]) expect(Math.hypot(b.x - eye[0], b.y - eye[1], b.z - eye[2])).toBeLessThanOrEqual(levels.far);
    }
    } finally {
      look(r, 4, 4, 12);
    }
    // a step of the camera changes the count by the share the distance takes, and by chance: which blades' ranks fall
    // across the line is a draw, whose spread is about the square root of the count
    for (let i = 1; i < counts.length; i++)
      expect(Math.abs(counts[i] - counts[i - 1]), `drawn ${counts[i - 1]} then ${counts[i]}`).toBeLessThanOrEqual(0.1 * counts[i - 1] + 3 * Math.sqrt(counts[i - 1]));
    const steps = frames.slice(1).map((f, i) => differing(f, frames[i]));
    // the change a step makes falls smoothly as the camera draws back; a pop is a step that changes far more than the
    // steps either side of it do
    for (let i = 1; i < steps.length - 1; i++)
      expect(steps[i], `the step to ${(8 * 1.015 ** (i + 1)).toFixed(1)} units`).toBeLessThanOrEqual(1.5 * Math.max(steps[i - 1], steps[i + 1]) + 50);
  });

  it('shrinks a blade into the ground as its rank passes the share kept, rather than blinking it out', async () => {
    // one blade a chunk, tall and wide, at a rank grass.ts says, with the share kept set just past it
    const one: GrassKind = { density: 0.0625, height: 3, heightSpread: 0, width: 0.6, base: [0.1, 0.5, 0.1], tip: [0.2, 0.8, 0.2], lean: 0 };
    const make = (seed: number): GrassField => ({ origin: [0, 0], cell: 0.25, cols: 16, rows: 16, mask: new Uint8Array(256).fill(1), heights: new Float32Array(256), kinds: [one], seed });
    let seed = 1;
    while (!(bladesIn(make(seed), 0, 0, 0)[0]?.rank > 0.4)) seed++;
    const f = make(seed);
    const [blade] = bladesIn(f, 0, 0, 0);
    await r.setGrass(f, { near: 1000, mid: 1000, far: 2000 });
    look(r, blade.x, blade.y, 10);
    const cover = async (share: number) => {
      r.economy = { ...FULL_ECONOMY, shadows: true, grass: share };
      const px = await draw(r);
      let n = 0;
      for (let i = 0; i < px.rgb.length; i += 3) if (px.rgb[i + 1] > px.rgb[i] * 1.2 && px.rgb[i + 1] > px.rgb[i + 2] * 1.2) n++;
      return n;
    };
    const whole = await cover(1);
    // kept at rank / 1.05, the blade stands (1.1 / 1.05 - 1) / 0.1 of its rank tall: under half its height
    const sinking = await cover(blade.rank / 1.05);
    const gone = await cover(blade.rank / 1.1 - 0.001);
    expect(whole).toBeGreaterThan(200);
    expect(sinking, 'part sunk').toBeGreaterThan(0);
    expect(sinking, 'and not whole').toBeLessThan(whole * 0.7);
    expect(gone, 'and then gone').toBe(0);
  });

  it('draws nothing of it on the rung that gives it up, and at half, half the ranks, all among the whole', async () => {
    await r.setGrass(null);
    const none = await draw(r);
    await r.setGrass(field(), { near: 1000, mid: 1000, far: 2000 });
    r.economy = { ...FULL_ECONOMY, shadows: true, grass: 0 };
    expect(differing(await draw(r), none), 'the rung at nought against no grass').toBe(0);
    r.economy = { ...FULL_ECONOMY, shadows: true };
    await draw(r);
    const whole = await r.grassBlades();
    r.economy = { ...FULL_ECONOMY, shadows: true, grass: 0.5 };
    await draw(r);
    const half = await r.grassBlades();
    r.economy = { ...FULL_ECONOMY, shadows: true };
    // a blade is drawn while its rank is under the kept share and the band past it: 0.55 of them at half
    expect(Math.abs(half.near.length / whole.near.length - 0.55)).toBeLessThan(0.55 * 0.05);
    const ids = new Set(whole.near.map((b) => b.id));
    expect(half.near.every((b) => ids.has(b.id))).toBe(true);
  });

  it('draws its capacity and no more, with no error, when the field has more', async () => {
    await r.setGrass(field(), { capacity: 1000 });
    await draw(r);
    const n = await r.grassDrawn();
    expect(n.near + n.far).toBe(1000);
    expect(errors).toEqual([]);
  });

  it('is drawn with the movers when the static half is kept, not frozen into it', async () => {
    await r.setGrass(null);
    const bare = await draw(r, 'redraw');
    await r.setGrass(field());
    const redrawn = await draw(r, 'redraw');
    expect(differing(redrawn, bare)).toBeGreaterThan(1000);
    await draw(r, 'keep');
    expect(differing(await draw(r, 'keep'), redrawn)).toBe(0);
  });

  it('takes the shadow of what stands in it, and the fog as the ground does', async () => {
    await r.setGrass(field({}, false));
    r.setSunShadow({ min: [-2, -2, -1], max: [10, 10, 5] });
    const open = await draw(r);
    r.setStatic([ground, { mesh: box(), matrices: at(4, 4, 0, 2, 2, 3), albedo: [0.9, 0.2, 0.2], roughness: 0.5 }]);
    const shaded = await draw(r, 'redraw', 'grass-shadow');
    // blades in the shadow darken as the earth among them does, as much as a clamped toon light lets either
    const blades = bladeLight(shaded, [5.6, 2.6, 0], 4, 4) / bladeLight(open, [5.6, 2.6, 0], 4, 4);
    const earth = bladeLight(shaded, [5.6, 2.6, 0], 4, 4, true) / bladeLight(open, [5.6, 2.6, 0], 4, 4, true);
    expect(blades, 'blades in the box\'s shadow').toBeLessThan(0.9);
    expect(Math.abs(blades - earth), `blades darken by ${blades}, the earth by ${earth}`).toBeLessThan(0.1);
    expect(bladeLight(shaded, [1.5, 1.5, 0], 4, 4) / bladeLight(open, [1.5, 1.5, 0], 4, 4), 'blades out of it').toBeGreaterThan(0.97);
    r.setStatic([ground]);
    r.setSunShadow(null);
    // the fog pales the grass as it pales the bare earth in the cup beside it, so the two come nearer each other
    await r.setGrass(field());
    const clear = await draw(r);
    r.fog = { ...noFog(100), density: 0.08, base: -10, height: 1000, colour: [0.6, 0.6, 0.7], ambient: 1, anisotropy: 0, reach: 600, steps: 16, cones: 0 };
    const fogged = await draw(r);
    const apart = (px: Pixels) => {
      const [gx, gy] = toScreen(r, [4, 6.2, 0]), [cx, cy] = toScreen(r, [4, 4, 0]);
      const g = meanIn(px, gx - 4, gy - 3, gx + 5, gy + 4), c = meanIn(px, cx - 4, cy - 3, cx + 5, cy + 4);
      return Math.hypot(g[0] - c[0], g[1] - c[1], g[2] - c[2]);
    };
    expect(apart(fogged), 'fogged grass and earth are nearer alike than clear ones').toBeLessThan(apart(clear) * 0.7);
  });

  it('draws the same field alike in millimetres and in tenths of a metre', async () => {
    const mm = new GameRenderer(gpu, 8, 8, 64, 1);
    await mm.ready;
    setUp(mm);
    mm.look = { ...r.look };
    await r.setGrass(field());
    await mm.setGrass(field());
    const a = await draw(r), b = await draw(mm);
    expect(grassy(a, [4, 6, 0])).toBeGreaterThan(0.3);
    expect(differing(a, b) / (SIZE * SIZE)).toBeLessThan(0.01);
    mm.dispose();
  });

  it('destroys everything it made when it is cleared', async () => {
    const d = gpu.device;
    const made: { destroy(): void }[] = [];
    const cb = d.createBuffer.bind(d), ct = d.createTexture.bind(d);
    d.createBuffer = ((x: GPUBufferDescriptor) => { const b = cb(x); made.push(b); return b; }) as typeof d.createBuffer;
    d.createTexture = ((x: GPUTextureDescriptor) => { const t = ct(x); made.push(t); return t; }) as typeof d.createTexture;
    await r.setGrass(field(), { trample: { origin: [0, 0], cell: 0.25, cols: 32, rows: 32 } });
    d.createBuffer = cb as typeof d.createBuffer;
    d.createTexture = ct as typeof d.createTexture;
    await draw(r);
    expect(made.length).toBeGreaterThan(4);
    const destroyed = new Set<unknown>();
    for (const m of made) { const f = m.destroy.bind(m); m.destroy = () => { destroyed.add(m); f(); }; }
    await r.setGrass(null);
    expect(made.filter((m) => !destroyed.has(m)).length).toBe(0);
  });

  it('bends in the wind by the game\'s own time: two moments differ, the same moment twice does not', async () => {
    await r.setGrass(field({ kinds: [ROUGH] }, false));
    look(r, 4, 4, 8);
    r.wind = { direction: [1, 0.5], strength: 1, gustSize: 6, gustSpeed: 3 };
    r.time = 10;
    const a = await draw(r, 'redraw', 'grass-wind-10');
    r.time = 11.5;
    const b = await draw(r, 'redraw', 'grass-wind-11');
    expect(differing(a, b), 'two moments').toBeGreaterThan(2000);
    r.time = 10;
    // however many frames, and whatever step each was, between: only the moment counts
    for (let i = 0; i < 5; i++) r.frame(target.createView(), 'redraw', 0.1 * i);
    expect(differing(await draw(r), a), 'the same moment again').toBe(0);
  });

  it('stands still with no wind, or on the rung that gives the wind up', async () => {
    await r.setGrass(field({ kinds: [ROUGH] }, false));
    look(r, 4, 4, 8);
    r.wind = { direction: [1, 0], strength: 0, gustSize: 6, gustSpeed: 3 };
    r.time = 1;
    const calm1 = await draw(r);
    r.time = 7;
    expect(differing(await draw(r), calm1), 'no wind').toBe(0);
    r.wind = { direction: [1, 0], strength: 1, gustSize: 6, gustSpeed: 3 };
    r.economy = { ...FULL_ECONOMY, shadows: true, wind: false };
    const still7 = await draw(r);
    r.time = 1;
    expect(differing(await draw(r), still7), 'the rung off').toBe(0);
    expect(differing(still7, calm1), 'and standing as it does with none').toBe(0);
  });

  it('draws each kind, for looking at', async () => {
    for (const [name, kind] of [['green', { ...GREEN, stripes: { width: 2, angle: 0, shade: 0.25 } }], ['fairway', FAIRWAY], ['rough', ROUGH]] as const) {
      const f = field({ kinds: [kind as GrassKind] }, name === 'green');
      r.setStatic([{ ...ground, albedo: grassGround(kind as GrassKind) }]);
      look(r, 4, 4, 8);
      await r.setGrass(null);
      const bare = await draw(r);
      await r.setGrass(f, {} as GrassOptions);
      const px = await draw(r, 'redraw', `grass-${name}`);
      expect(differing(px, bare), `the ${name} is drawn over its ground`).toBeGreaterThan(2000);
      if (name === 'green') {
        // the ground painted grassGround's colour is the colour the blades average to: the cup is no lighter or darker than the green round it
        const [gx, gy] = toScreen(r, [4, 6.2, 0]), [cx, cy] = toScreen(r, [4, 4, 0]);
        const g = meanIn(px, gx - 40, gy - 6, gx + 40, gy + 6), c = meanIn(px, cx - 12, cy - 6, cx + 12, cy + 6);
        expect(Math.hypot(g[0] - c[0], g[1] - c[1], g[2] - c[2]), `the green ${g.map(Math.round)} against the cup's ground ${c.map(Math.round)}`).toBeLessThan(4);
      }
    }
    r.setStatic([ground]);
    look(r, 4, 4, 12);
    expect(errors).toEqual([]);
  });
});
