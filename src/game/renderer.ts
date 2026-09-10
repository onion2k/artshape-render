/**
 * A renderer for games with a fixed or slowly-moving camera.
 *
 * The still-life renderer next door draws one piece beautifully and redraws
 * only when something changes. This one draws every frame, and its shape was
 * decided by measurement rather than taste — see the spike's RESULTS.md for
 * the numbers behind each of these:
 *
 * - **Its own material.** The still-life shader costs about 11 ms a
 *   megapixel on the pixels it covers, which is a 22 ms frame at 1080p. This
 *   one was under a tenth of a millisecond for the same coverage.
 * - **Forward, not deferred.** A plain loop over point lights carries three
 *   to five hundred of them before it needs tiles or clusters, which is far
 *   more than an arena wants.
 * - **No culling, no LOD.** Eight thousand movers at nearly five million
 *   triangles cost under three milliseconds. Neither was earning its
 *   complexity.
 * - **Effects in their own stage.** Additive layers through a shader that
 *   only fades and tints cost a third of what they cost through a material.
 * - **The static half can be kept**, when the arena is heavy and the lights
 *   that reach it do not move. Those two conditions are not independent: a
 *   moving light relights the arena, so keeping the frame and having dynamic
 *   lights on static geometry are alternatives.
 */
import { bufferFrom, emptyBuffer, shader, type Gpu } from '../gpu/context';
import { Camera } from '../gpu/camera';
import type { Mesh as PartMesh } from '../mesh/types';
import { LIGHT_STRIDE, type LightPool } from './lights';
import { sunShadowMatrix, spotShadowMatrix, type Box } from './shadows';
import { Particles, type Emit } from './particles';
import { COMPOSITE_WGSL, DEPTH_WGSL, EFFECT_WGSL, SPOT_SHADOWS, sceneSource, type SceneVariant } from './shaders';

const HDR: GPUTextureFormat = 'rgba16float';
const DEPTH: GPUTextureFormat = 'depth24plus';
/** The shadow maps' format: a depth the comparison sampler can read. */
const SHADOW: GPUTextureFormat = 'depth32float';
const SUN_MAP = 2048;
const SPOT_MAP = 512;
/**
 * Depth bias in the lookups, in clip depth. The sun's map spans the fitted
 * box, so a unit of its depth is the box's whole extent along the light and
 * this is a few millimetres of it; a spot's depth is perspective and packed
 * toward the lamp, so the same number is far more there — see the tests.
 */
const SUN_BIAS = 0.0012;
const SPOT_BIAS = 0.0006;

/** One mesh and the placements of it, as the still-life path also takes them. */
export interface GameGroup {
  mesh: PartMesh;
  /** Column-major 4×4 per placement. Its length fixes the pool; `count` moves within it. */
  matrices: Float32Array;
  /** How many placements are live, from the first. Left out, all of them. */
  count?: number;
  /**
   * Colour and roughness per placement, four floats each, as `tint` writes
   * them. Left out, every placement takes the group's own `albedo` and
   * `roughness`, or failing those the look's.
   */
  materials?: Float32Array;
  /** The whole group's colour, when the placements do not differ. */
  albedo?: [number, number, number];
  /** The whole group's roughness. 0 is a mirror, 1 is chalk. */
  roughness?: number;
}

/** Four floats a placement: colour and roughness, as the shader reads them. */
export const MATERIAL_STRIDE = 4;

/** Floats an effect layer: centre xy, half-size, brightness, colour rgb, sharpness. */
export const EFFECT_STRIDE = 8;

/** How a frame is put together. */
export type FrameMode =
  /** Draw everything every frame. Right when the arena is light, or its lighting moves. */
  | 'redraw'
  /** Keep the static half's colour and depth and copy them back. Right when the arena is heavy and its lighting is still. */
  | 'keep';

export interface Look {
  /** What a group that names no colour of its own is given. */
  albedo: [number, number, number];
  /** What a group that names no roughness of its own is given. */
  roughness: number;
  /** Toward the light, not along it. */
  sunDir: [number, number, number];
  sunColour: [number, number, number];
  exposure: number;
  /**
   * How far a point light carries: the distance, in world units, at which it
   * is down to half. Small makes a bright dot with darkness around it; large
   * makes a light that washes a room. It is not the light's radius — the
   * radius is where it stops entirely, this is how it spends the way there.
   */
  falloffHalf: number;
  /**
   * How much the environment contributes. It lights every surface everywhere
   * with no light in the scene at all, so it sets the floor the point lights
   * are added on top of: 1 is a lit room, 0.2 a dark one where the only thing
   * you see by is what is burning.
   */
  ambient: number;
  /**
   * What the frame clears to, before tonemapping. The environment lights the
   * material but is never drawn, so this is the whole of the sky the camera
   * sees past the arena's edge.
   */
  background: [number, number, number];
}

export const DEFAULT_LOOK: Look = {
  albedo: [0.95, 0.93, 0.88],
  roughness: 0.3,
  sunDir: [0.3, -0.4, 0.86],
  sunColour: [1, 0.97, 0.92],
  exposure: 1,
  // fifty units, which is what the constant it replaced worked out at
  falloffHalf: 50,
  ambient: 1,
  background: [0.02, 0.02, 0.024],
};

/** What the ladder may give up, cheapest loss first. */
export interface GameEconomy extends SceneVariant {
  /** A fraction of the effect layers to draw: 1 all of them, 0 none. */
  effects: number;
  /** Whether the particle pool is simulated and drawn. Off, it is neither. */
  particles?: boolean;
}

export const FULL_ECONOMY: GameEconomy = { cullLights: true, points: true, effects: 1, particles: true };

interface Uploaded {
  position: GPUBuffer;
  normal: GPUBuffer;
  index: GPUBuffer;
  instance: GPUBuffer;
  material: GPUBuffer;
  indexCount: number;
  capacity: number;
  count: number;
}

export class GameRenderer {
  readonly camera = new Camera();
  /** Resolves when every pipeline has compiled; `frame` draws nothing before. */
  readonly ready: Promise<void>;

  private scenePipelines = new Map<string, GPURenderPipeline>();
  private effect!: GPURenderPipeline;
  private composite!: GPURenderPipeline;
  private compiled = false;

  private sceneLayout: GPUBindGroupLayout;
  private effectLayout: GPUBindGroupLayout;
  private compositeLayout: GPUBindGroupLayout;
  private sceneBind: GPUBindGroup | null = null;
  private effectBind: GPUBindGroup | null = null;
  private compositeBind: GPUBindGroup | null = null;

  private frameBuffer: GPUBuffer;
  private frameData = new Float32Array(32);
  private lightBuffer: GPUBuffer;
  private effectBuffer: GPUBuffer;
  private quadBuffer: GPUBuffer;
  private sampler: GPUSampler;
  private maxLod = 0;
  /** Tint rgb and the viewport aspect the effect shader rounds its glows by. */
  private effectUniform = new Float32Array([1, 1, 1, 1]);
  private lightCount = 0;

  private colour: GPUTexture | null = null;
  private depth: GPUTexture | null = null;

  // The shadow maps: one for the sun, a stack for the spotlights, a
  // comparison sampler to read them through, the matrices they were
  // rendered with, and a depth-only pipeline to render them.
  private sunMap: GPUTexture;
  private spotMaps: GPUTexture;
  private shadowSampler: GPUSampler;
  private shadowBuffer: GPUBuffer;
  private shadowData = new Float32Array(16 + 4 + SPOT_SHADOWS * 16 + 4);
  private depthPipeline!: GPURenderPipeline;
  private depthLayout: GPUBindGroupLayout;
  /** One matrix buffer and bind group per pass: the sun's, then a spot's each. */
  private passBuffers: GPUBuffer[] = [];
  private passBinds: GPUBindGroup[] = [];
  private sunBox: Box | null = null;
  /** The spotlights being shadowed this frame: what to render each layer from. */
  private spots: { position: [number, number, number]; direction: [number, number, number]; outer: number; reach: number }[] = [];
  private lightScratch = new Float32Array(0);
  private keptColour: GPUTexture | null = null;
  private keptDepth: GPUTexture | null = null;
  private width = 0;
  private height = 0;

  private staticGroups: Uploaded[] = [];
  private dynamicGroups: Uploaded[] = [];
  /** Whether the kept frame still matches the static half. */
  private keptStale = true;

  economy: GameEconomy = { ...FULL_ECONOMY };
  look: Look = { ...DEFAULT_LOOK };
  /**
   * The particles, simulated on the GPU: see `particles.ts`. The game emits
   * into them through `emit` and they are moved and drawn by `frame`.
   * Gravity is in the game's own units a second squared — the renderer has
   * no opinion about what a unit is, and the default is a metre's worth.
   */
  readonly particles: Particles;
  gravity = 9.81;

  constructor(private ctx: Gpu, private lightCapacity = 512, private effectCapacity = 256, particleCapacity = 16384) {
    const { device } = ctx;
    this.particles = new Particles(ctx, particleCapacity, 128, HDR, DEPTH);
    this.frameBuffer = device.createBuffer({ label: 'game frame', size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.lightBuffer = emptyBuffer(device, Math.max(1, lightCapacity) * LIGHT_STRIDE * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, 'point lights');
    this.effectBuffer = device.createBuffer({ label: 'effect', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.effectBuffer, 0, this.effectUniform);
    this.quadBuffer = emptyBuffer(device, Math.max(1, effectCapacity) * EFFECT_STRIDE * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, 'effect quads');
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });

    // The maps are made once at a fixed size and never resized: a map is
    // sized to what it covers, not to the window. 2048 across an arena
    // twelve metres wide is six millimetres a texel.
    const mapUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.sunMap = device.createTexture({ label: 'sun shadow', size: [SUN_MAP, SUN_MAP], format: SHADOW, usage: mapUsage });
    this.spotMaps = device.createTexture({ label: 'spot shadows', size: [SPOT_MAP, SPOT_MAP, SPOT_SHADOWS], format: SHADOW, usage: mapUsage });
    // linear filtering on a comparison sampler is the hardware's own PCF
    this.shadowSampler = device.createSampler({ label: 'shadow compare', compare: 'less-equal', magFilter: 'linear', minFilter: 'linear' });
    this.shadowBuffer = device.createBuffer({ label: 'shadows', size: this.shadowData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.depthLayout = device.createBindGroupLayout({
      label: 'shadow pass',
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    });
    for (let i = 0; i < 1 + SPOT_SHADOWS; i++) {
      const b = device.createBuffer({ label: `shadow pass ${i}`, size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.passBuffers.push(b);
      this.passBinds.push(device.createBindGroup({ label: `shadow pass ${i}`, layout: this.depthLayout, entries: [{ binding: 0, resource: { buffer: b } }] }));
    }

    this.sceneLayout = device.createBindGroupLayout({
      label: 'game scene',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: 'cube' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
        { binding: 8, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
      ],
    });
    this.effectLayout = device.createBindGroupLayout({
      label: 'game effects',
      entries: [
        // the vertex stage reads the aspect out of it, the fragment the tint
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.compositeLayout = device.createBindGroupLayout({
      label: 'game composite',
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} }],
    });

    const instance: GPUVertexBufferLayout = {
      arrayStride: 64, stepMode: 'instance',
      attributes: [4, 5, 6, 7].map((loc, k) => ({ shaderLocation: loc, offset: k * 16, format: 'float32x4' as GPUVertexFormat })),
    };
    // Material rides in its own instance buffer rather than alongside the
    // matrix, so that moving a thing and recolouring it stay separate writes.
    // A game moves everything every frame and recolours a handful of things
    // when they are hit; one write of sixteen floats a placement is cheap
    // where one of twenty, every frame, is a quarter more traffic for nothing.
    const material: GPUVertexBufferLayout = {
      arrayStride: 16, stepMode: 'instance',
      attributes: [{ shaderLocation: 8, offset: 0, format: 'float32x4' as GPUVertexFormat }],
    };
    // Every permutation is built up front. There are four, they compile in
    // parallel with each other, and a ladder that had to wait for a compile
    // before it could step would step too late to matter.
    const variants: SceneVariant[] = [];
    for (const shadows of [true, false]) {
      for (const points of [true, false]) {
        for (const cullLights of [true, false]) variants.push({ cullLights, points, shadows });
      }
    }
    const waits: Promise<unknown>[] = variants.map((v) => {
      const module = shader(device, sceneSource(v), `game scene ${GameRenderer.key(v)}`);
      return device.createRenderPipelineAsync({
        label: `game scene ${GameRenderer.key(v)}`,
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.sceneLayout] }),
        vertex: {
          module, entryPoint: 'vsMain',
          buffers: [
            { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
            { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
            instance,
            material,
          ],
        },
        fragment: { module, entryPoint: 'fsMain', targets: [{ format: HDR }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: 'less' },
      }).then((p) => { this.scenePipelines.set(GameRenderer.key(v), p); });
    });

    // The depth pass: position and placement in, depth out, nothing else.
    // A slope-scaled bias in the rasteriser rather than in the lookup alone,
    // because the two together are what stop a flat floor shadowing itself
    // in stripes.
    const dp = shader(device, DEPTH_WGSL, 'shadow depth');
    waits.push(device.createRenderPipelineAsync({
      label: 'shadow depth',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.depthLayout] }),
      vertex: {
        module: dp, entryPoint: 'vsMain',
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
          instance,
        ],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: SHADOW, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2 },
    }).then((p) => { this.depthPipeline = p; }));

    const fx = shader(device, EFFECT_WGSL, 'game effects');
    const additive: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    };
    waits.push(device.createRenderPipelineAsync({
      label: 'game effects',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.effectLayout] }),
      vertex: { module: fx, entryPoint: 'vsMain' },
      fragment: { module: fx, entryPoint: 'fsMain', targets: [{ format: HDR, blend: additive }] },
      primitive: { topology: 'triangle-list' },
      // tested but never written: no layer may reject another
      depthStencil: { format: DEPTH, depthWriteEnabled: false, depthCompare: 'less-equal' },
    }).then((p) => { this.effect = p; }));

    const comp = shader(device, COMPOSITE_WGSL, 'game composite');
    waits.push(device.createRenderPipelineAsync({
      label: 'game composite',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.compositeLayout] }),
      vertex: { module: comp, entryPoint: 'vsMain' },
      fragment: { module: comp, entryPoint: 'fsMain', targets: [{ format: ctx.format }] },
      primitive: { topology: 'triangle-list' },
    }).then((p) => { this.composite = p; }));

    waits.push(this.particles.ready);
    this.ready = Promise.all(waits).then(() => { this.compiled = true; });
  }

  private static key(v: SceneVariant) {
    return `${v.cullLights === false ? 'naive' : 'culled'}-${v.points === false ? 'sun' : 'points'}-${v.shadows === false ? 'flat' : 'shadowed'}`;
  }

  /** The environment the material reads: a prefiltered cube and the split-sum lookup. */
  setEnvironment(specular: GPUTexture, brdf: GPUTexture, mips: number) {
    this.maxLod = mips - 1;
    this.sceneBind = this.ctx.device.createBindGroup({
      label: 'game scene',
      layout: this.sceneLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer } },
        { binding: 1, resource: specular.createView({ dimension: 'cube' }) },
        { binding: 2, resource: brdf.createView() },
        { binding: 3, resource: this.sampler },
        { binding: 4, resource: { buffer: this.lightBuffer } },
        { binding: 5, resource: { buffer: this.shadowBuffer } },
        { binding: 6, resource: this.sunMap.createView() },
        { binding: 7, resource: this.spotMaps.createView({ dimension: '2d-array' }) },
        { binding: 8, resource: this.shadowSampler },
      ],
    });
    this.effectBind = this.ctx.device.createBindGroup({
      label: 'game effects',
      layout: this.effectLayout,
      entries: [
        { binding: 0, resource: { buffer: this.effectBuffer } },
        { binding: 1, resource: { buffer: this.quadBuffer } },
      ],
    });
  }

  private upload(groups: GameGroup[]): Uploaded[] {
    const { device } = this.ctx;
    return groups.map((g) => {
      const capacity = g.matrices.length / 16;
      const instance = device.createBuffer({
        label: 'instances', size: Math.max(64, capacity * 64),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(instance, 0, g.matrices as Float32Array<ArrayBuffer>);
      const material = device.createBuffer({
        label: 'materials', size: Math.max(16, capacity * 16),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(material, 0, this.materialsFor(g, capacity));
      return {
        position: bufferFrom(device, g.mesh.positions, GPUBufferUsage.VERTEX, 'positions'),
        normal: bufferFrom(device, g.mesh.normals, GPUBufferUsage.VERTEX, 'normals'),
        index: bufferFrom(device, g.mesh.indices, GPUBufferUsage.INDEX, 'indices'),
        instance,
        material,
        indexCount: g.mesh.indices.length,
        capacity,
        count: Math.min(g.count ?? capacity, capacity),
      };
    });
  }

  /** A group's per-placement material, filled from whatever it named. */
  private materialsFor(g: GameGroup, capacity: number): Float32Array<ArrayBuffer> {
    if (g.materials) {
      const out = new Float32Array(Math.max(4, capacity * MATERIAL_STRIDE));
      out.set(g.materials.subarray(0, out.length));
      return out;
    }
    const [r, gr, b] = g.albedo ?? this.look.albedo;
    const rough = g.roughness ?? this.look.roughness;
    const out = new Float32Array(Math.max(4, capacity * MATERIAL_STRIDE));
    for (let i = 0; i < out.length; i += MATERIAL_STRIDE) out.set([r, gr, b, rough], i);
    return out;
  }

  private static release(groups: Uploaded[]) {
    for (const g of groups) {
      g.position.destroy(); g.normal.destroy(); g.index.destroy();
      g.instance.destroy(); g.material.destroy();
    }
  }

  /** The arena: what does not move. Setting it makes any kept frame stale. */
  setStatic(groups: GameGroup[]) {
    GameRenderer.release(this.staticGroups);
    this.staticGroups = this.upload(groups);
    this.keptStale = true;
  }

  /** The movers. Their pool is fixed here; `move` writes into it afterwards. */
  setDynamic(groups: GameGroup[]) {
    GameRenderer.release(this.dynamicGroups);
    this.dynamicGroups = this.upload(groups);
  }

  /**
   * Write one group's matrices and nothing else.
   *
   * This is the whole point of a separate path. The still-life renderer's
   * `moveAll` marks the scene's bounds, its lights, its probe and its
   * shadows stale after every move, which is right for a piece being dragged
   * and costs 1.4 ms a frame at eight thousand placements. This costs 0.1,
   * because the things it would re-derive are the game's to know.
   *
   * One write for the whole pool: writing per placement was measured
   * eighteen times worse.
   */
  move(group: number, matrices: Float32Array, count?: number) {
    const g = this.dynamicGroups[group];
    if (!g) return;
    this.ctx.device.queue.writeBuffer(g.instance, 0, matrices as Float32Array<ArrayBuffer>, 0, Math.min(matrices.length, g.capacity * 16));
    if (count !== undefined) g.count = Math.max(0, Math.min(count, g.capacity));
  }

  /**
   * Write one dynamic group's colours and roughnesses, four floats a
   * placement, without touching where anything is. This is how a thing
   * flashes when it is hit.
   */
  tint(group: number, materials: Float32Array) {
    const g = this.dynamicGroups[group];
    if (!g) return;
    this.ctx.device.queue.writeBuffer(
      g.material, 0, materials as Float32Array<ArrayBuffer>,
      0, Math.min(materials.length, g.capacity * MATERIAL_STRIDE),
    );
  }

  /**
   * The live lights for this frame, and which of them — by index in the
   * pool, at most SPOT_SHADOWS of them, spotlights only — get a shadow map
   * rendered from where they stand. The pool is not touched: the layer each
   * shadowed light reads is written into a copy on its way to the GPU.
   */
  setLights(pool: LightPool, shadowed: number[] = []) {
    this.lightCount = Math.min(pool.count, this.lightCapacity);
    this.spots = [];
    if (!this.lightCount) return;
    const n = this.lightCount * LIGHT_STRIDE;
    if (this.lightScratch.length < n) this.lightScratch = new Float32Array(pool.data.length);
    const d = this.lightScratch;
    d.set(pool.data.subarray(0, n));
    for (let i = 0; i < n; i += LIGHT_STRIDE) d[i + 13] = -1;
    for (const index of shadowed) {
      if (this.spots.length >= SPOT_SHADOWS) break;
      if (index < 0 || index >= this.lightCount) continue;
      const o = index * LIGHT_STRIDE;
      // no cone, no frustum: an all-round light has no one map to render
      if (d[o + 11] <= -1.5) continue;
      d[o + 13] = this.spots.length;
      this.spots.push({
        position: [d[o], d[o + 1], d[o + 2]],
        direction: [d[o + 8], d[o + 9], d[o + 10]],
        outer: (Math.acos(Math.max(-1, Math.min(1, d[o + 11]))) * 180) / Math.PI,
        reach: d[o + 3],
      });
    }
    this.ctx.device.queue.writeBuffer(this.lightBuffer, 0, d, 0, n);
  }

  /**
   * Where the sun's shadow map is fitted: a box round everything that may
   * cast or catch one, in world units. Null turns the sun's shadow off; the
   * sun still lights, and still has its diffuse term.
   */
  setSunShadow(box: Box | null) {
    this.sunBox = box;
  }

  /** The matrices the maps are rendered with, and the lookups read with. */
  private writeShadows() {
    const f = this.shadowData;
    const sun = f.subarray(0, 16);
    if (this.sunBox) sunShadowMatrix(sun, this.look.sunDir, this.sunBox);
    else sun.fill(0);
    // texel size, bias in depth units, on
    f[16] = 1 / SUN_MAP; f[17] = SUN_BIAS; f[18] = this.sunBox ? 1 : 0; f[19] = 0;
    for (let i = 0; i < SPOT_SHADOWS; i++) {
      const m = f.subarray(20 + i * 16, 36 + i * 16);
      const s = this.spots[i];
      if (s) spotShadowMatrix(m, s.position, s.direction, s.outer, s.reach);
      else m.fill(0);
    }
    const tail = 20 + SPOT_SHADOWS * 16;
    f[tail] = 1 / SPOT_MAP; f[tail + 1] = SPOT_BIAS; f[tail + 2] = this.spots.length; f[tail + 3] = 0;
    const { queue } = this.ctx.device;
    queue.writeBuffer(this.shadowBuffer, 0, f);
    queue.writeBuffer(this.passBuffers[0], 0, f, 0, 16);
    for (let i = 0; i < this.spots.length; i++) queue.writeBuffer(this.passBuffers[1 + i], 0, f, 20 + i * 16, 16);
  }

  /** One shadow map: every group, from one matrix, depth only. */
  private renderShadow(encoder: GPUCommandEncoder, view: GPUTextureView, pass: number, label: string) {
    const rp = encoder.beginRenderPass({
      label,
      colorAttachments: [],
      depthStencilAttachment: { view, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    rp.setPipeline(this.depthPipeline);
    rp.setBindGroup(0, this.passBinds[pass]);
    for (const groups of [this.staticGroups, this.dynamicGroups]) {
      for (const g of groups) {
        if (!g.count) continue;
        rp.setVertexBuffer(0, g.position);
        rp.setVertexBuffer(1, g.instance);
        rp.setIndexBuffer(g.index, 'uint32');
        rp.drawIndexed(g.indexCount, g.count);
      }
    }
    rp.end();
  }

  /**
   * The effect layers for this frame, `EFFECT_STRIDE` floats each: centre x
   * and y in clip space, half-size, brightness, colour, and how hard the edge
   * falls off. They are additive and depth-tested but never depth-writing, so
   * the order among them does not matter.
   */
  setEffects(quads: Float32Array<ArrayBuffer>, count: number) {
    this.effectQuads = Math.min(count, this.effectCapacity);
    if (this.effectQuads) this.ctx.device.queue.writeBuffer(this.quadBuffer, 0, quads, 0, this.effectQuads * EFFECT_STRIDE);
  }
  private effectQuads = 0;

  /** A burst of particles this frame: smoke, spray, sparks. See `particles.ts`. */
  emit(e: Emit): boolean {
    return this.particles.emit(e);
  }

  /** A tint over every effect layer at once. White leaves them as they are. */
  setEffectTint(colour: [number, number, number]) {
    this.effectUniform.set(colour, 0);
    this.ctx.device.queue.writeBuffer(this.effectBuffer, 0, this.effectUniform);
  }

  resize(width: number, height: number) {
    width = Math.max(1, Math.floor(width));
    height = Math.max(1, Math.floor(height));
    if (width === this.width && height === this.height) return;
    this.width = width; this.height = height;
    this.camera.aspect = width / height;
    this.effectUniform[3] = width / height;
    this.ctx.device.queue.writeBuffer(this.effectBuffer, 0, this.effectUniform);
    const { device } = this.ctx;
    for (const t of [this.colour, this.depth, this.keptColour, this.keptDepth]) t?.destroy();
    const both = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.colour = device.createTexture({ label: 'game colour', size: [width, height], format: HDR, usage: both | GPUTextureUsage.COPY_DST });
    this.depth = device.createTexture({ label: 'game depth', size: [width, height], format: DEPTH, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST });
    this.keptColour = device.createTexture({ label: 'kept colour', size: [width, height], format: HDR, usage: both | GPUTextureUsage.COPY_SRC });
    this.keptDepth = device.createTexture({ label: 'kept depth', size: [width, height], format: DEPTH, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    this.compositeBind = device.createBindGroup({
      label: 'game composite', layout: this.compositeLayout,
      entries: [{ binding: 0, resource: this.colour.createView() }],
    });
    this.keptStale = true;
  }

  private writeFrame() {
    const f = this.frameData;
    this.camera.update();
    f.set(this.camera.viewProjection, 0);
    f.set(this.camera.position, 16); f[19] = this.look.exposure;
    f.set(this.look.sunDir, 20); f[23] = this.maxLod;
    f.set(this.look.sunColour, 24); f[27] = this.look.falloffHalf;
    f[28] = this.look.albedo[0]; f[29] = this.look.albedo[1];
    f[30] = this.look.ambient;
    f[31] = this.economy.points === false ? 0 : this.lightCount;
    this.ctx.device.queue.writeBuffer(this.frameBuffer, 0, f);
  }

  private get clearValue(): GPUColor {
    const [r, g, b] = this.look.background;
    return { r, g, b, a: 1 };
  }

  private get scenePipeline() {
    return this.scenePipelines.get(GameRenderer.key(this.economy));
  }

  private draw(pass: GPURenderPassEncoder, groups: Uploaded[]) {
    const pipeline = this.scenePipeline;
    if (!pipeline || !this.sceneBind) return;
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.sceneBind);
    for (const g of groups) {
      if (!g.count) continue;
      pass.setVertexBuffer(0, g.position);
      pass.setVertexBuffer(1, g.normal);
      pass.setVertexBuffer(2, g.instance);
      pass.setVertexBuffer(3, g.material);
      pass.setIndexBuffer(g.index, 'uint32');
      pass.drawIndexed(g.indexCount, g.count);
    }
  }

  /** Draw the static half once into the kept pair, for `keep` to start from. */
  private bakeKept(encoder: GPUCommandEncoder) {
    if (!this.keptColour || !this.keptDepth) return;
    const pass = encoder.beginRenderPass({
      label: 'game static',
      colorAttachments: [{ view: this.keptColour.createView(), loadOp: 'clear', storeOp: 'store', clearValue: this.clearValue }],
      depthStencilAttachment: { view: this.keptDepth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    this.draw(pass, this.staticGroups);
    pass.end();
    this.keptStale = false;
  }

  /**
   * One frame into `target`. Returns whether it drew: before the pipelines
   * have compiled, or without an environment, it does not.
   */
  frame(target: GPUTextureView, mode: FrameMode = 'redraw', dt = 1 / 60): boolean {
    const { device } = this.ctx;
    if (!this.compiled || !this.sceneBind || !this.compositeBind || !this.colour || !this.depth) return false;
    this.writeFrame();
    const encoder = device.createCommandEncoder({ label: 'game frame' });
    const colourView = this.colour.createView();
    const depthView = this.depth.createView();

    // The maps first, so the scene pass can read them. Every frame: the sun
    // moves, the trucks move, and a map of where things were is a shadow of
    // where they are not.
    if (this.economy.shadows !== false && this.depthPipeline) {
      this.writeShadows();
      if (this.sunBox) this.renderShadow(encoder, this.sunMap.createView(), 0, 'sun shadow');
      for (let i = 0; i < this.spots.length; i++) {
        const view = this.spotMaps.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 });
        this.renderShadow(encoder, view, 1 + i, `spot shadow ${i}`);
      }
    }

    if (mode === 'keep') {
      if (this.keptStale) this.bakeKept(encoder);
      const size = { width: this.width, height: this.height, depthOrArrayLayers: 1 };
      encoder.copyTextureToTexture({ texture: this.keptColour! }, { texture: this.colour }, size);
      encoder.copyTextureToTexture({ texture: this.keptDepth! }, { texture: this.depth }, size);
    }

    // the particles move before the scene is drawn, so what is drawn is
    // where they are now
    const particles = this.economy.particles !== false;
    if (particles) this.particles.simulate(encoder, dt, this.camera, this.gravity);

    const pass = encoder.beginRenderPass({
      label: 'game scene',
      colorAttachments: [{
        view: colourView,
        loadOp: mode === 'keep' ? 'load' : 'clear',
        storeOp: 'store',
        clearValue: this.clearValue,
      }],
      depthStencilAttachment: {
        view: depthView,
        depthLoadOp: mode === 'keep' ? 'load' : 'clear',
        depthClearValue: 1,
        depthStoreOp: 'store',
      },
    });
    if (mode === 'redraw') this.draw(pass, this.staticGroups);
    this.draw(pass, this.dynamicGroups);
    if (particles) this.particles.draw(pass);
    const layers = Math.round(this.effectQuads * Math.max(0, Math.min(1, this.economy.effects)));
    if (layers && this.effectBind) {
      pass.setPipeline(this.effect);
      pass.setBindGroup(0, this.effectBind);
      pass.draw(6, layers);
    }
    pass.end();

    const post = encoder.beginRenderPass({
      label: 'game composite',
      colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    post.setPipeline(this.composite);
    post.setBindGroup(0, this.compositeBind);
    post.draw(3);
    post.end();

    device.queue.submit([encoder.finish()]);
    return true;
  }

  dispose() {
    GameRenderer.release(this.staticGroups);
    GameRenderer.release(this.dynamicGroups);
    for (const t of [this.colour, this.depth, this.keptColour, this.keptDepth, this.sunMap, this.spotMaps]) t?.destroy();
    for (const b of [this.frameBuffer, this.lightBuffer, this.effectBuffer, this.quadBuffer, this.shadowBuffer, ...this.passBuffers]) b.destroy();
    this.particles.dispose();
  }
}
