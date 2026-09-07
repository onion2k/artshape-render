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
