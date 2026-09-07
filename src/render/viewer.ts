/**
 * The viewer: a renderer on a canvas in the page.
 *
 * What the page adds to the headless renderer, and nothing more: the canvas
 * and its WebGPU context, an orbit that follows the pointer, a resize
 * observer on the host, the frame loop, and the adaptive resolution that
 * times frames while the camera moves. Everything drawn lives in the
 * renderer; this file decides when and at what size. Its surface is what
 * main.ts drives — subject, material, light, view — and is the same as
 * before the split, so a panel is written against the viewer and a program
 * without a page against the renderer.
 */

import { createContext, type GpuContext } from '../gpu/context';
import { Camera, Orbit } from '../gpu/camera';
import type { Mesh as PartMesh } from '../mesh/types';
import type { Anchor } from '../parts/types';
import type { Box3, Vec3 } from '../geom/types';
import type { EnvPreset } from './env';
import type { Film } from './post';
import { Renderer, type InstanceGroup, type Quality, type RendererOptions, type RigLight, type TableName } from './renderer';
import { Ladder, RUNGS, median, slownessOf, startingScale, tierFor, verdicts, type Verdict } from './calibrate';

export { MAX_RIG_LIGHTS, emitterSamples, tableNames } from './renderer';
export type { InstanceGroup, Quality, RendererOptions, RigLight, TableName } from './renderer';
export { Ladder, RUNGS, TIERS, tierFor, type Economy, type Rung, type Tier, type Verdict } from './calibrate';
export type { AdapterInfo } from '../gpu/context';

/**
 * The page's own marks, as one line: what each stage of getting to the first
 * frame took, from the page's start. A page marks its own stages beside the
 * viewer's — the scene it built, the moment it was ready.
 */
function startupLine(): string {
  const marks = performance.getEntriesByType('mark').filter((m) => /^(viewer|artshape|chess):/.test(m.name));
  if (!marks.length) return 'no marks';
  return marks.map((m) => `${m.name.replace(/^.*:/, '')} ${(m.startTime / 1000).toFixed(2)}s`).join(', ');
}

export class Viewer {
  /** The renderer under the canvas, for whatever the forwarding surface leaves out. */
  readonly renderer: Renderer;
  readonly camera: Camera;

  private ctx: GpuContext;
  private host: HTMLElement;
  private controls: Orbit;
  private observer: ResizeObserver;
  private raf = 0;
  private quality: Quality = 'draft';
  private renderScale = 1;
  /** Depth of field's focus, as a multiple of the orbit distance, so the target is what's sharp. */
  private focusScale = 1;

  /** Frames actually drawn, for measuring. */
  frameCount = 0;
  /** Called after every drawn frame, with the camera settled: for overlays laid over the canvas. */
  onFrame: (() => void) | null = null;

  /**
   * The ladder: the internal scale first, then what the frame gives up. Any
   * run of consecutive frames is timed by its gaps; a still frame, drawn on
   * its own, is fenced. Too slow and the ladder comes down; headroom and it
   * climbs back. The user's render-scale slider and quality are the ceiling.
   */
  private ladder = new Ladder();
  /** The tessellation the ladder asks of the page, as a multiplier on its own: 1, or less. */
  onDetail: ((factor: number) => void) | null = null;
  private lastFrameAt = 0;
  private frameMs = 16;
  /** When the ladder last moved: each step reallocates the render targets, so steps are rationed. */
  private lastScaleStep = 0;
  /**
   * What the viewer measured and did, a line a moment, for a report from a
   * machine that is not to hand: the adapter, each calibration, each step of
   * the ladder and what moved it. Bounded, so a long session keeps its
   * latest few hundred.
   */
  private journal: string[] = [];
  private note(line: string) {
    this.journal.push(`${(performance.now() / 1000).toFixed(1)}s ${line}`);
    if (this.journal.length > 300) this.journal.splice(0, this.journal.length - 300);
  }
  /** The last frames' times, gap-timed in runs and fenced when still, for the report's summary. */
  private runFrames: number[] = [];
  private stillFrames: number[] = [];
  /** The still frame's fence: one at a time, and the buffers it copies through. */
  private fenceBusy = false;
  private fenceSrc: GPUBuffer | null = null;
  private fenceDst: GPUBuffer | null = null;
  /**
   * What the display itself can do, measured on the ticks we draw nothing on.
   * Everything about pacing is judged against this rather than a number picked
   * in advance.
   */
  private tickMs = 16.7;
  private lastTickAt = 0;
  /** A frame smaller than this is not measured: its fixed cost would pass for a cost per pixel. */
  static readonly MIN_CALIBRATION_PIXELS = 200_000;
  /** Once the calibration's frames have taken this long together, one measured frame is verdict enough. */
  static readonly CALIBRATION_MS = 1500;
  /** What was measured of this GPU, here or on an earlier visit; null until either. */
  verdict: Verdict | null = null;
  /** While frames are being timed, the loop stands aside. */
  private calibrating = false;

  static async create(host: HTMLElement, onLost?: (info: GPUDeviceLostInfo) => void, opts: RendererOptions = {}): Promise<Viewer> {
    const canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    performance.mark('viewer:start');
    const ctx = await createContext(canvas, onLost);
    performance.mark('viewer:device');
    const viewer = new Viewer(ctx, host, opts);
    // the pipelines are asked for by now; on some drivers they compile
    // only when first drawn with, which the first frame's fence will show
    performance.mark('viewer:pipelines');
    return viewer;
  }

  private constructor(ctx: GpuContext, host: HTMLElement, opts: RendererOptions) {
    this.firstFrame = new Promise((resolve) => { this.firstFrameLanded = resolve; });
    this.ctx = ctx;
    this.host = host;
    host.appendChild(ctx.canvas);
    this.renderer = new Renderer(ctx, opts);
    this.camera = this.renderer.camera;
    // the orbit's range starts as a jeweller's, six millimetres to just over a
    // metre, and opens out to whatever is framed
    const u = this.renderer.mmPerUnit;
    this.controls = new Orbit(this.camera, {
      element: ctx.canvas, ease: 0.18, inertia: 0.72, minDistance: 6 / u, maxDistance: 1200 / u,
    });
    // the host, not the window: a pane that is laid out after load, or shown
    // after being hidden, changes size without a window resize event
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    // a machine measured slow on an earlier visit opens at the size it settled
    // on then, not at full size and a stall
    this.verdict = verdicts.load(ctx.adapter.key);
    const a = ctx.adapter;
    this.note(`adapter ${a.key}${a.fallback ? ' (software fallback)' : ''}; ${this.verdict ? `kept verdict ${this.verdict.msPerMpx.toFixed(0)} ms/Mpx, scale ${this.verdict.scale.toFixed(2)}, rung ${this.verdict.rung ?? 0}` : 'no verdict kept'}`);
    if (this.verdict) {
      // the scale it settled on, and its rungs only if it is a slow machine:
      // on a fast one they were a passing moment — a bake, a tab in the
      // background — and a page that opened without its shadows for it would
      // be worse than the moment was
      const slow = tierFor(this.verdict.msPerMpx) === 'fast';
      this.ladder = new Ladder(this.verdict.scale, slow ? this.verdict.rung : 0);
      // and the bakes budgeted before the first of them, which is what a kept verdict is for
      this.renderer.setSlowness(slownessOf(this.verdict.msPerMpx));
    } else if (ctx.adapter.fallback) {
      // a software renderer, and nothing measured yet: it is slow before it
      // is measured, so it starts low and climbs if it can. SwiftShader
      // measured 2800 ms/Mpx, two hundred times a desktop
      this.ladder = new Ladder(Ladder.FLOOR, 2);
      this.renderer.setSlowness(64);
    }
    this.renderer.setEconomy(this.ladder.economy);
    this.resize();
    this.loop();
  }

  /** The ladder's position, for a page to show: the internal scale and how many rungs are taken. */
  get pacing() { return { scale: this.ladder.scale, rung: this.ladder.rung, frameMs: this.frameMs, tickMs: this.tickMs }; }
  /** What the page should multiply its tessellation detail by. */
  get detailFactor() { return this.ladder.economy.detail; }

  /** The adapter, as far as the browser says. */
  get adapter() { return this.ctx.adapter; }

  /**
   * Time a few frames of the scene on screen and set the internal scale from
   * the cost. Call once the first scene is set; a background alone measures
   * nothing and is not measured. The first frame carries the bakes and shader
   * warm-up and is drawn but not counted; the median of the rest is the
   * verdict, kept against the adapter for the next visit.
   *
   * Each frame is fenced with a readback rather than timed on the main
   * thread, since a submit returns long before the GPU has drawn anything.
   */
  async calibrate(frames = 3): Promise<Verdict | null> {
    // a frame has a cost of its own before its first pixel, so a canvas that
    // has no size yet — a pane not laid out, a tab not shown — would measure
    // the overhead and call it the cost per pixel; say nothing until there is one
    if (this.calibrating || !this.renderer.hasScene) return this.verdict;
    // nothing can be timed until the shaders have compiled and the first
    // frame has landed: measured before it, the frames would queue behind
    // the bakes' chunks and hold the loop's own first frame back
    await this.renderer.ready;
    await this.firstFrame;
    if (this.calibrating) return this.verdict;
    this.calibrating = true;
    // measured at full scale, whatever the scale was opened at, so one visit's
    // verdict is the same frame as the next's; a frame has a cost before its
    // first pixel, and a small frame would put that down to its pixels
    const opened = this.ladder.scale;
    this.ladder.scale = 1;
    this.resize();
    if (this.renderer.renderPixels < Viewer.MIN_CALIBRATION_PIXELS) {
      this.ladder.scale = opened;
      this.resize();
      this.calibrating = false;
      return this.verdict;
    }
    const { device } = this.ctx;
    const src = device.createBuffer({ label: 'fence src', size: 4, usage: GPUBufferUsage.COPY_SRC });
    const dst = device.createBuffer({ label: 'fence dst', size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const timings: number[] = [];
    try {
      let spent = 0;
      for (let i = 0; i <= frames; i++) {
        // enough: a machine that takes seconds a frame has said what it is,
        // and the page should not be held for the rest of the sample
        if (timings.length && spent > Viewer.CALIBRATION_MS) break;
        this.renderer.requestRender();
        const t0 = performance.now();
        const drew = this.renderer.render(() => this.ctx.context.getCurrentTexture().createView());
        const encoder = device.createCommandEncoder({ label: 'fence' });
        encoder.copyBufferToBuffer(src, 0, dst, 0, 4);
        device.queue.submit([encoder.finish()]);
        await dst.mapAsync(GPUMapMode.READ);
        dst.unmap();
        const took = performance.now() - t0;
        spent += took;
        if (drew && i > 0) timings.push(took);
        // no animation frame is waited on between: a page opened in a
        // background tab gets none, and would never finish measuring
      }
    } finally {
      src.destroy();
      dst.destroy();
      this.calibrating = false;
    }
    if (!timings.length) {
      this.ladder.scale = opened;
      this.resize();
      return this.verdict;
    }
    const mpx = this.renderer.renderPixels / 1e6;
    const msPerMpx = median(timings) / mpx;
    this.ladder.scale = startingScale(msPerMpx, mpx, this.tickMs, Ladder.FLOOR);
    this.verdict = { key: this.ctx.adapter.key, msPerMpx, scale: this.ladder.scale, rung: this.ladder.rung, at: Date.now() };
    verdicts.save(this.verdict);
    this.note(`calibrated: ${timings.map((t) => t.toFixed(0)).join('/')} ms at ${mpx.toFixed(2)} Mpx → ${msPerMpx.toFixed(1)} ms/Mpx, tick ${this.tickMs.toFixed(1)}, scale ${this.ladder.scale.toFixed(2)}`);
    // the bakes follow the verdict from here: the next scene's, and this one's if the budgets moved
    const slowness = slownessOf(msPerMpx);
    if (slowness > 1 || this.renderer.budgets.probeSize !== 256) {
      this.renderer.setSlowness(slowness);
      const b = this.renderer.budgets;
      this.note(`bakes budgeted at slowness ${slowness.toFixed(1)}: ${b.occlusionDirections.draft}/${b.occlusionDirections.full} directions at ${b.occlusionDepth.draft}/${b.occlusionDepth.full}, chunks of ${(b.triangleBudget / 1e6).toFixed(1)}M triangles, probe ${b.probeSize}² × ${b.probeBounces}`);
    }
    this.resize();
    this.renderer.requestRender();
    return this.verdict;
  }

  // --- the renderer's surface, forwarded ---
  setEnvironmentImage(img: { width: number; height: number; data: Float32Array }, meanRadiance: number) { this.renderer.setEnvironmentImage(img, meanRadiance); }
  setEnvironment(preset: EnvPreset | 'image') { return this.renderer.setEnvironment(preset); }
  setMaterial(metalName: string, finishName: string) { this.renderer.setMaterial(metalName, finishName); }
  setBloom(v: number) { this.renderer.setBloom(v); }
  setDetail(v: number) { this.renderer.setDetail(v); }
  setFilm(film: Partial<Film>) { this.renderer.setFilm(film); }
  setGlow(v: number) { this.renderer.setGlow(v); }
  setRig(lights: RigLight[]) { this.renderer.setRig(lights); }
  setKeyLight(opts: { elevation: number; azimuth: number; strength: number; warmth: number; size?: number }) { this.renderer.setKeyLight(opts); }
  setLens(mm: number) { this.renderer.setLens(mm); }
  setCameraRoll(radians: number) { this.renderer.setCameraRoll(radians); }
  setLensShift(x: number, y: number) { this.renderer.setLensShift(x, y); }
  setFocusHelper(on: boolean) { this.renderer.setFocusHelper(on); }
  setEnvStrength(v: number) { this.renderer.setEnvStrength(v); }
  setTable(name: TableName) { this.renderer.setTable(name); }
  setBackground(rgb: Vec3) { this.renderer.setBackground(rgb); }
  setExposure(v: number) { this.renderer.setExposure(v); }
  setEnvSpin(radians: number) { this.renderer.setEnvSpin(radians); }
  setDebug(mode: number) { this.renderer.setDebug(mode); }
  setContact(v: number) { this.renderer.setContact(v); }
  setInstanced(groups: InstanceGroup[]) { this.renderer.setInstanced(groups); }
  move(group: number, matrices: Float32Array, count?: number) { this.renderer.move(group, matrices, count); }
  moveAll(updates: Array<{ group: number; matrices: Float32Array; count?: number }>) { this.renderer.moveAll(updates); }
  setMesh(data: PartMesh) { this.renderer.setMesh(data); }
  setSelection(selected: Array<Float32Array<ArrayBuffer>> | null) { this.renderer.setSelection(selected); }
  setAnchors(anchors: Anchor[], scale: number) { this.renderer.setAnchors(anchors, scale); }
  requestRender() { this.renderer.requestRender(); }
  get traceSamples() { return this.renderer.traceSamples; }
  get traceLimit() { return this.renderer.traceLimit; }

  /** Depth of field: 0 off, 1 a lens wide open; focus as a multiple of the distance to the orbit target, 1 being the target itself. */
  setDepthOfField(strength: number, focusScale: number) {
    this.focusScale = focusScale;
    this.renderer.setDepthOfField(strength);
    this.pushFocus();
  }
  /** Tell the renderer where the focus and the subject are, from the orbit's distance. */
  private pushFocus() {
    const d = this.controls.distance;
    this.renderer.setFocus(d * this.focusScale, d);
  }

  /**
   * Draft is for working: a lighter shadow bake and fewer pixels, so an edit
   * shows in a fraction of a second on a dense form. Final is for looking.
   */
  setQuality(q: Quality) {
    if (q === this.quality) return;
    this.quality = q;
    this.renderer.setQuality(q);
    this.resize();
  }

  /** Fraction of device resolution to render at, below the pixel budget. */
  setRenderScale(v: number) {
    this.renderScale = Math.min(Math.max(v, 0.25), 1);
    this.resize();
  }

  // --- the camera, as the orbit and the page see it ---
  /** Send the orbit to an elevation above the table, an azimuth round it, and a distance, easing there. */
  setView(to: { elevation?: number; azimuth?: number; distance?: number }) {
    this.controls.setSpherical({
      azimuth: to.azimuth,
      polar: to.elevation === undefined ? undefined : Math.PI / 2 - to.elevation,
      radius: to.distance,
    });
    this.renderer.requestRender();
  }

  /** Where the camera is, for a panel to show: angles in radians, distance in world units. */
  viewState() {
    return {
      elevation: Math.PI / 2 - this.controls.currentPolar,
      azimuth: this.controls.currentAzimuth,
      distance: this.controls.distance,
      lens: Camera.lensForFov(this.camera.fov),
      roll: this.camera.roll,
      shift: this.camera.shift,
    };
  }

  frameBounds(b: Box3) {
    this.renderer.frameBounds(b);
    // a piece larger than the jeweller's range needs room to stand back from, and a tiny one to come close to
    const radius = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2;
    const u = this.renderer.mmPerUnit;
    this.controls.minDistance = Math.min(6 / u, radius * 0.1);
    this.controls.maxDistance = Math.max(1200 / u, radius * 40);
    this.controls.forcePosition();
    this.pushFocus();
  }

  /** A world point in CSS pixels over the canvas, or null when it is behind the camera. */
  project(p: Vec3): [number, number] | null {
    const m = this.camera.viewProjection;
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    if (w <= 0) return null;
    const x = (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w;
    const y = (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w;
    return [((x + 1) / 2) * this.host.clientWidth, ((1 - y) / 2) * this.host.clientHeight];
  }

  /** The instance under a page point, or null. */
  pick(x: number, y: number): { group: number; instance: number } | null {
    const rect = this.ctx.canvas.getBoundingClientRect();
    const nx = ((x - rect.left) / rect.width) * 2 - 1;
    const ny = 1 - ((y - rect.top) / rect.height) * 2;
    return this.renderer.pick(nx, ny);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.fenceSrc?.destroy();
    this.fenceDst?.destroy();
    this.observer.disconnect();
    this.controls.remove();
    this.renderer.dispose();
  }

  // ---- internals ----

  private resize = () => {
    // Render at device resolution up to a budget, then scale down. A retina
    // canvas the size of a laptop screen sits just inside it; a tall pane or a
    // large monitor comes down to the same cost rather than crawling.
    const cw = Math.max(1, this.host.clientWidth), ch = Math.max(1, this.host.clientHeight);
    const budget = this.quality !== 'draft' ? Renderer.PIXEL_BUDGET : Renderer.DRAFT_PIXEL_BUDGET;
    // never below one pixel per CSS pixel at rest: under that, edges stair-step
    // however well they were multisampled, because each rendered pixel is
    // stretched over more than one on screen
    const budgeted = Math.max(Math.min(window.devicePixelRatio, Math.sqrt(budget / (cw * ch))), 1);
    const dpr = Math.min(budgeted, 2) * this.renderScale * this.ladder.scale;
    const w = Math.max(1, Math.floor(cw * dpr));
    const h = Math.max(1, Math.floor(ch * dpr));
    this.ctx.canvas.width = w;
    this.ctx.canvas.height = h;
    this.renderer.setSize(w, h);
  };

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (this.calibrating) return;
    const tickNow = performance.now();
    const sinceTick = tickNow - this.lastTickAt;
    this.lastTickAt = tickNow;
    const moving = this.controls.moving;
    this.controls.update();
    this.renderer.setMoving(moving);
    // nothing to draw when nothing has changed: the GPU idles and the page stays responsive
    if (!this.renderer.pending) {
      // A tick we spend nothing on is the display's own cadence, and it costs
      // nothing to measure. It is the only honest yardstick for the pacing
      // below: a frame gap can never be shorter than the screen's own.
      if (sinceTick > 1 && sinceTick < 250) this.tickMs = this.tickMs * 0.9 + sinceTick * 0.1;
      return;
    }
    // the focus follows the orbit's distance, refreshed only on a frame that
    // is due anyway: the orbit goes on easing by hairs after it reports
    // settled, and those must not keep the renderer awake
    this.pushFocus();
    const drew = this.renderer.render(() => this.ctx.context.getCurrentTexture().createView());
    if (!drew) return;
    this.frameCount++;
    if (this.frameCount === 1) this.fenceFirst();
    else if (!this.pace()) this.fenceStill();
    this.onFrame?.();
  };

  /**
   * The first frame is fenced but never judged: it carries every bake and,
   * on a driver that compiles a pipeline when it is first drawn with, every
   * shader — seconds on a Windows laptop, and nothing to do with what a
   * frame costs after. It is written down, since that wait is what a page
   * shows a spinner for, and `onFirstFrame` fires when it has landed.
   */
  onFirstFrame: ((ms: number) => void) | null = null;
  /** Resolves once the first frame has landed; what the calibration waits on. */
  private readonly firstFrame: Promise<void>;
  private firstFrameLanded: () => void = () => {};
  private fenceFirst() {
    this.fence().then((ms) => {
      performance.mark('viewer:first-frame');
      this.note(`first frame landed: ${ms.toFixed(0)} ms after its submit (bakes and, on some drivers, the shaders)`);
      this.firstFrameLanded();
      this.onFirstFrame?.(ms);
    }, () => { this.firstFrameLanded(); });
  }

  /** Queue four bytes behind what is submitted and resolve, with the time taken, when the GPU has done it. */
  private fence(): Promise<number> {
    const { device } = this.ctx;
    this.fenceSrc ??= device.createBuffer({ label: 'still fence src', size: 4, usage: GPUBufferUsage.COPY_SRC });
    this.fenceDst ??= device.createBuffer({ label: 'still fence dst', size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    this.fenceBusy = true;
    const t0 = performance.now();
    const encoder = device.createCommandEncoder({ label: 'still fence' });
    encoder.copyBufferToBuffer(this.fenceSrc, 0, this.fenceDst, 0, 4);
    device.queue.submit([encoder.finish()]);
    return this.fenceDst.mapAsync(GPUMapMode.READ).then(() => {
      this.fenceDst?.unmap();
      this.fenceBusy = false;
      return performance.now() - t0;
    }, (err) => { this.fenceBusy = false; throw err; });
  }

  /**
   * Time consecutive frames by their gaps and move the ladder to keep up
   * with the display. Returns whether this frame was one of a run; a frame
   * on its own says nothing here, and is fenced instead.
   *
   * What counts as fast enough has to be the display's own cadence, not a
   * number chosen in advance. A frame gap is floored by the screen: on a sixty
   * hertz panel nothing is ever quicker than sixteen milliseconds, so a scale
   * that waits for fourteen before stepping back up can only ever fall, and
   * one slow moment leaves the piece soft for the rest of the session. Both
   * thresholds are therefore multiples of what the idle ticks report.
   */
  private pace(): boolean {
    const now = performance.now();
    const gap = now - this.lastFrameAt;
    this.lastFrameAt = now;
    // only consecutive frames say anything; a gap after an idle spell does not
    if (gap > 250) return false;
    this.frameMs = this.frameMs * 0.8 + gap * 0.2;
    this.runFrames.push(gap);
    if (this.runFrames.length > 240) this.runFrames.shift();
    // a step swaps a few hundred megabytes of targets, so at most a few a second
    if (now - this.lastScaleStep < 300) return true;
    const missing = this.tickMs * 1.5 + 6;
    const keepingUp = this.tickMs * 1.2;
    if (this.frameMs > missing) {
      if (this.ladder.slower(now, this.frameMs / missing)) this.stepped(now, `run at ${this.frameMs.toFixed(0)} ms over ${missing.toFixed(0)}`);
    } else if (this.frameMs < keepingUp) {
      if (this.ladder.faster(now)) this.stepped(now, `run at ${this.frameMs.toFixed(1)} ms under ${keepingUp.toFixed(0)}`);
    }
    return true;
  }

  /**
   * A frame drawn on its own — the view still, a piece just rebuilt — has
   * no neighbour to be timed against, so it is fenced: a copy of four bytes
   * queued behind it and mapped, which resolves when the GPU has finished
   * the frame. A still frame is allowed more than a moving one, since it is
   * one frame and not a rate; over that and the ladder comes down, as it
   * would for a slow run. Only one fence is in flight at a time, and a
   * frame drawn while one is out goes unmeasured; so does one drawn while
   * the page is hidden, whose fence would time the browser's throttling.
   */
  private fenceStill() {
    // a hidden page's timers are throttled, and would time the throttle, not the frame
    if (this.fenceBusy || this.calibrating || document.hidden) return;
    this.fence().then((ms) => {
      const now = performance.now();
      // a fence from before a calibration resolves in the middle of it: it
      // must not move the scale under the frames being measured
      if (document.hidden || this.calibrating) return;
      this.stillFrames.push(ms);
      if (this.stillFrames.length > 60) this.stillFrames.shift();
      if (now - this.lastScaleStep < 300) return;
      const budget = Viewer.STILL_BUDGET;
      if (ms > budget && this.ladder.slower(now, ms / budget)) this.stepped(now, `still frame ${ms.toFixed(0)} ms over ${budget}`);
    }, () => {});
  }

  /** What a frame at rest may take before the ladder comes down for it. */
  static readonly STILL_BUDGET = 250;

  /**
   * Everything the viewer knows about this machine and what it did about
   * it, as text to paste: for a slow laptop that is somewhere else, one
   * paste says what it measured, where the ladder stands, what its frames
   * take, and every step on the way, so the thresholds can be judged
   * against a machine that is not to hand.
   */
  report(app = 'artshape'): string {
    const a = this.ctx.adapter;
    const { canvas } = this.ctx;
    const v = this.verdict;
    const e = this.ladder.economy;
    const b = this.renderer.budgets;
    const summary = (xs: number[]) => {
      if (!xs.length) return 'none';
      const s = [...xs].sort((x, y) => x - y);
      return `${xs.length}: min ${s[0].toFixed(0)}, median ${s[s.length >> 1].toFixed(0)}, max ${s[s.length - 1].toFixed(0)} ms`;
    };
    const without = RUNGS.filter((_, i) => i < this.ladder.rung);
    return [
      `${app} report, ${new Date().toISOString()}`,
      `browser: ${navigator.userAgent}`,
      `adapter: ${a.key}${a.fallback ? ' (software fallback)' : ''}${a.description ? ` — ${a.description}` : ''}`,
      `screen: ${this.host.clientWidth}×${this.host.clientHeight} css at dpr ${window.devicePixelRatio}, canvas ${canvas.width}×${canvas.height}, drawing ${(this.renderer.renderPixels / 1e6).toFixed(2)} Mpx, tick ${this.tickMs.toFixed(1)} ms`,
      `verdict: ${v ? `${v.msPerMpx.toFixed(1)} ms/Mpx, kept ${new Date(v.at).toISOString()}` : 'none'}`,
      `ladder: scale ${this.ladder.scale.toFixed(2)}, rung ${this.ladder.rung}${without.length ? ` (without ${without.join(', ')})` : ''}; shadow taps ×${e.shadowTaps}, contact ${e.contact ? 'on' : 'off'}, supersample ${e.supersample ? 'allowed' : 'off'}, detail ×${e.detail}`,
      `bakes: ${b.occlusionDirections.draft}/${b.occlusionDirections.full} directions at ${b.occlusionDepth.draft}/${b.occlusionDepth.full}, chunks of ${(b.triangleBudget / 1e6).toFixed(1)}M triangles, probe ${b.probeSize}² × ${b.probeBounces} bounce${b.probeBounces > 1 ? 's' : ''}`,
      `frames in runs — ${summary(this.runFrames)}`,
      `still frames fenced — ${summary(this.stillFrames)}`,
      `drawn: ${this.frameCount}`,
      `startup: ${startupLine()}`,
      'journal:',
      ...this.journal.map((l) => `  ${l}`),
    ].join('\n');
  }

  /** After a step: the renderer told, new targets, the page asked for its detail if that changed, and the position written down for the next visit. */
  private stepped(now: number, why: string) {
    this.frameMs = this.tickMs;
    this.lastScaleStep = now;
    this.note(`ladder → scale ${this.ladder.scale.toFixed(2)}, rung ${this.ladder.rung}: ${why}`);
    const was = this.renderer.setEconomy(this.ladder.economy);
    this.resize();
    if (this.verdict) {
      this.verdict = { ...this.verdict, scale: this.ladder.scale, rung: this.ladder.rung, at: Date.now() };
      verdicts.save(this.verdict);
    }
    if (was.detail !== this.ladder.economy.detail) this.onDetail?.(this.ladder.economy.detail);
  }
}
