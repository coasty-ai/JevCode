/**
 * The optional post-write syntax check (docs/AGENT-LOOP-DESIGN.md §4.8): after a successful edit or write, a quick parse
 * by extension — Python through `ast.parse` in memory (no `__pycache__` in the workspace), JSON in process, and
 * `node --check` for edits of existing JavaScript files only (a new `.js` file may hold JSX or Flow).
 *
 * New errors only: when the post-edit content fails, the pre-edit content is checked the same way, and nothing is
 * reported when it failed too — so valid JSX in an existing `.js` file is never flagged. A missing interpreter or a
 * timeout adds nothing; the check never reverts anything.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import type { AgentContext } from '../../core/types.js';
import { shellQuote } from '../../workspace/tests.js';
import { AGENT_CHECK_MAX_LINES, AGENT_CHECK_TIMEOUT_MS } from '../limits.js';

const PY_CHECK = `python3 -c "import ast,sys;ast.parse(open(sys.argv[1],encoding='utf-8').read(),sys.argv[1])"`;

type Checker = (ctx: AgentContext, target: string) => Promise<string[] | null>;

/** Run a command-line checker; null = no verdict (missing interpreter, timeout, sandbox trouble). */
async function commandCheck(ctx: AgentContext, command: string): Promise<string[] | null> {
  try {
    const r = await ctx.sandbox.run(command, { timeoutMs: AGENT_CHECK_TIMEOUT_MS, maxOutputBytes: 64 * 1024, signal: ctx.signal });
    if (r.killedBy !== null || r.exitCode === 127 || r.exitCode === null) return null;
    if (r.exitCode === 0) return [];
    const lines = `${r.stderr}\n${r.stdout}`.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
    return lines.length === 0 ? null : lines.map(ctx.redact);
  } catch {
    return null;
  }
}

const pythonCheck: Checker = (ctx, target) => commandCheck(ctx, `${PY_CHECK} ${shellQuote(target)}`);
const nodeCheck: Checker = (ctx, target) => commandCheck(ctx, `node --check ${shellQuote(target)}`);

function jsonProblem(text: string): string[] {
  try {
    JSON.parse(text);
    return [];
  } catch (e) {
    return [e instanceof Error ? e.message : String(e)];
  }
}

/**
 * The extension a scratch copy of `path` needs to parse as the file does in place: a `.js` file takes its module type
 * from the nearest package.json inside the workspace (`"type": "module"` → `.mjs`, `"commonjs"` → `.cjs`).
 */
async function scratchExt(root: string, path: string, ext: string): Promise<string> {
  if (ext !== '.js') return ext;
  for (let dir = dirname(join(root, path)); dir.startsWith(root); dir = dirname(dir)) {
    // the nearest package.json decides, with or without a type (none: CommonJS with module detection, like `.js`)
    const pkg = await readFile(join(dir, 'package.json'), 'utf8').then((t) => JSON.parse(t) as { type?: unknown }, () => null);
    if (pkg !== null) return pkg.type === 'module' ? '.mjs' : pkg.type === 'commonjs' ? '.cjs' : ext;
    if (dir === root || dirname(dir) === dir) break;
  }
  return ext;
}

/** Check the pre-edit content through a scratch copy under the run's tmp dir, with the extension it parses under. */
async function checkScratch(ctx: AgentContext, content: string, ext: string, checker: Checker): Promise<string[] | null> {
  const dir = join(ctx.runDir, 'tmp');
  const file = join(dir, `agent-check-${process.pid}-${Date.now()}${ext}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, content, { mode: 0o600 });
    return await checker(ctx, file);
  } catch {
    return null;
  } finally {
    await rm(file, { force: true }).catch(() => undefined);
  }
}

/**
 * The `syntax check:` lines to append to an edit/write result (≤ 20), or [] when there is nothing new to report.
 * `before` is the pre-edit content (null for a new file); `after` the content now on disk at `path`.
 */
export async function syntaxCheck(ctx: AgentContext, path: string, before: string | null, after: string): Promise<string[]> {
  const ext = extname(path).toLowerCase();
  let problems: string[] | null = null;
  let previous: () => Promise<string[] | null> = async () => null;
  if (ext === '.json') {
    problems = jsonProblem(after);
    previous = async () => (before === null ? [] : jsonProblem(before));
  } else if (ext === '.py') {
    problems = await pythonCheck(ctx, path);
    previous = async () => (before === null ? [] : checkScratch(ctx, before, ext, pythonCheck));
  } else if ((ext === '.js' || ext === '.mjs' || ext === '.cjs') && before !== null) {
    problems = await nodeCheck(ctx, path);
    previous = async () => checkScratch(ctx, before, await scratchExt(ctx.workspace.root, path, ext), nodeCheck);
  }
  if (problems === null || problems.length === 0) return [];
  const old = await previous();
  // new errors only: an old failure (or no verdict on the old content) reports nothing
  if (old === null || old.length > 0) return [];
  return problems.slice(0, AGENT_CHECK_MAX_LINES);
}

/** The lines appended to a result (§4.3): `syntax check:` then the problems. */
export function syntaxCheckBlock(lines: readonly string[]): string | null {
  return lines.length === 0 ? null : `syntax check:\n${lines.join('\n')}`;
}
