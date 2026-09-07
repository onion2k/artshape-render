/**
 * Body counting off the main thread. The analysis takes seconds on a dense
 * form, and on the main thread that is seconds in which the page cannot draw
 * a frame or take a keystroke. Meshes arrive as plain typed arrays, one copy
 * per distinct mesh, and placements point at them by index.
 */

import { analyseConnectivity } from './connectivity';
import type { Mesh } from '../mesh/types';

export interface ConnectivityRequest {
  token: number;
  meshes: Array<Pick<Mesh, 'positions' | 'indices'>>;
  placements: Array<{ mesh: number; matrix: Float32Array }>;
}

export interface ConnectivityResponse {
  token: number;
  bodies: number;
  floating: number;
  ms: number;
}

addEventListener('message', (e: MessageEvent<ConnectivityRequest>) => {
  const { token, meshes, placements } = e.data;
  const report = analyseConnectivity({
    placements: placements.map((p) => ({ part: { mesh: meshes[p.mesh] }, matrix: p.matrix })),
  });
  const response: ConnectivityResponse = { token, bodies: report.bodies, floating: report.floating, ms: report.ms };
  postMessage(response);
});
