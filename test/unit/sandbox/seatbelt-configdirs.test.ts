/**
 * TUI-DESIGN §19.0 (`sandbox` row) / §12.7: `ProfileOptions.configDirs` — `(subpath "/tmp/x/jevcode")` under
 * `XDG_CONFIG_HOME=/tmp/x` (canonicalised), appended to the `file-read*` denies after the home rules, deduplicated
 * against `~/.config/jevcode`, and a no-op when absent; on darwin the key file is really unreadable.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { canonicalPathSync } from '../../../src/sandbox/paths.js';
import { createSandbox } from '../../../src/sandbox/run.js';
import { buildProfile, sbplString } from '../../../src/sandbox/seatbelt.js';
import type { ProfileOptions } from '../../../src/sandbox/seatbelt.js';
import { FAST_KILL, makeTemp, never } from './helpers.js';

const darwin = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');

let cleanups: Array<() => void> = [];
function temp(): string {
  const t = makeTemp('jev-sbc-');
  cleanups.push(t.cleanup);
  return t.dir;
}
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function fixture(dir: string): { base: ProfileOptions; home: string } {
  const ws = join(dir, 'ws');
  mkdirSync(ws, { recursive: true });
  mkdirSync(join(dir, 'run', 'tmp'), { recursive: true });
  mkdirSync(join(dir, 'run', 'home'), { recursive: true });
  const home = join(dir, 'home');
  mkdirSync(home);
  return { home, base: { ws, runTmp: join(dir, 'run', 'tmp'), runHome: join(dir, 'run', 'home'), ttyPath: null, readDenies: [join(dir, 'pkg', '.env')], noNetwork: false, home } };
}

function readDenyLine(profile: string): string {
  return profile.split('\n').find((l) => l.startsWith('(deny file-read* '))!;
}

describe('buildProfile configDirs (§12.7)', () => {
  it('XDG_CONFIG_HOME=/tmp/x → (literal + subpath "<canonical /tmp/x/jevcode>") appended after the home rules', () => {
    const { base, home } = fixture(temp());
    const xdg = '/tmp/x/jevcode';
    const canon = canonicalPathSync(xdg);
    const p = buildProfile({ ...base, configDirs: [xdg] });
    const line = readDenyLine(p);
    expect(line).toContain(`(subpath ${sbplString(canon)})`);
    expect(line).toContain(`(literal ${sbplString(canon)})`);
    // appended: after the dotenv deny and the home rules
    expect(line.indexOf(sbplString(canon))).toBeGreaterThan(line.indexOf(sbplString(join(home, '.netrc'))));
    expect(line.indexOf(sbplString(canon))).toBeGreaterThan(line.indexOf(sbplString(join(base.readDenies[0]!))));
    expect(line.endsWith(`(literal ${sbplString(canon)}) (subpath ${sbplString(canon)}))`)).toBe(true);
    // the `/tmp` → `/private/tmp` canonicalisation happened on macOS (subpath matches kernel paths only)
    if (process.platform === 'darwin') expect(canon.startsWith('/private/')).toBe(true);
  });

  it('without configDirs the profile is byte-identical; empty strings are ignored; the legacy ~/.config/jevcode entry is deduplicated', () => {
    const { base, home } = fixture(temp());
    const plain = buildProfile(base);
    expect(buildProfile({ ...base, configDirs: [] })).toBe(plain);
    expect(buildProfile({ ...base, configDirs: ['', 7 as unknown as string] })).toBe(plain);
    const legacy = join(home, '.config', 'jevcode');
    const withLegacy = buildProfile({ ...base, configDirs: [legacy] });
    // the subpath rule already existed from HOME_SECRET_SUBPATHS; only the literal is new
    expect(withLegacy.split(`(subpath ${sbplString(canonicalPathSync(legacy))})`).length - 1).toBe(1);
    expect(withLegacy).toContain(`(literal ${sbplString(canonicalPathSync(legacy))})`);
    const twice = buildProfile({ ...base, configDirs: ['/tmp/x/jevcode', '/tmp/x/jevcode'] });
    expect(twice.split(sbplString(canonicalPathSync('/tmp/x/jevcode'))).length - 1).toBe(2);
    // nothing else moved: only the file-read* deny line differs from the plain profile
    const a = plain.split('\n');
    const b = buildProfile({ ...base, configDirs: ['/tmp/x/jevcode'] }).split('\n');
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) if (!a[i]!.startsWith('(deny file-read* ')) expect(b[i]).toBe(a[i]);
  });

  it('a not-yet-existing config dir gets both rules so a later mkdir cannot slip through', () => {
    const dir = temp();
    const { base } = fixture(dir);
    const future = join(dir, 'not-yet', 'jevcode');
    const p = buildProfile({ ...base, configDirs: [future] });
    expect(readDenyLine(p)).toContain(`(literal ${sbplString(future)}) (subpath ${sbplString(future)})`);
  });
});

describe.skipIf(!darwin)('createSandbox configDirs under sandbox-exec (darwin)', () => {
  it('the key file under XDG_CONFIG_HOME/jevcode is unreadable; a sibling outside it stays readable', async () => {
    const dir = temp();
    const ws = join(dir, 'ws');
    mkdirSync(ws);
    const xdg = join(dir, 'xdg');
    const cfg = join(xdg, 'jevcode');
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, 'credentials.json'), '{"generator":{"apiKey":"sk-ant-notreal-configdirs"}}\n');
    writeFileSync(join(xdg, 'other.txt'), 'readable\n');
    const sb = createSandbox({ workspaceRoot: ws, runDir: join(dir, 'run'), profile: 'auto', noNetwork: false, secretReadDenies: [], redact: (s) => s, configDirs: [cfg] }, FAST_KILL);
    expect(sb.level).toBe('seatbelt');
    const r = await sb.run(`cat "${cfg}/credentials.json" 2>&1; echo key=$?; cat "${xdg}/other.txt" 2>&1; echo other=$?; ls "${cfg}" 2>&1; echo ls=$?`, { timeoutMs: 15_000, maxOutputBytes: 50_000, signal: never() });
    expect(r.stdout).not.toContain('notreal');
    expect(r.stdout).toMatch(/Operation not permitted/);
    expect(r.stdout).toMatch(/key=1/);
    expect(r.stdout).toMatch(/readable\nother=0/);
    expect(r.stdout).toMatch(/ls=[1-9]/);
    // the same command without the option can read the key: the deny is the option's doing
    const plain = createSandbox({ workspaceRoot: ws, runDir: join(dir, 'run-plain'), profile: 'auto', noNetwork: false, secretReadDenies: [], redact: (s) => s }, FAST_KILL);
    const leak = await plain.run(`cat "${cfg}/credentials.json"; echo key=$?`, { timeoutMs: 15_000, maxOutputBytes: 50_000, signal: never() });
    expect(leak.stdout).toContain('notreal');
  });
});
