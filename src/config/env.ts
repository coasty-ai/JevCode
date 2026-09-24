/**
 * .env reading (DESIGN.md §3): `util.parseEnv` into an isolated map, never into
 * `process.env`, so a loaded key can never leak into a sandboxed child's environment.
 */
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { ConfigError } from '../errors.js';
import type { LoadedDotenv } from './types.js';

/** A .env larger than this is not a .env; refusing it bounds memory and redaction cost. */
export const MAX_DOTENV_BYTES = 1024 * 1024;

function errnoCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'string' ? (e as { code: string }).code : undefined;
}

/** Parse .env text into a Map; empty values are kept (resolve.ts treats them as unset). */
export function parseDotenvText(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(parseEnv(text))) {
    if (typeof v === 'string') out.set(k, v);
  }
  return out;
}

/** null when the file does not exist (or the path is a directory); ConfigError for anything else, naming the path. */
export async function readDotenv(path: string): Promise<LoadedDotenv | null> {
  let text: string;
  try {
    const buf = await readFile(path);
    if (buf.byteLength > MAX_DOTENV_BYTES) {
      throw new ConfigError(`dotenv file ${path} is ${buf.byteLength} bytes; refusing to parse more than ${MAX_DOTENV_BYTES}`, { setting: 'dotenv' });
    }
    text = buf.toString('utf8');
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    const code = errnoCode(e);
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null;
    throw new ConfigError(`cannot read dotenv file ${path}: ${e instanceof Error ? e.message : String(e)}`, { setting: 'dotenv', cause: e });
  }
  return { path, vars: parseDotenvText(text) };
}
