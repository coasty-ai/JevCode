/** The shape every tool executor returns (docs/AGENT-LOOP-DESIGN.md §4.3, §3.6). */
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
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
  /** the spill file of a clipped output (`jevcode:outputs/step-N.txt`): a masked result names it (§7.3) */
  pointer?: string;
}

/**
 * A missing path that starts with the workspace folder's own name (`js-fix/src/math.js` in `…/js-fix`): the hint names
 * the relative form, so the next call lands (the S6 live runs of 2026-09-23 spent a turn on a `glob` to find it). '' otherwise,
 * and '' when the workspace has a top-level entry of that name, where the path may mean exactly what it says.
 */
export function rootNameHint(root: string, path: string): string {
  const name = basename(root);
  const p = path.replace(/^\.\//, '');
  // a workspace that really has a top-level entry of that name (a Python package named like its repo) gets no hint
  if (name === '' || !p.startsWith(`${name}/`) || p.length <= name.length + 1 || existsSync(join(root, name))) return '';
  return ` (paths are relative to the workspace root ${name}: did you mean ${p.slice(name.length + 1)}?)`;
}

/** The `ERROR: …` line for a failed workspace access (§4.3 read_file failures); `root` adds the root-name hint to a missing file. */
export function accessError(path: string, e: unknown, root?: string): string | null {
  if (e instanceof FileNotFoundError) return `ERROR: ${path}: no such file${root === undefined ? '' : rootNameHint(root, path)}`;
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

/**
 * Decoded content that may not have been UTF-8 on disk: the decoder turned an invalid byte into U+FFFD, or a NUL
 * (binary, or UTF-16) is in it. Only then is it worth reading the raw bytes (src/workspace/encoding.ts) again.
 */
export function mayNotBeUtf8(content: string): boolean {
  return content.includes('�') || content.includes('\u0000');
}

/**
 * A live TUI run wrote `$TMPDIR/probe.test.tsx` with write_file and left a literal `$TMPDIR/` directory in the
 * repository: only bash expands variables. A file-tool path that starts with `$` or holds `${` is refused with this.
 */
export const VARIABLE_PATH_ERROR = `ERROR: file tools take workspace paths and do not expand variables such as $TMPDIR; create scratch files with bash (e.g. cat > "$TMPDIR/x" <<'EOF')`;

/** True for a path a shell would expand (`$TMPDIR/x`, `$HOME/a`, `src/${name}.ts`); `routes/$slug.tsx` is an ordinary name. */
export function isVariablePath(path: string): boolean {
  return path.startsWith('$') || path.includes('${');
}

/** Text that went through the redactor holds `[REDACTED:<kind>]` (src/core/redact.ts) — or a bare `[REDACTED]`. */
export function hasRedactionMarker(text: string): boolean {
  return /\[REDACTED[:\]]/.test(text);
}
