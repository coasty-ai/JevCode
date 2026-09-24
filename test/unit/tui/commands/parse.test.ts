/** TUI-DESIGN §19.0 / §19.1: the §5.1 grammar — quotes, escapes, options, errors; an unknown command never submits (see submit.test.ts). */
import { describe, expect, it } from 'vitest';
import { commandToken, isCommandLine, parseCommand, restOf } from '../../../../src/tui/commands/parse.js';

function ok(line: string) {
  const r = parseCommand(line);
  if (!r.ok) throw new Error(`expected ok for ${line}: ${r.reason}`);
  return r.command;
}

describe('parseCommand (TUI-DESIGN §5.1)', () => {
  it('names are case-insensitive [a-z][a-z0-9-]*; bare args split on whitespace', () => {
    expect(ok('/help')).toEqual({ name: 'help', args: [], options: {}, raw: '/help' });
    expect(ok('/HeLp keys')).toEqual({ name: 'help', args: ['keys'], options: {}, raw: '/HeLp keys' });
    expect(ok('  /budget   spend-cap   3  ')).toMatchObject({ name: 'budget', args: ['spend-cap', '3'] });
    expect(ok('/why s7.risk.plan_mismatch').args).toEqual(['s7.risk.plan_mismatch']);
    expect(ok('/x-1 a\tb').args).toEqual(['a', 'b']);
  });
  it('double quotes take escapes, single quotes are literal, quotes may sit mid-line', () => {
    expect(ok('/rename "fix parse_date \\"tz\\""').args).toEqual(['fix parse_date "tz"']);
    expect(ok("/rename 'it''s'").args).toEqual(['it', 's']);
    expect(ok("/rename 'a \"b\" c'").args).toEqual(['a "b" c']);
    expect(ok('/export "a b"c').args).toEqual(['a b', 'c']);
    expect(ok('/export ""').args).toEqual(['']);
    expect(ok('/export "\\\\"').args).toEqual(['\\']);
  });
  it('backslash escapes in bare words; an escaped -- is an argument, not an option', () => {
    expect(ok('/export a\\ b').args).toEqual(['a b']);
    expect(ok('/export \\--not-a-flag').args).toEqual(['--not-a-flag']);
    expect(ok('/export \\"quoted\\"').args).toEqual(['"quoted"']);
  });
  it('--flag and --flag=value become options; later occurrences win; a lone -- is an argument', () => {
    expect(ok('/diff 3 --full --all').options).toEqual({ full: true, all: true });
    expect(ok('/resume fix --sort=created --force').options).toEqual({ sort: 'created', force: true });
    expect(ok('/x --a=1 --a=2').options).toEqual({ a: '2' });
    expect(ok('/x --').args).toEqual(['--']);
    expect(ok('/x --=v').args).toEqual(['--=v']);
  });
  it('errors: unterminated quote, dangling backslash, empty or bad name, not a command', () => {
    expect(parseCommand('/rename "abc')).toEqual({ ok: false, error: 'unterminated quote', name: 'rename', reason: 'unterminated quote' });
    expect(parseCommand("/rename 'abc")).toMatchObject({ ok: false, error: 'unterminated quote' });
    expect(parseCommand('/rename abc\\')).toEqual({ ok: false, error: 'dangling backslash', name: 'rename', reason: 'dangling backslash' });
    expect(parseCommand('/rename "abc\\')).toMatchObject({ ok: false, error: 'dangling backslash' });
    expect(parseCommand('/')).toMatchObject({ ok: false, error: 'empty name', name: null });
    expect(parseCommand('/ help')).toMatchObject({ ok: false, error: 'empty name' });
    expect(parseCommand('/1abc')).toMatchObject({ ok: false, error: 'bad name', name: '1abc' });
    expect(parseCommand('/he lp!')).toMatchObject({ ok: true });
    expect(parseCommand('/hé')).toMatchObject({ ok: false, error: 'bad name' });
    expect(parseCommand('help')).toMatchObject({ ok: false, error: 'not-a-command' });
    expect(parseCommand('//literal')).toMatchObject({ ok: false, error: 'not-a-command' });
    expect(parseCommand('')).toMatchObject({ ok: false, error: 'not-a-command' });
  });
  it('is total over odd input: huge lines, unicode args, NUL, only whitespace', () => {
    const huge = `/rename ${'x'.repeat(100_000)}`;
    expect(ok(huge).args[0]?.length).toBe(100_000);
    expect(ok('/rename 日本語 🎉 "über"').args).toEqual(['日本語', '🎉', 'über']);
    expect(ok('/rename a\u0000b').args).toEqual(['a\u0000b']);
    expect(parseCommand('   ')).toMatchObject({ ok: false });
  });
});

describe('isCommandLine / commandToken / restOf', () => {
  it('a `/` at column 0 is a command line; `//` is the literal-slash escape', () => {
    expect(isCommandLine('/help')).toBe(true);
    expect(isCommandLine('//not')).toBe(false);
    expect(isCommandLine(' /help')).toBe(false);
    expect(isCommandLine('')).toBe(false);
    expect(commandToken('/BuDget spend-cap 3')).toBe('/budget');
    expect(commandToken('/')).toBe('/');
    expect(commandToken('//x')).toBe('');
    expect(commandToken('hello')).toBe('');
  });
  it('restOf returns the trimmed one-line remainder clipped to the cap', () => {
    expect(restOf('/rename   fix   tz  ')).toBe('fix tz');
    expect(restOf('/rename a\nb')).toBe('a b');
    expect(restOf('/rename')).toBe('');
    expect(restOf(`/steer ${'y'.repeat(700)}`).length).toBe(600);
    expect(restOf('/steer abc', 2)).toBe('ab');
  });
});
