/**
 * The five Jev question groups (docs/IMPORT-DESIGN.md §4.4.3), their batching, their budget and
 * their answer floors.
 *
 * §0 principle 3 — **Jev sees shapes, not content.** A request carries paths, byte counts,
 * sha256 prefixes, frontmatter *keys*, heading *texts* (already redacted and clipped by the
 * parser), charset/entropy *buckets* and similarity scores. It never carries a file body, and it
 * never carries one byte of a candidate secret — not a prefix, not a character. `--jev-sample` is
 * the only knob that widens this, and under `none` group V is suppressed entirely **[G2.4]**.
 *
 * §0 principle 4 — **the conservative side on abstention.** 401 / 402 / 429 / timeout /
 * `--no-jev` / `--mock` / over-budget all return a *complete* `JevOutcome` with `reason` set and
 * no answers. `askImport` never throws.
 *
 * Every question is built through `src/jev/questions.ts`, so the REPORT rules hold by
 * construction: a definition plus ≥ 2 examples on **both** sides of every Noul, an escape option
 * and a paired `can_` Noul on every Choice, 2–10 situation levels on every Score. Jev is never
 * asked to count anything.
 *
 * Pure, except for one `Decider.ask` per batch in `askImport`.
 */
import { IMPORT_LIMITS } from '../core/limits.js';
import type { Answer, Decider, Json, Question } from '../core/types.js';
import { JevHttpError } from '../errors.js';
import { ESCAPE_KEY, PAIRED_PREFIX, assertQuestionBatch, choice, noul, pairedNouls, ref, score } from '../jev/questions.js';
import type { ValueShape } from './types.js';

// ---------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------

/** §4.4.3 / §5.6: how much of a body may travel. `none` also suppresses group V entirely [G2.4]. */
export type JevSample = 'none' | 'headings' | 'head400';

/** §4.4.3 group I. `shape` is the only description of the value, and it holds no substring of it. */
export interface SecretCandidate {
  id: string;
  dotted: string;
  leaf: string;
  path: string;
  shape: ValueShape;
  fileClass: string;
}

/** §4.4.3 group II. `headings` are already redacted and clipped by the parser (≤ 5, ≤ 80 cells). */
export interface FileCandidate {
  id: string;
  path: string;
  bytes: number;
  lines: number;
  fences: number;
  frontmatterKeys: readonly string[];
  headings: readonly string[];
}

/** §4.4.3 group III: one near-duplicate pair, in band (Jaccard ∈ [0.6, 0.9)). */
export interface PairCandidate {
  id: string;
  a: { path: string; tool: string; bytes: number; sha8: string; headings: readonly string[] };
  b: { path: string; tool: string; bytes: number; sha8: string; headings: readonly string[] };
  jaccard: number;
  commonHeadingRun: number;
}

/** §4.4.3 group IV: one note competing for an index line. */
export interface NoteCandidate {
  id: string;
  path: string;
  kind: string;
  scope: string;
  bytes: number;
}

/** §4.4.3 group V [G2.4]: headings, the matched noun phrase and the two polarity markers — not the sentences. */
export interface ConflictCandidate {
  id: string;
  headings: readonly string[];
  noun: string;
  positiveMarker: string;
  negativeMarker: string;
  sentences?: readonly string[];
}

/** One request's worth of work: the state Jev reasons over, its questions, and which groups they came from. */
export interface QuestionBatch {
  state: Json;
  questions: Record<string, Question>;
  groups: readonly ('I' | 'II' | 'III' | 'IV' | 'V')[];
}

const EMPTY: QuestionBatch = { state: {}, questions: {}, groups: [] };

/** §4.4.3 group II: ≤ `jevHeadings` (5) per file, each clipped to `jevHeadingCells` (80). */
function clipHeadings(headings: readonly string[]): string[] {
  return headings.slice(0, IMPORT_LIMITS.jevHeadings).map((h) => h.slice(0, IMPORT_LIMITS.jevHeadingCells));
}

/**
 * §4.4.3: the paired Noul id for one option of one Choice. `src/jev/questions.ts pairedNouls`
 * keys by `can_<option>` alone, which is unique only when a batch holds **one** Choice; an import
 * batch holds one Choice per candidate file, so the candidate's own suffix is appended. The
 * `can_` prefix — the thing `PAIRED_PREFIX` exists for — is preserved.
 */
export function pairedIdFor(choiceId: string, option: string): string {
  const suffix = choiceId.slice(choiceId.lastIndexOf('_') + 1);
  return `${PAIRED_PREFIX}${option}_${suffix}`;
}

// ---------------------------------------------------------------------------------------
// Group I — is_secret
// ---------------------------------------------------------------------------------------

const SECRET_TRUE_EXAMPLES = [
  'a 51-character alphanumeric value at env.ANTHROPIC_API_KEY',
  'a 64-character hex value at mcpServers.github.env.GITHUB_TOKEN',
  'a 40-character base64url value at headers.Authorization',
];
const SECRET_FALSE_EXAMPLES = [
  'a 64-character hex value at instructions[0].sha256',
  'a 36-character uuid at projects.machineID',
  'the string ${OPENROUTER_API_KEY} at mcpServers.x.env.OPENROUTER_API_KEY',
  'the value z-ai/glm-5.3-flash at model',
];

/**
 * §4.4.3 group I — `is_secret`, asked only for keys the code left in the rule-8 band.
 *
 * The state carries `{ name, path, file, length, charset, entropyBucket, family, fileClass }`
 * per candidate: **no value bytes, no substring, not even a prefix.** Jev may promote a band item
 * into the secret class and may never demote one out of it (`joinSecretVerdict`).
 */
export function secretQuestions(cands: readonly SecretCandidate[]): QuestionBatch {
  if (cands.length === 0) return EMPTY;
  const questions: Record<string, Question> = {};
  const candidates = cands.map((c, i) => {
    questions[`secret_${i}`] = noul(
      `Is the value stored at ${ref(c.dotted)} in ${ref(c.path)} a credential — an API key, token, password or private key? You are given its shape only: ${c.shape.length} characters, ${c.shape.charset}, ${c.shape.entropyBucket} entropy.`,
      {
        true: {
          definition: 'the value is a secret a service accepts as proof of identity, and publishing it would let someone else act as this user',
          examples: SECRET_TRUE_EXAMPLES,
        },
        false: {
          definition: 'the value identifies, configures or describes something and is safe to publish',
          examples: SECRET_FALSE_EXAMPLES,
        },
      },
    );
    return {
      id: c.id,
      index: i,
      name: c.leaf,
      path: c.dotted,
      file: c.path,
      length: c.shape.length,
      charset: c.shape.charset,
      entropyBucket: c.shape.entropyBucket,
      family: c.shape.family,
      fileClass: c.fileClass,
    };
  });
  return { state: { candidates }, questions, groups: ['I'] };
}

// ---------------------------------------------------------------------------------------
// Group II — file_kind
// ---------------------------------------------------------------------------------------

/** §4.4.3 group II: the five readings, verbatim, plus the escape option `choice()` adds. */
export const FILE_KIND_OPTIONS: Readonly<Record<string, string>> = {
  instructions_for_an_agent: 'a standing instruction, convention or preference an agent should follow while working in this project',
  saved_workflow_or_command: 'a reusable prompt or procedure a human invokes by name, usually with arguments',
  tool_configuration: 'settings for a tool: models, paths, servers, permissions',
  conversation_log_or_transcript: 'a record of what was said or done, written by a tool',
  unrelated_project_file: 'source, documentation or data that belongs to the project and is not about how an agent should behave',
};

/** §4.4.3 group II: the `true`-side example pairs of each paired Noul. */
const KIND_TRUE_EXAMPLES: Readonly<Record<string, readonly string[]>> = {
  instructions_for_an_agent: ['a CLAUDE.md saying "never write prose before a patch"', 'a rules file listing the test command to use in this repo', 'a note recording that this project prefers tabs'],
  saved_workflow_or_command: ['a commands/ft.md whose body is "Run $1 and explain the first failure"', 'a prompt file with an argument-hint of "<test path>"', 'a saved procedure titled "release checklist" a human invokes by name'],
  tool_configuration: ['a settings.json with model and permissions keys', 'a config.toml with an [mcp_servers.github] table', 'a jsonc file listing editor paths and servers'],
  conversation_log_or_transcript: ['a .jsonl file of assistant and user turns', 'a session log with timestamps and tool calls', 'a history file a tool appended to after every message'],
  unrelated_project_file: ['a README describing what the package does for its users', 'a CHANGELOG of released versions', 'a data file of fixture rows'],
};
const KIND_FALSE_EXAMPLES: Readonly<Record<string, readonly string[]>> = {
  instructions_for_an_agent: ['a transcript of a past conversation', 'a README aimed at the package’s users', 'a settings file of key/value pairs'],
  saved_workflow_or_command: ['a standing convention with no arguments and nothing to invoke', 'a list of servers and their transports', 'a record of what happened last Tuesday'],
  tool_configuration: ['a prose note about how work is done here', 'a saved prompt with $ARGUMENTS in it', 'a log of tool calls'],
  conversation_log_or_transcript: ['a standing instruction file', 'a configuration file', 'a reusable prompt'],
  unrelated_project_file: ['a rules file scoped by globs', 'a memory topic describing a preference', 'a saved command'],
};

/**
 * §4.4.3 group II — `file_kind`, asked only for files in the file-rule band (rows 11 and 12).
 *
 * The state carries `{ path, bytes, lines, fences, frontmatterKeys, headings }`; `headings`
 * appears only under `--jev-sample=headings` (the default) or `head400`, and never under `none`.
 * Every option gets a paired `can_` Noul with a definition and three examples on both sides.
 */
export function fileKindQuestions(cands: readonly FileCandidate[], sample: JevSample): QuestionBatch {
  if (cands.length === 0) return EMPTY;
  const withHeadings = sample !== 'none';
  const questions: Record<string, Question> = {};
  const files = cands.map((c, i) => {
    const choiceId = `kind_${i}`;
    questions[choiceId] = choice(`What is the file at ${ref(c.path)}? It is ${c.bytes} bytes, ${c.lines} lines, with ${c.fences} fenced blocks.`, { ...FILE_KIND_OPTIONS });
    const paired = pairedNouls(FILE_KIND_OPTIONS as Record<string, string>, (option, description) => ({
      instructions: `Could the file at ${ref(c.path)} be ${description}?`,
      criteria: {
        true: { definition: description, examples: [...(KIND_TRUE_EXAMPLES[option] ?? [])] },
        false: { definition: `the file is something other than ${description}`, examples: [...(KIND_FALSE_EXAMPLES[option] ?? [])] },
      },
    }));
    for (const [key, q] of Object.entries(paired)) questions[`${key}_${i}`] = q;
    return {
      id: c.id,
      index: i,
      path: c.path,
      bytes: c.bytes,
      lines: c.lines,
      fences: c.fences,
      frontmatterKeys: [...c.frontmatterKeys],
      ...(withHeadings ? { headings: clipHeadings(c.headings) } : {}),
    };
  });
  return { state: { files }, questions, groups: ['II'] };
}

// ---------------------------------------------------------------------------------------
// Group III — same_meaning
// ---------------------------------------------------------------------------------------

/**
 * §4.4.3 group III — `same_meaning`, asked only for pairs whose normalised-token Jaccard is in
 * `[0.6, 0.9)`. Identical sha256 and Jaccard ≥ 0.9 are decided by code; below 0.6 is decided by
 * code. The state carries both paths, tools, byte counts, sha256 prefixes, heading lists, the
 * Jaccard value and the longest common heading run — never a body.
 *
 * `headings` obey `--jev-sample` exactly as group II's do: **never under `none`**. A heading is
 * body text — the one payload in this group a redactor has to be right about — so the flag that
 * says "send no sample" has to mean it here too. The pair is still asked about; only the
 * heading lists are withheld, and the Jaccard, the byte counts and the sha256 prefixes are
 * enough for the question to stand on.
 */
export function sameMeaningQuestions(cands: readonly PairCandidate[], sample: JevSample = 'headings'): QuestionBatch {
  if (cands.length === 0) return EMPTY;
  const withHeadings = sample !== 'none';
  const questions: Record<string, Question> = {};
  const pairs = cands.map((c, i) => {
    questions[c.id] = noul(
      `Do the two files in pairs[${i}] — ${ref(c.a.path)} and ${ref(c.b.path)} — say the same thing, so that importing both would store the same instruction twice?`,
      {
        true: {
          definition: 'one file is a copy, a rename or a light edit of the other: keeping both would give an agent the same instruction twice with nothing added',
          examples: [
            'the same AGENTS.md reached through two tools, one with a heading renamed',
            'a CLAUDE.md that is a one-line @AGENTS.md include, resolved to the same text',
            'two rule files with identical bodies and different frontmatter descriptions',
          ],
        },
        false: {
          definition: 'the two files overlap in wording but carry different instructions, different scopes or different examples, so dropping one would lose something',
          examples: [
            'a user-scope preference file and a project-scope rule that share boilerplate headings',
            'two package rules in a monorepo with the same shape and different paths',
            'a short note and a long document that quotes it and then adds three more rules',
          ],
        },
      },
    );
    return {
      id: c.id,
      index: i,
      a: { path: c.a.path, tool: c.a.tool, bytes: c.a.bytes, sha8: c.a.sha8, ...(withHeadings ? { headings: clipHeadings(c.a.headings) } : {}) },
      b: { path: c.b.path, tool: c.b.tool, bytes: c.b.bytes, sha8: c.b.sha8, ...(withHeadings ? { headings: clipHeadings(c.b.headings) } : {}) },
      jaccard: Number(c.jaccard.toFixed(3)),
      commonHeadingRun: c.commonHeadingRun,
    };
  });
  return { state: { pairs }, questions, groups: ['III'] };
}

// ---------------------------------------------------------------------------------------
// Group IV — matters_here
// ---------------------------------------------------------------------------------------

/** §4.4.3 group IV: the five situation levels, most actionable first. The Score only *orders* the index; it never drops a note. */
export const RANK_LEVELS: readonly string[] = [
  'it names a file, command or rule in this repository that an agent would otherwise get wrong',
  'it states a durable preference about how work is done here',
  'it records the state of a branch or task that is still open',
  'it records something that happened and is now finished',
  'it is about a different project, or about a tool that is not installed',
];

/**
 * §4.4.3 group IV — `matters_here`, asked only when the plan exceeds `memoryIndexLines`. The
 * index holds the top N by level, ties broken by the code order of `rankIndex`. **Nothing is
 * dropped**: everything not indexed is still written as an on-demand topic file.
 */
export function mattersHereQuestions(cands: readonly NoteCandidate[], workspace: string): QuestionBatch {
  if (cands.length === 0) return EMPTY;
  const questions: Record<string, Question> = {};
  const notes = cands.map((c, i) => {
    questions[c.id] = score(`How likely is the note at ${ref(c.path)} to change what an agent does in ${ref(workspace)} this week?`, [...RANK_LEVELS]);
    return { id: c.id, index: i, path: c.path, kind: c.kind, scope: c.scope, bytes: c.bytes };
  });
  return { state: { workspace, notes }, questions, groups: ['IV'] };
}

// ---------------------------------------------------------------------------------------
// Group V — contradicts
// ---------------------------------------------------------------------------------------

/**
 * §4.4.3 group V — `contradicts`, narrowed by **[G2.4]**: the payload is the headings, the
 * matched noun phrase and the two polarity markers — *not* the two sentences. Jev's effect here
 * is limited to ordering the conflicts section (the verdict is `review` either way), so the
 * weaker payload costs nothing real and the design keeps its "Jev never receives a file body".
 *
 * Suppressed entirely under `--jev-sample=none`; the two sentence fragments travel only under
 * `head400`, already redacted and clipped to `jevSentenceChars`.
 */
export function contradictsQuestions(cands: readonly ConflictCandidate[], sample: JevSample): QuestionBatch {
  if (cands.length === 0 || sample === 'none') return EMPTY;
  const withSentences = sample === 'head400';
  const questions: Record<string, Question> = {};
  const conflicts = cands.map((c, i) => {
    questions[c.id] = noul(
      `In conflicts[${i}], two imported instructions give opposed advice about "${c.noun}": one says "${c.positiveMarker}", the other says "${c.negativeMarker}". Would following both at once be impossible?`,
      {
        true: {
          definition: 'the two instructions cannot both be obeyed about the same object: doing what one asks breaks the other',
          examples: ['"always explain before patching" against "never write prose before a patch"', '"use tabs in this repo" against "avoid tabs, indent with spaces"'],
        },
        false: {
          definition: 'the two instructions are about different objects, different scopes or different moments, so both can hold at once',
          examples: ['"never commit without tests" and "always run the linter" — different objects', '"prefer short commits on this branch" and "avoid long commits in release" — different scopes'],
        },
      },
    );
    return {
      id: c.id,
      index: i,
      headings: [...c.headings],
      noun: c.noun,
      positiveMarker: c.positiveMarker,
      negativeMarker: c.negativeMarker,
      ...(withSentences && c.sentences ? { sentences: c.sentences.map((s) => s.slice(0, IMPORT_LIMITS.jevSentenceChars)) } : {}),
    };
  });
  return { state: { conflicts }, questions, groups: ['V'] };
}

// ---------------------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------------------

function countQuestions(b: QuestionBatch): number {
  return Object.keys(b.questions).length;
}

function mergeTwo(a: QuestionBatch, b: QuestionBatch): QuestionBatch {
  const stateA = typeof a.state === 'object' && a.state !== null && !Array.isArray(a.state) ? a.state : {};
  const stateB = typeof b.state === 'object' && b.state !== null && !Array.isArray(b.state) ? b.state : {};
  return { state: { ...stateA, ...stateB }, questions: { ...a.questions, ...b.questions }, groups: [...a.groups, ...b.groups] };
}

/**
 * §4.4.3: one `Decider.ask` per group, except that **groups I + II + III share one request when
 * all three are non-empty and the batch is ≤ `jevQuestions` (400)**. Empty batches are dropped;
 * `assertQuestionBatch` is the backstop on every batch returned.
 */
export function mergeBatches(batches: readonly QuestionBatch[], maxQuestions: number = IMPORT_LIMITS.jevQuestions): readonly QuestionBatch[] {
  const live = batches.filter((b) => countQuestions(b) > 0);
  if (live.length === 0) return [];
  const isShareable = (b: QuestionBatch): boolean => b.groups.every((g) => g === 'I' || g === 'II' || g === 'III');
  const shareable = live.filter(isShareable);
  const rest = live.filter((b) => !isShareable(b));
  const out: QuestionBatch[] = [];
  const distinct = new Set(shareable.flatMap((b) => b.groups));
  const total = shareable.reduce((n, b) => n + countQuestions(b), 0);
  if (shareable.length > 1 && distinct.size === 3 && total <= maxQuestions) {
    out.push(shareable.reduce(mergeTwo));
  } else {
    out.push(...shareable);
  }
  out.push(...rest);
  for (const b of out) assertQuestionBatch(b.questions);
  return out;
}

// ---------------------------------------------------------------------------------------
// Asking — §4.9, the degradation matrix
// ---------------------------------------------------------------------------------------

/** What `askImport` needs. `decider === null` is `--no-jev` / `--mock`: no request is made at all. */
export interface AskDeps {
  decider: Decider | null;
  signal: AbortSignal;
  maxUsd: number;
  requests?: number;
}

/** §4.6.1 `ImportPlan.jev`: always complete, even when nothing was asked. `fallbacks` counts the questions the code answered instead. */
export interface JevOutcome {
  answers: Readonly<Record<string, Answer>>;
  requests: number;
  questions: number;
  usd: number;
  fallbacks: number;
  reason?: string;
}

/**
 * `jev/types.ts JEV_INPUT_USD_PER_TOKEN` and the two token constants, restated. `src/import/**`
 * may import `src/jev/questions.ts` and nothing else from `src/jev` (§7 ownership), so the three
 * prices are pinned here with their source; `test/unit/import/questions.test.ts` asserts they
 * still equal the client's.
 */
export const JEV_INPUT_USD_PER_TOKEN = 4.2e-8;
export const JEV_TOKEN_OVERHEAD = 271;
export const JEV_TOKENS_PER_CHAR = 0.196;

/** §4.4.4: the pre-flight price of one batch, from its serialised size. Never a reason to fail — only to stop asking. */
export function estimateUsd(batch: QuestionBatch): number {
  const chars = JSON.stringify({ state: batch.state, questions: batch.questions }).length;
  return (JEV_TOKEN_OVERHEAD + chars * JEV_TOKENS_PER_CHAR) * JEV_INPUT_USD_PER_TOKEN;
}

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function reasonOf(e: unknown): string {
  if (e instanceof JevHttpError) return `HTTP ${e.status}`;
  if (e instanceof Error) {
    if (e.name === 'AbortError' || /abort/i.test(e.message)) return 'cancelled';
    if (/timeout|timed out/i.test(e.message)) return 'timeout';
    return e.message.slice(0, 120);
  }
  return 'unknown error';
}

/**
 * §4.9: ask each batch in turn, and **never throw**. A null decider, a throwing decider, an
 * aborted signal, an exhausted `import.jevMaxUsd` and a request cap all return a *complete*
 * outcome with `reason` set; the caller then takes the code fallbacks, which are always the
 * conservative side (§0 principle 4).
 *
 * At most `jevRequests` (3) requests and `jevQuestions` (400) questions in total.
 */
export async function askImport(batches: readonly QuestionBatch[], deps: AskDeps): Promise<JevOutcome> {
  const asked = batches.filter((b) => countQuestions(b) > 0);
  const totalQuestions = asked.reduce((n, b) => n + countQuestions(b), 0);
  const none = (reason: string): JevOutcome => ({ answers: {}, requests: 0, questions: 0, usd: 0, fallbacks: totalQuestions, reason });

  if (asked.length === 0) return { answers: {}, requests: 0, questions: 0, usd: 0, fallbacks: 0 };
  if (deps.decider === null) return none('not asked (--no-jev)');
  if (!(deps.maxUsd > 0)) return none(`not asked (jevMaxUsd ${usd(deps.maxUsd)})`);
  if (deps.signal.aborted) return none('not asked (cancelled)');

  const maxRequests = Math.max(0, Math.min(deps.requests ?? IMPORT_LIMITS.jevRequests, IMPORT_LIMITS.jevRequests));
  if (maxRequests === 0) return none('not asked (request budget 0)');

  const answers: Record<string, Answer> = {};
  let requests = 0;
  let questions = 0;
  let spent = 0;
  let reason: string | undefined;

  for (const batch of asked) {
    if (requests >= maxRequests) {
      reason = `stopped after ${requests} request${requests === 1 ? '' : 's'} (request budget ${maxRequests})`;
      break;
    }
    if (questions + countQuestions(batch) > IMPORT_LIMITS.jevQuestions) {
      reason = `stopped after ${questions} questions (question budget ${IMPORT_LIMITS.jevQuestions})`;
      break;
    }
    if (deps.signal.aborted) {
      reason = 'cancelled';
      break;
    }
    if (spent + estimateUsd(batch) > deps.maxUsd) {
      reason = `stopped after ${requests} request${requests === 1 ? '' : 's'} (jevMaxUsd ${usd(deps.maxUsd)} reached)`;
      break;
    }
    try {
      // jev-contract: import groups I–V — classification hints for `jevcode import` (IMPORT-DESIGN §4.4.3; contract 1.6)
      //   escape: every question in the batch is built by src/jev/questions.ts (choice/noul/score) and `assertQuestionBatch` re-checks the escape option and the paired `can_` Nouls before the batch leaves this file
      //   guard: the answers pass the floors above (CHOICE_FLOOR / PAIRED_NOUL_FLOOR / NOUL_FLOOR) and then the plan's own rules — the five identity rules, the secret-basename and oversize refusals and the destination routing all run after, and can only refuse more
      //   fallback: an unanswered id counts in `fallbacks` and the code classification stands; a reject/timeout/402 returns a complete JevOutcome with `reason` and no answers (askImport never throws); test: test/unit/import/questions.test.ts
      //   no-gating: ordering only — Jev sees shapes, never content (§0 principle 3), and no answer can make a file be written: apply still re-checks every destination
      const res = await deps.decider.ask(batch.state, batch.questions, { signal: deps.signal, stage: 'context', step: 0 });
      requests += 1;
      questions += countQuestions(batch);
      spent += res.usage.costUsd;
      for (const [id, a] of Object.entries(res.answers)) answers[id] = a;
    } catch (e) {
      reason = requests === 0 ? `not asked (${reasonOf(e)})` : `stopped after ${requests} request${requests === 1 ? '' : 's'} (${reasonOf(e)})`;
      break;
    }
  }

  const fallbacks = totalQuestions - Object.keys(answers).filter((id) => answers[id] !== undefined).length;
  return { answers, requests, questions, usd: spent, fallbacks: Math.max(0, fallbacks), ...(reason === undefined ? {} : { reason }) };
}

// ---------------------------------------------------------------------------------------
// The intake floors (`chat/intake.ts:166,214`, `loop/stages/choose.ts:10`)
// ---------------------------------------------------------------------------------------

/**
 * `loop/stages/choose.ts:10 PAIRED_NOUL_FLOOR`, restated. `src/import/**` imports nothing from
 * `src/loop` (§7 ownership); `test/unit/import/questions.test.ts` asserts the two are equal, so a
 * change to the codebase's one confidence convention fails here rather than drifting.
 */
export const PAIRED_NOUL_FLOOR = 0.5;
/** `chat/intake.ts:166 INTAKE_RUN_FLOOR`: a Choice is taken at `p ≥ 0.6` with its paired Noul ≥ the floor. */
export const CHOICE_FLOOR = 0.6;
/** §4.4.3 groups I and V: a bare Noul is taken at `p ≥ 0.5`. */
export const NOUL_FLOOR = 0.5;

/** §4.4.3: the Noul's `p` when it is at or above `floor`, else `null`. Group III passes `CHOICE_FLOOR`. */
export function resolveNoul(answers: Readonly<Record<string, Answer>>, id: string, floor: number = NOUL_FLOOR): number | null {
  const a = answers[id];
  if (!a || a.type !== 'noul') return null;
  if (!Number.isFinite(a.noul) || a.noul < floor) return null;
  return a.noul;
}

/**
 * §4.4.3 group II, the intake idiom (`chat/intake.ts:214`): the chosen option is taken only when
 * `p ≥ 0.6` **and** its paired Noul ≥ `PAIRED_NOUL_FLOOR`. Anything weaker — including the escape
 * option — returns `null`, and the caller keeps the code rule's verdict.
 */
export function resolveChoice(answers: Readonly<Record<string, Answer>>, id: string): { option: string; p: number; paired: number } | null {
  const a = answers[id];
  if (!a || a.type !== 'choice') return null;
  const option = a.choice;
  if (option === ESCAPE_KEY) return null;
  const raw = a.probabilities[option];
  const p = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  const pairedAnswer = answers[pairedIdFor(id, option)];
  const paired = pairedAnswer && pairedAnswer.type === 'noul' && Number.isFinite(pairedAnswer.noul) ? pairedAnswer.noul : 0;
  if (p < CHOICE_FLOOR || paired < PAIRED_NOUL_FLOOR) return null;
  return { option, p, paired };
}

/** §4.4.3 group IV: the level index Jev chose (0 = the most actionable situation), or `null`. */
export function resolveScore(answers: Readonly<Record<string, Answer>>, id: string): number | null {
  const a = answers[id];
  if (!a || a.type !== 'score') return null;
  if (!Number.isFinite(a.score)) return null;
  return Math.max(0, Math.round(a.score));
}
