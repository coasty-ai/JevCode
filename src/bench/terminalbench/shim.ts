/**
 * Terminal-Bench local shim, design A of bench/data/terminal-bench/README.md (DESIGN.md §13):
 * boundary-aware rewriting of container paths, Dockerfile COPY/RUN replay, PATH shims for
 * setpriv/uv/apt-get, and the shared verifier venv. Nothing here knows about the engine.
 */
import { chmod, cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import { ConfigError, SandboxError } from '../../errors.js';
import type { CommandRunner } from '../types.js';

export type PathMap = Record<string, string>;

/** Files whose string literals are rewritten; tests/Dockerfile and data files are never touched. */
export const REWRITE_EXTENSIONS: readonly string[] = ['.sh', '.py', '.mjs', '.mts', '.ts', '.tsx'];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `(?<![\w./-])/app(?=[/"'\s:)]|$)`: preceded by nothing path-like (so `/apple`, `./app`,
 * `foo/app` and `x-/app` stay), followed by a separator, quote, whitespace, `:`/`)` or the
 * line end. A few extra closers (backtick, comma, `;`, `]`, `}`) are accepted so markdown
 * and shell lists rewrite completely; none of them can start a longer path.
 */
export function boundaryPattern(containerPath: string): RegExp {
  return new RegExp(`(?<![\\w./-])${escapeRe(containerPath)}(?=[/"'\\s:)\`,;\\]}]|$)`, 'gm');
}

/** Rewrite every mapped prefix, longest first so `/logs/verifier` wins over `/logs`. */
export function rewritePaths(text: string, map: PathMap): string {
  const keys = Object.keys(map).sort((a, b) => b.length - a.length || a.localeCompare(b));
  let out = text;
  for (const key of keys) out = out.replace(boundaryPattern(key), () => map[key]!);
  return out;
}

/** Map one absolute container path to its local stand-in (null when no prefix matches). */
export function mapContainerPath(p: string, map: PathMap): string | null {
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (p === key) return map[key]!;
    if (p.startsWith(`${key}/`)) return join(map[key]!, p.slice(key.length + 1));
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Dockerfile parsing (COPY / RUN / WORKDIR / ENV), continuation lines joined, comments dropped
// ---------------------------------------------------------------------------------------

export interface DockerInstruction {
  cmd: string;
  args: string;
}

export function parseDockerfile(text: string): DockerInstruction[] {
  const out: DockerInstruction[] = [];
  const lines = text.split('\n');
  let buf: string | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (buf === null && /^\s*(#|$)/.test(line)) continue;
    // comment lines inside a continuation are dropped by Docker too
    if (buf !== null && /^\s*#/.test(line)) continue;
    const cont = /\\\s*$/.test(line);
    const body = cont ? line.replace(/\\\s*$/, '') : line;
    buf = buf === null ? body : `${buf}\n${body}`;
    if (cont) continue;
    const m = /^\s*([A-Za-z]+)\s*([\s\S]*)$/.exec(buf);
    buf = null;
    if (!m) continue;
    out.push({ cmd: m[1]!.toUpperCase(), args: m[2]!.trim() });
  }
  if (buf !== null) {
    const m = /^\s*([A-Za-z]+)\s*([\s\S]*)$/.exec(buf);
    if (m) out.push({ cmd: m[1]!.toUpperCase(), args: m[2]!.trim() });
  }
  return out;
}

export interface CopySpec {
  sources: string[];
  dest: string;
}

/** COPY args: flags (--chown, --from) dropped, JSON form accepted; `--from=` stages are skipped (null). */
export function parseCopyArgs(args: string): CopySpec | null {
  let rest = args.trim();
  while (rest.startsWith('--')) {
    const m = /^--[a-z-]+(=\S*)?\s*/.exec(rest);
    if (!m) break;
    if (m[0].startsWith('--from')) return null;
    rest = rest.slice(m[0].length);
  }
  let parts: string[];
  if (rest.startsWith('[')) {
    try {
      const arr = JSON.parse(rest) as unknown;
      if (!Array.isArray(arr) || !arr.every((x) => typeof x === 'string')) return null;
      parts = arr as string[];
    } catch {
      return null;
    }
  } else parts = rest.split(/\s+/).filter((s) => s !== '');
  if (parts.length < 2) return null;
  return { sources: parts.slice(0, -1), dest: parts.at(-1)! };
}

/** `RUN` steps that install system or Python packages are replayed by the venv/shims instead. */
export function isInstallStep(cmd: string): boolean {
  const c = cmd.trim();
  return /(^|&&|;|\|\|)\s*(apt-get|apt|apk|dnf|yum|micromamba|mamba|conda|pip3?\s+install|python3?\s+-m\s+pip\s+install|uv\s+(pip|tool)\s+install|curl\s|wget\s)/.test(c);
}

async function pathKind(p: string): Promise<'dir' | 'file' | null> {
  try {
    const s = await stat(p);
    return s.isDirectory() ? 'dir' : 'file';
  } catch {
    return null;
  }
}

/** Minimal glob for a single path component (`package*.json`). */
async function expandSource(contextDir: string, src: string): Promise<string[]> {
  if (!src.includes('*')) return [join(contextDir, src)];
  const dir = join(contextDir, dirname(src));
  const re = new RegExp(`^${basename(src).split('*').map(escapeRe).join('.*')}$`);
  const names = await readdir(dir).catch((): string[] => []);
  return names.filter((n) => re.test(n)).map((n) => join(dir, n));
}

function assertInside(root: string, p: string): void {
  const rel = relative(resolve(root), resolve(p));
  if (rel.startsWith('..') || rel.split(sep).includes('..')) throw new ConfigError(`path ${p} escapes ${root}`);
}

/**
 * Docker COPY semantics onto a local root: a directory source copies its contents into dest,
 * a file source lands at dest (or dest/<name> when dest is a directory / ends with `/` / there
 * are several sources).
 */
export async function replayCopy(spec: CopySpec, contextDir: string, destLocal: string, destIsDir: boolean): Promise<void> {
  assertInside(contextDir, contextDir);
  const sources = (await Promise.all(spec.sources.map((s) => expandSource(contextDir, s)))).flat();
  const many = sources.length > 1 || destIsDir;
  for (const src of sources) {
    assertInside(contextDir, src);
    const kind = await pathKind(src);
    if (kind === null) throw new ConfigError(`COPY source ${relative(contextDir, src)} does not exist`);
    if (kind === 'dir') {
      await mkdir(destLocal, { recursive: true });
      await cp(src, destLocal, { recursive: true, force: true });
    } else if (many || (await pathKind(destLocal)) === 'dir') {
      await mkdir(destLocal, { recursive: true });
      await cp(src, join(destLocal, basename(src)), { force: true });
    } else {
      await mkdir(dirname(destLocal), { recursive: true });
      await cp(src, destLocal, { force: true });
    }
  }
}

/** Resolve a COPY dest against WORKDIR, then map it locally; unmapped roots are staged under `fallbackRoot`. */
export function resolveDest(dest: string, workdir: string, map: PathMap, fallbackRoot: string): { local: string; container: string } {
  // normalised so `/app/../x` cannot be mapped under the /app stand-in and land outside it
  const container = posix.normalize(dest.startsWith('/') ? dest : posix.join(workdir, dest === '.' ? '' : dest));
  const clean = container.replace(/\/+$/, '') || '/';
  const local = mapContainerPath(clean, map) ?? join(fallbackRoot, clean);
  return { local, container: clean };
}

// ---------------------------------------------------------------------------------------
// tests/ rewrite
// ---------------------------------------------------------------------------------------

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Copy tests/ to T and rewrite the string literals of runtime files (never Dockerfile or data). */
export async function copyAndRewriteTests(testsDir: string, T: string, map: PathMap): Promise<string[]> {
  await mkdir(T, { recursive: true });
  await cp(testsDir, T, { recursive: true, force: true, dereference: false });
  const rewritten: string[] = [];
  for (const file of await walk(T)) {
    const name = basename(file);
    if (name === 'Dockerfile') continue;
    if (!REWRITE_EXTENSIONS.some((ext) => name.endsWith(ext))) continue;
    const before = await readFile(file, 'utf8');
    const after = rewritePaths(before, map);
    if (after !== before) {
      await writeFile(file, after, 'utf8');
      rewritten.push(relative(T, file));
    }
  }
  return rewritten;
}

// ---------------------------------------------------------------------------------------
// PATH shims
// ---------------------------------------------------------------------------------------

export const SHIM_SETPRIV = `#!/bin/sh
# setpriv shim: no uid/gid drop locally (agent and verifier share a user); run the command.
while [ $# -gt 0 ]; do
  case "$1" in
    --reuid|--regid|--groups|--inh-caps|--ambient-caps|--bounding-set|--securebits|--selinux-label|--apparmor-profile) shift 2 ;;
    --reuid=*|--regid=*|--groups=*|--inh-caps=*|--ambient-caps=*|--bounding-set=*|--securebits=*) shift ;;
    --clear-groups|--keep-groups|--init-groups|--no-new-privs|--reset-env) shift ;;
    --) shift; break ;;
    -*) shift ;;
    *) break ;;
  esac
done
exec "$@"
`;

export const SHIM_UV = `#!/bin/sh
# uv shim: 'uv pip install [--system] ...' -> the verifier venv's pip; anything else is unsupported.
if [ "$1" = "pip" ] && [ "$2" = "install" ]; then
  shift 2
  for a in "$@"; do
    shift
    [ "$a" = "--system" ] || set -- "$@" "$a"
  done
  exec python3 -m pip install "$@"
fi
echo "uv shim: unsupported invocation: uv $*" >&2
exit 127
`;

export const SHIM_APT_GET = `#!/bin/sh
echo "apt-get: system package installs are not available in the local Terminal-Bench shim" >&2
exit 100
`;

export const SHIM_PYTHON = `#!/bin/sh
exec python3 "$@"
`;

/** Write the shims into S (idempotent). `python` resolves through PATH so a venv's python3 wins. */
export async function writeShims(S: string): Promise<void> {
  await mkdir(S, { recursive: true });
  const files: Record<string, string> = { setpriv: SHIM_SETPRIV, uv: SHIM_UV, 'apt-get': SHIM_APT_GET, python: SHIM_PYTHON };
  for (const [name, body] of Object.entries(files)) {
    const p = join(S, name);
    await writeFile(p, body, 'utf8');
    await chmod(p, 0o755);
  }
}

// ---------------------------------------------------------------------------------------
// Shared verifier venv
// ---------------------------------------------------------------------------------------

export const TB_VENV_DIR = 'tb-venv';
export const VERIFIER_BASE_PACKAGES: readonly string[] = ['pytest==9.1.1', 'pytest-json-ctrf==0.5.2'];
const VENV_MARKER = '.jevcode-packages.json';
let venvLock: Promise<void> = Promise.resolve();

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function venvPackages(records: readonly { verifier_pip_packages: readonly string[] }[]): string[] {
  const set = new Set<string>(VERIFIER_BASE_PACKAGES);
  for (const r of records) for (const p of r.verifier_pip_packages) if (/^[A-Za-z0-9_.\-[\]=<>!~,]+$/.test(p)) set.add(p);
  return [...set].sort();
}

/** `<runsDir>/tb-venv` created once per bench (in-process lock); reused when the package set matches. */
export async function ensureVerifierVenv(runsDir: string, packages: readonly string[], makeRunner: (root: string) => CommandRunner, log: (line: string) => void, timeoutMs = 15 * 60_000): Promise<string> {
  const dir = join(runsDir, TB_VENV_DIR);
  const prev = venvLock;
  const next = prev.then(async () => {
    const want = JSON.stringify([...packages].sort());
    const have = await readFile(join(dir, VENV_MARKER), 'utf8').catch(() => null);
    if (have === want && (await pathKind(join(dir, 'bin', 'python'))) === 'file') return;
    await mkdir(dir, { recursive: true });
    const run = makeRunner(dir);
    log(`[terminal-bench] creating verifier venv at ${dir} (${packages.length} packages)`);
    const q = shellQuote(dir);
    const res = await run(`python3 -m venv ${q} && ${q}/bin/python -m pip install -q ${packages.map(shellQuote).join(' ')}`, { timeoutMs, maxOutputBytes: 64 * 1024 });
    if (!res.ok) throw new SandboxError(`verifier venv creation failed: ${res.stderr.slice(-600)}`);
    await writeFile(join(dir, VENV_MARKER), want, 'utf8');
  });
  venvLock = next.catch(() => undefined);
  await next;
  return dir;
}
