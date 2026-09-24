/**
 * `/copy` (TUI-DESIGN §10.5, A86, C12). The payload is `redact(sanitizeStream(text))` capped at
 * 64 KiB; a native tool is tried first (`pbcopy`, `wl-copy`, `xclip -selection clipboard`,
 * `xsel --clipboard --input`, 2 s each), then an OSC 52 **write** — only behind
 * `--osc52`/`ui.osc52`, wrapped in tmux's DCS passthrough with doubled ESC when `TMUX` is set.
 * OSC 52 is never read (`\x1b]52;c;?`): the payload is base64-encoded, so a `?` inside it can never
 * form a read request. Worst case with every tool installed but hanging: 4 × 2 s = 8 s before the
 * OSC 52 fallback or the failure toast. `spawn` and the writer are injectable for tests.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { clipBytes } from '../../core/text.js';
import { sanitizeStream } from '../plain.js';

/** TUI-DESIGN §10.5: payload cap. */
export const CLIPBOARD_MAX_BYTES = 64 * 1024;
/** TUI-DESIGN §10.5: per-tool timeout. */
export const CLIPBOARD_TOOL_TIMEOUT_MS = 2000;

/** TUI-DESIGN §10.5: native tools in order. */
export const CLIPBOARD_TOOLS: readonly { name: ClipboardMethod; cmd: string; args: readonly string[] }[] = [
  { name: 'pbcopy', cmd: 'pbcopy', args: [] },
  { name: 'wl-copy', cmd: 'wl-copy', args: [] },
  { name: 'xclip', cmd: 'xclip', args: ['-selection', 'clipboard'] },
  { name: 'xsel', cmd: 'xsel', args: ['--clipboard', '--input'] },
];

/** TUI-DESIGN §10.5: how the payload reached the clipboard. */
export type ClipboardMethod = 'pbcopy' | 'wl-copy' | 'xclip' | 'xsel' | 'osc52' | 'none';

/** The slice of `child_process.ChildProcess` the copier needs; tests inject a fake. */
export interface ChildLike {
  stdin: { write(chunk: string): unknown; end(): void; on(event: 'error', fn: (e: Error) => void): unknown } | null;
  /** `'exit'` delivers the exit code (or null when killed); `'error'` the spawn error */
  on(event: 'exit' | 'error', fn: (arg: number | null | Error) => void): unknown;
  kill(): unknown;
}
/** TUI-DESIGN §10.5: injectable spawn (`child_process.spawn` shape reduced to what the copier uses). */
export type SpawnLike = (cmd: string, args: readonly string[]) => ChildLike;

/** TUI-DESIGN §10.5: `copyRedacted` seams. */
export interface ClipboardDeps {
  spawn?: SpawnLike;
  /** OSC 52 writer (the terminal's stdout); required for the fallback to be attempted */
  write?: (s: string) => void;
  /** `--osc52` / `ui.osc52` (default false: never emit OSC 52 unasked) */
  osc52?: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** restrict the native tools tried (default: all four in order) */
  tools?: readonly ClipboardMethod[];
}

/** TUI-DESIGN §10.5: what `/copy` reports. */
export interface CopyResult {
  ok: boolean;
  method: ClipboardMethod;
  /** bytes handed to the clipboard */
  bytes: number;
  /** redaction markers the payload gained (the `/copy draft` count) */
  masked: number;
  truncated: boolean;
  /** §24: `copied` · `copied with N secret(s) masked` · the failure toast */
  toast: string;
}

/** §24 failure toast when no tool works and OSC 52 is off (a new string: the glossary names only the successes). */
export const COPY_FAILED_TOAST = 'copy failed: no clipboard tool found (pbcopy, wl-copy, xclip, xsel); pass --osc52 to use the terminal';

const MARKER_RE = /\[REDACTED:[^\]]*\]/g;

function countMarkers(s: string): number {
  let n = 0;
  MARKER_RE.lastIndex = 0;
  while (MARKER_RE.exec(s) !== null) n++;
  return n;
}

/**
 * TUI-DESIGN §10.5: `redact(sanitizeStream(text))` clipped to 64 KiB; pure. Returns the payload and
 * how many markers redaction added. A cut that lands inside a `[REDACTED:…]` marker moves back to
 * the marker's start, so the payload never ends in a half marker.
 */
export function clipboardPayload(text: string, redact: (s: string) => string): { payload: string; masked: number; truncated: boolean } {
  const clean = sanitizeStream(String(text));
  const redacted = redact(clean);
  const masked = Math.max(0, countMarkers(redacted) - countMarkers(clean));
  const cut = clipBytes(redacted, CLIPBOARD_MAX_BYTES);
  let payload = cut.text;
  if (cut.truncatedBytes > 0) {
    const open = payload.lastIndexOf('[REDACTED:');
    if (open !== -1 && payload.indexOf(']', open) === -1) payload = payload.slice(0, open);
  }
  return { payload, masked, truncated: cut.truncatedBytes > 0 };
}

/** TUI-DESIGN §10.5: `\x1b]52;c;<base64>\x07`, inside tmux wrapped as `\x1bPtmux;` + (ESC doubled) + `\x1b\\`. Never a `?` read. Pure. */
export function osc52Sequence(payload: string, tmux: boolean): string {
  const b64 = Buffer.from(payload, 'utf8').toString('base64');
  const seq = `\x1b]52;c;${b64}\x07`;
  return tmux ? `\x1bPtmux;${seq.replace(/\x1b/g, '\x1b\x1b')}\x1b\\` : seq;
}

/** §24: `copied` or `copied with N secret(s) masked`. */
export function copiedToast(masked: number): string {
  if (masked <= 0) return 'copied';
  return `copied with ${masked} ${masked === 1 ? 'secret' : 'secrets'} masked`;
}

function defaultSpawn(cmd: string, args: readonly string[]): ChildLike {
  const child = nodeSpawn(cmd, [...args], { stdio: ['pipe', 'ignore', 'ignore'] });
  return {
    stdin: child.stdin,
    on: (event, fn) => child.on(event, fn),
    kill: () => child.kill(),
  };
}

/** Run one tool with the payload on stdin; resolves true on exit 0 within the timeout, false otherwise (ENOENT, non-zero, timeout, stdin error). */
export function pipeToTool(spawn: SpawnLike, cmd: string, args: readonly string[], payload: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(ok);
    };
    let child: ChildLike;
    try {
      child = spawn(cmd, args);
    } catch {
      finish(false);
      return;
    }
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish(false);
    }, Math.max(1, timeoutMs));
    timer.unref?.();
    child.on('error', () => finish(false));
    child.on('exit', (code) => finish(code === 0));
    if (!child.stdin) {
      finish(false);
      return;
    }
    child.stdin.on('error', () => finish(false));
    try {
      child.stdin.write(payload);
      child.stdin.end();
    } catch {
      finish(false);
    }
  });
}

/**
 * TUI-DESIGN §10.5: copy `text` redacted. Native tool first (in `CLIPBOARD_TOOLS` order, 2 s
 * each), then OSC 52 write when `deps.osc52` and a writer exist; never OSC 52 read.
 */
export async function copyRedacted(text: string, redact: (s: string) => string, deps: ClipboardDeps = {}): Promise<CopyResult> {
  const { payload, masked, truncated } = clipboardPayload(text, redact);
  const bytes = Buffer.byteLength(payload, 'utf8');
  const spawn = deps.spawn ?? defaultSpawn;
  const timeoutMs = deps.timeoutMs ?? CLIPBOARD_TOOL_TIMEOUT_MS;
  const wanted = deps.tools ?? CLIPBOARD_TOOLS.map((t) => t.name);
  for (const tool of CLIPBOARD_TOOLS) {
    if (!wanted.includes(tool.name)) continue;
    if (await pipeToTool(spawn, tool.cmd, tool.args, payload, timeoutMs)) {
      return { ok: true, method: tool.name, bytes, masked, truncated, toast: copiedToast(masked) };
    }
  }
  if (deps.osc52 === true && deps.write) {
    const env = deps.env ?? {};
    const tmux = typeof env['TMUX'] === 'string' && env['TMUX'] !== '';
    deps.write(osc52Sequence(payload, tmux));
    return { ok: true, method: 'osc52', bytes, masked, truncated, toast: copiedToast(masked) };
  }
  return { ok: false, method: 'none', bytes, masked, truncated, toast: COPY_FAILED_TOAST };
}
