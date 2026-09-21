import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCliArgs, type ParsedFlags } from '../../../src/cli/args.js';
import { detectPackageRoot, negateBooleanText, reconcileResumeConfig, resolveConfig, resumeIdentityFromRunMeta, type ResolveOptions } from '../../../src/config/resolve.js';
import type { RunMeta } from '../../../src/core/types.js';
import { fingerprint } from '../../../src/config/mask.js';
import { ConfigError } from '../../../src/errors.js';

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
const resolve = (flags: ParsedFlags, env: NodeJS.ProcessEnv = {}, opts: ResolveOptions = {}) => resolveConfig(flags, env, cwd, { packageRoot: pkg, homedir: home, ...opts });

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
    expect(c.openAssistPath).toBeNull();
    expect(c.configFile).toBeNull();
    expect(c.dotenvFiles).toEqual([]);
    expect(c.sandbox).toBe('auto');
    expect(c.noNetwork).toBe(false);
    expect(c.plain).toBe(false);
    expect(c.warnings).toEqual([]);
    expect(c.limits()).toEqual({
      maxSteps: 40,
      maxWallMs: 30 * 60_000,
      maxReplans: 5,
      completeThreshold: 0.85,
      impossibleThreshold: 0.85,
      commandTimeoutMs: 120_000,
      maxCommandTimeoutMs: 600_000,
      maxOutputBytes: 200 * 1024,
      spendCapUsd: 2,
    });
  });

  it('flag > env > ./.env > <OPEN_ASSIST_PATH>/.env > config file > default, one layer at a time', async () => {
    const oa = join(root, 'open-assist');
    await mkdir(oa);
    await writeFile(join(oa, '.env'), 'JEVCODE_MODEL=from-oa\nJEVCODE_MAX_STEPS=4\nJEV_MODEL=jev-1.13\nJEVCODE_SPEND_CAP_USD=1\n');
    await writeFile(join(cwd, '.env'), 'JEVCODE_MODEL=from-dotenv\nJEVCODE_MAX_STEPS=3\nJEV_MODEL=typesafe/jev-1.13\n');
    await writeFile(join(cwd, 'jevcode.json'), JSON.stringify({ model: 'from-file', maxSteps: 5, jevModel: 'jev-1.13-20260101', spendCapUsd: 0.25, maxReplans: 1 }));
    const env = { JEVCODE_MODEL: 'from-env', JEVCODE_MAX_STEPS: '2', OPEN_ASSIST_PATH: oa };

    const c = await resolve(run('--model', 'from-flag'), env);
    expect(c.entries.get('generator.model')).toEqual({ value: 'from-flag', source: 'flag' });
    expect(c.entries.get('limits.maxSteps')).toEqual({ value: '2', source: 'env' });
    expect(c.entries.get('decider.model')).toEqual({ value: 'typesafe/jev-1.13', source: `dotenv:${join(cwd, '.env')}` });
    expect(c.entries.get('limits.spendCapUsd')).toEqual({ value: '1', source: `dotenv:${join(oa, '.env')}` });
    expect(c.entries.get('limits.maxReplans')).toEqual({ value: '1', source: `file:${join(cwd, 'jevcode.json')}` });
    expect(c.entries.get('limits.completeThreshold')).toEqual({ value: '0.85', source: 'default' });
    expect(c.entries.get('openAssistPath')).toEqual({ value: oa, source: 'env' });
    expect(c.configFile).toBe(join(cwd, 'jevcode.json'));
    expect(c.dotenvFiles).toEqual([join(cwd, '.env'), join(oa, '.env')]);

    const c2 = await resolve(run(), { ...env, JEVCODE_MODEL: '' });
    expect(c2.entries.get('generator.model')).toEqual({ value: 'from-dotenv', source: `dotenv:${join(cwd, '.env')}` });
    await writeFile(join(cwd, '.env'), 'JEVCODE_MODEL=\n');
    const c3 = await resolve(run(), { OPEN_ASSIST_PATH: oa });
    expect(c3.entries.get('generator.model')).toEqual({ value: 'from-oa', source: `dotenv:${join(oa, '.env')}` });
    const c4 = await resolve(run());
    expect(c4.entries.get('generator.model')).toEqual({ value: 'from-file', source: `file:${join(cwd, 'jevcode.json')}` });
    await rm(join(cwd, 'jevcode.json'));
    const c5 = await resolve(run());
    expect(c5.entries.get('generator.model')).toEqual({ value: 'z-ai/glm-5.3-flash', source: 'default' });
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
    expect(c.limits().maxSteps).toBe(40);
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
    expect((await resolve(run(), env)).decider()).toEqual({ baseUrl: 'https://openrouter.ai/api/alpha/decisions', apiKey: OR_KEY, model: 'typesafe/jev-1.13-20260917', pinned: true });
    expect((await resolve(run('--jev-model', 'TypeSafe/Jev-1.13'), env)).decider()).toMatchObject({ model: 'TypeSafe/Jev-1.13', pinned: false });
    expect((await resolve(run('--jev-model', 'jev-1.13-20260917', '--jev-base-url', 'https://proxy.test/decisions/'), env)).decider()).toMatchObject({ pinned: true, baseUrl: 'https://proxy.test/decisions' });
    const badModel = await resolve(run('--jev-model', '!!bad'), env);
    expect(() => badModel.decider()).toThrow(/decider\.model/);
  });

  it('pricing: table for the default GLM 5.3 Flash and for Sonnet 5, env overrides, zeros plus a warning for unknown models', async () => {
    const env = { OPENROUTER_API_KEY: OR_KEY };
    const dflt = await resolve(run(), env);
    expect(dflt.generator().pricing).toEqual({ inputPerM: 0.09, outputPerM: 0.3, cacheReadPerM: 0.018, cacheWritePerM: expect.closeTo(0.1125, 12) });
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

  it('rejects an invalid provider or sandbox from the env with the setting name', async () => {
    const c = await resolve(run(), { JEVCODE_PROVIDER: 'openai' });
    expect(() => c.generator()).toThrow(/generator\.provider: "openai" \(from env\) is not one of anthropic\|openrouter/);
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

  it('Open Assist path: sibling ../open-assist of the package by default, its .env joins the chain, and both dotenvs are secretPaths', async () => {
    const sibling = join(root, 'pkg', 'open-assist');
    await mkdir(sibling);
    await writeFile(join(sibling, '.env'), `JEV_API_KEY=${OR_KEY}\nUNUSED_TOKEN=unused-token-value-1234\n`);
    const c = await resolve(run());
    expect(c.openAssistPath).toBe(sibling);
    expect(c.entries.get('openAssistPath')).toEqual({ value: sibling, source: 'default' });
    expect(c.entries.get('decider.apiKey')).toEqual({ value: OR_KEY, source: `dotenv:${join(sibling, '.env')}` });
    expect(c.secretPaths).toEqual(expect.arrayContaining([join(cwd, '.env'), join(sibling, '.env')]));
    expect(c.dotenvFiles).toEqual([join(sibling, '.env')]);
    expect(c.redact(`x ${OR_KEY} y unused-token-value-1234`)).toBe('x [REDACTED:decider.apiKey] y [REDACTED:UNUSED_TOKEN]');
    const explicit = await resolve(run('--open-assist-path', 'nowhere'));
    expect(explicit.openAssistPath).toBe(join(cwd, 'nowhere'));
    expect(explicit.dotenvFiles).toEqual([]);
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
  const LAUNCH = { fps: 30, renderMode: 'standard' as const, screenReader: false, ascii: false, noColor: false };

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

  it('the run cap default is mode-keyed after --mode (P45): $0.25 under jev-only, $2.00 otherwise, explicit values untouched', async () => {
    const jo = await resolve(run('--mode', 'jev-only'));
    expect(jo.entries.get('limits.spendCapUsd')).toEqual({ value: '0.25', source: 'default' });
    expect(jo.limits().spendCapUsd).toBe(0.25);
    expect(jo.sessionSpendCap('jev-only')).toEqual({ value: 1.25, source: 'derived', derived: true });
    expect((await resolve(run('--condition', 'jev-only'))).limits().spendCapUsd).toBe(0.25);
    expect((await resolve(run())).limits().spendCapUsd).toBe(2);
    expect((await resolve(run('--mode', 'jev-off'))).limits().spendCapUsd).toBe(2);
    expect((await resolve(run('--mode', 'jev-only', '--spend-cap', '1'))).limits().spendCapUsd).toBe(1);
    expect((await resolve(run('--mode', 'jev-only'), { JEVCODE_SPEND_CAP_USD: '0.5' })).entries.get('limits.spendCapUsd')).toEqual({ value: '0.5', source: 'env' });
  });

  it('sessionSpendCap(mode): derived 5 × run cap, configured through the chain, none = +Infinity; the record prints the derived row', async () => {
    const c = await resolve(run());
    expect(c.sessionSpendCap('jev-on')).toEqual({ value: 10, source: 'derived', derived: true });
    expect(c.sessionSpendCap('jev-only')).toEqual({ value: 1.25, source: 'derived', derived: true });
    expect(c.record()['session.spendCapUsd']).toEqual({ value: '10', source: 'derived' });
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
    const bad = await resolve(run('--provider', 'anthropic', '--model', 'claude-next'), env);
    expect(() => bad.generator()).toThrow('generator.model "claude-next" has no pricing entry, so the $2.000 spend cap could not be enforced. Set JEVCODE_PRICE_IN_PER_M and JEVCODE_PRICE_OUT_PER_M (USD per million tokens), or pass --allow-unpriced to run under a token cap instead.');
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
    expect(jo.entries.get('limits.spendCapUsd')).toEqual({ value: '0.25', source: 'default' });
    expect(jo.limits().spendCapUsd).toBe(0.25);
    expect(jo.sessionSpendCap('jev-only')).toEqual({ value: 1.25, source: 'derived', derived: true });
    expect((await resolve(run(), {}, { mode: 'jev-on' })).limits().spendCapUsd).toBe(2);
    // an explicit --mode on the command line is the same signal
    expect((await resolve(run('--mode', 'jev-only'), {}, {})).limits().spendCapUsd).toBe(0.25);
    // a configured cap is never touched by the mode
    expect((await resolve(run('--spend-cap', '1'), {}, { mode: 'jev-only' })).limits().spendCapUsd).toBe(1);
  });
});
