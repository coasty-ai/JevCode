/**
 * Reach study for the 9 SWE-bench Verified instances whose issue oracle is VALID
 * (experiments/results/oracle-from-issue.md): can the jev-only candidate sources produce the gold
 * patch at the gold site, and if not, which capability is missing? Pure code, $0.00: no Jev call.
 *
 * Method (per instance, per gold hunk):
 *   1. parse the gold diff into contiguous change runs ("hunks"), classify each;
 *   2. build the Site the engine would build at the gold line (py/structure analyse/scopeAt/blockAt,
 *      the same fields search/sites.ts + localize/sites.ts fill), for a modification the replace site
 *      at the first removed line, for an insertion the gap site plus the replace sites of both
 *      neighbours (templates emit `_before`/`_after` forms at replace sites);
 *   3. enumerate the real sources (mutate, templates, donor, composite; ENUMERATE_CAP 254 and
 *      uncapped) with EnumerateOptions built the way search/subgoal.ts builds them (testLiterals from
 *      the oracle FailureView, taskIdentifiers from the issue text, corpus = the engine's
 *      loadPythonFiles cut: first MAX_WORKSPACE_PY_FILES non-test files alphabetically), apply every
 *      candidate with verify/apply.ts and compare the resulting file with the gold-patched file
 *      (code tokens per line, blanks/comments dropped); also whether the first gold line alone is in
 *      the set;
 *   4. sketch pool (sketch/pool.ts) shape coverage + slot vocabulary (fill/state.ts), token-beam
 *      vocabulary coverage (beam/vocab.ts);
 *   5. the queue's vocabulary pre-check (sieve/queue.ts vocabularyOf/missingFromVocab) and where the
 *      missing tokens live (other repo files, tests, an imported module, nowhere).
 *
 * Usage: node --env-file=.env node_modules/.bin/tsx experiments/reach/reach-oracle-9.mts [--only a,b] [--no-composite] [--engine-only]
 * Output: experiments/reach/out/reach-oracle-9.json (+ .md fragment)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildVocabulary } from '../../src/synth/beam/vocab.ts';
import { toks } from '../../src/synth/beam/tokens.ts';
import { createDonorSource } from '../../src/synth/donor/index.ts';
import { buildSlotVocabulary } from '../../src/synth/fill/state.ts';
import { functionGapSlots } from '../../src/synth/localize/sites.ts';
import { createMutationSource } from '../../src/synth/mutate/index.ts';
import { indentOf } from '../../src/synth/py/edits.ts';
import { analyse, blockAt, scopeAt, statementAt } from '../../src/synth/py/structure.ts';
import type { PyModule } from '../../src/synth/py/structure.ts';
import { tokenizeFragment } from '../../src/synth/py/tokenize.ts';
import { createCompositeSource } from '../../src/synth/search/composite.ts';
import { ENUMERATE_CAP, isTestPath, taskIdentifiers, testLiterals } from '../../src/synth/search/subgoal.ts';
import { missingFromVocab, vocabularyOf } from '../../src/synth/sieve/queue.ts';
import { sketchPool } from '../../src/synth/sketch/pool.ts';
import { instantiates, productionsFor } from '../../src/synth/sketch/productions.ts';
import { createTemplateSource } from '../../src/synth/templates/index.ts';
import type { Candidate, CandidateSource, EnumerateOptions, FailureView, Site, SourceFile } from '../../src/synth/types.ts';
import { applyCandidate } from '../../src/synth/verify/apply.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const REPOS = '/tmp/jevonly/repos';
const OUT_DIR = join(HERE, 'out');
/** src/synth/search/index.ts:44 — loadPythonFiles sorts the non-test .py paths and keeps the first 400 */
const MAX_WORKSPACE_PY_FILES = 400;
/** src/synth/index.ts:49 */
const BEAM_MAX_TOKENS = 25;
/** search/sites.ts:97 GAP_FUNCTION_MAX_LINES */
const GAP_FUNCTION_MAX_LINES = 40;
const UNCAPPED = 1_000_000;

const ORACLE_VALID = ['sympy__sympy-15345', 'sympy__sympy-17139', 'sympy__sympy-19954', 'sympy__sympy-11618', 'sympy__sympy-12096', 'django__django-15315', 'django__django-15128', 'django__django-15563', 'psf__requests-2931'];

const argv = process.argv.slice(2);
const onlyArg = argv.find((a) => a.startsWith('--only='));
const only = onlyArg === undefined ? null : onlyArg.slice('--only='.length).split(',');
const noComposite = argv.includes('--no-composite');
const engineOnly = argv.includes('--engine-only');
/**
 * composite.ts's donor-body units (enumerateDonorBodyUnits, composite.ts:620-668) walk every def of the
 * corpus × every 3–5-line window × adaptIdentifiers; at a def site on a 400-file sympy corpus one call
 * had not returned after 6 minutes (this study's first run), so they are off by default here and
 * timed separately with --donor-units (composite then = depth-2 pairs + signature units).
 */
const donorUnits = argv.includes('--donor-units');
/**
 * composite.ts's signature units (enumerateSignatureUnits, composite.ts:415-464) call `callSiteEdits`
 * per header draft, which runs `callsOf` → `scopeAt` on every single-line statement of every corpus
 * file (composite.ts:395-413): at sympy/core/function.py:510 with the 400-file corpus one call had not
 * returned after 10 minutes (second run of this study). Off by default; timed with --signature-units.
 */
const signatureUnits = argv.includes('--signature-units');

interface Record_ {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  fail_to_pass: string[];
  test_files: string[];
}

interface OracleRow {
  instance_id: string;
  outcome: string;
  criterion?: { form: string; strength: string };
  goal?: { test_id: string; call: string; expected: string; actual: string };
  base?: { ms: number };
  gold?: { ms: number };
}

// ---------------------------------------------------------------------------------------- diff parsing

interface Hunk {
  file: string;
  /** 1-based old line of the first removed line, or the old line before which the insertion goes */
  oldLine: number;
  removed: string[];
  added: string[];
  /** added lines that are code (not blank / comment-only) */
  addedCode: string[];
  removedCode: string[];
  kind: 'single_line_modification' | 'multi_line_modification' | 'pure_insertion' | 'deletion' | 'new_function' | 'non_code_only';
}

function isCodeLine(text: string): boolean {
  const t = text.trim();
  return t !== '' && !t.startsWith('#');
}

/** Contiguous runs of changed lines of a unified diff, with old-file numbering. */
function parseHunks(diff: string): Hunk[] {
  const out: Hunk[] = [];
  let file = '';
  let oldNo = 0;
  let run: { start: number; removed: string[]; added: string[] } | null = null;
  const flush = (): void => {
    if (run === null) return;
    const removedCode = run.removed.filter(isCodeLine);
    const addedCode = run.added.filter(isCodeLine);
    let kind: Hunk['kind'];
    if (removedCode.length === 0 && addedCode.length === 0) kind = 'non_code_only';
    else if (removedCode.length === 0) kind = /^\s*(def|class)\b/.test(addedCode[0] ?? '') ? 'new_function' : 'pure_insertion';
    else if (addedCode.length === 0) kind = 'deletion';
    else if (removedCode.length === 1 && addedCode.length === 1) kind = 'single_line_modification';
    else kind = 'multi_line_modification';
    out.push({ file, oldLine: run.start, removed: run.removed, added: run.added, addedCode, removedCode, kind });
    run = null;
  };
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git')) {
      flush();
      const m = /^diff --git a\/(\S+) b\/(\S+)/.exec(raw);
      file = m?.[2] ?? '';
      continue;
    }
    if (raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('index ')) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h !== null) {
      flush();
      oldNo = Number(h[1]);
      continue;
    }
    if (raw.startsWith('-')) {
      if (run === null) run = { start: oldNo, removed: [], added: [] };
      run.removed.push(raw.slice(1));
      oldNo += 1;
    } else if (raw.startsWith('+')) {
      if (run === null) run = { start: oldNo, removed: [], added: [] };
      run.added.push(raw.slice(1));
    } else {
      flush();
      if (raw.startsWith(' ') || raw === '') oldNo += 1;
    }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------------------- normalisation

/** Code tokens of one physical line joined by one space; '' for blank / comment / untokenizable. */
function normLine(text: string): string {
  const t = text.trim();
  if (t === '' || t.startsWith('#')) return '';
  try {
    return tokenizeFragment(text)
      .filter((k) => k.type === 'NAME' || k.type === 'NUMBER' || k.type === 'STRING' || k.type === 'OP')
      .map((k) => k.text)
      .join(' ');
  } catch {
    return t.replace(/\s+/g, ' ');
  }
}

function normLines(lines: readonly string[]): string[] {
  return lines.map(normLine).filter((l) => l !== '');
}

function splitLines(src: string): string[] {
  const lines = src.split(/\r?\n/);
  if (lines[lines.length - 1] === '' && /\r?\n$/.test(src)) lines.pop();
  return lines;
}

/** Base file lines with one hunk applied (gold for this hunk only). */
function applyHunkToLines(lines: readonly string[], h: Hunk): string[] {
  const before = lines.slice(0, h.oldLine - 1);
  const after = lines.slice(h.oldLine - 1 + h.removed.length);
  return [...before, ...h.added, ...after];
}

// ---------------------------------------------------------------------------------------- workspace

function sh(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
}

function nonTestPyFiles(workspace: string): string[] {
  return sh('git', ['ls-files', '*.py'], workspace)
    .split('\n')
    .filter((p) => p.endsWith('.py') && !isTestPath(p))
    .sort();
}

function loadFile(workspace: string, path: string): SourceFile | null {
  try {
    const src = readFileSync(join(workspace, path), 'utf8');
    return { path, src, mod: analyse(src) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------- sites

function blockOf(mod: PyModule, line: number): Site['block'] {
  const b = blockAt(mod, line);
  return b === undefined ? null : { name: b.name, startLine: b.startLine, endLine: b.endLine };
}

/** A replace site the way localize/sites.ts replaceSite builds one (search/sites.ts feeds the same fields). */
function replaceSiteAt(file: SourceFile, line: number): Site {
  const text = file.mod.lines[line - 1] ?? '';
  return { file, line, kind: 'replace', currentLine: text, indent: indentOf(text), block: blockOf(file.mod, line), scope: scopeAt(file.mod, line), evidence: { notes: ['gold site'] } };
}

/** An insert site before `line` at `indent` (localize/sites.ts insertSite 'after': scope of the line before the gap). */
function insertSiteAt(file: SourceFile, line: number, indent: string): Site {
  return { file, line, kind: 'insert', currentLine: '', indent, block: blockOf(file.mod, Math.max(1, line - 1)), scope: scopeAt(file.mod, Math.max(1, line - 1)), evidence: { notes: ['gold gap'] } };
}

// ---------------------------------------------------------------------------------------- comparison

interface Hit {
  op: string;
  index: number;
  text: string;
}

interface SourceRun {
  source: string;
  site: string;
  cap: number;
  count: number;
  ms: number;
  hunkHits: Hit[];
  firstLineHits: Hit[];
  error?: string;
}

function candidateLines(c: Candidate): string[] {
  const out = c.text.split('\n');
  for (const e of c.extraEdits ?? []) if (e.text !== undefined) out.push(...e.text.split('\n'));
  return out;
}

function runSource(name: string, src: CandidateSource, site: Site, siteLabel: string, opts: EnumerateOptions, goldFile: string[], goldFirst: string): SourceRun {
  const t0 = Date.now();
  let cands: Candidate[];
  try {
    cands = src.enumerate(site, opts);
  } catch (e) {
    return { source: name, site: siteLabel, cap: opts.cap, count: 0, ms: Date.now() - t0, hunkHits: [], firstLineHits: [], error: String(e).slice(0, 200) };
  }
  const ms = Date.now() - t0;
  const hunkHits: Hit[] = [];
  const firstLineHits: Hit[] = [];
  const goldKey = goldFile.join('\n');
  cands.forEach((c, index) => {
    const lines = normLines(candidateLines(c));
    if (lines.includes(goldFirst)) firstLineHits.push({ op: c.op, index, text: candidateLines(c).join(' ⏎ ').slice(0, 160) });
    try {
      const applied = applyCandidate(c);
      const after = applied.files.find((f) => f.path === site.file.path)?.after;
      if (after !== undefined && normLines(splitLines(after)).join('\n') === goldKey) hunkHits.push({ op: c.op, index, text: candidateLines(c).join(' ⏎ ').slice(0, 160) });
    } catch {
      // stale / out-of-range: not applicable
    }
  });
  return { source: name, site: siteLabel, cap: opts.cap, count: cands.length, ms, hunkHits, firstLineHits };
}

// ---------------------------------------------------------------------------------------- sketch / beam / vocab

interface SketchCheck {
  poolSize: number;
  uncappedSize: number;
  /** index in the capped pool of the first sketch the first gold line instantiates, or -1 */
  matchIndex: number;
  matchProduction: string | null;
  matchUncapped: boolean;
  holes: { i: number; gold: string; cls: string; inSlotVocab: boolean }[];
  fillable: boolean | null;
}

function sketchCheck(site: Site, opts: EnumerateOptions, goldFirstLine: string): SketchCheck {
  const goldToks = toks(goldFirstLine.trim());
  const pool = sketchPool(site, opts);
  let matchIndex = -1;
  let matchProduction: string | null = null;
  let match: string[] | null = null;
  pool.forEach((e, i) => {
    if (matchIndex >= 0) return;
    if (instantiates(e.toks, goldToks)) {
      matchIndex = i;
      matchProduction = e.production;
      match = e.toks;
    }
  });
  const all = productionsFor(site, opts);
  const matchUncapped = matchIndex >= 0 || all.some((s) => instantiates(s.toks, goldToks));
  const holes: SketchCheck['holes'] = [];
  let fillable: boolean | null = null;
  if (match !== null) {
    const m: string[] = match;
    const sv = buildSlotVocabulary(site, opts);
    const idents = new Set(sv.identifiers.map((o) => o.tok.text));
    const attrs = new Set(sv.attributes.map((o) => o.tok.text));
    const ops = new Set([...sv.operators, ...sv.assignments].map((o) => o.tok.text));
    const lits = new Set(sv.literals.map((o) => o.tok.text));
    m.forEach((s, i) => {
      if (s !== '_' && s !== '<op>') return;
      const gold = goldToks[i]!.text;
      let cls: string;
      let ok: boolean;
      if (s === '<op>') {
        cls = 'operator';
        ok = ops.has(gold);
      } else if (m[i - 1] === '.') {
        cls = 'attribute';
        ok = attrs.has(gold);
      } else {
        cls = 'value';
        ok = idents.has(gold) || lits.has(gold);
      }
      holes.push({ i, gold, cls, inSlotVocab: ok });
    });
    fillable = holes.every((h) => h.inSlotVocab);
  }
  return { poolSize: pool.length, uncappedSize: all.length, matchIndex, matchProduction, matchUncapped, holes, fillable };
}

interface BeamCheck {
  tokens: number;
  withinMaxTokens: boolean;
  missing: string[];
  vocabSize: number;
}

function beamCheck(site: Site, opts: EnumerateOptions, goldFirstLine: string): BeamCheck {
  const vocab = buildVocabulary(site, opts);
  const ts = toks(goldFirstLine.trim());
  const missing: string[] = [];
  ts.forEach((t, i) => {
    const v = vocab.byText.get(t.text);
    if (v === undefined) missing.push(t.text);
    else if (v.attributeOnly && ts[i - 1]?.text !== '.') missing.push(`${t.text} (attribute-only)`);
  });
  return { tokens: ts.length, withinMaxTokens: ts.length <= BEAM_MAX_TOKENS, missing, vocabSize: vocab.tokens.length };
}

interface VocabCheck {
  missing: string[];
  where: Record<string, string>;
}

function vocabCheck(site: Site, failures: FailureView[], task: string, goldAdded: string[], tokenIndex: Map<string, string[]>, testTokenIndex: Map<string, string[]>, moduleAttr: (name: string) => string | null): VocabCheck {
  const vocab = vocabularyOf(site.file, failures, task);
  const pseudo: Candidate = { id: 'gold', site, text: goldAdded.join('\n'), source: 'history', op: 'gold' };
  const missing = missingFromVocab(pseudo, vocab);
  const where: Record<string, string> = {};
  for (const m of missing) {
    const repo = tokenIndex.get(m) ?? [];
    const tests = testTokenIndex.get(m) ?? [];
    const mod = moduleAttr(m);
    const parts: string[] = [];
    if (repo.length > 0) parts.push(`repo: ${repo.length} file${repo.length === 1 ? '' : 's'} (${repo.slice(0, 2).join(', ')})`);
    if (tests.length > 0) parts.push(`tests: ${tests.slice(0, 2).join(', ')}`);
    if (mod !== null) parts.push(`module: ${mod}`);
    where[m] = parts.length === 0 ? 'nowhere (new name)' : parts.join('; ');
  }
  return { missing, where };
}

// ---------------------------------------------------------------------------------------- per instance

interface HunkResult {
  file: string;
  oldLine: number;
  kind: Hunk['kind'];
  removed: number;
  added: number;
  addedCode: number;
  goldFirst: string;
  block: string | null;
  blockLines: number | null;
  /** physical lines of the statement at the replace site (a multi-line statement needs a statement-level edit) */
  statementSpan: number | null;
  gapSlotLegal: boolean | null;
  fileInEngineCorpus: boolean;
  sites: string[];
  runs: SourceRun[];
  sketch: SketchCheck | null;
  beam: BeamCheck | null;
  vocab: VocabCheck | null;
  reachable: { source: string; site: string; cap: number; op: string; index: number }[];
  firstLineOnly: { source: string; site: string; cap: number; op: string; index: number }[];
}

interface InstanceResult {
  id: string;
  oracle: string;
  criterion: string;
  tRunMs: number | null;
  goldFileRank: number | null;
  nonTestPyFiles: number;
  goldFileInEngineCorpus: boolean;
  corpusMs: number;
  hunks: HunkResult[];
  allHunksReachable: boolean;
  wallMs: number;
}

function buildModuleAttrProbe(workspace: string, file: SourceFile, python: string | null): (name: string) => string | null {
  const modules = [...new Set(file.mod.imports.map((i) => i.module).filter((m): m is string => typeof m === 'string' && m !== ''))];
  const cache = new Map<string, string | null>();
  return (name: string): string | null => {
    if (cache.has(name)) return cache.get(name)!;
    let result: string | null = null;
    if (python !== null) {
      const script = `import builtins,importlib,sys\nsys.path.insert(0,${JSON.stringify(workspace)})\nname=${JSON.stringify(name)}\nif hasattr(builtins,name): print('builtins'); sys.exit()\nfor m in ${JSON.stringify(modules)}:\n  try:\n    mod=importlib.import_module(m)\n  except Exception: continue\n  if hasattr(mod,name): print(m); sys.exit()\n`;
      try {
        const out = execFileSync(python, ['-c', script], { cwd: workspace, encoding: 'utf8', timeout: 60_000 }).trim();
        result = out === '' ? null : out.split('\n').at(-1) ?? null;
      } catch {
        result = null;
      }
    }
    cache.set(name, result);
    return result;
  };
}

function venvPython(instanceId: string): string | null {
  try {
    const out = sh('/bin/sh', ['-c', `ls -d ${process.env['HOME']}/.jevcode/runs/bench-work/*/${instanceId}/*/workspace/.venv/bin/python 2>/dev/null | sort -r | head -5`], '/tmp').trim();
    for (const py of out.split('\n').filter((l) => l !== '')) {
      try {
        execFileSync(py, ['-c', 'import sys'], { timeout: 30_000 });
        return py;
      } catch {
        // next
      }
    }
  } catch {
    // none
  }
  return null;
}

function studyInstance(rec: Record_, gold: string, oracle: OracleRow | undefined): InstanceResult {
  const t0 = Date.now();
  const workspace = join(REPOS, rec.instance_id);
  const status = sh('git', ['status', '--short'], workspace).trim();
  if (status !== '') throw new Error(`${rec.instance_id}: worktree not clean: ${status.slice(0, 200)}`);
  const head = sh('git', ['rev-parse', 'HEAD'], workspace).trim();
  if (!head.startsWith(rec.base_commit.slice(0, 10)) && !rec.base_commit.startsWith(head.slice(0, 10))) throw new Error(`${rec.instance_id}: HEAD ${head} is not base_commit ${rec.base_commit}`);

  const failure: FailureView | null = oracle?.goal === undefined ? null : { testId: oracle.goal.test_id, call: oracle.goal.call, expected: oracle.goal.expected, actual: oracle.goal.actual };
  const failures = failure === null ? [] : [failure];
  const task = rec.problem_statement.split('\r\n').join('\n');
  const literals = testLiterals(failures);
  const identifiers = taskIdentifiers(task);

  const allPaths = nonTestPyFiles(workspace);
  const enginePaths = allPaths.slice(0, MAX_WORKSPACE_PY_FILES);
  const hunks = parseHunks(gold);
  const goldPath = hunks[0]?.file ?? '';
  const goldRank = allPaths.indexOf(goldPath);

  const tc = Date.now();
  const engineCorpus = new Map<string, SourceFile>();
  for (const p of enginePaths) {
    const f = loadFile(workspace, p);
    if (f !== null) engineCorpus.set(p, f);
  }
  const fullCorpus = new Map<string, SourceFile>(engineCorpus);
  if (!engineOnly) {
    for (const p of allPaths.slice(MAX_WORKSPACE_PY_FILES)) {
      const f = loadFile(workspace, p);
      if (f !== null) fullCorpus.set(p, f);
    }
  }
  const corpusMs = Date.now() - tc;
  // NAME-token index over the full repo (non-test) and over the test files, for the "where does it live" column
  const tokenIndex = new Map<string, string[]>();
  for (const [p, f] of fullCorpus) {
    const seen = new Set<string>();
    for (const t of f.mod.tokens) if (t.type === 'NAME' && !seen.has(t.text)) {
      seen.add(t.text);
      const l = tokenIndex.get(t.text) ?? [];
      l.push(p);
      tokenIndex.set(t.text, l);
    }
  }
  const testTokenIndex = new Map<string, string[]>();
  const testPaths = sh('git', ['ls-files', '*.py'], workspace).split('\n').filter((p) => p.endsWith('.py') && isTestPath(p));
  for (const p of testPaths) {
    let src = '';
    try {
      src = readFileSync(join(workspace, p), 'utf8');
    } catch {
      continue;
    }
    const seen = new Set<string>();
    for (const m of src.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      if (seen.has(m[0])) continue;
      seen.add(m[0]);
      const l = testTokenIndex.get(m[0]) ?? [];
      if (l.length < 5) l.push(p);
      testTokenIndex.set(m[0], l);
    }
  }
  const python = venvPython(rec.instance_id);

  const mutation = createMutationSource();
  const template = createTemplateSource();
  const donor = createDonorSource();
  const composite = createCompositeSource({ singles: [mutation, template, donor], donorUnits: false, signatureUnits: false });
  const unitsOnly = createCompositeSource({ singles: [mutation, template, donor], pairs: false, signatureUnits: false, donorUnits: true });
  const sigOnly = createCompositeSource({ singles: [mutation, template, donor], pairs: false, signatureUnits: true, donorUnits: false });
  const sources: [string, CandidateSource][] = [['mutation', mutation], ['template', template], ['donor', donor]];
  if (!noComposite) sources.push(['composite', composite]);
  if (donorUnits) sources.push(['donor_units', unitsOnly]);
  if (signatureUnits) sources.push(['signature_units', sigOnly]);

  const results: HunkResult[] = [];
  const fileCache = new Map<string, SourceFile>();
  for (const h of hunks) {
    if (h.kind === 'non_code_only') {
      results.push({ file: h.file, oldLine: h.oldLine, kind: h.kind, removed: h.removed.length, added: h.added.length, addedCode: 0, goldFirst: '', block: null, blockLines: null, statementSpan: null, gapSlotLegal: null, fileInEngineCorpus: engineCorpus.has(h.file), sites: [], runs: [], sketch: null, beam: null, vocab: null, reachable: [], firstLineOnly: [] });
      continue;
    }
    let file = fileCache.get(h.file) ?? engineCorpus.get(h.file) ?? fullCorpus.get(h.file) ?? loadFile(workspace, h.file);
    if (file === null) throw new Error(`${rec.instance_id}: cannot load ${h.file}`);
    fileCache.set(h.file, file);
    const baseLines = file.mod.lines;
    const goldFileNorm = normLines(applyHunkToLines(baseLines, h));
    const goldFirst = normLine(h.addedCode[0] ?? h.added[0] ?? '');
    const goldIndent = indentOf(h.addedCode[0] ?? h.added[0] ?? '');

    // sites: modification/deletion → replace at the first removed line; insertion → the gap and both neighbours
    const sites: { label: string; site: Site }[] = [];
    if (h.removed.length > 0) sites.push({ label: `replace@${h.oldLine}`, site: replaceSiteAt(file, h.oldLine) });
    else {
      sites.push({ label: `insert@${h.oldLine}`, site: insertSiteAt(file, h.oldLine, goldIndent) });
      // neighbours: the previous code line and the line after the gap (templates' `_after` / `_before` forms)
      let prev = h.oldLine - 1;
      while (prev >= 1 && !isCodeLine(baseLines[prev - 1] ?? '')) prev--;
      if (prev >= 1) sites.push({ label: `replace@${prev}(before gap)`, site: replaceSiteAt(file, prev) });
      if (h.oldLine <= baseLines.length && isCodeLine(baseLines[h.oldLine - 1] ?? '')) sites.push({ label: `replace@${h.oldLine}(after gap)`, site: replaceSiteAt(file, h.oldLine) });
    }
    const primary = sites[0]!.site;
    const block = blockOf(file.mod, h.removed.length > 0 ? h.oldLine : Math.max(1, h.oldLine - 1));
    const st = h.removed.length > 0 ? statementAt(file.mod, h.oldLine) : undefined;
    // a slot at the gold indent anywhere between the previous code line and the gap line is the same
    // gap once blank lines are ignored (gapIndentsAfter numbers the dedent levels on consecutive lines)
    let gapSlotLegal: boolean | null = null;
    if (h.removed.length === 0 && block !== null) {
      const slots = functionGapSlots(file, block.startLine, block.endLine);
      let prevCode = h.oldLine - 1;
      while (prevCode >= 1 && !isCodeLine(baseLines[prevCode - 1] ?? '')) prevCode--;
      gapSlotLegal = slots.some((s) => s.line > prevCode && s.line <= h.oldLine && s.indent === goldIndent);
    }

    const runs: SourceRun[] = [];
    const corpora: [string, Map<string, SourceFile>][] = [['engine', engineCorpus]];
    if (!engineOnly) corpora.push(['full', fullCorpus]);
    for (const [corpusName, corpus] of corpora) {
      for (const cap of [ENUMERATE_CAP, UNCAPPED]) {
        const opts: EnumerateOptions = { cap, testLiterals: literals, taskIdentifiers: identifiers, corpus };
        for (const { label, site } of sites) {
          for (const [name, src] of sources) {
            // mutation does not read the corpus: run it once per cap
            if (name === 'mutation' && corpusName === 'full') continue;
            // composite is bounded by its own limits (SECOND_ORDER_LIMIT 100, SIGNATURE_UNIT_LIMIT 20,
            // DONOR_UNIT_LIMIT 48), not by opts.cap, and its donor-body units walk every def of the
            // corpus: run it once per site, on the engine corpus, at the engine cap
            if ((name === 'composite' || name === 'donor_units' || name === 'signature_units') && (cap !== ENUMERATE_CAP || corpusName !== 'engine')) continue;
            const r = runSource(name, src, site, `${label}|${corpusName}`, opts, goldFileNorm, goldFirst);
            runs.push(r);
            process.stderr.write(`  ${rec.instance_id} ${h.file}:${h.oldLine} ${label} ${corpusName} cap=${cap} ${name}: ${r.count} cands ${r.ms} ms hunk=${r.hunkHits.length} first=${r.firstLineHits.length}${r.error === undefined ? '' : ` ERR ${r.error}`}\n`);
          }
        }
      }
    }
    const engineOpts: EnumerateOptions = { cap: ENUMERATE_CAP, testLiterals: literals, taskIdentifiers: identifiers, corpus: engineCorpus };
    const sk = sketchCheck(primary, engineOpts, h.addedCode[0] ?? h.added[0] ?? '');
    const bm = beamCheck(primary, engineOpts, h.addedCode[0] ?? h.added[0] ?? '');
    const vc = vocabCheck(primary, failures, task, h.addedCode, tokenIndex, testTokenIndex, buildModuleAttrProbe(workspace, file, python));
    const reachable = runs.flatMap((r) => r.hunkHits.map((hit) => ({ source: r.source, site: r.site, cap: r.cap, op: hit.op, index: hit.index })));
    const firstLineOnly = runs.flatMap((r) => r.firstLineHits.map((hit) => ({ source: r.source, site: r.site, cap: r.cap, op: hit.op, index: hit.index })));
    results.push({
      file: h.file,
      oldLine: h.oldLine,
      kind: h.kind,
      removed: h.removed.length,
      added: h.added.length,
      addedCode: h.addedCode.length,
      goldFirst,
      block: block?.name ?? null,
      blockLines: block === null ? null : block.endLine - block.startLine + 1,
      statementSpan: st === undefined ? null : st.endLine - st.startLine + 1,
      gapSlotLegal,
      fileInEngineCorpus: engineCorpus.has(h.file),
      sites: sites.map((s) => s.label),
      runs,
      sketch: sk,
      beam: bm,
      vocab: vc,
      reachable,
      firstLineOnly,
    });
  }
  const codeHunks = results.filter((r) => r.kind !== 'non_code_only');
  return {
    id: rec.instance_id,
    oracle: oracle?.outcome ?? 'none',
    criterion: oracle?.criterion === undefined ? '-' : `${oracle.criterion.form} (${oracle.criterion.strength})`,
    tRunMs: oracle?.base?.ms ?? null,
    goldFileRank: goldRank < 0 ? null : goldRank + 1,
    nonTestPyFiles: allPaths.length,
    goldFileInEngineCorpus: goldRank >= 0 && goldRank < MAX_WORKSPACE_PY_FILES,
    corpusMs,
    hunks: results,
    allHunksReachable: codeHunks.length > 0 && codeHunks.every((r) => r.reachable.length > 0),
    wallMs: Date.now() - t0,
  };
}

// ---------------------------------------------------------------------------------------- main

const records = (JSON.parse(readFileSync(join(ROOT, 'bench/data/swebench-verified-30.json'), 'utf8')) as Record_[]).filter((r) => ORACLE_VALID.includes(r.instance_id) && (only === null || only.includes(r.instance_id)));
const gold = JSON.parse(readFileSync(join(ROOT, 'bench/data/swebench-verified-30.gold.json'), 'utf8')) as Record<string, string>;
const oracleRows = (JSON.parse(readFileSync(join(ROOT, 'experiments/oracle/results.json'), 'utf8')) as { rows?: OracleRow[] }).rows ?? [];

mkdirSync(OUT_DIR, { recursive: true });
const out: InstanceResult[] = [];
const suffix = `${donorUnits ? '.units' : ''}${signatureUnits ? '.sig' : ''}`;
const partialPath = join(OUT_DIR, `reach-oracle-9.partial${only === null ? '' : `.${only.join('_')}`}${suffix}.json`);
for (const rec of records) {
  process.stderr.write(`== ${rec.instance_id}\n`);
  const r = studyInstance(rec, gold[rec.instance_id] ?? '', oracleRows.find((o) => o.instance_id === rec.instance_id));
  out.push(r);
  writeFileSync(partialPath, JSON.stringify(out, null, 1));
  process.stderr.write(`   done in ${(r.wallMs / 1000).toFixed(1)} s; all hunks reachable: ${r.allHunksReachable}\n`);
}
const outPath = join(OUT_DIR, `${only === null ? 'reach-oracle-9' : `reach-oracle-9.${only.join('_')}`}${suffix}.json`);
writeFileSync(outPath, JSON.stringify({ ran_at: new Date().toISOString(), spend_usd: 0, jev_requests: 0, max_workspace_py_files: MAX_WORKSPACE_PY_FILES, enumerate_cap: ENUMERATE_CAP, instances: out }, null, 1));

// compact table to stdout
for (const r of out) {
  console.log(`\n### ${r.id} — oracle ${r.oracle}, ${r.criterion}, t_run ${r.tRunMs} ms; gold file rank ${r.goldFileRank}/${r.nonTestPyFiles} (in engine corpus: ${r.goldFileInEngineCorpus}); all hunks reachable: ${r.allHunksReachable}`);
  for (const h of r.hunks) {
    if (h.kind === 'non_code_only') {
      console.log(`- ${h.file}:${h.oldLine} ${h.kind} (-${h.removed}/+${h.added})`);
      continue;
    }
    console.log(`- ${h.file}:${h.oldLine} ${h.kind} (-${h.removed}/+${h.added}, code +${h.addedCode}) in ${h.block ?? '<module>'}${h.blockLines === null ? '' : ` (${h.blockLines} lines)`}${h.statementSpan !== null && h.statementSpan > 1 ? `; statement spans ${h.statementSpan} lines` : ''}${h.gapSlotLegal === null ? '' : `; gap slot legal: ${h.gapSlotLegal}`}`);
    console.log(`  gold first line: ${h.goldFirst}`);
    const bySource = new Map<string, SourceRun[]>();
    for (const run of h.runs) {
      const k = `${run.source}|${run.site}`;
      bySource.set(k, [...(bySource.get(k) ?? []), run]);
    }
    for (const [k, list] of bySource) {
      const capped = list.find((x) => x.cap === ENUMERATE_CAP);
      const unc = list.find((x) => x.cap === UNCAPPED);
      console.log(`  ${k}: n=${capped?.count ?? '-'} (uncapped ${unc?.count ?? '-'}) hunk hit: ${capped?.hunkHits.length ?? 0}/${unc?.hunkHits.length ?? 0} first-line hit: ${capped?.firstLineHits.length ?? 0}/${unc?.firstLineHits.length ?? 0}${(capped?.hunkHits[0] ?? unc?.hunkHits[0]) === undefined ? '' : ` via ${(capped?.hunkHits[0] ?? unc?.hunkHits[0])!.op} @${(capped?.hunkHits[0] ?? unc?.hunkHits[0])!.index}`}${(capped?.firstLineHits[0] ?? unc?.firstLineHits[0]) === undefined ? '' : ` first via ${(capped?.firstLineHits[0] ?? unc?.firstLineHits[0])!.op}`}`);
    }
    if (h.sketch !== null) console.log(`  sketch: pool ${h.sketch.poolSize} (uncapped ${h.sketch.uncappedSize}); gold shape at ${h.sketch.matchIndex} (${h.sketch.matchProduction ?? '-'}; uncapped ${h.sketch.matchUncapped}); holes ${JSON.stringify(h.sketch.holes)}; fillable ${h.sketch.fillable}`);
    if (h.beam !== null) console.log(`  beam vocab: ${h.beam.tokens} tokens (≤25: ${h.beam.withinMaxTokens}); missing ${JSON.stringify(h.beam.missing)}; vocab ${h.beam.vocabSize}`);
    if (h.vocab !== null) console.log(`  queue vocab missing: ${JSON.stringify(h.vocab.where)}`);
  }
}
console.log(`\nwritten ${outPath}`);
