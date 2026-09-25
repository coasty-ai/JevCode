/**
 * The summary readers for the ecosystems detection learned (src/workspace/tests.ts): RSpec, Minitest / test-unit, Maven
 * Surefire, Gradle, dotnet, ExUnit, PHPUnit / Pest, Deno, mocha, Bun and Swift, each on a green and a failing run, and
 * `node --test` summed over the several summaries a workspaces run prints. They sit after every older reader in
 * ALL_PARSERS, so an output an older reader understood keeps its counts. The Minitest, test-unit and `node --test`
 * outputs were captured from real runs (ruby 2.6 / minitest 5.11 / test-unit 3.2, Node 22 `npm test --workspaces`);
 * the others follow each tool's documented summary format.
 */
import { describe, expect, it } from 'vitest';

import {
  parseBun,
  parseDeno,
  parseDotnet,
  parseExUnit,
  parseGradle,
  parseMaven,
  parseMinitest,
  parseMocha,
  parseNodeTest,
  parsePhpunit,
  parseRspec,
  parseSwift,
  parseTestOutput,
} from '../../../src/workspace/tests.js';

const c = (passed: number, failed: number, errors: number, skipped: number): { passed: number; failed: number; errors: number; skipped: number } => ({ passed, failed, errors, skipped });

describe('RSpec', () => {
  const failing = `Randomized with seed 12345
..*F

Pending: (Failures listed here are expected and do not affect your suite's status)

  1) Calculator divides
     # Not yet implemented
     # ./spec/calculator_spec.rb:14

Failures:

  1) Calculator subtracts
     Failure/Error: expect(calc.sub(3, 1)).to eq(1)

       expected: 1
            got: 2

       (compared using ==)
     # ./spec/calculator_spec.rb:10:in \`block (2 levels) in <top (required)>'

Finished in 0.01234 seconds (files took 0.08 seconds to load)
4 examples, 1 failure, 1 pending

Failed examples:

rspec ./spec/calculator_spec.rb:9 # Calculator subtracts

Randomized with seed 12345
`;
  it('green, failing with pending, coloured, and an error outside of examples', () => {
    expect(parseRspec('...\n\nFinished in 0.002 seconds (files took 0.05 seconds to load)\n3 examples, 0 failures\n')).toEqual(c(3, 0, 0, 0));
    expect(parseRspec(failing)).toEqual(c(2, 1, 0, 1));
    expect(parseRspec('\u001b[32m1 example, 0 failures\u001b[0m\n')).toEqual(c(1, 0, 0, 0));
    const loadError = "An error occurred while loading ./spec/foo_spec.rb.\nFailure/Error: require 'foo'\n\nLoadError:\n  cannot load such file -- foo\n\nFinished in 0.00003 seconds (files took 0.1 seconds to load)\n0 examples, 0 failures, 1 error occurred outside of examples\n";
    expect(parseRspec(loadError)).toEqual(c(0, 0, 1, 0));
    expect(parseTestOutput('unknown', failing)).toEqual(c(2, 1, 0, 1));
    expect(parseRspec('no summary here\n')).toBeNull();
  });
});

describe('Minitest and test-unit', () => {
  // ruby 2.6 / minitest 5.11.3, captured
  const minitestFailing = `Run options: --seed 11229

# Running:

.SEF

Finished in 0.003103s, 1289.0750 runs/s, 644.5375 assertions/s.

  1) Error:
T#test_d:
RuntimeError: boom
    t_test.rb:6:in \`test_d'

  2) Failure:
T#test_b [t_test.rb:4]:
Expected: 1
  Actual: 2

4 runs, 2 assertions, 1 failures, 1 errors, 1 skips

You have skipped tests. Run with --verbose for details.
`;
  const minitestGreen = 'Run options: --seed 35144\n\n# Running:\n\n..\n\nFinished in 0.002762s, 724.1130 runs/s, 724.1130 assertions/s.\n\n2 runs, 2 assertions, 0 failures, 0 errors, 0 skips\n';
  // test-unit 3.2.9, captured
  const testUnit = `Loaded suite tu_test
Started
.F
===============================================================================
Failure: test_b(TU)
<1> expected but was
<2>
===============================================================================
O
===============================================================================
Omission: later [test_c(TU)]
===============================================================================

Finished in 0.004539 seconds.
-------------------------------------------------------------------------------
3 tests, 2 assertions, 1 failures, 0 errors, 0 pendings, 1 omissions, 0 notifications
50% passed
-------------------------------------------------------------------------------
660.94 tests/s, 440.63 assertions/s
`;
  it('reads runs / failures / errors / skips (Rails `bin/rails test` prints the same line)', () => {
    expect(parseMinitest(minitestFailing)).toEqual(c(1, 1, 1, 1));
    expect(parseMinitest(minitestGreen)).toEqual(c(2, 0, 0, 0));
    expect(parseMinitest(testUnit)).toEqual(c(1, 1, 0, 1));
    expect(parseTestOutput('unknown', minitestFailing)).toEqual(c(1, 1, 1, 1));
    expect(parseTestOutput('unknown', testUnit)).toEqual(c(1, 1, 0, 1));
    expect(parseMinitest('Finished in 0.1s\n')).toBeNull();
  });
});

describe('Maven Surefire', () => {
  const failing = `[INFO] -------------------------------------------------------
[INFO]  T E S T S
[INFO] -------------------------------------------------------
[INFO] Running com.example.AppTest
[ERROR] Tests run: 3, Failures: 1, Errors: 0, Skipped: 1, Time elapsed: 0.034 s <<< FAILURE! -- in com.example.AppTest
[ERROR] com.example.AppTest.testSub -- Time elapsed: 0.005 s <<< FAILURE!
org.opentest4j.AssertionFailedError: expected: <1> but was: <2>
[INFO]
[INFO] Results:
[INFO]
[ERROR] Failures:
[ERROR]   AppTest.testSub:18 expected: <1> but was: <2>
[INFO]
[ERROR] Tests run: 3, Failures: 1, Errors: 0, Skipped: 1
[INFO]
[INFO] ------------------------------------------------------------------------
[INFO] BUILD FAILURE
`;
  const reactor = `[INFO] Running com.example.core.CoreTest
[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.02 s -- in com.example.core.CoreTest
[INFO]
[INFO] Results:
[INFO]
[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0
[INFO]
[INFO] --- surefire:3.2.5:test (default-test) @ api ---
[INFO] Running com.example.api.ApiTest
[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.03 s -- in com.example.api.ApiTest
[INFO] Running com.example.api.ErrTest
[INFO] Tests run: 1, Failures: 0, Errors: 1, Skipped: 0, Time elapsed: 0.01 s -- in com.example.api.ErrTest
[INFO]
[INFO] Results:
[INFO]
[ERROR] Tests run: 4, Failures: 0, Errors: 1, Skipped: 0
[INFO] BUILD FAILURE
`;
  it('the Results totals line, summed over the modules of a reactor build; per-class lines only without one', () => {
    expect(parseMaven(failing)).toEqual(c(1, 1, 0, 1));
    expect(parseMaven(reactor)).toEqual(c(5, 0, 1, 0));
    const killed = '[INFO] Running a.ATest\n[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.02 s -- in a.ATest\n[INFO] Running a.BTest\n[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.01 s <<< FAILURE! -- in a.BTest\n';
    expect(parseMaven(killed)).toEqual(c(2, 1, 0, 0));
    expect(parseTestOutput('unknown', failing)).toEqual(c(1, 1, 0, 1));
    expect(parseMaven('[INFO] BUILD SUCCESS\n')).toBeNull();
  });
});

describe('Gradle', () => {
  it('counts only when a test task fails (a green `gradle test` prints none)', () => {
    const failing = '> Task :app:test FAILED\n\nAppTest > subtracts() FAILED\n    org.opentest4j.AssertionFailedError at AppTest.java:18\n\n3 tests completed, 1 failed, 1 skipped\n\nFAILURE: Build failed with an exception.\n';
    expect(parseGradle(failing)).toEqual(c(1, 1, 0, 1));
    expect(parseTestOutput('unknown', failing)).toEqual(c(1, 1, 0, 1));
    expect(parseGradle('> Task :app:test\n\nBUILD SUCCESSFUL in 2s\n3 actionable tasks: 3 executed\n')).toBeNull();
  });
});

describe('dotnet test', () => {
  const output = `  Determining projects to restore...
  Calc.Tests -> /src/Calc.Tests/bin/Debug/net8.0/Calc.Tests.dll
Test run for /src/Calc.Tests/bin/Debug/net8.0/Calc.Tests.dll (.NETCoreApp,Version=v8.0)
Starting test execution, please wait...
A total of 1 test files matched the specified pattern.
  Failed Calc.Tests.SumTests.Subtracts [4 ms]
  Error Message:
   Assert.Equal() Failure
Failed!  - Failed:     1, Passed:     2, Skipped:     1, Total:     4, Duration: 12 ms - Calc.Tests.dll (net8.0)
Passed!  - Failed:     0, Passed:     5, Skipped:     0, Total:     5, Duration: 8 ms - Api.Tests.dll (net8.0)
`;
  it('sums the per-project lines; the terminal logger summary when that is all there is', () => {
    expect(parseDotnet(output)).toEqual(c(7, 1, 0, 1));
    expect(parseDotnet('Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3, Duration: 15 ms - A.Tests.dll (net8.0)\n')).toEqual(c(3, 0, 0, 0));
    expect(parseDotnet('Test summary: total: 4, failed: 1, succeeded: 2, skipped: 1, duration: 1.2s\n')).toEqual(c(2, 1, 0, 1));
    expect(parseTestOutput('unknown', output)).toEqual(c(7, 1, 0, 1));
    expect(parseDotnet('Build succeeded.\n')).toBeNull();
  });
});

describe('ExUnit (mix test)', () => {
  it('every counted kind is a test; excluded and skipped are skipped, invalid are errors', () => {
    const failing = 'Running ExUnit with seed: 123456, max_cases: 16\n\n..\n\n  1) test subtracts (CalcTest)\n     test/calc_test.exs:9\n     Assertion with == failed\n\n.\nFinished in 0.03 seconds (0.03s async, 0.00s sync)\n1 doctest, 3 tests, 1 failure, 1 skipped\n';
    expect(parseExUnit(failing)).toEqual(c(2, 1, 0, 1));
    expect(parseExUnit('Finished in 0.02 seconds (0.02s async, 0.00s sync)\n3 tests, 0 failures\n\nRandomized with seed 42\n')).toEqual(c(3, 0, 0, 0));
    expect(parseExUnit('1 property, 5 tests, 0 failures, 2 excluded\n')).toEqual(c(4, 0, 0, 2));
    expect(parseExUnit('4 tests, 0 failures, 1 invalid\n')).toEqual(c(3, 0, 1, 0));
    expect(parseTestOutput('unknown', failing)).toEqual(c(2, 1, 0, 1));
    expect(parseExUnit('Compiling 3 files (.ex)\n')).toBeNull();
  });
});

describe('PHPUnit and Pest', () => {
  it('OK (N tests), the FAILURES!/ERRORS! field line, and Pest / artisan test', () => {
    expect(parsePhpunit('...                                                                 3 / 3 (100%)\n\nTime: 00:00.012, Memory: 8.00 MB\n\nOK (3 tests, 5 assertions)\n')).toEqual(c(3, 0, 0, 0));
    expect(parsePhpunit('OK (1 test, 1 assertion)\n')).toEqual(c(1, 0, 0, 0));
    const failing = '..F.S                                                               5 / 5 (100%)\n\nThere was 1 failure:\n\n1) CalcTest::testSub\nFailed asserting that 2 is identical to 1.\n\nFAILURES!\nTests: 5, Assertions: 4, Failures: 1, Skipped: 1.\n';
    expect(parsePhpunit(failing)).toEqual(c(3, 1, 0, 1));
    expect(parsePhpunit('ERRORS!\nTests: 4, Assertions: 3, Errors: 1, Failures: 1.\n')).toEqual(c(2, 1, 1, 0));
    expect(parsePhpunit('OK, but there were issues!\nTests: 3, Assertions: 3, Deprecations: 1, Incomplete: 1.\n')).toEqual(c(2, 0, 0, 1));
    const pest = '   PASS  Tests\\Unit\\ExampleTest\n  ✓ that true is true\n\n   FAIL  Tests\\Feature\\CalcTest\n  ⨯ it subtracts\n\n  Tests:    1 failed, 2 passed (3 assertions)\n  Duration: 0.12s\n';
    expect(parsePhpunit(pest)).toEqual(c(2, 1, 0, 0));
    expect(parsePhpunit('  Tests:    4 passed, 1 skipped (4 assertions)\n')).toEqual(c(4, 0, 0, 1));
    expect(parseTestOutput('unknown', failing)).toEqual(c(3, 1, 0, 1));
    expect(parseTestOutput('unknown', pest)).toEqual(c(2, 1, 0, 0));
    expect(parsePhpunit('PHPUnit 10.5.0 by Sebastian Bergmann and contributors.\n')).toBeNull();
  });
});

describe('Deno', () => {
  it('ok / FAILED summaries, with steps, ignored and filtered tests', () => {
    const failing = 'running 3 tests from ./sum_test.ts\nsum ... ok (1ms)\nmean ... FAILED (2ms)\nskipped one ... ignored (0ms)\n\n ERRORS \n\nmean => ./sum_test.ts:5:6\nerror: AssertionError: Values are not equal.\n\n FAILURES \n\nmean => ./sum_test.ts:5:6\n\nFAILED | 1 passed | 1 failed | 1 ignored (15ms)\n\nerror: Test failed\n';
    expect(parseDeno(failing)).toEqual(c(1, 1, 0, 1));
    expect(parseDeno('ok | 3 passed | 0 failed (10ms)\n')).toEqual(c(3, 0, 0, 0));
    expect(parseDeno('ok | 2 passed (3 steps) | 0 failed (8ms)\n')).toEqual(c(2, 0, 0, 0));
    expect(parseDeno('ok | 1 passed | 0 failed | 4 filtered out (3ms)\n')).toEqual(c(1, 0, 0, 0));
    expect(parseTestOutput('unknown', failing)).toEqual(c(1, 1, 0, 1));
    expect(parseDeno('ok\n')).toBeNull();
  });
});

describe('mocha', () => {
  it('passing, then pending and failing', () => {
    const failing = '\n\n  sum\n    ✔ adds\n    - divides\n    1) subtracts\n\n\n  1 passing (6ms)\n  1 pending\n  1 failing\n\n  1) sum\n       subtracts:\n     AssertionError [ERR_ASSERTION]: 2 == 1\n';
    expect(parseMocha(failing)).toEqual(c(1, 1, 0, 1));
    expect(parseMocha('  sum\n    ✔ adds\n\n  3 passing (4ms)\n')).toEqual(c(3, 0, 0, 0));
    expect(parseMocha('  0 passing (2ms)\n  2 failing\n')).toEqual(c(0, 2, 0, 0));
    // behind `npm test` (runner npm) and in a vitest workspace (the JS family is one test command)
    expect(parseTestOutput('npm', failing)).toEqual(c(1, 1, 0, 1));
    expect(parseTestOutput('vitest', failing)).toEqual(c(1, 1, 0, 1));
    expect(parseMocha('3 passing tests\n')).toBeNull();
  });
});

describe('Bun', () => {
  it('the pass / fail / skip rows above `Ran N tests across M files.`', () => {
    const failing = 'bun test v1.1.30 (7996d06b)\n\ntest/sum.test.ts:\n✓ sum > adds [0.12ms]\n✗ sum > subtracts [0.20ms]\n» sum > divides\n\n 1 pass\n 1 skip\n 1 fail\n 2 expect() calls\nRan 3 tests across 1 files. [12.00ms]\n';
    expect(parseBun(failing)).toEqual(c(1, 1, 0, 1));
    expect(parseBun(' 4 pass\n 0 fail\n 6 expect() calls\nRan 4 tests across 2 files. [9.00ms]\n')).toEqual(c(4, 0, 0, 0));
    expect(parseTestOutput('npm', failing)).toEqual(c(1, 1, 0, 1));
    expect(parseBun(' 4 pass\n 0 fail\n')).toBeNull();
  });
});

describe('swift test', () => {
  it('XCTest’s last Executed line plus the swift-testing run line', () => {
    const both = `Test Suite 'All tests' started at 2024-05-01 10:00:00.000.
Test Case '-[SumTests.SumTests testAdds]' passed (0.001 seconds).
Test Case '-[SumTests.SumTests testSkip]' skipped (0.001 seconds).
/src/Tests/SumTests/SumTests.swift:7: error: -[SumTests.SumTests testWrong] : XCTAssertEqual failed: ("3") is not equal to ("4")
Test Case '-[SumTests.SumTests testWrong]' failed (0.002 seconds).
Test Suite 'SumTests' failed at 2024-05-01 10:00:00.004.
	 Executed 3 tests, with 1 test skipped and 1 failure (0 unexpected) in 0.004 (0.004) seconds
Test Suite 'All tests' failed at 2024-05-01 10:00:00.004.
	 Executed 3 tests, with 1 test skipped and 1 failure (0 unexpected) in 0.004 (0.005) seconds
◇ Test run started.
✔ Test addsST() passed after 0.001 seconds.
✘ Test wrongST() failed after 0.001 seconds with 1 issue.
✘ Test run with 2 tests failed after 0.001 seconds with 1 issue.
`;
    expect(parseSwift(both)).toEqual(c(2, 2, 0, 1));
    // XCTest ran nothing, swift-testing ran everything (a Swift 6 package)
    expect(parseSwift('\t Executed 0 tests, with 0 failures (0 unexpected) in 0.000 (0.000) seconds\n✔ Test run with 3 tests in 1 suite passed after 0.002 seconds.\n')).toEqual(c(3, 0, 0, 0));
    // failures count assertions, not tests: capped at the tests run
    expect(parseSwift('\t Executed 1 test, with 3 failures (0 unexpected) in 0.001 (0.001) seconds\n')).toEqual(c(0, 1, 0, 0));
    expect(parseTestOutput('unknown', both)).toEqual(c(2, 2, 0, 1));
    expect(parseSwift('Build complete!\n')).toBeNull();
  });
});

describe('node --test: several summaries are summed', () => {
  // Node 22 `npm test --workspaces --if-present` over two workspaces, captured (one test, then two)
  const workspaces = `
> @mono/a@1.0.0 test
> node --test

TAP version 13
# Subtest: double
ok 1 - double
  ---
  duration_ms: 0.412833
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 46.244375

> @mono/b@1.0.0 test
> node --test

TAP version 13
# Subtest: mean
ok 1 - mean
  ---
  duration_ms: 0.373958
  type: 'test'
  ...
# Subtest: sum
ok 2 - sum
  ---
  duration_ms: 0.394542
  type: 'test'
  ...
1..2
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 42.643375
`;
  it('3 passed, not the last workspace’s 2', () => {
    expect(parseNodeTest(workspaces)).toEqual(c(3, 0, 0, 0));
    expect(parseTestOutput('npm', workspaces)).toEqual(c(3, 0, 0, 0));
    const failingSecond = workspaces.replace('# pass 2\n# fail 0', '# pass 1\n# fail 1').replace('# skipped 0\n# todo 0\n# duration_ms 42', '# skipped 1\n# todo 0\n# duration_ms 42');
    expect(parseNodeTest(failingSecond)).toEqual(c(2, 1, 0, 1));
  });

  it('a vitest-detected workspace reads a `node --test` run too (the JS family is one test command)', () => {
    expect(parseTestOutput('vitest', workspaces)).toEqual(c(3, 0, 0, 0));
    expect(parseTestOutput('jest', workspaces)).toEqual(c(3, 0, 0, 0));
  });
});

describe('the new readers only add counts where no older one matched', () => {
  it('an output an older reader understands keeps its counts', () => {
    // a pytest run that also printed an RSpec-looking line and a mocha-looking line keeps the pytest counts
    const mixed = '3 examples, 1 failure\n  2 passing (3ms)\n======= 5 passed in 0.12s =======\n';
    expect(parseTestOutput('unknown', mixed)).toEqual(c(5, 0, 0, 0));
    expect(parseTestOutput('npm', 'Tests:       1 failed, 2 passed, 3 total\n')).toEqual(c(2, 1, 0, 0));
    // the Python runners stay strict: another ecosystem's summary is not theirs
    expect(parseTestOutput('pytest', '3 examples, 0 failures\n')).toBeNull();
    expect(parseTestOutput('cargo', 'ok | 3 passed | 0 failed (10ms)\n')).toBeNull();
  });
});
