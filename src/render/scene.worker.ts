/**
 * The traced scene built off the main thread. Flattening every placement
 * and building the hierarchy is seconds of CPU on a dense mesh, and on the
 * main thread that is seconds without a frame; here the raster view stays
 * live and the tracer starts when the scene arrives. A request that has been
 * superseded is told apart by its token.
 */

import { buildScene, type SceneGroup, type TracedScene } from './bvh';

export interface SceneRequest {
  token: number;
  groups: SceneGroup[];
}

export interface SceneResponse {
  token: number;
  scene: TracedScene;
}

addEventListener('message', (e: MessageEvent<SceneRequest>) => {
  const { token, groups } = e.data;
  const scene = buildScene(groups);
  const response: SceneResponse = { token, scene };
  // the worker's postMessage, typed as the window's by the DOM lib: the arrays move rather than copy
  (postMessage as (message: unknown, transfer: Transferable[]) => void)(response, [scene.nodes.buffer, scene.triangles.buffer, scene.positions.buffer, scene.attributes.buffer, scene.groups.buffer, scene.inverses.buffer] as Transferable[]);
});
