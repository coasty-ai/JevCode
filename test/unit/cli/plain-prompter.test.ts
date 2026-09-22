/**
 * TUI-DESIGN-2 §3.7 (S3): the `--plain` readline twin of the ambiguity card — `createPlainPrompter().intake` over the
 * composer's borrowed line source: `y`/`yes` runs, `n`/`no` chats, empty keeps, an invalid answer is asked again, five
 * invalid answers keep (`READLINE_MAX_PROMPTS`), EOF keeps; the screen-reader form prints the `1/2/3` lines and takes the
 * digits; the line source is released after every answer (finding 3).
 */
import { describe, expect, it } from 'vitest';
import { INTAKE_READLINE_PROMPT, INTAKE_SR_LINES } from '../../../src/chat/lines.js';
import { createPlainPrompter, type WizardOutcome } from '../../../src/cli/session.js';
import { READLINE_MAX_PROMPTS, type LineSource } from '../../../src/tui/plain.js';
import { LOGIN_ONE_KEY_PROMPT, LOGIN_OTHER_WAYS_PROMPT } from '../../../src/tui/onboarding/lines.js';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface FakeLines extends LineSource {
  feed(line: string): void;
  close(): void;
  borrowed(): boolean;
}

function fakeLines(): FakeLines {
  let onLine: ((l: string) => void) | null = null;
  const closers = new Set<() => void>();
  let closed = false;
  return {
    onLine(fn) {
      onLine = fn;
      return () => {
        if (onLine === fn) onLine = null;
      };
    },
    onClose(fn) {
      closers.add(fn);
      return () => closers.delete(fn);
    },
    get closed() {
      return closed;
    },
    feed: (line) => onLine?.(line),
    close() {
      closed = true;
      for (const c of [...closers]) c();
    },
    borrowed: () => onLine !== null,
  };
}

function setup(o: { screenReader?: boolean } = {}) {
  const lines = fakeLines();
  const out: string[] = [];
  const prompter = createPlainPrompter({ lines, stdout: { write: (s: string) => out.push(s), columns: 80 }, ...(o.screenReader !== undefined ? { screenReader: o.screenReader } : {}) });
  /** ask, then feed the answers one per turn (the prompt is written when `ask` attaches) */
  const answer = async (...answers: string[]): Promise<'run' | 'chat' | 'keep'> => {
    const pending = prompter.intake!('the date parsing');
    for (const a of answers) {
      await tick();
      lines.feed(a);
    }
    return pending;
  };
  const prompts = (): number => out.filter((s) => s === INTAKE_READLINE_PROMPT).length;
  return { lines, out, prompter, answer, prompts };
}

describe('createPlainPrompter().intake — the §3.7 readline twin', () => {
  it('y / yes run; n / no chat; empty, 3, keep and esc keep; the row is the §12 literal and the source is released afterwards', async () => {
    const s = setup();
    expect(await s.answer('y')).toBe('run');
    expect(s.out[0]).toBe('run this as a task? [y] run it  [n] just chatting  [Esc/empty] keep the text > ');
    expect(s.lines.borrowed()).toBe(false);
    expect(await s.answer('yes')).toBe('run');
    expect(await s.answer('n')).toBe('chat');
    expect(await s.answer('NO')).toBe('chat');
    expect(await s.answer('')).toBe('keep');
    expect(await s.answer('3')).toBe('keep');
    expect(await s.answer('keep')).toBe('keep');
    expect(await s.answer('esc')).toBe('keep');
    expect(s.prompts()).toBe(8);
    // never the message itself: the [you] bubble already showed it
    expect(s.out.join('')).not.toContain('the date parsing');
  });

  it('an invalid answer asks again; five invalid answers keep the text (READLINE_MAX_PROMPTS); a valid answer after two invalid ones is taken', async () => {
    const s = setup();
    expect(await s.answer('maybe', 'q', 'yn', 'later', 'x')).toBe('keep');
    expect(s.prompts()).toBe(READLINE_MAX_PROMPTS);
    expect(await s.answer('what', 'hm', 'y')).toBe('run');
    expect(s.prompts()).toBe(READLINE_MAX_PROMPTS + 3);
    expect(s.lines.borrowed()).toBe(false);
  });

  it('EOF keeps (nobody can answer after Ctrl-D); a closed source keeps at once without a prompt', async () => {
    const s = setup();
    const pending = s.prompter.intake!('parse_date');
    await tick();
    s.lines.close();
    expect(await pending).toBe('keep');
    expect(s.prompts()).toBe(1);
    expect(await s.prompter.intake!('again')).toBe('keep');
    expect(s.prompts()).toBe(1);
  });

  it('screen reader: the `1 run it  2 just chatting  3 keep the text` line, then `Enter selection (1-3):` — 1 runs, 2 chats, 3 keeps (TD §6.5 typed-line rule)', async () => {
    const s = setup({ screenReader: true });
    expect(await s.answer('1')).toBe('run');
    expect(s.out.slice(0, 2)).toEqual([`${INTAKE_SR_LINES[0]}\n`, `${INTAKE_SR_LINES[1]} `]);
    expect(s.prompts()).toBe(0);
    expect(await s.answer('2')).toBe('chat');
    expect(await s.answer('3')).toBe('keep');
    expect(await s.answer('7', '')).toBe('keep');
    expect(s.out.filter((x) => x === `${INTAKE_SR_LINES[1]} `)).toHaveLength(5);
  });
});

describe('TUI-DESIGN-3 §1.4.3 / §1.3.3: the --plain wizard twin (R3 F4)', () => {
  const OR = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123';
  const TS = 'ts-live-abcdefghijklmnopqrstuvwxyz-0123456789';
  /** a plain prompter over a fake line source whose masked reads are fed like the readline twin's */
  function wizardSetup() {
    const lines = fakeLines();
    const out: string[] = [];
    const prompter = createPlainPrompter({ lines, stdout: { write: (s: string) => out.push(s), columns: 80 }, stdin: { isTTY: false } });
    const drive = async (missing: readonly ('generator.apiKey' | 'decider.apiKey')[], o: { provider?: 'anthropic' | 'openrouter' | null; found?: 'typesafe' | 'jev' | 'anthropic' | null; mode?: 'jev-on' | 'jev-only'; reason?: 'missing' | 'login' }, ...answers: string[]): Promise<WizardOutcome> => {
      const pending = prompter.wizard!(missing, { provider: o.provider ?? null, reason: o.reason ?? 'missing', mode: o.mode ?? 'jev-on', found: o.found ?? null });
      for (const a of answers) {
        await tick();
        lines.feed(a);
      }
      return pending;
    };
    return { lines, out, prompter, drive };
  }

  it('both keys missing, nothing resolving: the other-ways line, then ONE masked OpenRouter key → apiKey + jevApiKey + provider + jevProvider openrouter (the one-key path writes jevProvider)', async () => {
    const s = wizardSetup();
    const outcome = await s.drive(['generator.apiKey', 'decider.apiKey'], {}, '', OR);
    expect(outcome).toEqual({ kind: 'saved', patch: { apiKey: OR, provider: 'openrouter', jevApiKey: OR, jevProvider: 'openrouter' } });
    expect(s.out.some((l) => l === LOGIN_OTHER_WAYS_PROMPT)).toBe(true);
    expect(s.out.some((l) => l.includes(LOGIN_ONE_KEY_PROMPT.trim()))).toBe(true);
    expect(s.out.join('')).not.toContain(OR);
    // a short key cancels
    expect(await s.drive(['generator.apiKey', 'decider.apiKey'], {}, '', 'short')).toEqual({ kind: 'cancelled' });
  });

  it('[t] TypeSafe Jev: the TypeSafe key, then the optional OpenRouter generator key (Enter = skip pends / persists jev-only; a key saves both with jevProvider typesafe)', async () => {
    const s = wizardSetup();
    expect(await s.drive(['generator.apiKey', 'decider.apiKey'], {}, 't', TS, OR)).toEqual({ kind: 'saved', patch: { jevApiKey: TS, jevProvider: 'typesafe', apiKey: OR, provider: 'openrouter' } });
    expect(await s.drive(['generator.apiKey', 'decider.apiKey'], {}, 't', TS, '')).toEqual({ kind: 'saved', patch: { jevApiKey: TS, jevProvider: 'typesafe' }, mode: { mode: 'jev-only', persist: true } });
    expect(await s.drive(['generator.apiKey', 'decider.apiKey'], { reason: 'login' }, 't', TS, '')).toEqual({ kind: 'saved', patch: { jevApiKey: TS, jevProvider: 'typesafe' }, mode: { mode: 'jev-only', persist: false } });
  });

  it('[j] Jev only: the provider question, the Jev key, and the mode choice (persisted at startup, pended from /login); [a] Anthropic: the Anthropic key, then the round-2 Jev step', async () => {
    const s = wizardSetup();
    expect(await s.drive(['generator.apiKey', 'decider.apiKey'], {}, 'j', '2', OR)).toEqual({ kind: 'saved', patch: { jevApiKey: OR, jevProvider: 'openrouter' }, mode: { mode: 'jev-only', persist: true } });
    expect(await s.drive(['generator.apiKey', 'decider.apiKey'], {}, 'j', '1', TS)).toEqual({ kind: 'saved', patch: { jevApiKey: TS, jevProvider: 'typesafe' }, mode: { mode: 'jev-only', persist: true } });
    expect(await s.drive(['generator.apiKey', 'decider.apiKey'], { reason: 'login' }, 'j', 'typesafe', TS)).toMatchObject({ kind: 'saved', mode: { mode: 'jev-only', persist: false } });
    expect(await s.drive(['generator.apiKey', 'decider.apiKey'], {}, 'j', 'x', TS)).toEqual({ kind: 'cancelled' });
    const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuv_-x';
    expect(await s.drive(['generator.apiKey', 'decider.apiKey'], {}, 'a', KEY, OR)).toEqual({ kind: 'saved', patch: { provider: 'anthropic', apiKey: KEY, jevApiKey: OR } });
  });

  it('the found-title path (Jev resolves, the generator missing): the OpenRouter generator key alone — apiKey + provider openrouter, NEVER jevProvider / jevApiKey (D-G)', async () => {
    const s = wizardSetup();
    expect(await s.drive(['generator.apiKey'], { provider: 'openrouter', found: 'typesafe' }, OR)).toEqual({ kind: 'saved', patch: { apiKey: OR, provider: 'openrouter' } });
    expect(await s.drive(['generator.apiKey'], { provider: 'openrouter', found: 'jev' }, OR)).toEqual({ kind: 'saved', patch: { apiKey: OR, provider: 'openrouter' } });
    expect(s.out.some((l) => l === LOGIN_OTHER_WAYS_PROMPT)).toBe(false);
    // jev-only keeps the round-2 flow: the Jev key alone, the reuse rule untouched
    const jo = wizardSetup();
    expect(await jo.drive(['decider.apiKey'], { mode: 'jev-only' }, OR)).toEqual({ kind: 'saved', patch: { jevApiKey: OR } });
    // an anthropic provider preselected: the round-2 two-step flow (generator key, Jev key)
    const anth = wizardSetup();
    const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuv_-x';
    expect(await anth.drive(['generator.apiKey', 'decider.apiKey'], { provider: 'anthropic' }, KEY, OR)).toEqual({ kind: 'saved', patch: { provider: 'anthropic', apiKey: KEY, jevApiKey: OR } });
  });
});

describe('TUI-DESIGN-3 §1.8 edge 24: Ctrl-C and EOF in the --plain wizard', () => {
  /** the shared stdin of the readline composer: raw-mode capable, and a byte stream the masked read may watch */
  interface FakeStdin {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode(mode: boolean): void;
    on(event: 'data', fn: (chunk: string | Uint8Array) => void): unknown;
    off(event: 'data', fn: (chunk: string | Uint8Array) => void): unknown;
    /** what a terminal in raw mode delivers (Ctrl-C is a byte there, never SIGINT and never a line) */
    emit(chunk: string | Uint8Array): void;
    /** every setRawMode argument, in order */
    modes: boolean[];
    listeners(): number;
  }
  function fakeStdin(): FakeStdin {
    const fns = new Set<(chunk: string | Uint8Array) => void>();
    const s: FakeStdin = {
      isTTY: true,
      isRaw: false,
      modes: [],
      setRawMode(mode) {
        s.modes.push(mode);
        s.isRaw = mode;
      },
      on(_event, fn) {
        fns.add(fn);
        return s;
      },
      off(_event, fn) {
        fns.delete(fn);
        return s;
      },
      emit(chunk) {
        for (const fn of [...fns]) fn(chunk);
      },
      listeners: () => fns.size,
    };
    return s;
  }
  function setup() {
    const lines = fakeLines();
    const stdin = fakeStdin();
    const out: string[] = [];
    const prompter = createPlainPrompter({ lines, stdout: { write: (s: string) => out.push(s), columns: 80 }, stdin });
    const open = (): Promise<WizardOutcome> => prompter.wizard!(['generator.apiKey', 'decider.apiKey'], { provider: null, reason: 'missing', mode: 'jev-on', found: null });
    return { lines, stdin, out, open };
  }

  it('a lone `\\u0003` byte at the masked key field cancels the wizard at once — readline never reports a line for it (the plain wizard used to hang)', async () => {
    const s = setup();
    const pending = s.open();
    await tick();
    expect(s.out).toContain(LOGIN_OTHER_WAYS_PROMPT);
    s.lines.feed(''); // Enter on the other-ways line: the one-key path
    await tick();
    expect(s.out.some((l) => l.includes(LOGIN_ONE_KEY_PROMPT.trim()))).toBe(true);
    expect(s.stdin.modes).toEqual([true]); // the field is read with the echo off
    expect(s.stdin.listeners()).toBe(1);
    s.stdin.emit(Uint8Array.from([0x03]));
    expect(await pending).toEqual({ kind: 'cancelled' });
    // the watcher is detached with the read and the terminal is cooked again (the fix block and exit 2 follow in the controller)
    expect(s.stdin.listeners()).toBe(0);
    expect(s.stdin.modes).toEqual([true, false]);
  });

  it('a `\\u0003` inside a typed line still cancels; EOF on the other-ways line cancels without ever asking for a key', async () => {
    const withByte = setup();
    const p1 = withByte.open();
    await tick();
    withByte.lines.feed('');
    await tick();
    withByte.lines.feed('sk-or-v1-abcdefghijklmnop\u0003');
    expect(await p1).toEqual({ kind: 'cancelled' });

    const eof = setup();
    const p2 = eof.open();
    await tick();
    eof.lines.close();
    expect(await p2).toEqual({ kind: 'cancelled' });
    expect(eof.out.some((l) => l.includes(LOGIN_ONE_KEY_PROMPT.trim()))).toBe(false);
  });
});
