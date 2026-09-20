/** Experiment 4 (follow-up): edit-based beam. Start from the buggy line; each step Jev picks an edit site
 * (replace token i / delete token i / insert before gap g / line is correct) and, for replace/insert, the token
 * (grammar-filtered by the prefix). Beam width W over edits, depth <= 3. Tests verify. 36 replace-kind lines. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE, MARK, loadCorpus, tokenize, detokenize, sameTokens, candidateSet, filterOptions, makeJev, askChoice, pool, p50, runTests, type Tok, type Cand, type Item } from './common.mts';
import type { Json } from '../../src/core/types.ts';

const W = Number(process.argv[2] ?? 3); const DEPTH = 3; const TOK_TOP = 2; const j = makeJev();
const corpus = loadCorpus().filter((c) => c.kind === 'replace');
const CORRECT = 'line_is_already_correct';
const mark = (toks: Tok[], i: number, n: number, ins?: string): string => detokenize([...toks.slice(0, i), { text: `[[${ins ?? toks.slice(i, i + n).map((t) => t.text).join(' ')}]]`, cls: 'identifier' }, ...toks.slice(i + n)]);
function siteOptions(toks: Tok[]): Record<string, Json> {
  const o: Record<string, Json> = {};
  toks.forEach((t, i) => { o[`replace_${sanitize(t.text)}_at_${i + 1}`] = { edit: 'replace this token with another', token: t.text, line_with_site_marked: mark(toks, i, 1) }; o[`delete_${sanitize(t.text)}_at_${i + 1}`] = { edit: 'delete this token', token: t.text, line_with_site_marked: mark(toks, i, 1) }; });
  for (let g = 0; g <= toks.length; g++) o[`insert_before_position_${g + 1}`] = { edit: 'insert a new token here', line_with_site_marked: mark(toks, g, 0, '+++') };
  o[CORRECT] = { edit: 'no change: `line` is already the correct replacement line' };
  return o;
}
function sanitize(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20) || 'sym'; }
const SITE_Q = `\`line\` is the current version of the faulty line at the \`${MARK}\` marker in \`program\` (\`buggy_line\` is the original). Which single edit brings \`line\` closer to the correct line that makes all \`tests\` pass? Each option shows the edit site in \`line_with_site_marked\` ([[...]] marks the token, +++ marks an insertion point). Choose \`${CORRECT}\` if \`line\` already is the correct line.`;
const TOK_Q = `\`line_with_site_marked\` is the faulty line at the \`${MARK}\` marker in \`program\`, with the edit site marked [[...]] (or +++ for an insertion). Which single Python token belongs at the marked site in the correct line? Choose \`none_of_these\` if the right token is not offered.`;
interface Beam { toks: Tok[]; logp: number; edits: string[] }
const rows = await pool(corpus, 6, async (item) => {
  const t0 = Date.now(); const target = tokenize(item.fix_line); const { cands } = candidateSet(item); const byKey = new Map<string, Cand>(cands.map((c) => [c.key, c]));
  const base = { task: `The Python function \`${item.name}\` has a one-line bug at the \`${MARK}\` marker in \`program\`. The corrected program must make every entry of \`tests\` pass.`, program: item.marked_program, buggy_line: item.buggy_line, tests: item.tests };
  let live: Beam[] = [{ toks: tokenize(item.buggy_line!), logp: 0, edits: [] }]; const completed: Beam[] = []; const states: Beam[] = []; let requests = 0, cost = 0; const lat: number[] = [];
  for (let d = 0; d < DEPTH && live.length; d++) {
    const exp: Beam[] = [];
    await Promise.all(live.map(async (b) => {
      const opts = siteOptions(b.toks);
      const r = await askChoice(j, { ...base, line: detokenize(b.toks) }, 'edit_site', SITE_Q, opts); requests++; cost += r.cost; lat.push(r.latencyMs);
      const top = r.ranked.filter(([k]) => k !== 'none_of_these').slice(0, W);
      await Promise.all(top.map(async ([key, p]) => {
        const lp = b.logp + Math.log(Math.max(p, 1e-6));
        if (key === CORRECT) { completed.push({ ...b, logp: lp, edits: [...b.edits, 'stop'] }); return; }
        const m = /^(replace|delete|insert_before_position)_(?:.*_at_)?(\d+)$/.exec(key)!; const op = m[1]!; const i = Number(m[2]) - 1;
        if (op === 'delete') { exp.push({ toks: [...b.toks.slice(0, i), ...b.toks.slice(i + 1)], logp: lp, edits: [...b.edits, `del ${b.toks[i]!.text}@${i}`] }); return; }
        const prefix = b.toks.slice(0, i); const tokOpts = filterOptions(cands, prefix); delete tokOpts['end_of_line']; if (op === 'replace') { const cur = [...byKey.values()].find((c) => c.tok.text === b.toks[i]!.text); if (cur) delete tokOpts[cur.key]; }
        if (!Object.keys(tokOpts).length) return;
        const r2 = await askChoice(j, { ...base, line: detokenize(b.toks), line_with_site_marked: op === 'replace' ? mark(b.toks, i, 1) : mark(b.toks, i, 0, '+++') }, 'site_token', TOK_Q, tokOpts); requests++; cost += r2.cost; lat.push(r2.latencyMs);
        for (const [tk, p2] of r2.ranked.filter(([k]) => k !== 'none_of_these').slice(0, TOK_TOP)) {
          const tok = byKey.get(tk)!.tok; const nt = op === 'replace' ? [...b.toks.slice(0, i), tok, ...b.toks.slice(i + 1)] : [...b.toks.slice(0, i), tok, ...b.toks.slice(i)];
          exp.push({ toks: nt, logp: lp + Math.log(Math.max(p2, 1e-6)), edits: [...b.edits, `${op} ${op === 'replace' ? b.toks[i]!.text + '->' : '+'}${tok.text}@${i}`] });
        }
      }));
    }));
    exp.sort((a, b) => b.logp - a.logp); live = exp.filter((e, k) => !exp.slice(0, k).some((o) => sameTokens(o.toks, e.toks))).slice(0, W); states.push(...live);
  }
  completed.sort((a, b) => b.logp - a.logp);
  const uniq: Beam[] = []; for (const c of completed) if (!uniq.some((u) => sameTokens(u.toks, c.toks))) uniq.push(c);
  const verifiedStop = uniq.slice(0, 3).map((b) => ({ line: detokenize(b.toks), edits: b.edits, exact: sameTokens(b.toks, target), pass: runTests(item, detokenize(b.toks)).pass }));
  // oracle over every beam state visited (<= W*DEPTH test runs): tests as the ground truth, Jev only proposes
  const seenStates: Beam[] = []; for (const s of states) if (!seenStates.some((u) => sameTokens(u.toks, s.toks)) && !sameTokens(s.toks, tokenize(item.buggy_line!))) seenStates.push(s);
  const stateHits = seenStates.map((s) => ({ line: detokenize(s.toks), exact: sameTokens(s.toks, target), pass: runTests(item, detokenize(s.toks)).pass, edits: s.edits }));
  const firstPass = stateHits.find((s) => s.pass);
  const row = { name: item.name, target: item.fix_line, buggy: item.buggy_line, stop_top_line: verifiedStop[0]?.line ?? null, stop_top_exact: verifiedStop[0]?.exact ?? false, stop_top_pass: verifiedStop[0]?.pass ?? false, stop_any_exact: verifiedStop.some((v) => v.exact), stop_any_pass: verifiedStop.some((v) => v.pass), states_visited: stateHits.length, any_state_exact: stateHits.some((s) => s.exact), any_state_pass: !!firstPass, first_pass_line: firstPass?.line ?? null, first_pass_edits: firstPass?.edits ?? null, requests, cost, lat_p50: p50(lat), wall_ms: Date.now() - t0 };
  console.log(`${item.name.padEnd(27)} req=${String(requests).padStart(2)} $${cost.toFixed(4)} ${(row.wall_ms / 1000).toFixed(1)}s states=${String(stateHits.length).padStart(2)} | stop: ${row.stop_top_exact ? 'EXACT' : row.stop_top_pass ? 'PASS ' : 'fail '} | any state: ${row.any_state_exact ? 'EXACT' : row.any_state_pass ? 'PASS ' : 'fail '} | ${row.first_pass_line ?? row.stop_top_line ?? '<none>'} ${firstPass ? JSON.stringify(firstPass.edits) : `(target: ${item.fix_line})`}`);
  return row;
});
writeFileSync(join(HERE, `out/edit-beam-w${W}.json`), JSON.stringify({ rows, usage: j.usage }, null, 1));
const c = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).length;
console.log(`\nedit-beam W=${W} depth=${DEPTH} lines=${rows.length} | Jev-stopped top: exact=${c((r) => r.stop_top_exact)} pass=${c((r) => r.stop_top_pass)}; any of top-3 stopped: exact=${c((r) => r.stop_any_exact)} pass=${c((r) => r.stop_any_pass)} | tests over all visited states: exact=${c((r) => r.any_state_exact)} pass=${c((r) => r.any_state_pass)} (mean states ${(rows.reduce((s, r) => s + r.states_visited, 0) / rows.length).toFixed(1)})`);
console.log(`calls=${j.usage.calls} cost=$${j.usage.cost.toFixed(4)} per_line=$${(j.usage.cost / rows.length).toFixed(4)} req/line=${(j.usage.calls / rows.length).toFixed(1)} jev_p50=${p50(j.usage.lat).toFixed(0)}ms wall_p50=${p50(rows.map((r) => r.wall_ms))}ms`);
