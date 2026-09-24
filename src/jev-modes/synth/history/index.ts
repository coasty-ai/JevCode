/**
 * The `history` candidate source (docs/JEV-ONLY-DESIGN.md §3 last row): harvest.ts reads the
 * repository's git history once per run through the sandbox (bounded), source.ts turns the
 * reverse of each change run near a site into ordinary candidates. Measured need and reach in
 * experiments/results/swebench-reach-oracle-9.md (capability 3) and jev-only-rungs-1-2.md.
 */
export type { HistoryCommit, HistoryFacts, HistoryHunk } from './types.js';
export { HISTORY_COMMAND_TIMEOUT_MS, HISTORY_CONTEXT, HISTORY_LOG_PER_QUERY, HISTORY_MAX_COMMANDS, HISTORY_MAX_COMMITS, HISTORY_MAX_IDENT_QUERIES, HISTORY_MAX_REF_QUERIES, HISTORY_OUTPUT_BYTES, harvestHistory, issueRefs, parseShowDiff, parseShowOutput, rankIdentifiers } from './harvest.js';
export type { HarvestOptions, HistoryRef } from './harvest.js';
export { HISTORY_SITE_NOTE, HISTORY_WINDOW_LINES, createHistorySource, distanceToSite, enumerateHistory, locateLines, locateReversal, locateReversals, provenanceOf, reverseHunk, sameSpan, spanEndOf } from './source.js';
export type { LocatedReversal } from './source.js';
