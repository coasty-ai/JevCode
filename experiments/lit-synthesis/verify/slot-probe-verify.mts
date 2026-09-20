/**
 * Grammar-guided Choice synthesis pilot on QuixBugs (live Jev, ~$0.05).
 *
 * Per program with a one-line replacement fix:
 *  probe request (one batched request, independent questions):
 *    kind        Choice over statement kinds of the replacement line
 *    wrong_token Choice over tokens of the buggy line ("which token is wrong", escape = a token is missing)
 *    cloze_i     Choice for each slot of the fixed line with every other token visible
 *    prefix_i    Choice for each slot with only the true prefix visible and `?` for later slots
 *  S2 diff-fill  real left-to-right beam (B=3) over only the slots that differ from the buggy line
 *  S1 full-fill  real left-to-right beam (B=3) over every slot of the fixed line's shape
 *  Both verified by running the QuixBugs JSON tests with python3 (the oracle).
 *
 * Usage: env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/lit-synthesis/slot-probe.mts [maxPrograms] [beam]
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createJevDecider } from '../../../src/jev/client.ts';
import { choice } from '../../../src/jev/questions.ts';
import type { Json, Question, Answer } from '../../../src/core/types.ts';

const ROOT = '/tmp/quixbugs';
const OUT = '/Users/prateekjannu/Documents/vscode/JevCode/experiments/lit-synthesis/verify';
const WORK = '/tmp/jevonly/synth';
const MAX = Number(process.argv[2] ?? 40);
const BEAM = Number(process.argv[3] ?? 3);
const SPEND_CAP = 0.08;
const key = process.env['OPENROUTER_API_KEY'] ?? '';
if (!key) throw new Error('OPENROUTER_API_KEY missing');
const jev = createJevDecider({ baseUrl: 'https://openrouter.ai/api/alpha/decisions', apiKey: key, model: 'typesafe/jev-1.13-20260917', pinned: true }, { redact: (s) => s });
const signal = new AbortController().signal;
let spend = 0; const latencies: number[] = []; let requests = 0; let retries = 0;
async function ask(state: Json, qs: Record<string, Question>): Promise<Record<string, Answer>> {
  if (spend > SPEND_CAP) throw new Error(`spend cap ${SPEND_CAP} reached`);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await jev.ask(state, qs, { signal, stage: 'propose', step: 1 });
      spend += r.usage.costUsd; latencies.push(r.latencyMs); requests++;
      return r.answers;
    } catch (e) { lastErr = e; retries++; }
  }
  throw lastErr;
}
function ranked(a: Answer): [string, number][] { return a.type === 'choice' ? Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]) : []; }

// ---------------------------------------------------------------- tokenizer (one logical line)
type TokType = 'name' | 'num' | 'str' | 'op' | 'kw' | 'punct';
interface Tok { type: TokType; text: string }
const KEYWORDS = new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' '));
const KW_OPS = new Set(['and', 'or', 'not', 'in', 'is']);
const OPS = new Set(['+', '-', '*', '/', '//', '%', '**', '==', '!=', '<', '<=', '>', '>=', '&', '|', '^', '<<', '>>', '~']);
const TOKEN_RE = /\s*(?:(?<str>[rbfuRBFU]{0,2}(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"))|(?<num>\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+)|(?<name>[A-Za-z_]\w*)|(?<op>\*\*=|\/\/=|>>=|<<=|\.\.\.|->|\*\*|\/\/|<<|>>|<=|>=|==|!=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|:=|[-+*\/%@&|^~<>=()\[\]{},:.;]))/y;
export function tokenize(line: string): Tok[] {
  const src = line.replace(/#.*$/, '').trim(); const out: Tok[] = []; TOKEN_RE.lastIndex = 0;
  while (TOKEN_RE.lastIndex < src.length) {
    const m = TOKEN_RE.exec(src); if (!m || m[0] === '') { if (src.slice(TOKEN_RE.lastIndex).trim() === '') break; throw new Error(`cannot tokenize: ${src.slice(TOKEN_RE.lastIndex)}`); }
    const g = m.groups!;
    if (g['str'] !== undefined) out.push({ type: 'str', text: g['str'] });
    else if (g['num'] !== undefined) out.push({ type: 'num', text: g['num'] });
    else if (g['name'] !== undefined) out.push({ type: KW_OPS.has(g['name']) ? 'op' : KEYWORDS.has(g['name']) ? 'kw' : 'name', text: g['name'] });
    else if (g['op'] !== undefined) out.push({ type: OPS.has(g['op']) ? 'op' : 'punct', text: g['op'] });
  }
  return out;
}
type SlotClass = 'ident' | 'attr' | 'oper' | 'num' | null;
function slotClass(toks: Tok[], i: number): SlotClass {
  const t = toks[i]!;
  if (t.type === 'name') return toks[i - 1]?.text === '.' ? 'attr' : 'ident';
  if (t.type === 'op') return 'oper';
  if (t.type === 'num') return 'num';
  return null;
}
function shape(toks: Tok[]): string { return toks.map((t) => (t.type === 'name' ? 'ID' : t.type === 'num' ? 'NUM' : t.type === 'str' ? 'STR' : t.text)).join(' '); }
function render(toks: string[]): string { return toks.join(' '); }
function lcs<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): [number, number][] {
  const n = a.length, m = b.length; const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = eq(a[i]!, b[j]!) ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const pairs: [number, number][] = []; let i = 0, j = 0;
  while (i < n && j < m) { if (eq(a[i]!, b[j]!)) { pairs.push([i, j]); i++; j++; } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++; else j++; }
  return pairs;
}

// ---------------------------------------------------------------- option sets (code proposes)
const BUILTINS = ['len', 'range', 'enumerate', 'min', 'max', 'abs', 'sum', 'sorted', 'reversed', 'list', 'set', 'dict', 'tuple', 'str', 'int', 'float', 'all', 'any', 'zip', 'isinstance', 'None', 'True', 'False'];
const COMMON_ATTRS = ['append', 'pop', 'extend', 'insert', 'remove', 'keys', 'values', 'items', 'get', 'add', 'join', 'split', 'strip', 'lower', 'upper', 'popleft', 'appendleft', 'sort', 'index', 'count', 'isdigit', 'isalpha', 'startswith', 'endswith'];
const OPERATORS: Record<string, string> = { op_plus: '+', op_minus: '-', op_times: '*', op_divide: '/', op_floordiv: '//', op_mod: '%', op_power: '**', op_eq: '==', op_ne: '!=', op_lt: '<', op_le: '<=', op_gt: '>', op_ge: '>=', op_and: 'and', op_or: 'or', op_not: 'not', op_in: 'in', op_is: 'is', op_bitand: '&', op_bitor: '|', op_xor: '^', op_shl: '<<', op_shr: '>>', op_invert: '~' };
interface Scope { idents: Record<string, string>; attrs: Set<string>; nums: Set<string> }
function scanScope(lines: string[]): Scope {
  const roles = new Map<string, string>(); const attrs = new Set<string>(); const nums = new Set<string>();
  const set = (n: string, r: string) => { if (!roles.has(n)) roles.set(n, r); };
  for (const [li, raw] of lines.entries()) {
    const l = raw.replace(/#.*$/, '');
    const def = /def\s+(\w+)\s*\(([^)]*)\)/.exec(l);
    if (def) { set(def[1]!, `function defined at line ${li + 1}`); for (const p of def[2]!.split(',')) { const n = p.trim().replace(/^\*+/, '').split(/[=:]/)[0]!.trim(); if (n) set(n, `parameter of ${def[1]}`); } continue; }
    const forM = /for\s+(.+?)\s+in\s/.exec(l);
    if (forM) for (const n of forM[1]!.split(',')) { const nn = n.trim().replace(/[()]/g, ''); if (/^\w+$/.test(nn)) set(nn, `loop variable at line ${li + 1}`); }
    const asg = /^\s*([\w, *]+?)\s*(?:[-+*\/%]?=)(?!=)/.exec(l);
    if (asg && !/^\s*(if|elif|while|return|yield)\b/.test(l)) for (const n of asg[1]!.split(',')) { const nn = n.trim().replace(/^\*/, ''); if (/^\w+$/.test(nn) && !KEYWORDS.has(nn)) set(nn, `local variable assigned at line ${li + 1}`); }
    const withM = /(?:as|import)\s+(\w+)/.exec(l); if (withM) set(withM[1]!, `imported name at line ${li + 1}`);
    for (const t of tokenize(l)) { if (t.type === 'num') nums.add(t.text); }
    for (const t of tokenize(l).map((t, i, arr) => (t.type === 'name' && arr[i - 1]?.text === '.' ? t.text : null))) if (t) attrs.add(t);
    for (const t of tokenize(l)) if (t.type === 'name') set(t.text, `name used at line ${li + 1}`);
  }
  for (const a of attrs) if (roles.get(a)?.startsWith('name used')) roles.delete(a);
  for (const b of BUILTINS) set(b, 'Python builtin');
  return { idents: Object.fromEntries(roles), attrs, nums };
}
function keyFor(prefix: string, text: string, used: Set<string>): string {
  let k = `${prefix}_${text.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+/, '') || 'x'}`; if (k.length > 60) k = k.slice(0, 60);
  let kk = k, i = 2; while (used.has(kk)) kk = `${k}_${i++}`; used.add(kk); return kk;
}
interface OptionSet { options: Record<string, string>; byKey: Record<string, string> }
function optionsFor(cls: SlotClass, scope: Scope, tests: Json[]): OptionSet {
  const used = new Set<string>(); const options: Record<string, string> = {}; const byKey: Record<string, string> = {};
  const add = (prefix: string, text: string, desc: string) => { if (Object.values(byKey).includes(text)) return; const k = keyFor(prefix, text, used); options[k] = desc; byKey[k] = text; };
  if (cls === 'ident') for (const [n, r] of Object.entries(scope.idents)) add('name', n, `\`${n}\` (${r})`);
  else if (cls === 'attr') { for (const a of scope.attrs) add('attr', a, `\`.${a}\` (attribute used in program)`); for (const a of COMMON_ATTRS) add('attr', a, `\`.${a}\``); }
  else if (cls === 'oper') for (const [k, v] of Object.entries(OPERATORS)) { options[k] = `\`${v}\``; byKey[k] = v; }
  else if (cls === 'num') {
    const cands = new Set<string>(['0', '1', '2', '3', '10']); for (const n of scope.nums) cands.add(n);
    const walk = (v: Json): void => { if (typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= 100) cands.add(String(v)); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
    tests.forEach(walk);
    for (const c of [...cands].slice(0, 30)) add('num', c, `\`${c}\``);
  }
  return { options, byKey };
}

// ---------------------------------------------------------------- test oracle
function codeOnly(src: string): string[] { const i = src.indexOf('\n"""'); return (i > 0 ? src.slice(0, i) : src).replace(/\s+$/, '').split('\n'); }
const RUNNER = `
import json, sys, types, math, signal
sys.setrecursionlimit(5000)
mod = __import__(sys.argv[1]); fx = getattr(mod, sys.argv[1])
tests = json.load(open(sys.argv[2]))
class Timeout(Exception): pass
def _alarm(*a): raise Timeout()
signal.signal(signal.SIGALRM, _alarm)
def norm(o):
    if isinstance(o, types.GeneratorType): o = list(o)
    return json.loads(json.dumps(o, default=str))
def eq(a, b):
    if isinstance(a, float) or isinstance(b, float):
        try: return math.isclose(float(a), float(b), rel_tol=1e-6, abs_tol=1e-6)
        except Exception: return False
    if isinstance(a, list) and isinstance(b, list): return len(a) == len(b) and all(eq(x, y) for x, y in zip(a, b))
    return a == b
passed = []
for k, (inp, exp) in enumerate(tests):
    args = inp if isinstance(inp, list) else [inp]
    signal.alarm(2)
    try:
        out = norm(fx(*args))
    except Timeout:
        out = ('__timeout__',)
    except Exception as e:
        out = ('__exc__', type(e).__name__)
    signal.alarm(0)
    if eq(out, exp): passed.append(k)
print(json.dumps({"ok": len(passed), "n": len(tests), "passed": passed}))
`;
function runTests(prog: string, lines: string[], tests: string[]): { ok: number; n: number; passed: number[]; timeout?: boolean } {
  const h = createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 10);
  const dir = join(WORK, `${prog}_${h}`); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${prog}.py`), lines.join('\n') + '\n'); writeFileSync(join(dir, 'runner.py'), RUNNER); writeFileSync(join(dir, 'tests.json'), `[${tests.join(',')}]`);
  try {
    const out = execFileSync('python3', ['runner.py', prog, 'tests.json'], { cwd: dir, timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n').pop()!;
    return JSON.parse(out) as { ok: number; n: number; passed: number[] };
  } catch { return { ok: 0, n: tests.length, passed: [], timeout: true }; }
}

// ---------------------------------------------------------------- per program
const KINDS: Record<string, string> = {
  return_statement: 'a `return` statement', assignment: 'an assignment `target = value` (also tuple or subscript targets)', augmented_assignment: 'an augmented assignment such as `x += 1` or `n &= n - 1`',
  if_statement: 'an `if` condition line', elif_statement: 'an `elif` condition line', while_loop: 'a `while` condition line', for_loop: 'a `for ... in ...:` loop header',
  yield_statement: 'a `yield` statement', call_statement: 'a bare call such as `steps.append(x)`', other_statement: 'some other statement kind (def, else, try, import, ...)',
};
function kindOf(line: string): string {
  const l = line.trim();
  if (/^return\b/.test(l)) return 'return_statement'; if (/^yield\b/.test(l)) return 'yield_statement'; if (/^if\b/.test(l)) return 'if_statement'; if (/^elif\b/.test(l)) return 'elif_statement';
  if (/^while\b/.test(l)) return 'while_loop'; if (/^for\b/.test(l)) return 'for_loop'; if (/^[\w.\[\], *]+\s*(?:[-+*\/%&|^]|\/\/|\*\*|<<|>>)=(?!=)/.test(l)) return 'augmented_assignment';
  if (/^[\w.\[\], *]+\s*=(?!=)/.test(l)) return 'assignment'; if (/^[\w.]+\(.*\)$/.test(l)) return 'call_statement'; return 'other_statement';
}
interface SlotResult { i: number; cls: SlotClass; truth: string; nOptions: number; covered: boolean; cloze: { top1: boolean; rank: number; p: number; escape: number }; prefix: { top1: boolean; rank: number; p: number; escape: number } }
interface BeamResult { holes: number; requests: number; beam: string[]; truthRank: number; passRank: number; logpTruth: number | null; testsGoldOk: boolean }
interface ProgResult { program: string; lines: number; oracleTests: number; totalTests: number; goldPassesAll: boolean; buggy: string; fixed: string; kind: { truth: string; pick: string; p: number; ok: boolean }; wrongToken: { truth: string[]; pick: string; p: number; ok: boolean; nTokens: number }; shapeSame: boolean; shapeInDonors: boolean; slots: SlotResult[]; s2: BeamResult | null; s1: BeamResult | null; costUsd: number; requests: number }

function makeHoleQuestion(path: string, opts: Record<string, string>): Question {
  return choice(`\`${path}\` is a partially written replacement for \`buggy_line\` in \`program\`. Tokens before \`<HOLE>\` are fixed; each \`?\` is a token still to be filled in later. Which option is the correct token for \`<HOLE>\`, so that the finished line makes every entry of \`tests\` pass? Pick \`none_of_these\` if no option fits.`, opts);
}
function partial(toks: Tok[], slotIdx: number[], filled: string[], holeAt: number, mode: 'prefix' | 'cloze'): string {
  const out = toks.map((t) => t.text); const pos = new Map(slotIdx.map((s, k) => [s, k] as const));
  for (const [s, k] of pos) { if (k < filled.length) out[s] = filled[k]!; else if (k === holeAt) out[s] = '<HOLE>'; else if (mode === 'prefix') out[s] = '?'; }
  if (mode === 'cloze') { for (const [s, k] of pos) if (k !== holeAt) out[s] = toks[s]!.text; out[slotIdx[holeAt]!] = '<HOLE>'; }
  return render(out);
}

async function beamFill(base: Json, prog: string, buggyIdx: number, lines: string[], indent: string, toks: Tok[], slotIdx: number[], truthFill: string[], optionSets: OptionSet[], tests: string[], width: number): Promise<BeamResult> {
  let beam: { filled: string[]; logp: number }[] = [{ filled: [], logp: 0 }]; let reqs = 0; let logpTruth: number | null = 0;
  const names = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
  for (let h = 0; h < slotIdx.length; h++) {
    const os = optionSets[h]!;
    const cands: Record<string, Json> = {}; const qs: Record<string, Question> = {};
    beam.forEach((b, bi) => { cands[names[bi]!] = partial(toks, slotIdx, b.filled, h, 'prefix'); qs[`fill_${names[bi]}`] = makeHoleQuestion(`candidates.${names[bi]}`, os.options); });
    const ans = await ask({ ...base, candidates: cands }, qs); reqs++;
    const next: { filled: string[]; logp: number }[] = [];
    beam.forEach((b, bi) => {
      const r = ranked(ans[`fill_${names[bi]}`]!).filter(([k]) => k !== 'none_of_these');
      const isTruthPrefix = logpTruth !== null && b.filled.every((f, k) => f === truthFill[k]);
      if (isTruthPrefix) { const pt = r.find(([k]) => os.byKey[k] === truthFill[h])?.[1]; if (pt === undefined || pt <= 0) logpTruth = null; else logpTruth! += Math.log(pt); }
      for (const [k, p] of r.slice(0, width)) next.push({ filled: [...b.filled, os.byKey[k]!], logp: b.logp + Math.log(Math.max(p, 1e-4)) });
    });
    const seen = new Set<string>(); beam = next.sort((a, b) => b.logp - a.logp).filter((x) => { const s = x.filled.join('\u0001'); if (seen.has(s)) return false; seen.add(s); return true; }).slice(0, width);
    if (logpTruth !== null && !beam.some((b) => b.filled.every((f, k) => f === truthFill[k]))) logpTruth = null; // truth fell out of the beam
  }
  const rendered = beam.map((b) => { const out = toks.map((t) => t.text); slotIdx.forEach((s, k) => (out[s] = b.filled[k]!)); return render(out); });
  const truthLine = render(toks.map((t) => t.text));
  const truthRank = rendered.findIndex((l) => l === truthLine) + 1;
  let passRank = 0;
  for (const [i, l] of rendered.entries()) { const cand = [...lines]; cand[buggyIdx] = indent + l; const r = runTests(prog, cand, tests); if (r.ok === r.n && !r.timeout) { passRank = i + 1; break; } }
  const goldLines = [...lines]; goldLines[buggyIdx] = indent + truthLine; const g = runTests(prog, goldLines, tests);
  return { holes: slotIdx.length, requests: reqs, beam: rendered, truthRank, passRank, logpTruth, testsGoldOk: g.ok === g.n };
}

async function runProgram(p: string): Promise<ProgResult | null> {
  const buggy = codeOnly(readFileSync(join(ROOT, 'python_programs', `${p}.py`), 'utf8')).filter((l) => l.trim() !== '' && !/^\s*#/.test(l));
  const fixed = codeOnly(readFileSync(join(ROOT, 'correct_python_programs', `${p}.py`), 'utf8')).filter((l) => l.trim() !== '' && !/^\s*#/.test(l));
  if (buggy.length !== fixed.length) return null; // insertion/deletion fixes are out of scope for the slot probe
  const diffs = buggy.map((l, i) => [l, i] as const).filter(([l, i]) => l.replace(/#.*$/, '').trimEnd() !== fixed[i]!.replace(/#.*$/, '').trimEnd());
  if (diffs.length !== 1) return null;
  const bi = diffs[0]![1]; const buggyLine = buggy[bi]!.replace(/#.*$/, '').trimEnd(); const fixedLine = fixed[bi]!.replace(/#.*$/, '').trimEnd();
  const indent = /^\s*/.exec(buggyLine)![0];
  const testLines = readFileSync(join(ROOT, 'json_testcases', `${p}.json`), 'utf8').trim().split('\n').filter((l) => l.trim() !== '');
  const tests = testLines.map((l) => JSON.parse(l) as Json);
  const testsShown = tests.slice(0, 4).map((t) => ({ input: (t as Json[])[0]!, expected: (t as Json[])[1]! }));
  const bt = tokenize(buggyLine), ft = tokenize(fixedLine);
  const scope = scanScope(buggy);
  const goldRun = runTests(p, fixed, testLines); const oracle = goldRun.passed.map((k) => testLines[k]!); const goldOk = goldRun.ok === goldRun.n;
  if (oracle.length === 0) { console.log(`${p} gold passes no test within the alarm; skipped`); return null; }
  const base: Json = {
    task: `The Python function \`${p}\` in \`program\` has a single-line bug on \`buggy_line\`. \`tests\` give inputs and the expected output of the correct function.`,
    program: Object.fromEntries(buggy.map((l, i) => [`L${i + 1}`, l])), tests: testsShown, buggy_line: buggyLine.trim(),
  };
  const costBefore = spend, reqBefore = requests;
  // --- slots of the fixed line
  const slotIdx = ft.map((_, i) => i).filter((i) => slotClass(ft, i) !== null);
  const optionSets = slotIdx.map((i) => optionsFor(slotClass(ft, i), scope, tests));
  const truthFill = slotIdx.map((i) => ft[i]!.text);
  // --- probe request: kind, wrong token, cloze + prefix per slot
  const qs: Record<string, Question> = {};
  qs['kind'] = choice('What kind of statement is the corrected line that must replace `buggy_line` so that `tests` pass?', KINDS);
  const tokOpts: Record<string, string> = {}; const tokKeys: string[] = []; const usedT = new Set<string>();
  bt.forEach((t, i) => { const k = keyFor(`tok${i + 1}`, t.text, usedT); tokOpts[k] = `token ${i + 1} of \`buggy_line\`: \`${t.text}\``; tokKeys.push(k); });
  tokOpts['a_token_is_missing'] = 'no existing token is wrong; the line is wrong because a token or fragment is missing and must be inserted';
  qs['wrong_token'] = choice('Which token of `buggy_line` is wrong and must be changed or removed so that `tests` pass? Read the tokens literally.', tokOpts);
  const state: Json = { ...base, partial_lines: {} };
  const partials: Record<string, Json> = {};
  slotIdx.forEach((_, h) => {
    partials[`cloze_${h + 1}`] = partial(ft, slotIdx, [], h, 'cloze'); partials[`prefix_${h + 1}`] = partial(ft, slotIdx, truthFill.slice(0, h), h, 'prefix');
    qs[`cloze_${h + 1}`] = choice(`\`partial_lines.cloze_${h + 1}\` is the corrected line that replaces \`buggy_line\` in \`program\`, with one token blanked as \`<HOLE>\`. Which option is the token at \`<HOLE>\` such that the line makes every entry of \`tests\` pass? Pick \`none_of_these\` if no option fits.`, optionSets[h]!.options);
    qs[`prefix_${h + 1}`] = makeHoleQuestion(`partial_lines.prefix_${h + 1}`, optionSets[h]!.options);
  });
  (state as Record<string, Json>)['partial_lines'] = partials;
  const ans = await ask(state, qs);
  const kindR = ranked(ans['kind']!); const kindTruth = kindOf(fixedLine);
  const pairs = lcs(bt, ft, (a, b) => a.text === b.text); const matchedB = new Set(pairs.map(([i]) => i));
  const wrongIdx = bt.map((_, i) => i).filter((i) => !matchedB.has(i));
  const wrongTruth = wrongIdx.length ? wrongIdx.map((i) => tokKeys[i]!) : ['a_token_is_missing'];
  const wtR = ranked(ans['wrong_token']!);
  const slots: SlotResult[] = slotIdx.map((i, h) => {
    const os = optionSets[h]!; const truth = ft[i]!.text; const truthKey = Object.entries(os.byKey).find(([, v]) => v === truth)?.[0];
    const score = (a: Answer) => { const r = ranked(a); const nonEsc = r.filter(([k]) => k !== 'none_of_these'); const rank = truthKey ? nonEsc.findIndex(([k]) => k === truthKey) + 1 : 0; return { top1: rank === 1, rank, p: truthKey ? (r.find(([k]) => k === truthKey)?.[1] ?? 0) : 0, escape: r.find(([k]) => k === 'none_of_these')?.[1] ?? 0 }; };
    return { i, cls: slotClass(ft, i), truth, nOptions: Object.keys(os.options).length, covered: !!truthKey, cloze: score(ans[`cloze_${h + 1}`]!), prefix: score(ans[`prefix_${h + 1}`]!) };
  });
  // --- S2 diff-fill: holes only where fixed tokens are not matched by the LCS with the buggy line
  const matchedF = new Set(pairs.map(([, j]) => j));
  const diffSlots = slotIdx.filter((i) => !matchedF.has(i));
  let s2: BeamResult | null = null;
  if (diffSlots.length > 0 && diffSlots.every((i) => slots.find((s) => s.i === i)!.covered)) {
    s2 = await beamFill(base, p, bi, buggy, indent, ft, diffSlots, diffSlots.map((i) => ft[i]!.text), diffSlots.map((i) => optionSets[slotIdx.indexOf(i)]!), oracle, BEAM);
  }
  // --- S1 full-fill over every slot
  const s1 = slotIdx.length <= 12 ? await beamFill(base, p, bi, buggy, indent, ft, slotIdx, truthFill, optionSets, oracle, BEAM) : null;
  const donorShapes = new Set(buggy.filter((_, i) => i !== bi).map((l) => shape(tokenize(l))));
  return {
    program: p, lines: buggy.length, oracleTests: oracle.length, totalTests: tests.length, goldPassesAll: goldOk, buggy: buggyLine.trim(), fixed: fixedLine.trim(),
    kind: { truth: kindTruth, pick: kindR[0]![0], p: ans['kind']!.type === 'choice' ? ans['kind']!.probabilities[kindTruth] ?? 0 : 0, ok: kindR[0]![0] === kindTruth },
    wrongToken: { truth: wrongTruth, pick: wtR[0]![0], p: Math.max(...wrongTruth.map((k) => (ans['wrong_token']!.type === 'choice' ? ans['wrong_token']!.probabilities[k] ?? 0 : 0))), ok: wrongTruth.includes(wtR[0]![0]), nTokens: bt.length },
    shapeSame: shape(bt) === shape(ft), shapeInDonors: donorShapes.has(shape(ft)), slots, s2, s1, costUsd: spend - costBefore, requests: requests - reqBefore,
  };
}

const programs = readdirSync(join(ROOT, 'python_programs')).filter((f) => f.endsWith('.py') && !f.endsWith('_test.py')).map((f) => basename(f, '.py')).filter((p) => existsSync(join(ROOT, 'json_testcases', `${p}.json`))).slice(0, MAX);
const results: ProgResult[] = [];
const pool = 6; let idx = 0;
await Promise.all(Array.from({ length: pool }, async () => {
  while (idx < programs.length) { const p = programs[idx++]!; try { const r = await runProgram(p); if (r) { results.push(r); console.log(`${p.padEnd(28)} kind=${r.kind.ok ? 'Y' : 'n'} wrong=${r.wrongToken.ok ? 'Y' : 'n'} slots=${r.slots.length} cloze=${r.slots.filter((s) => s.cloze.top1).length} prefix=${r.slots.filter((s) => s.prefix.top1).length} cov=${r.slots.filter((s) => s.covered).length} | S2 holes=${r.s2?.holes ?? '-'} pass@${r.s2?.passRank ?? '-'} truth@${r.s2?.truthRank ?? '-'} | S1 pass@${r.s1?.passRank ?? '-'} truth@${r.s1?.truthRank ?? '-'} | $${r.costUsd.toFixed(4)}`); } else console.log(`${p.padEnd(28)} skipped (not a one-line replacement)`); } catch (e) { console.log(`${p.padEnd(28)} ERROR ${(e as Error).message}`); } }
}));
results.sort((a, b) => a.program.localeCompare(b.program));
latencies.sort((a, b) => a - b);
const summary = { n: results.length, requests, retries, costUsd: spend, latencyP50: latencies[Math.floor(latencies.length / 2)], latencyP90: latencies[Math.floor(latencies.length * 0.9)], beam: BEAM };
writeFileSync(join(OUT, `slot-probe-verify-b${BEAM}.json`), JSON.stringify({ summary, results }, null, 2));
const all = results.flatMap((r) => r.slots);
const by = (cls: SlotClass) => all.filter((s) => s.cls === cls);
const agg = (ss: SlotResult[]) => `n=${ss.length} covered=${ss.filter((s) => s.covered).length} cloze_top1=${ss.filter((s) => s.cloze.top1).length} prefix_top1=${ss.filter((s) => s.prefix.top1).length} cloze_mrr=${(ss.reduce((a, s) => a + (s.cloze.rank ? 1 / s.cloze.rank : 0), 0) / Math.max(ss.length, 1)).toFixed(2)} prefix_mrr=${(ss.reduce((a, s) => a + (s.prefix.rank ? 1 / s.prefix.rank : 0), 0) / Math.max(ss.length, 1)).toFixed(2)}`;
console.log(`\nprograms=${results.length} requests=${requests} retries=${retries} cost=$${spend.toFixed(4)} p50=${summary.latencyP50}ms p90=${summary.latencyP90}ms`);
console.log(`kind top1=${results.filter((r) => r.kind.ok).length}/${results.length}  wrong_token top1=${results.filter((r) => r.wrongToken.ok).length}/${results.length}  shape_same=${results.filter((r) => r.shapeSame).length} shape_in_donors=${results.filter((r) => r.shapeInDonors).length}`);
console.log(`slots all: ${agg(all)}`); for (const c of ['ident', 'attr', 'oper', 'num'] as SlotClass[]) console.log(`slots ${c}: ${agg(by(c))}`);
console.log(`S2 diff-fill: ran=${results.filter((r) => r.s2).length} pass=${results.filter((r) => r.s2?.passRank).length} truth_in_beam=${results.filter((r) => r.s2?.truthRank).length} gold_ok=${results.filter((r) => r.s2?.testsGoldOk).length}`);
console.log(`S1 full-fill: ran=${results.filter((r) => r.s1).length} pass=${results.filter((r) => r.s1?.passRank).length} truth_in_beam=${results.filter((r) => r.s1?.truthRank).length} mean_holes=${(results.filter((r) => r.s1).reduce((a, r) => a + r.s1!.holes, 0) / Math.max(1, results.filter((r) => r.s1).length)).toFixed(1)}`);
