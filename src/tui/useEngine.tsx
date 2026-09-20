/**
 * UI state for the TUI: a reducer over EngineEvent, the ≤ 20 fps live-region coalescer, the
 * event bus that lets `attach(engine)` happen after the first frame, and the TUI Confirmer
 * (DESIGN.md §10). Everything here except the hook is pure and unit-tested without Ink.
 */
import { useEffect, useReducer } from 'react';
import type { ConfirmRequest, Confirmer, Decision, EngineEvent, EngineStatus, RunResult } from '../core/types.js';
import { AbortError } from '../errors.js';
import { IDENTITY_REVIEWER, itemsFromEvent, sanitizeStream, type TranscriptItem } from './plain.js';

export const DECISIONS_KEPT = 12;
/** 50 ms = 20 fps: the only coalescing the TUI does (generator deltas and exec output share the buffer). */
export const LIVE_FLUSH_MS = 50;
/** The live buffer keeps a tail only; the full proposal text is committed to <Static> at `proposal`. */
export const LIVE_BUFFER_MAX = 64 * 1024;

export interface UiState {
  readonly items: readonly TranscriptItem[];
  /** monotonic counter behind item keys */
  readonly seq: number;
  readonly live: string;
  /** cumulative streamed tool-argument chars of the current generator call (0 when none / after the proposal) */
  readonly toolChars: number;
  readonly decisions: readonly Decision[];
  readonly status: EngineStatus | null;
  /** from run:ready, fills the status line before the first status event */
  readonly ready: { step: number; maxSteps: number } | null;
  readonly pendingConfirm: ConfirmRequest | null;
  readonly task: string;
  readonly resumeId: string | null;
  readonly runId: string | null;
  readonly done: RunResult | null;
}

export type UiAction =
  | { type: 'event'; event: EngineEvent }
  | { type: 'live'; text: string; toolChars?: number }
  | { type: 'confirm:request'; request: ConfirmRequest }
  | { type: 'confirm:settled'; id: string };

export function initialUiState(task: string, resumeId: string | null): UiState {
  return { items: [], seq: 0, live: '', toolChars: 0, decisions: [], status: null, ready: null, pendingConfirm: null, task, resumeId, runId: null, done: null };
}

/** Pure; one dispatch per event (live flushes come from the coalescer as their own action). */
export function uiReducer(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case 'live': {
      const toolChars = action.toolChars ?? state.toolChars;
      return state.live === action.text && state.toolChars === toolChars ? state : { ...state, live: action.text, toolChars };
    }
    case 'confirm:request':
      return state.pendingConfirm?.id === action.request.id ? state : { ...state, pendingConfirm: action.request };
    case 'confirm:settled':
      return state.pendingConfirm?.id === action.id ? { ...state, pendingConfirm: null } : state;
    case 'event':
      return applyEvent(state, action.event);
  }
}

function applyEvent(state: UiState, e: EngineEvent): UiState {
  const newItems = itemsFromEvent(e, state.seq);
  let next: UiState = newItems.length === 0 ? state : { ...state, items: [...state.items, ...newItems], seq: state.seq + newItems.length };
  switch (e.type) {
    case 'run:start':
      next = { ...next, runId: e.runId };
      break;
    case 'run:ready':
      next = { ...next, runId: e.runId, ready: { step: e.step, maxSteps: e.maxSteps } };
      break;
    case 'decision':
      next = { ...next, decisions: [...next.decisions.slice(-(DECISIONS_KEPT - 1)), e.decision] };
      break;
    case 'status':
      next = { ...next, status: e.status };
      break;
    // A new stream (or a command) starts with an empty live region; `proposal` and `outcome`
    // end it in the same update that appends their item, so no frame shows text twice or not at all.
    case 'generator:start':
    case 'exec:start':
    case 'proposal':
    case 'outcome':
      if (next.live !== '' || next.toolChars !== 0) next = { ...next, live: '', toolChars: 0 };
      break;
    // Cumulative count from the engine; the live region shows `streaming action… N chars` while the text buffer is empty.
    case 'generator:tool-delta':
      if (next.toolChars !== e.chars) next = { ...next, toolChars: e.chars };
      break;
    case 'confirm:request':
      next = { ...next, pendingConfirm: e.request };
      break;
    case 'confirm:resolved':
      if (next.pendingConfirm?.id === e.id) next = { ...next, pendingConfirm: null };
      break;
    case 'run:end':
      next = { ...next, done: e.result, pendingConfirm: null, live: '', toolChars: 0 };
      break;
    default:
      break;
  }
  return next;
}

// ---------------------------------------------------------------------------------------
// Event bus: attach(engine) may be called after render(); events before the App subscribes are replayed.
// ---------------------------------------------------------------------------------------

export interface EventSource {
  subscribe(fn: (e: EngineEvent) => void): () => void;
}
export interface EventBus extends EventSource {
  emit(e: EngineEvent): void;
}

const BUS_REPLAY_MAX = 10_000;

export function createEventBus(): EventBus {
  const listeners = new Set<(e: EngineEvent) => void>();
  let backlog: EngineEvent[] = [];
  return {
    subscribe(fn) {
      listeners.add(fn);
      if (backlog.length > 0) {
        const replay = backlog;
        backlog = [];
        for (const e of replay) fn(e);
      }
      return () => {
        listeners.delete(fn);
      };
    },
    emit(e) {
      if (listeners.size === 0) {
        backlog.push(e);
        if (backlog.length > BUS_REPLAY_MAX) backlog.shift();
        return;
      }
      for (const fn of [...listeners]) fn(e);
    },
  };
}

// ---------------------------------------------------------------------------------------
// TUI Confirmer
// ---------------------------------------------------------------------------------------

export interface TuiConfirmer extends Confirmer {
  /** settle the pending request; false when no request with that id is pending */
  resolve(id: string, approved: boolean): boolean;
  onRequest(fn: (req: ConfirmRequest) => void): () => void;
  pending(): ConfirmRequest | null;
}

export interface TuiConfirmerOptions {
  /** decline automatically after this many ms (stdin not a TTY); null = wait for y/n */
  autoDeclineMs?: number | null;
  /** shown in the declined reason; 'reviewer' on a TTY, 'no reviewer (stdin not a TTY)' on a pipe */
  identity?: string;
}

export function createTuiConfirmer(opts: TuiConfirmerOptions = {}): TuiConfirmer {
  const autoDecline = opts.autoDeclineMs ?? null;
  const listeners = new Set<(req: ConfirmRequest) => void>();
  let pending: { req: ConfirmRequest; settle: (approved: boolean) => void; fail: (err: AbortError) => void } | null = null;

  return {
    identity: opts.identity ?? IDENTITY_REVIEWER,
    pending: () => pending?.req ?? null,
    onRequest(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    resolve(id, approved) {
      if (!pending || pending.req.id !== id) return false;
      pending.settle(approved);
      return true;
    },
    confirm(req, { signal }) {
      if (signal.aborted) return Promise.reject(signal.reason instanceof AbortError ? signal.reason : new AbortError('signal'));
      // The engine is sequential; a second request while one is pending means the first can
      // no longer be answered by anyone, so it is declined (never approved) rather than left hanging.
      pending?.settle(false);
      return new Promise<boolean>((resolve, reject) => {
        let timer: NodeJS.Timeout | null = null;
        const cleanup = (): void => {
          signal.removeEventListener('abort', onAbort);
          if (timer) clearTimeout(timer);
          if (pending?.req.id === req.id) pending = null;
        };
        const onAbort = (): void => {
          cleanup();
          reject(signal.reason instanceof AbortError ? signal.reason : new AbortError('signal'));
        };
        pending = {
          req,
          settle: (approved) => {
            cleanup();
            resolve(approved);
          },
          fail: (err) => {
            cleanup();
            reject(err);
          },
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (autoDecline !== null) {
          timer = setTimeout(() => pending?.req.id === req.id && pending.settle(false), Math.max(0, autoDecline));
          timer.unref();
        }
        for (const fn of [...listeners]) fn(req);
      });
    },
  };
}

// ---------------------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------------------

function appendTail(buf: string, text: string): string {
  // Command output and generator text are untrusted: strip escapes before they can reach the frame.
  const joined = buf + sanitizeStream(text);
  return joined.length > LIVE_BUFFER_MAX ? joined.slice(joined.length - LIVE_BUFFER_MAX) : joined;
}

/**
 * Feeds the reducer from an EventSource. `generator:delta` and `exec:output` accumulate in a
 * closure buffer (and `generator:tool-delta` in a counter) and reach React through one `live`
 * dispatch per LIVE_FLUSH_MS at most.
 */
export function useEngine(source: EventSource, confirmer: TuiConfirmer, task: string, resumeId: string | null): { state: UiState; dispatch: (a: UiAction) => void } {
  const [state, dispatch] = useReducer(uiReducer, null, () => initialUiState(task, resumeId));

  useEffect(() => {
    let buffer = '';
    let toolChars = 0;
    let timer: NodeJS.Timeout | null = null;
    const flush = (): void => {
      timer = null;
      dispatch({ type: 'live', text: buffer, toolChars });
    };
    const schedule = (): void => {
      if (timer === null) timer = setTimeout(flush, LIVE_FLUSH_MS);
    };
    const clearLive = (): void => {
      buffer = '';
      toolChars = 0;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const unsubscribe = source.subscribe((e) => {
      switch (e.type) {
        case 'generator:delta':
          buffer = appendTail(buffer, e.text);
          schedule();
          return;
        case 'exec:output':
          buffer = appendTail(buffer, e.chunk);
          schedule();
          return;
        case 'generator:tool-delta':
          toolChars = e.chars;
          schedule();
          return;
        case 'generator:start':
        case 'exec:start':
        case 'proposal':
        case 'outcome':
        case 'run:end':
          clearLive();
          dispatch({ type: 'event', event: e });
          return;
        default:
          dispatch({ type: 'event', event: e });
      }
    });
    const unsubscribeConfirm = confirmer.onRequest((request) => dispatch({ type: 'confirm:request', request }));
    return () => {
      unsubscribe();
      unsubscribeConfirm();
      if (timer !== null) clearTimeout(timer);
    };
  }, [source, confirmer]);

  return { state, dispatch };
}
