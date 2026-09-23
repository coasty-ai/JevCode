/**
 * `read_file` (docs/AGENT-LOOP-DESIGN.md §4.6): numbered lines through `Workspace.read` (the workspace boundary, secret
 * paths and redaction are the workspace's), paging with offset / limit under a 40,000-char cap, and the
 * `jevcode:outputs/step-N[-k].txt` files the harness spilled long outputs into, served from the run directory.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentContext } from '../../core/types.js';
import { sha12 } from '../../core/hash.js';
import { OUTPUT_READ_PREFIX } from '../../core/limits.js';
import { AGENT_FILE_MAX_BYTES, AGENT_READ_DEFAULT_LINES, AGENT_READ_LINE_CHARS, AGENT_READ_MAX_CHARS } from '../limits.js';
import { numberLines } from './format.js';
import { accessError, errorResult, isBinary, type ToolResult } from './result.js';

/** `outputs/step-12.txt` or `outputs/step-12-3.txt` (several commands of one observe step) — nothing else is ever joined. */
const OUTPUT_REF = /^outputs\/step-([1-9]\d{0,8})(?:-([1-9]\d{0,2}))?\.txt$/;

export function parseAgentOutputRef(path: string): string | null {
  const ref = path.startsWith(OUTPUT_READ_PREFIX) ? path.slice(OUTPUT_READ_PREFIX.length) : null;
  return ref !== null && OUTPUT_REF.test(ref) ? ref : null;
}

async function readRunOutput(ctx: AgentContext, path: string): Promise<{ content: string; truncated: boolean } | string> {
  const ref = parseAgentOutputRef(path);
  if (ref === null) return `ERROR: ${path}: no stored output under this name (the harness names them jevcode:outputs/step-N.txt)`;
  const abs = join(ctx.runDir, ref);
  try {
    const st = await stat(abs);
    const text = await readFile(abs, 'utf8');
    const truncated = st.size > AGENT_FILE_MAX_BYTES;
    return { content: ctx.redact(truncated ? text.slice(0, AGENT_FILE_MAX_BYTES) : text), truncated };
  } catch {
    return `ERROR: ${path}: no such file (the output may have been evicted by the per-run output bound)`;
  }
}

export interface ReadArgs {
  path: string;
  offset?: number;
  limit?: number;
}

/** The last-read content hash of every workspace file `read_file` returned, for edit_file's stale-read note (§4.5 step 8). */
export type ReadHashes = Map<string, string>;

/** Render `content` as the page `[offset, offset + limit)` within the char cap. */
export function renderPage(path: string, content: string, offset: number, limit: number, truncated: boolean): { text: string; ok: boolean; first: number; last: number; total: number } {
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const total = lines.length;
  if (total === 0) return { text: `${path} (empty file)`, ok: true, first: 0, last: 0, total };
  if (offset > total) return { text: `ERROR: offset ${offset} is past the end of ${path} (${total} lines)`, ok: false, first: 0, last: 0, total };
  const shown: string[] = [];
  let chars = 0;
  for (let i = offset - 1; i < total && shown.length < limit; i += 1) {
    const rendered = numberLines([lines[i]!], i + 1, AGENT_READ_LINE_CHARS);
    if (chars + rendered.length + 1 > AGENT_READ_MAX_CHARS && shown.length > 0) break;
    shown.push(rendered);
    chars += rendered.length + 1;
  }
  const last = offset + shown.length - 1;
  const parts = [`${path} (lines ${offset}-${last} of ${total}${truncated ? '+; the file is larger than 1 MiB and only its head is readable' : ''})`, ...shown];
  if (last < total) parts.push(`[showing lines ${offset}-${last} of ${total}; call read_file with offset=${last + 1} to continue]`);
  return { text: parts.join('\n'), ok: true, first: offset, last, total };
}

async function readOne(ctx: AgentContext, a: ReadArgs, hashes: ReadHashes): Promise<ToolResult> {
  const offset = a.offset ?? 1;
  const limit = a.limit ?? AGENT_READ_DEFAULT_LINES;
  let content: string;
  let truncated = false;
  let workspaceFile = false;
  if (a.path.startsWith(OUTPUT_READ_PREFIX)) {
    const r = await readRunOutput(ctx, a.path);
    if (typeof r === 'string') return errorResult(r, `read_file ${a.path} (error)`);
    ({ content, truncated } = r);
  } else {
    try {
      const view = await ctx.workspace.read(a.path, AGENT_FILE_MAX_BYTES);
      content = view.content;
      truncated = view.truncatedBytes > 0;
      workspaceFile = true;
    } catch (e) {
      const text = accessError(a.path, e);
      if (text === null) throw e;
      return errorResult(text, `read_file ${a.path} (error)`);
    }
  }
  if (isBinary(content)) return errorResult(`ERROR: ${a.path} is binary`, `read_file ${a.path} (binary)`);
  if (workspaceFile) hashes.set(a.path, sha12(content));
  const page = renderPage(a.path, content, offset, limit, truncated);
  const summary = page.ok ? (page.total === 0 ? `read_file ${a.path} (empty)` : `read_file ${a.path} (lines ${page.first}-${page.last})`) : `read_file ${a.path} (error)`;
  return { text: page.text, ok: page.ok, summary, hashBasis: page.text, ...(workspaceFile && page.ok ? { readPaths: [a.path] } : {}) };
}

/** `read_file`, one path or the ≤ 8 of a `paths: [...]` call (one result, the pages one after another). */
export async function runReadFile(ctx: AgentContext, a: ReadArgs, paths: readonly string[] | undefined, hashes: ReadHashes): Promise<ToolResult> {
  if (paths === undefined || paths.length <= 1) return readOne(ctx, a, hashes);
  const results: ToolResult[] = [];
  for (const p of paths) results.push(await readOne(ctx, { ...a, path: p }, hashes));
  const readPaths = results.flatMap((r) => r.readPaths ?? []);
  return {
    text: results.map((r) => r.text).join('\n\n'),
    ok: results.some((r) => r.ok),
    summary: `read_file ${paths.join(', ')} (${paths.length} files)`,
    hashBasis: results.map((r) => r.hashBasis ?? '').join('\n'),
    ...(readPaths.length > 0 ? { readPaths } : {}),
  };
}
