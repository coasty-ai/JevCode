/**
 * Disk cache for provider catalogues: `~/.jevcode/models/<provider>.json`, one file per provider,
 * fresh for 24 h, with the response's ETag kept so a refresh can be answered by a 304 *when the
 * provider offers one*. None of the seven list endpoints sent an `etag` header when probed on
 * 2026-09-21 (nor OpenRouter's `/key` check), so a refresh today is in practice a full
 * re-download; the revalidation path is here for the providers that add one. Size a refresh
 * accordingly rather than assuming 304s.
 *
 * The cache exists so the first frame never waits on the network: a picker opens from this file (or
 * from the bundled snapshot) and refreshes behind the frame. Every read is tolerant — a missing,
 * truncated, hand-edited or foreign-version file reads as a miss, and a failed write is not an error
 * for the caller.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { writeFileAtomic } from '../core/atomic.js';
import { isJsonObject, parseJson } from '../core/json.js';
import { isProviderId } from './providers.js';
import type { CacheEntry, Json, JsonObject, ModelCache, ModelInfo, ModelPricing, ModelSupports, ProviderId } from './types.js';

/** 24 h (the task's TTL): catalogues change on the order of weeks, keys and prices on the order of days. */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** On-disk shape version; a file with any other value reads as a miss. */
export const CACHE_VERSION = 1;

/**
 * `<jevcode home>/models` — `~/.jevcode/models`, or `$JEVCODE_HOME/models` when set (the same home
 * whose `runs/` is the runs dir; `cli/session.ts jevcodeDir` resolves it the same way, which this
 * mirrors rather than imports so the catalogue does not depend on the CLI).
 */
export function modelsCacheDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir(), cwd: string = process.cwd()): string {
  const h = env['JEVCODE_HOME']?.trim();
  const base = h !== undefined && h !== '' ? resolvePath(cwd, h) : join(home, '.jevcode');
  return join(base, 'models');
}

export function cacheFilePath(dir: string, provider: ProviderId): string {
  return join(dir, `${provider}.json`);
}

// ---------------------------------------------------------------------------------------
// Tolerant parse (the file is untrusted input like any wire payload)
// ---------------------------------------------------------------------------------------

function str(o: JsonObject, key: string): string | null {
  const v = o[key];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function posInt(o: JsonObject, key: string): number | undefined {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined;
}

function rate(o: JsonObject, key: string): number | undefined {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function boolOf(o: JsonObject, key: string): boolean | undefined {
  const v = o[key];
  return typeof v === 'boolean' ? v : undefined;
}

/** Alias list from a cache file: strings only, trimmed, de-duplicated, never the id, `[]` → absent. */
function parseAliases(id: string, v: Json | undefined): readonly string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const alias = item.trim();
    if (alias === '' || alias === id || out.includes(alias)) continue;
    out.push(alias);
  }
  return out.length === 0 ? undefined : out;
}

function parsePricing(v: Json | undefined): ModelPricing | undefined {
  if (!isJsonObject(v)) return undefined;
  const input = rate(v, 'inputPerM');
  const output = rate(v, 'outputPerM');
  if (input === undefined || output === undefined) return undefined;
  const p: ModelPricing = { inputPerM: input, outputPerM: output };
  const cache = rate(v, 'cacheReadPerM');
  if (cache !== undefined) p.cacheReadPerM = cache;
  return p;
}

function parseSupports(v: Json | undefined): ModelSupports {
  const s: ModelSupports = {};
  if (!isJsonObject(v)) return s;
  const tools = boolOf(v, 'tools');
  if (tools !== undefined) s.tools = tools;
  const structured = boolOf(v, 'structuredOutput');
  if (structured !== undefined) s.structuredOutput = structured;
  const reasoning = boolOf(v, 'reasoning');
  if (reasoning !== undefined) s.reasoning = reasoning;
  const vision = boolOf(v, 'vision');
  if (vision !== undefined) s.vision = vision;
  return s;
}

/** One cached model, field by field. Null when the id or provider is unusable. */
export function parseCachedModel(v: Json): ModelInfo | null {
  if (!isJsonObject(v)) return null;
  const id = str(v, 'id');
  const provider = str(v, 'provider');
  if (id === null || provider === null || !isProviderId(provider)) return null;
  const info: ModelInfo = {
    id,
    provider,
    displayName: str(v, 'displayName') ?? id,
    supports: parseSupports(v['supports']),
    updatedAt: str(v, 'updatedAt') ?? '',
  };
  const aliases = parseAliases(id, v['aliases']);
  if (aliases !== undefined) info.aliases = aliases;
  const ctx = posInt(v, 'contextLength');
  if (ctx !== undefined) info.contextLength = ctx;
  const out = posInt(v, 'maxOutput');
  if (out !== undefined) info.maxOutput = out;
  const pricing = parsePricing(v['pricing']);
  if (pricing !== undefined) info.pricing = pricing;
  if (v['deprecated'] === true) info.deprecated = true;
  return info;
}

/** Parse a cache file. Null for anything that is not a version-1 entry for a known provider. */
export function parseCacheFile(text: string): CacheEntry | null {
  const parsed = parseJson(text);
  if (!parsed.ok || !isJsonObject(parsed.value)) return null;
  const body = parsed.value;
  if (body['version'] !== CACHE_VERSION) return null;
  const provider = str(body, 'provider');
  const fetchedAt = str(body, 'fetchedAt');
  if (provider === null || !isProviderId(provider) || fetchedAt === null) return null;
  const raw = body['models'];
  if (!Array.isArray(raw)) return null;
  const models: ModelInfo[] = [];
  for (const item of raw) {
    const model = parseCachedModel(item);
    if (model !== null && model.provider === provider) models.push(model);
  }
  const etag = str(body, 'etag');
  return { version: 1, provider, fetchedAt, etag, models };
}

export function serialiseCacheEntry(entry: CacheEntry): string {
  return `${JSON.stringify({ version: CACHE_VERSION, provider: entry.provider, fetchedAt: entry.fetchedAt, etag: entry.etag, models: entry.models }, null, 2)}\n`;
}

/**
 * Inside the TTL window. A file with an unparseable `fetchedAt` is never fresh, and neither is one
 * stamped in the future: a clock that was briefly set forward (or a VM with a bad RTC) would
 * otherwise write an entry that pins the catalogue until the wall clock catches up, with only
 * `force` to escape it. A negative age is treated as "not fresh", i.e. revalidate now.
 */
export function isFresh(entry: CacheEntry, nowMs: number, ttlMs: number = CACHE_TTL_MS): boolean {
  const at = Date.parse(entry.fetchedAt);
  if (!Number.isFinite(at)) return false;
  const age = nowMs - at;
  return age >= 0 && age < ttlMs;
}

/** How old a cached entry is, in ms; null when its timestamp is unusable. */
export function cacheAgeMs(entry: CacheEntry, nowMs: number): number | null {
  const at = Date.parse(entry.fetchedAt);
  return Number.isFinite(at) ? Math.max(0, nowMs - at) : null;
}

export interface CacheDeps {
  readFile?: (path: string) => Promise<string>;
  writeFile?: (path: string, text: string) => Promise<void>;
}

/** A cache over a directory. Reads never throw; writes swallow their own failures. */
export function createModelCache(dir: string, deps: CacheDeps = {}): ModelCache {
  const read = deps.readFile ?? ((p: string): Promise<string> => readFile(p, 'utf8'));
  const write = deps.writeFile ?? ((p: string, text: string): Promise<void> => writeFileAtomic(p, text, { mkdir: true }));
  return {
    path: (provider) => cacheFilePath(dir, provider),
    async read(provider) {
      let text: string;
      try {
        text = await read(cacheFilePath(dir, provider));
      } catch {
        return null;
      }
      const entry = parseCacheFile(text);
      return entry !== null && entry.provider === provider ? entry : null;
    },
    async write(entry) {
      try {
        await write(cacheFilePath(dir, entry.provider), serialiseCacheEntry(entry));
      } catch {
        // §4.6 judge-safety rule d (as for trust.json): a failed cache write is never fatal
      }
    },
  };
}

/** A cache that stores nothing — for one-shot reads and for tests that assert the network path. */
export const NULL_CACHE: ModelCache = {
  path: (provider) => cacheFilePath('', provider),
  read: async () => null,
  write: async () => undefined,
};

/** The production cache, rooted at `modelsCacheDir()`. */
export function defaultModelCache(env: NodeJS.ProcessEnv = process.env): ModelCache {
  return createModelCache(modelsCacheDir(env));
}
