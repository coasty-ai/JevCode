/**
 * Plain (non-Ink) renderer plus the transcript-item model shared by the TUI's <Static>
 * pane, the plain renderer and the engine's transcript.log (DESIGN.md §10). This module is
 * dependency-free (Node built-ins only) so the engine can import `itemsFromEvent` /
 * `formatTranscriptItem` without pulling in ink/react.
 */
import { createInterface } from 'node:readline';
import type {
  Action,
  ActionOutcome,
  Confirmer,
  ConfirmRequest,
  Engine,
  EngineEvent,
  JudgeResult,
  Renderer,
  RendererOptions,
  RiskAssessment,
  RiskDimension,
  UiLabel,
} from '../core/types.js';
import { RISK_DIMENSIONS } from '../core/types.js';
import { AbortError } from '../errors.js';
import { clip, firstLine } from '../core/text.js';
import { formatDuration } from '../core/time.js';

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
  // contract 1.1 (TUI-DESIGN §15 item 19): union members only in wave 0; itemsFromEvent cases land with O10 (wave 2) except `notice`
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

/**
 * Transcript items for one engine event (0 or 1; kinds per §10). `seq` is the caller's
 * monotonic counter for the first item produced; keys are `${step}:${kind}:${seq}`.
 * Events that feed the panes only (decision, status, stage:*, deltas, exec:output, ...) yield [].
 */
export function itemsFromEvent(e: EngineEvent, seq: number): TranscriptItem[] {
  const make = (step: number | null, kind: TranscriptKind, text: string, level: TranscriptLevel = 'info', extra: { verdict?: 'ok' | 'review' | 'block'; detail?: string; label?: UiLabel } = {}): TranscriptItem[] => {
    const item: TranscriptItem = {
      key: `${step ?? 'run'}:${kind}:${seq}`,
      seq,
      step,
      kind,
      level,
      text: clip(oneLine(text), TRANSCRIPT_TEXT_MAX),
      ...(extra.verdict ? { verdict: extra.verdict } : {}),
      ...(extra.detail ? { detail: extra.detail } : {}),
      ...(extra.label ? { label: extra.label } : {}),
    };
    return [item];
  };
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
      return make(e.step, 'confirm:resolved', `confirm ${e.id} ${e.aborted ? 'aborted' : e.approved ? 'approved' : 'declined'}`, e.aborted ? 'warn' : 'info');
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
      // contract 1.1 (TUI-DESIGN §15.1): a labelled notice (Engine.annotate) prints `<label> <text>`; any other notice `notice <kind>: <text>`
      return make(e.step, 'notice', e.label ? e.text : `notice ${e.kind}: ${e.text}`, e.level, { ...(e.detail ? { detail: clipDetail(e.detail) } : {}), ...(e.label ? { label: e.label } : {}) });
    case 'run:end': {
      const r = e.result;
      return make(
        null,
        'run:end',
        `end ${r.stopReason} steps=${r.steps} wall=${formatDuration(r.wallMs)} cost=${usd(r.usage.generator.costUsd + r.usage.jev.costUsd)} (gen ${usd(r.usage.generator.costUsd)}, jev ${usd(r.usage.jev.costUsd)})${r.error ? ` error=${r.error.code}: ${r.error.message}` : ''}`,
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

// ---------------------------------------------------------------------------------------
// Confirmation summary (shared by the Ink box and the readline prompt)
// ---------------------------------------------------------------------------------------

/** Fixed row count of the confirmation header; the §10 budget formula subtracts exactly this. */
export const CONFIRM_HEADER_ROWS = 6;
export const CONFIRM_KEYS_LINE = '[y] approve  [n] decline';

function dimText(name: RiskDimension, risk: RiskAssessment): string {
  const d = risk.dims[name];
  // level, P(argmax level), risk term, harness confidence (§10 confirmation box)
  return `${name} L${d.level} p=${p2(d.probability)} r=${p2(d.risk)} c=${p2(d.confidence)}`;
}

/** Exactly CONFIRM_HEADER_ROWS one-line strings: goal, action, dims x2, reason, keys. */
export function confirmHeaderLines(req: ConfirmRequest): string[] {
  const d = describeAction(req.proposal.action);
  const [d0, d1, d2, d3] = RISK_DIMENSIONS;
  return [
    `confirm ${req.id} step ${req.step}: ${clip(oneLine(req.proposal.goal), 200)}`,
    `action: ${d.kind} ${clip(oneLine(d.target), 200)}`,
    `${dimText(d0!, req.risk)} | ${dimText(d1!, req.risk)}`,
    `${dimText(d2!, req.risk)} | ${dimText(d3!, req.risk)}`,
    `reason: risk=${p2(req.risk.risk)} ${clip(oneLine(req.risk.reason), 300)}`,
    CONFIRM_KEYS_LINE,
  ];
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

export interface ReadlineConfirmerOptions {
  /** readline SIGINT while a question is pending (only fires in terminal mode; kept for completeness) */
  onAbort: (reason: 'signal') => void;
  /** stdin not a TTY: decline after this many ms (default 0) */
  confirmTimeoutMs?: number;
  /** rows of preview printed before the question (default 20) */
  previewRows?: number;
}

export const READLINE_MAX_PROMPTS = 5;
export const IDENTITY_REVIEWER = 'reviewer';
export const IDENTITY_NO_TTY = 'no reviewer (stdin not a TTY)';

function abortErrorFrom(signal: AbortSignal): AbortError {
  return signal.reason instanceof AbortError ? signal.reason : new AbortError('signal');
}

/** Minimal stream shapes so tests can pass PassThrough streams. */
export type ConfirmInput = NodeJS.ReadableStream & { isTTY?: boolean };
export type ConfirmOutput = NodeJS.WritableStream;

/**
 * y/n on TTY stdin through `node:readline` with `terminal: false`, so the kernel keeps
 * delivering SIGINT on Ctrl-C (raw mode is never enabled) and the process handler in
 * cli/main.tsx runs shutdown('signal'). Non-TTY stdin declines after `confirmTimeoutMs`.
 */
export function createReadlineConfirmer(stdin: ConfirmInput, stdout: ConfirmOutput, opts: ReadlineConfirmerOptions): Confirmer {
  const tty = Boolean(stdin.isTTY);
  const timeoutMs = Math.max(0, opts.confirmTimeoutMs ?? 0);
  const previewRows = Math.max(0, opts.previewRows ?? 20);
  const identity = tty ? IDENTITY_REVIEWER : IDENTITY_NO_TTY;

  function printRequest(req: ConfirmRequest): void {
    const lines = confirmHeaderLines(req).slice(0, CONFIRM_HEADER_ROWS - 1);
    const preview = confirmPreviewLines(req);
    const shown = preview.slice(0, previewRows);
    const body = [...lines.map((l) => `${stepLabel(req.step)} ${l}`), ...shown.map((l) => `  ${l}`)];
    if (preview.length > shown.length) body.push(`  …[${preview.length - shown.length} preview lines omitted]`);
    stdout.write(`${body.join('\n')}\n`);
  }

  function declineAfterTimeout(req: ConfirmRequest, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        stdout.write(`${stepLabel(req.step)} confirm ${req.id} declined: ${identity}\n`);
        resolve(false);
      }, timeoutMs);
      const onAbort = (): void => {
        clearTimeout(t);
        reject(abortErrorFrom(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function ask(req: ConfirmRequest, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const rl = createInterface({ input: stdin, output: stdout, terminal: false });
      let prompts = 0;
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        rl.close();
        fn();
      };
      const onAbort = (): void => finish(() => reject(abortErrorFrom(signal)));
      const prompt = (): void => {
        prompts += 1;
        stdout.write(`${stepLabel(req.step)} ${CONFIRM_KEYS_LINE} > `);
      };
      rl.on('line', (line) => {
        const a = line.trim().toLowerCase();
        if (a === 'y' || a === 'yes') return finish(() => resolve(true));
        if (a === 'n' || a === 'no') return finish(() => resolve(false));
        if (prompts >= READLINE_MAX_PROMPTS) {
          stdout.write(`${stepLabel(req.step)} confirm ${req.id} declined: no valid answer after ${prompts} prompts\n`);
          return finish(() => resolve(false));
        }
        prompt();
      });
      // stdin closed under us: nobody can approve, so decline (never auto-approve).
      rl.on('close', () => finish(() => resolve(false)));
      rl.on('SIGINT', () => {
        opts.onAbort('signal');
      });
      signal.addEventListener('abort', onAbort, { once: true });
      prompt();
    });
  }

  return {
    identity,
    confirm(req, { signal }) {
      if (signal.aborted) return Promise.reject(abortErrorFrom(signal));
      printRequest(req);
      return tty ? ask(req, signal) : declineAfterTimeout(req, signal);
    },
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

/** First line, written before any engine exists; carries the same `step 0/–` sentinel as the TUI. */
export function plainFirstLine(task: string, resumeId: string | null): string {
  return formatTranscriptItem(headerItem(task, resumeId));
}

export function createPlainRenderer(opts: RendererOptions): Renderer {
  const stdout: ConfirmOutput = opts.stdout ?? process.stdout;
  const stdin: ConfirmInput = opts.stdin ?? process.stdin;
  let seq = 0;
  // A raw generator stream is on the current line until `proposal` (or any item) terminates it.
  let streamOpen = false;
  let detach: (() => void) | null = null;

  const firstFrame = new Promise<void>((resolve) => {
    stdout.write(`${plainFirstLine(opts.task, opts.resumeId)}\n`, () => resolve());
  });

  const confirmer = createReadlineConfirmer(stdin, stdout, {
    onAbort: (reason) => opts.onAbort(reason),
    ...(opts.confirmTimeoutMs !== undefined ? { confirmTimeoutMs: opts.confirmTimeoutMs } : {}),
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
    for (const item of items) stdout.write(`${formatTranscriptItem(item)}\n`);
  }

  return {
    confirmer,
    attach(engine: Engine) {
      detach?.();
      detach = engine.events.onAny(handle);
    },
    firstFrame: () => firstFrame,
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

