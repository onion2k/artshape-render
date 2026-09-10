/**
 * Particles, simulated and drawn on the GPU.
 *
 * A fixed pool of them lives in a storage buffer and never comes back to
 * the CPU. Each frame the game says where new ones start — a handful of
 * emitters, a few dozen floats each — and three passes do the rest: one
 * compute pass writes the new particles into the pool, one moves every
 * particle in it, and one draw puts a camera-facing quad on each that is
 * still alive. Sixteen thousand of them cost about what one truck does.
 *
 * The pool is a ring. The CPU keeps the cursor, hands each emitter the run
 * of slots it will fill, and moves on; a particle is overwritten when the
 * ring comes round again, which for a pool many times the size of a
 * second's emission means it has long since died. No free list, no atomics,
 * no readback — nothing that would make the GPU wait for anything.
 *
 * Two kinds of blending in one pipeline, chosen per particle: an alpha of
 * zero makes it additive, which is a spark or a glow, and anything above
 * makes it a translucent thing that hides what is behind it, which is
 * smoke. Premultiplied, so the two can share a pass.
 */
import { emptyBuffer, shader, type Gpu } from '../gpu/context';
import type { Camera } from '../gpu/camera';

/** Floats a particle: position and age, velocity and life, colour and
 *  alpha, then size, growth, floor and gravity. Four vec4s. */
export const PARTICLE_STRIDE = 16;
/** Floats an emitter: six vec4s, the last a spare. */
export const EMITTER_STRIDE = 24;

/** What the game asks for: a burst of particles from one place. */
export interface Emit {
  position: [number, number, number];
  /** The velocity they all share. */
  velocity: [number, number, number];
  /** A random speed added in a random direction, on top. */
  spread: number;
  count: number;
  /** Seconds. */
  life: number;
  /** How much the life varies, as a fraction, either way. */
  lifeSpread?: number;
  /** Half-width of the quad, in world units. */
  size: number;
  /** Size gained a second: smoke swells, sparks do not. */
  growth?: number;
  colour: [number, number, number];
  /** Zero draws it additively; above zero it is translucent, this opaque at most. */
  alpha: number;
  /** How much of gravity it feels: one falls, zero floats, less than zero rises. */
  gravity?: number;
  /** Below this height it dies: the ground, or the water, it lands on. */
  floor?: number;
}

const STRUCTS = `
struct Particle {
  pos: vec3f, age: f32,
  vel: vec3f, life: f32,
  colour: vec3f, alpha: f32,
  size: f32, growth: f32, floor: f32, gravity: f32,
};
struct Emitter {
  pos: vec3f, count: f32,
  vel: vec3f, spread: f32,
  colour: vec3f, alpha: f32,
  life: f32, size: f32, growth: f32, floor: f32,
  gravity: f32, slot: f32, lifeSpread: f32, seed: f32,
  _spare: vec4f,
};
struct Frame {
  viewProj: mat4x4f,
  right: vec3f, dt: f32,
  up: vec3f, time: f32,
  gravity: f32, capacity: f32, emitters: f32, drag: f32,
};

`;

// The pool is read and written by the compute passes and only read by the
// draw, and a vertex stage may not even see a read_write binding — so the
// same structs are compiled twice, once behind each set of bindings.
const COMPUTE_WGSL = STRUCTS + `
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(2) var<storage, read> emitters: array<Emitter>;

// A hash, not a generator: every particle draws its randomness from its own
// slot and the frame's seed, so nothing has to remember a state.
fn hash(n: u32) -> f32 {
  var x = n * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  x = (x >> 22u) ^ x;
  return f32(x) / 4294967295.0;
}
fn unitDir(a: f32, b: f32) -> vec3f {
  let z = a * 2.0 - 1.0;
  let r = sqrt(max(0.0, 1.0 - z * z));
  let phi = b * 6.28318530718;
  return vec3f(r * cos(phi), r * sin(phi), z);
}

// One workgroup an emitter, its threads striding through the burst.
@compute @workgroup_size(64) fn emit(
  @builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) t: u32,
) {
  let e = emitters[wg.x];
  let count = u32(e.count);
  let cap = u32(frame.capacity);
  for (var j = t; j < count; j += 64u) {
    let slot = (u32(e.slot) + j) % cap;
    let s = slot * 7u + u32(e.seed) * 131u;
    var p: Particle;
    let dir = unitDir(hash(s), hash(s + 1u));
    p.pos = e.pos + dir * (e.spread * 0.05 * hash(s + 2u));
    p.vel = e.vel + unitDir(hash(s + 3u), hash(s + 4u)) * e.spread * hash(s + 5u);
    p.age = 0.0;
    p.life = e.life * (1.0 + (hash(s + 6u) * 2.0 - 1.0) * e.lifeSpread);
    p.colour = e.colour;
    p.alpha = e.alpha;
    p.size = e.size * (0.7 + 0.6 * hash(s + 7u));
    p.growth = e.growth;
    p.floor = e.floor;
    p.gravity = e.gravity;
    particles[slot] = p;
  }
}

@compute @workgroup_size(64) fn update(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= u32(frame.capacity)) { return; }
  var p = particles[i];
  if (p.age >= p.life) { return; }
  let dt = frame.dt;
  p.age += dt;
  // Things that fall are droplets and have little drag; things that float
  // are smoke and have a lot: the two are told apart by how much gravity
  // they feel, so there is one knob and not two.
  let drag = mix(frame.drag, frame.drag * 0.15, clamp(p.gravity, 0.0, 1.0));
  p.vel = p.vel * exp(-drag * dt);
  p.vel.z -= frame.gravity * p.gravity * dt;
  p.pos += p.vel * dt;
  p.size += p.growth * dt;
  if (p.pos.z < p.floor) { p.age = p.life; }
  particles[i] = p;
}

`;

const DRAW_WGSL = STRUCTS + `
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> particles: array<Particle>;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) colour: vec3f,
  @location(2) alpha: f32,
  @location(3) fade: f32,
};

@vertex fn vsMain(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> VsOut {
  var out: VsOut;
  let p = particles[i];
  if (p.life <= 0.0 || p.age >= p.life) {
    // dead: every corner at one point, which is no triangle at all
    out.pos = vec4f(2.0, 2.0, 2.0, 1.0);
    return out;
  }
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let c = corners[v];
  let world = p.pos + (frame.right * c.x + frame.up * c.y) * p.size;
  out.pos = frame.viewProj * vec4f(world, 1.0);
  out.uv = c;
  out.colour = p.colour;
  out.alpha = p.alpha;
  // in quickly, out slowly: the shape of a puff and of a splash both
  let t = p.age / p.life;
  out.fade = min(1.0, t * 6.0) * (1.0 - t) * (1.0 - t);
  return out;
}

@fragment fn fsMain(in: VsOut) -> @location(0) vec4f {
  let r = length(in.uv);
  let soft = smoothstep(1.0, 0.3, r) * in.fade;
  if (in.alpha <= 0.0) {
    // additive: colour on, nothing hidden
    return vec4f(in.colour * soft, 0.0);
  }
  let a = soft * in.alpha;
  return vec4f(in.colour * a, a);
}
`;

export class Particles {
  readonly capacity: number;
  readonly maxEmitters: number;
  readonly ready: Promise<void>;
  /** Drag on a floating particle, a second; a falling one has a sixth of it. */
  drag = 2.4;

  private pool: GPUBuffer;
  private emitterBuffer: GPUBuffer;
  private frameBuffer: GPUBuffer;
  private frameData = new Float32Array(32);
  private pending: Float32Array<ArrayBuffer>;
  private pendingCount = 0;
  private cursor = 0;
  private seed = 0;
  private time = 0;
  private emitPipe!: GPUComputePipeline;
  private updatePipe!: GPUComputePipeline;
  private drawPipe!: GPURenderPipeline;
  private computeBind: GPUBindGroup;
  private drawBind: GPUBindGroup;
  private compiled = false;

  constructor(private ctx: Gpu, capacity = 16384, maxEmitters = 128, colourFormat: GPUTextureFormat = 'rgba16float', depthFormat: GPUTextureFormat = 'depth24plus') {
    const { device } = ctx;
    this.capacity = Math.max(64, Math.ceil(capacity / 64) * 64);
    this.maxEmitters = Math.max(1, maxEmitters);
    this.pending = new Float32Array(this.maxEmitters * EMITTER_STRIDE);
    this.pool = emptyBuffer(device, this.capacity * PARTICLE_STRIDE * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, 'particles');
    this.emitterBuffer = emptyBuffer(device, this.maxEmitters * EMITTER_STRIDE * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, 'emitters');
    this.frameBuffer = device.createBuffer({ label: 'particle frame', size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const computeLayout = device.createBindGroupLayout({
      label: 'particle compute',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      ],
    });
    const drawLayout = device.createBindGroupLayout({
      label: 'particle draw',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.computeBind = device.createBindGroup({
      label: 'particle compute', layout: computeLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer } },
        { binding: 1, resource: { buffer: this.pool } },
        { binding: 2, resource: { buffer: this.emitterBuffer } },
      ],
    });
    this.drawBind = device.createBindGroup({
      label: 'particle draw', layout: drawLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer } },
        { binding: 1, resource: { buffer: this.pool } },
      ],
    });

    const module = shader(device, COMPUTE_WGSL, 'particles compute');
    const drawModule = shader(device, DRAW_WGSL, 'particles draw');
    const compute = device.createPipelineLayout({ bindGroupLayouts: [computeLayout] });
    const premultiplied: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };
    this.ready = Promise.all([
      device.createComputePipelineAsync({ label: 'particle emit', layout: compute, compute: { module, entryPoint: 'emit' } })
        .then((p) => { this.emitPipe = p; }),
      device.createComputePipelineAsync({ label: 'particle update', layout: compute, compute: { module, entryPoint: 'update' } })
        .then((p) => { this.updatePipe = p; }),
      device.createRenderPipelineAsync({
        label: 'particle draw',
        layout: device.createPipelineLayout({ bindGroupLayouts: [drawLayout] }),
        vertex: { module: drawModule, entryPoint: 'vsMain' },
        fragment: { module: drawModule, entryPoint: 'fsMain', targets: [{ format: colourFormat, blend: premultiplied }] },
        primitive: { topology: 'triangle-list' },
        // tested against the scene, never written: a puff does not hide a puff
        depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'less-equal' },
      }).then((p) => { this.drawPipe = p; }),
    ]).then(() => { this.compiled = true; });
  }

  /**
   * Ask for a burst this frame. Returns whether there was room for the
   * request: the emitter list is bounded, and a frame that asks for more
   * loses the last of them rather than any of the first.
   */
  emit(e: Emit): boolean {
    if (this.pendingCount >= this.maxEmitters) return false;
    const count = Math.max(0, Math.min(Math.floor(e.count), this.capacity));
    if (count === 0) return true;
    const o = this.pendingCount * EMITTER_STRIDE;
    const d = this.pending;
    d[o] = e.position[0]; d[o + 1] = e.position[1]; d[o + 2] = e.position[2]; d[o + 3] = count;
    d[o + 4] = e.velocity[0]; d[o + 5] = e.velocity[1]; d[o + 6] = e.velocity[2]; d[o + 7] = e.spread;
    d[o + 8] = e.colour[0]; d[o + 9] = e.colour[1]; d[o + 10] = e.colour[2]; d[o + 11] = e.alpha;
    d[o + 12] = e.life; d[o + 13] = e.size; d[o + 14] = e.growth ?? 0; d[o + 15] = e.floor ?? -1e9;
    d[o + 16] = e.gravity ?? 1; d[o + 17] = this.cursor; d[o + 18] = e.lifeSpread ?? 0; d[o + 19] = this.seed++;
    d[o + 20] = 0; d[o + 21] = 0; d[o + 22] = 0; d[o + 23] = 0;
    this.cursor = (this.cursor + count) % this.capacity;
    this.pendingCount++;
    return true;
  }

  /** How many bursts are waiting for the next frame. */
  get pendingEmitters() { return this.pendingCount; }

  /**
   * Upload this frame's bursts and run the two compute passes. Before the
   * scene pass, on the same encoder, so the draw sees the moved pool.
   */
  simulate(encoder: GPUCommandEncoder, dt: number, camera: Camera, gravity: number) {
    if (!this.compiled) { this.pendingCount = 0; return; }
    const { queue } = this.ctx.device;
    this.time += dt;
    const f = this.frameData;
    f.set(camera.viewProjection, 0);
    // the camera's own right and up, read off the rows of its view matrix,
    // so a quad always faces it whatever it is looking at
    const v = camera.view;
    f[16] = v[0]; f[17] = v[4]; f[18] = v[8]; f[19] = dt;
    f[20] = v[1]; f[21] = v[5]; f[22] = v[9]; f[23] = this.time;
    f[24] = gravity; f[25] = this.capacity; f[26] = this.pendingCount; f[27] = this.drag;
    queue.writeBuffer(this.frameBuffer, 0, f);
    if (this.pendingCount) {
      queue.writeBuffer(this.emitterBuffer, 0, this.pending, 0, this.pendingCount * EMITTER_STRIDE);
    }
    const pass = encoder.beginComputePass({ label: 'particles' });
    pass.setBindGroup(0, this.computeBind);
    if (this.pendingCount) {
      pass.setPipeline(this.emitPipe);
      pass.dispatchWorkgroups(this.pendingCount);
    }
    pass.setPipeline(this.updatePipe);
    pass.dispatchWorkgroups(this.capacity / 64);
    pass.end();
    this.pendingCount = 0;
  }

  /** Every live particle, as a quad, into the pass that drew the scene. */
  draw(pass: GPURenderPassEncoder) {
    if (!this.compiled) return;
    pass.setPipeline(this.drawPipe);
    pass.setBindGroup(0, this.drawBind);
    pass.draw(6, this.capacity);
  }

  dispose() {
    for (const b of [this.pool, this.emitterBuffer, this.frameBuffer]) b.destroy();
  }
}
