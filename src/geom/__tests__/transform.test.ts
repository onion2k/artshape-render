import { describe, expect, it } from 'vitest';
import {
  determinant3, frameAlong, fromBasis, identity, invert, multiply, reflection,
  rotationAbout, transformDirection, transformPoint, translation, uniformScale,
} from '../transform';
import { dot, len } from '../vec';
import { expectMat, expectVec } from './helpers';

describe('identity and translation', () => {
  it('identity leaves a point unmoved', () => {
    expectVec(transformPoint(identity(), [1, 2, 3]), [1, 2, 3]);
  });

  it('translation moves a point by the given offset and nothing else', () => {
    const m = translation([5, -2, 1]);
    expectVec(transformPoint(m, [0, 0, 0]), [5, -2, 1]);
    expectVec(transformPoint(m, [1, 1, 1]), [6, -1, 2]);
  });

  it('translation does not affect a direction', () => {
    const m = translation([5, -2, 1]);
    expectVec(transformDirection(m, [1, 0, 0]), [1, 0, 0]);
  });
});

describe('rotationAbout', () => {
  it('rotates 90 degrees about Z: X onto Y', () => {
    const m = rotationAbout([0, 0, 1], Math.PI / 2);
    expectVec(transformPoint(m, [1, 0, 0]), [0, 1, 0]);
  });

  it('rotates 90 degrees about X: Y onto Z', () => {
    const m = rotationAbout([1, 0, 0], Math.PI / 2);
    expectVec(transformPoint(m, [0, 1, 0]), [0, 0, 1]);
  });

  it('leaves a point on the axis fixed', () => {
    const m = rotationAbout([0, 0, 1], 1.3);
    expectVec(transformPoint(m, [0, 0, 7]), [0, 0, 7]);
  });

  it('a full turn is the identity', () => {
    const m = rotationAbout([0.3, 0.5, 0.8], Math.PI * 2);
    expectMat(m, identity());
  });

  it('normalizes an unnormalized axis', () => {
    const a = rotationAbout([0, 0, 1], Math.PI / 3);
    const b = rotationAbout([0, 0, 5], Math.PI / 3);
    expectMat(a, b);
  });

  it('preserves length (a rotation is an isometry)', () => {
    const m = rotationAbout([1, 1, 1], 0.7);
    const p = transformPoint(m, [3, -1, 2]);
    expect(len(p)).toBeCloseTo(len([3, -1, 2]));
  });
});

describe('uniformScale', () => {
  it('scales every axis equally', () => {
    const m = uniformScale(2);
    expectVec(transformPoint(m, [1, 2, 3]), [2, 4, 6]);
  });
});

describe('reflection', () => {
  it('reflects a point through the plane with the given normal', () => {
    const m = reflection([1, 0, 0]);
    expectVec(transformPoint(m, [1, 2, 3]), [-1, 2, 3]);
  });

  it('leaves a point in the mirror plane fixed', () => {
    const m = reflection([1, 0, 0]);
    expectVec(transformPoint(m, [0, 5, -3]), [0, 5, -3]);
  });

  it('has a negative determinant', () => {
    expect(determinant3(reflection([0, 1, 0]))).toBeLessThan(0);
  });

  it('applied twice is the identity', () => {
    const m = reflection([0.6, 0.8, 0]);
    expectMat(multiply(m, m), identity());
  });
});

describe('fromBasis', () => {
  it('places the origin and columns as given', () => {
    const m = fromBasis([1, 2, 3], [1, 0, 0], [0, 1, 0], [0, 0, 1]);
    expectVec(transformPoint(m, [0, 0, 0]), [1, 2, 3]);
    expectVec(transformDirection(m, [1, 0, 0]), [1, 0, 0]);
    expectVec(transformDirection(m, [0, 1, 0]), [0, 1, 0]);
    expectVec(transformDirection(m, [0, 0, 1]), [0, 0, 1]);
  });

  it('scales the basis vectors when a scale is given', () => {
    const m = fromBasis([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 3);
    expectVec(transformDirection(m, [1, 0, 0]), [3, 0, 0]);
  });
});

describe('multiply', () => {
  it('is the identity when either side is identity', () => {
    const m = rotationAbout([0, 1, 0], 0.4);
    expectMat(multiply(identity(), m), m);
    expectMat(multiply(m, identity()), m);
  });

  it('applies b first, then a: translating after rotating', () => {
    // rotate 90 about Z, then translate by (1, 0, 0)
    const rot = rotationAbout([0, 0, 1], Math.PI / 2);
    const move = translation([1, 0, 0]);
    const combined = multiply(move, rot);
    // (1, 0, 0) rotates to (0, 1, 0), then translates to (1, 1, 0)
    expectVec(transformPoint(combined, [1, 0, 0]), [1, 1, 0]);
  });

  it('is associative', () => {
    const a = rotationAbout([0, 0, 1], 0.3);
    const b = translation([1, 2, 3]);
    const c = uniformScale(2);
    expectMat(multiply(multiply(a, b), c), multiply(a, multiply(b, c)), 4);
  });
});

describe('transformPoint vs transformDirection', () => {
  it('transformDirection rotates but ignores translation', () => {
    const m = multiply(translation([10, 0, 0]), rotationAbout([0, 0, 1], Math.PI / 2));
    expectVec(transformDirection(m, [1, 0, 0]), [0, 1, 0]);
    expectVec(transformPoint(m, [1, 0, 0]), [10, 1, 0]);
  });
});

describe('determinant3', () => {
  it('is 1 for the identity', () => {
    expect(determinant3(identity())).toBeCloseTo(1);
  });

  it('is 1 for a pure rotation', () => {
    expect(determinant3(rotationAbout([1, 2, 3], 1.1))).toBeCloseTo(1);
  });

  it('is the cube of the scale for a uniform scale', () => {
    expect(determinant3(uniformScale(2))).toBeCloseTo(8);
  });

  it('is negative for a single reflection', () => {
    expect(determinant3(reflection([0, 0, 1]))).toBeLessThan(0);
  });
});

describe('frameAlong', () => {
  it('places +X along the given direction', () => {
    const m = frameAlong([0, 0, 0], [0, 1, 0]);
    expectVec(transformDirection(m, [1, 0, 0]), [0, 1, 0]);
  });

  it('produces an orthonormal, right-handed basis', () => {
    const m = frameAlong([1, 1, 1], [1, 1, 0], [0, 0, 1]);
    const x = transformDirection(m, [1, 0, 0]);
    const y = transformDirection(m, [0, 1, 0]);
    const z = transformDirection(m, [0, 0, 1]);
    expect(len(x)).toBeCloseTo(1);
    expect(len(y)).toBeCloseTo(1);
    expect(len(z)).toBeCloseTo(1);
    expect(dot(x, y)).toBeCloseTo(0);
    expect(dot(x, z)).toBeCloseTo(0);
    expect(dot(y, z)).toBeCloseTo(0);
    expect(determinant3(m)).toBeCloseTo(1);
  });

  it('falls back to a well-defined frame when the hint is parallel to x', () => {
    const m = frameAlong([0, 0, 0], [0, 0, 1], [0, 0, 5]);
    expect(determinant3(m)).toBeCloseTo(1);
  });
});

describe('invert', () => {
  it('undoes a translation', () => {
    const m = translation([3, -4, 5]);
    const inv = invert(m)!;
    expectVec(transformPoint(inv, transformPoint(m, [1, 2, 3])), [1, 2, 3]);
  });

  it('undoes a rotation', () => {
    const m = rotationAbout([0.3, 0.7, 0.2], 1.4);
    const inv = invert(m)!;
    expectMat(multiply(m, inv), identity(), 4);
  });

  it('undoes a general composed transform', () => {
    const m = multiply(
      translation([2, -1, 5]),
      multiply(rotationAbout([0, 1, 0], 0.9), uniformScale(2.5)),
    );
    const inv = invert(m)!;
    expectMat(multiply(m, inv), identity(), 3);
    expectVec(transformPoint(inv, transformPoint(m, [1, -2, 3])), [1, -2, 3], 3);
  });

  it('returns null for a singular matrix', () => {
    const singular = new Float32Array(16); // all zero: determinant 0
    expect(invert(singular)).toBeNull();
  });
});
