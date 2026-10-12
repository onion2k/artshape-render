# The painted edge in artshape-render: the production plan

Agreed on 12 October 2026 and built on `painted` from v0.37.0, parts 0 to 7
in commits b1c1769 to f9a0f5b, the tidy 2beeb45 and the docs after it. What
follows is the plan as written, with its boxes ticked, and this note says
where the build departed from it and why. It stops before the tag, which is
the user's.

## As built

- **A game that asks for none of it draws v0.37.0's frames to the bit.**
  Twenty-four frames (the standard scene, the golf scene and the toy ball,
  toon and physically based, one sample and four, redrawn and kept) hashed at
  bd26e65 in `painted-golden.json`, and the golden passes unchanged after
  every part.
- **The uniform is a bind group of its own, at group 1,** and not a binding
  of the scene's group. It is made only when a painted group is first handed
  in, so no layout, buffer or pipeline layout of a game that asks for none
  moved. The painted pipeline layout is its own.
- **The varyings are 7 to 12,** not the planned 7 to 14: six were enough, and
  the flowing, textured and carded builds, which use 7 and 8, still may not
  be painted (a group with paint and one of them is refused by name).
- **`PAINT_SET_FLOATS` is 40, not 32:** ten vec4s a set (the colours sit on
  sixteen-byte boundaries and the float after each fills its padding), so the
  uniform is 160 floats. A test lays the struct out by WGSL's rules and holds
  it to `PAINT_OFFSETS`.
- **The boulder finds 23 lines, not E21's 22,** by the tie rule written in
  the mesh pass (ties go to the first found); the new count is held exactly.
  A block's corners turn 90 degrees, past `maxTurn`, so no line chains on a
  block: its four top edges are four strokes and not one or two.
- **The hole slab has 40 concave triangle-edges,** its wall's corners
  included, and the test holds that figure and not a smaller one.
- **`taperThin` was not built.** The experiments' knob for thinning a stroke
  toward its tail is left out; `taper` is the one knob.
- **One noise drives the mark.** The loaded head and the dry tail, by noise or
  along the ridgeline, read a single world noise in the shader
  (`paintMark`, with `markAlong` blending the two forms), and not a noise for
  each.
- **The sheet lights with `form` at 3,** the cap in the toon light, as
  ooerfish's look will, and holds only that each frame drew and the paint
  changed it; the pictures were sent to the user on 13 October and their
  verdict on the defaults is pending. `boulder` gained `rings` and `segments`
  for it, its old counts the defaults.
- **A cliff of slabs under the gate rule reads as an outline.** The gate
  strokes every upper convex edge of every slab, so a cliff is outlined and
  not painted along its corners. A slab rule of its own is the named next
  plan, below, and not in this build.
- **The golden's scenes are shared through `scenes.ts`.** `standardScene`,
  `shoreScene` and `paintedStandard` moved from `perf.gpu.test.ts`, which the
  golden had imported (registering the perf suite as a skipped test in its
  file), into a helper both import. The hashes did not move.
- **What it costs** (apple/metal-3, M4 Pro, 1280x800): `standard` reads
  0.62 ms in five plain runs against its baseline of 0.60, inside the gate's
  15%; `standard painted` 0.733 ms, +0.11 ms, under the guessed +0.3;
  `shore` 0.67 and `shore painted` 0.907, so the paint is 0.24 ms over 200
  boulders. The renderer bundled and minified is 63,004 bytes gzipped at
  v0.37.0 and 67,116 here (+4,112); `src/mesh/paint.ts` is 3,326 of those
  and is tree-shaken out of a game that does not import it. Part 7's own
  `perf:gpu` run is in the commit that closes it.

Written 13 October 2026, from the experiments E1 to E21 in the worktree
`~/projects/artshape-render-painted` (branch `painted-experiments`, never
to be merged) and their report, `docs/specs/painted-experiments.md` there.
The facts hold on artshape-render `bd26e65` (v0.37.0), which is `main`.
To be built by the `builder` agent on `sonnet`, one part at a time, on a
branch `painted` from `main`, in a worktree of its own. Anything marked
*guess* was not measured.

## Aim

A game can give a group of faceted scenery a hand-painted edge: a few
chosen ridges carry a crisp stroke of a pale paint colour, with a loaded
head and a dry tail, sized by the facet, kept off the undersides, faded
where ridges crowd a vertex and as the thing shrinks on screen. The
experiments settled what it is and what it costs (0.10 ms a frame for the
attribute and band on the standard scene, about 4 kB gzipped of shader,
2.4 kB of mesh pass tree-shaken away if unused). A game that asks for none
of it draws the frame v0.37.0 draws, to the bit, and boots no slower.

## What the experiments decided, and this plan keeps

- **Meshes stay split.** Derivative normals dash on shared vertices (E2).
  The lighting normal stays the vertex's flat one; nothing is welded.
- **The edge is carried in the mesh** (E3b): per triangle its three edges'
  signed fold angles, heights, the corner index, the face's id and z
  extent, each edge's up-share, each corner's crowd, the chosen bits and
  the place along the chosen ridgeline. Coplanar triangles are merged into
  faces first (E9).
- **The lip is an absolute pale colour of its own hue, mixed into the
  albedo before the light** (E17), never laid over the lit colour (E14
  read as gloss) and never a multiple of the albedo (E15 vanished).
- **The choice is made in the mesh pass** (E18, E20, E21): a gate on the
  fold, upper ridges only, then either agreement between neighbouring
  faces or ridgelines with a budget and spacing. One flat setting does not
  suit slabs and boulders, so settings are per set, chosen per mesh.
- **No face layers.** The falloff, the per-face gradient, the hue wobble,
  the cracks and the smooth-normal wrap read as vertex shading or as crazy
  paving (E5, E6, E11) and are not built. The flat per-facet value
  (`facet`, E12) and the concave crease (`dark`) stay as knobs at nought.
- **No bevel on boulders** (E12). The light's shade, fill and occlusion are
  the game's look, not the paint, and are not in this plan.

## The interfaces

### `src/mesh/paint.ts` (new; the experiment's file is reference, not to be copied)

```ts
export const PAINT_STRIDE = 20;                       // five vec4 a vertex
export type PaintChoice = 'gate' | 'agree' | 'ridge';
export interface PaintOptions {
  set?: number;                                       // 0..3, which PaintSet the fragment reads; default 0
  quiet?: boolean;                                    // every layer at nought for this mesh (a ground); default false
  choice?: PaintChoice;                               // default 'gate'
  ridge?: { floor?: number; maxTurn?: number; budget: number; spacing?: number }; // budget is a count: the caller sizes it
  tolerance?: number;                                 // position match, default 1e-5
}
export interface PaintStats { triangles: number; faces: number; edges: { convex: number; concave: number; flat: number; open: number }; ridges?: { found: number; chosen: number } }
export function split(mesh: Mesh): Mesh;              // every triangle its own three vertices
export function painted(mesh: Mesh, options?: PaintOptions): Mesh & { paint: Float32Array; paintStats: PaintStats };
```

`painted` throws if an index is used by two triangles (call `split`
first; the solids' quads share two). The layout, documented in the file
and held by a test against `PAINT_LAYOUT`:

| floats | holds |
| --- | --- |
| 0..2 | signed fold angle of edge i (opposite corner i), radians, + convex, 0 flat or open |
| 3 | corner index 0, 1, 2 |
| 4..6 | height from corner i to edge i, mesh units |
| 7 | zMin of the face, 8 zMax, 9 face id (index + hash of first position) |
| 10 | quiet (0 or 1), 11 set (0..3) |
| 12..14 | per corner: crowd (count of convex edges over 0.3 rad at that position) + (upShare of edge i + 1) / 4 |
| 15 | chosen bits: bit i set if edge i carries the lip under `choice` |
| 16..18 | place along the chosen ridgeline at corner i, 0 at the higher end, 1 at the lower; 0 if none |
| 19 | spare, written 0 |

The budget is a count, not a size: the game knows the placement's scale
and gives a pebble 1 and a boulder 3 (`round(1 + 2 * worldRadius / 40)` is
what the lab used at scale 40, which the game translates to its units).
A pile is painted as separate lumps, one `painted` each, so each gets its
own budget; that is the caller's business.

### `src/game/paint.ts` (new): the knobs, their packing and the WGSL sums

```ts
export interface PaintSet { /* every knob below, each optional, defaults = PAINT_DEFAULT */ }
export const PAINT_DEFAULT: Required<PaintSet>;       // the settled recipe for rock
export const PAINT_SETS = 4, PAINT_SET_FLOATS = 40;   // packed per set; a test holds the count
export function packPaint(out: Float32Array, sets: readonly PaintSet[]): void;
export const PAINT_WGSL: string;                      // the band, the strokes, the lip, built from the same constants
```

Knobs, per set, with the recipe's values as the defaults (taste the user
chose through E11 to E21; a game may move any):

| knob | default | what |
| --- | --- | --- |
| width, widthFacet, widthPx, shareCap, fadePx | 0.2 world, 0.08 of the facet, 1 px floor, 0.25 cap, 6 px | the band's width: `max(width, widthFacet × facet)`, floored in pixels, capped at a share of the facet, faded as the facet shrinks |
| gate, ramp | 0.3, 0.15 rad | the fold an edge must pass, and how softly |
| ridgeUp | 0.3 | an edge's up-share below which it carries nothing |
| edgeAa, feather, featherWidth | 0.25, 0, 1 | the band's antialiasing half-width and inner feather |
| swell, swellScale, taper, broken, brokenScale | 0.3, 4, 0.2, 0, 8 | the stroke's width wobble and breaks (broken 0 under ridgelines: a chain is one stroke) |
| vertexFade, fadeReach | 1, 0.8 | the lip faded near a crowded vertex |
| light, lightColour | 1.3, (0.62, 0.55, 0.42) | the lip's strength and its absolute colour |
| sun, up, upPow, litCut | 0.6, 0.9, 2, 0 | the lip weighted toward sun-facing and up-facing faces |
| markValue, markScale, markEnd, markHue, markHueColour, markAlong | 0.6, 8, 0.8, 1, (0.66, 0.52, 0.36), 1 | the loaded head and dry tail, along the ridgeline when `markAlong` is 1 |
| dark, darkFactor | 0, 0.45 | the concave crease |
| facet | 0 | a flat value offset per face |

The sums are written once in TypeScript (`paintBand`, `paintStrength`,
`paintLip`) and once as WGSL from the same constants, as `toon.ts` does,
and a GPU test holds the shader to them on a device.

### `src/game/renderer.ts`

- `Look.paint?: PaintSet[]` (up to four; absent means `PAINT_DEFAULT` for
  every set). Packed into a uniform buffer of its own (`PAINT_SETS ×
  PAINT_SET_FLOATS` floats) when the look changes, so a game tunes it each
  frame for nothing and nothing recompiles.
- A `painted` `SceneVariant`, toon only: compiled the first time
  `setStatic` or `setDynamic` is handed a group whose mesh has `paint`, in
  every rung as the textured build is (`PAINTED_VARIANTS`); `prepare()`
  waits; until then the group draws through the plain build. A game that
  never hands one in compiles nothing and draws as it did. A physically
  based look draws a painted group plain (documented; the experiments were
  all toon).
- `PAINT_LAYOUT`: five `float32x4` attributes at vertex locations 3, 12,
  13, 14, 15 (free in every build that can be painted; the carded build
  uses 2 and 11 and is not painted), bound only for groups with `paint`.
  VsOut gains flat varyings at 7 to 14 in the painted build only (the
  flowing, textured and carded builds use 7 and 8 and are not painted).
- `Uploaded.paint` buffer, destroyed with the group; the kept static half
  bakes a painted group as any other.
- The fragment: the band from barycentrics × heights (the pixel footprint
  from `length(vec2(dpdx, dpdy))`, not `fwidth`), the gate, the up-share,
  the chosen bit, the crowd fade, the strokes, the lip mixed into the
  albedo before the ramp, dimmed by `litCut`; then the ramp and the rest
  as the toon build has them.

## Parts, in build order

Each part has its own tests, seen failing first, and `npm run typecheck &&
npm test` green before the next starts; the full check (`test:gpu`,
`perf:gpu`) runs once at the end. A box is ticked as its part lands.

- [x] **0. The golden.** (b1c1769) Before any change, on `main`: a GPU test
  `painted-unasked.gpu.test.ts` in the shape of `unasked.gpu.test.ts`
  hashes the standard scene, the golf scene and the toy ball, toon and
  physically based, at one sample and four, kept and not, into
  `painted-golden.json` for this adapter. Check: the file exists with the
  adapter's hashes and the test passes on `main`. This test must pass,
  unchanged, after every later part.

- [x] **1. The mesh pass without choice.** (a1b4d12; the hole slab has 40 concave triangle-edges, its wall's corners too) `src/mesh/paint.ts`: `split`,
  `painted` with `choice: 'gate'` only (floats 0..14, 19; 15 all bits set;
  16..18 zero). Node tests in `src/mesh/__tests__/paint.test.ts`: a `block`
  gives 12 triangles, 6 faces, 24 convex edges at π/2 exactly and 12 flat;
  the hole slab (E3b's: annulus, tubeIn, disc, frustum) gives its floor
  join negative and its lip positive; a `boulder` has no open edges;
  crowd counts on the block are 3 at every corner; every up-share is in
  [-1, 1]; the stride equals `PAINT_STRIDE` and a `boulder` with shared
  indices throws; and `painted` is deterministic (two calls, equal bytes).
  Check: those tests, and `scripts`-free: no change to the renderer yet.

- [x] **2. The choice.** (f70b0f8; the boulder finds 23 lines, not E21's 22, by a tie rule, and a block's corners turn 90° so nothing chains on it) `choice: 'agree'` (an edge chosen where both its
  faces pick it as their best by fold × up-share × length) and
  `choice: 'ridge'` (chains over `floor`, under `maxTurn`, scored, the top
  `budget` greedily with `spacing × bounding radius` exclusion; the along
  parameter with 0 at the higher end). Tests: on a `block` the chains are
  the four top edges in one or two lines (count held exactly), budget 1
  picks the longest, spacing of 2 radii leaves one; on `boulder(1, { seed:
  3 })` the counts found and chosen are held exactly (they are the seed's);
  no edge belongs to two lines; along runs 0 to 1 along a line. Check:
  the tests, and the mesh-pass stats logged for the boulder match E21's
  22 lines found at floor 0.15 and turn 50° (*guess*: the production
  chaining may differ in ties; if it does, say so and hold the new count).

- [x] **3. The knobs and the sums.** (c234509; PAINT_SET_FLOATS is 40, not 32: ten vec4s a set, 160 floats the uniform) `src/game/paint.ts`: `PaintSet`,
  `PAINT_DEFAULT`, `packPaint`, the TypeScript sums and `PAINT_WGSL`.
  Tests: the packing's float count equals `PAINT_SET_FLOATS`; a set with
  every knob absent packs the default; the band sum is 1 at the edge, 0
  at the width plus the footprint, and halves the width where the share
  cap binds; the strength sum is 0 below the gate and 1 above the ramp;
  the along mark is brightest at 0 and darkest at 1. Check: the tests.

- [x] **4. The build and the binding.** (772d1fc; the paint uniform is a bind group of its own at group 1, made only when asked, and the varyings are 7 to 12) The `painted` variant, the uniform,
  `PAINT_LAYOUT`, `Uploaded.paint`, `Look.paint`, `prepare()`. GPU tests
  in `painted.gpu.test.ts` (a new file, not the lab's): a painted `block`
  under the default set differs from the plain one only within the band
  (count the differing pixels and their distance to the projected edges,
  as E3b did); each knob moved from nought (or to nought) changes only
  what it says against the same look (as `toy.gpu.test.ts` does), one `it`
  per knob; a `quiet` mesh is byte-identical to the plain build; a group
  without `paint` in a scene with painted groups is byte-identical to
  itself drawn plain; the physically based look draws a painted group
  plain; and the sums on the device match `src/game/paint.ts` to within
  two levels. Part 0's golden still passes. Check: all of those green.

- [x] **5. The sheet.** (0fdc995; sheets sent to the user 13 Oct, their verdict on the defaults pending) A GPU test that draws the settled recipe on
  `boulder2`-like rocks (E10's `boulder` at 5 rings and 8 segments, which
  becomes `boulder(size, { seed, rings, segments })` with the old counts
  as defaults, held by `lowpoly.test.ts`), a row of eight sizes and a
  cliff of slabs under a `cliff` set, written as PNGs under
  `VITE_FRAME_DIR`, for the user to look at. Check: the pictures looked at
  by the user against E21 mine 3 and E18 mine 1, and the recipe's defaults
  moved if they ask.

- [x] **6. Cost.** (f9a0f5b; standard painted +0.11 ms, the paint +0.24 ms over 200 boulders, +4.1 kB gzipped bundled, the mesh pass 3.3 kB) `perf:gpu` gains `standard painted` (the standard scene
  with the boxes painted and the ground not) and `shore painted` (200
  boulders painted on the plain ground), judged against the baseline
  written on the same run; `standard` itself must read within the gate's
  tolerance of its baseline, five alternated rounds. Download: the
  renderer bundled and minified before and after, by the byte, in the
  report. Budget: `standard painted` under `standard` + 0.3 ms (*guess*
  from E7's 0.10 for the band and 0.15 with the strokes). Check: the gate
  green and the figures in the report.

  **Cost** (apple/metal-3, M4 Pro, 1280x800, run on the tree at 0fdc995 plus
  the new rows). `standard`, five plain runs of `npm run perf:gpu`: 0.62,
  0.62, 0.62, 0.62, 0.62 ms against the baseline's 0.60 (+3%, inside the
  gate's 15%; the file's 0.597 was written on an earlier run, and the
  baseline was not moved). New rows, written once and then held in five
  runs: `standard painted` 0.733 ms (readings 0.73, 0.73, 0.73, 0.74, 0.74),
  so +0.11 ms over `standard`, under the guessed +0.3 budget. `shore`
  (200 plain boulders, 201 groups) 0.67 ms; `shore painted` 0.907 ms
  (readings 0.90 to 0.91); the paint's own cost over 200 boulders is
  0.24 ms (0.907 - 0.67). Download, `GameRenderer` bundled and minified
  with esbuild, `gzip -9`: v0.37.0 (bd26e65) 213,840 raw / 63,004 gz; this
  tree 228,429 raw / 67,116 gz; +14,589 raw / +4,112 gz. `src/mesh/paint.ts`
  bundled alone: 7,129 raw / 3,326 gz.

- [x] **7. Docs and release.** (docs, spec and version at 0.38.0; the tag is the user's) README: a section "A painted edge" in the
  game path's list, saying what it is, the layout, the knobs and the cost;
  CLAUDE.md: the model feature ("scenery with a painted edge": `paint.ts`
  in `mesh/` and `game/`, the tests, the perf rows); `docs/specs/painted.md`
  is this plan with an "as built" note on top, as `toy.md` is;
  `docs/specs/painted-experiments.md` copied in from the worktree; the
  consumers table unchanged. Tag v0.38.0. Check: `npm run typecheck && npm
  test`, `test:gpu`, `perf:gpu` all green on the tag; the golden passes.

## Out of scope, and the next plan

- **ooerfish's side** is a plan of its own after v0.38.0 lands: the pin
  moved; the boulders and the cliff through `painted` with budgets by
  world size; the halved rock and darker cabin colours in `palette.ts`;
  the shade, fill, sun and occlusion of E12's pick in `look.ts` (noting
  `form` is capped at 3 and the game runs occlusion at 0 today); the look
  pictures written again and looked at; `game.scenery()` counting painted
  groups; the perf baseline written again with the bytes said.
- **Trees carry nothing** (E6, E11). **Wood** (a jetty, a cabin) takes the
  same code under a set of its own; its parts are the game's.
- **A pile as one mesh with per-lump budgets**, **a slab rule of its own**
  (a cliff's ridgelines run down its corners), **the silhouette rule**, and
  **the ribbon stroke as a card** are named in the experiments' report and
  not here.
- **The lab's toggle, modes, sheets and knobs that were dropped** stay in
  the worktree, which is cleared once v0.38.0 is tagged and this plan's
  report says what of it was kept.

## What is handed back

A report per part (the builder's), and one at the end: the figures from
part 6, the golden's state, the bundle bytes, the pictures of part 5, and
every departure from this plan with its reason, in `docs/specs/painted.md`.
