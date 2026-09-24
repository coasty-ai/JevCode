# Gap-closure wave (wf_b190d4b0-0f3) — hand-offs the two fix passes could not land under their ownership split

Both passes report tsc clean and the whole unit suite green (G1: 553 files / 9,621 passed / 0 failed at --maxWorkers=3). The re-gate agent was stopped by the owner (user: finish quickly) — the owner runs the gates once after the lean pass. The items below are landed by the LEAN pass (slot A = cli/config/session, slot B = tui) — verbatim from the reports.

## fix:G1-coordination-production

### tests
GATES (all re-run at the final tree state)
- npx tsc -p tsconfig.json --noEmit — CLEAN (0 errors).
- node scripts/no-any.mjs — ok (src, test, perf, scripts).
- Whole unit suite, npx vitest run --project unit --maxWorkers=3 — 553 files / 9,621 passed | 8 skipped | 0 FAILED. No failures in any file, mine or otherwise.
- env -u CI npx vitest run --project pty test/pty/round5.pty.test.ts — 6 files-cases passed (was 5; +1 new).
- sh test/pty/run-smoke.sh r5-who r5-who-ascii — BOTH PASS, exit 0, timeouts 0 (was FAIL exit 124, timeouts 1, on both). Requires `node scripts/build.mjs` first: run-smoke drives bin/jevcode.js → dist/jevcode.mjs, so a stale bundle measures the previous commit — that is now recorded in the .steps header and is why the previous wave's row read as unchanged.

MY FILES (vitest counts)
- test/unit/session/coordination.test.ts — 52 cases (was 34, +18).
- test/unit/cli/session-coordination.test.ts — 9 cases (was 5, +4).
- test/unit/cli/sessions.test.ts — 48 cases (+1 case, 2 pins rewritten).
- test/unit/cli/main-sessions.test.ts — NEW, 4 cases.
- test/pty/round5.pty.test.ts — 6 cases (+1: the --ascii / 40-column twin of the two-session /who).
- Combined direct run (those 4 unit files + facts/session-chat/peers/publish/publish-ledger): 237 passed.

LIVE VERIFICATION (real binary, real homes, after node scripts/build.mjs)
- Blocker 1: three separate `jevcode sessions headsup … --json` processes over ONE home → messageIds `bnjl5uuf-tmsufp2u-1`, `bnjl5uuf-zyhdmpco-2`, `bnjl5uuf-raqbfrmp-3` (three distinct ids, three files on disk). Before the fix the review reproduced three IDENTICAL ids and two silently dropped messages.
- Blocker 2: `mkdir -p /tmp/jvfix2 && touch /tmp/jvfix2/coordination && JEVCODE_HOME=/tmp/jvfix2 jevcode sessions who` → `jevcode sessions who: the session ledger could not be opened here (ENOTDIR: not a directory, mkdir '<path>')`, exit 2. No path, and no `4d4e6845` hostKey basename. `--json` → `{ ok:false, reason:"error", message:… }`.
- Finding 3: fresh empty home, `jevcode sessions headsup "nobody is here"` → `delivered to 0 sessions`; `--json` → `{ ok:false, delivered:0 }` (was `ok:true, delivered:1`).
- Finding 11: `jevcode sessions gc --device ffffffff` → `ffffffff is now ignored — its records are hidden from /who and 'jevcode sessions gc' drops them as they expire` (was `gc removed 1 record of ffffffff`).

### deviations
- FINDING 6 (major, idle ledger) — NOT implemented as written; implemented as a MEASURED residual instead, because the prescribed fix contradicts a read-only contract. The fix asks for a sessionless `startReading()` after `renderer.firstFrame()` with `handle.setIdentity()` promotion. Two blockers: (a) an idle session has no row shape — `SessionActivity.kind` is `'run' | 'bench'` (src/coordination/types.ts:467) and a `Heartbeat` needs a `runId` and a claim (src/coordination/records.ts:248), both under the READ-ONLY `src/coordination/**`, so an idle TUI could open a ledger but could never publish a row; two idle TUIs would STILL be invisible to each other, which is the exact symptom the finding names. (b) the half that IS reachable (an idle TUI READING a running peer) needs SessionLedgerInput.runId/sessionId nullable plus a `promote()` through createPublisher's lifecycle — ~150 lines across the write half, in a fix pass with 18 other items. What I did instead: the pty idle case (`r5-who-idle`) now spawns a real `jevcode run … --plain --mock --mock-steps 40` peer under the same JEVCODE_HOME for the whole scenario and asserts the idle TUI still answers `who · unknown`. The residual is now measured and pinned rather than asserted in prose, and it fails the day someone closes it. The follow-up needs a contract change first (an idle `SessionActivity.kind`), which is a design decision, not a fix-pass edit.
- FINDING 9 (major, the `peers` status zone) — NOT fixed: every remaining piece is in G2's frozen files (`src/tui/useEngine.tsx` owns BOTH `UiState` and `UiAction`; `src/tui/App.tsx` owns the `statusView` call). I deliberately did not add a `pushFold()` on the session side either: with no reducer arm to receive it, it would be a dead pointer, which D-AN forbids — the same rule the rest of this wave is enforcing. The exact hunk (four small edits, none in core/types.ts) is in `requests` below, ready to apply. Gap 1 must be reported as PARTIALLY closed: three of its four read sinks (/who, /peers, the chat `peers` fact) are live and tested; the status zone is dark.
- FINDING 19 — I edited `test/pty/run-smoke.sh` (dropped `JEVCODE_FAULT=peer:5` from the r5-who/r5-who-ascii env row). That file is not in my named file list; the finding says the change must be "coordinated with whoever owns run-smoke.sh this wave", and the r5-who rows in it were originally a request from this slot. The edit is one line plus a comment and I re-measured both scenarios after it. Revert if the owner objects.
- FINDING 4 — I took BOTH halves of the offered fix, not one: `SessionsRefusedRow.deviceId` is renamed to `deviceId8` AND its value is now resolved through the fold to a real device id8 (self's when the route is `@all` or the row has left the fold), plus a new `target` field carrying what was actually addressed. Renaming alone would have left a `--json` consumer unable to join at all; resolving alone would have kept a truncated id under a full-id name, which is finding 10's complaint. Recorded beside the §13.2 clause-8 text in the file.
- FINDING 2 — the path stripper lives in `src/session/coordination.ts` as `withoutPaths`, not `collapsePaths` from `src/coordination/leases.ts`. `collapsePaths` collapses a LIST of lease paths to a common prefix; it is not a message redactor, and importing it would put the coordination tree on the `sessions list` path (gate G-R5-1). `withoutPaths` replaces the whole path run with `<path>` rather than its basename, because the basename of a device subtree IS the 8-hex hostKey (`devices/<hostKey>`) and §7 row 61 forbids that in a sink too. A lookbehind keeps a RELATIVE path whole, so a user's own `headsup "editing src/loop/engine.ts"` is not mangled.
- FINDING 14 — `pair` now rejects with a `ConfigError` rather than a bare `Error`, so the new refusal/fault branch keeps its landed exit 2. Without that, the honest "a plain Error is a fault" rule would have demoted a designed refusal to exit 1.
- FINDING 18 — `settingReader` is wired at BOTH sites, which means `src/cli/main.tsx` gained one STATIC import of `src/session/coordination.js`. That module has zero value imports (pinned), so the graph widens by nothing; the import-graph guard in sessions.test.ts was narrowed from `/coordination/` to `'../coordination/'` (i.e. `src/coordination/**` only) and now also asserts that this is the ONE `src/session/coordination.js` edge in main.tsx.
- FINDING 17 — the shared helper is `sessionsVerbOf(flags, io?)` plus `sessionsVerbNeedsCoordination(verb)` / `SESSIONS_INDEX_VERBS`, because the gate in main.tsx needed the verb-list half too, not just the verb computation. main.tsx's inline `verb === 'list' || …` chain is gone.
- MISSING TEST partially covered: "cross-device coverage end to end … a real `--force-takeback`". I added a unit case over a foreign UNVERIFIED origin beside a TRUSTED device (the /who row flag, the inbox row's `unverified`, and the `paired` column are three different answers on one fold). A real `--force-takeback` needs two processes holding two device KEYS and is a `test/pty/**` scenario, not something an injected fold can stand in for; it stays open.
- Two stale source claims in `src/cli/sessions.ts` were corrected while I was in the file: it said `src/cli/args.ts` parses only the first four verbs and that widening it is an open §9.2 request. R5-6's hunk has landed (`src/cli/args.ts:164` parses all seventeen), so the comment was describing a build that no longer exists. Comment-only.

### requests
- R5-H4 (to G2, src/tui/useEngine.tsx + src/tui/App.tsx) — the `peers` status zone, finding 9. FOUR edits, all additive, none in src/core/types.ts.
(1) src/tui/useEngine.tsx, `UiState` (line 147), add two members:
      /** TUI-DESIGN-5 §2.2: the coordination fold, the peer zone's only source; null until the ledger opens */
      readonly fold: import('../coordination/index.js').Fold | null;
      readonly selfId: import('./status/lines.js').PeerZoneSelf | null;
(2) both initial-state literals (the `toolChars: 0` sites, lines ~370 and ~698), add: `fold: null, selfId: null,`
(3) src/tui/useEngine.tsx, `UiAction` union (line 295), add one member:
      | { type: 'peers:fold'; fold: import('../coordination/index.js').Fold; selfId: import('./status/lines.js').PeerZoneSelf }
(4) the reducer, beside `case 'spend:session':` (line 569):
      case 'peers:fold':
        return { ...state, fold: action.fold, selfId: action.selfId };
(5) src/tui/App.tsx line 3230 and line 3391 — `statusView` ALREADY reads `s.fold` / `s.selfId` (src/tui/status/lines.ts:681), so once `UiState` carries them the spread `statusView({ ...state, … })` picks them up with NO further edit at line 3230; line 3391's `statusView(state, …)` likewise. Nothing else changes.
- R5-H4b (the session-side half, MINE to apply once the arm above exists — I have deliberately not landed it, because a dispatch with no reducer arm is a dead pointer). In src/cli/session.ts, inside the fold subscription at line 2515, replace the body with:
      coordUnsubscribe = led.subscribe(() => {
        announcePeerEdge();
        pushFold(led);
      });
and add beside `announcePeerEdge()`:
      /** gate G-R5-3: a beat that moves NO count must produce no dispatch, so two peers beating every 2 s cost 0 frames. */
      let lastZone = '';
      function pushFold(led: SessionLedger): void {
        const self = { deviceId: led.self.deviceId, runId: led.self.runId, sessionId: led.self.sessionId };
        const counts = peerZoneCounts(led.fold, self);            // src/tui/status/lines.ts:538, already exported
        const key = `${counts.live}/${counts.headsUp}/${counts.mail}`;
        if (key === lastZone) return;
        lastZone = key;
        renderer.dispatch?.({ type: 'peers:fold', fold: led.fold, selfId: self });
      }
and reset `lastZone = ''` in `stopPublishing()` beside `peerNoticeArmed = true`. I will land this in one commit with G2's arm, plus the G-R5-3 unit test (a beat that moves no count produces no dispatch).
- docs/STATUS.md (to the orchestrator, not mine to edit): gap 1 should be recorded as PARTIALLY closed, not closed. Live: the thirteen `jevcode sessions <verb>` verbs against the real ledger, and three of the four in-session read sinks (/who, /peers, the chat `peers` fact), each naming WHICH of the two off-reasons applies. Dark: the `peers` status zone (§12.1 S6) — blocked on R5-H4 above; and the idle case — a session that has not run a task still opens no ledger, blocked on `SessionActivity.kind` having no idle value under the frozen contract (see deviations). The pty case `r5-who-idle` now measures that residual with a real peer beating under the same home.

### problems
- `/who` and `/peers` DISAGREE about the same fold, and the fix is in my file but outside the finding set, so I left it. In the r5-who capture (.scratch/pty-smoke/r5-who.txt) line 241 reads `who · 1 live, 0 gone` and line 439 reads `peers · 0 here, 0 stale` for one session. Cause: `listSessions` pushes every `fold.live` row with a hard-coded `'live'` (src/coordination/fold.ts:401), while `peerViewOf` reads `fold.liveness.get(key) ?? 'unknown'` (src/session/peers.ts:108) and an entry is only written when `livenessOf` was called (fold.ts:186) — so our own freshly-adopted row counts as neither live nor stale. This under-counts the chat `peers` fact and will under-count the §12.1 S6 status zone the moment R5-H4 lands. Hunk (src/session/peers.ts:103-122): give `consider` a `fallback: Liveness` parameter and pass `'live'` from the `fold.live` loop, `'gone'` from the `fold.gone` loop, `'unknown'` from forks, then `const verdict = fold.liveness.get(key) ?? fallback;`. I did not apply it: `test/unit/session/peers.test.ts` has its own pinned fixtures and no finding covers it, so changing it unreviewed would be the kind of unmeasured drive-by this pass exists to stop.
- A two-device end-to-end path is still entirely unmeasured. Everything in this wave — unit and pty — is ONE device and at most two processes (`sameDevice: true`, `authority: 'self'`). The unverified/trusted DISTINCTION is now unit-tested over an injected fold, but no test exercises a real foreign `device.key`, a real HMAC verification, or `--force-takeback` across devices. §10.3's whole trust half is therefore live code with no end-to-end evidence.
- `SessionsAckRow.deviceId` → `deviceId8` and `SessionsRefusedRow.deviceId` → `deviceId8` (+ new `target`) are BREAKING `--json` field renames on `sessions inbox --json`, `sessions tell|request|headsup --json`. They are correct (§13.3's `deviceId` promised a full device id and delivered eight characters of a session id) and both are recorded as §13.2 clause-8 amendments in the source, but if any consumer outside this repo reads those keys, this is the release that moves them.
- The r5-who / r5-who-ascii shell smoke reads a STALE bundle unless `node scripts/build.mjs` runs first — `run-smoke.sh` never builds, unlike the vitest pty project's global setup. This is why the previous wave's report could say the row "should re-measure" and the review could measure a FAIL that was already fixed in src. I recorded it in the .steps header; it is still a trap for the next reader of run-smoke.sh and arguably belongs as a build step in that script (not my file).
- Transient, resolved: while I was running the final gates, G2's in-flight work left a scratch file `test/unit/tmpdbg/dbg.test.tsx` in the tree (created 14:38) that broke `npx tsc -p tsconfig.json --noEmit` with a `LaunchSettings` cast error. G2 removed it before I finished and the final tsc is clean. Flagging only because the tree is shared and it may recur in another slot's gate run.

## fix:G2-shell-mounting

### tests
VERIFICATION (all on this worktree, load 5–7):
• `npx tsc -p tsconfig.json --noEmit` → exit 0, clean (whole tree, G1's files included).
• `node scripts/no-any.mjs` → ok (src, test, perf, scripts).
• My files: round5-shell-app.test.tsx 44/44 · import/git-root.test.ts 9/9 (new) · import/lines.test.ts 26/26 · import/reducer.test.ts + models + keys/resolve.test.ts 86/86 · picker.test.tsx 13/13 · round3-commands-app.test.tsx green. Combined tui project directory: 126 files / 3,167 — green except the documented Ink load flake.
• Whole unit suite once, `--maxWorkers=3`: **553 files, 9,622 passed, 8 skipped, 0 failed** on the quiet pass (14:42). A later identical run had 1 failure in a file I did not touch — `test/unit/cli/session.test.ts > the forced-exit epilogue names the current run` — which passes 97/97 alone; two earlier runs each had one `test/unit/tui/app.test.tsx` case red (a different case each time, 75/75 alone), the exact flake family docs/STATUS.md records.
• `env -u CI npx vitest run --project pty test/pty/round5.pty.test.ts` → **6/6 passed** (25.9 s).
• `env -u CI sh test/pty/run-smoke.sh r5-import-overlay r5-import-overlay-ascii` → both **PASS** exit 0, `clears_after_first_frame=1` (the one shrink segment, under the `clears<=1` gate), `no-3j`, no tall frames, `no-key-bytes`, and the new positive checks fire: `r5-import-overlay:keys r5-import-overlay:rows r5-import-overlay:head` / `r5-import-overlay:ascii r5-import-overlay-ascii:keys`.
• `env -u CI sh test/pty/run-smoke.sh r5-model-picker r5-model-picker-ascii` → both **PASS** exit 0, 0 clears, `r5-model-picker:rule`, `no-key-bytes` (these were exit 124 / `MISSING:r5-model-picker-rule` before the picker was mounted).

NEW/CHANGED TESTS, against the MISSING TESTS list:
1. §7 row 91 negative half — `resolve.test.ts` (printables inert, Space no preview, Ctrl-R no rename, Ctrl-A no widen, `x` does not arm, `x`→`y` is not `deleteConfirm`, paste inert; the same pair in the LIST still arms and confirms) + the App-level twin in round5-shell-app (`onDelete` never called, the frame is byte-identical after `x y`, no `delete this session?` row).
2. The card's data identity — open on row A, move the filter under it via `restoreDraft`, assert the card still names s1/r1 and that `cardLines` is only ever called with a real `SessionRow` (recorded call list); plus a pure case where the card's run left the list (one honest row, no `cardLines`).
3. Enter inside the open card resumes the CARD's run (`onOpen` = s1 even after the filter moved to s2) and closes the picker.
4. `gitRootOf` — the new file's 9 cases, including a source-level pin that `src/cli/main.tsx` either imports the shared module or runs the identical bounded `existsSync` walk (no `isDirectory`, no spawn); it flips to the stricter branch the moment request R2 lands.
5. SR trailing edge — three `DOWN`s inside the window, `models: 4 of …` is eventually spoken, total announcements ≤ 3.
6. §7 row 59 behaviour 2 through the shell — a late-resolving `applyImport`, Ctrl-C, `opts.signal.aborted === true`, the `--resume` frame survives and `applied 9 of 9` never paints.
7. Esc during `scanning` — the plan resolves afterwards, overlay stays `none`, nothing repopulates, and no `Import…` block is spoken.
8. `--ascii` of the overlay at 40/80/120 for all six steps + the not-wired hint (row budget ≤ `CAP.import`, width ≤ `blockWidth`, zero unicode cells), plus a MOUNTED `--ascii` App frame with the overlay open carrying no `·→▌↑↓`.
9. `importApplyNotWired` asserted WHOLE at 40/80/120 in both glyph sets, and through the App at 24×80 with a shrink to 12×40 re-picking a different, narrower rung.
10. `IMPORT_PENDING_TOAST` — a non-key printable toasts instead of reaching the composer, and the toast is glyph-folded under `--ascii`.
11. The models arm with NO seam — the pure frame is `MODELS_LOADING` beside an honest rule row, and no App frame ever contains `no model matches`.
12. `pickerFilter`'s remaining keys — `ctrl+a` edits the query (`move home`) vs `picker:allWorkspaces` in the list; `ctrl+r` inert vs `picker:rename`; `x`/`y` are query characters and never arm.
13. `snapshotResults` / `modelProvidersCovered` with 3 providers, `catalogueSettled` false, and `modelCheck(unknown id) === 'warn'` (§7 row 100).
14. The session redactor's exact layer reaches `planImport` (a `config.addSecret`-shaped value that `patternRedact` leaves untouched is masked by what the App passes).
15. `/import --dry-run` — `y` answers with the flag's own sentence, never reaches `applying`, never claims a write.
16. Two extra SR cases: the import twin speaks the step block once then one focus sentence per move (and the rows view never re-speaks the group list), and a key answered with a hint (the apply refusal) is heard, not only painted.
17. `picker.test.tsx` — the tail rows' `--ascii` twins (finding 12).

### deviations
- Finding 6 (the `--plain` twins for `/import` and `/model`) is NOT applied: `src/cli/session.ts` is G1's file this wave and the gap brief says "Do not touch src/cli/** or src/session/**". Ownership wins over "apply every major finding", so the two hunks are filed verbatim in `requests` (R4a/R4b). Until G1 lands them the `--plain` sink still prints `/import is not available in this build …` and `model <current>`, and §13.1's one-producer rule is therefore still open for `--plain` — this is the one finding this pass did not close.
- Finding 4's second half (`redact` at src/cli/main.tsx:667) and finding 7's CLI half (one shared `gitRootOf`; threading `GitState.topLevel` + the resolved workspace through `setGitDirs`) are likewise requests, not edits, for the same ownership reason. The App side of both is done and the shared module exists; the App already ACCEPTS the threaded values (`Bridge.gitDirs` and `TuiRenderer.setGitDirs` gained optional `topLevel` / `workspace` members, which are structurally compatible with session.ts's narrower declared type, so G1's hunk is additive and cannot break the assignment).
- Finding 7 asks for "the session's resolved workspace root for env.workspace". The App cannot compute it — the renderer mounts from argv, before the config resolves — so it reads `bridge.gitDirs.workspace` when the session supplies it (request R3) and falls back to `p.cwd ?? process.cwd()`. The git root no longer depends on that: `gitRootOf` walks for `.git` from whatever workspace it is given, which already fixes the linked-worktree disagreement even before R3 lands.
- Finding 8's fix is split: the ladder lives in `importApplyNotWired(rows, width, glyphs)` (pure), but the App stores the row COUNT on the import record and renders the rung at the current `blockWidth(columns)` in `overlayData`. Storing the rendered string would have frozen the rung at the width it was pressed on, so a resize would still elide it — which is the defect the finding names.
- Finding 5's seam is `(rows, input, opts: { signal, onRow })` as specified, and the App both aborts on Esc/Ctrl-C AND drops a late `applied` (`live.state.interrupted || abort.signal.aborted`). It does not render per-row progress: `ImportUiState` has no progress action and inventing one would put a third owner on the `applying` frame; `onRow` is used only to give the interrupt its real count, which is what §7 row 59 behaviour 2 actually asserts.
- Finding 9's "speak on every state change" is implemented as: a STEP change speaks the step block, anything else speaks one focus sentence, both through the shared trailing-edge coalescer. One extra rule the finding did not name but the tests forced out: when one 400 ms window holds both a step change and a hint (press `y` within 400 ms of the plan landing), BOTH are spoken — the first cut let the block swallow the hint, so the apply refusal reached the frame and not the reader.
- Finding 3's coalescer is a new module-level hook (`useSpokenCoalesced`) shared by both SR surfaces rather than two ad-hoc timers; `modelsSrAtRef` is deleted as dead. Its clock is the App's `now`, its timer is created in an effect and cleared on close and on unmount, so nothing new runs on a render path.
- Finding 1's belt went slightly further than asked: `pickerReducer`'s `preview` / `rename` / `deleteArm` are no-ops while `card !== null` (the finding offered "or clear `card`" — clearing would contradict §2.8's "the card is the pane"), and a PASTE is inert in the card too (it is filter text, and the filter is inert).
- Beyond the numbered findings, one adjacent identity defect was fixed: the picker's `open` op resumed `selectedSession(picker, filter)` even with the card open, so a filter that moved under the card would have resumed a DIFFERENT session than the card named. It now resumes `sessionOfRun(picker, picker.card.runId)`. A `CLOSE_OVERLAY` interrupt on `import` also now routes through `closeImport()` instead of a bare `closeOverlay`, which would have left `importRef` and its open token live behind a hidden overlay.
- `test/unit/tui/keys/resolve.test.ts`'s case "`x` keeps its bare delete arm in the sub-state — the card never steals a landed key" was REWRITTEN, not extended: it asserted the blocker's behaviour as correct on a misreading of §7 row 91 (the row says only r/f/d/w and Esc route). Its lambda was not self-contained, unlike picker.test.tsx's, so the claim and the assertion were both stale.

### requests
- R1 — src/cli/main.tsx (G1), finding 4 second half. In the `case 'import':` arm's `planOptions` object (~line 667), add one member after `decider: null,`:
```
            decider: null,
+           // TUI-DESIGN-5 §5.4 item 1: the CONFIGURED-secret layer. `planImport`'s default redactor is
+           // `redactSecrets(s, undefined)` — the 15 pattern families only — so a `config.addSecret` value that
+           // matches no family survives into `PlanRow.why`, the warnings and the report. `pathsFor` already
+           // returns the session's redactor; the TUI twin now passes exactly the same thing (App.tsx:1658).
+           redact: p.redact,
          },
```
`p` is the `await pathsFor(flags)` result already in scope and `pathsFor` already returns `redact: config.redact` (main.tsx:489), so this is a one-line change with no new plumbing.
- R2 — src/cli/main.tsx (G1), finding 7. Delete the private `gitRootOf` (the 11-line docblock plus the function at ~line 459-468) and import the shared one beside the other static imports:
```
+// TUI-DESIGN-5 §5.5: ONE `gitRootOf` for both import sinks — `/import` (src/tui/App.tsx) binds this module too,
+// so the session and the CLI can never plan different project scopes. Pure, `existsSync` only, no spawn, so it
+// stays legal on the argv path (gate G-R5-1).
+import { gitRootOf } from '../tui/import/git-root.js';
```
The call site (`gitRoot: gitRootOf(p.workspace)`) is unchanged — the shared signature is `(workspace: string, fs?) => string | null`. Check whether `existsSync`, `joinPath`, `dirname` or `resolvePath` become unused afterwards. `test/unit/tui/import/git-root.test.ts`'s last case already anticipates this: it asserts the shared import AND the absence of a second `gitRootOf`, and passes either way today.
- R3 — src/cli/session.ts (G1), finding 7's workspace half. Two edits. (a) the `RendererExtras` type (~line 1444):
```
-    setGitDirs?(dirs: { gitDir: string | null; commonDir: string | null }): void;
+    setGitDirs?(dirs: { gitDir: string | null; commonDir: string | null; topLevel?: string | null; workspace?: string | null }): void;
```
(b) the call site (~line 4636):
```
-    extras.setGitDirs?.({ gitDir: gitAtStart?.gitDir ?? null, commonDir: gitAtStart?.commonDir ?? null });
+    // TUI-DESIGN-5 §5.2: `/import` plans its PROJECT scope from these. `topLevel` is what git itself answered
+    // for the resolved workspace (a linked worktree's root, which no `gitDir` string manipulation recovers),
+    // and `workspace` is that resolved root, which is not `process.cwd()` under `--workspace`.
+    extras.setGitDirs?.({ gitDir: gitAtStart?.gitDir ?? null, commonDir: gitAtStart?.commonDir ?? null, topLevel: gitAtStart?.topLevel ?? null, workspace: workspaceRoot });
```
The App side is already landed and both members are optional, so this compiles before and after.
- R4a — src/cli/session.ts (G1), finding 6, the `/import` `--plain` twin. Replace the two-line `case 'import':` refusal (~line 3927):
```
-      case 'import':
-        note('/import is not available in this build — jevcode import plans, reviews and applies from the CLI', { label: '[ui]', level: 'warn' });
-        return;
+      case 'import': {
+        /**
+         * TUI-DESIGN-5 §13.1 / §5.7: ONE producer, two sinks. `App.tsx` intercepts `/import` and opens the
+         * overlay, so this arm is the `--plain` (and `--screen-reader`) twin — the SAME `initImportUi` state,
+         * printed as the numbered form. It must never be a second sentence.
+         */
+        const { planImport, summarisePlan, applicableRows } = await import('../import/index.js');
+        const { initImportUi } = await import('../tui/import/reducer.js');
+        const { IMPORT_DRY_RUN_REFUSAL, IMPORT_NOTHING_FOUND, importPlainLines, importScreenReaderLines } = await import('../tui/import/lines.js');
+        const { gitRootOf } = await import('../tui/import/git-root.js');
+        const plan = await planImport({
+          env: { home: homedir(), env: process.env, platform: process.platform, workspace: workspaceRoot, gitRoot: gitRootOf(workspaceRoot), extraRoots: [] },
+          jevcodeVersion: VERSION,
+          trust: 'session',
+          decider: null,
+          redact: config?.redact ?? patternRedact, // §5.4 item 1, exactly as the TUI twin passes it
+          ...(a.source !== null ? { optIn: [a.source] } : {}),
+        });
+        if (plan.rows.length === 0) {
+          note(IMPORT_NOTHING_FOUND, { label: '[ui]', level: 'warn' });
+          return;
+        }
+        const input = { plan, summary: summarisePlan(plan), applicable: applicableRows(plan, { scope: 'both' }) };
+        const ui = initImportUi(input);
+        // §5.7: the prompt is printed only when something reads the answer, and nothing in this build does
+        const rows = o.launch.screenReader === true ? importScreenReaderLines(ui, { prompt: false, input }) : importPlainLines(ui, input, columns(), glyphs(), { prompt: false });
+        textBlock(rows[0] ?? 'Import', rows.slice(1));
+        note(a.dryRun ? IMPORT_DRY_RUN_REFUSAL : 'jevcode import --yes applies this plan', { label: '[ui]' });
+        return;
+      }
```
Adapt the locals to session.ts's names (`workspaceRoot`, `config`, `o.launch`, `columns()`, `glyphs()`); `a.dryRun` and `a.source` are already on the `import` CommandAction (dispatch.ts:138). Then add an `r5-identity`-style case asserting the `--plain` rows and the TUI overlay rows come from the same `importPlainLines` / `importRendered` producers over one `initImportUi`.
- R4b — src/cli/session.ts (G1), finding 6, the `/model` `--plain` twin. Inside `case 'model':`, in the `id === null || id.trim() === ''` branch (~line 3583), keep the current/pending line and append the numbered list:
```
           const currentModel = generatorModelLabel();
           note(pending.model !== undefined && pending.model !== currentModel ? `model ${currentModel} (next run: ${pending.model})` : `model ${currentModel}`);
+          /**
+           * §6.4 D-AQ: the TUI opens the pane-slot picker here (`App.tsx`'s `case 'model'`), so this is its
+           * `--plain` twin — the numbered one-shot list and its prompt, from the same producers the picker
+           * uses, never a pane. Everything is bundled and offline: `instantCatalogue()` costs no I/O.
+           */
+          const models = await import('../models/index.js');
+          const { MODELS_PLAIN_CAP, modelsPickPrompt, modelsPlainLines } = await import('../tui/models/lines.js');
+          const { snapshotResults } = await import('../tui/models/state.js');
+          const rows = models.instantCatalogue();
+          const lines = modelsPlainLines({ models: rows, text: models, results: snapshotResults(rows, models.SNAPSHOT_AT), total: rows.length, columns: columns(), glyphs: glyphs(), prompt: false });
+          textBlock(lines[0] ?? 'models', lines.slice(1));
+          note(modelsPickPrompt(Math.min(rows.length, MODELS_PLAIN_CAP)), { label: '[ui]' });
           return;
```
`modelsPlainLines`' options are `{ models, text, results?, nowMs?, columns?, glyphs?, cap?, total?, prompt? }` (src/tui/models/lines.ts:303). Note the TUI never reaches this arm without an id, so the picker and this twin cannot both answer.

### problems
- The `--plain` half of gap 2 is still open (finding 6). Every mounted surface now has an SR twin, an `--ascii` twin and a pure `--plain` producer with tests, but nothing ROUTES the plain producers: in a `--plain` session `/import` and `/model` still print the round-4 refusal and `model <current>`. Closing it is R4a/R4b in `src/cli/session.ts`, which this wave's ownership assigns to G1.
- `ImportUiState` still has no dry-run member: `/import --dry-run` is refused from the App's record (`ImportSession.dryRun`), not from the reducer. If a future caller drives `importReducer` directly (the CLI's own overlay path is the obvious candidate) the flag will not travel with the state. Threading it into the reducer is one member plus one guard in `case 'apply'`, and it belongs with the apply seam rather than ahead of it.
- The apply seam is still absent in production, so the whole of §7 row 59 behaviour 2 is exercised only through an injected `applyImport`. The abort plumbing, the `onRow` count and the late-`applied` drop are asserted at the App level, but no real writer has ever been aborted mid-plan — that check arrives with `ApplyOptions`.
- `useSpokenCoalesced`'s trailing timer is real (`setTimeout`), so a test that asserts a coalesced announcement waits ~400 ms of wall clock. The three cases that do this (`models` trailing edge, the import step/focus pair, the spoken apply refusal) pass `waitFor(..., 4000)`; on a heavily loaded machine they are the most likely new timing flakes in the file.
- Two pre-existing Ink-timing flakes fired during the full-suite runs and are NOT mine: `test/unit/tui/app.test.tsx` (a different case on each of two runs; 75/75 alone) and `test/unit/cli/session.test.ts > the forced-exit epilogue names the current run` (97/97 alone). Both are in the family docs/STATUS.md already records for this machine.
- `test/unit/tui/import/git-root.test.ts`'s CLI-equivalence case is a SOURCE pin, not a behavioural one, because `src/cli/main.tsx`'s copy is private and unexported. It asserts the algorithm (a bounded `existsSync` walk, no `isDirectory`, no spawn) and flips to the stronger "there is no second copy" branch the moment R2 lands; until then two functions with the same name still exist, even though they now agree.
