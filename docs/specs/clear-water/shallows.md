# Clear water's shallows: the knee and the caustic line

Built on 14 October 2026 on `shallows` from v0.39.0 (`fa59adb`), as part 8 of the crystal-clear water plan
(`ooerfish/docs/crystal.md`), which holds the aim; this note says what was built and why. It stops before the
release, which is the user's. What the knee and the line did in the experiments is in `crystal-experiments.md`
(E1 and E2, and "On the real lake").

## What it is

Two more options of `look.clear`, both drawing as before at their defaults, so a water that names neither draws as
0.39.0's did, to the pixel:

- `clearKnee` (nought): a depth of path through the water, in world units, in which nothing is lost to the deep
  colour. The absorption is `exp2(-max(through - knee, 0) / lasts)`, so what lies under thinner water than the knee is
  seen in its own colour, and past it the light is lost as before, a knee further down. The caustics' fade takes the
  same knee off the depth over the bed, so they are at their brightest under it. It is a length, kept in millimetres
  in `CLEAR_DEFAULTS_MM` as the others are and turned by `mmPerUnit`; the default is nought, which no unit turns.
- `causticLine` (0.16): the width of a caustic line as a share of a cell, which was the constant `CAUSTIC_LINE`.
  Narrower is crisper. It is a share, not a length, so no unit turns it. It is held to at least a ten-thousandth,
  since a smoothstep from nought to nought is not defined in WGSL.

## As built

- **No struct grew.** Both ride in the two free words of `foamOpt`, the last vec4 of `ClearFrame`, packed by
  `foamUniform` as its third and fourth words. Before them those words were nought, and a water naming neither still
  writes nought there: the knee's default is nought, and the line at its default is written as nought, which the
  pass reads as `CAUSTIC_LINE`. A water that names the line at 0.16 is packed as one that does not.
- **The constant is said once.** `CAUSTIC_LINE` in the WGSL is built from `CLEAR_DEFAULTS_MM.causticLine`, so the
  default and the shader's fallback cannot drift apart.
- **Nought is the old sum, to the bit.** `max(through - 0, 0)` is `through` exactly, the path being a distance, and
  the line read from the uniform at 0.16 draws the same pixels as the constant did (seen: with the default packed as
  0.16 rather than nought, the golden still passed). The golden passed with both in, and failed when the knee's
  default was moved to five millimetres and when the line's was moved to 0.12, so it reaches both.
- **Not built:** the lift toward a shallow colour, the third caustic layer and the colour fringe. E1 found the lift
  tints a sand bed lilac under a deep blue; E2 found the third layer adds busyness rather than light and the fringe
  reads as a fault and costs half a millisecond. The plan dropped them.

## What is held, and by what

- `clear.test.ts`: the defaults (nought and 0.16), packed as noughts; a knee and a line packed as the shader reads
  them, in the frame's last four words, with the foam's vec4 still four floats; not-a-number and the infinities
  refused for the default, a negative knee held to nought, a line of nought or less held above it; the knee's
  millimetre default turned by `mmPerUnit` (a default of 500 mm put in for the length of the test, since nought shows
  nothing), and the line by none; a line named at its default packed as the nought it was.
- `clearshallows.gpu.test.ts`, on the pond of `clearscene.ts` seen from overhead, with no foam, glitter, bend or
  mirror, so a pixel whose light lost nothing is the opaque frame's own:
  - **The knee:** at a clarity of 0.7, the shallow box (its top a third of a unit under) is tinted by the water with
    no knee (59 levels from its dry colour) and is its own colour with a knee of 0.6 (within a level and a half of the
    dry frame), while the deep box, four units under, is still the deep colour: darker than the shallow box by more
    than 150 levels summed, far from its own colour and bluer than it is red.
  - **The knee on the caustics:** over a black deep colour and no mirror, a pixel is the bed times what is kept, with
    the caustics or without, so the share the caustics add is their own strength alone, whatever the absorption
    keeps. A unit under at a clarity of two, that share is 0.081 with no knee and 0.140 with a knee of a unit: 1.73
    times, against 1.78 from the fade's sum (`1 / 2^(-1/1.2)`), worked out apart from the shader.
  - **The line:** on sand a third of a unit under, cells four units across, the light the caustics add along three
    rows has a contrast (its deviation over its mean) of 1.28 at 0.16 and 2.00 at 0.08, and half the light in all
    (7.1 levels against 3.5), as a narrower line covering less of the bed should. A line named at 0.16 draws the
    unnamed frame to the pixel.
- `cleargolden.gpu.test.ts` is unchanged and passes, compared and not skipped, on `apple/metal-3`.
- Each new test was seen failing with its bug put back: the knee taken off the absorption, off the caustics' fade,
  and not packed; the line the constant always, and the default packed as itself; the knee's default not turned; a
  not-a-number let through; a line of no width let through.

## What it costs

A subtraction and a max in the absorption, the same in the caustics' fade, and a select for the line: nothing a frame
can show. `standard clear shallows` is the standard clear water with a knee of 0.8 (half its clarity), the line at
0.08 and the caustics at three times their default. It could not be measured on a quiet machine on the day it was
built: an image generator (Draw Things) and another agent's headless Chromium had the GPU, and the standard scene
read 0.65 to 2.13 ms across runs against its 0.60. In each of six runs of the change, the new scene read within the
run's wobble of `standard clear` (0.07 to 0.16 ms under it in three, 0.01 to 0.03 over it in three; a seventh, with
`standard clear` at 3.03 ms, read nothing), and the same scene
drawn by v0.39.0's shader, timed in turn with it, varied as widely. Its baseline is not written: it is to be written on a quiet machine,
by editing in its one key, with the parent's scenes inside their baselines on the same run.

## Not done, and not known

- **The look on the real lake.** Part 9 chooses the figures from a sheet on ooerfish's lake with its sand ring. Over
  ooerfish's dark slate bed the knee darkened the shallows in the experiments; that is the bed's, not the knee's.
- **The narrow line far off.** Under about 0.08 the line breaks into dashes into the distance at one sample a pixel.
  A line that widens with the pixel's footprint would cure it, and was not asked for.
- **The four samples and the toon look** are not tested for these two by name. They are sums in the clear pass,
  which draws at one sample in every mode, and the golden holds the default in plain, four samples and toon.
