/**
 * Clear water's settings, without its picture: how far a game can see into
 * the water, how much its waves bend what is under it, its foam, its glitter
 * and the caustics on its bed, as one record for the frame (`look.clear`),
 * resolved over the defaults and packed for the clear pass. A game changes it
 * as often as it likes, every frame if it wants to, for the price of a
 * uniform: a lake that clears as it is cured is this record, and not its
 * groups handed over again.
 *
 * The defaults are fixed lengths, so they are kept in millimetres and turned
 * into the world's own units by the renderer's `mmPerUnit`: the same water in
 * a world of millimetres and one of tenths of a metre. A length a game names
 * is already in its own units, and is taken as it is.
 */

type Rgb = [number, number, number];

export interface ClearWater {
  /** How deep the water is, in world units, where half the light through it has been lost to its deep colour. */
  clarity: number;
  /** How far the waves bend what is below, in world units at the bed. Nought bends nothing. */
  refraction: number;
  /** How thin the water is, in world units, where there is foam: at a shore, or over a rock near the surface. */
  foamWidth: number;
  /** How much the sun glitters on the waves, as sharp white dashes. Nought for none. */
  glitter: number;
  /** The foam's colour, and the colour of its edge toward the open water. */
  foam: Rgb;
  foamEdge: Rgb;
  /** How strongly the caustics light what is under shallow water. Nought for none, and none of their sums are done. */
  caustics: number;
  /** How wide a cell of the caustics is, in world units. */
  causticScale: number;
}

/**
 * The defaults, every length in millimetres: the sheet chosen from on 10 October 2026, a pond half a metre deep seen
 * through to its bed and stones, half its light lost by sixteen centimetres down, its stones' edges wobbling by up to
 * ten, a thin crisp line of foam where it is three centimetres deep or less, and caustics in cells fifteen across.
 */
export const CLEAR_DEFAULTS_MM: ClearWater = {
  clarity: 160,
  refraction: 100,
  foamWidth: 30,
  glitter: 1,
  foam: [1, 1, 1],
  foamEdge: [0.55, 0.9, 0.95],
  caustics: 0.6,
  causticScale: 150,
};

/** How many floats the packed settings are: three vec4s. */
export const CLEAR_STRIDE = 12;

/** The least a clarity or a caustic cell may be, in world units: a water of no clarity divides by nought. */
const LEAST = 1e-4;

/** A number a look named, where it is one and at least `least`; the default where it is not a number. */
function taken(named: number | undefined, fallback: number, least = 0): number {
  if (named === undefined || !Number.isFinite(named)) return fallback;
  return Math.max(least, named);
}

/** The settings to draw with: what a look names over the defaults, the defaults' lengths in the world's own units. */
export function resolveClear(named: Partial<ClearWater> | undefined, mmPerUnit: number): ClearWater {
  const d = CLEAR_DEFAULTS_MM;
  const mm = (millimetres: number) => millimetres / mmPerUnit;
  const n = named ?? {};
  return {
    clarity: taken(n.clarity, mm(d.clarity), LEAST),
    refraction: taken(n.refraction, mm(d.refraction)),
    foamWidth: taken(n.foamWidth, mm(d.foamWidth)),
    glitter: taken(n.glitter, d.glitter),
    foam: n.foam ?? d.foam,
    foamEdge: n.foamEdge ?? d.foamEdge,
    caustics: taken(n.caustics, d.caustics),
    causticScale: taken(n.causticScale, mm(d.causticScale), LEAST),
  };
}

/** Writes the settings into `out` as the clear pass reads them, and returns it. */
export function clearUniform(out: Float32Array, w: ClearWater): Float32Array {
  out.set([w.clarity, w.refraction, w.foamWidth, w.glitter, ...w.foam, w.caustics, ...w.foamEdge, w.causticScale]);
  return out;
}

/**
 * How many floats the clear pass's own uniform is: the camera's inverse view and projection, which carries a pixel and
 * its depth back into the world; the frame's size; and the settings.
 */
export const CLEAR_FRAME_FLOATS = 16 + 4 + CLEAR_STRIDE;

/**
 * Writes the clear pass's uniform into `out`: `inverse` (the inverse of the camera's view and projection), the frame's
 * width and height and their reciprocals, then the settings. Returns `out`.
 */
export function packClearFrame(out: Float32Array, inverse: Float32Array, width: number, height: number, w: ClearWater): Float32Array {
  out.set(inverse, 0);
  out.set([width, height, 1 / width, 1 / height], 16);
  clearUniform(out.subarray(20, 20 + CLEAR_STRIDE), w);
  return out;
}

/**
 * The clear pass's fragment stage: the twelve waves of open water turn the surface, what is under it is read back
 * from the opaque frame and its depth, and is lost to the deep colour with the depth of water the eye looks through,
 * with the sky mirrored where the surface is seen edge-on. It is put after the scene shader's head, its vertex
 * stage and the flow's WGSL (`clearSource` in `shaders.ts`), whose `waterSlope` it calls.
 */
export const CLEAR_FRAGMENT = `
struct ClearFrame {
  inverse: mat4x4f,
  // the frame's width and height, and one over each
  screen: vec4f,
  // clarity, refraction, foam width, glitter
  water: vec4f,
  // the foam's colour, and the caustics' strength
  foam: vec4f,
  // the foam's edge, and the caustics' cell
  edge: vec4f,
};
@group(1) @binding(0) var opaque: texture_2d<f32>;
@group(1) @binding(1) var opaqueDepth: texture_2d<f32>;
@group(1) @binding(2) var<uniform> cw: ClearFrame;

// How the light through the water is lost, colour by colour: each channel of the deep colour lasts in proportion to how
// much of it there is, so red goes first and the shallows turn teal of themselves, saturated and not milky, and the deep
// is the deep colour at its richest. The least and the most of the clarity a channel is given.
const CLEAR_LEAST: f32 = 0.35;
const CLEAR_MOST: f32 = 1.6;
// How bright the deep colour and the foam are in the sun and in the light from all round.
const CLEAR_SUN: f32 = 0.18;
const CLEAR_AMBIENT: f32 = 0.75;
// The sky in the water: its reflectance face on, how sharp it is, and how much of it there is at most.
const CLEAR_RF0: f32 = 0.02;
const CLEAR_SHARP: f32 = 0.15;
const CLEAR_MIRROR: f32 = 0.8;
// The foam: how much of its width is its white core (the rest is its edge's colour), how wide its edges are eased,
// as a share of the width, and how far a slow noise breaks it, and how fast that noise drifts, in its cells a second.
const FOAM_CORE: f32 = 0.35;
const FOAM_SOFT: f32 = 0.06;
const FOAM_BREAK: f32 = 1.1;
const FOAM_CELL: f32 = 3.0;
const FOAM_DRIFT: f32 = 0.25;
// The glitter: open water's glint lobe on waves of its own, finer and steeper than the surface's (which are kept gentle
// so the bed reads through them), cut to dashes where it is at least this bright.
const GLITTER_CUT: f32 = 0.6;
const GLITTER_FINER: f32 = 4.5;
const GLITTER_TILT: f32 = 0.7;
// The caustics: how sharp a line of light is (its width, as a share of a cell), how fast the two layers drift, in cells
// a second, how fast they fade with the depth of water over the bed (half by this many clarities), and how much of the
// sun's light they are, at their brightest.
const CAUSTIC_LINE: f32 = 0.16;
const CAUSTIC_DRIFT: f32 = 0.12;
const CAUSTIC_FADE: f32 = 0.6;
const CAUSTIC_SUN: f32 = 0.7;
// How deep what is below is when the refraction's bend is at its full, in world units: less where it is shallower.
const BEND_DEPTH: f32 = 3.0;

// where a pixel of the opaque frame is in the world, from its depth
fn clearWorld(px: vec2f, depth: f32) -> vec3f {
  let ndc = vec2f(px.x * cw.screen.z * 2.0 - 1.0, 1.0 - px.y * cw.screen.w * 2.0);
  let w = cw.inverse * vec4f(ndc, depth, 1.0);
  return w.xyz / w.w;
}

@fragment fn fsMain(in: VsOut) -> @location(0) vec4f {
  let px = in.pos.xy;
  let v = normalize(frame.camPos - in.world);
  // the waves, as open water's: taken ahead of any branch, since a derivative may only be taken where the whole draw goes one way
  let perPixel = length(fwidth(in.world.xy));
  let slope = waterSlope(in.world.xy * in.pattern.y, frame.spare0 * in.pattern.z, perPixel * in.pattern.y);
  let n0 = normalize(in.normal);
  let n = normalize(n0 + (normalize(in.tx) * -slope.x + normalize(in.ty) * -slope.y) * in.pattern.w);
  let ndv = max(dot(n, v), 0.0);

  // what is straight under the water at this pixel, and how deep the water stands over it
  let straight = textureLoad(opaqueDepth, vec2i(px), 0).r;
  let floor0 = clearWorld(px, straight);
  let stand = select(max(in.world.z - floor0.z, 0.0), 1.0e4, straight >= 1.0);
  // what is below, bent by the waves the more the deeper it is; where the bend lands on something out of the water it is not bent
  // the waves' own slope, whatever their steepness, times the refraction, which is how far in the world it moves what is below at the most
  let tilt = (n.xy - n0.xy) / max(in.pattern.w, 0.05);
  let bend = tilt * cw.water.y * min(stand / BEND_DEPTH, 1.0) / max(perPixel, 1.0e-5);
  let moved = clamp(px + bend, vec2f(0.5), cw.screen.xy - vec2f(0.5));
  let movedDepth = textureLoad(opaqueDepth, vec2i(moved), 0).r;
  let under = clearWorld(moved, movedDepth).z < in.world.z;
  let at = select(px, moved, under);
  let depth = select(straight, movedDepth, under);
  // the very texel the depth was read from, not a filtered one: filtered, a bend landing beside something out of the
  // water bled its colour into the water round it
  var below = textureLoad(opaque, vec2i(at), 0).rgb;
  let floor1 = clearWorld(at, depth);
  let through = select(distance(in.world, floor1), 1.0e4, depth >= 1.0);

  // caustics on what is below: two layers of cells drifting against each other, their edges the lines of light, the
  // brighter the shallower and only where the sun reaches it; as light falling on it, so in its own colour
  if (cw.foam.w > 0.0 && depth < 1.0) {
    let cell = floor1.xy / cw.edge.w;
    let drift = frame.spare0 * CAUSTIC_DRIFT;
    let a = flowVoro(cell + vec2f(drift, drift * 0.6));
    let b = flowVoro(cell * 1.3 + vec2f(-drift * 0.8, drift) + 17.0);
    let line = (1.0 - smoothstep(0.0, CAUSTIC_LINE, a.y)) * 0.6 + (1.0 - smoothstep(0.0, CAUSTIC_LINE, b.y)) * 0.4;
    let over = max(in.world.z - floor1.z, 0.0);
    var sun = 1.0;
    if (SHADOWS && shadows.sunParams.z > 0.5) {
      let sp = shadows.sun * vec4f(floor1, 1.0);
      let uv = vec2f(sp.x, -sp.y) * 0.5 + 0.5;
      if (all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0)) && sp.z >= 0.0 && sp.z <= 1.0) {
        sun = sunLit(uv, sp.z - shadows.sunParams.y * 2.0);
      }
    }
    let strength = cw.foam.w * exp2(-over / (cw.water.x * CAUSTIC_FADE)) * sun * max(frame.sunDir.z, 0.0);
    below += below * line * strength * CAUSTIC_SUN * frame.sunColour;
  }

  // the light lost to the deep colour along the way, channel by channel
  let lightOn = frame.ambient * CLEAR_AMBIENT + frame.sunColour * max(dot(n, frame.sunDir), 0.0) * CLEAR_SUN;
  let deep = in.second * lightOn * frame.exposure;
  let share = in.second / max(max(in.second.x, in.second.y), max(in.second.z, 1.0e-4));
  let lasts = cw.water.x * mix(vec3f(CLEAR_LEAST), vec3f(CLEAR_MOST), share);
  let kept = exp2(-through / lasts);
  var colour = below * kept + deep * (1.0 - kept);

  // the sky in the water, by how edge-on the surface is seen: folded up, since water does not mirror the ground
  let rd = reflect(-v, n);
  let folded = vec3f(rd.xy, abs(rd.z));
  let sky = textureSampleLevel(envSpecular, samp, folded, frame.maxLod * CLEAR_SHARP).rgb * frame.exposure;
  let reflectance = CLEAR_RF0 + (1.0 - CLEAR_RF0) * pow(1.0 - ndv, 5.0);
  colour = mix(colour, sky, reflectance * CLEAR_MIRROR);

  // the glitter: open water's glint, the camera's own, cut to sharp dashes
  // its waves are taken here, outside the branch, as every derivative must be
  let fine = waterSlope(in.world.xy * in.pattern.y * GLITTER_FINER, frame.spare0 * in.pattern.z * 1.7, perPixel * in.pattern.y * GLITTER_FINER);
  if (cw.water.w > 0.0) {
    let gn = normalize(n0 + (normalize(in.tx) * -fine.x + normalize(in.ty) * -fine.y) * GLITTER_TILT);
    let gr = reflect(-v, gn);
    let heading = normalize(-v.xy + vec2f(1.0e-5, 0.0));
    let rise = min(v.z + WATER_LIFT, 0.97);
    let ahead = vec3f(heading * sqrt(1.0 - rise * rise), rise);
    let glint = pow(max(dot(vec3f(gr.xy, abs(gr.z)), ahead), 0.0), WATER_SHINY);
    let dash = smoothstep(GLITTER_CUT, GLITTER_CUT * 1.25, glint);
    colour += frame.sunColour / max(max(frame.sunColour.x, frame.sunColour.y), max(frame.sunColour.z, 1.0e-4)) * dash * cw.water.w * frame.exposure;
  }

  // the foam where the water is thin: a crisp band, its core white and its edge the edge's colour, broken by a noise drifting with the clock
  let width = cw.water.z;
  if (width > 0.0) {
    let noise = flowNoise(in.world.xy / (width * FOAM_CELL * 10.0) + vec2f(frame.spare0 * FOAM_DRIFT, 0.0));
    let reach = stand + (noise - 0.5) * width * FOAM_BREAK;
    let soft = width * FOAM_SOFT;
    let edge = 1.0 - smoothstep(width - soft, width + soft, reach);
    let core = 1.0 - smoothstep(width * FOAM_CORE - soft, width * FOAM_CORE + soft, reach);
    let lit = lightOn * frame.exposure;
    colour = mix(colour, cw.edge.rgb * lit, edge);
    colour = mix(colour, cw.foam.rgb * lit, core);
  }
  return vec4f(finite(colour), 1.0);
}
`;

/**
 * The pass before it, which makes the opaque depth readable: a full-screen pass that reads the scene's depth and
 * writes it as a float the clear pass can load, at the same time as the depth the clear pass tests against. At four
 * samples a pixel that is the nearest of the four, as `depthResolveSource` takes it, written into the frame's one
 * sample depth; at one sample the depth is already there, and only the float is written.
 */
export function clearDepthSource(samples: number): string {
  const many = samples > 1;
  return `
struct VsOut { @builtin(position) pos: vec4f };
@vertex fn vsMain(@builtin(vertex_index) i: u32) -> VsOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var out: VsOut;
  out.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  return out;
}
@group(0) @binding(0) var depthTex: ${many ? 'texture_depth_multisampled_2d' : 'texture_depth_2d'};
struct Out { ${many ? '@builtin(frag_depth) depth: f32, ' : ''}@location(0) raw: f32 };
@fragment fn fsMain(in: VsOut) -> Out {
  let at = vec2i(in.pos.xy);
  var nearest = textureLoad(depthTex, at, 0);
  ${many ? `for (var s = 1; s < ${samples}; s++) { nearest = min(nearest, textureLoad(depthTex, at, s)); }` : ''}
  var out: Out;
  ${many ? 'out.depth = nearest;' : ''}
  out.raw = nearest;
  return out;
}
`;
}
