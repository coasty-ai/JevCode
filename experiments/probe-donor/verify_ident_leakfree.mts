/**
 * Verification re-run (2026-09-20) for probe-donor-and-templates.md.
 *  (a) ident, leak-free: in probe.mts all hole templates of a program share one state, so each sibling
 *      template reveals the identifier the other hole asks for. Here every changed-identifier hole is asked
 *      in its own request with ONLY that template in `replacement_templates`, both variants.
 *  (b) donor `own` re-run on 3 programs to check the saved rows reproduce.
 * Usage: env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/probe-donor/verify_ident_leakfree.mts
 * Writes out/verify_ident_leakfree.json. Budget: ~32 requests, well under $0.01.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJevDecider } from '../../src/jev/client.ts';
import { choice } from '../../src/jev/questions.ts';
import type { Json, Question } from '../../src/core/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const key = process.env['OPENROUTER_API_KEY'] ?? '';
if (!key) throw new Error('OPENROUTER_API_KEY missing');
const jev = createJevDecider({ baseUrl: 'https://openrouter.ai/api/alpha/decisions', apiKey: key, model: 'typesafe/jev-1.13-20260917', pinned: true }, { redact: (s) => s });
const signal = new AbortController().signal;
interface Prog { name: string; buggy: string[]; diff: { kind: 'replace'; line_index: number; buggy_line: string; fix_line: string } | { kind: 'insert' }; identifiers: string[]; tests: Json }
const progs = JSON.parse(readFileSync(join(HERE, 'quixbugs.json'), 'utf8')) as Prog[];
let cost = 0; const lat: number[] = []; let requests = 0;
async function ask(state: Json, qs: Record<string, Question>) { const r = await jev.ask(state, qs, { signal, stage: 'context', step: 1 }); cost += r.usage.costUsd; lat.push(r.latencyMs); requests++; return r; }
const ranked = (p: Record<string, number>) => Object.entries(p).sort((a, b) => b[1] - a[1]).map(([k]) => k);
const rankOf = (p: Record<string, number>, k: string) => ranked(p).indexOf(k) + 1;
const programObj = (lines: string[]) => Object.fromEntries(lines.map((l, i) => [`L${i + 1}`, l]));
const BUILTINS = ['len', 'max', 'min', 'all', 'any', 'range', 'enumerate', 'abs', 'sum', 'sorted', 'list', 'set', 'dict', 'str', 'int', 'float', 'zip', 'reversed', 'tuple', 'True', 'False', 'None'];
const KEYWORDS = new Set(['and', 'or', 'not', 'in', 'is', 'if', 'else', 'elif', 'for', 'while', 'return', 'def', 'yield', 'lambda', 'import', 'from', 'as', 'pass', 'break', 'continue', 'with', 'class', 'try', 'except', 'finally', 'raise', 'del', 'global', 'nonlocal', 'assert']);
function nameTokens(line: string) { const out: { name: string; start: number; end: number }[] = []; const re = /[A-Za-z_][A-Za-z0-9_]*/g; let m: RegExpExecArray | null; while ((m = re.exec(line))) { if (KEYWORDS.has(m[0])) continue; if (m.index > 0 && line[m.index - 1] === '.') continue; out.push({ name: m[0], start: m.index, end: m.index + m[0].length }); } return out; }
const rows: Json[] = [];
// (a) leak-free changed-identifier holes
const saved = JSON.parse(readFileSync(join(HERE, 'out', 'ident.json'), 'utf8')).rows as { program: string; variant: string; hole: string; template: string; truth: string; changed: boolean; truth_rank: number; p_truth: number }[];
const changed = saved.filter((r) => r.variant === 'with_buggy_line' && r.changed);
for (const c of changed) {
  const p = progs.find((q) => q.name === c.program)!; const d = p.diff as Extract<Prog['diff'], { kind: 'replace' }>; const k = d.line_index;
  const scope = [...new Set([...p.identifiers, ...BUILTINS])].filter((s) => !KEYWORDS.has(s));
  const optEntries: [string, string][] = []; const used = new Set<string>();
  for (const s of scope) { let kk = `ident_${s.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`; while (used.has(kk)) kk += '_'; used.add(kk); optEntries.push([kk, s]); }
  const opts: Record<string, Json> = Object.fromEntries(optEntries); const truthKey = optEntries.find(([, v]) => v === c.truth)![0];
  for (const variant of ['with_buggy_line', 'hole_only'] as const) {
    const prog = programObj(p.buggy.map((l, i) => (i === k && variant === 'hole_only' ? '<<< MISSING LINE >>>' : l)));
    const state: Json = { task: variant === 'with_buggy_line'
        ? `The function \`${p.name}\` has a single-line bug at \`program.L${k + 1}\`. \`replacement_templates.hole_1\` is the proposed replacement for that line with one identifier removed and written as \`__HOLE__\`. The filled line must make every case in \`tests\` pass.`
        : `The function \`${p.name}\` has a single-line bug. Line \`L${k + 1}\` of \`program\` has been removed and replaced by \`<<< MISSING LINE >>>\`. \`replacement_templates.hole_1\` is the correct line for that position with one identifier removed and written as \`__HOLE__\`. The filled line must make every case in \`tests\` pass.`,
      program: prog, faulty_line: `L${k + 1}`, tests: p.tests, replacement_templates: { hole_1: c.template } };
    const q = choice(`Which identifier, in scope in \`program\`, fills \`__HOLE__\` in \`replacement_templates.hole_1\` so that the completed line at \`program.L${k + 1}\` makes all \`tests\` pass?`, opts);
    const r = await ask(state, { hole_1: q }); const a = r.answers['hole_1']!; if (a.type !== 'choice') continue;
    const rk = rankOf(a.probabilities, truthKey); const top = ranked(a.probabilities)[0]!;
    const orig = saved.find((s) => s.program === c.program && s.variant === variant && s.hole === c.hole)!;
    rows.push({ kind: 'ident_leakfree', program: p.name, variant, template: c.template, truth: c.truth, n_options: optEntries.length + 1, truth_rank: rk, p_truth: a.probabilities[truthKey] ?? 0, top: opts[top] ?? top, p_top: a.probabilities[top] ?? 0, orig_rank: orig.truth_rank, orig_p: orig.p_truth, latency_ms: r.latencyMs });
    console.log(`${p.name.padEnd(26)} ${variant.padEnd(16)} ${c.template.slice(0, 48).padEnd(48)} truth=${c.truth.padEnd(12)} rank=${rk} p=${(a.probabilities[truthKey] ?? 0).toFixed(2)} (orig rank=${orig.truth_rank} p=${orig.p_truth.toFixed(2)}) top=${opts[top] ?? top}`);
  }
}
// (b) donor own, 3 programs
const key2 = (i: number) => `${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`;
function seededShuffle<T>(arr: T[], seed: number): T[] { const a = [...arr]; let s = seed; for (let i = a.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) & 0x7fffffff; const j = s % (i + 1); [a[i], a[j]] = [a[j]!, a[i]!]; } return a; }
const savedDonor = JSON.parse(readFileSync(join(HERE, 'out', 'donor.json'), 'utf8')).rows as { program: string; variant: string; truth_rank: number; p_truth: number }[];
const replace = progs.filter((p) => p.diff.kind === 'replace');
for (const name of ['bitcount', 'possible_change', 'sqrt']) {
  const p = replace.find((q) => q.name === name)!; const pi = replace.indexOf(p); const d = p.diff as Extract<Prog['diff'], { kind: 'replace' }>; const k = d.line_index;
  const holed = programObj(p.buggy.map((l, i) => (i === k ? '<<< MISSING LINE >>>' : l)));
  const pool = new Set<string>(p.buggy.map((l) => l.trim())); pool.add(d.fix_line.trim());
  const cands = seededShuffle([...pool].filter((l) => l !== '').slice(0, 254), 7 + pi);
  const opts: Record<string, Json> = Object.fromEntries(cands.map((c, i) => [`cand_${key2(i)}`, c]));
  const truth = Object.entries(opts).find(([, v]) => v === d.fix_line.trim())![0]; const buggyKey = Object.entries(opts).find(([, v]) => v === d.buggy_line.trim())?.[0] ?? null;
  const state: Json = { task: `The function \`${p.name}\` has a single-line bug. Line \`L${k + 1}\` of \`program\` has been removed and replaced by the marker \`<<< MISSING LINE >>>\`. Exactly one candidate line, once its identifiers are adapted to this function, belongs at that position so that every case in \`tests\` passes. Candidate lines are shown without indentation.`, program: holed, missing_line: `L${k + 1}`, tests: p.tests };
  const q = choice(`Which candidate line, adapted to the identifiers of \`program\`, belongs at \`program.L${k + 1}\` (the \`<<< MISSING LINE >>>\` marker) so that all \`tests\` pass?`, opts);
  const r = await ask(state, { donor: q }); const a = r.answers['donor']!; if (a.type !== 'choice') continue;
  const rk = rankOf(a.probabilities, truth); const top = ranked(a.probabilities)[0]!; const orig = savedDonor.find((s) => s.program === name && s.variant === 'own')!;
  rows.push({ kind: 'donor_own_rerun', program: name, n_candidates: cands.length, truth_rank: rk, p_truth: a.probabilities[truth] ?? 0, top_is_buggy_line: top === buggyKey, top_text: opts[top] ?? top, p_escape: a.probabilities['none_of_these'] ?? 0, orig_rank: orig.truth_rank, orig_p: orig.p_truth, latency_ms: r.latencyMs });
  console.log(`donor own ${name.padEnd(20)} n=${cands.length} rank=${rk} p=${(a.probabilities[truth] ?? 0).toFixed(2)} (orig rank=${orig.truth_rank} p=${orig.p_truth.toFixed(2)}) top=${JSON.stringify(opts[top] ?? top)}`);
}
lat.sort((a, b) => a - b);
const summary = { requests, costUsd: cost, latency_p50_ms: lat[Math.floor(lat.length / 2)] ?? null, latency_p90_ms: lat[Math.floor(lat.length * 0.9)] ?? null };
writeFileSync(join(HERE, 'out', 'verify_ident_leakfree.json'), JSON.stringify({ summary, rows }, null, 1));
console.log(JSON.stringify(summary));
