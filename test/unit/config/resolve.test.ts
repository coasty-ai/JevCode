import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCliArgs, type ParsedFlags } from '../../../src/cli/args.js';
import { detectPackageRoot, isEngineMode, modeFromParsedFlags, negateBooleanText, reconcileResumeConfig, resolveConfig, resumeIdentityFromRunMeta, type ResolveOptions } from '../../../src/config/resolve.js';
import { AGENT_DEFAULT_MAX_STEPS, BASE_URLS, DEFAULT_MODE, DEFAULT_MODEL } from '../../../src/config/defaults.js';
import { PROVIDER_DEFAULT_MODEL, PROVIDER_IDS } from '../../../src/provider/ids.js';
import { PROVIDERS } from '../../../src/provider/registry.js';
import { defaultRunSpendCapUsd } from '../../../src/config/ui.js';
import type { RunMeta } from '../../../src/core/types.js';
import { fingerprint } from '../../../src/config/mask.js';
import { ConfigError } from '../../../src/errors.js';
import { configTableLines, configTableRows } from '../../../src/cli/config-table.js';
import { writeCredentials } from '../../../src/config/credentials.js';

const FIX = join(import.meta.dirname, '../../fixtures/config');
const OR_KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

let root: string;
let cwd: string;
let home: string;
let pkg: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'jevcode-cfg-')));
  cwd = join(root, 'ws');
  home = join(root, 'home');
  pkg = join(root, 'pkg', 'JevCode');
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(pkg, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const run = (...argv: string[]): ParsedFlags => parseCliArgs(['run', 'task', ...argv]);
const resolve = (flags: ParsedFlags, env: NodeJS.ProcessEnv = {}, opts: ResolveOptions = {}) => resolveConfig(flags, env, cwd, { homedir: home, ...opts });

describe('resolveConfig precedence', () => {
  it('uses defaults with their source when nothing is set, and never throws for a missing key', async () => {
    const c = await resolve(run());
    expect(c.entries.get('generator.provider')).toEqual({ value: 'openrouter', source: 'default' });
    expect(c.entries.get('generator.model')).toEqual({ value: 'z-ai/glm-5.3-flash', source: 'default' });
    expect(c.entries.get('decider.model')).toEqual({ value: 'typesafe/jev-1.13-20260917', source: 'default' });
    expect(c.entries.get('limits.maxWall')).toEqual({ value: '30m', source: 'default' });
    expect(c.entries.has('generator.apiKey')).toBe(false);
    expect(c.workspace).toBe(cwd);
    expect(c.runsDir).toBe(join(home, '.jevcode', 'runs'));
    expect(c.extraEnvFile).toBeNull();
    expect(c.configFile).toBeNull();
    expect(c.dotenvFiles).toEqual([]);
    expect(c.sandbox).toBe('auto');
    expect(c.noNetwork).toBe(false);
    expect(c.plain).toBe(false);
    expect(c.warnings).toEqual([]);
    expect(c.limits()).toEqual({
      // AGENT-LOOP-DESIGN §14.2: the agent default's step cap is AGENT_DEFAULT_MAX_STEPS when unset (a legacy mode keeps 40)
      maxSteps: AGENT_DEFAULT_MAX_STEPS,
      maxWallMs: 30 * 60_000,
      maxReplans: 5,
      completeThreshold: 0.85,
      impossibleThreshold: 0.85,
      commandTimeoutMs: 120_000,
      maxCommandTimeoutMs: 600_000,
      maxOutputBytes: 200 * 1024,
      // TUI-DESIGN-2 §1.2 / TUI-DESIGN-3 §1.1: zero arguments resolve to DEFAULT_MODE, whose mode-keyed run-cap default follows (P45)
      spendCapUsd: defaultRunSpendCapUsd(DEFAULT_MODE),
    });
    expect(c.mode).toBe(DEFAULT_MODE);
    expect(c.entries.get('mode')).toEqual({ value: DEFAULT_MODE, source: 'default' });
  });

  it('flag > env > ./.env > <JEVCODE_EXTRA_ENV_FILE> > config file > default, one layer at a time', async () => {
    const oa = join(root, 'extra');
    await mkdir(oa);
    await writeFile(join(oa, '.env'), 'JEVCODE_MODEL=from-oa\nJEVCODE_MAX_STEPS=4\nJEV_MODEL=jev-1.13\nJEVCODE_SPEND_CAP_USD=1\n');
    await writeFile(join(cwd, '.env'), 'JEVCODE_MODEL=from-dotenv\nJEVCODE_MAX_STEPS=3\nJEV_MODEL=typesafe/jev-1.13\n');
    await writeFile(join(cwd, 'jevcode.json'), JSON.stringify({ model: 'from-file', maxSteps: 5, jevModel: 'jev-1.13-20260101', spendCapUsd: 0.25, maxReplans: 1 }));
    const env = { JEVCODE_MODEL: 'from-env', JEVCODE_MAX_STEPS: '2', JEVCODE_EXTRA_ENV_FILE: join(oa, '.env') };

    const c = await resolve(run('--model', 'from-flag'), env);
    expect(c.entries.get('generator.model')).toEqual({ value: 'from-flag', source: 'flag' });
    expect(c.entries.get('limits.maxSteps')).toEqual({ value: '2', source: 'env' });
    expect(c.entries.get('decider.model')).toEqual({ value: 'typesafe/jev-1.13', source: `dotenv:${join(cwd, '.env')}` });
    expect(c.entries.get('limits.spendCapUsd')).toEqual({ value: '1', source: `dotenv:${join(oa, '.env')}` });
    expect(c.entries.get('limits.maxReplans')).toEqual({ value: '1', source: `file:${join(cwd, 'jevcode.json')}` });
    expect(c.entries.get('limits.completeThreshold')).toEqual({ value: '0.85', source: 'default' });
    expect(c.entries.get('extraEnvFile')).toEqual({ value: join(oa, '.env'), source: 'env' });
    expect(c.configFile).toBe(join(cwd, 'jevcode.json'));
    expect(c.dotenvFiles).toEqual([join(cwd, '.env'), join(oa, '.env')]);

    const c2 = await resolve(run(), { ...env, JEVCODE_MODEL: '' });
    expect(c2.entries.get('generator.model')).toEqual({ value: 'from-dotenv', source: `dotenv:${join(cwd, '.env')}` });
    await writeFile(join(cwd, '.env'), 'JEVCODE_MODEL=\n');
    const c3 = await resolve(run(), { JEVCODE_EXTRA_ENV_FILE: join(oa, '.env') });
    expect(c3.entries.get('generator.model')).toEqual({ value: 'from-oa', source: `dotenv:${join(oa, '.env')}` });
    const c4 = await resolve(run());
    expect(c4.entries.get('generator.model')).toEqual({ value: 'from-file', source: `file:${join(cwd, 'jevcode.json')}` });
    await rm(join(cwd, 'jevcode.json'));
    const c5 = await resolve(run());
    expect(c5.entries.get('generator.model')).toEqual({ value: 'z-ai/glm-5.3-flash', source: 'default' });
  });

  it('an unset generator.model is the resolved provider\'s own default — `--provider openai` alone never sends the OpenRouter id', async () => {
    // the S6 final review: `--provider openai|anthropic|xai` with no --model sent `z-ai/glm-5.3-flash` and every message 404ed
    const openai = await resolve(run('--provider', 'openai'));
    expect(openai.entries.get('generator.model')).toEqual({ value: 'gpt-5.6-luna', source: 'default' });
    for (const id of PROVIDER_IDS) {
      const c = await resolve(run('--provider', id));
      expect(c.entries.get('generator.model')).toEqual({ value: PROVIDER_DEFAULT_MODEL[id], source: 'default' });
      expect(c.entries.get('generator.model')?.value).toBe(PROVIDERS.find((p) => p.id === id)?.defaultModel);
    }
    // the provider from the environment keys the default the same way; an explicit model always wins
    expect((await resolve(run(), { JEVCODE_PROVIDER: 'anthropic' })).entries.get('generator.model')).toEqual({ value: 'claude-sonnet-5', source: 'default' });
    expect((await resolve(run('--provider', 'xai', '--model', 'grok-4.7-mini'))).entries.get('generator.model')).toEqual({ value: 'grok-4.7-mini', source: 'flag' });
    expect((await resolve(run('--provider', 'openai'), { JEVCODE_MODEL: 'gpt-6-astra' })).entries.get('generator.model')).toEqual({ value: 'gpt-6-astra', source: 'env' });
    // the OpenRouter row IS config/defaults.ts DEFAULT_MODEL
    expect(PROVIDER_DEFAULT_MODEL.openrouter).toBe(DEFAULT_MODEL);
  });

  it('record() keeps every source and masks secrets as { source, fingerprint }, flag keys included', async () => {
    await writeFile(join(cwd, '.env'), `OPENROUTER_API_KEY=${OR_KEY}\n`);
    const c = await resolve(run('--api-key', 'flagkey-ABCDEF0123456789-XYZ', '--provider', 'openrouter'));
    const rec = c.record();
    expect(rec['generator.apiKey']).toEqual({ value: { source: 'flag', fingerprint: fingerprint('flagkey-ABCDEF0123456789-XYZ') }, source: 'flag' });
    expect(rec['decider.apiKey']).toEqual({ value: { source: `dotenv:${join(cwd, '.env')}`, fingerprint: fingerprint(OR_KEY) }, source: `dotenv:${join(cwd, '.env')}` });
    expect(rec['generator.provider']).toEqual({ value: 'openrouter', source: 'flag' });
    expect(JSON.stringify(rec)).not.toContain('flagkey');
    expect(JSON.stringify(rec)).not.toContain(OR_KEY.slice(0, 12));
    for (const v of Object.values(rec)) expect(typeof v.source).toBe('string');
  });
});

describe('resolveConfig keys and lazy validation', () => {
  it('generator key by provider (the default openrouter reads OPENROUTER_API_KEY), with JEVCODE_API_KEY as the fallback; decider key falls back to OPENROUTER_API_KEY', async () => {
    // the default provider is openrouter: one OPENROUTER_API_KEY serves the generator and Jev; an Anthropic key alone is not the generator key
    const a = await resolve(run(), { ANTHROPIC_API_KEY: 'anthropic-key-1234', OPENROUTER_API_KEY: OR_KEY });
    expect(a.generator()).toMatchObject({ provider: 'openrouter', model: 'z-ai/glm-5.3-flash', apiKey: OR_KEY, baseUrl: 'https://openrouter.ai/api/v1', priced: true });
    expect(a.decider().apiKey).toBe(OR_KEY);
    // --provider anthropic --model claude-sonnet-5 still works and switches the key variable
    const b = await resolve(run('--provider', 'anthropic', '--model', 'claude-sonnet-5'), { ANTHROPIC_API_KEY: 'anthropic-key-1234', OPENROUTER_API_KEY: OR_KEY });
    expect(b.generator()).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'anthropic-key-1234', baseUrl: 'https://api.anthropic.com', priced: true });
    expect(b.decider().apiKey).toBe(OR_KEY);
    const c = await resolve(run(), { JEVCODE_API_KEY: 'generic-key-1234', JEV_API_KEY: 'jev-key-12345678' });
    expect(c.generator().apiKey).toBe('generic-key-1234');
    expect(c.decider().apiKey).toBe('jev-key-12345678');
    // the provider-specific name wins over the generic one within the same layer
    const c2 = await resolve(run(), { JEVCODE_API_KEY: 'generic-key-1234', OPENROUTER_API_KEY: OR_KEY });
    expect(c2.generator().apiKey).toBe(OR_KEY);
    // env layer beats the dotenv layer even when the dotenv holds the provider-specific name
    await writeFile(join(cwd, '.env'), `OPENROUTER_API_KEY=${OR_KEY}\n`);
    const d = await resolve(run(), { JEVCODE_API_KEY: 'generic-key-1234' });
    expect(d.entries.get('generator.apiKey')).toEqual({ value: 'generic-key-1234', source: 'env' });
  });

  it('generator() throws ConfigError naming the setting and the sources consulted; resolveConfig itself does not', async () => {
    await writeFile(join(cwd, '.env'), 'SOME_PLAIN=x\n');
    const c = await resolve(run());
    let err: unknown;
    try {
      c.generator();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const ce = err as ConfigError;
    expect(ce.setting).toBe('generator.apiKey');
    expect(ce.exitCode).toBe(2);
    expect(ce.message).toContain('--api-key (flag)');
    // the default provider is openrouter, so the missing-key error names OPENROUTER_API_KEY
    expect(ce.message).toContain('generator.apiKey: the openrouter API key is not set');
    expect(ce.message).toContain('OPENROUTER_API_KEY / JEVCODE_API_KEY (env)');
    expect(ce.message).not.toContain('ANTHROPIC_API_KEY');
    expect(ce.message).toContain(`dotenv:${join(cwd, '.env')}`);
    expect(ce.message).toContain('no default');
    expect(() => c.decider()).toThrow(/decider\.apiKey/);
    expect(() => c.decider()).toThrow(/JEV_API_KEY \/ OPENROUTER_API_KEY/);
    expect(c.limits().maxSteps).toBe(AGENT_DEFAULT_MAX_STEPS);
    // --provider anthropic names its own variable
    const anthropic = await resolve(run('--provider', 'anthropic'));
    expect(() => anthropic.generator()).toThrow(/generator\.apiKey: the anthropic API key is not set.*ANTHROPIC_API_KEY \/ JEVCODE_API_KEY \(env\)/);
  });

  it('validates numbers, URLs and thresholds lazily and memoises the result', async () => {
    const bad = await resolve(run('--max-steps', 'ten'), { OPENROUTER_API_KEY: OR_KEY });
    expect(() => bad.limits()).toThrow(/limits\.maxSteps: "ten" \(from flag\) is not an integer >= 1/);
    const bad2 = await resolve(run('--complete-threshold', '1.5'));
    expect(() => bad2.limits()).toThrow(/limits\.completeThreshold/);
    const bad3 = await resolve(run('--base-url', 'nope'), { OPENROUTER_API_KEY: OR_KEY });
    expect(() => bad3.generator()).toThrow(/generator\.baseUrl: "nope" \(from flag\) is not a URL/);
    const bad4 = await resolve(run(), { JEVCODE_MAX_WALL: 'forever' });
    expect(() => bad4.limits()).toThrow(/limits\.maxWall: "forever" \(from env\) is not a duration/);
    const ok = await resolve(run('--temperature', '0.7', '--max-tokens', '1000', '--max-wall', '90s', '--spend-cap', '0.1'), { OPENROUTER_API_KEY: OR_KEY });
    const g = ok.generator();
    expect(g.temperature).toBe(0.7);
    expect(g.maxTokens).toBe(1000);
    expect(ok.generator()).toBe(g);
    expect(ok.limits().maxWallMs).toBe(90_000);
    expect(ok.limits().spendCapUsd).toBe(0.1);
    expect(ok.limits()).toBe(ok.limits());
    const noTemp = await resolve(run(), { OPENROUTER_API_KEY: OR_KEY });
    expect(noTemp.generator().temperature).toBeNull();
  });

  it('decider(): verbatim model, pinned iff the normalised id ends in -YYYYMMDD, URL trailing slash stripped', async () => {
    const env = { OPENROUTER_API_KEY: OR_KEY };
    // contract 1.2 (TUI-DESIGN-2 §6 item 4): provider, pricing and providerSource ride the DeciderConfig
    // TUI-DESIGN-2 §2.3 rule 2d: an OPENROUTER_API_KEY alone infers openrouter (`auto:openrouter-key`)
    expect((await resolve(run(), env)).decider()).toEqual({ provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/alpha/decisions', apiKey: OR_KEY, model: 'typesafe/jev-1.13-20260917', pinned: true, pricing: { inputUsdPerToken: 4.2e-8, outputUsdPerToken: 0 }, providerSource: 'auto:openrouter-key' });
    expect((await resolve(run('--jev-model', 'TypeSafe/Jev-1.13'), env)).decider()).toMatchObject({ model: 'TypeSafe/Jev-1.13', pinned: false });
    expect((await resolve(run('--jev-model', 'jev-1.13-20260917', '--jev-base-url', 'https://proxy.test/decisions/'), env)).decider()).toMatchObject({ pinned: true, baseUrl: 'https://proxy.test/decisions' });
    const badModel = await resolve(run('--jev-model', '!!bad'), env);
    expect(() => badModel.decider()).toThrow(/decider\.model/);
  });

  it('decider(): a configured base URL on api.typesafe.ai names the typesafe provider (TUI-DESIGN-2 §2.3 rule 2a) with provider-aware pinning (§2.5)', async () => {
    const env = { JEV_API_KEY: 'jev-key-12345678' };
    const ts = (await resolve(run('--jev-model', 'jev-1.13.0', '--jev-base-url', 'https://api.typesafe.ai/v1/systemone'), env)).decider();
    expect(ts).toMatchObject({ provider: 'typesafe', providerSource: 'auto:base-url', model: 'jev-1.13.0', pinned: true, baseUrl: 'https://api.typesafe.ai/v1/systemone', pricing: { inputUsdPerToken: 4.2e-8, outputUsdPerToken: 0 } });
    // jev-latest is an alias on TypeSafe; the dated OpenRouter id is refused offline under typesafe (§2.5)
    expect((await resolve(run('--jev-model', 'jev-latest', '--jev-base-url', 'https://api.typesafe.ai/v1/systemone'), env)).decider()).toMatchObject({ provider: 'typesafe', pinned: false });
    const dated = await resolve(run('--jev-model', 'jev-1.13-20260917', '--jev-base-url', 'https://api.typesafe.ai/v1/systemone'), env);
    expect(() => dated.decider()).toThrow(/is an OpenRouter id/);
    // an unknown host stays on today's OpenRouter path (JEV_API_KEY → `auto:openrouter-key`, rule 2b); the default URL is never a derivation
    expect((await resolve(run('--jev-base-url', 'https://proxy.test/decisions'), env)).decider()).toMatchObject({ provider: 'openrouter', providerSource: 'auto:openrouter-key' });
    expect((await resolve(run(), env)).decider()).toMatchObject({ provider: 'openrouter', providerSource: 'auto:openrouter-key' });
  });

  it('mode (TUI-DESIGN-2 §1.2 / §6 item 9): the config carries the `mode` setting its caps were keyed on — DEFAULT_MODE, --mode / --condition, or opts.mode on a re-resolve', async () => {
    const env = { OPENROUTER_API_KEY: OR_KEY };
    expect((await resolve(run(), env)).mode).toBe(DEFAULT_MODE);
    expect((await resolve(run('--mode', 'jev-on'), env)).mode).toBe('jev-on');
    expect((await resolve(run('--mode', 'jev-off'), env)).mode).toBe('jev-off');
    expect((await resolve(run('--condition', 'jev-on'), env)).mode).toBe('jev-on');
    expect((await resolve(run(), env, { mode: 'jev-on' })).mode).toBe('jev-on');
    // the run-cap default follows the same value (TUI-DESIGN §9.1, P45; TUI-DESIGN-3 §1.1: keyed on DEFAULT_MODE)
    expect((await resolve(run(), env)).limits().spendCapUsd).toBe(defaultRunSpendCapUsd(DEFAULT_MODE));
    expect((await resolve(run('--mode', 'jev-on'), env)).limits().spendCapUsd).toBe(10);
  });

  it('pricing: table for the default GLM 5.3 Flash and for Sonnet 5, env overrides, zeros plus a warning for unknown models', async () => {
    const env = { OPENROUTER_API_KEY: OR_KEY };
    const dflt = await resolve(run(), env);
    expect(dflt.generator().pricing).toEqual({ inputPerM: 0.15, outputPerM: 0.5, cacheReadPerM: 0.05, cacheWritePerM: expect.closeTo(0.1875, 12) });
    expect(dflt.generator().priced).toBe(true);
    expect(dflt.warnings).toEqual([]);
    expect(dflt.record()['generator.priceCacheReadPerM']).toBeUndefined(); // a table hit: no derived cache rows
    for (const id of ['z-ai/glm-5.3-flashx', 'z-ai/glm-5.3']) expect((await resolve(run('--model', id), env)).generator().priced).toBe(true);
    const a = await resolve(run('--provider', 'openrouter', '--model', 'anthropic/claude-sonnet-5'), env);
    expect(a.generator().pricing).toEqual({ inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5 });
    expect(a.warnings).toEqual([]);
    const b = await resolve(run('--provider', 'openrouter', '--model', 'vendor/other'), env);
    expect(b.generator().pricing).toEqual({ inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0 });
    expect(b.warnings).toHaveLength(1);
    expect(b.warnings[0]).toMatch(/no pricing entry/);
    b.generator();
    expect(b.warnings).toHaveLength(1);
    const c = await resolve(run('--provider', 'openrouter', '--model', 'vendor/other'), { ...env, JEVCODE_PRICE_IN_PER_M: '3', JEVCODE_PRICE_OUT_PER_M: '15' });
    expect(c.generator().pricing).toMatchObject({ inputPerM: 3, outputPerM: 15 });
    expect(c.warnings).toEqual([]);
  });

  it('rejects an invalid provider or sandbox from the env with the setting name; the SEVEN ids resolve (D-AP)', async () => {
    // D-AP, the reader half: `openai` is a provider now — it resolves, with the provider's own base URL from `BASE_URLS`
    const ok = await resolve(run('--model', 'gpt-5.6-luna'), { JEVCODE_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-openai-0123456789abcdef' });
    expect(ok.generator().provider).toBe('openai');
    expect(ok.generator().baseUrl).toBe(BASE_URLS.openai);
    const c = await resolve(run(), { JEVCODE_PROVIDER: 'notaprovider' });
    expect(() => c.generator()).toThrow(/generator\.provider: "notaprovider" \(from env\) is not one of anthropic\|openrouter\|openai\|gemini\|xai\|fireworks\|meta/);
    await expect(resolve(run(), { JEVCODE_SANDBOX: 'jail' })).rejects.toThrow(/sandbox: "jail" \(from env\)/);
  });

  it('stores the sandbox profile in its normalised form so run.json compares equal on resume', async () => {
    const c = await resolve(run(), { JEVCODE_SANDBOX: ' Seatbelt ' });
    expect(c.sandbox).toBe('seatbelt');
    expect(c.entries.get('sandbox')).toEqual({ value: 'seatbelt', source: 'env' });
    expect(c.record()['sandbox']).toEqual({ value: 'seatbelt', source: 'env' });
    expect((await resolve(run())).entries.get('sandbox')).toEqual({ value: 'auto', source: 'default' });
  });
});

describe('resolveConfig files, paths and secrets', () => {
  it('reads the config file fixture, coerces scalars, warns on unknown keys, reports its path', async () => {
    await copyFile(join(FIX, 'jevcode.json'), join(cwd, 'jevcode.json'));
    const c = await resolve(run());
    expect(c.configFile).toBe(join(cwd, 'jevcode.json'));
    expect(c.entries.get('configFile')).toEqual({ value: join(cwd, 'jevcode.json'), source: 'default' });
    expect(c.entries.get('generator.provider')?.value).toBe('openrouter');
    expect(c.entries.get('limits.maxSteps')?.value).toBe('12');
    expect(c.entries.get('limits.spendCapUsd')?.value).toBe('0.5');
    expect(c.plain).toBe(true);
    expect(c.limits()).toMatchObject({ maxSteps: 12, spendCapUsd: 0.5, maxWallMs: 600_000 });
    expect(c.warnings.some((w) => w.includes('unknownThing'))).toBe(true);
    expect(c.secretPaths).toContain(join(cwd, 'jevcode.json'));
  });

  it('falls back to ~/.config/jevcode/config.json, honours --config and JEVCODE_CONFIG, rejects missing or invalid files eagerly', async () => {
    await mkdir(join(home, '.config', 'jevcode'), { recursive: true });
    await writeFile(join(home, '.config', 'jevcode', 'config.json'), '{"maxReplans": 9}');
    const a = await resolve(run());
    expect(a.configFile).toBe(join(home, '.config', 'jevcode', 'config.json'));
    expect(a.entries.get('limits.maxReplans')).toEqual({ value: '9', source: `file:${join(home, '.config', 'jevcode', 'config.json')}` });

    await writeFile(join(root, 'other.json'), '{"maxReplans": 7}');
    const b = await resolve(run('--config', join(root, 'other.json')));
    expect(b.entries.get('configFile')).toEqual({ value: join(root, 'other.json'), source: 'flag' });
    expect(b.entries.get('limits.maxReplans')?.value).toBe('7');
    const c = await resolve(run(), { JEVCODE_CONFIG: join(root, 'other.json') });
    expect(c.configFile).toBe(join(root, 'other.json'));
    expect(c.entries.get('configFile')?.source).toBe('env');

    await expect(resolve(run('--config', join(root, 'missing.json')))).rejects.toThrow(/configFile: .*missing\.json \(from flag\) does not exist/);
    await writeFile(join(root, 'bad.json'), '{not json');
    await expect(resolve(run('--config', join(root, 'bad.json')))).rejects.toThrow(/not valid JSON/);
    // V8 quotes the first characters of a short unparsable document; a key at the top of a broken config file must not reach the message.
    await writeFile(join(root, 'leak.json'), `${OR_KEY} oops`);
    let leak: unknown;
    try {
      await resolve(run('--config', join(root, 'leak.json')));
    } catch (e) {
      leak = e;
    }
    expect(leak).toBeInstanceOf(ConfigError);
    expect((leak as ConfigError).message).toMatch(/not valid JSON/);
    expect((leak as ConfigError).message).not.toContain(OR_KEY.slice(0, 10));
    expect((leak as ConfigError).message).not.toContain('sk-or-v1');
    await writeFile(join(root, 'arr.json'), '[1]');
    await expect(resolve(run('--config', join(root, 'arr.json')))).rejects.toThrow(/JSON object/);
    await writeFile(join(root, 'obj.json'), '{"model": {"x": 1}}');
    await expect(resolve(run('--config', join(root, 'obj.json')))).rejects.toThrow(/must be a string, number or boolean/);
  });

  it('--extra-env-file names a .env FILE whose keys are a fallback, is a secretPath, and has NO default (§21 rename)', async () => {
    const extra = join(root, 'elsewhere', 'creds.env');
    await mkdir(join(root, 'elsewhere'));
    await writeFile(extra, `JEV_API_KEY=${OR_KEY}\nUNUSED_TOKEN=unused-token-value-1234\n`);
    const c = await resolve(run('--extra-env-file', extra));
    expect(c.extraEnvFile).toBe(extra);
    expect(c.entries.get('extraEnvFile')).toEqual({ value: extra, source: 'flag' });
    expect(c.entries.get('decider.apiKey')).toEqual({ value: OR_KEY, source: `dotenv:${extra}` });
    expect(c.secretPaths).toEqual(expect.arrayContaining([join(cwd, '.env'), extra]));
    expect(c.dotenvFiles).toEqual([extra]);
    expect(c.redact(`x ${OR_KEY} y unused-token-value-1234`)).toBe('x [REDACTED:decider.apiKey] y [REDACTED:UNUSED_TOKEN]');
    // no row set: nothing outside the workspace is consulted, and there is no built-in default path
    const bare = await resolve(run());
    expect(bare.extraEnvFile).toBeNull();
    expect(bare.entries.has('extraEnvFile')).toBe(false);
    expect(bare.dotenvFiles).toEqual([]);
    // a relative value resolves against cwd; a path that does not exist is simply not read
    const missing = await resolve(run('--extra-env-file', 'nowhere.env'));
    expect(missing.extraEnvFile).toBe(join(cwd, 'nowhere.env'));
    expect(missing.dotenvFiles).toEqual([]);
  });

  it('workspace resolves relative to cwd; JEVCODE_HOME is the home whose runs/ is the runs dir; --runs-dir is direct', async () => {
    const a = await resolve(run('--workspace', 'sub'));
    expect(a.workspace).toBe(join(cwd, 'sub'));
    expect(a.entries.get('workspace')).toEqual({ value: join(cwd, 'sub'), source: 'flag' });
    const b = await resolve(run(), { JEVCODE_HOME: join(root, 'jh'), JEVCODE_WORKSPACE: '/tmp/x' });
    expect(b.runsDir).toBe(join(root, 'jh', 'runs'));
    expect(b.workspace).toBe('/tmp/x');
    const c = await resolve(run('--runs-dir', join(root, 'r')));
    expect(c.runsDir).toBe(join(root, 'r'));
    expect(c.entries.get('runsDir')?.source).toBe('flag');
  });

  it('SecretSet covers resolved keys and every secret-looking dotenv variable (used or not), leaving SHAs alone', async () => {
    await copyFile(join(FIX, 'redaction.env'), join(cwd, '.env'));
    const c = await resolve(run('--provider', 'openrouter', '--api-key', 'flagkey-ABCDEF0123456789-XYZ'));
    const out = c.redact(`${OR_KEY} plain-password-with-no-format-1234 flagkey-ABCDEF0123456789-XYZ deadbeefdeadbeefdeadbeefdeadbeefdeadbeef not-a-secret`);
    expect(out).toBe('[REDACTED:decider.apiKey] [REDACTED:UNUSED_DB_PASSWORD] [REDACTED:generator.apiKey] deadbeefdeadbeefdeadbeefdeadbeefdeadbeef not-a-secret');
    expect(c.redactJson({ k: OR_KEY })).toEqual({ k: '[REDACTED:decider.apiKey]' });
    expect(c.secretPaths).toContain(join(cwd, '.env'));
  });

  it('config command flags resolve the same way as run flags', async () => {
    const c = await resolve(parseCliArgs(['config', '--model', 'm1', '--no-network']));
    expect(c.entries.get('generator.model')?.value).toBe('m1');
    expect(c.noNetwork).toBe(true);
    expect(c.entries.get('noNetwork')).toEqual({ value: 'true', source: 'flag' });
  });
});

describe('detectPackageRoot', () => {
  it('finds the jevcode package.json from a nested directory and returns null elsewhere', async () => {
    await writeFile(join(pkg, 'package.json'), '{"name":"jevcode"}');
    await mkdir(join(pkg, 'dist'));
    expect(detectPackageRoot(join(pkg, 'dist'))).toBe(pkg);
    expect(detectPackageRoot()).toBe(await realpath(join(import.meta.dirname, '../../..')));
    expect(detectPackageRoot(join(root, 'home'))).toBeNull();
  });
});

describe('TUI-DESIGN §16: XDG config path, mode-keyed caps, launch rows, the six contract members', () => {
  const withFlags = (extra: Record<string, string | boolean>, ...argv: string[]): ParsedFlags => Object.assign(run(...argv), extra) as ParsedFlags;
  const LAUNCH = { fps: 30, renderMode: 'standard' as const, screenReader: false, ascii: false, noColor: false, reducedMotion: false };

  it('XDG file first, legacy ~/.config/jevcode/config.json as a fallback with a one-time warning', async () => {
    const xdg = join(root, 'xdg');
    await mkdir(join(xdg, 'jevcode'), { recursive: true });
    await mkdir(join(home, '.config', 'jevcode'), { recursive: true });
    await writeFile(join(home, '.config', 'jevcode', 'config.json'), '{"maxReplans": 9}');
    const legacy = await resolve(run(), { XDG_CONFIG_HOME: xdg });
    expect(legacy.configFile).toBe(join(home, '.config', 'jevcode', 'config.json'));
    expect(legacy.warnings.filter((w) => w.includes('legacy'))).toHaveLength(1);
    expect(legacy.warnings[0]).toContain(join(xdg, 'jevcode', 'config.json'));
    await writeFile(join(xdg, 'jevcode', 'config.json'), '{"maxReplans": 4}');
    const preferred = await resolve(run(), { XDG_CONFIG_HOME: xdg });
    expect(preferred.configFile).toBe(join(xdg, 'jevcode', 'config.json'));
    expect(preferred.entries.get('limits.maxReplans')?.value).toBe('4');
    expect(preferred.warnings).toEqual([]);
    expect(preferred.secretPaths).toContain(join(xdg, 'jevcode', 'config.json'));
    // no XDG_CONFIG_HOME: the XDG path is the legacy path, no warning
    const plain = await resolve(run());
    expect(plain.configFile).toBe(join(home, '.config', 'jevcode', 'config.json'));
    expect(plain.warnings).toEqual([]);
    // ./jevcode.json still wins over both
    await writeFile(join(cwd, 'jevcode.json'), '{"maxReplans": 1}');
    expect((await resolve(run(), { XDG_CONFIG_HOME: xdg })).configFile).toBe(join(cwd, 'jevcode.json'));
  });

  it('configDirs = XDG dir then legacy dir, deduplicated', async () => {
    expect((await resolve(run())).configDirs).toEqual([join(home, '.config', 'jevcode')]);
    expect((await resolve(run(), { XDG_CONFIG_HOME: '/tmp/x' })).configDirs).toEqual(['/tmp/x/jevcode', join(home, '.config', 'jevcode')]);
  });

  it('the run cap default is mode-keyed after --mode (P45): $1.00 under jev-only, $10.00 otherwise, explicit values untouched', async () => {
    const jo = await resolve(run('--mode', 'jev-only'));
    expect(jo.entries.get('limits.spendCapUsd')).toEqual({ value: '1', source: 'default' });
    expect(jo.limits().spendCapUsd).toBe(1);
    expect(jo.sessionSpendCap('jev-only')).toEqual({ value: 5, source: 'derived', derived: true });
    expect((await resolve(run('--condition', 'jev-only'))).limits().spendCapUsd).toBe(1);
    // TUI-DESIGN-2 §1.2 / TUI-DESIGN-3 §1.1: zero arguments = DEFAULT_MODE and its mode-keyed cap; jev-on / jev-off keep $10.00
    expect((await resolve(run())).limits().spendCapUsd).toBe(defaultRunSpendCapUsd(DEFAULT_MODE));
    expect((await resolve(run('--mode', 'jev-on'))).limits().spendCapUsd).toBe(10);
    expect((await resolve(run('--mode', 'jev-off'))).limits().spendCapUsd).toBe(10);
    expect((await resolve(run('--mode', 'jev-only', '--spend-cap', '3'))).limits().spendCapUsd).toBe(3);
    expect((await resolve(run('--mode', 'jev-only'), { JEVCODE_SPEND_CAP_USD: '0.5' })).entries.get('limits.spendCapUsd')).toEqual({ value: '0.5', source: 'env' });
  });

  it('sessionSpendCap(mode): derived 5 × run cap, configured through the chain, none = +Infinity; the record prints the derived row', async () => {
    const c = await resolve(run('--mode', 'jev-on'));
    expect(c.sessionSpendCap('jev-on')).toEqual({ value: 50, source: 'derived', derived: true });
    expect(c.sessionSpendCap('jev-only')).toEqual({ value: 5, source: 'derived', derived: true });
    expect(c.record()['session.spendCapUsd']).toEqual({ value: '50', source: 'derived' });
    const flagged = await resolve(run('--spend-cap', '3'));
    expect(flagged.sessionSpendCap('jev-on')).toEqual({ value: 15, source: 'derived', derived: true });
    const env = await resolve(run(), { JEVCODE_SESSION_SPEND_CAP_USD: '15' });
    expect(env.sessionSpendCap('jev-on')).toEqual({ value: 15, source: 'env', derived: false });
    expect(env.record()['session.spendCapUsd']).toEqual({ value: '15', source: 'env' });
    expect((await resolve(withFlags({ sessionSpendCap: 'none' }))).sessionSpendCap('jev-on')).toEqual({ value: Number.POSITIVE_INFINITY, source: 'flag', derived: false });
    await writeFile(join(cwd, 'jevcode.json'), JSON.stringify({ sessionSpendCapUsd: 7 }));
    expect((await resolve(run())).sessionSpendCap('jev-on')).toEqual({ value: 7, source: `file:${join(cwd, 'jevcode.json')}`, derived: false });
    const bad = await resolve(run(), { JEVCODE_SESSION_SPEND_CAP_USD: '0' });
    expect(() => bad.sessionSpendCap('jev-on')).toThrow(/session\.spendCapUsd: "0" \(from env\) is not a number > 0/);
  });

  it('launch rows resolve flag > env > default and never from the file; a file value is recorded as ignored:launch with a warning', async () => {
    await writeFile(join(cwd, 'jevcode.json'), JSON.stringify({ fps: 20, renderMode: 'incremental', theme: 'light', screenReader: true }));
    const c = await resolve(run(), { JEVCODE_FPS: '25' });
    expect(c.entries.get('ui.fps')).toEqual({ value: '25', source: 'env' });
    expect(c.entries.get('ui.renderMode')).toEqual({ value: 'standard', source: 'default' });
    expect(c.entries.get('ui.screenReader')).toEqual({ value: 'false', source: 'default' });
    expect(c.entries.get('ui.ascii')).toEqual({ value: 'false', source: 'default' });
    expect(c.entries.get('ui.noColor')).toEqual({ value: 'false', source: 'default' });
    expect(c.entries.get('ui.theme')).toEqual({ value: 'light', source: `file:${join(cwd, 'jevcode.json')}` });
    const rec = c.record();
    expect(rec['ui.fps']).toEqual({ value: '25', source: 'env' });
    expect(rec['ui.fps.ignored']).toEqual({ value: '20', source: 'ignored:launch' });
    expect(rec['ui.renderMode.ignored']).toEqual({ value: 'incremental', source: 'ignored:launch' });
    expect(rec['ui.screenReader.ignored']).toEqual({ value: 'true', source: 'ignored:launch' });
    expect(rec['ui.theme']).toEqual({ value: 'light', source: `file:${join(cwd, 'jevcode.json')}` });
    expect(c.warnings.some((w) => w.includes('ignored:launch') && w.includes('fps') && w.includes('renderMode') && w.includes('screenReader'))).toBe(true);
    expect(c.warnings.some((w) => w.includes('unknown keys'))).toBe(false);
    expect(c.sourcesConsulted('ui.fps')).toEqual(['--fps (flag)', 'JEVCODE_FPS (env)', `fps (file:${join(cwd, 'jevcode.json')}, ignored:launch)`, 'default 30']);
    const flagged = await resolve(withFlags({ fps: '10', ascii: true, noColor: true, screenReader: true, renderMode: 'incremental' }), { JEVCODE_FPS: '25', TERM: 'dumb' });
    expect(flagged.entries.get('ui.fps')).toEqual({ value: '10', source: 'flag' });
    expect(flagged.entries.get('ui.ascii')).toEqual({ value: 'true', source: 'flag' });
    expect(flagged.entries.get('ui.noColor')).toEqual({ value: 'true', source: 'flag' });
    expect(flagged.entries.get('ui.screenReader')).toEqual({ value: 'true', source: 'flag' });
    expect(flagged.entries.get('ui.renderMode')).toEqual({ value: 'incremental', source: 'flag' });
    expect((await resolve(run(), { TERM: 'dumb', NO_COLOR: '1' })).entries.get('ui.ascii')).toEqual({ value: 'true', source: 'default' });
    expect((await resolve(run(), { NO_COLOR: '1' })).entries.get('ui.noColor')).toEqual({ value: 'true', source: 'env' });
  });

  it('ui(launch): session settings through the full chain, launch members copied from the argument', async () => {
    await writeFile(join(cwd, '.env'), 'JEVCODE_THEME=daltonized\nJEVCODE_OSC52=1\n');
    await writeFile(join(cwd, 'jevcode.json'), JSON.stringify({ theme: 'light', history: false, exitCode: 'last-run', logLevel: 'warn', log: 'my.log', fps: 5 }));
    const c = await resolve(withFlags({ noHistory: true, noAnimation: true, notify: true, verbose: true }, '--plain'));
    const ui = c.ui({ ...LAUNCH, fps: 12, screenReader: true });
    expect(ui).toEqual({
      fps: 12,
      renderMode: 'standard',
      screenReader: true,
      ascii: false,
      noColor: false,
      theme: 'daltonized',
      title: false,
      reducedMotion: true,
      notify: true,
      osc52: true,
      history: false,
      noInput: false,
      trustWorkspace: false,
      budgetWarnings: true,
      allowSecretMention: false,
      exitCode: 'last-run',
      logLevel: 'debug',
      logFile: join(cwd, 'my.log'),
      keybindingsFile: join(home, '.config', 'jevcode', 'keybindings.json'),
      wordmark: 'sweep',
      // contract 1.6 (TUI-DESIGN-4 §8 items 4–5)
      renderer: 'classic',
      fullscreenDump: true,
    });
    expect(c.entries.get('ui.history')).toEqual({ value: 'false', source: 'flag' });
    expect(c.entries.get('log.level')).toEqual({ value: 'debug', source: 'flag' });
    expect((await resolve(withFlags({ verbose: true, logLevel: 'trace' }))).entries.get('log.level')).toEqual({ value: 'trace', source: 'flag' });
    expect((await resolve(withFlags({ noBudgetWarnings: true }))).ui(LAUNCH).budgetWarnings).toBe(false);
    expect((await resolve(withFlags({ theme: 'ansi', exitCode: 'zero', keybindings: 'kb.json' }))).ui(LAUNCH)).toMatchObject({ theme: 'ansi', exitCode: 'zero', keybindingsFile: join(cwd, 'kb.json') });
    expect((await resolve(run(), { XDG_CONFIG_HOME: '/tmp/x' })).ui(LAUNCH).keybindingsFile).toBe('/tmp/x/jevcode/keybindings.json');
    const bad = await resolve(run(), { JEVCODE_THEME: 'neon' });
    expect(() => bad.ui(LAUNCH)).toThrow(/ui\.theme: "neon" \(from env\)/);
  });

  it('llm-jev (docs/LLM-JEV-DESIGN.md): missingSecrets needs BOTH keys like jev-on; the mode resolves through the chain and pays the $10.00 generator cap', async () => {
    const none = await resolve(run(), { JEVCODE_PROVIDER: 'openai' });
    expect(none.missingSecrets('llm-jev')).toEqual(['generator.apiKey', 'decider.apiKey']);
    expect((await resolve(run('--mock-generator'))).missingSecrets('llm-jev')).toEqual(['decider.apiKey']);
    expect((await resolve(run('--mock'))).missingSecrets('llm-jev')).toEqual([]);
    expect((await resolve(run(), { OPENROUTER_API_KEY: OR_KEY })).missingSecrets('llm-jev')).toEqual([]);
    expect((await resolve(run(), { ANTHROPIC_API_KEY: 'anthropic-key-1234' })).missingSecrets('llm-jev')).toEqual(['generator.apiKey', 'decider.apiKey']);
    const viaEnv = await resolve(run(), { JEVCODE_MODE: 'llm-jev' });
    expect(viaEnv.mode).toBe('llm-jev');
    expect(viaEnv.limits().spendCapUsd).toBe(10);
    expect((await resolve(run('--mode', 'llm-jev'))).mode).toBe('llm-jev');
    expect(modeFromParsedFlags(run('--mode', 'llm-jev'))).toBe('llm-jev');
    expect(modeFromParsedFlags(run('--condition', 'llm-jev'))).toBe('llm-jev');
  });

  it('missingSecrets(mode) never throws and skips the generator key for jev-only and --mock*, both keys for --mock', async () => {
    const none = await resolve(run(), { JEVCODE_PROVIDER: 'openai' });
    expect(none.missingSecrets('jev-on')).toEqual(['generator.apiKey', 'decider.apiKey']);
    expect(none.missingSecrets('jev-off')).toEqual(['generator.apiKey', 'decider.apiKey']);
    expect(none.missingSecrets('jev-only')).toEqual(['decider.apiKey']);
    expect((await resolve(run('--mock'))).missingSecrets('jev-on')).toEqual([]);
    expect((await resolve(run('--mock-generator'))).missingSecrets('jev-on')).toEqual(['decider.apiKey']);
    // default provider openrouter: one OPENROUTER_API_KEY covers both sides; an Anthropic key alone covers neither
    expect((await resolve(run(), { OPENROUTER_API_KEY: OR_KEY })).missingSecrets('jev-on')).toEqual([]);
    expect((await resolve(run(), { ANTHROPIC_API_KEY: 'anthropic-key-1234' })).missingSecrets('jev-on')).toEqual(['generator.apiKey', 'decider.apiKey']);
    expect((await resolve(run('--provider', 'anthropic'), { ANTHROPIC_API_KEY: 'anthropic-key-1234' })).missingSecrets('jev-on')).toEqual(['decider.apiKey']);
    expect((await resolve(run('--provider', 'anthropic'), { OPENROUTER_API_KEY: OR_KEY })).missingSecrets('jev-on')).toEqual(['generator.apiKey']);
    expect((await resolve(run('--provider', 'openrouter'), { OPENROUTER_API_KEY: OR_KEY })).missingSecrets('jev-on')).toEqual([]);
    expect((await resolve(run(), { OPENROUTER_API_KEY: '   ', JEV_API_KEY: '' })).missingSecrets('jev-on')).toEqual(['generator.apiKey', 'decider.apiKey']);
  });

  it('addSecret / dropSecret delegate to the redactor', async () => {
    const c = await resolve(run());
    expect(c.addSecret('login', 'short')).toBe(false);
    expect(c.addSecret('login', 'new-login-key-0123456789')).toBe(true);
    expect(c.redact('x new-login-key-0123456789 y')).toBe('x [REDACTED:login] y');
    expect(c.addSecret('login', 'new-login-key-0123456789')).toBe(false);
    expect(typeof c.dropSecret('login')).toBe('boolean');
  });

  it('priced fail-closed through generator(): an unpriced Anthropic model is a ConfigError unless --allow-unpriced, which sets the token cap', async () => {
    const env = { ANTHROPIC_API_KEY: 'anthropic-key-1234' };
    const bad = await resolve(run('--mode', 'jev-on', '--provider', 'anthropic', '--model', 'claude-next'), env);
    expect(() => bad.generator()).toThrow('generator.model "claude-next" has no pricing entry, so the $10.000 spend cap could not be enforced. Set JEVCODE_PRICE_IN_PER_M and JEVCODE_PRICE_OUT_PER_M (USD per million tokens), or pass --allow-unpriced to run under a token cap instead.');
    expect('maxGeneratorTokens' in bad.limits()).toBe(false);
    const ok = await resolve(withFlags({ allowUnpriced: true }, '--provider', 'anthropic', '--model', 'claude-next', '--spend-cap', '1.5'), env);
    expect(ok.generator().priced).toBe(false);
    expect(ok.limits().maxGeneratorTokens).toBe(100_000);
    expect(ok.warnings.some((w) => w.includes('no pricing entry') && w.includes('100000'))).toBe(true);
    expect(ok.record()['limits.maxGeneratorTokens']).toEqual({ value: '100000', source: 'derived' });
    expect(ok.record()['limits.allowUnpriced']).toEqual({ value: 'true', source: 'flag' });
    const viaEnv = await resolve(run('--provider', 'anthropic', '--model', 'claude-next'), { ...env, JEVCODE_ALLOW_UNPRICED: '1', JEVCODE_MAX_GENERATOR_TOKENS: '50000' });
    expect(viaEnv.limits().maxGeneratorTokens).toBe(50_000);
    expect(viaEnv.record()['limits.maxGeneratorTokens']).toEqual({ value: '50000', source: 'env' });
    expect((await resolve(run('--provider', 'anthropic', '--model', 'claude-sonnet-5'), env)).generator().priced).toBe(true);
    expect((await resolve(run('--provider', 'anthropic', '--model', 'claude-sonnet-5'), env)).record()['limits.maxGeneratorTokens']).toBeUndefined();
    // the default (OpenRouter GLM 5.3 Flash) is table-priced: no gate, no token cap row
    const dflt = await resolve(run(), { OPENROUTER_API_KEY: OR_KEY });
    expect(dflt.generator().priced).toBe(true);
    expect(dflt.record()['limits.maxGeneratorTokens']).toBeUndefined();
  });

  it('cache price rows: table for known models, derived 0.1× / 1.25× input for unknown ones, explicit overrides win', async () => {
    const env = { OPENROUTER_API_KEY: OR_KEY };
    const known = await resolve(run('--provider', 'openrouter'), env);
    expect(known.record()['generator.priceCacheReadPerM']).toBeUndefined();
    const derived = await resolve(run('--provider', 'openrouter', '--model', 'vendor/other'), { ...env, JEVCODE_PRICE_IN_PER_M: '3', JEVCODE_PRICE_OUT_PER_M: '15' });
    expect(derived.generator().pricing).toEqual({ inputPerM: 3, outputPerM: 15, cacheReadPerM: expect.closeTo(0.3, 12), cacheWritePerM: 3.75 });
    expect(derived.record()['generator.priceCacheReadPerM']).toEqual({ value: '0.3', source: 'derived' });
    expect(derived.record()['generator.priceCacheWritePerM']).toEqual({ value: '3.75', source: 'derived' });
    const explicit = await resolve(run('--provider', 'openrouter', '--model', 'vendor/other'), { ...env, JEVCODE_PRICE_IN_PER_M: '3', JEVCODE_PRICE_OUT_PER_M: '15', JEVCODE_PRICE_CACHE_READ_PER_M: '0.5' });
    expect(explicit.generator().pricing).toMatchObject({ cacheReadPerM: 0.5, cacheWritePerM: 3.75 });
    expect(explicit.record()['generator.priceCacheReadPerM']).toEqual({ value: '0.5', source: 'env' });
    expect(explicit.record()['generator.priceCacheWritePerM']).toEqual({ value: '3.75', source: 'derived' });
  });

  it('record() never throws, even with malformed booleans, and keeps every existing row', async () => {
    const c = await resolve(run(), { JEVCODE_ALLOW_UNPRICED: 'maybe' });
    const rec = c.record();
    expect(rec['generator.provider']).toEqual({ value: 'openrouter', source: 'default' });
    expect(rec['generator.model']).toEqual({ value: 'z-ai/glm-5.3-flash', source: 'default' });
    expect(rec['ui.theme']).toEqual({ value: 'dark', source: 'default' });
    expect(rec['limits.maxGeneratorTokens']).toBeUndefined();
    expect(() => c.limits()).toThrow(/limits\.allowUnpriced: "maybe" \(from env\) is not a boolean/);
  });

  it('JEVCODE_NO_HISTORY is inverted at every layer: process env, ./.env, and the variable name used as a config-file key', async () => {
    const viaEnv = await resolve(run(), { JEVCODE_NO_HISTORY: '1' });
    expect(viaEnv.entries.get('ui.history')).toEqual({ value: 'false', source: 'env' });
    expect(viaEnv.ui(LAUNCH).history).toBe(false);
    expect((await resolve(run(), { JEVCODE_NO_HISTORY: 'true' })).ui(LAUNCH).history).toBe(false);
    expect((await resolve(run(), { JEVCODE_NO_HISTORY: 'yes' })).ui(LAUNCH).history).toBe(false);
    // `=0` re-enables, an empty value is unset, a malformed value keeps its text and source for the validator
    expect((await resolve(run(), { JEVCODE_NO_HISTORY: '0' })).entries.get('ui.history')).toEqual({ value: 'true', source: 'env' });
    expect((await resolve(run(), { JEVCODE_NO_HISTORY: '' })).entries.get('ui.history')).toEqual({ value: 'true', source: 'default' });
    const malformed = await resolve(run(), { JEVCODE_NO_HISTORY: 'maybe' });
    expect(malformed.entries.get('ui.history')).toEqual({ value: 'maybe', source: 'env' });
    expect(() => malformed.ui(LAUNCH)).toThrow(/ui\.history: "maybe" \(from env\) is not a boolean/);
    await writeFile(join(cwd, '.env'), 'JEVCODE_NO_HISTORY=true\n');
    const viaDotenv = await resolve(run());
    expect(viaDotenv.entries.get('ui.history')).toEqual({ value: 'false', source: `dotenv:${join(cwd, '.env')}` });
    expect(viaDotenv.ui(LAUNCH).history).toBe(false);
    await rm(join(cwd, '.env'));
    await writeFile(join(cwd, 'jevcode.json'), JSON.stringify({ JEVCODE_NO_HISTORY: true }));
    const viaFileKey = await resolve(run());
    expect(viaFileKey.entries.get('ui.history')).toEqual({ value: 'false', source: `file:${join(cwd, 'jevcode.json')}` });
    expect(viaFileKey.ui(LAUNCH).history).toBe(false);
    expect(viaFileKey.warnings.some((w) => w.includes('unknown keys'))).toBe(false);
    await writeFile(join(cwd, 'jevcode.json'), JSON.stringify({ history: false }));
    expect((await resolve(run())).ui(LAUNCH).history).toBe(false);
    // the flag still wins and stays negated; the consulted list names the inverted variable
    expect((await resolve(withFlags({ noHistory: true }), { JEVCODE_NO_HISTORY: '0' })).ui(LAUNCH).history).toBe(false);
    expect(viaEnv.sourcesConsulted('ui.history')).toContain('JEVCODE_NO_HISTORY (inverted) (env)');
    expect(negateBooleanText('1')).toBe('false');
    expect(negateBooleanText(' No ')).toBe('true');
    expect(negateBooleanText('maybe')).toBe('maybe');
  });

  it('NO_UPDATE_NOTIFIER=1 disables update.notify; JEVCODE_UPDATE_NOTIFY is checked first within a layer', async () => {
    expect((await resolve(run(), { NO_UPDATE_NOTIFIER: '1' })).entries.get('update.notify')).toEqual({ value: 'false', source: 'env' });
    expect((await resolve(run(), { NO_UPDATE_NOTIFIER: '0' })).entries.get('update.notify')).toEqual({ value: 'true', source: 'env' });
    // the positive name wins within a layer and keeps its raw text (`1`), which the boolean validator accepts
    const both = await resolve(run(), { JEVCODE_UPDATE_NOTIFY: '1', NO_UPDATE_NOTIFIER: '1' });
    expect(both.entries.get('update.notify')).toEqual({ value: '1', source: 'env' });
    expect((await resolve(run())).entries.get('update.notify')).toEqual({ value: 'false', source: 'default' });
    await writeFile(join(cwd, 'jevcode.json'), JSON.stringify({ updateNotify: true }));
    expect((await resolve(run(), { NO_UPDATE_NOTIFIER: '1' })).entries.get('update.notify')?.value).toBe('false');
    expect((await resolve(run())).entries.get('update.notify')?.value).toBe('true');
  });

  it('JEVCODE_TRACE=<file> is JEVCODE_LOG=<file> at level trace unless a flag or a higher layer sets log.level', async () => {
    const traced = await resolve(run(), { JEVCODE_TRACE: 't.log' });
    expect(traced.entries.get('log.file')).toEqual({ value: 't.log', source: 'env' });
    expect(traced.entries.get('log.level')).toEqual({ value: 'trace', source: 'env' });
    expect(traced.ui(LAUNCH)).toMatchObject({ logFile: join(cwd, 't.log'), logLevel: 'trace' });
    // --log-level / --verbose (flags) win; an explicit JEVCODE_LOG_LEVEL in the same layer wins
    expect((await resolve(withFlags({ logLevel: 'warn' }), { JEVCODE_TRACE: 't.log' })).entries.get('log.level')).toEqual({ value: 'warn', source: 'flag' });
    expect((await resolve(withFlags({ verbose: true }), { JEVCODE_TRACE: 't.log' })).entries.get('log.level')).toEqual({ value: 'debug', source: 'flag' });
    expect((await resolve(run(), { JEVCODE_TRACE: 't.log', JEVCODE_LOG_LEVEL: 'error' })).entries.get('log.level')).toEqual({ value: 'error', source: 'env' });
    // JEVCODE_LOG is checked before JEVCODE_TRACE: when both are set the level is not forced
    const both = await resolve(run(), { JEVCODE_LOG: 'a.log', JEVCODE_TRACE: 'b.log' });
    expect(both.entries.get('log.file')).toEqual({ value: 'a.log', source: 'env' });
    expect(both.entries.get('log.level')).toEqual({ value: 'info', source: 'default' });
    // an empty / blank JEVCODE_TRACE is unset
    expect((await resolve(run(), { JEVCODE_TRACE: '   ' })).entries.get('log.level')).toEqual({ value: 'info', source: 'default' });
    // a dotenv JEVCODE_TRACE beats a file logLevel but not an env JEVCODE_LOG_LEVEL
    await writeFile(join(cwd, '.env'), 'JEVCODE_TRACE=d.log\n');
    await writeFile(join(cwd, 'jevcode.json'), JSON.stringify({ logLevel: 'warn' }));
    const fromDotenv = await resolve(run());
    expect(fromDotenv.entries.get('log.file')).toEqual({ value: 'd.log', source: `dotenv:${join(cwd, '.env')}` });
    expect(fromDotenv.entries.get('log.level')).toEqual({ value: 'trace', source: `dotenv:${join(cwd, '.env')}` });
    expect((await resolve(run(), { JEVCODE_LOG_LEVEL: 'error' })).entries.get('log.level')).toEqual({ value: 'error', source: 'env' });
  });

  it('a non-scalar value under a launch file key is reported as ignored:launch, never a fatal ConfigError', async () => {
    await writeFile(join(cwd, 'jevcode.json'), JSON.stringify({ fps: [1, 2], renderMode: { a: 1 }, screenReader: null, maxReplans: 3 }));
    const c = await resolve(run());
    expect(c.entries.get('ui.fps')).toEqual({ value: '30', source: 'default' });
    expect(c.entries.get('limits.maxReplans')?.value).toBe('3');
    const rec = c.record();
    expect(rec['ui.fps.ignored']).toEqual({ value: '[1,2]', source: 'ignored:launch' });
    expect(rec['ui.renderMode.ignored']).toEqual({ value: '{"a":1}', source: 'ignored:launch' });
    expect(rec['ui.screenReader.ignored']).toEqual({ value: 'null', source: 'ignored:launch' });
    expect(c.warnings.some((w) => w.includes('ignored:launch') && w.includes('fps'))).toBe(true);
    // a huge non-scalar is clipped in the record
    await writeFile(join(cwd, 'jevcode.json'), JSON.stringify({ fps: Array.from({ length: 200 }, (_, i) => i) }));
    expect(String((await resolve(run())).record()['ui.fps.ignored']?.value).length).toBeLessThanOrEqual(80);
    // a non-scalar under a session key is still the fatal error
    await writeFile(join(cwd, 'jevcode.json'), JSON.stringify({ theme: [1] }));
    await expect(resolve(run())).rejects.toThrow(/must be a string, number or boolean/);
  });

  it('record() `.ignored` rows never influence the resume identity or reconciliation (round trip through run.json)', async () => {
    await writeFile(join(cwd, 'jevcode.json'), JSON.stringify({ fps: 20, screenReader: true, spendCapUsd: 0.5 }));
    const c = await resolve(run(), { JEVCODE_FPS: '25' });
    const rec = c.record();
    expect(Object.keys(rec).filter((k) => k.endsWith('.ignored')).sort()).toEqual(['ui.fps.ignored', 'ui.screenReader.ignored']);
    const meta: RunMeta = {
      runId: '20260920-140211-abcdefgh',
      task: 't',
      workspace: cwd,
      mode: 'jev-on',
      config: rec,
      versions: { jevcode: '0', node: '22' },
      createdAt: '2026-09-20T14:02:11.123Z',
      overrides: [],
      resumes: [],
      resolvedJevModel: null,
      jevModelDrift: null,
    };
    const identity = resumeIdentityFromRunMeta(meta);
    expect(identity).toMatchObject({ provider: 'openrouter', model: 'z-ai/glm-5.3-flash', sandbox: 'auto' });
    expect(JSON.stringify(identity)).not.toContain('ignored');
    const again = await resolve(run(), { JEVCODE_FPS: '25' });
    const rc = reconcileResumeConfig({ limits: again.limits(), workspaceRealpath: null, state: { step: 3, spendTotalUsd: 0.1, wallMsUsed: 1, replanCount: 0, stopReason: null, generatorTokens: 0 } }, meta, parseCliArgs(['run', '--resume', meta.runId]));
    expect(rc.errors).toEqual([]);
    expect(rc.overrides).toEqual([]);
    expect(rc.limits.spendCapUsd).toBe(0.5);
  });

  it('dropSecret delegates to the shared redactor: a just-added secret is dropped and no longer masked', async () => {
    const c = await resolve(run());
    expect(c.addSecret('login', 'new-login-key-0123456789')).toBe(true);
    expect(c.redact('x new-login-key-0123456789 y')).toBe('x [REDACTED:login] y');
    expect(c.dropSecret('login')).toBe(true);
    expect(c.redact('x new-login-key-0123456789 y')).toBe('x new-login-key-0123456789 y');
    expect(c.dropSecret('login')).toBe(false);
    expect(c.dropSecret('never-added')).toBe(false);
  });

  it('the legacy config-path warning fires once per process for a path; suppressLegacyWarning silences it', async () => {
    const xdg = join(root, 'xdg2');
    await mkdir(join(xdg, 'jevcode'), { recursive: true });
    await mkdir(join(home, '.config', 'jevcode'), { recursive: true });
    await writeFile(join(home, '.config', 'jevcode', 'config.json'), '{"maxReplans": 9}');
    const first = await resolve(run(), { XDG_CONFIG_HOME: xdg });
    expect(first.warnings.filter((w) => w.includes('legacy'))).toHaveLength(1);
    const second = await resolve(run(), { XDG_CONFIG_HOME: xdg });
    expect(second.configFile).toBe(join(home, '.config', 'jevcode', 'config.json'));
    expect(second.warnings.filter((w) => w.includes('legacy'))).toHaveLength(0);
    const third = await resolve(run(), { XDG_CONFIG_HOME: xdg }, { suppressLegacyWarning: true });
    expect(third.warnings).toEqual([]);
  });

  it('ResolveOptions.mode keys the run-cap default when the flags carry no --mode (the --resume re-resolve)', async () => {
    const jo = await resolve(run(), {}, { mode: 'jev-only' });
    expect(jo.entries.get('limits.spendCapUsd')).toEqual({ value: '1', source: 'default' });
    expect(jo.limits().spendCapUsd).toBe(1);
    expect(jo.sessionSpendCap('jev-only')).toEqual({ value: 5, source: 'derived', derived: true });
    expect((await resolve(run(), {}, { mode: 'jev-on' })).limits().spendCapUsd).toBe(10);
    // an explicit --mode on the command line is the same signal
    expect((await resolve(run('--mode', 'jev-only'), {}, {})).limits().spendCapUsd).toBe(1);
    // a configured cap is never touched by the mode
    expect((await resolve(run('--spend-cap', '3'), {}, { mode: 'jev-only' })).limits().spendCapUsd).toBe(3);
  });
});

describe('TUI-DESIGN-2 §2.3: decider.provider — auto-detection, precedence, key order, offline refusals, redaction, §2.6 rows', () => {
  const TS_KEY = 'ts-live-0123456789abcdef0123456789abcdef';
  const JEV_KEY = 'jev-key-0123456789abcdef';
  /** the `--jev-provider` flag, structurally (cli/args.ts gains the key in S2's PR; resolve reads flags by name) */
  const withFlag = (flags: ParsedFlags, jevProvider: string): ParsedFlags => ({ ...flags, jevProvider }) as ParsedFlags;

  it('auto (rules 2b–2e): JEV_API_KEY → openrouter; TYPESAFE_API_KEY → typesafe with its defaults; both → openrouter; OPENROUTER_API_KEY → openrouter; nothing → openrouter/default', async () => {
    expect((await resolve(run(), { JEV_API_KEY: JEV_KEY })).decider()).toMatchObject({ provider: 'openrouter', providerSource: 'auto:openrouter-key', apiKey: JEV_KEY, model: 'typesafe/jev-1.13-20260917', baseUrl: 'https://openrouter.ai/api/alpha/decisions' });
    // the user's .env: TYPESAFE_API_KEY, OPENROUTER_API_KEY, ANTHROPIC_API_KEY, no JEV_API_KEY → typesafe, jev-1.13.0
    const ts = await resolve(run(), { TYPESAFE_API_KEY: TS_KEY, OPENROUTER_API_KEY: OR_KEY, ANTHROPIC_API_KEY: 'anthropic-key-1234' });
    expect(ts.decider()).toEqual({ provider: 'typesafe', providerSource: 'auto:typesafe-key', apiKey: TS_KEY, model: 'jev-1.13.0', pinned: true, baseUrl: 'https://api.typesafe.ai/v1/systemone', pricing: { inputUsdPerToken: 4.2e-8, outputUsdPerToken: 0 } });
    expect(ts.entries.get('decider.provider')).toEqual({ value: 'typesafe', source: 'derived' });
    expect(ts.entries.get('decider.baseUrl')).toEqual({ value: 'https://api.typesafe.ai/v1/systemone', source: 'default' });
    expect(ts.entries.get('decider.model')).toEqual({ value: 'jev-1.13.0', source: 'default' });
    expect(ts.entries.get('decider.apiKey')).toEqual({ value: TS_KEY, source: 'env' });
    expect(ts.missingSecrets('jev-only')).toEqual([]);
    // today's users: JEV_API_KEY keeps them on OpenRouter even beside a TypeSafe key (rule 2b before 2c)
    expect((await resolve(run(), { JEV_API_KEY: JEV_KEY, TYPESAFE_API_KEY: TS_KEY })).decider()).toMatchObject({ provider: 'openrouter', providerSource: 'auto:openrouter-key', apiKey: JEV_KEY });
    expect((await resolve(run(), { OPENROUTER_API_KEY: OR_KEY })).decider()).toMatchObject({ provider: 'openrouter', providerSource: 'auto:openrouter-key', apiKey: OR_KEY });
    const none = await resolve(run());
    expect(none.entries.get('decider.provider')).toEqual({ value: 'openrouter', source: 'default' });
    expect(none.entries.get('decider.model')).toEqual({ value: 'typesafe/jev-1.13-20260917', source: 'default' });
    expect(none.missingSecrets('jev-only')).toEqual(['decider.apiKey']);
    expect(() => none.decider()).toThrow(/decider\.apiKey/);
    expect(none.record()['decider.providerSource']).toEqual({ value: 'default', source: 'derived' });
  });

  it('auto (rule 2a): a configured base URL whose host the table knows wins over the keys; a dotenv TypeSafe key counts too', async () => {
    const byUrl = await resolve(run('--jev-base-url', 'https://api.typesafe.ai/v1/systemone'), { JEV_API_KEY: JEV_KEY });
    expect(byUrl.decider()).toMatchObject({ provider: 'typesafe', providerSource: 'auto:base-url', apiKey: JEV_KEY, model: 'jev-1.13.0' });
    expect(byUrl.record()['decider.providerSource']).toEqual({ value: 'auto:base-url', source: 'derived' });
    expect((await resolve(run(), { JEV_BASE_URL: 'https://openrouter.ai/api/alpha/decisions', TYPESAFE_API_KEY: TS_KEY, OPENROUTER_API_KEY: OR_KEY })).decider()).toMatchObject({ provider: 'openrouter', providerSource: 'auto:base-url', apiKey: OR_KEY });
    await writeFile(join(cwd, '.env'), `TYPESAFE_API_KEY=${TS_KEY}\n`);
    const dot = await resolve(run());
    expect(dot.decider()).toMatchObject({ provider: 'typesafe', providerSource: 'auto:typesafe-key', apiKey: TS_KEY });
    expect(dot.entries.get('decider.apiKey')).toEqual({ value: TS_KEY, source: `dotenv:${join(cwd, '.env')}` });
  });

  it('rule 1: an explicit provider — flag > JEV_PROVIDER > ./.env > file jevProvider — keeps its source; any other value is an eager ConfigError naming the source (even under --mock); `auto` reads as absent', async () => {
    expect((await resolve(withFlag(run(), 'typesafe'), { TYPESAFE_API_KEY: TS_KEY, JEV_PROVIDER: 'openrouter' })).decider()).toMatchObject({ provider: 'typesafe', providerSource: 'flag' });
    const env = await resolve(run(), { JEV_PROVIDER: 'TypeSafe', TYPESAFE_API_KEY: TS_KEY });
    expect(env.decider()).toMatchObject({ provider: 'typesafe', providerSource: 'env' });
    expect(env.entries.get('decider.provider')).toEqual({ value: 'typesafe', source: 'env' });
    await writeFile(join(cwd, '.env'), `JEV_PROVIDER=openrouter\nOPENROUTER_API_KEY=${OR_KEY}\n`);
    expect((await resolve(run(), { TYPESAFE_API_KEY: TS_KEY })).decider()).toMatchObject({ provider: 'openrouter', providerSource: `dotenv:${join(cwd, '.env')}`, apiKey: OR_KEY });
    await rm(join(cwd, '.env'));
    await writeFile(join(cwd, 'jevcode.json'), JSON.stringify({ jevProvider: 'typesafe' }));
    expect((await resolve(run(), { TYPESAFE_API_KEY: TS_KEY, OPENROUTER_API_KEY: OR_KEY })).decider()).toMatchObject({ provider: 'typesafe', providerSource: `file:${join(cwd, 'jevcode.json')}`, apiKey: TS_KEY });
    await rm(join(cwd, 'jevcode.json'));
    // rule 1's refusal is eager (like the sandbox profile): `JEV_PROVIDER=foo jevcode chat --mock` fails at resolveConfig, which --mock
    // reaches although it never calls decider()
    let err: unknown;
    try {
      await resolve(run(), { JEV_PROVIDER: 'foo', OPENROUTER_API_KEY: OR_KEY });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toMatch(/^decider\.provider: "foo" \(from env\) is not one of auto\|typesafe\|openrouter \(consulted: --jev-provider \(flag\), JEV_PROVIDER \(env\)/);
    expect((err as ConfigError).exitCode).toBe(2);
    expect((err as ConfigError).setting).toBe('decider.provider');
    await expect(resolve(parseCliArgs(['chat', '--mock']), { JEV_PROVIDER: 'foo' })).rejects.toThrow(/^decider\.provider: "foo" \(from env\) is not one of auto\|typesafe\|openrouter/);
    await expect(resolve(withFlag(run(), 'both'), {})).rejects.toThrow(/^decider\.provider: "both" \(from flag\)/);
    await writeFile(join(cwd, 'jevcode.json'), JSON.stringify({ jevProvider: 'neither' }));
    await expect(resolve(run(), {})).rejects.toThrow(`decider.provider: "neither" (from file:${join(cwd, 'jevcode.json')})`);
    await rm(join(cwd, 'jevcode.json'));
    // an explicit `auto` is the absent row: the same derivation, the same `derived` entry
    const explicitAuto = await resolve(run(), { JEV_PROVIDER: 'auto', TYPESAFE_API_KEY: TS_KEY });
    const absent = await resolve(run(), { TYPESAFE_API_KEY: TS_KEY });
    expect(explicitAuto.decider()).toEqual(absent.decider());
    expect(explicitAuto.entries.get('decider.provider')).toEqual({ value: 'typesafe', source: 'derived' });
    expect(explicitAuto.record()['decider.providerSource']).toEqual(absent.record()['decider.providerSource']);
  });

  it('a `jevProvider` saved by writeCredentials into the XDG config.json is read back as the `file:` layer (§1.4: a saved TypeSafe key never resolves to openrouter)', async () => {
    const env = { XDG_CONFIG_HOME: join(home, 'xdg') };
    await writeCredentials({ jevApiKey: TS_KEY, jevProvider: 'typesafe' }, { env, home, cwd, platform: 'darwin' }, 'login');
    const path = join(home, 'xdg', 'jevcode', 'config.json');
    const c = await resolve(run(), env);
    expect(c.configFile).toBe(path);
    expect(c.decider()).toMatchObject({ provider: 'typesafe', providerSource: `file:${path}`, apiKey: TS_KEY, model: 'jev-1.13.0', baseUrl: 'https://api.typesafe.ai/v1/systemone' });
    expect(c.entries.get('decider.provider')).toEqual({ value: 'typesafe', source: `file:${path}` });
    expect(c.entries.get('decider.apiKey')).toEqual({ value: TS_KEY, source: `file:${path}` });
    expect(c.record()['decider.providerSource']).toEqual({ value: `file:${path}`, source: 'derived' });
    expect(configTableRows(c.record()).find((r) => r.setting === 'decider.provider')?.source).toMatch(/^file:/);
    // the saved provider steers the key order too (§2.3 step 3): TYPESAFE_API_KEY in the shell wins over JEV_API_KEY
    expect((await resolve(run(), { ...env, JEV_API_KEY: JEV_KEY, TYPESAFE_API_KEY: `${TS_KEY}-shell` })).decider().apiKey).toBe(`${TS_KEY}-shell`);
  });

  it("step 3 key order: the provider's variable is consulted first when the provider was explicit or TypeSafe-inferred; today's order otherwise; OPENROUTER_API_KEY under typesafe is refused", async () => {
    // --jev-provider typesafe + JEV_API_KEY + TYPESAFE_API_KEY → TYPESAFE_API_KEY
    expect((await resolve(withFlag(run(), 'typesafe'), { JEV_API_KEY: JEV_KEY, TYPESAFE_API_KEY: TS_KEY })).decider().apiKey).toBe(TS_KEY);
    // JEV_API_KEY + OPENROUTER_API_KEY (auto) → JEV_API_KEY, as today
    expect((await resolve(run(), { JEV_API_KEY: JEV_KEY, OPENROUTER_API_KEY: OR_KEY })).decider().apiKey).toBe(JEV_KEY);
    // explicit openrouter keeps today's order (its variable is already in the row: no duplicate in the consulted list)
    const or = await resolve(withFlag(run(), 'openrouter'), { JEV_API_KEY: JEV_KEY, OPENROUTER_API_KEY: OR_KEY });
    expect(or.decider().apiKey).toBe(JEV_KEY);
    expect(or.sourcesConsulted('decider.apiKey')).toContain('JEV_API_KEY / OPENROUTER_API_KEY (env)');
    // under typesafe the consulted list names the TypeSafe variable first
    const ts = await resolve(run(), { TYPESAFE_API_KEY: TS_KEY });
    expect(ts.sourcesConsulted('decider.apiKey')).toContain('TYPESAFE_API_KEY / JEV_API_KEY / OPENROUTER_API_KEY (env)');
    // a typesafe provider whose only key is OPENROUTER_API_KEY is refused offline with the fix named
    const wrongKey = await resolve(run(), { JEV_PROVIDER: 'typesafe', OPENROUTER_API_KEY: OR_KEY });
    expect(wrongKey.missingSecrets('jev-only')).toEqual([]);
    expect(() => wrongKey.decider()).toThrow('decider.apiKey: resolved from OPENROUTER_API_KEY but decider.provider is typesafe (from env); set TYPESAFE_API_KEY or pass --jev-provider openrouter');
    // JEV_API_KEY is the generic Jev key: accepted under typesafe
    expect((await resolve(run(), { JEV_PROVIDER: 'typesafe', JEV_API_KEY: JEV_KEY })).decider()).toMatchObject({ provider: 'typesafe', apiKey: JEV_KEY });
  });

  it("row 4 / §2.5: a configured base URL of the other provider's host and a model of the other naming are refused offline; jev-latest is an alias on both", async () => {
    const mismatch = await resolve(run('--jev-base-url', 'https://openrouter.ai/api/alpha/decisions'), { JEV_PROVIDER: 'typesafe', TYPESAFE_API_KEY: TS_KEY });
    expect(() => mismatch.decider()).toThrow(`decider.baseUrl: "https://openrouter.ai/api/alpha/decisions" (from flag) is openrouter's endpoint but decider.provider is typesafe (from env); pass --jev-provider openrouter or drop --jev-base-url`);
    const proxied = await resolve(run('--jev-base-url', 'https://proxy.test/decisions'), { JEV_PROVIDER: 'typesafe', TYPESAFE_API_KEY: TS_KEY });
    expect(proxied.decider()).toMatchObject({ provider: 'typesafe', baseUrl: 'https://proxy.test/decisions', model: 'jev-1.13.0' });
    const orModel = await resolve(run('--jev-model', 'typesafe/jev-1.13'), { TYPESAFE_API_KEY: TS_KEY });
    expect(() => orModel.decider()).toThrow('decider.model: "typesafe/jev-1.13" (from flag) is an OpenRouter id; the typesafe provider serves jev-1.13.0 (or pass --jev-provider openrouter)');
    for (const m of ['jev-1.13-20260917', 'jev-1.13']) {
      const c = await resolve(run('--jev-model', m), { TYPESAFE_API_KEY: TS_KEY });
      expect(() => c.decider()).toThrow(/is an OpenRouter id/);
    }
    const tsModel = await resolve(run('--jev-model', 'jev-1.13.0'), { OPENROUTER_API_KEY: OR_KEY });
    expect(() => tsModel.decider()).toThrow('decider.model: "jev-1.13.0" (from flag) is a TypeSafe id; the openrouter provider serves typesafe/jev-1.13-20260917 (or pass --jev-provider typesafe)');
    expect((await resolve(run('--jev-model', 'jev-latest'), { TYPESAFE_API_KEY: TS_KEY })).decider()).toMatchObject({ provider: 'typesafe', model: 'jev-latest', pinned: false });
    expect((await resolve(run('--jev-model', 'jev-latest'), { OPENROUTER_API_KEY: OR_KEY })).decider()).toMatchObject({ provider: 'openrouter', model: 'jev-latest', pinned: false });
  });

  it('Redaction: a known key variable exported in the shell is masked whichever provider runs; short values never join the set', async () => {
    const c = await resolve(run(), { JEV_PROVIDER: 'openrouter', OPENROUTER_API_KEY: OR_KEY, TYPESAFE_API_KEY: TS_KEY, ANTHROPIC_API_KEY: 'anthropic-key-1234' });
    expect(c.decider().apiKey).toBe(OR_KEY);
    // the OpenRouter key was already named by the generator setting (same value); the TypeSafe and Anthropic keys are masked under their variable names
    expect(c.redact(`a ${TS_KEY} b ${OR_KEY} c anthropic-key-1234`)).toBe('a [REDACTED:TYPESAFE_API_KEY] b [REDACTED:generator.apiKey] c [REDACTED:ANTHROPIC_API_KEY]');
    expect(c.redactJson({ k: TS_KEY })).toEqual({ k: '[REDACTED:TYPESAFE_API_KEY]' });
    const short = await resolve(run(), { TYPESAFE_API_KEY: 'abc' });
    expect(short.redact('abc def')).toBe('abc def');
  });

  it('§2.6: record() carries decider.provider and decider.providerSource; the table prints `derived (auto: TYPESAFE_API_KEY is set)` and `default (typesafe)`; the identity reads the row back', async () => {
    const c = await resolve(run(), { TYPESAFE_API_KEY: TS_KEY });
    const rec = c.record();
    expect(rec['decider.provider']).toEqual({ value: 'typesafe', source: 'derived' });
    expect(rec['decider.providerSource']).toEqual({ value: 'auto:typesafe-key', source: 'derived' });
    expect(rec['decider.baseUrl']).toEqual({ value: 'https://api.typesafe.ai/v1/systemone', source: 'default' });
    expect(rec['decider.model']).toEqual({ value: 'jev-1.13.0', source: 'default' });
    expect(rec['decider.apiKey']).toEqual({ value: { source: 'env', fingerprint: fingerprint(TS_KEY) }, source: 'env' });
    expect(JSON.stringify(rec)).not.toContain(TS_KEY.slice(0, 12));
    const tableRows = configTableRows(rec);
    expect(tableRows.find((r) => r.setting === 'decider.provider')?.source).toBe('derived (auto: TYPESAFE_API_KEY is set)');
    expect(tableRows.find((r) => r.setting === 'decider.baseUrl')?.source).toBe('default (typesafe)');
    expect(tableRows.find((r) => r.setting === 'decider.model')?.source).toBe('default (typesafe)');
    expect(tableRows.some((r) => r.setting.includes('providerSource'))).toBe(false);
    const or = (await resolve(run(), { JEV_PROVIDER: 'openrouter', OPENROUTER_API_KEY: OR_KEY })).record();
    expect(or['decider.provider']).toEqual({ value: 'openrouter', source: 'env' });
    expect(or['decider.providerSource']).toEqual({ value: 'env', source: 'derived' });
    expect(configTableRows(or).find((r) => r.setting === 'decider.model')?.source).toBe('default (openrouter)');
    const meta: RunMeta = { runId: 'r', task: 't', workspace: cwd, mode: 'jev-only', config: rec, versions: { jevcode: '0', node: '0' }, createdAt: '2026-09-21T00:00:00.000Z', overrides: [], resumes: [], resolvedJevModel: null, jevModelDrift: null };
    expect(resumeIdentityFromRunMeta(meta)).toMatchObject({ jevProvider: 'typesafe', jevModel: 'jev-1.13.0', jevBaseUrl: 'https://api.typesafe.ai/v1/systemone' });
  });
});

describe('complete autonomy by default: the `autonomy` setting', () => {
  it('chain: --autonomy > JEVCODE_AUTONOMY > ./.env > <JEVCODE_EXTRA_ENV_FILE> > file `autonomy` > full; each layer records its source', async () => {
    const dflt = await resolve(run());
    expect(dflt.autonomy).toBe('full');
    expect(dflt.entries.get('autonomy')).toEqual({ value: 'full', source: 'default' });
    expect(dflt.record()['autonomy']).toEqual({ value: 'full', source: 'default' });
    expect(configTableRows(dflt.record()).find((r) => r.setting === 'autonomy')).toEqual({ setting: 'autonomy', value: 'full', source: 'default', atDefault: true });
    // `jevcode config --all` prints the row at its default
    expect(configTableLines(dflt.record(), { sandboxLevel: 'none', width: 110, all: true }).find((l) => l.startsWith('autonomy '))).toMatch(/^autonomy\s+full$/);
    await writeFile(join(cwd, 'jevcode.json'), JSON.stringify({ autonomy: 'review' }));
    const file = await resolve(run());
    expect(file.autonomy).toBe('review');
    expect(file.entries.get('autonomy')).toEqual({ value: 'review', source: `file:${join(cwd, 'jevcode.json')}` });
    const oa = join(root, 'extra-autonomy');
    await mkdir(oa);
    await writeFile(join(oa, '.env'), 'JEVCODE_AUTONOMY=full\n');
    expect((await resolve(run(), { JEVCODE_EXTRA_ENV_FILE: join(oa, '.env') })).autonomy).toBe('full');
    await writeFile(join(cwd, '.env'), 'JEVCODE_AUTONOMY=review\n');
    expect((await resolve(run(), { JEVCODE_EXTRA_ENV_FILE: join(oa, '.env') })).entries.get('autonomy')).toEqual({ value: 'review', source: `dotenv:${join(cwd, '.env')}` });
    expect((await resolve(run(), { JEVCODE_EXTRA_ENV_FILE: join(oa, '.env'), JEVCODE_AUTONOMY: 'full' })).entries.get('autonomy')).toEqual({ value: 'full', source: 'env' });
    const flagged = await resolve(run('--autonomy', 'review'), { JEVCODE_AUTONOMY: 'full' });
    expect(flagged.entries.get('autonomy')).toEqual({ value: 'review', source: 'flag' });
    expect(flagged.autonomy).toBe('review');
    // case-insensitive, like every other enum row
    expect((await resolve(run(), { JEVCODE_AUTONOMY: 'REVIEW' })).autonomy).toBe('review');
  });

  it('a value that is not full|review is an eager ConfigError naming the setting and the source (exit 2)', async () => {
    let err: unknown;
    try {
      await resolve(run(), { JEVCODE_AUTONOMY: 'yolo' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toContain('autonomy: "yolo" (from env) is not one of full|review');
    expect((err as ConfigError).exitCode).toBe(2);
  });
});

describe('TUI-DESIGN-2 §1.2: the `mode` setting', () => {
  it('chain: --mode > JEVCODE_MODE > ./.env > <JEVCODE_EXTRA_ENV_FILE> > file `mode` > DEFAULT_MODE; each layer records its source; the run-cap default follows', async () => {
    const dflt = await resolve(run());
    expect(dflt.mode).toBe(DEFAULT_MODE);
    expect(dflt.entries.get('mode')).toEqual({ value: DEFAULT_MODE, source: 'default' });
    expect(dflt.record()['mode']).toEqual({ value: DEFAULT_MODE, source: 'default' });
    // §2.6 / §12: `mode  <DEFAULT_MODE>  default`
    expect(configTableRows(dflt.record()).find((r) => r.setting === 'mode')).toEqual({ setting: 'mode', value: DEFAULT_MODE, source: 'default', atDefault: true });
    // file `mode: jev-on` → source file:<path>, cap default $10.00 (§8.1 S1 row)
    await writeFile(join(cwd, 'jevcode.json'), JSON.stringify({ mode: 'jev-on' }));
    const file = await resolve(run());
    expect(file.mode).toBe('jev-on');
    expect(file.entries.get('mode')).toEqual({ value: 'jev-on', source: `file:${join(cwd, 'jevcode.json')}` });
    expect(file.entries.get('limits.spendCapUsd')).toEqual({ value: '10', source: 'default' });
    expect(file.limits().spendCapUsd).toBe(10);
    expect(file.sessionSpendCap(file.mode)).toEqual({ value: 50, source: 'derived', derived: true });
    const modeRow = configTableRows(file.record()).find((r) => r.setting === 'mode');
    expect(modeRow).toEqual({ setting: 'mode', value: 'jev-on', source: `file:${join(cwd, 'jevcode.json')}`, atDefault: false });
    // TUI-DESIGN-4 §3.3 / F-B3: the rendered row carries the SHORT parenthetical; the path stays in the record and in --json
    expect(configTableLines(file.record(), { sandboxLevel: 'none', width: 110 }).find((l) => l.startsWith('mode '))).toMatch(/^mode\s+jev-on\s+\(file\)$/);
    // the extra .env file beats the config file, ./.env beats it, the process env beats both, a flag beats everything
    const oa = join(root, 'extra-mode');
    await mkdir(oa);
    await writeFile(join(oa, '.env'), 'JEVCODE_MODE=jev-off\n');
    expect((await resolve(run(), { JEVCODE_EXTRA_ENV_FILE: join(oa, '.env') })).entries.get('mode')).toEqual({ value: 'jev-off', source: `dotenv:${join(oa, '.env')}` });
    await writeFile(join(cwd, '.env'), 'JEVCODE_MODE=jev-only\n');
    expect((await resolve(run(), { JEVCODE_EXTRA_ENV_FILE: join(oa, '.env') })).entries.get('mode')).toEqual({ value: 'jev-only', source: `dotenv:${join(cwd, '.env')}` });
    expect((await resolve(run(), { JEVCODE_EXTRA_ENV_FILE: join(oa, '.env'), JEVCODE_MODE: 'jev-on' })).entries.get('mode')).toEqual({ value: 'jev-on', source: 'env' });
    expect((await resolve(run('--mode', 'jev-off'), { JEVCODE_EXTRA_ENV_FILE: join(oa, '.env'), JEVCODE_MODE: 'jev-on' })).entries.get('mode')).toEqual({ value: 'jev-off', source: 'flag' });
    // --condition (args.ts's hidden alias) is the flag layer too; values are case-insensitive and stored normalised
    expect((await resolve(run('--condition', 'jev-on'), { JEVCODE_MODE: 'jev-only' })).entries.get('mode')).toEqual({ value: 'jev-on', source: 'flag' });
    expect((await resolve(run(), { JEVCODE_MODE: 'JEV-ON' })).entries.get('mode')).toEqual({ value: 'jev-on', source: 'env' });
    // the mode-keyed cap follows the resolved value from any layer
    expect((await resolve(run(), { JEVCODE_MODE: 'jev-on' })).limits().spendCapUsd).toBe(10);
    expect((await resolve(run(), { JEVCODE_MODE: 'jev-only' })).limits().spendCapUsd).toBe(1);
  });

  it('§12: `mode: "<v>" (from <source>) is not one of jev-only|jev-on|jev-off|llm-jev|agent` — eager, exit 2, verbatim; opts.mode (a --resume re-resolve) skips the chain', async () => {
    let err: unknown;
    try {
      await resolve(run(), { JEVCODE_MODE: 'turbo' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toBe('mode: "turbo" (from env) is not one of jev-only|jev-on|jev-off|llm-jev|agent');
    expect((err as ConfigError).exitCode).toBe(2);
    expect((err as ConfigError).setting).toBe('mode');
    await writeFile(join(cwd, 'jevcode.json'), JSON.stringify({ mode: 'fast' }));
    await expect(resolve(run())).rejects.toThrow(`mode: "fast" (from file:${join(cwd, 'jevcode.json')}) is not one of jev-only|jev-on|jev-off|llm-jev`);
    // a --resume re-resolve passes run.json's mode and never consults the chain: the bad file value is not even read
    const resumed = await resolve(run(), {}, { mode: 'jev-on' });
    expect(resumed.mode).toBe('jev-on');
    expect(resumed.entries.get('mode')).toEqual({ value: 'jev-on', source: 'default' });
    expect(resumed.limits().spendCapUsd).toBe(10);
    await rm(join(cwd, 'jevcode.json'));
    // opts.mode agreeing with an explicit layer keeps that layer's source; disagreeing, the re-resolve's value stands as `default`
    expect((await resolve(run('--mode', 'jev-only'), {}, { mode: 'jev-only' })).entries.get('mode')).toEqual({ value: 'jev-only', source: 'flag' });
    expect((await resolve(run('--mode', 'jev-only'), {}, { mode: 'jev-on' })).entries.get('mode')).toEqual({ value: 'jev-on', source: 'default' });
    // `record()` never throws for a valid chain and `jevcode config` prints the row (`config` command flags)
    expect((await resolve(parseCliArgs(['config']), { JEVCODE_MODE: 'jev-off' })).record()['mode']).toEqual({ value: 'jev-off', source: 'env' });
  });
});

describe('TUI-DESIGN-3 §1.1 / §1.8 (S3): modeFromParsedFlags is the one argv rule; a wizard-written file never displaces an env TypeSafe key; the seen.defaultMode row', () => {
  it('modeFromParsedFlags: --mode, the hidden --condition alias, everything else DEFAULT_MODE (the former cli/main.tsx twin is gone)', () => {
    expect(modeFromParsedFlags({ command: 'run' })).toBe(DEFAULT_MODE);
    expect(modeFromParsedFlags({ command: 'chat' })).toBe(DEFAULT_MODE);
    expect(modeFromParsedFlags({ command: 'run', mode: 'jev-on' })).toBe('jev-on');
    expect(modeFromParsedFlags({ command: 'run', mode: 'jev-only' })).toBe('jev-only');
    expect(modeFromParsedFlags({ command: 'run', condition: 'jev-off' })).toBe('jev-off');
    expect(modeFromParsedFlags({ command: 'run', condition: 'jev-on' })).toBe('jev-on');
    // an unknown value never reaches here (args.ts rejects it); a stray one falls back to the default
    expect(modeFromParsedFlags({ command: 'run', mode: 'nope' })).toBe(DEFAULT_MODE);
    expect(modeFromParsedFlags({ command: 'run', mode: 'llm-jev' })).toBe('llm-jev');
    expect(modeFromParsedFlags({ command: 'chat', condition: 'llm-jev' })).toBe('llm-jev');
    expect(isEngineMode('llm-jev')).toBe(true);
    expect(isEngineMode('turbo')).toBe(false);
    expect(isEngineMode(undefined)).toBe(false);
  });

  it('edge 34: a file the one-key wizard wrote beside an env TYPESAFE_API_KEY (apiKey + provider openrouter, no jevProvider) keeps `decider.provider typesafe (auto:typesafe-key)`; a file `jevProvider: openrouter` WOULD move Jev (why the save-shape table forbids it)', async () => {
    const TS_KEY = 'ts-live-abcdefghijklmnopqrstuvwxyz-0123456789';
    await writeCredentials({ apiKey: OR_KEY, provider: 'openrouter' }, { env: {}, home, cwd }, 'wizard');
    const c = await resolve(run(), { TYPESAFE_API_KEY: TS_KEY });
    expect(c.decider()).toMatchObject({ provider: 'typesafe', providerSource: 'auto:typesafe-key', apiKey: TS_KEY });
    expect(c.entries.get('generator.apiKey')).toMatchObject({ value: OR_KEY });
    expect(c.missingSecrets('jev-on')).toEqual([]);
    expect(configTableRows(c.record()).find((r) => r.setting === 'decider.provider')?.source).toBe('derived (auto: TYPESAFE_API_KEY is set)');
    // the forbidden shape: a file jevProvider is rule 1 and beats rule 2c
    await writeCredentials({ apiKey: OR_KEY, jevApiKey: OR_KEY, provider: 'openrouter', jevProvider: 'openrouter' }, { env: {}, home, cwd }, 'wizard');
    expect((await resolve(run(), { TYPESAFE_API_KEY: TS_KEY })).decider()).toMatchObject({ provider: 'openrouter', apiKey: OR_KEY });
  });

  it('seen.defaultMode (D-Q): a file-only bookkeeping row — resolved from `seenDefaultMode`, hidden from the table unless --all, kept in the record; no flag, no variable', async () => {
    const { settingSpec } = await import('../../../src/config/defaults.js');
    expect(settingSpec('seen.defaultMode')).toMatchObject({ env: [], fileKey: 'seenDefaultMode', defaultValue: null, secret: false, hidden: true });
    expect(settingSpec('seen.defaultMode').flag).toBeUndefined();
    const none = await resolve(run());
    expect(none.entries.has('seen.defaultMode')).toBe(false);
    await writeFile(join(cwd, 'jevcode.json'), JSON.stringify({ seenDefaultMode: 'jev-on' }));
    const c = await resolve(run());
    expect(c.entries.get('seen.defaultMode')).toEqual({ value: 'jev-on', source: `file:${join(cwd, 'jevcode.json')}` });
    expect(c.warnings).toEqual([]);
    expect(c.record()['seen.defaultMode']).toEqual({ value: 'jev-on', source: `file:${join(cwd, 'jevcode.json')}` });
    expect(configTableRows(c.record()).some((r) => r.setting === 'seen.defaultMode')).toBe(false);
    expect(configTableRows(c.record(), { all: true }).find((r) => r.setting === 'seen.defaultMode')?.source).toMatch(/^file:/);
  });
});

describe('TUI-DESIGN-4 §7.5 (P-D5): resolveConfig records the problems `jevcode config` reports', () => {
  it('the measured broken config produces a problem per bad row and the unknown keys verbatim', async () => {
    await writeFile(join(cwd, 'jevcode.json'), JSON.stringify({ maxSteps: 'lots', theme: 'nope', temperature: 'hot', notASetting: 1, generator: { model: 123 } }));
    const c = await resolve(run());
    const rec = c.record();
    expect(rec['limits.maxSteps']?.problem).toEqual({ kind: 'wrong-type', expected: 'an integer ≥ 1' });
    expect(rec['ui.theme']?.problem).toEqual({ kind: 'wrong-type', expected: 'one of dark|light|daltonized|ansi' });
    expect(rec['generator.temperature']?.problem).toEqual({ kind: 'wrong-type', expected: 'a number between 0 and 2' });
    // a nested object and an invented name are not settings: they are unknown FILE KEYS, not rows
    expect(c.unknownFileKeys).toEqual(['notASetting', 'generator']);
    expect(Object.keys(rec)).not.toContain('notASetting');
  });

  it('a row at its default and a well-formed row carry no problem, and the record never throws', async () => {
    const c = await resolve(run());
    for (const [name, v] of Object.entries(c.record())) expect(v.problem ?? null, name).toBeNull();
    expect(c.unknownFileKeys).toEqual([]);
  });

  it('`ui.fps: 240` never reaches the record as a problem — `resolveLaunchSettings` has already clamped it (§7.5 edge)', async () => {
    const c = await resolve(run(), { JEVCODE_FPS: '240' });
    expect(c.record()['ui.fps']).toEqual({ value: '30', source: 'env' });
    // the `⚠ clamped to 30` row is `settingProblem`'s job for any layer that does NOT pre-clamp (defaults.test.ts)
  });
});

describe('TUI-DESIGN-4 §8 (the round-4 config rows): ResolvedConfig.context()', () => {
  it('always carries the three rows §8 gives a default, and NOTHING else until the user sets it', async () => {
    const c = await resolve(run());
    // `context.mode` / `context.compaction` / `context.kept` / `context.compactEvery` have a `defaultValue`, so
    // they always resolve and JevCode's config layer pins them; the other three are absent, so
    // `src/core/limits.ts` keeps them. (`kept` joined the four when round-5 item 19 unparked it.)
    expect(c.context?.()).toEqual({ view: 'relaxed', compaction: 'code', kept: 'code', compactEvery: 8 });
    expect(Object.keys(c.context?.() ?? {}).sort()).toEqual(['compactEvery', 'compaction', 'kept', 'view']);
    for (const name of ['context.mode', 'context.compaction', 'context.compactEvery']) {
      expect(c.record()[name]?.source, name).toBe('default');
    }
  });

  it('reads the env and the config file, and skips a malformed value rather than throwing', async () => {
    await writeFile(join(cwd, 'jevcode.json'), JSON.stringify({ contextHistorySteps: 20, contextBudgetChars: 'lots' }));
    const c = await resolve(run(), { JEVCODE_CONTEXT_COMPACTION: 'off', JEVCODE_CONTEXT_MODE: 'legacy', JEVCODE_CONTEXT_FILE_CACHE_BYTES: '65536' });
    expect(c.context?.()).toEqual({ view: 'legacy', compaction: 'off', kept: 'code', compactEvery: 8, historySteps: 20, fileCacheBytes: 65536 });
    expect(c.record()['context.budgetChars']?.problem).toEqual({ kind: 'wrong-type', expected: 'an integer ≥ 1' });
  });
});
