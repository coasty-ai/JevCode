export const meta = {
  name: 'tui-wave-1',
  description: 'Wave 1 of the JevCode interactive TUI: seven ink-free slots implemented in parallel, each adversarially reviewed and fixed',
  phases: [
    { title: 'Implement', detail: 'O2 O3 O4 O5 O6 O7 O8 pure/fs modules with unit tests' },
    { title: 'Review', detail: 'one adversarial reviewer per slot' },
    { title: 'Fix', detail: 'implementer applies the findings' },
  ],
}

const REPO = args.repo
const DATE = args.date

const COMMON = `You are an implementer on the JevCode interactive TUI (repo ${REPO}; TypeScript strict, ESM, Node 22.23.2, no 'any', exactOptionalPropertyTypes and noUncheckedIndexedAccess on; runtime deps are ONLY ink 7.1.1 and react 19.3.0; everything else Node built-ins). Today is ${DATE}.
THE SPEC is ${REPO}/docs/TUI-DESIGN.md. Read first: the D1-D15 table and section 0 (fixed decisions), section 15 (the contract: every type you need already exists in src/core/types.ts after wave 0 — never redefine a type that section 15 puts in types.ts; import it), section 15.2 (insertion points), section 19.0 and 19.1-19.3 (the test file per module and what it asserts), section 20 (your slot's row: files, exports, dependencies), section 24 (the glossary of user-facing strings: use these strings VERBATIM), and the sections named in your slot brief. Also read ${REPO}/docs/DESIGN.md section 10 for the existing TUI rules, and the existing code you build on (named in your brief).
OWNERSHIP RULES (hard): edit and create ONLY the files listed for your slot; other slots are working concurrently on other files in the same checkout, and another team owns src/synth/**, src/loop/stages/**, and experiments/**. If you need something in a file you do not own, write it down in your report under "requests for other slots" and stub locally in your own files instead. Never run git add/commit/stash/checkout; never modify package.json; never add a dependency. Re-read a shared file (src/core/types.ts) right before relying on a symbol.
QUALITY BAR: production quality, no TODOs left behind, every exported function documented with a one-line comment that cites the design section (e.g. "TUI-DESIGN §4.1"), every module has its unit test file per section 19.0 with the assertions the design names, edge cases handled (empty input, unicode graphemes/wide chars/emoji, huge inputs, tiny/zero sizes, NaN/Infinity, missing files, EACCES/ENOENT), pure functions kept pure (no I/O, no Date.now inside pure code: pass nowMs), strings from section 24 verbatim, no console output.
VERIFY before you finish: (1) 'npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E "<your file paths>"' prints nothing (the full tsc may show errors in OTHER slots' in-progress files; ignore those but report them); (2) 'node scripts/no-any.mjs' passes; (3) 'npx vitest run --project unit <your test paths>' passes; (4) for any perf target the design gives your module (e.g. fuzzy scorer <= 16 ms per keystroke over 5,000 candidates, computeLayout <= 5 us, cellWidth throughput), include a unit test that measures it and asserts the bound with headroom for a loaded machine (use 3x the design's bound if the design does not say otherwise, and report the measured value).
REPORT (structured): files created/edited, exports, tests added and their counts, measured numbers, deviations from the design with reasons, requests for other slots, and anything in the design you found contradictory or impossible (do not silently reinterpret; pick the reading that honours the fixed decisions F1-F18 and say so).`

const SLOTS = [
  {
    key: 'O2-composer-core',
    brief: `SLOT O2 composer core (ink-free). Sections: 4.1 TextBuffer model and reducer, 4.2 cellWidth and rows, 4.4 input filter, 4.5 paste lifecycle (the PasteStore part; the Ink useRef wiring is O9), 4.6 history, 4.7 undo/redo/kill ring/coalescing, 19.2 property tests, and the HistoryStore interface in section 15 item 16. Files: src/tui/composer/{buffer,width,eaw-table,rows,paste,history,killring,filter}.ts, scripts/gen-eaw.mjs (generates eaw-table.ts from the devDependency-visible get-east-asian-width package if present in node_modules, else from a checked-in fallback range list; run it once and commit the generated table as source), test/unit/tui/composer/**. Exports per section 20: reduceBuffer, graphemeBoundaries, wordBoundary, cellWidth, stringWidth, truncateCells, layoutRows, cursorToRowX, viewport, PasteStore, filterInput, HistoryStore impl (file-backed ~/.jevcode/history.jsonl per section 4.6 and A60: JSONL entries { t, workspace, kind, text }, 4 KiB/entry, 1,000 entries with atomic rewrite, consecutive duplicates dropped, per-workspace filter with an 'all' widening, redaction function injected, never written for bench/perf). cellWidth must replicate string-width 8.2.2's rules (zero-width classes via \\p{...} with the v flag, RGI emoji = 2, keycap/ZWJ sequences = 2, Hangul L+V(+T) = 2, East Asian Wide/Fullwidth = 2, ambiguous = 1) and be fixture-tested against the string-width package installed under node_modules (import it in the TEST only via createRequire from the repo root; if it is not resolvable, use a checked-in fixture of 300 strings with expected widths). Property tests: cursor always on a grapheme boundary after any sequence of 500 random ops; layoutRows(text).join equals text modulo wraps; undo(redo(x)) == x.`,
  },
  {
    key: 'O3-keys-layout-commands',
    brief: `SLOT O3 keys + layout + commands (ink-free). Sections: 2.1 computeLayout (implement EXACTLY the function in the design, with its invariants tested over rows 2..60 x columns 20..400 x every OverlayKind x wants 0..12), 2.2 (the allocation table becomes a test: each row's numbers at rows 8/12/24/40/50), 3.1 resolveKey and KeyState, 3.2 bindings and KEY_ACTIONS registry, 3.3 reduceInterrupts and the S0-S7 matrix (each cell a test), 3.4 keybindings file loader, 4.9 submit routing (routeSubmit, pure), 5.1 slash grammar parser, 5.2 the command table (COMMANDS registry with availableDuringTask and argument specs), 5.3 palette rendering lines (pure strings), 5.4 fuzzy scorer (prefix-then-subsequence with word-boundary bonuses; <= 16 ms per keystroke over 5,000 candidates measured in a test), 21 (scripts/gen-docs.mjs generating docs/KEYS.md and docs/COMMANDS.md from the registries, man/jevcode.1 and completions/jevcode.{bash,zsh,fish} from cli/args.ts FLAGS + COMMANDS; write the generator and generate the files; a sync test asserts the generated docs match). Files: src/tui/layout.ts, src/tui/keys/{resolve,interrupts,bindings,keybindings-file}.ts, src/tui/commands/{parse,registry,fuzzy,dispatch}.ts (dispatch = pure resolution of a parsed command to an action descriptor the controller executes; it must not import cli/**), src/tui/composer/submit.ts, scripts/gen-docs.mjs, docs/KEYS.md, docs/COMMANDS.md, man/jevcode.1, completions/*, test/unit/tui/{layout,keys,commands}/**. Note: src/tui/App.tsx still has its own computeLayout today; do NOT edit App.tsx (O9 will switch it); your layout.ts is the new one.`,
  },
  {
    key: 'O4-review-pane-decisions',
    brief: `SLOT O4 review + pane + decisions (ink-free, pure line builders). Sections: 6.1 reviewHeaderLines(req, n, columns) and its row ladder at every n, 6.5 plain/screen-reader twins, 7.1 DecisionRow model (toDecisionRow: the code rule that consumed each answer, near-threshold '!' flag within 0.03), 7.2 tabs d/p/t/s as lines(state, rows, columns) builders (decisions with 10-cell eighth-block probability bars on a '·' track, plan ledger [x] [ ] [?] [!], step timeline letters I C P R X J with timings, synth strip free-text), 7.3 loop banner row, 7.6 /why and /calibration blocks (whyBlock, calibrationBlock computed from Decision records; reliability bins, ECE, near-threshold counts, sharpness), bars.ts (eighthBar, sparkline with a fixed 0-1000 ms scale), glyphs.ts (unicode and --ascii twins for every glyph; screen-reader variants), followupLines (section 9.3 box). Files: src/tui/review/lines.ts, src/tui/pane/{model,decisions,plan,timeline,synth,banner}.ts, src/tui/why.ts, src/tui/calibration.ts, src/tui/bars.ts, src/tui/glyphs.ts, test/unit/tui/{review,pane}/** plus test/unit/tui/{why,calibration,bars,glyphs}.test.ts. Use the fixture builders in test/fixtures/tui/fixtures.ts (mkConfirmRequest, mkDecision, mkRisk) — read that file; do not edit it (O1 owns it). Every line builder must respect the columns argument (truncate with the glyph set's ellipsis; never wider than columns).`,
  },
  {
    key: 'O5-status-git-pure',
    brief: `SLOT O5 wave-1 (pure parts only): status line, toasts, git parsers, mention denylist. Sections: 7.4 status line statusLineText(state, columns) with the three zones and the width ladder (>= 80 run+session meters, >= 100 git zone and sparkline, >= 120 bars only where the design says, badges, left-zone words), 7.5 toastReducer, 12.1 statusPorcelainV2 (pure parser of 'git status --porcelain=v2 --branch -uall -z' output into GitState.dirty/head/upstream/ahead/behind; test with recorded fixtures including renames, unmerged, submodules, detached HEAD, unborn branch), toRunGitMeta (pure), 12.2 banner lines (pure), 10.4 isMentionDenied in src/sandbox/paths.ts (reuse the existing isSecretPath logic; read src/sandbox/paths.ts fully first). Files: src/tui/status/lines.ts, src/tui/toasts.ts, src/workspace/git.ts (edit: ADD statusPorcelainV2 and keep every existing export unchanged), src/workspace/gitstate.ts (new: toRunGitMeta and the pure helpers only; probeGitState with its two spawns is wave 2 — export a typed stub that throws 'not wired in wave 1' so callers compile, and say so), src/sandbox/paths.ts (edit: add isMentionDenied only), test/unit/tui/status/**, test/unit/workspace/{git-porcelain-v2,gitstate}.test.ts, test/unit/sandbox/paths-mention.test.ts. Do not edit src/workspace/files.ts, seatbelt.ts or run.ts (wave 2).`,
  },
  {
    key: 'O6-sessions-money-config',
    brief: `SLOT O6 sessions + money + config. Sections: 8.1 data model, 8.2 index.jsonl (foldIndex, readIndex, appendIndexLine with O_APPEND <= 512-byte lines and torn-line skipping, reindex over run.json/state.json), 8.3 buildSeed and seedSource (pure), 8.5 run.lock (acquireRunLock/releaseRunLock with PID liveness and stale detection), 8.7 /export (exportSession concatenating transcript.log files with run headers), picker rows (8.4: pickerRows pure), 9.1-9.6 money (spend/meter.ts: setCap, child meters forwarding to the root, parent/parentExceeded in snapshot with the conditional-spread rule; src/tui/budget/lines.ts: budgetItems, costBlock, the y/r/n box lines, threshold crossing detection 50/80/95 with 'restored' semantics), 16 config schema (src/config/launch.ts resolveLaunchSettings pure; src/config/ui.ts; resolve.ts/validate.ts/defaults.ts/types.ts edits for missingSecrets(mode), ui(launch), sessionSpendCap(mode) with the mode-keyed jev-only default 0.25 and 'none' = +Infinity, addSecret/dropSecret delegation, configDirs, priced (fail-closed rule for unpriced Anthropic models unless allowUnpriced), XDG config path first with legacy fallback and a one-time warning, the ui.*/session.* SETTINGS rows and record() rows including 'ignored:launch' and 'derived' sources). Files: src/session/{index,lock,seed,export,picker-lines}.ts, src/spend/meter.ts (edit), src/tui/budget/lines.ts, src/config/{resolve,validate,defaults,types}.ts (edit), src/config/{ui,launch}.ts (new), test/unit/{session,spend}/**, test/unit/config/{launch,ui}.test.ts and edits to the existing test/unit/config/*.test.ts you must update, including test/unit/session/ten-run-seed.test.ts (the pure seed/index/meter assertions of section 19.7). Read src/config/resolve.ts, validate.ts, defaults.ts and src/spend/meter.ts fully before editing; keep every existing behaviour and test green; the wave-0 contract may have added optional missingSecrets/ui/sessionSpendCap to ResolvedConfig — make them required now if types.ts still has them optional (you own that change in types.ts ONLY for those three members; touch nothing else there).`,
  },
  {
    key: 'O7-secrets-onboarding-logs',
    brief: `SLOT O7 secrets + onboarding + logs. Sections: 10.1 detectSecrets (every existing redacting family from src/core/redact.ts FORMAT_PATTERNS plus warn-only AWS/Slack/PEM-with-PRIVATE-KEY/JWT/Stripe/npm_/hf_/glpat-; SecretHit { family, label, start, end, warnOnly }; sk-proj- labelled OpenAI; exact configured secrets first), dropSecret on the Redactor, 10.2 gate lines (gateLines pure), 10.5 clipboard (copyRedacted: native tool pbcopy/wl-copy/xclip/xsel first via spawn with a timeout, OSC 52 write as fallback, never read; injectable spawn for tests), 10.6-10.7, 11.1 onboarding reducer and wizard lines (pure state machine: detect -> provider -> generator key -> Jev key with Enter = reuse -> save -> verify? -> trust -> sandbox line; key bytes are never in the state: the reducer receives masked lengths only), 11.2 credentials writer (atomic 0600 write to the XDG config.json, legacy path check, shadowing detection, Windows ACL note), 11.3 trust store (~/.jevcode/trust.json 0600 keyed by git-root realpath with AGENTS.md@sha256; changed sha re-prompts; --trust-workspace) and loadInstructions (AGENTS.md first match walking up to the workspace root, CLAUDE.md fallback, ~/.config/jevcode/AGENTS.md, 32 KiB cap, { path, sha256, bytes }), 13.6 per-run log (src/core/log.ts createLog: levels error/warn/info/debug/trace, warn+ flushed synchronously, fallback dir, key-class trace helper for keystrokes), cli/login.ts (commandLogin/Logout/ConfigSet pure command handlers that read stdin masked in --plain via node:readline with output muted; the Ink masked field is O9). Files: src/core/redact.ts (edit; keep every existing export and behaviour), src/core/log.ts, src/tui/onboarding/{reducer,lines}.ts, src/tui/secrets/{gate-lines,clipboard}.ts, src/config/{credentials,trust,instructions}.ts, src/cli/login.ts, test/unit/core/** (create the directory; MOVE test/unit/config/redact.test.ts to test/unit/core/redact.test.ts with git mv NOT allowed — copy it, extend it, and delete the old file with rm), test/unit/config/{trust,credentials,instructions,login}.test.ts, test/unit/tui/onboarding/**. False-positive discipline: add negative tests for legitimate code that must NOT match (base64 blobs, sha256 hex, UUIDs, 'sk-' inside words, a PEM header without PRIVATE KEY).`,
  },
  {
    key: 'O8-undo-diff-errors-pure',
    brief: `SLOT O8 wave-1: undo/diff/error surfaces (pure + plain fs). Sections: 12.3 pre/post images (src/checkpoint/images.ts: writePreImages/writePostImages/readPostImages under <run>/pre/<step>/<sha256(relpath)> and post/<step>.json with per-file sha256, cleanAtStart, headOid; skip > 1 MiB noted; dirty-set copy cap 200 files / 16 MiB; streamed hashing cap 16 MiB per step; atomic writes via src/core/atomic.ts), 12.4 planUndo decision table (pure over post images + current hashes + later steps' post images: restore / refuse-with-rewind / ask-per-file default n; HEAD-moved rule), 12.5 /rewind planning (pure), 12.6 diffStatBlock (inline --numstat -z parser and renderer with letters M/A/D/R/?/B/S, dagger legend, row cap 40) and diffStep (unified diff between pre and post images rendered as lines; a dependency-free line diff), 13.1 severity -> surface map (pure classifier), 13.3 blockingLines (pure), 13.4 PaneBoundary.tsx (an Ink error boundary component that degrades one pane to a one-line notice; test with ink-testing-library) and the disk-error classifier classifyDiskError in src/checkpoint/store.ts (edit: ADD CHECKPOINT_FILES entries ui/log/lock/pre/post/tmp/drafts and classifyDiskError; keep all existing behaviour), 13.5 epilogueLines (pure; every string per section 24 and the exit-code table), 13.5 the exit-code table as data. Files: src/checkpoint/images.ts, src/checkpoint/store.ts (edit), src/undo/{plan,diff}.ts (apply.ts and pager.ts need the sandbox/git and are wave 2: export typed stubs that throw 'not wired in wave 1'), src/cli/epilogue.ts, src/tui/PaneBoundary.tsx, src/tui/blocking/lines.ts, src/cli/fatal.ts (the pure part: fatalLines and the restore-string constant; the process-exit wiring is wave 2 — export an installFatalHandlers(deps) that takes injected write/exit/restore so it is fully unit-testable now), test/unit/{checkpoint,undo,cli/epilogue,cli/fatal}/**, test/unit/tui/pane-boundary.test.tsx. Read src/checkpoint/store.ts, src/core/atomic.ts, src/core/hash.ts fully first.`,
  },
]

const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    exports: { type: 'array', items: { type: 'string' } },
    tests: { type: 'string' },
    measured: { type: 'array', items: { type: 'string' } },
    deviations: { type: 'array', items: { type: 'string' } },
    requests: { type: 'array', items: { type: 'string' } },
    problems: { type: 'array', items: { type: 'string' } },
    tscClean: { type: 'boolean' },
    testsPass: { type: 'boolean' },
  },
  required: ['files', 'exports', 'tests', 'deviations', 'requests', 'problems', 'tscClean', 'testsPass'],
}
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, file: { type: 'string' }, problem: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' } }, required: ['severity', 'file', 'problem', 'evidence', 'fix'] } },
    designMismatches: { type: 'array', items: { type: 'string' } },
    missingTests: { type: 'array', items: { type: 'string' } },
  },
  required: ['findings', 'designMismatches', 'missingTests'],
}

phase('Implement')
log(`wave 1: ${SLOTS.length} slots in parallel`)
const results = await pipeline(
  SLOTS,
  (s) => agent(`${COMMON}\n\n${s.brief}`, { label: `impl:${s.key}`, phase: 'Implement', schema: IMPL_SCHEMA }).then((r) => (r ? { ...r, key: s.key, brief: s.brief } : null)),
  (impl, s) => {
    if (!impl) return null
    return agent(`You are an ADVERSARIAL REVIEWER for slot ${s.key} of the JevCode interactive TUI (repo ${REPO}, spec ${REPO}/docs/TUI-DESIGN.md, today ${DATE}). The implementer reports these files: ${impl.files.join(', ')}. Read the slot brief below, the design sections it names, section 15 (contract), section 19.0 (required tests per module) and section 24 (glossary strings). Then read EVERY listed file and its tests in full, run 'npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E "${impl.files.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}"' and 'npx vitest run --project unit' on the slot's test paths yourself, and try to break the code: wrong types vs section 15, strings that differ from section 24, missing edge cases (unicode, empty, huge, tiny, NaN, missing files, EACCES), impurity in pure modules, missing tests from section 19.0, perf bounds not asserted, any 'any', new dependencies, files edited outside the slot's ownership (check git status for unexpected paths that match this slot's area), and silent reinterpretations of the design. Return up to 20 findings ranked by severity with file, evidence (quote the line) and a concrete fix. Do not modify any file.\n\nSLOT BRIEF:\n${s.brief}\n\nIMPLEMENTER REPORT: deviations=${JSON.stringify(impl.deviations)} problems=${JSON.stringify(impl.problems)} requests=${JSON.stringify(impl.requests)} measured=${JSON.stringify(impl.measured || [])}`, { label: `review:${s.key}`, phase: 'Review', schema: REVIEW_SCHEMA }).then((rv) => ({ impl, review: rv }))
  },
  (pair, s) => {
    if (!pair || !pair.review) return pair
    const fixable = pair.review.findings.filter((f) => f.severity !== 'minor')
    const minors = pair.review.findings.filter((f) => f.severity === 'minor')
    if (fixable.length === 0 && pair.review.missingTests.length === 0 && pair.review.designMismatches.length === 0) return { ...pair, fixed: 'nothing to fix' }
    const text = [...fixable, ...minors].map((f, i) => `${i + 1}. [${f.severity}] ${f.file}: ${f.problem}\n   evidence: ${f.evidence}\n   fix: ${f.fix}`).join('\n')
    return agent(`${COMMON}\n\nYou are the implementer of slot ${s.key} again, in the FIX pass. Your earlier work is on disk (files: ${pair.impl.files.join(', ')}). An adversarial reviewer returned the findings below. Apply every blocker and major finding, the minors unless they contradict the design, add the missing tests listed, and resolve the design mismatches (the design wins unless it contradicts a fixed decision F1-F18; say which). Re-run the verification steps. Report what changed per finding.\nFINDINGS:\n${text}\nMISSING TESTS: ${JSON.stringify(pair.review.missingTests)}\nDESIGN MISMATCHES: ${JSON.stringify(pair.review.designMismatches)}\n\nSLOT BRIEF (for reference):\n${s.brief}`, { label: `fix:${s.key}`, phase: 'Fix', schema: IMPL_SCHEMA }).then((fx) => ({ ...pair, fixed: fx }))
  },
)

const summary = results.map((r, i) => {
  const key = SLOTS[i].key
  if (!r) return { key, status: 'failed (no result)' }
  const review = r.review || null
  return {
    key,
    files: r.impl.files,
    tscClean: r.fixed && typeof r.fixed === 'object' ? r.fixed.tscClean : r.impl.tscClean,
    testsPass: r.fixed && typeof r.fixed === 'object' ? r.fixed.testsPass : r.impl.testsPass,
    findings: review ? review.findings.length : null,
    blockers: review ? review.findings.filter((f) => f.severity === 'blocker').length : null,
    requests: (r.fixed && typeof r.fixed === 'object' ? r.fixed.requests : r.impl.requests) || [],
    deviations: (r.fixed && typeof r.fixed === 'object' ? r.fixed.deviations : r.impl.deviations) || [],
    problems: (r.fixed && typeof r.fixed === 'object' ? r.fixed.problems : r.impl.problems) || [],
    measured: (r.fixed && typeof r.fixed === 'object' ? r.fixed.measured : r.impl.measured) || [],
  }
})
return { slots: summary }
