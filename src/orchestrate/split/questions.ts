/**
 * The two Jev requests of a whole delegation (docs/ORCHESTRATION-DESIGN.md §3.5 request 1, §5.5 request 2).
 *
 * Request 1 at `decompose`: one Choice over the surviving split options, one paired Noul per option, and one
 * literal-fact Noul per agent of the leading option. Request 2 after every agent has finished: one Score per
 * agent, for LANDING ORDER ONLY.
 *
 * The non-obvious invariant: **the state is O(1) in the transcript and in the change size** — every list here
 * is sliced to a constant and every string is clipped to a constant, so a 400-step run and a 40-file diff send
 * exactly as many bytes as a 4-step run and a 1-file diff. That is why nothing in this module takes a window,
 * a transcript or a whole diff. The second bound is `MAX_DECOMPOSE_QUESTIONS`: request 1 is one request, so
 * the self-contained Nouls are dropped from the end rather than allowed to grow the batch (§3.5, "≤ 13 total").
 *
 * Nothing here asks Jev to count, to decide money, to approve a land or to grade a hard rule.
 */
import { clip } from '../../core/text.js';
import { assertQuestionBatch, choice, noul, pairedNouls, ref, score } from '../../jev/questions.js';
import type { Json, JsonObject, Question } from '../../core/types.js';
import type { NormalizedSplit, SplitKind } from '../types.js';

// ---------------------------------------------------------------------------------------
// §3.5 — the option keys (descriptive snake_case; `none_of_these` is added by `choice`)
// ---------------------------------------------------------------------------------------

/** The Choice key of every non-escape `SplitKind`. `rank.ts` maps back with `SPLIT_KIND_OF`. */
export const OPTION_KEY_OF: Readonly<Record<Exclude<SplitKind, 'no_split'>, string>> = {
  by_plan_item: 'split_by_plan_item',
  by_directory: 'split_by_directory',
  by_failing_test: 'split_by_failing_test',
  by_layer: 'split_by_layer',
  as_written: 'split_as_written',
};

/** The inverse of `OPTION_KEY_OF`. `no_split` is never an option key: it is the fallback, not a choice. */
export const SPLIT_KIND_OF: Readonly<Record<string, SplitKind>> = {
  split_by_plan_item: 'by_plan_item',
  split_by_directory: 'by_directory',
  split_by_failing_test: 'by_failing_test',
  split_by_layer: 'by_layer',
  split_as_written: 'as_written',
};

/** The Choice key of a kind, or `null` for `no_split` — which is the fallback and never an option. */
export function optionKeyOf(kind: SplitKind): string | null {
  return kind === 'no_split' ? null : OPTION_KEY_OF[kind];
}

/** §3.5: the escape of `which_split`, and the id of the Choice itself. */
export const WHICH_SPLIT = 'which_split';
export const SPLIT_ESCAPE = 'none_of_these';

/** §3.5: "Questions in one request (≤ 13 total)". */
export const MAX_DECOMPOSE_QUESTIONS = 13;

/** §5.5: "one Score per agent (≤ 8 questions)". */
export const MAX_RANK_QUESTIONS = 8;

/** §3.5's normative state bounds, in one object so the test can assert them mechanically. */
export const DECOMPOSE_STATE_LIMITS = {
  /** the task statement itself; §3.5 bounds every other field and this one is clipped for the same reason */
  taskChars: 2_000,
  remaining: 12,
  remainingChars: 200,
  unverified: 8,
  unverifiedChars: 200,
  directories: 12,
  directoryChars: 120,
  failingTests: 8,
  failingTestChars: 120,
  verification: 4,
  verificationChars: 120,
  agentTaskChars: 200,
  agentOwns: 8,
  agentOwnChars: 200,
  agentVerify: 2,
  agentVerifyChars: 120,
} as const;

/** §5.5's state bounds: "up to 40 lines of diff per file for ≤ 4 files — never the whole diff". */
export const RANK_STATE_LIMITS = {
  taskChars: 200,
  owns: 8,
  ownChars: 200,
  sampleFiles: 4,
  sampleLinesPerFile: 40,
  sampleLineChars: 200,
} as const;

// ---------------------------------------------------------------------------------------
// §3.5 request 1 — the state
// ---------------------------------------------------------------------------------------

export interface DecomposeStateInput {
  task: string;
  remaining: readonly string[];
  unverified: readonly string[];
  directories: readonly string[];
  failingTests: readonly string[];
  verification: readonly string[];
  options: readonly NormalizedSplit[];
}

function clipList(items: readonly string[], max: number, chars: number): string[] {
  return items.slice(0, max).map((s) => clip(s, chars));
}

function optionJson(split: NormalizedSplit): Json {
  const L = DECOMPOSE_STATE_LIMITS;
  return {
    agents: split.agents.map((a) => ({
      slug: a.slug,
      task: clip(a.task, L.agentTaskChars),
      owns: clipList(a.own, L.agentOwns, L.agentOwnChars),
      verify: clipList(a.verify, L.agentVerify, L.agentVerifyChars),
    })),
  };
}

/**
 * §3.5's state, verbatim:
 * `{ task, plan: { remaining, unverified }, repo: { directories, failing_tests, verification }, options: { … } }`.
 * O(1) in the transcript: nothing here reads `recent`, the window or a diff.
 */
export function buildDecomposeState(input: DecomposeStateInput): Json {
  const L = DECOMPOSE_STATE_LIMITS;
  const options: JsonObject = {};
  for (const o of input.options) {
    if (o.kind === 'no_split') continue;
    options[OPTION_KEY_OF[o.kind]] = optionJson(o);
  }
  return {
    task: clip(input.task, L.taskChars),
    plan: {
      remaining: clipList(input.remaining, L.remaining, L.remainingChars),
      unverified: clipList(input.unverified, L.unverified, L.unverifiedChars),
    },
    repo: {
      directories: clipList(input.directories, L.directories, L.directoryChars),
      failing_tests: clipList(input.failingTests, L.failingTests, L.failingTestChars),
      verification: clipList(input.verification, L.verification, L.verificationChars),
    },
    options,
  };
}

// ---------------------------------------------------------------------------------------
// §3.5 request 1 — the questions
// ---------------------------------------------------------------------------------------

/** What each option key means, in the measured style of `replan.ts`'s `REPLAN_OPTIONS`. */
const OPTION_DESCRIPTION: Readonly<Record<string, string>> = {
  split_by_plan_item: 'one agent per remaining plan item, each owning only the files its own item touches',
  split_by_directory: 'one agent per top-level source directory, each owning that whole directory',
  split_by_failing_test: 'one agent per failing test file, each owning that test and the sources it imports',
  split_by_layer: 'one agent per package of the workspace manifest, each owning that package',
  split_as_written: 'the split the engineer proposed itself, with the same ownership rules applied to it',
};

function canExamplesTrue(key: string): string[] {
  switch (key) {
    case 'split_by_failing_test':
      return [
        'one agent owns `test/unit/parse.test.ts` with `src/parse.ts`, another owns `test/unit/render.test.ts` with `src/render.ts`, and neither source imports the other',
        'the two failing suites fail for unrelated reasons: one on a bad regex, the other on a missing import',
      ];
    case 'split_by_layer':
      return [
        'the repository has `packages/server` and `packages/client`, and the remaining work is one change inside each',
        'each package has its own test command, so one agent can verify itself without building the other',
      ];
    case 'split_by_directory':
      return [
        'one agent owns `src/tui/**` and another owns `docs/**`: a renderer change and a documentation change never open the same file',
        'one agent owns `src/cli/**` and another owns `test/**`, and the cli change needs no new test file inside the other slice',
      ];
    case 'split_by_plan_item':
      return [
        'item one is "add the `--json` flag in `src/cli/args.ts`" and item two is "colour the status line in `src/tui/status/lines.ts`"',
        'a `prelude` agent owns the one shared `src/core/types.ts` change and every other agent depends on it, so the shared edit lands first',
      ];
    default:
      return [
        'the proposed agents own three disjoint directories and each task names only files inside its own directory',
        'the proposed agents each own one module plus that module\'s test, and the modules do not import one another',
      ];
  }
}

function canExamplesFalse(key: string): string[] {
  switch (key) {
    case 'split_by_failing_test':
      return [
        'both failing suites fail on the same helper in `src/util/time.ts`, which only one of the two agents owns',
        'the second suite cannot even be collected until the first agent\'s import fix lands',
      ];
    case 'split_by_layer':
      return [
        'the client package cannot compile until the server package exports a type it does not own yet',
        'both packages are built by one root script that writes into a directory only one agent owns',
      ];
    case 'split_by_directory':
      return [
        'the `src/tui/**` agent has to add a field to `src/core/types.ts`, which the other agent owns',
        'both agents have to register their new module in the same `src/index.ts` barrel export',
      ];
    case 'split_by_plan_item':
      return [
        'two remaining items are two halves of one edit to the same function in one file',
        'the second item is "then update the callers", and the callers are the files the first agent owns',
      ];
    default:
      return [
        'two of the proposed agents list the same file in their tasks although only one of them owns it',
        'one agent\'s task is to use a function another agent has not written yet, in a file the first agent does not own',
      ];
  }
}

/** §3.5: the id of the per-agent literal-fact Noul. */
export function selfContainedId(slug: string): string {
  return `agent_${slug}_is_self_contained`;
}

/**
 * §3.5's third question kind, one per agent OF THE LEADING OPTION.
 *
 * This is a SECOND OPINION, not the guard: §3.4 rule 8's code check [G11] scans the task text for path-shaped
 * tokens and rejects the whole option when one resolves to a real repo path outside that agent's `own`. That
 * check is the primary one because it is deterministic and cannot be talked out of. This Noul exists for the
 * self-containment the scanner cannot see (a task that describes a file without naming it), and it is phrased
 * as a comparison of two given texts — the task text and the owns list — rather than as a judgement about
 * whether the split is a good idea.
 */
function selfContainedNoul(slug: string, optionKey: string, index: number): Question {
  const taskRef = ref(`options.${optionKey}.agents.${index}.task`);
  const ownsRef = ref(`options.${optionKey}.agents.${index}.owns`);
  return noul(
    `Compare two given texts for agent \`${slug}\`: its task text in ${taskRef} and its list of owned paths in ${ownsRef}. Does the task text describe work that can be completed using only the files the owns list names? Answer carefully and literally.`,
    {
      true: {
        definition: `every file the task text names, or plainly needs, is matched by an entry of ${ownsRef}; the task text names no path outside it`,
        examples: [
          'the task text is "add a `--json` flag to `src/cli/args.ts` and a case for it" and the owns list is `["src/cli/args.ts", "test/unit/cli/args.test.ts"]`',
          'the task text names no path at all — "rewrite the status line so it fits 40 columns" — and the owns list is `["src/tui/status/**"]`, where that work lives',
        ],
      },
      false: {
        definition: `the task text names, or plainly needs, a file no entry of ${ownsRef} matches`,
        examples: [
          'the task text is "add the field to `src/core/types.ts`, then render it" and the owns list is only `["src/tui/**"]`',
          'the task text is "export the new helper from the package entry point" and the owns list does not include `src/index.ts`',
        ],
      },
    },
  );
}

/** What `buildDecomposeQuestions` built, plus what the ≤ 13 bound forced it to leave out. */
export interface DecomposeQuestionPlan {
  questions: Record<string, Question>;
  /** the option keys that got a `can_<key>` paired Noul, in Choice order */
  optionKeys: readonly string[];
  /** the slugs that got an `agent_<slug>_is_self_contained` Noul */
  askedSelfContained: readonly string[];
  /** §3.5's ≤ 13 bound: the slugs whose Noul was dropped from the end of the batch */
  droppedSelfContained: readonly string[];
}

/**
 * Request 1 as a plan, so the caller can record what the ≤ 13 bound cost it. An agent with no Noul is NEVER
 * dropped by §3.5's self-contained rule (absence is not "below the floor"); `rank.ts` depends on that.
 */
export function planDecomposeQuestions(options: readonly NormalizedSplit[], leading: NormalizedSplit | null): DecomposeQuestionPlan {
  const descriptions: Record<string, string> = {};
  for (const o of options) {
    if (o.kind === 'no_split') continue;
    const key = OPTION_KEY_OF[o.kind];
    descriptions[key] = `${OPTION_DESCRIPTION[key] ?? 'a proposed way of splitting the work'} (${ref(`options.${key}`)})`;
  }
  const optionKeys = Object.keys(descriptions);

  const questions: Record<string, Question> = {
    [WHICH_SPLIT]: choice(
      `Given ${ref('task')}, ${ref('plan.remaining')}, ${ref('repo')} and ${ref('options')}, which of these ways of dividing the remaining work between engineers working at the same time should be delegated? Answer carefully and literally.`,
      descriptions,
    ),
    ...pairedNouls(descriptions, (option, desc) => ({
      instructions: `For \`${option}\` (${desc}): the agents of this option can be worked on at the same time without one of them needing to change a file another one owns. Is that true? Answer carefully and literally.`,
      criteria: {
        true: {
          definition: `every agent listed under ${ref(`options.${option}`)} can finish its own task by changing only the paths in its own \`owns\` list, so no agent has to change a file another agent owns`,
          examples: canExamplesTrue(option),
        },
        false: {
          definition: `at least one agent of this option would have to change a file another agent's \`owns\` list claims, or two of them would have to change the same shared file`,
          examples: canExamplesFalse(option),
        },
      },
    })),
  };

  const asked: string[] = [];
  const dropped: string[] = [];
  if (leading !== null && leading.kind !== 'no_split') {
    const key = OPTION_KEY_OF[leading.kind];
    for (const [i, a] of leading.agents.entries()) {
      if (Object.keys(questions).length >= MAX_DECOMPOSE_QUESTIONS) {
        dropped.push(a.slug);
        continue;
      }
      questions[selfContainedId(a.slug)] = selfContainedNoul(a.slug, key, i);
      asked.push(a.slug);
    }
  }
  assertQuestionBatch(questions);
  return { questions, optionKeys, askedSelfContained: asked, droppedSelfContained: dropped };
}

/** §3.5 request 1: `which_split` + one `can_<key>` per option + one self-contained Noul per leading agent, ≤ 13. */
export function buildDecomposeQuestions(options: readonly NormalizedSplit[], leading: NormalizedSplit | null): Record<string, Question> {
  return planDecomposeQuestions(options, leading).questions;
}

// ---------------------------------------------------------------------------------------
// §5.5 request 2 — landing order only
// ---------------------------------------------------------------------------------------

export interface RankAgentInput {
  slug: string;
  task: string;
  own: readonly string[];
  stat: { files: number; added: number; removed: number };
  /** raw unified-diff lines; bounded here to ≤ 4 files × ≤ 40 lines */
  sample: readonly string[];
}

/** §5.5: the id of one agent's landing-order Score. */
export function rankScoreId(slug: string): string {
  return `agent_${slug}_diff_covers_task`;
}

/**
 * §5.5's five levels, as SITUATIONS (`src/jev/questions.ts:78` takes 2–10 of them). They describe what the
 * diff looks like, never a quantity: the Score is an ordinal over situations, and code turns it into an order.
 */
export const RANK_LEVELS: readonly string[] = [
  'the diff does none of what the task describes: it changes no file the task is about, or it only reformats and renames',
  'the diff begins what the task describes and stops: a stub, a signature with no body, or one of several named changes',
  'the diff does part of what the task describes and leaves a named part of it plainly missing',
  'the diff does everything the task describes, and adds no test for it',
  'the diff does everything the task describes and adds a test for it',
];

/** Split a unified diff sample into per-file chunks at `diff --git` / `+++` boundaries, bounded both ways. */
function boundSample(sample: readonly string[]): string[] {
  const L = RANK_STATE_LIMITS;
  const out: string[] = [];
  let files = 0;
  let inFile = 0;
  let started = false;
  for (const raw of sample) {
    const line = clip(raw, L.sampleLineChars);
    const boundary = raw.startsWith('diff --git ') || (!started && raw.startsWith('+++ '));
    if (boundary) {
      files += 1;
      inFile = 0;
      started = true;
      if (files > L.sampleFiles) break;
    } else if (!started) {
      started = true;
      files = 1;
    }
    if (inFile >= L.sampleLinesPerFile) continue;
    inFile += 1;
    out.push(line);
  }
  return out;
}

/** §5.5's per-agent state: the task, the owns, the code-computed diff stat, and a bounded sample. */
export function buildRankState(agents: readonly RankAgentInput[]): Json {
  const L = RANK_STATE_LIMITS;
  return {
    agents: agents.slice(0, MAX_RANK_QUESTIONS).map((a) => ({
      slug: a.slug,
      task: clip(a.task, L.taskChars),
      owns: a.own.slice(0, L.owns).map((o) => clip(o, L.ownChars)),
      stat: { files: a.stat.files, added: a.stat.added, removed: a.stat.removed },
      sample: boundSample(a.sample),
    })),
  };
}

/**
 * §5.5 request 2: one Score per agent, ≤ 8 questions.
 *
 * This can NEVER make an agent land, unland, pass or fail. It orders the landing queue and suggests `[k] kick`;
 * §5.3's hard rules and the verification commands decide everything else, in code, without asking.
 */
export function buildRankQuestions(agents: readonly RankAgentInput[]): Record<string, Question> {
  const questions: Record<string, Question> = {};
  for (const [i, a] of agents.slice(0, MAX_RANK_QUESTIONS).entries()) {
    questions[rankScoreId(a.slug)] = score(
      `Given the task text of agent \`${a.slug}\` in ${ref(`agents.${i}.task`)}, the change it made in ${ref(`agents.${i}.stat`)} and the sample of its diff in ${ref(`agents.${i}.sample`)}, how much of that stated task does the diff accomplish? Answer carefully and literally.`,
      [...RANK_LEVELS],
    );
  }
  assertQuestionBatch(questions);
  return questions;
}
