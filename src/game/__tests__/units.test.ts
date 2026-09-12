/**
 * The game path in another unit.
 *
 * A world unit is the caller's business: an arena is modelled in millimetres,
 * a walking simulator would be modelled in metres, and neither is wrong. What
 * would be wrong is a length written into the library itself — a near plane
 * of twenty, a floor of one, a gravity of 9.81 — because such a number means
 * a different thing in every world, and nothing in the picture says which one
 * it meant. The still-life path was given `mmPerUnit` when it was made a
 * library; these are the same rules for this one, checked without a device.
 *
 * The shape of every check is the same: describe the same physical thing
 * twice, once in millimetres and once in metres, and require the two to agree
 * about what a shadow map, a fog march or a light's fall should do.
 */
import { describe, expect, it } from 'vitest';
import { spotShadowMatrix } from '../shadows';
import { FOG_FLOATS, NO_FOG, fogUniform, noFog } from '../fog';
import { DEFAULT_LOOK, defaultLook } from '../renderer';
import { Camera } from '../../gpu/camera';

/** A point through a matrix, divided out: clip xyz, and the w it came with. */
function through(m: Float32Array, p: [number, number, number]): [number, number, number, number] {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [x / w, y / w, z / w, w];
}

/** A metre is a thousand millimetres, and this is the number that says so. */
const MM_PER_METRE = 1000;
const k = 1 / MM_PER_METRE;

describe('a spotlight, described in millimetres and in metres', () => {
  // a lamp four metres up, aiming down the way, reaching six and a half
  const mm = { position: [0, 0, 4000] as [number, number, number], reach: 6500 };
  const metres = { position: [0, 0, 4] as [number, number, number], reach: 6.5 };
  const aim: [number, number, number] = [0, 0.3, -0.95];

  it('puts the same places at the same depths in its map', () => {
    const a = new Float32Array(16); const b = new Float32Array(16);
    spotShadowMatrix(a, mm.position, aim, 28, mm.reach);
    spotShadowMatrix(b, metres.position, aim, 28, metres.reach);
    // three places under the lamp: at its foot, a metre out, and four out
    for (const [x, y, z] of [[0, 0, 0], [0, 1000, 0], [0, 4000, 300]] as [number, number, number][]) {
      const inMm = through(a, [x, y, z]);
      const inMetres = through(b, [x * k, y * k, z * k]);
      expect(inMetres[0]).toBeCloseTo(inMm[0], 4);
      expect(inMetres[1]).toBeCloseTo(inMm[1], 4);
      // the depth a surface writes and the depth a lookup compares: if these
      // part company, every shadow on the game path is wrong by the unit
      expect(inMetres[2]).toBeCloseTo(inMm[2], 4);
    }
  });

  it('keeps the whole of a lamp inside its own frustum, in either unit', () => {
    for (const lamp of [mm, metres]) {
      const m = new Float32Array(16);
      spotShadowMatrix(m, lamp.position, [0, 0, -1], 30, lamp.reach);
      // just past the near plane, and just short of the reach
      const near: [number, number, number] = [0, 0, lamp.position[2] - lamp.reach / 200];
      const far: [number, number, number] = [0, 0, lamp.position[2] - lamp.reach * 0.99];
      expect(through(m, near)[2]).toBeGreaterThanOrEqual(0);
      expect(through(m, far)[2]).toBeLessThanOrEqual(1);
    }
  });

  it('never clips a metre-scale scene away with a near plane of its own', () => {
    // the bug this is here for: a near plane of twenty world units is 20 mm in
    // an arena and 20 m in a room, and 20 m from the lamp is past the far wall
    const m = new Float32Array(16);
    spotShadowMatrix(m, [0, 0, 3], [0, 0, -1], 30, 8);
    const floor = through(m, [0, 0, 0]);
    expect(floor[2]).toBeGreaterThan(0);
    expect(floor[2]).toBeLessThan(1);

    // and what it used to do, kept here so the bug cannot come back quietly:
    // twenty units of near plane in a room eight units deep is behind the
    // camera's own floor, and the floor falls out of the map altogether
    const asWas = new Float32Array(16);
    spotShadowMatrix(asWas, [0, 0, 3], [0, 0, -1], 30, 8, 20);
    expect(through(asWas, [0, 0, 0])[2]).toBeLessThan(0);
  });
});

describe('the fog uniform in another unit', () => {
  const camera = () => {
    const c = new Camera();
    c.position = [0, -2000, 300]; c.target = [0, 0, 300];
    c.near = 1; c.far = 40000; c.aspect = 1; c.update();
    return c;
  };

  it('converts a layer and its reach, and the density the other way', () => {
    const metres = noFog(MM_PER_METRE);
    expect(metres.height).toBeCloseTo(NO_FOG.height * k);
    expect(metres.reach).toBeCloseTo(NO_FOG.reach * k);
    // a mist a beam halves over is the same mist: half the beam over a
    // thousandth of the number of units is a thousand times the extinction
    const mist = { ...NO_FOG, density: 2.6e-4 };
    const asMetres = { ...noFog(MM_PER_METRE), density: mist.density * MM_PER_METRE };
    expect(asMetres.density * asMetres.reach).toBeCloseTo(mist.density * mist.reach);
  });

  it('no longer rounds a sub-unit length up to one', () => {
    // half a metre of falloff, and a third of a metre of reach, in a world
    // measured in metres: the floors used to make them one, which is a light
    // that carries twice as far as it was asked to
    const out = new Float32Array(FOG_FLOATS);
    fogUniform(out, { ...noFog(MM_PER_METRE), reach: 0.33 }, camera(), null, [0, 0, 1], [1, 1, 1], 0.001, 0, 0, 0.5);
    expect(out[48]).toBeCloseTo(0.33);
    expect(out[54]).toBeCloseTo(0.5);
  });

  it('still keeps every divisor off nought', () => {
    const out = new Float32Array(FOG_FLOATS);
    fogUniform(out, { ...NO_FOG, height: 0, reach: 0 }, camera(), null, [0, 0, 1], [1, 1, 1], 0.001, 0, 0, 0);
    expect(out[39]).toBeGreaterThan(0);
    expect(out[48]).toBeGreaterThan(0);
    expect(out[54]).toBeGreaterThan(0);
  });
});

describe("the look's lengths", () => {
  it("carries the light fall into the world's own unit", () => {
    expect(defaultLook(MM_PER_METRE).falloffHalf).toBeCloseTo(DEFAULT_LOOK.falloffHalf * k);
  });

  it('leaves what is not a length alone', () => {
    const metres = defaultLook(MM_PER_METRE);
    expect(metres.ambient).toBe(DEFAULT_LOOK.ambient);
    expect(metres.exposure).toBe(DEFAULT_LOOK.exposure);
    expect(metres.sunDir).toEqual(DEFAULT_LOOK.sunDir);
  });

  it('takes the softness the other way, being per length', () => {
    // texels of map per world unit of distance: a world whose numbers are a
    // thousand times smaller needs a thousand times the coefficient
    const soft = { ...DEFAULT_LOOK, spotSoftness: 1 / 500 };
    const scaled = { ...defaultLook(MM_PER_METRE), spotSoftness: soft.spotSoftness * MM_PER_METRE };
    expect(scaled.spotSoftness * (2500 * k)).toBeCloseTo(soft.spotSoftness * 2500);
  });
});
