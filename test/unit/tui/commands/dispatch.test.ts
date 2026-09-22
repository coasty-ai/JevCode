/**
 * TUI-DESIGN §19.0: `dispatchCommand` — grammar errors become `/<cmd>: <reason>` items, `ArgSpec` validation
 * per kind, `availableDuringTask` sentences verbatim, unknown commands never resolve, every command yields
 * its action descriptor; no import from cli/** (asserted by a source scan).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMMAND_ACTION_KINDS, COMMAND_TOKENS, SUGGEST_MIN_SCORE, UNKNOWN_COMMAND_MAX, argumentCandidates, confirmFor, didYouMean, dispatchCommand, parseCommandLine, resolveRunTarget, unknownCommandText, type CommandAction, type ConfirmKind, type DispatchContext } from '../../../../src/tui/commands/dispatch.js';
import { confirmRow } from '../../../../src/tui/commands/confirm.js';
import { parseCommand } from '../../../../src/tui/commands/parse.js';
import { COMMANDS, findCommand, type CommandSpec } from '../../../../src/tui/commands/registry.js';

const idle: DispatchContext = { run: 'none', step: 7, changedSteps: [3, 5, 7], sessions: [{ id: '20260920-191506-5gnampki', title: 'fix parse_date tz' }, { id: '20260919-101010-abcdefgh', title: 'fix the docs' }, { id: '20260918-101010-abcdefgh', title: 'migrate loader' }] };
const live: DispatchContext = { ...idle, run: 'live' };

function ok(line: string, ctx: DispatchContext = idle) {
  const r = dispatchCommand(line, ctx);
  if (!r.ok) throw new Error(`expected ok for ${line}: ${r.text}`);
  return r.action;
}
function bad(line: string, ctx: DispatchContext = idle): string {
  const r = dispatchCommand(line, ctx);
  if (r.ok) throw new Error(`expected an error for ${line}`);
  expect(r.label).toBe('[ui]');
  return r.text;
}
/** TUI-DESIGN-3 §4.4 F21: the draft flag of an error */
function keeps(line: string, ctx: DispatchContext = idle): boolean {
  const r = dispatchCommand(line, ctx);
  if (r.ok) throw new Error(`expected an error for ${line}`);
  return r.keepDraft;
}

describe('dispatchCommand (TUI-DESIGN §5.1, §5.2)', () => {
  it('an unknown command never resolves: the TUI-DESIGN-4 §3.1.7 shape with the optional `Did you mean` clause', () => {
    // with no clause there is no full stop before the separator — `.` immediately followed by ` · ` reads as a typo
    expect(bad('/foo')).toBe('error: /foo — not a command · type / to list commands');
    expect(bad('/')).toBe('error: / — not a command · type / to list commands');
    expect(bad('/bud')).toBe('error: /bud — not a command. Did you mean /budget? · type / to list commands');
    expect(unknownCommandText('foo')).toBe('error: /foo — not a command · type / to list commands');
    expect(dispatchCommand('hello', idle)).toMatchObject({ ok: false, text: 'error: /hello — not a command · type / to list commands' });
  });
  it('tokeniser errors keep the command name: `/export: unterminated quote`, `dangling backslash`', () => {
    expect(bad('/export "abc')).toBe('error: /export: unterminated quote');
    expect(bad("/export 'abc")).toBe('error: /export: unterminated quote');
    expect(bad('/export abc\\')).toBe('error: /export: dangling backslash');
    expect(bad('/1x')).toMatch(/^error: \/1x: "1x" is not a command name/);
  });
  it('rest commands (/steer, /why, /rename) take the raw remainder: apostrophes, unbalanced quotes and a trailing backslash are text (§5.1 `rest = raw remainder`)', () => {
    expect(ok("/steer don't touch the tests", live)).toEqual({ kind: 'steer', text: "don't touch the tests" });
    expect(ok('/steer say "hello', live)).toEqual({ kind: 'steer', text: 'say "hello' });
    expect(ok('/steer a\\', live)).toEqual({ kind: 'steer', text: 'a\\' });
    expect(ok('/steer --force is not a flag here', live)).toEqual({ kind: 'steer', text: '--force is not a flag here' });
    expect(ok("/why what's this")).toEqual({ kind: 'why', ref: "what's this" });
    expect(ok("/rename it's fine")).toEqual({ kind: 'rename', title: "it's fine" });
    expect(ok('/rename "abc')).toEqual({ kind: 'rename', title: '"abc' });
    expect(ok('/rename keep \\"the\\" backslashes')).toEqual({ kind: 'rename', title: 'keep \\"the\\" backslashes' });
    expect(ok('/Rename  spaced   out ')).toEqual({ kind: 'rename', title: 'spaced out' });
    const p = parseCommandLine("/steer don't");
    expect(p).toEqual({ ok: true, command: { name: 'steer', args: ["don't"], options: {}, raw: "/steer don't" } });
    expect(parseCommandLine('/why')).toMatchObject({ ok: true, command: { name: 'why', args: [] } });
    expect(parseCommandLine('/export "abc')).toMatchObject({ ok: false, error: 'unterminated quote' });
    expect(parseCommandLine('/nope "abc')).toMatchObject({ ok: false, error: 'unterminated quote' }); // unknown names use the grammar
    // a ParsedCommand handed in directly still feeds the rest argument from `raw`
    const parsed = parseCommand('/steer keep going');
    if (parsed.ok) expect(dispatchCommand(parsed.command, live)).toMatchObject({ ok: true, action: { kind: 'steer', text: 'keep going' } });
  });
  it('availableDuringTask: idle commands while live, live commands while idle (verbatim §24)', () => {
    expect(bad('/undo', live)).toBe('error: /undo runs when the run is idle; Esc pauses first');
    expect(bad('/new', live)).toBe('error: /new runs when the run is idle; Esc pauses first');
    expect(bad('/pause')).toBe('error: /pause needs a live run');
    expect(bad('/steer keep going')).toBe('error: /steer needs a live run');
    expect(ok('/pause', live)).toEqual({ kind: 'pause' });
    expect(ok('/pause', { ...idle, run: 'starting' })).toEqual({ kind: 'pause' });
    expect(ok('/diff', live)).toEqual({ kind: 'diff', step: null, full: false, all: false });
    expect(bad('/diff --full', live)).toBe('error: /diff --full runs when the run is idle; Esc pauses first');
    expect(ok('/diff --full --all 3')).toEqual({ kind: 'diff', step: 3, full: true, all: true });
    expect(bad('/diff --nope')).toBe('error: /diff: unknown option --nope');
  });
  it('flags: a value on a boolean flag and a missing or unlisted value on a value flag are errors, never silently false', () => {
    expect(bad('/resume --force=yes')).toBe('error: /resume: --force takes no value');
    expect(bad('/diff --full=1')).toBe('error: /diff: --full takes no value');
    expect(bad('/diff --all=true')).toBe('error: /diff: --all takes no value');
    expect(bad('/resume --sort')).toBe('error: /resume: --sort expects updated|created (--sort=updated)');
    expect(bad('/resume --sort=size')).toBe('error: /resume: --sort expects updated|created, got "size"');
    expect(ok('/resume --sort=created')).toMatchObject({ sort: 'created' });
    expect(ok('/resume --sort=updated --force')).toMatchObject({ sort: 'updated', force: true });
  });
  it('/budget: show, set with kind-specific validation, the design\'s exact error text', () => {
    expect(ok('/budget')).toEqual({ kind: 'budget', set: null });
    expect(ok('/budget spend-cap 3')).toEqual({ kind: 'budget', set: { setting: 'spend-cap', usd: 3 } });
    expect(ok('/budget spend-cap $2.50')).toEqual({ kind: 'budget', set: { setting: 'spend-cap', usd: 2.5 } });
    expect(bad('/budget spend-cap abc')).toBe('error: /budget spend-cap: expected a positive USD amount, got "abc"');
    expect(bad('/budget spend-cap 0')).toBe('error: /budget spend-cap: expected a positive USD amount, got "0"');
    expect(bad('/budget spend-cap -1')).toBe('error: /budget spend-cap: expected a positive USD amount, got "-1"');
    expect(bad('/budget spend-cap')).toBe('error: /budget spend-cap: expected a value');
    expect(ok('/budget session-spend-cap none')).toEqual({ kind: 'budget', set: { setting: 'session-spend-cap', usd: 'none' } });
    expect(ok('/budget session-spend-cap 15')).toEqual({ kind: 'budget', set: { setting: 'session-spend-cap', usd: 15 } });
    expect(bad('/budget spend-cap none')).toBe('error: /budget spend-cap: expected a positive USD amount, got "none"');
    expect(ok('/budget max-steps 14')).toEqual({ kind: 'budget', set: { setting: 'max-steps', n: 14 } });
    expect(bad('/budget max-steps 1.5')).toBe('error: /budget max-steps: expected a positive integer, got "1.5"');
    expect(bad('/budget max-steps 99999999')).toMatch(/expected a positive integer/);
    expect(ok('/budget max-wall 7h30m')).toEqual({ kind: 'budget', set: { setting: 'max-wall', ms: 27_000_000, text: '7h30m' } });
    expect(bad('/budget max-wall soon')).toBe('error: /budget max-wall: expected a duration such as 30m, 7h30m or 90s, got "soon"');
    expect(ok('/budget max-replans 2')).toEqual({ kind: 'budget', set: { setting: 'max-replans', n: 2 } });
    expect(ok('/budget max-generator-tokens 200000')).toEqual({ kind: 'budget', set: { setting: 'max-generator-tokens', n: 200000 } });
    // §9.5: the derived default is spendCapUsd / 15 × 1e6 (a $20 cap → 1,333,333), so the token cap accepts well past 1e6
    expect(ok('/budget max-generator-tokens 1333333')).toEqual({ kind: 'budget', set: { setting: 'max-generator-tokens', n: 1_333_333 } });
    expect(ok('/budget max-generator-tokens 2000000')).toEqual({ kind: 'budget', set: { setting: 'max-generator-tokens', n: 2_000_000 } });
    expect(ok('/budget max-generator-tokens 1000000000')).toEqual({ kind: 'budget', set: { setting: 'max-generator-tokens', n: 1_000_000_000 } });
    expect(bad('/budget max-generator-tokens 1000000001')).toBe('error: /budget max-generator-tokens: expected a positive integer of generator tokens, got "1000000001"');
    expect(bad('/budget max-generator-tokens 0')).toMatch(/expected a positive integer of generator tokens/);
    expect(bad('/budget max-generator-tokens 1e6')).toMatch(/expected a positive integer of generator tokens/);
    expect(bad('/budget max-replans 2000000')).toBe('error: /budget max-replans: expected a positive integer, got "2000000"');
    expect(ok('/budget max-steps 1000000')).toEqual({ kind: 'budget', set: { setting: 'max-steps', n: 1_000_000 } });
    expect(bad('/budget nope 1')).toBe('error: /budget: expected one of spend-cap|session-spend-cap|max-steps|max-wall|max-replans|max-generator-tokens, got "nope"');
    expect(bad('/budget spend-cap 1 2')).toBe('error: /budget: takes at most 2 arguments, got 3');
    expect(ok('/budget spend-cap 3', live)).toEqual({ kind: 'budget', set: { setting: 'spend-cap', usd: 3 } });
  });
  it('step arguments: 1..state.step with changed files', () => {
    expect(ok('/undo')).toEqual({ kind: 'undo', step: null });
    expect(ok('/undo 5')).toEqual({ kind: 'undo', step: 5 });
    expect(bad('/undo 4')).toBe('error: /undo: expected a step 1..7 with changed files, got "4"');
    expect(bad('/undo 8')).toBe('error: /undo: expected a step 1..7 with changed files, got "8"');
    expect(bad('/undo 0')).toMatch(/expected a step 1\.\.7/);
    expect(bad('/undo abc')).toMatch(/got "abc"/);
    expect(bad('/undo 1', { run: 'none', step: 0 })).toBe('error: /undo: expected a step none yet with changed files, got "1"');
    expect(ok('/rewind 3')).toEqual({ kind: 'rewind', step: 3 });
    expect(ok('/rewind 2', { run: 'none', step: 4 })).toEqual({ kind: 'rewind', step: 2 }); // no changedSteps known → any 1..step
    expect(ok('/diff 7')).toEqual({ kind: 'diff', step: 7, full: false, all: false });
  });
  it('run arguments: run id, exact title, unique prefix; ambiguity lists the candidates', () => {
    expect(ok('/resume')).toEqual({ kind: 'resume', target: { kind: 'picker' }, force: false, sort: 'updated' });
    expect(ok('/sessions')).toEqual({ kind: 'resume', target: { kind: 'picker' }, force: false, sort: 'updated' });
    expect(ok('/continue')).toEqual({ kind: 'resume', target: { kind: 'continue' }, force: false, sort: 'updated' });
    expect(ok('/resume 20260920-191506-5gnampki --force')).toEqual({ kind: 'resume', target: { kind: 'run', id: '20260920-191506-5gnampki' }, force: true, sort: 'updated' });
    expect(ok('/resume "fix the docs"')).toMatchObject({ target: { kind: 'run', id: '20260919-101010-abcdefgh' } });
    expect(ok('/resume MIGR')).toMatchObject({ target: { kind: 'run', id: '20260918-101010-abcdefgh' } });
    expect(bad('/resume fix')).toBe('error: /resume: "fix" matches 2 sessions: "fix parse_date tz", "fix the docs"');
    expect(bad('/resume nothing')).toBe('error: /resume: no session matches "nothing"');
    expect(bad('/resume a b')).toBe('error: /resume: takes at most 1 argument, got 2');
    expect(ok('/resume --sort=created')).toMatchObject({ sort: 'created' });
    expect(resolveRunTarget('', [])).toEqual({ ok: false, reason: 'expected a run id or a session title' });
    expect(resolveRunTarget('20260920-191506-5gnampki', undefined)).toEqual({ ok: true, id: '20260920-191506-5gnampki' });
    const many = Array.from({ length: 7 }, (_, i) => ({ id: `id${i}`, title: `task ${i}` }));
    expect(resolveRunTarget('task', many)).toMatchObject({ ok: false, reason: expect.stringMatching(/matches 7 sessions: .*, …$/) });
  });
  it('rest arguments: /rename passes whole (the host clips to 60), /steer and /why ≤ 600 one-line', () => {
    expect(ok('/rename fix   parse_date  "tz"')).toEqual({ kind: 'rename', title: 'fix parse_date "tz"' });
    // TUI-DESIGN-3 §4.4 F13: the dispatcher passes the title whole; the controller clips to 60 once and appends the cut note
    expect((ok(`/rename ${'x'.repeat(100)}`) as { title: string }).title.length).toBe(100);
    expect(bad('/rename')).toBe('error: /rename: expected <title>');
    expect(bad('/rename    ')).toBe('error: /rename: expected <title>');
    expect(ok('/steer keep the CHANGELOG format', live)).toEqual({ kind: 'steer', text: 'keep the CHANGELOG format' });
    expect((ok(`/steer ${'y'.repeat(700)}`, live) as { text: string }).text.length).toBe(600);
    expect(ok('/why s7.risk.plan_mismatch')).toEqual({ kind: 'why', ref: 's7.risk.plan_mismatch' });
    expect(ok('/why 3')).toEqual({ kind: 'why', ref: '3' });
    expect(bad('/why')).toMatch(/^error: \/why: expected <ref\|digit>/);
  });
  it('enum arguments and the remaining commands resolve to their descriptors', () => {
    expect(ok('/help')).toEqual({ kind: 'help', topic: 'all' });
    expect(ok('/help KEYS')).toEqual({ kind: 'help', topic: 'keys' });
    expect(ok('/h reload')).toEqual({ kind: 'help', topic: 'reload' });
    expect(bad('/help nope')).toBe('error: /help: expected one of keys|commands|reload, got "nope"');
    expect(ok('/decisions')).toEqual({ kind: 'decisions', n: 12, stage: null });
    expect(ok('/decisions 5 risk')).toEqual({ kind: 'decisions', n: 5, stage: 'risk' });
    expect(ok('/decisions judge')).toEqual({ kind: 'decisions', n: 12, stage: 'judge' });
    expect(bad('/decisions 0')).toBe('error: /decisions: expected a positive integer, got "0"');
    expect(bad('/decisions nope')).toMatch(/expected a count or a stage/);
    expect(ok('/provider OpenRouter')).toEqual({ kind: 'provider', provider: 'openrouter' });
    expect(bad('/provider gemini')).toBe('error: /provider: expected one of anthropic|openrouter, got "gemini"');
    expect(ok('/mode jev-only')).toEqual({ kind: 'mode', mode: 'jev-only' });
    // TUI-DESIGN-2 §1.3: `/mode` alone shows (null); `/llm on|off` maps onto the mode action; `/panel` and `/transcript` (§4.6, §4.5)
    expect(ok('/mode')).toEqual({ kind: 'mode', mode: null });
    expect(ok('/mode JEV-ON', live)).toEqual({ kind: 'mode', mode: 'jev-on' });
    expect(bad('/mode jev-maybe')).toBe('error: /mode: expected one of jev-only|jev-on|jev-off|llm-jev, got "jev-maybe"');
    expect(bad('/mode jev-on jev-off')).toBe('error: /mode: takes at most 1 argument, got 2');
    expect(ok('/llm on')).toEqual({ kind: 'mode', mode: 'jev-on' });
    expect(ok('/llm OFF', live)).toEqual({ kind: 'mode', mode: 'jev-only' });
    expect(bad('/llm')).toBe('error: /llm: expected <on|off>: on = /mode jev-on, off = /mode jev-only');
    expect(bad('/llm maybe')).toBe('error: /llm: expected one of on|off, got "maybe"');
    expect(ok('/panel')).toEqual({ kind: 'panel', panel: 'toggle' });
    expect(ok('/panel d', live)).toEqual({ kind: 'panel', panel: 'd' });
    expect(ok('/panel OFF')).toEqual({ kind: 'panel', panel: 'off' });
    expect(ok('/panel full')).toEqual({ kind: 'panel', panel: 'full' });
    expect(bad('/panel x')).toBe('error: /panel: expected one of d|p|t|s|off|full, got "x"');
    expect(ok('/transcript')).toEqual({ kind: 'transcript', view: null });
    expect(ok('/transcript full', live)).toEqual({ kind: 'transcript', view: 'full' });
    expect(ok('/transcript compact')).toEqual({ kind: 'transcript', view: 'compact' });
    expect(bad('/transcript all')).toBe('error: /transcript: expected one of compact|full, got "all"');
    expect(ok('/model claude-sonnet-5')).toEqual({ kind: 'model', id: 'claude-sonnet-5' });
    // TUI-DESIGN-3 §4.4 F15: `/model` and `/provider` alone show the current and pending values (null)
    expect(ok('/model')).toEqual({ kind: 'model', id: null });
    expect(ok('/provider')).toEqual({ kind: 'provider', provider: null });
    expect(ok('/ml claude-sonnet-5')).toEqual({ kind: 'model', id: 'claude-sonnet-5' });
    expect(ok('/theme daltonized')).toEqual({ kind: 'theme', theme: 'daltonized' });
    expect(bad('/theme')).toBe('error: /theme: expected one of dark|light|daltonized|ansi');
    expect(ok('/copy')).toEqual({ kind: 'copy', what: 'last' });
    expect(ok('/copy draft')).toEqual({ kind: 'copy', what: 'draft' });
    expect(ok('/logout')).toEqual({ kind: 'logout', which: null });
    expect(ok('/logout jev')).toEqual({ kind: 'logout', which: 'jev' });
    expect(ok('/export')).toEqual({ kind: 'export', file: null });
    expect(ok('/export "notes/session 1.log"')).toEqual({ kind: 'export', file: 'notes/session 1.log' });
    expect(bad('/export .env', { ...idle, isDeniedPath: (p) => p === '.env' })).toBe('error: /export: .env is on the secret denylist; JevCode never writes there');
    expect(ok('/history clear')).toEqual({ kind: 'historyClear' });
    expect(bad('/history')).toBe('error: /history: expected clear');
    expect(bad('/history wipe')).toBe('error: /history: expected clear, got "wipe"');
    expect(ok('/quit')).toEqual({ kind: 'exit' });
    expect(ok('/exit', live)).toEqual({ kind: 'exit' });
    expect(bad('/exit now')).toBe('error: /exit: takes no arguments');
    for (const name of ['new', 'plan', 'calibration', 'jev', 'cost', 'config', 'login', 'trust', 'status', 'errors', 'report', 'editor']) {
      expect(ok(`/${name}`)).toEqual({ kind: name });
    }
    // the no-argument commands by name (G1: every command has its own literal in a test)
    expect(ok('/trust')).toEqual({ kind: 'trust' });
    expect(ok('/calibration')).toEqual({ kind: 'calibration' });
    expect(ok('/report')).toEqual({ kind: 'report' });
    expect(ok('/errors')).toEqual({ kind: 'errors' });
    expect(ok('/config')).toEqual({ kind: 'config' });
    expect(ok('/login')).toEqual({ kind: 'login' });
    expect(ok('/editor')).toEqual({ kind: 'editor' });
    expect(ok('/jev')).toEqual({ kind: 'jev' });
    expect(ok('/plan')).toEqual({ kind: 'plan' });
    expect(ok('/status')).toEqual({ kind: 'status' });
    expect(ok('/new')).toEqual({ kind: 'new' });
    expect(bad('/trust now')).toBe('error: /trust: takes no arguments');
    expect(ok('/unsteer', live)).toEqual({ kind: 'unsteer' });
    expect(ok('/abort', live)).toEqual({ kind: 'abort' });
  });
  it('accepts a ParsedCommand as well as a line, and every registry command dispatches with a valid argument set', () => {
    const p = parseCommand('/budget spend-cap 3');
    expect(p.ok).toBe(true);
    if (p.ok) expect(dispatchCommand(p.command, idle)).toMatchObject({ ok: true, action: { kind: 'budget' } });
    const sample: Record<string, string> = { rename: 'x', steer: 'x', why: '3', budget: '', model: 'm', provider: 'anthropic', mode: 'jev-on', llm: 'on', theme: 'dark', history: 'clear', ui: 'reset' };
    // TUI-DESIGN-3 §8 S4 (G5): the kinds list is exhaustive over the union (compile-time) and every dispatched kind is in it
    const kinds: readonly CommandAction['kind'][] = COMMAND_ACTION_KINDS;
    expect(kinds).toHaveLength(40); // TUI-DESIGN-4: +fullscreen +scrollback +peers +uiReset
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const c of COMMANDS) {
      const ctx = c.availableDuringTask === 'live' ? live : idle;
      const r = dispatchCommand(`/${c.name} ${sample[c.name] ?? ''}`.trim(), ctx);
      expect(r.ok, c.name).toBe(true);
      if (r.ok) {
        expect(r.spec.name).toBe(c.name);
        expect(kinds).toContain(r.action.kind);
      }
    }
    // aliases dispatch to the owner's action
    expect(ok('/s')).toEqual({ kind: 'status' });
    expect(ok('/m jev-on')).toEqual({ kind: 'mode', mode: 'jev-on' });
    expect(ok('/p d')).toEqual({ kind: 'panel', panel: 'd' });
    expect(ok('/tr full')).toEqual({ kind: 'transcript', view: 'full' });
    expect(ok('/q')).toEqual({ kind: 'exit' });
    expect(ok('/nw')).toEqual({ kind: 'new' });
    expect(ok('/r')).toMatchObject({ kind: 'resume', target: { kind: 'picker' } });
  });
  it('TUI-DESIGN-3 §4.4 F21 (D-K): `keepDraft` — fixable errors (unknown command, tokeniser, bad argument, missing value) keep the draft; availability errors (`needs a live run`, `runs when the run is idle`, an idle-only flag while live) clear it', () => {
    expect(keeps('/foo')).toBe(true);
    expect(keeps('/bud')).toBe(true);
    expect(keeps('/export "abc')).toBe(true);
    expect(keeps('/export abc\\')).toBe(true);
    expect(keeps('/budget spend-cap abc')).toBe(true);
    expect(keeps('/budget spend-cap')).toBe(true);
    expect(keeps('/undo 4')).toBe(true);
    expect(keeps('/mode jev-maybe')).toBe(true);
    expect(keeps('/resume nothing')).toBe(true);
    expect(keeps('/exit now')).toBe(true);
    expect(keeps('/diff --nope')).toBe(true);
    expect(keeps('/undo', live)).toBe(false);
    expect(keeps('/new', live)).toBe(false);
    expect(keeps('/pause')).toBe(false);
    expect(keeps('/steer keep going')).toBe(false);
    expect(keeps('/diff --full', live)).toBe(false);
    expect(dispatchCommand('/steer x', idle)).toEqual({ ok: false, text: 'error: /steer needs a live run', label: '[ui]', keepDraft: false });
  });
  it('argumentCandidates offers enum/setting values, changed steps and session titles; a second positional (the /decisions stage) has its own list; rest/text/path arguments have none (TUI-DESIGN-3 §4.3)', () => {
    expect(argumentCandidates(findCommand('budget') as CommandSpec, 0, idle)).toContain('spend-cap');
    expect(argumentCandidates(findCommand('decisions') as CommandSpec, 1, idle)).toEqual(['replan', 'intent', 'context', 'propose', 'risk', 'execute', 'judge', 'complete']);
    expect(argumentCandidates(findCommand('decisions') as CommandSpec, 0, idle)).toEqual([]);
    expect(argumentCandidates(findCommand('budget') as CommandSpec, 1, idle)).toEqual([]);
    expect(argumentCandidates(findCommand('model') as CommandSpec, 0, idle)).toEqual([]);
    expect(argumentCandidates(findCommand('export') as CommandSpec, 0, idle)).toEqual([]);
    expect(argumentCandidates(findCommand('steer') as CommandSpec, 0, live)).toEqual([]);
    expect(argumentCandidates(findCommand('theme') as CommandSpec, 0, idle)).toEqual(['dark', 'light', 'daltonized', 'ansi']);
    expect(argumentCandidates(findCommand('resume') as CommandSpec, 0, { run: 'none', step: 0, sessions: [{ id: '20260920-191506-5gnampki', title: '' }] })).toEqual(['20260920-191506-5gnampki']);
    expect(argumentCandidates(findCommand('undo') as CommandSpec, 0, idle)).toEqual(['3', '5', '7']);
    expect(argumentCandidates(findCommand('undo') as CommandSpec, 0, { run: 'none', step: 3 })).toEqual(['1', '2', '3']);
    expect(argumentCandidates(findCommand('resume') as CommandSpec, 0, idle)).toEqual(['fix parse_date tz', 'fix the docs', 'migrate loader']);
    expect(argumentCandidates(findCommand('rename') as CommandSpec, 0, idle)).toEqual([]);
    expect(argumentCandidates(findCommand('help') as CommandSpec, 3, idle)).toEqual([]);
    expect(COMMAND_TOKENS).toContain('/quit');
    expect(COMMAND_TOKENS).toContain('/sessions');
    expect(COMMAND_TOKENS).toContain('/llm');
    expect(argumentCandidates(findCommand('mode') as CommandSpec, 0, idle)).toEqual(['jev-only', 'jev-on', 'jev-off', 'llm-jev']);
    expect(argumentCandidates(findCommand('panel') as CommandSpec, 0, idle)).toEqual(['d', 'p', 't', 's', 'off', 'full']);
  });
  it('TUI-DESIGN-4 §3.1.7 "Did you mean": `rank(token, command names)` at or above the word-prefix band (700), the best AVAILABLE match preferred, and no clause when nothing clears it', () => {
    expect(didYouMean('bud')?.name).toBe('budget');
    expect(didYouMean('renam')?.name).toBe('rename');
    expect(didYouMean('hel')?.name).toBe('help');
    expect(didYouMean('exi')?.name).toBe('exit');
    expect(didYouMean('/bud')?.name).toBe('budget'); // the slash is stripped before ranking
    expect(didYouMean('BUD')?.name).toBe('budget'); // case-folded
    // a wrong guess is worse than none: `xyzzy` (and `bogus`, which is not a subsequence of any name) get no clause
    expect(didYouMean('xyzzy')).toBeNull();
    expect(didYouMean('bogus')).toBeNull();
    expect(didYouMean('')).toBeNull();
    expect(didYouMean('/')).toBeNull();
    expect(SUGGEST_MIN_SCORE).toBe(700);
    // §3.1.7's pool is "41 names + 21 aliases": a hit on an ALIAS resolves to its owner
    expect(didYouMean('qui')?.name).toBe('exit'); // `quit`, an alias of /exit
    expect(didYouMean('nw')?.name).toBe('new'); // an exact alias never reaches this path in the product, but it ranks
    expect(didYouMean('cf')?.name).toBe('config');
    // `rank` is a subsequence scorer, so a typo that ADDS a letter clears nothing: `/quitt`, `/budgett`, `/bogus`
    for (const t of ['quitt', 'budgett', 'undoo', 'cost2']) expect(didYouMean(t), t).toBeNull();
    // prefer the best match that is AVAILABLE now, and fall back to the best overall WITH the availability note
    expect(didYouMean('abor', true)?.name).toBe('abort');
    expect(didYouMean('abor', false)?.name).toBe('abort');
    // `un` ranks /undo (idle only) first and /unsteer (live only) second, so the preference flips with the phase
    expect(didYouMean('un', false)?.name).toBe('undo');
    expect(didYouMean('un', true)?.name).toBe('unsteer');
    // the fall-back carries the note, so the user is not sent into `/x needs a live run` on the next Enter
    expect(unknownCommandText('/stee', false)).toBe('error: /stee — not a command. Did you mean /steer? (live only) · type / to list commands');
    expect(unknownCommandText('/stee', true)).toBe('error: /stee — not a command. Did you mean /steer? · type / to list commands');
    expect(unknownCommandText('/und', true)).toBe('error: /und — not a command. Did you mean /undo? (idle only) · type / to list commands');
    // the whole rejected line is quoted, clipped at 80 — the measured `/bogus/steer` cascade stays legible
    expect(unknownCommandText('/bogus/steer')).toBe('error: /bogus/steer — not a command · type / to list commands');
    const long = `/${'z'.repeat(200)}`;
    expect(unknownCommandText(long).startsWith(`error: ${long.slice(0, UNKNOWN_COMMAND_MAX - 1)}…`)).toBe(true);
    expect(UNKNOWN_COMMAND_MAX).toBe(80);
  });
  it('TUI-DESIGN-4 §4.5 (D-X): `confirm` is non-null only for a destructive command reached through a SELECTION surface', () => {
    const sel: DispatchContext = { ...idle, fromPalette: true };
    const selLive: DispatchContext = { ...live, fromPalette: true };
    expect(dispatchCommand('/new', sel)).toMatchObject({ ok: true, confirm: 'new' });
    expect(dispatchCommand('/exit', sel)).toMatchObject({ ok: true, confirm: 'exit' });
    expect(dispatchCommand('/abort', selLive)).toMatchObject({ ok: true, confirm: 'abort' });
    // `/history clear` is destructive AND has no rung ladder: §4.5 gives it its own readline `y/N` (`session.ts`,
    // `prompter?.historyClear`), so `confirm` is null and no overlay is ever asked to draw an empty body
    expect(dispatchCommand('/history clear', sel)).toMatchObject({ ok: true, action: { kind: 'historyClear' }, confirm: null });
    // the alias reaches the same gate (the owner is what carries `destructive`)
    expect(dispatchCommand('/q', sel)).toMatchObject({ ok: true, action: { kind: 'exit' }, confirm: 'exit' });
    expect(dispatchCommand('/nw', sel)).toMatchObject({ ok: true, action: { kind: 'new' }, confirm: 'new' });
    // a HAND-TYPED line is never gated — the risk is mis-selection, not mis-typing (EXIT_IDLE, test/pty/helpers.ts:789)
    for (const line of ['/new', '/exit', '/q', '/history clear']) expect(dispatchCommand(line, idle), line).toMatchObject({ ok: true, confirm: null });
    expect(dispatchCommand('/abort', live)).toMatchObject({ ok: true, confirm: null });
    // and a non-destructive command is never gated, selection surface or not
    for (const line of ['/status', '/cost', '/help', '/undo']) expect(dispatchCommand(line, sel), line).toMatchObject({ ok: true, confirm: null });
    // exactly four specs carry `destructive`
    expect(COMMANDS.filter((c) => c.destructive === true).map((c) => c.name)).toEqual(['new', 'abort', 'history', 'exit']);
    // `confirmFor` reads the ACTION, so a `/history` that never resolved to `historyClear` cannot reach a confirm row
    const hist = findCommand('history') as CommandSpec;
    expect(confirmFor(hist, { kind: 'historyClear' }, true)).toBeNull();
    expect(confirmFor(hist, { kind: 'status' }, true)).toBeNull();
    expect(confirmFor(hist, { kind: 'historyClear' }, false)).toBeNull();
    // every `ConfirmKind` `confirmFor` can produce has a ladder — `confirmRow` is total, so S1 can render it
    // unconditionally (the null-body overlay of the review is structurally impossible)
    const news = findCommand('new') as CommandSpec;
    for (const k of [confirmFor(news, { kind: 'new' }, true), confirmFor(findCommand('exit') as CommandSpec, { kind: 'exit' }, true)]) {
      expect(k).not.toBeNull();
      expect(confirmRow(k as ConfirmKind, 76).length).toBeGreaterThan(0);
    }
    // a `/history` that failed validation is an error, not an action, so it never reaches the gate at all
    expect(dispatchCommand('/history', sel)).toMatchObject({ ok: false });
    expect(dispatchCommand('/history nope', sel)).toMatchObject({ ok: false });
  });
  it('TUI-DESIGN-4 §1.3.1 / §1.3.4 / §7.10 / §7.1: the four new commands dispatch, and `/ui` takes only `reset`', () => {
    expect(ok('/fullscreen')).toEqual({ kind: 'fullscreen' });
    expect(ok('/scrollback')).toEqual({ kind: 'scrollback' });
    expect(ok('/peers')).toEqual({ kind: 'peers' });
    expect(ok('/ui reset')).toEqual({ kind: 'uiReset' });
    expect(bad('/ui')).toBe('error: /ui: expected reset');
    expect(bad('/ui nope')).toBe('error: /ui: expected reset, got "nope"');
    expect(keeps('/ui nope')).toBe(true);
    expect(bad('/peers now')).toMatch(/^error: \/peers/);
  });
  it('dispatch.ts never imports cli/** (the controller depends on it, not the reverse)', () => {
    const src = readFileSync(fileURLToPath(new URL('../../../../src/tui/commands/dispatch.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/from '[^']*\/cli\//);
    for (const f of ['parse', 'registry', 'fuzzy', 'palette', 'local']) {
      const s = readFileSync(fileURLToPath(new URL(`../../../../src/tui/commands/${f}.ts`, import.meta.url)), 'utf8');
      expect(s, f).not.toMatch(/from '[^']*\/cli\//);
      expect(s, f).not.toMatch(/from 'ink'|from 'react'/);
    }
  });
});
