import { describe, expect, it } from 'vitest';
import { setting } from '../setting';
import { findAnchor } from '../types';
import { expectWellFormed } from '../../mesh/__tests__/helpers';

describe('setting: both styles are well-formed', () => {
  it('claw', () => expectWellFormed(setting({ width: 8, style: 'claw' }).mesh));
  it('bezel', () => expectWellFormed(setting({ width: 8, style: 'bezel' }).mesh));
  it('defaults to claw when no style is given', () => {
    expect(setting({ width: 8 }).name).toBe('claw');
  });
});

describe('setting: anchors', () => {
  it('seats at the origin, bored to the stone\'s own width', () => {
    const p = setting({ width: 8 });
    const seat = findAnchor(p, 'seat');
    expect(seat.position).toEqual([0, 0, 0]);
    expect(seat.bore).toBe(8);
  });

  it('bases below the seat, at the mount\'s own bottom', () => {
    const p = setting({ width: 8, style: 'bezel', height: 3 });
    const base = findAnchor(p, 'base');
    expect(base.position[2]).toBeLessThan(0);
  });

  it('a claw setting\'s base sits lower than a bezel\'s of the same height, on account of the claw wire', () => {
    const claw = setting({ width: 8, style: 'claw', height: 3 });
    const bezel = setting({ width: 8, style: 'bezel', height: 3 });
    expect(findAnchor(claw, 'base').position[2]).toBeLessThan(findAnchor(bezel, 'base').position[2]);
  });
});

describe('setting: claws parameter', () => {
  it('more claws means more geometry', () => {
    const few = setting({ width: 8, style: 'claw', claws: 3 });
    const many = setting({ width: 8, style: 'claw', claws: 8 });
    expect(many.mesh.positions.length).toBeGreaterThan(few.mesh.positions.length);
  });

  it('is well-formed with the minimum sensible claw count', () => {
    expectWellFormed(setting({ width: 8, style: 'claw', claws: 2 }).mesh);
  });
});
