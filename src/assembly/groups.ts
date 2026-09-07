/**
 * Placements grouped by the mesh they share: the draw call list. Two parts
 * made by the same call share a mesh, so the mesh alone is not the group;
 * what is drawn on the surface has to match as well. The result has the shape
 * a renderer's instance group takes, with the placements kept beside it for
 * selection.
 */

import type { Assembly, Placement } from './assembly';
import type { Engraving, Inscription, Part, PlateRelief } from '../parts/types';
import type { Mesh } from '../mesh/types';

export function groupByMesh(assembly: Assembly) {
  type Group = { mesh: Mesh; matrices: number[]; placements: Placement[]; metal?: string; finish?: string; enamel?: string; relief?: PlateRelief; veinMetal?: string; pavilionFacets?: number; engraving?: Engraving; inscription?: Inscription; glow?: number; gemPlanes?: Float32Array; gemSize?: number };
  // Two parts made by the same call share a mesh, so the mesh alone is not
  // the group: what is drawn on the surface has to match as well.
  const byMesh = new Map<Mesh, Group[]>();
  const sameSurface = (g: Group, part: Part) =>
    g.metal === part.material?.metal && g.finish === part.material?.finish && g.enamel === part.enamel
    && g.veinMetal === part.veinMetal && g.engraving === part.engraving && g.inscription === part.inscription && g.glow === part.glow;
  for (const p of assembly.placements) {
    let groups = byMesh.get(p.part.mesh);
    if (!groups) { groups = []; byMesh.set(p.part.mesh, groups); }
    let group = groups.find((g) => sameSurface(g, p.part));
    if (!group) {
      group = { mesh: p.part.mesh, matrices: [], placements: [], metal: p.part.material?.metal, finish: p.part.material?.finish, enamel: p.part.enamel, relief: p.part.relief, veinMetal: p.part.veinMetal, pavilionFacets: p.part.pavilionFacets, engraving: p.part.engraving, inscription: p.part.inscription, glow: p.part.glow, gemPlanes: p.part.gemPlanes, gemSize: p.part.gemSize };
      groups.push(group);
    }
    for (let i = 0; i < 16; i++) group.matrices.push(p.matrix[i]);
    group.placements.push(p);
  }
  return [...byMesh.values()].flat().map((g) => ({
    mesh: g.mesh,
    matrices: new Float32Array(g.matrices),
    placements: g.placements,
    metal: g.metal,
    finish: g.finish,
    enamel: g.enamel,
    relief: g.relief,
    veinMetal: g.veinMetal,
    pavilionFacets: g.pavilionFacets,
    engraving: g.engraving,
    inscription: g.inscription,
    glow: g.glow,
    gemPlanes: g.gemPlanes,
    gemSize: g.gemSize,
  }));
}
