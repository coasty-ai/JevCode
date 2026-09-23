/**
 * The stream probe's known replies (`src/perf/stream-fixture.ts`): the shapes the probe's per-delta pairing and the
 * commit comparison rely on — unique whole-token markers on every text delta, the structure-only deltas marker-free,
 * and the `mixed` reply exactly the prototype's (46 deltas, 421 characters, 40 markers).
 */
import { describe, expect, it } from 'vitest';
import { STREAM_PRESETS, markerOf, markerRe, streamPreset, streamPresetName } from '../../../src/perf/stream-fixture.js';

describe('stream fixture presets', () => {
  it('mixed: 46 deltas, 421 characters, 40 unique markers; the rest carry only line structure', () => {
    const p = streamPreset('mixed');
    expect(p.deltas).toHaveLength(46);
    expect(p.text).toHaveLength(421);
    expect(p.text).toBe(p.deltas.join(''));
    const markers = p.markers.filter((m): m is string => m !== null);
    expect(markers).toHaveLength(40);
    expect(new Set(markers).size).toBe(40);
    // the unmarked deltas are newlines and fence lines only
    expect(p.deltas.filter((_, i) => p.markers[i] === null)).toEqual(['\n', '\n', '\n', '\n', '```ts\n', '```\n']);
    // a greeting line split across two deltas, a paragraph wider than two 80-column rows, bullets, a fence, blank lines, no final newline
    const lines = p.text.split('\n');
    expect(lines[0]).toBe('Sure k01. Here is the plan k02.');
    expect(lines.some((l) => l.length > 160)).toBe(true);
    expect(lines.filter((l) => l.startsWith('- '))).toHaveLength(3);
    expect(lines.filter((l) => l === '')).toHaveLength(3);
    expect(p.text.endsWith('Done k05.')).toBe(true);
  });

  it('long: about 8 KB of paragraphs, a unique three-digit marker on every word delta', () => {
    const p = streamPreset('long');
    expect(p.text.length).toBeGreaterThan(7000);
    expect(p.text.length).toBeLessThan(9000);
    const markers = p.markers.filter((m): m is string => m !== null);
    expect(markers).toHaveLength(528);
    expect(new Set(markers).size).toBe(528);
    expect(p.deltas.filter((_, i) => p.markers[i] === null).every((d) => d === '\n\n')).toBe(true);
  });

  it('markers match as whole tokens only: `p1x` is never found inside `p17`, nor inside a longer word or the status clock', () => {
    expect(markerOf('word p07 ')).toBe('p07');
    expect(markerOf('\n')).toBeNull();
    expect(markerOf('stream n123 ')).toBe('n123');
    expect(markerRe('p01').test('word p01 word')).toBe(true);
    expect(markerRe('p01').test('word p012')).toBe(false);
    expect(markerRe('p01').test('xp01')).toBe(false);
    // the status row's clock `0m00s` holds `m00`, which is why markers are matched per token, never by the bare pattern
    expect(markerRe('m00').test('0m00s')).toBe(false);
  });

  it('preset names parse strictly', () => {
    expect(STREAM_PRESETS).toEqual(['mixed', 'long']);
    expect(streamPresetName('mixed')).toBe('mixed');
    expect(streamPresetName(' long ')).toBe('long');
    expect(streamPresetName('')).toBeNull();
    expect(streamPresetName(undefined)).toBeNull();
    expect(streamPresetName('MIXED')).toBeNull();
  });
});
