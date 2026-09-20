import { describe, expect, it } from 'vitest';
import { isTestCommand } from '../../../src/loop/stages/execute.js';

const pytest = { command: 'pytest -q', runner: 'pytest' as const };
const npm = { command: 'npm test', runner: 'npm' as const };
const cargo = { command: 'cargo test', runner: 'cargo' as const };
const go = { command: 'go test ./...', runner: 'go' as const };

describe('isTestCommand (test detection feeds parsed counts and lastTestRun)', () => {
  it('matches the detected command, a prefix with more arguments, and launcher forms', () => {
    expect(isTestCommand('pytest -q', pytest)).toBe(true);
    expect(isTestCommand('pytest   -q tests/test_a.py', pytest)).toBe(true);
    expect(isTestCommand('pytest tests/test_a.py::test_f', pytest)).toBe(true);
    expect(isTestCommand('python -m pytest -x', pytest)).toBe(true);
    expect(isTestCommand('npx vitest run', { command: 'vitest run', runner: 'vitest' })).toBe(true);
    expect(isTestCommand('npm test -- --grep x', npm)).toBe(true);
    expect(isTestCommand('cargo test --lib', cargo)).toBe(true);
    expect(isTestCommand('go test ./pkg/...', go)).toBe(true);
  });
  it('does not treat other subcommands of the same launcher, other programs, or a null test command as the test command', () => {
    expect(isTestCommand('npm run build', npm)).toBe(false);
    expect(isTestCommand('npm install left-pad', npm)).toBe(false);
    expect(isTestCommand('cargo build --release', cargo)).toBe(false);
    expect(isTestCommand('go build ./...', go)).toBe(false);
    expect(isTestCommand('ls -la', pytest)).toBe(false);
    expect(isTestCommand('python -m pip install x', pytest)).toBe(false);
    expect(isTestCommand('pytest -q', null)).toBe(false);
  });
});
