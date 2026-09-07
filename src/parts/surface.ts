import { scaledCount } from '../mesh/detail';
import type { Vec3 } from '../geom/types';
import { bezierPatch, helicoid, mobius, ripple, saddle, shell, surface, type SurfaceFn } from '../mesh/surface';
import { meshBounds, type Anchor, type Part } from './types';

/**
 * Mathematical solids: sheets shaped by a function and thickened into
 * shells. Each has a `face` anchor at the middle of its top sheet, pointing
 * along the surface normal there, and a `back` opposite, so it can carry
 * or be mounted like a plate.
 */
export interface SheetSpec {
  name?: string;
  thickness?: number;
  segments?: number;
  enamel?: string;
}

function sheetPart(name: string, f: SurfaceFn, spec: SheetSpec, closedU = false, closedV = false, aspect = 1): Part {
  const thickness = spec.thickness ?? 0.8;
  const segments = scaledCount(spec.segments ?? 48);
  const mesh = surface(f, {
    thickness,
    segmentsU: segments,
    segmentsV: Math.max(4, Math.round(segments / aspect)),
    closedU, closedV,
    enamelTop: !!spec.enamel,
  });
  // the middle of the sheet and its normal there, from the function itself
  const h = 1e-3;
  const p = f(0.5, 0.5);
  const du = sub(f(0.5 + h, 0.5), f(0.5 - h, 0.5));
  const dv = sub(f(0.5, 0.5 + h), f(0.5, 0.5 - h));
  const n = normalize(cross(du, dv));
  const t = normalize(du);
  const anchors: Anchor[] = [
    { name: 'face', position: [p[0] + n[0] * thickness / 2, p[1] + n[1] * thickness / 2, p[2] + n[2] * thickness / 2], axis: n, tangent: t },
    { name: 'back', position: [p[0] - n[0] * thickness / 2, p[1] - n[1] * thickness / 2, p[2] - n[2] * thickness / 2], axis: [-n[0], -n[1], -n[2]], tangent: t },
  ];
  return { name: spec.name ?? name, mesh, bounds: meshBounds(mesh), anchors, enamel: spec.enamel };
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export interface SaddleSpec extends SheetSpec { width: number; depth: number; rise: number }
export function saddlePart(spec: SaddleSpec): Part {
  return sheetPart('saddle', saddle(spec.width, spec.depth, spec.rise), spec, false, false, spec.width / spec.depth);
}

export interface RippleSpec extends SheetSpec { width: number; depth: number; amplitude: number; waves: number }
export function ripplePart(spec: RippleSpec): Part {
  return sheetPart('ripple', ripple(spec.width, spec.depth, spec.amplitude, spec.waves), spec, false, false, spec.width / spec.depth);
}

export interface HelicoidSpec extends SheetSpec { radius: number; height: number; turns: number }
export function helicoidPart(spec: HelicoidSpec): Part {
  return sheetPart('helicoid', helicoid(spec.radius, spec.height, spec.turns), spec, false, false, 4);
}

export interface MobiusSpec extends SheetSpec { radius: number; width: number; twists?: number }
export function mobiusPart(spec: MobiusSpec): Part {
  // an odd number of half-twists meets itself flipped, an even one square; both close
  return sheetPart('mobius', mobius(spec.radius, spec.width, spec.twists ?? 1), spec, true, false, 6);
}

export interface ShellSpec extends SheetSpec { radius: number; tube: number; turns?: number; growth?: number; height?: number }
export function shellPart(spec: ShellSpec): Part {
  const turns = spec.turns ?? 3;
  return sheetPart(
    'shell',
    shell(spec.radius, spec.tube, turns, spec.growth ?? 2.2, spec.height ?? spec.radius * 1.5),
    { ...spec, segments: spec.segments ?? Math.round(48 * turns) },
    false, true, 3,
  );
}

export interface PatchSpec extends SheetSpec { net: Vec3[] }
export function patchPart(spec: PatchSpec): Part {
  return sheetPart('patch', bezierPatch(spec.net), spec);
}
