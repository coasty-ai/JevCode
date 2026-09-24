/**
 * probe-select live driver. Phases: pools (offline), ab (state shape A/B at size 50), main (sizes x with/without fix),
 * nouls (batched Nouls per candidate, size 50), shuffle (order permutations, 10 programs), repeat (noise, size 50).
 * usage: env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/probe-select/run.mts <phase> [--programs a,b] [--sizes 10,50] [--variant desc|state] [--cap 1.00]
 * Appends one JSON line per Jev request to experiments/results/probe-selection.raw.jsonl.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createJevDecider } from '../../src/jev/client.ts';
import { choice, contextNoul, noul } from '../../src/jev/questions.ts';
import type { Json, Question } from '../../src/core/types.ts';
import { loadProgram, programNames, passesOracle, pickStateTests, type Program } from './quixbugs.ts';
import { buildPool, buildSet, permuteSet, type CandidatePool, type CandidateSet } from './candidates.ts';

const args = process.argv.slice(2);
const phase = args[0] ?? 'main';
const flag = (n: string): string | undefined => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const RESULTS = fileURLToPath(new URL('../results', import.meta.url));
const RAW = `${RESULTS}/probe-selection.raw.jsonl`;
const POOLS = '/tmp/jevonly/pools.json';
const CAP = Number(flag('cap') ?? '1.00');
const sizes = (flag('sizes') ?? '10,50,150,254').split(',').map(Number);
const variant = (flag('variant') ?? 'desc') as 'desc' | 'state';
const noulStyle = (flag('noulstyle') ?? 'full') as 'full' | 'compact';
const escapeOn = flag('escape') !== 'off' && phase !== 'noescape'; // verification 2026-09-20: the noescape phase must drop the escape by itself (the original run did not pass --escape off, see probe-selection.md)
const only = flag('programs')?.split(',');
const CONCURRENCY = Number(flag('concurrency') ?? '6');
mkdirSync('/tmp/jevonly', { recursive: true });

// ------------------------------------------------------------------ pools (offline, cached)
interface Stored { program: Program; pool: CandidatePool }
function loadPools(): Stored[] {
  if (existsSync(POOLS) && phase !== 'pools') return JSON.parse(readFileSync(POOLS, 'utf8')) as Stored[];
  const out: Stored[] = [];
  for (const name of programNames()) {
    const program = loadProgram(name);
    const pool = buildPool(program);
    out.push({ program, pool });
    console.error(`pool ${name.padEnd(28)} mode=${program.mode.padEnd(7)} pool=${String(pool.pool.length).padStart(3)} first=${String(pool.firstOrder).padStart(3)} neigh=${String(pool.neighbour).padStart(3)} fix=${pool.fixGenerated} oracle_tests=${program.oracle.length}`);
  }
  writeFileSync(POOLS, JSON.stringify(out));
  return out;
}
const stored = loadPools().filter((s) => !only || only.includes(s.program.name));
if (phase === 'pools') process.exit(0);

// ------------------------------------------------------------------ Jev
const key = process.env['OPENROUTER_API_KEY'] ?? '';
if (!key) throw new Error('OPENROUTER_API_KEY missing');
const jev = createJevDecider({ baseUrl: 'https://openrouter.ai/api/alpha/decisions', apiKey: key, model: 'typesafe/jev-1.13-20260917', pinned: true }, { redact: (s) => s });
const signal = new AbortController().signal;
let spent = 0;
function spend(c: number): void { spent += c; if (spent > CAP) throw new Error(`spend cap ${CAP} reached: $${spent.toFixed(4)}`); }

// ------------------------------------------------------------------ state + questions (exact wording)
function baseState(p: Program): Record<string, Json> {
  const tests = pickStateTests(p).map((t) => t.kind === 'json'
    ? { input: t.input as Json, expected: t.expected as Json, actual_with_bug: t.actual as Json, status_with_bug: t.status }
    : { test_source: t.source ?? '', expected: t.expected as Json, actual_with_bug: t.actual as Json, status_with_bug: t.status });
  const task = p.mode === 'replace'
    ? `The Python function \`${p.name}\` has a one-line bug. \`buggy_line\` (line \`buggy_line_number\` of \`program\`) is the faulty line. \`tests\` shows inputs, the expected output, and what the buggy program actually does.`
    : `The Python function \`${p.name}\` is missing one statement. It belongs immediately after \`buggy_line\` (line \`buggy_line_number\` of \`program\`). \`tests\` shows inputs, the expected output, and what the buggy program actually does.`;
  return {
    task,
    program: Object.fromEntries(p.lines.map((l, i) => [`L${i + 1}`, l])),
    buggy_line_number: `L${p.index + 1}`,
    buggy_line: p.buggyLine,
    tests,
  };
}
const CHOICE_INSTRUCTIONS = {
  replace: 'Which option is the corrected line that, put in place of `buggy_line`, makes every test in `tests` pass, including the tests that currently fail? Read each option literally: most options are wrong mutations of the faulty line or copies of other lines. Choose `none_of_these` if no option is a correct fix.',
  insert: 'Which option is the missing statement that, inserted immediately after `buggy_line`, makes every test in `tests` pass, including the tests that currently fail? Read each option literally: most options are unrelated statements or wrong mutations. Choose `none_of_these` if no option is a correct fix.',
};
const ESCAPE_DESC = 'No option is a correct fix; every option leaves the tests failing or breaks the function.';

function choiceRequest(p: Program, set: CandidateSet, v: 'desc' | 'state'): { state: Json; questions: Record<string, Question> } {
  const state = baseState(p);
  const options: Record<string, Json | null> = {};
  if (v === 'desc') for (const [k, t] of set.options) options[k] = t;
  else { for (const [k] of set.options) options[k] = null; state['candidates'] = Object.fromEntries(set.options); }
  let instr = v === 'state' ? CHOICE_INSTRUCTIONS[p.mode].replace('Which option', 'Which entry of `candidates`').replace('each option', 'each entry').replace('most options', 'most entries').replace('no option', 'no entry') : CHOICE_INSTRUCTIONS[p.mode];
  if (!escapeOn) {
    // control condition (violates the REPORT rule on purpose): no escape option at all
    instr = instr.replace(/ Choose `none_of_these`[^.]*\./, '');
    return { state, questions: { fix: { type: 'choice', instructions: instr, criteria: options } } };
  }
  options['none_of_these'] = ESCAPE_DESC;
  return { state, questions: { fix: choice(instr, options) } };
}

const NOUL_TRUE = { definition: 'The candidate repairs the exact mistake so the function returns `expected` for every test input, including the tests that currently fail, and stays correct on the tests that already pass.', examples: ['the operator, index or argument the bug got wrong is corrected and nothing else changes', 'a line equivalent to the reference implementation of this algorithm'] };
const NOUL_FALSE = { definition: 'The candidate leaves the bug in place, introduces a different bug, or changes something unrelated to the failure.', examples: ['the faulty line unchanged', 'a mutation that changes the wrong operator or the wrong variable', 'a copy or mutation of another line of the program'] };

function noulRequest(p: Program, set: CandidateSet, style: 'full' | 'compact'): { state: Json; questions: Record<string, Question> } {
  const state = baseState(p);
  state['candidates'] = Object.fromEntries(set.options);
  const questions: Record<string, Question> = {};
  if (style === 'compact') {
    // criteria stated once in the state (REPORT §11: content in state vs instructions is equivalent), one short Noul per candidate
    state['correct_fix_criteria'] = { correct_fix: NOUL_TRUE.definition, correct_fix_examples: NOUL_TRUE.examples, not_a_fix: NOUL_FALSE.definition, not_a_fix_examples: NOUL_FALSE.examples };
    for (const [k] of set.options) questions[k] = contextNoul(p.mode === 'replace' ? `Is \`candidates.${k}\` a correct fix per \`correct_fix_criteria\`: put in place of \`buggy_line\`, does it make every test in \`tests\` pass?` : `Is \`candidates.${k}\` a correct fix per \`correct_fix_criteria\`: inserted immediately after \`buggy_line\`, does it make every test in \`tests\` pass?`);
    return { state, questions };
  }
  for (const [k] of set.options) {
    questions[k] = noul(
      p.mode === 'replace'
        ? `Is \`candidates.${k}\` the corrected line: put in place of \`buggy_line\`, does it make every test in \`tests\` pass?`
        : `Is \`candidates.${k}\` the missing statement: inserted immediately after \`buggy_line\`, does it make every test in \`tests\` pass?`,
      { true: NOUL_TRUE, false: NOUL_FALSE },
    );
  }
  return { state, questions };
}

// ------------------------------------------------------------------ records
interface Rec {
  phase: string; program: string; mode: 'replace' | 'insert'; method: 'choice' | 'nouls'; variant: 'desc' | 'state'; order: string; size: number; options: number; withFix: boolean;
  fixKey: string | null; fixGenerated: string; top: [string, number][]; pTrue: number | null; pEscape: number | null; rankTrue: number | null; top1: string; top1IsFix: boolean;
  top1IsEscape: boolean; top1Text: string | null; top1Plausible: boolean | null; top3Plausible?: boolean; costUsd: number; latencyMs: number; inputTokens: number; sumP: number; ts: string;
}
function record(r: Rec): void { appendFileSync(RAW, JSON.stringify(r) + '\n'); }

async function askChoice(ph: string, p: Program, pool: CandidatePool, set: CandidateSet, v: 'desc' | 'state', order = 'original'): Promise<Rec> {
  const { state, questions } = choiceRequest(p, set, v);
  const r = await jev.ask(state, questions, { signal, stage: 'propose', step: 1 });
  spend(r.usage.costUsd);
  const a = r.answers['fix']!;
  if (a.type !== 'choice') throw new Error('not a choice answer');
  if (!escapeOn) a.probabilities['none_of_these'] = 0;
  const ranked = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]);
  const texts = new Map(set.options);
  const top1 = ranked[0]![0];
  const rankTrue = set.fixKey ? ranked.findIndex(([k]) => k === set.fixKey) + 1 : null;
  const top1Text = texts.get(top1) ?? null;
  let top1Plausible: boolean | null = null;
  if (top1 === set.fixKey) top1Plausible = true;
  else if (top1Text !== null) top1Plausible = await passesOracle(p, top1Text);
  // top-3 plausible: does any of the three highest non-escape candidates pass the oracle?
  let top3Plausible = top1Plausible === true;
  if (!top3Plausible) for (const [k] of ranked.slice(0, 3)) { if (k === top1) continue; if (k === set.fixKey) { top3Plausible = true; break; } const t = texts.get(k); if (t && (await passesOracle(p, t))) { top3Plausible = true; break; } }
  const rec: Rec = {
    phase: ph, program: p.name, mode: p.mode, method: 'choice', variant: escapeOn ? v : `${v}_noescape`, order, size: set.size, options: set.options.length + (escapeOn ? 1 : 0), withFix: set.withFix, fixKey: set.fixKey, fixGenerated: pool.fixGenerated,
    top: ranked.slice(0, 5).map(([k, pr]) => [k, pr] as [string, number]), pTrue: set.fixKey ? a.probabilities[set.fixKey] ?? 0 : null, pEscape: a.probabilities['none_of_these'] ?? 0, rankTrue,
    top1, top1IsFix: top1 === set.fixKey, top1IsEscape: top1 === 'none_of_these', top1Text, top1Plausible, top3Plausible, costUsd: r.usage.costUsd, latencyMs: r.latencyMs, inputTokens: r.usage.inputTokens,
    sumP: Object.values(a.probabilities).reduce((s, x) => s + x, 0), ts: new Date().toISOString(),
  };
  record(rec);
  console.log(`${ph.padEnd(7)} ${p.name.padEnd(26)} ${v.padEnd(5)} ${order.padEnd(8)} size=${String(set.size).padStart(3)} fix=${set.withFix ? 'Y' : 'n'} top1=${rec.top1IsFix ? 'FIX' : rec.top1IsEscape ? 'ESC' : rec.top1Plausible ? 'plausible' : 'wrong'} pTrue=${rec.pTrue?.toFixed(2) ?? '  - '} pEsc=${rec.pEscape!.toFixed(2)} top=${ranked[0]![1].toFixed(2)} rank=${rankTrue ?? '-'} $${r.usage.costUsd.toFixed(5)} ${r.latencyMs}ms ${r.usage.inputTokens}tok`);
  return rec;
}

async function askNouls(ph: string, p: Program, pool: CandidatePool, set: CandidateSet, order = 'original'): Promise<Rec> {
  const { state, questions } = noulRequest(p, set, noulStyle);
  const r = await jev.ask(state, questions, { signal, stage: 'propose', step: 1 });
  spend(r.usage.costUsd);
  const probs: [string, number][] = set.options.map(([k]) => { const a = r.answers[k]!; return [k, a.type === 'noul' ? a.noul : 0]; });
  const ranked = [...probs].sort((x, y) => y[1] - x[1]);
  const texts = new Map(set.options);
  const top1 = ranked[0]![0];
  const rankTrue = set.fixKey ? ranked.findIndex(([k]) => k === set.fixKey) + 1 : null;
  const top1Text = texts.get(top1) ?? null;
  let top1Plausible: boolean | null = top1 === set.fixKey ? true : null;
  if (top1Plausible === null && top1Text !== null) top1Plausible = await passesOracle(p, top1Text);
  const rec: Rec = {
    phase: ph, program: p.name, mode: p.mode, method: 'nouls', variant: noulStyle, order, size: set.size, options: set.options.length, withFix: set.withFix, fixKey: set.fixKey, fixGenerated: pool.fixGenerated,
    top: ranked.slice(0, 5), pTrue: set.fixKey ? probs.find(([k]) => k === set.fixKey)![1] : null, pEscape: null, rankTrue, top1, top1IsFix: top1 === set.fixKey, top1IsEscape: false, top1Text, top1Plausible,
    costUsd: r.usage.costUsd, latencyMs: r.latencyMs, inputTokens: r.usage.inputTokens, sumP: probs.reduce((s, [, x]) => s + x, 0), ts: new Date().toISOString(),
  };
  record(rec);
  console.log(`${ph.padEnd(7)} ${p.name.padEnd(26)} nouls-${noulStyle} ${order} size=${String(set.size).padStart(3)} fix=${set.withFix ? 'Y' : 'n'} top1=${rec.top1IsFix ? 'FIX' : rec.top1Plausible ? 'plausible' : 'wrong'} pTrue=${rec.pTrue?.toFixed(2) ?? '  - '} max=${ranked[0]![1].toFixed(2)} rank=${rankTrue ?? '-'} above0.5=${probs.filter(([, x]) => x >= 0.5).length} $${r.usage.costUsd.toFixed(5)} ${r.latencyMs}ms ${r.usage.inputTokens}tok`);
  return rec;
}

// ------------------------------------------------------------------ phases
async function forEachProgram(fn: (s: Stored) => Promise<void>): Promise<void> {
  const queue = [...stored];
  const workers = Array.from({ length: CONCURRENCY }, async () => { for (;;) { const s = queue.shift(); if (!s) return; try { await fn(s); } catch (e) { console.error(`${s.program.name}: ${(e as Error).message}`); if (spent > CAP) throw e; } } });
  await Promise.all(workers);
}

const t0 = Date.now();
if (phase === 'ab') {
  await forEachProgram(async ({ program, pool }) => {
    const set = buildSet(program, pool, 50, true);
    for (const v of ['desc', 'state'] as const) await askChoice('ab', program, pool, set, v);
  });
} else if (phase === 'main') {
  await forEachProgram(async ({ program, pool }) => {
    for (const size of sizes) for (const withFix of [true, false]) await askChoice('main', program, pool, buildSet(program, pool, size, withFix), variant);
  });
} else if (phase === 'nouls') {
  await forEachProgram(async ({ program, pool }) => {
    for (const size of sizes) for (const withFix of [true, false]) await askNouls('nouls', program, pool, buildSet(program, pool, size, withFix));
  });
} else if (phase === 'nouls-repeat') {
  await forEachProgram(async ({ program, pool }) => {
    const set = buildSet(program, pool, 50, true);
    for (let i = 0; i < 2; i++) await askNouls('nouls-repeat', program, pool, set, `repeat${i + 1}`);
  });
} else if (phase === 'rerank') {
  // two-stage: take the Noul (full, 254) top-5 per program from the raw log, ask a Choice (+escape) over just those
  const prior = readFileSync(RAW, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Rec).filter((r) => r.phase === 'nouls' && r.size === 254 && (r.variant === 'full' || r.variant === 'state'));
  await forEachProgram(async ({ program, pool }) => {
    for (const withFix of [true, false]) {
      const src = prior.find((r) => r.program === program.name && r.withFix === withFix);
      if (!src) continue;
      const full = buildSet(program, pool, 254, withFix);
      const texts = new Map(full.options);
      const shortlist = src.top.slice(0, 5).map(([k]) => texts.get(k)!);
      const options = shortlist.map((t, i) => [`cand_${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`, t] as [string, string]);
      const fixKey = withFix ? options.find(([, t]) => t === program.fixLine)?.[0] ?? null : null;
      await askChoice('rerank', program, pool, { size: options.length, withFix, options, fixKey }, variant, 'noul_top5');
    }
  });
} else if (phase === 'noescape') {
  await forEachProgram(async ({ program, pool }) => {
    for (const size of sizes) await askChoice('noescape', program, pool, buildSet(program, pool, size, true), variant);
  });
} else if (phase === 'shuffle') {
  const ten = stored.slice(0, 10);
  stored.length = 0; stored.push(...ten);
  await forEachProgram(async ({ program, pool }) => {
    const set = buildSet(program, pool, 50, true);
    await askChoice('shuffle', program, pool, set, variant, 'original');
    await askChoice('shuffle', program, pool, permuteSet(set, 'reversed', ''), variant, 'reversed');
    await askChoice('shuffle', program, pool, permuteSet(set, 'shuffled', `shuffle:${program.name}`), variant, 'shuffled');
  });
} else if (phase === 'repeat') {
  await forEachProgram(async ({ program, pool }) => {
    const set = buildSet(program, pool, 50, true);
    for (let i = 0; i < 2; i++) await askChoice('repeat', program, pool, set, variant, `repeat${i + 1}`);
  });
} else throw new Error(`unknown phase ${phase}`);
console.log(`\nphase=${phase} programs=${stored.length} spent=$${spent.toFixed(4)} wall=${((Date.now() - t0) / 1000).toFixed(0)}s`);
