import { describe, expect, it } from 'vitest';
import { branch, stem } from '../stem';
import { catmullRom } from '../../geom/curve';
import { findAnchor } from '../types';
import { expectWellFormed } from '../../mesh/__tests__/helpers';

const straight = () => catmullRom([[0, -18, 0], [1, -6, 0], [-1, 6, 0], [2, 18, 0]]);

describe('stem', () => {
  it('is well-formed with and without nodes', () => {
    expectWellFormed(stem({ path: straight(), radius: 1.5 }).mesh);
    expectWellFormed(stem({ path: straight(), radius: 1.5, nodes: 3 }).mesh);
  });

  it('has base and tip anchors at the path\'s two ends', () => {
    const p = stem({ path: straight(), radius: 1.5 });
    const base = findAnchor(p, 'base');
    const tip = findAnchor(p, 'tip');
    // the path runs from y=-18 to y=18
    expect(base.position[1]).toBeLessThan(-15);
    expect(tip.position[1]).toBeGreaterThan(15);
  });

  it('adds one named node anchor per node, none without', () => {
    const bare = stem({ path: straight(), radius: 1.5 });
    expect(bare.anchors.map((a) => a.name)).toEqual(['base', 'tip']);
    const withNodes = stem({ path: straight(), radius: 1.5, nodes: 3 });
    expect(withNodes.anchors.map((a) => a.name)).toEqual(['base', 'tip', 'n0', 'n1', 'n2']);
  });

  it('node anchors stand off the surface, not on the centerline', () => {
    const p = stem({ path: straight(), radius: 2, nodes: 1 });
    const node = findAnchor(p, 'n0');
    expect(Math.hypot(node.position[0], node.position[2])).toBeGreaterThan(0.5);
  });

  it('is dipped whole when enamelled — a stem is round', () => {
    const p = stem({ path: straight(), radius: 1.5, enamel: 'ruby' });
    expect([...p.mesh.enamel!].every((v) => v === 1)).toBe(true);
  });
});

describe('branch', () => {
  it('is well-formed', () => {
    expectWellFormed(branch({ path: straight(), radius: 1.4, limbs: 3 }).mesh);
  });

  it('is one merged mesh — more triangles than the trunk alone', () => {
    const trunk = stem({ path: straight(), radius: 1.4, nodes: 3 });
    const withLimbs = branch({ path: straight(), radius: 1.4, limbs: 3 });
    expect(withLimbs.mesh.indices.length).toBeGreaterThan(trunk.mesh.indices.length);
  });

  it('drops the numbered node anchors the limbs grew from, replacing them with a tip anchor per limb', () => {
    const p = branch({ path: straight(), radius: 1.4, limbs: 3 });
    expect(p.anchors.some((a) => /^n\d+$/.test(a.name))).toBe(false);
    expect(p.anchors.map((a) => a.name)).toEqual(['base', 'tip', 't0', 't1', 't2']);
  });

  it('more limbs means more geometry', () => {
    const few = branch({ path: straight(), radius: 1.4, limbs: 2 });
    const many = branch({ path: straight(), radius: 1.4, limbs: 5 });
    expect(many.mesh.positions.length).toBeGreaterThan(few.mesh.positions.length);
  });
});
