/**
 * Generator prompts (DESIGN.md §7, §13). One fixed system prompt per run and one user message
 * per step. The user message is O(plan + window + context), never O(transcript): every section
 * is bounded here and the total is clipped as a last resort.
 */
import { clip, headTail } from '../core/text.js';
import type { Candidate, EngineMode, FileView, Intent, IntentAnswer, Plan, ReplanDirective, SandboxLevel, WindowEntry } from '../core/types.js';

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
  verdict: 'chosen' | 'overridden' | 'fallback';
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
}

export interface SystemPromptOptions {
  mode: EngineMode;
  sandboxLevel: SandboxLevel;
  toolName: string;
}

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
      : 'Every well-formed action is executed; there is no reviewer. You obtain file contents only through `read` actions.';
  return [
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
  if (lines.length === 0) return null;
  return ['## Notes from the harness', ...lines.map((l) => `- ${l}`)].join('\n');
}

function windowEntry(e: WindowEntry): string {
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

/** One user message per step (§7 layout; §13 omits the Jev sections and lists candidates). */
export function buildUserMessage(input: PromptInput): string {
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
  sections.push(
    `## Your reply\nCall \`${input.toolName}\` once with { goal, action, plan } (or reply with exactly one fenced \`\`\`json block of that shape). One action only.`,
  );
  const text = sections.join('\n\n');
  return text.length > PROMPT_LIMITS.maxUserMessageChars ? headTail(text, PROMPT_LIMITS.maxUserMessageChars - 2_000, 1_500) : text;
}

/** Follow-up user message after a malformed reply (§6 stage table): reason plus the tail of the raw text. */
export function buildRetryMessage(reason: string, rawTail: string, toolName: string): string {
  return [
    `Your previous reply could not be used: ${clip(reason, 400)}.`,
    rawTail.length > 0 ? 'The end of what you sent:\n```\n' + rawTail + '\n```' : 'It contained no usable text.',
    `Reply again by calling \`${toolName}\` once with a valid { goal, action, plan } object (or one fenced json block of that shape). Use exactly the keys of the schema and no others.`,
  ].join('\n\n');
}
