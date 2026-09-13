/**
 * The default build's shaders, by hash.
 *
 * Residency is most of what a shader costs, so a feature a consumer opts
 * into must be compiled out for everyone who did not. This holds that
 * rule: the sources the renderer compiles with nothing asked for are
 * hashed, and a change to any of them fails here. A deliberate change to
 * the shared model updates the hash in the same commit, and says why; a
 * permutation that has leaked a line into the default build does not get
 * to.
 */
import { describe, expect, it } from 'vitest';
import { GROUND_WGSL, PBR_WGSL, PREPASS_WGSL, pbrSource } from '../shaders';
import { TRACE_WGSL } from '../tracer';

/** cyrb53: a 53-bit string hash in plain arithmetic, so the test needs nothing of node's. */
function sha(str: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

const EXPECTED: Record<string, string> = {
  'scene, with the table reflected': '1c48856299ccae',
  'scene, without': '1538cff126040e',
  'scene, as exported': '79635e146728f',
  ground: '1e4ad81b2b938a',
  prepass: '1f1620ef9a2a48',
  tracer: '1e94d7a1bf393a',
};

describe('the default build compiles what it did', () => {
  const sources: Record<string, string> = {
    'scene, with the table reflected': pbrSource({ reflectTable: true }),
    'scene, without': pbrSource({ reflectTable: false }),
    'scene, as exported': PBR_WGSL,
    ground: GROUND_WGSL,
    prepass: PREPASS_WGSL,
    tracer: TRACE_WGSL,
  };
  for (const [name, source] of Object.entries(sources)) {
    it(name, () => {
      expect(sha(source), `${name}: the default shader changed — if that was meant, put its new hash here and say why in the commit`).toBe(EXPECTED[name]);
    });
  }
});
