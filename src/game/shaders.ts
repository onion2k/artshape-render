/**
 * The game path's shaders.
 *
 * Nothing here is shared with `render/shaders.ts`, and that is the finding a
 * spike was built to establish rather than a preference. Measured on a
 * screen the material fills, the still-life shader costs about 11 ms a
 * megapixel — a 1080p frame of it is 22 ms, over a 60 fps budget on a
 * desktop GPU with nothing moving. Three quarters of that is two features a
 * game does not want: the table reflected in every glossy face, and a soft
 * shadow filtered over thirty-six taps. What is left after them, 2.7 ms/Mpx,
 * is still a hundred times what the shading below costs.
 *
 * So: one material model, one directional light, one prefiltered
 * environment tap, and a loop over point lights that cast nothing. A frame
 * of it at 1080p was under a tenth of a millisecond.
 *
 * Everything the ladder can give up is a module constant rather than a
 * uniform, because a branch the compiler cannot fold leaves the code
 * resident and residency is most of what a shader costs here: gating the
 * still-life renderer's table reflection behind a uniform saved nothing at
 * all, where compiling it out saved five milliseconds a megapixel.
 */

/** What a permutation of the scene shader may leave out. */
export interface SceneVariant {
  /**
   * Whether a point light beyond its radius is skipped after one distance
   * test. Exact — a light is faded to nothing at its radius, so the culled
   * and uncelled images are identical — and worth up to 2.8×. There is no
   * reason to turn it off outside a measurement.
   */
  cullLights?: boolean;
  /** Whether point lights are evaluated at all. The ladder's cheapest deep cut. */
  points?: boolean;
}

const SCENE = `
struct Frame {
  viewProj: mat4x4f,
  camPos: vec3f, exposure: f32,
  sunDir: vec3f, maxLod: f32,
  // roughness and albedo are the look's fallbacks, which the CPU folds into
  // each placement's own material before it uploads: the shader reads the
  // instance, not these. They stay in the struct because the layout is fixed
  // at 128 bytes and lightCount's offset is not worth moving.
  sunColour: vec3f, roughness: f32,
  albedo: vec3f, lightCount: f32,
};
/** A point light: where it is, how far it reaches, and what it puts out. */
struct Point { position: vec3f, radius: f32, colour: vec3f, intensity: f32 };

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var envSpecular: texture_cube<f32>;
@group(0) @binding(2) var envBrdf: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var<storage, read> points: array<Point>;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) albedo: vec3f,
  @location(3) roughness: f32,
};

@vertex fn vsMain(
  @location(0) position: vec3f, @location(1) normal: vec3f,
  @location(4) m0: vec4f, @location(5) m1: vec4f, @location(6) m2: vec4f, @location(7) m3: vec4f,
  // colour and roughness per placement, in their own instance buffer so that
  // moving a thing and recolouring it are separate writes: a game moves
  // everything every frame and recolours a few things occasionally
  @location(8) material: vec4f,
) -> VsOut {
  let model = mat4x4f(m0, m1, m2, m3);
  let world = model * vec4f(position, 1.0);
  var out: VsOut;
  out.pos = frame.viewProj * world;
  out.world = world.xyz;
  out.normal = (model * vec4f(normal, 0.0)).xyz;
  out.albedo = material.rgb;
  out.roughness = material.a;
  return out;
}

fn fresnel(f0: vec3f, cosine: f32) -> vec3f {
  return f0 + (vec3f(1.0) - f0) * pow(clamp(1.0 - cosine, 0.0, 1.0), 5.0);
}

/** GGX for one direction, without its Fresnel: the caller applies that. */
fn ggx(n: vec3f, v: vec3f, l: vec3f, ndv: f32, a2: f32, k: f32) -> f32 {
  let h = normalize(l + v);
  let ndl = max(dot(n, l), 0.0);
  let ndh = max(dot(n, h), 0.0);
  let denom = ndh * ndh * (a2 - 1.0) + 1.0;
  let d = a2 / (3.14159265 * denom * denom);
  let g = (ndl / (ndl * (1.0 - k) + k)) * (ndv / (ndv * (1.0 - k) + k));
  return d * g / max(4.0 * ndl * ndv, 1e-4);
}

@fragment fn fsMain(in: VsOut) -> @location(0) vec4f {
  let n = normalize(in.normal);
  let v = normalize(frame.camPos - in.world);
  let ndv = max(dot(n, v), 1e-4);
  // a roughness of zero is a mirror with no width to its highlight, which
  // sparkles into aliasing; 0.03 is as sharp as is worth drawing
  let rough = clamp(in.roughness, 0.03, 1.0);
  let f0 = in.albedo;
  let a = rough * rough;
  let a2 = a * a;
  let k = a * 0.5;

  // the sun: one direction, no shadow. A game that wants one casts it into
  // a map of its own; nothing here filters thirty-six taps a pixel.
  let l = normalize(frame.sunDir);
  let ndl = max(dot(n, l), 0.0);
  var colour = ggx(n, v, l, ndv, a2, k) * fresnel(f0, max(dot(normalize(l + v), v), 0.0)) * frame.sunColour * ndl;

  if (POINT_LIGHTS) {
    let count = u32(frame.lightCount);
    for (var i = 0u; i < count; i++) {
      let p = points[i];
      let toLight = p.position - in.world;
      let d2 = dot(toLight, toLight);
      if (CULL_BY_RADIUS && d2 > p.radius * p.radius) { continue; }
      let dist = sqrt(max(d2, 1e-8));
      let pl = toLight / dist;
      let pndl = max(dot(n, pl), 0.0);
      if (pndl <= 0.0) { continue; }
      // faded to nothing at the radius, so culling changes no pixel
      let reach = clamp(1.0 - d2 / (p.radius * p.radius), 0.0, 1.0);
      let atten = reach * reach / (1.0 + d2 * 0.0004);
      let spec = ggx(n, v, pl, ndv, a2, k) * fresnel(f0, max(dot(normalize(pl + v), v), 0.0));
      colour += (spec + f0 * 0.25) * p.colour * p.intensity * pndl * atten;
    }
  }

  // image based: one prefiltered tap and the split-sum lookup
  let r = reflect(-v, n);
  let pre = textureSampleLevel(envSpecular, samp, r, rough * frame.maxLod).rgb;
  let ab = textureSampleLevel(envBrdf, samp, vec2f(ndv, rough), 0.0).rg;
  colour += pre * (f0 * ab.x + ab.y);

  return vec4f(colour * frame.exposure, 1.0);
}
`;

export function sceneSource({ cullLights = true, points = true }: SceneVariant = {}): string {
  return `const CULL_BY_RADIUS: bool = ${cullLights};\nconst POINT_LIGHTS: bool = ${points};\n` + SCENE;
}

/**
 * Effects: explosions, muzzle flashes, the bright things a game draws over
 * everything else. Additive, depth-tested but never depth-writing, so no
 * layer rejects another and the overdraw is real.
 *
 * A screen-filling layer costs 0.045 ms through this and 0.147 ms through a
 * shader doing the material's work — so effects get their own stage, and it
 * is worth about three times its own weight.
 */
export const EFFECT_WGSL = `
struct Effect { colour: vec3f, _pad: f32 };
@group(0) @binding(0) var<uniform> fx: Effect;
@group(0) @binding(1) var<storage, read> quads: array<vec4f>;

struct Out { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) tint: f32 };

@vertex fn vsMain(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> Out {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  // xy centre in clip space, z half-size, w brightness
  let q = quads[i];
  let p = corners[v];
  var out: Out;
  out.pos = vec4f(q.xy + p * q.z, 0.0, 1.0);
  out.uv = p;
  out.tint = q.w;
  return out;
}

@fragment fn fsMain(in: Out) -> @location(0) vec4f {
  let a = smoothstep(1.0, 0.0, length(in.uv)) * in.tint;
  return vec4f(fx.colour * a, a);
}
`;

/** Tonemap one source to the canvas. */
export const COMPOSITE_WGSL = `
@group(0) @binding(0) var src: texture_2d<f32>;
@vertex fn vsMain(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fsMain(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let c = textureLoad(src, vec2i(pos.xy), 0).rgb;
  let m = c / (c + vec3f(1.0));
  return vec4f(pow(m, vec3f(1.0 / 2.2)), 1.0);
}
`;
