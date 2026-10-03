/**
 * The fog a particle or a sprite is given by its own distance, under node:
 * the optical depth of the exponential layer along a straight ray, which has
 * a closed form, held to a fine numeric integral of the same density; the
 * transmittance and the in-scatter built on it; and that the shaders a game
 * that never asks for any of it compiles are the text they were at v0.24.0,
 * which is the cheapest way to say "nothing asked, nothing changed" before a
 * device is involved. `particlefog.gpu.test.ts` holds the WGSL to this sum.
 */
import { describe, expect, it } from 'vitest';
import { NO_FOG, fogAhead, fogPhase, noFog, opticalDepth, type Fog } from '../fog';
import { FOG_BLEND_WGSL, FOG_MSAA_WGSL, FOG_WGSL } from '../shaders';
import { DRAW_WGSL, SPRITE_WGSL } from '../particles';

/** FNV-1a over the text: no more than a way to say whether two strings are the same. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** The layer the Chopdrop haze is, in metres: 8e-4 a metre, 300 deep from the sea, reaching 1,200. */
const HAZE: Fog = { ...NO_FOG, density: 8e-4, base: 0, height: 300, reach: 1200, ambient: 0.4, anisotropy: 0.3, colour: [0.6, 0.7, 0.85] };

/** The density the march reads: exponential over the height above the base, flat below it. */
const density = (fog: Fog, z: number) => fog.density * Math.exp(-Math.max(z - fog.base, 0) / fog.height);

/** A fine midpoint integral of the density along a ray from height `z0` rising at `slope` for `distance`. */
function numeric(fog: Fog, z0: number, slope: number, distance: number, n = 400_000) {
  const ds = distance / n;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += density(fog, z0 + slope * (i + 0.5) * ds) * ds;
  return sum;
}

describe('the optical depth of the layer along a ray', () => {
  // each: where the ray starts (height above the base), how it climbs per unit of distance, and how far it goes
  const rays: [string, number, number, number][] = [
    ['level, above the base', 150, 0, 900],
    ['level, below the base, where the density is flat', -80, 0, 900],
    ['level, exactly at the base', 0, 0, 900],
    ['rising, above the base', 20, 0.2, 800],
    ['falling, above the base', 400, -0.3, 800],
    ['rising through the base', -60, 0.25, 700],
    ['falling through the base', 90, -0.25, 700],
    ['rising steeply from the ground', 0, 0.97, 500],
    ['straight down, through the base', 200, -1, 600],
    ['straight up', 5, 1, 1000],
    ['rising from far below the base', -500, 0.5, 2000],
    ['almost level, a hair up', 120, 1e-7, 900],
    ['almost level, a hair down', 120, -1e-7, 900],
    ['almost level and across the base', -0.0001, 1e-6, 900],
    ['falling and ending below the base', 100, -0.4, 600],
  ];

  it.each(rays)('is the numeric integral, for a ray that is %s', (_name, z0, slope, d) => {
    const exact = opticalDepth(HAZE, z0, slope, d);
    const fine = numeric(HAZE, z0, slope, d);
    expect(exact).toBeGreaterThan(0);
    expect(Math.abs(exact / fine - 1)).toBeLessThan(2e-5);
  });

  it('is a straight product of density and length for a level ray under the base', () => {
    expect(opticalDepth(HAZE, -10, 0, 500)).toBeCloseTo(HAZE.density * 500, 12);
  });

  it('is zero for no distance and for no density, and never negative or not a number', () => {
    expect(opticalDepth(HAZE, 50, 0.3, 0)).toBe(0);
    expect(opticalDepth({ ...HAZE, density: 0 }, 50, 0.3, 700)).toBe(0);
    for (const slope of [-1, -0.5, -1e-12, 0, 1e-12, 0.5, 1])
      for (const z0 of [-1e4, -1, 0, 1, 1e4]) {
        const t = opticalDepth(HAZE, z0, slope, 1200);
        expect(Number.isFinite(t)).toBe(true);
        expect(t).toBeGreaterThanOrEqual(0);
      }
  });

  it('thins with height: the same ray started higher takes less', () => {
    expect(opticalDepth(HAZE, 600, 0, 800)).toBeLessThan(opticalDepth(HAZE, 100, 0, 800));
    expect(opticalDepth(HAZE, 100, 0, 800)).toBeLessThan(opticalDepth(HAZE, -100, 0, 800));
  });

  it('does not ignore the falloff over height: a ray that climbs takes less than a level one', () => {
    expect(opticalDepth(HAZE, 0, 0.8, 800)).toBeLessThan(opticalDepth(HAZE, 0, 0, 800) * 0.6);
  });
});

describe('what a particle is given', () => {
  const eye: [number, number, number] = [0, 0, 120];
  const sun: [number, number, number] = [0.3, -0.5, 0.8];
  const sunColour: [number, number, number] = [1.5, 1.4, 1.2];
  const at = (d: number, rise = 0.1): [number, number, number] => [0, d * Math.sqrt(1 - rise * rise), 120 + d * rise];

  it('takes nothing, and adds nothing, with no fog', () => {
    for (const fog of [noFog(1), noFog(100), { ...HAZE, density: 0 }]) {
      const a = fogAhead(fog, eye, at(500), sun, sunColour);
      expect(a.through).toBe(1);
      expect(a.scattered).toEqual([0, 0, 0]);
    }
  });

  it('is exp of minus the optical depth along the ray to the point', () => {
    const d = 450;
    const a = fogAhead(HAZE, eye, at(d), sun, sunColour);
    expect(a.through).toBeCloseTo(Math.exp(-numeric(HAZE, 120, 0.1, d)), 5);
    // the figure the game's smoke is up against: about seven tenths gets through from 450
    expect(a.through).toBeGreaterThan(0.6);
    expect(a.through).toBeLessThan(0.8);
  });

  it('scatters the fog\'s colour, lit by the ambient and by the sun through the phase function, for what it took', () => {
    const d = 450;
    const to = at(d);
    const a = fogAhead(HAZE, eye, to, sun, sunColour);
    const dir = [to[0] - eye[0], to[1] - eye[1], to[2] - eye[2]].map((v) => v / d);
    const cosine = dir[0] * sun[0] + dir[1] * sun[1] + dir[2] * sun[2];
    const l = Math.hypot(...sun);
    const p = fogPhase(cosine / l, HAZE.anisotropy);
    for (let k = 0; k < 3; k++)
      expect(a.scattered[k]).toBeCloseTo(HAZE.colour[k] * (HAZE.ambient + sunColour[k] * p) * (1 - a.through), 6);
  });

  it('is the march\'s own sum when nothing shadows the light: the steps add up to light times what was taken', () => {
    const d = 700, to = at(d, 0.05), steps = 4000;
    const dir = [0, Math.sqrt(1 - 0.05 ** 2), 0.05];
    const p = fogPhase(dir[0] * sun[0] / Math.hypot(...sun) + dir[1] * sun[1] / Math.hypot(...sun) + dir[2] * sun[2] / Math.hypot(...sun), HAZE.anisotropy);
    const light = HAZE.colour.map((c, k) => c * (HAZE.ambient + sunColour[k] * p));
    let through = 1;
    const scattered = [0, 0, 0];
    const dt = d / steps;
    for (let i = 0; i < steps; i++) {
      const taken = 1 - Math.exp(-density(HAZE, 120 + dir[2] * (i + 0.5) * dt) * dt);
      for (let k = 0; k < 3; k++) scattered[k] += through * taken * light[k];
      through *= 1 - taken;
    }
    const a = fogAhead(HAZE, eye, to, sun, sunColour);
    expect(a.through).toBeCloseTo(through, 5);
    for (let k = 0; k < 3; k++) expect(a.scattered[k]).toBeCloseTo(scattered[k], 5);
  });

  it('takes more the further the point is, and never more than the reach\'s worth', () => {
    let last = 1;
    for (const d of [50, 200, 600, 1000, 1200]) {
      const t = fogAhead(HAZE, eye, at(d), sun, sunColour).through;
      expect(t).toBeLessThan(last);
      last = t;
    }
    // past the reach the march has stopped, and so does the fog on a particle
    const atReach = fogAhead(HAZE, eye, at(1200), sun, sunColour);
    const past = fogAhead(HAZE, eye, at(5000), sun, sunColour);
    expect(past.through).toBeCloseTo(atReach.through, 9);
    expect(past.scattered).toEqual(atReach.scattered);
  });

  it('is the same fog in a world measured in other units: a haze described in metres and in tenths of a metre agree', () => {
    // the golf's units, a tenth of a metre: lengths ten times as many, the density a tenth as large
    const k = 10;
    const golf: Fog = { ...HAZE, density: HAZE.density / k, base: HAZE.base * k, height: HAZE.height * k, reach: HAZE.reach * k };
    const metres = fogAhead(HAZE, eye, at(450), sun, sunColour);
    const tenths = fogAhead(golf, eye.map((v) => v * k) as [number, number, number], at(450).map((v) => v * k) as [number, number, number], sun, sunColour);
    expect(tenths.through).toBeCloseTo(metres.through, 9);
    for (let c = 0; c < 3; c++) expect(tenths.scattered[c]).toBeCloseTo(metres.scattered[c], 9);
  });

  it('is finite for a point at the eye, and takes nothing from it', () => {
    const a = fogAhead(HAZE, eye, eye, sun, sunColour);
    expect(a.through).toBe(1);
    expect(a.scattered).toEqual([0, 0, 0]);
  });
});

describe('a game that does not ask', () => {
  // The hashes of the shaders at v0.24.0, which were taken (as SHA-256, then
  // again as these) from the text as it stood at 9cf02e5, before the change. The fog's struct and its phase function have been
  // moved to be shared; spliced back in they are the same text to the byte,
  // and the particles' own shaders are not touched at all.
  it('compiles the fog and the particles from the same text it did at v0.24.0', () => {
    expect({
      FOG_WGSL: hash(FOG_WGSL), FOG_MSAA_WGSL: hash(FOG_MSAA_WGSL), FOG_BLEND_WGSL: hash(FOG_BLEND_WGSL),
      DRAW_WGSL: hash(DRAW_WGSL), SPRITE_WGSL: hash(SPRITE_WGSL),
    }).toEqual({
      FOG_WGSL: 'f004ea2e', FOG_MSAA_WGSL: 'd7419938', FOG_BLEND_WGSL: 'a074a786',
      DRAW_WGSL: 'f2ed5e20', SPRITE_WGSL: 'ba632508',
    });
  });
});
