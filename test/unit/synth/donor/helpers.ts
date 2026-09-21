/** Fixtures and a scripted Jev for the donor tests: QuixBugs programs, ladder tasks, hand-built sites, valid Answer objects. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Answer, Decision, Json, Question, StageName } from '../../../../src/core/types.js';
import { choiceConfidence } from '../../../../src/jev/confidence.js';
import { analyse, blockAt, scopeAt } from '../../../../src/synth/py/structure.js';
import type { EnumerateOptions, JevAsk, Site, SourceFile } from '../../../../src/synth/types.js';

export const DATA = join(process.cwd(), 'bench', 'data');
export const QUIXBUGS = join(DATA, 'quixbugs');
export const LADDER = join(DATA, 'ladder');

export interface QuixbugsIndexRecord {
  name: string;
  bugLine: number;
  buggyLine: string | null;
  fixedLine: string;
}

export function quixbugsIndex(): QuixbugsIndexRecord[] {
  return JSON.parse(readFileSync(join(QUIXBUGS, 'index.json'), 'utf8')) as QuixbugsIndexRecord[];
}

export function sourceFile(path: string, src: string): SourceFile {
  return { path, src, mod: analyse(src) };
}

/** programs/<name>.py of every QuixBugs program (node.py included), keyed by `<name>.py`. */
export function quixbugsCorpus(): Map<string, SourceFile> {
  const out = new Map<string, SourceFile>();
  for (const f of readdirSync(join(QUIXBUGS, 'programs')).filter((n) => n.endsWith('.py')).sort()) {
    out.set(f, sourceFile(f, readFileSync(join(QUIXBUGS, 'programs', f), 'utf8')));
  }
  return out;
}

export function quixbugsCorrect(name: string): string {
  return readFileSync(join(QUIXBUGS, 'correct', `${name}.py`), 'utf8');
}

export interface LadderTask {
  name: string;
  /** buggy sources keyed by their task-relative path (`src/units.py`) */
  files: Map<string, SourceFile>;
  gold: Map<string, string>;
}

export function ladderTasks(): LadderTask[] {
  const index = JSON.parse(readFileSync(join(LADDER, 'index.json'), 'utf8')) as { name: string; files: string[]; path: string; tier?: string }[];
  // the short tier is the original twelve tasks these expectations were measured on; the long tier
  // (tasks 13–20) measures the horizon, not donor reach
  return index.filter((t) => t.tier !== 'long').map((t) => {
    const files = new Map<string, SourceFile>();
    const gold = new Map<string, string>();
    for (const rel of t.files) {
      files.set(rel, sourceFile(rel, readFileSync(join(LADDER, t.path, rel), 'utf8')));
      gold.set(rel, readFileSync(join(LADDER, t.path, 'gold', rel.replace(/^src\//, '')), 'utf8'));
    }
    return { name: t.name, files, gold };
  });
}

export interface SiteSpec {
  kind: 'replace' | 'insert';
  line: number;
  /** insert sites: indentation of the inserted line */
  indent?: string;
  /** line whose scope the site sees (default: the site line for replace, the line before for insert) */
  scopeLine?: number;
}

export function makeSite(file: SourceFile, spec: SiteSpec): Site {
  const raw = file.mod.lines[spec.line - 1] ?? '';
  const scopeLine = spec.scopeLine ?? (spec.kind === 'replace' ? spec.line : Math.max(1, spec.line - 1));
  const b = blockAt(file.mod, scopeLine);
  return {
    file,
    line: spec.line,
    kind: spec.kind,
    currentLine: spec.kind === 'replace' ? raw : '',
    indent: spec.kind === 'replace' ? (/^[ \t]*/.exec(raw)?.[0] ?? '') : (spec.indent ?? ''),
    block: b === undefined ? null : { name: b.name, startLine: b.startLine, endLine: b.endLine },
    scope: scopeAt(file.mod, scopeLine),
    evidence: { notes: ['test site'] },
  };
}

export function enumerateOptions(corpus: ReadonlyMap<string, SourceFile>, overrides: Partial<EnumerateOptions> = {}): EnumerateOptions {
  return { cap: 200, testLiterals: [], taskIdentifiers: [], corpus, ...overrides };
}

/** A valid Choice answer: probabilities over every option key summing to 1, choice = argmax, harness confidence. */
export function choiceAnswer(question: Question, weights: Record<string, number>): Answer {
  if (question.type !== 'choice') throw new Error('choiceAnswer needs a choice question');
  const keys = Object.keys(question.criteria);
  const raw = keys.map((k) => Math.max(0, weights[k] ?? 0));
  let total = raw.reduce((a, b) => a + b, 0);
  const filled = total === 0 ? keys.map(() => 1) : raw;
  total = filled.reduce((a, b) => a + b, 0);
  const probabilities: Record<string, number> = {};
  keys.forEach((k, i) => {
    probabilities[k] = filled[i]! / total;
  });
  let choice = keys[0]!;
  for (const k of keys) if (probabilities[k]! > probabilities[choice]!) choice = k;
  return { type: 'choice', choice, probabilities, confidence: choiceConfidence(probabilities[choice]!, keys.length) };
}

export interface AskCall {
  stage: StageName;
  state: Json;
  questions: Record<string, Question>;
}

/**
 * Scripted JevAsk: `script(id, question, state)` returns weights over option keys (missing keys
 * get 0; an all-zero script means uniform). Records every call so tests can assert the state
 * shape and the request count.
 */
export function scriptedAsk(script: (id: string, question: Question, state: Json) => Record<string, number>): JevAsk & { calls: AskCall[] } {
  const calls: AskCall[] = [];
  const ask: JevAsk = async (stage, state, questions) => {
    calls.push({ stage, state, questions });
    const answers: Record<string, Answer> = {};
    const rows: Decision[] = [];
    for (const [id, q] of Object.entries(questions)) answers[id] = choiceAnswer(q, script(id, q, state));
    return { answers, rows, latencyMs: 1 };
  };
  return Object.assign(ask, { calls });
}

export function holeTemplateOf(state: Json, key: string): string {
  const templates = (state as { replacement_templates: Record<string, string> }).replacement_templates;
  return templates[key] ?? '';
}
