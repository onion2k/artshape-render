import { transformPoint, type Mat4 } from '../geom/transform';
import type { Mesh } from '../mesh/types';

/** What the analysis reads: placed meshes. An Assembly is one; so is a worker's copy of one. */
export interface PlacedMeshes {
  placements: ReadonlyArray<{ part: { mesh: Pick<Mesh, 'positions' | 'indices'> }; matrix: Mat4 }>;
}

export interface ConnectivityOptions {
  /**
   * How close two surfaces must come to count as joined, in millimetres.
   *
   * Not zero. Parts that merely graze are not printable either — a shared edge
   * carries no material — so this is deliberately a little slack, and anything
   * inside it is treated as fused.
   */
  tolerance?: number;
  /** Broad-phase cell size. Should be comfortably larger than the tolerance. */
  cell?: number;
  /** Test every nth triangle. 1 is exact; larger is faster and can miss contacts. */
  stride?: number;
}

export interface ConnectivityReport {
  /** Separate solids the model would export as. 1 is the goal. */
  bodies: number;
  /** Placements in the largest body. */
  largest: number;
  /** Placements touching nothing at all. */
  floating: number;
  /** Body index per placement, indexed as assembly.placements. */
  bodyOf: Int32Array;
  /** Placement indices that touch nothing, worst offenders first by size. */
  floatingPlacements: number[];
  ms: number;
}

/**
 * How many separate solids is this assembly?
 *
 * Nothing else in the project asks this, because nothing else needs to: the
 * renderer is happy to draw parts hanging in mid-air, and every check in the
 * validator judges one mesh at a time. But a model that is going to be printed
 * has to be a single body — or at least a set of bodies each of which is a
 * deliberate separate piece — and a petal a millimetre clear of the receptacle
 * looks identical on screen to one that is welded to it.
 *
 * Two placements are joined if their surfaces intersect, come within
 * `tolerance`, or one contains the other. All three are needed, and finding that
 * out took two wrong answers:
 *
 * Proximity between one part's vertices and another's triangles is not enough.
 * A hexagonal cap sitting on three square posts genuinely interpenetrates, but
 * the cap's only vertices are its six corners and the posts' are their section
 * rings, and none of them lands within a tenth of a millimetre of the other
 * surface. Coarse shapes can overlap in a region that contains no vertex at all,
 * so the intersection has to be tested against the edges, not the corners.
 *
 * Nor is intersection enough on its own. A spine rooted below the surface of the
 * head it belongs to is swallowed whole — no surfaces cross, and yet the union
 * is plainly one solid. That needs a containment test, which is cheap here
 * because it only has to run on the placements nothing else has claimed.
 */
export function analyseConnectivity(
  assembly: PlacedMeshes,
  opts: ConnectivityOptions = {},
): ConnectivityReport {
  const t0 = performance.now();
  const tolerance = opts.tolerance ?? 0.1;
  // Small cells cost memory and buy speed: the narrow phase scans 27 of them per
  // vertex, so halving the cell roughly halves the triangles it has to look at.
  const cell = opts.cell ?? Math.max(tolerance * 4, 0.6);
  const stride = Math.max(opts.stride ?? 1, 1);
  const n = assembly.placements.length;

  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  if (n === 0) {
    return {
      bodies: 0, largest: 0, floating: 0,
      bodyOf: new Int32Array(0), floatingPlacements: [], ms: 0,
    };
  }

  // --- everything into one world-space soup, tagged by placement ---
  let vertexTotal = 0;
  let triangleTotal = 0;
  for (const p of assembly.placements) {
    vertexTotal += p.part.mesh.positions.length / 3;
    triangleTotal += p.part.mesh.indices.length / 3;
  }

  const vx = new Float64Array(vertexTotal);
  const vy = new Float64Array(vertexTotal);
  const vz = new Float64Array(vertexTotal);
  const vOwner = new Int32Array(vertexTotal);
  const tri = new Int32Array(triangleTotal * 3);
  const tOwner = new Int32Array(triangleTotal);

  let vo = 0, to = 0;
  for (let i = 0; i < n; i++) {
    const { part, matrix } = assembly.placements[i];
    const { positions, indices } = part.mesh;
    const base = vo;
    for (let v = 0; v < positions.length; v += 3) {
      const w = transformPoint(matrix, [positions[v], positions[v + 1], positions[v + 2]]);
      vx[vo] = w[0]; vy[vo] = w[1]; vz[vo] = w[2];
      vOwner[vo] = i;
      vo++;
    }
    for (let t = 0; t < indices.length; t += 3) {
      tri[to * 3] = base + indices[t];
      tri[to * 3 + 1] = base + indices[t + 1];
      tri[to * 3 + 2] = base + indices[t + 2];
      tOwner[to] = i;
      to++;
    }
  }

  // --- broad phase: triangles into a sparse uniform grid ---
  const key = (ix: number, iy: number, iz: number) =>
    // three large primes, xor-mixed; collisions only cost a few extra distance tests
    (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) | 0;

  /**
   * Each cell also remembers which placements own triangles in it — a short list,
   * since parts are local. That list is what makes this affordable: a cell whose
   * every owner is already in the same body as the vertex being tested can teach
   * us nothing, and is skipped without looking at a single triangle. As contacts
   * merge placements into bodies, more and more of the model falls into that case.
   */
  interface Cell { tris: number[]; owners: number[] }
  const grid = new Map<number, Cell>();
  const at = (v: number) => Math.floor(v / cell);
  for (let t = 0; t < triangleTotal; t++) {
    const a = tri[t * 3], b = tri[t * 3 + 1], c = tri[t * 3 + 2];
    const owner = tOwner[t];
    const x0 = at(Math.min(vx[a], vx[b], vx[c])), x1 = at(Math.max(vx[a], vx[b], vx[c]));
    const y0 = at(Math.min(vy[a], vy[b], vy[c])), y1 = at(Math.max(vy[a], vy[b], vy[c]));
    const z0 = at(Math.min(vz[a], vz[b], vz[c])), z1 = at(Math.max(vz[a], vz[b], vz[c]));
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        for (let iz = z0; iz <= z1; iz++) {
          const k = key(ix, iy, iz);
          const found = grid.get(k);
          if (found) {
            found.tris.push(t);
            if (!found.owners.includes(owner)) found.owners.push(owner);
          } else {
            grid.set(k, { tris: [t], owners: [owner] });
          }
        }
      }
    }
  }

  // --- narrow phase: every triangle against the triangles of other placements ---
  const tol2 = tolerance * tolerance;
  const stamp = new Int32Array(triangleTotal).fill(-1);
  const lo = [0, 0, 0], hi = [0, 0, 0];

  for (let ta = 0; ta < triangleTotal; ta += stride) {
    const owner = tOwner[ta];
    const a0 = tri[ta * 3], a1 = tri[ta * 3 + 1], a2 = tri[ta * 3 + 2];
    lo[0] = Math.min(vx[a0], vx[a1], vx[a2]) - tolerance;
    hi[0] = Math.max(vx[a0], vx[a1], vx[a2]) + tolerance;
    lo[1] = Math.min(vy[a0], vy[a1], vy[a2]) - tolerance;
    hi[1] = Math.max(vy[a0], vy[a1], vy[a2]) + tolerance;
    lo[2] = Math.min(vz[a0], vz[a1], vz[a2]) - tolerance;
    hi[2] = Math.max(vz[a0], vz[a1], vz[a2]) + tolerance;

    for (let ix = at(lo[0]); ix <= at(hi[0]); ix++) {
      for (let iy = at(lo[1]); iy <= at(hi[1]); iy++) {
        for (let iz = at(lo[2]); iz <= at(hi[2]); iz++) {
          const found = grid.get(key(ix, iy, iz));
          if (!found) continue;
          const root = find(owner);
          let worthwhile = false;
          for (const o of found.owners) if (find(o) !== root) { worthwhile = true; break; }
          if (!worthwhile) continue;

          for (const tb of found.tris) {
            if (stamp[tb] === ta) continue;
            stamp[tb] = ta;
            const other = tOwner[tb];
            if (other === owner || find(other) === root) continue;
            if (trianglesMeet(vx, vy, vz, tri, ta, tb, tol2)) {
              union(owner, other);
              break;
            }
          }
        }
      }
    }
  }

  // --- anything still alone may simply be buried inside something else ---
  for (let pass = 0; pass < 4; pass++) {
    const size = new Int32Array(n);
    for (let i = 0; i < n; i++) size[find(i)]++;
    let merged = false;
    for (let i = 0; i < n; i++) {
      if (size[find(i)] !== 1) continue;
      const probe = vertexOf(i, vx, vy, vz, vOwner);
      if (!probe) continue;
      for (let j = 0; j < n; j++) {
        if (find(j) === find(i)) continue;
        if (containsPoint(vx, vy, vz, tri, tOwner, triangleTotal, j, probe)) {
          union(i, j);
          merged = true;
          break;
        }
      }
    }
    if (!merged) break;
  }

  // --- collect components ---
  const label = new Map<number, number>();
  const bodyOf = new Int32Array(n);
  const size: number[] = [];
  for (let i = 0; i < n; i++) {
    const root = find(i);
    let id = label.get(root);
    if (id === undefined) { id = label.size; label.set(root, id); size.push(0); }
    bodyOf[i] = id;
    size[id]++;
  }

  const floatingPlacements: number[] = [];
  for (let i = 0; i < n; i++) if (size[bodyOf[i]] === 1) floatingPlacements.push(i);

  return {
    bodies: label.size,
    largest: Math.max(...size),
    floating: floatingPlacements.length,
    bodyOf,
    floatingPlacements,
    ms: performance.now() - t0,
  };
}

/** Squared distance from a point to a triangle: the standard region-by-region solve. */
function pointTriangleDistance2(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3);
    const qx = apx - abx * t, qy = apy - aby * t, qz = apz - abz * t;
    return qx * qx + qy * qy + qz * qz;
  }

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6);
    const qx = apx - acx * t, qy = apy - acy * t, qz = apz - acz * t;
    return qx * qx + qy * qy + qz * qz;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const qx = bpx + (cx - bx) * t, qy = bpy + (cy - by) * t, qz = bpz + (cz - bz) * t;
    return qx * qx + qy * qy + qz * qz;
  }

  const denom = 1 / (va + vb + vc);
  const s = vb * denom, t = vc * denom;
  const qx = apx - abx * s - acx * t;
  const qy = apy - aby * s - acy * t;
  const qz = apz - abz * s - acz * t;
  return qx * qx + qy * qy + qz * qz;
}

/** First world-space vertex belonging to a placement, as a containment probe. */
function vertexOf(
  placement: number,
  vx: Float64Array, vy: Float64Array, vz: Float64Array, vOwner: Int32Array,
): [number, number, number] | null {
  for (let v = 0; v < vOwner.length; v++) {
    if (vOwner[v] === placement) return [vx[v], vy[v], vz[v]];
  }
  return null;
}

/**
 * Is the point inside placement `j`? Parity of the crossings along a fixed ray.
 *
 * Only ever asked about placements that nothing has touched, so brute force over
 * that one placement's triangles is affordable and there is no structure to keep
 * in step. The ray is nudged off the axes so it is unlikely to graze an edge,
 * which is the only way parity counting goes wrong on a closed mesh — and every
 * mesh here is checked closed by the validator.
 */
function containsPoint(
  vx: Float64Array, vy: Float64Array, vz: Float64Array,
  tri: Int32Array, tOwner: Int32Array, triangleTotal: number,
  j: number, p: [number, number, number],
): boolean {
  const dir: [number, number, number] = [0.7071, 0.5773, 0.4082];
  let crossings = 0;
  for (let t = 0; t < triangleTotal; t++) {
    if (tOwner[t] !== j) continue;
    const a = tri[t * 3], b = tri[t * 3 + 1], c = tri[t * 3 + 2];
    if (rayHitsTriangle(
      p, dir,
      vx[a], vy[a], vz[a], vx[b], vy[b], vz[b], vx[c], vy[c], vz[c],
    )) crossings++;
  }
  return (crossings & 1) === 1;
}

function rayHitsTriangle(
  p: [number, number, number], d: [number, number, number],
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): boolean {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const hx = d[1] * e2z - d[2] * e2y;
  const hy = d[2] * e2x - d[0] * e2z;
  const hz = d[0] * e2y - d[1] * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(det) < 1e-12) return false;
  const inv = 1 / det;
  const sx = p[0] - ax, sy = p[1] - ay, sz = p[2] - az;
  const u = (sx * hx + sy * hy + sz * hz) * inv;
  if (u < 0 || u > 1) return false;
  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < 0 || u + v > 1) return false;
  return (e2x * qx + e2y * qy + e2z * qz) * inv > 1e-9;
}

/**
 * Do two triangles intersect, or come within `tol2`?
 *
 * Intersection is tested edge against face, both ways round, because two
 * triangles cannot cross without an edge of one passing through the other. That
 * is what the vertex-only version missed: a corner can be nowhere near the other
 * surface while the edge leading to it goes straight through it.
 */
function trianglesMeet(
  vx: Float64Array, vy: Float64Array, vz: Float64Array,
  tri: Int32Array, ta: number, tb: number, tol2: number,
): boolean {
  const a = [tri[ta * 3], tri[ta * 3 + 1], tri[ta * 3 + 2]];
  const b = [tri[tb * 3], tri[tb * 3 + 1], tri[tb * 3 + 2]];

  for (let i = 0; i < 3; i++) {
    const p = a[i], q = a[(i + 1) % 3];
    if (segmentHitsTriangle(
      vx[p], vy[p], vz[p], vx[q], vy[q], vz[q],
      vx[b[0]], vy[b[0]], vz[b[0]], vx[b[1]], vy[b[1]], vz[b[1]], vx[b[2]], vy[b[2]], vz[b[2]],
    )) return true;
  }
  for (let i = 0; i < 3; i++) {
    const p = b[i], q = b[(i + 1) % 3];
    if (segmentHitsTriangle(
      vx[p], vy[p], vz[p], vx[q], vy[q], vz[q],
      vx[a[0]], vy[a[0]], vz[a[0]], vx[a[1]], vy[a[1]], vz[a[1]], vx[a[2]], vy[a[2]], vz[a[2]],
    )) return true;
  }

  // not crossing, but close enough to count as fused
  for (const p of a) {
    if (pointTriangleDistance2(
      vx[p], vy[p], vz[p],
      vx[b[0]], vy[b[0]], vz[b[0]], vx[b[1]], vy[b[1]], vz[b[1]], vx[b[2]], vy[b[2]], vz[b[2]],
    ) <= tol2) return true;
  }
  for (const p of b) {
    if (pointTriangleDistance2(
      vx[p], vy[p], vz[p],
      vx[a[0]], vy[a[0]], vz[a[0]], vx[a[1]], vy[a[1]], vz[a[1]], vx[a[2]], vy[a[2]], vz[a[2]],
    ) <= tol2) return true;
  }
  return false;
}

function segmentHitsTriangle(
  px: number, py: number, pz: number,
  qx: number, qy: number, qz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): boolean {
  const dx = qx - px, dy = qy - py, dz = qz - pz;
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const hx = dy * e2z - dz * e2y;
  const hy = dz * e2x - dx * e2z;
  const hz = dx * e2y - dy * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(det) < 1e-14) return false;
  const inv = 1 / det;
  const sx = px - ax, sy = py - ay, sz = pz - az;
  const u = (sx * hx + sy * hy + sz * hz) * inv;
  if (u < 0 || u > 1) return false;
  const qcx = sy * e1z - sz * e1y;
  const qcy = sz * e1x - sx * e1z;
  const qcz = sx * e1y - sy * e1x;
  const v = (dx * qcx + dy * qcy + dz * qcz) * inv;
  if (v < 0 || u + v > 1) return false;
  const t = (e2x * qcx + e2y * qcy + e2z * qcz) * inv;
  return t >= 0 && t <= 1;
}
