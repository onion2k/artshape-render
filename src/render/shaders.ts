/**
 * WGSL for the three things drawn in the scene pass: the metal, the ground disc
 * and the anchor lines. All three share bind group 0, the frame: camera,
 * exposure, environment textures and the baked occlusion.
 *
 * Every shader here writes linear HDR; tonemapping is the post chain's job.
 */

export const FRAME_STRUCT = `
struct Frame {
  viewProj: mat4x4f,
  cameraPos: vec3f,
  exposure: f32,
  envSpin: f32,
  debug: f32,      // 0 shaded, 1 normals, 2 uv, 3 roughness, 4 prefiltered, 5 brdf, 6 occlusion, 7 wear
  maxLod: f32,
  occlusionOn: f32,
  // 1 while something is selected: the rest of the piece steps back
  selecting: f32,
  // the key: one movable light over the baked environment, in world space
  keyDir: vec3f,
  keyStrength: f32,
  keyColour: vec3f,
  // how much of the baked environment reaches the piece: 1 as baked, 0 dark
  envStrength: f32,
  // the key's own view of the scene, for its shadow; and the offset a
  // sample steps along the normal before the lookup, in world units
  lightViewProj: mat4x4f,
  shadowOffset: f32,
  shadowBias: f32,
  shadowOn: f32,
  // the key's angular radius in radians: 0 a point, a softbox a good fraction of a radian
  keySize: f32,
  // the reflection probe: the piece and its table seen from their centre,
  // filtered like the sky, and read as a sphere of this radius about it
  probeCentre: vec3f,
  probeRadius: f32,
  probeOn: f32,
  probeMaxLod: f32,
  // how much of the small stuff a real piece carries is drawn: polish
  // swirls and smudges on metal, dust on cloth. 0 leaves everything pristine
  detail: f32,
  // millimetres in one world unit: a length times this is in millimetres,
  // which is what every fixed size below — a swirl's pitch, a wire's width — is written in
  unitMm: f32,
  // the frame's size in pixels, and whether the contact occlusion drawn at
  // half that size is to be read by pixel
  viewport: vec2f,
  aoOn: f32,
  // the studio rig: how many of the lights below are lit
  rigCount: f32,
  // the soft shadows' taps as a fraction of the full count: 1 as designed,
  // less on a machine that cannot afford them (the rig array below is
  // aligned to sixteen bytes, so this sits in what would have been padding)
  shadowTaps: f32,
  rig: array<RigLight, 3>,
};
// the tap counts, brought to the frame's fraction but never below a few
fn tapCount(full: i32, floor: i32) -> i32 {
  return max(floor, i32(round(f32(full) * frame.shadowTaps)));
}
/**
 * A light of the rig: a disc like the key, with its own view of the scene
 * for its shadow, kept in its own layer of the rig's shadow array.
 */
struct RigLight {
  dir: vec3f,
  strength: f32,
  colour: vec3f,
  size: f32,
  viewProj: mat4x4f,
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(11) var rigShadow: texture_depth_2d_array;
@group(0) @binding(10) var contactAo: texture_2d<f32>;

/** The contact occlusion at this pixel: 1 in the open, less where something stands close over the surface. */
fn contactAt(clip: vec4f) -> f32 {
  if (frame.aoOn < 0.5) { return 1.0; }
  return textureSampleLevel(contactAo, linearSampler, clip.xy / frame.viewport, 0.0).r;
}
@group(0) @binding(9) var probe: texture_cube<f32>;

// Local lights: the glowing parts of the piece, each sampled as a few small
// spheres of light. They cast no shadow — that is a project of its own — but
// they fall off with distance and light the table, which is most of what a
// neon on a bench does.
struct Light {
  position: vec3f,
  radius: f32,     // of the sphere the light is taken to be, world units
  intensity: vec3f, // radiant intensity: irradiance at unit distance, facing it
  shadow: f32,     // layer of its shadow cube in the array, or -1 for none
};
struct Lights { count: u32, near: f32, far: f32, _p2: u32, items: array<Light, 48> };
@group(0) @binding(7) var<uniform> lights: Lights;
// each light's own view of the piece, six faces round it, baked when the
// piece changes: the lights are part of the piece, so their shadows are still
@group(0) @binding(8) var localShadows: texture_depth_2d_array;

// the six faces round a light, in the order they were rendered: the way each
// looks and which way is up in its image, with right = cross(dir, up)
const FACE_DIR = array<vec3f, 6>(
  vec3f(1.0, 0.0, 0.0), vec3f(-1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0),
  vec3f(0.0, -1.0, 0.0), vec3f(0.0, 0.0, 1.0), vec3f(0.0, 0.0, -1.0));
const FACE_UP = array<vec3f, 6>(
  vec3f(0.0, -1.0, 0.0), vec3f(0.0, -1.0, 0.0), vec3f(0.0, 0.0, 1.0),
  vec3f(0.0, 0.0, -1.0), vec3f(0.0, -1.0, 0.0), vec3f(0.0, -1.0, 0.0));

/**
 * How much of a light reaches a point: 1 in the open, 0 behind something.
 * The cube's faces were rendered with one perspective, so the depth to
 * compare is that of the point along whichever axis the face looks down.
 */
// a fixed rotation per point for the taps' pattern; this chunk stands alone in the depth passes, so its own hash
fn shadowPhase(p: vec3f) -> f32 {
  let q = floor(p * 23.0);
  return fract(sin(dot(q, vec3f(12.9898, 78.233, 37.719))) * 43758.5453) * 6.2831853;
}
// a point in a disc: Vogel's spiral, evenly spread at any count
fn shadowTap(i: i32, count: i32, phase: f32) -> vec2f {
  let r = sqrt((f32(i) + 0.5) / f32(count));
  let a = f32(i) * 2.3999632 + phase;
  return vec2f(cos(a), sin(a)) * r;
}
fn localShadowAt(light: Light, p: vec3f, n: vec3f) -> f32 {
  if (light.shadow < 0.0) { return 1.0; }
  let layer = i32(light.shadow);
  let size = f32(textureDimensions(localShadows).x);
  // step the point out along its normal before the lookup, so a surface does
  // not shadow itself where the map's resolution runs out. A texel of the map
  // at the point's distance is the unit; where the light skims the surface
  // the depth changes by far more than that across one texel, so the step
  // grows with the slope — a tube an eighth of an inch above a plate lights
  // most of that plate at a grazing angle
  var d = p - light.position;
  let dist = length(d);
  let texel = dist * 2.0 / size;
  let ndl = clamp(dot(n, -d / max(dist, 1e-4)), 0.0, 1.0);
  let slope = sqrt(max(1.0 - ndl * ndl, 0.0)) / max(ndl, 0.05);
  let offset = n * texel * (1.5 + min(slope, 8.0));
  d = p + offset - light.position;
  let a = abs(d);
  var face = 0;
  if (a.y >= a.x && a.y >= a.z) { face = select(3, 2, d.y > 0.0); }
  else if (a.z >= a.x) { face = select(5, 4, d.z > 0.0); }
  else { face = select(1, 0, d.x > 0.0); }
  let dir = FACE_DIR[face];
  let up = FACE_UP[face];
  let right = cross(dir, up);
  let major = dot(d, dir);
  // the face's image: right runs along u, up runs against v
  let uv = vec2f(0.5 + 0.5 * dot(d, right) / major, 0.5 - 0.5 * dot(d, up) / major);
  let near = lights.near; let far = lights.far;
  let depth = far / (far - near) - (far * near) / ((far - near) * major);
  let slice = layer * 6 + face;
  let test = depth - 0.0008;
  // The penumbra is the sphere's own size seen from what blocks it: a search
  // over the map finds how far in front of the point the blockers sit, and
  // the filter widens with the gap, so a fin's shadow under a diode is crisp
  // where the fin nearly touches and soft where it stands off — as the key's
  // and the rig's are. The face spans twice its distance across, so a width
  // on the receiver's plane is half that over the distance in uv.
  let texelUv = 1.0 / size;
  let phase = shadowPhase(p);
  // the blockers could be anywhere between here and the light; look as wide
  // as the sphere would throw a penumbra from a blocker a fifth of the way in
  let nearest = max(near, 0.2 * major);
  let search = clamp(0.5 * light.radius * (major - nearest) / (nearest * major), texelUv * 2.0, 0.25);
  var blockers = 0.0;
  var blockerMajor = 0.0;
  let searchTaps = tapCount(12, 4);
  for (var i = 0; i < searchTaps; i++) {
    let at = clamp(uv + shadowTap(i, searchTaps, phase) * search, vec2f(0.0), vec2f(1.0));
    let stored = textureLoad(localShadows, vec2i(at * (size - 1.0)), slice, 0);
    if (stored < test) {
      blockers += 1.0;
      blockerMajor += far * near / (far - stored * (far - near));
    }
  }
  if (blockers == 0.0) { return 1.0; }
  let mb = blockerMajor / blockers;
  let radius = max(0.5 * light.radius * (major - mb) / (mb * major), texelUv * 1.5);
  var lit = 0.0;
  let filterTaps = tapCount(16, 4);
  for (var i = 0; i < filterTaps; i++) {
    lit += textureSampleCompareLevel(localShadows, shadowSampler, uv + shadowTap(i, filterTaps, phase) * radius, slice, test);
  }
  return lit / f32(filterTaps);
}
@group(0) @binding(1) var envSpecular: texture_cube<f32>;
@group(0) @binding(2) var envBrdf: texture_2d<f32>;
@group(0) @binding(3) var linearSampler: sampler;
@group(0) @binding(4) var<storage, read> occlusion: array<u32>;
@group(0) @binding(5) var keyShadow: texture_depth_2d;
@group(0) @binding(6) var shadowSampler: sampler_comparison;
`;

export const COMMON = `
// about Z, because that is the environment's up
fn spinZ(a: f32) -> mat3x3f {
  let c = cos(a); let s = sin(a);
  return mat3x3f(vec3f(c, -s, 0.0), vec3f(s, c, 0.0), vec3f(0.0, 0.0, 1.0));
}

// the baked environment, dimmed by the frame's own setting — every read of
// it goes through here, so turning the sky down turns all of it down
fn env(dir: vec3f, lod: f32) -> vec3f {
  return textureSampleLevel(envSpecular, linearSampler, dir, lod).rgb * frame.envStrength;
}

/**
 * What is seen in direction dir from the point p: the probe where it saw
 * something, the sky where it did not. The probe was rendered from one
 * point, so its directions are corrected for parallax against a sphere of
 * the scene's size — a ring's inside reflects the stone beside it rather
 * than a smeared copy from the centre. Alpha is the probe's hit mask,
 * premultiplied by its filter, so the blend is a plain add.
 */
fn reflectionAt(dir: vec3f, lod: f32, p: vec3f) -> vec3f {
  let sky = env(spinZ(frame.envSpin) * dir, lod);
  if (frame.probeOn < 0.5) { return sky; }
  let rel = p - frame.probeCentre;
  let b = dot(rel, dir);
  let c = dot(rel, rel) - frame.probeRadius * frame.probeRadius;
  let disc = max(b * b - c, 0.0);
  let t = -b + sqrt(disc);
  let corrected = normalize(rel + dir * t);
  let probeLod = lod / max(frame.maxLod, 1.0) * frame.probeMaxLod;
  let seen = textureSampleLevel(probe, linearSampler, corrected, probeLod);
  return seen.rgb + sky * (1.0 - seen.a);
}

/** Light arriving from all round the normal at p: the sky's, with the piece and table standing in where the probe saw them. */
fn irradianceAt(n: vec3f, p: vec3f) -> vec3f {
  return reflectionAt(n, frame.maxLod, p);
}

// One directional light, GGX over the environment's own split-sum: the
// baked sky gives the piece its shape, the key gives it a side. Returns the
// specular lobe scaled by n·l; the caller adds its own diffuse.
//
// The key has a size. A disc of light rather than a point, so its
// highlight is a shape on a mirror and a soft bloom on satin: the lobe is
// evaluated toward the point of the disc nearest the reflection ray, and
// widened by the disc's own radius with the energy that widening spreads
// divided back out (Karis's sphere-light approximation).
fn keySpecular(n: vec3f, v: vec3f, f0: vec3f, roughness: f32) -> vec3f {
  return discSpecular(n, v, f0, roughness, frame.keyDir, frame.keySize, frame.keyColour, frame.keyStrength);
}
fn discSpecular(n: vec3f, v: vec3f, f0: vec3f, roughness: f32, dir: vec3f, size: f32, colour: vec3f, strength: f32) -> vec3f {
  let l0 = normalize(dir);
  if (dot(n, l0) <= -sin(size) || strength <= 0.0) { return vec3f(0.0); }
  let r = reflect(-v, n);
  let rl = dot(r, l0);
  let cosCone = cos(size);
  var l = l0;
  if (rl < cosCone) {
    // the closest point on the disc's rim to the reflection ray
    let perp = r - l0 * rl;
    let pl = length(perp);
    if (pl > 1e-4) { l = normalize(l0 * cosCone + perp / pl * sin(size)); }
  } else {
    l = r;
  }
  let ndl = max(dot(n, l), 0.0);
  let h = normalize(l + v);
  let ndh = max(dot(n, h), 0.0);
  let ndv = max(dot(n, v), 1e-3);
  let vdh = max(dot(v, h), 0.0);
  let a = max(roughness * roughness, 0.002);
  let aw = clamp(a + 0.5 * tan(size), a, 1.0);
  let norm = (a / aw) * (a / aw);
  let a2 = aw * aw;
  let dd = ndh * ndh * (a2 - 1.0) + 1.0;
  let d = a2 / (3.14159265 * dd * dd);
  let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
  let g = (ndl / (ndl * (1.0 - k) + k)) * (ndv / (ndv * (1.0 - k) + k));
  let f = f0 + (1.0 - f0) * pow(1.0 - vdh, 5.0);
  return d * g * f * norm / (4.0 * ndv) * colour * strength * 3.0;
}

// a point in a disc: Vogel's spiral, evenly spread at any count
fn vogel(i: i32, count: i32, phase: f32) -> vec2f {
  let r = sqrt((f32(i) + 0.5) / f32(count));
  let a = f32(i) * 2.3999632 + phase;
  return vec2f(cos(a), sin(a)) * r;
}

// how much of the key reaches a point: its shadow map, filtered over a
// disc the size of the penumbra there. The penumbra is the light's own
// size seen from the blocker: a search over the map finds how far above
// the point the nearest occluders sit, and the filter widens with that
// distance, so a leaf's shadow is crisp at its stem and soft at its tip.
// The map's ortho frame covers 2R across and 4R deep, so a depth gap of
// dz is 2·dz·tan(size) of uv, whatever R is. The lookup steps off the
// surface along the normal first, which is what keeps a lit face from
// shadowing itself where the map's texels are coarser than the mesh.
fn keyShadowAt(world: vec3f, n: vec3f) -> f32 {
  if (frame.shadowOn < 0.5 || frame.keyStrength <= 0.0) { return 1.0; }
  return discShadow(world, n, frame.lightViewProj, frame.keySize, -1);
}
// the maps: the key's own, or a layer of the rig's
fn shadowDims(layer: i32) -> vec2f {
  if (layer < 0) { return vec2f(textureDimensions(keyShadow)); }
  return vec2f(textureDimensions(rigShadow));
}
fn shadowLoad(layer: i32, at: vec2i) -> f32 {
  if (layer < 0) { return textureLoad(keyShadow, at, 0); }
  return textureLoad(rigShadow, at, layer, 0);
}
fn shadowCompare(layer: i32, uv: vec2f, depth: f32) -> f32 {
  if (layer < 0) { return textureSampleCompareLevel(keyShadow, shadowSampler, uv, depth); }
  return textureSampleCompareLevel(rigShadow, shadowSampler, uv, layer, depth);
}
fn discShadow(world: vec3f, n: vec3f, viewProj: mat4x4f, size: f32, layer: i32) -> f32 {
  let dims = shadowDims(layer);
  // the offsets were set for the key's map; a coarser map needs them scaled
  let coarse = f32(textureDimensions(keyShadow).x) / dims.x;
  let p = world + n * frame.shadowOffset * coarse;
  let clip = viewProj * vec4f(p, 1.0);
  let uv = vec2f(clip.x, -clip.y) * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || clip.z > 1.0) { return 1.0; }
  let depth = clip.z - frame.shadowBias * coarse;
  let texel = 1.0 / dims;
  // a fixed rotation per point, so the taps' pattern is a grain, not a print
  let phase = hash13(floor(world * 23.0)) * 6.2831853;
  let spread = 2.0 * tan(size);
  var radius = texel * 1.5;
  if (spread > 0.0) {
    // blocker search: the mean depth of what is between here and the light,
    // over the widest penumbra this point could have
    let search = max(spread * depth, texel.x * 2.0);
    var blockers = 0.0;
    var blockerDepth = 0.0;
    let searchTaps = tapCount(12, 4);
    for (var i = 0; i < searchTaps; i++) {
      let at = uv + vogel(i, searchTaps, phase) * search;
      let d = shadowLoad(layer, vec2i(clamp(at, vec2f(0.0), vec2f(1.0)) * (dims - 1.0)));
      if (d < depth) { blockers += 1.0; blockerDepth += d; }
    }
    if (blockers == 0.0) { return 1.0; }
    let gap = depth - blockerDepth / blockers;
    radius = max(vec2f(spread * gap), texel * 1.5);
  }
  var lit = 0.0;
  let filterTaps = tapCount(24, 6);
  for (var i = 0; i < filterTaps; i++) {
    lit += shadowCompare(layer, uv + vogel(i, filterTaps, phase) * radius, depth);
  }
  return lit / f32(filterTaps);
}

// the key's diffuse: a disc lights a little past its own horizon, so the
// terminator softens with its size instead of cutting off at n·l = 0
fn keyDiffuse(n: vec3f) -> f32 {
  return discDiffuse(n, frame.keyDir, frame.keySize, frame.keyStrength);
}
fn discDiffuse(n: vec3f, dir: vec3f, size: f32, strength: f32) -> f32 {
  let w = sin(size);
  let ndl = clamp((dot(n, normalize(dir)) + w) / (1.0 + w), 0.0, 1.0);
  return ndl * strength * 3.0 / 3.14159265;
}

/**
 * The studio rig: fill and rim beside the key, each a disc with its own
 * shadow. What they add at a point, split so a caller can put the diffuse
 * under its own body colour: the specular already has its Fresnel in.
 * shadowN is the normal the shadow lookup steps along, which the table
 * takes as straight up.
 */
struct RigLit { diffuse: vec3f, specular: vec3f };
fn rigAt(n: vec3f, v: vec3f, world: vec3f, f0: vec3f, roughness: f32, shadowN: vec3f) -> RigLit {
  var out: RigLit;
  out.diffuse = vec3f(0.0);
  out.specular = vec3f(0.0);
  let count = i32(frame.rigCount);
  for (var i = 0; i < count; i++) {
    let l = frame.rig[i];
    if (l.strength <= 0.0) { continue; }
    var lit = 1.0;
    if (frame.shadowOn > 0.5) { lit = discShadow(world, shadowN, l.viewProj, l.size, i); }
    if (lit <= 0.0) { continue; }
    out.diffuse += discDiffuse(n, l.dir, l.size, l.strength) * l.colour * lit;
    out.specular += discSpecular(n, v, f0, roughness, l.dir, l.size, l.colour, l.strength) * lit;
  }
  return out;
}

/**
 * What the local lights add at a point: a diffuse body lit by each, and a
 * highlight from each as a small sphere of light (the key's own
 * representative-point construction, at the sphere's apparent size).
 * Returns radiance before exposure.
 */
fn localLights(n: vec3f, v: vec3f, p: vec3f, f0: vec3f, roughness: f32, body: vec3f) -> vec3f {
  var sum = vec3f(0.0);
  let count = min(lights.count, 48u);
  for (var i = 0u; i < count; i++) {
    let light = lights.items[i];
    let toLight = light.position - p;
    let dist2 = dot(toLight, toLight);
    let dist = sqrt(dist2);
    let l0 = toLight / max(dist, 1e-4);
    let ndl0 = dot(n, l0);
    // the sphere's apparent radius, and a horizon widened by it
    let size = atan(light.radius / max(dist, light.radius * 1.01));
    if (ndl0 <= -sin(size)) { continue; }
    // inverse square, softened inside the sphere so nothing blows up on contact
    let falloff = 1.0 / max(dist2, light.radius * light.radius);
    let lit = localShadowAt(light, p, n);
    if (lit <= 0.0) { continue; }
    let irradiance = light.intensity * falloff * lit;
    // diffuse: the sphere seen over the horizon lights a little past grazing
    let w = sin(size);
    let ndl = clamp((ndl0 + w) / (1.0 + w), 0.0, 1.0);
    sum += body * irradiance * ndl / 3.14159265;
    // specular, toward the point of the sphere nearest the reflection ray
    let r = reflect(-v, n);
    let centre = toLight - r * dot(toLight, r);
    let closest = toLight - centre * clamp(light.radius / max(length(centre), 1e-4), 0.0, 1.0);
    let l = normalize(closest);
    let sndl = max(dot(n, l), 0.0);
    let h = normalize(l + v);
    let ndh = max(dot(n, h), 0.0);
    let ndv = max(dot(n, v), 1e-3);
    let vdh = max(dot(v, h), 0.0);
    let a = max(roughness * roughness, 0.002);
    let aw = clamp(a + 0.5 * tan(size), a, 1.0);
    let norm = (a / aw) * (a / aw);
    let a2 = aw * aw;
    let dd = ndh * ndh * (a2 - 1.0) + 1.0;
    let d = a2 / (3.14159265 * dd * dd);
    let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
    let g = (sndl / (sndl * (1.0 - k) + k)) * (ndv / (ndv * (1.0 - k) + k));
    let f = f0 + (1.0 - f0) * pow(1.0 - vdh, 5.0);
    sum += d * g * f * norm / (4.0 * ndv) * irradiance * sndl;
  }
  return sum;
}

fn hash13(p0: vec3f) -> f32 {
  var p = fract(p0 * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

fn noise3(p: vec3f) -> f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i + vec3f(0.0, 0.0, 0.0)), hash13(i + vec3f(1.0, 0.0, 0.0)), f.x),
        mix(hash13(i + vec3f(0.0, 1.0, 0.0)), hash13(i + vec3f(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(hash13(i + vec3f(0.0, 0.0, 1.0)), hash13(i + vec3f(1.0, 0.0, 1.0)), f.x),
        mix(hash13(i + vec3f(0.0, 1.0, 1.0)), hash13(i + vec3f(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
`;

/**
 * The material record, one per draw group, and the field functions that
 * read it: relief, engraving, lettering, wires, planishing. They are pure
 * functions of the record and a point, so the path tracer shares them,
 * with the record copied into a private variable of the same name.
 */
export const MATERIAL_STRUCT = `
struct Material {
  f0: vec3f,
  roughness: f32,
  anisotropy: f32,
  hammer: f32,
  patina: f32,
  wear: f32,
  patinaColour: vec3f,
  _pad: f32,
  occlusionBase: u32,
  vertexCount: u32,
  model: u32,          // 0 metal, 1 nacre, 2 gem, 3 plastic, 4 wood, 5 light
  _pad2: u32,
  baseColour: vec3f,
  orient: f32,
  enamelColour: vec3f,
  enamelOpacity: f32,   // 0: no enamel on this part
  // chased relief on a plate, evaluated per pixel on the caps
  relief: f32,          // ridge height; 0: none
  reliefVeins: f32,
  reliefLength: f32,
  reliefHalfWidth: f32,
  reliefSpan: vec4f,    // the cap uv box: minX, minY, width, height
  reliefDroop: f32,
  veinF0: vec3f,        // wires along the veins of an enamelled face
  veinOn: f32,
  // a cut stone
  gemIor: f32,
  gemDispersion: f32,
  gemSparkle: f32,
  gemPavilion: f32,   // facets round the pavilion; a step cut has fewer than a brilliant
  // an engraved pattern, evaluated per pixel in surface millimetres
  pattern: u32,        // 0 none; then hatch, crosshatch, guilloche, basketweave, rays, wave, stipple
  patternFaces: u32,   // 0 the caps of a plate only, 1 the whole surface
  _pad3: u32,
  _pad4: u32,
  patternParams: vec4f, // pitch mm, depth mm, angle, the surface's half extent
  // lettering: a run of placed glyphs in the glyph buffer, read from the atlas
  glyphBase: u32,
  glyphCount: u32,
  letterSpread: f32,   // how far the atlas field reaches either side of an edge, in mm
  letterPeriod: f32,   // the surface's length round, where it is closed along x; 0 on an open face
  letter: vec4f,       // depth mm, angle, centre x, centre y
  emission: vec4f,     // radiance of a light, rgb; w is 1 for a light
  // a cut stone's facets, as planes in the part's own space, to trace through
  gemPlaneBase: u32,
  gemPlaneCount: u32,
  gemSize: f32,        // the stone's width: the distance its colour is judged over
  _pad7: f32,
};
/** One placed glyph: its box in surface mm before the inscription's turn, and its atlas rectangle. */
struct Glyph { box: vec4f, rect: vec4f };
`;

export const MATERIAL_FIELDS = `
/**
 * The chased vein relief, the same field deform.ts displaced the plate by:
 * a midrib ridge tapering to the tip, lateral ridges angled forward from it.
 * Evaluated per pixel so a ridge narrower than the lattice still reads as a
 * ridge and not a row of facets.
 */
fn reliefSmooth(a: f32, b: f32, x: f32) -> f32 {
  let t = clamp((x - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

struct Lateral { u: f32, r: f32, sweep: f32, cx: f32, cy: f32, phi0: f32, wave: f32, side: f32 };

/** Lateral vein i: where it leaves the midrib and the arc it follows. Mirrors deform.ts exactly. */
fn lateralVein(i: i32, veins: i32, halfWidth: f32, side: f32) -> Lateral {
  let k = f32(i) / f32(max(veins - 1, 1));
  var out: Lateral;
  out.u = 0.12 + 0.72 * k + side * 0.022;
  let a0 = 1.0 - 0.35 * k;
  out.r = halfWidth * (2.8 + 0.6 * k);
  out.sweep = a0 - 0.25;
  out.cx = out.r * sin(a0);
  out.cy = -out.r * cos(a0);
  out.phi0 = a0 + 1.57079633;
  out.wave = halfWidth * (0.8 + 0.3 * k);
  out.side = side;
  return out;
}

/** Sideways offset of a lateral's centreline at distance t along it: a gentle wave, zero at the midrib. Mirrors deform.ts. */
fn lateralWave(v: Lateral, t: f32) -> f32 {
  let amp = v.wave * 0.028;
  let envelope = min(t / (0.4 * v.wave), 1.0);
  return amp * sin(6.2831853 * t / v.wave + v.side * 0.7) * envelope;
}

/** Distance across a lateral (x) and along it (y), as a capsule: past an end, the distance is to that end. */
fn lateralCoords(v: Lateral, dx: f32, ay: f32) -> vec2f {
  let px = dx - v.cx; let py = ay - v.cy;
  var sweep = v.phi0 - atan2(py, px);
  if (sweep > 3.14159265) { sweep -= 6.2831853; }
  if (sweep < -3.14159265) { sweep += 6.2831853; }
  if (sweep < 0.0) { return vec2f(length(vec2f(dx, ay)), 0.0); }
  let tEnd = v.r * v.sweep;
  if (sweep > v.sweep) {
    let phiEnd = v.phi0 - v.sweep;
    let rho = v.r + lateralWave(v, tEnd);
    return vec2f(length(vec2f(dx - (v.cx + rho * cos(phiEnd)), ay - (v.cy + rho * sin(phiEnd)))), tEnd);
  }
  let t = v.r * sweep;
  return vec2f(abs(length(vec2f(px, py)) - v.r - lateralWave(v, t)), t);
}

/** The relief as a unit field, before the ridge height scales it. */
fn reliefField(x: f32, y: f32) -> f32 {
  let length = material.reliefLength;
  let halfWidth = material.reliefHalfWidth;
  let wm = halfWidth * 0.16;
  let wl = halfWidth * 0.11;
  let u = clamp(x / length, 0.0, 1.0);
  let spine = sin(3.14159265 * u) * material.reliefDroop * length;
  let yy = y - spine;
  let ay = abs(yy);
  let taper = pow(1.0 - u, 0.7) * reliefSmooth(0.0, 0.1, u);
  var h = exp(-(yy * yy) / (wm * wm)) * taper;
  let margin = 1.0 - reliefSmooth(0.7, 1.0, ay / halfWidth);
  let side = select(1.0, -1.0, yy < 0.0);
  var lateral = 0.0;
  let veins = i32(material.reliefVeins);
  for (var i = 0; i < veins; i++) {
    let v = lateralVein(i, veins, halfWidth, side);
    let c = lateralCoords(v, x - v.u * length, ay);
    let along = reliefSmooth(0.0, wl * 2.0, c.y) * exp(-(c.y * c.y) / (halfWidth * halfWidth * 1.4));
    lateral = max(lateral, exp(-(c.x * c.x) / (wl * wl)) * along);
  }
  h += 0.55 * lateral * margin * pow(1.0 - u, 0.4);
  return h;
}

fn reliefHeight(x: f32, y: f32) -> f32 { return material.relief * reliefField(x, y); }

/*
 * Engraved patterns.
 *
 * Each is a unit field of grooves — 1 at the bottom of a cut, 0 on untouched
 * metal — in surface millimetres, rotated by the pattern's angle. The depth
 * scales it and the normal is bent by its gradient, exactly as the vein relief
 * is, so a groove finer than the mesh still reads as a groove.
 */

/** A rounded groove of half-width w, centred where s is 0. */
fn groove(s: f32, w: f32) -> f32 {
  let t = clamp(abs(s) / w, 0.0, 1.0);
  return 1.0 - t * t * (3.0 - 2.0 * t);
}

/** Parallel grooves at a pitch, each of half-width w. */
fn stripes(x: f32, pitch: f32, w: f32) -> f32 {
  return groove((fract(x / pitch) - 0.5) * pitch, w);
}

fn patternField(xIn: f32, yIn: f32) -> f32 {
  let pitch = material.patternParams.x;
  let a = material.patternParams.z;
  let ca = cos(a); let sa = sin(a);
  let x = ca * xIn + sa * yIn;
  let y = -sa * xIn + ca * yIn;
  switch material.pattern {
    case 1u: {  // hatch
      return stripes(y, pitch, 0.22 * pitch);
    }
    case 2u: {  // crosshatch
      return max(stripes(y, pitch, 0.2 * pitch), stripes(x, pitch, 0.2 * pitch));
    }
    case 3u: {  // guilloche: two families of sinuous lines crossing, engine turned
      let wave = 0.32 * pitch * sin(6.2831853 * x / (3.0 * pitch));
      return max(stripes(y + wave, pitch, 0.16 * pitch), stripes(y - wave, pitch, 0.16 * pitch));
    }
    case 4u: {  // basketweave: cells of stripes, alternately across and along
      let cell = 3.0 * pitch;
      let parity = i32(floor(x / cell)) + i32(floor(y / cell));
      let across = stripes(y, pitch, 0.22 * pitch);
      let along = stripes(x, pitch, 0.22 * pitch);
      let fill = select(along, across, (parity & 1) == 0);
      let seams = max(stripes(x, cell, 0.12 * pitch), stripes(y, cell, 0.12 * pitch));
      return max(fill, seams);
    }
    case 5u: {  // rays: grooves radiating from the surface's origin, a deco sunray
      let r = length(vec2f(x, y));
      let extent = max(material.patternParams.w, pitch);
      let dth = pitch / extent;
      let theta = atan2(y, x);
      let s = (fract(theta / dth) - 0.5) * dth * r;
      // the rays would pile up at the centre; let them fade out there
      return groove(s, 0.2 * pitch) * smoothstep(pitch, 3.0 * pitch, r);
    }
    case 6u: {  // wave
      let wave = 0.35 * pitch * sin(6.2831853 * x / (3.0 * pitch));
      return stripes(y + wave, pitch, 0.22 * pitch);
    }
    case 7u: {  // stipple: a lattice of round pits, rows staggered
      let row = floor(y / pitch);
      let shift = select(0.0, 0.5 * pitch, (i32(row) & 1) == 1);
      let cx = (fract((x + shift) / pitch) - 0.5) * pitch;
      let cy = (fract(y / pitch) - 0.5) * pitch;
      let d2 = (cx * cx + cy * cy) / (0.32 * pitch * 0.32 * pitch);
      return max(0.0, 1.0 - d2);
    }
    default: { return 0.0; }
  }
}

/**
 * Signed distance in mm from the nearest letter's edge, negative inside a
 * letter, at a point in the inscription's own frame. Far from every glyph it
 * is simply "far", which the cut treats as untouched metal.
 */
fn letterDistance(p: vec2f) -> f32 {
  var best = 1e9;
  let spread = material.letterSpread;
  for (var i = 0u; i < material.glyphCount; i++) {
    let g = glyphs[material.glyphBase + i];
    if (p.x < g.box.x || p.x > g.box.z || p.y < g.box.y || p.y > g.box.w) { continue; }
    let f = (p - g.box.xy) / (g.box.zw - g.box.xy);
    // the atlas is drawn y-down
    let uv = mix(g.rect.xy, g.rect.zw, vec2f(f.x, 1.0 - f.y));
    let s = textureSampleLevel(atlas, linearSampler, uv, 0.0).r;
    best = min(best, (0.5 - s) * 2.0 * spread);
  }
  return best;
}

/**
 * The lettering's height at a point in surface mm: the letter's floor,
 * the depth down, reached over a short bevel at the edge so the wall catches
 * light rather than vanishing between two pixels.
 */
fn letterHeight(e: vec2f) -> f32 {
  let a = material.letter.y;
  var d = e - material.letter.zw;
  // on a band the coordinate meets itself: take the way round that is nearest
  // the line's centre, so a line across the seam is whole
  let period = material.letterPeriod;
  if (period > 0.0) { d.x -= period * round(d.x / period); }
  let local = vec2f(cos(a) * d.x + sin(a) * d.y, -sin(a) * d.x + cos(a) * d.y);
  let dist = letterDistance(local);
  // a narrow wall: wide enough to catch light, never so wide the letter reads as embossed
  let bevel = min(0.15, material.letterSpread * 0.3);
  return -material.letter.x * (1.0 - smoothstep(-bevel, bevel, dist));
}

/**
 * Light through a cut stone, traced.
 *
 * The stone is a convex solid bounded by its facet planes, so a ray inside
 * it leaves through whichever plane it meets first — one test per plane,
 * no mesh. From the point where the eye's ray enters, each channel is bent
 * in by its own index (red least, blue most: the fire), run to the far
 * facet, and there either bounces back in, when it strikes too shallow to
 * escape, or splits by Fresnel into a part that leaves and a part that goes
 * on. What leaves is looked up in the room — the probe and the sky — in the
 * direction it left. The stone's colour is what a trip of its own width
 * through it leaves of the light, Beer's law between bounces.
 */
fn fresnelDielectric(cosI: f32, eta: f32) -> f32 {
  // eta is the index the ray is entering over the one it is leaving
  let sinT2 = (1.0 - cosI * cosI) / (eta * eta);
  if (sinT2 >= 1.0) { return 1.0; }
  let cosT = sqrt(1.0 - sinT2);
  let rs = (cosI - eta * cosT) / (cosI + eta * cosT);
  let rp = (eta * cosI - cosT) / (eta * cosI + cosT);
  return 0.5 * (rs * rs + rp * rp);
}

fn gemTraced(p: vec3f, v: vec3f, n: vec3f, side: vec3f, axis: vec3f, ior: f32, dispersion: f32, tint: vec3f, worldP: vec3f) -> vec3f {
  // into the part's own space: its axes in the world are the varyings
  let yAxis = cross(axis, side);
  let toObject = mat3x3f(side, yAxis, axis);   // columns: object x, y, z in world
  let vo = normalize(transpose(toObject) * v);
  let no = normalize(transpose(toObject) * n);
  // colour as absorption per millimetre, from what survives the stone's width
  let absorb = -log(max(tint, vec3f(1e-3))) / max(material.gemSize, 0.5 / frame.unitMm);
  let base = material.gemPlaneBase;
  let count = material.gemPlaneCount;
  var out = vec3f(0.0);
  for (var c = 0; c < 3; c++) {
    // the traced stone needs far less help than the folded one: its fire
    // comes from real bounces, so the spread is only doubled
    let eta = max(ior + dispersion * 2.0 * (f32(c) - 1.0), 1.02);
    let cosI = max(dot(vo, no), 1e-4);
    var throughput = 1.0 - fresnelDielectric(cosI, eta);
    var dir = refract(-vo, no, 1.0 / eta);
    if (dot(dir, dir) < 1e-6) { continue; }
    var pos = p;
    var gathered = 0.0;
    for (var bounce = 0; bounce < 5; bounce++) {
      // the nearest plane ahead
      var tBest = 1e9;
      var nHit = no;
      for (var i = 0u; i < count; i++) {
        let pl = gemPlanes[base + i];
        let denom = dot(dir, pl.xyz);
        if (denom <= 1e-6) { continue; }
        let t = (pl.w - dot(pl.xyz, pos)) / denom;
        if (t > 1e-4 && t < tBest) { tBest = t; nHit = pl.xyz; }
      }
      if (tBest >= 1e9) { break; }
      pos += dir * tBest;
      throughput *= exp(-absorb[c] * tBest);
      // leaving: the ray meets the facet from inside, so the normal to bend
      // against points back in
      let cosHit = max(dot(dir, nHit), 1e-4);
      let f = fresnelDielectric(cosHit, 1.0 / eta);
      if (f < 1.0) {
        let outDir = refract(dir, -nHit, eta);
        if (dot(outDir, outDir) > 1e-6) {
          let world = normalize(toObject * outDir);
          gathered += throughput * (1.0 - f) * dot(seen(world, 0.0, worldP), vec3f(f32(c == 0), f32(c == 1), f32(c == 2)));
        }
      }
      throughput *= f;
      if (throughput < 0.01) { break; }
      dir = reflect(dir, nHit);
    }
    out += gathered * vec3f(f32(c == 0), f32(c == 1), f32(c == 2));
  }
  return out;
}

/** Engraved height: grooves cut in by the depth, or raised by a negative one. */
fn engraveHeight(x: f32, y: f32, depth: f32) -> f32 { return -depth * patternField(x, y); }

/**
 * Signed distance to the edge of the cloisonné wire: negative inside it. The
 * wire has a width of its own — a third of a millimetre at the midrib,
 * thinning along each vein — and its own extent: it starts on the midrib,
 * runs out until the enamel cell's rim clips it, and where it ends short of
 * that it ends in a round cap. The ridge's fades do not apply to it.
 */
fn veinWire(x: f32, y: f32) -> f32 {
  let length = material.reliefLength;
  let halfWidth = material.reliefHalfWidth;
  let u = clamp(x / length, 0.0, 1.0);
  let spine = sin(3.14159265 * u) * material.reliefDroop * length;
  let yy = y - spine;
  let ay = abs(yy);
  let side = select(1.0, -1.0, yy < 0.0);
  let halfWire = 0.16 / frame.unitMm;
  // the midrib draws down along its length, as it does in the leaf
  var sdf = ay - halfWire * (1.0 - 0.45 * u);
  let veins = i32(material.reliefVeins);
  for (var i = 0; i < veins; i++) {
    let v = lateralVein(i, veins, halfWidth, side);
    let c = lateralCoords(v, x - v.u * length, ay);
    // Two thinnings, and they compound. Along its own length a vein tapers
    // toward where it ends; and a vein set nearer the tip is a finer one to
    // begin with, because the whole system draws down as the leaf narrows.
    let station = 1.0 - 0.30 * v.u;
    let taper = station * (1.0 - 0.45 * c.y / (v.r * v.sweep));
    sdf = min(sdf, c.x - halfWire * 0.85 * taper);
  }
  return sdf;
}

/**
 * A single bounce cannot pick up the colour a real path does, so the spread
 * across the channels is exaggerated to stand in for a dozen of them.
 */
const FIRE_GAIN: f32 = 6.0;

/**
 * What a crown gives back. The rest leaks out of the pavilion and is lost,
 * which is the difference between a stone and a mirror, and the reason a
 * badly cut one looks like a window.
 */
const CROWN_RETURN: f32 = 0.7;

/**
 * What comes back out of a cut stone.
 *
 * Nothing is traced. What sells a gem is not what lies behind it but what it
 * does with the light in front: a ray bends on the way in, runs down to the
 * pavilion, bounces twice off it and leaves through the crown — so the room
 * arrives at the eye folded and multiplied, which is what a brilliant shows.
 * Bending each channel by a slightly different amount splits it into colour on
 * the way, which is the fire.
 */
fn gemInterior(v: vec3f, n: vec3f, axis: vec3f, lateral: vec3f, ior: f32, dispersion: f32, p: vec3f) -> vec3f {
  let spin = spinZ(frame.envSpin);
  // A pavilion meets the girdle at about forty degrees, and it takes two of
  // those facets to turn the light round: the first sends the ray across the
  // stone, the second sends it back up and out. Both are built here from the
  // stone's own axis and the pavilion facet the light is given, so every part
  // of the crown ends up looking somewhere different — which is the whole
  // reason a cut stone is alive rather than a lump of glass.
  let slope = 0.755;   // cosine of the pavilion angle
  let reach = 0.656;   // and its sine
  var out = vec3f(0.0);
  for (var c = 0; c < 3; c++) {
    // red bends least, blue most
    let channel = max(ior + dispersion * FIRE_GAIN * (f32(c) - 1.0), 1.02);
    var ray = refract(-v, n, 1.0 / channel);
    // a facet steep enough to keep the light in gives nothing back but a mirror
    if (dot(ray, ray) < 1e-6) { ray = reflect(-v, n); }
    ray = reflect(ray, axis * slope + lateral * reach);
    ray = reflect(ray, axis * slope - lateral * reach);
    let sample = seen(ray, 0.0, p);
    out += sample * vec3f(f32(c == 0), f32(c == 1), f32(c == 2));
  }
  return out * CROWN_RETURN;
}

/**
 * The flash a stone throws as it turns.
 *
 * Each facet answers only when its reflection happens to point a particular
 * way — so the smallest movement of the head
 * puts a different set of them out and another set alight. How bright the
 * facet's own reflection is decides whether any of them answer at all, which
 * is why a stone sparkles under a lamp and lies quiet in a shadow.
 */
fn gemSparkle(n: vec3f, r: vec3f, lit: f32, amount: f32) -> f32 {
  if (amount <= 0.0 || lit <= 0.0) { return 0.0; }
  // The facet's own normal names it. It is constant across a facet, so the
  // whole facet answers at once — which is exactly what a facet does, and why
  // a stone flashes rather than glitters like sand.
  let which = floor(n * 24.0);
  let aim = floor(r * 7.0);
  return smoothstep(0.88, 0.99, hash13(which * 3.1 + aim * 1.9)) * lit * amount;
}

/** Planished dimpling: three crossed waves. */
fn planish(p: vec3f) -> f32 {
  return sin(p.x * 1.7 + p.y * 0.9) * sin(p.y * 1.9 - p.z * 1.1) * sin(p.z * 1.6 + p.x * 0.8);
}

/** Fired enamel is glass with a faint orange peel: glossy, never a mirror. */
const ENAMEL_ROUGHNESS: f32 = 0.09;

/**
 * Nacre: light gets under the surface and comes back out diffused, so the
 * body is lit by a broad, wrapped irradiance rather than the normal's alone,
 * with a little bleeding through from behind at the rim. Over it sits a soft
 * dielectric lustre, and an iridescent sheen — the trade calls it orient —
 * that shifts hue as the view turns across the plates.
 */
fn orientTint(ndv: f32, strength: f32) -> vec3f {
  let phase = ndv * 1.3;
  return vec3f(1.0) + strength * vec3f(
    sin(6.2832 * phase), sin(6.2832 * (phase + 0.33)), sin(6.2832 * (phase + 0.67)));
}

fn nacreBody(n: vec3f, v: vec3f, ndv: f32, base: vec3f, ao: f32, p: vec3f) -> vec3f {
  let irrN = irradianceAt(n, p);
  let irrWrap = irradianceAt(normalize(n + v), p);
  let irrBack = irradianceAt(-n, p);
  let scattered = irrN * 0.7 + irrWrap * 0.3;
  let rim = pow(1.0 - ndv, 2.5) * 0.35;
  // multiple scattering loses some light on every pass through the plates:
  // nacre returns about half of what falls on it, not all of it
  return base * (scattered + irrBack * rim) * ao * 0.55;
}
`;

const PBR_MAIN = `
@fragment fn fsMain(in: VsOut, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4f {
  var n = normalize(in.normal);
  let v = normalize(frame.cameraPos - in.world);
  if (!frontFacing) { n = -n; }
  // the mesh's own normal, before anything bends it: what the specular
  // anti-aliasing measures the bends against
  let meshNormal = n;

  var tbn = tangentFrame(n, in.world, in.uv);
  // how much of the flat plate one pixel covers, for antialiasing anything drawn on it
  let plateFootprint = max(0.75 * length(vec2f(dpdx(in.plate.x), dpdy(in.plate.x))), 0.005 / frame.unitMm);
  // and of the engraving coordinates, taken here where every pixel takes them,
  // with the directions those coordinates run in on the surface
  let engraveFootprint = max(0.75 * length(vec2f(dpdx(in.engrave.x), dpdy(in.engrave.x))), 0.005 / frame.unitMm);
  let engraveFrame = tangentFrame(n, in.world, in.engrave);
  // and how much of the part's own coordinates a pixel spans, for the finest detail
  let objectFootprint = length(fwidth(in.object));
  // the part's own coordinates in millimetres, which the fine detail is sized in
  let objMm = in.object * frame.unitMm;
  let objectFootprintMm = objectFootprint * frame.unitMm;

  // --- chased relief: bend the normal by the height field's gradient, per pixel ---
  // The relief was applied as a shear along the flat plate's normal; the cup and
  // curl that followed are bends, so the flat x and y directions are still unit
  // tangents of the surface. The vertex normal carries no relief, so this is
  // the whole of it.
  if (material.relief > 0.0 && abs(in.cap) > 0.5) {
    let eps = material.reliefHalfWidth * 1e-3;
    let fx = (reliefHeight(in.plate.x + eps, in.plate.y) - reliefHeight(in.plate.x - eps, in.plate.y)) / (2.0 * eps);
    let fy = (reliefHeight(in.plate.x, in.plate.y + eps) - reliefHeight(in.plate.x, in.plate.y - eps)) / (2.0 * eps);
    let t = normalize(tbn[0] - n * dot(tbn[0], n));
    let b = normalize(tbn[1] - n * dot(tbn[1], n));
    n = normalize(n - in.cap * (fx * t + fy * b) * select(1.0, -1.0, !frontFacing));
    // re-square the frame to the new normal without touching the derivatives,
    // which may not be taken inside a branch this pixel's neighbours may skip
    tbn = mat3x3f(normalize(t - n * dot(t, n)), normalize(b - n * dot(b, n)), n);
  }

  // --- engraving: the same bend, from a pattern field, on whatever face carries coordinates ---
  if (material.pattern > 0u && (material.patternFaces > 0u || abs(in.cap) > 0.5)) {
    let pitch = material.patternParams.x;
    // grooves finer than a pixel would only shimmer; let the pattern fade to
    // plain metal as it gets there
    let fade = 1.0 - smoothstep(0.12, 0.45, engraveFootprint / pitch);
    let depth = material.patternParams.y * fade;
    if (depth != 0.0) {
      let eps = pitch * 0.02;
      let e = in.engrave;
      let fx = (engraveHeight(e.x + eps, e.y, depth) - engraveHeight(e.x - eps, e.y, depth)) / (2.0 * eps);
      let fy = (engraveHeight(e.x, e.y + eps, depth) - engraveHeight(e.x, e.y - eps, depth)) / (2.0 * eps);
      // the field is cut along the outward normal of whichever face this is,
      // so the frame comes from the engraving coordinates themselves — a
      // sweep's uv is left-handed, and this never has to know
      let t = normalize(engraveFrame[0] - n * dot(engraveFrame[0], n));
      let b = normalize(engraveFrame[1] - n * dot(engraveFrame[1], n));
      let sign = select(1.0, -1.0, !frontFacing);
      n = normalize(n - sign * (fx * t + fy * b));
      tbn = mat3x3f(normalize(tbn[0] - n * dot(tbn[0], n)), normalize(tbn[1] - n * dot(tbn[1], n)), n);
    }
  }

  // --- lettering: the same bend again, from the letters' distance field ---
  var letterFloor = 0.0;
  if (material.glyphCount > 0u && (material.patternFaces > 0u || abs(in.cap) > 0.5)) {
    let eps = max(0.02, material.letterSpread * 0.08);
    let e = in.engrave;
    let h0 = letterHeight(e);
    let fx = (letterHeight(e + vec2f(eps, 0.0)) - letterHeight(e - vec2f(eps, 0.0))) / (2.0 * eps);
    let fy = (letterHeight(e + vec2f(0.0, eps)) - letterHeight(e - vec2f(0.0, eps))) / (2.0 * eps);
    let t = normalize(engraveFrame[0] - n * dot(engraveFrame[0], n));
    let b = normalize(engraveFrame[1] - n * dot(engraveFrame[1], n));
    let sign = select(1.0, -1.0, !frontFacing);
    n = normalize(n - sign * (fx * t + fy * b));
    tbn = mat3x3f(normalize(tbn[0] - n * dot(tbn[0], n)), normalize(tbn[1] - n * dot(tbn[1], n)), n);
    // how far into the cut this pixel is, 0..1: the floor of a cut is left matte by the graver
    letterFloor = select(0.0, clamp(-h0 / material.letter.x, 0.0, 1.0), material.letter.x != 0.0);
  }

  var roughness = material.roughness;
  var f0 = material.f0;
  var metallic = 1.0;
  if (letterFloor > 0.0) { roughness = mix(roughness, max(roughness, 0.42), letterFloor); }
  // nacre has a soft lustre whatever finish the sketch asked for, and no
  // planishing, patina or wear: those are things done to metal
  let nacre = material.model == 1u;
  if (nacre) { roughness = max(roughness, 0.18); }
  // a stone is polished by definition, whatever finish the sketch asked for,
  // and nothing is hammered, patinated or worn but metal
  let gemstone = material.model == 2u;
  if (gemstone) { roughness = min(roughness, 0.04); }
  // a display plastic is not worked metal either: no planishing, patina or wear
  let plastic = material.model == 3u;
  // wood is grain drawn through a dielectric; nothing about it is worked metal
  let wood = material.model == 4u;
  // a light is a glass skin over its own glow; nothing about it is metal
  let light = material.model == 5u;
  let worked = !nacre && !gemstone && !plastic && !wood && !light;

  // --- planishing: perturb the normal by the gradient of a height field ---
  if (material.hammer > 0.0 && worked) {
    let p = objMm * 0.55;
    let eps = 0.35;
    let h0 = planish(p);
    let hx = planish(p + tbn[0] * eps);
    let hy = planish(p + tbn[1] * eps);
    let bump = (tbn[0] * (hx - h0) + tbn[1] * (hy - h0)) / eps;
    n = normalize(n - bump * material.hammer * 0.22);
  }

  // --- the small stuff: polish swirls and the smear of handling ---
  // A polished surface is never a plane. It carries the fine swirled
  // scratches of its final polish, too fine to see as lines but not too fine
  // to break a highlight into a soft haze, and where hands have been it
  // carries their oils, which dull the highlight in slow blotches. Both are
  // drawn from the part's own coordinates, so they stay put as it turns.
  // Enamel hides the metal under it, so the glass carries none of this; and
  // the swirls are a sixth of a millimetre apart, so where a pixel spans
  // more than a fraction of that they are let go before they can alias —
  // a moiré on a petal seen from across the room is worse than no swirls.
  let swirlFade = 1.0 - smoothstep(0.025, 0.08, objectFootprintMm);
  if (frame.detail > 0.0 && worked && material.roughness < 0.35 && in.enamel < 0.5) {
    let q = objMm;
    // swirls: two families of fine lines, each turned by a slow noise so the
    // rings of a buffing wheel wander across the surface
    let turn = noise3(q * 0.09) * 6.2831853;
    let ca = cos(turn); let sa = sin(turn);
    let s1 = q.x * ca + q.y * sa + q.z * 0.37;
    let s2 = -q.x * sa + q.y * ca * 0.8 + q.z * 0.61;
    let scratch = abs(sin(s1 * 38.0 + noise3(q * 3.1) * 4.0)) * 0.6 + abs(sin(s2 * 53.0 + noise3(q * 2.3) * 4.0)) * 0.4;
    // a smudge: a slow blotch of oil that lifts the roughness
    let smudge = smoothstep(0.55, 0.85, noise3(q * 0.23 + vec3f(7.0, 3.0, 1.0)) * 0.7 + noise3(q * 0.6) * 0.3);
    let amount = frame.detail * smoothstep(0.35, 0.05, material.roughness);
    // the scratches scatter the highlight a touch (as a steady haze once
    // they are too fine to see); the oil more, and softly
    roughness += amount * (0.03 * mix(0.5, 1.0 - scratch, swirlFade) + 0.11 * smudge);
    // and the fine lines bend the normal a hair, along their own grain
    let eps = 0.05;
    let sx = abs(sin((s1 + eps) * 38.0 + noise3(q * 3.1) * 4.0)) - abs(sin((s1 - eps) * 38.0 + noise3(q * 3.1) * 4.0));
    n = normalize(n + tbn[0] * sx * amount * 0.012 * swirlFade);
  }

  // --- patina: an oxide fraction that is not metal any more ---
  if (material.patina > 0.0 && worked) {
    let blotch = noise3(objMm * 0.32) * 0.65 + noise3(objMm * 0.9) * 0.35;
    let mask = smoothstep(0.62 - material.patina * 0.55, 0.78 - material.patina * 0.3, blotch);
    metallic = mix(1.0, 0.0, mask * material.patina);
    f0 = mix(f0, vec3f(0.04), mask * material.patina);
    roughness = mix(roughness, min(roughness + 0.35, 0.95), mask * material.patina);
  }

  // --- micro-variation: no real surface is one roughness end to end ---
  // Broad smudges where the polishing cloth or a hand went over it, and a
  // finer mottle under them, each a small shift in roughness; and the
  // faintest drift in the metal's own tint, so a wide flat face reads as a
  // surface rather than a fill. Sized by the finish: a mirror polish moves
  // a little, a satin or brushed finish a good deal more, since its
  // roughness came from marks in the first place.
  if (worked) {
    let p = objMm;
    let smudge = noise3(p * 0.09 + vec3f(3.1, 7.7, 1.3)) - 0.5;
    let mottle = noise3(p * 0.7 + vec3f(11.0, 2.0, 5.0)) - 0.5;
    let fine = noise3(p * 3.0) - 0.5;
    let amount = 0.02 + 0.2 * roughness * (1.0 - roughness);
    roughness = roughness + amount * (smudge * 1.6 + mottle * 0.8 + fine * 0.5);
    let tint = 1.0 + 0.035 * (smudge * 1.2 + mottle * 0.6);
    f0 = f0 * tint;
  }

  // --- wear: edges handled bright, creases left dull ---
  let wearOn = select(material.wear, 0.0, !worked);
  let edge = smoothstep(0.05, 0.8, in.wear) * wearOn;
  var crease = smoothstep(0.05, 0.8, -in.wear) * wearOn;
  // the grain only matters where there is a crease, and most of a surface has none
  if (crease > 0.0) { crease *= 0.7 + 0.6 * noise3(objMm * 1.7); }
  roughness = mix(roughness, roughness * 0.45, edge);
  roughness = mix(roughness, min(roughness + 0.3, 0.95), crease);
  f0 = mix(f0, f0 * 0.55, crease * 0.8);
  metallic = mix(metallic, metallic * 0.6, crease * 0.6);

  // --- specular anti-aliasing: widen the lobe by the normal's variance across the pixel ---
  // What sparkles is the detail bent into the normal — hammer, swirls,
  // relief, engraving — where a pixel straddles more of it than it can show.
  // The mesh's own curvature is not that: a small polished ring turns its
  // normal a good deal across one pixel too, and widening the lobe for it
  // makes every polished thing satin at a distance, which the path tracer,
  // averaging the same pixel honestly, never does. So the bends are measured
  // against the mesh, and the curvature counts for a fraction, enough to
  // keep a bead's silhouette from glittering.
  {
    let dbx = dpdx(n) - dpdx(meshNormal); let dby = dpdy(n) - dpdy(meshNormal);
    let dgx = dpdx(meshNormal); let dgy = dpdy(meshNormal);
    let bumps = 0.25 * (dot(dbx, dbx) + dot(dby, dby));
    let curvature = 0.25 * (dot(dgx, dgx) + dot(dgy, dgy));
    let kernel = min(2.0 * bumps + 0.15 * curvature, 0.18);
    let alpha = roughness * roughness;
    roughness = sqrt(sqrt(alpha * alpha + kernel));
  }

  roughness = clamp(roughness, 0.03, 1.0);

  // --- anisotropy: bend the reflection vector along the brush direction ---
  var reflectN = n;
  if (material.anisotropy > 0.0) {
    let bitangent = tbn[1];
    let anisoT = cross(bitangent, v);
    let anisoN = cross(anisoT, bitangent);
    reflectN = normalize(mix(n, anisoN, material.anisotropy * (1.0 - roughness * 0.4)));
  }

  let r = reflect(-v, reflectN);
  let ndv = clamp(dot(n, v), 0.001, 1.0);
  let spin = spinZ(frame.envSpin);

  // Never sample the environment sharper than the pixel can show. The
  // pixel covers a cone of reflection directions, and the environment's
  // levels are not plain mips but GGX prefilters by roughness, so the level
  // to read is the one whose lobe is about that cone wide: a lobe's angular
  // spread is near its alpha, and alpha is roughness squared. Reading the
  // level whose texel matched the pixel instead made a polished ring, whose
  // normal turns a good deal across one pixel, satin from any distance.
  let footprint = max(length(dpdx(r)), length(dpdy(r)));
  let footLod = clamp(sqrt(footprint), 0.0, 1.0) * frame.maxLod;
  let lod = max(roughness * frame.maxLod, footLod);
  let prefiltered = seen(r, lod, in.world);
  let ab = textureSampleLevel(envBrdf, linearSampler, vec2f(ndv, roughness), 0.0).rg;

  // Lagarde's specular occlusion: a mirror keeps more of its reflection than
  // its hemisphere visibility suggests
  // the floor of a cut letter sits in its own shadow; and whatever stands
  // close over this pixel takes its share of the sky
  let ao = in.ao * (1.0 - 0.45 * letterFloor) * contactAt(in.clip);
  let specOcclusion = clamp(pow(ndv + ao, exp2(-16.0 * roughness - 1.0)) - 1.0 + ao, 0.0, 1.0);
  var reflected = prefiltered * specOcclusion;

  let enamelled = in.enamel > 0.001;

  // what the key light lands on: a diffuse body (none for metal, which has
  // no diffuse lobe), a specular f0 and roughness. Each branch fills these
  // in; the key is added once, after, so no branch forgets it.
  var keyBody = vec3f(0.0);
  var keyF0 = f0;
  var keyRough = roughness;

  var colour: vec3f;
  if (material.model == 1u) {
    // nacre: a lustre over a scattering body, with the sheen on the lustre
    let fresnel = f0 * ab.x + ab.y;
    let tint = orientTint(ndv, material.orient);
    let body = nacreBody(n, v, ndv, material.baseColour, ao, in.world);
    colour = (body * (1.0 - fresnel) * mix(vec3f(1.0), tint, 0.3) + reflected * fresnel * tint) * frame.exposure;
    keyBody = material.baseColour * mix(1.0, ao, 0.5);
  } else if (gemstone) {
    // a hard dielectric mirror on the facet, the folded room underneath it,
    // and a flash where the facet catches something bright
    let axis = normalize(in.axis);
    let ior = max(material.gemIor, 1.05);
    let g0 = pow((ior - 1.0) / (ior + 1.0), 2.0);
    let mirror = reflected * (g0 * ab.x + ab.y);
    let fresnel = g0 + (1.0 - g0) * pow(1.0 - ndv, 5.0);
    // Which pavilion facet the light meets depends on where it crossed the
    // crown, not only on where it was going. That is why the table of a stone
    // is a mosaic of directions rather than one flat colour, and it is the
    // difference between reading as a gem and reading as a bead of glass.
    let across = normalize(in.side - axis * dot(in.side, axis));
    let step = 6.2831853 / max(material.gemPavilion, 2.0);
    let az = (floor(atan2(in.object.y, in.object.x) / step) + 0.5) * step;
    let lateral = across * cos(az) + cross(axis, across) * sin(az);
    var interior: vec3f;
    if (material.gemPlaneCount > 0u) {
      // a faceted stone is traced: the Fresnel split at the entry is inside
      // the trace, so nothing is taken off again here
      interior = gemTraced(in.object, v, n, normalize(in.side), axis, ior, material.gemDispersion, material.baseColour, in.world);
      colour = (mirror + interior) * frame.exposure;
    } else {
      interior = gemInterior(v, n, axis, lateral, ior, material.gemDispersion, in.world) * material.baseColour * ao;
      let lit = smoothstep(0.8, 4.0, dot(reflected, vec3f(0.2126, 0.7152, 0.0722)));
      let flash = gemSparkle(n, r, lit, material.gemSparkle);
      colour = (mirror + interior * (1.0 - fresnel) + reflected * flash) * frame.exposure;
    }
    keyF0 = vec3f(g0);
  } else if (light) {
    // the source itself: its radiance straight out through a glass skin that
    // still reflects the room, brightest where the tube is seen edge-on —
    // the gas glows through more of itself there, and a diode's dome the same
    let fresnel = f0 * ab.x + ab.y;
    let limb = mix(1.0, 1.3, pow(1.0 - ndv, 2.0));
    colour = (material.emission.rgb * limb * (1.0 - fresnel) + reflected * fresnel) * frame.exposure;
    keyBody = vec3f(0.0);
    keyF0 = vec3f(0.04);
    keyRough = max(roughness, 0.08);
  } else if (plastic || wood) {
    // an ordinary dielectric: a low, fixed highlight over a diffuse body in
    // the finish's own colour — no patina, hammer or enamel, only ever metal
    var body = material.baseColour;
    if (wood) {
      // Growth rings as a stack of warped planes through the part: a haft is
      // cut from a board, not turned round its own pith, so what shows on a
      // cylinder is long stripes and cathedrals where the surface cuts the
      // rings, not concentric circles. Each ring is a sharp dark latewood
      // band on a paler earlywood ground, and a fine fibre texture runs the
      // length of Z through both, so the figure reads at every distance.
      let p = objMm;
      let wobble = noise3(vec3f(p.x * 0.35, p.y * 0.35, p.z * 0.03)) * 2.6
        + noise3(vec3f(p.x * 1.3, p.y * 1.3, p.z * 0.11)) * 0.6;
      let ringCoord = (p.x * 0.94 + p.y * 0.34) * 1.9 + wobble;
      let ph = fract(ringCoord);
      // never sharper than the pixel: a ring narrower than the footprint is
      // averaged toward its mean rather than shimmering
      let foot = clamp(fwidth(ringCoord) * 1.5, 0.02, 0.5);
      let late = smoothstep(0.42 - foot, 0.62 + foot, ph) * (1.0 - smoothstep(0.78 - foot, 0.96 + foot, ph));
      let fibre = noise3(vec3f(p.x * 5.5, p.y * 5.5, p.z * 0.4)) - 0.5;
      let strength = material.orient;
      body = material.baseColour
        * (1.0 + 0.5 * strength * fibre)
        * mix(1.0 + 0.3 * strength, 1.0 - 1.3 * strength, late)
        * mix(vec3f(1.0), vec3f(0.92, 0.78, 0.66), late);
    }
    let specular = reflected * (f0 * ab.x + ab.y);
    let irradiance = irradianceAt(n, in.world);
    let diffuse = irradiance * body * ao;
    colour = (specular + diffuse) * frame.exposure;
    keyBody = body * mix(1.0, ao, 0.5);
  } else {
    let specular = reflected * (f0 * ab.x + ab.y);
    // metal has no diffuse lobe, so this only shows where patina has taken hold
    let irradiance = irradianceAt(n, in.world);
    let diffuse = irradiance * material.patinaColour * (1.0 - metallic) * ao;
    colour = (specular + diffuse) * frame.exposure;
    keyBody = material.patinaColour * (1.0 - metallic) * mix(1.0, ao, 0.5);

    // Enamel: a glass skin over the metal, on the vertices that carry it. The
    // surface is a smooth dielectric with its own narrow highlight; under it
    // the body scatters light in its colour, and a transparent enamel lets the
    // metal's reflection back out through the colour, which is the glow of a
    // translucent enamel over a bright foil.
    if (enamelled) {
      let eRough = ENAMEL_ROUGHNESS;
      let eLod = max(eRough * frame.maxLod, footLod);
      let ePrefiltered = seen(reflect(-v, n), eLod, in.world);
      let eOcclusion = clamp(pow(ndv + ao, exp2(-16.0 * eRough - 1.0)) - 1.0 + ao, 0.0, 1.0);
      let eReflected = ePrefiltered * eOcclusion;
      let eAb = textureSampleLevel(envBrdf, linearSampler, vec2f(ndv, eRough), 0.0).rg;
      let eFresnel = vec3f(0.04) * eAb.x + eAb.y;
      let eSpecular = eReflected * eFresnel;
      // the metal's own highlight, seen through the glass and dyed by it: the
      // colour is the round trip's transmittance, in and back out. A little
      // stays even in an opaque enamel, where the layer is thin at the rim.
      let through = specular * material.enamelColour * (1.0 - material.enamelOpacity);
      let body = irradiance * material.enamelColour * ao * material.enamelOpacity;
      var enamel = (eSpecular + (1.0 - eFresnel) * (body + through)) * frame.exposure;
      // Cloisonné: wires of a second metal set along the veins. The same field
      // that raises the relief says where a vein runs; its core is the wire.
      // The wire is polished, and reflects what the glass beside it reflects.
      // The wire is polished, and stands proud of the glass as a half-round
      // bead, so it catches the sky along its crown and the sun along one
      // flank: the distance field's gradient says which way the bead falls.
      keyF0 = mix(keyF0, vec3f(0.04), in.enamel);
      keyRough = mix(keyRough, eRough, in.enamel);
      keyBody = mix(keyBody, material.enamelColour * material.enamelOpacity * mix(1.0, ao, 0.5), in.enamel);
      if (material.veinOn > 0.0) {
        let sdf = veinWire(in.plate.x, in.plate.y);
        let wire = (1.0 - smoothstep(-plateFootprint, plateFootprint, sdf)) * in.enamel;
        if (wire > 0.0) {
          let eps = 0.02;
          let gx = (veinWire(in.plate.x + eps, in.plate.y) - veinWire(in.plate.x - eps, in.plate.y)) / (2.0 * eps);
          let gy = (veinWire(in.plate.x, in.plate.y + eps) - veinWire(in.plate.x, in.plate.y - eps)) / (2.0 * eps);
          let t = normalize(tbn[0] - n * dot(tbn[0], n));
          let b = normalize(tbn[1] - n * dot(tbn[1], n));
          let across = gx * t + gy * b;
          let bead = 0.14 / frame.unitMm;
          // a bead of that radius: level on the crown, falling to the edge,
          // but never quite on its side, and flattening as the wire nears a
          // pixel wide, where only the crown's reflection should be left
          let flat = 1.0 - smoothstep(0.012, 0.05, plateFootprint * frame.unitMm);
          let tilt = clamp(1.0 + sdf / bead, 0.0, 1.0) * 0.7 * flat;
          let wireN = normalize(n * sqrt(1.0 - tilt * tilt) + normalize(across + n * 1e-4) * tilt * select(1.0, -1.0, !frontFacing));
          // the bead's spread of normals does not go away when the bead is
          // too small to draw: it becomes roughness, and the wire seen from
          // afar is a rough polished metal, catching the key from any angle
          let wireRough = mix(0.55, 0.12, flat);
          let wireNdv = max(dot(wireN, v), 1e-4);
          let wireLod = max(wireRough * frame.maxLod, footLod);
          let wireAb = textureSampleLevel(envBrdf, linearSampler, vec2f(wireNdv, wireRough), 0.0).rg;
          let wireReflected = seen(reflect(-v, wireN), wireLod, in.world) * mix(ao, 1.0, 0.5);
          let wireColour = wireReflected * (material.veinF0 * wireAb.x + wireAb.y) * frame.exposure;
          enamel = mix(enamel, wireColour, wire);
          // and the key and the piece's lights see the bead, in its own metal
          n = normalize(mix(n, wireN, wire));
          keyF0 = mix(keyF0, material.veinF0, wire);
          keyRough = mix(keyRough, wireRough, wire);
          keyBody = mix(keyBody, vec3f(0.0), wire);
        }
      }
      colour = mix(colour, enamel, in.enamel);
    }
  }

  // the key light, over whatever the environment gave, where its shadow lets it
  let keyLit = keyShadowAt(in.world, n);
  colour += (keySpecular(n, v, keyF0, keyRough) + keyBody * keyDiffuse(n) * frame.keyColour) * keyLit * frame.exposure;
  // and the rig's fill and rim, the same way
  if (frame.rigCount > 0.0) {
    let rig = rigAt(n, v, in.world, keyF0, keyRough, n);
    colour += (rig.specular + keyBody * rig.diffuse) * frame.exposure;
  }
  // and the piece's own lights, on everything but the lights themselves
  if (!light) { colour += localLights(n, v, in.world, keyF0, keyRough, keyBody) * frame.exposure; }

  // Selection: what the cursor is on keeps its light and takes a warm cast;
  // everything else drops back so the chosen instances read at a glance.
  if (frame.selecting > 0.5) {
    let glow = vec3f(0.95, 0.62, 0.18) * frame.exposure * 0.22;
    colour = mix(colour * 0.22, colour * 1.1 + glow, in.selected);
  }

  let d = frame.debug;
  if (d > 6.5) {
    colour = select(vec3f(0.3, 0.3 * (1.0 + in.wear), 0.3 * (1.0 + in.wear)), vec3f(0.3 + in.wear * 0.7), in.wear > 0.0);
  } else if (d > 5.5) { colour = vec3f(ao); }
  else if (d > 4.5) { colour = vec3f(ab, 0.0) * 4.0; }
  else if (d > 3.5) { colour = prefiltered; }
  else if (d > 2.5) { colour = vec3f(roughness); }
  else if (d > 1.5) { colour = vec3f(in.uv, 0.35); }
  else if (d > 0.5) { colour = n * 0.5 + 0.5; }

  // alpha carries the distance to the eye, for the depth of field pass
  return vec4f(colour, length(in.world - frame.cameraPos));
}
`;


/** The table's record and its surfaces, shared with the path tracer. The surfaces take a point and a pixel's footprint in millimetres. */
export const GROUND_STRUCT = `
struct Ground {
  centre: vec3f,
  radius: f32,
  background: vec3f,   // linear: what tonemaps to the page colour
  _pad: f32,
  albedo: vec3f,
  _pad2: f32,
  table: f32,          // which surface: 0 matte, 1 oak, 2 walnut, 3 slate, 4 linen, 5 velvet, 6 silk
  roughness: f32,
  scale: f32,          // pattern size, mm per feature
  puff: f32,           // how proud a cushion stands, world units; 0 for anything hard and flat
  cushionSize: f32,    // the cushion's half-side, as a fraction of the disc's radius
  slope: f32,
  _pad4: vec2f,
};
`;

export const TABLE_SURFACES = `
/**
 * What the table is at a point. sheen is a cloth's fuzz colour: velvet
 * throws light back at grazing angles in it, and 0 for anything that is not
 * a cloth. aniso stretches the highlight along X, the way a satin weave
 * does along its floats.
 */
struct Surface { albedo: vec3f, roughness: f32, normal: vec3f, sheen: vec3f, aniso: f32 };
fn hard(albedo: vec3f, roughness: f32, normal: vec3f) -> Surface {
  return Surface(albedo, roughness, normal, vec3f(0.0), 0.0);
}

// Boards laid along X, each a little different in tone and in where its
// rings fall, with a dark seam between them. Rings as in the parts' own wood:
// a stack of warped planes, so a plank shows long stripes and cathedrals.
fn plankSurface(p: vec2f, base: vec3f, seamWidth: f32, contrast: f32, foot: f32) -> Surface {
  let boardWidth = ground.scale;
  let board = floor(p.y / boardWidth);
  let inBoard = fract(p.y / boardWidth);
  let seed = hash13(vec3f(board, 0.0, 0.0));
  let tone = mix(0.8, 1.2, seed);
  // each board is a different cut: its rings run at their own slant and phase
  let slant = mix(-0.25, 0.25, hash13(vec3f(board, 7.0, 0.0)));
  let along = p.x + seed * 3000.0;
  let across = (inBoard - 0.5) * boardWidth;
  // rings run the length of the board, drifting slowly and closing into
  // cathedrals where the wobble folds them back over themselves
  let wobble = noise3(vec3f(along * 0.008, across * 0.03, seed)) * 3.0
    + noise3(vec3f(along * 0.03, across * 0.12, seed * 3.0)) * 0.7;
  let ringCoord = across * (0.22 + slant * 0.3) + along * 0.004 * slant + wobble;
  let ph = fract(ringCoord);
  let ringFoot = clamp(foot * 0.5, 0.02, 0.5);
  let late = smoothstep(0.4 - ringFoot, 0.6 + ringFoot, ph) * (1.0 - smoothstep(0.78 - ringFoot, 0.96 + ringFoot, ph));
  let fibre = noise3(vec3f(p.x * 0.6, p.y * 5.0, seed)) - 0.5;
  var albedo = base * tone
    * (1.0 + 0.35 * contrast * fibre)
    * mix(1.0 + 0.2 * contrast, 1.0 - 0.9 * contrast, late)
    * mix(vec3f(1.0), vec3f(0.92, 0.8, 0.7), late);
  let edge = min(inBoard, 1.0 - inBoard) * boardWidth;
  let seam = 1.0 - smoothstep(0.0, seamWidth, edge);
  albedo = mix(albedo, base * 0.25, seam);
  // the seam is a shallow groove; latewood stands very slightly proud
  let dz = seam * 0.6 + late * 0.05;
  let n = normalize(vec3f(0.0, -dz * 4.0 * select(1.0, -1.0, inBoard > 0.5), 1.0));
  return hard(albedo, ground.roughness + late * 0.08, n);
}

fn slateSurface(p: vec2f) -> Surface {
  let s = ground.scale;
  let mottle = noise3(vec3f(p.x / s, p.y / s, 1.0)) * 0.6 + noise3(vec3f(p.x / s * 4.0, p.y / s * 4.0, 2.0)) * 0.3;
  // cleaved bedding: fine parallel ridges, wandering
  let bed = noise3(vec3f(p.x * 0.015, p.y * 0.35 + noise3(vec3f(p.x * 0.03, p.y * 0.03, 5.0)) * 6.0, 3.0));
  let flake = noise3(vec3f(p.x * 0.5, p.y * 0.5, 7.0));
  let base = mix(vec3f(0.03, 0.034, 0.042), vec3f(0.085, 0.09, 0.1), mottle);
  let albedo = base * (0.94 + 0.12 * bed) * (0.9 + 0.2 * flake);
  let n = normalize(vec3f(0.0, (bed - 0.5) * 0.08, 1.0));
  return hard(albedo, ground.roughness + (0.5 - flake) * 0.2, n);
}

fn linenSurface(p: vec2f, foot: f32) -> Surface {
  let s = ground.scale;
  // a plain weave: warp and weft alternately on top, each thread a soft ridge
  let u = p.x / s; let v = p.y / s;
  let warp = 0.5 + 0.5 * cos(u * 6.2831853);
  let weft = 0.5 + 0.5 * cos(v * 6.2831853);
  let check = fract(floor(u) * 0.5 + floor(v) * 0.5) * 2.0;   // 0 or 1
  let ridge = mix(warp, weft, check);
  let blur = clamp(foot / s * 2.0, 0.0, 1.0);
  let thread = mix(ridge, 0.5, blur);      // averaged away when finer than a pixel
  let slub = noise3(vec3f(p.x * 0.15, p.y * 0.15, 9.0));
  let base = vec3f(0.62, 0.56, 0.46) * mix(0.9, 1.1, slub);
  let albedo = base * mix(0.82, 1.0, thread);
  return hard(albedo, ground.roughness, vec3f(0.0, 0.0, 1.0));
}

// Velvet: a dense pile, so the colour is deep and the light comes back off
// the fibre tips at grazing angles — the sheen — where a crushed patch of
// pile leaning the other way shows as a slow blotch of lighter and darker.
fn velvetSurface(p: vec2f) -> Surface {
  let s = ground.scale;
  let crush = noise3(vec3f(p.x * 0.06, p.y * 0.06, 3.0)) * 0.7 + noise3(vec3f(p.x * 0.2, p.y * 0.2, 7.0)) * 0.3;
  let fuzz = noise3(vec3f(p.x / s, p.y / s, 11.0));
  // a pile swallows nearly everything that goes straight in
  let base = vec3f(0.006, 0.008, 0.03) * mix(0.5, 1.5, crush) * mix(0.9, 1.1, fuzz);
  // the pile leans a little where it is crushed, tilting the normal with it
  let eps = 2.0;
  let cx = noise3(vec3f((p.x + eps) * 0.06, p.y * 0.06, 3.0)) - noise3(vec3f((p.x - eps) * 0.06, p.y * 0.06, 3.0));
  let cy = noise3(vec3f(p.x * 0.06, (p.y + eps) * 0.06, 3.0)) - noise3(vec3f(p.x * 0.06, (p.y - eps) * 0.06, 3.0));
  let n = normalize(vec3f(-cx * 0.35, -cy * 0.35, 1.0));
  let sheen = vec3f(0.08, 0.10, 0.24) * mix(0.5, 1.5, crush);
  return Surface(base, ground.roughness, n, sheen, 0.0);
}

// Silk: a satin weave, the floats running along X so the highlight streaks
// that way, on an ivory ground with the faint ribbing of the threads.
fn silkSurface(p: vec2f, foot: f32) -> Surface {
  let s = ground.scale;
  let thread = 0.5 + 0.5 * cos(p.y / s * 6.2831853);
  let blur = clamp(foot / s * 2.0, 0.0, 1.0);
  let rib = mix(thread, 0.5, blur);
  let slub = noise3(vec3f(p.x * 0.05, p.y * 0.3, 5.0));
  let albedo = vec3f(0.48, 0.43, 0.33) * mix(0.94, 1.02, rib) * mix(0.96, 1.04, slub);
  let n = normalize(vec3f(0.0, (rib - 0.5) * 0.1 * (1.0 - blur), 1.0));
  return Surface(albedo, ground.roughness, n, vec3f(0.5, 0.48, 0.42), 0.75);
}

fn tableSurface(p: vec2f, foot: f32) -> Surface {
  let t = ground.table;
  if (t < 0.5) {
    // a matte table in the page's colour, never darker than a dark cloth
    return hard(max(ground.background, ground.albedo), ground.roughness, vec3f(0.0, 0.0, 1.0));
  } else if (t < 1.5) {
    return plankSurface(p, vec3f(0.42, 0.28, 0.15), 0.7, 0.4, foot);
  } else if (t < 2.5) {
    return plankSurface(p, vec3f(0.16, 0.09, 0.055), 0.9, 0.5, foot);
  } else if (t < 3.5) {
    return slateSurface(p);
  } else if (t < 4.5) {
    return linenSurface(p, foot);
  } else if (t < 5.5) {
    return velvetSurface(p);
  }
  return silkSurface(p, foot);
}
`;

/**
 * The cushion as a height field over the table's disc, read from the bake.
 * Needs `ground` and `cushionHeight` declared by whoever includes it: the
 * ground pass draws it, the tracer intersects it.
 */
export const CUSHION_FIELD = `
/** The cushion's height at a point of the disc, bilinear over the baked map. */
fn heightAt(uv: vec2f) -> f32 {
  let s = f32(textureDimensions(cushionHeight).x);
  let p = clamp(uv * s - 0.5, vec2f(0.0), vec2f(s - 1.001));
  let i = vec2i(floor(p));
  let f = fract(p);
  let h00 = textureLoad(cushionHeight, i, 0).r;
  let h10 = textureLoad(cushionHeight, i + vec2i(1, 0), 0).r;
  let h01 = textureLoad(cushionHeight, i + vec2i(0, 1), 0).r;
  let h11 = textureLoad(cushionHeight, i + vec2i(1, 1), 0).r;
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}

/** The cushion's own dome, without the piece pressed into it. */
fn domeAt(local: vec2f) -> f32 {
  let q = abs(local) / ground.cushionSize;
  let e = pow(pow(q.x, 4.0) + pow(q.y, 4.0), 0.25);
  let shoulder = 1.0 - smoothstep(0.45, 1.0, e);
  let crown = 0.8 + 0.2 * max(0.0, 1.0 - e * e);
  return ground.puff * shoulder * crown;
}

`;

export const TABLE_LIT = `
/**
 * The table, lit, at a point of the disc: its surface, the cushion's shape
 * and fold, the sky's light under the baked occlusion, the key and the rig
 * with their shadows, the sheen, the piece's own lights, and the fade to
 * the page at the rim. The ground pass draws it; the piece's shader calls
 * it where a reflection ray meets the table, so a polished face shows the
 * table exactly where it is rather than where the probe's sphere put it.
 * v is the direction to whoever is looking, contact the screen-space
 * occlusion where there is one, foot the footprint in millimetres the
 * grain is drawn at, exposure the frame's where the table is drawn for
 * the eye and one where it is drawn for a reflection to be exposed later.
 */
fn tableLit(world: vec3f, local: vec2f, v: vec3f, contact: f32, foot: f32, exposure: f32) -> vec3f {
  let acc = textureSampleLevel(shadow, linearSampler, local * 0.5 + 0.5, 0.0).rg;
  let ao = select(1.0, clamp(acc.r / acc.g, 0.0, 1.0), acc.g > 0.0) * contact;
  // the table takes the background's colour, but never darker than a dark
  // matte table, and is lit by the sky and the key like anything else —
  // so on a black page there is still a pool of light with a shadow in
  // it, and on a pale one the table is that colour with a shadow in it
  // the table's grain is drawn in millimetres
  let surface = tableSurface(world.xy * frame.unitMm, foot);
  var n = surface.normal;
  var dipShade = 1.0;
  var cushion = 1.0;
  if (ground.puff > 0.0) {
    // the cushion's normal from its height's slope, and the cloth's own
    // fine normal laid over it; where the piece has pressed the cloth down
    // out of its dome it sits in a fold, and shades itself
    let uv = local * 0.5 + 0.5;
    let step = 1.0 / f32(textureDimensions(cushionHeight).x);
    let mm = 2.0 * ground.radius * step;
    let dx = (heightAt(uv + vec2f(step, 0.0)) - heightAt(uv - vec2f(step, 0.0))) / (2.0 * mm);
    let dy = (heightAt(uv + vec2f(0.0, step)) - heightAt(uv - vec2f(0.0, step))) / (2.0 * mm);
    let slopeN = normalize(vec3f(-dx, -dy, 1.0));
    n = normalize(vec3f(slopeN.xy + n.xy * 0.6, slopeN.z));
    let pressed = clamp((domeAt(local) - heightAt(uv)) / max(ground.puff, 0.1), 0.0, 1.0);
    dipShade = 1.0 - 0.45 * pressed;
    // beyond the cushion's rim there is only the table under it
    cushion = smoothstep(0.0, 0.15, domeAt(local) / max(ground.puff, 0.1));
  }
  let ndv = max(dot(n, v), 1e-3);
  let spin = spinZ(frame.envSpin);
  let irradiance = irradianceAt(n, world);
  // each light carries its own shadow: the sky's the baked occlusion, the
  // key's its shadow map — the key doesn't darken where the sky can't reach
  let keyLit = keyShadowAt(world, vec3f(0.0, 0.0, 1.0));
  var key = keyDiffuse(n) * frame.keyColour * keyLit;
  var rig: RigLit;
  rig.diffuse = vec3f(0.0);
  rig.specular = vec3f(0.0);
  if (frame.rigCount > 0.0) {
    rig = rigAt(n, v, world, vec3f(0.04), clamp(surface.roughness, 0.05, 1.0), vec3f(0.0, 0.0, 1.0));
    key += rig.diffuse;
  }
  // dust: a cloth on a bench gathers it, a sparse scatter of pale flecks that
  // catch the light where the pile is dark
  var dust = 0.0;
  if (frame.detail > 0.0 && any(surface.sheen > vec3f(0.0))) {
    let cell = floor(world.xy * 3.0);
    let h = hash13(vec3f(cell, 4.0));
    let inCell = fract(world.xy * 3.0) - vec2f(hash13(vec3f(cell, 5.0)), hash13(vec3f(cell, 6.0)));
    let fleck = smoothstep(0.08, 0.03, length(inCell)) * step(0.82, h);
    dust = fleck * frame.detail * (0.5 + 0.5 * hash13(vec3f(cell, 7.0)));
  }
  let diffuse = mix(surface.albedo, vec3f(0.55, 0.52, 0.48), dust) * (irradiance * ao + key) * dipShade;
  // the table's own sheen: a dielectric's low highlight, dulled by roughness
  // and by the piece standing over it, so a waxed board holds a soft
  // reflection of the sky and the key while a cloth holds none
  let rough = clamp(surface.roughness, 0.05, 1.0);
  let ab = textureSampleLevel(envBrdf, linearSampler, vec2f(ndv, rough), 0.0).rg;
  let fresnel = vec3f(0.04) * ab.x + ab.y;
  // a satin's highlight streaks along its floats: bend the reflection toward
  // the weave the way a brushed metal's is bent toward the brush
  var reflectN = n;
  if (surface.aniso > 0.0) {
    let weave = vec3f(1.0, 0.0, 0.0);
    let anisoT = cross(weave, v);
    reflectN = normalize(mix(n, cross(anisoT, weave), surface.aniso * (1.0 - rough * 0.4)));
  }
  let reflected = reflectionAt(reflect(-v, reflectN), rough * frame.maxLod, world) * mix(ao, 1.0, 0.3);
  var specular = reflected * fresnel + keySpecular(reflectN, v, vec3f(0.04), rough) * keyLit + rig.specular;
  // a cloth's sheen: light coming back off the fibre tips, most at grazing
  // angles, in the fuzz's own colour — the velvet glow at the edge of a fold
  if (any(surface.sheen > vec3f(0.0))) {
    let rim = pow(1.0 - ndv, 4.0);
    let ldir = normalize(frame.keyDir);
    let h = normalize(ldir + v);
    let sinH = sqrt(max(1.0 - dot(n, h) * dot(n, h), 0.0));
    // Charlie's distribution: a broad lobe that peaks toward grazing
    let charlie = (2.0 + 1.0 / 0.6) * pow(sinH, 1.0 / 0.6) / 6.2831853;
    // and, like the sky's, it is a grazing effect: seen square-on the pile swallows it
    let keySheen = charlie * max(dot(n, ldir), 0.0) * frame.keyColour * frame.keyStrength * 0.6 * keyLit * (0.12 + 0.88 * rim);
    specular += surface.sheen * (irradiance * ao * (0.006 + 0.6 * rim * rim) + keySheen);
  }
  // the piece's own lights pool on the table under it
  let lamps = localLights(n, v, world, vec3f(0.04), rough, surface.albedo);
  var lit = (diffuse * (1.0 - fresnel) + specular + lamps) * exposure;
  if (cushion < 1.0) {
    // the table the cushion sits on: a dark matte, lit as the matte table is
    let matte = max(ground.background, vec3f(0.04, 0.04, 0.043));
    var flatKey = keyDiffuse(vec3f(0.0, 0.0, 1.0)) * frame.keyColour * keyLit;
    if (frame.rigCount > 0.0) { flatKey += rigAt(vec3f(0.0, 0.0, 1.0), v, world, vec3f(0.04), 1.0, vec3f(0.0, 0.0, 1.0)).diffuse; }
    let flat = matte * (irradianceAt(vec3f(0.0, 0.0, 1.0), world) * ao + flatKey) * exposure;
    lit = mix(flat, lit, cushion);
  }
  let fade = 1.0 - smoothstep(0.3, 1.0, length(local));
  var colour = mix(ground.background, lit, fade);
  return colour;
}
`;

export const PBR_WGSL = `
${FRAME_STRUCT}
${COMMON}
${MATERIAL_STRUCT}
${GROUND_STRUCT}
// the table, for reflections to meet: its record, its baked shadow, its cushion
@group(0) @binding(12) var<uniform> ground: Ground;
@group(0) @binding(13) var shadow: texture_2d<f32>;
@group(0) @binding(14) var cushionHeight: texture_2d<f32>;
${CUSHION_FIELD}
${TABLE_SURFACES}
${TABLE_LIT}

/**
 * What is seen in direction dir from p, with the table met exactly. The
 * probe holds the piece and the table as one cube from one point, corrected
 * for parallax against a sphere, and for the table — a plane, or a cushion's
 * lift over one — that correction puts its edge far from where it is. So a
 * reflection ray is run to the table itself, and where it lands within the
 * disc the table is shaded there, sharp for a polished face and given back
 * to the probe's blurred read as the face roughens.
 */
fn seen(dir: vec3f, lod: f32, p: vec3f) -> vec3f {
  let read = reflectionAt(dir, lod, p);
  // The ray has to be a direction before anything is worked out from it, and
  // the test is written so that one which is not fails rather than passes: a
  // NaN compares false against everything, so asking whether it points up
  // (dir.z >= -1e-4) lets it straight through. What follows would then
  // intersect it with the table and ask the table what it looks like at a
  // point that is not a point. Matte never reads that point, so it answered
  // anyway; every other table does, and answers NaN. The answer goes into the
  // light probe, the probe is prefiltered down a mip chain, and that chain is
  // what every reflective surface in the frame reads — so a single ray that
  // was never a direction turns the whole picture black, piece and table
  // alike. Found on a chess set: silver on walnut, and nothing on the screen.
  if (frame.probeOn < 0.5 || !(dir.z < -1e-4)) { return read; }
  let roughness = lod / max(frame.maxLod, 1.0);
  let sharp = 1.0 - smoothstep(0.3, 0.7, roughness);
  if (sharp <= 0.0) { return read; }
  let down = dir;
  var t = (ground.centre.z - p.z) / down.z;
  if (t <= 0.0) { return read; }
  var hit = p + down * t;
  var local = (hit.xy - ground.centre.xy) / ground.radius;
  if (ground.puff > 0.0 && max(abs(local.x), abs(local.y)) < 1.0) {
    // once more onto the cushion's lift where the ray came down
    t = (ground.centre.z + heightAt(local * 0.5 + 0.5) - p.z) / down.z;
    if (t <= 0.0) { return read; }
    hit = p + down * t;
    local = (hit.xy - ground.centre.xy) / ground.radius;
  }
  // beyond the disc there is only the page, as the tracer sees it; the probe's
  // table would reach there through its parallax, scalloped, and wrongly
  if (max(abs(local.x), abs(local.y)) >= 1.0) { return mix(read, ground.background, sharp); }
  // the grain blurs with the reflection's spread over the distance to it
  let foot = (t * roughness * 0.5 + 0.02) * frame.unitMm;
  // unexposed: the shader reading this applies the frame's exposure once, to everything
  let exact = tableLit(hit, local, -down, 1.0, foot, 1.0);
  return mix(read, exact, sharp);
}
@group(1) @binding(0) var<uniform> material: Material;
@group(1) @binding(3) var<storage, read> gemPlanes: array<vec4f>;
@group(1) @binding(1) var<storage, read> glyphs: array<Glyph>;
@group(1) @binding(2) var atlas: texture_2d<f32>;

struct VsIn {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) wear: f32,
  @location(4) im0: vec4f,
  @location(5) im1: vec4f,
  @location(6) im2: vec4f,
  @location(7) im3: vec4f,
  @location(8) face: vec2f,     // enamel, cap
  @location(9) selected: f32,
  @location(10) engrave: vec2f,  // surface millimetres, for engraving
  @builtin(vertex_index) vid: u32,
  @builtin(instance_index) iid: u32,
};

struct VsOut {
  // invariant, so the depth prepass and this pass agree to the bit
  @builtin(position) @invariant clip: vec4f,
  @location(0) normal: vec3f,
  @location(1) world: vec3f,
  @location(2) object: vec3f,
  @location(3) uv: vec2f,
  @location(4) ao: f32,
  @location(5) wear: f32,
  @location(6) enamel: f32,
  // which cap, and the flat plate's coordinates there; linear in uv, so exact
  @location(7) cap: f32,
  @location(8) plate: vec2f,
  // the part's own up and across, in world space: which way a stone is standing
  @location(9) axis: vec3f,
  @location(10) side: vec3f,
  @location(11) @interpolate(flat) selected: f32,
  @location(12) engrave: vec2f,
};

@vertex fn vsMain(in: VsIn) -> VsOut {
  let inst = mat4x4f(in.im0, in.im1, in.im2, in.im3);
  let world = inst * vec4f(in.position, 1.0);

  // baked visibility, one pair of fixed-point sums per (placement, vertex)
  let index = material.occlusionBase + in.iid * material.vertexCount + in.vid;
  let r = f32(occlusion[2u * index]);
  let g = f32(occlusion[2u * index + 1u]);
  let ao = select(1.0, clamp(r / g, 0.0, 1.0), g > 0.0);

  var out: VsOut;
  out.clip = frame.viewProj * world;
  out.selected = in.selected;
  // placements are rigid with uniform scale, so rotating the normal is exact
  out.normal = normalize(mat3x3f(inst[0].xyz, inst[1].xyz, inst[2].xyz) * in.normal);
  out.world = world.xyz;
  out.object = in.position;
  out.uv = in.uv;
  out.ao = mix(1.0, ao, frame.occlusionOn);
  out.wear = in.wear;
  out.enamel = in.face.x * select(0.0, 1.0, material.enamelOpacity > 0.0);
  out.cap = in.face.y;
  out.plate = material.reliefSpan.xy + in.uv * material.reliefSpan.zw;
  out.engrave = in.engrave;
  let frame3 = mat3x3f(inst[0].xyz, inst[1].xyz, inst[2].xyz);
  out.axis = normalize(frame3 * vec3f(0.0, 0.0, 1.0));
  out.side = normalize(frame3 * vec3f(1.0, 0.0, 0.0));
  return out;
}

// Tangent frame from screen-space derivatives: u runs along a sweep and around
// a revolve, so dP/du is the brush direction of a finish.
fn tangentFrame(n: vec3f, p: vec3f, uv: vec2f) -> mat3x3f {
  let dp1 = dpdx(p); let dp2 = dpdy(p);
  let duv1 = dpdx(uv); let duv2 = dpdy(uv);
  let dp2perp = cross(dp2, n);
  let dp1perp = cross(n, dp1);
  let t = dp2perp * duv1.x + dp1perp * duv2.x;
  let b = dp2perp * duv1.y + dp1perp * duv2.y;
  let inv = inverseSqrt(max(dot(t, t), dot(b, b)) + 1e-12);
  return mat3x3f(t * inv, b * inv, n);
}
${MATERIAL_FIELDS}
${PBR_MAIN}
`;

export const GROUND_WGSL = `
${FRAME_STRUCT}
${COMMON}
${GROUND_STRUCT}
@group(1) @binding(0) var<uniform> ground: Ground;
@group(1) @binding(2) var cushionHeight: texture_2d<f32>;
${CUSHION_FIELD}
${TABLE_SURFACES}
@group(1) @binding(1) var shadow: texture_2d<f32>;
${TABLE_LIT}

struct VsOut { @builtin(position) clip: vec4f, @location(0) local: vec2f, @location(1) world: vec3f };

@vertex fn vsMain(@location(0) position: vec3f) -> VsOut {
  var out: VsOut;
  out.local = position.xy;
  // a cushion rises out of the disc by its baked height
  let lift = select(0.0, heightAt(position.xy * 0.5 + 0.5), ground.puff > 0.0);
  let world = ground.centre + vec3f(position.xy * ground.radius, lift);
  out.world = world;
  out.clip = frame.viewProj * vec4f(world, 1.0);
  return out;
}

@fragment fn fsMain(in: VsOut) -> @location(0) vec4f {
  let v = normalize(frame.cameraPos - in.world);
  var colour = tableLit(in.world, in.local, v, contactAt(in.clip), length(fwidth(in.world.xy)) * frame.unitMm, frame.exposure);
  let acc = textureSample(shadow, linearSampler, in.local * 0.5 + 0.5).rg;
  let ao = select(1.0, clamp(acc.r / acc.g, 0.0, 1.0), acc.g > 0.0) * contactAt(in.clip);
  if (frame.debug > 5.5 && frame.debug < 6.5) { colour = vec3f(ao); }
  else if (frame.debug > 0.5) { colour = ground.background; }
  // distance to the eye for the depth of field pass, negated: the table
  // marks itself so it can be kept no sharper than the piece on it
  return vec4f(colour, -length(in.world - frame.cameraPos));
}
`;

/**
 * Depth only, ahead of the scene pass. The scene's fragment shader is not
 * cheap — noise for patina and wear, a planished normal — and a rose is forty
 * petals deep: without a prepass most of that work is done for surfaces a
 * nearer petal then covers.
 */
export const PREPASS_WGSL = `
${FRAME_STRUCT}
struct PrepassOut { @builtin(position) @invariant clip: vec4f };
@vertex fn vsMain(
  @location(0) position: vec3f,
  @location(4) im0: vec4f, @location(5) im1: vec4f, @location(6) im2: vec4f, @location(7) im3: vec4f,
) -> PrepassOut {
  // the same expression, in the same order, as the scene pass
  let inst = mat4x4f(im0, im1, im2, im3);
  let world = inst * vec4f(position, 1.0);
  var out: PrepassOut;
  out.clip = frame.viewProj * world;
  return out;
}
// the pass has a colour target, so the pipeline must name it; the write mask is zero
@fragment fn fsMain() -> @location(0) vec4f { return vec4f(0.0); }
`;

export const ANCHOR_WGSL = `
${FRAME_STRUCT}
struct VsOut { @builtin(position) clip: vec4f, @location(0) colour: vec3f, @location(1) world: vec3f };
@vertex fn vsMain(@location(0) position: vec3f, @location(1) colour: vec3f) -> VsOut {
  var out: VsOut;
  out.clip = frame.viewProj * vec4f(position, 1.0);
  out.colour = colour;
  out.world = position;
  return out;
}
// alpha carries the distance to the eye, as the piece's does, so the depth
// of field blurs a line by where it stands rather than smearing every one
@fragment fn fsMain(in: VsOut) -> @location(0) vec4f { return vec4f(in.colour, length(frame.cameraPos - in.world)); }
`;
