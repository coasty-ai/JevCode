/**
 * The command table (TUI-DESIGN §5.2; TUI-DESIGN-2 §1.3 `/mode` `/llm`, §4.6 `/panel` `/transcript`; TUI-DESIGN-3 §4.1 the shortcut
 * aliases and `POPULAR`, D-K): one typed array feeds the dispatcher, the palette, help, `docs/COMMANDS.md` (scripts/gen-docs.mjs) and
 * the `--plain` readline composer. Pure data plus lookups. `availableDuringTask`: idle | live | any. `plain`: whether the readline
 * composer supports the command. Aliases (§4.1): every alias is a `NAME_RE` token, unique across names + aliases, never another
 * command's name; no one-letter alias for a command whose Enter destroys state without a confirm (`/new`, `/exit`, `/abort`).
 */
import { DEFAULT_MODE, MODE_BADGE_WORD, MODE_SETTING_VALUES } from '../../config/defaults.js';
import type { EngineMode } from '../../core/types.js';

/** TUI-DESIGN §5.1: the argument kinds `ArgSpec` validates. */
export type ArgKind = 'enum' | 'int' | 'usd' | 'duration' | 'run' | 'step' | 'path' | 'setting' | 'text' | 'rest';

/** TUI-DESIGN §5.1: one positional argument of a command. */
export interface ArgSpec {
  readonly name: string;
  readonly kind: ArgKind;
  /** `enum` / `setting` values, in palette order */
  readonly values?: readonly string[];
  /** palette sub-rows for `values` (`/budget spend-cap <usd>   run cap for the next /resume or run`) */
  readonly valueHints?: Readonly<Record<string, { readonly args?: string; readonly title: string }>>;
  readonly optional?: boolean;
  /** shown in the palette's arg-hint column, e.g. `<usd>` */
  readonly hint?: string;
  /** TUI-DESIGN-3 §4.1 rule 8: the value the palette suffixes ` (default)` at render time (`/mode` reads `DEFAULT_MODE`, D-N) */
  readonly defaultValue?: string;
}

/** TUI-DESIGN §5.2: `avail` column. */
export type Availability = 'idle' | 'live' | 'any';

/** TUI-DESIGN §5.2: a `--flag` a command accepts (`/diff --full --all`, `/resume --sort=created`). */
export interface FlagSpec {
  readonly name: string;
  readonly title: string;
  /** the flag is idle-only even when the command is `any` (`/diff --full`) */
  readonly idleOnly?: boolean;
  /** the flag takes `--flag=value` (a bare `--flag` is an error); absent = boolean (`--flag=value` is an error) */
  readonly value?: boolean;
  /** the accepted values of a value flag, in palette order */
  readonly values?: readonly string[];
}

/** TUI-DESIGN §5.2 / A63: the registry keeps a `project` category reserved for `.jevcode/commands/*.md`. */
export type CommandCategory = 'session' | 'run' | 'inspect' | 'money' | 'config' | 'files' | 'ui' | 'project';

/** TUI-DESIGN §5.2: one row of the command table. */
export interface CommandSpec {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly args: readonly ArgSpec[];
  readonly flags?: readonly FlagSpec[];
  readonly availableDuringTask: Availability;
  /** `--plain` support: yes | no | a note such as `/resume <id> only` */
  readonly plain: string;
  /** the one-line title the palette shows */
  readonly title: string;
  /** the `Args` column as the design writes it, e.g. `[spend-cap|session-spend-cap|… <v>]` */
  readonly usage: string;
  /** the semantics column for docs/COMMANDS.md and help */
  readonly semantics: string;
  readonly category: CommandCategory;
  /** §5.3 Suggested-group key (which state suggests this command first) */
  readonly suggestWhen?: 'stop' | 'budget-stop' | 'unauthorized' | 'changed-files' | 'rewind-menu';
}

/** TUI-DESIGN §9.4: the `/budget` settings. */
export const BUDGET_SETTINGS = ['spend-cap', 'session-spend-cap', 'max-steps', 'max-wall', 'max-replans', 'max-generator-tokens'] as const;

/** TUI-DESIGN §16: `/theme` values. */
export const THEMES = ['dark', 'light', 'daltonized', 'ansi'] as const;

/** TUI-DESIGN-2 §1.2 / §1.3: the engine modes in the round-2 table order; llm-jev last (docs/LLM-JEV-DESIGN.md §9.3). The default is `DEFAULT_MODE` (config/defaults.ts), never named here (TUI-DESIGN-3 §1.1, D-N). */
export const ENGINE_MODES: readonly EngineMode[] = MODE_SETTING_VALUES;
/**
 * TUI-DESIGN-3 §4.1 rule 8 / §10 "Commands": the `/mode` value hints — the badge word comes from the one table `MODE_BADGE_WORD`;
 * the row equal to `DEFAULT_MODE` gets ` (default)` when the palette renders it (`ArgSpec.defaultValue`), so no string here names a default.
 */
export const MODE_VALUE_HINTS: Readonly<Record<EngineMode, { readonly title: string }>> = {
  'jev-on': { title: `${MODE_BADGE_WORD['jev-on']}: the code model writes, Jev decides every step` },
  'llm-jev': { title: `${MODE_BADGE_WORD['llm-jev']}: candidate patches, tests verify, Jev arbitrates` },
  'jev-only': { title: 'no generating LLM; code proposes, Jev decides, tests verify' },
  'jev-off': { title: 'the generator alone (bench condition)' },
};
/** TUI-DESIGN-3 §4.1 rule 6: the Popular group of an empty palette query, in this fixed order (16 commands). */
export const POPULAR: readonly string[] = ['help', 'mode', 'model', 'cost', 'status', 'resume', 'new', 'panel', 'plan', 'diff', 'undo', 'theme', 'login', 'budget', 'jev', 'exit'];
/**
 * TUI-DESIGN-3 §4.1 (D-K): commands whose Enter destroys state without a confirm — never a one-letter alias (`a` for /abort and
 * `n` for /new are dropped; /new gets `nw`). `/exit` keeps `q` alone (the letter every pager teaches; `x` is dropped): `EXIT_ONE_LETTER`.
 */
export const NO_ONE_LETTER_ALIAS: readonly string[] = ['new', 'abort'];
export const EXIT_ONE_LETTER = 'q';
/** TUI-DESIGN-2 §1.3: `/llm on|off` → `/mode jev-on` | `/mode jev-only`. */
export const LLM_STATES = ['on', 'off'] as const;
export const LLM_STATE_MODE: Readonly<Record<(typeof LLM_STATES)[number], 'jev-on' | 'jev-only'>> = { on: 'jev-on', off: 'jev-only' };
/** TUI-DESIGN-2 §4.6: `/panel [d|p|t|s|off|full]`. */
export const PANEL_ARGS = ['d', 'p', 't', 's', 'off', 'full'] as const;
/** TUI-DESIGN-2 §4.5: `/transcript [compact|full]`. */
export const TRANSCRIPT_VIEWS = ['compact', 'full'] as const;

/** TUI-DESIGN §5.2 `COMMANDS` — the table, in the design's row order. */
export const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'help',
    aliases: ['h'],
    args: [{ name: 'topic', kind: 'enum', values: ['keys', 'commands', 'reload'], optional: true, hint: '[keys|commands|reload]', valueHints: { keys: { title: 'the key table only' }, commands: { title: 'the command list only' }, reload: { title: 're-read keybindings.json' } } }],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'keys by context, commands with one-liners, per-terminal notes',
    usage: '[keys|commands|reload]',
    semantics: 'append the help block (keys by context, commands with one-liners, per-terminal notes); `reload` re-reads `keybindings.json`',
    category: 'ui',
  },
  {
    name: 'new',
    aliases: ['nw'],
    args: [],
    availableDuringTask: 'idle',
    plain: 'yes',
    title: 'end the session; the next prompt starts a new one here',
    usage: '—',
    semantics: 'end the session; the next prompt starts a new session in this workspace (new `sessionId`, fresh root meter); item shows the old session\'s total',
    category: 'session',
  },
  {
    name: 'resume',
    aliases: ['r', 'sessions', 'continue'],
    args: [{ name: 'run', kind: 'run', optional: true, hint: '[id|title]' }],
    availableDuringTask: 'idle',
    plain: '`/resume <id|title>` only',
    title: 'pick a session to continue, or continue <id|title>',
    usage: '[id|title]',
    semantics: 'picker (§8.4); with an argument continue that run (a stopped run resumes; a `complete` run seeds a follow-up unless `--force`); after `/undo`/`/rewind` of that run the human note rides in `EngineOptions.humanDirective` and `undoLog` (§12.4); `/continue` = most recently used run here',
    category: 'session',
    suggestWhen: 'stop',
    flags: [{ name: 'force', title: 'resume a `complete` run instead of seeding a follow-up' }, { name: 'sort', title: '`--sort=created` orders the picker by creation time', value: true, values: ['updated', 'created'] }],
  },
  {
    name: 'rename',
    aliases: [],
    args: [{ name: 'title', kind: 'rest', hint: '<title>' }],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'set the session title (≤ 60 chars)',
    usage: '<title>',
    semantics: 'session title ≤ 60 (through the secret gate and `redact`); index `rename` line; status centre',
    category: 'session',
  },
  {
    name: 'steer',
    aliases: [],
    args: [{ name: 'text', kind: 'rest', hint: '<text>' }],
    availableDuringTask: 'live',
    plain: 'yes',
    title: 'queue a directive for the next step (= Enter while live)',
    usage: '<text>',
    semantics: '= Enter with text while live (needed by `--plain`)',
    category: 'run',
  },
  {
    name: 'unsteer',
    aliases: [],
    args: [],
    availableDuringTask: 'live',
    plain: 'yes',
    title: 'take the newest queued steer back (= Up on the first row)',
    usage: '—',
    semantics: '= Up on the first row: `engine.unsteer()`',
    category: 'run',
  },
  {
    name: 'pause',
    aliases: [],
    args: [],
    availableDuringTask: 'live',
    plain: 'yes',
    title: 'stop after the step in flight commits (= Esc)',
    usage: '—',
    semantics: '`engine.pause()` (= Esc)',
    category: 'run',
  },
  {
    name: 'abort',
    aliases: [],
    args: [],
    availableDuringTask: 'live',
    plain: 'yes',
    title: 'stop the run now (= Esc Esc); the step in flight is discarded',
    usage: '—',
    semantics: '`engine.abort(\'human_abort\')` (= Esc Esc)',
    category: 'run',
  },
  {
    name: 'undo',
    aliases: ['u'],
    args: [{ name: 'n', kind: 'step', optional: true, hint: '[n]' }],
    availableDuringTask: 'idle',
    plain: 'yes (readline `y/N`)',
    title: 'restore the files a step changed (verify-before-write)',
    usage: '[n]',
    semantics: '§12.4',
    category: 'files',
    suggestWhen: 'changed-files',
  },
  {
    name: 'rewind',
    aliases: ['rw'],
    args: [{ name: 'step', kind: 'step', optional: true, hint: '[step]' }],
    availableDuringTask: 'idle',
    plain: 'yes',
    title: 'pick a step; undo last…n, then files / plan+window / both',
    usage: '[step]',
    semantics: 'picker of steps with changed files → undo last…n → `files / plan+window / both` (§12.5)',
    category: 'files',
    suggestWhen: 'rewind-menu',
  },
  {
    name: 'diff',
    aliases: ['d'],
    args: [{ name: 'step', kind: 'step', optional: true, hint: '[step]' }],
    flags: [{ name: 'full', title: 'unified diff in `$GIT_PAGER`/`$PAGER`/`less` (idle only)', idleOnly: true }, { name: 'all', title: 'lift the 40-row cap' }],
    availableDuringTask: 'any',
    plain: 'inline only',
    title: 'numstat block of the run\'s changes (--full opens the pager)',
    usage: '[step] [--full] [--all]',
    semantics: '§12.6 (`--full` idle only)',
    category: 'files',
  },
  {
    name: 'plan',
    aliases: ['pl'],
    args: [],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'append the plan ledger block',
    usage: '—',
    semantics: 'append the plan ledger block',
    category: 'inspect',
  },
  {
    name: 'decisions',
    aliases: ['dc'],
    args: [
      { name: 'n', kind: 'int', optional: true, hint: '[n]' },
      {
        name: 'stage',
        kind: 'enum',
        values: ['replan', 'intent', 'context', 'propose', 'risk', 'execute', 'judge', 'complete'],
        optional: true,
        hint: '[stage]',
        valueHints: {
          replan: { title: 'replan rows: the plan rewritten' },
          intent: { title: 'intent rows: what the step means to do' },
          context: { title: 'context rows: files and facts gathered' },
          propose: { title: 'propose rows: the candidate action' },
          risk: { title: 'risk rows: the five dimensions and the verdict' },
          execute: { title: 'execute rows: the action as run' },
          judge: { title: 'judge rows: did the step help' },
          complete: { title: 'complete rows: is the task done' },
        },
      },
    ],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'append the last n decision rows (default 12)',
    usage: '[n] [stage]',
    semantics: 'append the last n `DecisionRow`s (default 12)',
    category: 'inspect',
  },
  {
    name: 'why',
    aliases: ['w'],
    args: [{ name: 'ref', kind: 'rest', hint: '<ref|digit>' }],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'why Jev decided as it did (s7.risk.plan_mismatch, risk.plan_mismatch, or a pane digit)',
    usage: '<ref|digit>',
    semantics: 'append the `/why` block (§7.6) for `s7.risk.plan_mismatch`, `risk.plan_mismatch` (current step) or a visible pane digit',
    category: 'inspect',
  },
  {
    name: 'calibration',
    aliases: [],
    args: [],
    availableDuringTask: 'idle',
    plain: 'yes',
    title: 'reliability bins, ECE and near-threshold counts',
    usage: '—',
    semantics: 'append the reliability block from `decisions.jsonl` + `steps.jsonl` of this workspace\'s runs (the 50 most recent runs or 32 MB of records, streamed)',
    category: 'inspect',
  },
  {
    name: 'jev',
    aliases: ['j'],
    args: [],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'decider model, drift, questions, latency p50/p95, Jev cost',
    usage: '—',
    semantics: 'decider model, resolved/drift@step, questions, latency p50/p95, Jev cost',
    category: 'inspect',
  },
  {
    name: 'cost',
    aliases: ['c'],
    args: [],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'run and session spend, per-step cost, pending caps',
    usage: '—',
    semantics: '12-row block (§9.6)',
    category: 'money',
  },
  {
    name: 'budget',
    aliases: ['b'],
    args: [
      {
        name: 'setting',
        kind: 'setting',
        values: BUDGET_SETTINGS,
        optional: true,
        hint: '[setting <v>]',
        valueHints: {
          'spend-cap': { args: '<usd>', title: 'run cap for the next /resume or run' },
          'session-spend-cap': { args: '<usd>', title: 'session cap, applies now' },
          'max-steps': { args: '<n>', title: 'step limit for the next /resume or run' },
          'max-wall': { args: '<dur>', title: 'wall limit for the next /resume or run' },
          'max-replans': { args: '<n>', title: 'replan limit for the next /resume or run' },
          'max-generator-tokens': { args: '<n>', title: 'token cap under --allow-unpriced for the next /resume or run' },
        },
      },
      { name: 'value', kind: 'text', optional: true, hint: '<v>' },
    ],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'show or set caps (spend-cap, session-spend-cap, max-steps, max-wall, max-replans)',
    usage: '[spend-cap|session-spend-cap|max-steps|max-wall|max-replans <v>]',
    semantics: 'show or set (§9.4); `session-spend-cap none` lifts the session cap; `max-generator-tokens <n>` is the --allow-unpriced token cap (§9.5)',
    category: 'money',
    suggestWhen: 'budget-stop',
  },
  {
    name: 'model',
    aliases: ['ml'],
    args: [{ name: 'id', kind: 'text', optional: true, hint: '[id]' }],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'generator model for the next run only',
    usage: '[id]',
    semantics: 'no argument shows `model <current> (next run: <pending>)`; with one: pending for the **next** run only (memory); a differing `--model` on `/resume` stays `ConfigError`',
    category: 'config',
  },
  {
    name: 'provider',
    aliases: [],
    args: [{ name: 'p', kind: 'enum', values: ['anthropic', 'openrouter'], optional: true, hint: '[anthropic|openrouter]' }],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'generator provider for the next run only',
    usage: '[anthropic|openrouter]',
    semantics: 'no argument shows `provider <current> (next run: <pending>)`; with one: pending for the **next** run only (memory)',
    category: 'config',
  },
  // TUI-DESIGN-2 §1.3: `/mode` shows or pends; `/llm on|off` is its alias pair; TUI-DESIGN-3 §4.1 rule 8: the value hints read the badge table
  {
    name: 'mode',
    aliases: ['m'],
    args: [{ name: 'm', kind: 'enum', values: ENGINE_MODES, optional: true, hint: '[jev-only|jev-on|jev-off|llm-jev]', valueHints: MODE_VALUE_HINTS, defaultValue: DEFAULT_MODE }],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'engine mode: show, or set for the next run',
    usage: '[jev-only|jev-on|jev-off|llm-jev]',
    semantics: 'no argument: current and next mode; with one: pending for the **next** run (memory); `jev-on` with no generator key opens the wizard\'s generator step in place; persist with `jevcode config set mode <m>`',
    category: 'config',
  },
  {
    name: 'llm',
    aliases: [],
    args: [{ name: 'state', kind: 'enum', values: LLM_STATES, hint: '<on|off>' }],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'Jev + LLM on (= /mode jev-on) or off (= /mode jev-only)',
    usage: '<on|off>',
    semantics: '`/llm on` = `/mode jev-on`, `/llm off` = `/mode jev-only`',
    category: 'config',
  },
  {
    name: 'config',
    aliases: ['cf'],
    args: [],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'masked settings table with sources and the effective session cap',
    usage: '—',
    semantics: 'masked table with `source` column, effective session cap, sandbox footer',
    category: 'config',
  },
  {
    name: 'login',
    aliases: ['l'],
    args: [],
    availableDuringTask: 'any',
    plain: '`/login` raw-mode prompt',
    title: 're-enter a missing or rejected API key (applies to the next run)',
    usage: '—',
    semantics: 'wizard field re-entry (§11.2); `saved — applies to the next run`',
    category: 'config',
    suggestWhen: 'unauthorized',
  },
  {
    name: 'logout',
    aliases: [],
    args: [{ name: 'which', kind: 'enum', values: ['generator', 'jev'], optional: true, hint: '[generator|jev]', valueHints: { generator: { title: 'remove the saved generator (code model) key' }, jev: { title: 'remove the saved Jev key' } } }],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'remove a saved key from the config file',
    usage: '[generator|jev]',
    semantics: 'rewrites the credentials file atomically and reports env-sourced keys without touching them (§11.2)',
    category: 'config',
  },
  {
    name: 'trust',
    aliases: [],
    args: [],
    availableDuringTask: 'idle',
    plain: 'yes',
    title: 'reopen the workspace trust gate',
    usage: '—',
    semantics: 'reopen the trust gate',
    category: 'config',
  },
  {
    name: 'theme',
    aliases: ['t'],
    args: [{ name: 'theme', kind: 'enum', values: THEMES, hint: '<dark|light|daltonized|ansi>', valueHints: { dark: { title: 'TypeSafe pink' }, light: { title: 'the same roles on a light terminal' }, daltonized: { title: 'colour-blind safe: blue/orange for red/green' }, ansi: { title: 'the 16 ANSI colours only' } } }],
    availableDuringTask: 'any',
    plain: 'n/a',
    title: 'colour theme for new items and the dynamic region',
    usage: '<dark|light|daltonized|ansi>',
    semantics: 'new items and the dynamic region only',
    category: 'ui',
  },
  // TUI-DESIGN-2 §4.6: the Jev panel and the transcript view (S4's rows, landed with the table)
  {
    name: 'panel',
    aliases: ['p'],
    args: [{ name: 'what', kind: 'enum', values: PANEL_ARGS, optional: true, hint: '[d|p|t|s|off|full]', valueHints: { d: { title: 'decisions tab' }, p: { title: 'plan tab' }, t: { title: 'timeline tab' }, s: { title: 'synth tab' }, off: { title: 'collapse to the one-row strip' }, full: { title: 'expand to the 12-row pane' } } }],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'Jev panel: toggle, open a tab (d|p|t|s), collapse (off) or expand (full)',
    usage: '[d|p|t|s|off|full]',
    semantics: 'no argument toggles collapsed ↔ open (≤ 6 rows); `d|p|t|s` opens that tab (the same tab again collapses); `off` collapses to the one-row strip; `full` expands to the 12-row pane (§4.6); `--plain` prints the rows',
    category: 'ui',
  },
  {
    name: 'transcript',
    aliases: ['tr'],
    args: [{ name: 'view', kind: 'enum', values: TRANSCRIPT_VIEWS, optional: true, hint: '[compact|full]', valueHints: { compact: { title: 'one line per step' }, full: { title: 'every stage line' } } }],
    availableDuringTask: 'any',
    plain: 'always full',
    title: 'transcript view: compact (one line per step) or full (every stage line)',
    usage: '[compact|full]',
    semantics: 'no argument shows the current view; `compact` (default) hides the stage kinds and shows one `[step N]` line per step; `full` shows every item (new items only, §4.5); `--plain` is always `full`',
    category: 'ui',
  },
  {
    name: 'copy',
    aliases: ['cp'],
    args: [{ name: 'what', kind: 'enum', values: ['last', 'proposal', 'diff', 'draft'], optional: true, hint: '[last|proposal|diff|draft]', valueHints: { last: { title: 'the last transcript item' }, proposal: { title: 'the last proposal' }, diff: { title: 'the run\'s diff, as /diff prints it' }, draft: { title: 'the composer draft' } } }],
    availableDuringTask: 'any',
    plain: 'n/a',
    title: 'copy the last item, proposal, diff or draft (redacted)',
    usage: '[last|proposal|diff|draft]',
    semantics: '§10.5',
    category: 'ui',
  },
  {
    name: 'export',
    aliases: [],
    args: [{ name: 'file', kind: 'path', optional: true, hint: '[file]' }],
    availableDuringTask: 'idle',
    plain: 'yes',
    title: 'write the session transcripts to a file',
    usage: '[file]',
    semantics: '§8.7',
    category: 'session',
  },
  {
    name: 'status',
    aliases: ['s'],
    args: [],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'run id, session id, step/max, stage, sandbox, workspace, git, stop reason, lock',
    usage: '—',
    semantics: 'run id, session id, step/max, stage, sandbox, workspace, git, stop reason, lock',
    category: 'inspect',
  },
  {
    name: 'errors',
    aliases: [],
    args: [],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'append recent warnings and errors; acknowledges !n',
    usage: '—',
    semantics: 'append recent warnings/errors as items; acknowledges `!n`',
    category: 'inspect',
  },
  {
    name: 'report',
    aliases: [],
    args: [],
    availableDuringTask: 'idle',
    plain: 'yes',
    title: 'write a redacted support bundle under ~/.jevcode/reports/',
    usage: '—',
    semantics: '`~/.jevcode/reports/<run-id>/` (§13.6)',
    category: 'inspect',
  },
  {
    name: 'history',
    aliases: [],
    args: [{ name: 'op', kind: 'enum', values: ['clear'], hint: 'clear' }],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'clear the prompt history (after y/N)',
    usage: 'clear',
    semantics: 'truncate `history.jsonl` after `y/N`',
    category: 'ui',
  },
  {
    name: 'editor',
    aliases: [],
    args: [],
    availableDuringTask: 'any',
    plain: 'n/a',
    title: 'edit the draft in $VISUAL / $EDITOR (= Ctrl+G)',
    usage: '—',
    semantics: '= Ctrl+G',
    category: 'ui',
  },
  {
    name: 'exit',
    aliases: ['q', 'quit'],
    args: [],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'leave (exit 0; confirms first while a run is live)',
    usage: '—',
    semantics: 'exit 0 (`exitConfirm` first while live; `--exit-code=last-run` opt-in)',
    category: 'session',
  },
];

const BY_NAME: ReadonlyMap<string, CommandSpec> = (() => {
  const m = new Map<string, CommandSpec>();
  for (const c of COMMANDS) {
    m.set(c.name, c);
    for (const a of c.aliases) m.set(a, c);
  }
  return m;
})();

/**
 * TUI-DESIGN §5.1 `rest`: true when the command's only argument is the raw remainder of the line (`/rename`,
 * `/steer`, `/why`) — such a line skips the quote/escape tokeniser after the name, so an apostrophe or a
 * stray quote in natural-language text is text, never `unterminated quote`.
 */
export function takesRest(spec: CommandSpec): boolean {
  return spec.args.length === 1 && spec.args[0]?.kind === 'rest' && (spec.flags?.length ?? 0) === 0;
}

/** TUI-DESIGN §5.1: the command for a name or alias (case-insensitive, with or without the leading `/`); null when unknown. */
export function findCommand(nameOrAlias: string): CommandSpec | null {
  const key = nameOrAlias.trim().replace(/^\//, '').toLowerCase();
  return BY_NAME.get(key) ?? null;
}

/** TUI-DESIGN-3 §4.1 rule 4: the alias the palette column shows — the shortest; ties keep table order; null when the command has none. */
export function shortestAlias(spec: CommandSpec): string | null {
  let best: string | null = null;
  for (const a of spec.aliases) if (best === null || a.length < best.length) best = a;
  return best;
}

/** TUI-DESIGN §5.3: every `/name` (aliases excluded) in table order — the palette's candidate list. */
export function commandNames(): readonly string[] {
  return COMMANDS.map((c) => `/${c.name}`);
}

/** TUI-DESIGN §5.1: true when the token (with or without `/`) is exactly a name or alias — the only case Enter runs a command from the palette. */
export function isExactCommand(token: string): boolean {
  return findCommand(token) !== null && /^\/?[a-z][a-z0-9-]*$/i.test(token.trim());
}

/** TUI-DESIGN §5.2: the `[ui] error:` text (without the label) for a command that is not available now. */
export function availabilityError(spec: CommandSpec, live: boolean): string | null {
  if (spec.availableDuringTask === 'idle' && live) return `error: /${spec.name} runs when the run is idle; Esc pauses first`;
  if (spec.availableDuringTask === 'live' && !live) return `error: /${spec.name} needs a live run`;
  return null;
}
