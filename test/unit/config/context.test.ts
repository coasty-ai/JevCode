/**
 * TUI-DESIGN-5 §10 (R5-3) / §3.6 (D-AI) — the `context.*` config chain, all three layers.
 *
 * D-AI exists because (a) alone — the schema rows — ships dead code exactly like the hook round 4 left behind. So
 * this file pins the whole chain: every row resolves through env > `./.env` > `<JEVCODE_EXTRA_ENV_FILE>` > config
 * file > default; `resolveContextConfig` turns those entries into a sparse `ContextPolicyOptions`;
 * `ResolvedConfig.context()` is ALWAYS set after `resolveConfig` (which is what makes the member's own doc comment
 * in `src/core/types.ts` true); and `EngineOptions.contextPolicy` is non-undefined at BOTH `createEngine` sites in
 * `src/cli/session.ts` — the start and the resume.
 *
 * No `context.*` row has a CLI flag: `src/cli/args.ts` belongs to another slot this round and §3.6's own table
 * prints `—` in the Flag column for all five rows. The chain's top layer for these settings is therefore `env`.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCliArgs, type ParsedFlags } from '../../../src/cli/args.js';
import { commandConfigSet } from '../../../src/cli/login.js';
import { resolveConfig, resolveContextConfig, type ResolveOptions } from '../../../src/config/resolve.js';
import { BASE_URLS, CONTEXT_COMPACTIONS, CONTEXT_KEPT_RANKERS, CONTEXT_VIEWS, DEFAULT_CONTEXT_COMPACTION, DEFAULT_CONTEXT_COMPACT_EVERY, DEFAULT_CONTEXT_KEPT, DEFAULT_CONTEXT_VIEW, SETTINGS, settingSpec } from '../../../src/config/defaults.js';
import { PROVIDER_BASE_URL, PROVIDER_IDS, keyEnvNames } from '../../../src/provider/ids.js';
import type { SettingName } from '../../../src/config/types.js';
import type { SettingReader } from '../../../src/config/validate.js';
import type { ContextPolicyOptions, Resolved } from '../../../src/core/types.js';
import { finishedRunLines, loadedRun, makeController, scriptedRunId, type Harness } from '../cli/helpers.js';

const CONTEXT_ROWS: readonly SettingName[] = ['context.mode', 'context.compaction', 'context.kept', 'context.compactEvery', 'context.historySteps', 'context.fileCacheBytes', 'context.budgetChars'];

let root: string;
let cwd: string;
let home: string;
let oa: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'jevcode-ctx-')));
  cwd = join(root, 'ws');
  home = join(root, 'home');
  oa = join(root, 'oa');
  for (const d of [cwd, home, oa]) await mkdir(d, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const run = (...argv: string[]): ParsedFlags => parseCliArgs(['run', 'task', ...argv]);
const resolve = (flags: ParsedFlags, env: NodeJS.ProcessEnv = {}, opts: ResolveOptions = {}) => resolveConfig(flags, env, cwd, { homedir: home, ...opts });

/** A one-entry reader, so `resolveContextConfig` can be table-tested without a filesystem. */
function reader(entries: Partial<Record<SettingName, string>>): SettingReader {
  const map = new Map<SettingName, Resolved<string>>();
  for (const [k, v] of Object.entries(entries)) map.set(k as SettingName, { value: v, source: 'env' });
  return { get: (n) => map.get(n), sources: () => [] };
}

describe('§3.6 the schema — five rows in the design, seven on the tree, one owner', () => {
  it('every `context.*` name the design lists has a SETTINGS row, and `context.kept` is the one round 5 added (G-R5-8)', () => {
    for (const name of CONTEXT_ROWS) expect(SETTINGS.find((s) => s.name === name), name).toBeDefined();
    // the design's §3.6 table lists five; round 4 had already landed `historySteps` and `fileCacheBytes` and had
    // NOT landed `kept`, so the union of the two lists is what the schema must carry
    expect(SETTINGS.filter((s) => s.name.startsWith('context.')).map((s) => s.name)).toEqual([...CONTEXT_ROWS]);
  });

  it('`context.kept` is an enum row with a default, an env name and a file key — printed, validated and persisted like its siblings', () => {
    const spec = settingSpec('context.kept');
    expect(spec.shape).toEqual({ kind: 'enum', values: CONTEXT_KEPT_RANKERS });
    expect(spec.defaultValue).toBe(DEFAULT_CONTEXT_KEPT);
    expect(spec.fileKey).toBe('contextKept');
    expect(spec.secret).toBe(false);
    expect(spec.hidden).toBeUndefined();
    expect([...CONTEXT_KEPT_RANKERS]).toEqual(['code', 'jev']);
  });

  it('no `context.*` row is a launch setting or a secret (they resolve after the first frame, §3.6)', () => {
    for (const name of CONTEXT_ROWS) {
      const spec = settingSpec(name);
      expect(spec.launch, name).toBeUndefined();
      expect(spec.secret, name).toBe(false);
      expect(spec.flag, name).toBeUndefined();
    }
  });
});

describe('§3.6 / §10 — every row resolves through the chain: env > ./.env > JEVCODE_EXTRA_ENV_FILE/.env > file > default', () => {
  it('the default layer answers for the three rows that have a default, and the other four stay absent', async () => {
    const c = await resolve(run());
    expect(c.entries.get('context.mode')).toEqual({ value: DEFAULT_CONTEXT_VIEW, source: 'default' });
    expect(c.entries.get('context.compaction')).toEqual({ value: DEFAULT_CONTEXT_COMPACTION, source: 'default' });
    expect(c.entries.get('context.kept')).toEqual({ value: DEFAULT_CONTEXT_KEPT, source: 'default' });
    expect(c.entries.get('context.compactEvery')).toEqual({ value: String(DEFAULT_CONTEXT_COMPACT_EVERY), source: 'default' });
    expect(c.entries.has('context.historySteps')).toBe(false);
    expect(c.entries.has('context.fileCacheBytes')).toBe(false);
    expect(c.entries.has('context.budgetChars')).toBe(false);
  });

  it('the config file beats the default, each `.env` beats the file, and the process env beats them all — per row', async () => {
    await writeFile(join(cwd, 'jevcode.json'), JSON.stringify({ contextMode: 'legacy', contextCompaction: 'llm', contextKept: 'jev', contextCompactEvery: 3, contextHistorySteps: 5, contextFileCacheBytes: 4096, contextBudgetChars: 12_345 }));
    const file = `file:${join(cwd, 'jevcode.json')}`;
    const fromFile = await resolve(run());
    for (const name of CONTEXT_ROWS) expect(fromFile.entries.get(name)?.source, name).toBe(file);
    expect(fromFile.entries.get('context.budgetChars')?.value).toBe('12345');

    // <JEVCODE_EXTRA_ENV_FILE> beats the file
    await writeFile(join(oa, '.env'), 'JEVCODE_CONTEXT_COMPACTION=off\n');
    const fromOa = await resolve(run(), { JEVCODE_EXTRA_ENV_FILE: join(oa, '.env') });
    expect(fromOa.entries.get('context.compaction')).toEqual({ value: 'off', source: `dotenv:${join(oa, '.env')}` });

    // ./.env beats <JEVCODE_EXTRA_ENV_FILE>
    await writeFile(join(cwd, '.env'), 'JEVCODE_CONTEXT_COMPACTION=llm\nJEVCODE_CONTEXT_HISTORY_STEPS=9\n');
    const fromDotenv = await resolve(run(), { JEVCODE_EXTRA_ENV_FILE: join(oa, '.env') });
    expect(fromDotenv.entries.get('context.compaction')).toEqual({ value: 'llm', source: `dotenv:${join(cwd, '.env')}` });
    expect(fromDotenv.entries.get('context.historySteps')).toEqual({ value: '9', source: `dotenv:${join(cwd, '.env')}` });

    // the process environment beats every one of them
    const fromEnv = await resolve(run(), { JEVCODE_EXTRA_ENV_FILE: join(oa, '.env'), JEVCODE_CONTEXT_MODE: 'relaxed', JEVCODE_CONTEXT_COMPACTION: 'code', JEVCODE_CONTEXT_KEPT: 'code', JEVCODE_CONTEXT_COMPACT_EVERY: '16', JEVCODE_CONTEXT_HISTORY_STEPS: '20', JEVCODE_CONTEXT_FILE_CACHE_BYTES: '65536', JEVCODE_CONTEXT_BUDGET_CHARS: '90000' });
    for (const name of CONTEXT_ROWS) expect(fromEnv.entries.get(name)?.source, name).toBe('env');
    expect(fromEnv.context?.()).toEqual({ view: 'relaxed', compaction: 'code', kept: 'code', compactEvery: 16, historySteps: 20, fileCacheBytes: 65_536, budgetChars: 90_000 });
  });

  it('`sourcesConsulted` names the layers a user has to look in for every row (`jevcode config --explain`)', async () => {
    await writeFile(join(cwd, 'jevcode.json'), '{}');
    const c = await resolve(run());
    for (const name of CONTEXT_ROWS) {
      const consulted = c.sourcesConsulted(name).join(' | ');
      // no flag layer for a `context.*` row (§3.6's table prints `—`), so the top layer named is the variable
      expect(consulted, name).not.toContain('(flag)');
      expect(consulted, name).toContain('(env)');
      expect(consulted, name).toContain(`${settingSpec(name).fileKey!} (file:`);
      expect(consulted, name).toMatch(/default |no default/);
    }
  });
});

describe('§3.6 — `resolveContextConfig`, the sparse policy (D-AI layer 2)', () => {
  it('maps every mapped row, and returns ONLY the members that resolved', () => {
    expect(resolveContextConfig(reader({}))).toEqual({});
    expect(resolveContextConfig(reader({ 'context.mode': 'LEGACY ', 'context.compaction': ' Off' }))).toEqual({ view: 'legacy', compaction: 'off' });
    const all: ContextPolicyOptions = resolveContextConfig(reader({ 'context.mode': 'relaxed', 'context.compaction': 'llm', 'context.compactEvery': '0', 'context.historySteps': '12', 'context.fileCacheBytes': '0', 'context.budgetChars': '1' }));
    expect(all).toEqual({ view: 'relaxed', compaction: 'llm', compactEvery: 0, historySteps: 12, fileCacheBytes: 0, budgetChars: 1 });
    // every enum value the schema accepts round-trips
    for (const v of CONTEXT_VIEWS) expect(resolveContextConfig(reader({ 'context.mode': v })).view).toBe(v);
    for (const v of CONTEXT_COMPACTIONS) expect(resolveContextConfig(reader({ 'context.compaction': v })).compaction).toBe(v);
  });

  it('a malformed value is SKIPPED, never thrown — the result now reaches `createEngine`, so a stray variable must not crash a run', () => {
    const bad = reader({ 'context.mode': 'sideways', 'context.compaction': 'yes', 'context.compactEvery': '-1', 'context.historySteps': '0', 'context.fileCacheBytes': '1.5', 'context.budgetChars': 'many' });
    expect(() => resolveContextConfig(bad)).not.toThrow();
    expect(resolveContextConfig(bad)).toEqual({});
    expect(resolveContextConfig(reader({ 'context.compactEvery': '' }))).toEqual({});
  });

  it('round-5 item 19: `context.kept` IS mapped into ContextPolicyOptions, both values, and nothing is parked', async () => {
    expect(resolveContextConfig(reader({ 'context.kept': 'jev' })).kept).toBe('jev');
    expect(resolveContextConfig(reader({ 'context.kept': 'code' })).kept).toBe('code');
    expect(resolveContextConfig(reader({ 'context.kept': ' JEV ' })).kept).toBe('jev');
    // a malformed value is skipped like every other row, never thrown and never a default in disguise
    expect(resolveContextConfig(reader({ 'context.kept': 'sideways' }))).toEqual({});
    // the old `CONTEXT_KEPT_PARKED` warning is gone from every layer
    const jev = await resolve(run(), { JEVCODE_CONTEXT_KEPT: 'jev' });
    expect(jev.warnings.filter((w) => w.startsWith('context.kept:'))).toEqual([]);
    expect(jev.context?.().kept).toBe('jev');
    expect((await resolve(run())).context?.().kept).toBe(DEFAULT_CONTEXT_KEPT);
  });

  it('round-5 item 19: `context.kept` reaches the engine from every layer, and the SETTINGS row no longer says it is unwired', async () => {
    expect(settingSpec('context.kept').description).toBe('kept-items ranker (code|jev)');
    // the config file
    await writeFile(join(cwd, 'jevcode.json'), JSON.stringify({ contextKept: 'jev' }));
    const fromFile = await resolve(run());
    expect(fromFile.entries.get('context.kept')?.source).toBe(`file:${join(cwd, 'jevcode.json')}`);
    expect(fromFile.context?.().kept).toBe('jev');
    // `./.env`, which beats the file
    await writeFile(join(cwd, '.env'), 'JEVCODE_CONTEXT_KEPT=code\n');
    expect((await resolve(run())).context?.().kept).toBe('code');
    // <JEVCODE_EXTRA_ENV_FILE>, below `./.env`
    await rm(join(cwd, '.env'));
    await writeFile(join(oa, '.env'), 'JEVCODE_CONTEXT_KEPT=jev\n');
    expect((await resolve(run(), { JEVCODE_EXTRA_ENV_FILE: join(oa, '.env') })).context?.().kept).toBe('jev');
    // the process env beats them all
    expect((await resolve(run(), { JEVCODE_EXTRA_ENV_FILE: join(oa, '.env'), JEVCODE_CONTEXT_KEPT: 'code' })).context?.().kept).toBe('code');
  });

  it('`jevcode config set context.kept jev` round-trips through the file the next resolve reads and reaches the engine', async () => {
    const configPath = join(root, 'xdg-config.json');
    const env: NodeJS.ProcessEnv = { JEVCODE_CONFIG: configPath };
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      stdin: process.stdin,
      stdout: { write: (x: string) => void out.push(x) },
      stderr: { write: (x: string) => void err.push(x) },
      env,
      home,
      cwd,
    };
    expect(await commandConfigSet('context.kept', 'jev', io)).toBe(0);
    expect(err).toEqual([]);
    expect(out.join('')).toContain('context.kept = jev');

    const c = await resolve(run(), env);
    expect(c.entries.get('context.kept')).toEqual({ value: 'jev', source: `file:${configPath}` });
    expect(c.warnings.filter((w) => w.startsWith('context.kept:'))).toEqual([]);
    expect(c.context?.().kept).toBe('jev');

    const back: string[] = [];
    expect(await commandConfigSet('context.kept', 'code', { ...io, stdout: { write: (x: string) => void back.push(x) } })).toBe(0);
    expect((await resolve(run(), env)).context?.().kept).toBe('code');
  });
});

/**
 * TUI-DESIGN-5 §6.3 rows 1 and 2 — R5-6's hunks, landed by R5-3 in this slot's W4 config PR (§6.3's landing table,
 * §9.2's `config/resolve.ts` and `config/{types,defaults,validate}.ts` rows). Row 1 was a LIVE bug.
 */
describe('§6.3 rows 1 and 2 — the two provider tables this slot owns', () => {
  it('row 1: the generator key falls back to EVERY variable `provider/ids.ts` names, gemini and meta included', async () => {
    // the bug: `gemini`'s second name was unreachable, so a user with only GOOGLE_API_KEY set had no key at all
    const gemini = await resolve(run(), { JEVCODE_PROVIDER: 'gemini', GOOGLE_API_KEY: 'g-secret' });
    expect(gemini.entries.get('generator.apiKey')?.value).toBe('g-secret');
    const meta = await resolve(run(), { JEVCODE_PROVIDER: 'meta', MODEL_API_KEY: 'm-secret' });
    expect(meta.entries.get('generator.apiKey')?.value).toBe('m-secret');
    // JevCode's own spelling still wins when both are set (`ids.ts` orders the list)
    const both = await resolve(run(), { JEVCODE_PROVIDER: 'gemini', GEMINI_API_KEY: 'own', GOOGLE_API_KEY: 'sdk' });
    expect(both.entries.get('generator.apiKey')?.value).toBe('own');
    // behaviour-neutral for the two providers the old two-entry table knew
    const anthropic = await resolve(run(), { JEVCODE_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'a' });
    expect(anthropic.entries.get('generator.apiKey')?.value).toBe('a');
    const openrouter = await resolve(run(), { JEVCODE_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'o' });
    expect(openrouter.entries.get('generator.apiKey')?.value).toBe('o');
    // and `sourcesConsulted` names every variable a user has to look in, for every id
    for (const id of PROVIDER_IDS) {
      const c = await resolve(run(), { JEVCODE_PROVIDER: id });
      const consulted = c.sourcesConsulted('generator.apiKey').join(' | ');
      for (const name of keyEnvNames(id)) expect(consulted, `${id} ${name}`).toContain(name);
    }
    // a value that is not a provider id adds no variable and does not throw
    const bogus = await resolve(run(), { JEVCODE_PROVIDER: 'not-a-provider', ANTHROPIC_API_KEY: 'a' });
    expect(bogus.sourcesConsulted('generator.apiKey').join(' | ')).not.toContain('not-a-provider');
  });

  it('row 2: `BASE_URLS` IS the seven-entry zero-import table, so the two copies cannot drift', () => {
    expect(BASE_URLS).toBe(PROVIDER_BASE_URL);
    for (const id of PROVIDER_IDS) expect(BASE_URLS[id], id).toBe(PROVIDER_BASE_URL[id]);
    // the two values the old two-entry literal held are unchanged — the row is behaviour-neutral
    expect(BASE_URLS.anthropic).toBe('https://api.anthropic.com');
    expect(BASE_URLS.openrouter).toBe('https://openrouter.ai/api/v1');
  });
});

describe('§8.1 item 8 / §10 — `ResolvedConfig.context()` is ALWAYS set after `resolveConfig`', () => {
  it('the member exists and always carries the three rows the config layer pins, whatever the flags', async () => {
    for (const flags of [run(), run('--mode', 'jev-only'), run('--mock'), run('--plain')]) {
      const c = await resolve(flags);
      expect(typeof c.context).toBe('function');
      expect(c.context?.()).toEqual({ view: 'relaxed', compaction: 'code', kept: 'code', compactEvery: 8 });
    }
  });

  it('it is the same function `resolveContextConfig` is, so `jevcode config` and the engine can never disagree', async () => {
    const c = await resolve(run(), { JEVCODE_CONTEXT_COMPACTION: 'off', JEVCODE_CONTEXT_BUDGET_CHARS: '50000' });
    expect(c.context?.()).toEqual({ view: 'relaxed', compaction: 'off', kept: 'code', compactEvery: 8, budgetChars: 50_000 });
    expect(c.context?.()).toEqual(resolveContextConfig({ get: (n) => c.entries.get(n), sources: () => [] }));
  });

  /**
   * The extraction moved the body from a closure over `entries` to a `SettingReader` argument. `ResolvedConfig`
   * hands it the resolver's own reader, whose `get` IS `entries.get` today — but nothing in the type says so, and a
   * normalising reader added later would make `jevcode config`'s printed row and the engine's policy disagree
   * silently. This asserts the equality over the whole surface, every row and every layer, rather than one value.
   */
  it('the resolver\u2019s reader and `entries` answer identically for every `context.*` row, at every layer', async () => {
    await writeFile(join(cwd, 'jevcode.json'), JSON.stringify({ contextMode: 'legacy', contextFileCacheBytes: 4096 }));
    await writeFile(join(cwd, '.env'), 'JEVCODE_CONTEXT_COMPACT_EVERY=3\n');
    const c = await resolve(run(), { JEVCODE_CONTEXT_COMPACTION: 'llm', JEVCODE_CONTEXT_HISTORY_STEPS: '7' });
    const fromEntries: SettingReader = { get: (n) => c.entries.get(n), sources: (n) => c.sourcesConsulted(n) };
    for (const name of CONTEXT_ROWS) expect(fromEntries.get(name), name).toEqual(c.entries.get(name));
    expect(c.context?.()).toEqual(resolveContextConfig(fromEntries));
    expect(c.context?.()).toEqual({ view: 'legacy', compaction: 'llm', kept: 'code', compactEvery: 3, historySteps: 7, fileCacheBytes: 4096 });
    // and the member is stable: two calls build two equal objects, never a memoised alias a caller could mutate
    expect(c.context?.()).not.toBe(c.context?.());
    expect(c.context?.()).toEqual(c.context?.());
  });
});

describe('§3.6 / §9.3 constraint (c) — `EngineOptions.contextPolicy` at EVERY `createEngine` site', () => {
  const harnesses: Harness[] = [];
  afterEach(() => {
    for (const h of harnesses.splice(0)) h.cleanup();
  });
  const build = async (...args: Parameters<typeof makeController>): Promise<Harness> => {
    const h = await makeController(...args);
    harnesses.push(h);
    return h;
  };

  it('the START site passes it, and the chain reaches the engine (this line is the whole of D-AI layer 3)', async () => {
    const h = await build({ env: { JEVCODE_CONTEXT_COMPACTION: 'off', JEVCODE_CONTEXT_HISTORY_STEPS: '4' } });
    void h.controller.run();
    await h.ready();
    await h.submit('do a thing');
    expect(h.factory.calls).toHaveLength(1);
    const opts = h.factory.calls[0]!;
    expect(opts.contextPolicy).toBeDefined();
    expect(opts.contextPolicy).toEqual({ view: 'relaxed', compaction: 'off', kept: 'code', compactEvery: 8, historySteps: 4 });
  });

  it('the RESUME site passes it too, re-read from the chain so a setting changed between runs takes effect', async () => {
    const ws = '/tmp/ws-ctx-resume';
    const resumed = scriptedRunId(921);
    const h = await build({
      env: { JEVCODE_CONTEXT_COMPACTION: 'llm' },
      indexLines: finishedRunLines({ sessionId: 'S1', runId: resumed, workspace: ws, task: 'resumed', cost: { generator: 0.1, jev: 0 }, stop: 'max_steps' }),
      deps: {
        loadForResume: async (_dir, runId) => ({
          meta: loadedRun({ runId, sessionId: 'S1', workspace: h!.workspace, task: 'resumed' }).meta,
          state: loadedRun({ runId, sessionId: 'S1', workspace: h!.workspace, step: 3, stop: 'max_steps' }).state!,
          previousStopReason: 'max_steps',
          warnings: [],
        }),
      },
    });
    void h.controller.run();
    await h.ready();
    await h.command(`/resume ${resumed}`);
    expect(h.factory.calls).toHaveLength(1);
    expect(h.factory.calls[0]!.resume).toEqual({ runId: resumed, force: false });
    expect(h.factory.calls[0]!.contextPolicy).toEqual({ view: 'relaxed', compaction: 'llm', kept: 'code', compactEvery: 8 });
  });
});
