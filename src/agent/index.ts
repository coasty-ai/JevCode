/**
 * The agent loop's entry point (docs/AGENT-LOOP-DESIGN.md §2.1): JevCode's model-driven harness, where the code model
 * drives with native tool calls and the harness executes, checkpoints and verifies. The engine loads this module with a
 * dynamic import when a run in `agent` mode has no injected `EngineOptions.agent`.
 */
import type { AgentDriverFactory } from '../core/types.js';
import { createDriver } from './driver.js';

/** A fresh driver per run. */
export const createAgentDriver: AgentDriverFactory = () => createDriver();

export { AgentTranscriptMissingError, transcriptPath } from './transcript.js';
export { classifyCommand, commandGate, destructiveNote, ruleRiskAssessment, RULE_SENTENCES, type CommandClass, type CommandVerdict, type DestructiveRule } from './safety.js';
export { buildAgentSystemPrompt } from './prompt.js';
export { TOOL_SPECS, toolsFor } from './tools/specs.js';
export { AGENT_MAX_BLOCKS, AGENT_MAX_LOOP_NUDGES } from './limits.js';
