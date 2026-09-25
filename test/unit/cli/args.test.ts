/**
 * TUI-DESIGN-5 §10 R5-6 `cli/args.test.ts` — round 5's half of the flag table (the landed rows stay in
 * `test/unit/config/args.test.ts`): the `models` command and its verbs, the seven-provider `--provider`, and the
 * shape gate G-R5-10 asks for (`Command` has its expected members, **the new ones named literally**).
 */
import { describe, expect, it } from 'vitest';
import { COMMANDS, MODELS_OPS, parseCliArgs, usageText, type Command } from '../../../src/cli/args.js';
import { AGENT_VERIFY_SETTING_VALUES, AUTONOMY_SETTING_VALUES, DEFAULT_AGENT_VERIFY, DEFAULT_AUTONOMY } from '../../../src/config/defaults.js';
import { PROVIDER_IDS } from '../../../src/provider/ids.js';
import { UsageError } from '../../../src/errors.js';

const parse = (argv: readonly string[]): ReturnType<typeof parseCliArgs> => parseCliArgs(argv);
function usage(argv: readonly string[]): UsageError {
  try {
    parseCliArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) return e;
    throw e;
  }
  throw new Error(`expected UsageError for ${argv.join(' ')}`);
}

describe('gate G-R5-10: the Command array, its new members named literally', () => {
  it('has exactly its expected members, with `import`, `models`, `agents` and `doctor` named (not merely counted)', () => {
    /**
     * G-R5-10's own wording: "`Command` has exactly its 16 members, the three new ones named literally:
     * `'import'`, `'models'`, `'agents'`" — "its expected members" would have passed with `agents` absent, which
     * is precisely the defect (§14.2 #7). All three are here now: each arrived with its own `src/cli/<verb>.ts`
     * AND its `main.tsx` `switch` arm, because the switch is exhaustive and a member with no arm is a compile
     * error, not a missing feature.
     */
    for (const c of ['import', 'models', 'agents', 'doctor'] as const) expect(COMMANDS, c).toContain(c);
    expect(new Set(COMMANDS).size).toBe(COMMANDS.length);
    const expected: readonly Command[] = ['chat', 'run', 'config', 'bench', 'perf', 'login', 'logout', 'sessions', 'models', 'import', 'agents', 'doctor', 'report', 'why', 'calibration', 'completion', 'upgrade'];
    expect(COMMANDS).toEqual(expected);
    // 16 after round 5's W4 PR; 17 with the finishing wave's `doctor`, which arrived the same way — its own
    // `src/cli/doctor.ts` AND its own `main.tsx` arm
    expect(COMMANDS).toHaveLength(17);
  });
});

describe('jevcode models — the verbs (§6.6)', () => {
  it('a bare `models` is `list`', () => {
    expect(parse(['models']).modelsOp).toBe('list');
    expect(parse(['models']).command).toBe('models');
  });

  it.each(MODELS_OPS)('%s parses', (op) => {
    expect(parse(op === 'search' ? ['models', op, 'glm'] : ['models', op]).modelsOp).toBe(op);
  });

  it('search takes free text, space-joined like `run`’s task', () => {
    expect(parse(['models', 'search', 'gpt', '6', 'astra']).query).toBe('gpt 6 astra');
    expect(parse(['models', 'search', '  glm  ']).query).toBe('glm');
  });

  it('search with nothing after it is a usage error that names the form', () => {
    expect(usage(['models', 'search']).message).toContain('jevcode models search <query>');
  });

  it('an unknown verb names the three, and list/refresh take no extra words', () => {
    expect(usage(['models', 'wat']).message).toContain('expected one of list|search|refresh');
    expect(usage(['models', 'list', 'glm']).message).toContain('takes no further arguments');
    expect(usage(['models', 'refresh', 'x']).message).toContain('takes no further arguments');
  });

  it('accepts exactly the five flags §6.6 needs and refuses the rest', () => {
    expect(parse(['models', 'list', '--provider', 'xai']).provider).toBe('xai');
    expect(parse(['models', 'list', '--json']).json).toBe(true);
    expect(parse(['models', 'list', '--plain']).plain).toBe(true);
    expect(parse(['models', 'list', '--ascii']).ascii).toBe(true);
    expect(parse(['models', 'list', '--screen-reader']).screenReader).toBe(true);
    // a `models` run resolves no config and starts no engine, so the run flags have no meaning here
    expect(() => parse(['models', 'list', '--mode', 'jev-on'])).toThrow(UsageError);
    expect(() => parse(['models', 'list', '--resume', 'x'])).toThrow(UsageError);
    expect(() => parse(['models', 'list', '--spend-cap', '2'])).toThrow(UsageError);
  });

  it('`--json=verbose` is refused: models has no event stream', () => {
    expect(usage(['models', 'list', '--json=bogus']).message).toContain('--json');
  });
});

describe('--provider is the seven ids everywhere it is accepted (§6.1 D-AP, §6.3)', () => {
  it.each(PROVIDER_IDS)('%s is accepted on run', (id) => {
    expect(parse(['run', 'task', '--provider', id]).provider).toBe(id);
  });

  it('is case- and space-insensitive, and the refusal names all seven', () => {
    expect(parse(['run', 'task', '--provider', ' Gemini ']).provider).toBe('gemini');
    expect(usage(['run', 'task', '--provider', 'llama']).message).toContain(PROVIDER_IDS.join('|'));
  });

  it('`login --provider <id>` accepts the five new ones too (§6.5: the wizard stays binary, its CLI twin does not)', () => {
    expect(parse(['login', '--provider', 'openai']).provider).toBe('openai');
    expect(parse(['login', '--provider', 'fireworks']).provider).toBe('fireworks');
  });

  it('the usage line and the help text name PROVIDER_IDS, never a re-declared pair', () => {
    expect(usageText('models')).toContain('Usage: jevcode models [list|search <query>|refresh]');
    expect(usageText('models')).toContain(PROVIDER_IDS.join('|'));
    expect(usageText()).toContain('jevcode models [list | search <query> | refresh]');
    expect(usageText()).toContain('list and search read the disk cache and the bundled snapshot; refresh is the explicit fetch');
    expect(usageText('run')).toContain(PROVIDER_IDS.join('|'));
  });

  it('`jevcode login --help` names the SEVEN too — the usage line and the flag table cannot disagree', () => {
    // §6.5 widened `login --provider` to all seven and routes five of them to the free verify path; the usage
    // line still advertised `[--provider anthropic|openrouter]`, contradicting both the flag table and the
    // ConfigError `generatorProviderFor` throws
    // the synopsis (`USAGE_LINES`, what the man page and `jevcode --help` print)
    expect(usageText()).toContain(`jevcode login [--key-stdin | --generator-key-stdin --jev-key-stdin] [--provider ${PROVIDER_IDS.join('|')}]`);
    expect(usageText()).not.toContain('[--provider anthropic|openrouter]');
    expect(usageText()).toContain('[--jev-provider typesafe|openrouter]');
    // and the per-command flag table, which reads the same one table
    expect(usageText('login')).toContain(`--provider ${PROVIDER_IDS.join('|')}`);
    expect(usageText('login')).not.toMatch(/--provider anthropic\|openrouter\s/);
  });
});

describe('complete autonomy by default: `--autonomy full|review`', () => {
  it('parses on chat / run / config, is refused where no config is resolved, and its value is kept verbatim for config/validate.ts', () => {
    expect(parse(['run', 'task', '--autonomy', 'review']).autonomy).toBe('review');
    expect(parse(['run', 'task', '--autonomy', 'full']).autonomy).toBe('full');
    expect(parse(['chat', '--autonomy', 'review']).autonomy).toBe('review');
    expect(parse(['config', '--autonomy', 'review']).autonomy).toBe('review');
    expect(parse(['run', 'task']).autonomy).toBeUndefined();
    // an unknown value is the config layer's ConfigError, not a UsageError: `--mode` works the same way
    expect(parse(['run', 'task', '--autonomy', 'yolo']).autonomy).toBe('yolo');
    expect(() => parse(['models', 'list', '--autonomy', 'review'])).toThrow(UsageError);
  });

  it('the help text names the enum and the default, and says what each side does', () => {
    expect(usageText('run')).toContain('--autonomy full|review');
    expect(usageText('run')).toContain(`who approves risky commands (default ${DEFAULT_AUTONOMY})`);
    // AGENT-LOOP-DESIGN §A2: full never asks and never refuses (the legacy "a blocked action always stops" is gone from the help)
    expect(usageText('run')).toContain('full never asks (a destructive command runs in the sandbox and leaves a note), review asks y/n before destructive and unrecognised ones');
    expect(usageText('run')).not.toContain('a blocked action always stops');
    expect(usageText('config')).toContain('--autonomy full|review');
    expect(AUTONOMY_SETTING_VALUES.join('|')).toBe('full|review');
  });
});

describe('the model checks its own work by default: `--agent-verify off|tests`', () => {
  it('parses on chat / run / config, is refused where no config is resolved, and its value is kept verbatim for config/validate.ts', () => {
    expect(parse(['run', 'task', '--agent-verify', 'tests']).agentVerify).toBe('tests');
    expect(parse(['run', 'task', '--agent-verify', 'off']).agentVerify).toBe('off');
    expect(parse(['chat', '--agent-verify', 'tests']).agentVerify).toBe('tests');
    expect(parse(['config', '--agent-verify', 'tests']).agentVerify).toBe('tests');
    expect(parse(['run', 'task']).agentVerify).toBeUndefined();
    // an unknown value is the config layer's ConfigError, not a UsageError, as with --autonomy
    expect(parse(['run', 'task', '--agent-verify', 'always']).agentVerify).toBe('always');
    expect(() => parse(['models', 'list', '--agent-verify', 'tests'])).toThrow(UsageError);
    // login's `--verify` is a different flag: a boolean that checks the saved keys
    expect(parse(['login', '--verify']).verify).toBe(true);
  });

  it('the help text names the enum and the default, and says what each side does', () => {
    expect(usageText('run')).toContain('--agent-verify off|tests');
    expect(usageText('run')).toContain(`who checks an agent run before it finishes (default ${DEFAULT_AGENT_VERIFY})`);
    expect(usageText('run')).toContain('(default off)');
    expect(usageText('run')).toContain('off = the model runs the checks the change calls for; tests = the harness also runs the detected test command after changes');
    expect(usageText('chat')).toContain('--agent-verify off|tests');
    expect(usageText('config')).toContain('--agent-verify off|tests');
    expect(AGENT_VERIFY_SETTING_VALUES.join('|')).toBe('off|tests');
  });
});
