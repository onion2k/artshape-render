// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Camera, Orbit } from '../camera';

/** A plain Event with the extra fields Orbit's handlers read, dispatched
 *  through a real jsdom element so this exercises actual addEventListener
 *  wiring rather than calling private handlers directly. */
function pointerEvent(type: string, fields: Partial<PointerEvent> & { clientX?: number; clientY?: number }) {
  const e = new Event(type, { bubbles: true, cancelable: true }) as unknown as PointerEvent;
  Object.assign(e, { pointerId: 1, button: 0, clientX: 0, clientY: 0, shiftKey: false, ...fields });
  return e;
}
function wheelEvent(deltaY: number) {
  const e = new Event('wheel', { bubbles: true, cancelable: true }) as unknown as WheelEvent;
  Object.assign(e, { deltaY });
  return e;
}

function setup(camPos: [number, number, number] = [0, 10, 0]) {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true });
  document.body.appendChild(el);
  const camera = new Camera();
  camera.position = camPos;
  camera.target = [0, 0, 0];
  const orbit = new Orbit(camera, { element: el, ease: 1, inertia: 0 }); // ease 1: no smoothing lag in tests
  return { el, camera, orbit };
}

describe('Orbit: construction', () => {
  it('reads its initial spherical position from the camera', () => {
    const { camera } = setup([0, 20, 0]);
    // radius should match the initial camera distance from target
    expect(Math.hypot(...camera.position)).toBeCloseTo(20);
  });

  it('is not moving at rest', () => {
    const { orbit } = setup();
    expect(orbit.moving).toBe(false);
  });
});

describe('Orbit: drag rotates the camera', () => {
  it('a horizontal drag changes the camera position after update()', () => {
    const { el, camera, orbit } = setup([0, 20, 0]);
    const before = [...camera.position];
    el.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 100 }));
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 160, clientY: 100 }));
    orbit.update();
    expect(camera.position).not.toEqual(before);
  });

  it('reports moving while a drag is still easing in', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true });
    const camera = new Camera();
    camera.position = [0, 20, 0];
    // deliberately slow ease, so moving() stays true for more than one update
    const orbit = new Orbit(camera, { element: el, ease: 0.1, inertia: 0.9 });
    el.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 100 }));
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 200, clientY: 100 }));
    orbit.update();
    expect(orbit.moving).toBe(true);
  });

  it('ignores a pointermove for a different pointerId', () => {
    const { el, camera, orbit } = setup([0, 20, 0]);
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 100 }));
    window.dispatchEvent(pointerEvent('pointermove', { pointerId: 2, clientX: 300, clientY: 300 }));
    const before = [...camera.position];
    orbit.update();
    expect(Math.hypot(...camera.position.map((v, i) => v - before[i]) as [number, number, number])).toBeCloseTo(0, 6);
  });

  it('stops responding to pointermove after pointerup', () => {
    const { el, camera, orbit } = setup([0, 20, 0]);
    el.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 100 }));
    window.dispatchEvent(pointerEvent('pointerup', { clientX: 100, clientY: 100 }));
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 400, clientY: 400 }));
    orbit.update();
    const afterFirst = [...camera.position];
    orbit.update();
    expect(camera.position).toEqual(afterFirst);
  });
});

describe('Orbit: wheel zooms', () => {
  it('a negative deltaY (scroll up) moves the camera closer to the target', () => {
    const { el, camera, orbit } = setup([0, 20, 0]);
    el.dispatchEvent(wheelEvent(-100));
    orbit.update();
    expect(Math.hypot(...camera.position)).toBeLessThan(20);
  });

  it('a positive deltaY (scroll down) moves the camera further away', () => {
    const { el, camera, orbit } = setup([0, 20, 0]);
    el.dispatchEvent(wheelEvent(100));
    orbit.update();
    expect(Math.hypot(...camera.position)).toBeGreaterThan(20);
  });

  it('respects minDistance and maxDistance', () => {
    const el = document.createElement('div');
    const camera = new Camera();
    camera.position = [0, 5, 0];
    camera.target = [0, 0, 0];
    const orbit = new Orbit(camera, { element: el, ease: 1, minDistance: 4, maxDistance: 10 });
    for (let i = 0; i < 50; i++) { el.dispatchEvent(wheelEvent(-1000)); orbit.update(); }
    expect(Math.hypot(...camera.position)).toBeGreaterThanOrEqual(4 - 1e-6);
  });
});

describe('Orbit: disabled ignores input', () => {
  it('a drag does nothing while disabled', () => {
    const { el, camera, orbit } = setup([0, 20, 0]);
    orbit.enabled = false;
    el.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 100 }));
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 300, clientY: 300 }));
    const before = [...camera.position];
    orbit.update();
    expect(Math.hypot(...camera.position.map((v, i) => v - before[i]) as [number, number, number])).toBeCloseTo(0, 6);
  });
});

describe('Orbit: forcePosition', () => {
  it('adopts a manually-moved camera position immediately, with no easing lag', () => {
    const el = document.createElement('div');
    const camera = new Camera();
    camera.position = [0, 20, 0];
    camera.target = [0, 0, 0];
    const orbit = new Orbit(camera, { element: el, ease: 0.05 }); // slow ease
    camera.position = [0, 0, 40];
    orbit.forcePosition();
    expect(orbit.moving).toBe(false);
    expect(Math.hypot(...camera.position)).toBeCloseTo(40, 1);
  });
});

describe('Orbit: remove() detaches its listeners', () => {
  it('a drag after remove() no longer moves the camera', () => {
    const { el, camera, orbit } = setup([0, 20, 0]);
    orbit.remove();
    el.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 100 }));
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 300, clientY: 300 }));
    const before = [...camera.position];
    orbit.update();
    expect(Math.hypot(...camera.position.map((v, i) => v - before[i]) as [number, number, number])).toBeCloseTo(0, 6);
  });
});
