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
  /**
   * Whether the sun and the shadowed spotlights read their maps. Off, the
   * lookups compile out and the maps are never rendered; the sun still has
   * its diffuse term either way.
   */
  shadows?: boolean;
}

/** How many spotlights may carry a shadow map at once. */
export const SPOT_SHADOWS = 8;

const SCENE = `
struct Frame {
  viewProj: mat4x4f,
  camPos: vec3f, exposure: f32,
  sunDir: vec3f, maxLod: f32,
  // How far a point light carries: the distance at which it is down to half,
  // in world units. It used to be a constant of 0.0004 applied to the squared
  // distance, which is a half-distance of fifty — right for a piece of
  // jewellery a few centimetres across and hopeless in an arena measured in
  // metres, where every light was a bright dot with nothing around it.
  sunColour: vec3f, falloffHalf: f32,
  // albedo is the look's fallback, folded into each placement's own material
  // by the CPU before it uploads; the shader reads the instance, not this. It
  // stays in the struct because the layout is fixed at 128 bytes and
  // lightCount's offset is not worth moving. The ambient term scales what
  // the environment contributes, which is everything a scene is lit by
  // before a single point light is added.
  albedo: vec2f, ambient: f32, lightCount: f32,
};
/**
 * A light: where it is, how far it reaches, what it puts out, and — for a
 * spotlight — which way it faces and how wide its cone is. A light with no
 * cone stores an outer edge of -2, which no cosine can be below, so the cone
 * term folds to one and it throws in every direction as it always did.
 */
struct Point {
  position: vec3f, radius: f32,
  colour: vec3f, intensity: f32,
  direction: vec3f, cosOuter: f32,
  // Three separate f32s and not a vec3f. A vec3f aligns to sixteen bytes, so
  // written as one it would sit at offset 64 rather than 52 and make this
  // struct eighty bytes against the sixteen floats the CPU writes — every
  // light after the first would read the tail of the one before it. Which is
  // exactly what happened, and what it looked like was a truck with one
  // working headlight.
  // shadow is which layer of the spot maps this light's is in, or -1 for
  // none; the CPU writes it into what used to be padding
  cosInner: f32, shadow: f32, _pad1: f32, _pad2: f32,
};
/**
 * The shadow maps' matrices, world to clip. sunParams is the map's texel
 * size, the depth bias, and whether there is a sun map at all; spotParams is
 * the same for the spot layers. Eight spots is the array's size, not a
 * suggestion: the layers are one texture and the layout is fixed.
 */
struct Shadows {
  sun: mat4x4f,
  sunParams: vec4f,
  spots: array<mat4x4f, SPOT_SLOTS>,
  spotParams: vec4f,
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var envSpecular: texture_cube<f32>;
@group(0) @binding(2) var envBrdf: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var<storage, read> points: array<Point>;
@group(0) @binding(5) var<uniform> shadows: Shadows;
@group(0) @binding(6) var sunShadow: texture_depth_2d;
@group(0) @binding(7) var spotShadow: texture_depth_2d_array;
@group(0) @binding(8) var cmp: sampler_comparison;

// How much of a light a surface takes as plain matte light, on top of the
// highlight: the same quarter the point lights have always used, so that the
// sun is the same kind of light they are. It was a highlight only, which is
// why a bright day was a bright overcast one — the ground was lit by the
// environment and the sun only glinted off it.
const DIFFUSE: f32 = 0.25;

// Four compared taps at half-texel offsets, each of which the hardware
// bilinearly compares over four texels: sixteen texels' worth of edge for
// four fetches. Level zero explicitly, because a sample that takes
// derivatives may not be made under a branch and these are all under one.
fn sunLit(uv: vec2f, z: f32) -> f32 {
  let t = shadows.sunParams.x;
  var s = textureSampleCompareLevel(sunShadow, cmp, uv + vec2f(-0.5, -0.5) * t, z);
  s += textureSampleCompareLevel(sunShadow, cmp, uv + vec2f(0.5, -0.5) * t, z);
  s += textureSampleCompareLevel(sunShadow, cmp, uv + vec2f(-0.5, 0.5) * t, z);
  s += textureSampleCompareLevel(sunShadow, cmp, uv + vec2f(0.5, 0.5) * t, z);
  return s * 0.25;
}
fn spotLit(uv: vec2f, layer: i32, z: f32) -> f32 {
  let t = shadows.spotParams.x;
  var s = textureSampleCompareLevel(spotShadow, cmp, uv + vec2f(-0.5, -0.5) * t, layer, z);
  s += textureSampleCompareLevel(spotShadow, cmp, uv + vec2f(0.5, -0.5) * t, layer, z);
  s += textureSampleCompareLevel(spotShadow, cmp, uv + vec2f(-0.5, 0.5) * t, layer, z);
  s += textureSampleCompareLevel(spotShadow, cmp, uv + vec2f(0.5, 0.5) * t, layer, z);
  return s * 0.25;
}

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

  // The sun: one direction, a highlight and a quarter of matte, and a shadow
  // read from one orthographic map fitted round whatever box the game named.
  // The still-life renderer filters thirty-six taps a pixel for its soft
  // shadow; this reads four, compared in hardware, and is sharp.
  let l = normalize(frame.sunDir);
  let ndl = max(dot(n, l), 0.0);
  var lit = 1.0;
  if (SHADOWS && shadows.sunParams.z > 0.5 && ndl > 0.0) {
    let sp = shadows.sun * vec4f(in.world, 1.0);
    let uv = vec2f(sp.x, -sp.y) * 0.5 + 0.5;
    if (all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0)) && sp.z >= 0.0 && sp.z <= 1.0) {
      // more bias the more edge-on the surface is to the light, which is
      // where a map's texel spans the most depth
      let slope = sqrt(max(1.0 - ndl * ndl, 0.0)) / max(ndl, 0.05);
      lit = sunLit(uv, sp.z - shadows.sunParams.y * (1.0 + min(slope, 8.0)));
    }
  }
  let sunSpec = ggx(n, v, l, ndv, a2, k) * fresnel(f0, max(dot(normalize(l + v), v), 0.0));
  var colour = (sunSpec + f0 * DIFFUSE) * frame.sunColour * ndl * lit;

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
      // Two terms, doing two jobs. The first is the window: it takes the
      // light to nothing exactly at its radius, which is what makes the cull
      // exact. The second is the fall itself, half at falloffHalf and inverse
      // square beyond — the radius says how far a light reaches, this says
      // how it spends the way there.
      let reach = clamp(1.0 - d2 / (p.radius * p.radius), 0.0, 1.0);
      let half = max(frame.falloffHalf, 1.0);
      let atten = reach * reach / (1.0 + d2 / (half * half));
      // the cone: pl runs from the surface to the light, so the angle to
      // compare against is the one between the light's own aim and the way
      // back to the surface
      let cone = smoothstep(p.cosOuter, p.cosInner, dot(-pl, p.direction));
      if (cone <= 0.0) { continue; }
      // a spotlight with a map of its own reads it the way the sun does
      var plit = 1.0;
      if (SHADOWS && p.shadow >= 0.0) {
        let layer = i32(p.shadow);
        let sp = shadows.spots[layer] * vec4f(in.world, 1.0);
        if (sp.w > 0.0) {
          let ndc = sp.xyz / sp.w;
          let uv = vec2f(ndc.x, -ndc.y) * 0.5 + 0.5;
          if (all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0)) && ndc.z <= 1.0) {
            let slope = sqrt(max(1.0 - pndl * pndl, 0.0)) / max(pndl, 0.05);
            plit = spotLit(uv, layer, ndc.z - shadows.spotParams.y * (1.0 + min(slope, 8.0)));
          }
        }
      }
      let spec = ggx(n, v, pl, ndv, a2, k) * fresnel(f0, max(dot(normalize(pl + v), v), 0.0));
      colour += (spec + f0 * DIFFUSE) * p.colour * p.intensity * pndl * atten * cone * plit;
    }
  }

  // image based: one prefiltered tap and the split-sum lookup
  let r = reflect(-v, n);
  let pre = textureSampleLevel(envSpecular, samp, r, rough * frame.maxLod).rgb;
  let ab = textureSampleLevel(envBrdf, samp, vec2f(ndv, rough), 0.0).rg;
  colour += pre * (f0 * ab.x + ab.y) * frame.ambient;

  return vec4f(colour * frame.exposure, 1.0);
}
`;

export function sceneSource({ cullLights = true, points = true, shadows = true }: SceneVariant = {}): string {
  return `const CULL_BY_RADIUS: bool = ${cullLights};\nconst POINT_LIGHTS: bool = ${points};\n`
    + `const SHADOWS: bool = ${shadows};\nconst SPOT_SLOTS: u32 = ${SPOT_SHADOWS}u;\n` + SCENE;
}

/**
 * The depth pass a shadow map is rendered with: the same instanced
 * placements, the same vertex layout for position and matrix, and nothing
 * else — no normals, no material, no fragment stage. One matrix in.
 */
export const DEPTH_WGSL = `
@group(0) @binding(0) var<uniform> viewProj: mat4x4f;
@vertex fn vsMain(
  @location(0) position: vec3f,
  @location(4) m0: vec4f, @location(5) m1: vec4f, @location(6) m2: vec4f, @location(7) m3: vec4f,
) -> @builtin(position) vec4f {
  let model = mat4x4f(m0, m1, m2, m3);
  return viewProj * (model * vec4f(position, 1.0));
}
`;

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
/**
 * A global tint over the whole batch, for a ladder that wants to fade them,
 * and the viewport's aspect — a quad square in clip space is an ellipse on a
 * wide screen, and a glow has to be round.
 */
struct Effect { tint: vec3f, aspect: f32 };
/**
 * One layer: where its middle is in clip space, how big, how bright, what
 * colour, and how hard its edge is. Colour is per quad rather than per batch
 * so that a white muzzle flash, a cyan trail and an orange explosion are one
 * draw — the first game built on this needed all three in the same frame.
 */
struct Quad { centre: vec2f, size: f32, brightness: f32, colour: vec3f, sharp: f32 };
@group(0) @binding(0) var<uniform> fx: Effect;
@group(0) @binding(1) var<storage, read> quads: array<Quad>;

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) tint: vec3f,
  @location(2) sharp: f32,
};

@vertex fn vsMain(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> Out {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let q = quads[i];
  let p = corners[v];
  var out: Out;
  out.pos = vec4f(q.centre + p * q.size * vec2f(1.0 / max(fx.aspect, 1e-3), 1.0), 0.0, 1.0);
  out.uv = p;
  out.tint = q.colour * q.brightness;
  out.sharp = max(q.sharp, 0.05);
  return out;
}

@fragment fn fsMain(in: Out) -> @location(0) vec4f {
  // sharp = 1 is the plain fade; higher pulls the light into a hot core
  let a = pow(smoothstep(1.0, 0.0, length(in.uv)), in.sharp);
  let c = fx.tint * in.tint * a;
  return vec4f(c, a);
}
`;

/**
 * The post chain, and the composite that ends it.
 *
 * Three fragment passes over one fullscreen triangle. The bright pass reads
 * the HDR frame at a quarter of its size, keeps what is over a threshold
 * with a soft knee under it, and writes a quarter-size bloom texture; two
 * blur passes take that texture back and forth through a nine-tap Gaussian,
 * once across and once down; and the composite adds the blurred bloom back
 * onto the frame, tonemaps, darkens the corners and adds grain. Quarter
 * size, because bloom is by definition soft and a blur at full size is
 * sixteen times the work for an edge nobody can see.
 *
 * The composite is the same tonemap the renderer always had, with the
 * bloom added before it — so a light that is clipped white in the frame
 * spills a colour, which is what bloom is for — and the vignette and the
 * grain after it, on the displayable value, where they are meant to be
 * seen.
 */
const POST_VERT = `
struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vsMain(@builtin(vertex_index) i: u32) -> VsOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var out: VsOut;
  out.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(p.x, 1.0 - p.y);
  return out;
}
`;

/**
 * The knobs: bloom strength, the luminance it starts at, how soft the start
 * is, how dark the corners go, how much grain, the time the grain rolls on,
 * and the source's texel size for the bright pass to sample around.
 */
const POST_STRUCT = `
struct Post { bloom: f32, threshold: f32, knee: f32, vignette: f32, grain: f32, time: f32, texelX: f32, texelY: f32 };
`;

export const BRIGHT_WGSL = POST_VERT + POST_STRUCT + `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> post: Post;

@fragment fn fsMain(in: VsOut) -> @location(0) vec4f {
  // four bilinear taps a half-texel out from the middle of the quarter-size
  // pixel: a 4x4 box of the source for four fetches
  let t = vec2f(post.texelX, post.texelY);
  var c = textureSample(src, samp, in.uv + vec2f(-1.0, -1.0) * t).rgb;
  c += textureSample(src, samp, in.uv + vec2f(1.0, -1.0) * t).rgb;
  c += textureSample(src, samp, in.uv + vec2f(-1.0, 1.0) * t).rgb;
  c += textureSample(src, samp, in.uv + vec2f(1.0, 1.0) * t).rgb;
  c *= 0.25;
  // a soft knee under the threshold, so a light does not switch on its bloom
  // as it crosses a line
  let lum = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  let knee = max(post.knee, 1e-3);
  let soft = clamp(lum - post.threshold + knee, 0.0, 2.0 * knee);
  let w = max(lum - post.threshold, soft * soft / (4.0 * knee)) / max(lum, 1e-4);
  return vec4f(c * max(w, 0.0), 1.0);
}
`;

/** Direction and texel size: one buffer for across, one for down. */
export const BLUR_WGSL = POST_VERT + `
struct Blur { dir: vec2f, texel: vec2f };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> blur: Blur;

@fragment fn fsMain(in: VsOut) -> @location(0) vec4f {
  // nine taps of a Gaussian with sigma about two texels, bilinear so each
  // tap is really two
  let step = blur.dir * blur.texel;
  var c = textureSample(src, samp, in.uv).rgb * 0.2270;
  let w = array<f32, 4>(0.1945, 0.1216, 0.0541, 0.0162);
  for (var i = 1; i <= 4; i++) {
    let o = step * f32(i) * 1.5;
    c += textureSample(src, samp, in.uv + o).rgb * w[i - 1];
    c += textureSample(src, samp, in.uv - o).rgb * w[i - 1];
  }
  return vec4f(c, 1.0);
}
`;

/** Tonemap one source to the canvas, with the bloom, the vignette and the grain. */
export const COMPOSITE_WGSL = POST_VERT + POST_STRUCT + `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var bloom: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> post: Post;

fn hash(p: vec2f) -> f32 {
  let h = dot(p, vec2f(127.1, 311.7));
  return fract(sin(h) * 43758.5453);
}

@fragment fn fsMain(in: VsOut) -> @location(0) vec4f {
  var c = textureLoad(src, vec2i(in.pos.xy), 0).rgb;
  c += textureSample(bloom, samp, in.uv).rgb * post.bloom;
  var m = c / (c + vec3f(1.0));
  // the corners: the distance from the middle, over the half-diagonal, so a
  // corner is one whatever the frame's shape
  let r = length(in.uv - vec2f(0.5)) / 0.7071;
  m *= 1.0 - post.vignette * smoothstep(0.35, 1.05, r);
  var d = pow(clamp(m, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2));
  // grain, on the displayed value, rolling with the time so it does not sit
  // still on the screen; strongest in the midtones and nothing in the black
  // and the white, like film. Added under the gamma it lifted every black
  // pixel it landed on to a grey, and a night sky was a grey haze.
  let g = hash(in.pos.xy + vec2f(post.time * 60.0, post.time * 37.0)) - 0.5;
  let l = dot(d, vec3f(0.2126, 0.7152, 0.0722));
  d += vec3f(g * post.grain * 4.0 * l * (1.0 - l));
  return vec4f(clamp(d, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;
