import { describe, expect, it } from 'vitest';
import { GLYPHS, cellWidth } from '../../../../src/tui/glyphs.js';
import { NO_TIMELINE_YET, letterStrip, secs, timelineRows } from '../../../../src/tui/pane/timeline.js';
import type { TimelineStep } from '../../../../src/tui/pane/model.js';
import { paneState, timelineFixture } from './helpers.js';

const live = (step: number, stages: TimelineStep['stages']): TimelineStep => ({ step, stages, totalMs: null, harnessMs: null, generatorTokens: null, generatorUsd: null });

describe('timeline tab (TUI-DESIGN §7.2 `t`, §24, frame F-T)', () => {
  it('formats seconds as .21s / 6.1s / 41s / 1m2s', () => {
    expect(secs(210)).toBe('.21s');
    expect(secs(6100)).toBe('6.1s');
    expect(secs(41_000)).toBe('41s');
    expect(secs(62_000)).toBe('1m2s');
    expect(secs(0)).toBe('.00s');
    expect(secs(Number.NaN)).toBe('?s');
    expect(secs(-5)).toBe('?s');
  });
  it('never yields `.100s` or `10.0s`: every carry moves to the next form and the width never grows', () => {
    expect(secs(994)).toBe('.99s');
    expect(secs(995)).toBe('1.0s');
    expect(secs(999)).toBe('1.0s');
    expect(secs(999.9)).toBe('1.0s');
    expect(secs(9949)).toBe('9.9s');
    expect(secs(9950)).toBe('10s');
    expect(secs(9999)).toBe('10s');
    expect(secs(59_499)).toBe('59s');
    expect(secs(59_999)).toBe('59s');
    expect(secs(60_000)).toBe('1m');
    for (let ms = 0; ms < 70_000; ms += 7) expect(secs(ms).length).toBeLessThanOrEqual(4);
  });
  it('sizes the letters round(ms/total·40), at least one per stage that took time, cut to the width', () => {
    const s7 = timelineFixture().find((s) => s.step === 7)!;
    const strip = letterStrip(s7, 40);
    expect(strip.length).toBeLessThanOrEqual(40);
    expect(strip).toMatch(/^I+C+P+R+X+J+$/);
    expect((strip.match(/P/g) ?? []).length).toBe(Math.round((6100 / 8200) * 40));
    expect(letterStrip(s7, 30).length).toBeLessThanOrEqual(30);
    expect(letterStrip(s7, 0)).toBe('');
    expect(letterStrip(live(1, {}), 40)).toBe('');
  });
  it('a 0 ms stage draws no letter (a skipped intent is not shown as time spent)', () => {
    expect(letterStrip(live(1, { intent: 0, propose: 1000 }), 40)).toBe('P'.repeat(40));
    expect(letterStrip(live(1, { intent: 0, context: 0, propose: 500, execute: 500 }), 40)).toBe(`${'P'.repeat(20)}${'X'.repeat(20)}`);
    expect(letterStrip(live(1, { intent: 1, propose: 10_000 }), 40)).toMatch(/^IP+$/);
  });
  it('renders two rows per step, newest first, at 80 columns with the §24 two-space step pad', () => {
    const out = timelineRows(paneState({ tab: 't' }), 12, 80);
    expect(out.length).toBe(4);
    expect(out[0]).toBe('time  s7  intent .21s  ctx .24s  propose 6.1s  risk .23s  exec 1.2s  judge .19s');
    expect(out[1]).toMatch(/^ {6}s7 {2}I+C+P+R+X+J+ {2}total 8\.2s {2}h 31ms$/);
    expect(out[2]).toBe('time  s6  intent .20s  ctx .22s  propose 4.9s  risk .22s  exec 1.6s  judge .18s');
    expect(out[3]).toMatch(/^ {6}s6 {2}I+C+P+R+X+J+ {2}total 7\.4s {2}h 24ms$/);
    for (const l of out) expect(cellWidth(l)).toBeLessThanOrEqual(80);
  });
  it('a two-digit step widens the label for every row shown, keeping the strips aligned', () => {
    const t = [live(12, { intent: 200, propose: 800 }), live(9, { intent: 200, propose: 800 })];
    const out = timelineRows(paneState({ timeline: t }), 12, 80);
    expect(out[0]!.startsWith('time  s12  intent .20s')).toBe(true);
    expect(out[1]!.startsWith('      s12  I')).toBe(true);
    expect(out[2]!.startsWith('time  s9   intent .20s')).toBe(true);
    expect(out[3]!.startsWith('      s9   I')).toBe(true);
    expect(out[1]!.indexOf('I')).toBe(out[3]!.indexOf('I'));
    // only the rows shown count: with the budget cut to s12's two rows, s9 does not widen anything, and a lone s9 uses two cells
    expect(timelineRows(paneState({ timeline: [live(9, { intent: 1 }), live(12, { intent: 1 })] }), 2, 80)[0]!.startsWith('time  s12  ')).toBe(true);
    expect(timelineRows(paneState({ timeline: [live(9, { intent: 1 })] }), 2, 80)[0]!.startsWith('time  s9  intent')).toBe(true);
  });
  it('renders one row per step with 30 letters and gen at ≥ 120 columns', () => {
    const out = timelineRows(paneState({ tab: 't' }), 12, 120);
    expect(out.length).toBe(2);
    expect(out[0]).toMatch(/^time {2}s7 {2}I+C+P+R+X+J+ +total 8\.2s {2}h 31ms {2}gen 5\.4k \$0\.032 {2}I\.21 C\.24 P6\.1 R\.23 X1\.2 J\.19$/);
    for (const l of out) expect(cellWidth(l)).toBeLessThanOrEqual(120);
  });
  it('caps at rows (an odd budget cuts a step in half), truncates narrow columns, renders the placeholder', () => {
    const s = paneState({ tab: 't' });
    expect(timelineRows(s, 3, 80).length).toBe(3);
    expect(timelineRows(s, 0, 80)).toEqual([]);
    for (const c of [20, 59, 79]) for (const l of timelineRows(s, 12, c)) expect(cellWidth(l)).toBeLessThanOrEqual(c);
    expect(timelineRows(paneState({ timeline: [] }), 5, 80)).toEqual([NO_TIMELINE_YET]);
  });
  it('a live step (no step:end yet) uses the sum of stages as its total', () => {
    const state = paneState({ timeline: [live(9, { intent: 500, context: 500 })] });
    const out = timelineRows(state, 2, 80);
    expect(out[1]).toMatch(/I{20}C{20} {2}total 1\.0s$/);
    expect(timelineRows(state, 1, 120)[0]).not.toContain('gen');
  });
  it('ascii twin is ASCII', () => {
    for (const l of timelineRows(paneState({ tab: 't' }), 12, 120, GLYPHS.ascii)) expect(l).toMatch(/^[\x20-\x7e]*$/);
  });
});
