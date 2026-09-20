import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCliArgs, type ParsedFlags } from '../../../src/cli/args.js';
import { detectPackageRoot, resolveConfig } from '../../../src/config/resolve.js';
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
const resolve = (flags: ParsedFlags, env: NodeJS.ProcessEnv = {}) => resolveConfig(flags, env, cwd, { packageRoot: pkg, homedir: home });

describe('resolveConfig precedence', () => {
  it('uses defaults with their source when nothing is set, and never throws for a missing key', async () => {
    const c = await resolve(run());
    expect(c.entries.get('generator.provider')).toEqual({ value: 'anthropic', source: 'default' });
    expect(c.entries.get('generator.model')).toEqual({ value: 'claude-sonnet-5', source: 'default' });
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
    expect(c5.entries.get('generator.model')).toEqual({ value: 'claude-sonnet-5', source: 'default' });
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
  it('generator key by provider, with JEVCODE_API_KEY as the fallback; decider key falls back to OPENROUTER_API_KEY', async () => {
    const a = await resolve(run(), { ANTHROPIC_API_KEY: 'anthropic-key-1234', OPENROUTER_API_KEY: OR_KEY });
    expect(a.generator().apiKey).toBe('anthropic-key-1234');
    expect(a.generator().baseUrl).toBe('https://api.anthropic.com');
    expect(a.decider().apiKey).toBe(OR_KEY);
    const b = await resolve(run('--provider', 'openrouter'), { ANTHROPIC_API_KEY: 'anthropic-key-1234', OPENROUTER_API_KEY: OR_KEY });
    expect(b.generator().apiKey).toBe(OR_KEY);
    expect(b.generator().baseUrl).toBe('https://openrouter.ai/api/v1');
    const c = await resolve(run(), { JEVCODE_API_KEY: 'generic-key-1234', JEV_API_KEY: 'jev-key-12345678', OPENROUTER_API_KEY: OR_KEY });
    expect(c.generator().apiKey).toBe('generic-key-1234');
    expect(c.decider().apiKey).toBe('jev-key-12345678');
    // env layer beats the dotenv layer even when the dotenv holds the provider-specific name
    await writeFile(join(cwd, '.env'), 'ANTHROPIC_API_KEY=dotenv-anthropic-key\n');
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
    expect(ce.message).toContain('ANTHROPIC_API_KEY / JEVCODE_API_KEY (env)');
    expect(ce.message).toContain(`dotenv:${join(cwd, '.env')}`);
    expect(ce.message).toContain('no default');
    expect(() => c.decider()).toThrow(/decider\.apiKey/);
    expect(() => c.decider()).toThrow(/JEV_API_KEY \/ OPENROUTER_API_KEY/);
    expect(c.limits().maxSteps).toBe(40);
  });

  it('validates numbers, URLs and thresholds lazily and memoises the result', async () => {
    const bad = await resolve(run('--max-steps', 'ten'), { ANTHROPIC_API_KEY: 'anthropic-key-1234' });
    expect(() => bad.limits()).toThrow(/limits\.maxSteps: "ten" \(from flag\) is not an integer >= 1/);
    const bad2 = await resolve(run('--complete-threshold', '1.5'));
    expect(() => bad2.limits()).toThrow(/limits\.completeThreshold/);
    const bad3 = await resolve(run('--base-url', 'nope'), { ANTHROPIC_API_KEY: 'anthropic-key-1234' });
    expect(() => bad3.generator()).toThrow(/generator\.baseUrl: "nope" \(from flag\) is not a URL/);
    const bad4 = await resolve(run(), { JEVCODE_MAX_WALL: 'forever' });
    expect(() => bad4.limits()).toThrow(/limits\.maxWall: "forever" \(from env\) is not a duration/);
    const ok = await resolve(run('--temperature', '0.7', '--max-tokens', '1000', '--max-wall', '90s', '--spend-cap', '0.1'), { ANTHROPIC_API_KEY: 'anthropic-key-1234' });
    const g = ok.generator();
    expect(g.temperature).toBe(0.7);
    expect(g.maxTokens).toBe(1000);
    expect(ok.generator()).toBe(g);
    expect(ok.limits().maxWallMs).toBe(90_000);
    expect(ok.limits().spendCapUsd).toBe(0.1);
    expect(ok.limits()).toBe(ok.limits());
    const noTemp = await resolve(run(), { ANTHROPIC_API_KEY: 'anthropic-key-1234' });
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

  it('pricing: table for Sonnet 5, env overrides, zeros plus a warning for unknown models', async () => {
    const env = { OPENROUTER_API_KEY: OR_KEY };
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
