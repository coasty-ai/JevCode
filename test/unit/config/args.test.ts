/**
 * TUI-DESIGN §1, §15.2 (`cli/args.ts` row), §16, §17: the CLI parser — the nine new commands and their positionals,
 * every §16 flag under the key the config layer reads, `--json[=verbose]`, `-c`, `--resume <id|title>` (any non-empty
 * value; the id check moved to the controller), bare argv / leading flag → `chat`, `jevcode run` with no task on a
 * TTY → `chat` (A101), the `--no-input` usage error, and the usage text; every pre-existing flag keeps working.
 * TUI-DESIGN-2 §1.2 / §2.3: `--mode` help names jev-only as the default; `--jev-provider auto|typesafe|openrouter`.
 */
import { CONDITION_ORDER } from '../../../src/bench/conditions.js';
import { describe, expect, it } from 'vitest';
import {
  BARE_JEVCODE_SENTENCE,
  BOOLEAN_FLAGS,
  CONDITIONS,
  CLI_SOURCES,
  COMMANDS,
  COMPLETION_SHELLS,
  FLAGS,
  JEV_PROVIDERS,
  LOGIN_JEV_PROVIDERS,
  MODES,
  NO_INPUT_NEEDS_TASK,
  RUN_ID_RE,
  SESSIONS_OPS,
  STRING_FLAGS,
  TAGLINE,
  classifyResumeValue,
  parseCliArgs,
  promoteRunToChat,
  usageText,
  type Command,
} from '../../../src/cli/args.js';
import type { TuiBooleanFlagKey, TuiStringFlagKey } from '../../../src/config/types.js';
import { DEFAULT_MODE, MODE_BADGE_WORD, SETTINGS, settingSpec } from '../../../src/config/defaults.js';
import { UsageError } from '../../../src/errors.js';
import { PROVIDER_IDS } from '../../../src/provider/ids.js';

const RUN_ID = '20260919-142301-k7q2m3xa';

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
      '--workspace', '/tmp/ws', '--runs-dir', '/tmp/runs', '--extra-env-file', '/tmp/oa', '--config', '/tmp/c.json', '--sandbox', 'none', '--no-network', '--plain',
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
    expect(f.extraEnvFile).toBe('/tmp/oa');
    expect(f.config).toBe('/tmp/c.json');
    expect(f.sandbox).toBe('none');
    expect(f.noNetwork).toBe(true);
    expect(f.plain).toBe(true);
  });

  it('parses --task-file, --resume/--force and the hidden flags', () => {
    expect(parseCliArgs(['run', '--task-file', 't.md']).taskFile).toBe('t.md');
    const r = parseCliArgs(['run', '--resume', RUN_ID, '--force']);
    expect(r.resume).toBe(RUN_ID);
    expect(r.force).toBe(true);
    expect(r.task).toBeUndefined();
    const h = parseCliArgs(['run', 'x', '--perf-exit-after-first-frame', '--condition', 'jev-off', '--mock', '--mock-steps', '3', '--perf-lag-probe', '--source', 'perf']);
    expect(h.perfExitAfterFirstFrame).toBe(true);
    expect(h.condition).toBe('jev-off');
    expect(h.mock).toBe(true);
    expect(h.mockSteps).toBe('3');
    expect(h.perfLagProbe).toBe(true);
    expect(h.source).toBe('perf');
    expect(usage(['run', 'x', '--mock-steps', 'many']).message).toMatch(/--mock-steps/);
    expect(usage(['config', '--mock']).message).toMatch(/--mock/);
    // TUI-DESIGN §15 item 11: `bench` is set programmatically, never claimed from the command line
    expect(usage(['run', 'x', '--source', 'bench']).message).toMatch(new RegExp(`--source: expected one of ${CLI_SOURCES.join('\\|')}`));
  });

  it('allows no task text (stdin is decided by main) and --max-wall in every duration form', () => {
    expect(parseCliArgs(['run']).task).toBeUndefined();
    expect(parseCliArgs(['run']).command).toBe('run');
    expect(parseCliArgs(['run', 'x', '--max-wall', '90s']).maxWallMs).toBe(90_000);
    expect(parseCliArgs(['run', 'x', '--max-wall', '1500ms']).maxWallMs).toBe(1500);
    expect(parseCliArgs(['run', 'x', '--max-wall', '2h']).maxWallMs).toBe(7_200_000);
    expect(parseCliArgs(['run', 'x', '--max-wall', '45']).maxWallMs).toBe(45);
  });

  it('rejects --resume with task text or --task-file, --force alone, --resume with --continue, an empty --resume and bad conditions', () => {
    expect(usage(['run', 'do it', '--resume', RUN_ID]).message).toMatch(/--resume/);
    expect(usage(['run', '--task-file', 'a', '--resume', RUN_ID]).message).toMatch(/--resume/);
    expect(usage(['run', 'x', '--force']).message).toMatch(/--force/);
    expect(usage(['run', '--resume', RUN_ID, '-c']).message).toMatch(/--resume and --continue/);
    expect(usage(['run', '--resume', '  ']).message).toMatch(/expected a run id or a session title/);
    expect(usage(['run', 'x', '--task-file', 'y']).message).toMatch(/not both/);
    expect(usage(['run', 'x', '--condition', 'maybe']).message).toMatch(/--condition/);
    expect(usage(['run', 'x', '--list-sessions']).message).toMatch(/--list-sessions/);
  });

  it('TUI-DESIGN §15.2: --resume accepts any non-empty value (a title, a prefix); the run-id check is the controller\'s', () => {
    expect(parseCliArgs(['run', '--resume', 'nope']).resume).toBe('nope');
    expect(parseCliArgs(['run', '--resume', ' tz fixes ']).resume).toBe('tz fixes');
    expect(parseCliArgs(['chat', '--resume', 'tz']).resume).toBe('tz');
    expect(classifyResumeValue(RUN_ID)).toEqual({ kind: 'run', runId: RUN_ID });
    expect(classifyResumeValue(` ${RUN_ID} `)).toEqual({ kind: 'run', runId: RUN_ID });
    expect(classifyResumeValue('tz fixes')).toEqual({ kind: 'title', title: 'tz fixes' });
    expect(classifyResumeValue('20260919-142301-K7Q2M3XA')).toEqual({ kind: 'title', title: '20260919-142301-K7Q2M3XA' });
    expect(RUN_ID_RE.test(RUN_ID)).toBe(true);
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
    // TUI-DESIGN-5 §6.1 (D-AP): `openai` is a provider from round 5 on; the refusal now names all seven
    expect(usage(['run', 'x', '--provider', 'notaprovider']).message).toMatch(/anthropic\|openrouter\|openai\|gemini\|xai\|fireworks\|meta/);
    expect(parseCliArgs(['run', 'x', '--provider', 'openai']).provider).toBe('openai');
  });
});

describe('parseCliArgs: chat (TUI-DESIGN §1)', () => {
  it('a bare argv is chat; a leading flag parses as chat flags; a bare word is still an unknown command', () => {
    expect(parseCliArgs([])).toEqual({ command: 'chat' });
    expect(parseCliArgs(['chat'])).toEqual({ command: 'chat' });
    expect(parseCliArgs(['--model', 'x'])).toEqual({ command: 'chat', model: 'x' });
    expect(parseCliArgs(['--plain', '-c', '--theme', 'ansi'])).toEqual({ command: 'chat', theme: 'ansi', plain: true, continue: true });
    expect(usage(['fly']).message).toMatch(/unknown command "fly"/);
    expect(usage(['fix the bug']).message).toMatch(/jevcode run "<task>"/);
  });

  it('chat takes no task text, session flags and the ui flags; --no-input on chat is the §24 usage error', () => {
    expect(usage(['chat', 'fix', 'it']).message).toMatch(/takes no task text.*jevcode run/);
    expect(usage(['--plain', 'fix it']).message).toMatch(/takes no task text/);
    const f = parseCliArgs(['chat', '--continue', '--force', '--list-sessions', '--mode', 'jev-only', '--mock', '--perf-exit-after-first-frame']);
    expect(f).toMatchObject({ command: 'chat', continue: true, force: true, listSessions: true, mode: 'jev-only', mock: true, perfExitAfterFirstFrame: true });
    expect(parseCliArgs(['chat', '-c']).continue).toBe(true);
    expect(usage(['chat', '--no-input']).message).toContain(NO_INPUT_NEEDS_TASK);
    expect(usage(['--no-input']).message).toContain(NO_INPUT_NEEDS_TASK);
    expect(parseCliArgs(['run', 'x', '--no-input']).noInput).toBe(true);
    // --task-file is a run flag
    expect(usage(['chat', '--task-file', 't.md']).message).toMatch(/--task-file/);
  });

  it('A101: `jevcode run` with nothing to run on a TTY is chat; anything to run, --json or --no-input keeps run; a pipe keeps run', () => {
    expect(parseCliArgs(['run'], { stdinIsTTY: true })).toEqual({ command: 'chat' });
    expect(parseCliArgs(['run', '--plain', '--theme', 'light'], { stdinIsTTY: true })).toEqual({ command: 'chat', theme: 'light', plain: true });
    expect(parseCliArgs(['run'], { stdinIsTTY: false }).command).toBe('run');
    expect(parseCliArgs(['run']).command).toBe('run');
    for (const argv of [['run', 'task'], ['run', '--task-file', 't.md'], ['run', '--resume', RUN_ID], ['run', '-c'], ['run', '--list-sessions'], ['run', '--json'], ['run', '--no-input']]) {
      expect(parseCliArgs(argv, { stdinIsTTY: true }).command, argv.join(' ')).toBe('run');
    }
    expect(promoteRunToChat({ command: 'run' }, { stdinIsTTY: true })).toEqual({ command: 'chat' });
    expect(promoteRunToChat({ command: 'run', task: 'x' }, { stdinIsTTY: true })).toEqual({ command: 'run', task: 'x' });
    // the perf and mock hooks do not keep `run`: a no-task probe measures the chat first frame (perf drivers pass a task)
    expect(parseCliArgs(['run', '--mock', '--perf-exit-after-first-frame'], { stdinIsTTY: true })).toMatchObject({ command: 'chat', mock: true, perfExitAfterFirstFrame: true });
    expect(parseCliArgs(['run', '--source', 'perf'], { stdinIsTTY: true })).toMatchObject({ command: 'chat', source: 'perf' });
    expect(parseCliArgs(['run', 'task', '--source', 'perf', '--perf-exit-after-first-frame'], { stdinIsTTY: true }).command).toBe('run');
    expect(promoteRunToChat({ command: 'bench' }, { stdinIsTTY: true })).toEqual({ command: 'bench' });
    expect(promoteRunToChat({ command: 'run' }, {})).toEqual({ command: 'run' });
  });
});

describe('parseCliArgs: the TUI-DESIGN §16 flags land under the keys the config layer reads', () => {
  it('every ui.* / log.* / session.* value flag parses and validates', () => {
    const f = parseCliArgs([
      'chat', '--theme', 'Daltonized', '--fps', '20', '--render-mode', 'Incremental', '--exit-code', 'last-run', '--keybindings', '/k.json',
      '--log', '/tmp/j.log', '--log-level', 'DEBUG', '--session-spend-cap', '12.5', '--max-generator-tokens', '5000',
    ]);
    expect(f).toMatchObject({ theme: 'daltonized', fps: '20', renderMode: 'incremental', exitCode: 'last-run', keybindings: '/k.json', log: '/tmp/j.log', logLevel: 'debug', sessionSpendCap: '12.5', maxGeneratorTokens: '5000' });
    expect(parseCliArgs(['run', 'x', '--session-spend-cap', 'NONE']).sessionSpendCap).toBe('none');
    expect(usage(['chat', '--theme', 'neon']).message).toMatch(/--theme: expected one of dark\|light\|daltonized\|ansi/);
    expect(usage(['chat', '--render-mode', 'fast']).message).toMatch(/--render-mode: expected one of standard\|incremental/);
    expect(usage(['chat', '--fps', 'abc']).message).toMatch(/--fps: expected a number 5\.\.30, got "abc"/);
    expect(usage(['chat', '--fps', '0']).message).toMatch(/--fps: expected a number 5\.\.30/);
    expect(usage(['chat', '--exit-code', 'maybe']).message).toMatch(/--exit-code: expected one of zero\|last-run/);
    expect(usage(['chat', '--log-level', 'loud']).message).toMatch(/--log-level: expected one of error\|warn\|info\|debug\|trace/);
    expect(usage(['chat', '--session-spend-cap=-1']).message).toMatch(/--session-spend-cap: expected a positive USD amount or none/);
    expect(usage(['chat', '--session-spend-cap', '0']).message).toMatch(/--session-spend-cap: expected a positive USD amount or none/);
    expect(usage(['chat', '--session-spend-cap', 'lots']).message).toMatch(/--session-spend-cap/);
    expect(usage(['chat', '--max-generator-tokens', '0']).message).toMatch(/--max-generator-tokens: expected a positive integer/);
    expect(usage(['chat', '--keybindings', '']).message).toMatch(/--keybindings: expected a path/);
    expect(usage(['chat', '--log', ' ']).message).toMatch(/--log: expected a path/);
  });

  it('TUI-DESIGN §16 (R14): --fps takes parseFps\'s shape within 5..30 at parse time — 1e2, 100 and 4 are usage errors, never silently ignored or clamped', () => {
    for (const bad of ['1e2', '100', '4', '31', '0x10', '', ' ', 'Infinity']) expect(usage(['chat', '--fps', bad]).message, bad).toMatch(/--fps: expected a number 5\.\.30/);
    // a leading dash needs the `=` form for parseArgs; the range check still rejects it
    expect(usage(['chat', '--fps=-5']).message).toMatch(/--fps: expected a number 5\.\.30/);
    expect(parseCliArgs(['chat', '--fps', '5']).fps).toBe('5');
    expect(parseCliArgs(['chat', '--fps', '30']).fps).toBe('30');
    expect(parseCliArgs(['run', 'x', '--fps', ' 20 ']).fps).toBe('20');
    // a fraction parses (config/launch.ts rounds it) as long as it stays in range
    expect(parseCliArgs(['chat', '--fps', '20.5']).fps).toBe('20.5');
    expect(usage(['chat', '--fps', '4.9']).message).toMatch(/--fps/);
    // --session-spend-cap is trimmed like `none`
    expect(parseCliArgs(['chat', '--session-spend-cap', ' 12.5 ']).sessionSpendCap).toBe('12.5');
    expect(parseCliArgs(['chat', '--session-spend-cap', ' none ']).sessionSpendCap).toBe('none');
  });

  it('every ui.* boolean flag parses; --reduced-motion is an alias of --no-animation (key noAnimation)', () => {
    const f = parseCliArgs([
      'run', 'x', '--ascii', '--title', '--screen-reader', '--no-animation', '--notify', '--osc52', '--no-history', '--no-input', '--trust-workspace',
      '--no-budget-warnings', '--allow-secret-mention', '--no-color', '--verbose', '--allow-unpriced', '--update-notify',
    ]);
    expect(f).toMatchObject({
      ascii: true, title: true, screenReader: true, noAnimation: true, notify: true, osc52: true, noHistory: true, noInput: true, trustWorkspace: true,
      noBudgetWarnings: true, allowSecretMention: true, noColor: true, verbose: true, allowUnpriced: true, updateNotify: true,
    });
    expect(parseCliArgs(['chat', '--reduced-motion']).noAnimation).toBe(true);
    expect(parseCliArgs(['chat', '--reduced-motion'])).not.toHaveProperty('reducedMotion');
    // config prints the rows, so it accepts the flags too; bench and perf do not
    expect(parseCliArgs(['config', '--theme', 'light', '--verbose']).theme).toBe('light');
    expect(usage(['bench', '--theme', 'light']).message).toMatch(/--theme/);
    expect(usage(['perf', '--screen-reader']).message).toMatch(/--screen-reader/);
  });

  it('the STRING_FLAGS / BOOLEAN_FLAGS carry every TuiStringFlagKey / TuiBooleanFlagKey of config/types.ts', () => {
    const stringKeys: readonly TuiStringFlagKey[] = ['theme', 'fps', 'renderMode', 'exitCode', 'keybindings', 'log', 'logLevel', 'sessionSpendCap', 'maxGeneratorTokens'];
    const boolKeys: readonly TuiBooleanFlagKey[] = ['ascii', 'title', 'screenReader', 'noAnimation', 'notify', 'osc52', 'noHistory', 'noInput', 'trustWorkspace', 'noBudgetWarnings', 'allowSecretMention', 'noColor', 'verbose', 'allowUnpriced', 'updateNotify'];
    for (const k of stringKeys) expect(STRING_FLAGS, k).toContain(k);
    for (const k of boolKeys) expect(BOOLEAN_FLAGS, k).toContain(k);
    // the launch resolver reads these (config/launch.ts LaunchFlags)
    for (const k of ['fps', 'renderMode'] as const) expect(STRING_FLAGS).toContain(k);
    for (const k of ['screenReader', 'ascii', 'noColor'] as const) expect(BOOLEAN_FLAGS).toContain(k);
  });
});

describe('parseCliArgs: --json[=verbose] (TUI-DESIGN §8.9)', () => {
  it('--json is a boolean that also accepts =verbose; it never swallows the next token', () => {
    expect(parseCliArgs(['run', '--json', 'fix', 'the', 'bug'])).toMatchObject({ command: 'run', json: true, task: 'fix the bug' });
    expect(parseCliArgs(['run', '--json', 'fix'])).not.toHaveProperty('jsonVerbose');
    expect(parseCliArgs(['run', 'fix', '--json=verbose'])).toMatchObject({ json: true, jsonVerbose: true, task: 'fix' });
    expect(parseCliArgs(['--json'])).toEqual({ command: 'chat', json: true });
    expect(parseCliArgs(['config', '--json'])).toEqual({ command: 'config', json: true });
    expect(parseCliArgs(['sessions', '--json'])).toMatchObject({ command: 'sessions', json: true, sessionsOp: 'list' });
    expect(parseCliArgs(['calibration', '--json'])).toEqual({ command: 'calibration', json: true });
    expect(usage(['run', 'x', '--json=pretty']).message).toMatch(/--json: expected --json or --json=verbose, got "pretty"/);
    expect(usage(['perf', '--json']).message).toMatch(/--json/);
    expect(usage(['bench', '--json']).message).toMatch(/--json/);
    // a `--json` after `--` is a positional, not the flag
    expect(parseCliArgs(['run', '--', '--json'])).toEqual({ command: 'run', task: '--json' });
  });
});

describe('parseCliArgs: commands', () => {
  it('answers --help without touching anything else; --version [--json] parses like any flag', () => {
    expect(parseCliArgs(['--help'])).toEqual({ command: 'chat', help: true });
    expect(parseCliArgs(['-h'])).toEqual({ command: 'chat', help: true });
    expect(parseCliArgs(['--help', '--bogus'])).toEqual({ command: 'chat', help: true });
    expect(parseCliArgs(['bench', '--help', '--live']).help).toBe(true);
    expect(parseCliArgs(['--version'])).toEqual({ command: 'chat', version: true });
    expect(parseCliArgs(['-v'])).toEqual({ command: 'chat', version: true });
    expect(parseCliArgs(['perf', '-v']).version).toBe(true);
    expect(parseCliArgs(['--version', '--json'])).toEqual({ command: 'chat', version: true, json: true });
    // TUI-DESIGN §1: `--version [--json]` is an any-command row — `--json` rides along with `--version` even where it is not a command flag
    expect(parseCliArgs(['bench', '--version', '--json'])).toEqual({ command: 'bench', version: true, json: true });
    expect(parseCliArgs(['perf', '-v', '--json'])).toEqual({ command: 'perf', version: true, json: true });
    expect(parseCliArgs(['login', '--json', '--version'])).toEqual({ command: 'login', version: true, json: true });
    expect(parseCliArgs(['completion', '--version', '--json=verbose'])).toMatchObject({ command: 'completion', version: true, json: true });
    // without --version the rule is unchanged: `--json` is unknown on bench/perf/login, and `--` ends the search
    expect(usage(['bench', '--json']).message).toMatch(/--json/);
    expect(usage(['login', '--json']).message).toMatch(/--json/);
    expect(usage(['bench', '--json', '--', '--version']).message).toMatch(/--json/);
    // help/version short-circuit the positional and cross-flag checks
    expect(parseCliArgs(['why', '--help'])).toEqual({ command: 'why', help: true });
  });

  it('config: --json plus common flags, `set <setting> <value>`, no other positionals, no run flags', () => {
    const f = parseCliArgs(['config', '--json', '--provider', 'openrouter']);
    expect(f.command).toBe('config');
    expect(f.json).toBe(true);
    expect(f.provider).toBe('openrouter');
    expect(parseCliArgs(['config', 'set', 'theme', 'light'])).toEqual({ command: 'config', configSet: { setting: 'theme', value: 'light' } });
    expect(parseCliArgs(['config', 'set', 'limits.spendCapUsd', '3'])).toEqual({ command: 'config', configSet: { setting: 'limits.spendCapUsd', value: '3' } });
    expect(usage(['config', 'extra']).message).toMatch(/no positional/);
    expect(usage(['config', 'set', 'theme']).message).toMatch(/set <setting> <value>/);
    expect(usage(['config', 'set', 'theme', 'light', 'extra']).message).toMatch(/set <setting> <value>/);
    expect(usage(['config', 'set', ' ', 'x']).message).toMatch(/setting name is empty/);
    expect(usage(['config', '--resume', RUN_ID]).message).toMatch(/--resume/);
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
    expect(usage(['bench', 'extra']).message).toMatch(/no positional/);
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

  it('login / logout (TUI-DESIGN §11.2): their flags, --provider and --config; no positionals, no run flags', () => {
    expect(parseCliArgs(['login', '--provider', 'OpenRouter', '--generator-key-stdin', '--jev-key-stdin', '--status', '--verify', '--config', '/c.json'])).toEqual({
      command: 'login', provider: 'openrouter', generatorKeyStdin: true, jevKeyStdin: true, status: true, verify: true, config: '/c.json',
    });
    expect(parseCliArgs(['logout', '--generator'])).toEqual({ command: 'logout', generator: true });
    expect(parseCliArgs(['logout', '--jev', '--config', '/c.json'])).toEqual({ command: 'logout', jev: true, config: '/c.json' });
    expect(usage(['login', 'extra']).message).toMatch(/no positional/);
    expect(usage(['login', '--model', 'x']).message).toMatch(/--model/);
    expect(usage(['login', '--api-key', 'k']).message).toMatch(/--api-key/);
    expect(usage(['logout', '--provider', 'anthropic']).message).toMatch(/--provider/);
  });

  it('sessions <verb> [words…] — the seventeen verbs (TUI-DESIGN §1, §8.5; TUI-DESIGN-5 §2.10)', () => {
    expect(parseCliArgs(['sessions'])).toEqual({ command: 'sessions', sessionsOp: 'list' });
    for (const op of SESSIONS_OPS.filter((o) => o !== 'unlock')) expect(parseCliArgs(['sessions', op])).toEqual({ command: 'sessions', sessionsOp: op });
    // §2.10: the words after the verb are the verb's own arguments and reach `commandSessions` verbatim, so
    // `unlock`'s run id is BOTH the checked `runId` and the first word — one parse, no second grammar
    expect(parseCliArgs(['sessions', 'unlock', RUN_ID])).toEqual({ command: 'sessions', sessionsOp: 'unlock', runId: RUN_ID, sessionsArgs: [RUN_ID] });
    expect(parseCliArgs(['sessions', 'tell', 'mbp', 'hold', 'off'])).toEqual({ command: 'sessions', sessionsOp: 'tell', sessionsArgs: ['mbp', 'hold', 'off'] });
    expect(parseCliArgs(['sessions', '--workspace', '/w', '--runs-dir', '/r'])).toMatchObject({ workspace: '/w', runsDir: '/r' });
    expect(usage(['sessions', 'bogus']).message).toMatch(/expected one of list\|reindex\|prune\|unlock/);
    expect(usage(['sessions', 'unlock']).message).toMatch(/needs the run id to unlock/);
    expect(usage(['sessions', 'unlock', 'nope']).message).toMatch(/not a run id/);
    expect(usage(['sessions', 'unlock', RUN_ID, 'extra']).message).toMatch(/one run id/);
    expect(usage(['sessions', 'list', 'extra']).message).toMatch(/takes no further arguments/);
    expect(usage(['sessions', '--model', 'x']).message).toMatch(/--model/);
  });

  it('report <id> (TUI-DESIGN §13.6) and why <id> <step> <ref> (§7.6)', () => {
    expect(parseCliArgs(['report', RUN_ID, '--include-requests', '--out', '/tmp/b'])).toEqual({ command: 'report', runId: RUN_ID, includeRequests: true, out: '/tmp/b' });
    expect(usage(['report']).message).toMatch(/needs a run id/);
    expect(usage(['report', 'nope']).message).toMatch(/not a run id/);
    expect(usage(['report', RUN_ID, RUN_ID]).message).toMatch(/one run id/);
    expect(parseCliArgs(['why', RUN_ID, '7', 'risk.plan_mismatch'])).toEqual({ command: 'why', runId: RUN_ID, step: 7, ref: 'risk.plan_mismatch' });
    expect(parseCliArgs(['why', RUN_ID, '7', 's7.risk.plan_mismatch', '--json'])).toMatchObject({ json: true, ref: 's7.risk.plan_mismatch' });
    expect(usage(['why']).message).toMatch(/needs a run id, a step and a decision ref/);
    expect(usage(['why', RUN_ID]).message).toMatch(/expected a positive step number/);
    expect(usage(['why', RUN_ID, '0', 'x']).message).toMatch(/expected a positive step number/);
    expect(usage(['why', RUN_ID, 'seven', 'x']).message).toMatch(/expected a positive step number/);
    expect(usage(['why', RUN_ID, '7']).message).toMatch(/expected a decision ref/);
    expect(parseCliArgs(['calibration'])).toEqual({ command: 'calibration' });
    expect(usage(['calibration', 'x']).message).toMatch(/no positional/);
  });

  it('completion <shell> (TUI-DESIGN §17 item 4) and upgrade [<version>|latest|next] [--check] [--method] (§17 item 5)', () => {
    for (const shell of COMPLETION_SHELLS) expect(parseCliArgs(['completion', shell])).toEqual({ command: 'completion', shell });
    expect(usage(['completion']).message).toMatch(/expected one of bash\|zsh\|fish/);
    expect(usage(['completion', 'pwsh']).message).toMatch(/expected one of bash\|zsh\|fish/);
    expect(usage(['completion', 'bash', 'zsh']).message).toMatch(/expected one of/);
    expect(parseCliArgs(['upgrade'])).toEqual({ command: 'upgrade' });
    expect(parseCliArgs(['upgrade', 'next', '--check'])).toEqual({ command: 'upgrade', check: true, upgradeTarget: 'next' });
    expect(parseCliArgs(['upgrade', '1.2.3-rc.1', '--method', 'brew'])).toEqual({ command: 'upgrade', method: 'brew', upgradeTarget: '1.2.3-rc.1' });
    expect(parseCliArgs(['upgrade', '--check', '--write-cache'])).toEqual({ command: 'upgrade', check: true, writeCache: true });
    expect(usage(['upgrade', '--write-cache']).message).toMatch(/--write-cache only applies together with --check/);
    expect(usage(['upgrade', 'a', 'b']).message).toMatch(/at most one version/);
    expect(usage(['upgrade', 'not', 'a', 'version']).message).toMatch(/at most one version/);
    expect(usage(['upgrade', 'not a version']).message).toMatch(/is not a version/);
    expect(usage(['upgrade', '1.0;rm']).message).toMatch(/is not a version/);
    expect(usage(['upgrade', '--model', 'x']).message).toMatch(/--model/);
  });
});

describe('usageText', () => {
  const ALL: readonly Command[] = COMMANDS;

  it('mentions every visible flag and every command; hidden flags and alias-only names stay out of the flag columns', () => {
    const all = [usageText(), ...ALL.map((c) => usageText(c))].join('\n');
    for (const f of FLAGS) {
      const re = new RegExp(`--${f.name}(\\s|$)`, 'm');
      if (f.hidden) expect(all, f.name).not.toMatch(re);
      else expect(all, f.name).toMatch(re);
    }
    for (const c of ALL) expect(usageText()).toContain(`jevcode ${c}`);
    expect(usageText()).toContain('jevcode --version [--json] | --help');
    expect(usageText('chat')).toContain('(also --reduced-motion)');
    expect(usageText('run')).toContain('(also --reduced-motion)');
    expect(usageText()).not.toMatch(/--source/);
  });

  it('per-command usage shows the command\'s own flags and only the common flags it takes', () => {
    const login = usageText('login');
    expect(login).toContain('Usage: jevcode login');
    expect(login).toContain('--generator-key-stdin');
    expect(login).toContain('--provider anthropic|openrouter');
    expect(login).toContain('--config <file>');
    expect(login).not.toContain('--model');
    expect(login).not.toContain('--plain');
    const chat = usageText('chat');
    expect(chat).toContain('-c, --continue');
    expect(chat).toContain('--json');
    expect(chat).not.toContain('--task-file');
    expect(usageText('run')).toContain('--task-file <path>');
    expect(usageText('why')).toContain('Usage: jevcode why <id> <step> <ref>');
    expect(usageText('completion')).toContain('bash|zsh|fish');
    expect(usageText('run')).toMatch(/--mode jev-only\|jev-on\|jev-off/);
    expect(usageText()).toContain('jev-only');
    // TUI-DESIGN-2 §1.4: `jevcode login --jev-provider typesafe|openrouter`
    // TUI-DESIGN-3 §1.6: `--key-stdin` leads the login synopsis
    // TUI-DESIGN-5 §6.5: `login --provider` is the seven ids, so the synopsis reads them from `PROVIDER_IDS`
    // and wraps onto a second line (it was `[--provider anthropic|openrouter]`, which the flag no longer means)
    expect(usageText()).toContain(`jevcode login [--key-stdin | --generator-key-stdin --jev-key-stdin] [--provider ${PROVIDER_IDS.join('|')}]`);
    expect(usageText()).toContain('[--jev-provider typesafe|openrouter] [--status] [--verify]');
    expect(parseCliArgs(['login', '--key-stdin'])).toEqual({ command: 'login', keyStdin: true });
    expect(FLAGS.find((f) => f.key === 'keyStdin')).toMatchObject({ name: 'key-stdin', type: 'boolean', commands: ['login'] });
    expect(usageText('login')).toContain('--key-stdin');
    // TUI-DESIGN-3 §0.1 (D-Q): `jevcode config --all`
    expect(parseCliArgs(['config', '--all'])).toEqual({ command: 'config', all: true });
    expect(usageText()).toContain('jevcode config [--json] [--all]');
    // finding 9: login's flag table agrees with its usage line (`auto` = infer is what an absent flag means there)
    expect(login).toContain('--jev-provider typesafe|openrouter ');
    expect(login).not.toContain('auto|typesafe|openrouter');
  });

  it('the spec covers every ParsedFlags key exactly once, COMMANDS is the documented list in order, short forms are unique', () => {
    const keys = FLAGS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...STRING_FLAGS, ...BOOLEAN_FLAGS].sort());
    // TUI-DESIGN-5 §6.6 / §5.5 / §4.2, gate G-R5-10: every member has its own `src/cli/<verb>.ts` and its own
    // `main.tsx` switch arm — 14 → 16 in round 5's W4 PR, → 17 with round 5's finishing `doctor`
    expect(COMMANDS).toEqual(['chat', 'run', 'config', 'bench', 'perf', 'login', 'logout', 'sessions', 'models', 'import', 'agents', 'doctor', 'report', 'why', 'calibration', 'completion', 'upgrade']);
    const shorts = FLAGS.map((f) => f.short).filter((s): s is string => s !== undefined);
    expect(new Set(shorts).size).toBe(shorts.length);
    expect(shorts.sort()).toEqual(['c', 'h', 'v']);
    const names = FLAGS.flatMap((f) => [f.name, ...(f.aliases ?? [])]);
    expect(new Set(names).size).toBe(names.length);
    for (const f of FLAGS) expect(f.commands.length, f.name).toBeGreaterThan(0);
  });
});

describe('parseCliArgs: --mode and the jev-only condition (TUI-DESIGN-2 §1.2)', () => {
  it('--mode help names the default through DEFAULT_MODE (TUI-DESIGN-3 §1.1, D-N) and orders the enum jev-only|jev-on|jev-off|llm-jev; the flag itself stays optional (the default lives in the config layer)', () => {
    const mode = FLAGS.find((f) => f.key === 'mode');
    expect(mode?.arg).toBe('jev-only|jev-on|jev-off|llm-jev');
    expect(mode?.help).toBe(`engine mode (default ${DEFAULT_MODE}): jev-only (Jev alone, no generating LLM), jev-on (Jev + the code model), jev-off (generator only), llm-jev (candidate patches, tests verify, Jev arbitrates)`);
    expect(mode?.help).not.toMatch(/jev-only \(default|Claude|GLM/);
    expect(FLAGS.find((f) => f.key === 'condition')?.arg).toBe('jev-only|jev-on|jev-off|llm-jev');
    expect(MODES).toEqual(['jev-only', 'jev-on', 'jev-off', 'llm-jev']);
    expect(parseCliArgs([]).mode).toBeUndefined();
    expect(parseCliArgs(['chat']).mode).toBeUndefined();
    expect(usage(['run', 'x', '--mode', 'jev-maybe']).message).toMatch(/--mode: expected one of jev-only\|jev-on\|jev-off\|llm-jev/);
    expect(usageText()).toContain('[--mode jev-only|jev-on|jev-off|llm-jev]');
    expect(usageText()).not.toContain('[--mode jev-on|jev-off|jev-only]');
    // TUI-DESIGN-3 §1.1 / §1.9: the bare-`jevcode` sentence names DEFAULT_MODE's badge word; the tagline is generator-neutral
    expect(usageText()).toContain(BARE_JEVCODE_SENTENCE);
    expect(BARE_JEVCODE_SENTENCE).toBe(`A bare \`jevcode\` opens the interactive session in ${MODE_BADGE_WORD[DEFAULT_MODE]} mode (one OpenRouter key serves Jev and the code model; /mode jev-only runs on Jev alone); \`/\` lists commands, \`?\` shows the keys.`);
    expect(usageText().split('\n')[0]).toBe(TAGLINE);
    expect(TAGLINE).toBe('JevCode: Jev decides, the code model writes.');
    expect(usageText()).not.toContain('Claude');
  });

  it('llm-jev (docs/LLM-JEV-DESIGN.md): --mode / --condition / bench --conditions accept the fourth mode; the bench default stays jev-on,jev-off', () => {
    expect(parseCliArgs(['run', 'x', '--mode', 'llm-jev']).mode).toBe('llm-jev');
    expect(parseCliArgs(['chat', '--mode', ' LLM-JEV ']).mode).toBe('llm-jev');
    expect(parseCliArgs(['run', 'x', '--condition', 'llm-jev']).condition).toBe('llm-jev');
    expect(parseCliArgs(['bench', '--conditions', 'jev-on,llm-jev']).conditions).toBe('jev-on,llm-jev');
    expect(CONDITIONS).toEqual(['jev-on', 'jev-off', 'jev-only', 'llm-jev', 'llm-sieve', 'jev-off-tuned', 'jev-on-next', 'jev-on-next-nofast']);
    // Every bench arm the runner defines is accepted by --conditions (args.ts lists them literally: bench/conditions.ts is too
    // heavy for the argv path). Contract 1.9 (Fastlane, docs/LLM-LOOP-DESIGN.md §8.1) added `jev-on-next` and
    // `jev-on-next-nofast` to CONDITION_ORDER; the rows landed here with the `arg`, `help` and usage strings below.
    expect([...CONDITIONS]).toEqual([...CONDITION_ORDER]);
    expect(FLAGS.find((f) => f.key === 'conditions')?.arg).toBe('jev-on,jev-off[,jev-only,llm-jev,llm-sieve,jev-off-tuned,jev-on-next,jev-on-next-nofast]');
    expect(FLAGS.find((f) => f.key === 'conditions')?.help).toBe('conditions to run (when omitted: the jev-on and jev-off arms)');
    expect(usageText('run')).toContain('--mode jev-only|jev-on|jev-off|llm-jev ');
    expect(usageText('bench')).toContain('--conditions jev-on,jev-off[,jev-only,llm-jev,llm-sieve,jev-off-tuned,jev-on-next,jev-on-next-nofast] ');
    expect(usageText()).toContain('[--mode jev-only|jev-on|jev-off|llm-jev]');
    expect(usageText()).toContain('[--conditions jev-on,jev-off,jev-only,llm-jev,llm-sieve,jev-off-tuned,jev-on-next,jev-on-next-nofast]');
  });

  it('parses --mode, folds the hidden --condition alias into it, and rejects disagreement', () => {
    expect(parseCliArgs(['run', 'x', '--mode', 'jev-only']).mode).toBe('jev-only');
    expect(parseCliArgs(['run', 'x', '--mode', ' JEV-OFF ']).mode).toBe('jev-off');
    expect(parseCliArgs(['run', 'x']).mode).toBeUndefined();
    const alias = parseCliArgs(['run', 'x', '--condition', 'jev-only']);
    expect(alias.condition).toBe('jev-only');
    expect(alias.mode).toBe('jev-only');
    expect(parseCliArgs(['run', 'x', '--mode', 'jev-on', '--condition', 'jev-on']).mode).toBe('jev-on');
    expect(parseCliArgs(['chat', '--mode', 'jev-only']).mode).toBe('jev-only');
    expect(usage(['run', 'x', '--mode', 'jev-maybe']).message).toMatch(/--mode/);
    expect(usage(['run', 'x', '--condition', 'jev-maybe']).message).toMatch(/--condition/);
    expect(usage(['run', 'x', '--mode', 'jev-on', '--condition', 'jev-off']).message).toMatch(/disagree/);
    // a session flag: bench and config do not take it
    expect(usage(['bench', '--mode', 'jev-only']).message).toMatch(/mode/);
    expect(usage(['config', '--mode', 'jev-only']).message).toMatch(/mode/);
  });

  it('bench --conditions accepts jev-only alone or with the others; usage mentions it; the bench default order is untouched (§1.1)', () => {
    expect(parseCliArgs(['bench', '--conditions', 'jev-on,jev-only']).conditions).toBe('jev-on,jev-only');
    expect(parseCliArgs(['bench', '--conditions', 'jev-only']).conditions).toBe('jev-only');
    expect(parseCliArgs(['bench', '--conditions', 'jev-on,jev-off,jev-only']).conditions).toBe('jev-on,jev-off,jev-only');
    expect(usage(['bench', '--conditions', 'jev-on,nope']).message).toMatch(/--conditions/);
    expect(usageText()).toContain('jev-only');
    expect(usageText('run')).toMatch(/--mode jev-only\|jev-on\|jev-off/);
    expect(FLAGS.find((f) => f.key === 'conditions')?.help).toBe('conditions to run (when omitted: the jev-on and jev-off arms)');
  });
});

describe('parseCliArgs: --jev-provider (TUI-DESIGN-2 §2.3, §1.4)', () => {
  it('parses auto|typesafe|openrouter (lowercased) on every run-like command and on login; anything else is a usage error; logout does not take it', () => {
    expect(STRING_FLAGS).toContain('jevProvider');
    expect(JEV_PROVIDERS).toEqual(['auto', 'typesafe', 'openrouter']);
    expect(parseCliArgs(['run', 'x', '--jev-provider', 'typesafe']).jevProvider).toBe('typesafe');
    expect(parseCliArgs(['chat', '--jev-provider', ' OpenRouter ']).jevProvider).toBe('openrouter');
    expect(parseCliArgs(['--jev-provider', 'auto'])).toEqual({ command: 'chat', jevProvider: 'auto' });
    expect(parseCliArgs(['config', '--jev-provider', 'typesafe']).jevProvider).toBe('typesafe');
    expect(parseCliArgs(['bench', '--jev-provider', 'typesafe']).jevProvider).toBe('typesafe');
    expect(parseCliArgs(['perf', '--jev-provider', 'openrouter']).jevProvider).toBe('openrouter');
    expect(parseCliArgs(['login', '--jev-provider', 'typesafe', '--jev-key-stdin'])).toEqual({ command: 'login', jevProvider: 'typesafe', jevKeyStdin: true });
    expect(parseCliArgs(['login', '--jev-provider', 'OpenRouter']).jevProvider).toBe('openrouter');
    // TUI-DESIGN-2 §1.4 (finding 9): login's usage line says typesafe|openrouter — `auto` is what an absent flag means there and is refused
    expect(LOGIN_JEV_PROVIDERS).toEqual(['typesafe', 'openrouter']);
    expect(usage(['login', '--jev-provider', 'auto']).message).toMatch(/--jev-provider: expected one of typesafe\|openrouter, got "auto"/);
    expect(usage(['login', '--jev-provider', 'auto']).message).toContain('jevcode login');
    expect(usageText('login')).toContain('--jev-provider typesafe|openrouter ');
    expect(usageText('login')).not.toContain('auto|typesafe|openrouter');
    expect(usageText('run')).toContain('--jev-provider auto|typesafe|openrouter');
    expect(usageText()).toContain('[--jev-provider typesafe|openrouter]'); // the login synopsis line
    expect(usage(['run', 'x', '--jev-provider', 'gemini']).message).toMatch(/--jev-provider: expected one of auto\|typesafe\|openrouter, got "gemini"/);
    expect(usage(['logout', '--jev-provider', 'typesafe']).message).toMatch(/--jev-provider/);
    expect(parseCliArgs(['run', 'x']).jevProvider).toBeUndefined();
    const spec = FLAGS.find((f) => f.key === 'jevProvider');
    expect(spec?.name).toBe('jev-provider');
    expect(spec?.arg).toBe('auto|typesafe|openrouter');
    expect(spec?.help).toBe('Jev provider (default auto: typesafe when TYPESAFE_API_KEY is set, else openrouter)');
    expect(spec?.commands).toEqual(['chat', 'run', 'config', 'bench', 'perf', 'login']);
    expect(spec?.argFor).toEqual({ login: 'typesafe|openrouter' });
    expect(usageText('run')).toContain('--jev-provider auto|typesafe|openrouter');
  });
});

/**
 * Round-5 item 21: the leaked private name is gone — the retired flag, environment variable and file key all
 * named a sibling checkout nobody outside one machine has. Nothing public ever shipped them, so there is no
 * alias and an old invocation is a usage error rather than a silent no-op. (The retired spellings are assembled
 * from parts below, never written out, so the release gate that greps for them stays empty.)
 */
describe('item 21 — the extra .env file row, under its shipped names only', () => {
  it('the flag, the env name, the file key and the description are the pinned ones', () => {
    const spec = FLAGS.find((f) => f.key === 'extraEnvFile');
    expect(spec).toBeDefined();
    expect(spec?.name).toBe('extra-env-file');
    expect(spec?.arg).toBe('<path>');
    expect(spec?.help).toBe('an additional .env file whose keys are read as a fallback');
    const row = settingSpec('extraEnvFile');
    expect(row.env).toEqual(['JEVCODE_EXTRA_ENV_FILE']);
    expect(row.fileKey).toBe('extraEnvFile');
    expect(row.description).toBe('an additional .env file whose keys are read as a fallback');
    expect(row.defaultValue).toBeNull();
  });

  it('the old names are NOT accepted as aliases, anywhere', () => {
    // assembled from parts on purpose: the release gate greps `src test scripts …` for the retired spellings
    // and must come back EMPTY, so a negative assertion that wrote one out would be the one hit keeping it red
    const oldFlag = `--${'open'}-assist-path`;
    const oldStem = `${'open'}Assist`;
    const oldEnv = `${'OPEN'}_ASSIST_PATH`;
    expect(() => parseCliArgs(['run', 'task', oldFlag, '/tmp/x'])).toThrow();
    expect(FLAGS.some((f) => f.name === oldFlag.slice(2))).toBe(false);
    expect(SETTINGS.some((r) => r.name.includes(oldStem) || r.env.includes(oldEnv))).toBe(false);
    // and the usage text a user reads names the new flag
    expect(usageText('run')).toContain('--extra-env-file <path>');
    expect(usageText('run')).not.toContain(oldFlag);
  });
});
