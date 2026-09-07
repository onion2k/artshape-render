import { describe, expect, it } from 'vitest';
import { revolve } from '../revolve';

const finite = (mesh: ReturnType<typeof revolve>) => [...mesh.positions].every(Number.isFinite);

describe('revolve edge cases: segments count', () => {
  it('segments=1 is minimal but valid — a single wedge', () => {
    const mesh = revolve({ points: [[5, 0], [5, 10]] }, { segments: 1 });
    expect(mesh.positions.length / 3).toBeGreaterThan(0);
    expect(finite(mesh)).toBe(true);
  });

  it('segments=0 throws rather than producing NaN positions', () => {
    // `a = (i / segments) * arc` would divide by the segment count with no
    // floor, so segments=0 used to give i/0 = NaN for every row — reachable
    // from a real sketch, since every DSL builtin that revolves a
    // silhouette (bead, egg, pearl, bell, rivet, collar, pod, bud, setting,
    // gem's cabochon) reads `segments` via Args.count(), which now rejects
    // anything under 1 before it ever reaches revolve(). revolve() itself
    // carries the same guard, for any caller that builds a Silhouette by
    // hand rather than going through the DSL.
    expect(() => revolve({ points: [[5, 0], [5, 10]] }, { segments: 0 })).toThrow(/at least 1 segment/);
  });

  it('a negative segments count throws the same way', () => {
    expect(() => revolve({ points: [[5, 0], [5, 10]] }, { segments: -4 })).toThrow(/at least 1 segment/);
  });
});

describe('revolve edge cases: degenerate silhouettes', () => {
  it('a single-point silhouette throws rather than silently producing a broken mesh', () => {
    // only reachable by calling revolve() directly with a malformed
    // Silhouette — the DSL never lets a sketch supply raw silhouette points
    expect(() => revolve({ points: [[5, 0]] }, { segments: 16 })).toThrow();
  });

  it('a silhouette that runs to radius 0 at both ends (a lens/spindle shape) stays finite', () => {
    const mesh = revolve({ points: [[0, -5], [5, 0], [0, 5]] }, { segments: 16 });
    expect(finite(mesh)).toBe(true);
  });

  it('duplicate consecutive silhouette points do not throw or produce NaN', () => {
    const mesh = revolve({ points: [[5, 0], [5, 0], [5, 10]] }, { segments: 16 });
    expect(finite(mesh)).toBe(true);
  });
});

describe('revolve edge cases: the arc parameter', () => {
  it('arc=0 sweeps no angle at all — a flat sliver, but finite', () => {
    const mesh = revolve({ points: [[5, 0], [5, 10]] }, { segments: 16, arc: 0 });
    expect(finite(mesh)).toBe(true);
    for (let i = 0; i < mesh.positions.length; i += 3) {
      expect(mesh.positions[i + 1]).toBeCloseTo(0, 4); // every point at angle 0: y=0
    }
  });

  it('a negative arc sweeps the other way around, but stays finite and well-formed', () => {
    const mesh = revolve({ points: [[5, 0], [5, 10]] }, { segments: 16, arc: -Math.PI });
    expect(finite(mesh)).toBe(true);
    for (let i = 0; i < mesh.positions.length; i += 3) {
      expect(mesh.positions[i + 1]).toBeLessThanOrEqual(1e-6); // negative arc sweeps into y <= 0
    }
  });
});
