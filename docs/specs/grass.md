# Grass on the game path: a spec

Agreed on 2026-09-27 and built on the branch after v0.18.0. What follows
is the spec as agreed; this note says where the build departed from it,
and why.

## As built

- **The cost.** The golf field adds 0.36 ms to the standard scene at the
  home view on an M4 Pro (92,168 blades: 86,609 near, 5,559 far), against
  the 2.0 ms budget, which `perf:gpu` holds. The spec's estimate was 1.5
  ms. It drew fewer blades than estimated (the frustum cuts most of the
  rough), and each costs less than a group's did. The wind adds 0.11–0.13
  ms, and its rung is kept. Nearest zoom is 1.22 ms, and half density 0.77.
- **The tolerance stays at 15%.** Mid-build an image generator shared the
  GPU and moved every scene 10–30% together. Widening the gate to fit a busy
  machine was tried and undone. The rule is now to run it on a quiet
  machine, and otherwise judge a change against its parent run alternately.
- **The frame-diff script was not built.** The refactor was proved more
  strongly: the WGSL of all 32 builds hashed the same before and after.
- **Criterion 5 (stripes)** is held as alternate bands of blades differing
  by more than 10% in turn, not "by the shade within 20%". A clamped toon
  frame does not keep a shade proportional.
- **Criterion 9 (half density)** draws 55% of the blades, not half. A blade
  is drawn while its rank is under the kept share plus the band it shrinks
  over, and the extra 5% are the partly sunk ones. Without that band, near
  blades would shrink too.
- **Criterion 12 (shadow and fog)** is held relative to the ground: blades
  in a shadow darken by what the earth among them darkens by, within 0.1,
  and fog brings grass and bare earth nearer alike.
- **`grassGround`** stays the plain root-to-tip average. An average weighted
  by area was tried on a picture judged by eye. On screen it put the ground
  seven levels off the green where the plain average is one and a half, so
  a test now holds the match.
- **Blades read and write as `vec4u`** (a float's bits and the id), since a
  bit pattern stored through a float may be canonicalised on some GPUs.
- **Everything in the API section was built.** One thing is held more
  weakly than the rest. That gusts travel downwind is tested on the
  TypeScript `gust`; its WGSL copy is checked only by the picture changing
  between two moments and holding still at one.

---

Draft as agreed. It is based on v0.18.0 (c83a5c0), and the measurements
were taken on this worktree at that commit.

## What

A field of real grass that a game on the game path can ask for. The blades
are generated on the GPU from a seed and a mask that the game draws of its
ground. They bend in a wind that the game drives from its own clock. They
lie flat where the game presses them, and stand again over a few seconds.
They thin out with distance, so a field that runs to the horizon costs what
its near part does. A game that does not ask for grass draws the same frame
to the pixel and compiles nothing new.

The need comes from ooergolf. It wants a short, dense, striped green
(blades 0.1 to 0.2 units tall), a fairway (about 0.3) and a rough (0.6 to
1.0, sparser). All of them should move in the breeze, and the ball should
flatten a track through them. A world unit is 10 cm there. The camera is
fov 40°, 0.78 rad from straight down, 30 to 110 units back (62 at home),
with `shading: 'toon'`, `tone: 'clamp'`, daylight, occlusion and a thin fog.

## Where it stands now

Each item was checked against the code at v0.18.0:

- **Particles** (`particles.ts`) are simulated on the GPU with compute
  passes into a fixed ring. Their capacity is a constructor argument,
  16384 by default (arena asks for 32768).
- **Sprites** are capped at 256 (`SPRITE_CAPACITY`).
- **GameGroups** are one instanced `drawIndexed` per group, with a matrix
  (64 B), a material (16 B) and a pattern (32 B) per placement. They have no
  culling and no level of detail, and every group is drawn up to three
  times a frame: into the sun's shadow map, into the occlusion's depth
  prepass, and into the scene.
- **Nothing** in `src/game` bends anything in a vertex shader, has a wind,
  draws indirectly, or places meshes on the GPU.
- **Time:** `frame(target, mode, dt)` adds `dt` to a private `postTime`,
  which the grain and the fog's noise read. There is no game-given clock.
- **The scene shader** is one WGSL string (`SCENE` in `shaders.ts`). Its
  variants are module constants (`cullLights`, `points`, `shadows`,
  `patterned`, `toon`), and all 32 builds are compiled before `ready`. The
  vertex and fragment stages are in the same string.
- **The game path has no MSAA.** The scene pass is single-sampled, so
  anything under a pixel wide aliases.

### The measurement: blades through a GameGroup today

The rig was a scratch GPU test, now deleted. It drew fields of 5-triangle
blades (7 vertices) scattered at random over 60×60 units, as one static
GameGroup over a ground plane. It used ooergolf's look (toon, clamp,
daylight, a sun shadow fitted to the field, occlusion at 2 and 2.5, fog),
its home camera, and a 1280×800 target. Each figure is the per-frame
throughput time: 10 frames to warm up, then 7 runs of 30 frames, and the
median run. The machine was an Apple M4 Pro (`apple/metal-3`). Two runs
agreed within 1–6%.

| Field | Full | No shadows | No occlusion | Neither |
| --- | ---: | ---: | ---: | ---: |
| empty (ground only) | 0.63–0.68 ms | 0.47–0.53 | 0.34–0.39 | 0.25 |
| green, h 0.15, w 0.04: 50k | 0.93 | 0.73–0.76 | 0.58–0.60 | 0.40–0.41 |
| 200k | 2.02 | 1.56 | 1.38–1.40 | 0.93–0.96 |
| 500k | 4.28 | 3.25 | 3.04 | 2.04 |
| 1M | 7.81–7.92 | 5.98 | 5.65–5.72 | 3.86–3.95 |
| 2M | 15.4–16.2 | 11.6 | 11.3–11.5 | 7.56–7.63 |
| rough, h 0.8, w 0.08: 50k | 1.10 | 0.88–0.91 | 0.67–0.73 | 0.50–0.53 |
| 200k | 2.61–2.67 | 2.13–2.18 | 1.91–1.98 | 1.46–1.47 |
| 500k | 5.95 | 4.83 | 4.45–4.50 | 3.36–3.40 |
| 1M | 11.8 | 9.55–9.94 | 8.54–9.39 | 6.61–6.75 |

What it says:

- **The cost is linear in blades.** A drawn blade costs about 7.6 ns in
  total (green size) and 11.6 ns (rough size), of which the scene pass
  alone is 3.7 and 6.4.
- **The shadow map and the occlusion prepass together are half of the
  cost.** The shadow map is about 1.9 ms a million and the prepass about
  2.2. A grass path that keeps blades out of both halves its cost.
- **ooergolf's frame is 1.3 ms now** (`smoke/perf-baseline.json`), against
  an 8 ms budget. It has seven holes of 53 to 84 grass tiles, which is 480
  to 760 square units of green, and about 10,000 square units of rough
  within its tufts' reach of 34.

### What a blade is on screen

At the home view a pixel spans about 0.056 units at the target. At the
nearest zoom (30) it is 0.027, and at the furthest (110) it is 0.10.

- **A mown blade 0.15 tall** stands about 1.9 pixels high and 0.7 wide
  from 0.78 rad at the home view (3.9 high at the nearest zoom).
- **A rough blade 0.8 tall** is about 10 pixels high at home and 20 up
  close.

So on the green a real blade is at the size of the pixel grid. With no
MSAA, blades of real width would shimmer as the camera follows the ball.
The spec widens a blade to at least a pixel (see Looks). The green reads
as grass through its colour and its movement, not as blades you can pick
out, until the camera is near.

## Decisions

### 1. The field is a mask over a grid, drawn by the game

**Recommended.** The game hands over a grid over its ground:

- an origin, a cell size and a size in cells;
- a byte per cell saying which kind grows there (0 for none);
- a height per cell saying where the ground is;
- a table of up to eight kinds;
- a kind and a height for everywhere outside the grid, so the rough runs
  to the horizon without the grid having to.

Each kind has:

- blades per square unit;
- height, and how much it varies;
- root width;
- a root colour and a tip colour, and how much a blade's colour varies;
- roughness;
- a lean at rest;
- `give`, how much the wind moves it;
- optionally, stripes.

- **Why a mask and not regions:** ooergolf's course is a tile map, and the
  places grass must not grow are shapes: the cup's disc, the rail's
  footprint, water, a conveyor, a windmill's base. The game already
  rasterises those. A mask at 0.25 units cuts the cup's 1.45 radius well
  (at home that is about 4 pixels a cell), and it lets future courses draw
  fairways and rough in any shape.
- **Cost:** a byte and a float per cell. ooergolf's course plus the reach
  round it is about 100×110 units, or 400×440 cells at 0.25, which is
  176 KB of mask and 704 KB of heights. The grid is held to at most
  1024×1024 cells, and a larger one is refused when it is set.
- **Alternative: polygons per region.** They are smoother at edges. The
  game would have to build them, and the GPU would need a point-in-polygon
  test per blade. Not worth it at 4 pixels a cell.
- **Slopes** are not in it. Heights are per cell, which gives steps, and
  ooergolf has only steps. See open question 5.

### 2. Blades are generated on the GPU from the seed and the mask

**Recommended.** Each kind's blades sit on a jittered lattice anchored to
the grid's origin, with a spacing of 1/√density. A blade's place, turn,
height, shade and rank all come from a hash of its lattice cell and the
seed, the same way the particles hash their slot.

Each frame:

1. The CPU culls chunks of the grid (16×16 cells) against the frustum and
   the far distance. This is pure arithmetic, tested under node.
2. A compute pass visits every candidate lattice point in the chunks that
   survive. It keeps those in the mask, in view, and kept by the level of
   detail (decision 7), and appends each to a visible list of fixed
   capacity, with an atomic count. It writes two indirect draw calls: near
   blades and far blades.
3. Two `drawIndexedIndirect` calls draw the blades. The blade's own vertex
   stage builds it from its list entry, the wind and the trample.

- **Why not placed by the CPU once:** a million blades at 16 B is 16 MB to
  build and upload before the first frame. That is ooergolf's boot, which
  is 103 ms today. It would also need a way to thin by distance, which
  would then be a CPU pass every frame. On the GPU, the field costs no
  memory for its blades and no time at boot.
- **Why not a GameGroup:** it has no level of detail or culling, it is
  drawn three times, and it has no bend. The table above is what it costs.
- **The cost of doing it on the GPU:** the placement is WGSL, which node
  cannot run. So it has a TypeScript twin in `grass.ts`, which uses the same
  u32 hash and the same lattice. A GPU test reads back the visible list for
  a small field, with the level of detail off, and holds it equal to the
  twin's blades. That is one function in two languages held together by a
  test. The particles' hash has no twin; this one needs one because
  placement is what the unit tests are about.
- **Blades never move with the camera.** The lattice is anchored in the
  world, so thinning and the ladder remove blades and never reshuffle
  them.

### 3. How many

The measured cost of the scene pass alone is 3.7 to 6.4 ns a blade on the
M4 Pro. Drawn in the scene only (decision 6), 2 ms buys 300,000 to 500,000
blades on screen. The recommended defaults for ooergolf:

| Kind | Height | Width | Blades/unit² | Near blades on a hole |
| --- | --- | --- | --- | --- |
| green, mown | 0.15 ± 30% | 0.05 | 150 | ≤ 115k (760 u²) |
| fairway | 0.3 ± 30% | 0.06 | 60 | none on today's holes |
| rough | 0.8 ± 30% | 0.09 | 12 | ~120k within 34, then thinned |

The visible list's capacity defaults to 262,144 blades (16 B each, 4 MB).
It is fixed when the grass is set. A frame with more candidates than that
draws the capacity and drops the rest, rather than growing the list.

### 4. Stripes

**Recommended:** stripes are a kind's option, in world space: a width, an
angle, an offset and a shade. Alternate bands lean opposite ways along the
stripe and are shaded lighter and darker by `shade`. The lean on its own
barely changes the colour under toon light, where the normals are pulled
toward up (see Looks), so the shade is what makes a stripe show. The lean
adds a little change as the view turns, as a real mown stripe has.

ooergolf's stripes are two tile rows (6 units) wide, running across the
course, so it would ask for width 6, angle 0 and offset its origin's y.

*Alternative:* a per-cell stripe byte in the mask. That is more general
(curved mowing lines) at a second texture. Not needed yet.

### 5. Wind

**Recommended.** Two new properties on `GameRenderer`, set by the game each
frame:

- **`time`:** seconds, the game's own. It is 0 until set, and a 0 means
  nothing moves.
- **`wind`:** `{ direction: [x, y], strength, gustSize, gustSpeed }`,
  still by default.

The renderer never reads a clock for them. Its private `postTime` stays for
the grain and the fog's noise, as now.

In the vertex stage, a blade bends toward the wind's direction, about the
horizontal axis across it. A vertex at fraction u of the height turns by
θ·u², so the blade curves and keeps its length. θ is the sum of three
terms, capped at 80°:

- **The gust:** `give × strength × gust(p, time)`. Here `gust` is two
  octaves of value noise over the ground, sampled at
  `(p·dir − gustSpeed·time, p·across) / gustSize`, so bands of gust travel
  across the field downwind.
- **A flutter:** `0.1 × give × strength × sin(2π(3·time + hash))`, so
  neighbouring blades are not in step.
- **The blade's lean at rest:** from its kind and its stripe.

`gust` has a TypeScript twin, which is tested for two things: it is bounded
in [0, 1], and it travels, so that `gust(p + dir·v·Δt, t + Δt) = gust(p, t)`.

- **Cost:** a few noise lookups a vertex. It is not measured yet. The
  build step measures it against a still field in the perf gate, and says
  whether the "no wind" rung is worth having (decision 9).
- **Determinism:** the same `time` gives the same picture to the pixel,
  paused or not, and `dt` plays no part. A GPU test holds this.

### 6. Being pressed down

**Recommended: a trample grid the game stamps, kept on the CPU and
uploaded.**

- **Setting it up:** `setGrass(field, { trample: { origin, cell, cols,
  rows, recovery } })`. The grid covers only where the ball can go, because
  a rough the ball never enters needs none. The cell defaults to 0.25 and
  `recovery` to 6 seconds.
- **Pressing:** `press(x, y, radius, dx, dy)` flattens the blades in a
  disc, lying toward (dx, dy), at the current `time`. It returns false
  off the grid or past the frame's limit of 64 presses. `clearPresses()`
  empties the grid, for a new hole.
- **What a texel holds:** when it was pressed, how deep, and which way,
  as four floats (`rgba32float`).
- **How it recovers:** a blade reads its texel once a vertex and takes a
  depth of `depth × (1 − smoothstep(0, recovery, time − pressedAt))`. So
  recovery needs no pass, costs nothing while nothing is pressed, and
  depends on `time` alone, so a paused game holds its track.
- **When presses overlap:** a press overwrites a texel only where it would
  press deeper than what is left there now. A light touch never erases a
  fresh track.
- **Uploading:** the texels the frame's presses touched are uploaded as
  one dirty rectangle.
- **How it looks:** a pressed blade lies toward the press's direction, up
  to 80° by its depth. That turns its normal, which moves it down a toon
  band, and it is also darkened by `pressShade` (0.7, ooergolf's
  `TRAIL.dark`). The track reads the way today's strips do, but it is the
  grass.
- **Bounded:** the grid is allocated once, when grass is set, and is never
  grown. ooergolf's largest hole at 0.25 is about 120×180 texels (346 KB),
  and the grid is refused past 1024×1024 texels (16 MB). There is no list
  of points kept, so there is nothing to empty except by `clearPresses`.
- **The logic is headless.** `Trample` in `grass.ts` does the stamping,
  the overwrite rule, the depth at a time and the dirty rectangle, all under
  node. The renderer only uploads what it has written.

*Alternatives:*

- **A trample texture written by a compute pass on the GPU.** No upload.
  But the logic could only be tested on a device, and it needs read-write
  storage textures. Not worth it for 64 presses a frame.
- **A ring of recent points the shader searches.** Every blade loops over
  the ring, so the cost grows with the length of the track, and the track's
  length is capped by the ring's size. Rejected.

### 7. Looks

- **Shading.** The blades go through the scene's own fragment code, with
  the shading, toon bands, sun shadow lookup, spot and point lights,
  occlusion read, ambient and `finite`. To make that possible, the scene
  shader is split into a shared fragment chunk and two vertex stages (the
  refactor commit below). The toon bands, the look and the rungs then
  apply to grass with no second copy of the lighting.
- **Normals.** A blade's normal is its face's normal pulled 60% toward
  up, so a field shades as one surface in broad toon bands rather than as
  noise. A pressed or wind-bent blade turns its normal with it.
- **Colour.** Each blade runs from its kind's root colour at its foot to
  its tip colour, along `u^0.7`. The root colour is the darkening into the
  ground, standing in for self-shadow. Each blade is varied by ±`variation`
  in value, with a little hue, from its hash. A low-frequency patch noise
  over the ground gives the field patches of darker grass, which replaces
  the rough's speckle.
- **Shadow received:** yes, and at no extra cost: blades read the sun's map
  the ground does. The rail's and trees' shadows fall on the grass.
- **Shadow cast: off by default.** A blade 2 pixels tall casts nothing you
  can see, and casting into the map was about 1.9 ms a million blades
  (measured, on the GameGroup path). `shadows: true` on the grass options
  casts the near blades with the one-triangle blade for a rough that wants
  it, and it goes out on the `shadows` rung. See open question 2.
- **Occlusion:** blades are not drawn into the occlusion prepass, which
  saves about 2.2 ms a million (measured). They read the map at their
  pixel. That map was made from the ground and what stands on it, so the
  grass at a rail's foot or round the cup's collar darkens as the ground
  there would. Tall rough near a wall takes a little too much of the
  ground's shade, which reads as grass in shade.
- **Fog:** free. The fog march reads the depth, and the blades write it.
- **Pixel width.** A blade is widened to at least one pixel at its
  distance, from the projection, so the green does not shimmer. This is
  the one departure from real sizes, and it is what makes a 0.05-wide
  blade usable at 0.056 units a pixel.
- **The ground under the grass stays the game's.** The grass draws no
  ground. So that gaps between blades and the far fade don't show,
  `grassGround(kind)` gives the colour a blade field of that kind averages
  to, for the game to paint its ground in.
- **Where the grass meets things:** the mask. The cup's disc, the rail's
  tiles, water, a conveyor and a windmill's base are cells with no grass,
  which the game rasterises. At 0.25 a cell an edge is ragged by a cell,
  which is 4 pixels at home and reads as grass growing up to a thing. A
  barrier sliding over grass hides the blades under it by depth, and a
  blade 0.15 tall does not poke through a box. The ball sits in the green's
  blades and flattens those under it.
- **Keep mode.** Grass moves every frame, so in `keep` mode it is drawn
  with the movers, after the kept static half is copied. It is never baked
  into the kept frame.

### 8. Levels of detail

**Recommended:** the blades thin continuously, by a rank each one holds, and
switch mesh past a middle distance. Four distances matter, set in the grass
options and defaulted from the kind's height:

- **`near`:** every blade inside it is kept. Default 40 units for the golf.
- **`mid`:** past it, blades use a one-triangle mesh instead of five.
  Default 90.
- **The keep function:** past `near`, a blade survives while its rank is
  below `keep(d) = (near/d)²`. So each ring out from the camera holds about
  as many blades as the one before, and a field that runs to the horizon
  adds a slowly growing few, not an area's worth.
- **`far`:** there are no blades past it. The ground's colour carries on
  from there. Default 300.

How popping is avoided:

- **A blade shrinks to nothing before it goes.** Its height is scaled by
  `clamp((keep(d) − rank) / 0.1, 0, 1)`. Blades never blink out; they
  sink into the ground as the camera draws back, and grow as it comes
  near.
- **Survivors widen by `1/√keep`, capped at 3×,** so the field's coverage
  holds as it thins and its colour does not step.
- **The switch from five triangles to one** falls where a blade is about 4
  pixels tall, so the difference is under a pixel. It is dithered per blade
  over a band of 10% by the blade's hash, so there is no line across the
  field.
- **The last blades before `far`** have shrunk to nothing, over a ground
  painted their average colour (`grassGround`), so the edge is a fade.
- **The economy's density** multiplies `keep`, so a rung that halves the
  grass removes the same blades the distance would. It is a subset, and
  nothing reshuffles when the governor steps.

### 9. Cost, the rung, and a gate

**Budget:** the standard golf field at the home view, 1280×800, full
economy, adds **at most 2.0 ms** to the same scene without grass on the
reference machine (M4 Pro). The estimate from the measurement is 1.2 ms
in the scene pass: 115k green blades at 3.7 ns and 120k near rough at 6.4
ns. Add about 0.3 ms for the thinned far rough, and the compute cull. The
compute pass and the wind are not measured yet, and the first build step
measures them against this.

**The rungs,** as new optional fields on `GameEconomy`, which a game that
names neither never sees:

- **`grass?: number`,** a density fraction. 1 is everything, 0 is none,
  with no compute and no draw. At 0.5 there are half the blades, widened,
  and they are a subset of the full field.
- **`wind?: boolean`.** Off, the blades stand at their rest lean. The
  trample still shows, since it is the game's and costs one lookup.

Recommended rungs for ooergolf, which are its own decision:

- **The rung that drops particles** also sets `grass: 0.5` and
  `wind: false`, if the build shows that wind is worth taking out.
- **The last rung** sets `grass: 0`.

The rungs are judged against the 1 ms and 0 ms marks in the perf gate.

**A slower machine** is not measured. There is no other GPU here. What the
spec can promise is the ladder's figures on this machine and ooergolf's
governor, which already steps down from the mean frame.

**A gate held in this repo** (it has none, see CLAUDE.md):

- **The command:** `npm run perf:gpu` runs
  `src/game/__tests__/perf.gpu.test.ts` under `VITE_PERF=1`. The file is
  skipped otherwise, so `test:gpu` stays pixel checks and no slower.
- **Its scenes, at 1280×800:**
  1. the toon daylight scene with occlusion and fog and no grass, which
     holds the game path as a whole for every consumer;
  2. that scene with the standard golf field at the home view;
  3. the same field at the nearest zoom;
  4. the field on the half-density rung.
- **The method** is the one above: warm up, then the median of seven runs
  of thirty frames.
- **The baseline** is `perf-baseline.json`, keyed by the adapter's key
  (`gpu.adapter.key`), and held both ways at **±15%**. That is about three
  times the 1–6% wobble measured between two runs, and the gate's first
  commit measures its own wobble over five runs before the figure is
  fixed.
- **The budget:** scene 2 minus scene 1 is at most 2.0 ms on the reference
  adapter.
- **An adapter with no baseline** records one when
  `VITE_PERF_UPDATE=1` and otherwise passes with a warning. It never fails
  on a machine that has never been measured.
- **Its working parts,** the median, the comparison and the keying, are
  pure and unit-tested under node.
- **Before trusting it,** it is watched on the unchanged tree several
  times, and against a field with double the blades, which it should see
  as about twice the cost.

### 10. The API

Everything is new and optional. Nothing that exists changes its signature.

```ts
// src/game/grass.ts: pure, runs under node
export interface GrassKind {
  density: number;            // blades a square world unit
  height: number;             // world units
  heightSpread?: number;      // a fraction either way; 0.3
  width: number;              // at the root, world units
  base: [number, number, number];
  tip: [number, number, number];
  variation?: number;         // 0.15
  roughness?: number;         // 0.85
  lean?: number;              // at rest, 0 upright to 1 lying down; 0.2
  give?: number;              // how much the wind moves it, 0 to 1; 1
  stripes?: { width: number; angle: number; offset?: number; shade: number };
}
export interface GrassField {
  origin: [number, number];
  cell: number;
  cols: number;
  rows: number;
  mask: Uint8Array;           // cols*rows, one more than the kind's index, 0 for none
  heights: Float32Array;      // cols*rows, the ground each cell's blades stand on
  kinds: GrassKind[];         // at most 8
  outside?: { kind: number; height: number };  // beyond the grid; none if left out
  seed: number;
}
export interface GrassOptions {
  capacity?: number;          // blades drawn a frame at most; 262144
  near?: number; mid?: number; far?: number;
  shadows?: boolean;          // cast into the sun's map; false
  trample?: { origin: [number, number]; cell: number; cols: number; rows: number; recovery?: number };
  pressShade?: number;        // 0.7
}
export interface Wind { direction: [number, number]; strength: number; gustSize: number; gustSpeed: number }
export const STILL: Wind;
export function grassGround(kind: GrassKind): [number, number, number];
// and, for the tests: bladesIn (the twin), keep, gust, Trample, grassUniform

// GameRenderer
setGrass(field: GrassField | null, options?: GrassOptions): Promise<void>;
time: number;                 // the game's clock, seconds; 0
wind: Wind;                   // STILL
press(x: number, y: number, radius: number, dx: number, dy: number): boolean;
clearPresses(): void;
grassDrawn(): Promise<{ near: number; far: number }>;  // reads the indirect counts back, for tests and the gate
// GameEconomy gains grass?: number and wind?: boolean
```

How the API behaves:

- **`setGrass`** compiles the grass pipelines the first time it is called,
  and its promise resolves when they are in. `ready` is untouched, so a
  game that never asks compiles nothing new. ooergolf awaits `setGrass`
  before its first frame, as the house rule on loading asks.
- **Refusals:** `setGrass` throws on a mask or heights of the wrong length,
  more than 8 kinds, a mask value with no kind, a height that is not a
  number, or a grid or trample past its ceiling.
- **Changing a field:** calling it again with the same sizes rewrites the
  mask and heights in place. A new size makes the buffers again.
- **`null`** frees every buffer and texture the grass made.
- **Units:** every length is in the world's own units. The renderer's own
  fixed sizes, the pixel floor aside, go through `mm()`, as the rest do.

How it is proved that every game behaves as before:

- **The pins.** Every consumer pins a tag, so nothing changes until a game
  moves its pin: pushminer is on v0.16.1, coinpush and the template on
  v0.16.0, heist and artshape on v0.15.0, and arena and chess on v0.13.0.
  bearing and ooergolf are on v0.18.0.
- **The GPU suite, unchanged.** All 103 tests pass at v0.18.0 today, and
  every commit here keeps them passing without editing one of them.
- **The refactor proves itself.** Splitting the scene shader moves no
  pixel. Each of the 32 builds is drawn into a fixed scene at the parent
  commit and after, with `VITE_FRAME_DIR`, and the frames are diffed to
  zero changed pixels. The diffing script is kept in `scripts/` for the
  next refactor.
- **Nothing asked.** A new GPU test draws a scene with a renderer that was
  never given grass, then with one given grass and then `null`, and they
  match to the pixel. It also counts the pipeline compiles made before
  `ready` and holds that count to the number v0.18.0 makes.
- **The perf gate's scene 1,** with no grass, holds the frame of a game
  that does not ask to its baseline.
- **Before the tag:** bearing's and ooergolf's `npm run check` are run
  against the branch in throwaway clones in the scratchpad, never in their
  working checkouts. bearing should show no moved gate. The still-life
  path (`src/render`) is not touched by any of this.

## Acceptance criteria

1. A game that never calls `setGrass` draws the same frame to the pixel as
   before, and makes the same pipelines before `ready`.
2. A field draws blades only in cells its mask gives a kind. None grow in
   the cup's disc cut from a green.
3. The blades drawn for a small field with the level of detail off are the
   TypeScript twin's blades, in number exactly and in place within 1e-4
   units.
4. The same seed gives the same field. Another seed gives another.
5. Mown stripes show: the mean colour of alternate bands differs by the
   kind's `shade` within 20%.
6. With wind, frames at two times differ. At the same time twice they
   match to the pixel. With strength 0, or the `wind` rung off, two times
   match to the pixel.
7. A press darkens the grass in its disc at once. The same view `recovery`
   seconds later matches a never-pressed field to the pixel. Halfway, it
   is between the two.
8. The number of blades drawn falls continuously with the camera's
   distance, and none are drawn past `far`. Stepping the camera back
   through `near`, `mid` and `far` in small steps shows no step changing
   more than twice the median step's pixels.
9. `economy.grass` at 0 draws the same as no grass and runs no grass pass.
   At 0.5 it draws half the blades within 5%, all of them among the full
   field's.
10. More candidates than capacity draws the capacity, with no GPU error.
11. In `keep` mode the grass moves with `time` and the kept half is not
    frozen over it.
12. A sun shadow falls on the grass. Fog pales far grass as it pales the
    ground.
13. The same field in millimetres (`mmPerUnit` 1) and in tenths of a metre
    (100) draws the same picture.
14. The standard golf field costs at most 2.0 ms over the scene without
    it, held by `perf:gpu`, with its baseline held ±15%.
15. `setGrass(null)` and `dispose` destroy everything the grass made.

## Edge cases (the checklist in CLAUDE.md)

- **Nothing asked:** criterion 1.
- **Units:** criterion 13. The pixel floor is in pixels. Every other fixed
  length goes through `mm()`.
- **The look:** PBR and toon both, since it is the same fragment code. The
  `filmic` and `clamp` tone maps apply after it, so nothing new there.
- **The economy:**
  - `shadows` off: blades stop reading the sun's map, and stop casting if
    they were.
  - `occlusion` off: blades stop reading its map.
  - `fog` off: nothing new.
  - `post` and `effects`: not reached.
  - `points` off: blades take no point light.
  - The new `grass` and `wind` rungs: criteria 6 and 9.
  - Stepping down and back up gives the same frame, which is tested.
- **Frame modes:** criterion 11.
- **The passes:** it reaches the sun's map (only when casting), a spot's
  map (it reads spots like any surface), the scene, the fog through depth,
  and the frame through `finite`. `shaders.test.ts` extends to the grass
  stage. It is not in the occlusion prepass, by design.
- **Capacity:** capacity 0 refuses. At capacity and past it, see criterion
  10. Presses past 64 a frame return false. A grid or trample past its
  ceiling refuses.
- **Resize:** the pixel floor reads the height each frame. A 1-pixel frame
  and an odd size are tested.
- **Before ready, without an environment, and before `setGrass` resolves:**
  the grass is not drawn and the frame is otherwise as it would be.
- **Dispose:** criterion 15.
- **Time:** criteria 6 and 7. `time` going backwards, as after a new hole
  or a seek, is allowed: a press from the future has no depth until its
  time comes, so a `clearPresses` at a new hole is what the game should
  do.
- **Devices:** the pressed grid is `rgba32float` and is only sampled with
  `textureLoad` (no filtering needed). The indirect draws and storage
  atomics are core WebGPU. Firefox is not tested here, and that is said
  plainly.

## Test plan

**Unit tests, under node** (`src/game/__tests__/grass.test.ts`):

- **Validation:** each refusal in the API section.
- **The twin:** the same seed gives the same blades. Blades land only in
  their own kind's cells. Blades per area are within 5% of the density
  over a large field. Editing one cell leaves every other cell's blades as
  they were, which is the world anchoring.
- **`keep`:** it is 1 inside `near`, falls monotonically and continuously
  to 0 by `far`, and at half density picks a subset. The widening is
  bounded at 3.
- **`gust`:** it is bounded in [0, 1], it travels downwind at `gustSpeed`,
  and it is 0 bend at strength 0.
- **`Trample`:**
  - the depth at the press time, and at the recovery time;
  - monotone between them;
  - a press off the grid, or the 65th in a frame, returns false;
  - the overwrite rule;
  - `clearPresses`;
  - the dirty rectangle covers the presses;
  - the memory is fixed at construction.
- **`grassUniform`:** the layout, as `particles.test.ts` holds its strides.
- **The perf gate's own parts:** the median, the comparison both ways and
  the keying by adapter.

**GPU tests** (`src/game/__tests__/grass.gpu.test.ts`), each at 192 or 256
pixels in the style of `toon.gpu.test.ts`, with frames written under
`VITE_FRAME_DIR`:

- criteria 1 to 13 and 15, one test or more each;
- a picture of each kind (green with stripes, fairway, rough) written out
  and looked at.

**Seen failing first:**

- Each commit writes its tests against a stub that type-checks: `setGrass`
  resolves and draws nothing, `press` returns true and does nothing, and
  `wind` is read and ignored.
- They run and fail for the right reason. Criterion 2 finds no green
  pixels, 6 finds the frames at two times identical, 7 finds no darkening,
  and the unit tests fail on values rather than on imports.
- The failures are copied into the report.

**Mutation checks,** each made, seen failing and restored:

- read `postTime` in place of `time` (criterion 6's "same time twice"
  fails);
- drop the recovery (7 fails);
- drop the shrink before a blade goes (8 fails);
- ignore the mask (2 fails);
- change the WGSL hash's constant but not the twin's (3 fails);
- let `press` grow a list (the fixed-memory test fails);
- put grass in the occlusion prepass (the perf gate's budget should move).
  That one is a check on the gate, not a test.

## The order of the work, and the release

Each commit is green on the full check (typecheck, node suite, GPU suite,
and `perf:gpu` from commit 2), and a refactor and a feature land apart.

1. **The project says how it is worked on.** `CLAUDE.md`, already drafted
   in this worktree.
2. **A frame of the game path is held to a baseline.**
   - `perf.gpu.test.ts`, run by `npm run perf:gpu`, with its pure parts and
     their unit tests, scene 1 only, and the baseline for this machine.
   - A shared GPU-test helper for reading a frame back and writing it out,
     used by the new tests only.
   - The before/after frame-diff script.
3. **The scene shader's fragment stage is shared** (a refactor). No pixel
   moves: all 32 builds are diffed to zero, and the suite is unchanged.
4. **Grass is described and placed without a device.** `grass.ts`: the
   field, kinds, the twin, `keep`, `gust`, `Trample` and `grassGround`,
   with unit tests.
5. **A field of grass draws on the game path.**
   - Adds `setGrass`, the compute cull, the indirect draws, the blade vertex
     stage, the level of detail, the stripes and `economy.grass`.
   - GPU tests for criteria 1–5 and 8–15.
   - Perf scenes 2–4, and the budget held.
6. **The grass bends in the game's wind.** Adds `time`, `wind` and
   `economy.wind`, with criterion 6, the wind's cost measured, and the rung
   kept or dropped on that figure.
7. **The grass is pressed down and stands again.** Adds `press`,
   `clearPresses` and the trample upload, with criterion 7.
8. **The docs.** README, a grass section in `TESTING.md`, and grass as a
   model feature in `CLAUDE.md`.
9. **0.19.0.** The version alone, tagged `v0.19.0`, pushed with the tag.
   Only when asked.

It is **0.19.0** because the change only adds: new optional economy
fields, new methods and a new module. No export changes its shape, and
`sceneSource` keeps its signature.

### How ooergolf takes it in

In a feature of its own there, on its own line:

- **The pin.** It moves to `v0.19.0`.
- **The field.** `scene.ts` builds a `GrassField` from the layout:
  - a mask at 0.25 over the course and the tufts' reach, with green on
    grass tiles and rough elsewhere;
  - the cup's disc, rails, water, conveyors and windmill bases cut out;
  - heights from `floor`, and the rough at `−ROUGH_DEPTH`;
  - `outside` set to rough at `−ROUGH_DEPTH`;
  - stripes of two tile rows.
- **What goes:**
  - the tile grain pattern, with the tiles painted `grassGround(green)`;
  - the tufts group, and `scenery.tufts`;
  - the rough's speckle, with the rough plane painted
    `grassGround(rough)`;
  - the track group, and `trail.ts`'s strips.
- **What replaces the track:** the page calls `renderer.press` behind the
  rolling ball, and `clearPresses` when a hole begins. It sets
  `renderer.time` to game time and `renderer.wind` from `sway.ts`'s breeze,
  so the trees and the grass lean in the same wind.
- **Its gates:**
  - Its leaks gate loses the trail's ceiling, since the trample is fixed by
    construction.
  - Its perf gate's frame baseline moves, from 1.3 ms to about 2.5–3.3 ms
    by the estimate, within its 8 ms budget, through `/gate-moved`, with the
    reason given.
  - Its quality ladder gains the grass rungs.
  - Its look pictures are written again and every one looked at.
  - Determinism, pace and the fuzzer are untouched, since the grass is
    drawing only.

## Open questions, each with a recommendation

1. **The Firefox fix in the main checkout** (`src/render/env.ts`, the
   `TESTING.md` note, and an untracked `src/render/__tests__/env.gpu.test.ts`)
   is uncommitted and not on `origin/main`. Should 0.19.0 carry it? *I
   recommend you commit it to main yourself first, as its own change, and
   I rebase onto it. Otherwise 0.19.0 ships without it.*
2. **Should rough blades cast shadows?** *No, by default.* The root
   darkening stands in for it. `shadows: true` is there if a look wants it,
   at about 1.9 ms a million blades cast (on the GameGroup path; the
   one-triangle blade should be cheaper, and the build measures it).
3. **Should the perf gate go in CI?** *No.* SwiftShader is the only
   adapter there, as with the GPU suite. It stays a local gate, run before
   a rendering change, and the baseline is keyed per adapter.
4. **Should the grass get MSAA?** *No.* The frame is single-sampled, and
   multisampling it all to save the green from shimmer costs every pixel.
   The one-pixel width floor and the colour matched to the ground do that
   job. If the green still crawls when the camera follows the ball, the
   next thing to try is fading the green's blades toward the ground colour
   by their pixel height, not MSAA.
5. **Slopes** (a green that is not stepped)? *Not in 0.19.0.* ooergolf has
   none. Heights per cell sampled bilinearly would be the change, when a
   course wants one.
6. **A second field at once** (two holes in view)? *No.* One field per
   renderer, and the grid is sized to what the camera can see of the
   course. `outside` handles the rest.
7. **Should the wind reach the flags and trees too?** *Not in the renderer.*
   They are the game's own meshes, moved by the game (`sway.ts`). The game
   feeds the same breeze to both.
8. **Should the blade shapes be the game's?** *Not yet.* The renderer
   builds a tapered blade of 5 triangles and 1 triangle. A cartoon clump
   (three blades from one root) is the likeliest next ask, and would be an
   option on the kind.

## Not verified

- **The dedicated path's cost.** The compute cull, the wind's cost and
  the generated blade's vertex cost are not measured. The 2.0 ms budget is
  an estimate from the GameGroup measurement, and commit 5 measures it.
  Where it does not fit, the spec comes back here with the numbers before
  anything is tuned toward it.
- **Any machine but an M4 Pro.** There is no slower GPU here.
- **The look** is designed, not seen: nothing is drawn yet. In particular,
  whether 2-pixel mown blades read as a lawn or as noise at the home view
  can only be settled by looking.
- **Firefox and Direct3D.**
