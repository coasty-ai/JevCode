/**
 * Probe-donor live experiments on QuixBugs (Jev only, no generating LLM).
 *   donor   (1) donor line selection: Choice over program lines (+3 other programs) + fix line
 *   ident   (2) identifier adaptation: Choice over in-scope identifiers to fill __HOLE__ in the fix line
 *   kind    (3) fix-kind classification over a template catalogue
 *   insert  (4) where to insert / which line gains the condition
 * Usage: env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/probe-donor/probe.mts <mode>
 * Writes experiments/probe-donor/out/<mode>.json (per-item rows + totals). Data: quixbugs.json (build_dataset.py).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJevDecider } from '../../src/jev/client.ts';
import { choice } from '../../src/jev/questions.ts';
import type { Json, Question } from '../../src/core/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] ?? 'donor';
const key = process.env['OPENROUTER_API_KEY'] ?? '';
if (!key) throw new Error('OPENROUTER_API_KEY missing');
const jev = createJevDecider({ baseUrl: 'https://openrouter.ai/api/alpha/decisions', apiKey: key, model: 'typesafe/jev-1.13-20260917', pinned: true }, { redact: (s) => s });
const signal = new AbortController().signal;

interface Prog { name: string; buggy: string[]; fixed: string[]; diff: { kind: 'replace'; line_index: number; buggy_line: string; fix_line: string } | { kind: 'insert'; insert_after_index: number; fix_line: string }; identifiers: string[]; attributes: string[]; tests: Json; kind_primary: string; kind_acceptable: string[] }
const progs = JSON.parse(readFileSync(join(HERE, 'quixbugs.json'), 'utf8')) as Prog[];
let cost = 0; const lat: number[] = []; let requests = 0;
async function ask(state: Json, qs: Record<string, Question>) {
  const r = await jev.ask(state, qs, { signal, stage: 'context', step: 1 });
  cost += r.usage.costUsd; lat.push(r.latencyMs); requests++;
  return r;
}
const ranked = (p: Record<string, number>) => Object.entries(p).sort((a, b) => b[1] - a[1]).map(([k]) => k);
const rankOf = (p: Record<string, number>, k: string) => ranked(p).indexOf(k) + 1;
const key2 = (i: number) => `${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`;
function seededShuffle<T>(arr: T[], seed: number): T[] { const a = [...arr]; let s = seed; for (let i = a.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) & 0x7fffffff; const j = s % (i + 1); [a[i], a[j]] = [a[j]!, a[i]!]; } return a; }
const programObj = (lines: string[]) => Object.fromEntries(lines.map((l, i) => [`L${i + 1}`, l]));
const testsFor = (p: Prog): Json => p.tests;
const rows: Json[] = []; const totals: Record<string, number> = {};
const bump = (k: string, v = 1) => { totals[k] = (totals[k] ?? 0) + v; };

// ---------------------------------------------------------------- (1) donor line selection
async function donor() {
  const replace = progs.filter((p) => p.diff.kind === 'replace');
  for (const [pi, p] of replace.entries()) {
    const d = p.diff as Extract<Prog['diff'], { kind: 'replace' }>;
    const k = d.line_index;
    const holed = programObj(p.buggy.map((l, i) => (i === k ? '<<< MISSING LINE >>>' : l)));
    for (const variant of ['own', 'own_plus_3'] as const) {
      const pool = new Set<string>(p.buggy.map((l) => l.trim()));
      if (variant === 'own_plus_3') for (let j = 1; j <= 3; j++) for (const l of progs[(progs.indexOf(p) + j) % progs.length]!.buggy) pool.add(l.trim());
      pool.add(d.fix_line.trim());
      const cands = seededShuffle([...pool].filter((l) => l !== '').slice(0, 254), 7 + pi);
      const opts: Record<string, Json> = Object.fromEntries(cands.map((c, i) => [`cand_${key2(i)}`, c]));
      const truth = Object.entries(opts).find(([, v]) => v === d.fix_line.trim())![0];
      const buggyKey = Object.entries(opts).find(([, v]) => v === d.buggy_line.trim())?.[0] ?? null;
      const state: Json = {
        task: `The function \`${p.name}\` has a single-line bug. Line \`L${k + 1}\` of \`program\` has been removed and replaced by the marker \`<<< MISSING LINE >>>\`. Exactly one candidate line, once its identifiers are adapted to this function, belongs at that position so that every case in \`tests\` passes. Candidate lines are shown without indentation.`,
        program: holed, missing_line: `L${k + 1}`, tests: testsFor(p),
      };
      const q = choice(`Which candidate line, adapted to the identifiers of \`program\`, belongs at \`program.L${k + 1}\` (the \`<<< MISSING LINE >>>\` marker) so that all \`tests\` pass?`, opts);
      const r = await ask(state, { donor: q });
      const a = r.answers['donor']!; if (a.type !== 'choice') continue;
      const rk = rankOf(a.probabilities, truth); const top = ranked(a.probabilities)[0]!;
      const row = { program: p.name, variant, n_candidates: cands.length, truth_rank: rk, p_truth: a.probabilities[truth] ?? 0, top_is_buggy_line: top === buggyKey, top_text: opts[top] ?? top, p_top: a.probabilities[top] ?? 0, buggy_rank: buggyKey ? rankOf(a.probabilities, buggyKey) : null, p_escape: a.probabilities['none_of_these'] ?? 0, fix_line: d.fix_line.trim(), latency_ms: r.latencyMs };
      rows.push(row); bump(`${variant}_n`); if (rk === 1) bump(`${variant}_top1`); if (rk <= 3) bump(`${variant}_top3`); bump(`${variant}_rr`, 1 / rk); if (top === buggyKey) bump(`${variant}_top_is_buggy`);
      console.log(`${p.name.padEnd(28)} ${variant.padEnd(11)} n=${String(cands.length).padStart(3)} rank=${rk} p=${(a.probabilities[truth] ?? 0).toFixed(2)} ${top === buggyKey ? 'TOP=BUGGY' : ''} top=${JSON.stringify(opts[top] ?? top)}`);
    }
  }
}

// ---------------------------------------------------------------- (2) identifier adaptation
const BUILTINS = ['len', 'max', 'min', 'all', 'any', 'range', 'enumerate', 'abs', 'sum', 'sorted', 'list', 'set', 'dict', 'str', 'int', 'float', 'zip', 'reversed', 'tuple', 'True', 'False', 'None'];
const KEYWORDS = new Set(['and', 'or', 'not', 'in', 'is', 'if', 'else', 'elif', 'for', 'while', 'return', 'def', 'yield', 'lambda', 'import', 'from', 'as', 'pass', 'break', 'continue', 'with', 'class', 'try', 'except', 'finally', 'raise', 'del', 'global', 'nonlocal', 'assert']);
function nameTokens(line: string): { name: string; start: number; end: number }[] {
  const out: { name: string; start: number; end: number }[] = []; const re = /[A-Za-z_][A-Za-z0-9_]*/g; let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (KEYWORDS.has(m[0])) continue;
    if (m.index > 0 && line[m.index - 1] === '.') continue; // attribute, not a Name
    if (/^["']/.test(line.slice(0, m.index).replace(/[^"']/g, '').slice(-1)) && (line.slice(0, m.index).split(/["']/).length - 1) % 2 === 1) continue; // inside string
    out.push({ name: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}
async function ident() {
  for (const p of progs.filter((p) => p.diff.kind === 'replace')) {
    const d = p.diff as Extract<Prog['diff'], { kind: 'replace' }>; const k = d.line_index;
    const fixTrim = d.fix_line.trim(); const bugTrim = d.buggy_line.trim();
    const toks = nameTokens(fixTrim);
    const scope = [...new Set([...p.identifiers, ...BUILTINS])].filter((s) => !KEYWORDS.has(s));
    const optEntries: [string, string][] = []; const used = new Set<string>();
    for (const s of scope) { let kk = `ident_${s.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`; while (used.has(kk)) kk += '_'; used.add(kk); optEntries.push([kk, s]); }
    const opts: Record<string, Json> = Object.fromEntries(optEntries);
    const keyFor = (s: string) => optEntries.find(([, v]) => v === s)?.[0] ?? null;
    const bugToks = new Set(nameTokens(bugTrim).map((t) => `${t.name}@${t.start}`));
    const items = toks.map((t, i) => ({ hole: `hole_${i + 1}`, template: `${fixTrim.slice(0, t.start)}__HOLE__${fixTrim.slice(t.end)}`, truth: t.name, truthKey: keyFor(t.name), changed: !bugToks.has(`${t.name}@${t.start}`) || !bugTrim.includes(t.name) }));
    // "changed" = this identifier is not present at all in the buggy line (must be inferred, cannot be copied)
    for (const it of items) it.changed = !nameTokens(bugTrim).some((b) => b.name === it.truth);
    const covered = items.filter((it) => it.truthKey !== null);
    for (const it of items.filter((it) => it.truthKey === null)) { rows.push({ program: p.name, variant: 'uncovered', hole: it.hole, template: it.template, truth: it.truth, changed: it.changed }); bump('uncovered'); }
    if (covered.length === 0) continue;
    for (const variant of ['with_buggy_line', 'hole_only'] as const) {
      const prog = programObj(p.buggy.map((l, i) => (i === k && variant === 'hole_only' ? '<<< MISSING LINE >>>' : l)));
      const state: Json = {
        task: variant === 'with_buggy_line'
          ? `The function \`${p.name}\` has a single-line bug at \`program.L${k + 1}\`. Each entry of \`replacement_templates\` is the proposed replacement for that line with one identifier removed and written as \`__HOLE__\`. The filled line must make every case in \`tests\` pass.`
          : `The function \`${p.name}\` has a single-line bug. Line \`L${k + 1}\` of \`program\` has been removed and replaced by \`<<< MISSING LINE >>>\`. Each entry of \`replacement_templates\` is the correct line for that position with one identifier removed and written as \`__HOLE__\`. The filled line must make every case in \`tests\` pass.`,
        program: prog, faulty_line: `L${k + 1}`, tests: testsFor(p), replacement_templates: Object.fromEntries(covered.map((it) => [it.hole, it.template])),
      };
      const qs: Record<string, Question> = Object.fromEntries(covered.map((it) => [it.hole, choice(`Which identifier, in scope in \`program\`, fills \`__HOLE__\` in \`replacement_templates.${it.hole}\` so that the completed line at \`program.L${k + 1}\` makes all \`tests\` pass?`, opts)]));
      const r = await ask(state, qs);
      for (const it of covered) {
        const a = r.answers[it.hole]!; if (a.type !== 'choice') continue;
        const rk = rankOf(a.probabilities, it.truthKey!); const top = ranked(a.probabilities)[0]!;
        rows.push({ program: p.name, variant, hole: it.hole, template: it.template, truth: it.truth, changed: it.changed, n_options: optEntries.length + 1, truth_rank: rk, p_truth: a.probabilities[it.truthKey!] ?? 0, top: opts[top] ?? top, p_top: a.probabilities[top] ?? 0, latency_ms: r.latencyMs });
        const tag = `${variant}_${it.changed ? 'changed' : 'unchanged'}`; bump(`${tag}_n`); if (rk === 1) bump(`${tag}_top1`); bump(`${tag}_rr`, 1 / rk);
        console.log(`${p.name.padEnd(28)} ${variant.padEnd(16)} ${it.changed ? 'CHG' : 'same'} ${it.template.padEnd(60).slice(0, 60)} truth=${it.truth.padEnd(14)} rank=${rk} p=${(a.probabilities[it.truthKey!] ?? 0).toFixed(2)} top=${opts[top] ?? top}`);
      }
    }
  }
}

// ---------------------------------------------------------------- (3) fix-kind classification
const CATALOGUE: Record<string, string> = {
  operator_swap: 'One operator is wrong and must be replaced by another of the same family: a comparison (`<` vs `<=`, `==` vs `!=`), arithmetic (`+` vs `-`, `^` vs `&`), or boolean (`and` vs `or`) operator. Example: `while lo <= hi` should be `while lo < hi`.',
  off_by_one: 'A boundary, index, range end or count is off by one and needs `+ 1`, `- 1`, a different slice start, or an adjacent index. Example: `range(0, r)` should be `range(0, r + 1)`; `dp[i - 1, j]` should be `dp[i - 1, j - 1]`.',
  argument_order: 'The right values are present but in the wrong order: swapped call arguments, swapped operands, or swapped index positions. Example: `gcd(a % b, b)` should be `gcd(b, a % b)`; `x + y` should be `y + x` when order matters.',
  missing_condition_or_guard: 'A condition is incomplete or a guard is missing: an `if`/`while` needs an extra clause, a `None`/empty check, or a constant `True` must become a real test. Example: `while True:` should be `while queue:`; `if hare.successor is None` should be `if hare is None or hare.successor is None`.',
  wrong_variable: 'The wrong variable, field, or expression is used where another in-scope one belongs. Example: `enumerate(arr)` should be `enumerate(counts)`; `node.outgoing_nodes` should be `node.incoming_nodes`.',
  wrong_function_call: 'The wrong function or method is called, or a call is missing or superfluous around an expression. Example: `any(...)` should be `all(...)`; `longest = length + 1` should be `longest = max(longest, length + 1)`; `yield flatten(x)` should be `yield x`.',
  control_flow_change: 'The flow of control is wrong: a `return`, `break`, `continue`, loop or branch is in the wrong place, missing, or wrongly nested, and the fix moves or changes a statement that controls execution rather than a value.',
  wrong_constant: 'A literal value is wrong: a wrong number, an empty list where a non-empty one belongs, `[]` vs `[[]]`, `0` vs `1`. Example: `return []` should be `return [n]`.',
  none_of_these: 'The fix does not match any template above (for example a whole statement must be added, or an expression restructured).',
};
async function kind() {
  for (const p of progs) {
    const k = p.diff.kind === 'replace' ? p.diff.line_index : null;
    for (const variant of ['catalogue', 'catalogue_plus_missing_statement', 'catalogue_with_faulty_line'] as const) {
      const cat: Record<string, Json> = { ...CATALOGUE };
      if (variant === 'catalogue_plus_missing_statement') cat['missing_statement'] = 'A whole statement is missing and must be inserted (a bookkeeping assignment, an `append`/`add` call, a final flush after a loop). Example: `prevnode = node` missing from a loop body; `lines.append(text)` missing after the loop.';
      const state: Json = { task: `The function \`${p.name}\` in \`program\` has a single bug that makes some cases in \`tests\` fail. The fix is a one-line change (or one inserted line). Classify the kind of fix needed.`, program: programObj(p.buggy), tests: testsFor(p), ...(variant === 'catalogue_with_faulty_line' && k !== null ? { faulty_line: `L${k + 1}`, faulty_line_text: p.buggy[k]! } : {}) };
      const q = choice(`Which kind of fix does \`program\` need so that all \`tests\` pass?${variant === 'catalogue_with_faulty_line' && k !== null ? ` The faulty line is \`program.L${k + 1}\`.` : ''}`, cat);
      const r = await ask(state, { kind: q });
      const a = r.answers['kind']!; if (a.type !== 'choice') continue;
      const top = ranked(a.probabilities)[0]!;
      let truth = p.kind_primary; let acceptable = p.kind_acceptable;
      if (variant !== 'catalogue_plus_missing_statement') acceptable = acceptable.filter((x) => x !== 'missing_statement');
      else if (p.kind_acceptable.includes('missing_statement')) { truth = 'missing_statement'; }
      const strict = top === truth, lenient = acceptable.includes(top);
      rows.push({ program: p.name, variant, truth, acceptable, top, p_top: a.probabilities[top] ?? 0, p_truth: a.probabilities[truth] ?? 0, truth_rank: rankOf(a.probabilities, truth), strict, lenient, probabilities: a.probabilities, latency_ms: r.latencyMs });
      bump(`${variant}_n`); if (strict) bump(`${variant}_strict`); if (lenient) bump(`${variant}_lenient`);
      console.log(`${p.name.padEnd(28)} ${variant.padEnd(34)} truth=${truth.padEnd(27)} top=${top.padEnd(27)} p=${(a.probabilities[top] ?? 0).toFixed(2)} ${strict ? 'OK' : lenient ? 'ok~' : 'X'}`);
    }
  }
}

// ---------------------------------------------------------------- (4) where to insert / which line gains the condition
const CONDITION_ADDED: Record<string, string> = { breadth_first_search: 'queue', detect_cycle: 'hare is None or', possible_change: 'not coins', is_valid_parenthesization: 'depth == 0' };
async function insert() {
  for (const p of progs.filter((p) => p.diff.kind === 'insert')) {
    const d = p.diff as Extract<Prog['diff'], { kind: 'insert' }>;
    const opts: Record<string, Json> = { before_l1: `insert as the new first line, before L1: ${p.buggy[0]!.trim()}` };
    for (let i = 0; i < p.buggy.length; i++) opts[`after_l${i + 1}`] = `insert directly after L${i + 1}: ${p.buggy[i]!.trim()}`;
    const truth = d.insert_after_index < 0 ? 'before_l1' : `after_l${d.insert_after_index + 1}`;
    for (const variant of ['given_line', 'line_unknown'] as const) {
      const state: Json = { task: `The function \`${p.name}\` in \`program\` is missing one statement, which makes some cases in \`tests\` fail.${variant === 'given_line' ? ' `missing_statement` is the statement to insert (indentation will be adjusted to the chosen position).' : ''}`, program: programObj(p.buggy), tests: testsFor(p), ...(variant === 'given_line' ? { missing_statement: d.fix_line.trim() } : {}) };
      const q = choice(variant === 'given_line' ? `Where in \`program\` must \`missing_statement\` be inserted so that all \`tests\` pass?` : `Where in \`program\` must the missing statement be inserted so that all \`tests\` pass?`, opts);
      const r = await ask(state, { where: q }); const a = r.answers['where']!; if (a.type !== 'choice') continue;
      const rk = rankOf(a.probabilities, truth); const top = ranked(a.probabilities)[0]!;
      rows.push({ program: p.name, kind: 'insert', variant, n_options: Object.keys(opts).length + 1, truth, truth_rank: rk, p_truth: a.probabilities[truth] ?? 0, top, p_top: a.probabilities[top] ?? 0, fix_line: d.fix_line.trim(), latency_ms: r.latencyMs });
      bump(`insert_${variant}_n`); if (rk === 1) bump(`insert_${variant}_top1`); bump(`insert_${variant}_rr`, 1 / rk);
      console.log(`${p.name.padEnd(28)} insert ${variant.padEnd(13)} truth=${truth} rank=${rk} p=${(a.probabilities[truth] ?? 0).toFixed(2)} top=${top}`);
    }
  }
  for (const p of progs.filter((p) => p.name in CONDITION_ADDED)) {
    const d = p.diff as Extract<Prog['diff'], { kind: 'replace' }>; const truth = `line_${d.line_index + 1}`;
    const opts: Record<string, Json> = Object.fromEntries(p.buggy.map((l, i) => [`line_${i + 1}`, l.trim()]));
    for (const variant of ['given_condition', 'condition_unknown'] as const) {
      const state: Json = { task: `The function \`${p.name}\` in \`program\` has a bug: one existing line's condition is incomplete or wrong.${variant === 'given_condition' ? ` The condition \`${CONDITION_ADDED[p.name]}\` must be incorporated into that line.` : ''}`, program: programObj(p.buggy), tests: testsFor(p), ...(variant === 'given_condition' ? { condition_to_add: CONDITION_ADDED[p.name] } : {}) };
      const q = choice(variant === 'given_condition' ? `Which line of \`program\` must be changed to incorporate \`condition_to_add\` so that all \`tests\` pass?` : `Which line of \`program\` has the incomplete or wrong condition that must be changed so that all \`tests\` pass?`, opts);
      const r = await ask(state, { where: q }); const a = r.answers['where']!; if (a.type !== 'choice') continue;
      const rk = rankOf(a.probabilities, truth); const top = ranked(a.probabilities)[0]!;
      rows.push({ program: p.name, kind: 'condition', variant, n_options: Object.keys(opts).length + 1, truth, truth_rank: rk, p_truth: a.probabilities[truth] ?? 0, top, p_top: a.probabilities[top] ?? 0, fix_line: d.fix_line.trim(), latency_ms: r.latencyMs });
      bump(`cond_${variant}_n`); if (rk === 1) bump(`cond_${variant}_top1`); bump(`cond_${variant}_rr`, 1 / rk);
      console.log(`${p.name.padEnd(28)} cond   ${variant.padEnd(17)} truth=${truth} rank=${rk} p=${(a.probabilities[truth] ?? 0).toFixed(2)} top=${top}`);
    }
  }
}


// ---------------------------------------------------------------- (1b) donor at 254 candidates, and escape when the truth is absent
async function donor2() {
  const replace = progs.filter((p) => p.diff.kind === 'replace');
  const allLines = [...new Set(progs.flatMap((q) => q.buggy.map((l) => l.trim())).filter((l) => l !== ''))];
  for (const [pi, p] of replace.entries()) {
    const d = p.diff as Extract<Prog['diff'], { kind: 'replace' }>; const k = d.line_index;
    const holed = programObj(p.buggy.map((l, i) => (i === k ? '<<< MISSING LINE >>>' : l)));
    for (const variant of ['all_programs_254', 'own_plus_3_truth_absent'] as const) {
      const pool = new Set<string>(p.buggy.map((l) => l.trim()));
      if (variant === 'own_plus_3_truth_absent') for (let j = 1; j <= 3; j++) for (const l of progs[(progs.indexOf(p) + j) % progs.length]!.buggy) pool.add(l.trim());
      else { for (const l of seededShuffle(allLines, 99 + pi)) { if (pool.size >= 253) break; pool.add(l); } }
      if (variant === 'all_programs_254') pool.add(d.fix_line.trim()); else pool.delete(d.fix_line.trim());
      const cands = seededShuffle([...pool].filter((l) => l !== '').slice(0, 254), 7 + pi);
      const opts: Record<string, Json> = Object.fromEntries(cands.map((c, i) => [`cand_${key2(i)}`, c]));
      const truth = Object.entries(opts).find(([, v]) => v === d.fix_line.trim())?.[0] ?? 'none_of_these';
      const buggyKey = Object.entries(opts).find(([, v]) => v === d.buggy_line.trim())?.[0] ?? null;
      const state: Json = {
        task: `The function \`${p.name}\` has a single-line bug. Line \`L${k + 1}\` of \`program\` has been removed and replaced by the marker \`<<< MISSING LINE >>>\`. ${variant === 'all_programs_254' ? 'Exactly one candidate line, once its identifiers are adapted to this function, belongs at that position so that every case in `tests` passes.' : 'At most one candidate line, once its identifiers are adapted to this function, belongs at that position so that every case in `tests` passes; if no candidate fits, the answer is `none_of_these`.'} Candidate lines are shown without indentation.`,
        program: holed, missing_line: `L${k + 1}`, tests: testsFor(p),
      };
      const q = choice(`Which candidate line, adapted to the identifiers of \`program\`, belongs at \`program.L${k + 1}\` (the \`<<< MISSING LINE >>>\` marker) so that all \`tests\` pass?`, opts);
      const r = await ask(state, { donor: q });
      const a = r.answers['donor']!; if (a.type !== 'choice') continue;
      const rk = rankOf(a.probabilities, truth); const top = ranked(a.probabilities)[0]!;
      const row = { program: p.name, variant, n_candidates: cands.length, truth, truth_rank: rk, p_truth: a.probabilities[truth] ?? 0, top_is_buggy_line: top === buggyKey, top_text: opts[top] ?? top, p_top: a.probabilities[top] ?? 0, buggy_rank: buggyKey ? rankOf(a.probabilities, buggyKey) : null, p_escape: a.probabilities['none_of_these'] ?? 0, fix_line: d.fix_line.trim(), latency_ms: r.latencyMs };
      rows.push(row); bump(`${variant}_n`); if (rk === 1) bump(`${variant}_top1`); if (rk <= 3) bump(`${variant}_top3`); bump(`${variant}_rr`, 1 / rk); if (top === buggyKey) bump(`${variant}_top_is_buggy`); bump(`${variant}_escape_mass`, a.probabilities['none_of_these'] ?? 0);
      console.log(`${p.name.padEnd(28)} ${variant.padEnd(24)} n=${String(cands.length).padStart(3)} rank=${rk} p_truth=${(a.probabilities[truth] ?? 0).toFixed(2)} p_escape=${(a.probabilities['none_of_these'] ?? 0).toFixed(2)} ${top === buggyKey ? 'TOP=BUGGY' : ''} top=${JSON.stringify(opts[top] ?? top)}`);
    }
  }
}

const runners: Record<string, () => Promise<void>> = { donor, donor2, ident, kind, insert };
if (!(mode in runners)) throw new Error(`unknown mode ${mode}`);
await runners[mode]!();
lat.sort((a, b) => a - b);
const summary = { mode, requests, costUsd: cost, latency_p50_ms: lat[Math.floor(lat.length / 2)] ?? null, latency_p90_ms: lat[Math.floor(lat.length * 0.9)] ?? null, totals };
mkdirSync(join(HERE, 'out'), { recursive: true });
writeFileSync(join(HERE, 'out', `${mode}.json`), JSON.stringify({ summary, rows }, null, 1));
console.log(JSON.stringify(summary));
