/**
 * Scope builders for the non-Python runners and the scope-usability guard
 * (docs/HARNESS-NEXT-DESIGN.md §6 S1, risks R-11 and R-14). The parsers for these runners were
 * already in the tree; without a builder every scoped run silently became the whole suite, and
 * with a *wrong* builder it silently becomes zero tests — which is what `scopeUsable` exists to
 * catch, and why it is unit-tested per runner before the builders are wired.
 */
import { describe, expect, it } from 'vitest';

import { cargoScope, goScope, jestScope, scopeBuilderFor, scopeUsable, vitestScope } from '../../../src/workspace/tests.js';
import { RUN_FAILURE_ID } from '../../../src/jev-modes/synth/verify/text.js';

describe('jest / vitest scope builders', () => {
  it('jest: file paths become escaped path regexes, node-id names become -t filters', () => {
    const scope = jestScope('npx jest');
    // the escaped regex carries backslashes, so it is shell-quoted: jest sees `src/a\.test\.ts`
    expect(scope(['src/a.test.ts'])).toBe("npx jest 'src/a\\.test\\.ts'");
    expect(scope(['src/a.test.ts::renders a row'])).toBe("npx jest 'src/a\\.test\\.ts' -t 'renders a row'");
    expect(scope(['renders a row'])).toBe("npx jest -t 'renders a row'");
    // duplicates collapse, order is kept
    expect(scope(['src/a.test.ts', 'src/a.test.ts::x', 'src/b.test.ts'])).toBe("npx jest 'src/a\\.test\\.ts' 'src/b\\.test\\.ts' -t x");
    expect(scope([])).toBe('npx jest');
  });

  it('vitest: the same shape without the regex escaping (paths are substring filters)', () => {
    const scope = vitestScope('npx vitest run');
    expect(scope(['test/unit/a.test.ts'])).toBe('npx vitest run test/unit/a.test.ts');
    expect(scope(['test/unit/a.test.ts::adds two'])).toBe("npx vitest run test/unit/a.test.ts -t 'adds two'");
    expect(scope([])).toBe('npx vitest run');
  });

  it('a package-manager wrapper gets the `--` separator, or the scope would be eaten by npm', () => {
    expect(jestScope('npm test')(['src/a.test.ts'])).toBe("npm test -- 'src/a\\.test\\.ts'");
    expect(vitestScope('pnpm test')(['a.test.ts'])).toBe('pnpm test -- a.test.ts');
    // already separated: no second `--`
    expect(vitestScope('npm test --')(['a.test.ts'])).toBe('npm test -- a.test.ts');
    // yarn passes arguments through, and a direct binary needs nothing
    expect(vitestScope('yarn test')(['a.test.ts'])).toBe('yarn test a.test.ts');
  });
});

describe('cargo / go scope builders', () => {
  it('cargo: a Rust path becomes a `module::test` substring filter, a bare name passes through', () => {
    const scope = cargoScope('cargo test');
    expect(scope(['src/parser.rs'])).toBe('cargo test parser');
    expect(scope(['src/parser.rs::parses_empty'])).toBe('cargo test parser::parses_empty');
    expect(scope(['tests/integration.rs'])).toBe('cargo test integration');
    // `mod`/`lib`/`main` are not module path segments
    expect(scope(['src/lexer/mod.rs::scans'])).toBe('cargo test lexer::scans');
    expect(scope(['parses_empty'])).toBe('cargo test parses_empty');
    expect(scope([])).toBe('cargo test');
  });

  it('cargo: two targets cannot be one filter, so the suite is left unscoped rather than mis-scoped', () => {
    const scope = cargoScope('cargo test');
    // `cargo test a b` is a usage error, not a union: one extra run beats a silent zero-test pass
    expect(scope(['parses_empty', 'parses_nested'])).toBe('cargo test');
    expect(scope(['src/parser.rs::a', 'src/lexer.rs::b'])).toBe('cargo test');
    // the same target twice is still one filter
    expect(scope(['src/parser.rs::a', 'src/parser.rs::a'])).toBe('cargo test parser::a');
  });

  it('go: paths become packages, names become one anchored -run alternation', () => {
    const scope = goScope('go test ./...');
    expect(scope(['pkg/lexer/lexer_test.go'])).toBe('go test ./pkg/lexer');
    expect(scope(['pkg/lexer/lexer_test.go::TestScan'])).toBe("go test ./pkg/lexer -run '^(TestScan)$'");
    expect(scope(['TestScan', 'TestParse'])).toBe("go test ./... -run '^(TestScan|TestParse)$'");
    expect(scope([])).toBe('go test ./...');
  });

  it('scopeBuilderFor now covers jest, vitest, cargo and go; npm and unknown still have none', () => {
    for (const r of ['pytest', 'django', 'sympy_bintest', 'unittest', 'jest', 'vitest', 'cargo', 'go'] as const) expect(scopeBuilderFor(r, 'x')).not.toBeNull();
    for (const r of ['npm', 'unknown'] as const) expect(scopeBuilderFor(r, 'x')).toBeNull();
  });
});

describe('the scope-usability guard', () => {
  it('a run that collected nothing is not evidence, however clean it looks', () => {
    // the failure mode of R-14: a wrong scope string runs zero tests and "0 failing" reads as success
    expect(scopeUsable({ passed: 0, failed: 0, errors: 0, skipped: 0 })).toBe(false);
    expect(scopeUsable(null)).toBe(false);
  });

  it('any non-zero collected count makes the run usable — including a skip-only or error-only run', () => {
    expect(scopeUsable({ passed: 3, failed: 0, errors: 0, skipped: 0 })).toBe(true);
    expect(scopeUsable({ passed: 0, failed: 1, errors: 0, skipped: 0 })).toBe(true);
    expect(scopeUsable({ passed: 0, failed: 0, errors: 1, skipped: 0 })).toBe(true);
    expect(scopeUsable({ passed: 0, failed: 0, errors: 0, skipped: 2 })).toBe(true);
  });

  it('the synthesised <test run> failure is not a collected test — the exact shape a bad jest/cargo/go filter makes', () => {
    // `summarize()` turns "exit 1, nothing parsed" into errors += 1 with this id. Counting it
    // would make every wrong scope on those runners read as usable, i.e. would disable the guard.
    expect(scopeUsable({ passed: 0, failed: 0, errors: 1, skipped: 0, failing: [RUN_FAILURE_ID] })).toBe(false);
    // a real error alongside it still counts
    expect(scopeUsable({ passed: 0, failed: 0, errors: 2, skipped: 0, failing: [RUN_FAILURE_ID, 'pkg/a_test.go::TestX'] })).toBe(true);
    expect(scopeUsable({ passed: 2, failed: 0, errors: 1, skipped: 0, failing: [RUN_FAILURE_ID] })).toBe(true);
  });
});
