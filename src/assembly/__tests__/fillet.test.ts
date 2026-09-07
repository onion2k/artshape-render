import { describe, expect, it } from 'vitest';
import { Assembly } from '../assembly';
import { solderFillet, type FilletCache } from '../fillet';
import { rivet } from '../../parts/fastener';
import { bar } from '../../parts/panel';
import { pearl } from '../../parts/pearl';
import { gem } from '../../parts/gem';
import { setting } from '../../parts/setting';

describe('solderFillet: solderability', () => {
  it('adds a fillet when both parts are ordinary metal', () => {
    const a = new Assembly();
    const cache: FilletCache = new Map();
    const plate = a.place(bar({ length: 20, width: 4, thickness: 1.5, bore: 2 }));
    const post = a.connect(plate.anchor('a'), rivet({ headDiameter: 3, headHeight: 1, shankDiameter: 2, grip: 1 }), 'seat');
    const result = solderFillet(a, plate, plate.anchor('a'), post, 'seat', cache);
    expect(result).not.toBeNull();
    expect(result!.part.name).toBe('solder');
  });

  it('returns null when the placed part is not solderable (a stone in its setting)', () => {
    const a = new Assembly();
    const cache: FilletCache = new Map();
    const mount = a.place(setting({ width: 6 }));
    const stone = a.connect(mount.anchor('seat'), gem({ width: 6 }), 'seat');
    expect(stone.part.solderable).toBe(false);
    const result = solderFillet(a, mount, mount.anchor('seat'), stone, 'seat', cache);
    expect(result).toBeNull();
  });

  it('returns null when the owner part is not solderable (built on a pearl, hypothetically)', () => {
    const a = new Assembly();
    const cache: FilletCache = new Map();
    const post = a.place(pearl({ radius: 4 }));
    const cap = a.connect(post.anchor('crown'), rivet({ headDiameter: 2, headHeight: 0.5, shankDiameter: 1, grip: 0.5 }), 'seat');
    const result = solderFillet(a, post, post.anchor('crown'), cap, 'seat', cache);
    expect(result).toBeNull();
  });
});

describe('solderFillet: cache reuse', () => {
  it('two joins of the same size and material share one Part object', () => {
    const a = new Assembly();
    const cache: FilletCache = new Map();
    const plateSpec = () => bar({ length: 20, width: 4, thickness: 1.5, bore: 2 });
    const rivetSpec = () => rivet({ headDiameter: 3, headHeight: 1, shankDiameter: 2, grip: 1 });

    const plate1 = a.place(plateSpec());
    const post1 = a.connect(plate1.anchor('a'), rivetSpec(), 'seat');
    const fillet1 = solderFillet(a, plate1, plate1.anchor('a'), post1, 'seat', cache);

    const plate2 = a.place(plateSpec());
    const post2 = a.connect(plate2.anchor('a'), rivetSpec(), 'seat');
    const fillet2 = solderFillet(a, plate2, plate2.anchor('a'), post2, 'seat', cache);

    expect(fillet1!.part).toBe(fillet2!.part);
  });

  it('the fillet is placed centred on the target anchor', () => {
    const a = new Assembly();
    const cache: FilletCache = new Map();
    const plate = a.place(bar({ length: 20, width: 4, thickness: 1.5, bore: 2 }));
    const post = a.connect(plate.anchor('a'), rivet({ headDiameter: 3, headHeight: 1, shankDiameter: 2, grip: 1 }), 'seat');
    const target = plate.anchor('a');
    const result = solderFillet(a, plate, target, post, 'seat', cache)!;
    expect(result.matrix[12]).toBeCloseTo(target.position[0], 4);
    expect(result.matrix[13]).toBeCloseTo(target.position[1], 4);
    expect(result.matrix[14]).toBeCloseTo(target.position[2], 4);
  });

  it('is added to the assembly\'s own placement list, not just returned', () => {
    const a = new Assembly();
    const cache: FilletCache = new Map();
    const plate = a.place(bar({ length: 20, width: 4, thickness: 1.5, bore: 2 }));
    const post = a.connect(plate.anchor('a'), rivet({ headDiameter: 3, headHeight: 1, shankDiameter: 2, grip: 1 }), 'seat');
    const before = a.placements.length;
    solderFillet(a, plate, plate.anchor('a'), post, 'seat', cache);
    expect(a.placements.length).toBe(before + 1);
  });
});
