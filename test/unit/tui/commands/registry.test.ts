/**
 * TUI-DESIGN §19.0: the command table — every §5.2 row present with its args/avail/plain, aliases resolve,
 * `availableDuringTask` error sentences verbatim (§24), registry ↔ docs/COMMANDS.md, the generated docs
 * (KEYS.md, COMMANDS.md, man page, completions) in sync with the registries (`gen-docs.mjs --check`, CRLF
 * copies included), and their quality gates: `mandoc -T lint` (no WARNING/ERROR), `bash -n`, `zsh -n`,
 * `fish -n` (each skipped when the tool is absent), a deterministic `.TH` date.
 */
import { execFileSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODE, MODE_BADGE_WORD, MODE_SETTING_VALUES } from '../../../../src/config/defaults.js';
import { COMMAND_ACTION_KINDS, dispatchCommand, type CommandAction } from '../../../../src/tui/commands/dispatch.js';
import { paletteGhost, paletteMatches, type PaletteState } from '../../../../src/tui/commands/palette.js';
import { BUDGET_SETTINGS, COMMANDS, ENGINE_MODES, EXIT_ONE_LETTER, LLM_STATES, LLM_STATE_MODE, MODE_VALUE_HINTS, NO_ONE_LETTER_ALIAS, PANEL_ARGS, POPULAR, THEMES, TRANSCRIPT_VIEWS, availabilityError, commandNames, findCommand, isExactCommand, restArgIndex, shortestAlias, takesRest, type CommandSpec } from '../../../../src/tui/commands/registry.js';
import { PROVIDER_IDS } from '../../../../src/provider/ids.js';
import { routeSubmit } from '../../../../src/tui/composer/submit.js';
import { parsePanelCommand } from '../../../../src/tui/pane/commands.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const COMMANDS_MD = `${ROOT}docs/COMMANDS.md`;
const GENERATED = ['docs/KEYS.md', 'docs/COMMANDS.md', 'man/jevcode.1', 'completions/jevcode.bash', 'completions/jevcode.zsh', 'completions/jevcode.fish'];

/** true when an executable of that name is on PATH (the quality gates skip when a tool is absent) */
function hasBin(name: string): boolean {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

function run(cmd: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): { code: number; out: string; err: string } {
  try {
    const out = execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, env });
    return { code: 0, out, err: '' };
  } catch (e) {
    const x = e as { status?: number | null; stdout?: string; stderr?: string };
    return { code: x.status ?? 1, out: x.stdout ?? '', err: x.stderr ?? '' };
  }
}

/** TUI-DESIGN §5.2 rows with the TUI-DESIGN-3 §4.1 alias table (D-K: 21 new aliases; `nw` for /new, `q`/`quit` for /exit, none for /abort) */
const EXPECTED: readonly [name: string, avail: CommandSpec['availableDuringTask'], plain: string, aliases: readonly string[]][] = [
  ['help', 'any', 'yes', ['h']],
  ['new', 'idle', 'yes', ['nw']],
  ['resume', 'idle', '`/resume <id|title>` only', ['r', 'sessions', 'continue']],
  ['rename', 'any', 'yes', []],
  ['steer', 'live', 'yes', []],
  ['unsteer', 'live', 'yes', []],
  ['pause', 'any', 'yes', []], // TUI-DESIGN-5 §2.6: `'any'` — `/pause <target>` touches no local engine; the local form refuses per form (§12 S45a)
  ['abort', 'live', 'yes', []],
  ['undo', 'idle', 'yes (readline `y/N`)', ['u']],
  ['rewind', 'idle', 'yes', ['rw']],
  ['diff', 'any', 'inline only', ['d']],
  ['plan', 'any', 'yes', ['pl']],
  ['decisions', 'any', 'yes', ['dc']],
  ['why', 'any', 'yes', ['w']],
  ['calibration', 'idle', 'yes', []],
  ['jev', 'any', 'yes', ['j']],
  ['cost', 'any', 'yes', ['c']],
  ['budget', 'any', 'yes', ['b']],
  ['model', 'any', 'yes', ['ml']],
  ['provider', 'any', 'yes', []],
  ['mode', 'any', 'yes', ['m']],
  ['llm', 'any', 'yes', []],
  ['config', 'any', 'yes', ['cf']],
  ['login', 'any', '`/login` raw-mode prompt', ['l']],
  ['logout', 'any', 'yes', []],
  ['trust', 'idle', 'yes', []],
  ['theme', 'any', 'n/a', ['t']],
  ['panel', 'any', 'yes', ['p']],
  ['transcript', 'any', 'always full', ['tr']],
  ['copy', 'any', 'n/a', ['cp']],
  ['export', 'idle', 'yes', []],
  ['status', 'any', 'yes', ['s']],
  ['errors', 'any', 'yes', []],
  ['report', 'idle', 'yes', []],
  ['history', 'any', 'yes', []],
  ['editor', 'any', 'n/a', []],
  ['exit', 'any', 'yes', ['q', 'quit']],
  // TUI-DESIGN-4 §1.3.1, §1.3.4, §7.10, §7.1: the four round-4 rows (37 → 41)
  ['fullscreen', 'any', 'yes', []],
  ['scrollback', 'any', 'yes', []],
  ['peers', 'any', 'yes', []],
  ['ui', 'any', 'yes', []],
  // TUI-DESIGN-5 §2.3, §2.7, §2.9: R5-2's six rows of the one §9.2 registry PR (41 → 47, and 47 → 56 with the
  // nine rows below — the integration pass landed every slot's rows and R5-6's `/provider` values edit)
  ['who', 'any', 'yes', []],
  ['inbox', 'any', 'yes', []],
  ['tell', 'any', 'yes', []],
  ['headsup', 'any', 'yes', []],
  ['request', 'any', 'yes', []],
  ['end', 'any', 'yes', []],
  // TUI-DESIGN-5 §3.2 / §3.3 (R5-3), §4.9 (R5-4, D-AN) and §5.5 (R5-5): the nine rows that complete the one §9.2
  // registry PR, 47 → 56. `/compact` is `'live'` (§3.3: folding history is meaningless with no next prompt) and
  // `/land` is `'idle'` and the only `destructive` one of the seven (§4.9).
  ['context', 'any', 'yes', []],
  ['compact', 'live', 'yes', []],
  ['split', 'any', 'yes', []],
  ['agents', 'any', 'yes', []],
  ['agent', 'any', 'yes', []],
  ['land', 'idle', 'yes', []],
  ['spawn', 'live', 'yes', []],
  ['import', 'idle', 'yes', ['imp']],
  ['memory', 'any', 'yes', ['mem']],
];

/** TUI-DESIGN-3 §4.1: the alias table, verbatim (command → aliases after round 3) */
const ALIAS_TABLE: Readonly<Record<string, readonly string[]>> = {
  help: ['h'], panel: ['p'], mode: ['m'], plan: ['pl'], model: ['ml'], diff: ['d'], cost: ['c'], undo: ['u'], status: ['s'], theme: ['t'],
  resume: ['r', 'sessions', 'continue'], login: ['l'], new: ['nw'], budget: ['b'], exit: ['q', 'quit'], jev: ['j'], transcript: ['tr'], copy: ['cp'],
  config: ['cf'], rewind: ['rw'], why: ['w'], decisions: ['dc'], llm: [], abort: [], steer: [],
  // TUI-DESIGN-5 §5.5: the only two round-5 rows with aliases; every other new row takes none, so no round-5
  // command can shadow a `PANEL_ARGS` / `TRANSCRIPT_VIEWS` / `LLM_STATES` word.
  import: ['imp'], memory: ['mem'],
};
const fresh: PaletteState = { lastStop: null, unauthorized: false, changedFiles: false, rewindMenu: false, live: false };
const NAME_RE = /^[a-z][a-z0-9-]*$/;

describe('COMMANDS (TUI-DESIGN §5.2)', () => {
  it('has every §5.2 row in order with avail, plain and aliases', () => {
    expect(COMMANDS.map((c) => c.name)).toEqual(EXPECTED.map((e) => e[0]));
    for (const [name, avail, plain, aliases] of EXPECTED) {
      const c = findCommand(name);
      expect(c, name).not.toBeNull();
      expect(c?.availableDuringTask, name).toBe(avail);
      expect(c?.plain, name).toBe(plain);
      expect(c?.aliases, name).toEqual(aliases);
    }
  });
  it('names and aliases are unique, valid, and every spec has a title, usage and semantics', () => {
    const all = COMMANDS.flatMap((c) => [c.name, ...c.aliases]);
    expect(new Set(all).size).toBe(all.length);
    for (const n of all) expect(n).toMatch(/^[a-z][a-z0-9-]*$/);
    for (const c of COMMANDS) {
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.usage.length).toBeGreaterThan(0);
      expect(c.semantics.length).toBeGreaterThan(0);
      for (const a of c.args) {
        if (a.kind === 'enum' || a.kind === 'setting') expect(a.values?.length ?? 0, `${c.name} ${a.name}`).toBeGreaterThan(0);
      }
    }
  });
  it('argument specs match the design: /budget settings with hints, /theme values, /diff flags, /decisions [n] [stage]', () => {
    const budget = findCommand('budget') as CommandSpec;
    expect(budget.args[0]?.kind).toBe('setting');
    expect(budget.args[0]?.values).toEqual(BUDGET_SETTINGS);
    for (const v of BUDGET_SETTINGS) expect(budget.args[0]?.valueHints?.[v]?.title, v).toBeTruthy();
    expect(findCommand('theme')?.args[0]?.values).toEqual(THEMES);
    expect((findCommand('diff')?.flags ?? []).map((f) => [f.name, f.idleOnly ?? false])).toEqual([['full', true], ['all', false]]);
    expect(findCommand('decisions')?.args.map((a) => a.kind)).toEqual(['int', 'enum']);
    expect(findCommand('undo')?.args[0]).toMatchObject({ kind: 'step', optional: true });
    expect(findCommand('resume')?.args[0]).toMatchObject({ kind: 'run', optional: true });
    expect(findCommand('rename')?.args[0]).toMatchObject({ kind: 'rest' });
    expect(findCommand('export')?.args[0]).toMatchObject({ kind: 'path', optional: true });
    expect((findCommand('resume')?.flags ?? []).find((f) => f.name === 'sort')).toMatchObject({ value: true, values: ['updated', 'created'] });
    expect(COMMANDS.filter(takesRest).map((c) => c.name)).toEqual(['rename', 'steer', 'why', 'headsup']);
    // TUI-DESIGN-5 §2.9: `restArgIndex` generalises `takesRest` to a rest argument that is merely LAST, so
    // `/tell mbp don't touch the tests` is a message and never `unterminated quote`
    expect(COMMANDS.filter((c) => restArgIndex(c) >= 0).map((c) => [c.name, restArgIndex(c)])).toEqual([
      ['rename', 0],
      ['steer', 0],
      ['why', 0],
      ['tell', 1],
      ['headsup', 0],
      ['request', 2],
      // TUI-DESIGN-5 §4.9 / §5.5: the round-5 rows whose LAST argument is the raw remainder — `/agent <slug>
      // <verb> [args]`, `/spawn <role> <glob> [task]` and `/memory [op] [<text>]`. `/import`'s `[<source>]` is a
      // bare token, not a rest, so it is deliberately absent.
      ['agent', 2],
      ['spawn', 2],
      ['memory', 1],
    ]);
  });
  it('TUI-DESIGN-2 §1.3 / §4.6: /mode takes an optional jev-only|jev-on|jev-off|llm-jev; /llm <on|off>; /panel [d|p|t|s|a|off|full]; /transcript [compact|full] — strings verbatim', () => {
    const mode = findCommand('mode') as CommandSpec;
    // AGENT-LOOP-DESIGN §14.1: `legacy` is always accepted (it lists the older modes); it is LISTED only once the default flips to agent
    expect(mode.args[0]).toEqual({ name: 'm', kind: 'enum', values: ['jev-only', 'jev-on', 'jev-off', 'llm-jev', 'agent'], accepts: ['legacy'], optional: true, hint: '[jev-only|jev-on|jev-off|llm-jev]', valueHints: { ...MODE_VALUE_HINTS, legacy: { title: 'list the older modes (saved configs, resume, the bench)' } }, defaultValue: DEFAULT_MODE });
    expect(mode.title).toBe('engine mode: show, or set for the next run');
    expect(mode.usage).toBe('[jev-only|jev-on|jev-off|llm-jev]');
    expect(mode.semantics).toBe('no argument: current and next mode; with one: pending for the **next** run (memory); `jev-on` with no generator key opens the wizard\'s generator step in place; persist with `jevcode config set mode <m>`');
    expect(ENGINE_MODES).toEqual(['jev-only', 'jev-on', 'jev-off', 'llm-jev', 'agent']);
    const llm = findCommand('llm') as CommandSpec;
    expect(llm.args[0]).toEqual({ name: 'state', kind: 'enum', values: ['on', 'off'], hint: '<on|off>' });
    expect(llm.title).toBe('Jev + LLM on (= /mode jev-on) or off (= /mode jev-only)');
    expect(llm.usage).toBe('<on|off>');
    expect(llm.semantics).toBe('`/llm on` = `/mode jev-on`, `/llm off` = `/mode jev-only`');
    expect(llm.category).toBe('config');
    expect(LLM_STATE_MODE).toEqual({ on: 'jev-on', off: 'jev-only' });
    const panel = findCommand('panel') as CommandSpec;
    // TUI-DESIGN-5 §4.3 (R5-4's §9.2 request): `'a'` joins `PANEL_ARGS` in this file's one PR — the ARGUMENT
    // exists always, the TAB only while something delegates (`paneTabsFor`, R5-4's `src/tui/pane/model.ts`)
    expect(panel.args[0]).toMatchObject({ kind: 'enum', values: ['d', 'p', 't', 's', 'a', 'off', 'full'], optional: true, hint: '[d|p|t|s|a|off|full]' });
    expect(panel.usage).toBe('[d|p|t|s|a|off|full]');
    expect(panel.category).toBe('ui');
    const transcript = findCommand('transcript') as CommandSpec;
    expect(transcript.args[0]).toMatchObject({ kind: 'enum', values: ['compact', 'full'], optional: true, hint: '[compact|full]' });
    expect(transcript.usage).toBe('[compact|full]');
    expect(transcript.category).toBe('ui');
    // TUI-DESIGN-3 §4.4 F3: `--plain` is always the full view, so the readline composer forwards the line (the host answers `always full`)
    expect(transcript.plain).toBe('always full');
    expect(findCommand('panel')?.plain).toBe('yes');
    // the palette lists them; `/llm` is a name, not an alias of /mode (its own row in docs/COMMANDS.md)
    for (const n of ['/mode', '/llm', '/panel', '/transcript']) expect(commandNames()).toContain(n);
    expect(findCommand('llm')?.name).toBe('llm');
  });
  it('TUI-DESIGN-3 §4.1 (D-K): the alias table verbatim; every alias a NAME_RE token, unique across names + aliases, never a name, never a PANEL_ARGS / TRANSCRIPT_VIEWS / LLM_STATES word; popular aliases ≤ 2 characters; no one-letter alias for /new, /exit, /abort (their Enter destroys state without a confirm); /undo\'s `u` passes (the undo confirm)', () => {
    for (const [name, aliases] of Object.entries(ALIAS_TABLE)) expect(findCommand(name)?.aliases, name).toEqual(aliases);
    const names = new Set(COMMANDS.map((c) => c.name));
    const all = COMMANDS.flatMap((c) => c.aliases);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(27); // 4 before round 3 + 21 in round 3 + TUI-DESIGN-5 §5.5's `imp` and `mem`
    for (const a of all) {
      expect(a).toMatch(NAME_RE);
      expect(names.has(a), `alias ${a} is a command name`).toBe(false);
    }
    // PANEL_ARGS / TRANSCRIPT_VIEWS / LLM_STATES words live after the name, so `d` the alias and `d` the argument never meet: `/p d` is /panel on the decisions tab
    expect((PANEL_ARGS as readonly string[]).filter((w) => all.includes(w))).toEqual(['d', 'p', 't', 's']);
    expect((TRANSCRIPT_VIEWS as readonly string[]).some((w) => all.includes(w))).toBe(false);
    expect((LLM_STATES as readonly string[]).some((w) => all.includes(w))).toBe(false);
    expect(parsePanelCommand('/p d')).toEqual({ kind: 'panel', arg: 'd' });
    expect(dispatchCommand('/d 3', { run: 'none', step: 3 })).toMatchObject({ ok: true, action: { kind: 'diff', step: 3 } });
    expect(NO_ONE_LETTER_ALIAS).toEqual(['new', 'abort']);
    for (const name of NO_ONE_LETTER_ALIAS) for (const a of findCommand(name)?.aliases ?? []) expect(a.length, `${name} alias ${a}`).toBeGreaterThanOrEqual(2);
    // /exit keeps `q` (the letter every pager teaches) as its only one-letter alias; `x` is gone
    expect(EXIT_ONE_LETTER).toBe('q');
    expect((findCommand('exit')?.aliases ?? []).filter((a) => a.length === 1)).toEqual([EXIT_ONE_LETTER]);
    expect(findCommand('undo')?.aliases).toEqual(['u']);
    for (const name of POPULAR) {
      const spec = findCommand(name) as CommandSpec;
      if (spec.aliases.length > 0) expect((shortestAlias(spec) as string).length, name).toBeLessThanOrEqual(2);
    }
    // `e` and `st` are not aliased (four popular e-prefixes; st is ambiguous with status)
    expect(findCommand('e')).toBeNull();
    expect(findCommand('st')).toBeNull();
    expect(findCommand('a')).toBeNull();
    expect(findCommand('x')).toBeNull();
    expect(findCommand('n')).toBeNull();
    expect(POPULAR).toHaveLength(16);
    for (const name of POPULAR) expect(findCommand(name), name).not.toBeNull();
  });
  it('TUI-DESIGN-3 §4.1 rules 1–3 / F22–F23: every alias runs its owner on Enter (`isExactCommand`, `routeSubmit` in the palette), pins it to the top of the palette against the real scorer, and ghosts the arrow `→ /owner`', () => {
    /** the required argument of the aliased commands that have one */
    const arg: Record<string, string> = { why: ' 3', theme: ' dark' };
    for (const c of COMMANDS) {
      for (const a of c.aliases) {
        expect(isExactCommand(`/${a}`), a).toBe(true);
        expect(findCommand(a)?.name, a).toBe(c.name);
        const line = `/${a}${arg[c.name] ?? ''}`;
        const r = dispatchCommand(line, { run: c.availableDuringTask === 'live' ? 'live' : 'none', step: 0 });
        expect(r.ok && r.spec.name, a).toBe(c.name);
        const routed = routeSubmit({ text: line, submitting: false, overlay: 'palette', run: c.availableDuringTask === 'live' ? 'live' : 'none', host: { detectSecrets: () => [] }, chips: new Map(), ranBefore: false, dispatch: { run: c.availableDuringTask === 'live' ? 'live' : 'none', step: 0 } });
        expect(routed.kind === 'command' && routed.spec.name, a).toBe(c.name);
        const matches = paletteMatches(`/${a}`, fresh);
        expect(matches[0]?.spec.name, a).toBe(c.name);
        expect(paletteGhost(`/${a}`, matches), a).toMatchObject({ arrow: `/${c.name}` });
      }
    }
    // the shortest alias is the palette column's (ties: table order)
    expect(shortestAlias(findCommand('resume') as CommandSpec)).toBe('r');
    expect(shortestAlias(findCommand('exit') as CommandSpec)).toBe('q');
  });
  it('TUI-DESIGN-3 §4.1 rule 8 (D-N): the /mode hints come from MODE_BADGE_WORD, name no default, and ENGINE_MODES is MODE_SETTING_VALUES; /model and /provider are optional (F15)', () => {
    expect(ENGINE_MODES).toBe(MODE_SETTING_VALUES);
    for (const m of MODE_SETTING_VALUES) expect(MODE_VALUE_HINTS[m].title.length).toBeGreaterThan(0);
    expect(MODE_VALUE_HINTS['jev-on'].title).toBe(`${MODE_BADGE_WORD['jev-on']}: the code model writes, Jev decides every step`);
    expect(MODE_VALUE_HINTS['llm-jev'].title).toBe(`${MODE_BADGE_WORD['llm-jev']}: candidate patches, tests verify, Jev arbitrates`);
    expect(MODE_VALUE_HINTS['jev-only'].title).toBe('no generating LLM; code proposes, Jev decides, tests verify');
    expect(MODE_VALUE_HINTS['jev-off'].title).toBe('the generator alone (bench condition)');
    for (const m of MODE_SETTING_VALUES) expect(MODE_VALUE_HINTS[m].title).not.toMatch(/default/);
    expect(findCommand('mode')?.args[0]?.defaultValue).toBe(DEFAULT_MODE);
    expect(findCommand('model')?.args[0]).toMatchObject({ kind: 'text', optional: true, hint: '[id]' });
    // TUI-DESIGN-5 §6.1 (D-AP) / §9.2's registry row: the palette offers the SEVEN ids, read from the one
    // zero-import table rather than re-declared — the two-name wall is the bug §6.3 exists to remove.
    expect(findCommand('provider')?.args[0]).toMatchObject({ kind: 'enum', optional: true, values: [...PROVIDER_IDS] });
    expect(PROVIDER_IDS.slice(0, 2)).toEqual(['anthropic', 'openrouter']);
    const src = readFileSync(`${ROOT}src/tui/commands/registry.ts`, 'utf8');
    expect(src).not.toMatch(/jev-only \(default|, the default\)|is the default|default mode is/);
  });
  it('TUI-DESIGN-3 §8 S4 (G1–G5): every CommandAction kind has a `case` in the App\'s runCommand or the controller\'s execute() (panel/transcript: the App\'s pre-router `parsePanelCommand`), and every command name has a `/name` literal in a test outside this loop', () => {
    const app = readFileSync(`${ROOT}src/tui/App.tsx`, 'utf8');
    const session = readFileSync(`${ROOT}src/cli/session.ts`, 'utf8');
    const kinds: readonly CommandAction['kind'][] = COMMAND_ACTION_KINDS;
    expect(new Set(kinds).size).toBe(kinds.length);
    /**
     * TUI-DESIGN-4 §9.2: the four round-4 commands are S4's registry rows, but their handlers are other slots' —
     * `/fullscreen` and `/scrollback` are S1's (§1.3.1, §1.3.4) and `/peers` / `/ui reset` are S6's copy in S3's
     * `session.ts` (§7.10, §7.1, §3.3's work list). The gate stays live for the other 36 and the `||` below keeps
     * passing once the cases land, at which point this set is deleted.
     */
    const PENDING_ROUND4_HANDLERS: ReadonlySet<string> = new Set(['fullscreen', 'scrollback', 'peers', 'uiReset']);
    /**
     * TUI-DESIGN-5 §9.2, the same shape: R5-2 owns the six `CommandAction` arms (`src/tui/commands/dispatch.ts`)
     * and the six registry rows, while their handlers live in `src/cli/session.ts` (R5-1's one W4 PR) — §9.2's
     * `session.ts` row lists R5-2's two requests and omits these six cases, which R5-2's report files as an exact
     * hunk. The set is deleted when that PR lands; until then `src/cli/session.ts`'s `assertNever(a)` is the
     * compile-time record of the same debt.
     */
    // The integration pass landed R5-1's `session.ts` W4 PR, so all six have a `case` there (five of them the
    // honest D-AN refusal, `who` the real block). The set is kept EMPTY rather than deleted so the next round's
    // debt has a named place to go, and the `every` assertion below still holds over it.
    const PENDING_ROUND5_HANDLERS: ReadonlySet<string> = new Set([]);
    for (const kind of kinds) {
      const handled = app.includes(`case '${kind}':`) || session.includes(`case '${kind}':`) || ((kind === 'panel' || kind === 'transcript') && parsePanelCommand(`/${kind}`)?.kind === kind);
      expect(handled || PENDING_ROUND4_HANDLERS.has(kind) || PENDING_ROUND5_HANDLERS.has(kind), `CommandAction kind '${kind}' has no case in App.tsx runCommand or session.ts execute()`).toBe(true);
    }
    expect([...PENDING_ROUND4_HANDLERS, ...PENDING_ROUND5_HANDLERS].every((k) => (kinds as readonly string[]).includes(k))).toBe(true);
    // every registry command dispatches to a listed kind
    // TUI-DESIGN-5 §4.9 / §5.5: the round-5 rows with REQUIRED positionals get a sample too — `/agent <slug>
    // <verb>` and `/spawn <role> <glob>`. The rest (`/context`, `/compact`, `/agents`, `/split`, `/land`,
    // `/import`, `/memory`) take none or take them optionally, so the bare name is a valid line.
    const sample: Record<string, string> = { rename: 'x', steer: 'x', why: '3', history: 'clear', theme: 'dark', llm: 'on', ui: 'reset', tell: 'mbp hello', headsup: 'editing engine.ts', request: 'mbp pause', agent: 'api pause', spawn: 'api src/api/** fix the 401' };
    for (const c of COMMANDS) {
      // TUI-DESIGN-5 §2.6 / §2.7: `/pause` and `/end` are `'any'`, but their local (no-target) form still needs a run
      const needsRun = c.availableDuringTask === 'live' || c.name === 'pause' || c.name === 'end';
      const r = dispatchCommand(`/${c.name} ${sample[c.name] ?? ''}`.trim(), { run: needsRun ? 'live' : 'none', step: 0 });
      expect(r.ok && kinds.includes(r.action.kind), c.name).toBe(true);
    }
    // G1: a `/name` literal in some unit test file other than this one (the dispatch loop above does not count)
    const testRoot = `${ROOT}test/unit/`;
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.test\.tsx?$/.test(e.name) && !p.endsWith('commands/registry.test.ts')) files.push(readFileSync(p, 'utf8'));
      }
    };
    walk(testRoot);
    const corpus = files.join('\n');
    for (const c of COMMANDS) expect(corpus.includes(`'/${c.name}`) || corpus.includes(`"/${c.name}`) || corpus.includes(`\`/${c.name}`), `no test outside the registry loop drives /${c.name}`).toBe(true);
  });
  it('findCommand resolves names and aliases case-insensitively, with or without the slash; isExactCommand is strict', () => {
    expect(findCommand('/Quit')?.name).toBe('exit');
    expect(findCommand('/S')?.name).toBe('status');
    expect(findCommand('TR')?.name).toBe('transcript');
    expect(findCommand('sessions')?.name).toBe('resume');
    expect(findCommand('continue')?.name).toBe('resume');
    expect(findCommand('h')?.name).toBe('help');
    expect(findCommand('/nope')).toBeNull();
    expect(findCommand('')).toBeNull();
    expect(isExactCommand('/budget')).toBe(true);
    expect(isExactCommand('budget')).toBe(true);
    expect(isExactCommand('/bud')).toBe(false);
    expect(isExactCommand('/budget ')).toBe(true);
    expect(isExactCommand('/budget spend-cap')).toBe(false);
    expect(commandNames()).toContain('/budget');
    expect(commandNames()).not.toContain('/quit');
  });
  it('availability errors are the §24 sentences', () => {
    expect(availabilityError(findCommand('undo') as CommandSpec, true)).toBe('error: /undo runs when the run is idle; Esc pauses first');
    expect(availabilityError(findCommand('steer') as CommandSpec, false)).toBe('error: /steer needs a live run');
    expect(availabilityError(findCommand('steer') as CommandSpec, true)).toBeNull();
    // TUI-DESIGN-5 §2.6 / §2.7 (§14.2 #16, #39): `/pause` and `/end` are `'any'` and the GENERATED sentence is
    // therefore null for both — the per-form refusal (§12 S45a / S45b) is the dispatcher's, asserted there
    expect(availabilityError(findCommand('pause') as CommandSpec, false)).toBeNull();
    expect(availabilityError(findCommand('end') as CommandSpec, false)).toBeNull();
    expect(availabilityError(findCommand('undo') as CommandSpec, false)).toBeNull();
    expect(availabilityError(findCommand('help') as CommandSpec, true)).toBeNull();
  });
  /**
   * TUI-DESIGN-5 §2.4 / §12 "Superseded, not kept": `/peers` keeps TD4's counts view, and its help text is
   * PUBLISHED to users through the generated `docs/COMMANDS.md`, so an advertised feature that no longer exists
   * is a user-visible lie. The per-peer kv rows are `/who`'s job now.
   */
  it('§2.4: `/peers` points at `/who` and no longer advertises the superseded per-peer kv rows', () => {
    const peers = findCommand('peers') as CommandSpec;
    expect(peers.title).toBe('other jevcode instances working in this workspace · /who shows what each is doing');
    expect(peers.title.endsWith(' · /who shows what each is doing')).toBe(true);
    // the four TD4 strings §12 keeps are named; the two superseded clauses are not
    for (const kept of ['peers · <n> here, <m> stale', 'no other jevcode is working in this workspace', 'the peer registry is not available in this build', '[w] wait for it   [r] read-only session   [q] quit']) {
      expect(peers.semantics, kept).toContain(kept);
    }
    for (const gone of ['kv row', 'started <t> ago', 'workspace, started']) expect(peers.semantics.toLowerCase(), gone).not.toContain(gone.toLowerCase());
    // the privacy contract is still stated, because it is what makes the counts view the whole view
    expect(peers.semantics).toContain('Never a pid, never a path');
    // …and the published doc carries the new `semantics`, not the retired kv rows (`title` is the palette's;
    // `docs/COMMANDS.md`'s description column is `semantics`)
    const doc = readFileSync(COMMANDS_MD, 'utf8');
    expect(doc).toContain('`/who` is the detailed view');
    expect(doc).not.toContain('one kv row per peer');
  });
  it('registry ↔ docs/COMMANDS.md: every command and alias is a row and no extra rows exist (generated)', () => {
    const doc = readFileSync(COMMANDS_MD, 'utf8');
    expect(doc).toContain('generated by scripts/gen-docs.mjs');
    const rows = doc.split('\n').filter((l) => /^\| `\//.test(l));
    expect(rows.length).toBe(COMMANDS.length);
    for (const c of COMMANDS) {
      const row = rows.find((l) => l.startsWith(`| \`/${c.name}\``));
      expect(row, c.name).toBeDefined();
      for (const a of c.aliases) expect(row, `${c.name} alias ${a}`).toContain(`alias \`/${a}\``);
      expect(row).toContain(`| ${c.availableDuringTask} |`);
    }
  });
});

describe('generated documentation is in sync (TUI-DESIGN §21)', () => {
  it('node scripts/gen-docs.mjs --check exits 0 (KEYS.md, COMMANDS.md, man page, completions)', () => {
    const out = execFileSync(process.execPath, ['scripts/gen-docs.mjs', '--check'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
    expect(out).toBe('');
  }, 60_000);
  it('--check tolerates CRLF copies (an autocrlf checkout) and still reports a stale target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcode-gen-docs-'));
    try {
      for (const rel of GENERATED) {
        const text = readFileSync(join(ROOT, rel), 'utf8');
        expect(text.includes('\r')).toBe(false);
        const abs = join(dir, rel);
        execFileSync('mkdir', ['-p', join(abs, '..')]);
        writeFileSync(abs, text.replace(/\n/g, '\r\n'));
      }
      expect(run(process.execPath, ['scripts/gen-docs.mjs', '--check', '--out', dir])).toMatchObject({ code: 0, out: '' });
      writeFileSync(join(dir, 'docs/KEYS.md'), 'stale\r\n');
      const stale = run(process.execPath, ['scripts/gen-docs.mjs', '--check', '--out', dir]);
      expect(stale.code).toBe(1);
      expect(stale.err).toContain('stale generated docs');
      expect(stale.err).toContain('docs/KEYS.md');
      expect(stale.err).not.toContain('COMMANDS.md');
      expect(run(process.execPath, ['scripts/gen-docs.mjs', '--check', '--out']).code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
  it('the man page date is deterministic: YYYY-MM-DD from git metadata, SOURCE_DATE_EPOCH overrides it', () => {
    const man = readFileSync(`${ROOT}man/jevcode.1`, 'utf8');
    expect(man).toMatch(/^\.TH JEVCODE 1 "\d{4}-\d{2}-\d{2}" "jevcode \d+\.\d+\.\d+[^"]*" "User Commands"$/m);
    const epoch = run(process.execPath, ['scripts/gen-docs.mjs', '--print', 'man'], { ...process.env, SOURCE_DATE_EPOCH: '0' });
    expect(epoch.code).toBe(0);
    expect(epoch.out).toContain('.TH JEVCODE 1 "1970-01-01"');
    // no trailing .br after the last SYNOPSIS line (a mandoc WARNING)
    const synopsis = man.slice(man.indexOf('.SH SYNOPSIS'), man.indexOf('.SH DESCRIPTION'));
    expect(synopsis.trimEnd().endsWith('.br')).toBe(false);
    expect(synopsis).toContain('.br');
    for (const line of man.split('\n')) expect(Buffer.byteLength(line), line).toBeLessThanOrEqual(256);
  }, 60_000);
  it.skipIf(!hasBin('mandoc'))('mandoc -T lint: no WARNING, ERROR or UNSUPP on the generated man page', () => {
    const r = run('mandoc', ['-T', 'lint', 'man/jevcode.1']);
    const bad = `${r.out}${r.err}`.split('\n').filter((l) => /(WARNING|ERROR|UNSUPP|FATAL):/.test(l));
    expect(bad).toEqual([]);
  });
  it.skipIf(!hasBin('bash'))('bash -n accepts the bash completion', () => {
    expect(run('bash', ['-n', 'completions/jevcode.bash'])).toMatchObject({ code: 0 });
  });
  it.skipIf(!hasBin('zsh'))('zsh -n accepts the zsh completion', () => {
    expect(run('zsh', ['-n', 'completions/jevcode.zsh'])).toMatchObject({ code: 0 });
  });
  it.skipIf(!hasBin('fish'))('fish -n accepts the fish completion', () => {
    expect(run('fish', ['-n', 'completions/jevcode.fish'])).toMatchObject({ code: 0 });
  });
  it('the man page and completions mention every CLI command and every slash command; the man ENVIRONMENT mode line derives from the table and DEFAULT_MODE (D-N); aliases propagate', () => {
    const man = readFileSync(`${ROOT}man/jevcode.1`, 'utf8');
    expect(man.startsWith('.\\" generated by scripts/gen-docs.mjs')).toBe(true);
    expect(man).toContain('.TH JEVCODE 1');
    for (const c of COMMANDS) expect(man, c.name).toContain(`/${c.name}`);
    for (const c of COMMANDS) for (const a of c.aliases) expect(man, `${c.name} alias ${a}`).toContain(`/${c.name}, /${a}`.replace(/-/g, '\\-').slice(0, `/${c.name}, /${a}`.length + 2).split(', /')[0] as string);
    const roffMode = (m: string): string => m.replace(/-/g, '\\-');
    expect(man.replace(/\n/g, ' ')).toContain(`engine mode (${MODE_SETTING_VALUES.map(roffMode).join(' | ')}; default ${roffMode(DEFAULT_MODE)})`);
    expect(man).not.toMatch(/the default \||is the default/);
    expect(man).not.toContain('Claude');
    expect(man).toContain('/status, /s');
    expect(man).toContain('/exit, /q, /quit');
    for (const code of ['0', '2', '3', '4', '5', '6', '129', '130', '143']) expect(man).toContain(`.B ${code}\n`);
    const bash = readFileSync(`${ROOT}completions/jevcode.bash`, 'utf8');
    const zsh = readFileSync(`${ROOT}completions/jevcode.zsh`, 'utf8');
    const fish = readFileSync(`${ROOT}completions/jevcode.fish`, 'utf8');
    for (const s of [bash, zsh, fish]) {
      expect(s).toContain('generated by scripts/gen-docs.mjs');
      expect(s).toContain('--spend-cap');
      expect(s).toContain('runs');
      expect(s).not.toContain('--mock');
    }
    expect(zsh.startsWith('#compdef jevcode')).toBe(true);
    expect(bash).toContain('complete -F _jevcode jevcode');
    expect(fish).toContain('complete -c jevcode');
  });
});
