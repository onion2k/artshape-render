import { describe, expect, it } from 'vitest';
import { sweep } from '../../mesh/sweep';
import { circle } from '../../geom/profile';
import { line, samplePath } from '../../geom/curve';
import { revolve } from '../../mesh/revolve';

// emitterSamples lives with the viewer, which needs WebGPU to construct; the
// function itself is pure and is imported on its own
import { emitterSamples } from '../renderer';

describe('emitterSamples', () => {
  it('puts a light every 8 mm or so down a tube, each of the tube\'s radius and a share of its area', () => {
    const mesh = sweep(samplePath(line([0, 0, 0], [40, 0, 0]), 40), { profile: circle(1.5, 16) });
    const s = emitterSamples(mesh);
    expect(s.length).toBe(5);
    // spread along x, centred on the axis
    for (let i = 1; i < s.length; i++) expect(s[i].centre[0]).toBeGreaterThan(s[i - 1].centre[0]);
    for (const x of s) {
      expect(Math.abs(x.centre[1])).toBeLessThan(0.2);
      expect(x.radius).toBeCloseTo(1.5, 0);
    }
    const total = s.reduce((a, x) => a + x.area, 0);
    expect(total).toBeCloseTo(2 * Math.PI * 1.5 * 40 + 2 * Math.PI * 1.5 * 1.5, -1);
  });

  it('a small round thing is one light at its middle', () => {
    const mesh = revolve({ points: [[0, -2], [1.6, -1.2], [2, 0], [1.6, 1.2], [0, 2]] }, { segments: 24 });
    const s = emitterSamples(mesh);
    expect(s.length).toBe(1);
    expect(Math.hypot(...s[0].centre)).toBeLessThan(0.3);
  });
});
