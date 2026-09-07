import type { Vec3 } from '../geom/types';
export interface Mesh {
  positions: Float32Array;
  normals: Float32Array;
  /** u runs along the sweep or around the revolve, v across it. Drives brushed finishes. */
  uvs: Float32Array;
  indices: Uint32Array;
  /**
   * Where the surface is enamelled, 0 or 1 per vertex. Absent on a plain
   * metal part. A plate carries it on its top cap: the cell the enamel is
   * fired into, with the bevel and walls left as the metal rim.
   */
  enamel?: Float32Array;
  /**
   * Which face of a plate a vertex belongs to: +1 the top cap, -1 the bottom
   * cap, 0 the bevel and walls. Lets the shader evaluate chased relief per
   * pixel on the caps, where the flat coordinates are known.
   */
  cap?: Float32Array;
  /**
   * The box a plate's cap uv is measured against — minX, minY, width, height
   * in the plate's own flat coordinates — so a shader can turn uv back into
   * millimetres and draw an engraving at a real size.
   */
  uvSpan?: [number, number, number, number];
  /**
   * Surface coordinates in millimetres, two per vertex, for drawing an
   * engraving at a real size: along and around a sweep, round and up a
   * revolve, across a plate's face. Where absent the viewer derives them
   * from uv and the mesh's extent.
   */
  engrave?: Float32Array;
  /**
   * For a surface closed along the first engraving coordinate — a band, a
   * torus — its length round: the coordinate runs 0 to this and meets itself,
   * so lettering can wrap across the seam. Absent on an open surface.
   */
  engravePeriod?: number;
}

/**
 * Millimetres per unit of u and of v, averaged over the surface. Sweeps and
 * revolves parameterise 0..1 along and around, so this is what turns their uv
 * into a coordinate an engraving can be scaled in. Weighted by triangle area,
 * so a wide belly counts for more than a pinched tip.
 */
/**
 * Engraving coordinates for any mesh: its own where the generator wrote them,
 * the flat plate coordinates for a plate, and uv scaled by the average extent
 * for anything else.
 */
export function engraveCoords(mesh: Mesh): Float32Array {
  if (mesh.engrave) return mesh.engrave;
  const n = mesh.positions.length / 3;
  const out = new Float32Array(n * 2);
  const [x0, y0, sx, sy] = mesh.uvSpan ?? [0, 0, ...uvExtent(mesh)];
  for (let i = 0; i < n; i++) {
    out[i * 2] = x0 + mesh.uvs[i * 2] * sx;
    out[i * 2 + 1] = y0 + mesh.uvs[i * 2 + 1] * sy;
  }
  return out;
}

export function uvExtent(mesh: Mesh): [number, number] {
  const p = mesh.positions, uv = mesh.uvs, idx = mesh.indices;
  let su = 0, sv = 0, weight = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    const e1 = [p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]];
    const e2 = [p[c * 3] - p[a * 3], p[c * 3 + 1] - p[a * 3 + 1], p[c * 3 + 2] - p[a * 3 + 2]];
    const du1 = uv[b * 2] - uv[a * 2], dv1 = uv[b * 2 + 1] - uv[a * 2 + 1];
    const du2 = uv[c * 2] - uv[a * 2], dv2 = uv[c * 2 + 1] - uv[a * 2 + 1];
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-12) continue;
    // dP/du and dP/dv from the two edges
    const inv = 1 / det;
    const tu = [(e1[0] * dv2 - e2[0] * dv1) * inv, (e1[1] * dv2 - e2[1] * dv1) * inv, (e1[2] * dv2 - e2[2] * dv1) * inv];
    const tv = [(e2[0] * du1 - e1[0] * du2) * inv, (e2[1] * du1 - e1[1] * du2) * inv, (e2[2] * du1 - e1[2] * du2) * inv];
    const cx = e1[1] * e2[2] - e1[2] * e2[1], cy = e1[2] * e2[0] - e1[0] * e2[2], cz = e1[0] * e2[1] - e1[1] * e2[0];
    const area = Math.hypot(cx, cy, cz);
    su += Math.hypot(tu[0], tu[1], tu[2]) * area;
    sv += Math.hypot(tv[0], tv[1], tv[2]) * area;
    weight += area;
  }
  return weight > 0 ? [su / weight, sv / weight] : [1, 1];
}

export type Vec2 = [number, number];

/**
 * Accumulates a mesh from generators that emit vertex grids and fans.
 *
 * Everything here produces structured topology on purpose: edges follow the form,
 * so a swept tube reads smoother at 3k triangles than a grid-sampled one does at 7k,
 * and every vertex carries a real surface parameter rather than a lattice position.
 */
export class MeshBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uv: number[] = [];
  private idx: number[] = [];

  get vertexCount() { return this.pos.length / 3; }
  get triangleCount() { return this.idx.length / 3; }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number) {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    return this.pos.length / 3 - 1;
  }

  triangle(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number) {
    this.idx.push(a, b, c, a, c, d);
  }

  /**
   * Stitch a (rows x cols) vertex grid whose first vertex is `base`. Grids are
   * emitted with the seam column duplicated, so `cols` is the real column count
   * and no index wrapping is needed here.
   */
  grid(base: number, rows: number, cols: number) {
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const i = base + r * cols + c;
        this.quad(i, i + cols, i + cols + 1, i + 1);
      }
    }
  }

  build(): Mesh {
    return {
      positions: new Float32Array(this.pos),
      normals: new Float32Array(this.nrm),
      uvs: new Float32Array(this.uv),
      indices: new Uint32Array(this.idx),
    };
  }
}

/** Recompute smooth normals from face geometry, where an analytic normal is awkward. */
export function recomputeNormals(mesh: Mesh) {
  const { positions, normals, indices } = mesh;
  normals.fill(0);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const e1x = positions[b] - positions[a];
    const e1y = positions[b + 1] - positions[a + 1];
    const e1z = positions[b + 2] - positions[a + 2];
    const e2x = positions[c] - positions[a];
    const e2y = positions[c + 1] - positions[a + 1];
    const e2z = positions[c + 2] - positions[a + 2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    for (const v of [a, b, c]) {
      normals[v] += nx; normals[v + 1] += ny; normals[v + 2] += nz;
    }
  }
  for (let v = 0; v < normals.length; v += 3) {
    const l = Math.hypot(normals[v], normals[v + 1], normals[v + 2]) || 1;
    normals[v] /= l; normals[v + 1] /= l; normals[v + 2] /= l;
  }
}

/**
 * Concatenate meshes into one.
 *
 * A Part is a single mesh, which is what lets the renderer instance it — so a
 * form that is genuinely one piece of metal but takes several sweeps to describe,
 * like a branch and its limbs, has to be joined here rather than placed as
 * separate parts. Everything else in the vocabulary stays separate on purpose:
 * pieces overlap and are riveted, not welded.
 */
/**
 * Glaze a whole mesh rather than one face of it.
 *
 * A plate is enamelled in a cell: the metal round the edge is the wall that
 * holds the glass, so only the cap is marked. A body turned on a lathe has no
 * cell — it is dipped, or the enamel is fired over the whole of it, which is
 * how an egg is done — so every vertex carries it.
 */
export function enamelWhole(mesh: Mesh): Mesh {
  mesh.enamel = new Float32Array(mesh.positions.length / 3).fill(1);
  return mesh;
}

/**
 * Glaze the inside of a hollow turned body: the vertices whose normals point
 * in toward the axis. The rim annuli face along the axis and stay metal, which
 * is the lip a fired enamel always shows.
 */
export function enamelInside(mesh: Mesh): Mesh {
  const n = mesh.positions.length / 3;
  const out = new Float32Array(n);
  const p = mesh.positions, nm = mesh.normals;
  for (let i = 0; i < n; i++) {
    const x = p[i * 3], y = p[i * 3 + 1];
    const r = Math.hypot(x, y);
    if (r < 1e-6) continue;
    const radial = (nm[i * 3] * x + nm[i * 3 + 1] * y) / r;
    if (radial < -0.5) out[i] = 1;
  }
  mesh.enamel = out;
  return mesh;
}

/**
 * Glaze the inside of a swept blade.
 *
 * A blade that curls out of its plane has a concave face: where the surface
 * normal leans toward the centre the path bends round. Each section takes its
 * own bend, and where the path runs straight it borrows the path's bend as a
 * whole, so a slight curve still gets one whole face and not a patchwork. A
 * blade bowed within its own plane has no concave face — the bend runs along
 * its edge — so it takes enamel on its upper face, as a leaf does. The end
 * caps look along the path and stay metal either way.
 */
export function enamelConcave(mesh: Mesh, path: Vec3[]): Mesh {
  const n = mesh.positions.length / 3;
  const out = new Float32Array(n);
  const bendAt = (i: number): Vec3 | null => {
    const a = path[Math.max(i - 1, 0)], b = path[i], c = path[Math.min(i + 1, path.length - 1)];
    const k: Vec3 = [a[0] - 2 * b[0] + c[0], a[1] - 2 * b[1] + c[1], a[2] - 2 * b[2] + c[2]];
    const l = Math.hypot(k[0], k[1], k[2]);
    return l > 1e-9 ? [k[0] / l, k[1] / l, k[2] / l] : null;
  };
  const whole: Vec3 = [0, 0, 0];
  for (let i = 1; i < path.length - 1; i++) {
    const k = bendAt(i);
    if (k) { whole[0] += k[0]; whole[1] += k[1]; whole[2] += k[2]; }
  }
  const wl = Math.hypot(whole[0], whole[1], whole[2]);
  const fallback: Vec3 | null = wl > 1e-9 ? [whole[0] / wl, whole[1] / wl, whole[2] / wl] : null;
  // each vertex takes the bend of the path point nearest it; the mesh's own
  // ring layout is the sweep's business
  const nm = mesh.normals, p = mesh.positions;
  const bends = path.map((_, i) => bendAt(i) ?? fallback);
  for (let i = 0; i < n; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    let best = 0, bestD = Infinity;
    for (let j = 0; j < path.length; j++) {
      const d = (path[j][0] - x) ** 2 + (path[j][1] - y) ** 2 + (path[j][2] - z) ** 2;
      if (d < bestD) { bestD = d; best = j; }
    }
    const k = bends[best];
    if (!k) continue;
    const d = nm[i * 3] * k[0] + nm[i * 3 + 1] * k[1] + nm[i * 3 + 2] * k[2];
    if (d > 0.35) out[i] = 1;
  }
  // A broad face is half the section; anything less that faced the bend was
  // an edge — a flat ribbon coiled in its own plane presents its inner edge to
  // the centre — and enamel on an edge is not what anyone meant.
  let marked = 0;
  for (const v of out) marked += v;
  if (marked < n * 0.4) {
    for (let i = 0; i < n; i++) out[i] = nm[i * 3 + 2] > 0.35 ? 1 : 0;
  }
  mesh.enamel = out;
  return mesh;
}

export function mergeMeshes(meshes: Mesh[]): Mesh {
  let verts = 0, tris = 0;
  for (const m of meshes) { verts += m.positions.length / 3; tris += m.indices.length; }

  const positions = new Float32Array(verts * 3);
  const normals = new Float32Array(verts * 3);
  const uvs = new Float32Array(verts * 2);
  const indices = new Uint32Array(tris);
  const enamel = meshes.some((m) => m.enamel) ? new Float32Array(verts) : undefined;
  const cap = meshes.some((m) => m.cap) ? new Float32Array(verts) : undefined;
  // each piece keeps its own engraving coordinates; a piece without any gets
  // them derived, so the whole is engravable if any part of it is
  const engrave = meshes.some((m) => m.engrave) ? new Float32Array(verts * 2) : undefined;

  let vo = 0, io = 0;
  for (const m of meshes) {
    positions.set(m.positions, vo * 3);
    normals.set(m.normals, vo * 3);
    uvs.set(m.uvs, vo * 2);
    if (enamel && m.enamel) enamel.set(m.enamel, vo);
    if (cap && m.cap) cap.set(m.cap, vo);
    if (engrave) engrave.set(engraveCoords(m), vo * 2);
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i] + vo;
    vo += m.positions.length / 3;
    io += m.indices.length;
  }
  const out: Mesh = { positions, normals, uvs, indices };
  if (enamel) out.enamel = enamel;
  if (cap) out.cap = cap;
  if (engrave) out.engrave = engrave;
  // one closed surface's period survives a merge only if every piece shares it
  const period = meshes[0]?.engravePeriod;
  if (period && meshes.every((m) => m.engravePeriod === period)) out.engravePeriod = period;
  return out;
}
