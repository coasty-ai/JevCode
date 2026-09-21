/**
 * TUI-DESIGN §19.0: the command table — every §5.2 row present with its args/avail/plain, aliases resolve,
 * `availableDuringTask` error sentences verbatim (§24), registry ↔ docs/COMMANDS.md, the generated docs
 * (KEYS.md, COMMANDS.md, man page, completions) in sync with the registries (`gen-docs.mjs --check`, CRLF
 * copies included), and their quality gates: `mandoc -T lint` (no WARNING/ERROR), `bash -n`, `zsh -n`,
 * `fish -n` (each skipped when the tool is absent), a deterministic `.TH` date.
 */
import { execFileSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUDGET_SETTINGS, COMMANDS, THEMES, availabilityError, commandNames, findCommand, isExactCommand, takesRest, type CommandSpec } from '../../../../src/tui/commands/registry.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const COMMANDS_MD = `${ROOT}docs/COMMANDS.md`;
const GENERATED = ['docs/KEYS.md', 'docs/COMMANDS.md', 'man/jevcode.1', 'completions/jevcode.bash', 'completions/jevcode.zsh', 'completions/jevcode.fish'];

/** true when an executable of that name is on PATH (the quality gates skip when a tool is absent) */
function hasBin(name: string): boolean {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

function run(cmd: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): { code: number; out: string; err: string } {
  try {
    const out = execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, env });
    return { code: 0, out, err: '' };
  } catch (e) {
    const x = e as { status?: number | null; stdout?: string; stderr?: string };
    return { code: x.status ?? 1, out: x.stdout ?? '', err: x.stderr ?? '' };
  }
}

const EXPECTED: readonly [name: string, avail: CommandSpec['availableDuringTask'], plain: string, aliases: readonly string[]][] = [
  ['help', 'any', 'yes', ['h']],
  ['new', 'idle', 'yes', []],
  ['resume', 'idle', '`/resume <id|title>` only', ['sessions', 'continue']],
  ['rename', 'any', 'yes', []],
  ['steer', 'live', 'yes', []],
  ['unsteer', 'live', 'yes', []],
  ['pause', 'live', 'yes', []],
  ['abort', 'live', 'yes', []],
  ['undo', 'idle', 'yes (readline `y/N`)', []],
  ['rewind', 'idle', 'yes', []],
  ['diff', 'any', 'inline only', []],
  ['plan', 'any', 'yes', []],
  ['decisions', 'any', 'yes', []],
  ['why', 'any', 'yes', []],
  ['calibration', 'idle', 'yes', []],
  ['jev', 'any', 'yes', []],
  ['cost', 'any', 'yes', []],
  ['budget', 'any', 'yes', []],
  ['model', 'any', 'yes', []],
  ['provider', 'any', 'yes', []],
  ['mode', 'any', 'yes', []],
  ['config', 'any', 'yes', []],
  ['login', 'any', '`/login` raw-mode prompt', []],
  ['logout', 'any', 'yes', []],
  ['trust', 'idle', 'yes', []],
  ['theme', 'any', 'n/a', []],
  ['copy', 'any', 'n/a', []],
  ['export', 'idle', 'yes', []],
  ['status', 'any', 'yes', []],
  ['errors', 'any', 'yes', []],
  ['report', 'idle', 'yes', []],
  ['history', 'any', 'yes', []],
  ['editor', 'any', 'n/a', []],
  ['exit', 'any', 'yes', ['quit']],
];

describe('COMMANDS (TUI-DESIGN §5.2)', () => {
  it('has every §5.2 row in order with avail, plain and aliases', () => {
    expect(COMMANDS.map((c) => c.name)).toEqual(EXPECTED.map((e) => e[0]));
    for (const [name, avail, plain, aliases] of EXPECTED) {
      const c = findCommand(name);
      expect(c, name).not.toBeNull();
      expect(c?.availableDuringTask, name).toBe(avail);
      expect(c?.plain, name).toBe(plain);
      expect(c?.aliases, name).toEqual(aliases);
    }
  });
  it('names and aliases are unique, valid, and every spec has a title, usage and semantics', () => {
    const all = COMMANDS.flatMap((c) => [c.name, ...c.aliases]);
    expect(new Set(all).size).toBe(all.length);
    for (const n of all) expect(n).toMatch(/^[a-z][a-z0-9-]*$/);
    for (const c of COMMANDS) {
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.usage.length).toBeGreaterThan(0);
      expect(c.semantics.length).toBeGreaterThan(0);
      for (const a of c.args) {
        if (a.kind === 'enum' || a.kind === 'setting') expect(a.values?.length ?? 0, `${c.name} ${a.name}`).toBeGreaterThan(0);
      }
    }
  });
  it('argument specs match the design: /budget settings with hints, /theme values, /diff flags, /decisions [n] [stage]', () => {
    const budget = findCommand('budget') as CommandSpec;
    expect(budget.args[0]?.kind).toBe('setting');
    expect(budget.args[0]?.values).toEqual(BUDGET_SETTINGS);
    for (const v of BUDGET_SETTINGS) expect(budget.args[0]?.valueHints?.[v]?.title, v).toBeTruthy();
    expect(findCommand('theme')?.args[0]?.values).toEqual(THEMES);
    expect((findCommand('diff')?.flags ?? []).map((f) => [f.name, f.idleOnly ?? false])).toEqual([['full', true], ['all', false]]);
    expect(findCommand('decisions')?.args.map((a) => a.kind)).toEqual(['int', 'enum']);
    expect(findCommand('undo')?.args[0]).toMatchObject({ kind: 'step', optional: true });
    expect(findCommand('resume')?.args[0]).toMatchObject({ kind: 'run', optional: true });
    expect(findCommand('rename')?.args[0]).toMatchObject({ kind: 'rest' });
    expect(findCommand('export')?.args[0]).toMatchObject({ kind: 'path', optional: true });
    expect((findCommand('resume')?.flags ?? []).find((f) => f.name === 'sort')).toMatchObject({ value: true, values: ['updated', 'created'] });
    expect(COMMANDS.filter(takesRest).map((c) => c.name)).toEqual(['rename', 'steer', 'why']);
  });
  it('findCommand resolves names and aliases case-insensitively, with or without the slash; isExactCommand is strict', () => {
    expect(findCommand('/Quit')?.name).toBe('exit');
    expect(findCommand('sessions')?.name).toBe('resume');
    expect(findCommand('continue')?.name).toBe('resume');
    expect(findCommand('h')?.name).toBe('help');
    expect(findCommand('/nope')).toBeNull();
    expect(findCommand('')).toBeNull();
    expect(isExactCommand('/budget')).toBe(true);
    expect(isExactCommand('budget')).toBe(true);
    expect(isExactCommand('/bud')).toBe(false);
    expect(isExactCommand('/budget ')).toBe(true);
    expect(isExactCommand('/budget spend-cap')).toBe(false);
    expect(commandNames()).toContain('/budget');
    expect(commandNames()).not.toContain('/quit');
  });
  it('availability errors are the §24 sentences', () => {
    expect(availabilityError(findCommand('undo') as CommandSpec, true)).toBe('error: /undo runs when the run is idle; Esc pauses first');
    expect(availabilityError(findCommand('pause') as CommandSpec, false)).toBe('error: /pause needs a live run');
    expect(availabilityError(findCommand('pause') as CommandSpec, true)).toBeNull();
    expect(availabilityError(findCommand('undo') as CommandSpec, false)).toBeNull();
    expect(availabilityError(findCommand('help') as CommandSpec, true)).toBeNull();
  });
  it('registry ↔ docs/COMMANDS.md: every command and alias is a row and no extra rows exist (generated)', () => {
    const doc = readFileSync(COMMANDS_MD, 'utf8');
    expect(doc).toContain('generated by scripts/gen-docs.mjs');
    const rows = doc.split('\n').filter((l) => /^\| `\//.test(l));
    expect(rows.length).toBe(COMMANDS.length);
    for (const c of COMMANDS) {
      const row = rows.find((l) => l.startsWith(`| \`/${c.name}\``));
      expect(row, c.name).toBeDefined();
      for (const a of c.aliases) expect(row, `${c.name} alias ${a}`).toContain(`alias \`/${a}\``);
      expect(row).toContain(`| ${c.availableDuringTask} |`);
    }
  });
});

describe('generated documentation is in sync (TUI-DESIGN §21)', () => {
  it('node scripts/gen-docs.mjs --check exits 0 (KEYS.md, COMMANDS.md, man page, completions)', () => {
    const out = execFileSync(process.execPath, ['scripts/gen-docs.mjs', '--check'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
    expect(out).toBe('');
  }, 60_000);
  it('--check tolerates CRLF copies (an autocrlf checkout) and still reports a stale target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcode-gen-docs-'));
    try {
      for (const rel of GENERATED) {
        const text = readFileSync(join(ROOT, rel), 'utf8');
        expect(text.includes('\r')).toBe(false);
        const abs = join(dir, rel);
        execFileSync('mkdir', ['-p', join(abs, '..')]);
        writeFileSync(abs, text.replace(/\n/g, '\r\n'));
      }
      expect(run(process.execPath, ['scripts/gen-docs.mjs', '--check', '--out', dir])).toMatchObject({ code: 0, out: '' });
      writeFileSync(join(dir, 'docs/KEYS.md'), 'stale\r\n');
      const stale = run(process.execPath, ['scripts/gen-docs.mjs', '--check', '--out', dir]);
      expect(stale.code).toBe(1);
      expect(stale.err).toContain('stale generated docs');
      expect(stale.err).toContain('docs/KEYS.md');
      expect(stale.err).not.toContain('COMMANDS.md');
      expect(run(process.execPath, ['scripts/gen-docs.mjs', '--check', '--out']).code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
  it('the man page date is deterministic: YYYY-MM-DD from git metadata, SOURCE_DATE_EPOCH overrides it', () => {
    const man = readFileSync(`${ROOT}man/jevcode.1`, 'utf8');
    expect(man).toMatch(/^\.TH JEVCODE 1 "\d{4}-\d{2}-\d{2}" "jevcode \d+\.\d+\.\d+[^"]*" "User Commands"$/m);
    const epoch = run(process.execPath, ['scripts/gen-docs.mjs', '--print', 'man'], { ...process.env, SOURCE_DATE_EPOCH: '0' });
    expect(epoch.code).toBe(0);
    expect(epoch.out).toContain('.TH JEVCODE 1 "1970-01-01"');
    // no trailing .br after the last SYNOPSIS line (a mandoc WARNING)
    const synopsis = man.slice(man.indexOf('.SH SYNOPSIS'), man.indexOf('.SH DESCRIPTION'));
    expect(synopsis.trimEnd().endsWith('.br')).toBe(false);
    expect(synopsis).toContain('.br');
    for (const line of man.split('\n')) expect(Buffer.byteLength(line), line).toBeLessThanOrEqual(256);
  }, 60_000);
  it.skipIf(!hasBin('mandoc'))('mandoc -T lint: no WARNING, ERROR or UNSUPP on the generated man page', () => {
    const r = run('mandoc', ['-T', 'lint', 'man/jevcode.1']);
    const bad = `${r.out}${r.err}`.split('\n').filter((l) => /(WARNING|ERROR|UNSUPP|FATAL):/.test(l));
    expect(bad).toEqual([]);
  });
  it.skipIf(!hasBin('bash'))('bash -n accepts the bash completion', () => {
    expect(run('bash', ['-n', 'completions/jevcode.bash'])).toMatchObject({ code: 0 });
  });
  it.skipIf(!hasBin('zsh'))('zsh -n accepts the zsh completion', () => {
    expect(run('zsh', ['-n', 'completions/jevcode.zsh'])).toMatchObject({ code: 0 });
  });
  it.skipIf(!hasBin('fish'))('fish -n accepts the fish completion', () => {
    expect(run('fish', ['-n', 'completions/jevcode.fish'])).toMatchObject({ code: 0 });
  });
  it('the man page and completions mention every CLI command and every slash command', () => {
    const man = readFileSync(`${ROOT}man/jevcode.1`, 'utf8');
    expect(man.startsWith('.\\" generated by scripts/gen-docs.mjs')).toBe(true);
    expect(man).toContain('.TH JEVCODE 1');
    for (const c of COMMANDS) expect(man, c.name).toContain(`/${c.name}`);
    for (const code of ['0', '2', '3', '4', '5', '6', '129', '130', '143']) expect(man).toContain(`.B ${code}\n`);
    const bash = readFileSync(`${ROOT}completions/jevcode.bash`, 'utf8');
    const zsh = readFileSync(`${ROOT}completions/jevcode.zsh`, 'utf8');
    const fish = readFileSync(`${ROOT}completions/jevcode.fish`, 'utf8');
    for (const s of [bash, zsh, fish]) {
      expect(s).toContain('generated by scripts/gen-docs.mjs');
      expect(s).toContain('--spend-cap');
      expect(s).toContain('runs');
      expect(s).not.toContain('--mock');
    }
    expect(zsh.startsWith('#compdef jevcode')).toBe(true);
    expect(bash).toContain('complete -F _jevcode jevcode');
    expect(fish).toContain('complete -c jevcode');
  });
});
