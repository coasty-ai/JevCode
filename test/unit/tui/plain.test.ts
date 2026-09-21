import { PassThrough } from 'node:stream';
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
  clipDetail,
  confirmHeaderLines,
  confirmPreviewLines,
  createPlainRenderer,
  createReadlineConfirmer,
  formatTranscriptItem,
  headerItem,
  isChatLabel,
  itemsFromEvent,
  localItem,
  normaliseNote,
  oneLine,
  plainFirstLine,
  retrySettledText,
  sanitizeStream,
  sessionHeaderItem,
  stepSummaryText,
  type ConfirmInput,
  type NoteGate,
} from '../../../src/tui/plain.js';
import { REVIEW_KEYS_80, reviewHeaderLines } from '../../../src/tui/review/lines.js';
import { cellWidth, glyphSet, glyphTwin } from '../../../src/tui/glyphs.js';
import { makeEngine, turn } from '../loop/fakes.js';
import { budgetItems } from '../../../src/tui/budget/lines.js';
import { gitBannerLine, headDriftWarning } from '../../../src/workspace/gitstate.js';
import { AbortError } from '../../../src/errors.js';
import type { EngineEvent, JudgeResult, LaunchSettings, NoticeKind, RunGitMeta, SecretHit, SessionHost } from '../../../src/core/types.js';
import { makeProposal, makeStepRecord } from '../../fixtures/checkpoint/make.js';
import { fakeEngine, loadRunEvents, mkConfirmRequest, tick } from '../../fixtures/tui/fixtures.js';
// TUI-DESIGN-2 §3.7 / §6 item 11: the --plain twin of Renderer.restoreDraft
import { intakeKeptEcho } from '../../../src/tui/plain.js';

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

  it('formats the documented line shapes', () => {
    const intent = itemsFromEvent({ type: 'intent', step: 3, intent: 'edit', answer: 'edit', probability: 0.82, confidence: 0.71 }, 0)[0]!;
    expect(formatTranscriptItem(intent)).toBe('[step 3] intent=edit p=0.82 c=0.71');
    const fallback = itemsFromEvent({ type: 'intent', step: 3, intent: 'investigate', answer: 'none_of_these', probability: 0.4, confidence: 0.1 }, 0)[0]!;
    expect(formatTranscriptItem(fallback)).toBe('[step 3] intent=investigate p=0.40 c=0.10 (jev answered none_of_these)');
    const risk = itemsFromEvent(loadRunEvents().find((e) => e.type === 'risk' && e.step === 2)!, 7)[0]!;
    expect(formatTranscriptItem(risk)).toBe('[step 2] risk=0.50 review: destructive: level 2 (0.50)');
    expect(risk.verdict).toBe('review');
    const proposal = itemsFromEvent(loadRunEvents().find((e) => e.type === 'proposal' && e.step === 2)!, 9)[0]!;
    expect(formatTranscriptItem(proposal)).toBe('[step 2] proposal edit src/a.py: fix the off-by-one | plan done=1 remaining=2 open=0');
    expect(proposal.detail).toBe('--- old\nrange(n)\n+++ new\nrange(n + 1)');
    const end = itemsFromEvent(loadRunEvents().at(-1)!, 20)[0]!;
    expect(formatTranscriptItem(end)).toBe('[run] end max_steps steps=2 wall=9s cost=$0.010 (gen $0.010, jev $0.000)');
    const resolved = itemsFromEvent({ type: 'confirm:resolved', step: 2, id: 'c-2', approved: false, aborted: false }, 1)[0]!;
    expect(formatTranscriptItem(resolved)).toBe('[step 2] confirm c-2 declined');
    expect(resolved.key).toBe('2:confirm:resolved:1');
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
    expect(item.detail).toBe('echo [2Jhi\nprintf "]0;title"');
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
    expect(out.text).toContain('"paths": ["tests/test_a.py"]}}\n[step 1] proposal read tests/test_a.py');
    // step 2 stream ended with a newline: no blank line is inserted
    expect(out.text).toContain('{"goal": "fix"}\n[step 2] proposal edit');
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
    expect(out.text).toContain('--- old');
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
    expect(formatTranscriptItem(items[0]!)).toBe('[step 2] synth rank: top candidate `return 2` (candidates=12, tested=3)');
    expect(itemsFromEvent({ type: 'synth', step: 1, phase: 'localise', detail: 'src/a.py:2' }, 0)[0]!.text).toBe('synth localise: src/a.py:2');
    expect(itemsFromEvent({ type: 'synth', step: 1, phase: 'p', detail: 'd', tested: 0 }, 0)[0]!.text).toBe('synth p: d (tested=0)');
    expect(itemsFromEvent({ type: 'synth', step: 1, phase: 'p', detail: 'd', candidates: 4 }, 0)[0]!.text).toBe('synth p: d (candidates=4)');
    expect(itemsFromEvent({ type: 'synth', step: 1, phase: 'p', detail: 'a\nb\u001b[2J' }, 0)[0]!.text).toBe('synth p: a ⏎ b[2J');
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
    expect(lines).toContain('[run] start r1 mode=jev-only task: t');
    expect(lines).toContain('[step 1] synth localise: src/a.py:2 (candidates=3)');
    expect(lines).toContain('[step 1] synth select: chose `return 2` (candidates=3, tested=1)');
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
    expect(lines[0]).toBe('review  step 3  risk 0.50 (exp)  edit src/a.py "fix the off-by-one"');
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

  it('steer:queued / steer:applied / steer:withdrawn / pause:requested', () => {
    expect(line({ type: 'steer:queued', step: 8, index: 1, text: 'also update the docs', queued: 1 })).toEqual(['[step 8] steer queued (1) for step 8: also update the docs']);
    expect(itemsFromEvent({ type: 'steer:queued', step: 8, index: 1, text: 'x', queued: 3 }, 4)[0]).toMatchObject({ kind: 'steer:queued', key: '8:steer:queued:4', seq: 4, level: 'info' });
    expect(line({ type: 'steer:applied', step: 8, count: 2, superseded: ['replan: change approach', 'a\nb'] })).toEqual(['[step 8] steer applied to step 8 (2 directives; superseded: "replan: change approach", "a ⏎ b")']);
    expect(line({ type: 'steer:applied', step: 8, count: 1, superseded: [] })).toEqual(['[step 8] steer applied to step 8 (1 directive)']);
    expect(line({ type: 'steer:withdrawn', step: 8, index: 2 })).toEqual(['[step 8] steer withdrawn (2)']);
    expect(line({ type: 'pause:requested', step: 5 })).toEqual(['[step 5] pause requested: stopping after step 5']);
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

  it('retry:settled: one `warning:` line only when the chain failed or lasted > 10 s; `retry` itself is pane-only', () => {
    expect(line({ type: 'retry:settled', side: 'jev', step: 3, attempts: 3, ok: false, totalWaitMs: 41_000 })).toEqual(['[step 3] warning: jev retry chain: 3 attempts over 41s — gave up']);
    expect(line({ type: 'retry:settled', side: 'generator', step: null, attempts: 2, ok: true, totalWaitMs: 12_500 })).toEqual(['[run] warning: generator retry chain: 2 attempts over 12s — recovered']);
    expect(line({ type: 'retry:settled', side: 'jev', step: 3, attempts: 2, ok: true, totalWaitMs: 10_000 })).toEqual([]);
    expect(line({ type: 'retry:settled', side: 'jev', step: 3, attempts: 1, ok: true, totalWaitMs: 0 })).toEqual([]);
    expect(retrySettledText({ type: 'retry:settled', side: 'jev', step: 3, attempts: 1, ok: false, totalWaitMs: 500 })).toBe('warning: jev retry chain: 1 attempt over 500ms — gave up');
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
    expect(line(none)).toEqual(['[run] git none · not a git repository: changes made by commands are not recoverable, /diff compares against step pre-images only']);
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
    expect(line({ type: 'confirm:resolved', step: 2, id: 'c-2', approved: false, aborted: false, note: 'wrong file' })).toEqual(['[step 2] confirm c-2 declined (note: wrong file)']);
    expect(line({ type: 'confirm:resolved', step: 2, id: 'c-2', approved: false, aborted: false })).toEqual(['[step 2] confirm c-2 declined']);
    expect(line({ type: 'confirm:resolved', step: 2, id: 'c-2', approved: true, aborted: false, note: 'ignored on approve?' })).toEqual(['[step 2] confirm c-2 approved (note: ignored on approve?)']);
    const end = loadRunEvents().at(-1)!;
    expect(end.type).toBe('run:end');
    if (end.type !== 'run:end') return;
    expect(line(end)).toEqual(['[run] end max_steps steps=2 wall=9s cost=$0.010 (gen $0.010, jev $0.000)']);
    expect(line({ ...end, exitCode: 4, resumable: true, paths: { runDir: '/r', transcript: '/r/transcript.log', log: '/r/jevcode.log' } })).toEqual(['[run] end max_steps steps=2 wall=9s cost=$0.010 (gen $0.010, jev $0.000) exit 4']);
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

  it('TUI-DESIGN-2 §3.7 / §6 item 11: restoreDraft echoes the kept draft as one bare `(kept: …)` line through the host redactor (never an item), after ending an open stream', async () => {
    const out = new Sink();
    const r = createPlainRenderer({ task: 't', resumeId: null, onAbort: () => undefined, stdout: out as unknown as NodeJS.WriteStream, stdin: new PassThrough() as unknown as NodeJS.ReadStream });
    await r.firstFrame();
    r.setHost(noHost());
    const fe = fakeEngine();
    r.attach(fe.engine);
    fe.emit({ type: 'generator:delta', step: 1, text: 'partial' });
    r.restoreDraft('the date parsing\nkey SECRETVALUE');
    await r.unmount();
    const lines = out.text.split('\n');
    expect(lines).toContain('partial');
    expect(lines).toContain('(kept: the date parsing ⏎ key [REDACTED:h])');
    expect(intakeKeptEcho('x')).toBe('(kept: x)');
    expect(lines.some((l) => l.startsWith('[ui]') && l.includes('kept'))).toBe(false);
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
      expect(transcript.some((l) => /^\[step \d+\] steer queued \(1\) for step \d+: also update the docs$/.test(l))).toBe(true);
      expect(transcript.some((l) => /^\[run\] git none · not a git repository/.test(l))).toBe(true);

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
    expect(stepSummaryText(r, { generator: 0.003, jev: 0.001 })).toBe('edit kth.py "guard k > len" · risk 0.12 ok · 1 file · tests 41p/0f/0e · judge 0.89 · complete 0.93 · 1.2s · $0.004');
    const item = itemsFromEvent({ type: 'step:end', record: r, costUsd: { generator: 0.003, jev: 0.001 } }, 5)[0]!;
    expect(item).toMatchObject({ kind: 'step', step: 4, key: '4:step:5', level: 'info' });
    expect(formatTranscriptItem(item)).toBe('[step 4] edit kth.py "guard k > len" · risk 0.12 ok · 1 file · tests 41p/0f/0e · judge 0.89 · complete 0.93 · 1.2s · $0.004');
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
