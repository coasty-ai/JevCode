/**
 * Generator prompts (DESIGN.md §7, §13). One fixed system prompt per run and one user message
 * per step. The user message is O(plan + window + context), never O(transcript): every section
 * is bounded here and the total is clipped as a last resort.
 *
 * docs/COORDINATION-DESIGN.md §8 (the relaxed generator context): when `PromptInput.context` is given, the message carries
 * `## Files in view` (fresh content of every file the generator read / edited, Jev's picks first in jev-on, de-duplicated by
 * path), the tiered `## Recent steps` (the newest 2 outputs whole up to 32 KiB, 3–6 head+tail, 7–12 one line) and the rolling
 * `## Summary`, filled in the §8.2 order under the model-aware budget: a section that does not fit shrinks to its floor
 * before the next is added, and no clip is silent (every marker names the path to the full text, §8.5). Without `context`
 * the message is byte-identical to before (the 4-entry window, Jev's context files) — the synth modes and older callers.
 */
import { clip, headTail } from '../core/text.js';
// TUI-DESIGN §8.6 (F7): the steer bounds are defined once, next to PendingDirective
import { DIRECTIVE_MAX_CHARS, PENDING_DIRECTIVES_MAX } from '../core/types.js';
import type { Candidate, ChoiceVerdict, EngineMode, FileView, Intent, IntentAnswer, Plan, ReplanDirective, SandboxLevel, WindowEntry } from '../core/types.js';
import type { RenderedHistoryEntry } from '../loop/context/history.js';
import { FILES_SHARE, HISTORY_SHARE, SUMMARY_MAX_CHARS } from '../loop/context/limits.js';
import type { FilePin } from '../loop/context/types.js';

export const PROMPT_LIMITS = {
  /** hard ceiling on one user message; sections are bounded individually well below it */
  maxUserMessageChars: 160_000,
  planItemChars: 200,
  planItems: 20,
  windowOutputChars: 600,
  contextFileBytes: 16_384,
  contextTotalBytes: 61_440,
  contextFiles: 12,
  candidates: 300,
  taskChars: 12_000,
  reasonChars: 600,
  noteChars: 300,
} as const;

export interface PromptIntentInfo {
  intent: Intent;
  answer: IntentAnswer;
  /** Choice probability of the resolved option */
  probability: number;
  /** paired Noul of the resolved option */
  pairedNoul: number;
  /** core/types.ts ChoiceVerdict; `code` (llm-jev) reads as a plain chosen intent — no Choice was asked */
  verdict: ChoiceVerdict;
}

export interface PromptHints {
  /** plan_still_valid < 0.3 on this step */
  planStale?: { probability: number };
  /** matches_intent < 0.3 on the previous step */
  intentMismatch?: { intent: Intent; probability: number; step: number };
  /** done claims beyond the per-step cap on the previous step */
  claimsDropped?: number;
}

export interface PromptWorkspaceInfo {
  changedFiles: string[];
  /** first step after --resume: prefix the changed-files section */
  resumed: boolean;
  testCommand: string | null;
  git: boolean;
}

/** §8.4: one file of `## Files in view` — fresh content from disk, ≤ 32 KiB, with why it is in view. */
export interface PromptFileInView {
  path: string;
  /** the shown content; when `truncatedBytes > 0` the section adds the `…[N more bytes …; full file: <path>]` marker */
  content: string;
  bytes: number;
  truncatedBytes: number;
  pinnedBy: FilePin;
  lastUsedStep: number;
  /** dropped for the files byte budget before the prompt: listed by name with the recovery hint */
  omitted: boolean;
}

/** §8.3 / §8.6 / §8.7: what the engine's context policy assembled for this step. */
export interface PromptContextView {
  /** most valuable first (pins human > jev > seed > edit > read, then most recently used) */
  files: PromptFileInView[];
  /** oldest first, tiers already assigned and outputs expanded */
  history: RenderedHistoryEntry[];
  /** the rolling summary text (≤ 3 KiB as written; clipped at 6 KiB here), null before the first compaction */
  summary: string | null;
  summaryAt: number | null;
  /** §8.2 `contextBudgetChars` */
  budgetChars: number;
}

export interface PromptInput {
  mode: EngineMode;
  step: number;
  task: string;
  plan: Plan;
  /** null in jev-off */
  intent: PromptIntentInfo | null;
  hints: PromptHints;
  /** Jev's replan directive issued for this step (jev-on) */
  directive: ReplanDirective | null;
  /** jev-off fixed loop text for this step, or an earlier directive text still active */
  loopNotice: string | null;
  window: WindowEntry[];
  workspace: PromptWorkspaceInfo;
  /** jev-on: files Jev selected (already bounded by the context stage) */
  contextFiles: FileView[];
  /** jev-off: the candidate list (path + bytes), no contents */
  candidates: Candidate[] | null;
  toolName: string;
  /** TUI-DESIGN §8.6 / §15 item 19: human directives applied to this step (≤ 8 × 600) → one hints line each */
  humanDirectives?: readonly string[];
  /** TUI-DESIGN §15 item 11: @-mentioned files the human pinned for this task */
  pinnedFiles?: readonly string[];
  /** docs/COORDINATION-DESIGN.md §8: the relaxed context view; absent → the legacy 4-entry message, byte-identical to before */
  context?: PromptContextView;
}

export interface SystemPromptOptions {
  mode: EngineMode;
  sandboxLevel: SandboxLevel;
  toolName: string;
  /** TUI-DESIGN §11.3 / §15 item 19: AGENTS.md text (≤ 32 KiB) appended as `## Project instructions`; generator only */
  instructions?: string;
}

/** What one build produced: the text, its size and the per-section chars behind the meter (§8.7 `/context`). */
export interface PromptBuild {
  text: string;
  chars: number;
  /** section name → chars, in render order */
  sections: Record<string, number>;
  /** a section was shrunk to its floor (or the last-resort clip fired) to fit the budget */
  shrunk: boolean;
}

/** TUI-DESIGN §11.3 (D6): the instruction text never exceeds 32 KiB in the prompt, whatever the loader passed. */
export const INSTRUCTIONS_MAX_CHARS = 32 * 1024;
/** TUI-DESIGN §8.6: each human directive line is clipped at 600 (F7: 8 × 600, never re-clipped as a batch) — defined once in core/types.ts. */
export const HUMAN_DIRECTIVE_CHARS: number = DIRECTIVE_MAX_CHARS;
const PINNED_FILES_SHOWN = 20;

const SCHEMA_EXAMPLE = `{ "goal": "one sentence",
  "action": { "kind": "edit", "path": "src/a.py", "old": "exact text copied verbatim", "new": "replacement" },
  "plan": { "done": ["..."], "remaining": ["..."], "openProblems": ["..."] } }`;

export function buildSystemPrompt(opts: SystemPromptOptions): string {
  const sandbox =
    opts.sandboxLevel === 'seatbelt'
      ? 'Commands run under a macOS seatbelt profile: writes are allowed only inside the workspace and the run temp dir, secret stores are unreadable, and the process tree is killed on timeout.'
      : 'Commands run with a scrubbed environment in the workspace, with a timeout, an output cap (200 KB, the rest is dropped) and a process-tree kill; writes outside the workspace may fail.';
  const reviewer =
    opts.mode === 'jev-on'
      ? 'A separate decision model (Jev) scores every proposed action for risk before it runs, judges the result, and decides whether the task is complete; blocked or declined actions come back to you with the reason. Jev also sets the intent of each step and picks which files you see.'
      : opts.mode === 'llm-jev'
        ? // docs/LLM-JEV-DESIGN.md §9.2 stage 1 / §9.4: the generic fallback's reviewer sentence
          'Patches are verified in shadow lanes before they reach the workspace; unverified actions (a `run` that is not the test command, an unverified patch, a `done` while tests fail) are gated on harm only by a separate decision model (Jev): what existing data would be lost and what could not be undone. Blocked actions come back to you with the reason; the harness computes test results and completion, you do not.'
        : 'Every well-formed action is executed; there is no reviewer. You obtain file contents only through `read` actions.';
  const base = [
    'You are the engineer in a coding-agent harness. You write code; you do not decide when the task is finished, the harness does.',
    'Each turn you receive the task, the accepted plan, recent steps with their results, and workspace information. You reply by calling the tool ' +
      `\`${opts.toolName}\` exactly once with { goal, action, plan }. If tool calling is unavailable, reply with exactly one fenced \`\`\`json block of the same shape and nothing after it:`,
    '```json\n' + SCHEMA_EXAMPLE + '\n```',
    'Rules:',
    '- Exactly one action per turn. Kinds: read { paths }, edit { path, old, new }, write { path, content }, patch { diff }, run { command, timeoutMs? }, done { summary }.',
    '- `edit`: `old` must be copied verbatim from the file and match exactly once; keep it as short as uniquely identifies the spot. Prefer `edit` for changes under ~60 lines, `write` for new files, `patch` only when you already hold a unified diff (a/ b/ prefixes, applied with git apply -p1).',
    '- `run`: non-interactive, must finish inside the timeout (default 120 s, max 600 s); no editors, pagers, prompts or servers that never exit. ' + sandbox,
    '- `read`: at most 12 workspace-relative paths, 16 KB each. Never read secret files (.env, keys).',
    '- `done`: propose it only when the plan has nothing remaining and the work is verified (tests or an equivalent run in a recent step). The summary states what changed and how it was verified.',
    '- `plan`: return the full plan every turn. `done` lists finished items (include an item only when its evidence is visible in a step result), `remaining` the ordered items left, `openProblems` what is unresolved. Items are short (under 200 characters). Do not mark an item done on the same turn you propose the action that would finish it unless the action is the verification itself.',
    '- Paths are workspace-relative. Do not touch files outside the workspace, .git internals, or credentials.',
    `- ${reviewer}`,
    '- Keep any text before the tool call to a few sentences of reasoning.',
  ].join('\n\n');
  // TUI-DESIGN §15.2 prompts.ts row: `\n\n## Project instructions\n<text>` — the generator sees AGENTS.md, Jev never does (D6)
  const instructions = opts.instructions?.trim() ?? '';
  return instructions.length === 0 ? base : `${base}\n\n## Project instructions\n${clip(instructions, INSTRUCTIONS_MAX_CHARS)}`;
}

function item(s: string, max = PROMPT_LIMITS.planItemChars): string {
  return clip(s.replace(/\s+/g, ' ').trim(), max);
}

function list(items: readonly string[], empty: string, max: number = PROMPT_LIMITS.planItems): string {
  if (items.length === 0) return `  (${empty})`;
  const shown = items.slice(0, max).map((s, i) => `  ${i + 1}. ${item(s)}`);
  if (items.length > max) shown.push(`  … ${items.length - max} more`);
  return shown.join('\n');
}

function planSection(plan: Plan): string {
  const lines = ['## Plan (accepted by the harness)'];
  lines.push('done:');
  lines.push(list(plan.done.map((d) => (d.evidence.judged >= 0 ? `${d.text} (step ${d.evidence.step}, judged ${d.evidence.judged.toFixed(2)})` : `${d.text} (step ${d.evidence.step})`)), 'nothing yet'));
  lines.push('remaining:');
  lines.push(list(plan.remaining, 'nothing listed'));
  if (plan.unverified.length > 0) {
    lines.push('unverified (claimed done, Jev was unsure; verify before claiming again):');
    lines.push(list(plan.unverified.map((u) => `${u.text} (step ${u.step}, done=${u.judged.toFixed(2)})`), ''));
  }
  lines.push('openProblems (yours, replaced each step):');
  lines.push(list(plan.openProblems, 'none', 16));
  if (plan.harnessProblems.length > 0) {
    lines.push('harnessProblems (owned by the harness; you cannot remove these):');
    lines.push(list(plan.harnessProblems.map((h) => `[${h.kind}, step ${h.step}] ${h.text}`), '', 16));
  }
  return lines.join('\n');
}

function intentSection(input: PromptInput): string | null {
  const it = input.intent;
  if (!it) return null;
  const lines = ['## Intent for this step (from Jev)'];
  if (it.verdict === 'fallback') {
    lines.push(`Jev found no fitting intent (p=${it.probability.toFixed(2)}, chose \`${it.answer}\`); investigate before changing anything. Effective intent: \`${it.intent}\`.`);
  } else {
    const how = it.verdict === 'overridden' ? ' (Jev\'s first choice was overridden by a stronger paired judgement)' : '';
    lines.push(`Intent: \`${it.intent}\` (Choice p=${it.probability.toFixed(2)}, paired judgement can_${it.intent}=${it.pairedNoul.toFixed(2)})${how}.`);
  }
  if (it.intent === 'finish') {
    lines.push('Jev judges nothing remains. Propose `done` with a summary if you agree, or one final verification `run`.');
  }
  return lines.join('\n');
}

function hintsSection(input: PromptInput): string | null {
  const lines: string[] = [];
  const h = input.hints;
  if (h.planStale) lines.push(`Jev judged the plan stale (plan_still_valid=${h.planStale.probability.toFixed(2)}): revise \`remaining\` before continuing.`);
  if (h.intentMismatch) {
    lines.push(`Jev judged the last action (step ${h.intentMismatch.step}) did not carry out intent \`${h.intentMismatch.intent}\` (p=${h.intentMismatch.probability.toFixed(2)}).`);
  }
  if (h.claimsDropped && h.claimsDropped > 0) {
    lines.push(`${h.claimsDropped} done claim(s) beyond the 8 judged per step were dropped last step; restate them when their evidence is visible.`);
  }
  if (input.directive) {
    const d = input.directive;
    lines.push(`Replan directive from Jev (move \`${d.move}\`, p=${d.probability.toFixed(2)}, task_impossible=${d.taskImpossible.toFixed(2)}): ${clip(d.text, 600)}`);
  }
  if (input.loopNotice) lines.push(clip(input.loopNotice, 600));
  // TUI-DESIGN §8.6 / §15.2 prompts.ts row: one line per human directive, after the replan line, each clipped at 600 (≤ 8 lines)
  for (const d of (input.humanDirectives ?? []).slice(0, PENDING_DIRECTIVES_MAX)) lines.push(`Instruction from the human for this step (it takes precedence over the plan's order): ${clip(d, HUMAN_DIRECTIVE_CHARS)}`);
  const pinned = input.pinnedFiles ?? [];
  if (pinned.length > 0) lines.push(`The human pinned these files for this task (@-mentions): ${pinned.slice(0, PINNED_FILES_SHOWN).join(', ')}${pinned.length > PINNED_FILES_SHOWN ? `, … (${pinned.length - PINNED_FILES_SHOWN} more)` : ''}`);
  if (lines.length === 0) return null;
  return ['## Notes from the harness', ...lines.map((l) => `- ${l}`)].join('\n');
}

/** The header lines of one step entry (everything but the output block). */
function entryHeader(e: WindowEntry): string[] {
  const head = [`### step ${e.step}: ${e.action}`];
  const meta: string[] = [];
  if (e.intent) meta.push(`intent=${e.intent}`);
  meta.push(`outcome=${e.outcome ?? 'not reached'}`);
  if (e.judge) {
    meta.push(`succeeded=${e.judge.succeeded.toFixed(2)}`, `error_present=${e.judge.errorPresent.toFixed(2)}`, `new_information=${e.judge.newInfo.toFixed(2)}`);
    if (e.judge.tests) {
      meta.push(
        e.judge.tests.source === 'parsed'
          ? `tests=${e.judge.tests.passed} passed, ${e.judge.tests.failed} failed, ${e.judge.tests.errors} errors`
          : `tests_pass(judged)=${e.judge.tests.allPassed.toFixed(2)}`,
      );
    }
  }
  if (typeof e.completion === 'number') meta.push(`task_complete=${e.completion.toFixed(2)}`);
  if (e.truncated) meta.push('output truncated (cap passed)');
  head.push(meta.join(' | '));
  if (e.reason) head.push(`reason: ${clip(e.reason, PROMPT_LIMITS.reasonChars)}`);
  if (e.shownFiles.length > 0) head.push(`shown files: ${e.shownFiles.slice(0, 20).join(', ')}${e.shownFiles.length > 20 ? ', …' : ''}`);
  for (const n of e.notes.slice(0, 8)) head.push(`note: ${clip(n, PROMPT_LIMITS.noteChars)}`);
  return head;
}

function windowEntry(e: WindowEntry): string {
  const head = entryHeader(e);
  if (e.output !== undefined && e.output.length > 0) head.push('output:\n```\n' + headTail(e.output, 400, 200) + '\n```');
  return head.join('\n');
}

function windowSection(window: WindowEntry[]): string {
  const lines = ['## Recent steps (last 4, oldest first)'];
  if (window.length === 0) lines.push('(this is the first step)');
  else for (const e of window.slice(-4)) lines.push(windowEntry(e));
  return lines.join('\n');
}

function workspaceSection(ws: PromptWorkspaceInfo): string {
  const lines = ['## Workspace'];
  lines.push(ws.git ? 'git repository: yes' : 'git repository: no');
  lines.push(ws.testCommand ? `detected test command: \`${ws.testCommand}\`` : 'detected test command: none');
  const files = ws.changedFiles.slice(0, 50);
  const label = ws.resumed ? 'resumed run: these files differ from the last commit' : 'files changed by this run';
  lines.push(`${label}: ${files.length === 0 ? 'none' : files.join(', ')}${ws.changedFiles.length > 50 ? `, … (${ws.changedFiles.length - 50} more)` : ''}`);
  return lines.join('\n');
}

function contextSection(files: FileView[]): string {
  const lines = ['## Context files (selected by Jev for this step)'];
  if (files.length === 0) {
    lines.push('(none selected; use a `read` action if you need file contents)');
    return lines.join('\n');
  }
  let total = 0;
  for (const f of files.slice(0, PROMPT_LIMITS.contextFiles)) {
    let content = f.content;
    if (content.length > PROMPT_LIMITS.contextFileBytes) content = content.slice(0, PROMPT_LIMITS.contextFileBytes);
    if (total + content.length > PROMPT_LIMITS.contextTotalBytes) break;
    total += content.length;
    const trunc = f.truncatedBytes > 0 || content.length < f.content.length ? ` …[truncated ${f.truncatedBytes + (f.content.length - content.length)} bytes]` : '';
    lines.push(`### ${f.path} (${f.bytes} bytes${trunc})\n\`\`\`\n${content}\n\`\`\``);
  }
  return lines.join('\n');
}

function candidateSection(candidates: Candidate[]): string {
  const lines = ['## Workspace files (path, bytes) — use `read` to see contents'];
  if (candidates.length === 0) lines.push('(no candidate files listed)');
  else {
    for (const c of candidates.slice(0, PROMPT_LIMITS.candidates)) lines.push(`${c.path} ${c.bytes}`);
    if (candidates.length > PROMPT_LIMITS.candidates) lines.push(`… ${candidates.length - PROMPT_LIMITS.candidates} more not listed`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------
// docs/COORDINATION-DESIGN.md §8: the relaxed context sections
// ---------------------------------------------------------------------------------------

/** How much the fill order (§8.2) has shrunk: 0 = everything, 1 = files at their floor, 2 = history all one-liners, 3 = no summary. */
type ShrinkLevel = 0 | 1 | 2 | 3;

const PIN_LABEL: Readonly<Record<FilePin, string>> = { read: 'you read it', edit: 'you edited it', human: 'pinned by the human', jev: 'selected by Jev', seed: 'carried from the parent run' };

function whyInView(f: PromptFileInView): string {
  const when = f.lastUsedStep > 0 ? ` at step ${f.lastUsedStep}` : '';
  return `${PIN_LABEL[f.pinnedBy]}${when}`;
}

/** §8.5: a clipped file names itself as the recovery path. */
function fileBlock(path: string, bytes: number, why: string, content: string, truncatedBytes: number): string {
  const marker = truncatedBytes > 0 ? `\n…[${truncatedBytes} more bytes not shown of ${bytes}; full file: ${path}]…` : '';
  return `### ${path} (${bytes} bytes · ${why})\n\`\`\`\n${content}${marker}\n\`\`\``;
}

function fileOmitted(path: string, bytes: number, why: string, reason: string): string {
  return `### ${path} (${bytes} bytes · ${why}) — not shown (${reason}); \`read\` it if you need it`;
}

/**
 * §8.4 / §8.8: `## Files in view` — in jev-on Jev's picks first (their content already bounded by the context stage), then the
 * cache entries not already present, de-duplicated by path, within FILES_SHARE of the budget. Beyond the floor (level ≥ 1) only
 * Jev's picks carry content; every other file is listed by name with the `read` hint — never dropped silently.
 */
function filesInViewSection(input: PromptInput, ctx: PromptContextView, level: ShrinkLevel): string | null {
  const jevFiles = input.mode === 'jev-on' ? input.contextFiles.slice(0, PROMPT_LIMITS.contextFiles) : [];
  if (jevFiles.length === 0 && ctx.files.length === 0) {
    return input.mode === 'jev-on' ? '## Files in view\n(none; use a `read` action if you need file contents)' : null;
  }
  const cap = Math.floor(ctx.budgetChars * FILES_SHARE);
  const lines = ['## Files in view'];
  const seen = new Set<string>();
  let total = 0;
  for (const f of jevFiles) {
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    let content = f.content;
    if (content.length > PROMPT_LIMITS.contextFileBytes) content = content.slice(0, PROMPT_LIMITS.contextFileBytes);
    const truncated = f.truncatedBytes + (f.content.length - content.length);
    if (total + content.length > cap) {
      lines.push(fileOmitted(f.path, f.bytes, PIN_LABEL.jev, 'files budget'));
      continue;
    }
    total += content.length;
    lines.push(fileBlock(f.path, f.bytes, PIN_LABEL.jev, content, truncated));
  }
  for (const f of ctx.files) {
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    const why = whyInView(f);
    if (f.omitted || level >= 1) {
      lines.push(fileOmitted(f.path, f.bytes, why, f.omitted ? 'files budget' : 'prompt budget'));
      continue;
    }
    if (total + f.content.length > cap) {
      lines.push(fileOmitted(f.path, f.bytes, why, 'files budget'));
      continue;
    }
    total += f.content.length;
    lines.push(fileBlock(f.path, f.bytes, why, f.content, f.truncatedBytes));
  }
  return lines.join('\n');
}

function tieredEntry(r: RenderedHistoryEntry, asLine: boolean): string {
  if (asLine || r.tier === 'line' || (r.output === null && r.entry.judge === undefined && r.entry.notes.length === 0 && r.entry.shownFiles.length === 0)) return `- ${r.line}`;
  const head = entryHeader(r.entry);
  if (r.output !== null && r.output.length > 0) head.push('output:\n```\n' + r.output + '\n```');
  return head.join('\n');
}

/**
 * §8.3: `## Recent steps` tiered, oldest first, within HISTORY_SHARE of the budget: when the rendered section is too large the
 * oldest expanded entries demote to one-liners until it fits (their pointer names the full text); level ≥ 2 = all one-liners.
 */
function recentStepsSection(ctx: PromptContextView, level: ShrinkLevel): string {
  const items = ctx.history;
  const header = `## Recent steps (last ${items.length}, oldest first)`;
  if (items.length === 0) return `${header}\n(this is the first step)`;
  const cap = Math.floor(ctx.budgetChars * HISTORY_SHARE);
  let demoted = level >= 2 ? items.length : 0;
  for (;;) {
    const body = items.map((r, i) => tieredEntry(r, i < demoted)).join('\n');
    if (body.length <= cap || demoted >= items.length) return `${header}\n${body}`;
    demoted += 1;
  }
}

function summarySection(ctx: PromptContextView, level: ShrinkLevel): string | null {
  if (ctx.summary === null || ctx.summary.length === 0 || level >= 3) return null;
  const at = ctx.summaryAt !== null ? ` (rolling; compacted at step ${ctx.summaryAt})` : ' (rolling)';
  return `## Summary${at}\n${clip(ctx.summary, SUMMARY_MAX_CHARS)}`;
}

function replySection(toolName: string): string {
  return `## Your reply\nCall \`${toolName}\` once with { goal, action, plan } (or reply with exactly one fenced \`\`\`json block of that shape). One action only.`;
}

function sectionName(text: string): string {
  const m = /^(?:# Step \d+\n\n)?## ([^\n(]+)/.exec(text);
  return m?.[1]?.trim() ?? 'other';
}

function measure(sections: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sections) {
    const name = sectionName(s);
    out[name] = (out[name] ?? 0) + s.length;
  }
  return out;
}

/** The legacy message (no context view): byte-identical to what the engine sent before §8 landed. */
function assembleLegacy(input: PromptInput): string[] {
  const sections: string[] = [];
  sections.push(`# Step ${input.step}\n\n## Task\n${clip(input.task, PROMPT_LIMITS.taskChars)}`);
  sections.push(planSection(input.plan));
  const intent = intentSection(input);
  if (intent) sections.push(intent);
  const hints = hintsSection(input);
  if (hints) sections.push(hints);
  sections.push(workspaceSection(input.workspace));
  if (input.mode === 'jev-on') sections.push(contextSection(input.contextFiles));
  else sections.push(candidateSection(input.candidates ?? []));
  sections.push(windowSection(input.window));
  sections.push(replySection(input.toolName));
  return sections;
}

/** §8.2 fill order at one shrink level: task → plan → directives → summary → files in view → candidates → recent steps. */
function assembleRelaxed(input: PromptInput, ctx: PromptContextView, level: ShrinkLevel): string[] {
  const sections: string[] = [];
  sections.push(`# Step ${input.step}\n\n## Task\n${clip(input.task, PROMPT_LIMITS.taskChars)}`);
  sections.push(planSection(input.plan));
  const intent = intentSection(input);
  if (intent) sections.push(intent);
  const hints = hintsSection(input);
  if (hints) sections.push(hints);
  sections.push(workspaceSection(input.workspace));
  const summary = summarySection(ctx, level);
  if (summary) sections.push(summary);
  const files = filesInViewSection(input, ctx, level);
  if (files) sections.push(files);
  if (input.mode !== 'jev-on') sections.push(candidateSection(input.candidates ?? []));
  sections.push(recentStepsSection(ctx, level));
  sections.push(replySection(input.toolName));
  return sections;
}

/** One user message per step (§7 layout; §13 omits the Jev sections and lists candidates) with the facts behind the meter. */
export function buildPrompt(input: PromptInput): PromptBuild {
  const ctx = input.context;
  if (ctx === undefined) {
    const sections = assembleLegacy(input);
    const joined = sections.join('\n\n');
    const clipped = joined.length > PROMPT_LIMITS.maxUserMessageChars;
    const text = clipped ? headTail(joined, PROMPT_LIMITS.maxUserMessageChars - 2_000, 1_500) : joined;
    return { text, chars: text.length, sections: measure(sections), shrunk: clipped };
  }
  const budget = Math.max(1, Math.floor(ctx.budgetChars));
  for (const level of [0, 1, 2, 3] as const) {
    const sections = assembleRelaxed(input, ctx, level);
    const joined = sections.join('\n\n');
    if (joined.length <= budget) return { text: joined, chars: joined.length, sections: measure(sections), shrunk: level > 0 };
    if (level === 3) {
      // the last-resort safety net (§8.2): head + tail of the whole message, marked — and inside the budget at any budget
      const tail = Math.min(1_500, Math.floor(budget / 4));
      const text = headTail(joined, Math.max(1, budget - tail - 200), tail);
      return { text, chars: text.length, sections: measure(sections), shrunk: true };
    }
  }
  /* unreachable: the loop returns at level 3 */
  const text = assembleRelaxed(input, ctx, 3).join('\n\n');
  return { text, chars: text.length, sections: {}, shrunk: true };
}

/** One user message per step (§7 layout; §13 omits the Jev sections and lists candidates). */
export function buildUserMessage(input: PromptInput): string {
  return buildPrompt(input).text;
}

/** Follow-up user message after a malformed reply (§6 stage table): reason plus the tail of the raw text. */
export function buildRetryMessage(reason: string, rawTail: string, toolName: string): string {
  return [
    `Your previous reply could not be used: ${clip(reason, 400)}.`,
    rawTail.length > 0 ? 'The end of what you sent:\n```\n' + rawTail + '\n```' : 'It contained no usable text.',
    `Reply again by calling \`${toolName}\` once with a valid { goal, action, plan } object (or one fenced json block of that shape). Use exactly the keys of the schema and no others.`,
  ].join('\n\n');
}
