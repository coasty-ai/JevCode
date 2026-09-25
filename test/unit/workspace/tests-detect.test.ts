/**
 * Test-command detection across ecosystems and package managers (src/workspace/tests.ts, module comment a–n). The
 * manifest that names its ecosystem's test command wins over the Python shapes that only infer one, so a JS app with a
 * stray tests/test_api.py, a python bin/test or a tests/runtests.py gets its package manager's command; an explicit
 * pytest configuration still beats a package.json. Each case builds its tree in a temp directory.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { TestCommand, TestRunner } from '../../../src/core/types.js';
import { detectTestCommand, packageManagerOf, packageTestCommand, SPEC_FILE, type ManifestReader } from '../../../src/workspace/tests.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A tree from `{ path: content }`; a path ending in `/` is an empty directory. */
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'jev-detect-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    if (rel.endsWith('/')) mkdirSync(join(dir, rel), { recursive: true });
    else {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
  }
  return dir;
}

function readerFor(dir: string): ManifestReader {
  return {
    async read(rel) {
      try {
        return readFileSync(join(dir, rel), 'utf8');
      } catch {
        return null;
      }
    },
    async list(rel) {
      try {
        return readdirSync(join(dir, rel));
      } catch {
        return null;
      }
    },
  };
}

const shape = (tc: TestCommand | null): { command: string; runner: TestRunner } | null => (tc === null ? null : { command: tc.command, runner: tc.runner });
const detect = async (files: Record<string, string>): Promise<{ command: string; runner: TestRunner } | null> => shape(await detectTestCommand(readerFor(tree(files))));
const pkg = (test: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ name: 'app', scripts: { test }, ...extra });
const unknown = (command: string): { command: string; runner: TestRunner } => ({ command, runner: 'unknown' });

describe('package.json: the project package manager runs its test script', () => {
  it('npm without a lockfile or field; the runner is read from the script', async () => {
    expect(await detect({ 'package.json': pkg('vitest run') })).toEqual({ command: 'npm test', runner: 'vitest' });
    expect(await detect({ 'package.json': pkg('jest --ci'), 'package-lock.json': '{}' })).toEqual({ command: 'npm test', runner: 'jest' });
    expect(await detect({ 'package.json': pkg('node --test') })).toEqual({ command: 'npm test', runner: 'npm' });
  });

  it('the lockfile names the manager: pnpm, yarn, bun (both lockfile formats)', async () => {
    expect(await detect({ 'package.json': pkg('vitest run'), 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" })).toEqual({ command: 'pnpm test', runner: 'vitest' });
    expect(await detect({ 'package.json': pkg('jest'), 'yarn.lock': '# yarn lockfile v1\n' })).toEqual({ command: 'yarn test', runner: 'jest' });
    // `bun test` would run Bun's own runner instead of the script
    expect(await detect({ 'package.json': pkg('bun test'), 'bun.lockb': '' })).toEqual({ command: 'bun run test', runner: 'npm' });
    expect(await detect({ 'package.json': pkg('vitest'), 'bun.lock': '{}' })).toEqual({ command: 'bun run test', runner: 'vitest' });
  });

  it('the packageManager field wins over the lockfile (yarn 4 with Plug’n’Play, pnpm, bun, npm)', async () => {
    expect(await detect({ 'package.json': pkg('vitest run', { packageManager: 'yarn@4.5.0' }), '.pnp.cjs': '', 'yarn.lock': '' })).toEqual({ command: 'yarn test', runner: 'vitest' });
    expect(await detect({ 'package.json': pkg('vitest run', { packageManager: 'pnpm@9.12.0+sha512.abc' }) })).toEqual({ command: 'pnpm test', runner: 'vitest' });
    expect(await detect({ 'package.json': pkg('bun test', { packageManager: 'bun@1.1.30' }) })).toEqual({ command: 'bun run test', runner: 'npm' });
    expect(await detect({ 'package.json': pkg('mocha', { packageManager: 'npm@10.8.0' }), 'yarn.lock': '' })).toEqual({ command: 'npm test', runner: 'npm' });
    // an unrecognised field falls back to the lockfile
    expect(await detect({ 'package.json': pkg('jest', { packageManager: 'deno@2' }), 'pnpm-lock.yaml': '' })).toEqual({ command: 'pnpm test', runner: 'jest' });
  });

  it('packageManagerOf / packageTestCommand', () => {
    expect(packageManagerOf({}, new Set(['pnpm-lock.yaml', 'yarn.lock']))).toBe('pnpm');
    expect(packageManagerOf({ packageManager: 'yarn@1.22.22' }, new Set(['pnpm-lock.yaml']))).toBe('yarn');
    expect(packageManagerOf({}, new Set())).toBe('npm');
    expect(['npm', 'pnpm', 'yarn', 'bun'].map((pm) => packageTestCommand(pm as 'npm'))).toEqual(['npm test', 'pnpm test', 'yarn test', 'bun run test']);
  });

  it("npm's placeholder, an empty script, no scripts and a malformed package.json name no command", async () => {
    expect(await detect({ 'package.json': pkg('echo "Error: no test specified" && exit 1') })).toBeNull();
    expect(await detect({ 'package.json': pkg('  ') })).toBeNull();
    expect(await detect({ 'package.json': JSON.stringify({ name: 'x' }) })).toBeNull();
    expect(await detect({ 'package.json': '{ "scripts": { "test": ' })).toBeNull();
    // and detection goes on to the next manifest
    expect(await detect({ 'package.json': pkg('echo "Error: no test specified" && exit 1'), Makefile: 'test:\n\tnode test.js\n' })).toEqual(unknown('make test'));
  });
});

describe('the manifest beats the inferred Python shapes (the four misdetections)', () => {
  it('a JS app with tests/test_api.py runs its package manager, not pytest', async () => {
    expect(await detect({ 'package.json': pkg('vitest run'), 'tests/test_api.py': 'def test_x(): pass\n' })).toEqual({ command: 'npm test', runner: 'vitest' });
    expect(await detect({ 'package.json': pkg('vitest run'), 'pnpm-lock.yaml': '', 'test_api.py': '' })).toEqual({ command: 'pnpm test', runner: 'vitest' });
  });

  it('a node project with a python bin/test or a tests/runtests.py runs npm test', async () => {
    expect(await detect({ 'package.json': pkg('node --test'), 'bin/test': '#!/usr/bin/env python3\nprint(1)\n' })).toEqual({ command: 'npm test', runner: 'npm' });
    expect(await detect({ 'package.json': pkg('jest'), 'tests/runtests.py': '#!/usr/bin/env python\n' })).toEqual({ command: 'npm test', runner: 'jest' });
  });

  it('setup.py with a test_suite is not `setup.py test` (setuptools 72 removed it): the Python shapes decide', async () => {
    expect(await detect({ 'setup.py': 'from setuptools import setup\nsetup(name="x", test_suite="tests")\n' })).toBeNull();
    expect(await detect({ 'setup.py': 'setup(test_suite="tests")\n', 'tests/__init__.py': '', 'tests/basic.py': '' })).toEqual({ command: 'python3 -m unittest discover -v', runner: 'unittest' });
    expect(await detect({ 'setup.py': 'setup(test_suite="tests")\n', 'tests/test_a.py': '' })).toEqual({ command: 'python3 -m pytest -q', runner: 'pytest' });
  });

  it('an explicit pytest configuration beats a package.json (a Python project with JS tooling said which runner it uses)', async () => {
    const both = { 'package.json': pkg('jest'), 'yarn.lock': '' };
    expect(await detect({ ...both, 'pytest.ini': '[pytest]\n' })).toEqual({ command: 'python3 -m pytest -q', runner: 'pytest' });
    expect(await detect({ ...both, 'pyproject.toml': '[tool.pytest.ini_options]\naddopts = "-q"\n' })).toEqual({ command: 'python3 -m pytest -q', runner: 'pytest' });
    // a pyproject without pytest configuration is no such statement
    expect(await detect({ ...both, 'pyproject.toml': '[project]\nname = "x"\n', 'tests/test_a.py': '' })).toEqual({ command: 'yarn test', runner: 'jest' });
  });

  it('a Makefile `test:` target beats the inferred Python layout, and the pytest configuration beats the Makefile', async () => {
    expect(await detect({ Makefile: 'test:\n\tpytest\n', 'tests/test_a.py': '', 'setup.py': '' })).toEqual(unknown('make test'));
    expect(await detect({ Makefile: 'test:\n\tpytest\n', 'pytest.ini': '[pytest]\n' })).toEqual({ command: 'python3 -m pytest -q', runner: 'pytest' });
  });

  it('only the Python runners carry a scope builder; the manifest commands do not (the legacy fast path reads TestCommand.scope)', async () => {
    for (const files of [{ 'package.json': pkg('vitest run') }, { 'Cargo.toml': '' }, { 'go.mod': 'module x\n' }, { 'pom.xml': '<project/>' }, { Makefile: 'test:\n\ttrue\n' }]) {
      const tc = await detectTestCommand(readerFor(tree(files)));
      expect(tc).not.toBeNull();
      expect(tc?.scope, JSON.stringify(files)).toBeUndefined();
    }
    expect(typeof (await detectTestCommand(readerFor(tree({ 'pytest.ini': '[pytest]\n' }))))?.scope).toBe('function');
  });
});

describe('one fixture per ecosystem', () => {
  it('Cargo and Go (after a real package.json test script)', async () => {
    expect(await detect({ 'Cargo.toml': '[package]\nname = "x"\n' })).toEqual({ command: 'cargo test', runner: 'cargo' });
    expect(await detect({ 'go.mod': 'module example.com/x\n' })).toEqual({ command: 'go test ./...', runner: 'go' });
    expect(await detect({ 'Cargo.toml': '', 'package.json': pkg('vitest run') })).toEqual({ command: 'npm test', runner: 'vitest' });
    expect(await detect({ 'go.mod': 'module x\n', Makefile: 'test:\n\tgo test -race ./...\n' })).toEqual({ command: 'go test ./...', runner: 'go' });
  });

  it('Deno: `deno task test` with a tasks.test (deno.json or commented deno.jsonc), else `deno test`', async () => {
    expect(await detect({ 'deno.json': JSON.stringify({ tasks: { test: 'deno test -A' } }) })).toEqual(unknown('deno task test'));
    expect(await detect({ 'deno.jsonc': '{\n  // tasks\n  "tasks": { "test": "deno test --allow-read", /* the suite */ },\n  "imports": { "x": "https://a.b/c//d" },\n}\n' })).toEqual(unknown('deno task test'));
    expect(await detect({ 'deno.json': JSON.stringify({ tasks: { dev: 'deno run main.ts' } }) })).toEqual(unknown('deno test'));
    expect(await detect({ 'deno.jsonc': '{ "fmt": { "lineWidth": 100 } }' })).toEqual(unknown('deno test'));
    expect(await detect({ 'deno.json': '{ not json' })).toEqual(unknown('deno test'));
  });

  it('Ruby: spec/ → rspec, test/ → rake test; `bundle exec` only with a Gemfile; a Gemfile alone names nothing', async () => {
    expect(await detect({ Gemfile: "source 'https://rubygems.org'\n", 'spec/': '' })).toEqual(unknown('bundle exec rspec'));
    expect(await detect({ Rakefile: 'task default: :spec\n', 'spec/': '' })).toEqual(unknown('rspec'));
    expect(await detect({ Gemfile: '', Rakefile: '', 'test/': '' })).toEqual(unknown('bundle exec rake test'));
    expect(await detect({ Rakefile: "require 'rake/testtask'\n", 'test/': '' })).toEqual(unknown('rake test'));
    expect(await detect({ Gemfile: '', 'spec/': '', 'test/': '' })).toEqual(unknown('bundle exec rspec'));
    expect(await detect({ Gemfile: '' })).toBeNull();
  });

  it('Maven and Gradle, with and without their wrappers (never mvn -q: it hides the Tests run: summary)', async () => {
    expect(await detect({ 'pom.xml': '<project/>' })).toEqual(unknown('mvn test'));
    expect(await detect({ 'pom.xml': '<project/>', mvnw: '#!/bin/sh\n' })).toEqual(unknown('./mvnw test'));
    expect(await detect({ 'build.gradle': '' })).toEqual(unknown('gradle test'));
    expect(await detect({ 'build.gradle.kts': '', gradlew: '#!/bin/sh\n' })).toEqual(unknown('./gradlew test'));
    expect(await detect({ 'settings.gradle.kts': 'rootProject.name = "x"\n', gradlew: '' })).toEqual(unknown('./gradlew test'));
    expect(await detect({ 'settings.gradle': '' })).toEqual(unknown('gradle test'));
  });

  it('.NET: a root solution or project file', async () => {
    for (const f of ['App.sln', 'App.slnx', 'App.csproj', 'Lib.fsproj', 'Old.vbproj']) expect(await detect({ [f]: '' }), f).toEqual(unknown('dotnet test'));
    // a project file in a subdirectory is not a root marker
    expect(await detect({ 'src/App/App.csproj': '' })).toBeNull();
  });

  it('Elixir, Swift', async () => {
    expect(await detect({ 'mix.exs': 'defmodule X.MixProject do\nend\n' })).toEqual(unknown('mix test'));
    expect(await detect({ 'Package.swift': '// swift-tools-version:5.9\n' })).toEqual(unknown('swift test'));
  });

  it('PHP: composer test script, then Pest, then PHPUnit (config or binary); composer.json alone names nothing', async () => {
    expect(await detect({ 'composer.json': JSON.stringify({ scripts: { test: ['@php artisan test'] } }) })).toEqual(unknown('composer test'));
    expect(await detect({ 'composer.json': JSON.stringify({ 'require-dev': { 'pestphp/pest': '^3.0' } }), 'phpunit.xml': '' })).toEqual(unknown('vendor/bin/pest'));
    expect(await detect({ 'composer.json': '{}', 'vendor/bin/pest': '', 'vendor/bin/phpunit': '' })).toEqual(unknown('vendor/bin/pest'));
    expect(await detect({ 'composer.json': '{}', 'phpunit.xml.dist': '<phpunit/>' })).toEqual(unknown('vendor/bin/phpunit'));
    expect(await detect({ 'composer.json': '{}', 'phpunit.dist.xml': '<phpunit/>' })).toEqual(unknown('vendor/bin/phpunit'));
    expect(await detect({ 'composer.json': '{}', 'vendor/bin/phpunit': '' })).toEqual(unknown('vendor/bin/phpunit'));
    expect(await detect({ 'composer.json': '{}' })).toBeNull();
  });

  it('Make: a `test` target, alone or among several; never `test :=`, `integration-test:` or `.PHONY: test` alone', async () => {
    expect(await detect({ Makefile: 'all: build\n\ntest: build\n\t./run-tests\n' })).toEqual(unknown('make test'));
    expect(await detect({ Makefile: 'unit test: deps\n\t./t\n' })).toEqual(unknown('make test'));
    expect(await detect({ GNUmakefile: 'test::\n\t./t\n' })).toEqual(unknown('make test'));
    expect(await detect({ makefile: 'test:\n\t./t\n' })).toEqual(unknown('make test'));
    expect(await detect({ Makefile: 'test := 1\nintegration-test:\n\t./t\n.PHONY: test\n' })).toBeNull();
  });

  it('nothing recognisable: null', async () => {
    expect(await detect({ 'README.md': '# x\n', 'main.c': 'int main(){}\n' })).toBeNull();
  });
});

describe('.jevcode-spec.json confirmation is unchanged: it only acts when a bench loader wrote the file', () => {
  // the upstream Django checkout carries a package.json whose test script runs its JS tests through grunt
  const django = { 'package.json': pkg('grunt test --verbose'), 'tests/runtests.py': '#!/usr/bin/env python\n', 'tests/test_sqlite.py': '', 'setup.py': '' };

  it('a Django checkout: npm test from the files alone; the spec naming runtests.py confirms the Django runner', async () => {
    expect(await detect(django)).toEqual({ command: 'npm test', runner: 'npm' });
    const spec = { [SPEC_FILE]: JSON.stringify({ test_cmd: './tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1' }) };
    const tc = await detectTestCommand(readerFor(tree({ ...django, ...spec })));
    expect(shape(tc)).toEqual({ command: 'python3 tests/runtests.py --parallel 1', runner: 'django' });
    expect(tc?.scope?.(['tests/decorators/tests.py'])).toBe('python3 tests/runtests.py --parallel 1 decorators.tests');
  });

  it('a spec naming pytest confirms pytest over a manifest command; a spec naming an absent entry point changes nothing', async () => {
    expect(await detect({ Makefile: 'test:\n\tpytest\n', 'test_requests.py': '', [SPEC_FILE]: '{"test_cmd":"pytest -rA"}' })).toEqual({ command: 'python3 -m pytest -q', runner: 'pytest' });
    expect(await detect({ 'package.json': pkg('jest'), [SPEC_FILE]: '{"test_cmd":"bin/test -C"}' })).toEqual({ command: 'npm test', runner: 'jest' });
    // a runner the spec reader does not know (cargo) is no confirmation either
    expect(await detect({ 'Cargo.toml': '', [SPEC_FILE]: '{"test_cmd":"cargo test"}' })).toEqual({ command: 'cargo test', runner: 'cargo' });
  });
});
