/**
 * `jevcode doctor [--json]` — the one command that answers "is this machine set up, and if not, what do I type?".
 *
 * Every check is a `DoctorRow`: a status (`pass` / `warn` / `fail`), one line of detail, and ONE line of fix. The
 * fix is not optional and not a paragraph: a row that cannot say what to type is a row that wastes the reader's
 * time. `warn` never fails the command — a missing provider key is a fact about this machine, not a defect — so
 * the exit code is 0 unless something is actually broken (`fail`), and 1 when it is.
 *
 * Three rules this file keeps, each load-bearing:
 *
 *  - **No secret is ever printed.** A key that is present is shown as the wizard's own fingerprint form
 *    (`sha256:` + the first 8 hex characters, `src/core/hash.ts`), which is enough to tell two keys apart and
 *    useless to anyone who reads the terminal over your shoulder. The value, its length and its prefix stay here.
 *  - **The network probes are FREE GETs only.** `openrouter.ai/api/v1/key`, `api.anthropic.com/v1/models` and
 *    TypeSafe's health path bill nothing and generate nothing; `doctor` must never be a command a user is afraid
 *    to run. Each has its own 3 s timeout, and a provider with no key is not probed at all (`warn`, with the fix).
 *  - **Nothing from `src/provider/registry.ts` or `src/models/**` is imported**, here or transitively. Those load
 *    seven HTTP adapters and the model catalogue to read a handful of strings. `src/provider/ids.ts` is the
 *    zero-import table this file reads instead, and `src/cli/main.tsx` reaches this module through an
 *    `await import()` so none of it is on the argv / first-frame path either (gate G-R5-1).
 *
 * Everything the checks touch — the environment, the clock, the filesystem and `fetch` — arrives through
 * `DoctorIo`, so `test/unit/cli/doctor.test.ts` runs the whole command with no real machine and no network.
 */
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import type { ParsedFlags } from './args.js';
import { EXIT_CODES } from '../errors.js';
import { fingerprint } from '../core/hash.js';
import { PROVIDER_IDS, PROVIDER_KEY_ENV, type ProviderId } from '../provider/ids.js';
import { VERSION } from '../version.js';

/** `pass` is fine, `warn` is a fact the user may want to act on, `fail` is broken and sets the exit code. */
export type DoctorStatus = 'pass' | 'warn' | 'fail';

/** One check. `id` is stable and machine-readable; `detail` and `fix` are one line each, never a paragraph. */
export interface DoctorRow {
  readonly id: string;
  readonly status: DoctorStatus;
  readonly detail: string;
  readonly fix: string;
}

/** The three free reachability probes. A provider absent from this table simply has no `reach.*` row. */
export const DOCTOR_PROBES: Readonly<Record<'openrouter' | 'anthropic' | 'typesafe', { url: string; header: (key: string) => Record<string, string> }>> = {
  openrouter: { url: 'https://openrouter.ai/api/v1/key', header: (k) => ({ Authorization: `Bearer ${k}` }) },
  anthropic: { url: 'https://api.anthropic.com/v1/models', header: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }) },
  typesafe: { url: 'https://api.typesafe.ai/v1/systemone/health', header: (k) => ({ Authorization: `Bearer ${k}` }) },
};

/** Each probe gets its own budget: a provider that hangs must not hold the whole command. */
export const DOCTOR_PROBE_TIMEOUT_MS = 3_000;

/** The minimum Node the package supports (`engines.node` in package.json). */
export const DOCTOR_MIN_NODE_MAJOR = 22;

/** Where a key was found. `none` is not a failure — it is the ordinary state of a provider you do not use. */
export type KeySource = 'env' | 'file' | 'none';

/** The machine, as one injectable seam: no ambient `process`, `fs`, `fetch` or clock below this line. */
export interface DoctorIo {
  readonly env: NodeJS.ProcessEnv;
  /** `process.versions.node` */
  readonly nodeVersion: string;
  readonly platform: NodeJS.Platform;
  readonly stdout: { write(s: string): void; isTTY?: boolean; columns?: number };
  readonly stderr: { write(s: string): void };
  /** the resolved config file path, whether it exists, and the keys saved in it (values, never printed) */
  readonly configFile: { path: string; exists: boolean; provider: string | null; apiKey: string | null; jevApiKey: string | null };
  readonly runsDir: string;
  /** `st_mode & 0o777`, or `null` when the path does not exist or cannot be stat'ed */
  mode(path: string): number | null;
  /** can this process create files under `path`? (`W_OK` on the nearest existing ancestor) */
  writable(path: string): boolean;
  /** `sandbox-exec` availability for the `auto` profile, from `src/sandbox/seatbelt.ts`'s own detector */
  sandboxLevel(): 'seatbelt' | 'none';
  /** one free GET; resolves to the HTTP status, or a one-line cause when it never completed */
  probe(url: string, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number } | { error: string }>;
}

function row(id: string, status: DoctorStatus, detail: string, fix: string): DoctorRow {
  return { id, status, detail, fix };
}

/** the wizard's fingerprint form — the ONLY form in which a key is ever shown (§3) */
function shown(key: string): string {
  return `sha256:${fingerprint(key.trim())}`;
}

/** `v22.14.0` / `22.14.0` → 22; `null` when the string is not a version at all. */
export function nodeMajorOf(version: string): number | null {
  const m = /^v?(\d+)\./.exec(version.trim());
  const n = m?.[1] === undefined ? Number.NaN : Number(m[1]);
  return Number.isInteger(n) ? n : null;
}

/** Which variable (if any) holds this provider's key, in `PROVIDER_KEY_ENV`'s own lookup order. */
export function keyEnvHit(id: ProviderId, env: NodeJS.ProcessEnv): { name: string; value: string } | null {
  for (const name of PROVIDER_KEY_ENV[id]) {
    const v = env[name];
    if (typeof v === 'string' && v.trim() !== '') return { name, value: v };
  }
  return null;
}

/**
 * The generator-key row for one provider. A saved `apiKey` in the config file counts only for the provider the
 * file names, which `doctor` cannot know without resolving the whole chain; rather than guess, a file key is
 * reported against the provider whose variable is otherwise empty ONLY when the file also names that provider.
 */
function providerKeyRow(id: ProviderId, io: DoctorIo, fileProvider: string | null): DoctorRow {
  const hit = keyEnvHit(id, io.env);
  if (hit !== null) return row(`key.${id}`, 'pass', `${id}: key in ${hit.name} (${shown(hit.value)})`, `unset ${hit.name} to stop using it`);
  const fileKey = io.configFile.apiKey;
  if (fileKey !== null && fileKey.trim() !== '' && fileProvider === id) {
    return row(`key.${id}`, 'pass', `${id}: key in ${io.configFile.path} (${shown(fileKey)})`, `run 'jevcode logout --generator' to remove it`);
  }
  return row(`key.${id}`, 'warn', `${id}: no key`, `export ${PROVIDER_KEY_ENV[id][0]}=… or run 'jevcode login --provider ${id}'`);
}

/** the decider (Jev) key: TypeSafe's own variable first, then the OpenRouter route's, then the saved one */
function jevKeyRow(io: DoctorIo): DoctorRow {
  for (const name of ['TYPESAFE_API_KEY', 'JEV_API_KEY'] as const) {
    const v = io.env[name];
    if (typeof v === 'string' && v.trim() !== '') return row('key.jev', 'pass', `jev: key in ${name} (${shown(v)})`, `unset ${name} to stop using it`);
  }
  const saved = io.configFile.jevApiKey;
  if (saved !== null && saved.trim() !== '') return row('key.jev', 'pass', `jev: key in ${io.configFile.path} (${shown(saved)})`, `run 'jevcode logout --jev' to remove it`);
  return row('key.jev', 'warn', 'jev: no key', `export TYPESAFE_API_KEY=… or run 'jevcode login'`);
}

/** the key a probe should use, or `null` when the provider has none and the probe must be skipped */
function probeKeyFor(target: 'openrouter' | 'anthropic' | 'typesafe', io: DoctorIo): string | null {
  if (target === 'typesafe') {
    const v = io.env['TYPESAFE_API_KEY'];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
    return io.configFile.jevApiKey?.trim() ?? null;
  }
  return keyEnvHit(target, io.env)?.value.trim() ?? null;
}

async function reachRow(target: 'openrouter' | 'anthropic' | 'typesafe', io: DoctorIo): Promise<DoctorRow> {
  const spec = DOCTOR_PROBES[target];
  const key = probeKeyFor(target, io);
  if (key === null || key === '') return row(`reach.${target}`, 'warn', `${target}: not probed (no key)`, `set the key first — 'jevcode doctor' probes a provider only when it can authenticate`);
  const r = await io.probe(spec.url, spec.header(key), DOCTOR_PROBE_TIMEOUT_MS);
  if ('error' in r) return row(`reach.${target}`, 'fail', `${target}: ${spec.url} did not answer (${r.error})`, `check your network or proxy, then re-run 'jevcode doctor'`);
  if (r.status === 401 || r.status === 403) return row(`reach.${target}`, 'fail', `${target}: reachable, key REJECTED (HTTP ${r.status})`, `run 'jevcode login --provider ${target === 'typesafe' ? 'openrouter' : target}' with a valid key`);
  if (r.status >= 500) return row(`reach.${target}`, 'warn', `${target}: reachable, HTTP ${r.status} (their side)`, `retry later — this is the provider's outage, not your configuration`);
  if (r.status >= 400) return row(`reach.${target}`, 'warn', `${target}: reachable, HTTP ${r.status}`, `the probe endpoint answered oddly; a run may still work`);
  return row(`reach.${target}`, 'pass', `${target}: reachable, key accepted (HTTP ${r.status})`, `nothing to do`);
}

/** 0o600 on the file and 0o700 on its directory: anything wider and another local account can read the key. */
function configModeRows(io: DoctorIo): DoctorRow[] {
  if (!io.configFile.exists) {
    return [row('config.file', 'warn', `no config file at ${io.configFile.path}`, `run 'jevcode login' to create one, or keep using environment variables`)];
  }
  const out: DoctorRow[] = [];
  const fileMode = io.mode(io.configFile.path);
  if (fileMode === null) out.push(row('config.file', 'fail', `${io.configFile.path} cannot be read`, `check the path's permissions, or point JEVCODE_CONFIG somewhere readable`));
  else if ((fileMode & 0o077) !== 0) out.push(row('config.file', 'fail', `${io.configFile.path} is mode 0${fileMode.toString(8)} — other local accounts can read your keys`, `chmod 600 ${io.configFile.path}`));
  else out.push(row('config.file', 'pass', `${io.configFile.path} is mode 0${fileMode.toString(8)}`, `nothing to do`));

  const dir = dirname(io.configFile.path);
  const dirMode = io.mode(dir);
  if (dirMode === null) out.push(row('config.dir', 'warn', `${dir} cannot be stat'ed`, `check the directory exists and is yours`));
  else if ((dirMode & 0o077) !== 0) out.push(row('config.dir', 'fail', `${dir} is mode 0${dirMode.toString(8)} — it should be 0700`, `chmod 700 ${dir}`));
  else out.push(row('config.dir', 'pass', `${dir} is mode 0${dirMode.toString(8)}`, `nothing to do`));
  return out;
}

function terminalRow(io: DoctorIo): DoctorRow {
  const tty = io.stdout.isTTY === true;
  const cols = typeof io.stdout.columns === 'number' && io.stdout.columns > 0 ? io.stdout.columns : null;
  const noColor = typeof io.env['NO_COLOR'] === 'string' && io.env['NO_COLOR'] !== '';
  const colour = noColor ? 'off (NO_COLOR)' : tty ? 'on' : 'off (not a terminal)';
  const detail = `${tty ? 'TTY' : 'not a TTY'}, ${cols === null ? 'width unknown' : `${cols} columns`}, colour ${colour}`;
  if (!tty) return row('terminal', 'warn', detail, `the TUI needs a terminal; on a pipe jevcode uses --plain, which is the same session in lines`);
  if (cols !== null && cols < 40) return row('terminal', 'warn', detail, `widen the window to at least 40 columns — below that the status line drops cells`);
  return row('terminal', 'pass', detail, `nothing to do`);
}

/** Every check, in print order. Pure but for `io`; `commandDoctor` only formats what this returns. */
export async function doctorRows(io: DoctorIo): Promise<DoctorRow[]> {
  const rows: DoctorRow[] = [];

  rows.push(row('version', 'pass', `jevcode ${VERSION}`, `run 'jevcode upgrade' to move to the latest release`));

  const major = nodeMajorOf(io.nodeVersion);
  if (major === null) rows.push(row('node', 'warn', `Node version "${io.nodeVersion}" is not recognisable`, `install Node ${DOCTOR_MIN_NODE_MAJOR} or newer from nodejs.org`));
  else if (major < DOCTOR_MIN_NODE_MAJOR) rows.push(row('node', 'fail', `Node ${io.nodeVersion} — jevcode needs ${DOCTOR_MIN_NODE_MAJOR} or newer`, `install Node ${DOCTOR_MIN_NODE_MAJOR} or newer from nodejs.org`));
  else rows.push(row('node', 'pass', `Node ${io.nodeVersion}`, `nothing to do`));

  for (const id of PROVIDER_IDS) rows.push(providerKeyRow(id, io, io.configFile.provider));
  rows.push(jevKeyRow(io));

  for (const target of ['openrouter', 'anthropic', 'typesafe'] as const) rows.push(await reachRow(target, io));

  const level = io.sandboxLevel();
  if (level === 'seatbelt') rows.push(row('sandbox', 'pass', `sandbox-exec available — commands run under a seatbelt profile`, `nothing to do`));
  else if (io.platform === 'darwin') rows.push(row('sandbox', 'fail', `sandbox-exec is missing on this macOS install — commands would run unsandboxed`, `reinstall the macOS command line tools, or pass --sandbox none to accept it deliberately`));
  else rows.push(row('sandbox', 'warn', `no sandbox on ${io.platform} — commands run unsandboxed`, `run jevcode inside a container if the workspace is not yours`));

  rows.push(...configModeRows(io));

  if (io.writable(io.runsDir)) rows.push(row('runs', 'pass', `${io.runsDir} is writable`, `nothing to do`));
  else rows.push(row('runs', 'fail', `${io.runsDir} is not writable — no run can be recorded or resumed`, `fix the directory's permissions, or set JEVCODE_HOME / --runs-dir somewhere you can write`));

  rows.push(terminalRow(io));
  return rows;
}

/** the printed form: one line per row, plus the fix indented under every row that is not a `pass` */
export function doctorLines(rows: readonly DoctorRow[]): string[] {
  const width = Math.max(0, ...rows.map((r) => r.id.length));
  const out: string[] = [];
  for (const r of rows) {
    out.push(`${r.status}  ${r.id.padEnd(width)}  ${r.detail}`);
    if (r.status !== 'pass') out.push(`      ${' '.repeat(width)}  fix: ${r.fix}`);
  }
  const fails = rows.filter((r) => r.status === 'fail').length;
  const warns = rows.filter((r) => r.status === 'warn').length;
  out.push('', `${rows.length} checks: ${rows.length - fails - warns} pass, ${warns} warn, ${fails} fail`);
  return out;
}

/** `jevcode doctor [--json]`: 0 when nothing failed, 1 when something did. A warn never sets the code. */
export async function commandDoctor(flags: ParsedFlags, io: DoctorIo): Promise<number> {
  const rows = await doctorRows(io);
  const ok = rows.every((r) => r.status !== 'fail');
  if (flags.json === true) io.stdout.write(`${JSON.stringify({ ok, rows }, null, 2)}\n`);
  else io.stdout.write(`${doctorLines(rows).join('\n')}\n`);
  return ok ? EXIT_CODES.ok : 1;
}

/** the real machine behind `DoctorIo`; every member is one call, so the seam above stays the only logic. */
export async function defaultDoctorIo(flags: ParsedFlags): Promise<DoctorIo> {
  const { resolveConfig } = await import('../config/resolve.js');
  const { credentialsPath, readCredentialsFile } = await import('../config/credentials.js');
  const { detectSandboxLevel } = await import('../sandbox/seatbelt.js');
  const config = await resolveConfig(flags, process.env, process.cwd());
  const target = credentialsPath({ env: process.env, home: homedir(), cwd: process.cwd(), ...(flags.config !== undefined ? { configFlag: flags.config } : {}) });
  const creds = await readCredentialsFile(target.path);
  return {
    env: process.env,
    nodeVersion: process.versions.node,
    platform: process.platform,
    stdout: process.stdout,
    stderr: process.stderr,
    configFile: { path: target.path, exists: creds.exists, provider: creds.provider, apiKey: creds.apiKey, jevApiKey: creds.jevApiKey },
    runsDir: config.runsDir,
    mode: (path) => {
      try {
        return statSync(path).mode & 0o777;
      } catch {
        return null;
      }
    },
    writable: (path) => {
      // the nearest EXISTING ancestor is what decides whether a run directory can be created
      let dir = path;
      for (let i = 0; i < 64; i++) {
        try {
          accessSync(dir, fsConstants.W_OK);
          return true;
        } catch {
          const up = dirname(dir);
          if (up === dir) return false;
          dir = up;
        }
      }
      return false;
    },
    sandboxLevel: () => detectSandboxLevel(config.sandbox === 'none' ? 'auto' : config.sandbox, process.platform),
    probe: async (url, headers, timeoutMs) => {
      try {
        const res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) });
        return { status: res.status };
      } catch (e) {
        const text = e instanceof Error ? e.message : String(e);
        return { error: text.length > 60 ? `${text.slice(0, 59)}…` : text };
      }
    },
  };
}
