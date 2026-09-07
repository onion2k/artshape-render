/**
 * Baked ambient occlusion and a ground shadow, from the same set of depth maps.
 *
 * Image-based lighting on its own lights the inside of a cup as brightly as its
 * rim. The cure is visibility: for every vertex of every placement, what
 * fraction of the light above its surface can it actually see?
 *
 * Instancing makes this awkward — the same petal is placed forty times and each
 * copy is shadowed differently — so the answer cannot live in a vertex
 * attribute. It lives in a storage buffer instead, two fixed-point sums per
 * (placement, vertex), and the scene's vertex shader reads its own entry by
 * instance and vertex index.
 *
 * The bake is shadow accumulation: render scene depth from a few hundred
 * directions, then for each direction a compute pass visits every placed vertex,
 * tests it against the depth map, and adds its weighted visibility with atomics.
 * A ground disc under the piece is rendered into the same depth maps as an
 * occluder and receives its own shadow texture, which is what puts the piece on
 * a table rather than in space.
 *
 * Directions are drawn in proportion to the environment's brightness, not
 * spread uniformly: a small flower on a tall stem blocks a sliver of sky from
 * any point on the table, yet under a softbox it casts a clear soft shadow,
 * because nearly all the light comes from that one patch. Sampling by radiance
 * makes the result the fraction of incoming light that actually arrives, and it
 * puts the sample budget where it shows.
 */

import { bufferFrom, FULLSCREEN_VERT, shader, type Gpu } from '../gpu/context';
import type { Mesh } from '../mesh/types';
import { cubeDirection, type EnvSamples } from './env';

export interface OcclusionGroup {
  mesh: Mesh;
  /** Column-major 4x4 per placement, 16 floats each. */
  matrices: Float32Array;
  /** The scene's own buffers, shared with the bake: VERTEX | STORAGE usage. */
  position: GPUBuffer;
  normal: GPUBuffer;
  instance: GPUBuffer;
  index: GPUBuffer;
  /** Left out of the bake, casting nothing and receiving nothing: a part that moves. Its entries stay zero, which the shader reads as unoccluded. */
  dynamic?: boolean;
}

export interface Occlusion {
  /** Per-(placement, vertex) sums as u32 pairs: R = vis * w, G = w, both times 1024. */
  lookup: GPUBuffer;
  /** First entry of each group, in the order the groups were given. */
  bases: number[];
  /** Ground shadow, rg16float: R = sum(vis * w), G = sum(w). */
  ground: GPUTexture;
  groundCentre: [number, number, number];
  groundRadius: number;
  /** Fires after each chunk of directions lands, so the scene can redraw with what it has. */
  onProgress?: () => void;
  /** Resolves when every direction has been accumulated, or the bake was cancelled. */
  done: Promise<void>;
  dispose(): void;
}

export interface OcclusionOptions {
  env?: { samples: EnvSamples; spin: number };
  directions?: number;
  depthSize?: number;
  groundSize?: number;
  groundScale?: number;
  /** Triangle-draws per submitted chunk: less on a slow machine, so a chunk takes the same time everywhere. */
  triangleBudget?: number;
}

/** The fixed-point scale of the accumulation sums. */
export const OCCLUSION_SCALE = 1024;

const DIR_STRIDE = 256;
const WORKGROUP = 64;
/** WebGPU's guaranteed maxComputeWorkgroupsPerDimension; past it the accumulate dispatch takes rows. */
const MAX_WORKGROUPS = 65535;
/** Triangle-draws per submitted chunk of the bake unless told otherwise; a comfortable fraction of a second on a desktop GPU. */
const TRIANGLE_BUDGET = 12_000_000;

const DIR_STRUCT = `
struct Dir { viewProj: mat4x4f, dir: vec3f, _p: f32 };
@group(0) @binding(0) var<uniform> dir: Dir;
`;

const DEPTH = `
${DIR_STRUCT}
@vertex fn vsMain(
  @location(0) position: vec3f,
  @location(1) im0: vec4f, @location(2) im1: vec4f, @location(3) im2: vec4f, @location(4) im3: vec4f,
) -> @builtin(position) vec4f {
  let inst = mat4x4f(im0, im1, im2, im3);
  return dir.viewProj * inst * vec4f(position, 1.0);
}`;

const ACCUMULATE = `
${DIR_STRUCT}
@group(0) @binding(1) var depthTex: texture_depth_2d;

struct Params {
  base: u32, vertexCount: u32, instanceCount: u32, _p: u32,
  normalOffset: f32, depthBias: f32, depthSize: f32, _p2: f32,
};
@group(1) @binding(0) var<storage, read> positions: array<f32>;
@group(1) @binding(1) var<storage, read> normals: array<f32>;
@group(1) @binding(2) var<storage, read> instances: array<mat4x4f>;
@group(1) @binding(3) var<storage, read_write> acc: array<atomic<u32>>;
@group(1) @binding(4) var<uniform> params: Params;

@compute @workgroup_size(${WORKGROUP}) fn main(@builtin(global_invocation_id) id: vec3u) {
  // a dispatch is at most 65535 workgroups a dimension: rows of them for a dense mesh
  let i = id.x + id.y * ${MAX_WORKGROUPS}u * ${WORKGROUP}u;
  if (i >= params.vertexCount * params.instanceCount) { return; }
  let inst = i / params.vertexCount;
  let vid = i - inst * params.vertexCount;
  let m = instances[inst];
  let p = (m * vec4f(positions[3u * vid], positions[3u * vid + 1u], positions[3u * vid + 2u], 1.0)).xyz;
  let n = normalize(mat3x3f(m[0].xyz, m[1].xyz, m[2].xyz) * vec3f(normals[3u * vid], normals[3u * vid + 1u], normals[3u * vid + 2u]));

  var w = dot(n, dir.dir);
  var vis = 0.0;
  if (w > 0.0) {
    // step off the surface toward the light before testing, so a vertex never
    // shadows itself, then allow a little slack in depth for the rest
    let clip = dir.viewProj * vec4f(p + n * params.normalOffset, 1.0);
    let ndc = clip.xyz / clip.w;
    let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    let px = vec2i(clamp(uv * params.depthSize, vec2f(0.0), vec2f(params.depthSize - 1.0)));
    let stored = textureLoad(depthTex, px, 0);
    vis = select(0.0, 1.0, ndc.z - params.depthBias <= stored);
  } else {
    w = 0.0;
  }
  let idx = params.base + i;
  atomicAdd(&acc[2u * idx], u32(vis * w * ${OCCLUSION_SCALE}.0 + 0.5));
  atomicAdd(&acc[2u * idx + 1u], u32(w * ${OCCLUSION_SCALE}.0 + 0.5));
}`;

const GROUND = `
${FULLSCREEN_VERT}
${DIR_STRUCT}
@group(0) @binding(1) var depthTex: texture_depth_2d;
struct GroundParams { centre: vec3f, radius: f32, normalOffset: f32, depthBias: f32, depthSize: f32, _p: f32 };
@group(0) @binding(2) var<uniform> ground: GroundParams;

@fragment fn fsMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = ground.centre + vec3f((uv - 0.5) * 2.0 * ground.radius, ground.normalOffset);
  let clip = dir.viewProj * vec4f(p, 1.0);
  let ndc = clip.xyz / clip.w;
  let suv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  let px = vec2i(clamp(suv * ground.depthSize, vec2f(0.0), vec2f(ground.depthSize - 1.0)));
  let stored = textureLoad(depthTex, px, 0);
  let vis = select(0.0, 1.0, ndc.z - ground.depthBias <= stored);
  let w = dir.dir.z;
  return vec4f(vis * w, w, 0.0, 0.0);
}`;

interface Pipelines {
  depth: GPURenderPipeline;
  accumulate: GPUComputePipeline;
  ground: GPURenderPipeline;
}

const pipelines = new WeakMap<GPUDevice, Promise<Pipelines>>();
const compiled = new WeakMap<GPUDevice, Pipelines>();

/** The bake's pipelines, compiled off the main thread once per device and awaited before the first chunk. */
function getPipelines(device: GPUDevice): Promise<Pipelines> {
  let p = pipelines.get(device);
  if (p) return p;
  // the direction slot is addressed by dynamic offset, so every layout that
  // holds it is explicit
  const dirEntry: GPUBindGroupLayoutEntry = {
    binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
    buffer: { type: 'uniform', hasDynamicOffset: true },
  };
  const depthEntry: GPUBindGroupLayoutEntry = {
    binding: 1, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, texture: { sampleType: 'depth' },
  };
  const dirLayout = device.createBindGroupLayout({ entries: [dirEntry] });
  const dirDepthLayout = device.createBindGroupLayout({ entries: [dirEntry, depthEntry] });
  const groundLayout = device.createBindGroupLayout({
    entries: [dirEntry, depthEntry, { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
  });
  const storage = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry =>
    ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } });
  const groupLayout = device.createBindGroupLayout({
    entries: [storage(0, 'read-only-storage'), storage(1, 'read-only-storage'), storage(2, 'read-only-storage'), storage(3, 'storage'), storage(4, 'uniform')],
  });

  const depthModule = shader(device, DEPTH, 'occlusion depth');
  const depth = device.createRenderPipelineAsync({
    label: 'occlusion depth',
    layout: device.createPipelineLayout({ bindGroupLayouts: [dirLayout] }),
    vertex: {
      module: depthModule, entryPoint: 'vsMain',
      buffers: [
        { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
        {
          arrayStride: 64, stepMode: 'instance',
          attributes: [1, 2, 3, 4].map((loc, k) => ({ shaderLocation: loc, offset: k * 16, format: 'float32x4' as GPUVertexFormat })),
        },
      ],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
  });
  const accumulate = device.createComputePipelineAsync({
    label: 'occlusion accumulate',
    layout: device.createPipelineLayout({ bindGroupLayouts: [dirDepthLayout, groupLayout] }),
    compute: { module: shader(device, ACCUMULATE, 'occlusion accumulate'), entryPoint: 'main' },
  });
  const groundModule = shader(device, GROUND, 'occlusion ground');
  const ground = device.createRenderPipelineAsync({
    label: 'occlusion ground',
    layout: device.createPipelineLayout({ bindGroupLayouts: [groundLayout] }),
    vertex: { module: groundModule, entryPoint: 'vsFullscreen' },
    fragment: {
      module: groundModule, entryPoint: 'fsMain',
      targets: [{
        format: 'rg16float',
        blend: {
          color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        },
      }],
    },
  });
  p = Promise.all([depth, accumulate, ground]).then(([depth, accumulate, ground]) => {
    const all = { depth, accumulate, ground };
    compiled.set(device, all);
    return all;
  });
  pipelines.set(device, p);
  return p;
}

export function bakeOcclusion(ctx: Gpu, groups: OcclusionGroup[], opts: OcclusionOptions = {}): Occlusion | null {
  if (!groups.length) return null;
  const { device } = ctx;
  const pipesReady = getPipelines(device);

  const directions = opts.directions ?? 256;
  const depthSize = opts.depthSize ?? 2048;
  const groundSize = opts.groundSize ?? 512;
  const groundScale = opts.groundScale ?? 1.8;

  // --- world bounds, from the eight corners of each placed local box ---
  const bounds = worldBounds(groups);
  const cx = (bounds.min[0] + bounds.max[0]) / 2;
  const cy = (bounds.min[1] + bounds.max[1]) / 2;
  const cz = (bounds.min[2] + bounds.max[2]) / 2;
  const pieceRadius = Math.max(
    Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]) / 2,
    1e-3,
  );
  const groundZ = bounds.min[2];
  const groundRadius = pieceRadius * groundScale;
  const groundCentre: [number, number, number] = [cx, cy, groundZ];
  const sceneRadius = Math.hypot(groundRadius, cz - groundZ) * 1.05;
  const texel = (2 * sceneRadius) / depthSize;
  const normalOffset = texel * 2.5;
  const depthBias = 1.5 / depthSize;

  // --- lookup layout ---
  const bases: number[] = [];
  let total = 0;
  for (const g of groups) {
    bases.push(total);
    total += (g.mesh.positions.length / 3) * (g.matrices.length / 16);
  }
  const lookup = device.createBuffer({
    label: 'occlusion lookup', size: total * 8,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  // --- directions, and one uniform slot per direction ---
  const dirs = opts.env
    ? sampleEnvironment(opts.env.samples, opts.env.spin, directions)
    : Array.from({ length: directions }, (_, i) => fibonacciDirection(i, directions));
  const dirBuffer = device.createBuffer({ size: directions * DIR_STRIDE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const dirData = new Float32Array((directions * DIR_STRIDE) / 4);
  const viewProj = new Float32Array(16);
  for (let i = 0; i < directions; i++) {
    const d = dirs[i];
    orthoFromDirection(viewProj, d, [cx, cy, (groundZ + bounds.max[2]) / 2], sceneRadius);
    const o = (i * DIR_STRIDE) / 4;
    dirData.set(viewProj, o);
    dirData.set([d[0], d[1], d[2], 0], o + 16);
  }
  device.queue.writeBuffer(dirBuffer, 0, dirData);

  // --- targets ---
  const depthTex = device.createTexture({
    label: 'occlusion depth', size: [depthSize, depthSize], format: 'depth32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const ground = device.createTexture({
    label: 'occlusion ground', size: [groundSize, groundSize], format: 'rg16float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });

  // --- the ground disc as an occluder: its own little mesh with one identity placement ---
  const disc = discMesh(groundCentre, groundRadius, 64);
  const discPosition = bufferFrom(device, disc.positions, GPUBufferUsage.VERTEX);
  const discIndex = bufferFrom(device, disc.indices, GPUBufferUsage.INDEX);
  const discInstance = bufferFrom(device, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), GPUBufferUsage.VERTEX);

  // --- the bake: for every direction, depth, then splat, then ground ---
  //
  // Submitted in chunks rather than as one command buffer. The GPU driver
  // kills any command buffer that runs longer than a second or two, and takes
  // the whole device with it; a dense piece drawn from a few hundred directions
  // at this resolution is well past that. Each chunk is sized to a budget of
  // triangle-draws, the sums are additive so every landed chunk is already a
  // usable answer, and a bake that is superseded stops at the next chunk.
  const drawnTriangles = groups.reduce((n, g) => n + (g.mesh.indices.length / 3) * (g.matrices.length / 16), 0);
  const chunk = Math.max(1, Math.min(32, Math.floor((opts.triangleBudget ?? TRIANGLE_BUDGET) / Math.max(drawnTriangles, 1))));
  let cancelled = false;

  // --- bind groups and the encoding of one direction, once the pipelines have compiled ---
  const paramBuffers: GPUBuffer[] = [];
  let groundParams: GPUBuffer | null = null;
  const depthView = depthTex.createView();
  const groundView = ground.createView();
  const prepare = (pipes: Pipelines) => {
  // --- bind groups ---
    const dirBind = device.createBindGroup({
      layout: pipes.depth.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: dirBuffer, size: DIR_STRIDE } }],
    });
    const accDirBind = device.createBindGroup({
      layout: pipes.accumulate.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: dirBuffer, size: DIR_STRIDE } },
        { binding: 1, resource: depthView },
      ],
    });
    const groupBinds = groups.map((g, k) => {
      const params = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const vertexCount = g.mesh.positions.length / 3;
      const instanceCount = g.matrices.length / 16;
      device.queue.writeBuffer(params, 0, new Uint32Array([bases[k], vertexCount, instanceCount, 0]));
      device.queue.writeBuffer(params, 16, new Float32Array([normalOffset, depthBias, depthSize, 0]));
      paramBuffers.push(params);
      return device.createBindGroup({
        layout: pipes.accumulate.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: { buffer: g.position } },
          { binding: 1, resource: { buffer: g.normal } },
          { binding: 2, resource: { buffer: g.instance } },
          { binding: 3, resource: { buffer: lookup } },
          { binding: 4, resource: { buffer: params } },
        ],
      });
    });
    groundParams = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(groundParams, 0, new Float32Array([cx, cy, groundZ, groundRadius, normalOffset, depthBias, depthSize, 0]));
    const groundBind = device.createBindGroup({
      layout: pipes.ground.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: dirBuffer, size: DIR_STRIDE } },
        { binding: 1, resource: depthView },
        { binding: 2, resource: { buffer: groundParams } },
      ],
    });

  const encodeDirection = (encoder: GPUCommandEncoder, i: number) => {
      const d = dirs[i];
      const offset = [i * DIR_STRIDE];

      const depthPass = encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: { view: depthView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      });
      depthPass.setPipeline(pipes.depth);
      depthPass.setBindGroup(0, dirBind, offset);
      for (const g of groups) {
        if (g.dynamic) continue;
        depthPass.setVertexBuffer(0, g.position);
        depthPass.setVertexBuffer(1, g.instance);
        depthPass.setIndexBuffer(g.index, 'uint32');
        depthPass.drawIndexed(g.mesh.indices.length, g.matrices.length / 16);
      }
      if (d[2] > 0) {
        // the disc only occludes from above; from below it is the table's underside
        depthPass.setVertexBuffer(0, discPosition);
        depthPass.setVertexBuffer(1, discInstance);
        depthPass.setIndexBuffer(discIndex, 'uint32');
        depthPass.drawIndexed(disc.indices.length, 1);
      }
      depthPass.end();

      const compute = encoder.beginComputePass();
      compute.setPipeline(pipes.accumulate);
      compute.setBindGroup(0, accDirBind, offset);
      groups.forEach((g, k) => {
        if (g.dynamic) return;
        compute.setBindGroup(1, groupBinds[k]);
        const count = (g.mesh.positions.length / 3) * (g.matrices.length / 16);
        const workgroups = Math.ceil(count / WORKGROUP);
        compute.dispatchWorkgroups(Math.min(workgroups, MAX_WORKGROUPS), Math.ceil(workgroups / MAX_WORKGROUPS));
      });
      compute.end();

      if (d[2] > 0.02) {
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view: groundView, loadOp: 'load', storeOp: 'store' }],
        });
        pass.setPipeline(pipes.ground);
        pass.setBindGroup(0, groundBind, offset);
        pass.draw(3);
        pass.end();
      }
    };
    return encodeDirection;
  };


  const releaseScratch = () => {
    depthTex.destroy();
    discPosition.destroy();
    discIndex.destroy();
    discInstance.destroy();
    dirBuffer.destroy();
    groundParams?.destroy();
    for (const b of paramBuffers) b.destroy();
  };

  const occlusion: Occlusion = {
    lookup,
    bases,
    ground,
    groundCentre,
    groundRadius,
    done: Promise.resolve(),
    dispose() {
      cancelled = true;
      lookup.destroy();
      ground.destroy();
    },
  };

  occlusion.done = (async () => {
    // the pipelines compile off the main thread: the first bake waits for
    // them, and every later one finds them compiled and encodes its first
    // chunk before this call returns, so what is submitted after it is
    // ordered behind it as before
    const encodeDirection = prepare(compiled.get(device) ?? (await pipesReady));
    if (cancelled) { releaseScratch(); return; }
    // the first chunk is small, so a shadowed frame is on screen before the rest lands
    for (let first = 0, size = Math.min(chunk, 8); first < directions && !cancelled; first += size, size = chunk) {
      const encoder = device.createCommandEncoder({ label: 'occlusion bake' });
      for (let i = first; i < Math.min(first + size, directions); i++) encodeDirection(encoder, i);
      device.queue.submit([encoder.finish()]);
      // one chunk in flight at a time: the queue never holds more than a budget's worth
      await device.queue.onSubmittedWorkDone();
      if (!cancelled) occlusion.onProgress?.();
    }
    // scratch resources are safe to destroy once the last submit is done; a
    // cancelled bake has nothing queued either
    releaseScratch();
  })();

  return occlusion;
}

function discMesh(centre: [number, number, number], radius: number, segments: number) {
  const positions = new Float32Array((segments + 1) * 3);
  positions.set(centre, 0);
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    positions[(i + 1) * 3] = centre[0] + Math.cos(a) * radius;
    positions[(i + 1) * 3 + 1] = centre[1] + Math.sin(a) * radius;
    positions[(i + 1) * 3 + 2] = centre[2];
  }
  const indices = new Uint32Array(segments * 3);
  for (let i = 0; i < segments; i++) {
    indices[i * 3] = 0;
    indices[i * 3 + 1] = i + 1;
    indices[i * 3 + 2] = ((i + 1) % segments) + 1;
  }
  return { positions, indices };
}

export function worldBounds(groups: Array<Pick<OcclusionGroup, 'mesh' | 'matrices'>>) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const g of groups) {
    const p = g.mesh.positions;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (p[i + k] < lo[k]) lo[k] = p[i + k];
        if (p[i + k] > hi[k]) hi[k] = p[i + k];
      }
    }
    const M = g.matrices;
    for (let m = 0; m < M.length; m += 16) {
      for (let corner = 0; corner < 8; corner++) {
        const x = corner & 1 ? hi[0] : lo[0];
        const y = corner & 2 ? hi[1] : lo[1];
        const z = corner & 4 ? hi[2] : lo[2];
        const wx = M[m] * x + M[m + 4] * y + M[m + 8] * z + M[m + 12];
        const wy = M[m + 1] * x + M[m + 5] * y + M[m + 9] * z + M[m + 13];
        const wz = M[m + 2] * x + M[m + 6] * y + M[m + 10] * z + M[m + 14];
        if (wx < min[0]) min[0] = wx; if (wx > max[0]) max[0] = wx;
        if (wy < min[1]) min[1] = wy; if (wy > max[1]) max[1] = wy;
        if (wz < min[2]) min[2] = wz; if (wz > max[2]) max[2] = wz;
      }
    }
  }
  return { min, max };
}

/**
 * Directions drawn from a cube map in proportion to radiance times solid angle,
 * walked with a stratified sequence so samples tile each bright patch evenly. A
 * floor on the radiance keeps a few samples in the dark, so a shadow stays
 * darker than its surroundings rather than black. With directions chosen this
 * way the per-sample weight reduces to the cosine alone.
 */
function sampleEnvironment(env: EnvSamples, spin: number, count: number): Array<[number, number, number]> {
  const { faces, size } = env;
  const n = 6 * size * size;
  const lum = (f: number, x: number, y: number) => {
    const i = (y * size + x) * 4;
    return 0.2126 * faces[f][i] + 0.7152 * faces[f][i + 1] + 0.0722 * faces[f][i + 2];
  };
  let mean = 0;
  for (let f = 0; f < 6; f++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) mean += lum(f, x, y);
  mean /= n;
  const floor = mean * 0.08;

  const cdf = new Float64Array(n);
  let acc = 0;
  for (let f = 0; f < 6; f++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const sc = (2 * (x + 0.5)) / size - 1;
        const tc = (2 * (y + 0.5)) / size - 1;
        const solid = 4 / Math.pow(1 + sc * sc + tc * tc, 1.5);
        acc += (lum(f, x, y) + floor) * solid;
        cdf[(f * size + y) * size + x] = acc;
      }
    }
  }

  const c = Math.cos(spin), s = Math.sin(spin);
  const out: Array<[number, number, number]> = [];
  for (let k = 0; k < count; k++) {
    const u = ((k + 0.5) / count) * acc;
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < u) lo = mid + 1; else hi = mid;
    }
    const f = Math.floor(lo / (size * size));
    const rem = lo - f * size * size;
    const y = Math.floor(rem / size);
    const x = rem - y * size;
    const sc = (2 * (x + radicalInverse(k, 2))) / size - 1;
    const tc = (2 * (y + radicalInverse(k, 3))) / size - 1;
    const d = cubeDirection(f, sc, tc);
    // the shader samples the cube at spin * d, so the world direction is the inverse spin
    out.push([c * d[0] - s * d[1], s * d[0] + c * d[1], d[2]]);
  }
  return out;
}

function radicalInverse(i: number, base: number) {
  let inv = 1 / base, r = 0, f = inv;
  while (i > 0) {
    r += f * (i % base);
    i = Math.floor(i / base);
    f *= inv;
  }
  return r;
}

/** Point i of n, spread evenly over the sphere. */
function fibonacciDirection(i: number, n: number): [number, number, number] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const z = 1 - (2 * (i + 0.5)) / n;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const a = golden * i;
  return [Math.cos(a) * r, Math.sin(a) * r, z];
}

/**
 * Orthographic view looking along -d at `centre`, camera pulled back 2r, with
 * depth mapped to [0, 1] over a range of 4r, as WebGPU clips it.
 */
export function orthoFromDirection(out: Float32Array, d: [number, number, number], centre: number[], radius: number) {
  const up = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const rx = up[1] * d[2] - up[2] * d[1];
  const ry = up[2] * d[0] - up[0] * d[2];
  const rz = up[0] * d[1] - up[1] * d[0];
  const rl = Math.hypot(rx, ry, rz);
  const r = [rx / rl, ry / rl, rz / rl];
  const u = [d[1] * r[2] - d[2] * r[1], d[2] * r[0] - d[0] * r[2], d[0] * r[1] - d[1] * r[0]];
  const eye = [centre[0] + d[0] * radius * 2, centre[1] + d[1] * radius * 2, centre[2] + d[2] * radius * 2];
  const view = [
    r[0], u[0], d[0], 0,
    r[1], u[1], d[1], 0,
    r[2], u[2], d[2], 0,
    -(r[0] * eye[0] + r[1] * eye[1] + r[2] * eye[2]),
    -(u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2]),
    -(d[0] * eye[0] + d[1] * eye[1] + d[2] * eye[2]),
    1,
  ];
  // view z runs from 0 at the eye to -4r at the far side; depth = -z / 4r
  const proj = [
    1 / radius, 0, 0, 0,
    0, 1 / radius, 0, 0,
    0, 0, -1 / (radius * 4), 0,
    0, 0, 0, 1,
  ];
  for (let c = 0; c < 4; c++) {
    for (let rI = 0; rI < 4; rI++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += proj[k * 4 + rI] * view[c * 4 + k];
      out[c * 4 + rI] = s;
    }
  }
}
