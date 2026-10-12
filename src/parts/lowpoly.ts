/**
 * A toy's faceted scenery, cut with flat faces so every facet catches the
 * light on its own and a tree reads as a toy's: a broadleaf of faceted lumps
 * with a lighter crown, a conifer of stacked cones, a far tree of a few
 * faces, a bush, a spiky fern and a boulder. Each is cheap, since a game
 * draws every placement more than once a frame.
 *
 * There are no colours here and no materials. A part is a named mesh
 * (`trunk`, `leaves`, `crown`, `bush`, `fern`, `rock`) and the game colours
 * it by name, so two games can dress one tree differently. Each stands on the
 * ground at its origin, a tree's top is its height, and what varies from one
 * to the next comes from `seed`, so the same seed is the same mesh. Height
 * scales every dimension evenly, so a game may make one mesh and instance it
 * at any height. Without this each game would carry its own copy of the
 * generators.
 */
import type { Vec3 } from '../geom/types';
import { at, built, faceOut, frustum, lump, seeded } from '../mesh/lowpoly';
import type { MeshBuilder, Mesh } from '../mesh/types';

/** One named mesh of a piece of scenery: the game gives it a colour by its name. */
export interface ScenePart {
  name: string;
  mesh: Mesh;
}

/** A piece of scenery: its kind, and the named meshes it is made of. */
export interface Scenery {
  name: string;
  parts: ScenePart[];
}

/** How finely the faceted shapes are cut: the rings and segments of a lump, the sides of a cone and a trunk. Chunky, so it reads as a toy's. */
export const FACETS = {
  rings: 3,
  segments: 6,
  cone: 6,
  trunk: 6,
  rockRings: 3,
  rockSegments: 5,
  /** A broadleaf's lumps, rounder than a bush's: a crown of twenty-four facets reads as a die. */
  crown: { rings: 4, segments: 8 },
} as const;

/** A trunk of `sides` flat faces from radius `r` at the ground, tapering to seven tenths of it at `top`: open, since it stands in its canopy. */
function trunk(b: MeshBuilder, r: number, top: number, sides: number = FACETS.trunk) {
  frustum(b, at(0, 0, 0), sides, r * 1.25, r * 0.7, 0, top, { top: false });
}

/**
 * A broadleaf `height` tall: a trunk up into three faceted lumps round its
 * middle and a lighter one on top, as a canopy is lit from above. The crown's
 * top is the tree's height. Parts: `trunk`, `leaves`, `crown`.
 */
export function broadleaf({ height = 7, seed = 1 } = {}): Scenery {
  const random = seeded(seed * 9973 + 11);
  const { rings, segments } = FACETS.crown;
  const R = 0.4 * height;
  const crownR = 0.68 * R;
  const crownZ = height - 0.6 * R;
  const turn = random() * Math.PI * 2;
  const leaves = built((b) => {
    for (let k = 0; k < 3; k++) {
      const a = turn + (k / 3) * Math.PI * 2;
      const r = R * (0.62 + random() * 0.1);
      lump(
        b,
        at(Math.cos(a) * R * 0.45, Math.sin(a) * R * 0.45, crownZ - 0.5 * R, a),
        random,
        rings,
        segments,
        [r, r, r * 0.9],
        { give: 0.12 },
      );
    }
  });
  // the crown's top stays where it is, `crownR * 0.88` above its middle, and that is the tree's height
  const crown = built((b) =>
    lump(
      b,
      at(0, 0, height - crownR * 0.88, random() * Math.PI * 2),
      random,
      rings,
      segments,
      [crownR, crownR, crownR * 0.88],
      { give: 0.12 },
    ),
  );
  return {
    name: 'broadleaf',
    parts: [
      { name: 'trunk', mesh: built((b) => trunk(b, 0.3 * (height / 7), 0.62 * height)) },
      { name: 'leaves', mesh: leaves },
      { name: 'crown', mesh: crown },
    ],
  };
}

/** A conifer `height` tall: `tiers` faceted cones stacked on a short trunk, each narrower than the one below. Parts: `trunk`, `leaves`. */
export function conifer({ height = 8, seed = 1, tiers = 4 } = {}): Scenery {
  const random = seeded(seed * 6151 + 5);
  const leaves = built((b) => {
    for (let k = 0; k < tiers; k++) {
      const z0 = height * (0.16 + (0.62 / tiers) * k);
      const z1 = k === tiers - 1 ? height : z0 + height * 0.36;
      const r = height * (0.3 - (0.17 / tiers) * k) * (0.92 + random() * 0.14);
      frustum(b, at(0, 0, 0), FACETS.cone, r, 0, z0, z1, { bottom: true, phase: random() * Math.PI });
    }
  });
  return {
    name: 'conifer',
    parts: [
      { name: 'trunk', mesh: built((b) => trunk(b, 0.22 * (height / 8), 0.3 * height, 5)) },
      { name: 'leaves', mesh: leaves },
    ],
  };
}

/**
 * A tree on the far hills, a unit tall to be scaled: as few faces as still
 * read as a conifer (two five-sided cones) or a broadleaf (one lump of ten),
 * since a hill has a thousand of them. One part, `leaves`.
 */
export function farTree(kind: 'conifer' | 'broadleaf'): Scenery {
  const mesh = built((b) => {
    if (kind === 'conifer') {
      frustum(b, at(0, 0, 0), 5, 0.32, 0, 0.05, 0.62, { bottom: true });
      frustum(b, at(0, 0, 0), 5, 0.24, 0, 0.42, 1, { bottom: true, phase: 0.6 });
    } else lump(b, at(0, 0, 0.55), seeded(3), 2, 5, [0.38, 0.38, 0.45], { give: 0.1 });
  });
  return { name: `far ${kind}`, parts: [{ name: 'leaves', mesh }] };
}

/** A round bush about `size` across from its middle: three faceted lumps, flattened where they meet the ground. One part, `bush`. */
export function bush(size: number, { seed = 1 } = {}): Scenery {
  const random = seeded(seed * 4441 + 9);
  const { rings, segments } = FACETS;
  const mesh = built((b) => {
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + random();
      const r = size * (0.55 + random() * 0.2);
      lump(
        b,
        at(Math.cos(a) * size * 0.45, Math.sin(a) * size * 0.45, r * 0.4),
        random,
        rings,
        segments,
        [r, r, r * 0.85],
        { give: 0.15, floor: -r * 0.4 },
      );
    }
  });
  return { name: 'bush', parts: [{ name: 'bush', mesh }] };
}

/** A spiky plant about `size` tall: `blades` thin three-sided spikes leaning out from its root. One part, `fern`. */
export function fern(size: number, { seed = 1, blades = 9 } = {}): Scenery {
  const random = seeded(seed * 3301 + 2);
  const mesh = built((b) => {
    for (let k = 0; k < blades; k++) {
      const a = (k / blades) * Math.PI * 2 + random() * 0.5;
      const lean = 0.35 + random() * 0.5;
      const len = size * (0.7 + random() * 0.3);
      const tip: Vec3 = [Math.cos(a) * Math.sin(lean) * len, Math.sin(a) * Math.sin(lean) * len, Math.cos(lean) * len];
      const w = size * 0.16;
      const base = [0, 1, 2].map((i): Vec3 => [
        Math.cos(a + (i / 3) * Math.PI * 2) * w + Math.cos(a) * w,
        Math.sin(a + (i / 3) * Math.PI * 2) * w + Math.sin(a) * w,
        0,
      ]);
      const middle: Vec3 = [
        (base[0][0] + base[1][0] + base[2][0] + tip[0]) / 4,
        (base[0][1] + base[1][1] + base[2][1] + tip[1]) / 4,
        tip[2] / 4,
      ];
      for (let i = 0; i < 3; i++) faceOut(b, [base[i], base[(i + 1) % 3], tip], middle);
    }
  });
  return { name: 'fern', parts: [{ name: 'fern', mesh }] };
}

/**
 * A boulder about `size` across each way from its middle: a faceted lump
 * pushed in further than a canopy is, sunk a little and flat underneath, so
 * it sits on the ground and does not perch on it. One part, `rock`. `rings`
 * and `segments` cut it finer for a boulder that is seen large (a painted
 * edge wants facets to choose its ridges from); left out they are the chunky
 * counts of `FACETS`, so every call made before they existed is the same mesh.
 */
export function boulder(
  size: number,
  { seed = 1, rings = FACETS.rockRings, segments = FACETS.rockSegments }: { seed?: number; rings?: number; segments?: number } = {},
): Scenery {
  const random = seeded(seed * 7727 + 1);
  const mesh = built((b) =>
    lump(
      b,
      at(0, 0, -size * 0.15, random() * Math.PI * 2),
      random,
      rings,
      segments,
      [size, size * 0.82, size * 0.72],
      { give: 0.3, floor: -size * 0.1 },
    ),
  );
  return { name: 'boulder', parts: [{ name: 'rock', mesh }] };
}
