/**
 * Wire types for the warm lane runner (docs/HARNESS-NEXT-DESIGN.md §3 M6, wave S1) and the
 * command → request mapping that decides whether a lane command can be served warm at all.
 *
 * The rule the rest of the plane rests on: a command is servable only when it is *exactly* the
 * shape the warm server reproduces. Anything with shell control characters, a redirection, a
 * pipe, an unknown interpreter or an unknown environment assignment is refused here and runs
 * cold — refusing is free, serving something we mis-parsed is not.
 */
import { isFiniteNumber, isJsonObject, isString, parseJson } from '../../core/json.js';
import { shellWords } from '../search/budget.js';
import { CASE_TIMEOUT_ENV, MAX_CASE_TIMEOUTS_ENV } from '../verify/quixbugs.js';

/** The two lane shapes the warm server implements; everything else stays on the cold path. */
export type WarmMode = 'quixbugs' | 'pytest';

export interface WarmQuixbugsRequest {
  kind: 'quixbugs';
  /** directory holding run_tests.py (absolute) */
  dir: string;
  name: string;
  /** the candidate file inside the lane (absolute) */
  path: string;
  /** per-case limit in seconds; run_tests.py's own default when absent */
  timeout?: number;
  slow?: boolean;
  maxFailures?: number;
}

export interface WarmPytestRequest {
  kind: 'pytest';
  /** argv after `-m pytest`, verbatim */
  args: readonly string[];
}

export type WarmRunRequest = WarmQuixbugsRequest | WarmPytestRequest;

/** `VerifyRunResult`-shaped, so `summarize()` parses a warm run exactly as it parses a cold one. */
export interface WarmRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

export type WarmResponse =
  | { kind: 'ok'; id: number; result: WarmRunResult }
  | { kind: 'ready'; id: number }
  /** the warm parent found a workspace module in its own import set: restart, run this candidate cold */
  | { kind: 'invalidate'; id: number; path: string }
  | { kind: 'error'; id: number; message: string };

/** Environment keys the lane sets per run; the warm child sets exactly these and unsets the rest. */
export const WARM_ENV_KEYS: readonly string[] = [CASE_TIMEOUT_ENV, MAX_CASE_TIMEOUTS_ENV];

/**
 * Characters that make a command more than one program: a warm request replays an argv, not a
 * shell line, so a command carrying any of them is never servable. The lane commands built by
 * `quixbugsTestCommand` and `laneSubsetCommand` contain none (paths are single-quoted).
 */
const SHELL_CONTROL = /[;|&<>`$()\n\r*?[\]{}~!#]/;

/** Leading `NAME=value` assignments of a command, and the index of the first real word. */
function splitAssignments(words: readonly string[]): { env: Record<string, string>; at: number } {
  const env: Record<string, string> = {};
  let at = 0;
  while (at < words.length) {
    const w = words[at] ?? '';
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(w);
    if (m === null) break;
    env[m[1] ?? ''] = m[2] ?? '';
    at += 1;
  }
  return { env, at };
}

function isPythonWord(w: string): boolean {
  const base = w.slice(w.lastIndexOf('/') + 1);
  return /^python[0-9.]*$/.test(base);
}

/**
 * `PYTHONDONTWRITEBYTECODE=1 python3 <dir>/run_tests.py <name> <candidate> [--max-failures N]
 * [--timeout S] [--slow]` → a warm request. Null when the command is anything else, carries an
 * unknown flag, or names a per-case limit the server would not reproduce.
 */
export function quixbugsRequestFor(command: string): WarmQuixbugsRequest | null {
  if (SHELL_CONTROL.test(command)) return null;
  const words = shellWords(command);
  const { at } = splitAssignments(words);
  if (!isPythonWord(words[at] ?? '')) return null;
  const script = words[at + 1] ?? '';
  if (!/(^|\/)run_tests\.py$/.test(script)) return null;
  const name = words[at + 2];
  const path = words[at + 3];
  if (name === undefined || path === undefined || name.startsWith('-') || path.startsWith('-')) return null;
  const slash = script.lastIndexOf('/');
  const req: WarmQuixbugsRequest = { kind: 'quixbugs', dir: slash === -1 ? '.' : script.slice(0, slash), name, path };
  for (let i = at + 4; i < words.length; i++) {
    const w = words[i] ?? '';
    if (w === '--slow') {
      req.slow = true;
      continue;
    }
    if (w === '--max-failures') {
      const n = Number(words[i + 1]);
      if (!Number.isFinite(n)) return null;
      req.maxFailures = n;
      i += 1;
      continue;
    }
    if (w === '--timeout') {
      const raw = words[i + 1] ?? '';
      const sec = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : /^(\d+(\.\d+)?)s$/.test(raw) ? Number(raw.slice(0, -1)) : /^(\d+(\.\d+)?)ms$/.test(raw) ? Number(raw.slice(0, -2)) / 1000 : NaN;
      if (!Number.isFinite(sec) || sec <= 0) return null;
      req.timeout = sec;
      i += 1;
      continue;
    }
    // an unrecognised flag (--jobs, --timeout-ms, anything future) is a reason to stay cold
    return null;
  }
  return req;
}

/** `[VAR=v …] python[3] -m pytest <args…>` or `pytest <args…>` → a warm request; null otherwise. */
export function pytestRequestFor(command: string): WarmPytestRequest | null {
  if (SHELL_CONTROL.test(command)) return null;
  const words = shellWords(command);
  const { at } = splitAssignments(words);
  const head = words[at] ?? '';
  let argsAt: number;
  if (isPythonWord(head)) {
    if (words[at + 1] !== '-m' || words[at + 2] !== 'pytest') return null;
    argsAt = at + 3;
  } else if (/(^|\/)(pytest|py\.test)$/.test(head)) {
    argsAt = at + 1;
  } else {
    return null;
  }
  return { kind: 'pytest', args: words.slice(argsAt) };
}

/** The warm request a lane command maps to under `mode`, or null when it must run cold. */
export function requestFor(mode: WarmMode, command: string): WarmRunRequest | null {
  return mode === 'quixbugs' ? quixbugsRequestFor(command) : pytestRequestFor(command);
}

/** Parse one response line. Anything unexpected is an `error` response, never a silent pass. */
export function parseResponse(line: string): WarmResponse {
  const parsed = parseJson(line);
  if (!parsed.ok || !isJsonObject(parsed.value)) return { kind: 'error', id: -1, message: `malformed response: ${line.slice(0, 200)}` };
  const o = parsed.value;
  const idRaw = o['id'];
  const id = isFiniteNumber(idRaw) ? idRaw : -1;
  const inv = o['invalidate'];
  if (isString(inv)) return { kind: 'invalidate', id, path: inv };
  if (o['ok'] !== true) {
    const message = isString(o['error']) ? o['error'] : 'warm worker refused the request';
    return { kind: 'error', id, message };
  }
  const stdout = o['stdout'];
  if (!isString(stdout)) return { kind: 'ready', id };
  const exit = o['exit'];
  return {
    kind: 'ok',
    id,
    result: {
      stdout,
      stderr: isString(o['stderr']) ? o['stderr'] : '',
      exitCode: isFiniteNumber(exit) ? exit : null,
      timedOut: o['timedOut'] === true,
      durationMs: isFiniteNumber(o['ms']) ? o['ms'] : 0,
    },
  };
}
