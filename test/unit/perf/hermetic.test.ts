/**
 * Hermetic child environments (TUI-DESIGN-2 §8.2; docs/STATUS.md "Round 2" finding 2): `resolveConfig` reads the legacy
 * `$HOME/.config/jevcode/config.json` when the XDG file is absent (`src/config/resolve.ts` candidates `[cwd/jevcode.json,
 * xdgFile, legacyFile]`), so every pty and perf child must get an isolated `HOME` — not only `XDG_CONFIG_HOME` — and never
 * `JEVCODE_CONFIG`. Each case plants a legacy credentials file with fake keys in a fake HOME that the *parent* uses,
 * spawns `jevcode config` under the environment the harness builds (`test/pty/helpers.ts` `childEnv`, `src/perf/pty.ts`
 * `baseEnv`, `test/pty/run-smoke.sh --hermetic`) and asserts that no `file:` source, no legacy warning and no key byte
 * appear — after a control run that proves the fake HOME *would* leak without the isolation. Needs the built bundle
 * (`npm run build`); skipped without it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseEnv } from '../../../src/perf/pty.js';
import { BIN, CHILD_ENV_UNSET, DIST, ROOT, childEnv } from '../../pty/helpers.js';

const FAKE = `sk-fake-${'q'.repeat(40)}`;
const haveBundle = existsSync(DIST) && existsSync(BIN);

function configOutput(env: Record<string, string | undefined>, cwd: string): string {
  const r = spawnSync(process.execPath, [BIN, 'config', '--workspace', cwd], { cwd, env, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

describe.skipIf(!haveBundle)('hermetic child environments (legacy credentials file in the parent HOME)', () => {
  let fakeHome = '';
  let ws = '';
  const savedHome = process.env['HOME'];
  const savedConfig = process.env['JEVCODE_CONFIG'];
  beforeAll(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'jevcode-hermetic-fakehome-'));
    ws = mkdtempSync(join(tmpdir(), 'jevcode-hermetic-ws-'));
    mkdirSync(join(fakeHome, '.config', 'jevcode'), { recursive: true });
    writeFileSync(join(fakeHome, '.config', 'jevcode', 'config.json'), JSON.stringify({ provider: 'openrouter', apiKey: FAKE, jevApiKey: FAKE }));
    // the parent's own environment is the developer's: a saved login in HOME and a JEVCODE_CONFIG pointing at it
    process.env['HOME'] = fakeHome;
    process.env['JEVCODE_CONFIG'] = join(fakeHome, '.config', 'jevcode', 'config.json');
  });
  afterAll(() => {
    if (savedHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = savedHome;
    if (savedConfig === undefined) delete process.env['JEVCODE_CONFIG'];
    else process.env['JEVCODE_CONFIG'] = savedConfig;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  });

  it('control: without the isolation the legacy file is read (`file:` source) — so the cases below are live', () => {
    const out = configOutput({ PATH: process.env['PATH'], HOME: fakeHome, TERM: 'dumb', OPEN_ASSIST_PATH: join(ws, 'none') }, ws);
    expect(out).toContain('file:');
  });

  it('test/pty/helpers.ts childEnv: HOME, XDG_CONFIG_HOME and JEVCODE_HOME isolated, JEVCODE_CONFIG and every key variable unset', () => {
    const home = mkdtempSync(join(tmpdir(), 'jevcode-hermetic-home-'));
    try {
      const env = childEnv(home, 24, 80);
      expect(env['HOME']).toBe(home);
      expect(env['XDG_CONFIG_HOME']).toBe(join(home, 'xdg'));
      expect(env['JEVCODE_HOME']).toBe(home);
      for (const k of ['JEVCODE_CONFIG', 'TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'JEV_API_KEY', 'ANTHROPIC_API_KEY', 'CI']) expect(env[k]).toBeUndefined();
      expect(CHILD_ENV_UNSET).toContain('JEVCODE_CONFIG');
      const out = configOutput(env, ws);
      expect(out).not.toContain('file:');
      expect(out).not.toContain('legacy');
      expect(out).not.toContain(FAKE);
      // the env reached the child: the runs dir is the isolated home's
      expect(out).toMatch(new RegExp(`runsDir\\s+${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/runs`));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('src/perf/pty.ts baseEnv: a minimal env with HOME and XDG_CONFIG_HOME inside the drive dir, no key variable, no JEVCODE_CONFIG', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcode-hermetic-drive-'));
    try {
      const env = baseEnv({ rows: 24, columns: 80, env: { JEVCODE_HOME: join(dir, 'home') } }, dir);
      expect(env['HOME']).toBe(dir);
      expect(env['XDG_CONFIG_HOME']).toBe(join(dir, 'xdg'));
      expect(env['OPEN_ASSIST_PATH']).toBe(join(dir, 'no-open-assist'));
      expect(Object.keys(env).sort()).toEqual(['HOME', 'JEVCODE_HOME', 'OPEN_ASSIST_PATH', 'PATH', 'PTY_COLS', 'PTY_ROWS', 'TERM', 'XDG_CONFIG_HOME']);
      const out = configOutput(env, ws);
      expect(out).not.toContain('file:');
      expect(out).not.toContain(FAKE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('test/pty/run-smoke.sh --hermetic: the smoke\'s own env construction passes its self-check (and its control reads the legacy file)', () => {
    const r = spawnSync('/bin/sh', [join(ROOT, 'test', 'pty', 'run-smoke.sh'), '--hermetic'], { cwd: ROOT, env: { ...process.env, HOME: fakeHome }, encoding: 'utf8', timeout: 120_000 });
    expect(r.stdout).toContain('hermetic: PASS');
    expect(r.stdout).toContain('no-file-source no-key-bytes no-legacy-warning control:legacy-file-read');
    expect(r.status).toBe(0);
  });
});
