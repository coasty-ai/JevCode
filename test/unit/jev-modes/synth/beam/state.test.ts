import { describe, expect, it } from 'vitest';
import { MARK, MODULE_CONTEXT_LINES, OUTER_BLOCK_MAX_LINES, WHOLE_FILE_MAX_LINES, baseState, listingRange, markedListing, taskSentence, testsView } from '../../../../../src/jev-modes/synth/beam/state.js';
import { GCD_FAILURES, gcdSite, siteAt, sourceFile } from './helpers.js';

/** An outer function holding a nested one, padded with comment lines so the file exceeds `WHOLE_FILE_MAX_LINES`. */
function nested(padding: number): string {
  const pad = Array.from({ length: padding }, (_, i) => `    # padding ${i}`).join('\n');
  return `import os\n\ndef outer(startnode):\n    visited = set()\n\n    def inner(node):\n        if node in visited:\n            return False\n        return inner(node)\n${pad}\n    return inner(startnode)\n`;
}

describe('state: listing range', () => {
  it('lists a short file whole, imports and helpers included (the measured shape)', () => {
    const { file, site } = gcdSite();
    expect(file.mod.lines.length).toBeLessThanOrEqual(WHOLE_FILE_MAX_LINES);
    expect(listingRange(site)).toEqual({ from: 1, to: file.mod.lines.length });
    const listing = markedListing(site);
    expect(listing.split('\n')[0]).toBe('def gcd(a, b):');
    expect(listing).toContain(`        ${MARK}`);
    expect(listing).not.toContain('return gcd(a % b, b)');
  });
  it('lists the outermost enclosing function for a site inside a nested function of a long file', () => {
    const file = sourceFile('dfs.py', nested(60));
    expect(file.mod.lines.length).toBeGreaterThan(WHOLE_FILE_MAX_LINES);
    const site = siteAt(file, 9, 'insert');
    expect(site.block?.name).toBe('inner');
    const listing = markedListing(site);
    expect(listing).toContain('def outer(startnode):');
    expect(listing).toContain('    visited = set()'); // the closure variable the fix needs
    expect(listing).toContain(`        ${MARK}\n        return inner(node)`);
    expect(listing).not.toContain('import os');
  });
  it('falls back to the innermost block when the outer one is too long, and to a window at module level', () => {
    const file = sourceFile('big.py', nested(OUTER_BLOCK_MAX_LINES + 10));
    const site = siteAt(file, 8);
    expect(listingRange(site)).toEqual({ from: site.block!.startLine, to: site.block!.endLine });
    expect(markedListing(site)).not.toContain('def outer');
    const moduleSite = siteAt(file, 1);
    expect(moduleSite.block).toBeNull();
    expect(listingRange(moduleSite)).toEqual({ from: 1, to: 1 + MODULE_CONTEXT_LINES });
    expect(markedListing(moduleSite).split('\n')[0]).toBe(MARK);
  });
  it('an insert site after the last listed line appends the marker', () => {
    const { file } = gcdSite();
    const site = siteAt(file, file.mod.lines.length + 1, 'insert');
    expect(markedListing(site).endsWith(MARK)).toBe(true);
  });
});

describe('state: base state', () => {
  it('uses the measured task sentence, null buggy_line for inserts and a bounded tests view', () => {
    const { file, site } = gcdSite();
    expect(taskSentence(site)).toBe(`The Python function \`gcd\` has a one-line bug. In \`program\` the faulty position is marked \`${MARK}\` (the marker keeps the correct indentation). The original wrong line at that position is \`buggy_line\`; the correct line is usually a small edit of it. The corrected program must make every entry of \`tests\` pass.`);
    const insert = siteAt(file, 3, 'insert');
    expect(taskSentence(insert)).toContain('No line existed there: a new line must be inserted.');
    const st = baseState(insert, '', GCD_FAILURES);
    expect(st['buggy_line']).toBeNull();
    expect(st['goal']).toBeUndefined();
    expect(st['file']).toBe('gcd.py');
    const many = Array.from({ length: 9 }, (_, i) => ({ testId: `t${i}`, call: `f(${i})`, expected: '1', actual: '0' }));
    expect(testsView(many)).toHaveLength(5);
  });
});
