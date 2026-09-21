/**
 * The command table (TUI-DESIGN §5.2): one typed array feeds the dispatcher, the palette, help,
 * `docs/COMMANDS.md` (scripts/gen-docs.mjs) and the `--plain` readline composer. Pure data plus lookups.
 * `availableDuringTask`: idle | live | any. `plain`: whether the readline composer supports the command.
 */

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

/** TUI-DESIGN §5.2 `COMMANDS` — the table, in the design's row order. */
export const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'help',
    aliases: ['h'],
    args: [{ name: 'topic', kind: 'enum', values: ['keys', 'commands', 'reload'], optional: true, hint: '[keys|commands|reload]' }],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'keys by context, commands with one-liners, per-terminal notes',
    usage: '[keys|commands|reload]',
    semantics: 'append the help block (keys by context, commands with one-liners, per-terminal notes); `reload` re-reads `keybindings.json`',
    category: 'ui',
  },
  {
    name: 'new',
    aliases: [],
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
    aliases: ['sessions', 'continue'],
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
    aliases: [],
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
    aliases: [],
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
    aliases: [],
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
    aliases: [],
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
    aliases: [],
    args: [
      { name: 'n', kind: 'int', optional: true, hint: '[n]' },
      { name: 'stage', kind: 'enum', values: ['replan', 'intent', 'context', 'propose', 'risk', 'execute', 'judge', 'complete'], optional: true, hint: '[stage]' },
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
    aliases: [],
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
    aliases: [],
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
    aliases: [],
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
    aliases: [],
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
    aliases: [],
    args: [{ name: 'id', kind: 'text', hint: '<id>' }],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'generator model for the next run only',
    usage: '<id>',
    semantics: 'pending for the **next** run only (memory); a differing `--model` on `/resume` stays `ConfigError`',
    category: 'config',
  },
  {
    name: 'provider',
    aliases: [],
    args: [{ name: 'p', kind: 'enum', values: ['anthropic', 'openrouter'], hint: '<p>' }],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'generator provider for the next run only',
    usage: '<p>',
    semantics: 'pending for the **next** run only (memory)',
    category: 'config',
  },
  {
    name: 'mode',
    aliases: [],
    args: [{ name: 'm', kind: 'enum', values: ['jev-on', 'jev-off', 'jev-only'], hint: '<m>' }],
    availableDuringTask: 'any',
    plain: 'yes',
    title: 'engine mode for the next run only',
    usage: '<m>',
    semantics: 'pending for the **next** run only (memory)',
    category: 'config',
  },
  {
    name: 'config',
    aliases: [],
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
    aliases: [],
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
    args: [{ name: 'which', kind: 'enum', values: ['generator', 'jev'], optional: true, hint: '[generator|jev]' }],
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
    aliases: [],
    args: [{ name: 'theme', kind: 'enum', values: THEMES, hint: '<dark|light|daltonized|ansi>' }],
    availableDuringTask: 'any',
    plain: 'n/a',
    title: 'colour theme for new items and the dynamic region',
    usage: '<dark|light|daltonized|ansi>',
    semantics: 'new items and the dynamic region only',
    category: 'ui',
  },
  {
    name: 'copy',
    aliases: [],
    args: [{ name: 'what', kind: 'enum', values: ['last', 'proposal', 'diff', 'draft'], optional: true, hint: '[last|proposal|diff|draft]' }],
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
    aliases: [],
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
    aliases: ['quit'],
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
