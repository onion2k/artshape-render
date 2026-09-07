/**
 * A cushion under the piece.
 *
 * A cloth table is not a plane: a pillow is a plump pad with rounded edges,
 * and whatever is set on it sinks in, the cloth draping down to meet it.
 * This bakes that shape as a height map over the ground disc, in three steps:
 *
 * 1. The piece is rendered straight down into a depth map, so every texel
 *    of the ground knows how high the underside of the piece is above it.
 * 2. A min-plus "cone" pass spreads that outward: the cloth may be no higher
 *    than the piece's underside at any point, nor higher than that plus a
 *    slope times the distance away. The slope is steep: this is the collar
 *    of cloth bunched against whatever touches it, a few millimetres wide.
 *    It is run along eight directions in turn, so the collar is round enough.
 * 3. A blur of the piece's footprint says how much of the cloth each part of
 *    it is carrying: a plate presses the cushion down across its whole
 *    extent, a ring a little, a stem hardly at all beyond its own collar.
 *    Only what comes down to the cloth counts — a canopy high above it
 *    carries nothing. That is the sag, and it is what keeps a thin trunk
 *    from digging a pit.
 * 4. The result is capped by the cushion's own dome: a rounded-square pad
 *    that stands `puff` millimetres proud and falls to the table at its rim.
 *
 * The ground mesh reads the height in its vertex shader and its fragment
 * shader takes the normal from the height's gradient, so lighting, shadow
 * and sheen all see the real shape.
 */
import { shader, type Gpu } from '../gpu/context';

export const CUSHION_SIZE = 512;

const CONE_WGSL = `
struct Params {
  centre: vec3f,
  radius: f32,     // of the ground disc: the map spans 2r
  puff: f32,       // how proud the cushion stands, world units
  slope: f32,      // how steeply the cloth drapes off a part, a ratio
  clearance: f32,  // the cloth stays this far under a part's underside
  size: f32,       // the cushion's half-side as a fraction of the radius
  dir: vec2i,      // the direction this pass sweeps
  stage: u32,      // 0 sweep from the depth map; 1 sweep from the height map; 2 finish; 3 blur the footprint; 4 blur again
  unitMm: f32,     // millimetres in one world unit
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var pieceDepth: texture_depth_2d;
@group(0) @binding(2) var src: texture_2d<f32>;
@group(0) @binding(3) var dst: texture_storage_2d<r32float, write>;
@group(0) @binding(4) var aux: texture_2d<f32>;

const FAR = 1e9;

// height texel -> where the piece's depth render put that point
fn undersideAt(p: vec2i) -> f32 {
  let s = f32(${CUSHION_SIZE});
  let local = (vec2f(p) + 0.5) / s * 2.0 - 1.0;
  // the depth render looked straight down with its x along -y and its y along +x
  let ndc = vec2f(-local.y, local.x);
  let uv = vec2f(ndc.x * 0.5 + 0.5, 1.0 - (ndc.y * 0.5 + 0.5));
  let q = vec2i(clamp(uv * s, vec2f(0.0), vec2f(s - 1.0)));
  let d = textureLoad(pieceDepth, q, 0);
  if (d >= 0.9999) { return FAR; }
  // depth runs 0 at the eye, 2r above the centre, to 1 at 4r below that
  return params.centre.z + params.radius * 2.0 - d * params.radius * 4.0 - params.clearance;
}

fn valueAt(p: vec2i) -> f32 {
  if (params.stage == 0u) { return undersideAt(p); }
  return textureLoad(src, p, 0).r;
}

fn dome(p: vec2i) -> f32 {
  let s = f32(${CUSHION_SIZE});
  let local = (vec2f(p) + 0.5) / s * 2.0 - 1.0;
  let q = abs(local) / params.size;
  // a rounded square, plump: a gentle crown across the top, and a soft
  // shoulder rolling down to the rim rather than a wall
  let e = pow(pow(q.x, 4.0) + pow(q.y, 4.0), 0.25);
  let shoulder = 1.0 - smoothstep(0.45, 1.0, e);
  let crown = 0.8 + 0.2 * max(0.0, 1.0 - e * e);
  return params.puff * shoulder * crown;
}

@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let p = vec2i(id.xy);
  let s = i32(${CUSHION_SIZE});
  if (p.x >= s || p.y >= s) { return; }
  let texel = params.radius * 2.0 / f32(s);
  if (params.stage == 2u) {
    // the cushion's own shape, sagging under what it carries, and no higher
    // than the collar allows; a part set on the table itself may push the
    // cloth a little below it
    let cone = textureLoad(src, p, 0).r;
    let carried = textureLoad(aux, p, 0).r;
    let sag = params.puff * smoothstep(0.05, 0.6, carried);
    let h = min(dome(p) - sag, cone - params.centre.z);
    textureStore(dst, p, vec4f(max(h, -params.clearance), 0.0, 0.0, 0.0));
    return;
  }
  if (params.stage == 3u || params.stage == 4u) {
    // how much of the cloth nearby is under the piece: a box blur of the
    // footprint, sixteen millimetres or so wide, one axis per pass — wide
    // enough that the inside of a ring is carried down with its band
    let reach = max(1, i32(8.0 / (texel * params.unitMm)));
    // a tent rather than a box, so a ring's inside does not show the two axes
    var sum = 0.0;
    var n = 0.0;
    for (var k = -reach; k <= reach; k++) {
      let q = p + params.dir * k;
      if (q.x < 0 || q.y < 0 || q.x >= s || q.y >= s) { continue; }
      let w = 1.0 - abs(f32(k)) / f32(reach + 1);
      if (params.stage == 3u) {
        // only what reaches the cloth presses it: a canopy high over the
        // cushion carries no weight on it, its trunk does
        let underside = undersideAt(q);
        let top = params.centre.z + params.puff;
        sum += w * (1.0 - smoothstep(top, top + 3.0 / params.unitMm, underside));
      }
      else { sum += w * textureLoad(src, q, 0).r; }
      n += w;
    }
    textureStore(dst, p, vec4f(sum / max(n, 1.0), 0.0, 0.0, 0.0));
    return;
  }
  let stepLength = length(vec2f(params.dir)) * texel;
  var best = valueAt(p);
  for (var k = 1; k <= 40; k++) {
    let rise = params.slope * f32(k) * stepLength;
    let a = p + params.dir * k;
    let b = p - params.dir * k;
    if (a.x >= 0 && a.y >= 0 && a.x < s && a.y < s) { best = min(best, valueAt(a) + rise); }
    if (b.x >= 0 && b.y >= 0 && b.x < s && b.y < s) { best = min(best, valueAt(b) + rise); }
  }
  textureStore(dst, p, vec4f(best, 0.0, 0.0, 0.0));
}
`;

export interface CushionShape {
  /** How proud the cushion stands, in world units. */
  puff: number;
  /** How steeply the cloth drapes away from a part, a ratio. */
  slope: number;
  /** The cushion's half-side, as a fraction of the ground radius. */
  size: number;
}

export class CushionBake {
  readonly height: GPUTexture;
  private scratch: GPUTexture;
  private pressure: GPUTexture;
  // assigned when it compiles; no bake runs before `ready`
  private pipeline!: GPUComputePipeline;
  /** Resolves when the pipeline has compiled. */
  readonly ready: Promise<void>;
  private layout: GPUBindGroupLayout;
  private params: GPUBuffer;

  constructor(private ctx: Gpu) {
    const { device } = ctx;
    const make = (label: string) => device.createTexture({
      label, size: [CUSHION_SIZE, CUSHION_SIZE], format: 'r32float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.height = make('cushion height');
    this.scratch = make('cushion scratch');
    this.pressure = make('cushion pressure');
    this.layout = device.createBindGroupLayout({
      label: 'cushion',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'depth' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { format: 'r32float', access: 'write-only' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
    this.ready = device.createComputePipelineAsync({
      label: 'cushion',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module: shader(device, CONE_WGSL, 'cushion'), entryPoint: 'main' },
    }).then((p) => { this.pipeline = p; });
    // eleven passes, each with its own slice of parameters
    this.params = device.createBuffer({ label: 'cushion params', size: 256 * 11, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /**
   * Bake from a depth render of the piece seen straight down over the ground
   * disc (centre, radius). Records the passes on the encoder.
   */
  /** `mmPerUnit`: millimetres in one world unit, for the sizes the bake fixes — how wide a footprint spreads, how high over the cloth a part stops pressing. */
  bake(encoder: GPUCommandEncoder, pieceDepth: GPUTextureView, centre: number[], radius: number, shape: CushionShape, mmPerUnit = 1) {
    const { device } = this.ctx;
    const clearance = 0.25 / mmPerUnit;
    const h = this.height, sc = this.scratch, pr = this.pressure;
    const sweeps: Array<{ dir: [number, number]; stage: number; from: GPUTexture; to: GPUTexture; aux?: GPUTexture }> = [
      // the collar: eight directions, alternating between the two scratch textures
      { dir: [1, 0], stage: 0, from: sc, to: h },
      { dir: [0, 1], stage: 1, from: h, to: sc },
      { dir: [1, 1], stage: 1, from: sc, to: h },
      { dir: [1, -1], stage: 1, from: h, to: sc },
      { dir: [2, 1], stage: 1, from: sc, to: h },
      { dir: [1, 2], stage: 1, from: h, to: sc },
      { dir: [2, -1], stage: 1, from: sc, to: h },
      { dir: [1, -2], stage: 1, from: h, to: sc },
      // the sag: the footprint blurred, one axis then the other
      { dir: [1, 0], stage: 3, from: sc, to: h },
      { dir: [0, 1], stage: 4, from: h, to: pr },
      // and the cushion from both
      { dir: [0, 0], stage: 2, from: sc, to: h, aux: pr },
    ];
    const data = new ArrayBuffer(256 * sweeps.length);
    sweeps.forEach((s, i) => {
      const f32 = new Float32Array(data, i * 256, 8);
      const i32 = new Int32Array(data, i * 256 + 32, 3);
      f32.set([centre[0], centre[1], centre[2], radius, shape.puff, shape.slope, clearance, shape.size]);
      i32.set([s.dir[0], s.dir[1], s.stage]);
      new Float32Array(data, i * 256 + 44, 1)[0] = mmPerUnit;
    });
    device.queue.writeBuffer(this.params, 0, data);
    const groups = Math.ceil(CUSHION_SIZE / 8);
    sweeps.forEach((s, i) => {
      const bind = device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.params, offset: i * 256, size: 48 } },
          { binding: 1, resource: pieceDepth },
          { binding: 2, resource: s.from.createView() },
          { binding: 3, resource: s.to.createView() },
          { binding: 4, resource: (s.aux ?? s.from).createView() },
        ],
      });
      const pass = encoder.beginComputePass({ label: `cushion ${i}` });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(groups, groups);
      pass.end();
    });
  }
}
