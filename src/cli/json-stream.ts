/**
 * The `--json` NDJSON stream (TUI-DESIGN §8.9; A61, A138, A158, A170). One line per event on stdout:
 * the first is the envelope `{"v":1,"type":"stream:start","schema":"jevcode.events/1","jevcode":"<version>","t":iso}`;
 * every further line is `{ "v": 1, "t": iso, "runId", "sessionId", ...EngineEvent }` — the redacted `EngineEvent`
 * exactly as the engine emitted it (its `emit()` runs `redactDeep`, so configured secrets, `Send anyway`-confirmed
 * values and recognised formats are already `[REDACTED:…]`) — plus the controller lines that involve no engine:
 * `session:start`, `session:end`, `session:budget`, `session:refused` and `ui` (idle-time renderer-local items).
 * `status` events ride the stream only with `--json=verbose`. `run:end` carries `exitCode`, `resumable`, `paths`.
 *
 * Consumer contract (documented in `--help` and DESIGN §10): **consumers ignore unknown `type`s**; `v` increments
 * only on an incompatible change; additive fields never bump it. The stream never contains keystrokes, composer
 * drafts, pasted payloads or key material; a human turn is the `run:start` task line and the `steer:queued` lines
 * holding the redacted submitted text; `secret-ack` carries a count only (P59). No countdown ticks (`retry` carries
 * `waitMs`). Every line is one `JSON.stringify` — a value that cannot be serialised becomes a `stream:error` line
 * (a type consumers ignore) rather than an exception inside the engine's listener.
 */
import type { Confirmer, Engine, EngineEvent, IntakeKind, JevProvider, Renderer, RendererOptions, SessionHost, UiConfig, UiLabel } from '../core/types.js';
import type { ChatRoute } from '../chat/intake.js';

export const JSON_STREAM_VERSION = 1 as const;
export const JSON_STREAM_SCHEMA = 'jevcode.events/1';

/** TUI-DESIGN §8.9: the identity every line after the envelope carries. */
export interface JsonStreamContext {
  runId: string | null;
  sessionId: string | null;
}

interface LineHead extends JsonStreamContext {
  v: typeof JSON_STREAM_VERSION;
  t: string;
}

/** `Omit` that keeps a discriminated union's members apart (the built-in one collapses them to their common keys). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type JsonStreamStart = { v: typeof JSON_STREAM_VERSION; type: 'stream:start'; schema: typeof JSON_STREAM_SCHEMA; jevcode: string; t: string };
/** `{ v, t, runId, sessionId, ...EngineEvent }`: an event's own `runId`/`sessionId` (run:start, run:ready) win over the context's. */
export type JsonEventLine = LineHead & DistributiveOmit<EngineEvent, 'v' | 't' | 'runId' | 'sessionId'>;
export type JsonSessionStart = LineHead & { type: 'session:start'; workspace: string; parentRunId: string | null };
export type JsonSessionEnd = LineHead & { type: 'session:end'; reason: 'exit' | 'error'; runs: number; exitCode: number };
/** a `/budget` change while idle (§9.4): `appliesTo` `now` for the session cap, `next` for the run-scoped pending values */
export type JsonSessionBudget = LineHead & { type: 'session:budget'; setting: string; from: string; to: string; appliesTo: 'now' | 'next' };
export type JsonSessionRefused = LineHead & { type: 'session:refused'; reason: 'session-cap' | 'unpriced' | 'secret'; spentUsd?: number; capUsd?: number; exitCode: number };
/** an idle-time renderer-local item (§15.1); while a run is live the same line is a `notice { kind: 'ui' }` engine event */
export type JsonUiLine = LineHead & { type: 'ui'; text: string; label: UiLabel; level: 'info' | 'warn' | 'error' };
/**
 * TUI-DESIGN-2 §3.8 / §3.10 / §6 item 17: one line per chat request — the intake (`route` = what the reading decided:
 * `run` · `asked` · `reply` · `facts` · `lookup` · `llm`), then a second line for the lookup or LLM request it led to
 * (`provider` `'generator'` for the LLM turn). Never the message; `requestHash` is the client's hash of the request.
 */
export type JsonChatLine = LineHead & { type: 'chat'; intake: IntakeKind; probability: number; route: ChatRoute; provider: JevProvider | 'generator'; costUsd: number; latencyMs: number; requestHash: string };
export type JsonStreamError = LineHead & { type: 'stream:error'; message: string; eventType: string | null };
export type JsonControllerLine = JsonSessionStart | JsonSessionEnd | JsonSessionBudget | JsonSessionRefused | JsonUiLine | JsonChatLine;
export type JsonStreamLine = JsonStreamStart | JsonEventLine | JsonControllerLine | JsonStreamError;

/** Event types that ride the stream only with `--json=verbose` (§8.9: "status events only with --json=verbose"). */
export const VERBOSE_ONLY_TYPES: ReadonlySet<EngineEvent['type']> = new Set<EngineEvent['type']>(['status']);

export interface JsonStreamOptions {
  out: { write(chunk: string): unknown };
  /** the jevcode version for the envelope (`src/version.ts` VERSION) */
  version: string;
  /** `--json=verbose`: `status` events too */
  verbose?: boolean;
  /**
   * TUI-DESIGN §8.9 redaction guarantee: engine events arrive redacted by the engine's `emit()` (`redactDeep`), while
   * every controller-line string (`session:start.workspace`, `session:budget.from/to`, `ui.text`) passes this function
   * — the session `config.redact`. Required, so no caller can forget it (the epilogue and `[ui] error:` texts quote user input).
   */
  redact: (s: string) => string;
  /** ISO clock, injected for deterministic tests */
  now?: () => string;
}

export interface JsonStream {
  /** write the `stream:start` envelope once (later calls are no-ops) */
  start(): void;
  /** one engine event; false when it was dropped (`status` without `--json=verbose`) */
  event(e: EngineEvent, ctx: JsonStreamContext): boolean;
  sessionStart(o: { sessionId: string; runId: string | null; parentRunId: string | null; workspace: string }): void;
  sessionEnd(o: { reason: 'exit' | 'error'; runs: number; exitCode: number }, ctx: JsonStreamContext): void;
  sessionBudget(o: { setting: string; from: string; to: string; appliesTo: 'now' | 'next' }, ctx: JsonStreamContext): void;
  sessionRefused(o: { reason: 'session-cap' | 'unpriced' | 'secret'; spentUsd?: number; capUsd?: number; exitCode: number }, ctx: JsonStreamContext): void;
  ui(text: string, o: { label?: UiLabel; level?: 'info' | 'warn' | 'error' }, ctx: JsonStreamContext): void;
  /** TUI-DESIGN-2 §6 item 17: one `chat` line per chat request (intake · lookup · LLM turn) */
  chat(o: { intake: IntakeKind; probability: number; route: ChatRoute; provider: JevProvider | 'generator'; costUsd: number; latencyMs: number; requestHash: string }, ctx: JsonStreamContext): void;
  /** lines written so far, envelope included */
  readonly lines: number;
  readonly started: boolean;
}

/** TUI-DESIGN §8.9: one NDJSON line; never throws — a non-serialisable value yields a `stream:error` line consumers ignore. */
export function serializeLine(line: JsonStreamLine): string {
  try {
    return `${JSON.stringify(line)}\n`;
  } catch (e) {
    const head: LineHead = { v: JSON_STREAM_VERSION, t: 't' in line ? line.t : '', runId: 'runId' in line ? line.runId : null, sessionId: 'sessionId' in line ? line.sessionId : null };
    const fallback: JsonStreamError = { ...head, type: 'stream:error', message: e instanceof Error ? e.message : String(e), eventType: typeof line.type === 'string' ? line.type : null };
    return `${JSON.stringify(fallback)}\n`;
  }
}

/** TUI-DESIGN §8.9 `writeJsonStream` — the writer behind `--json`; pure over its `out` sink. */
export function writeJsonStream(opts: JsonStreamOptions): JsonStream {
  const now = opts.now ?? ((): string => new Date().toISOString());
  const redact = opts.redact;
  const verbose = opts.verbose === true;
  let lines = 0;
  let started = false;

  const emit = (line: JsonStreamLine): void => {
    opts.out.write(serializeLine(line));
    lines += 1;
  };
  const head = (ctx: JsonStreamContext): LineHead => ({ v: JSON_STREAM_VERSION, t: now(), runId: ctx.runId, sessionId: ctx.sessionId });

  return {
    start() {
      if (started) return;
      started = true;
      emit({ v: JSON_STREAM_VERSION, type: 'stream:start', schema: JSON_STREAM_SCHEMA, jevcode: opts.version, t: now() });
    },
    event(e, ctx) {
      if (!verbose && VERBOSE_ONLY_TYPES.has(e.type)) return false;
      // the event's own identity fields (run:start.runId, run:ready.sessionId) are authoritative; the context fills the rest
      const runId = 'runId' in e && typeof e.runId === 'string' ? e.runId : ctx.runId;
      const sessionId = 'sessionId' in e && typeof e.sessionId === 'string' ? e.sessionId : ctx.sessionId;
      emit({ ...head({ runId, sessionId }), ...e, runId, sessionId });
      return true;
    },
    sessionStart(o) {
      emit({ ...head({ runId: o.runId, sessionId: o.sessionId }), type: 'session:start', workspace: redact(o.workspace), parentRunId: o.parentRunId });
    },
    sessionEnd(o, ctx) {
      emit({ ...head(ctx), type: 'session:end', reason: o.reason, runs: o.runs, exitCode: o.exitCode });
    },
    sessionBudget(o, ctx) {
      emit({ ...head(ctx), type: 'session:budget', setting: o.setting, from: redact(o.from), to: redact(o.to), appliesTo: o.appliesTo });
    },
    sessionRefused(o, ctx) {
      emit({
        ...head(ctx),
        type: 'session:refused',
        reason: o.reason,
        ...(o.spentUsd !== undefined ? { spentUsd: o.spentUsd } : {}),
        ...(o.capUsd !== undefined ? { capUsd: o.capUsd } : {}),
        exitCode: o.exitCode,
      });
    },
    ui(text, o, ctx) {
      emit({ ...head(ctx), type: 'ui', text: redact(text), label: o.label ?? '[ui]', level: o.level ?? 'info' });
    },
    chat(o, ctx) {
      // the request hash is the client's (redacted before it reaches the controller); every other field is a number or an enum
      emit({ ...head(ctx), type: 'chat', intake: o.intake, probability: o.probability, route: o.route, provider: o.provider, costUsd: o.costUsd, latencyMs: o.latencyMs, requestHash: redact(o.requestHash) });
    },
    get lines() {
      return lines;
    },
    get started() {
      return started;
    },
  };
}

/** TUI-DESIGN §1 / §8.9: the `--json` renderer's confirmer identity (C46: every prompt takes its safe default — decline). */
export const IDENTITY_JSON = 'no reviewer (--json)';

/** A confirmer that declines at once and writes nothing (the stream is the only stdout writer). */
export function createSilentDecliner(identity = IDENTITY_JSON): Confirmer {
  return {
    identity,
    confirm: () => Promise.resolve(false),
    confirmDetailed: () => Promise.resolve({ approved: false }),
  };
}

export interface JsonRendererOptions extends RendererOptions {
  stream: JsonStream;
  /** the session id the lines carry before/after a run (`run:ready.sessionId` refreshes it while attached) */
  sessionId?: string | null;
}

export interface JsonRenderer extends Renderer {
  setHost(host: SessionHost): void;
  setUi(ui: UiConfig): void;
  notify(text: string, opts?: { level?: 'info' | 'warn' | 'error'; detail?: string; label?: UiLabel }): void;
  /** the current line identity (tests) */
  readonly context: JsonStreamContext;
}

/**
 * TUI-DESIGN §1 / §8.9: the renderer behind `--json` — non-interactive, no composer, no readline; `firstFrame()`
 * writes the envelope; `attach()` forwards every engine event; `notify()` writes idle-time `ui` lines. The
 * confirmer declines silently (no text may interleave with the stream).
 */
export function createJsonRenderer(opts: JsonRendererOptions): JsonRenderer {
  const { stream } = opts;
  const ctx: JsonStreamContext = { runId: null, sessionId: opts.sessionId ?? null };
  let detach: (() => void) | null = null;
  let ui: UiConfig | null = null;
  void ui;
  const firstFrame = Promise.resolve().then(() => stream.start());

  return {
    confirmer: createSilentDecliner(),
    get context() {
      return { ...ctx };
    },
    attach(engine: Engine) {
      detach?.();
      ctx.runId = engine.runId;
      detach = engine.events.onAny((e) => {
        if (e.type === 'run:ready' && e.sessionId !== undefined) ctx.sessionId = e.sessionId;
        stream.event(e, ctx);
      });
    },
    firstFrame: () => firstFrame,
    setHost() {
      // the JSON renderer has no composer: nothing to route to the host
    },
    setUi(u) {
      ui = u;
    },
    notify(text, o = {}) {
      stream.ui(text, { ...(o.label ? { label: o.label } : {}), ...(o.level ? { level: o.level } : {}) }, ctx);
    },
    async unmount() {
      detach?.();
      detach = null;
    },
  };
}
