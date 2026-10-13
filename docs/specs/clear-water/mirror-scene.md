# Clear water mirroring the scene itself

Built on 13 October 2026 on `mirror` from v0.38.0 (`f9f7b2c`), as part 4 of the crystal-clear water plan
(`ooerfish/docs/crystal.md`), which holds the aim; this note says what was built and where it departs from the
plan's box. It stops before the tag, which is the user's. The experiments that said to build it are in the
`crystal` worktree's `crystal-experiments.md` (E4, and "On the real lake").

## What it is

Three more options of `look.clear`, all off unless asked, so a water that asks for none of them draws as 0.38.0's
did, to the pixel:

- `mirrorScene` (false): the water shows the scene it reflects, and not only the sky.
- `mirrorPlane` (0): the height of the water's surface, in world units, which the scene is turned over in and
  clipped at. It is a height the game names, so `mmPerUnit` does not turn it.
- `mirrorDistort` (0.03): how far the swells' normal shifts the reflection, as a share of the screen for a normal
  tilted all the way over. Not a length either. Untuned: the figure is a guess, to be chosen on the lake.

## As built

- **The reflection is the camera's own view with the world turned over in the plane,** and not a second camera. The
  mirror pass uses a frame uniform of its own (`mirrorFrameBuffer`, with a scene bind group over it) whose view and
  projection is the camera's matrix times the reflection `z -> 2h - z`, whose eye is the eye turned over, and whose
  occlusion flag is nought, the occlusion being the camera's. The world positions the shader lights and clips by are
  the real ones, so the shadow maps are read as they stand and nothing is shadowed twice. The prototype's second camera
  looked from under the water with the up vector kept, which put the frame upside down and needed a flip; this frame is
  the right way up, and the water reads it at its own pixel. Handedness turns over with the reflection, which a build
  with no culling does not mind.
- **The clip is a build flag of the scene shader,** `SceneVariant.mirrored`: a `MIRRORED` constant and one line, put
  at the top of whatever body the fragment stage has (the carded build gives it another header), that throws away
  what is under the plane, read from the frame uniform's second spare, which is free. It is in no other build, held by
  `shaders.test.ts` and by the old text hashes, which did not move. The prototype's oblique near plane was left out:
  a discard is exact on a triangle that crosses the plane, and costs one compare.
- **A build for each kind of group and each rung it is drawn on,** made when first asked for: the mask is shadows,
  points, toon, patterned, flowing, textured, carded and painted (at most 256, each made once), and a group whose
  build is not in yet is left out until it is. `prepare()` waits for them, as it does for the others. A painted group
  in a look that is not toon is drawn plain, as it is in the scene pass. The group's buffers are set by the same
  `drawGroup` the scene pass uses, so a kind added to one is added to both.
- **The frame is half the camera's, in half floats, with a depth of its own, cleared to an alpha of nought,** and
  the groups write one: the frame is premultiplied by where something was drawn, with no key colour and no clamp
  at one, so it is true HDR. It is made by the first frame that needs it and again on a resize, and destroyed when the
  option is turned off or the renderer is disposed. A one-pixel frame draws.
- **The soft edge is the sampler's.** The clear pass reads the frame with the linear, clamped sampler it reads the
  shore field with. Premultiplied, filtering the frame filters the alpha with the colour, so where scenery meets sky
  the edge is a gradient over about two screen pixels (a texel of the half-size frame), and `sky * (1 - alpha) +
  scenery` composes it with no fringe. A four-tap blur of the alpha was left out: it costs a read a pixel on every
  water pixel and the single filtered read measured as soft as the test asks (the edge of the post's reflection
  crosses its half way over three pixels, none of them taking more than 60% of it).
- **The distortion is the swells' normal projected on the screen.** `n0.xy`, the Gerstner normal of the vertex stage
  and not the fine waves', goes through the camera's own matrix as a direction, times a half and `mirrorDistort`, and
  shifts the read. The prototype added the world's x and y straight to the screen's u and v, which is right only for
  a camera looking along +y. The shift is held to the sums by a test, independent of the shader: the measured shift of
  the reflection's edge is 2.31 pixels against 2.24 from `gerstnerAt` and the projection, and twice the distortion
  gives twice the shift.
- **The tint and the strength apply to the mix.** The scene's reflection is put in place of the sky before
  `mirrorTint` and `mirror`, so both reach both, and a sick lake's reflected cliff is as green as its reflected sky.
- **Nothing is drawn into it** but the opaque groups: not the sky (alpha nought says "the sky as today"), the grass,
  the particles and the effect layers, nor the clear water. Cards are drawn through the carded build, cut by their
  alpha as at one sample. The mirror is drawn each frame, static groups too, whatever the frame mode, since the camera moves.
- **No rung.** The plan's box names none, so the economy's ladder cannot turn it off yet. A game that wants one sets
  `look.clear.mirrorScene` itself.

## What it costs

`apple/metal-3`, M4 Pro, 1280x800, `standard clear mirror` against `standard clear` in the same run, with another app
(an image generator) on the GPU for all of it, so every figure read 10 to 25% over its baseline, the parent commit's
too (`standard` 0.63 to 0.72 in runs of the parent against 0.60):

| Run | standard clear | standard clear mirror | difference |
| --- | --- | --- | --- |
| 1 | 0.82 | 0.85 | +0.03 |
| 2 (alternating with the parent) | 0.83 | 0.84 | +0.01 |
| 3 (alternating) | 0.80 | 0.87 | +0.07 |
| 4 (alternating) | 0.82 | 0.83 | +0.01 |
| 5 | 0.87 | 0.83 | -0.04 |
| 6 | 0.79 | 0.81 | +0.02 |
| 7 | 0.76 | 0.88 | +0.12 |
| 8 | 0.74 | 0.84 | +0.10 |

The median is +0.03 ms and the worst +0.12, under the budget of 0.3. The standard scene is four hundred boxes, so
this is the cost of drawing four hundred boxes at a quarter of the pixels and reading the result, and it says what
the pass itself costs, not what a lake with a wood round it costs: the crystal prototype measured 0.15 ms on
ooerfish's own standard scene, and the real figure there is part 6's to give.

## What is held, and by what

`clear.test.ts` (the defaults, the packing, the refusals), `shaders.test.ts` (the build and its clip, and that no
other build has a word of it), and `clearscene.gpu.test.ts`: the white post standing in the water is mirrored in the
pixels beneath it and in no other (the water beside it is the sky's, to the bit, which is the clip's proof: the bed
under the water, a flat of mud just below the surface, would fill the mirror unclipped), the plane puts the
reflection's rows where it should and clips where it should, the distortion, the tint and the strength, the soft
edge, no pass and no texture while off (counted), one pass a frame and a half-size frame made once, the frame
uniform's own words read back, every kind of group on two rungs, each frame mode and look, no water in the frame,
and dispose. `cleargolden.gpu.test.ts` is unchanged and passes. Each GPU test was seen to fail with its bug put back.

## Not done, and not known

- **The look on the real lake.** Nothing here has been drawn on ooerfish's lake, with its trees and cabin and a
  shore field. Whether the default `mirrorDistort` is right, and whether `mirrorPlane` wants a figure other than the
  water's height to hide a seam at the shore, are part 6's to see.
- **A rung for it,** if the standard scene's frame budget on a slower machine needs one.
- **A lens shift or an off-axis camera** is carried by the camera's own matrix, and is not tested.
