/**
 * What the frame holds before the tone map, on a real device: a half float,
 * which has nothing past 65504. A mirror-smooth face at the mirror angle to
 * a bright lamp asks for a great deal more than that — the highlight's peak
 * goes with the inverse fourth power of the roughness — and what is written
 * past the top of a half float is infinity. The bright pass divides a
 * luminance by itself, which for infinity is not a number; the blur spreads
 * that over its whole kernel; and the tone map makes of it whatever the
 * machine's compiler does with not-a-number under a clamp: a white glint on
 * one, a black hole the size of the bloom on another. It was black in
 * Firefox on Windows, in a game with chrome paint at a roughness of 0.05
 * under lamps of sixteen.
 *
 * Which it is depends on the GPU before it depends on the compiler: a write
 * past the top of a half float is infinity on Direct3D hardware, and on an
 * Apple GPU it is held at 65504, so on a Mac there is nothing to see and no
 * infinity to find. So the test is in two halves. The scene, on any machine,
 * must never ask the frame for as much as it can hold: a channel at the top
 * of a half float is a channel that asked for more. And the passes that read
 * the frame are handed infinity and not-a-number directly, written into a
 * texture of their own, which any machine can do: what comes out must be a
 * number everywhere, infinity shown white, and neither spread.
 */
/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevice, halfToFloat, readbackLayer, type Gpu } from '../../gpu/context';
import { bakeEnvironment } from '../../render/env';
import { MeshBuilder } from '../../mesh/types';
import { EFFECT_STRIDE, GameRenderer, type GameGroup } from '../renderer';
import { BRIGHT_WGSL, COMPOSITE_WGSL } from '../shaders';
import { LightPool } from '../lights';

const SIZE = 256;
/** The most a half float holds: a channel at it asked for more. */
const HALF_MAX = 65504;
/** The angle of the camera and of the lamp off the face's normal, either side of it: the mirror angle. */
const TILT = Math.PI / 6;
const AWAY = 2000;

/** A flat square facing up, `size` across, about the origin. */
function face(size: number) {
  const b = new MeshBuilder();
  const h = size / 2;
  const a = b.vertex(-h, -h, 0, 0, 0, 1, 0, 0);
  b.vertex(h, -h, 0, 0, 0, 1, 1, 0);
  b.vertex(h, h, 0, 0, 0, 1, 1, 1);
  b.vertex(-h, h, 0, 0, 0, 1, 0, 1);
  b.quad(a, a + 1, a + 2, a + 3);
  return b.build();
}

const identity = () => {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
};

describe('what the frame holds before the tone map', () => {
  let gpu: Gpu;
  let renderer: GameRenderer;
  let target: GPUTexture;
  const view = () => target.createView();

  beforeAll(async () => {
    gpu = await createDevice();
    renderer = new GameRenderer(gpu, 8, 8, 64);
    await renderer.ready;
    target = gpu.device.createTexture({
      size: [SIZE, SIZE], format: gpu.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const env = bakeEnvironment(gpu, 'studio', { size: 32, mips: 3 });
    await env.samples;
    renderer.setEnvironment(env.specular, env.brdf, env.mips);
    renderer.resize(SIZE, SIZE);
    // chrome, as the game that found this paints it
    const chrome: GameGroup = { mesh: face(400), matrices: identity(), albedo: [0.9, 0.9, 0.95], roughness: 0.05 };
    renderer.setStatic([chrome]);
    renderer.setDynamic([]);
    // a long lens from far off, so the whole middle of the frame is within the highlight's width
    renderer.camera.position = [0, -AWAY * Math.sin(TILT), AWAY * Math.cos(TILT)];
    renderer.camera.target = [0, 0, 0];
    renderer.camera.fov = 2;
    renderer.camera.near = 10;
    renderer.camera.far = 8000;
    // the lamp alone: no sun, no sky, and a fall so slow it is as bright at the face as where it hangs
    renderer.look = { ...renderer.look, ambient: 0, sunColour: [0, 0, 0], background: [0, 0, 0], exposure: 1, falloffHalf: 1e6, occlusion: 0 };
    renderer.post = { bloom: 0.45, threshold: 1.25, knee: 0.5, vignette: 0, grain: 0 };
  });

  afterAll(() => { renderer?.dispose(); target?.destroy(); gpu?.device.destroy(); });

  /** A lamp at the mirror angle to the camera, as bright as asked. */
  function lamp(intensity: number) {
    const pool = new LightPool(8);
    pool.add({ position: [0, AWAY * Math.sin(TILT), AWAY * Math.cos(TILT)], radius: 1e5, colour: [1, 1, 1], intensity });
    renderer.setLights(pool);
  }

  /** Every channel of a half-float texture, as numbers. */
  async function floats(texture: GPUTexture): Promise<Float64Array> {
    await gpu.queue.onSubmittedWorkDone();
    const half = new Uint16Array(await readbackLayer(gpu.device, texture, 0, 0, texture.width, 8));
    const out = new Float64Array(half.length);
    for (let i = 0; i < half.length; i++) out[i] = halfToFloat(half[i]);
    return out;
  }
  /** How many of the colour channels are not finite numbers, and the most any of them is. */
  function census(values: Float64Array) {
    let bad = 0, most = 0;
    for (let i = 0; i < values.length; i++) {
      if (i % 4 === 3) continue;
      if (!Number.isFinite(values[i])) bad++;
      else most = Math.max(most, values[i]);
    }
    return { bad, most };
  }

  /** The displayed frame's brightness, a byte a pixel. */
  async function shown(): Promise<(x: number, y: number) => number> {
    await gpu.queue.onSubmittedWorkDone();
    const row = Math.ceil((SIZE * 4) / 256) * 256;
    const buffer = gpu.device.createBuffer({ size: row * SIZE, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = gpu.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow: row, rowsPerImage: SIZE }, [SIZE, SIZE, 1]);
    gpu.queue.submit([enc.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(buffer.getMappedRange().slice(0));
    buffer.unmap(); buffer.destroy();
    return (x, y) => (px[y * row + x * 4] + px[y * row + x * 4 + 1] + px[y * row + x * 4 + 2]) / 3;
  }

  it('is a modest number under a modest lamp, so the rest of this measures the lamp and not the scene', async () => {
    lamp(0.001);
    renderer.frame(view());
    const { bad, most } = census(await floats(renderer.hdr.colour!));
    expect(bad).toBe(0);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThan(1000);
  });

  it('holds a mirror-smooth face under a bright lamp to less than a half float has, however bright the lamp', async () => {
    lamp(1e7);
    renderer.frame(view());
    expect(census(await floats(renderer.hdr.colour!)).most).toBeLessThan(HALF_MAX);
    lamp(16);
    renderer.frame(view());
    const { bad, most } = census(await floats(renderer.hdr.colour!));
    expect(bad, 'channels that are infinite or not a number').toBe(0);
    expect(most, 'the brightest channel, which at the top of a half float asked for more than there is').toBeLessThan(HALF_MAX);
    // and the highlight is still there, and still a great deal brighter than white
    expect(most).toBeGreaterThan(1000);
  });

  it('throws a bloom from it that is a number everywhere, brightest at the highlight', async () => {
    lamp(16);
    renderer.frame(view());
    const bloom = await floats(renderer.hdr.bloom!);
    expect(census(bloom).bad, 'bloom channels that are infinite or not a number').toBe(0);
    const side = renderer.hdr.bloom!.width;
    const at = (x: number, y: number) => bloom[(y * side + x) * 4];
    expect(at(side / 2, side / 2)).toBeGreaterThan(at(2, 2));
    expect(at(side / 2, side / 2)).toBeGreaterThan(1);
  });

  it('shows the highlight white with its glow round it, and no hole in it', async () => {
    lamp(16);
    renderer.frame(view());
    const at = await shown();
    let darkest = 255;
    for (let y = SIZE / 2 - 24; y < SIZE / 2 + 24; y++) for (let x = SIZE / 2 - 24; x < SIZE / 2 + 24; x++) darkest = Math.min(darkest, at(x, y));
    expect(darkest, 'the darkest pixel in the middle of the highlight').toBeGreaterThan(240);
  });

  it('shows glows piled past the top of a half float as white, not as a hole', async () => {
    // additive layers sum in the blend, where no shader can hold them: eight
    // of the brightest there is, one on another, over the whole frame
    lamp(0.001);
    const quads = new Float32Array(8 * EFFECT_STRIDE);
    for (let i = 0; i < 8; i++) quads.set([0, 0, 4, 60000, 1, 1, 1, 0.05], i * EFFECT_STRIDE);
    renderer.setEffects(quads, 8);
    renderer.frame(view());
    const bloom = census(await floats(renderer.hdr.bloom!));
    const at = await shown();
    renderer.setEffects(quads, 0);
    expect(bloom.bad, 'bloom channels that are infinite or not a number').toBe(0);
    expect(at(SIZE / 2, SIZE / 2)).toBeGreaterThan(240);
    expect(at(40, 40)).toBeGreaterThan(240);
  });
});

describe('the passes that read the frame, handed what is not a number', () => {
  const SIDE = 16;
  /** Half floats: a half, one, infinity, and not-a-number. */
  const HALF = 0x3800, ONE = 0x3c00, INF = 0x7c00, NAN = 0x7e00;
  /** Where the infinity and the not-a-number are put, well apart: in different quarter-size pixels of the bloom. */
  const INF_AT = [4, 4] as const, NAN_AT = [11, 11] as const;
  let gpu: Gpu;
  let source: GPUTexture;

  beforeAll(async () => {
    gpu = await createDevice();
    source = gpu.device.createTexture({ size: [SIDE, SIDE], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    // a frame of mid grey, so a hole in it would show, with one texel of each
    const data = new Uint16Array(SIDE * SIDE * 4);
    for (let i = 0; i < SIDE * SIDE; i++) data.set([HALF, HALF, HALF, ONE], i * 4);
    data.set([INF, INF, INF, ONE], (INF_AT[1] * SIDE + INF_AT[0]) * 4);
    data.set([NAN, NAN, NAN, ONE], (NAN_AT[1] * SIDE + NAN_AT[0]) * 4);
    gpu.queue.writeTexture({ texture: source }, data, { bytesPerRow: SIDE * 8 }, [SIDE, SIDE]);
  });

  afterAll(() => { source?.destroy(); gpu?.device.destroy(); });

  /** One full-screen pass of `code` into a new texture of `format` and `side`, reading `textures` at bindings from nought, then a sampler, then the knobs. */
  async function pass(code: string, textures: GPUTexture[], format: GPUTextureFormat, side: number): Promise<GPUTexture> {
    const module = gpu.device.createShaderModule({ code });
    const pipeline = await gpu.device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vsMain' },
      fragment: { module, entryPoint: 'fsMain', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    // bloom, threshold, knee, vignette, grain, time, and the source's texel
    // the post chain's knobs as the renderer writes them, the tone last: the filmic curve
    const knobs = gpu.device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    gpu.queue.writeBuffer(knobs, 0, new Float32Array([0.45, 1.25, 0.5, 0, 0, 0, 1 / SIDE, 1 / SIDE, 0, 0, 0, 0]));
    const sampler = gpu.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const out = gpu.device.createTexture({ size: [side, side], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
    const n = textures.length;
    const bind = gpu.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        ...textures.map((t, binding) => ({ binding, resource: t.createView() })),
        { binding: n, resource: sampler },
        { binding: n + 1, resource: { buffer: knobs } },
      ],
    });
    const enc = gpu.device.createCommandEncoder();
    const rp = enc.beginRenderPass({ colorAttachments: [{ view: out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    rp.setPipeline(pipeline);
    rp.setBindGroup(0, bind);
    rp.draw(3);
    rp.end();
    gpu.queue.submit([enc.finish()]);
    await gpu.queue.onSubmittedWorkDone();
    return out;
  }

  it('makes a bloom that is a number everywhere, and bright where the infinity was', async () => {
    const bloom = await pass(BRIGHT_WGSL, [source], 'rgba16float', SIDE / 4);
    const half = new Uint16Array(await readbackLayer(gpu.device, bloom, 0, 0, SIDE / 4, 8));
    bloom.destroy();
    const values = Array.from(half, halfToFloat);
    const bad = values.filter((v, i) => i % 4 !== 3 && !Number.isFinite(v)).length;
    expect(bad, 'bloom channels that are infinite or not a number').toBe(0);
    const at = (x: number, y: number) => values[(y * (SIDE / 4) + x) * 4];
    expect(at(1, 1), 'the bloom where the infinity was').toBeGreaterThan(100);
    expect(at(1, 1)).toBeLessThan(HALF_MAX);
    // mid grey is under the threshold, and throws none
    expect(at(3, 0)).toBeLessThan(0.01);
  });

  it('shows infinity white, and lets neither it nor not-a-number darken anything round it', async () => {
    const bloom = await pass(BRIGHT_WGSL, [source], 'rgba16float', SIDE / 4);
    const frame = await pass(COMPOSITE_WGSL, [source, bloom], gpu.format, SIDE);
    const px = new Uint8Array(await readbackLayer(gpu.device, frame, 0, 0, SIDE, 4));
    bloom.destroy(); frame.destroy();
    const at = (x: number, y: number) => (px[(y * SIDE + x) * 4] + px[(y * SIDE + x) * 4 + 1] + px[(y * SIDE + x) * 4 + 2]) / 3;
    // mid grey through the tone map, where nothing else reaches
    const grey = at(15, 0);
    expect(grey).toBeGreaterThan(100);
    expect(grey).toBeLessThan(200);
    expect(at(INF_AT[0], INF_AT[1]), 'the infinite texel').toBeGreaterThan(250);
    // not-a-number is one texel of nothing, which is the least it can be: it must not take its neighbours with it
    const holes: string[] = [];
    for (let y = 0; y < SIDE; y++) for (let x = 0; x < SIDE; x++) {
      if (x === NAN_AT[0] && y === NAN_AT[1]) continue;
      if (at(x, y) < grey - 2) holes.push(`${x},${y}: ${at(x, y)}`);
    }
    expect(holes, 'texels darker than the grey they were given').toEqual([]);
  });
});

