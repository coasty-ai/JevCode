/**
 * Test-command detection from the repository's own files, recognition of a test run, and summary-line parsing
 * (DESIGN.md §8). Parsing is code, never a Jev question: the judge state carries the counts. Summaries are read from
 * the tail because a capped output keeps its last 16 KB.
 *
 * Detection order (first match wins; repository shapes only, never benchmark names). The detected command is the
 * model's hint and the reference a run is recognised against; the harness runs it itself only when asked to.
 *   a. an explicit pytest configuration: pytest.ini, pyproject [tool.pytest…], setup.cfg [tool:pytest], tox.ini
 *      [pytest]                                                    → `python -m pytest -q`. It beats a package.json:
 *      a Python project that also carries JS tooling said which runner it uses.
 *   b. a root package.json with a real scripts.test (not npm's placeholder), run with the project's package manager:
 *      the packageManager field (pnpm@…, yarn@…, bun@…, npm@…), else the lockfile (pnpm-lock.yaml, yarn.lock,
 *      bun.lockb / bun.lock), else npm                             → `npm test` / `pnpm test` / `yarn test` /
 *      `bun run test` (not `bun test`, which is Bun's own runner rather than the script); the runner is read from the
 *      script (vitest, jest, …, else `npm`, which tries every parser)
 *   c. Cargo.toml                                                  → `cargo test`
 *   d. go.mod                                                      → `go test ./...`
 *   e. deno.json / deno.jsonc                                      → `deno task test` with a tasks.test, else `deno test`
 *   f. Gemfile or Rakefile: spec/ → `bundle exec rspec` (`rspec` without a Gemfile); else test/ → `bundle exec rake
 *      test` (`rake test`)
 *   g. pom.xml                                                     → `./mvnw test` with the wrapper, else `mvn test`
 *      (never -q: quiet mode hides the `Tests run:` summary)
 *   h. build.gradle(.kts) / settings.gradle(.kts)                  → `./gradlew test` with the wrapper, else `gradle test`
 *   i. a root *.sln / *.slnx / *.csproj / *.fsproj / *.vbproj      → `dotnet test`
 *   j. mix.exs                                                     → `mix test`
 *   k. composer.json: scripts.test → `composer test`; else Pest in require-dev → `vendor/bin/pest`; else a phpunit.xml
 *      (.dist) / phpunit.dist.xml or vendor/bin/phpunit            → `vendor/bin/phpunit`
 *   l. Package.swift                                               → `swift test`
 *   m. Makefile / makefile / GNUmakefile with a `test:` target      → `make test`
 *   n. only then the inferred Python shapes, which name no runner themselves:
 *      - a top-level tests/runtests.py (a Django-style suite; `python -m pytest` exits 1 at once in such a checkout
 *        because nothing there is a pytest module)               → `python tests/runtests.py --parallel 1`
 *      - bin/test with a python shebang (a sympy-style runner)   → `python bin/test`
 *      - a pytest layout without configuration: conftest.py at the root, test_*.py / *_test.py at the root or under
 *        tests/ or test/                                         → `python -m pytest -q`
 *      - a tests/ or test/ package (__init__.py, no pytest files) → `python -m unittest discover -v`
 * `setup.py test` is never proposed: setuptools 72 removed the command. Ecosystems e–m use runner `unknown`, which tries
 * every parser; only the Python runners carry a scope builder (the legacy fast path reads `TestCommand.scope`).
 * `python` is the interpreter when the workspace has .venv/bin/python (the sandbox puts .venv/bin on PATH,
 * src/sandbox/run.ts), `python3` otherwise. A `.jevcode-spec.json` at the root, written by a bench loader with the
 * harness's own `test_cmd`, confirms the runner: when its command names a runner whose entry point exists in the tree,
 * that runner wins over the file order (a Django checkout carries a package.json whose `grunt test` would otherwise
 * win). Detection works without it.
 *
 * Recognition (`isTestCommand`): a command is a run of the detected test command when, after normalising both — `cd
 * <dir> &&`, `VAR=value`, `env`, `time` and `timeout <n>` prefixes and trailing `2>&1`, `| tail…`, `| head…`,
 * `| grep…`, `| tee…`, `| cat` and `|| true` dropped — it extends the detected command or names the same runner
 * family. The families and the spellings each accepts:
 *   js        npm test|t|tst|run test|run-script test (also `test:*` scripts), pnpm test|run test, yarn test|run
 *             test (also `yarn workspace <w> test`), bun run test, bun test, and vitest / jest / mocha / ava / tap /
 *             `node --test`, bare or after npx [--no-install], npm exec, pnpm [exec|dlx], yarn [exec], bunx, bun x,
 *             ./node_modules/.bin/ or node_modules/.bin/; any options before or arguments after (`-- file`, `-w x`,
 *             `--workspace x`, `--filter x`, `-C dir`). Every package-manager test script is in this family.
 *   pytest    pytest, py.test, python[3[.X]] -m pytest, .venv/bin/pytest, venv/bin/python -m pytest, each also after
 *             uv run, poetry run, pdm run, pipenv run, hatch run or rye run
 *   unittest  python -m unittest
 *   django    [python] [./][tests/]runtests.py
 *   sympy     [python] [./]bin/test
 *   cargo     cargo [+toolchain] test|t, cargo nextest run
 *   go        go test
 *   rspec     rspec, bin/rspec, bundle exec rspec, [bundle exec] rake spec
 *   minitest  [bundle exec] rake test, [bin/]rails test, ruby -Itest <x_test.rb | test_x.rb>
 *   maven     mvn / ./mvnw … test
 *   gradle    gradle / ./gradlew … test, including :module:test
 *   dotnet    dotnet test;  mix: mix test;  swift: swift test
 *   php       composer test|run test, [vendor/bin/]phpunit, [vendor/bin/]pest, php artisan test
 *   deno      deno test, deno task test
 *   make      make [-C dir] … test
 * A detected `make test` accepts any recognised family: it names no runner itself (runner `unknown`), and every parser
 * is tried on its output. A detected command outside every family keeps the older rule: the same program (and, for a
 * package manager or toolchain, the same subcommand).
 */
import type { TestCommand, TestCounts, TestRunner } from '../core/types.js';

/**
 * The id `src/jev-modes/synth/verify/text.ts` gives the failure it synthesises for a run that produced no
 * parsed result. Declared here rather than imported so this module stays free of `src/jev-modes/synth`
 * (the dependency runs the other way); `test/unit/workspace/tests-scope.test.ts` pins them equal.
 */
const RUN_FAILURE_ID = '<test run>';

export interface ManifestReader {
  /** relative path -> text (bounded) or null when missing / unreadable / not allowed */
  read(relPath: string): Promise<string | null>;
  /** relative directory listing (names only) or null */
  list(relPath: string): Promise<string[] | null>;
}

/** Written by bench loaders beside the checkout (git-excluded); `{ "test_cmd": "<the harness's test command>" }`. */
export const SPEC_FILE = '.jevcode-spec.json';

export type PythonInterpreter = 'python' | 'python3';
export type ScopeBuilder = (targets: readonly string[]) => string;
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

const NPM_PLACEHOLDER = /no test specified/;
const PYTHON_SHEBANG = /^#![^\n]*\bpython[0-9.]*\b/;
const TEST_FILE_NAME = /^test_.*\.py$|_tests?\.py$/;
/** a `test` target, alone or among several (`unit test: deps`), never `test := value` or `integration-test:` */
const MAKE_TEST_TARGET = /^(?:[^\s:#=]+[ \t]+)*test[ \t]*::?(?!=)/m;
const DOTNET_PROJECT = /\.(sln|slnx|csproj|fsproj|vbproj)$/;

function runnerFromScript(script: string): TestRunner {
  if (/\bvitest\b/.test(script)) return 'vitest';
  if (/\bjest\b/.test(script)) return 'jest';
  if (/\bpytest\b/.test(script)) return 'pytest';
  if (/\bcargo\s+test\b/.test(script)) return 'cargo';
  if (/\bgo\s+test\b/.test(script)) return 'go';
  return 'npm';
}

// ---------------------------------------------------------------------------------------
// Repository shapes
// ---------------------------------------------------------------------------------------

/** `python` when the workspace carries its own venv (on PATH inside the sandbox), else `python3`. */
export async function pythonInterpreter(r: ManifestReader): Promise<PythonInterpreter> {
  const bin = await r.list('.venv/bin');
  return bin !== null && bin.includes('python') ? 'python' : 'python3';
}

async function hasPytestConfig(r: ManifestReader): Promise<boolean> {
  if ((await r.read('pytest.ini')) !== null) return true;
  const pyproject = await r.read('pyproject.toml');
  if (pyproject !== null && /^\s*\[tool\.pytest(\.ini_options)?\]/m.test(pyproject)) return true;
  const setupCfg = await r.read('setup.cfg');
  if (setupCfg !== null && /^\s*\[tool:pytest\]/m.test(setupCfg)) return true;
  const tox = await r.read('tox.ini');
  if (tox !== null && /^\s*\[pytest\]/m.test(tox)) return true;
  return false;
}

async function hasDjangoRuntests(r: ManifestReader): Promise<boolean> {
  return (await r.read('tests/runtests.py')) !== null;
}

async function hasSympyBinTest(r: ManifestReader): Promise<boolean> {
  const text = await r.read('bin/test');
  return text !== null && PYTHON_SHEBANG.test(text);
}

async function hasPytestLayout(r: ManifestReader): Promise<boolean> {
  if ((await r.read('conftest.py')) !== null) return true;
  const root = await r.list('.');
  if (root !== null && root.some((n) => TEST_FILE_NAME.test(n))) return true;
  for (const dir of ['tests', 'test']) {
    const names = await r.list(dir);
    if (names !== null && names.some((n) => TEST_FILE_NAME.test(n) || n === 'conftest.py')) return true;
  }
  return false;
}

async function hasUnittestPackage(r: ManifestReader): Promise<boolean> {
  for (const dir of ['tests', 'test']) if ((await r.read(`${dir}/__init__.py`)) !== null) return true;
  return false;
}

type Json = Record<string, unknown>;

function asObject(v: unknown): Json | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null;
}

function parseJsonObject(text: string | null): Json | null {
  if (text === null) return null;
  try {
    return asObject(JSON.parse(text));
  } catch {
    return null; // malformed: detection proceeds as if the file were not there
  }
}

/** JSON with comments and trailing commas (deno.jsonc): comments outside strings are dropped before parsing. */
function parseJsoncObject(text: string | null): Json | null {
  if (text === null) return null;
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
    } else out += ch;
  }
  return parseJsonObject(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** The package manager a JS project uses: its packageManager field, else its lockfile, else npm. */
export function packageManagerOf(pkg: Json, rootNames: ReadonlySet<string>): PackageManager {
  const field = pkg['packageManager'];
  const declared = typeof field === 'string' ? /^(npm|pnpm|yarn|bun)@/.exec(field.trim()) : null;
  if (declared !== null) return declared[1] as PackageManager;
  if (rootNames.has('pnpm-lock.yaml')) return 'pnpm';
  if (rootNames.has('yarn.lock')) return 'yarn';
  if (rootNames.has('bun.lockb') || rootNames.has('bun.lock')) return 'bun';
  return 'npm';
}

/** The command that runs a package.json `test` script: `bun test` would run Bun's own runner, not the script. */
export function packageTestCommand(pm: PackageManager): string {
  return pm === 'bun' ? 'bun run test' : `${pm} test`;
}

// ---------------------------------------------------------------------------------------
// Commands per runner
// ---------------------------------------------------------------------------------------

export function pytestCommand(py: PythonInterpreter): string {
  return `${py} -m pytest -q`;
}
export function djangoCommand(py: PythonInterpreter): string {
  return `${py} tests/runtests.py --parallel 1`;
}
export function sympyCommand(py: PythonInterpreter): string {
  return `${py} bin/test`;
}
export function unittestCommand(py: PythonInterpreter): string {
  return `${py} -m unittest discover -v`;
}

function withScope(command: string, runner: TestRunner): TestCommand {
  const scope = scopeBuilderFor(runner, command);
  return scope === null ? { command, runner } : { command, runner, scope };
}

/**
 * The runner a shell test command names (env assignments and the interpreter skipped):
 * `./tests/runtests.py …` / `python tests/runtests.py` → django, `bin/test …` → sympy_bintest,
 * `pytest` / `py.test` / `python -m pytest` → pytest, `python -m unittest` / `python setup.py test`
 * → unittest; null for anything else.
 */
export function runnerFromCommand(command: string): TestRunner | null {
  const toks = command
    .trim()
    .split(/\s+/)
    .filter((t) => t !== '' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  const base = (t: string | undefined): string => (t ?? '').replace(/^['"]|['"]$/g, '').split('/').pop() ?? '';
  let i = 0;
  if (/^python[0-9.]*$/.test(base(toks[0]))) {
    i = 1;
    if (toks[1] === '-m') {
      const mod = toks[2] ?? '';
      if (mod === 'pytest') return 'pytest';
      if (mod === 'unittest') return 'unittest';
      return null;
    }
  }
  const script = (toks[i] ?? '').replace(/^['"]|['"]$/g, '');
  const name = base(script);
  if (name === 'runtests.py') return 'django';
  if (name === 'test' && /(^|\/)bin\/test$/.test(script)) return 'sympy_bintest';
  if (name === 'pytest' || name === 'py.test') return 'pytest';
  if (name === 'unittest') return 'unittest';
  if (name === 'setup.py' && toks[i + 1] === 'test') return 'unittest';
  return null;
}

async function readSpecCommand(r: ManifestReader): Promise<string | null> {
  const text = await r.read(SPEC_FILE);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && 'test_cmd' in parsed) {
      const cmd = (parsed as { test_cmd?: unknown }).test_cmd;
      if (typeof cmd === 'string' && cmd.trim() !== '') return cmd;
    }
  } catch {
    /* malformed spec: detection proceeds from the files alone */
  }
  return null;
}

/** The command for a runner the spec names, provided its entry point exists in the tree. */
async function commandForRunner(r: ManifestReader, runner: TestRunner, py: PythonInterpreter): Promise<TestCommand | null> {
  switch (runner) {
    case 'django':
      return (await hasDjangoRuntests(r)) ? withScope(djangoCommand(py), 'django') : null;
    case 'sympy_bintest':
      return (await r.read('bin/test')) !== null ? withScope(sympyCommand(py), 'sympy_bintest') : null;
    case 'pytest':
      return withScope(pytestCommand(py), 'pytest');
    case 'unittest':
      return withScope(unittestCommand(py), 'unittest');
    default:
      return null;
  }
}

/** A runner named only by the command it runs: every parser is tried on its output. */
const unknownRunner = (command: string): TestCommand => ({ command, runner: 'unknown' });

/** b–m of the module comment: the manifests that name their ecosystem's test command. */
async function detectFromManifests(r: ManifestReader): Promise<TestCommand | null> {
  const listing = new Set((await r.list('.')) ?? []);
  const has = async (name: string): Promise<boolean> => listing.has(name) || (await r.read(name)) !== null;

  const pkg = parseJsonObject(await r.read('package.json'));
  const script = asObject(pkg?.['scripts'])?.['test'];
  if (pkg !== null && typeof script === 'string' && script.trim().length > 0 && !NPM_PLACEHOLDER.test(script)) {
    return { command: packageTestCommand(packageManagerOf(pkg, listing)), runner: runnerFromScript(script) };
  }
  if ((await r.read('Cargo.toml')) !== null) return { command: 'cargo test', runner: 'cargo' };
  if ((await r.read('go.mod')) !== null) return { command: 'go test ./...', runner: 'go' };

  const denoText = (await r.read('deno.json')) ?? (await r.read('deno.jsonc'));
  if (denoText !== null) {
    const tasks = asObject(parseJsoncObject(denoText)?.['tasks']);
    return unknownRunner(tasks !== null && tasks['test'] !== undefined ? 'deno task test' : 'deno test');
  }

  const gemfile = await has('Gemfile');
  if (gemfile || (await has('Rakefile')) || (await has('rakefile'))) {
    const bundle = gemfile ? 'bundle exec ' : '';
    if ((await r.list('spec')) !== null) return unknownRunner(`${bundle}rspec`);
    if ((await r.list('test')) !== null) return unknownRunner(`${bundle}rake test`);
  }

  if (await has('pom.xml')) return unknownRunner((await has('mvnw')) ? './mvnw test' : 'mvn test');
  for (const f of ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']) {
    if (await has(f)) return unknownRunner((await has('gradlew')) ? './gradlew test' : 'gradle test');
  }
  if ([...listing].some((n) => DOTNET_PROJECT.test(n))) return unknownRunner('dotnet test');
  if (await has('mix.exs')) return unknownRunner('mix test');

  const composerText = await r.read('composer.json');
  if (composerText !== null) {
    const composer = parseJsonObject(composerText);
    if (asObject(composer?.['scripts'])?.['test'] !== undefined) return unknownRunner('composer test');
    const vendorBin = new Set((await r.list('vendor/bin')) ?? []);
    const requiresPest = [composer?.['require-dev'], composer?.['require']].some((deps) => asObject(deps)?.['pestphp/pest'] !== undefined);
    if (requiresPest || vendorBin.has('pest')) return unknownRunner('vendor/bin/pest');
    if (vendorBin.has('phpunit') || (await has('phpunit.xml')) || (await has('phpunit.xml.dist')) || (await has('phpunit.dist.xml'))) return unknownRunner('vendor/bin/phpunit');
  }

  if (await has('Package.swift')) return unknownRunner('swift test');
  for (const f of ['GNUmakefile', 'makefile', 'Makefile']) {
    const text = await r.read(f);
    if (text !== null && MAKE_TEST_TARGET.test(text)) return unknownRunner('make test');
  }
  return null;
}

async function detectFromFiles(r: ManifestReader, py: PythonInterpreter): Promise<TestCommand | null> {
  if (await hasPytestConfig(r)) return withScope(pytestCommand(py), 'pytest');
  const manifest = await detectFromManifests(r);
  if (manifest !== null) return manifest;
  if (await hasDjangoRuntests(r)) return withScope(djangoCommand(py), 'django');
  if (await hasSympyBinTest(r)) return withScope(sympyCommand(py), 'sympy_bintest');
  if (await hasPytestLayout(r)) return withScope(pytestCommand(py), 'pytest');
  if (await hasUnittestPackage(r)) return withScope(unittestCommand(py), 'unittest');
  return null;
}

/** See the module comment for the order; the spec file only confirms a runner whose entry point exists. */
export async function detectTestCommand(r: ManifestReader): Promise<TestCommand | null> {
  const py = await pythonInterpreter(r);
  const detected = await detectFromFiles(r, py);
  const specCommand = await readSpecCommand(r);
  if (specCommand !== null) {
    const runner = runnerFromCommand(specCommand);
    if (runner !== null && detected?.runner !== runner) {
      const confirmed = await commandForRunner(r, runner, py);
      if (confirmed !== null) return confirmed;
    }
  }
  return detected;
}

// ---------------------------------------------------------------------------------------
// Recognising a run of the detected command
// ---------------------------------------------------------------------------------------

/** A shell word with its quotes: `'a b'`, `"a b"` or a run of other characters. */
const WORD = `(?:'[^']*'|"[^"]*"|[^\\s'"])+`;
const LEADING: readonly RegExp[] = [
  new RegExp(`^cd\\s+${WORD}\\s*&&\\s*`),
  new RegExp(`^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\\s'"])*\\s+`),
  /^env\s+(?=[A-Za-z_][A-Za-z0-9_]*=)/,
  /^time(?:\s+-p)?\s+/,
  /^timeout\s+(?:-[sk]\s+\S+\s+|--?[A-Za-z][\w-]*(?:=\S+)?\s+)*\d+(?:\.\d+)?[smhd]?\s+/,
];
/** an argument of a trailing filter: a word that is not itself a pipe, a list operator or a redirect */
const FILTER_ARG = `(?:'[^']*'|"[^"]*"|[^\\s'"|&;<>])+`;
const TRAILING: readonly RegExp[] = [
  /\s+2>&1$/,
  /\s*\|\|\s*true$/,
  new RegExp(`\\s*(?<!\\|)\\|&?\\s*(?:tail|head|grep|egrep|tee|cat)(?:\\s+${FILTER_ARG})*$`),
];

/** The command a shell line runs, with the wrappers of the module comment dropped; `exitMasked` when a pipe or `|| true` went. */
export function testInvocation(command: string): { core: string; exitMasked: boolean } {
  let s = command.replace(/\s+/g, ' ').trim();
  let exitMasked = false;
  for (let changed = true; changed; ) {
    changed = false;
    for (const re of LEADING) {
      const next = s.replace(re, '');
      if (next !== s && next !== '') {
        s = next;
        changed = true;
      }
    }
    for (const re of TRAILING) {
      const next = s.replace(re, '');
      if (next !== s && next !== '') {
        if (re !== TRAILING[0]) exitMasked = true;
        s = next;
        changed = true;
      }
    }
  }
  // a pipe left in the line (`npm test | tail -5 | sh`) reports its last command's status too
  return { core: s, exitMasked: exitMasked || s.includes('|') };
}

type Family = 'js' | 'pytest' | 'unittest' | 'django' | 'sympy' | 'cargo' | 'go' | 'rspec' | 'minitest' | 'maven' | 'gradle' | 'dotnet' | 'mix' | 'php' | 'deno' | 'swift' | 'make';

const unquote = (t: string): string => t.replace(/^(['"])(.*)\1$/, '$2');
const baseName = (t: string): string => {
  const u = unquote(t);
  return u.slice(u.lastIndexOf('/') + 1);
};
const NO_ARGS: ReadonlySet<string> = new Set();

/** The index of the first token at or after `i` that is not an option; an option in `withArg` also takes the next token. */
function skipOptions(toks: readonly string[], i: number, withArg: ReadonlySet<string> = NO_ARGS): number {
  let j = i;
  while (j < toks.length && toks[j]!.startsWith('-')) j += withArg.has(toks[j]!) ? 2 : 1;
  return j;
}

const JS_RUNNERS: ReadonlySet<string> = new Set(['vitest', 'jest', 'mocha', 'ava', 'tap']);
const NODE_ARG_FLAGS: ReadonlySet<string> = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--env-file', '--test-reporter', '--test-reporter-destination', '--test-name-pattern', '--test-skip-pattern', '--test-concurrency', '--test-timeout', '--test-shard']);
const PM_ARG_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(['--prefix', '-w', '--workspace', '--userconfig', '--cache', '--registry', '--loglevel']),
  pnpm: new Set(['-C', '--dir', '--filter', '-F', '--filter-prod', '--workspace-concurrency', '--reporter', '--loglevel', '--test-pattern']),
  yarn: new Set(['--cwd']),
  bun: new Set(['--cwd', '--filter', '-F']),
};
const NPX_ARG_FLAGS: ReadonlySet<string> = new Set(['-p', '--package']);
const PY_PROJECT_RUNNERS: ReadonlySet<string> = new Set(['uv', 'poetry', 'pdm', 'pipenv', 'hatch', 'rye']);
const PY_RUN_ARG_FLAGS: ReadonlySet<string> = new Set(['--with', '--with-requirements', '--python', '-p', '--extra', '--group', '--package', '--directory', '--project', '--env-file', '--index', '--index-url']);
const MAKE_ARG_FLAGS: ReadonlySet<string> = new Set(['-C', '--directory', '-f', '--file', '--makefile', '-I', '--include-dir', '-o', '-W']);
const RUBY_ARG_FLAGS: ReadonlySet<string> = new Set(['-I', '-r', '-C', '-E']);

const isTestScript = (s: string | undefined): boolean => s !== undefined && /^test(:|$)/.test(s);

/** vitest / jest / mocha / ava / tap (any path to the binary), or `node --test` / `tsx --test`. */
function jsRunnerAt(toks: readonly string[], i: number): boolean {
  const name = baseName(toks[i] ?? '');
  if (JS_RUNNERS.has(name)) return true;
  if (name !== 'node' && name !== 'tsx') return false;
  for (let j = i + 1; j < toks.length && toks[j]!.startsWith('-'); j += NODE_ARG_FLAGS.has(toks[j]!) ? 2 : 1) if (toks[j] === '--test') return true;
  return false;
}

/** `npm test`, `pnpm --filter x run test`, `yarn workspace a test`, `bun run test`, `pnpm exec vitest`, `yarn jest`, … */
function packageManagerFamily(pm: string, toks: readonly string[], i: number): Family | null {
  const flags = PM_ARG_FLAGS[pm] ?? NO_ARGS;
  let j = skipOptions(toks, i + 1, flags);
  if (pm === 'yarn' && toks[j] === 'workspace') j = skipOptions(toks, j + 2, flags);
  else if (pm === 'yarn' && toks[j] === 'workspaces') j = toks[j + 1] === 'foreach' ? skipOptions(toks, j + 2, new Set(['--from', '--include', '--exclude', '-j', '--jobs'])) : j + 1;
  else if (pm === 'pnpm' && toks[j] === 'recursive') j = skipOptions(toks, j + 1, flags);
  const sub = toks[j];
  if (sub === 'test' || ((pm === 'npm' || pm === 'pnpm') && (sub === 't' || sub === 'tst'))) return 'js';
  if (sub === 'run' || sub === 'run-script') {
    const k = skipOptions(toks, j + 1, flags);
    return isTestScript(toks[k]) || jsRunnerAt(toks, k) ? 'js' : null;
  }
  if (sub === 'exec' || sub === 'x' || sub === 'dlx') {
    const k = skipOptions(toks, j + 1, NPX_ARG_FLAGS);
    return jsRunnerAt(toks, k) ? 'js' : null;
  }
  // pnpm, yarn and bun run a script or a local binary named directly (`pnpm test:unit`, `yarn vitest`)
  if (pm !== 'npm' && (isTestScript(sub) || jsRunnerAt(toks, j))) return 'js';
  return null;
}

/** `python [-X opt] -m pytest|unittest`, `python tests/runtests.py`, `python bin/test`, `python .venv/bin/pytest`. */
function pythonFamily(toks: readonly string[], i: number): Family | null {
  let j = i + 1;
  while (j < toks.length && toks[j]!.startsWith('-')) {
    const t = toks[j]!;
    if (t === '-m') {
      const mod = toks[j + 1];
      return mod === 'pytest' ? 'pytest' : mod === 'unittest' ? 'unittest' : null;
    }
    if (t === '-c') return null;
    j += t === '-X' || t === '-W' ? 2 : 1;
  }
  return scriptFamily(toks[j]);
}

function scriptFamily(tok: string | undefined): Family | null {
  if (tok === undefined) return null;
  const script = unquote(tok);
  const name = baseName(script);
  if (name === 'pytest' || name === 'py.test') return 'pytest';
  if (name === 'runtests.py') return 'django';
  if (/(^|\/)bin\/test$/.test(script)) return 'sympy';
  return null;
}

/** The runner family the command at `toks[i]` belongs to, or null (module comment, "Recognition"). */
function familyAt(toks: readonly string[], i: number): Family | null {
  const head = toks[i];
  if (head === undefined) return null;
  const name = baseName(head);
  const sub = (k: number): string | undefined => toks[skipOptions(toks, k)];
  if (/^python[0-9.]*$/.test(name) || name === 'py') return pythonFamily(toks, i);
  if (PY_PROJECT_RUNNERS.has(name) && toks[i + 1] === 'run') return familyAt(toks, skipOptions(toks, i + 2, PY_RUN_ARG_FLAGS));
  if (name === 'bundle' && toks[i + 1] === 'exec') return familyAt(toks, skipOptions(toks, i + 2));
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') return packageManagerFamily(name, toks, i);
  if (name === 'npx' || name === 'bunx') return jsRunnerAt(toks, skipOptions(toks, i + 1, NPX_ARG_FLAGS)) ? 'js' : null;
  if (jsRunnerAt(toks, i)) return 'js';
  const script = scriptFamily(head);
  if (script !== null) return script;
  switch (name) {
    case 'cargo': {
      const k = skipOptions(toks, toks[i + 1]?.startsWith('+') === true ? i + 2 : i + 1);
      return toks[k] === 'test' || toks[k] === 't' || (toks[k] === 'nextest' && toks[k + 1] === 'run') ? 'cargo' : null;
    }
    case 'go':
      return toks[skipOptions(toks, i + 1, new Set(['-C']))] === 'test' ? 'go' : null;
    case 'rspec':
      return 'rspec';
    case 'rake': {
      const task = sub(i + 1);
      return task === 'spec' ? 'rspec' : isTestScript(task) ? 'minitest' : null;
    }
    case 'rails': {
      const task = sub(i + 1);
      return task === 't' || isTestScript(task) ? 'minitest' : null;
    }
    case 'ruby': {
      const k = skipOptions(toks, i + 1, RUBY_ARG_FLAGS);
      return /(^|\/)(test_[^/]*|[^/]*_test)\.rb$/.test(unquote(toks[k] ?? '')) ? 'minitest' : null;
    }
    case 'mvn':
    case 'mvnw':
      return toks.slice(i + 1).includes('test') ? 'maven' : null;
    case 'gradle':
    case 'gradlew':
      return toks.slice(i + 1).some((t) => t === 'test' || /^:?(?:[\w.-]+:)+test$/.test(t)) ? 'gradle' : null;
    case 'dotnet':
      return sub(i + 1) === 'test' ? 'dotnet' : null;
    case 'mix':
      return sub(i + 1) === 'test' ? 'mix' : null;
    case 'swift':
      return sub(i + 1) === 'test' ? 'swift' : null;
    case 'deno': {
      const k = skipOptions(toks, i + 1);
      return toks[k] === 'test' || (toks[k] === 'task' && isTestScript(sub(k + 1))) ? 'deno' : null;
    }
    case 'composer': {
      const k = skipOptions(toks, i + 1, new Set(['-d', '--working-dir']));
      return isTestScript(toks[k]) || ((toks[k] === 'run' || toks[k] === 'run-script') && isTestScript(sub(k + 1))) ? 'php' : null;
    }
    case 'phpunit':
    case 'pest':
      return 'php';
    case 'php': {
      const k = skipOptions(toks, i + 1, new Set(['-d', '-c']));
      const script = baseName(toks[k] ?? '');
      return script === 'phpunit' || script === 'pest' || (script === 'artisan' && toks[k + 1] === 'test') ? 'php' : null;
    }
    case 'make':
    case 'gmake':
      for (let k = i + 1; k < toks.length; k += MAKE_ARG_FLAGS.has(toks[k]!) ? 2 : 1) if (toks[k] === 'test') return 'make';
      return null;
    default:
      return null;
  }
}

function familyOf(core: string): Family | null {
  return familyAt(core.split(' '), 0);
}

const SUBCOMMAND_LAUNCHERS: ReadonlySet<string> = new Set(['npm', 'yarn', 'pnpm', 'bun', 'cargo', 'go', 'make']);

/** The older rule, for a detected command outside every family: the same program (and subcommand, for a launcher). */
function sameProgram(c: string, t: string): boolean {
  const program = (s: string): string => {
    const toks = s.split(' ');
    if ((toks[0] === 'python' || toks[0] === 'python3') && toks[1] === '-m' && toks[2]) return toks[2];
    if (toks[0] === 'npx' && toks[1]) return toks[1];
    if (toks[0] && SUBCOMMAND_LAUNCHERS.has(toks[0]) && toks[1]) return `${toks[0]} ${toks[1]}`;
    return toks[0] ?? '';
  };
  const pc = program(c);
  return pc.length > 0 && pc === program(t);
}

/**
 * True when `command` runs the workspace's detected test command: the command itself, a scoped or extended form of it
 * (`pytest -q tests/x.py` for `pytest -q`), or another spelling of the same runner family (`npx vitest run a.test.ts`,
 * `node --test test/a.test.js` or `pnpm test` for a detected `npm test`; `uv run pytest` for `python3 -m pytest -q`),
 * after the wrappers of the module comment are dropped. A detected `make test` accepts any recognised family.
 */
export function isTestCommand(command: string, test: TestCommand | null): boolean {
  if (!test) return false;
  const c = testInvocation(command).core;
  const t = testInvocation(test.command).core;
  if (c === t || c.startsWith(`${t} `)) return true;
  const ft = familyOf(t);
  if (ft === null) return sameProgram(c, t);
  const fc = familyOf(c);
  return fc !== null && (fc === ft || ft === 'make');
}

/** shell composition would make "the test command" run something else as well; one plain invocation only */
const SHELL_COMPOSITION = /[;&|<>`$(){}\\\n]/;

/**
 * True when `command` is one plain invocation of the detected workspace test command or a scoped
 * form of it (`pytest -q tests/test_x.py::test_y`, `python3 -m pytest -q` for `pytest -q`): the same
 * predicate the execute stage uses to record `workspace.lastTestRun`, minus any shell composition
 * (a pipe, `&&`, `||`, a redirect, a substitution), so a composed line is never a verification run.
 */
export function isVerificationRun(command: string, test: TestCommand | null): boolean {
  if (test === null || SHELL_COMPOSITION.test(command)) return false;
  return isTestCommand(command, test);
}

// ---------------------------------------------------------------------------------------
// Scoping a command to a subset (test files, node ids, runner labels)
// ---------------------------------------------------------------------------------------

/** POSIX single-quote quoting for `sh -c`. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const SAFE_ARG = /^[A-Za-z0-9_.\/:=@%+-]+$/;
function quoteArg(s: string): string {
  return SAFE_ARG.test(s) ? s : shellQuote(s);
}

function uniq(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}

function looksLikePath(t: string): boolean {
  return t.includes('/') || t.endsWith('.py');
}

const UNITTEST_ID = /^(\w+) \(([\w.]+)\)$/;

/** `test_x (a.b.C)` → `a.b.C.test_x`; `test_x (a.b.C.test_x)` (Python ≥ 3.11) → `a.b.C.test_x`; null for anything else. */
export function unittestLabel(id: string): string | null {
  const m = UNITTEST_ID.exec(id.trim());
  if (m === null) return null;
  const name = m[1] ?? '';
  const qual = m[2] ?? '';
  return qual.endsWith(`.${name}`) ? qual : `${qual}.${name}`;
}

/** A Python file path as a dotted module: `tests/decorators/tests.py` → `tests.decorators.tests`, `pkg/__init__.py` → `pkg`. */
export function moduleOfPath(path: string): string {
  let p = path.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  if (p.endsWith('.py')) p = p.slice(0, -3);
  if (p.endsWith('/__init__')) p = p.slice(0, -'/__init__'.length);
  if (p === '__init__') p = '';
  return p
    .split('/')
    .filter((s) => s !== '' && s !== '.')
    .join('.');
}

/**
 * A Django `runtests.py` label: a test path relative to the tests dir (`tests/decorators/tests.py`
 * → `decorators.tests`), a pytest node id (`tests/decorators/tests.py::DecoratorsTest::test_attributes`
 * → `decorators.tests.DecoratorsTest.test_attributes`), a unittest id (`test_attributes
 * (decorators.tests.DecoratorsTest)`) or an already dotted label, which passes through.
 */
export function djangoLabel(target: string, testsDir = 'tests'): string {
  const t = target.trim();
  const fromUnittest = unittestLabel(t);
  if (fromUnittest !== null) return fromUnittest;
  const [head = '', ...rest] = t.split('::');
  let base = head;
  if (looksLikePath(base)) {
    let p = base.replace(/^\.\//, '');
    if (p === testsDir || p === `${testsDir}/`) p = '';
    else if (p.startsWith(`${testsDir}/`)) p = p.slice(testsDir.length + 1);
    base = moduleOfPath(p);
  }
  return [base, ...rest].filter((s) => s !== '').join('.');
}

/** A `python -m unittest` label: a module path (`tests/test_x.py` → `tests.test_x`), a node id, a unittest id or a dotted label. */
export function unittestModuleLabel(target: string): string {
  const t = target.trim();
  const fromUnittest = unittestLabel(t);
  if (fromUnittest !== null) return fromUnittest;
  const [head = '', ...rest] = t.split('::');
  const base = looksLikePath(head) ? moduleOfPath(head) : head;
  return [base, ...rest].filter((s) => s !== '').join('.');
}

/** A sympy `bin/test` target: `path.py:test_x` (the runner's own header form) or `path.py::test_x` → path + name; a path; a bare test name. */
export function sympyTarget(target: string): { path: string | null; name: string | null } {
  const t = target.trim();
  const parts = t.split('::');
  if (parts.length > 1) return { path: parts[0] === '' ? null : (parts[0] ?? null), name: parts[parts.length - 1] ?? null };
  const at = t.indexOf('.py:');
  if (at !== -1) return { path: t.slice(0, at + 3), name: t.slice(at + 4) === '' ? null : t.slice(at + 4) };
  return looksLikePath(t) ? { path: t, name: null } : { path: null, name: t === '' ? null : t };
}

/** pytest: file paths and node ids appended as they are. */
export function pytestScope(command: string): ScopeBuilder {
  return (targets) => {
    const args = uniq(targets.map((t) => t.trim()).filter((t) => t !== ''));
    return args.length === 0 ? command : `${command} ${args.map(quoteArg).join(' ')}`;
  };
}

/** Django: dotted labels relative to the tests dir (`decorators.tests`, `decorators.tests.DecoratorsTest.test_attributes`). */
export function djangoScope(command: string): ScopeBuilder {
  return (targets) => {
    const labels = uniq(targets.map((t) => djangoLabel(t)).filter((l) => l !== ''));
    return labels.length === 0 ? command : `${command} ${labels.map(quoteArg).join(' ')}`;
  };
}

/** sympy: test file paths, then `-k <names>` for any test names among the targets (`-k` must come last: it swallows the following arguments). */
export function sympyScope(command: string): ScopeBuilder {
  return (targets) => {
    const paths: string[] = [];
    const names: string[] = [];
    for (const t of targets) {
      const s = sympyTarget(t);
      if (s.path !== null) paths.push(s.path);
      if (s.name !== null) names.push(s.name);
    }
    if (paths.length === 0 && names.length === 0) return command;
    const parts = [command, ...uniq(paths).map(quoteArg)];
    if (names.length > 0) parts.push('-k', ...uniq(names).map(quoteArg));
    return parts.join(' ');
  };
}

/** unittest: `python -m unittest -v <module or dotted labels>` (discovery is replaced by the explicit names). */
export function unittestScope(command: string): ScopeBuilder {
  const py = command.trim().split(/\s+/)[0] ?? 'python3';
  return (targets) => {
    const labels = uniq(targets.map((t) => unittestModuleLabel(t)).filter((l) => l !== ''));
    return labels.length === 0 ? command : `${py} -m unittest -v ${labels.map(quoteArg).join(' ')}`;
  };
}

/**
 * A test name for `-t` / `-run`: the last `::`-separated segment of a node id, with a pytest
 * parametrisation suffix (`test_a[0-x]`) dropped — the id of one case is not a filter pattern.
 */
function testNameOf(target: string): string {
  const t = target.trim();
  const last = t.split('::').pop() ?? '';
  const at = last.indexOf('[');
  return (at === -1 ? last : last.slice(0, at)).trim();
}

/** A JS test path (`src/a.test.ts`, `src/a.test.ts::renders`) → the file part; '' when the target is a bare name. */
function jsFileOf(target: string): string {
  const head = (target.trim().split('::')[0] ?? '').trim();
  return looksLikeJsPath(head) ? head : '';
}

function looksLikeJsPath(t: string): boolean {
  return t.includes('/') || /\.(m|c)?(j|t)sx?$/.test(t);
}

/**
 * Append runner arguments to a command. A package-manager wrapper (`npm test`, `pnpm test`)
 * swallows everything after the script name unless it is preceded by `--`, so a scope appended
 * without it silently runs the whole suite — exactly the failure mode the scope-usability guard
 * exists to catch, and cheaper to avoid here.
 */
function appendRunnerArgs(command: string, args: readonly string[]): string {
  if (args.length === 0) return command;
  const head = command.trim().split(/\s+/)[0] ?? '';
  const needsSeparator = (head === 'npm' || head === 'pnpm') && !/\s--(\s|$)/.test(command);
  return `${command}${needsSeparator ? ' --' : ''} ${args.join(' ')}`;
}

/**
 * jest: file paths are regexes matched against the full path (`jest <pattern>`), test names go
 * through `-t`. Paths are passed as literal fragments — `jest` treats the positional argument as
 * a regex, so the metacharacters of a real path (`.`) are escaped.
 */
export function jestScope(command: string): ScopeBuilder {
  return (targets) => {
    const paths: string[] = [];
    const names: string[] = [];
    for (const t of targets) {
      const f = jsFileOf(t);
      if (f !== '') paths.push(f.replace(/[.+*?^$()[\]{}|\\]/g, '\\$&'));
      const n = t.includes('::') || f === '' ? testNameOf(t) : '';
      if (n !== '') names.push(n);
    }
    if (paths.length === 0 && names.length === 0) return command;
    const args = [...uniq(paths).map(quoteArg)];
    for (const n of uniq(names)) args.push('-t', quoteArg(n));
    return appendRunnerArgs(command, args);
  };
}

/** vitest: file paths are substring filters, test names go through `-t` (the same shape as jest, without the regex escaping). */
export function vitestScope(command: string): ScopeBuilder {
  return (targets) => {
    const paths: string[] = [];
    const names: string[] = [];
    for (const t of targets) {
      const f = jsFileOf(t);
      if (f !== '') paths.push(f);
      const n = t.includes('::') || f === '' ? testNameOf(t) : '';
      if (n !== '') names.push(n);
    }
    if (paths.length === 0 && names.length === 0) return command;
    const args = [...uniq(paths).map(quoteArg)];
    for (const n of uniq(names)) args.push('-t', quoteArg(n));
    return appendRunnerArgs(command, args);
  };
}

/**
 * cargo: `cargo test <TESTNAME>` takes exactly ONE filter, matched as a substring of the test
 * path (`module::test_name`), so a Rust path target is turned into its module path and a name
 * target passes through. Two or more targets cannot be expressed — `cargo test a b` is a usage
 * error, not a union — so the command is returned unscoped and the whole suite runs: a scope
 * that cannot be built is one extra run, a scope built wrongly is a silent zero-test pass
 * (R-14). `--` is never appended: everything here is a cargo-level filter.
 */
export function cargoScope(command: string): ScopeBuilder {
  return (targets) => {
    const filters: string[] = [];
    for (const t of targets) {
      const s = t.trim();
      if (s === '') continue;
      const head = s.split('::')[0] ?? '';
      if (/\.rs$/.test(head) || head.includes('/')) {
        const mod = head
          .replace(/\.rs$/, '')
          .replace(/^(\.\/)?(src|tests|benches)\//, '')
          .split('/')
          .filter((p) => p !== '' && p !== 'mod' && p !== 'lib' && p !== 'main')
          .join('::');
        const rest = s.split('::').slice(1).join('::');
        const full = [mod, rest].filter((p) => p !== '').join('::');
        if (full !== '') filters.push(full);
      } else {
        filters.push(s);
      }
    }
    const one = uniq(filters);
    return one.length === 1 ? appendRunnerArgs(command, one.map(quoteArg)) : command;
  };
}

/**
 * go: packages are directories (`./pkg/...`), test names go through one alternation `-run`
 * pattern. The package list replaces the command's own `./...` when the targets name packages.
 */
export function goScope(command: string): ScopeBuilder {
  const base = command.replace(/\s+\.\/\.\.\.\s*$/, '').trim();
  return (targets) => {
    const pkgs: string[] = [];
    const names: string[] = [];
    for (const t of targets) {
      const s = t.trim();
      if (s === '') continue;
      const head = s.split('::')[0] ?? '';
      if (/\.go$/.test(head) || head.includes('/')) {
        const dir = /\.go$/.test(head) ? head.slice(0, Math.max(0, head.lastIndexOf('/'))) : head.replace(/\/+$/, '');
        pkgs.push(dir === '' ? '.' : dir.startsWith('.') ? dir : `./${dir}`);
      }
      const n = s.includes('::') || !looksLikeGoPath(head) ? testNameOf(s) : '';
      if (n !== '') names.push(n);
    }
    if (pkgs.length === 0 && names.length === 0) return command;
    const args = uniq(pkgs).length === 0 ? ['./...'] : uniq(pkgs).map(quoteArg);
    if (names.length > 0) args.push('-run', quoteArg(`^(${uniq(names).join('|')})$`));
    return appendRunnerArgs(base, args);
  };
}

function looksLikeGoPath(t: string): boolean {
  return t.includes('/') || /\.go$/.test(t);
}

/** The scope builder for a runner, or null when the runner cannot run a subset by name. */
export function scopeBuilderFor(runner: TestRunner, command: string): ScopeBuilder | null {
  switch (runner) {
    case 'pytest':
      return pytestScope(command);
    case 'django':
      return djangoScope(command);
    case 'sympy_bintest':
      return sympyScope(command);
    case 'unittest':
      return unittestScope(command);
    case 'jest':
      return jestScope(command);
    case 'vitest':
      return vitestScope(command);
    case 'cargo':
      return cargoScope(command);
    case 'go':
      return goScope(command);
    default:
      return null;
  }
}

/**
 * The scope-usability guard (docs/HARNESS-NEXT-DESIGN.md §6 S1, risks R-11 and R-14). A scoped
 * run is evidence only when it reported a non-zero collected/total count: a wrong scope string
 * runs zero tests on every runner here, and "0 failing" then reads as success. Zero collected
 * means the scope is unusable, and the caller must fall back to the full suite and record
 * `scope_unusable` — never treat the empty run as a pass.
 *
 * `summarize()` synthesises a `<test run>` failure (`errors += 1`) for any non-zero exit with no
 * parsed failure — which is exactly what jest, cargo and go print for a filter that matched
 * nothing. Counting it would make every wrong scope on those runners read as "usable", i.e.
 * would make this guard silently do nothing on the four runners R-14 is about; so it is
 * subtracted out here rather than in each caller.
 */
export function scopeUsable(counts: (TestCounts & { failing?: readonly string[] }) | null): boolean {
  if (counts === null) return false;
  const synthetic = counts.failing !== undefined && counts.failing.includes(RUN_FAILURE_ID) ? 1 : 0;
  return counts.passed + counts.failed + Math.max(0, counts.errors - synthetic) + counts.skipped > 0;
}

// ---------------------------------------------------------------------------------------
// Summary parsers (counts for the judge state)
// ---------------------------------------------------------------------------------------

const TAIL_CHARS = 16 * 1024;

function tail(output: string): string {
  return output.length > TAIL_CHARS ? output.slice(output.length - TAIL_CHARS) : output;
}

function lastMatch(text: string, re: RegExp): RegExpExecArray | null {
  let last: RegExpExecArray | null = null;
  for (const m of text.matchAll(re)) last = m;
  return last;
}

function num(s: string | undefined): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Fallback for `pytest -qq` (e.g. `-q` on the command line on top of `addopts = -q`), which
 * prints no summary line at all: count the progress characters of lines such as
 * `tests/test_a.py ..F.s  [ 71%]` or `.......  [100%]` (`.` pass, `F` fail, `E` error,
 * `s`/`x` skipped or xfail, `X` xpass).
 */
export function parsePytestProgress(text: string): TestCounts | null {
  const counts: TestCounts = { passed: 0, failed: 0, errors: 0, skipped: 0 };
  let seen = false;
  for (const line of text.split('\n')) {
    const pm = /^(?:\S+\s+)?([.FEsxX]+)\s+\[\s*\d+%\]\s*$/.exec(line.trimEnd());
    if (!pm) continue;
    seen = true;
    for (const ch of pm[1]!) {
      if (ch === '.' || ch === 'X') counts.passed += 1;
      else if (ch === 'F') counts.failed += 1;
      else if (ch === 'E') counts.errors += 1;
      else counts.skipped += 1;
    }
  }
  return seen ? counts : null;
}

/** `===== 3 passed, 1 failed, 2 errors, 1 skipped in 0.12s =====` (any subset, any order). */
export function parsePytest(text: string): TestCounts | null {
  const m = lastMatch(text, /^[=\s]*((?:\d+ [a-z]+(?:, )?)+) in \d+(?:\.\d+)?s(?: \([^)]*\))?[=\s]*$/gm);
  if (!m) {
    if (/^[=\s]*no tests ran in \d+(?:\.\d+)?s/m.test(text)) return { passed: 0, failed: 0, errors: 0, skipped: 0 };
    return parsePytestProgress(text);
  }
  const counts: TestCounts = { passed: 0, failed: 0, errors: 0, skipped: 0 };
  let seen = false;
  for (const part of m[1]!.split(', ')) {
    const pm = /^(\d+) ([a-z]+)$/.exec(part.trim());
    if (!pm) continue;
    const n = num(pm[1]);
    switch (pm[2]) {
      case 'passed':
        counts.passed += n;
        seen = true;
        break;
      case 'failed':
        counts.failed += n;
        seen = true;
        break;
      case 'error':
      case 'errors':
        counts.errors += n;
        seen = true;
        break;
      case 'skipped':
      case 'deselected':
        counts.skipped += n;
        seen = true;
        break;
      case 'xfailed':
        counts.skipped += n;
        seen = true;
        break;
      case 'xpassed':
        counts.passed += n;
        seen = true;
        break;
      default:
        break; // warnings, rerun, etc.
    }
  }
  return seen ? counts : null;
}

const UNITTEST_RAN = /^Ran (\d+) tests? in [\d.]+s\s*$/gm;
const UNITTEST_RESULT = /^(OK|FAILED)(?: \(([^)]*)\))?\s*$/m;
const UNITTEST_STATUS_SUFFIX = / \.\.\. (ok|OK|FAIL|ERROR|skipped\b.*|expected failure|unexpected success)\s*$/;

/** `failures=2, errors=1, skipped=1, expected failures=1, unexpected successes=1` → numbers by key. */
function unittestFields(s: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of s.matchAll(/([a-z ]+?)=(\d+)/g)) out[(m[1] ?? '').trim()] = num(m[2]);
  return out;
}

/**
 * unittest's TextTestRunner (also Django's `tests/runtests.py`): `Ran 23 tests in 0.012s` then
 * `OK`, `OK (skipped=1)` or `FAILED (failures=1, errors=1, skipped=1, expected failures=1,
 * unexpected successes=1)`. Expected failures count as skipped and unexpected successes as failed
 * (the run exits 1 on them). Without the summary (a killed run) the verbose ` ... ok` lines are counted.
 */
export function parseUnittest(text: string): TestCounts | null {
  const ran = lastMatch(text, UNITTEST_RAN);
  if (ran !== null) {
    const total = num(ran[1]);
    const res = UNITTEST_RESULT.exec(text.slice(ran.index + ran[0].length));
    const f = unittestFields(res?.[2] ?? '');
    const failed = (f['failures'] ?? 0) + (f['unexpected successes'] ?? 0);
    const errors = f['errors'] ?? 0;
    const skipped = (f['skipped'] ?? 0) + (f['expected failures'] ?? 0);
    return { passed: Math.max(0, total - failed - errors - skipped), failed, errors, skipped };
  }
  const counts: TestCounts = { passed: 0, failed: 0, errors: 0, skipped: 0 };
  let seen = false;
  let pending = false;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const m = UNITTEST_STATUS_SUFFIX.exec(line);
    const status = m !== null ? (m[1] ?? '') : pending && /^(ok|OK|FAIL|ERROR)$/.test(line.trim()) ? line.trim() : null;
    pending = m === null && /^\w+ \([\w.]+\)/.test(line);
    if (status === null) continue;
    seen = true;
    if (status === 'ok' || status === 'OK') counts.passed += 1;
    else if (status === 'FAIL' || status === 'unexpected success') counts.failed += 1;
    else if (status === 'ERROR') counts.errors += 1;
    else counts.skipped += 1;
  }
  return seen ? counts : null;
}

/** Django's runner is unittest's TextTestRunner; the summary lines are the same. */
export const parseDjango: (text: string) => TestCounts | null = parseUnittest;

const ANSI = /\u001b\[[0-9;]*m/g;
const SYMPY_ITEM = /(\d+) (passed|failed|skipped|expected to fail but passed|expected to fail|exceptions)/g;
const SYMPY_STATUS_CHARS = /^([.FEswTKfX]+)\s*(?:\[(?:OK|FAIL)\])?\s*$/;
const SYMPY_FILE_LINE = /^(\S+\.py)\[(?:\d+|\?)\]\s*(.*)$/;
const SYMPY_VERBOSE_LINE = /^(test\w*)\s+(?:.*?\s+)?(ok|F|E|s|w|T|K|f|X)\s*(?:\[(?:OK|FAIL)\])?\s*$/;

function sympyCountChar(counts: TestCounts, ch: string): void {
  if (ch === '.' || ch === 'X' || ch === 'ok') counts.passed += 1;
  else if (ch === 'F') counts.failed += 1;
  else if (ch === 'E') counts.errors += 1;
  else counts.skipped += 1; // s, w (slow), T (timeout), K (interrupt), f (xfail)
}

/**
 * sympy's `bin/test`: `tests finished: 90 passed, 1 failed, 2 skipped, 1 expected to fail,
 * 1 expected to fail but passed, 1 exceptions, in 5.61 seconds` (the line wraps at the terminal
 * width, so it is read up to `seconds`). Exceptions are errors, expected failures are skipped,
 * unexpected passes are passed. Without the summary the status characters after each
 * `path.py[N]` (quiet) or the `test_x ok|F|E|…` lines (--verbose) are counted; only when the
 * `test process starts` banner is present, so ordinary text never reads as sympy tests.
 */
export function parseSympyBinTest(text: string): TestCounts | null {
  const clean = text.replace(ANSI, '');
  const at = clean.lastIndexOf('tests finished:');
  if (at !== -1) {
    const end = clean.indexOf('seconds', at);
    const summary = (end === -1 ? clean.slice(at) : clean.slice(at, end)).replace(/[=\n]/g, ' ');
    const counts: TestCounts = { passed: 0, failed: 0, errors: 0, skipped: 0 };
    let seen = false;
    for (const m of summary.matchAll(SYMPY_ITEM)) {
      seen = true;
      const n = num(m[1]);
      switch (m[2]) {
        case 'passed':
        case 'expected to fail but passed':
          counts.passed += n;
          break;
        case 'failed':
          counts.failed += n;
          break;
        case 'exceptions':
          counts.errors += n;
          break;
        default:
          counts.skipped += n; // skipped, expected to fail
      }
    }
    if (seen) return counts;
  }
  if (!clean.includes('test process starts')) return null;
  const counts: TestCounts = { passed: 0, failed: 0, errors: 0, skipped: 0 };
  let seen = false;
  let inFile = false;
  for (const raw of clean.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('____') || line.includes('tests finished:')) break;
    const f = SYMPY_FILE_LINE.exec(line);
    if (f !== null) {
      inFile = true;
      const rest = (f[2] ?? '').replace(/\s*\[(?:OK|FAIL)\]\s*$/, '').trim();
      if (rest !== '' && /^[.FEswTKfX]+$/.test(rest)) {
        seen = true;
        for (const ch of rest) sympyCountChar(counts, ch);
      }
      continue;
    }
    if (!inFile) continue;
    const v = SYMPY_VERBOSE_LINE.exec(line);
    if (v !== null) {
      seen = true;
      sympyCountChar(counts, v[2] ?? '');
      continue;
    }
    const c = SYMPY_STATUS_CHARS.exec(line);
    if (c !== null) {
      seen = true;
      for (const ch of c[1] ?? '') sympyCountChar(counts, ch);
    }
  }
  return seen ? counts : null;
}

/** `Tests:       1 failed, 2 passed, 3 total` */
export function parseJest(text: string): TestCounts | null {
  const m = lastMatch(text, /^Tests:\s+(.+?),\s*(\d+) total\s*$/gm);
  if (!m) return null;
  const counts: TestCounts = { passed: 0, failed: 0, errors: 0, skipped: 0 };
  for (const part of m[1]!.split(',')) {
    const pm = /(\d+) (failed|passed|skipped|todo|pending)/.exec(part);
    if (!pm) continue;
    const n = num(pm[1]);
    if (pm[2] === 'failed') counts.failed += n;
    else if (pm[2] === 'passed') counts.passed += n;
    else counts.skipped += n;
  }
  return counts;
}

/** ` Tests  1 failed | 2 passed | 1 skipped (4)` */
export function parseVitest(text: string): TestCounts | null {
  const m = lastMatch(text, /^\s*Tests\s{2,}(.+?)\s*\((\d+)\)\s*$/gm);
  if (!m) return null;
  const counts: TestCounts = { passed: 0, failed: 0, errors: 0, skipped: 0 };
  for (const part of m[1]!.split('|')) {
    const pm = /(\d+) (failed|passed|skipped|todo)/.exec(part);
    if (!pm) continue;
    const n = num(pm[1]);
    if (pm[2] === 'failed') counts.failed += n;
    else if (pm[2] === 'passed') counts.passed += n;
    else counts.skipped += n;
  }
  return counts;
}

/** `test result: ok. 5 passed; 0 failed; 1 ignored; ...` summed over every test binary. */
export function parseCargo(text: string): TestCounts | null {
  const counts: TestCounts = { passed: 0, failed: 0, errors: 0, skipped: 0 };
  let seen = false;
  for (const m of text.matchAll(/^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/gm)) {
    seen = true;
    counts.passed += num(m[1]);
    counts.failed += num(m[2]);
    counts.skipped += num(m[3]);
  }
  return seen ? counts : null;
}

/** `--- PASS:` / `--- FAIL:` / `--- SKIP:` lines from `go test -v`. */
export function parseGo(text: string): TestCounts | null {
  const counts: TestCounts = { passed: 0, failed: 0, errors: 0, skipped: 0 };
  let seen = false;
  for (const m of text.matchAll(/^\s*--- (PASS|FAIL|SKIP): /gm)) {
    seen = true;
    if (m[1] === 'PASS') counts.passed++;
    else if (m[1] === 'FAIL') counts.failed++;
    else counts.skipped++;
  }
  return seen ? counts : null;
}

/** One summary row of `node --test`: the TAP reporter's `# pass 3` or the spec reporter's `ℹ pass 3`. */
const NODE_TEST_SUMMARY = /^(?:#|ℹ) (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) (\d+(?:\.\d+)?)\s*$/gm;

/**
 * docs/AGENT-LOOP-DESIGN.md §15 S4: `node --test` — the TAP summary (`# pass 1`, `# fail 1`, … piped, the Node 22 default
 * when stdout is not a TTY) and the spec summary (`ℹ pass 1`, `ℹ fail 1`, … `--test-reporter=spec` or a TTY). A
 * `"test": "node --test"` script is detected as `npm test` with runner `npm`, so without this its output parsed to nothing and
 * no run of such a workspace could ever be `complete`. Both `pass` and `fail` rows are required (a stray `# pass` line in
 * other output is not a summary). Each row is summed over every summary in the output: `npm test --workspaces` prints one
 * per workspace. `cancelled` tests count as errors (a timeout or a cancelled parent), `skipped` and `todo` as skipped.
 */
export function parseNodeTest(text: string): TestCounts | null {
  const rows = new Map<string, number>();
  for (const m of text.replace(ANSI, '').matchAll(NODE_TEST_SUMMARY)) rows.set(m[1]!, (rows.get(m[1]!) ?? 0) + num(m[2]));
  const pass = rows.get('pass');
  const fail = rows.get('fail');
  if (pass === undefined || fail === undefined) return null;
  return { passed: pass, failed: fail, errors: rows.get('cancelled') ?? 0, skipped: (rows.get('skipped') ?? 0) + (rows.get('todo') ?? 0) };
}

const tally = (passed: number, failed: number, errors: number, skipped: number): TestCounts => ({ passed: Math.max(0, passed), failed, errors, skipped });

/** RSpec: `3 examples, 1 failure, 1 pending` and `0 examples, 0 failures, 1 error occurred outside of examples`. */
export function parseRspec(text: string): TestCounts | null {
  const m = lastMatch(text.replace(ANSI, ''), /^\s*(\d+) examples?, (\d+) failures?(?:, (\d+) pending)?(?:, (\d+) errors? occurred outside of examples)?\s*$/gm);
  if (m === null) return null;
  const failed = num(m[2]);
  const pending = num(m[3]);
  return tally(num(m[1]) - failed - pending, failed, num(m[4]), pending);
}

/** Minitest `4 runs, 2 assertions, 1 failures, 1 errors, 1 skips`; test-unit `3 tests, 2 assertions, 1 failures, 0 errors, 0 pendings, 1 omissions, …`. */
export function parseMinitest(text: string): TestCounts | null {
  const m = lastMatch(text.replace(ANSI, ''), /^\s*(\d+) (?:runs?|tests?), \d+ assertions?, (\d+) failures?, (\d+) errors?, (?:(\d+) skips?|(\d+) pendings?, (\d+) omissions?)/gm);
  if (m === null) return null;
  const failed = num(m[2]);
  const errors = num(m[3]);
  const skipped = num(m[4]) + num(m[5]) + num(m[6]);
  return tally(num(m[1]) - failed - errors - skipped, failed, errors, skipped);
}

const SUREFIRE = /Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)(.*)$/gm;

/**
 * Maven Surefire / Failsafe: the `Results:` totals line `Tests run: 3, Failures: 1, Errors: 0, Skipped: 0`, summed over
 * the modules of a reactor build (one totals line each); the per-class lines (`…, Time elapsed: 0.05 s - in a.BTest`)
 * are counted only when no totals line survived (a killed build).
 */
export function parseMaven(text: string): TestCounts | null {
  const all = [...text.replace(ANSI, '').matchAll(SUREFIRE)];
  const totals = all.filter((m) => !/Time elapsed/.test(m[5] ?? ''));
  const rows = totals.length > 0 ? totals : all;
  if (rows.length === 0) return null;
  let run = 0;
  let failed = 0;
  let errors = 0;
  let skipped = 0;
  for (const m of rows) {
    run += num(m[1]);
    failed += num(m[2]);
    errors += num(m[3]);
    skipped += num(m[4]);
  }
  return tally(run - failed - errors - skipped, failed, errors, skipped);
}

/** Gradle prints counts only when tests fail: `3 tests completed, 1 failed, 1 skipped`, one line per failing test task. */
export function parseGradle(text: string): TestCounts | null {
  let seen = false;
  let done = 0;
  let failed = 0;
  let skipped = 0;
  for (const m of text.replace(ANSI, '').matchAll(/^\s*(\d+) tests? completed(?:, (\d+) failed)?(?:, (\d+) skipped)?\s*$/gm)) {
    seen = true;
    done += num(m[1]);
    failed += num(m[2]);
    skipped += num(m[3]);
  }
  return seen ? tally(done - failed - skipped, failed, 0, skipped) : null;
}

/**
 * `dotnet test`: `Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3, Duration: 15 ms - A.Tests.dll (net8.0)`
 * (or `Failed!  - …`), summed over the test projects; the terminal logger's `Test summary: total: 3, failed: 0,
 * succeeded: 3, skipped: 0` when that is all there is.
 */
export function parseDotnet(text: string): TestCounts | null {
  const clean = text.replace(ANSI, '');
  let seen = false;
  const c = tally(0, 0, 0, 0);
  for (const m of clean.matchAll(/(?:Passed|Failed)!\s+-\s+Failed:\s+(\d+),\s+Passed:\s+(\d+),\s+Skipped:\s+(\d+),\s+Total:\s+(\d+)/g)) {
    seen = true;
    c.failed += num(m[1]);
    c.passed += num(m[2]);
    c.skipped += num(m[3]);
  }
  if (seen) return c;
  const s = lastMatch(clean, /Test summary: total: (\d+), failed: (\d+), succeeded: (\d+), skipped: (\d+)/g);
  return s === null ? null : tally(num(s[3]), num(s[2]), 0, num(s[4]));
}

/**
 * ExUnit (`mix test`): `1 doctest, 3 tests, 1 failure, 2 excluded, 1 invalid, 1 skipped`. Every counted kind (doctests,
 * properties, tests) is a test; excluded and skipped tests are skipped, invalid ones (a failed setup_all) errors.
 */
export function parseExUnit(text: string): TestCounts | null {
  const m = lastMatch(text.replace(ANSI, ''), /^\s*((?:\d+ (?:doctests?|propert(?:y|ies)|tests?|features?), )+)(\d+) failures?((?:, \d+ (?:excluded|invalid|skipped))*)\s*$/gm);
  if (m === null) return null;
  let total = 0;
  for (const k of (m[1] ?? '').matchAll(/(\d+) /g)) total += num(k[1]);
  const extra = (kind: string): number => num(new RegExp(`(\\d+) ${kind}`).exec(m[3] ?? '')?.[1]);
  const failed = num(m[2]);
  const skipped = extra('excluded') + extra('skipped');
  const errors = extra('invalid');
  return tally(total - failed - skipped - errors, failed, errors, skipped);
}

/**
 * PHPUnit `OK (3 tests, 5 assertions)` or `Tests: 3, Assertions: 3, Errors: 1, Failures: 1, Skipped: 1.` (after
 * `FAILURES!`, `ERRORS!` or `OK, but …`); Pest / `php artisan test` `Tests:    1 failed, 2 passed (3 assertions)`.
 * Skipped and incomplete tests are skipped; risky tests, warnings and deprecations passed.
 */
export function parsePhpunit(text: string): TestCounts | null {
  const clean = text.replace(ANSI, '');
  const ok = lastMatch(clean, /^\s*OK \((\d+) tests?, \d+ assertions?\)\s*$/gm);
  const fields = lastMatch(clean, /^\s*Tests: (\d+), Assertions: \d+((?:, [A-Za-z ]+: \d+)*)\.?\s*$/gm);
  const pest = lastMatch(clean, /^\s*Tests:\s+((?:\d+ [a-z]+(?:, )?)+?)\s*(?:\(\d+ assertions?\))?\s*$/gm);
  const latest = [ok, fields, pest].filter((m): m is RegExpExecArray => m !== null).sort((a, b) => b.index - a.index)[0];
  if (latest === undefined) return null;
  if (latest === ok) return tally(num(ok[1]), 0, 0, 0);
  if (latest === fields) {
    const f = (name: string): number => num(new RegExp(`${name}: (\\d+)`).exec(fields[2] ?? '')?.[1]);
    const failed = f('Failures');
    const errors = f('Errors');
    const skipped = f('Skipped') + f('Incomplete');
    return tally(num(fields[1]) - failed - errors - skipped, failed, errors, skipped);
  }
  const c = tally(0, 0, 0, 0);
  for (const part of (latest[1] ?? '').matchAll(/(\d+) ([a-z]+)/g)) {
    const n = num(part[1]);
    if (part[2] === 'failed') c.failed += n;
    else if (part[2] === 'skipped' || part[2] === 'incomplete' || part[2] === 'todo' || part[2] === 'todos') c.skipped += n;
    else c.passed += n; // passed, risky, warnings, deprecated, notices
  }
  return c;
}

/** Deno: `ok | 3 passed (2 steps) | 0 failed | 1 ignored (15ms)` or `FAILED | 2 passed | 1 failed (20ms)`. */
export function parseDeno(text: string): TestCounts | null {
  const m = lastMatch(text.replace(ANSI, ''), /^(?:ok|FAILED) \| (\d+) passed(?: \(\d+ steps?\))? \| (\d+) failed(?: \(\d+ steps?\))?((?: \| \d+ [a-z ]+?)*)(?: \([^)]*\))?\s*$/gm);
  if (m === null) return null;
  return tally(num(m[1]), num(m[2]), 0, num(/(\d+) ignored/.exec(m[3] ?? '')?.[1]));
}

/** Mocha: `3 passing (8ms)`, then `1 pending` and `2 failing` on the lines that follow it. */
export function parseMocha(text: string): TestCounts | null {
  const clean = text.replace(ANSI, '');
  const m = lastMatch(clean, /^\s*(\d+) passing \([^)]*\)\s*$/gm);
  if (m === null) return null;
  const after = clean.slice(m.index + m[0].length).split('\n').slice(0, 4).join('\n');
  return tally(num(m[1]), num(/^\s*(\d+) failing\s*$/m.exec(after)?.[1]), 0, num(/^\s*(\d+) pending\s*$/m.exec(after)?.[1]));
}

/** Bun's runner: ` 3 pass`, ` 1 fail`, ` 1 skip`, ` 1 todo`, ` 1 error` rows just above `Ran 5 tests across 2 files.`. */
export function parseBun(text: string): TestCounts | null {
  const clean = text.replace(ANSI, '');
  const ran = lastMatch(clean, /^Ran \d+ tests? across \d+ files?\./gm);
  if (ran === null) return null;
  const rows = clean.slice(0, ran.index).split('\n').slice(-10).join('\n');
  const row = (kind: string): number => num(new RegExp(`^\\s*(\\d+) ${kind}\\s*$`, 'm').exec(rows)?.[1]);
  return tally(row('pass'), row('fail'), row('errors?'), row('skip') + row('todo'));
}

/**
 * `swift test`: XCTest's last `Executed 5 tests, with 1 test skipped and 2 failures (0 unexpected) in …` (the `All tests`
 * suite) plus swift-testing's `Test run with 3 tests passed after 0.001 seconds.` / `… failed after … with 2 issues.`
 * Both count assertion failures or issues, not failing tests, so a test's failures are capped at the tests run.
 */
export function parseSwift(text: string): TestCounts | null {
  const clean = text.replace(ANSI, '');
  const x = lastMatch(clean, /Executed (\d+) tests?, with (?:(\d+) tests? skipped and )?(\d+) failures? \(\d+ unexpected\)/g);
  const st = lastMatch(clean, /Test run with (\d+) tests?(?: in \d+ suites?)? (passed|failed) after [\d.]+ seconds?(?: with (\d+) issues?)?/g);
  if (x === null && st === null) return null;
  const c = tally(0, 0, 0, 0);
  if (x !== null) {
    const ran = num(x[1]) - num(x[2]);
    const failed = Math.min(num(x[3]), Math.max(0, ran));
    c.passed += Math.max(0, ran - failed);
    c.failed += failed;
    c.skipped += num(x[2]);
  }
  if (st !== null) {
    const total = num(st[1]);
    const failed = st[2] === 'failed' ? Math.min(Math.max(1, num(st[3])), total) : 0;
    c.passed += total - failed;
    c.failed += failed;
  }
  return c;
}

// The list is tried in order and the first reader wins, so a reader appended after the others only adds counts where no
// other format matched — the legacy modes gain facts, never different ones (docs/AGENT-LOOP-DESIGN.md §15 S4). parseNodeTest
// joined last in S4; the readers after it cover the ecosystems detection learned later (Ruby, JVM, .NET, Elixir, PHP, Deno,
// mocha, Bun, Swift).
const ALL_PARSERS: readonly ((t: string) => TestCounts | null)[] = [
  parsePytest,
  parseJest,
  parseVitest,
  parseCargo,
  parseGo,
  parseUnittest,
  parseSympyBinTest,
  parseNodeTest,
  parseRspec,
  parseMinitest,
  parseMaven,
  parseDotnet,
  parseExUnit,
  parsePhpunit,
  parseDeno,
  parseMocha,
  parseBun,
  parseSwift,
  parseGradle,
];

function parseAny(t: string): TestCounts | null {
  for (const p of ALL_PARSERS) {
    const r = p(t);
    if (r) return r;
  }
  return null;
}

/**
 * Pure. Parses from the tail; `npm`/`unknown` try every format. jest and vitest read their own formats first and then
 * every other one: the whole JS family is one test command (`node --test` or mocha run in a vitest workspace).
 */
export function parseTestOutput(runner: TestRunner, output: string): TestCounts | null {
  if (typeof output !== 'string' || output.length === 0) return null;
  const t = tail(output);
  switch (runner) {
    case 'pytest':
      return parsePytest(t);
    case 'django':
    case 'unittest':
      return parseUnittest(t);
    case 'sympy_bintest':
      return parseSympyBinTest(t);
    case 'jest':
      return parseJest(t) ?? parseVitest(t) ?? parseAny(t);
    case 'vitest':
      return parseVitest(t) ?? parseJest(t) ?? parseAny(t);
    case 'cargo':
      return parseCargo(t);
    case 'go':
      return parseGo(t);
    case 'npm':
    case 'unknown':
      return parseAny(t);
    default:
      return null;
  }
}
