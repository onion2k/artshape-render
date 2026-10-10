/**
 * The flow material on a real device: a surface drawn with a pattern that
 * travels along the mesh's own +x by `time * speed`, in four kinds (5 ripple,
 * 6 crust, 7 drift, 8 water, which is laid in the world and not on the mesh), through a build of the scene shader that is compiled only
 * when a group first asks for one. A game that asks for none of it draws as it
 * did and compiles nothing; each kind draws its second colour over its first;
 * the same time is the same frame, and a later time is the same picture moved
 * along by the speed; glow lights what no light reaches, and nought does not;
 * ripple's slope turns the normal; a kept static half does not freeze it; and
 * every rung, look and antialiasing mode has its build. Pixel checks, under an
 * error scope, since a pass wrongly put together draws nothing and says so
 * only to the console. VITE_FRAME_DIR writes the frames.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDevice, halfToFloat, readbackLayer, type Gpu } from '../../gpu/context';
import { MeshBuilder, type Mesh } from '../../mesh/types';
import { bakeEnvironment } from '../../render/env';
import { DEFAULT_POST, FULL_ECONOMY, GameRenderer, PATTERN_STRIDE, type Antialias, type FrameMode, type GameEconomy, type GameGroup } from '../renderer';
import { LightPool } from '../lights';
import { FLOW_CRUST, FLOW_DRIFT, FLOW_RIPPLE, FLOW_WATER, packFlow } from '../flow';
import { differing, readPixels, saveFrame, type Pixels } from './frame';

const W = 192, H = 192;
/** The pipelines a renderer makes before `ready`, as v0.19.0's did: a game asking for nothing new makes no more. */
const PIPELINES_AT_0_19 = 46;
/** The flowing builds: toon or not, shadows, points and the cull, each rung of the ladder, and always patterned. */
const FLOWING_BUILDS = 16;
const DEAD_BLACK: [number, number, number] = [0, 0, 0];
const DARK: [number, number, number] = [0.1, 0.1, 0.1];
const RED: [number, number, number] = [0.9, 0.2, 0.1];
/** The camera: far off and long in the lens, so every point of the square is seen from the same direction and a pattern moved is a picture moved. */
const DISTANCE = 301.5, FOV = 3;
/** Pixels across a unit of the square, seen from there. */
const PX_PER_UNIT = H / (2 * DISTANCE * Math.tan((FOV / 2) * (Math.PI / 180)));

/** A square of `size` across the mesh's own x and y, facing up, about the origin. */
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

function ball(): Mesh {
  const b = new MeshBuilder();
  const rings = 16, segments = 24;
  for (let i = 0; i <= rings; i++) {
    const phi = (i / rings) * Math.PI;
    for (let j = 0; j <= segments; j++) {
      const th = (j / segments) * Math.PI * 2;
      const x = Math.sin(phi) * Math.cos(th), y = Math.sin(phi) * Math.sin(th), z = Math.cos(phi);
      b.vertex(x, y, z, x, y, z, 0, 0);
    }
  }
  const row = segments + 1;
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < segments; j++) b.quad(i * row + j, (i + 1) * row + j, (i + 1) * row + j + 1, i * row + j + 1);
  return b.build();
}

const at = (scale: number, x = 0, y = 0, z = 0) => new Float32Array([scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, x, y, z, 1]);

interface Flow {
  kind: number;
  scale?: number;
  speed?: number;
  glow?: number;
  second?: [number, number, number];
}

/** One placement's eight floats. */
function flowOf({ kind, scale = 1, speed = 0, glow = 0, second = RED }: Flow): Float32Array {
  return packFlow(new Float32Array(PATTERN_STRIDE), 0, { kind, scale, speed, glow, second });
}

describe('the flow material on the game renderer', () => {
  let gpu: Gpu;
  let env: ReturnType<typeof bakeEnvironment>;
  let r: GameRenderer;
  let target: GPUTexture;

  /** A renderer with the square's camera and a plain look, the frame shown straight. */
  async function make(mmPerUnit = 100, size = W): Promise<GameRenderer> {
    const renderer = new GameRenderer(gpu, 8, 8, 256, mmPerUnit);
    await renderer.ready;
    renderer.setEnvironment(env.specular, env.brdf, env.mips);
    renderer.resize(size, size);
    renderer.setLights(new LightPool(8));
    renderer.look = { ...renderer.look, background: [0.02, 0.02, 0.03], occlusion: 0 };
    renderer.post = { ...DEFAULT_POST, bloom: 0, vignette: 0, grain: 0, tone: 'clamp' };
    renderer.economy = { ...FULL_ECONOMY, shadows: true };
    renderer.camera.fov = FOV; renderer.camera.near = 100; renderer.camera.far = 600;
    renderer.camera.target = [0, 0, 0];
    renderer.camera.position = [0, -30, 300];
    return renderer;
  }

  beforeAll(async () => {
    gpu = await createDevice();
    env = bakeEnvironment(gpu, 'daylight', { size: 32, mips: 3 });
    await env.samples;
    target = gpu.device.createTexture({ size: [W, H], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    r = await make();
  });

  afterAll(() => { r?.dispose(); target?.destroy(); gpu?.device.destroy(); });

  beforeEach(() => {
    r.look = { ...r.look, shading: 'pbr', antialias: undefined, sunColour: [1, 1, 1], ambient: 1, exposure: 1 };
    r.economy = { ...FULL_ECONOMY, shadows: true };
    r.post = { ...DEFAULT_POST, bloom: 0, vignette: 0, grain: 0, tone: 'clamp' };
    r.time = 0;
    r.setStatic([]);
    r.setDynamic([]);
  });

  /** A twelve-unit square wearing one flow, its first colour `albedo`. */
  const square = (flow: Flow, albedo: [number, number, number] = DARK, roughness = 0.5, size = 12): GameGroup =>
    ({ mesh: plane(size), matrices: at(1), albedo, roughness, patterns: flowOf(flow) });

  /** One frame, read back, under an error scope that fails the test on a validation error. */
  async function draw(name = '', mode: FrameMode = 'redraw', renderer = r, tex = target): Promise<Pixels> {
    gpu.device.pushErrorScope('validation');
    const drew = renderer.frame(tex.createView(), mode, 0);
    const error = await gpu.device.popErrorScope();
    expect(error?.message ?? null).toBeNull();
    expect(drew).toBe(true);
    const px = await readPixels(gpu, tex);
    if (name) await saveFrame(`flow ${name}`, px);
    return px;
  }

  /** The square at `time`, once its builds are in. */
  async function at_(time: number, name = '', mode: FrameMode = 'redraw'): Promise<Pixels> {
    r.time = time;
    return draw(name, mode);
  }

  /** The pixels of the frame that lean toward red, and those that are grey, over the whole frame. */
  function hues(px: Pixels): { red: number; grey: number; bright: number } {
    let red = 0, grey = 0, bright = 0;
    for (let i = 0; i < px.rgb.length; i += 3) {
      const [a, g, b] = [px.rgb[i], px.rgb[i + 1], px.rgb[i + 2]];
      if (a > b + 40 && a > g + 30) red++;
      if (Math.abs(a - b) < 12 && Math.abs(a - g) < 12 && a > 8 && a < 90) grey++;
      if (a + g + b > 400) bright++;
    }
    return { red, grey, bright };
  }

  /** How bright the most is that any channel of any pixel gets. */
  const most = (px: Pixels) => px.rgb.reduce((m, v) => Math.max(m, v), 0);

  /** The standard deviation of one channel over the middle of the frame, where the square is. */
  function spread(px: Pixels): number {
    const v: number[] = [];
    for (let y = 60; y < 132; y++) for (let x = 60; x < 132; x++) v.push(px.rgb[(y * px.width + x) * 3 + 1]);
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    return Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  }

  /** The mean absolute difference between `a` moved `s` pixels along the frame's x and `b`, over the middle. */
  function misfit(a: Pixels, b: Pixels, s: number): number {
    let sum = 0, n = 0;
    for (let y = 60; y < 132; y++)
      for (let x = 60; x < 132; x++)
        for (let c = 0; c < 3; c++) {
          sum += Math.abs(b.rgb[(y * b.width + x) * 3 + c] - a.rgb[(y * a.width + x - s) * 3 + c]);
          n++;
        }
    return sum / n;
  }

  /** How far along the frame's x `b` is `a` moved, in whole pixels, and how well that fits against not moving at all. */
  function movedBy(a: Pixels, b: Pixels): { shift: number; fit: number; still: number } {
    let shift = 0, fit = Infinity;
    for (let s = -20; s <= 20; s++) {
      const m = misfit(a, b, s);
      if (m < fit) { fit = m; shift = s; }
    }
    return { shift, fit, still: misfit(a, b, 0) };
  }

  // a ripple from the second colour's blue into dark, a crust of dark plates cracked in orange, a drift of white flecks on blue-grey
  const KINDS: { name: string; flow: Flow; albedo: [number, number, number] }[] = [
    { name: 'ripple', flow: { kind: FLOW_RIPPLE, scale: 1, speed: 2, second: [0.1, 0.5, 0.9] }, albedo: [0.02, 0.1, 0.14] },
    { name: 'crust', flow: { kind: FLOW_CRUST, scale: 1, speed: 2, second: [1, 0.25, 0.02] }, albedo: [0.1, 0.07, 0.06] },
    { name: 'drift', flow: { kind: FLOW_DRIFT, scale: 1, speed: 2, second: [1, 1, 1] }, albedo: [0.3, 0.45, 0.6] },
  ];

  it('makes no pipeline for it until a group asks, and every group that does not draws as it did', async () => {
    const device = gpu.device as unknown as Record<string, (...a: unknown[]) => unknown>;
    let made = 0;
    const originals: Record<string, (...a: unknown[]) => unknown> = {};
    for (const m of ['createRenderPipelineAsync', 'createComputePipelineAsync', 'createRenderPipeline', 'createComputePipeline']) {
      originals[m] = device[m];
      device[m] = function (this: unknown, ...a: unknown[]) { made++; return originals[m].apply(this, a); };
    }
    try {
      const fresh = await make();
      expect(made, 'pipelines made before ready').toBe(PIPELINES_AT_0_19);
      // every kind that was there before, and none at all, in a static half and a dynamic one
      const old = (kind: number): GameGroup => ({ mesh: plane(12), matrices: at(1), albedo: DARK, roughness: 0.5, patterns: flowOf({ kind, scale: 1, speed: 0.3, second: RED }) });
      const none: GameGroup = { mesh: ball(), matrices: at(3, 0, 0, 3), albedo: DARK, roughness: 0.5 };
      for (const kind of [0, 1, 2, 3, 4]) {
        fresh.setStatic([old(kind)]);
        fresh.setDynamic([none]);
        await fresh.prepare();
        await draw('', 'redraw', fresh);
      }
      expect(made, 'pipelines made by groups with no flow').toBe(PIPELINES_AT_0_19);
      // a group of the old kinds with a mover over it, drawn before the flowing build exists and after: the same frame
      fresh.setStatic([old(4)]);
      fresh.setDynamic([none]);
      const speckle = await draw('', 'redraw', fresh);
      fresh.setStatic([square({ kind: FLOW_RIPPLE })]);
      expect(made, 'pipelines made at the first flowing group').toBe(PIPELINES_AT_0_19 + FLOWING_BUILDS);
      await fresh.prepare();
      fresh.setStatic([square({ kind: FLOW_CRUST })]);
      fresh.setDynamic([square({ kind: FLOW_DRIFT })]);
      await fresh.prepare();
      expect(made, 'and not made again for the next').toBe(PIPELINES_AT_0_19 + FLOWING_BUILDS);
      fresh.setStatic([old(4)]);
      fresh.setDynamic([none]);
      expect(differing(speckle, await draw('', 'redraw', fresh)), 'the old kinds, with the flowing build in').toBe(0);
      fresh.dispose();
    } finally {
      for (const m of Object.keys(originals)) device[m] = originals[m];
    }
  });

  it('writes the clock where nothing but the flowing build reads it: a group that does not flow draws the same at any time, in either look', async () => {
    const balls: GameGroup = {
      mesh: ball(), matrices: new Float32Array([...at(2, -4, 3, 2), ...at(2, 4, 3, 2)]), albedo: [0.6, 0.2, 0.1], roughness: 0.4,
      patterns: new Float32Array([...flowOf({ kind: 1, scale: 1, speed: 0.3 }), ...flowOf({ kind: 4, scale: 1, speed: 0.3 })]),
    };
    const plain: GameGroup = { mesh: ball(), matrices: at(2, 0, -5, 2), albedo: [0.3, 0.6, 0.2], roughness: 0.3 };
    for (const shading of ['pbr', 'toon'] as const) {
      r.look = { ...r.look, shading, occlusion: 2, occlusionRadius: 3 };
      r.setStatic([balls]);
      r.setDynamic([plain]);
      const then = await at_(0);
      expect(spread(then), 'a frame with something in it').toBeGreaterThan(0);
      expect(differing(then, await at_(77.3)), shading).toBe(0);
    }
    r.look = { ...r.look, occlusion: 0 };
  });

  for (const { name, flow, albedo } of KINDS)
    it(`draws a ${name}: a surface that is not one colour, and not the plain surface under it`, async () => {
      r.setStatic([square({ kind: 0 }, albedo)]);
      const plain = await draw();
      expect(spread(plain), 'the plain surface is one colour').toBeLessThan(3);
      r.setStatic([square(flow, albedo)]);
      await r.prepare();
      const px = await at_(1.5, name);
      expect(spread(px), 'a surface that is not one colour').toBeGreaterThan(4);
      expect(differing(plain, px), 'the pattern over the plain surface').toBeGreaterThan(3000);
    });

  it('shows the ripple\'s second colour toward its crests, and the crust\'s in thin cracks, as a drift\'s as flecks', async () => {
    const counts: Record<string, number> = {};
    for (const { name, flow, albedo } of KINDS) {
      r.setStatic([square({ ...flow, second: [1, 0.2, 0.1] }, albedo)]);
      await r.prepare();
      const h = hues(await at_(1.5));
      counts[name] = h.red;
    }
    // ripple's crests are broad, crust's cracks are thin lines, and a drift's flecks are patches
    expect(counts.ripple).toBeGreaterThan(300);
    expect(counts.crust).toBeGreaterThan(100);
    expect(counts.drift).toBeGreaterThan(300);
    expect(counts.crust).toBeLessThan(counts.ripple);
  });

  it('draws the same time as the same frame, and a time back again as it was', async () => {
    for (const { flow, albedo } of KINDS) {
      r.setStatic([square({ ...flow, glow: 0.5 }, albedo)]);
      await r.prepare();
      const a = await at_(4.25);
      expect(differing(a, await at_(4.25)), 'the same time twice').toBe(0);
      const later = await at_(6);
      expect(differing(a, later), 'a later time').toBeGreaterThan(1000);
      expect(differing(a, await at_(4.25)), 'and back again').toBe(0);
    }
  });

  it('moves a ripple and a crust along +x by the speed times the time between frames, and nothing else', async () => {
    const speed = 2, dt = 0.329;
    // the picture is the mesh's own x, laid on the frame from the left: along +x is toward the right
    const expected = speed * dt * PX_PER_UNIT;
    expect(expected).toBeGreaterThan(6);
    for (const { name, flow, albedo } of [KINDS[0], KINDS[1]]) {
      // the crust with no glow, since its glow has a slow pulse of its own that moves nothing along
      r.setStatic([square({ ...flow, speed, glow: 0 }, albedo)]);
      await r.prepare();
      const a = await at_(3);
      const b = await at_(3 + dt);
      const { shift, fit, still } = movedBy(a, b);
      expect(Math.abs(shift - expected), `${name}: the shift of ${shift} pixels, where ${expected.toFixed(1)} is the speed`).toBeLessThanOrEqual(1.5);
      expect(fit, `${name}: moved, it is the same picture`).toBeLessThan(still * 0.5);
      // and the other way, backward in time, moves it back
      const c = await at_(3 - dt);
      expect(movedBy(a, c).shift, `${name} backward`).toBeLessThan(0);
    }
  });

  it('moves the drift\'s flecks and not its scratches, and a speed of nought moves none of it', async () => {
    const { flow, albedo } = KINDS[2];
    r.setStatic([square({ ...flow, speed: 0 }, albedo)]);
    await r.prepare();
    expect(differing(await at_(1), await at_(50)), 'at a speed of nought').toBe(0);
    for (const k of [KINDS[0], KINDS[1]]) {
      r.setStatic([square({ ...k.flow, speed: 0 }, k.albedo)]);
      await r.prepare();
      expect(differing(await at_(1), await at_(50)), `${k.name} at a speed of nought`).toBe(0);
    }
    // what moves is the time times the speed, so half the speed at twice the time is the same frame
    r.setStatic([square({ ...flow, speed: 2 }, albedo)]);
    const a = await at_(3);
    r.setStatic([square({ ...flow, speed: 1 }, albedo)]);
    expect(differing(a, await at_(6))).toBe(0);
    // the flecks move, the scratches stay: of two pictures a step apart most of what is left alone is the scratch
    r.setStatic([square({ ...flow, speed: 2 }, albedo)]);
    const b = await at_(3.4);
    expect(differing(a, b), 'the flecks').toBeGreaterThan(500);
    expect(differing(a, b), 'and not all of the surface').toBeLessThan(W * H * 0.4);
  });

  it('lights a surface that has no light on it, by the glow, and not at all by a glow of nought', async () => {
    // matte, so the toon look's sheen, which is the sky in a clear coat and not its ambient's, has none to show
    r.look = { ...r.look, sunColour: [0, 0, 0], ambient: 0, background: DEAD_BLACK };
    for (const shading of ['pbr', 'toon'] as const) {
      r.look = { ...r.look, shading };
      for (const { name, flow, albedo } of KINDS) {
        r.setStatic([square({ ...flow, second: [1, 0.2, 0.05], glow: 0 }, albedo, 1)]);
        await r.prepare();
        const dark = await at_(2);
        expect(most(dark), `${name} ${shading}, with a glow of nought, in the dark`).toBeLessThan(4);
        r.setStatic([square({ ...flow, second: [1, 0.2, 0.05], glow: 3 }, albedo, 1)]);
        const lit = await at_(2, `glow ${name} ${shading}`);
        const h = hues(lit);
        expect(h.red, `${name} ${shading}, glowing, in the dark`).toBeGreaterThan(100);
        // what it gives out is the second colour's: red leads, green follows, blue is least
        let r1 = 0, g1 = 0, b1 = 0;
        for (let i = 0; i < lit.rgb.length; i += 3) { r1 += lit.rgb[i]; g1 += lit.rgb[i + 1]; b1 += lit.rgb[i + 2]; }
        expect(r1).toBeGreaterThan(g1);
        expect(g1).toBeGreaterThan(b1);
      }
    }
  });

  it('adds the glow whatever light falls on the surface, and more of it for more glow', async () => {
    const { flow, albedo } = KINDS[1];
    r.setStatic([square({ ...flow, glow: 0 }, albedo)]);
    await r.prepare();
    const lit = await at_(2);
    r.setStatic([square({ ...flow, glow: 1 }, albedo)]);
    const glowing = await at_(2);
    r.setStatic([square({ ...flow, glow: 3 }, albedo)]);
    const more = await at_(2);
    const total = (p: Pixels) => p.rgb.reduce((s, v) => s + v, 0);
    expect(total(glowing)).toBeGreaterThan(total(lit));
    expect(total(more)).toBeGreaterThan(total(glowing));
  });

  it('turns the ripple\'s normal by the slope of its field, so a glossy surface of one colour is not shaded evenly', async () => {
    // the second colour the first, so what varies over the surface can only be the light, and the light only the normal
    r.look = { ...r.look, ambient: 0, sunColour: [4, 4, 4], sunDir: [0.0, -0.5, 0.87] };
    const same: [number, number, number] = [0.3, 0.3, 0.3];
    r.setStatic([square({ kind: 0 }, same, 0.15)]);
    await r.prepare();
    const flat = await at_(1);
    r.setStatic([square({ kind: FLOW_RIPPLE, scale: 1, speed: 0, second: same }, same, 0.15)]);
    const rippled = await at_(1, 'ripple one colour');
    expect(spread(flat), 'a flat surface').toBeLessThan(2);
    expect(spread(rippled), 'a rippled one').toBeGreaterThan(spread(flat) + 4);
    // and the highlight moves with the ripple: a surface that has travelled has its light elsewhere
    r.setStatic([square({ kind: FLOW_RIPPLE, scale: 1, speed: 2, second: same }, same, 0.15)]);
    expect(differing(await at_(1), await at_(2)), 'the light on the water after it has moved').toBeGreaterThan(1000);
  });

  it('turns the normal with the mesh, not the screen: a square turned about its own up draws the same ripple, turned', async () => {
    r.look = { ...r.look, ambient: 0, sunColour: [4, 4, 4], sunDir: [0.0, -0.5, 0.87] };
    const same: [number, number, number] = [0.3, 0.3, 0.3];
    const flow = { kind: FLOW_RIPPLE, scale: 1, speed: 0, second: same };
    // the ripple's highlights lie across x and y alike; put the square on its side and the field stays on the square
    const g = square(flow, same, 0.15);
    g.matrices = new Float32Array([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]);
    r.camera.position = [0, -300, 30];
    r.setStatic([g]);
    await r.prepare();
    const side = await at_(1);
    r.camera.position = [0, -30, 300];
    expect(spread(side), 'a ripple on a square stood up').toBeGreaterThan(3);
  });

  it('draws before its build is in as the speckle of the patterned build, still and without glow, and as the flow after', async () => {
    const fresh = await make();
    const flow: Flow = { kind: FLOW_RIPPLE, scale: 1, speed: 0.4, glow: 2, second: [0.1, 0.5, 0.9] };
    const make1 = () => gpu.device.createTexture({ size: [W, H], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const [a, b] = [make1(), make1()];
    fresh.setStatic([square(flow)]);
    // asked for, not waited on: both frames are drawn in the one turn, before any compile can land
    fresh.time = 0;
    const early = draw('', 'redraw', fresh, a);
    fresh.time = 5;
    const later = draw('', 'redraw', fresh, b);
    const [first, second] = [await early, await later];
    expect(differing(first, second), 'it does not move before it is in').toBe(0);
    // the speckle of the second colour, which is the patterned build's kind four from the same floats
    fresh.setStatic([{ ...square(flow), patterns: flowOf({ kind: 4, scale: 1, speed: 0.4, glow: 2, second: [0.1, 0.5, 0.9] }) }]);
    expect(differing(first, await draw('', 'redraw', fresh, a)), 'is kind four').toBe(0);
    fresh.setStatic([square(flow)]);
    await fresh.prepare();
    fresh.time = 0;
    const after = await draw('', 'redraw', fresh, a);
    expect(differing(first, after), 'and after, it is the flow').toBeGreaterThan(1000);
    fresh.time = 5;
    expect(differing(after, await draw('', 'redraw', fresh, b)), 'and it moves').toBeGreaterThan(1000);
    a.destroy(); b.destroy();
    fresh.dispose();
  });

  it('draws the old kinds in a group that also flows as it draws them in one that does not, and a kind it does not know as none', async () => {
    // three balls on the one mesh: two of the old kinds above, and below them a third that is the placement under test
    const ballsWith = (third: Float32Array, second: number): GameGroup => ({
      mesh: ball(),
      matrices: new Float32Array([...at(2, -4, 3, 2), ...at(2, 4, 3, 2), ...at(2, 0, -6, 2)]),
      albedo: [0.6, 0.2, 0.1], roughness: 0.4,
      patterns: new Float32Array([...flowOf({ kind: 1, scale: 1, speed: 0.3 }), ...flowOf({ kind: second, scale: 1, speed: 0.3 }), ...third]),
    });
    const part = (px: Pixels) => ({ ...px, rgb: px.rgb.subarray(0, px.width * 110 * 3), height: 110 });
    r.look = { ...r.look, sunColour: [2, 2, 2], ambient: 1 };
    r.setStatic([ballsWith(flowOf({ kind: 3, scale: 1 }), 4)]);
    await r.prepare();
    const old = part(await at_(2));
    expect(spread(await at_(2)), 'a frame with something in it').toBeGreaterThan(0);
    r.setStatic([ballsWith(flowOf({ kind: FLOW_RIPPLE, scale: 1, speed: 1, glow: 1 }), 4)]);
    await r.prepare();
    expect(differing(old, part(await at_(2))), 'the old kinds beside a flowing one').toBe(0);
    // and a kind past the three is none, not the speckle the patterned build would make of it
    r.setStatic([ballsWith(flowOf({ kind: FLOW_RIPPLE, scale: 1, speed: 1, glow: 1 }), 0)]);
    await r.prepare();
    const none = part(await at_(2));
    // eleven, past every kind there is: nine is clear water and ten a glow since v0.29.0, each drawn by a build of its own
    r.setStatic([ballsWith(flowOf({ kind: FLOW_RIPPLE, scale: 1, speed: 1, glow: 1 }), 11)]);
    await r.prepare();
    expect(differing(none, part(await at_(2))), 'a kind of eleven, among flowing ones').toBe(0);
  });

  it('has its build in when `prepare` says so, with nothing waited on but that', async () => {
    const fresh = await make();
    const tex = () => gpu.device.createTexture({ size: [W, H], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const [a, b] = [tex(), tex()];
    fresh.setStatic([square({ kind: FLOW_RIPPLE, scale: 1, speed: 1, second: [0.1, 0.5, 0.9] })]);
    await fresh.prepare();
    // both frames in the one turn, so no compile can land between them and the first
    fresh.time = 1;
    const one = draw('', 'redraw', fresh, a);
    fresh.time = 2;
    const two = draw('', 'redraw', fresh, b);
    expect(differing(await one, await two), 'the ripple moves in the first frame after `prepare`').toBeGreaterThan(1000);
    a.destroy(); b.destroy();
    fresh.dispose();
  });

  it('does not freeze a flowing group in the kept static half, and keeps the rest', async () => {
    for (const aa of ['none', 'msaa'] as const) {
      r.look = { ...r.look, antialias: aa };
      const still: GameGroup = { mesh: ball(), matrices: at(2, 4, 3, 2), albedo: [0.7, 0.2, 0.1], roughness: 0.5 };
      const mover: GameGroup = { mesh: ball(), matrices: at(2, -4, 3, 2), albedo: [0.2, 0.7, 0.1], roughness: 0.5 };
      r.setStatic([{ ...square({ kind: FLOW_CRUST, scale: 1, speed: 2, second: [1, 0.3, 0.05] }), roughness: 0.5 }, still]);
      r.setDynamic([mover]);
      await r.prepare();
      const first = await at_(1, '', 'keep');
      expect(differing(first, await at_(1, '', 'redraw')), `${aa}: the first kept frame is a drawn one`).toBe(0);
      const kept = await at_(2.5, `keep ${aa}`, 'keep');
      const fresh = await at_(2.5, '', 'redraw');
      expect(differing(first, kept), `${aa}: a kept frame has moved`).toBeGreaterThan(1000);
      expect(differing(kept, fresh), `${aa}: and is the frame drawn afresh`).toBe(0);
      // and what is kept is kept: the ball in the static half is the same pixels in both
      r.setDynamic([]);
      const lone = await at_(2.5, '', 'keep');
      expect(differing(lone, await at_(2.5, '', 'redraw'))).toBe(0);
    }
  });

  it('draws in every build the ladder can ask for, in both looks, and each is the flowing one', async () => {
    r.setStatic([square({ kind: FLOW_RIPPLE, scale: 1, speed: 3, second: [0.1, 0.5, 0.9] }, [0.02, 0.1, 0.14])]);
    r.setDynamic([{ mesh: ball(), matrices: at(2, 4, 3, 2), albedo: [0.7, 0.2, 0.1], roughness: 0.5 }]);
    await r.prepare();
    for (const shading of ['pbr', 'toon'] as const)
      for (const rung of [{}, { shadows: false }, { points: false }, { cullLights: false }, { shadows: false, points: false, cullLights: false }] as Partial<GameEconomy>[]) {
        r.look = { ...r.look, shading };
        r.economy = { ...FULL_ECONOMY, shadows: true, ...rung };
        const a = await at_(1);
        const b = await at_(2);
        expect(differing(a, b), `${shading} ${JSON.stringify(rung)} moves`).toBeGreaterThan(1000);
      }
    r.economy = { ...FULL_ECONOMY, shadows: true };
    const top = await at_(1);
    r.economy = { ...FULL_ECONOMY, shadows: true, points: false };
    await at_(1);
    r.economy = { ...FULL_ECONOMY, shadows: true };
    expect(differing(top, await at_(1)), 'stepped down and back').toBe(0);
  });

  it('draws with every tone map, and holds it finite with a glow as large as can be asked', async () => {
    r.look = { ...r.look, sunColour: [0, 0, 0], ambient: 0, background: DEAD_BLACK };
    r.setStatic([square({ kind: FLOW_CRUST, scale: 1, speed: 1, glow: 1e9, second: [1, 0.3, 0.05] }, DARK)]);
    await r.prepare();
    for (const tone of ['filmic', 'clamp', 'soft'] as const) {
      r.post = { ...r.post, tone };
      const px = await at_(1.5, `glow ${tone}`);
      expect(most(px), `${tone}: it lights the dark`).toBeGreaterThan(200);
      // the frame before the tone map is a number everywhere, and never past a half float
      await gpu.queue.onSubmittedWorkDone();
      const tex = r.hdr.colour!;
      const half = new Uint16Array(await readbackLayer(gpu.device, tex, 0, 0, tex.width, tex.height));
      let bad = 0, top = 0;
      for (let i = 0; i < half.length; i++) {
        if (i % 4 === 3) continue;
        const v = halfToFloat(half[i]);
        if (!Number.isFinite(v)) bad++;
        else top = Math.max(top, v);
      }
      expect(bad, `${tone}: channels that are infinite or not a number`).toBe(0);
      expect(top, `${tone}: the brightest channel`).toBeLessThan(65504);
    }
    r.post = { ...r.post, tone: 'clamp' };
  });

  it('draws each antialiasing mode, flowing, and the same pixels in the middle of the surface as with none', async () => {
    r.setStatic([square({ kind: FLOW_RIPPLE, scale: 1, speed: 3, second: [0.1, 0.5, 0.9] }, [0.02, 0.1, 0.14])]);
    await r.prepare();
    const none = await at_(1, 'aa none');
    const modes: Antialias[] = ['fxaa', 'msaa'];
    for (const aa of modes) {
      r.look = { ...r.look, antialias: aa };
      await r.prepare();
      const a = await at_(1, `aa ${aa}`);
      const b = await at_(2);
      expect(differing(a, b), `${aa} moves, so it is the flowing build`).toBeGreaterThan(1000);
      let sum = 0, n = 0;
      for (let y = 70; y < 122; y++) for (let x = 70; x < 122; x++) for (let c = 0; c < 3; c++) { sum += Math.abs(a.rgb[(y * W + x) * 3 + c] - none.rgb[(y * W + x) * 3 + c]); n++; }
      // four samples leave the inside of a surface as it was; FXAA softens detail within it, a little
      expect(sum / n, `${aa}: the inside of the surface`).toBeLessThan(aa === 'msaa' ? 1 : 6);
    }
  });

  it('is in for four samples at once when four samples are asked for after it, and when before', async () => {
    const device = gpu.device as unknown as Record<string, (...a: unknown[]) => unknown>;
    let made = 0;
    const originals: Record<string, (...a: unknown[]) => unknown> = {};
    for (const m of ['createRenderPipelineAsync', 'createRenderPipeline']) {
      originals[m] = device[m];
      device[m] = function (this: unknown, ...a: unknown[]) { made++; return originals[m].apply(this, a); };
    }
    try {
      // flowing first, four samples after: the flowing builds are made again at four samples
      const first = await make();
      first.setStatic([square({ kind: FLOW_RIPPLE, speed: 1 })]);
      await first.prepare();
      const flowingAlone = made;
      first.look = { ...first.look, antialias: 'msaa' };
      await first.prepare();
      const msaaAfter = made - flowingAlone;
      first.time = 1;
      const a = await draw('', 'redraw', first);
      first.time = 2;
      expect(differing(a, await draw('', 'redraw', first)), 'flowing at four samples, flow asked first').toBeGreaterThan(1000);
      first.dispose();
      // four samples first, flowing after
      const second = await make();
      second.look = { ...second.look, antialias: 'msaa' };
      await second.prepare();
      const msaaAlone = made;
      second.setStatic([square({ kind: FLOW_RIPPLE, speed: 1 })]);
      await second.prepare();
      expect(made - msaaAlone, 'the flowing builds, at one sample and at four').toBe(FLOWING_BUILDS * 2);
      second.time = 1;
      const b = await draw('', 'redraw', second);
      second.time = 2;
      expect(differing(b, await draw('', 'redraw', second)), 'flowing at four samples, four samples asked first').toBeGreaterThan(1000);
      expect(msaaAfter, 'four samples after flow: its own builds and the flowing ones at four samples').toBe(32 + 1 + 1 + 2 + 1 + FLOWING_BUILDS);
      second.dispose();
    } finally {
      for (const m of Object.keys(originals)) device[m] = originals[m];
    }
  });

  it('reads a surface in the mesh\'s own units, so a world in millimetres draws what a world in tenths of a metre does', async () => {
    // the same square, 12 units across at a scale of one cell a unit, and in a world of millimetres, 12000 across at a scale of one cell a thousand
    const small = await make(100);
    small.look = { ...small.look, sunColour: [1, 1, 1], ambient: 1 };
    small.setStatic([square({ kind: FLOW_RIPPLE, scale: 1, speed: 2, second: [0.1, 0.5, 0.9] })]);
    await small.prepare();
    small.time = 2.5;
    const a = await draw('', 'redraw', small);
    small.dispose();
    const mm = await make(1);
    mm.look = { ...mm.look, sunColour: [1, 1, 1], ambient: 1 };
    // every length the game hands over is in the world's own: the camera and the matrix are in millimetres here
    mm.camera.position = [0, -30000, 300000]; mm.camera.target = [0, 0, 0]; mm.camera.near = 100000; mm.camera.far = 600000;
    mm.setStatic([{ mesh: plane(12000), matrices: at(1), albedo: DARK, roughness: 0.5, patterns: flowOf({ kind: FLOW_RIPPLE, scale: 0.001, speed: 2000, second: [0.1, 0.5, 0.9] }) }]);
    await mm.prepare();
    mm.time = 2.5;
    const b = await draw('', 'redraw', mm);
    mm.dispose();
    let sum = 0, n = 0;
    for (let y = 50; y < 142; y++) for (let x = 50; x < 142; x++) for (let c = 0; c < 3; c++) { sum += Math.abs(a.rgb[(y * W + x) * 3 + c] - b.rgb[(y * W + x) * 3 + c]); n++; }
    expect(sum / n).toBeLessThan(1.5);
  });

  it('holds its placements at capacity and past it, with the rest of the group none', async () => {
    // three placements, the patterns for one of them: the other two are kind none, and a count of two never draws the third
    const g = square({ kind: FLOW_RIPPLE, speed: 1, second: [0.1, 0.5, 0.9] });
    g.matrices = new Float32Array([...at(1, -5, 0), ...at(1, 5, 0), ...at(1, 0, 8)]);
    g.count = 2;
    r.setStatic([g]);
    await r.prepare();
    const two = await at_(1);
    g.count = 3;
    r.setStatic([g]);
    const three = await at_(1);
    expect(differing(two, three)).toBeGreaterThan(100);
    // patterns beyond the group's capacity are dropped, never grown
    const long: GameGroup = { ...g, patterns: new Float32Array(PATTERN_STRIDE * 40).fill(0).map((_, i) => (i % PATTERN_STRIDE === 0 ? 5 : 1)) };
    r.setStatic([long]);
    await at_(1);
  });

  it('draws at a pixel, at an odd size and resized back, and is disposed with everything it made', async () => {
    r.setStatic([square({ kind: FLOW_CRUST, speed: 1, glow: 1 })]);
    r.setDynamic([square({ kind: FLOW_DRIFT, speed: 1 })]);
    await r.prepare();
    for (const [w, h] of [[1, 1], [37, 23], [W, H]]) {
      r.resize(w, h);
      const t = gpu.device.createTexture({ size: [w, h], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      gpu.device.pushErrorScope('validation');
      expect(r.frame(t.createView(), 'redraw')).toBe(true);
      expect(r.frame(t.createView(), 'keep')).toBe(true);
      expect((await gpu.device.popErrorScope())?.message ?? null).toBeNull();
      t.destroy();
    }
    const fresh = await make();
    fresh.setStatic([square({ kind: FLOW_RIPPLE })]);
    await fresh.prepare();
    gpu.device.pushErrorScope('validation');
    fresh.dispose();
    expect((await gpu.device.popErrorScope())?.message ?? null).toBeNull();
  });

  // open water: kind eight, waves in the world, lit as a mirror of the sky with a glint of the camera's own
  const WATER: Flow = { kind: FLOW_WATER, scale: 0.4, speed: 1, glow: 0.3, second: [0.6, 0.8, 1] };
  const BODY: [number, number, number] = [0.02, 0.12, 0.2];

  /** The middle of the frame, which a square turned about its own up always fills: the mean of all three channels, and the pixels that are near white, which the sea's body and mirror never reach and a glint does. */
  function middle(px: Pixels, bright = 235): { mean: number; glints: number } {
    let sum = 0, glints = 0, n = 0;
    for (let y = 60; y < 132; y++)
      for (let x = 60; x < 132; x++) {
        const i = (y * px.width + x) * 3;
        const v = px.rgb[i] + px.rgb[i + 1] + px.rgb[i + 2];
        sum += v / 3; n++;
        if (v / 3 > bright) glints++;
      }
    return { mean: sum / n, glints };
  }

  it('draws open water: a surface that is not one colour, not the plain one under it, and not a ripple', async () => {
    r.setStatic([square({ kind: 0 }, BODY)]);
    const plain = await draw();
    r.setStatic([square(WATER, BODY)]);
    await r.prepare();
    const water = await at_(1.5, 'water');
    expect(spread(water), 'a surface that is not one colour').toBeGreaterThan(4);
    expect(differing(plain, water), 'the water over the plain surface').toBeGreaterThan(3000);
    for (const px of [plain, water]) for (const v of px.rgb) expect(Number.isNaN(v)).toBe(false);
    r.setStatic([square({ kind: FLOW_RIPPLE, scale: 0.4, speed: 1, glow: 0.3, second: [0.6, 0.8, 1] }, BODY)]);
    expect(differing(await at_(1.5), water), 'water is not a ripple').toBeGreaterThan(3000);
  });

  it('draws water at the same time as the same frame, and a later time as another', async () => {
    r.setStatic([square(WATER, BODY)]);
    await r.prepare();
    const a = await at_(4.25);
    expect(differing(a, await at_(4.25)), 'the same time twice').toBe(0);
    expect(differing(a, await at_(5.5)), 'a later time').toBeGreaterThan(1000);
    expect(differing(a, await at_(4.25)), 'and back again').toBe(0);
    // and a speed of nought holds it still
    r.setStatic([square({ ...WATER, speed: 0 }, BODY)]);
    expect(differing(await at_(1), await at_(50)), 'at a speed of nought').toBe(0);
  });

  it('lays its waves in the world, not on the mesh: a square moved over the water shows other waves, and two squares side by side are one sea', async () => {
    // the same square at two places is two views of one sea, so the picture of it moves with it
    const g = (x: number): GameGroup => ({ ...square(WATER, BODY, 0.5, 12), matrices: at(1, x, 0, 0) });
    r.setStatic([g(0)]);
    await r.prepare();
    const here = await at_(2);
    r.setStatic([g(0.7)]);
    expect(differing(here, await at_(2)), 'a square moved').toBeGreaterThan(1000);
    // two squares that meet are drawn as one: the seam between them is no brighter a line than any other
    r.setStatic([{ ...square(WATER, BODY, 0.5, 6), matrices: new Float32Array([...at(1, -3, 0, 0), ...at(1, 3, 0, 0)]), patterns: new Float32Array([...flowOf(WATER), ...flowOf(WATER)]) }]);
    const two = await at_(2, 'water two squares');
    r.setStatic([square(WATER, BODY, 0.5, 12)]);
    const one = await at_(2, 'water one square');
    // the two cover a band twelve by six, so the rows they share with the one are the band's middle
    const band = (px: Pixels): Pixels => ({ ...px, rgb: px.rgb.subarray(75 * px.width * 3, 118 * px.width * 3), height: 43 });
    expect(spread(two), 'the two are drawn').toBeGreaterThan(4);
    expect(differing(band(one), band(two)), 'one square of twelve and two of six, which are one sea').toBeLessThan(43 * W * 0.01);
  });

  it('puts the glint where the camera is: turned about the surface\'s up by a large angle, from a low view, the water is as bright and has glints from every side', async () => {
    // at the steepness a game gives its sea (0.8 in ooergolf), where the swell is weak and the glints are the fine waves'
    r.setStatic([square({ ...WATER, glow: 0.8 }, BODY, 0.3)]);
    await r.prepare();
    // thirty degrees above the horizon, where the mirror's glint is well to one side of straight down, so a glint fixed in
    // the world and not the camera's would be found on one heading and lost on the next
    const LOW = [0, -300 * Math.cos(0.5), 300 * Math.sin(0.5)];
    const turn = (angle: number): [number, number, number] =>
      [LOW[0] * Math.cos(angle) - LOW[1] * Math.sin(angle), LOW[0] * Math.sin(angle) + LOW[1] * Math.cos(angle), LOW[2]];
    const seen: { mean: number; glints: number }[] = [];
    for (const angle of [0, 1.6, 3.1, 4.7, 2.4, -1.3]) {
      r.camera.position = turn(angle);
      seen.push(middle(await at_(2, `water low turned ${angle}`)));
    }
    r.camera.position = [0, -30, 300];
    const means = seen.map((s) => s.mean), glints = seen.map((s) => s.glints);
    const [lo, hi] = [Math.min(...means), Math.max(...means)];
    expect(lo, 'not a black frame').toBeGreaterThan(8);
    expect(hi / lo, `the mean brightness, ${means.map((m) => m.toFixed(1))}, in every heading`).toBeLessThan(1.25);
    // every heading has glints, and not the few a fixed glint would leave on the one heading it faces: the sea is the same
    // sea from each side and the fine waves are not, so the counts differ by a few times and are never nought
    expect(Math.min(...glints), `the glints, ${glints}, in every heading`).toBeGreaterThan(15);
  });

  it('is a flat sea at a steepness of nought, one colour, and a steeper sea is not', async () => {
    r.setStatic([square({ ...WATER, glow: 0 }, BODY, 0.3)]);
    await r.prepare();
    const flat = await at_(2);
    expect(spread(flat), 'a flat sea is one colour').toBeLessThan(2);
    r.setStatic([square({ ...WATER, glow: 0.6 }, BODY, 0.3)]);
    expect(spread(await at_(2)), 'a steep one is not').toBeGreaterThan(spread(flat) + 4);
  });

  it('keeps water finite with a steepness as large as can be asked, and draws it in both looks and under every rung', async () => {
    for (const shading of ['pbr', 'toon'] as const)
      for (const rung of [{}, { shadows: false, points: false, cullLights: false }] as Partial<GameEconomy>[]) {
        r.look = { ...r.look, shading };
        r.economy = { ...FULL_ECONOMY, shadows: true, ...rung };
        r.setStatic([square({ ...WATER, glow: 1e9 }, BODY)]);
        await r.prepare();
        const px = await at_(2);
        expect(Number.isNaN(most(px))).toBe(false);
        expect(spread(await at_(3)), `${shading} ${JSON.stringify(rung)}`).toBeGreaterThanOrEqual(0);
      }
    r.economy = { ...FULL_ECONOMY, shadows: true };
  });

  it('compiles no more for water than for the other flow kinds: the flowing builds are the same sixteen', async () => {
    const device = gpu.device as unknown as Record<string, (...a: unknown[]) => unknown>;
    let made = 0;
    const originals: Record<string, (...a: unknown[]) => unknown> = {};
    for (const m of ['createRenderPipelineAsync', 'createComputePipelineAsync', 'createRenderPipeline', 'createComputePipeline']) {
      originals[m] = device[m];
      device[m] = function (this: unknown, ...a: unknown[]) { made++; return originals[m].apply(this, a); };
    }
    try {
      const fresh = await make();
      expect(made, 'pipelines made before ready').toBe(PIPELINES_AT_0_19);
      fresh.setStatic([square(WATER, BODY)]);
      await fresh.prepare();
      expect(made, 'pipelines made for the first group of water').toBe(PIPELINES_AT_0_19 + FLOWING_BUILDS);
      fresh.dispose();
    } finally {
      for (const m of Object.keys(originals)) device[m] = originals[m];
    }
  });

  it('draws nothing before the environment, as the game path never has, and says so', async () => {
    const bare = new GameRenderer(gpu, 8, 8, 64, 100);
    await bare.ready;
    bare.setStatic([square({ kind: FLOW_RIPPLE })]);
    expect(bare.frame(target.createView())).toBe(false);
    bare.dispose();
  });
});
