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

  And what the frame holds before the tone map (`overflow.gpu.test.ts`):
  it is half floats, which have nothing past 65504, and a mirror-smooth
  face at the mirror angle to a bright lamp asks for a hundred times that.
  An Apple GPU holds such a write at the top; a Direct3D one writes
  infinity, which the bright pass turns into not-a-number, the blur
  spreads, and the tone map shows as a black hole the size of the bloom.
  So no Mac will ever show it, and the test is in two halves that any
  machine can run: the scene never asks the frame for as much as it can
  hold, however bright the lamp; and the bright pass and the composite,
  handed a texture with infinity and not-a-number written into it, give
  back numbers everywhere, infinity shown white, and neither spread.
  `shaders.test.ts` holds every stage that writes or reads the frame to
  going through `finite`, so a stage added later cannot forget.

  The environment's bake (`src/render/__tests__/env.gpu.test.ts`) is held
  to a rule Chrome does not enforce: no pipeline is asked for a bind group
  its shader does not have. The split-sum table's shader has no bindings,
  and the bake used to ask its pipeline for the layout at group nought;
  Chrome hands one back regardless, Firefox makes the group invalid, and
  the pass shared its encoder with the sky and the prefilter, so in
  Firefox the whole bake was dropped and no scene had its sky. The GPU
  suite runs in Chrome, which would never have shown it, so the test
  watches what the bake asks for rather than waiting for an error. It was
  found by running a game in Firefox and reading its console, which is
  worth doing again whenever a pass or a pipeline is added.

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

`src/game/__tests__/wash.test.ts` and `wash.gpu.test.ts` hold the wash and
the fade. A game that asks for neither draws to the pixel as before, and the
GPU test cannot show that by comparing two runs of the new code (an update
that nudged every particle would nudge both), so a lone particle is held to
the position its own drag and gravity work out, with a wash set to nothing and
to somewhere it never reaches, against one placed there and left still. The
same scenes' pixels were also hashed at v0.23.0 and again after the change,
as a one-off by hand, and matched. Two things the tests learned: drops fall
out of a frame in a second at the world's own gravity, so the test that drops
are hardly moved by a wash lowers it, or both pictures are empty; and the
frame's own count reaches the grain, so a run with frames drawn while the
particles were off differs from one without by a hair of noise, and is held
by where its light is and not by pixel.

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

## Grass on the game path

`src/game/__tests__/grass.test.ts` holds what grass is without a device: a
field refused where it cannot be what it says; the blades grown from a seed,
only in their own kind's cells, at the density asked, anchored so that
changing one patch of the mask leaves every other blade where it was; the
chunks a camera sees; the share kept at a distance, falling without a step,
and a blade shrinking to nothing before it goes; the gust carried downwind;
and the trample, pressed, recovered, refusing what it should and never
growing. `grass.gpu.test.ts` holds it on a device: that the GPU grows the
very blades `grass.ts` does (the same hash in both languages, held equal to
1e-4); that a game never asking compiles the 46 pipelines v0.18.0 did and
draws the same frame; the mask, the stripes, the thinning, the rungs, the
capacity, the kept frame, the sun's shadow and the fog; the wind at two
moments and the same moment twice; and the trample, pressed, halfway and
recovered to the pixel. `VITE_FRAME_DIR` writes a picture of each kind.

**Measure blades, not windows.** A green's blades cover a third of what is
under them from three-quarters above, so a mean over a window is mostly the
earth between them, which does not change; the stripes and the shadow tests
read the blades' own pixels. And a camera sweep cannot tell a blade that
blinks out from one that shrinks, since the camera's own movement swamps
both: the shrinking is held by one blade at a known rank.

**`perf:gpu` wants a quiet GPU.** It holds each scene to a baseline for
the adapter within 15% both ways. Another app on the GPU (an image
generator was seen to) moves every scene 10-30% together; when the
standard scene, which has no grass, moves as much as the rest, it is the
machine. Judge a change against its parent commit run alternately instead,
and take baselines only when it is quiet. And warm the GPU before timing
anything: one that sat idle while the renderer was set up runs slow for a
while, and the scene timed first read a sixth over its baseline in half of
the runs on a quiet machine until three hundred frames were drawn before
it.

## Antialiasing on the game path

`src/game/__tests__/antialias.gpu.test.ts` draws a black square turned on a
grey sky, lit by nothing, so a frame without antialiasing has exactly two
colours in it: four samples a pixel, and FXAA, each put more than a hundred
pixels between the two along its edge, and change not one pixel off the
stair. Then everything that draws into the scene, drawn into four samples:
grass, a sprite and an effect layer where they are without them; a kept
static half equal to the pixel to one drawn afresh, and not frozen when
something moves; the fog marched over the multisampled depth within two
levels of the plain one off the edge; the occlusion alongside. The ladder
steps to FXAA and to none and back to the same frame, each rung is the look
it names, and a look that asks for none compiles the 46 pipelines v0.19.0
did (and FXAA one more, four samples 36 more). A resize to a pixel and to an
odd size draws without an error, under an error scope, which is how every
frame in the file is drawn: a pass wrongly put together draws nothing and
says so only to the console. `look.test.ts` holds the choice of
antialiasing, the multisampled fog's derivation from the plain one and
FXAA's reads without a device.

On every rung of the ladder (shadows, points, the cull, post, fog,
occlusion, effects, particles) four samples draw what one does off the
edges, and stepping back up gives the same frame; those frames are drawn
with a `dt` of nothing, since the fog's march is dithered by the frame's
time and two frames a sixtieth apart differ in thousands of pixels.

**A thick fog says nothing.** The fog test first used a fog so dense that
the whole frame was its colour, and "the same fog with four samples as
with one" was white against white; it was found by looking at the frames.
It is thin now, and the square shows through it. Look at what a pixel test
compares before believing it compares anything. The rung test had the same
fault in another form: the ball's shadow fell on the black square, black on
black, and drawing every rung through the fully shadowed build survived it
until the square was grey.

## The toon light on the game path

`src/game/__tests__/toonlight.gpu.test.ts` lights a mid-grey ball in toon
bands, with the toy finish (below) turned off so the bands are what is
measured, and a ball over a floor for the sun's shadow. Each setting asked for
as nothing draws as a look that never mentions it; a physically based look
ignores all four; and each moves only what it says: the soft band edge
leaves every pixel more than six from a hard band's edge as it was, and
turns four hundred pixels of stair into none; the shade colour turns the
ball's shade and its shadow on the floor blue-violet and leaves the floor
in the sun as it was; the rim brightens the outer tenth of the ball and
leaves its middle as it was; the sky and ground light the top of the ball
blue and its underside warm. The grass, lit by the same fragment stage,
takes them too. `look.test.ts` holds their packing: a look that asks for
none of it packs noughts, which is what skips every branch that reads it.

Three things this file learned. **Nothing is seen at white:** a white ball
in a sun of 2.5 is held at white by the straight tone, and a tint, a rim or
a softened edge on it changes nothing; the ball is mid grey. **A band's
edge meets the outline**, where the surface turns away and any ramp is
squeezed into a pixel, so the stair is counted three pixels in. And **an
eased edge looks as if it had a dark line along it:** it is the eye's own
Mach band at the ramp's knee, and reading the pixels across it (172 up to
190, never down) settled it.

**The same frame, to the bit, is a property of the compiled code and not
of the arithmetic.** The sky and ground light first replaced the ambient
term with a branch of its own, `if (sky and ground) { colour += ... } else
{ colour += the old term }`: the same arithmetic on the old side, and the
frames moved in their last bits, which is what the compiler made of a sum
split across a branch. It now replaces what that sum starts from, and the
sum is written as it always was. It was found by hashing the frames of a
wide set of scenes, half floats and shown, on the tree before the change
and after it: 76 hashes, which then matched.

## The toy finish on the game path

`src/game/__tests__/toy.test.ts` holds the finish's sums without a device.
The smooth light's ramp (`toonRamp` in `toon.ts`) is the deepest band
exactly where the sun does not reach and one exactly on flat ground, for
every sun and every form; it never falls and never jumps as the sun's share
rises, is never flat between the two, falls away from flat ground at the
form light's slope, is the form light's top band to the bit wherever the
form's fall is over the band between, and under the knee where it comes down
to it rises from the deepest band no higher than the band between (a ramp
that rose past it read ooergolf's hill flatter, which its look metrics
caught). The soft tone leaves a colour under its knee exactly as
it was, never passes one, keeps a colour's hue as it brightens where the
clamp turns an orange yellow, sends a white highlight on red plastic to
white while the red round it stays red, keeps a lit pastel its colour
(a pastel is as white as a highlight, and nowhere near as bright), and keeps
a lit red's gradient where the clamp holds it flat. And the packing: the finish is on in a toon look
that says nothing of it and off, part by part, where it says nought.

`toy.gpu.test.ts` holds it on a device, each part against the same look with
that part at nought: a physically based look takes none of it; the highlight
is one compact spot, white at its middle, on a smooth ball and nothing on a
matte one or on grass (a smooth blade in a crease takes no highlight, no
sheen and no tint, whatever the look asks), never in another thing's shadow, and its brightest
within a third of itself as a ten-pixel ball moves an eighth of a pixel at a
time (it read 375 to 420 over the eight steps; with the widening taken out,
141 to 303, which is the sparkle the widening is for); the sheen lifts a smooth ball's edge and not its middle, bluer, and
is shut out of a crease; the ramp turns the bands' stair into none and
leaves flat ground in the full sun and deep in a shadow as they were; the
occlusion's tint turns a crease bluer, from the sky's light as well as the
sun's, and nothing where there is no occlusion or no shade colour. The ramp
at nine angles to the sun and with the form light, and the soft tone at five
strengths of sun on an orange and on a cream, are held to their sums in
`toon.ts` within a level (the cream because the orange never goes white, and
a shader whose white spill had drifted passed on the orange alone). A
pixel, an odd size, millimetres against tenths of a metre, a kept frame
against a redrawn one and every rung stepped down and back each give what
they should.

Three things this file learned. **A setting that is on unless said has to be
said off to be measured:** the harness first merged each shot's look onto
the last, the finish was switched off by the frame before and never back on,
and the pictures of the finish were pictures of the bands. **The grass
differs from itself by a pixel from one frame to the next**, with nothing
changed, where two blades meet at the same depth; it did in v0.21.0 too, and
a test that compares grass frames allows it and says so. **The same frame to
the bit, again:** the occlusion's tint first split the occlusion's two sums
into a tinted branch and a grey one, and a frame of the golf's look moved one
pixel by one level; the grey sums are written as they were now, and the tint
changes only what they are handed. Found by comparing forty frames of
v0.21.0, toon and physically based in every antialiasing and frame mode,
with grass and with lamps, against the finished tree with the finish off.
**What code costs is paid where it is compiled, asked for or not:** the
finish's code in the grass's build cost ooergolf's rough 0.45 ms of a 2.5 ms
frame (+19%) with every part of it at nought, where the renderer's own golf
scene, with a sparser field, read +0.07. With the grass switched off the two
agreed. Compiling the highlight, the sheen and the tint out of the grass
(`SceneVariant.matte`) brought it to +0.2 (+0.12 to +0.29 over five
rounds alternated with its parent), and one picture of ooergolf's moved, the
blades at a rail's foot a shade greyer where the tint had turned them; the
soft tone, timed against the clamp, cost nothing. Holding the tint's colour for less of the shader first,
by working it out again where the sky's light takes it, saved nothing.

## Rounded edges

`src/mesh/__tests__/rounded.test.ts` holds the rounded box and the rounded
profile: closed and well formed, exactly the size asked, every point the
radius from a box that much smaller and facing straight out from it, no
hard edge anywhere and flat across each face; a profile's arcs tangent to
its sides, on the inside of each turn, its open ends kept, never crossing
itself on a short side, and a lathe's rims rounded and the solid still
closed. Two of those held nothing at first: a round bulging the wrong way on
a right turn, and two rounds crossing on a short side, each passed until the
test looked at where the points were and not only how many there were.

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

## A lamp in the rig

`src/render/__tests__/lamp.gpu.test.ts` hangs one rig light in the scene
rather than in the sky — a position, a cone, a reach — over a bead floating
clear of a matte table, and checks three things: that it pools where it is
aimed and leaves the rest of the table dark, that the bead's shadow lands on
the table, and that the raster and the tracer agree about all of it to within
eight levels.

The third is the one that earned its keep. It found two faults the first two
could not, because both were places where the raster quietly did nothing:

**A rig light did not cast unless the key was lit.** `shadowOn` in the frame
uniform was the key's strength alone, which is right while the key is what
lights a piece and wrong the moment the rig can light one by itself. A scene
lit by a bench lamp with the key turned down threw no shadow at all, and the
lamp read as a broken shadow map rather than as a switch left off.

**A perspective map wants its bias in its own depth.** The sky's rig maps are
orthographic, and their depth is linear across the scene, so one bias in clip
depth means the same number of world units everywhere. A lamp's map is a
perspective one from the lamp, and the same figure was worth a few world
units close in and some tens further out: the shadow lifted off the table and
started a good six millimetres late. The lamp now carries `depthScale` —
`near·far/(far−near)` — and the shader divides it by the squared distance,
which is a bias in world units expressed in that map's own depth. Taking the
conversion out again moves the near half of the shadow by 28 levels, which is
what says it is load-bearing rather than tidy.

The shape of the test is worth copying for anything else lit from a place
rather than a direction: profile a line of table across the shadow, print
raster and traced side by side, and look at where they part company. Both
faults showed as a run of pixels where the two disagreed by twenty or thirty
levels with the rest of the line agreeing to within four.

**Two traps in arranging the scene**, both of which cost a run each. A squat
piece sitting on the table under a high lamp throws a shadow its own base
covers — the same thing that made a chessboard look unlit — so the bead here
floats. And a pool falls off from where it is aimed, so a point in shadow
must be measured against its mirror image in the pool rather than against the
pool's middle, or the lamp's own falloff is counted as shadow.

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
