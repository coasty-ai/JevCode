import type { Json, JsonObject } from './types.js';

export type ParseResult = { ok: true; value: Json } | { ok: false; error: string };

export function parseJson(text: string): ParseResult {
  try {
    return { ok: true, value: JSON.parse(text) as Json };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function isJsonObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isJsonArray(v: unknown): v is Json[] {
  return Array.isArray(v);
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function isString(v: unknown): v is string {
  return typeof v === 'string';
}

export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Convert an arbitrary serialisable value (records with optional/undefined fields, Dates,
 * class instances with toJSON) into plain Json by round-tripping through JSON.stringify.
 */
export function toJson(v: unknown): Json {
  const text = JSON.stringify(v);
  return text === undefined ? null : (JSON.parse(text) as Json);
}

/** Read a nested property by dotted path, or undefined. */
export function getPath(v: Json, path: string): Json | undefined {
  let cur: Json | undefined = v;
  for (const part of path.split('.')) {
    if (cur === undefined || cur === null || typeof cur !== 'object') return undefined;
    cur = Array.isArray(cur) ? cur[Number(part)] : cur[part];
  }
  return cur;
}
