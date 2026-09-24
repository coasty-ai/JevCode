/** TUI-DESIGN §4.7, §19.0 (`killring.test.ts`): 16 entries, newest first, consecutive kills concatenate, Alt+Y rotation. */
import { describe, expect, it } from 'vitest';
import { KILL_RING_MAX, nextYankIndex, pushKill } from '../../../../src/tui/composer/killring.js';

describe('pushKill', () => {
  it('unshifts new kills newest-first and caps the ring at 16', () => {
    let ring: readonly string[] = [];
    for (let i = 0; i < 20; i++) ring = pushKill(ring, `k${i}`, 'unshift');
    expect(ring.length).toBe(KILL_RING_MAX);
    expect(KILL_RING_MAX).toBe(16);
    expect(ring[0]).toBe('k19');
    expect(ring[15]).toBe('k4');
  });
  it('append and prepend extend the newest entry; on an empty ring they start one', () => {
    expect(pushKill(['ab'], 'cd', 'append')).toEqual(['abcd']);
    expect(pushKill(['ab'], 'cd', 'prepend')).toEqual(['cdab']);
    expect(pushKill(['ab', 'z'], 'cd', 'append')).toEqual(['abcd', 'z']);
    expect(pushKill([], 'cd', 'append')).toEqual(['cd']);
    expect(pushKill([], 'cd', 'prepend')).toEqual(['cd']);
  });
  it('ignores empty kills and never mutates its input', () => {
    const ring = ['a'];
    expect(pushKill(ring, '', 'unshift')).toBe(ring);
    expect(pushKill(ring, '', 'append')).toBe(ring);
    pushKill(ring, 'b', 'unshift');
    expect(ring).toEqual(['a']);
  });
});

describe('nextYankIndex', () => {
  it('rotates towards older entries and wraps to the newest', () => {
    const ring = ['n', 'o', 'p'];
    expect(nextYankIndex(ring, 0)).toBe(1);
    expect(nextYankIndex(ring, 1)).toBe(2);
    expect(nextYankIndex(ring, 2)).toBe(0);
    expect(nextYankIndex(['x'], 0)).toBe(0);
  });
  it('is null on an empty ring and recovers from bad indices', () => {
    expect(nextYankIndex([], 0)).toBeNull();
    expect(nextYankIndex(['a', 'b'], -1)).toBe(0);
    expect(nextYankIndex(['a', 'b'], Number.NaN)).toBe(0);
    expect(nextYankIndex(['a', 'b'], 7)).toBe(0);
  });
});
