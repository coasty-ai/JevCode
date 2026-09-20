import { describe, expect, it } from 'vitest';
import { BOOLEAN_FLAGS, FLAGS, STRING_FLAGS, parseCliArgs, usageText } from '../../../src/cli/args.js';
import { UsageError } from '../../../src/errors.js';

function usage(argv: string[]): UsageError {
  try {
    parseCliArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) return e;
    throw e;
  }
  throw new Error(`expected UsageError for ${argv.join(' ')}`);
}

describe('parseCliArgs: run', () => {
  it('parses task text and every common flag', () => {
    const f = parseCliArgs([
      'run', 'fix', 'the', 'bug',
      '--provider', 'openrouter', '--model', 'anthropic/claude-sonnet-5', '--api-key', 'k1', '--base-url', 'https://x.test',
      '--temperature', '0.5', '--max-tokens', '2048', '--jev-base-url', 'https://j.test', '--jev-api-key', 'k2', '--jev-model', 'jev-1.13',
      '--spend-cap', '1.5', '--max-steps', '7', '--max-wall', '7h30m', '--max-replans', '2', '--complete-threshold', '0.9', '--impossible-threshold', '0.8',
      '--workspace', '/tmp/ws', '--runs-dir', '/tmp/runs', '--open-assist-path', '/tmp/oa', '--config', '/tmp/c.json', '--sandbox', 'none', '--no-network', '--plain',
    ]);
    expect(f.command).toBe('run');
    expect(f.task).toBe('fix the bug');
    expect(f.provider).toBe('openrouter');
    expect(f.model).toBe('anthropic/claude-sonnet-5');
    expect(f.apiKey).toBe('k1');
    expect(f.baseUrl).toBe('https://x.test');
    expect(f.temperature).toBe('0.5');
    expect(f.maxTokens).toBe('2048');
    expect(f.jevBaseUrl).toBe('https://j.test');
    expect(f.jevApiKey).toBe('k2');
    expect(f.jevModel).toBe('jev-1.13');
    expect(f.spendCap).toBe('1.5');
    expect(f.maxSteps).toBe('7');
    expect(f.maxWall).toBe('7h30m');
    expect(f.maxWallMs).toBe(7 * 3_600_000 + 30 * 60_000);
    expect(f.maxReplans).toBe('2');
    expect(f.completeThreshold).toBe('0.9');
    expect(f.impossibleThreshold).toBe('0.8');
    expect(f.workspace).toBe('/tmp/ws');
    expect(f.runsDir).toBe('/tmp/runs');
    expect(f.openAssistPath).toBe('/tmp/oa');
    expect(f.config).toBe('/tmp/c.json');
    expect(f.sandbox).toBe('none');
    expect(f.noNetwork).toBe(true);
    expect(f.plain).toBe(true);
  });

  it('parses --task-file, --resume/--force and the hidden flags', () => {
    expect(parseCliArgs(['run', '--task-file', 't.md']).taskFile).toBe('t.md');
    const r = parseCliArgs(['run', '--resume', '20260919-142301-k7q2m3xa', '--force']);
    expect(r.resume).toBe('20260919-142301-k7q2m3xa');
    expect(r.force).toBe(true);
    expect(r.task).toBeUndefined();
    const h = parseCliArgs(['run', 'x', '--perf-exit-after-first-frame', '--condition', 'jev-off', '--mock', '--mock-steps', '3', '--perf-lag-probe']);
    expect(h.perfExitAfterFirstFrame).toBe(true);
    expect(h.condition).toBe('jev-off');
    expect(h.mock).toBe(true);
    expect(h.mockSteps).toBe('3');
    expect(h.perfLagProbe).toBe(true);
    expect(usage(['run', 'x', '--mock-steps', 'many']).message).toMatch(/--mock-steps/);
    expect(usage(['config', '--mock']).message).toMatch(/--mock/);
  });

  it('allows no task text (stdin is decided by main) and --max-wall in every duration form', () => {
    expect(parseCliArgs(['run']).task).toBeUndefined();
    expect(parseCliArgs(['run', 'x', '--max-wall', '90s']).maxWallMs).toBe(90_000);
    expect(parseCliArgs(['run', 'x', '--max-wall', '1500ms']).maxWallMs).toBe(1500);
    expect(parseCliArgs(['run', 'x', '--max-wall', '2h']).maxWallMs).toBe(7_200_000);
    expect(parseCliArgs(['run', 'x', '--max-wall', '45']).maxWallMs).toBe(45);
  });

  it('rejects --resume with task text or --task-file, --force alone, bad run ids and bad conditions', () => {
    expect(usage(['run', 'do it', '--resume', '20260919-142301-k7q2m3xa']).message).toMatch(/--resume/);
    expect(usage(['run', '--task-file', 'a', '--resume', '20260919-142301-k7q2m3xa']).message).toMatch(/--resume/);
    expect(usage(['run', 'x', '--force']).message).toMatch(/--force/);
    expect(usage(['run', '--resume', 'nope']).message).toMatch(/not a run id/);
    expect(usage(['run', 'x', '--task-file', 'y']).message).toMatch(/not both/);
    expect(usage(['run', 'x', '--condition', 'maybe']).message).toMatch(/--condition/);
  });

  it('rejects a bad --max-wall with the duration hint and exit code 2', () => {
    const e = usage(['run', 'x', '--max-wall', 'soon']);
    expect(e.message).toMatch(/--max-wall/);
    expect(e.message).toMatch(/30m/);
    expect(e.exitCode).toBe(2);
    expect(e.code).toBe('usage');
  });

  it('rejects unknown flags, missing values, bad --sandbox and bad --provider', () => {
    expect(usage(['run', 'x', '--bogus']).message).toMatch(/--bogus/);
    expect(usage(['run', 'x', '--model']).message).toMatch(/--model/);
    expect(usage(['run', 'x', '--sandbox', 'jail']).message).toMatch(/auto\|seatbelt\|none/);
    expect(usage(['run', 'x', '--provider', 'openai']).message).toMatch(/anthropic\|openrouter/);
  });
});

describe('parseCliArgs: commands', () => {
  it('requires a known command first', () => {
    expect(usage([]).message).toMatch(/missing command/);
    expect(usage(['--model', 'x']).message).toMatch(/first argument must be a command/);
    expect(usage(['fly']).message).toMatch(/unknown command "fly"/);
  });

  it('answers --help without touching anything else', () => {
    expect(parseCliArgs(['--help'])).toEqual({ command: 'run', help: true });
    expect(parseCliArgs(['-h']).help).toBe(true);
    expect(parseCliArgs(['bench', '--help', '--live']).help).toBe(true);
    expect(parseCliArgs(['--version'])).toEqual({ command: 'run', version: true });
    expect(parseCliArgs(['perf', '-v']).version).toBe(true);
  });

  it('config: --json plus common flags, no positionals, no run flags', () => {
    const f = parseCliArgs(['config', '--json', '--provider', 'openrouter']);
    expect(f.command).toBe('config');
    expect(f.json).toBe(true);
    expect(f.provider).toBe('openrouter');
    expect(usage(['config', 'extra']).message).toMatch(/no positional/);
    expect(usage(['config', '--resume', '20260919-142301-k7q2m3xa']).message).toMatch(/--resume/);
    expect(usage(['config', '--suite', 'all']).message).toMatch(/--suite/);
  });

  it('bench: every bench flag parses and is validated', () => {
    const f = parseCliArgs([
      'bench', '--suite', 'all', '--tasks', '3', '--task-id', 'a,b', '--conditions', 'jev-on,jev-off', '--concurrency', '2', '--live', '--spend-cap', '5',
      '--task-spend-cap', '1.25', '--allow-model-alias', '--resume', 'bench-1', '--out', '/tmp/out', '--max-steps', '9',
    ]);
    expect(f.command).toBe('bench');
    expect(f.suite).toBe('all');
    expect(f.tasks).toBe('3');
    expect(f.taskId).toBe('a,b');
    expect(f.conditions).toBe('jev-on,jev-off');
    expect(f.concurrency).toBe('2');
    expect(f.live).toBe(true);
    expect(f.spendCap).toBe('5');
    expect(f.taskSpendCap).toBe('1.25');
    expect(f.allowModelAlias).toBe(true);
    expect(f.resume).toBe('bench-1');
    expect(f.out).toBe('/tmp/out');
    expect(f.maxSteps).toBe('9');
    expect(usage(['bench', '--suite', 'lmarena']).message).toMatch(/--suite/);
    expect(usage(['bench', '--conditions', 'jev-maybe']).message).toMatch(/--conditions/);
    expect(usage(['bench', '--tasks', '0']).message).toMatch(/--tasks/);
    expect(usage(['bench', '--concurrency', 'two']).message).toMatch(/--concurrency/);
    expect(usage(['bench', '--task-spend-cap', '-1']).message).toMatch(/--task-spend-cap/);
    expect(usage(['bench', '--force']).message).toMatch(/--force/);
  });

  it('--live requires --spend-cap on bench and perf', () => {
    expect(usage(['bench', '--live']).message).toMatch(/--spend-cap/);
    expect(usage(['perf', '--live']).message).toMatch(/--spend-cap/);
    expect(parseCliArgs(['bench', '--live', '--spend-cap', '1']).live).toBe(true);
    expect(parseCliArgs(['bench', '--suite', 'swebench']).live).toBeUndefined();
  });

  it('perf: --live, --out and common flags', () => {
    const f = parseCliArgs(['perf', '--live', '--spend-cap', '0.5', '--out', '/tmp/perf.json', '--plain']);
    expect(f.command).toBe('perf');
    expect(f.out).toBe('/tmp/perf.json');
    expect(f.plain).toBe(true);
    expect(usage(['perf', '--json']).message).toMatch(/--json/);
  });
});

describe('usageText', () => {
  it('mentions every visible flag and every command', () => {
    const all = `${usageText()}\n${usageText('run')}\n${usageText('config')}\n${usageText('bench')}\n${usageText('perf')}`;
    for (const f of FLAGS) {
      const re = new RegExp(`--${f.name}(\\s|$)`, 'm');
      if (f.hidden) expect(all, f.name).not.toMatch(re);
      else expect(all, f.name).toMatch(re);
    }
    for (const c of ['run', 'config', 'bench', 'perf']) expect(usageText()).toContain(`jevcode ${c}`);
  });

  it('the spec covers every ParsedFlags key exactly once', () => {
    const keys = FLAGS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual([...STRING_FLAGS, ...BOOLEAN_FLAGS].sort());
  });
});
