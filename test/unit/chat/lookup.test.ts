/**
 * TUI-DESIGN-2 §3.6 jev-only lookup (S3, §8.1 row `lookup.test.ts`): `lookupKeywords`, `rankCandidates` (mentions first,
 * overlap desc, shorter paths, ≤ 60; `[measured]` over 20,000), the one request of context Nouls with the criteria in the
 * state, p ≥ 0.5 top 3, denylisted reads dropped, ≤ 3 lines ≤ 120 cells (definition lines first), the bubble and the miss line.
 */
import { describe, expect, it } from 'vitest';
import type { Answer, AskResult, Candidate, FileView, Json, Question } from '../../../src/core/types.js';
import {
  LOOKUP_CANDIDATES_MAX,
  LOOKUP_CRITERIA,
  LOOKUP_FOOTER,
  LOOKUP_HEADER,
  LOOKUP_HITS_MAX,
  LOOKUP_KEYWORDS_MAX,
  LOOKUP_LINE_CELLS,
  LOOKUP_READ_BYTES,
  excerptLines,
  lookupCode,
  lookupHitLine,
  lookupKeywords,
  lookupLines,
  lookupMissText,
  rankCandidates,
  type LookupResult,
} from '../../../src/chat/lookup.js';
import { cellWidth } from '../../../src/tui/glyphs.js';

const identity = (s: string): string => s;

function askWith(ps: Record<string, number>, calls: { state: Json; questions: Record<string, Question> }[] = []): (state: Json, questions: Record<string, Question>) => Promise<AskResult> {
  return async (state, questions) => {
    calls.push({ state, questions });
    const answers: Record<string, Answer> = {};
    Object.keys(questions).forEach((id, i) => {
      answers[id] = { type: 'noul', noul: ps[id] ?? (i === 0 ? 0.7 : 0.1) };
    });
    return { answers, usage: { inputTokens: 1200, outputTokens: 30, costUsd: 0.00005, calls: 1 }, latencyMs: 130, model: 'jev-1.13.0', requestHash: 'h1', attempts: 1, id: null };
  };
}

const FILES: Record<string, string> = {
  'utils/dates.py': ['import datetime', '', 'FMT = "%Y-%m-%d"', '', 'def parse_date(s: str, tz: str | None = None) -> datetime:', '    """parse"""', '    return datetime.strptime(s, FMT).replace(tzinfo=tz)', '', 'def other():', '    return parse_date("x")', '    # parse_date again', '    # parse_date again 2'].join('\n'),
  'tests/test_dates.py': 'from utils.dates import parse_date\n\ndef test_parse_date_tz():\n    assert parse_date("2020-01-01")\n',
  'README.md': '# proj\nparse_date is documented here\n',
};
const read = async (rel: string, maxBytes: number): Promise<FileView | null> => {
  expect(maxBytes).toBeLessThanOrEqual(LOOKUP_READ_BYTES);
  const c = FILES[rel];
  return c === undefined ? null : { path: rel, content: c, bytes: c.length, truncatedBytes: 0 };
};
const candidates: Candidate[] = Object.keys(FILES).map((path) => ({ path, bytes: FILES[path]!.length })).concat([{ path: 'src/unrelated/thing.ts', bytes: 10 }, { path: '.env', bytes: 3 }]);

describe('§3.6 keywords and ranking', () => {
  it('lookupKeywords: identifiers and words ≥ 3 chars, lower-cased, deduplicated, minus the stoplist, ≤ 12', () => {
    expect(lookupKeywords('Where is the date parsing? parse_date, tz handling in utils/dates.py')).toEqual(['date', 'parsing', 'parse_date', 'handling', 'utils', 'dates']);
    expect(lookupKeywords('is it ok?')).toEqual([]);
    expect(lookupKeywords(Array.from({ length: 30 }, (_, i) => `word${i}`).join(' '))).toHaveLength(LOOKUP_KEYWORDS_MAX);
    expect(lookupKeywords('Parse PARSE parse')).toEqual(['parse']);
  });

  it('rankCandidates: mentions first, then path-token overlap desc, then shorter paths; unrelated files drop; ≤ 60', () => {
    const ranked = rankCandidates(candidates, lookupKeywords('where is the date parsing in the tests?'), ['README.md']);
    expect(ranked.map((c) => c.path)).toEqual(['README.md', 'tests/test_dates.py', 'utils/dates.py']);
    expect(rankCandidates(candidates, ['nothing_matches'], [])).toEqual([]);
    const many = Array.from({ length: 200 }, (_, i) => ({ path: `pkg/dates_${i}.py`, bytes: 1 }));
    expect(rankCandidates(many, ['dates'], [])).toHaveLength(LOOKUP_CANDIDATES_MAX);
    expect(rankCandidates([{ path: 'a/b/dates.py', bytes: 1 }, { path: 'dates.py', bytes: 1 }], ['dates'], []).map((c) => c.path)).toEqual(['dates.py', 'a/b/dates.py']);
    expect(rankCandidates([{ path: 'x.py', bytes: 1 }], [], ['@x.py']).map((c) => c.path)).toEqual(['x.py']);
  });

  it('[measured] rankCandidates over 20,000 candidates', () => {
    const big: Candidate[] = Array.from({ length: 20_000 }, (_, i) => ({ path: `src/module_${i % 97}/file_${i}.${i % 3 === 0 ? 'py' : 'ts'}`, bytes: 100 }));
    const keywords = lookupKeywords('why does module_13 file_1300 fail on the date parsing?');
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const r = rankCandidates(big, keywords, ['src/module_5/file_5.ts']);
      samples.push(performance.now() - t0);
      expect(r[0]?.path).toBe('src/module_5/file_5.ts');
      expect(r.length).toBeLessThanOrEqual(LOOKUP_CANDIDATES_MAX);
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length / 2)] ?? 0;
    process.stdout.write(`[measured] rankCandidates over 20,000 candidates: p50 ${p50.toFixed(2)} ms · min ${samples[0]?.toFixed(2)} ms (design: ≈ 1 ms)\n`);
    expect(p50).toBeLessThan(25);
  });
});

describe('§3.6 lookupCode — one request, bounded reads, excerpts', () => {
  it('asks one context Noul per ranked file with the criteria written once in the state, keeps p ≥ 0.5 top 3, reads ≤ 64 KiB each, and drops a denied read to a path-only hit', async () => {
    const calls: { state: Json; questions: Record<string, Question> }[] = [];
    const r = await lookupCode({ message: 'where is the date parsing? see tests', mentions: [], candidates, read, ask: askWith({ file_0: 0.9, file_1: 0.8 }, calls), provider: 'typesafe', redact: identity, signal: new AbortController().signal });
    expect(calls).toHaveLength(1);
    const state = calls[0]!.state as { message: string; files: { path: string }[]; criteria: unknown };
    expect(state.criteria).toEqual(LOOKUP_CRITERIA);
    expect(state.files.map((f) => f.path)).toEqual(['tests/test_dates.py', 'utils/dates.py']);
    const q = calls[0]!.questions['file_0'];
    expect(q?.type).toBe('noul');
    if (q?.type === 'noul') {
      expect(q.criteria).toBeUndefined();
      expect(String(q.instructions)).toBe('Would reading `tests/test_dates.py` help answer `message`?');
    }
    expect(r.considered).toBe(2);
    expect(r.hits.map((h) => h.path)).toEqual(['tests/test_dates.py', 'utils/dates.py']);
    // definition lines first (5 `def parse_date`), then the first keyword lines in file order (1 `import datetime`, 7 `datetime.strptime`)
    expect(r.hits[1]?.lines.map((l) => l.n)).toEqual([5, 1, 7]);
    expect(r.hits[1]?.lines[0]?.text).toBe('def parse_date(s: str, tz: str | None = None) -> datetime:');
    expect(r.usage.costUsd).toBeCloseTo(0.00005, 9);
    expect(r.provider).toBe('typesafe');
    expect(r.latencyMs).toBe(130);
  });

  it('a hit whose read is denied or unreadable keeps the path with no lines; below the floor nothing is a hit; no candidate → no request', async () => {
    const calls: { state: Json; questions: Record<string, Question> }[] = [];
    const r = await lookupCode({ message: 'the env file?', mentions: ['.env'], candidates, read: async () => null, ask: askWith({ file_0: 0.9 }, calls), provider: 'openrouter', redact: identity, signal: new AbortController().signal });
    expect(r.hits).toEqual([{ path: '.env', p: 0.9, lines: [] }]);
    const miss = await lookupCode({ message: 'where is the date parsing?', mentions: [], candidates, read, ask: askWith({ file_0: 0.2, file_1: 0.4 }), provider: 'openrouter', redact: identity, signal: new AbortController().signal });
    expect(miss.hits).toEqual([]);
    expect(miss.considered).toBe(2);
    const none = await lookupCode({ message: 'zzz', mentions: [], candidates, read, ask: askWith({}, calls), provider: 'openrouter', redact: identity, signal: new AbortController().signal });
    expect(none).toMatchObject({ hits: [], considered: 0, latencyMs: 0 });
    expect(none.usage.costUsd).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('the message reaches Jev through redact; the signal aborts between reads', async () => {
    const calls: { state: Json; questions: Record<string, Question> }[] = [];
    await lookupCode({ message: 'where is sk-secret used in the dates parsing?', mentions: [], candidates, read, ask: askWith({}, calls), provider: 'openrouter', redact: (s) => s.replaceAll('sk-secret', '[REDACTED]'), signal: new AbortController().signal });
    expect(JSON.stringify(calls[0]!.state)).not.toContain('sk-secret');
    const c = new AbortController();
    const reason = new Error('stop');
    await expect(lookupCode({ message: 'date parsing', mentions: [], candidates, read: async (rel, max) => { c.abort(reason); return read(rel, max); }, ask: askWith({ file_0: 0.9, file_1: 0.9 }), provider: 'openrouter', redact: identity, signal: c.signal })).rejects.toBe(reason);
  });

  it('excerptLines: ≤ 3 keyword lines, definition lines first, each ≤ 100 cells, one-lined', () => {
    const lines = excerptLines(FILES['utils/dates.py']!, ['parse_date']);
    expect(lines.map((l) => l.n)).toEqual([5, 10, 11]);
    expect(lines).toHaveLength(3);
    const long = excerptLines(`def parse_date():\n    ${'x'.repeat(300)} parse_date\n`, ['parse_date']);
    for (const l of long) expect(cellWidth(l.text)).toBeLessThanOrEqual(100);
    expect(excerptLines('nothing here', ['parse_date'])).toEqual([]);
    expect(excerptLines('a\tparse_date\u001b[2J', ['parse_date'])[0]?.text).toBe('a parse_date[2J');
  });
});

describe('§3.6 the bubble', () => {
  const result = (hits: LookupResult['hits'], considered = 12): LookupResult => ({ hits, considered, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 1 }, latencyMs: 1, provider: 'typesafe', requestHash: 'h1' });

  it('header, one `  <path>:<n>  <text>` row per line (≤ 120 cells), a bare path for a hit without lines, footer — verbatim', () => {
    const lines = lookupLines(result([{ path: 'utils/dates.py', p: 0.9, lines: [{ n: 12, text: 'def parse_date(s: str, tz: str | None = None) -> datetime:' }, { n: 31, text: 'return datetime.strptime(s, FMT).replace(tzinfo=tz)' }] }, { path: 'tests/test_dates.py', p: 0.7, lines: [{ n: 8, text: 'def test_parse_date_tz():' }] }, { path: 'secret.txt', p: 0.6, lines: [] }]), 'proj');
    expect(lines).toEqual([LOOKUP_HEADER, '  utils/dates.py:12  def parse_date(s: str, tz: str | None = None) -> datetime:', '  utils/dates.py:31  return datetime.strptime(s, FMT).replace(tzinfo=tz)', '  tests/test_dates.py:8  def test_parse_date_tz():', '  secret.txt', LOOKUP_FOOTER]);
    expect(LOOKUP_HEADER).toBe("In jev-only mode I can point at code but not explain it — Jev decides, it doesn't write. Likely places:");
    expect(LOOKUP_FOOTER).toBe("Switch with /mode jev-on to get an explanation from the LLM, or describe the change and I'll make it.");
    expect(cellWidth(lookupHitLine('a/'.repeat(50) + 'x.py', { n: 1, text: 'y'.repeat(200) }))).toBeLessThanOrEqual(LOOKUP_LINE_CELLS);
    expect(LOOKUP_HITS_MAX).toBe(3);
  });

  it('the miss line names the directory and the number of candidates considered', () => {
    expect(lookupLines(result([], 12), 'proj')).toEqual([lookupMissText('proj', 12)]);
    expect(lookupMissText('proj', 12)).toBe("I couldn't find a file in proj that clearly answers that (looked at 12 candidates). Name the file or function, or switch with /mode jev-on for an explanation.");
    // §12 verbatim: `candidates` even for one — the glossary's literal, so pty / live expectations written from the spec (`candidates\)`) match
    expect(lookupMissText('proj', 1)).toContain('looked at 1 candidates)');
  });
});
