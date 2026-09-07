/**
 * A progressive path tracer for final quality.
 *
 * The raster path shades each point once, from a baked sky, one probe and a
 * few shadow maps, and every one of those is a stand-in for light that went
 * somewhere else first. This traces the light instead: a ray per pixel per
 * sample from a thin lens, bounced through the piece by its own materials,
 * with the key and the rig sampled as the discs they are and the sky read
 * where a path escapes. Interreflection, soft shadows, the colour a gold
 * ring throws on the table, refraction through a stone — all of it falls
 * out of the same loop, and the picture converges while the view is still.
 *
 * The scene is a bounding-volume hierarchy built on the CPU (bvh.ts). The
 * materials are the raster shader's own records and field functions — the
 * relief, engraving, lettering and wires are the same code, read from a
 * private copy of the record at each hit — so what is drawn is the same
 * piece, lit honestly.
 *
 * Each sample adds to a float accumulation and the mean is written into the
 * post chain's scene target, so bloom and the film pass follow as they do
 * for a raster frame.
 */
import { shader, type Gpu } from '../gpu/context';
import { COMMON, CUSHION_FIELD, FRAME_STRUCT, GROUND_STRUCT, MATERIAL_FIELDS, MATERIAL_STRUCT, TABLE_SURFACES } from './shaders';
import type { TracedScene } from './bvh';

const TRACE_WGSL = `
${FRAME_STRUCT}
${COMMON}
${MATERIAL_STRUCT}
// the material code reads reflections through this; the tracer traces the table itself
fn seen(dir: vec3f, lod: f32, p: vec3f) -> vec3f { return reflectionAt(dir, lod, p); }
// the raster shader's records, all of them at once: a slot is one record at its stride
struct MaterialSlot { m: Material, pad: array<vec4f, 15> };
@group(1) @binding(0) var<storage, read> materials: array<MaterialSlot>;
@group(1) @binding(1) var<storage, read> glyphs: array<Glyph>;
@group(1) @binding(2) var atlas: texture_2d<f32>;
@group(1) @binding(3) var<storage, read> gemPlanes: array<vec4f>;
// the field functions read the record through this name, as the raster shader does
var<private> material: Material;
${MATERIAL_FIELDS}
${GROUND_STRUCT}
@group(2) @binding(7) var<uniform> ground: Ground;
@group(2) @binding(11) var cushionHeight: texture_2d<f32>;
// the sky's cumulative distribution over the sample cube's texels, 256 to a row
@group(2) @binding(12) var skyCdf: texture_2d<f32>;
${CUSHION_FIELD}
${TABLE_SURFACES}

/** The cushion's height over the table at a point, 0 beyond the disc, where there is only table. */
fn cushionAt(xy: vec2f) -> f32 {
  let local = (xy - ground.centre.xy) / ground.radius;
  if (max(abs(local.x), abs(local.y)) >= 1.0) { return 0.0; }
  return heightAt(local * 0.5 + 0.5);
}

/**
 * Where a ray meets the cushion: the height field marched through the thin
 * slab it lives in, the crossing then bisected. The slab is a few
 * millimetres, so the steps are fine along any ray that is not grazing; a
 * grazing one may skip a collar narrower than its stride, which is the
 * cost of not tracing the bake's mesh.
 */
fn cushionHit(o: vec3f, d: vec3f, tMax: f32) -> f32 {
  let zLo = ground.centre.z - 0.3 * ground.puff;
  let zHi = ground.centre.z + ground.puff;
  if (abs(d.z) < 1e-6) { return 1e30; }
  var tA = (zHi - o.z) / d.z;
  var tB = (zLo - o.z) / d.z;
  let tIn = max(min(tA, tB), 1e-4);
  let tOut = min(max(tA, tB), tMax);
  if (tIn >= tOut) { return 1e30; }
  let steps = 48;
  let dt = (tOut - tIn) / f32(steps);
  var tPrev = tIn;
  var p = o + d * tPrev;
  var fPrev = p.z - ground.centre.z - cushionAt(p.xy);
  if (fPrev <= 0.0) { return 1e30; }   // starting under the cloth: nothing to meet
  for (var i = 1; i <= steps; i++) {
    let t = tIn + dt * f32(i);
    p = o + d * t;
    let f = p.z - ground.centre.z - cushionAt(p.xy);
    if (f <= 0.0) {
      var a = tPrev; var b = t;
      for (var k = 0; k < 6; k++) {
        let m = 0.5 * (a + b);
        let q = o + d * m;
        if (q.z - ground.centre.z - cushionAt(q.xy) <= 0.0) { b = m; } else { a = m; }
      }
      return 0.5 * (a + b);
    }
    tPrev = t; fPrev = f;
  }
  return 1e30;
}

struct Node { min: vec3f, left: u32, max: vec3f, count: u32 };
struct Tri { a: u32, b: u32, c: u32, group: u32 };
struct GroupInfo { attrBase: u32, flatBase: u32, vertexCount: u32, instBase: u32 };
struct Params {
  origin: vec3f,
  sample: u32,
  forward: vec3f,
  tanHalf: f32,
  right: vec3f,
  aspect: f32,
  up: vec3f,
  aperture: f32,
  focus: f32,
  bounces: u32,
  width: u32,
  height: u32,
  groundOn: f32,
  pixelAngle: f32,   // radians a pixel subtends
  seed: u32,
  triangles: u32,
  shift: vec2f,     // the lens shift, as the projection applies it
  rowOffset: u32,   // the first row of this dispatch's band
  eps: f32,         // the step off a surface before the next ray: a fiftieth of a millimetre, in world units
  skyCount: u32,    // texels in the sky's distribution; 0 before there is one
  skySize: u32,     // the sample cube's face size
  _r0: u32,
  _r1: u32,
};
@group(2) @binding(0) var<uniform> params: Params;
@group(2) @binding(1) var<storage, read> nodes: array<Node>;
@group(2) @binding(2) var<storage, read> tris: array<Tri>;
@group(2) @binding(3) var<storage, read> positions: array<f32>;
@group(2) @binding(4) var<storage, read> attrs: array<f32>;
// the groups are few, and a uniform keeps the storage buffers within the stage's limit
struct Groups { items: array<vec4u, 256> };
@group(2) @binding(5) var<uniform> groupTable: Groups;
@group(2) @binding(6) var<storage, read> inverses: array<mat4x4f>;
@group(2) @binding(8) var accumIn: texture_2d<f32>;
@group(2) @binding(9) var accumOut: texture_storage_2d<rgba32float, write>;
@group(2) @binding(10) var output: texture_storage_2d<rgba16float, write>;

const ATTR: u32 = 12u;
const PI: f32 = 3.14159265;

// --- randomness: a PCG stream per pixel and sample ---
var<private> rng: u32;
fn pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
fn rand() -> f32 {
  rng = pcg(rng);
  return f32(rng) / 4294967296.0;
}

// --- the scene ---
fn pos(i: u32) -> vec3f { return vec3f(positions[i * 3u], positions[i * 3u + 1u], positions[i * 3u + 2u]); }

struct Hit { t: f32, u: f32, v: f32, tri: u32, ground: bool };

fn slab(o: vec3f, invD: vec3f, lo: vec3f, hi: vec3f, tMax: f32) -> f32 {
  let t0 = (lo - o) * invD;
  let t1 = (hi - o) * invD;
  let tmin = min(t0, t1);
  let tmax = max(t0, t1);
  let near = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));
  let far = min(min(tmax.x, tmax.y), min(tmax.z, tMax));
  return select(1e30, near, near <= far);
}

fn triHit(o: vec3f, d: vec3f, i: u32, tMax: f32) -> vec3f {
  let t = tris[i];
  let p0 = pos(t.a); let p1 = pos(t.b); let p2 = pos(t.c);
  let e1 = p1 - p0; let e2 = p2 - p0;
  let h = cross(d, e2);
  let a = dot(e1, h);
  if (abs(a) < 1e-9) { return vec3f(-1.0); }
  let f = 1.0 / a;
  let s = o - p0;
  let u = f * dot(s, h);
  if (u < 0.0 || u > 1.0) { return vec3f(-1.0); }
  let q = cross(s, e1);
  let v = f * dot(d, q);
  if (v < 0.0 || u + v > 1.0) { return vec3f(-1.0); }
  let tt = f * dot(e2, q);
  if (tt <= 1e-4 || tt >= tMax) { return vec3f(-1.0); }
  return vec3f(tt, u, v);
}

fn trace(o: vec3f, d: vec3f, tMaxIn: f32) -> Hit {
  var hit: Hit;
  hit.t = tMaxIn; hit.tri = 0xffffffffu; hit.ground = false;
  // the table first, so the rest of the walk can stop short of it: a plane,
  // or the cushion's height field where there is one
  if (params.groundOn > 0.5 && abs(d.z) > 1e-6) {
    let t = select((ground.centre.z - o.z) / d.z, cushionHit(o, d, hit.t), ground.puff > 0.0);
    if (t > 1e-4 && t < hit.t) { hit.t = t; hit.ground = true; }
  }
  if (params.triangles == 0u) { return hit; }
  let invD = 1.0 / select(d, vec3f(1e-9), abs(d) < vec3f(1e-9));
  var stack: array<u32, 32>;
  var sp = 0;
  var node = 0u;
  loop {
    let n = nodes[node];
    if (n.count > 0u) {
      for (var i = 0u; i < n.count; i++) {
        let r = triHit(o, d, n.left + i, hit.t);
        if (r.x > 0.0) { hit.t = r.x; hit.u = r.y; hit.v = r.z; hit.tri = n.left + i; hit.ground = false; }
      }
      if (sp == 0) { break; }
      sp--; node = stack[sp];
      continue;
    }
    let l = n.left; let r = n.left + 1u;
    let nl = nodes[l]; let nr = nodes[r];
    var tl = slab(o, invD, nl.min, nl.max, hit.t);
    var tr = slab(o, invD, nr.min, nr.max, hit.t);
    var first = l; var second = r;
    if (tr < tl) { first = r; second = l; let tmp = tl; tl = tr; tr = tmp; }
    if (tl >= 1e30) {
      if (sp == 0) { break; }
      sp--; node = stack[sp];
      continue;
    }
    if (tr < 1e30 && sp < 32) { stack[sp] = second; sp++; }
    node = first;
  }
  return hit;
}

fn occluded(o: vec3f, d: vec3f, tMax: f32) -> bool {
  let h = trace(o, d, tMax);
  return h.t < tMax;
}

// --- a hit, made into a surface ---
struct Surf {
  p: vec3f,
  n: vec3f,       // shading normal, toward the incoming ray's side
  ng: vec3f,      // geometric, the same side
  f0: vec3f,
  roughness: f32,
  metallic: f32,
  body: vec3f,    // diffuse albedo under everything
  emission: vec3f,
  coat: f32,      // an enamel's glass, 0..1
  coatRough: f32,
  coatBody: vec3f,     // what the glass covers: the enamel's own colour, by its opacity
  coatThrough: vec3f,  // and what of the metal shows through it
  gem: bool,
  ior: f32,
  absorb: vec3f,  // per mm inside a stone
  dispersion: f32,
  inside: bool,
  /** How much of the table is table here: the disc fades to the page's colour at its rim. */
  fade: f32,
};

fn attr(i: u32, k: u32) -> f32 { return attrs[i * ATTR + k]; }

fn surfaceAt(hit: Hit, o: vec3f, d: vec3f, dist: f32) -> Surf {
  var s: Surf;
  s.p = o + d * hit.t;
  s.emission = vec3f(0.0);
  s.coat = 0.0; s.gem = false; s.inside = false; s.fade = 1.0;
  s.metallic = 0.0; s.ior = 1.5; s.absorb = vec3f(0.0); s.dispersion = 0.0;
  let foot = params.pixelAngle * dist;   // the pixel's footprint here, in world units
  if (hit.ground) {
    let local = (s.p.xy - ground.centre.xy) / ground.radius;
    s.fade = 1.0 - smoothstep(0.3, 1.0, length(local));
    let surface = tableSurface(s.p.xy * frame.unitMm, foot * frame.unitMm);
    s.ng = vec3f(0.0, 0.0, 1.0);
    s.n = normalize(surface.normal);
    s.body = surface.albedo;
    if (ground.puff > 0.0) {
      // the cushion's normal from its height's slope, the cloth's own laid
      // over it, and the fold where the piece has pressed the cloth down —
      // as the ground pass shades it
      let uv = local * 0.5 + 0.5;
      let step = 1.0 / f32(textureDimensions(cushionHeight).x);
      let run = 2.0 * ground.radius * step;
      let dx = (heightAt(uv + vec2f(step, 0.0)) - heightAt(uv - vec2f(step, 0.0))) / (2.0 * run);
      let dy = (heightAt(uv + vec2f(0.0, step)) - heightAt(uv - vec2f(0.0, step))) / (2.0 * run);
      let slopeN = normalize(vec3f(-dx, -dy, 1.0));
      s.ng = slopeN;
      s.n = normalize(vec3f(slopeN.xy + s.n.xy * 0.6, slopeN.z));
      let pressed = clamp((domeAt(local) - heightAt(uv)) / max(ground.puff, 0.1), 0.0, 1.0);
      // beyond the cushion's rim there is only the dark matte table under it
      let onCushion = smoothstep(0.0, 0.15, domeAt(local) / max(ground.puff, 0.1));
      s.body = mix(vec3f(0.04, 0.04, 0.043), s.body * (1.0 - 0.45 * pressed), onCushion);
    }
    s.f0 = vec3f(0.04);
    s.roughness = clamp(surface.roughness, 0.05, 1.0);
    return s;
  }
  let tri = tris[hit.tri];
  let gi = groupTable.items[tri.group];
  let g = GroupInfo(gi.x, gi.y, gi.z, gi.w);
  material = materials[tri.group].m;
  let inst = (tri.a - g.flatBase) / g.vertexCount;
  let ia = g.attrBase + (tri.a - g.flatBase) % g.vertexCount;
  let ib = g.attrBase + (tri.b - g.flatBase) % g.vertexCount;
  let ic = g.attrBase + (tri.c - g.flatBase) % g.vertexCount;
  let w = vec3f(1.0 - hit.u - hit.v, hit.u, hit.v);
  let inv = inverses[g.instBase + inst];
  let rot = transpose(mat3x3f(inv[0].xyz, inv[1].xyz, inv[2].xyz));   // inverse transpose: normals to world
  let na = vec3f(attr(ia, 0u), attr(ia, 1u), attr(ia, 2u));
  let nb = vec3f(attr(ib, 0u), attr(ib, 1u), attr(ib, 2u));
  let nc = vec3f(attr(ic, 0u), attr(ic, 1u), attr(ic, 2u));
  var n = normalize(rot * (na * w.x + nb * w.y + nc * w.z));
  let p0 = pos(tri.a); let p1 = pos(tri.b); let p2 = pos(tri.c);
  var ng = normalize(cross(p1 - p0, p2 - p0));
  if (dot(ng, n) < 0.0) { ng = -ng; }
  let front = dot(ng, d) < 0.0;
  if (!front) { n = -n; ng = -ng; s.inside = true; }

  let uv = vec2f(attr(ia, 3u), attr(ia, 4u)) * w.x + vec2f(attr(ib, 3u), attr(ib, 4u)) * w.y + vec2f(attr(ic, 3u), attr(ic, 4u)) * w.z;
  let engrave = vec2f(attr(ia, 5u), attr(ia, 6u)) * w.x + vec2f(attr(ib, 5u), attr(ib, 6u)) * w.y + vec2f(attr(ic, 5u), attr(ic, 6u)) * w.z;
  let enamel = (attr(ia, 7u) * w.x + attr(ib, 7u) * w.y + attr(ic, 7u) * w.z) * select(0.0, 1.0, material.enamelOpacity > 0.0);
  let cap = attr(ia, 8u) * w.x + attr(ib, 8u) * w.y + attr(ic, 8u) * w.z;
  let wear = attr(ia, 9u) * w.x + attr(ib, 9u) * w.y + attr(ic, 9u) * w.z;
  let object = (inv * vec4f(s.p, 1.0)).xyz;
  let plate = material.reliefSpan.xy + uv * material.reliefSpan.zw;
  let objectScale = length(inv[0].xyz);
  let plateFootprint = max(0.75 * foot, 0.005 / frame.unitMm);
  let engraveFootprint = max(0.75 * foot, 0.005 / frame.unitMm);
  let objectFootprint = foot * objectScale;
  // the part's own coordinates in millimetres, which the fine detail is sized in
  let objMm = object * frame.unitMm;
  let objectFootprintMm = objectFootprint * frame.unitMm;

  // tangent frames from the triangle's own edges, for uv and for the engraving coordinates
  let e1 = p1 - p0; let e2 = p2 - p0;
  let uva = vec2f(attr(ia, 3u), attr(ia, 4u)); let uvb = vec2f(attr(ib, 3u), attr(ib, 4u)); let uvc = vec2f(attr(ic, 3u), attr(ic, 4u));
  var tbn = frameFrom(n, e1, e2, uvb - uva, uvc - uva);
  let ea = vec2f(attr(ia, 5u), attr(ia, 6u)); let eb = vec2f(attr(ib, 5u), attr(ib, 6u)); let ec = vec2f(attr(ic, 5u), attr(ic, 6u));
  let engraveFrame = frameFrom(n, e1, e2, eb - ea, ec - ea);
  let sign = select(1.0, -1.0, !front);

  // --- the same bends the raster shader makes: relief, engraving, lettering ---
  if (material.relief > 0.0 && abs(cap) > 0.5) {
    let eps = material.reliefHalfWidth * 1e-3;
    let fx = (reliefHeight(plate.x + eps, plate.y) - reliefHeight(plate.x - eps, plate.y)) / (2.0 * eps);
    let fy = (reliefHeight(plate.x, plate.y + eps) - reliefHeight(plate.x, plate.y - eps)) / (2.0 * eps);
    let t = normalize(tbn[0] - n * dot(tbn[0], n));
    let b = normalize(tbn[1] - n * dot(tbn[1], n));
    n = normalize(n - cap * (fx * t + fy * b) * sign);
    tbn = mat3x3f(normalize(t - n * dot(t, n)), normalize(b - n * dot(b, n)), n);
  }
  if (material.pattern > 0u && (material.patternFaces > 0u || abs(cap) > 0.5)) {
    let pitch = material.patternParams.x;
    let fade = 1.0 - smoothstep(0.12, 0.45, engraveFootprint / pitch);
    let depth = material.patternParams.y * fade;
    if (depth != 0.0) {
      let eps = pitch * 0.02;
      let fx = (engraveHeight(engrave.x + eps, engrave.y, depth) - engraveHeight(engrave.x - eps, engrave.y, depth)) / (2.0 * eps);
      let fy = (engraveHeight(engrave.x, engrave.y + eps, depth) - engraveHeight(engrave.x, engrave.y - eps, depth)) / (2.0 * eps);
      let t = normalize(engraveFrame[0] - n * dot(engraveFrame[0], n));
      let b = normalize(engraveFrame[1] - n * dot(engraveFrame[1], n));
      n = normalize(n - sign * (fx * t + fy * b));
      tbn = mat3x3f(normalize(tbn[0] - n * dot(tbn[0], n)), normalize(tbn[1] - n * dot(tbn[1], n)), n);
    }
  }
  var letterFloor = 0.0;
  if (material.glyphCount > 0u && (material.patternFaces > 0u || abs(cap) > 0.5)) {
    let eps = max(0.02, material.letterSpread * 0.08);
    let h0 = letterHeight(engrave);
    let fx = (letterHeight(engrave + vec2f(eps, 0.0)) - letterHeight(engrave - vec2f(eps, 0.0))) / (2.0 * eps);
    let fy = (letterHeight(engrave + vec2f(0.0, eps)) - letterHeight(engrave - vec2f(0.0, eps))) / (2.0 * eps);
    let t = normalize(engraveFrame[0] - n * dot(engraveFrame[0], n));
    let b = normalize(engraveFrame[1] - n * dot(engraveFrame[1], n));
    n = normalize(n - sign * (fx * t + fy * b));
    tbn = mat3x3f(normalize(tbn[0] - n * dot(tbn[0], n)), normalize(tbn[1] - n * dot(tbn[1], n)), n);
    letterFloor = select(0.0, clamp(-h0 / material.letter.x, 0.0, 1.0), material.letter.x != 0.0);
  }

  var roughness = material.roughness;
  var f0 = material.f0;
  var metallic = 1.0;
  if (letterFloor > 0.0) { roughness = mix(roughness, max(roughness, 0.42), letterFloor); }
  let nacre = material.model == 1u;
  if (nacre) { roughness = max(roughness, 0.18); }
  let gemstone = material.model == 2u;
  if (gemstone) { roughness = min(roughness, 0.04); }
  let plastic = material.model == 3u;
  let wood = material.model == 4u;
  let light = material.model == 5u;
  let worked = !nacre && !gemstone && !plastic && !wood && !light;

  if (material.hammer > 0.0 && worked) {
    let p = objMm * 0.55;
    let eps = 0.35;
    let h0 = planish(p);
    let hx = planish(p + tbn[0] * eps);
    let hy = planish(p + tbn[1] * eps);
    let bump = (tbn[0] * (hx - h0) + tbn[1] * (hy - h0)) / eps;
    n = normalize(n - bump * material.hammer * 0.22);
  }
  let swirlFade = 1.0 - smoothstep(0.025, 0.08, objectFootprintMm);
  if (frame.detail > 0.0 && worked && material.roughness < 0.35 && enamel < 0.5) {
    let q = objMm;
    let turn = noise3(q * 0.09) * 6.2831853;
    let ca = cos(turn); let sa = sin(turn);
    let s1 = q.x * ca + q.y * sa + q.z * 0.37;
    let s2 = -q.x * sa + q.y * ca * 0.8 + q.z * 0.61;
    let scratch = abs(sin(s1 * 38.0 + noise3(q * 3.1) * 4.0)) * 0.6 + abs(sin(s2 * 53.0 + noise3(q * 2.3) * 4.0)) * 0.4;
    let smudge = smoothstep(0.55, 0.85, noise3(q * 0.23 + vec3f(7.0, 3.0, 1.0)) * 0.7 + noise3(q * 0.6) * 0.3);
    let amount = frame.detail * smoothstep(0.35, 0.05, material.roughness);
    roughness += amount * (0.03 * mix(0.5, 1.0 - scratch, swirlFade) + 0.11 * smudge);
    let eps = 0.05;
    let sx = abs(sin((s1 + eps) * 38.0 + noise3(q * 3.1) * 4.0)) - abs(sin((s1 - eps) * 38.0 + noise3(q * 3.1) * 4.0));
    n = normalize(n + tbn[0] * sx * amount * 0.012 * swirlFade);
  }
  if (material.patina > 0.0 && worked) {
    let blotch = noise3(objMm * 0.32) * 0.65 + noise3(objMm * 0.9) * 0.35;
    let mask = smoothstep(0.62 - material.patina * 0.55, 0.78 - material.patina * 0.3, blotch);
    metallic = mix(1.0, 0.0, mask * material.patina);
    f0 = mix(f0, vec3f(0.04), mask * material.patina);
    roughness = mix(roughness, min(roughness + 0.35, 0.95), mask * material.patina);
  }
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
  let wearOn = select(material.wear, 0.0, !worked);
  let edge = smoothstep(0.05, 0.8, wear) * wearOn;
  var crease = smoothstep(0.05, 0.8, -wear) * wearOn;
  if (crease > 0.0) { crease *= 0.7 + 0.6 * noise3(objMm * 1.7); }
  roughness = mix(roughness, roughness * 0.45, edge);
  roughness = mix(roughness, min(roughness + 0.3, 0.95), crease);
  f0 = mix(f0, f0 * 0.55, crease * 0.8);
  metallic = mix(metallic, metallic * 0.6, crease * 0.6);
  roughness = clamp(roughness, 0.03, 1.0);

  // the shading normal must not lean past the geometric one, or a ray leaves the wrong way
  if (dot(n, ng) < 0.05) { n = normalize(n + ng * (0.05 - dot(n, ng))); }
  s.n = n; s.ng = ng;
  s.f0 = f0; s.roughness = roughness; s.metallic = metallic;
  s.body = material.patinaColour * (1.0 - metallic);

  if (nacre) {
    s.metallic = 0.0;
    s.f0 = material.f0;
    s.body = material.baseColour * 0.55 * mix(vec3f(1.0), orientTint(max(dot(n, -d), 0.0), material.orient), 0.3);
  } else if (gemstone) {
    s.gem = true;
    s.ior = max(material.gemIor, 1.05);
    s.dispersion = material.gemDispersion;
    let size = max(material.gemSize, 0.5 / frame.unitMm);
    s.absorb = -log(clamp(material.baseColour, vec3f(1e-3), vec3f(1.0))) / size;
    s.f0 = vec3f(pow((s.ior - 1.0) / (s.ior + 1.0), 2.0));
    s.metallic = 0.0; s.body = vec3f(0.0);
  } else if (light) {
    s.emission = material.emission.rgb;
    s.f0 = vec3f(0.04); s.metallic = 0.0; s.body = vec3f(0.0);
    s.roughness = max(roughness, 0.08);
  } else if (plastic || wood) {
    var body = material.baseColour;
    if (wood) {
      let p = objMm;
      let wobble = noise3(vec3f(p.x * 0.35, p.y * 0.35, p.z * 0.03)) * 2.6
        + noise3(vec3f(p.x * 1.3, p.y * 1.3, p.z * 0.11)) * 0.6;
      let ringCoord = (p.x * 0.94 + p.y * 0.34) * 1.9 + wobble;
      let ph = fract(ringCoord);
      let ringFoot = clamp(objectFootprintMm * 2.85, 0.02, 0.5);
      let late = smoothstep(0.42 - ringFoot, 0.62 + ringFoot, ph) * (1.0 - smoothstep(0.78 - ringFoot, 0.96 + ringFoot, ph));
      let fibre = noise3(vec3f(p.x * 5.5, p.y * 5.5, p.z * 0.4)) - 0.5;
      let strength = material.orient;
      body = material.baseColour
        * (1.0 + 0.5 * strength * fibre)
        * mix(1.0 + 0.3 * strength, 1.0 - 1.3 * strength, late)
        * mix(vec3f(1.0), vec3f(0.92, 0.78, 0.66), late);
    }
    s.f0 = vec3f(0.04); s.metallic = 0.0; s.body = body;
  }

  // enamel: a glass coat over its own colour, the metal showing through by its transparency
  if (enamel > 0.001 && !gemstone && !light) {
    s.coat = enamel;
    s.coatRough = ENAMEL_ROUGHNESS;
    s.coatBody = material.enamelColour * material.enamelOpacity;
    s.coatThrough = material.enamelColour * (1.0 - material.enamelOpacity);
    if (material.veinOn > 0.0) {
      let sdf = veinWire(plate.x, plate.y);
      let wire = (1.0 - smoothstep(-plateFootprint, plateFootprint, sdf)) * enamel;
      if (wire > 0.0) {
        let eps = 0.02;
        let gx = (veinWire(plate.x + eps, plate.y) - veinWire(plate.x - eps, plate.y)) / (2.0 * eps);
        let gy = (veinWire(plate.x, plate.y + eps) - veinWire(plate.x, plate.y - eps)) / (2.0 * eps);
        let t = normalize(tbn[0] - n * dot(tbn[0], n));
        let b = normalize(tbn[1] - n * dot(tbn[1], n));
        let across = gx * t + gy * b;
        let flat = 1.0 - smoothstep(0.012, 0.05, plateFootprint);
        let tilt = clamp(1.0 + sdf / 0.14, 0.0, 1.0) * 0.7 * flat;
        let wireN = normalize(n * sqrt(1.0 - tilt * tilt) + normalize(across + n * 1e-4) * tilt * sign);
        s.n = normalize(mix(s.n, wireN, wire));
        s.coat = mix(s.coat, 0.0, wire);
        s.f0 = mix(s.f0, material.veinF0, wire);
        s.metallic = mix(s.metallic, 1.0, wire);
        s.roughness = mix(s.roughness, mix(0.55, 0.12, flat), wire);
        s.body = mix(s.body, vec3f(0.0), wire);
      }
    }
  }
  return s;
}

fn frameFrom(n: vec3f, e1: vec3f, e2: vec3f, d1: vec2f, d2: vec2f) -> mat3x3f {
  let det = d1.x * d2.y - d2.x * d1.y;
  var t: vec3f; var b: vec3f;
  if (abs(det) < 1e-12) {
    t = normalize(cross(n, select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(n.x) < 0.9)));
    b = cross(n, t);
    return mat3x3f(t, b, n);
  }
  let r = 1.0 / det;
  t = (e1 * d2.y - e2 * d1.y) * r;
  b = (e2 * d1.x - e1 * d2.x) * r;
  t = t - n * dot(t, n);
  b = b - n * dot(b, n);
  let inv = inverseSqrt(max(dot(t, t), dot(b, b)) + 1e-12);
  return mat3x3f(t * inv, b * inv, n);
}

// --- reflectance ---
fn fresnel(f0: vec3f, vdh: f32) -> vec3f { return f0 + (1.0 - f0) * pow(1.0 - vdh, 5.0); }
fn ggxD(ndh: f32, a: f32) -> f32 {
  let a2 = a * a;
  let dd = ndh * ndh * (a2 - 1.0) + 1.0;
  return a2 / (PI * dd * dd);
}
fn smithG1(ndx: f32, a: f32) -> f32 {
  let a2 = a * a;
  return 2.0 * ndx / (ndx + sqrt(a2 + (1.0 - a2) * ndx * ndx));
}
/** Sample the visible normals of a GGX lobe (Heitz), in the frame where z is the normal. */
fn sampleVndf(v: vec3f, a: f32, r1: f32, r2: f32) -> vec3f {
  let vh = normalize(vec3f(a * v.x, a * v.y, v.z));
  let lensq = vh.x * vh.x + vh.y * vh.y;
  let t1 = select(vec3f(1.0, 0.0, 0.0), vec3f(-vh.y, vh.x, 0.0) * inverseSqrt(lensq), lensq > 0.0);
  let t2 = cross(vh, t1);
  let r = sqrt(r1);
  let phi = 2.0 * PI * r2;
  let p1 = r * cos(phi);
  var p2 = r * sin(phi);
  let sa = 0.5 * (1.0 + vh.z);
  p2 = (1.0 - sa) * sqrt(max(1.0 - p1 * p1, 0.0)) + sa * p2;
  let nh = p1 * t1 + p2 * t2 + sqrt(max(0.0, 1.0 - p1 * p1 - p2 * p2)) * vh;
  return normalize(vec3f(a * nh.x, a * nh.y, max(0.0, nh.z)));
}
fn basis(n: vec3f) -> mat3x3f {
  let up = select(vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 0.0), abs(n.z) > 0.999);
  let t = normalize(cross(up, n));
  let b = cross(n, t);
  return mat3x3f(t, b, n);
}
fn cosineDir(n: vec3f, r1: f32, r2: f32) -> vec3f {
  let r = sqrt(r1);
  let phi = 2.0 * PI * r2;
  let local = vec3f(r * cos(phi), r * sin(phi), sqrt(max(0.0, 1.0 - r1)));
  return basis(n) * local;
}
fn coneDir(dir: vec3f, size: f32, r1: f32, r2: f32) -> vec3f {
  let cosT = 1.0 - r1 * (1.0 - cos(size));
  let sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
  let phi = 2.0 * PI * r2;
  return basis(normalize(dir)) * vec3f(sinT * cos(phi), sinT * sin(phi), cosT);
}

/**
 * The surface's reflectance for a pair of directions, and the density its
 * sampler would have drawn l with: the layers summed, and the lobes'
 * densities mixed by the same weights the sampler uses.
 */
struct Bsdf { f: vec3f, pdf: f32 };
fn lobeWeights(s: Surf, ndv: f32) -> vec3f {
  // coat, specular, diffuse
  let fc = s.coat * (0.04 + 0.96 * pow(1.0 - ndv, 5.0));
  let under = 1.0 - fc;
  let fs = dot(fresnel(s.f0, ndv), vec3f(0.333));
  let spec = under * mix(fs, 1.0, s.metallic);
  let diff = under * (1.0 - mix(fs, 1.0, s.metallic));
  let sum = max(fc + spec + diff, 1e-4);
  return vec3f(fc, spec, max(diff, 0.02 * under)) / sum;
}
fn evalBsdf(s: Surf, v: vec3f, l: vec3f) -> Bsdf {
  var out: Bsdf;
  out.f = vec3f(0.0); out.pdf = 0.0;
  let n = s.n;
  let ndv = max(dot(n, v), 1e-4);
  let ndl = dot(n, l);
  if (ndl <= 0.0) { return out; }
  let h = normalize(v + l);
  let ndh = max(dot(n, h), 0.0);
  let vdh = max(dot(v, h), 0.0);
  let wgt = lobeWeights(s, ndv);
  // the coat
  var throughCoat = vec3f(1.0);
  if (s.coat > 0.0) {
    let a = max(s.coatRough * s.coatRough, 0.002);
    let fc = 0.04 + 0.96 * pow(1.0 - vdh, 5.0);
    let d = ggxD(ndh, a);
    let g = smithG1(ndv, a) * smithG1(ndl, a);
    out.f += vec3f(fc * d * g / (4.0 * ndv * ndl)) * s.coat;
    out.pdf += wgt.x * d * smithG1(ndv, a) / (4.0 * ndv);
    let fcv = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
    let fcl = 0.04 + 0.96 * pow(1.0 - ndl, 5.0);
    throughCoat = mix(vec3f(1.0), vec3f((1.0 - fcv) * (1.0 - fcl)), s.coat);
  }
  // the specular under it
  {
    let a = max(s.roughness * s.roughness, 0.002);
    let d = ggxD(ndh, a);
    let g = smithG1(ndv, a) * smithG1(ndl, a);
    var f = fresnel(s.f0, vdh);
    // under an enamel the metal's highlight is dyed by the glass on its way in and out
    if (s.coat > 0.0) { f = f * mix(vec3f(1.0), s.coatThrough, s.coat); }
    out.f += throughCoat * f * d * g / (4.0 * ndv * ndl);
    out.pdf += wgt.y * d * smithG1(ndv, a) / (4.0 * ndv);
  }
  // the diffuse body, and an enamel's own colour under its glass
  let body = mix(s.body, s.coatBody, s.coat);
  out.f += throughCoat * body / PI;
  out.pdf += wgt.z * ndl / PI;
  return out;
}
/**
 * A bounce: the direction taken, its weight, and where the sky is read if
 * the ray escapes. The sampled direction decides what the ray hits; the
 * sky itself is read at the lobe's centre, blurred by the lobe, as the
 * raster path reads it — the sky's small bright lights would otherwise take
 * a thousand samples to settle on a satin surface.
 */
struct Sampled { l: vec3f, weight: vec3f, specular: bool, skyDir: vec3f, skyRough: f32, pdf: f32 };
fn sampleBsdf(s: Surf, v: vec3f) -> Sampled {
  var out: Sampled;
  let n = s.n;
  let ndv = max(dot(n, v), 1e-4);
  let wgt = lobeWeights(s, ndv);
  let r = rand();
  let frame = basis(n);
  var vl = transpose(frame) * v;
  vl = normalize(vec3f(vl.xy, max(vl.z, 0.05)));
  var l: vec3f;
  out.specular = false;
  if (r < wgt.x) {
    let a = max(s.coatRough * s.coatRough, 0.002);
    let h = frame * sampleVndf(vl, a, rand(), rand());
    l = reflect(-v, h);
    out.specular = s.coatRough < 0.15;
    out.skyDir = reflect(-v, n); out.skyRough = s.coatRough;
  } else if (r < wgt.x + wgt.y) {
    let a = max(s.roughness * s.roughness, 0.002);
    let h = frame * sampleVndf(vl, a, rand(), rand());
    l = reflect(-v, h);
    out.specular = s.roughness < 0.15;
    out.skyDir = reflect(-v, n); out.skyRough = s.roughness;
  } else {
    l = cosineDir(n, rand(), rand());
    out.skyDir = n; out.skyRough = 1.0;
  }
  out.l = l;
  let b = evalBsdf(s, v, l);
  let ndl = max(dot(n, l), 0.0);
  out.weight = select(vec3f(0.0), b.f * ndl / b.pdf, b.pdf > 1e-6 && ndl > 0.0);
  out.pdf = b.pdf;
  return out;
}

// --- the sky, sampled where its light is ---
fn skyCdfAt(i: i32) -> f32 { return textureLoad(skyCdf, vec2i(i % 256, i / 256), 0).r; }
fn cubeDir(face: i32, sc: f32, tc: f32) -> vec3f {
  var v: vec3f;
  switch (face) {
    case 0: { v = vec3f(1.0, -tc, -sc); }
    case 1: { v = vec3f(-1.0, -tc, sc); }
    case 2: { v = vec3f(sc, 1.0, tc); }
    case 3: { v = vec3f(sc, -1.0, -tc); }
    case 4: { v = vec3f(sc, -tc, 1.0); }
    default: { v = vec3f(-sc, -tc, -1.0); }
  }
  return normalize(v);
}
fn texelSolid(x: i32, y: i32, size: i32) -> f32 {
  let sc = (2.0 * (f32(x) + 0.5)) / f32(size) - 1.0;
  let tc = (2.0 * (f32(y) + 0.5)) / f32(size) - 1.0;
  return 4.0 / (f32(size * size) * pow(1.0 + sc * sc + tc * tc, 1.5));
}
fn texelMass(i: i32) -> f32 { return skyCdfAt(i) - select(0.0, skyCdfAt(i - 1), i > 0); }

struct SkySample { dir: vec3f, pdf: f32 };
/**
 * A direction drawn from the sky in proportion to its light: the texel by
 * the cumulative distribution, a point within it, and the density per
 * steradian that drew it. The distribution is in the cube's own frame; the
 * direction is turned back into the world's.
 */
fn sampleSky(r1: f32, r2: f32, r3: f32) -> SkySample {
  var out: SkySample;
  out.pdf = 0.0;
  let n = i32(params.skyCount);
  if (n == 0) { return out; }
  var lo = 0; var hi = n - 1;
  for (var k = 0; k < 20 && lo < hi; k++) {
    let mid = (lo + hi) / 2;
    if (skyCdfAt(mid) < r1) { lo = mid + 1; } else { hi = mid; }
  }
  let size = i32(params.skySize);
  let face = lo / (size * size);
  let rem = lo - face * size * size;
  let y = rem / size;
  let x = rem - y * size;
  let sc = (2.0 * (f32(x) + r2)) / f32(size) - 1.0;
  let tc = (2.0 * (f32(y) + r3)) / f32(size) - 1.0;
  out.dir = spinZ(-frame.envSpin) * cubeDir(face, sc, tc);
  out.pdf = texelMass(lo) / texelSolid(x, y, size);
  return out;
}
/** The density with which sampleSky would have drawn a world direction. */
fn skyPdf(dir: vec3f) -> f32 {
  let n = i32(params.skyCount);
  if (n == 0) { return 0.0; }
  let dc = spinZ(frame.envSpin) * dir;
  let a = abs(dc);
  var face = 0; var sc = 0.0; var tc = 0.0; var ma = 1.0;
  if (a.x >= a.y && a.x >= a.z) {
    ma = a.x;
    if (dc.x > 0.0) { face = 0; sc = -dc.z; tc = -dc.y; } else { face = 1; sc = dc.z; tc = -dc.y; }
  } else if (a.y >= a.z) {
    ma = a.y;
    if (dc.y > 0.0) { face = 2; sc = dc.x; tc = dc.z; } else { face = 3; sc = dc.x; tc = -dc.z; }
  } else {
    ma = a.z;
    if (dc.z > 0.0) { face = 4; sc = dc.x; tc = -dc.y; } else { face = 5; sc = -dc.x; tc = -dc.y; }
  }
  let size = i32(params.skySize);
  let x = clamp(i32((sc / ma + 1.0) * 0.5 * f32(size)), 0, size - 1);
  let y = clamp(i32((tc / ma + 1.0) * 0.5 * f32(size)), 0, size - 1);
  let i = (face * size + y) * size + x;
  return texelMass(i) / texelSolid(x, y, size);
}
/**
 * The sky's light at a point by next event: one direction drawn from the
 * sky's own distribution, tested for occlusion, and weighed against the
 * chance the surface's sampler would have found it, so the sun in a
 * daylight sky lands on a matte face in a handful of samples rather than
 * a thousand. Read sharp: this is the sky where the light is.
 */
fn skyLight(s: Surf, v: vec3f) -> vec3f {
  let sk = sampleSky(rand(), rand(), rand());
  if (sk.pdf <= 0.0) { return vec3f(0.0); }
  let l = sk.dir;
  let ndl = dot(s.n, l);
  if (ndl <= 0.0 || dot(s.ng, l) <= 0.0) { return vec3f(0.0); }
  if (occluded(s.p + s.ng * params.eps, l, 1e6)) { return vec3f(0.0); }
  let b = evalBsdf(s, v, l);
  let w = sk.pdf * sk.pdf / (sk.pdf * sk.pdf + b.pdf * b.pdf);
  return b.f * ndl * sky(l, 0.0) * w / sk.pdf;
}

// --- lights: the key and the rig as discs, sampled by next event ---
fn discLight(s: Surf, v: vec3f, dir: vec3f, size: f32, colour: vec3f, strength: f32) -> vec3f {
  if (strength <= 0.0) { return vec3f(0.0); }
  let l = coneDir(dir, max(size, 1e-3), rand(), rand());
  let ndl = dot(s.n, l);
  if (ndl <= 0.0 || dot(s.ng, l) <= 0.0) { return vec3f(0.0); }
  if (occluded(s.p + s.ng * params.eps, l, 1e6)) { return vec3f(0.0); }
  let b = evalBsdf(s, v, l);
  // the disc's irradiance, 3 in sky units per unit of strength, as the raster shader's
  return b.f * ndl * colour * strength * 3.0;
}
fn directLight(s: Surf, v: vec3f) -> vec3f {
  var sum = discLight(s, v, frame.keyDir, frame.keySize, frame.keyColour, frame.keyStrength);
  let count = i32(frame.rigCount);
  for (var i = 0; i < count; i++) {
    let l = frame.rig[i];
    sum += discLight(s, v, l.dir, l.size, l.colour, l.strength);
  }
  // the piece's own lights, as the small spheres the raster shader takes them for
  for (var i = 0u; i < lights.count; i++) {
    let light = lights.items[i];
    let to = light.position - s.p;
    let dist = length(to);
    if (dist <= light.radius * 1.5) { continue; }
    // a point on the sphere rather than its centre, so its shadow has the
    // penumbra its size gives it, as the raster's does
    let size = asin(min(light.radius / dist, 1.0));
    let l = coneDir(to / dist, size, rand(), rand());
    let ndl = dot(s.n, l);
    if (ndl <= 0.0 || dot(s.ng, l) <= 0.0) { continue; }
    if (occluded(s.p + s.ng * params.eps, l, dist - light.radius)) { continue; }
    let b = evalBsdf(s, v, l);
    sum += b.f * ndl * light.intensity / (dist * dist);
  }
  return sum;
}

// --- the sky where a path escapes ---
fn sky(d: vec3f, roughness: f32) -> vec3f {
  // read blurred by a roughness only while there is no distribution to
  // sample the sky by: then a rough bounce reads it blurred by its own
  // roughness, as the raster path does, for a great deal less noise at some
  // bias. With the distribution, every read is sharp.
  return env(spinZ(frame.envSpin) * d, roughness * frame.maxLod);
}

// --- one path ---
fn radiance(o0: vec3f, d0: vec3f) -> vec3f {
  var o = o0; var d = d0;
  var throughput = vec3f(1.0);
  var result = vec3f(0.0);
  var dist = 0.0;
  var lastSpecular = true;
  var skyDir = d0;
  var skyRough = 0.0;
  // once a path has scattered off something matte, what it goes on to see
  // of the sky is only ever a glow on that surface: read it blurred, or a
  // polished ring beside a table covers it in fireflies for a thousand samples
  var scattered = false;
  var inGem = false;
  var gemAbsorb = vec3f(0.0);
  var channel = -1;   // which channel a dispersed path carries, or all
  // whether the sky was sampled at the last surface, and the density the
  // surface's own sampler drew the bounce with: an escaped ray is then
  // weighed against the sky's density, the other half of the same estimate
  var skySampled = false;
  var lastPdf = 0.0;
  for (var bounce = 0u; bounce <= params.bounces; bounce++) {
    let hit = trace(o, d, 1e6);
    if (hit.tri == 0xffffffffu && !hit.ground) {
      // the sky lights the piece and shows in it; behind the piece the raster
      // path draws the page's colour, and so does this, so the two agree
      // With the sky's distribution to sample by, the sky is read sharp: the
      // blur below was the defence against fireflies from a matte bounce
      // finding a small bright light by chance, and the weighing against the
      // sky's density does that without the bias — measured against a
      // sharp reference, the blur was seven levels off in the studio, and
      // the weighed sharp read closer at every count of samples. Before the
      // distribution lands, the blur stands.
      // The sharp read is along the ray itself. The blurred one is at the
      // lobe's centre — the normal for a matte bounce — which is the blur's
      // whole idea, and under an overhead light a sharp read there counts
      // the light twice over: measured in a furnace, a table under a band
      // of sky came out double before this was seen.
      var w = 1.0;
      if (skySampled) {
        let ps = skyPdf(d);
        w = lastPdf * lastPdf / max(lastPdf * lastPdf + ps * ps, 1e-12);
      }
      let sharp = params.skyCount > 0u;
      let read = select(sky(skyDir, skyRough), sky(d, 0.0), sharp);
      result += throughput * select(read * w, ground.background, bounce == 0u);
      break;
    }
    dist += hit.t;
    if (inGem) { throughput *= exp(-gemAbsorb * hit.t); }
    let s = surfaceAt(hit, o, d, dist);
    let v = -d;
    // the table's rim: what is not table is the page's own colour, unlit, as the raster path draws it
    if (s.fade < 1.0) {
      result += throughput * ground.background * (1.0 - s.fade);
      throughput *= s.fade;
      if (s.fade <= 0.0) { break; }
    }
    // what the surface gives off, counted only where no light sampling reached it
    if (any(s.emission > vec3f(0.0)) && lastSpecular) { result += throughput * s.emission; }

    if (s.gem) {
      // a stone: Fresnel decides between the mirror and the way in or out
      var eta = s.ior;
      if (s.dispersion > 0.0 && channel < 0) {
        channel = i32(rand() * 3.0);
        throughput *= 3.0 * vec3f(f32(channel == 0), f32(channel == 1), f32(channel == 2));
      }
      if (channel >= 0) { eta = max(s.ior + s.dispersion * 2.0 * (f32(channel) - 1.0), 1.02); }
      let cosI = max(dot(s.n, v), 1e-4);
      let ratio = select(eta, 1.0 / eta, s.inside);
      let f = fresnelDielectric(cosI, ratio);
      if (rand() < f) {
        d = reflect(d, s.n);
        o = s.p + s.ng * params.eps;
        lastSpecular = true; skyDir = d; skyRough = 0.0; skySampled = false;
      } else {
        let refracted = refract(d, s.n, 1.0 / ratio);
        if (dot(refracted, refracted) < 1e-6) {
          d = reflect(d, s.n);
          o = s.p + s.ng * params.eps;
        } else {
          d = normalize(refracted);
          o = s.p - s.ng * params.eps;
          inGem = !s.inside;
          gemAbsorb = s.absorb;
        }
        lastSpecular = true; skyDir = d; skyRough = 0.0;
      }
      continue;
    }

    // direct light at this point — the lights, and the sky by its own
    // distribution, except on a mirror, which finds the sky itself — then a
    // bounce of the surface's choosing
    result += throughput * directLight(s, v);
    let mirror = s.roughness < 0.15 && s.metallic > 0.5;
    skySampled = !mirror && params.skyCount > 0u;
    if (skySampled) { result += throughput * skyLight(s, v); }
    let next = sampleBsdf(s, v);
    if (all(next.weight <= vec3f(0.0))) { break; }
    throughput *= next.weight;
    lastSpecular = next.specular;
    lastPdf = next.pdf;
    skyDir = next.skyDir; skyRough = select(next.skyRough, max(next.skyRough, 0.35), scattered);
    if (!next.specular) { scattered = true; }
    if (dot(next.l, s.ng) <= 0.0) { break; }
    o = s.p + s.ng * params.eps;
    d = next.l;
    inGem = false;
    // Russian roulette once the path has paid for itself
    if (bounce >= 2u) {
      let q = clamp(max(max(throughput.r, throughput.g), throughput.b), 0.05, 0.95);
      if (rand() > q) { break; }
      throughput /= q;
    }
  }
  return result;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  // a sample is traced in bands of rows, one band a frame, so no dispatch runs longer than a frame should
  let id = vec2u(gid.x, gid.y + params.rowOffset);
  if (id.x >= params.width || id.y >= params.height) { return; }
  rng = pcg(id.x + id.y * params.width + params.sample * 0x9e3779b9u + params.seed);
  // a thin lens: the ray through a jittered point of the pixel, from a point on the aperture, meeting at the focus
  let jitter = vec2f(rand(), rand());
  let px = (vec2f(id) + jitter) / vec2f(f32(params.width), f32(params.height));
  // a lens shift moved the image across the frame; the ray for this pixel is the one the unshifted frame had here
  let ndc = vec2f(px.x * 2.0 - 1.0, 1.0 - px.y * 2.0) + 2.0 * params.shift;
  var d = normalize(params.forward + params.right * ndc.x * params.tanHalf * params.aspect + params.up * ndc.y * params.tanHalf);
  var o = params.origin;
  if (params.aperture > 0.0) {
    let focal = o + d * (params.focus / max(dot(d, params.forward), 1e-3));
    let r = sqrt(rand()) * params.aperture;
    let a = 2.0 * PI * rand();
    o = o + params.right * r * cos(a) + params.up * r * sin(a);
    d = normalize(focal - o);
  }
  var c = radiance(o, d);
  let prev = select(vec4f(0.0), textureLoad(accumIn, vec2i(id), 0), params.sample > 0u);
  let sum = prev + vec4f(c, 1.0);
  textureStore(accumOut, vec2i(id), sum);
  textureStore(output, vec2i(id), vec4f(sum.rgb / sum.a * frame.exposure, 1.0));
}
`;

export interface TraceCamera {
  origin: [number, number, number];
  forward: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
  tanHalf: number;
  aspect: number;
  /** Aperture radius in world units, 0 for a pinhole; and the distance in focus. */
  aperture: number;
  focus: number;
  /** Lens shift, as the camera's projection carries it. */
  shift: [number, number];
}

export class PathTracer {
  // assigned when it compiles, off the main thread; no sample is taken before `compiled`
  private pipeline!: GPUComputePipeline;
  /** Whether the pipeline has compiled: a frame before then takes no sample and comes back. */
  compiled = false;
  private params: GPUBuffer;
  private sceneBuffers: GPUBuffer[] = [];
  private accum: GPUTexture[] = [];
  private width = 0;
  private height = 0;
  private output: GPUTexture | null = null;
  /** The next row a dispatch starts at; 0 means a sample is about to begin. */
  private cursor = 0;
  /** Pixels a dispatch is allowed: about a frame's worth of tracing on a modest GPU. */
  bandBudget = 1_500_000;
  /** Samples taken into the current accumulation. */
  samples = 0;
  /** Where the accumulation stops. */
  maxSamples = 1024;
  bounces = 6;
  private groundBuffer: GPUBuffer | null = null;
  private cushionView: GPUTextureView | null = null;
  /** The sky's cumulative distribution, 256 texels to a row; a single texel until a sky is given. */
  private skyTexture: GPUTexture;
  private skyCount = 0;
  private skySize = 0;
  triangleCount = 0;

  readonly layout: GPUBindGroupLayout;
  readonly materialLayout: GPUBindGroupLayout;

  /** `mmPerUnit`: millimetres in one world unit, for the step off a surface. */
  constructor(private ctx: Gpu, frameLayout: GPUBindGroupLayout, private mmPerUnit = 1) {
    const { device } = ctx;
    const c = GPUShaderStage.COMPUTE;
    this.materialLayout = device.createBindGroupLayout({
      label: 'trace materials',
      entries: [
        { binding: 0, visibility: c, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: c, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: c, texture: {} },
      ],
    });
    this.layout = device.createBindGroupLayout({
      label: 'trace scene',
      entries: [
        { binding: 0, visibility: c, buffer: { type: 'uniform' } },
        { binding: 1, visibility: c, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: c, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: c, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: c, buffer: { type: 'read-only-storage' } },
        { binding: 5, visibility: c, buffer: { type: 'uniform' } },
        { binding: 6, visibility: c, buffer: { type: 'read-only-storage' } },
        { binding: 7, visibility: c, buffer: { type: 'uniform' } },
        { binding: 8, visibility: c, texture: { sampleType: 'unfilterable-float' } },
        { binding: 9, visibility: c, storageTexture: { format: 'rgba32float', access: 'write-only' } },
        { binding: 10, visibility: c, storageTexture: { format: 'rgba16float', access: 'write-only' } },
        { binding: 11, visibility: c, texture: { sampleType: 'unfilterable-float' } },
        { binding: 12, visibility: c, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
    const module = shader(device, TRACE_WGSL, 'path tracer');
    device.createComputePipelineAsync({
      label: 'path tracer',
      layout: device.createPipelineLayout({ bindGroupLayouts: [frameLayout, this.materialLayout, this.layout] }),
      compute: { module, entryPoint: 'main' },
    }).then((p) => { this.pipeline = p; this.compiled = true; }, (err) => console.error('path tracer failed to compile:', err));
    this.params = device.createBuffer({ label: 'trace params', size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.skyTexture = device.createTexture({ label: 'sky cdf', size: [1, 1], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  }

  /** The scene to trace, with the table's record and the cushion's baked height; rebuilt whenever the piece changes. */
  setScene(scene: TracedScene, ground: GPUBuffer, cushion: GPUTextureView) {
    const { device } = this.ctx;
    for (const b of this.sceneBuffers) b.destroy();
    const upload = (data: ArrayBufferView, label: string, usage: GPUBufferUsageFlags, minSize = 16) => {
      const size = Math.max(minSize, Math.ceil(data.byteLength / 16) * 16);
      const b = device.createBuffer({ label, size, usage: usage | GPUBufferUsage.COPY_DST });
      if (data.byteLength) device.queue.writeBuffer(b, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
      return b;
    };
    if (scene.groups.length > 256 * 4) throw new Error('the path tracer takes at most 256 groups');
    this.sceneBuffers = [
      upload(scene.nodes, 'bvh nodes', GPUBufferUsage.STORAGE),
      upload(scene.triangles, 'bvh triangles', GPUBufferUsage.STORAGE),
      upload(scene.positions, 'trace positions', GPUBufferUsage.STORAGE),
      upload(scene.attributes, 'trace attributes', GPUBufferUsage.STORAGE),
      upload(scene.groups, 'trace groups', GPUBufferUsage.UNIFORM, 256 * 16),
      upload(scene.inverses, 'trace inverses', GPUBufferUsage.STORAGE),
    ];
    this.groundBuffer = ground;
    this.cushionView = cushion;
    this.triangleCount = scene.triangleCount;
    this.reset();
  }

  /**
   * The sky to sample by: its cumulative distribution over the sample
   * cube's texels, face by face, and the cube's face size. Given whenever
   * the environment's readback lands; until then the tracer reads the sky
   * only where its paths escape.
   */
  setSky(cdf: Float32Array, size: number) {
    const { device } = this.ctx;
    const width = 256, height = Math.max(1, Math.ceil(cdf.length / width));
    if (this.skyTexture.width !== width || this.skyTexture.height !== height) {
      this.skyTexture.destroy();
      this.skyTexture = device.createTexture({ label: 'sky cdf', size: [width, height], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    }
    const padded = new Float32Array(width * height);
    padded.set(cdf);
    device.queue.writeTexture({ texture: this.skyTexture }, padded, { bytesPerRow: width * 4 }, [width, height]);
    this.skyCount = cdf.length;
    this.skySize = size;
    this.reset();
  }

  /** Start the accumulation over: the view or the scene changed. */
  reset() { this.samples = 0; this.cursor = 0; }

  /** Whether a scene has been set: nothing can be sampled before one. */
  get hasScene() { return this.sceneBuffers.length > 0; }

  get done() { return this.samples >= this.maxSamples; }

  /** Size the accumulation to the target the mean is written into. */
  resize(width: number, height: number, output: GPUTexture) {
    if (width === this.width && height === this.height && output === this.output) return;
    this.width = width; this.height = height; this.output = output;
    for (const t of this.accum) t.destroy();
    // two copies: a dispatch reads the one and writes the other for its
    // band, then the band is copied back, so both always hold the whole
    this.accum = [0, 1].map((i) => this.ctx.device.createTexture({
      label: `trace accumulation ${i}`, size: [width, height], format: 'rgba32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
    }));
    this.reset();
  }

  /**
   * Trace the next band of the current sample into the accumulation and
   * write its mean to the output. A band is as many rows as the budget
   * allows; a small frame is one band, a large one several, so a frame
   * never waits on more tracing than a frame's worth.
   */
  sample(encoder: GPUCommandEncoder, frameBind: GPUBindGroup, materialBind: GPUBindGroup, camera: TraceCamera, groundOn: boolean) {
    if (!this.output || !this.groundBuffer || !this.cushionView || !this.accum.length || this.done) return;
    const { device } = this.ctx;
    const read = this.accum[0], write = this.accum[1];
    const rows = Math.max(8, Math.min(this.height - this.cursor, Math.ceil(this.bandBudget / this.width / 8) * 8));
    const pixelAngle = 2 * camera.tanHalf / this.height;
    const p = new ArrayBuffer(128);
    const f = new Float32Array(p), u = new Uint32Array(p);
    f.set(camera.origin, 0); u[3] = this.samples;
    f.set(camera.forward, 4); f[7] = camera.tanHalf;
    f.set(camera.right, 8); f[11] = camera.aspect;
    f.set(camera.up, 12); f[15] = camera.aperture;
    f[16] = camera.focus; u[17] = this.bounces; u[18] = this.width; u[19] = this.height;
    f[20] = groundOn ? 1 : 0; f[21] = pixelAngle; u[22] = 0x51ed27; u[23] = this.triangleCount;
    f[24] = camera.shift[0]; f[25] = camera.shift[1];
    u[26] = this.cursor; f[27] = 0.02 / this.mmPerUnit;
    u[28] = this.skyCount; u[29] = this.skySize;
    device.queue.writeBuffer(this.params, 0, p);
    const bind = device.createBindGroup({
      label: 'trace scene', layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.params } },
        ...this.sceneBuffers.map((b, i) => ({ binding: i + 1, resource: { buffer: b } })),
        { binding: 7, resource: { buffer: this.groundBuffer } },
        { binding: 8, resource: read.createView() },
        { binding: 9, resource: write.createView() },
        { binding: 10, resource: this.output.createView() },
        { binding: 11, resource: this.cushionView },
        { binding: 12, resource: this.skyTexture.createView() },
      ],
    });
    const pass = encoder.beginComputePass({ label: 'path trace' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, frameBind);
    pass.setBindGroup(1, materialBind);
    pass.setBindGroup(2, bind);
    pass.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(rows / 8));
    pass.end();
    // the band written is copied back, so the next read sees it
    const bandRows = Math.min(rows, this.height - this.cursor);
    encoder.copyTextureToTexture(
      { texture: write, origin: [0, this.cursor, 0] }, { texture: read, origin: [0, this.cursor, 0] }, [this.width, bandRows, 1],
    );
    this.cursor += bandRows;
    if (this.cursor >= this.height) { this.cursor = 0; this.samples++; }
  }

  dispose() {
    this.skyTexture.destroy();
    for (const b of this.sceneBuffers) b.destroy();
    for (const t of this.accum) t.destroy();
    this.params.destroy();
  }
}
