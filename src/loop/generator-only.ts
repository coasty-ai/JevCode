/**
 * Jev-off condition (DESIGN.md §13): the same loop with every Jev consumer removed. The
 * engine core in engine.ts branches on `mode`, so this factory forces `mode: 'jev-off'` and
 * re-exports the jev-off specific pieces (fixed loop text) for callers and tests.
 */
import type { Engine, EngineOptions } from '../core/types.js';
import { createEngine, type EngineDeps } from './engine.js';

export { loopTripText } from './loopdetect.js';

/**
 * Same prompt layout minus the Jev sections, candidate list instead of context files,
 * verbatim plan acceptance (judged -1), fixed loop text on a trip, `done` -> 'generator_done',
 * no risk/judge stages; emits the same event union (decision/jev:request/intent/context/
 * risk/judge/replan never fire).
 */
export function createGeneratorOnlyEngine(opts: EngineOptions, deps: EngineDeps = {}): Promise<Engine> {
  return createEngine({ ...opts, mode: 'jev-off' }, deps);
}
