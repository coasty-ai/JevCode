/**
 * TUI-DESIGN §19.0 / §4.9: `/foo` never submits; `//` literal; empty trim; a missing chip cancels; a hit opens
 * the gate; live → steer vs idle → submit; held until the host attaches; trailing `\` is a newline; `exit`
 * typed alone does not exit; secret spans ≥ 8 chars only; the 12,000-char notice; a `/` after leading
 * whitespace is still a command; rest commands keep apostrophes; denied `@` mentions are dropped (§10.4).
 */
import { describe, expect, it } from 'vitest';
import type { SecretHit } from '../../../../src/core/types.js';
import { CHIP_LABEL_RE, MIN_SECRET_LENGTH, MULTILINE_ARM_MS, READ_ONLY_WHILE_THINKING, STILL_THINKING_TOAST, TASK_CHARS_LIMIT, TRUNCATION_NOTICE, deniedMentionNotice, expandChips, hiddenCommandLine, mentionedPaths, multilineCommandNotice, routeSend, routeSubmit, secretSpans, whileThinking, type SubmitInput } from '../../../../src/tui/composer/submit.js';
import { COMMANDS, findCommand, type CommandSpec } from '../../../../src/tui/commands/registry.js';

const noHits = { detectSecrets: () => [] as readonly SecretHit[] };
const hitAt = (start: number, end: number, label = 'sk-ant-…'): SecretHit => ({ family: 'anthropic', label, start, end, warnOnly: false });

function input(o: Partial<SubmitInput> = {}): SubmitInput {
  return {
    text: 'fix parse_date tz',
    submitting: false,
    overlay: 'none',
    run: 'none',
    host: noHits,
    chips: new Map(),
    ranBefore: false,
    dispatch: { run: 'none', step: 0 },
    ...o,
  };
}

describe('routeSubmit (TUI-DESIGN §4.9)', () => {
  it('re-entrancy: while submitting Enter is ignored', () => {
    expect(routeSubmit(input({ submitting: true }))).toEqual({ kind: 'ignore', reason: 'submitting' });
  });
  it('a `/` token that matches nothing never submits: error item, draft kept (fixable errors keep it, availability errors clear it — TUI-DESIGN-3 F21, D-K)', () => {
    expect(routeSubmit(input({ text: '/foo' }))).toEqual({ kind: 'error', text: 'error: /foo — not a command · type / to list commands', label: '[ui]', keepDraft: true });
    expect(routeSubmit(input({ text: '/bud' }))).toEqual({ kind: 'error', text: 'error: /bud — not a command. Did you mean /budget? · type / to list commands', label: '[ui]', keepDraft: true });
    expect(routeSubmit(input({ text: '/export "x' }))).toEqual({ kind: 'error', text: 'error: /export: unterminated quote', label: '[ui]', keepDraft: true });
    expect(routeSubmit(input({ text: '/rename "x' }))).toMatchObject({ kind: 'command', action: { kind: 'rename', title: '"x' } });
    expect(routeSubmit(input({ text: '/budget spend-cap abc' }))).toEqual({ kind: 'error', text: 'error: /budget spend-cap: expected a positive USD amount, got "abc"', label: '[ui]', keepDraft: true });
    expect(routeSubmit(input({ text: '/undo', run: 'live', dispatch: { run: 'live', step: 3 } }))).toEqual({ kind: 'error', text: 'error: /undo runs when the run is idle; Esc pauses first', label: '[ui]', keepDraft: false });
    expect(routeSubmit(input({ text: '/steer x' }))).toEqual({ kind: 'error', text: 'error: /steer needs a live run', label: '[ui]', keepDraft: false });
    expect(routeSubmit(input({ text: '/budgett', overlay: 'palette' }))).toMatchObject({ kind: 'error', keepDraft: true });
    expect(routeSubmit(input({ text: '/undo', overlay: 'palette', run: 'live', dispatch: { run: 'live', step: 3 } }))).toMatchObject({ kind: 'error', keepDraft: false });
  });
  it('TUI-DESIGN-3 §4.1 rule 1 / §8 S4: every alias of the table runs its owner on Enter, in the palette and in the composer', () => {
    const arg: Record<string, string> = { why: ' 3', theme: ' dark' };
    for (const c of COMMANDS) {
      for (const a of c.aliases) {
        const run = c.availableDuringTask === 'live' ? 'live' : 'none';
        const o = { text: `/${a}${arg[c.name] ?? ''}`, run, dispatch: { run, step: 0 } } as const;
        expect(routeSubmit(input({ ...o, overlay: 'palette' })), a).toMatchObject({ kind: 'command', spec: { name: c.name }, line: o.text });
        expect(routeSubmit(input(o)), a).toMatchObject({ kind: 'command', spec: { name: c.name } });
      }
    }
    expect(routeSubmit(input({ text: '/s', overlay: 'palette' }))).toMatchObject({ kind: 'command', action: { kind: 'status' } });
    expect(routeSubmit(input({ text: '/m jev-on', overlay: 'palette' }))).toMatchObject({ kind: 'command', action: { kind: 'mode', mode: 'jev-on' } });
    expect(routeSubmit(input({ text: '/Q', overlay: 'palette' }))).toMatchObject({ kind: 'command', action: { kind: 'exit' } });
  });
  it('TUI-DESIGN-3 §4.4 F14: while a chat request is thinking (`allowCommandsWhileSubmitting`) `/` lines route instead of being dropped — the read-only set runs, /exit runs (the App cancels the request and exits), /steer answers `needs a live run`, everything else answers the still-thinking toast with the draft kept; text still waits', () => {
    const thinking = { submitting: true, allowCommandsWhileSubmitting: true, run: 'starting' as const, dispatch: { run: 'none' as const, step: 0 } };
    // the read-only set, every spelling
    for (const name of ['status', 'cost', 'jev', 'help', 'panel', 'transcript', 'theme']) {
      expect(READ_ONLY_WHILE_THINKING.has(name), name).toBe(true);
      expect(whileThinking(findCommand(name) as CommandSpec), name).toBe('run');
    }
    expect(routeSubmit(input({ ...thinking, text: '/status' }))).toMatchObject({ kind: 'command', action: { kind: 'status' } });
    expect(routeSubmit(input({ ...thinking, text: '/s' }))).toMatchObject({ kind: 'command', action: { kind: 'status' } });
    expect(routeSubmit(input({ ...thinking, text: '/cost' }))).toMatchObject({ kind: 'command', action: { kind: 'cost' } });
    expect(routeSubmit(input({ ...thinking, text: '/help keys' }))).toMatchObject({ kind: 'command', action: { kind: 'help', topic: 'keys' } });
    expect(routeSubmit(input({ ...thinking, text: '/theme light' }))).toMatchObject({ kind: 'command', action: { kind: 'theme', theme: 'light' } });
    expect(routeSubmit(input({ ...thinking, text: '/panel d', overlay: 'palette' }))).toMatchObject({ kind: 'command', action: { kind: 'panel', panel: 'd' } });
    // /exit runs (cancel + exit is the App's); /steer needs a live run (a chat request is not a run); the rest → busy toast
    expect(whileThinking(findCommand('exit') as CommandSpec)).toBe('exit');
    expect(routeSubmit(input({ ...thinking, text: '/exit' }))).toMatchObject({ kind: 'command', action: { kind: 'exit' } });
    expect(routeSubmit(input({ ...thinking, text: '/steer go' }))).toEqual({ kind: 'error', text: 'error: /steer needs a live run', label: '[ui]', keepDraft: false });
    for (const name of ['new', 'mode', 'budget', 'undo', 'resume', 'login', 'config', 'why', 'diff', 'copy', 'model']) {
      expect(whileThinking(findCommand(name) as CommandSpec), name).toBe('busy');
      const sample: Record<string, string> = { why: ' 3', mode: ' jev-on' };
      expect(routeSubmit(input({ ...thinking, text: `/${name}${sample[name] ?? ''}` })), name).toEqual({ kind: 'busy', toast: STILL_THINKING_TOAST });
    }
    expect(STILL_THINKING_TOAST).toBe('one moment — still thinking');
    // a typo while thinking is still the unknown-command error (the draft kept), never a silent drop
    expect(routeSubmit(input({ ...thinking, text: '/statuss' }))).toMatchObject({ kind: 'error', keepDraft: true });
    // text while thinking is still ignored by the router (the App toasts); submitting without the flag ignores commands too (a run submission in flight)
    expect(routeSubmit(input({ ...thinking, text: 'hello again' }))).toEqual({ kind: 'ignore', reason: 'submitting' });
    expect(routeSubmit(input({ submitting: true, text: '/status' }))).toEqual({ kind: 'ignore', reason: 'submitting' });
    // the flag without `submitting` changes nothing for a read-only command and still answers busy for the rest (chatThinking is the App's predicate)
    expect(routeSubmit(input({ allowCommandsWhileSubmitting: true, text: '/new' }))).toEqual({ kind: 'busy', toast: STILL_THINKING_TOAST });
    expect(routeSubmit(input({ text: '/new' }))).toMatchObject({ kind: 'command', action: { kind: 'new' } });
  });
  it('an exact command runs (session mode idle and live alike); the palette runs only an exact name or alias', () => {
    expect(routeSubmit(input({ text: '/cost' }))).toMatchObject({ kind: 'command', action: { kind: 'cost' }, line: '/cost' });
    expect(routeSubmit(input({ text: '/budget spend-cap 3', run: 'live', dispatch: { run: 'live', step: 3 } }))).toMatchObject({ kind: 'command', action: { kind: 'budget', set: { setting: 'spend-cap', usd: 3 } } });
    expect(routeSubmit(input({ text: '/quit', overlay: 'palette' }))).toMatchObject({ kind: 'command', action: { kind: 'exit' } });
    expect(routeSubmit(input({ text: '/exit', overlay: 'palette' }))).toMatchObject({ kind: 'command', action: { kind: 'exit' } });
    expect(routeSubmit(input({ text: '/bud', overlay: 'palette' }))).toEqual({ kind: 'error', text: 'error: /bud — not a command. Did you mean /budget? · type / to list commands', label: '[ui]', keepDraft: true });
    expect(routeSubmit(input({ text: '/budget spend-cap 3', overlay: 'palette' }))).toMatchObject({ kind: 'command', action: { kind: 'budget' } });
    expect(routeSubmit(input({ text: '/', overlay: 'palette' }))).toEqual({ kind: 'error', text: 'error: / — not a command · type / to list commands', label: '[ui]', keepDraft: true });
    expect(routeSubmit(input({ text: '', overlay: 'palette' }))).toMatchObject({ kind: 'error' });
  });
  it('a `/` after leading whitespace is a command, never a paid run (D-log: slash typos never start a run)', () => {
    expect(routeSubmit(input({ text: ' /help' }))).toMatchObject({ kind: 'command', action: { kind: 'help', topic: 'all' }, line: '/help' });
    expect(routeSubmit(input({ text: '\t  /foo' }))).toEqual({ kind: 'error', text: 'error: /foo — not a command · type / to list commands', label: '[ui]', keepDraft: true });
    expect(routeSubmit(input({ text: '  /budget spend-cap abc' }))).toMatchObject({ kind: 'error', text: 'error: /budget spend-cap: expected a positive USD amount, got "abc"' });
    // `//` stays a column-0 escape: with leading whitespace it is neither a command nor the literal-slash form
    expect(routeSubmit(input({ text: ' //x' }))).toMatchObject({ kind: 'submit', full: ' //x' });
  });
  it('rest commands through the router: /steer with an apostrophe steers while live; /why and /rename keep quotes and a trailing backslash', () => {
    const l = { run: 'live' as const, dispatch: { run: 'live' as const, step: 3 } };
    expect(routeSubmit(input({ text: "/steer don't touch the tests", ...l }))).toMatchObject({ kind: 'command', action: { kind: 'steer', text: "don't touch the tests" } });
    expect(routeSubmit(input({ text: '/steer say "hi', ...l }))).toMatchObject({ kind: 'command', action: { kind: 'steer', text: 'say "hi' } });
    expect(routeSubmit(input({ text: "/why what's this" }))).toMatchObject({ kind: 'command', action: { kind: 'why', ref: "what's this" } });
    expect(routeSubmit(input({ text: "/rename it's fine" }))).toMatchObject({ kind: 'command', action: { kind: 'rename', title: "it's fine" } });
    // a trailing single backslash is the newline key on any line, rest commands included (§3.2 row 2)
    expect(routeSubmit(input({ text: '/steer a\\', ...l }))).toEqual({ kind: 'newline', text: '/steer a' });
    expect(routeSubmit(input({ text: '/steer a\\\\', ...l }))).toMatchObject({ kind: 'command', action: { kind: 'steer', text: 'a\\\\' } });
    expect(routeSubmit(input({ text: "/steer don't" }))).toEqual({ kind: 'error', text: 'error: /steer needs a live run', label: '[ui]', keepDraft: false });
  });
  it('`//` is a literal slash-leading prompt; `exit`/`quit`/`:q` alone are prompts, not exits (§22 vs A9)', () => {
    expect(routeSubmit(input({ text: '//usr/bin/env is the shebang' }))).toMatchObject({ kind: 'submit', full: '/usr/bin/env is the shebang' });
    for (const w of ['exit', 'quit', ':q']) expect(routeSubmit(input({ text: w }))).toMatchObject({ kind: 'submit', full: w });
  });
  it('empty (after trim) is a no-op; `//` alone is the literal one-character prompt `/` (§4.9 step order)', () => {
    expect(routeSubmit(input({ text: '' }))).toEqual({ kind: 'ignore', reason: 'empty' });
    expect(routeSubmit(input({ text: '   \n\t ' }))).toEqual({ kind: 'ignore', reason: 'empty' });
    expect(routeSubmit(input({ text: '// ' }))).toMatchObject({ kind: 'submit', full: '/ ' });
    expect(routeSubmit(input({ text: '/ ' }))).toMatchObject({ kind: 'error', text: 'error: / — not a command · type / to list commands' });
  });
  it('a trailing backslash is a newline with the backslash removed (never a submission)', () => {
    expect(routeSubmit(input({ text: 'line one\\' }))).toEqual({ kind: 'newline', text: 'line one' });
    expect(routeSubmit(input({ text: '/rename foo\\' }))).toEqual({ kind: 'newline', text: '/rename foo' });
    expect(routeSubmit(input({ text: 'ends with two\\\\' }))).toMatchObject({ kind: 'submit' });
  });
  it('chips expand in label order; a label whose body is missing cancels with `remove [Pasted #N] or paste again`', () => {
    const chips = new Map([[1, 'BODY ONE'], [2, 'BODY TWO']]);
    expect(routeSubmit(input({ text: 'see [Pasted #2, 3 lines] and [Pasted #1, 1 line]', chips }))).toMatchObject({ kind: 'submit', full: 'see BODY TWO and BODY ONE' });
    expect(routeSubmit(input({ text: 'see [Pasted #3, 3 lines]', chips }))).toEqual({ kind: 'chip-missing', n: 3, text: 'remove [Pasted #3] or paste again', label: '[ui]' });
    expect(routeSubmit(input({ text: '[Pasted #1: "hello", 2 lines]', chips }))).toMatchObject({ kind: 'submit', full: 'BODY ONE' });
    expect(expandChips('x [Pasted #7, 1 line] y', new Map())).toEqual({ ok: false, n: 7, label: '[Pasted #7, 1 line]' });
    expect('[Pasted #12, 40 lines]'.match(CHIP_LABEL_RE)?.[0]).toBe('[Pasted #12, 40 lines]');
    expect(routeSubmit(input({ text: 'x', expand: () => ({ ok: false, n: 9, label: '[Pasted #9, 1 line]' }) }))).toMatchObject({ kind: 'chip-missing', n: 9 });
    expect(routeSubmit(input({ text: 'x', expand: (t) => ({ ok: true, text: `${t}!` }) }))).toMatchObject({ kind: 'submit', full: 'x!' });
  });
  it('is held with `starting…` until the host attaches; commands and errors still work without a host', () => {
    expect(routeSubmit(input({ host: null }))).toEqual({ kind: 'hold', toast: 'starting…' });
    expect(routeSubmit(input({ host: null, text: '/cost' }))).toMatchObject({ kind: 'command' });
    expect(routeSubmit(input({ host: null, text: '/foo' }))).toMatchObject({ kind: 'error' });
    expect(routeSubmit(input({ host: null, text: '' }))).toEqual({ kind: 'ignore', reason: 'empty' });
  });
  it('a detected secret opens the gate with the expanded text and the hits; only `y` continues through routeSend', () => {
    const full = 'use sk-ant-abcdefghijklmnop please';
    const host = { detectSecrets: (s: string) => (s.includes('sk-ant-') ? [hitAt(4, 27)] : []) };
    const r = routeSubmit(input({ text: full, host }));
    expect(r).toEqual({ kind: 'gate', full, hits: [hitAt(4, 27)] });
    const sent = routeSend(full, [hitAt(4, 27)], { run: 'none', ranBefore: false });
    expect(sent).toEqual({ kind: 'submit', full, secretSpans: ['sk-ant-abcdefghijklmnop'], pinnedFiles: [], droppedMentions: [], promptKind: 'prompt', notice: null });
    // the gate sees the expanded text, so a secret inside a paste chip is caught too
    const chips = new Map([[1, 'key: sk-ant-abcdefghijklmnop']]);
    expect(routeSubmit(input({ text: '[Pasted #1, 1 line]', chips, host }))).toMatchObject({ kind: 'gate', full: 'key: sk-ant-abcdefghijklmnop' });
  });
  it('live, starting or pausing → steer (S7 Enter with text steers, §3.3); idle → submit (prompt before the first run ended, follow-up after); aborting → ignored', () => {
    expect(routeSubmit(input({ run: 'live' }))).toEqual({ kind: 'steer', full: 'fix parse_date tz', secretSpans: [], notice: null, droppedMentions: [] });
    expect(routeSubmit(input({ run: 'starting' }))).toMatchObject({ kind: 'steer' });
    expect(routeSubmit(input({ run: 'pausing' }))).toMatchObject({ kind: 'steer' });
    expect(routeSubmit(input({ run: 'none' }))).toEqual({ kind: 'submit', full: 'fix parse_date tz', secretSpans: [], pinnedFiles: [], droppedMentions: [], promptKind: 'prompt', notice: null });
    expect(routeSubmit(input({ run: 'none', ranBefore: true }))).toMatchObject({ kind: 'submit', promptKind: 'follow-up' });
    expect(routeSubmit(input({ run: 'aborting' }))).toEqual({ kind: 'ignore', reason: 'run-ending' });
  });
  it('@-mentions become pinnedFiles on a new run and stay inside the text of a steer', () => {
    const text = 'look at @src/a.py and @tests/test\\ a.py, also @src/a.py; not email@example.com';
    expect(routeSubmit(input({ text }))).toMatchObject({ kind: 'submit', pinnedFiles: ['src/a.py', 'tests/test a.py'], droppedMentions: [] });
    expect(routeSubmit(input({ text, run: 'live' }))).toMatchObject({ kind: 'steer', full: text, droppedMentions: [] });
    expect(mentionedPaths('@/abs/path @ok.txt @')).toEqual(['ok.txt']);
    expect(mentionedPaths('')).toEqual([]);
  });
  it('a denied @ mention typed in full is dropped from pinnedFiles and reported (§5.4/§10.4: the literal word stays, the notice is the §24 line)', () => {
    const isDeniedPath = (rel: string): boolean => rel === '.env' || rel.startsWith('.git/') || /credential/i.test(rel);
    const dispatch = { run: 'none' as const, step: 0, isDeniedPath };
    const text = 'compare @.env with @src/a.py and @.git/config and @Credentials.json';
    const r = routeSubmit(input({ text, dispatch }));
    expect(r).toMatchObject({ kind: 'submit', full: text, pinnedFiles: ['src/a.py'], droppedMentions: ['.env', '.git/config', 'Credentials.json'] });
    expect(deniedMentionNotice('.env')).toBe('.env is on the secret denylist; JevCode never reads it. Start with --allow-secret-mention to override.');
    // a steer reports the dropped mentions too (the text still carries the word; the engine's own read keeps SecretPathError)
    expect(routeSubmit(input({ text, run: 'live', dispatch: { ...dispatch, run: 'live' } }))).toMatchObject({ kind: 'steer', full: text, droppedMentions: ['.env', '.git/config', 'Credentials.json'] });
    // no denylist → everything is pinned (the controller always passes one; the default is permissive)
    expect(routeSubmit(input({ text }))).toMatchObject({ kind: 'submit', pinnedFiles: ['.env', 'src/a.py', '.git/config', 'Credentials.json'], droppedMentions: [] });
    expect(routeSend('see @.env', [], { run: 'none', ranBefore: false, isDeniedPath })).toMatchObject({ kind: 'submit', pinnedFiles: [], droppedMentions: ['.env'] });
  });
  it('secret spans: every hit ≥ 8 chars, de-duplicated, in text order; short spans dropped', () => {
    const full = 'a AKIAIOSFODNN7EXAMPLE b short c AKIAIOSFODNN7EXAMPLE';
    const hits: SecretHit[] = [hitAt(33, 53, 'AKIA…'), hitAt(2, 22, 'AKIA…'), hitAt(25, 30, 'x')];
    expect(secretSpans(full, hits)).toEqual(['AKIAIOSFODNN7EXAMPLE']);
    expect(MIN_SECRET_LENGTH).toBe(8);
    expect(secretSpans(full, [hitAt(-5, 3)])).toEqual([]);
    expect(secretSpans('', [])).toEqual([]);
  });
  it('an expanded submission over 12,000 characters carries the truncation notice', () => {
    const long = 'x'.repeat(TASK_CHARS_LIMIT + 1);
    expect(routeSubmit(input({ text: long }))).toMatchObject({ kind: 'submit', notice: TRUNCATION_NOTICE });
    expect(routeSubmit(input({ text: long, run: 'live' }))).toMatchObject({ kind: 'steer', notice: TRUNCATION_NOTICE });
    expect(routeSubmit(input({ text: 'x'.repeat(TASK_CHARS_LIMIT) }))).toMatchObject({ kind: 'submit', notice: null });
    expect(TRUNCATION_NOTICE).toBe('notice: only the first 12,000 characters reach the generator; @-mention a file for more');
  });
  it('TUI-DESIGN-4 §5.3 P-C8 (b): a command hidden on a later line of a multi-line draft warns once and keeps the draft; a second Enter inside 3 s submits', () => {
    const draft = 'please look at this\nand then\n/exit';
    // `multilineArmedAt: null` is the caller saying "I store the arm" — with it absent the scan never runs, so a
    // controller that has not wired P-C8 yet can never swallow a draft (the §9.2 App.tsx request)
    expect(routeSubmit(input({ text: draft, now: 1000 }))).toMatchObject({ kind: 'submit', full: draft });
    const first = routeSubmit(input({ text: draft, multilineArmedAt: null, now: 1000 }));
    expect(first).toEqual({
      kind: 'confirm-multiline',
      text: 'line 3 looks like /exit; a submitted message is sent as text — remove it or press Enter again',
      label: '[ui]',
      line: 3,
      command: '/exit',
    });
    expect(multilineCommandNotice(3, '/exit')).toBe('line 3 looks like /exit; a submitted message is sent as text — remove it or press Enter again');
    // the second Enter inside the window submits the whole draft as text
    expect(routeSubmit(input({ text: draft, multilineArmedAt: 1000, now: 1000 + MULTILINE_ARM_MS }))).toMatchObject({ kind: 'submit', full: draft });
    // (e) the arm expires into a WARNING, never a silent send
    expect(routeSubmit(input({ text: draft, multilineArmedAt: 1000, now: 1001 + MULTILINE_ARM_MS }))).toMatchObject({ kind: 'confirm-multiline', line: 3 });
    expect(MULTILINE_ARM_MS).toBe(3000);
  });
  it('TUI-DESIGN-4 §5.3 P-C8 edge cases: the first line wins, `//` is unchanged, and a pasted path or list is never a false positive', () => {
    // (a) a draft whose FIRST line is a command — unchanged, the whole thing goes to dispatchCommand (never the
    // P-C8 warning), which is where its arguments are validated exactly as they are today
    expect(routeSubmit(input({ text: '/help\nsome notes' }))).toMatchObject({ kind: 'error', keepDraft: true });
    expect(routeSubmit(input({ text: '/steer go\nand then' }), )).toMatchObject({ kind: 'error' });
    expect(routeSubmit(input({ text: '/help\n/exit', multilineArmedAt: null }))).not.toMatchObject({ kind: 'confirm-multiline' });
    // (b) `//` at column 0 — the literal-slash path, and its later lines are still scanned
    expect(routeSubmit(input({ text: '//literal\nplain text', multilineArmedAt: null }))).toMatchObject({ kind: 'submit', full: '/literal\nplain text' });
    expect(routeSubmit(input({ text: '//literal\n/exit', multilineArmedAt: null }))).toMatchObject({ kind: 'confirm-multiline', line: 2 });
    // (c) a pasted code block containing a path, (d) a markdown list — `commandToken` only matches registry names
    expect(routeSubmit(input({ text: 'see\n/usr/bin/env node\nthanks', multilineArmedAt: null }))).toMatchObject({ kind: 'submit' });
    expect(routeSubmit(input({ text: 'steps:\n/ one\n/ two', multilineArmedAt: null }))).toMatchObject({ kind: 'submit' });
    // a line that is a command plus an argument is prose, not a hidden command (only a WHOLE line counts)
    expect(routeSubmit(input({ text: 'hi\n/steer go faster', multilineArmedAt: null }))).toMatchObject({ kind: 'submit' });
    // a single-line draft is never scanned
    expect(hiddenCommandLine('/exit')).toBeNull();
    expect(hiddenCommandLine('hi\n/exit')).toEqual({ line: 2, command: '/exit' });
    expect(hiddenCommandLine('hi\n  /q  ')).toEqual({ line: 2, command: '/q' }); // an alias counts, whitespace-trimmed
    expect(hiddenCommandLine('hi\nthere')).toBeNull();
    expect(hiddenCommandLine('hi\n/nope')).toBeNull();
    // the FIRST hidden line is the one reported
    expect(hiddenCommandLine('a\n/new\n/exit')).toEqual({ line: 2, command: '/new' });
    // a CAPITALISED command line is a command (`dispatchCommand` is case-insensitive, `/EXIT` runs), so the scan is
    // too — comparing the raw line against the lower-cased token made `/EXIT` on line 4 silently prose, which is
    // exactly the defect P-C8 (b) exists to close
    expect(hiddenCommandLine('hi\n/EXIT')).toEqual({ line: 2, command: '/exit' });
    expect(hiddenCommandLine('a\nb\nc\n/Exit')).toEqual({ line: 4, command: '/exit' });
    expect(routeSubmit(input({ text: 'a\nb\nc\n/EXIT', multilineArmedAt: null }))).toMatchObject({ kind: 'confirm-multiline', line: 4, command: '/exit' });
  });
  it('TUI-DESIGN-4 §4.5: `fromPalette` is carried into the dispatch context and is the ONLY thing that arms a confirm', () => {
    expect(routeSubmit(input({ text: '/new', overlay: 'palette', fromPalette: true }))).toMatchObject({ kind: 'command', action: { kind: 'new' }, confirm: 'new' });
    // the palette being OPEN is not provenance: a hand-typed /exit with the card up still exits at once (EXIT_IDLE)
    expect(routeSubmit(input({ text: '/exit', overlay: 'palette' }))).toMatchObject({ kind: 'command', action: { kind: 'exit' }, confirm: null });
    expect(routeSubmit(input({ text: '/exit' }))).toMatchObject({ kind: 'command', action: { kind: 'exit' }, confirm: null });
    // …and a `fromPalette` line typed with NO overlay (the --plain numbered pick) is gated all the same
    expect(routeSubmit(input({ text: '/exit', fromPalette: true }))).toMatchObject({ kind: 'command', confirm: 'exit' });
    expect(routeSubmit(input({ text: '/status', fromPalette: true }))).toMatchObject({ kind: 'command', confirm: null });
    // `/history clear` is destructive but owns its own readline y/N (§4.5), so it is never a `ConfirmKind`: the
    // overlay is never asked to draw a body `confirmRow` cannot produce
    expect(routeSubmit(input({ text: '/history clear', overlay: 'palette', fromPalette: true }))).toMatchObject({ kind: 'command', action: { kind: 'historyClear' }, confirm: null });
  });
  it('is pure: the same input yields the same decision and the input is not mutated', () => {
    const i = input({ text: 'hello [Pasted #1, 1 line]', chips: new Map([[1, 'b']]) });
    const before = JSON.stringify({ ...i, chips: [...i.chips], host: null });
    expect(routeSubmit(i)).toEqual(routeSubmit(i));
    expect(JSON.stringify({ ...i, chips: [...i.chips], host: null })).toBe(before);
  });
});
