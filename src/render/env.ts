/**
 * Procedural image-based lighting, baked on the GPU.
 *
 * Metal is essentially all reflection: with nothing around it, gold renders as a
 * flat brown blob. So before any shading is worth looking at there has to be an
 * environment, and it has to have *shape* — softboxes with defined edges, not a
 * smooth gradient, because the edge of a reflected light source is what tells the
 * eye a surface is polished.
 *
 * Three textures come out: the sharp background cube with a mip chain, a
 * GGX-prefiltered cube whose mip level maps to roughness, and the split-sum
 * BRDF lookup. A small mip of the background is also read back, because the
 * occlusion bake draws its directions from where the light is.
 */

import { FULLSCREEN_VERT, halfToFloat, readbackLayer, shader, type Gpu } from '../gpu/context';

/** IEEE half from a float, round to nearest, for uploading a probe. */
function floatToHalf(value: number): number {
  const f32 = new Float32Array(1); const u32 = new Uint32Array(f32.buffer);
  f32[0] = value;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  let exp = ((x >>> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant = (mant | 0x800000) >>> (1 - exp);
    return sign | ((mant + 0x1000) >>> 13);
  }
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | ((mant + 0x1000) >>> 13);
}

export type EnvPreset = 'studio' | 'dusk' | 'gallery' | 'daylight';

export interface EnvSamples {
  /** Radiance per face, RGBA floats, row 0 first, in GL face order. */
  faces: Float32Array[];
  size: number;
}

export interface Environment {
  background: GPUTexture;
  specular: GPUTexture;
  brdf: GPUTexture;
  /** Face size of mip 0. */
  size: number;
  mips: number;
  /** Always true here: the bake is float end to end. Kept for the UI. */
  highDynamicRange: boolean;
  /** Resolves once the small-mip readback lands. */
  samples: Promise<EnvSamples>;
  dispose(): void;
}

const FORMAT: GPUTextureFormat = 'rgba16float';

const CUBE_BASIS = `
struct Basis { forward: vec3f, _p0: f32, right: vec3f, _p1: f32, up: vec3f, _p2: f32, preset: f32, roughness: f32, sourceSize: f32, _p3: f32, sun: vec3f, sunSize: f32 };
@group(0) @binding(0) var<uniform> basis: Basis;
`;

const SKY = `
${FULLSCREEN_VERT}
${CUBE_BASIS}

// A rectangular area light, hit-tested against the ray. Not a dot-product
// falloff: a soft blob reflects as a soft blob and reads like plastic.
fn rectLight(d: vec3f, centre: vec3f, right: vec3f, up: vec3f, halfSize: vec2f, colour: vec3f, softness: f32) -> vec3f {
  let n = normalize(cross(right, up));
  let denom = dot(d, n);
  let t = dot(centre, n) / denom;
  if (t <= 0.0) { return vec3f(0.0); }
  let local = d * t - centre;
  let q = vec2f(dot(local, normalize(right)), dot(local, normalize(up)));
  let e = smoothstep(halfSize + softness, halfSize - softness, abs(q));
  let f = q / halfSize;
  let middle = 1.0 - 0.3 * clamp(dot(f, f), 0.0, 1.0);
  return colour * e.x * e.y * middle;
}

fn floorHit(d: vec3f) -> vec2f { return d.xy * (-1.0 / min(d.z, -1e-3)); }

fn studio(d: vec3f) -> vec3f {
  let h = d.z;
  var wall = mix(vec3f(0.016, 0.017, 0.02), vec3f(0.05, 0.056, 0.07), smoothstep(-0.2, 1.0, h));
  wall += vec3f(0.014, 0.012, 0.01) * smoothstep(0.35, -0.1, h);
  var col = wall;
  if (h < 0.0) {
    let hit = floorHit(d);
    let toPool = hit - vec2f(0.45, -0.75);
    let pool = exp(-dot(toPool, toPool) * 0.3);
    let floorCol = vec3f(0.022, 0.022, 0.025) + vec3f(0.11, 0.105, 0.098) * pool;
    col = mix(floorCol, wall, smoothstep(-0.1, 0.0, h));
  }
  col += rectLight(d, vec3f(0.9, -1.5, 2.6), vec3f(2.4, 0.0, 0.0), vec3f(0.0, 1.5, 0.9), vec2f(1.5, 1.0), vec3f(22.0, 21.0, 19.5), 0.35);
  col += rectLight(d, vec3f(-2.6, 0.6, 0.5), vec3f(0.0, 1.8, 0.0), vec3f(0.0, 0.0, 1.8), vec2f(1.1, 1.4), vec3f(2.4, 2.8, 3.6), 0.5);
  col += rectLight(d, vec3f(1.4, 2.8, 0.9), vec3f(1.6, -0.8, 0.0), vec3f(0.0, 0.0, 1.4), vec2f(0.9, 0.7), vec3f(5.5, 4.4, 3.2), 0.4);
  col += rectLight(d, vec3f(-0.6, 1.4, 2.3), vec3f(3.0, 0.9, 0.0), vec3f(0.0, -0.5, 1.6), vec2f(2.4, 0.09), vec3f(9.0, 9.2, 9.8), 0.05);
  col += rectLight(d, vec3f(0.0, 0.0, 3.6), vec3f(3.0, 0.0, 0.0), vec3f(0.0, 3.0, 0.0), vec2f(2.6, 2.6), vec3f(0.9, 0.93, 1.0), 1.4);
  return col;
}

fn dusk(d: vec3f) -> vec3f {
  let h = d.z;
  let sky = mix(vec3f(0.25, 0.32, 0.5), vec3f(0.03, 0.05, 0.12), smoothstep(0.0, 0.85, h));
  let horizon = mix(vec3f(1.15, 0.55, 0.24), sky, smoothstep(0.0, 0.28, h));
  let ground = mix(vec3f(0.045, 0.038, 0.032), vec3f(0.14, 0.10, 0.08), smoothstep(-0.7, 0.0, h));
  var col = select(ground, horizon, h > 0.0);
  let sunDir = normalize(vec3f(0.86, 0.36, 0.10));
  let sun = smoothstep(0.9965, 0.9992, dot(d, sunDir));
  col += vec3f(46.0, 26.0, 12.0) * sun;
  col += vec3f(1.5, 0.7, 0.3) * pow(max(dot(d, sunDir), 0.0), 22.0);
  return col;
}

fn gallery(d: vec3f) -> vec3f {
  let h = d.z * 0.5 + 0.5;
  var col = mix(vec3f(0.10, 0.10, 0.105), vec3f(0.30, 0.31, 0.33), smoothstep(0.1, 0.95, h));
  if (d.z < 0.0) {
    let hit = floorHit(d);
    let near = exp(-dot(hit, hit) * 0.08);
    let floorCol = vec3f(0.13, 0.128, 0.125) + vec3f(0.07, 0.068, 0.065) * near;
    col = mix(floorCol, col, smoothstep(-0.08, 0.0, d.z));
  }
  for (var i = -1; i <= 1; i++) {
    let x = f32(i) * 2.1;
    col += rectLight(d, vec3f(x, 0.0, 3.0), vec3f(0.75, 0.0, 0.0), vec3f(0.0, 3.0, 0.0), vec2f(0.42, 1.9), vec3f(9.0, 9.0, 9.2), 0.18);
  }
  col += rectLight(d, vec3f(0.0, -3.2, 0.3), vec3f(4.0, 0.0, 0.0), vec3f(0.0, 0.0, 2.2), vec2f(2.4, 1.4), vec3f(0.9, 0.92, 1.0), 0.7);
  return col;
}

// Open air, late morning: a clear sky, blue at the zenith and paling to a
// warm haze at the horizon, a sun where the key light is — so what a
// polished face reflects is the same sun that casts the shadow — and a
// neutral ground lit by all of it, warmer on the sun's side where it
// bounces. The sky's brightness near the sun and the haze's warmth both
// follow the sun's own height, the way they do through a day.
fn daylight(d: vec3f) -> vec3f {
  let sunDir = normalize(basis.sun);
  let h = d.z;
  let sunHeight = clamp(sunDir.z, 0.05, 1.0);
  // a low sun reddens the whole sky; a high one leaves it blue
  let warmth = 1.0 - smoothstep(0.1, 0.6, sunHeight);
  let zenith = mix(vec3f(0.28, 0.46, 0.85), vec3f(0.40, 0.42, 0.62), warmth * 0.6);
  let horizon = mix(vec3f(0.78, 0.80, 0.82), vec3f(0.95, 0.72, 0.50), warmth);
  var col = mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.55));
  // aureole: the sky brightens toward the sun, most of all at the horizon
  let toSun = max(dot(d, sunDir), 0.0);
  col += mix(vec3f(1.4, 1.1, 0.8), vec3f(1.6, 0.9, 0.5), warmth) * pow(toSun, 6.0) * 0.55;
  col += vec3f(0.9, 0.85, 0.75) * pow(toSun, 30.0) * 0.6;
  if (h < 0.0) {
    // ground: neutral, a touch warmer toward the sun where light bounces,
    // darkening straight down where the sky's own light is furthest away
    let flat = vec3f(0.30, 0.28, 0.25);
    let bounce = vec3f(0.08, 0.06, 0.04) * max(dot(normalize(vec3f(d.xy, 0.0)), normalize(vec3f(sunDir.xy, 0.0))), 0.0);
    let down = smoothstep(0.0, -1.0, h);
    col = mix(horizon * 0.85, (flat + bounce) * mix(1.0, 0.7, down), smoothstep(0.0, -0.12, h));
  }
  // the sun itself: small, and bright enough to read as a sun in a mirror
  // Its size is the key's: a wider disc is dimmer per steradian so the same
  // light lands, which is a mirror's difference between a sun and a softbox.
  let radius = max(basis.sunSize, 0.017);
  let cosR = cos(radius);
  let disc = smoothstep(cosR - (1.0 - cosR) * 0.5, cosR + (1.0 - cosR) * 0.15, dot(d, sunDir));
  let area = (1.0 - cosR) / (1.0 - cos(0.017));
  col += mix(vec3f(120.0, 112.0, 100.0), vec3f(110.0, 70.0, 35.0), warmth) * disc / area;
  return col;
}

@fragment fn fsMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = uv * 2.0 - 1.0;
  let d = normalize(basis.forward + basis.right * p.x + basis.up * p.y);
  var col: vec3f;
  if (basis.preset < 0.5) { col = studio(d); }
  else if (basis.preset < 1.5) { col = dusk(d); }
  else if (basis.preset < 2.5) { col = gallery(d); }
  else { col = daylight(d); }
  return vec4f(col, 1.0);
}`;

/**
 * A photographed environment: an equirectangular map looked up by direction.
 * Longitude runs across the image, latitude down it with the horizon in the
 * middle, and +Z is up, as everywhere else here.
 */
const EQUIRECT = `
${FULLSCREEN_VERT}
${CUBE_BASIS}
@group(0) @binding(1) var image: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@fragment fn fsMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = uv * 2.0 - 1.0;
  let d = normalize(basis.forward + basis.right * p.x + basis.up * p.y);
  let lon = atan2(d.y, d.x);
  let lat = asin(clamp(d.z, -1.0, 1.0));
  let st = vec2f(0.5 - lon / 6.2831853, 0.5 - lat / 3.14159265);
  // basis.roughness carries the exposure scale for a loaded image
  return vec4f(textureSampleLevel(image, samp, st, 0.0).rgb * basis.roughness, 1.0);
}`;

/**
 * A probe face as drawn carries each pixel's distance in alpha, for the depth
 * of field (the table's negated); the probe wants a plain hit mask there.
 */
const MASK = `
${FULLSCREEN_VERT}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@fragment fn fsMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let c = textureSampleLevel(src, samp, uv, 0.0);
  return vec4f(c.rgb, select(0.0, 1.0, c.a != 0.0));
}`;

/**
 * One mip level down: a linear sample at the centre of each texel averages
 * the four beneath. Alpha comes along: for a probe it is the hit mask, and a
 * level that reported a hit everywhere would blot out the sky behind every
 * reflection softer than a mirror.
 */
const DOWNSAMPLE = `
${FULLSCREEN_VERT}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@fragment fn fsMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(src, samp, uv, 0.0);
}`;

const GGX_COMMON = `
const PI: f32 = 3.14159265359;

fn radicalInverse(bits0: u32) -> f32 {
  var bits = bits0;
  bits = (bits << 16u) | (bits >> 16u);
  bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
  bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
  bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
  bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
  return f32(bits) * 2.3283064365386963e-10;
}

fn importanceGGX(xi: vec2f, n: vec3f, a: f32) -> vec3f {
  let phi = 2.0 * PI * xi.x;
  let cosTheta = sqrt((1.0 - xi.y) / (1.0 + (a * a - 1.0) * xi.y));
  let sinTheta = sqrt(1.0 - cosTheta * cosTheta);
  let h = vec3f(cos(phi) * sinTheta, sin(phi) * sinTheta, cosTheta);
  let up = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(n.z) < 0.999);
  let tx = normalize(cross(up, n));
  let ty = cross(n, tx);
  return normalize(tx * h.x + ty * h.y + n * h.z);
}
`;

const PREFILTER = `
${FULLSCREEN_VERT}
${CUBE_BASIS}
${GGX_COMMON}
@group(0) @binding(1) var source: texture_cube<f32>;
@group(0) @binding(2) var samp: sampler;

@fragment fn fsMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = uv * 2.0 - 1.0;
  let n = normalize(basis.forward + basis.right * p.x + basis.up * p.y);
  let v = n;
  let SAMPLES = 128u;
  // never let alpha reach zero: the pdf becomes 0/0 and mip 0 fills with NaN
  let a = max(basis.roughness * basis.roughness, 1e-3);
  var sum = vec4f(0.0);
  var weight = 0.0;
  for (var i = 0u; i < SAMPLES; i++) {
    let xi = vec2f(f32(i) / f32(SAMPLES), radicalInverse(i));
    let h = importanceGGX(xi, n, a);
    let l = normalize(2.0 * dot(v, h) * h - v);
    let ndl = dot(n, l);
    if (ndl <= 0.0) { continue; }
    // sample from a mip chosen by solid angle, or a bright softbox turns into fireflies
    let ndh = max(dot(n, h), 0.0);
    let d = (ndh * ndh * (a * a - 1.0) + 1.0);
    let pdf = (a * a) / max(PI * d * d, 1e-8) * 0.25 + 1e-4;
    let saTexel = 4.0 * PI / (6.0 * basis.sourceSize * basis.sourceSize);
    let saSample = 1.0 / (f32(SAMPLES) * pdf + 0.0001);
    let lod = select(0.5 * log2(saSample / saTexel), 0.0, basis.roughness == 0.0);
    sum += textureSampleLevel(source, samp, l, lod) * ndl;
    weight += ndl;
  }
  // alpha comes along: for a probe it is the hit mask, premultiplied
  return sum / max(weight, 0.001);
}`;

const BRDF = `
${FULLSCREEN_VERT}
${GGX_COMMON}

fn geometrySmith(ndv: f32, ndl: f32, roughness: f32) -> f32 {
  let k = (roughness * roughness) / 2.0;
  let gv = ndv / (ndv * (1.0 - k) + k);
  let gl = ndl / (ndl * (1.0 - k) + k);
  return gv * gl;
}

@fragment fn fsMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let ndv = max(uv.x, 0.001);
  let roughness = uv.y;
  let v = vec3f(sqrt(1.0 - ndv * ndv), 0.0, ndv);
  let n = vec3f(0.0, 0.0, 1.0);
  let a = roughness * roughness;
  var scale = 0.0;
  var bias = 0.0;
  let SAMPLES = 512u;
  for (var i = 0u; i < SAMPLES; i++) {
    let xi = vec2f(f32(i) / f32(SAMPLES), radicalInverse(i));
    let h = importanceGGX(xi, n, a);
    let l = normalize(2.0 * dot(v, h) * h - v);
    let ndl = max(l.z, 0.0);
    if (ndl <= 0.0) { continue; }
    let ndh = max(h.z, 0.0);
    let vdh = max(dot(v, h), 0.0);
    let g = geometrySmith(ndv, ndl, roughness);
    let gVis = (g * vdh) / max(ndh * ndv, 0.0001);
    let fc = pow(1.0 - vdh, 5.0);
    scale += (1.0 - fc) * gVis;
    bias += fc * gVis;
  }
  return vec4f(scale / f32(SAMPLES), bias / f32(SAMPLES), 0.0, 1.0);
}`;

/** [forward, right, up] per cube face, in GL's face order, which WebGPU shares. */
const FACES: Array<[number[], number[], number[]]> = [
  [[1, 0, 0], [0, 0, -1], [0, -1, 0]],
  [[-1, 0, 0], [0, 0, 1], [0, -1, 0]],
  [[0, 1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, -1, 0], [1, 0, 0], [0, 0, -1]],
  [[0, 0, 1], [1, 0, 0], [0, -1, 0]],
  [[0, 0, -1], [-1, 0, 0], [0, -1, 0]],
];

const PRESET_INDEX: Record<EnvPreset, number> = { studio: 0, dusk: 1, gallery: 2, daylight: 3 };
const BASIS_STRIDE = 256;

interface Pipelines {
  sky: GPURenderPipeline;
  equirect: GPURenderPipeline;
  down: GPURenderPipeline;
  mask: GPURenderPipeline;
  prefilter: GPURenderPipeline;
  brdf: GPURenderPipeline;
  sampler: GPUSampler;
  /** For the photograph: wraps round in longitude. */
  imageSampler: GPUSampler;
}

const pipelines = new WeakMap<GPUDevice, Promise<Pipelines>>();
const compiled = new WeakMap<GPUDevice, Pipelines>();

/** The bake's pipelines, compiled off the main thread once per device. */
function getPipelines(device: GPUDevice): Promise<Pipelines> {
  let p = pipelines.get(device);
  if (p) return p;
  // The basis slot is addressed by dynamic offset, which an automatic layout
  // never grants, so the two pipelines that use it get explicit layouts.
  const basisEntry: GPUBindGroupLayoutEntry = {
    binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true },
  };
  const skyLayout = device.createBindGroupLayout({ entries: [basisEntry] });
  const equirectLayout = device.createBindGroupLayout({
    entries: [
      basisEntry,
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ],
  });
  const prefilterLayout = device.createBindGroupLayout({
    entries: [
      basisEntry,
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: 'cube' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ],
  });
  const make = (code: string, label: string, layout?: GPUBindGroupLayout) => {
    const module = shader(device, code, label);
    return device.createRenderPipelineAsync({
      label,
      layout: layout ? device.createPipelineLayout({ bindGroupLayouts: [layout] }) : 'auto',
      vertex: { module, entryPoint: 'vsFullscreen' },
      fragment: { module, entryPoint: 'fsMain', targets: [{ format: FORMAT }] },
    });
  };
  const samplers = {
    sampler: device.createSampler({
      magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge',
    }),
    imageSampler: device.createSampler({
      magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'clamp-to-edge',
    }),
  };
  p = Promise.all([
    make(SKY, 'env sky', skyLayout), make(EQUIRECT, 'env equirect', equirectLayout), make(DOWNSAMPLE, 'env downsample'),
    make(MASK, 'probe mask'), make(PREFILTER, 'env prefilter', prefilterLayout), make(BRDF, 'env brdf'),
  ]).then(([sky, equirect, down, mask, prefilter, brdf]) => {
    const all = { sky, equirect, down, mask, prefilter, brdf, ...samplers };
    compiled.set(device, all);
    return all;
  });
  pipelines.set(device, p);
  return p;
}

/** Resolves once the environment's pipelines have compiled on this device; asked for early, they compile beside the renderer's. */
export function envPipelinesReady(device: GPUDevice): Promise<void> {
  return getPipelines(device).then(() => {});
}

/** The pipelines, which must have compiled: `envPipelinesReady` says when. */
function pipelinesNow(device: GPUDevice): Pipelines {
  const p = compiled.get(device);
  if (!p) throw new Error('environment pipelines used before they compiled');
  return p;
}

/** A photographed environment to bake from: an equirectangular float image, and the factor that brings it to the presets' scale. */
export interface EnvImage {
  width: number;
  height: number;
  /** RGBA floats, row 0 at the top. */
  data: Float32Array;
  scale: number;
}

export function bakeEnvironment(
  ctx: Gpu,
  preset: EnvPreset,
  opts: { size?: number; mips?: number; brdfSize?: number; sampleSize?: number; sun?: [number, number, number]; sunSize?: number; image?: EnvImage } = {},
): Environment {
  const { device } = ctx;
  // a photograph, uploaded as a float texture for the equirect pipeline to read
  let imageTexture: GPUTexture | null = null;
  if (opts.image) {
    const img = opts.image;
    // half floats: a 32-bit float texture cannot be filtered without an
    // optional feature, and the probe is sampled bilinearly into the cube
    const half = new Uint16Array(img.data.length);
    for (let i = 0; i < img.data.length; i++) half[i] = floatToHalf(img.data[i]);
    imageTexture = device.createTexture({
      label: 'env image', size: [img.width, img.height], format: FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: imageTexture }, half as Uint16Array<ArrayBuffer>, { bytesPerRow: img.width * 8 }, [img.width, img.height]);
  }
  let disposed = false;
  const size = opts.size ?? 512;
  const mips = opts.mips ?? 8;
  const brdfSize = opts.brdfSize ?? 128;
  const sampleSize = opts.sampleSize ?? 64;

  const cube = (levels: number, label: string) => device.createTexture({
    label, size: [size, size, 6], format: FORMAT, mipLevelCount: levels,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
  });
  const backgroundMips = Math.floor(Math.log2(size)) + 1;
  const background = cube(backgroundMips, 'env background');
  const specular = cube(mips, 'env specular');
  const brdf = device.createTexture({
    label: 'env brdf', size: [brdfSize, brdfSize], format: FORMAT,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });

  // one uniform buffer with a slot per (face, level) draw, addressed by dynamic offset
  const slots = 6 + 6 * mips;
  const basisBuffer = device.createBuffer({ size: slots * BASIS_STRIDE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const basisData = new Float32Array((slots * BASIS_STRIDE) / 4);
  // where the sun is, for the presets that have one; toward the light
  const sun = opts.sun ?? [0.5, -0.6, 0.62];
  const setBasis = (slot: number, face: number, roughness: number) => {
    const [f, r, u] = FACES[face];
    basisData.set(
      [f[0], f[1], f[2], 0, r[0], r[1], r[2], 0, u[0], u[1], u[2], 0, PRESET_INDEX[preset], roughness, size, 0, sun[0], sun[1], sun[2], opts.sunSize ?? 0],
      (slot * BASIS_STRIDE) / 4,
    );
  };
  // for a photograph the roughness slot of the sky draws carries its exposure scale
  for (let face = 0; face < 6; face++) setBasis(face, face, opts.image ? opts.image.scale : 0);
  for (let level = 0; level < mips; level++) {
    for (let face = 0; face < 6; face++) setBasis(6 + level * 6 + face, face, mips > 1 ? level / (mips - 1) : 0);
  }
  device.queue.writeBuffer(basisBuffer, 0, basisData);

  const faceView = (tex: GPUTexture, face: number, level: number) =>
    tex.createView({ dimension: '2d', baseArrayLayer: face, arrayLayerCount: 1, baseMipLevel: level, mipLevelCount: 1 });
  const drawTo = (encoder: GPUCommandEncoder, view: GPUTextureView, pipeline: GPURenderPipeline, bind: GPUBindGroup, offsets?: number[]) => {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind, offsets);
    pass.draw(3);
    pass.end();
  };

  // The bake waits for its pipelines only the first time, while they compile
  // off the main thread — the textures are handed out now and are black until
  // it lands. Once compiled it encodes and submits before returning, as a
  // caller that draws with the environment straight after relies on.
  const drawn = (async () => {
    const pipes = compiled.get(device) ?? (await getPipelines(device));
    if (disposed) return;
    const encoder = device.createCommandEncoder({ label: 'env bake' });

    // --- 1. the environment itself, then its mip chain one level at a time ---
    const skyPipe = imageTexture ? pipes.equirect : pipes.sky;
    const skyBind = device.createBindGroup({
      layout: skyPipe.getBindGroupLayout(0),
      entries: imageTexture
        ? [
          { binding: 0, resource: { buffer: basisBuffer, size: BASIS_STRIDE } },
          { binding: 1, resource: imageTexture.createView() },
          { binding: 2, resource: pipes.imageSampler },
        ]
        : [{ binding: 0, resource: { buffer: basisBuffer, size: BASIS_STRIDE } }],
    });
    for (let face = 0; face < 6; face++) {
      drawTo(encoder, faceView(background, face, 0), skyPipe, skyBind, [face * BASIS_STRIDE]);
    }
    for (let level = 1; level < backgroundMips; level++) {
      for (let face = 0; face < 6; face++) {
        const bind = device.createBindGroup({
          layout: pipes.down.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: faceView(background, face, level - 1) },
            { binding: 1, resource: pipes.sampler },
          ],
        });
        drawTo(encoder, faceView(background, face, level), pipes.down, bind);
      }
    }

    // --- 2. GGX prefilter into a second cube, level by level ---
    const prefilterBind = device.createBindGroup({
      layout: pipes.prefilter.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: basisBuffer, size: BASIS_STRIDE } },
        { binding: 1, resource: background.createView({ dimension: 'cube' }) },
        { binding: 2, resource: pipes.sampler },
      ],
    });
    for (let level = 0; level < mips; level++) {
      for (let face = 0; face < 6; face++) {
        drawTo(encoder, faceView(specular, face, level), pipes.prefilter, prefilterBind, [(6 + level * 6 + face) * BASIS_STRIDE]);
      }
    }

    // --- 3. split-sum BRDF lookup ---
    const brdfBind = device.createBindGroup({ layout: pipes.brdf.getBindGroupLayout(0), entries: [] });
    drawTo(encoder, brdf.createView(), pipes.brdf, brdfBind);

    device.queue.submit([encoder.finish()]);
  })();

  // --- 4. a small mip of the background, read back for direction sampling ---
  const sampleLod = Math.max(0, Math.round(Math.log2(size / sampleSize)));
  const realSize = Math.max(1, size >> sampleLod);
  // Six readbacks, one submit each, awaited in turn: an environment disposed
  // while they are under way — the light moved again before the first bake's
  // sky had been read — must not submit copies from a destroyed texture.
  const samples = (async () => {
    await drawn;
    const faces: Float32Array[] = [];
    for (let face = 0; face < 6 && !disposed; face++) {
      const raw = new Uint16Array(await readbackLayer(device, background, face, sampleLod, realSize, 8));
      const out = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i++) out[i] = halfToFloat(raw[i]);
      faces.push(out);
    }
    return { faces, size: realSize };
  })();

  return {
    background,
    specular,
    brdf,
    size,
    mips,
    highDynamicRange: true,
    samples,
    dispose() {
      disposed = true;
      background.destroy();
      specular.destroy();
      brdf.destroy();
      basisBuffer.destroy();
      imageTexture?.destroy();
    },
  };
}

/**
 * Filter a cube that has already been drawn — a reflection probe of the
 * piece — the way the sky is filtered: its mip chain by averaging, then a
 * GGX prefilter into a second cube, level by roughness. Records the passes
 * on the encoder given, so a probe can be drawn, filtered and read in one
 * frame.
 */
export function filterCube(
  ctx: Gpu, encoder: GPUCommandEncoder,
  raw: GPUTexture, background: GPUTexture, specular: GPUTexture, size: number, mips: number,
): { dispose(): void } {
  const { device } = ctx;
  const pipes = pipelinesNow(device);
  const backgroundMips = Math.floor(Math.log2(size)) + 1;
  const slots = 6 * mips;
  const basisBuffer = device.createBuffer({ size: slots * BASIS_STRIDE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const basisData = new Float32Array((slots * BASIS_STRIDE) / 4);
  for (let level = 0; level < mips; level++) {
    for (let face = 0; face < 6; face++) {
      const [f, r, u] = FACES[face];
      basisData.set(
        [f[0], f[1], f[2], 0, r[0], r[1], r[2], 0, u[0], u[1], u[2], 0, 0, mips > 1 ? level / (mips - 1) : 0, size, 0, 0, 0, 0, 0],
        ((level * 6 + face) * BASIS_STRIDE) / 4,
      );
    }
  }
  device.queue.writeBuffer(basisBuffer, 0, basisData);
  const faceView = (tex: GPUTexture, face: number, level: number) =>
    tex.createView({ dimension: '2d', baseArrayLayer: face, arrayLayerCount: 1, baseMipLevel: level, mipLevelCount: 1 });
  const drawTo = (view: GPUTextureView, pipeline: GPURenderPipeline, bind: GPUBindGroup, offsets?: number[]) => {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind, offsets);
    pass.draw(3);
    pass.end();
  };
  // the drawn faces in, with alpha made a hit mask
  for (let face = 0; face < 6; face++) {
    const bind = device.createBindGroup({
      layout: pipes.mask.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: faceView(raw, face, 0) }, { binding: 1, resource: pipes.sampler }],
    });
    drawTo(faceView(background, face, 0), pipes.mask, bind);
  }
  for (let level = 1; level < backgroundMips; level++) {
    for (let face = 0; face < 6; face++) {
      const bind = device.createBindGroup({
        layout: pipes.down.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: faceView(background, face, level - 1) },
          { binding: 1, resource: pipes.sampler },
        ],
      });
      drawTo(faceView(background, face, level), pipes.down, bind);
    }
  }
  const prefilterBind = device.createBindGroup({
    layout: pipes.prefilter.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: basisBuffer, size: BASIS_STRIDE } },
      { binding: 1, resource: background.createView({ dimension: 'cube' }) },
      { binding: 2, resource: pipes.sampler },
    ],
  });
  for (let level = 0; level < mips; level++) {
    for (let face = 0; face < 6; face++) {
      drawTo(faceView(specular, face, level), pipes.prefilter, prefilterBind, [(level * 6 + face) * BASIS_STRIDE]);
    }
  }
  return { dispose() { basisBuffer.destroy(); } };
}

/**
 * The sky as a distribution over the sample cube's texels: radiance times
 * solid angle, cumulative and normalised, for a path tracer to draw
 * directions from in proportion to how much light comes from them. A small
 * floor keeps every texel drawable, so no direction has a density of zero.
 * Texels run face by face, row by row, as the readback lays them.
 */
export interface SkyDistribution {
  cdf: Float32Array;
  /** How much of the sky's light the brightest hundredth of its texels carry: 1 a sun alone, near 0.01 an even sky. */
  concentration: number;
}
export function skyDistribution(env: EnvSamples): SkyDistribution {
  const { faces, size } = env;
  const n = 6 * size * size;
  const lum = (f: number, x: number, y: number) => {
    const i = (y * size + x) * 4;
    return 0.2126 * faces[f][i] + 0.7152 * faces[f][i + 1] + 0.0722 * faces[f][i + 2];
  };
  let mean = 0;
  for (let f = 0; f < 6; f++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) mean += lum(f, x, y);
  mean /= Math.max(n, 1);
  const floor = mean * 0.02 + 1e-6;
  const cdf = new Float32Array(n);
  let acc = 0;
  for (let f = 0; f < 6; f++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        acc += (lum(f, x, y) + floor) * texelSolidAngle(x, y, size);
        cdf[(f * size + y) * size + x] = acc;
      }
    }
  }
  for (let i = 0; i < n; i++) cdf[i] /= acc;
  if (n) cdf[n - 1] = 1;
  // the mass of each texel, sorted, for how peaked the sky is
  const mass = new Float64Array(n);
  for (let i = 0; i < n; i++) mass[i] = cdf[i] - (i ? cdf[i - 1] : 0);
  mass.sort();
  let top = 0;
  for (let i = n - Math.max(1, Math.round(n / 100)); i < n; i++) top += mass[i];
  return { cdf, concentration: top };
}

/** The solid angle of a cube face's texel, from its centre. */
export function texelSolidAngle(x: number, y: number, size: number): number {
  const sc = (2 * (x + 0.5)) / size - 1;
  const tc = (2 * (y + 0.5)) / size - 1;
  return 4 / (size * size * Math.pow(1 + sc * sc + tc * tc, 1.5));
}

/** Cube face texel (sc, tc) to a unit direction, in GL's face convention. */
export function cubeDirection(face: number, sc: number, tc: number): [number, number, number] {
  let v: [number, number, number];
  switch (face) {
    case 0: v = [1, -tc, -sc]; break;
    case 1: v = [-1, -tc, sc]; break;
    case 2: v = [sc, 1, tc]; break;
    case 3: v = [sc, -1, -tc]; break;
    case 4: v = [sc, -tc, 1]; break;
    default: v = [-sc, -tc, -1]; break;
  }
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}
