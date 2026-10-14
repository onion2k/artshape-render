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
- **A toy's faceted scenery, for a game to colour** — `broadleaf`,
  `conifer`, `farTree`, `bush`, `fern` and `boulder` in `parts/lowpoly.ts`,
  cut with flat faces from the helpers in `mesh/lowpoly.ts` (`at`, `face`,
  `tri`, `frustum`, `lump`, and the solids a building is cut from: `prism`, `block`,
  `slab`, `rod`, `dome`, `disc`, `annulus` and `tubeIn`). Cheap (a broadleaf is 204 triangles, a far tree
  10 or 16), seeded, standing on the ground at the origin with a tree's top
  at its height, and made of named meshes with no colour: the game colours
  `trunk`, `leaves` and `crown` itself.
- **A painted edge for that scenery, from 0.38.0** — a few chosen ridges of a
  faceted rock or wall carry a crisp stroke of pale paint, loaded at its head
  and dry at its tail, from `painted` in `mesh/paint.ts` and `Look.paint`; a
  game that asks for none of it draws what it did.
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
    src/mesh/       the four generators, deformation, wear, engraving, rounded edges
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
- **A surface that flows is a pattern too, in a build of its own.** Kinds 5
  (ripple), 6 (crust), 7 (drift) and 8 (water, from 0.27.0) are written with
  `packFlow` (`flow.ts`): kind, scale, speed, glow, then the second colour. The pattern travels along
  the mesh's own +x by `renderer.time * speed`, so the game's clock moves it
  and a paused game, or a test that sets the same time twice, draws the same
  frame; nothing reads a wall clock. Scale and speed are in the mesh's own
  units, and scale is how many of the pattern's cells fit in one of them: one
  suits a strip a few units across, so a mesh in millimetres wants about a
  thousandth and one in tenths of a metre about a tenth, and speed is
  the mesh's own length a second. The pattern is drawn from where on the
  mesh a fragment is, so lay the surface in the mesh's x and y, x the way it
  flows, with its normal along z. Ripple turns the surface normal by its
  height field's slope so the lights and the sky glint on it; crust is dark
  plates over cracks; drift is scratches fixed to the mesh with flecks and a
  few glints moving along it. A flow kind's glow is light the surface gives out
  itself, the second colour times the glow times the kind's own field (the
  crests, the cracks, the flecks), added whatever light falls on it, so lava
  shows in a pitch-black cave; nought, the default, adds nothing. **Water**
  (`FLOW_WATER`, kind 8, after three.js's water example) is the exception to
  most of that: twelve sine waves laid in the world's x and y, not the mesh's,
  so ponds of any shape are one sea, each travelling its own way at its own
  pace by the game's clock, turn the normal, and the surface is a deep body
  colour mixed with the environment's sky mirrored in the waves by a Fresnel
  term, with a glint that is the camera's own (a lobe of the mirror direction
  straight ahead along the view, a little higher than a flat sheet's, so a
  wave tipped toward the eye lights and flat water does not, whichever way the
  camera is turned). Its floats: `scale` is how many cells of the biggest wave
  fit in a world unit (about 0.4 for a pond a few tens of units across), `speed`
  how fast the waves go, `glow` how steeply they tilt the normal (0.3 is a
  lively sea, nought a flat mirror: it gives out no light), and `second` the
  tint of the mirrored sky; the first colour is the body. No scene is
  reflected, only the environment's sky, and there is no occlusion on it. It
  costs a frame about what the ripple does (0.63 ms against 0.65 on the
  standard scene with one strip of each, thirty units by eight; see the
  `standard ripple` and `standard water` rows of `perf:gpu`). The build
  that draws them is compiled the first time `setStatic` or `setDynamic` is
  handed a group with one, in every rung of the economy and, if asked for,
  every antialiasing mode, and `prepare()` says when it is in; until then the
  group is drawn through the patterned build, as the still speckle of kind 4
  with no glow. A game that has no such group compiles nothing and draws as it
  did. A kept static half (`'keep'`) redraws a flowing static group each frame
  and keeps the rest, so it costs what that group costs and no more. Edges,
  foam and banks are the game's to draw as geometry of its own.
- **Clear water, from 0.29.0, is seen through.** A placement of kind 9
  (`FLOW_CLEAR`) is open water's twelve waves on a surface drawn in a pass of
  its own after the opaque scene, at one sample a pixel: the scene's depth is
  made readable (at four samples, the nearest of them, into the frame's own
  depth), the frame is copied, and the water reads what is under it from the
  copy. What is below is lost to the deep colour (`second`) with the depth of
  water the eye looks through, a channel at a time, so the shallows turn teal
  of themselves and the deep is the deep colour at its richest; it is bent by
  the waves the more the deeper it lies, but never where the bend would land
  on something out of the water; there is foam where the water stands thin,
  a crisp white line with an edge of `foamEdge`, broken by a drifting noise;
  sun glitter in sharp dashes; soft caustics on what is under the shallows,
  where the sun's map says the sun reaches; and the sky mirrored only where
  the surface is seen edge-on. How much of each is `look.clear` (`clear.ts`),
  one record for the frame, packed into a uniform, so a game changes it each
  frame for nothing: a lake that clears as it is cured is that record and
  not its groups handed over again. Its lengths are the world's own, and its
  defaults, in millimetres, are the sheet chosen from on 10 October 2026: half
  the light gone by 160 mm, a bend of up to 100 mm, foam where it is 30 mm deep
  or less, caustic cells 150 mm across. A clear group is all clear water (one
  with any other kind in it is refused); it casts no shadow, darkens no
  corner by occlusion, and is not in the kept half. With one in the frame the
  particles and the effect layers are drawn after it, against the depth with
  the water in it, and the fog marches over that depth at one sample whatever
  the antialiasing, so a splash above the water is over it and the haze stops
  at its surface. Its builds are compiled the first time a clear group is
  handed in, and `prepare()` waits; a game with none compiles and draws
  nothing new. It costs 0.70 ms on the standard scene against open water's
  0.64, and 0.74 against 0.66 at four samples (`standard clear`).
- **A glow, from 0.29.0,** is kind 10 (`FLOW_GLOW`): a placement that gives
  out `second` times `glow` over its own lit colour, everywhere on it and
  still, through the flowing build. A fish that glows under clear water is
  one, seen through the water and tinted by it.
- **Clear water's finish, from 0.30.0, is asked for in `look.clear`,** and a
  water that asks for none of it draws as 0.29.0's did, to the pixel:
  - `waves`, up to four Gerstner swells (`waves.ts`: a direction, a length, an
    amplitude and a steepness, going at the speed deep water gives their
    length), move the surface itself and turn its normal. `heightAt(waves, x,
    y, t, gravity)` gives the height the surface is drawn at, so what a game
    floats rides the very water drawn; gravity is `GRAVITY_MM / mmPerUnit`.
  - `near` and `nearDistance`: a colour the water lightens toward by the
    camera, with the sky's reflection eased off there. `crest` and
    `crestAmount`: a colour the swells' tops lighten toward.
  - `mirrorTint`, `mirrorNear` and `mirror` (from 0.32.0), for the sky in
    the water: the reflected sky is multiplied by a colour of its own, so a
    painted lake's highlights are not the sky's pale blue (null for none);
    the camera keeps that share of the mirror, from nought to one, where a
    near colour would ease it away, so the ripples at a player's feet still
    catch the sky (nought, the default, eases it to nothing as before); and
    the mirror's strength is multiplied by `mirror`, nought for none and one
    for as before. A water that asks for none of them draws as 0.31.0's did,
    to the pixel.
  - `ripple`, `rippleAmount` and `rippleCut` (from 0.33.0), for a painted
    lake's ripples in a colour of their own, whatever the sky: the body
    lightens toward `ripple` on the fine waves' slopes (null for none), by
    `rippleAmount` at a full slope (nought to one, half by default) and
    only above `rippleCut`, the share of a full slope below which nothing
    lightens (three tenths by default), so only the crests' sides catch it.
    A full slope is 0.6 of the fine waves' own, whatever the steepness. A
    water that asks for none draws as 0.32.0's did, to the pixel.
  - `foamSoft` and `foamEverywhere` (from 0.34.0), for a bold ink-line of foam round
    everything that stands in the water: `foamSoft` is how soft the line's edge
    is as a share of its width (six hundredths by default, lower is crisper,
    never under three quarters of a pixel), and `foamEverywhere` draws the
    depth band at its full width inside the shore field too, so a bobber, a
    boat or a rock near the surface has a ring where the water is thin over
    it, as the shore has, and the field's own lines are left as they were. A
    thing wholly under the water but nearer the surface than `foamWidth` rings
    too, so a game sets that small. A water that asks for neither draws as
    0.33.0's did, to the pixel.
  - `mirrorScene`, `mirrorPlane` and `mirrorDistort` (from 0.39.0), for the water
    to mirror the scene itself and not only the sky: a bank, a rock, a jetty or
    a cabin standing in it shows in the pixels beneath it. With `mirrorScene`
    true the opaque groups are drawn once more before the scene pass, with the
    view turned over in the plane at `mirrorPlane` (the height of the water's
    surface, in world units, nought by default) and everything under that plane
    clipped away, into a frame of half the size, in half floats, with a depth of
    its own and an alpha of nought where nothing was drawn. The clear pass reads
    that frame in place of the sky where something was drawn, the sky where
    nothing was, and the two mixed by its alpha at an edge, which is a soft one,
    since the frame is premultiplied and read filtered. `mirrorTint` and
    `mirror` apply to both, so a sick lake's reflection is as green as its sky
    is. `mirrorDistort`, a share of the screen for a normal tilted all the way
    over (three hundredths by default), shifts where the frame is read by the
    swells' own normal along the screen's axes, and not the fine waves', which
    fade out with the distance at which the mirror shows things; it lies the
    reflection still at nought, and does nothing with no `waves`. The shadow
    maps, the grass, the particles, the sky and the water itself are not drawn
    into it, and the camera's occlusion is not read by it; the sun's maps are
    read as they stand. It is a build of the scene shader of its own (a
    `MIRRORED` constant and a clip, in no other build), made for each kind of
    group the frame has and each rung of shadows and points it is drawn on, when
    first asked for, and `prepare()` waits. The frame and its depth are made
    when the first frame needs them and again on a resize, and let go when the
    option is turned off. `mirrorScene` false, the default, runs no pass and
    makes no texture, and the water draws as 0.38.0's did, to the pixel
    (`cleargolden.gpu.test.ts`). It costs about 0.03 ms over `standard clear`
    on the standard scene (`standard clear mirror`); what it costs is the
    scenery it draws again, so a lake with a wood round it costs more.
  - `clearKnee` and `causticLine` (from 0.40.0), for a pale bed seen bright
    through thin water and sharp lines of light on it. `clearKnee` is a depth
    of path through the water, in world units, in which nothing is lost to the
    deep colour: the light is taken over the path less the knee, so what lies
    under thinner water than that is seen in its own colour, and the deep is
    reached as before only a knee further down. The caustics fade by the same
    knee. Nought, the default, loses light from the surface down as before.
    Over a dark bed it lets more of the dark through, so the shallows darken;
    it is the option for a pale one. `causticLine` is the width of a caustic
    line as a share of a cell (0.16 by default, the line as it was): narrower
    is crisper, covers less of the bed, and so wants `caustics` raised to be
    seen (the sheets of October 2026 chose 0.08 at about three times the
    strength); much under that it breaks into dashes far off, since it does not
    widen with the pixel. Both ride in the foam's uniform, which did not grow,
    and a water that names neither draws as 0.39.0's did, to the pixel
    (`cleargolden.gpu.test.ts`). What they cost a frame is measured by
    `standard clear shallows`.
  - `sparkles`, `sparkleCut`, `sparkleBright` and `sparkleSize`: round soft
    stars where the fine waves catch the glint ahead of the camera, as the
    glitter does, brighter than one so the bloom haloes them, a radius in
    pixels on the screen, and fewer into the distance. A game asking for
    them will want `glitter` at nought.
  - `setShoreField({ size, distances, min, max })` hands over how far each
    point of the water is from the nearest shore or anything standing in it
    (`shore.ts`), made once by the game. With it the foam is a line
    `foamWidth` wide round every shore whatever its slope, a rim of
    `foamEdge`, and a second line `foamWidth2` wide `foamGap` beyond, broken by
    a drifting noise; the foam the depth gives is kept, thin, for what the
    field does not know. Without one, or outside it, the foam is the depth's
    band as before. A field is checked as anything from outside is, and
    replaced or taken away (`null`) whenever the game likes.
  - All of it together costs nothing measurable over the same water without
    it: 0.73 ms on the standard scene against 0.74 (`standard clear finish`
    against `standard clear sheet`, three quiet runs alike), and the four
    swells alone 0.71.
- **Ground can wear an image, in a build of its own.** `setGroundTexture(layers)`
  takes up to eight `ImageBitmap`s, all square, all the same size, a power of
  two and at most 1024 across (anything else is refused by name, and the
  texture it had is kept), makes mips for each, and binds them to the scene as
  one `texture_2d_array` with a repeating, trilinear, 16-times anisotropic
  sampler of its own at bindings 10 and 11. `null` takes it away. Make each
  bitmap with `createImageBitmap(source, { premultiplyAlpha: 'none',
  colorSpaceConversion: 'none' })`, or its alpha will have been folded into
  its colour: the colour is a modulation about mid-grey and the alpha a
  height about mid-grey, both data, and neither is read as sRGB light. A
  group opts in with `texture`, four floats a placement (`TEXTURE_STRIDE`,
  written with `packTexture`): the layer, counted from one (nought is none,
  and a layer past the last wears the last), how many times the layer tiles
  across a unit of the world, the albedo strength and the shade strength,
  each 0 to 1. The layer is sampled by the world's x and y and not the mesh's,
  so ground that abuts is one field with no seam between its kinds, and a
  placement moved on by a tile draws the same. The colour multiplies the
  albedo by `mix(1, rgb * 2, albedo strength)` after any pattern mix, so the
  game's palette stays the game's; the alpha multiplies the sun's light by
  `mix(1, alpha * 2, shade strength)` before the toon ramp cuts it, so a
  band's edge and the ramp pick the grain up instead of flattening it (the
  physically based look takes it on the same term). Both fade to nothing as
  the texels shrink below a pixel (from four texels a pixel to sixty-four, by
  octave), so far ground settles to its flat colour and not to a grey mip.
  Strength nought and layer nought are the flat placement to the bit. A
  textured group may also have `patterns` and keeps its speckle; it may not
  have a flow kind among them. The build that draws it is compiled the first
  time `setStatic` or `setDynamic` is handed a group with a layer named, in every
  rung and, if asked for, every antialiasing mode, and `prepare()` says when it
  is in; until then the group is drawn without its texture, and a kept static
  half is baked again when it lands. Setting a texture compiles one pipeline,
  the mips', and nothing else: a game that never sets one, or sets one and
  puts it on no group, compiles the same 46 as before. Until a texture is set
  the scene binds one neutral grey texel, which modulates nothing.
- **Cards are flat meshes cut out by an image, in builds of their own.** A card
  is a leaf, a flower or a blade of weed: a flat piece of mesh whose
  fragments are thrown away where a mask is clear, so a tree is a few
  hundred squares and not a few hundred thousand triangles.
  `setCardImages(layers)` takes up to eight `ImageBitmap`s, all square, all the
  same size, a power of two and at most 1024 across (anything else, and an
  empty list, is refused by name, and the images it had are kept); `null` takes
  them away, and the scene then binds one opaque white texel, which cuts
  nothing. Only the alpha is read, so make each with `createImageBitmap(source,
  { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })`. A group opts in
  with `card: { layer, cut }`: the layer counted from one, the cut 0 to 1 and
  0.5 if left out. The mesh needs two uvs a vertex (a group with a card and
  none is refused), and the sampler repeats, so a uv past one tiles the mask.
  The colour is the group's own, in colour and not in the image, so the
  palette stays the game's; the back of a card is lit as its front is. A card
  may have patterns, but no flow kind and no ground `texture`. Its shadow from
  the sun and from a spot, and the contact occlusion it casts, are of what is
  left after the cut, through two depth builds made with the carded ones, so a
  leaf casts a leaf and not a square, and the economy's rungs for shadows and
  occlusion switch them as they do any group's. The mips are made on the CPU
  (`cardLevels` in `cards.ts`), each level's alpha scaled so that the share of
  texels over the cut is the full-size mask's share: a plain average of a
  sparse leaf drops under the cut and the tree goes bald at a distance. At four
  samples a pixel the carded builds turn the cut into alpha to coverage, the
  alpha sharpened about the cut by its screen derivative, and read the one
  nearest mip level, so an edge is partial coverage and not a step. What that
  holds, measured against the share at full size and not promised beyond: at one
  sample, a sparse leaflet mask holds to 10% down to 0.434 of its size across
  and the kit's five masks to 0.317; at four, the worst is 5.7% down to 0.317.
  Smaller than that the leaves thin. The builds (sixteen, and sixteen more at four
  samples, with the two depth builds) are compiled the first time a card group
  is handed in, `prepare()` says when they are in, and until then the group is
  drawn as an uncut square, and a kept static half is baked again when they
  land. A game that asks for no cards compiles the same 46 pipelines and draws
  exactly what v0.30.0 did, plain, at four samples and kept, held to its pixel
  hashes (`cards-golden.json`, written on the old code). The cost, in
  `perf:gpu`: four hundred bushes of four thousand triangles each over the
  standard scene (1.6 million triangles, a leaf mask on every one) are
  5.24 ms a frame (`standard cards`) and 6.12 ms at four samples (`standard
  cards msaa`) against 0.60 for the scene alone, so a card is paid for by its
  triangles and its overdraw like any mesh, and a tree is worth making of few.
- **A group can leave the shadow maps and the occlusion out.** Every group is
  drawn up to three times a frame: into the sun's shadow map and each spot's
  (`shadow`), into the occlusion's depth prepass (`occlusion`), and in
  colour. Both flags default to true, the old draw to the pixel. `shadow:
  false` leaves the group out of every map, so it casts none and costs nothing
  there; `occlusion: false` leaves it out of the prepass, so it darkens no
  crease and is not seen by the occlusion. Use them for scenery too far from
  the camera for either to be seen, such as the outer band of a wood, where
  each hundred trees of cards is a large share of the frame. The group is
  still drawn in colour (kept or redrawn), receives shadow and occlusion as
  ever, and is still in the depth that clear water reads, so the water is
  seen through to it. The saving, in `perf:gpu`: the four hundred bushes of
  `standard cards` with both off (`standard cards far`) are 3.95 ms a frame
  against 5.4, a quarter of the frame for nothing the camera could see.
- **A painted edge, from 0.38.0, is carried by the mesh and drawn in a build of its own.**
  A few chosen ridges of a faceted thing (a boulder, a cliff's slabs, a wall)
  carry a crisp stroke of a pale paint colour, with a loaded head and a dry
  tail, as a hand would lay it with a flat brush. Its width is a share of the
  facet, so a boulder's stroke is bolder than a pebble's, it is kept off the
  undersides, it fades where ridges crowd a vertex and as the thing shrinks on
  screen, and the colour is mixed into the albedo before the light, so the
  toon ramp cuts it and it never reads as gloss. It is toon only: a physically
  based look draws a painted group plain.

      import { painted, split } from 'artshape-render/mesh/paint';
      const rock = boulder(1, { seed, rings: 5, segments: 8 }).parts[0].mesh;
      const mesh = painted(split(rock), { choice: 'ridge', ridge: { budget: 3, spacing: 0.4 } });
      renderer.setStatic([{ mesh, matrices, albedo: [0.13, 0.12, 0.11], roughness: 0.9 }]);
      renderer.look = { ...renderer.look, paint: [{ lightColour: [0.62, 0.55, 0.42] }] };

  The mesh has to be `split` first (every triangle its own three vertices, so
  nothing is welded and the lighting normal stays the facet's), and `painted`
  throws on one that shares an index. `choice` says which ridges carry the
  stroke: `'gate'` every edge that folds past the gate, `'agree'` an edge both
  its faces pick as their best (a few long bold strokes), `'ridge'` chains of
  edges scored and the best `budget` of them taken, a share `spacing` of the
  mesh's radius apart. The budget is a count and the game sizes it, a pebble
  one and a boulder three; a pile is painted as separate lumps, each its own
  budget. `quiet: true` leaves a mesh unpainted by the same build (a ground
  beside the rocks), and `set` (0 to 3) says which of the look's sets it
  reads. What the mesh carries is `PAINT_STRIDE` (20) floats a vertex, in
  five `float32x4` of their own, bound only for a group that has them: the
  three edges' signed folds, the heights to them, the face's id and height
  range, each edge's share of up and each corner's crowd, the chosen bits and
  the place along the chosen ridgeline. The file's header holds the table, and
  a test holds the table to `PAINT_LAYOUT`. A group with paint may not have a
  texture, a card or a flow kind, which use the same attribute locations and
  varyings.

  `look.paint` is up to four `PaintSet`s, each knob optional and a knob left
  out `PAINT_DEFAULT`'s (the settled recipe for rock), packed into a uniform
  of its own at group 1 when it changes, so a game may tune it each frame and
  nothing recompiles. `src/game/paint.ts` lists every knob with what it does.
  The ones a game touches first are `lightColour` (the stroke's colour, an
  absolute pale tone of the rock's own hue), `light` (its strength), `widthFacet`
  (the width as a share of the facet, with `width` its floor), `gate` (the fold
  an edge must pass), `ridgeUp` (how far up an edge must face to carry
  paint) and, in the mesh pass, the budget. The sums (the band, the strength,
  the fades, the mark) are written once in TypeScript and once as WGSL from the
  same constants, and a GPU test holds the shader to them within two levels.

  The cost, in `perf:gpu` on an M4 Pro: the standard scene's four hundred
  boxes painted by the gate's choice are 0.73 ms against 0.62 (`standard
  painted`, +0.11 ms); two hundred boulders on the ridge choice are 0.91 ms
  against 0.67 unpainted (`shore` and `shore painted`, +0.24 ms). Bundled and
  minified, the renderer grows by 4.1 kB gzipped (63,004 to 67,116 bytes) and
  `mesh/paint.ts` is 3.3 kB of that, which a game that never imports it does
  not ship. The sixteen builds (toon, patterned and not, every rung) are
  compiled only when `setStatic` or `setDynamic` is first handed a group that
  has paint, and again at four samples if asked for, `prepare()` says when
  they are in, until then the group is drawn plain, and a kept static half is
  baked again when they land. A game that asks for none of it compiles nothing
  more, makes no buffer or layout, and draws the frames of v0.37.0 to the bit,
  held by `painted-unasked.gpu.test.ts` against hashes written on the old code.
- **Toon is a look, and a tone.** `look.shading = 'toon'` draws every
  group through a permutation that lights a surface at its own colour, in
  one smooth ramp from a shade to the full sun, and tints the sky's light by
  it, where the physically based shading takes a quarter of the colour and
  adds the sky's light grey over it; and `post.tone = 'clamp'` shows the
  frame straight, held at white, where the filmic curve holds a bright
  colour short of white and pulls it toward grey, or `'soft'` shows it
  straight with a shoulder that keeps a bright colour's hue. Together they
  are a bright, saturated world, finished as a toy is (see below). Left out,
  shading and tone are what they always were, to the pixel.
- **Particles can be blown, and can change colour.** `emit` takes a burst
  of them, born and aged on the GPU. `setWash(washes)` hands the renderer up
  to four sources of air (`Wash`: a position, a radius, a speed and a reach, in
  world units) that push what is under them, straight down at the source and
  turning outward as the air nears the end of its reach, weaker across and down
  the column, and nothing above it or past it. Smoke follows the air closely
  and a drop, which falls, hardly at all; the field is `washVelocity` in
  `wash.ts`, which the shader is held equal to. It is kept until set again, and
  `[]` is none. An `Emit`'s `fade` is a second colour its particles move to
  over their life, by a smooth-step on their age: dark smoke at the fire that
  pales as it rises. `setWind([x, y, z])` is the air's own velocity
  everywhere, world units a second, kept until set again: the drag pulls a
  particle's velocity toward the wind plus the wash's air where it is, not
  toward nothing, as closely as `washFollow` says for its gravity, so smoke
  rides the wind and falling drops hardly feel it (`airVelocity` in `wash.ts`
  is the sum, which the shader is held equal to). A wind set between frames
  blows from the next, and sprites, which the game places, are not moved by it.
  A game that sets none of these draws every particle as it did, to the pixel.
- **Sprites are particles the game places.** `setSprites(data, count)`,
  eight floats each (`SPRITE_STRIDE`: position and size, colour and alpha),
  draws soft camera-facing puffs where the game says, every frame, with the
  particles' blending and under their rung of the ladder. For what has to
  follow the game's own clock — smoke in a game that steps its own time —
  where a particle is born and aged on the GPU and moves only when a frame is
  drawn.
- **Particles and sprites can be fogged by their own distance.** The fog is
  marched to the depth the scene wrote, and a particle writes none, so smoke in
  front of open sky is fogged as if it stood at the fog's `reach`, and a hazy
  world hazes a column of it away. `particleFog = 'own'` (default `'behind'`,
  which is exactly what was drawn before, to the pixel) draws them after the
  fog is laid on the scene and before the bloom, each fogged by its own
  distance in closed form: the optical depth of the exponential layer along the
  ray (`opticalDepth`, `fogAhead` in `fog.ts`, which the WGSL is held equal to),
  its transmittance on the colour and its in-scatter over it. That leaves out
  what the march reads from maps, the sun's shadows and the spot cones, and the
  taper over the last third of the reach, so smoke near the reach is a little
  hazier (6% at 1,100 of 1,200) than a surface. Sprites are fogged for every
  fragment; particles at the corners of their quad. They are still tested
  against the scene's depth, with four samples a pixel too. With no fog, or its
  rung off, nothing changes. The builds are compiled when first asked for;
  `prepare` waits for them.

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

**A sky, and a sun whose shadow follows the view (from 0.28.0).** Each is asked for, and a game that asks for none of
them draws the frame it drew at 0.27.1 to the pixel (held by `unasked.gpu.test.ts`):

- `look.sky = { zenith, horizon, height?, below? }` draws a gradient past everything, by how high each pixel's ray
  looks: the horizon colour at the level, the zenith from `height` up (the sine of the elevation, half by default), and
  `below` under the level. It is compiled when first asked for (`prepare` waits), drawn first in the scene pass and in a
  kept frame's static half, and replaces the flat `background` wherever it shows. `skyColour` in `sky.ts` is the sum.
- `setSunShadow(box, { reach, fade? })` fits the sun's map to the view and not the whole box: a square `reach` across,
  over the ground from a tenth of it behind the camera to nine tenths ahead, moved across the light's plane by whole
  texels so a still edge does not swim. Its depth spans the whole box, so every caster still casts, and its shadows fade
  out to the lit over the outer `fade` of the square (a tenth by default), so none is seen to stop. A long course's
  shadows are then as sharp as a short one's.
- `look.shadowSoftness` (texels, up to three) reads the sun's shadow over nine taps that far apart, for a soft edge.
- `look.waterShadow` lets open water take the sun's shadow: its lit body and glint, and the whole of it darkened as the
  ground beside it is, so a shadow across a bank is one shadow.

Together they cost the standard scene with a strip of open water 0.06 ms (`standard sky fit` against `standard water`
in `perf:gpu`).

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
| a textured ground (0.26.0): the 600-unit ground wearing a 256-square layer, colour and shade at 0.5 | +0.18 ms (0.62 to 0.80, four runs of the perf gate, a machine at load 4.5) | not measured |

Each of the toon light's settings alone read under 0.01 ms on the standard
scene, which is to say no cost could be told from the noise. Alternating
v0.19.0 and this release five times each, a look asking for none of it read
0.73 and 0.72 ms on the standard scene, and within 3% either way on the golf
scenes. Four samples take 49 MB of colour and depth at that
size, and as much again for a kept frame once `keep` is drawn with them;
FXAA takes 4 MB.

**A toon look is a toy's finish unless it says otherwise.** Four settings,
each on in any toon look that does not set it to nought, and each a few
instructions a pixel, in the manner of the Switch's own toys (Mario Kart 8,
Odyssey): `gloss`, a clean highlight where the sun glances off a smooth
surface, sized by its roughness, soft at its edge and white at its middle,
widened where the surface turns too fast across a pixel to hold it so a
small ball does not sparkle, and none from a roughness of 0.8, so grass and
lawns are matte; `sheen`, the sky in a clear coat where a smooth surface
turns from the eye; `smoothShading`, the bands melted into one ramp that
lights flat ground facing up and every shadow exactly as the bands did and
shades everything between by the sun it takes, falling away from flat
ground as steeply as `form` asks; and `occlusionTint`, the occlusion
darkening toward the shade colour rather than grey, where there is a shade
colour and some occlusion. `gloss` and `sheen` go to 2; nought of each is
toon as it was, the bands and the small hard glint. Grass is drawn matte
whatever its roughness: no highlight, no sheen and no tint in a crease,
since a blade is drawn by the million and the three, compiled into it,
cost ooergolf's rough a quarter of a millisecond for a tint on the blades
at a rail's foot that could scarcely be seen.

```ts
game.look = { ...game.look, shading: 'toon' };                        // the finish, all of it
game.look = { ...game.look, shading: 'toon', gloss: 1.5, sheen: 0 };   // glossier, and no coat
game.post = { ...game.post, tone: 'soft' };                            // bright plastic keeps its hue
```

A toon look that says nought of all four draws the frame v0.21.0 drew, to
the bit; the finish adds no pipeline, and a physically based look takes none
of it. `post.tone = 'soft'` is asked for, not given: under its knee a colour
is shown as the clamp shows it, and past it the brightest channel eases
toward one with the others keeping their share, so a lit orange stays orange
where the clamp turns it yellow, and what is largely white light (a
highlight, a lit cream) goes to white. `toon.ts` holds the ramp and the
tone as sums, and a GPU test holds the shader to them. On an M4 Pro at
1280x800, alternated with v0.21.0 in four rounds on a GPU an image generator
was also using, the finished tree read +0.025 ms on the standard scene,
+0.04 with the toon light, and +0.015 to +0.07 on the golf scenes (paired
medians). Turned off in the same tree, interleaved with itself on in eleven
rounds, the finish's own work could not be told from the noise (+0.02 and
-0.07 ms on the standard scene, +0.01 and -0.01 on the golf field): what it
costs is its code being in the toon build at all, which a toon look pays
whether or not it turns the finish off, and a physically based build does
not have.

**Rounded edges are the mesh's.** A toy's edges are moulded, and a moulded
edge carries a line of highlight that turns as the thing turns; a square one
catches none. `roundedBox(size, radius)` in `mesh/rounded.ts` is a box
rounded at every edge and corner, flat on its faces and smooth over every
round, and `roundCorners(profile, radius)` rounds the corners of a profile
for `revolve` to turn, a sweep to carry or `extrude` to lift, each arc
tangent to its sides and never wider than half the shorter. Rounding by
bending normals near edges on screen was tried first and left dashes where a
face was a few pixels tall; in the geometry it is exact at any distance, its
outline is round too, and it costs triangles rather than a pass.

```ts
import { roundCorners, roundedBox } from 'artshape-render/mesh/rounded';
import { revolve } from 'artshape-render/mesh/revolve';

const block = roundedBox([1.4, 0.7, 0.9], 0.08);
const puck = revolve(roundCorners({ points: [[0, 0], [1, 0], [1, 0.5], [0, 0.5]] }, 0.12), { segments: 48 });
```

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

    npm test          1,071 tests, node
    npm run test:gpu  164 tests, headless Chrome with a real device
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
