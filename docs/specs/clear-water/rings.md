# Clear water's splash rings

Built on 15 October 2026 on `ripples` from v0.43.0 (`d950981`), for ooerfish's splashes (`ooerfish/docs/splash.md`,
which holds the aim). This note says what was sheeted, what the user chose, and what was built and why. It stops before
the release, which is the user's.

## What was sheeted

ooerfish drew a splash as three white rings laid on the water and a burst of droplets. Over its cured lake, bright and
seen through, they read as circles painted on it, and the user wanted the water itself seen to move. Three directions
were mocked in a copy of the game, filmed for three seconds as a pebble from the boat and a lure from the shore: A, the
rings thin, pale and broken into dashes that open with age; B, no rings drawn, each splash a train of ripples in the
water's own normal; C, B with the body lightened on the ripples' slope and a crown of droplets. **The user chose B.**

The mock's first ring vanished from the shore: a lure's ring is a fraction of a pixel there, and a ring faded where it
would alias was lost. A least wavelength in pixels (six), as the detail layer has a cell in pixels, put it back, broader
far off than near.

## What it is

Seven options of `look.clear` and a setter. A water that names no strength draws as v0.43.0 did, to the pixel, whatever
is handed over:

- `GameRenderer.setRings(data, count)`: up to `RING_SLOTS` (12) rings, `RING_FLOATS` (4) each: where something landed,
  its age in seconds of the game's own clock, and its size (one for ooerfish's pebble). Kept until set again. `packRings`
  takes them in order, refuses a ring that is not numbers or has no size (the next takes its slot), clears the slots
  left, and says how many it took; the setter says whether all were.
- `ringStrength` (nought): how far a ring's slope tilts the normal. ooerfish asks 2.5.
- `ringWavelength` (50 mm), `ringSpeed` (300 mm a second), `ringTrain` (50 mm), `ringGrowth` (60 mm a second): the
  shape, lengths in millimetres turned into the world's units by `resolveClear`, a size `s` taking `sqrt(s)` of the
  wavelength and the train. At ooerfish's hundred millimetres a unit they are the mock's figures exactly.
- `ringLife` (3.5 s) and `ringPixels` (6): not lengths, not turned.

## As built

- **One function, one branch.** `clearRings(p, perPixel)` sums each live ring's radial slope: its front `RING_START`
  (0.3) of a wavelength out at the landing and then at the speed, the train behind it eased in at the front and out at
  the back, `cos` of the distance behind the front over the wavelength, faded by `(1 − age/life)²` and by
  `1/sqrt(1 + r/λ)` as it spreads, and faded again where the wavelength comes within two pixel footprints so it never
  aliases. Its slope `rn` is added to the normal with and without the detail layer, and to the mirror's normal `nm`,
  so the bend, the light and the mirror all take it; the height is not moved, so what floats on the swells is where it
  was. The branch is taken only where the count is over nought, and the count is packed as nought without a strength:
  with none, `rn` is nought, `x + 0` is `x`, and `nm` is `n0` as it was.
- **One block grew.** `ringsUniform` packs the count, the strength, the wavelength and the least pixels, then the speed,
  the train, its growth and the life, then twelve slots, last in the frame (`CLEAR_RINGS_FLOATS` 56; the frame 168 from
  112), every earlier block counted back from it so none moved.
- **Cost.** Twelve rings over `standard clear finish`'s water, in the same run: 0.017 ms (0.75 against 0.74 ms on
  `apple/metal-3`, a loaded machine). The baseline key `standard clear rings` was not written, the machine being at
  other work; it passes as unbaselined until it is written on a quiet one.

## Held by

- `clear.test.ts`: the defaults and their units, refusals, the count packed as nought with no strength, the packing
  and its place last in the frame, `packRings`' twelve and its refusals in order, the shader's struct.
- `clearrings.gpu.test.ts`, on `apple/metal-3`: rings with no strength and a strength with no rings draw the water
  without them to the pixel; a ring half a second old bends 2,811 pixels and none outside its band, in every quarter;
  nothing past its life, before its age or of no size; a ring a twentieth of a unit from sixty off moves no pixel with no
  least and 719 at six; nothing past the water's edge; twelve drawn and the thirteenth refused. Each was seen failing
  with its term taken out (the slope from the normal; the life's test; the least). The loop's own stop at the count
  survives being taken out, since `packRings` leaves the slots past it of no size: it saves work and is not a rule.
- `cleargolden.gpu.test.ts` unchanged, run before the first change and after the last.
