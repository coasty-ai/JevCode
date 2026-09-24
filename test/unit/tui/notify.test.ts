/**
 * TUI-DESIGN §19.0 (`notify.test.ts`, §14.1, C48): BEL / OSC 9 / OSC 99 / the tmux DCS passthrough (doubled ESC),
 * the payload never starting `<digit>;`, redaction and control stripping, the terminal table, and the timers —
 * the review timer starts when the deferred box appears, restarts on keystrokes, fires at ~6 s; the run-end timer
 * starts at run:end, is cancelled by any keystroke, fires at ~60 s; budget fires at once; default off, on in SR.
 */
import { describe, expect, it } from 'vitest';
import { BEL, REVIEW_NOTIFY_MS, RUN_END_NOTIFY_MS, createNotifier, createNotifyTimers, detectNotifyMethod, insideTmux, notifyPayload, notifySequence, tmuxPassthrough, type NotifyKind } from '../../../src/tui/notify.js';

describe('sequences and payloads (§14.1)', () => {
  it('BEL, OSC 9, OSC 99, and the tmux wrapper with every ESC doubled', () => {
    expect(notifySequence('bel', 'x')).toBe(BEL);
    expect(notifySequence('osc9', 'review pending')).toBe('\x1b]9;review pending\x07');
    expect(notifySequence('osc99', 'review pending')).toBe('\x1b]99;;review pending\x1b\\');
    expect(notifySequence('osc99', 'r', { tmux: true })).toBe('\x1bPtmux;\x1b\x1b]99;;r\x1b\x1b\\\x1b\\');
    expect(tmuxPassthrough('\x1b]9;a\x07')).toBe('\x1bPtmux;\x1b\x1b]9;a\x07\x1b\\');
    expect(notifySequence('bel', 'x', { tmux: true })).toBe(BEL);
  });

  it('the payload is redacted, one line, control-free, ≤ 200 chars and never starts `<digit>;`', () => {
    expect(notifyPayload('1;evil')).toBe('jevcode: 1;evil');
    expect(notifyPayload('42;also')).toBe('jevcode: 42;also');
    expect(notifyPayload('a\nb\tc\x1b[2Jd')).toBe('a b c[2Jd');
    expect(notifyPayload('x'.repeat(300))).toHaveLength(200);
    expect(notifyPayload('key sk-ant-abc', (s) => s.replace('sk-ant-abc', '[REDACTED]'))).toBe('key [REDACTED]');
  });

  it('detects the method from the terminal table; never a query', () => {
    expect(detectNotifyMethod({ TERM: 'xterm-256color' })).toBe('bel');
    expect(detectNotifyMethod({ TERM_PROGRAM: 'iTerm.app' })).toBe('osc9');
    expect(detectNotifyMethod({ TERM_PROGRAM: 'WezTerm' })).toBe('osc9');
    expect(detectNotifyMethod({ TERM_PROGRAM: 'ghostty' })).toBe('osc9');
    expect(detectNotifyMethod({ TERM: 'foot' })).toBe('osc9');
    expect(detectNotifyMethod({ TERM: 'xterm-kitty' })).toBe('osc99');
    expect(insideTmux({ TMUX: '/tmp/tmux-1/default,1,0' })).toBe(true);
    expect(insideTmux({})).toBe(false);
  });

  it('createNotifier writes only when enabled (default off; on under --screen-reader)', () => {
    const out: string[] = [];
    let enabled = false;
    const n = createNotifier({ write: (s) => out.push(s), env: { TERM_PROGRAM: 'iTerm.app' }, enabled: () => enabled });
    expect(n.method).toBe('osc9');
    expect(n.notify('review pending')).toBe(false);
    expect(out).toEqual([]);
    enabled = true;
    expect(n.notify('review pending')).toBe(true);
    expect(out).toEqual(['\x1b]9;review pending\x07']);
  });
});

describe('timers (§6.3, §14.1)', () => {
  function clock() {
    let now = 0;
    const timers: { id: number; at: number; fn: () => void }[] = [];
    let seq = 0;
    const set = (fn: () => void, ms: number): unknown => {
      const t = { id: ++seq, at: now + ms, fn };
      timers.push(t);
      return t.id;
    };
    const clear = (h: unknown): void => {
      const i = timers.findIndex((t) => t.id === h);
      if (i !== -1) timers.splice(i, 1);
    };
    const advance = (ms: number): void => {
      now += ms;
      for (const t of [...timers].sort((a, b) => a.at - b.at)) {
        if (t.at <= now) {
          timers.splice(timers.indexOf(t), 1);
          t.fn();
        }
      }
    };
    return { set, clear, advance, timers };
  }

  it('the review timer fires ~6 s after the box appears, restarts on keystrokes, cancels when the review resolves', () => {
    const c = clock();
    const fired: NotifyKind[] = [];
    const t = createNotifyTimers({ fire: (k) => fired.push(k), setTimeout: c.set, clearTimeout: c.clear });
    t.reviewShown();
    c.advance(4000);
    t.keystroke();
    c.advance(4000);
    expect(fired).toEqual([]);
    c.advance(2000);
    expect(fired).toEqual(['review']);
    t.reviewShown();
    t.reviewGone();
    c.advance(REVIEW_NOTIFY_MS + 1);
    expect(fired).toEqual(['review']);
    expect(t.pending).toEqual([]);
  });

  it('the run-end timer fires at ~60 s unless a key arrives; budget fires at once', () => {
    const c = clock();
    const fired: NotifyKind[] = [];
    const t = createNotifyTimers({ fire: (k) => fired.push(k), setTimeout: c.set, clearTimeout: c.clear });
    t.runEnded();
    expect(t.pending).toEqual(['run-end']);
    c.advance(30_000);
    t.keystroke();
    c.advance(RUN_END_NOTIFY_MS);
    expect(fired).toEqual([]);
    t.runEnded();
    c.advance(RUN_END_NOTIFY_MS);
    expect(fired).toEqual(['run-end']);
    t.budget();
    expect(fired).toEqual(['run-end', 'budget']);
    t.runEnded();
    t.cancel();
    expect(t.pending).toEqual([]);
  });
});
