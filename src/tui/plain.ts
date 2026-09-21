/**
 * Plain (non-Ink) renderer plus the transcript-item model shared by the TUI's <Static>
 * pane, the plain renderer and the engine's transcript.log (DESIGN.md §10, TUI-DESIGN §15.1).
 * `itemsFromEvent` is the single item source: transcript.log, `--plain` and the TUI stay
 * line-for-line identical for the whole of a run. This module is ink-free (Node built-ins and
 * pure `lines()` modules only) so the engine can import `itemsFromEvent` / `formatTranscriptItem`
 * without pulling in ink/react.
 */
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import type {
  Action,
  ActionOutcome,
  ConfirmOutcome,
  Confirmer,
  ConfirmRequest,
  Engine,
  EngineEvent,
  JudgeResult,
  NoticeKind,
  Renderer,
  RendererOptions,
  SecretHit,
  SessionHost,
  UiConfig,
  UiLabel,
} from '../core/types.js';
import { AbortError } from '../errors.js';
import { clip, firstLine } from '../core/text.js';
import { formatDuration } from '../core/time.js';
import { MIN_SECRET_LENGTH, detectSecrets as detectSecretsByPattern, patternRedact } from '../core/redact.js';
import { gitBannerLine, headDriftWarning, headMoved } from '../workspace/gitstate.js';
import { budgetItems } from './budget/lines.js';
// TUI-DESIGN §14.1 / §24: `--ascii` substitutes the glyph table on stdout only (glyphs.ts imports plain.ts's hoisted `sanitizeStream`; the cycle is safe: both use the other inside functions)
import { glyphSet, glyphTwin, type GlyphSet } from './glyphs.js';
import { RETRY_SLOW_MS, blockingRowsStructured } from './blocking/lines.js';
import { REVIEW_KEYS_80, reviewHeaderLines } from './review/lines.js';
import { gatePlainPrompt, secretAckText } from './secrets/gate-lines.js';

// ---------------------------------------------------------------------------------------
// Transcript items
// ---------------------------------------------------------------------------------------

export type TranscriptKind =
  | 'run:start'
  | 'run:ready'
  | 'intent'
  | 'context'
  | 'synth'
  | 'proposal'
  | 'risk'
  | 'confirm:resolved'
  | 'outcome'
  | 'judge'
  | 'plan'
  | 'loop:tripped'
  | 'replan'
  | 'transcript'
  | 'error'
  | 'run:end'
  // contract 1.1 (TUI-DESIGN §15 item 19): the engine items of §15.1's item table
  | 'steer:queued'
  | 'steer:applied'
  | 'steer:withdrawn'
  | 'pause'
  | 'budget'
  | 'retry'
  | 'notice'
  | 'workspace'
  | 'blocking'
  | 'secret-ack'
  | 'ui';

export type TranscriptLevel = 'info' | 'warn' | 'error';

/** One immutable transcript row. `text` is one logical line; `detail` is a TUI-only body (scrollback). */
export interface TranscriptItem {
  readonly key: string;
  readonly seq: number;
  readonly step: number | null;
  readonly kind: TranscriptKind;
  readonly level: TranscriptLevel;
  readonly text: string;
  /** risk items carry the verdict so the TUI colours them like the decisions pane */
  readonly verdict?: 'ok' | 'review' | 'block';
  /** multi-line body shown under the line in the TUI only (never in plain / transcript.log) */
  readonly detail?: string;
  /** TUI-DESIGN §15 item 19 / §15.1: a renderer-local item (no engine live): printed by --plain and the TUI, never in transcript.log */
  readonly local?: boolean;
  /** TUI-DESIGN §15 item 19 / §15.1: printed instead of stepLabel(); only notice kind 'ui' and local items set it */
  readonly label?: UiLabel;
}

/** Caps keeping every transcript line bounded no matter what the generator or a command emits. */
export const TRANSCRIPT_TEXT_MAX = 600;
export const TRANSCRIPT_DETAIL_MAX_LINES = 60;
export const TRANSCRIPT_DETAIL_MAX_CHARS = 6000;
const TASK_MAX = 160;
const LIST_MAX = 5;

// C0 (minus \t \n \r), DEL and C1: everything a terminal could read as an escape or control sequence.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/**
 * Drop control characters but keep line structure (\t, \n, \r). Applied to raw generator deltas
 * and command output before they reach any terminal, so an escape sequence produced by a command
 * or by the generator cannot clear the screen, move the cursor or write the clipboard.
 */
export function sanitizeStream(s: string): string {
  return s.replace(CONTROL_RE, '');
}

/** Collapse a string onto one line and drop control characters (a command's escape codes must never reach the terminal raw). */
export function oneLine(s: string): string {
  return sanitizeStream(s.replace(/\r\n|\r|\n/g, ' ⏎ ').replace(/\t/g, ' '));
}

export function p2(x: number): string {
  return Number.isFinite(x) ? x.toFixed(2) : 'nan';
}
export function usd(x: number): string {
  return Number.isFinite(x) ? `$${x.toFixed(3)}` : '$nan';
}
export function kTokens(n: number): string {
  if (!Number.isFinite(n)) return 'nan';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function stepLabel(step: number | null): string {
  return step === null ? '[run]' : `[step ${step}]`;
}

export interface ActionDescription {
  kind: Action['kind'];
  /** path, command, paths or summary: what the action touches */
  target: string;
  /** the body a reviewer wants to see (old/new, content, diff, command); '' for read */
  preview: string;
}

export function describeAction(a: Action): ActionDescription {
  switch (a.kind) {
    case 'read':
      return { kind: a.kind, target: a.paths.slice(0, LIST_MAX).join(', ') + (a.paths.length > LIST_MAX ? ` (+${a.paths.length - LIST_MAX})` : ''), preview: '' };
    case 'edit':
      return { kind: a.kind, target: a.path, preview: `--- old\n${a.old}\n+++ new\n${a.new}` };
    case 'write':
      return { kind: a.kind, target: a.path, preview: a.content };
    case 'patch': {
      const lines = a.diff.split('\n').length;
      return { kind: a.kind, target: `${lines} line unified diff`, preview: a.diff };
    }
    case 'run':
      return { kind: a.kind, target: `$ ${firstLine(a.command)}`, preview: a.command };
    case 'done':
      return { kind: a.kind, target: firstLine(a.summary), preview: a.summary };
  }
}

export function actionLabel(a: Action): string {
  const d = describeAction(a);
  return clip(oneLine(`${d.kind} ${d.target}`), 200);
}

/** Bounded, terminal-safe multi-line detail (TUI scrollback body and the readline confirmer's preview). */
export function clipDetail(s: string): string {
  const lines = sanitizeStream(s.replace(/\r\n|\r/g, '\n')).split('\n');
  let out = lines.length > TRANSCRIPT_DETAIL_MAX_LINES ? `${lines.slice(0, TRANSCRIPT_DETAIL_MAX_LINES).join('\n')}\n…[${lines.length - TRANSCRIPT_DETAIL_MAX_LINES} lines omitted]` : lines.join('\n');
  if (out.length > TRANSCRIPT_DETAIL_MAX_CHARS) out = `${out.slice(0, TRANSCRIPT_DETAIL_MAX_CHARS)}…`;
  return out;
}

function outcomeText(o: ActionOutcome): { text: string; level: TranscriptLevel } {
  switch (o.status) {
    case 'executed': {
      const parts = [`outcome executed: ${o.summary}`];
      if (o.exec) {
        const flags = [`exit ${o.exec.exitCode ?? 'null'}`];
        if (o.exec.killedBy) flags.push(`killed by ${o.exec.killedBy}`);
        if (o.exec.truncated) flags.push('output truncated');
        if (o.exec.orphans.length > 0) flags.push(`${o.exec.orphans.length} orphan pid(s)`);
        flags.push(formatDuration(o.exec.durationMs));
        parts.push(`(${flags.join(', ')})`);
      }
      if (o.changedFiles.length > 0) parts.push(`changed=${o.changedFiles.length}: ${o.changedFiles.slice(0, LIST_MAX).join(', ')}`);
      return { text: parts.join(' '), level: o.exec && !o.exec.ok ? 'warn' : 'info' };
    }
    case 'noop':
      return { text: `outcome noop: ${o.summary}`, level: 'info' };
    case 'blocked':
      return { text: `outcome blocked: ${o.reason}`, level: 'warn' };
    case 'declined':
      return { text: `outcome declined: ${o.reason}`, level: 'warn' };
    case 'failed':
      return { text: `outcome failed: ${o.error}`, level: 'warn' };
    case 'interrupted':
      return { text: `outcome interrupted${o.exec?.signal ? ` (signal ${o.exec.signal})` : ''}`, level: 'warn' };
  }
}

function judgeText(judge: JudgeResult | null, completion: number | null): string {
  const c = completion === null ? 'n/a' : p2(completion);
  if (judge === null) return `judge skipped completion=${c}`;
  let tests = 'none';
  if (judge.tests) {
    tests =
      judge.tests.source === 'parsed'
        ? `${judge.tests.passed}p/${judge.tests.failed}f/${judge.tests.errors}e ${judge.tests.allPassed ? 'pass' : 'fail'}`
        : `judged all_passed=${p2(judge.tests.allPassed)}`;
  }
  const accepted = judge.doneClaims.filter((d) => d.accepted).length;
  return `judge succeeded=${p2(judge.succeeded)} error_present=${p2(judge.errorPresent)} new_info=${p2(judge.newInfo)} tests=${tests} claims=${accepted}/${judge.doneClaims.length} completion=${c}`;
}

function quoteList(xs: readonly string[]): string {
  return xs
    .slice(0, LIST_MAX)
    .map((x) => `"${clip(oneLine(x), 80)}"`)
    .join('; ');
}

/** One line per `synth` event (jev-only): `synth <phase>: <detail> (candidates=…, tested=…)`, counts only when present. */
export function synthText(e: Extract<EngineEvent, { type: 'synth' }>): string {
  const counts: string[] = [];
  if (e.candidates !== undefined) counts.push(`candidates=${e.candidates}`);
  if (e.tested !== undefined) counts.push(`tested=${e.tested}`);
  return `synth ${e.phase}: ${e.detail}${counts.length > 0 ? ` (${counts.join(', ')})` : ''}`;
}

/** TUI-DESIGN §24: `steer queued (N) for step S: <text>` — N is the queue length after this steer. */
export function steerQueuedText(e: Extract<EngineEvent, { type: 'steer:queued' }>): string {
  return `steer queued (${e.queued}) for step ${e.step}: ${e.text}`;
}

/** TUI-DESIGN §24: `steer applied to step S (N directives; superseded: <text ≤ 80>)`; the superseded clause only when something was. */
export function steerAppliedText(e: Extract<EngineEvent, { type: 'steer:applied' }>): string {
  const n = `${e.count} directive${e.count === 1 ? '' : 's'}`;
  const superseded = e.superseded.length > 0 ? `; superseded: ${e.superseded.map((s) => `"${clip(oneLine(s), 80)}"`).join(', ')}` : '';
  return `steer applied to step ${e.step} (${n}${superseded})`;
}

/**
 * TUI-DESIGN §13.1 / §15.1: the one `warning:` line a retry chain earns when it failed or lasted longer than
 * `RETRY_SLOW_MS` — `warning: <side> retry chain: N attempts over Ts — <short>`; null otherwise (a quick recovery is pane-only).
 */
export function retrySettledText(e: Extract<EngineEvent, { type: 'retry:settled' }>): string | null {
  if (e.ok && e.totalWaitMs <= RETRY_SLOW_MS) return null;
  const attempts = `${e.attempts} attempt${e.attempts === 1 ? '' : 's'}`;
  const short = e.ok ? 'recovered' : 'gave up';
  return `warning: ${e.side} retry chain: ${attempts} over ${formatDuration(Math.max(0, e.totalWaitMs))} — ${short}`;
}

/** TUI-DESIGN §13.3 / §24: the blocking pane's reason row as the transcript item (the keys stay in the pane). */
export function blockingRequestText(e: Extract<EngineEvent, { type: 'blocking:request' }>): string {
  return `blocking: ${blockingRowsStructured(e.request).title.join(' · ')}`;
}

/** TUI-DESIGN §13.3: `blocking <id> resolved: <answer>` (` (auto)` when the jev-unreachable timer answered). */
export function blockingResolvedText(e: Extract<EngineEvent, { type: 'blocking:resolved' }>): string {
  return `blocking ${e.id} resolved: ${e.answer}${e.auto ? ' (auto)' : ''}`;
}

/**
 * TUI-DESIGN §24 "Engine items": the notice kinds whose `text` is already the documented line (`[run] seeded from run <id>: …`,
 * `checkpoint degraded: <code> on <file>`, `resumed on <oid8>, run started on <oid8> — …`, `run <id> is in use by pid …`, the
 * offline/online, sandbox, instructions, config and pricing sentences); they print bare. `ui` is labelled by `annotate()`.
 */
export const BARE_NOTICE_KINDS: ReadonlySet<NoticeKind> = new Set<NoticeKind>(['offline', 'online', 'checkpoint:degraded', 'checkpoint:restored', 'sandbox', 'drift', 'seeded', 'instructions', 'config', 'pricing', 'lock']);

/**
 * Transcript items for one engine event (0, 1 or a few; kinds per §10 and TUI-DESIGN §15.1's item table).
 * `seq` is the caller's monotonic counter for the first item produced; keys are `${step}:${kind}:${seq + i}`.
 * Events that feed the panes only (decision, status, stage:*, deltas, exec:output, retry, checkpoint, ...) yield [].
 */
export function itemsFromEvent(e: EngineEvent, seq: number): TranscriptItem[] {
  let n = 0;
  const one = (step: number | null, kind: TranscriptKind, text: string, level: TranscriptLevel = 'info', extra: { verdict?: 'ok' | 'review' | 'block'; detail?: string; label?: UiLabel } = {}): TranscriptItem => {
    const s = seq + n;
    n += 1;
    return {
      key: `${step ?? 'run'}:${kind}:${s}`,
      seq: s,
      step,
      kind,
      level,
      text: clip(oneLine(text), TRANSCRIPT_TEXT_MAX),
      ...(extra.verdict ? { verdict: extra.verdict } : {}),
      ...(extra.detail ? { detail: extra.detail } : {}),
      ...(extra.label ? { label: extra.label } : {}),
    };
  };
  const make = (step: number | null, kind: TranscriptKind, text: string, level: TranscriptLevel = 'info', extra: { verdict?: 'ok' | 'review' | 'block'; detail?: string; label?: UiLabel } = {}): TranscriptItem[] => [one(step, kind, text, level, extra)];
  switch (e.type) {
    case 'run:start':
      return make(null, 'run:start', `start ${e.runId} mode=${e.mode}${e.resumedFromStep !== null ? ` resumed from step ${e.resumedFromStep}` : ''} task: ${clip(oneLine(e.task), TASK_MAX)}`);
    case 'run:ready':
      return make(null, 'run:ready', `ready ${e.runId} step ${e.step}/${e.maxSteps}${e.resumed ? ' (resumed)' : ''}`);
    case 'intent':
      return make(e.step, 'intent', `intent=${e.intent} p=${p2(e.probability)} c=${p2(e.confidence)}${e.answer !== e.intent ? ` (jev answered ${e.answer})` : ''}`);
    case 'context':
      return make(e.step, 'context', `context ${e.files.length} files ${kTokens(e.bytes)}B of ${e.candidates} candidates: ${e.files.slice(0, LIST_MAX).join(', ')}${e.files.length > LIST_MAX ? ` (+${e.files.length - LIST_MAX})` : ''}`);
    case 'synth':
      // jev-only synthesizer progress: one line per event, so it lands in transcript.log like every other item
      return make(e.step, 'synth', synthText(e));
    case 'proposal': {
      const d = describeAction(e.proposal.action);
      const plan = e.proposal.plan;
      const text = `proposal ${d.kind} ${d.target}: ${e.proposal.goal} | plan done=${plan.done.length} remaining=${plan.remaining.length} open=${plan.openProblems.length}`;
      return make(e.step, 'proposal', text, 'info', d.preview ? { detail: clipDetail(d.preview) } : {});
    }
    case 'risk':
      return make(e.step, 'risk', `risk=${p2(e.risk.risk)} ${e.risk.verdict}: ${e.risk.reason}`, e.risk.verdict === 'block' ? 'warn' : 'info', { verdict: e.risk.verdict });
    case 'confirm:resolved':
      // TUI-DESIGN §6.4 / §24: `confirm <id> declined (note: <note>)` when the reviewer left a `d` note
      return make(e.step, 'confirm:resolved', `confirm ${e.id} ${e.aborted ? 'aborted' : e.approved ? 'approved' : 'declined'}${e.note ? ` (note: ${e.note})` : ''}`, e.aborted ? 'warn' : 'info');
    case 'outcome': {
      const o = outcomeText(e.outcome);
      return make(e.step, 'outcome', o.text, o.level);
    }
    case 'judge':
      return make(e.step, 'judge', judgeText(e.judge, e.completion));
    case 'plan': {
      const p = e.plan;
      let text = `plan done=${p.done.length} remaining=${p.remaining.length} unverified=${p.unverified.length} problems=${p.openProblems.length + p.harnessProblems.length}`;
      if (e.rejectedDone.length > 0) text += ` rejected: ${quoteList(e.rejectedDone)}`;
      if (e.unverifiedDone.length > 0) text += ` unverified: ${quoteList(e.unverifiedDone)}`;
      return make(e.step, 'plan', text, e.rejectedDone.length > 0 ? 'warn' : 'info');
    }
    case 'loop:tripped':
      return make(e.step, 'loop:tripped', `loop tripped: ${e.signature} x${e.occurrences}`, 'warn');
    case 'replan':
      return make(e.step, 'replan', `replan ${e.directive.move} p=${p2(e.directive.probability)} c=${p2(e.directive.confidence)} impossible=${p2(e.directive.taskImpossible)}: ${e.directive.text}`, 'warn');
    case 'transcript':
      return make(e.step, 'transcript', e.level === 'info' ? e.text : `${e.level}: ${e.text}`, e.level);
    case 'error':
      return make(e.step, 'error', `error ${e.error.code}: ${e.error.message}${e.fatal ? ' (fatal)' : ''}`, 'error');
    case 'notice':
      // contract 1.1 (TUI-DESIGN §15.1 / §24 "Engine items"): a labelled notice (Engine.annotate) prints `<label> <text>`; the engine's own
      // kinds already emit self-describing texts (`seeded from run …`, `checkpoint degraded: …`, `run <id> is in use …`) and print bare;
      // `notice <kind>: <text>` is the fallback for a kind that does not describe itself (an unlabelled `ui`, or one from a newer engine)
      return make(e.step, 'notice', e.label || BARE_NOTICE_KINDS.has(e.kind) ? e.text : `notice ${e.kind}: ${e.text}`, e.level, { ...(e.detail ? { detail: clipDetail(e.detail) } : {}), ...(e.label ? { label: e.label } : {}) });
    // --- TUI-DESIGN §15.1 item table: the contract 1.1 engine items (§24 "Engine items" strings) ---------------------
    case 'steer:queued':
      return make(e.step, 'steer:queued', steerQueuedText(e));
    case 'steer:applied':
      return make(e.step, 'steer:applied', steerAppliedText(e));
    case 'steer:withdrawn':
      return make(e.step, 'steer:withdrawn', `steer withdrawn (${e.index})`);
    case 'pause:requested':
      return make(e.step, 'pause', `pause requested: stopping after step ${e.step}`);
    case 'budget:warn':
      // TUI-DESIGN §9.2 / §24: `[run] budget: …` through the shared money lines; 80 % and 95 % are warnings, 50 % is information
      return budgetItems(e).map((text) => one(null, 'budget', text, e.pct >= 80 ? 'warn' : 'info'));
    case 'budget:stop':
    case 'budget:unpriced':
      return budgetItems(e).map((text) => one(null, 'budget', text, 'warn'));
    case 'budget:clamp':
    case 'budget:override':
      return budgetItems(e).map((text) => one(null, 'budget', text, 'info'));
    case 'retry:settled': {
      // TUI-DESIGN §13.1 / §15.1: one `warning:` line only when the chain failed or lasted > 10 s
      const text = retrySettledText(e);
      return text === null ? [] : make(e.step, 'retry', text, 'warn');
    }
    case 'workspace': {
      // TUI-DESIGN §12.2 / §24: `[run] git <banner>`, `[run] instructions: <path> (<bytes>, sha256 <8>)`, the P52 HEAD-drift warning on resume
      const banner = gitBannerLine(e.git);
      const items = [one(null, 'workspace', banner.text, banner.level)];
      for (const i of e.instructions) items.push(one(null, 'workspace', `instructions: ${i.path} (${i.bytes}, sha256 ${i.sha256.slice(0, 8)})`));
      if (e.git.resumedOn !== undefined && headMoved(e.git.head, e.git.resumedOn)) items.push(one(null, 'workspace', headDriftWarning(e.git.head, e.git.resumedOn), 'warn'));
      return items;
    }
    case 'blocking:request':
      return make(e.request.step, 'blocking', blockingRequestText(e), 'error');
    case 'blocking:resolved':
      return make(null, 'blocking', blockingResolvedText(e));
    case 'secret-ack':
      // TUI-DESIGN §10.2 / §24: `[step n] sent K secret(s) to the generator on request` (`[run]` before step 1); count only, never a value
      return make(e.step, 'secret-ack', secretAckText(e.count));
    case 'run:end': {
      const r = e.result;
      return make(
        null,
        'run:end',
        // TUI-DESIGN §13.5: the run:end item carries the exit code when the engine reports one
        `end ${r.stopReason} steps=${r.steps} wall=${formatDuration(r.wallMs)} cost=${usd(r.usage.generator.costUsd + r.usage.jev.costUsd)} (gen ${usd(r.usage.generator.costUsd)}, jev ${usd(r.usage.jev.costUsd)})${r.error ? ` error=${r.error.code}: ${r.error.message}` : ''}${e.exitCode !== undefined ? ` exit ${e.exitCode}` : ''}`,
        r.stopReason === 'complete' ? 'info' : r.stopReason === 'error' ? 'error' : 'warn',
      );
    }
    default:
      return [];
  }
}

/** The one-line form written to transcript.log, by the plain renderer and by the TUI's <Static> rows. A `label` (TUI-DESIGN §15.1) replaces the step label. */
export function formatTranscriptItem(item: TranscriptItem): string {
  return `${item.label ?? stepLabel(item.step)} ${item.text}`;
}

/**
 * TUI-DESIGN §15.1: a renderer-local item while no engine is live (the recent-session row, the sandbox line,
 * idle help, `[ui] error:` for idle commands, …): printed by `--plain` and the TUI, carried by `--json` as a
 * `ui` line, never in any transcript.log. `seq` is the renderer's own counter; keys never collide with event items.
 */
export function localItem(text: string, seq: number, opts: { label?: UiLabel; level?: TranscriptLevel; detail?: string } = {}): TranscriptItem {
  const label = opts.label ?? '[ui]';
  return {
    key: `local:${label}:${seq}`,
    seq,
    step: null,
    kind: 'ui',
    level: opts.level ?? 'info',
    text: clip(oneLine(text), TRANSCRIPT_TEXT_MAX),
    local: true,
    label,
    ...(opts.detail ? { detail: clipDetail(opts.detail) } : {}),
  };
}

// ---------------------------------------------------------------------------------------
// Confirmation summary (shared by the Ink box and the readline prompt)
// ---------------------------------------------------------------------------------------

/** TUI-DESIGN §6.1 / §15.2: the full review header is 8 rows (was 6); the layout budget subtracts exactly this. */
export const CONFIRM_HEADER_ROWS = 8;
/** The width the shared header is cut to for the readline twin and the legacy Ink box (§6.1 "full header at 80 columns"). */
export const CONFIRM_HEADER_COLUMNS = 80;
/** TUI-DESIGN §6.1 row 2 (§24 "Review box" keys): what the TUI header shows. */
export const CONFIRM_KEYS_LINE = REVIEW_KEYS_80;
/** TUI-DESIGN §6.5: the readline confirmer's prompt keys (`d <note>` on the same line). */
export const READLINE_CONFIRM_KEYS = '[y] approve  [n] decline  [d] decline+note';
/** TUI-DESIGN §6.4: a decline note is one line of at most this many characters. */
export const CONFIRM_NOTE_MAX = 600;
/** TUI-DESIGN §24: the note prompt of the readline twin (Enter on an empty line cancels the note). */
export const READLINE_NOTE_PROMPT = 'note (≤ 600, Enter sends, empty cancels): ';

/** TUI-DESIGN §6.1 / §15.2: exactly CONFIRM_HEADER_ROWS rows — `reviewHeaderLines(req, 8, 80)`, the one shared header. */
export function confirmHeaderLines(req: ConfirmRequest): string[] {
  return reviewHeaderLines(req, CONFIRM_HEADER_ROWS, CONFIRM_HEADER_COLUMNS);
}

/** Preview body lines (old/new, content, diff, command); '' preview yields []. */
export function confirmPreviewLines(req: ConfirmRequest): string[] {
  const d = describeAction(req.proposal.action);
  if (d.preview === '') return [];
  return clipDetail(d.preview).split('\n');
}

// ---------------------------------------------------------------------------------------
// Readline confirmer
// ---------------------------------------------------------------------------------------

/** TUI-DESIGN §6.4 / §10.7: what the `d` note's gate needs from the session host; absent → pattern-only detection and `patternRedact`. */
export type NoteGate = Pick<SessionHost, 'detectSecrets' | 'addSecret' | 'redact'>;

/**
 * TUI-DESIGN §1 / §6.5 / §14.2: one `node:readline` interface per stdin. On a `--plain` TTY the readline composer
 * (`plain-composer.ts`) owns it and lends its `'line'` stream through this shape; the confirmer borrows the lines
 * for one review and detaches — it never creates a second interface over the same stream, never calls `rl.close()`
 * (which pauses the shared input) and never `input.pause()`s. `closed` is the EOF fact (a review that arrives
 * after EOF declines at once; nobody can answer it).
 */
export interface LineSource {
  /** every line until the returned release runs; the owner swallows them meanwhile (and shows no prompt) */
  onLine(fn: (line: string) => void): () => void;
  /** EOF on the shared stream (the owner's readline `close`); returns the detach */
  onClose(fn: () => void): () => void;
  /** true once EOF was seen */
  readonly closed: boolean;
}

export interface ReadlineConfirmerOptions {
  /** readline SIGINT while a question is pending (only fires in terminal mode; kept for completeness) */
  onAbort: (reason: 'signal') => void;
  /** non-interactive: decline after this many ms (default 0) */
  confirmTimeoutMs?: number;
  /** rows of preview printed before the question (default 20) */
  previewRows?: number;
  /** TUI-DESIGN §6.4: the note gate, read at question time (the host attaches after the first frame) */
  host?: () => NoteGate | null;
  /**
   * TUI-DESIGN §1 (C46): whether a human can answer at all. Default `Boolean(stdin.isTTY)`; wave 3 passes
   * `!flags.noInput && !isInCi && TERM !== 'dumb'` so `--no-input`, `CI` and `TERM=dumb` on a TTY take the safe
   * default (decline after `confirmTimeoutMs`) without reading a byte.
   */
  interactive?: boolean;
  /**
   * TUI-DESIGN §1 / §6.5: the shared stdin's line source (the readline composer's `lines`), read at question time.
   * Absent or null → the confirmer creates one interface of its own, once, and keeps it for its whole lifetime.
   */
  lines?: () => LineSource | null;
  /** TUI-DESIGN §14.1: the glyph table for stdout (`--ascii`); default unicode */
  glyphs?: GlyphSet;
}

export const READLINE_MAX_PROMPTS = 5;
export const IDENTITY_REVIEWER = 'reviewer';
export const IDENTITY_NO_TTY = 'no reviewer (stdin not a TTY)';
/** TUI-DESIGN §1: a TTY stdin the launch made non-interactive (`--no-input`, `CI`, `TERM=dumb`) */
export const IDENTITY_NO_INPUT = 'no reviewer (non-interactive)';

function abortErrorFrom(signal: AbortSignal): AbortError {
  return signal.reason instanceof AbortError ? signal.reason : new AbortError('signal');
}

/** Minimal stream shapes so tests can pass PassThrough streams. */
export type ConfirmInput = NodeJS.ReadableStream & { isTTY?: boolean };
export type ConfirmOutput = NodeJS.WritableStream;

/** TUI-DESIGN §6.4: `sanitizeStream → oneLine → clip 600` — the note's shape before the gate and the redactor. */
export function normaliseNote(raw: string): string {
  return clip(oneLine(sanitizeStream(raw)).trim(), CONFIRM_NOTE_MAX);
}

/** TUI-DESIGN §10.2: every hit span ≥ 8 chars, de-duplicated, in text order — what `y` hands to `addSecret`. */
function hitSpans(text: string, hits: readonly SecretHit[]): string[] {
  const out: string[] = [];
  for (const h of [...hits].sort((a, b) => a.start - b.start)) {
    const span = text.slice(Math.max(0, h.start), Math.max(0, h.end));
    if (span.length >= MIN_SECRET_LENGTH && !out.includes(span)) out.push(span);
  }
  return out;
}

/**
 * A `LineSource` over one `node:readline` interface that lives as long as its owner: listeners attach and detach
 * per question, the interface is never closed by a question (TUI-DESIGN §1: one interface per stdin).
 */
function ownLineSource(stdin: ConfirmInput, stdout: ConfirmOutput): LineSource {
  const lineFns = new Set<(line: string) => void>();
  const closeFns = new Set<() => void>();
  let closed = false;
  const rl = createInterface({ input: stdin, output: stdout, terminal: false });
  rl.on('line', (line: string) => {
    for (const fn of [...lineFns]) fn(line);
  });
  rl.on('close', () => {
    closed = true;
    for (const fn of [...closeFns]) fn();
  });
  return {
    onLine(fn) {
      lineFns.add(fn);
      return () => lineFns.delete(fn);
    },
    onClose(fn) {
      closeFns.add(fn);
      return () => closeFns.delete(fn);
    },
    get closed() {
      return closed;
    },
  };
}

/**
 * y/n/d on TTY stdin through `node:readline` with `terminal: false`, so the kernel keeps
 * delivering SIGINT on Ctrl-C (raw mode is never enabled) and the process handler runs the
 * §14.2 matrix. TUI-DESIGN §6.5: the 8 header lines and ≤ 20 preview rows, then
 * `[step N] [y] approve  [n] decline  [d] decline+note > `; `d <note>` on the same line (or `d`
 * then the note on its own line) declines with a note that passes the §6.4 gate → redact → clip;
 * five invalid answers decline (a cancelled note or gate is not an invalid answer).
 * `confirmDetailed` returns the `ConfirmOutcome`; `confirm` is its boolean view. A non-interactive
 * launch (no TTY, `--no-input`, `CI`, `TERM=dumb`) declines after `confirmTimeoutMs`. Never auto-approves.
 * The lines come from `opts.lines()` (the composer's shared readline) or from one interface of its own.
 */
export function createReadlineConfirmer(stdin: ConfirmInput, stdout: ConfirmOutput, opts: ReadlineConfirmerOptions): Confirmer & { confirmDetailed(req: ConfirmRequest, o: { signal: AbortSignal }): Promise<ConfirmOutcome> } {
  const tty = Boolean(stdin.isTTY);
  // TUI-DESIGN §1 (C46): `--no-input`/`CI`/`TERM=dumb` on a TTY are non-interactive too
  const interactive = opts.interactive ?? tty;
  const timeoutMs = Math.max(0, opts.confirmTimeoutMs ?? 0);
  const previewRows = Math.max(0, opts.previewRows ?? 20);
  const identity = interactive ? IDENTITY_REVIEWER : tty ? IDENTITY_NO_INPUT : IDENTITY_NO_TTY;
  const glyphs = opts.glyphs ?? glyphSet();
  let secretSeq = 0;
  let own: LineSource | null = null;
  // TUI-DESIGN §14.1: every stdout write passes the glyph twin (`--ascii`); the strings themselves stay canonical
  const write = (s: string): void => {
    stdout.write(glyphTwin(s, glyphs));
  };
  const source = (): LineSource => {
    const shared = opts.lines?.() ?? null;
    if (shared !== null) return shared;
    own ??= ownLineSource(stdin, stdout);
    return own;
  };

  function printRequest(req: ConfirmRequest): void {
    const lines = confirmHeaderLines(req);
    const preview = confirmPreviewLines(req);
    const shown = preview.slice(0, previewRows);
    const body = [...lines.map((l) => `${stepLabel(req.step)} ${l}`), ...shown.map((l) => `  ${l}`)];
    if (preview.length > shown.length) body.push(`  …[${preview.length - shown.length} preview lines omitted]`);
    write(`${body.join('\n')}\n`);
  }

  function declineAfterTimeout(req: ConfirmRequest, signal: AbortSignal): Promise<ConfirmOutcome> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        write(`${stepLabel(req.step)} confirm ${req.id} declined: ${identity}\n`);
        resolve({ approved: false });
      }, timeoutMs);
      const onAbort = (): void => {
        clearTimeout(t);
        reject(abortErrorFrom(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function ask(req: ConfirmRequest, signal: AbortSignal): Promise<ConfirmOutcome> {
    return new Promise((resolve, reject) => {
      const src = source();
      const label = stepLabel(req.step);
      if (src.closed) {
        // EOF already happened: nobody can approve, so decline (never auto-approve)
        write(`${label} confirm ${req.id} declined: stdin closed\n`);
        resolve({ approved: false });
        return;
      }
      let invalid = 0;
      let settled = false;
      // TUI-DESIGN §6.5: `keys` awaits y/n/d; `note` awaits the note line after a bare `d`; `gate` awaits the §4.10 y/N for a note with a secret
      let mode: { kind: 'keys' } | { kind: 'note' } | { kind: 'gate'; note: string; hits: readonly SecretHit[] } = { kind: 'keys' };
      let detachLine: () => void = () => undefined;
      let detachClose: () => void = () => undefined;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        // detach only: the interface belongs to its owner and stays open for the next line (§1: one interface per stdin)
        detachLine();
        detachClose();
        fn();
      };
      const onAbort = (): void => finish(() => reject(abortErrorFrom(signal)));
      /** TUI-DESIGN §6.5: re-show the keys prompt (a cancelled note/gate comes back here without counting as an invalid answer) */
      const showKeys = (): void => {
        mode = { kind: 'keys' };
        write(`${label} ${READLINE_CONFIRM_KEYS} > `);
      };
      /** TUI-DESIGN §6.5: only a genuinely invalid keys-mode line counts; the fifth declines */
      const invalidAnswer = (): void => {
        invalid += 1;
        if (invalid >= READLINE_MAX_PROMPTS) {
          write(`${label} confirm ${req.id} declined: no valid answer after ${invalid} prompts\n`);
          finish(() => resolve({ approved: false }));
          return;
        }
        showKeys();
      };
      const declineWith = (note: string): void => {
        const gate = opts.host?.() ?? null;
        const redacted = normaliseNote(gate ? gate.redact(note) : patternRedact(note));
        finish(() => resolve(redacted.length > 0 ? { approved: false, note: redacted } : { approved: false }));
      };
      const takeNote = (raw: string): void => {
        const note = normaliseNote(raw);
        if (note.length === 0) {
          // an empty note cancels back to the keys prompt (§24 "empty cancels"); not an invalid answer
          showKeys();
          return;
        }
        // TUI-DESIGN §6.4 / §10.7: the note passes the gate before it reaches the engine
        const gate = opts.host?.() ?? null;
        const hits = gate ? gate.detectSecrets(note) : detectSecretsByPattern(note);
        if (hits.length === 0) {
          declineWith(note);
          return;
        }
        mode = { kind: 'gate', note, hits };
        write(`${label} ${gatePlainPrompt(hits)} `);
      };
      const onLine = (line: string): void => {
        if (settled) return;
        if (mode.kind === 'note') {
          takeNote(line);
          return;
        }
        if (mode.kind === 'gate') {
          const a = line.trim().toLowerCase();
          if (a === 'y' || a === 'yes') {
            // TUI-DESIGN §10.2: `y` → addSecret for every hit span ≥ 8 chars before the note leaves the confirmer
            const gate = opts.host?.() ?? null;
            if (gate) for (const span of hitSpans(mode.note, mode.hits)) gate.addSecret(`composer#${++secretSeq}`, span);
            declineWith(mode.note);
            return;
          }
          // anything else cancels the note and keeps the review open (not an invalid answer)
          showKeys();
          return;
        }
        const a = line.trim();
        const lower = a.toLowerCase();
        if (lower === 'y' || lower === 'yes') return finish(() => resolve({ approved: true }));
        if (lower === 'n' || lower === 'no') return finish(() => resolve({ approved: false }));
        if (lower === 'd') {
          mode = { kind: 'note' };
          write(`${label} ${READLINE_NOTE_PROMPT}`);
          return;
        }
        if (/^d\s+\S/.test(lower)) {
          takeNote(a.slice(1));
          return;
        }
        invalidAnswer();
      };
      detachLine = src.onLine(onLine);
      // stdin closed under us: nobody can approve, so decline (never auto-approve).
      detachClose = src.onClose(() => finish(() => resolve({ approved: false })));
      signal.addEventListener('abort', onAbort, { once: true });
      showKeys();
    });
  }

  function confirmDetailed(req: ConfirmRequest, { signal }: { signal: AbortSignal }): Promise<ConfirmOutcome> {
    if (signal.aborted) return Promise.reject(abortErrorFrom(signal));
    printRequest(req);
    return interactive ? ask(req, signal) : declineAfterTimeout(req, signal);
  }

  return {
    identity,
    confirmDetailed,
    confirm: (req, o) => confirmDetailed(req, o).then((r) => r.approved),
  };
}

// ---------------------------------------------------------------------------------------
// Plain renderer
// ---------------------------------------------------------------------------------------

/** Key of the synthetic header row; never collides with event items (their keys end in a numeric seq). */
export const HEADER_ITEM_KEY = 'run:header';

/**
 * The header row both renderers show before any engine exists: the task (or the run being
 * resumed) and the `step 0/–` sentinel. The TUI puts it at the top of <Static>, the plain
 * renderer writes it as its first line, so both transcripts start identically. It is not an
 * engine item: seq −1 keeps the engine's counter (transcript.log) untouched.
 */
export function headerItem(task: string, resumeId: string | null): TranscriptItem {
  const what = resumeId ? `resuming ${resumeId}` : `task: ${clip(oneLine(task), TASK_MAX)}`;
  return { key: HEADER_ITEM_KEY, seq: -1, step: null, kind: 'run:start', level: 'info', text: `jevcode ${what} | step 0/– starting` };
}

/** TUI-DESIGN §1 / §24: the session header `jevcode session · <dir> | step 0/– starting` (`chat`; no run exists yet). */
export function sessionHeaderItem(cwd: string): TranscriptItem {
  const dir = basename(cwd) || cwd;
  return { key: HEADER_ITEM_KEY, seq: -1, step: null, kind: 'run:start', level: 'info', text: `jevcode session · ${oneLine(dir)} | step 0/– starting` };
}

/** First line, written before any engine exists; carries the same `step 0/–` sentinel as the TUI. */
export function plainFirstLine(task: string, resumeId: string | null): string {
  return formatTranscriptItem(headerItem(task, resumeId));
}

/** TUI-DESIGN §15 item 16: the plain renderer's options — `RendererOptions` plus the cwd the session header names. */
export interface PlainRendererOptions extends RendererOptions {
  /** the directory the `chat` header names (default `process.cwd()`) */
  cwd?: string;
  /**
   * TUI-DESIGN §1 (C46): whether the readline confirmer may ask at all. Wave 3 passes
   * `!flags.noInput && !isInCi && TERM !== 'dumb'`; default `Boolean(stdin.isTTY)`.
   */
  interactive?: boolean;
  /** TUI-DESIGN §1 / §6.5: the readline composer's shared line source (`composer.lines`); `setLineSource()` may hand it over later */
  lines?: LineSource;
}

/** The plain renderer: `Renderer` plus the contract-1.1 hooks it implements (TUI-DESIGN §15 item 16). */
export interface PlainRenderer extends Renderer {
  setHost(host: SessionHost): void;
  setUi(ui: UiConfig): void;
  notify(text: string, opts?: { level?: TranscriptLevel; detail?: string; label?: UiLabel }): void;
  /**
   * TUI-DESIGN §1 / §6.5: hand the readline composer's `lines` to the confirmer so both share the one stdin
   * interface; must run before the first review (before the first run starts) on a `--plain` TTY.
   */
  setLineSource(lines: LineSource): void;
  /** the host handed over by `setHost`, null before */
  readonly host: SessionHost | null;
  /** the session settings handed over by `setUi`, null before */
  readonly ui: UiConfig | null;
  /** TUI-DESIGN §14.1: the glyph table stdout is written through (`--ascii` → ASCII twins; items stay canonical) */
  readonly glyphs: GlyphSet;
}

/**
 * TUI-DESIGN §1 / §15.1: the line renderer for `--plain`, pipes, `CI`, `TERM=dumb` and `--no-input`.
 * Engine items come from `itemsFromEvent` (identical to transcript.log and the TUI); idle-time
 * local items arrive through `notify()` and print with their label (`[ui]`, `[setup]`, `[config]`,
 * `[sandbox]`). The readline confirmer takes the session host's gate once `setHost()` ran and the
 * composer's shared line source once `setLineSource()` ran. TUI-DESIGN §14.1: stdout is written
 * through the launch glyph table (`--ascii`); the item strings themselves — and so transcript.log —
 * stay canonical Unicode.
 */
export function createPlainRenderer(opts: PlainRendererOptions): PlainRenderer {
  const stdout: ConfirmOutput = opts.stdout ?? process.stdout;
  const stdin: ConfirmInput = opts.stdin ?? process.stdin;
  let seq = 0;
  let localSeq = 0;
  // A raw generator stream is on the current line until `proposal` (or any item) terminates it.
  let streamOpen = false;
  let detach: (() => void) | null = null;
  let host: SessionHost | null = opts.host ?? null;
  let ui: UiConfig | null = null;
  let lines: LineSource | null = opts.lines ?? null;
  // TUI-DESIGN §14.1 / §16: the glyph mode is a launch setting (flag > env > default), fixed before the first frame
  const glyphs = glyphSet({ ...(opts.launch?.ascii !== undefined ? { ascii: opts.launch.ascii } : {}), ...(opts.launch?.screenReader !== undefined ? { screenReader: opts.launch.screenReader } : {}) });
  const write = (s: string): void => {
    stdout.write(glyphTwin(s, glyphs));
  };

  const header = opts.mode === 'session' ? sessionHeaderItem(opts.cwd ?? process.cwd()) : headerItem(opts.task, opts.resumeId);
  const firstFrame = new Promise<void>((resolve) => {
    stdout.write(glyphTwin(`${formatTranscriptItem(header)}\n`, glyphs), () => resolve());
  });

  const confirmer = createReadlineConfirmer(stdin, stdout, {
    onAbort: (reason) => opts.onAbort(reason),
    ...(opts.confirmTimeoutMs !== undefined ? { confirmTimeoutMs: opts.confirmTimeoutMs } : {}),
    ...(opts.interactive !== undefined ? { interactive: opts.interactive } : {}),
    host: () => host,
    lines: () => lines,
    glyphs,
  });

  function endStream(): void {
    if (streamOpen) {
      stdout.write('\n');
      streamOpen = false;
    }
  }

  function handle(e: EngineEvent): void {
    if (e.type === 'generator:delta') {
      const text = sanitizeStream(e.text);
      if (text.length === 0) return;
      stdout.write(text);
      streamOpen = !text.endsWith('\n');
      return;
    }
    const items = itemsFromEvent(e, seq);
    if (items.length === 0) return;
    seq += items.length;
    endStream();
    for (const item of items) write(`${formatTranscriptItem(item)}\n`);
  }

  return {
    confirmer,
    glyphs,
    get host() {
      return host;
    },
    get ui() {
      return ui;
    },
    attach(engine: Engine) {
      detach?.();
      detach = engine.events.onAny(handle);
    },
    firstFrame: () => firstFrame,
    setHost(h: SessionHost) {
      host = h;
    },
    setUi(u: UiConfig) {
      ui = u;
    },
    setLineSource(l: LineSource) {
      lines = l;
    },
    // TUI-DESIGN §15.1: an idle-time renderer-local item — `--plain` prints it with its label; no transcript.log exists to hold it
    notify(text, o = {}) {
      const item = localItem(text, localSeq++, { ...(o.label ? { label: o.label } : {}), ...(o.level ? { level: o.level } : {}), ...(o.detail ? { detail: o.detail } : {}) });
      endStream();
      write(`${formatTranscriptItem(item)}\n`);
    },
    async unmount() {
      detach?.();
      detach = null;
      endStream();
      await new Promise<void>((resolve) => {
        stdout.write('', () => resolve());
      });
    },
  };
}
