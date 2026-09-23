/**
 * docs/AGENT-LOOP-DESIGN.md §14.2 / §15 S4 (src/config/resolve.ts): agent mode needs the generator key only (Jev is optional), its
 * step default is AGENT_DEFAULT_MAX_STEPS (250) when the user set none, and `context.compaction`'s source is readable so the agent's
 * `llm` writer is its default only while the value is the default layer's. The legacy modes are unchanged.
 */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCliArgs, type ParsedFlags } from '../../../src/cli/args.js';
import { resolveConfig, settingIsExplicit, type ResolveOptions } from '../../../src/config/resolve.js';
import { AGENT_DEFAULT_MAX_STEPS, DEFAULT_MAX_STEPS } from '../../../src/config/defaults.js';

const OR_KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

let root: string;
let cwd: string;
let home: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'jevcode-cfg-agent-')));
  cwd = join(root, 'ws');
  home = join(root, 'home');
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const run = (...argv: string[]): ParsedFlags => parseCliArgs(['run', 'task', ...argv]);
const resolve = (flags: ParsedFlags, env: NodeJS.ProcessEnv = {}, opts: ResolveOptions = {}) => resolveConfig(flags, env, cwd, { homedir: home, ...opts });

describe('resolveConfig in agent mode (§14.2)', () => {
  it('missingSecrets(agent) needs the generator key only — no decider key, the legacy modes still need both', async () => {
    const none = await resolve(run('--mode', 'agent'));
    expect(none.missingSecrets('agent')).toEqual(['generator.apiKey']);
    expect(none.missingSecrets('jev-on')).toEqual(['generator.apiKey', 'decider.apiKey']);
    expect(none.missingSecrets('llm-jev')).toEqual(['generator.apiKey', 'decider.apiKey']);
    expect(none.missingSecrets('jev-only')).toEqual(['decider.apiKey']);
    // a generator key alone runs agent mode; one OpenRouter key serves both where both are needed
    const genOnly = await resolve(run('--mode', 'agent'), { JEVCODE_API_KEY: OR_KEY });
    expect(genOnly.missingSecrets('agent')).toEqual([]);
    expect((await resolve(run('--mode', 'agent', '--mock'))).missingSecrets('agent')).toEqual([]);
  });

  it('limits.maxSteps defaults to AGENT_DEFAULT_MAX_STEPS (250) in agent mode; an explicit value wins; other modes keep 40', async () => {
    expect(AGENT_DEFAULT_MAX_STEPS).toBe(250);
    const agent = await resolve(run('--mode', 'agent'));
    expect(agent.mode).toBe('agent');
    expect(agent.limits().maxSteps).toBe(AGENT_DEFAULT_MAX_STEPS);
    expect(agent.entries.get('limits.maxSteps')).toEqual({ value: '250', source: 'default' });
    expect((await resolve(run('--mode', 'agent', '--max-steps', '12'))).limits().maxSteps).toBe(12);
    expect((await resolve(run('--mode', 'agent'), { JEVCODE_MAX_STEPS: '30' })).limits().maxSteps).toBe(30);
    expect((await resolve(run('--mode', 'jev-on'))).limits().maxSteps).toBe(DEFAULT_MAX_STEPS);
    // a --resume re-resolve keyed on the run's recorded mode applies the same default
    expect((await resolve(run(), {}, { mode: 'agent' })).limits().maxSteps).toBe(AGENT_DEFAULT_MAX_STEPS);
  });

  it('context.compaction exposes its source: default → not explicit (the agent may pick llm); env / flag-layer values are honoured', async () => {
    const byDefault = await resolve(run('--mode', 'agent'));
    expect(byDefault.entries.get('context.compaction')).toEqual({ value: 'code', source: 'default' });
    expect(settingIsExplicit(byDefault.record(), 'context.compaction')).toBe(false);
    const fromEnv = await resolve(run('--mode', 'agent'), { JEVCODE_CONTEXT_COMPACTION: 'code' });
    expect(settingIsExplicit(fromEnv.record(), 'context.compaction')).toBe(true);
    expect(fromEnv.context?.().compaction).toBe('code');
  });

  it('settingIsExplicit: absent, default and derived rows are not the user’s; a discarded file value was never in force', () => {
    expect(settingIsExplicit({}, 'context.compaction')).toBe(false);
    expect(settingIsExplicit({ 'context.compaction': { value: 'llm', source: 'default' } }, 'context.compaction')).toBe(false);
    expect(settingIsExplicit({ 'session.spendCapUsd': { value: '50', source: 'derived' } }, 'session.spendCapUsd')).toBe(false);
    expect(settingIsExplicit({ 'context.compaction': { value: 'off', source: 'flag' } }, 'context.compaction')).toBe(true);
    expect(settingIsExplicit({ 'context.compaction': { value: 'code', source: 'file:/x/config.json' } }, 'context.compaction')).toBe(true);
    expect(settingIsExplicit({ 'context.compaction': { value: 'bad', source: 'file:/x/config.json', problem: { kind: 'wrong-type', expected: 'one of code|llm|off' } } }, 'context.compaction')).toBe(false);
  });
});
