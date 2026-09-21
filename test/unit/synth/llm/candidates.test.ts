import { describe, expect, it } from 'vitest';

import { sha12 } from '../../../../src/core/hash.js';
import { anchorHunk, applyLlmCandidate, attemptFromDrop, attemptFromOutcome, attemptLedger, convertSample, llmSiteEdits, reanchorLlmSite, type CompileCheck, type LlmApplied } from '../../../../src/synth/llm/candidates.js';
import type { PatchSpec } from '../../../../src/synth/llm/schema.js';
import type { LlmCandidate } from '../../../../src/synth/llm/types.js';
import type { Base, VerifyOutcome } from '../../../../src/synth/search/types.js';
import { progress } from '../../../../src/synth/verify/index.js';
import { candidate, siteAt, sourceFile, summary } from '../search/helpers.js';
import { applyCandidate } from '../../../../src/synth/verify/apply.js';
import { CALC_SRC, calcFiles } from './fixtures.js';

const files = calcFiles();
const calc = files.get('src/calc.py')!;

function patch(edits: { path?: string; old: string; new: string; nearLine?: number }[], rationale = 'r'): PatchSpec {
  return { rationale, edits: edits.map((e) => ({ path: e.path ?? 'src/calc.py', old: e.old, new: e.new, nearLine: e.nearLine ?? 0 })) };
}

async function convert(patches: PatchSpec[], over: { tried?: Set<string>; compile?: CompileCheck; seen?: Map<string, LlmCandidate>; verdictOf?: (sha: string) => string | null } = {}) {
  return convertSample({ sample: 0, patches, files, listings: [{ path: 'src/calc.py', startLine: 13, endLine: 19 }], ...over });
}

describe('anchorHunk: three tiers and near_line', () => {
  it('a block that appears twice is misanchored without near_line and anchored with it', () => {
    const old = '    if a is None:\n        return b';
    const bare = anchorHunk(calc.mod.lines, old);
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.reason).toMatch(/matches 2 places/);
    const near = anchorHunk(calc.mod.lines, old, 9);
    expect(near).toEqual({ ok: true, start: 8, end: 9, tier: 'exact' });
    // near_line too far from either copy does not pick one
    expect(anchorHunk(calc.mod.lines, old, 60).ok).toBe(false);
  });

  it('falls back to the whitespace-normalised and token-signature tiers, and reports a missing block', () => {
    expect(anchorHunk(calc.mod.lines, 'return a - b\n')).toEqual({ ok: true, start: 10, end: 10, tier: 'whitespace' });
    expect(anchorHunk(calc.mod.lines, 'out.append(x*k)')).toEqual({ ok: true, start: 18, end: 18, tier: 'tokens' });
    const missing = anchorHunk(calc.mod.lines, '    return a * b');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe('`old` not found');
  });
});

describe('convertSample: block-anchored sites, deletions, multi-file, drops, dedupe, compile', () => {
  it('replaces a dedenting block through the text-hashed span; the shipped applier agrees on the unchanged base and only the hashed span notices a reformatted copy', async () => {
    const old = '            continue\n        out.append(x * k)';
    const res = await convert([patch([{ old, new: '            pass\n        out.append(x * k * 2)' }])]);
    expect(res.dropped).toEqual([]);
    expect(res.candidates).toHaveLength(1);
    const c = res.candidates[0]!;
    expect(c.source).toBe('llm');
    expect(c.op).toBe('sample_0_0');
    expect(c.site.line).toBe(17);
    expect(c.site.endLine).toBe(18);
    expect(c.site.span).toEqual({ endLine: 18, textSha: sha12('            continue\n        out.append(x * k)') });
    expect(c.site.block?.name).toBe('scale');
    const applied = res.applied[0]!;
    expect(applied.diff).toContain('-            continue');
    expect(applied.diff).toContain('+            pass');
    expect(applied.diff).toContain('+        out.append(x * k * 2)');
    expect(applied.files[0]!.after.split('\n')[17]).toBe('        out.append(x * k * 2)');
    // agreement: on the unchanged base the shared applier (verify/apply.ts, `Site.span` by textSha) and the local one produce the same diff
    expect(applyCandidate(c, files).diff).toBe(applied.diff);
    // the textSha rule (§4.7 step 3): a base where one span line was reformatted (same code tokens, different text) is stale to both
    // appliers — the one-statement tokenizer check would have rewritten it blind; the search re-anchors such a site by text instead
    const reformatted = new Map([['src/calc.py', sourceFile('src/calc.py', CALC_SRC.replace('        out.append(x * k)', '        out.append(x*k)'))]]);
    expect(() => applyCandidate(c, reformatted)).toThrow(/stale llm site/);
    expect(() => applyLlmCandidate(c, reformatted)).toThrow(/stale llm site/);
  });

  it('a deletion hunk deletes every span line, primary included', async () => {
    const res = await convert([patch([{ old: '        if x is None:\n            continue', new: '' }])]);
    expect(res.candidates).toHaveLength(1);
    const c = res.candidates[0]!;
    expect(c.text).toBe('');
    expect(llmSiteEdits(c)).toEqual([
      { path: 'src/calc.py', line: 16, kind: 'delete' },
      { path: 'src/calc.py', line: 17, kind: 'delete' },
    ]);
    const after = res.applied[0]!.files[0]!.after;
    expect(after).not.toContain('continue');
    expect(after.split('\n').slice(14, 17)).toEqual(['    for x in xs:', '        out.append(x * k)', '    return out']);
  });

  it('a second hunk in another file becomes extraEdits and the diff covers both files', async () => {
    const res = await convert([patch([{ old: '    return a + b', new: '    return (a or 0) + b' }, { path: 'src/util.py', old: '    return max(lo, min(x, hi))', new: '    return min(hi, max(x, lo))' }])]);
    expect(res.dropped).toEqual([]);
    const c = res.candidates[0]!;
    expect(c.site.file.path).toBe('src/calc.py');
    expect(c.extraEdits).toEqual([{ path: 'src/util.py', line: 2, kind: 'replace', text: '    return min(hi, max(x, lo))' }]);
    expect(res.applied[0]!.files.map((f) => f.path)).toEqual(['src/calc.py', 'src/util.py']);
    expect(res.applied[0]!.diff).toMatch(/diff --git a\/src\/util\.py/);
  });

  it('drops a misanchored, a test-path and an unknown-file patch with reasons the ledger can feed back', async () => {
    const res = await convert([patch([{ old: '    return a * b', new: '    return a + b' }]), patch([{ path: 'tests/test_calc.py', old: 'x', new: 'y' }]), patch([{ path: 'src/nope.py', old: 'x', new: 'y' }])]);
    expect(res.candidates).toEqual([]);
    expect(res.dropped.map((d) => d.reason)).toEqual(['misanchored', 'test_path', 'not_in_base']);
    const row = attemptFromDrop(res.dropped[0]!, 2);
    expect(row?.verdict).toMatch(/^misanchored: `old` not found in src\/calc\.py: return a \* b/);
    expect(attemptFromDrop(res.dropped[1]!, 2)).toBeNull();
  });

  it('folds identical diffs (trailing whitespace normalised) into one candidate with agreement, and answers a tried diff at once', async () => {
    const seen = new Map<string, LlmCandidate>();
    const first = await convert([patch([{ old: '    return a + b', new: '    return (a or 0) + b   ' }])], { seen });
    expect(first.candidates).toHaveLength(1);
    const sha = first.candidates[0]!.id.slice('llm:'.length);
    const second = await convertSample({ sample: 1, patches: [patch([{ old: '    return a + b', new: '    return (a or 0) + b' }])], files, seen });
    expect(second.candidates).toEqual([]);
    expect(second.dropped[0]).toMatchObject({ reason: 'duplicate', sha });
    expect(first.candidates[0]!.prior).toBe(2);
    const tried = await convert([patch([{ old: '    return a + b', new: '    return (a or 0) + b' }])], { tried: new Set([sha]), verdictOf: () => 'unchanged: test_add still fails' });
    expect(tried.dropped[0]).toMatchObject({ reason: 'tried', detail: 'unchanged: test_add still fails' });
  });

  it('drops a patch whose post-image does not compile, with the checker message', async () => {
    const compile: CompileCheck = async (_path, source) => (source.includes('return (a or 0 + b') ? { ok: false, message: "SyntaxError: '(' was never closed (line 4)" } : { ok: true });
    const res = await convert([patch([{ old: '    return a + b', new: '    return (a or 0 + b' }]), patch([{ old: '    return a + b', new: '    return (a or 0) + b' }])], { compile });
    expect(res.dropped).toHaveLength(1);
    expect(res.dropped[0]).toMatchObject({ reason: 'syntax_error', detail: "SyntaxError: '(' was never closed (line 4) in src/calc.py" });
    expect(res.candidates).toHaveLength(1);
  });
});

describe('reanchorLlmSite and the attempt ledger', () => {
  it('re-anchors an llm site by text after lines shift above it', async () => {
    const res = await convert([patch([{ old: '        out.append(x * k)', new: '        out.append(x * k * 2)' }])]);
    const c = res.candidates[0]!;
    const shifted = sourceFile('src/calc.py', `import math\n\n${CALC_SRC}`);
    const site = reanchorLlmSite(c.site, new Map([['src/calc.py', shifted]]));
    expect(site?.line).toBe(20);
    expect(site?.span).toEqual({ endLine: 20, textSha: c.site.span.textSha });
    const moved: LlmCandidate = { ...c, site: site! };
    expect(applyLlmCandidate(moved, new Map([['src/calc.py', shifted]])).diff).toContain('+        out.append(x * k * 2)');
    // stale on the original file object: the span no longer hashes
    expect(() => applyLlmCandidate(moved, files)).toThrow(/stale llm site/);
    expect(reanchorLlmSite(siteAt(calc, 4), files)).toBeNull();
  });

  it('builds ledger rows from VerifyOutcomes with the code verdict vocabulary and folds by diff', () => {
    const base: Base = { id: 'b0', origin: 'committed', fromGoal: null, files, summary: summary({ failing: ['t::test_add'], passing: ['t::test_sub', 't::test_scale'] }), depth: 0 };
    const seed = candidate(siteAt(calc, 4), '    return a - b', { op: 'relational_swap' });
    const applied = applyCandidate(seed, files);
    const regressedRun = summary({ failing: ['t::test_add', 't::test_sub'], passing: ['t::test_scale'], failures: [{ testId: 't::test_sub', call: 'sub(1, 1)', expected: '0', actual: 'AssertionError: assert 2 == 0' }] });
    const o: VerifyOutcome = { job: { candidate: seed, base, p: 0.5, sourcePrior: 0.5, key: [2, 0.5, 0.5] }, applied, subset: regressedRun, progress: progress(base.summary, regressedRun), status: 'regressed' };
    const row = attemptFromOutcome(o, 3);
    expect(row.op).toBe('mutation:relational_swap');
    expect(row.verdict).toBe('regressed: 1 newly failing (t::test_sub: E AssertionError: assert 2 == 0)');
    expect(row.diffHead).toContain('-    return a + b');
    expect(row.diffHead).not.toMatch(/^diff --git/);
    const later = { ...row, verdict: 'unchanged: t::test_add still fails' };
    const rows = attemptLedger([row, later, ...Array.from({ length: 7 }, (_, i) => ({ ...row, sha: `s${i}`, op: `sample_${i}_0` }))]);
    expect(rows).toHaveLength(6);
    expect(rows.some((r) => r.sha === row.sha && r.verdict === later.verdict)).toBe(false); // folded then pushed out by the 7 newer rows
    expect(attemptLedger([row, later])).toEqual([later]);
  });

  it('exposes LlmApplied in the AppliedCandidate shape', async () => {
    const res = await convert([patch([{ old: '    return a + b', new: '    return b + a' }])]);
    const a: LlmApplied = res.applied[0]!;
    expect(a.files[0]!.before).toBe(CALC_SRC);
    expect(a.candidate.provenance).toBe('r');
  });
});
