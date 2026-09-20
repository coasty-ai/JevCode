/**
 * Ranking check for the introspection-fed template sets (a little Jev, ≤ $0.05): at the gold site
 * of sympy-15345 (class-body gap) and sympy-17139 (the guard gap), the template source's set with
 * the introspection facts is handed to the real ranker (src/synth/rank, Q8/Q9/Q10 by N) with the
 * oracle's FailureView and the enclosing listing, and the rank Jev gives the test-passing candidate
 * is recorded. The sieve would run the whole set on these fast oracles (t_run ≤ 2 s); this is the
 * RANK-mode picture the design uses on slow ones.
 *
 * Usage: env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/reach/introspect-rank.mts [--only=a,b]
 * Output: experiments/reach/out/introspect-rank.json
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Decision, Json, Question, StageName } from '../../src/core/types.ts';
import { createJevDecider } from '../../src/jev/client.ts';
import { introspectRepro, vocabularyAdditions } from '../../src/synth/introspect/index.ts';
import { chunksWithContext, extractBlocks } from '../../src/synth/oracle/index.ts';
import type { TracebackFrame } from '../../src/synth/oracle/index.ts';
import { indentOf } from '../../src/synth/py/edits.ts';
import { createRanker } from '../../src/synth/rank/index.ts';
import { programRange } from '../../src/synth/rank/questions.ts';
import { ENUMERATE_CAP, taskIdentifiers, testLiterals } from '../../src/synth/search/subgoal.ts';
import { createTemplateSource, familyOf } from '../../src/synth/templates/index.ts';
import type { Candidate, EnumerateOptions, FailureView, Site } from '../../src/synth/types.ts';
import { applyCandidate } from '../../src/synth/verify/apply.ts';
import type { VerifyRunFn } from '../../src/synth/verify/types.ts';
import { REPOS, applyHunksToLines, insertSiteAt, loadFile, normLines, parseHunks, replaceSiteAt, sh, splitLines, venvPython } from './lib.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT_DIR = join(HERE, 'out');
const MODEL = 'typesafe/jev-1.13-20260917';
const SPEND_CAP_USD = 0.05;
const INSTANCES = ['sympy__sympy-15345', 'sympy__sympy-17139'];
const argv = process.argv.slice(2);
const onlyArg = argv.find((a) => a.startsWith('--only='));
const only = onlyArg === undefined ? null : onlyArg.slice('--only='.length).split(',');

interface Record_ {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
}
interface OracleRow {
  instance_id: string;
  goal?: { test_id: string; call: string; expected: string; actual: string };
  jev?: { frame_in_fix?: { file: string; fn: string; p: number }[] };
}

const run: VerifyRunFn = (command, opts) =>
  new Promise((resolve) => {
    execFile('/bin/sh', ['-c', command], { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: Math.max(opts.maxOutputBytes * 8, 1 << 20), killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: number | string; killed?: boolean }) | null;
      resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: e === null ? 0 : typeof e.code === 'number' ? e.code : null, timedOut: e?.killed === true });
    });
  });

const key = process.env['OPENROUTER_API_KEY'] ?? '';
if (key === '') throw new Error('OPENROUTER_API_KEY missing');
const jev = createJevDecider({ baseUrl: 'https://openrouter.ai/api/alpha/decisions', apiKey: key, model: MODEL, pinned: true }, { redact: (s) => s });
const signal = new AbortController().signal;
let spent = 0;
let requests = 0;
const ask = async (stage: StageName, state: Json, questions: Record<string, Question>): Promise<{ answers: Record<string, import('../../src/core/types.ts').Answer>; rows: Decision[]; latencyMs: number }> => {
  if (spent > SPEND_CAP_USD) throw new Error(`spend cap ${SPEND_CAP_USD} reached`);
  const res = await jev.ask(state, questions, { signal, stage, step: 1 });
  spent += res.usage.costUsd;
  requests += 1;
  return { answers: res.answers, rows: [], latencyMs: res.latencyMs };
};

function functionListing(site: Site): string {
  const { start, end } = programRange(site);
  const lines = site.file.mod.lines;
  const out: string[] = [];
  for (let n = start; n <= end; n++) out.push(`L${n}: ${lines[n - 1] ?? ''}`);
  return out.join('\n');
}

function candidateLines(c: Candidate): string[] {
  const out = c.text.split('\n');
  for (const e of c.extraEdits ?? []) if (e.text !== undefined) out.push(...e.text.split('\n'));
  return out;
}

const records = (JSON.parse(readFileSync(join(ROOT, 'bench/data/swebench-verified-30.json'), 'utf8')) as Record_[]).filter((r) => INSTANCES.includes(r.instance_id) && (only === null || only.includes(r.instance_id)));
const gold = JSON.parse(readFileSync(join(ROOT, 'bench/data/swebench-verified-30.gold.json'), 'utf8')) as Record<string, string>;
const oracleRows = (JSON.parse(readFileSync(join(ROOT, 'experiments/oracle/results.json'), 'utf8')) as { rows?: OracleRow[] }).rows ?? [];
mkdirSync(OUT_DIR, { recursive: true });

const results: Json[] = [];
for (const rec of records) {
  const workspace = join(REPOS, rec.instance_id);
  if (sh('git', ['status', '--short'], workspace).trim() !== '') throw new Error(`${rec.instance_id}: worktree not clean`);
  const oracle = oracleRows.find((o) => o.instance_id === rec.instance_id);
  const task = rec.problem_statement.split('\r\n').join('\n');
  const failures: FailureView[] = oracle?.goal === undefined ? [] : [{ testId: oracle.goal.test_id, call: oracle.goal.call, expected: oracle.goal.expected, actual: oracle.goal.actual }];
  const python = venvPython(rec.instance_id) ?? undefined;
  const extraction = extractBlocks(task);
  const block = extraction.blocks.find((b) => b.kind === 'code' || b.kind === 'repl')!;
  const cwc = chunksWithContext(block, extraction);
  const judged = new Set((oracle?.jev?.frame_in_fix ?? []).filter((f) => f.p >= 0.5).map((f) => `${f.file}|${f.fn}`));
  const anchors: TracebackFrame[] = extraction.tracebacks.flatMap((t) => t.frames).filter((f) => judged.has(`${f.file}|${f.fn ?? ''}`));
  const names = await introspectRepro(run, { chunks: cwc.chunks, options: { packageName: 'sympy', framework: null } }, { workspace, ...(python === undefined ? {} : { python }), anchors });
  const hunks = parseHunks(gold[rec.instance_id] ?? '').filter((h) => h.kind !== 'non_code_only');
  const target = rec.instance_id === 'sympy__sympy-15345' ? hunks.find((h) => h.addedCode.some((l) => l.includes(' = _print_')))! : hunks[0]!;
  const file = loadFile(workspace, target.file);
  const goldNorm = normLines(applyHunksToLines(file.mod.lines, [target])).join('\n');
  const goldIndent = indentOf(target.addedCode[0] ?? '');
  const site = insertSiteAt(file, target.oldLine, goldIndent);
  const opts: EnumerateOptions = { cap: ENUMERATE_CAP, testLiterals: testLiterals(failures), taskIdentifiers: taskIdentifiers(task), corpus: new Map([[file.path, file]]), introspected: names, extraNames: vocabularyAdditions(names, file) };
  const cands = createTemplateSource().enumerate(site, opts);
  const goldIdx = cands.findIndex((c) => {
    try {
      const after = applyCandidate(c).files.find((f) => f.path === file.path)?.after;
      return after !== undefined && normLines(splitLines(after)).join('\n') === goldNorm;
    } catch {
      return false;
    }
  });
  process.stderr.write(`${rec.instance_id}: ${cands.length} template candidates at insert@${target.oldLine} (${cands.filter((c) => familyOf(c.op) === 'introspect').length} introspect); gold-equivalent at enumeration index ${goldIdx}\n`);
  const t0 = Date.now();
  const before = requests;
  const spentBefore = spent;
  const ranked = await createRanker({ stage: 'propose' }).rank(cands, { ask, task, failures, functionListing: functionListing(site), signal });
  const pos = goldIdx < 0 ? -1 : ranked.ranked.findIndex((r) => r.candidate.id === cands[goldIdx]!.id);
  const top = ranked.ranked.slice(0, 5).map((r) => ({ rank: r.rank, p: Number(r.probability.toFixed(3)), text: candidateLines(r.candidate).join(' ⏎ ').slice(0, 90), op: r.candidate.op }));
  const row = {
    instance_id: rec.instance_id,
    site: `insert@${target.oldLine}`,
    candidates: cands.length,
    introspect_candidates: cands.filter((c) => familyOf(c.op) === 'introspect').length,
    gold_enumeration_index: goldIdx,
    gold_rank: pos < 0 ? null : pos + 1,
    gold_p: pos < 0 ? null : Number(ranked.ranked[pos]!.probability.toFixed(3)),
    method: ranked.method,
    escape_p: Number(ranked.escapeProbability.toFixed(3)),
    fix_probably_absent: ranked.fixProbablyAbsent,
    requests: requests - before,
    cost_usd: Number((spent - spentBefore).toFixed(5)),
    ms: Date.now() - t0,
    top,
  };
  results.push(row as unknown as Json);
  process.stderr.write(`  ranked by ${row.method}: gold rank ${row.gold_rank ?? '-'} (p ${row.gold_p ?? '-'}), escape ${row.escape_p}, absent ${row.fix_probably_absent}; ${row.requests} requests, $${row.cost_usd}, ${row.ms} ms\n  top: ${top.map((t) => `#${t.rank} p${t.p} ${t.text}`).join(' | ')}\n`);
}
const out = { model: MODEL, ran_at: new Date().toISOString(), spend_usd: Number(spent.toFixed(5)), jev_requests: requests, rows: results };
writeFileSync(join(OUT_DIR, 'introspect-rank.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
