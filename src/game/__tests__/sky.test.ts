import { describe, expect, it } from 'vitest';
import { lookAt, multiply, perspective } from '../../gpu/camera';
import { SKY_BELOW, SKY_FLOATS, SKY_HEIGHT, invertInto, packSky, skyColour, type Sky } from '../sky';

const SKY: Sky = { zenith: [0.03, 0.33, 0.9], horizon: [0.6, 0.85, 1], below: [0.2, 0.3, 0.1] };

describe('the sky', () => {
  it('is the horizon at the level, the zenith from its height up, and between in between, never past either', () => {
    expect(skyColour(SKY, 0)).toEqual(SKY.horizon);
    expect(skyColour(SKY, SKY_HEIGHT)).toEqual(SKY.zenith);
    expect(skyColour(SKY, 1)).toEqual(SKY.zenith);
    let last = skyColour(SKY, 0);
    for (let up = 0.05; up <= SKY_HEIGHT; up += 0.05) {
      const c = skyColour(SKY, up);
      // the blue rises and the red falls all the way up, so the gradient has no band
      expect(c[2]).toBeLessThanOrEqual(last[2] + 1e-9);
      expect(c[0]).toBeLessThanOrEqual(last[0] + 1e-9);
      last = c;
    }
  });

  it('turns to the colour below just under the level, softly, and to the horizon\'s where none is said', () => {
    expect(skyColour(SKY, -SKY_BELOW)).toEqual(SKY.below);
    const half = skyColour(SKY, -SKY_BELOW / 2);
    expect(half[0]).toBeGreaterThan(SKY.below![0]);
    expect(half[0]).toBeLessThan(SKY.horizon[0]);
    expect(skyColour({ zenith: SKY.zenith, horizon: SKY.horizon }, -1)).toEqual(SKY.horizon);
  });

  it('takes a height of its own, and the default for one that is not a height', () => {
    expect(skyColour({ ...SKY, height: 0.2 }, 0.2)).toEqual(SKY.zenith);
    expect(skyColour({ ...SKY, height: 0 }, SKY_HEIGHT)).toEqual(SKY.zenith);
  });

  it('inverts a camera\'s matrix: a far point carried there and back is where it was', () => {
    const view = new Float32Array(16), proj = new Float32Array(16), vp = new Float32Array(16), inv = new Float32Array(16);
    lookAt(view, [10, -20, 5], [0, 40, 2], [0, 0, 1]);
    perspective(proj, (40 * Math.PI) / 180, 1.6, 0.5, 800);
    multiply(vp, proj, view);
    expect(invertInto(inv, vp)).toBe(true);
    const p = [3, 30, 7, 1];
    const c = [0, 1, 2, 3].map((r) => vp[r] * p[0] + vp[4 + r] * p[1] + vp[8 + r] * p[2] + vp[12 + r] * p[3]);
    const back = [0, 1, 2, 3].map((r) => inv[r] * c[0] + inv[4 + r] * c[1] + inv[8 + r] * c[2] + inv[12 + r] * c[3]);
    for (let k = 0; k < 3; k++) expect(back[k] / back[3]).toBeCloseTo(p[k], 3);
    // and refuses one with none, leaving what it was given alone
    const before = inv.slice();
    expect(invertInto(inv, new Float32Array(16))).toBe(false);
    expect(inv).toEqual(before);
  });

  it('packs its uniform in the shader\'s order', () => {
    const out = new Float32Array(SKY_FLOATS);
    const vp = new Float32Array(16);
    vp[0] = vp[5] = vp[10] = vp[15] = 1;
    expect(packSky(out, { ...SKY, height: 0.3 }, vp, [1, 2, 3], 640, 480)).toBe(true);
    expect([...out.slice(16, 24)]).toEqual([1, 2, 3, 0, 640, 480, Math.fround(0.3), Math.fround(SKY_BELOW)]);
    expect([...out.slice(24, 27)]).toEqual(SKY.zenith.map(Math.fround));
    expect([...out.slice(28, 31)]).toEqual(SKY.horizon.map(Math.fround));
    expect([...out.slice(32, 35)]).toEqual(SKY.below!.map(Math.fround));
    expect(packSky(out, SKY, new Float32Array(16), [0, 0, 0], 1, 1)).toBe(false);
  });
});
