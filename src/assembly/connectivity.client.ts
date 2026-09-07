/**
 * The body counter, off the main thread.
 *
 * The worker is made here rather than by the page, because `new URL(...,
 * import.meta.url)` resolves against the file it is written in: written in an
 * application, it would look for the worker beside the application's own
 * sources and not find it. The types come through as types only, so importing
 * this does not pull the worker's module in.
 */
export type { ConnectivityRequest, ConnectivityResponse } from './connectivity.worker';

export function createConnectivityWorker(): Worker {
  return new Worker(new URL('./connectivity.worker.ts', import.meta.url), { type: 'module' });
}
