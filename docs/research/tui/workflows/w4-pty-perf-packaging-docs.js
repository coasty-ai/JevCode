export const meta = {
  name: 'tui-wave-4',
  description: 'Wave 4 of the JevCode interactive TUI: pty suite, perf gates, packaging/release, documentation; each reviewed and fixed',
  phases: [
    { title: 'Implement', detail: 'pty suite; perf probes and gates; polish follow-ups; docs (packaging ran separately)' },
    { title: 'Review', detail: 'one adversarial reviewer per slot' },
    { title: 'Fix', detail: 'implementer applies the findings' },
  ],
}

const REPO = args.repo
const DATE = args.date

const COMMON = `You are an implementer on the JevCode interactive TUI (repo ${REPO}; TypeScript strict, ESM, Node 22.23.2, no 'any'; runtime deps ONLY ink 7.1.1 + react 19.3.0). Today is ${DATE}. THE SPEC is ${REPO}/docs/TUI-DESIGN.md (read the D1-D15 table, section 0, and the sections your brief names; section 24 for strings). Waves 0-3 are on disk and committed: the interactive TUI works (chat and run modes, --plain, --json). The pty driver is scripts/pty/drive.exp (read docs/research/tui/20-pty-driver-findings.md for usage, the sentinel caveat, the one-clear-per-shrink fact and the early-Ctrl-C note).
OWNERSHIP RULES (hard): edit ONLY your slot's files (src/tui/** and src/cli/** belong to the polish slot in this wave; src/perf/** to the perf slot; test/pty/** to the pty slot; docs to the docs slot); other slots run concurrently; another team owns src/synth/**, src/loop/stages/**, experiments/**, bench data, and the jev-only parts of docs/DECISIONS.md, docs/STATUS.md and docs/DESIGN.md (re-read those files right before editing and change only TUI-related text; never rewrite their other sections). Never run git add/commit/stash/checkout; never add a runtime dependency. package.json edits are allowed ONLY for the packaging slot and only as the brief says.
QUALITY BAR: production quality; measured numbers reported with the exact command; nothing claimed that was not run; no TODOs.
REPORT (structured): files, what was verified with which command, measured numbers, deviations with reasons, requests, problems.`

const SLOTS = [
  {
    key: 'W4-pty-suite',
    brief: `SLOT pty suite (section 19.5, 19.8). Files: test/pty/** (a vitest project 'pty': tests spawn scripts/pty/drive.exp via node:child_process with stdio 'ignore' + a temp JEVCODE_HOME, PTY_ROWS/PTY_COLS per case, CI removed from the child env; skipIf(!existsSync('/usr/bin/expect')); each test asserts on the capture and timing JSONL), vitest.config.ts (add the 'pty' project: include test/pty/**/*.pty.test.ts, fileParallelism false, testTimeout 180 s), package.json scripts ONLY: add "test:pty": "vitest run --project pty" (touch nothing else in package.json), test/pty/helpers.ts (spawn wrapper, capture parsing: count ESC[2J per geometry segment, dynamic-region row count between the last rule line and the status line, SGR counting, sentinel helpers using the cursor-hide ESC[?25l rule). Scenarios (each its own test, all with --mock so no network): chat first frame (< 300 ms warm, composer visible, 'step 0/' sentinel); typing + Enter starts a run and the composer keeps focus; steer while live → 'steer queued' item; Esc pause → human_pause exit 4 in run mode; Ctrl-C matrix cells S0 (hint then exit 0 on the second press), S1 (clears draft), S2 one-shot (exit 130 + epilogue), S2 session (run:end item, composer reopens), S3 (clear draft, run continues); review: box appears only after ~1 s idle, type-ahead 'y' does not approve, 'y' approves, 'n' declines, 'd note' declines with the note in transcript.log; Ctrl-D twice exits 0 idle and opens the confirm while live; resize storm (30 resizes 2 ms apart via repeated 'resize' steps) → no crash, 0 clears after a grow, ≤ 1 per shrink; tiny terminal 12x60 and 8x40 dynamic region ≤ rows-2; 20 KB paste (send the text between ESC[200~ and ESC[201~) → one chip; secret-looking paste → the gate row, Esc dismisses; /exit while live → confirm; NO_COLOR → 0 SGR; --plain TTY readline composer runs a mocked task; --json on a pipe → valid NDJSON envelope; Ctrl-Z then fg is documented as manual (no test) unless you can drive it with expect's job control — try 'send \\x1a' then 'exec kill -CONT' on the pid and assert the repaint; and the three-way transcript identity: after a mocked run, diff <run>/transcript.log against the plain renderer's output and against the TUI's <Static> lines extracted from the capture (strip ANSI) — they must be identical line for line. Run the whole suite twice and report timing and flakiness; make it deterministic (no fixed sleeps where an expect on a sentinel works).`,
  },
  {
    key: 'W4-perf-gates',
    brief: `SLOT perf gates (section 18; docs/DESIGN.md section 12; README performance table). Files: src/perf/{first-frame,render-lag,step-overhead,main}.ts (edit), src/perf/{composer-latency,states,static-append}.ts (new), perf/results/latest.json (regenerated), README.md Performance section ONLY (update the table with the new numbers and rows; do not touch other README sections — the docs slot owns them), perf/drivers/pty_type.py only if a Python typist is genuinely needed (prefer expect steps). Gates to implement and run: first frame cold p95 < 300 ms for BOTH 'run' and 'chat' geometries (24x80, 40x120) with zero network asserted; composer keystroke → frame p95 < 16 ms and max < 50 ms in a real pty at the A109 region (drive 200 keystrokes with 30 ms spacing through drive.exp, timestamp each frame from the capture's synchronized-output brackets ESC[?2026h/l relative to the send timestamps in the timing JSONL); event-loop lag p95 < 5 ms / max < 50 ms while typing during a live mocked run (--perf-lag-probe); zero ESC[2J after the first frame per geometry segment (assert ESC[3J, ESC c and ESC[?1049h never appear); harnessMs p95 < 50 ms per step with imagesMs p95 reported (< 15 ms); Static append bytes per committed line at the realistic region (report, no gate); frame count per second ≤ maxFps. Run 'npm run perf' on a quiet machine (check 'uptime' load; if load average > 8, wait and retry up to 3 times, and report the load at measurement time), write perf/results/latest.json, and update the README table with the measured values, dates and gates. Report every number.`,
  },
  {
    key: 'W4-polish',
    brief: `SLOT polish: the cross-slot follow-ups the wave 3 reviewers and integrator left, all small and design-cited. Files: src/tui/** and src/cli/** (you are the only slot editing them in this wave; the perf slot edits src/perf only), src/core/types.ts and src/loop/engine.ts ONLY for the EngineOptions.log item, and their tests under test/unit/tui/** and test/unit/cli/**. Items: (1) src/tui/keys/resolve.ts: a bare 'r' on an empty draft while state.retrying !== null resolves to { type: 'retryNow' } (remove App.tsx's interception); a one-row draft satisfies both the Up and Down history rules (cursorRow 'only' or rows === 1) and App.tsx's per-key cursorRow override goes. (2) src/tui/glyphs.ts: spinnerStatic is '•' (ascii '*') under reduced motion; status/lines.ts reads it. (3) fatal restore: src/cli/main.tsx + session.ts pass restore: restoreTerminal from src/tui/terminal.ts into wireFatalHandlers so the exit string (RESTORE, 'CSI 0 SP q') is written exactly once at every exit (measured twice today in all 15 chat/run scenarios; assert once in a pty step). (4) session.ts: after resolveConfig (and before each run when limits change) dispatch { type: 'thresholds', complete, impossible } to the renderer so decision rows' '!' marker and consumedBy follow a non-default --complete-threshold. (5) session.ts: after run:end read the live session meter cap when pushing session spend into the status (today '/budget session-spend-cap 0.01' shows sess $0.00/0.01 then reverts to /10.00 after run:end). (6) Wizard: wizard.cancel() and onDone without a save/trust call bridge.wizardHost.cancel?.() (add cancel?(): void to WizardHost) so the overlay watch becomes redundant. (7) TuiRenderer.promptSecretGate(hits): Promise<boolean> — the §4.10 gate row for an argv task before run:ready; cli/tui-prompter.ts already forwards it when present. (8) EngineOptions.log?: Log (src/core/types.ts additive; src/loop/engine.ts writes its notice/warn lines to it) so engine lines reach <runDir>/jevcode.log (§13.6); session.ts passes the run log. (9) Input path: split a coalesced useInput chunk at control bytes and CR ('\\x03\\x03' in one read must count as two Ctrl-C presses; a trailing CR is Enter; an interior newline in an unbracketed chunk is paste-like) per §4.5 step 1 — implement in the App input path (or a pure helper in src/tui/keys/ with tests). (10) --version --json prints { name, version, node, ink, react } (§17.3). (11) docs/TUI-DESIGN.md §15 item 20: add the run:idle and thresholds rows; §4.5 step 1: the chunk-splitting rule; §18/§19.5: the zero-clears gate per geometry segment with ≤ 1 clear per shrink segment; §6.3: the arming rule 'committed frame AND ≥ 150 ms' — edit only those paragraphs. Verify with tsc, no-any, 'npx vitest run --project unit test/unit/tui test/unit/cli test/unit/loop', 'npm run build' and 'sh test/pty/run-smoke.sh' (19/19 must stay green; add a step asserting the single RESTORE).`,
  },
  {
    key: 'W4-docs',
    brief: `SLOT documentation (section 21). Files: README.md (all sections EXCEPT Performance, which the perf slot owns: rewrite Install (zero dependencies, npx, npm i -g, brew tap), a new "Interactive session" section (bare jevcode, composer keys, slash commands, sessions/follow-ups/steering/pause, picker, review keys and what is never offered, Jev pane tabs), "Money", "Secrets" (with the addSecret resume caveat and the redaction guarantee wording of section 8.9), "Exit codes" table from section 13.5, "Windows" note, keep and update Run/Configuration (new flags/settings from section 16) and Sandbox; keep the Bench and jev-only sections intact), docs/TUI.md (the user guide: modes, keys, sessions, money, secrets, undo/diff, errors, exit codes, terminal setup notes per terminal from the research matrix), docs/KEYS.md and docs/COMMANDS.md (regenerate with scripts/gen-docs.mjs; verify the sync test), docs/DESIGN.md amendments per section 21 (section 4 contract 1.1 pointer, section 9 index/lock/images/seed/human_pause, section 10 composer/layout/labels/annotate/--json guarantee, section 11 state-mutation amendment + exit-code table + fatalExit order, section 12 new gates) — edit ONLY those TUI-related paragraphs and re-read the file first because another team edits it concurrently, docs/STATUS.md (append a dated "Interactive TUI" section: what was built, verified with which commands and pty scenarios, measured numbers (take them from perf/results/latest.json and test output — do not invent), what is unverified, open questions), docs/research/tui/terminal-matrix.md (the checklist from research 07 section 7/8 consolidated), CHANGELOG.md (new, 0.2.0 entry). Every claim in the docs must be checked against the code on disk (read src/cli/args.ts, src/tui/commands/registry.ts, src/tui/keys/bindings.ts, docs/TUI-DESIGN.md section 24) — no drift between docs and behaviour; where the implementation deviates from the design, document the behaviour, not the design, and list the deviation in docs/STATUS.md.`,
  },
]

const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    verified: { type: 'array', items: { type: 'string' } },
    measured: { type: 'array', items: { type: 'string' } },
    deviations: { type: 'array', items: { type: 'string' } },
    requests: { type: 'array', items: { type: 'string' } },
    problems: { type: 'array', items: { type: 'string' } },
    pass: { type: 'boolean' },
  },
  required: ['files', 'verified', 'deviations', 'requests', 'problems', 'pass'],
}
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, file: { type: 'string' }, problem: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' } }, required: ['severity', 'file', 'problem', 'evidence', 'fix'] } },
    unverifiedClaims: { type: 'array', items: { type: 'string' } },
  },
  required: ['findings', 'unverifiedClaims'],
}

phase('Implement')
const results = await pipeline(
  SLOTS,
  (s) => agent(`${COMMON}\n\n${s.brief}`, { label: `impl:${s.key}`, phase: 'Implement', schema: IMPL_SCHEMA }).then((r) => (r ? { ...r, key: s.key } : null)),
  (impl, s) => {
    if (!impl) return null
    return agent(`You are an ADVERSARIAL REVIEWER for slot ${s.key} (repo ${REPO}, spec ${REPO}/docs/TUI-DESIGN.md, today ${DATE}). Files reported: ${impl.files.join(', ')}. Read the brief and the design sections it names, then read every file, RE-RUN every verification command the implementer claims (and the pty suite / perf run where relevant), and check every number and claim against reality: docs that describe behaviour the code does not have, perf numbers not reproducible, tests that pass vacuously, skipped scenarios, package files missing from the allowlist, licenses missing, flakiness (run the pty suite twice). Return up to 20 findings ranked by severity with evidence and a concrete fix, plus the list of claims you could not verify. Do not modify files.\n\nSLOT BRIEF:\n${s.brief}\n\nIMPLEMENTER REPORT: verified=${JSON.stringify(impl.verified)} measured=${JSON.stringify(impl.measured || [])} deviations=${JSON.stringify(impl.deviations)} problems=${JSON.stringify(impl.problems)}`, { label: `review:${s.key}`, phase: 'Review', schema: REVIEW_SCHEMA }).then((rv) => ({ impl, review: rv }))
  },
  (pair, s) => {
    if (!pair || !pair.review) return pair
    const fixable = pair.review.findings.filter((f) => f.severity !== 'minor')
    const minors = pair.review.findings.filter((f) => f.severity === 'minor')
    if (fixable.length === 0 && pair.review.unverifiedClaims.length === 0) return { ...pair, fixed: 'nothing to fix' }
    const text = [...fixable, ...minors].map((f, i) => `${i + 1}. [${f.severity}] ${f.file}: ${f.problem}\n   evidence: ${f.evidence}\n   fix: ${f.fix}`).join('\n')
    return agent(`${COMMON}\n\nYou are the implementer of slot ${s.key} again, in the FIX pass (files: ${pair.impl.files.join(', ')}). Apply every blocker and major finding, the minors unless they contradict the design, and re-verify or remove every unverified claim. Re-run the verification. Report what changed per finding.\nFINDINGS:\n${text}\nUNVERIFIED CLAIMS: ${JSON.stringify(pair.review.unverifiedClaims)}\n\nSLOT BRIEF:\n${s.brief}`, { label: `fix:${s.key}`, phase: 'Fix', schema: IMPL_SCHEMA }).then((fx) => ({ ...pair, fixed: fx }))
  },
)

return {
  slots: results.map((r, i) => (r ? { key: SLOTS[i].key, files: (r.fixed && typeof r.fixed === 'object' ? r.fixed.files : r.impl.files), pass: (r.fixed && typeof r.fixed === 'object' ? r.fixed.pass : r.impl.pass), measured: (r.fixed && typeof r.fixed === 'object' ? r.fixed.measured : r.impl.measured) || [], findings: r.review ? r.review.findings.length : null, problems: (r.fixed && typeof r.fixed === 'object' ? r.fixed.problems : r.impl.problems) || [] } : { key: SLOTS[i].key, status: 'failed' })),
}
