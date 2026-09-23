/** The shape every tool executor returns (docs/AGENT-LOOP-DESIGN.md §4.3, §3.6). */
import { FileNotFoundError, JevCodeError, PathEscapeError } from '../../errors.js';

export interface ToolResult {
  /** the `tool_result` content the model reads; its first line is a status line */
  text: string;
  /** false → the result is sent with `isError` */
  ok: boolean;
  /** one line for `tool:call` / `tool:result` and the step record (`read_file src/a.ts (lines 1-120)`) */
  summary: string;
  /** what the loop detector hashes as the call's result (§3.6); null → the call is never signed */
  hashBasis: string | null;
  /** workspace files this call read (the observe step's `read` action paths) */
  readPaths?: string[];
}

/** The `ERROR: …` line for a failed workspace access (§4.3 read_file failures). */
export function accessError(path: string, e: unknown): string | null {
  if (e instanceof FileNotFoundError) return `ERROR: ${path}: no such file`;
  if (e instanceof PathEscapeError) {
    if (e.kind === 'secret') return `ERROR: ${path} is a secret path and cannot be read`;
    if (e.kind === 'git') return `ERROR: ${path} is inside .git, which the harness does not read or write`;
    return `ERROR: ${path} is outside the workspace`;
  }
  if (e instanceof JevCodeError && /not a regular file/.test(e.message)) return `ERROR: ${path} is not a regular file (use glob to list a directory)`;
  return null;
}

export function errorResult(text: string, summary: string, hashBasis: string | null = text): ToolResult {
  return { text, ok: false, summary, hashBasis };
}

/** A file's content holds a NUL byte: binary. */
export function isBinary(content: string): boolean {
  return content.includes('\u0000');
}
