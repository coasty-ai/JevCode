import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BARE_NOTICE_KINDS,
  COMPACT_HIDDEN_KINDS,
  CONFIRM_HEADER_COLUMNS,
  CONFIRM_HEADER_ROWS,
  CONFIRM_KEYS_LINE,
  HEADER_ITEM_KEY,
  IDENTITY_NO_INPUT,
  IDENTITY_NO_TTY,
  IDENTITY_REVIEWER,
  READLINE_CONFIRM_KEYS,
  READLINE_MAX_PROMPTS,
  READLINE_NOTE_PROMPT,
  RUN_END_PATTERN,
  RUN_END_RE,
  RUN_FINISHED_WORD,
  RUN_STARTED_RE,
  RUN_STARTED_TAIL_PATTERN,
  RUN_STARTED_WORD,
  clipDetail,
  dominantRiskClause,
  confirmHeaderLines,
  confirmPreviewLines,
  createItemStreamState,
  createPlainRenderer,
  createReadlineConfirmer,
  formatTranscriptItem,
  headerItem,
  isChatLabel,
  contextWarnItemText,
  itemsFromEvent,
  localItem,
  normaliseNote,
  oneLine,
  outcomeSummaryText,
  plainFirstLine,
  retrySettledText,
  riskItemText,
  sanitizeStream,
  sessionHeaderItem,
  stepSummaryText,
  type ConfirmInput,
  type NoteGate,
} from '../../../src/tui/plain.js';
import { REVIEW_KEYS_80, reviewHeaderLines } from '../../../src/tui/review/lines.js';
import { joinWrapped, wrapBody, wrapBodyCut } from '../../../src/tui/transcript/wrap.js';
import { ctxText } from '../../../src/tui/context/lines.js';
import { computeContextUsage } from '../../../src/loop/context/meter.js';
import { cellWidth, glyphSet, glyphTwin } from '../../../src/tui/glyphs.js';
import { makeEngine, turn } from '../loop/fakes.js';
import { budgetItems } from '../../../src/tui/budget/lines.js';
import { gitBannerLine, headDriftWarning } from '../../../src/workspace/gitstate.js';
import { AbortError } from '../../../src/errors.js';
import type { ContextUsage, EngineEvent, JudgeResult, LaunchSettings, NoticeKind, RunGitMeta, SecretHit, SessionHost } from '../../../src/core/types.js';
import { makeProposal, makeStepRecord } from '../../fixtures/checkpoint/make.js';
import { fakeEngine, loadRunEvents, mkConfirmRequest, tick } from '../../fixtures/tui/fixtures.js';
import { stopTranscriptLine } from '../../../src/loop/stop.js';
import { MODE_BADGE_WORD } from '../../../src/config/defaults.js';

class Sink extends PassThrough {
  text = '';
  constructor() {
    super();
    this.setEncoding('utf8');
    this.on('data', (chunk: string) => {
      this.text += chunk;
    });
  }
}

function ttyInput(): ConfirmInput {
  const s = new PassThrough() as PassThrough & { isTTY?: boolean };
  s.isTTY = true;
  return s;
}

describe('itemsFromEvent / formatTranscriptItem', () => {
  it('produces one item for transcript kinds and none for pane-only events', () => {
    const events = loadRunEvents();
    let seq = 0;
    const kinds = new Map<string, number>();
    for (const e of events) {
      const items = itemsFromEvent(e, seq);
      expect(items.length).toBeLessThanOrEqual(1);
      for (const it of items) {
        expect(it.key).toBe(`${it.step ?? 'run'}:${it.kind}:${seq}`);
        expect(it.text).not.toMatch(/\n/);
        kinds.set(it.kind, (kinds.get(it.kind) ?? 0) + 1);
        seq += 1;
      }
    }
    expect(kinds.has('run:start')).toBe(true);
    expect([...kinds.keys()]).not.toContain('decision');
    // tool-argument streaming is a live-region signal only: no line in plain output or transcript.log
    expect(itemsFromEvent({ type: 'generator:tool-delta', step: 1, chars: 57 }, 0)).toEqual([]);
    for (const t of ['decision', 'status', 'stage:start', 'stage:end', 'checkpoint', 'generator:delta', 'generator:end', 'exec:start', 'step:start'] as const) {
      const e = events.find((x) => x.type === t);
      expect(e, t).toBeDefined();
      expect(itemsFromEvent(e!, 0)).toEqual([]);
    }
  });

  it('formats the documented line shapes (TUI-DESIGN-4 §3.6, D-V: sentence case, ` · ` the one separator, no `k=v`, no `|`)', () => {
    const intent = itemsFromEvent({ type: 'intent', step: 3, intent: 'edit', answer: 'edit', probability: 0.82, confidence: 0.71 }, 0)[0]!;
    expect(formatTranscriptItem(intent)).toBe('[step 3] intent · edit · 0.82 (confidence 0.71)');
    const fallback = itemsFromEvent({ type: 'intent', step: 3, intent: 'investigate', answer: 'none_of_these', probability: 0.4, confidence: 0.1 }, 0)[0]!;
    expect(formatTranscriptItem(fallback)).toBe('[step 3] intent · investigate · 0.40 (confidence 0.10) · Jev answered none_of_these');
    const risk = itemsFromEvent(loadRunEvents().find((e) => e.type === 'risk' && e.step === 2)!, 7)[0]!;
    // §3.6 (G3): ONE row — an `ok` verdict used to cost 8 terminal rows — and the audit string moves to the TUI-only detail
    expect(formatTranscriptItem(risk)).toBe('[step 2] risk 0.50 review · destructive 2 · /why s2.risk.destructive');
    expect(risk.detail).toBe('destructive: level 2 (0.50)');
    expect(risk.verdict).toBe('review');
    const okRisk = itemsFromEvent({ type: 'risk', step: 1, risk: { dims: { destructive: { risk: 0.01, probability: 1, expected: 0, tailMass: 0, bound: 'expected', confidence: 1, level: 0 }, out_of_scope: { risk: 0, probability: 1, expected: 0, tailMass: 0, bound: 'expected', confidence: 1, level: 0 }, plan_mismatch: { risk: 0, probability: 1, expected: 0, tailMass: 0, bound: 'expected', confidence: 1, level: 0 }, irreversible: { risk: 0, probability: 1, expected: 0, tailMass: 0, bound: 'expected', confidence: 1, level: 0 } }, risk: 0.01, verdict: 'ok', reason: 'risk 0.01 (ok) from destructive: expected level 0.00 of 3; dominant level 0 "nothing is lost"; Jev confidence 1.00' } }, 0)[0]!;
    expect(formatTranscriptItem(okRisk)).toBe('[step 1] risk 0.01 ok · destructive 0 · irreversible 0');
    const proposal = itemsFromEvent(loadRunEvents().find((e) => e.type === 'proposal' && e.step === 2)!, 9)[0]!;
    // §3.6 / §6.1 (G2, G7): the target names the file and its counts; the plan counts moved to the `plan` item
    expect(formatTranscriptItem(proposal)).toBe('[step 2] proposal · edit src/a.py +1 −1 · "fix the off-by-one"');
    // §6.2 / A6-2: the `edit` preview is a real unified diff now, not two blobs labelled `--- old` / `+++ new`
    expect(proposal.detail).toBe('--- a/src/a.py\n+++ b/src/a.py\n@@ -1 +1 @@\n-range(n)\n\\ No newline at end of file\n+range(n + 1)\n\\ No newline at end of file');
    expect(proposal.detailKind).toBe('diff');
    const end = itemsFromEvent(loadRunEvents().at(-1)!, 20)[0]!;
    // §3.6 (G1): ONE form everywhere; the `(generator … · jev …)` split is always present
    expect(formatTranscriptItem(end)).toBe('[run] finished · max_steps · 2 steps · 9s · $0.010 (generator $0.010 · jev $0.000)');
    const resolved = itemsFromEvent({ type: 'confirm:resolved', step: 2, id: 'c-2', approved: false, aborted: false }, 1)[0]!;
    // §3.6 (G5): the confirm id is machine-only (it is in decisions.jsonl)
    expect(formatTranscriptItem(resolved)).toBe('[step 2] review declined');
    expect(resolved.key).toBe('2:confirm:resolved:1');
  });

  it('§3.6 (G1): `run:start` names the mode badge and the task, `run:ready` is deleted as an item, and the run id is in neither', () => {
    const start = itemsFromEvent({ type: 'run:start', runId: '20260922-035503-kntk2yw3', mode: 'jev-on', resumedFromStep: null, task: 'fix the failing test' }, 0)[0]!;
    expect(formatTranscriptItem(start)).toBe('[run] started · jev+llm · fix the failing test');
    expect(start.text).not.toContain('20260922');
    const resumed = itemsFromEvent({ type: 'run:start', runId: 'r1', mode: 'jev-only', resumedFromStep: 7, task: 't' }, 0)[0]!;
    expect(formatTranscriptItem(resumed)).toBe('[run] started · jev-only · resumed at step 7 · t');
    expect(itemsFromEvent({ type: 'run:ready', runId: 'r1', step: 0, maxSteps: 40, task: 't', resumed: false }, 0)).toEqual([]);
    /**
     * §3.6 (G1): the `stop:` line is deleted too — `[run] finished` already says it. `src/loop/stop.ts` is the
     * harness session's under the 2026-09-22 ownership rule, so the deletion lands in the ONE formatter instead:
     * every sink §3.7 lists (transcript.log, `--plain`, the TUI, the session controller) reads `itemsFromEvent`,
     * so dropping it here drops it everywhere, and the `--json` event is untouched.
     */
    expect(itemsFromEvent({ type: 'transcript', step: null, level: 'info', text: '' }, 0)).toEqual([]);
    for (const reason of ['complete', 'human_abort', 'max_steps', 'human_pause'] as const) {
      expect(itemsFromEvent({ type: 'transcript', step: null, level: 'info', text: stopTranscriptLine(reason, 5) }, 0)).toEqual([]);
      expect(itemsFromEvent({ type: 'transcript', step: null, level: 'warn', text: stopTranscriptLine(reason, 5, 'a detail') }, 0)).toEqual([]);
    }
    // a generator line that merely BEGINS with the word is not the frame line and survives
    expect(itemsFromEvent({ type: 'transcript', step: 2, level: 'info', text: 'stop: the tests are red at step 5 of the plan' }, 0)).toHaveLength(1);
    expect(itemsFromEvent({ type: 'transcript', step: 2, level: 'info', text: 'stop: complete at step 5 — and then some' }, 0)).toHaveLength(1);
  });

  it('§3.6 (G2): the `plan` item is emitted only when a count changed, and the same event object decides the same way for every sink', () => {
    const plan = (done: string[], remaining: string[]): Extract<EngineEvent, { type: 'plan' }> => ({ type: 'plan', step: 1, plan: { done: done.map((text) => ({ text, evidence: { step: 1, judged: -1 } })), remaining, unverified: [], openProblems: [], harnessProblems: [] }, rejectedDone: [], unverifiedDone: [] });
    itemsFromEvent({ type: 'run:start', runId: 'r1', mode: 'jev-on', resumedFromStep: null, task: 't' }, 0);
    const first = plan([], ['a', 'b', 'c']);
    expect(itemsFromEvent(first, 0).map(formatTranscriptItem)).toEqual(['[step 1] plan · 0 done · 3 remaining']);
    // the SAME event object seen by a second sink takes the SAME branch (useEngine.tsx and session.ts both call this)
    expect(itemsFromEvent(first, 0).map(formatTranscriptItem)).toEqual(['[step 1] plan · 0 done · 3 remaining']);
    expect(itemsFromEvent(plan([], ['a', 'b', 'c']), 0)).toEqual([]);
    expect(itemsFromEvent(plan(['a'], ['b', 'c']), 0).map(formatTranscriptItem)).toEqual(['[step 1] plan · 1 done · 2 remaining']);
    // a new run always emits its first plan again
    itemsFromEvent({ type: 'run:start', runId: 'r2', mode: 'jev-on', resumedFromStep: null, task: 't' }, 0);
    expect(itemsFromEvent(plan(['a'], ['b', 'c']), 0)).toHaveLength(1);
  });

  it('§3.6 (G4): `outcome blocked/declined/failed` is a one-row summary, with the whole reason as the TUI-only detail', () => {
    const reason = 'risk 0.85 (block) from destructive: expected level 3.00 of 3; dominant level 3 "overwrites a tracked file whose content cannot be regenerated"; Jev confidence 0.90; Jev judged the action does not carry out intent `edit` (matches_intent=0.08)';
    const blocked = itemsFromEvent({ type: 'outcome', step: 4, outcome: { status: 'blocked', reason } }, 0)[0]!;
    expect(formatTranscriptItem(blocked)).toBe('[step 4] blocked · destructive 3 · "overwrites a tracked file whose content cannot be regenerat…"');
    expect(blocked.detail).toBe(reason);
    expect(blocked.text).not.toContain('matches_intent=');
    const failed = itemsFromEvent({ type: 'outcome', step: 4, outcome: { status: 'failed', error: 'patch failed: calc/ops.py:12 — patch does not apply' } }, 0)[0]!;
    expect(formatTranscriptItem(failed)).toBe('[step 4] failed · "patch failed: calc/ops.py:12 — patch does not apply"');
    // executed: the duplicated `exit 0 (exit 0, 10ms)` collapses and `read 1 file(s)` is pluralised
    const executed = itemsFromEvent({ type: 'outcome', step: 2, outcome: { status: 'executed', summary: 'read 3 file(s)', changedFiles: [] } }, 0)[0]!;
    expect(formatTranscriptItem(executed)).toBe('[step 2] done · read 3 files');
    const one = itemsFromEvent({ type: 'outcome', step: 2, outcome: { status: 'executed', summary: 'read 1 file(s)', changedFiles: [] } }, 0)[0]!;
    expect(formatTranscriptItem(one)).toBe('[step 2] done · read 1 file');
  });

  it('§14.2 item 6: a `failed` outcome keeps its WHOLE §6.7 diagnosis in transcript.log and `--plain`', () => {
    // `outcome.error` is not a `RiskAssessment.reason` — it is the two-message text §6.7 builds, and it repeats
    // nothing printed above it. The 60-cell clip cut `PATCH_ERROR_MESSAGES_MAX = 2`'s second message mid-path in
    // the only place a `--plain` user ever sees it (both sinks drop `detail`).
    const two = 'patch failed: calc/ops.py:12 — patch does not apply; calc/io.py:4 — patch does not apply';
    expect(two.length).toBe(88);
    const failed = itemsFromEvent({ type: 'outcome', step: 4, outcome: { status: 'failed', error: two } }, 0)[0]!;
    expect(formatTranscriptItem(failed)).toBe(`[step 4] failed · "${two}"`);
    expect(failed.text).toContain('calc/io.py:4');
    expect(failed.text).not.toContain('…');
    // a 120-character ENOENT message survives too; only `TRANSCRIPT_TEXT_MAX` bounds it
    const enoent = `ENOENT: no such file or directory, open '${'d/'.repeat(30)}x.py'`;
    expect(enoent.length).toBeGreaterThan(100);
    expect(itemsFromEvent({ type: 'outcome', step: 4, outcome: { status: 'failed', error: enoent } }, 0)[0]!.text).toContain(enoent);
    // …and a pathological one is still bounded by the item cap
    const huge = itemsFromEvent({ type: 'outcome', step: 4, outcome: { status: 'failed', error: 'z'.repeat(5000) } }, 0)[0]!;
    expect(huge.text.length).toBeLessThanOrEqual(600);
    // `blocked` / `declined` DO repeat the risk row one line above, so they keep the 60-cell summary
    expect(outcomeSummaryText('declined', 'risk 0.85 (block) from destructive: x; dominant level 3 "a"; y')).toBe('declined · destructive 3 · "a"');
  });

  it('§14.2 item 14: the `risk` row and the `outcome blocked` row one line below name the SAME dimension', () => {
    const dims = {
      destructive: { risk: 0.2, probability: 1, expected: 0.2, tailMass: 0, bound: 'expected' as const, confidence: 1, level: 1 },
      out_of_scope: { risk: 0.85, probability: 1, expected: 0.85, tailMass: 0, bound: 'expected' as const, confidence: 1, level: 3 },
    };
    // a reason whose FIRST clause is not the at-max dimension: the old code named `destructive` in the outcome row
    // and `out_of_scope` in the risk row one line above it
    const reason = 'risk 0.85 (block) from destructive: expected level 1.00 of 3; dominant level 1 "small"; Jev confidence 1.00 | out_of_scope: expected level 3.00 of 3; dominant level 3 "leaves the task"; Jev confidence 1.00';
    const risk = { dims, risk: 0.85, verdict: 'block' as const, reason };
    expect(riskItemText(risk, 4)).toBe('risk 0.85 block · out_of_scope 3 "leaves the task" · /why s4.risk.out_of_scope');
    expect(outcomeSummaryText('blocked', reason, risk)).toBe('blocked · out_of_scope 3 · "leaves the task"');
    expect(dominantRiskClause(risk)).toEqual({ dim: 'out_of_scope', level: 3, text: 'leaves the task' });
    // and the two rows agree even when the dims are silent about the dimension the reason names
    expect(dominantRiskClause({ dims: {}, reason })).toEqual({ dim: 'destructive', level: 1, text: 'small' });
    expect(dominantRiskClause({ dims: {}, reason: 'nothing parseable' })).toBeNull();
  });

  it('§14.2 item 15: two interleaved run ids do not share the `plan` baseline', () => {
    const plan = (done: string[], remaining: string[]): Extract<EngineEvent, { type: 'plan' }> => ({ type: 'plan', step: 1, plan: { done: done.map((text) => ({ text, evidence: { step: 1, judged: -1 } })), remaining, unverified: [], openProblems: [], harnessProblems: [] }, rejectedDone: [], unverifiedDone: [] });
    const parent = createItemStreamState();
    const child = createItemStreamState();
    itemsFromEvent({ type: 'run:start', runId: 'parent', mode: 'jev-on', resumedFromStep: null, task: 't' }, 0, parent);
    itemsFromEvent({ type: 'run:start', runId: 'child', mode: 'jev-on', resumedFromStep: null, task: 't' }, 0, child);
    expect(itemsFromEvent(plan([], ['a', 'b', 'c']), 0, parent)).toHaveLength(1);
    // the child's IDENTICAL counts must not be suppressed by the parent's baseline
    expect(itemsFromEvent(plan([], ['a', 'b', 'c']), 0, child)).toHaveLength(1);
    // …and the child's own repeat still is
    expect(itemsFromEvent(plan([], ['a', 'b', 'c']), 0, child)).toHaveLength(0);
    // the child's `run:start` cannot reset the parent's baseline
    expect(itemsFromEvent(plan([], ['a', 'b', 'c']), 0, parent)).toHaveLength(0);
    // one stream, two runs in sequence: `run:end` drops the finished run's entry, so the map cannot grow per run
    expect(parent.planKeys.size).toBe(1);
    itemsFromEvent({ type: 'run:end', result: (loadRunEvents().at(-1) as Extract<EngineEvent, { type: 'run:end' }>).result }, 0, parent);
    expect(parent.planKeys.size).toBe(0);
  });

  it('bounds and sanitises text from events', () => {
    const long = 'x'.repeat(5000) + '\n\u001b[31mred\u001b[0m\t';
    const item = itemsFromEvent({ type: 'transcript', step: null, level: 'warn', text: long }, 0)[0]!;
    expect(item.text.length).toBeLessThanOrEqual(600);
    const short = itemsFromEvent({ type: 'transcript', step: 1, level: 'error', text: 'a\nb\u001b[31mc' }, 0)[0]!;
    expect(formatTranscriptItem(short)).toBe('[step 1] error: a ⏎ b[31mc');
  });

  it('strips C0, DEL and C1 controls from lines, stream text and proposal bodies (a command cannot drive the terminal)', () => {
    // 0x9b is the 8-bit CSI; 0x1b]52;… is an OSC clipboard write; \x07 is BEL
    const hostile = 'a\u009b2Jb\u001b]52;c;Zm9v\u0007c\u007fd';
    expect(oneLine(hostile)).toBe('a2Jb]52;c;Zm9vcd');
    expect(sanitizeStream('x\u001b[2J\ty\r\nz\u0085')).toBe('x[2J\ty\r\nz');
    expect(clipDetail('l1\r\nl2\u001b[2J\rl3')).toBe('l1\nl2[2J\nl3');
    const req = mkConfirmRequest('c1', 1, { kind: 'write', path: 'x.sh', content: 'echo \u001b[2Jhi\nprintf "\u001b]0;title\u0007"' });
    for (const line of confirmPreviewLines(req)) expect(line).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    const item = itemsFromEvent({ type: 'proposal', step: 1, proposal: req.proposal }, 0)[0]!;
    // §6.2: a `write` preview is a unified diff against /dev/null; the control bytes are still gone
    expect(item.detail).toBe('--- /dev/null\n+++ b/x.sh\n@@ -0,0 +1,2 @@\n+echo [2Jhi\n+printf "]0;title"\n\\ No newline at end of file');
    expect(item.detail).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  });

  it('the header item formats to the plain first line and never collides with event keys', () => {
    const h = headerItem('Fix the failing test in src/a.py', null);
    expect(h.key).toBe(HEADER_ITEM_KEY);
    expect(h.seq).toBe(-1);
    expect(formatTranscriptItem(h)).toBe(plainFirstLine('Fix the failing test in src/a.py', null));
    expect(formatTranscriptItem(h)).toBe('[run] jevcode task: Fix the failing test in src/a.py | step 0/– starting');
    expect(formatTranscriptItem(headerItem('x'.repeat(500), null)).length).toBeLessThan(220);
    expect(headerItem('t', '20260919-120000-ab12').text).toBe('jevcode resuming 20260919-120000-ab12 | step 0/– starting');
  });
});

describe('createPlainRenderer', () => {
  it('writes the first line, one line per item identical to formatTranscriptItem, raw deltas terminated at proposal', async () => {
    const out = new Sink();
    const stdin = new PassThrough() as ConfirmInput;
    const aborts: string[] = [];
    const r = createPlainRenderer({
      task: 'Fix the failing test in src/a.py',
      resumeId: null,
      onAbort: (x) => aborts.push(x),
      stdout: out as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
    });
    await r.firstFrame();
    expect(out.text).toBe(`${plainFirstLine('Fix the failing test in src/a.py', null)}\n`);
    expect(out.text).toContain('step 0/–');
    expect(r.confirmer.identity).toBe(IDENTITY_NO_TTY);

    const fe = fakeEngine();
    r.attach(fe.engine);
    const events = loadRunEvents();
    for (const e of events) fe.emit(e);
    await r.unmount();

    const expected: string[] = [plainFirstLine('Fix the failing test in src/a.py', null)];
    let seq = 0;
    let open = false;
    let stream = '';
    for (const e of events) {
      if (e.type === 'generator:delta') {
        stream += e.text;
        open = !e.text.endsWith('\n');
        continue;
      }
      const items = itemsFromEvent(e, seq);
      if (items.length === 0) continue;
      seq += items.length;
      if (stream !== '') {
        expected.push(...(open ? stream : stream.slice(0, -1)).split('\n'));
        stream = '';
        open = false;
      }
      expected.push(...items.map(formatTranscriptItem));
    }
    expect(out.text.split('\n').filter((l, i, a) => i < a.length - 1 || l !== '')).toEqual(expected);
    // step 1 stream had no trailing newline: the proposal line must start a fresh line
    expect(out.text).toContain('"paths": ["tests/test_a.py"]}}\n[step 1] proposal · read tests/test_a.py');
    // step 2 stream ended with a newline: no blank line is inserted
    expect(out.text).toContain('{"goal": "fix"}\n[step 2] proposal · edit');
    expect(aborts).toEqual([]);
  });

  it('resume mode first line names the run id', () => {
    expect(plainFirstLine('ignored', '20260919-120000-ab12')).toBe('[run] jevcode resuming 20260919-120000-ab12 | step 0/– starting');
  });

  it('deltas lose escape sequences and a control-only delta does not open a stream line', async () => {
    const out = new Sink();
    const r = createPlainRenderer({ task: 't', resumeId: null, onAbort: () => undefined, stdout: out as unknown as NodeJS.WriteStream, stdin: new PassThrough() as unknown as NodeJS.ReadStream });
    await r.firstFrame();
    const fe = fakeEngine();
    r.attach(fe.engine);
    fe.emit({ type: 'generator:start', step: 1, attempt: 1 });
    // ESC, BEL and the 8-bit CSI are dropped; what survives of an escape sequence is inert text
    fe.emit({ type: 'generator:delta', step: 1, text: '\u001b\u0007\u009b' });
    fe.emit({ type: 'transcript', step: 1, level: 'info', text: 'after control-only delta' });
    fe.emit({ type: 'generator:delta', step: 1, text: 'plain \u001b[31mred\u001b[0m text' });
    fe.emit({ type: 'transcript', step: 1, level: 'info', text: 'after stream' });
    await r.unmount();
    const lines = out.text.split('\n');
    expect(lines).toEqual([plainFirstLine('t', null), '[step 1] after control-only delta', 'plain [31mred[0m text', '[step 1] after stream', '']);
  });

  it('llm-jev: only the first candidate streams — deltas with sample ≥ 1 are not written (docs/LLM-JEV-DESIGN.md §9.3); absent or 0 streams as before', async () => {
    const out = new Sink();
    const r = createPlainRenderer({ task: 't', resumeId: null, onAbort: () => undefined, stdout: out as unknown as NodeJS.WriteStream, stdin: new PassThrough() as unknown as NodeJS.ReadStream });
    await r.firstFrame();
    const fe = fakeEngine();
    r.attach(fe.engine);
    fe.emit({ type: 'generator:start', step: 1, attempt: 1, sample: 0, samples: 3 });
    fe.emit({ type: 'generator:delta', step: 1, text: 'first', sample: 0 });
    fe.emit({ type: 'generator:start', step: 1, attempt: 1, sample: 1, samples: 3 });
    fe.emit({ type: 'generator:delta', step: 1, text: ' SECOND', sample: 1 });
    fe.emit({ type: 'generator:start', step: 1, attempt: 1, sample: 2, samples: 3 });
    fe.emit({ type: 'generator:delta', step: 1, text: ' THIRD', sample: 2 });
    fe.emit({ type: 'generator:delta', step: 1, text: ' legacy' });
    fe.emit({ type: 'transcript', step: 1, level: 'info', text: 'after samples' });
    await r.unmount();
    expect(out.text.split('\n')).toEqual([plainFirstLine('t', null), 'first legacy', '[step 1] after samples', '']);
  });
});

describe('createReadlineConfirmer', () => {
  it('TTY stdin: y approves, n declines, invalid answers re-prompt; prints the request first', async () => {
    const stdin = ttyInput();
    const out = new Sink();
    const c = createReadlineConfirmer(stdin, out, { onAbort: () => undefined });
    expect(c.identity).toBe(IDENTITY_REVIEWER);
    const signal = new AbortController().signal;

    const p1 = c.confirm(mkConfirmRequest('c1', 3), { signal });
    await tick();
    // TUI-DESIGN §6.5: the 8 header lines `[step 7] `-prefixed, the preview, then the y/n/d prompt
    const header = confirmHeaderLines(mkConfirmRequest('c1', 3));
    expect(header).toHaveLength(CONFIRM_HEADER_ROWS);
    for (const line of header) expect(out.text).toContain(`[step 3] ${line}`);
    // TUI-DESIGN-4 §6.3 "Identity": the readline twin renders the SAME `diffRows` output — signs, not `--- old` blobs
    expect(out.text).not.toContain('--- old');
    expect(out.text).toContain('-x = 1');
    expect(out.text).toContain('+x = 2');
    expect(out.text).toContain(`[step 3] ${READLINE_CONFIRM_KEYS} > `);
    expect(READLINE_CONFIRM_KEYS).toBe('[y] approve  [n] decline  [d] decline+note');
    (stdin as PassThrough).write('maybe\n');
    await tick();
    (stdin as PassThrough).write('Y\n');
    await expect(p1).resolves.toBe(true);

    const p2 = c.confirm(mkConfirmRequest('c2', 4), { signal });
    (stdin as PassThrough).write('no\n');
    await expect(p2).resolves.toBe(false);
  });

  it('TTY stdin: rejects with AbortError when the signal aborts; declines when stdin closes', async () => {
    const stdin = ttyInput();
    const out = new Sink();
    const c = createReadlineConfirmer(stdin, out, { onAbort: () => undefined });
    const ac = new AbortController();
    const p = c.confirm(mkConfirmRequest('c1', 1), { signal: ac.signal });
    ac.abort(new AbortError('signal'));
    await expect(p).rejects.toBeInstanceOf(AbortError);

    const stdin2 = ttyInput();
    const c2 = createReadlineConfirmer(stdin2, new Sink(), { onAbort: () => undefined });
    const p2 = c2.confirm(mkConfirmRequest('c1', 1), { signal: new AbortController().signal });
    (stdin2 as PassThrough).end();
    await expect(p2).resolves.toBe(false);
  });

  it('non-TTY stdin: declines after confirmTimeoutMs without reading input', async () => {
    const stdin = new PassThrough() as ConfirmInput;
    const out = new Sink();
    const c = createReadlineConfirmer(stdin, out, { onAbort: () => undefined, confirmTimeoutMs: 10 });
    expect(c.identity).toBe(IDENTITY_NO_TTY);
    const t0 = Date.now();
    await expect(c.confirm(mkConfirmRequest('c1', 2), { signal: new AbortController().signal })).resolves.toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(8);
    expect(out.text).toContain(`[step 2] confirm c1 declined: ${IDENTITY_NO_TTY}`);
    const c0 = createReadlineConfirmer(new PassThrough() as ConfirmInput, new Sink(), { onAbort: () => undefined });
    await expect(c0.confirm(mkConfirmRequest('c1', 2), { signal: new AbortController().signal })).resolves.toBe(false);
  });
});

describe('itemsFromEvent exhaustiveness', () => {
  it('handles every event type without throwing', () => {
    const events: EngineEvent[] = loadRunEvents();
    for (const e of events) expect(() => itemsFromEvent(e, 0)).not.toThrow();
  });
});

describe('synth transcript items (jev-only)', () => {
  it('one line per synth event, counts only when present, control characters stripped', () => {
    const full: EngineEvent = { type: 'synth', step: 2, phase: 'rank', detail: 'top candidate `return 2`', candidates: 12, tested: 3 };
    const items = itemsFromEvent(full, 5);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: '2:synth:5', seq: 5, step: 2, kind: 'synth', level: 'info' });
    expect(formatTranscriptItem(items[0]!)).toBe('[step 2] synth · rank · top candidate `return 2` · 12 candidates, 3 tested');
    expect(itemsFromEvent({ type: 'synth', step: 1, phase: 'localise', detail: 'src/a.py:2' }, 0)[0]!.text).toBe('synth · localise · src/a.py:2');
    expect(itemsFromEvent({ type: 'synth', step: 1, phase: 'p', detail: 'd', tested: 0 }, 0)[0]!.text).toBe('synth · p · d · 0 tested');
    expect(itemsFromEvent({ type: 'synth', step: 1, phase: 'p', detail: 'd', candidates: 4 }, 0)[0]!.text).toBe('synth · p · d · 4 candidates');
    expect(itemsFromEvent({ type: 'synth', step: 1, phase: 'p', detail: 'a\nb\u001b[2J' }, 0)[0]!.text).toBe('synth · p · a ⏎ b[2J');
    expect(itemsFromEvent({ type: 'synth', step: 1, phase: 'p', detail: 'x'.repeat(2000) }, 0)[0]!.text.length).toBeLessThanOrEqual(600);
  });

  it('the plain renderer prints the synth line and terminates an open stream first', async () => {
    const out = new Sink();
    const r = createPlainRenderer({ task: 't', resumeId: null, onAbort: () => undefined, stdout: out as unknown as NodeJS.WriteStream, stdin: new PassThrough() as unknown as NodeJS.ReadStream });
    await r.firstFrame();
    const fe = fakeEngine();
    r.attach(fe.engine);
    fe.emit({ type: 'run:start', runId: 'r1', task: 't', mode: 'jev-only', resumedFromStep: null });
    // an open generator stream (never in jev-only, but the rule is general) is terminated before the item line
    fe.emit({ type: 'generator:delta', step: 1, text: 'partial' });
    fe.emit({ type: 'synth', step: 1, phase: 'localise', detail: 'src/a.py:2', candidates: 3 });
    fe.emit({ type: 'synth', step: 1, phase: 'select', detail: 'chose `return 2`', candidates: 3, tested: 1 });
    await r.unmount();
    const lines = out.text.split('\n');
    expect(lines).toContain('partial');
    expect(lines).toContain('[run] started · jev-only · t');
    expect(lines).toContain('[step 1] synth · localise · src/a.py:2 · 3 candidates');
    expect(lines).toContain('[step 1] synth · select · chose `return 2` · 3 candidates, 1 tested');
  });
});

// ---------------------------------------------------------------------------------------
// TUI-DESIGN §15.2 (O10 wave 2): the 8-row header, the `d <note>` path, the new item cases, local items
// ---------------------------------------------------------------------------------------

describe('confirmHeaderLines (TUI-DESIGN §6.1, §15.2: 6 → 8 rows)', () => {
  it('is exactly reviewHeaderLines(req, 8, 80): 8 rows, each ≤ 80 cells, row 2 the §24 keys line', () => {
    const req = mkConfirmRequest('c1', 3);
    const lines = confirmHeaderLines(req);
    expect(CONFIRM_HEADER_ROWS).toBe(8);
    expect(CONFIRM_HEADER_COLUMNS).toBe(80);
    expect(lines).toEqual(reviewHeaderLines(req, 8, 80));
    expect(lines).toHaveLength(8);
    for (const l of lines) expect(cellWidth(l)).toBeLessThanOrEqual(80);
    expect(lines[0]).toBe('review  step 3  risk 0.50 (exp)  edit src/a.py +1 −1 "fix the off-by-one"');
    expect(lines[1]).toBe(CONFIRM_KEYS_LINE);
    expect(CONFIRM_KEYS_LINE).toBe(REVIEW_KEYS_80);
    expect(lines[7]).toBe('5 matches_intent  —  not judged this step');
    expect(confirmHeaderLines({ ...req, matchesIntent: 0.88 })[7]).toMatch(/^5 matches_intent .*0\.88 noul/);
  });
});

describe('createReadlineConfirmer: d <note> (TUI-DESIGN §6.4, §6.5, §10.7)', () => {
  const signal = (): AbortSignal => new AbortController().signal;

  it('`d <note>` on the prompt line declines with the note through confirmDetailed; confirm() is its boolean view', async () => {
    const stdin = ttyInput();
    const out = new Sink();
    const c = createReadlineConfirmer(stdin, out, { onAbort: () => undefined });
    const p = c.confirmDetailed(mkConfirmRequest('c1', 3), { signal: signal() });
    await tick();
    (stdin as PassThrough).write('d  wrong file — the bug is in b.py\n');
    await expect(p).resolves.toEqual({ approved: false, note: 'wrong file — the bug is in b.py' });
    const p2 = c.confirm(mkConfirmRequest('c2', 4), { signal: signal() });
    (stdin as PassThrough).write('D nope\n');
    await expect(p2).resolves.toBe(false);
  });

  it('a bare `d` asks for the note on its own line; an empty note cancels back to the keys prompt; the note is one line ≤ 600', async () => {
    const stdin = ttyInput();
    const out = new Sink();
    const c = createReadlineConfirmer(stdin, out, { onAbort: () => undefined });
    const p = c.confirmDetailed(mkConfirmRequest('c1', 3), { signal: signal() });
    await tick();
    (stdin as PassThrough).write('d\n');
    await tick();
    expect(out.text).toContain(`[step 3] ${READLINE_NOTE_PROMPT}`);
    (stdin as PassThrough).write('\n');
    await tick();
    expect(out.text.split(`[step 3] ${READLINE_CONFIRM_KEYS} > `)).toHaveLength(3);
    (stdin as PassThrough).write('d\n');
    await tick();
    (stdin as PassThrough).write(`${'x'.repeat(700)}\u001b[2J\nsecond line ignored\n`);
    const r = await p;
    expect(r.approved).toBe(false);
    expect(r.note).toHaveLength(600);
    expect(r.note).not.toMatch(/[\u001b\n]/);
    expect(normaliseNote('  a\nb\t c \u0007')).toBe('a ⏎ b  c');
  });

  it('a note with a secret passes the gate: anything but y cancels the note; y adds every span and the note leaves redacted', async () => {
    const SECRET = 'sk-ant-api03-SECRETSECRETSECRETSECRETSECRET';
    const added: [string, string][] = [];
    const gate: NoteGate = {
      detectSecrets: (s): readonly SecretHit[] => {
        const i = s.indexOf(SECRET);
        return i < 0 ? [] : [{ family: 'anthropic', label: 'sk-ant-…', start: i, end: i + SECRET.length, warnOnly: false }];
      },
      addSecret: (name, value) => {
        added.push([name, value]);
        return true;
      },
      redact: (s) => s.split(SECRET).join('[REDACTED:composer#1]'),
    };
    const stdin = ttyInput();
    const out = new Sink();
    const c = createReadlineConfirmer(stdin, out, { onAbort: () => undefined, host: () => gate });
    const p = c.confirmDetailed(mkConfirmRequest('c1', 3), { signal: signal() });
    await tick();
    (stdin as PassThrough).write(`d use ${SECRET} instead\n`);
    await tick();
    expect(out.text).toContain('[step 3] jevcode: looks like this contains a secret (sk-ant-…); type y to send, anything else to cancel: ');
    (stdin as PassThrough).write('n\n');
    await tick();
    expect(added).toEqual([]);
    expect(out.text.split(`[step 3] ${READLINE_CONFIRM_KEYS} > `)).toHaveLength(3);
    (stdin as PassThrough).write(`d use ${SECRET} instead\n`);
    await tick();
    (stdin as PassThrough).write('y\n');
    await expect(p).resolves.toEqual({ approved: false, note: 'use [REDACTED:composer#1] instead' });
    expect(added).toEqual([['composer#1', SECRET]]);
    // the secret never reached stdout
    expect(out.text).not.toContain(SECRET);
  });

  it('without a host the note is detected and masked by the pattern layer alone', async () => {
    const stdin = ttyInput();
    const out = new Sink();
    const c = createReadlineConfirmer(stdin, out, { onAbort: () => undefined });
    const p = c.confirmDetailed(mkConfirmRequest('c1', 1), { signal: signal() });
    await tick();
    (stdin as PassThrough).write('d key sk-ant-api03-SECRETSECRETSECRETSECRETSECRET leaked\n');
    await tick();
    expect(out.text).toContain('looks like this contains a secret (sk-ant-…)');
    (stdin as PassThrough).write('y\n');
    await expect(p).resolves.toEqual({ approved: false, note: 'key [REDACTED:pattern] leaked' });
  });

  it('non-TTY: confirmDetailed declines after the timeout with `{ approved: false }` and no note', async () => {
    const c = createReadlineConfirmer(new PassThrough() as ConfirmInput, new Sink(), { onAbort: () => undefined, confirmTimeoutMs: 5 });
    await expect(c.confirmDetailed(mkConfirmRequest('c1', 2), { signal: signal() })).resolves.toEqual({ approved: false });
  });
});

describe('itemsFromEvent: the contract 1.1 engine items (TUI-DESIGN §15.1 item table, §24 strings)', () => {
  const line = (e: EngineEvent, seq = 0): string[] => itemsFromEvent(e, seq).map(formatTranscriptItem);
  /** audit #7: the harness's own `computeContextUsage` is the producer, so the test never re-models `pct`. */
  const usageAtPct = (pct: number): ContextUsage =>
    computeContextUsage({
      promptChars: pct * 1_000,
      budgetChars: 100_000,
      files: 6,
      historyEntries: 12,
      summaryAt: 8,
      lastCompactionStep: 8,
      compactions: 3,
      lastCompactionAt: '2026-09-22T14:02:09.000Z',
      compaction: 'code',
      promptBuildMs: 41,
      refreshMs: 6,
      recentSteps: { chars: 71_000, allowanceChars: 71_000, whole: 2, clipped: 4, oneLine: 6, reads: 3 },
    });

  it('steer:queued / steer:applied / steer:withdrawn / pause:requested', () => {
    expect(line({ type: 'steer:queued', step: 8, index: 1, text: 'also update the docs', queued: 1 })).toEqual(['[step 8] steer queued · step 8 · "also update the docs" · 1 waiting']);
    expect(itemsFromEvent({ type: 'steer:queued', step: 8, index: 1, text: 'x', queued: 3 }, 4)[0]).toMatchObject({ kind: 'steer:queued', key: '8:steer:queued:4', seq: 4, level: 'info' });
    expect(line({ type: 'steer:applied', step: 8, count: 2, superseded: ['replan: change approach', 'a\nb'] })).toEqual(['[step 8] steer applied · step 8 · 2 directives · superseded "replan: change approach", "a ⏎ b"']);
    expect(line({ type: 'steer:applied', step: 8, count: 1, superseded: [] })).toEqual(['[step 8] steer applied · step 8 · 1 directive']);
    expect(line({ type: 'steer:withdrawn', step: 8, index: 2 })).toEqual(['[step 8] steer withdrawn · 2']);
    expect(line({ type: 'pause:requested', step: 5 })).toEqual(['[step 5] pausing · the run stops after step 5']);
    expect(itemsFromEvent({ type: 'pause:requested', step: 5 }, 0)[0]?.kind).toBe('pause');
  });

  it('budget:* through budgetItems (§9.2, §9.4) under the [run] label; 80/95 % and stops are warnings', () => {
    const warn80: EngineEvent = { type: 'budget:warn', scope: 'run', pct: 80, spentUsd: 1.6, capUsd: 2, step: 7, stepsLeftEstimate: 3, restored: false };
    const warn50: EngineEvent = { type: 'budget:warn', scope: 'session', pct: 50, spentUsd: 5.2, capUsd: 10, step: 7, stepsLeftEstimate: null, restored: false };
    const stop: EngineEvent = { type: 'budget:stop', scope: 'run', by: 'run', spentUsd: 2.01, capUsd: 2, step: 9, at: 'step_start', raise: { command: '/budget spend-cap 3.00', flag: '--spend-cap', minimum: 3 } };
    const clamp: EngineEvent = { type: 'budget:clamp', runCapUsd: 2, clampedToUsd: 0.7, sessionSpentUsd: 9.3, sessionCapUsd: 10 };
    const override: EngineEvent = { type: 'budget:override', setting: 'limits.spendCapUsd', from: '2', to: '3', appliesTo: 'resume', source: '/budget' };
    const unpriced: EngineEvent = { type: 'budget:unpriced', side: 'generator', model: 'vendor/x', step: 2, tokens: { input: 10, output: 5 } };
    for (const [e, level] of [[warn80, 'warn'], [warn50, 'info'], [stop, 'warn'], [clamp, 'info'], [override, 'info'], [unpriced, 'warn']] as const) {
      const items = itemsFromEvent(e, 11);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ kind: 'budget', step: null, level, seq: 11, key: `run:budget:11` });
      expect(items[0]!.text).toBe(budgetItems(e)[0]);
      expect(formatTranscriptItem(items[0]!)).toBe(`[run] ${budgetItems(e)[0]}`);
    }
    expect(line(warn80)).toEqual(['[run] budget: run spend $1.600 is 80 % of the $2.000 run cap — about 3 steps left']);
    expect(line(stop)).toEqual(['[run] budget stop: run cap $2.000 reached at step start — raise: /budget spend-cap 3.00']);
    expect(line(clamp)).toEqual(['[run] budget: run cap clamped to $0.700 (session $9.300 of $10.000)']);
    expect(line(override)).toEqual(['[run] budget override: limits.spendCapUsd 2 → 3 (applies to this resume)']);
    expect(line(unpriced)).toEqual(['[run] budget: generator usage.cost missing for vendor/x — unpriced']);
  });

  /**
   * Finishing audit #7 / TUI-DESIGN-5 D-AG, deviation 16. The engine emits `context:warn` once per UPWARD crossing
   * of the 85 % line and `contextEnabled` now includes `llm-jev` (the shipped default), so before this arm the
   * crossing reached `--json` only: every interactive and `--plain` user saw nothing at 85 %. The row is the `ctx`
   * status cell's own amber/red form, so the transcript and the status line cannot disagree.
   *
   * `context:compacted` deliberately produces NO row (D-AJ (b), deviation 3): the engine emits a
   * `notice{kind:'ui'}` beside the typed event whose text already carries `<before> → <after> prompt chars`, the
   * fold count, the step and the trigger — a second row would print one compaction twice.
   */
  it('audit #7: `context:warn` is one row in all three sinks, word-for-word the `ctx` cell; `context:compacted` stays notice-only', () => {
    const warn85: EngineEvent = { type: 'context:warn', step: 7, pct: 85, budgetTokens: 100_000, tokensInWindow: 85_000 };
    const warn87: EngineEvent = { type: 'context:warn', step: 7, pct: 87, budgetTokens: 100_000, tokensInWindow: 87_000 };
    const warn95: EngineEvent = { type: 'context:warn', step: 9, pct: 95, budgetTokens: 100_000, tokensInWindow: 95_000 };
    expect(contextWarnItemText(87)).toBe('ctx 87% amber · /compact now');
    expect(contextWarnItemText(95)).toBe('ctx 95% red · /compact now');
    // the ONE wording: `plain.ts` builds it from `core/limits.ts` rather than importing `context/lines.ts` (the
    // §14.2 item 13 import-graph gate below), so the two strings are pinned equal here instead
    for (const pct of [85, 87, 94, 95, 99]) expect(contextWarnItemText(pct)).toBe(ctxText(usageAtPct(pct), 120));
    const items = itemsFromEvent(warn87, 11);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'notice', step: 7, level: 'warn', seq: 11, text: 'ctx 87% amber · /compact now' });
    // transcript.log == --plain == TUI: one formatter, one string, with the step label the other item rows use
    expect(line(warn87)).toEqual(['[step 7] ctx 87% amber · /compact now']);
    expect(line(warn85)).toEqual(['[step 7] ctx 85% amber · /compact now']);
    expect(line(warn95)).toEqual(['[step 9] ctx 95% red · /compact now']);
    // and it wraps, never cuts, at every rung
    for (const width of [40, 80, 120]) {
      const rows = wrapBody('ctx 87% amber · /compact now', width);
      expect(joinWrapped(rows)).toBe('ctx 87% amber · /compact now');
      for (const r of rows) expect(cellWidth(r)).toBeLessThanOrEqual(width);
    }
    // the typed compaction event yields nothing; the engine's companion `[ui]` notice is the one row
    expect(line({ type: 'context:compacted', step: 4, chars: { before: 41_000, after: 12_000 }, by: 'code' })).toEqual([]);
    const companion: EngineEvent = {
      type: 'notice',
      step: 4,
      kind: 'ui',
      level: 'info',
      label: '[ui]',
      text: 'compaction: 41000 → 12000 prompt chars (code); 3 steps folded into the summary at step 4 (every 8 steps)',
      detail: JSON.stringify({ type: 'context:compacted', step: 4, chars: { before: 41_000, after: 12_000 }, by: 'code' }),
    };
    expect(line(companion)).toEqual(['[ui] compaction: 41000 → 12000 prompt chars (code); 3 steps folded into the summary at step 4 (every 8 steps)']);
  });

  /**
   * Finishing audit #12's follow-up — the harness's `[setup]` synthesizer-scope notice, verbatim. `llm-jev` is the
   * shipped default and `synthesizerHandles` is false for a workspace with no non-test `.py` file, so the run takes
   * the generic per-step propose while the badge still reads `llm+jev · verified`. The notice is a plain
   * `notice{kind:'config', label:'[setup]'}` with no new `EngineEvent` member, so `itemsFromEvent` renders it
   * today — this test is the pin that the TUI row, the `--plain` row and `transcript.log` are the same string and
   * that it WRAPS, never cuts, at 40 columns.
   */
  it("audit #12: the `[setup]` synthesizer-scope notice is one string in all three sinks and wraps at 40 columns", () => {
    const text =
      'synthesizer composite covers Python workspaces with a detected test runner; this workspace takes the generic per-step propose (docs/LLM-JEV-DESIGN.md §9.4)';
    const notice: EngineEvent = { type: 'notice', step: null, kind: 'config', level: 'info', label: '[setup]', text };
    const items = itemsFromEvent(notice, 3);
    expect(items).toHaveLength(1);
    // the item text is the engine's text verbatim — no `notice config:` prefix, no clip (the string is under TRANSCRIPT_TEXT_MAX)
    expect(items[0]!.text).toBe(text);
    expect(items[0]).toMatchObject({ kind: 'notice', step: null, label: '[setup]', level: 'info' });
    // transcript.log and `--plain` print `formatTranscriptItem`; the TUI prints the same item's `text` under the same label
    expect(formatTranscriptItem(items[0]!)).toBe(`[setup] ${text}`);
    expect(line(notice)).toEqual([`[setup] ${text}`]);
    // 40 columns: wrapped, never cut — every token survives and the join is the original
    const body = wrapBodyCut(text, 40);
    expect(body.cuts).toEqual([]);
    expect(joinWrapped(body.rows, body.cuts)).toBe(text);
    expect(body.rows.length).toBeGreaterThan(1);
    for (const r of body.rows) expect(cellWidth(r)).toBeLessThanOrEqual(40);
    expect(body.rows.join(' ').split(/\s+/).filter((w) => w !== '')).toEqual(text.split(/\s+/));
  });

  it('retry:settled: one `warning:` line only when the chain failed or lasted > 10 s; `retry` itself is pane-only', () => {
    expect(line({ type: 'retry:settled', side: 'jev', step: 3, attempts: 3, ok: false, totalWaitMs: 41_000 })).toEqual(['[step 3] warning · jev retried 3 times over 41s — gave up']);
    expect(line({ type: 'retry:settled', side: 'generator', step: null, attempts: 2, ok: true, totalWaitMs: 12_500 })).toEqual(['[run] warning · generator retried 2 times over 12s — recovered']);
    expect(line({ type: 'retry:settled', side: 'jev', step: 3, attempts: 2, ok: true, totalWaitMs: 10_000 })).toEqual([]);
    expect(line({ type: 'retry:settled', side: 'jev', step: 3, attempts: 1, ok: true, totalWaitMs: 0 })).toEqual([]);
    expect(retrySettledText({ type: 'retry:settled', side: 'jev', step: 3, attempts: 1, ok: false, totalWaitMs: 500 })).toBe('warning · jev retried 1 time over 500ms — gave up');
    expect(itemsFromEvent({ type: 'retry:settled', side: 'jev', step: 3, attempts: 3, ok: false, totalWaitMs: 41_000 }, 0)[0]).toMatchObject({ kind: 'retry', level: 'warn' });
    expect(line({ type: 'retry', side: 'jev', step: 3, stage: 'risk', info: { attempt: 2, maxAttempts: 3, waitMs: 12_000, retryAfter: true, cause: { kind: 'http', status: 429, code: null, message: 'rate limited' } } })).toEqual([]);
  });

  it('workspace: the git banner (§12.2), one instructions line per file, the P52 HEAD-drift warning on resume', () => {
    const git: RunGitMeta = { repo: true, head: { kind: 'branch', name: 'main', oid: 'abcdef0123456789' }, upstream: 'origin/main', linkedWorktree: false, prefix: '', dirtyAtStart: { modified: 3, staged: 1, untracked: 1 } };
    const e: EngineEvent = { type: 'workspace', git, instructions: [{ path: 'AGENTS.md', sha256: '1a2b3c4d5e6f7a8b9c', bytes: 1234 }], sandbox: 'seatbelt' };
    const items = itemsFromEvent(e, 5);
    expect(items.map(formatTranscriptItem)).toEqual(['[run] git main · 3 modified · 1 staged · 1 untracked', '[run] instructions: AGENTS.md (1234, sha256 1a2b3c4d)']);
    expect(items.map((i) => i.seq)).toEqual([5, 6]);
    expect(items.map((i) => i.key)).toEqual(['run:workspace:5', 'run:workspace:6']);
    expect(items[0]!.text).toBe(gitBannerLine(git).text);
    const none: EngineEvent = { type: 'workspace', git: { repo: false, reason: 'not-a-repo', head: null, upstream: null, linkedWorktree: false, prefix: '', dirtyAtStart: { modified: 0, staged: 0, untracked: 0 } }, instructions: [], sandbox: 'none' };
    expect(line(none)).toEqual(['[run] git · no repository — changes are not recoverable; /diff <step> compares pre-images']);
    const moved: EngineEvent = { type: 'workspace', git: { ...git, resumedOn: { kind: 'detached', oid: '91ab3c4d5e6f7a8b' } }, instructions: [], sandbox: 'seatbelt' };
    const drift = itemsFromEvent(moved, 0);
    expect(drift).toHaveLength(2);
    expect(drift[1]).toMatchObject({ level: 'warn', text: headDriftWarning(git.head, { kind: 'detached', oid: '91ab3c4d5e6f7a8b' }) });
    expect(formatTranscriptItem(drift[1]!)).toBe('[run] warning: HEAD was main at run start, now 91ab3c4d — the plan may not apply');
    const same: EngineEvent = { type: 'workspace', git: { ...git, resumedOn: git.head }, instructions: [], sandbox: 'seatbelt' };
    expect(itemsFromEvent(same, 0)).toHaveLength(1);
    const unmerged: EngineEvent = { type: 'workspace', git: { ...git, dirtyAtStart: { modified: 412, staged: 0, untracked: 0 } }, instructions: [], sandbox: 'seatbelt' };
    expect(itemsFromEvent(unmerged, 0)[0]!.level).toBe('info');
  });

  it('blocking:request / blocking:resolved (§13.3) and secret-ack (§10.2)', () => {
    const req: EngineEvent = { type: 'blocking:request', request: { id: 'b1', step: 4, kind: 'key-rejected', side: 'jev', detail: 'HTTP 401 — "User not found."', sources: ['JEV_API_KEY (env)'], stop: 'error', exitCode: 2 } };
    expect(line(req)).toEqual(['[step 4] blocking: jev: key rejected (HTTP 401 — "User not found.")']);
    expect(itemsFromEvent(req, 0)[0]).toMatchObject({ kind: 'blocking', level: 'error', step: 4 });
    const unreachable: EngineEvent = { type: 'blocking:request', request: { id: 'b2', step: 7, kind: 'jev-unreachable', detail: '', retryInMs: 30_000, stop: 'error', exitCode: 5 } };
    expect(line(unreachable)).toEqual(['[step 7] blocking: jev unreachable after 3 attempts · retrying in 30 s (auto, doubles to 5 min)']);
    expect(line({ type: 'blocking:resolved', id: 'b1', answer: 'retry', auto: false })).toEqual(['[run] blocking b1 resolved: retry']);
    expect(line({ type: 'blocking:resolved', id: 'b2', answer: 'retry', auto: true })).toEqual(['[run] blocking b2 resolved: retry (auto)']);
    expect(line({ type: 'secret-ack', step: null, count: 1 })).toEqual(['[run] sent 1 secret to the generator on request']);
    expect(line({ type: 'secret-ack', step: 3, count: 2 })).toEqual(['[step 3] sent 2 secrets to the generator on request']);
    expect(itemsFromEvent({ type: 'secret-ack', step: 3, count: 2 }, 0)[0]?.kind).toBe('secret-ack');
  });

  it('confirm:resolved with a note (§6.4) and run:end with the exit code (§13.5)', () => {
    // §3.6 (G5): `review declined · "<note>"` — the confirm id is machine-only (it is in decisions.jsonl)
    expect(line({ type: 'confirm:resolved', step: 2, id: 'c-2', approved: false, aborted: false, note: 'wrong file' })).toEqual(['[step 2] review declined · "wrong file"']);
    expect(line({ type: 'confirm:resolved', step: 2, id: 'c-2', approved: false, aborted: false })).toEqual(['[step 2] review declined']);
    expect(line({ type: 'confirm:resolved', step: 2, id: 'c-2', approved: true, aborted: false, note: 'ignored on approve?' })).toEqual(['[step 2] review approved · "ignored on approve?"']);
    const end = loadRunEvents().at(-1)!;
    expect(end.type).toBe('run:end');
    if (end.type !== 'run:end') return;
    // §3.6 (G1): ONE form everywhere; the `(generator … · jev …)` split is always present
    expect(line(end)).toEqual(['[run] finished · max_steps · 2 steps · 9s · $0.010 (generator $0.010 · jev $0.000)']);
    expect(line({ ...end, exitCode: 4, resumable: true, paths: { runDir: '/r', transcript: '/r/transcript.log', log: '/r/jevcode.log' } })).toEqual(['[run] finished · max_steps · 2 steps · 9s · $0.010 (generator $0.010 · jev $0.000) · exit 4']);
  });

  it('pane-only contract-1.1 events yield nothing: confirm:request, decision, status, retry, checkpoint, exec:output, step:end', () => {
    const events = loadRunEvents();
    for (const t of ['confirm:request', 'decision', 'status', 'checkpoint', 'step:start', 'stage:start'] as const) {
      const e = events.find((x) => x.type === t);
      expect(e, t).toBeDefined();
      expect(itemsFromEvent(e!, 0)).toEqual([]);
    }
    expect(itemsFromEvent({ type: 'exec:output', step: 1, stream: 'stdout', chunk: 'x' }, 0)).toEqual([]);
  });
});

describe('localItem / sessionHeaderItem (TUI-DESIGN §15.1, §24)', () => {
  it('a local item carries local: true and its label; formatTranscriptItem prints the label instead of the step label', () => {
    const i = localItem('recent: "tz fixes" · 2h ago  (Enter continues, /resume browses)', 0);
    expect(i).toMatchObject({ kind: 'ui', local: true, label: '[ui]', level: 'info', step: null, seq: 0, key: 'local:[ui]:0' });
    expect(formatTranscriptItem(i)).toBe('[ui] recent: "tz fixes" · 2h ago  (Enter continues, /resume browses)');
    const s = localItem('seatbelt — writes confined to the workspace and run dirs', 1, { label: '[sandbox]', level: 'warn', detail: 'a\nb' });
    expect(formatTranscriptItem(s)).toBe('[sandbox] seatbelt — writes confined to the workspace and run dirs');
    expect(s).toMatchObject({ level: 'warn', detail: 'a\nb', key: 'local:[sandbox]:1' });
    expect(localItem('a\u001b[2Jb\nc', 2).text).toBe('a[2Jb ⏎ c');
    expect(localItem('x'.repeat(2000), 3).text).toHaveLength(600);
  });

  it('the session header names the directory with the step 0/– sentinel', () => {
    const h = sessionHeaderItem('/Users/me/proj');
    expect(h.key).toBe(HEADER_ITEM_KEY);
    expect(h.seq).toBe(-1);
    expect(formatTranscriptItem(h)).toBe('[run] jevcode session · proj | step 0/– starting');
    expect(sessionHeaderItem('/').text).toBe('jevcode session · / | step 0/– starting');
  });
});

describe('createPlainRenderer: local items, labels, session mode, host hand-over (§15 item 16, §15.1)', () => {
  const noHost = (): SessionHost => ({
    submit: async () => undefined,
    command: async () => undefined,
    steer: () => ({ ok: true, index: 0, queued: 1 }),
    unsteer: () => null,
    pause: () => undefined,
    abort: () => undefined,
    retryNow: () => false,
    note: () => undefined,
    redact: (s) => s.replace('SECRETVALUE', '[REDACTED:h]'),
    addSecret: () => true,
    detectSecrets: () => [],
    exit: () => undefined,
    index: () => [],
    history: () => null,
    workspaceCandidates: async () => [],
  });

  it('notify prints idle-time items with their label, terminating an open stream first; the TUI would print the same line', async () => {
    const out = new Sink();
    const r = createPlainRenderer({ task: 't', resumeId: null, onAbort: () => undefined, stdout: out as unknown as NodeJS.WriteStream, stdin: new PassThrough() as unknown as NodeJS.ReadStream });
    await r.firstFrame();
    r.notify('recent: "tz fixes" · 2h ago  (Enter continues, /resume browses)');
    r.notify('seatbelt — writes confined to the workspace and run dirs', { label: '[sandbox]' });
    r.notify('error: unknown command /foo; type / to list commands', { label: '[ui]', level: 'error', detail: 'never printed' });
    const fe = fakeEngine();
    r.attach(fe.engine);
    fe.emit({ type: 'generator:delta', step: 1, text: 'partial' });
    r.notify('during a stream');
    await r.unmount();
    expect(out.text.split('\n')).toEqual([
      plainFirstLine('t', null),
      '[ui] recent: "tz fixes" · 2h ago  (Enter continues, /resume browses)',
      '[sandbox] seatbelt — writes confined to the workspace and run dirs',
      '[ui] error: unknown command /foo; type / to list commands',
      'partial',
      '[ui] during a stream',
      '',
    ]);
    expect(out.text).not.toContain('never printed');
    expect(formatTranscriptItem(localItem('recent: "tz fixes" · 2h ago  (Enter continues, /resume browses)', 0))).toBe(out.text.split('\n')[1]);
  });

  it('mode: session prints the `jevcode session · <dir>` header; one-shot keeps the task header', async () => {
    const out = new Sink();
    const r = createPlainRenderer({ task: '', resumeId: null, onAbort: () => undefined, mode: 'session', cwd: '/Users/me/proj', stdout: out as unknown as NodeJS.WriteStream, stdin: new PassThrough() as unknown as NodeJS.ReadStream });
    await r.firstFrame();
    expect(out.text).toBe('[run] jevcode session · proj | step 0/– starting\n');
    const one = new Sink();
    const r2 = createPlainRenderer({ task: 'fix it', resumeId: null, onAbort: () => undefined, mode: 'one-shot', stdout: one as unknown as NodeJS.WriteStream, stdin: new PassThrough() as unknown as NodeJS.ReadStream });
    await r2.firstFrame();
    expect(one.text).toBe('[run] jevcode task: fix it | step 0/– starting\n');
  });

  it('setHost hands the gate to the readline confirmer (the note is redacted by the host); setUi is stored', async () => {
    const stdin = ttyInput();
    const out = new Sink();
    const r = createPlainRenderer({ task: 't', resumeId: null, onAbort: () => undefined, stdout: out as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream });
    await r.firstFrame();
    expect(r.host).toBeNull();
    expect(r.ui).toBeNull();
    const host = noHost();
    r.setHost(host);
    expect(r.host).toBe(host);
    const p = r.confirmer.confirmDetailed!(mkConfirmRequest('c1', 2), { signal: new AbortController().signal });
    await tick();
    (stdin as PassThrough).write('d contains SECRETVALUE here\n');
    await expect(p).resolves.toEqual({ approved: false, note: 'contains [REDACTED:h] here' });
    r.setUi({ fps: 30, renderMode: 'standard', screenReader: false, ascii: false, noColor: false, theme: 'dark', title: false, reducedMotion: false, notify: false, osc52: false, history: true, noInput: false, trustWorkspace: false, budgetWarnings: true, allowSecretMention: false, exitCode: 'zero', logLevel: 'info', logFile: null, keybindingsFile: null });
    expect(r.ui?.theme).toBe('dark');
    await r.unmount();
  });
});

// ---------------------------------------------------------------------------------------
// FIX pass: notices (§24), non-interactive confirmer (§1 C46), the §14.1 glyph twin, the invalid-answer
// counter (§6.5), abort races, one interface per stdin, and the §15.1 three-writer identity
// ---------------------------------------------------------------------------------------

describe('itemsFromEvent: notice (TUI-DESIGN §15.1, §24 "Engine items")', () => {
  const line = (e: EngineEvent): string => itemsFromEvent(e, 0).map(formatTranscriptItem).join('|');

  it('a labelled notice from annotate() prints `<label> <text>` with the label instead of the step label', () => {
    const e: EngineEvent = { type: 'notice', step: 3, kind: 'ui', level: 'error', text: 'error: unknown command /foo; type / to list commands', label: '[ui]', detail: 'a\nb' };
    const items = itemsFromEvent(e, 9);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'notice', level: 'error', step: 3, label: '[ui]', detail: 'a\nb', key: '3:notice:9' });
    expect(line(e)).toBe('[ui] error: unknown command /foo; type / to list commands');
    expect(line({ type: 'notice', step: null, kind: 'ui', level: 'warn', text: 'generator.apiKey: env overrides file', label: '[config]' })).toBe('[config] generator.apiKey: env overrides file');
  });

  it('the engine\'s self-describing kinds print bare (`[run] seeded from run …`, `checkpoint degraded: …`, `run <id> is in use …`); the level is kept', () => {
    expect(line({ type: 'notice', step: null, kind: 'seeded', level: 'info', text: 'seeded from run 20260919-142301-k7q2m3xa: plan done=4 remaining=2 unverified=1 · window 3 entries · 2 created files' })).toBe(
      '[run] seeded from run 20260919-142301-k7q2m3xa: plan done=4 remaining=2 unverified=1 · window 3 entries · 2 created files',
    );
    const degraded: EngineEvent = { type: 'notice', step: 3, kind: 'checkpoint:degraded', level: 'error', text: 'checkpoint degraded: ENOSPC on state.json' };
    expect(line(degraded)).toBe('[step 3] checkpoint degraded: ENOSPC on state.json');
    expect(itemsFromEvent(degraded, 0)[0]!.level).toBe('error');
    expect(itemsFromEvent(degraded, 0)[0]!.label).toBeUndefined();
    expect(line({ type: 'notice', step: null, kind: 'lock', level: 'warn', text: "run 20260919-142301-k7q2m3xa is in use by pid 4242 since 2026-09-20T10:00:00Z (another jevcode?); run 'jevcode sessions unlock 20260919-142301-k7q2m3xa' if that process is gone" })).toBe(
      "[run] run 20260919-142301-k7q2m3xa is in use by pid 4242 since 2026-09-20T10:00:00Z (another jevcode?); run 'jevcode sessions unlock 20260919-142301-k7q2m3xa' if that process is gone",
    );
    expect(line({ type: 'notice', step: null, kind: 'drift', level: 'warn', text: 'resumed on 91ab3c4d, run started on abcdef01 — the plan may not apply' })).toBe('[run] resumed on 91ab3c4d, run started on abcdef01 — the plan may not apply');
    expect(line({ type: 'notice', step: 2, kind: 'checkpoint:restored', level: 'info', text: 'checkpoint restored: state.json written' })).toBe('[step 2] checkpoint restored: state.json written');
    const kinds: NoticeKind[] = ['offline', 'online', 'checkpoint:degraded', 'checkpoint:restored', 'sandbox', 'drift', 'seeded', 'instructions', 'config', 'pricing', 'lock'];
    for (const k of kinds) expect(BARE_NOTICE_KINDS.has(k), k).toBe(true);
    expect(BARE_NOTICE_KINDS.has('ui')).toBe(false);
  });

  it('`notice <kind>: <text>` stays the fallback for a kind that does not describe itself (an unlabelled ui, or one from a newer engine)', () => {
    expect(line({ type: 'notice', step: 1, kind: 'ui', level: 'info', text: 'something' })).toBe('[step 1] notice ui: something');
    expect(line({ type: 'notice', step: null, kind: 'future-kind' as NoticeKind, level: 'info', text: 'x' })).toBe('[run] notice future-kind: x');
  });
});

describe('createReadlineConfirmer: interactive (TUI-DESIGN §1 C46: --no-input / CI / TERM=dumb on a TTY)', () => {
  it('TTY stdin + interactive: false declines after confirmTimeoutMs, reads nothing and names itself non-interactive', async () => {
    const stdin = ttyInput() as PassThrough & { isTTY?: boolean };
    const out = new Sink();
    const c = createReadlineConfirmer(stdin, out, { onAbort: () => undefined, confirmTimeoutMs: 5, interactive: false });
    expect(c.identity).toBe(IDENTITY_NO_INPUT);
    const p = c.confirmDetailed(mkConfirmRequest('c1', 2), { signal: new AbortController().signal });
    stdin.write('y\n');
    await expect(p).resolves.toEqual({ approved: false });
    expect(stdin.listenerCount('data')).toBe(0);
    expect(out.text).toContain(`[step 2] confirm c1 declined: ${IDENTITY_NO_INPUT}`);
    expect(out.text).not.toContain(READLINE_CONFIRM_KEYS);
    // interactive: true on a pipe asks (the caller decided), the default follows isTTY
    expect(createReadlineConfirmer(new PassThrough() as ConfirmInput, new Sink(), { onAbort: () => undefined, interactive: true }).identity).toBe(IDENTITY_REVIEWER);
    expect(createReadlineConfirmer(new PassThrough() as ConfirmInput, new Sink(), { onAbort: () => undefined }).identity).toBe(IDENTITY_NO_TTY);
    expect(createReadlineConfirmer(ttyInput(), new Sink(), { onAbort: () => undefined }).identity).toBe(IDENTITY_REVIEWER);
  });

  it('createPlainRenderer({ interactive: false }) threads the flag to its confirmer', async () => {
    const stdin = ttyInput();
    const out = new Sink();
    const r = createPlainRenderer({ task: 't', resumeId: null, onAbort: () => undefined, interactive: false, confirmTimeoutMs: 1, stdout: out as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream });
    await r.firstFrame();
    expect(r.confirmer.identity).toBe(IDENTITY_NO_INPUT);
    await expect(r.confirmer.confirm(mkConfirmRequest('c1', 1), { signal: new AbortController().signal })).resolves.toBe(false);
    expect((stdin as PassThrough).listenerCount('data')).toBe(0);
  });
});

describe('createPlainRenderer: the §14.1 glyph twin on stdout (--ascii)', () => {
  const launch = (ascii: boolean): LaunchSettings => ({ fps: 30, renderMode: 'standard', screenReader: false, ascii, noColor: false, reducedMotion: false });
  const git: RunGitMeta = { repo: true, head: { kind: 'branch', name: 'main', oid: 'abcdef0123456789' }, upstream: 'origin/main', ahead: 2, behind: 1, linkedWorktree: false, prefix: '', dirtyAtStart: { modified: 3, staged: 0, untracked: 0 } };
  const ws: EngineEvent = { type: 'workspace', git, instructions: [], sandbox: 'seatbelt' };

  it('launch.ascii substitutes the table on every stdout line (header, items, local items) while itemsFromEvent stays Unicode', async () => {
    const out = new Sink();
    const r = createPlainRenderer({ task: 't', resumeId: null, onAbort: () => undefined, launch: launch(true), stdout: out as unknown as NodeJS.WriteStream, stdin: new PassThrough() as unknown as NodeJS.ReadStream });
    await r.firstFrame();
    expect(r.glyphs.mode).toBe('ascii');
    expect(out.text).toBe('[run] jevcode task: t | step 0/- starting\n');
    r.notify('recent: "tz fixes" · 2h ago  (Enter continues, /resume browses)');
    const fe = fakeEngine();
    r.attach(fe.engine);
    fe.emit(ws);
    fe.emit({ type: 'notice', step: null, kind: 'drift', level: 'warn', text: 'resumed on 91ab3c4d, run started on abcdef01 — the plan may not apply' });
    await r.unmount();
    const lines = out.text.split('\n');
    expect(lines[1]).toBe('[ui] recent: "tz fixes" - 2h ago  (Enter continues, /resume browses)');
    expect(lines[2]).toBe('[run] git main ^2 v1 - 3 modified');
    expect(lines[3]).toBe('[run] resumed on 91ab3c4d, run started on abcdef01 - the plan may not apply');
    for (const l of lines) expect(l).toMatch(/^[\x20-\x7e]*$/);
    // the item model (and so transcript.log) is untouched
    expect(itemsFromEvent(ws, 0)[0]!.text).toBe('git main ↑2 ↓1 · 3 modified');
    expect(glyphTwin(formatTranscriptItem(itemsFromEvent(ws, 0)[0]!), glyphSet({ ascii: true }))).toBe(lines[2]);
  });

  it('the default (unicode) leaves every line canonical; the readline confirmer writes its rows through the same table', async () => {
    const out = new Sink();
    const r = createPlainRenderer({ task: 't', resumeId: null, onAbort: () => undefined, launch: launch(false), stdout: out as unknown as NodeJS.WriteStream, stdin: new PassThrough() as unknown as NodeJS.ReadStream });
    await r.firstFrame();
    expect(r.glyphs.mode).toBe('unicode');
    const fe = fakeEngine();
    r.attach(fe.engine);
    fe.emit(ws);
    await r.unmount();
    expect(out.text.split('\n')[1]).toBe('[run] git main ↑2 ↓1 · 3 modified');

    const stdin = ttyInput();
    const asciiOut = new Sink();
    const ra = createPlainRenderer({ task: 't', resumeId: null, onAbort: () => undefined, launch: launch(true), stdout: asciiOut as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream });
    await ra.firstFrame();
    const p = ra.confirmer.confirmDetailed!(mkConfirmRequest('c1', 3), { signal: new AbortController().signal });
    await tick();
    // row 8 `5 matches_intent  —  not judged this step` → `-`; the note prompt's `≤` → `<=`
    expect(asciiOut.text).toContain('[step 3] 5 matches_intent  -  not judged this step');
    (stdin as PassThrough).write('d\n');
    await tick();
    expect(asciiOut.text).toContain('[step 3] note (<= 600, Enter sends, empty cancels): ');
    (stdin as PassThrough).write('fine\n');
    await expect(p).resolves.toEqual({ approved: false, note: 'fine' });
    expect(asciiOut.text).toMatch(/^[\x20-\x7e\n]*$/);
  });
});

describe('createReadlineConfirmer: the invalid-answer counter (§6.5) and abort races', () => {
  const signal = (): AbortSignal => new AbortController().signal;

  it('four cancelled notes then y still approve; a cancelled gate does not count either; five genuinely invalid answers decline', async () => {
    const stdin = ttyInput() as PassThrough;
    const out = new Sink();
    const c = createReadlineConfirmer(stdin, out, { onAbort: () => undefined });
    const p = c.confirmDetailed(mkConfirmRequest('c1', 3), { signal: signal() });
    await tick();
    for (let i = 0; i < 4; i += 1) {
      stdin.write('d\n');
      await tick();
      stdin.write('\n');
      await tick();
    }
    // a gate cancel (note with a secret, then `n`) is not an invalid answer either
    stdin.write('d key sk-ant-api03-SECRETSECRETSECRETSECRETSECRET leaked\n');
    await tick();
    stdin.write('n\n');
    await tick();
    stdin.write('maybe\n');
    await tick();
    stdin.write('y\n');
    await expect(p).resolves.toEqual({ approved: true });
    expect(out.text).not.toContain('no valid answer');

    const p2 = c.confirmDetailed(mkConfirmRequest('c2', 4), { signal: signal() });
    await tick();
    for (let i = 0; i < READLINE_MAX_PROMPTS; i += 1) {
      stdin.write('what\n');
      await tick();
    }
    await expect(p2).resolves.toEqual({ approved: false });
    expect(out.text).toContain(`[step 4] confirm c2 declined: no valid answer after ${READLINE_MAX_PROMPTS} prompts`);
    expect(out.text.split(`[step 4] ${READLINE_CONFIRM_KEYS} > `)).toHaveLength(READLINE_MAX_PROMPTS + 1);
  });

  it('an abort while the note or the gate is pending rejects with AbortError and never approves; the same confirmer keeps working afterwards', async () => {
    const stdin = ttyInput() as PassThrough;
    const out = new Sink();
    const c = createReadlineConfirmer(stdin, out, { onAbort: () => undefined });
    const ac1 = new AbortController();
    const p1 = c.confirmDetailed(mkConfirmRequest('c1', 1), { signal: ac1.signal });
    await tick();
    stdin.write('d\n');
    await tick();
    ac1.abort(new AbortError('signal'));
    await expect(p1).rejects.toBeInstanceOf(AbortError);
    // a late `y` for the aborted review is ignored, not applied to anything
    stdin.write('y\n');
    await tick();
    const ac2 = new AbortController();
    const p2 = c.confirmDetailed(mkConfirmRequest('c2', 2), { signal: ac2.signal });
    await tick();
    stdin.write('d key sk-ant-api03-SECRETSECRETSECRETSECRETSECRET leaked\n');
    await tick();
    expect(out.text).toContain('[step 2] jevcode: looks like this contains a secret');
    ac2.abort(new AbortError('signal'));
    await expect(p2).rejects.toBeInstanceOf(AbortError);
    // one interface per stdin: the confirmer never closed it, so the next review still reads
    const p3 = c.confirmDetailed(mkConfirmRequest('c3', 3), { signal: signal() });
    await tick();
    stdin.write('y\n');
    await expect(p3).resolves.toEqual({ approved: true });
    expect(stdin.isPaused()).toBe(false);
    // EOF: a pending review declines, and a later review declines at once
    const p4 = c.confirmDetailed(mkConfirmRequest('c4', 4), { signal: signal() });
    stdin.end();
    await expect(p4).resolves.toEqual({ approved: false });
    await expect(c.confirmDetailed(mkConfirmRequest('c5', 5), { signal: signal() })).resolves.toEqual({ approved: false });
    expect(out.text).toContain('[step 5] confirm c5 declined: stdin closed');
  });
});

describe('the three-writer identity (TUI-DESIGN §15.1, §15.3, §19.1)', () => {
  it('transcript.log, --plain and the TUI <Static> formatter agree line for line over a real run; idle local items are in --plain only', async () => {
    const h = await makeEngine({ turns: [turn({ kind: 'read', paths: ['src/a.py'] }), turn({ kind: 'done', summary: 'nothing else to do' })], limits: { maxSteps: 2 } });
    try {
      const out = new Sink();
      const r = createPlainRenderer({ task: 'Fix f() in src/a.py', resumeId: null, onAbort: () => undefined, stdout: out as unknown as NodeJS.WriteStream, stdin: new PassThrough() as unknown as NodeJS.ReadStream });
      await r.firstFrame();
      const recent = 'recent: "tz fixes" · 2h ago  (Enter continues, /resume browses)';
      r.notify(recent);
      r.attach(h.engine);
      h.engine.events.on('run:ready', () => {
        // renderer-originated line while live (annotate) and a human steer: both ride the engine's transcript. Deferred to
        // a microtask: a synchronous emit from inside a listener re-enters `emit()`, and listeners registered later see the
        // inner event first — a real controller acts from the composer, never from inside an engine listener.
        queueMicrotask(() => {
          expect(h.engine.annotate('budget: session cap $10 → $15 (applies now)', { label: '[ui]' })).toBe(true);
          expect(h.engine.steer('also update the docs').ok).toBe(true);
        });
      });
      await h.engine.run();
      r.notify('session 20260920-1 ended: 1 run, $0.010 total', { label: '[ui]' });
      await r.unmount();

      const transcript = h.store.transcript;
      expect(transcript.length).toBeGreaterThan(5);
      expect(transcript).toContain('[ui] budget: session cap $10 → $15 (applies now)');
      expect(transcript.some((l) => /^\[step \d+\] steer queued · step \d+ · "also update the docs" · 1 waiting$/.test(l))).toBe(true);
      expect(transcript.some((l) => /^\[run\] git · no repository — changes are not recoverable/.test(l))).toBe(true);

      // the TUI twin: Transcript.tsx renders formatTranscriptItem(item) for every item the reducer built from the same events
      let seq = 0;
      const tui: string[] = [];
      for (const e of h.events) {
        const items = itemsFromEvent(e, seq);
        seq += items.length;
        tui.push(...items.map(formatTranscriptItem));
      }
      expect(tui).toEqual(transcript);

      // the --plain twin: header, the idle local item, then the run (stream text and items in event order), then the idle epilogue
      const expected: string[] = [plainFirstLine('Fix f() in src/a.py', null), `[ui] ${recent}`];
      let stream = '';
      let open = false;
      for (const e of h.events) {
        if (e.type === 'generator:delta') {
          const t = sanitizeStream(e.text);
          if (t.length === 0) continue;
          stream += t;
          open = !t.endsWith('\n');
          continue;
        }
        const items = itemsFromEvent(e, 0);
        if (items.length === 0) continue;
        if (stream !== '') {
          expected.push(...(open ? stream : stream.slice(0, -1)).split('\n'));
          stream = '';
          open = false;
        }
        expected.push(...items.map(formatTranscriptItem));
      }
      expected.push('[ui] session 20260920-1 ended: 1 run, $0.010 total');
      const plain = out.text.split('\n');
      expect(plain.at(-1)).toBe('');
      expect(plain.slice(0, -1)).toEqual(expected);
      // every transcript.log line is in --plain, in order; the local items are in --plain only
      const plainItems = plain.filter((l) => transcript.includes(l));
      expect(plainItems).toEqual(transcript);
      expect(transcript.some((l) => l.includes('recent:') || l.includes('ended:'))).toBe(false);
      expect(plain).toContain(`[ui] ${recent}`);
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------------------
// TUI-DESIGN-2 §4.5 / §3.10 / §6 item 17 (S3): the `step` summary line and the `chat` bubbles in every sink
// ---------------------------------------------------------------------------------------
describe('TUI-DESIGN-2 §4.5: stepSummaryText and the `step` item (one line per step in all three sinks)', () => {
  const risk = (r: number, verdict: 'ok' | 'review' | 'block') => ({ dims: {} as never, risk: r, verdict, reason: '' });
  const judge = (succeeded: number, tests: JudgeResult['tests'] = null) => ({ succeeded, errorPresent: 0.1, newInfo: 0.1, tests, doneClaims: [] });

  it('full form: `<action> · risk <r> <verdict> · <outcome> · tests <p>p/<f>f/<e>e · judge <p>[ · complete <c>] · <wall> · $<cost>`', () => {
    const r = makeStepRecord(4, {
      proposal: makeProposal({ goal: 'guard k > len', action: { kind: 'edit', path: 'kth.py', old: 'a', new: 'b' } }),
      risk: risk(0.12, 'ok'),
      outcome: { status: 'executed', summary: 'edited', changedFiles: ['kth.py'] },
      judge: judge(0.89, { source: 'parsed', allPassed: true, passed: 41, failed: 0, errors: 0 }),
      completion: 0.93,
      timing: { generatorMs: 0, jevMs: 0, execMs: 0, harnessMs: 0, totalMs: 1234 },
    });
    // §6.6: the outcome segment gains the churn (`1 file +1 −1`) and the `/diff <N>` pointer is the LAST segment
    expect(stepSummaryText(r, { generator: 0.003, jev: 0.001 })).toBe('edit kth.py "guard k > len" · risk 0.12 ok · 1 file +1 −1 · tests 41p/0f/0e · judge 0.89 · complete 0.93 · 1.2s · $0.004 · /diff 4');
    const item = itemsFromEvent({ type: 'step:end', record: r, costUsd: { generator: 0.003, jev: 0.001 } }, 5)[0]!;
    expect(item).toMatchObject({ kind: 'step', step: 4, key: '4:step:5', level: 'info' });
    expect(formatTranscriptItem(item)).toBe('[step 4] edit kth.py "guard k > len" · risk 0.12 ok · 1 file +1 −1 · tests 41p/0f/0e · judge 0.89 · complete 0.93 · 1.2s · $0.004 · /diff 4');
  });

  it('verdict words, outcomes, the completion cut, the four-decimal cost below $0.001 and the token form without cost (jev-only `jev 1.4k`, else `gen … jev …`)', () => {
    const base = makeStepRecord(2, { risk: risk(0.44, 'review'), outcome: { status: 'declined', reason: 'no' }, judge: judge(0.5), completion: 0.3, timing: { generatorMs: 0, jevMs: 0, execMs: 0, harnessMs: 0, totalMs: 12_000 }, usage: { generator: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, jev: { inputTokens: 1300, outputTokens: 100, costUsd: 0, calls: 3 } } });
    expect(stepSummaryText(base)).toBe('run $ pytest -q · risk 0.44 [review] · declined · judge 0.50 · 12s · jev 1.4k');
    expect(stepSummaryText({ ...base, risk: risk(0.81, 'block'), outcome: { status: 'blocked', reason: 'x' } }, { generator: 0, jev: 0.0004 })).toBe('run $ pytest -q · risk 0.81 [block] · blocked · judge 0.50 · 12s · $0.0004');
    expect(stepSummaryText({ ...base, outcome: { status: 'noop', summary: 'done' }, usage: { generator: { inputTokens: 5000, outputTokens: 400, costUsd: 0, calls: 1 }, jev: { inputTokens: 1300, outputTokens: 100, costUsd: 0, calls: 3 } } })).toBe('run $ pytest -q · risk 0.44 [review] · skipped · judge 0.50 · 12s · gen 5.4k jev 1.4k');
    expect(stepSummaryText({ ...base, outcome: { status: 'executed', summary: 'ran', changedFiles: [] }, timing: { ...base.timing, totalMs: 62_000 } })).toBe('run $ pytest -q · risk 0.44 [review] · judge 0.50 · 1m2s · jev 1.4k');
    // the completion clause follows the threshold (default 0.85; overridable)
    expect(stepSummaryText({ ...base, completion: 0.86 })).toContain(' · complete 0.86 · ');
    expect(stepSummaryText({ ...base, completion: 0.86 }, undefined, { completeThreshold: 0.9 })).not.toContain('complete');
    // action target ≤ 40 cells, goal only for edit/write/patch and ≤ 32 chars, `done <summary>`
    const long = makeStepRecord(1, { proposal: makeProposal({ goal: 'g'.repeat(80), action: { kind: 'write', path: `${'p'.repeat(60)}.py`, content: '' } }), risk: null, outcome: null, judge: null });
    const text = stepSummaryText(long);
    expect(text.startsWith(`write ${'p'.repeat(39)}… "${'g'.repeat(31)}…" · `)).toBe(true);
    expect(stepSummaryText(makeStepRecord(1, { proposal: makeProposal({ goal: 'finish', action: { kind: 'done', summary: 'all tests pass now' } }), risk: null, outcome: { status: 'noop', summary: 'done' }, judge: null }))).toBe('done all tests pass now · skipped · 0.0s · jev 0');
    expect(stepSummaryText(makeStepRecord(1, { proposal: makeProposal({ action: { kind: 'read', paths: ['tests/test_kth.py', 'kth.py'] } }), risk: null, outcome: null, judge: null }))).toBe('read tests/test_kth.py, kth.py · 0.0s · jev 0');
    expect(stepSummaryText(makeStepRecord(1, { proposal: null, intent: 'edit', risk: null, outcome: null, judge: null }))).toBe('edit (no proposal) · 0.0s · jev 0');
  });

  it('an interrupted step reads `interrupted at <stage> (<reason>)`', () => {
    const r = makeStepRecord(3, { interruptedAt: { stage: 'intent', reason: 'human_abort' } });
    expect(stepSummaryText(r)).toBe('interrupted at intent (human_abort)');
    expect(formatTranscriptItem(itemsFromEvent({ type: 'step:end', record: r }, 0)[0]!)).toBe('[step 3] interrupted at intent (human_abort)');
  });

  it('the compact filter set names the stage kinds and run:ready; `step`, `chat`, `run:start`, `run:end` stay visible', () => {
    for (const k of ['intent', 'context', 'synth', 'proposal', 'risk', 'outcome', 'judge', 'plan', 'run:ready'] as const) expect(COMPACT_HIDDEN_KINDS.has(k), k).toBe(true);
    for (const k of ['step', 'chat', 'run:start', 'run:end', 'confirm:resolved', 'error', 'ui', 'notice', 'budget'] as const) expect(COMPACT_HIDDEN_KINDS.has(k), k).toBe(false);
  });
});

describe('TUI-DESIGN-2 §3.10: [you] / [jevcode] items are kind `chat` in every sink', () => {
  it('localItem with a bubble label → kind chat; other labels stay ui; formatTranscriptItem prints `[you] hi`', () => {
    const you = localItem('hi', 0, { label: '[you]' });
    expect(you).toMatchObject({ kind: 'chat', local: true, label: '[you]', key: 'local:[you]:0' });
    expect(formatTranscriptItem(you)).toBe('[you] hi');
    expect(localItem("Hi. I'm ready when you are", 1, { label: '[jevcode]' })).toMatchObject({ kind: 'chat', label: '[jevcode]' });
    expect(localItem('x', 2, { label: '[config]' }).kind).toBe('ui');
    expect(localItem('x', 3).kind).toBe('ui');
    expect(isChatLabel('[you]') && isChatLabel('[jevcode]') && !isChatLabel('[ui]') && !isChatLabel(undefined)).toBe(true);
  });

  it('a live annotate() with a bubble label is a chat item too; the plain renderer prints the same row for an idle bubble', async () => {
    const live = itemsFromEvent({ type: 'notice', step: null, kind: 'ui', level: 'info', text: 'hi', label: '[you]' }, 4)[0]!;
    expect(live).toMatchObject({ kind: 'chat', label: '[you]', key: 'run:chat:4' });
    expect(formatTranscriptItem(live)).toBe('[you] hi');
    const out = new Sink();
    const r = createPlainRenderer({ task: 'chat', resumeId: null, onAbort: () => undefined, stdout: out as unknown as NodeJS.WriteStream, stdin: new PassThrough() as unknown as NodeJS.ReadStream });
    await r.firstFrame();
    r.notify('hi', { label: '[you]' });
    r.notify("Hi. I'm ready when you are — describe a change you want in proj, or ask what I can do.", { label: '[jevcode]' });
    await r.unmount();
    const lines = out.text.split('\n');
    expect(lines).toContain('[you] hi');
    expect(lines).toContain("[jevcode] Hi. I'm ready when you are — describe a change you want in proj, or ask what I can do.");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// TUI-DESIGN-4 §3.7 "Guard against R2": every `[run]` anchor `src/perf/**`, `test/pty/**` and `scripts/pty/**` need
// is an exported NAMED constant here, glyph-agnostic, with a self-test over real round-4 item text in BOTH glyph
// sets — a zero match is a hard failure, never a vacuous pass (today `polish-check.mjs:399` reports V17 as success
// with `no run ended in this capture` when its anchor misses, which is exactly the R2 failure mode).
// ---------------------------------------------------------------------------------------------------------------

describe('§3.7: the exported run-frame anchors match in both glyph sets', () => {
  const started = formatTranscriptItem(itemsFromEvent({ type: 'run:start', runId: '20260922-120000-ab12cd34', mode: 'jev-on', resumedFromStep: null, task: 'fix the failing test' }, 0)[0]!);
  const end = loadRunEvents().at(-1)!;
  const finished = formatTranscriptItem(itemsFromEvent(end, 0)[0]!);

  it('the round-4 rows they anchor on are what the formatter produces', () => {
    expect(started).toBe('[run] started · jev+llm · fix the failing test');
    expect(finished).toMatch(/^\[run\] finished · max_steps · 2 steps · /);
    expect(RUN_STARTED_WORD).toBe('started');
    expect(RUN_FINISHED_WORD).toBe('finished');
  });

  for (const [name, g] of [
    ['unicode', glyphSet({})],
    ['ascii', glyphSet({ ascii: true })],
  ] as const) {
    it(`${name}: RUN_STARTED_RE / RUN_END_RE / END_PATTERN / RUN_STARTED_PATTERN all match, none vacuously`, () => {
      const s = glyphTwin(started, g);
      const f = glyphTwin(finished, g);
      expect(RUN_STARTED_RE.test(s)).toBe(true);
      expect(RUN_END_RE.test(f)).toBe(true);
      // the perf constants are strings the callers wrap in `new RegExp`
      expect(new RegExp(RUN_END_PATTERN).test(f)).toBe(true);
      expect(new RegExp(`\\[run\\] ${RUN_STARTED_TAIL_PATTERN}`).test(s)).toBe(true);
      // and they do NOT match the other row, so a stale window cannot silently become the whole capture (R2)
      expect(RUN_END_RE.test(s)).toBe(false);
      expect(RUN_STARTED_RE.test(f)).toBe(false);
      // the round-3 leading-space form `polish-check.mjs` sees in a capture (≤ 9 cells of gutter)
      expect(RUN_STARTED_RE.test(`    ${s}`)).toBe(true);
      expect(RUN_END_RE.test(`    ${f}`)).toBe(true);
    });
  }

  it('the old round-3 anchors no longer match, so nothing can pass on a stale pattern', () => {
    expect(/^ {0,9}\[run\] end /.test(finished)).toBe(false);
    expect(new RegExp('end [a-z_]+ steps=').test(finished)).toBe(false);
    expect(new RegExp('\\[run\\] start ').test(started)).toBe(false);
  });

  // §14.2 review item 5: the error clause used to sit between the stop reason and the step count, so the very
  // constant `src/perf/pty.ts:800` and `render-lag.ts:386` import stopped matching for exactly the runs that end
  // badly — and `render-lag.ts` does `capture.search(new RegExp(END_PATTERN))`, so a silent non-match turns the
  // lag window into the whole capture and the gate into a lie. That is R2.
  const errored = formatTranscriptItem(
    itemsFromEvent(
      {
        type: 'run:end',
        exitCode: 1,
        result: {
          ...(loadRunEvents().at(-1) as Extract<EngineEvent, { type: 'run:end' }>).result,
          stopReason: 'error',
          error: { name: 'ProviderError', code: 'PROVIDER_HTTP', message: 'connection reset by peer', exitCode: 1 },
        },
      },
      0,
    )[0]!,
  );

  it('a run that ended with an error still matches every anchor, in both glyph sets (item 5)', () => {
    expect(errored).toBe('[run] finished · error · 2 steps · 9s · $0.010 (generator $0.010 · jev $0.000) · exit 1 · PROVIDER_HTTP: connection reset by peer');
    for (const g of [glyphSet({}), glyphSet({ ascii: true })]) {
      const f = glyphTwin(errored, g);
      expect(RUN_END_RE.test(f)).toBe(true);
      expect(new RegExp(RUN_END_PATTERN).test(f)).toBe(true);
      expect(RUN_END_RE.test(`    ${f}`)).toBe(true);
    }
    // the diagnosis is the LAST segment, after `exit <n>` — §12's `run:end` string has no error clause before it
    expect(errored.indexOf('exit 1')).toBeLessThan(errored.indexOf('PROVIDER_HTTP'));
  });

  it('the `llm-jev` badge does not smuggle a second ` · ` into the run-frame row (item 18)', () => {
    const row = formatTranscriptItem(itemsFromEvent({ type: 'run:start', runId: 'r1', mode: 'llm-jev', resumedFromStep: null, task: 'fix the failing test' }, 0)[0]!);
    // the console's own badge is `llm+jev · verified`; the ROW's grammar says ` · ` is the one inline separator
    expect(MODE_BADGE_WORD['llm-jev']).toBe('llm+jev · verified');
    expect(row).toBe('[run] started · llm+jev verified · fix the failing test');
    expect(row.split(' · ')).toHaveLength(3);
    expect(RUN_STARTED_RE.test(row)).toBe(true);
    // every other mode is byte-unchanged
    for (const [mode, badge] of [
      ['jev-on', 'jev+llm'],
      ['jev-only', 'jev-only'],
      ['jev-off', 'llm-only'],
    ] as const) {
      expect(formatTranscriptItem(itemsFromEvent({ type: 'run:start', runId: 'r1', mode, resumedFromStep: null, task: 't' }, 0)[0]!)).toBe(`[run] started · ${badge} · t`);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// TUI-DESIGN-4 §14.2 review item 13: `plain.ts` is the ONE item formatter and is on every sink's first-frame path
// (`--plain`'s included), so what it drags in behind one function is a product fact, not a style question. The
// pure line diff moved to `src/tui/diff/text.ts`, which imports **nothing at all**; `src/undo/diff.ts` — which
// opens files and spawns `git` — is out of the graph. The remaining `node:fs*` / `node:child_process` importers
// are a DECLARED allowlist: each is named with the round-4 requirement that puts it there, so a new one is a
// visible failure rather than a silent regression.
// ---------------------------------------------------------------------------------------------------------------

describe('§14.2 item 13: the item formatter\'s static import graph', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const rel = (f: string): string => f.slice(root.length);

  /** Value imports only (`import type` is erased), resolved the way Node resolves this project's ESM. */
  const graph = (entry: string): { files: Set<string>; builtins: Map<string, Set<string>> } => {
    const files = new Set<string>();
    const builtins = new Map<string, Set<string>>();
    const visit = (f: string): void => {
      if (files.has(f)) return;
      files.add(f);
      const src = readFileSync(f, 'utf8');
      const re = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)([^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
      let m = re.exec(src);
      while (m !== null) {
        const spec = m[2] ?? '';
        if (spec.startsWith('node:')) {
          const who = builtins.get(spec) ?? new Set<string>();
          who.add(rel(f));
          builtins.set(spec, who);
        } else if (spec.startsWith('.')) {
          const base = resolvePath(dirname(f), spec).replace(/\.js$/, '');
          for (const ext of ['.ts', '.tsx', '/index.ts']) {
            if (existsSync(base + ext)) {
              visit(base + ext);
              break;
            }
          }
        }
        m = re.exec(src);
      }
    };
    visit(entry);
    return { files, builtins };
  };

  it('`src/tui/diff/text.ts` imports nothing, and `summary.ts` reaches no Node built-in through it', () => {
    const text = graph(`${root}src/tui/diff/text.ts`);
    expect([...text.files].map(rel)).toEqual(['src/tui/diff/text.ts']);
    expect([...text.builtins.keys()]).toEqual([]);
  });

  it('`plain.ts` no longer pulls `src/undo/diff.ts` (and therefore `checkpoint/images.ts` and `workspace/git.ts` behind it)', () => {
    const { files } = graph(`${root}src/tui/plain.ts`);
    const names = [...files].map(rel);
    expect(names).not.toContain('src/undo/diff.ts');
    expect(names.filter((n) => n.startsWith('src/checkpoint/'))).toEqual(['src/checkpoint/store.ts']); // S6's blocking/lines.ts
    expect(names).not.toContain('src/loop/engine.ts');
    expect(names).toContain('src/tui/diff/text.ts');
  });

  it('every `node:fs*` / `node:child_process` importer in the graph is on the declared allowlist', () => {
    const { builtins } = graph(`${root}src/tui/plain.ts`);
    const heavy = new Set<string>();
    for (const [spec, who] of builtins) if (spec.startsWith('node:fs') || spec === 'node:child_process') for (const w of who) heavy.add(w);
    expect([...heavy].sort()).toEqual([
      // §3.6 G6: `gitBannerLine` is an item text, so the formatter must reach it (it spawns nothing at import time)
      'src/checkpoint/store.ts',
      // §6.3 edge 8: `isSecretPath`, purely lexical (sandbox/paths.ts:120–135 — "safe to run over a 5,000-entry listing")
      'src/core/atomic.ts',
      // `src/orchestrate/{land,manifest,worktree}.ts` were here while `src/jev-modes/stages/risk.ts` — which
      // `src/tui/review/lines.ts` needs for `buildRiskQuestions` / `riskLevelTexts` — imported `ownsPath` /
      // `parseOwnGlob` from the orchestrate BARREL, which re-exports those three `node:fs` / `child_process`
      // importers. The harness session (OOS iteration 2) now imports the leaf `src/orchestrate/split/globs.ts`
      // instead, whose only import is `core/limits.js`, so the three rows are gone and the guard is tighter.
      'src/sandbox/paths.ts',
      'src/workspace/gitstate.ts',
    ]);
  });
});
