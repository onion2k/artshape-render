# The crystal-clear water, round two: what the experiments found

Part 0 of ooerfish's `docs/crystal-2.md`, done on 15 October 2026 in the worktree `artshape-render-crystal2` (branch
`crystal-2` from v0.42.0, `538ac30`). Nothing is committed. Every figure is from one machine, `apple/metal-3` in
headless Chrome, and every cost from a run of the lab or of `perf:gpu`. The user's choices go at the end, under
**Chosen**, once they are made.

## The short of it

| Option | What the pictures say | Recommendation |
| --- | --- | --- |
| E1 glitter at the sun (`glitterSun`, `glitterGrain`) | The renderer's own glitter, free, is a few big chunky white bars from overhead and nothing at all from the shore. Aimed at the sun the flecks lie where the sun's path is and nowhere else: a narrow, broken column of small flecks toward a dusk sun (and a few blobs toward a day sun from high up). The grain breaks them smaller and unequal, which reads as flecks and not bars. It is a thin line of sparkle, not a field of thousands. | Build `glitterSun` 1 with `glitterGrain` 0.6 only if the lane (E2) is not taken: at `glitter` 0.6 it is a fine addition toward a low sun, and the stars live beside it. If E2 is taken, take E2 and leave this. |
| E2 the sun's lane (`sunLane`, `sunLaneWidth`) | The strongest picture of the round. At dusk, looking toward the sun, a broad pink-gold path crawls across the water, broken into the fine waves, from the near bank outward. At 0.3 it is a hint, at 0.6 a lane, at 1 it starts to wash the water out. Width 15 is a glow over most of the view, 200 is a thin, hard, hardly-there path. By day, from the shore or from overhead, it is not seen (the sun is behind or too high), which is right. | Build it: `sunLane` 0.6 at width 60 (width 30 to 40 is worth a look in the game's own view, since the lake's shore view never faces the dusk sun). |
| E3 caustics on the sand (`causticScale`, `causticGlow`, `causticFringe`) | Larger cells (x2, x3) read as clearer, broader nets and less busy; x3 is the best of them. `causticGlow` puts a bright core on the line: 0.3 is a gentle lift, 0.6 clear white webs on the sand, 1 too much (white webs over the whole bed). The fringe at 0.25 gives the lines a faint orange edge on the sand, which reads as a chromatic shimmer and not a fault at this size. | Build `causticGlow` 0.3 to 0.6 with the cell at twice. Fringe: optional, 0.25 is safe and cheap here (it costs no extra Voronoi). |
| E4 the colour sweep (no option) | Turquoise is a pale, minty shallow that reads as tropical but washes out the deep blue and the reflection; saturated is a richer, darker blue that is the nearest to the reference's deep sea. The sick lake is olive in all three and the palettes change it little (the sick colours are mixed in whole). | Saturated for the deep, turquoise's shallows only if a tropical lake is wanted; a middle palette (shallow between the two) is worth a try in the game. No package change. |
| E5 the foam's edge and the wet sand (`foamFray`, `foamGrain`, and a mock) | `foamFray` 0.5 and 1 are close to the old line (the old wobble is 1.1, so 1 is the default to the eye); 2 and 4 only make long, lazy bulges, not a frayed edge. `foamGrain` is what frays: at 0.3 the line breaks into short dashes with the edge's cyan showing through, at 0.6 it is holed like froth, a little busy. The wet-strip mock (a dry beach out to 1.2 units, its first 0.4 darkened and saturated) reads weakly: from the shore the darker band is a thin tan stripe, from overhead it is a visible ring only at 0.4. | Build `foamGrain` 0.3 (with the fray left at its default). The wet strip is worth building in the game only with a beach wide enough to show it; this lab's bank is too steep and too grassy to judge it. |

## Where it was done, and how

- **The lab** is `src/game/__tests__/crystal2.gpu.test.ts`. It draws each picture at 512 by 320, four samples, and
  composes the sheets `/tmp/crystal-2/sheets/E1.png` to `E5.png`, the plain picture first and then the strengths,
  one row a scene. It holds nothing but that every frame drew without a validation error and the plain picture is
  not blank. Run it with
  `VITE_FRAME_DIR=/tmp/crystal-2 npx vitest run --config vitest.browser.config.ts src/game/__tests__/crystal2.gpu.test.ts`
  (about 7 s); without the variable it says so and draws nothing.
- **The scenes** are `clearlake.ts`'s lake. `LAKE_CLEAR` was brought up to ooerfish's `CLEAR` and `CLEAR_WAVES` at
  `3c98de7` (knee 0.4, caustic line 0.08, strength 0.36, sparkles 0.15 drifting along the 1.2 rad swell at half a unit
  a second, the detail layer at 8 px and 1, the third swell from -0.5 rad), and the water's flow to 3.5 cells and 0.2.
  The old figures, which `cleardetail` and `cleardrift` were calibrated on, are kept as `LAKE_CLEAR_ROUND_ONE` with
  `ROUND_ONE_FLOW`, and those two tests were pointed at them, so no instrument moved. `LAKE_DUSK` is ooerfish's dusk
  (the sun (-0.9, 0.2, 0.3) in `dusklight`, exposure 0.8, fill 0.65, `duskZenith` and `duskHorizon`, copied from its
  `src/look.ts` and `src/palette.ts`), with its sky baked as the game bakes it. The sparkles' brightness is scaled by
  the time's glitter (1 by day, 0.5 at dusk), as the game does.
- **Two views, as asked: the shore and overhead.** **Added, and why:** a third row, *sunward*, for the glitter and the
  lane. The lane lies in the sun's own direction and the shore view looks north with the dusk sun in the west, so
  neither asked-for view could show it. It is the shore view turned to face the sun (closer, at polar 1.2, and by day
  from 0.75 so as not to stand inside the far bank's tree).
- **Also added:** a fourth foam column (`foamFray` 4) because the plan's 0.5, 1 and 2 hardly differ from plain; a
  *beach alone* control beside the wet-strip mock; and the sick lake under each palette in E4.
- **Films** (90 frames of a thirtieth of a second, in `/tmp/crystal-2/film/<name>/`: `f000.png` to `f089.png`,
  `strip.png` of every ninth frame, `film.mp4`): `plain dusk sunward`, `E1 dusk sunward`, `E1 day sunward` (glitter 0.6,
  sun 1, grain 0.6) and `E2 dusk sunward` (lane 0.6, width 60).

### What was changed in the package

`src/game/clear.ts`: eight options, all nought by default, packed as two vec4s (`extraA`, `extraB`; `extraUniform`,
`CLEAR_EXTRA_FLOATS` 8) past the end of the frame, which is now 116 floats (it was 108). Each is a branch on its own
field with the old expression kept (`var` set to the old sum, overridden only when asked):

- `glitterSun`: `ahead = normalize(mix(ahead, normalize(frame.sunDir), glitterSun))`, and, in that branch only, no
  flecks from a sun below the horizon (added; the plan did not say). The sun is normalised because `frame.sunDir` is not.
- `glitterGrain`: `cut = GLITTER_CUT * (1 + (flowHash(cell) - 0.5) * grain)`, the cell one of the fine waves'.
- `sunLane`, `sunLaneWidth`: `pow(max(dot(rd, sunDir), 0), width) * sunColour * lane`, `rd` being the reflection off the
  surface normal with the detail layer's slope in it (`n`), gated by the shadow map as the sparkles are, faded by
  `max(sunDir.z, 0)`, times the exposure.
- `causticGlow`, `causticFringe`: the glow is `line * strength * glow * CAUSTIC_SUN * sunColour * exposure` added beside the
  old term (the exposure is added to the plan's sum, since `below` is the exposed frame). The fringe offsets the line's
  distance per channel by -, 0 and + a share of the line's width, so it costs no extra Voronoi.
- `foamFray`: the wobble as a share of the width, nought being the old 1.1.
- `foamGrain`: the line, rim excluded, multiplied by a smoothstep of `flowNoise(q * 6.1)` at a cut of 0.6 times the grain, a hole
  where the noise falls below it. **A reading of the plan's "thresholded at 1 − foamGrain":** that sentence has more grain
  meaning fewer holes if taken literally, so the cut here rises with the grain.

Tests: `clear.test.ts` holds the defaults, the order and clamps of the packing, the refusals, and the frame at 116 floats
(its comment says why: 108 with the drift last, two vec4s of experiments past it); its offsets, counted back from the
frame's end, moved by the experiments' eight floats. Not written test-first: the tests were written with the code,
so they were not seen failing before it.

## Costs, `perf:gpu`, `standard clear` against `standard clear finish`

Each of the four scenes is the finish's water with the option on, in the same run (glitter 0.6, sun 1, grain 0.6; lane
0.6 at 60; glow 0.6 with fringe 0.25; fray 1 with grain 0.6). Six runs on a machine that was not quiet (the baseline run
of `standard clear finish` read 0.79 ms against its baseline 0.73, and the scenes above it wobbled by about 0.1):

| Scene | Difference from finish, six runs (ms) |
| --- | --- |
| glitter | +0.107, -0.033, -0.083, +0.190, +0.003, -0.003 |
| lane | +0.063, +0.003, -0.107, +0.137, -0.007, -0.027 |
| caustic glow | +0.103, +0.067, -0.050, +0.133, -0.007, -0.033 |
| fray | +0.093, -0.057, -0.047, +0.010, -0.007, +0.017 |

None stands clear of the wobble: each is within ±0.2 ms of finish, scattered both sides of nought. The finish itself read
0.79 ms in the last run. The perf baseline was not written. "no baseline for this adapter" is printed for the new scenes.

## Checks

- The golden (`cleargolden.gpu.test.ts`): green before the first picture (at v0.42.0 untouched, then again with the
  shader changed and every option at its default), **red** once with `causticGlow: 0.5` forced on inside the renderer's
  `packClearFrame` call, green again with that taken out, and green a last time at the end (three runs after: all pass).
- `npm run typecheck && npm test`: green, 82 files and 1,336 tests (1,332 before).
- `npm run test:gpu`: 51 files passed, 424 tests passed, 13 skipped (the new lab's six, with the rest).

## Not verified

- The lab was not tried on another adapter, and the costs are on one.
- The golden is not shown to hold each *other* option (only `causticGlow` was forced); the other seven are held by the
  golden's pixels being unchanged with them at nought, not by their own forced failure.
- The wet strip is a mock on a bank not built for it; its look in the game is untested.

## Chosen

On 15 October 2026 the user chose the sun's lane at 0.6 and width 60, the caustic glow with the cell at twice the
default, the saturated palette, and the foam grain at 0.3. The glitter aimed at the sun, its grain, the fray, the
caustic fringe and the wet strip are dropped. The build is parts 1 to 3 of ooerfish's `docs/crystal-2.md`.
