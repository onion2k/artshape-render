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

import { SHORE_FIELD_FLOATS, fieldUniform, type ShoreField } from './shore';
import { WAVE_FLOATS, WAVES_WGSL, checkWaves, packWaves, type GerstnerWave } from './waves';

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
  /**
   * With a shore field (`setShoreField`), the foam is a line `foamWidth` wide out from every shore, and a second line
   * `foamWidth2` wide (nought for none) a gap of `foamGap` beyond it, in world units across the water.
   */
  foamGap: number;
  foamWidth2: number;
  /** The long swells that move the surface itself, four at the most (`waves.ts`). None, and the surface lies still. */
  waves: readonly GerstnerWave[];
  /**
   * A colour the water lightens toward by the camera, and over how far from it, in world units: the near water a
   * lighter blue than the far, as a painted lake is. Within that distance the sky's reflection is eased off too, so the
   * water at the player's feet is seen into and not mirrored. Null for none.
   */
  near: Rgb | null;
  nearDistance: number;
  /** A colour the swells' crests lighten toward, and how far at the very top, from nought to one. Null for none. */
  crest: Rgb | null;
  crestAmount: number;
  /**
   * Round soft sparkles where the fine waves catch the glint ahead of the camera, as the glitter does: how many, from nought (none) to one; how nearly a wave has
   * to face the sun to sparkle, from nought to one, the higher the fewer; and how bright each is at its middle, past
   * one so the bloom haloes it; and how big each is, its radius on the screen in pixels. They are drawn as well as
   * `glitter`, which a game asking for them will want at nought.
   */
  sparkles: number;
  sparkleCut: number;
  sparkleBright: number;
  sparkleSize: number;
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
  foamGap: 150,
  foamWidth2: 0,
  waves: [],
  near: null,
  nearDistance: 4000,
  crest: null,
  crestAmount: 0.6,
  sparkles: 0,
  sparkleCut: 0.5,
  sparkleBright: 4,
  sparkleSize: 2.5,
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
  const waves = n.waves ?? d.waves;
  checkWaves(waves);
  return {
    clarity: taken(n.clarity, mm(d.clarity), LEAST),
    refraction: taken(n.refraction, mm(d.refraction)),
    foamWidth: taken(n.foamWidth, mm(d.foamWidth)),
    glitter: taken(n.glitter, d.glitter),
    foam: n.foam ?? d.foam,
    foamEdge: n.foamEdge ?? d.foamEdge,
    caustics: taken(n.caustics, d.caustics),
    causticScale: taken(n.causticScale, mm(d.causticScale), LEAST),
    foamGap: taken(n.foamGap, mm(d.foamGap)),
    foamWidth2: taken(n.foamWidth2, mm(d.foamWidth2)),
    waves,
    near: n.near ?? d.near,
    nearDistance: taken(n.nearDistance, mm(d.nearDistance), LEAST),
    crest: n.crest ?? d.crest,
    crestAmount: Math.min(taken(n.crestAmount, d.crestAmount), 1),
    sparkles: Math.min(taken(n.sparkles, d.sparkles), 1),
    sparkleCut: Math.min(taken(n.sparkleCut, d.sparkleCut), 1),
    sparkleBright: taken(n.sparkleBright, d.sparkleBright),
    sparkleSize: taken(n.sparkleSize, d.sparkleSize, 0.5),
  };
}

/** Writes the settings into `out` as the clear pass reads them, and returns it. */
export function clearUniform(out: Float32Array, w: Omit<ClearWater, 'waves' | 'foamGap' | 'foamWidth2' | keyof ClearFinish>): Float32Array {
  out.set([w.clarity, w.refraction, w.foamWidth, w.glitter, ...w.foam, w.caustics, ...w.foamEdge, w.causticScale]);
  return out;
}

/** The settings that finish the water, packed after its waves: each is off at nought, and its sums are not done. */
type ClearFinish = Pick<ClearWater, 'near' | 'nearDistance' | 'crest' | 'crestAmount' | 'sparkles' | 'sparkleCut' | 'sparkleBright' | 'sparkleSize'>;

/** How many floats the finish is packed into: three vec4s. */
export const CLEAR_FINISH_FLOATS = 12;

/**
 * Writes the finish into `out` as the near colour and its distance, the crest colour and its amount, and the sparkles,
 * their cut and their brightness: a near colour or a crest that is not asked for is written as a distance or an amount
 * of nought, which the pass reads as none. Returns `out`.
 */
export function finishUniform(out: Float32Array, w: ClearFinish): Float32Array {
  out.set([...(w.near ?? [0, 0, 0]), w.near ? w.nearDistance : 0, ...(w.crest ?? [0, 0, 0]), w.crest ? w.crestAmount : 0]);
  out.set([w.sparkles, w.sparkleCut, w.sparkleBright, w.sparkleSize], 8);
  return out;
}

/**
 * How many floats the clear pass's own uniform is: the camera's inverse view and projection, which carries a pixel and
 * its depth back into the world; the frame's size; the settings; the waves; the finish; and where the shore field lies.
 */
export const CLEAR_FRAME_FLOATS = 16 + 4 + CLEAR_STRIDE + WAVE_FLOATS + CLEAR_FINISH_FLOATS + SHORE_FIELD_FLOATS;

/**
 * Writes the clear pass's uniform into `out`: `inverse` (the inverse of the camera's view and projection), the frame's
 * width and height and their reciprocals, the settings, then the waves under `gravity`, in world units a second
 * squared, the finish, and where `field` lies, if there is one. Returns `out`.
 */
export function packClearFrame(
  out: Float32Array,
  inverse: Float32Array,
  width: number,
  height: number,
  w: ClearWater,
  gravity: number,
  field: ShoreField | null = null,
): Float32Array {
  out.set(inverse, 0);
  out.set([width, height, 1 / width, 1 / height], 16);
  clearUniform(out.subarray(20, 20 + CLEAR_STRIDE), w);
  packWaves(out.subarray(20 + CLEAR_STRIDE), w.waves, gravity);
  finishUniform(out.subarray(20 + CLEAR_STRIDE + WAVE_FLOATS), w);
  fieldUniform(out.subarray(20 + CLEAR_STRIDE + WAVE_FLOATS + CLEAR_FINISH_FLOATS), field, w);
  return out;
}

/**
 * What the clear pass's vertex stage gains over the scene's: the surface moved by the waves, and its normal turned by
 * them. With no waves, nothing is changed, to the bit, so a water that asked for none draws as it did before them.
 */
/** What the clear pass's vertex stage hands its fragment stage over the flow's: how high the swells lift it there. */
export const CLEAR_STRUCT_SPLICE = {
  from: '  @location(8) @interpolate(flat) ty: vec3f,\n',
  to: '  @location(8) @interpolate(flat) ty: vec3f,\n  @location(9) swell: f32,\n',
};

export const CLEAR_VERTEX_SPLICES = [
  {
    // the scene's own sums are left as they are and only overridden: written into a var, the compiler fused them
    // otherwise, and a water with no waves drew a bit differently from one before them
    from: '  out.world = world.xyz;\n',
    to: '  out.world = world.xyz;\n  let swell = gerstner(world.xy, frame.spare0);\n  if (swell.any) {\n    let moved = vec4f(world.xyz + swell.moved, 1.0);\n    out.pos = frame.viewProj * moved;\n    out.world = moved.xyz;\n    out.swell = swell.moved.z;\n  }\n',
  },
  {
    from: '  out.normal = (model * vec4f(normal, 0.0)).xyz;\n',
    to: '  out.normal = (model * vec4f(normal, 0.0)).xyz;\n  if (swell.any) { out.normal = swell.normal; }\n',
  },
];

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
  // the waves, two a slot, as packWaves writes them
  waves: array<vec4f, ${WAVE_FLOATS / 4}>,
  // the near colour and how far it reaches, nought for none
  near: vec4f,
  // the crest colour and how much of it, nought for none
  crest: vec4f,
  // how many sparkles, their cut, their brightness and their radius in pixels
  sparkle: vec4f,
  // the shore field's south-west corner, and one over its width and height
  field: vec4f,
  // the gap to the second line of foam and its width, and one where there is a shore field
  lines: vec4f,
};
@group(1) @binding(0) var opaque: texture_2d<f32>;
@group(1) @binding(1) var opaqueDepth: texture_2d<f32>;
@group(1) @binding(2) var<uniform> cw: ClearFrame;
@group(1) @binding(3) var shoreField: texture_2d<f32>;
@group(1) @binding(4) var shoreSampler: sampler;
${WAVES_WGSL}
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
// The foam lines' own noise, with a shore field: cells this many of the line's widths across, so a line breaks every
// few of its own widths as a painted one does, and a finer second layer of this share.
const FOAM_LINE_CELL: f32 = 8.0;
const FOAM_LINE_FINE: f32 = 0.35;
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
// The foam lines, with a shore field: how wide the rim of the edge's colour is beyond the line, as a share of its
// width, and how thin water has to be, as a share of the width, for the foam the depth gives round what the field does
// not know (the bobber, a boat), which is kept away from the shores the field already rings.
const FOAM_RIM: f32 = 0.3;
const FOAM_THIN: f32 = 0.35;
// The crests: where on a swell, from its still height to its top, their colour starts and is at its full.
const CREST_FROM: f32 = 0.4;
const CREST_FULL: f32 = 1.0;
// The sparkles: each is one of a lattice of cells over the fine waves, at least this many of their own cells across, at
// a point jittered inside it; it is drawn as a soft disc on the screen of this radius in pixels, so it is round from any
// angle, a bright core in a soft halo of this share of its brightness. Into the distance, and where the water is seen edge-on, a cell is doubled as often as it takes to stay this
// many sparkles wide on the screen, so it holds its star whole and they thin out as the eye expects. How sharply a wave
// has to mirror the glint, as a power of the dot of its reflection with the glint's way.
const SPARKLE_CELLS: f32 = 1.0;
const SPARKLE_HALO: f32 = 0.3;
const SPARKLE_ROOM: f32 = 7.0;
const SPARKLE_POWER: f32 = 80.0;

// where a pixel of the opaque frame is in the world, from its depth
fn clearWorld(px: vec2f, depth: f32) -> vec3f {
  let ndc = vec2f(px.x * cw.screen.z * 2.0 - 1.0, 1.0 - px.y * cw.screen.w * 2.0);
  let w = cw.inverse * vec4f(ndc, depth, 1.0);
  return w.xyz / w.w;
}

// One lattice's sparkle at this pixel: the point of the pixel's cell, lit where the fine waves there mirror the glint
// ahead of the camera, and a share of the cells by a hash of their own, drawn as a soft disc round that point's place
// on the screen.
fn sparkleStar(in: VsOut, px: vec2f, n0: vec3f, v: vec3f, ahead: vec3f, least: f32, level: f32, fineScale: f32, perPixel: f32) -> f32 {
  let cellW = least * exp2(level);
  let at = floor(in.world.xy / cellW);
  // the level is in the cell's name, so a doubled cell is not lit as the cell it grew from was
  let name = at + vec2f(level * 1013.0);
  let jitter = vec2f(flowHash(name + 3.1), flowHash(name + 7.7)) * 0.4 + 0.3;
  let centre = (at + jitter) * cellW;
  let cs = waterSlope(centre * fineScale, frame.spare0 * in.pattern.z * 1.7, perPixel * fineScale);
  let sn = normalize(n0 + (normalize(in.tx) * -cs.x + normalize(in.ty) * -cs.y) * GLITTER_TILT);
  let gr = reflect(-v, sn);
  let facing = pow(max(dot(vec3f(gr.xy, abs(gr.z)), ahead), 0.0), SPARKLE_POWER);
  let chosen = step(flowHash(name + 11.3), cw.sparkle.x);
  let clip = frame.viewProj * vec4f(centre, in.world.z, 1.0);
  let onScreen = (clip.xy / clip.w * vec2f(0.5, -0.5) + 0.5) * cw.screen.xy;
  let r = length(px - onScreen) / cw.sparkle.w;
  return (exp(-3.0 * r * r) + SPARKLE_HALO * exp(-0.7 * r * r)) * smoothstep(cw.sparkle.y, mix(cw.sparkle.y, 1.0, 0.5), facing) * chosen;
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
  // the water's own colour, lightened toward the near colour by the camera, where a game asks for one
  let away = distance(frame.camPos, in.world);
  let nearness = 1.0 - smoothstep(0.0, cw.near.w, away);
  let body = select(in.second, mix(in.second, cw.near.rgb, nearness), cw.near.w > 0.0);
  let deep = body * lightOn * frame.exposure;
  let share = body / max(max(body.x, body.y), max(body.z, 1.0e-4));
  let lasts = cw.water.x * mix(vec3f(CLEAR_LEAST), vec3f(CLEAR_MOST), share);
  let kept = exp2(-through / lasts);
  var colour = below * kept + deep * (1.0 - kept);

  // the sky in the water, by how edge-on the surface is seen: folded up, since water does not mirror the ground
  let rd = reflect(-v, n);
  let folded = vec3f(rd.xy, abs(rd.z));
  let sky = textureSampleLevel(envSpecular, samp, folded, frame.maxLod * CLEAR_SHARP).rgb * frame.exposure;
  let reflectance = CLEAR_RF0 + (1.0 - CLEAR_RF0) * pow(1.0 - ndv, 5.0);
  // eased off by the camera, where there is a near colour, so the water at the feet is seen into and not mirrored
  let mirror = select(1.0, 1.0 - nearness, cw.near.w > 0.0);
  colour = mix(colour, sky, reflectance * CLEAR_MIRROR * mirror);

  // the crests, lightened by how high the swells lift the surface, as a share of how high they can
  if (cw.crest.w > 0.0) {
    var most = 0.0;
    for (var i = 0u; i < WAVE_SLOTS; i++) { most += cw.waves[i * 2u].w; }
    let top = smoothstep(CREST_FROM, CREST_FULL, in.swell / max(most, 1.0e-5));
    colour = mix(colour, cw.crest.rgb * lightOn * frame.exposure, top * cw.crest.w);
  }

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

  // the sparkles: the nearest cell's point, lit where the fine waves there catch the glint and drawn as a soft round star
  // on the screen, past one so the bloom haloes it; in the sun only, where there are shadows to say where that is
  if (cw.sparkle.x > 0.0) {
    let fineScale = in.pattern.y * GLITTER_FINER;
    let least = SPARKLE_CELLS / max(fineScale, 1.0e-5);
    // the lattice doubled as often as it must be to hold its stars here, and the next one up blended in toward the seam
    // where it takes over, so a star across the seam is drawn whole from the lattice both sides share
    let wanted = log2(SPARKLE_ROOM * cw.sparkle.w * perPixel / least);
    let level = max(0.0, ceil(wanted));
    let up = clamp(wanted - level + 1.0, 0.0, 1.0);
    // the glint's own way, as the glitter's: ahead of the camera and a little over the horizon, so the sparkles are in
    // view wherever the sun is, as a painted lake's are
    let heading = normalize(-v.xy + vec2f(1.0e-5, 0.0));
    let rise = min(v.z + WATER_LIFT, 0.97);
    let ahead = vec3f(heading * sqrt(1.0 - rise * rise), rise);
    let lit = mix(sparkleStar(in, px, n0, v, ahead, least, level, fineScale, perPixel), sparkleStar(in, px, n0, v, ahead, least, level + 1.0, fineScale, perPixel), up);
    var sun = 1.0;
    if (SHADOWS && shadows.sunParams.z > 0.5) {
      let sp = shadows.sun * vec4f(in.world, 1.0);
      let uv = vec2f(sp.x, -sp.y) * 0.5 + 0.5;
      if (all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0)) && sp.z >= 0.0 && sp.z <= 1.0) {
        sun = sunLit(uv, sp.z - shadows.sunParams.y * 2.0);
      }
    }
    let star = lit * sun * step(0.0, frame.sunDir.z);
    colour += frame.sunColour / max(max(frame.sunColour.x, frame.sunColour.y), max(frame.sunColour.z, 1.0e-4)) * star * cw.sparkle.z * frame.exposure;
  }

  // where the water is in the shore field, read here, before any branch, as every sample of a filtered texture must be
  let fieldAt = (in.world.xy - cw.field.xy) * cw.field.zw;
  let shore = textureSampleLevel(shoreField, shoreSampler, fieldAt, 0.0).r;
  let inField = cw.lines.z > 0.0 && all(fieldAt >= vec2f(0.0)) && all(fieldAt <= vec2f(1.0));

  // the foam where the water is thin: a crisp band, its core white and its edge the edge's colour, broken by a noise drifting with the clock
  let width = cw.water.z;
  if (width > 0.0 && inField) {
    // with a shore field, lines of even width round every shore whatever its slope: the line, its rim, a gap and a
    // second line, broken by the same noise; and the band the depth gives, thin, only out where the field rings nothing
    let q = in.world.xy / (width * FOAM_LINE_CELL) + vec2f(frame.spare0 * FOAM_DRIFT, 0.0);
    let noise = flowNoise(q) * (1.0 - FOAM_LINE_FINE) + flowNoise(q * 2.7 + 5.3) * FOAM_LINE_FINE;
    let wobble = (noise - 0.5) * width * FOAM_BREAK;
    let d = shore + wobble;
    // eased over a pixel at the least, so a line is crisp and not jagged
    let soft = max(width * FOAM_SOFT, perPixel * 0.75);
    let line = 1.0 - smoothstep(width - soft, width + soft, d);
    let rimTo = width * (1.0 + FOAM_RIM);
    let rim = 1.0 - smoothstep(rimTo - soft, rimTo + soft, d);
    let from2 = width + cw.lines.x;
    let to2 = from2 + cw.lines.y;
    let second = select(0.0, smoothstep(from2 - soft, from2 + soft, d) * (1.0 - smoothstep(to2 - soft, to2 + soft, d)), cw.lines.y > 0.0);
    let thinW = width * FOAM_THIN;
    let thin = (1.0 - smoothstep(thinW - soft, thinW + soft, stand + wobble * FOAM_THIN)) * step(to2 + width, shore);
    let lit = lightOn * frame.exposure;
    colour = mix(colour, cw.edge.rgb * lit, rim);
    colour = mix(colour, cw.foam.rgb * lit, max(max(line, second), thin));
  } else if (width > 0.0) {
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
