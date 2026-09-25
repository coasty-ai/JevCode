/**
 * Group C — the harness facts (TUI-DESIGN-2 §3.5, verbatim; TUI-DESIGN-5 §2.3 adds the fifteenth, `peers`): facts assembled from the session's own state,
 * each with a `topic`, `examples` (the Noul's true side) and a `text` (the `[jevcode]` line). `buildFactQuestions`
 * folds one Noul per fact (`about_<key>`) into the intake request; `selectFacts` keeps p ≥ 0.5 in probability order,
 * ≤ 4 lines, else the top 2. Sources and fingerprints only — never a key value. Core types only: this module imports
 * nothing from `src/cli/` (no cycle with the controller's `RunRecord`).
 */
import type { Answer, EngineMode, GitState, JevProvider, LastTestRun, PeerView, Question, SandboxLevel, StopReason, TestRunner } from '../core/types.js';
import { noul, ref } from '../jev/questions.js';
import { clip } from '../core/text.js';
import { JEV_ONLY_DEFAULT_SPEND_CAP_USD, MODE_BADGE_WORD } from '../config/defaults.js';
import { sandboxText } from '../tui/onboarding/lines.js';
import { usd2 } from '../tui/budget/lines.js';
import { stepCostText } from '../tui/plain.js';
import { modeWord } from './replies.js';
import { LLM_STATE_MODE } from '../tui/commands/registry.js';
import { formatDuration } from '../core/time.js';

/** contract 1.8 item 10 (TUI-DESIGN-5 §2.3, §8.1): `'peers'` — "who else is working here", the fifteenth fact. */
export type FactKey = 'what_it_is' | 'mode_now' | 'switch_mode' | 'workspace' | 'last_run' | 'last_tests' | 'keys' | 'cost_so_far' | 'sandbox' | 'how_to_task' | 'review' | 'undo' | 'commands' | 'provider' | 'peers';
export const FACT_KEYS: readonly FactKey[] = ['what_it_is', 'mode_now', 'switch_mode', 'workspace', 'last_run', 'last_tests', 'keys', 'cost_so_far', 'sandbox', 'how_to_task', 'review', 'undo', 'commands', 'provider', 'peers'];

export interface Fact {
  readonly key: FactKey;
  readonly topic: string;
  readonly examples: readonly string[];
  readonly text: string;
}

/** what the facts know of the last run (core types only) */
export interface FactsLastRun {
  runId: string;
  task: string;
  stopReason: StopReason;
  steps: number;
  costUsd: { generator: number; jev: number };
  paused: boolean;
}

export interface FactsInput {
  mode: EngineMode;
  nextMode: EngineMode;
  /**
   * `testCommand` is the command a run parsed (`lastTests.command`); before any run the listing's detected runner
   * (`testsFromCandidates`, the same fact the intake state carries) prints as `tests: <runner> (detected)` — additive to §3.5
   */
  workspace: { root: string; git: GitState | null; hasTests: boolean; testCommand: string | null; testRunner?: TestRunner | null };
  lastRun: FactsLastRun | null;
  lastTests: LastTestRun | null;
  /** sources only (`env TYPESAFE_API_KEY`, `dotenv:<path>`, `file:<path>`), never a key value */
  keys: { jev: { provider: JevProvider; source: string } | null; generator: { provider: string; source: string } | null };
  spend: { sessionUsd: number; sessionCapUsd: number; runs: number; chats: number };
  sandbox: SandboxLevel;
  runsDir: string;
  provider: { name: JevProvider; host: string; model: string; p50Ms: number | null } | null;
  /**
   * TUI-DESIGN-5 §2.3 / §2.4: `SessionHost.peers?()`'s four scalars — a count, a count, an age and a boolean.
   * **OPTIONAL**, because `undefined` and `null` are different states the fact must not merge: `undefined` is a
   * caller that has no ledger wiring at all (every pre-round-5 fixture), `null` is a ledger that is not open yet
   * (§1.4 promise 1). No pid, no path and no device label reaches this fact — a user who wants detail types `/who`.
   */
  peers?: PeerView | null;
  /**
   * TUI-DESIGN-5 §12.1, gap 1 (fix pass, finding 7): **which** of the two causes `peers: undefined` is.
   *
   * `undefined` alone printed the bare `the peer registry is not available in this build.` — a sentence that is
   * now false, because the build DOES have coordination; what it does not have here is a ledger, and the reason
   * is either the configuration or an unwritable home. `src/cli/session.ts` passes
   * `COORDINATION_OFF_CLAUSE[reason]`, and the fact appends it exactly as `/who` and `/peers` do, so the three
   * sinks the brief names cannot disagree. Ignored unless `peers` is `undefined`.
   */
  peersOffClause?: string;
  /**
   * `ResolvedConfig.autonomy` — who approves a review-flagged action. OPTIONAL so no existing fixture breaks;
   * absent reads as the default `full`, which is what a caller without a resolved config would run under.
   */
  autonomy?: 'full' | 'review';
}

/** the `topic` column of §3.5 */
export const FACT_TOPICS: Readonly<Record<FactKey, string>> = {
  what_it_is: 'what JevCode is and how it works',
  mode_now: 'which mode the session is in',
  switch_mode: 'how to switch between jev-only and jev+llm',
  workspace: 'which directory and repository it is working on',
  last_run: 'what the last run did and how it ended',
  last_tests: 'whether the tests pass',
  keys: 'which API keys are configured and where they come from',
  cost_so_far: 'how much the session has cost',
  sandbox: 'how commands are sandboxed',
  how_to_task: 'how to start a run or give it work',
  review: 'how approvals and reviews work',
  undo: 'how to undo or inspect changes',
  commands: 'which commands exist',
  provider: 'how Jev is reached, its model, latency and price',
  peers: 'whether other JevCode sessions are working here',
};

/** the `examples` column of §3.5 (the Noul's true side) */
export const FACT_EXAMPLES: Readonly<Record<FactKey, readonly string[]>> = {
  what_it_is: ['what can you do?', 'what are you?', 'how does this work?'],
  mode_now: ['which mode is this?', 'are you using the LLM?', 'is Claude on?'],
  switch_mode: ['how do I turn the LLM on?', 'switch to jev+llm?', 'how do I change mode?'],
  workspace: ['which folder are you in?', 'what repo is this?', 'where are we?'],
  last_run: ['what did the last run do?', 'did it finish?', 'what happened just now?'],
  last_tests: ['did the tests pass?', 'how many tests failed?', 'is the suite green?'],
  keys: ['which keys are you using?', 'is my API key set?', 'where does the key come from?'],
  cost_so_far: ['how much has this cost?', 'what have I spent?', 'how much money so far?'],
  sandbox: ['are commands sandboxed?', 'can you touch the network?', 'is this safe to run?'],
  how_to_task: ['how do I give you a task?', 'how do I start?', 'what do I type to make a change?'],
  review: ['what does the review card do?', 'how do I approve a step?', 'will you ask before deleting?'],
  undo: ['how do I undo that?', 'can I revert the last step?', 'how do I see the diff?'],
  commands: ['what commands are there?', 'how do I see the help?', 'what does /panel do?'],
  provider: ['which Jev model is this?', 'are you on typesafe or openrouter?', 'how fast is Jev?'],
  peers: ['is anyone else working on this?', 'am I the only jevcode here?', 'who else has this repo open?'],
};

/** the `false examples` column of §3.5, verbatim (≥ 2 per key; `noul()` throws below two) */
export const FACT_FALSE_EXAMPLES: Readonly<Record<FactKey, readonly string[]>> = {
  what_it_is: ['what does parse_date do?', 'fix the failing test'],
  mode_now: ['what does parse_date do?', 'run the tests'],
  switch_mode: ['which mode is this?', 'add a --dry-run flag'],
  workspace: ['where is the date parsing?', 'hi'],
  last_run: ['run the tests', 'what does utils/dates.py export?'],
  last_tests: ['run the tests', 'why does test_parse_date fail?'],
  keys: ['how much has this cost?', 'thanks'],
  cost_so_far: ['which mode is this?', 'fix the date parsing'],
  sandbox: ['run the tests', 'what did you change?'],
  how_to_task: ['fix the failing test', 'what did the last run do?'],
  review: ['undo that', 'what does parse_date do?'],
  undo: ['revert the last commit', 'did the tests pass?'],
  commands: ['run the tests', 'hi'],
  provider: ['which mode is this?', 'what does parse_date do?'],
  peers: ['which mode is this?', 'fix the failing test'],
};

/** Jev's price on both providers (§2.1: $0.042 per million input tokens, output free) */
export const JEV_PRICE_TEXT = '$0.042 per million input tokens (output free)';
// TUI-DESIGN-3 §1.9 (R3 F9 / R5 F13): the copy names the code model, never a vendor
export const WHAT_IT_IS_TEXT = 'JevCode is a coding agent where Jev, a decision model, makes every decision: what kind of step comes next, which files matter, how risky an action is, whether a step worked. In jev-only mode code proposes fixes and tests verify them; in jev+llm mode the code model writes the code.';
// `/llm on`'s target from the registry: jev-on today, agent once slice S6 flips the default (AGENT-LOOP-DESIGN §14.5)
export const SWITCH_MODE_TEXT = `Switch with /mode jev-only (Jev alone, $${JEV_ONLY_DEFAULT_SPEND_CAP_USD.toFixed(2)} run cap) or /mode ${LLM_STATE_MODE.on} (alias /llm on); it applies to the next run. Persist it with jevcode config set mode <m>.`;
/**
 * The `review` fact, per `autonomy`. Under `full` (the default) a review-flagged action is auto-approved and
 * logged, so the old "Nothing is ever auto-approved" sentence would be a lie; under `review` the y/n card is back.
 */
export const REVIEW_TEXT = 'Risky actions stop for review: y approves once, n declines, d declines with a note. Nothing is auto-approved under --autonomy review; Enter does nothing there.';
export const REVIEW_TEXT_FULL = 'Autonomy is full: a review-flagged action is auto-approved and logged as a [review] line, and a blocked action still stops the run. Pass --autonomy review (or jevcode config set autonomy review) to be asked instead: y approves once, n declines, d declines with a note.';
export function reviewText(autonomy: 'full' | 'review' = 'full'): string {
  return autonomy === 'review' ? REVIEW_TEXT : REVIEW_TEXT_FULL;
}
export const UNDO_TEXT = '/undo reverts the last step\'s file changes, /rewind picks a step, /diff shows what changed.';
export const COMMANDS_TEXT = 'Commands start with /; type / to list them, /help for keys.';
export const HOW_TO_TASK_TEXT = 'Describe the change in plain words and press Enter; a run starts, shows every decision, and stops to ask before anything risky.';
/**
 * AGENT-LOOP-DESIGN §14.5, amended by §A2: the agent-mode sentence. §14.5 ends with "Destructive commands are refused", which §A2 makes
 * false under the default full autonomy (they run inside the sandbox, with pre-images and a note), so the sentence keeps what holds.
 */
export const HOW_TO_TASK_TEXT_AGENT = 'Describe the change in plain words and press Enter; a run starts, streams what it does, runs your tests when the change calls for it, and /undo reverts any step.';
export const HOW_TO_TASK_SUFFIX: Readonly<Record<EngineMode, string>> = {
  'jev-only': ' In jev-only I fix what tests can verify; for open-ended changes switch with /mode jev-on.',
  'jev-on': ' The code model writes the code, Jev decides each step.',
  'jev-off': ' The generator alone runs it; reviews still ask.',
  'llm-jev': ' The code model writes candidate patches, tests verify them, Jev arbitrates.',
  'agent': ' The code model works through tools and checks its own work, running your tests when they apply.',
};
/** TUI-DESIGN-3 §1.9: the `mode_now` sentence per mode — ONE table, the badge words from `MODE_BADGE_WORD` */
export const MODE_SENTENCE: Readonly<Record<EngineMode, string>> = {
  'jev-only': `Mode: ${MODE_BADGE_WORD['jev-only']} — no generating LLM; code proposes, Jev decides, tests verify.`,
  'jev-on': `Mode: ${MODE_BADGE_WORD['jev-on']} — the code model writes the code, Jev decides every step.`,
  'jev-off': `Mode: ${MODE_BADGE_WORD['jev-off']} — the generator alone, no Jev (bench condition; reviews still ask).`,
  'llm-jev': `Mode: ${MODE_BADGE_WORD['llm-jev']} — the code model writes candidate patches, tests verify them, Jev arbitrates.`,
  'agent': `Mode: ${MODE_BADGE_WORD['agent']} — the code model works through tools and checks its own work; Jev makes a few quick routing calls.`,
};
/**
 * AGENT-LOOP-DESIGN §13 / peer review G: what `/jev`, `/why` and `/decisions` answer in agent mode when there is nothing to show — a
 * normal agent run asks Jev nothing but a few optional quick routing calls, so an empty table would read as a fault.
 */
export const AGENT_NO_DECISIONS_TEXT = 'a normal agent run makes no Jev decisions';
export const NOTHING_RAN_TEXT = 'Nothing has run yet in this session.';
export const NO_TESTS_PARSED_TEXT = 'No test run has been parsed in this session yet.';

function modeNowText(mode: EngineMode, nextMode: EngineMode): string {
  const base = MODE_SENTENCE[mode];
  return nextMode !== mode ? `${base} Next run: ${modeWord(nextMode)}.` : base;
}

/** the branch (or detached head) of a probed repository — the `workspace` fact and the chat system prompt's git line */
export function branchOf(g: GitState): string {
  if (g.head === null) return 'no HEAD';
  if (g.head.kind === 'branch') return g.head.name;
  if (g.head.kind === 'detached') return `detached ${g.head.oid.slice(0, 8)}`;
  return `${g.head.name} (unborn)`;
}

function workspaceText(w: FactsInput['workspace']): string {
  const runner = w.testRunner !== undefined && w.testRunner !== null && w.testRunner !== 'unknown' ? w.testRunner : null;
  const tests = w.testCommand !== null ? `tests: ${w.testCommand}` : runner !== null ? `tests: ${runner} (detected)` : 'no test command found';
  const g = w.git;
  const git = g !== null && g.repo ? `git ${branchOf(g)}, ${g.dirty.modified + g.dirty.staged} modified · ${g.dirty.untracked} untracked` : 'not a git repository';
  return `Workspace: ${w.root} (${git}; ${tests})`;
}

function lastRunText(r: FactsLastRun | null): string {
  if (r === null) return NOTHING_RAN_TEXT;
  const cost = usd2(r.costUsd.generator + r.costUsd.jev);
  const task = clip(r.task, 60);
  const ended = r.paused ? `is paused after ${r.steps} step${r.steps === 1 ? '' : 's'}` : `ended ${r.stopReason} after ${r.steps} step${r.steps === 1 ? '' : 's'}`;
  return `Last run ${r.runId}: "${task}" ${ended}, ${cost}; /resume continues, /diff shows the changes.`;
}

function lastTestsText(t: LastTestRun | null): string {
  if (t === null) return NO_TESTS_PARSED_TEXT;
  return `Last test run: ${t.passed} passed, ${t.failed} failed, ${t.errors} errors (step ${t.step}).`;
}

function keysText(k: FactsInput['keys']): string {
  const jev = k.jev === null ? 'Jev — no key resolves yet (jevcode login saves one)' : `Jev through ${k.jev.provider} (${k.jev.source}, never printed)`;
  const gen = k.generator === null ? 'generator: none — needed for jev+llm; /mode jev-on asks for one.' : `generator: ${k.generator.provider} (${k.generator.source})`;
  return `Keys: ${jev}; ${gen}`;
}

/** the spend in `/cost`'s form (`stepCostText`: three decimals, four below $0.001 — an intake costs ≈ $0.0002), the cap in two */
function costText(s: FactsInput['spend']): string {
  const runs = `${s.runs} run${s.runs === 1 ? '' : 's'}`;
  const chats = `${s.chats} chat message${s.chats === 1 ? '' : 's'}`;
  return `Session spend: ${stepCostText(s.sessionUsd)} of ${usd2(s.sessionCapUsd)} (${runs}, ${chats}). /cost has the breakdown.`;
}

/** TUI-DESIGN-5 §2.4 / §12.1: the peer fact — TD4's two kept sentences, plus §2.4's pointer at `/who`. */
export const PEERS_UNAVAILABLE_TEXT = 'the peer registry is not available in this build';
export const PEERS_ALONE_TEXT = 'no other jevcode is working in this workspace';

/**
 * TUI-DESIGN-5 §12.1 / §2.3: the ONE "the ledger has not opened yet" sentence, shared by the chat fact and by
 * `/peers`' `view === null` block (fix pass, finding 8) so the two surfaces cannot drift. It starts with
 * `COORDINATION_NOT_OPEN` (`src/session/coordination.ts`) verbatim, which `facts.test.ts` pins.
 */
export function peersNotOpenText(ascii = false): string {
  return `the session ledger is not open yet ${ascii ? '--' : '\u2014'} /who lists every jevcode on this workspace once it is`;
}

export function peersFactText(view: PeerView | null | undefined, ascii = false, offClause?: string): string {
  const dash = ascii ? '--' : '\u2014';
  // gap 1 / finding 7: `undefined` is "there will be no ledger", and the clause says which of the two causes
  if (view === undefined) return offClause === undefined || offClause === '' ? `${PEERS_UNAVAILABLE_TEXT}.` : `${PEERS_UNAVAILABLE_TEXT} ${dash} ${offClause}.`;
  if (view === null) {
    const t = peersNotOpenText(ascii);
    return `${t.slice(0, 1).toUpperCase()}${t.slice(1)}.`;
  }
  const here = Number.isFinite(view.live) ? Math.max(0, Math.floor(view.live)) : 0;
  const stale = Number.isFinite(view.stale) ? Math.max(0, Math.floor(view.stale)) : 0;
  // §2.4's privacy contract: counts, an age and a boolean. Never a pid, never a path, never a device label.
  if (here <= 1 && stale === 0) return `${PEERS_ALONE_TEXT} ${dash} /who shows what each is doing.`;
  const others = Math.max(0, here - 1);
  const parts: string[] = [];
  parts.push(others === 0 ? 'No other jevcode is live here' : `${others} other jevcode ${others === 1 ? 'session is' : 'sessions are'} working here`);
  if (stale > 0) parts.push(`${stale} stale`);
  if (view.oldestStartedMsAgo !== null) parts.push(`the oldest started ${formatDuration(Math.max(0, view.oldestStartedMsAgo))} ago`);
  if (view.exclusive) parts.push('one holds an exclusive lease');
  return `${parts.join(', ')} ${dash} /peers counts them, /who shows what each is doing.`;
}

function providerText(p: FactsInput['provider']): string {
  if (p === null) return `Jev: not configured yet — jevcode login saves a key; ${JEV_PRICE_TEXT}.`;
  const latency = p.p50Ms !== null ? `about ${Math.round(p.p50Ms)} ms per decision, ` : '';
  return `Jev: ${p.name} (${p.host}), model ${p.model}, ${latency}${JEV_PRICE_TEXT}.`;
}

/** the 15 facts of §3.5 + TUI-DESIGN-5 §2.3's `peers`; sources and fingerprints only, never a key value */
export function harnessFacts(i: FactsInput): readonly Fact[] {
  const text: Record<FactKey, string> = {
    what_it_is: WHAT_IT_IS_TEXT,
    mode_now: modeNowText(i.mode, i.nextMode),
    switch_mode: SWITCH_MODE_TEXT,
    workspace: workspaceText(i.workspace),
    last_run: lastRunText(i.lastRun),
    last_tests: lastTestsText(i.lastTests),
    keys: keysText(i.keys),
    cost_so_far: costText(i.spend),
    sandbox: sandboxText(i.sandbox),
    how_to_task: (i.nextMode === 'agent' ? HOW_TO_TASK_TEXT_AGENT : HOW_TO_TASK_TEXT) + HOW_TO_TASK_SUFFIX[i.nextMode],
    review: reviewText(i.autonomy),
    undo: UNDO_TEXT,
    commands: COMMANDS_TEXT,
    provider: providerText(i.provider),
    peers: peersFactText(i.peers, false, i.peersOffClause),
  };
  return FACT_KEYS.map((key) => ({ key, topic: FACT_TOPICS[key], examples: FACT_EXAMPLES[key], text: text[key] }));
}

export const FACT_QUESTION_PREFIX = 'about_';

/** `about_<key>`: one Noul per fact, definition + examples on both sides (REPORT rule 4) */
export function buildFactQuestions(facts: readonly Fact[]): Record<string, Question> {
  const out: Record<string, Question> = {};
  for (const f of facts) {
    out[`${FACT_QUESTION_PREFIX}${f.key}`] = noul(`Does ${ref('message')} ask about ${f.topic}?`, {
      true: { definition: `the human wants to know ${f.topic}`, examples: [...f.examples] },
      false: { definition: `${f.topic} is not what the message is about`, examples: [...FACT_FALSE_EXAMPLES[f.key]] },
    });
  }
  return out;
}

export const FACT_SELECT_FLOOR = 0.5;
export const FACT_MAX_LINES = 4;
export const FACT_MIN_LINES = 2;

/** p ≥ 0.5 sorted by p desc, ≤ 4; none ≥ 0.5 → the top 2 (the answer leads with what was asked) */
export function selectFacts(facts: readonly Fact[], answers: Record<string, Answer>): readonly Fact[] {
  const scored = facts.map((f, i) => {
    const a = answers[`${FACT_QUESTION_PREFIX}${f.key}`];
    return { f, i, p: a && a.type === 'noul' && Number.isFinite(a.noul) ? a.noul : 0 };
  });
  scored.sort((x, y) => y.p - x.p || x.i - y.i);
  const above = scored.filter((s) => s.p >= FACT_SELECT_FLOOR);
  const picked = above.length > 0 ? above.slice(0, FACT_MAX_LINES) : scored.slice(0, FACT_MIN_LINES);
  return picked.map((s) => s.f);
}
