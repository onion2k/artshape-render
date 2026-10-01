# artshape-render: working on it

A library, not a game: two renderers over one core, shipped as TypeScript
sources that consumers pin by git tag. The README says what it is and
`TESTING.md` how it is tested; this file says how it is changed. The house
rules in `~/.claude/CLAUDE.md` apply too. Where they speak of a game (a test
API on `window`, a fuzzer, a save), this file says what stands in for each
here, or that nothing does.

## Commands

    npm run typecheck   tsc over every source, GPU tests included (~2 s)
    npm test            the node suite: Vitest, src/**/*.test.ts, jsdom where a DOM is wanted (~5 s)
    npm run test:gpu    the GPU suite: src/**/*.gpu.test.ts in the machine's own Chrome, headless,
                        WebGPU on (vitest.browser.config.ts); VITE_FRAME_DIR=dir writes its frames as PNGs
    npm run perf:gpu    the game path's frame timed on this GPU and held to perf-baseline.json (~5 s)
    npm run perf:gpu:update   writes this GPU's figures as its baseline

There is no `check` script, no pre-commit hook, no lint and no formatter.
Until there are:

- **The quick check** is `npm run typecheck && npm test`. It is what CI runs
  on every push and pull request (`.github/workflows/check.yml`).
- **The full check** is the quick check, `npm run test:gpu` and
  `npm run perf:gpu`. It runs only on a machine
  with a real GPU: a runner's only adapter is SwiftShader, some two hundred
  times slower, so it stays local. Run it before committing anything that
  draws.

## Layout

- **`src/game/` is the game path.** It draws every frame, for a game with
  things moving: `renderer.ts` (`GameRenderer`: groups of instanced
  placements, the look, the economy ladder, shadows, occlusion, fog, post),
  `shaders.ts` (every WGSL string, and the scene shader's variants as module
  constants), `toon.ts` (the toon look's sums: the smooth light's ramp and
  the soft tone, in TypeScript and in WGSL built from the same constants),
  `particles.ts` (the GPU particle pool and sprites), `fog.ts`, `lights.ts`
  and `shadows.ts`. Games import from here.
- **`src/render/` is the still-life renderer.** It draws one piece well and
  redraws only on a change (`renderer.ts`, `viewer.ts`, the path tracer,
  environments in `env.ts`). The game path borrows two things from it:
  `bakeEnvironment` from `env.ts`, and `ContactOcclusion` from `ao.ts`.
- **What both share, and what has no picture:** `gpu/` (device, buffers,
  camera), `geom/`, `mesh/` (the generators, and `rounded.ts`: a rounded
  box and rounded profile corners, for a toy's moulded edges), `parts/`,
  `pattern/`, `assembly/` and `dsl/`. All of it is pure and runs under node.
- **The thing without its picture.** A renderer's arithmetic lives in pure
  functions beside it and is tested under node. Examples are `fogUniform`
  and `viewDepth` in `fog.ts`, `sunShadowMatrix` in `shadows.ts`,
  `LightPool` in `lights.ts`, `sceneSource` in `shaders.ts`, `toonRamp`
  and `softTone` in `toon.ts`, and `calibrate.ts` for the viewer. The GPU classes take everything as
  arguments or properties and never read a clock: time comes in as `dt`
  on `frame`.
- **Content** is the consumer's. The only content here is the DSL's
  builtins, the part builders and the environments' presets.
- **What persists** is nothing of the game path's. The still-life viewer
  keeps its calibration verdict in `localStorage` (`calibrate.ts`), which
  is its one persisted shape.
- **The public surface** is every file under `src/`, by the `./*` export
  in `package.json`. A consumer can import anything, so a rename anywhere
  is a breaking change to someone.

## Consumers

Pinned by tag, so nothing changes for a game until it moves its pin. What
each pins today:

| Consumer | Pin | Path used |
| --- | --- | --- |
| bearing | v0.22.1 | game |
| ooergolf | v0.22.2 | game |
| pushminer | v0.16.1 | game |
| coinpush, artshape-game-template | v0.16.0 | game |
| heist, artshape (the still-life viewer) | v0.15.0 | render (`Viewer`) |
| arena, chess | v0.13.0 | game, and render for stills |

A change to the game path must leave a game that does not ask for it
drawing the same frame to the pixel, and boot no slower. Both can be proved
here with a GPU test.

## Model features

What to copy the shape of:

- **Something a game sees:** the particles. `particles.ts` is a class that
  takes the device and its capacities in its constructor, compiles its
  pipelines off the main thread into a `ready` promise, and has a fixed
  pool that is never resized. The game hands it plain data (`Emit`, a
  sprite array). `GameRenderer` owns one, exposes `emit` and `setSprites`,
  and gates it on the economy (`particles`). Its tests are
  `particles.test.ts`, which holds the layouts, and `particles.gpu.test.ts`
  and `sprites.gpu.test.ts`, which check pixels.
- **A pass over the frame with its maths on the CPU:** fog. `fog.ts` holds
  the record (`Fog`, with `noFog(mmPerUnit)` as the default that costs
  nothing) and the packing (`fogUniform`). `fog.test.ts` checks it against
  the camera's own projection. `fog.gpu.test.ts`, `fogreach.gpu.test.ts`
  and `fogcones.gpu.test.ts` check pixels.
- **An effect a look turns on, with a rung that turns it off:** occlusion.
  It is `look.occlusion` (0 is none and no passes) and `economy.occlusion`,
  and `occlusion.gpu.test.ts` checks that it darkens where it should, and
  does not with the strength at nothing or the rung off.
- **Something a game sees that the GPU grows:** grass. `grass.ts` is the
  thing without its picture (the field, the blades' growth, the thinning,
  the wind, the trample), and `grass-pass.ts` grows and draws it, lit by the
  scene's own fragment stage through `sceneWith`. The WGSL grows the same
  blades as the TypeScript, and a GPU test holds the two equal. It is made
  only when a game first calls `setGrass`. Its tests are `grass.test.ts` and
  `grass.gpu.test.ts`, and its cost is the `golf` scenes in `perf:gpu`.
- **A shader variant:** toon (`SceneVariant.toon`). It is a module constant
  in the WGSL and not a uniform, so every build of the scene shader is
  compiled up front. `toon.gpu.test.ts` holds that a look which says
  nothing draws exactly as before.
- **Builds compiled when first asked for:** antialiasing. `look.antialias`
  asks, `prepare()` compiles and says when it is in, and `economy.antialias`
  is its rung. Four samples a pixel need a pipeline at `SAMPLES` of
  everything drawn into the scene pass, all made in `compileMsaa` (the
  scene's builds, the effect layers, `Particles.multisample`,
  `GrassPass.multisample`, and the fog's march over the multisampled
  depth). `antialias.gpu.test.ts` holds that a look which does not ask
  compiles nothing more, and draws each rung.
- **A finish on by default, with its sums in two languages:** the toy
  finish (`gloss`, `sheen`, `smoothShading`, `occlusionTint`). Each is on
  in a toon look unless it says nought, and nought of all four is toon as
  it was before, which is the anchor its regression tests rest on: every
  test of the bands asks for them by turning the finish off. `toon.ts`
  holds the ramp and the soft tone as sums with their WGSL built from the
  same constants, `toy.test.ts` holds the sums, and `toy.gpu.test.ts`
  holds the shader to them and each part against itself at nought. Grass
  is built without the highlight, sheen and tint (`SceneVariant.matte`):
  code in the scene shader is paid by every blade whether it is asked for
  or not, so time a change to it in a game with a dense field too.
- **Builds compiled when first handed a thing that wants them:** the flow
  kinds. A placement's pattern kind 5, 6 or 7 (`flow.ts`: ripple, crust,
  drift) is drawn through `SceneVariant.flowing`, a build made only of
  strings spliced into the scene shader's text, so every other build is the
  text it was to the byte; it is compiled when `setStatic` or `setDynamic` is
  first handed such a group (`askFlow`, sixteen builds, and again at four
  samples if `compileMsaa` has run or runs), and `prepare()` waits for it.
  Its clock is the frame uniform's `spare0`, written from `GameRenderer.time`
  and read by no other build. A static flowing group is not in the kept
  frame: `keep` redraws it each frame over the kept rest. `flow.test.ts`
  holds the packing, the splices and `shaders.test.ts` the "not a word of it
  elsewhere"; `flow.gpu.test.ts` holds that a game that does not ask draws
  the same at any time and compiles nothing, and each kind, the clock, the
  glow and the rest of the checklist; `perf.gpu.test.ts` has its scene.
- **A setting of the look read under a uniform:** the toon light
  (`bandSoftness`, `shadeColour`, `rim`, `skyLight`, `form`). A few instructions a
  pixel, so a uniform and not a permutation; `toonUniform` packs a look that
  asks for none of it as noughts, and every branch reading it is skipped.
  `toonlight.gpu.test.ts` holds that each moves only what it says.

## The test API

A library's test API is its own constructors, run headless:

- **A device with no canvas:** `createDevice()` from `gpu/context.ts`.
- **A renderer at a small size:** `new GameRenderer(gpu, lights, effects,
  particles, mmPerUnit)`, then `await renderer.ready`, `setEnvironment`
  (from `bakeEnvironment(gpu, preset, { size, mips })`, awaiting its
  `samples`), `resize`, `setStatic`/`setDynamic`/`setLights`, and the
  camera placed.
- **A frame:** `renderer.frame(target.createView(), mode, dt)` into a
  texture of `gpu.format`. Time moves only by the `dt` each frame is
  handed, so a test steps it exactly.
- **What a look asks to be compiled:** `await renderer.prepare()` after
  setting `look.antialias`, before the frame that should have it. Without
  it the frame is drawn with what has compiled, which depends on when.
- **Reading back:** each GPU test copies the target to a buffer and maps it.
  There is no shared helper yet; `toon.gpu.test.ts` has the usual one, with
  the PNG writer for `VITE_FRAME_DIR`. `renderer.hdr` gives the frame
  before the tone map. `readbackLayer` in `gpu/context.ts` reads one layer
  of a texture.
- **The still-life renderer** has `pending`, which a test waits on until
  bakes have landed. It never counts frames.

- **Timing a frame:** `perf.gpu.test.ts` times `standardScene()` (a
  ground, four hundred boxes, ooergolf's toon daylight look from its home
  view, at 1280×800) as a median of throughput runs, and `perf.ts` judges
  it. A feature's own scene joins it there.

## Edge-case checklist

For anything new on the game path, say what it does:

- **nothing asked:** a game that never uses it draws the same frame to the
  pixel and compiles nothing new before `ready`
- **units:** a world in millimetres (`mmPerUnit` 1, arena and chess) and
  one in tenths of a metre (100, the golf); every length the feature fixes
  goes through `mm()`
- **the look:** PBR and toon; the `filmic`, `clamp` and `soft` tone maps;
  the toon light asked for and not; the toy finish on, as toon's default,
  and each part at nought, which with all four is v0.21.0's toon
- **antialiasing:** none, FXAA and four samples a pixel. Anything drawn
  into the scene pass needs a pipeline at `SAMPLES`, made in `compileMsaa`,
  or the pass refuses it; anything reading the scene's depth after it reads
  a multisampled one then, as the fog's march does
- **the economy:** each rung (`shadows`, `points`, `particles`, `post`,
  `fog`, `occlusion`, `effects`, `grass`, `wind`, `antialias`) on and off,
  and the feature's own rung;
  a rung stepped down and back gives the same frame
- **frame modes:** `redraw` and `keep`. A kept static half must not freeze
  something that moves.
- **the passes it reaches:** the sun's shadow map, a spot's, the occlusion
  depth prepass, the scene, the fog march (which reads depth), bloom, and
  the half-float frame (held by `finite`; see `overflow.gpu.test.ts`)
- **capacity:** at nothing, at capacity and past it. What is kept is fixed
  at construction, and past capacity it is dropped, never grown.
- **resize:** a size of one pixel, an odd size, and resized mid-run
- **before ready, and without an environment:** `frame` draws nothing and
  says so
- **dispose:** every buffer and texture it made is destroyed
- **time:** the same `dt`s or game time give the same picture. Nothing
  reads a wall clock.
- **devices:** Apple (a write past the half float is held at the top) and
  Direct3D (it becomes infinity), and a browser without a feature it asks
  for (Firefox's WebGPU has differed on bind groups)

## Gates

| Gate | Holds | Baseline | Tolerance |
| --- | --- | --- | --- |
| typecheck | every source compiles, GPU tests included | none | exact |
| node suite | the maths, meshes, parts and DSL, and the game path's arithmetic; 1,071 tests in 68 files at v0.22.0 | none | exact |
| GPU suite | pixel properties: it draws, the look, the rungs, fog, shadows, occlusion, overflow, grass, antialiasing, the toon light, the toy finish; 164 tests in 25 files at v0.22.0, and the perf gate skipped unless asked, ~25 s on an M4 Pro | none: no golden pictures | per test |
| perf:gpu | each scene's frame, by adapter; `standard` was 0.60 ms on an M4 Pro (`apple/metal-3`) | `src/game/__tests__/perf-baseline.json` | ±15% both ways: five runs of the unchanged tree spread 0.59–0.64 ms, and it failed a frame with the occlusion off (40% quicker) and one with four times the fog's steps (51% slower). An adapter with no baseline passes and says so. Run it on a quiet machine: another app on the GPU (an image generator was seen to) moves it 10–30%, and then a change is judged against its parent commit run alternately instead. |

**Missing, and each is a house rule this project does not yet meet:**

- **No performance gate for the still-life renderer, and none in CI.**
  `headroom.gpu.test.ts` prints stage times for the still-life renderer and
  holds none of them. `perf:gpu` holds the game path, on a machine that has
  a baseline, and SwiftShader would say nothing true about it.
- **No look gate.** No picture is held. The GPU tests assert properties of
  pixels, which catch a broken feature but not a changed look.
- **No full-check script, no pre-commit hook, no lint, no formatter.**
- **No leak gate.** Pools are fixed at construction, which is the rule that
  stands in for one, and their sizes are the constructor's arguments.
- **No fuzzer.** A library has no player. The nearest thing is holding a
  feature across the economy's rungs and the frame modes.

## Commits and releases

Commit only when asked, in the house voice. A release is a commit that
moves `package.json`'s version alone (`0.18.0`), tagged `v0.18.0` and
pushed with the tag. Consumers move their pins in their own feature.
