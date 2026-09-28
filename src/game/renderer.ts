/**
 * A renderer for games with a fixed or slowly-moving camera.
 *
 * The still-life renderer next door draws one piece beautifully and redraws
 * only when something changes. This one draws every frame, and its shape was
 * decided by measurement rather than taste — see the spike's RESULTS.md for
 * the numbers behind each of these:
 *
 * - **Its own material.** The still-life shader costs about 11 ms a
 *   megapixel on the pixels it covers, which is a 22 ms frame at 1080p. This
 *   one was under a tenth of a millisecond for the same coverage.
 * - **Forward, not deferred.** A plain loop over point lights carries three
 *   to five hundred of them before it needs tiles or clusters, which is far
 *   more than an arena wants.
 * - **No culling, no LOD.** Eight thousand movers at nearly five million
 *   triangles cost under three milliseconds. Neither was earning its
 *   complexity.
 * - **Effects in their own stage.** Additive layers through a shader that
 *   only fades and tints cost a third of what they cost through a material.
 * - **The static half can be kept**, when the arena is heavy and the lights
 *   that reach it do not move. Those two conditions are not independent: a
 *   moving light relights the arena, so keeping the frame and having dynamic
 *   lights on static geometry are alternatives.
 */
import { bufferFrom, emptyBuffer, shader, type Gpu } from '../gpu/context';
import { Camera } from '../gpu/camera';
import type { Mesh as PartMesh } from '../mesh/types';
import { LIGHT_STRIDE, type LightPool } from './lights';
import { sunShadowMatrix, spotShadowMatrix, type Box } from './shadows';
import { Particles, type Emit } from './particles';
import {
  BLUR_WGSL, BRIGHT_WGSL, COMPOSITE_WGSL, DEPTH_WGSL, EFFECT_WGSL, FOG_BLEND_WGSL, FOG_MSAA_WGSL, FOG_WGSL, FXAA_WGSL, SPOT_SHADOWS, sceneSource,
  type SceneVariant,
} from './shaders';
import { CONE_FLOATS, FOG_FLOATS, NO_FOG, fogUniform, noFog, type Fog } from './fog';
import { ContactOcclusion } from '../render/ao';
import { STILL, checkField, type GrassField, type GrassOptions, type Wind } from './grass';
import { GrassPass } from './grass-pass';

/** A blade the GPU grew this frame: where its root is, and its id. */
export interface DrawnBlade { x: number; y: number; z: number; id: number }

const HDR: GPUTextureFormat = 'rgba16float';
const DEPTH: GPUTextureFormat = 'depth24plus';
/** The shadow maps' format: a depth the comparison sampler can read. */
const SHADOW: GPUTextureFormat = 'depth32float';
const SUN_MAP = 2048;
const SPOT_MAP = 512;
/**
 * Depth bias in the lookups, in clip depth. The sun's map spans the fitted
 * box, so a unit of its depth is the box's whole extent along the light and
 * this is a few millimetres of it; a spot's depth is perspective and packed
 * toward the lamp, so the same number is far more there — see the tests.
 */
const SUN_BIAS = 0.0012;
/**
 * The fog's own bias into the sun's map, and much smaller than a surface's.
 * A surface needs enough bias not to shadow itself; a point of air needs
 * only enough to clear the map's own quantisation, and the bias is in the
 * map's normalised depth, so on an arena-sized box lit by a low sun it buys
 * a great many world units. At four times SUN_BIAS it was some ninety of
 * them — wider than the trees — and a forest at dawn held a tenth of the
 * light out of the mist instead of half.
 */
const FOG_BIAS = 0.0002;
const SPOT_BIAS = 0.0006;
/**
 * How near a lamp its shadow map starts, in millimetres, and the angle one
 * texel of that map spans — about 0.0075 radians for the 125-degree map a
 * 58-degree cone gets, less for a narrower one, which errs toward a little
 * too much bias. Their product is the soft kernel's bias in the map's own
 * depth, which the shader used to hold as a constant of 0.15: right in
 * millimetres and a hundred and fifty metres out in metres.
 */
const SPOT_NEAR_MM = 20;
const SPOT_TEXEL_ANGLE = 0.0075;
/** The earth's gravity, in millimetres a second squared. */
const EARTH_MM = 9810;

/** One mesh and the placements of it, as the still-life path also takes them. */
export interface GameGroup {
  mesh: PartMesh;
  /** Column-major 4×4 per placement. Its length fixes the pool; `count` moves within it. */
  matrices: Float32Array;
  /** How many placements are live, from the first. Left out, all of them. */
  count?: number;
  /**
   * Colour and roughness per placement, four floats each, as `tint` writes
   * them. Left out, every placement takes the group's own `albedo` and
   * `roughness`, or failing those the look's.
   */
  materials?: Float32Array;
  /** The whole group's colour, when the placements do not differ. */
  albedo?: [number, number, number];
  /** The whole group's roughness. 0 is a mirror, 1 is chalk. */
  roughness?: number;
  /**
   * A pattern per placement, `PATTERN_STRIDE` floats each: its kind (1 a
   * swirl, 2 bands, 3 marbling, 4 speckle, 0 none), how many times over the
   * thing's own units it repeats, a seed from 0 to 1 that shifts it, a spare,
   * and then the second colour it mixes in and a spare. Drawn from where on
   * the thing a fragment is, so it turns with the thing. Left out, the group
   * draws through a shader with no pattern code in it at all.
   */
  patterns?: Float32Array;
}

/** Eight floats a placement's pattern: kind, scale, seed and a spare, then the second colour and a spare. */
export const PATTERN_STRIDE = 8;

/** Four floats a placement: colour and roughness, as the shader reads them. */
export const MATERIAL_STRIDE = 4;

/** Floats an effect layer: centre xy, half-size, brightness, colour rgb, sharpness. */
export const EFFECT_STRIDE = 8;

/** How a frame is put together. */
export type FrameMode =
  /** Draw everything every frame. Right when the arena is light, or its lighting moves. */
  | 'redraw'
  /** Keep the static half's colour and depth and copy them back. Right when the arena is heavy and its lighting is still. */
  | 'keep';

export interface Look {
  /**
   * How surfaces are shaded: physically based, as a real surface is, or toon,
   * in a few flat bands at their own colour. Left out, physically based.
   */
  shading?: 'pbr' | 'toon';
  /** What a group that names no colour of its own is given. */
  albedo: [number, number, number];
  /** What a group that names no roughness of its own is given. */
  roughness: number;
  /** Toward the light, not along it. */
  sunDir: [number, number, number];
  sunColour: [number, number, number];
  exposure: number;
  /**
   * How far a point light carries: the distance, in the world's own units,
   * at which it is down to half. Small makes a bright dot with darkness
   * around it; large makes a light that washes a room. It is not the light's
   * radius — the radius is where it stops entirely, this is how it spends
   * the way there.
   */
  falloffHalf: number;
  /**
   * How much the environment contributes. It lights every surface everywhere
   * with no light in the scene at all, so it sets the floor the point lights
   * are added on top of: 1 is a lit room, 0.2 a dark one where the only thing
   * you see by is what is burning.
   */
  ambient: number;
  /**
   * How a spotlight's shadow softens with distance: texels of its map the
   * lookup's disc grows by for every world unit a surface is from the lamp.
   * Zero is a hard edge everywhere. A lamp is a head, not a point, and a
   * thin thing standing far from the surface it shades throws an edge that
   * has spread by the time it lands; at 1/500 a pole 2500 from a lamp
   * shades the road in a smear rather than a wedge. The map is 512 across
   * a cone, so a texel is about 0.008 of the distance: the disc's radius in
   * world units is roughly this times the distance squared times that.
   *
   * It is per world unit, and so the one number in this record that scales
   * the other way: a world in metres wants a thousand times the value a
   * world in millimetres does, because the distances it multiplies are a
   * thousand times smaller.
   */
  spotSoftness: number;
  /**
   * Screen-space ambient occlusion: how dark a crease, a corner or the
   * ground under a thing goes. 1 is the still-life renderer's contact
   * shadow, which is a fifth dark at a right-angled corner once blurred;
   * past 1 is a heavier hand, which a game seen from across a room wants,
   * and the result is held at black. Nothing is no occlusion and none of
   * its passes: a depth pass of everything, the occlusion from that depth
   * at half the frame, and a blur that stops at edges. It darkens the
   * ambient term fully and the lights by `occlusionDirect` of it, so it is
   * worth most where the ambient is doing real work.
   */
  occlusion: number;
  /**
   * How far a surface looks for what shades it, in world units: about the
   * size of the gaps it should darken. The occlusion pass holds it to 48
   * of its half-size pixels on screen, so it stays a contact shadow up close.
   */
  occlusionRadius: number;
  /**
   * How much of the occlusion the direct light takes, 0 to 1. Nothing is
   * the physical answer — occlusion is of the sky, not of a lamp — and a
   * little is a look: the grime in the corners that a lit room still has.
   */
  occlusionDirect: number;
  /**
   * What the frame clears to, before tonemapping. The environment lights the
   * material but is never drawn, so this is the whole of the sky the camera
   * sees past the arena's edge.
   */
  background: [number, number, number];
  /**
   * How the edges of things are smoothed, so a rail, a string or a pole has
   * no stair steps and a thin thing does not shimmer as the camera moves.
   * Left out, or 'none', neither, as it always was.
   *
   * 'msaa' draws the scene at four samples a pixel, colour and depth, and
   * resolves it before the fog and the post chain see it: everything drawn
   * into the scene (groups, grass, particles, sprites, effect layers, and
   * the static half a kept frame holds) is smoothed where it covers part of
   * a pixel, and nothing inside a surface changes. The fog marches the
   * first sample of each pixel's depth; the occlusion takes its own depth
   * pass at one sample, as it always did, and is blurred at half the frame
   * anyway. It costs the most, in time and in memory: at 1280x800 the
   * multisampled colour and depth are 49 MB, and as much again for a kept
   * frame once `keep` is drawn with it.
   *
   * 'fxaa' smooths the finished frame in one pass instead (see FXAA_WGSL):
   * cheaper, and softer, and it softens a little of what is sharp on purpose.
   *
   * The builds either needs are compiled the first time a frame is asked
   * for with it, never before, so a game that does not ask compiles nothing
   * more; `prepare` compiles them and says when they are in, and until then
   * a frame is drawn with what is. The ladder holds it down with
   * `economy.antialias`.
   *
   * Measured on an M4 Pro at 1280x800, alternated with none in nine rounds
   * on a shared GPU: four samples added 0.14 ms to `perf:gpu`'s standard
   * scene (0.10 to 0.22) and 0.43 ms to its golf field (0.37 to 0.58), whose
   * every blade is drawn into them; FXAA added 0.04 ms and 0.13, more where
   * more of the frame is edges.
   */
  antialias?: Antialias;
  /**
   * Toon only: the width the bands' edges are eased over, as a share of the
   * sun a surface takes (the bands change at 0.05 and 0.45 of it), so a
   * band's edge on a curve is a smooth line and not a stair. It is never
   * eased over less than the share changes across a pixel, and the glint's
   * edge, a stair of its own, is eased over a pixel with it. Held to 0.1,
   * past which a surface in the sun's own shadow would lift off the deepest
   * band. Left out, or nought, the hard steps they always were. A few
   * instructions a pixel, and no cost could be told from the noise: a
   * median under 0.01 ms over nine rounds on the standard scene at 1280x800,
   * the rounds spread about 0.07 either way.
   */
  bandSoftness?: number;
  /**
   * Toon only: what a surface's colour is multiplied by in the deepest shade,
   * turned from the sun or in its shadow, so the shade is a colour of its
   * own and not a darker grey: a cool blue-violet such as [0.5, 0.52, 0.8]
   * for a sunny day. The band between the shade and the light is tinted half
   * as far, and a softened edge by as far as it is eased. Left out, the
   * bands' grey as it always was, which is as if it were [0.6, 0.6, 0.6]. A
   * few instructions a pixel, and no cost could be told from the noise: a
   * median under 0.01 ms over nine rounds on the standard scene at
   * 1280x800, the rounds spread about 0.07 either way.
   */
  shadeColour?: [number, number, number];
  /**
   * Toon only: how bright a rim of light is where a surface turns from the
   * camera, so a thing stands off whatever is behind it. It is added, at
   * `rimColour` times this, and is brightest edge-on, falling to nothing
   * `rimWidth` in. A flat ground seen at a grazing angle is all edge, so it
   * takes the rim too: a width under the ground's own at the game's views
   * keeps it off. Left out, or nought, no rim. A few instructions a pixel,
   * and no cost could be told from the noise: a median under 0.01 ms over
   * nine rounds on the standard scene at 1280x800, the rounds spread about
   * 0.07 either way.
   */
  rim?: number;
  /** The rim's colour. Left out, white. */
  rimColour?: [number, number, number];
  /**
   * How far in from the edge the rim reaches, from nothing to one: the
   * share of the way from edge-on to facing the camera, by the cosine of the
   * angle between them. On a ball, 0.3 is the outer twentieth of its radius
   * and 0.5 the outer seventh. Left out, 0.35.
   */
  rimWidth?: number;
  /**
   * Toon only: the light from above and the light from below, in place of
   * the environment's brightness, which toon takes as a grey. A surface
   * facing straight up takes `skyLight`, one facing straight down
   * `groundLight` (a warm bounce off the grass, say), and one between a mix
   * by how far it faces up; each times the surface's colour and the look's
   * `ambient`. The environment still gives the gleam on what is smooth.
   * Either left out takes the other; both left out, the environment's grey,
   * which is the environment's brightness in that direction halved. A few
   * instructions a pixel, and no cost could be told from the noise: a
   * median under 0.01 ms over nine rounds on the standard scene at 1280x800,
   * the rounds spread about 0.07 either way.
   */
  skyLight?: [number, number, number];
  /** The light from below: see `skyLight`. */
  groundLight?: [number, number, number];
  /**
   * Toon only: how much of the sun's fall-off the top band keeps, so a
   * surface's form shows in it: a slope turned from the sun a little darker
   * than flat ground, one facing it a little brighter, by as much as the sun
   * it takes differs from what flat ground takes, times this. Flat ground,
   * facing straight up, is as it was, and so is everything in the bands
   * below; the top band never falls below the one beneath it, and meets it
   * without a step down. Without it a toon look draws a gentle hill exactly
   * as bright as the flat, since every slope a ball can roll on takes more
   * of a high sun than the top band's edge. Held to three. Left out, or
   * nought, the flat top band it always was. A few instructions a pixel,
   * and no cost could be told from the noise: a median of 0.003 ms on the
   * standard scene and 0.04 on the golf field over nine rounds at
   * 1280x800, the rounds spread from -0.06 to 0.11.
   */
  form?: number;
}

/**
 * How the edges of things are smoothed: see `Look.antialias`. In the order
 * of their cost, so a ladder that steps down takes the next one along.
 */
export type Antialias = 'none' | 'fxaa' | 'msaa';
const ANTIALIAS: readonly Antialias[] = ['none', 'fxaa', 'msaa'];

/** Samples a pixel when the scene is multisampled: four, which every WebGPU device has for these formats. */
export const SAMPLES = 4;

/**
 * The antialiasing a frame is drawn with: what the look asks for, held to
 * what the economy allows. The economy never raises it: a look that asks
 * for none gets none on every rung.
 */
export function antialiasFor(look: Pick<Look, 'antialias'>, economy: Pick<GameEconomy, 'antialias'>): Antialias {
  const asked = Math.max(0, ANTIALIAS.indexOf(look.antialias ?? 'none'));
  const allowed = economy.antialias === undefined ? ANTIALIAS.length - 1 : Math.max(0, ANTIALIAS.indexOf(economy.antialias));
  return ANTIALIAS[Math.min(asked, allowed)];
}

/** Floats the toon look's own light takes in the frame's uniform, after the thirty-two it always had. */
export const TOON_FLOATS = 20;
/** The most of the sun's fall-off the top band may keep. */
export const MAX_FORM = 3;
/** The widest the toon bands' edges may be eased over. */
export const MAX_BAND_SOFTNESS = 0.1;
/** How far in the rim reaches when the look does not say. */
export const RIM_WIDTH = 0.35;

/**
 * The toon look's own light, packed as the scene shader's `Frame` reads it
 * after `lightCount`: the shade colour and the bands' softness, the rim's
 * colour at its strength and its width, the sky's light and whether there
 * is a sky and ground at all, and the ground's light and whether there is a
 * shade colour; and how much form the top band keeps, and three spares. A
 * look that asks for none of it packs noughts, and every
 * branch in the shader that reads them is skipped: the frame is as it was.
 * What is not a number is taken as not asked.
 */
export function toonUniform(out: Float32Array, look: Look, offset = 0): Float32Array {
  const num = (x: number | undefined, fallback: number) => (x !== undefined && Number.isFinite(x) ? x : fallback);
  const colour = (c: [number, number, number] | undefined) => (c && c.every(Number.isFinite) ? c : undefined);
  const shade = colour(look.shadeColour);
  out.set(shade ?? [0, 0, 0], offset);
  out[offset + 3] = Math.min(MAX_BAND_SOFTNESS, Math.max(0, num(look.bandSoftness, 0)));
  const strength = Math.max(0, num(look.rim, 0));
  const width = Math.min(1, Math.max(0, num(look.rimWidth, RIM_WIDTH)));
  const rim = colour(look.rimColour) ?? [1, 1, 1];
  const lit = strength > 0 && width > 0;
  out.set(lit ? [rim[0] * strength, rim[1] * strength, rim[2] * strength] : [0, 0, 0], offset + 4);
  out[offset + 7] = lit ? width : 0;
  const sky = colour(look.skyLight) ?? colour(look.groundLight);
  const ground = colour(look.groundLight) ?? sky;
  out.set(sky ?? [0, 0, 0], offset + 8);
  out[offset + 11] = sky ? 1 : 0;
  out.set(ground ?? [0, 0, 0], offset + 12);
  out[offset + 15] = shade ? 1 : 0;
  out[offset + 16] = Math.min(MAX_FORM, Math.max(0, num(look.form, 0)));
  out[offset + 17] = out[offset + 18] = out[offset + 19] = 0;
  return out;
}

/**
 * The look's opening settings, with its lengths in millimetres — the unit the
 * library is written in. For a world in anything else, `defaultLook`.
 */
export const DEFAULT_LOOK: Look = {
  albedo: [0.95, 0.93, 0.88],
  roughness: 0.3,
  sunDir: [0.3, -0.4, 0.86],
  sunColour: [1, 0.97, 0.92],
  exposure: 1,
  // fifty units, which is what the constant it replaced worked out at
  falloffHalf: 50,
  ambient: 1,
  spotSoftness: 0,
  occlusion: 0,
  // a hand's width: the gap under a thing and the corner where two meet
  occlusionRadius: 300,
  occlusionDirect: 0.25,
  background: [0.02, 0.02, 0.024],
};

/**
 * `DEFAULT_LOOK` in the caller's units: `mmPerUnit` millimetres to a world
 * unit, as the renderer was given. Only `falloffHalf` is a length, and
 * `spotSoftness` would be per length if it were not nought.
 */
export function defaultLook(mmPerUnit = 1): Look {
  return {
    ...DEFAULT_LOOK,
    falloffHalf: DEFAULT_LOOK.falloffHalf / mmPerUnit,
    occlusionRadius: DEFAULT_LOOK.occlusionRadius / mmPerUnit,
    spotSoftness: DEFAULT_LOOK.spotSoftness * mmPerUnit,
  };
}

/** What the ladder may give up, cheapest loss first. */
export interface GameEconomy extends SceneVariant {
  /** A fraction of the effect layers to draw: 1 all of them, 0 none. */
  effects: number;
  /** Whether the particle pool is simulated and drawn. Off, it is neither. */
  particles?: boolean;
  /**
   * Whether the post chain runs. Off, the frame is tonemapped and nothing
   * else of it: no bloom, vignette or grain. The antialiasing has a rung of
   * its own.
   */
  post?: boolean;
  /** Whether the fog is marched. Off, there is none, whatever its density says. */
  fog?: boolean;
  /** Whether the occlusion is drawn. Off, there is none, whatever the look's strength says. */
  occlusion?: boolean;
  /**
   * The share of the grass's blades drawn: 1 all of them, 0 none and no
   * grass passes. Half keeps the same blades the distance would, so a step
   * down the ladder thins the field and never reshuffles it. Left out, all.
   */
  grass?: number;
  /** Whether the grass bends in the wind. Off, it stands at its lean at rest, and a press still shows. Left out, on. */
  wind?: boolean;
  /**
   * The most antialiasing the frame may spend (see `Look.antialias`):
   * 'msaa' whatever the look asks, 'fxaa' the cheaper pass in place of four
   * samples a pixel, 'none' neither. It never gives more than the look asks.
   * Left out, whatever the look asks. Both builds stay compiled once asked
   * for, so a step either way is the next frame.
   */
  antialias?: Antialias;
}

/**
 * The post chain's knobs. Bloom is how much of the blurred bright pass is
 * added back; threshold is the luminance, before tonemapping, that it
 * starts at, and knee how softly; vignette is how dark the corners go, 0 to
 * 1; grain is the amplitude of the noise on the displayed value.
 */
export interface Post {
  bloom: number;
  threshold: number;
  knee: number;
  vignette: number;
  grain: number;
  /**
   * How the frame is brought to the screen: the filmic curve, which holds a
   * bright colour short of white, or straight, held at white, for a toon
   * world's chosen colours. Left out, filmic.
   */
  tone?: 'filmic' | 'clamp';
}

export const DEFAULT_POST: Post = { bloom: 0.35, threshold: 1.0, knee: 0.5, vignette: 0.3, grain: 0.03 };

export const FULL_ECONOMY: GameEconomy = { cullLights: true, points: true, effects: 1, particles: true, post: true, fog: true, occlusion: true };

/** A placement's matrix, the four columns of it, one placement a step. */
const INSTANCE_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: 64, stepMode: 'instance',
  attributes: [4, 5, 6, 7].map((loc, k) => ({ shaderLocation: loc, offset: k * 16, format: 'float32x4' as GPUVertexFormat })),
};
// Material rides in its own instance buffer rather than alongside the
// matrix, so that moving a thing and recolouring it stay separate writes.
// A game moves everything every frame and recolours a handful of things
// when they are hit; one write of sixteen floats a placement is cheap
// where one of twenty, every frame, is a quarter more traffic for nothing.
const MATERIAL_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: 16, stepMode: 'instance',
  attributes: [{ shaderLocation: 8, offset: 0, format: 'float32x4' as GPUVertexFormat }],
};
const PATTERN_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: PATTERN_STRIDE * 4, stepMode: 'instance',
  attributes: [
    { shaderLocation: 9, offset: 0, format: 'float32x4' as GPUVertexFormat },
    { shaderLocation: 10, offset: 16, format: 'float32x4' as GPUVertexFormat },
  ],
};
/** Every build of the scene shader, each with and without patterns and toon shading. */
const SCENE_VARIANTS: SceneVariant[] = [];
for (const toon of [false, true]) {
  for (const patterned of [false, true]) {
    for (const shadows of [true, false]) {
      for (const points of [true, false]) {
        for (const cullLights of [true, false]) SCENE_VARIANTS.push({ cullLights, points, shadows, patterned, toon });
      }
    }
  }
}

interface Uploaded {
  position: GPUBuffer;
  normal: GPUBuffer;
  index: GPUBuffer;
  instance: GPUBuffer;
  material: GPUBuffer;
  /** Every placement's pattern, all nought where the group has none, since every build of the shader reads it. */
  pattern: GPUBuffer;
  /** Whether the group has patterns, and draws through the build with the pattern code in it. */
  patterned: boolean;
  indexCount: number;
  capacity: number;
  count: number;
}

export class GameRenderer {
  readonly camera = new Camera();
  /** Resolves when every pipeline has compiled; `frame` draws nothing before. */
  readonly ready: Promise<void>;

  private scenePipelines = new Map<string, GPURenderPipeline>();
  /** The scene shader's builds and their layout, kept to make the multisampled pipelines from when a look first asks for them. */
  private sceneModules = new Map<string, GPUShaderModule>();
  private sceneLayoutPipeline: GPUPipelineLayout;
  private effectModule: GPUShaderModule;
  private effect!: GPURenderPipeline;
  private effectMsaa: GPURenderPipeline | null = null;

  // The antialiasing: how much of it the look has asked for so far (an
  // index into ANTIALIAS), the builds each needs, compiled once when first
  // asked for and never before, and what each draws into, made at the
  // frame's size once its builds are in. The multisampled colour's samples
  // are thrown away once resolved; the depth's are kept for the fog.
  private antialiasAsked = 0;
  private antialiasBuilt: Promise<void> = Promise.resolve();
  private msaaBuild: Promise<void> | null = null;
  private fxaaBuild: Promise<void> | null = null;
  private msaaCompiled = false;
  private fxaaCompiled = false;
  private msaaColour: GPUTexture | null = null;
  private msaaDepth: GPUTexture | null = null;
  private msaaKeptColour: GPUTexture | null = null;
  private msaaKeptDepth: GPUTexture | null = null;
  /** Whether the kept frame at four samples a pixel still matches the static half. */
  private keptStaleMsaa = true;
  private fogMsaaLayout: GPUBindGroupLayout | null = null;
  private fogMsaaPipeline: GPURenderPipeline | null = null;
  private fogMsaaBind: GPUBindGroup | null = null;
  private fxaaLayout: GPUBindGroupLayout | null = null;
  private fxaaPipeline: GPURenderPipeline | null = null;
  private fxaaBind: GPUBindGroup | null = null;
  /** The frame as shown, before FXAA reads it: the composite's target when FXAA is on. */
  private shown: GPUTexture | null = null;
  private composite!: GPURenderPipeline;
  private compiled = false;

  private sceneLayout: GPUBindGroupLayout;
  private effectLayout: GPUBindGroupLayout;
  private compositeLayout: GPUBindGroupLayout;
  /** The bloom passes: bright to a quarter-size texture, then a blur each way. */
  private postLayout: GPUBindGroupLayout;
  private bright!: GPURenderPipeline;
  private blur!: GPURenderPipeline;
  private postBuffer: GPUBuffer;
  private postData = new Float32Array(12);
  private blurH: GPUBuffer;
  private blurV: GPUBuffer;
  private postSampler: GPUSampler;
  private bloomA: GPUTexture | null = null;
  private bloomB: GPUTexture | null = null;
  private brightBind: GPUBindGroup | null = null;
  private blurBindA: GPUBindGroup | null = null;
  private blurBindB: GPUBindGroup | null = null;
  private postTime = 0;
  post: Post = { ...DEFAULT_POST };
  /**
   * The volume the frame is seen through. Density at nothing is no fog and
   * no passes; see `fog.ts` for what the rest of it means.
   */
  fog: Fog = { ...NO_FOG };
  private fogLayout: GPUBindGroupLayout;
  private fogBlendLayout: GPUBindGroupLayout;
  private fogPipeline!: GPURenderPipeline;
  private fogBlendPipeline!: GPURenderPipeline;
  private fogBuffer: GPUBuffer;
  private fogData = new Float32Array(FOG_FLOATS);
  private coneBuffer: GPUBuffer;
  private coneData = new Float32Array(SPOT_SHADOWS * CONE_FLOATS);
  private fogMap: GPUTexture | null = null;
  private fogBind: GPUBindGroup | null = null;
  private fogBlendBind: GPUBindGroup | null = null;
  private sceneBind: GPUBindGroup | null = null;
  /** What the scene bind group was last made from, to make it again when the occlusion's texture is. */
  private environment: { specular: GPUTexture; brdf: GPUTexture } | null = null;
  /**
   * The occlusion: its passes, the depth-only pipeline that draws everything
   * into its depth at render resolution, the camera matrix that pass reads,
   * and a white texel the scene reads in its place when there is none.
   */
  private occlusion: ContactOcclusion;
  private occlusionDepthPipeline!: GPURenderPipeline;
  private occlusionPassBuffer: GPUBuffer;
  private occlusionPassBind: GPUBindGroup;
  private noOcclusion: GPUTexture;
  private effectBind: GPUBindGroup | null = null;
  private compositeBind: GPUBindGroup | null = null;

  private frameBuffer: GPUBuffer;
  private frameData = new Float32Array(32 + TOON_FLOATS);
  private lightBuffer: GPUBuffer;
  private effectBuffer: GPUBuffer;
  private quadBuffer: GPUBuffer;
  private sampler: GPUSampler;
  private maxLod = 0;
  /** Tint rgb and the viewport aspect the effect shader rounds its glows by. */
  private effectUniform = new Float32Array([1, 1, 1, 1]);
  private lightCount = 0;

  private colour: GPUTexture | null = null;
  private depth: GPUTexture | null = null;

  // The shadow maps: one for the sun, a stack for the spotlights, a
  // comparison sampler to read them through, the matrices they were
  // rendered with, and a depth-only pipeline to render them.
  private sunMap: GPUTexture;
  private spotMaps: GPUTexture;
  private shadowSampler: GPUSampler;
  private shadowBuffer: GPUBuffer;
  // the sun's matrix and params, a matrix a spot, the spots' params, and the
  // soft kernel's bias — which is a length, so it is computed, not written in
  private shadowData = new Float32Array(16 + 4 + SPOT_SHADOWS * 16 + 4 + 4);
  private depthPipeline!: GPURenderPipeline;
  private depthLayout: GPUBindGroupLayout;
  /** One matrix buffer and bind group per pass: the sun's, then a spot's each. */
  private passBuffers: GPUBuffer[] = [];
  private passBinds: GPUBindGroup[] = [];
  private sunBox: Box | null = null;
  /** The spotlights being shadowed this frame: what to render each layer from. */
  private spots: { position: [number, number, number]; direction: [number, number, number]; outer: number; reach: number; colour: [number, number, number]; cosInner: number; cosOuter: number }[] = [];
  private lightScratch = new Float32Array(0);
  private keptColour: GPUTexture | null = null;
  private keptDepth: GPUTexture | null = null;
  private width = 0;
  private height = 0;

  private staticGroups: Uploaded[] = [];
  /** The grass, made when a game first asks for it and not before. */
  private grass: GrassPass | null = null;
  /** Whether the grass was grown this frame, and so is drawn in it. */
  private grassGrown = false;
  private dynamicGroups: Uploaded[] = [];
  /** Whether the kept frame still matches the static half. */
  private keptStale = true;

  economy: GameEconomy = { ...FULL_ECONOMY };
  /** The look, opened at `defaultLook(mmPerUnit)` by the constructor. */
  look: Look = { ...DEFAULT_LOOK };
  /**
   * The particles, simulated on the GPU: see `particles.ts`. The game emits
   * into them through `emit` and they are moved and drawn by `frame`.
   * Gravity is in the game's own units a second squared — the renderer has
   * no opinion about what a unit is, and the default is the earth's, put into
   * that unit through `mmPerUnit`.
   */
  readonly particles: Particles;
  /** The earth's, in the caller's units, unless the game says otherwise. */
  gravity: number;
  /**
   * The game's own clock, in seconds, which the grass's wind reads: the
   * game sets it each frame from the time it steps, so a paused game, or a
   * test that sets the same moment twice, draws the same picture. The
   * renderer never reads a clock for it. Nought until it is set.
   */
  time = 0;
  /** The wind the grass bends in, which the game drives. Still until it is set. */
  wind: Wind = { ...STILL };

  /**
   * How many millimetres one world unit is. The world itself — meshes,
   * matrices, camera, lights, emitters — stays in whatever unit the caller
   * works in; this is how the renderer states its own fixed sizes in that
   * unit, and it is the whole of what `render/` learned when it was made a
   * library. Nothing here is fixed in a real size the way a groove or a vein
   * wire is; what needs it is the defaults that carry a length, the floors
   * under the lengths a division needs, and the near plane of a spot's
   * shadow map.
   */
  readonly mmPerUnit: number;

  /** A fixed size, from millimetres into the world's own unit. */
  private mm(millimetres: number) { return millimetres / this.mmPerUnit; }

  constructor(private ctx: Gpu, private lightCapacity = 512, private effectCapacity = 256, particleCapacity = 16384, mmPerUnit = 1) {
    const { device } = ctx;
    this.mmPerUnit = mmPerUnit > 0 ? mmPerUnit : 1;
    this.look = defaultLook(this.mmPerUnit);
    this.fog = noFog(this.mmPerUnit);
    this.gravity = this.mm(EARTH_MM);
    this.particles = new Particles(ctx, particleCapacity, 128, HDR, DEPTH);
    this.frameBuffer = device.createBuffer({ label: 'game frame', size: (32 + TOON_FLOATS) * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.lightBuffer = emptyBuffer(device, Math.max(1, lightCapacity) * LIGHT_STRIDE * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, 'point lights');
    this.effectBuffer = device.createBuffer({ label: 'effect', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.effectBuffer, 0, this.effectUniform);
    this.quadBuffer = emptyBuffer(device, Math.max(1, effectCapacity) * EFFECT_STRIDE * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, 'effect quads');
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });

    // The maps are made once at a fixed size and never resized: a map is
    // sized to what it covers, not to the window. 2048 across an arena
    // twelve metres wide is six millimetres a texel.
    // COPY_SRC so a test can read a map back and see what is in it. A
    // shadow that does not appear has no other symptom, and a map dumped as
    // a picture answers in one run what pixel checks argue about for an hour.
    const mapUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    this.sunMap = device.createTexture({ label: 'sun shadow', size: [SUN_MAP, SUN_MAP], format: SHADOW, usage: mapUsage });
    this.spotMaps = device.createTexture({ label: 'spot shadows', size: [SPOT_MAP, SPOT_MAP, SPOT_SHADOWS], format: SHADOW, usage: mapUsage });
    // linear filtering on a comparison sampler is the hardware's own PCF
    this.shadowSampler = device.createSampler({ label: 'shadow compare', compare: 'less-equal', magFilter: 'linear', minFilter: 'linear' });
    this.shadowBuffer = device.createBuffer({ label: 'shadows', size: this.shadowData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.depthLayout = device.createBindGroupLayout({
      label: 'shadow pass',
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    });
    for (let i = 0; i < 1 + SPOT_SHADOWS; i++) {
      const b = device.createBuffer({ label: `shadow pass ${i}`, size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.passBuffers.push(b);
      this.passBinds.push(device.createBindGroup({ label: `shadow pass ${i}`, layout: this.depthLayout, entries: [{ binding: 0, resource: { buffer: b } }] }));
    }
    this.occlusion = new ContactOcclusion(ctx, DEPTH);
    this.occlusionPassBuffer = device.createBuffer({ label: 'occlusion depth pass', size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.occlusionPassBind = device.createBindGroup({ label: 'occlusion depth pass', layout: this.depthLayout, entries: [{ binding: 0, resource: { buffer: this.occlusionPassBuffer } }] });
    this.noOcclusion = device.createTexture({ label: 'no occlusion', size: [1, 1], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: this.noOcclusion }, new Uint8Array([255]), {}, [1, 1]);

    this.sceneLayout = device.createBindGroupLayout({
      label: 'game scene',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: 'cube' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
        { binding: 8, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
        { binding: 9, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    this.effectLayout = device.createBindGroupLayout({
      label: 'game effects',
      entries: [
        // the vertex stage reads the aspect out of it, the fragment the tint
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.compositeLayout = device.createBindGroupLayout({
      label: 'game composite',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    this.postLayout = device.createBindGroupLayout({
      label: 'game post',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    this.fogLayout = device.createBindGroupLayout({
      label: 'game fog',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
      ],
    });
    this.fogBlendLayout = device.createBindGroupLayout({
      label: 'game fog blend',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    this.fogBuffer = device.createBuffer({ label: 'fog', size: FOG_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.coneBuffer = device.createBuffer({ label: 'fog cones', size: SPOT_SHADOWS * CONE_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.postBuffer = device.createBuffer({ label: 'post', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.blurH = device.createBuffer({ label: 'blur across', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.blurV = device.createBuffer({ label: 'blur down', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.postSampler = device.createSampler({ label: 'post', magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

    // Every permutation is built up front, each with and without patterns and toon shading.
    // They compile in parallel with each other, and a ladder that had to wait
    // for a compile before it could step would step too late to matter.
    this.sceneLayoutPipeline = device.createPipelineLayout({ bindGroupLayouts: [this.sceneLayout] });
    const waits: Promise<unknown>[] = SCENE_VARIANTS.map((v) => {
      const module = shader(device, sceneSource(v), `game scene ${GameRenderer.key(v)}`);
      this.sceneModules.set(GameRenderer.key(v), module);
      return device.createRenderPipelineAsync(this.sceneDescriptor(v, module, 1))
        .then((p) => { this.scenePipelines.set(GameRenderer.key(v), p); });
    });

    // The depth pass: position and placement in, depth out, nothing else.
    // A slope-scaled bias in the rasteriser rather than in the lookup alone,
    // because the two together are what stop a flat floor shadowing itself
    // in stripes.
    const dp = shader(device, DEPTH_WGSL, 'shadow depth');
    waits.push(device.createRenderPipelineAsync({
      label: 'shadow depth',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.depthLayout] }),
      vertex: {
        module: dp, entryPoint: 'vsMain',
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
          INSTANCE_LAYOUT,
        ],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: SHADOW, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2 },
    }).then((p) => { this.depthPipeline = p; }));
    // the same pass for the occlusion, into the frame's depth format and with
    // no bias: this depth is looked at, not compared against
    waits.push(device.createRenderPipelineAsync({
      label: 'occlusion depth',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.depthLayout] }),
      vertex: {
        module: dp, entryPoint: 'vsMain',
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
          INSTANCE_LAYOUT,
        ],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: 'less' },
    }).then((p) => { this.occlusionDepthPipeline = p; }));
    waits.push(this.occlusion.ready);

    this.effectModule = shader(device, EFFECT_WGSL, 'game effects');
    waits.push(device.createRenderPipelineAsync(this.effectDescriptor(1)).then((p) => { this.effect = p; }));

    for (const [label, code, target] of [['game bright', BRIGHT_WGSL, HDR], ['game blur', BLUR_WGSL, HDR]] as const) {
      const m = shader(device, code, label);
      waits.push(device.createRenderPipelineAsync({
        label,
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.postLayout] }),
        vertex: { module: m, entryPoint: 'vsMain' },
        fragment: { module: m, entryPoint: 'fsMain', targets: [{ format: target }] },
        primitive: { topology: 'triangle-list' },
      }).then((p) => { if (label === 'game bright') this.bright = p; else this.blur = p; }));
    }

    const fogModule = shader(device, FOG_WGSL, 'game fog');
    waits.push(device.createRenderPipelineAsync({
      label: 'game fog',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.fogLayout] }),
      vertex: { module: fogModule, entryPoint: 'vsMain' },
      fragment: { module: fogModule, entryPoint: 'fsMain', targets: [{ format: HDR }] },
      primitive: { topology: 'triangle-list' },
    }).then((p) => { this.fogPipeline = p; }));

    // scattered light added, what got through multiplying what is there: the
    // frame is fogged in place, before the bloom reads it, so a lamp in the
    // mist blooms the mist and not the lamp it can no longer see
    const fogBlend = shader(device, FOG_BLEND_WGSL, 'game fog blend');
    waits.push(device.createRenderPipelineAsync({
      label: 'game fog blend',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.fogBlendLayout] }),
      vertex: { module: fogBlend, entryPoint: 'vsMain' },
      fragment: {
        module: fogBlend, entryPoint: 'fsMain',
        targets: [{
          format: HDR,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'src-alpha', operation: 'add' },
            alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    }).then((p) => { this.fogBlendPipeline = p; }));

    const comp = shader(device, COMPOSITE_WGSL, 'game composite');
    waits.push(device.createRenderPipelineAsync({
      label: 'game composite',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.compositeLayout] }),
      vertex: { module: comp, entryPoint: 'vsMain' },
      fragment: { module: comp, entryPoint: 'fsMain', targets: [{ format: ctx.format }] },
      primitive: { topology: 'triangle-list' },
    }).then((p) => { this.composite = p; }));

    waits.push(this.particles.ready);
    this.ready = Promise.all(waits).then(() => { this.compiled = true; });
  }

  private static key(v: SceneVariant, samples = 1) {
    return `${v.cullLights === false ? 'naive' : 'culled'}-${v.points === false ? 'sun' : 'points'}-${v.shadows === false ? 'flat' : 'shadowed'}${v.patterned ? '-patterned' : ''}${v.toon ? '-toon' : ''}${samples > 1 ? `-x${samples}` : ''}`;
  }

  /** A build of the scene shader as a pipeline, at one sample a pixel or several. */
  private sceneDescriptor(v: SceneVariant, module: GPUShaderModule, samples: number): GPURenderPipelineDescriptor {
    return {
      label: `game scene ${GameRenderer.key(v, samples)}`,
      layout: this.sceneLayoutPipeline,
      vertex: {
        module, entryPoint: 'vsMain',
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
          { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
          INSTANCE_LAYOUT,
          MATERIAL_LAYOUT,
          PATTERN_LAYOUT,
        ],
      },
      fragment: { module, entryPoint: 'fsMain', targets: [{ format: HDR }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: 'less' },
      multisample: { count: samples },
    };
  }

  /** The effect layers' pipeline, at one sample a pixel or several. */
  private effectDescriptor(samples: number): GPURenderPipelineDescriptor {
    const additive: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    };
    return {
      label: samples > 1 ? `game effects x${samples}` : 'game effects',
      layout: this.ctx.device.createPipelineLayout({ bindGroupLayouts: [this.effectLayout] }),
      vertex: { module: this.effectModule, entryPoint: 'vsMain' },
      fragment: { module: this.effectModule, entryPoint: 'fsMain', targets: [{ format: HDR, blend: additive }] },
      primitive: { topology: 'triangle-list' },
      // tested but never written: no layer may reject another
      depthStencil: { format: DEPTH, depthWriteEnabled: false, depthCompare: 'less-equal' },
      multisample: { count: samples },
    };
  }

  /**
   * Compiles whatever the look asks for that is not compiled yet, and
   * resolves when it is in: today, the antialiasing's builds, which are
   * made the first time a look asks for them and never before. `frame`
   * starts them itself and draws with what is compiled until they are in,
   * so a game that wants its first frame antialiased awaits this after
   * setting its look, as it awaits `ready`; one that does not is
   * antialiased a few frames in. Four samples a pixel compile everything
   * that draws into the scene again (the scene's builds, the effect layers,
   * the particles, the grass if there is any, and the fog's march), and
   * FXAA compiles one pass; with them in, the ladder steps between them in
   * a frame.
   */
  async prepare(): Promise<void> {
    await this.ready;
    this.askAntialias();
    await this.antialiasBuilt;
  }

  /** Starts the builds the look's antialiasing needs, each once; every other time, nothing. */
  private askAntialias() {
    const asked = Math.max(0, ANTIALIAS.indexOf(this.look.antialias ?? 'none'));
    if (asked <= this.antialiasAsked) return;
    this.antialiasAsked = asked;
    // FXAA as well as four samples, since the ladder steps down to it
    const builds = [this.buildFxaa()];
    if (ANTIALIAS[asked] === 'msaa') builds.push(this.buildMsaa());
    this.antialiasBuilt = Promise.all(builds).then(() => undefined);
  }

  /** What this frame is antialiased with: what the look asks, held to the economy's rung and to what has compiled. */
  private get antialiasing(): Antialias {
    const want = antialiasFor(this.look, this.economy);
    const grass = !this.grass?.live || this.grass.multisampled;
    if (want === 'msaa' && this.msaaCompiled && this.msaaColour && grass) return 'msaa';
    if (want !== 'none' && this.fxaaCompiled && this.shown) return 'fxaa';
    return 'none';
  }

  private buildMsaa(): Promise<void> {
    this.msaaBuild ??= this.compileMsaa();
    return this.msaaBuild;
  }

  private async compileMsaa() {
    const { device } = this.ctx;
    const waits: Promise<unknown>[] = SCENE_VARIANTS.map((v) =>
      device.createRenderPipelineAsync(this.sceneDescriptor(v, this.sceneModules.get(GameRenderer.key(v))!, SAMPLES))
        .then((p) => { this.scenePipelines.set(GameRenderer.key(v, SAMPLES), p); }));
    waits.push(device.createRenderPipelineAsync(this.effectDescriptor(SAMPLES)).then((p) => { this.effectMsaa = p; }));
    // the march reads the multisampled depth, which is a binding of another type
    this.fogMsaaLayout = device.createBindGroupLayout({
      label: 'game fog x4',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth', multisampled: true } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
      ],
    });
    const fog = shader(device, FOG_MSAA_WGSL, 'game fog x4');
    waits.push(device.createRenderPipelineAsync({
      label: 'game fog x4',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.fogMsaaLayout] }),
      vertex: { module: fog, entryPoint: 'vsMain' },
      fragment: { module: fog, entryPoint: 'fsMain', targets: [{ format: HDR }] },
      primitive: { topology: 'triangle-list' },
    }).then((p) => { this.fogMsaaPipeline = p; }));
    waits.push(this.particles.multisample(SAMPLES));
    if (this.grass) waits.push(this.grass.multisample(SAMPLES));
    await Promise.all(waits);
    this.msaaCompiled = true;
    this.makeMsaaTargets();
  }

  private buildFxaa(): Promise<void> {
    this.fxaaBuild ??= this.compileFxaa();
    return this.fxaaBuild;
  }

  private async compileFxaa() {
    const { device } = this.ctx;
    this.fxaaLayout = device.createBindGroupLayout({
      label: 'game fxaa',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    const m = shader(device, FXAA_WGSL, 'game fxaa');
    this.fxaaPipeline = await device.createRenderPipelineAsync({
      label: 'game fxaa',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.fxaaLayout] }),
      vertex: { module: m, entryPoint: 'vsMain' },
      fragment: { module: m, entryPoint: 'fsMain', targets: [{ format: this.ctx.format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.fxaaCompiled = true;
    this.makeFxaaTargets();
  }

  /**
   * The multisampled colour and depth at the frame's size, and the fog's
   * bind group over that depth: made once the builds are in, and again on a
   * resize. A kept frame's pair is dropped with them and made again when
   * `keep` is next drawn.
   */
  private makeMsaaTargets() {
    if (!this.msaaCompiled || !this.width || !this.fogMsaaLayout) return;
    const { device } = this.ctx;
    for (const t of [this.msaaColour, this.msaaDepth, this.msaaKeptColour, this.msaaKeptDepth]) t?.destroy();
    this.msaaKeptColour = this.msaaKeptDepth = null;
    const size = [this.width, this.height];
    // COPY_DST both, so a kept frame can be copied in
    this.msaaColour = device.createTexture({
      label: 'game colour x4', size, format: HDR, sampleCount: SAMPLES,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
    });
    this.msaaDepth = device.createTexture({
      label: 'game depth x4', size, format: DEPTH, sampleCount: SAMPLES,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.fogMsaaBind = device.createBindGroup({
      label: 'game fog x4', layout: this.fogMsaaLayout,
      entries: [
        { binding: 0, resource: this.msaaDepth.createView() },
        { binding: 1, resource: this.sunMap.createView() },
        { binding: 2, resource: this.shadowSampler },
        { binding: 3, resource: { buffer: this.fogBuffer } },
        { binding: 4, resource: { buffer: this.coneBuffer } },
        { binding: 5, resource: this.spotMaps.createView({ dimension: '2d-array' }) },
      ],
    });
    this.keptStaleMsaa = true;
  }

  /** The kept static half at four samples a pixel: made the first time `keep` is drawn with them, since a game that never keeps never needs it. */
  private makeMsaaKept() {
    if (this.msaaKeptColour) return;
    const { device } = this.ctx;
    const size = [this.width, this.height];
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC;
    this.msaaKeptColour = device.createTexture({ label: 'kept colour x4', size, format: HDR, sampleCount: SAMPLES, usage });
    this.msaaKeptDepth = device.createTexture({ label: 'kept depth x4', size, format: DEPTH, sampleCount: SAMPLES, usage });
    this.keptStaleMsaa = true;
  }

  /** What the composite draws into for FXAA to read, at the frame's size, and FXAA's bind group over it. */
  private makeFxaaTargets() {
    if (!this.fxaaCompiled || !this.width || !this.fxaaLayout) return;
    this.shown?.destroy();
    this.shown = this.ctx.device.createTexture({
      label: 'game shown', size: [this.width, this.height], format: this.ctx.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.fxaaBind = this.ctx.device.createBindGroup({
      label: 'game fxaa', layout: this.fxaaLayout,
      entries: [
        { binding: 0, resource: this.shown.createView() },
        { binding: 1, resource: this.postSampler },
      ],
    });
  }

  /** The environment the material reads: a prefiltered cube and the split-sum lookup. */
  setEnvironment(specular: GPUTexture, brdf: GPUTexture, mips: number) {
    this.maxLod = mips - 1;
    this.environment = { specular, brdf };
    this.bindScene();
    this.effectBind = this.ctx.device.createBindGroup({
      label: 'game effects',
      layout: this.effectLayout,
      entries: [
        { binding: 0, resource: { buffer: this.effectBuffer } },
        { binding: 1, resource: { buffer: this.quadBuffer } },
      ],
    });
  }

  /** The scene's bind group: made with the environment, and again whenever the occlusion's texture is. */
  private bindScene() {
    if (!this.environment) return;
    const { specular, brdf } = this.environment;
    this.sceneBind = this.ctx.device.createBindGroup({
      label: 'game scene',
      layout: this.sceneLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer } },
        { binding: 1, resource: specular.createView({ dimension: 'cube' }) },
        { binding: 2, resource: brdf.createView() },
        { binding: 3, resource: this.sampler },
        { binding: 4, resource: { buffer: this.lightBuffer } },
        { binding: 5, resource: { buffer: this.shadowBuffer } },
        { binding: 6, resource: this.sunMap.createView() },
        { binding: 7, resource: this.spotMaps.createView({ dimension: '2d-array' }) },
        { binding: 8, resource: this.shadowSampler },
        { binding: 9, resource: this.occlusion.view ?? this.noOcclusion.createView() },
      ],
    });
  }

  private upload(groups: GameGroup[]): Uploaded[] {
    const { device } = this.ctx;
    return groups.map((g) => {
      const capacity = g.matrices.length / 16;
      const instance = device.createBuffer({
        label: 'instances', size: Math.max(64, capacity * 64),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(instance, 0, g.matrices as Float32Array<ArrayBuffer>);
      const material = device.createBuffer({
        label: 'materials', size: Math.max(16, capacity * 16),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(material, 0, this.materialsFor(g, capacity));
      const pattern = device.createBuffer({
        label: 'patterns', size: Math.max(PATTERN_STRIDE * 4, capacity * PATTERN_STRIDE * 4),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      if (g.patterns) {
        const out = new Float32Array(Math.max(PATTERN_STRIDE, capacity * PATTERN_STRIDE));
        out.set(g.patterns.subarray(0, out.length));
        device.queue.writeBuffer(pattern, 0, out);
      }
      return {
        position: bufferFrom(device, g.mesh.positions, GPUBufferUsage.VERTEX, 'positions'),
        normal: bufferFrom(device, g.mesh.normals, GPUBufferUsage.VERTEX, 'normals'),
        index: bufferFrom(device, g.mesh.indices, GPUBufferUsage.INDEX, 'indices'),
        instance,
        material,
        pattern,
        patterned: !!g.patterns,
        indexCount: g.mesh.indices.length,
        capacity,
        count: Math.min(g.count ?? capacity, capacity),
      };
    });
  }

  /** A group's per-placement material, filled from whatever it named. */
  private materialsFor(g: GameGroup, capacity: number): Float32Array<ArrayBuffer> {
    if (g.materials) {
      const out = new Float32Array(Math.max(4, capacity * MATERIAL_STRIDE));
      out.set(g.materials.subarray(0, out.length));
      return out;
    }
    const [r, gr, b] = g.albedo ?? this.look.albedo;
    const rough = g.roughness ?? this.look.roughness;
    const out = new Float32Array(Math.max(4, capacity * MATERIAL_STRIDE));
    for (let i = 0; i < out.length; i += MATERIAL_STRIDE) out.set([r, gr, b, rough], i);
    return out;
  }

  private static release(groups: Uploaded[]) {
    for (const g of groups) {
      g.position.destroy(); g.normal.destroy(); g.index.destroy();
      g.instance.destroy(); g.material.destroy(); g.pattern.destroy();
    }
  }

  /** The arena: what does not move. Setting it makes any kept frame stale. */
  setStatic(groups: GameGroup[]) {
    GameRenderer.release(this.staticGroups);
    this.staticGroups = this.upload(groups);
    this.keptStale = true;
    this.keptStaleMsaa = true;
  }

  /** The movers. Their pool is fixed here; `move` writes into it afterwards. */
  setDynamic(groups: GameGroup[]) {
    GameRenderer.release(this.dynamicGroups);
    this.dynamicGroups = this.upload(groups);
  }

  /**
   * Write one group's matrices and nothing else.
   *
   * This is the whole point of a separate path. The still-life renderer's
   * `moveAll` marks the scene's bounds, its lights, its probe and its
   * shadows stale after every move, which is right for a piece being dragged
   * and costs 1.4 ms a frame at eight thousand placements. This costs 0.1,
   * because the things it would re-derive are the game's to know.
   *
   * One write for the whole pool: writing per placement was measured
   * eighteen times worse.
   */
  move(group: number, matrices: Float32Array, count?: number) {
    const g = this.dynamicGroups[group];
    if (!g) return;
    this.ctx.device.queue.writeBuffer(g.instance, 0, matrices as Float32Array<ArrayBuffer>, 0, Math.min(matrices.length, g.capacity * 16));
    if (count !== undefined) g.count = Math.max(0, Math.min(count, g.capacity));
  }

  /**
   * Write one dynamic group's colours and roughnesses, four floats a
   * placement, without touching where anything is. This is how a thing
   * flashes when it is hit.
   */
  tint(group: number, materials: Float32Array) {
    const g = this.dynamicGroups[group];
    if (!g) return;
    this.ctx.device.queue.writeBuffer(
      g.material, 0, materials as Float32Array<ArrayBuffer>,
      0, Math.min(materials.length, g.capacity * MATERIAL_STRIDE),
    );
  }

  /**
   * The live lights for this frame, and which of them — by index in the
   * pool, at most SPOT_SHADOWS of them, spotlights only — get a shadow map
   * rendered from where they stand. The pool is not touched: the layer each
   * shadowed light reads is written into a copy on its way to the GPU.
   */
  setLights(pool: LightPool, shadowed: number[] = []) {
    this.lightCount = Math.min(pool.count, this.lightCapacity);
    this.spots = [];
    if (!this.lightCount) return;
    const n = this.lightCount * LIGHT_STRIDE;
    if (this.lightScratch.length < n) this.lightScratch = new Float32Array(pool.data.length);
    const d = this.lightScratch;
    d.set(pool.data.subarray(0, n));
    for (let i = 0; i < n; i += LIGHT_STRIDE) d[i + 13] = -1;
    for (const index of shadowed) {
      if (this.spots.length >= SPOT_SHADOWS) break;
      if (index < 0 || index >= this.lightCount) continue;
      const o = index * LIGHT_STRIDE;
      // no cone, no frustum: an all-round light has no one map to render
      if (d[o + 11] <= -1.5) continue;
      d[o + 13] = this.spots.length;
      this.spots.push({
        position: [d[o], d[o + 1], d[o + 2]],
        direction: [d[o + 8], d[o + 9], d[o + 10]],
        outer: (Math.acos(Math.max(-1, Math.min(1, d[o + 11]))) * 180) / Math.PI,
        reach: d[o + 3],
        // and what it takes to throw a cone through the fog: what it puts
        // out, and the cone it puts it out in
        colour: [d[o + 4] * d[o + 7], d[o + 5] * d[o + 7], d[o + 6] * d[o + 7]],
        cosOuter: d[o + 11],
        cosInner: d[o + 12],
      });
    }
    this.ctx.device.queue.writeBuffer(this.lightBuffer, 0, d, 0, n);
  }

  /**
   * Where the sun's shadow map is fitted: a box round everything that may
   * cast or catch one, in world units. Null turns the sun's shadow off; the
   * sun still lights, and still has its diffuse term.
   */
  setSunShadow(box: Box | null) {
    this.sunBox = box;
  }

  /** The matrices the maps are rendered with, and the lookups read with. */
  private writeShadows() {
    const f = this.shadowData;
    const sun = f.subarray(0, 16);
    if (this.sunBox) sunShadowMatrix(sun, this.look.sunDir, this.sunBox);
    else sun.fill(0);
    // texel size, bias in depth units, on
    f[16] = 1 / SUN_MAP; f[17] = SUN_BIAS; f[18] = this.sunBox ? 1 : 0; f[19] = 0;
    for (let i = 0; i < SPOT_SHADOWS; i++) {
      const m = f.subarray(20 + i * 16, 36 + i * 16);
      const s = this.spots[i];
      if (s) spotShadowMatrix(m, s.position, s.direction, s.outer, s.reach, this.mm(SPOT_NEAR_MM));
      else m.fill(0);
    }
    const tail = 20 + SPOT_SHADOWS * 16;
    f[tail] = 1 / SPOT_MAP; f[tail + 1] = SPOT_BIAS; f[tail + 2] = this.spots.length; f[tail + 3] = this.look.spotSoftness;
    f[tail + 4] = this.mm(SPOT_NEAR_MM) * SPOT_TEXEL_ANGLE;
    const { queue } = this.ctx.device;
    queue.writeBuffer(this.shadowBuffer, 0, f);
    queue.writeBuffer(this.passBuffers[0], 0, f, 0, 16);
    for (let i = 0; i < this.spots.length; i++) queue.writeBuffer(this.passBuffers[1 + i], 0, f, 20 + i * 16, 16);
  }

  /** One shadow map: every group, from one matrix, depth only. */
  private renderShadow(encoder: GPUCommandEncoder, view: GPUTextureView, pass: number, label: string) {
    const rp = encoder.beginRenderPass({
      label,
      colorAttachments: [],
      depthStencilAttachment: { view, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    rp.setPipeline(this.depthPipeline);
    rp.setBindGroup(0, this.passBinds[pass]);
    for (const groups of [this.staticGroups, this.dynamicGroups]) {
      for (const g of groups) {
        if (!g.count) continue;
        rp.setVertexBuffer(0, g.position);
        rp.setVertexBuffer(1, g.instance);
        rp.setIndexBuffer(g.index, 'uint32');
        rp.drawIndexed(g.indexCount, g.count);
      }
    }
    if (pass === 0 && this.grassGrown && this.grass?.casts) this.grass.drawShadow(rp);
    rp.end();
  }

  /**
   * The effect layers for this frame, `EFFECT_STRIDE` floats each: centre x
   * and y in clip space, half-size, brightness, colour, and how hard the edge
   * falls off. They are additive and depth-tested but never depth-writing, so
   * the order among them does not matter.
   */
  setEffects(quads: Float32Array<ArrayBuffer>, count: number) {
    this.effectQuads = Math.min(count, this.effectCapacity);
    if (this.effectQuads) this.ctx.device.queue.writeBuffer(this.quadBuffer, 0, quads, 0, this.effectQuads * EFFECT_STRIDE);
  }
  private effectQuads = 0;

  /** A burst of particles this frame: smoke, spray, sparks. See `particles.ts`. */
  emit(e: Emit): boolean {
    return this.particles.emit(e);
  }

  /**
   * The sprites to draw from now on, `SPRITE_STRIDE` floats each: soft puffs
   * the game places itself, where particles are born and aged on the GPU and
   * move only when a frame is drawn. Drawn with the particles, and with them
   * given up when the ladder turns particles off.
   */
  setSprites(data: Float32Array, count: number) {
    this.particles.setSprites(data, count);
  }

  /** How many sprites a frame may have. */
  get spriteCapacity(): number {
    return this.particles.spriteCapacity;
  }

  /** A tint over every effect layer at once. White leaves them as they are. */
  setEffectTint(colour: [number, number, number]) {
    this.effectUniform.set(colour, 0);
    this.ctx.device.queue.writeBuffer(this.effectBuffer, 0, this.effectUniform);
  }

  /**
   * The frame before the tone map, and the bloom thrown from it, for a test
   * or a capture to read back: half floats both, and what the composite is
   * handed. A half float holds nothing past 65504, and what is written past
   * it is infinity, which the blur then spreads; so what is in these is worth
   * being able to look at. Null before the first `resize`.
   */
  get hdr(): { colour: GPUTexture | null; bloom: GPUTexture | null } {
    return { colour: this.colour, bloom: this.bloomA };
  }

  resize(width: number, height: number) {
    width = Math.max(1, Math.floor(width));
    height = Math.max(1, Math.floor(height));
    if (width === this.width && height === this.height) return;
    this.width = width; this.height = height;
    this.camera.aspect = width / height;
    this.effectUniform[3] = width / height;
    this.ctx.device.queue.writeBuffer(this.effectBuffer, 0, this.effectUniform);
    const { device } = this.ctx;
    for (const t of [this.colour, this.depth, this.keptColour, this.keptDepth]) t?.destroy();
    const both = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    // COPY_SRC so the frame before the tone map can be read back: see `hdr`
    this.colour = device.createTexture({ label: 'game colour', size: [width, height], format: HDR, usage: both | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC });
    // TEXTURE_BINDING because the fog reads it: a march has to know where
    // the scene stopped it
    this.depth = device.createTexture({ label: 'game depth', size: [width, height], format: DEPTH, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
    this.keptColour = device.createTexture({ label: 'kept colour', size: [width, height], format: HDR, usage: both | GPUTextureUsage.COPY_SRC });
    this.keptDepth = device.createTexture({ label: 'kept depth', size: [width, height], format: DEPTH, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    // The fog, at half the frame each way: enough for something with no
    // edges, a quarter of the marching.
    this.fogMap?.destroy();
    const fw = Math.max(1, Math.ceil(width / 2)), fh = Math.max(1, Math.ceil(height / 2));
    this.fogMap = device.createTexture({ label: 'fog', size: [fw, fh], format: HDR, usage: both });
    this.fogBind = device.createBindGroup({
      label: 'game fog', layout: this.fogLayout,
      entries: [
        { binding: 0, resource: this.depth.createView() },
        { binding: 1, resource: this.sunMap.createView() },
        { binding: 2, resource: this.shadowSampler },
        { binding: 3, resource: { buffer: this.fogBuffer } },
        { binding: 4, resource: { buffer: this.coneBuffer } },
        { binding: 5, resource: this.spotMaps.createView({ dimension: '2d-array' }) },
      ],
    });
    this.fogBlendBind = device.createBindGroup({
      label: 'game fog blend', layout: this.fogBlendLayout,
      entries: [
        { binding: 0, resource: this.fogMap.createView() },
        { binding: 1, resource: this.postSampler },
      ],
    });

    // The bloom textures, a quarter of the frame each way, and every bind
    // group that reads the frame or them: remade with the frame.
    for (const t of [this.bloomA, this.bloomB]) t?.destroy();
    const bw = Math.max(1, Math.ceil(width / 4)), bh = Math.max(1, Math.ceil(height / 4));
    this.bloomA = device.createTexture({ label: 'bloom a', size: [bw, bh], format: HDR, usage: both | GPUTextureUsage.COPY_SRC });
    this.bloomB = device.createTexture({ label: 'bloom b', size: [bw, bh], format: HDR, usage: both });
    device.queue.writeBuffer(this.blurH, 0, new Float32Array([1, 0, 1 / bw, 1 / bh]));
    device.queue.writeBuffer(this.blurV, 0, new Float32Array([0, 1, 1 / bw, 1 / bh]));
    this.brightBind = device.createBindGroup({
      label: 'game bright', layout: this.postLayout,
      entries: [
        { binding: 0, resource: this.colour.createView() },
        { binding: 1, resource: this.postSampler },
        { binding: 2, resource: { buffer: this.postBuffer } },
      ],
    });
    this.blurBindA = device.createBindGroup({
      label: 'game blur across', layout: this.postLayout,
      entries: [
        { binding: 0, resource: this.bloomA.createView() },
        { binding: 1, resource: this.postSampler },
        { binding: 2, resource: { buffer: this.blurH } },
      ],
    });
    this.blurBindB = device.createBindGroup({
      label: 'game blur down', layout: this.postLayout,
      entries: [
        { binding: 0, resource: this.bloomB.createView() },
        { binding: 1, resource: this.postSampler },
        { binding: 2, resource: { buffer: this.blurV } },
      ],
    });
    this.occlusion.resize(width, height);
    this.bindScene();
    this.compositeBind = device.createBindGroup({
      label: 'game composite', layout: this.compositeLayout,
      entries: [
        { binding: 0, resource: this.colour.createView() },
        { binding: 1, resource: this.bloomA.createView() },
        { binding: 2, resource: this.postSampler },
        { binding: 3, resource: { buffer: this.postBuffer } },
      ],
    });
    this.keptStale = true;
    // and the antialiasing's own, if it has been asked for
    this.makeMsaaTargets();
    this.makeFxaaTargets();
  }

  private writeFrame() {
    const f = this.frameData;
    this.camera.update();
    f.set(this.camera.viewProjection, 0);
    f.set(this.camera.position, 16); f[19] = this.look.exposure;
    f.set(this.look.sunDir, 20); f[23] = this.maxLod;
    f.set(this.look.sunColour, 24); f[27] = this.look.falloffHalf;
    // what used to be the fallback albedo, which the shader never read: how
    // much of the occlusion the lights take, and whether there is any to read
    f[28] = Math.max(0, Math.min(1, this.look.occlusionDirect));
    f[29] = this.occlusionOn ? 1 : 0;
    f[30] = this.look.ambient;
    f[31] = this.economy.points === false ? 0 : this.lightCount;
    toonUniform(f, this.look, 32);
    this.ctx.device.queue.writeBuffer(this.frameBuffer, 0, f);
  }

  private get occlusionOn(): boolean {
    return this.economy.occlusion !== false && this.look.occlusion > 0 && !!this.occlusionDepthPipeline;
  }

  private get clearValue(): GPUColor {
    const [r, g, b] = this.look.background;
    return { r, g, b, a: 1 };
  }

  private scenePipeline(patterned: boolean, samples: number) {
    return this.scenePipelines.get(GameRenderer.key({ ...this.economy, patterned, toon: this.look.shading === 'toon' }, samples));
  }

  private draw(pass: GPURenderPassEncoder, groups: Uploaded[], samples = 1) {
    const plain = this.scenePipeline(false, samples);
    const patterned = this.scenePipeline(true, samples);
    if (!plain || !patterned || !this.sceneBind) return;
    pass.setBindGroup(0, this.sceneBind);
    // the pipeline set only where it changes, which for a game's groups, the patterned few among the plain, is rarely
    let on: GPURenderPipeline | null = null;
    for (const g of groups) {
      if (!g.count) continue;
      const want = g.patterned ? patterned : plain;
      if (want !== on) {
        pass.setPipeline(want);
        on = want;
      }
      pass.setVertexBuffer(0, g.position);
      pass.setVertexBuffer(1, g.normal);
      pass.setVertexBuffer(2, g.instance);
      pass.setVertexBuffer(3, g.material);
      pass.setVertexBuffer(4, g.pattern);
      pass.setIndexBuffer(g.index, 'uint32');
      pass.drawIndexed(g.indexCount, g.count);
    }
  }

  /** Draw the static half once into the kept pair for this many samples a pixel, for `keep` to start from. */
  private bakeKept(encoder: GPUCommandEncoder, samples = 1) {
    const colour = samples > 1 ? this.msaaKeptColour : this.keptColour;
    const depth = samples > 1 ? this.msaaKeptDepth : this.keptDepth;
    if (!colour || !depth) return;
    const pass = encoder.beginRenderPass({
      label: 'game static',
      colorAttachments: [{ view: colour.createView(), loadOp: 'clear', storeOp: 'store', clearValue: this.clearValue }],
      depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    this.draw(pass, this.staticGroups, samples);
    pass.end();
    if (samples > 1) this.keptStaleMsaa = false;
    else this.keptStale = false;
  }

  /**
   * One frame into `target`. Returns whether it drew: before the pipelines
   * have compiled, or without an environment, it does not.
   */
  frame(target: GPUTextureView, mode: FrameMode = 'redraw', dt = 1 / 60): boolean {
    const { device } = this.ctx;
    if (!this.compiled || !this.sceneBind || !this.compositeBind || !this.colour || !this.depth) return false;
    this.writeFrame();
    // what the frame is antialiased with: the look's ask, held to the rung and to what has compiled
    this.askAntialias();
    const aa = this.antialiasing;
    const samples = aa === 'msaa' ? SAMPLES : 1;
    const multisampled = samples > 1;
    const encoder = device.createCommandEncoder({ label: 'game frame' });

    // The grass grown first: the sun's map may want its blades, and the scene pass does.
    const density = Math.max(0, Math.min(1, this.economy.grass ?? 1));
    const wind = this.economy.wind === false ? STILL : this.wind;
    this.grassGrown = !!this.grass?.live && this.grass.grow(encoder, this.camera, this.height, density, wind, this.time);
    // Four samples a pixel are drawn into their own colour and depth and
    // resolved into the frame's colour at the end of the scene pass, which
    // is what everything after it reads; the fog reads their depth.
    const colourView = this.colour.createView();
    const sceneView = multisampled ? this.msaaColour!.createView() : colourView;
    const depthView = (multisampled ? this.msaaDepth! : this.depth).createView();

    // The maps first, so the scene pass can read them. Every frame: the sun
    // moves, the trucks move, and a map of where things were is a shadow of
    // where they are not.
    if (this.economy.shadows !== false && this.depthPipeline) {
      this.writeShadows();
      if (this.sunBox) this.renderShadow(encoder, this.sunMap.createView(), 0, 'sun shadow');
      for (let i = 0; i < this.spots.length; i++) {
        const view = this.spotMaps.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 });
        this.renderShadow(encoder, view, 1 + i, `spot shadow ${i}`);
      }
    }

    // The occlusion, before the scene pass that reads it: everything's depth
    // from the camera, static and dynamic alike whatever the mode, and the
    // occlusion worked out from that.
    if (this.occlusionOn && this.occlusion.depthView) {
      device.queue.writeBuffer(this.occlusionPassBuffer, 0, this.camera.viewProjection as Float32Array<ArrayBuffer>);
      const prepass = encoder.beginRenderPass({
        label: 'occlusion depth',
        colorAttachments: [],
        depthStencilAttachment: { view: this.occlusion.depthView, depthLoadOp: 'clear', depthClearValue: 1, depthStoreOp: 'store' },
      });
      prepass.setPipeline(this.occlusionDepthPipeline);
      prepass.setBindGroup(0, this.occlusionPassBind);
      for (const g of [...this.staticGroups, ...this.dynamicGroups]) {
        if (!g.count) continue;
        prepass.setVertexBuffer(0, g.position);
        prepass.setVertexBuffer(1, g.instance);
        prepass.setIndexBuffer(g.index, 'uint32');
        prepass.drawIndexed(g.indexCount, g.count);
      }
      prepass.end();
      this.occlusion.radius = this.look.occlusionRadius;
      this.occlusion.strength = this.look.occlusion;
      const { camera } = this;
      this.occlusion.run(encoder, { fovY: (camera.fov * Math.PI) / 180, aspect: camera.aspect, near: camera.near, far: camera.far, shift: camera.shift });
    }

    if (mode === 'keep' && multisampled) {
      // the kept pair at four samples, copied whole into the frame's own
      this.makeMsaaKept();
      if (this.keptStaleMsaa) this.bakeKept(encoder, samples);
      const size = { width: this.width, height: this.height, depthOrArrayLayers: 1 };
      encoder.copyTextureToTexture({ texture: this.msaaKeptColour! }, { texture: this.msaaColour! }, size);
      encoder.copyTextureToTexture({ texture: this.msaaKeptDepth! }, { texture: this.msaaDepth! }, size);
    } else if (mode === 'keep') {
      if (this.keptStale) this.bakeKept(encoder);
      const size = { width: this.width, height: this.height, depthOrArrayLayers: 1 };
      encoder.copyTextureToTexture({ texture: this.keptColour! }, { texture: this.colour }, size);
      encoder.copyTextureToTexture({ texture: this.keptDepth! }, { texture: this.depth }, size);
    }

    // the particles move before the scene is drawn, so what is drawn is
    // where they are now
    const particles = this.economy.particles !== false;
    if (particles) this.particles.simulate(encoder, dt, this.camera, this.gravity);

    const pass = encoder.beginRenderPass({
      label: 'game scene',
      colorAttachments: [multisampled ? {
        view: sceneView,
        resolveTarget: colourView,
        loadOp: mode === 'keep' ? 'load' : 'clear',
        // nothing reads the samples once they are resolved
        storeOp: 'discard',
        clearValue: this.clearValue,
      } : {
        view: colourView,
        loadOp: mode === 'keep' ? 'load' : 'clear',
        storeOp: 'store',
        clearValue: this.clearValue,
      }],
      depthStencilAttachment: {
        view: depthView,
        depthLoadOp: mode === 'keep' ? 'load' : 'clear',
        depthClearValue: 1,
        depthStoreOp: 'store',
      },
    });
    if (mode === 'redraw') this.draw(pass, this.staticGroups, samples);
    this.draw(pass, this.dynamicGroups, samples);
    // the grass moves every frame, so it is drawn with the movers and never kept with the static half
    if (this.grassGrown) this.grass!.draw(pass, this.sceneBind, { ...this.economy, toon: this.look.shading === 'toon' }, samples);
    if (particles) this.particles.draw(pass, samples);
    const layers = Math.round(this.effectQuads * Math.max(0, Math.min(1, this.economy.effects)));
    if (layers && this.effectBind) {
      pass.setPipeline(multisampled ? this.effectMsaa! : this.effect);
      pass.setBindGroup(0, this.effectBind);
      pass.draw(6, layers);
    }
    pass.end();

    // The fog, over the frame, before any of the post chain sees it. It
    // needs the sun's map, which the shadow block above has just drawn, and
    // the depth the scene pass has just written.
    if (this.economy.fog !== false && this.fog.density > 0 && this.fogPipeline && this.fogBlendPipeline && this.fogMap) {
      const shadowed = this.economy.shadows !== false && this.sunBox !== null;
      // The cones: the shadowed spots, each with its own map's matrix, so
      // the march can light the air from them and cut what stands in the
      // way. None of it is written when the game asks for no cones.
      const lit = this.fog.cones > 0 && this.economy.shadows !== false ? this.spots.length : 0;
      for (let i = 0; i < lit; i++) {
        const s = this.spots[i];
        const o = i * CONE_FLOATS;
        this.coneData.set(this.shadowData.subarray(20 + i * 16, 36 + i * 16), o);
        this.coneData.set(s.position, o + 16); this.coneData[o + 19] = s.reach;
        this.coneData.set(s.direction, o + 20); this.coneData[o + 23] = s.cosOuter;
        this.coneData.set(s.colour, o + 24); this.coneData[o + 27] = s.cosInner;
        this.coneData[o + 28] = i;
      }
      if (lit) device.queue.writeBuffer(this.coneBuffer, 0, this.coneData, 0, lit * CONE_FLOATS);
      fogUniform(
        this.fogData, this.fog, this.camera,
        shadowed ? this.shadowData.subarray(0, 16) : null,
        this.look.sunDir, this.look.sunColour, FOG_BIAS, this.postTime,
        lit, this.look.falloffHalf, SPOT_BIAS, 1 / SPOT_MAP,
      );
      device.queue.writeBuffer(this.fogBuffer, 0, this.fogData);
      const march = encoder.beginRenderPass({
        label: 'game fog',
        colorAttachments: [{ view: this.fogMap.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      });
      march.setPipeline(multisampled ? this.fogMsaaPipeline! : this.fogPipeline);
      march.setBindGroup(0, multisampled ? this.fogMsaaBind! : this.fogBind!);
      march.draw(3);
      march.end();

      const over = encoder.beginRenderPass({
        label: 'game fog blend',
        colorAttachments: [{ view: colourView, loadOp: 'load', storeOp: 'store' }],
      });
      over.setPipeline(this.fogBlendPipeline);
      over.setBindGroup(0, this.fogBlendBind!);
      over.draw(3);
      over.end();
    }

    // The post chain. With the rung off, or bloom at nothing, the bloom
    // passes are skipped and the composite is told to add none of it; the
    // vignette and the grain are likewise nothing when the rung is off.
    const doPost = this.economy.post !== false;
    const bloomOn = doPost && this.post.bloom > 0 && this.bright && this.blur && this.bloomA && this.bloomB;
    this.postTime += dt;
    const pd = this.postData;
    pd[0] = bloomOn ? this.post.bloom : 0; pd[1] = this.post.threshold; pd[2] = this.post.knee;
    pd[3] = doPost ? this.post.vignette : 0; pd[4] = doPost ? this.post.grain : 0; pd[5] = this.postTime;
    pd[6] = 1 / this.width; pd[7] = 1 / this.height; pd[8] = this.post.tone === 'clamp' ? 1 : 0;
    device.queue.writeBuffer(this.postBuffer, 0, pd);
    if (bloomOn) {
      const steps: [GPURenderPipeline, GPUBindGroup, GPUTexture, string][] = [
        [this.bright, this.brightBind!, this.bloomA!, 'game bright'],
        [this.blur, this.blurBindA!, this.bloomB!, 'game blur across'],
        [this.blur, this.blurBindB!, this.bloomA!, 'game blur down'],
      ];
      for (const [pipeline, bind, out, label] of steps) {
        const rp = encoder.beginRenderPass({
          label,
          colorAttachments: [{ view: out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
        });
        rp.setPipeline(pipeline);
        rp.setBindGroup(0, bind);
        rp.draw(3);
        rp.end();
      }
    } else if (this.bloomA) {
      // nothing to add: the composite reads a cleared texture
      const rp = encoder.beginRenderPass({
        label: 'game bloom clear',
        colorAttachments: [{ view: this.bloomA.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      });
      rp.end();
    }

    // With FXAA, the composite draws the frame as shown into a texture of
    // its own, and FXAA draws it again into the target, smoothed.
    const fxaa = aa === 'fxaa';
    const post = encoder.beginRenderPass({
      label: 'game composite',
      colorAttachments: [{ view: fxaa ? this.shown!.createView() : target, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    post.setPipeline(this.composite);
    post.setBindGroup(0, this.compositeBind);
    post.draw(3);
    post.end();
    if (fxaa) {
      const smooth = encoder.beginRenderPass({
        label: 'game fxaa',
        colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      });
      smooth.setPipeline(this.fxaaPipeline!);
      smooth.setBindGroup(0, this.fxaaBind!);
      smooth.draw(3);
      smooth.end();
    }

    device.queue.submit([encoder.finish()]);
    return true;
  }

  /**
   * The grass to grow: a field of it (see `grass.ts`), replacing any other,
   * or null for none, which destroys everything the last one made. The
   * first call compiles the grass's pipelines, which a game that never
   * asks for grass never pays for; the promise resolves when they are in,
   * and until then the frame is drawn without it. A field that cannot be
   * what it says throws here.
   */
  async setGrass(field: GrassField | null, options: GrassOptions = {}): Promise<void> {
    if (!field) {
      this.grass?.clear();
      return;
    }
    checkField(field, options);
    this.grass ??= new GrassPass(this.ctx, this.sceneLayout, HDR, DEPTH, SHADOW);
    this.grass.setField(field, options, this.passBuffers[0]);
    await this.grass.ready;
    // drawn into four samples a pixel as well, once a look has asked for them
    if (this.antialiasAsked >= ANTIALIAS.indexOf('msaa')) await this.grass.multisample(SAMPLES);
  }

  /**
   * Press the grass down in a disc of `radius` at (x, y), the blades lying
   * toward (dx, dy), at the renderer's `time`: full inside half the radius,
   * softening to nothing at it, and standing again over the trample's
   * recovery. Nothing is kept but the trample's own fixed grid, so a ball
   * can press every frame for ever. False, and nothing done, where the
   * field has no trample, off it, or past 64 presses in a frame.
   */
  press(x: number, y: number, radius: number, dx: number, dy: number): boolean {
    return this.grass?.press(x, y, radius, dx, dy, this.time) ?? false;
  }

  /** Nothing pressed anywhere, for a new hole: the grass stands as it was. */
  clearPresses() {
    this.grass?.clearPresses();
  }

  /** How many blades of grass the last frame drew, near and far, read back from the GPU: for a test or a gate. */
  async grassDrawn(): Promise<{ near: number; far: number }> {
    return this.grass ? this.grass.drawn() : { near: 0, far: 0 };
  }

  /** The blades of grass the last frame drew, read back from the GPU: for a test. */
  async grassBlades(): Promise<{ near: DrawnBlade[]; far: DrawnBlade[] }> {
    return this.grass ? this.grass.blades() : { near: [], far: [] };
  }

  dispose() {
    GameRenderer.release(this.staticGroups);
    GameRenderer.release(this.dynamicGroups);
    for (const t of [this.colour, this.depth, this.keptColour, this.keptDepth, this.sunMap, this.spotMaps, this.bloomA, this.bloomB, this.fogMap]) t?.destroy();
    for (const t of [this.msaaColour, this.msaaDepth, this.msaaKeptColour, this.msaaKeptDepth, this.shown]) t?.destroy();
    for (const b of [this.frameBuffer, this.lightBuffer, this.effectBuffer, this.quadBuffer, this.shadowBuffer, this.postBuffer, this.blurH, this.blurV, this.fogBuffer, this.coneBuffer, ...this.passBuffers]) b.destroy();
    this.particles.dispose();
    this.grass?.dispose();
    this.occlusion.dispose();
    this.noOcclusion.destroy();
    this.occlusionPassBuffer.destroy();
  }
}
