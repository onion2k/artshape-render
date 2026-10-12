# The painted low-poly look: what the experiments found

Eight experiments, 12 October 2026, on the worktree `artshape-render-painted`
(branch `painted-experiments` from v0.37.0, nothing committed). The plan
they followed is `~/.claude/plans/painted-edges-experiments.md`, which also
holds each result in full. The aim was to learn whether the game path can
draw hand-painted-looking low-poly scenery (light edges along a rock's
corners, dark creases, painted faces) from the package's own generated
solids, with no models and no textures. Every figure here is from one
machine, `apple/metal-3` in headless Chrome.

## Recommendation

**Build it, by the route E3b found, and not the one first planned.** The
mechanism works and is cheap: an edge band that is even along its length,
a set width, correctly convex or concave per edge, and free of the quads'
diagonals, from twelve floats a vertex that a mesh pass writes once. The
layers over it (a broad soft falloff from the strong edges, a gradient
within each face, a per-face hue and value wobble) turn a boulder from a
shaded polyhedron into something that reads as painted. The look costs
0.15 ms a frame without cracks and about 4 kB gzipped, against a game
budget of 8 ms and 400 kB. What is not yet right is taste, not mechanism,
and is listed under *what the real version must do differently*.

## What was learned, in order

1. **Welding (E1).** The split solids weld into shared vertices at any
   tolerance (matching points agree exactly). Averaging normals equally per
   face-vertex is wrong, because caps are fanned and quads split: a block's
   corners came out at 35° and 66°. Angle weighting gives 54.74° at every
   corner, exact. Only angle weighting is to be used.

2. **Derivative normals (E2).** The flat normal from
   `cross(dpdy(world), dpdx(world))` lights a split mesh bit for bit as its
   vertex normals do, at one sample and four, at every yaw. On a mesh with
   shared vertices it is wrong in 2 px dashes along every internal edge, on
   this GPU. **So meshes stay split**, which is how the solids are built.

3. **The smooth-normal gap is not an edge (E3).** `1 - dot(nSmooth, nFlat)`
   is nought at one point near a face's centre and grows to the border, so a
   threshold takes a fixed fraction of every face (91% of a block's pixels
   over 0.05), scales with face size, is 1.47 times stronger at a corner,
   and its sign fails on any face strung between a convex and a concave
   edge. Dropped.

4. **The edge carried in the mesh works (E3b).** Per triangle: three signed
   fold angles (from the neighbouring triangle found by matching positions;
   nought for a coplanar neighbour, so diagonals and cap fans never show),
   the corner index, three heights, and the z extent. Per fragment the
   distance to each edge is barycentric times height. Band of 6 px at every
   height along a block's edge; halves with distance in world units or holds
   in pixels; 0 concave pixels on convex solids; the hole slab's floor join
   all concave and its lip all convex.

5. **The light edge (E4).** A gate on the fold's angle does most of the work:
   at 0.35 rad the boulder is still a wire cage, at 0.6 to 0.7 only the
   strong ridges carry a lip. The found settings (`combo=worn`): width 0.6,
   pixel floor 0.75, gate 0.6, ramp 0.4, sun 0.3, up 0.8, broken 0.6 at
   scale 8, light 0.9, dark 0.8.

6. **The painted face (E5).** `falloff` (a wide soft band, width 3 to 4
   units on a boulder 40 across) and `wobble` (0.1 to 0.12) do the most;
   `grade` helps (0.3 to 0.5); a full Voronoi crack network reads as crazy
   paving; `fade` by a facet's size on screen stops far rocks being cages.
   The found settings (`own=painted`) over the worn lip: falloff 0.6 at
   width 4, grade 0.5, wobble 0.12, cracks 0.35, fade 3 px.

7. **Foliage (E6).** A wrap term from the smooth normal does little under
   the toon look, because the sky carries most of the light and the
   terminator is weak to start with; at full wrap a canopy is a smooth
   plastic blob. On foliage the grade and wobble help, the lip and cracks
   hurt. The real tree work is a stronger key or less sky on foliage, and
   some break-up within a canopy.

8. **The hard crease (E8).** The trunk and the canopy's lumps are separate
   meshes, so no join is smoothed across. The fault is the conifer's tier
   rim, where the cone's underside is averaged into its side; a `maxAngle`
   of 1.2 rad on `smoothed` mends it and costs the broadleaf nothing seen;
   0.8 rad puts the facets back.

9. **Cost (E7).** Against `off` at 0.640 ms on the standard scene: the
   derivative normal alone +0.003; the attribute and band with no layer
   +0.100; the full rock look +0.740, of which the cracks are +0.593; the
   look without cracks +0.147. The same on 200 boulders. Download: the
   renderer bundled and minified grows 3.7 kB gzipped; the mesh passes 2.4
   kB, tree-shaken if not imported. Pipelines before `ready` unchanged at 32.

## What the real version must do differently

- **Faces, not triangles.** The grade and wobble are per triangle, so a
  quad's two halves step along the diagonal. The mesh pass should merge
  coplanar neighbours into a face id and a face extent before writing.
- **Cracks are few, broken and tapered,** or left out. The Voronoi network
  is both the dearest layer and the one that reads worst.
- **Darkening toward the base of the thing as a whole,** in object space,
  since the per-face grade cannot do it; and the look's shade colour and
  contrast are what make a rock read as stone, not the paint alone (a lit
  face at 160/255 under a sun of 1.3 left room for a lip; at 2 it did not).
- **Paint what asks for it.** The cost follows painted pixels, so a group
  opts in and the ground does not.
- **A pixel floor and a fade together,** so a far rock keeps two or three
  strokes on its ridges and never a cage.
- **The sun's shadow map is read only where the flat `ndl > 0`,** so a
  wrapped face is never shadowed by something else; a wrap in a scene needs
  the shadow read moved.
- **`fwidth` is replaced by `length(vec2(dpdx, dpdy))`** for the pixel
  footprint, or a diagonal edge's band is 1.4 times wider.

## A sketch of the real version

- **Mesh:** `mesh/paint.ts` with `painted(mesh)` (the twelve floats, after
  merging coplanar faces) and `split(mesh)`; `smoothed(mesh, { maxAngle })`
  for foliage. The weld stays unused by the look. Node tests hold the
  block's angles exactly, the hole slab's signs, the face merge, and the
  stride against the layout.
- **Renderer:** a `paint` field on `Mesh`, bound only for a group whose
  mesh has one, on the plain and patterned builds (the flowing, textured
  and carded builds use VsOut 7 and 8; the paint needs 7 to 10).
- **Look:** `look.paint` as a record of the knobs with defaults that draw
  today's frame to the bit when absent, packed into the frame uniform (not
  compiled in, as the lab did) so a game tunes it live and nothing recompiles.
  The edge sums written once in TypeScript and once as WGSL from the same
  constants, as `toon.ts` does.
- **Tests:** a GPU test per layer against the same look with that layer at
  nought, as `toy.gpu.test.ts` does; a golden frame proving the ordinary
  build unchanged; `standard painted` rows in `perf:gpu`.
- **ooerfish's side:** the boulders and trees through `painted`, the ground
  left alone, the knobs in `look.ts` beside `TOY`, a look picture.

## Where the evidence is

- `frames/sheets/KEY.md` says what every sheet's columns are; the sheets
  worth opening first are `e5 three-boulders--own.png`,
  `e5 lump-medium--own--zoom.png`, `e4 boulder-seed-11-...--gate--zoom.png`,
  `e3b hole slab high edgeslit msaa dark.png` (in `frames/`), and
  `e6 conifer-seed-1-side--own.png`.
- The lab is `src/game/__tests__/painted.gpu.test.ts` (E2 to E6) and
  `paintperf.gpu.test.ts` (E7); the mesh passes `src/mesh/weld.ts` and
  `src/mesh/paint.ts`; the shader work under the `PAINTED` toggle in
  `src/game/shaders.ts` and `PAINT_LAYOUT` in `src/game/renderer.ts`.
- `npx tsc --noEmit` is clean and `toy.gpu.test.ts` passes with the toggle
  off; the perf gate's `standard` reads 0.64 against its 0.60 baseline,
  within tolerance, the same before and after E7's file existed.

## E9: the examples (12 October 2026)

Two more tree types, a rock pile, a cliff, eight boulders and pebbles, a
cabin and a jetty, each plain and painted, and a lakeside scene with all of
them (`frames/sheets/e9 *`, key in `KEY.md`). To make them, coplanar
triangles are now merged into faces before painting, and a mesh carries a
quiet flag and a choice of one of three settings compiled into one shader,
which is the shape the real version's per-group opt-in takes. What they
add to the findings above:

- **Widths must be relative to the thing's size.** They are world units
  tuned on a boulder 40 across; at the game's sizes everything is lip.
- **Lip colours must be tinted toward the material.** Under the toy finish
  a near-white lip turns blue-silver and rock reads as quartz; a stone-grey
  lip (`rock2`) reads as stone, a warm faint lip reads as worn wood.
- **The jetty and the cabin's roof are the clearest wins,** the bush the
  best foliage, the fern unchanged. At game distance the gain is real but
  modest, and the palette and the finish limit the picture more than the
  paint does.

## E10: the second round, in the game's light (12 October 2026)

After the review of E9 (colours washed out; the round tree poor against
the conifer; rocks good but wanting polys; the jetty great; the house too
simple), everything was drawn in ooerfish's own day light, palette, toy
finish, sky and soft tone (`frames/sheets/e10 *`). What that adds:

- **Part of the wash was the palette, not the lab.** The game's cream logs
  (0.82) clip to white under its 2.6 sun, and its 0.22 boulder grey lifts
  to blue-grey under the cool shade colour. Brown logs read as a cabin.
- **The lip as a multiple of the material** (`lightRelative`: rock half
  again its own grey, wood a warm 1.4, 1.25, 1.05) holds across light and
  dark things where one fixed lip colour did not.
- **Rocks at 5 rings and 8 segments** are the balance; 6 by 10 painted
  starts to read as a football. A cliff of leaning slabs in stepped rows
  reads as an outcrop.
- **A canopy of clean regular solids** (a dome on a skirt, as the conifer is
  cones) takes the paint better than a cluster of lumps.
- **Glass cannot glow:** a group has no emissive short of a flow kind,
  which the real version may want for windows and the lantern.

## E11: the edge line alone (12 October 2026)

After the review of E10 (the conifer best: flat facets with only the edge
lighting; the rest reads as vertex shading), every face layer was turned
off and only the lip drawn (`frames/sheets/e11 *`). Two findings change
the recommendation:

- **The conifer the user liked carried no painted edge.** Its set had the
  lip at nought; its look was the toy finish's rim and terminator on flat
  facets. So the look the user wants is flat facets, and the face layers
  (falloff, grade, wobble, wrap) are not wanted.
- **The edge line alone needs a lip two to three times the albedo to show
  in the game's light,** and then it reads as a clean ridge on rocks and
  the cliff, is subtle on wood, and turns round foliage into a cage. The
  line belongs on rock and wood, not on trees.

So the real version is the edge mechanism alone (E3b, 0.10 ms a frame with
no layers), opted into by rock and wood groups, with a lip relative to the
material, a gate on the fold, a pixel floor and a fade; and no face layers.

## E12: the charm round (12 October 2026)

After the review of E11 (the clean edge is nice but misses the charm of
the references), the light and the palette were varied with the edge line
on, a flat per-facet value was added, and a geometric bevel was tried
(`frames/sheets/e12 *`). This is the round that moved the picture most,
and it changes where the real work lies:

- **The light is the big lever, not the paint.** The toon ramp gives a
  turned face `albedo × shade × sun × 0.4 + albedo × fill`, and the fill
  (sky and ground light) is why shaded faces are pale. Fill at 0.4 of the
  game's, a cool saturated shade `[0.13, 0.19, 0.34]`, a warm sun
  `[2.9, 2.5, 1.9]`, and occlusion 4 at radius 12 tinted toward the shade
  make rocks read as stone: warm tops, dark cool sides, a soft dark foot.
  The game runs with occlusion at 0 today. `form` is capped at 3 by
  `MAX_FORM`, so the game's 4 already draws as 3.
- **A flat value per facet** (`facet` 0.08 on rock, no hue, no gradient)
  reads as crumpled paper and not as noise or vertex shading.
- **A bevel in the mesh** (`src/mesh/bevel.ts`) sits between its two faces'
  values and never catches a highlight brighter than both, so it is worse
  than the drawn line on boulders (clay pebbles at five times the
  triangles) and better on the cliff's big slabs as a lit chamfer.
- **The palette:** a warm stone albedo, a cool fill at the pick's
  brightness, a real brown for the cabin's cream, and a warm grey for the
  cliff are content changes the picture needs more than any further knob.

So the production work is in three places, not one: the edge line and the
facet value in the renderer (both cheap), the look's shade, fill, sun and
occlusion in the game's `look.ts`, and the palette.

## E13 and E14: the edge as a stroke, and sized by the facet (12 October 2026)

After the review that the edges were straight lines, E13 gave the band
swell, a sided wander, tapered breaks, corner gathering, a feather and a
core, and E14 sized the band by the facet and let the lip be laid on after
the light so it can be brighter than a lit face (`frames/sheets/e13 *`,
`e14 *`). What stands:

- **Width as a fraction of the facet** (the smallest height, about 0.08 to
  0.1) holds the proportion from pebble to boulder, and replaces world
  units. This belongs in the real version.
- **The gate was hiding the sunlit edges.** On a boulder the lit face's
  ridges fold less than 0.4 rad, so the lip sat only on the shaded faces;
  0.3 puts it on the sunward ridges.
- **A lip laid on after the light** reads as paint over the rock rather
  than a bevel, but needs a colour above 1, and with the feather and core
  the boulders read as wet gloss with white smears. The cleaner line on
  E12's light read as drier stone. Taste, to be put to the user.
- **The strokes gather into stars** where several lit ridges meet at a
  vertex, by geometry; the fix (fade the lip where many lit edges share a
  vertex) is not built.
- **Per-thing settings** (a cliff set with a smaller share and a higher
  gate) are needed: one setting does not suit slabs and boulders alike.
- **Small facets on screen** need a cap on the band's share of the facet,
  or a stronger fade, or the small rocks whiten.

## E15: the matte lip kept below the lit face (12 October 2026)

With the lip mixed in before the light, nothing above 1, no core, a calm
feather, and a fade where many lit edges meet at a vertex (counted by the
mesh pass, stride 16), the boulders read as dry stone with no gloss and no
stars, and the small rocks stop whitening with a stronger fade
(`frames/sheets/e15 *`). But a lip that may not pass the lit face shows
almost nothing on the lit side in this light: a faint line on the shaded
ridges and the outline, near invisible at the game's distance. The
reference's visible strokes on lit ridges exist because its lit face is
darker and more saturated than ours. So the room for a visible matte lip
is made by the look and the palette (a darker, warmer rock under a less
clipping sun), not by the edge. The vertex fade, the facet-relative width,
the share cap and the per-thing sets all belong in the real version.

## E16: the darker rock (12 October 2026)

With the rock's albedo halved, the matte lip of E15 shows on the lit
ridges and stays well below white, measured: a lip of 2.2 times the
albedo lifts a pixel by 14 levels on average, 23 at the 90th percentile,
with the brightest lip pixel at 151 of 255 (`frames/sheets/e16 *`,
`lipmeasure-e16.py`). Lowering the exposure or the sun moves face and lip
together and darkens the scene, so the light stays; warm albedos read as
clay beside the grey cliff. At the game's distance the strokes are faint
and the plain build is close. The matte, below-the-face edge is therefore
a close-up effect in this look; the reference's crisp high-contrast
strokes need either a pale of its own hue or a lip allowed above the lit
face, which the user ruled out. That is the taste decision the production
version rests on.

## E17: a pale paint of its own hue (12 October 2026)

With the lip an absolute warm chalk (0.62, 0.55, 0.42) at 0.8, mixed in
before the light on the halved rock, the stroke reads as cream paint laid
along the ridges and carries more hue than the face (chroma 35 against
24.5), lifting a lit pixel by 26 on average and staying below white
(brightest 188 of 255). It shows at the game's distance on the larger
rocks and the cliff (`frames/sheets/e17 *`). Cool and green hues read as
blue or green rock. This is the nearest the experiments have come to the
reference rocks, and it needs no code beyond what E15 built. What still
differs is that the strokes follow every ridge over the gate and are
soft-edged where the reference's are chosen and crisp.

## E18: crispness and choice (12 October 2026)

A hard band (feather 0), a gate of 0.45 over a steep ramp, the lip only
on edges whose two faces' normals lean up (`ridgeOnly`, the up-share
packed by the mesh pass), and the chalk at 1.2 leave a handful of bold
crisp cream dashes on the upper ridges, a fifth of the pixels E17's lip
touched (`frames/sheets/e18 *`). Measured against a crisp band with no
variation, which runs every edge and reads as a wireframe, the taper's
breaks and the swell are what make a crisp stroke read as a mark, so they
stay. This is the nearest frame to the reference rocks of all the rounds.
What remains is that the marks are chosen by rule (fold, up-share, noise)
and not by a hand, and are one flat cream along their length.

## The settled recipe

Edge code as E15 built it, with E18's choice: width a tenth of the
facet (0.06 for slabs), gate 0.45 over 0.15 (0.45 for slabs too),
ridge-only above 0.3, a hard band with taper 0.2 and swell 0.3, the vertex
fade over 0.8 of the facet, a share cap of 0.25 and a fade from 6 px, the
lip an absolute warm chalk (0.62, 0.55, 0.42) at 1.2 mixed in before the
light, a quarter cooler on the cliff, on the rock at half the game's
albedo, under E12's light (shade (0.13, 0.19, 0.34), fill at 0.4 with a
cool sky light, sun (2.9, 2.5, 1.9), occlusion 4 at radius 12). No face
layers, no wrap, no bevel on boulders.

## E19: the mark loaded and dry (12 October 2026)

A value noise along each mark at the break's scale, a dimming toward each
dash's tips, and a small hue shift from a warm loaded head to the rock's
own colour at the dry tail give each dash a head and a tail close up,
measured as a spread of the lift of 20 against 15 (`frames/sheets/e19 *`).
At the game's distance the change is lost. It belongs in the real version
as three cheap knobs for close views, with the head's direction the one
thing noise cannot choose. The settled recipe above gains: markValue 0.6
at the break's scale, markEnd 0.8, markHue 1, the chalk at 1.3.

## E20: one dominant ridge per face (12 October 2026)

Scoring each face's border edges by fold, up-share and length and picking
the best chooses little on its own, because neighbouring faces seldom pick
the same edge and the union is most of the strong edges. What chooses is
agreement: an edge drawn only where both its faces pick it, which halves
the marks and leaves a few long bold strokes on boulders and piles, the
most painter-like of all the rounds (`frames/sheets/e20 *`). It strips
slab-like shapes, so a cliff keeps the gate rule instead. The choice is
cheap: seven bits a triangle from the mesh pass and one multiply in the
fragment. The settled recipe gains the agree mode for boulders and piles,
with the ridge filter kept and the gate at 0.3; the cliff stays as it was.

## E21: ridgelines, a budget per rock, spacing (12 October 2026)

Chaining a rock's convex edges into ridgelines in the mesh pass, scoring
them, taking a budget of three for a boulder with an exclusion distance
between them, and putting the stroke's loaded head at the ridge's higher
end and its dry tail at the lower, gives the first marks that read as a
painter's chosen strokes (`frames/sheets/e21 *`). It costs five floats a
vertex more (stride 20) and nothing in the fragment beyond E19's knobs
reading a parameter instead of a noise. The real version needs the
budget by world size, not mesh units (pebbles took a boulder's three), a
per-lump count for a pile, and a rule of its own for slabs, whose
ridgelines run down their vertical corners; at the game's distance the
marks are still few pixels. The settled recipe gains the ridgelines for
boulders: floor 0.15, turn 50°, budget 1 + 2 × size, spacing 0.4, no
breaks, width 0.08 of the facet, the mark along the chain.
