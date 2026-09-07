/**
 * Contact occlusion, per pixel.
 *
 * The baked occlusion is per vertex, and between vertices it is smeared: a
 * rivet meeting a plate, a stone in its seat, a leaf lying on a leaf all
 * shade as if the parts were an inch apart. This adds what the bake cannot:
 * for each pixel, how much of the hemisphere over it is blocked by what the
 * depth buffer shows nearby, within a few millimetres.
 *
 * Three passes a frame: the piece's depth alone at render resolution (the
 * scene's own depth is multisampled and thrown away), occlusion at half
 * resolution from a few directions and steps with a per-pixel turn, and a
 * blur that respects depth so the noise goes and the edges stay.
 */
import { FULLSCREEN_VERT, shader, type Gpu } from '../gpu/context';

const AO = `
${FULLSCREEN_VERT}
struct Params {
  size: vec2f,        // of this pass's target
  depthSize: vec2f,   // of the depth buffer
  tanHalf: f32,       // of the vertical field of view
  aspect: f32,
  near: f32,
  far: f32,
  radius: f32,        // reach in world units
  strength: f32,
  shift: vec2f,       // the camera's lens shift, which moved the image on the frame
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var depthTex: texture_depth_2d;

fn linearDepth(d: f32) -> f32 {
  return params.near * params.far / (params.far - d * (params.far - params.near));
}
fn depthAt(uv: vec2f) -> f32 {
  let p = vec2i(clamp(uv, vec2f(0.0), vec2f(0.9999)) * params.depthSize);
  return textureLoad(depthTex, p, 0);
}
fn viewPos(uv: vec2f, z: f32) -> vec3f {
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0) + 2.0 * params.shift;
  return vec3f(ndc.x * params.aspect * params.tanHalf * z, ndc.y * params.tanHalf * z, -z);
}
fn hash(p: vec2f) -> f32 {
  let q = fract(p * vec2f(0.1031, 0.1030));
  let r = q + dot(q, q.yx + 33.33);
  return fract((r.x + r.y) * r.x);
}

@fragment fn fsMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let d = depthAt(uv);
  if (d >= 0.9999) { return vec4f(1.0); }
  let z = linearDepth(d);
  let p = viewPos(uv, z);
  // the surface's normal from its neighbours in the depth buffer: a small
  // step either side, taking the nearer pair so an edge does not smear
  let du = vec2f(1.0, 0.0) / params.size;
  let dv = vec2f(0.0, 1.0) / params.size;
  let px1 = viewPos(uv + du, linearDepth(depthAt(uv + du)));
  let px0 = viewPos(uv - du, linearDepth(depthAt(uv - du)));
  let py1 = viewPos(uv + dv, linearDepth(depthAt(uv + dv)));
  let py0 = viewPos(uv - dv, linearDepth(depthAt(uv - dv)));
  let dx = select(px1 - p, p - px0, abs(px0.z - p.z) < abs(px1.z - p.z));
  let dy = select(py1 - p, p - py0, abs(py0.z - p.z) < abs(py1.z - p.z));
  var n = normalize(cross(dx, dy));
  if (dot(n, -p) < 0.0) { n = -n; }

  // the reach on screen, in this pass's pixels
  let radiusPx = clamp(params.radius * (params.size.y / (2.0 * params.tanHalf)) / z, 2.0, 48.0);
  let pixel = uv * params.size;
  let turn = hash(pixel) * 6.2831853;
  let jitter = hash(pixel + 7.0);
  let DIRS = 4;
  let STEPS = 6;
  var occlusion = 0.0;
  var count = 0.0;
  for (var i = 0; i < DIRS; i++) {
    let a = turn + f32(i) * 6.2831853 / f32(DIRS);
    let dir = vec2f(cos(a), sin(a));
    for (var k = 1; k <= STEPS; k++) {
      let s = (f32(k) - 0.5 + jitter * 0.5) / f32(STEPS) * radiusPx;
      let uv2 = uv + dir * s / params.size;
      if (any(uv2 < vec2f(0.0)) || any(uv2 > vec2f(1.0))) { continue; }
      let d2 = depthAt(uv2);
      if (d2 >= 0.9999) { count += 1.0; continue; }
      let q = viewPos(uv2, linearDepth(d2));
      let v = q - p;
      let dist = length(v);
      // what blocks the hemisphere: something above the surface, within reach
      let ndl = dot(n, v / max(dist, 1e-4));
      let falloff = clamp(1.0 - (dist * dist) / (params.radius * params.radius), 0.0, 1.0);
      occlusion += max(ndl - 0.12, 0.0) * falloff;
      count += 1.0;
    }
  }
  let ao = 1.0 - params.strength * occlusion / max(count, 1.0) * 1.6;
  return vec4f(clamp(ao, 0.0, 1.0));
}`;

const BLUR = `
${FULLSCREEN_VERT}
struct Params { size: vec2f, depthSize: vec2f, tanHalf: f32, aspect: f32, near: f32, far: f32, radius: f32, strength: f32, shift: vec2f };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var depthTex: texture_depth_2d;
@group(0) @binding(2) var src: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

fn linearDepth(d: f32) -> f32 {
  return params.near * params.far / (params.far - d * (params.far - params.near));
}
fn depthAt(uv: vec2f) -> f32 {
  let p = vec2i(clamp(uv, vec2f(0.0), vec2f(0.9999)) * params.depthSize);
  return linearDepth(textureLoad(depthTex, p, 0));
}

// a 5x5 box that does not cross an edge: a tap counts only if its depth is
// near the centre's, so the noise averages out within a surface and stops
// at the silhouette
@fragment fn fsMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  let z0 = depthAt(uv);
  var sum = 0.0;
  var weight = 0.0;
  for (var y = -2; y <= 2; y++) {
    for (var x = -2; x <= 2; x++) {
      let o = vec2f(f32(x), f32(y)) / params.size;
      let z = depthAt(uv + o);
      let w = select(0.0, 1.0, abs(z - z0) < z0 * 0.03 + params.radius * 0.5);
      sum += textureSampleLevel(src, samp, uv + o, 0.0).r * w;
      weight += w;
    }
  }
  return vec4f(sum / max(weight, 1e-3));
}`;

export interface AoCamera {
  fovY: number;
  aspect: number;
  near: number;
  far: number;
  shift: [number, number];
}

export class ContactOcclusion {
  /** The piece's depth at render resolution, drawn each frame by the caller. */
  depth: GPUTexture | null = null;
  depthView: GPUTextureView | null = null;
  /** The finished occlusion, half resolution, 1 in the open. */
  view: GPUTextureView | null = null;
  private raw: GPUTexture | null = null;
  private blurred: GPUTexture | null = null;
  // assigned as each compiles; nothing here runs before `ready`
  private aoPipe!: GPURenderPipeline;
  private blurPipe!: GPURenderPipeline;
  /** Resolves when both pipelines have compiled. */
  readonly ready: Promise<void>;
  private params: GPUBuffer;
  private sampler: GPUSampler;
  private width = 0;
  private height = 0;
  /** Reach in world units, and how dark the deepest contact goes. */
  radius = 2.5;
  strength = 1;

  constructor(private ctx: Gpu, private depthFormat: GPUTextureFormat) {
    const { device } = ctx;
    const make = (code: string, label: string) => {
      const module = shader(device, code, label);
      return device.createRenderPipelineAsync({
        label, layout: 'auto',
        vertex: { module, entryPoint: 'vsFullscreen' },
        fragment: { module, entryPoint: 'fsMain', targets: [{ format: 'r8unorm' }] },
      });
    };
    this.ready = Promise.all([
      make(AO, 'contact occlusion').then((p) => { this.aoPipe = p; }),
      make(BLUR, 'contact occlusion blur').then((p) => { this.blurPipe = p; }),
    ]).then(() => {});
    this.params = device.createBuffer({ label: 'ao params', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width; this.height = height;
    const { device } = this.ctx;
    this.depth?.destroy(); this.raw?.destroy(); this.blurred?.destroy();
    this.depth = device.createTexture({
      label: 'ao depth', size: [width, height], format: this.depthFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.depthView = this.depth.createView();
    const hw = Math.max(1, Math.ceil(width / 2)), hh = Math.max(1, Math.ceil(height / 2));
    const half = (label: string) => device.createTexture({
      label, size: [hw, hh], format: 'r8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.raw = half('ao raw');
    this.blurred = half('ao');
    this.view = this.blurred.createView();
  }

  /** Compute the occlusion from the depth the caller has just drawn. */
  run(encoder: GPUCommandEncoder, camera: AoCamera) {
    if (!this.depth || !this.raw || !this.blurred) return;
    const { device } = this.ctx;
    const hw = this.raw.width, hh = this.raw.height;
    device.queue.writeBuffer(this.params, 0, new Float32Array([
      hw, hh, this.width, this.height,
      Math.tan(camera.fovY / 2), camera.aspect, camera.near, camera.far,
      this.radius, this.strength, camera.shift[0], camera.shift[1],
    ]));
    const draw = (pipe: GPURenderPipeline, entries: GPUBindGroupEntry[], target: GPUTexture, label: string) => {
      const bind = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries });
      const pass = encoder.beginRenderPass({
        label, colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 1, g: 1, b: 1, a: 1 } }],
      });
      pass.setPipeline(pipe);
      pass.setBindGroup(0, bind);
      pass.draw(3);
      pass.end();
    };
    draw(this.aoPipe, [
      { binding: 0, resource: { buffer: this.params } },
      { binding: 1, resource: this.depthView! },
    ], this.raw, 'contact occlusion');
    draw(this.blurPipe, [
      { binding: 0, resource: { buffer: this.params } },
      { binding: 1, resource: this.depthView! },
      { binding: 2, resource: this.raw.createView() },
      { binding: 3, resource: this.sampler },
    ], this.blurred, 'contact occlusion blur');
  }

  dispose() {
    this.depth?.destroy(); this.raw?.destroy(); this.blurred?.destroy();
    this.params.destroy();
  }
}
