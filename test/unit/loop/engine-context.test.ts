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
import { HISTORY_STEPS, contextBudgetChars } from '../../../src/loop/context/limits.js';
import type { ContextUsage } from '../../../src/loop/context/types.js';
import { createFakeSandbox, createFakeWorkspace, execResult, makeEngine, turn, type Harness } from './fakes.js';

const harnesses: Harness[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** `EngineStatus.context` (the §12.0.3 subtype the engine returns until core/types.ts carries the member). */
function usage(status: EngineStatus): ContextUsage {
  const c = (status as EngineStatus & { context?: ContextUsage }).context;
  expect(c).toBeDefined();
  return c!;
}

/** `steps` run steps whose output is `chars` long (letters, not digits: signature normalisation strips digits). */
async function runSteps(steps: number, chars: number, contextPolicy?: { view?: 'relaxed' | 'legacy'; compactEvery?: number }): Promise<Harness> {
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

  it('a `read` of jevcode:outputs/step-<n>.txt is served from the run dir, never from the workspace', async () => {
    const h = await makeEngine({
      turns: [
        turn({ kind: 'run', command: 'pytest -q' }, { remaining: ['read the tail'] }),
        turn({ kind: 'read', paths: ['jevcode:outputs/step-1.txt', 'jevcode:outputs/step-9.txt'] }, { remaining: ['fix'] }),
      ],
      sandbox: createFakeSandbox(() => execResult({ stdout: `FAILED tests/test_a.py::test_f\n${'y'.repeat(40_000)}\n` })),
      limits: { maxSteps: 2 },
    });
    harnesses.push(h);
    await h.engine.run();
    const out = h.store.steps[1]!.outcome!;
    const text = out.status === 'executed' ? (out.summary ?? '') : '';
    expect(text).toBeTruthy();
    const read = h.events.filter((e) => e.type === 'transcript').map((e) => ('text' in e ? e.text : '')).join('\n');
    expect(read).not.toContain('outputs/step-1.txt: no such file');
    // the second path has no stored output and says so; the workspace was never asked for either
    expect(h.workspace.reads).not.toContain('jevcode:outputs/step-1.txt');
    expect(h.workspace.reads).not.toContain('jevcode:outputs/step-9.txt');
    const prompt = h.provider.requests.at(-1)!.messages[0]!.content;
    expect(prompt).toContain('jevcode:outputs/step-1.txt');
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
    expect(prompt3).toContain('contents are under Files in view');
    // the workspace was asked for the file twice in total: step 1's read and the first prompt's refresh
    expect(h.workspace.reads.filter((p) => p === 'a.py')).toHaveLength(2);
  });
});

describe('§8.6 / §12.0.3 compaction and the meter', () => {
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
    expect((notice as { text: string }).text).toMatch(/^compaction: \d+ → \d+ chars \(code\); 6 steps folded into the summary at step 8 \(every 8 steps\)$/);
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
    expect(after.promptChars).toBe(h.provider.requests.at(-1)!.messages[0]!.content.length);
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

  it('compaction is deterministic: two identical runs produce the same summary and the same counters', async () => {
    const a = await runSteps(9, 5_000);
    await a.engine.run();
    const b = await runSteps(9, 5_000);
    await b.engine.run();
    const fold = (h: Harness): string => JSON.stringify(h.store.summary, (k, v) => (k === 'at' ? '<t>' : v));
    expect(fold(b)).toBe(fold(a));
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
  });
});
