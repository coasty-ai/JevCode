/**
 * Every bound the import engine enforces, in one module (docs/IMPORT-DESIGN.md §2.8, Appendix B).
 * Nothing is truncated silently: every clip emits a `warnings` entry on its row and a line in the
 * report's `## Notices`.
 *
 * SHARED FILE, IMPORT HALF ONLY. §7.1 [G2.2] makes this file co-owned: `COORDINATION-DESIGN.md`
 * row 3 (`:1908`) creates it, and import W0 lands **after** coordination W0 as an additive export.
 * Coordination has not landed on this branch, so this file currently holds `IMPORT_LIMITS` alone
 * and the merge is an append. The incoming rows that join it, unchanged, are:
 *
 *   - CD row 3  (COORDINATION-DESIGN.md:1908) — the coordination bounds this file was created for
 *   - CD row 19 (:1944)                       — the prompt-section bounds, amended by §2.10.3 [G2.7]
 *
 * Neither is re-declared here, and no existing export is moved into this file.
 */

/**
 * §2.8 / Appendix B. Frozen by `as const` so a caller cannot widen a bound at runtime; every
 * value is a positive finite number and the two shares sit in `(0, 0.5)`
 * (`test/unit/core/limits.test.ts`).
 */
export const IMPORT_LIMITS = {
  // ----- discover (§4.2.2) -----
  /** deepest real artefact observed is `~/.claude/projects/<slug>/<session>/subagents/x.jsonl` (depth 5) */
  walkDepth: 8,
  /** per root; `~/.claude/projects` alone is 10,220 entries today */
  walkEntries: 20_000,
  /** per root; a cold NFS `$HOME` must not hang the wizard */
  walkMs: 2_000,
  /** one atlas row cannot produce 3,371 plan rows */
  filesPerRow: 512,
  /** `= INSTRUCTIONS_READ_CAP_BYTES` (`config/instructions.ts:24`) */
  sourceReadCapBytes: 4 * 1024 * 1024,
  /** metadata pass only; the largest transcript on the author's machine is 151 MB */
  transcriptScanBytes: 256 * 1024,
  /** a NUL in this prefix means the file is not text (§4.4.1 rule 5) */
  binarySniffBytes: 8 * 1024,
  /** stat→read race slack (§6 row 31) */
  readSlackBytes: 64 * 1024,

  // ----- destination (§2.2, §2.8) -----
  memoryDirBytes: 512 * 1024,
  memoryFiles: 200,
  /** Claude's own index cap is 200 lines / 25 KB */
  memoryIndexLines: 200,
  memoryIndexBytes: 8 * 1024,
  topicBytes: 8 * 1024,
  /** Windsurf's own rule cap is 12,000 chars → clipped with a notice */
  ruleBytes: 4 * 1024,
  commandBytes: 8 * 1024,
  /** keeps `AGENTS.md` under `INSTRUCTIONS_MAX_BYTES` (32 KiB) with headroom */
  agentsAppendBytes: 8 * 1024,
  /** per rule, after brace expansion */
  rulePatterns: 200,
  /** rule files a session matches against per step [G1.6] */
  ruleFiles: 200,
  mcpServers: 64,
  /** `slugOf` output cap [G1.2] */
  slugMaxChars: 64,

  // ----- prompt: shares of the step's context budget (§2.10.3) [G2.7] -----
  /** the `## Memory (index)` system-prompt section, once per run */
  memoryIndexPromptBytes: 8 * 1024,
  rulesInScopeShare: 0.1,
  rulesInScopeMin: 2 * 1024,
  rulesInScopeMax: 12 * 1024,
  memoryInScopeShare: 0.14,
  memoryInScopeMin: 2 * 1024,
  memoryInScopeMax: 16 * 1024,

  // ----- jev (§4.4.3) -----
  /** `assertQuestionBatch` (`jev/questions.ts:102`) caps at 1,000; the import budget is far under it */
  jevRequests: 3,
  jevQuestions: 400,
  jevHeadings: 5,
  jevHeadingCells: 80,
  /** only under `--jev-sample=head400` [G2.4] */
  jevSentenceChars: 200,

  // ----- plan (§4.5) -----
  planRows: 2_000,
  /** bounds the O(N²) Jaccard pass [G1.6] */
  dedupePairs: 20_000,
  minhashBands: 8,

  // ----- artefacts (§4.6, §4.7.6) -----
  reportBytes: 1 * 1024 * 1024,
  sourceLineBytes: 2 * 1024,
  /** newest import dirs kept; the rest are GC'd at the start of the next import [G1.4] */
  importsKeep: 10,
  lockStaleMs: 10 * 60 * 1000,
} as const;

/** The literal type of `IMPORT_LIMITS`, for callers that thread a narrowed copy through a seam. */
export type ImportLimits = typeof IMPORT_LIMITS;
