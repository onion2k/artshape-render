# Testing artshape-render

`npm test` runs the suite once; `npm run test:watch` keeps it open. Vitest,
configured in `vitest.config.ts` to pick up `src/**/*.test.ts`. Tests live
next to what they cover, in a `__tests__` directory alongside the module.

`npm run test:gpu` runs the tests that need a WebGPU device — the
`*.gpu.test.ts` files, excluded from the node run — in the machine's own
Chrome, headless, through Vitest's browser mode and Playwright
(`vitest.browser.config.ts`; nothing is downloaded, Chrome is launched with
WebGPU enabled). `VITE_FRAME_DIR=/some/dir npm run test:gpu` writes the
frames those tests draw out as PNGs, for looking at.

Every push and pull request runs the typecheck and the node suite on
GitHub (`.github/workflows/check.yml`). The GPU suite is not in it: a
runner's only WebGPU adapter is SwiftShader, some two hundred times
slower than a desktop GPU, which the headroom and furnace tests would
time out against long before they said anything true. It stays a local
gate — run it before committing a rendering change. The typecheck covers
its source either way, so those files cannot rot unnoticed.

## What's covered

Roughly bottom-up, from the math to the device:

- **DSL** (`src/dsl/__tests__`) — lexer, parser, evaluator, and the builtin
  registry, including the `Args` reader and `signature()`, the probe an
  editor's help strip and completions would run on. The catalogue of
  example sketches belongs to an application, so what compiles them is
  tested there; the render tests keep their own fixtures in
  `src/render/__tests__/fixtures.ts`.
- **Geometry and pattern math** (`src/geom/__tests__`, `src/pattern/__tests__`)
  — vectors, transforms, curves, symmetries. Pure functions, checked against
  known results (a 90° rotation, a circle's arc length) rather than against
  each other.
- **Builtin dispatch** (`src/dsl/__tests__/builtins-dispatch.test.ts`) — that
  a DSL call reads the right argument into the right parameter of the
  underlying geometry or pattern function. A `repeat` around a single-part
  unit at the identity makes a placement's matrix exactly the symmetry's own
  transform, which is what lets these checks be exact rather than
  approximate.
- **Mesh generators** (`src/mesh/__tests__`) — profile, sweep, revolve,
  extrude, and the shared mesh helpers (`MeshBuilder`, `mergeMeshes`, the
  enamel markers). Two shared assertions in `helpers.ts`:
  `expectWellFormed` (index bounds, unit normals, no degenerate triangles)
  and `expectWatertight` (every edge shared by exactly two faces — see the
  gotcha below on why that has to be keyed by position, not index).
- **Part builders** (`src/parts/__tests__`) — one file per part module,
  checking anchors, bounds, well-formedness across the real option space,
  and enamel wiring.
- **Outline, deform, and wear** (`src/geom/__tests__/outline*.test.ts`,
  `src/mesh/__tests__/deform*.test.ts`, `wear*.test.ts`) — leaf and petal
  silhouettes, the cup/curl/twist/ruffle/relief deformation fields, and the
  curvature-based wear heuristic. Includes an `-edges` file per module for
  zero, negative, and degenerate inputs specifically.
- **Camera and orbit** (`src/gpu/__tests__`) — `Camera`'s matrices (pure)
  and `Orbit`'s pointer/wheel handling, under jsdom, driven through real
  `addEventListener` wiring rather than by calling handlers directly.

A GPU test awaits `renderer.ready` after constructing a renderer: the
pipelines compile off the main thread, and `render` draws nothing until
the last is in. A GPU test that reads a frame back waits on `renderer.pending`, not on
a count of frames: an occlusion bake lands in chunks with a gap between
each in which nothing is dirty, and `pending` now covers a bake still
landing, so a loop that stops when it goes false has the whole bake and
the probe after it. The shadows test used to stop after sixty frames if
nothing was pending at that moment, which on a busy GPU was the middle
of the full bake — it failed about half of full runs and never alone.

- **The game path** (`src/game/__tests__`) — the light pool's packing and
  its fixed-capacity behaviour, and that the scene shader's variants are
  module constants rather than uniforms, which is the thing the next
  person to add a rung will get wrong. On a real device: that it draws at
  all, that more lights make a brighter frame, that the radius cull gives
  the same picture as no cull, that the ladder's cuts are reversible, that
  the kept static frame matches redrawing it, and that a group can be
  moved and its live count changed without rebuilding it.

  These are pixel checks rather than timings, deliberately. Six separate
  faults in the spike that produced this renderer's design had no symptom
  except a plausible number, and every one was caught by rendering it and
  asking whether the image changed.

## What's not covered, and why

`src/render/viewer.ts` — the canvas, the orbit, the frame loop and the
adaptive resolution — has no automated coverage; the arithmetic under its
calibration (the scale to open at, the tier suggested, the median, the
stored verdict and its shelf life) and the ladder it drives (the scale
to its floor, then the rungs in order, and the two guards on the way
back up), and the bakes' budgets from the verdict (the square-root
scaling, the floors, the second bounce given up at four times slower)
are pure in `src/render/calibrate.ts` and tested in
`calibrate.test.ts`; the fenced timing itself is not. The renderer under it has
one headless test (`src/render/__tests__/renderer.gpu.test.ts`, under
`npm run test:gpu`): a device with no canvas, the rosette sketch, a frame
into a texture, and its pixels read back — the piece is at the centre and
gold, the background at the corners, the debug views draw, the tracer takes
a sample, every shader compiles and no GPU error is raised; and the same
rosette modelled in metres with `mmPerUnit: 1000` draws the same frame to
within a level. A second file, `headroom.gpu.test.ts`, builds a parametric
shell at rising density and prints the time of every stage — generation,
upload, first frame, shadow bake, probe, traced scene, first sample — as a
record of what the renderer takes; its largest size, eleven million
triangles, runs only under `VITE_HEADROOM=full`. These say the renderer
draws, draws the same at any unit, and draws dense meshes, not that it
draws well: a material or lighting change still means
opening the app and looking at it, in the in-app browser preview or a real
browser. Treat a change there as unverified until it's actually been seen
on screen.

## Gotchas for writing tests here

- **`expectWatertight` keys edges by rounded position, not vertex index.**
  The mesh generators duplicate vertices on purpose at every crease and cap
  seam, so each side can carry its own normal — that's the generator working
  correctly, not a bug. Round to a fixed precision *before* folding `-0` to
  `+0`: a residual floating-point epsilon near a seam (an angle of 2π is not
  bit-identical to 0) rounds to `-0`, and `toFixed` prints that with a minus
  sign, hashing two geometrically identical vertices apart.
- **`deform()` mutates positions in place.** A test that searches for a
  vertex by its post-deform coordinates is searching a mesh the assertion
  has already changed — `cup()`, for instance, shortens a vertex's `y` as it
  lifts `z`, since it preserves arc length rather than projected width.
  Address vertices by their known grid index in a synthetic mesh, not by
  re-scanning coordinates after the call.
- **Hand-built "obviously curved" fixtures are unreliable for curvature
  heuristics** like `computeWear`. A synthetic two-face fold can give
  opposite signs to its own two seam-duplicate vertices if the fixture's
  geometry doesn't actually agree with itself on which side is the ridge.
  Prefer a real generator (e.g. `extrude()` with a bevel) as the fixture.

- **`Camera.lookAt` degenerates when the camera-to-target direction is
  parallel to +Z**, the "up" this whole project is authored around. The
  cross product that builds the view basis is then the zero vector, and the
  `|| 1` guard against dividing by zero silently zeroes the x/y basis rather
  than producing `NaN`. Don't place a camera (real or in a test) directly
  above or below its target on the Z axis; it's also why `Orbit` clamps its
  polar angle away from the poles.

## Shadows on the game path

`src/game/__tests__/shadows.gpu.test.ts` puts a box over a floor and reads
the floor in the box's shadow against the floor beside it: darker under the
sun's map, darker under a spotlight's, back to the same when the map is
taken away, a flat floor that does not shadow itself, and the flat picture
when the ladder rung is off. The matrices the maps are rendered with are
checked on the CPU in `shadows.test.ts` — every corner of the fitted box
inside the clip volume, depth linear for the sun and perspective for a spot,
the cone just inside a spot's map. The DSL builds plates about their centre:
a test that places one from a corner is measuring the wrong thing.

**A spot's soft edge.** `look.spotSoftness` widens a spotlight's lookup disc
with the surface's distance from the lamp, in texels per world unit, and the
test for it reads brightness along a line of floor points crossing the box's
shadow edge and compares how steeply the line falls at its steepest: half
as steep, at least, at a texel per twenty-five units as at none. It is the
slope and not a count of the ramp's samples because the "hard" edge is not
a step in the frame either — the bloom spills the lit floor forty-odd units
into the shadow — and a ramp wider than any window you count in reads as
narrow. The box is moved away from the lamp for it, so the shadow's far edge
is clear of the box's own image. What the softness is for was found in the
arena and not here: a lamp post as tall as the lamp beside it throws a
shadow with no end, and the arena's lamps also turned out to be sitting
inside their own heads — the head's underside, past the map's near plane,
was in every lamp's own map and shaded half the road. The library cannot
know where a game puts its lamp relative to its lamp mesh; a game that sees
a hard-edged bite out of every pool should look for a blocker within a few
units of the light before it looks anywhere else.

## Particles on the game path

`src/game/__tests__/particles.gpu.test.ts` emits into an otherwise black
frame and reads the mean: a burst appears where it was emitted, is gone
when its life is up, falls onto its floor when it is given gravity and
floats when it is not, and is not drawn at all when the ladder turns the
pool off. Two things the tests learned: a 32-degree lens from a camera 447
units off its target sees 128 units either side of it, so a burst placed
higher is off the frame; and a particle fades in over its first tenth, so a
reading straight after emission is dimmer than one later — compare separate
runs, never two moments of one.

## Post-processing on the game path

`src/game/__tests__/post.gpu.test.ts` drives the post chain — bloom, the
vignette and the grain — over flat frames and one effect quad, and reads
patches of the result: with the rung off, or everything at nothing, a flat
frame is flat and a corner is the middle; the vignette darkens the corner and
not the middle; a hot quad lights a ring well outside its own edge with
bloom and not without; a frame under the threshold blooms nothing; the grain
leaves a black frame black, and on a grey one it spreads the pixels by
about its amplitude and moves from frame to frame. Two things the tests
learned: the vignette works on the tonemapped value under the gamma, so 0.6
at the corner shows as about 0.7 of plain, not 0.4; and grain added under
the gamma lifts every black pixel it lands on to a grey — the particle
tests, which take a black frame as their zero, caught it — so it is added
to the displayed value and weighted to the midtones.

## Volumetric fog on the game path

`src/game/__tests__/fog.gpu.test.ts` marches fog through an otherwise black
frame with one slab hanging over half of it: the frame is untouched at no
density and with the rung off; the empty air lights up, and more of it the
denser the fog; the air under the slab is less than half as bright as the air
beside it, which is a shaft; the ambient term lifts the shadowed air back
again; the layer can be raised past the camera, fogging the top of the frame
instead of the bottom; a plate in the way shortens the march and so the fog;
and forward scattering makes looking toward the sun brighter than looking
away. `fog.test.ts` checks the setup on the CPU: that `viewDepth` inverts
the projection `camera.ts` writes, and that the packed camera basis rebuilds
rays whose view depth is exactly one — a ray a few degrees out puts the
shafts in the wrong place and nothing looks broken.

**A `card` is centred in x but runs from zero to its height in y.** The
comment in the shadow tests saying a plate is built about its own centre is
half true, and the half that is not cost an afternoon: a 2600-long slab
placed at the origin covers y 0 to 2600, so every ray marching through
negative y ran in sunlight, the shadowed patch read as bright as the lit one,
and the fog looked broken when the scene was. Check a mesh's bounds before
believing where it is.

**Two ways this suite can lie to you.** The frame comes back **bgra**, so
`px[o]` is blue and `px[o + 2]` is red — a debug shader writing a value per
channel reads back reversed, which sent the hunt above off after the camera
basis for an hour. And a debug value read through the composite passes
through bloom, the vignette and the grain as well as the tonemap: turn the
post rung off before decoding anything quantitative out of a pixel.

**Cones.** `fogcones.gpu.test.ts` hangs one spotlight over a black frame
with mist in it: the air under the lamp lights up when the cones come on and
is black when they do not, the air beside the beam stays dark, and the same
lamp put over a lid lights nothing below it. That last one is the test with
teeth — replace the cone's shadow lookup with a constant and it is the only
one that fails, which is what says the beam is really being cut rather than
merely being narrow.

**The far end of a march.** `fog-reach` (`fogreach.gpu.test.ts`) puts a
ground plane four times the fog's reach under an arena-like camera and
measures the fog's own contribution as the difference between a frame with
it and a frame without — which in a test is exact, because the scene does not
move. The measure is the sharpest step between neighbouring bands. It is the
kind of test that only works with a still scene: the same comparison
attempted in the running game was worthless, because the car drifts, the
camera follows it, and two captures a moment apart differ in half their
pixels. If an A/B needs two renders, do it where nothing moves between them.

## Units on the game path

`src/game/__tests__/units.gpu.test.ts` is the game path's answer to the
still-life path's metres test, and it is shaped the same way: a lamp over a
slab over a floor, in mist, drawn once in millimetres with `mmPerUnit` 1 and
once a thousand times smaller in number with `mmPerUnit` 1000. The two frames
differ by 0.001 of a level, which is nothing; the third frame in the file is
the control, the metre world drawn by a renderer that was told nothing about
the unit, and it differs by 8.9 — which is what the path did before this pass.
Look at the control's PNG and the fault is plain: the slab casts no shadow at
all, because a near plane of twenty world units is twenty metres, and the
whole scene is in front of it.

`units.test.ts` checks the same rules without a device: that a lamp described
in millimetres and in metres writes the same depths into its map, that the
fog uniform no longer rounds a sub-unit length up to one, and that the look's
`falloffHalf` converts one way while `spotSoftness`, being per length,
converts the other. One of its assertions is the old bug rather than the new
behaviour — `spotShadowMatrix(..., 20)` on a scene eight units deep puts the
floor behind the near plane — so that a length written back into the library
by hand fails a test instead of quietly losing every shadow.

**Reading a shadow map.** The maps carry `COPY_SRC`, so a test can copy one
back and print it. A depth texture must be copied whole and with
`aspect: 'depth-only'`; both restrictions error rather than truncate, and the
error is easy to miss under a grep. Printing the sun map as 32×32 characters
answered in one run what pixel checks had argued about all afternoon — the
geometry was in half of it, which said at once that the scene was wrong.
