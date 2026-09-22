/**
 * TUI-DESIGN §5.3 / TUI-DESIGN-3 §4.1–§4.2 (D-K): palette rows (≤ 8, Suggested group first, score order, aliases never rows,
 * `(idle only)` / `(live only)`, argument sub-rows, footer `(i/N)  Tab completes · Enter runs an exact match · Esc closes` with
 * ▲/▼), the F-K frame at 80 columns (a live run after a spend_cap stop; the round-3 alias column added to the TUI-DESIGN.md
 * rows), the F-P1/F-P2/F-P3 palette rows read back from TUI-DESIGN-3.md (every row exactly the frame's width), the exact-alias
 * pin rule against the real scorer for every alias of the table, the ghost arrow, Suggested → Recent → Popular → rest, the
 * alias column (hidden < 50 columns, the shortest alias), width parity of `cells()`/`cut()` with string-width over every title,
 * hint and help line, and the help block (≤ 60 lines, aliases shown, `live` tags, the four §10 notes).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODE, MODE_BADGE_WORD } from '../../../../src/config/defaults.js';
import { buildBindings } from '../../../../src/tui/keys/bindings.js';
import { ALIAS_COL, ALIAS_MIN_COLUMNS, HELP_COMPACTION_LEVELS, HELP_KEYS_POINTER, HELP_MAX_LINES, HELP_NOTES, HELP_POINTER, NAME_COL, PALETTE_FOOTER, RECENT, RECENT_MAX, SR_PALETTE_COALESCE_MS, SUGGESTED, VALUE_MARKER, VALUE_MARKER_ASCII, cells, cut, cutTitle, helpCommandHead, helpLines, isSuggested, noMatchRow, numberedPrompt, numberedShown, paletteFooterText, paletteGhost, paletteGhostFor, paletteLines, paletteMatches, paletteNumberedLines, paletteRows, srPaletteLine, type PaletteState } from '../../../../src/tui/commands/palette.js';
import { PLAIN_COLUMNS, plainPaletteState } from '../../../../src/tui/plain-composer.js';
import { paletteNavState } from '../../../../src/tui/commands/nav.js';
import { COMMANDS, POPULAR, findCommand, shortestAlias, type CommandSpec } from '../../../../src/tui/commands/registry.js';

const DESIGN = fileURLToPath(new URL('../../../../docs/TUI-DESIGN.md', import.meta.url));
const DESIGN3 = fileURLToPath(new URL('../../../../docs/TUI-DESIGN-3.md', import.meta.url));

const idleAfterStop: PaletteState = { lastStop: 'max_steps', unauthorized: false, changedFiles: true, rewindMenu: false, live: false };
const fresh: PaletteState = { lastStop: null, unauthorized: false, changedFiles: false, rewindMenu: false, live: false };
const live: PaletteState = { ...fresh, live: true };
const afterSpendCap: PaletteState = { ...idleAfterStop, lastStop: 'spend_cap' };
/** F-K (§2.3): the palette is open on `/b` while a run is live (status `palette … step 7/7 … run $0.31/2.00 ok`, no `done`), the previous run stopped on spend_cap */
const frameFK: PaletteState = { lastStop: 'spend_cap', unauthorized: false, changedFiles: true, rewindMenu: false, live: true };
/** TUI-DESIGN-3 §4.2 F-P1: `/` after a run that changed files; the history holds `/cost` and `/status` */
const frameFP1: PaletteState = { lastStop: null, unauthorized: false, changedFiles: true, rewindMenu: false, live: false, recent: ['cost', 'status'] };

const pad = (s: string, width = 80): string => s + ' '.repeat(Math.max(0, width - cells(s)));

/** the fenced block that follows a `**<marker>` caption line of a design document */
function fence(doc: string, marker: string): string[] {
  const lines = readFileSync(doc, 'utf8').split('\n');
  const at = lines.findIndex((l) => l.startsWith(marker));
  expect(at, marker).toBeGreaterThan(0);
  let k = at + 1;
  while (lines[k] !== '```') k++;
  const body: string[] = [];
  for (k++; lines[k] !== '```'; k++) body.push(lines[k] as string);
  return body;
}

/** the palette rows of the F-K fence (the 8 rows between the pane's blank rows and the composer) */
function frameFKRows(): string[] {
  const body = fence(DESIGN, '**F-K.');
  const start = body.findIndex((l) => l.startsWith('▌ /budget'));
  return body.slice(start, start + 8);
}

/**
 * TUI-DESIGN-3 §4.1 rule 4: the F-K rows of TUI-DESIGN.md predate the alias column — a command row's 15-cell name column becomes
 * 12 + the 3-cell alias column (`/budget` → `/budget     b  `); rows without an alias and the sub-rows / footer are unchanged
 */
function withAliasColumn(row: string, width = 80): string {
  const m = /^(▌ |  )\/([a-z]+)( +)(.*)$/.exec(row);
  if (!m || m[3] === undefined || 1 + (m[2] as string).length + (m[3] as string).length !== NAME_COL + ALIAS_COL) return row;
  const spec = findCommand(m[2] as string);
  const alias = spec ? shortestAlias(spec) : null;
  const out = `${m[1]}${`/${m[2]}`.padEnd(NAME_COL)}${(alias ?? '').padEnd(ALIAS_COL - 1)} ${m[4]}`;
  // TUI-DESIGN-3 §4.2 row anatomy: the group tag sits at the right edge (F-K drew it two cells after the title)
  const tag = `  ${SUGGESTED}`;
  return out.endsWith(tag) ? pad(out.slice(0, -tag.length), width - tag.length) + tag : out;
}

/** the palette rows inside an F-P card fence (`│ … │` rows of the `commands` card) */
function cardRows(body: string[]): string[] {
  const top = body.findIndex((l) => l.startsWith('╭─ commands'));
  const out: string[] = [];
  for (let i = top + 1; i < body.length && !(body[i] as string).startsWith('╰'); i++) out.push((body[i] as string).slice(2, -2));
  return out;
}

describe('paletteMatches (TUI-DESIGN §5.3; TUI-DESIGN-3 §4.1 rule 6)', () => {
  it('empty query: Suggested → Recent → Popular (16, fixed order, no tag) → the rest in table order; aliases never appear as rows', () => {
    const all = paletteMatches('', fresh);
    const rest = COMMANDS.map((c) => c.name).filter((n) => !POPULAR.includes(n));
    expect(all.map((m) => m.spec.name)).toEqual([...POPULAR, ...rest]);
    expect(all.some((m) => m.spec.name === 'quit')).toBe(false);
    expect(all.every((m) => !m.recent)).toBe(true);
    expect(POPULAR).toEqual(['help', 'mode', 'model', 'cost', 'status', 'resume', 'new', 'panel', 'plan', 'diff', 'undo', 'theme', 'login', 'budget', 'jev', 'exit']);
    const after = paletteMatches('', idleAfterStop);
    expect(after.slice(0, 2).map((m) => m.spec.name)).toEqual(['resume', 'undo']);
    expect(after[0]?.suggested).toBe(true);
    // Recent: ≤ 3 distinct owners, newest first, an alias entry resolves before de-duplication, a Suggested command is never doubled
    const recent = paletteMatches('', { ...frameFP1, recent: ['cost', 'status', 'c', 'undo', 'mode', 'help'] });
    expect(recent.slice(0, 4).map((m) => [m.spec.name, m.suggested, m.recent])).toEqual([['undo', true, false], ['cost', false, true], ['status', false, true], ['mode', false, true]]);
    expect(recent.filter((m) => m.recent)).toHaveLength(RECENT_MAX);
    expect(recent.map((m) => m.spec.name)).toHaveLength(COMMANDS.length);
    expect(new Set(recent.map((m) => m.spec.name)).size).toBe(COMMANDS.length);
    // an unknown or misspelt recent entry is skipped
    expect(paletteMatches('', { ...fresh, recent: ['nope', 'status'] }).slice(0, 2).map((m) => m.spec.name)).toEqual(['status', 'help']);
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
  it('TUI-DESIGN-3 §4.1 rule 2: an exact alias pins its owner to the top with score 1000; the prefix siblings follow in score order (`/s` status → steer, `/p` panel → plan, `/t` theme → trust, `/l` login → llm, `/tr` transcript → trust); a non-empty query is never reordered by popularity', () => {
    const top = (q: string): string[] => paletteMatches(q, fresh).slice(0, 2).map((m) => m.spec.name);
    expect(top('/s')).toEqual(['status', 'steer']);
    expect(top('/p')).toEqual(['panel', 'plan']);
    expect(top('/t')).toEqual(['theme', 'trust']);
    expect(top('/l')).toEqual(['login', 'llm']);
    expect(top('/tr')).toEqual(['transcript', 'trust']);
    expect(paletteMatches('/s', fresh)[0]?.score).toBe(1000);
    expect(paletteMatches('/S', fresh)[0]?.spec.name).toBe('status'); // case-folded like the names
    // the pinned owner keeps the spans of its name match (`s` of status); an alias-only hit has none
    expect(paletteMatches('/s', fresh)[0]?.spans).toEqual([[1, 2]]);
    expect(paletteMatches('/q', fresh)).toMatchObject([{ spec: { name: 'exit' }, score: 1000, spans: [] }]);
    // `/c`: cost pinned by its alias, then copy (prefix, table order before config)
    expect(paletteMatches('/c', fresh).slice(0, 3).map((m) => m.spec.name)).toEqual(['cost', 'copy', 'config']);
    // popularity never reorders a typed query: `/e` is score order (exit, export, errors, editor …), not the Popular order
    expect(paletteMatches('/e', fresh).slice(0, 4).map((m) => m.spec.name)).toEqual(['exit', 'export', 'errors', 'editor']);
  });
  it('TUI-DESIGN-3 §8 S4: for EVERY alias of the table `paletteMatches("/" + alias)[0].spec.name === owner` — in the fresh, live and after-stop states alike (the exact token leads even a Suggested row: Enter runs it, so the highlight agrees with Enter)', () => {
    for (const c of COMMANDS) {
      for (const a of c.aliases) {
        for (const [name, state] of [['fresh', fresh], ['live', live], ['idleAfterStop', idleAfterStop], ['afterSpendCap', afterSpendCap], ['unauthorized', { ...fresh, unauthorized: true }]] as const) {
          const m = paletteMatches(`/${a}`, state);
          expect(m[0]?.spec.name, `/${a} → ${c.name} (${name})`).toBe(c.name);
          expect(m[0]?.score, `/${a} score`).toBe(1000);
        }
      }
    }
    // `/d` after a run that changed files: /diff (the exact alias) leads, the Suggested /undo follows, then the rest by score
    expect(paletteMatches('/d', idleAfterStop).slice(0, 3).map((m) => [m.spec.name, m.suggested])).toEqual([['diff', false], ['undo', true], ['decisions', false]]);
    // an exact NAME leads the same way
    expect(paletteMatches('/undo', idleAfterStop)[0]?.spec.name).toBe('undo');
    expect(paletteMatches('/rewind', { ...idleAfterStop, rewindMenu: true })[0]?.spec.name).toBe('rewind');
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
  it('F-K (with the round-3 alias column and TUI-DESIGN-4\'s 41 commands): `/b` at 80×8 while live after a spend_cap stop → /budget Suggested with the `…)` cut, /abort untagged, /calibration (idle only), /scrollback, 3 sub-rows, the S-ARMED footer; every row exactly 80 cells', () => {
    const lines = paletteLines('/b', frameFK, 0, 8, 80);
    expect(lines).toHaveLength(8);
    for (const l of lines) expect(cells(l)).toBe(80);
    expect(lines[0]).toBe(pad('▌ /budget     b  show or set caps (spend-cap, session-spend-cap, …)    Suggested'));
    expect(lines[1]).toBe(pad('  /abort         stop the run now (= Esc Esc); the step in flight is discarded'));
    expect(lines[2]).toBe(pad('  /calibration   reliability bins, ECE and near-threshold counts (idle only)'));
    // TUI-DESIGN-4 §1.3.4: `/scrollback` is a fourth subsequence hit for `b`, so one sub-row gives way to it
    expect(lines[3]).toBe(pad('  /scrollback    print the transcript to the primary screen for copy and find'));
    expect(lines[4]).toBe(pad('  /budget spend-cap <usd>            run cap for the next /resume or run'));
    expect(lines[5]).toBe(pad('  /budget session-spend-cap <usd>    session cap, applies now'));
    expect(lines[6]).toBe(pad('  /budget max-steps <n>              step limit for the next /resume or run'));
    // TUI-DESIGN-4 §4.4: `/b` is an exact alias, so the state is S-ARMED on the **owner** and the footer says so (E3)
    expect(lines[7]).toBe(pad('  (1/4)  Enter runs /budget · Tab adds an argument · Esc closes'));
    // and against the design document itself (TUI-DESIGN.md F-K predates the alias column: its 15-cell name column reads as 12 + 3): the three command rows and the three surviving sub-rows still match it row for row
    const doc = frameFKRows().map((r) => withAliasColumn(r));
    expect(lines.slice(0, 3).map((l) => l.trimEnd())).toEqual(doc.slice(0, 3));
    expect(lines.slice(4, 7).map((l) => l.trimEnd())).toEqual(doc.slice(3, 6));
    const rows = paletteRows('/b', frameFK, 0, 8, 80);
    expect(rows.map((r) => r.dim)).toEqual([false, false, true, false, false, false, false, false]);
    expect(rows.map((r) => r.kind)).toEqual(['command', 'command', 'command', 'command', 'value', 'value', 'value', 'footer']);
    expect(rows[0]?.suggested).toBe(true);
    expect(rows[0]?.tag).toBe(SUGGESTED);
    expect(rows[0]?.alias).toBe('b');
    expect(rows[1]?.alias).toBeNull();
    expect(rows[0]?.spans).toEqual([[3, 4]]); // the `b` of /budget after `▌ /`
  });
  it('idle after a plain stop (the same query): /budget is not Suggested, /abort is (live only), /calibration is untagged', () => {
    const lines = paletteLines('/b', idleAfterStop, 0, 8, 80);
    expect(lines[0]).toBe(pad('▌ /budget     b  show or set caps (spend-cap, session-spend-cap, max-steps, …)'));
    expect(lines[1]).toBe('  /abort         stop the run now (= Esc Esc); the step in flight i… (live only)'); // the tag costs 12 cells: a plain cut (the parenthesis is not a trailing list)
    expect(lines[2]).toBe(pad('  /calibration   reliability bins, ECE and near-threshold counts'));
    expect(paletteRows('/b', idleAfterStop, 0, 8, 80).map((r) => r.dim).slice(0, 3)).toEqual([false, true, false]);
  });
  it('TUI-DESIGN-3 §4.2 F-P1 verbatim from the design document: `/` after a run that changed files, history /cost + /status, 76 inner cells — Suggested → recent → Popular with the alias column; every row exactly 76 cells', () => {
    const doc = cardRows(fence(DESIGN3, '**F-P1.'));
    expect(doc).toHaveLength(6);
    const mine = paletteLines('/', frameFP1, 0, 6, 76);
    // TUI-DESIGN-4 §4.4 / §4.6: the five command rows are the frame's; the footer is the state footer over 41 commands
    expect(mine.slice(0, 5)).toEqual(doc.slice(0, 5));
    for (const l of mine) expect(cells(l)).toBe(76);
    expect(mine[0]).toBe('▌ /undo       u  restore the files a step changed (verify-before…  Suggested');
    expect(mine[1]).toBe('  /cost       c  run and session spend, per-step cost, pending caps   recent');
    expect(mine[2]).toBe('  /status     s  run id, session id, step/max, stage, sandbox, work…  recent');
    expect(mine[3]).toBe('  /help       h  keys by context, commands with one-liners, per-terminal no…');
    expect(mine[4]).toBe('  /mode       m  engine mode: show, or set for the next run                 ');
    expect(mine[5]).toBe(`  (1/${COMMANDS.length})  ${PALETTE_FOOTER} ▼`.padEnd(76));
    expect(PALETTE_FOOTER).toBe('Enter next · Tab picks · Esc closes'); // TUI-DESIGN-4 §4.4: the S-BROWSE rendering
    const rows = paletteRows('/', frameFP1, 0, 6, 76);
    expect(rows.map((r) => r.tag)).toEqual([SUGGESTED, RECENT, RECENT, null, null, null]);
    expect(rows.map((r) => r.alias)).toEqual(['u', 'c', 's', 'h', 'm', undefined]);
  });
  it('TUI-DESIGN-3 §4.2 F-P2: `/m` pins /mode (alias) over /model (prefix); the enum sub-rows stay on screen although the six matches overflow (the command rows shrink to two, ▼ says the rest scrolls); the count and the ghost `+5` match the frame', () => {
    const doc = cardRows(fence(DESIGN3, '**F-P2.'));
    const mine = paletteLines('/m', fresh, 0, 6, 76);
    for (const l of mine) expect(cells(l)).toBe(76);
    expect(mine.slice(0, 2)).toEqual(doc.slice(0, 2));
    expect(mine[0]).toBe('▌ /mode       m  engine mode: show, or set for the next run                 ');
    expect(mine[1]).toBe('  /model      ml generator model for the next run only                      ');
    const rows = paletteRows('/m', fresh, 0, 6, 76);
    expect(rows.map((r) => r.kind)).toEqual(['command', 'command', 'value', 'value', 'value', 'footer']);
    // the sub-rows in `values` order (registry / TUI-DESIGN-2 §1.2 table order) with the badge-table hints; the frame's own order is jev-on, llm-jev, jev-only
    expect(rows.slice(2, 5).map((r) => r.name)).toEqual(['/mode jev-only', '/mode jev-on', '/mode jev-off']);
    expect(mine[2]).toContain('no generating LLM; code proposes, Jev');
    expect(mine[3]).toContain(`${MODE_BADGE_WORD['jev-on']}: the code model`);
    expect(paletteMatches('/m', fresh)).toHaveLength(6); // mode, model, llm, theme, resume, rename — the frame's `(1/6)`
    // TUI-DESIGN-4 §4.4: `/m` is an exact alias → S-ARMED on /mode, whose arg 0 has values
    expect(mine[5]).toBe('  (1/6)  Enter runs /mode · Tab adds an argument · Esc closes ▼'.padEnd(76));
    expect(paletteGhost('/m', paletteMatches('/m', fresh))).toEqual({ rest: '', more: 5, arrow: '/mode' });
    // scrolled past the exact row the sub-rows give way to the matches
    expect(paletteRows('/m', fresh, 3, 6, 76).map((r) => r.kind)).toEqual(['command', 'command', 'command', 'command', 'command', 'footer']);
  });
  it('TUI-DESIGN-3 §4.2 F-P3: 12×60 flat tier, `/` typed — the alias column is kept at 60 columns, every row is exactly 60 cells (the frame\'s rows too), the rows follow Suggested → recent → Popular', () => {
    const doc = fence(DESIGN3, '**F-P3.');
    const start = doc.findIndex((l) => l.startsWith('▌ /undo'));
    const docRows = doc.slice(start, start + 7);
    for (const l of docRows) expect(cells(l), l).toBe(60);
    const mine = paletteLines('/', { ...frameFP1, recent: ['cost'] }, 0, 7, 60);
    expect(mine).toHaveLength(7);
    for (const l of mine) expect(cells(l), l).toBe(60);
    expect(mine.slice(0, 5)).toEqual(docRows.slice(0, 5));
    expect(mine[0]).toBe('▌ /undo       u  restore the files a step change…  Suggested');
    expect(mine[1]).toBe('  /cost       c  run and session spend, per-step co…  recent');
    // rule 6 puts /status (Popular #5) before /panel (#8); the frame drew /panel — the rule wins, the frame is illustrative there
    expect(mine[5]).toBe('  /status     s  run id, session id, step/max, stage, sandb…');
    // TUI-DESIGN-4 §4.4 / §4.6: the frame's footer row is replaced by the state footer over 41 commands
    expect(mine[6]).toBe(`  (1/${COMMANDS.length})  ${PALETTE_FOOTER} ▼`.padEnd(60));
  });
  it('TUI-DESIGN-3 §4.1 rule 4: the alias column shows the shortest alias (ties: table order — /resume → r, /exit → q), is hidden below 50 columns (today\'s 15-cell name column returns), and never changes a row\'s width', () => {
    expect(shortestAlias(findCommand('resume') as CommandSpec)).toBe('r');
    expect(shortestAlias(findCommand('exit') as CommandSpec)).toBe('q');
    expect(shortestAlias(findCommand('model') as CommandSpec)).toBe('ml');
    expect(shortestAlias(findCommand('steer') as CommandSpec)).toBeNull();
    expect(ALIAS_MIN_COLUMNS).toBe(50);
    expect(NAME_COL + ALIAS_COL).toBe(15);
    const at50 = paletteRows('/b', afterSpendCap, 0, 4, 50);
    expect(at50[0]?.text).toBe('▌ /budget     b  show or set caps (…)    Suggested');
    expect(at50[0]?.alias).toBe('b');
    const at49 = paletteRows('/b', afterSpendCap, 0, 4, 49);
    expect(at49[0]?.text).toBe('▌ /budget        show or set caps (…)   Suggested');
    expect(at49[0]?.alias).toBeNull();
    for (const width of [40, 49, 50, 60, 76, 80, 120]) for (const l of paletteLines('', frameFP1, 0, 8, width)) expect(cells(l), `${width}: ${l}`).toBe(width);
  });
  it('cutTitle cuts a parenthesised list at a comma and closes it `…)`; a single-item parenthetical and other titles cut by cell (F-P1); whole titles pass through', () => {
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
    // TUI-DESIGN-3 §4.2 F-P1: `(verify-before-write)` is one item, not a list — a plain cut keeps what fits of it
    expect(cutTitle('restore the files a step changed (verify-before-write)', 52)).toBe('restore the files a step changed (verify-before-wri…');
    expect(cutTitle('restore the files a step changed (verify-before-write)', 48)).toBe('restore the files a step changed (verify-before…');
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
    expect(lines[0]).toBe('▌ /undo       u  restore the files a step changed (verify-before-wri…  Suggested');
    expect(lines[1]).toBe('  /resume     r  pick a session to continue, or continue <id|title>    Suggested');
    expect(lines[lines.length - 1]).toBe(pad('  (1/2)  Enter runs /undo · Esc closes')); // TUI-DESIGN-4 §4.4: `/u` is /undo's alias → S-ARMED on the owner
    // `/n`: the Suggested rows (/undo, /rewind — both contain an n) come before the prefix match /new
    expect(paletteMatches('/n', menu).map((m) => m.spec.name)).toEqual(['undo', 'rewind', 'new']);
    expect(paletteLines('/n', menu, 2, 8, 80)[2]).toBe(pad('▌ /new        nw end the session; the next prompt starts a new one here'));
  });
  it('at 120 columns the /budget title is whole (F-Z); the selected marker follows `selected`', () => {
    const lines = paletteLines('/b', afterSpendCap, 1, 8, 120);
    expect(lines[0]).toBe('  /budget     b  show or set caps (spend-cap, session-spend-cap, max-steps, max-wall, max-replans)             Suggested');
    expect(lines[1]?.startsWith('▌ /abort')).toBe(true);
    // the selected /abort has no argument values → no sub-rows, fewer lines (TUI-DESIGN-4: /scrollback is a fourth `b` hit)
    expect(lines).toHaveLength(5);
    // TUI-DESIGN-4 §4.4: the marker is off the draft's own row → S-PICKED, and the footer names the row Tab would take
    expect(lines[4]).toBe(pad('  (2/4)  Tab picks /abort · Enter next · Esc closes', 120));
  });
  it('unavailable rows carry (idle only) / (live only); rows are marked dim', () => {
    const rows = paletteRows('/calibration', live, 0, 8, 80);
    expect(rows[0]?.text).toBe(pad('▌ /calibration   reliability bins, ECE and near-threshold counts (idle only)'));
    expect(rows[0]?.dim).toBe(true);
    const idleRows = paletteRows('/pause', fresh, 0, 8, 80);
    expect(idleRows[0]?.text).toContain('(live only)');
  });
  it('scrolls around the selection with ▲/▼ marks; rows never exceed the slot', () => {
    const all = paletteLines('', fresh, 20, 8, 80);
    expect(all).toHaveLength(8);
    expect(all[7]).toBe(pad(`  (21/${COMMANDS.length})  ${PALETTE_FOOTER} ▲ ▼`));
    expect(paletteLines('', fresh, 0, 8, 80)[7]).toBe(pad(`  (1/${COMMANDS.length})  ${PALETTE_FOOTER} ▼`));
    expect(paletteLines('', fresh, COMMANDS.length - 1, 8, 80)[7]).toBe(pad(`  (${COMMANDS.length}/${COMMANDS.length})  ${PALETTE_FOOTER} ▲`));
    expect(paletteLines('', fresh, 0, 3, 80)).toHaveLength(3);
    expect(paletteLines('', fresh, 0, 1, 80)).toHaveLength(1);
    expect(paletteLines('', fresh, 0, 0, 80)).toEqual([]);
    // TUI-DESIGN-4 §4.7 E2: zero matches draws a sentence and the `(0/0)  Esc closes` footer, never a blank card
    expect(paletteLines('zzz', fresh, 0, 8, 80)).toEqual([pad('  no command matches /zzz — keep typing, or Esc to clear'), pad('  (0/0)  Esc closes')]);
  });
  it('tolerates tiny widths, NaN sizes and out-of-range selection', () => {
    for (const l of paletteLines('/b', afterSpendCap, 99, 8, 20)) expect(cells(l)).toBeLessThanOrEqual(20);
    expect(paletteLines('/b', afterSpendCap, -5, Number.NaN, Number.NaN)).toEqual([]);
    expect(paletteLines('/b', afterSpendCap, Number.NaN, 2, 80)[1]).toContain('(1/4)');
    const ascii = paletteLines('/b', afterSpendCap, 0, 8, 80, true);
    expect(ascii[0]?.startsWith('> /budget     b  ')).toBe(true);
    expect(ascii[7]).toBe(pad('  (1/4)  Enter runs /budget - Tab adds an argument - Esc closes'));
  });
  it('TUI-DESIGN-3 §4.1 rule 8: the `/mode` sub-rows read the badge table, the row equal to DEFAULT_MODE ends ` (default)` (D-N: computed, never a literal) and the suffix survives the cut; /theme, /panel, /transcript, /copy, /logout, /help and the /decisions stages carry hints', () => {
    const rows = paletteRows('/mode', fresh, 0, 8, 80);
    const values = rows.filter((r) => r.kind === 'value');
    expect(values.map((r) => r.name)).toEqual(['/mode jev-only', '/mode jev-on', '/mode jev-off', '/mode llm-jev']);
    const def = values.find((r) => r.name === `/mode ${DEFAULT_MODE}`);
    expect(def?.text.trimEnd().endsWith(' (default)')).toBe(true);
    expect(values.filter((r) => r.text.includes('(default)'))).toHaveLength(1);
    // the llm-jev row is the default row since 6aed085: its title is cut to make room for ` (default)` at 80 columns, so only the
    // badge word (the title's head) is asserted here; the full hint is checked on a non-default row below
    expect(values.find((r) => r.name === '/mode llm-jev')?.text).toContain(MODE_BADGE_WORD['llm-jev']);
    expect(values.find((r) => r.name === '/mode jev-on')?.text).toContain(`${MODE_BADGE_WORD['jev-on']}: `);
    expect(values.find((r) => r.name === '/mode jev-only')?.text).toContain('no generating LLM; code proposes, Jev deci');
    for (const name of ['theme', 'panel', 'transcript', 'copy', 'logout', 'help']) {
      const spec = findCommand(name) as CommandSpec;
      for (const v of spec.args[0]?.values ?? []) expect(spec.args[0]?.valueHints?.[v]?.title, `${name} ${v}`).toBeTruthy();
    }
    const stages = findCommand('decisions') as CommandSpec;
    for (const v of stages.args[1]?.values ?? []) expect(stages.args[1]?.valueHints?.[v]?.title, v).toBeTruthy();
    expect(paletteLines('/theme', fresh, 0, 8, 80)[1]).toBe(pad('  /theme dark                        TypeSafe pink'));
  });
  it('TUI-DESIGN-3 §4.3: a typed partial filters the sub-rows to the candidates Tab cycles through; the value equal to the token is highlighted', () => {
    const rows = paletteRows('/budget sp', fresh, 0, 8, 80);
    expect(rows.filter((r) => r.kind === 'value').map((r) => r.name)).toEqual(['/budget spend-cap', '/budget session-spend-cap', '/budget max-steps']);
    // TUI-DESIGN-4 §4.3 P-P4: the value cursor `▹` sits on V[j] (j = 0 here) — the PROBED defect was that no row was marked at all
    expect(rows.filter((r) => r.kind === 'value').map((r) => r.selected)).toEqual([true, false, false]);
    expect(rows.find((r) => r.kind === 'value')?.text.startsWith('▹ ')).toBe(true);
    const exact = paletteRows('/budget spend-cap', fresh, 0, 8, 80).filter((r) => r.kind === 'value');
    expect(exact[0]).toMatchObject({ name: '/budget spend-cap', selected: true });
    expect(exact.slice(1).every((r) => !r.selected)).toBe(true);
    expect(paletteRows('/mode', fresh, 0, 8, 80).filter((r) => r.kind === 'value')).toHaveLength(4);
  });
  it('TUI-DESIGN-3 §4.1 rule 3: ghost text — a prefix of the top match ghosts its rest with the count of other matches; an exact or prefix alias ghosts the arrow `→ /owner`; a Suggested top match that does not extend the query yields no ghost', () => {
    expect(paletteGhost('/bu', paletteMatches('/bu', afterSpendCap))).toEqual({ rest: 'dget', more: 0 });
    expect(paletteGhost('/', paletteMatches('/', frameFP1))).toEqual({ rest: 'undo', more: COMMANDS.length - 1 }); // F-P1 `› /undo +36`
    expect(paletteGhost('/budget', paletteMatches('/budget', fresh))).toBeNull();
    expect(paletteGhost('/zz', [])).toBeNull();
    // an alias, exact or as a prefix: the arrow (`rest` empty so a pre-round-3 renderer draws only `+N`)
    expect(paletteGhost('/b', paletteMatches('/b', afterSpendCap))).toEqual({ rest: '', more: 3, arrow: '/budget' });
    expect(paletteGhost('/quit', paletteMatches('/quit', fresh))).toEqual({ rest: '', more: 0, arrow: '/exit' });
    expect(paletteGhost('/qu', paletteMatches('/qu', fresh))).toEqual({ rest: '', more: 0, arrow: '/exit' });
    expect(paletteGhost('/s', paletteMatches('/s', fresh))).toMatchObject({ arrow: '/status' });
    expect(paletteGhost('/ml', paletteMatches('/ml', fresh))).toMatchObject({ arrow: '/model' });
    expect(paletteGhost('/cp', paletteMatches('/cp', fresh))).toMatchObject({ arrow: '/copy' });
    for (const c of COMMANDS) for (const a of c.aliases) expect(paletteGhost(`/${a}`, paletteMatches(`/${a}`, fresh)), a).toMatchObject({ arrow: `/${c.name}` });
    // `/e` after a stop: /resume is Suggested (top row) but is not a completion of `e`, so no ghost — never a misleading `→`
    const e = paletteMatches('/e', idleAfterStop);
    expect(e[0]?.spec.name).toBe('resume');
    expect(e[0]?.suggested).toBe(true);
    // TUI-DESIGN-4 §4.3 P-P2: a marked row that does not extend the token now ghosts the arrow (the `arrow` shape subsumes the fuzzy hit)
    expect(paletteGhost('/e', e)).toEqual({ rest: '', more: e.length - 1, arrow: '/resume' });
    // without the Suggested row the prefix match ghosts
    const eFresh = paletteMatches('/e', fresh);
    expect(eFresh[0]?.spec.name).toBe('exit');
    expect(paletteGhost('/e', eFresh)).toEqual({ rest: 'xit', more: eFresh.length - 1 });
  });
  it('cells / cut handle wide and combining characters and never split a grapheme cluster', () => {
    expect(cells('abc')).toBe(3);
    expect(cells('日本')).toBe(4);
    expect(cells('é')).toBe(1);
    expect(cells('é')).toBe(1);
    expect(cells('🎉')).toBe(2);
    expect(cells('👨‍👩‍👧')).toBe(2);
    expect(cut('abcdef', 4)).toBe('abc…');
    expect(cut('日本語です', 5)).toBe('日本…');
    expect(cut('abc', 3)).toBe('abc');
    expect(cut('abc', 0)).toBe('');
    expect(cut('abcdef', 4, true)).toBe('a...');
    expect(cut('aébcd', 3)).toBe('aé…');
    expect(cut('aébcd', 2)).toBe('a…');
    expect(cut('👨‍👩‍👧xyz', 3)).toBe('👨‍👩‍👧…');
    expect(cut('👨‍👩‍👧xyz', 2)).toBe('…');
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
    const samples: string[] = [PALETTE_FOOTER, '▌ /budget', '  (1/3)  ▲ ▼', SUGGESTED, RECENT, '日本語 🎉 é é', ...HELP_NOTES];
    for (const c of COMMANDS) {
      samples.push(c.title, c.usage, `/${c.name}`, helpCommandHead(c), ...c.args.flatMap((a) => [a.hint ?? '', ...Object.values(a.valueHints ?? {}).flatMap((h) => [h.title, h.args ?? ''])]));
    }
    samples.push(...helpLines(80), ...helpLines(200), ...paletteLines('', fresh, 0, 8, 80), ...paletteLines('/', frameFP1, 0, 6, 76), ...paletteLines('/m', fresh, 0, 6, 76), ...paletteLines('/b', frameFK, 0, 8, 80), ...paletteLines('/b', frameFK, 0, 8, 40));
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

describe('TUI-DESIGN-4 §4.3 P-P2 `paletteGhostFor`: the ghost IS the highlight', () => {
  it('the three shapes, read off `matches[selected]` and never `matches[0]`', () => {
    const m = paletteMatches('/m', fresh);
    expect(m[0]?.spec.name).toBe('mode');
    expect(m[1]?.spec.name).toBe('model');
    // `rest` — the marked row extends the typed token
    expect(paletteGhostFor('/m', m, 1)).toEqual({ kind: 'rest', rest: 'odel', more: m.length - 1 });
    // `arrow` — it does not, because the token is an alias (`/m` is /mode's alias) or a fuzzy hit
    expect(paletteGhostFor('/m', m, 0)).toEqual({ kind: 'arrow', target: '/mode', more: m.length - 1 });
    expect(paletteGhostFor('/q', paletteMatches('/q', fresh), 0)).toEqual({ kind: 'arrow', target: '/exit', more: 0 });
    // `value` — an argument value of the marked sub-row
    // `/mode j` ranks jev-on · jev-off · jev-only · llm-jev (`rank` is a subsequence scorer, so `llm-jev` matches `j`)
    expect(paletteGhostFor('/mode j', paletteMatches('/mode j', fresh), 0)).toEqual({ kind: 'value', rest: 'ev-on', more: 3 });
    expect(paletteGhostFor('/mode j', paletteMatches('/mode j', fresh), 2)).toEqual({ kind: 'value', rest: 'ev-only', more: 3 });
    // and the one marked row that does NOT extend the token ghosts the arrow, so the ghost never vanishes under the
    // cursor Tab is about to accept
    expect(paletteGhostFor('/mode j', paletteMatches('/mode j', fresh), 3)).toEqual({ kind: 'arrow', target: '/mode llm-jev', more: 3 });
    // A4 p5's defect: the marker on one command and the ghost on another can no longer happen
    for (let i = 0; i < m.length; i++) {
      const g = paletteGhostFor('/m', m, i);
      const owner = (m[i] as { spec: CommandSpec }).spec.name;
      expect(g === null || (g.kind === 'arrow' ? g.target === `/${owner}` : `m${g.rest}` === owner), owner).toBe(true);
    }
    // nothing to preview
    expect(paletteGhostFor('/mode', paletteMatches('/mode', fresh), 0)).toBeNull();
    expect(paletteGhostFor('/zz', [], 0)).toBeNull();
    // round 3's two-member entry point is the `selected = 0` projection of the union, unchanged for its callers
    expect(paletteGhost('/m', m)).toEqual({ rest: '', more: m.length - 1, arrow: '/mode' });
  });
});

describe('TUI-DESIGN-4 §4.4: the footer says what Enter does, in every state', () => {
  const only = (q: string, st: PaletteState, sel = 0): string => {
    const rows = paletteRows(q, st, sel, 1, 120);
    return (rows[0] as { text: string }).text.trimEnd().replace(/^ {2}\(\d+\/\d+\) {2}/, '');
  };
  it('the eleven rows of the §4.4 table, each read off the real state machine', () => {
    // S-BROWSE — a bare `/`
    expect(paletteNavState('/', paletteMatches('/', fresh), 0)).toBe('browse');
    expect(only('/', fresh)).toBe('Enter next · Tab picks · Esc closes');
    expect(PALETTE_FOOTER).toBe('Enter next · Tab picks · Esc closes');
    // S-ONE — exactly one candidate, which Enter accepts
    const one = paletteMatches('/calib', fresh);
    expect(one).toHaveLength(1);
    expect(paletteNavState('/calib', one, 0)).toBe('one');
    expect(only('/calib', fresh)).toBe('Enter picks /calibration · Esc closes');
    // S-ARMED with an enum arg 0, and with no arguments at all
    expect(only('/mode', fresh)).toBe('Enter runs /mode · Tab adds an argument · Esc closes');
    expect(only('/cost', fresh)).toBe('Enter runs /cost · Esc closes');
    // S-ARGBAD — a typo'd enum value; Enter still RUNS so dispatchCommand can report it
    expect(paletteNavState('/mode jev-onx', paletteMatches('/mode jev-onx', fresh), 0)).toBe('argbad');
    expect(only('/mode jev-onx', fresh)).toBe('Enter runs /mode jev-onx · no such value · Esc closes');
    // S-ARMED, unavailable now — the whole row is drawn dim and the footer says why
    expect(only('/undo', live)).toBe('Enter runs /undo · idle only · Esc closes');
    expect(only('/steer', fresh)).toBe('Enter runs /steer · live only · Esc closes');
    // S-PICKED — the marker off the draft's own row: Tab picks it, Enter only moves on
    const mode = paletteMatches('/mode', fresh);
    expect(mode[1]?.spec.name).toBe('model');
    expect(paletteNavState('/mode', mode, 1)).toBe('picked');
    expect(only('/mode', fresh, 1)).toBe('Tab picks /model · Enter next · Esc closes');
    // S-ARG / S-ARGDONE
    expect(paletteNavState('/mode ', paletteMatches('/mode ', fresh), 0)).toBe('arg');
    expect(only('/mode ', fresh)).toBe('Enter next value · Tab picks · Esc closes');
    expect(paletteNavState('/mode jev-on', paletteMatches('/mode jev-on', fresh), 0)).toBe('argdone');
    expect(only('/mode jev-on', fresh)).toBe('Enter runs /mode jev-on · Esc closes');
    // S-FREE — arg 0 has no values, so the footer names what to type
    expect(paletteNavState('/rename x', paletteMatches('/rename x', fresh), 0)).toBe('free');
    expect(only('/rename x', fresh)).toBe('Enter runs /rename · type the title · Esc closes');
    // S-NONE
    expect(paletteFooterText('none')).toBe('Esc closes');
  });
  it('the command name in the footer is always the RESOLVED OWNER, so an alias can never surprise (E3)', () => {
    expect(only('/q', fresh)).toBe('Enter runs /exit · Esc closes');
    expect(only('/nw', fresh)).toBe('Enter runs /new · Esc closes');
    expect(only('/m', fresh)).toBe('Enter runs /mode · Tab adds an argument · Esc closes');
    for (const c of COMMANDS) {
      for (const a of c.aliases) {
        const rows = paletteRows(`/${a}`, fresh, 0, 1, 160);
        expect((rows[0] as { text: string }).text, a).toContain(`Enter runs /${c.name}`);
      }
    }
  });
  it('`·` becomes ` - ` under `--ascii`, and at n === 1 the STATE footer is the one thing the row still teaches (E16)', () => {
    expect(paletteFooterText('browse', { ascii: true })).toBe('Enter next - Tab picks - Esc closes');
    expect(paletteFooterText('armed', { name: 'mode', hasValues: true, ascii: true })).toBe('Enter runs /mode - Tab adds an argument - Esc closes');
    expect(paletteLines('/mode', fresh, 0, 1, 80)).toHaveLength(1);
    expect(paletteLines('/mode', fresh, 0, 1, 80)[0]).toBe(pad('  (1/2)  Enter runs /mode · Tab adds an argument · Esc closes'));
  });
  it('E2 / F-P3: the S-NONE inline row and its `(0/0)` footer at 80 and at 60 columns, ascii too', () => {
    expect(paletteLines('zz', fresh, 0, 8, 80)).toEqual([pad('  no command matches /zz — keep typing, or Esc to clear'), pad('  (0/0)  Esc closes')]);
    const at60 = paletteLines('zz', fresh, 0, 8, 60);
    expect(at60).toEqual([pad('  no command matches /zz — keep typing, or Esc to clear', 60), pad('  (0/0)  Esc closes', 60)]);
    for (const l of at60) expect(cells(l)).toBe(60);
    expect(paletteRows('zz', fresh, 0, 8, 80)[0]?.kind).toBe('note');
    expect(noMatchRow('/zz')).toBe('no command matches /zz — keep typing, or Esc to clear');
    expect(noMatchRow('/zz', true)).toBe('no command matches /zz - keep typing, or Esc to clear');
    expect(paletteLines('zz', fresh, 0, 8, 80, true)[0]).toBe(pad('  no command matches /zz - keep typing, or Esc to clear'));
    // the card never overflows at a tiny width
    for (const w of [1, 4, 10, 24, 34]) for (const l of paletteLines('zz', fresh, 0, 8, w)) expect(cells(l), String(w)).toBe(w);
  });
  it('§4.3 P-P4: the value cursor is `▹` (`-` in ascii), never the command marker, and the footer counts the list the keys are walking', () => {
    expect(VALUE_MARKER).toBe('▹ ');
    expect(VALUE_MARKER_ASCII).toBe('- ');
    const rows = paletteRows('/mode j', fresh, 0, 8, 80, false, 1);
    const values = rows.filter((r) => r.kind === 'value');
    expect(values.map((r) => r.name)).toEqual(['/mode jev-on', '/mode jev-off', '/mode jev-only', '/mode llm-jev']);
    expect(values.map((r) => r.selected)).toEqual([false, true, false, false]);
    expect(values[1]?.text.startsWith('▹ ')).toBe(true);
    expect(values[0]?.text.startsWith('  ')).toBe(true);
    // the `(i/N)` prefix counts the VALUES in the argument states
    expect(rows.at(-1)?.text.trimStart().startsWith('(2/4)')).toBe(true);
    expect(paletteRows('/mode j', fresh, 0, 8, 80, true, 1).filter((r) => r.kind === 'value')[1]?.text.startsWith('- ')).toBe(true);
  });
  it('§4.3 P-P3: the value cursor `j` and the match index `i` are two cursors — `selected` never moves the value list', () => {
    // the regression this pins: `vsel` used to be `wrapIndex(valueIndex ?? selected, …)` while `selSpec` was
    // `matches[selected]`, so ONE number stood for both cursors. `/mode j` with `selected = 1` picked /model (no
    // `args[0].values`), which dropped every sub-row and printed `(0/0)` while `paletteGhostFor` still previewed a
    // /mode value — the marker/ghost disagreement §4.3 exists to close, reintroduced in the argument states.
    for (let i = 0; i < paletteMatches('/mode j', fresh).length; i++) {
      for (const j of [0, 1, 2, 3]) {
        const rows = paletteRows('/mode j', fresh, i, 8, 80, false, j);
        const values = rows.filter((r) => r.kind === 'value');
        expect(values, `i=${i} j=${j}`).toHaveLength(4);
        // the command marker stays on the draft's own row, whatever `i` was before the argument was typed
        expect(rows.find((r) => r.kind === 'command' && r.selected)?.name, `i=${i} j=${j}`).toBe('/mode');
        expect(values.findIndex((r) => r.selected), `i=${i} j=${j}`).toBe(j);
        expect(rows.at(-1)?.text.trimStart().startsWith(`(${j + 1}/4)`), `i=${i} j=${j}`).toBe(true);
      }
    }
    // §4.8 F-P2's frame: the sub-rows on screen and `(2/4)` with the cursor on the second value
    expect(paletteRows('/mode ', fresh, 0, 7, 76, false, 1).at(-1)?.text.trimEnd()).toBe('  (2/4)  Enter next value · Tab picks · Esc closes');
    // and when the row budget cuts the list the footer says how many are off screen (§4.3 P-P4), never silently
    expect(paletteRows('/mode ', fresh, 0, 6, 76, false, 1).at(-1)?.text.trimEnd()).toBe('  (2/4)  Enter next value · Tab picks · Esc closes · … +1 more');
    expect(paletteRows('/mode ', fresh, 0, 6, 76, true, 1).at(-1)?.text.trimEnd()).toBe('  (2/4)  Enter next value - Tab picks - Esc closes - ... +1 more');
    // and the ghost agrees with the cursor, at every j (P-P2 + P-P3 are one question)
    const m = paletteMatches('/mode j', fresh);
    for (const j of [0, 1, 2, 3]) {
      const g = paletteGhostFor('/mode j', m, j);
      const row = paletteRows('/mode j', fresh, 0, 8, 80, false, j).filter((r) => r.kind === 'value')[j];
      const target = g === null ? null : g.kind === 'arrow' ? g.target : `/mode j${g.rest}`;
      expect(target, `j=${j}`).toBe(row?.name);
    }
  });
  it('§4.3 P-P4 invariant: in every argument state the footer counts the list the keys walk, and it is never `(0/0)`', () => {
    for (const c of COMMANDS) {
      const values = c.args[0]?.values;
      if (values === undefined) continue;
      const matches = paletteMatches(`/${c.name} `, fresh);
      for (let i = 0; i < matches.length; i++) {
        for (let j = 0; j < values.length; j++) {
          const rows = paletteRows(`/${c.name} `, fresh, i, 10, 100, false, j);
          const shown = rows.filter((r) => r.kind === 'value').length;
          const footer = /\((\d+)\/(\d+)\)/.exec(rows.at(-1)?.text ?? '');
          expect(footer, `/${c.name} i=${i} j=${j}`).not.toBeNull();
          const [, at, total] = footer as RegExpExecArray;
          expect(Number(total), `/${c.name} i=${i} j=${j}`).toBe(values.length);
          expect(Number(at), `/${c.name} i=${i} j=${j}`).toBe(j + 1);
          expect(shown, `/${c.name} i=${i} j=${j}`).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('TUI-DESIGN-4 §4.6: the numbered list both twins share', () => {
  it('the header, the numbering, the width bound and the screen-reader line', () => {
    const lines = paletteNumberedLines('', fresh, 80);
    expect(lines[0]).toBe('commands (41) — type a number or a name, then Enter');
    expect(lines).toHaveLength(COMMANDS.length + 1);
    for (const l of lines) expect(cells(l), l).toBeLessThanOrEqual(80);
    for (const l of paletteNumberedLines('', fresh, 60)) expect(cells(l), l).toBeLessThanOrEqual(60);
    expect(paletteNumberedLines('', fresh, 80, true)[0]).toBe('commands (41) - type a number or a name, then Enter');
    // every new command of this round is reachable by number: '/fullscreen', '/scrollback', '/peers', '/ui reset'
    const text = lines.join('\n');
    for (const name of ['/fullscreen', '/scrollback', '/peers', '/ui']) expect(text, name).toContain(name);
    // the SR announcement, byte-identical between `--plain --screen-reader` and the TUI under SR
    expect(srPaletteLine(2, 37, findCommand('resume') as CommandSpec)).toBe('palette: 3 of 37 · /resume · pick a session to continue, or continue <id|title> · Enter next, Tab picks, Esc closes');
    expect(SR_PALETTE_COALESCE_MS).toBe(400);
  });
  it('§4.6: `--plain` and the screen reader share ONE formatter, so their blocks are byte-identical by construction', () => {
    // the identity §4.6 requires ("`--plain --screen-reader` and the TUI under SR emit byte-identical lines") can
    // only be asserted here for now: `paletteNumberedLines` has one caller in `src`, the `--plain` composer, and
    // the TUI-under-SR half needs S1's `App.tsx` row (§9.2 request (l)). This pins the formatter as the single
    // source both sides must use, at the width `--plain` uses on a pipe.
    const plain = paletteNumberedLines('', plainPaletteState(false), PLAIN_COLUMNS);
    expect(plain).toEqual(paletteNumberedLines('', { lastStop: null, unauthorized: false, changedFiles: false, rewindMenu: false, live: false }, 80));
    expect(plain[0]).toBe(`commands (${COMMANDS.length}) — type a number or a name, then Enter`);
    // the `… N more — /help commands` tail: it never fires at 41 commands (the cap is 40 and one hidden row would
    // cost the row it saves), and from two hidden rows up it does — asserted on the formatter's own arithmetic
    expect(plain.some((l) => l.includes('more — /help commands'))).toBe(false);
    expect(numberedShown(41)).toBe(41);
    expect(numberedShown(42)).toBe(40);
    expect(numberedShown(43)).toBe(40);
    expect(numberedPrompt(41)).toBe('pick 1-41, or type a message > ');
  });
});

describe('helpLines (TUI-DESIGN §5.3; TUI-DESIGN-3 §4.1 rule 7, §4.4 F9)', () => {
  /** every command has its own `  /<name>` line (the strict form of the finding-4 assertion) */
  const everyCommand = (lines: string[]): string[] => COMMANDS.filter((c) => !lines.some((l) => l.startsWith(`  /${c.name}`))).map((c) => c.name);
  /** every per-terminal note is present (compacted levels pack the two short theme notes into one line) */
  const allNotes = (lines: string[]): boolean => HELP_NOTES.every((n) => lines.some((l) => l.includes(n)));

  it('≤ 60 lines at 80 columns with EVERY command on its own line and the four per-terminal notes — the round-2 rows (TUI-DESIGN-2 §1.3 /mode /llm, §4.6 /panel /transcript, the panel keys) and the round-3 aliases fit through compaction level 3, never the tail cut', () => {
    const lines = helpLines(80);
    expect(lines.length).toBeLessThanOrEqual(HELP_MAX_LINES);
    // TUI-DESIGN-4: with 41 commands the level-4 block is exactly 60 rows at 80 columns because the `keys` header
    // shares the first packed row — the whole key table and every command line survive at the default width
    expect(lines[0]?.startsWith('keys  global: ')).toBe(true);
    expect(lines).toContain('commands');
    // level 3: the key contexts pack into one block, each context named where its keys start
    for (const ctx of ['global:', 'composer:', 'review box:', 'session picker:', 'palette:']) expect(lines.some((l) => l.includes(ctx)), ctx).toBe(true);
    expect(everyCommand(lines)).toEqual([]);
    for (const name of ['exit', 'mode', 'llm', 'panel', 'transcript', 'help', 'quit'.replace('quit', 'exit')]) expect(lines.some((l) => l.startsWith(`  /${name}`)), name).toBe(true);
    // TUI-DESIGN-4: with 41 commands the notes go at 80 columns (level 4) — the ladder's own rule, "a command line outranks a terminal tip"
    expect(allNotes(lines)).toBe(false);
    expect(lines[lines.length - 1]).not.toBe(HELP_POINTER);
    for (const l of lines) expect(cells(l), l).toBeLessThanOrEqual(80);
    // at 120 columns the block is whole too (41 commands push the four notes out at 100 — a command outranks a tip)
    const wide = helpLines(120);
    expect(wide.length).toBeLessThanOrEqual(HELP_MAX_LINES);
    expect(everyCommand(wide)).toEqual([]);
    expect(allNotes(wide)).toBe(true);
    for (const l of wide) expect(cells(l), l).toBeLessThanOrEqual(120);
    expect(everyCommand(helpLines(100))).toEqual([]);
    // wide terminals keep the uncompacted form: one context title line per key context and the `notes` header, one note per line
    const level0 = helpLines(400); // TUI-DESIGN-4: 41 commands push level 0 past the cap until 400 columns
    expect(level0).toContain('notes');
    for (const ctx of ['  global', '  composer', '  review box', '  session picker', '  palette']) expect(level0).toContain(ctx);
    for (const n of HELP_NOTES) expect(level0).toContain(`  ${n}`);
    expect(HELP_NOTES).toEqual(['Shift+Enter needs a keyboard protocol: use Ctrl+J or \\ then Enter', 'macOS: turn on "Option as Meta" for Alt-b/Alt-f', 'colour-blind? /theme daltonized', 'light terminal? /theme light']);
  });
  it('TUI-DESIGN-3 §4.1 rule 7: the command lines show the aliases after the name (`  /status, /s   <title>`), and the `live` option keeps only the tag that applies now — every tag survives the cut', () => {
    const lines = helpLines(80);
    expect(lines.find((l) => l.startsWith('  /status'))).toMatch(/^ {2}\/status, \/s\s+run id, session id/);
    expect(lines.find((l) => l.startsWith('  /exit'))).toMatch(/^ {2}\/exit, \/q, \/quit\s+leave/);
    expect(lines.find((l) => l.startsWith('  /resume'))).toMatch(/^ {2}\/resume, \/r, \/sessions, \/continue \[id\|title\] /);
    expect(helpCommandHead(findCommand('undo') as CommandSpec)).toBe('  /undo, /u [n]');
    expect(helpCommandHead(findCommand('steer') as CommandSpec)).toBe('  /steer <text>');
    // no `live`: every non-any command carries its tag (the palette's historical form)
    expect(lines.find((l) => l.startsWith('  /undo'))).toMatch(/ \(idle only\)$/);
    expect(lines.find((l) => l.startsWith('  /steer'))).toMatch(/ \(live only\)$/);
    // live: idle-only commands are tagged, live-only ones are not; idle: the reverse
    const whileLive = helpLines(80, { live: true });
    expect(whileLive.find((l) => l.startsWith('  /undo'))).toMatch(/ \(idle only\)$/);
    expect(whileLive.find((l) => l.startsWith('  /steer'))).not.toContain('(live only)');
    const whileIdle = helpLines(80, { live: false });
    expect(whileIdle.find((l) => l.startsWith('  /undo'))).not.toContain('(idle only)');
    expect(whileIdle.find((l) => l.startsWith('  /steer'))).toMatch(/ \(live only\)$/);
    expect(whileIdle.find((l) => l.startsWith('  /cost'))).not.toMatch(/only\)$/);
    for (const opts of [{}, { live: true }, { live: false }]) {
      const ls = helpLines(80, opts);
      expect(ls.length).toBeLessThanOrEqual(HELP_MAX_LINES);
      for (const l of ls) expect(cells(l), l).toBeLessThanOrEqual(80);
    }
  });
  it('the compaction ladder: 70 columns drops the notes (level 4) before any command; below 60 the tail is cut with the docs pointer; the ladder is documented', () => {
    expect(HELP_COMPACTION_LEVELS).toHaveLength(6); // TUI-DESIGN-4: level 5 — the key table gives way to its pointer
    expect(HELP_POINTER).toBe('  … see docs/KEYS.md and docs/COMMANDS.md for the rest');
    const at70 = helpLines(70);
    expect(at70.length).toBeLessThanOrEqual(HELP_MAX_LINES);
    expect(everyCommand(at70)).toEqual([]);
    expect(allNotes(at70)).toBe(false);
    expect(at70[at70.length - 1]).not.toBe(HELP_POINTER);
    // TUI-DESIGN-4 level 5: below 80 columns the key table becomes one pointer row and **no command is ever cut**;
    // the tail cut (HELP_POINTER) stays as the last resort behind it
    expect(at70[1]).toBe(cut(HELP_KEYS_POINTER, 70));
    for (const width of [40, 50, 59]) {
      const narrow = helpLines(width);
      expect(narrow.length, `${width}`).toBeLessThanOrEqual(HELP_MAX_LINES);
      expect(everyCommand(narrow), `${width}`).toEqual([]);
      expect(narrow[1], `${width}`).toBe(cut(HELP_KEYS_POINTER, width));
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
    expect(helpLines(100, { ascii: true }).some((l) => l.includes(' - '))).toBe(true);
    expect(helpLines(80, { ascii: true }).some((l) => l.includes('...'))).toBe(true); // the level-5 key pointer takes its ascii twin
    const narrow = helpLines(40);
    expect(narrow.length).toBeLessThanOrEqual(HELP_MAX_LINES);
    for (const l of narrow) expect(cells(l)).toBeLessThanOrEqual(40);
    expect(helpLines(Number.NaN).length).toBeGreaterThan(10);
  });
});
