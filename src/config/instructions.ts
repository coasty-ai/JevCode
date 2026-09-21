/**
 * Instruction files (TUI-DESIGN §11.3, A122, D6). `loadInstructions(workspaceRoot, gitRoot, home)`
 * takes the first `AGENTS.md` (fallback `CLAUDE.md`) found walking up from the workspace to the
 * workspace root — never above it — plus `${XDG_CONFIG_HOME:-~/.config}/jevcode/AGENTS.md`;
 * 32 KiB cap per file (truncated with a notice); read once per run after the first frame;
 * `redact`ed (default `patternRedact`, so a caller that forgets the config redactor still gets
 * the safe layer); recorded as `run.json.instructions[]` (`{ path, sha256, bytes }`) and injected
 * into the generator system prompt only, as `## Project instructions (from <path>, sha256 <8>)`.
 * A symlinked instruction file is followed only while its realpath stays inside the tree it was
 * found in (the workspace root, or the jevcode config dir for the global file): a repository
 * cannot point `AGENTS.md` at `~/.ssh/id_rsa` to pull it into the prompt.
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { sha256Hex } from '../core/hash.js';
import { patternRedact } from '../core/redact.js';
import { clipBytes } from '../core/text.js';
import type { InstructionRecord } from '../core/types.js';
import { displayPath, xdgJevcodeDir } from './credentials.js';

/** TUI-DESIGN §11.3: per-file cap (Codex's AGENTS_MD_MAX_BYTES). */
export const INSTRUCTIONS_MAX_BYTES = 32 * 1024;
/** A file larger than this is not an instruction file; it is skipped with a notice instead of being read. */
export const INSTRUCTIONS_READ_CAP_BYTES = 4 * 1024 * 1024;
/** TUI-DESIGN §11.3: the names tried in order at each directory. */
export const INSTRUCTION_FILE_NAMES: readonly ('AGENTS.md' | 'CLAUDE.md')[] = ['AGENTS.md', 'CLAUDE.md'];

/** TUI-DESIGN §11.3: one loaded file with its display path and clipped text. */
export interface LoadedInstructionFile extends InstructionRecord {
  /** path as shown in items and the system prompt (workspace-relative or `~/…`) */
  display: string;
  name: 'AGENTS.md' | 'CLAUDE.md';
  truncated: boolean;
  /** redacted, clipped content */
  text: string;
}

/** TUI-DESIGN §11.3: `loadInstructions` result — the `EngineOptions.instructions` shape plus notices. */
export interface LoadedInstructions {
  /** `run.json.instructions[]` */
  files: InstructionRecord[];
  /** the generator system-prompt section(s); empty when no file was found */
  text: string;
  /** truncation, unreadable files, skipped oversize files */
  notices: string[];
  /** every file, with its text, for the trust prompt and the pane */
  loaded: LoadedInstructionFile[];
}

/** TUI-DESIGN §11.3: seams (env for XDG, redact, cap, fs). */
export interface LoadInstructionsOptions {
  env?: NodeJS.ProcessEnv;
  /** default `patternRedact` */
  redact?: (s: string) => string;
  maxBytes?: number;
  readFile?: (path: string) => Promise<Buffer>;
  stat?: (path: string) => Promise<{ isFile(): boolean; size: number }>;
  /** symlink resolution (default `fs.promises.realpath`) */
  realpath?: (path: string) => Promise<string>;
}

type Io = Required<Pick<LoadInstructionsOptions, 'redact' | 'maxBytes' | 'readFile' | 'stat' | 'realpath'>>;

function errnoCode(e: unknown): string {
  return typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'string' ? (e as { code: string }).code : 'error';
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** TUI-DESIGN §11.3: the directories searched — the workspace up to the workspace root (git root) inclusive, never above; only the workspace when it is not inside the root. Pure. */
export function instructionSearchDirs(workspaceRoot: string, gitRoot: string | null): string[] {
  const ws = resolvePath(workspaceRoot);
  const top = gitRoot === null ? ws : resolvePath(gitRoot);
  if (!isInside(ws, top)) return [ws];
  const dirs: string[] = [];
  let dir = ws;
  for (;;) {
    dirs.push(dir);
    if (dir === top) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/** TUI-DESIGN §11.3: `## Project instructions (from <path>, sha256 <8>)` header. Pure. */
export function instructionsHeader(display: string, sha256: string): string {
  return `## Project instructions (from ${display}, sha256 ${sha256.slice(0, 8)})`;
}

/** TUI-DESIGN §24: `instructions: <path> (<bytes>, sha256 <8>)` — the `[run]` label is `stepLabel()`. Pure. */
export function instructionItemText(display: string, rec: InstructionRecord, truncated = false): string {
  return `instructions: ${display} (${rec.bytes} bytes, sha256 ${rec.sha256.slice(0, 8)})${truncated ? ` — truncated to ${INSTRUCTIONS_MAX_BYTES / 1024} KiB` : ''}`;
}

function displayFor(path: string, workspaceRoot: string, home: string): string {
  if (isInside(path, workspaceRoot)) {
    const rel = relative(workspaceRoot, path);
    return rel === '' ? path : rel.split(sep).join('/');
  }
  const rel = relative(workspaceRoot, path);
  if (!rel.startsWith('..') || rel.split(sep).filter((p) => p === '..').length > 3) return displayPath(path, home);
  return rel.split(sep).join('/');
}

async function realOrSelf(p: string, o: Io): Promise<string> {
  try {
    return await o.realpath(p);
  } catch {
    return resolvePath(p);
  }
}

/** Read one candidate; `scope` is the directory whose realpath the file must resolve inside (symlink policy). */
async function readOne(path: string, name: 'AGENTS.md' | 'CLAUDE.md', display: string, scope: string, o: Io, notices: string[]): Promise<LoadedInstructionFile | null> {
  let size: number;
  try {
    const st = await o.stat(path);
    if (!st.isFile()) return null;
    size = st.size;
  } catch (e) {
    const code = errnoCode(e);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') notices.push(`instructions: cannot read ${display}: ${code}`);
    return null;
  }
  const real = await realOrSelf(path, o);
  if (!isInside(real, await realOrSelf(scope, o))) {
    notices.push(`instructions: ${display} skipped (symlink resolves outside ${scope})`);
    return null;
  }
  if (size > INSTRUCTIONS_READ_CAP_BYTES) {
    notices.push(`instructions: ${display} skipped (${size} bytes; larger than ${INSTRUCTIONS_READ_CAP_BYTES / (1024 * 1024)} MiB)`);
    return null;
  }
  let buf: Buffer;
  try {
    buf = await o.readFile(path);
  } catch (e) {
    notices.push(`instructions: cannot read ${display}: ${errnoCode(e)}`);
    return null;
  }
  const sha256 = sha256Hex(buf);
  const { text: clipped, truncatedBytes } = clipBytes(buf.toString('utf8'), o.maxBytes);
  const truncated = truncatedBytes > 0;
  if (truncated) notices.push(`instructions: ${display} truncated to ${Math.floor(o.maxBytes / 1024)} KiB (${buf.length} bytes on disk)`);
  return { path, sha256, bytes: buf.length, display, name, truncated, text: o.redact(clipped) };
}

/**
 * TUI-DESIGN §11.3: load the project instruction file (first match walking up, `CLAUDE.md`
 * fallback) and the global `~/.config/jevcode/AGENTS.md`; 32 KiB cap each; redacted; returns the
 * `run.json` records, the system-prompt text and any notices. Missing files are not an error.
 */
export async function loadInstructions(workspaceRoot: string, gitRoot: string | null, home: string, opts: LoadInstructionsOptions = {}): Promise<LoadedInstructions> {
  const o: Io = {
    redact: opts.redact ?? patternRedact,
    maxBytes: opts.maxBytes ?? INSTRUCTIONS_MAX_BYTES,
    readFile: opts.readFile ?? ((p: string): Promise<Buffer> => readFile(p)),
    stat: opts.stat ?? ((p: string) => stat(p)),
    realpath: opts.realpath ?? ((p: string) => realpath(p)),
  };
  const env = opts.env ?? {};
  const ws = resolvePath(workspaceRoot);
  const notices: string[] = [];
  const loaded: LoadedInstructionFile[] = [];

  const dirs = instructionSearchDirs(ws, gitRoot);
  const scope = dirs[dirs.length - 1] ?? ws;
  outer: for (const dir of dirs) {
    for (const name of INSTRUCTION_FILE_NAMES) {
      const p = join(dir, name);
      const f = await readOne(p, name, displayFor(p, ws, home), scope, o, notices);
      if (f) {
        loaded.push(f);
        break outer;
      }
    }
  }
  const globalDir = xdgJevcodeDir(env, home);
  const globalPath = join(globalDir, 'AGENTS.md');
  if (!loaded.some((f) => f.path === globalPath)) {
    const g = await readOne(globalPath, 'AGENTS.md', displayPath(globalPath, home), globalDir, o, notices);
    if (g) loaded.push(g);
  }

  const files: InstructionRecord[] = loaded.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes }));
  const text = loaded.map((f) => `${instructionsHeader(f.display, f.sha256)}\n\n${f.text}`).join('\n\n');
  return { files, text, notices, loaded };
}

/** The project-level file (the first entry when it is not the global one), for the trust store's `agents` field. */
export function projectInstructionFile(result: LoadedInstructions, env: NodeJS.ProcessEnv, home: string): LoadedInstructionFile | null {
  const globalPath = join(xdgJevcodeDir(env, home), 'AGENTS.md');
  return result.loaded.find((f) => f.path !== globalPath) ?? null;
}
