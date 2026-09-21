/**
 * TUI-DESIGN-2 §3.7 (S3): the `--plain` readline twin of the ambiguity card — `createPlainPrompter().intake` over the
 * composer's borrowed line source: `y`/`yes` runs, `n`/`no` chats, empty keeps, an invalid answer is asked again, five
 * invalid answers keep (`READLINE_MAX_PROMPTS`), EOF keeps; the screen-reader form prints the `1/2/3` lines and takes the
 * digits; the line source is released after every answer (finding 3).
 */
import { describe, expect, it } from 'vitest';
import { INTAKE_READLINE_PROMPT, INTAKE_SR_LINES } from '../../../src/chat/lines.js';
import { createPlainPrompter } from '../../../src/cli/session.js';
import { READLINE_MAX_PROMPTS, type LineSource } from '../../../src/tui/plain.js';

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
