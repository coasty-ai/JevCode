/**
 * The keybindings file (TUI-DESIGN §3.4, §16 `ui.keybindings`, A24, F14):
 * `${XDG_CONFIG_HOME:-~/.config}/jevcode/keybindings.json` maps `namespace:action` ids to a key string,
 * an array of key strings, or `"none"` / `null` to unbind. A value with two space-separated keys is a
 * chord completed within 3 s. Reserved keys and reserved actions are refused (warning), unknown ids warn,
 * key collisions are reported by `buildBindings` (§3.4, §6.2), nothing is fatal. `parseKeybindings` is
 * pure; `loadKeybindings` is the one synchronous read (≤ 64 KiB), meant for the tick right after
 * `firstFrame()` resolves and for `/help reload`; its `warnings` carry the parse and the collision lines.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildBindings, isReservedKey, keyActionById, normalizeKeyString, type Bindings } from './bindings.js';

/** TUI-DESIGN §3.4: the file is read up to this size; a larger one is ignored with a warning. */
export const KEYBINDINGS_MAX_BYTES = 64 * 1024;

/** TUI-DESIGN §3.4: the outcome of parsing one file body. */
export interface KeybindingsParse {
  /** action id → effective keys (an empty array unbinds); only ids that were accepted */
  readonly overrides: ReadonlyMap<string, readonly string[]>;
  /** one line per refused key / unknown id / malformed value, ready for `jevcode.log` */
  readonly warnings: readonly string[];
}

/** TUI-DESIGN §3.4: the outcome of `loadKeybindings` — the parse plus where the file was looked for. */
export interface KeybindingsLoad extends KeybindingsParse {
  readonly path: string;
  /** false when the file does not exist (defaults apply silently) */
  readonly found: boolean;
  /** the effective table (defaults + overrides) */
  readonly bindings: Bindings;
}

/** TUI-DESIGN §16: `${XDG_CONFIG_HOME:-~/.config}/jevcode/keybindings.json` unless `--keybindings` / `JEVCODE_KEYBINDINGS` names another. */
export function keybindingsPath(env: NodeJS.ProcessEnv, flagPath?: string | null, home: string = homedir()): string {
  if (flagPath !== undefined && flagPath !== null && flagPath.trim() !== '') return flagPath;
  const fromEnv = env['JEVCODE_KEYBINDINGS'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv;
  const xdg = env['XDG_CONFIG_HOME'];
  const base = xdg !== undefined && xdg.trim() !== '' ? xdg : join(home, '.config');
  return join(base, 'jevcode', 'keybindings.json');
}

function keysOfValue(id: string, value: unknown, warnings: string[]): readonly string[] | null {
  if (value === null || value === 'none' || value === '' || (Array.isArray(value) && value.length === 0)) return [];
  const raw: unknown[] = Array.isArray(value) ? value : [value];
  const keys: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') {
      warnings.push(`keybindings: ${id}: expected a key string, an array of key strings, or "none"; got ${JSON.stringify(v)}`);
      return null;
    }
    if (v === 'none') continue;
    const canonical = normalizeKeyString(v);
    if (canonical === null) {
      warnings.push(`keybindings: ${id}: "${v}" is not a key (use e.g. "ctrl+g", "alt+b", "f1", "?", or a chord "ctrl+x ctrl+s")`);
      return null;
    }
    if (isReservedKey(canonical)) {
      warnings.push(`keybindings: ${id}: "${v}" is reserved (Ctrl+C, Ctrl+D, Enter/Ctrl+M, Esc/Ctrl+[, Tab/Ctrl+I are never rebindable); binding refused`);
      return null;
    }
    if (!keys.includes(canonical)) keys.push(canonical);
  }
  return keys;
}

/** TUI-DESIGN §3.4 `parseKeybindings` — pure over the file body; every problem is a warning, never a throw. */
export function parseKeybindings(text: string): KeybindingsParse {
  const warnings: string[] = [];
  const overrides = new Map<string, readonly string[]>();
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    warnings.push(`keybindings: not valid JSON (${e instanceof Error ? e.message : String(e)}); defaults kept`);
    return { overrides, warnings };
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    warnings.push('keybindings: expected a JSON object of "namespace:action": key; defaults kept');
    return { overrides, warnings };
  }
  for (const [id, value] of Object.entries(json as Record<string, unknown>)) {
    if (id.startsWith('$') || id.startsWith('//')) continue; // `$schema`, comments
    const spec = keyActionById(id);
    if (spec === null) {
      warnings.push(`keybindings: unknown action id "${id}" (ids are namespace:action, see docs/KEYS.md)`);
      continue;
    }
    if (spec.reserved) {
      warnings.push(spec.id === 'review:approve' ? `keybindings: ${id} is reserved and cannot be rebound (y is the only key that ever approves, §6.2)` : `keybindings: ${id} is reserved and cannot be rebound`);
      continue;
    }
    const keys = keysOfValue(id, value, warnings);
    if (keys === null) continue;
    overrides.set(id, keys);
  }
  return { overrides, warnings };
}

/** the fs surface the loader needs (injected by tests) */
export interface KeybindingsFs {
  readFileSync(path: string, encoding: 'utf8'): string;
  statSync(path: string): { size: number };
}

const REAL_FS: KeybindingsFs = {
  readFileSync: (p, enc) => readFileSync(p, enc),
  statSync: (p) => statSync(p),
};

/**
 * TUI-DESIGN §3.4 `loadKeybindings` — synchronous, ≤ 64 KiB, never throws: ENOENT means defaults,
 * EACCES/EISDIR/oversize produce one warning and the defaults. Meant for the tick after `firstFrame()`
 * (before Ink dispatches any key) and for `/help reload`.
 */
export function loadKeybindings(path: string, fs: KeybindingsFs = REAL_FS): KeybindingsLoad {
  const warnings: string[] = [];
  let text: string | null = null;
  try {
    const st = fs.statSync(path);
    if (st.size > KEYBINDINGS_MAX_BYTES) warnings.push(`keybindings: ${path} is ${st.size} bytes (limit ${KEYBINDINGS_MAX_BYTES}); ignored, defaults kept`);
    else text = fs.readFileSync(path, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { path, found: false, overrides: new Map(), warnings: [], bindings: buildBindings() };
    warnings.push(`keybindings: could not read ${path}: ${code ?? (e instanceof Error ? e.message : String(e))}; defaults kept`);
  }
  if (text === null) return { path, found: true, overrides: new Map(), warnings, bindings: buildBindings() };
  const parsed = parseKeybindings(text);
  const bindings = buildBindings(parsed.overrides);
  return { path, found: true, overrides: parsed.overrides, warnings: [...warnings, ...parsed.warnings, ...bindings.warnings], bindings };
}
