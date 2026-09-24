/**
 * The agent's prompts (docs/AGENT-LOOP-DESIGN.md §5): the byte-stable system prompt, the model-family addenda and every
 * fixed harness message text.
 *
 * The system prompt is built once per run from facts that do not change during it (model, provider, sandbox, test
 * command, autonomy, instructions, memory index), so it is identical on every turn and the provider cache holds. It
 * never names Jev, the date, the step or the plan. Its identity block is the verified `chatIdentityHeader` of the chat
 * path, verbatim and first (§A1, §A5): glm-5.3-flash answered "who made you" as its vendor when it was missing.
 *
 * Harness notes are user-role text blocks appended after the tool results; none of them is written as if the
 * assistant had said it (§A1).
 */
import type { AgentToolName, SandboxLevel } from '../core/types.js';
import { chatIdentityHeader } from '../chat/llm-turn.js';
import { IMPORT_LIMITS } from '../core/limits.js';
import { clip } from '../core/text.js';
import { INSTRUCTIONS_MAX_CHARS } from '../provider/prompts.js';
import { AGENT_TOOL_NAMES } from './tools/specs.js';
import { AGENT_MAX_CALLS_PER_TURN } from './limits.js';

export interface SystemPromptFacts {
  model: string;
  /** the provider's display name (`OpenRouter`) */
  providerLabel: string;
  sandboxLevel: SandboxLevel;
  testCommand: string | null;
  autonomy: 'full' | 'review';
  instructions: string | null;
  memoryIndex: string | null;
}

/** The sandbox sentence `buildSystemPrompt` uses (src/provider/prompts.ts), so both prompts describe the same sandbox. */
function sandboxSentence(level: SandboxLevel): string {
  return level === 'seatbelt'
    ? 'Commands run under a macOS seatbelt profile: writes are allowed only inside the workspace and the run temp dir, secret stores are unreadable, and the process tree is killed on timeout.'
    : 'Commands run with a scrubbed environment in the workspace, with a timeout, an output cap (200 KB, the rest is dropped) and a process-tree kill; writes outside the workspace may fail.';
}

/**
 * §A2: under full autonomy nothing is refused, so the prompt asks for restraint instead of promising a refusal; under
 * review the human sees destructive and unrecognised commands first. Either sentence is constant for the run.
 */
function safetyLines(autonomy: 'full' | 'review'): string[] {
  const common = '- Stay inside the workspace. Never read secrets (.env files, keys, credential stores).';
  if (autonomy === 'review') {
    return [
      common,
      '- The human reviews destructive and unrecognised commands before they run. A declined command comes back as a tool result; pick another way or explain what you need and why.',
    ];
  }
  return [
    common,
    '- Never run destructive commands the task does not need: deleting outside the workspace, discarding uncommitted changes you did not make, force pushes, sudo, piping downloads into a shell, disk tools, publishing. The harness runs every command in its sandbox without asking, so this is your responsibility.',
  ];
}

/** §5.2: one short paragraph chosen by the model id. */
export function familyAddendum(model: string): string | null {
  const id = model.toLowerCase();
  const base = id.slice(id.lastIndexOf('/') + 1);
  if (base.startsWith('glm')) return 'Call tools only through the native function-calling interface. Never write tool calls as XML or JSON in your reply text.';
  if (base.startsWith('gpt') || /^o\d/.test(base)) return 'Prefer edit_file over rewriting files. Keep preambles to one sentence.';
  if (base.startsWith('claude') || id.startsWith('anthropic/')) return 'Use parallel tool calls for independent reads.';
  if (base.startsWith('gemini')) return 'Send tool arguments as plain JSON values; do not wrap numbers or booleans in quotes.';
  return null;
}

/** The memory index with the legacy prompt's header and clips (`## Memory (index)`, 200 lines, 8 KiB). */
function memoryIndexBlock(raw: string | null): string | null {
  const text = raw?.trim() ?? '';
  if (text.length === 0) return null;
  const all = text
    .split('\n')
    .map((l) => l.replace(/[`\r]+/g, '').replace(/^\s*#+\s*/, '').trimEnd())
    .filter((l) => l.length > 0);
  if (all.length === 0) return null;
  const kept = all.slice(0, IMPORT_LIMITS.memoryIndexLines);
  const joined = kept.join('\n');
  const body = clip(joined, IMPORT_LIMITS.memoryIndexPromptBytes);
  const notes: string[] = [];
  if (all.length > kept.length) notes.push(`${all.length - kept.length} more indexed notes not shown (${IMPORT_LIMITS.memoryIndexLines}-line index cap)`);
  if (body.length < joined.length) notes.push(`index clipped at ${IMPORT_LIMITS.memoryIndexPromptBytes} chars`);
  return `## Memory (index)\n\`\`\`text\n${body}\n\`\`\`${notes.length === 0 ? '' : `\n(${notes.join('; ')})`}`;
}

/** §5.1: the system prompt, in the design's section order, led by the verified identity header. */
export function buildAgentSystemPrompt(f: SystemPromptFacts): string {
  const verify =
    f.testCommand !== null
      ? `- After changing code, run the tests (\`${f.testCommand}\` was detected) or a scoped subset, and fix failures before you finish.`
      : '- After changing code, run the tests (no test command was detected: run what the project uses, if anything) or a scoped subset, and fix failures before you finish.';
  const sections = [
    chatIdentityHeader(f.model, f.providerLabel),
    [
      '# How you work',
      '- You work autonomously in the user\'s workspace until the task is done. Explore with the tools, make the change, verify it, then reply with a short summary and no tool call.',
      '- Before a batch of tool calls, write one short sentence on what you are about to do.',
      '- Call several independent tools in one reply when you can (for example read three files at once). Reads, searches and read-only commands run in parallel; edits and other commands run one at a time, in the order you give them.',
      '- Use todo_write to plan work with several steps; keep one item in_progress.',
    ].join('\n'),
    [
      '# How to answer',
      '- Warm, concise, personal, plain prose.',
      '- A greeting gets one or two friendly sentences; a question gets a direct answer.',
      '- Answer conversational messages (greetings, thanks, questions about you) directly and briefly, without tools. To answer a question about this workspace you may use the read-only tools (read_file, grep, glob, read-only bash).',
      '- When the message asks for a change, do the work with the tools.',
      '- A question is not a request for a change, even when it points at a bug ("this is wrong, right?"): answer it, reading what you need, and offer to make the change. Edit files or run commands that change the workspace only when the user asks for it.',
      '- Never invent facts about the workspace, and never claim to have run anything you did not run.',
    ].join('\n'),
    [
      '# Tools',
      '- Read a file before you edit it. Copy old_string exactly from read_file output, without the line-number prefix.',
      '- edit_file for changes to existing files; write_file for new files or complete rewrites.',
      '- grep and glob to find code. Read large files in parts with offset and limit.',
      `- bash: non-interactive commands only; each call is a fresh shell, so use workdir instead of cd. ${sandboxSentence(f.sandboxLevel)}`,
      '- Long outputs are cut; the result names a jevcode:outputs/ path you can read_file or grep.',
    ].join('\n'),
    ['# Verifying', verify].join('\n'),
    [
      '# Finishing',
      '- When the task is done, reply without tool calls: what you changed and how you verified it. If you could not finish, say what is left and why.',
    ].join('\n'),
    [
      '# Git and scratch files',
      '- Do not commit, push or create branches unless the user asks.',
      '- Never discard or revert changes you did not make (git checkout or restore of files, git reset --hard, git clean, git stash drop). To undo your own edit, edit the file back.',
      '- Put scratch files under $TMPDIR, not in the workspace or /tmp.',
    ].join('\n'),
    ['# Safety', ...safetyLines(f.autonomy)].join('\n'),
  ];
  const instructions = f.instructions?.trim() ?? '';
  if (instructions.length > 0) sections.push(`## Project instructions\n${clip(instructions, INSTRUCTIONS_MAX_CHARS)}`);
  const memory = memoryIndexBlock(f.memoryIndex);
  if (memory !== null) sections.push(memory);
  const addendum = familyAddendum(f.model);
  if (addendum !== null) sections.push(addendum);
  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------------------
// §5.4 Harness message texts
// ---------------------------------------------------------------------------------------

export const CONTINUE_NUDGE = 'Continue: carry out the step you just described, using the tools.';
export const CONTINUE_CUT_NUDGE = 'Your reply was cut off at the output limit. Continue from where it stopped.';
export const NOT_EXECUTED_STEER = 'NOT EXECUTED: the user sent new instructions before this call ran.';
export const NOT_EXECUTED_REDACTED = "NOT EXECUTED: this call's arguments were redacted when the run was checkpointed; send it again with the full text.";
export const NOT_EXECUTED_TOO_MANY = `NOT EXECUTED: more than ${AGENT_MAX_CALLS_PER_TURN} tool calls in one reply; send the rest in your next reply.`;
export const PROGRESS_NUDGE =
  'Step back: your recent steps do not seem to move the task forward. Re-read the task, say what is still missing, and change your approach if needed.';
export const CONTINUE_WITH_TASK = 'Continue with the task.';

export function verifyFailedNudge(cmd: string, p: number, f: number, e: number): string {
  return `The last run of \`${cmd}\` after your change failed (${p} passed, ${f} failed, ${e} errors). Fix it, or explain why the failures are unrelated, before you finish.`;
}

export function verifyResult(cmd: string, statusLine: string, output: string): string {
  return `The harness ran \`${cmd}\` to verify your change: ${statusLine}\n${output}\nIf it failed, fix it and verify again. If it passed, your summary stands: reply with one short sentence that says the tests passed.`;
}

export function verifyTimeout(cmd: string, seconds: number): string {
  return `The harness ran \`${cmd}\` to verify your change, but it did not finish within ${seconds}s, so the change is not verified. Reply with your summary and say that it is not verified, or run a narrower test.`;
}

export function notExecutedRunEnded(stopReason: string): string {
  return `NOT EXECUTED: the previous run stopped (${stopReason}) before this call ran.`;
}

export function steerNote(text: string): string {
  return `[message from the user while you were working]\n${text}`;
}

export function unknownTool(name: string, available: readonly string[] = AGENT_TOOL_NAMES): string {
  return `UNKNOWN TOOL ${name}. Available: ${available.join(', ')}.`;
}

export function invalidArguments(tool: AgentToolName, problem: string, signature: string): string {
  return `INVALID ARGUMENTS for ${tool}: ${problem}. Expected ${signature}.`;
}

export function truncatedCall(maxTokens: number): string {
  return `Your reply was cut off at the output limit (${maxTokens} tokens) while writing this call. Split large changes into several smaller edit_file calls, or write a large file in parts.`;
}

export function blockedResult(rule: string, why: string): string {
  return `BLOCKED by the harness (rule ${rule}): ${why}. Nothing ran. Choose a safer command, or tell the user what is needed and why.`;
}

export function declinedResult(reason: string, note: string | null): string {
  return `DECLINED by the human: ${reason}${note !== null && note.length > 0 ? ` — note: ${note}` : ''}`;
}

/** The four RA1 wordings (§5.4): `change_approach` is the code fallback. */
export type LoopNudgeKind = 'change_approach' | 'gather_context' | 'fix_environment' | 'revert_changes';
export const LOOP_NUDGE_KINDS: readonly LoopNudgeKind[] = ['change_approach', 'gather_context', 'fix_environment', 'revert_changes'];

export function loopNudgeText(kind: LoopNudgeKind, what: string): string {
  switch (kind) {
    case 'change_approach':
      return `${what}. Stop and try a different approach.`;
    case 'gather_context':
      return `${what}. You are missing information: read the relevant code or error output before changing anything else.`;
    case 'fix_environment':
      return `${what}. The failure may be in the environment (missing dependency, wrong command, wrong directory). Check that first.`;
    case 'revert_changes':
      return `${what}. Your recent edits may have made things worse: review them (git diff) and revert your own changes that do not help.`;
  }
}

/** `{what}` of a loop nudge, built from the trip (§5.4). */
export function loopTripWhat(trip: { rule: 'repeat' | 'window'; tool: string; count: number; testCommand: string | null }): string {
  if (trip.testCommand !== null) return `You have run \`${trip.testCommand}\` ${trip.count} times with the same failing tests`;
  if (trip.rule === 'repeat') return `You have called ${trip.tool} with the same arguments ${trip.count} times in a row and got the same result`;
  return `You have made the same ${trip.tool} call with the same result ${trip.count} times in your last 10 calls`;
}
