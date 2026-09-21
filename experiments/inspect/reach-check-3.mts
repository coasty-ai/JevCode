/**
 * Reach-target check for a jev-only SWE-bench bench (jev-only-rungs-1-2.md §21.5): for each of the seven
 * instances whose test-passing target `experiments/results/swebench-reach-oracle-9.md` names, read the run's
 * records and answer, from the records alone:
 *   - harvested: the `synth introspect:` / `synth history:` / introspection-site `synth localize:` lines;
 *   - shown to Jev: the target text among the options of a rank Choice (`decisions.jsonl`, id `fix`;
 *     compact Nouls carry the text in the state, which is not recorded, so this is a lower bound);
 *   - tested live: `sha12(unifiedDiff(path, base, patched))` of the target at every plausible placement
 *     against `synthState.tried` (the newest ≤ 3,000 hashes of every candidate classified in the run);
 *   - committed: the run's `model_patch.diff`.
 * Usage: node node_modules/.bin/tsx experiments/inspect/reach-check-3.mts <results dir>[,<results dir>…]
 * The base text is `git show HEAD:<path>` in the run's own workspace (run.json), so the hashes are the
 * ones the lanes computed at the base commit.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sha12 } from '../../src/core/hash.js';
import { unifiedDiff } from '../../src/synth/py/edits.js';

const dirs = (process.argv[2] ?? 'bench/results/jev-only-swebench-3').split(',');
type Rec = { task: string; runId: string; reason?: string; pass: boolean | null };
const runs = new Map<string, Rec>();
for (const dir of dirs) {
  const p = join(dir, 'tasks.jsonl');
  if (!existsSync(p)) continue;
  for (const l of readFileSync(p, 'utf8').split('\n')) {
    if (l.trim() === '') continue;
    const r = JSON.parse(l) as Rec;
    if (r.reason === 'in_progress' && runs.has(r.task)) continue;
    runs.set(r.task, r);
  }
}

type Lines = string[];
const split = (s: string): Lines => s.split('\n');
const joinL = (ls: Lines): string => ls.join('\n');
const indentOf = (s: string): string => /^\s*/.exec(s)?.[0] ?? '';
function insertBefore(ls: Lines, line: number, texts: string[]): string {
  const out = [...ls];
  out.splice(line - 1, 0, ...texts);
  return joinL(out);
}
function replaceSpan(ls: Lines, from: number, to: number, text: string): string {
  const out = [...ls];
  out.splice(from - 1, to - from + 1, text);
  return joinL(out);
}
const findLine = (ls: Lines, needle: string, from = 1): number => {
  for (let i = from - 1; i < ls.length; i++) if ((ls[i] ?? '').includes(needle)) return i + 1;
  return -1;
};
function hashOf(path: string, before: string, after: string): string {
  const d = unifiedDiff(path, before, after);
  const diff = d === '' ? '' : d.endsWith('\n') ? d : `${d}\n`;
  return sha12(diff);
}

interface Placement { label: string; after: string }
interface Target { path: string; needles: string[]; placements: (ls: Lines) => Placement[] }

const TARGETS: Record<string, Target> = {
  'sympy__sympy-15345': {
    path: 'sympy/printing/mathematica.py',
    needles: ['_print_MinMaxBase = _print_Function', '_print_MinMaxBase'],
    placements: (ls) => {
      const cls = findLine(ls, 'class MCodePrinter');
      let end = cls + 1;
      while (end <= ls.length && !/^(def |class )/.test(ls[end - 1] ?? '')) end++;
      const out: Placement[] = [];
      for (let L = cls + 1; L <= end; L++) out.push({ label: `insert before L${L}`, after: insertBefore(ls, L, ['    _print_MinMaxBase = _print_Function']) });
      return out;
    },
  },
  'sympy__sympy-17139': {
    path: 'sympy/simplify/fu.py',
    needles: ['if not rv.exp.is_real', 'rv.exp.is_real'],
    placements: (ls) => {
      const anchor = findLine(ls, 'if (rv.exp < 0) == True:');
      const out: Placement[] = [];
      for (let L = anchor - 6; L <= anchor + 6; L++) {
        let k = L;
        while (k <= ls.length && (ls[k - 1] ?? '').trim() === '') k++;
        const ind = indentOf(ls[k - 1] ?? '');
        out.push({ label: `2-line guard before L${L}`, after: insertBefore(ls, L, [`${ind}if not rv.exp.is_real:`, `${ind}    return rv`]) });
        out.push({ label: `1-line guard before L${L}`, after: insertBefore(ls, L, [`${ind}if not rv.exp.is_real: return rv`]) });
      }
      return out;
    },
  },
  'sympy__sympy-19954': {
    path: 'sympy/combinatorics/perm_groups.py',
    needles: ['reversed(list(enumerate(rep_blocks)))', 'if i >= len(num_blocks)', 'len(num_blocks)'],
    placements: (ls) => {
      const L = findLine(ls, 'for i, r in enumerate(rep_blocks):');
      const ind = indentOf(ls[L - 1] ?? '');
      const del = findLine(ls, 'del num_blocks[i], blocks[i]', L);
      const ind2 = indentOf(ls[del - 1] ?? '');
      const out: Placement[] = [{ label: `replace L${L} with reversed(list(enumerate(rep_blocks)))`, after: replaceSpan(ls, L, L, `${ind}for i, r in reversed(list(enumerate(rep_blocks))):`) }];
      // the guard before the raising `del` (the gold-equivalent that solved the instance twice) and the same guards at the gap AFTER it (rung 3's first site)
      for (const at of [del, del + 1]) for (const body of ['break', 'continue', 'return False']) for (const cond of ['i >= len(num_blocks)', 'i >= len(blocks)']) {
        out.push({ label: `guard 'if ${cond}: ${body}' before L${at}${at === del ? ' (before the del)' : ' (after the del)'}`, after: insertBefore(ls, at, [`${ind2}if ${cond}:`, `${ind2}    ${body}`]) });
      }
      return out;
    },
  },
  'sympy__sympy-11618': {
    path: 'sympy/geometry/point.py',
    needles: ['zip_longest'],
    placements: (ls) => {
      const L = findLine(ls, 'for a, b in zip(');
      const l1 = ls[L - 1] ?? '';
      const l2 = ls[L] ?? '';
      const two1 = l1.replace('zip(', 'zip_longest(');
      const two2 = l2.replace(' else p)]))', ' else p, fillvalue=0)]))');
      const one = `${two1}${two2.trim()}`;
      const out: Placement[] = [];
      const firstImport = findLine(ls, 'from sympy.core import');
      const lastImport = findLine(ls, 'from .entity import');
      for (let I = firstImport - 1; I <= lastImport + 2; I++) {
        const base2 = split(replaceSpan(ls, L, L + 1, `${two1}\n${two2}`));
        out.push({ label: `2-line zip_longest + import before L${I}`, after: insertBefore(base2, I, ['from itertools import zip_longest']) });
        const base1 = split(replaceSpan(ls, L, L + 1, one));
        out.push({ label: `joined zip_longest + import before L${I}`, after: insertBefore(base1, I, ['from itertools import zip_longest']) });
      }
      out.push({ label: 'zip_longest without the import (2-line)', after: replaceSpan(ls, L, L + 1, `${two1}\n${two2}`) });
      return out;
    },
  },
  'django__django-15315': {
    path: 'django/db/models/fields/__init__.py',
    needles: ['return hash(self.creation_counter)'],
    placements: (ls) => {
      const L = findLine(ls, 'return hash((');
      let end = L;
      while (end <= ls.length && !(ls[end - 1] ?? '').trim().startsWith('))')) end++;
      const ind = indentOf(ls[L - 1] ?? '');
      return [{ label: `replace L${L}-${end} with return hash(self.creation_counter)`, after: replaceSpan(ls, L, end, `${ind}return hash(self.creation_counter)`) }];
    },
  },
  'psf__requests-2931': {
    path: 'requests/models.py',
    needles: ['return data'],
    placements: (ls) => {
      const L = findLine(ls, 'return to_native_string(data)');
      const ind = indentOf(ls[L - 1] ?? '');
      return [{ label: `replace L${L} with return data`, after: replaceSpan(ls, L, L, `${ind}return data`) }];
    },
  },
  'sympy__sympy-12096': {
    path: 'sympy/core/function.py',
    needles: ['nfloat(self._imp_(*self.args), prec)', '.evalf(prec)'],
    placements: (ls) => {
      const L = findLine(ls, 'return Float(self._imp_(*self.args), prec)');
      const ind = indentOf(ls[L - 1] ?? '');
      return [
        { label: `replace L${L} with return nfloat(self._imp_(*self.args), prec)`, after: replaceSpan(ls, L, L, `${ind}return nfloat(self._imp_(*self.args), prec)`) },
        { label: `replace L${L} with the gold comprehension`, after: replaceSpan(ls, L, L, `${ind}return Float(self._imp_(*[i.evalf(prec) for i in self.args]), prec)`) },
      ];
    },
  },
};

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
for (const [task, t] of Object.entries(TARGETS)) {
  const rec = runs.get(task);
  console.log(`\n## ${task}`);
  if (rec === undefined) { console.log('  no record in the given results dirs'); continue; }
  const runDir = join(homedir(), '.jevcode/runs', rec.runId);
  const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as { workspace?: string; workspaceDir?: string };
  const ws = run.workspace ?? run.workspaceDir ?? '';
  console.log(`  run ${rec.runId} (${rec.reason ?? ''}, pass=${rec.pass}); workspace ${ws}`);
  const transcript = existsSync(join(runDir, 'transcript.log')) ? readFileSync(join(runDir, 'transcript.log'), 'utf8') : '';
  for (const kind of ['introspect', 'history']) for (const m of transcript.matchAll(new RegExp(`^\\[step (\\d+)\\] synth ${kind}: (.*)$`, 'gm'))) console.log(`  ${kind} @${m[1]}: ${m[2]!.slice(0, 260)}`);
  for (const m of transcript.matchAll(/^\[step (\d+)\] synth localize: (.*introspection site.*)$/gm)) console.log(`  introspection sites @${m[1]}: ${m[2]!.slice(0, 300)}`);
  const verifies = [...transcript.matchAll(/^\[step \d+\] synth verify: .*?(\d+) tested on .*$/gm)];
  const plausible = [...transcript.matchAll(/(\d+) plausible/g)].reduce((n, m) => n + Number(m[1]), 0);
  const searches = [...transcript.matchAll(/^\[step (\d+)\] synth search: (.*)$/gm)].map((m) => `${m[1]}:${m[2]!.slice(0, 120)}`);
  console.log(`  verify batches ${verifies.length}, tested ${verifies.reduce((n, m) => n + Number(m[1]), 0)}, plausible mentions ${plausible}; searches: ${searches.join(' || ')}`);
  for (const m of transcript.matchAll(/^\[step (\d+)\] synth guard: (.*)$/gm)) console.log(`  guard @${m[1]}: ${m[2]!.slice(0, 200)}`);
  // shown to Jev
  const shown: string[] = [];
  let options = 0;
  if (existsSync(join(runDir, 'decisions.jsonl'))) {
    for (const l of readFileSync(join(runDir, 'decisions.jsonl'), 'utf8').split('\n')) {
      if (l.trim() === '' || !l.includes('"criteria"')) continue;
      const d = JSON.parse(l) as { step: number; id: string; question: { type: string; criteria?: Record<string, unknown> }; answer: { choice?: string }; probability?: number };
      if (d.question.type !== 'choice' || d.id !== 'fix') continue;
      for (const [k, v] of Object.entries(d.question.criteria ?? {})) {
        if (typeof v !== 'string') continue;
        options += 1;
        const nv = norm(v);
        for (const needle of t.needles) if (nv.includes(norm(needle))) shown.push(`step ${d.step} ${k} ${JSON.stringify(v.trim()).slice(0, 100)} (answer ${d.answer.choice ?? '?'} p=${d.probability ?? '?'})`);
      }
    }
  }
  console.log(`  shown to Jev as a Choice option: ${shown.length === 0 ? 'no' : 'YES'} (${options} candidate options in fix Choices)${shown.length > 0 ? `\n    ${[...new Set(shown)].slice(0, 6).join('\n    ')}` : ''}`);
  // tested
  let tried: string[] = [];
  try {
    const st = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8')) as { state: { synthState?: { tried?: string[] } } };
    tried = st.state.synthState?.tried ?? [];
  } catch (e) { console.log(`  state.json unreadable: ${e instanceof Error ? e.message : String(e)}`); }
  const triedSet = new Set(tried);
  let before = '';
  try { before = execFileSync('git', ['-C', ws, 'show', `HEAD:${t.path}`], { encoding: 'utf8', maxBuffer: 64 << 20 }); } catch { console.log(`  cannot read HEAD:${t.path} in ${ws}`); }
  if (before !== '') {
    const ls = split(before);
    const placements = t.placements(ls);
    const hits = placements.filter((p) => triedSet.has(hashOf(t.path, before, p.after)));
    console.log(`  tested live (sha12 of the diff in tried, ${tried.length} hashes${tried.length >= 3000 ? ', TRUNCATED to the newest 3000' : ''}): ${hits.length === 0 ? 'no' : 'YES'} of ${placements.length} placements${hits.length > 0 ? ` — ${hits.map((h) => h.label).join('; ')}` : ''}`);
  }
  const mp = join(runDir, 'model_patch.diff');
  if (existsSync(mp)) {
    const patch = readFileSync(mp, 'utf8');
    console.log(`  committed patch (${patch.length} bytes):\n    ${patch.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).slice(0, 8).join('\n    ')}`);
  } else console.log('  committed patch: none');
}
