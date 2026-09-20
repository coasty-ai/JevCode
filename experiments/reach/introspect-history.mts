/**
 * Introspected names and the history source at the gold sites (capabilities 2 and 3 of
 * experiments/results/swebench-reach-oracle-9.md), $0: no Jev call.
 *
 * For sympy-15345 (class-body alias), sympy-17139 (attribute-predicate guard) and django-15315
 * (revert of the commit the issue names): the reproduction is rebuilt from the issue text the way
 * the oracle does (extractBlocks → block 0 → chunksWithContext; Jev's judged failure kind and
 * anchors are read back from experiments/oracle/results.json, no request), the introspection pass
 * runs once in the base worktree with the bench venv (src/synth/introspect), the history is
 * harvested with ≤ 8 read-only git commands (src/synth/history), then the real sources enumerate
 * at the gold sites built as reach-oracle-9.mts builds them, before (plain EnumerateOptions) and
 * after (introspected / history / extraNames). Every candidate is applied and compared with the
 * gold-patched file (code tokens per line); the found candidate is applied to a private worktree
 * with the test patch and the FAIL_TO_PASS tests run with the bench venv.
 *
 * `--quixbugs`: the 40 QuixBugs sites (bench/data/quixbugs index.json bugLine; the four insertion
 * gaps too) through the template source without and with a real introspection of the first JSON
 * test call, to measure how many candidates the two productions add there.
 *
 * Usage: node --env-file=.env node_modules/.bin/tsx experiments/reach/introspect-history.mts [--only=a,b] [--no-f2p] [--no-donor] [--quixbugs] [--swe-only]
 * Output: experiments/reach/out/introspect-history.json (+ a table on stdout)
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDonorSource } from '../../src/synth/donor/index.ts';
import { createHistorySource, harvestHistory } from '../../src/synth/history/index.ts';
import type { HistoryFacts } from '../../src/synth/history/index.ts';
import { introspectRepro, vocabularyAdditions } from '../../src/synth/introspect/index.ts';
import type { IntrospectedNames } from '../../src/synth/introspect/index.ts';
import { createMutationSource } from '../../src/synth/mutate/index.ts';
import { chunksWithContext, extractBlocks } from '../../src/synth/oracle/index.ts';
import type { TracebackFrame } from '../../src/synth/oracle/index.ts';
import { indentOf } from '../../src/synth/py/edits.ts';
import { ENUMERATE_CAP, isTestPath, taskIdentifiers, testLiterals } from '../../src/synth/search/subgoal.ts';
import { missingFromVocab, vocabularyOf } from '../../src/synth/sieve/queue.ts';
import { createTemplateSource, familyOf } from '../../src/synth/templates/index.ts';
import type { Candidate, CandidateSource, EnumerateOptions, FailureView, Site, SourceFile } from '../../src/synth/types.ts';
import { applyCandidate } from '../../src/synth/verify/apply.ts';
import type { VerifyRunFn } from '../../src/synth/verify/types.ts';
import { REPOS, applyHunksToLines, insertSiteAt, isCodeLine, loadFile, normLines, parseHunks, privateWorktree, replaceSiteAt, runF2P, sh, splitLines, venvPython } from './lib.mts';
import type { Hunk } from './lib.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT_DIR = join(HERE, 'out');
/** src/synth/search/index.ts loadPythonFiles: the first 400 non-test .py paths alphabetically */
const MAX_WORKSPACE_PY_FILES = 400;
const INSTANCES = ['sympy__sympy-15345', 'sympy__sympy-17139', 'django__django-15315'];
const QUIXBUGS = join(ROOT, 'bench/data/quixbugs');
const QUIXBUGS_INTROSPECT_TIMEOUT_MS = 8000;

const argv = process.argv.slice(2);
const onlyArg = argv.find((a) => a.startsWith('--only='));
const only = onlyArg === undefined ? null : onlyArg.slice('--only='.length).split(',');
const noF2P = argv.includes('--no-f2p');
const noDonor = argv.includes('--no-donor');
const doQuixbugs = argv.includes('--quixbugs');
const sweOnly = argv.includes('--swe-only');

interface Record_ {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  fail_to_pass: string[];
  test_patch: string;
  spec: { test_cmd: string };
}

interface OracleRow {
  instance_id: string;
  goal?: { test_id: string; call: string; expected: string; actual: string };
  jev?: { failure_kind?: string; frame_in_fix?: { file: string; fn: string; p: number }[] };
}

/** A sandbox-shaped runner: /bin/sh -c with the timeout and output bound the caller gives. */
const run: VerifyRunFn = (command, opts) =>
  new Promise((resolve) => {
    execFile('/bin/sh', ['-c', command], { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: Math.max(opts.maxOutputBytes * 8, 1 << 20), killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: number | string; killed?: boolean; signal?: string | null }) | null;
      resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: e === null ? 0 : typeof e.code === 'number' ? e.code : null, timedOut: e?.killed === true });
    });
  });

function nonTestPyFiles(workspace: string): string[] {
  return sh('git', ['ls-files', '*.py'], workspace)
    .split('\n')
    .filter((p) => p.endsWith('.py') && !isTestPath(p))
    .sort();
}

function candidateLines(c: Candidate): string[] {
  const out = c.text.split('\n');
  for (const e of c.extraEdits ?? []) if (e.text !== undefined) out.push(...e.text.split('\n'));
  return out;
}

interface Hit {
  index: number;
  op: string;
  text: string;
  candidate: Candidate;
}

/** Candidates whose application equals the gold-patched file (blank and comment lines dropped, code tokens compared). */
function goldHits(cands: readonly Candidate[], path: string, goldNorm: string): Hit[] {
  const out: Hit[] = [];
  cands.forEach((c, index) => {
    try {
      const after = applyCandidate(c).files.find((f) => f.path === path)?.after;
      if (after !== undefined && normLines(splitLines(after)).join('\n') === goldNorm) out.push({ index, op: c.op, text: candidateLines(c).join(' ⏎ ').slice(0, 160), candidate: c });
    } catch {
      // stale / out of range
    }
  });
  return out;
}

interface SiteRow {
  site: string;
  mutation: number;
  templateBefore: number;
  templateAfter: number;
  donor: number;
  history: number;
  totalBefore: number;
  totalAfter: number;
  introspectAdded: number;
  hitBefore: Hit[];
  hitAfter: Hit[];
  /** the found candidate's position among the SEEDS list in source order (mutation, template, donor/history) */
  seedsIndexAfter: number | null;
  vocabMissingBefore: string[];
  vocabMissingAfter: string[];
  topIntrospect: string[];
  ms: number;
}

interface InstanceResult {
  id: string;
  capability: string;
  introspection: { status: string; ms: number; target: string | null; moduleName: string | null; frames: string[]; operands: { expr: string; type: string; classes: string[]; predicates: number; falsy: number; receiver: boolean; frame: string | null }[]; counts: { classes: number; predicates: number; attributes: number; moduleNames: number; total: number }; note: string } | null;
  history: { commands: number; ms: number; commits: { sha: string; subject: string; reason: string; hunks: number }[]; note: string } | null;
  sites: SiteRow[];
  found: { site: string; index: number; op: string; text: string } | null;
  f2p: { pass: boolean; ms: number; tail: string } | null;
  wallMs: number;
}

/** The oracle's reproduction spec rebuilt from the issue text without Jev (block 0 is the only block on all three instances). */
function reproSpec(rec: Record_): { chunks: string[]; packageName: string; framework: 'django' | null; anchors: TracebackFrame[] } {
  const task = rec.problem_statement.split('\r\n').join('\n');
  const extraction = extractBlocks(task);
  const block = extraction.blocks.find((b) => b.kind === 'code' || b.kind === 'repl');
  if (block === undefined) throw new Error(`${rec.instance_id}: no runnable block in the issue text`);
  const cwc = chunksWithContext(block, extraction);
  const packageName = rec.repo === 'sympy/sympy' ? 'sympy' : rec.repo === 'django/django' ? 'django' : rec.repo.split('/')[1] ?? 'pkg';
  return { chunks: cwc.chunks, packageName, framework: packageName === 'django' ? 'django' : null, anchors: extraction.tracebacks.flatMap((t) => t.frames) };
}

async function studyInstance(rec: Record_, gold: string, oracle: OracleRow | undefined): Promise<InstanceResult> {
  const t0 = Date.now();
  const workspace = join(REPOS, rec.instance_id);
  const status = sh('git', ['status', '--short'], workspace).trim();
  if (status !== '') throw new Error(`${rec.instance_id}: worktree not clean: ${status.slice(0, 200)}`);
  const head = sh('git', ['rev-parse', 'HEAD'], workspace).trim();
  if (!head.startsWith(rec.base_commit.slice(0, 10))) throw new Error(`${rec.instance_id}: HEAD ${head} is not ${rec.base_commit}`);
  const task = rec.problem_statement.split('\r\n').join('\n');
  const failure: FailureView | null = oracle?.goal === undefined ? null : { testId: oracle.goal.test_id, call: oracle.goal.call, expected: oracle.goal.expected, actual: oracle.goal.actual };
  const failures = failure === null ? [] : [failure];
  const python = venvPython(rec.instance_id) ?? undefined;
  const hunks = parseHunks(gold).filter((h) => h.kind !== 'non_code_only');
  const goldPath = hunks[0]!.file;
  const capability = rec.instance_id === 'django__django-15315' ? 'history' : 'introspected names';

  // the engine's corpus cut plus the gold file
  const paths = nonTestPyFiles(workspace);
  const corpus = new Map<string, SourceFile>();
  for (const p of paths.slice(0, MAX_WORKSPACE_PY_FILES)) {
    try {
      corpus.set(p, loadFile(workspace, p));
    } catch {
      // unreadable
    }
  }
  const goldFile = loadFile(workspace, goldPath);
  corpus.set(goldPath, goldFile);
  const baseOpts: EnumerateOptions = { cap: ENUMERATE_CAP, testLiterals: testLiterals(failures), taskIdentifiers: taskIdentifiers(task), corpus };

  // --- the introspection pass (all three; the guard/alias capability on the two sympy instances)
  const spec = reproSpec(rec);
  const judged = new Set((oracle?.jev?.frame_in_fix ?? []).filter((f) => f.p >= 0.5).map((f) => `${f.file}|${f.fn}`));
  const anchors = spec.anchors.filter((f) => judged.has(`${f.file}|${f.fn ?? ''}`));
  process.stderr.write(`  ${rec.instance_id}: introspecting ${spec.chunks.length} chunk(s), ${anchors.length} anchor(s), python ${python ?? 'python3'}\n`);
  const names: IntrospectedNames = await introspectRepro(run, { chunks: spec.chunks, options: { packageName: spec.packageName, framework: spec.framework } }, { workspace, ...(python === undefined ? {} : { python }), anchors });
  process.stderr.write(`  introspection ${names.status} in ${names.durationMs} ms: ${names.note}; operands ${names.operands.map((o) => `${o.expr}:${o.typeName}[${o.classes.slice(0, 3).join(',')}${o.classes.length > 3 ? ',…' : ''}] preds ${o.predicates.length} (falsy ${o.falsyPredicates.length})${o.raisingReceiver ? ' receiver' : ''}`).join('; ')}\n`);

  // --- the history harvest (all three; the revert capability on django-15315)
  const hist: HistoryFacts = await harvestHistory(run, { workspace, files: [goldPath], task, identifiers: taskIdentifiers(task), sources: [goldFile] });
  process.stderr.write(`  history: ${hist.note} in ${hist.durationMs} ms\n`);

  // --- sites (as reach-oracle-9.mts builds them) and the target hunk
  const target: Hunk = rec.instance_id === 'sympy__sympy-15345' ? hunks.find((h) => h.addedCode.some((l) => l.includes(' = _print_')))! : hunks[0]!;
  const baseLines = goldFile.mod.lines;
  const goldNorm = normLines(applyHunksToLines(baseLines, [target])).join('\n');
  const goldIndent = indentOf(target.addedCode[0] ?? target.added[0] ?? '');
  const sites: { label: string; site: Site }[] = [];
  if (target.removed.length > 0) sites.push({ label: `replace@${target.oldLine}`, site: replaceSiteAt(goldFile, target.oldLine) });
  else {
    sites.push({ label: `insert@${target.oldLine}`, site: insertSiteAt(goldFile, target.oldLine, goldIndent) });
    let prev = target.oldLine - 1;
    while (prev >= 1 && !isCodeLine(baseLines[prev - 1] ?? '')) prev--;
    if (prev >= 1) sites.push({ label: `replace@${prev}(before gap)`, site: replaceSiteAt(goldFile, prev) });
    let next = target.oldLine;
    while (next <= baseLines.length && !isCodeLine(baseLines[next - 1] ?? '')) next++;
    if (next <= baseLines.length) sites.push({ label: `replace@${next}(after gap)`, site: replaceSiteAt(goldFile, next) });
  }

  const mutation = createMutationSource();
  const template = createTemplateSource();
  const donor: CandidateSource | null = noDonor ? null : createDonorSource();
  const history = createHistorySource();
  const vocab = vocabularyOf(goldFile, failures, task);
  const extraNames = vocabularyAdditions(names, goldFile);
  const vocabAfter = new Set([...vocab, ...extraNames]);
  const afterOpts: EnumerateOptions = { ...baseOpts, introspected: names, extraNames, history: hist };

  const rows: SiteRow[] = [];
  for (const { label, site } of sites) {
    const ts = Date.now();
    const m = mutation.enumerate(site, baseOpts);
    const tBefore = template.enumerate(site, baseOpts);
    const tAfter = template.enumerate(site, afterOpts);
    const d = donor === null ? [] : donor.enumerate(site, baseOpts);
    const h = history.enumerate(site, afterOpts);
    const hitBefore = [...goldHits(m, goldPath, goldNorm), ...goldHits(tBefore, goldPath, goldNorm).map((x) => ({ ...x, index: x.index })), ...goldHits(d, goldPath, goldNorm)];
    const hitsTemplateAfter = goldHits(tAfter, goldPath, goldNorm);
    const hitsHistory = goldHits(h, goldPath, goldNorm);
    const hitAfter = [...hitsTemplateAfter.map((x) => ({ ...x, op: `template:${x.op}` })), ...hitsHistory.map((x) => ({ ...x, op: `history:${x.op}` }))];
    const first = hitAfter[0];
    let seedsIndexAfter: number | null = null;
    if (first !== undefined) seedsIndexAfter = first.op.startsWith('template:') ? m.length + first.index : m.length + tAfter.length + first.index;
    const introspectCands = tAfter.filter((c) => familyOf(c.op) === 'introspect');
    rows.push({
      site: label,
      mutation: m.length,
      templateBefore: tBefore.length,
      templateAfter: tAfter.length,
      donor: d.length,
      history: h.length,
      totalBefore: m.length + tBefore.length + d.length,
      totalAfter: m.length + tAfter.length + d.length + h.length,
      introspectAdded: introspectCands.length,
      hitBefore,
      hitAfter,
      seedsIndexAfter,
      vocabMissingBefore: first === undefined ? [] : missingFromVocab(first.candidate, vocab),
      vocabMissingAfter: first === undefined ? [] : missingFromVocab(first.candidate, vocabAfter),
      topIntrospect: introspectCands.slice(0, 6).map((c) => candidateLines(c).join(' ⏎ ').slice(0, 100)),
      ms: Date.now() - ts,
    });
    const r = rows[rows.length - 1]!;
    process.stderr.write(`  ${label}: mutation ${r.mutation}, template ${r.templateBefore} → ${r.templateAfter} (+${r.introspectAdded} introspect), donor ${r.donor}, history ${r.history}; total ${r.totalBefore} → ${r.totalAfter}; gold hit before ${r.hitBefore.length}, after ${r.hitAfter.length}${first === undefined ? '' : ` (${first.op} @${first.index}, SEEDS #${seedsIndexAfter}; vocab missing before ${JSON.stringify(r.vocabMissingBefore)} after ${JSON.stringify(r.vocabMissingAfter)})`} in ${r.ms} ms\n`);
  }

  // --- the found candidate against the FAIL_TO_PASS tests in a private worktree
  const foundRow = rows.find((r) => r.hitAfter.length > 0);
  const found = foundRow === undefined ? null : { site: foundRow.site, index: foundRow.hitAfter[0]!.index, op: foundRow.hitAfter[0]!.op, text: foundRow.hitAfter[0]!.text };
  let f2p: InstanceResult['f2p'] = null;
  if (found !== null && !noF2P && python !== undefined) {
    const cand = foundRow!.hitAfter[0]!.candidate;
    const ws = privateWorktree(rec.instance_id, rec.repo, rec.base_commit, '-ih');
    const applied = applyCandidate(cand);
    for (const f of applied.files) writeFileSync(join(ws, f.path), f.after);
    writeFileSync(join(ws, '.jev-test.patch'), rec.test_patch);
    sh('git', ['apply', '.jev-test.patch'], ws);
    process.stderr.write(`  F2P: running ${rec.fail_to_pass.join(', ')} in ${ws}\n`);
    f2p = runF2P({ instance_id: rec.instance_id, repo: rec.repo, fail_to_pass: rec.fail_to_pass, test_patch: rec.test_patch }, ws, python);
    process.stderr.write(`  F2P ${f2p.pass ? 'PASS' : 'FAIL'} in ${f2p.ms} ms: ${f2p.tail.slice(-160).replace(/\s+/g, ' ')}\n`);
  }

  return {
    id: rec.instance_id,
    capability,
    introspection: {
      status: names.status,
      ms: names.durationMs,
      target: names.target,
      moduleName: names.moduleName,
      frames: names.frames.map((f) => `${f.path}:${f.line} ${f.fn ?? ''}`),
      operands: names.operands.map((o) => ({ expr: o.expr, type: o.typeName, classes: o.classes, predicates: o.predicates.length, falsy: o.falsyPredicates.length, receiver: o.raisingReceiver, frame: o.frame === null ? null : `${o.frame.path}:${o.frame.line} ${o.frame.fn ?? ''}` })),
      counts: { classes: names.classes.length, predicates: names.predicates.length, attributes: names.attributes.length, moduleNames: names.moduleNames.length, total: names.classes.length + names.predicates.length + names.attributes.length + names.moduleNames.length },
      note: names.note,
    },
    history: { commands: hist.commands, ms: hist.durationMs, commits: hist.commits.map((c) => ({ sha: c.sha.slice(0, 10), subject: c.subject, reason: c.reason, hunks: c.hunks.length })), note: hist.note },
    sites: rows,
    found,
    f2p,
    wallMs: Date.now() - t0,
  };
}

// ---------------------------------------------------------------------------------------- QuixBugs

interface QuixEntry {
  name: string;
  bugLine: number;
  hasJsonTests: boolean;
}

interface QuixRow {
  name: string;
  site: string;
  introspection: string;
  operands: number;
  predicates: number;
  classes: string[];
  before: number;
  after: number;
  added: number;
}

const INSERTION_SITES: Record<string, { line: number; indent: number }> = {
  depth_first_search: { line: 10, indent: 12 },
  reverse_linked_list: { line: 6, indent: 8 },
  shunting_yard: { line: 18, indent: 12 },
  wrap: { line: 10, indent: 4 },
};

async function studyQuixbugs(): Promise<QuixRow[]> {
  const entries = JSON.parse(readFileSync(join(QUIXBUGS, 'index.json'), 'utf8')) as QuixEntry[];
  const programs = join(QUIXBUGS, 'programs');
  const template = createTemplateSource();
  const rows: QuixRow[] = [];
  for (const e of entries) {
    const file = loadFile(programs, `${e.name}.py`);
    let names: IntrospectedNames | null = null;
    if (e.hasJsonTests) {
      const tests = JSON.parse(readFileSync(join(QUIXBUGS, 'tests', `${e.name}.json`), 'utf8')) as { input: unknown[] }[];
      const input = tests[0]?.input ?? [];
      const chunks = ['import json', `from ${e.name} import ${e.name}`, `${e.name}(*json.loads(${JSON.stringify(JSON.stringify(input))}))`];
      names = await introspectRepro(run, { chunks, options: { packageName: null } }, { workspace: programs, python: 'python3', timeoutMs: QUIXBUGS_INTROSPECT_TIMEOUT_MS });
    }
    const sitesHere: { label: string; site: Site }[] = [{ label: `replace@${e.bugLine}`, site: replaceSiteAt(file, e.bugLine) }];
    const ins = INSERTION_SITES[e.name];
    if (ins !== undefined) sitesHere.push({ label: `insert@${ins.line}`, site: insertSiteAt(file, ins.line, ' '.repeat(ins.indent)) });
    const opts: EnumerateOptions = { cap: ENUMERATE_CAP, testLiterals: [], taskIdentifiers: [], corpus: new Map([[file.path, file]]) };
    for (const { label, site } of sitesHere) {
      const before = template.enumerate(site, opts).length;
      const after = names === null ? before : template.enumerate(site, { ...opts, introspected: names, extraNames: vocabularyAdditions(names, file) }).length;
      rows.push({ name: e.name, site: label, introspection: names === null ? 'no JSON tests (pytest module): no repro built' : `${names.status} ${names.durationMs} ms`, operands: names?.operands.length ?? 0, predicates: names?.predicates.length ?? 0, classes: names?.classes.slice(0, 6) ?? [], before, after, added: after - before });
      process.stderr.write(`  quixbugs ${e.name} ${label}: ${before} → ${after} (${names === null ? 'no repro' : `${names.status}, ${names.operands.length} operands, ${names.predicates.length} predicates, classes ${names.classes.slice(0, 4).join(',')}`})\n`);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------------------- main

mkdirSync(OUT_DIR, { recursive: true });
const records = (JSON.parse(readFileSync(join(ROOT, 'bench/data/swebench-verified-30.json'), 'utf8')) as Record_[]).filter((r) => INSTANCES.includes(r.instance_id) && (only === null || only.includes(r.instance_id)));
const gold = JSON.parse(readFileSync(join(ROOT, 'bench/data/swebench-verified-30.gold.json'), 'utf8')) as Record<string, string>;
const oracleRows = (JSON.parse(readFileSync(join(ROOT, 'experiments/oracle/results.json'), 'utf8')) as { rows?: OracleRow[] }).rows ?? [];

const results: InstanceResult[] = [];
if (!doQuixbugs || sweOnly || only !== null) {
  for (const rec of records) {
    process.stderr.write(`== ${rec.instance_id}\n`);
    const r = await studyInstance(rec, gold[rec.instance_id] ?? '', oracleRows.find((o) => o.instance_id === rec.instance_id));
    results.push(r);
    writeFileSync(join(OUT_DIR, 'introspect-history.partial.json'), JSON.stringify(results, null, 1));
    process.stderr.write(`   done in ${(r.wallMs / 1000).toFixed(1)} s\n`);
  }
}
let quix: QuixRow[] = [];
if (doQuixbugs && !sweOnly) {
  process.stderr.write('== QuixBugs 40 sites\n');
  quix = await studyQuixbugs();
}
const outPath = join(OUT_DIR, `introspect-history${only === null ? '' : `.${only.join('_')}`}${doQuixbugs ? '.quixbugs' : ''}.json`);
writeFileSync(outPath, JSON.stringify({ ran_at: new Date().toISOString(), spend_usd: 0, jev_requests: 0, enumerate_cap: ENUMERATE_CAP, instances: results, quixbugs: quix }, null, 1));

console.log('\n| instance | capability | candidate found | index (source / SEEDS) | site count before → after | vocab missing before → after | F2P pass |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const r of results) {
  const row = r.sites.find((s) => s.hitAfter.length > 0);
  const hit = row?.hitAfter[0];
  console.log(`| ${r.id} | ${r.capability} | ${hit === undefined ? 'no' : `**yes** \`${hit.text}\` (${hit.op}) at ${row!.site}`} | ${hit === undefined ? '-' : `${hit.index} / ${row!.seedsIndexAfter}`} | ${row === undefined ? r.sites.map((s) => `${s.site}: ${s.totalBefore} → ${s.totalAfter}`).join('; ') : `${row.totalBefore} → ${row.totalAfter} (templates ${row.templateBefore} → ${row.templateAfter}, history ${row.history})`} | ${row === undefined ? '-' : `${JSON.stringify(row.vocabMissingBefore)} → ${JSON.stringify(row.vocabMissingAfter)}`} | ${r.f2p === null ? (noF2P ? 'not run' : '-') : r.f2p.pass ? `**pass** (${(r.f2p.ms / 1000).toFixed(1)} s)` : `FAIL (${(r.f2p.ms / 1000).toFixed(1)} s)`} |`);
}
for (const r of results) {
  console.log(`\n### ${r.id}`);
  if (r.introspection !== null) console.log(`- introspection: ${r.introspection.status} in ${r.introspection.ms} ms; target \`${r.introspection.target ?? '-'}\`; module ${r.introspection.moduleName ?? '-'}; frames ${r.introspection.frames.join(' → ') || '-'}; names ${JSON.stringify(r.introspection.counts)}; operands: ${r.introspection.operands.map((o) => `\`${o.expr}\` ${o.type} [${o.classes.slice(0, 4).join(', ')}${o.classes.length > 4 ? ', …' : ''}] ${o.predicates} predicates (${o.falsy} falsy)${o.receiver ? ', receiver' : ''}${o.frame === null ? '' : ` @ ${o.frame}`}`).join('; ')}`);
  if (r.history !== null) console.log(`- history: ${r.history.note} (${r.history.commands} commands, ${r.history.ms} ms): ${r.history.commits.map((c) => `${c.sha} "${c.subject.slice(0, 60)}" ${c.reason} ${c.hunks} runs`).join('; ') || '-'}`);
  for (const s of r.sites) console.log(`- ${s.site}: mutation ${s.mutation}, templates ${s.templateBefore} → ${s.templateAfter} (+${s.introspectAdded} introspect), donor ${s.donor}, history ${s.history}; total ${s.totalBefore} → ${s.totalAfter}; gold hit before ${s.hitBefore.length} / after ${s.hitAfter.length}${s.hitAfter[0] === undefined ? '' : ` (${s.hitAfter[0].op} @${s.hitAfter[0].index}, SEEDS #${s.seedsIndexAfter})`}; top introspect: ${s.topIntrospect.map((t) => `\`${t}\``).join(', ') || '-'}`);
  if (r.f2p !== null) console.log(`- F2P: ${r.f2p.pass ? 'pass' : 'FAIL'} in ${r.f2p.ms} ms — ${r.f2p.tail.slice(-200).replace(/\s+/g, ' ')}`);
}
if (quix.length > 0) {
  const before = quix.reduce((n, q) => n + q.before, 0);
  const after = quix.reduce((n, q) => n + q.after, 0);
  const ran = quix.filter((q) => q.introspection.startsWith('ran')).length;
  console.log(`\n### QuixBugs: ${quix.length} sites, templates ${before} → ${after} candidates (+${after - before}, ${before === 0 ? 0 : (((after - before) / before) * 100).toFixed(1)} %); introspection ran on ${ran} sites`);
  console.log('| program | site | introspection | operands | predicates | classes | templates before → after |');
  console.log('| --- | --- | --- | --- | --- | --- | --- |');
  for (const q of quix) console.log(`| ${q.name} | ${q.site} | ${q.introspection} | ${q.operands} | ${q.predicates} | ${q.classes.join(', ')} | ${q.before} → ${q.after} |`);
}
console.log(`\nwritten ${outPath}`);
