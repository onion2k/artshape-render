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
  /**
   * A colour the reflected sky is multiplied by, so a painted lake's highlights are a colour of its own and not the
   * sky's pale blue. Null for none, and the sky is mirrored as it is.
   */
  mirrorTint: Rgb | null;
  /**
   * The share of the mirror the camera keeps where there is a near colour, from nought to one: nought eases it to
   * nothing by the camera, so the water at the feet is seen into, and one keeps all of it, so the ripples there still
   * catch the sky.
   */
  mirrorNear: number;
  /** How strong the mirror is, as a multiple of what it was before this option: one for the same, nought for none. */
  mirror: number;
  /**
   * Whether the water mirrors the scene as well as the sky. True has `GameRenderer` draw the opaque groups once more
   * before the scene pass, with the view turned over in `mirrorPlane` and everything under that plane clipped away, into
   * a half-size frame of its own, and the water shows that where something was drawn and the sky where nothing was. The
   * shadow maps, the grass, the cards' extra pass, the particles and the clear water itself are not drawn again for it.
   * False draws no such pass and makes no such frame, and the water is what it was.
   */
  mirrorScene: boolean;
  /** The height of the water's surface, in world units, which the scene is mirrored in and clipped at. Moot while `mirrorScene` is false. */
  mirrorPlane: number;
  /**
   * How far the swells' own normal shifts the mirrored scene, as a share of the screen for a normal tilted all the way
   * over: nought lies it still. It is the swells' (the Gerstner sum's) and not the fine waves', which fade out with
   * distance where the mirror shows things. Moot while `mirrorScene` is false.
   */
  mirrorDistort: number;
  /**
   * A colour the body lightens toward on the fine waves' slopes, so a painted lake's streaks of lighter blue are
   * painted into the water and are not the sky's, which a dark `mirrorTint` takes away. Null for none, and nothing is
   * added. The slope is the fine waves' own, `length(slope) / 0.6` held to one: at that, or past it, the wave is on a
   * full slope (the sum of the twelve waves is 0.31 rms, 1.38 at the very most, so a full slope is a steep crest's
   * side and most of the water is under half). It does not depend on the water's steepness, which only tilts the
   * normal: `rippleCut` means the same share of a full slope whatever a game turns that to. Distance quiets the
   * ripples as it does the glitter, so the far water is not streaked.
   */
  ripple: Rgb | null;
  /** How far the body lightens toward `ripple` at a full slope, from nought to one. Moot while `ripple` is null. */
  rippleAmount: number;
  /**
   * The share of a full slope below which nothing lightens, from nought to one, eased in over the rest, so only the
   * crests' sides catch it: nought lightens by every slope, one by none.
   */
  rippleCut: number;
  /**
   * How soft the foam line's edge is, as a share of its width, from nought up; the default is as the lines were drawn
   * before this option. Lower is crisper, a bold ink-line. It softens the edges of the shore field's lines and of the
   * depth band that stands in for them, and never below three quarters of a pixel, so a line is not aliased whatever
   * this is. It does not reach the plain band drawn where there is no shore field.
   */
  foamSoft: number;
  /**
   * Whether inside the shore field the depth band is drawn at its full width too, so that a thing standing in the water
   * (a bobber, a boat, a crate, a rock near the surface) has a ring of foam where the water is thin over it, as the
   * shore has. False draws only the field's lines there, and a thin band where the field rings nothing, as before.
   * The band is the water over whatever is under it being thinner than `foamWidth`, so a thing wholly under the
   * surface but nearer it than that rings too (a fish at that depth, say): a game that wants that sets `foamWidth` small. Where
   * the field's own lines are, the band is left out, so a shore is not doubled and its line keeps its even width.
   */
  foamEverywhere: boolean;
  /**
   * How deep a path through the water is, in world units, before anything along it is lost to the deep colour: the
   * light is taken over the path less this, so what lies under thin water is seen in its own colour, and the deep is
   * reached as before only a knee further down. The caustics fade by the same knee, so they stay at their brightest
   * over that depth of bed. Nought, the default, loses light from the surface down as before. It is the bright bed of
   * a pale shallow; over a dark one it lets more of the dark through, and the shallows darken.
   */
  clearKnee: number;
  /**
   * How wide a caustic line is, as a share of a cell: lower is a crisper, finer line, which covers less of the bed and
   * so wants `caustics` raised to be seen (the sheets of October 2026 chose 0.08 at about three times the strength). The
   * default, 0.16, is the line as it was drawn before this option. A line much under 0.08 breaks into stair-stepped
   * dashes into the distance, since it does not widen with the pixel's footprint.
   */
  causticLine: number;
  /**
   * The detail layer's cell, in pixels on the screen: the fine waves read once more at a scale chosen pixel by pixel,
   * so their finest wave is this many pixels across near and far, and never fades out with the distance as the twelve
   * do. Its slope is added to the normal (and so to the bend, the light and the sky's reflection) and to the mirrored
   * scene's read, and never to the height, so what floats is not moved. Nought, the default, is none, and none of its
   * sums are done. It is pixels and not a length, so no unit turns it; a cell under a pixel is held at one, since a
   * finer one would only alias. The films of October 2026 chose eight: four reads as grain and sixteen hardly shows.
   */
  detailPixels: number;
  /**
   * How much of the layer's slope is added, as a share of the water's own steepness: one (the default, and the
   * films' choice) adds it at the steepness the fine waves have, 0.6 is the cautious choice if that reads busy, and
   * nought adds none. Moot while `detailPixels` is nought.
   */
  detailAmount: number;
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
  mirrorTint: null,
  mirrorNear: 0,
  mirror: 1,
  mirrorScene: false,
  mirrorPlane: 0,
  mirrorDistort: 0.03,
  ripple: null,
  rippleAmount: 0.5,
  rippleCut: 0.3,
  foamSoft: 0.06,
  foamEverywhere: false,
  clearKnee: 0,
  causticLine: 0.16,
  detailPixels: 0,
  detailAmount: 1,
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
    mirrorTint: n.mirrorTint ?? d.mirrorTint,
    mirrorNear: Math.min(taken(n.mirrorNear, d.mirrorNear), 1),
    mirror: taken(n.mirror, d.mirror),
    mirrorScene: n.mirrorScene === true,
    mirrorPlane: taken(n.mirrorPlane, d.mirrorPlane, -Infinity),
    mirrorDistort: taken(n.mirrorDistort, d.mirrorDistort),
    ripple: n.ripple ?? d.ripple,
    rippleAmount: Math.min(taken(n.rippleAmount, d.rippleAmount), 1),
    rippleCut: Math.min(taken(n.rippleCut, d.rippleCut), 1),
    foamSoft: taken(n.foamSoft, d.foamSoft),
    foamEverywhere: n.foamEverywhere ?? d.foamEverywhere,
    clearKnee: taken(n.clearKnee, mm(d.clearKnee)),
    causticLine: taken(n.causticLine, d.causticLine, LEAST),
    detailPixels: detailCell(taken(n.detailPixels, d.detailPixels)),
    detailAmount: taken(n.detailAmount, d.detailAmount),
  };
}

/** A detail cell as it can be drawn: nought or less is none, and anything over nought is a pixel at the least. */
function detailCell(pixels: number): number {
  return pixels > 0 ? Math.max(pixels, 1) : 0;
}

/** Writes the settings into `out` as the clear pass reads them, and returns it. */
export function clearUniform(out: Float32Array, w: Omit<ClearWater, 'waves' | 'foamGap' | 'foamWidth2' | keyof ClearFinish | keyof ClearMirror | 'mirrorPlane' | keyof ClearRipple | keyof ClearFoam>): Float32Array {
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

/** The settings of the sky's reflection in the water, packed last in the frame. */
type ClearMirror = Pick<ClearWater, 'mirrorTint' | 'mirrorNear' | 'mirror' | 'mirrorScene' | 'mirrorDistort'>;

/** How many floats the mirror is packed into: two vec4s. */
export const CLEAR_MIRROR_FLOATS = 8;

/**
 * Writes the mirror into `out` as the tint with a one where there is one (a tint of nought and a flag of nought are
 * none, so the sky is not multiplied at all), then the strength and the share the camera keeps, then the swells'
 * distortion and a one where the scene is mirrored too. A water that does not mirror the scene writes the last two as
 * nought whatever the distortion says, so it is packed word for word as it was. Returns `out`.
 */
export function mirrorUniform(out: Float32Array, w: ClearMirror): Float32Array {
  out.set([...(w.mirrorTint ?? [0, 0, 0]), w.mirrorTint ? 1 : 0, w.mirror, w.mirrorNear, w.mirrorScene ? w.mirrorDistort : 0, w.mirrorScene ? 1 : 0]);
  return out;
}

/** The settings of the ripples' lightening, and the detail layer in the two words they leave free, packed after the mirror. */
type ClearRipple = Pick<ClearWater, 'ripple' | 'rippleAmount' | 'rippleCut' | 'detailPixels' | 'detailAmount'>;

/** How many floats the ripples are packed into: two vec4s. */
export const CLEAR_RIPPLE_FLOATS = 8;

/**
 * Writes the ripples into `out` as the colour with a one where there is one (a flag of nought is none, so nothing is
 * mixed at all), then the amount and the cut, then the detail layer's cell and amount. The layer is written only when
 * it is asked for, a cell and an amount both over nought; otherwise both words are the noughts they were before it,
 * which the pass reads as none, so a water that names neither is packed word for word as it was. Returns `out`.
 */
export function rippleUniform(out: Float32Array, w: ClearRipple): Float32Array {
  const detail = w.detailPixels > 0 && w.detailAmount > 0;
  out.set([...(w.ripple ?? [0, 0, 0]), w.ripple ? 1 : 0, w.rippleAmount, w.rippleCut, detail ? w.detailPixels : 0, detail ? w.detailAmount : 0]);
  return out;
}

/**
 * Where the twelve fine waves' own fade begins, in waves a pixel: `waterWave` in `flow.ts` eases a wave out from 0.3 to
 * 0.7 of a wave across a pixel, so a wave is gone before it can alias. The detail layer moves that fade down by a cell,
 * so its finest kept wave is a cell across and not some nine to twenty pixels, which is what made the layer as first
 * specified show nothing. Said here and in `flow.ts`'s WGSL, and held equal by a test.
 */
export const WAVE_FADE_FROM = 0.3;

/** The settings of the foam's edge and reach, and the shallows' knee and caustic line, packed after the ripples. */
type ClearFoam = Pick<ClearWater, 'foamSoft' | 'foamEverywhere' | 'clearKnee' | 'causticLine'>;

/** How many floats the foam's options are packed into: one vec4. */
export const CLEAR_FOAM_FLOATS = 4;

/**
 * Writes the foam's edge softness, a one where the depth band is drawn everywhere, the shallows' knee and the caustic
 * line into `out`, and returns it. The line at its default is written as nought, which the pass reads as its own
 * constant, so a water that names neither the knee nor the line is packed word for word as it was before them.
 */
export function foamUniform(out: Float32Array, w: ClearFoam): Float32Array {
  out.set([w.foamSoft, w.foamEverywhere ? 1 : 0, w.clearKnee, w.causticLine === CLEAR_DEFAULTS_MM.causticLine ? 0 : w.causticLine]);
  return out;
}

/**
 * How many floats the clear pass's own uniform is: the camera's inverse view and projection, which carries a pixel and
 * its depth back into the world; the frame's size; the settings; the waves; the finish; where the shore field lies; the mirror; the ripples; and the foam's options.
 */
export const CLEAR_FRAME_FLOATS = 16 + 4 + CLEAR_STRIDE + WAVE_FLOATS + CLEAR_FINISH_FLOATS + SHORE_FIELD_FLOATS + CLEAR_MIRROR_FLOATS + CLEAR_RIPPLE_FLOATS + CLEAR_FOAM_FLOATS;

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
  fieldUniform(out.subarray(20 + CLEAR_STRIDE + WAVE_FLOATS + CLEAR_FINISH_FLOATS, CLEAR_FRAME_FLOATS - CLEAR_FOAM_FLOATS - CLEAR_RIPPLE_FLOATS - CLEAR_MIRROR_FLOATS), field, w);
  mirrorUniform(out.subarray(CLEAR_FRAME_FLOATS - CLEAR_FOAM_FLOATS - CLEAR_RIPPLE_FLOATS - CLEAR_MIRROR_FLOATS, CLEAR_FRAME_FLOATS - CLEAR_FOAM_FLOATS - CLEAR_RIPPLE_FLOATS), w);
  rippleUniform(out.subarray(CLEAR_FRAME_FLOATS - CLEAR_FOAM_FLOATS - CLEAR_RIPPLE_FLOATS, CLEAR_FRAME_FLOATS - CLEAR_FOAM_FLOATS), w);
  foamUniform(out.subarray(CLEAR_FRAME_FLOATS - CLEAR_FOAM_FLOATS), w);
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
  // the sky's tint and a one where there is one; then the mirror's strength and the share of it the camera keeps, the
  // swells' distortion of the scene in it and a one where the scene is mirrored too
  tint: vec4f,
  mirror: vec4f,
  // the ripples' colour and a one where there is one; then the amount and the cut, then the detail layer's cell in pixels
  // and its amount, both nought for none
  ripple: vec4f,
  ripples: vec4f,
  // the foam line's edge softness as a share of its width, and a one where the depth band is drawn in the field too; then
  // the depth of path through which nothing is lost, and the caustic line's width as a share of a cell, nought for CAUSTIC_LINE
  foamOpt: vec4f,
};
@group(1) @binding(0) var opaque: texture_2d<f32>;
@group(1) @binding(1) var opaqueDepth: texture_2d<f32>;
@group(1) @binding(2) var<uniform> cw: ClearFrame;
@group(1) @binding(3) var shoreField: texture_2d<f32>;
@group(1) @binding(4) var shoreSampler: sampler;
// the scene as the water mirrors it, at half the frame: its colour premultiplied by where something was drawn, which is
// its alpha, since it is cleared to nought and written at one; a texel of nothing while the scene is not mirrored
@group(1) @binding(5) var sceneMirror: texture_2d<f32>;
@group(1) @binding(6) var sceneMirrorSampler: sampler;
// the mirror's depth, cleared to one where nothing was drawn; a texel of nought while the scene is not mirrored, which
// the shader never reads then
@group(1) @binding(7) var sceneMirrorDepth: texture_depth_2d;
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
// The fine waves' slope that is a full one, for lightening the body on the ripples (see ClearWater.ripple).
const RIPPLE_FULL: f32 = 0.6;
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
const CAUSTIC_LINE: f32 = ${CLEAR_DEFAULTS_MM.causticLine};
const CAUSTIC_DRIFT: f32 = 0.12;
const CAUSTIC_FADE: f32 = 0.6;
const CAUSTIC_SUN: f32 = 0.7;
// How deep what is below is when the refraction's bend is at its full, in world units: less where it is shallower.
const BEND_DEPTH: f32 = 3.0;
// The detail layer: its fade, a share of the cell, so its finest kept wave is a cell across (see WAVE_FADE_FROM); how far
// apart its levels are laid, in the waves' own units, so one level's crests do not line up with the next's; and the
// widest a pixel's footprint is taken to be, in world units, so a ray all but along the water does not overflow.
const DETAIL_FADE: f32 = ${WAVE_FADE_FROM / (2 * Math.PI)};
const DETAIL_APART: f32 = 37.0;
const DETAIL_WIDEST: f32 = 1.0e6;
// The least share of the depth the fine waves' own bend shows that the layer's bend may land at, under the surface, and
// of the distance from the water of what their mirror shows that the layer's mirror may show; and how near the water,
// as a share of the camera's distance, a thing must be for the layer's mirror to be kept off it.
const DETAIL_LANDING: f32 = 0.5;
const DETAIL_NEAR: f32 = 0.1;
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

// Where the ray through a point of the screen meets the still water's plane at the height h. The camera's own
// position and the inverse of its view and projection give the ray, so the point comes from the lens alone.
fn clearOnPlane(px: vec2f, h: f32) -> vec2f {
  let d = clearWorld(px, 0.0) - frame.camPos;
  let dz = select(d.z, select(-1.0e-6, 1.0e-6, d.z >= 0.0), abs(d.z) < 1.0e-6);
  return frame.camPos.xy + d.xy * abs((h - frame.camPos.z) / dz);
}

// How wide the pixel at px is on the still water's plane at the height h, in world units, as length(fwidth(world.xy))
// measures it on a flat plane: from where the rays through its edges meet the plane. It is worked out from the lens and
// the pixel's place, and not from the triangle being drawn, so it is the same either side of a triangle's edge however
// far the swells have moved and tilted the triangles; fwidth over the moved surface jumps there.
fn clearFootprint(px: vec2f, h: f32) -> f32 {
  let across = clearOnPlane(px + vec2f(0.5, 0.0), h) - clearOnPlane(px - vec2f(0.5, 0.0), h);
  let down = clearOnPlane(px + vec2f(0.0, 0.5), h) - clearOnPlane(px - vec2f(0.0, 0.5), h);
  return min(length(abs(across) + abs(down)), DETAIL_WIDEST);
}

// The detail layer's slope at this pixel: the fine waves read at the scale that makes their cell cw.ripples.z pixels
// across here, the two nearest powers of two of the waves' own unit blended by where the wanted scale lies between
// them, as the sparkles' lattice is, so each level is fixed in the world and the scale is continuous as the camera
// moves. The blend is divided by its own length, so two unrelated slopes mixed half and half are as rough as either
// and the layer shows no band midway between levels. The scale is taken from the still surface under the pixel, before
// the swells move it.
fn clearDetail(in: VsOut, px: vec2f) -> vec2f {
  let cells = cw.ripples.z;
  let foot = clearFootprint(px, in.world.z - in.swell);
  let wanted = log2(max(cells * foot * in.pattern.y, 1.0e-30));
  let level = floor(wanted);
  let up = wanted - level;
  let cellA = exp2(level) / in.pattern.y;
  let cellB = cellA * 2.0;
  let t = frame.spare0 * in.pattern.z;
  let sa = waterSlope(in.world.xy / cellA + vec2f(level * DETAIL_APART), t, foot / cellA * cells * DETAIL_FADE);
  let sb = waterSlope(in.world.xy / cellB + vec2f((level + 1.0) * DETAIL_APART), t, foot / cellB * cells * DETAIL_FADE);
  return (sa * (1.0 - up) + sb * up) / sqrt((1.0 - up) * (1.0 - up) + up * up);
}

// How far from the water point at what the mirrored scene shows at uv is, in world units, as far as can be where
// nothing was drawn. The mirror's frame is the camera's view turned over in the water's plane, so the point its depth
// gives through the camera's own inverse is the thing's image under the plane, as far from a point on the plane as the
// thing is.
fn clearMirrored(uv: vec2f, at: vec3f) -> f32 {
  let size = vec2f(textureDimensions(sceneMirrorDepth));
  let d = textureLoad(sceneMirrorDepth, vec2i(clamp(uv * size, vec2f(0.0), size - 1.0)), 0);
  return select(distance(clearWorld(uv * cw.screen.xy, d), at), 1.0e30, d >= 1.0);
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
  let np = normalize(n0 + (normalize(in.tx) * -slope.x + normalize(in.ty) * -slope.y) * in.pattern.w);
  // the detail layer, where it is asked for: its slope added to the normal, and so to the bend and the light, and to the
  // mirrored scene's read through nm; never to the height, so what floats is not moved. np is the normal without it
  var n = np;
  var nm = n0;
  if (cw.ripples.z > 0.0) {
    let d = clearDetail(in, px);
    let dn = (normalize(in.tx) * -d.x + normalize(in.ty) * -d.y) * in.pattern.w * cw.ripples.w;
    n = normalize(n0 + (normalize(in.tx) * -slope.x + normalize(in.ty) * -slope.y) * in.pattern.w + dn);
    nm = normalize(n0 + dn);
  }
  let ndv = max(dot(n, v), 0.0);

  // what is straight under the water at this pixel, and how deep the water stands over it
  let straight = textureLoad(opaqueDepth, vec2i(px), 0).r;
  let floor0 = clearWorld(px, straight);
  let stand = select(max(in.world.z - floor0.z, 0.0), 1.0e4, straight >= 1.0);
  // what is below, bent by the waves the more the deeper it is; where the bend lands on something out of the water it is not bent
  // the waves' own slope, whatever their steepness, times the refraction, which is how far in the world it moves what is below at the most
  let tilt = (n.xy - n0.xy) / max(in.pattern.w, 0.05);
  let bend = tilt * cw.water.y * min(stand / BEND_DEPTH, 1.0) / max(perPixel, 1.0e-5);
  var moved = clamp(px + bend, vec2f(0.5), cw.screen.xy - vec2f(0.5));
  var movedDepth = textureLoad(opaqueDepth, vec2i(moved), 0).r;
  // the detail layer's bend, kept only where it lands at least DETAIL_LANDING as deep under the surface as what the fine
  // waves' own bend shows there: their landing where it is under the water, and what is straight under where it is not.
  // The bend is sized by the water standing straight under the pixel, and a ray cannot be bent that far onto something
  // just under the surface; the layer's fine, steep tilt sent scattered pixels beside a post or a bobber onto its side
  // there, and the water showed flecks and smears of its colour. A landing that deep has lost most of its colour to the
  // water anyway. Short of it, the fine waves' landing is taken whole: shortening the layer's bend instead still crossed
  // a thin thing's last pixel onto it
  if (cw.ripples.z > 0.0) {
    let tilt0 = (np.xy - n0.xy) / max(in.pattern.w, 0.05);
    let at0 = clamp(px + tilt0 * cw.water.y * min(stand / BEND_DEPTH, 1.0) / max(perPixel, 1.0e-5), vec2f(0.5), cw.screen.xy - vec2f(0.5));
    let depth0 = textureLoad(opaqueDepth, vec2i(at0), 0).r;
    let deep0 = in.world.z - clearWorld(at0, depth0).z;
    let shown = select(stand, deep0, deep0 > 0.0);
    if (in.world.z - clearWorld(moved, movedDepth).z < shown * DETAIL_LANDING) {
      moved = at0;
      movedDepth = depth0;
    }
  }
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
    let lineW = select(cw.foamOpt.w, CAUSTIC_LINE, cw.foamOpt.w <= 0.0);
    let line = (1.0 - smoothstep(0.0, lineW, a.y)) * 0.6 + (1.0 - smoothstep(0.0, lineW, b.y)) * 0.4;
    // the depth over the bed less the knee, so they fade only below it
    let over = max(in.world.z - floor1.z - cw.foamOpt.z, 0.0);
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
  // nothing is lost in the first knee of the path, and from there on as before
  let kept = exp2(-max(through - cw.foamOpt.z, 0.0) / lasts);
  var colour = below * kept + deep * (1.0 - kept);

  // the ripples, painted into the body: lightened toward a colour of their own by the fine waves' slope, over a cut
  if (cw.ripple.w > 0.0) {
    let steep = min(length(slope) / RIPPLE_FULL, 1.0);
    let lift = smoothstep(0.0, 1.0, clamp((steep - cw.ripples.y) / max(1.0 - cw.ripples.y, 1.0e-3), 0.0, 1.0));
    colour = mix(colour, cw.ripple.rgb * lightOn * frame.exposure, lift * cw.ripples.x);
  }

  // the sky in the water, by how edge-on the surface is seen: folded up, since water does not mirror the ground
  let rd = reflect(-v, n);
  let folded = vec3f(rd.xy, abs(rd.z));
  var sky = textureSampleLevel(envSpecular, samp, folded, frame.maxLod * CLEAR_SHARP).rgb * frame.exposure;
  // the scene in the mirror, where it was drawn, stands in for the sky there. Its edge is filtered with the rest of the
  // texture, which is premultiplied, so where scenery meets sky it is a soft one over a texel of the half-size frame and
  // not a line of its facets. The swells' own normal shifts where it is read, along the screen's axes, by a share of the
  // screen; the fine waves' would fade out with the distance at which the mirror shows things
  if (cw.mirror.w > 0.0) {
    let lean = (frame.viewProj * vec4f(nm.x, nm.y, 0.0, 0.0)).xy;
    var look = vec2f(px.x * cw.screen.z, px.y * cw.screen.w) + vec2f(lean.x, -lean.y) * (0.5 * cw.mirror.z);
    // the detail layer's shift of the read is a share of the screen, which is how a far bank's reflection moves; a
    // thing standing in the water by this point hardly moves in it, and the shift pulled a bobber's red out beside it.
    // So where the layer's read lands on something near the water here that the swells' own read does not show, the
    // swells' read is taken whole
    if (cw.ripples.z > 0.0) {
      let lean0 = (frame.viewProj * vec4f(n0.x, n0.y, 0.0, 0.0)).xy;
      let look0 = vec2f(px.x * cw.screen.z, px.y * cw.screen.w) + vec2f(lean0.x, -lean0.y) * (0.5 * cw.mirror.z);
      let near = min(clearMirrored(look0, in.world) * DETAIL_LANDING, distance(frame.camPos, in.world) * DETAIL_NEAR);
      if (clearMirrored(look, in.world) < near) { look = look0; }
    }
    let seen = textureSampleLevel(sceneMirror, sceneMirrorSampler, look, 0.0);
    sky = sky * (1.0 - seen.a) + seen.rgb;
  }
  if (cw.tint.w > 0.0) { sky = sky * cw.tint.rgb; }
  let reflectance = CLEAR_RF0 + (1.0 - CLEAR_RF0) * pow(1.0 - ndv, 5.0);
  // eased off by the camera, where there is a near colour, so the water at the feet is seen into and not mirrored
  // by as much as a game asks, up to all of it kept
  let mirror = select(1.0, 1.0 - nearness * (1.0 - cw.mirror.y), cw.near.w > 0.0);
  colour = mix(colour, sky, reflectance * CLEAR_MIRROR * cw.mirror.x * mirror);

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
    // second line, broken by the same noise; and the band the depth gives, thin (or, asked for, full width), only out where the field rings nothing
    let q = in.world.xy / (width * FOAM_LINE_CELL) + vec2f(frame.spare0 * FOAM_DRIFT, 0.0);
    let noise = flowNoise(q) * (1.0 - FOAM_LINE_FINE) + flowNoise(q * 2.7 + 5.3) * FOAM_LINE_FINE;
    let wobble = (noise - 0.5) * width * FOAM_BREAK;
    let d = shore + wobble;
    // eased over a pixel at the least, so a line is crisp and not jagged
    let soft = max(width * cw.foamOpt.x, perPixel * 0.75);
    let line = 1.0 - smoothstep(width - soft, width + soft, d);
    let rimTo = width * (1.0 + FOAM_RIM);
    let rim = 1.0 - smoothstep(rimTo - soft, rimTo + soft, d);
    let from2 = width + cw.lines.x;
    let to2 = from2 + cw.lines.y;
    let second = select(0.0, smoothstep(from2 - soft, from2 + soft, d) * (1.0 - smoothstep(to2 - soft, to2 + soft, d)), cw.lines.y > 0.0);
    let thinW = width * FOAM_THIN;
    let thin = (1.0 - smoothstep(thinW - soft, thinW + soft, stand + wobble * FOAM_THIN)) * step(to2 + width, shore);
    // asked for, the band is drawn at its full width out where the field rings nothing, with its rim, so a thing in the
    // water has a ring as the shore has
    let band = (1.0 - smoothstep(width - soft, width + soft, stand + wobble)) * step(to2 + width, shore);
    let bandRim = (1.0 - smoothstep(rimTo - soft, rimTo + soft, stand + wobble)) * step(to2 + width, shore);
    let ringed = select(thin, band, cw.foamOpt.y > 0.5);
    let lit = lightOn * frame.exposure;
    colour = mix(colour, cw.edge.rgb * lit, select(rim, max(rim, bandRim), cw.foamOpt.y > 0.5));
    colour = mix(colour, cw.foam.rgb * lit, max(max(line, second), ringed));
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
