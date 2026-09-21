/**
 * AbortSignal composition shared by the transport layer (provider/sse.ts, jev/client.ts) and the engine's per-sample
 * generator channel (docs/LLM-JEV-DESIGN.md §4.8): one controller that aborts with the parent's reason, and an `unlink`
 * the caller runs in its `finally` so a long-lived parent signal does not accumulate listeners.
 */
export function linkedAbort(signal: AbortSignal): { controller: AbortController; unlink: () => void } {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return { controller, unlink: () => signal.removeEventListener('abort', onAbort) };
}
