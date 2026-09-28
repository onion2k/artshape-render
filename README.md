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
    src/game/       the other renderer: forward, every frame, many lights, grass

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
- **A pattern is a permutation, not a branch.** A group given `patterns`,
  eight floats a placement (`PATTERN_STRIDE`: kind, scale, seed, then a
  second colour), draws through a build of the scene shader with the pattern
  code in it — a swirl, bands, marbling or speckle, mixed into the albedo
  from where on the thing a fragment is, so it turns with the thing — and
  every other group through a build without it, which pays nothing.
- **Toon is a look, and a tone.** `look.shading = 'toon'` draws every
  group through a permutation that lights a surface in three flat bands at
  its own colour and tints the sky's light by it, where the physically
  based shading takes a quarter of the colour and adds the sky's light grey
  over it; and `post.tone = 'clamp'` shows the frame straight, held at
  white, where the filmic curve holds a bright colour short of white and
  pulls it toward grey. Together they are a bright, flat, saturated world.
  Left out, both are what they always were, to the pixel.
- **Sprites are particles the game places.** `setSprites(data, count)`,
  eight floats each (`SPRITE_STRIDE`: position and size, colour and alpha),
  draws soft camera-facing puffs where the game says, every frame, with the
  particles' blending and under their rung of the ladder. For what has to
  follow the game's own clock — smoke in a game that steps its own time —
  where a particle is born and aged on the GPU and moves only when a frame is
  drawn.

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

**Occlusion is the still life's contact shadow, run for a game.** Set the
look's `occlusion` above nothing and each frame gains a depth pass of
everything, the occlusion from that depth at half the frame, and a blur that
stops at edges; the scene darkens its ambient term by all of it and its
lights by `occlusionDirect` of it. `occlusionRadius` is the size of gap it
darkens, in world units. The `occlusion` rung gives up the three passes.

**Edges are smoothed when a look asks.** `look.antialias = 'msaa'` draws
the scene at four samples a pixel, colour and depth, and resolves it before
the fog and the post chain: every group, blade, particle, sprite and effect
layer, and the static half a kept frame holds, is smoothed where it covers
part of a pixel, and nothing inside a surface moves. `'fxaa'` smooths the
finished frame in one pass instead (FXAA 3.11 at its default quality), which
is cheaper and a little softer. `economy.antialias` is the ladder's rung for
it: `'fxaa'` steps four samples down to the pass, `'none'` gives both up, and
it never gives more than the look asks. Neither compiles a thing until a
look asks for it; `await game.prepare()` after setting the look compiles
what it asks for, and until then a frame is drawn with what is compiled.

```ts
game.look = { ...game.look, antialias: 'msaa' };
await game.prepare();                          // the four-sample builds, and FXAA for the rung below
game.economy = { ...game.economy, antialias: 'fxaa' };   // a slower machine's rung
```

**Toon light has depth when a look asks.** Five settings of a toon look,
each off unless set, and each a few instructions a pixel: `bandSoftness`
eases the bands' edges (and the glint's) so a band's edge on a curve is a
clean line; `shadeColour` tints the shaded band and the sun's shadow toward
a colour instead of a darker grey; `rim`, `rimColour` and `rimWidth` put a
bright edge where a surface turns from the camera; and `skyLight` and
`groundLight` light a surface from above in the one and from below in the
other, in place of the environment's grey; and `form` keeps some of the
sun's fall-off in the top band, so a slope turned from the sun is a little
darker than flat ground and one facing it a little brighter, and a gentle
hill, which a high sun would otherwise light as brightly as the flat, shows
its shape. The grass is lit by the same fragment stage, so it takes them
too. A physically based look ignores all five: its Fresnel term is its rim,
its environment its sky, and its fall-off is the sun's own.

```ts
game.look = {
  ...game.look, shading: 'toon',
  bandSoftness: 0.06,
  shadeColour: [0.5, 0.52, 0.8],            // a cool blue-violet shade
  rim: 0.5, rimColour: [1, 0.95, 0.85], rimWidth: 0.3,
  skyLight: [0.42, 0.5, 0.62], groundLight: [0.45, 0.4, 0.28],
  form: 1.5,                                 // slopes shaded by the sun they take
};
```

A look that asks for none of this draws the frame v0.19.0 drew, to the bit,
and compiles the same 46 pipelines before `ready`. What each costs, on an M4
Pro at 1280x800, as the median of nine rounds alternating it with none on a
GPU other programs were using:

| Setting | Standard scene | Golf field |
| --- | --- | --- |
| `antialias: 'msaa'` | +0.14 ms (0.10 to 0.22) | +0.43 ms (0.37 to 0.58) |
| `antialias: 'fxaa'` | +0.04 ms | +0.13 ms |
| the toon light's four, together | +0.01 ms, rounds spread ±0.07 | +0.03 ms, rounds spread ±0.1 |
| `form: 1.5` (0.21.0) | +0.003 ms, rounds spread -0.06 to 0.03 | +0.04 ms, rounds spread -0.03 to 0.11 |

Each of the toon light's settings alone read under 0.01 ms on the standard
scene, which is to say no cost could be told from the noise. Alternating
v0.19.0 and this release five times each, a look asking for none of it read
0.73 and 0.72 ms on the standard scene, and within 3% either way on the golf
scenes. Four samples take 49 MB of colour and depth at that
size, and as much again for a kept frame once `keep` is drawn with them;
FXAA takes 4 MB.

**Grass is its own pass, and the one thing here that culls and thins.** A
game hands `setGrass` a field: a grid over its ground saying which of up to
eight kinds grows in each cell (none where a cup is cut or a rail stands)
and how high the ground is there, what grows beyond it, and a seed. No blade
is ever listed. Each frame the CPU picks the chunks in view, a compute pass
grows every blade in them from the seed and the mask and keeps those in
view and kept at their distance, and two indirect draws put five triangles
on a near blade and one on a far; they never come back to the CPU. A blade
is lit by the scene's own fragment stage, so the look reaches it as it
reaches anything, but it is drawn into neither the sun's map (unless asked)
nor the occlusion's prepass, which were half of what blades cost as a
group: a million of those measured 7.8 ms on an M4 Pro at 1280x800.

```ts
import { grassGround, type GrassField } from 'artshape-render/game/grass';

await game.setGrass(field, { trample: { origin, cell: 0.25, cols, rows } });
game.time = gameTime;             // the game's own clock: the wind and the trample read it
game.wind = { direction: [1, 0.3], strength: 0.6, gustSize: 20, gustSpeed: 4 };
game.press(ball.x, ball.y, 1, vx, vy);   // the grass laid flat behind a rolling ball, standing again in six seconds
```

It thins as `(near / d)²` past `near`, so a field to the horizon costs what
its near part does, and a blade sinks into the ground as the camera draws
back rather than blinking out; `economy.grass` thins it by the same ranks
and `economy.wind` stills it. The golf field (a 27 by 39 green and rough to
300 units, 92,000 blades at the home view) adds about 0.36 ms. A game that
never calls `setGrass` compiles nothing more and draws the same frame.
`grassGround(kind)` is the colour to paint the ground under a kind, so the
gaps between blades do not show.

Everything the ladder can give up is a shader permutation rather than a
uniform. A branch the compiler cannot fold leaves the code resident, and
residency is most of what a shader costs: gating the still life's table
reflection behind a uniform saved nothing measurable, where compiling it
out saved five milliseconds a megapixel. The one exception is the occlusion's
read in the scene shader: a single texture tap under a uniform, because the
cost of occlusion is its passes, which the rung does skip, and a
permutation for one tap would double the scene pipelines compiled at load.

## What may go in

The material record and the tracer are shared by every consumer, and a
loose stone under a gemmologist's loupe wants more of them than a ring on
a bench. The rule that keeps one renderer serving both: a material may
carry any measured property at a neutral default, and any tracer feature
beyond the shared model is a permutation a consumer asks for, compiled
out otherwise. A fluorescence, a pleochroic absorption, a calibrated body
colour are numbers on the record that a stone without them never pays
for; spectral fire, birefringence and the like are `RendererOptions`
that leave the shader as it was for anyone who did not set them.
Residency is most of what a shader costs, so a feature gated by a
uniform rather than compiled out is not opt-in at all — unless what it
gates is work rather than code: `gemBounces` lets a stone's paths run
past the ordinary six, which costs a fifth more a sample on a ring with
a stone and nothing on a scene without one, and is six unless asked.
A test hashes the shaders a default build compiles, so a permutation
that leaks a line into them is caught.

## Checking it

    npm test          1,042 tests, node
    npm run test:gpu  147 tests, headless Chrome with a real device
    npm run perf:gpu  the game path's frame, held to a baseline for this GPU
    npm run typecheck

The GPU suite runs in the machine's own Chrome through Vitest's browser
mode; nothing is downloaded. `VITE_FRAME_DIR=/some/dir npm run test:gpu`
writes the frames those tests draw out as PNGs, for looking at.

A rendering change is held to the tracer or to a known answer before it
is kept — the furnace test, and the raster-versus-traced comparisons,
exist for that. Where the two disagree, the tracer is the reference.

## Licence

MIT — see [LICENSE](LICENSE).
