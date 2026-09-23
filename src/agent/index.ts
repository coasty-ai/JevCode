/**
 * The agent loop's entry point (docs/AGENT-LOOP-DESIGN.md §2.1). The engine loads this module with a dynamic import
 * when a run in `agent` mode has no injected `EngineOptions.agent`.
 *
 * STUB (slice S1): the contract types live in `src/core/types.ts` (the agent-loop block); slice S3 replaces this file with the
 * real driver and slice S4 adds the engine branch that loads it. Between S1 and S4 `--mode agent` is accepted by every
 * allow-list but is not functional (§15 S1: nothing is released in between); loading this stub fails with exit 2.
 */
import type { AgentDriver, AgentDriverFactory } from '../core/types.js';
import { ConfigError } from '../errors.js';

/** A fresh driver per run. Not built yet: throws the ConfigError that names it. */
export const createAgentDriver: AgentDriverFactory = (): AgentDriver => {
  throw new ConfigError('agent mode is not built yet', { setting: 'mode' });
};
