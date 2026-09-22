/**
 * TUI-DESIGN-5 §10 R5-6 `cli/args.test.ts` — round 5's half of the flag table (the landed rows stay in
 * `test/unit/config/args.test.ts`): the `models` command and its verbs, the seven-provider `--provider`, and the
 * shape gate G-R5-10 asks for (`Command` has its expected members, **the new ones named literally**).
 */
import { describe, expect, it } from 'vitest';
import { COMMANDS, MODELS_OPS, parseCliArgs, usageText, type Command } from '../../../src/cli/args.js';
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
