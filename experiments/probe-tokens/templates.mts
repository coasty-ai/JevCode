/** Experiment 3: Choice over line templates (identifiers/literals masked) from the buggy line, donor lines and
 * mutants of the buggy line, then slot filling by Choice over in-scope identifiers/literals (sequential and parallel). */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { choice } from '../../src/jev/questions.ts';
import type { Json, Question } from '../../src/core/types.ts';
import { HERE, MARK, loadCorpus, tokenize, detokenize, sameTokens, candidateSet, makeJev, askChoice, pool, p50, runTests, OP_NAMES, type Tok, type Item } from './common.mts';

const j = makeJev(); const corpus = loadCorpus();
const SLOT = '_';
const isSlot = (t: Tok): boolean => t.cls === 'identifier' || t.cls === 'number' || t.cls === 'string' || t.cls === 'literal';
function template(toks: Tok[]): Tok[] { return toks.map((t) => (isSlot(t) ? { text: SLOT, cls: 'identifier' } : t)); }
const tplText = (t: Tok[]): string => detokenize(t);
function tplKey(t: Tok[]): string {
  const parts = t.map((x) => (x.text === SLOT ? 'x' : x.cls === 'keyword' ? x.text : (OP_NAMES[x.text]?.[0] ?? 'sym').replace(/^(op|punct)_/, '')));
  return `shape_${parts.join('_')}`.slice(0, 60).replace(/_+$/, '');
}
const MUTATIONS: [RegExp, string][] = [
  [/<=/g, '<'], [/>=/g, '>'], [/(?<![<>=!])<(?!=)/g, '<='], [/(?<![<>=!])>(?!=)/g, '>='], [/==/g, '!='], [/!=/g, '=='],
  [/\+ 1\b/g, '- 1'], [/- 1\b/g, '+ 1'], [/\band\b/g, 'or'], [/\bor\b/g, 'and'], [/\+/g, '-'], [/(?<!\*)\*(?!\*)/g, '/'],
  [/\bTrue\b/g, 'False'], [/\bnot /g, ''], [/\[0\]/g, '[-1]'], [/\/\//g, '/'], [/(?<!\/)\/(?!\/)/g, '//'], [/\^=/g, '&='], [/\bany\b/g, 'all'],
];
function mutants(line: string): string[] {
  const out = new Set<string>();
  for (const [re, rep] of MUTATIONS) { const m = line.replace(re, rep); if (m !== line) out.add(m); }
  const sw = line.replace(/\(([^(),]+), ([^(),]+)\)/, '($2, $1)'); if (sw !== line) out.add(sw);
  return [...out];
}
function templatePool(item: Item): { key: string; toks: Tok[]; source: string }[] {
  const pool: { key: string; toks: Tok[]; source: string }[] = []; const seen = new Set<string>(); const keys = new Set<string>();
  const push = (line: string, source: string): void => {
    let toks: Tok[]; try { toks = template(tokenize(line)); } catch { return; }
    if (!toks.length) return; const txt = tplText(toks); if (seen.has(txt)) return; seen.add(txt);
    let k = tplKey(toks), n = 2; while (keys.has(k)) k = `${tplKey(toks).slice(0, 56)}_${n++}`; keys.add(k);
    pool.push({ key: k, toks, source });
  };
  if (item.buggy_line) push(item.buggy_line, 'buggy_line');
  item.buggy_program.split('\n').forEach((l, i) => { if (l.trim() && !l.trim().startsWith('#') && !l.trim().startsWith('def ')) push(l.trim(), `line_${i + 1}`); });
  if (item.buggy_line) for (const m of mutants(item.buggy_line)) push(m, 'mutant_of_buggy_line');
  return pool;
}
function fillText(tpl: Tok[], fills: Tok[]): string { let k = 0; return detokenize(tpl.map((t) => (t.text === SLOT ? (fills[k++] ?? { text: `<SLOT_${k}>`, cls: 'identifier' as const }) : t))); }
function baseState(item: Item): Record<string, Json> {
  return { task: `The Python function \`${item.name}\` has a one-line bug. In \`program\` the faulty position is marked \`${MARK}\`. ${item.buggy_line === null ? 'No line existed there: a new line must be inserted.' : 'The original wrong line at that position is `buggy_line`.'} The corrected program must make every entry of \`tests\` pass.`, program: item.marked_program, buggy_line: item.buggy_line, tests: item.tests };
}
const rows = await pool(corpus, 6, async (item) => {
  const t0 = Date.now(); const target = tokenize(item.fix_line); const targetTpl = template(target); const targetTplText = tplText(targetTpl);
  const tpls = templatePool(item); const truth = tpls.find((t) => tplText(t.toks) === targetTplText);
  const { cands } = candidateSet(item); const slotCands = cands.filter((c) => isSlot(c.tok)); const slotOpts: Record<string, Json> = Object.fromEntries(slotCands.map((c) => [c.key, c.desc])); const byKey = new Map(slotCands.map((c) => [c.key, c]));
  let cost = 0; const lat: number[] = [];
  // (a) template selection
  const tplOpts: Record<string, Json> = Object.fromEntries(tpls.map((t) => [t.key, { shape: tplText(t.toks), from: t.source }]));
  const r1 = await askChoice(j, baseState(item), 'line_shape', `Each option is a line shape where \`_\` stands for any single identifier or literal (names, numbers, strings, True/False/None); keywords, operators and punctuation are shown literally. Which shape does the correct replacement line for the \`${MARK}\` marker in \`program\` have? Choose \`none_of_these\` if no listed shape fits the correct line.`, tplOpts);
  cost += r1.cost; lat.push(r1.latencyMs);
  const keys = r1.ranked.map(([k]) => k); const truthRank = truth ? keys.indexOf(truth.key) + 1 : 0; const topKey = keys[0]!; const topTpl = tpls.find((t) => t.key === topKey);
  // (b) slot filling, sequential, on a given template
  async function fillSeq(tpl: Tok[]): Promise<{ toks: Tok[]; line: string }> {
    const fills: Tok[] = []; const nSlots = tpl.filter((t) => t.text === SLOT).length;
    for (let k = 0; k < nSlots; k++) {
      const st = { ...baseState(item), line_shape: tplText(tpl), line_with_slots: fillText(tpl, fills), slot_to_fill: `<SLOT_${k + 1}>` };
      const r = await askChoice(j, st, 'slot', `\`line_with_slots\` is the correct replacement line for the \`${MARK}\` marker in \`program\`, with earlier slots already filled and the remaining slots shown as \`<SLOT_n>\`. Which identifier or literal belongs at \`slot_to_fill\`? Choose \`none_of_these\` if the right token is not offered.`, slotOpts);
      cost += r.cost; lat.push(r.latencyMs);
      const pick = r.ranked.find(([k2]) => k2 !== 'none_of_these')![0]; fills.push(byKey.get(pick)!.tok);
    }
    const toks = tpl.map((t) => (t.text === SLOT ? fills.shift()! : t)); return { toks, line: detokenize(toks) };
  }
  // (c) slot filling, all slots as independent Choices in one request
  async function fillPar(tpl: Tok[]): Promise<{ toks: Tok[]; line: string }> {
    const nSlots = tpl.filter((t) => t.text === SLOT).length; if (!nSlots) return { toks: tpl, line: detokenize(tpl) };
    const qs: Record<string, Question> = {};
    for (let k = 0; k < nSlots; k++) qs[`slot_${k + 1}`] = choice(`\`line_with_slots\` is the correct replacement line for the \`${MARK}\` marker in \`program\`, with every identifier and literal replaced by a numbered slot. Which identifier or literal belongs at \`<SLOT_${k + 1}>\`? Choose \`none_of_these\` if the right token is not offered.`, slotOpts);
    const r = await j.jev.ask({ ...baseState(item), line_with_slots: fillText(tpl, []) }, qs, { signal: j.signal, stage: 'risk', step: 1 });
    j.usage.cost += r.usage.costUsd; j.usage.calls++; j.usage.lat.push(r.latencyMs); j.usage.inTok += r.usage.inputTokens; cost += r.usage.costUsd; lat.push(r.latencyMs);
    const fills: Tok[] = [];
    for (let k = 0; k < nSlots; k++) { const a = r.answers[`slot_${k + 1}`]!; if (a.type !== 'choice') throw new Error('x'); const pick = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).find(([k2]) => k2 !== 'none_of_these')![0]; fills.push(byKey.get(pick)!.tok); }
    const toks = tpl.map((t) => (t.text === SLOT ? fills.shift()! : t)); return { toks, line: detokenize(toks) };
  }
  const tfSeq = await fillSeq(targetTpl); const tfPar = await fillPar(targetTpl);
  const e2e = topTpl ? (tplText(topTpl.toks) === targetTplText ? tfSeq : await fillSeq(topTpl.toks)) : null;
  const e2ePass = e2e ? runTests(item, e2e.line).pass : false;
  const row = { name: item.name, target: item.fix_line, target_template: targetTplText, pool_size: tpls.length, covered: !!truth, covered_by: truth?.source ?? null, template_rank: truthRank, p_truth: truth ? (r1.probs[truth.key] ?? 0) : 0, top_template: topTpl ? tplText(topTpl.toks) : topKey, top_p: r1.ranked[0]![1], n_slots: targetTpl.filter((t) => t.text === SLOT).length,
    tf_seq_exact: sameTokens(tfSeq.toks, target), tf_seq_line: tfSeq.line, tf_par_exact: sameTokens(tfPar.toks, target), tf_par_line: tfPar.line, e2e_line: e2e?.line ?? null, e2e_exact: e2e ? sameTokens(e2e.toks, target) : false, e2e_pass: e2ePass, cost, lat_p50: p50(lat), wall_ms: Date.now() - t0 };
  console.log(`${item.name.padEnd(27)} pool=${String(tpls.length).padStart(2)} covered=${truth ? truth.source.padEnd(21) : 'NO'.padEnd(21)} rank=${truthRank || '-'} top=${topKey === 'none_of_these' ? 'NONE' : ''} | tf_seq=${row.tf_seq_exact ? 'Y' : 'n'} tf_par=${row.tf_par_exact ? 'Y' : 'n'} e2e=${row.e2e_exact ? 'EXACT' : e2ePass ? 'PASS ' : 'fail '} | ${row.e2e_line ?? '<none>'}${row.e2e_exact ? '' : `   (target: ${item.fix_line})`}`);
  return row;
});
writeFileSync(join(HERE, 'out/templates.json'), JSON.stringify({ rows, usage: j.usage }, null, 1));
const c = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).length;
console.log(`\nlines=${rows.length} covered=${c((r) => r.covered)} tpl_top1(covered)=${c((r) => r.template_rank === 1)} tpl_top3(covered)=${c((r) => r.template_rank >= 1 && r.template_rank <= 3)} none_of_these_when_uncovered=${c((r) => !r.covered && r.top_template === 'none_of_these')}/${c((r) => !r.covered)}`);
console.log(`slot filling on the true template: sequential exact=${c((r) => r.tf_seq_exact)} parallel exact=${c((r) => r.tf_par_exact)} | end-to-end (top template then sequential slots): exact=${c((r) => r.e2e_exact)} pass=${c((r) => r.e2e_pass)}`);
console.log(`calls=${j.usage.calls} cost=$${j.usage.cost.toFixed(4)} per_line=$${(j.usage.cost / rows.length).toFixed(4)} jev_p50=${p50(j.usage.lat).toFixed(0)}ms`);
