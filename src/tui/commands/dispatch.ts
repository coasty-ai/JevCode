/**
 * Pure command resolution (TUI-DESIGN §5.1, §5.2, §4.9; TUI-DESIGN-2 §1.3, §4.6; TUI-DESIGN-3 §4.4 F15, F21): `dispatchCommand`
 * turns a parsed line into the action descriptor the controller executes, or into the `[ui] error:` text the composer appends —
 * with `keepDraft` true for the errors the user can fix by editing (unknown command, tokeniser, bad argument) and false for
 * availability errors (`needs a live run`, `runs when the run is idle`), which have nothing to fix (D-K). Validates `ArgSpec`s,
 * flags and `availableDuringTask`. No I/O, no clock, and no import from `cli/**` (the controller depends on this module, never
 * the reverse).
 */
import { isValidRunId } from '../../checkpoint/run-id.js';
import { parseDuration } from '../../core/time.js';
import type { EngineMode, StageName } from '../../core/types.js';
import type { KeyRunPhase } from '../keys/resolve.js';
import { commandName, parseCommand, restOf, type ParseResult, type ParsedCommand } from './parse.js';
import { BUDGET_SETTINGS, COMMANDS, LLM_STATE_MODE, LLM_STATES, PANEL_ARGS, THEMES, TRANSCRIPT_VIEWS, availabilityError, findCommand, takesRest, type ArgSpec, type CommandSpec } from './registry.js';

/** TUI-DESIGN §5.1: what the resolver needs to know about the session to validate arguments. */
export interface DispatchContext {
  /** the run phase (§15 item 20 `RunPhase`); anything but 'none' is live for `availableDuringTask` */
  readonly run: KeyRunPhase;
  /** committed steps of the current or last run (upper bound of `step` arguments) */
  readonly step: number;
  /** steps with `changedFiles` (from the reducer's `step:end` records, never a `steps.jsonl` read); undefined = not known */
  readonly changedSteps?: readonly number[];
  /** the index fold for `run` arguments: id + title */
  readonly sessions?: readonly { readonly id: string; readonly title: string }[];
  /** the `@` denylist for `path` arguments */
  readonly isDeniedPath?: (rel: string) => boolean;
}

/** TUI-DESIGN §9.4: a validated `/budget <setting> <value>`. */
export type BudgetValue =
  | { setting: 'spend-cap'; usd: number }
  | { setting: 'session-spend-cap'; usd: number | 'none' }
  | { setting: 'max-steps' | 'max-replans' | 'max-generator-tokens'; n: number }
  | { setting: 'max-wall'; ms: number; text: string };

/** TUI-DESIGN §5.2: one action per command, fully validated. */
export type CommandAction =
  | { kind: 'help'; topic: 'all' | 'keys' | 'commands' | 'reload' }
  | { kind: 'new' }
  | { kind: 'resume'; target: { kind: 'picker' } | { kind: 'continue' } | { kind: 'run'; id: string }; force: boolean; sort: 'updated' | 'created' }
  | { kind: 'rename'; title: string }
  | { kind: 'steer'; text: string }
  | { kind: 'unsteer' }
  | { kind: 'pause' }
  | { kind: 'abort' }
  | { kind: 'undo'; step: number | null }
  | { kind: 'rewind'; step: number | null }
  | { kind: 'diff'; step: number | null; full: boolean; all: boolean }
  | { kind: 'plan' }
  | { kind: 'decisions'; n: number; stage: StageName | null }
  | { kind: 'why'; ref: string }
  | { kind: 'calibration' }
  | { kind: 'jev' }
  | { kind: 'cost' }
  | { kind: 'budget'; set: BudgetValue | null }
  // TUI-DESIGN-3 §4.4 F15: `/model` and `/provider` alone show (null) the current and the pending value
  | { kind: 'model'; id: string | null }
  | { kind: 'provider'; provider: 'anthropic' | 'openrouter' | null }
  // TUI-DESIGN-2 §1.3 / §6 item 17: `/mode` alone shows (null); `/llm on` → jev-on, `/llm off` → jev-only
  | { kind: 'mode'; mode: EngineMode | null }
  // TUI-DESIGN-2 §4.6: `/panel` alone toggles; a tab letter opens it; `off` collapses; `full` expands. `/transcript` alone shows the view
  | { kind: 'panel'; panel: 'toggle' | (typeof PANEL_ARGS)[number] }
  | { kind: 'transcript'; view: (typeof TRANSCRIPT_VIEWS)[number] | null }
  | { kind: 'config' }
  | { kind: 'login' }
  | { kind: 'logout'; which: 'generator' | 'jev' | null }
  | { kind: 'trust' }
  | { kind: 'theme'; theme: (typeof THEMES)[number] }
  | { kind: 'copy'; what: 'last' | 'proposal' | 'diff' | 'draft' }
  | { kind: 'export'; file: string | null }
  | { kind: 'status' }
  | { kind: 'errors' }
  | { kind: 'report' }
  | { kind: 'historyClear' }
  | { kind: 'editor' }
  | { kind: 'exit' };

/**
 * TUI-DESIGN §4.9 / TUI-DESIGN-3 §4.4 F21: the resolution — an action, or the item text (`error: …`, printed under the `[ui]`
 * label) with `keepDraft`: true for a fixable error (the draft stays for editing), false for an availability error (the App
 * clears the draft, so the next line never appends to it: `› /steer x/pause`, R4 F21).
 */
export type DispatchResult =
  | { readonly ok: true; readonly action: CommandAction; readonly spec: CommandSpec }
  | { readonly ok: false; readonly text: string; readonly label: '[ui]'; readonly keepDraft: boolean };

/**
 * TUI-DESIGN-3 §8 S4 (G5): every `CommandAction['kind']`, once — the exhaustiveness check of the dispatch-loop test (a `case`
 * in the App's `runCommand` or the controller's `execute()` for each). The `satisfies` keeps the list and the union in step.
 */
export const COMMAND_ACTION_KINDS = [
  'help', 'new', 'resume', 'rename', 'steer', 'unsteer', 'pause', 'abort', 'undo', 'rewind', 'diff', 'plan', 'decisions', 'why', 'calibration', 'jev', 'cost',
  'budget', 'model', 'provider', 'mode', 'panel', 'transcript', 'config', 'login', 'logout', 'trust', 'theme', 'copy', 'export', 'status', 'errors', 'report',
  'historyClear', 'editor', 'exit',
] as const satisfies readonly CommandAction['kind'][];
/** the type-level twin: a kind missing from `COMMAND_ACTION_KINDS` fails here */
type MissingKind = Exclude<CommandAction['kind'], (typeof COMMAND_ACTION_KINDS)[number]>;
const _everyKindListed: MissingKind extends never ? true : never = true;
void _everyKindListed;

/** TUI-DESIGN §24: the unknown-command item (a `/` token that matches nothing never submits). */
export function unknownCommandText(token: string): string {
  const t = token.startsWith('/') ? token : `/${token}`;
  return `error: unknown command ${t}; type / to list commands`;
}

/** a fixable error: the draft is kept */
function err(text: string): DispatchResult {
  return { ok: false, text, label: '[ui]', keepDraft: true };
}

/** TUI-DESIGN-3 §4.4 F21: an availability error — nothing to edit, the draft is cleared */
function availErr(text: string): DispatchResult {
  return { ok: false, text, label: '[ui]', keepDraft: false };
}

function cmdErr(name: string, reason: string): DispatchResult {
  return err(`error: /${name}: ${reason}`);
}

const STAGES: readonly StageName[] = ['replan', 'intent', 'context', 'propose', 'risk', 'execute', 'judge', 'complete'];
const DECISIONS_DEFAULT = 12;
/** the ceiling for step / replan / row counts */
const MAX_INT = 1_000_000;
/** TUI-DESIGN §9.5: the token cap's ceiling — the derived default is `spendCapUsd / 15 × 1e6` (a $20 cap → 1,333,333), so 1e9 leaves room */
const MAX_TOKENS = 1_000_000_000;

function positiveInt(v: string, max = MAX_INT): number | null {
  if (!/^\d{1,10}$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 && n <= max ? n : null;
}

function usd(v: string): number | null {
  const t = v.trim().replace(/^\$/, '');
  if (!/^\d+(?:\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** TUI-DESIGN §5.1 `run`: `RUN_ID_RE` or a unique title / case-insensitive title prefix in the index fold. */
export function resolveRunTarget(value: string, sessions: readonly { readonly id: string; readonly title: string }[] | undefined): { ok: true; id: string } | { ok: false; reason: string } {
  const v = value.trim();
  if (v === '') return { ok: false, reason: 'expected a run id or a session title' };
  if (isValidRunId(v)) return { ok: true, id: v };
  const list = sessions ?? [];
  const lower = v.toLowerCase();
  const exact = list.filter((s) => s.title.toLowerCase() === lower);
  if (exact.length === 1) return { ok: true, id: (exact[0] as { id: string }).id };
  const pool = exact.length > 1 ? exact : list.filter((s) => s.title.toLowerCase().startsWith(lower));
  if (pool.length === 1) return { ok: true, id: (pool[0] as { id: string }).id };
  if (pool.length > 1) {
    const names = pool.slice(0, 5).map((s) => `"${s.title}"`).join(', ');
    return { ok: false, reason: `"${v}" matches ${pool.length} sessions: ${names}${pool.length > 5 ? ', …' : ''}` };
  }
  return { ok: false, reason: `no session matches "${v}"` };
}

/** TUI-DESIGN §5.1 `step`: an integer `1..state.step` with `changedFiles`. */
function stepArg(v: string, ctx: DispatchContext): number | null {
  const n = positiveInt(v);
  if (n === null || n > ctx.step) return null;
  if (ctx.changedSteps !== undefined && !ctx.changedSteps.includes(n)) return null;
  return n;
}

function stepReason(ctx: DispatchContext, got: string): string {
  const range = ctx.step >= 1 ? `1..${ctx.step}` : 'none yet';
  return `expected a step ${range} with changed files, got "${got}"`;
}

function enumArg(spec: ArgSpec, v: string): string | null {
  const lower = v.trim().toLowerCase();
  return (spec.values ?? []).find((x) => x === lower) ?? null;
}

function enumReason(spec: ArgSpec, got: string): string {
  return `expected one of ${(spec.values ?? []).join('|')}, got "${got}"`;
}

/** TUI-DESIGN §5.1 options: unknown flags, a value on a boolean flag, a missing or unlisted value on a value flag */
function checkFlags(spec: CommandSpec, p: ParsedCommand): DispatchResult | null {
  const flags = spec.flags ?? [];
  for (const [k, v] of Object.entries(p.options)) {
    const f = flags.find((x) => x.name === k);
    if (f === undefined) return cmdErr(spec.name, `unknown option --${k}`);
    if (f.value !== true) {
      if (v !== true) return cmdErr(spec.name, `--${k} takes no value`);
      continue;
    }
    const expects = f.values !== undefined ? f.values.join('|') : 'a value';
    if (v === true) return cmdErr(spec.name, `--${k} expects ${expects} (--${k}=${f.values?.[0] ?? '<value>'})`);
    if (f.values !== undefined && !f.values.includes(v)) return cmdErr(spec.name, `--${k} expects ${expects}, got "${v}"`);
  }
  return null;
}

function tooMany(spec: CommandSpec, p: ParsedCommand, max: number): DispatchResult | null {
  if (p.args.length > max) return cmdErr(spec.name, max === 0 ? 'takes no arguments' : `takes at most ${max} argument${max === 1 ? '' : 's'}, got ${p.args.length}`);
  return null;
}

function budgetValue(setting: (typeof BUDGET_SETTINGS)[number], v: string): { ok: true; set: BudgetValue } | { ok: false; reason: string } {
  switch (setting) {
    case 'spend-cap': {
      const n = usd(v);
      return n === null ? { ok: false, reason: `expected a positive USD amount, got "${v}"` } : { ok: true, set: { setting, usd: n } };
    }
    case 'session-spend-cap': {
      if (v.trim().toLowerCase() === 'none') return { ok: true, set: { setting, usd: 'none' } };
      const n = usd(v);
      return n === null ? { ok: false, reason: `expected a positive USD amount or none, got "${v}"` } : { ok: true, set: { setting, usd: n } };
    }
    case 'max-steps':
    case 'max-replans': {
      const n = positiveInt(v);
      return n === null ? { ok: false, reason: `expected a positive integer, got "${v}"` } : { ok: true, set: { setting, n } };
    }
    case 'max-generator-tokens': {
      const n = positiveInt(v, MAX_TOKENS);
      return n === null ? { ok: false, reason: `expected a positive integer of generator tokens, got "${v}"` } : { ok: true, set: { setting, n } };
    }
    case 'max-wall': {
      try {
        return { ok: true, set: { setting, ms: parseDuration(v, 'max-wall'), text: v.trim().toLowerCase() } };
      } catch {
        return { ok: false, reason: `expected a duration such as 30m, 7h30m or 90s, got "${v}"` };
      }
    }
  }
}

/**
 * TUI-DESIGN §5.1 `parseCommandLine` — the tokeniser as the dispatcher applies it: the name token is read
 * first; a command whose only argument is `rest` (`/rename`, `/steer`, `/why`) takes the raw remainder of
 * the line with no quote or escape processing (`rest = raw remainder, trimmed, ≤ 600`), every other command
 * goes through the §5.1 grammar. So `/steer don't touch the tests` is a steer, never `unterminated quote`.
 */
export function parseCommandLine(line: string): ParseResult {
  const name = commandName(line);
  if (name !== null) {
    const spec = findCommand(name);
    if (spec !== null && takesRest(spec)) {
      const raw = line.trim();
      const rest = restOf(raw);
      return { ok: true, command: { name, args: rest === '' ? [] : [rest], options: {}, raw } };
    }
  }
  return parseCommand(line);
}

/**
 * TUI-DESIGN §5.2 `dispatchCommand` — resolve a parsed command (or a raw line) against the registry and
 * the context. Enter runs a command only on an exact name/alias match; an unknown name keeps the draft
 * (`error: unknown command /foo; type / to list commands`); a failed `ArgSpec` yields
 * `error: /<cmd>: <reason>`; `availableDuringTask` yields the two §24 sentences. A raw line is tokenised by
 * `parseCommandLine` (rest commands skip the grammar); a `ParsedCommand` is taken as given, its `raw`
 * remainder still feeding the rest arguments.
 */
export function dispatchCommand(input: ParsedCommand | string, ctx: DispatchContext): DispatchResult {
  let p: ParsedCommand;
  if (typeof input === 'string') {
    const r = parseCommandLine(input);
    if (!r.ok) {
      if (r.error === 'not-a-command' || r.error === 'empty name') return err(unknownCommandText(input.trim().split(/\s+/)[0] ?? '/'));
      return r.name === null ? err(`error: ${r.reason}`) : cmdErr(r.name, r.reason);
    }
    p = r.command;
  } else p = input;
  const spec = findCommand(p.name);
  if (spec === null) return err(unknownCommandText(p.name));
  const live = ctx.run !== 'none';
  const unavailable = availabilityError(spec, live);
  if (unavailable !== null) return availErr(unavailable);
  const flagErr = checkFlags(spec, p);
  if (flagErr !== null) return flagErr;
  for (const f of spec.flags ?? []) {
    if (f.idleOnly && live && p.options[f.name] !== undefined) return availErr(`error: /${spec.name} --${f.name} runs when the run is idle; Esc pauses first`);
  }
  const a0 = p.args[0];
  const ok = (action: CommandAction): DispatchResult => ({ ok: true, action, spec });

  switch (spec.name) {
    case 'help': {
      const t = tooMany(spec, p, 1);
      if (t) return t;
      if (a0 === undefined) return ok({ kind: 'help', topic: 'all' });
      const v = enumArg(spec.args[0] as ArgSpec, a0);
      if (v === null) return cmdErr(spec.name, enumReason(spec.args[0] as ArgSpec, a0));
      return ok({ kind: 'help', topic: v as 'keys' | 'commands' | 'reload' });
    }
    case 'new':
    case 'unsteer':
    case 'pause':
    case 'abort':
    case 'plan':
    case 'calibration':
    case 'jev':
    case 'cost':
    case 'config':
    case 'login':
    case 'trust':
    case 'status':
    case 'errors':
    case 'report':
    case 'editor':
    case 'exit': {
      const t = tooMany(spec, p, 0);
      if (t) return t;
      return ok({ kind: spec.name } as CommandAction);
    }
    case 'resume': {
      const t = tooMany(spec, p, 1);
      if (t) return t;
      const force = p.options['force'] === true;
      const sortOpt = p.options['sort'];
      const sort: 'updated' | 'created' = sortOpt === 'created' ? 'created' : 'updated'; // validated by checkFlags
      if (a0 === undefined) return ok({ kind: 'resume', target: p.name === 'continue' ? { kind: 'continue' } : { kind: 'picker' }, force, sort });
      const r = resolveRunTarget(a0, ctx.sessions);
      if (!r.ok) return cmdErr('resume', r.reason);
      return ok({ kind: 'resume', target: { kind: 'run', id: r.id }, force, sort });
    }
    case 'rename': {
      const title = restOf(p.raw, 600);
      if (title === '') return cmdErr(spec.name, 'expected <title>');
      // TUI-DESIGN-3 §4.4 F13: the host clips once (`text60`) and says so — the dispatcher passes the title whole
      return ok({ kind: 'rename', title });
    }
    case 'steer': {
      const text = restOf(p.raw, 600);
      if (text === '') return cmdErr(spec.name, 'expected <text>');
      return ok({ kind: 'steer', text });
    }
    case 'why': {
      const ref = restOf(p.raw, 600);
      if (ref === '') return cmdErr(spec.name, 'expected <ref|digit> such as s7.risk.plan_mismatch, risk.plan_mismatch or 3');
      return ok({ kind: 'why', ref });
    }
    case 'undo':
    case 'rewind': {
      const t = tooMany(spec, p, 1);
      if (t) return t;
      if (a0 === undefined) return ok({ kind: spec.name, step: null });
      const s = stepArg(a0, ctx);
      if (s === null) return cmdErr(spec.name, stepReason(ctx, a0));
      return ok({ kind: spec.name, step: s });
    }
    case 'diff': {
      const t = tooMany(spec, p, 1);
      if (t) return t;
      let step: number | null = null;
      if (a0 !== undefined) {
        step = stepArg(a0, ctx);
        if (step === null) return cmdErr(spec.name, stepReason(ctx, a0));
      }
      return ok({ kind: 'diff', step, full: p.options['full'] === true, all: p.options['all'] === true });
    }
    case 'decisions': {
      const t = tooMany(spec, p, 2);
      if (t) return t;
      let n = DECISIONS_DEFAULT;
      let stage: StageName | null = null;
      for (const a of p.args) {
        if (/^\d+$/.test(a)) {
          const v = positiveInt(a);
          if (v === null) return cmdErr(spec.name, `expected a positive integer, got "${a}"`);
          n = v;
        } else {
          const s = STAGES.find((x) => x === a.toLowerCase());
          if (s === undefined) return cmdErr(spec.name, `expected a count or a stage (${STAGES.join('|')}), got "${a}"`);
          stage = s;
        }
      }
      return ok({ kind: 'decisions', n, stage });
    }
    case 'budget': {
      const t = tooMany(spec, p, 2);
      if (t) return t;
      if (a0 === undefined) return ok({ kind: 'budget', set: null });
      const setting = BUDGET_SETTINGS.find((s) => s === a0.toLowerCase());
      if (setting === undefined) return cmdErr(spec.name, `expected one of ${BUDGET_SETTINGS.join('|')}, got "${a0}"`);
      const v = p.args[1];
      if (v === undefined) return err(`error: /budget ${setting}: expected a value`);
      const r = budgetValue(setting, v);
      if (!r.ok) return err(`error: /budget ${setting}: ${r.reason}`);
      return ok({ kind: 'budget', set: r.set });
    }
    case 'model': {
      const t = tooMany(spec, p, 1);
      if (t) return t;
      // TUI-DESIGN-3 §4.4 F15: no argument shows `model <current> (next run: <pending>)`
      if (a0 === undefined) return ok({ kind: 'model', id: null });
      if (a0.trim() === '') return cmdErr(spec.name, 'expected <id>');
      return ok({ kind: 'model', id: a0.trim() });
    }
    case 'provider': {
      const t = tooMany(spec, p, 1);
      if (t) return t;
      if (a0 === undefined) return ok({ kind: 'provider', provider: null });
      const v = enumArg(spec.args[0] as ArgSpec, a0);
      if (v === null) return cmdErr(spec.name, enumReason(spec.args[0] as ArgSpec, a0));
      return ok({ kind: 'provider', provider: v as 'anthropic' | 'openrouter' });
    }
    case 'mode': {
      const t = tooMany(spec, p, 1);
      if (t) return t;
      if (a0 === undefined) return ok({ kind: 'mode', mode: null });
      const v = enumArg(spec.args[0] as ArgSpec, a0);
      if (v === null) return cmdErr(spec.name, enumReason(spec.args[0] as ArgSpec, a0));
      return ok({ kind: 'mode', mode: v as EngineMode });
    }
    case 'llm': {
      const t = tooMany(spec, p, 1);
      if (t) return t;
      if (a0 === undefined) return cmdErr(spec.name, `expected <on|off>: on = /mode jev-on, off = /mode jev-only`);
      const v = enumArg(spec.args[0] as ArgSpec, a0);
      if (v === null) return cmdErr(spec.name, enumReason(spec.args[0] as ArgSpec, a0));
      return ok({ kind: 'mode', mode: LLM_STATE_MODE[v as (typeof LLM_STATES)[number]] });
    }
    case 'panel': {
      const t = tooMany(spec, p, 1);
      if (t) return t;
      if (a0 === undefined) return ok({ kind: 'panel', panel: 'toggle' });
      const v = enumArg(spec.args[0] as ArgSpec, a0);
      if (v === null) return cmdErr(spec.name, enumReason(spec.args[0] as ArgSpec, a0));
      return ok({ kind: 'panel', panel: v as (typeof PANEL_ARGS)[number] });
    }
    case 'transcript': {
      const t = tooMany(spec, p, 1);
      if (t) return t;
      if (a0 === undefined) return ok({ kind: 'transcript', view: null });
      const v = enumArg(spec.args[0] as ArgSpec, a0);
      if (v === null) return cmdErr(spec.name, enumReason(spec.args[0] as ArgSpec, a0));
      return ok({ kind: 'transcript', view: v as (typeof TRANSCRIPT_VIEWS)[number] });
    }
    case 'logout': {
      const t = tooMany(spec, p, 1);
      if (t) return t;
      if (a0 === undefined) return ok({ kind: 'logout', which: null });
      const v = enumArg(spec.args[0] as ArgSpec, a0);
      if (v === null) return cmdErr(spec.name, enumReason(spec.args[0] as ArgSpec, a0));
      return ok({ kind: 'logout', which: v as 'generator' | 'jev' });
    }
    case 'theme': {
      const t = tooMany(spec, p, 1);
      if (t) return t;
      if (a0 === undefined) return cmdErr(spec.name, `expected one of ${THEMES.join('|')}`);
      const v = enumArg(spec.args[0] as ArgSpec, a0);
      if (v === null) return cmdErr(spec.name, enumReason(spec.args[0] as ArgSpec, a0));
      return ok({ kind: 'theme', theme: v as (typeof THEMES)[number] });
    }
    case 'copy': {
      const t = tooMany(spec, p, 1);
      if (t) return t;
      if (a0 === undefined) return ok({ kind: 'copy', what: 'last' });
      const v = enumArg(spec.args[0] as ArgSpec, a0);
      if (v === null) return cmdErr(spec.name, enumReason(spec.args[0] as ArgSpec, a0));
      return ok({ kind: 'copy', what: v as 'last' | 'proposal' | 'diff' | 'draft' });
    }
    case 'export': {
      const t = tooMany(spec, p, 1);
      if (t) return t;
      if (a0 === undefined) return ok({ kind: 'export', file: null });
      const file = a0.trim();
      if (file === '' || file.includes('\0')) return cmdErr(spec.name, `"${a0}" is not a file path`);
      if (ctx.isDeniedPath?.(file) === true) return cmdErr(spec.name, `${file} is on the secret denylist; JevCode never writes there`);
      return ok({ kind: 'export', file });
    }
    case 'history': {
      const t = tooMany(spec, p, 1);
      if (t) return t;
      if (a0 === undefined || enumArg(spec.args[0] as ArgSpec, a0) === null) return cmdErr(spec.name, `expected clear${a0 === undefined ? '' : `, got "${a0}"`}`);
      return ok({ kind: 'historyClear' });
    }
    default:
      return err(unknownCommandText(spec.name));
  }
}

/**
 * TUI-DESIGN §5.1 / TUI-DESIGN-3 §4.3: the completion candidates for the argument at `argIndex` of a command — enum and setting
 * values in palette order, the changed steps for `step`, the session titles (id when untitled) for `run`; `rest`/`text`/`path`
 * have none (Tab is then a no-op with `no completions for <arg>`). Consumed by `completeDraft` (local.ts).
 */
export function argumentCandidates(spec: CommandSpec, argIndex: number, ctx: DispatchContext): readonly string[] {
  const a = spec.args[argIndex];
  if (a === undefined) return [];
  switch (a.kind) {
    case 'enum':
    case 'setting':
      return a.values ?? [];
    case 'step': {
      const steps = ctx.changedSteps ?? Array.from({ length: Math.max(0, ctx.step) }, (_, i) => i + 1);
      return steps.filter((s) => s >= 1 && s <= ctx.step).map(String);
    }
    case 'run':
      return (ctx.sessions ?? []).map((s) => s.title === '' ? s.id : s.title);
    default:
      return [];
  }
}

/** every command name and alias — the registry's exact-match set (`isExactCommand` is the predicate). */
export const COMMAND_TOKENS: readonly string[] = COMMANDS.flatMap((c) => [`/${c.name}`, ...c.aliases.map((a) => `/${a}`)]);
