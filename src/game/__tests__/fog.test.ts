/**
 * The maths a march is set up with: the depth the buffer holds, and the
 * camera basis the shader rebuilds its rays from. Both are things the fog
 * would be quietly wrong about on a device — a ray a few degrees out puts
 * the shafts in the wrong place and nothing looks broken — so they are
 * checked here, against the projection in `camera.ts` itself.
 */
import { describe, expect, it } from 'vitest';
import { Camera } from '../../gpu/camera';
import { FOG_FLOATS, NO_FOG, fogUniform, viewDepth } from '../fog';

/** A world point through the camera's own matrix, to clip and then to NDC. */
function project(camera: Camera, p: [number, number, number]) {
  const m = camera.viewProjection;
  const o = [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
  return { x: o[0] / o[3], y: o[1] / o[3], z: o[2] / o[3], w: o[3] };
}

const camera = () => {
  const c = new Camera();
  c.position = [0, -400, 120];
  c.target = [30, 60, 40];
  c.aspect = 16 / 9;
  c.near = 1; c.far = 5000;
  c.update();
  return c;
};

describe('viewDepth', () => {
  it('undoes the projection depth writes, at the plates and between them', () => {
    const c = camera();
    for (const d of [1, 10, 250, 1000, 4999]) {
      // a point straight ahead at view depth d: along the forward axis
      const f = [-c.view[2], -c.view[6], -c.view[10]];
      const p: [number, number, number] = [
        c.position[0] + f[0] * d, c.position[1] + f[1] * d, c.position[2] + f[2] * d,
      ];
      const { z, w } = project(c, p);
      expect(w).toBeCloseTo(d, 2);
      // relative, not absolute: a float32 depth buffer spends nearly all its
      // precision near the camera, and at the far plane one step of z is
      // several world units. Half a unit in five thousand is the format, not
      // the formula.
      expect(viewDepth(z, c.near, c.far) / d).toBeCloseTo(1, 3);
    }
  });

  it('reads a cleared buffer as the far plane, so an empty pixel marches to the end', () => {
    expect(viewDepth(1, 1, 5000)).toBeCloseTo(5000, 1);
    expect(viewDepth(0, 1, 5000)).toBeCloseTo(1, 4);
  });
});

describe('fogUniform', () => {
  const pack = (over: Partial<typeof NO_FOG> = {}, sun: Float32Array | null = null) => {
    const c = camera();
    const out = new Float32Array(FOG_FLOATS);
    fogUniform(out, { ...NO_FOG, ...over }, c, sun, [0.3, 0.4, 0.866], [1, 0.8, 0.6], 0.005, 2);
    return { c, out };
  };

  /** The ray the shader builds, for a pixel at these NDC coordinates. */
  const ray = (out: Float32Array, ndcX: number, ndcY: number) => {
    const right = [out[20], out[21], out[22]], up = [out[24], out[25], out[26]], back = [out[28], out[29], out[30]];
    const vx = (ndcX + 2 * out[44]) * out[27] * out[31];
    const vy = (ndcY + 2 * out[45]) * out[27];
    return [0, 1, 2].map((i) => right[i] * vx + up[i] * vy - back[i]);
  };

  it('packs a basis whose middle ray looks where the camera looks', () => {
    const { c, out } = pack();
    const r = ray(out, 0, 0);
    const len = Math.hypot(r[0], r[1], r[2]);
    expect(len).toBeCloseTo(1, 5);
    const want = [c.target[0] - c.position[0], c.target[1] - c.position[1], c.target[2] - c.position[2]];
    const wl = Math.hypot(...want);
    for (let i = 0; i < 3; i++) expect(r[i]).toBeCloseTo(want[i] / wl, 5);
  });

  it('builds a ray with a view depth of exactly one, so t is the depth buffer\'s own', () => {
    // a point down a corner ray at t units should project to that corner and
    // to a w of t: this is the whole trick the march rests on
    const { c, out } = pack();
    for (const [nx, ny] of [[1, 1], [-1, 0.3], [0.5, -1]]) {
      const r = ray(out, nx, ny);
      const t = 137;
      const p: [number, number, number] = [
        c.position[0] + r[0] * t, c.position[1] + r[1] * t, c.position[2] + r[2] * t,
      ];
      const q = project(c, p);
      expect(q.w).toBeCloseTo(t, 2);
      expect(q.x).toBeCloseTo(nx, 4);
      expect(q.y).toBeCloseTo(ny, 4);
    }
  });

  it('opens the rays as wide as the lens does', () => {
    const { c, out } = pack();
    const mid = ray(out, 0, 0), edge = ray(out, 0, 1);
    const dot = mid.reduce((s, v, i) => s + v * edge[i], 0) / Math.hypot(...edge);
    expect((Math.acos(dot) * 180) / Math.PI).toBeCloseTo(c.fov / 2, 3);
  });

  it('normalises the sun, clamps what must be clamped, and rounds the steps', () => {
    const { out } = pack({ density: -3, anisotropy: 5, steps: 12.6, height: 0, reach: -10 });
    expect(Math.hypot(out[32], out[33], out[34])).toBeCloseTo(1, 6);
    expect(out[35]).toBe(0);
    expect(out[46]).toBe(13);
    expect(out[47]).toBeLessThanOrEqual(0.95);
    expect(out[39]).toBeGreaterThan(0);
    expect(out[48]).toBeGreaterThan(0);
  });

  it('says whether there is a sun map, and zeroes the matrix when there is not', () => {
    const { out } = pack();
    expect(out[51]).toBe(0);
    expect(Array.from(out.subarray(0, 16))).toEqual(new Array(16).fill(0));
    const m = new Float32Array(16).fill(7);
    expect(pack({}, m).out[51]).toBe(1);
    expect(pack({}, m).out[0]).toBe(7);
  });
});
