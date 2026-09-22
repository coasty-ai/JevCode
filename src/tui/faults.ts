/**
 * `JEVCODE_FAULT` — one typed parser, thirteen scenarios (TUI-DESIGN-4 §7.11; TD §19.6).
 *
 * Before round 4 the variable was matched by string in three places (`App.tsx`, `PaneBoundary.tsx`,
 * `Transcript.tsx`) and only `render:<pane>` / `render:<pane>:lines` existed, although TD §19.6 already *names*
 * `jev:429`, `jev:401` and `persist:ENOSPC` — so the pty rows that would gate the retry row, the auth pane and the
 * degraded pane were dead. This module is the single grammar: every consumer reads a typed field of the
 * discriminated union `Fault`, and an unknown value is **rejected loudly** (`faultEnvError`, written to stderr
 * before Ink mounts) so a typo'd fault in CI fails the test instead of silently passing.
 *
 * Dev-only and zero-import: it is reachable from the first-frame path, so it may never pull in Ink, the theme or
 * any I/O. `JEVCODE_ASSERT_HEIGHT=1` (§1.5) rides here as a field of `FaultEnv`, not as a fourteenth string.
 */

/**
 * The React boundaries a `render:<pane>` fault may name (TUI-DESIGN-4 §7.3's catalogue).
 *
 * Every `<PaneBoundary pane=…>` mounted anywhere in `src/tui/**` MUST appear here, or its fault string is a loud
 * rejection instead of the fault it names — `test/unit/tui/faults.test.ts` greps the tree and fails on an
 * unlisted name, the same shape as `round4-identity.test.ts`'s "fails on an unlisted command".
 */
export const FAULT_PANES: readonly string[] = [
  'live',
  'pane',
  'overlay',
  'composer',
  'status',
  'static',
  'transcript',
  'wordmark',
  'rule',
  'banner',
  'queue',
  // TUI-DESIGN-4 §1.3 (D-S): the fullscreen renderer's own boundary (`src/tui/fullscreen/ViewportBox.tsx`)
  'viewport',
];

/** The errno codes a `persist:` fault may inject (TUI-DESIGN-4 §7.11 row 3; the store's degraded set). */
export const PERSIST_FAULT_CODES = ['ENOSPC', 'EACCES', 'EROFS', 'ENOENT'] as const;
export type PersistFaultCode = (typeof PERSIST_FAULT_CODES)[number];

/** The transport failures a `net:` fault may inject (TUI-DESIGN-4 §7.11 row 7). */
export const NET_FAULT_CODES = ['ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET'] as const;
export type NetFaultCode = (typeof NET_FAULT_CODES)[number];

/** The shapes a `config:` fault may give the config file (TUI-DESIGN-4 §7.11 row 11). */
export const CONFIG_FAULT_KINDS = ['truncated', 'wrong-type', 'unreadable'] as const;
export type ConfigFaultKind = (typeof CONFIG_FAULT_KINDS)[number];

/** TUI-DESIGN-4 §7.11: the thirteen scenarios as one discriminated union. */
export type Fault =
  /** 1, 2 — `render:<pane>[:lines][:sticky]`: the pane (or its line builder) throws; `sticky` throws on **every** render */
  | { readonly kind: 'render'; readonly pane: string; readonly lines: boolean; readonly sticky: boolean }
  /** 3 — `persist:<CODE>[:after=<n>]`: the checkpoint store's write rejects with `CODE` from write `n` (1-based; 1 = the first) */
  | { readonly kind: 'persist'; readonly code: PersistFaultCode; readonly after: number }
  /** 4 — `rundir:rm[:after=<n>]`: the run directory is removed after step `n` */
  | { readonly kind: 'rundir'; readonly op: 'rm'; readonly after: number }
  /** 5 — `submit:hang`: `host.submit()` never settles */
  | { readonly kind: 'submit'; readonly mode: 'hang' }
  /** 6 — `jev:429[:<retryAfterSeconds>]` · `jev:401` · `jev:5xx:<n>`: the mock decider answers the status `count` times */
  | { readonly kind: 'jev'; readonly status: number; readonly retryAfterMs: number | null; readonly count: number }
  /** 7 — `net:ENOTFOUND` · `net:ETIMEDOUT` · `net:ECONNRESET:mid-stream`: the transport fails at DNS, at connect, mid-SSE */
  | { readonly kind: 'net'; readonly code: NetFaultCode; readonly midStream: boolean }
  /** 8 — `stdout:EPIPE[:after=<n>]`: `stdout.write` throws EPIPE after frame `n` */
  | { readonly kind: 'stdout'; readonly code: 'EPIPE'; readonly after: number }
  /** 9 — `clock:jump:<±s>[:at=<n>]`: the injected `now()` jumps `±s` seconds at frame/step `n` */
  | { readonly kind: 'clock'; readonly jumpMs: number; readonly at: number }
  /** 10 — `index:corrupt` · `index:huge:<n>`: the session-index fixture (`lines` is 0 for `corrupt`) */
  | { readonly kind: 'index'; readonly mode: 'corrupt' | 'huge'; readonly lines: number }
  /** 11 — `config:<kind>`: the config file is truncated / wrong-typed / unreadable */
  | { readonly kind: 'config'; readonly mode: ConfigFaultKind }
  /** 12 — `loop:hog:<ms>`: a synchronous busy-wait inside one event handler */
  | { readonly kind: 'loop'; readonly hogMs: number }
  /** 13 — `peer:<n>`: `n` fake peers in the registry snapshot */
  | { readonly kind: 'peer'; readonly count: number };

export type FaultKind = Fault['kind'];

/** The environment variable this module owns. */
export const FAULT_ENV_VAR = 'JEVCODE_FAULT';
/** TUI-DESIGN-4 §1.5: the development-only height assertion; a `FaultEnv` field, never a fault string. */
export const ASSERT_HEIGHT_ENV_VAR = 'JEVCODE_ASSERT_HEIGHT';

/** The grammar, one row per scenario — printed with the rejection so a typo names its own fix. */
export const FAULT_GRAMMAR: readonly string[] = [
  'render:<pane>[:lines][:sticky]  (pane: ' + FAULT_PANES.join(' | ') + ')',
  'persist:<ENOSPC|EACCES|EROFS|ENOENT>[:after=<n>]',
  'rundir:rm[:after=<n>]',
  'submit:hang',
  'jev:429[:<retry-after-seconds>] | jev:401 | jev:5xx:<n>',
  'net:ENOTFOUND | net:ETIMEDOUT | net:ECONNRESET[:mid-stream]',
  'stdout:EPIPE[:after=<n>]',
  'clock:jump:<±seconds>[:at=<n>]',
  'index:corrupt | index:huge:<n>',
  'config:<truncated|wrong-type|unreadable>',
  'loop:hog:<ms>',
  'peer:<n>',
];

/** A non-negative integer suffix (`after=12`, `at=3`, a bare `5`); null when the text is not one. */
function nonNegInt(text: string): number | null {
  if (!/^\d{1,9}$/.test(text)) return null;
  return Number.parseInt(text, 10);
}

/** A signed integer (`clock:jump:-30`); null when the text is not one. */
function signedInt(text: string): number | null {
  if (!/^[+-]?\d{1,9}$/.test(text)) return null;
  return Number.parseInt(text, 10);
}

/** `after=<n>` / `at=<n>`; returns null when the part is absent (caller's default) and `undefined` when malformed. */
function keyedInt(parts: readonly string[], key: string): number | null | undefined {
  if (parts.length === 0) return null;
  if (parts.length > 1) return undefined;
  const part = parts[0] ?? '';
  if (!part.startsWith(`${key}=`)) return undefined;
  const n = nonNegInt(part.slice(key.length + 1));
  return n === null ? undefined : n;
}

function parseRender(rest: readonly string[]): Fault | null {
  const pane = rest[0] ?? '';
  if (!FAULT_PANES.includes(pane)) return null;
  const tail = rest.slice(1);
  let lines = false;
  let sticky = false;
  for (const t of tail) {
    if (t === 'lines' && !lines) lines = true;
    else if (t === 'sticky' && !sticky) sticky = true;
    else return null;
  }
  return { kind: 'render', pane, lines, sticky };
}

function parsePersist(rest: readonly string[]): Fault | null {
  const code = rest[0] ?? '';
  if (!(PERSIST_FAULT_CODES as readonly string[]).includes(code)) return null;
  const after = keyedInt(rest.slice(1), 'after');
  if (after === undefined) return null;
  return { kind: 'persist', code: code as PersistFaultCode, after: after ?? 1 };
}

function parseJev(rest: readonly string[]): Fault | null {
  const head = rest[0] ?? '';
  if (head === '401') {
    if (rest.length !== 1) return null;
    return { kind: 'jev', status: 401, retryAfterMs: null, count: 1 };
  }
  if (head === '429') {
    if (rest.length === 1) return { kind: 'jev', status: 429, retryAfterMs: null, count: 1 };
    if (rest.length !== 2) return null;
    const secs = nonNegInt(rest[1] ?? '');
    if (secs === null) return null;
    return { kind: 'jev', status: 429, retryAfterMs: secs * 1000, count: 1 };
  }
  if (head === '5xx') {
    if (rest.length !== 2) return null;
    const n = nonNegInt(rest[1] ?? '');
    if (n === null || n < 1) return null;
    return { kind: 'jev', status: 500, retryAfterMs: null, count: n };
  }
  return null;
}

function parseNet(rest: readonly string[]): Fault | null {
  const code = rest[0] ?? '';
  if (!(NET_FAULT_CODES as readonly string[]).includes(code)) return null;
  if (rest.length === 1) return { kind: 'net', code: code as NetFaultCode, midStream: false };
  if (rest.length === 2 && rest[1] === 'mid-stream') return { kind: 'net', code: code as NetFaultCode, midStream: true };
  return null;
}

/**
 * TUI-DESIGN-4 §7.11: parse one `JEVCODE_FAULT` value into the typed union. `null` means "not a fault this build
 * understands" — an absent, empty or unknown value. The caller distinguishes the two with `faultEnvError`.
 */
export function parseFault(value: string | undefined | null): Fault | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0 || text.length > 128) return null;
  const parts = text.split(':');
  const head = parts[0] ?? '';
  const rest = parts.slice(1);
  switch (head) {
    case 'render':
      return parseRender(rest);
    case 'persist':
      return parsePersist(rest);
    case 'rundir': {
      if (rest[0] !== 'rm') return null;
      const after = keyedInt(rest.slice(1), 'after');
      if (after === undefined) return null;
      return { kind: 'rundir', op: 'rm', after: after ?? 1 };
    }
    case 'submit':
      return rest.length === 1 && rest[0] === 'hang' ? { kind: 'submit', mode: 'hang' } : null;
    case 'jev':
      return parseJev(rest);
    case 'net':
      return parseNet(rest);
    case 'stdout': {
      if (rest[0] !== 'EPIPE') return null;
      const after = keyedInt(rest.slice(1), 'after');
      if (after === undefined) return null;
      return { kind: 'stdout', code: 'EPIPE', after: after ?? 1 };
    }
    case 'clock': {
      if (rest[0] !== 'jump') return null;
      const secs = signedInt(rest[1] ?? '');
      if (secs === null) return null;
      const at = keyedInt(rest.slice(2), 'at');
      if (at === undefined) return null;
      return { kind: 'clock', jumpMs: secs * 1000, at: at ?? 0 };
    }
    case 'index': {
      if (rest[0] === 'corrupt') return rest.length === 1 ? { kind: 'index', mode: 'corrupt', lines: 0 } : null;
      if (rest[0] === 'huge' && rest.length === 2) {
        const n = nonNegInt(rest[1] ?? '');
        return n === null || n < 1 ? null : { kind: 'index', mode: 'huge', lines: n };
      }
      return null;
    }
    case 'config': {
      const mode = rest[0] ?? '';
      if (rest.length !== 1 || !(CONFIG_FAULT_KINDS as readonly string[]).includes(mode)) return null;
      return { kind: 'config', mode: mode as ConfigFaultKind };
    }
    case 'loop': {
      if (rest[0] !== 'hog' || rest.length !== 2) return null;
      const ms = nonNegInt(rest[1] ?? '');
      return ms === null ? null : { kind: 'loop', hogMs: ms };
    }
    case 'peer': {
      if (rest.length !== 1) return null;
      const n = nonNegInt(rest[0] ?? '');
      return n === null ? null : { kind: 'peer', count: n };
    }
    default:
      return null;
  }
}

/** The fault string a `render:<pane>` fault renders back to (round-trips `parseFault`; the `fault` prop of a boundary). */
export function faultToString(f: Fault): string {
  switch (f.kind) {
    case 'render':
      return `render:${f.pane}${f.lines ? ':lines' : ''}${f.sticky ? ':sticky' : ''}`;
    case 'persist':
      return `persist:${f.code}:after=${f.after}`;
    case 'rundir':
      return `rundir:rm:after=${f.after}`;
    case 'submit':
      return 'submit:hang';
    case 'jev':
      return f.status === 429 && f.retryAfterMs !== null ? `jev:429:${Math.round(f.retryAfterMs / 1000)}` : f.status >= 500 ? `jev:5xx:${f.count}` : `jev:${f.status}`;
    case 'net':
      return `net:${f.code}${f.midStream ? ':mid-stream' : ''}`;
    case 'stdout':
      return `stdout:EPIPE:after=${f.after}`;
    case 'clock':
      return `clock:jump:${f.jumpMs >= 0 ? '+' : ''}${Math.round(f.jumpMs / 1000)}:at=${f.at}`;
    case 'index':
      return f.mode === 'corrupt' ? 'index:corrupt' : `index:huge:${f.lines}`;
    case 'config':
      return `config:${f.mode}`;
    case 'loop':
      return `loop:hog:${f.hogMs}`;
    case 'peer':
      return `peer:${f.count}`;
  }
}

/** The `JEVCODE_FAULT` value that makes `pane` throw once (TD §13.4, §19.6) — the string form every boundary matches. */
export function renderFaultString(pane: string, opts: { lines?: boolean; sticky?: boolean } = {}): string {
  return faultToString({ kind: 'render', pane, lines: opts.lines === true, sticky: opts.sticky === true });
}

/**
 * TUI-DESIGN-4 §7.11: how a `render:` fault applies to `pane` — `null` when this fault is not about this pane,
 * `'once'` when it should throw one time (the boundary latches), `'sticky'` when it must throw on every render.
 * `lines` selects the line-builder variant (`render:<pane>:lines`), which the item renderer reads.
 */
export function renderFaultMode(fault: Fault | null, pane: string, opts: { lines?: boolean } = {}): 'once' | 'sticky' | null {
  if (fault === null || fault.kind !== 'render' || fault.pane !== pane) return null;
  if (fault.lines !== (opts.lines === true)) return null;
  return fault.sticky ? 'sticky' : 'once';
}

export interface FaultEnv {
  /** the parsed `JEVCODE_FAULT`, or null when unset */
  readonly fault: Fault | null;
  /** TUI-DESIGN-4 §1.5: `JEVCODE_ASSERT_HEIGHT=1` — a frame taller than the terminal throws in development */
  readonly assertHeight: boolean;
  /** the loud rejection: a non-empty `JEVCODE_FAULT` this build does not understand (never a silent pass) */
  readonly error: string | null;
}

/** The rejection text for an unparseable `JEVCODE_FAULT` — the value, then the grammar, one row per scenario. */
export function faultEnvError(value: string): string {
  const shown = value.length > 96 ? `${value.slice(0, 95)}…` : value;
  return [`jevcode: ${FAULT_ENV_VAR}=${shown} is not a fault this build understands. Supported:`, ...FAULT_GRAMMAR.map((g) => `  ${g}`)].join('\n');
}

/**
 * TUI-DESIGN-4 §7.11: read both development variables from an environment. The caller writes `error` to **stderr
 * and exits before Ink mounts** — a typo'd fault in CI must fail the test, not silently measure the unfaulted frame.
 */
export function readFaultEnv(env: NodeJS.ProcessEnv): FaultEnv {
  const raw = env[FAULT_ENV_VAR];
  const assertHeight = env[ASSERT_HEIGHT_ENV_VAR] === '1';
  if (typeof raw !== 'string' || raw.trim().length === 0) return { fault: null, assertHeight, error: null };
  const fault = parseFault(raw);
  return fault === null ? { fault: null, assertHeight, error: faultEnvError(raw.trim()) } : { fault, assertHeight, error: null };
}
