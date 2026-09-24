/**
 * TUI-DESIGN-3 §4.3 / §4.4 F14, F20 / §4.1 rule 6 `local.ts`: `completeDraft` completes the name or the argument under the cursor
 * and never wipes a typed argument (R4 F4: `/budget spend-cap` + Tab keeps the value); enum, setting, step and run candidates;
 * a `run` title with spaces is inserted quoted; cycling through `selected` with the remembered stem; rest/text/path arguments
 * toast `no completions for <arg>`; `argumentGhost` after an accepted value; `draftTokens` positions; `dispatchCtxOf` prefers
 * the host's context and reads `run: 'none'` while a chat request thinks; `recentCommands` over history entries and records.
 */
import { describe, expect, it } from 'vitest';
import type { SessionRow } from '../../../../src/core/types.js';
import type { DispatchContext } from '../../../../src/tui/commands/dispatch.js';
import { argumentGhost, chatThinking, completeDraft, dispatchCtxOf, draftTokens, noCompletionsToast, quoteCandidate, recentCommands, runIsLive, type CompletionContext } from '../../../../src/tui/commands/local.js';
import type { PaletteState } from '../../../../src/tui/commands/palette.js';

const palette: PaletteState = { lastStop: null, unauthorized: false, changedFiles: false, rewindMenu: false, live: false };
const dispatch: DispatchContext = { run: 'none', step: 7, changedSteps: [3, 5, 7], sessions: [{ id: '20260920-191506-5gnampki', title: 'fix parse_date tz' }, { id: '20260919-101010-abcdefgh', title: 'fix the docs' }, { id: '20260918-101010-abcdefgh', title: 'migrate loader' }, { id: '20260917-101010-abcdefgh', title: '' }] };
const ctx: CompletionContext = { dispatch, palette };
const tab = (draft: string, cursor = draft.length, selected = 0, stem?: string) => completeDraft(draft, cursor, 1, ctx, selected, stem);

describe('completeDraft (TUI-DESIGN-3 §4.3; fixes R4 F4)', () => {
  it('the cursor inside or right after the name token completes the command as today (`/name `), keeping a tail; an unknown name is ignored', () => {
    expect(tab('/bud')).toEqual({ kind: 'command', text: '/budget ', cursor: 8, name: 'budget' });
    expect(tab('/', 1)).toMatchObject({ kind: 'command', text: '/help ' }); // the first Popular row
    expect(tab('/m')).toEqual({ kind: 'command', text: '/mode ', cursor: 6, name: 'mode' }); // the exact alias pins /mode
    expect(tab('/m', 2, 1)).toMatchObject({ kind: 'command', name: 'model' }); // `selected` = the highlighted palette row
    expect(tab('/bud spend-cap 3', 4)).toEqual({ kind: 'command', text: '/budget spend-cap 3', cursor: 8, name: 'budget' });
    expect(tab('/zzz')).toEqual({ kind: 'ignore' });
    expect(tab('hello')).toEqual({ kind: 'ignore' });
    expect(tab('//literal')).toEqual({ kind: 'ignore' });
  });
  it('`/budget sp` Tab → `/budget spend-cap ` (the only prefix match is accepted with a space); the value is never wiped', () => {
    expect(tab('/budget sp')).toEqual({ kind: 'argument', text: '/budget spend-cap ', cursor: 18, candidates: ['spend-cap'], selected: 0, stem: 'sp', arg: 'setting', accepted: true });
    // F4's measured regression: `› /budget spend-cap` + Tab must not become `› /budget `
    expect(tab('/budget spend-cap')).toEqual({ kind: 'argument', text: '/budget spend-cap ', cursor: 18, candidates: ['spend-cap'], selected: 0, stem: 'spend-cap', arg: 'setting', accepted: true });
    expect(tab('/budget SPEND-CAP')).toMatchObject({ kind: 'argument', text: '/budget spend-cap ', accepted: true });
    // the tail after the cursor is kept: Tab on `spend-cap` with a value after it replaces only that token
    expect(tab('/budget sp 3', 10)).toMatchObject({ kind: 'argument', text: '/budget spend-cap  3', cursor: 18 });
    expect(tab('/budget spend-cap 3', 17)).toMatchObject({ kind: 'argument', text: '/budget spend-cap  3', cursor: 18 });
  });
  it('several candidates cycle: `/budget s` Tab → spend-cap (no space), the next Tabs with the remembered stem walk the ranked list and wrap; Shift+Tab is the caller\'s `selected − 1`', () => {
    const first = tab('/budget s');
    expect(first).toMatchObject({ kind: 'argument', text: '/budget spend-cap', cursor: 17, selected: 0, stem: 's', accepted: false });
    if (first.kind !== 'argument') throw new Error('argument expected');
    expect(first.candidates.slice(0, 2)).toEqual(['spend-cap', 'session-spend-cap']);
    const n = first.candidates.length;
    const second = tab(first.text, first.cursor, 1, first.stem);
    expect(second).toMatchObject({ kind: 'argument', text: '/budget session-spend-cap', selected: 1, stem: 's', accepted: false, candidates: first.candidates });
    const wrapped = tab(first.text, first.cursor, n, first.stem);
    expect(wrapped).toMatchObject({ text: '/budget spend-cap', selected: 0 });
    const back = tab(first.text, first.cursor, -1, first.stem);
    expect(back).toMatchObject({ selected: n - 1, text: `/budget ${first.candidates[n - 1] as string}` });
    // an empty partial lists every value in registry order
    expect(tab('/budget ')).toMatchObject({ kind: 'argument', text: '/budget spend-cap', candidates: ['spend-cap', 'session-spend-cap', 'max-steps', 'max-wall', 'max-replans', 'max-generator-tokens'], accepted: false });
    // AGENT-LOOP-DESIGN §14.1: `/mode` lists agent · jev-only · legacy
    expect(tab('/mode ', 6, 2)).toMatchObject({ kind: 'argument', text: '/mode legacy', selected: 2 });
  });
  it('`/decisions 5 ri` Tab → the stage candidates at index 1 (`risk `); `--flags` are skipped when counting positionals', () => {
    expect(tab('/decisions 5 ri')).toEqual({ kind: 'argument', text: '/decisions 5 risk ', cursor: 18, candidates: ['risk'], selected: 0, stem: 'ri', arg: 'stage', accepted: true });
    expect(tab('/decisions 5 ')).toMatchObject({ kind: 'argument', arg: 'stage', candidates: ['replan', 'intent', 'context', 'propose', 'risk', 'execute', 'judge', 'complete'] });
    expect(tab('/decisions ')).toEqual({ kind: 'none', toast: 'no completions for n' }); // an int argument has no candidates
    expect(tab('/resume --force fi')).toMatchObject({ kind: 'argument', arg: 'run' });
    expect(tab('/resume --force')).toEqual({ kind: 'none', toast: 'no completions for --force' });
    expect(tab('/diff --all 3')).toMatchObject({ kind: 'argument', text: '/diff --all 3 ', accepted: true });
  });
  it('step and run candidates: changed steps only; a session title with spaces is inserted quoted (`/resume "fix the docs" `), an untitled session by id', () => {
    expect(tab('/undo ')).toMatchObject({ kind: 'argument', candidates: ['3', '5', '7'], text: '/undo 3', accepted: false });
    expect(tab('/undo 5')).toEqual({ kind: 'argument', text: '/undo 5 ', cursor: 8, candidates: ['5'], selected: 0, stem: '5', arg: 'n', accepted: true });
    expect(tab('/rewind 7')).toMatchObject({ text: '/rewind 7 ' });
    expect(tab('/resume "fix the d')).toEqual({ kind: 'argument', text: '/resume "fix the docs" ', cursor: 23, candidates: ['fix the docs'], selected: 0, stem: 'fix the d', arg: 'run', accepted: true });
    expect(tab('/resume migr')).toEqual({ kind: 'argument', text: '/resume "migrate loader" ', cursor: 25, candidates: ['migrate loader'], selected: 0, stem: 'migr', arg: 'run', accepted: true });
    expect(tab('/resume fix')).toMatchObject({ kind: 'argument', text: '/resume "fix the docs"', accepted: false, candidates: ['fix the docs', 'fix parse_date tz'] }); // two prefix matches: the shorter ranks first, no space, the next Tab cycles
    expect(tab('/resume 2026')).toMatchObject({ kind: 'argument', text: '/resume 20260917-101010-abcdefgh ', accepted: true });
    expect(quoteCandidate('a "b" \\c')).toBe('"a \\"b\\" \\\\c"');
    expect(quoteCandidate('plain')).toBe('plain');
  });
  it('rest, text and path arguments have no candidates → `none` with `no completions for <arg>`; nothing matched → the same toast; past the last argument → the command is named', () => {
    expect(tab('/rename fo')).toEqual({ kind: 'none', toast: 'no completions for title' });
    expect(tab('/steer go')).toEqual({ kind: 'none', toast: 'no completions for text' });
    expect(tab('/why s7')).toEqual({ kind: 'none', toast: 'no completions for ref' });
    expect(tab('/model cl')).toEqual({ kind: 'none', toast: 'no completions for id' });
    expect(tab('/export not')).toEqual({ kind: 'none', toast: 'no completions for file' });
    expect(tab('/budget spend-cap 3', 19)).toEqual({ kind: 'none', toast: 'no completions for value' });
    expect(tab('/theme zz')).toEqual({ kind: 'none', toast: 'no completions for theme' });
    expect(tab('/status x')).toEqual({ kind: 'none', toast: 'no completions for /status' });
    expect(noCompletionsToast('setting')).toBe('no completions for setting');
  });
  it('argumentGhost: after an accepted value the value hint ghosts (`<usd>` after `/budget spend-cap `), else the next argument\'s hint; null elsewhere', () => {
    expect(argumentGhost('/budget spend-cap ', 18)).toBe('<usd>');
    expect(argumentGhost('/budget max-wall ', 17)).toBe('<dur>');
    expect(argumentGhost('/budget max-steps ', 18)).toBe('<n>');
    expect(argumentGhost('/decisions 5 ', 13)).toBe('[stage]');
    expect(argumentGhost('/budget ', 8)).toBe('[setting <v>]');
    expect(argumentGhost('/budget spend-cap', 17)).toBeNull();
    expect(argumentGhost('/budget spend-cap 3 ', 20)).toBeNull();
    expect(argumentGhost('/status ', 8)).toBeNull();
    expect(argumentGhost('/steer ', 7)).toBeNull();
    expect(argumentGhost('hello ', 6)).toBeNull();
  });
  it('draftTokens: name and argument spans with quotes unwrapped and escapes removed; an unterminated quote runs to the end', () => {
    expect(draftTokens('/budget spend-cap 3')).toEqual({ name: { start: 0, end: 7, raw: '/budget', value: 'budget', flag: false }, args: [{ start: 8, end: 17, raw: 'spend-cap', value: 'spend-cap', flag: false }, { start: 18, end: 19, raw: '3', value: '3', flag: false }] });
    expect(draftTokens('  /Resume "fix the docs" --force')).toMatchObject({ name: { start: 2, end: 9, value: 'resume' }, args: [{ start: 10, end: 24, raw: '"fix the docs"', value: 'fix the docs', flag: false }, { start: 25, end: 32, raw: '--force', flag: true }] });
    expect(draftTokens('/export "a\\"b')).toMatchObject({ args: [{ raw: '"a\\"b', value: 'a"b' }] });
    expect(draftTokens("/export 'x y'")).toMatchObject({ args: [{ value: 'x y' }] });
    expect(draftTokens('/steer a\\ b')).toMatchObject({ args: [{ raw: 'a\\ b', value: 'a b' }] });
    expect(draftTokens('hello')).toEqual({ name: null, args: [] });
    expect(draftTokens('//x')).toEqual({ name: null, args: [] });
  });
});

describe('dispatchCtxOf (TUI-DESIGN-3 §4.4 F20 / F14) and chatThinking', () => {
  const state = { run: 'none' as const, step: 7, changedSteps: [3, 7], thinking: null };
  const rows: SessionRow[] = [{ sessionId: 's1', workspace: '/w', title: 'fix the docs', task60: '', runs: [], lastUsed: '', createdAt: '', totalUsd: 0, mode: 'jev-on', branch: null }];
  it('prefers the host\'s dispatchContext (denylist, run ids) and falls back to the App\'s fold (`sessions[].id = sessionId`); no host → no sessions', () => {
    const denied = (rel: string): boolean => rel === '.env';
    const withCtx = { index: () => rows, dispatchContext: () => ({ step: 9, changedSteps: [9], sessions: [{ id: 'run-9', title: 'fix the docs' }], isDeniedPath: denied }) };
    expect(dispatchCtxOf(withCtx, state)).toEqual({ run: 'none', step: 9, changedSteps: [9], sessions: [{ id: 'run-9', title: 'fix the docs' }], isDeniedPath: denied });
    const fold = { index: () => rows };
    expect(dispatchCtxOf(fold, state)).toEqual({ run: 'none', step: 7, changedSteps: [3, 7], sessions: [{ id: 's1', title: 'fix the docs' }] });
    expect(dispatchCtxOf(null, state)).toEqual({ run: 'none', step: 7, changedSteps: [3, 7] });
  });
  it('the run phase is the App\'s, read as `none` while a chat request is thinking (a chat request is not a run); a live run keeps its phase', () => {
    expect(dispatchCtxOf(null, { ...state, run: 'live' }).run).toBe('live');
    expect(dispatchCtxOf(null, { ...state, run: 'starting', thinking: 'intake' }).run).toBe('none');
    expect(dispatchCtxOf(null, { ...state, run: 'starting', thinking: null }).run).toBe('starting');
    expect(dispatchCtxOf(null, { ...state, run: 'live', thinking: 'intake' }).run).toBe('live');
    expect(chatThinking({ run: 'starting', thinking: 'intake' })).toBe(true);
    expect(chatThinking({ run: 'none', thinking: 'lookup' })).toBe(true);
    expect(chatThinking({ run: 'live', thinking: 'intake' })).toBe(false);
    expect(chatThinking({ run: 'starting', thinking: null })).toBe(false);
    expect(runIsLive('pausing')).toBe(true);
    expect(runIsLive('starting')).toBe(false);
  });
});

describe('recentCommands (TUI-DESIGN-3 §4.1 rule 6)', () => {
  it('the last ≤ 3 distinct command owners, newest first; aliases resolve; prompts, unknown commands and literal-slash prompts are skipped; records filter to kind === command', () => {
    expect(recentCommands(['fix the bug', '/cost', '/status', '/c', '/help'])).toEqual(['help', 'cost', 'status']);
    expect(recentCommands(['/cost', '/status'])).toEqual(['status', 'cost']);
    expect(recentCommands(['/nope', '/usr/bin/env is the shebang', 'exit', '/undo 3', '/UNDO'])).toEqual(['undo']);
    expect(recentCommands([])).toEqual([]);
    expect(recentCommands(['/cost', '/status', '/mode', '/help'], 2)).toEqual(['help', 'mode']);
    expect(recentCommands([{ kind: 'prompt', text: '/not a command entry' }, { kind: 'command', text: '/s' }, { kind: 'steer', text: '/cost' }, { kind: 'command', text: '/m jev-on' }])).toEqual(['mode', 'status']);
  });
});
