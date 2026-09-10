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
export const SPOT_SHADOWS = 16;

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

/**
 * Fog with a volume: the view ray marched, the sun's shadow map sampled at
 * every step, the result written half-size and blended over the frame.
 *
 * The ray is built from the camera's basis so that its view-space z is
 * exactly -1, which makes the march parameter the same view depth the depth
 * buffer holds: a step is a step toward the surface, and where the surface
 * is, the march stops. The start of the march is dithered per pixel and per
 * frame, because twenty-four even steps through a shaft of light is
 * twenty-four visible bands, and the same twenty-four started at a random
 * offset is noise that a half-size texture and a bilinear upsample turn back
 * into smoke.
 *
 * Output is scattered light in rgb and transmittance in alpha, which is
 * exactly what a `one`/`src-alpha` blend wants: the frame is multiplied by
 * what got through and the scattered light is added on top.
 */
export const FOG_WGSL = POST_VERT + `
const CONE_SLOTS: u32 = ${SPOT_SHADOWS}u;
/**
 * How many lamps one ray may carry through its march.
 *
 * The cones are tested once per ray against the whole ray rather than once
 * per step, and only the survivors go into the march: sixteen tests up front
 * instead of sixteen at every one of twenty-eight steps. That is the
 * difference between the cones costing 3.1 ms a frame and costing a quarter
 * of one — the shadow samples were never the expense, the arithmetic of
 * asking sixteen lamps twenty-eight times whether they were near was.
 *
 * Eight of them, and which eight matters. The lamps handed in are the ones
 * nearest the *truck*, which for a ray that passes near the truck is very
 * nearly all of them — so taking the first eight would drop lamps the ray
 * goes straight through in favour of lamps it merely passes. Each is scored
 * by how far into its reach the ray comes, and a better one displaces the
 * worst.
 */
const CONE_LIVE: i32 = 8;
struct Fog {
  sun: mat4x4f,
  camPos: vec3f, near: f32,
  right: vec3f, far: f32,
  up: vec3f, tanHalf: f32,
  back: vec3f, aspect: f32,
  sunDir: vec3f, density: f32,
  sunColour: vec3f, height: f32,
  colour: vec3f, base: f32,
  // shift x and y, steps, anisotropy
  lens: vec4f,
  // reach, ambient, shadow bias, whether there is a sun map
  march: vec4f,
  // time, how many cones, the half distance their fall is measured by, and
  // the spot maps' own bias
  when: vec4f,
  // how much the cones scatter, and the spot maps' texel size
  lamps: vec4f,
};
/**
 * A light that throws a cone through the mist: where it is, which way it
 * points, how wide, what colour, and the map it casts by. Its own shadow
 * matrix travels with it rather than being looked up in the scene's Shadows
 * block, so the fog pass needs one buffer for the lot and knows nothing
 * about how the scene numbers its lights.
 */
struct Cone {
  view: mat4x4f,
  position: vec3f, radius: f32,
  direction: vec3f, cosOuter: f32,
  colour: vec3f, cosInner: f32,
  layer: f32, _p0: f32, _p1: f32, _p2: f32,
};

@group(0) @binding(0) var depthTex: texture_depth_2d;
@group(0) @binding(1) var sunShadow: texture_depth_2d;
@group(0) @binding(2) var cmp: sampler_comparison;
@group(0) @binding(3) var<uniform> fog: Fog;
@group(0) @binding(4) var<uniform> cones: array<Cone, CONE_SLOTS>;
@group(0) @binding(5) var spotShadow: texture_depth_2d_array;

/**
 * Henyey-Greenstein, scaled so that g of zero is exactly one: how much of
 * the light coming from the sun leaves in the direction of the eye. Over
 * zero it peaks looking toward the sun, which is where a mist glows.
 */
fn phase(c: f32, g: f32) -> f32 {
  let g2 = g * g;
  let d = 1.0 + g2 - 2.0 * g * c;
  return (1.0 - g2) / max(pow(max(d, 1e-4), 1.5), 1e-4);
}

/**
 * Where along the reach the fog starts tapering off, as a fraction of it.
 * The last third, which at the arena's nine thousand is three thousand units
 * of gradient — long enough that the eye reads it as the mist thinning with
 * distance rather than as the end of anything.
 */
const REACH_FADE: f32 = 0.66;

/** A hash of the pixel and the frame: the march's starting offset. */
fn dither(p: vec3f) -> f32 {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

@fragment fn fsMain(in: VsOut) -> @location(0) vec4f {
  // this pass is half size; the depth it reads is not
  let dims = vec2i(textureDimensions(depthTex));
  let coord = min(vec2i(in.pos.xy) * 2, dims - vec2i(1));
  let z = textureLoad(depthTex, coord, 0);

  let ndc = vec2f(in.uv.x * 2.0 - 1.0, 1.0 - in.uv.y * 2.0);
  let vx = (ndc.x + 2.0 * fog.lens.x) * fog.tanHalf * fog.aspect;
  let vy = (ndc.y + 2.0 * fog.lens.y) * fog.tanHalf;
  // view-space z of -1, so t is the view depth the buffer above is in
  let ray = fog.right * vx + fog.up * vy - fog.back;
  let span = length(ray);
  let dir = ray / span;

  // the projection in camera.ts, undone; at a cleared depth of one this is
  // the far plane, which is why nothing drawn needs no special case
  let surface = fog.near / max(1.0 + z * (fog.near - fog.far) / fog.far, 1e-6);
  // how far the march would go if nothing stopped it, and where it does stop
  let far = fog.march.x / span;
  let end = min(surface, far);
  let steps = i32(fog.lens.z);
  let dt = end / f32(steps);
  let segment = dt * span;
  let start = dither(vec3f(in.pos.xy, fog.when.x));
  let p = phase(dot(dir, fog.sunDir), fog.lens.w);

  // Which lamps this ray could pass through the light of at all: the
  // closest the ray ever comes to each, against that lamp's reach.
  let count = i32(fog.when.y);
  var near: array<i32, CONE_LIVE>;
  var nearScore: array<f32, CONE_LIVE>;
  var nearCount = 0;
  let endWorld = end * span;
  for (var c = 0; c < count; c++) {
    let w = cones[c].position - fog.camPos;
    let tc = clamp(dot(w, dir), 0.0, endWorld);
    let off = w - dir * tc;
    let d2 = dot(off, off);
    let r2 = cones[c].radius * cones[c].radius;
    if (d2 > r2) { continue; }
    // nought where the ray runs through the lamp, one where it grazes the
    // edge of its reach and the lamp has nothing left to give
    let score = d2 / r2;
    if (nearCount < CONE_LIVE) {
      near[nearCount] = c; nearScore[nearCount] = score; nearCount = nearCount + 1;
    } else {
      var worst = 0;
      var worstScore = nearScore[0];
      for (var j = 1; j < CONE_LIVE; j++) {
        if (nearScore[j] > worstScore) { worstScore = nearScore[j]; worst = j; }
      }
      if (score < worstScore) { near[worst] = c; nearScore[worst] = score; }
    }
  }

  var through = 1.0;
  var scattered = vec3f(0.0);
  for (var i = 0; i < steps; i++) {
    let t = (f32(i) + start) * dt;
    let at = fog.camPos + ray * t;
    // exponential over the height, flat below the base: a layer that lies
    // in the hollows and thins out over the hills
    var density = fog.density * exp(-max(at.z - fog.base, 0.0) / fog.height);
    // A march that runs out of reach rather than running into something has
    // to taper, or the fog stops dead at a fixed distance from the eye —
    // and the set of points a fixed distance from the eye is a sphere,
    // which is an arc ruled across the frame, straight enough over a narrow
    // view to look like somebody drew it. Ramp the density down over the
    // last of the reach. A ray that meets a surface first never gets far
    // enough along to notice, and two neighbouring rays, one stopped by a
    // surface and one not, taper by nearly the same amount — so this softens
    // the end of the march without putting an edge where the two kinds meet.
    density *= 1.0 - smoothstep(REACH_FADE, 1.0, t / far);
    if (density > 1e-9) {
      var lit = 1.0;
      if (fog.march.w > 0.5) {
        let sp = fog.sun * vec4f(at, 1.0);
        let uv = vec2f(sp.x, -sp.y) * 0.5 + 0.5;
        // outside the map is lit: the box the sun map covers is not the world
        if (all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0)) && sp.z >= 0.0 && sp.z <= 1.0) {
          lit = textureSampleCompareLevel(sunShadow, cmp, uv, sp.z - fog.march.z);
        }
      }
      // What the lamps put into the air here. Each is the scene's own fall
      // and cone, so a beam in the mist ends where the beam on the road
      // ends, and each reads its own shadow map, so the cone is cut by
      // whatever stands in it — which is the difference between a light with
      // a shaft and a light with a smudge round it. Only the lamps this ray
      // was found to pass near are in the loop at all.
      var lamps = vec3f(0.0);
      let half = max(fog.when.z, 1.0);
      for (var k = 0; k < nearCount; k++) {
        let L = cones[near[k]];
        let toLight = L.position - at;
        let d2 = dot(toLight, toLight);
        if (d2 > L.radius * L.radius) { continue; }
        let dist = sqrt(max(d2, 1e-8));
        let pl = toLight / dist;
        let cone = smoothstep(L.cosOuter, L.cosInner, dot(-pl, L.direction));
        if (cone <= 0.0) { continue; }
        let window = clamp(1.0 - d2 / (L.radius * L.radius), 0.0, 1.0);
        let atten = window * window / (1.0 + d2 / (half * half));
        var seen = 1.0;
        let sp = L.view * vec4f(at, 1.0);
        if (sp.w > 0.0) {
          let ndc = sp.xyz / sp.w;
          let uv = vec2f(ndc.x, -ndc.y) * 0.5 + 0.5;
          if (all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0)) && ndc.z <= 1.0 && ndc.z >= 0.0) {
            seen = textureSampleCompareLevel(spotShadow, cmp, uv, i32(L.layer), ndc.z - fog.when.w);
          }
        }
        lamps += L.colour * (atten * cone * seen * phase(dot(dir, pl), fog.lens.w));
      }
      let light = fog.colour * (fog.march.y + fog.sunColour * lit * p + lamps * fog.lamps.x);
      let taken = 1.0 - exp(-density * segment);
      scattered += through * taken * light;
      through *= 1.0 - taken;
    }
  }
  return vec4f(scattered, through);
}
`;

/** The half-size fog, read back up to the frame's size and blended over it. */
export const FOG_BLEND_WGSL = POST_VERT + `
@group(0) @binding(0) var fogTex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@fragment fn fsMain(in: VsOut) -> @location(0) vec4f {
  return textureSample(fogTex, samp, in.uv);
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
