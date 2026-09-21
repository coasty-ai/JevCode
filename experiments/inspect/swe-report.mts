/**
 * Per-instance table for jev-only SWE-bench benches (jev-only-rungs-1-2.md §21; run from the repo root): tasks.jsonl (one or more result dirs, comma-separated)
 * joined with each run's transcript.log and steps.jsonl. `wiring_defect_history_site` = an `error` stop after the ranker's
 * site invariant threw on a git-history reversal (`error internal: ranker: candidate "hist_…"`, §21.5/§21.7). `--mark=a,b,c` marks those instances (e.g. the 9 of
 * the BEFORE run) with a `*` in the 30-run table. Solved = the local-venv evaluator's verdict, nothing else.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const dirs = (args.find((a) => !a.startsWith('--')) ?? 'bench/results/jev-only-swebench-2-oracle').split(',');
const mark = new Set((args.find((a) => a.startsWith('--mark='))?.slice('--mark='.length) ?? '').split(',').filter((s) => s !== ''));
/** dirs whose unfinished rows are a dead process (the 9-run's OOM), not a bench still running */
const crashedDirs = new Set((args.find((a) => a.startsWith('--crashed='))?.slice('--crashed='.length) ?? '').split(',').filter((s) => s !== ''));
type Rec = { task: string; pass: boolean | null; evaluator: string; reason?: string; steps: number; wallMs: number; cost: { jev: number }; jevRequests: number; stopReason: string; patchEmpty: boolean | null; patchApplied: boolean | null; patchBytes: number | null; runId: string; blocked: number; declined: number };
const final = new Map<string, Rec>();
const started = new Map<string, Rec>();
for (const dir of dirs) {
  const path = join(dir, 'tasks.jsonl');
  if (!existsSync(path)) continue;
  for (const l of readFileSync(path, 'utf8').split('\n')) {
    if (l.trim() === '') continue;
    const r = JSON.parse(l) as Rec;
    if (r.reason === 'in_progress') {
      if (!final.has(r.task)) started.set(r.task, { ...r, stopReason: crashedDirs.has(dir) ? 'crashed' : 'in_progress' });
      continue;
    }
    final.set(r.task, r);
    started.delete(r.task);
  }
}
// a task that started and never finished (the process died: the 9-run's OOM) is reported as crashed
for (const [task, r] of started) if (!final.has(task)) final.set(task, { ...r, reason: r.stopReason, evaluator: 'none' });

const rows: string[] = [];
const totals = { n: 0, oracle: { strong: 0, weak: 0, unstable: 0, none: 0 }, patches: 0, pass: 0, bestGuess: 0, cost: 0, wall: 0, evaluated: 0, blockedPM: 0, declined: 0, engineRejectedInstances: 0 };
const classes = new Map<string, number>();
for (const r of [...final.values()].sort((a, b) => (a.task < b.task ? -1 : 1))) {
  const runDir = join(homedir(), '.jevcode/runs', r.runId);
  const transcript = existsSync(join(runDir, 'transcript.log')) ? readFileSync(join(runDir, 'transcript.log'), 'utf8') : '';
  const synth = (phase: string): string[] => [...transcript.matchAll(new RegExp(`^\\[step (\\d+)\\] synth ${phase}: (.*)$`, 'gm'))].map((m) => `${m[1]}:${m[2]}`);
  const oracleLine = synth('oracle')[0] ?? '';
  const oracle = /^\d+:(valid_weak)/.test(oracleLine) ? 'weak' : /^\d+:valid/.test(oracleLine) ? 'strong' : /^\d+:unstable/.test(oracleLine) ? 'unstable' : /^\d+:restored/.test(oracleLine) ? 'restored' : 'none';
  const oracleOutcome = oracleLine.replace(/^\d+:/, '').split(':')[0] ?? '-';
  const baselines = synth('baseline');
  const searches = synth('search');
  const verifies = synth('verify').filter((v) => /tested on/.test(v));
  const budgetLines = synth('budget');
  const steps = existsSync(join(runDir, 'steps.jsonl')) ? readFileSync(join(runDir, 'steps.jsonl'), 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as { step: number; proposal?: { goal?: string; action?: { kind?: string } }; outcome?: { status?: string; reason?: string } }) : [];
  const patches = steps.filter((s) => s.proposal?.action?.kind === 'patch');
  const applied = patches.filter((s) => s.outcome?.status === 'executed');
  const blockedPM = patches.filter((s) => s.outcome?.status === 'blocked' && /plan_mismatch/.test(s.outcome?.reason ?? '')).length;
  const declined = patches.filter((s) => s.outcome?.status === 'declined').length;
  const rejected = patches.length - applied.length;
  const bestGuess = patches.some((s) => /best-guess/.test(s.proposal?.goal ?? ''));
  const commits = searches.filter((s) => / commit/.test(s)).length;
  const tested = verifies.reduce((n, v) => n + Number(/(\d+) tested/.exec(v)?.[1] ?? 0), 0);
  const plausible = verifies.reduce((n, v) => n + Number(/(\d+) plausible/.exec(v)?.[1] ?? 0), 0);
  const regressed = verifies.reduce((n, v) => n + Number(/(\d+) regressed/.exec(v)?.[1] ?? 0), 0);
  const enumerated = searches.reduce((n, s) => n + Number(/candidates=(\d+)/.exec(s)?.[1] ?? 0), 0);
  const goals = baselines.length > 0 ? (transcript.match(/synth ledger: fixed \d+, open \d+, parked \d+/g)?.at(-1) ?? '') : '';
  const parkedNoSite = searches.some((s) => /parked: no (site|candidate)/.test(s));
  const parkedExhausted = searches.some((s) => /parked: exhausted/.test(s));
  const budgetOnly = searches.length > 0 && searches.every((s) => / budget/.test(s));
  const rankerSiteErrors = (transcript.match(/error internal: ranker: candidate "hist_/g) ?? []).length;
  let cls: string;
  if (r.reason === 'crashed') cls = 'crashed_oom';
  else if (r.stopReason === 'error' && rankerSiteErrors > 0) cls = 'wiring_defect_history_site';
  else if (r.reason === 'in_progress') cls = 'in_progress';
  else if (r.pass === true) cls = 'solved';
  else if (r.evaluator !== 'local-venv' && r.patchEmpty !== true && r.patchEmpty !== null && r.pass === null) cls = 'setup';
  else if (baselines.length === 0) cls = 'setup';
  else if (r.patchEmpty === true || r.patchEmpty === null) {
    if (oracle === 'none' || oracle === 'unstable') cls = bestGuess ? 'no_oracle_best_guess_rejected' : 'no_oracle_no_guess';
    else if (commits > 0 && rejected > 0) cls = blockedPM > 0 ? 'engine_blocked_plan_mismatch' : declined > 0 ? 'engine_declined_review' : 'engine_rejected';
    else if (parkedNoSite) cls = 'oracle_unreachable';
    else if (plausible === 0 && regressed > 0) cls = 'ranked_run_but_regressions';
    else if (budgetOnly || parkedExhausted || searches.length > 0) cls = 'reachable_not_ranked_in_budget';
    else cls = 'no_search';
  } else cls = bestGuess ? 'best_guess_wrong' : 'evaluator_fail_on_committed_patch';
  classes.set(cls, (classes.get(cls) ?? 0) + 1);
  totals.n += 1;
  totals.oracle[oracle === 'strong' || oracle === 'restored' ? 'strong' : oracle === 'weak' ? 'weak' : oracle === 'unstable' ? 'unstable' : 'none'] += 1;
  totals.patches += applied.length;
  if (r.pass === true) totals.pass += 1;
  if (r.evaluator === 'local-venv') totals.evaluated += 1;
  if (bestGuess) totals.bestGuess += 1;
  totals.cost += r.cost.jev;
  totals.wall += r.wallMs;
  totals.blockedPM += blockedPM;
  totals.declined += declined;
  if (blockedPM + declined > 0) totals.engineRejectedInstances += 1;
  const firstBaseline = baselines[0]?.replace(/^\d+:/, '').replace(/ \(repository.*$/, '').slice(0, 120) ?? '-';
  const evalText = r.pass === null ? 'n/a' : r.pass ? 'PASS' : 'fail';
  rows.push(`| ${mark.has(r.task) ? '*' : ''}${r.task} | ${oracle}${oracle !== 'none' ? '' : ` (${oracleOutcome})`} | ${goals.replace('synth ledger: ', '') || '-'} | ${firstBaseline.replace(/\|/g, '\\|')} | ${enumerated} / ${tested} / ${plausible} | ${commits} / ${applied.length} (${blockedPM} blocked pm, ${declined} declined) | ${budgetLines.length} | ${bestGuess ? 'yes' : 'no'} | ${evalText} (${r.evaluator}${r.reason ? `: ${r.reason.slice(0, 60).replace(/\|/g, '\\|')}` : ''}) | ${r.steps} | $${r.cost.jev.toFixed(4)} | ${Math.round(r.wallMs / 1000)} | ${r.stopReason} | ${cls} |`);
  console.error(`${r.task}: oracle=${oracle} ${oracleLine.slice(0, 200)}\n   baselines: ${baselines.map((b) => b.slice(0, 200)).join(' || ')}\n   searches: ${searches.map((s) => s.slice(0, 160)).join(' || ')}\n   budget: ${budgetLines.map((s) => s.slice(0, 160)).join(' || ')}\n   verify: ${verifies.slice(0, 6).map((v) => v.slice(0, 160)).join(' || ')}${verifies.length > 6 ? ` || +${verifies.length - 6} more` : ''}\n   patches: ${patches.map((p) => `${p.step}:${p.outcome?.status}`).join(', ')} eval: ${r.pass} ${r.reason ?? ''} run ${r.runId}`);
}
console.log('| instance | oracle | ledger | first baseline | enumerated / tested / plausible | commits / applied (rejections) | progress budget steps | best guess | evaluator | steps | Jev $ | wall s | stop | class |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of rows) console.log(r);
console.log(`\nTotals: ${totals.n} instances; oracle strong ${totals.oracle.strong}, weak ${totals.oracle.weak}, unstable ${totals.oracle.unstable}, none ${totals.oracle.none}; patches applied ${totals.patches}; best guess used ${totals.bestGuess}; evaluator pass ${totals.pass}/${totals.evaluated}; engine rejections: ${totals.blockedPM} blocked (plan_mismatch) + ${totals.declined} declined (review, no reviewer) on ${totals.engineRejectedInstances} instances; Jev $${totals.cost.toFixed(4)}; wall ${Math.round(totals.wall / 1000)} s (sum)`);
console.log(`Failure classes: ${[...classes.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
