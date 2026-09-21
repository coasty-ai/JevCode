/**
 * TUI-DESIGN §5.3: palette rows (≤ 8, Suggested group first, score order, aliases hidden, `(idle only)` /
 * `(live only)`, argument sub-rows, footer `(i/N)  Tab completes · Enter runs an exact match · Esc closes`
 * with ▲/▼), the F-K frame verbatim at 80 columns (a live run after a spend_cap stop), ghost text, width
 * parity of `cells()`/`cut()` with string-width over every title, hint and help line, and the help block
 * (≤ 60 lines, §24 notes).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildBindings } from '../../../../src/tui/keys/bindings.js';
import { HELP_COMPACTION_LEVELS, HELP_MAX_LINES, HELP_NOTES, HELP_POINTER, PALETTE_FOOTER, cells, cut, cutTitle, helpLines, isSuggested, paletteGhost, paletteLines, paletteMatches, paletteRows, type PaletteState } from '../../../../src/tui/commands/palette.js';
import { COMMANDS, findCommand, type CommandSpec } from '../../../../src/tui/commands/registry.js';

const DESIGN = fileURLToPath(new URL('../../../../docs/TUI-DESIGN.md', import.meta.url));

const idleAfterStop: PaletteState = { lastStop: 'max_steps', unauthorized: false, changedFiles: true, rewindMenu: false, live: false };
const fresh: PaletteState = { lastStop: null, unauthorized: false, changedFiles: false, rewindMenu: false, live: false };
const live: PaletteState = { ...fresh, live: true };
const afterSpendCap: PaletteState = { ...idleAfterStop, lastStop: 'spend_cap' };
/** F-K (§2.3): the palette is open on `/b` while a run is live (status `palette … step 7/7 … run $0.31/2.00 ok`, no `done`), the previous run stopped on spend_cap */
const frameFK: PaletteState = { lastStop: 'spend_cap', unauthorized: false, changedFiles: true, rewindMenu: false, live: true };

/** the palette rows of the F-K fence (the 8 rows between the pane's blank rows and the composer) */
function frameFKRows(): string[] {
  const lines = readFileSync(DESIGN, 'utf8').split('\n');
  const at = lines.findIndex((l) => l.startsWith('**F-K.'));
  expect(at).toBeGreaterThan(0);
  let k = at + 1;
  while (lines[k] !== '```') k++;
  const body: string[] = [];
  for (k++; lines[k] !== '```'; k++) body.push(lines[k] as string);
  const start = body.findIndex((l) => l.startsWith('▌ /budget'));
  return body.slice(start, start + 8);
}

describe('paletteMatches (TUI-DESIGN §5.3)', () => {
  it('empty query lists every command in table order, Suggested first; aliases never appear as rows', () => {
    const all = paletteMatches('', fresh);
    expect(all.map((m) => m.spec.name)).toEqual(COMMANDS.map((c) => c.name));
    expect(all.some((m) => m.spec.name === 'quit')).toBe(false);
    const after = paletteMatches('', idleAfterStop);
    expect(after.slice(0, 2).map((m) => m.spec.name)).toEqual(['resume', 'undo']);
    expect(after[0]?.suggested).toBe(true);
  });
  it('`/b` after a spend_cap stop: /budget (Suggested) first, then /abort and /calibration by score', () => {
    const m = paletteMatches('/b', afterSpendCap);
    expect(m.slice(0, 3).map((x) => x.spec.name)).toEqual(['budget', 'abort', 'calibration']);
    expect(m[0]?.suggested).toBe(true);
    expect(m[1]?.suggested).toBe(false);
    expect(m[0]?.spans).toEqual([[1, 2]]);
  });
  it('an alias typed exactly resolves to its command; a query that matches nothing yields no rows', () => {
    expect(paletteMatches('quit', fresh).map((m) => m.spec.name)).toEqual(['exit']);
    expect(paletteMatches('sess', fresh).map((m) => m.spec.name)).toEqual(['resume']);
    expect(paletteMatches('zzz', fresh)).toEqual([]);
  });
  it('the Esc Esc menu restricts the palette to /rewind /undo /resume /new with /rewind suggested', () => {
    const m = paletteMatches('', { ...idleAfterStop, rewindMenu: true });
    expect(m.map((x) => x.spec.name).sort()).toEqual(['new', 'resume', 'rewind', 'undo']);
    expect(m[0]?.spec.name).toBe('resume');
    expect(m.find((x) => x.spec.name === 'rewind')?.suggested).toBe(true);
  });
  it('isSuggested keys on state: /resume after any stop, /budget after spend_cap|token_cap, /login after 401, /undo with changed files while idle', () => {
    const s = (n: string): CommandSpec => findCommand(n) as CommandSpec;
    expect(isSuggested(s('resume'), idleAfterStop)).toBe(true);
    expect(isSuggested(s('resume'), fresh)).toBe(false);
    expect(isSuggested(s('budget'), afterSpendCap)).toBe(true);
    expect(isSuggested(s('budget'), { ...afterSpendCap, lastStop: 'token_cap' })).toBe(true);
    expect(isSuggested(s('budget'), idleAfterStop)).toBe(false);
    expect(isSuggested(s('login'), { ...fresh, unauthorized: true })).toBe(true);
    expect(isSuggested(s('undo'), idleAfterStop)).toBe(true);
    expect(isSuggested(s('undo'), { ...idleAfterStop, live: true })).toBe(false);
    expect(isSuggested(s('help'), idleAfterStop)).toBe(false);
  });
});

describe('paletteRows / paletteLines', () => {
  it('F-K verbatim: `/b` at 80×8 while live after a spend_cap stop → /budget Suggested with the `…)` cut, /abort untagged, /calibration (idle only), 4 sub-rows, footer (1/3)', () => {
    const lines = paletteLines('/b', frameFK, 0, 8, 80);
    expect(lines).toHaveLength(8);
    for (const l of lines) expect(cells(l)).toBeLessThanOrEqual(80);
    expect(lines[0]).toBe('▌ /budget        show or set caps (spend-cap, session-spend-cap, …)  Suggested');
    expect(lines[1]).toBe('  /abort         stop the run now (= Esc Esc); the step in flight is discarded');
    expect(lines[2]).toBe('  /calibration   reliability bins, ECE and near-threshold counts (idle only)');
    expect(lines[3]).toBe('  /budget spend-cap <usd>            run cap for the next /resume or run');
    expect(lines[4]).toBe('  /budget session-spend-cap <usd>    session cap, applies now');
    expect(lines[5]).toBe('  /budget max-steps <n>              step limit for the next /resume or run');
    expect(lines[6]).toBe('  /budget max-wall <dur>             wall limit for the next /resume or run');
    expect(lines[7]).toBe(`  (1/3)  ${PALETTE_FOOTER}`);
    // and against the design document itself, so the frame and the renderer can never drift apart
    expect(lines).toEqual(frameFKRows());
    const rows = paletteRows('/b', frameFK, 0, 8, 80);
    expect(rows.map((r) => r.dim)).toEqual([false, false, true, false, false, false, false, false]);
    expect(rows[0]?.suggested).toBe(true);
    expect(rows[0]?.spans).toEqual([[3, 4]]); // the `b` of /budget after `▌ /`
  });
  it('idle after a plain stop (the same query): /budget is not Suggested, /abort is (live only), /calibration is untagged', () => {
    const lines = paletteLines('/b', idleAfterStop, 0, 8, 80);
    expect(lines[0]).toBe('▌ /budget        show or set caps (spend-cap, session-spend-cap, max-steps, …)');
    expect(lines[1]).toBe('  /abort         stop the run now (= Esc Esc); the step in flight i… (live only)'); // the tag costs 12 cells: a plain cut (the parenthesis is not a trailing list)
    expect(lines[2]).toBe('  /calibration   reliability bins, ECE and near-threshold counts');
    expect(paletteRows('/b', idleAfterStop, 0, 8, 80).map((r) => r.dim).slice(0, 3)).toEqual([false, true, false]);
  });
  it('cutTitle cuts a parenthesised list at a comma and closes it `…)`; other titles cut by cell; whole titles pass through', () => {
    const t = 'show or set caps (spend-cap, session-spend-cap, max-steps, max-wall, max-replans)';
    expect(cutTitle(t, 52)).toBe('show or set caps (spend-cap, session-spend-cap, …)');
    expect(cutTitle(t, 50)).toBe('show or set caps (spend-cap, session-spend-cap, …)');
    expect(cutTitle(t, 49)).toBe('show or set caps (spend-cap, …)');
    expect(cutTitle(t, 31)).toBe('show or set caps (spend-cap, …)');
    expect(cutTitle(t, 30)).toBe('show or set caps (…)'); // no whole item fits: the parenthetical is elided
    expect(cutTitle(t, 20)).toBe('show or set caps (…)');
    expect(cutTitle(t, 19)).toBe('show or set caps (…'); // even `(…)` does not fit: the plain cell cut
    expect(cutTitle(t, 18)).toBe('show or set caps …');
    expect(cutTitle(t, 200)).toBe(t);
    expect(cutTitle(t, 52, true)).toBe('show or set caps (spend-cap, session-spend-cap, ...)');
    expect(cutTitle('no parens here at all', 10)).toBe('no parens…');
    expect(cutTitle('(leading) paren', 8)).toBe('(leadin…'); // a leading parenthesis is not a trailing list: plain cut
    expect(cutTitle('restore the files a step changed (verify-before-write)', 52)).toBe('restore the files a step changed (…)');
    expect(cutTitle('restore the files a step changed (verify-before-write)', 20)).toBe('restore the files a…');
    expect(cutTitle(t, 0)).toBe('');
    expect(cutTitle(t, Number.NaN)).toBe('');
  });
  it('the Esc Esc menu with a query: only /rewind /undo /resume /new are candidates, Suggested rows first', () => {
    const menu: PaletteState = { ...idleAfterStop, rewindMenu: true };
    expect(paletteMatches('/re', menu).map((m) => m.spec.name)).toEqual(['resume', 'rewind']); // both Suggested (stop, rewind-menu) in table order
    expect(paletteMatches('/rew', menu).map((m) => m.spec.name)).toEqual(['rewind']);
    expect(paletteMatches('/rename', menu)).toEqual([]);
    const lines = paletteLines('/u', menu, 0, 8, 80);
    expect(lines[0]).toBe('▌ /undo          restore the files a step changed (…)  Suggested');
    expect(lines[1]).toBe('  /resume        pick a session to continue, or continue <id|title>  Suggested');
    expect(lines[lines.length - 1]).toBe(`  (1/2)  ${PALETTE_FOOTER}`);
    // `/n`: the Suggested rows (/undo, /rewind — both contain an n) come before the prefix match /new
    expect(paletteMatches('/n', menu).map((m) => m.spec.name)).toEqual(['undo', 'rewind', 'new']);
    expect(paletteLines('/n', menu, 2, 8, 80)[2]).toBe('▌ /new           end the session; the next prompt starts a new one here');
  });
  it('at 120 columns the /budget title is whole (F-Z); the selected marker follows `selected`', () => {
    const lines = paletteLines('/b', afterSpendCap, 1, 8, 120);
    expect(lines[0]).toBe('  /budget        show or set caps (spend-cap, session-spend-cap, max-steps, max-wall, max-replans)  Suggested');
    expect(lines[1]?.startsWith('▌ /abort')).toBe(true);
    // the selected /abort has no argument values → no sub-rows, fewer lines
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe(`  (2/3)  ${PALETTE_FOOTER}`);
  });
  it('unavailable rows carry (idle only) / (live only); rows are marked dim', () => {
    const rows = paletteRows('/calibration', live, 0, 8, 80);
    expect(rows[0]?.text).toBe('▌ /calibration   reliability bins, ECE and near-threshold counts (idle only)');
    expect(rows[0]?.dim).toBe(true);
    const idleRows = paletteRows('/pause', fresh, 0, 8, 80);
    expect(idleRows[0]?.text).toContain('(live only)');
  });
  it('scrolls around the selection with ▲/▼ marks; rows never exceed the slot', () => {
    const all = paletteLines('', fresh, 20, 8, 80);
    expect(all).toHaveLength(8);
    expect(all[7]).toBe(`  (21/${COMMANDS.length})  ${PALETTE_FOOTER} ▲ ▼`);
    expect(paletteLines('', fresh, 0, 8, 80)[7]).toBe(`  (1/${COMMANDS.length})  ${PALETTE_FOOTER} ▼`);
    expect(paletteLines('', fresh, COMMANDS.length - 1, 8, 80)[7]).toBe(`  (${COMMANDS.length}/${COMMANDS.length})  ${PALETTE_FOOTER} ▲`);
    expect(paletteLines('', fresh, 0, 3, 80)).toHaveLength(3);
    expect(paletteLines('', fresh, 0, 1, 80)).toHaveLength(1);
    expect(paletteLines('', fresh, 0, 0, 80)).toEqual([]);
    expect(paletteLines('zzz', fresh, 0, 8, 80)).toEqual([`  (0/0)  ${PALETTE_FOOTER}`]);
  });
  it('tolerates tiny widths, NaN sizes and out-of-range selection', () => {
    for (const l of paletteLines('/b', afterSpendCap, 99, 8, 20)) expect(cells(l)).toBeLessThanOrEqual(20);
    expect(paletteLines('/b', afterSpendCap, -5, Number.NaN, Number.NaN)).toEqual([]);
    expect(paletteLines('/b', afterSpendCap, Number.NaN, 2, 80)[1]).toContain('(1/3)');
    const ascii = paletteLines('/b', afterSpendCap, 0, 8, 80, true);
    expect(ascii[0]?.startsWith('> /budget')).toBe(true);
    expect(ascii[7]).toBe('  (1/3)  Tab completes - Enter runs an exact match - Esc closes');
  });
  it('ghost text is the rest of the top match with the count of other matches; a Suggested top match that does not extend the query yields no ghost', () => {
    expect(paletteGhost('/b', paletteMatches('/b', afterSpendCap))).toEqual({ rest: 'udget', more: 2 });
    expect(paletteGhost('/budget', paletteMatches('/budget', fresh))).toBeNull();
    expect(paletteGhost('/zz', [])).toBeNull();
    expect(paletteGhost('/quit', paletteMatches('/quit', fresh))).toBeNull(); // alias: top is /exit, not a prefix
    // `/e` after a stop: /resume is Suggested (top row) but is not a completion of `e`, so no ghost — never a misleading `→`
    const e = paletteMatches('/e', idleAfterStop);
    expect(e[0]?.spec.name).toBe('resume');
    expect(e[0]?.suggested).toBe(true);
    expect(paletteGhost('/e', e)).toBeNull();
    // without the Suggested row the prefix match ghosts
    const eFresh = paletteMatches('/e', fresh);
    expect(eFresh[0]?.spec.name).toBe('exit');
    expect(paletteGhost('/e', eFresh)).toEqual({ rest: 'xit', more: eFresh.length - 1 });
  });
  it('cells / cut handle wide and combining characters and never split a grapheme cluster', () => {
    expect(cells('abc')).toBe(3);
    expect(cells('日本')).toBe(4);
    expect(cells('é')).toBe(1);
    expect(cells('e\u0301')).toBe(1);
    expect(cells('🎉')).toBe(2);
    expect(cells('👨\u200d👩\u200d👧')).toBe(2);
    expect(cut('abcdef', 4)).toBe('abc…');
    expect(cut('日本語です', 5)).toBe('日本…');
    expect(cut('abc', 3)).toBe('abc');
    expect(cut('abc', 0)).toBe('');
    expect(cut('abcdef', 4, true)).toBe('a...');
    expect(cut('ae\u0301bcd', 3)).toBe('ae\u0301…');
    expect(cut('ae\u0301bcd', 2)).toBe('a…');
    expect(cut('👨\u200d👩\u200d👧xyz', 3)).toBe('👨\u200d👩\u200d👧…');
    expect(cut('👨\u200d👩\u200d👧xyz', 2)).toBe('…');
    expect(cut('abc', Number.NaN)).toBe('');
  });
  it('width parity: cells()/cut() agree with string-width over every command title, usage, value hint, key title and help line', async () => {
    let stringWidth: ((s: string) => number) | null = null;
    try {
      const mod = (await import('string-width')) as { default: (s: string) => number };
      stringWidth = mod.default;
    } catch {
      stringWidth = null; // not installed under a strict installer (it is only ink's transitive dependency): the O2 oracle below still runs
    }
    const { stringWidth: o2 } = await import('../../../../src/tui/composer/width.js');
    const samples: string[] = [PALETTE_FOOTER, '▌ /budget', '  (1/3)  ▲ ▼', 'Suggested', '日本語 🎉 é e\u0301', ...HELP_NOTES];
    for (const c of COMMANDS) {
      samples.push(c.title, c.usage, `/${c.name}`, ...c.args.flatMap((a) => [a.hint ?? '', ...Object.values(a.valueHints ?? {}).flatMap((h) => [h.title, h.args ?? ''])]));
    }
    samples.push(...helpLines(80), ...helpLines(200), ...paletteLines('', fresh, 0, 8, 80), ...paletteLines('/b', frameFK, 0, 8, 80), ...paletteLines('/b', frameFK, 0, 8, 40));
    for (const s of samples) {
      expect(cells(s), JSON.stringify(s)).toBe(o2(s));
      if (stringWidth !== null) expect(cells(s), JSON.stringify(s)).toBe(stringWidth(s));
      for (const max of [1, 5, 12, 40]) {
        const c = cut(s, max);
        expect(cells(c), `${JSON.stringify(s)} cut ${max}`).toBeLessThanOrEqual(max);
        if (stringWidth !== null) expect(stringWidth(c)).toBeLessThanOrEqual(max);
      }
    }
  });
});

describe('helpLines (TUI-DESIGN §5.3)', () => {
  /** every command has its own `  /<name>` line (the strict form of the finding-4 assertion) */
  const everyCommand = (lines: string[]): string[] => COMMANDS.filter((c) => !lines.some((l) => l.startsWith(`  /${c.name}`))).map((c) => c.name);
  const bothNotes = (lines: string[]): boolean => HELP_NOTES.every((n) => lines.includes(`  ${n}`));

  it('≤ 60 lines at 80 columns with EVERY command on its own line and both per-terminal notes verbatim — the round-2 rows (TUI-DESIGN-2 §1.3 /mode /llm, §4.6 /panel /transcript, the panel keys) fit through compaction level 3, never the tail cut', () => {
    const lines = helpLines(80);
    expect(lines.length).toBeLessThanOrEqual(HELP_MAX_LINES);
    expect(lines[0]).toBe('keys');
    expect(lines).toContain('commands');
    // level 3: the key contexts pack into one block, each context named where its keys start
    for (const ctx of ['global:', 'composer:', 'review box:', 'session picker:', 'palette:']) expect(lines.some((l) => l.includes(ctx)), ctx).toBe(true);
    expect(everyCommand(lines)).toEqual([]);
    for (const name of ['exit', 'mode', 'llm', 'panel', 'transcript', 'help', 'quit'.replace('quit', 'exit')]) expect(lines.some((l) => l.startsWith(`  /${name}`)), name).toBe(true);
    expect(bothNotes(lines)).toBe(true);
    expect(lines[lines.length - 1]).not.toBe(HELP_POINTER);
    for (const l of lines) expect(cells(l), l).toBeLessThanOrEqual(80);
    // at 100 columns the block is whole too
    const wide = helpLines(100);
    expect(wide.length).toBeLessThanOrEqual(HELP_MAX_LINES);
    expect(everyCommand(wide)).toEqual([]);
    expect(bothNotes(wide)).toBe(true);
    for (const l of wide) expect(cells(l), l).toBeLessThanOrEqual(100);
    // wide terminals keep the uncompacted form: one context title line per key context and the `notes` header
    const level0 = helpLines(200);
    expect(level0).toContain('notes');
    for (const ctx of ['  global', '  composer', '  review box', '  session picker', '  palette']) expect(level0).toContain(ctx);
    expect(HELP_NOTES).toEqual(['Shift+Enter needs a keyboard protocol: use Ctrl+J or \\ then Enter', 'macOS: turn on "Option as Meta" for Alt-b/Alt-f']);
  });
  it('the compaction ladder: 70 columns drops the notes (level 4) before any command; below 60 the tail is cut with the docs pointer; the ladder is documented', () => {
    expect(HELP_COMPACTION_LEVELS).toHaveLength(5);
    expect(HELP_POINTER).toBe('  … see docs/KEYS.md and docs/COMMANDS.md for the rest');
    const at70 = helpLines(70);
    expect(at70.length).toBeLessThanOrEqual(HELP_MAX_LINES);
    expect(everyCommand(at70)).toEqual([]);
    expect(bothNotes(at70)).toBe(false);
    expect(at70[at70.length - 1]).not.toBe(HELP_POINTER);
    for (const width of [40, 50, 59]) {
      const narrow = helpLines(width);
      expect(narrow.length, `${width}`).toBe(HELP_MAX_LINES);
      expect(narrow[narrow.length - 1], `${width}`).toBe(cut(HELP_POINTER, width));
      for (const l of narrow) expect(cells(l), l).toBeLessThanOrEqual(width);
    }
    // every level keeps one `  /<name>` line per command that survives the cut (commands are never packed two to a line)
    for (const width of [40, 60, 70, 80, 100, 200]) {
      const commandLines = helpLines(width).filter((l) => l.startsWith('  /'));
      expect(commandLines.length, `${width}`).toBeGreaterThan(0);
      for (const l of commandLines) expect(l, `${width}`).not.toMatch(/ · \//);
    }
  });
  it('honours the effective bindings, the ascii flag and the topic filter; never exceeds the cap at narrow widths', () => {
    const b = buildBindings(new Map([['composer:externalEditor', ['ctrl+x ctrl+e']], ['global:help', []]]));
    const lines = helpLines(100, { bindings: b });
    expect(lines.some((l) => l.includes('Ctrl+X Ctrl+E external editor'))).toBe(true);
    expect(lines.some((l) => l.includes('?/F1 help'))).toBe(false);
    expect(helpLines(80, { topic: 'keys' })).not.toContain('commands');
    expect(helpLines(80, { topic: 'commands' })[0]).toBe('commands');
    expect(helpLines(80, { ascii: true }).some((l) => l.includes(' - '))).toBe(true);
    const narrow = helpLines(40);
    expect(narrow.length).toBeLessThanOrEqual(HELP_MAX_LINES);
    for (const l of narrow) expect(cells(l)).toBeLessThanOrEqual(40);
    expect(helpLines(Number.NaN).length).toBeGreaterThan(10);
  });
});
