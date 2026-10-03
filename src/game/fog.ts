/**
 * Fog with a volume: a ray marched through it, lit by the sun, shadowed by
 * whatever the sun's shadow map already knows is in the way.
 *
 * Ordinary distance fog is a lerp toward grey by depth, and it cannot do the
 * two things fog is worth having for — lying in the hollows and taking the
 * shape of what stands in the light. This marches the view ray instead, and
 * at every step asks the density (an exponential falloff over a height, so
 * it pools in the low ground) and the sun's shadow map (so a tree throws a
 * shaft rather than a stripe on the floor). It is single scattering: light
 * arrives from the sun, bounces once toward the eye, and is not traced
 * further. That is the standard cheat and it is the right one — the second
 * bounce in a thin mist is a brightening, and the ambient term is already
 * that brightening.
 *
 * The maths that sets up a march is here, on the CPU, because it is the part
 * worth testing without a device: the camera's basis, the projection the
 * depth buffer was written with, and the packing the shader reads.
 */

import type { Camera } from '../gpu/camera';
import type { Vec3 } from '../geom/types';

export interface Fog {
  /**
   * Extinction per world unit at the base height: how much of a beam is
   * taken out of it per unit travelled. Zero is no fog, and costs nothing —
   * the passes are skipped. The useful range is small, because a world unit
   * is small: at 2e-5 a beam is down to half over 35 000 units.
   *
   * It is the one number here that is per length rather than a length, so it
   * scales the other way: the same mist described in metres instead of
   * millimetres has a density a thousand times larger, not smaller. `noFog`
   * converts, and everything else in this record is a length in the caller's
   * own units.
   */
  density: number;
  /** The world Z the fog is thickest at, and below which it does not thicken. */
  base: number;
  /** How far above `base` the density is down to a third: the depth of the layer. */
  height: number;
  /** What the fog scatters — its albedo, and so its colour. */
  colour: [number, number, number];
  /** How much of the sky the fog takes, on top of what the sun gives it. */
  ambient: number;
  /**
   * Forward scattering, -1 to 1. Over zero the fog glows where the sun is
   * behind what you are looking at, which is the whole reason a shaft of
   * light is visible; 0.6 is a mist, 0 is a uniform haze.
   */
  anisotropy: number;
  /** How far along the ray the march goes, in world units, when nothing stops it. */
  reach: number;
  /** Steps along the ray. More is smoother and dearer; the start is dithered. */
  steps: number;
  /**
   * How much the shadowed spotlights scatter in the fog — a cone in the air
   * under every lamp that carries a map, cut by whatever stands in it. Zero
   * is none, and skips the loop. The lights are whichever ones were handed
   * to `setLights` as shadowed: a light with no map casts no cone, because a
   * cone that shines through a tree is worse than no cone.
   */
  cones: number;
}

/**
 * No fog at all: the passes are skipped and the frame is untouched. Its
 * lengths are millimetres, which is the unit the library was written in; for
 * a world in anything else use `noFog`.
 */
export const NO_FOG: Fog = {
  density: 0, base: 0, height: 1000, colour: [1, 1, 1],
  ambient: 0.2, anisotropy: 0.6, reach: 6000, steps: 24, cones: 1,
};

/**
 * `NO_FOG` in the caller's units: `mmPerUnit` millimetres to a world unit, as
 * the renderer was given. A metre-scale world gets a layer a metre deep and
 * six metres of reach rather than a thousand and six thousand of them.
 */
export function noFog(mmPerUnit = 1): Fog {
  return {
    ...NO_FOG,
    density: NO_FOG.density * mmPerUnit,
    base: NO_FOG.base / mmPerUnit,
    height: NO_FOG.height / mmPerUnit,
    reach: NO_FOG.reach / mmPerUnit,
  };
}

/**
 * The floor under every length that ends up a divisor here. It is small
 * enough to be nothing in any unit a world might be in — a micrometre, in
 * metres — because its only job is to keep a division finite. It was one
 * world unit, which silently rounded a half-metre falloff up to a metre in a
 * world measured in metres.
 */
const TINY = 1e-6;

/** Floats in the fog uniform: a matrix, seven vec4-aligned rows, four tails. */
export const FOG_FLOATS = 60;

/** Floats a cone takes: its shadow matrix, then four vec4s of light. */
export const CONE_FLOATS = 32;

/**
 * Pack everything a march needs into the uniform the shader reads.
 *
 * The camera goes in as a basis rather than a matrix to invert. A ray
 * through a pixel is `right * vx + up * vy - back`, built so its view-space
 * z is exactly -1: a point at view depth d is then `camPos + ray * d`, and
 * the depth buffer holds d through the projection the camera used, so the
 * march runs in the same units the depth is in with no inverse anywhere.
 */
export function fogUniform(
  out: Float32Array, fog: Fog, camera: Camera,
  sun: Float32Array | null, sunDir: Vec3, sunColour: Vec3,
  bias: number, time: number,
  cones = 0, falloffHalf = 50, spotBias = 0, spotTexel = 0,
): Float32Array {
  if (sun) out.set(sun, 0); else out.fill(0, 0, 16);
  const v = camera.view;
  out[16] = camera.position[0]; out[17] = camera.position[1]; out[18] = camera.position[2];
  out[19] = camera.near;
  // rows of the view are the camera's axes: right, up, and the way it came from
  out[20] = v[0]; out[21] = v[4]; out[22] = v[8]; out[23] = camera.far;
  out[24] = v[1]; out[25] = v[5]; out[26] = v[9];
  out[27] = Math.tan((camera.fov * Math.PI) / 360);
  out[28] = v[2]; out[29] = v[6]; out[30] = v[10]; out[31] = camera.aspect;
  const l = Math.hypot(sunDir[0], sunDir[1], sunDir[2]) || 1;
  out[32] = sunDir[0] / l; out[33] = sunDir[1] / l; out[34] = sunDir[2] / l;
  out[35] = Math.max(fog.density, 0);
  out[36] = sunColour[0]; out[37] = sunColour[1]; out[38] = sunColour[2];
  out[39] = Math.max(fog.height, TINY);
  out[40] = fog.colour[0]; out[41] = fog.colour[1]; out[42] = fog.colour[2];
  out[43] = fog.base;
  out[44] = camera.shift[0]; out[45] = camera.shift[1];
  out[46] = Math.max(1, Math.round(fog.steps)); out[47] = Math.min(0.95, Math.max(-0.95, fog.anisotropy));
  out[48] = Math.max(fog.reach, TINY); out[49] = Math.max(fog.ambient, 0);
  out[50] = bias; out[51] = sun ? 1 : 0;
  out[52] = time;
  out[53] = Math.max(0, cones);
  out[54] = Math.max(falloffHalf, TINY);
  out[55] = spotBias;
  out[56] = Math.max(fog.cones, 0);
  out[57] = spotTexel;
  return out;
}

/**
 * The fog's record as the shader reads it, shared by the march, and by the
 * particles and sprites that are fogged by their own distance
 * (`GameRenderer.particleFog`), so that every one of them reads the very
 * uniform `fogUniform` packs, and a field moved here is moved for all.
 */
export const FOG_STRUCT_WGSL = `struct Fog {
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
`;

/** The phase function of the march and of the closed form, in WGSL: `fogPhase` is its TypeScript. */
export const FOG_PHASE_WGSL = `/**
 * Henyey-Greenstein, scaled so that g of zero is exactly one: how much of
 * the light coming from the sun leaves in the direction of the eye. Over
 * zero it peaks looking toward the sun, which is where a mist glows.
 */
fn phase(c: f32, g: f32) -> f32 {
  let g2 = g * g;
  let d = 1.0 + g2 - 2.0 * g * c;
  return (1.0 - g2) / max(pow(max(d, 1e-4), 1.5), 1e-4);
}
`;

/** The HG phase function the march and `fogAhead` scatter the sun with: see `FOG_PHASE_WGSL`. */
export function fogPhase(c: number, g: number): number {
  const g2 = g * g;
  const d = 1 + g2 - 2 * g * c;
  return (1 - g2) / Math.max(Math.pow(Math.max(d, 1e-4), 1.5), 1e-4);
}

/**
 * The rise of a ray, over the layer's depth, under which it is counted level.
 * The integral is then taken at the middle of the ray with its second-order
 * correction, since the closed form divides by the rise, and a float cannot
 * take the difference of two nearly equal exponentials.
 */
const LEVEL = 0.01;

/**
 * The optical depth of the layer along a straight ray: the integral of the
 * density from the eye to a distance along it, for a ray that starts `z0`
 * up in the world, climbs `slope` a unit of distance (its z component, from
 * -1 to 1), and goes `distance`.
 *
 * The march in `FOG_WGSL` steps through exactly this density, which is
 * flat at `density` below `base` and falls off as an exponential over
 * `height` above it, and an exponential along a straight line integrates in
 * closed form. A ray that crosses the base is cut there: flat below, and
 * exponential above. A ray that is level, or all but, would divide by nothing,
 * so its exponential is taken at its middle.
 *
 * It leaves out what the march adds on top, the taper of the density over the
 * last third of the reach (`REACH_FADE`), which has no closed form with the
 * exponential. `fogAhead` stops at the reach instead.
 */
export function opticalDepth(fog: Fog, z0: number, slope: number, distance: number): number {
  const density = Math.max(fog.density, 0), height = Math.max(fog.height, TINY);
  if (!(distance > 0) || density === 0) return 0;
  const hA = z0 - fog.base, hB = hA + slope * distance;
  if (hA <= 0 && hB <= 0) return density * distance;
  // the stretch above the base: the whole ray, or the part of it past the crossing
  let from = 0, to = distance;
  if (hA < 0) from = -hA / slope;
  if (hB < 0) to = -hA / slope;
  const below = distance - (to - from);
  const ha = Math.max(hA + slope * from, 0), hb = Math.max(hA + slope * to, 0);
  const x = (hb - ha) / height;
  const above = Math.abs(x) < LEVEL
    ? (to - from) * Math.exp(-(ha + hb) / (2 * height)) * (1 + (x * x) / 24)
    : ((to - from) * (Math.exp(-ha / height) - Math.exp(-hb / height))) / x;
  return density * (below + above);
}

/** What a fogged thing is given: the share of its own light that gets through, and the light the fog adds in front of it. */
export interface FogAhead {
  through: number;
  scattered: [number, number, number];
}

/**
 * The fog between the eye and a point, in closed form, for something drawn
 * with no depth of its own: `through` is exp of minus the optical depth along
 * the ray, and `scattered` is what the fog sends toward the eye over that
 * distance, which for light that does not change along the ray is its colour
 * times (the ambient plus the sun's through the phase function), times what
 * the fog took, one less `through`.
 *
 * It is the march's own sum with the two things the march reads from maps left
 * out: the sun's shadows and the spot cones. The air a particle stands in is
 * lit as if nothing shaded it and no lamp shone, so a puff in the shadow of a
 * hill is hazed a little brighter than the surface beside it, and the cones
 * are not seen on it. The distance stops at `reach`, as the march does,
 * though without its taper over the last third, so a thing near the reach is
 * hazed a little more than a surface at the same distance.
 */
export function fogAhead(fog: Fog, from: Vec3, to: Vec3, sunDir: Vec3, sunColour: Vec3): FogAhead {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-9 || !(fog.density > 0)) return { through: 1, scattered: [0, 0, 0] };
  const distance = Math.min(length, Math.max(fog.reach, TINY));
  const optical = opticalDepth(fog, from[2], dz / length, distance);
  const through = Math.exp(-optical);
  const sl = Math.hypot(sunDir[0], sunDir[1], sunDir[2]) || 1;
  const cosine = (dx * sunDir[0] + dy * sunDir[1] + dz * sunDir[2]) / (length * sl);
  const phase = fogPhase(cosine, Math.min(0.95, Math.max(-0.95, fog.anisotropy)));
  const ambient = Math.max(fog.ambient, 0);
  const took = 1 - through;
  return {
    through,
    scattered: [0, 1, 2].map((k) => fog.colour[k] * (ambient + sunColour[k] * phase) * took) as [number, number, number],
  };
}

/**
 * `opticalDepth` and `fogAhead` in WGSL, for a shader that declares the fog
 * as `var<uniform> fog: Fog` (`FOG_STRUCT_WGSL`) and has `phase`
 * (`FOG_PHASE_WGSL`). `fogAhead(point)` gives the in-scatter in rgb and the
 * transmittance in a, which is what a premultiplied blend wants. The sums are
 * the TypeScript's line for line, held equal at a set of points by
 * `particlefog.gpu.test.ts`.
 */
export const FOG_AHEAD_WGSL = `
const FOG_LEVEL: f32 = ${LEVEL};
const FOG_TINY: f32 = ${TINY};

fn fogOptical(z0: f32, slope: f32, dist: f32) -> f32 {
  let density = max(fog.density, 0.0);
  let height = max(fog.height, FOG_TINY);
  if (!(dist > 0.0) || density == 0.0) { return 0.0; }
  let hA = z0 - fog.base;
  let hB = hA + slope * dist;
  if (hA <= 0.0 && hB <= 0.0) { return density * dist; }
  var s0 = 0.0;
  var s1 = dist;
  if (hA < 0.0) { s0 = -hA / slope; }
  if (hB < 0.0) { s1 = -hA / slope; }
  let below = dist - (s1 - s0);
  let ha = max(hA + slope * s0, 0.0);
  let hb = max(hA + slope * s1, 0.0);
  let x = (hb - ha) / height;
  var above = 0.0;
  if (abs(x) < FOG_LEVEL) {
    above = (s1 - s0) * exp(-(ha + hb) / (2.0 * height)) * (1.0 + x * x / 24.0);
  } else {
    above = (s1 - s0) * (exp(-ha / height) - exp(-hb / height)) / x;
  }
  return density * (below + above);
}

fn fogAhead(point: vec3f) -> vec4f {
  let ray = point - fog.camPos;
  let len = length(ray);
  if (len < 1e-9 || !(fog.density > 0.0)) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let dist = min(len, max(fog.march.x, FOG_TINY));
  let through = exp(-fogOptical(fog.camPos.z, ray.z / len, dist));
  let cosine = dot(ray, fog.sunDir) / len;
  let light = fog.colour * (max(fog.march.y, 0.0) + fog.sunColour * phase(cosine, clamp(fog.lens.w, -0.95, 0.95)));
  return vec4f(light * (1.0 - through), through);
}
`;

/**
 * The view depth a depth-buffer value stands for, under the projection in
 * `camera.ts` — which maps [near, far] to [0, 1] and is not reversed. The
 * shader does this inline; this is here so a test can say what it should be.
 */
export function viewDepth(z: number, near: number, far: number): number {
  return near / Math.max(1 + (z * (near - far)) / far, 1e-6);
}
