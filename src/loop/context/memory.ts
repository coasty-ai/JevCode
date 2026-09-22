/**
 * The per-step memory selection (docs/IMPORT-DESIGN.md §2.10.4, §7.5 row 42; contract 1.6).
 *
 * §2.10.1 is the constraint: the system prompt is built once per run, so a rule that applies only to
 * `src/loop/**` must be injected per step or it is not a scoped rule at all. This module is that
 * injection point — the one place `src/loop/**` consults the importer's matcher.
 *
 * `matchRules(rules, paths)` (`src/import/rules.ts`) is pure, dependency-free and memoised on the
 * `rules` array itself, so a run that hands the same array every step compiles its globs once and a
 * rule with no match costs one memoised glob test. Nothing here reads the filesystem, the clock or
 * the environment: the engine hands in `EngineOptions.memory` and the step's paths, and gets back the
 * two lists `PromptContextView.rulesInScope` / `.memoryInScope` render.
 *
 * `paths` is the step's files in view — the generator's `read` / `edit` / `write` / `patch` targets
 * plus `pinnedFiles` (`session/seed.ts:28`) — the same set `CD §8.2` uses for `## Files in view`.
 *
 * Topics go through the SAME matcher, and that is the whole of §2.10.2 layer 6: a topic with `paths`
 * is in scope when one of them matches, and a topic without `paths` is index-only by construction
 * (`matchRules` reads a trigger-less, glob-less item as `manual`, which never fires implicitly), so it
 * stays in `## Memory (index)` and is read on demand. No second rule, no second cap.
 */
import { matchRules } from '../../import/rules.js';
import type { EngineMemoryOptions, MemoryItem } from '../../core/types.js';

/** §2.10.2 layers 5–6: what one step activated, root→leaf (the last item has the highest effective priority). */
export interface MemorySelection {
  rules: readonly MemoryItem[];
  topics: readonly MemoryItem[];
}

const NONE: MemorySelection = { rules: [], topics: [] };

/**
 * §2.10.4: the rule files and topics this step activates. Returns the empty selection — and therefore
 * elides both prompt sections — when the run was given no memory, when it was given no rules and no
 * topics, or when the step has no paths at all (the first step of a run, before anything is in view;
 * an `always` rule still fires, because `matchRules` answers it without consulting a path).
 */
export function selectMemory(memory: EngineMemoryOptions | undefined, paths: readonly string[]): MemorySelection {
  if (memory === undefined) return NONE;
  const rules = memory.rules ?? [];
  const topics = memory.topics ?? [];
  if (rules.length === 0 && topics.length === 0) return NONE;
  return { rules: matchRules(rules, paths), topics: matchRules(topics, paths) };
}

/** True when a selection would render nothing, so the caller can leave both members off the context view. */
export function isEmptySelection(sel: MemorySelection): boolean {
  return sel.rules.length === 0 && sel.topics.length === 0;
}
