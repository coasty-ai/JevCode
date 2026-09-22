/**
 * The context policy inside the engine (docs/COORDINATION-DESIGN.md §8, §12.0.3): the generator's view over a long run,
 * whole outputs on disk, the zero-cost read, deterministic compaction with its event, the meter on `status()`, Jev's state
 * unchanged (§8.1 two windows) and the additive checkpoint fields.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineStatus } from '../../../src/core/types.js';
import { hasContextStore } from '../../../src/checkpoint/types.js';
import { CHARS_PER_TOKEN, COMPACT_AT_PCT, HISTORY_STEPS, contextBudgetChars } from '../../../src/loop/context/limits.js';
import { compactCode } from '../../../src/loop/context/compaction.js';
import type { ContextUsage, HistoryEntry, Synthesizer } from '../../../src/core/types.js';
import { createFakeSandbox, createFakeWorkspace, execResult, makeEngine, turn, type Harness } from './fakes.js';

const harnesses: Harness[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** `EngineStatus.context` — the §12.0.3 member, now on the core contract (contract 1.4); absent only in the modes that build no view. */
function usage(status: EngineStatus): ContextUsage {
  expect(status.context).toBeDefined();
  return status.context!;
}

/**
 * contract 1.4 (§8.8 column 3): an llm-jev synthesizer that proposes one `run` per step and records the
 * `SynthesisContext.contextText` it was handed, so a test can read the relaxed view from the consumer's side.
 */
function synthRunning(seen: (string | undefined)[]): Synthesizer {
  let i = 0;
  return {
    name: 'ctx-probe',
    mode: 'llm-jev',
    async synthesize(ctx) {
      seen.push(ctx.contextText);
      return { goal: 'keep going', action: { kind: 'run', command: `echo ${'abcdefghijklmnopqrst'[i++ % 20]}` }, plan: { done: [], remaining: ['keep going'], openProblems: [] }, rawText: '' };
    },
  };
}

/** `steps` run steps whose output is `chars` long (letters, not digits: signature normalisation strips digits). */
async function runSteps(steps: number, chars: number, contextPolicy?: { view?: 'relaxed' | 'legacy'; compactEvery?: number; fileCacheBytes?: number }): Promise<Harness> {
  let i = 0;
  const h = await makeEngine({
    turns: () => turn({ kind: 'run', command: `echo ${'abcdefghijklmnopqrst'[i++ % 20]}` }, { remaining: ['keep going'] }),
    sandbox: createFakeSandbox((c) => execResult({ stdout: `${c}\n${'x'.repeat(Math.max(0, chars - c.length - 2))}\n` })),
    limits: { maxSteps: steps },
    ...(contextPolicy === undefined ? {} : { engine: { contextPolicy } }),
  });
  harnesses.push(h);
  return h;
}

describe('§8.3 the generator sees 12 recent steps, whole outputs and no silent clip', () => {
  it('keeps 12 entries with the two newest whole, writes every long output to outputs/ and points at it', async () => {
    const h = await runSteps(14, 5_000, { compactEvery: 0 });
    const r = await h.engine.run();
    expect(r.steps).toBe(14);
    const state = h.store.last()!;
    const history = (state as typeof state & { history?: { step: number; outputRef?: string; fullOutputChars?: number }[] }).history!;
    expect(history).toHaveLength(HISTORY_STEPS);
    expect(history.map((e) => e.step)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    // state.json stays small: the bodies are the window's, the long text is a file
    expect(JSON.stringify(history).length).toBeLessThan(HISTORY_STEPS * 1_500);
    expect(history.every((e) => e.outputRef === `outputs/step-${e.step}.txt` && e.fullOutputChars === 5_000)).toBe(true);
    expect([...h.store.outputs.keys()]).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    expect(h.store.outputs.get(14)).toHaveLength(5_000);
    // the last prompt shows 12 steps, the newest two whole, and names the file for every clip
    const last = h.provider.requests.at(-1)!.messages[0]!.content;
    expect(last).toContain('## Recent steps (last 12, oldest first)');
    expect(last).toContain(h.store.outputs.get(13)!);
    expect((last.match(/full text: read jevcode:outputs\/step-\d+\.txt/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(last.length).toBeLessThanOrEqual(contextBudgetChars());
  });

  it('review blocker (7): a 3 KiB step output reaches the next prompt whole, from disk and from the window body', async () => {
    const h = await runSteps(3, 3 * 1024, { compactEvery: 0 });
    await h.engine.run();
    // the whole text is on disk for every step, not only past 12 KiB
    expect([...h.store.outputs.keys()]).toEqual([1, 2, 3]);
    expect(h.store.outputs.get(2)).toHaveLength(3 * 1024);
    // the state body stays at the window bound — state.json does not grow with the output
    const history = (h.store.last()! as { history?: { step: number; output?: string; fullOutputChars?: number }[] }).history!;
    expect(history.every((e) => (e.output ?? '').length <= 664 && e.fullOutputChars === 3 * 1024)).toBe(true);
    // and the generator saw the two newest whole, with no omission marker
    const last = h.provider.requests.at(-1)!.messages[0]!.content;
    expect(last).toContain(h.store.outputs.get(2)!);
    expect(last).toContain(h.store.outputs.get(1)!);
    const recent = last.slice(last.indexOf('## Recent steps'));
    expect(recent).not.toContain('chars omitted');
  });

  it('a `read` of jevcode:outputs/step-<n>.txt serves the stored bytes, and an unknown one says so', async () => {
    const stored = `FAILED tests/test_a.py::test_f\n${'y'.repeat(40_000)}`;
    const h = await makeEngine({
      mode: 'jev-off',
      turns: [
        turn({ kind: 'run', command: 'pytest -q' }, { remaining: ['read the tail'] }),
        turn({ kind: 'read', paths: ['jevcode:outputs/step-1.txt', 'jevcode:outputs/step-9.txt'] }, { remaining: ['fix'] }),
        turn({ kind: 'done', summary: 'read it' }, { remaining: [] }),
      ],
      sandbox: createFakeSandbox(() => execResult({ stdout: `${stored}\n` })),
      limits: { maxSteps: 3 },
    });
    harnesses.push(h);
    await h.engine.run();
    // the step-2 output IS the stored text (32 KiB of it: head + tail past the per-file read cap), not a pointer
    const step2 = h.store.outputs.get(2) ?? '';
    expect(step2).toMatch(/### jevcode:outputs\/step-1\.txt \(\d{5} chars, head and tail shown; the whole \d{5} chars stay at jevcode:outputs\/step-1\.txt\)/);
    expect(step2).toContain('FAILED tests/test_a.py::test_f');
    expect(step2).toContain('y'.repeat(2_000));
    expect(step2.length).toBeGreaterThan(30_000);
    // the unknown ref says so, in the same output
    expect(step2).toContain('### jevcode:outputs/step-9.txt — no stored output under this name');
    // and neither path ever reached the workspace
    expect(h.workspace.reads).not.toContain('jevcode:outputs/step-1.txt');
    expect(h.workspace.reads).not.toContain('jevcode:outputs/step-9.txt');
  });

  it('review D4: `jevcode:` reads obey the 128 KB per-step read budget like any other read', async () => {
    const paths = Array.from({ length: 14 }, (_, i) => `jevcode:outputs/step-${i + 1}.txt`);
    const h = await makeEngine({
      mode: 'jev-off',
      turns: [...Array.from({ length: 14 }, (_, i) => turn({ kind: 'run', command: `echo ${'abcdefghijklmn'[i]}` }, { remaining: ['keep going'] })), turn({ kind: 'read', paths }, { remaining: ['done'] })],
      sandbox: createFakeSandbox((c) => execResult({ stdout: `${c}\n${'z'.repeat(40_000)}\n` })),
      limits: { maxSteps: 15 },
    });
    harnesses.push(h);
    await h.engine.run();
    const out = h.store.outputs.get(15) ?? '';
    // 14 × 40 KB would be 560 KB; the budget holds it near 128 KB and names what it did not show
    expect(out.length).toBeLessThan(140 * 1024);
    expect(out).toContain('the 128 KB read budget for this step is spent; read it alone on the next step');
  });
});

describe('§8.4 review D1/D2: the zero-cost read never hides a file', () => {
  it('a file bigger than the view walks its windows instead of answering "unchanged" three times', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcode-ctx-'));
    dirs.push(dir);
    const body = `${'A'.repeat(20_000)}\n${'B'.repeat(20_000)}\n`;
    writeFileSync(join(dir, 'big.py'), body);
    const h = await makeEngine({
      mode: 'jev-off',
      runsDir: dir,
      workspace: createFakeWorkspace({ root: dir, files: { 'big.py': body } }),
      turns: [
        turn({ kind: 'read', paths: ['big.py'] }, { remaining: ['read the rest'] }),
        turn({ kind: 'read', paths: ['big.py'] }, { remaining: ['read the rest'] }),
        turn({ kind: 'read', paths: ['big.py'] }, { remaining: ['done'] }),
      ],
      limits: { maxSteps: 3 },
    });
    harnesses.push(h);
    await h.engine.run();
    const outputs = [1, 2, 3].map((n) => h.store.outputs.get(n) ?? (h.store.steps[n - 1]?.outcome?.status === 'executed' ? '' : ''));
    const prompts = h.provider.requests.map((q) => q.messages[0]!.content);
    // the file does not fit in one 32 KiB view, so the prompt shows a window and says so
    expect(prompts[1]).toContain('read big.py for the next window');
    // and the follow-up reads are NOT refused with "unchanged" — each serves new bytes
    for (const p of prompts.slice(1)) expect(p).not.toContain('the whole file is under Files in view');
    const secondRead = outputs[1] ?? '';
    expect(secondRead).toContain('BBBB');
    expect(secondRead).toMatch(/lines \d+–\d+|bytes \d+–\d+/);
  });

  it('a file the files budget omitted is re-read, not answered from a view the prompt did not show', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcode-ctx-'));
    dirs.push(dir);
    for (const [name, size] of [['a.py', 30_000], ['b.py', 30_000], ['c.py', 30_000]] as const) writeFileSync(join(dir, name), 'x'.repeat(size));
    const files = { 'a.py': 'x'.repeat(30_000), 'b.py': 'x'.repeat(30_000), 'c.py': 'x'.repeat(30_000) };
    const h = await makeEngine({
      mode: 'jev-off',
      runsDir: dir,
      workspace: createFakeWorkspace({ root: dir, files }),
      engine: { contextPolicy: { fileCacheBytes: 40_000 } },
      turns: [
        turn({ kind: 'read', paths: ['a.py'] }, { remaining: ['b'] }),
        turn({ kind: 'read', paths: ['b.py'] }, { remaining: ['c'] }),
        turn({ kind: 'read', paths: ['a.py'] }, { remaining: ['done'] }),
      ],
      limits: { maxSteps: 3 },
    });
    harnesses.push(h);
    await h.engine.run();
    const prompt3 = h.provider.requests[2]!.messages[0]!.content;
    // one of the two files is past the 40 KB view budget and is listed by name
    expect(prompt3).toContain('— not shown (files budget); `read` it if you need it');
    // the third step re-read a.py for real rather than being told it is already in view
    expect(h.workspace.reads.filter((p) => p === 'a.py').length).toBeGreaterThanOrEqual(2);
  });
});

describe('§8.4 files in view', () => {
  it('every path read or edited stays in view, with fileMemory and the pin recorded', async () => {
    const h = await makeEngine({
      mode: 'jev-off',
      turns: [
        turn({ kind: 'read', paths: ['src/a.py'] }, { remaining: ['edit'] }),
        turn({ kind: 'write', path: 'src/new.py', content: 'VALUE = 1\n' }, { remaining: ['done'] }),
      ],
      limits: { maxSteps: 2 },
    });
    harnesses.push(h);
    await h.engine.run();
    const state = h.store.last()! as { fileCache?: { rel: string; pinnedBy: string; lastUsedStep: number }[]; fileMemory?: Record<string, { readAt: number | null; editedAt: number | null }> };
    expect(state.fileCache?.map((e) => [e.rel, e.pinnedBy])).toEqual([['src/a.py', 'read'], ['src/new.py', 'edit']]);
    expect(state.fileMemory?.['src/a.py']).toMatchObject({ readAt: 1 });
    expect(state.fileMemory?.['src/new.py']).toMatchObject({ editedAt: 2 });
    // the second prompt carries the file the first step read, with the reason it is in view
    const second = h.provider.requests[1]!.messages[0]!.content;
    expect(second).toContain('## Files in view');
    expect(second).toContain('### src/a.py');
    expect(second).toContain('you read it at step 1');
  });

  it('a read of an unchanged file already in view costs no workspace read (one stat only)', async () => {
    // the fake workspace is backed by a real directory, so the production stat path is the one under test
    const dir = mkdtempSync(join(tmpdir(), 'jevcode-ctx-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'a.py'), 'def f():\n    return 1\n');
    const h = await makeEngine({
      mode: 'jev-off',
      runsDir: dir,
      workspace: createFakeWorkspace({ root: dir, files: { 'a.py': 'def f():\n    return 1\n' } }),
      turns: [
        turn({ kind: 'read', paths: ['a.py'] }, { remaining: ['read it again'] }),
        turn({ kind: 'read', paths: ['a.py'] }, { remaining: ['done'] }),
        turn({ kind: 'read', paths: ['a.py'] }, { remaining: ['done'] }),
      ],
      limits: { maxSteps: 3 },
    });
    harnesses.push(h);
    await h.engine.run();
    // step 1 reads it; the prompt of step 2 refreshes it once; step 2's and step 3's reads are free
    // step 1 read it for real; steps 2 and 3 read it for free (the output line points at Files in view)
    const prompt2 = h.provider.requests[1]!.messages[0]!.content;
    const prompt3 = h.provider.requests[2]!.messages[0]!.content;
    expect(prompt2).not.toContain('unchanged since step');
    expect(prompt3).toContain('unchanged since step 1 (sha ');
    expect(prompt3).toContain('the whole file is under Files in view');
    // the workspace was asked for the file twice in total: step 1's read and the first prompt's refresh
    expect(h.workspace.reads.filter((p) => p === 'a.py')).toHaveLength(2);
  });
});

describe('§8.6 / §12.0.3 compaction and the meter', () => {
  it('contract 1.4 `Engine.compact()` (`/compact now`): folds at once outside the triggers; a no-op under the legacy pin', async () => {
    const h = await runSteps(9, 5_000, { compactEvery: 0 });
    h.engine.events.on('step:end', (e) => {
      if (e.record.step === 8) h.engine.compact!();
    });
    await h.engine.run();
    const notices = h.events.filter((e) => e.type === 'notice' && 'text' in e && e.text.startsWith('compaction:'));
    expect(notices).toHaveLength(1);
    expect((notices[0] as { text: string }).text).toMatch(/ \(requested\)$/);
    // contract 1.4: the typed event rides the union now, beside the one human-readable notice line
    const events = h.events.filter((e) => e.type === 'context:compacted');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'context:compacted', step: 8, by: 'code' });
    const state = h.store.last()!;
    expect(state.summaryAt).toBe(8);
    expect(state.compactions).toBe(1);

    // `view: 'legacy'` builds no context at all, so the verb does nothing (and never throws)
    const h2 = await runSteps(9, 5_000, { view: 'legacy', compactEvery: 0 });
    h2.engine.events.on('step:end', () => h2.engine.compact!());
    await h2.engine.run();
    expect(h2.events.filter((e) => e.type === 'context:compacted')).toEqual([]);
    expect(h2.store.last()!.compactions).toBeUndefined();
  });

  it('compacts on the 8th step, folds the history, writes the summary and announces context:compacted', async () => {
    const h = await runSteps(9, 5_000);
    await h.engine.run();
    const notices = h.events.filter((e) => e.type === 'notice' && 'text' in e && e.text.startsWith('compaction:'));
    expect(notices).toHaveLength(1);
    const notice = notices[0]!;
    // review finding 29: one shared line, the `[ui]` notice item — never a chat bubble
    expect(notice).toMatchObject({ type: 'notice', kind: 'ui', level: 'info', label: '[ui]', step: 8 });
    const detail = JSON.parse((notice as { detail?: string }).detail ?? '{}') as { type: string; step: number; chars: { before: number; after: number }; by: string };
    expect(detail.type).toBe('context:compacted');
    expect(detail.step).toBe(8);
    expect(detail.by).toBe('code');
    expect(detail.chars.after).toBeLessThan(detail.chars.before);
    // review D15: before/after are PROMPT chars — the size of the message the generator sees, not of the persisted JSON
    const promptBefore = (h.provider.requests[7]!.system ?? '').length + h.provider.requests[7]!.messages[0]!.content.length;
    expect(detail.chars.before).toBe(promptBefore);
    const promptAfter = (h.provider.requests[8]!.system ?? '').length + h.provider.requests[8]!.messages[0]!.content.length;
    // the estimate tracks the next real build within the summary's own size
    expect(Math.abs(detail.chars.after - promptAfter)).toBeLessThan(6_000);
    expect((notice as { text: string }).text).toMatch(/^compaction: \d+ → \d+ prompt chars \(code\); 6 steps folded into the summary at step 8 \(every 8 steps\)$/);
    // the summary is on disk and in the next prompt; the folded entries are one-liners with their pointers
    expect(hasContextStore(h.store)).toBe(true);
    expect(h.store.summary).not.toBeNull();
    const state = h.store.last()! as { summaryAt?: number; compactions?: number; lastCompactionAt?: string };
    expect(state.summaryAt).toBe(8);
    expect(state.compactions).toBe(1);
    expect(state.lastCompactionAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const after = h.provider.requests[8]!.messages[0]!.content;
    expect(after).toContain('## Summary (rolling; compacted at step 8)');
    expect(after).toContain('Objective:');
    expect(after).toContain('full text: read jevcode:outputs/step-1.txt');
  });

  it('status() carries ContextUsage: derived from the state before the first prompt, then chars / 3.4 per build', async () => {
    const h = await runSteps(9, 5_000);
    const before = usage(h.engine.status());
    expect(before).toMatchObject({ promptChars: 0, pct: 0, tokensInWindow: 0, files: 0, historyEntries: 0, compactions: 0, lastCompactionAt: null, compaction: 'code' });
    // review finding 51: the meter is a share of the prompt budget; the model's window is reported beside it
    expect(before.budgetTokens).toBe(Math.round(contextBudgetChars() / 3.4));
    expect(before.windowTokens).toBe(128_000);
    await h.engine.run();
    const after = usage(h.engine.status());
    // review D15: the meter counts the WHOLE prompt — the system prompt goes to the model on every call too
    const lastUser = h.provider.requests.at(-1)!.messages[0]!.content;
    const system = h.provider.requests.at(-1)!.system ?? '';
    expect(system.length).toBeGreaterThan(0);
    expect(after.promptChars).toBe(system.length + lastUser.length);
    // review D14: the build cost is measured and exposed, not discarded
    expect(after.promptBuildMs).toBeGreaterThanOrEqual(0);
    expect(after.refreshMs).toBeGreaterThanOrEqual(0);
    expect(after.recentSteps.whole).toBeGreaterThan(0);
    expect(after.recentSteps.allowanceChars).toBeGreaterThan(0);
    expect(after.tokensInWindow).toBe(Math.round(after.promptChars / 3.4));
    expect(after.pct).toBe(Math.round((100 * after.tokensInWindow) / after.budgetTokens));
    // §12.0.3 cadence: the object is the one computed at the last prompt build, before that step committed
    expect(after.historyEntries).toBe(8);
    expect(after.compactions).toBe(1);
    expect(after.lastCompactionStep).toBe(8);
    expect(after.summaryAt).toBe(8);
    // every status event carries the same object
    const statuses = h.events.filter((e) => e.type === 'status');
    expect(statuses.length).toBeGreaterThan(0);
    const last = usage((statuses.at(-1) as { status: EngineStatus }).status);
    expect(last).toEqual(after);
  });

  it('compaction is deterministic given (state, budget): the fold does not depend on map order, locale or the clock', async () => {
    const a = await runSteps(9, 5_000);
    await a.engine.run();
    const b = await runSteps(9, 5_000);
    await b.engine.run();
    const fold = (h: Harness): string => JSON.stringify(h.store.summary, (k, v) => (k === 'at' ? '<t>' : v));
    expect(fold(b)).toBe(fold(a));
    // the same state reached by a different insertion order, a different clock and a different locale folds identically
    const state = { step: 8, at: '2026-09-22T00:00:00.000Z', task: 'Fix f()', plan: a.store.last()!.plan, history: (a.store.last()! as { history?: HistoryEntry[] }).history!, lastTestRun: a.store.last()!.lastTestRun, previous: null };
    const memory = (a.store.last()! as { fileMemory?: Record<string, unknown> }).fileMemory ?? {};
    const forward: Record<string, unknown> = {};
    for (const k of Object.keys(memory).sort()) forward[k] = memory[k];
    const backward: Record<string, unknown> = {};
    for (const k of Object.keys(memory).sort().reverse()) backward[k] = memory[k];
    const one = compactCode({ ...state, fileMemory: forward as never });
    const two = compactCode({ ...state, fileMemory: backward as never, at: '2031-05-05T05:05:05.000Z' });
    expect(two.summary.text).toBe(one.summary.text);
    expect(two.summary.sections).toEqual(one.summary.sections);
    expect(two.dropped).toEqual(one.dropped);
    const strip = (s: unknown): string => JSON.stringify(s, (k, v) => (k === 'at' || k === 'lastCompactionAt' || k === 'updatedAt' || k === 'startedAt' ? '<t>' : v));
    expect(strip((b.store.last()! as { history?: unknown }).history)).toBe(strip((a.store.last()! as { history?: unknown }).history));
  });

  it('compaction: "off" disables the fold, and the meter says so', async () => {
    const h = await runSteps(9, 5_000, { compactEvery: 0 });
    await h.engine.run();
    expect(h.events.some((e) => e.type === 'notice' && 'text' in e && e.text.startsWith('compaction:'))).toBe(false);
    expect(h.store.summary).toBeNull();
    expect(usage(h.engine.status()).compactions).toBe(0);
    expect((h.store.last()! as { compactions?: number }).compactions).toBeUndefined();
  });
});

describe('§8 the rest of the bookkeeping', () => {
  it('review D22: the prompt shows the same redacted bytes in-process as it does after a resume', async () => {
    const key = 'sk-or-v1-SECRETSECRETSECRETSECRET';
    const h = await makeEngine({
      mode: 'jev-off',
      turns: [turn({ kind: 'run', command: 'printenv' }, { remaining: ['look'] }), turn({ kind: 'done', summary: 'seen' }, { remaining: [] })],
      sandbox: createFakeSandbox(() => execResult({ stdout: `TOKEN=${key}\n${'x'.repeat(2_000)}\n` })),
      limits: { maxSteps: 2 },
    });
    harnesses.push(h);
    await h.engine.run();
    const prompt = h.provider.requests[1]!.messages[0]!.content;
    expect(prompt).toContain('[REDACTED:test]');
    expect(prompt).not.toContain(key);
    // and the file on disk carries exactly what the prompt showed
    expect(h.store.outputs.get(1)).not.toContain(key);
  });

  it('review D23: a `run` that rewrites a file in view is not served from the stale bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcode-ctx-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'gen.py'), 'VALUE = 1\n');
    const ws = createFakeWorkspace({ root: dir, files: { 'gen.py': 'VALUE = 1\n' } });
    const h = await makeEngine({
      mode: 'jev-off',
      runsDir: dir,
      workspace: ws,
      turns: [
        turn({ kind: 'read', paths: ['gen.py'] }, { remaining: ['regenerate'] }),
        turn({ kind: 'run', command: 'python gen.py' }, { remaining: ['read it'] }),
        turn({ kind: 'read', paths: ['gen.py'] }, { remaining: ['done'] }),
      ],
      // the command rewrites the file the generator has in view, and reports it as changed
      sandbox: createFakeSandbox(() => {
        ws.files.set('gen.py', 'VALUE = 99\n');
        writeFileSync(join(dir, 'gen.py'), 'VALUE = 99\n');
        return execResult({ stdout: 'regenerated\n' });
      }),
      limits: { maxSteps: 3 },
    });
    harnesses.push(h);
    await h.engine.run();
    const prompt3 = h.provider.requests[2]!.messages[0]!.content;
    // the FILES IN VIEW section must carry the new bytes (the history legitimately keeps what step 1 read)
    const inView = prompt3.slice(prompt3.indexOf('## Files in view'), prompt3.indexOf('## Recent steps'));
    expect(inView).toContain('VALUE = 99');
    expect(inView).not.toContain('VALUE = 1');
  });

  it('§8.6 / review D20: a resume that folded rows past the history window compacts once, before the first prompt', async () => {
    const first = await runSteps(14, 3_000, { compactEvery: 0 });
    await first.engine.run();
    // a checkpoint that stopped at step 12 while steps 13 and 14 are in steps.jsonl
    const stale = structuredClone(first.store.last()!) as typeof first.store.states[number] & { history?: { step: number }[] };
    stale.history = (stale.history ?? []).filter((e) => e.step <= 12);
    stale.step = 12;
    first.store.states.push(stale);
    const resumed = await makeEngine({
      store: first.store,
      runsDir: first.runsDir,
      resume: { runId: first.engine.runId, force: false },
      turns: () => turn({ kind: 'done', summary: 'nothing left' }, { remaining: [] }),
      limits: { maxSteps: 16 },
    });
    harnesses.push(resumed);
    await resumed.engine.run();
    const notice = resumed.events.find((e) => e.type === 'notice' && 'text' in e && e.text.startsWith('compaction:'));
    expect(notice).toBeDefined();
    expect((notice as { text: string }).text).toContain('(resumed past the history window)');
    expect(resumed.provider.requests[0]!.messages[0]!.content).toContain('## Summary (rolling; compacted at step');
  });
});

describe('§8.1 two windows: Jev is untouched', () => {
  it('golden: every Jev request state is byte-identical to the legacy-view run (recent = 4 × 600)', async () => {
    const relaxed = await runSteps(9, 5_000);
    await relaxed.engine.run();
    const legacy = await runSteps(9, 5_000, { view: 'legacy' });
    await legacy.engine.run();
    const states = (h: Harness): string[] => h.decider.calls.map((c) => `${c.stage}#${c.step} ${JSON.stringify(c.state).replaceAll(h.runsDir, '<ws>')}`);
    expect(states(relaxed)).toEqual(states(legacy));
    expect(states(relaxed).length).toBeGreaterThan(30);
    // and the shape the golden pins: at most 4 recent entries, each body at the window bound
    for (const call of relaxed.decider.calls) {
      const recent = (call.state as { recent?: { output?: string }[] }).recent;
      if (recent === undefined) continue;
      expect(recent.length).toBeLessThanOrEqual(4);
      for (const e of recent) expect((e.output ?? '').length).toBeLessThanOrEqual(600 + 32);
    }
  });
});

describe('§8 checkpoint compatibility (additive)', () => {
  it('the additions are optional: a run that touched nothing writes none of them', async () => {
    const h = await makeEngine({ turns: [turn({ kind: 'done', summary: 'nothing to do' })], limits: { maxSteps: 1 } });
    harnesses.push(h);
    await h.engine.run();
    const state = h.store.last()!;
    for (const key of ['fileCache', 'fileMemory', 'summaryAt', 'compactions', 'lastCompactionAt']) expect(state).not.toHaveProperty(key);
    // `history` is the one addition a committed step always fills, and it is still optional in the shape
    expect((state as { history?: unknown[] }).history).toHaveLength(1);
  });

  /**
   * INVERTED for llm-jev by contract 1.4 (§8.8 column 3) / TUI-DESIGN-5 §8.2 R13: D5 deferred llm-jev only "until
   * `SynthesisContext.contextText` exists", because a view nothing read would have been dead weight with a meter
   * stuck at 0 %. It exists, the candidate source reads it, so llm-jev now pays for the view like the generator
   * modes and shows the meter — see the test below. `jev-only` is the one D5 mode left: it prompts no generator at
   * all, so it still builds nothing.
   */
  it('review D5 (as amended by TUI-DESIGN-5 R13): jev-only reads no relaxed view, never pays for it and shows no meter', async () => {
    const h = await makeEngine({
      mode: 'jev-only',
      synthesizer: { propose: async () => ({ proposal: { goal: 'stop', action: { kind: 'done', summary: 'nothing to do' }, plan: { done: [], remaining: [], openProblems: [] }, rawText: 'done' }, decisions: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 } }) } as never,
      limits: { maxSteps: 1 },
    });
    harnesses.push(h);
    await h.engine.run();
    // no meter at all — never a `ctx 0%` that cannot move
    expect((h.engine.status() as { context?: unknown }).context).toBeUndefined();
    for (const e of h.events) if (e.type === 'status') expect((e as { status: { context?: unknown } }).status.context).toBeUndefined();
    // no generator call, and none of §8's disk or state weight
    expect(h.provider.requests).toHaveLength(0);
    expect(h.store.outputs.size).toBe(0);
    expect(h.store.summary).toBeNull();
    const state = h.store.last();
    if (state !== undefined) for (const key of ['history', 'fileCache', 'fileMemory', 'summaryAt', 'compactions']) expect(state).not.toHaveProperty(key);
  });

  /**
   * contract 1.4 (§8.8 column 3, §12.0.3) / TUI-DESIGN-5 §8.2 R13: the other half of the inversion above. llm-jev is
   * the shipped DEFAULT_MODE, so before this the `ctx N%` meter and `/context` were blind for most users.
   */
  it('TUI-DESIGN-5 R13: an llm-jev run builds the relaxed view — the meter moves, `outputs/` fills, and the synthesizer is handed `contextText`', async () => {
    const seen: (string | undefined)[] = [];
    const h = await makeEngine({
      mode: 'llm-jev',
      synthesizer: synthRunning(seen),
      sandbox: createFakeSandbox((c) => execResult({ stdout: `${c}\n${'x'.repeat(5_000 - c.length - 2)}\n` })),
      limits: { maxSteps: 3 },
    });
    harnesses.push(h);
    await h.engine.run();

    const u = usage(h.engine.status());
    expect(u.promptChars).toBeGreaterThan(0);
    // §12.0.3: the percentage is of the PROMPT BUDGET, in tokens, and the three numbers agree
    expect(u.tokensInWindow).toBe(Math.round(u.promptChars / CHARS_PER_TOKEN));
    expect(u.budgetTokens).toBe(Math.round(u.budgetChars / CHARS_PER_TOKEN));
    expect(u.pct).toBe(Math.round((100 * u.tokensInWindow) / u.budgetTokens));
    // §12.0.3 cadence point 1: the last recompute was step 3's prompt build, which saw steps 1–2 in the history
    expect(u.historyEntries).toBe(2);
    // every `status` carries the SAME object, so a surface never sees the member appear and vanish
    const statuses = h.events.filter((e) => e.type === 'status');
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((e) => (e as { status: { context?: unknown } }).status.context !== undefined)).toBe(true);

    // §8.3 / §8.5: the whole outputs are on disk and the checkpoint carries the additions
    expect([...h.store.outputs.keys()]).toEqual([1, 2, 3]);
    expect((h.store.last()! as { history?: unknown[] }).history).toHaveLength(3);

    // §8.8 column 3: the synthesizer got the assembled sections — and NOT the `propose_action` reply block
    expect(seen).toHaveLength(3);
    const last = seen.at(-1)!;
    expect(last).toContain('## Task');
    expect(last).toContain('## Plan (accepted by the harness)');
    expect(last).toContain('## Recent steps');
    expect(last).not.toContain('## Your reply');
    expect(last).not.toContain('propose_action');
    // step 1 has no history yet; by step 3 the earlier steps' outputs are in the text the synthesizer holds
    expect(seen[0]).not.toContain('### step 2:');
    expect(last).toContain('### step 2:');
    // llm-jev calls no generator through the engine's propose stage — the view rides the synthesizer's own samples
    expect(h.provider.requests).toHaveLength(0);
  });

  it('TUI-DESIGN-5 R13: the §8.6 compaction and the Q16 `context:warn` cadence fire on llm-jev exactly as on jev-on', async () => {
    const seen: (string | undefined)[] = [];
    const h = await makeEngine({
      mode: 'llm-jev',
      synthesizer: synthRunning(seen),
      sandbox: createFakeSandbox((c) => execResult({ stdout: `${c}\n${'x'.repeat(5_000 - c.length - 2)}\n` })),
      limits: { maxSteps: 6 },
      engine: {
        contextPolicy: { view: 'relaxed', windowTokens: 20_000, compactEvery: 0 },
        instructions: { files: [{ path: 'AGENTS.md', sha256: 'ab'.repeat(32), bytes: 40_000 }], text: 'house style. '.repeat(3_077) },
      },
    });
    harnesses.push(h);
    await h.engine.run();
    const warns = h.events.filter((e) => e.type === 'context:warn');
    expect(warns.length).toBeGreaterThanOrEqual(1);
    for (const w of warns) expect((w as { pct: number }).pct).toBeGreaterThanOrEqual(COMPACT_AT_PCT);
    const compacted = h.events.filter((e) => e.type === 'context:compacted');
    expect(compacted.length).toBeGreaterThanOrEqual(1);
    expect(h.store.summary).not.toBeNull();
    // and the fold reaches the text the synthesizer is handed on the next step
    expect(seen.at(-1)!).toContain('## Summary (rolling');
  });

  it('review D18: the legacy pin carries no `context` on status either', async () => {
    const h = await runSteps(2, 5_000, { view: 'legacy' });
    await h.engine.run();
    expect((h.engine.status() as { context?: unknown }).context).toBeUndefined();
    expect(h.events.filter((e) => e.type === 'status').every((e) => (e as { status: { context?: unknown } }).status.context === undefined)).toBe(true);
  });

  it('review D12: when the 64 MiB bound drops an output mid-run, its history line stops pointing at a file', async () => {
    const h = await runSteps(1, 5_000, { compactEvery: 0 });
    h.store.outputsMax = 3;
    harnesses.push(h);
    await h.engine.run();
    const more = await makeEngine({
      store: h.store,
      runsDir: h.runsDir,
      resume: { runId: h.engine.runId, force: false },
      turns: () => turn({ kind: 'run', command: 'echo z' }, { remaining: ['keep going'] }),
      sandbox: createFakeSandbox(() => execResult({ stdout: `z\n${'x'.repeat(5_000)}\n` })),
      limits: { maxSteps: 6 },
    });
    harnesses.push(more);
    await more.engine.run();
    // the bound kept only the newest 3 files; the older entries say so instead of pointing at nothing
    expect(h.store.outputs.size).toBeLessThanOrEqual(3);
    const prompt = more.provider.requests.at(-1)!.messages[0]!.content;
    expect(prompt).toContain('full text dropped by the 64 MiB per-run output bound');
    const dangling = [...prompt.matchAll(/read jevcode:outputs\/step-(\d+)\.txt/g)].map((m) => Number(m[1]));
    for (const step of dangling) expect(h.store.outputs.has(step)).toBe(true);
  });

  it('a resume restores the additions and keeps counting from them', async () => {
    const first = await runSteps(9, 5_000);
    harnesses.push(first);
    await first.engine.run();
    const saved = first.store.last()!;
    const resumed = await makeEngine({
      store: first.store,
      runsDir: first.runsDir,
      turns: () => turn({ kind: 'run', command: 'echo z' }, { remaining: ['keep going'] }),
      sandbox: createFakeSandbox(() => execResult({ stdout: `z\n${'x'.repeat(5_000)}\n` })),
      limits: { maxSteps: 10 },
      resume: { runId: first.store.meta!.runId, force: false },
    });
    harnesses.push(resumed);
    const u = usage(resumed.engine.status());
    expect(u.compactions).toBe(1);
    expect(u.summaryAt).toBe(8);
    expect(u.historyEntries).toBe((saved as { history?: unknown[] }).history!.length);
    expect(u.promptChars).toBe(0);
    // …and it RUNS: the summary comes back from disk, the meter moves, the history keeps growing from the restored rows
    await resumed.engine.run();
    const after = usage(resumed.engine.status());
    expect(after.promptChars).toBeGreaterThan(0);
    const prompt = resumed.provider.requests[0]!.messages[0]!.content;
    expect(prompt).toContain('## Summary (rolling; compacted at step 8)');
    expect(prompt).toContain('## Recent steps');
    expect((resumed.store.last()! as { history?: { step: number }[] }).history!.map((e) => e.step)).toContain(10);
  });

  it('a resume folds steps.jsonl rows the checkpoint never saw into the history (foldedSteps → foldHistoryRecord)', async () => {
    const first = await runSteps(3, 5_000, { compactEvery: 0 });
    await first.engine.run();
    // two committed steps whose checkpoint never landed: the rows are in steps.jsonl, the state stops at step 3
    const stale = structuredClone(first.store.last()!) as typeof first.store.states[number] & { history?: { step: number }[] };
    stale.history = (stale.history ?? []).filter((e) => e.step <= 1);
    stale.step = 1;
    first.store.states.push(stale);
    const resumed = await makeEngine({
      store: first.store,
      runsDir: first.runsDir,
      resume: { runId: first.engine.runId, force: false },
      turns: () => turn({ kind: 'done', summary: 'nothing left' }, { remaining: [] }),
      limits: { maxSteps: 5 },
    });
    harnesses.push(resumed);
    await resumed.engine.run();
    const prompt = resumed.provider.requests[0]!.messages[0]!.content;
    // steps 2 and 3 came back from steps.jsonl, not from the (stale) checkpoint, and carry their outputs
    expect(prompt).toContain('### step 2:');
    expect(prompt).toContain('### step 3:');
    expect(prompt).toContain('x'.repeat(2_000));
    const history = (resumed.store.last()! as { history?: { step: number; outputRef?: string }[] }).history!;
    expect(history.map((e) => e.step).slice(0, 4)).toEqual([1, 2, 3, 4]);
    expect(history.find((e) => e.step === 3)!.outputRef).toBe('outputs/step-3.txt');
  });
});

/**
 * contract 1.4 (Q16) `context:warn`: the §8.6 compaction line (`COMPACT_AT_PCT`, 85 % of the prompt budget) is the
 * moment the run's context stops being comfortable — the fold that follows is visible, but nothing announced the
 * crossing itself, so a surface had to poll `status().context.pct` to notice. The event is edge-triggered: one per
 * UPWARD crossing, never a per-step drip, and the compaction that follows lowers the meter and re-arms it.
 *
 * It is emitted where the relaxed meter is computed, so the modes without a meter cannot emit it: `view: 'legacy'`
 * and the non-consuming modes (jev-only, llm-jev) never reach the branch.
 */
describe('contract 1.4 (Q16) context:warn', () => {
  /**
   * A run whose fixed system prompt (clipped project instructions) already sits well inside the budget, so the
   * growing recent-steps section is what pushes the meter over the line — and the fold pulls it back under.
   */
  async function crowded(view: 'relaxed' | 'legacy'): Promise<Harness> {
    let i = 0;
    const h = await makeEngine({
      turns: () => turn({ kind: 'run', command: `echo ${'abcdefghijklmnopqrst'[i++ % 20]}` }, { remaining: ['keep going'] }),
      sandbox: createFakeSandbox((c) => execResult({ stdout: `${c}\n${'x'.repeat(Math.max(0, 5_000 - c.length - 2))}\n` })),
      limits: { maxSteps: 6 },
      engine: {
        contextPolicy: { view, windowTokens: 20_000, compactEvery: 0 },
        instructions: { files: [{ path: 'AGENTS.md', sha256: 'ab'.repeat(32), bytes: 40_000 }], text: 'house style. '.repeat(3_077) },
      },
    });
    harnesses.push(h);
    return h;
  }

  it('fires once per upward crossing of the 85 % line, and the compaction under it re-arms the next one', async () => {
    const h = await crowded('relaxed');
    await h.engine.run();
    // six steps, two crossings: 60 → 69 → 78 → 86 (fold) → 79 → 87 (fold). Never one per step.
    const warns = h.of('context:warn');
    expect(warns.map((w) => w.step)).toEqual([4, 6]);
    expect(h.of('context:compacted').map((e) => e.step)).toEqual([4, 6]);

    const budgetTokens = Math.round(contextBudgetChars(20_000) / 3.4);
    for (const w of warns) {
      const req = h.provider.requests[w.step - 1]!;
      const promptChars = (req.system ?? '').length + req.messages[0]!.content.length;
      expect(w.budgetTokens, `step ${w.step}`).toBe(budgetTokens);
      expect(w.tokensInWindow, `step ${w.step}`).toBe(Math.round(promptChars / 3.4));
      expect(w.pct, `step ${w.step}`).toBe(Math.round((100 * w.tokensInWindow) / w.budgetTokens));
      expect(w.pct, `step ${w.step}`).toBeGreaterThanOrEqual(COMPACT_AT_PCT);
    }

    // the first warn precedes the fold it predicts; the second only happens because step 5 came back under the line
    const types = h.events.map((e) => e.type);
    expect(types.indexOf('context:warn')).toBeLessThan(types.indexOf('context:compacted'));
    expect(types.lastIndexOf('context:warn')).toBeGreaterThan(types.indexOf('context:compacted'));
    const fifth = h.provider.requests[4]!;
    const fifthPct = Math.round((100 * Math.round(((fifth.system ?? '').length + fifth.messages[0]!.content.length) / 3.4)) / budgetTokens);
    expect(fifthPct).toBeLessThan(COMPACT_AT_PCT);
  });

  it('a legacy run emits none — the meter it would report does not exist', async () => {
    const h = await crowded('legacy');
    await h.engine.run();
    expect(h.of('context:warn')).toEqual([]);
    expect((h.engine.status() as { context?: unknown }).context).toBeUndefined();
  });
});
