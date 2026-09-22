// The Jev-safety contract of HARNESS-NEXT-DESIGN §1.2, enforced at build time (wave S0).
//
// Jev is a router, never an authority. Every Jev call site introduced or moved by that design satisfies four clauses:
//
//   1. code enumerates the options   — the Choice is built by `src/jev/questions.ts choice()`, which guarantees
//                                      ESCAPE_KEY and the paired Nouls; nothing hand-builds a Question literal
//   2. a code guard runs after       — and it can only tighten; the router's answer is never the last word
//   3. a deterministic code fallback — named at the site, with a unit test of its own that the annotation points at
//   4. being wrong costs wall-clock  — never correctness: a router orders, it does not gate completion or acceptance
//
// A call site proves the four clauses with a comment block directly above it:
//
//   // jev-contract: R1 run_first (§3.x)
//   //   escape: choice() over the code-built scopes — ESCAPE_KEY, argmax only beyond the 0.05 margin
//   //   guard: the scope-usability check and the code deny-list run after the answer
//   //   fallback: scopeBuilderFor() narrowest code scope, then the full suite; test: test/unit/synth/oracle/scope.test.ts
//   //   no-gating: ordering only — completion stays isCompleteByFact() on the harness's own run
//
// Existing, pre-design uses are grandfathered in ALLOW below, by file and by count: annotate a new site, or add a row
// with a reason. A file that grows an extra un-annotated `.ask(` fails, which is the point — the contract is checked
// where the calls are, not in a document.
//
// Usage: `node scripts/jev-contract.mjs [root]` (root defaults to the cwd; the unit test passes a fixture tree).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Files whose `.ask(` sites predate the design (§1.2 "the existing non-router uses"), with the reason each is safe. */
const ALLOW = [
  { file: 'src/loop/engine.ts', sites: 2, why: 'askRecorded, plus the decomposeContext seam that forwards into it (contract 1.5): the one metered, recorded path to the decider — the guard, not call sites' },
  { file: 'src/loop/stages/decompose.ts', sites: 1, why: 'the `deps.ask` forwarder into ctx.ask/askRecorded (contract 1.5); the Choice is built, floored and guarded in src/orchestrate/split/rank.ts, which carries the four-clause block' },
  { file: 'src/jev/router.ts', sites: 1, why: "contract 1.9 (Fastlane) §2.1: routeSpeculative's `input.ask(signal)` is the INJECTED thunk of the routed site — the stage's own ctx.ask, which reaches the decider through the engine's one metered path. The primitive builds no question and takes no decision; it only decides whether an answer arrives in time to be applied, and its single failure branch (deadline / JevError / 503 / abort / committed token) is what makes every routed site's clause-3 fallback structural. The four clauses belong to the calling site, which carries them." },
  { file: 'src/chat/lookup.ts', sites: 1, why: 'TUI-DESIGN-2 §3.6 chat lookup Nouls: no workspace mutation reachable from the answer' },
  { file: 'src/chat/intake.ts', sites: 1, why: 'TUI-DESIGN-2 §3.13 intake Choice: escape + can_* pairs, code fallback coding_task' },
  { file: 'src/undo/apply.ts', sites: 1, why: 'not Jev: the undo picker asks the human which checkpoint to restore' },
  { file: 'src/loop/coordination.ts', sites: 1, why: "not Jev: `input.ask(req)` is the lease-conflict BLOCKING PANE (COORDINATION-DESIGN \u00a74.3 step 4) through the engine's existing Confirmer/blocker seam \u2014 a `BlockingRequest` answered by a human with [w]/[c]/[t]/[q], not a Choice. \u00a72.1 keeps Jev off the coordination path entirely: no decider is reachable from this module, so jev-off, --no-input and an unreachable Jev are byte-identical here" },
  { file: 'src/perf/jev-latency.ts', sites: 1, why: 'the --live latency probe: fixed question batch, no action reachable' },
  { file: 'src/jev/cache.ts', sites: 1, why: 'createCachingDecider: a memoizing decorator that forwards the caller\'s own state and questions to `inner.ask` untouched — it builds no question and takes no decision, so the four clauses belong to the site that called it' },
  { file: 'src/synth/index.ts', sites: 1, why: 'llm-jev dispatcher: the batch is built and guarded by the synthesizer stage that owns it' },
  { file: 'src/synth/llm/repro.ts', sites: 1, why: 'Q13 repro selection among code-generated inputs; code fallback to the first input' },
  { file: 'src/synth/oracle/search.ts', sites: 1, why: 'Q12 oracle Choice over code-enumerated commands; code fallback to the detected command' },
  { file: 'src/synth/search/subgoal.ts', sites: 1, why: 'Q11 edit class over a fixed enum; code fallback to the code-ranked class' },
  { file: 'src/synth/search/sites.ts', sites: 3, why: 'Q2–Q6 localisation: traceback frames stay in the listing whatever Jev answers' },
  { file: 'src/synth/localize/index.ts', sites: 5, why: 'Q2–Q6 localisation asker (chunked): ranking only, code order is the fallback' },
  { file: 'src/synth/donor/holes.ts', sites: 1, why: 'Q14 donor hole fill over code-mined candidates; the candidate still runs the tests' },
];

/** §1.2 "structurally excluded from Jev": ids that would make Jev an authority. Never a question id, anywhere. */
const FORBIDDEN_IDS = ['allow', 'approve', 'approved', 'commit_ok', 'accept_patch', 'is_correct', 'task_done', 'patch_is_correct'];

/** A Question literal must come from the builders in this file, which enforce the escape rule and the criteria shape. */
const QUESTION_BUILDER_FILES = ['src/jev/questions.ts'];

const CLAUSE_KEYS = ['escape', 'guard', 'fallback', 'no-gating'];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'bench']);

// `x.ask(` / `x?.ask(` on a value — not `.asking(`, not a type position.
//
// A per-line regex is not enough: a formatter that wraps the chain (`await ctx.decider` / newline / `.ask(state, …)`)
// would hide the site entirely, and because the allow-list ratchets on *un-annotated sites per file*, a reformat
// both hides the new site and drops an existing file below its allowance. So the scan also follows the two ways
// prettier can split the call, and anchors the site at the receiver's line (which is where the contract block goes).
/** the whole call on one line */
const ASK_ON_LINE = /[\w$)\]]\s*\??\s*\.\s*ask\s*\(/;
/** `\n  .ask(` — the receiver ended the line before */
const ASK_DOT_FIRST = /^\s*\??\s*\.\s*ask\s*\(/;
/** `\n  ask(` — the line before ended with the dot */
const ASK_NAME_FIRST = /^\s*ask\s*\(/;
/** a line that ends in something a `.ask(` can be called on */
const RECEIVER_TAIL = /[\w$)\]]\s*\??\s*$/;
const RECEIVER_DOT_TAIL = /[\w$)\]]\s*\??\s*\.\s*$/;

/** The nearest earlier line that is neither blank nor a comment, or -1. */
function receiverLineAbove(lines, i) {
  for (let j = i - 1; j >= 0; j--) {
    if (lines[j].trim() === '') continue;
    if (isComment(lines[j])) continue;
    return j;
  }
  return -1;
}

/**
 * The 0-based line of every Jev call site in `lines`, anchored at the receiver (ascending, each site once).
 * A forwarder (`ask: (a, b) => other.ask(a, b)`) is plumbing, not a decision site.
 */
function askSiteLines(lines) {
  const out = [];
  const push = (j) => {
    if (j >= 0 && !isForwarder(lines[j]) && out[out.length - 1] !== j) out.push(j);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isComment(line)) continue;
    if (ASK_ON_LINE.test(line)) {
      if (!isForwarder(line)) push(i);
      continue;
    }
    if (ASK_DOT_FIRST.test(line)) {
      const j = receiverLineAbove(lines, i);
      if (j >= 0 && RECEIVER_TAIL.test(lines[j])) push(j);
      continue;
    }
    if (ASK_NAME_FIRST.test(line)) {
      const j = receiverLineAbove(lines, i);
      if (j >= 0 && RECEIVER_DOT_TAIL.test(lines[j])) push(j);
    }
  }
  return out;
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(p, out);
    } else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** `ask:` / `ask =` definitions and forwarders (`ask: (a, b) => other.ask(a, b)`) are plumbing, not decision sites. */
function isForwarder(line) {
  return /\bask\s*:\s*(?:async\s*)?\(/.test(line) || /\bask\s*[:=]\s*(?:async\s*)?\(?[\w$]*\)?\s*=>/.test(line);
}

function isComment(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/** The contiguous comment block directly above `i`, oldest line first. */
function commentBlockAbove(lines, i) {
  const block = [];
  for (let j = i - 1; j >= 0; j--) {
    const t = lines[j].trim();
    if (t === '') break;
    if (!isComment(lines[j])) break;
    block.unshift(t.replace(/^\/\*+|^\*+\/?|^\/\//, '').trim());
  }
  return block;
}

function parseAnnotation(block) {
  const text = block.join('\n');
  if (!/jev-contract\s*:/.test(text)) return null;
  const clauses = {};
  for (const key of CLAUSE_KEYS) {
    const m = new RegExp(`${key}\\s*:\\s*(.+)`, 'i').exec(text);
    clauses[key] = m ? m[1].trim() : '';
  }
  const router = /jev-contract\s*:\s*(.+)/.exec(text)?.[1]?.trim() ?? '';
  return { router, clauses, text };
}

export function checkTree(root) {
  const errors = [];
  const srcDir = join(root, 'src');
  const files = walk(srcDir);
  const allowByFile = new Map(ALLOW.map((a) => [a.file, a]));
  const unannotatedByFile = new Map();
  let contracted = 0;
  let sites = 0;

  for (const abs of files) {
    const rel = relative(root, abs).split('\\').join('/');
    const src = readFileSync(abs, 'utf8');
    const lines = src.split('\n');

    // a file takes part in asking when it sends a request or builds questions; the rules below are about those files,
    // not about a renderer fixture that happens to spell a Question out for a snapshot
    const askLines = askSiteLines(lines);
    const asks = askLines.length > 0;
    const buildsQuestions = /from '.*jev\/questions\.js'/.test(src);

    // clause 1, structurally: only the builders may spell a Question out
    if (!QUESTION_BUILDER_FILES.includes(rel) && (asks || buildsQuestions)) {
      lines.forEach((line, i) => {
        if (/\{\s*type:\s*'(choice|noul|score)'\s*,\s*instructions\s*:/.test(line)) {
          errors.push(`${rel}:${i + 1}: clause 1: build the Question with src/jev/questions.ts (choice/noul/score) — a literal skips the escape and criteria rules`);
        }
      });
    }

    if (asks || buildsQuestions) {
      for (const id of FORBIDDEN_IDS) {
        const re = new RegExp(`['"\`]${id}['"\`]\\s*\\]?\\s*:\\s*(?:choice|noul|contextNoul|score)\\s*\\(`);
        lines.forEach((line, i) => {
          if (isComment(line)) return;
          if (re.test(line)) errors.push(`${rel}:${i + 1}: clause 4: "${id}" would make Jev the authority (§1.2 structurally excluded); the code decides this`);
        });
      }
    }

    for (const i of askLines) {
      sites += 1;
      const ann = parseAnnotation(commentBlockAbove(lines, i));
      if (ann === null) {
        unannotatedByFile.set(rel, (unannotatedByFile.get(rel) ?? 0) + 1);
        continue;
      }
      contracted += 1;
      const where = `${rel}:${i + 1} (${ann.router || 'unnamed router'})`;
      for (const key of CLAUSE_KEYS) {
        if (ann.clauses[key] === '') errors.push(`${where}: the jev-contract block is missing the "${key}:" clause (§1.2 clause ${CLAUSE_KEYS.indexOf(key) + 1})`);
      }
      const fallback = ann.clauses['fallback'];
      if (fallback !== '') {
        const m = /test\s*:\s*(\S+)/.exec(fallback);
        if (m === null) errors.push(`${where}: clause 3: name the fallback's unit test as "test: <path>" — every fallback is driven by a Decider that throws`);
        else if (!existsSync(join(root, m[1]))) errors.push(`${where}: clause 3: the named fallback test ${m[1]} does not exist`);
      }
      // clause 4, at the site: a router's answer orders work, it does not decide that something is done or allowed
      const window = lines.slice(i, i + 25).join('\n');
      const gate = /\b(?:complete|completed|approved|allowed|accepted|verdict)\s*=(?!=)|return\s+\{[^}]*\b(?:complete|approved|allowed)\b/.exec(window);
      if (gate !== null) errors.push(`${where}: clause 4: the answer feeds "${gate[0].trim()}" — a router may order work, never gate correctness or acceptance`);
    }
  }

  for (const [file, count] of unannotatedByFile) {
    const allowed = allowByFile.get(file);
    if (allowed === undefined) {
      errors.push(`${file}: ${count} Jev call site(s) with no jev-contract block and no allow-list row (§1.2: every call site proves the four clauses)`);
    } else if (count > allowed.sites) {
      errors.push(`${file}: ${count} un-annotated Jev call sites, the allow-list grandfathers ${allowed.sites} — annotate the new one with a jev-contract block`);
    }
  }
  // the ratchet only tightens if shrinking is mandatory: an over-wide row is headroom a new un-annotated site can
  // hide in (and a reformat that hides a site would otherwise pass silently), so a stale row is an error, not a note
  for (const a of ALLOW) {
    if (!existsSync(join(root, a.file))) continue;
    const count = unannotatedByFile.get(a.file) ?? 0;
    if (count < a.sites) errors.push(`${a.file}: the allow-list grandfathers ${a.sites} un-annotated Jev call site(s) but the file has ${count} — tighten the row to ${count}${count === 0 ? ' (or drop it)' : ''}`);
  }
  return { errors, sites, contracted, allowListed: sites - contracted };
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const root = process.argv[2] ?? '.';
  if (!statSync(join(root, 'src'), { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`jev-contract: ${root}/src is not a directory`);
    process.exit(2);
  }
  const { errors, sites, contracted, allowListed } = checkTree(root);
  if (errors.length > 0) {
    console.error(`the Jev-safety contract (HARNESS-NEXT-DESIGN §1.2) is not met:\n${errors.map((e) => `  ${e}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`jev-contract: ok (${sites} Jev call site(s): ${contracted} with a four-clause block, ${allowListed} allow-listed)`);
}
