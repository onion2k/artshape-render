/**
 * HDR output: the scene renders into a multisampled float target, bloom is drawn
 * from what overshoots white, and one composite pass tonemaps to the canvas.
 *
 * Kept in a float target, a softbox reflected in polished gold can spill into
 * its neighbours the way it does through a real lens — a glow, not a flat white
 * patch — and the tonemap sees the whole frame at once. WebGPU resolves the
 * multisampling for free on the way out of the scene pass.
 */

import { FULLSCREEN_VERT, shader, type Gpu } from '../gpu/context';

/** The film: how the finished frame is brought to the screen. */
export interface Film {
  /** 0 the ACES fit, 1 AgX. */
  tonemap: number;
  /** Darkening toward the corners, 0..1. */
  vignette: number;
  /** Film grain, 0..1. */
  grain: number;
  /** Lateral colour at the edges of the frame, 0..1. */
  fringe: number;
}

export interface PostOptions {
  bloom: number;
  /** Debug views want their raw values shown, not tonemapped and bloomed. */
  raw: boolean;
  film: Film;
  /**
   * Depth of field: the distance in focus, and how hard everything off it
   * blurs (0 off). The scene's alpha channel carries each pixel's distance
   * to the eye, so no depth texture has to be read back.
   */
  focus: number;
  dof: number;
  /** Distance to the piece's own centre — the table is kept no sharper than this. */
  subject: number;
  /** Tint what is in focus: the helper photographers know as peaking. */
  peaking?: boolean;
}

const HDR: GPUTextureFormat = 'rgba16float';
const SAMPLES = 4;
const BLOOM_LEVELS = 5;

const BRIGHT = `
${FULLSCREEN_VERT}
struct Params { threshold: f32, knee: f32, _p: vec2f };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> params: Params;
@fragment fn fsMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let c = textureSample(src, samp, uv).rgb;
  let l = max(max(c.r, c.g), c.b);
  var soft = clamp(l - params.threshold + params.knee, 0.0, 2.0 * params.knee);
  soft = soft * soft / (4.0 * params.knee + 1e-4);
  let contribution = max(soft, l - params.threshold) / max(l, 1e-4);
  return vec4f(c * contribution, 1.0);
}`;

const DOWN = `
${FULLSCREEN_VERT}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@fragment fn fsMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(src));
  var sum = textureSample(src, samp, uv).rgb * 4.0;
  sum += textureSample(src, samp, uv + t * vec2f(-1.0, -1.0)).rgb;
  sum += textureSample(src, samp, uv + t * vec2f( 1.0, -1.0)).rgb;
  sum += textureSample(src, samp, uv + t * vec2f(-1.0,  1.0)).rgb;
  sum += textureSample(src, samp, uv + t * vec2f( 1.0,  1.0)).rgb;
  return vec4f(sum / 8.0, 1.0);
}`;

const UP = `
${FULLSCREEN_VERT}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@fragment fn fsMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(src));
  var sum = vec3f(0.0);
  sum += textureSample(src, samp, uv + t * vec2f(-1.0,  0.0)).rgb * 2.0;
  sum += textureSample(src, samp, uv + t * vec2f( 1.0,  0.0)).rgb * 2.0;
  sum += textureSample(src, samp, uv + t * vec2f( 0.0, -1.0)).rgb * 2.0;
  sum += textureSample(src, samp, uv + t * vec2f( 0.0,  1.0)).rgb * 2.0;
  sum += textureSample(src, samp, uv + t * vec2f(-1.0, -1.0)).rgb;
  sum += textureSample(src, samp, uv + t * vec2f( 1.0, -1.0)).rgb;
  sum += textureSample(src, samp, uv + t * vec2f(-1.0,  1.0)).rgb;
  sum += textureSample(src, samp, uv + t * vec2f( 1.0,  1.0)).rgb;
  return vec4f(sum / 12.0, 1.0);
}`;

const DOF = `
${FULLSCREEN_VERT}
struct Params { focus: f32, strength: f32, maxRadius: f32, subject: f32 };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> params: Params;

fn cocAt(d: f32) -> f32 {
  let rel = (d - params.focus) / params.focus;
  let r = select(rel, -rel * 1.5, rel < 0.0);
  return clamp(r * params.strength * params.maxRadius, 0.0, params.maxRadius);
}

// circle of confusion in pixels: the far side blurs by how far past focus
// it lies, the near side faster, as a lens does. The clear colour (alpha 0)
// is the sky, all the way out of focus. The table flags itself with a
// negative distance, and is kept no sharper than the piece's own centre —
// a lens focused past a subject puts a crisp band across the table behind
// a blurred piece, which is right for a lens and wrong for a shop window.
fn coc(a: f32) -> f32 {
  if (a == 0.0) { return cocAt(params.focus * 8.0); }
  if (a < 0.0) { return max(cocAt(-a), cocAt(params.subject)); }
  return cocAt(a);
}

// A gather over a golden-angle disc, each tap weighted by whether its own
// circle reaches this pixel — a sharp thing in front does not smear over
// what is behind it, and an in-focus thing does not bleed into a blurred
// background. One pass at full size: the pieces are small, the taps are few.
// Explicit-level samples, since the in-focus early return leaves the loop
// in non-uniform control flow, where implicit-derivative sampling isn't allowed.
@fragment fn fsMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(src));
  let centre = textureSampleLevel(src, samp, uv, 0.0);
  let r0 = coc(centre.a);
  if (r0 < 0.5) { return centre; }
  var sum = centre.rgb;
  var weight = 1.0;
  let taps = 40;
  for (var i = 1; i <= taps; i++) {
    let t = f32(i) / f32(taps);
    let ang = f32(i) * 2.39996323;
    let rad = sqrt(t) * r0;
    let off = vec2f(cos(ang), sin(ang)) * rad / size;
    let s = textureSampleLevel(src, samp, uv + off, 0.0);
    // a tap counts in proportion to how far its own circle reaches
    let w = clamp(coc(s.a) / max(rad, 1e-3), 0.0, 1.0);
    sum += s.rgb * w;
    weight += w;
  }
  return vec4f(sum / weight, centre.a);
}`;

/**
 * Supersampling's other half: the scene was drawn at a whole multiple of the
 * canvas, and each canvas pixel is the plain mean of its block. A box is the
 * right filter here — the block's samples all belong to this pixel and to no
 * other — and it is what a camera's sensor does over each of its wells.
 */
const DOWNSAMPLE = `
${FULLSCREEN_VERT}
struct Params { factor: u32, _p: u32, _q: vec2u };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: Params;
@fragment fn fsMain(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let base = vec2u(pos.xy) * params.factor;
  var sum = vec4f(0.0);
  for (var y = 0u; y < params.factor; y++) {
    for (var x = 0u; x < params.factor; x++) {
      sum += textureLoad(src, base + vec2u(x, y), 0);
    }
  }
  return sum / f32(params.factor * params.factor);
}`;

const COMPOSITE = `
${FULLSCREEN_VERT}
struct Params {
  bloom: f32, raw: f32, tonemap: f32, vignette: f32, grain: f32, fringe: f32,
  // focus peaking: 0 off, else the distance in focus, the blur's strength and its
  // widest circle, so what would blur under two pixels can be tinted as sharp
  peak: f32, focus: f32, strength: f32, maxRadius: f32, subject: f32, _p: f32,
};
@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var bloom: texture_2d<f32>;

// Narkowicz's ACES fit: punchy, saturates bright colour toward white
fn acesFit(x: vec3f) -> vec3f {
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

// AgX (Sobotka), the base look: a log encoding over sixteen and a half
// stops, a sigmoid fitted to film, and a colour inset and outset either
// side so bright saturated colour desaturates toward white the way film
// does instead of skewing hue. A neon tube keeps its colour into its core.
fn agxInset(v: vec3f) -> vec3f {
  return vec3f(
    0.842479062253094 * v.x + 0.0423282422610123 * v.y + 0.0423756549057051 * v.z,
    0.0784335999999992 * v.x + 0.878468636469772 * v.y + 0.0784336 * v.z,
    0.0792237451477643 * v.x + 0.0791661274605434 * v.y + 0.879142973793104 * v.z);
}
fn agxOutset(v: vec3f) -> vec3f {
  return vec3f(
    1.19687900512017 * v.x - 0.0528968517574562 * v.y - 0.0529716355144438 * v.z,
    -0.0980208811401368 * v.x + 1.15190312990417 * v.y - 0.0980434501171241 * v.z,
    -0.0990297440797205 * v.x - 0.0989611768448433 * v.y + 1.15107367264116 * v.z);
}
fn agxSigmoid(x: vec3f) -> vec3f {
  let x2 = x * x; let x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
fn agx(colour: vec3f) -> vec3f {
  let minEv = -12.47393; let maxEv = 4.026069;
  var v = agxInset(max(colour, vec3f(1e-10)));
  v = clamp(log2(v), vec3f(minEv), vec3f(maxEv));
  v = (v - minEv) / (maxEv - minEv);
  v = agxSigmoid(v);
  // the base look is a straight line through; out of the working space,
  // and the sigmoid's output is already display-encoded, so back to linear
  v = agxOutset(v);
  return pow(clamp(v, vec3f(0.0), vec3f(1.0)), vec3f(2.2));
}

// the display's own curve, not a plain power
fn srgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

fn hash(p: vec2f) -> f32 {
  let q = fract(p * vec2f(0.1031, 0.1030));
  let r = q + dot(q, q.yx + 33.33);
  return fract((r.x + r.y) * r.x);
}

@fragment fn fsMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(scene));
  let centred = (uv - 0.5) * vec2f(size.x / size.y, 1.0);
  let r2 = dot(centred, centred);
  // lateral colour: the red and blue channels land a little inside and
  // outside the green, more toward the edge of the frame
  let shift = (uv - 0.5) * r2 * params.fringe * 0.012;
  var s = textureSample(scene, samp, uv).rgb;
  if (params.fringe > 0.0) {
    s = vec3f(textureSample(scene, samp, uv - shift).r, s.g, textureSample(scene, samp, uv + shift).b);
  }
  let b = textureSample(bloom, samp, uv).rgb;
  var lit = s + b * params.bloom;
  // the lens lets less through toward its corners
  lit *= 1.0 - params.vignette * smoothstep(0.15, 1.1, r2);
  var colour = select(acesFit(lit), agx(lit), params.tonemap > 0.5);
  // grain in the display domain, finer in the highlights as on film, and
  // fixed to the pixel rather than the frame so a still frame stays still
  let g = (hash(uv * size) - 0.5) * params.grain * 0.12;
  colour = clamp(colour + g * (1.0 - colour * 0.6), vec3f(0.0), vec3f(1.0));
  if (params.raw > 0.5) { colour = s; }
  // focus peaking: the piece and the table carry their distance in alpha
  // (the table's negated); what lies within the sharp band goes green
  if (params.peak > 0.5) {
    let a = textureSample(scene, samp, uv).a;
    let d = abs(a);
    if (d > 0.0) {
      let rel = (d - params.focus) / params.focus;
      let r = select(rel, -rel * 1.5, rel < 0.0);
      var coc = r * params.strength * params.maxRadius;
      // the table is kept no sharper than the piece's centre, as the blur keeps it
      if (a < 0.0) {
        let relS = (params.subject - params.focus) / params.focus;
        coc = max(coc, select(relS, -relS * 1.5, relS < 0.0) * params.strength * params.maxRadius);
      }
      let sharp = 1.0 - smoothstep(0.6, 1.6, coc);
      colour = mix(colour, vec3f(0.25, 0.95, 0.4), sharp * 0.55);
    }
  }
  return vec4f(srgb(colour), 1.0);
}`;

export class PostChain {
  private width = 0;
  private height = 0;

  private msaa: GPUTexture | null = null;
  private depth: GPUTexture | null = null;
  private resolve: GPUTexture | null = null;
  private dof: GPUTexture | null = null;
  private bloom: GPUTexture[] = [];
  /** The scene brought down to the canvas's size, when it was drawn above it. */
  private framed: GPUTexture | null = null;
  /** Rendered pixels per canvas pixel along each side. */
  private factor = 1;

  private sampler: GPUSampler;
  // assigned as each compiles; nothing here is drawn with before `ready`
  private brightPipe!: GPURenderPipeline;
  private downPipe!: GPURenderPipeline;
  private upPipe!: GPURenderPipeline;
  private compositePipe!: GPURenderPipeline;
  private dofPipe!: GPURenderPipeline;
  private downsamplePipe!: GPURenderPipeline;
  /** Resolves when every pipeline has compiled. */
  readonly ready: Promise<void>;
  private downsampleParams: GPUBuffer;
  private brightParams: GPUBuffer;
  private compositeParams: GPUBuffer;
  private dofParams: GPUBuffer;
  private dofData = new Float32Array(4);

  // Views, made once with their textures. A render pass needs one per
  // attachment, and making them per frame is a dozen driver objects a frame
  // for something that only changes when the targets are rebuilt.
  private msaaView: GPUTextureView | null = null;
  private resolveView: GPUTextureView | null = null;
  private depthView: GPUTextureView | null = null;
  private bloomViews: GPUTextureView[] = [];
  /** Rewritten in place each frame rather than allocated. */
  private compositeData = new Float32Array(12);

  private brightBind: GPUBindGroup | null = null;
  private downBinds: GPUBindGroup[] = [];
  private upBinds: GPUBindGroup[] = [];
  private compositeBind: GPUBindGroup | null = null;
  private compositeDofBind: GPUBindGroup | null = null;
  private dofBind: GPUBindGroup | null = null;
  private dofView: GPUTextureView | null = null;
  private framedView: GPUTextureView | null = null;
  private downsampleBind: GPUBindGroup | null = null;
  private downsampleDofBind: GPUBindGroup | null = null;

  readonly depthFormat: GPUTextureFormat = 'depth24plus';
  readonly colourFormat = HDR;
  readonly sampleCount = SAMPLES;

  constructor(private ctx: Gpu) {
    const { device } = ctx;
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    // compiled off the main thread, all at once: `ready` resolves when every one is
    const waits: Promise<unknown>[] = [];
    const pipe = (code: string, label: string, assign: (p: GPURenderPipeline) => void, blend?: GPUBlendState, format: GPUTextureFormat = HDR) => {
      const module = shader(device, code, label);
      waits.push(device.createRenderPipelineAsync({
        label,
        layout: 'auto',
        vertex: { module, entryPoint: 'vsFullscreen' },
        fragment: { module, entryPoint: 'fsMain', targets: [{ format, blend }] },
        primitive: { topology: 'triangle-list' },
      }).then(assign));
    };
    const additive: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    };
    pipe(BRIGHT, 'bloom bright', (p) => { this.brightPipe = p; });
    pipe(DOWN, 'bloom down', (p) => { this.downPipe = p; });
    pipe(UP, 'bloom up', (p) => { this.upPipe = p; }, additive);
    pipe(COMPOSITE, 'composite', (p) => { this.compositePipe = p; }, undefined, ctx.format);
    pipe(DOF, 'depth of field', (p) => { this.dofPipe = p; });
    pipe(DOWNSAMPLE, 'supersample down', (p) => { this.downsamplePipe = p; });
    this.ready = Promise.all(waits).then(() => { this.compiled = true; this.makeBinds(); });
    this.downsampleParams = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    this.brightParams = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.brightParams, 0, new Float32Array([1.2, 0.5, 0, 0]));
    this.compositeParams = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.dofParams = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** The scene's targets, which stand `factor` times above the canvas each way. */
  get renderWidth() { return this.width * this.factor; }
  /** The scene target itself, for anything that wants to write a frame into the chain. */
  get sceneTexture() { return this.resolve; }
  get renderHeight() { return this.height * this.factor; }

  /**
   * Size the targets to a canvas of `width` by `height`, with the scene drawn
   * `factor` times larger each way and brought down to fit. Supersampling on
   * top of the multisampling: the multisampler only sees edges, and a final
   * frame wants its shading — engraving, wire, sparkle, grain — sampled more
   * than once per pixel too.
   */
  resize(canvasWidth: number, canvasHeight: number, factor = 1) {
    canvasWidth = Math.max(1, Math.floor(canvasWidth));
    canvasHeight = Math.max(1, Math.floor(canvasHeight));
    factor = Math.max(1, Math.floor(factor));
    if (canvasWidth === this.width && canvasHeight === this.height && factor === this.factor) return;
    this.width = canvasWidth;
    this.height = canvasHeight;
    this.factor = factor;
    const width = canvasWidth * factor, height = canvasHeight * factor;
    this.release();
    const { device } = this.ctx;
    device.queue.writeBuffer(this.downsampleParams, 0, new Uint32Array([factor, 0, 0, 0]));

    this.msaa = device.createTexture({
      size: [width, height], format: HDR, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT, label: 'scene msaa',
    });
    this.depth = device.createTexture({
      size: [width, height], format: this.depthFormat, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT, label: 'scene depth',
    });
    // storage too: the path tracer writes its mean straight into it
    this.resolve = device.createTexture({
      size: [width, height], format: HDR, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING, label: 'scene resolve',
    });
    this.dof = device.createTexture({
      size: [width, height], format: HDR, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING, label: 'depth of field',
    });
    if (factor > 1) {
      this.framed = device.createTexture({
        size: [canvasWidth, canvasHeight], format: HDR, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING, label: 'framed',
      });
      this.framedView = this.framed.createView();
    }

    this.bloom = [];
    let w = width, h = height;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
      this.bloom.push(device.createTexture({
        size: [w, h], format: HDR, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING, label: `bloom ${i}`,
      }));
    }

    this.msaaView = this.msaa.createView();
    this.resolveView = this.resolve.createView();
    this.dofView = this.dof.createView();
    this.depthView = this.depth.createView();
    this.bloomViews = this.bloom.map((t) => t.createView());
    // the bind groups want the pipelines' layouts, which may still be compiling: then they follow `ready`
    if (this.compiled) this.makeBinds();
  }

  /** Whether every pipeline has compiled, so bind groups can be made against their layouts. */
  private compiled = false;

  private makeBinds() {
    const { device } = this.ctx;
    if (!this.resolve || !this.dof || !this.bloom.length) return;
    const view = (t: GPUTexture) => t.createView();
    this.brightBind = device.createBindGroup({
      layout: this.brightPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: view(this.resolve) },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.brightParams } },
      ],
    });
    this.downBinds = [];
    this.upBinds = [];
    for (let i = 1; i < BLOOM_LEVELS; i++) {
      this.downBinds.push(device.createBindGroup({
        layout: this.downPipe.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: view(this.bloom[i - 1]) }, { binding: 1, resource: this.sampler }],
      }));
    }
    for (let i = BLOOM_LEVELS - 2; i >= 0; i--) {
      this.upBinds.push(device.createBindGroup({
        layout: this.upPipe.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: view(this.bloom[i + 1]) }, { binding: 1, resource: this.sampler }],
      }));
    }
    const compositeFrom = (t: GPUTexture) => device.createBindGroup({
      layout: this.compositePipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: view(t) },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.compositeParams } },
        { binding: 3, resource: view(this.bloom[0]) },
      ],
    });
    if (this.framed) {
      // the film sees the frame at the canvas's size, from either source
      const downFrom = (t: GPUTexture) => device.createBindGroup({
        layout: this.downsamplePipe.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: view(t) }, { binding: 1, resource: { buffer: this.downsampleParams } }],
      });
      this.downsampleBind = downFrom(this.resolve);
      this.downsampleDofBind = downFrom(this.dof);
      this.compositeBind = this.compositeDofBind = compositeFrom(this.framed);
    } else {
      this.compositeBind = compositeFrom(this.resolve);
      this.compositeDofBind = compositeFrom(this.dof);
    }
    this.dofBind = device.createBindGroup({
      layout: this.dofPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: view(this.resolve) },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.dofParams } },
      ],
    });
  }

  /** The scene pass: multisampled HDR colour resolved on store, plus depth. */
  scenePass(clear: [number, number, number]): GPURenderPassDescriptor {
    return {
      colorAttachments: [{
        view: this.msaaView!,
        resolveTarget: this.resolveView!,
        // alpha 0 marks the clear colour as sky for the depth of field pass
        clearValue: { r: clear[0], g: clear[1], b: clear[2], a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.depthView!,
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
      },
    };
  }

  /** Bloom the resolved scene and composite it onto the canvas. */
  finish(encoder: GPUCommandEncoder, canvasView: GPUTextureView, opts: PostOptions) {
    const { device } = this.ctx;
    this.compositeData[0] = opts.raw ? 0 : opts.bloom;
    this.compositeData[1] = opts.raw ? 1 : 0;
    this.compositeData[2] = opts.film.tonemap;
    this.compositeData[3] = opts.raw ? 0 : opts.film.vignette;
    this.compositeData[4] = opts.raw ? 0 : opts.film.grain;
    this.compositeData[5] = opts.raw ? 0 : opts.film.fringe;
    // peaking reads the band the blur would leave sharp; with the blur off it
    // shows the band a middling blur would, so the helper says something either way
    this.compositeData[6] = opts.peaking ? 1 : 0;
    this.compositeData[7] = opts.focus;
    this.compositeData[8] = opts.dof > 0 ? opts.dof : 0.5;
    this.compositeData[9] = Math.max(6, Math.min(this.renderWidth, this.renderHeight) * 0.03);
    this.compositeData[10] = opts.subject;
    device.queue.writeBuffer(this.compositeParams, 0, this.compositeData);

    const draw = (pipeline: GPURenderPipeline, bind: GPUBindGroup, target: GPUTextureView, load: GPULoadOp) => {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: target, loadOp: load, storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      pass.draw(3);
      pass.end();
    };

    if (!opts.raw) {
      draw(this.brightPipe, this.brightBind!, this.bloomViews[0], 'clear');
      for (let i = 1; i < BLOOM_LEVELS; i++) {
        draw(this.downPipe, this.downBinds[i - 1], this.bloomViews[i], 'clear');
      }
      let k = 0;
      for (let i = BLOOM_LEVELS - 2; i >= 0; i--) {
        draw(this.upPipe, this.upBinds[k++], this.bloomViews[i], 'load');
      }
    }
    const blur = !opts.raw && opts.dof > 0;
    if (blur) {
      this.dofData.set([opts.focus, opts.dof, Math.max(6, Math.min(this.renderWidth, this.renderHeight) * 0.03), opts.subject]);
      device.queue.writeBuffer(this.dofParams, 0, this.dofData);
      draw(this.dofPipe, this.dofBind!, this.dofView!, 'clear');
    }
    if (this.framed) {
      draw(this.downsamplePipe, blur ? this.downsampleDofBind! : this.downsampleBind!, this.framedView!, 'clear');
    }
    draw(this.compositePipe, blur ? this.compositeDofBind! : this.compositeBind!, canvasView, 'clear');
  }

  private release() {
    this.msaa?.destroy();
    this.depth?.destroy();
    this.resolve?.destroy();
    this.framed?.destroy();
    this.framed = null;
    this.framedView = null;
    this.dof?.destroy();
    for (const t of this.bloom) t.destroy();
    this.msaa = this.depth = this.resolve = this.dof = null;
    this.msaaView = this.resolveView = this.depthView = this.dofView = null;
    this.bloom = [];
    this.bloomViews = [];
  }

  dispose() {
    this.release();
    this.brightParams.destroy();
    this.compositeParams.destroy();
    this.dofParams.destroy();
  }
}

/** The linear value that tonemaps to a given display value; used for the clear colour. */
/** AgX in TypeScript, the same maths as the shader, for inverting the background colour. */
export function agxJs(c: [number, number, number]): [number, number, number] {
  const inset = (v: number[]) => [
    0.842479062253094 * v[0] + 0.0423282422610123 * v[1] + 0.0423756549057051 * v[2],
    0.0784335999999992 * v[0] + 0.878468636469772 * v[1] + 0.0784336 * v[2],
    0.0792237451477643 * v[0] + 0.0791661274605434 * v[1] + 0.879142973793104 * v[2],
  ];
  const outset = (v: number[]) => [
    1.19687900512017 * v[0] - 0.0528968517574562 * v[1] - 0.0529716355144438 * v[2],
    -0.0980208811401368 * v[0] + 1.15190312990417 * v[1] - 0.0980434501171241 * v[2],
    -0.0990297440797205 * v[0] - 0.0989611768448433 * v[1] + 1.15107367264116 * v[2],
  ];
  const sig = (x: number) => {
    const x2 = x * x, x4 = x2 * x2;
    return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
  };
  const minEv = -12.47393, maxEv = 4.026069;
  let v = inset(c.map((x) => Math.max(x, 1e-10)));
  v = v.map((x) => (Math.min(maxEv, Math.max(minEv, Math.log2(x))) - minEv) / (maxEv - minEv));
  v = v.map(sig);
  v = outset(v);
  return v.map((x) => Math.pow(Math.min(1, Math.max(0, x)), 2.2)) as [number, number, number];
}

/**
 * The linear radiance that the film brings to a given display colour, so a
 * page colour can be painted behind the piece and come back out as itself.
 * The ACES fit inverts per channel by bisection; AgX mixes channels, so it
 * is solved by iteration, which converges in a handful of steps for any
 * colour a page is likely to be.
 */
export function inverseTonemap(display: [number, number, number], tonemap = 1): [number, number, number] {
  const fromSrgb = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const target = display.map(fromSrgb) as [number, number, number];
  if (tonemap < 0.5) {
    const aces = (x: number) => {
      const a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
      return Math.min(1, Math.max(0, (x * (a * x + b)) / (x * (c * x + d) + e)));
    };
    return target.map((t) => {
      let lo = 0, hi = 20;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (aces(mid) < t) lo = mid; else hi = mid;
      }
      return (lo + hi) / 2;
    }) as [number, number, number];
  }
  let guess: [number, number, number] = [Math.max(target[0], 1e-4), Math.max(target[1], 1e-4), Math.max(target[2], 1e-4)];
  for (let i = 0; i < 40; i++) {
    const out = agxJs(guess);
    guess = guess.map((g, k) => Math.min(50, Math.max(1e-6, g * Math.pow(Math.max(target[k], 1e-6) / Math.max(out[k], 1e-6), 0.9)))) as [number, number, number];
  }
  return guess;
}
