/**
 * The agent-mode propose stage (docs/AGENT-LOOP-DESIGN.md §2.1, §2.2): the engine-side twin of `stages/synth.ts`, plus every
 * helper of the engine seam that needs no private engine state — the per-step change set (§3.4), the rule `RiskAssessment` of a
 * gate (§12), the truthful note of a destructive command that ran (§A2, §A5), the completion predicate's unscoped-run test
 * (§3.3), and the stream tap that turns the provider's tool-call and reasoning callbacks into events (§9.3).
 *
 * The driver itself lives in `src/agent/` and is reached only through the `AgentDriver` contract (`src/core/types.ts`); nothing
 * here imports it, so the engine compiles and tests against a fake driver.
 */
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../../core/atomic.js';
import { OUTPUTS_DIR_MAX_BYTES, OUTPUT_FILE_MAX_CHARS, OUTPUT_READ_PREFIX } from '../../core/limits.js';
import { clip, headTail } from '../../core/text.js';
import { CHECKPOINT_FILES } from '../../checkpoint/store.js';
import { RISK_DIMENSIONS } from '../../core/types.js';
import type {
  Action,
  ActionOutcome,
  AgentContext,
  AgentDriver,
  AgentGate,
  AgentNext,
  EngineEvent,
  LastTestRun,
  Proposal,
  RiskAssessment,
  RiskDimension,
  RiskDimensionResult,
  TestCommand,
  ToolCallDelta,
} from '../../core/types.js';
import { preImagePath, type PostImage, type PreImageEntry, type PreImageResult } from '../../checkpoint/images.js';
import { sha256Hex } from '../../core/hash.js';
import type { StageContext } from '../engine.js';

// ---------------------------------------------------------------------------------------
// The engine's agent constants (docs/AGENT-LOOP-DESIGN.md §11). `src/agent/limits.ts` (slice S3) holds every constant the
// DRIVER reads; these are the ones the ENGINE enforces, kept here so the engine seam does not import the driver's modules.
// ---------------------------------------------------------------------------------------

/** §3.6 / §8: loop trips answered with a nudge; the trip after the last one stops the run `stuck` (exit 4, resumable). */
export const AGENT_MAX_LOOP_NUDGES = 5;
/** §8 / §A2: gate refusals in one process before the run pauses for a human (`human_pause`, resumable, no prompt). */
export const AGENT_MAX_BLOCKS = 5;
/** §10: `CheckpointState.agentState` is at most this many bytes of JSON. */
export const AGENT_STATE_MAX_BYTES = 65_536;
/** §9.3: `generator:reasoning` is throttled to one event per this many ms. */
export const AGENT_REASONING_EVENT_MS = 100;
/** §9.2: `generator:reasoning.tail` is the last line of the reasoning so far, at most this many chars. */
export const AGENT_REASONING_TAIL_CHARS = 120;
/** §9.1: the target a `generator:tool-delta` names (`writing edit_file src/a.ts…`), at most this many chars. */
export const AGENT_TOOL_TARGET_CHARS = 80;
/** §8: the transcript line of the AGENT_MAX_BLOCKS stop. */
export const AGENT_MAX_BLOCKS_LINE = `the agent hit the destructive-command rules ${AGENT_MAX_BLOCKS} times; review, then resume`;
/** §2.2: a harness-seeded step (`seedStep`, `/land`'s merge and pre-flight) is refused in agent mode — the driver proposes every step. */
export const AGENT_SEEDED_STEP_REFUSED = "harness-seeded steps (/land's merge and pre-flight) are not available in agent mode yet; nothing was merged, committed or stashed";

// ---------------------------------------------------------------------------------------
// The stage (§2.2)
// ---------------------------------------------------------------------------------------

/**
 * One `AgentDriver.next`, as the propose stage: the proposal's free text is redacted like a generator reply (the driver built it
 * from model prose and call arguments) and announced; the engine then finishes the step by its kind.
 */
export async function runAgentStage(ctx: StageContext, driver: AgentDriver, actx: AgentContext): Promise<AgentNext> {
  const next = await driver.next(actx);
  const proposal: Proposal = { ...next.proposal, rawText: ctx.redact(next.proposal.rawText) };
  ctx.emit({ type: 'proposal', step: ctx.step, proposal });
  return { ...next, proposal };
}

// ---------------------------------------------------------------------------------------
// The gate (§12)
// ---------------------------------------------------------------------------------------

const ZERO_DIMENSION: RiskDimensionResult = { risk: 0, probability: 0, expected: 0, tailMass: 0, bound: 'expected', confidence: 0, level: 0 };

/**
 * §9.4 / §12: the classifier's verdict as the step's `RiskAssessment` — the rule's sentence as the reason, the rule id in `rule`,
 * zeroed dimensions (never drawn: no Jev Score was asked). `risk` is 1 for anything a rule matched or the gate held (a review of
 * an `unknown` command), 0 otherwise.
 */
export function ruleRiskAssessment(gate: AgentGate): RiskAssessment {
  const dims = {} as Record<RiskDimension, RiskDimensionResult>;
  for (const d of RISK_DIMENSIONS) dims[d] = { ...ZERO_DIMENSION };
  const risk = gate.verdict === 'ok' && gate.rule === null ? 0 : 1;
  return { dims, risk, verdict: gate.verdict, reason: gate.reason, ...(gate.rule !== null ? { rule: gate.rule } : {}) };
}

/**
 * §8 / §A2: a destructive refusal AGENT_MAX_BLOCKS counts — a gate `block` the engine refused, or a rule-matched `review` the human
 * declined (the classifier never blocks: under `--autonomy review` a destructive command is a y/n card, and a `n` is the refusal).
 * A declined review of an `unknown` command (no rule) is not a destructive refusal.
 */
export function isAgentRefusal(gate: AgentGate | null, outcome: ActionOutcome | null): boolean {
  if (gate === null || outcome === null) return false;
  if (gate.verdict === 'block') return outcome.status === 'blocked';
  return gate.verdict === 'review' && gate.rule !== null && outcome.status === 'declined';
}

/** Rules whose effect leaves the machine: neither the sandbox nor a pre-image can contain it (§A5). */
export const LEFT_MACHINE_RULES: ReadonlySet<string> = new Set(['force_push', 'publish', 'exfiltrate', 'remote_exec']);

/** §A5: what `/undo` can do about a destructive command that ran. */
export type DestructiveCoverage = 'left-machine' | 'restores' | 'may-not';

// `git_discard` forms whose whole effect is on workspace files (the dirty set a `run` pre-images, §12.3)
const DISCARD_ON_FILES = /\bgit\b[^;&|\n]*\b(?:reset\s+[^;&|\n]*--hard|checkout|restore|switch|clean)\b/;
// forms that destroy something no pre-image holds: a stash, a branch, a worktree, or ignored files (`clean -x` / `-X`)
const DISCARD_BEYOND_FILES = /\bgit\b[^;&|\n]*\b(?:stash|branch|worktree)\b|\bgit\b[^;&|\n]*\bclean\b[^;&|\n]*\s-[a-zA-Z]*[xX]/;

/**
 * §A5 truthful notes. The sandbox and the pre-images contain only LOCAL workspace effects, so:
 * - a rule that leaves the machine → `left-machine`, whatever was captured;
 * - `git_discard` of workspace files, with every dirty file captured, both images whole and HEAD where it was → `restores`;
 * - everything else (no OS sandbox on Linux, a capped or failed pre-image, a moved HEAD, a stash / branch / worktree, ignored
 *   files) → `may-not`. Anything not provably covered says so.
 */
export function destructiveCoverage(i: { rule: string; command: string; imagesComplete: boolean; headMoved: boolean }): DestructiveCoverage {
  if (LEFT_MACHINE_RULES.has(i.rule)) return 'left-machine';
  if (i.rule === 'git_discard' && i.imagesComplete && !i.headMoved && DISCARD_ON_FILES.test(i.command) && !DISCARD_BEYOND_FILES.test(i.command)) return 'restores';
  return 'may-not';
}

/** §A2 / §A5: the one transcript line a destructive command that ran leaves (the rule id also rides `StepRecord.risk.rule`). */
export function destructiveNote(command: string, rule: string, coverage: DestructiveCoverage): string {
  const cmd = clip(command.replace(/\s+/g, ' ').trim(), 120);
  const tail = coverage === 'left-machine' ? 'this left the machine; /undo cannot reverse it' : coverage === 'restores' ? '/undo restores the workspace' : '/undo may not restore this';
  return `destructive · ran ${cmd} (rule ${rule}) — ${tail}`;
}

// ---------------------------------------------------------------------------------------
// Completion (§3.3)
// ---------------------------------------------------------------------------------------

/** A `bash` workdir that is the workspace root: absent, empty, `.` or `./`. */
export function isRootCwd(cwd: string | undefined): boolean {
  return cwd === undefined || cwd === '' || cwd === '.' || cwd === './';
}

function normaliseCommand(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * The command a test run is recorded under (`LastTestRun.command`): the command itself at the root, `cd <cwd> && <command>`
 * anywhere else — the truth of where it ran, and exactly what keeps a subdirectory run from reading as the unscoped command.
 */
export function recordedTestCommand(command: string, cwd: string | undefined): string {
  return isRootCwd(cwd) ? command : `cd ${cwd} && ${command}`;
}

/**
 * §3.3: the last test run is the UNSCOPED detected command — its normalised text equals `testCommand.command` (a scoped form,
 * `pytest -q tests/test_a.py`, and a subdirectory run, `cd pkg && npm test`, do not) — parsed (only parsed runs become
 * `LastTestRun`) and all green. Currency against `lastChangeStep` is the caller's.
 */
export function isUnscopedGreenRun(run: LastTestRun | null, testCommand: TestCommand | null): boolean {
  if (run === null || testCommand === null || !run.allPassed) return false;
  return normaliseCommand(run.command) === normaliseCommand(testCommand.command);
}

// ---------------------------------------------------------------------------------------
// The per-step change set (§3.4)
// ---------------------------------------------------------------------------------------

async function sameAsPre(root: string, runDir: string, step: number, e: PreImageEntry, post: PostImage | null): Promise<boolean> {
  const abs = join(root, e.path);
  let size: number | null = null;
  let regular = false;
  try {
    const st = await lstat(abs);
    size = st.size;
    regular = st.isFile();
  } catch {
    size = null;
  }
  if (e.existed !== (size !== null)) return false;
  if (size === null || !regular) return true;
  if (e.bytes !== null && e.bytes !== size) return false;
  // open risk 11: a dirty-before file with no pre copy (size or cap skip) and an unchanged size counts as unchanged
  if (!e.copied) return true;
  let before: Buffer;
  try {
    before = await readFile(preImagePath(runDir, step, e.path));
  } catch {
    return false;
  }
  const hashed = post?.files[e.path]?.sha256;
  if (typeof hashed === 'string') return sha256Hex(before) === hashed;
  try {
    return (await readFile(abs)).equals(before);
  } catch {
    return false;
  }
}

/**
 * The files of the step's pre-image (the dirty set before a `run`) whose bytes, size or existence differ now — which includes
 * the files dirty at RUN start that `Workspace.changedFiles()` never reports. Bounded by the pre-image caps (200 files / 16 MiB);
 * a post image's hash is used where it exists, so a file is read at most once more.
 */
export async function changedSincePre(i: { root: string; runDir: string; step: number; pre: PreImageResult | null; post?: PostImage | null }): Promise<string[]> {
  if (i.pre === null) return [];
  const out: string[] = [];
  for (const e of i.pre.entries) if (!(await sameAsPre(i.root, i.runDir, i.step, e, i.post ?? null))) out.push(e.path);
  return out;
}

export interface StepChangeInput {
  action: Action;
  outcome: ActionOutcome | null;
  /** the run's changed files at step start (`Workspace.changedFiles()` before the step) */
  before: readonly string[];
  /** the run's changed files after execute (`ExecuteStageResult.changedFiles`, or the rule-2 re-read) */
  after: readonly string[];
  /** this step's pre-images; null when none were taken */
  pre: PreImageResult | null;
  /** `changedSincePre` when the engine already computed it (before the post images), else null */
  preChanged: readonly string[] | null;
  post: PostImage | null;
  root: string;
  runDir: string;
  step: number;
}

/**
 * §3.4: the files THIS step changed — for `edit` / `write` / `patch` the executed target, for a `run`
 *   (after \ before) ∪ (before \ after) ∪ { p in the pre-image whose bytes, size or existence differ now }
 * plus any p in before ∩ after with no pre-image entry (the image failed: unknown counts as changed). Nothing for a refused or
 * declined step, a read or a `done`. Sorted.
 */
export async function stepChangeSet(i: StepChangeInput): Promise<string[]> {
  const kind = i.action.kind;
  if (kind === 'edit' || kind === 'write' || kind === 'patch') return i.outcome?.status === 'executed' ? [...i.outcome.changedFiles].sort() : [];
  if (kind !== 'run') return [];
  const status = i.outcome?.status;
  if (status === 'blocked' || status === 'declined' || status === undefined) return [];
  const before = new Set(i.before);
  const after = new Set(i.after);
  const out = new Set<string>();
  for (const p of after) if (!before.has(p)) out.add(p);
  for (const p of before) if (!after.has(p)) out.add(p);
  const imaged = new Set((i.pre?.entries ?? []).map((e) => e.path));
  for (const p of before) if (after.has(p) && !imaged.has(p)) out.add(p);
  const fromPre = i.preChanged ?? (await changedSincePre({ root: i.root, runDir: i.runDir, step: i.step, pre: i.pre, post: i.post }));
  for (const p of fromPre) out.add(p);
  return [...out].sort();
}

// ---------------------------------------------------------------------------------------
// Spilled outputs (§7.2)
// ---------------------------------------------------------------------------------------

/** A spill part number the store's naming can carry: a positive safe integer (anything else writes the whole-step file). */
export function isOutputPart(part: number | undefined): part is number {
  return part !== undefined && Number.isSafeInteger(part) && part >= 1;
}

/**
 * §7.2: the part files' own per-run byte bound. The store's OUTPUTS_DIR_MAX_BYTES ledger reads `step-<n>.txt` names only, so the
 * parts keep a ledger of their own under the same bound; a part past it is not written (the result keeps its inline head and tail).
 */
export const AGENT_OUTPUT_PARTS_MAX_BYTES = OUTPUTS_DIR_MAX_BYTES;
const OUTPUT_PART_RE = /^step-[1-9]\d{0,8}-[1-9]\d{0,8}\.txt$/;

/** The part files of this run by name → bytes: read from disk once, on the run's first part write (a resumed run's parts count). */
export interface OutputPartLedger {
  sizes: Promise<Map<string, number>> | null;
}

export function createOutputPartLedger(): OutputPartLedger {
  return { sizes: null };
}

async function scanOutputParts(dir: string): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return sizes;
  }
  for (const n of names) {
    if (!OUTPUT_PART_RE.test(n)) continue;
    try {
      sizes.set(n, (await stat(join(dir, n))).size);
    } catch {
      /* gone between readdir and stat */
    }
  }
  return sizes;
}

/**
 * §7.2: one more spilled result of an observe step that spills several — `outputs/step-<n>-<k>.txt` beside the store's
 * `step-<n>.txt`, clipped and redacted exactly as `CheckpointStore.writeOutput` clips and redacts. Returns the `jevcode:` pointer
 * the tool result names, or null when the part would take the run's parts past AGENT_OUTPUT_PARTS_MAX_BYTES (nothing written).
 */
export async function writeOutputPart(runDir: string, step: number, part: number, text: string, redact: (s: string) => string, ledger: OutputPartLedger): Promise<string | null> {
  const name = `step-${step}-${part}.txt`;
  const body = redact(text.length > OUTPUT_FILE_MAX_CHARS ? headTail(text, OUTPUT_FILE_MAX_CHARS - 4_096, 4_000) : text);
  const bytes = Buffer.byteLength(body, 'utf8');
  const dir = join(runDir, CHECKPOINT_FILES.outputs);
  ledger.sizes ??= scanOutputParts(dir);
  const sizes = await ledger.sizes;
  let others = 0;
  for (const [n, b] of sizes) if (n !== name) others += b;
  if (others + bytes > AGENT_OUTPUT_PARTS_MAX_BYTES) return null;
  // booked before the write, so parts written concurrently by one segment see each other
  const prev = sizes.get(name);
  sizes.set(name, bytes);
  try {
    await writeFileAtomic(join(dir, name), body, { mkdir: true });
  } catch (e) {
    if (prev === undefined) sizes.delete(name);
    else sizes.set(name, prev);
    throw e;
  }
  return `${OUTPUT_READ_PREFIX}${CHECKPOINT_FILES.outputs}/${name}`;
}

// ---------------------------------------------------------------------------------------
// The stream tap (§9.3)
// ---------------------------------------------------------------------------------------

// the first path, command or pattern argument in a (partial) JSON argument text, up to where it has streamed so far
const TOOL_TARGET_RE = /"(?:path|file_path|command|cmd|pattern)"\s*:\s*"((?:[^"\\]|\\.)*)/;

/** §9.1: a path, command or pattern parsed from a call's partial JSON arguments, one line, ≤ AGENT_TOOL_TARGET_CHARS; undefined before any. */
export function toolTargetOf(partialArgs: string): string | undefined {
  const m = TOOL_TARGET_RE.exec(partialArgs);
  if (m === null || m[1] === undefined) return undefined;
  const text = m[1].replace(/\\(.)/g, (_all, c: string) => (c === 'n' || c === 't' || c === 'r' ? ' ' : c)).replace(/\s+/g, ' ').trim();
  return text.length === 0 ? undefined : clip(text, AGENT_TOOL_TARGET_CHARS);
}

/** §9.2: the last non-empty line of the reasoning so far, its tail when it is longer than AGENT_REASONING_TAIL_CHARS. */
export function reasoningTail(text: string): string {
  const lines = text.split('\n');
  for (let k = lines.length - 1; k >= 0; k--) {
    const line = lines[k]!.replace(/\s+/g, ' ').trim();
    if (line.length === 0) continue;
    return line.length <= AGENT_REASONING_TAIL_CHARS ? line : `…${line.slice(-(AGENT_REASONING_TAIL_CHARS - 1))}`;
  }
  return '';
}

export interface AgentStreamTap {
  /** `GenerateOptions.onToolCall`: remembers the call being written and its partial arguments, then forwards to the driver */
  toolCall(d: ToolCallDelta): void;
  /** the `tool` / `target` members of the next `generator:tool-delta` (empty before any `onToolCall`) */
  toolFields(): { tool?: string; target?: string };
  /** `GenerateOptions.onReasoning`: counts and emits `generator:reasoning`, at most one event per AGENT_REASONING_EVENT_MS */
  reasoning(fragment: string): void;
  /** the throttled reasoning progress not yet emitted, once, when the turn's result arrived */
  flush(): void;
}

/** How much reasoning text the tap keeps to find the last line (the count is exact; only the tail is kept). */
const REASONING_KEEP_CHARS = 2_048;

/**
 * §9.3: what `Engine.generate` adds for a call that carries agent hooks. `generator:delta` and the retry reset stay in the engine
 * (they are one line each); this holds the per-turn state of the tool-call and reasoning callbacks. The provider fires
 * `onToolCall` and `onToolDelta` per fragment; the `tool` / `target` a tool-delta names is what the tap knew when it fired.
 */
export function createAgentStreamTap(o: { step: number; turn: number; now: () => number; emit: (e: EngineEvent) => void; onToolCall?: (d: ToolCallDelta) => void }): AgentStreamTap {
  const calls = new Map<number, { name: string | undefined; args: string }>();
  let current: number | null = null;
  let reasoningChars = 0;
  let reasoningText = '';
  let lastEmitAt = Number.NEGATIVE_INFINITY;
  let pending = false;
  const emitReasoning = (): void => {
    o.emit({ type: 'generator:reasoning', step: o.step, turn: o.turn, chars: reasoningChars, tail: reasoningTail(reasoningText) });
    lastEmitAt = o.now();
    pending = false;
  };
  return {
    toolCall(d) {
      const held = calls.get(d.index) ?? { name: undefined, args: '' };
      if (d.name !== undefined && d.name.length > 0) held.name = d.name;
      held.args += d.fragment;
      calls.set(d.index, held);
      current = d.index;
      o.onToolCall?.(d);
    },
    toolFields() {
      const held = current === null ? undefined : calls.get(current);
      if (held === undefined) return {};
      const target = toolTargetOf(held.args);
      return { ...(held.name !== undefined ? { tool: held.name } : {}), ...(target !== undefined ? { target } : {}) };
    },
    reasoning(fragment) {
      if (fragment.length === 0) return;
      reasoningChars += fragment.length;
      reasoningText = (reasoningText + fragment).slice(-REASONING_KEEP_CHARS);
      if (o.now() - lastEmitAt >= AGENT_REASONING_EVENT_MS) emitReasoning();
      else pending = true;
    },
    flush() {
      if (pending) emitReasoning();
    },
  };
}
