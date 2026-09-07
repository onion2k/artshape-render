import { describe, expect, it } from 'vitest';
import { sweep } from '../sweep';
import * as profile from '../../geom/profile';
import { expectWellFormed } from './helpers';

const finite = (mesh: ReturnType<typeof sweep>) =>
  [...mesh.positions].every(Number.isFinite) && [...mesh.normals].every(Number.isFinite);

describe('sweep edge cases: degenerate paths', () => {
  it('a single-point path stays finite rather than throwing', () => {
    // frames() degenerates every direction to the zero vector for a
    // single-point path (there is no direction to be tangent to), but its
    // own normalize() guards divide by 1 rather than 0 — the result is a
    // flat, zero-extent frame, not NaN
    const mesh = sweep([[0, 0, 0]], { profile: profile.circle(1, 8), caps: true });
    expect(finite(mesh)).toBe(true);
  });

  it('a two-point path (the minimum for a real tube) is well-formed', () => {
    const mesh = sweep([[0, 0, 0], [10, 0, 0]], { profile: profile.circle(1, 8), caps: true });
    expectWellFormed(mesh);
  });

  it('duplicate consecutive path points do not throw or produce NaN', () => {
    const mesh = sweep(
      [[0, 0, 0], [5, 0, 0], [5, 0, 0], [10, 0, 0]],
      { profile: profile.circle(1, 8), caps: true },
    );
    expect(finite(mesh)).toBe(true);
  });

  it('an empty path throws rather than silently returning garbage', () => {
    expect(() => sweep([], { profile: profile.circle(1, 8) })).toThrow();
  });
});

describe('sweep edge cases: degenerate profile and taper', () => {
  it('a zero-radius profile collapses the tube onto its own centerline, but stays finite', () => {
    const mesh = sweep([[0, 0, 0], [5, 0, 0], [10, 0, 0]], { profile: profile.circle(0, 8), caps: true });
    expect(finite(mesh)).toBe(true);
    for (let i = 0; i < mesh.positions.length; i += 3) {
      expect(Math.hypot(mesh.positions[i + 1], mesh.positions[i + 2])).toBeCloseTo(0, 4);
    }
  });

  it('a minimal 2-sided profile (a doubled line, not a real polygon) stays finite', () => {
    const mesh = sweep([[0, 0, 0], [5, 0, 0], [10, 0, 0]], { profile: profile.circle(1, 2), caps: true });
    expect(finite(mesh)).toBe(true);
  });

  it('a taper reaching exactly 0 at the tip collapses that ring onto the path without NaN', () => {
    const mesh = sweep([[0, 0, 0], [5, 0, 0], [10, 0, 0]], {
      profile: profile.circle(2, 8), taper: (t) => 1 - t, caps: true,
    });
    expect(finite(mesh)).toBe(true);
    let tipRadius = 0;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      if (mesh.positions[i] > 9.9) tipRadius = Math.max(tipRadius, Math.hypot(mesh.positions[i + 1], mesh.positions[i + 2]));
    }
    expect(tipRadius).toBeCloseTo(0, 3);
  });

  it('a negative taper (an inverted section) does not throw — the ring stays at the same radius, just rotated 180°', () => {
    const mesh = sweep([[0, 0, 0], [5, 0, 0], [10, 0, 0]], {
      profile: profile.circle(2, 8), taper: () => -1, caps: false,
    });
    expect(finite(mesh)).toBe(true);
    // no caps this time, so every vertex is a ring vertex — a negated
    // circle profile is still a circle of the same radius
    for (let i = 0; i < mesh.positions.length; i += 3) {
      expect(Math.hypot(mesh.positions[i + 1], mesh.positions[i + 2])).toBeCloseTo(2, 3);
    }
  });
});

describe('sweep edge cases: closed loop at minimal size', () => {
  it('a closed loop with only two distinct points stays finite', () => {
    const mesh = sweep([[0, 0, 0], [10, 0, 0]], { profile: profile.circle(1, 8), closed: true });
    expect(finite(mesh)).toBe(true);
  });
});
