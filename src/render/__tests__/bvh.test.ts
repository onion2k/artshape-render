import { describe, expect, it } from 'vitest';
import { sweep } from '../../mesh/sweep';
import { circle } from '../../geom/profile';
import { line, samplePath } from '../../geom/curve';
import { revolve } from '../../mesh/revolve';
import { buildScene, type TracedScene } from '../bvh';

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const translated = (x: number, y: number, z: number) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);

/** Walk the tree on the CPU: every leaf's triangles inside its box, every inner box holding its children's. */
function check(scene: TracedScene) {
  const nodes = scene.nodes;
  const u = new Uint32Array(nodes.buffer);
  const seen = new Uint8Array(scene.triangleCount);
  const bounds = (i: number) => ({ min: [nodes[i * 8], nodes[i * 8 + 1], nodes[i * 8 + 2]], max: [nodes[i * 8 + 4], nodes[i * 8 + 5], nodes[i * 8 + 6]] });
  const inside = (p: number[], b: { min: number[]; max: number[] }) => p.every((c, k) => c >= b.min[k] - 1e-4 && c <= b.max[k] + 1e-4);
  let leaves = 0, depthMax = 0;
  const walk = (i: number, depth: number) => {
    depthMax = Math.max(depthMax, depth);
    const b = bounds(i);
    const count = u[i * 8 + 7];
    if (count > 0) {
      leaves++;
      const first = u[i * 8 + 3];
      for (let t = first; t < first + count; t++) {
        expect(seen[t]).toBe(0);
        seen[t] = 1;
        for (let c = 0; c < 3; c++) {
          const v = scene.triangles[t * 4 + c];
          const p = [scene.positions[v * 3], scene.positions[v * 3 + 1], scene.positions[v * 3 + 2]];
          expect(inside(p, b)).toBe(true);
        }
      }
      return;
    }
    const left = u[i * 8 + 3];
    for (const child of [left, left + 1]) {
      const cb = bounds(child);
      expect(inside(cb.min, b)).toBe(true);
      expect(inside(cb.max, b)).toBe(true);
      walk(child, depth + 1);
    }
  };
  walk(0, 0);
  return { leaves, depthMax, covered: seen.every((s) => s === 1) };
}

describe('buildScene', () => {
  it('flattens placements into world space and files every triangle in exactly one leaf', () => {
    const tube = sweep(samplePath(line([0, 0, 0], [20, 0, 0]), 20), { profile: circle(1.5, 12) });
    const bead = revolve({ points: [[0, -2], [1.6, -1.2], [2, 0], [1.6, 1.2], [0, 2]] }, { segments: 16 });
    const scene = buildScene([
      { mesh: tube, matrices: identity() },
      { mesh: bead, matrices: new Float32Array([...translated(30, 0, 0), ...translated(0, 30, 5)]) },
    ]);
    const tubeTris = tube.indices.length / 3, beadTris = bead.indices.length / 3;
    expect(scene.triangleCount).toBe(tubeTris + 2 * beadTris);
    // the second bead's vertices were carried to where it stands
    const g = scene.groups;
    expect(g[4]).toBe(tube.positions.length / 3);   // attribute base of group 1
    const flatBase = g[5], vc = g[6];
    const secondBead = flatBase + vc;
    const ys = Array.from({ length: vc }, (_, v) => scene.positions[(secondBead + v) * 3 + 1]);
    expect(Math.min(...ys)).toBeGreaterThan(27);
    expect(Math.max(...ys)).toBeLessThan(33);
    // and its inverse takes the world back to the part's own frame
    const inv = scene.inverses.subarray(32, 48);
    expect(inv[12]).toBeCloseTo(0); expect(inv[13]).toBeCloseTo(-30); expect(inv[14]).toBeCloseTo(-5);
    const { leaves, depthMax, covered } = check(scene);
    expect(covered).toBe(true);
    expect(leaves).toBeGreaterThan(10);
    expect(depthMax).toBeLessThan(32);
  });

  it('keeps the attributes a triangle needs: normals, uvs, engraving coordinates, and the group they belong to', () => {
    const tube = sweep(samplePath(line([0, 0, 0], [10, 0, 0]), 10), { profile: circle(1, 8) });
    const scene = buildScene([{ mesh: tube, matrices: identity() }]);
    for (let t = 0; t < scene.triangleCount; t++) expect(scene.triangles[t * 4 + 3]).toBe(0);
    const n = tube.positions.length / 3;
    for (let v = 0; v < n; v++) {
      const o = v * 12;
      expect(Math.hypot(scene.attributes[o], scene.attributes[o + 1], scene.attributes[o + 2])).toBeCloseTo(1, 3);
      expect(scene.attributes[o + 3]).toBe(tube.uvs[v * 2]);
    }
  });

  it('copes with an empty scene', () => {
    const scene = buildScene([]);
    expect(scene.triangleCount).toBe(0);
    expect(scene.nodes.length).toBe(8);
  });
});
