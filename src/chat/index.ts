/**
 * `src/chat/**` — conversational intake (TUI-DESIGN-2 §3, D-C): one Jev request per submission decides what it is;
 * greetings get a catalogue reply, tool questions the session's own facts, code questions a lookup (jev-only) or one
 * LLM turn (jev+llm), tasks a run, ambiguity a confirmation. Pure builders and data; the controller (`src/cli/session.ts`)
 * owns the state machine of §3.1 and the money of §3.9.
 */
export * from './intake.js';
export * from './replies.js';
export * from './facts.js';
export * from './lookup.js';
export * from './llm-turn.js';
export * from './bubbles.js';
export * from './ledger.js';
