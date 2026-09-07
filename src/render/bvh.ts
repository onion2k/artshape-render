/**
 * The scene as triangles in world space, under a bounding volume hierarchy,
 * for the path tracer to walk on the GPU.
 *
 * Every placement of every part is flattened: its vertices carried into
 * world space, its triangles pointing at them. The per-vertex attributes
 * the shading needs — normal, uv, engraving coordinates, enamel, cap, wear —
 * stay per mesh vertex, shared by the placements, and a triangle finds
 * them through its group: attribute index = base + flat index mod the
 * mesh's vertex count, and the placement is the quotient.
 *
 * The hierarchy is binary, built top down by a binned surface-area
 * heuristic over the triangles' centroids, with leaves of a few triangles.
 * Nodes are laid out as the GPU reads them: bounds, then either the two
 * children (the right one always follows the left) or the leaf's run.
 */
import { engraveCoords, type Mesh as PartMesh } from '../mesh/types';
import { computeWear } from '../mesh/wear';

export interface SceneGroup {
  mesh: PartMesh;
  matrices: Float32Array;
  /** Wear per mesh vertex, if already analysed; computed here otherwise. */
  wear?: Float32Array;
}

export interface TracedScene {
  /** 8 floats a node: min xyz, left child or first triangle, max xyz, count (0 for an inner node). */
  nodes: Float32Array;
  /** 4 u32 a triangle: three flat vertex indices and the group. */
  triangles: Uint32Array;
  /** World-space positions, 3 floats a flat vertex, placement by placement. */
  positions: Float32Array;
  /** 12 floats a mesh vertex: normal xyz, uv, engrave, enamel, cap, wear, and two spare. */
  attributes: Float32Array;
  /** 4 u32 a group: attribute base, flat base, vertex count, placement base. */
  groups: Uint32Array;
  /** 16 floats a placement: the inverse of its matrix, for the part's own coordinates. */
  inverses: Float32Array;
  triangleCount: number;
}

const ATTR_STRIDE = 12;
const LEAF_SIZE = 4;
const BINS = 12;

export function buildScene(groups: SceneGroup[]): TracedScene {
  // count
  let flatVertices = 0, triangles = 0, meshVertices = 0, placements = 0;
  for (const g of groups) {
    const vc = g.mesh.positions.length / 3;
    const ic = g.matrices.length / 16;
    flatVertices += vc * ic;
    triangles += (g.mesh.indices.length / 3) * ic;
    meshVertices += vc;
    placements += ic;
  }
  const positions = new Float32Array(flatVertices * 3);
  const tri = new Uint32Array(triangles * 4);
  const attributes = new Float32Array(meshVertices * ATTR_STRIDE);
  const groupTable = new Uint32Array(groups.length * 4);
  const inverses = new Float32Array(placements * 16);

  let flatBase = 0, triBase = 0, attrBase = 0, instBase = 0;
  groups.forEach((g, gi) => {
    const m = g.mesh;
    const vc = m.positions.length / 3;
    const ic = g.matrices.length / 16;
    groupTable.set([attrBase, flatBase, vc, instBase], gi * 4);
    const engrave = engraveCoords(m);
    const wear = g.wear ?? computeWear(m);
    for (let v = 0; v < vc; v++) {
      const o = (attrBase + v) * ATTR_STRIDE;
      attributes[o] = m.normals[v * 3]; attributes[o + 1] = m.normals[v * 3 + 1]; attributes[o + 2] = m.normals[v * 3 + 2];
      attributes[o + 3] = m.uvs[v * 2]; attributes[o + 4] = m.uvs[v * 2 + 1];
      attributes[o + 5] = engrave[v * 2]; attributes[o + 6] = engrave[v * 2 + 1];
      attributes[o + 7] = m.enamel?.[v] ?? 0;
      attributes[o + 8] = m.cap?.[v] ?? 0;
      attributes[o + 9] = wear[v];
    }
    for (let i = 0; i < ic; i++) {
      const mat = g.matrices.subarray(i * 16, i * 16 + 16);
      invert(inverses.subarray((instBase + i) * 16, (instBase + i) * 16 + 16), mat);
      const base = flatBase + i * vc;
      for (let v = 0; v < vc; v++) {
        const x = m.positions[v * 3], y = m.positions[v * 3 + 1], z = m.positions[v * 3 + 2];
        const o = (base + v) * 3;
        positions[o] = mat[0] * x + mat[4] * y + mat[8] * z + mat[12];
        positions[o + 1] = mat[1] * x + mat[5] * y + mat[9] * z + mat[13];
        positions[o + 2] = mat[2] * x + mat[6] * y + mat[10] * z + mat[14];
      }
      for (let t = 0; t < m.indices.length; t += 3) {
        const o = triBase * 4;
        tri[o] = base + m.indices[t]; tri[o + 1] = base + m.indices[t + 1]; tri[o + 2] = base + m.indices[t + 2];
        tri[o + 3] = gi;
        triBase++;
      }
    }
    flatBase += vc * ic;
    attrBase += vc;
    instBase += ic;
  });

  const nodes = buildBvh(positions, tri, triangles);
  return { nodes, triangles: tri, positions, attributes, groups: groupTable, inverses, triangleCount: triangles };
}

/** Binned SAH, iterative with an explicit stack; reorders the triangle array in place. */
function buildBvh(positions: Float32Array, tri: Uint32Array, count: number): Float32Array {
  // centroids and bounds per triangle, once
  const cen = new Float32Array(count * 3);
  const bmin = new Float32Array(count * 3);
  const bmax = new Float32Array(count * 3);
  for (let t = 0; t < count; t++) {
    for (let k = 0; k < 3; k++) {
      let lo = Infinity, hi = -Infinity;
      for (let c = 0; c < 3; c++) {
        const p = positions[tri[t * 4 + c] * 3 + k];
        if (p < lo) lo = p;
        if (p > hi) hi = p;
      }
      bmin[t * 3 + k] = lo; bmax[t * 3 + k] = hi; cen[t * 3 + k] = (lo + hi) / 2;
    }
  }
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;

  // a binary tree over leaves of at least one triangle has under 2n nodes;
  // laid out in place rather than grown, since a growing array of numbers
  // was a third of the build on a few million triangles
  const nodes = new Float64Array(Math.max(1, 2 * count) * 8);
  let nodeCount = 0;
  const pushNode = () => nodeCount++;
  // the stack as three parallel arrays: no object a pop
  const stackNode = new Int32Array(Math.max(1, 2 * count)), stackFirst = new Int32Array(stackNode.length), stackCount = new Int32Array(stackNode.length);
  let top = 0;
  const push = (node: number, first: number, n: number) => { stackNode[top] = node; stackFirst[top] = first; stackCount[top] = n; top++; };
  const root = pushNode();
  push(root, 0, count);

  const binMin = new Float32Array(BINS * 3), binMax = new Float32Array(BINS * 3), binCount = new Uint32Array(BINS);
  const leftMin = new Float32Array(BINS * 3), leftMax = new Float32Array(BINS * 3), leftCount = new Uint32Array(BINS);

  while (top > 0) {
    top--;
    const node = stackNode[top], first = stackFirst[top], n = stackCount[top];
    // bounds of the run, and of its centroids
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let cminX = Infinity, cminY = Infinity, cminZ = Infinity, cmaxX = -Infinity, cmaxY = -Infinity, cmaxZ = -Infinity;
    for (let i = first; i < first + n; i++) {
      const t = order[i];
      minX = Math.min(minX, bmin[t * 3]); minY = Math.min(minY, bmin[t * 3 + 1]); minZ = Math.min(minZ, bmin[t * 3 + 2]);
      maxX = Math.max(maxX, bmax[t * 3]); maxY = Math.max(maxY, bmax[t * 3 + 1]); maxZ = Math.max(maxZ, bmax[t * 3 + 2]);
      cminX = Math.min(cminX, cen[t * 3]); cminY = Math.min(cminY, cen[t * 3 + 1]); cminZ = Math.min(cminZ, cen[t * 3 + 2]);
      cmaxX = Math.max(cmaxX, cen[t * 3]); cmaxY = Math.max(cmaxY, cen[t * 3 + 1]); cmaxZ = Math.max(cmaxZ, cen[t * 3 + 2]);
    }
    nodes[node * 8] = minX; nodes[node * 8 + 1] = minY; nodes[node * 8 + 2] = minZ;
    nodes[node * 8 + 4] = maxX; nodes[node * 8 + 5] = maxY; nodes[node * 8 + 6] = maxZ;
    const leaf = () => { nodes[node * 8 + 3] = first; nodes[node * 8 + 7] = n; };
    if (n <= LEAF_SIZE) { leaf(); continue; }

    // the widest centroid axis, binned
    const ext = [cmaxX - cminX, cmaxY - cminY, cmaxZ - cminZ];
    const axis = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2;
    const lo = [cminX, cminY, cminZ][axis], span = ext[axis];
    if (span <= 1e-9) {
      // every centroid in one place: split by count
      if (n > LEAF_SIZE * 4) { splitAt(node, first, n, first + (n >> 1)); } else { leaf(); }
      continue;
    }
    binCount.fill(0); binMin.fill(Infinity); binMax.fill(-Infinity);
    const scale = BINS / span;
    for (let i = first; i < first + n; i++) {
      const t = order[i];
      const b = Math.min(BINS - 1, Math.floor((cen[t * 3 + axis] - lo) * scale));
      binCount[b]++;
      for (let k = 0; k < 3; k++) {
        binMin[b * 3 + k] = Math.min(binMin[b * 3 + k], bmin[t * 3 + k]);
        binMax[b * 3 + k] = Math.max(binMax[b * 3 + k], bmax[t * 3 + k]);
      }
    }
    // sweep left to right, then right to left, for the cost of each split
    let lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity, lc = 0;
    for (let b = 0; b < BINS - 1; b++) {
      lc += binCount[b];
      lx = Math.min(lx, binMin[b * 3]); ly = Math.min(ly, binMin[b * 3 + 1]); lz = Math.min(lz, binMin[b * 3 + 2]);
      hx = Math.max(hx, binMax[b * 3]); hy = Math.max(hy, binMax[b * 3 + 1]); hz = Math.max(hz, binMax[b * 3 + 2]);
      leftCount[b] = lc;
      leftMin[b * 3] = lx; leftMin[b * 3 + 1] = ly; leftMin[b * 3 + 2] = lz;
      leftMax[b * 3] = hx; leftMax[b * 3 + 1] = hy; leftMax[b * 3 + 2] = hz;
    }
    let best = Infinity, bestBin = -1;
    let rx = Infinity, ry = Infinity, rz = Infinity, sx = -Infinity, sy = -Infinity, sz = -Infinity, rc = 0;
    for (let b = BINS - 1; b > 0; b--) {
      rc += binCount[b];
      rx = Math.min(rx, binMin[b * 3]); ry = Math.min(ry, binMin[b * 3 + 1]); rz = Math.min(rz, binMin[b * 3 + 2]);
      sx = Math.max(sx, binMax[b * 3]); sy = Math.max(sy, binMax[b * 3 + 1]); sz = Math.max(sz, binMax[b * 3 + 2]);
      const l = b - 1;
      if (leftCount[l] === 0 || rc === 0) continue;
      const cost = leftCount[l] * area(leftMin[l * 3], leftMin[l * 3 + 1], leftMin[l * 3 + 2], leftMax[l * 3], leftMax[l * 3 + 1], leftMax[l * 3 + 2])
        + rc * area(rx, ry, rz, sx, sy, sz);
      if (cost < best) { best = cost; bestBin = l; }
    }
    const parentArea = area(minX, minY, minZ, maxX, maxY, maxZ);
    if (bestBin < 0 || (n <= LEAF_SIZE * 4 && best >= n * parentArea)) { leaf(); continue; }
    // partition the run about the chosen bin
    let i = first, j = first + n - 1;
    while (i <= j) {
      const t = order[i];
      const b = Math.min(BINS - 1, Math.floor((cen[t * 3 + axis] - lo) * scale));
      if (b <= bestBin) { i++; } else { order[i] = order[j]; order[j] = t; j--; }
    }
    if (i === first || i === first + n) { splitAt(node, first, n, first + (n >> 1)); continue; }
    splitAt(node, first, n, i);
  }

  function splitAt(node: number, first: number, n: number, mid: number) {
    const left = pushNode();
    const right = pushNode();
    nodes[node * 8 + 3] = left;
    nodes[node * 8 + 7] = 0;
    // the right child is pushed first so the left is built first: no matter for the layout, since ids are fixed here
    push(right, mid, first + n - mid);
    push(left, first, mid - first);
  }

  // apply the order to the triangle array
  const sorted = new Uint32Array(tri.length);
  for (let i = 0; i < count; i++) {
    const t = order[i];
    sorted[i * 4] = tri[t * 4]; sorted[i * 4 + 1] = tri[t * 4 + 1]; sorted[i * 4 + 2] = tri[t * 4 + 2]; sorted[i * 4 + 3] = tri[t * 4 + 3];
  }
  tri.set(sorted);
  const out = new Float32Array(nodeCount * 8);
  out.set(nodes.subarray(0, nodeCount * 8));
  // the child index and the leaf's first triangle are read as u32 on the GPU: store their bit patterns
  const u = new Uint32Array(out.buffer);
  for (let i = 0; i < nodeCount; i++) {
    u[i * 8 + 3] = nodes[i * 8 + 3];
    u[i * 8 + 7] = nodes[i * 8 + 7];
  }
  return out;
}

function area(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  const dx = Math.max(0, x1 - x0), dy = Math.max(0, y1 - y0), dz = Math.max(0, z1 - z0);
  return 2 * (dx * dy + dy * dz + dz * dx);
}

/** The inverse of a rigid placement with uniform scale: transpose the rotation over the scale squared, and turn the translation. */
function invert(out: Float32Array, m: Float32Array) {
  const s2 = m[0] * m[0] + m[1] * m[1] + m[2] * m[2];
  const k = s2 > 0 ? 1 / s2 : 1;
  // R^-1 = R^T / s^2 (column-major: m[col*4 + row])
  out[0] = m[0] * k; out[1] = m[4] * k; out[2] = m[8] * k; out[3] = 0;
  out[4] = m[1] * k; out[5] = m[5] * k; out[6] = m[9] * k; out[7] = 0;
  out[8] = m[2] * k; out[9] = m[6] * k; out[10] = m[10] * k; out[11] = 0;
  const tx = m[12], ty = m[13], tz = m[14];
  out[12] = -(out[0] * tx + out[4] * ty + out[8] * tz);
  out[13] = -(out[1] * tx + out[5] * ty + out[9] * tz);
  out[14] = -(out[2] * tx + out[6] * ty + out[10] * tz);
  out[15] = 1;
}
