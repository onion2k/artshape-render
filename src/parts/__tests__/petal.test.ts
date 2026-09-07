import { describe, expect, it } from 'vitest';
import { petal } from '../petal';
import { findAnchor } from '../types';
import { expectWellFormed } from '../../mesh/__tests__/helpers';

describe('petal: base contract', () => {
  it('is a well-formed mesh', () => {
    expectWellFormed(petal({ length: 22, width: 13, thickness: 0.8 }).mesh);
  });

  it('always has a claw anchor at the origin, pointing back along -X', () => {
    const p = petal({ length: 22, width: 13, thickness: 0.8 });
    const claw = findAnchor(p, 'claw');
    expect(claw.position).toEqual([0, 0, 0]);
    expect(claw.axis).toEqual([-1, 0, 0]);
  });

  it('gains a boss anchor, bored to the given diameter, with a bossBore', () => {
    const p = petal({ length: 22, width: 13, thickness: 0.8, bossBore: 2.2 });
    const boss = findAnchor(p, 'boss');
    expect(boss.bore).toBe(2.2);
    expect(boss.position[0]).toBeCloseTo(22 * 0.16);
  });

  it('deform always runs — even a plain petal is not perfectly flat', () => {
    // unlike leaf, petal calls deform() unconditionally
    const flat = petal({ length: 22, width: 13, thickness: 0.8 });
    const cupped = petal({ length: 22, width: 13, thickness: 0.8, cup: 0.5 });
    const depth = (p: typeof flat) => p.bounds.max[2] - p.bounds.min[2];
    expect(depth(cupped)).toBeGreaterThan(depth(flat));
  });
});

describe('petal: shape and edge variety all stay well-formed', () => {
  for (const shape of ['round', 'pointed', 'spoon', 'strap', 'lip', 'quill'] as const) {
    it(`shape: ${shape}`, () => {
      expectWellFormed(petal({ length: 20, width: 12, thickness: 0.7, shape }).mesh);
    });
  }

  for (const edge of ['entire', 'toothed', 'fringed', 'crenate', 'notched'] as const) {
    it(`edge: ${edge}`, () => {
      expectWellFormed(petal({ length: 20, width: 12, thickness: 0.7, edge }).mesh);
    });
  }

  it('stays well-formed with veins pierced through it', () => {
    expectWellFormed(petal({ length: 20, width: 12, thickness: 0.7, veins: 3 }).mesh);
  });

  it('stays well-formed with ruffle applied', () => {
    expectWellFormed(petal({ length: 20, width: 12, thickness: 0.7, ruffle: 0.3, ruffleWaves: 6 }).mesh);
  });
});

describe('petal: enamel', () => {
  it('carries its enamel colour, marking only the top cap', () => {
    const p = petal({ length: 20, width: 12, thickness: 0.7, enamel: 'emerald' });
    expect(p.enamel).toBe('emerald');
    expect([...p.mesh.enamel!]).toContain(1);
    expect([...p.mesh.enamel!]).toContain(0);
  });
});
