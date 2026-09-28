/**
 * Grass, grown and drawn on the GPU.
 *
 * A GameGroup of blades was measured before this was written: a million
 * five-triangle blades cost 7.8 ms a frame on an M4 Pro at 1280x800, and
 * half of it was the sun's shadow map and the occlusion's depth prepass,
 * which draw every group again; and a group has no way to thin with
 * distance, nor to bend. So grass is its own pass. Each frame the CPU picks
 * the chunks of the field the camera can see (`visibleChunks`), a compute
 * pass grows every blade in them from the seed and the mask, keeps those in
 * view and kept at their distance, and appends each to a list of fixed
 * capacity; and two indirect draws put a blade on each entry, five
 * triangles near and one far. The blades never come back to the CPU.
 *
 * A blade is lit by the scene's own fragment stage (`sceneWith`), so toon
 * bands, the sun's shadow, the lights, the occlusion and the ambient are
 * the same on grass as on anything else, with no copy of them to drift. It
 * reads the sun's map and the occlusion but is drawn into neither unless a
 * game asks for its shadows: a blade two pixels tall throws nothing anyone
 * can see, and each costs about as much as the blades themselves. The fog
 * reads its depth like anything's.
 *
 * Nothing here is made until a game first asks for grass, so a game that
 * never does compiles and allocates nothing more than it did.
 */
import { emptyBuffer, shader, type Gpu } from '../gpu/context';
import type { Camera } from '../gpu/camera';
import { sceneWith, type SceneVariant } from './shaders';
import {
  BAND, CAPACITY, CHUNK, GRASS_FLOATS, MAX_BEND, MAX_KINDS, chunkKinds, frustumPlanes, grassUniform, kindsUniform,
  visibleChunks, type GrassField, type GrassOptions, type Wind,
} from './grass';

/** Chunk entries a frame, at most: a field to the horizon at a quarter unit a cell asks a few thousand. */
export const MAX_CHUNKS = 16384;
/** Bytes a drawn blade takes in the list: where its root is, and its id. */
const BLADE_BYTES = 16;
/** The indirect draws and the counters: near's four words, far's four, the total, and three spare. */
const COUNTS_WORDS = 12;
const COUNTS_RESET = new Uint32Array([15, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0]);

/** What a blade's growth and its drawing both read: the frame's uniform and the kinds, and the grass's own hash. */
const GRASS_COMMON = /* wgsl */ `
struct Grass {
  eye: vec3f, near: f32,
  origin: vec2f, cell: f32, mid: f32,
  size: vec2f, chunkSize: f32, far: f32,
  outsideKind: f32, outsideHeight: f32, density: f32, pixel: f32,
  seed: u32, capacity: u32, _s0: u32, _s1: u32,
  wind: vec4f,
  gust: vec4f,
  trample: vec4f,
  trampleSize: vec4f,
  planes: array<vec4f, 6>,
};
/** A kind of grass: root colour and height; tip colour and spread; width, variation, roughness, lean; give and stripes; stripes' shade. */
struct Kind { base: vec4f, tip: vec4f, shape: vec4f, motion: vec4f, extra: vec4f };
const BAND: f32 = ${BAND};
const MAX_BEND: f32 = ${MAX_BEND};

// The particles' hash, and grass.ts's: a blade's chance is read from its place, never from a generator.
fn grassHash(n: u32) -> u32 {
  var x = n * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  return (x >> 22u) ^ x;
}
fn grassUnit(h: u32) -> f32 { return f32(h >> 8u) / 16777216.0; }
/** The share of blades kept at a distance: see keep() in grass.ts. */
fn keepAt(d: f32) -> f32 {
  let base = select((grass.near / d) * (grass.near / d), 1.0, d <= grass.near);
  return base * (1.0 - smoothstep(grass.far * 0.75, grass.far, d)) * grass.density;
}
`;

/** The growth: a workgroup a chunk entry, its threads striding through the chunk's lattice. See bladesIn() in grass.ts. */
export const GROW_WGSL = GRASS_COMMON + /* wgsl */ `
@group(0) @binding(0) var<uniform> grass: Grass;
@group(0) @binding(1) var<uniform> kinds: array<Kind, ${MAX_KINDS}>;
@group(0) @binding(2) var<storage, read> chunks: array<vec4i>;
@group(0) @binding(3) var mask: texture_2d<u32>;
@group(0) @binding(4) var heights: texture_2d<f32>;
@group(0) @binding(5) var<storage, read_write> blades: array<vec4u>;
@group(0) @binding(6) var<storage, read_write> counts: array<atomic<u32>, ${COUNTS_WORDS}>;

fn bladeKey(cx: i32, cy: i32, kind: u32, a: u32, b: u32) -> u32 {
  var h = grassHash(grass.seed);
  h = grassHash(h + bitcast<u32>(cx));
  h = grassHash(h + bitcast<u32>(cy));
  return grassHash(h + ((kind << 16u) | (a << 8u) | b));
}

@compute @workgroup_size(64) fn grow(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) t: u32) {
  let c = chunks[wg.x];
  let n = u32(c.w);
  let kind = u32(c.z);
  let k = kinds[kind];
  let span = f32(256u * n);
  let cols = i32(grass.size.x);
  let rows = i32(grass.size.y);
  let tall = k.base.w * (1.0 + k.tip.w);
  for (var i = t; i < n * n; i += 64u) {
    let a = i % n;
    let b = i / n;
    let key = bladeKey(c.x, c.y, kind, a, b);
    let h = grassHash(key);
    // jittered to a 256th of its square, so which cell it lands in is integer arithmetic, as grass.ts has it
    let qa = a * 256u + (h & 255u);
    let qb = b * 256u + ((h >> 8u) & 255u);
    let gx = c.x * ${CHUNK} + i32((qa * ${CHUNK}u) / (256u * n));
    let gy = c.y * ${CHUNK} + i32((qb * ${CHUNK}u) / (256u * n));
    var grows = -1;
    var z = 0.0;
    if (gx >= 0 && gy >= 0 && gx < cols && gy < rows) {
      grows = i32(textureLoad(mask, vec2i(gx, gy), 0).r) - 1;
      z = textureLoad(heights, vec2i(gx, gy), 0).r;
    } else if (grass.outsideKind >= 0.0) {
      grows = i32(grass.outsideKind);
      z = grass.outsideHeight;
    }
    if (grows != i32(kind)) { continue; }
    let x = (f32(c.x) + f32(qa) / span) * grass.chunkSize + grass.origin.x;
    let y = (f32(c.y) + f32(qb) / span) * grass.chunkSize + grass.origin.y;
    let root = vec3f(x, y, z);
    let id = (key & ~7u) | kind;
    let d = distance(root, grass.eye);
    if (grassUnit(grassHash(id + 1u)) >= keepAt(d) * (1.0 + BAND)) { continue; }
    // in view: a sphere round the blade, as tall as it may be, bent any way
    let centre = root + vec3f(0.0, 0.0, tall * 0.5);
    var seen = true;
    for (var p = 0; p < 6; p++) {
      if (dot(grass.planes[p].xyz, centre) + grass.planes[p].w < -tall) { seen = false; }
    }
    if (!seen) { continue; }
    // a slot of the whole capacity first, so near and far together never pass it and never meet
    if (atomicAdd(&counts[8], 1u) >= grass.capacity) { continue; }
    let entry = vec4u(bitcast<u32>(x), bitcast<u32>(y), bitcast<u32>(z), id);
    // one triangle past the middle distance, the change dithered by the blade so it draws no line across the field
    if (d > grass.mid * (0.95 + 0.1 * grassUnit(grassHash(id + 5u)))) {
      blades[grass.capacity - 1u - atomicAdd(&counts[5], 1u)] = entry;
    } else {
      blades[atomicAdd(&counts[1], 1u)] = entry;
    }
  }
}
`;

/**
 * A blade's vertex stage: built from its entry in the list, its kind and
 * its hash, bent from its root as an arc of its own length, and handed to
 * the scene's fragment stage as any surface is. FAR draws the far list,
 * which fills from the top of the buffer down, as one triangle.
 */
export const GRASS_VERTEX = GRASS_COMMON + /* wgsl */ `
override FAR: bool = false;
@group(1) @binding(0) var<uniform> grass: Grass;
@group(1) @binding(1) var<uniform> kinds: array<Kind, ${MAX_KINDS}>;
@group(1) @binding(2) var<storage, read> blades: array<vec4u>;
// what the blade is drawn through: the camera's matrix, or the sun's for its shadow
@group(1) @binding(3) var<uniform> through: mat4x4f;

// The near blade: three rows and a tip, each row narrower, as fifteen corners of five triangles.
const NEAR_U = array<f32, 15>(0.0, 0.0, 0.4, 0.0, 0.4, 0.4, 0.4, 0.4, 0.75, 0.4, 0.75, 0.75, 0.75, 0.75, 1.0);
const NEAR_ACROSS = array<f32, 15>(-0.5, 0.5, 0.4, -0.5, 0.4, -0.4, -0.4, 0.4, 0.25, -0.4, 0.25, -0.25, -0.25, 0.25, 0.0);
const FAR_U = array<f32, 3>(0.0, 0.0, 1.0);
const FAR_ACROSS = array<f32, 3>(-0.5, 0.5, 0.0);

/** Value noise over the ground, nought to one: patches of darker and lighter grass. */
fn patchNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = p - i;
  let s = f * f * (3.0 - 2.0 * f);
  let ix = bitcast<u32>(i32(i.x));
  let iy = bitcast<u32>(i32(i.y));
  let a = grassUnit(grassHash(grassHash(ix) + iy));
  let b = grassUnit(grassHash(grassHash(ix + 1u) + iy));
  let c = grassUnit(grassHash(grassHash(ix) + iy + 1u));
  let d = grassUnit(grassHash(grassHash(ix + 1u) + iy + 1u));
  return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}

@vertex fn vsMain(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VsOut {
  var slot = ii;
  if (FAR) { slot = grass.capacity - 1u - ii; }
  let e = blades[slot];
  let root = vec3f(bitcast<f32>(e.x), bitcast<f32>(e.y), bitcast<f32>(e.z));
  let id = e.w;
  let k = kinds[id & 7u];
  let d = max(distance(root, grass.eye), 1e-4);
  let kept = keepAt(d);
  // shrunk to nothing over the band past the kept ranks, so it sinks rather than blinks out; see shrink() and widen()
  let s = clamp((kept * (1.0 + BAND) - grassUnit(grassHash(id + 1u))) / BAND, 0.0, 1.0);
  let height = k.base.w * (1.0 + k.tip.w * (grassUnit(grassHash(id + 2u)) * 2.0 - 1.0)) * s;
  // at least a pixel wide wherever it stands, or a short blade far off shimmers in and out of the pixels
  let width = max(k.shape.x * min(3.0, inverseSqrt(max(kept, 1.0 / 9.0))), d * grass.pixel);
  let yaw = grassUnit(grassHash(id + 3u)) * 6.2831853;
  let side = vec2f(cos(yaw), sin(yaw));
  let facing = vec2f(-side.y, side.x);

  // at rest it leans its own way; mown, each stripe leans the one way and the next the other, and is shaded by it
  var lean = facing * k.shape.w * 1.5707963;
  var shade = 1.0;
  if (k.motion.y > 0.0) {
    let along = vec2f(cos(k.motion.z), sin(k.motion.z));
    let band = floor((dot(root.xy, vec2f(-along.y, along.x)) + k.motion.w) / k.motion.y);
    let odd = band - 2.0 * floor(band * 0.5);
    lean = along * (odd * 2.0 - 1.0) * k.shape.w * 1.5707963;
    shade = 1.0 + (odd - 0.5) * k.extra.x;
  }
  let bent = lean;
  let theta = min(length(bent), MAX_BEND);
  let dir = select(facing, bent / max(length(bent), 1e-6), length(bent) > 1e-6);

  var u: f32;
  var across: f32;
  if (FAR) { u = FAR_U[vi]; across = FAR_ACROSS[vi]; } else { u = NEAR_U[vi]; across = NEAR_ACROSS[vi]; }
  // an arc of the blade's length, turning theta from root to tip: it bends and never stretches
  let up = select(sin(theta * u) / theta, u, theta < 1e-3) * height;
  let reach = select((1.0 - cos(theta * u)) / theta, 0.0, theta < 1e-3) * height;
  let world = root + vec3f(dir * reach + side * across * width, up);
  let tangent = vec3f(dir * sin(theta * u), cos(theta * u));
  var n = normalize(cross(vec3f(side, 0.0), tangent));
  if (dot(n, grass.eye - world) < 0.0) { n = -n; }
  // pulled toward up, so a field shades as one surface in broad bands and not as noise
  n = normalize(mix(n, vec3f(0.0, 0.0, 1.0), 0.6));

  let vary = 1.0 + k.shape.y * (grassUnit(grassHash(id + 4u)) * 2.0 - 1.0);
  let patchy = 1.0 + k.shape.y * (patchNoise(root.xy / 3.0) * 2.0 - 1.0);
  var o: VsOut;
  o.pos = through * vec4f(world, 1.0);
  o.world = world;
  o.normal = n;
  o.albedo = mix(k.base.rgb, k.tip.rgb, pow(u, 0.7)) * vary * patchy * shade;
  o.roughness = k.shape.z;
  o.local = vec3f(0.0);
  o.pattern = vec4f(0.0);
  o.second = vec3f(0.0);
  return o;
}
`;

/** The scene variants a blade is drawn through: a group's, without the patterns. */
type GrassVariant = Required<Omit<SceneVariant, 'patterned'>>;

function variantKey(v: GrassVariant, far: boolean) {
  return `${v.cullLights ? 'c' : 'n'}${v.points ? 'p' : 's'}${v.shadows ? 'S' : 'f'}${v.toon ? 't' : 'r'}${far ? 'F' : 'N'}`;
}

/** The buffers and textures of one field, made when it is set and destroyed when it is not. */
interface Resources {
  field: GrassField;
  options: GrassOptions;
  capacity: number;
  chunks: ReturnType<typeof chunkKinds>;
  uniform: GPUBuffer;
  kinds: GPUBuffer;
  chunkBuffer: GPUBuffer;
  mask: GPUTexture;
  heights: GPUTexture;
  blades: GPUBuffer;
  counts: GPUBuffer;
  camera: GPUBuffer;
  grow: GPUBindGroup;
  draw: GPUBindGroup;
  shadow: GPUBindGroup | null;
}

export class GrassPass {
  /** Resolves when every pipeline has compiled; nothing is drawn before. */
  readonly ready: Promise<void>;
  private compiled = false;
  private growLayout: GPUBindGroupLayout;
  private drawLayout: GPUBindGroupLayout;
  private emptyLayout: GPUBindGroupLayout;
  private empty: GPUBindGroup;
  private growPipeline!: GPUComputePipeline;
  private pipelines = new Map<string, GPURenderPipeline>();
  private shadowPipelines: GPURenderPipeline[] = [];
  private res: Resources | null = null;
  private uniformData = new Float32Array(GRASS_FLOATS);
  private chunkData = new Int32Array(MAX_CHUNKS * 4);
  private planes = new Float32Array(24);
  /** Whether this frame grew any blades, and so whether there is anything to draw. */
  private grown = false;

  constructor(
    private ctx: Gpu,
    sceneLayout: GPUBindGroupLayout,
    colourFormat: GPUTextureFormat,
    depthFormat: GPUTextureFormat,
    shadowFormat: GPUTextureFormat,
  ) {
    const { device } = ctx;
    this.growLayout = device.createBindGroupLayout({
      label: 'grass grow',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'uint' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    this.drawLayout = device.createBindGroupLayout({
      label: 'grass draw',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      ],
    });
    this.emptyLayout = device.createBindGroupLayout({ label: 'grass nothing', entries: [] });
    this.empty = device.createBindGroup({ label: 'grass nothing', layout: this.emptyLayout, entries: [] });

    const waits: Promise<unknown>[] = [];
    waits.push(device.createComputePipelineAsync({
      label: 'grass grow',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.growLayout] }),
      compute: { module: shader(device, GROW_WGSL, 'grass grow'), entryPoint: 'grow' },
    }).then((p) => { this.growPipeline = p; }));

    // every build the ladder can step to, near and far, compiled up front as the scene's are
    for (const toon of [false, true])
      for (const shadows of [true, false])
        for (const points of [true, false])
          for (const cullLights of [true, false]) {
            const v: GrassVariant = { cullLights, points, shadows, toon };
            const module = shader(device, sceneWith(GRASS_VERTEX, { ...v, patterned: false }), `grass ${variantKey(v, false)}`);
            for (const far of [false, true])
              waits.push(device.createRenderPipelineAsync({
                label: `grass ${variantKey(v, far)}`,
                layout: device.createPipelineLayout({ bindGroupLayouts: [sceneLayout, this.drawLayout] }),
                vertex: { module, entryPoint: 'vsMain', constants: { FAR: far ? 1 : 0 } },
                fragment: { module, entryPoint: 'fsMain', targets: [{ format: colourFormat }] },
                primitive: { topology: 'triangle-list', cullMode: 'none' },
                depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less' },
              }).then((p) => { this.pipelines.set(variantKey(v, far), p); }));
          }
    // into the sun's map, when a game asks the blades to cast: the vertex stage alone, biased as the groups' are
    const depthModule = shader(device, sceneWith(GRASS_VERTEX, { shadows: false }), 'grass shadow');
    for (const far of [false, true])
      waits.push(device.createRenderPipelineAsync({
        label: `grass shadow ${far ? 'far' : 'near'}`,
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.emptyLayout, this.drawLayout] }),
        vertex: { module: depthModule, entryPoint: 'vsMain', constants: { FAR: far ? 1 : 0 } },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: shadowFormat, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2 },
      }).then((p) => { this.shadowPipelines[far ? 1 : 0] = p; }));
    this.ready = Promise.all(waits).then(() => { this.compiled = true; });
  }

  /** Whether there is a field, compiled and set, to draw. */
  get live(): boolean {
    return this.compiled && !!this.res;
  }

  /** Whether the set field's blades cast into the sun's map. */
  get casts(): boolean {
    return !!this.res?.options.shadows;
  }

  /**
   * The field to grow, replacing any other; its buffers are made again.
   * `sunPass` is the buffer holding the sun's matrix, for the blades'
   * shadow. Checked already, by the renderer.
   */
  setField(field: GrassField, options: GrassOptions, sunPass: GPUBuffer) {
    this.clear();
    const { device } = this.ctx;
    const capacity = options.capacity ?? CAPACITY;
    const uniform = device.createBuffer({ label: 'grass', size: GRASS_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const kinds = device.createBuffer({ label: 'grass kinds', size: MAX_KINDS * 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(kinds, 0, kindsUniform(field.kinds) as Float32Array<ArrayBuffer>);
    const chunkBuffer = emptyBuffer(device, MAX_CHUNKS * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, 'grass chunks');
    const mask = device.createTexture({ label: 'grass mask', size: [field.cols, field.rows], format: 'r8uint', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: mask }, field.mask as Uint8Array<ArrayBuffer>, { bytesPerRow: field.cols }, [field.cols, field.rows]);
    const heights = device.createTexture({ label: 'grass heights', size: [field.cols, field.rows], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: heights }, field.heights as Float32Array<ArrayBuffer>, { bytesPerRow: field.cols * 4 }, [field.cols, field.rows]);
    const blades = emptyBuffer(device, capacity * BLADE_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, 'grass blades');
    const counts = device.createBuffer({ label: 'grass counts', size: COUNTS_WORDS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    device.queue.writeBuffer(counts, 0, COUNTS_RESET);
    const camera = device.createBuffer({ label: 'grass camera', size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const grow = device.createBindGroup({
      label: 'grass grow', layout: this.growLayout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: kinds } },
        { binding: 2, resource: { buffer: chunkBuffer } },
        { binding: 3, resource: mask.createView() },
        { binding: 4, resource: heights.createView() },
        { binding: 5, resource: { buffer: blades } },
        { binding: 6, resource: { buffer: counts } },
      ],
    });
    const drawWith = (through: GPUBuffer, label: string) => device.createBindGroup({
      label, layout: this.drawLayout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: kinds } },
        { binding: 2, resource: { buffer: blades } },
        { binding: 3, resource: { buffer: through, size: 64 } },
      ],
    });
    this.res = {
      field, options, capacity, chunks: chunkKinds(field),
      uniform, kinds, chunkBuffer, mask, heights, blades, counts, camera,
      grow, draw: drawWith(camera, 'grass draw'), shadow: options.shadows ? drawWith(sunPass, 'grass shadow') : null,
    };
  }

  /** No field: everything it made is destroyed. The pipelines stay, for the next. */
  clear() {
    const r = this.res;
    if (!r) return;
    for (const b of [r.uniform, r.kinds, r.chunkBuffer, r.blades, r.counts, r.camera]) b.destroy();
    for (const t of [r.mask, r.heights]) t.destroy();
    this.res = null;
    this.grown = false;
  }

  /**
   * This frame's blades grown into the list: the chunks in view picked on
   * the CPU, the uniform written, the counters set back, and the growth
   * dispatched into `encoder`. Whether there is anything to draw.
   */
  grow(encoder: GPUCommandEncoder, camera: Camera, viewportHeight: number, density: number, wind: Wind, time: number): boolean {
    const r = this.res;
    this.grown = false;
    if (!r || !this.compiled || density <= 0) return false;
    const { device } = this.ctx;
    frustumPlanes(camera.viewProjection, this.planes);
    const pixel = (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, viewportHeight);
    const far = grassUniform(this.uniformData, r.field, r.options, { eye: camera.position, planes: this.planes, pixel, density, wind, time }, r.capacity)[11];
    const n = visibleChunks(r.field, r.chunks, this.planes, camera.position, far, this.chunkData);
    device.queue.writeBuffer(r.uniform, 0, this.uniformData);
    device.queue.writeBuffer(r.counts, 0, COUNTS_RESET);
    device.queue.writeBuffer(r.camera, 0, camera.viewProjection as Float32Array<ArrayBuffer>);
    if (n) {
      device.queue.writeBuffer(r.chunkBuffer, 0, this.chunkData, 0, n * 4);
      const pass = encoder.beginComputePass({ label: 'grass grow' });
      pass.setPipeline(this.growPipeline);
      pass.setBindGroup(0, r.grow);
      pass.dispatchWorkgroups(n);
      pass.end();
    }
    this.grown = n > 0;
    return this.grown;
  }

  /** The grown blades into the scene pass, lit through `scene`, the scene's own bind group, in the build the ladder is on. */
  draw(pass: GPURenderPassEncoder, scene: GPUBindGroup, variant: SceneVariant) {
    const r = this.res;
    if (!r || !this.grown) return;
    const v: GrassVariant = { cullLights: variant.cullLights !== false, points: variant.points !== false, shadows: variant.shadows !== false, toon: !!variant.toon };
    pass.setBindGroup(0, scene);
    pass.setBindGroup(1, r.draw);
    for (const far of [false, true]) {
      const p = this.pipelines.get(variantKey(v, far));
      if (!p) continue;
      pass.setPipeline(p);
      pass.drawIndirect(r.counts, far ? 16 : 0);
    }
  }

  /** The grown blades into the sun's map, when they cast. */
  drawShadow(pass: GPURenderPassEncoder) {
    const r = this.res;
    if (!r || !this.grown || !r.shadow) return;
    pass.setBindGroup(0, this.empty);
    pass.setBindGroup(1, r.shadow);
    for (const far of [false, true]) {
      pass.setPipeline(this.shadowPipelines[far ? 1 : 0]);
      pass.drawIndirect(r.counts, far ? 16 : 0);
    }
  }

  /** How many blades the last frame drew, near and far: read back, for a test or a gate. */
  async drawn(): Promise<{ near: number; far: number }> {
    const c = await this.read('counts');
    return c ? { near: c[1], far: c[5] } : { near: 0, far: 0 };
  }

  /** The blades the last frame drew, near and far, each where its root is and its id: read back, for a test. */
  async blades(): Promise<{ near: { x: number; y: number; z: number; id: number }[]; far: { x: number; y: number; z: number; id: number }[] }> {
    const r = this.res;
    const c = await this.read('counts');
    const b = await this.read('blades');
    if (!r || !c || !b) return { near: [], far: [] };
    const f = new Float32Array(b.buffer);
    const at = (i: number) => ({ x: f[i * 4], y: f[i * 4 + 1], z: f[i * 4 + 2], id: b[i * 4 + 3] });
    return {
      near: Array.from({ length: c[1] }, (_, i) => at(i)),
      far: Array.from({ length: c[5] }, (_, i) => at(r.capacity - 1 - i)),
    };
  }

  private async read(which: 'counts' | 'blades'): Promise<Uint32Array | null> {
    const r = this.res;
    if (!r) return null;
    const { device } = this.ctx;
    const src = which === 'counts' ? r.counts : r.blades;
    const out = device.createBuffer({ size: src.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, out, 0, src.size);
    device.queue.submit([enc.finish()]);
    await out.mapAsync(GPUMapMode.READ);
    const data = new Uint32Array(out.getMappedRange().slice(0));
    out.unmap();
    out.destroy();
    return data;
  }

  dispose() {
    this.clear();
  }
}
