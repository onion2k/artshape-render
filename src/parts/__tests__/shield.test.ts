import { describe, expect, it } from 'vitest';
import { shield } from '../shield';
import { findAnchor } from '../types';
import { expectWatertight, expectWellFormed, boundsOf } from '../../mesh/__tests__/helpers';

describe('shield: base contract', () => {
  it('is a well-formed, watertight shell', () => {
    const p = shield({ radius: 30 });
    expectWellFormed(p.mesh);
    expectWatertight(p.mesh);
  });

  it('spans roughly 2x radius across the face', () => {
    const p = shield({ radius: 30 });
    const b = boundsOf(p.mesh);
    expect(b.max[0] - b.min[0]).toBeCloseTo(60, -1);
    expect(b.max[1] - b.min[1]).toBeCloseTo(60, -1);
  });

  it('a larger radius makes a larger shield', () => {
    const small = shield({ radius: 15 });
    const large = shield({ radius: 45 });
    const span = (p: typeof small) => boundsOf(p.mesh).max[0] - boundsOf(p.mesh).min[0];
    expect(span(large)).toBeGreaterThan(span(small));
  });

  it('face and back anchors sit on opposite sides, face pointing +Z', () => {
    const p = shield({ radius: 30 });
    const face = findAnchor(p, 'face');
    const back = findAnchor(p, 'back');
    expect(face.axis).toEqual([0, 0, 1]);
    expect(face.position[2]).toBeGreaterThan(back.position[2]);
  });
});

describe('shield: boss and dome', () => {
  it('the centre stands proud of the rim — a dome, not a flat disc', () => {
    const p = shield({ radius: 30, domeHeight: 5, bossHeight: 0 });
    let centreZ = -Infinity;
    let rimZ = -Infinity;
    for (let i = 0; i < p.mesh.positions.length; i += 3) {
      const [x, y, z] = [p.mesh.positions[i], p.mesh.positions[i + 1], p.mesh.positions[i + 2]];
      const r = Math.hypot(x, y);
      if (r < 1) centreZ = Math.max(centreZ, z);
      if (r > 29) rimZ = Math.max(rimZ, z);
    }
    expect(centreZ).toBeGreaterThan(rimZ);
  });

  it('a taller bossHeight raises the centre further above the dome alone', () => {
    const plain = shield({ radius: 30, bossHeight: 0 });
    const bossed = shield({ radius: 30, bossHeight: 8 });
    const centreZ = (p: typeof plain) => {
      let z = -Infinity;
      for (let i = 0; i < p.mesh.positions.length; i += 3) {
        if (Math.hypot(p.mesh.positions[i], p.mesh.positions[i + 1]) < 1) {
          z = Math.max(z, p.mesh.positions[i + 2]);
        }
      }
      return z;
    };
    expect(centreZ(bossed)).toBeGreaterThan(centreZ(plain));
  });

  it('stays well-formed and watertight with no boss at all', () => {
    const p = shield({ radius: 30, bossHeight: 0 });
    expectWellFormed(p.mesh);
    expectWatertight(p.mesh);
  });
});

describe('shield: grip', () => {
  it('the grip sits behind the face, on the concave side', () => {
    const p = shield({ radius: 30 });
    const face = findAnchor(p, 'face').position[2];
    const back = findAnchor(p, 'back').position[2];
    expect(back).toBeLessThan(face);
  });

  it('a gripWidth wider than the face itself sets the overall X span', () => {
    // wide enough that only the grip, not the domed face (2x radius), can
    // be responsible for the extra reach — isolating one overlapping piece
    // of a merged mesh from another by scanning raw coordinates is
    // unreliable in general (see leverBack/earringStand), so this goes
    // wide enough to sidestep the ambiguity rather than fight it
    const narrow = shield({ radius: 30, gripWidth: 10 });
    const wide = shield({ radius: 30, gripWidth: 90 });
    const span = (p: typeof narrow) => boundsOf(p.mesh).max[0] - boundsOf(p.mesh).min[0];
    expect(span(narrow)).toBeCloseTo(60, -1);
    expect(span(wide)).toBeGreaterThan(80);
  });
});
