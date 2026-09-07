import type { Box3, Vec3 } from '../geom/types';
import type { Mesh } from '../mesh/types';

/**
 * A named place where one part fastens to another.
 *
 * Joints are declared, not discovered. `axis` points out of the material along
 * the fastener; `tangent` orients anything that is not rotationally symmetric.
 */
export interface Anchor {
  name: string;
  position: Vec3;
  axis: Vec3;
  tangent: Vec3;
  /** Nominal drilled diameter, where the anchor is a hole. */
  bore?: number;
}

/**
 * The unit every generator produces and every consumer takes.
 *
 * Deliberately says nothing about how the geometry was made, which is what let
 * the geometry layer be replaced without touching assembly or the DSL plan.
 */
export interface Part {
  name: string;
  mesh: Mesh;
  bounds: Box3;
  anchors: Anchor[];
  /** Optional override, so one form can mix metals the way real work does. */
  material?: { metal?: string; finish?: string };
  /** Radiance of a light, in sky units, overriding what its material says. */
  glow?: number;
  /** Enamel colour name, for a part whose mesh marks an enamelled face. */
  enamel?: string;
  /** Chased relief on a plate, for the shader to shade per pixel. */
  relief?: PlateRelief;
  /** Metal of the wires set along the veins of an enamelled plate, cloisonné fashion. */
  veinMetal?: string;
  /**
   * Whether a join to this part is soldered. False for the things that are
   * held rather than joined — a stone in its setting, a pearl on its post —
   * where a fillet of solder would be a lie about how the piece is made.
   */
  solderable?: boolean;
  /** Facets round a stone's pavilion, for the shader to bounce light off. */
  pavilionFacets?: number;
  /** A cut stone's facets as planes — normal and offset, four floats each, in the part's own space — for the shader to trace through. */
  gemPlanes?: Float32Array;
  /** The stone's width, the length its colour is judged over. */
  gemSize?: number;
  /** A pattern cut into the surface, drawn per pixel by the shader. */
  engraving?: Engraving;
  /** Lettering cut into the surface, drawn per pixel by the shader. */
  inscription?: Inscription;
}

/**
 * Lettering: a string of glyphs — characters in a font, or Elder Futhark
 * spelled from Latin — laid along a baseline in the surface's millimetre
 * coordinates and cut in by `depth`.
 */
export interface Inscription {
  script: 'text' | 'runes';
  text: string;
  font: 'serif' | 'sans' | 'mono';
  /** Em height in millimetres. */
  size: number;
  /** Cut depth in millimetres; negative raises the letters. */
  depth: number;
  /** Rotation in the surface, radians. */
  angle: number;
  /** Where the line's centre sits, as an offset in surface millimetres from the middle of the face. */
  at?: [number, number];
}

export const ENGRAVING_PATTERNS = [
  'hatch', 'crosshatch', 'guilloche', 'basketweave', 'rays', 'wave', 'stipple',
] as const;
export type EngravingPattern = (typeof ENGRAVING_PATTERNS)[number];

/**
 * An engraved pattern: a height field the shader evaluates in the surface's
 * own millimetre coordinates, so a groove keeps its width however coarse the
 * mesh under it. `depth` positive cuts in; negative raises, as chasing does.
 */
export interface Engraving {
  pattern: EngravingPattern;
  /** Pitch of the pattern's features, in millimetres. */
  scale: number;
  /** Groove depth in millimetres; negative for a raised pattern. */
  depth: number;
  /** Rotation of the pattern in the surface, radians. */
  angle: number;
}

/**
 * The parameters of a plate's vein relief, exactly as `deform` displaced it,
 * so the scene shader can evaluate the same height field per pixel and shade
 * a ridge smoothly however coarse the cap's lattice is.
 */
export interface PlateRelief {
  /** Ridge height. */
  height: number;
  /** Count of lateral ridges. */
  veins: number;
  length: number;
  halfWidth: number;
  /** Sideways bow of the midrib: spine(x) = sin(pi x / length) * droop * length. */
  droop: number;
  /** The box the cap uv is measured against: minX, minY, width, height. */
  span: [number, number, number, number];
}

export const findAnchor = (part: Part, name: string): Anchor => {
  const a = part.anchors.find((x) => x.name === name);
  if (!a) throw new Error(`part "${part.name}" has no anchor "${name}"`);
  return a;
};

export function meshBounds(mesh: Mesh): Box3 {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (p[i + k] < min[k]) min[k] = p[i + k];
      if (p[i + k] > max[k]) max[k] = p[i + k];
    }
  }
  return { min, max };
}
