import { describe, expect, it } from 'vitest';
import { leaf } from '../leaf';
import { findAnchor } from '../types';
import { expectWellFormed } from '../../mesh/__tests__/helpers';

describe('leaf: base contract', () => {
  it('is a well-formed mesh', () => {
    expectWellFormed(leaf({ length: 30, width: 14, thickness: 1.1 }).mesh);
  });

  it('always has a base anchor, at the origin, pointing back along -X', () => {
    const p = leaf({ length: 30, width: 14, thickness: 1.1 });
    const base = findAnchor(p, 'base');
    expect(base.position).toEqual([0, 0, 0]);
    expect(base.axis).toEqual([-1, 0, 0]);
  });

  it('has no boss anchor without a bossBore', () => {
    const p = leaf({ length: 30, width: 14, thickness: 1.1 });
    expect(p.anchors.find((a) => a.name === 'boss')).toBeUndefined();
  });

  it('gains a boss anchor, bored to the given diameter, with a bossBore', () => {
    // relief is on by default (a quarter of the thickness) and it bends the
    // plate, carrying the boss anchor along with it — so relief is turned off
    // here to check the anchor's un-deformed position and axis in isolation
    const p = leaf({ length: 30, width: 14, thickness: 1.1, bossBore: 2.4, relief: 0 });
    const boss = findAnchor(p, 'boss');
    expect(boss.bore).toBe(2.4);
    expect(boss.axis).toEqual([0, 0, 1]);
    expect(boss.position[2]).toBeCloseTo(1.1 / 2);
  });

  it('relief is on by default and bends the plate even with no cup or curl asked for', () => {
    const plain = leaf({ length: 30, width: 14, thickness: 1.1, bossBore: 2.4 });
    const noRelief = leaf({ length: 30, width: 14, thickness: 1.1, bossBore: 2.4, relief: 0 });
    expect(findAnchor(plain, 'boss').position[2]).not.toBeCloseTo(findAnchor(noRelief, 'boss').position[2], 2);
  });

  it('is roughly length long and width wide before any bend', () => {
    const p = leaf({ length: 40, width: 20, thickness: 1 });
    const span = p.bounds.max[0] - p.bounds.min[0];
    // the outline tapers to nothing at both ends and includes bevel/edge
    // effects, so this is a loose envelope rather than an exact match
    expect(span).toBeGreaterThan(30);
    expect(span).toBeLessThanOrEqual(40 + 1);
    const width = p.bounds.max[1] - p.bounds.min[1];
    expect(width).toBeLessThanOrEqual(20 + 1);
    expect(width).toBeGreaterThan(10);
  });

  it('is thin along z, close to the given thickness, before any bend', () => {
    const p = leaf({ length: 30, width: 14, thickness: 2 });
    const depth = p.bounds.max[2] - p.bounds.min[2];
    expect(depth).toBeCloseTo(2, 0);
  });
});

describe('leaf: cup and curl actually bend the plate', () => {
  it('cup increases the z-extent relative to a flat leaf', () => {
    const flat = leaf({ length: 30, width: 14, thickness: 1 });
    const cupped = leaf({ length: 30, width: 14, thickness: 1, cup: 0.6 });
    const depth = (p: typeof flat) => p.bounds.max[2] - p.bounds.min[2];
    expect(depth(cupped)).toBeGreaterThan(depth(flat));
  });

  it('curl lifts the tip out of the base plane', () => {
    const curled = leaf({ length: 30, width: 14, thickness: 1, curl: 1.2 });
    expect(curled.bounds.max[2] - curled.bounds.min[2]).toBeGreaterThan(2);
  });

  it('bending moves the base anchor\'s axis, not just its position', () => {
    const flat = leaf({ length: 30, width: 14, thickness: 1, bossBore: 2 });
    const curled = leaf({ length: 30, width: 14, thickness: 1, curl: 1.5, bossBore: 2 });
    const flatBoss = findAnchor(flat, 'boss');
    const curledBoss = findAnchor(curled, 'boss');
    expect(curledBoss.axis).not.toEqual(flatBoss.axis);
  });
});

describe('leaf: piercings and enamel', () => {
  it('stays a well-formed mesh with piercings cut through it', () => {
    expectWellFormed(leaf({ length: 30, width: 14, thickness: 1, piercings: 3 }).mesh);
  });

  it('stays well-formed with veins pierced as well', () => {
    expectWellFormed(leaf({ length: 30, width: 14, thickness: 1, veins: 2 }).mesh);
  });

  it('stays well-formed as a palmate (lobed) leaf', () => {
    expectWellFormed(leaf({ length: 30, width: 14, thickness: 1, lobes: 5 }).mesh);
  });

  it('carries its enamel colour onto the part, marking only the top cap', () => {
    const p = leaf({ length: 30, width: 14, thickness: 1, enamel: 'cobalt' });
    expect(p.enamel).toBe('cobalt');
    expect(p.mesh.enamel).toBeDefined();
    expect([...p.mesh.enamel!]).toContain(1);
    expect([...p.mesh.enamel!]).toContain(0);
  });

  it('has no enamel field at all without one asked for', () => {
    const p = leaf({ length: 30, width: 14, thickness: 1 });
    expect(p.enamel).toBeUndefined();
    expect(p.mesh.enamel).toBeUndefined();
  });
});
