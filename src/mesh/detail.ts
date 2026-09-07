/**
 * How finely parts are tessellated: one scale on every segment count and
 * every chord tolerance. 1 is the catalogue's own density; 0.5 is a working
 * draft, with about a quarter of the triangles, since a plate's cap refines
 * in two directions and a sweep in two as well.
 *
 * A count is brought down whether a generator chose it or the sketch wrote
 * it — a petal at `segments: 72` is asking for smoothness, not for
 * seventy-two of anything — but never below eight and never above what was
 * written, so a hand-set hexagon is a hexagon at any detail. Process-wide,
 * like the render quality it follows; the evaluator keys its part memo on
 * it, so a change rebuilds every part.
 */

let scale = 1;

export function setDetail(s: number) {
  scale = Math.min(Math.max(s, 0.1), 1);
}

export function detail(): number {
  return scale;
}

/** A count brought to the current detail: never below `floor`, which keeps a round thing round, and never above the count itself. */
export function scaledCount(count: number, floor = 8): number {
  return Math.min(count, Math.max(floor, Math.round(count * scale)));
}
