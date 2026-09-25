/**
 * The command table (TUI-DESIGN §5.2; TUI-DESIGN-2 §1.3 `/mode` `/llm`, §4.6 `/panel` `/transcript`; TUI-DESIGN-3 §4.1 the shortcut
 * aliases and `POPULAR`, D-K): one typed array feeds the dispatcher, the palette, help, `docs/COMMANDS.md` (scripts/gen-docs.mjs) and
 * the `--plain` readline composer. Pure data plus lookups. `availableDuringTask`: idle | live | any. `plain`: whether the readline
 * composer supports the command. Aliases (§4.1): every alias is a `NAME_RE` token, unique across names + aliases, never another
 * command's name; no one-letter alias for a command whose Enter destroys state without a confirm (`/new`, `/exit`, `/abort`).
 */
import { ADVERTISED_MODES, DEFAULT_MODE, LEGACY_MODES, MODE_BADGE_WORD, MODE_SETTING_VALUES } from '../../config/defaults.js';
// TUI-DESIGN-5 §6.1 (D-AP) / §6.3: the seven provider ids, from the ZERO-IMPORT module (`src/provider/ids.ts`'s
// own docblock) — never `models/providers.ts`, whose `providerSpec(id)` puts `provider/openrouter.js` on this path.
import { PROVIDER_IDS } from '../../provider/ids.js';
import type { EngineMode } from '../../core/types.js';

/** TUI-DESIGN §5.1: the argument kinds `ArgSpec` validates. */
export type ArgKind = 'enum' | 'int' | 'usd' | 'duration' | 'run' | 'step' | 'path' | 'setting' | 'text' | 'rest';

/** TUI-DESIGN §5.1: one positional argument of a command. */
export interface ArgSpec {
  readonly name: string;
  readonly kind: ArgKind;
  /** `enum` / `setting` values, in palette order */
  readonly values?: readonly string[];
  /** `enum` values the dispatcher also accepts but the palette, completion and usage do not list (`/mode llm-jev` once only the advertised modes are listed) */
  readonly accepts?: readonly string[];
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
  /**
   * TUI-DESIGN-4 §4.5 (D-X): reached **through a selection surface** (the palette's accept/cycle, the `--plain`
   * numbered pick) this command gets a one-row confirm whose Enter is inert. A hand-typed `/exit` is unaffected —
   * the gate is `DispatchContext.fromPalette`, a provenance ref, never `overlay === 'palette'`.
   */
  readonly destructive?: true;
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
  'agent': { title: `${MODE_BADGE_WORD['agent']}: the code model works through tools and checks its own work` },
};
/**
 * AGENT-LOOP-DESIGN §14.1 / §14.3: the advertised mode surface — `/mode` lists agent · jev-only · legacy (`/mode legacy` names the rest),
 * `/llm on` is agent, and `/jev` / `/panel` leave the Popular group — goes live with the default flip (slice S6 sets DEFAULT_MODE to
 * agent). Until then a legacy-default session's palette, `/llm` and Popular stay byte-identical (this wave's binding legacy rule); the
 * pure `(defaultMode)` forms below state the post-flip surface for the tests.
 */
export function advertisedSurface(defaultMode: EngineMode = DEFAULT_MODE): boolean {
  return defaultMode === 'agent';
}
/** the `/mode legacy` argument: lists the modes kept for saved configs, resume and the bench */
export const MODE_LEGACY_ARG = 'legacy';
/** `/mode legacy`'s answer */
export const MODE_LEGACY_TEXT = `legacy modes, accepted for saved configs, resume and the bench: ${LEGACY_MODES.join(' · ')} — /mode <name> switches to one`;
/** `/mode`'s listed values: the advertised modes and `legacy` after the flip; every mode, in the round-2 table order, before it */
export function modeArgValues(defaultMode: EngineMode = DEFAULT_MODE): readonly string[] {
  return advertisedSurface(defaultMode) ? [...ADVERTISED_MODES, MODE_LEGACY_ARG] : ENGINE_MODES;
}
/** what `/mode` accepts without listing: every other engine mode (a persisted `mode llm-jev` keeps working) and `legacy` */
export function modeArgAccepts(defaultMode: EngineMode = DEFAULT_MODE): readonly string[] {
  const listed = modeArgValues(defaultMode);
  return [...ENGINE_MODES, MODE_LEGACY_ARG].filter((v) => !listed.includes(v));
}
/** TUI-DESIGN-3 §4.1 rule 6: the Popular group of an empty palette query, in this fixed order (16 commands; 14 after the flip, §14.3 item 8). */
export function popularFor(defaultMode: EngineMode = DEFAULT_MODE): readonly string[] {
  const all = ['help', 'mode', 'model', 'cost', 'status', 'resume', 'new', 'panel', 'plan', 'diff', 'undo', 'theme', 'login', 'budget', 'jev', 'exit'];
  return advertisedSurface(defaultMode) ? all.filter((n) => n !== 'jev' && n !== 'panel') : all;
}
export const POPULAR: readonly string[] = popularFor();
/**
 * TUI-DESIGN-3 §4.1 (D-K): commands whose Enter destroys state without a confirm — never a one-letter alias (`a` for /abort and
 * `n` for /new are dropped; /new gets `nw`). `/exit` keeps `q` alone (the letter every pager teaches; `x` is dropped): `EXIT_ONE_LETTER`.
 */
export const NO_ONE_LETTER_ALIAS: readonly string[] = ['new', 'abort'];
export const EXIT_ONE_LETTER = 'q';
/** TUI-DESIGN-2 §1.3: `/llm on|off` → `/mode jev-on` | `/mode jev-only`; AGENT-LOOP-DESIGN §14.5: `/llm on` → `/mode agent` after the flip. */
export const LLM_STATES = ['on', 'off'] as const;
export function llmStateMode(defaultMode: EngineMode = DEFAULT_MODE): Readonly<Record<(typeof LLM_STATES)[number], EngineMode>> {
  return { on: advertisedSurface(defaultMode) ? 'agent' : 'jev-on', off: 'jev-only' };
}
export const LLM_STATE_MODE: Readonly<Record<(typeof LLM_STATES)[number], EngineMode>> = llmStateMode();
/** TUI-DESIGN-2 §4.6 / TUI-DESIGN-5 §4.3: `/panel [d|p|t|s|a|off|full]` — `'a'` is R5-4's §9.2 request, landed in this file's one PR. */
export const PANEL_ARGS = ['d', 'p', 't', 's', 'a', 'off', 'full'] as const;
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
    destructive: true,
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
    // TUI-DESIGN-5 §2.6: `/pause [now] [<target>]`. `now` is the soft interrupt (`PauseOptions.at`); a target is a
    // peer, resolved by `resolveTarget` (§2.5) and reached as a mailbox message, never a local engine call.
    args: [
      { name: 'now', kind: 'enum', values: ['now'], optional: true, hint: '[now]', valueHints: { now: { title: 'soft interrupt: the stage in flight is discarded, the proposal is kept' } } },
      { name: 'target', kind: 'text', optional: true, hint: '[<target>]' },
    ],
    // TUI-DESIGN-5 §2.6 (§14.2 #16, #39): `'any'`, because `/pause mbp` touches no local engine. The generated
    // `availabilityError` cannot express a per-FORM rule, so the dispatcher hand-writes §12 S45a for the local form.
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'stop after the step in flight commits (= Esc); `now` interrupts, a target asks a peer',
    usage: '[now] [<target>]',
    semantics: '`engine.pause({ at, by: \'self\' })` (= Esc); `now` discards the stage in flight and keeps the proposal; `<target>` sends a `pause` message to a peer\'s inbox, `all` pauses this run and every live peer on this repo (§2.6)',
    category: 'run',
  },
  {
    name: 'abort',
    aliases: [],
    args: [],
    destructive: true,
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
    // TUI-DESIGN-5 §6.1 (D-AP) / §9.2's registry row (R5-6): the two-name wall is gone — the palette offers the
    // seven ids from `src/provider/ids.ts`, the ONE zero-import table the argv path may read (§6.3, §14.2 #5).
    args: [{ name: 'p', kind: 'enum', values: [...PROVIDER_IDS], optional: true, hint: `[${PROVIDER_IDS.join('|')}]` }],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'generator provider for the next run only',
    usage: `[${PROVIDER_IDS.join('|')}]`,
    semantics: 'no argument shows `provider <current> (next run: <pending>)`; with one: pending for the **next** run only (memory)',
    category: 'config',
  },
  // TUI-DESIGN-2 §1.3: `/mode` shows or pends; `/llm on|off` is its alias pair; TUI-DESIGN-3 §4.1 rule 8: the value hints read the badge table
  {
    name: 'mode',
    aliases: ['m'],
    args: [
      {
        name: 'm',
        kind: 'enum',
        values: modeArgValues(),
        accepts: modeArgAccepts(),
        optional: true,
        hint: advertisedSurface() ? `[${modeArgValues().join('|')}]` : '[jev-only|jev-on|jev-off|llm-jev]',
        valueHints: { ...MODE_VALUE_HINTS, [MODE_LEGACY_ARG]: { title: 'list the older modes (saved configs, resume, the bench)' } },
        defaultValue: DEFAULT_MODE,
      },
    ],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'engine mode: show, or set for the next run',
    usage: advertisedSurface() ? `[${modeArgValues().join('|')}]` : '[jev-only|jev-on|jev-off|llm-jev]',
    semantics: advertisedSurface()
      ? 'no argument: current and next mode; with one: pending for the **next** run (memory); `legacy` lists the older modes (still accepted: saved configs, resume, the bench); a mode that needs a generator key opens the wizard\'s generator step in place; persist with `jevcode config set mode <m>`'
      : 'no argument: current and next mode; with one: pending for the **next** run (memory); `jev-on` with no generator key opens the wizard\'s generator step in place; persist with `jevcode config set mode <m>`',
    category: 'config',
  },
  {
    name: 'llm',
    aliases: [],
    args: [{ name: 'state', kind: 'enum', values: LLM_STATES, hint: '<on|off>' }],
    availableDuringTask: 'any',
    plain: 'yes',
    title: advertisedSurface() ? 'the code model on (= /mode agent) or off (= /mode jev-only)' : 'Jev + LLM on (= /mode jev-on) or off (= /mode jev-only)',
    usage: '<on|off>',
    semantics: `\`/llm on\` = \`/mode ${LLM_STATE_MODE.on}\`, \`/llm off\` = \`/mode jev-only\``,
    category: 'config',
  },
  {
    name: 'config',
    aliases: ['cf'],
    args: [],
    // TUI-DESIGN-4 §3.3 (S3's §9.2 request): `configTableLines` already takes `{ all }`; this is the missing flag spec
    flags: [{ name: 'all', title: 'show every setting, including the rows folded at their defaults' }],
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
    // TUI-DESIGN-5 §4.3 / §9.2: R5-4's request, landed here because `registry.ts` is one file with one PR.
    // `PaneTab` already carries `'a'` and `nextPanel`'s parameter is already `PaneTab | 'off' | 'full' | null`
    // (`src/tui/pane/commands.ts`), so the enum is the only widening `/panel a` needs. The TAB itself is still
    // gated on `paneTabsFor(agents.length > 0)`, which is R5-4's — the argument existing is not the tab existing.
    args: [{ name: 'what', kind: 'enum', values: PANEL_ARGS, optional: true, hint: '[d|p|t|s|a|off|full]', valueHints: { d: { title: 'decisions tab' }, p: { title: 'plan tab' }, t: { title: 'timeline tab' }, s: { title: 'synth tab' }, a: { title: 'agents tab (while something delegates)' }, off: { title: 'collapse to the one-row strip' }, full: { title: 'expand to the 12-row pane' } } }],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'Jev panel: toggle, open a tab (d|p|t|s|a), collapse (off) or expand (full)',
    usage: '[d|p|t|s|a|off|full]',
    semantics: 'no argument toggles collapsed ↔ open (≤ 6 rows); `d|p|t|s` opens that tab (the same tab again collapses) and `a` the agents tab while something delegates (§4.3); `off` collapses to the one-row strip; `full` expands to the 12-row pane (§4.6); `--plain` prints the rows',
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
    // TUI-DESIGN-4 §5.5 P-C13 (S5's §9.2 request): `last` copies the whole turn, `conversation` the whole ledger
    args: [{ name: 'what', kind: 'enum', values: ['last', 'proposal', 'diff', 'draft', 'conversation'], optional: true, hint: '[last|proposal|diff|draft|conversation]', valueHints: { last: { title: 'the last chat turn, unclipped' }, proposal: { title: 'the last proposal' }, diff: { title: 'the run\'s diff, as /diff prints it' }, draft: { title: 'the composer draft' }, conversation: { title: 'the whole conversation as you:/jevcode: blocks' } } }],
    availableDuringTask: 'any',
    plain: 'n/a',
    title: 'copy the last turn, proposal, diff, draft or conversation (redacted)',
    usage: '[last|proposal|diff|draft|conversation]',
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
    // TUI-DESIGN-4 §4.5: `/history`'s only argument is `clear`, so every resolution of it is the destructive one
    destructive: true,
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
    destructive: true,
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'leave (exit 0; confirms first while a run is live)',
    usage: '—',
    semantics: 'exit 0 (`exitConfirm` first while live; `--exit-code=last-run` opt-in)',
    category: 'session',
  },
  // TUI-DESIGN-4: the four commands round 4 adds (37 → 41). §9.2 routes every one of them to S4's registry; the
  // handlers are S1's (`/fullscreen`, `/scrollback`, §1.3.1/§1.3.4) and S6's (`/peers`, `/ui reset`, §7.10/§7.1).
  {
    name: 'fullscreen',
    aliases: [],
    args: [],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'pin the header at the top of the screen (persists ui.renderer; needs a relaunch)',
    usage: '—',
    semantics: 'persist `ui.renderer: fullscreen` and offer a relaunch — the renderer is fixed at `render()` (§1.3.1), so it never switches in place; under `fullscreen` already, it persists `classic` back',
    category: 'ui',
  },
  {
    name: 'scrollback',
    aliases: [],
    args: [],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'print the transcript to the primary screen for copy and find',
    usage: '—',
    semantics: 'fullscreen only: suspend, print the whole transcript through `createPlainRenderer`, wait for a key, resume (§1.3.4); under `classic` it answers that the terminal\'s own scrollback already has it',
    category: 'ui',
  },
  {
    name: 'peers',
    aliases: [],
    args: [],
    availableDuringTask: 'any',
    plain: 'yes',
    // TUI-DESIGN-5 §2.4: the counts view keeps TD4's privacy contract (a count, a count, an age and a boolean —
    // no pid, no path, no label), so the title points at `/who` and the narrow view is never a dead end.
    title: 'other jevcode instances working in this workspace · /who shows what each is doing',
    usage: '—',
    // §2.4 / §12 "Superseded, not kept": TD4's per-peer kv rows (`workspace`, `started <t> ago`, `<state>`) are
    // `/who`'s job now — `PeerView`'s four scalars cannot produce them. Only the four TD4 strings that survive
    // are described here, because this text is published to users in `docs/COMMANDS.md`.
    semantics:
      'counts only, from `SessionHost.peers()`: `peers · <n> here, <m> stale`, else `no other jevcode is working in this workspace`, else `the peer registry is not available in this build`; a peer holding the exclusive lease raises the blocking row `[w] wait for it   [r] read-only session   [q] quit`. Never a pid, never a path, never a label — `/who` is the detailed view (§2.4)',
    category: 'session',
  },
  {
    name: 'ui',
    aliases: [],
    args: [{ name: 'action', kind: 'setting', values: ['reset'], hint: 'reset', valueHints: { reset: { title: 'unlatch every pane that failed to render' } } }],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'ui maintenance: reset re-enables panes that failed to render',
    usage: 'reset',
    semantics: 'clears every `guard()` pane latch (§7.1) and answers `ui reset — <n> panes unlatched` or `nothing was latched`',
    category: 'ui',
  },
  // ----- TUI-DESIGN-5 §2.3, §2.7, §2.9 (R5-2's six rows of the one §9.2 registry PR). D-AN: every row is
  // registered with its honest answer from day one — no dead pointers, no hidden rows.
  {
    name: 'who',
    aliases: [],
    args: [],
    flags: [{ name: 'all', title: 'include sessions gone more than 10 minutes' }],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'every jevcode session on this repo, with what each is doing',
    usage: '[--all]',
    semantics: 'a block of one row per session — liveness, branch@head, step/stage, mode, context, spend, files being edited, sub-work and beat age (§2.3, §12 S1–S5); `jevcode sessions who [--all] --json` is the machine twin',
    category: 'session',
  },
  {
    name: 'inbox',
    aliases: [],
    args: [],
    flags: [{ name: 'all', title: 'include messages already acked' }],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'unread messages from other sessions, newest first',
    usage: '[--all]',
    semantics: 'reads `fold.inbox` / `fold.acks` and writes nothing; a block of unread rows, newest first (§2.9)',
    category: 'session',
  },
  {
    name: 'tell',
    aliases: [],
    args: [
      { name: 'target', kind: 'text', hint: '<target>' },
      { name: 'text', kind: 'rest', hint: '<text>' },
    ],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'send one session a message',
    usage: '<target> <text>',
    semantics: 'a directed message; the far end shows `[session] <label>: <text>` and `transcript.log` records it (§2.9). A body that looks like a key is gated first and is redacted either way (§12 S34a)',
    category: 'session',
  },
  {
    name: 'headsup',
    aliases: [],
    args: [{ name: 'text', kind: 'rest', hint: '<text>' }],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'broadcast what you are about to touch to every live session here',
    usage: '<text>',
    semantics: 'a broadcast to every live row on this repo; a toast at the far end, never a persistent row (§2.9)',
    category: 'session',
  },
  {
    name: 'request',
    aliases: [],
    args: [
      { name: 'target', kind: 'text', hint: '<target>' },
      { name: 'verb', kind: 'enum', values: ['pause', 'end', 'steer'], hint: 'pause|end|steer', valueHints: { pause: { title: 'ask the far end to pause' }, end: { title: 'ask the far end to end its run' }, steer: { title: 'ask the far end to take a steer' } } },
      { name: 'text', kind: 'rest', hint: '<text>', optional: true },
    ],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'ask a session to pause, end or take a steer — it answers y/n',
    usage: '<target> pause|end|steer [<text>]',
    semantics: 'a gated verb request; the far end shows a **persistent** row (never a toast, because it needs an answer) with `[y]`/`[Y]`/`[n]` (§2.9, §12 S32)',
    category: 'session',
  },
  {
    name: 'end',
    aliases: [],
    destructive: true,
    args: [
      { name: 'now', kind: 'enum', values: ['now'], optional: true, hint: '[now]', valueHints: { now: { title: 'end without waiting for the step in flight to commit' } } },
      { name: 'target', kind: 'text', optional: true, hint: '[<target>]' },
    ],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'end this session — /resume afterwards needs --force',
    usage: '[now] [<target>]',
    semantics: '`engine.end({ at, by: \'human\' })`; writes `RunMeta.ended` and one `session:end` index line, so a later `/resume <id>` needs `--force`. Takes the confirm ladder and its Enter is inert (§2.7, §12 S27–S29)',
    category: 'run',
  },

// ----- TUI-DESIGN-5 §3.2 / §3.3 (R5-3's two rows of the one §9.2 registry PR) -------------------------------
  {
    name: 'context',
    aliases: [],
    args: [],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'what the generator sees this step, and what it costs',
    usage: '—',
    // §3.2 (D-AH): three reads that are already public — `status().context`, `snapshotState()` and the checkpoint
    // store's `readContextSummary()`. §13.3 records the deliberate absence of a `--json` twin: there is no
    // `jevcode context` verb, so the machine-readable form is `--json=verbose`'s `status` event.
    semantics:
      'one block: the budget and window, the recent-step split, prompt-build and file-refresh milliseconds, the rolling summary and its age, and the files in view with why each is there (§3.2, §12 S48–S53). Three distinct empty states — no live run, a mode that builds no relaxed context, and no prompt built yet. No `--json` of its own (§13.3)',
    category: 'inspect',
  },
  {
    name: 'compact',
    aliases: [],
    args: [],
    // §3.3: the OPPOSITE of Codex CLI's idle-only gate — `Engine.compact()` folds history so the NEXT step's
    // prompt fits, which is meaningless with no next prompt. The refusal is `availabilityError`'s own `'live'`
    // sentence, nothing hand-written.
    availableDuringTask: 'live',
    plain: 'yes',
    title: 'fold the history now instead of waiting for the next trigger',
    usage: '—',
    semantics:
      '`engine.compact()`; the engine\'s own compaction notice reports what happened in all three sinks (§3.4), so the command says nothing when the count rose and otherwise answers one of three sentences — compaction is off for this run, only the newest step is in history, or the run is no longer live (§3.3, §12 S57–S58a)',
    category: 'run',
  },
  // ----- TUI-DESIGN-5 §4.9 (D-AN: R5-4's five rows, registered honestly from day one — each answers
  // `<verb> is not available in this build — no agent is running` until the supervisor's store exists) ---------
  {
    name: 'split',
    aliases: [],
    args: [{ name: 'policy', kind: 'enum', values: ['auto', 'ask', 'off'], optional: true, hint: '[auto|ask|off]', valueHints: { auto: { title: 'split when the ranker says it pays' }, ask: { title: 'ask before every split' }, off: { title: 'never split' } } }],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'the split policy for the next step',
    usage: '[auto|ask|off]',
    semantics: 'pends `orchestrate.split` for the next step; no argument shows the current policy (§4.9)',
    category: 'run',
  },
  {
    name: 'agents',
    aliases: [],
    args: [],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'the agent tree — opens and focuses the `a` pane tab (Alt+A)',
    usage: '—',
    // §4.3: the App's own pre-router (`src/tui/pane/commands.ts`) handles this line, because it opens AND focuses
    // the tab and focus is `UiState.paneFocus`, which no host command can reproduce. In `--plain` the host prints
    // the block. With nothing delegating the answer is D-AN's honest one, never a blank tab.
    semantics: 'opens the `a` pane tab and focuses it so its eight letters resolve (`Alt+A` is the key twin); in `--plain` it prints the tree as a block. With nothing delegating it answers `/agents is not available in this build — no agent is running` (§4.3, §4.9, §12 S85)',
    category: 'inspect',
  },
  {
    name: 'agent',
    aliases: [],
    args: [
      { name: 'slug', kind: 'text', hint: '<slug>' },
      { name: 'verb', kind: 'enum', values: ['pause', 'resume', 'steer', 'budget', 'land', 'kick', 'drop', 'diff'], hint: 'pause|resume|steer|budget|land|kick|drop|diff', valueHints: { pause: { title: 'pause the agent at its next step' }, resume: { title: 'resume a paused agent' }, steer: { title: 'send the agent a steer' }, budget: { title: 'raise the agent\'s cap' }, land: { title: 'land the agent into the dock' }, kick: { title: 'kick a stalled agent once' }, drop: { title: 'drop the agent — its uncommitted diff is lost' }, diff: { title: 'the agent\'s diff against the base' } } },
      { name: 'args', kind: 'rest', hint: '[args]', optional: true },
    ],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'one verb against one agent, by slug',
    usage: '<slug> pause|resume|steer|budget|land|kick|drop|diff [args]',
    semantics: 'the typed twin of the `a` tab\'s eight letters (§4.3); until the supervisor\'s store exists it answers `/agent is not available in this build — no agent is running` (§4.9, §12 S85)',
    category: 'run',
  },
  {
    name: 'land',
    aliases: [],
    // §4.9: the only one of the seven that mutates files, so the only one that joins `EXCLUSIVE_COMMANDS`
    // (`src/cli/session.ts`) and the only one with `destructive: true` (a confirm row whose Enter is inert).
    destructive: true,
    args: [{ name: 'slug', kind: 'text', optional: true, hint: '[<slug>]' }],
    availableDuringTask: 'idle',
    plain: 'yes',
    title: 'land a finished agent\'s work into the dock',
    usage: '[<slug>]',
    semantics: 'merges the agent\'s branch into the dock behind the land preflight (§4.6); runs one at a time (`EXCLUSIVE_COMMANDS`) and takes the confirm ladder, whose Enter is inert. With nothing delegating it answers `/land is not available in this build — no agent is running` (§4.9, §12 S85)',
    category: 'files',
  },
  {
    name: 'spawn',
    aliases: [],
    args: [
      { name: 'role', kind: 'text', hint: '<role>' },
      { name: 'glob', kind: 'text', hint: '<glob>' },
      { name: 'task', kind: 'rest', hint: '[task]', optional: true },
    ],
    availableDuringTask: 'live',
    plain: 'yes',
    title: 'one extra agent against the live manifest',
    usage: '<role> <glob> [task]',
    semantics: 'adds one agent to the manifest of the live run; until the supervisor\'s store exists it answers `/spawn is not available in this build — no agent is running` (§4.9, §12 S85)',
    category: 'run',
  },
  // ----- TUI-DESIGN-5 §5.5 (R5-5's two rows, both `category: 'config'`) ---------------------------------------
  {
    name: 'import',
    aliases: ['imp'],
    args: [{ name: 'source', kind: 'text', optional: true, hint: '[<source>]' }],
    flags: [{ name: 'dry-run', title: 'plan only — nothing is written' }],
    availableDuringTask: 'idle',
    plain: 'yes',
    title: 'import memory, commands and settings from the other coding agents on this machine',
    usage: '[--dry-run] [<source>]',
    semantics: 'scans the known sources, shows one review overlay of what would be written, and applies only what you accept; a credential row always needs a terminal and is never applied by `--yes` (§5.2, §5.3). `jevcode import` is the CLI twin',
    category: 'config',
  },
  {
    name: 'memory',
    aliases: ['mem'],
    args: [
      { name: 'op', kind: 'enum', values: ['list', 'show', 'add', 'forget', 'reload'], optional: true, hint: '[list|show|add|forget|reload]', valueHints: { list: { title: 'the memory entries in effect' }, show: { title: 'the merged memory text' }, add: { title: 'append one line' }, forget: { title: 'drop one entry' }, reload: { title: 're-read the memory files from disk' } } },
      { name: 'text', kind: 'rest', optional: true, hint: '[<text>]' },
    ],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'the project and user memory this run reads',
    usage: '[list|show|add|forget|reload] [<text>]',
    semantics: 'reads and edits the memory files `memory.path` names; one switch (`memory.enabled`, D-AP) turns the whole feature off (§5.5)',
    category: 'config',
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

/**
 * TUI-DESIGN-5 §2.9: the index of a command's `rest` argument when it is the **last** one and the command takes no
 * flags, else `-1`. `takesRest`'s generalisation: `/rename`, `/steer` and `/why` answer `0` (round 1's case,
 * unchanged), `/headsup` answers `0`, `/tell` answers `1` and `/request` answers `2`. The positionals before it are
 * read as bare whitespace-delimited tokens and the remainder is taken raw, so `/tell mbp don't touch the tests` is
 * a message and never `unterminated quote`.
 */
export function restArgIndex(spec: CommandSpec): number {
  if ((spec.flags?.length ?? 0) > 0) return -1;
  const last = spec.args.length - 1;
  if (last < 0 || spec.args[last]?.kind !== 'rest') return -1;
  for (let i = 0; i < last; i++) if (spec.args[i]?.kind === 'rest') return -1;
  return last;
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
