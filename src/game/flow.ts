/**
 * The flow material: a surface that flows (water, lava, ice), drawn with a
 * pattern that travels along the mesh's own +x by `time * speed`, from the
 * game's own clock. Four kinds of pattern, 5 ripple, 6 crust, 7 drift and 8 water,
 * are placements of the pattern kind the scene shader already reads from a
 * placement's eight floats; this file holds what is only theirs: the kinds'
 * numbers, the packing of a placement, whether a group has any, and the WGSL
 * of the flowing build. Without it a game that wants a river has to fake one
 * with a texture it scrolls itself, and one that has no light on it cannot
 * glow.
 *
 * The WGSL is spliced into the scene shader only for the build that is
 * asked for (`SceneVariant.flowing`), so every other build is the text it was
 * before, to the byte, and a game that never asks pays for none of it. The
 * three looks are ported from the mock the game chose them from: water A,
 * lava A and ice A, with the mock's own lighting, its foam at the banks and
 * its camera left out, since a surface's edges are the game's to know. Water
 * (8) is not from a mock: its waves are laid in the world and not on the mesh,
 * so ponds of any shape are one sea, and it lights itself as open water is lit.
 */

/** A rippling surface: a height field travelling along +x, its second colour toward the crests, the normal turned by the slope. */
export const FLOW_RIPPLE = 5;
/** Dark plates drifting over cracks that glow in the second colour, with a slow pulse. */
export const FLOW_CRUST = 6;
/** A scratched, streaked surface, scratches fixed to the mesh, with flecks of the second colour drifting along it and a few glints. */
export const FLOW_DRIFT = 7;
/**
 * Open water, after three.js's water example: twelve sine waves, laid in the world and each travelling its own way at its
 * own pace, turn the normal, and the surface is a deep body colour mixed with the environment's sky mirrored in the waves
 * by a Fresnel term, with a glint where a wave tips the mirror toward the eye. The sky is the environment's, the one mirror
 * there is: no scene is reflected, as three.js's planar mirror reflects one, and the glint is a lobe fixed to the camera
 * and not to the sun, so it is seen whichever way the camera is turned. A placement's `scale` is how many cells of the
 * biggest wave fit in a world unit, `speed` how fast the waves go, `glow` how steeply they tilt the normal (not light
 * given out, as for the other kinds) and `second` the tint of the mirrored sky. There is no occlusion on it.
 */
export const FLOW_WATER = 8;

/**
 * Clear water: open water's twelve waves on a surface that is seen through, drawn in a pass of its own after the opaque
 * scene, which reads what is under it. What is below shows through it, bent by the waves and lost to the deep colour
 * with the water's depth, with foam where it is thin and caustics on what is under the shallows (`clear.ts` holds how
 * much of each, in `look.clear`). A placement's `scale`, `speed` and `glow` are open water's, the first colour is the
 * shallows' and `second` is the deep colour. A group with any placement of it is a clear group: every placement of it
 * is clear water, and it is drawn in no opaque pass, no shadow map and no occlusion.
 */
export const FLOW_CLEAR = 9;
/**
 * A glow: a placement that gives out light of its own, `second` times `glow`, over its own lit colour, everywhere on it
 * and still, whatever light falls on it. A glowing fish under clear water. It is drawn through the flowing build.
 */
export const FLOW_GLOW = 10;

/** Whether a pattern kind is one of the flow kinds: five and up, which is every kind there is (ripple, crust, drift, water, clear water and glow). The old kinds are one to four, and none is nought. */
export function isFlowKind(kind: number): boolean {
  return kind >= 4.5;
}

/** What a game says of a placement that flows. Scale and speed are in the mesh's own units. */
export interface FlowPlacement {
  /** `FLOW_RIPPLE`, `FLOW_CRUST`, `FLOW_DRIFT` or `FLOW_WATER`. */
  kind: number;
  /**
   * How many of the pattern's own cells fit in a unit of the mesh's x and y.
   * One draws the mock's look at a strip some six units across; a mesh in
   * millimetres wants a thousandth of that, and one in tenths of a metre
   * about a tenth, so the same picture lands on the same surface.
   */
  scale: number;
  /** How far along the mesh's own +x the pattern travels in a second of the game's clock, in the mesh's units. Negative runs it back. */
  speed: number;
  /**
   * How much light the surface gives out of itself: the second colour times this times the kind's own field, added whatever
   * light falls on it. Nought, the default, adds nothing. For `FLOW_WATER` it is instead how steeply the waves tilt the
   * normal, since water gives out no light of its own.
   */
  glow?: number;
  /** The colour the pattern mixes in, and glows in; for `FLOW_WATER`, the tint of the sky the waves mirror. */
  second: [number, number, number];
}

/**
 * Writes a flowing placement's eight floats at `offset` in `out`: kind,
 * scale, speed, glow, then the second colour and a spare. For a group's
 * `patterns`, whose stride is `PATTERN_STRIDE`; the caller says where each
 * placement starts. Returns `out`.
 */
export function packFlow(out: Float32Array, offset: number, p: FlowPlacement): Float32Array {
  out[offset] = p.kind;
  out[offset + 1] = p.scale;
  out[offset + 2] = p.speed;
  out[offset + 3] = p.glow ?? 0;
  out[offset + 4] = p.second[0];
  out[offset + 5] = p.second[1];
  out[offset + 6] = p.second[2];
  out[offset + 7] = 0;
  return out;
}

/** Whether any placement of a group's patterns, `stride` floats each, is a flow kind: what makes a group draw through the flowing build. */
export function usesFlow(patterns: Float32Array | undefined, stride: number): boolean {
  if (!patterns) return false;
  for (let i = 0; i + 3 < patterns.length; i += stride) if (isFlowKind(patterns[i])) return true;
  return false;
}

/** Whether any placement of a group's patterns is clear water: what makes a group a clear group, drawn in the clear pass. */
export function usesClear(patterns: Float32Array | undefined, stride: number): boolean {
  if (!patterns) return false;
  for (let i = 0; i + 3 < patterns.length; i += stride) if (Math.abs(patterns[i] - FLOW_CLEAR) < 0.5) return true;
  return false;
}

/** Replaces `from` by `to` in `text`, which must hold it once or the build (named `build`) is wrong: a change to the scene shader must change this too. */
export function spliced(text: string, from: string, to: string, build = 'flowing'): string {
  if (!text.includes(from)) throw new Error(`the ${build} build cannot be made: the scene shader no longer has "${from}"`);
  return text.replace(from, () => to);
}

/** The scene shader's pieces, as the flowing build changes them: each a place where a flow kind is read, and what is put there. */
export const FLOW_SPLICES = {
  /** The fragment stage is handed the mesh's own x and y axes, in the world, flat: what a slope is turned into the normal by. */
  struct: {
    from: '@location(6) @interpolate(flat) second: vec3f,\n',
    to: '@location(6) @interpolate(flat) second: vec3f,\n  @location(7) @interpolate(flat) tx: vec3f,\n  @location(8) @interpolate(flat) ty: vec3f,\n',
  },
  vertex: {
    from: '  out.second = second.rgb;\n',
    to: '  out.second = second.rgb;\n  out.tx = m0.xyz;\n  out.ty = m1.xyz;\n',
  },
  normal: {
    from: '  let n = normalize(in.normal);\n',
    to: '  let flow = flowSurface(in);\n  let n = flow.normal;\n',
  },
  albedo: {
    from: '    f0 = mix(f0, in.second, patternMix(in.local, in.pattern));\n',
    to: '    f0 = mix(f0 * flow.dim, in.second, select(patternMix(in.local, in.pattern), flow.mixing, in.pattern.x > 4.5)) + vec3f(flow.lift);\n',
  },
  glow: {
    from: '  return vec4f(finite(colour * frame.exposure), 1.0);\n',
    to: `  colour += flow.glow;
  if (in.pattern.x > 7.5 && in.pattern.x < 8.5) {
    // open water is the body colour seen through, with the sky mirrored in the waves by how edge-on the surface is
    // the sun's colour with its brightness taken out, so the glint is the sun's hue at a strength of the water's own
    let sunTint = frame.sunColour / max(max(frame.sunColour.x, frame.sunColour.y), max(frame.sunColour.z, 1e-4));
    // a wave that tips the mirror below the horizon would show the sky's ground, which water does not mirror, so it is folded up
    let rd = reflect(-v, n);
    let mirror = min(textureSampleLevel(envSpecular, samp, vec3f(rd.xy, abs(rd.z)), frame.maxLod * WATER_SHARP).rgb, vec3f(WATER_CAP));
    let reflectance = WATER_RF0 + (1.0 - WATER_RF0) * pow(1.0 - ndv, 3.0);
    // the sun's shadow on it, where the look asks: one, and nothing changed, where it does not
    let shaded = select(1.0, lit, shadows.spotSoft.z > 0.5);
    let body = f0 * (sunTint * max(dot(l, n), 0.0) * shaded * WATER_DIFFUSE + WATER_AMBIENT + ndv * 0.5);
    // The glint is the camera's own, so that it is seen however the camera is turned: a lobe of the mirror direction straight
    // ahead along the view and a little higher than a flat sheet would show, which a wave tipped toward the eye reaches and
    // flat water does not.
    let heading = normalize(-v.xy + vec2f(1e-5, 0.0));
    let rise = min(v.z + WATER_LIFT, 0.97);
    let ahead = vec3f(heading * sqrt(1.0 - rise * rise), rise);
    let glint = pow(max(dot(vec3f(rd.xy, abs(rd.z)), ahead), 0.0), WATER_SHINY) * WATER_GLINT * shaded;
    colour = mix(body, vec3f(WATER_FLOOR) + mirror * in.second * WATER_MIRROR + sunTint * glint, reflectance);
    // in a shadow the whole of it is darkened as much as the ground beside it is, so a shadow that falls across a bank
    // onto the water is one shadow; the sun is too small a share of open water's light for its own term to show one
    colour *= 1.0 - WATER_SHADOW * (1.0 - shaded);
  }
  return vec4f(finite(colour * frame.exposure), 1.0);
`,
  },
} as const;

/**
 * The flow kinds' fields, in WGSL: the mock's hash, value noise, fractal
 * noise and cellular distance, and `flowSurface`, which gives a fragment what
 * the kind does to it. Placed before the fragment stage, which calls it with
 * the stage's own input. The clock is the frame uniform's `spare0`, which
 * `GameRenderer.writeFrame` writes from `time` and no other build reads; the
 * pattern's own x is the mesh's local x less the speed times the clock, so a
 * later time is the same picture further along +x and nothing else moves
 * but the crust's pulse, which is the glow's alone.
 */
export const FLOW_WGSL = `
struct FlowSurface {
  // the surface's normal, turned by the field's slope, in the world
  normal: vec3f,
  // how much of the second colour the field mixes in, 0 to 1
  mixing: f32,
  // what the first colour is multiplied by before the mix: the crust's plates and the drift's scratches
  dim: f32,
  // what is added to the colour after it: a glint
  lift: f32,
  // the light the surface gives out of itself, in the second colour
  glow: vec3f,
};

fn flowHash(p0: vec2f) -> f32 {
  var p = fract(p0 * vec2f(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

fn flowNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f0 = fract(p);
  let f = f0 * f0 * (3.0 - 2.0 * f0);
  return mix(mix(flowHash(i), flowHash(i + vec2f(1.0, 0.0)), f.x),
             mix(flowHash(i + vec2f(0.0, 1.0)), flowHash(i + vec2f(1.0, 1.0)), f.x), f.y);
}

fn flowFbm(p0: vec2f) -> f32 {
  var p = p0;
  var a = 0.5;
  var s = 0.0;
  for (var i = 0; i < 4; i++) {
    s += a * flowNoise(p);
    p = p * 2.03 + 17.0;
    a *= 0.5;
  }
  return s;
}

/** The distance to the nearest cell's point, and the gap between it and the second nearest: a crack is where the gap closes. */
fn flowVoro(p: vec2f) -> vec2f {
  let i = floor(p);
  let f = fract(p);
  var d1 = 9.0;
  var d2 = 9.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let g = vec2f(f32(x), f32(y));
      let o = vec2f(flowHash(i + g), flowHash(i + g + 31.7));
      let d = length(g + o - f);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  return vec2f(d1, d2 - d1);
}

/** The ripple's height at q, where q's x has been moved by the clock already. */
fn flowRipple(q: vec2f) -> f32 {
  return flowFbm(vec2f(q.x * 0.55, q.y * 1.1)) + 0.45 * flowFbm(vec2f(q.x * 1.5, q.y * 2.6 + 5.0));
}

// Open water's figures. These are chosen by eye, once, against three.js's water: the mirror's share face-on, how blurred
// the sky in it is (a share of the environment's blurriest level), how bright a spot of the mirror may be (the sun in it is
// a hundred times the sky, and unbounded would bloom into the whole sheet), how much of the sun and the sky the body takes,
// how far above a flat sheet's mirror direction the glint's lobe is aimed, the dark the mirror stands on, how much of the
// tinted sky is seen, and the lobe's tightness and strength.
const WATER_RF0: f32 = 0.35;
const WATER_SHARP: f32 = 0.05;
const WATER_CAP: f32 = 6.0;
const WATER_DIFFUSE: f32 = 0.5;
const WATER_AMBIENT: f32 = 0.35;
const WATER_LIFT: f32 = 0.22;
const WATER_FLOOR: f32 = 0.12;
const WATER_MIRROR: f32 = 1.1;
const WATER_SHINY: f32 = 900.0;
const WATER_GLINT: f32 = 4.0;
// How much darker the whole of open water is in the sun's shadow, when the look asks for it: about as much as a toon
// look's ground goes from its top band to its shade.
const WATER_SHADOW: f32 = 0.2;
// How far the slow swirls bend the sheet, in cells of the biggest wave: enough that the swell's sines do not line up, and
// not so much that it reads as whirlpools.
const WATER_WARP: f32 = 0.45;

/**
 * One wave's slope at p at time t: its direction times the cosine of its phase, which is the slope of a sine's height, so
 * the normal is turned along the wave. A wave fades out where a pixel is wider than a third of its wavelength, so the fine
 * ones go quiet at a distance and do not shimmer.
 */
fn waterWave(p: vec2f, t: f32, dir: vec2f, k: f32, w: f32, phase: f32, weight: f32, pixel: f32) -> vec2f {
  let a = dot(dir * k, p) + t * w + phase;
  return normalize(dir) * cos(a) * weight * (1.0 - smoothstep(0.3, 0.7, pixel * k));
}

/**
 * The slope of the waves at p at time t: twelve sine waves in four groups of three, as three.js sums four normal-map reads
 * (a swell, a chop, a ripple and a fine grain), each wave its own wavenumber, heading and pace, so no one direction shows
 * and the sum, bent by a slow warp, does not repeat within a view. Sines and not value noise, whose slope is nought along every lattice line and
 * shows the grid.
 */
fn waterSlope(p0: vec2f, t: f32, pixel: f32) -> vec2f {
  var s = vec2f(0.0);
  // the sheet is bent by slow swirls before the waves are laid on it, so no crest is the one beside it over again
  let p = p0 + WATER_WARP * vec2f(sin(p0.y * 0.53 + t * 0.21 + 1.0) + sin(p0.y * 1.31 - p0.x * 0.7 + t * 0.13),
                                  sin(p0.x * 0.61 - t * 0.17) + sin(p0.x * 1.17 + p0.y * 0.9 + t * 0.11));
  // swell
  s += waterWave(p, t, vec2f( 0.92,  0.38), 1.9, 0.9, 0.0, 0.18, pixel);
  s += waterWave(p, t, vec2f(-0.31,  0.95), 2.6, 1.1, 1.7, 0.144, pixel);
  s += waterWave(p, t, vec2f( 0.62, -0.78), 3.3, 1.3, 4.1, 0.126, pixel);
  // chop
  s += waterWave(p, t, vec2f(-0.84, -0.54), 5.7, 1.9, 2.3, 0.20, pixel);
  s += waterWave(p, t, vec2f( 0.18,  0.98), 7.1, 2.2, 5.5, 0.17, pixel);
  s += waterWave(p, t, vec2f( 0.97, -0.24), 8.9, 2.6, 0.9, 0.14, pixel);
  // ripple
  s += waterWave(p, t, vec2f(-0.57,  0.82), 13.3, 3.4, 3.3, 0.11, pixel);
  s += waterWave(p, t, vec2f( 0.76,  0.65), 17.9, 3.9, 6.0, 0.09, pixel);
  s += waterWave(p, t, vec2f(-0.99, -0.14), 23.1, 4.5, 1.2, 0.07, pixel);
  // grain, so the glints are many and small, not a few soft lumps
  s += waterWave(p, t, vec2f( 0.44, -0.90), 31.7, 5.3, 2.9, 0.06, pixel);
  s += waterWave(p, t, vec2f(-0.71,  0.70), 43.3, 6.2, 5.1, 0.05, pixel);
  s += waterWave(p, t, vec2f( 0.89,  0.46), 59.9, 7.1, 0.4, 0.04, pixel);
  return s;
}

fn flowSurface(in: VsOut) -> FlowSurface {
  var s: FlowSurface;
  let n0 = normalize(in.normal);
  s.normal = n0;
  s.mixing = 0.0;
  s.dim = 1.0;
  s.lift = 0.0;
  s.glow = vec3f(0.0);
  let kind = in.pattern.x;
  // The pixel's width in wave cells quiets the waves finer than a pixel can show. It is taken here, ahead of every branch,
  // since a derivative may only be taken where the whole draw goes the same way, which a branch on the kind is not.
  let pixel = length(fwidth(in.world.xy)) * in.pattern.y;
  if (kind > 7.5 && kind < 8.5) {
    // open water: the waves turn the normal in the world, so a pool of any shape is one water
    let slope = waterSlope(in.world.xy * in.pattern.y, frame.spare0 * in.pattern.z, pixel);
    s.normal = normalize(n0 + (normalize(in.tx) * -slope.x + normalize(in.ty) * -slope.y) * in.pattern.w);
    return s;
  }
  if (kind > 9.5 && kind < 10.5) {
    // a glow: its light everywhere on it, still, and nothing else changed
    s.glow = in.second * in.pattern.w;
    return s;
  }
  if (kind < 4.5 || kind > 7.5) { return s; }
  let scale = in.pattern.y;
  let clock = frame.spare0;
  // the pattern's own x runs back with the clock, so the picture runs along +x
  let q = vec2f(in.local.x - clock * in.pattern.z, in.local.y) * scale;
  // the surface's own axes in the world, which a slope in the pattern's is turned into
  let tx = normalize(in.tx);
  let ty = normalize(in.ty);
  var tilt = vec2f(0.0);
  var field = 0.0;
  if (kind < 5.5) {
    // ripple, from the mock's water A: the second colour toward the crests, and the slope turning the normal
    let e = 0.08;
    let h = flowRipple(q);
    tilt = -vec2f(flowRipple(q + vec2f(e, 0.0)) - h, flowRipple(q + vec2f(0.0, e)) - h) / e * 0.55;
    s.mixing = smoothstep(0.35, 0.95, h);
    field = s.mixing;
  } else if (kind < 6.5) {
    // crust, from lava A: plates over cracks, the cracks in the second colour and glowing
    var c = q * 0.42;
    c += 0.25 * vec2f(flowFbm(c * 1.3), flowFbm(c * 1.3 + 9.0));
    let w = flowVoro(c);
    let crack = 1.0 - smoothstep(0.0, 0.16, w.y);
    let plate = flowFbm(c * 4.0);
    s.dim = 0.6 + 0.8 * plate;
    s.mixing = crack;
    tilt = vec2f(plate - 0.5, flowFbm(c * 4.0 + 3.0) - 0.5) * 0.5;
    // the slow pulse is the game's own clock and moves nothing along
    let pulse = 0.75 + 0.25 * sin(clock * 1.7 + w.x * 9.0);
    field = (crack * crack + 0.09 * (1.0 - smoothstep(0.0, 0.5, w.y))) * pulse;
  } else {
    // drift, from ice A: scratches fixed to the mesh along x, flecks drifting along them, a few glints
    let scratch = flowNoise(vec2f(in.local.x * scale * 0.12, q.y * 7.0));
    let fleck = smoothstep(0.6, 0.85, flowNoise(vec2f(q.x * 0.45, q.y * 1.4 + 0.6 * flowFbm(vec2f(q.x * 0.2, q.y * 0.3333)))));
    s.dim = 0.8 + 0.45 * scratch;
    s.mixing = fleck * 0.75;
    s.lift = 0.5 * step(0.986, flowHash(floor(vec2f(in.local.x * scale, q.y) * 5.0)));
    tilt = vec2f((scratch - 0.5) * 0.12, (scratch - 0.5) * 0.4);
    field = fleck;
  }
  s.normal = normalize(n0 + tx * tilt.x + ty * tilt.y);
  s.glow = in.second * in.pattern.w * field;
  return s;
}

`;
