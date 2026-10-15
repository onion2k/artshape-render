# Clear water's sun lane, caustic glow and foam grain

Built on 15 October 2026 on `crystal-2-build` from v0.42.0 (`538ac30`), as part 1 of round two of the crystal-clear
water plan (`ooerfish/docs/crystal-2.md`), which holds the aim. This note says what was chosen, what was built and why,
and what held it. It stops before the release, which is the user's. The sheets the choice was made from are in
`crystal-2-experiments.md` beside it, from the worktree `artshape-render-crystal2` (branch `crystal-2`), which is
reference only and was not built on.

## What was chosen

Of the eight options part 0 sheeted, the user chose four, with the figures they were chosen at: the sun's lane at 0.6
and a power of 60, the caustics' glow between 0.3 and 0.6 with the cell at twice the default (the cell is
`causticScale`, which already existed), and the foam's grain at 0.3. The glitter aimed at the sun, its grain, the foam's
fray and the caustics' fringe were dropped and are not built here. The saturated palette needs no package change.

## What it is

Four more options of `look.clear`. A water that does not name them draws as v0.42.0 did, to the pixel:

- `sunLane` (0 to 1, default 0) and `sunLaneWidth` (default 0, the lobe's power): a specular lobe toward the true sun,
  `pow(max(dot(r, sun), 0), width)`, with `r` the mirror direction off the surface as the water is drawn, so the detail
  layer's slope is in it and the lane breaks into the fine waves. It is the sun's colour times the strength, drawn in the
  sun only (the sun map's read, as the sparkles', and not at all where there are no shadows to read) and faded by
  `max(sunDir.z, 0)`, so a sun below the horizon draws none. `frame.sunDir` is not normalised and is here. A lane is
  drawn only with a strength and a power both over nought, as the detail layer is: a power of nought is one everywhere,
  and a strength named alone would wash the water, so a lane missing either is packed as nought and not drawn. 60 is a
  lane, 15 a wash and 200 sparse flecks.
- `causticGlow` (0 to 1, default 0): the sun's own light added along the caustic lines, beside the old term and not in
  its place, `line * strength * glow * CAUSTIC_SUN * sunColour * exposure`. The old term scales the bed's own colour,
  so over a dark bed it shows nothing; this gives a line a bright core on any bed. It is the caustics' and rides their
  strength, their fade with the depth and the knee, the sun's shadow and the sun's height, so it is moot with the
  caustics at nought and draws nothing under a sun below the horizon.
- `foamGrain` (0 to 1, default 0): the foam's white multiplied by a finer noise (`flowNoise` at 6.1 times the lines'
  own scale), a hole being where it falls below the grain's share of 0.6, eased over 0.08. More grain is more holes: 0.3
  breaks the line into dashes, 0.6 into froth. It holes the shore field's lines (the line, the second line and the
  depth band round what the field does not know) and the plain depth band's white core where there is no field, on the
  lines' own scale in both; the rim, the edge's colour and the water outside the foam are not touched.

All four are clamped as the options before them are: a share is held to 0 to 1, a power to at least nought, and what is
not a finite number (a string, `null`, `NaN`, an infinity) is refused and the default kept. No unit turns any of them:
a power and two shares are not lengths.

## As built

- **One vec4 grew.** The four are packed by `extraUniform` into a vec4 of their own after the drift
  (`CLEAR_EXTRA_FLOATS`, the frame now 112 floats from 108), so no earlier offset moved. `packClearFrame` now counts each
  block back from the frame's end by a name, so the next block added does not touch the sums of those before it. The
  struct's field is `extra`: x the lane's strength, y its power, z the glow, w the grain.
- **The old expressions are left as they were.** The glow, the lane and the grain are each added behind a test of their
  own word of the uniform, nought by default, so the shader a water that names none runs is the old arithmetic and the
  old pixel. They are branches on a uniform, which every pixel of a draw takes the same way.
- **The sun's shadow, said once for the lane.** `sunReaches` is the sun map's read for a point of the world (all of it
  where there is no map), used by the lane. The caustics' and the sparkles' own copies of the same read are left as they
  were, so the text the old pixels came from did not move.
- **The grain's two homes.** `foamHoles` is the noise; the shore field's branch multiplies the froth by it and the plain
  branch multiplies the core. Without the plain branch a water with no shore field would have a grain that does nothing,
  and the golden, whose water has no field, could not have seen it.
- **Ported from the sheet, not copied.** The sheet's prototype (`artshape-render-crystal2`, `src/game/clear.ts`) had
  these as eight options in two vec4s, with the glitter's, the fray's and the fringe's branches among them; only the
  four chosen were written again here, tests first. The prototype's lane read the mirror direction `rd` as this does.

## Held by

- `clear.test.ts`: the defaults and their packing as noughts; the four packed where the shader reads them, after the
  drift, with the frame at 112 and the drift's block at 104; a lane packed as nought without both its strength and its
  power, and the glow and the grain not waiting on it; the clamps; the refusals (a number that is not one, a string,
  `null`, a bad one among good ones spoiling only itself); nothing turned by the world's units; the shader's struct
  having the vec4 after the drift. The older tests' offsets are counted back from the drift's place and not from the
  frame's end, which they were, and say why.
- `clearcrystal2.gpu.test.ts`, on `apple/metal-3`:
  - the lane, on a flat sheet with the camera looking toward a sun 20 degrees up: the brightest pixel is in the column
    under the sun and within 3 rows of the row the mirror puts the sun on (a height of four over the tangent of the sun's
    height, projected through the renderer's own matrices), the lane falls to under half its peak 60 rows nearer and
    two thirds 30 rows further, and no pixel is darkened; nothing is drawn with the sun behind the camera, below the
    horizon, or with the lane missing its strength or its power, each against a frame of the same sun with the lane that
    is shown to be drawn; nothing is drawn in a slab's shadow (8,606 lit at its middle, 0 in the shadow); a power of 15
    lights more of the sheet than 60 and 60 more than 200, and twice the strength gives more light; and on a swelling
    water with the detail layer the steepest step along the lane's row is 5.4 levels against 1.6 flat;
  - the glow, over a black bed under clear water: the old term's spread is 0.00 and the glow's 17.2 at a half and 23.7
    at one, with a core 40 levels over the bed's mean, no pixel darker with it, nought named is nought unnamed, none
    with the caustics at nought or under a sun below the horizon (each against a frame where it is drawn), and over sand
    the old term is kept beside it (the sand is lit 3.5 levels more on average, and 1.3 where the glow stands in the
    old term's place);
  - the grain, with a shore field (4,302 white pixels in the line, 3,682 at 0.3, 1,105 at 1) and without one (72,721, the
    same at 0.3, 46,280 at 1): the line is holed, some of it is left, and the open water east of it is the same pixels;
    nought named is nought unnamed.
- `cleargolden.gpu.test.ts` is unchanged and green with all four at their defaults, and was seen to fail with each forced
  on in turn inside the renderer by changing `CLEAR_DEFAULTS_MM`: the glow at 0.6 (plain `ea6e2856` against the record's
  `1753a489`), the grain at 1 (`45c20c5a`), and the lane at a strength of 1 and a power of 1 (`f283fe6d`). **The lane at
  0.6 and 60 does not fail it:** the golden's sun is behind its camera (`[0.3, -0.4, 0.86]`, the camera at the south
  looking north), so its mirror direction is 74 degrees off the sun's and a lobe of power 60 is nought to the last bit.
  The golden cannot be given a sun that shows it, since its hashes are of the code at v0.29.0 and its scene is fixed; so
  it was shown to see a lane by forcing the broadest one (power 1), and a lane at the chosen figures is held by the GPU
  test above.
- `perf:gpu` has `standard clear lane`, `standard clear caustic glow` and `standard clear grain`, each the finish's
  scene with the option at the figures chosen.
- Each bug put back was seen to fail a test (the GPU tests and the unit tests together, one at a time):

  | bug put back | what failed |
  | --- | --- |
  | the lane's fade by the sun's height taken out | the sun-below-horizon test, and the power test |
  | the lane's shadow read taken out | the shadow test |
  | the lobe toward the view and not the mirror direction | five of the five lane tests |
  | the detail layer's slope left out of the lane | the waves test |
  | a lane packed whatever its power | the packing test and the nothing-drawn test |
  | the lane's strength ignored | the strength test and the waves test |
  | the glow over the whole bed and not the lines | the glow's spread test and the sand test |
  | the glow ignoring the sun's height | the glow's sun-below-horizon test |
  | the glow in place of the old term | the sand test (its gain measured, after the first version of the test let this one through) |
  | the glow, or the grain, packed as nought | the packing tests and the GPU test of each |
  | the grain's holes inverted | both grain tests |
  | the grain darkening the water outside the foam | the shore-field grain test (the open water moved) |
  | the grain left out of the depth band, or out of the field's lines | the grain test of each |
  | the frame's count left out | eleven unit tests and every GPU test of the three |

## What it costs

A dot, a pow and the sun map's read a pixel for the lane; a multiply-add in the caustics' branch for the glow; a noise
and a smoothstep on the foam's pixels for the grain; each behind a test of its own uniform word. `standard clear
lane`, `standard clear caustic glow` and `standard clear grain` against `standard clear finish`, the scene each adds
its option to, in the same runs of the perf gate (the difference in milliseconds, then the three figures):

| run | lane | glow | grain | finish |
| --- | ---: | ---: | ---: | ---: |
| 1 | -0.023 | -0.033 | -0.017 | 0.78 |
| 2 | +0.043 | +0.003 | -0.020 | 0.82 |
| 3 | -0.020 | -0.013 | -0.020 | 0.82 |

So none costs anything the gate can see: the differences are the wobble of the run, which is a few hundredths of a
millisecond either way. The gate was red in all three of those runs, on scenes this change does not reach, so the
machine was at other work. Later the same evening, with the load at four, two more runs were green on every untouched
scene (`standard` 0.63 and 0.62 against 0.60, `standard clear finish` 0.74 against 0.73) and read each of the three new
scenes at 0.74 ms, the finish's own figure, in both. The three keys were written in by hand at 0.74, and a third run
held them (lane 0.76, glow 0.75, grain 0.75, finish 0.76 against 0.73).

## Not done, and not known

- **The game.** Nothing here was drawn in ooerfish; its take-in is a pin bump of its own, with `sunLane` and
  `sunLaneWidth`, `causticGlow` with `causticScale` at twice the default, and `foamGrain`, from its own films. The lane
  shows only where the camera looks toward the sun: the game's day sun stands behind the angler on the south shore, so
  where the sun stands is the user's to pick (ooerfish `docs/crystal-2.md`, part 3).
- **A lane's look was seen on the sheets, not re-seen here.** The GPU tests hold where and how much it draws; the
  pictures it was chosen from are the sheets of part 0, and this build's frames are written by `VITE_FRAME_DIR` as
  `crystal2 ...png` for anyone who wants to look.
- **The glow's `exposure` factor** is the prototype's, so the added light is in the units of the frame the pass writes;
  it was not checked against a game with a different exposure than the tests' 0.5.
- **The grain on the plain depth band** was not on the sheets (the sheets' lake has a shore field), and is the same noise
  on the lines' scale; it is there so that the option does something in a water with no field and the golden can see it.
- **The package's `CLAUDE.md`** is not updated for the options (its model-feature entry, the test and file counts, and
  the gates table); that goes with the release.
- **One machine:** `apple/metal-3` in headless Chrome.
