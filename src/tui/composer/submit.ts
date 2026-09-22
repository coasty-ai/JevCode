/**
 * Submit routing (TUI-DESIGN §4.9, §5.1, §10.2; TUI-DESIGN-3 §4.4 F14, F21), pure over `parseCommand` / `dispatchCommand` /
 * `host.detectSecrets`: Enter on the composer becomes one of — ignore (re-entrancy, empty), newline
 * (trailing `\`), a command action or its `[ui] error:` item (`keepDraft` says whether the draft stays: fixable errors keep
 * it, availability errors clear it, D-K), a `busy` toast for a command that must wait for the thinking reply, a missing-chip
 * cancel, a hold until the host attaches, the secret gate, a steer (run live) or a submission (idle). A `/` token
 * that matches nothing never submits: a submitted line is a paid run (a `/` after leading whitespace is
 * a command too — a slash typo with a stray space must never start a run). `exit`/`quit`/`:q` typed alone
 * do not exit (§22 against A9). `@` mentions on the §10.4 denylist are dropped from `pinnedFiles` and
 * reported in `droppedMentions` (the literal word stays in the text). While a chat request is thinking
 * (`allowCommandsWhileSubmitting`), `/` lines route instead of being dropped: the read-only commands run
 * (`READ_ONLY_WHILE_THINKING`), `/exit` runs (the App cancels the request and exits), `/steer` answers
 * `needs a live run` (a chat request is not a run: the dispatch context carries `run: 'none'`), every other
 * command answers the `one moment — still thinking` toast with the draft kept.
 */
import type { SecretHit, SessionHost } from '../../core/types.js';
import type { OverlayKind } from '../layout.js';
import { dispatchCommand, unknownCommandText, type CommandAction, type DispatchContext } from '../commands/dispatch.js';
import { commandToken, isCommandLine } from '../commands/parse.js';
import { isExactCommand, type CommandSpec } from '../commands/registry.js';
import type { KeyRunPhase } from '../keys/resolve.js';

/** TUI-DESIGN §4.5: the generator sees at most this many characters of a submission (`PROMPT_LIMITS.taskChars`). */
export const TASK_CHARS_LIMIT = 12_000;
/** TUI-DESIGN §10.2: hit spans shorter than this are never handed to `addSecret`. */
export const MIN_SECRET_LENGTH = 8;
/** TUI-DESIGN §24: the notice for an over-long submission. */
export const TRUNCATION_NOTICE = 'notice: only the first 12,000 characters reach the generator; @-mention a file for more';
/** TUI-DESIGN §24: the toast while Enter is held before the host attached. */
export const STARTING_TOAST = 'starting…';
/** TUI-DESIGN-2 §3.1 row 11 / §12 "Status" (the App re-exports it): Enter while a submission is still thinking. */
export const STILL_THINKING_TOAST = 'one moment — still thinking';
/**
 * TUI-DESIGN-3 §4.4 F14: the commands that run while the intake is thinking — read-only, no session side effect. `/exit` is
 * handled apart (it cancels the request and exits); everything else answers `STILL_THINKING_TOAST`.
 */
export const READ_ONLY_WHILE_THINKING: ReadonlySet<string> = new Set(['status', 'cost', 'jev', 'help', 'panel', 'transcript', 'theme']);

/** TUI-DESIGN-3 §4.4 F14: what a resolved command does while a chat request is thinking. */
export function whileThinking(spec: Pick<CommandSpec, 'name'>): 'run' | 'exit' | 'busy' {
  if (spec.name === 'exit') return 'exit';
  return READ_ONLY_WHILE_THINKING.has(spec.name) ? 'run' : 'busy';
}

/** TUI-DESIGN §5.4 / §10.4 / §24: the `[ui]` notice for a denied `@` mention typed in full (the label is added by the item). */
export function deniedMentionNotice(rel: string): string {
  return `${rel} is on the secret denylist; JevCode never reads it. Start with --allow-secret-mention to override.`;
}

/** TUI-DESIGN §4.5: a chip label as it appears in the draft — `[Pasted #n, k lines]` or the history form `[Pasted #n: "…", k lines]`. */
export const CHIP_LABEL_RE = /\[Pasted #(\d+)(?:[:,][^\]]*)?\]/g;

/** TUI-DESIGN §4.5 `expandChips` — labels → bodies in label order; the first label without a body cancels. */
export type ExpandResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly n: number; readonly label: string };

/** TUI-DESIGN §4.5: the default expander over an `n → body` map (O2's `PasteStore` may replace it). */
export function expandChips(text: string, chips: ReadonlyMap<number, string>): ExpandResult {
  let missing: { n: number; label: string } | null = null;
  const out = text.replace(CHIP_LABEL_RE, (label, n: string) => {
    const body = chips.get(Number(n));
    if (body === undefined) {
      missing ??= { n: Number(n), label };
      return label;
    }
    return body;
  });
  if (missing !== null) {
    const m: { n: number; label: string } = missing;
    return { ok: false, n: m.n, label: m.label };
  }
  return { ok: true, text: out };
}

/** TUI-DESIGN §5.4: the `@path` mentions of a draft (spaces escaped as `\ `), workspace-relative, in order, de-duplicated. */
export function mentionedPaths(text: string): string[] {
  const out: string[] = [];
  const re = /(^|[\s(])@((?:\\ |[^\s@])+)/g;
  for (const m of text.matchAll(re)) {
    const raw = (m[2] ?? '').replace(/\\ /g, ' ').replace(/[.,;:!?)]+$/, '');
    if (raw === '' || raw.startsWith('/') || raw.includes('\0')) continue;
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

/** TUI-DESIGN §4.9: what the router needs from the session host (null until `setHost`). */
export type SubmitHost = Pick<SessionHost, 'detectSecrets'>;

/** TUI-DESIGN §4.9: the composer's view at Enter. */
export interface SubmitInput {
  /** the draft with chip labels inline */
  readonly text: string;
  readonly submitting: boolean;
  readonly overlay: OverlayKind;
  /** §15 item 20 `RunPhase` */
  readonly run: KeyRunPhase;
  /** null before `renderer.setHost()` (the ~10 ms after firstFrame()) */
  readonly host: SubmitHost | null;
  /** paste bodies by chip number (§4.5; never in React state) */
  readonly chips: ReadonlyMap<number, string>;
  /** at least one run ended in this session → the submission is a follow-up */
  readonly ranBefore: boolean;
  readonly dispatch: DispatchContext;
  /** override the chip expander (O2's PasteStore) */
  readonly expand?: (text: string) => ExpandResult;
  /**
   * TUI-DESIGN-3 §4.4 F14: a chat request is thinking (`chatThinking(state)`): `/` lines route while `submitting` instead of being
   * dropped — read-only commands run, the rest answer the still-thinking toast (`busy`); text still waits for the reply.
   */
  readonly allowCommandsWhileSubmitting?: boolean;
}

/** TUI-DESIGN §4.9: the routing decision the controller executes. */
export type SubmitDecision =
  | { readonly kind: 'ignore'; readonly reason: 'submitting' | 'empty' | 'run-ending' }
  | { readonly kind: 'newline'; readonly text: string }
  | { readonly kind: 'command'; readonly action: CommandAction; readonly spec: CommandSpec; readonly line: string }
  /** TUI-DESIGN-3 §4.4 F21: `keepDraft` false → the App clears the draft (availability errors have nothing to edit) */
  | { readonly kind: 'error'; readonly text: string; readonly label: '[ui]'; readonly keepDraft: boolean }
  /** TUI-DESIGN-3 §4.4 F14: a command that must wait for the thinking reply — toast, draft kept */
  | { readonly kind: 'busy'; readonly toast: typeof STILL_THINKING_TOAST }
  | { readonly kind: 'chip-missing'; readonly n: number; readonly text: string; readonly label: '[ui]' }
  | { readonly kind: 'hold'; readonly toast: typeof STARTING_TOAST }
  | { readonly kind: 'gate'; readonly full: string; readonly hits: readonly SecretHit[] }
  | { readonly kind: 'steer'; readonly full: string; readonly secretSpans: readonly string[]; readonly notice: string | null; readonly droppedMentions: readonly string[] }
  | { readonly kind: 'submit'; readonly full: string; readonly secretSpans: readonly string[]; readonly pinnedFiles: readonly string[]; readonly droppedMentions: readonly string[]; readonly promptKind: 'prompt' | 'follow-up'; readonly notice: string | null };

/** TUI-DESIGN §4.9 `send`'s view of the session: the run phase, whether a run ended before, the §10.4 denylist. */
export interface SendInput {
  readonly run: KeyRunPhase;
  readonly ranBefore: boolean;
  /** the `@` denylist (`isMentionDenied` bound to the workspace); absent = every mention allowed */
  readonly isDeniedPath?: (rel: string) => boolean;
}

/** TUI-DESIGN §10.2: every hit span ≥ 8 chars, warn-only families included, de-duplicated, in text order. */
export function secretSpans(full: string, hits: readonly SecretHit[]): string[] {
  const out: string[] = [];
  for (const h of [...hits].sort((a, b) => a.start - b.start)) {
    const span = full.slice(Math.max(0, h.start), Math.max(0, h.end));
    if (span.length >= MIN_SECRET_LENGTH && !out.includes(span)) out.push(span);
  }
  return out;
}

/**
 * TUI-DESIGN §4.9 `send` — after the gate (or with no hits): live/starting/pausing → steer, aborting → ignored
 * (the run is ending), otherwise submit. Denied `@` mentions (§10.4) never reach `pinnedFiles`; they are
 * returned as `droppedMentions` so the controller appends `deniedMentionNotice()` per path.
 */
export function routeSend(full: string, hits: readonly SecretHit[], i: SendInput): SubmitDecision {
  const spans = secretSpans(full, hits);
  const notice = full.length > TASK_CHARS_LIMIT ? TRUNCATION_NOTICE : null;
  const mentions = mentionedPaths(full);
  const droppedMentions = i.isDeniedPath === undefined ? [] : mentions.filter((m) => (i.isDeniedPath as (rel: string) => boolean)(m) === true);
  const pinnedFiles = mentions.filter((m) => !droppedMentions.includes(m));
  if (i.run === 'live' || i.run === 'starting' || i.run === 'pausing') return { kind: 'steer', full, secretSpans: spans, notice, droppedMentions };
  if (i.run === 'aborting') return { kind: 'ignore', reason: 'run-ending' };
  return { kind: 'submit', full, secretSpans: spans, pinnedFiles, droppedMentions, promptKind: i.ranBefore ? 'follow-up' : 'prompt', notice };
}

function sendInput(i: SubmitInput): SendInput {
  const denied = i.dispatch.isDeniedPath;
  return { run: i.run, ranBefore: i.ranBefore, ...(denied !== undefined ? { isDeniedPath: denied } : {}) };
}

/**
 * TUI-DESIGN §4.9 `routeSubmit` — `onEnter()` as a pure function:
 * submitting → ignore (unless a chat request is thinking and the line is a command, TUI-DESIGN-3 F14); palette → run only on an
 * exact name/alias match, else the unknown-command item; `/` first (leading whitespace ignored: a slash typo never starts a run,
 * D-log "a submitted line is money") → `dispatchCommand`, fixable errors keep the draft and availability errors clear it (F21);
 * while thinking a resolved command runs only when read-only (`whileThinking`), else `busy`; `//` at column 0 → literal slash
 * prompt; trailing `\` → newline; empty → ignore; missing chip → cancel with `remove [Pasted #N] or paste again`; no host → hold
 * with `starting…`; secret hits → the gate; else `routeSend`.
 */
export function routeSubmit(i: SubmitInput): SubmitDecision {
  const thinking = i.allowCommandsWhileSubmitting === true;
  const lead0 = i.text.trimStart();
  if (i.submitting && !(thinking && (isCommandLine(lead0) || i.overlay === 'palette'))) return { kind: 'ignore', reason: 'submitting' };
  let text = i.text;
  const resolved = (r: ReturnType<typeof dispatchCommand>, line: string): SubmitDecision => {
    if (!r.ok) return { kind: 'error', text: r.text, label: '[ui]', keepDraft: r.keepDraft };
    if (thinking && whileThinking(r.spec) === 'busy') return { kind: 'busy', toast: STILL_THINKING_TOAST };
    return { kind: 'command', action: r.action, spec: r.spec, line };
  };
  if (i.overlay === 'palette') {
    const token = commandToken(text.trimStart());
    if (token === '' || !isExactCommand(token)) return { kind: 'error', text: unknownCommandText(token === '' ? text.trim().split(/\s+/)[0] ?? '/' : token), label: '[ui]', keepDraft: true };
    return resolved(dispatchCommand(text.trimStart(), i.dispatch), text.trim());
  }
  if (/(^|[^\\])\\$/.test(text)) return { kind: 'newline', text: text.slice(0, -1) };
  const lead = text.trimStart();
  if (isCommandLine(lead)) return resolved(dispatchCommand(lead, i.dispatch), text.trim());
  if (text.startsWith('//')) text = text.slice(1); // literal slash-leading prompt
  if (text.trim() === '') return { kind: 'ignore', reason: 'empty' };
  const expanded = (i.expand ?? ((t: string) => expandChips(t, i.chips)))(text);
  if (!expanded.ok) return { kind: 'chip-missing', n: expanded.n, text: `remove [Pasted #${expanded.n}] or paste again`, label: '[ui]' };
  const full = expanded.text;
  if (i.host === null) return { kind: 'hold', toast: STARTING_TOAST };
  const hits = i.host.detectSecrets(full);
  if (hits.length > 0) return { kind: 'gate', full, hits };
  return routeSend(full, [], sendInput(i));
}
