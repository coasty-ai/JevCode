/**
 * Follow-up (live Jev, ~$0.03): (a) next-move Choice with code-computed `newly_passing_tests` /
 * `newly_failing_tests` in the state and option descriptions that name them (variant B);
 * (b) noise: the 13 partial candidates asked 3 more times (Nouls `both` + move variant A).
 * Run: env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/progress/probe2.mts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJevDecider } from '../../src/jev/client.ts';
import { choice, noul } from '../../src/jev/questions.ts';
import type { Json, Question } from '../../src/core/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const key = process.env['OPENROUTER_API_KEY'] ?? '';
if (!key) throw new Error('OPENROUTER_API_KEY missing');
const jev = createJevDecider({ baseUrl: 'https://openrouter.ai/api/alpha/decisions', apiKey: key, model: 'typesafe/jev-1.13-20260917', pinned: true }, { redact: (s) => s });
const signal = new AbortController().signal;
let cost = 0; const lat: number[] = []; let requests = 0;
type TestRow = { id: number; input: Json; expected: Json; actual: Json; status: string };
type Run = { total: number; passed: number; failed: number; tests: TestRow[] };
type Labels = { correct: boolean; progress: boolean; broke: boolean; kind: string; newly_passing: number[]; newly_failing: number[] };
type Cand = { id: string; line_no: number; old_line: string; new_line: string; after: Run; labels: Labels };
type Prog = { program: string; before: Run; candidates: Cand[] };
const data = JSON.parse(readFileSync(join(HERE, 'candidates.json'), 'utf8')) as Record<string, Prog>;
const prev = JSON.parse(readFileSync(join(HERE, 'results.json'), 'utf8')) as { moveRows: { program: string; cand: string; search: { candidates_remaining_for_this_line: number; untried_suspicious_lines: number }; expected: string[] }[] };
const trunc = (v: Json): Json => { const s = JSON.stringify(v); return s.length > 240 ? `${s.slice(0, 240)}…` : v; };
const failures = (run: Run): Json[] => run.tests.filter((t) => t.status !== 'pass').map((t) => ({ test: `test_${t.id}`, input: trunc(t.input), expected: trunc(t.expected), actual: trunc(t.actual), status: t.status }));
const both = (run: Run): Json => ({ passed: run.passed, failed: run.failed, total: run.total, failing_tests: failures(run) });
const TASK = (p: string) => `A candidate edit was applied to the Python function \`${p}\`. \`before\` is the test result of the program before the edit; \`after\` is the test result after the edit. Judge from the test results only. A test counts as failing if its status is fail, error or timeout. \`edit\` is the candidate edit that was applied; \`search\` describes what the repair loop has left to try.`;
async function ask(state: Json, qs: Record<string, Question>) { const r = await jev.ask(state, qs, { signal, stage: 'judge', step: 1 }); cost += r.usage.costUsd; lat.push(r.latencyMs); requests++; return r.answers; }
async function pool<T, R>(items: T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> { const out: R[] = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await f(items[k]!); } })); return out; }

const MOVE_A: Record<string, string> = {
  keep_and_stop: 'every test passes in `after`: keep the edit and finish the task',
  keep_and_continue: 'the edit made some previously failing tests pass without breaking any, and failures remain: keep the edit and work on the remaining failing tests',
  revert_and_try_next_candidate: 'the edit did not help or broke tests, and `search.candidates_remaining_for_this_line` is above zero: revert the edit and try the next candidate edit for the same line',
  revert_and_relocalise: 'the edit did not help or broke tests, no candidates remain for this line, and `search.untried_suspicious_lines` is above zero: revert and move to a different suspicious line',
  widen_search: 'the edit did not help or broke tests, no candidates remain for this line and no untried suspicious lines remain: revert and widen the search to more lines or another source of candidate edits',
};
const MOVE_B: Record<string, string> = {
  keep_and_stop: '`after.failed` is 0: every test passes, keep the edit and finish the task',
  keep_and_continue: '`after.newly_passing_tests` is above zero, `after.newly_failing_tests` is 0 and `after.failed` is above zero: the edit is a step forward, keep it and work on the remaining failing tests',
  revert_and_try_next_candidate: '`after.newly_passing_tests` is 0 or `after.newly_failing_tests` is above zero, and `search.candidates_remaining_for_this_line` is above zero: revert the edit and try the next candidate edit for the same line',
  revert_and_relocalise: '`after.newly_passing_tests` is 0 or `after.newly_failing_tests` is above zero, `search.candidates_remaining_for_this_line` is 0 and `search.untried_suspicious_lines` is above zero: revert and move to a different suspicious line',
  widen_search: '`after.newly_passing_tests` is 0 or `after.newly_failing_tests` is above zero, `search.candidates_remaining_for_this_line` is 0 and `search.untried_suspicious_lines` is 0: revert and widen the search to more lines or another source of candidate edits',
};
const Q_NOULS: Record<string, Question> = {
  made_progress: noul('Compared with `before`, did this edit make progress: does the program pass strictly more tests in `after` than in `before`?', {
    true: { definition: 'the number of passing tests in `after` is larger than in `before` (fewer tests fail after the edit than before it)', examples: ['before passed 1 of 9, after passes 4 of 9', 'a test listed under `before.failing_tests` is missing from `after.failing_tests` and no new failure appeared'] },
    false: { definition: 'the same number or fewer tests pass after the edit; the results are unchanged or worse', examples: ['before and after list the same failing tests', 'after passes fewer tests than before', 'the failing tests changed but their number did not shrink'] },
  }),
  broke_something: noul('Did the edit break something that worked: is there a test that passed in `before` but fails, errors or times out in `after`?', {
    true: { definition: 'at least one test that was passing before the edit is failing after it', examples: ['a test appears in `after.failing_tests` that is not in `before.failing_tests`', 'before passed 5 of 6, after passes 0 of 6'] },
    false: { definition: 'every test that passed before the edit still passes after it', examples: ['the set of failing tests shrank or stayed exactly the same', 'before passed 1 of 9, after passes 9 of 9'] },
  }),
};

const items = Object.values(data).flatMap((p) => p.candidates.map((cand) => { const pm = prev.moveRows.find((m) => m.program === p.program && m.cand === cand.id)!; return { program: p.program, cand, before: p.before, search: pm.search, expected: pm.expected }; }));
// (a) variant B on all 240
const moveB = await pool(items, 8, async (it) => {
  const afterB = { ...(both(it.cand.after) as Record<string, Json>), newly_passing_tests: it.cand.labels.newly_passing.length, newly_failing_tests: it.cand.labels.newly_failing.length };
  const state: Json = { task: `${TASK(it.program)} \`after.newly_passing_tests\` and \`after.newly_failing_tests\` were computed by code from the two runs.`, edit: { line: it.cand.line_no, old_line: it.cand.old_line, new_line: it.cand.new_line }, before: both(it.before), after: afterB, search: it.search };
  const a = await ask(state, { next_move: choice('What should the repair loop do next, given `edit`, `before`, `after` and `search`?', MOVE_B) });
  const ans = a['next_move']!; if (ans.type !== 'choice') throw new Error('bad');
  const chosen = Object.entries(ans.probabilities).sort((x, y) => y[1] - x[1])[0]![0];
  return { program: it.program, cand: it.cand.id, kind: it.cand.labels.kind, search: it.search, expected: it.expected, chosen, p_expected: Math.max(...it.expected.map((e) => ans.probabilities[e] ?? 0)), probs: ans.probabilities, ok: it.expected.includes(chosen) };
});
console.error(`variant B done: ${moveB.filter((r) => r.ok).length}/${moveB.length} cost=$${cost.toFixed(4)}`);
// (b) noise on partials: 3 repeats of nouls(both) + move A
const partials = items.filter((it) => it.cand.labels.kind.startsWith('partial'));
const repeats = await pool(partials.flatMap((it) => [0, 1, 2].map((rep) => ({ it, rep }))), 8, async ({ it, rep }) => {
  const state: Json = { task: TASK(it.program), edit: { line: it.cand.line_no, old_line: it.cand.old_line, new_line: it.cand.new_line }, before: both(it.before), after: both(it.cand.after), search: it.search };
  const a = await ask(state, { ...Q_NOULS, next_move: choice('What should the repair loop do next, given `edit`, `before`, `after` and `search`?', MOVE_A) });
  const mp = a['made_progress']!, bs = a['broke_something']!, nm = a['next_move']!;
  return { program: it.program, cand: it.cand.id, rep, made_progress: mp.type === 'noul' ? mp.noul : NaN, broke_something: bs.type === 'noul' ? bs.noul : NaN, p_keep_and_continue: nm.type === 'choice' ? nm.probabilities['keep_and_continue'] ?? 0 : NaN, p_try_next: nm.type === 'choice' ? nm.probabilities['revert_and_try_next_candidate'] ?? 0 : NaN };
});
lat.sort((a, b) => a - b);
writeFileSync(join(HERE, 'results2.json'), JSON.stringify({ meta: { date: new Date().toISOString(), requests, costUsd: cost, latencyP50: lat[Math.floor(lat.length / 2)] }, moveB, repeats }, null, 1));
console.log(`requests=${requests} cost=$${cost.toFixed(4)} p50=${lat[Math.floor(lat.length / 2)]}ms`);
