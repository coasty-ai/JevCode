/**
 * AGENT-LOOP-DESIGN §14.2 (Jev optional): `jevcode login --status` in agent mode reads `needs: generator (Jev optional)`, and a
 * missing `decider.apiKey` is not a failure there — the generator key alone makes an agent session `ok`. Every legacy mode keeps
 * its own rule: jev-only needs Jev alone, the rest need both.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandLogin, modeNeeds, type CommandIo } from '../../../src/cli/login.js';
import type { Resolved } from '../../../src/core/types.js';

let dir: string;
let home: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jevcode-login-agent-'));
  home = join(dir, 'home');
  await mkdir(home, { recursive: true });
  await mkdir(join(dir, 'ws'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const GEN_KEY = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123';

function io(mode: string, secrets: Map<string, Resolved<string>>): CommandIo & { text(): string } {
  let out = '';
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdin.end();
  return {
    stdin,
    stdout: { write: (s: string) => ((out += s), true) },
    stderr: { write: () => true },
    env: { XDG_CONFIG_HOME: join(home, 'xdg'), JEVCODE_MODE: mode, JEVCODE_EXTRA_ENV_FILE: join(dir, 'none.env') },
    home,
    cwd: join(dir, 'ws'),
    platform: 'darwin',
    resolveSecrets: async () => secrets,
    text: () => out,
  } as CommandIo & { text(): string };
}

describe('jevcode login --status under agent mode (§14.2)', () => {
  it('the generator key alone is ok: `needs: generator (Jev optional)`, `decider.apiKey: not set`, exit 0', async () => {
    const t = io('agent', new Map<string, Resolved<string>>([['generator.apiKey', { value: GEN_KEY, source: 'env' }]]));
    expect(await commandLogin({ status: true }, t)).toBe(0);
    expect(t.text()).toContain('decider.apiKey: not set');
    expect(t.text()).toContain('mode: agent (env) — needs: generator (Jev optional)');
  });

  it('no generator key is still a failure in agent mode (exit 1)', async () => {
    const t = io('agent', new Map<string, Resolved<string>>([['decider.apiKey', { value: GEN_KEY, source: 'env' }]]));
    expect(await commandLogin({ status: true }, t)).toBe(1);
    expect(t.text()).toContain('generator.apiKey: not set');
  });

  it('legacy modes are unchanged: a missing Jev key fails jev-on; jev-only needs Jev alone', async () => {
    const genOnly = new Map<string, Resolved<string>>([['generator.apiKey', { value: GEN_KEY, source: 'env' }]]);
    const t = io('jev-on', genOnly);
    expect(await commandLogin({ status: true }, t)).toBe(1);
    expect(t.text()).toContain('needs: generator, jev');
    expect(modeNeeds('jev-only')).toBe('jev');
    expect(modeNeeds('llm-jev')).toBe('generator, jev');
    expect(modeNeeds('agent')).toBe('generator (Jev optional)');
  });
});
