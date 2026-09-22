/**
 * Offline re-run of the assertions probe-token-synthesis.md verified with the probe scripts, now
 * against the production code and real Sites: vocabulary coverage 386/386 fix-line tokens, grammar
 * admission 425/426 positions (the exclusion is the `shortest_paths` multi-line fragment), template
 * pool coverage 17/40 (8 buggy line, 5 mutant, 4 donor), the pure permutation route producing the
 * fix for the four argument-order programs, and the listing equal to the probe's `program`. No Jev.
 * Skipped when the probe corpus is not checked out.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Json } from '../../../../src/core/types.js';
import { choice } from '../../../../src/jev/questions.js';
import { filterOptions, siteLineKind } from '../../../../src/synth/beam/beam.js';
import { permutationCandidates } from '../../../../src/synth/beam/permute.js';
import { markedListing } from '../../../../src/synth/beam/state.js';
import { slotOptions, templateOf, templatePool, templateText } from '../../../../src/synth/beam/templates.js';
import { sameTokens, toks } from '../../../../src/synth/beam/tokens.js';
import { END_KEY, buildVocabulary } from '../../../../src/synth/beam/vocab.js';
import { blockAt, scopeAt } from '../../../../src/synth/py/index.js';
import type { EnumerateOptions, Site } from '../../../../src/synth/types.js';
import { MARK } from '../../../../src/synth/beam/state.js';
import { sourceFile } from './helpers.js';

const CORPUS = new URL('../../../fixtures/synth/corpus.json', import.meta.url);

interface Item {
  name: string;
  kind: 'replace' | 'insert';
  indent: string;
  buggy_line: string | null;
  fix_line: string;
  marked_program: string;
  buggy_program: string;
  tests: Json[];
  tests_kind: 'json' | 'pytest_source';
}

function siteOf(item: Item): { site: Site; opts: EnumerateOptions } {
  const src = item.buggy_program.endsWith('\n') ? item.buggy_program : `${item.buggy_program}\n`;
  const file = sourceFile(`${item.name}.py`, src);
  const line = item.marked_program.split('\n').findIndex((l) => l.includes(MARK)) + 1;
  const b = blockAt(file.mod, line);
  const site: Site = {
    file,
    line,
    kind: item.kind,
    currentLine: item.kind === 'replace' ? (file.mod.lines[line - 1] ?? '') : '',
    indent: item.indent,
    block: b === undefined ? null : { name: b.name, startLine: b.startLine, endLine: b.endLine },
    scope: scopeAt(file.mod, line),
    evidence: { notes: [] },
  };
  const testLiterals = item.tests_kind === 'json' ? item.tests.map((t) => JSON.stringify(t)) : item.tests.map((t) => String(t));
  return { site, opts: { cap: 200, testLiterals, taskIdentifiers: [], corpus: new Map() } };
}

describe.skipIf(!existsSync(CORPUS))('token beam on the QuixBugs probe corpus (offline)', () => {
  const corpus: Item[] = existsSync(CORPUS) ? (JSON.parse(readFileSync(CORPUS, 'utf8')) as Item[]) : [];

  it('has the 40 measured lines', () => {
    expect(corpus).toHaveLength(40);
  });

  it('vocabulary covers 386/386 fix-line tokens and the grammar admits 425/426 positions, every option set a valid Choice', () => {
    let tokens = 0;
    let covered = 0;
    let positions = 0;
    let admitted = 0;
    const excluded: string[] = [];
    let maxOptions = 0;
    for (const item of corpus) {
      const { site, opts } = siteOf(item);
      const vocab = buildVocabulary(site, opts);
      const target = toks(item.fix_line);
      const kind = siteLineKind(site);
      for (let k = 0; k <= target.length; k++) {
        const options = filterOptions(vocab, target.slice(0, k), kind);
        expect(() => choice('q', options)).not.toThrow();
        maxOptions = Math.max(maxOptions, Object.keys(options).length);
        positions++;
        if (k === target.length) {
          if (options[END_KEY] !== undefined) admitted++;
          else excluded.push(item.name);
          continue;
        }
        tokens++;
        const v = vocab.byText.get(target[k]!.text);
        if (v !== undefined) covered++;
        if (v !== undefined && options[v.key] !== undefined) admitted++;
        else excluded.push(item.name);
      }
    }
    expect(tokens).toBe(386);
    expect(covered).toBe(386);
    expect(positions).toBe(426);
    expect(admitted).toBe(425);
    expect(excluded).toEqual(['shortest_paths']);
    expect(maxOptions).toBeLessThanOrEqual(253);
  });

  it('the template pool covers 17/40 fix shapes (8 buggy line, 5 mutant, 4 donor) with valid Choices', () => {
    const by: Record<string, number> = {};
    for (const item of corpus) {
      const { site, opts } = siteOf(item);
      const pool = templatePool(site, opts);
      expect(() => choice('q', Object.fromEntries(pool.map((e) => [e.key, { shape: e.text, from: e.source }])))).not.toThrow();
      const shape = templateText(templateOf(toks(item.fix_line)));
      const hit = pool.find((e) => e.text === shape);
      if (hit === undefined) continue;
      const source = hit.source === 'buggy_line' || hit.source === 'mutant_of_buggy_line' ? hit.source : 'donor';
      by[source] = (by[source] ?? 0) + 1;
      const vocab = buildVocabulary(site, opts);
      for (let k = 0; k < hit.slots; k++) {
        const slot = slotOptions(hit.toks, k, vocab);
        expect(slot.length).toBeGreaterThan(0);
        expect(() => choice('q', Object.fromEntries(slot.map((v) => [v.key, v.description])))).not.toThrow();
      }
    }
    expect(by).toEqual({ buggy_line: 8, mutant_of_buggy_line: 5, donor: 4 });
  });

  it('the pure permutation route yields the fix line for the four argument-order programs', () => {
    const hits = corpus.filter((item) => {
      const { site } = siteOf(item);
      const target = toks(item.fix_line);
      return permutationCandidates(site, 200).some((c) => sameTokens(toks(c.text), target));
    });
    expect(hits.map((i) => i.name).sort()).toEqual(['gcd', 'next_permutation', 'rpn_eval', 'shortest_path_lengths']);
  });

  it('the marked listing equals the measured `program` for every line', () => {
    for (const item of corpus) {
      const { site } = siteOf(item);
      expect(markedListing(site).trim(), item.name).toBe(item.marked_program.trim());
    }
  });
});
