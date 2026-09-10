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

/** No fog at all: the passes are skipped and the frame is untouched. */
export const NO_FOG: Fog = {
  density: 0, base: 0, height: 1000, colour: [1, 1, 1],
  ambient: 0.2, anisotropy: 0.6, reach: 6000, steps: 24, cones: 1,
};

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
  out[39] = Math.max(fog.height, 1e-3);
  out[40] = fog.colour[0]; out[41] = fog.colour[1]; out[42] = fog.colour[2];
  out[43] = fog.base;
  out[44] = camera.shift[0]; out[45] = camera.shift[1];
  out[46] = Math.max(1, Math.round(fog.steps)); out[47] = Math.min(0.95, Math.max(-0.95, fog.anisotropy));
  out[48] = Math.max(fog.reach, 1); out[49] = Math.max(fog.ambient, 0);
  out[50] = bias; out[51] = sun ? 1 : 0;
  out[52] = time;
  out[53] = Math.max(0, cones);
  out[54] = Math.max(1, falloffHalf);
  out[55] = spotBias;
  out[56] = Math.max(fog.cones, 0);
  out[57] = spotTexel;
  return out;
}

/**
 * The view depth a depth-buffer value stands for, under the projection in
 * `camera.ts` — which maps [near, far] to [0, 1] and is not reversed. The
 * shader does this inline; this is here so a test can say what it should be.
 */
export function viewDepth(z: number, near: number, far: number): number {
  return near / Math.max(1 + (z * (near - far)) / far, 1e-6);
}
