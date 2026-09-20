import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppliedCandidate } from '../../../../src/synth/types.js';
import { applyCandidate, indentedText } from '../../../../src/synth/verify/apply.js';
import { VerifyError } from '../../../../src/synth/verify/types.js';
import { candidate, GCD_BUGGY, site, sourceFile } from './helpers.js';

const gcd = sourceFile('gcd.py', GCD_BUGGY);

describe('applyCandidate: pure line edits', () => {
  it('replaces the site line, re-indenting bare text to the site indent', () => {
    const a = applyCandidate(candidate(site(gcd, 5), 'return gcd(b, a % b)'));
    expect(a.files).toHaveLength(1);
    expect(a.files[0]?.after).toBe('def gcd(a, b):\n    if b == 0:\n        return a\n    else:\n        return gcd(b, a % b)\n');
    expect(a.diff).toContain('-        return gcd(a % b, b)\n+        return gcd(b, a % b)\n');
    expect(a.diff.startsWith('diff --git a/gcd.py b/gcd.py\n')).toBe(true);
    expect(a.candidate.text).toBe('return gcd(b, a % b)');
    expect(gcd.src).toBe(GCD_BUGGY); // input untouched
  });
  it('text that carries its own indentation is taken verbatim', () => {
    const a = applyCandidate(candidate(site(gcd, 5), '        return gcd(b, a % b)'));
    expect(a.files[0]?.after).toContain('\n        return gcd(b, a % b)\n');
    expect(indentedText('x = 1', '  ')).toBe('  x = 1');
    expect(indentedText('  x = 1', '    ')).toBe('  x = 1');
    expect(indentedText('if a:\n    b', '    ')).toBe('    if a:\n        b');
    expect(indentedText('', '    ')).toBe('');
  });
  it('insert sites insert before the given line at the site indent', () => {
    const s = site(gcd, 2, 'insert');
    const a = applyCandidate(candidate(s, 'a, b = abs(a), abs(b)'));
    expect(a.files[0]?.after).toBe('def gcd(a, b):\n    a, b = abs(a), abs(b)\n    if b == 0:\n        return a\n    else:\n        return gcd(a % b, b)\n');
  });
  it('extraEdits use before-candidate line numbers and apply bottom-up (same file)', () => {
    const c = candidate(site(gcd, 2), 'if b <= 0:', [
      { path: 'gcd.py', line: 1, kind: 'insert', text: 'import math' }, // before line 1
      { path: 'gcd.py', line: 5, kind: 'replace', text: 'return gcd(b, a % b)' },
      { path: 'gcd.py', line: 6, kind: 'insert', text: '# end' }, // after the last line (count + 1)
    ]);
    const a = applyCandidate(c);
    expect(a.files[0]?.after).toBe('import math\ndef gcd(a, b):\n    if b <= 0:\n        return a\n    else:\n        return gcd(b, a % b)\n# end\n');
  });
  it('same-line edits: inserts read in list order (site text first), and a replace on that line still hits the original line', () => {
    // site insert before line 4 + extra insert before line 4 → site text above the extra
    const ins = applyCandidate(candidate(site(gcd, 4, 'insert'), 'a = abs(a)', [{ path: 'gcd.py', line: 4, kind: 'insert', text: 'b = abs(b)' }]));
    expect(ins.files[0]?.after).toBe('def gcd(a, b):\n    if b == 0:\n        return a\n    a = abs(a)\n    b = abs(b)\n    else:\n        return gcd(a % b, b)\n');
    // site insert before line 5 + extra replace of line 5 → the ORIGINAL line 5 is replaced, not the inserted text
    const mixed = applyCandidate(candidate(site(gcd, 5, 'insert'), 'a, b = b, a % b', [{ path: 'gcd.py', line: 5, kind: 'replace', text: 'return gcd(a, b)' }]));
    expect(mixed.files[0]?.after).toBe('def gcd(a, b):\n    if b == 0:\n        return a\n    else:\n        a, b = b, a % b\n        return gcd(a, b)\n');
  });
  it('extraEdits can touch another file from `files`; a delete edit removes a line', () => {
    const other = sourceFile('pkg/util.py', 'A = 1\nB = 2\nC = 3\n');
    const files = new Map([[gcd.path, gcd], [other.path, other]]);
    const c = candidate(site(gcd, 5), 'return gcd(b, a % b)', [{ path: 'pkg/util.py', line: 2, kind: 'delete' }]);
    const a = applyCandidate(c, files);
    expect(a.files.map((f) => f.path)).toEqual(['gcd.py', 'pkg/util.py']);
    expect(a.files[1]?.after).toBe('A = 1\nC = 3\n');
    expect(a.diff.split('diff --git ').length - 1).toBe(2);
  });
  it('`files` overrides the site snapshot when the content still matches the site line', () => {
    const current = sourceFile('gcd.py', `# header\n${GCD_BUGGY}`);
    // the site was computed on the old file, so line 5 is now a different line: stale
    expect(() => applyCandidate(candidate(site(gcd, 5), 'x'), new Map([[gcd.path, current]]))).toThrow(VerifyError);
  });
  it('stale sites, missing text and out-of-range edits throw VerifyError', () => {
    const stale = { ...site(gcd, 5), currentLine: 'something else' };
    expect(() => applyCandidate(candidate(stale, 'x'))).toThrow(/stale site/);
    expect(() => applyCandidate(candidate(site(gcd, 5), 'x', [{ path: 'gcd.py', line: 2, kind: 'replace' }]))).toThrow(/has no text/);
    expect(() => applyCandidate(candidate(site(gcd, 5), 'x', [{ path: 'gcd.py', line: 9, kind: 'insert', text: 'y' }]))).toThrow(/out of range/);
    expect(() => applyCandidate(candidate(site(gcd, 5), 'x', [{ path: 'nope.py', line: 1, kind: 'delete' }]))).toThrow(/not in the provided files/);
  });
  it('an unchanged candidate yields an empty diff', () => {
    const a = applyCandidate(candidate(site(gcd, 5), 'return gcd(a % b, b)'));
    expect(a.diff).toBe('');
    expect(a.files[0]?.after).toBe(GCD_BUGGY);
  });
});

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasGit())('the diff applies with git apply --check and reproduces `after`', () => {
  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'jevcode-verify-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const check = (a: AppliedCandidate) => {
    for (const f of a.files) {
      mkdirSync(dirname(join(dir, f.path)), { recursive: true });
      writeFileSync(join(dir, f.path), f.before);
    }
    writeFileSync(join(dir, 'cand.diff'), a.diff);
    execFileSync('git', ['apply', '--check', 'cand.diff'], { cwd: dir });
    execFileSync('git', ['apply', 'cand.diff'], { cwd: dir });
    for (const f of a.files) expect(readFileSync(join(dir, f.path), 'utf8')).toBe(f.after);
  };

  it('single replace', () => {
    check(applyCandidate(candidate(site(gcd, 5), 'return gcd(b, a % b)')));
  });
  it('replace + inserts + trailing insert + a second file, no trailing newline in one', () => {
    const other = sourceFile('pkg/util.py', 'A = 1\nB = 2\nC = 3');
    const files = new Map([[gcd.path, gcd], [other.path, other]]);
    const c = candidate(site(gcd, 2), 'if b <= 0:', [
      { path: 'gcd.py', line: 1, kind: 'insert', text: 'import math' },
      { path: 'gcd.py', line: 6, kind: 'insert', text: '# end' },
      { path: 'pkg/util.py', line: 3, kind: 'replace', text: 'C = 33' },
      { path: 'pkg/util.py', line: 1, kind: 'delete' },
    ]);
    check(applyCandidate(c, files));
  });
});
