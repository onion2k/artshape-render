# artshape-render

[![Check](https://github.com/onion2k/artshape-render/actions/workflows/check.yml/badge.svg)](https://github.com/onion2k/artshape-render/actions/workflows/check.yml)

A still-life renderer for small made things, and the language that feeds
it. Parametric parts — plates, wires, revolves, sheets — placed by
anchors and symmetries, drawn over raw WebGPU with one material model
covering metals, nacre, gems, enamel, wood, plastic and light.

Taken out of [artshape](https://github.com/onion2k/flower) in September
2026, where it had been the renderer behind a jewellery sketchbook, and
where a chess game had already vendored a copy of it. Nothing here knows
about jewellery, chess, or a page: no editor, no catalogue of examples,
no DOM beyond the canvas the viewer is given.

**It holds two renderers over one core.** `render/` draws a still life —
one piece, beautifully, redrawn only when something changes. `game/`
draws every frame, for something with hundreds of things moving in it.
They share the device layer, the geometry, the parts, the language and
the calibration; they share no shading, because sharing it was measured
and found to cost more than the duplication. The name still says
*render* because two projects pin this repository by URL and renaming it
would cost them something for nothing.

## What it does

- **Four ways to make a mesh** — a plate from a 2D outline, a sweep of a
  profile along a curve, a revolve of a silhouette, and a parametric
  sheet thickened into a shell. New shapes are mostly new outlines and
  functions, not new mesh code.
- **Every mesh carries surface coordinates in millimetres** beside its
  0..1 uv, so a groove is the same width on a plate, a wire and a bead,
  and engraving and lettering are cut in real sizes.
- **One material model, two renderers.** A raster path fast enough to
  work in, and a path tracer — fetched only when a traced frame is asked
  for — that is the honest answer the raster is held to.
- **Lighting that reads as a bench**: a baked environment or a loaded
  HDRI, a reflection probe, a movable area key with a soft shadow, a
  studio rig whose lights are discs in the sky or lamps standing in the
  scene with a cone of their own, the piece's own lights, contact
  occlusion, and a film pass.
- **A table the piece sits on**, hard or cloth, with a cushion it sinks
  into, and a camera with a lens in millimetres.
- **It measures the machine it is on.** The viewer times its first frames
  and keeps the verdict, then holds a ladder: fewer pixels first, then
  the supersample, coarser soft shadows, no contact pass, fewer
  triangles — and gives each back when there is room. The bakes' budgets
  follow the same verdict.

## Using it

    npm install github:onion2k/artshape-render

It ships TypeScript sources rather than a build, and expects a bundler
that compiles them — Vite, as both current consumers use. There are two
web workers inside it (the traced scene's BVH, and body counting), both
constructed by the library itself so their URLs resolve against its own
files; a consumer needs to do nothing about them beyond not pre-bundling
the package.

A page, at its smallest:

```ts
import { Viewer } from 'artshape-render/render/viewer';
import { compile } from 'artshape-render/dsl';
import { groupByMesh } from 'artshape-render/assembly/groups';

const viewer = await Viewer.create(document.getElementById('stage')!);
const { sketch } = compile(`
material gold polished
part petal = leaf(length: 34, width: 15, thickness: 1.1, piercings: 3)
form f { repeat petal around ring(8, radius: 5.5) }
`);
viewer.setInstanced(groupByMesh(sketch!.assembly));
viewer.frameBounds(sketch!.assembly.bounds());
```

Or drive the renderer directly with your own meshes and no language at
all: `render/renderer` takes instance groups of positions, normals and
matrices, and `mmPerUnit` converts if millimetres are not your unit.

`compile()` takes a `resolve` callback for a sketch's `use` of another
sketch; the library has no catalogue of its own to fall back on, which is
deliberate — where the sketches live is the application's business.

## Layout

    src/gpu/        the device, the canvas context, the camera and orbit
    src/geom/       vectors, transforms, curves, outlines
    src/mesh/       the four generators, deformation, wear, engraving
    src/parts/      the catalogue of parts and their anchors
    src/pattern/    symmetries
    src/assembly/   placements, grouping by mesh, body counting
    src/render/     the renderer, the tracer, the bakes, materials, the viewer
    src/dsl/        the language: lexer, parser, evaluator, builtins
    src/game/       the other renderer: forward, every frame, many lights

## The game path

For a fixed or slowly-moving camera with a lot happening in front of it —
an arena, a board, a side-on level. Its shape was decided by measurement
in a [spike](https://github.com/onion2k/arena-spike), not by taste:

```ts
import { GameRenderer } from 'artshape-render/game/renderer';
import { LightPool } from 'artshape-render/game/lights';

const game = new GameRenderer(gpu, 512);
await game.ready;
game.setEnvironment(env.specular, env.brdf, env.mips);
game.setStatic(arenaGroups);      // the parts of the scene that do not move
game.setDynamic(droneGroups);     // a fixed pool; `move` writes into it
game.setLights(pool);             // hundreds of them, no shadows
game.frame(context.getCurrentTexture().createView(), 'keep');
```

What the measurements settled, so nobody has to re-argue it:

- **Forward, not deferred.** A plain loop carries three to five hundred
  point lights before it wants tiles or clusters — 0.018 ms a light at
  1080p — which is more than an arena needs.
- **No culling, no LOD.** Eight thousand movers at nearly five million
  triangles cost under three milliseconds.
- **Effects get their own stage.** Additive layers through a shader that
  only fades and tints cost a third of what they cost through a material.
- **`move` writes matrices and touches nothing else.** The still-life
  path's `moveAll` re-measures bounds, lights, probe and shadows after
  every move, which costs 1.4 ms a frame at eight thousand placements
  and is right for a piece being dragged.
- **`'keep'` holds the static half's colour and depth** rather than
  redrawing it — worth almost all of a heavy arena's cost, and worth
  nothing if the lights that reach it move, because then it is stale.

**A world unit is the game's to choose.** `new GameRenderer(gpu, lights,
effects, particles, mmPerUnit)` says how many millimetres one of them is, and
defaults to one, as the still-life path's `mmPerUnit` does. Everything a game
hands over — meshes, matrices, camera, light radii, emitters — stays in its
own units; what converts is what the renderer fixes in a real size: the near
plane of a spotlight's shadow map, the soft kernel's bias, gravity, and the
opening values of the look and the fog, which `defaultLook(mmPerUnit)` and
`noFog(mmPerUnit)` will give you in any unit. A length that is per unit
rather than a unit — the fog's density, the look's `spotSoftness` — scales
the other way, and says so where it is declared.

Everything the ladder can give up is a shader permutation rather than a
uniform. A branch the compiler cannot fold leaves the code resident, and
residency is most of what a shader costs: gating the still life's table
reflection behind a uniform saved nothing measurable, where compiling it
out saved five milliseconds a megapixel.

## Checking it

    npm test          920 tests, node
    npm run test:gpu  75 tests, headless Chrome with a real device
    npm run typecheck

The GPU suite runs in the machine's own Chrome through Vitest's browser
mode; nothing is downloaded. `VITE_FRAME_DIR=/some/dir npm run test:gpu`
writes the frames those tests draw out as PNGs, for looking at.

A rendering change is held to the tracer or to a known answer before it
is kept — the furnace test, and the raster-versus-traced comparisons,
exist for that. Where the two disagree, the tracer is the reference.

## Licence

MIT — see [LICENSE](LICENSE).
