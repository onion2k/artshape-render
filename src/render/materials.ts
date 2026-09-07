/**
 * Metals and finishes.
 *
 * F0 is the reflectance at normal incidence, in linear RGB. Gold, silver, copper
 * and platinum come from measured spectral data reduced to sRGB primaries and are
 * as close to right as three channels allow. The alloys — brass, rose gold — and
 * the oxide finishes are plausible values chosen by eye, not measurements, and
 * are marked as such.
 */
export interface Metal {
  name: string;
  /** Linear-RGB reflectance at normal incidence. */
  f0: [number, number, number];
  /** True where the value comes from measured data rather than judgement. */
  measured: boolean;
  /** Shading model: metal by default; nacre for pearls, gem for cut stones, plastic for display props, light for things that glow. */
  model?: 'nacre' | 'gem' | 'plastic' | 'wood' | 'light';
  /** Body colour, for materials that have one. Linear RGB. */
  colour?: [number, number, number];
  /** Strength of the iridescent sheen, for nacre. */
  orient?: number;
  /** Index of refraction, for a gem. It sets both the sheen and how hard the stone bends light. */
  ior?: number;
  /** How far the stone pulls the colours apart — the trade calls it fire. */
  dispersion?: number;
  /** How readily it throws a flash as it turns. */
  sparkle?: number;
  /**
   * Radiance of a light, in the units the baked sky is measured in: 1 is as
   * bright as a clear sky, a neon tube several times that, a diode far more
   * over far less surface. Sets both how hard it blooms and how much it lights.
   */
  glow?: number;
}

export const metals: Record<string, Metal> = {
  gold: { name: 'gold', f0: [1.0, 0.766, 0.336], measured: true },
  silver: { name: 'silver', f0: [0.972, 0.96, 0.915], measured: true },
  platinum: { name: 'platinum', f0: [0.672, 0.637, 0.585], measured: true },
  copper: { name: 'copper', f0: [0.955, 0.638, 0.538], measured: true },
  'rose gold': { name: 'rose gold', f0: [0.98, 0.72, 0.56], measured: false },
  brass: { name: 'brass', f0: [0.91, 0.778, 0.423], measured: false },
  bronze: { name: 'bronze', f0: [0.76, 0.53, 0.36], measured: false },
  'blackened steel': { name: 'blackened steel', f0: [0.13, 0.125, 0.12], measured: false },

  // Pearls. Nacre's reflectance at normal incidence is that of a dielectric of
  // index about 1.55; the body colours are the trade's names for them.
  'white pearl': { name: 'white pearl', f0: [0.046, 0.046, 0.046], measured: false, model: 'nacre', colour: [0.86, 0.84, 0.80], orient: 0.10 },
  'cream pearl': { name: 'cream pearl', f0: [0.046, 0.046, 0.046], measured: false, model: 'nacre', colour: [0.88, 0.80, 0.64], orient: 0.10 },
  'pink pearl': { name: 'pink pearl', f0: [0.046, 0.046, 0.046], measured: false, model: 'nacre', colour: [0.90, 0.74, 0.72], orient: 0.12 },
  'grey pearl': { name: 'grey pearl', f0: [0.046, 0.046, 0.046], measured: false, model: 'nacre', colour: [0.42, 0.42, 0.44], orient: 0.14 },
  'black pearl': { name: 'black pearl', f0: [0.05, 0.05, 0.05], measured: false, model: 'nacre', colour: [0.07, 0.08, 0.09], orient: 0.22 },
  'gold pearl': { name: 'gold pearl', f0: [0.046, 0.046, 0.046], measured: false, model: 'nacre', colour: [0.85, 0.66, 0.36], orient: 0.10 },

  // Cut stones. The index of refraction and the dispersion are the published
  // figures for each species and do real work in the shader: the first sets how
  // much of the surface is mirror, the second how far the stone splits what it
  // swallows. `colour` is what survives a trip through a stone of ordinary
  // size, judged by eye rather than measured — a real absorption would have to
  // know how far the light travelled.
  diamond: { name: 'diamond', f0: [0.172, 0.172, 0.172], measured: true, model: 'gem', colour: [0.97, 0.97, 0.98], ior: 2.417, dispersion: 0.044, sparkle: 1.0 },
  ruby: { name: 'ruby', f0: [0.077, 0.077, 0.077], measured: true, model: 'gem', colour: [0.72, 0.05, 0.10], ior: 1.77, dispersion: 0.018, sparkle: 0.7 },
  sapphire: { name: 'sapphire', f0: [0.077, 0.077, 0.077], measured: true, model: 'gem', colour: [0.05, 0.13, 0.62], ior: 1.77, dispersion: 0.018, sparkle: 0.7 },
  emerald: { name: 'emerald', f0: [0.051, 0.051, 0.051], measured: true, model: 'gem', colour: [0.06, 0.55, 0.24], ior: 1.58, dispersion: 0.014, sparkle: 0.45 },
  amethyst: { name: 'amethyst', f0: [0.045, 0.045, 0.045], measured: true, model: 'gem', colour: [0.42, 0.20, 0.62], ior: 1.54, dispersion: 0.013, sparkle: 0.6 },
  aquamarine: { name: 'aquamarine', f0: [0.051, 0.051, 0.051], measured: true, model: 'gem', colour: [0.42, 0.78, 0.82], ior: 1.58, dispersion: 0.014, sparkle: 0.6 },
  topaz: { name: 'topaz', f0: [0.056, 0.056, 0.056], measured: true, model: 'gem', colour: [0.90, 0.62, 0.18], ior: 1.62, dispersion: 0.014, sparkle: 0.65 },
  garnet: { name: 'garnet', f0: [0.079, 0.079, 0.079], measured: true, model: 'gem', colour: [0.52, 0.06, 0.05], ior: 1.79, dispersion: 0.024, sparkle: 0.7 },
  peridot: { name: 'peridot', f0: [0.060, 0.060, 0.060], measured: true, model: 'gem', colour: [0.52, 0.72, 0.10], ior: 1.65, dispersion: 0.020, sparkle: 0.6 },
  citrine: { name: 'citrine', f0: [0.046, 0.046, 0.046], measured: true, model: 'gem', colour: [0.88, 0.60, 0.10], ior: 1.55, dispersion: 0.013, sparkle: 0.6 },
  onyx: { name: 'onyx', f0: [0.046, 0.046, 0.046], measured: false, model: 'gem', colour: [0.02, 0.02, 0.025], ior: 1.55, dispersion: 0.010, sparkle: 0.3 },
  moonstone: { name: 'moonstone', f0: [0.043, 0.043, 0.043], measured: false, model: 'gem', colour: [0.80, 0.84, 0.88], ior: 1.52, dispersion: 0.012, sparkle: 0.35 },

  // Display plastics: plain props — busts, ring stands — never the piece
  // itself. An ordinary dielectric reflectance, so with a `matte` or `flock`
  // finish the whole thing stays dead beside whatever it is showing off.
  'white plastic': { name: 'white plastic', f0: [0.035, 0.035, 0.035], measured: false, model: 'plastic', colour: [0.86, 0.85, 0.82] },
  'black plastic': { name: 'black plastic', f0: [0.035, 0.035, 0.035], measured: false, model: 'plastic', colour: [0.03, 0.03, 0.032] },
  'grey plastic': { name: 'grey plastic', f0: [0.035, 0.035, 0.035], measured: false, model: 'plastic', colour: [0.32, 0.32, 0.33] },

  // Woods: a dielectric like the plastics, but the shader draws grain through
  // the body colour — streaks run the length of the part's own Z, the way a
  // turned haft or a carved stem shows its figure. Colours by eye; `orient`
  // is borrowed to say how strongly the figure shows, as nacre borrows it
  // for its sheen.
  oak: { name: 'oak', f0: [0.04, 0.04, 0.04], measured: false, model: 'wood', colour: [0.40, 0.24, 0.10], orient: 0.4 },
  walnut: { name: 'walnut', f0: [0.04, 0.04, 0.04], measured: false, model: 'wood', colour: [0.20, 0.10, 0.05], orient: 0.5 },
  ash: { name: 'ash', f0: [0.04, 0.04, 0.04], measured: false, model: 'wood', colour: [0.58, 0.45, 0.27], orient: 0.32 },
};

// Lights. A glass tube full of excited gas, or a diode under its dome: a
// dielectric skin over a body that is itself the light source. `colour` is
// the light's own colour; `glow` how bright it is. Neon in the trade sense —
// any coloured gas tube — and the colours are the tube colours one can buy.
const neon = (name: string, colour: [number, number, number]): Metal =>
  ({ name, f0: [0.04, 0.04, 0.04], measured: false, model: 'light', colour, glow: 2.6 });
const diode = (name: string, colour: [number, number, number]): Metal =>
  ({ name, f0: [0.04, 0.04, 0.04], measured: false, model: 'light', colour, glow: 14 });
Object.assign(metals, {
  'red neon': neon('red neon', [1.0, 0.10, 0.04]),
  'pink neon': neon('pink neon', [1.0, 0.25, 0.55]),
  'amber neon': neon('amber neon', [1.0, 0.55, 0.10]),
  'green neon': neon('green neon', [0.15, 1.0, 0.30]),
  'cyan neon': neon('cyan neon', [0.10, 0.85, 1.0]),
  'blue neon': neon('blue neon', [0.15, 0.30, 1.0]),
  'violet neon': neon('violet neon', [0.55, 0.20, 1.0]),
  'white neon': neon('white neon', [0.95, 0.95, 1.0]),
  'red diode': diode('red diode', [1.0, 0.08, 0.03]),
  'amber diode': diode('amber diode', [1.0, 0.5, 0.08]),
  'green diode': diode('green diode', [0.1, 1.0, 0.25]),
  'blue diode': diode('blue diode', [0.12, 0.3, 1.0]),
  'white diode': diode('white diode', [0.95, 0.96, 1.0]),
});

export interface Finish {
  name: string;
  roughness: number;
  /**
   * Directional stretch of the highlight, along the surface's u parameter — which
   * runs along a sweep and around a revolve, exactly the way a real part is
   * linished or spun.
   */
  anisotropy: number;
  /** Planished dimpling, as a normal perturbation in object space. */
  hammer: number;
  /** Fraction of the surface turned to oxide: less metallic, coloured, rougher. */
  patina: number;
}

export const finishes: Record<string, Finish> = {
  polished: { name: 'polished', roughness: 0.05, anisotropy: 0, hammer: 0, patina: 0 },
  satin: { name: 'satin', roughness: 0.22, anisotropy: 0, hammer: 0, patina: 0 },
  brushed: { name: 'brushed', roughness: 0.3, anisotropy: 0.88, hammer: 0, patina: 0 },
  spun: { name: 'spun', roughness: 0.2, anisotropy: 0.7, hammer: 0, patina: 0 },
  hammered: { name: 'hammered', roughness: 0.16, anisotropy: 0, hammer: 1, patina: 0 },
  sandblasted: { name: 'sandblasted', roughness: 0.52, anisotropy: 0, hammer: 0, patina: 0 },
  antiqued: { name: 'antiqued', roughness: 0.38, anisotropy: 0.2, hammer: 0.35, patina: 0.45 },
  verdigris: { name: 'verdigris', roughness: 0.62, anisotropy: 0, hammer: 0.2, patina: 0.9 },
  // For the display plastics, chiefly — an injection-moulded matte and a
  // flocked (velvet-coated) surface, meaningfully rougher than any metal
  // finish above. Nothing stops a metal from asking for one, it just reads
  // as an oddly rough metal rather than a broken combination.
  matte: { name: 'matte', roughness: 0.55, anisotropy: 0, hammer: 0, patina: 0 },
  flock: { name: 'flock', roughness: 0.93, anisotropy: 0, hammer: 0, patina: 0 },
};

/** Metals proper, for the picker: pearls are chosen per part in a sketch. */
export const metalNames = Object.keys(metals).filter((n) => !metals[n].model);
export const pearlNames = Object.keys(metals).filter((n) => metals[n].model === 'nacre');
export const gemNames = Object.keys(metals).filter((n) => metals[n].model === 'gem');
export const lightNames = Object.keys(metals).filter((n) => metals[n].model === 'light');
export const plasticNames = Object.keys(metals).filter((n) => metals[n].model === 'plastic');
export const woodNames = Object.keys(metals).filter((n) => metals[n].model === 'wood');
export const finishNames = Object.keys(finishes);

/** Oxide colour for the patinated fraction, per metal family. */
export function patinaColour(metal: string): [number, number, number] {
  switch (metal) {
    case 'copper':
    case 'bronze':
    case 'brass':
      return [0.24, 0.42, 0.35];
    case 'silver':
      return [0.16, 0.14, 0.13];
    default:
      return [0.2, 0.17, 0.14];
  }
}

/**
 * Enamels: glass fired onto the metal. Each is a body colour in linear RGB and
 * an opacity. A transparent enamel — the jeweller's word is translucent — shows
 * the metal beneath it, which is why it is fired over a bright foil and glows;
 * an opaque one is a coloured skin with a glassy surface. Colours are the
 * trade's names, chosen by eye rather than measured.
 */
export interface Enamel {
  name: string;
  /**
   * Linear RGB. For a transparent enamel this is what comes back out of the
   * glass after the round trip to the metal beneath, so it runs bright; for an
   * opaque one it is the body's own albedo.
   */
  colour: [number, number, number];
  /** Fraction scattered by the body: 1 hides the metal entirely, low values glow with it. */
  opacity: number;
}

export const enamels: Record<string, Enamel> = {
  // transparent: fired over polished metal, and lit by its reflection
  cobalt: { name: 'cobalt', colour: [0.04, 0.10, 0.70], opacity: 0.30 },
  peacock: { name: 'peacock', colour: [0.03, 0.42, 0.48], opacity: 0.32 },
  emerald: { name: 'emerald', colour: [0.04, 0.46, 0.13], opacity: 0.32 },
  ruby: { name: 'ruby', colour: [0.66, 0.03, 0.06], opacity: 0.32 },
  amber: { name: 'amber', colour: [0.82, 0.46, 0.07], opacity: 0.28 },
  // opaque: a coloured skin under a glassy surface
  turquoise: { name: 'turquoise', colour: [0.06, 0.48, 0.48], opacity: 0.95 },
  moss: { name: 'moss', colour: [0.12, 0.26, 0.07], opacity: 0.92 },
  coral: { name: 'coral', colour: [0.80, 0.24, 0.16], opacity: 0.95 },
  lilac: { name: 'lilac', colour: [0.50, 0.38, 0.62], opacity: 0.95 },
  ivory: { name: 'ivory', colour: [0.84, 0.76, 0.58], opacity: 0.98 },
  white: { name: 'white', colour: [0.88, 0.88, 0.86], opacity: 0.98 },
  black: { name: 'black', colour: [0.012, 0.012, 0.014], opacity: 1 },
  // leather, chiefly — dark and mid brown, opaque like the other skins above
  umber: { name: 'umber', colour: [0.22, 0.12, 0.07], opacity: 0.97 },
  tan: { name: 'tan', colour: [0.52, 0.34, 0.19], opacity: 0.96 },
};

export const enamelNames = Object.keys(enamels);
