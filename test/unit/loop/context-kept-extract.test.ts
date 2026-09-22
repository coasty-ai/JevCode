/**
 * F26 — kept-item EXTRACTION (docs/COORDINATION-DESIGN.md §8.6, fourth bullet).
 *
 * `rankKept` (R5-H2) landed with the ordering pass and its question batch, and nothing ever produced a
 * candidate: `CheckpointState.kept` had no writer, so `'code'` ranked an empty list and `'jev'` had nothing to
 * ask about. §8.6 says the extraction is the whole mechanism under `'code'` — so without it the switch is
 * inert in both positions.
 *
 * What this file pins:
 *   - the candidates the code derives from a scripted history (the failing-test summary, the tests a done item
 *     flipped, the files the run edited, the declined / blocked reasons, the open problems), in code order;
 *   - the keys are CONTENT-derived and stable — the same candidate gets the same `keptKey` in every request and
 *     across two runs, which is what makes `rankKept`'s answers comparable (REPORT §10);
 *   - human `/keep` items are pinned first, in the order they were given, and are never ranked;
 *   - the cap is KEPT_MAX and it is applied before ranking;
 *   - nothing here reaches `compactCode`: the §8.6 byte golden is unchanged (asserted in context-compaction.test.ts).
 */
import { describe, expect, it } from 'vitest';
import type { CheckpointState, FileMemory, HistoryEntry, LastTestRun, Plan } from '../../../src/core/types.js';
import { KEPT_MAX, KEPT_TEXT_MAX, keptKey, type KeptItem } from '../../../src/loop/context/compaction.js';
import { KEPT_FAILING_IDS_MAX, assertionLineFor, extractKept, keptCandidates, readKeptItems } from '../../../src/loop/context/kept.js';
import { buildHistoryEntry, needsOutputFile, pushHistory } from '../../../src/loop/context/history.js';
import { buildWindowEntry } from '../../../src/loop/window.js';

const TASK = 'Fix f() in src/a.ts so that tests/test_a.py::test_f passes';

function plan(): Plan {
  return {
    done: [
      { text: 'read the failing test', evidence: { step: 2, judged: 0.91 } },
      { text: 'fix f()', evidence: { step: 6, judged: 0.88 } },
    ],
    remaining: ['run the suite'],
    unverified: [],
    openProblems: ['the ladder fixture writes into /tmp and the sandbox refuses it'],
    harnessProblems: [{ kind: 'replan', text: 'the same edit three times', step: 5 }],
  } as unknown as Plan;
}

/** §8.6's first named source: the ids the engine's own reader returned, and the output they came out of. */
const FAILING = ['tests/test_a.py::test_f'];
const TEST_OUTPUT = 'F.\nFAILED tests/test_a.py::test_f - assert 1 == 2\n1 failed, 12 passed in 0.10s\n';

const lastTestRun: LastTestRun = { step: 6, command: 'pytest -q', passed: 12, failed: 1, errors: 0, allPassed: false };

const fileMemory: FileMemory = {
  'src/a.ts': { sha12: 'abcdef012345', bytes: 120, readAt: 2, editedAt: 6 },
  'src/b.ts': { sha12: 'beef00112233', bytes: 90, readAt: 3, editedAt: 4 },
  // read but never edited: not a fact the run ESTABLISHED, so not a candidate
  'tests/test_a.py': { sha12: null, bytes: 80, readAt: 1, editedAt: null },
};

/** Eight steps: six ordinary edits, one declined at step 7 and one blocked at step 8. */
function history(): HistoryEntry[] {
  let h: HistoryEntry[] = [];
  const push = (e: ReturnType<typeof buildWindowEntry>, out: string): void => {
    h = pushHistory(h, buildHistoryEntry(e, out, needsOutputFile(out) ? `outputs/step-${e.step}.txt` : null));
  };
  for (let step = 1; step <= 6; step++) {
    const out = `output of step ${step}`;
    push(buildWindowEntry({ step, intent: 'edit', action: `edit src/f${step}.ts`, outcome: { status: 'executed', summary: 'ok', changedFiles: [] }, output: out, judge: null, completion: 0.5, shownFiles: [], notes: [], error: null }), out);
  }
  push(buildWindowEntry({ step: 7, intent: 'edit', action: 'edit src/b.ts', outcome: { status: 'declined', reason: 'the reviewer declined: it touches a path another session holds' }, output: '', judge: null, completion: 0, shownFiles: [], notes: [], error: null }), '');
  push(buildWindowEntry({ step: 8, intent: 'verify', action: 'run pip install requests', outcome: { status: 'blocked', reason: 'no network: the sandbox refuses outbound sockets' }, output: '', judge: null, completion: 0, shownFiles: [], notes: [], error: null }), '');
  return h;
}

function input(over: Partial<Parameters<typeof extractKept>[0]> = {}): Parameters<typeof extractKept>[0] {
  return { task: TASK, plan: plan(), history: history(), fileMemory, lastTestRun, failingTests: FAILING, testOutput: TEST_OUTPUT, ...over };
}

describe('F26 §8.6 — what the code extracts at a compaction', () => {
  it('a scripted 8-step history yields the expected candidates, in code order', () => {
    const kept = extractKept(input());
    expect(kept.map((k) => `${k.kind}@${k.step}: ${k.text}`)).toEqual([
      'fact@8: step 8 run pip install requests was blocked: no network: the sandbox refuses outbound sockets',
      'fact@7: step 7 edit src/b.ts was declined: the reviewer declined: it touches a path another session holds',
      'fact@6: pytest -q at step 6: 12 passed, 1 failed, 0 errors',
      'fact@6: tests/test_a.py::test_f fails at step 6: FAILED tests/test_a.py::test_f - assert 1 == 2',
      'file@6: src/a.ts',
      'fact@5: [replan, step 5] the same edit three times',
      'file@4: src/b.ts',
      'fact@0: open problem: the ladder fixture writes into /tmp and the sandbox refuses it',
    ]);
    // every derived item is the code's, so a `jev-off` run extracts exactly the same list
    expect(kept.every((k) => k.by === 'code')).toBe(true);
  });

  it('the keys are content-derived and stable across runs, and unique within one request', () => {
    const a = extractKept(input());
    const b = extractKept(input());
    const keysOf = (items: readonly KeptItem[]): string[] => {
      const taken = new Set<string>();
      return items.map((i) => {
        const k = keptKey(i, taken);
        taken.add(k);
        return k;
      });
    };
    const ka = keysOf(a);
    expect(keysOf(b)).toEqual(ka);
    expect(new Set(ka).size).toBe(ka.length);
    // `keep_1` / `still_relevant_2` would carry a position prior (REPORT §10); these carry the content's sha
    for (const k of ka) expect(k).toMatch(/^(?:fact|file)_[0-9a-f]{6,}$/);
  });

  it('a candidate that moves position keeps its key; one whose TEXT changes gets a new one', () => {
    const one = extractKept(input({ plan: { ...plan(), openProblems: [] } as unknown as Plan }));
    const two = extractKept(input());
    const src = (items: readonly KeptItem[]): KeptItem => items.find((i) => i.kind === 'file' && i.text === 'src/a.ts')!;
    expect(keptKey(src(two), new Set())).toBe(keptKey(src(one), new Set()));
    expect(keptKey({ kind: 'file', text: 'src/c.ts', step: 6, by: 'code' }, new Set())).not.toBe(keptKey(src(one), new Set()));
  });

  it('human `/keep` items are pinned first, in the order given, and are never ranked', () => {
    const human: KeptItem[] = [
      { kind: 'fact', text: 'the acceptance criterion is the ladder suite, not the unit suite', step: 1, by: 'human' },
      { kind: 'fact', text: 'do not touch src/legacy/**', step: 9, by: 'human' },
    ];
    const kept = extractKept(input({ human }));
    // by step alone the newer one would lead; the human's own order is what stands
    expect(kept.slice(0, 2)).toEqual(human);
    expect(kept.slice(2).every((k) => k.by === 'code')).toBe(true);
  });

  it('the cap is KEPT_MAX and it is applied BEFORE ranking (the newest survive, humans always)', () => {
    const many = Array.from({ length: 40 }, (_, i) => `open problem number ${i}`);
    const human: KeptItem[] = [{ kind: 'fact', text: 'pinned by the human', step: 1, by: 'human' }];
    const kept = extractKept(input({ human, plan: { ...plan(), openProblems: many } as unknown as Plan }));
    expect(kept).toHaveLength(KEPT_MAX);
    expect(kept[0]).toEqual(human[0]);
    // a smaller explicit cap is honoured, and the human still leads it
    const small = extractKept(input({ human, max: 3 }));
    expect(small).toHaveLength(3);
    expect(small[0]!.by).toBe('human');
  });

  it('every text is one line and clipped at KEPT_TEXT_MAX, and duplicates collapse onto the newest step', () => {
    const noisy = extractKept(
      input({
        plan: { ...plan(), openProblems: ['x'.repeat(900), 'a\nb\n  c'] } as unknown as Plan,
      }),
    );
    for (const k of noisy) {
      expect(k.text.length).toBeLessThanOrEqual(KEPT_TEXT_MAX);
      expect(k.text).not.toContain('\n');
    }
    // the same file edited at two steps is ONE candidate, at the newer step
    const dupes = keptCandidates(input({ fileMemory: { 'src/a.ts': { sha12: null, bytes: 1, readAt: null, editedAt: 6 } } }));
    expect(dupes.filter((k) => k.kind === 'file' && k.text === 'src/a.ts')).toHaveLength(1);
  });

  it('an empty run extracts nothing, so `CheckpointState.kept` stays absent', () => {
    const empty = extractKept({ task: TASK, plan: { done: [], remaining: [], unverified: [], openProblems: [], harnessProblems: [] } as unknown as Plan, history: [], fileMemory: {}, lastTestRun: null });
    expect(empty).toEqual([]);
  });

  it('a green run does not keep the test summary as a fact — there is nothing left to re-derive', () => {
    const green: LastTestRun = { ...lastTestRun, passed: 13, failed: 0, errors: 0, allPassed: true };
    const kept = extractKept(input({ lastTestRun: green, failingTests: [], testOutput: '13 passed in 0.10s' }));
    expect(kept.some((k) => k.text.startsWith('pytest -q at step'))).toBe(false);
    expect(kept.some((k) => k.text.includes('::test_f'))).toBe(false);
  });

  it('a failing id whose assertion line the output does not carry is still a candidate, by id alone', () => {
    const kept = extractKept(input({ testOutput: 'nothing recognisable here' }));
    expect(kept.some((k) => k.text === 'tests/test_a.py::test_f fails (pytest -q at step 6)')).toBe(true);
    // assertionLineFor says so itself, rather than inventing a line
    expect(assertionLineFor('nothing recognisable here', 'tests/test_a.py::test_f')).toBeNull();
    expect(assertionLineFor(TEST_OUTPUT, 'tests/test_a.py::test_f')).toBe('FAILED tests/test_a.py::test_f - assert 1 == 2');
  });

  it('at most KEPT_FAILING_IDS_MAX failing ids become candidates — past that it is the same cluster said again', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `tests/test_a.py::test_${i}`);
    const kept = keptCandidates(input({ failingTests: ids, testOutput: null }));
    expect(kept.filter((k) => k.text.includes('::test_')).length).toBe(KEPT_FAILING_IDS_MAX);
  });

  it('an untrusted state.json round-trips through readKeptItems, and a malformed row is dropped', () => {
    const good = extractKept(input());
    expect(readKeptItems({ kept: good } as unknown as CheckpointState)).toEqual(good);
    const dirty = { kept: [{ kind: 'fact', text: 'ok', step: 3, by: 'code' }, { kind: 'nonsense', text: 'x', step: 1, by: 'code' }, { kind: 'fact', text: '', step: 1, by: 'code' }, { kind: 'fact', text: 'y', step: -1, by: 'code' }, { kind: 'fact', text: 'z', step: 1, by: 'martian' }, 'not an object'] };
    expect(readKeptItems(dirty as unknown as CheckpointState)).toEqual([{ kind: 'fact', text: 'ok', step: 3, by: 'code' }]);
    expect(readKeptItems({} as unknown as CheckpointState)).toEqual([]);
    // and it is bounded, so a hostile state.json cannot grow the prompt
    const many = Array.from({ length: 200 }, (_, i) => ({ kind: 'fact', text: `f${i}`, step: i, by: 'code' }));
    expect(readKeptItems({ kept: many } as unknown as CheckpointState)).toHaveLength(KEPT_MAX);
  });
});

/**
 * Review defect **A4**: without `carried` the extraction is a pure function of the still-visible 12-step history
 * window, so `kept` could only ever hold facts the prompt already carries — the opposite of §8.6's "do not
 * re-derive". `carried` is the previous compaction's derived output, and it joins the candidate list as an
 * ordinary member: deduplicated on (kind, text) at the newer step, ranked by recency, cut at `KEPT_MAX`.
 */
describe('F26 §8.6 / A4 — the extraction ACCUMULATES rather than re-deriving', () => {
  const aged: KeptItem = { kind: 'fact', text: 'step 1 run pytest -q was blocked: the sandbox refused /etc/hosts', step: 1, by: 'code' };

  it('a carried item whose step is long gone is still a candidate', () => {
    const without = extractKept(input());
    expect(without.map((k) => k.text)).not.toContain(aged.text);
    const with_ = extractKept(input({ carried: [aged] }));
    expect(with_.map((k) => k.text)).toContain(aged.text);
    // ...and it ranks by its own (oldest) step, so it is among the first things the cap eats: every item
    // derived from a later step precedes it, and only the step-0 open problems trail it
    const at = with_.findIndex((k) => k.text === aged.text);
    expect(with_.slice(0, at).every((k) => k.step >= aged.step)).toBe(true);
    expect(with_.slice(at + 1).every((k) => k.step <= aged.step)).toBe(true);
  });

  it('a carried item the current compaction re-derives REFRESHES to the newer step, never duplicates', () => {
    const stale: KeptItem = { kind: 'file', text: 'src/a.ts', step: 2, by: 'code' };
    const kept = extractKept(input({ carried: [stale] }));
    const files = kept.filter((k) => k.kind === 'file' && k.text === 'src/a.ts');
    expect(files).toEqual([{ kind: 'file', text: 'src/a.ts', step: 6, by: 'code' }]);
  });

  it('accumulation is bounded by KEPT_MAX, and the human items still lead unranked', () => {
    const human: KeptItem = { kind: 'fact', text: 'the acceptance criterion is the ladder suite', step: 0, by: 'human' };
    const carried: KeptItem[] = Array.from({ length: 100 }, (_, i) => ({ kind: 'fact', text: `an aged fact ${i}`, step: 1, by: 'code' }));
    const kept = extractKept(input({ human: [human], carried }));
    expect(kept).toHaveLength(KEPT_MAX);
    expect(kept[0]).toEqual(human);
    expect(kept.filter((k) => k.by === 'human')).toEqual([human]);
    // the keys stay content-derived, so the ranking request is still comparable across compactions
    const taken = new Set<string>();
    for (const k of kept) {
      const key = keptKey(k, taken);
      expect(key).toMatch(/^(?:fact|file)_[0-9a-f]{6,}$/);
      taken.add(key);
    }
  });
});
