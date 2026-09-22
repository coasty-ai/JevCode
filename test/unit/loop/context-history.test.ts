/**
 * Tiered history (docs/COORDINATION-DESIGN.md §8.3, §8.5) and the review's blocker (7): the two newest outputs are whole
 * whatever their size, every clip names the path to the full text, and a pointer this device cannot follow says so.
 */
import { describe, expect, it } from 'vitest';
import type { StepRecord, WindowEntry } from '../../../src/core/types.js';
import {
  OUTPUT_GONE,
  buildHistoryEntry,
  collapseHistory,
  expandHistory,
  foldHistoryRecord,
  foldableCount,
  needsOutputFile,
  oneLiner,
  outputReadPath,
  outputRefFor,
  outputView,
  parseOutputRef,
  pushHistory,
  stepsNeedingViews,
  tierOf,
  tierText,
} from '../../../src/loop/context/history.js';
import { HISTORY_STEPS, HISTORY_WHOLE, OUTPUT_FILE_MIN_CHARS } from '../../../src/loop/context/limits.js';
import { WINDOW_OUTPUT_HEAD, WINDOW_OUTPUT_TAIL, buildWindowEntry } from '../../../src/loop/window.js';

function entry(step: number, output: string | null): WindowEntry {
  return buildWindowEntry({ step, intent: 'edit', action: `run cmd-${step}`, outcome: { status: 'executed', summary: 'ok', changedFiles: [] }, output, judge: null, completion: null, shownFiles: [], notes: [], error: null });
}

/** A history of `n` steps, every output `chars` long, the files present. */
function history(n: number, chars: number) {
  let out = [] as ReturnType<typeof buildHistoryEntry>[];
  const texts = new Map<number, string>();
  for (let step = 1; step <= n; step++) {
    const text = `step ${step} `.padEnd(chars, 'x');
    texts.set(step, text);
    out = pushHistory(out, buildHistoryEntry(entry(step, text), text, needsOutputFile(text) ? outputRefFor(step) : null), HISTORY_STEPS);
  }
  return { history: out, views: (step: number) => (texts.has(step) ? outputView(texts.get(step)!) : null) };
}

describe('§8.3 tiered history', () => {
  it('holds ≥ 12 recent steps and keeps state small (bodies stay at the window bound)', () => {
    const { history: h } = history(20, 5_000);
    expect(h).toHaveLength(HISTORY_STEPS);
    expect(h.map((e) => e.step)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    for (const e of h) {
      expect((e.output ?? '').length).toBeLessThanOrEqual(WINDOW_OUTPUT_HEAD + WINDOW_OUTPUT_TAIL + 64);
      expect(e.fullOutputChars).toBe(5_000);
      expect(e.outputRef).toBe(`outputs/step-${e.step}.txt`);
    }
    expect(JSON.stringify(h).length).toBeLessThan(12 * 1_500);
  });

  it('review blocker (7): a 3 KiB output — the size with neither a file nor a body before the fix — is whole', () => {
    const chars = 3 * 1024;
    const { history: h, views } = history(6, chars);
    // the whole text is on disk (the old rule wrote a file only past 12 KiB), the body stays at the window bound
    expect(h.at(-1)!.outputRef).toBe('outputs/step-6.txt');
    expect(h.at(-1)!.fullOutputChars).toBe(chars);
    expect((h.at(-1)!.output ?? '').length).toBeLessThanOrEqual(WINDOW_OUTPUT_HEAD + WINDOW_OUTPUT_TAIL + 64);
    const rendered = expandHistory(h, { view: views });
    for (const r of rendered.slice(-HISTORY_WHOLE)) {
      expect(r.tier).toBe('whole');
      expect(r.output).toHaveLength(chars);
      expect(r.output).toBe(`step ${r.entry.step} `.padEnd(chars, 'x'));
      expect(r.output).not.toContain('omitted');
    }
    // and the tier below it still shows head+tail of the same text, never a 600-char body
    expect(rendered[3]!.tier).toBe('mid');
    expect(rendered[3]!.output).toHaveLength(chars);
  });

  it('review blocker (7): the two newest outputs are WHOLE at every size between the body bound and 32 KiB', () => {
    // 700 chars is the size the design's "> 12 KiB" rule left with neither a file nor a body
    for (const chars of [OUTPUT_FILE_MIN_CHARS + 100, 700, 3 * 1024, 5_000, 12_000, 30_000, 32_768]) {
      const { history: h, views } = history(6, chars);
      const rendered = expandHistory(h, { view: views });
      const newest = rendered.slice(-HISTORY_WHOLE);
      expect(newest.map((r) => r.tier)).toEqual(['whole', 'whole']);
      for (const r of newest) {
        expect(r.output).toHaveLength(chars);
        expect(r.output).not.toContain('omitted');
      }
    }
  });

  it('every output past the body bound goes to disk, so no clip is ever silent', () => {
    expect(needsOutputFile('x'.repeat(OUTPUT_FILE_MIN_CHARS))).toBe(false);
    expect(needsOutputFile('x'.repeat(OUTPUT_FILE_MIN_CHARS + 1))).toBe(true);
    expect(needsOutputFile(null)).toBe(false);
  });

  it('tiers: newest 2 whole, 3–6 head+tail, 7–12 one line — and each clip names the file', () => {
    const { history: h, views } = history(12, 60 * 1024);
    const rendered = expandHistory(h, { view: views });
    expect(rendered.map((r) => r.tier)).toEqual(['line', 'line', 'line', 'line', 'line', 'line', 'mid', 'mid', 'mid', 'mid', 'whole', 'whole']);
    for (const r of rendered) {
      if (r.tier === 'line') {
        expect(r.line).toContain(`full text: read jevcode:outputs/step-${r.entry.step}.txt`);
        expect(r.output).toBeNull();
        continue;
      }
      expect(r.output).toContain(`chars omitted; full text: read jevcode:outputs/step-${r.entry.step}.txt`);
    }
    // whole ≈ 32 KiB, mid ≈ 6 KiB of the same 60 KiB text
    const whole = rendered.at(-1)!.output!.length;
    const mid = rendered[6]!.output!.length;
    expect(whole).toBeGreaterThan(32 * 1024);
    expect(whole).toBeLessThan(33 * 1024);
    expect(mid).toBeGreaterThan(6 * 1024);
    expect(mid).toBeLessThan(6.5 * 1024);
  });

  it('a pointer this device cannot follow is replaced by the truth, never dangled (review finding 22)', () => {
    const { history: h } = history(3, 20_000);
    const rendered = expandHistory(h, { view: () => null, missing: () => true });
    for (const r of rendered) {
      expect(r.line).toContain(OUTPUT_GONE);
      expect(r.line).not.toContain('jevcode:outputs');
      if (r.output !== null) {
        expect(r.output).toContain(`20000 chars in total; ${OUTPUT_GONE}`);
        expect(r.output).not.toContain('jevcode:outputs');
      }
    }
    // with the file present the same entries carry the pointer
    const ok = expandHistory(h, { view: () => null });
    expect(ok.at(-1)!.output).toContain('full text: read jevcode:outputs/step-3.txt');
  });

  it('a short output needs no file and its body is shown as it is', () => {
    const { history: h, views } = history(2, 120);
    const rendered = expandHistory(h, { view: views });
    expect(rendered.at(-1)!.output).toHaveLength(120);
    expect(h.at(-1)!.outputRef).toBeUndefined();
    expect(oneLiner(h.at(-1)!)).toBe('[step 2] run cmd-2 → executed (120 chars)');
  });

  it('only the ≤ 6 newest entries with a file need an output view (≤ 2 reads for the whole tier)', () => {
    const { history: h } = history(12, 20_000);
    expect(stepsNeedingViews(h)).toEqual([12, 11, 10, 9, 8, 7]);
    expect(stepsNeedingViews(h.slice(0, 1))).toEqual([1]);
    expect(stepsNeedingViews([])).toEqual([]);
  });

  it('tierOf / tierText are pure functions of the index and the view', () => {
    expect([0, 1, 2, 5, 6, 11].map(tierOf)).toEqual(['whole', 'whole', 'mid', 'mid', 'line', 'line']);
    const v = outputView('abcdefghij');
    expect(tierText(v, 4, 2, 'outputs/step-1.txt')).toBe(`abcd\n…[4 chars omitted; full text: read ${outputReadPath('outputs/step-1.txt')}]…\nij`);
    expect(tierText(v, 100, 100, null)).toBe('abcdefghij');
  });

  it('the `jevcode:` pseudo-path parses only the outputs/step-<n>.txt form', () => {
    expect(parseOutputRef('jevcode:outputs/step-7.txt')).toBe(7);
    expect(parseOutputRef('outputs/step-7.txt')).toBe(7);
    for (const bad of ['jevcode:outputs/../../etc/passwd', 'jevcode:outputs/step-0.txt', 'jevcode:outputs/step-x.txt', 'src/a.py', 'jevcode:state.json', 'jevcode:outputs/step-7.txt.bak']) {
      expect(parseOutputRef(bad)).toBeNull();
    }
  });

  it('--resume folds a steps.jsonl row with the same bounds and pointer', () => {
    const long = 'y'.repeat(9_000);
    const rec = { step: 5, startedAt: '2026-09-21T00:00:00.000Z', intent: 'run', intentAnswer: 'run', contextFiles: [], proposal: null, risk: null, outcome: { status: 'executed', exec: { command: 'pytest -q', exitCode: 0, stdout: long, stderr: '', durationMs: 1, killedBy: null, truncated: false } }, judge: null, completion: null, decisions: [], timing: {} } as unknown as StepRecord;
    const folded = foldHistoryRecord([], rec);
    expect(folded).toHaveLength(1);
    expect(folded[0]!.outputRef).toBe('outputs/step-5.txt');
    expect(folded[0]!.fullOutputChars).toBe(long.length);
    expect((folded[0]!.output ?? '').length).toBeLessThanOrEqual(WINDOW_OUTPUT_HEAD + WINDOW_OUTPUT_TAIL + 64);
  });

  it('collapse keeps the newest 2 verbatim, folds the rest to one-liners and counts only real folds', () => {
    const { history: h } = history(8, 5_000);
    expect(foldableCount(h)).toBe(6);
    const { history: after, folded } = collapseHistory(h);
    expect(folded.map((e) => e.step)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(after.slice(0, 6).every((e) => e.output === undefined && e.notes.length === 0)).toBe(true);
    expect(after.slice(-2).every((e) => (e.output ?? '').length > 0)).toBe(true);
    // pointers survive the fold, so the folded steps are still recoverable
    expect(after[0]!.outputRef).toBe('outputs/step-1.txt');
    // a second fold finds nothing left to fold
    expect(foldableCount(after)).toBe(0);
    expect(collapseHistory(after).folded).toEqual([]);
  });
});
