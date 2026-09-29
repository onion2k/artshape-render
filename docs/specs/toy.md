# The toy finish on the game path: a spec

Agreed on 2026-09-29 and built on the tree after v0.21.0. What follows is
the spec as agreed, with the user's three decisions, and this note says
where the build departed from it and why.

## As built

- **Four parts, on in every toon look unless said nought:** `gloss`,
  `sheen`, `smoothShading` and `occlusionTint`. A toon look that says nought
  of all four draws the frame v0.21.0 drew, to the bit, which forty frames of
  v0.21.0 (toon and physically based, in every antialiasing and frame mode,
  with grass and with lamps) proved against the finished tree. A physically
  based look is untouched by any of it.
- **The soft tone is asked for, not given** (`post.tone = 'soft'`), since a
  tone is the post chain's and not the shading's. It first let a colour's
  excess spill toward white at one rate, and a white highlight on red
  plastic came out pink. Then the spill went by how much of the colour was
  white light, and a candy world's pink ground, tried in bearing, went white
  with the highlights: a lit pastel is as white as a highlight. It now goes
  by that and by how far past one the colour is, so a highlight goes white,
  and a lit red and a lit pastel keep their colours.
- **The sheen reads the reflection the gleam already reads.** A second read
  of the environment was most of what the finish's own work cost: 0.037 ms
  on the standard scene with it, nothing that could be told from the noise
  without it (the finish on against off in one tree, eleven rounds).
- **What it costs is its code.** Alternated with v0.21.0 in four rounds, the
  finished tree read +0.01 to +0.07 ms on the perf scenes (paired medians;
  golf +0.07, standard +0.025), 3 to 6% and inside the gate's 15%: the code
  in the toon build, paid whether the finish is on or off. A physically
  based build has none of it.
- **The highlight's edge is eased over 0.15 of its lobe, not a pixel.** At a
  pixel it read as a sticker.
- **The occlusion's tint changes what the grey sums are handed, not the
  sums.** Written as a branch of its own it moved a frame of the golf's look
  by one pixel with the finish off.
- **Rounding is in the geometry** (`roundedBox`, `roundCorners` in
  `mesh/rounded.ts`), as decided. The screen-space rounding the prototype
  tried is not in the tree; it is described below as the evidence for the
  decision.
- **The grass test's colour match moved from four levels to six.** Under the
  ramp, blades turned every way average about three levels under flat
  ground, where the bands lit nearly all of them as flat ground.
- **The ramp was fixed in 0.22.1.** Its low side first rose on past the
  band between, and lit a slope turned a little from the sun brighter than
  the form light had: ooergolf's Volcano read 1.350 against its floor of
  1.38, where 0.21.0 read 1.458. It now rises to the band between exactly
  where the form's fall comes down to it, and above that is the form
  light's top band to the bit; the Volcano reads 1.485. Under it a field of
  blades averages a little darker, and two grass thresholds moved with
  their reasons.
- **Grass is matte, from 0.22.2.** The finish's code in the grass's build
  cost ooergolf's rough 0.45 ms of a 2.5 ms frame with every part at nought,
  which its perf gate caught; the renderer's own golf scene, with a sparser
  field, had read +0.07. The highlight, the sheen and the tint are compiled
  out of a blade (`SceneVariant.matte`), which took ooergolf's gap to about
  +0.1 ms and moved none of its pictures. The ramp stays in: it cost next to
  nothing, and grass shaded by the bands beside ground shaded by the ramp
  would not match.
- **Found and not fixed here:** the grass differs from itself by a pixel from
  one frame to the next with nothing changed, in v0.21.0 as well. It is a
  task of its own.

---

## What

Toon surfaces that read as moulded plastic in the manner of the Switch's
own toys (Mario Kart 8, Odyssey), keeping toon's bright saturated colours.

| Part | What it does | Cost |
| --- | --- | --- |
| Gloss | A clean highlight from the sun, sized by each thing's roughness: a white spot with a glow on smooth plastic, nothing on grass. Its edge eased; widened where a surface turns fast across a pixel, so it does not sparkle. | a few instructions |
| Sheen | The sky in a clear coat, strongest where a surface turns from the eye, shut out of creases by the occlusion. | a few instructions |
| Smooth light | The form light carried through every band: one ramp from the shade to the light, flat ground exactly as it was tuned. | a few instructions |
| Tinted occlusion | In toon, a crease darkens toward the shade colour, not toward grey. | a few instructions |
| Soft tone | A shoulder that keeps a bright colour's hue. The red ball's red channel sat at 252 over most of its lit side. | nothing |
| Antialiasing, occlusion | Already there (`antialias`, `occlusion`); ooergolf used both, bearing (v0.18.0) neither. | as measured in v0.20.0 |
| Rounded edges | See decision 1. | |

## Where it stood

- `perf:gpu`'s standard scene read 0.59 ms at the start of the session and
  0.68–0.72 ms on the same tree an hour later, with another session's
  browser and an image generator on the GPU.
- The four scenes added in v0.20.0 (golf msaa, standard msaa, standard fxaa,
  standard toon light) had no baseline.
- CLAUDE.md's consumer table was out of date: ooergolf pinned v0.21.0.
- **Screen-space rounding, prototyped:** a prepass of normals, a pass
  bending each pixel's normal toward the other face of a convex edge nearby,
  and the scene reading it. It rounded broad faces, and left dashes along a
  rail's top where the top was a few pixels tall on screen (a ring of taps
  cannot find a face that thin) and streaks where a bumper met the ground.
  Fixing it wanted a jump flood of several full-screen passes a frame.

## Decisions (the user's, 2026-09-29)

1. **Rounded edges: rounded geometry**, helpers in the library, each game
   remodelling its hard-edged pieces in its own feature; over a shading
   trick near creases found when a mesh is uploaded, and over screen-space
   rounding.
2. **The finish is what toon means**, where the recommendation was opt-in
   and a preset: the cheap parts are on in every toon look, and the heavy
   ones (antialiasing, occlusion, rounded geometry) stay asked for.
3. **The renderer, then both games**: ooergolf and bearing move to it in
   this session, their pictures taken again.

## Acceptance criteria

1. A physically based look draws the frame v0.21.0 drew, to the pixel, in
   every antialiasing and frame mode, and nothing new compiles before
   `ready`.
2. A toon look with the four parts at nought draws v0.21.0's toon, to the
   pixel; one that says nothing of them draws with all four.
3. Each part moves only what it says, against the same look with that part
   at nought.
4. Flat ground facing straight up keeps its colour under the smooth light,
   and so does ground deep in a shadow.
5. A small smooth ball's highlight does not sparkle as it moves across a
   pixel.
6. The soft tone keeps a colour's hue as it brightens, up to white.
7. The rounded box and the rounded profile are closed, exactly the size
   asked, and smooth over every round.
8. The finish's cost is measured and written down; nothing asked for costs
   the physically based path anything.
9. Pictures, before and after and each part alone, written and looked at.

## Test plan, as run

- `toy.test.ts` (node): the ramp and the tone as sums, and the packing.
- `toy.gpu.test.ts`: criteria 1 to 6 on a device, each part against itself
  at nought, and the checklist's edges (a pixel, an odd size, the two units,
  kept against redrawn, every rung down and back, grass, the half float).
- `rounded.test.ts` (node): criterion 7.
- Every new test mutation-checked: 38 mutants, 29 of the finish and 9 of
  the rounding, every one caught in the end. Four survived until their test
  was sharpened (the tint of the sky's light, the shader's white spill, and
  two rounds of a profile that crossed or bulged the wrong way), and three
  claims (no highlight in a shadow, no sheen in a crease, a lit pastel
  keeping its colour) had no test until a mutant or a picture showed it.
- The forty frames of v0.21.0, written before the change and compared after
  it, for criteria 1 and 2.
- The finish timed interleaved with itself off in one browser, eleven
  rounds a scene, and `perf:gpu` alternated with its parent in six.
