/**
 * contract 1.9 (Fastlane) §3.3 — the byte-stable prompt prefix
 * (docs/LLM-LOOP-DESIGN.md §3.3, HARNESS-NEXT-DESIGN.md §6 S2: "prefix order
 * `system → repo map → files → window` so the `jev-on`/`jev-off` prefix is byte-stable BETWEEN steps").
 *
 * The problem, in one line of the legacy message: it opens `# Step 3`. A provider's prompt cache is a
 * PREFIX cache — it matches from the first token — so a step number in byte 7 makes every step of a run
 * a complete cache miss on a message whose repo map and file bodies are usually identical to the last
 * step's. S2 prices that at "prompt input cost −≈ 80 %".
 *
 * The constraint §3.3 puts on the fix is the one asserted first here: **`view: 'legacy'` bytes may not
 * move**. The reorder is therefore an opt-in (`PromptInput.prefixOrder: 'pinned'`), the committed legacy
 * golden (`prompts-context.test.ts`, `test/fixtures/provider/legacy-jev-{on,off}.txt`) is untouched and
 * was NOT re-captured, and this file proves both halves: the default is byte-identical to before, and the
 * pinned order really does repeat between two steps that differ everywhere else.
 */
import { describe, expect, it } from 'vitest';

import type { Plan } from '../../../src/core/types.js';
import { buildWindowEntry } from '../../../src/loop/window.js';
import { contextBudgetChars } from '../../../src/loop/context/limits.js';
import { buildPrompt, buildUserMessage, type PromptContextView, type PromptInput } from '../../../src/provider/prompts.js';

const plan: Plan = { done: [], remaining: ['fix f'], unverified: [], openProblems: [], harnessProblems: [] };

function input(over: Partial<PromptInput> = {}): PromptInput {
  return {
    mode: 'jev-on',
    step: 3,
    task: 'Fix f() in src/a.ts so that tests/test_a.ts passes',
    plan,
    intent: null,
    hints: {},
    directive: null,
    loopNotice: null,
    window: [],
    workspace: { changedFiles: ['src/a.ts'], resumed: false, testCommand: 'pytest -q', git: true },
    contextFiles: [{ path: 'src/a.ts', content: 'export const f = () => 1;\n', bytes: 26, truncatedBytes: 0 }],
    candidates: null,
    toolName: 'propose_action',
    ...over,
  };
}

/**
 * Two steps of one run: the same task, repo map and files; a different step number, plan, window — and a
 * different set of CHANGED FILES, which is what a real step 9 has. `workspaceSection` grows that line at every
 * edit, so a head that contains it is not a head at all (review defect 4): the fixture must differ there or the
 * byte-identity assertion below is vacuous.
 */
function stepTwo(over: Partial<PromptInput> = {}): PromptInput {
  return input({
    step: 9,
    plan: { done: [], remaining: ['fix f', 'run the suite'], unverified: [], openProblems: ['the fixture is stale'], harnessProblems: [] },
    window: [buildWindowEntry({ step: 8, intent: 'edit', action: 'edit src/a.ts', outcome: { status: 'executed', summary: 'ok', changedFiles: ['src/a.ts'] }, output: 'ran 3 tests', judge: null, completion: null, shownFiles: [], notes: [], error: null })],
    workspace: { changedFiles: ['src/a.ts', 'src/b.ts', 'tests/test_a.py'], resumed: false, testCommand: 'pytest -q', git: true },
    ...over,
  });
}

const context = (over: Partial<PromptContextView> = {}): PromptContextView => ({ files: [], history: [], summary: null, summaryAt: null, budgetChars: contextBudgetChars(), ...over });

describe('§3.3 the default is today’s message, byte for byte', () => {
  it('`prefixOrder` absent === `legacy`, opens with `# Step N`, and reports no cacheable head', () => {
    const legacy = buildPrompt(input());
    expect(legacy.text).toBe(buildUserMessage(input({ prefixOrder: 'legacy' })));
    expect(legacy.text.startsWith('# Step 3\n\n## Task\n')).toBe(true);
    // there is no head to cache under the legacy order — the first bytes change at every step
    expect(legacy.prefixChars).toBeUndefined();

    const relaxed = buildPrompt(input({ context: context() }));
    expect(relaxed.text).toBe(buildUserMessage(input({ context: context(), prefixOrder: 'legacy' })));
    expect(relaxed.text.startsWith('# Step 3\n\n## Task\n')).toBe(true);
    expect(relaxed.prefixChars).toBeUndefined();
  });
});

describe('§3.3 `prefixOrder: pinned` — a head that repeats between steps', () => {
  it('orders task → repo map → files before anything that changes per step, and the window last', () => {
    const text = buildUserMessage(input({ prefixOrder: 'pinned' }));
    expect(text.startsWith('## Task\n')).toBe(true);
    const at = (s: string): number => {
      const i = text.indexOf(s);
      expect(i, `${s} is in the pinned message`).toBeGreaterThanOrEqual(0);
      return i;
    };
    // §3.3's order, read off the message itself
    expect(at('## Task')).toBeLessThan(at('## Workspace'));
    expect(at('## Workspace')).toBeLessThan(at('## Context'));
    // the step heading rides the plan section, which is the first thing after the head that changes every step
    expect(at('## Context')).toBeLessThan(at('# Step 3'));
    expect(text).toContain('# Step 3\n\n## Plan');
    expect(at('## Plan')).toBeLessThan(at('## Recent steps'));
    expect(at('## Recent steps')).toBeLessThan(at('## Your reply'));
    // review defect 4: the repo map that pins is the part that does NOT move — the changed-file list grows at
    // every edit of the run, so it sits behind the step heading and outside the head
    expect(text).toContain('## Workspace\ngit repository: yes\ndetected test command: `pytest -q`\n\n');
    expect(at('# Step 3')).toBeLessThan(at('files changed by this run'));
    expect(at('## Workspace (changed by this run)')).toBeLessThan(at('## Recent steps'));
  });

  it('adds, removes and rewrites nothing but the one heading the workspace split needs', () => {
    const pinnedBuild = buildPrompt(input({ prefixOrder: 'pinned' }));
    const legacyBuild = buildPrompt(input());
    // the same section NAMES — the step heading rides the plan instead of the task, and `## Workspace (changed by
    // this run)` measures under `Workspace` like the lines it took, so `/context` reports the same buckets
    expect(Object.keys(pinnedBuild.sections).sort()).toEqual(Object.keys(legacyBuild.sections).sort());
    // and every LINE of the legacy message survives verbatim: the only text the reorder adds is that heading
    const lines = (t: string): string[] => t.split('\n').filter((l) => l.length > 0).sort();
    expect(lines(pinnedBuild.text)).toEqual(lines(`${legacyBuild.text}\n## Workspace (changed by this run)`));
    const total = (m: Record<string, number>): number => Object.values(m).reduce((a, b) => a + b, 0);
    expect(total(pinnedBuild.sections)).toBe(total(legacyBuild.sections) + '## Workspace (changed by this run)'.length);
    for (const section of ['## Task\n', '## Workspace', '## Plan', '## Your reply']) expect(pinnedBuild.text).toContain(section);
  });

  it('two steps of one run share a byte-identical head, and `prefixChars` names exactly how long it is', () => {
    const a = buildPrompt(input({ prefixOrder: 'pinned' }));
    const b = buildPrompt(stepTwo({ prefixOrder: 'pinned' }));
    expect(a.prefixChars).toBeGreaterThan(0);
    expect(b.prefixChars).toBe(a.prefixChars);
    expect(b.text.slice(0, b.prefixChars)).toBe(a.text.slice(0, a.prefixChars));
    // and the head really is the whole of what repeats: the next char already differs (`# Step 3` vs `# Step 9`)
    expect(b.text.slice(b.prefixChars!)).not.toBe(a.text.slice(a.prefixChars!));
    // under the legacy order the two messages diverge at byte 7 — which is the cache miss §3.3 exists to remove
    const legacyA = buildUserMessage(input());
    const legacyB = buildUserMessage(stepTwo());
    let shared = 0;
    while (shared < legacyA.length && legacyA[shared] === legacyB[shared]) shared += 1;
    expect(shared).toBeLessThan(10);
    expect(a.prefixChars!).toBeGreaterThan(shared * 5);
  });

  it('holds on the relaxed path too, where the head is the two sections the budget never shrinks', () => {
    const a = buildPrompt(input({ prefixOrder: 'pinned', context: context() }));
    const b = buildPrompt(stepTwo({ prefixOrder: 'pinned', context: context() }));
    expect(a.prefixChars).toBeGreaterThan(0);
    expect(b.text.slice(0, b.prefixChars)).toBe(a.text.slice(0, a.prefixChars));
    expect(a.text.startsWith('## Task\n')).toBe(true);
    // the budgeted sections still fill in the §8.2 order behind the head, and nothing was dropped by the reorder
    expect(Object.keys(buildPrompt(input({ prefixOrder: 'pinned', context: context() })).sections).sort()).toEqual(Object.keys(buildPrompt(input({ context: context() })).sections).sort());
  });
});
