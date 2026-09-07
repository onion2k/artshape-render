import { describe, expect, it } from 'vitest';
import { revolve } from '../revolve';
import { expectWatertight, expectWellFormed, boundsOf } from './helpers';

describe('revolve: structural invariants', () => {
  it('a full-turn closed silhouette (a torus profile) is well-formed and watertight', () => {
    const mesh = revolve({
      points: [[8, -2], [10, 0], [8, 2], [6, 0]],
      closed: true,
    }, { segments: 20 });
    expectWellFormed(mesh);
    expectWatertight(mesh);
  });

  it('a solid of revolution — silhouette running out to the axis at both ends — is watertight', () => {
    // a sphere-like silhouette: pole -> equator -> pole, radius 0 at both ends
    const mesh = revolve({
      points: [[0, -5], [5, 0], [0, 5]],
      sharp: [false, false, false],
    }, { segments: 24 });
    expectWellFormed(mesh);
    expectWatertight(mesh);
  });

  it('a partial arc leaves the cut faces open — not watertight', () => {
    const mesh = revolve({ points: [[0, -5], [5, 0], [0, 5]] }, { segments: 12, arc: Math.PI });
    expect(() => expectWatertight(mesh)).toThrow();
  });
});

describe('revolve: geometry', () => {
  it('a constant-radius silhouette produces a cylinder of exactly that radius', () => {
    const mesh = revolve({ points: [[5, 0], [5, 10]] }, { segments: 16 });
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const r = Math.hypot(mesh.positions[i], mesh.positions[i + 1]);
      expect(r).toBeCloseTo(5, 3);
    }
  });

  it('spans z as given by the silhouette', () => {
    const mesh = revolve({ points: [[5, -3], [8, 7]] }, { segments: 10 });
    const b = boundsOf(mesh);
    expect(b.min[2]).toBeCloseTo(-3);
    expect(b.max[2]).toBeCloseTo(7);
  });

  it('a smaller arc sweeps a proportionally smaller angular range', () => {
    const half = revolve({ points: [[5, 0], [5, 10]] }, { segments: 16, arc: Math.PI });
    for (let i = 0; i < half.positions.length; i += 3) {
      const angle = Math.atan2(half.positions[i + 1], half.positions[i]);
      expect(angle).toBeGreaterThanOrEqual(-1e-6);
      expect(angle).toBeLessThanOrEqual(Math.PI + 1e-6);
    }
  });

  it('warp modulates radius by angle as well as by position along the silhouette', () => {
    const mesh = revolve({ points: [[5, 0], [5, 10]] }, {
      segments: 40,
      warp: (angle) => 1 + 0.5 * Math.cos(3 * angle), // three lobes
    });
    const radii: number[] = [];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      radii.push(Math.hypot(mesh.positions[i], mesh.positions[i + 1]));
    }
    expect(Math.max(...radii)).toBeGreaterThan(7);
    expect(Math.min(...radii)).toBeLessThan(3);
  });

  it('the seam at angle 0 and angle 2*pi coincides for a full turn', () => {
    const mesh = revolve({ points: [[5, 0], [5, 10]] }, { segments: 24 });
    // first ring (i=0) and last ring (i=segments) should be at the same position
    const n = mesh.positions.length / 3;
    const perRing = n / 25; // rows = segments + 1
    const first = [mesh.positions[0], mesh.positions[1], mesh.positions[2]];
    const lastRingStart = (25 - 1) * perRing * 3;
    const last = [mesh.positions[lastRingStart], mesh.positions[lastRingStart + 1], mesh.positions[lastRingStart + 2]];
    expect(first[0]).toBeCloseTo(last[0]);
    expect(first[1]).toBeCloseTo(last[1]);
    expect(first[2]).toBeCloseTo(last[2]);
  });
});
