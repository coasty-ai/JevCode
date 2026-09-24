import type { EngineEmitter, EngineEvent, EngineEventType } from './types.js';

type AnyListener = (e: EngineEvent) => void;

/**
 * Typed emitter for engine -> renderer events. Listener exceptions never propagate into the
 * loop; they are forwarded to `onListenerError` (default: written to stderr once per error).
 */
export function createEmitter(onListenerError?: (err: unknown, event: EngineEvent) => void): EngineEmitter {
  const byType = new Map<EngineEventType, Set<AnyListener>>();
  const any = new Set<AnyListener>();
  const report =
    onListenerError ??
    ((err: unknown, event: EngineEvent): void => {
      process.stderr.write(`[jevcode] listener error on ${event.type}: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  function safeCall(fn: AnyListener, e: EngineEvent): void {
    try {
      fn(e);
    } catch (err) {
      report(err, e);
    }
  }
  return {
    on(type, fn) {
      let set = byType.get(type);
      if (!set) {
        set = new Set();
        byType.set(type, set);
      }
      const l = fn as AnyListener;
      set.add(l);
      return () => {
        set!.delete(l);
      };
    },
    onAny(fn) {
      any.add(fn);
      return () => {
        any.delete(fn);
      };
    },
    emit(e) {
      const set = byType.get(e.type);
      if (set) for (const fn of [...set]) safeCall(fn, e);
      for (const fn of [...any]) safeCall(fn, e);
    },
  };
}
