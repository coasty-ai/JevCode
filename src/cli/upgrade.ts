/**
 * `jevcode upgrade [<version>|latest|next] [--check] [--method <m>] [--write-cache]` (TUI-DESIGN §17 items 5–6, D14):
 * delegates to the package manager detected from the install path — npx → nothing to upgrade; Homebrew; bun; pnpm;
 * yarn; else `npm install -g jevcode@<v>` (never `npm update -g`) — after printing the exact command it is about to
 * run (the dry-run line). `--check` asks the registry (2 s timeout) whether a newer version exists and, with
 * `--write-cache`, records the answer in `${XDG_CACHE_HOME:-~/.cache}/jevcode/update-check.json` for the post-run
 * notifier. Exit 0 ok / up to date · 2 usage · 5 registry unreachable · 6 the manager failed. Pure over injected
 * `fetch`, `spawn` and file writes.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ParsedFlags } from './args.js';
import { EXIT_CODES } from '../errors.js';
import { VERSION } from '../version.js';

export type PackageManager = 'npm' | 'brew' | 'bun' | 'pnpm' | 'yarn' | 'npx';
export const PACKAGE_MANAGERS: readonly PackageManager[] = ['npm', 'brew', 'bun', 'pnpm', 'yarn'];
export const PACKAGE_NAME = 'jevcode';
export const REGISTRY_URL = 'https://registry.npmjs.org/jevcode';
/** TUI-DESIGN §17 item 5: the registry timeout. */
export const REGISTRY_TIMEOUT_MS = 2000;
/** TUI-DESIGN §17 item 6: the notifier's cache is fresh for a day. */
export const CACHE_FRESH_MS = 24 * 60 * 60 * 1000;
/** exit 6: the manager itself failed */
export const EXIT_MANAGER_FAILED = 6;

/** TUI-DESIGN §17 item 5: the manager from `realpath(process.argv[1])` (and the env for npx). */
export function detectPackageManager(realArgv1: string, env: NodeJS.ProcessEnv): PackageManager {
  const p = realArgv1.replace(/\\/g, '/');
  if (/\/_npx\//.test(p) || env['npm_command'] === 'exec' || env['npm_config_user_agent']?.includes('npx') === true) return 'npx';
  if (/\/(Cellar|homebrew|linuxbrew)\//.test(p)) return 'brew';
  if (/\/\.bun\//.test(p)) return 'bun';
  if (/\/pnpm\//.test(p) || env['npm_config_user_agent']?.startsWith('pnpm') === true) return 'pnpm';
  if (/\/yarn\//.test(p) || /\/\.yarn\//.test(p) || env['npm_config_user_agent']?.startsWith('yarn') === true) return 'yarn';
  return 'npm';
}

/** the argv the manager runs for `<target>` (`latest` by default); null for npx */
export function upgradeArgv(manager: PackageManager, target: string): string[] | null {
  const spec = `${PACKAGE_NAME}@${target}`;
  switch (manager) {
    case 'npm':
      return ['npm', 'install', '-g', spec];
    case 'brew':
      return ['brew', 'upgrade', PACKAGE_NAME];
    case 'bun':
      return ['bun', 'install', '-g', spec];
    case 'pnpm':
      return ['pnpm', 'add', '-g', spec];
    case 'yarn':
      return ['yarn', 'global', 'add', spec];
    case 'npx':
      return null;
  }
}

/** `1.2.3` → [1, 2, 3]; pre-release tails compare lower than the release */
export function parseVersion(v: string): { parts: number[]; pre: string | null } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
  if (!m) return null;
  return { parts: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

/** negative when a < b, 0 equal, positive when a > b; null when either does not parse */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    const d = (pa.parts[i] ?? 0) - (pb.parts[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0;
}

export interface UpdateCheck {
  current: string;
  latest: string | null;
  /** the dist-tag asked for */
  tag: string;
  newer: boolean;
  checkedAt: string;
  error: string | null;
}

/** TUI-DESIGN §17 item 6: `${XDG_CACHE_HOME:-~/.cache}/jevcode/update-check.json`. */
export function updateCachePath(env: NodeJS.ProcessEnv, home: string): string {
  const xdg = env['XDG_CACHE_HOME']?.trim();
  return join(xdg !== undefined && xdg !== '' ? xdg : join(home, '.cache'), 'jevcode', 'update-check.json');
}

/** TUI-DESIGN §17 item 5: ask the registry for the dist-tag's version; 2 s timeout; never throws. */
export async function checkRegistry(tag: string, o: { fetch?: typeof fetch; timeoutMs?: number; now?: () => Date; current?: string } = {}): Promise<UpdateCheck> {
  const f = o.fetch ?? fetch;
  const current = o.current ?? VERSION;
  const checkedAt = (o.now?.() ?? new Date()).toISOString();
  try {
    const res = await f(`${REGISTRY_URL}/${encodeURIComponent(tag)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(o.timeoutMs ?? REGISTRY_TIMEOUT_MS) });
    if (!res.ok) return { current, latest: null, tag, newer: false, checkedAt, error: `registry HTTP ${res.status}` };
    const body = (await res.json()) as { version?: unknown };
    const latest = typeof body.version === 'string' ? body.version : null;
    if (latest === null) return { current, latest: null, tag, newer: false, checkedAt, error: 'registry answer has no version' };
    const cmp = compareVersions(current, latest);
    return { current, latest, tag, newer: cmp !== null && cmp < 0, checkedAt, error: null };
  } catch (e) {
    return { current, latest: null, tag, newer: false, checkedAt, error: `registry unreachable: ${(e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 120)}` };
  }
}

/** the outcome of the delegated manager (injectable) */
export interface SpawnOutcome {
  exitCode: number | null;
  error: string | null;
}
export type UpgradeSpawn = (argv: readonly string[]) => Promise<SpawnOutcome>;

export interface UpgradeIo {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  env: NodeJS.ProcessEnv;
  home: string;
  /** `realpath(process.argv[1])` */
  argv1: string;
  /** runs the manager with stdio inherited; default: node:child_process spawn */
  spawn?: UpgradeSpawn;
  fetch?: typeof fetch;
  now?: () => Date;
  writeFile?: (path: string, text: string) => Promise<void>;
  /** print the command only, never run it (tests, `JEVCODE_UPGRADE_DRY_RUN=1`) */
  dryRun?: boolean;
  current?: string;
}

const defaultSpawn: UpgradeSpawn = (argv) =>
  new Promise((resolve) => {
    const [file, ...args] = argv;
    if (file === undefined) {
      resolve({ exitCode: null, error: 'empty argv' });
      return;
    }
    import('node:child_process')
      .then(({ spawn }) => {
        const child = spawn(file, args, { stdio: 'inherit' });
        child.on('error', (e) => resolve({ exitCode: null, error: e.message }));
        child.on('exit', (code) => resolve({ exitCode: code, error: null }));
      })
      .catch((e: unknown) => resolve({ exitCode: null, error: e instanceof Error ? e.message : String(e) }));
  });

function isManager(s: string): s is PackageManager {
  return (PACKAGE_MANAGERS as readonly string[]).includes(s);
}

/** TUI-DESIGN §17 items 5–6: the `upgrade` command. */
export async function commandUpgrade(flags: ParsedFlags, io: UpgradeIo): Promise<number> {
  const target = flags.upgradeTarget ?? 'latest';
  const tag = target === 'latest' || target === 'next' ? target : 'latest';
  if (flags.check) {
    const check = await checkRegistry(tag, { ...(io.fetch ? { fetch: io.fetch } : {}), ...(io.now ? { now: io.now } : {}), ...(io.current !== undefined ? { current: io.current } : {}) });
    if (flags.writeCache) {
      const path = updateCachePath(io.env, io.home);
      try {
        const write = io.writeFile ?? (async (p: string, t: string): Promise<void> => {
          await mkdir(join(p, '..'), { recursive: true });
          await writeFile(p, t, 'utf8');
        });
        await write(path, `${JSON.stringify(check)}\n`);
      } catch (e) {
        io.stderr.write(`jevcode upgrade: could not write ${path}: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
    if (check.error !== null) {
      io.stderr.write(`jevcode upgrade: ${check.error}\n`);
      return EXIT_CODES.api;
    }
    io.stdout.write(check.newer ? `jevcode ${check.current} → ${check.latest} is available (${tag}); run jevcode upgrade\n` : `jevcode ${check.current} is up to date (${tag}: ${check.latest})\n`);
    return EXIT_CODES.ok;
  }
  let manager: PackageManager;
  if (flags.method !== undefined) {
    const m = flags.method.trim().toLowerCase();
    if (!isManager(m)) {
      io.stderr.write(`jevcode upgrade: --method expects ${PACKAGE_MANAGERS.join('|')}, got "${flags.method}"\n`);
      return EXIT_CODES.config;
    }
    manager = m;
  } else manager = detectPackageManager(io.argv1, io.env);
  const argv = upgradeArgv(manager, target);
  if (argv === null) {
    io.stdout.write(`jevcode runs through npx here (${io.argv1}); there is nothing installed to upgrade — npx fetches the requested version each time\n`);
    return EXIT_CODES.ok;
  }
  io.stdout.write(`upgrade via ${manager}: ${argv.join(' ')}\n`);
  if (io.dryRun === true || io.env['JEVCODE_UPGRADE_DRY_RUN'] === '1') return EXIT_CODES.ok;
  const r = await (io.spawn ?? defaultSpawn)(argv);
  if (r.error !== null) {
    io.stderr.write(`jevcode upgrade: ${manager} could not run: ${r.error}\n`);
    return EXIT_MANAGER_FAILED;
  }
  if (r.exitCode !== 0) {
    io.stderr.write(`jevcode upgrade: ${manager} exited ${r.exitCode ?? 'by signal'}\n`);
    return EXIT_MANAGER_FAILED;
  }
  return EXIT_CODES.ok;
}
