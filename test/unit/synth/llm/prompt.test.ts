import { describe, expect, it } from 'vitest';

import { HEAD_TAIL_MARKER } from '../../../../src/core/text.js';
import { PROMPT_LIMITS_FIX, buildFixSystemPrompt, buildFixUserMessage, fixPromptCharBound, hintSchedule, listingSet, renderHint, type FixPromptInput } from '../../../../src/synth/llm/prompt.js';
import type { FailureView, SourceFile } from '../../../../src/synth/types.js';
import { sourceFile } from '../search/helpers.js';
import { calcFiles } from './fixtures.js';

const files = calcFiles();

function baseInput(over: Partial<FixPromptInput> = {}): FixPromptInput {
  return {
    goal: { tests: ['tests/test_calc.py::test_add'], path: 'src/calc.py' },
    task: 'add() must treat None as 0',
    failures: [{ testId: 'tests/test_calc.py::test_add', call: 'add(None, 2)', expected: '2', actual: "TypeError: unsupported operand type(s) for +: 'NoneType' and 'int'" }],
    localisation: [{ path: 'src/calc.py', line: 4, fn: 'add', origin: 'traceback' }],
    listings: listingSet({ files, frames: [{ path: 'src/calc.py', line: 4 }], anchors: [] }),
    attempts: [],
    hint: { tiers: [] },
    ...over,
  };
}

describe('buildFixUserMessage: every section is bounded', () => {
  it('clips an oversized task, failure list, traceback, listing, ledger and partial to PROMPT_LIMITS_FIX', () => {
    const big = 'x'.repeat(20_000);
    const failures: FailureView[] = Array.from({ length: 50 }, (_, i) => ({ testId: `t::test_${i}`, call: big, expected: big, actual: big }));
    const longFile = sourceFile('src/long.py', `def f():\n${Array.from({ length: 500 }, (_, i) => `    x${i} = ${i}`).join('\n')}\n    return x0\n`);
    const manyFiles = new Map<string, SourceFile>([...files, ['src/long.py', longFile]]);
    const listings = listingSet({ files: manyFiles, frames: [{ path: 'src/long.py', line: 250 }], anchors: Array.from({ length: 10 }, (_, i) => ({ path: 'src/calc.py', line: 2 + i })) });
    expect(listings.length).toBeLessThanOrEqual(PROMPT_LIMITS_FIX.listings);
    expect(listings[0]!.lines.length).toBe(PROMPT_LIMITS_FIX.listingLines);
    expect(listings[0]!.origin).toBe('traceback');
    const msg = buildFixUserMessage(baseInput({ task: big, failures, traceback: big, listings, attempts: Array.from({ length: 20 }, (_, i) => ({ op: `sample_${i}_0`, step: i, diffHead: big, verdict: big, sha: `s${i}` })), partial: { diff: big }, outlines: [{ path: 'src/a.py', symbols: Array.from({ length: 100 }, (_, i) => `f${i}()`) }] }));
    expect(msg.length).toBeLessThan(fixPromptCharBound());
    expect(msg).toContain(HEAD_TAIL_MARKER(20_000 - PROMPT_LIMITS_FIX.taskHeadChars - PROMPT_LIMITS_FIX.taskTailChars).trim());
    expect(msg.match(/^- t::test_\d+: called/gm)).toHaveLength(PROMPT_LIMITS_FIX.failures);
    expect(msg).toContain('- +47 more failing tests of this goal');
    expect(msg.match(/^- sample_\d+_0 \(step/gm)).toHaveLength(PROMPT_LIMITS_FIX.attempts);
    expect(msg).toContain('… 60 more');
    for (const section of ['# Goal', '## Task', '## Failing behaviour', '## Localisation', '## Code', '## Other files', '## Earlier attempts this run', '## Best partial so far', '## Reply']) expect(msg).toContain(section);
    expect(msg).not.toContain('## Hint');
  });

  it('names the goal tests (≤ 3, +N more), derives the failure status and lists traceback frames before Jev lines', () => {
    const msg = buildFixUserMessage(
      baseInput({
        goal: { tests: ['t::a', 't::b', 't::c', 't::d', 't::e'], path: 'src/calc.py' },
        failures: [
          { testId: 't::a', call: 'add(None, 2)', expected: '2', actual: 'TypeError: bad operand' },
          { testId: 't::b', call: 'add(1, 2)', expected: '3', actual: '4' },
        ],
        localisation: [
          { path: 'src/calc.py', line: 8, fn: 'sub', origin: 'jev', probability: 0.4 },
          { path: 'src/calc.py', line: 4, fn: 'add', origin: 'traceback' },
        ],
      }),
    );
    expect(msg).toContain('fix t::a, t::b, t::c, +2 more in src/calc.py');
    expect(msg).toContain('status error');
    expect(msg).toContain('status failed');
    expect(msg.indexOf('src/calc.py:L4 (fn add) — traceback frame')).toBeLessThan(msg.indexOf('src/calc.py:L8 (fn sub)'));
    expect(msg).toContain('L4:     return a + b');
    expect(buildFixSystemPrompt()).toContain('propose_fix');
  });
});

describe('hints: h1 gated on P(top) ≥ 0.9', () => {
  it('renders h1 only above the gate and drops it from the schedule below it', () => {
    expect(renderHint({ tiers: ['h1'], anchor: { path: 'src/calc.py', line: 4, probability: 0.85 } })).toBeNull();
    expect(renderHint({ tiers: ['h1'], anchor: { path: 'src/calc.py', line: 4, probability: 0.92 } })).toBe('Jev put p=0.92 on `src/calc.py:L4`.');
    const gated = hintSchedule('quixbugs', 4, { anchor: { path: 'src/calc.py', line: 4, probability: 0.5 } });
    expect(gated.map((h) => h.tiers)).toEqual([[], ['h2'], ['h3'], ['h2']]);
    const open = hintSchedule('quixbugs', 4, { anchor: { path: 'src/calc.py', line: 4, probability: 0.95 }, editClass: 'change_operator' });
    expect(open.map((h) => h.tiers)).toEqual([[], ['h1'], ['h2'], ['h3']]);
    expect(open[1]!.anchor?.line).toBe(4);
    const repo = hintSchedule('repository', 6, { anchor: { path: 'src/calc.py', line: 4, probability: 0.95 }, editClass: 'insert_new_line', tReproMs: 800 });
    expect(repo.map((h) => h.tiers)).toEqual([[], ['h1'], ['h2'], ['h3'], ['h1', 'h2'], ['h4']]);
    const msg = buildFixUserMessage(baseInput({ hint: { tiers: ['h1', 'h2'], anchor: { path: 'src/calc.py', line: 4, probability: 0.8 } } }));
    expect(msg).toContain('## Hint\nPrefer the smallest change');
    expect(msg).not.toContain('Jev put');
  });

  it('listingSet keeps the ≤ 3 deepest frames, folds anchors inside a listed span and caps at 4', () => {
    const set = listingSet({
      files,
      frames: [
        { path: 'src/calc.py', line: 2 },
        { path: 'src/calc.py', line: 8 },
        { path: 'src/calc.py', line: 14 },
        { path: 'src/util.py', line: 2 },
      ],
      anchors: [{ path: 'src/calc.py', line: 17 }, { path: 'src/calc.py', line: 3 }, { path: 'src/missing.py', line: 1 }],
    });
    // deepest first: util.clamp, scale, sub — add (frame 1) is the 4th deepest and enters via the anchor L3
    expect(set.map((l) => `${l.name}:${l.origin}`)).toEqual(['clamp:traceback', 'scale:traceback', 'sub:traceback', 'add:jev']);
    expect(set.length).toBeLessThanOrEqual(PROMPT_LIMITS_FIX.listings);
  });
});
