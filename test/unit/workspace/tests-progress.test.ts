import { describe, expect, it } from 'vitest';
import { parsePytest, parsePytestProgress } from '../../../src/workspace/tests.js';

describe('pytest progress-line fallback (-qq prints no summary)', () => {
  it('counts dots, F, E, s, x, X across lines with and without file names', () => {
    const out = 'tests/test_a.py ..F.s                                        [ 62%]\n..xXE                                                             [100%]\n';
    expect(parsePytestProgress(out)).toEqual({ passed: 6, failed: 1, errors: 1, skipped: 2 });
    expect(parsePytest(out)).toEqual({ passed: 6, failed: 1, errors: 1, skipped: 2 });
  });
  it('prefers the summary line when present and returns null without any progress line', () => {
    expect(parsePytest('....... [100%]\n======= 7 passed in 0.01s =======\n')).toEqual({ passed: 7, failed: 0, errors: 0, skipped: 0 });
    expect(parsePytest('collecting ... nothing here\n')).toBeNull();
    expect(parsePytestProgress('random text [100%]\n')).toBeNull();
  });
});
