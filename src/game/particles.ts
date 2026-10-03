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
import { FINITE_WGSL } from './shaders';
import { FOG_AHEAD_WGSL, FOG_PHASE_WGSL, FOG_STRUCT_WGSL } from './fog';
import { AIR_WGSL, WASH_CAPACITY, WASH_EPSILON_MM, WASH_WGSL, WIND_AT, packWashes, packWind, type Wash } from './wash';

/** Floats a particle: position and age, velocity and life, colour and
 *  alpha, then size, growth, floor and gravity, then the colour it fades to
 *  and whether it does. Five vec4s. */
export const PARTICLE_STRIDE = 20;
/** Floats an emitter: six vec4s, the last the colour its particles fade to and whether they do. */
export const EMITTER_STRIDE = 24;
/** Floats a sprite: position and size, colour and alpha. Two vec4s. */
export const SPRITE_STRIDE = 8;
/** How many sprites a frame may have. */
export const SPRITE_CAPACITY = 256;

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
  /**
   * The colour a particle has reached by the end of its life, moving there
   * from `colour` as it ages, slowly at first and last and quickest in the
   * middle (a smooth-step on the share of its life gone), so that it keeps
   * its starting colour while it is thick and dense near where it was born
   * and settles into the end one as it thins out: dark smoke at the fire,
   * pale when it has risen. Left out, a particle keeps `colour` for life.
   */
  fade?: [number, number, number];
  /** Zero draws it additively; above zero it is translucent, this opaque at most. */
  alpha: number;
  /** How much of gravity it feels: one falls, zero floats, less than zero rises. */
  gravity?: number;
  /** Below this height it dies: the ground, or the water, it lands on. */
  floor?: number;
}

/**
 * One burst written into the emitter list at float `o` of `d`: where it
 * starts, how many, the ring's slot it fills from and the seed its particles
 * draw their chance from. The last vec4 is the colour they fade to and a one
 * if they do, so that a burst with no fade holds noughts there and the colour
 * is kept for life.
 */
export function packEmitter(d: Float32Array, o: number, e: Emit, count: number, slot: number, seed: number) {
  d[o] = e.position[0]; d[o + 1] = e.position[1]; d[o + 2] = e.position[2]; d[o + 3] = count;
  d[o + 4] = e.velocity[0]; d[o + 5] = e.velocity[1]; d[o + 6] = e.velocity[2]; d[o + 7] = e.spread;
  d[o + 8] = e.colour[0]; d[o + 9] = e.colour[1]; d[o + 10] = e.colour[2]; d[o + 11] = e.alpha;
  d[o + 12] = e.life; d[o + 13] = e.size; d[o + 14] = e.growth ?? 0; d[o + 15] = e.floor ?? -1e9;
  d[o + 16] = e.gravity ?? 1; d[o + 17] = slot; d[o + 18] = e.lifeSpread ?? 0; d[o + 19] = seed;
  d[o + 20] = e.fade?.[0] ?? 0; d[o + 21] = e.fade?.[1] ?? 0; d[o + 22] = e.fade?.[2] ?? 0; d[o + 23] = e.fade ? 1 : 0;
}

const STRUCTS = `
struct Particle {
  pos: vec3f, age: f32,
  vel: vec3f, life: f32,
  colour: vec3f, alpha: f32,
  size: f32, growth: f32, floor: f32, gravity: f32,
  fade: vec3f, fading: f32,
};
struct Emitter {
  pos: vec3f, count: f32,
  vel: vec3f, spread: f32,
  colour: vec3f, alpha: f32,
  life: f32, size: f32, growth: f32, floor: f32,
  gravity: f32, slot: f32, lifeSpread: f32, seed: f32,
  fade: vec3f, fading: f32,
};
struct Frame {
  viewProj: mat4x4f,
  right: vec3f, dt: f32,
  up: vec3f, time: f32,
  gravity: f32, capacity: f32, emitters: f32, drag: f32,
  // the run of the ring that may hold a live particle: see simulate()
  rangeStart: f32, rangeCount: f32, washEpsilon: f32, washCount: f32,
};

`;

// The pool is read and written by the compute passes and only read by the
// draw, and a vertex stage may not even see a read_write binding — so the
// same structs are compiled twice, once behind each set of bindings.
const COMPUTE_WGSL = STRUCTS + `
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(2) var<storage, read> emitters: array<Emitter>;
// two vec4s a wash, as packWashes lays them out; frame.washCount of them are live
// and after them the wind, one vec4 more, which with none set is noughts
@group(0) @binding(3) var<uniform> washes: array<vec4f, ${WASH_CAPACITY * 2 + 1}>;
${WASH_WGSL}
${AIR_WGSL}

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
    p.fade = e.fade;
    p.fading = e.fading;
    particles[slot] = p;
  }
}

@compute @workgroup_size(64) fn update(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= u32(frame.rangeCount)) { return; }
  let i = (u32(frame.rangeStart) + gid.x) % u32(frame.capacity);
  var p = particles[i];
  if (p.age >= p.life) { return; }
  let dt = frame.dt;
  p.age += dt;
  // Things that fall are droplets and have little drag; things that float
  // are smoke and have a lot: the two are told apart by how much gravity
  // they feel, so there is one knob and not two.
  let drag = mix(frame.drag, frame.drag * 0.15, clamp(p.gravity, 0.0, 1.0));
  p.vel = p.vel * exp(-drag * dt);
  // Air under a rotor pulls the velocity toward its own, as drag does, so it
  // is as steady at a long step as at a short one; a floating particle
  // settles to nearly all of it and a falling one to hardly any. With no wash
  // set this is not reached, and the particle moves as it always did.
  // A wind is the same air everywhere, added to the wash's; with neither set
  // this is not reached either.
  let wind = washes[${WASH_CAPACITY * 2}u].xyz;
  if (frame.washCount > 0.0 || any(wind != vec3f(0.0))) {
    var air = wind;
    if (frame.washCount > 0.0) { air = airAt(p.pos, u32(frame.washCount), frame.washEpsilon, wind); }
    p.vel += air * (washFollow(p.gravity) * (1.0 - exp(-drag * dt)));
  }
  p.vel.z -= frame.gravity * p.gravity * dt;
  p.pos += p.vel * dt;
  p.size += p.growth * dt;
  if (p.pos.z < p.floor) { p.age = p.life; }
  particles[i] = p;
}

`;

export const DRAW_WGSL = STRUCTS + FINITE_WGSL + `
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
  let t = p.age / p.life;
  out.colour = p.colour;
  if (p.fading > 0.0) { out.colour = mix(p.colour, p.fade, t * t * (3.0 - 2.0 * t)); }
  out.alpha = p.alpha;
  // in quickly, out slowly: the shape of a puff and of a splash both
  out.fade = min(1.0, t * 6.0) * (1.0 - t) * (1.0 - t);
  return out;
}

@fragment fn fsMain(in: VsOut) -> @location(0) vec4f {
  let r = length(in.uv);
  // one less the step up: the same curve as a step from one down to 0.3,
  // which with its edges that way round is whatever the compiler makes of it
  let soft = (1.0 - smoothstep(0.3, 1.0, r)) * in.fade;
  if (in.alpha <= 0.0) {
    // additive: colour on, nothing hidden
    return vec4f(finite(in.colour * soft), 0.0);
  }
  let a = soft * in.alpha;
  return vec4f(finite(in.colour * a), a);
}
`;

/**
 * Sprites: the same soft, camera-facing quad as a particle, but placed by the
 * game every frame rather than born and aged here, for what has to be where
 * the game's own clock says, and the same whether a frame was drawn between
 * or not: smoke rising from a chimney in a game that steps its own time. Its
 * alpha is the game's, and it is drawn over what is behind it, never added.
 */
export const SPRITE_WGSL = STRUCTS + FINITE_WGSL + `
struct Sprite { pos: vec3f, size: f32, colour: vec3f, alpha: f32 };
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> sprites: array<Sprite>;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) colour: vec3f,
  @location(2) alpha: f32,
};

@vertex fn vsMain(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> VsOut {
  var out: VsOut;
  let s = sprites[i];
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let c = corners[v];
  let world = s.pos + (frame.right * c.x + frame.up * c.y) * s.size;
  out.pos = frame.viewProj * vec4f(world, 1.0);
  out.uv = c;
  out.colour = s.colour;
  out.alpha = s.alpha;
  return out;
}

@fragment fn fsMain(in: VsOut) -> @location(0) vec4f {
  let r = length(in.uv);
  // thickest in the middle and thinning to nothing at the edge, as a puff is: no rim to show it is a disc
  let soft = exp(-3.0 * r * r) * (1.0 - smoothstep(0.75, 1.0, r));
  let a = soft * in.alpha;
  return vec4f(finite(in.colour * a), a);
}
`;

/**
 * A particle's or a sprite's shader made to fog itself, for
 * `GameRenderer.particleFog = 'own'`: the same quad, the same softness and
 * the same premultiplied colour, with the fog between the eye and the quad
 * taken out of the colour and put back as light.
 *
 * It is built from the plain shader's text and not written again beside it,
 * so the shape of a puff is said once and the plain build is untouched to the
 * byte. What the plain fragment returns is colour times its opacity and the
 * opacity; fogged, that is the colour times what the fog lets through, plus
 * the fog's own light, all times the opacity. Since the colour is already
 * multiplied by the opacity, that is `rgb * through + scattered * a`, which
 * for an additive particle, whose opacity is nought, is its glow dimmed and
 * nothing else: a spark hides nothing, so the haze in front of it is not
 * drawn over what is behind it.
 *
 * Where the fog is worked out is the one choice. A sprite works it out for
 * every fragment, by the distance to the very point of the quad it is: they
 * are few (`SPRITE_CAPACITY`) and may be large and near, and then the distance
 * across one is not the distance to its middle. A particle works it out at the
 * four corners of its quad and lets the rasteriser blend it: there are
 * thousands of them, overdrawn, and the fog's three exponentials and a power
 * for every fragment of twelve thousand smoke puffs more than doubled a fire's
 * frame (3.9 ms to 8.3 at 1280 by 800), where at the corners it costs a
 * quarter of one (to 4.9). The error of that grows with the square of the
 * quad's width over its distance and is a fraction of the fog taken, which is
 * itself a fraction of the colour: 0.2% at the middle of a puff whose
 * half-width is a fifth of its distance, which is a fat one, and a sprite is
 * the kind to use for anything wider and near.
 */
export function ownFogged(plain: string, lastVarying: string, next: number, perFragment: boolean): string {
  const tail = '@fragment fn fsMain(in: VsOut) -> @location(0) vec4f {';
  const place = '  out.pos = frame.viewProj * vec4f(world, 1.0);';
  const last = `  ${lastVarying},\n};`;
  for (const piece of [tail, place, last])
    if (!plain.includes(piece)) throw new Error('a particle shader is no longer written as the fogged build splices it, so it cannot be made from it');
  const carried = perFragment ? `@location(${next}) world: vec3f` : `@location(${next}) fog: vec4f`;
  const made = perFragment ? 'out.world = world;' : 'out.fog = fogAhead(world);';
  const got = perFragment ? 'fogAhead(in.world)' : 'in.fog';
  return plain
    .replace(last, `  ${lastVarying},\n  ${carried},\n};`)
    .replace(place, place + `\n  ${made}`)
    .replace(tail, 'fn plain(in: VsOut) -> vec4f {') + `
@group(1) @binding(0) var<uniform> fog: Fog;
${FOG_STRUCT_WGSL}${FOG_PHASE_WGSL}${FOG_AHEAD_WGSL}
@fragment fn fsMain(in: VsOut) -> @location(0) vec4f {
  let p = plain(in);
  let f = ${got};
  return vec4f(finite(p.rgb * f.a + f.rgb * p.a), p.a);
}
`;
}

export const DRAW_OWN_WGSL = ownFogged(DRAW_WGSL, '@location(3) fade: f32', 4, false);
export const SPRITE_OWN_WGSL = ownFogged(SPRITE_WGSL, '@location(2) alpha: f32', 3, true);

export class Particles {
  readonly capacity: number;
  readonly maxEmitters: number;
  readonly ready: Promise<void>;
  /** Drag on a floating particle, a second; a falling one has a sixth of it. */
  drag = 2.4;
  /** The width, in world units, under which a point is on a wash's axis: a millimetre, set by the renderer to the game's own unit. */
  washEpsilon = WASH_EPSILON_MM;

  private pool: GPUBuffer;
  private spriteBuffer: GPUBuffer;
  private spriteBind!: GPUBindGroup;
  private spritePipe!: GPURenderPipeline;
  private spriteCount = 0;
  /** How many sprites a frame may have: what `setSprites` is given past this is left out. */
  readonly spriteCapacity = SPRITE_CAPACITY;
  private emitterBuffer: GPUBuffer;
  private washBuffer: GPUBuffer;
  private washData = new Float32Array(WIND_AT + 4);
  private washCount = 0;
  private washDirty = false;
  private frameBuffer: GPUBuffer;
  private frameData = new Float32Array(32);
  private pending: Float32Array<ArrayBuffer>;
  private pendingCount = 0;
  private cursor = 0;
  private seed = 0;
  private time = 0;
  /**
   * Every burst still in the ring, oldest first, with the moment its last
   * particle can have died. The ring is filled in order, so the oldest
   * unexpired burst's first slot to the cursor is the whole run that can
   * hold a live particle, and the update and the draw cover that run and
   * nothing else: an idle pool costs nothing, a busy one costs what is in
   * it. Without this both passes walked all thirty-two thousand slots every
   * frame, which measured at 0.84ms for a pool holding a few hundred.
   */
  private bursts: { start: number; until: number }[] = [];
  /** The cursor before it wraps, so the run's length is a subtraction and
   *  a ring that has been lapped reads as full rather than as the remainder. */
  private emitted = 0;
  private emitPipe!: GPUComputePipeline;
  private updatePipe!: GPUComputePipeline;
  private drawPipe!: GPURenderPipeline;
  /** The particles' and the sprites' pipelines at four samples a pixel, made only when a renderer first asks for them. */
  private msaa: { draw: GPURenderPipeline; sprite: GPURenderPipeline } | null = null;
  private msaaBuild: Promise<void> | null = null;
  /** What the draw pipelines are made from, kept to make them again at another sample count. */
  private drawPipeline: (samples: number, sprites: boolean, own?: boolean) => GPURenderPipelineDescriptor;
  /** The builds that fog themselves, made only when a renderer first asks for `particleFog = 'own'`. */
  private own: { draw: GPURenderPipeline; sprite: GPURenderPipeline; bind: GPUBindGroup } | null = null;
  private ownBuild: Promise<void> | null = null;
  private fogLayout: GPUBindGroupLayout | null = null;
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
    this.washBuffer = device.createBuffer({ label: 'particle washes', size: (WIND_AT + 4) * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.frameBuffer = device.createBuffer({ label: 'particle frame', size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.spriteBuffer = emptyBuffer(device, SPRITE_CAPACITY * SPRITE_STRIDE * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, 'sprites');

    const computeLayout = device.createBindGroupLayout({
      label: 'particle compute',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
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
        { binding: 3, resource: { buffer: this.washBuffer } },
      ],
    });
    this.drawBind = device.createBindGroup({
      label: 'particle draw', layout: drawLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer } },
        { binding: 1, resource: { buffer: this.pool } },
      ],
    });

    // a sprite reads the same frame, and a list of its own that the game writes
    this.spriteBind = device.createBindGroup({
      label: 'sprite draw', layout: drawLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer } },
        { binding: 1, resource: { buffer: this.spriteBuffer } },
      ],
    });
    const module = shader(device, COMPUTE_WGSL, 'particles compute');
    const drawModule = shader(device, DRAW_WGSL, 'particles draw');
    const spriteModule = shader(device, SPRITE_WGSL, 'sprites draw');
    const compute = device.createPipelineLayout({ bindGroupLayouts: [computeLayout] });
    const premultiplied: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };
    // the fogged builds are compiled from their own text when first asked for, and not before
    let ownModules: { draw: GPUShaderModule; sprite: GPUShaderModule } | null = null;
    this.drawPipeline = (samples, sprites, own = false) => {
      if (own) this.fogLayout ??= device.createBindGroupLayout({
        label: 'particle fog',
        entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
      });
      if (own) ownModules ??= { draw: shader(device, DRAW_OWN_WGSL, 'particles draw fogged'), sprite: shader(device, SPRITE_OWN_WGSL, 'sprites draw fogged') };
      const m = own ? (sprites ? ownModules!.sprite : ownModules!.draw) : sprites ? spriteModule : drawModule;
      const name = `${sprites ? 'sprite draw' : 'particle draw'}${own ? ' fogged' : ''}`;
      return {
        label: samples > 1 ? `${name} x${samples}` : name,
        layout: device.createPipelineLayout({ bindGroupLayouts: own ? [drawLayout, this.fogLayout!] : [drawLayout] }),
        vertex: { module: m, entryPoint: 'vsMain' },
        fragment: { module: m, entryPoint: 'fsMain', targets: [{ format: colourFormat, blend: premultiplied }] },
        primitive: { topology: 'triangle-list' },
        // tested against the scene, never written: a puff does not hide a puff
        depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'less-equal' },
        multisample: { count: samples },
      };
    };
    this.ready = Promise.all([
      device.createComputePipelineAsync({ label: 'particle emit', layout: compute, compute: { module, entryPoint: 'emit' } })
        .then((p) => { this.emitPipe = p; }),
      device.createComputePipelineAsync({ label: 'particle update', layout: compute, compute: { module, entryPoint: 'update' } })
        .then((p) => { this.updatePipe = p; }),
      device.createRenderPipelineAsync(this.drawPipeline(1, false)).then((p) => { this.drawPipe = p; }),
      device.createRenderPipelineAsync(this.drawPipeline(1, true)).then((p) => { this.spritePipe = p; }),
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
    packEmitter(this.pending, this.pendingCount * EMITTER_STRIDE, e, count, this.cursor, this.seed++);
    this.bursts.push({ start: this.emitted, until: this.time + e.life * (1 + (e.lifeSpread ?? 0)) + 0.05 });
    this.emitted += count;
    this.cursor = this.emitted % this.capacity;
    this.pendingCount++;
    return true;
  }

  /**
   * The air blowing on the particles from the next frame on, kept until it is
   * set again: `[]` is none, and with none the update does exactly what it
   * did before there were washes. Returns whether every wash was taken, since
   * at most `WASH_CAPACITY` are and the rest are dropped; a wash that could
   * blow nothing is left out without being counted.
   */
  setWash(washes: readonly Wash[]): boolean {
    const { count, dropped } = packWashes(washes, this.washData);
    this.washCount = count;
    this.washDirty = true;
    return dropped === 0;
  }

  /**
   * The air's own velocity everywhere, world units a second, kept until set
   * again: `[0, 0, 0]` is none, and with none (and no wash) the update does
   * exactly what it did before there was a wind. The drag pulls a particle's
   * velocity toward the wind and the wash's air where it is, as closely as
   * `washFollow` says for its gravity: smoke rides it, and a drop hardly feels
   * it. Sprites are placed by the game and are not moved by it. A wind that is
   * not a number is taken as none.
   */
  setWind(wind: readonly [number, number, number]) {
    packWind(this.washData, wind);
    this.washDirty = true;
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
    // the live run of the ring, from the oldest burst that may still have
    // a particle in it to the cursor; a full ring is the whole ring
    while (this.bursts.length && this.bursts[0].until < this.time) this.bursts.shift();
    // From the oldest burst that may still have a particle to the cursor,
    // measured before wrapping: a ring that has been lapped since that burst
    // is full, and the first version read the remainder past the wrap and
    // drew a tenth of what was alive.
    const count = this.bursts.length ? Math.min(this.capacity, this.emitted - this.bursts[0].start) : 0;
    const start = this.bursts.length ? this.bursts[0].start % this.capacity : this.cursor;
    this.liveStart = start; this.liveCount = count;
    f[28] = start; f[29] = count; f[30] = this.washEpsilon; f[31] = this.washCount;
    queue.writeBuffer(this.frameBuffer, 0, f);
    if (this.washDirty) {
      queue.writeBuffer(this.washBuffer, 0, this.washData);
      this.washDirty = false;
    }
    if (this.pendingCount) {
      queue.writeBuffer(this.emitterBuffer, 0, this.pending, 0, this.pendingCount * EMITTER_STRIDE);
    }
    const pass = encoder.beginComputePass({ label: 'particles' });
    pass.setBindGroup(0, this.computeBind);
    if (this.pendingCount) {
      pass.setPipeline(this.emitPipe);
      pass.dispatchWorkgroups(this.pendingCount);
    }
    if (this.liveCount) {
      pass.setPipeline(this.updatePipe);
      pass.dispatchWorkgroups(Math.ceil(this.liveCount / 64));
    }
    pass.end();
    this.pendingCount = 0;
  }
  private liveStart = 0;
  private liveCount = 0;

  /** How many slots of the ring may hold a live particle right now. */
  get live() { return this.liveCount; }

  /**
   * This frame's sprites, `SPRITE_STRIDE` floats each, replacing the last
   * frame's: the first `count` of `data`, as many of them as there is room for.
   */
  setSprites(data: Float32Array, count: number) {
    this.spriteCount = Math.max(0, Math.min(Math.floor(count), this.spriteCapacity, Math.floor(data.length / SPRITE_STRIDE)));
    if (this.spriteCount)
      this.ctx.device.queue.writeBuffer(this.spriteBuffer, 0, data as Float32Array<ArrayBuffer>, 0, this.spriteCount * SPRITE_STRIDE);
  }

  /**
   * The draw pipelines at `samples` a pixel, for a scene drawn with that many,
   * made the first time a renderer asks and resolving when they are in. One
   * count besides one is kept: the renderer's four.
   */
  multisample(samples: number): Promise<void> {
    const { device } = this.ctx;
    this.msaaBuild ??= Promise.all([
      device.createRenderPipelineAsync(this.drawPipeline(samples, false)),
      device.createRenderPipelineAsync(this.drawPipeline(samples, true)),
    ]).then(([draw, sprite]) => { this.msaa = { draw, sprite }; });
    return this.msaaBuild;
  }

  /**
   * The fogged builds, made the first time a renderer asks for
   * `particleFog = 'own'` and resolving when they are in. They are drawn at
   * one sample a pixel whatever the scene is drawn with, after the fog, into
   * the frame's resolved colour, so no count of samples is kept for them, and
   * they read the fog from `fog`, the very buffer the march reads.
   */
  ownFog(fog: GPUBuffer): Promise<void> {
    const { device } = this.ctx;
    this.ownBuild ??= Promise.all([
      device.createRenderPipelineAsync(this.drawPipeline(1, false, true)),
      device.createRenderPipelineAsync(this.drawPipeline(1, true, true)),
    ]).then(([draw, sprite]) => {
      const bind = device.createBindGroup({ label: 'particle fog', layout: this.fogLayout!, entries: [{ binding: 0, resource: { buffer: fog } }] });
      this.own = { draw, sprite, bind };
    });
    return this.ownBuild;
  }

  /** Whether the fogged builds are in. */
  get ownReady(): boolean {
    return this.own !== null;
  }

  /** Every live particle, and every sprite, as a quad, into the pass that drew the scene, at the samples a pixel it has. */
  draw(pass: GPURenderPassEncoder, samples = 1) {
    if (!this.compiled) return;
    const msaa = samples > 1 ? this.msaa : null;
    if (samples > 1 && !msaa) return;
    this.issue(pass, msaa ? msaa.draw : this.drawPipe, msaa ? msaa.sprite : this.spritePipe);
  }

  /** The same quads through the fogged builds, into a pass over the frame the fog has already been laid on. Nothing before `ownFog` is in. */
  drawOwn(pass: GPURenderPassEncoder) {
    if (!this.compiled || !this.own) return;
    pass.setBindGroup(1, this.own.bind);
    this.issue(pass, this.own.draw, this.own.sprite);
  }

  /** What there is to draw: the sprites, then the live run of the ring, in two pieces where it wraps the end. */
  private issue(pass: GPURenderPassEncoder, draw: GPURenderPipeline, sprite: GPURenderPipeline) {
    if (this.spriteCount) {
      pass.setPipeline(sprite);
      pass.setBindGroup(0, this.spriteBind);
      pass.draw(6, this.spriteCount);
    }
    if (!this.liveCount) return;
    pass.setPipeline(draw);
    pass.setBindGroup(0, this.drawBind);
    const first = Math.min(this.liveCount, this.capacity - this.liveStart);
    pass.draw(6, first, 0, this.liveStart);
    if (first < this.liveCount) pass.draw(6, this.liveCount - first, 0, 0);
  }

  /** Whether anything would be drawn: a sprite, or a live particle. */
  get drawing(): boolean {
    return this.spriteCount > 0 || this.liveCount > 0;
  }

  dispose() {
    for (const b of [this.pool, this.emitterBuffer, this.washBuffer, this.frameBuffer, this.spriteBuffer]) b.destroy();
  }
}
