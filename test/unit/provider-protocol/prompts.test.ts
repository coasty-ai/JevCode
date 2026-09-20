import { describe, expect, it } from 'vitest';
import type { Plan, WindowEntry } from '../../../src/core/types.js';
import { PROMPT_LIMITS, buildRetryMessage, buildSystemPrompt, buildUserMessage, type PromptInput } from '../../../src/provider/prompts.js';

const plan: Plan = {
  done: [{ text: 'read the code', evidence: { step: 1, judged: 0.91 } }],
  remaining: ['fix f', 'run tests'],
  unverified: [{ text: 'fix f', step: 2, judged: 0.55 }],
  openProblems: ['test may be flaky'],
  harnessProblems: [{ kind: 'rejected_claim', text: "'fix f' was not accepted as done: done_0 = 0.21", step: 2 }],
};

function entry(step: number, output: string): WindowEntry {
  return { step, intent: 'verify', action: 'run pytest -q', outcome: 'executed', output, shownFiles: ['src/a.py'], notes: ['note'], judge: { succeeded: 0.2, errorPresent: 0.9, newInfo: 0.1, tests: { source: 'parsed', allPassed: false, passed: 1, failed: 1, errors: 0 }, doneClaims: [] } };
}

function input(over: Partial<PromptInput> = {}): PromptInput {
  return {
    mode: 'jev-on',
    step: 3,
    task: 'Fix f',
    plan,
    intent: { intent: 'edit', answer: 'edit', probability: 0.82, pairedNoul: 0.9, verdict: 'chosen' },
    hints: { planStale: { probability: 0.2 }, intentMismatch: { intent: 'verify', probability: 0.1, step: 2 }, claimsDropped: 2 },
    directive: { move: 'gather_context', probability: 0.7, confidence: 0.6, taskImpossible: 0.1, text: 'read the tests first' },
    loopNotice: null,
    window: [entry(1, 'a'.repeat(5000)), entry(2, 'b')],
    workspace: { changedFiles: ['src/a.py'], resumed: true, testCommand: 'pytest -q', git: true },
    contextFiles: [{ path: 'src/a.py', content: 'def f(): pass\n', bytes: 14, truncatedBytes: 0 }],
    candidates: null,
    toolName: 'propose_action',
    ...over,
  };
}

describe('buildUserMessage', () => {
  it('contains every labelled section in order and the harness-owned markers', () => {
    const m = buildUserMessage(input());
    const order = ['## Task', '## Plan (accepted by the harness)', 'unverified (claimed done', 'harnessProblems (owned by the harness', '## Intent for this step (from Jev)', '## Notes from the harness', '## Workspace', 'resumed run: these files differ from the last commit', '## Context files (selected by Jev', '## Recent steps (last 4', '## Your reply'];
    let last = -1;
    for (const s of order) {
      const i = m.indexOf(s);
      expect(i, s).toBeGreaterThan(last);
      last = i;
    }
    expect(m).toContain('Intent: `edit` (Choice p=0.82, paired judgement can_edit=0.90)');
    expect(m).toContain('Jev judged the plan stale (plan_still_valid=0.20)');
    expect(m).toContain('did not carry out intent `verify` (p=0.10)');
    expect(m).toContain('2 done claim(s) beyond the 8 judged');
    expect(m).toContain('Replan directive from Jev (move `gather_context`');
    expect(m).toContain("'fix f' was not accepted as done");
    expect(m).toContain('succeeded=0.20 | error_present=0.90');
    expect(m).toContain('tests=1 passed, 1 failed, 0 errors');
    expect(m).toContain('Call `propose_action` once');
  });
  it('bounds window output to head 400 + tail 200 and stays within the total bound', () => {
    const m = buildUserMessage(input());
    expect(m).toContain('chars omitted');
    expect(m.length).toBeLessThan(10_000);
    const big = input({ contextFiles: Array.from({ length: 12 }, (_, i) => ({ path: `f${i}.py`, content: 'x'.repeat(16_384), bytes: 16_384, truncatedBytes: 0 })), task: 't'.repeat(50_000), window: Array.from({ length: 10 }, (_, i) => entry(i + 1, 'o'.repeat(10_000))) });
    const bm = buildUserMessage(big);
    expect(bm.length).toBeLessThanOrEqual(PROMPT_LIMITS.maxUserMessageChars);
    // only the last 4 window entries and at most 60 KB of context
    expect(bm).not.toContain('### step 1:');
    expect(bm).toContain('### step 10:');
    expect((bm.match(/### f\d+\.py/g) ?? []).length).toBeLessThanOrEqual(4);
  });
  it('jev-off omits the Jev sections and lists candidates with bytes', () => {
    const m = buildUserMessage(input({ mode: 'jev-off', intent: null, directive: null, hints: {}, loopNotice: 'You have repeated the same edit 3 times.', candidates: [{ path: 'src/a.py', bytes: 12 }, { path: 'b.py', bytes: 3 }] }));
    expect(m).not.toContain('## Intent for this step');
    expect(m).not.toContain('## Context files');
    expect(m).toContain('## Workspace files (path, bytes)');
    expect(m).toContain('src/a.py 12');
    expect(m).toContain('You have repeated the same edit 3 times.');
  });
  it('fallback and finish wording', () => {
    expect(buildUserMessage(input({ intent: { intent: 'investigate', answer: 'none_of_these', probability: 0.4, pairedNoul: 0.2, verdict: 'fallback' } }))).toContain('Jev found no fitting intent (p=0.40, chose `none_of_these`); investigate before changing anything');
    expect(buildUserMessage(input({ intent: { intent: 'finish', answer: 'finish', probability: 0.9, pairedNoul: 0.9, verdict: 'chosen' } }))).toContain('Jev judges nothing remains. Propose `done`');
  });
});

describe('system prompt and retry message', () => {
  it('describes the tool, the fenced fallback, the edit rules and the sandbox', () => {
    const s = buildSystemPrompt({ mode: 'jev-on', sandboxLevel: 'seatbelt', toolName: 'propose_action' });
    expect(s).toContain('`propose_action` exactly once');
    expect(s).toContain('```json');
    expect(s).toContain('match exactly once');
    expect(s).toContain('seatbelt');
    expect(s).toContain('Jev');
    const off = buildSystemPrompt({ mode: 'jev-off', sandboxLevel: 'none', toolName: 'propose_action' });
    expect(off).toContain('there is no reviewer');
    expect(off).toContain('output cap');
  });
  it('retry message carries the reason and the raw tail', () => {
    const r = buildRetryMessage('action.kind: expected one of ...', 'tail text', 'propose_action');
    expect(r).toContain('action.kind: expected one of');
    expect(r).toContain('tail text');
    expect(r).toContain('propose_action');
  });
});
