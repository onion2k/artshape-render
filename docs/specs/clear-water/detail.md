# Clear water's detail layer

Built on 14 October 2026 on `detail-option` from v0.40.0 (`cfa6ce3`), as part 11 of the crystal-clear water plan
(`ooerfish/docs/crystal.md`), which holds the aim. The experiment it was chosen from is in the `artshape-render-detail`
worktree, `docs/specs/clear-water/detail-experiment.md`, and the films in the game are part 11b's record. The user chose
the experiment's variant B, a cell of eight pixels at an amount of one. This note says what was built and why. It stops
before the release, which is the user's.

## What it is

Two more options of `look.clear`. A water that names neither draws as 0.40.0's did, to the pixel:

- `detailPixels` (nought): the layer's cell, in pixels on the screen. The fine waves are read once more, at the scale
  that makes their finest wave this many pixels across. That holds near and far, so the layer does not fade with the
  distance as the twelve do. Nought is none, and none of its sums are done. A cell under a pixel is held at one, since
  a finer one would only alias. It is pixels and not a length, so no unit turns it.
- `detailAmount` (one, the first guess and the films' choice): how much of the layer's slope is added, as a share of
  the water's own steepness. It is moot while the cell is nought.

The slope is added to the normal, so to the light, the Fresnel, the sky's reflection and the bend. It is added to the
mirrored scene's read too. It never reaches the height or the vertex stage, so what floats is not moved. The ripples'
lightening, the glitter and the sparkles read the old slope.

## As built

- **The scale per pixel.** `clearDetail` reads `waterSlope` twice, at the two powers of two of the waves' own unit
  either side of the wanted scale, `log2(cells × footprint × scale)`. They are blended by where the wanted scale lies
  between them, so each level is fixed in the world and the scale is continuous as the camera moves. The blend is
  divided by its own length, `sqrt((1 − u)² + u²)`, so the layer is as rough midway between levels as at either. The
  levels are set 37 units apart in the waves' own coordinates, so their crests do not line up.
- **The footprint from the lens, not the triangle.** The experiment took the scale from `fwidth(in.world.xy)`, which is
  constant over each triangle of the surface the swells have moved, and jumps between them. `clearFootprint` instead
  meets the rays through the pixel's four edges with the still water's plane (the height less `in.swell`). It uses the
  camera's position and the inverse of its view and projection, and measures the hits as `length(fwidth())` measures a
  flat plane. Nothing in it depends on the triangle being drawn. The vertex stage was not touched.
- **The fade moved down (variant B).** The twelve waves fade from 0.3 to 0.7 of a wave a pixel (`waterWave` in
  `flow.ts`). As first specified, that took out every wave under nine to twenty pixels whatever scale they were read
  at, and the layer showed nothing (variant A). The pixel handed to the layer's fade is scaled by `cells ×
  DETAIL_FADE`, where `DETAIL_FADE` is `WAVE_FADE_FROM / 2π`, so its finest kept wave is a cell across. `WAVE_FADE_FROM`
  (0.3) is said in `clear.ts` and in `flow.ts`'s WGSL, and a test holds the two equal.
- **No struct grew.** The cell and the amount ride in the ripples' two free words, the last two of
  `ClearFrame.ripples`, which were noughts. `rippleUniform` writes them only when a cell and an amount are both over
  nought. Otherwise it writes the noughts it wrote before, and the pass reads a cell of nought as none.
  `CLEAR_FRAME_FLOATS` is still 104.
- **Nought draws as before.** Every new sum is behind `cw.ripples.z > 0.0`. Outside the branch, the normal is now a
  `var` set from a `let` of the old sum, and the mirror's lean reads a `var` that is the old `n0` unless the layer is
  on. `cleargolden.gpu.test.ts` passed with the change in, and failed with the layer packed on regardless.

## The fault at a thing standing in the water

In the experiment's pond a light fleck appeared at the white post's waterline. The films showed a purple-red smear
beside the game's bobber. Both were found and put right, along two paths.

- **The bend.** It is sized by the water standing straight under the pixel, and the old guard refused only a landing
  above the water. Beside a post, that pixel looks down two units to the bed. The layer's fine, steep tilt sent
  scattered pixels a few away onto the post's side just under the surface, which they showed almost unfiltered. A ray
  cannot be bent that far onto something so shallow. With the bend off, the fleck went (66 levels at the worst pixel,
  down to the 16 the layer moves the light anywhere). With the mirror off, it did not.
  - **The fix:** the layer's landing is kept only where it is at least `DETAIL_LANDING` (half) as deep under the
    surface as what the fine waves' own bend shows there. That is their landing where it is under the water, and the
    water straight under where it is not. Short of it, their landing is taken whole.
  - **Shortening the layer's bend instead was tried first.** It still crossed a thin bobber's last pixel onto it: 20
    levels redder beside the bobber, against 75 with no fix.
- **The mirror's read.** In the lake, with the bend fixed, a soft mauve patch stayed beside the bobber's ring. It went
  with the mirrored scene off. The layer's lean shifts the read by a share of the screen, which is how a far bank's
  reflection moves. A thing standing at the water point hardly moves in it, so the shift pulled the red reflection of
  the bobber's top out beside it.
  - **The fix:** the mirror's depth is now kept (`storeOp: 'store'`, `TEXTURE_BINDING`) and bound at 7 of the clear
    group, with a texel of nought standing in while the scene is not mirrored. `clearMirrored` turns a texel's depth back
    through the camera's own inverse, into how far what the mirror shows is from the water point. The layer's read is
    dropped for the swells' own only where it lands on something nearer the water than both half of what the swells'
    read shows (`DETAIL_LANDING`) and a tenth of the camera's distance (`DETAIL_NEAR`). So a far bank's reflection
    still breaks up as the films chose, and a bobber's reflection can break outward. A near thing's colour cannot be
    pulled out beside it.

## What is held, and by what

- `clear.test.ts`:
  - the defaults (no cell, an amount of one) packed as the noughts the words were;
  - a cell and an amount packed into the ripples' last two words, with the frame still 104 floats;
  - packed only when both are over nought, and a cell named at the default amount packed;
  - what is not a number refused, the amount held to nought or more, a cell held to a pixel, and a negative cell is none;
  - no unit turning either, with a default cell of eight put in for the length of the test;
  - `WAVE_FADE_FROM` equal to the 0.3 in `flow.ts`'s fade, and `DETAIL_FADE` built from it;
  - the layer's words (`clearDetail`, `clearFootprint`, `DETAIL_FADE`) in no scene build.
- `cleardetail.gpu.test.ts`, on three scenes. The lit sea is a water lit only by a low sun, with no light through it
  and no mirror, so a level is the normal's lean and does not depend on distance. The pond has its two posts. The lake
  is the experiment's, rebuilt from part 0 and shared in `clearlake.ts`, toon at four samples with the scene mirrored.
  - **The far water is moved:** 5.10 levels on average over rows fifty to seventy units off. No cell, and a cell at an
    amount of nought, draw plain to the pixel.
  - **As strong far as near:** a row's spread of levels, the layer's frame less plain's, is 6.04 far against 6.89 near,
    within a factor of two, where plain's own reads 6.23 near and nought far. Near, it is at least nine tenths of the
    plain waves' own spread (1.11).
  - **No jump at a moved edge:** one swell of 0.3 tilts each two-unit square of a sheet its own way. Its triangles are
    rasterised on the CPU from `gerstnerAt`. The step across a boundary is read from two pixels either side, as what is
    left of the change once the run of the four is taken off (two thirds of a jump; nought for a smooth texture). It is
    0.69 levels across 2,466 edges against 0.48 inside triangles, within a level.
  - **Beside a thing standing in the water:** beside each pond post's waterline, the worst three-by-three patch moves
    2.61 and 3.45 levels, under six. Beside a red bobber in the lake, its red risen over its green is 5.33 levels at the
    worst patch. The same band in open water a unit and a half either side reads 3.56 and 5.22, and the bobber's is held
    within three of the redder.
  - **Shimmer:** far-water pixels moving more than four levels between frames, over sixty frames stepped at 1/60 s, as
    the experiment counted. Plain reads 1,093, the experiment's figure exactly, and the layer 1,174, 1.074 times. The
    brief asked for 1.3. The layer with its fade taken out (the fault the experiment checked its count against) reads
    1.263, and with its cell read at half what is asked 1.180, so 1.3 would let both through. The bound is 1.15.
- `cleargolden.gpu.test.ts` is unchanged and passes, compared and not skipped, on `apple/metal-3`.
- Each new test was seen failing with its bug put back:
  - the layer left out of the normal;
  - the layer read at a fixed scale in the world;
  - the footprint taken from the moved triangles (1.77 against 0.50);
  - the bend's guard taken out (35 levels at the white post, 69 redder at the bobber);
  - the mirror's guard taken out (16 redder);
  - the fade taken out, and the cell halved (shimmer);
  - the fade left where the twelve have it, variant A (0.75 of the plain waves near);
  - a cell of eight packed where none was named;
  - the layer packed on regardless (the golden);
  - and in the unit tests: no least cell, packing whatever the amount, the default turned by the units, the fade's
    start said differently, another first guess, and the amount not held to nought.

## What it costs

Two more `waterSlope` sums a pixel, the footprint's four plane hits, and with the layer on one more depth read for the
bend and two for the mirror. It was measured with Draw Things holding the GPU, as a difference against plain timed in
turn, nine rounds a run, the median of five runs of thirty frames each time.

- **The pond at 1280 by 800, water over the whole frame at one sample:** +0.253 ms in both of two runs. Each round
  read from 0.243 to 0.262, and plain drifted no more than 0.02 ms within a round.
- **The lake from the shore, toon at four samples with the scene mirrored:** +0.180 ms in the quiet run (0.175 to
  0.190). In the other it was +0.203, with plain drifting by up to 0.72 ms within a round.
- **`standard clear detail` on the perf gate,** over five runs: 0.02 to 0.24 ms over `standard clear` (one run at
  2.2, when `standard` itself read 2.33 against its 0.60). Every run of the gate failed on scenes this change does not
  touch, by 16 to 300%. Its baseline is not written: it is to be written on a quiet machine, by editing in its one key.

## Not done, and not known

- **The game.** Nothing here was drawn in ooerfish. Its lake at 1280 by 800, over its slate bed, with its banks, fish
  and bobber and in motion, is for the take-in's films. They should look again at the bobber's waterline.
- **The bobber here is a post** a fifth of a unit across standing from the bed, not the game's bobber floating on
  the swells.
- **The camera moving.** The dolly (the blend re-forming as the scale moves) was measured in the experiment, on its
  faceted scale, and not again here.
- **Seams between levels** were not looked for again, since the blend is the experiment's. The swells' facets are gone
  from the scale, which the experiment could not settle in motion.
- **The guards are all or nothing.** A pixel can change between the layer's landing and the fine waves' from one frame
  to the next. The shimmer was counted on the far open water, clear of the lake's rock, so a thing standing in open
  water was not filmed in motion.
- **One machine:** `apple/metal-3` in headless Chrome. No phone, no other GPU, no Direct3D, and no Firefox for the new
  depth binding.
- **No rung.** At a quarter of a millisecond for full-frame water, a game that cannot afford it sets the cell to nought.
- **The units, in a GPU test.** The footprint is in world units from the camera's own matrices, and the cell is pixels,
  so no unit should matter. The unit tests hold the resolving; no frame was drawn in millimetres.
