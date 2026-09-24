/**
 * `jevcode doctor [--json]` (round-5 finishing wave).
 *
 * Every case drives the real `commandDoctor` over an injected `DoctorIo`: no real filesystem, no real clock and —
 * the property that matters most for a command whose job is to probe providers — **no network**. `probe` is a
 * counted fake, so "a provider with no key is not probed at all" is asserted by the call list, not by hope.
 */
import { describe, expect, it } from 'vitest';
import { commandDoctor, doctorLines, doctorRows, keyEnvHit, nodeMajorOf, DOCTOR_PROBES, DOCTOR_PROBE_TIMEOUT_MS, type DoctorIo, type DoctorRow } from '../../../src/cli/doctor.js';
import { parseCliArgs } from '../../../src/cli/args.js';
import { fingerprint } from '../../../src/core/hash.js';
import { PROVIDER_IDS } from '../../../src/provider/ids.js';

const OR_KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const ANTHROPIC_KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123';

interface Probed {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

function io(over: Partial<DoctorIo> = {}): { io: DoctorIo; out: string[]; probes: Probed[] } {
  const out: string[] = [];
  const probes: Probed[] = [];
  const base: DoctorIo = {
    env: {},
    nodeVersion: '22.14.0',
    platform: 'darwin',
    stdout: { write: (s) => void out.push(s), isTTY: true, columns: 120 },
    stderr: { write: () => undefined },
    configFile: { path: '/h/.config/jevcode/config.json', exists: false, provider: null, apiKey: null, jevApiKey: null },
    runsDir: '/h/.jevcode/runs',
    mode: () => 0o600,
    writable: () => true,
    sandboxLevel: () => 'seatbelt',
    probe: async (url, headers, timeoutMs) => {
      probes.push({ url, headers, timeoutMs });
      return { status: 200 };
    },
  };
  return { io: { ...base, ...over }, out, probes };
}

const doctor = parseCliArgs(['doctor']);
const doctorJson = parseCliArgs(['doctor', '--json']);
const find = (rows: readonly DoctorRow[], id: string): DoctorRow => {
  const r = rows.find((x) => x.id === id);
  if (r === undefined) throw new Error(`no row ${id} in ${rows.map((x) => x.id).join(', ')}`);
  return r;
};

describe('jevcode doctor — the command surface', () => {
  it('`doctor` and `doctor --json` parse, and the command is in COMMANDS', () => {
    expect(doctor.command).toBe('doctor');
    expect(doctorJson.command).toBe('doctor');
    expect(doctorJson.json).toBe(true);
  });

  it('with NO keys at all it still runs, answers 0 (nothing FAILED), and names the variable to export for every provider', async () => {
    const t = io();
    expect(await commandDoctor(doctor, t.io)).toBe(0);
    const text = t.out.join('');
    for (const id of PROVIDER_IDS) expect(text, id).toContain(`key.${id}`);
    expect(text).toContain('export OPENROUTER_API_KEY=…');
    expect(text).toContain('export ANTHROPIC_API_KEY=…');
    expect(text).toContain('export GEMINI_API_KEY=…');
    // a missing key is a WARN, never a fail: it is the ordinary state of a provider you do not use
    expect(text).not.toContain('fail  key.');
    // and with no key nothing is probed — `doctor` never touches the network to tell you a key is absent
    expect(t.probes).toEqual([]);
    expect(text).toContain('openrouter: not probed (no key)');
  });

  it('every row carries a one-line fix, and the text form prints it under every non-pass row', async () => {
    const rows = await doctorRows(io().io);
    for (const r of rows) {
      expect(r.fix.trim(), r.id).not.toBe('');
      expect(r.fix.includes('\n'), r.id).toBe(false);
      expect(r.detail.includes('\n'), r.id).toBe(false);
    }
    const lines = doctorLines(rows);
    const warns = rows.filter((r) => r.status === 'warn').length;
    const fails = rows.filter((r) => r.status === 'fail').length;
    expect(lines.filter((l) => l.includes('fix: '))).toHaveLength(warns + fails);
    expect(lines.at(-1)).toBe(`${rows.length} checks: ${rows.length - warns - fails} pass, ${warns} warn, ${fails} fail`);
  });

  it('--json emits one object per row plus the verdict, and the text and JSON forms agree row for row', async () => {
    const t = io();
    expect(await commandDoctor(doctorJson, t.io)).toBe(0);
    const parsed = JSON.parse(t.out.join('')) as { ok: boolean; rows: DoctorRow[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.rows.length).toBeGreaterThan(10);
    for (const r of parsed.rows) expect(Object.keys(r).sort()).toEqual(['detail', 'fix', 'id', 'status']);
    expect(parsed.rows.map((r) => r.id)).toEqual((await doctorRows(io().io)).map((r) => r.id));
  });
});

describe('jevcode doctor — keys are shown as a fingerprint and never as bytes', () => {
  it('a key in the environment is a pass that names the variable and prints sha256:… — never the key', async () => {
    const t = io({ env: { OPENROUTER_API_KEY: OR_KEY, ANTHROPIC_API_KEY: ANTHROPIC_KEY } });
    const rows = await doctorRows(t.io);
    expect(find(rows, 'key.openrouter').status).toBe('pass');
    expect(find(rows, 'key.openrouter').detail).toBe(`openrouter: key in OPENROUTER_API_KEY (sha256:${fingerprint(OR_KEY)})`);
    expect(find(rows, 'key.anthropic').detail).toContain(`sha256:${fingerprint(ANTHROPIC_KEY)}`);
    // 0 key bytes, in the text form and in --json
    const t2 = io({ env: { OPENROUTER_API_KEY: OR_KEY, ANTHROPIC_API_KEY: ANTHROPIC_KEY } });
    await commandDoctor(doctor, t2.io);
    const t3 = io({ env: { OPENROUTER_API_KEY: OR_KEY, ANTHROPIC_API_KEY: ANTHROPIC_KEY } });
    await commandDoctor(doctorJson, t3.io);
    for (const text of [t2.out.join(''), t3.out.join('')]) {
      expect(text).not.toContain(OR_KEY);
      expect(text).not.toContain(ANTHROPIC_KEY);
      expect(text).not.toContain(OR_KEY.slice(0, 24));
    }
  });

  it('a key saved in the config file counts for the provider the FILE names, and says where it came from', async () => {
    const saved = io({ configFile: { path: '/h/.config/jevcode/config.json', exists: true, provider: 'anthropic', apiKey: ANTHROPIC_KEY, jevApiKey: null } });
    const rows = await doctorRows(saved.io);
    expect(find(rows, 'key.anthropic').status).toBe('pass');
    expect(find(rows, 'key.anthropic').detail).toContain('/h/.config/jevcode/config.json');
    // and it is NOT credited to a provider the file does not name
    expect(find(rows, 'key.openrouter').status).toBe('warn');
  });

  it('the Jev key reads TYPESAFE_API_KEY, then JEV_API_KEY, then the saved one', async () => {
    expect(find(await doctorRows(io({ env: { TYPESAFE_API_KEY: 'ts-0123456789abcdef' } }).io), 'key.jev').detail).toContain('TYPESAFE_API_KEY');
    expect(find(await doctorRows(io({ env: { JEV_API_KEY: OR_KEY } }).io), 'key.jev').detail).toContain('JEV_API_KEY');
    const file = io({ configFile: { path: '/h/c.json', exists: true, provider: null, apiKey: null, jevApiKey: OR_KEY } });
    expect(find(await doctorRows(file.io), 'key.jev').detail).toContain('/h/c.json');
    expect(find(await doctorRows(io().io), 'key.jev').status).toBe('warn');
  });

  it('`keyEnvHit` follows PROVIDER_KEY_ENV order, so the JevCode name wins over the vendor SDK one', () => {
    expect(keyEnvHit('gemini', { GEMINI_API_KEY: 'a-key-value', GOOGLE_API_KEY: 'b-key-value' })?.name).toBe('GEMINI_API_KEY');
    expect(keyEnvHit('gemini', { GOOGLE_API_KEY: 'b-key-value' })?.name).toBe('GOOGLE_API_KEY');
    expect(keyEnvHit('gemini', { GEMINI_API_KEY: '  ' })).toBeNull();
  });
});

describe('jevcode doctor — reachability is three free GETs with their own 3 s budget', () => {
  it('a keyed provider is probed at its FREE endpoint, with the timeout, and a 200 is a pass', async () => {
    const t = io({ env: { OPENROUTER_API_KEY: OR_KEY } });
    const rows = await doctorRows(t.io);
    expect(t.probes).toHaveLength(1);
    expect(t.probes[0]?.url).toBe(DOCTOR_PROBES.openrouter.url);
    expect(t.probes[0]?.url).toBe('https://openrouter.ai/api/v1/key');
    expect(t.probes[0]?.timeoutMs).toBe(DOCTOR_PROBE_TIMEOUT_MS);
    expect(DOCTOR_PROBE_TIMEOUT_MS).toBe(3_000);
    expect(find(rows, 'reach.openrouter').status).toBe('pass');
    expect(find(rows, 'reach.anthropic').status).toBe('warn');
    expect(find(rows, 'reach.typesafe').status).toBe('warn');
  });

  it('401 is a FAIL that names the login to run; 5xx is a warn that says it is the provider’s side', async () => {
    const rejected = io({ env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY }, probe: async () => ({ status: 401 }) });
    const rows = await doctorRows(rejected.io);
    expect(find(rows, 'reach.anthropic').status).toBe('fail');
    expect(find(rows, 'reach.anthropic').fix).toContain("jevcode login --provider anthropic");
    expect(await commandDoctor(doctor, io({ env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY }, probe: async () => ({ status: 401 }) }).io)).toBe(1);

    const down = io({ env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY }, probe: async () => ({ status: 503 }) });
    expect(find(await doctorRows(down.io), 'reach.anthropic').status).toBe('warn');
    expect(await commandDoctor(doctor, io({ env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY }, probe: async () => ({ status: 503 }) }).io)).toBe(0);
  });

  it('a probe that never completes is a fail whose detail is ONE clipped line, not a stack', async () => {
    const t = io({ env: { OPENROUTER_API_KEY: OR_KEY }, probe: async () => ({ error: 'The operation was aborted due to timeout' }) });
    const r = find(await doctorRows(t.io), 'reach.openrouter');
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('did not answer');
    expect(r.detail.includes('\n')).toBe(false);
  });
});

describe('jevcode doctor — the machine rows', () => {
  it('Node below 22 fails and the command exits 1; 22+ passes', async () => {
    expect(nodeMajorOf('v22.14.0')).toBe(22);
    expect(nodeMajorOf('20.11.1')).toBe(20);
    expect(nodeMajorOf('not-a-version')).toBeNull();
    const old = io({ nodeVersion: '20.11.1' });
    expect(find(await doctorRows(old.io), 'node').status).toBe('fail');
    expect(await commandDoctor(doctor, io({ nodeVersion: '20.11.1' }).io)).toBe(1);
    expect(find(await doctorRows(io().io), 'node').status).toBe('pass');
  });

  it('a config file wider than 0600, or a config dir wider than 0700, is a FAIL with the chmod to type', async () => {
    const wide = io({ configFile: { path: '/h/c.json', exists: true, provider: null, apiKey: null, jevApiKey: null }, mode: (p) => (p === '/h/c.json' ? 0o644 : 0o700) });
    const rows = await doctorRows(wide.io);
    expect(find(rows, 'config.file').status).toBe('fail');
    expect(find(rows, 'config.file').fix).toBe('chmod 600 /h/c.json');
    expect(find(rows, 'config.dir').status).toBe('pass');

    const wideDir = io({ configFile: { path: '/h/c.json', exists: true, provider: null, apiKey: null, jevApiKey: null }, mode: (p) => (p === '/h/c.json' ? 0o600 : 0o755) });
    expect(find(await doctorRows(wideDir.io), 'config.dir').fix).toBe('chmod 700 /h');
    // no file at all is a warn, not a fail — environment variables are a complete setup
    expect(find(await doctorRows(io().io), 'config.file').status).toBe('warn');
  });

  it('an unwritable runs dir is a fail; a missing sandbox-exec on darwin is a fail and elsewhere a warn', async () => {
    expect(find(await doctorRows(io({ writable: () => false }).io), 'runs').status).toBe('fail');
    expect(find(await doctorRows(io({ sandboxLevel: () => 'none' }).io), 'sandbox').status).toBe('fail');
    expect(find(await doctorRows(io({ platform: 'linux', sandboxLevel: () => 'none' }).io), 'sandbox').status).toBe('warn');
    expect(find(await doctorRows(io().io), 'sandbox').status).toBe('pass');
  });

  it('the terminal row reports TTY, columns and colour, and NO_COLOR is named as the cause', async () => {
    expect(find(await doctorRows(io().io), 'terminal').detail).toBe('TTY, 120 columns, colour on');
    expect(find(await doctorRows(io({ env: { NO_COLOR: '1' } }).io), 'terminal').detail).toContain('colour off (NO_COLOR)');
    const piped = io({ stdout: { write: () => undefined, isTTY: false } });
    expect(find(await doctorRows(piped.io), 'terminal').status).toBe('warn');
    expect(find(await doctorRows(piped.io), 'terminal').fix).toContain('--plain');
    const narrow = io({ stdout: { write: () => undefined, isTTY: true, columns: 30 } });
    expect(find(await doctorRows(narrow.io), 'terminal').status).toBe('warn');
  });

  it('the version row is always present and names this build', async () => {
    const { VERSION } = await import('../../../src/version.js');
    expect(find(await doctorRows(io().io), 'version').detail).toBe(`jevcode ${VERSION}`);
  });
});

describe("the pytest row (0.6.0 joint drive: a --user pytest vanished under the sandbox's remapped HOME)", () => {
  it('pass with the version when the probe imports it; warn naming the fix when python3 is missing or pytest is not importable; warn when the build has no probe', async () => {
    const ok = io({ pytestProbe: async () => ({ ok: true, version: '8.3.4' }) });
    expect((await doctorRows(ok.io)).find((r) => r.id === 'pytest')).toMatchObject({ status: 'pass' });
    const missing = io({ pytestProbe: async () => ({ ok: false, reason: 'no-python3', detail: 'python3 was not found on PATH' }) });
    const m = (await doctorRows(missing.io)).find((r) => r.id === 'pytest');
    expect(m?.status).toBe('warn');
    expect(m?.fix).toContain('install Python 3');
    const notImportable = io({ pytestProbe: async () => ({ ok: false, reason: 'not-importable', detail: "No module named 'pytest'" }) });
    const n = (await doctorRows(notImportable.io)).find((r) => r.id === 'pytest');
    expect(n?.status).toBe('warn');
    expect(n?.fix).toContain('pip install --user pytest');
    expect(n?.detail).not.toContain('/Users/');
    const none = (await doctorRows(io().io)).find((r) => r.id === 'pytest');
    expect(none?.status).toBe('warn');
  });
});
