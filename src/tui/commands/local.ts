/**
 * App-local command helpers (TUI-DESIGN-3 §4.3, §4.4 F14, F20, §4.1 rule 6), pure: `completeDraft` — Tab completes the command
 * name or the argument under the cursor and never wipes a typed argument (R4 F4); `dispatchCtxOf` — the one dispatch context
 * (the host's when it has one, the App's fold otherwise) with `run: 'none'` while a chat request is thinking (a chat request is
 * not a run); `recentCommands` — the Recent group of the palette from the history entries; `chatThinking` — the predicate the
 * App re-exports. No I/O, no Ink, no import from `cli/**`.
 */
import type { SessionHost } from '../../core/types.js';
import type { KeyRunPhase } from '../keys/resolve.js';
import { argumentCandidates, type DispatchContext } from './dispatch.js';
import { rank } from './fuzzy.js';
import { noCompletionsToast } from './nav.js';
import { paletteMatches, RECENT_MAX, type PaletteState } from './palette.js';
import { commandName, isCommandLine } from './parse.js';
import { findCommand, takesRest, type CommandSpec } from './registry.js';

/** TUI-DESIGN-2 §3.1 / §4.9: an engine run owns the session — `live`, `aborting`, `pausing` (`starting` follows the idle rules). */
export function runIsLive(run: KeyRunPhase): boolean {
  return run === 'live' || run === 'aborting' || run === 'pausing';
}

/** TUI-DESIGN-2 §3.1 rows 1, 10, 11: a chat request is in flight — the phase is set and no engine run owns the session. */
export function chatThinking(s: { readonly run: KeyRunPhase; readonly thinking: unknown }): boolean {
  return s.thinking !== null && s.thinking !== undefined && !runIsLive(s.run);
}

/** TUI-DESIGN-3 §4.4 F20: what `dispatchCtxOf` reads from the App's state when the host has no context of its own. */
export interface DispatchStateView {
  readonly run: KeyRunPhase;
  readonly step: number;
  readonly changedSteps: readonly number[];
  readonly thinking: unknown;
}

/**
 * TUI-DESIGN-3 §4.4 F20 / F14 `dispatchCtxOf` — the host's `dispatchContext()` (denylist, `newestRunId ?? sessionId`) when it
 * exposes one, else the App's fold (`sessions[].id = sessionId`, changed steps from the reducer); the run phase is the App's,
 * read as `none` while a chat request is thinking so idle commands resolve and `/steer` answers `needs a live run`.
 */
export function dispatchCtxOf(host: Pick<SessionHost, 'index' | 'dispatchContext'> | null, state: DispatchStateView): DispatchContext {
  const own = host?.dispatchContext?.();
  const base: Omit<DispatchContext, 'run'> = own ?? {
    step: state.step,
    changedSteps: state.changedSteps,
    ...(host ? { sessions: host.index().map((s) => ({ id: s.sessionId, title: s.title })) } : {}),
  };
  return { ...base, run: chatThinking(state) ? 'none' : state.run };
}

/**
 * TUI-DESIGN-3 §4.1 rule 6 `recentCommands` — the Recent group: the owners of the last `max` distinct command lines in the history
 * (entries oldest first, as `HistoryStore.entries('workspace')` returns them; typed records are filtered to `kind === 'command'`),
 * newest first; an alias line resolves to its owner before de-duplication. Computed once at palette open.
 */
export function recentCommands(entries: readonly (string | { readonly kind: string; readonly text: string })[], max = RECENT_MAX): string[] {
  const out: string[] = [];
  for (let i = entries.length - 1; i >= 0 && out.length < max; i--) {
    const e = entries[i] as string | { readonly kind: string; readonly text: string };
    const text = typeof e === 'string' ? e : e.kind === 'command' ? e.text : null;
    if (text === null || !isCommandLine(text.trimStart())) continue;
    const name = commandName(text);
    const spec = name === null ? null : findCommand(name);
    if (spec === null || out.includes(spec.name)) continue;
    out.push(spec.name);
  }
  return out;
}

/** TUI-DESIGN-3 §4.3: one token of a draft with its code-unit span (`value` is the unquoted text, `raw` the slice as typed). */
export interface DraftToken {
  readonly start: number;
  readonly end: number;
  readonly raw: string;
  readonly value: string;
  /** a `--flag` / `--flag=value` token — skipped when counting positionals */
  readonly flag: boolean;
}

/**
 * TUI-DESIGN-3 §4.3 `draftTokens` — the §5.1 grammar with positions: the name token and every argument token (quotes unwrapped,
 * escapes removed in `value`; an unterminated quote runs to the end). Pure; a non-command draft yields `name: null`.
 */
export function draftTokens(draft: string): { readonly name: DraftToken | null; readonly args: readonly DraftToken[] } {
  let i = 0;
  const n = draft.length;
  const ws = (c: string): boolean => /\s/.test(c);
  while (i < n && ws(draft[i] as string)) i++;
  if (draft[i] !== '/' || draft[i + 1] === '/') return { name: null, args: [] };
  const nameStart = i;
  while (i < n && !ws(draft[i] as string)) i++;
  const name: DraftToken = { start: nameStart, end: i, raw: draft.slice(nameStart, i), value: draft.slice(nameStart + 1, i).toLowerCase(), flag: false };
  const args: DraftToken[] = [];
  while (i < n) {
    while (i < n && ws(draft[i] as string)) i++;
    if (i >= n) break;
    const start = i;
    let value = '';
    const q = draft[i] as string;
    if (q === '"' || q === "'") {
      i++;
      while (i < n && (draft[i] as string) !== q) {
        if (q === '"' && (draft[i] as string) === '\\' && i + 1 < n) {
          value += draft[i + 1] as string;
          i += 2;
          continue;
        }
        value += draft[i] as string;
        i++;
      }
      if (i < n) i++; // the closing quote
    } else {
      while (i < n && !ws(draft[i] as string)) {
        if ((draft[i] as string) === '\\' && i + 1 < n) {
          value += draft[i + 1] as string;
          i += 2;
          continue;
        }
        value += draft[i] as string;
        i++;
      }
    }
    const raw = draft.slice(start, i);
    args.push({ start, end: i, raw, value, flag: raw.startsWith('--') && raw.length > 2 });
  }
  return { name, args };
}

/** TUI-DESIGN-3 §4.3: what `completeDraft` needs — the dispatch context (candidates) and the palette state (command ranking). */
export interface CompletionContext {
  readonly dispatch: DispatchContext;
  readonly palette: PaletteState;
}

/** TUI-DESIGN-3 §4.3 / §10: the toast when the argument under the cursor has no candidates (the one definition lives in `nav.ts`, TUI-DESIGN-4 §4.2). */
export { noCompletionsToast };

/** TUI-DESIGN-3 §4.3: the outcome of one Tab. */
export type Completion =
  /** the name token was completed to `/name ` (the tail after the name is kept) */
  | { readonly kind: 'command'; readonly text: string; readonly cursor: number; readonly name: string }
  /**
   * the argument token under the cursor was replaced by `candidates[selected]`; `accepted` = a unique or exact value took a
   * trailing space (the next Tab moves on); otherwise the App keeps `stem` and advances `selected` so the next Tab cycles
   */
  | { readonly kind: 'argument'; readonly text: string; readonly cursor: number; readonly candidates: readonly string[]; readonly selected: number; readonly stem: string; readonly arg: string; readonly accepted: boolean }
  /** nothing to complete here — the toast says why; the draft is untouched */
  | { readonly kind: 'none'; readonly toast: string }
  /** not a command line, or nothing matched the name token */
  | { readonly kind: 'ignore' };

/** a `run` candidate with whitespace is inserted quoted, `"` and `\` escaped */
export function quoteCandidate(c: string): string {
  return /\s/.test(c) ? `"${c.replace(/(["\\])/g, '\\$1')}"` : c;
}

function wrap(i: number, n: number): number {
  if (n <= 0) return 0;
  const k = Math.floor(Number.isFinite(i) ? i : 0) % n;
  return k < 0 ? k + n : k;
}

/**
 * TUI-DESIGN-3 §4.3 `completeDraft` — Tab (`dir` 1) / Shift+Tab (−1) on a command draft. The cursor inside or right after the
 * name token completes the command as today (`paletteMatches(token)[selected]` → `/name `, the tail kept). Otherwise the token
 * under the cursor is an argument: `argIndex` counts the completed positionals (`--flags` skipped), the candidates come from
 * `argumentCandidates(spec, argIndex, ctx)` ranked by the stem (the partial as typed; the App passes the remembered `stem`
 * while cycling); **only the partial token is replaced** — the tail after it is kept. A typed value that is exactly a candidate,
 * or the only prefix match, is accepted with a trailing space; several candidates cycle through `selected` without one. `rest` /
 * `text` / `path` arguments (`/rename`, `/steer`, `/why`, `/model <id>`, `/export <file>`) have no candidates → `none` with the
 * toast `no completions for <arg>`. Pure; O(candidates) per key.
 */
export function completeDraft(draft: string, cursor: number, dir: 1 | -1, ctx: CompletionContext, selected: number, stem?: string): Completion {
  void dir; // the direction lives in the caller's `selected` arithmetic; kept in the signature so both keys share one path
  const lead = draft.trimStart();
  if (!isCommandLine(lead)) return { kind: 'ignore' };
  const t = draftTokens(draft);
  if (t.name === null) return { kind: 'ignore' };
  const at = Math.max(0, Math.min(Math.floor(cursor), draft.length));
  if (at <= t.name.end) {
    const matches = paletteMatches(t.name.value, ctx.palette);
    const pick = matches[wrap(selected, matches.length)]?.spec.name;
    if (pick === undefined) return { kind: 'ignore' };
    const tail = draft.slice(t.name.end);
    const head = `/${pick}`;
    const text = tail.trim() === '' ? `${head} ` : `${head}${tail}`;
    return { kind: 'command', text, cursor: head.length + 1, name: pick };
  }
  const spec: CommandSpec | null = findCommand(t.name.value);
  if (spec === null) return { kind: 'ignore' };
  if (takesRest(spec)) return { kind: 'none', toast: noCompletionsToast(spec.args[0]?.name ?? `/${spec.name}`) };
  const under = t.args.find((a) => a.start <= at && at <= a.end) ?? null;
  if (under?.flag === true) return { kind: 'none', toast: noCompletionsToast(under.raw.split('=')[0] ?? under.raw) };
  const from = under?.start ?? at;
  const to = under?.end ?? at;
  const argIndex = t.args.filter((a) => !a.flag && a.end <= from && a !== under).length;
  const argSpec = spec.args[argIndex];
  if (argSpec === undefined) return { kind: 'none', toast: noCompletionsToast(`/${spec.name}`) };
  const all = argumentCandidates(spec, argIndex, ctx.dispatch);
  if (all.length === 0) return { kind: 'none', toast: noCompletionsToast(argSpec.name) };
  const partial = under?.value ?? '';
  const lower = partial.toLowerCase();
  const key = (stem ?? partial).toLowerCase();
  const insert = (value: string, candidates: readonly string[], index: number, accepted: boolean): Completion => {
    const inserted = `${quoteCandidate(value)}${accepted ? ' ' : ''}`;
    const text = `${draft.slice(0, from)}${inserted}${draft.slice(to)}`;
    return { kind: 'argument', text, cursor: from + inserted.length, candidates, selected: index, stem: stem ?? partial, arg: argSpec.name, accepted };
  };
  if (stem === undefined) {
    const exact = all.find((c) => c.toLowerCase() === lower);
    if (exact !== undefined) return insert(exact, [exact], 0, true);
    const prefix = all.filter((c) => c.toLowerCase().startsWith(lower));
    if (prefix.length === 1) return insert(prefix[0] as string, prefix, 0, true);
  }
  const ranked = key === '' ? [...all] : rank(key, all, Number.POSITIVE_INFINITY).map((r) => r.candidate);
  if (ranked.length === 0) return { kind: 'none', toast: noCompletionsToast(argSpec.name) };
  if (ranked.length === 1) return insert(ranked[0] as string, ranked, 0, true);
  const index = wrap(selected, ranked.length);
  return insert(ranked[index] as string, ranked, index, false);
}

/**
 * TUI-DESIGN-3 §4.3: the value hint to ghost after an accepted argument — `<usd>` after `/budget spend-cap `, `[stage]` after
 * `/decisions 5 ` — the `valueHints[value].args` of the previous positional when it has one, else the next argument's `hint`.
 * Null when the cursor is not on an empty token after a command's arguments or nothing is expected there.
 */
export function argumentGhost(draft: string, cursor: number): string | null {
  const t = draftTokens(draft);
  if (t.name === null) return null;
  const at = Math.max(0, Math.min(Math.floor(cursor), draft.length));
  if (at <= t.name.end || at !== draft.length || !/\s$/.test(draft)) return null;
  const spec = findCommand(t.name.value);
  if (spec === null || takesRest(spec)) return null;
  const positionals = t.args.filter((a) => !a.flag);
  const prev = positionals[positionals.length - 1];
  const prevSpec = prev === undefined ? undefined : spec.args[positionals.length - 1];
  const fromValue = prev !== undefined && prevSpec?.valueHints?.[prev.value]?.args;
  if (typeof fromValue === 'string' && fromValue !== '') return fromValue;
  const next = spec.args[positionals.length];
  return next?.hint ?? null;
}
