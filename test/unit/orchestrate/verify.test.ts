import { describe, expect, it } from 'vitest';
import { VERIFY_COMMANDS_MAX } from '../../../src/core/limits.js';
import { NO_VERIFICATION_REASON, VERIFY_COMMAND_CHARS, resolveVerification, verifyForOwn, type VerifyResolveInput } from '../../../src/orchestrate/verify.js';

function base(over: Partial<VerifyResolveInput> = {}): VerifyResolveInput {
  return {
    configured: [],
    packageJson: null,
    rootFiles: new Set<string>(),
    makefile: null,
    synthRunner: null,
    lastTestRunCommand: null,
    ...over,
  };
}

describe('resolveVerification (§5.1)', () => {
  it('step 1: the configured commands win over everything below them', () => {
    const r = resolveVerification(
      base({
        configured: ['just check'],
        packageJson: { scripts: { test: 'vitest' } },
        rootFiles: new Set(['Cargo.toml']),
        synthRunner: 'synth run',
        lastTestRunCommand: 'npm test',
      }),
    );
    expect(r).toEqual({ commands: ['just check'], source: 'config', reason: null });
  });

  it('step 2: only test, typecheck and lint, only when present, in that order', () => {
    const r = resolveVerification(base({ packageJson: { scripts: { lint: 'eslint .', build: 'tsc -b', typecheck: 'tsc --noEmit', test: 'vitest run' } } }));
    expect(r).toEqual({ commands: ['npm run test', 'npm run typecheck', 'npm run lint'], source: 'package_scripts', reason: null });
    const partial = resolveVerification(base({ packageJson: { scripts: { lint: 'eslint .' } } }));
    expect(partial.commands).toEqual(['npm run lint']);
    const noScripts = resolveVerification(base({ packageJson: {}, rootFiles: new Set(['go.mod']) }));
    expect(noScripts).toMatchObject({ commands: ['go test ./...'], source: 'ecosystem' });
  });

  it('step 3: each ecosystem marker, and the Makefile `test:` target', () => {
    const eco = (rootFiles: readonly string[], makefile: string | null = null): readonly string[] => resolveVerification(base({ rootFiles: new Set(rootFiles), makefile })).commands;
    expect(eco(['pyproject.toml'])).toEqual(['pytest -q']);
    expect(eco(['pytest.ini'])).toEqual(['pytest -q']);
    expect(eco(['tox.ini'])).toEqual(['pytest -q']);
    expect(eco(['Cargo.toml'])).toEqual(['cargo test']);
    expect(eco(['go.mod'])).toEqual(['go test ./...']);
    expect(eco(['Makefile'], 'all: build\ntest:\n\tpytest\n')).toEqual(['make test']);
    expect(eco(['Makefile'], 'all: build\nlint:\n\truff\n')).toEqual([]);
    expect(eco(['Makefile'], 'integration-test:\n\tpytest\n')).toEqual([]);
    expect(eco(['Makefile'], null)).toEqual([]);
  });

  it('step 4 and step 5: the synth oracle, then the parent’s own last command', () => {
    expect(resolveVerification(base({ synthRunner: 'python -m pytest -q tests', lastTestRunCommand: 'npm test' }))).toEqual({ commands: ['python -m pytest -q tests'], source: 'synth_oracle', reason: null });
    expect(resolveVerification(base({ lastTestRunCommand: 'npm test -- --run' }))).toEqual({ commands: ['npm test -- --run'], source: 'last_test_run', reason: null });
  });

  it('step 6 returns the exact §5.1 string', () => {
    expect(resolveVerification(base())).toEqual({
      commands: [],
      source: 'none',
      reason: 'no verification command found; agents are research-only (set orchestrate.verify to allow code agents)',
    });
    expect(NO_VERIFICATION_REASON).toBe(resolveVerification(base()).reason);
  });

  it('walks the six steps in precedence as each source is removed', () => {
    const full = {
      configured: ['a'],
      packageJson: { scripts: { test: 'vitest' } },
      rootFiles: new Set(['Cargo.toml']),
      makefile: null,
      synthRunner: 's',
      lastTestRunCommand: 'l',
    } satisfies Partial<VerifyResolveInput>;
    expect(resolveVerification(base(full)).source).toBe('config');
    expect(resolveVerification(base({ ...full, configured: [] })).source).toBe('package_scripts');
    expect(resolveVerification(base({ ...full, configured: [], packageJson: null })).source).toBe('ecosystem');
    expect(resolveVerification(base({ ...full, configured: [], packageJson: null, rootFiles: new Set<string>() })).source).toBe('synth_oracle');
    expect(resolveVerification(base({ ...full, configured: [], packageJson: null, rootFiles: new Set<string>(), synthRunner: null })).source).toBe('last_test_run');
    expect(resolveVerification(base({ ...full, configured: [], packageJson: null, rootFiles: new Set<string>(), synthRunner: null, lastTestRunCommand: null })).source).toBe('none');
  });

  it('bounds the set at VERIFY_COMMANDS_MAX and says so', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f'];
    const r = resolveVerification(base({ configured: many }));
    expect(r.commands).toEqual(['a', 'b', 'c', 'd']);
    expect(r.commands.length).toBe(VERIFY_COMMANDS_MAX);
    expect(r.reason).toBe(`kept the first ${VERIFY_COMMANDS_MAX} of 6 verification commands`);
  });

  it('refuses a command holding a NUL or a newline, and clips at 200 characters', () => {
    const r = resolveVerification(base({ configured: ['npm test\nrm -rf /', 'ok one', 'nul\u0000here'] }));
    expect(r.commands).toEqual(['ok one']);
    expect(r.reason).toBe('dropped 2 config verification commands holding a newline or NUL');
    const long = resolveVerification(base({ configured: [`npm test ${'x'.repeat(400)}`] }));
    expect(long.commands[0]?.length).toBe(VERIFY_COMMAND_CHARS);
  });

  it('a step whose every candidate was refused falls through to the next step', () => {
    const r = resolveVerification(base({ configured: ['bad\ncommand'], packageJson: { scripts: { test: 'vitest' } } }));
    expect(r.commands).toEqual(['npm run test']);
    expect(r.source).toBe('package_scripts');
    expect(r.reason).toBe('dropped 1 config verification command holding a newline or NUL');
  });

  it('verifyForOwn hands every agent the resolved set (scoping is a later wave)', () => {
    const r = resolveVerification(base({ configured: ['npm test'] }));
    expect(verifyForOwn(r, ['src/tui/**'])).toEqual(['npm test']);
    expect(verifyForOwn(resolveVerification(base()), ['src/**'])).toEqual([]);
  });
});
