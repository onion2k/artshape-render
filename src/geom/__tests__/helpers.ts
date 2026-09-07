import { expect } from 'vitest';
import type { Vec3 } from '../types';
import type { Mat4 } from '../transform';

export function expectVec(a: Vec3, b: Vec3, precision = 5) {
  expect(a[0]).toBeCloseTo(b[0], precision);
  expect(a[1]).toBeCloseTo(b[1], precision);
  expect(a[2]).toBeCloseTo(b[2], precision);
}

export function expectMat(a: Mat4, b: Mat4 | number[], precision = 5) {
  for (let i = 0; i < 16; i++) expect(a[i]).toBeCloseTo(b[i], precision);
}
