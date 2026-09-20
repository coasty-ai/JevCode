/**
 * SEEDS vs WIDENED candidate counts at the 40 QuixBugs gold sites (mutation, templates, composite),
 * for the before/after comparison of experiments/results/jev-only-rungs-1-2.md (statement sites,
 * depth-2 wraps, import-carrying substitutions). $0: no Jev call, no Python.
 *
 * Usage: node node_modules/.bin/tsx experiments/reach/quixbugs-phase-counts.mts <tag>          # writes out/quixbugs-phase-counts.<tag>.json
 *        node node_modules/.bin/tsx experiments/reach/quixbugs-phase-counts.mts --compare a b  # prints the table
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMutationSource } from '../../src/synth/mutate/index.ts';
import { analyse, blockAt, scopeAt } from '../../src/synth/py/structure.ts';
import { createCompositeSource } from '../../src/synth/search/composite.ts';
import { createTemplateSource } from '../../src/synth/templates/index.ts';
import type { EnumerateOptions, Site, SourceFile } from '../../src/synth/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const QUIXBUGS = join(ROOT, 'bench/data/quixbugs');
const OUT_DIR = join(HERE, 'out');

interface Rec {
  name: string;
  bugLine: number;
  buggyLine: string | null;
  fixedLine: string;
  hasJsonTests: boolean;
}

function siteFor(src: string, line: number, kind: 'replace' | 'insert', indent: string | undefined, path: string): Site {
  const file: SourceFile = { path, src, mod: analyse(src) };
  const lineText = file.mod.lines[line - 1] ?? '';
  const b = blockAt(file.mod, line);
  return { file, line, kind, currentLine: kind === 'insert' ? '' : lineText, indent: indent ?? /^\s*/.exec(lineText)![0], block: b === undefined ? null : { name: b.name, startLine: b.startLine, endLine: b.endLine }, scope: scopeAt(file.mod, line), evidence: { notes: [] } };
}

function quixbugsSite(r: Rec): Site {
  const src = readFileSync(join(QUIXBUGS, 'programs', `${r.name}.py`), 'utf8');
  if (r.buggyLine !== null) return siteFor(src, r.bugLine, 'replace', undefined, `${r.name}.py`);
  const correct = readFileSync(join(QUIXBUGS, 'correct', `${r.name}.py`), 'utf8').split('\n');
  const gold = correct.find((l) => l.trim() === r.fixedLine) ?? r.fixedLine;
  return siteFor(src, r.bugLine, 'insert', /^\s*/.exec(gold)![0], `${r.name}.py`);
}

function testLiterals(r: Rec): string[] {
  if (!r.hasJsonTests) return [];
  const cases = JSON.parse(readFileSync(join(QUIXBUGS, 'tests', `${r.name}.json`), 'utf8')) as { input: unknown; expected: unknown }[];
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === 'number' && Number.isInteger(v) && Math.abs(v) < 1000) out.add(String(v));
    else if (typeof v === 'string' && v.length <= 12) out.add(`'${v.replace(/'/g, "\\'")}'`);
    else if (Array.isArray(v)) v.slice(0, 20).forEach(walk);
  };
  for (const c of cases.slice(0, 3)) {
    walk(c.input);
    walk(c.expected);
  }
  return [...out].slice(0, 10);
}

interface Row {
  name: string;
  kind: string;
  seeds: { mutation: number; template: number; composite: number };
  widened: { mutation: number; template: number; composite: number };
  goldInSeeds: boolean;
  goldInWidened: boolean;
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function measure(): Row[] {
  const records = JSON.parse(readFileSync(join(QUIXBUGS, 'index.json'), 'utf8')) as Rec[];
  const mutation = createMutationSource();
  const template = createTemplateSource();
  const composite = createCompositeSource();
  const rows: Row[] = [];
  for (const r of records) {
    const site = quixbugsSite(r);
    const corpus = new Map<string, SourceFile>([[site.file.path, site.file]]);
    const seeds: EnumerateOptions = { cap: 254, testLiterals: testLiterals(r), taskIdentifiers: [], corpus };
    // `phase` is the EnumerateOptions hint added with the depth-2 wraps; a spread keeps the script valid before the field exists
    const widened: EnumerateOptions = { ...seeds, ...({ phase: 'WIDENED' } as Partial<EnumerateOptions>) };
    const count = (opts: EnumerateOptions): { mutation: number; template: number; composite: number; texts: Set<string> } => {
      const m = mutation.enumerate(site, opts);
      const t = template.enumerate(site, opts);
      const c = composite.enumerate(site, opts);
      return { mutation: m.length, template: t.length, composite: c.length, texts: new Set([...m, ...t, ...c].map((x) => norm(x.text))) };
    };
    const s = count(seeds);
    const w = count(widened);
    const gold = norm(r.fixedLine);
    rows.push({ name: r.name, kind: site.kind, seeds: { mutation: s.mutation, template: s.template, composite: s.composite }, widened: { mutation: w.mutation, template: w.template, composite: w.composite }, goldInSeeds: s.texts.has(gold), goldInWidened: w.texts.has(gold) });
    console.error(`${r.name}: SEEDS ${s.mutation}+${s.template}+${s.composite} WIDENED ${w.mutation}+${w.template}+${w.composite} gold ${s.texts.has(gold) ? 'S' : '-'}${w.texts.has(gold) ? 'W' : '-'}`);
  }
  return rows;
}

const argv = process.argv.slice(2);
if (argv[0] === '--compare') {
  const a = JSON.parse(readFileSync(join(OUT_DIR, `quixbugs-phase-counts.${argv[1]}.json`), 'utf8')) as Row[];
  const b = JSON.parse(readFileSync(join(OUT_DIR, `quixbugs-phase-counts.${argv[2]}.json`), 'utf8')) as Row[];
  const total = (rows: Row[], phase: 'seeds' | 'widened'): number => rows.reduce((s, r) => s + r[phase].mutation + r[phase].template + r[phase].composite, 0);
  let seedsChanged = 0;
  let maxSiteGrowth = 0;
  let maxSite = '';
  console.log(`| program | SEEDS ${argv[1]} (m+t+c) | SEEDS ${argv[2]} | WIDENED ${argv[1]} | WIDENED ${argv[2]} | WIDENED growth | gold |`);
  console.log('| --- | --- | --- | --- | --- | --- | --- |');
  for (const ra of a) {
    const rb = b.find((r) => r.name === ra.name)!;
    const fmt = (x: Row['seeds']): string => `${x.mutation}+${x.template}+${x.composite}=${x.mutation + x.template + x.composite}`;
    const sa = ra.seeds.mutation + ra.seeds.template + ra.seeds.composite;
    const sb = rb.seeds.mutation + rb.seeds.template + rb.seeds.composite;
    const wa = ra.widened.mutation + ra.widened.template + ra.widened.composite;
    const wb = rb.widened.mutation + rb.widened.template + rb.widened.composite;
    if (sa !== sb || ra.seeds.mutation !== rb.seeds.mutation || ra.seeds.template !== rb.seeds.template || ra.seeds.composite !== rb.seeds.composite) seedsChanged += 1;
    const growth = wa === 0 ? 0 : (wb - wa) / wa;
    if (growth > maxSiteGrowth) {
      maxSiteGrowth = growth;
      maxSite = ra.name;
    }
    console.log(`| ${ra.name} | ${fmt(ra.seeds)} | ${fmt(rb.seeds)} | ${wa} | ${wb} | ${wa === 0 ? '-' : `${(growth * 100).toFixed(1)} %`} | ${rb.goldInSeeds ? 'S' : '-'}${rb.goldInWidened ? 'W' : '-'} |`);
  }
  console.log(`\nSEEDS total ${total(a, 'seeds')} -> ${total(b, 'seeds')} (${seedsChanged} sites changed); WIDENED total ${total(a, 'widened')} -> ${total(b, 'widened')} (${((total(b, 'widened') / total(a, 'widened') - 1) * 100).toFixed(1)} %); max per-site WIDENED growth ${(maxSiteGrowth * 100).toFixed(1)} % (${maxSite})`);
  console.log(`gold in SEEDS: ${a.filter((r) => r.goldInSeeds).length}/40 -> ${b.filter((r) => r.goldInSeeds).length}/40; in WIDENED: ${a.filter((r) => r.goldInWidened).length}/40 -> ${b.filter((r) => r.goldInWidened).length}/40`);
} else {
  const tag = argv[0] ?? 'now';
  const rows = measure();
  writeFileSync(join(OUT_DIR, `quixbugs-phase-counts.${tag}.json`), JSON.stringify(rows, null, 1));
  console.log(`written ${join(OUT_DIR, `quixbugs-phase-counts.${tag}.json`)}`);
}
