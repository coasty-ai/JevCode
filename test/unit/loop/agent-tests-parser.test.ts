/**
 * docs/AGENT-LOOP-DESIGN.md §15 S4 (src/workspace/tests.ts): `node --test` summaries parse. A `"test": "node --test"` script is
 * detected as `npm test` with runner `npm`; before `parseNodeTest` joined ALL_PARSERS its output read as nothing, so no agent run of
 * such a workspace could ever be `complete`. Captured from Node 22 (TAP when piped, spec with `--test-reporter=spec` or a TTY).
 */
import { describe, expect, it } from 'vitest';
import { parseNodeTest, parseTestOutput } from '../../../src/workspace/tests.js';

const NPM_HEAD = '\n> js-fix@ test\n> node --test\n\n';

const TAP_FAILING = `TAP version 13
# Subtest: sum
ok 1 - sum
  ---
  duration_ms: 0.292958
  type: 'test'
  ...
# Subtest: mean
not ok 2 - mean
  ---
  duration_ms: 0.303709
  type: 'test'
  location: '/tmp/js-fix/test/all.test.js:4:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:

    2 !== 3

  code: 'ERR_ASSERTION'
  ...
# Subtest: skipped one
ok 3 - skipped one # SKIP
# Subtest: todo one
ok 4 - todo one # TODO
1..4
# tests 4
# suites 0
# pass 1
# fail 1
# cancelled 0
# skipped 1
# todo 1
# duration_ms 35.556542
`;

const TAP_GREEN = `TAP version 13
# Subtest: sum
ok 1 - sum
# Subtest: mean
ok 2 - mean
# Subtest: capitalize
ok 3 - capitalize
1..3
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 41.2
`;

const SPEC_FAILING = `✔ sum (0.292958ms)
✖ mean (0.303709ms)
﹣ skipped one (0.033375ms) # SKIP
✔ todo one (0.030625ms) # TODO
ℹ tests 4
ℹ suites 0
ℹ pass 1
ℹ fail 1
ℹ cancelled 0
ℹ skipped 1
ℹ todo 1
ℹ duration_ms 34.131

✖ failing tests:

test at test/all.test.js:4:1
✖ mean (0.303709ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
      at TestContext.<anonymous> (file:///tmp/js-fix/test/all.test.js:4:39)
`;

describe('parseNodeTest (§15 S4)', () => {
  it('reads the TAP summary behind `npm test`: pass / fail, skipped + todo as skipped, cancelled as errors', () => {
    expect(parseTestOutput('npm', NPM_HEAD + TAP_FAILING)).toEqual({ passed: 1, failed: 1, errors: 0, skipped: 2 });
    expect(parseTestOutput('npm', NPM_HEAD + TAP_GREEN)).toEqual({ passed: 3, failed: 0, errors: 0, skipped: 0 });
  });

  it('reads the spec summary (ℹ rows), with the failure details that follow it', () => {
    expect(parseTestOutput('npm', SPEC_FAILING)).toEqual({ passed: 1, failed: 1, errors: 0, skipped: 2 });
    expect(parseTestOutput('unknown', SPEC_FAILING)).toEqual({ passed: 1, failed: 1, errors: 0, skipped: 2 });
  });

  it('strips ANSI colour (FORCE_COLOR) and counts cancelled tests as errors', () => {
    const coloured = '\u001b[34mℹ tests 3\u001b[39m\n\u001b[34mℹ pass 2\u001b[39m\n\u001b[34mℹ fail 0\u001b[39m\n\u001b[34mℹ cancelled 1\u001b[39m\n';
    expect(parseNodeTest(coloured)).toEqual({ passed: 2, failed: 0, errors: 1, skipped: 0 });
  });

  it('needs both a pass and a fail row: a stray `# pass` line in other output is not a summary', () => {
    expect(parseNodeTest('# pass 3\nsomething else\n')).toBeNull();
    expect(parseTestOutput('npm', 'build ok\n# pass 3\n')).toBeNull();
    expect(parseTestOutput('npm', 'no tests here')).toBeNull();
  });

  it('is tried LAST: formats another reader already understood keep their counts (the legacy modes gain facts, never different ones)', () => {
    expect(parseTestOutput('npm', 'Tests:       1 failed, 2 passed, 3 total\n')).toEqual({ passed: 2, failed: 1, errors: 0, skipped: 0 });
    expect(parseTestOutput('npm', '==== 3 passed in 0.12s ====\n')).toEqual({ passed: 3, failed: 0, errors: 0, skipped: 0 });
  });
});
