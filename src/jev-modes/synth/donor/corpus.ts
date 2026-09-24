/**
 * Normalised-shape index over every code line of the donor corpus (plastic-surgery
 * hypothesis, docs/JEV-ONLY.md; measured in experiments/results/probe-donor-and-templates.md:
 * a same-shape donor exists for 17/29 SWE-bench added lines, the true donor is top-1 in 35/36
 * QuixBugs programs when Jev chooses over the program's own lines).
 *
 * Shape = `py/similarity.normaliseLine` (NAME → ID, NUMBER → NUM, STRING → STR; keywords and
 * operators literal), so `memo[i, j] = memo[i - 1, j]` and `dp[a, b] = dp[a - 1, b]` share a key.
 * Per-file work (tokenizing, statement lookup) is cached on the SourceFile object; the maps are
 * assembled per call because the corpus Map can change between enumerations.
 */
import { normaliseLine } from '../py/similarity.js';
import { statementAt, blockAt } from '../py/structure.js';
import type { StatementKind } from '../py/structure.js';
import type { SourceFile } from '../types.js';
import { distinctNames, nameOccurrences } from './names.js';
import type { NameOccurrence } from './names.js';

/** One indexed physical line. `text` is trimmed; `indent` is the original leading whitespace. */
export interface DonorLine {
  file: SourceFile;
  path: string;
  /** 1-based physical line */
  line: number;
  text: string;
  indent: string;
  /** normalised tokens joined by one space: the index key */
  shape: string;
  shapeTokens: readonly string[];
  occurrences: readonly NameOccurrence[];
  /** distinct rebindable identifiers (no attributes, no keyword-argument labels) */
  identifiers: readonly string[];
  attributes: readonly string[];
  /** innermost enclosing def/class, null at module level */
  block: { name: string; startLine: number; endLine: number } | null;
  statementKind: StatementKind | null;
  /** the line starts a logical statement (continuation lines of a bracketed statement are false) */
  startsStatement: boolean;
  /** compound-statement header (`if …:`, `for …:`), whose body follows on the next lines */
  isHeader: boolean;
  /** last physical line of the header statement, for body extraction */
  statementEndLine: number;
  /** tab-expanded indentation column of the statement */
  statementIndent: number;
}

export interface DonorIndex {
  /** path → indexed lines of that file, in line order */
  files: ReadonlyMap<string, readonly DonorLine[]>;
  /** shape key → every line with that shape, in corpus order */
  byShape: ReadonlyMap<string, readonly DonorLine[]>;
  /** every indexed line, corpus order (files in insertion order, lines ascending) */
  lines: readonly DonorLine[];
  /** number of lines sharing a shape (0 for unseen shapes) */
  shapeFrequency(shape: string): number;
}

/** Statement kinds that never make sense as a donor statement on their own. */
export const NON_DONOR_KINDS: ReadonlySet<StatementKind> = new Set(['def', 'class', 'decorator', 'import', 'from_import', 'else', 'elif', 'except', 'finally', 'try', 'global', 'nonlocal']);

const perFile = new WeakMap<SourceFile, readonly DonorLine[]>();

/** Lines of one file worth indexing: anything with a name or keyword (blank, comment-only, docstring-only and bare-bracket lines are dropped). */
export function indexFile(file: SourceFile): readonly DonorLine[] {
  const cached = perFile.get(file);
  if (cached !== undefined) return cached;
  const out: DonorLine[] = [];
  file.mod.lines.forEach((raw, k) => {
    const shapeTokens = normaliseLine(raw);
    if (!shapeTokens.some((t) => t === 'ID' || /^[a-z]+$/.test(t))) return;
    const line = k + 1;
    const text = raw.trim();
    const st = statementAt(file.mod, line);
    const b = blockAt(file.mod, line);
    const occurrences = nameOccurrences(text);
    out.push({
      file,
      path: file.path,
      line,
      text,
      indent: /^[ \t]*/.exec(raw)?.[0] ?? '',
      shape: shapeTokens.join(' '),
      shapeTokens,
      occurrences,
      identifiers: distinctNames(occurrences, 'identifier'),
      attributes: distinctNames(occurrences, 'attribute'),
      block: b === undefined ? null : { name: b.name, startLine: b.startLine, endLine: b.endLine },
      statementKind: st?.kind ?? null,
      startsStatement: st !== undefined && st.startLine === line,
      isHeader: st !== undefined && st.header && st.startLine === line,
      statementEndLine: st?.endLine ?? line,
      statementIndent: st?.indent ?? 0,
    });
  });
  perFile.set(file, out);
  return out;
}

interface CacheEntry {
  index: DonorIndex;
  /** the SourceFile objects the index was built from, in order; identity-compared on reuse */
  files: readonly SourceFile[];
}
const perCorpus = new WeakMap<object, CacheEntry>();

function sameFiles(a: readonly SourceFile[], b: readonly SourceFile[]): boolean {
  return a.length === b.length && a.every((f, k) => f === b[k]);
}

function assemble(files: readonly SourceFile[]): DonorIndex {
  const byPath = new Map<string, readonly DonorLine[]>();
  const byShape = new Map<string, DonorLine[]>();
  const lines: DonorLine[] = [];
  for (const f of files) {
    if (byPath.has(f.path)) continue; // first occurrence of a path wins (the site's file is passed first)
    const indexed = indexFile(f);
    byPath.set(f.path, indexed);
    for (const l of indexed) {
      lines.push(l);
      const bucket = byShape.get(l.shape);
      if (bucket === undefined) byShape.set(l.shape, [l]);
      else bucket.push(l);
    }
  }
  return { files: byPath, byShape, lines, shapeFrequency: (shape) => byShape.get(shape)?.length ?? 0 };
}

/**
 * Build (or reuse) the index for a corpus given as the EnumerateOptions map or any iterable of
 * files. Reuse is keyed on the container object and verified against the file identities, so a
 * mutated map is re-indexed and an unchanged one costs a single pass over its entries.
 */
export function buildDonorIndex(corpus: ReadonlyMap<string, SourceFile> | Iterable<SourceFile>): DonorIndex {
  const files: SourceFile[] = corpus instanceof Map ? [...(corpus as ReadonlyMap<string, SourceFile>).values()] : [...(corpus as Iterable<SourceFile>)];
  const key = corpus as object;
  const hit = perCorpus.get(key);
  if (hit !== undefined && sameFiles(hit.files, files)) return hit.index;
  const index = assemble(files);
  if (typeof key === 'object' && !Array.isArray(key)) perCorpus.set(key, { index, files });
  return index;
}
