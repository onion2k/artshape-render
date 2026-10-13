# The crystal-clear water: what the experiments found

Part 0 of ooerfish's `docs/crystal.md`, done on 13 October 2026 in the worktree
`artshape-render-crystal` (branch `crystal` from `f9f7b2c`, v0.38.0). Nothing is
committed. The brief was `~/.claude/plans/crystal-experiments.md`. Every figure
here comes from one machine, `apple/metal-3` in headless Chrome, and every cost
from one run of the lab. The user's choices go at the end, under **Chosen**,
once they are made.

## The short of it

| Option (part) | What the pictures say | Recommendation |
| --- | --- | --- |
| E1 the shallows lit (1) | The knee is what brightens the bed. The lift tints it, and on a sand bed under the lake's deep blue it tints it lilac. | Build the knee at half a clarity. Build the lift only for a turquoise shallow colour, at 0.5 at most. |
| E2 the caustics crisper (2) | A narrower line alone only dims the caustics. A narrow line needs its strength raised to be seen. At 0.04 it breaks up at the far end, and the fringe reads as a fault. | Line 0.08 with the strength about three times today's. No third layer, no fringe. |
| E3 the fine normal (3) | It changes nothing on the lake at all. On the pond it roughens the edges of things under the water into steps. | Do not build part 3 as written. |
| E4 the scene in the mirror (4) | It works, and the clip at the water costs nothing and is essential. The rock's reflection is faint on this lake, and the distortion does nothing at the far water. | Build it at half size with the oblique clip, and ripple it by the swells. Measure it on the real lake first. |
| E5 light through the crest (5) | Under the lake's day sun the light-through is exactly nothing. The crest foam is all or nothing at the lake's steepness. | Drop part 5. |

## Where it was done, and how

- **The lab** is `src/game/__tests__/crystal.gpu.test.ts`. It draws each frame at 384 by 384, writes it to
  `/tmp/crystal` and composes the sheets `/tmp/crystal/sheets/E1.png` to `E5.png`. In each sheet the plain picture
  is on the left, then the strengths, with one row per scene. It holds nothing but that every frame draws without a
  validation error. Run it with
  `VITE_FRAME_DIR=/tmp/crystal npx vitest run --config vitest.browser.config.ts src/game/__tests__/crystal.gpu.test.ts`
  (about 13 s).
- **The shader:** `CLEAR_FRAGMENT` in `src/game/clear.ts` gained an `xp: array<vec4f, 4>` at the end of
  `ClearFrame`. It is written by the renderer after the frame's own floats from a temporary
  `ClearWater.experiment`, nought when absent. Packing past the end kept `CLEAR_FRAME_FLOATS`, and so the node
  tests, as they were. Each prototype is a branch on its own field, and the old expressions are left as they were.
  The caustics' old block runs untouched in an `else`.
- **The mirror:** clear group 1 gained binding 5, a texture, with a texel in its place when there is none
  (`GameRenderer.setExperimentMirror`). Everything added is marked `CRYSTAL EXPERIMENT`.
- **The golden** (`cleargolden.gpu.test.ts`) passed with every field at nought:
  - after the shader and renderer changes went in, which was before the first picture;
  - again at the end, the shader not having changed between the two.

  It was made to fail on purpose, with the lift forced to 0.5 and its depth to 0.75 inside the renderer, and passed
  again once that was taken out. So it is seen to catch a field left on.
- **The quick check:** `npm run typecheck && npm test` is green, with 1,309 tests in 82 files.

### The scenes

- **The pond** is `clearscene.ts`'s ramp of mud with its two white boxes and the golden's water settings, cut 96
  by 96 so that swells can bend it (`sheet(96)`).
  - **Changed from the brief:** it is seen from the golden's camera, (0, −12, 10) looking at (0, 0, −1). The
    camera clearmirror has, 1.2 units over the water, sees none of the bed: the first sheet drawn from it showed
    only the sky's mirror and the ramp's near edge.
- **The lake** is my build of ooerfish's.
  - **The ground:** the same ramp of depth (−0.2 to −6 across x) inside a rounded outline 10.5 units out, shelving
    up at 0.6 to a grass bank 0.6 high. The bed is sand (0.75, 0.68, 0.5), with a patch of weed colour
    (0.2, 0.4, 0.15) lying on the deep bed.
  - **The rocks:** a `boulder` 2.6 across stands in the north shallows, meeting the water about 0.5 out from its
    middle, and one 2.4 across stands on the north bank.
  - **The water:** a shore field round the outline and the shallow rock, and the water given ooerfish's `CLEAR`,
    `CLEAR_WAVES` and palette at b59aa0e, clean, with its caustics on.
  - **The look:** the game's day look: toon, MSAA, its sun, sky and toy finish, and the soft tone map.
  - **Its size:** the lake is about a third the size of the game's. So the figures that are about the lake's size
    are scaled by 10.5/30: the views' distances and target, and the near colour's reach (15.75 against 45). The
    water's own lengths are the game's as they stand. The shore view is polar 1.3, the overhead 0.35, both lenses
    40°.
- **The costs** are of the lake from the shore at 1280 by 800, 300 frames after the first. Each is the least and the
  median of seven runs of thirty frames, after ten to warm up.
  - **The wobble:** the plain frame's least read 1.327, 1.363, 1.337 and 1.387 ms across four runs of the
    unchanged lab, so a difference under about 0.06 ms is not a difference.
  - **The figures** are only against each other, on this run.

## The costs, one run

| Frame | Least (ms) | Median (ms) | Against plain |
| --- | --- | --- | --- |
| **Plain** | **1.387** | **1.473** | |
| E1 lift 0.2, knee 0 | 1.377 | 1.407 | none seen |
| E1 lift 0.5, knee a quarter clarity | 1.360 | 1.450 | none seen |
| E1 lift 0.9, knee half a clarity | 1.347 | 1.430 | none seen |
| E1 knee half a clarity alone | 1.367 | 1.493 | none seen |
| E2 line 0.08 | 1.363 | 1.423 | none seen |
| E2 line 0.04 | 1.347 | 1.427 | none seen |
| E2 line 0.04, third layer | 1.460 | 1.650 | +0.07 (+0.06 to +0.16 over four runs) |
| E2 line 0.04, third layer, fringe 0.02 | 1.900 | 2.083 | **+0.51** |
| E2 line 0.04, third layer, fringe 0.05 | 1.990 | 2.143 | **+0.60** |
| E3 detail ×3, 0.3 | 1.407 | 1.547 | +0.02 |
| E3 detail ×6, 0.6 | 1.463 | 1.640 | +0.08 |
| E3 detail ×12, 1.0 | 1.420 | 1.497 | +0.03 (E3 read +0.02 to +0.15 over four runs) |
| E4 the mirror's own frame, half size (640×400), its sun's shadow on | 0.130 | 0.243 | (alone) |
| E4 the mirror's own frame, half size, no shadows | 0.097 | 0.097 | (alone) |
| E4 the mirror's own frame, quarter size (320×200), its sun's shadow on | 0.113 | 0.127 | (alone) |
| E4 the mirror's own frame, quarter size, no shadows | 0.080 | 0.087 | (alone) |
| E4 the whole: the mirror at half size, no shadows, and the lake reading it | 1.413 | 1.513 | +0.03 |
| E4 the whole: the mirror at quarter size, no shadows, and the lake reading it | 1.373 | 1.417 | none seen |
| E4 the clear pass reading a mirror, none drawn | 1.387 | 1.553 | none seen |
| E5 sss 0.3, foam under J 0.9 | 1.417 | 1.453 | none seen |
| E5 sss 0.6, foam under J 0.7 | 1.387 | 1.487 | none seen |
| E5 sss 1.0, foam under J 0.5 | 1.420 | 1.613 | none seen |
| E5 sss 1.0, the sun ahead | 1.357 | 1.410 | none seen |
| E5 sss 1.0 alone, the day sun | 1.367 | 1.527 | none seen |
| E5 foam under J 0.15 alone | 1.407 | 1.497 | none seen |

The fringe is the only option whose cost stands well clear of the wobble. It does the Voronoi sum three times over.

## E1. The shallows lit

**The question:** does lifting what is under thin water toward the shallow colour give the reference's bright bed?

**What was built:**

- **The lift:** after the caustics and before the absorption, `below` is mixed toward `max(below, hue × light)`
  by `exp2(−stand / shallowDepth) × lift`. The hue is the water's albedo held to a peak of one, and the light is
  the one the water's own body is lit by. Lightening "toward" a colour darker than the bed would have darkened it,
  so it may only raise a channel.
- **The depth:** `shallowDepth` is half a clarity (0.75 on the pond, 0.4 on the lake).
- **The knee:** the path through the water, less the knee, is what the absorption is taken over, so nothing is lost
  in the first `knee` of it.
- **The strengths:** lift 0.2, 0.5 and 0.9 against knees of nought, a quarter and half a clarity, and the knee at
  half a clarity alone.

**What was seen** (`E1.png`):

- **The pond:** the lift turns the brown mud of the shallow west third teal, the more so the stronger. At 0.9 the
  strip by the bank reads as bright turquoise shallows, which is the reference's colour. The boxes are unchanged.
- **The lake from overhead:** the knee alone brightens a band round every shore to the sand's own warm pale
  colour. That is the nearest thing in the sheet to the reference's pale bed seen through thin water. The lift on
  this lake tints that band lilac: the lake's shallow colour (0.08, 0.36, 0.7) is a deep blue, so it raises only
  the blue of warm sand. At 0.9 there is a lavender rim all round.
- **The lake from the shore:** no change can be seen. From 15° above the water the near colour and the sky's
  mirror are all there is, and the bed does not show at that angle at all.
- **The cost:** none that could be measured.

**Recommendation:** the knee at half a clarity, for the bright bed. The lift only where the shallow colour is a light
turquoise (the pond's), and there at 0.5. On ooerfish's palette the lift should stay at nought, or be given a colour
of its own: lifting toward the water's albedo is the wrong colour for a deep-blue lake. Neither reaches the shore
view, which is the game's main one.

## E2. The caustics crisper

**The question:** how narrow a line, how many layers, and does a colour fringe read as light or as a fault?

**What was built:**

- **The line's width:** `CAUSTIC_LINE` made a field, at 0.16 (today's), 0.08 and 0.04.
- **A third layer:** a third Voronoi layer at 2.2 times the cell, 1.7 times as fast, at 0.3 of the sum. That is
  1.7 times the second layer's 1.3; the brief left open which layer it is finer than.
- **The fringe:** the red and the blue taken from the cell offset by 0.02 and 0.05 of a cell either side of the
  green, on the diagonal.
- **Added to see them:** columns at three and eight times the strength (the pond at caustics 3 and 8, the lake at
  0.36 and 0.96), and a row of the pond's near shallows at three times the size.

**What was seen** (`E2.png`, and crops looked at four times the size):

- **A narrower line at today's strength only dims the caustics.** The lines are the same height and cover less of
  the bed. At 0.04 the pond changed by at most 13 levels in 255, the lake by at most 10 from overhead, and none of
  it can be seen. The lake's caustics (0.12) are invisible in every column at today's strength.
- **At three times the strength:**
  - Today's line is a soft wash of broad pale bands.
  - Line 0.08 is a crisp network of cell edges, still continuous at the far end of the pond. This is the one that
    reads as the reference's sharp lines of light.
  - Line 0.04 with the third layer, at three and eight times, is a dense fine net, busier than the reference.
- **At the far end** (the pond's top left, where the bed is near the surface and far off), the 0.04 line breaks into
  stair-stepped dashes. That is aliasing at one sample a pixel. The 0.08 line does not, at this size.
- **The fringe** reads as a green line with magenta beside it, at both offsets, more like a fault in the picture than
  a rainbow edge of light. It is also the dearest thing measured: +0.5 to +0.6 ms.
- **The third layer** costs about 0.1 ms and adds busyness rather than light.

**Recommendation:** line 0.08 with the strength raised about three times, so a game asks for crisp lines and keeps
their brightness. On the lake that would be caustics about 0.36 against today's 0.12; seen at that, the lake from
overhead shows faint lines in its shallows. No third layer, and no fringe. If a narrower line is wanted later, it
must widen with the pixel's footprint, or it aliases at the far end.

## E3. The fine normal

**The question:** does a finer wave layer, in the normal alone, make the bed's wobble and the mirror read as water?

**What was built:** a third `waterSlope` at `detailScale` times the fine waves' scale (3, 6, 12), faster by its
square root, added to the normal and so to the bend, at `detailAmount` (0.3, 0.6, 1.0). It is never added to the
height. The row added to the sheet is the pond over its shallow box, at four times the size.

**What was seen** (`E3.png`, and changed pixels counted against the plain frame):

- **On the lake, nothing.** No pixel changes at ×6 or ×12 from either view, and 162 pixels by one level at ×3. The
  water's waves fade themselves out once a wave is shorter than a few pixels (`waterWave`'s `smoothstep(0.3, 0.7,
  pixel × k)`). At the lake's flow scale (2.4) every wave of the finer layer is that short.
- **On the pond:** about 40,000 to 67,000 pixels change, by at most 69 levels. In the crop, the box's submerged sides
  go from a smooth sideways wobble to a ragged edge stepped pixel by pixel, at ×6 most and ×12 no more (the fading
  again). It does not read as finer water. It reads as noise on the edges of what is under it. No break-up of the
  mirror could be seen in either scene.
- **The cost:** about 0.1 ms, close to the wobble.

**Recommendation:** do not build part 3 as written. At the game's scale the waves' own filtering removes the layer,
and where it survives it is pixel noise. A wobble the eye reads would have to come from something coarser than a
pixel's reach, such as the swells' own normal in the bend, which nothing here tried.

## E4. The scene in the mirror

**The question:** what does a mirrored pass cost, and does the lake read better with the rocks in the water?

**What was built:**

- **A second `GameRenderer`** with the lake's land (both ground meshes, the weed and both rocks, no water), drawn
  from the shore camera mirrored under the water's plane. Its world-up is kept, so its frame is the reflection
  upside down. The clear pass reads it at (u, 1 − v), offset by the change the waves make to the normal times
  `mirrorDistort` (0.01, 0.03, 0.08 of the screen).
- **Its frame** is half size (192, and 640 when timed) and a quarter. Its background is magenta, which the clear
  pass reads as "nothing here: the sky as today". Its own tone map is `clamp`, undone with a power of 2.2 in the
  pass, so the mirror is the scene's light clamped at one and not true HDR.
- **The clip** is Lengyel's oblique near plane, put on the mirror camera's projection (`clipAtWater` in the lab).
  The near plane is the water, so nothing under it is drawn, at no cost at all. One column draws it unclipped.

**What was seen** (`E4.png`, whose third row is the mirror's own frame):

- **Clipped:** the bank's rock shows in the water under the far shore as a soft pale shape, with the green of the
  bank as a thin line at the waterline. It is plainly there, but faint, because a pale rock on a pale sky's
  reflection is little contrast. 4,570 pixels change, by 19 levels on average.
- **Not clipped:** the mirror camera sees the sandy bed from beneath, and the whole lake goes milky. The clip is not
  optional.
- **From overhead:** nothing changes. The surface mirrors little face on, and what it would mirror there is sky.
- **Quarter size** looks all but the same as half size at this picture size. Both are soft.
- **The distortion does nothing.** 0.01, 0.03 and 0.08 changed exactly the same pixels by the same amount. The
  water's fine waves have faded to nothing at the far water, where the mirror shows things. The swells, which do not
  fade, are in the base normal that the offset is measured from. So nothing ripples the reflection there.
- **Faults of the hack, not of the idea:**
  - A thin rim where the magenta key meets the frame's edges.
  - A band of grey along the top of the mirror's own frame, which I did not explain. It falls on the south bank in
    the lake's frame and is hidden there.
- **The cost:** the mirror's own frame was 0.10 ms at half size without shadows and 0.13 with its sun's shadow.
  Quarter size was 0.08 and 0.11. The whole frame with the mirror at half size was within the wobble of the plain
  one (+0.03).

**Recommendation:**

- **Build it,** at half size, with the oblique clip, and with no shadow maps redrawn.
- **The ripple must come from the swells' normal** (the Gerstner one), or from a slope that is not filtered away,
  or the reflection lies dead still.
- **Whether the lake reads better** cannot be settled on this lake. It has one rock to mirror, and that rock is pale.
  The game's banks have trees, the cabin and the jetty, dark against the sky's reflection, and would show it far
  more. That is the picture to judge it by, in part 4 or a part-0 follow-up drawn in ooerfish.
- **The cost here is not the cost there.** This lake's land is two meshes of 0.25-unit cells and two rocks, about
  60,000 triangles. The game's banks have some three hundred trees, the kit's clumps, the cabin and the grass. Part
  4's budget (one millisecond over `standard clear`, a guess) should be measured on ooerfish's `STANDARD` scene
  before it is written. Leaving the grass and cards out of the mirror, as the plan says, will matter more there
  than here.

## E5. Light through the crest, and crest foam

**The question:** at the lake's centimetre swells, is there anything to see?

**What was built:**

- **The light-through:** the body lightened toward twice the water's albedo, by the swell's height as a share of the
  most the waves can lift it, times `pow(max(dot(v, −sunDir), 0), 4)`, at 0.3, 0.6 and 1.0.
- **The crest foam:** foam where the Gerstner sum's Jacobian is under 0.9, 0.7 and 0.5.
- **Added:** a column with the light-through alone under the day sun; one with the sun put ahead of the shore
  camera, low over the far bank, in the shader alone; and one with foam alone under a Jacobian of 0.15.
- **Drawn at:** ooerfish's wave heights and at ten times them. The pond was given the lake's swells.

**What was seen** (`E5.png`, and changed pixels counted):

- **The light-through under the lake's day sun changes no pixel at all,** in any scene, at either height. The sun
  (0.45, −0.5, 0.74) is behind the shore camera and the overhead one, so the eye never looks toward it through a
  crest. At dawn and dusk the term is a few thousandths for the same reason.
- **With the sun put ahead,** the crests take bands of lighter blue: about 10 levels over 23,000 pixels at the lake's
  heights and 26,000 at ten times. It can be seen, but only toward the sun.
- **The crest foam is the same at both heights,** because the Jacobian depends on the waves' steepness and not their
  height. The lake's four steepnesses add to 1.01, so the sum folds hard.
  - Under 0.9, 0.7 and 0.5 the foam is large white blotches over half the lake, then a third, then a scatter of
    flecks, a cow's hide on still water.
  - Under 0.15 there is none in this frame.
  - Ten times the height only makes the swells themselves visible. It also shows the bank's edge poking through
    the water at the outline, which is my lake's bank being lower than the swells, not the option.
- **The cost:** none that could be measured.

**Recommendation:** drop part 5. The light-through never shows with the lake's sun and views. The foam is a matter of
the steepnesses, which the lake chose to be too low to crest. If crest foam were ever wanted, the cut would be found
between 0.15 and 0.5 and seen moving, not set from these stills.

## What is not verified

- **Nothing was seen moving.** Every picture is one still at a water clock of 1.5 s. Shimmer, the caustics' crawl,
  the fine normal's noise and the mirror's ripple were judged from stills alone, and the house rule asks for moving
  pictures too. A few frames a tenth of a second apart for the chosen options would answer it.
- **The pictures are 384 pixels square, not the game's 1280 by 800.** A pixel there is about a third of one here,
  so E3 at ×3 might show a little in the game, and E2's line 0.04 would alias less. Not checked.
- **The lake is not ooerfish's lake.** It is a third the size, with a sand bed (the brief's choice; the game's bed is
  a dark slate), and no trees, cabin, jetty, grass, fish or fog. ooerfish was not run. Its look was copied by hand
  from b59aa0e. How the options look over the game's dark bed is unseen: the knee would show far less there.
- **The mirror** is an LDR frame clamped at one and decoded by a power of 2.2. It is not tinted by `mirrorTint`, and
  it is keyed on magenta. Its cost includes a whole second renderer's frame (its post pass and, where said, its own
  shadow map) on a light scene, so it is right for this lake and nothing else.
- **One machine:** `apple/metal-3` in headless Chrome. No other GPU or browser was tried. The pond is drawn at one
  sample a pixel with PBR, the lake at four with toon.
- **Timed by throughput,** as `perf.gpu.test.ts` times. A difference under 0.06 ms was not resolved. No timing was
  taken at the game's real frame.
- **The grey band** along the top of the mirror's own frame was not explained.
- **The golden was run** once the shader's branches for all five were in, and again at the end, rather than
  separately after each experiment. The shader did not change between those runs, so each experiment's code was
  held by both.

## On the real lake

The three options kept were put on ooerfish's own lake, at 1280 by 800, after the first sheets were seen.

### Where it was done

- **The worktree:** `~/projects/ooerfish-crystal`, branch `crystal-pictures` from `b59aa0e`, nothing committed. Its
  `node_modules/artshape-render` is a link to this package worktree, so the page draws with the lab's clear pass.
- **The options** are read from the address, `?crystal=knee,caustics,mirror` or any of them, in `src/crystal.ts`.
  A name not known is refused, named on the console, and the rest kept, as the lab's settings are. They are applied
  to `look.clear` in `apply` (`src/main.ts`):
  - **The knee** at half the clarity the water resolves to (0.4 on a clean lake), with no lift.
  - **The caustics:** the line at 0.08 of a cell and the strength three times today's (0.12 to 0.36 clean; a sick
    lake's share of it scaled the same way).
  - **The mirror:** a second `GameRenderer` drawing the lake's statics from the camera mirrored in the water's plane,
    clipped there by the oblique near plane. The statics are the banks, the trees, the cliff and its falls, the
    cabin, the jetty and the kit's cards. It draws into a texture half the frame's size, before the lake's own frame,
    in `draw` and in `measureFrame` alike. It has no grass, no fish and no particles.
- **The mirror's ripple** comes from the swells' Gerstner normal, at a distortion of 0.08. That is a new mode of the
  lab's flag (two in place of one), since the fine waves had shown nothing to ripple it by. The golden stayed green
  with it in.
- **The pictures** are `smoke/crystal.spec.ts` in that worktree, on `SMOKE_PORT=5206`:
  - each picture booted with `?seed=1&paused=1&rung=full`, set by `set(page, scene)` (120 frames), the overlays
    hidden, and the `#view` taken;
  - the sheets are `/tmp/crystal/lake/clear-day.png`, `half-boat.png`, `half-overhead.png` and `sick-day.png`, with
    plain, knee, caustics, mirror and all three in a row at half size. The single frames are beside them.
- **What changed** was counted against plain, pixel by pixel. I looked at every sheet and at crops twice the size.

### The cost at `STANDARD`

Measured as `perf.spec.ts` measures it (`measureFrame` after `set(page, STANDARD, 180)`, the least of its samples). Each
configuration was booted and timed in turn, three rounds, and the least of the three is given.

| Frame at `STANDARD` | Least (ms) | The three rounds | Against plain |
| --- | --- | --- | --- |
| The parent (ooerfish `b59aa0e` on the real v0.38.0, a run of its own) | 2.910 | 2.960, 2.920, 2.910 | |
| **Plain** (the lab's package, every option at nought) | **2.920** | 2.920, 2.950, 3.020 | |
| Knee | 2.930 | 3.020, 2.990, 2.930 | +0.01 |
| Caustics | 2.950 | 3.060, 3.000, 2.950 | +0.03 |
| Mirror | 3.090 | 3.120, 3.090, 3.100 | **+0.17** |
| All three | 3.070 | 3.110, 3.120, 3.070 | **+0.15** |

- **The machine was quiet.** The parent read 2.910 ms against its baseline of 2.95, about 1% under. An earlier round of
  plain, all three and the mirror alone read 2.960, 3.080 and 3.090.
- **Plain matches the parent** within the rounds' spread, so the lab's branches at nought cost the lake nothing that
  can be measured.
- **The mirror is the only option that costs.** It adds about 0.15 ms, all of it its own frame, which is about 5% of
  the lake's frame and far inside the 8 ms budget. Part 4's guessed budget of a millisecond is about six times what it
  took.
- **The knee and the caustics** are within the rounds' wobble.

### What each picture shows

- **The knee darkens the shallows on this lake.** ooerfish's bed is a dark slate. Taking away the absorption in the
  first 0.4 of the path lets more of that slate through, so a band just inside the foam line goes a darker navy, by day
  from the shore and plainly from overhead.
  - It changes 139,000 pixels by up to 27 levels on the clear lake, 208,000 by up to 73 from overhead, and 52,000 on
    the sick lake. From the boat it is 12,000, by at most 8.
  - On the lab's sand it was the bright bed the reference has. Here it is the reverse, because the bed is the
    reverse. It does nothing for the lake while the bed is dark.
- **The caustics show nothing that can be seen.** At three times the strength with line 0.08, they change 17,000
  pixels by at most 13 levels on the clear lake, 20,000 by at most 10 from overhead, 3,400 on the sick lake and 650
  from the boat. Crops at twice the size show no line on the shallow bed. The bed is dark, the clean lake's strength
  is low even at 0.36, and the caustics light the bed in its own colour. A crisp line wants a much higher strength,
  or a paler bed, before it is anything on this lake.
- **The mirror changes the lake more than anything tried.**
  - **From the shore, clean:**
    - The two falls hang in the water under them as white columns, broken by the swells into streaks.
    - The rocks of the north shore, the jetty and the rock on the right each show a reflection below them.
    - The cliff fills the far half of the lake with its own darker grey-blue in place of the sky's pale tinted
      blue. Where the reflection of its top meets the sky's there is a hard, faceted edge, reaching well down the
      frame on the left. That edge is the cliff's silhouette, as it should be for a cliff that tall, but it is sharp:
      nothing softens it.
    - 307,000 pixels change, by 19 levels on average.
  - **From the boat:** the falls' reflections stream down toward the camera, and the far water is mottled in lighter
    and darker patches of the reflected bank. 483,000 pixels change.
  - **On the sick lake:** the same region turns a strong olive green, much greener than plain (42 levels on average
    over 307,000 pixels). My guess, not checked: the darker cliff stands in for the pale sky that used to lighten the
    water, so the water's own green shows through more.
  - **Overhead:** almost nothing changes (20,000 pixels, 3 levels), since face on the water mirrors little.
- **All three together** look as the mirror alone does, with the knee's darker band at the shore.

### Recommendation, on the real lake

- **The mirror is worth building.** It is the one option that makes this lake read as water from the views the game
  is played in, and it costs 0.15 ms. The real version should still:
  - soften the hard edge where the reflection meets the sky (the mirror at a lower mip, or a blur toward that edge);
  - decide whether the reflection takes `mirrorTint`, since the sick lake's green deepens a good deal without it;
  - draw into a true HDR texture rather than a clamped one.
- **The knee should not be built for ooerfish** while its bed is a dark slate. It is the option for a pale bed, as
  the sheets on the lab's sand showed.
- **The caustics' crisper line** is right in shape, but on this lake it needs a strength well past three times, or a
  paler bed, before it is seen at all. That is a taste for the user to judge from a picture at a higher strength,
  which was not taken.

### Not verified, on the real lake

- **Nothing was seen moving.** One paused frame per picture, 120 frames after boot.
- **The mirror leaves out** the grass, the fish and the falls' mist. It is not tinted, it is clamped at one, and it is
  keyed on magenta. The rim the key leaves at the reflection's edges was not looked for closely.
- **The sick lake's olive** is explained by a guess.
- **Only shore, boat and overhead by day** were pictured. Dusk, night and the phone view were not, and nor was the
  lean rung.
- **The parent's figure** is from a run of its own, between the two runs of the options. It is not interleaved with
  them, though the machine read the same either side.
- **One machine:** `apple/metal-3`, headless Chromium, at 1280 by 800.

## Chosen

_For the user to fill in from the sheets: the strength (or none) for each of parts 1 to 5._
