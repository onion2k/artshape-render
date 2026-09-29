/**
 * The toy finish without a device: the smooth light's ramp and the soft
 * tone as sums, and how the finish is packed for the scene shader. The ramp
 * and the tone are written once in TypeScript and once in WGSL, from the
 * same constants; `toy.gpu.test.ts` holds the shader to these on a device.
 *
 * What the ramp must do is what a game's picture rests on. Flat ground
 * facing straight up is lit exactly as the top band lit it, so a course
 * tuned against the bands keeps its green; a surface turned from the sun, or
 * in its shadow, is the deepest band exactly, so every shadow is the colour
 * it was; near flat ground it falls as steeply as the form light asks, so a
 * gentle hill still reads; and nowhere between is it flat, or it would be a
 * band again.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOOK, TOON_FLOATS, toonUniform, type Look } from '../renderer';
import { MAX_GLOSS, MAX_SHEEN, SOFT_KNEE, TOON_MID, TOON_SHADE, TOON_TOP, softTone, toonRamp } from '../toon';

const pack = (look: Partial<Look>) => Array.from(toonUniform(new Float32Array(TOON_FLOATS), { ...DEFAULT_LOOK, ...look }));
const FLATS = [0.1, 0.3, 0.5, 0.75, 0.89, 1];
const FORMS = [0, 0.5, 1, 2.5, 3];

describe('the smooth light\'s ramp', () => {
  it('is the deepest band where the sun does not reach, whatever the sun and the form', () => {
    for (const flat of FLATS) for (const form of FORMS) expect(toonRamp(0, flat, form)).toBe(TOON_SHADE);
  });

  it('lights flat ground exactly as the top band did, whatever the sun and the form', () => {
    for (const flat of FLATS) for (const form of FORMS) expect(toonRamp(flat, flat, form)).toBe(1);
  });

  it('never falls as the sun a surface takes rises, and never jumps', () => {
    for (const flat of FLATS)
      for (const form of FORMS) {
        // the steepest it may be anywhere: the form's fall, or Lambert's, whichever is steeper, and a little for the join
        const steepest = Math.max(form, 1) / flat + 0.6;
        let was = toonRamp(0, flat, form);
        for (let x = 0.001; x <= 1; x += 0.001) {
          const now = toonRamp(x, flat, form);
          expect(now, `at ${x.toFixed(3)} of the sun, flat ${flat}, form ${form}`).toBeGreaterThanOrEqual(was);
          expect(now - was, `at ${x.toFixed(3)} of the sun, flat ${flat}, form ${form}`).toBeLessThanOrEqual(steepest * 0.001 + 1e-9);
          was = now;
        }
      }
  });

  it('is never flat between the shadow and flat ground, so no part of it is a band', () => {
    for (const flat of FLATS)
      for (const form of FORMS)
        for (let x = 0.02; x + 0.02 <= flat; x += 0.01) {
          expect(toonRamp(x + 0.02, flat, form) - toonRamp(x, flat, form), `at ${x.toFixed(2)}, flat ${flat}, form ${form}`).toBeGreaterThan(0.001);
        }
  });

  it('falls away from flat ground as steeply as the form light asks, so a gentle hill still reads', () => {
    for (const flat of [0.75, 0.89, 1])
      for (const form of [1, 2.5, 3]) {
        const slope = (toonRamp(flat, flat, form) - toonRamp(flat - 0.01, flat, form)) / 0.01;
        expect(slope, `flat ${flat}, form ${form}`).toBeCloseTo(form / flat, 5);
      }
  });

  it('is lit no more than the top band\'s most', () => {
    for (const flat of FLATS) for (const form of FORMS) for (let x = 0; x <= 1; x += 0.01) expect(toonRamp(x, flat, form)).toBeLessThanOrEqual(TOON_TOP);
  });

  it('is the form light\'s top band exactly wherever the form\'s fall is over the band between, so a hill reads as it did', () => {
    // v0.21.0's top band with the form light: the fall, held between the band between and the top band's most
    for (const flat of FLATS)
      for (const form of [1, 1.5, 2.5, 3]) {
        let seen = 0;
        for (let x = 0; x <= 1; x += 0.005) {
          const fall = 1 + (form * (x - flat)) / flat;
          // clear of where the fall meets the band between, which the ramp eases over
          if (fall < TOON_MID + 0.07) continue;
          expect(toonRamp(x, flat, form), `at ${x.toFixed(3)} of the sun, flat ${flat}, form ${form}`).toBe(Math.min(Math.max(fall, TOON_MID), TOON_TOP));
          seen++;
        }
        expect(seen, `flat ${flat}, form ${form}`).toBeGreaterThan(0);
      }
  });

  it('rises from the deepest band to the band between under where the form\'s fall reaches it, and no higher', () => {
    for (const flat of FLATS)
      for (const form of FORMS) {
        const knee = flat * (1 - (1 - TOON_MID) / Math.max(form, 1));
        for (let x = 0; x <= knee; x += 0.005) {
          // no more than the join's ease above the band between: the Volcano's shaded flank read brighter than it did
          expect(toonRamp(x, flat, form), `at ${x.toFixed(3)} of the sun, flat ${flat}, form ${form}`).toBeLessThanOrEqual(TOON_MID + 0.016);
        }
        expect(toonRamp(knee, flat, form), `at the knee, flat ${flat}, form ${form}`).toBeGreaterThanOrEqual(TOON_MID - 1e-9);
      }
  });
});

describe('the soft tone', () => {
  const hue = ([r, g, b]: number[]) => {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d < 1e-6) return 0;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  const COLOURS: [number, number, number][] = [
    [0.85, 0.035, 0.025], [0.105, 0.41, 0.024], [0.99, 0.8, 0.2], [0.03, 0.22, 0.85], [0.9, 0.04, 0.3], [0.5, 0.5, 0.5],
  ];

  it('leaves a colour under the knee exactly as it was', () => {
    for (const c of COLOURS) {
      const k = (SOFT_KNEE * 0.999) / Math.max(...c);
      const under = c.map((x) => x * k) as [number, number, number];
      expect(softTone(under)).toEqual(under);
    }
    expect(softTone([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('never goes past one, however bright', () => {
    for (const c of COLOURS)
      for (const k of [1, 2, 5, 50, 1e4]) for (const x of softTone(c.map((v) => v * k) as [number, number, number])) expect(x).toBeLessThanOrEqual(1);
  });

  it('keeps a colour\'s hue as it brightens, where holding each channel at one turns an orange yellow', () => {
    for (const c of COLOURS) {
      if (Math.max(...c) - Math.min(...c) < 0.01) continue;
      for (const k of [1.1, 1.5, 2, 3, 6]) {
        const lit = c.map((v) => v * k / Math.max(...c)) as [number, number, number];
        expect(Math.abs(hue(softTone(lit)) - hue(c)), `${c} at ${k}`).toBeLessThan(0.5);
      }
    }
    // the clamp, for what this is instead of: an orange lit past one on two channels comes out a yellow
    const orange = [1.9, 1.2, 0.2];
    expect(Math.abs(hue(orange.map((x) => Math.min(x, 1))) - hue(orange))).toBeGreaterThan(15);
  });

  it('brightens every channel as the light does, and goes to white under a light bright enough', () => {
    for (const c of COLOURS) {
      let was = [0, 0, 0];
      for (let k = 0.05; k < 40; k *= 1.1) {
        const now = softTone(c.map((v) => v * k) as [number, number, number]);
        for (let i = 0; i < 3; i++) expect(now[i]).toBeGreaterThanOrEqual(was[i] - 1e-9);
        was = now;
      }
      for (const x of softTone(c.map((v) => v * 400) as [number, number, number])) expect(x).toBeGreaterThan(0.97);
    }
  });

  it('turns a white highlight on a colour white, where keeping its hue would make it a tint of the colour', () => {
    // the sun's highlight on red plastic: the red, and nearly as much again of white on every channel
    const highlight = softTone([0.85 * 1.1 + 0.9, 0.035 * 1.1 + 0.9, 0.025 * 1.1 + 0.9]);
    for (const x of highlight) expect(x).toBeGreaterThan(0.95);
    // and the red round it, lit as brightly, stays red
    const red = softTone([0.85 * 1.6, 0.035 * 1.6, 0.025 * 1.6]);
    expect(red[1] / red[0]).toBeLessThan(0.06);
  });

  it('keeps a lit pastel its colour, which is as white as a highlight but nowhere near as bright', () => {
    // a candy pink and a cream in a bright sun: past one, and largely white light, and not highlights
    for (const pastel of [[1.25, 0.9, 1.2], [1.2, 1.1, 0.9]] as [number, number, number][]) {
      const shown = softTone(pastel);
      const was = (Math.max(...pastel) - Math.min(...pastel)) / Math.max(...pastel);
      const now = (Math.max(...shown) - Math.min(...shown)) / Math.max(...shown);
      expect(now, `${pastel}`).toBeGreaterThan(was * 0.9);
    }
  });

  it('keeps a bright colour\'s shape where the clamp holds it flat', () => {
    // the red ball's lit side in the golf's light, from its brightest to its dimmest, a red channel of 1.6 down to
    // 0.94: the clamp gives the first four the same red; a shoulder must bring what is far past one together at
    // last, so this is the range a lit colour is actually drawn in
    const reds = [1.9, 1.6, 1.4, 1.25, 1.1].map((k) => [0.85 * k, 0.035 * k, 0.025 * k] as [number, number, number]);
    const soft = reds.map((c) => softTone(c)[0]);
    for (let i = 1; i < soft.length; i++) expect(soft[i - 1] - soft[i]).toBeGreaterThan(0.004);
  });
});

describe('the toy finish packed for the scene shader', () => {
  it('is on in a toon look that says nothing of it', () => {
    const p = pack({});
    expect(p[17], 'gloss').toBe(1);
    expect(p[18], 'sheen').toBe(1);
    expect(p[19], 'smooth shading').toBe(1);
    expect(p[20], 'occlusion tint').toBe(1);
    expect(p.slice(21, 24), 'spares').toEqual([0, 0, 0]);
  });

  it('is off, each part alone, where the look says nought', () => {
    const off = pack({ gloss: 0, sheen: 0, smoothShading: 0, occlusionTint: 0 });
    expect(off.slice(17, 21)).toEqual([0, 0, 0, 0]);
    expect(pack({ gloss: 0 }).slice(17, 21)).toEqual([0, 1, 1, 1]);
    expect(pack({ sheen: 0 }).slice(17, 21)).toEqual([1, 0, 1, 1]);
    expect(pack({ smoothShading: 0 }).slice(17, 21)).toEqual([1, 1, 0, 1]);
    expect(pack({ occlusionTint: 0 }).slice(17, 21)).toEqual([1, 1, 1, 0]);
    // and says nothing of the toon light before it, which is off until it is asked for
    expect(off.slice(0, 17)).toEqual(new Array(17).fill(0));
  });

  it('holds each part between nothing and its most, and takes what is not a number as not said', () => {
    expect(pack({ gloss: 0.5 })[17]).toBeCloseTo(0.5);
    expect(pack({ gloss: 99 })[17]).toBeCloseTo(MAX_GLOSS);
    expect(pack({ sheen: 99 })[18]).toBeCloseTo(MAX_SHEEN);
    expect(pack({ smoothShading: 3 })[19]).toBe(1);
    expect(pack({ occlusionTint: 3 })[20]).toBe(1);
    for (const k of ['gloss', 'sheen', 'smoothShading', 'occlusionTint'] as const) {
      expect(pack({ [k]: -1 }).slice(17, 21)).toContain(0);
      expect(pack({ [k]: NaN }).slice(17, 21)).toEqual([1, 1, 1, 1]);
    }
  });
});
