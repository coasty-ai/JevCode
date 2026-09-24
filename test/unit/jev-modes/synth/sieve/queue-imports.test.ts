import { describe, expect, it } from 'vitest';
import { missingFromVocab } from '../../../../../src/jev-modes/synth/sieve/queue.js';
import type { Candidate, Site } from '../../../../../src/jev-modes/synth/types.js';

// A minimal candidate: only `text` matters for the vocabulary check.
function cand(text: string): Candidate {
  return { id: 'c', site: { file: { path: 'm.py', src: '', mod: {} as never }, line: 1, kind: 'insert', currentLine: '', indent: '', block: null, scope: {} as never, evidence: { notes: [] } } as Site, text, source: 'template', op: 'import_insert_top' };
}

describe('vocabulary pre-check: import module paths are not names the file must already contain', () => {
  const vocab = new Set(['Counter', 'tags', 'text', 'os', 'p']);
  it('from-imports check only the bound names', () => {
    expect(missingFromVocab(cand('from collections import Counter'), vocab)).toEqual([]);
    expect(missingFromVocab(cand('from collections.abc import Mapping'), vocab)).toEqual(['Mapping']);
  });
  it('bare imports check only `as` targets', () => {
    expect(missingFromVocab(cand('import collections.abc'), vocab)).toEqual([]);
    expect(missingFromVocab(cand('import os.path as p'), vocab)).toEqual([]);
    expect(missingFromVocab(cand('import json as jsonlib'), vocab)).toEqual(['jsonlib']);
  });
  it('ordinary lines are still fully checked', () => {
    expect(missingFromVocab(cand('tags = Counter(text)'), vocab)).toEqual([]);
    expect(missingFromVocab(cand('tags = Kounter(text)'), vocab)).toEqual(['Kounter']);
  });
});

describe('dedupe key: insert candidates differ by indentation', () => {
  it('keeps two indentations of one statement apart at an insert site, and merges them at a replace site', async () => {
    const { canonicalText } = await import('../../../../../src/jev-modes/synth/sieve/queue.js');
    const a = { text: '        opstack.append(token)', site: { kind: 'insert' as const } };
    const b = { text: '            opstack.append(token)', site: { kind: 'insert' as const } };
    expect(canonicalText(a)).not.toBe(canonicalText(b));
    const c = { text: '        x = 1', site: { kind: 'replace' as const } };
    const d = { text: 'x = 1', site: { kind: 'replace' as const } };
    expect(canonicalText(c)).toBe(canonicalText(d));
  });
});
