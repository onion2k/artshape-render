# Clear water's sparkles drifting

Built on 14 October 2026 on `sparkle-unpinned` from v0.41.1 (`6e26565`), as part 14 of the crystal-clear water plan
(`ooerfish/docs/crystal.md`), which holds the aim. This note says what was found, what was sheeted, what the user chose,
and what was built and why. It stops before the release, which is the user's.

## The fault

Each of the clear water's sparkles is one of a lattice of cells over the fine waves (`sparkleStar` in `clear.ts`): the
cell's jittered point, lit where the fine waves at that point mirror the glint ahead of the camera, drawn as a soft
disc round the point's place on the screen. The point is fixed in the world, so the waves at it come round to face the
glint every few seconds and the same star lights in the same place again: ooerfish's films of 14 October (part 12b)
saw a star near the camera return ten times in five seconds at a cut of 0.45, three at 0.9 and two at 0.98, and no cut
under one stops it. The cut only makes the stars fewer and smaller.

## What was sheeted

Two ways to put it right were built as options, both off by default, and filmed on the package's lake
(`clearlake.ts`, the lake shore view, 576 pixels square, thirty frames a second for five seconds, every frame kept):

- **A lattice that drifts with the water:** the whole lattice carried by a velocity, so a star's point moves on and the
  glint that comes round at it comes round somewhere else.
- **A cell that rests once lit:** a cell may shine only in a window of its own cycle, its star swelling to the window's
  middle and fading to its end, a rest long between windows. A shader keeps no history, so the rest was a phase per
  cell and not a memory of having shone.

The stars were tracked from frame to frame (a spot within four pixels of where one was is that one; one seen again
after 0.4 seconds dark has returned in its place):

| candidate                          | lit pixels a frame | stars | places lit again | returns | stars lit over a second |
| ---------------------------------- | -----------------: | ----: | ---------------: | ------: | ----------------------: |
| pinned, as v0.41.1                 |                115 |    50 |               16 |      19 |                      14 |
| drift 0.5 a second along the swell |                221 |    99 |                3 |       3 |                       2 |
| drift 1.5                          |                173 |   103 |                1 |       1 |                       1 |
| rest 3 s, shine 1 s, sparkles 1    |                104 |    39 |                0 |       0 |                       0 |
| rest 6 s, shine 1.5 s, sparkles 1  |                 78 |    35 |                3 |       3 |                       0 |

The resting lattice's three returns were 0.4 seconds apart, within one shine window, not after a rest. The films are
under `/tmp/crystal/sparkle-package/` (an MP4, a GIF, a zoomed GIF of the water band and a strip for each).

**The user chose the drift, at half a unit a second (film B).** The rest was taken out.

## What it is

One more option of `look.clear`. A water that does not name it draws as v0.41.1 did, to the pixel:

- `sparkleDrift` (`[0, 0]`): how the sparkles' lattice moves, in world units a second of the renderer's clock, as a
  pair. It is a velocity a game names in its own units, so no unit turns it; the default is nought, which no unit
  turns either. What is not a pair of finite numbers is refused and the default kept.

A drift carries the whole lattice, every level of it, so a star moves across the screen as the water does and the glint
that comes round again at its point comes round somewhere else. Nothing else moves: the fine waves, the glitter and the
detail layer are read where they were.

## As built

- **The lattice in a moving frame.** `sparkleStar` takes the drift times the clock off the world coordinate before
  the cell is found, and puts it back on the cell's point: `at = floor((world − drift) / cell)` and
  `centre = (at + jitter) × cell + drift`. The fine waves at the point are read where the point now is. With a drift
  of nought a coordinate less nought plus nought is the coordinate exactly, so there is no branch and the pinned
  lattice is drawn to the pixel.
- **One vec4 grew.** The drift is packed by `driftUniform` into a vec4 of its own after the foam's options
  (`CLEAR_DRIFT_FLOATS`, the frame now 108 floats from 104), its last two words nought and free, so no earlier offset
  moved. The resting candidate's two words were there and were taken out with it.
- **Density.** A drifting lattice shows about twice the stars the pinned one does (99 against 50 on the lake, 221 lit
  pixels a frame against 115): a pinned point can sit for seconds where the waves never quite face the glint, and a
  moving one is carried through. A game that takes the drift will want `sparkles` lower, which is the take-in's to
  choose from its own films.

## Held by

- `clear.test.ts`: the default and its packing as noughts last in the frame; a velocity packed where the shader reads
  it with its spare words nought; refusals (a number that is not one, a pair that is not one, a copy taken of the
  look's own array); nothing turned by the world's units; the frame's float count.
- `cleardrift.gpu.test.ts`, on `apple/metal-3`:
  - a drift of nought draws as the pinned lattice, to the pixel (and `cleargolden.gpu.test.ts` is unchanged);
  - on a flat sheet toward a low sun, the still plane's point under a pixel, projected back through the renderer's own
    matrices, lands within half a pixel, so the projection of a drift is to be trusted;
  - each star seen a frame apart (a thirtieth of a second, three moments of the waves) moves 0.13 pixels with the
    lattice pinned and 3.17 pixels with it drifting at (3, 2) a second, 0.27 pixels off where the drift's projection
    puts it;
  - on the lake filmed five seconds, the near water's stars return in their places pinned (6 returns at 21 stars, 19
    anywhere) and drifting at half a unit a second at most half as often there and under a third anywhere (2 and 3,
    which are different stars lighting by chance within the tracker's radius: one was 1.76 seconds after the last, when
    the drift had carried the point most of a unit away).
- `perf:gpu` has `standard clear drift`, the finish's scene with the lattice drifting.
- Each bug put back was seen to fail a test: the drift taken off the cell but not put back on its point (the stars do
  not move: the sheet and the lake both fail); the drift put on the point but not taken off the cell (a star moves
  only until its point leaves its cell: the sheet fails, and the lake's count still falls, so the sheet is the test of
  the point moving); the drift packed as nought whatever is named (both fail); the frame's count left at 104 (five
  unit tests fail).

## What it costs

A vec2 multiply and two adds a star, twice a pixel (the two lattice levels), inside the sparkles' branch only.
`standard clear drift` against `standard clear finish`, the scene it adds the drift to, in the same runs of the perf
gate: 1.02 against 1.04 ms, then 0.97 against 0.97, on a machine at other work (every scene read 33 to 50% over its
baseline that evening, the untouched ones too, so the gate was red on scenes this change does not reach). So the drift
costs nothing the gate can see. On a quiet machine, later the same evening, the gate was green and the drift read 0.73
and 0.74 ms against the finish's 0.73 and 0.74 (`standard` 0.62 against 0.60), so its baseline key was written in by
hand as 0.73.

## Not done, and not known

- **The game.** Nothing here was drawn in ooerfish; its take-in is a pin bump of its own, with `sparkleDrift` and
  `sparkles` chosen from its films, and `sparkleCut` reconsidered from 0.45.
- **Which way the water goes** is the game's to say: the package has no notion of a current. The films drifted along
  the lake's main swell.
- **A moving camera** was not filmed: the lattice drifts in the world, so a camera that moves sees it move with the
  world, as the waves do.
- **One machine:** `apple/metal-3` in headless Chrome.
