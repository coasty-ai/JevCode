/**
 * Path containment for every harness file access (DESIGN.md §8 `resolveInside`).
 *
 * The rule: resolve against the workspace, canonicalise the longest existing prefix
 * (including the full path, so a symlink at the last component is followed), append the
 * non-existent remainder, and require the result to sit inside realpath(workspace). Nothing
 * touches disk before this check passes. Secret stores are refused separately so the
 * generator never sees the harness's own keys even when the workspace is the JevCode checkout.
 */
import { lstat, realpath } from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';

import { PathEscapeError, SecretPathError } from '../errors.js';
import type { PathEscapeKind } from '../errors.js';

export type AccessMode = 'read' | 'write';

function errnoCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code?: unknown }).code) : undefined;
}

/** True when `child` is `parent` itself or lives under it (both already canonical). */
export function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * Canonical form of an absolute path that may not fully exist yet: realpath of the longest
 * existing prefix plus the remaining lexical components. A dangling symlink anywhere in the
 * prefix is reported as `{ dangling: true }` because following it on write would create a
 * file wherever it points.
 */
export async function canonicalPath(absPath: string): Promise<{ path: string; dangling: boolean }> {
  let prefix = absPath;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = await realpath(prefix);
      return { path: rest.length ? resolve(real, ...rest) : real, dangling: false };
    } catch (e) {
      const code = errnoCode(e);
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'ELOOP') throw e;
      if (code === 'ENOENT' || code === 'ELOOP') {
        // realpath failed but the entry itself exists: a dangling or cyclic symlink
        const st = await lstat(prefix).catch(() => null);
        if (st?.isSymbolicLink()) return { path: absPath, dangling: true };
      }
      const parent = dirname(prefix);
      if (parent === prefix) return { path: absPath, dangling: false };
      rest.unshift(basename(prefix));
      prefix = parent;
    }
  }
}

/** Synchronous twin used once at sandbox creation to build the seatbelt profile. */
export function canonicalPathSync(absPath: string): string {
  let prefix = absPath;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(prefix);
      return rest.length ? resolve(real, ...rest) : real;
    } catch (e) {
      const code = errnoCode(e);
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'ELOOP') throw e;
      if (code !== 'ENOTDIR') {
        let isLink = false;
        try {
          isLink = lstatSync(prefix).isSymbolicLink();
        } catch {
          isLink = false;
        }
        if (isLink) return absPath;
      }
      const parent = dirname(prefix);
      if (parent === prefix) return absPath;
      rest.unshift(basename(prefix));
      prefix = parent;
    }
  }
}

/**
 * Resolve `p` (relative to `ws`, or absolute) to a canonical absolute path that is inside
 * realpath(ws); `write` additionally refuses anything under `.git`. Throws PathEscapeError
 * with a kind that tells the generator *why* (`absolute`, `outside`, `symlink`, `git`).
 */
export async function resolveInside(ws: string, p: string, mode: AccessMode): Promise<string> {
  if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) throw new PathEscapeError('outside', String(p), `path ${JSON.stringify(String(p))} is empty or malformed`);
  const realWs = await realpath(ws);
  const absolute = isAbsolute(p);
  const lexical = resolve(realWs, p);
  const lexicalGiven = resolve(ws, p);
  const lexicallyInside = isWithin(realWs, lexical) || isWithin(resolve(ws), lexicalGiven);
  const kindFor = (fallback: PathEscapeKind): PathEscapeKind => (absolute && !lexicallyInside ? 'absolute' : lexicallyInside ? 'symlink' : fallback);

  if (!lexicallyInside) throw new PathEscapeError(absolute ? 'absolute' : 'outside', p);

  const canon = await canonicalPath(lexical);
  if (canon.dangling) throw new PathEscapeError('symlink', p, `path "${p}" is a dangling or cyclic symlink`);
  if (!isWithin(realWs, canon.path)) throw new PathEscapeError(kindFor('outside'), p, `path "${p}" resolves outside the workspace`);
  if (mode === 'write' && isWithin(resolve(realWs, '.git'), canon.path)) throw new PathEscapeError('git', p, `path "${p}" is inside .git and is never written by JevCode`);
  return canon.path;
}

const SECRET_BASENAMES = new Set(['.env', '.netrc']);
const SECRET_PATTERNS: readonly RegExp[] = [/^\.env\..+$/, /\.pem$/i, /\.key$/i, /^id_[a-z0-9_-]+(\.pub)?$/i];
const SECRET_EXCEPTIONS = new Set(['.env.example']);

/** Basename rule shared by candidates and the seatbelt read denials. */
export function isSecretBasename(name: string): boolean {
  if (SECRET_EXCEPTIONS.has(name)) return false;
  if (SECRET_BASENAMES.has(name)) return true;
  return SECRET_PATTERNS.some((re) => re.test(name));
}

/**
 * True when `p` (relative to `ws` or absolute; may be already canonical) is one of the
 * configured secret stores or matches the secret basename rule. Purely lexical so it can be
 * used on listings without touching disk; callers also pass the canonical path when they
 * have it.
 */
export function isSecretPath(ws: string, p: string, secretPaths: readonly string[]): boolean {
  const abs = resolve(ws, p);
  if (isSecretBasename(basename(abs))) return true;
  for (const s of secretPaths) {
    if (typeof s !== 'string' || s.length === 0) continue;
    const sAbs = resolve(s);
    if (abs === sAbs || abs.startsWith(sAbs + sep)) return true;
  }
  return false;
}

export function assertNotSecret(ws: string, p: string, secretPaths: readonly string[], canonical?: string): void {
  if (isSecretPath(ws, p, secretPaths)) throw new SecretPathError(p);
  if (canonical !== undefined && isSecretPath(ws, canonical, secretPaths)) throw new SecretPathError(p);
}
