import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  HEADER_ITEM_KEY,
  IDENTITY_NO_TTY,
  IDENTITY_REVIEWER,
  clipDetail,
  confirmHeaderLines,
  confirmPreviewLines,
  createPlainRenderer,
  createReadlineConfirmer,
  formatTranscriptItem,
  headerItem,
  itemsFromEvent,
  oneLine,
  plainFirstLine,
  sanitizeStream,
  type ConfirmInput,
} from '../../../src/tui/plain.js';
import { AbortError } from '../../../src/errors.js';
import type { EngineEvent } from '../../../src/core/types.js';
import { fakeEngine, loadRunEvents, mkConfirmRequest, tick } from '../../fixtures/tui/fixtures.js';

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
    for (const line of confirmHeaderLines(mkConfirmRequest('c1', 3)).slice(0, 5)) expect(out.text).toContain(`[step 3] ${line}`);
    expect(out.text).toContain('--- old');
    expect(out.text).toContain('[step 3] [y] approve  [n] decline > ');
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
