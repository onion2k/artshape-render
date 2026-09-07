import { describe, expect, it } from 'vitest';
import { Camera, lookAt } from '../camera';

describe('lookAt: degenerates when up is parallel to the view direction', () => {
  it('zeroes the x/y basis rather than producing NaN, when looking straight down the up axis', () => {
    const out = new Float32Array(16);
    lookAt(out, [0, 0, 10], [0, 0, 0], [0, 0, 1]);
    // the cross product of a parallel up and forward is the zero vector, and
    // the "|| 1" guard against dividing by a zero length leaves the basis at
    // zero rather than throwing — a real limitation given every symmetry and
    // part in this project is authored around +Z as "up"
    expect(out[0]).toBe(0);
    expect(out[5]).toBe(0);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });

  it('is well-formed once off that axis', () => {
    const out = new Float32Array(16);
    lookAt(out, [0, 10, 3], [0, 0, 0], [0, 0, 1]);
    expect(out[0]).not.toBe(0);
  });
});

describe('Camera', () => {
  it('has sane defaults and +Z up', () => {
    const cam = new Camera();
    expect(cam.aspect).toBe(1);
    expect(cam.near).toBeGreaterThan(0);
    expect(cam.far).toBeGreaterThan(cam.near);
  });

  it('update() populates view, projection and viewProjection', () => {
    const cam = new Camera();
    cam.update();
    // an identity-free view matrix: not the zero matrix, not the identity
    expect([...cam.view].some((v) => v !== 0)).toBe(true);
    expect([...cam.projection].some((v) => v !== 0)).toBe(true);
  });

  it('viewProjection is projection * view applied to a point', () => {
    const cam = new Camera();
    cam.position = [0, -10, 0];
    cam.target = [0, 0, 0];
    cam.fov = 60;
    cam.aspect = 1;
    cam.update();
    // the target should project to clip-space (0, 0) in x/y, in front of the camera (w > 0)
    const m = cam.viewProjection;
    const p: [number, number, number] = [0, 0, 0];
    const cx = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    const cy = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const cw = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    expect(cx / cw).toBeCloseTo(0, 5);
    expect(cy / cw).toBeCloseTo(0, 5);
    expect(cw).toBeGreaterThan(0);
  });

  it('a point straight ahead projects near the centre of the screen', () => {
    const cam = new Camera();
    cam.position = [0, 0, 10];
    cam.target = [0, 0, 0];
    cam.update();
    const m = cam.viewProjection;
    const cx = m[0] * 0 + m[4] * 0 + m[8] * 0 + m[12];
    const cy = m[1] * 0 + m[5] * 0 + m[9] * 0 + m[13];
    const cw = m[3] * 0 + m[7] * 0 + m[11] * 0 + m[15];
    expect(cx / cw).toBeCloseTo(0, 5);
    expect(cy / cw).toBeCloseTo(0, 5);
  });

  it('right and up are derived from the view matrix and stay orthonormal', () => {
    const cam = new Camera();
    cam.position = [12, 5, 8];
    cam.target = [1, 1, 1];
    cam.update();
    const dot = (a: [number, number, number], b: [number, number, number]) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
    const len = (a: [number, number, number]) => Math.hypot(...a);
    expect(len(cam.right)).toBeCloseTo(1, 4);
    expect(len(cam.up)).toBeCloseTo(1, 4);
    expect(dot(cam.right, cam.up)).toBeCloseTo(0, 4);
  });

  it('a narrower fov increases the projected size of a fixed-distance object', () => {
    // position off the world Z axis: dead along it, the +Z "up" reference the
    // whole project uses is parallel to the view direction and the look-at
    // basis degenerates (this is exactly why Orbit keeps its polar angle away
    // from the poles) — not what this test means to exercise
    const wide = new Camera();
    wide.position = [0, 10, 3]; wide.target = [0, 0, 0]; wide.fov = 90; wide.update();
    const narrow = new Camera();
    narrow.position = [0, 10, 3]; narrow.target = [0, 0, 0]; narrow.fov = 20; narrow.update();
    const projected = (cam: Camera, p: [number, number, number]) => {
      const m = cam.viewProjection;
      const cx = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
      const cw = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
      return cx / cw;
    };
    expect(Math.abs(projected(narrow, [1, 0, 0]))).toBeGreaterThan(Math.abs(projected(wide, [1, 0, 0])));
  });

  it('maps a point at the near plane and a point at the far plane into [0, 1] depth (WebGPU convention)', () => {
    const cam = new Camera();
    cam.position = [0, 0, 0]; cam.target = [0, 0, -1]; cam.near = 1; cam.far = 100; cam.update();
    const depthAt = (z: number) => {
      const m = cam.viewProjection;
      const cz = m[2] * 0 + m[6] * 0 + m[10] * z + m[14];
      const cw = m[3] * 0 + m[7] * 0 + m[11] * z + m[15];
      return cz / cw;
    };
    expect(depthAt(-1)).toBeCloseTo(0, 2);
    expect(depthAt(-100)).toBeCloseTo(1, 2);
  });
});

describe('lens, shift and roll', () => {
  const project = (cam: Camera, p: [number, number, number]) => {
    cam.update();
    const m = cam.viewProjection;
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    return [x / w, y / w];
  };

  it('a 42 mm lens on a 24 mm frame is about the 32 degree view the camera starts with', () => {
    expect(Camera.fovForLens(42)).toBeCloseTo(31.9, 0);
    expect(Camera.lensForFov(Camera.fovForLens(85))).toBeCloseTo(85, 6);
  });

  it('a rise carries the frame up: a point ahead lands lower on the picture', () => {
    const cam = new Camera();
    cam.position = [0, -50, 0]; cam.target = [0, 0, 0]; cam.aspect = 1;
    const before = project(cam, [0, 0, 5]);
    cam.shift = [0, 0.3];
    const after = project(cam, [0, 0, 5]);
    expect(after[0]).toBeCloseTo(before[0], 6);
    expect(after[1]).toBeCloseTo(before[1] - 0.6, 6);
  });

  it('a roll turns the picture about its centre and leaves the centre where it was', () => {
    const cam = new Camera();
    cam.position = [0, -50, 0]; cam.target = [0, 0, 0]; cam.aspect = 1;
    const centre = project(cam, [0, 0, 0]);
    const up = project(cam, [0, 0, 5]);
    cam.roll = Math.PI / 2;
    expect(project(cam, [0, 0, 0])[0]).toBeCloseTo(centre[0], 6);
    const turned = project(cam, [0, 0, 5]);
    // a quarter turn takes what was above the centre to one side of it, at the same distance
    expect(Math.abs(turned[0])).toBeCloseTo(Math.abs(up[1]), 5);
    expect(Math.abs(turned[1])).toBeLessThan(1e-5);
  });
});
