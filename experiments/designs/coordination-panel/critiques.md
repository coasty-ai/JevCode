{
  "deliverable": "/Users/prateekjannu/Documents/vscode/JevCode/docs/COORDINATION-DESIGN.md",
  "reviewed_at_head": "9c3a7ac",
  "compliance": "read-only: no edits, no commits, no live API calls, no keys printed",
  "verdict": "REVISE BEFORE W0 — architecture sound (serverless single-writer ledger, advisory default, pause = stop + replay cache, two context windows, most anchors hold), but five load-bearing mechanisms do not work as written (D1–D5), three documented UX claims are false against HEAD (D6–D8), and two schema-level gaps (D9, D13/D18) change W0/W1 contracts. Fix D1–D9, D13, D18 in the text, then re-verify; W2+ can stand.",
  "defects": [
    {
      "n": 1, "severity": "high", "where": "§3.2 stamp row; §3.1 `commons/<deviceId>/device.json` 'rewritten every 60 s while any run is live'; §4.5 fencing; §9.3 takeover",
      "why": "The Lamport counter is per DEVICE but issued by every PROCESS on that device: two sessions on one Mac each hold their own `n` → identical `(n, deviceId)` stamps, so the same-device double-claim window (§4.5, M3) — the one case the design says is 'a decision' — has no total order to break the tie. `device.json` then has as many writers as live runs (rule 1 violated). Persisting `n` only every 60 s means a crash re-issues stamps LOWER than ones already published (a later takeover lease can lose to the device's own stale lease).",
      "fix": "stamp = `{ n, deviceId, runId }` with runId as the tiebreak (unique, already validated). Each run keeps its counter in its own heartbeat/lease records; at `ledger.open()` `n = max(all stamps observed in own subtree + fold) + 1`. `device.json` is written only by the CLI (create / `sessions label`), never on a timer. Remove the 60 s rewrite from §3.1 and add a `records.test.ts` case: two processes, same device, same `n`."
    },
    {
      "n": 2, "severity": "high", "where": "§4.3 step 4 ('at once when the peer's expiresAt is > 60 s away and its heartbeat is fresh') vs step 7 (renew `expiresAt` = now + 10 min every 15 s)",
      "why": "For any live peer `expiresAt − now ≥ 9 m 45 s` at all times, so the skip clause is always true: the inline wait NEVER runs, every strict conflict goes straight to the rule-1 discard + `lease-conflict` pane, and M2 ('proceeds without a rule-1 discard') fails by construction.",
      "fix": "Delete the expiresAt clause. Skip the inline wait only when the peer's `stage === 'execute'` on a `command` lease with `exclusiveTree`, or the peer is `blocked`/`pausing`; otherwise wait inline up to `strictWaitMs`."
    },
    {
      "n": 3, "severity": "high", "where": "§4.3 step 1 ('written asynchronously … fire-and-forget; awaited only in finish') + §4.5 re-fold; §4.2 budget claim 'no file I/O'",
      "why": "The re-fold is a write-then-read fence; it only closes the window if the own exclusive lease's rename has COMPLETED before the peer dir is read. With a fire-and-forget write both sessions can readdir before either file exists → both proceed (M3 flaky). §4.2's 'no file I/O' also contradicts §4.5's readdir.",
      "fix": "Under `strict`: `await ledger.writeLocal(exclusive)` (rename done, no fsync) then readdir — one awaited ~1 ms write + one readdir on the step path; state `coordinateMs` p95 < 5 ms for strict, < 2 ms for advisory (which keeps fire-and-forget)."
    },
    {
      "n": 4, "severity": "high", "where": "§3.3 write point (3) 'a 15 s timer while any stage is in flight'; §3.4 same-device rule `now − beatAt < ttlMs`",
      "why": "A run parked on a blocking pane (`jev-unreachable` backoff up to 5 min at engine.ts:1160-1167, `spend-limit`, the new `lease-conflict` pane) is in no stage → no beats → after 45 s same-device peers and the resume card read it as stale/'crashed during step 8', its leases are ignored, and a device-B `takeRunLock` (foreignLive false) takes it over while the process is alive and about to continue.",
      "fix": "Timer runs from `run:ready` until `phase:'ended'` regardless of stage. Same-device liveness = `phase !== 'ended' ∧ isPidAlive ∧ startedAt ≥ bootAt`; beat age becomes only a `hung?` display flag (also removes the wall-clock skew exposure for same-device records)."
    },
    {
      "n": 5, "severity": "high", "where": "§4.5 last paragraph; §4.6 row 2; §11 (no row) — the task's 'lease holder paused for a day'",
      "why": "A laptop lid closed or Ctrl-Z mid-step: peers mark the holder stale after `ttl`, ignore its leases and edit the files; on wake the engine continues from wherever it was — pre-images already taken (engine.ts:2218-2221) — and `execute` applies an edit over the peer's version. §4.5 only detects this post-hoc (`theyTouched`). A paused RUN (process gone) is covered; a suspended PROCESS is not.",
      "fix": "Detect wake at the coordinate gate AND immediately before `execute`: if `monotonicNow − lastBeatMono > ttlMs`, re-run coordinate and compare each target's sha256 with the pre-image; mismatch → rule-1 discard with `harnessProblem 'targets changed while suspended'`, `replayable:false`. Add §11 row 39 + `engine-suspend.test.ts` (fake clock jump)."
    },
    {
      "n": 6, "severity": "medium-high", "where": "§11 row 38 ('abort() wins … exit 130'); §7.2 pause-now via the shared controller",
      "why": "engine.ts:882 `if (!this.controller.signal.aborted) this.controller.abort(new AbortError(reason…))` — after pause-now the signal is already aborted with `human_pause`, so `abort('human_abort')` skips it; the loop top (:1087) and `handleStepError` (:2552) classify `this.signal.reason` = `human_pause` → exit 4, `stopReason:'human_pause'`, and `markLastResort` (:892) only fills a null stopReason. Esc Esc after Ctrl-<chord> does not abort.",
      "fix": "Either `abort()` records `this.abortOverride = reason` when the signal is already aborted and `finish()`/classify callers prefer it, or pause-now aborts a dedicated `pauseController` combined into stage signals with `AbortSignal.any([controller.signal, pauseController.signal])`, leaving `abort()` sole owner of the shared controller."
    },
    {
      "n": 7, "severity": "medium-high", "where": "§5.3 target grammar `<runId8> | <sessionId8>`",
      "why": "`RUN_ID_RE = /^\\d{8}-\\d{6}-[a-z2-7]{8}$/` (engine.ts:212) and `sessionId` defaults to the run id (session.ts:1885): the first 8 chars are `YYYYMMDD`, identical for every run of the day, so every `/pause <runId8>` is ambiguous.",
      "fix": "Address by the trailing 8-char random suffix or any unique substring: resolver matches `id.endsWith(x) || id.includes(x)`; document as `<id-suffix>`."
    },
    {
      "n": 8, "severity": "medium-high", "where": "§7.2, §7.6, §12 item 22, §14 Q1 — `run:pauseNow` default `ctrl+g` 'free in every context'",
      "why": "src/tui/keys/bindings.ts:111 already binds `ctrl+g` to `composer:externalEditor`. The design's own verification note ('Ctrl-P is history-prev … proposed as Ctrl-G instead') checked one key and not the other.",
      "fix": "Choose an unbound chord (e.g. `ctrl+]` or `alt+p`; not `ctrl+\\` = SIGQUIT), or ship `/pause now` only and let users bind via keybindings.json; add a uniqueness assertion over `BINDINGS` in the bindings test if none exists."
    },
    {
      "n": 9, "severity": "medium", "where": "§5.1 acks `acks/<msgId>.json`, msgId `<deviceId>-<n>`, GC 'once an ack exists', `<runDir>/coordination/seen.json`",
      "why": "(a) Two runs on one device consuming the same `@<repoKey>`/`@all` message write the same ack file (rule 1). (b) The sender deletes a broadcast on the FIRST ack, before other sessions/devices saw it. (c) With per-process counters (D1) two processes mint the same `<deviceId>-<n>` → `seen.json` dedupe drops a real message. (d) `seen.json` per run dir loses dedupe across runs of one TUI session.",
      "fix": "msgId = `<deviceId>-<runIdSuffix8>-<seq>`; acks at `acks/<msgId>/<sessionId>.json`; targeted messages GC on ack, broadcasts only on expiry; seen-set per session under `sessions/seen/<sessionId>.json`."
    },
    {
      "n": 10, "severity": "medium", "where": "§6.5 `.jevcode-worktree` marker + `.jevcodeinclude`; §6.6 sweep guards (a) and (c)",
      "why": "Both files are untracked inside the worktree; `git status --porcelain --untracked-files=all` (src/workspace/git.ts:162, lanes.ts:159) lists them, so guard (c) 'clean' never holds → session worktrees are never swept. A crash between `git worktree add` and the marker write leaves an orphan guard (a) never matches → also never swept.",
      "fix": "Make `git worktree add --lock --reason 'jevcode:<runId>:<sessionId>'` the marker (written atomically with creation); keep metadata in `<commonDir>/worktrees/<name>/jevcode.json` (outside the checkout); if a file in the tree is still wanted, add it to `<gitdir>/info/exclude`."
    },
    {
      "n": 11, "severity": "medium", "where": "§9.3 fork rule ('lower stamp holds; higher stops exit 2'), import 'refused if a local dir exists with a newer state.step', `--force-takeback`",
      "why": "The loser has already committed steps into its own run dir and edited its clone before it sees the winner (minutes of iCloud lag). Later imports choose by step COUNT, which the loser may have more of, so the fork's losing branch can overwrite the winner; after a takeback import A's `pre/` still holds A's pre-images for step numbers now occupied by B's steps → `/undo` restores the wrong bytes.",
      "fix": "Loser writes `run.json.forked = { atStep, loserStamp, winnerStamp }` and renames its diverged tail to `steps.forked-<stamp>.jsonl`; imports prefer the stamp winner regardless of step; an import moves `pre/`,`post/` to `*.forked/` and records `undoUnavailableBelow`."
    },
    {
      "n": 12, "severity": "medium", "where": "§5.4 `request-release` ('will not START a step whose targets overlap … until released or 10 min pass')",
      "why": "Under `claims:'advisory'` this is a peer-induced delay of up to 10 min — contradicts G1(b), §2.1 rule 3 and §10.9 ('never block a run without the human's [c] continue').",
      "fix": "Advisory: fact + `[session]` notice + `## Other sessions` line only. Strict: honoured, bounded by `strictWaitMs`, with the same `[c] continue` escape."
    },
    {
      "n": 13, "severity": "medium", "where": "§7.2 execute row ('NOT interrupted … commits with judge:null, interruptedAt:{stage:'judge', reason:'human_pause'} (rule 3)')",
      "why": "Rule 3 (engine.ts:2570-2575) fires only when an ABORT reaches `handleStepError` after `executeFinished`; the row says the controller is not aborted. `takePostImages` (:2339) sits between execute and judge (:2347), and `stage()` (:1539) does no signal pre-check, so 'abort after execute' would race post-images or actually start the judge call.",
      "fix": "Specify: after `executeFinished` and `takePostImages`, if `pauseNow` is set skip `stage('judge')`, set `draft.judge = null; draft.interruptedAt = { stage:'judge', reason:'human_pause' }` directly (no signal), commit, and let `pauseRequested` end the run at the loop top; expose `EngineStatus.pauseNow` for the 'execute finishes first' status."
    },
    {
      "n": 14, "severity": "medium", "where": "§6.5 children 'with the same sessionId'; §9.4 `-c`; picker rows",
      "why": "`foldIndex` (index.ts:322-357) marks a session live while ANY of its runs is live and `resolveResumeTarget` (picker-lines.ts:313) resolves a session to its newest run: with a live child the paused parent shows `● live` and `-c` offers watch instead of resume; after the child ends the session's newest run is the child (worktree workspace) → Enter resumes the child and trips relocation prompts. `RunRow.parentRunId` exists but no fold rule uses it.",
      "fix": "Fold rule: runs with `parentRunId !== null` and `RunMeta.worktree` never set `SessionRow.live`, never become the session's default run, and render indented under the parent; or give children their own sessionId + `parentSessionId`."
    },
    {
      "n": 15, "severity": "medium", "where": "§4.1 'coordination.enabled forced off for source !== \"cli\"'; task case 'a bench of 30 runs each registering'",
      "why": "A TUI session on the same device cannot see that a 30-task bench is saturating CPU and `git worktree` lanes; `sessions who` shows nothing; G1 'knows what the others are doing' fails for the heaviest workload the repo runs.",
      "fix": "One presence-only heartbeat per bench PROCESS (`kind:'bench', benchId, tasks live/done, lanes, spend`, `claims:off`); per-run heartbeats stay off (512 cap safe)."
    },
    {
      "n": 16, "severity": "medium", "where": "§3.2 `repoKey = sha256(sorted root-commit oids)` via `git rev-list --max-parents=0 HEAD`",
      "why": "In a `--depth` clone the shallow boundary commits have no recorded parents and are returned as roots → a different repoKey from a full clone of the same repo (CI / a fresh shallow clone on device B never matches leases or handoffs). Unborn HEAD errors.",
      "fix": "If `git rev-parse --is-shallow-repository` is true or HEAD is unborn, fall back to `sha256(normalised origin URL)` tagged `kind:'remote'`; record both keys in the heartbeat; matching accepts either."
    },
    {
      "n": 17, "severity": "medium", "where": "§4.6 row 4 (`sessions gc --device … removes its subtree LOCALLY only`) vs §9.1 (reads fold `<sharedDir>/jevcode-commons/*` directly)",
      "why": "In shared-dir mode there is no local copy of a foreign subtree, so the GC is a no-op and a dead device's records persist forever; deleting in the shared dir is a foreign write (rule 1) that sync clients may resurrect.",
      "fix": "Local tombstone `sessions/ignored-devices.json` (fold skips it; `who --all` shows `ignored`); a device removes its OWN shared subtree on `sessions sync disable`."
    },
    {
      "n": 18, "severity": "medium", "where": "§7.3 step 3 replay 'skips … risk (re-runs risk only when the cached stage was before it)'; §7.2 `replayable: … stage ∈ {risk, coordinate, judge-before-execute}`; §14 Q8",
      "why": "`cache/step-<n>.json` holds proposal + target hashes but no `RiskAssessment`/`matchesIntent`, so a jev-on replay from `coordinate` executes with `StepRecord.risk = null` and a `review`-class proposal bypasses the confirm at engine.ts:2170. 'judge-before-execute' names a stage that does not exist.",
      "fix": "Always re-run `risk` on replay (Jev call only, no generator) — resolves Q8 as yes; replayable set = `{risk, coordinate}`; hash gate unchanged."
    },
    {
      "n": 19, "severity": "low-medium", "where": "§5.2 `handoff` `subject60`; §5.4 rendering under `## Other sessions`; §10.6",
      "why": "Commit subjects of any commit that lands (attacker-controlled on a hostile branch) and peer `note` texts reach every peer's generator prompt; 'never as a directive' is a rendering intent the model cannot enforce.",
      "fix": "Render peer texts in a fenced block with a standing 'untrusted data' line, `sanitizeStream` + one-line rule as steers, clip `handoff` subjects to 120 chars; record residual risk in §10."
    },
    {
      "n": 20, "severity": "low-medium", "where": "internal inconsistencies",
      "why": "(a) G1(a) 'within 15 s' holds same-device only; cross-device is 15 s + sync lag (minutes on iCloud, §14 Q3). (b) G3(d)/§8.9/M9 'Jev request bytes identical to HEAD' vs §4.1/§8.8 adding `state.coord.conflicts` under advisory. (c) §9.3 '≤ 1 MiB per cycle' vs `steps.jsonl` 'whole ≤ 4 MiB'. (d) §2.1 rule 1 cites index.jsonl's 'single appender' — index.ts:1-6 is O_APPEND from many processes (atomic small appends), a different invariant. (e) §3.2 cites '§11 row 28' for the copied-home case; it is row 27. (f) `LlmSource.cancel('pause')` needs a new `CancelReason` member (source.ts:111 = 'commit'|'budget'|'abort').",
      "fix": "(a) restate as same-device 15 s / cross-device 15 s + measured lag; (b) M9 asserts byte identity with `claims:off` or no conflict; (c) mirror steps.jsonl incrementally from the last mirrored offset; (d) reword; (e) renumber; (f) list the additive member in W3 item 27."
    },
    {
      "n": 21, "severity": "low", "where": "anchors in §12 W0 item 1 and elsewhere — src/core/types.ts is ~20-37 lines behind HEAD",
      "why": "Actual: `WindowEntry` :901 (doc :880); `interrupted` :966 (:944); `pendingDirectives` :973 (:952); `DIRECTIVE_MAX_CHARS` :993 (:972); `RunMeta` :1017 (:996); `BlockingKind/Answer` :1160-1161 (:1133-1134); `EngineOptions` :1174 / `resume` :1180 (:1147/:1153); `generatorPricing` :1244 (:1217); `EngineStatus` :1348 (:1311); `NoticeKind` :1375 (:1338); `EngineEvent` :1382, `synth` :1383, `generator:start` :1399 (:1345/:1346/:1362); `Engine.pause()` :1469 (:1412-1432). Also `draft.patchTargets = rk.targets` is engine.ts:2164 (doc :2168-2170); TD3's `src/session/**` read-only rule is TD3:1547 (doc :1336, which is transcript-wrap text).",
      "fix": "Re-read types.ts at HEAD before W0 and correct; everything else anchored was verified at HEAD (see confirmed list)."
    },
    {
      "n": 22, "severity": "low", "where": "§3.1 validators; §3.5 watchers; §3.2 `label`, `fsCaseInsensitive`",
      "why": "No regex for the `<sessionId>` outbox dir component (a run-id-shaped string today, but §6.5 could change it); `fs.watch(outbox/<mySessionId>/)` ENOENTs until a peer first writes there; case-insensitivity is per volume, not per device (external case-sensitive disks); two Macs default to `MacBook-Pro.local` so `device:<label>` collides.",
      "fix": "Add `sessionId` to the validator table; watch `outbox/` and filter; probe case-folding per workspace root; disambiguate labels as `label#id4` when duplicated in the fold."
    },
    {
      "n": 23, "severity": "low", "where": "§7.4 `end` = `human_pause` + index line; '`/resume <id> --force` reopens'",
      "why": "The engine resumes `human_pause` without `--force` (stop.ts:9; engine.ts:3035 checks only `complete`), so `jevcode run --resume <id>` from a shell bypasses `RunMeta.ended` — the gate exists only in the TUI/picker.",
      "fix": "`createEngine` reads `meta.ended` and requires `opts.resume.force` (one clause at engine.ts:3035), message `run <id> was ended by <by> at <t>; pass --force to reopen`."
    }
  ],
  "confirmed_ok": [
    "seatbelt.ts:102 (allow default), :104 writable roots, :157-161 configDirs, :170 jevHome read-deny, :179-180 re-allow, :183 network deny only under noNetwork; defaults.ts:126 noNetwork 'false'",
    "engine.ts:212 RUN_ID_RE, :214 SHUTDOWN_CHECKPOINT_BOUND_MS, :459-468 takeRunLock + hostname :462, :568/:570 wakers, :850-908 abort/markLastResort/forceExit, :926-941 steer, :953-957 pause, :964-976 retryNow, :981-1000 annotate, :1087 loop-top classify, :1094 pauseRequested, :1096-1112 blocker loop, :1160 installBlock, :1177-1216 awaitBlocker, :2197 computeTargets, :2202 pendingCheckpoint await, :2203-2208 blocked discard, :2218-2221 pre-images, :2552-2575 rules 1-3, :2810-2822 IIFE, :2870-2911 finish, :3011-3037 createEngine/resume lock, :3043-3048 git probe, :3099-3100 store.create + takeRunLock",
    "stop.ts:9 human_pause not a budget stop, :22-38 exitCodeFor (default → 4), :41-48 classifyAbort needs the human_pause branch; errors.ts:252-262 AbortError(reason, signalName)",
    "lock.ts full: sync API, isPidAlive EPERM=alive :27-35, parseRunLock :38-45, lockIsLive :57-59, acquireRunLock :91-126 with other-host replacement :117-125",
    "index.ts:19-33 IndexLine, :36 INDEX_KINDS, :47-60 indexOneLine, :128-142 STOP_REASON_SET, :190 parseIndexBody, :323-329 resumeOf, :446-471 appendIndexLine + cli-only gate :447 + 0o600",
    "store.ts:29-53 CHECKPOINT_FILES, :60 DISK_ERROR_CODES, :152-163 redactDeep, :264 per-key chains, :361-383 rotation, :545-554 writeUi (unwired today, as the design says); atomic.ts:19/:41; images.ts:11-13; run-id.ts:116-146; resume.ts:20-24/:147/:186-205",
    "state.ts:30-41/:113-123/:125; window.ts:10-15; prompts.ts:13/:15/:220/:227/:279/:286; execute.ts:64-80; seed.ts:11/:28/:47; gitstate.ts:35/:40-41/:216-218; questions.ts:37 noul / :63 choice",
    "source.ts:74/:350/:593/:792/:807; lanes.ts:35/:45/:188/:213-214/:311-312/:327/:333; runner.ts:348/:441/:506-510 (bench workspaces are per-pair copies); resolve.ts:788/:819; sessions.ts:111-114; picker-lines.ts:313-333; bindings.ts:104 ctrl+p; useGitHead.ts fs.watch + 100 ms debounce; step-overhead.ts:13; r3-implement.js:19 build/perf/pty + peer-ownership rule; glm-jev-off-baseline.md:210-213/:224-231; TD:24 D2, TD:99, TD:252, TD:1141/1143-1145, TD:1325; D:990, D:1470 'no recorded proposal is replayed'",
    "firstFrame (session.ts:3458) precedes createEngine (:1789/:2112) — newcomer pane + fold before createEngine is compatible with zero commons I/O before the first frame",
    "generator deltas are available to the engine (engine.ts:1933-1963 onDelta/onCancelled) — `partial.text` in cache/step-<n>.json is feasible",
    "workspace git calls default to a never-aborting signal (git.ts:47,:80), so a pause-now abort does not break changedFiles()/post-images"
  ]
}

---

```json
{
  "reviewed": "/Users/prateekjannu/Documents/vscode/JevCode/docs/COORDINATION-DESIGN.md (937 lines, untracked)",
  "design_head": "9c3a7ac",
  "head_now": "40c376a (group D + group E merges landed during this review; src/loop/engine.ts 3116 -> 3232 lines, src/core/types.ts +51)",
  "read_only": "no edits, no commits, no live calls",
  "defects": [
    {
      "n": 1,
      "severity": "blocker",
      "where": "whole doc; every src/loop/engine.ts anchor",
      "why": "HEAD moved under the doc. Current lines: SHUTDOWN_CHECKPOINT_BOUND_MS :217 (doc :214); takeRunLock :471 (:459-468); abort() :862, 'exit' handler install :896 (:876-884); forceExit :910 (:898-908); pause() :965 (:953-957); retryNow :976 (:964-976); loop-top abort classify :1099 (:1087); pauseRequested finish :1106 (:1094); installBlock :1172 (:1160); awaitBlocker :1189 (:1177-1216); emitStatus :1406 (:1394); runStep :2165; jev-off computeTargets :2305 (:2197); pendingCheckpoint await :2310 (:2202); takePreImages :2328 (:2218-2221); handleStepError :2657; checkpoint IIFE :2922-2934 (:2810-2822); finish :2952, final writeState :2991 (:2875-2878); createEngine :3127, realpath :3134 (:3018), headMoved :3190 (:3049-3057), store.create+takeRunLock :3215-3217 (:3099-3100). New facts the doc does not know: StepRecord.verify (types.ts:424), SynthesisContext.reportVerify (types.ts:1305), draft.closed + pushGeneratorRecord (engine.ts:2007-2016) which appends a late sample row under a DISCARDED step.",
      "fix": "Re-anchor against 40c376a before W0; add to §7.2 the rule for late sample rows of a pause-now-discarded step (see defect 22)."
    },
    {
      "n": 2,
      "severity": "blocker",
      "where": "§3.3 write point (2); §2.1 rule 4; engine.ts:2922-2934",
      "why": "The IIFE's catch calls this.noteDiskError(e, file, step) with file already = 'state.json' once writeState succeeded (engine.ts:1244-1258). A heartbeat ENOSPC/EACCES on ~/.jevcode/sessions would therefore be classified 'checkpoint degraded: ENOSPC on state.json', install the checkpoint-degraded pane (stop:'error', exitCode 3) and make the run non-resumable — a coordination failure blocking a run, contradicting rules 4 and 9. And pendingCheckpoint is awaited at :2310 before every execute, so any write awaited inside the IIFE IS on the step path (corner row 3 even admits ~/.jevcode may live in a synced folder).",
      "fix": "Fire the heartbeat as `void ledger.enqueue(write)` from a `.then` on the IIFE (or after writeState but outside the store try/catch), with the ledger chain's own errno classification -> `⇄ off (<code>)` notice. Never awaited by pendingCheckpoint, never routed through noteDiskError."
    },
    {
      "n": 3,
      "severity": "blocker",
      "where": "§7.2 row 'a blocking pane awaited'; §13 M5(a); engine.ts:1189-1230 awaitBlocker",
      "why": "awaitBlocker races only [aborted, answered, retry timer]. Engine.pause() (:965-969) sets a flag and announces; nothing resolves the race, so `pause()` during jev-unreachable / spend-limit / lease-conflict still waits for the human to answer the pane. M5(a) ('call pause() -> blocking:resolved answer:pause') cannot pass with the described design; the TUI resolving 'pause' from the pane is a different mechanism than Engine.pause().",
      "fix": "Add `private blockWaker: AbortController | null`; awaitBlocker pushes `sleep(∞, blockWaker.signal).catch(() => ({answer:'pause', auto:false}))` into races; pause() aborts it. Loop top (:1108-1121): `if (answer === 'pause' || answer === 'worktree') return this.finish('human_pause')` BEFORE the `answer === 'stop' || req.kind === 'drift'` line and without adoptBlockedError; keep drift's own rule."
    },
    {
      "n": 4,
      "severity": "blocker",
      "where": "§7.2 pause-now table, rows 1-2; engine.ts:2657-2690",
      "why": "Row 1 lists `judge` among stages that 'discard under rule 1', but in handleStepError `draft.executeFinished === true` for judge -> rule 3 (commit with judge:null). 'judge-before-execute' is not a stage. The human `review` confirm (this.confirm, engine.ts ~2284-2300, currentStage still 'risk') is a wait not covered by the table: a pause-now there rejects the confirmer with AbortError (confirm catch rethrows; `!this.signal.aborted` is false so no double abort) and discards — correct — but a replay that 'skips risk' would also skip the human approval.",
      "fix": "Rows: {intent, context, propose, risk incl. review confirm, coordinate, replan, inline strict wait} -> rule-1 discard; {execute} -> not interrupted (pauseNow flag, rule 3 after execute); {judge} -> abort the controller, rule 3 commit. `replayable := proposal !== null && !executeStarted && stage ∈ {risk (after runRiskStage returned), coordinate}`; replay re-asks confirm when cached risk.verdict === 'review'."
    },
    {
      "n": 5,
      "severity": "blocker",
      "where": "§7.2 at:'now' ('the engine first writes cache/step-<n>.json ... then controller.abort'); types.ts:1432 Engine.pause(): void; engine.ts ~1905-1925",
      "why": "pause() is synchronous and the TUI calls it synchronously; writeFileAtomic is async, so 'first writes then aborts' is impossible without changing the interface or leaving the write untracked (M4 asserts the cache file exists after run:end). The 'partial: { text ≤ 32 KiB }' field has no source: the engine only counts streamed chars (streamedChars, :1920) and emits generator:delta; no accumulator exists.",
      "fix": "pause stays `void`: snapshot the draft synchronously (proposal, patchTargets, stage, llm arrivals), call `this.persist(this.store.writeCache(...), 'cache/step-n.json')` (finish awaits pendingPersists inside the 5 s bound at :2991-3005; noteDiskError only blocks for state.json so a cache failure is a notice), then abort. Add a bounded `draft.partialText` (≤ 32 KiB, sanitizeStream) fed from onDelta, or drop partial.text from the card."
    },
    {
      "n": 6,
      "severity": "major",
      "where": "§2.2 graft 'pause-now through the shared AbortController'; §7.5; engine.ts:862-896, :1099",
      "why": "abort() aborts the controller only `if (!this.controller.signal.aborted)`. After Ctrl-G the reason is AbortError('human_pause'); an Esc Esc / SIGTERM that follows leaves signal.reason unchanged, so the loop top finishes with `human_pause` (exit 4) instead of `human_abort`/`signal` (130/143). markLastResort sets stopReason only when null, so the exit-handler path is also wrong.",
      "fix": "abort() records `this.abortReason = reason` (and signalName); finish()/loop top prefer `abortReason ?? classifyAbort(signal.reason).stop`; markLastResort overrides a 'human_pause' stopReason with the abort reason."
    },
    {
      "n": 7,
      "severity": "major",
      "where": "W0 item 1 ('AbortError.reason + human_pause', src/errors.ts:254); errors.ts:252, :259",
      "why": "AbortReason (errors.ts:252) must gain the member (the doc names only `.reason`), and the constructor's exitCode ternary (`reason === 'human_abort' ? 130 : 1`) gives AbortError('human_pause') exitCode 1, which leaks through serializeError into `error` events and generator rows.",
      "fix": "Extend AbortReason and the ternary (`'human_pause' -> 4`); list errors.ts:252 and :259 in W0 item 1."
    },
    {
      "n": 8,
      "severity": "major",
      "where": "§4.3 step 4 ('BlockingRequest kind:lease-conflict pane opens (installBlock)'); engine.ts:2311-2316; types.ts:1135-1146",
      "why": "If the coordinate micro-stage installs the block and returns normally, the existing `if (this.blocked !== null)` branch right after the pendingCheckpoint await records `interrupted = { stage: 'execute' }` — the resume card would say 'paused at execute'. Also BlockingRequest.stop and .exitCode are REQUIRED fields; the doc never says what `[q] stop` on a lease-conflict pane stops with.",
      "fix": "Coordinate follows the drift pattern (engine.ts:1881): set `this.stageBlock = { request, error }` and throw, so handleStepError's block branch (:2687-2695) records stage:'coordinate'. Specify `stop: 'human_pause', exitCode: 4` for lease-conflict."
    },
    {
      "n": 9,
      "severity": "major",
      "where": "§4.3 step 4 keys `[w] wait (re-arms, auto-resumes on release)`, `[c] continue anyway`; W0 BlockingAnswer + 'wait' | 'worktree'",
      "why": "By the time the pane opens the step is already discarded (rule 1). 'Auto-resume on release' and 'continue anyway' require an IN-PROCESS replay of the cached proposal; §7.3 defines replay only as EngineOptions.resume.replay at createEngine. Loop-top semantics for 'wait' / 'continue' / 'worktree' answers are unspecified (today 'continue' means checkpointDegraded = true at :1112).",
      "fix": "Define `private pendingReplay: CachedStep | null` consumed at the top of runStep() (skips intent..risk as in §7.3) and `private coordOverride: 'proceed' | null` for `[c]`; 'wait' re-arms the wakeable wait at the loop top then sets pendingReplay; 'worktree' -> finish('human_pause') with interruptedDetail.relocate. Or drop auto-resume: the next step re-proposes and the cache is kept for `/resume --replay`."
    },
    {
      "n": 10,
      "severity": "major",
      "where": "§5.4 request-release ('the engine will not START a step whose targets overlap ... until its lease is released or 10 min pass')",
      "why": "This is a hold caused by another session under the default advisory mode, contradicting G1(b) ('no step is ever delayed by another session') and §2.1 rule 3.",
      "fix": "Advisory: request-release becomes a `## Other sessions` fact plus a harnessProblem-style hint ('mbp asked you to release X; commit and move on'); the hold exists only under strict."
    },
    {
      "n": 11,
      "severity": "major",
      "where": "§4.1 ('coordination.enabled is forced off for source !== \"cli\"') vs W4 item 31 / M9 ('step-overhead runs with coordination ON')",
      "why": "perf is a RunSource ('cli' | 'bench' | 'perf', types.ts:1025); the gate as written disables coordination in the very run that gates coordinateMs and harnessMs.",
      "fix": "Gate on `source === 'bench'` only, or let an explicit `EngineOptions.coordination.enabled: true` win over the source gate; state which."
    },
    {
      "n": 12,
      "severity": "major",
      "where": "W0 item 1 RunMeta.repoKey?/.wsKey?/.deviceId?/.relocations?/.imports?/.ended?/.worktree?; W2 item 19; types.ts:1064; store.ts:435-455",
      "why": "CheckpointStore.updateMeta is `Partial<Pick<RunMeta, 'overrides'|'resumes'|'resolvedJevModel'|'jevModelDrift'|'title'|'instructions'|'git'>>` and store.updateMeta rebuilds `next` field by field. repoKey is only known after run:ready (§3.2), relocations/imports/ended/worktree are written later — none has a write path. isRunMeta is fine (additive).",
      "fix": "Extend the Pick and the `next` builder (relocations/imports append like resumes; repoKey/superKey/ended/worktree replace as scalars). Write wsKey and deviceId at store.create (zero spawns), so only repoKey needs the later update."
    },
    {
      "n": 13,
      "severity": "major",
      "where": "§7.3 step 1, W2 item 19 ('history fold, interruptedDetail load'); src/checkpoint/resume.ts:147-183; engine.ts constructor resume block (~:700-735)",
      "why": "foldStepsIntoState clears `interrupted` when a committed row exists at/after its step and sets stopReason:null/resumes+1. The new fields have no stated fold rule: interruptedDetail (the replay pointer) must drop with `interrupted`; `phase` must leave 'paused'/'ended'; history/fileCache/fileMemory/summaryAt must be rebuilt from folded rows. The engine constructor restores each CheckpointState field explicitly (pendingDirectives, undoLog, synthState...), so every new field also needs a restore line and a place in buildCheckpointState (~:1467).",
      "fix": "Name the rule per field in W2 item 19 and the restore/snapshot lines in W2 item 16; add a `foldStepsIntoState` test that a committed row ≥ interrupted.step drops interruptedDetail."
    },
    {
      "n": 14,
      "severity": "major",
      "where": "§6.2 'Lanes are leases ... one per lane at createLanes, released at disposeLanes'; W3 item 27; lanes.ts:53-58, :188, :288-322; types.ts:1234-1306; verify.ts:178-183; runner.ts:527-531",
      "why": "LaneContext is { runDir, sandbox, signal, workspaceInfo }; SynthesisContext has no coordination hook; createLanes is called by the synthesizer (not the engine) and the pool is cached in `mem.lanes` across steps, disposed and recreated when `lanes.length < oracle.lanes`. No plumbing from lanes.ts to the ledger is named. Also the lease's `laneDir` is an absolute path, contradicting §10.2 ('records carry no absolute paths off-device') once mirrored.",
      "fix": "Additive `SynthesisContext.coordination?: { laneClaimed(lane: Lane): void; laneReleased(lane: Lane): void }` threaded into LaneContext (a Pick), called in createLanes after `git worktree add` and in disposeLanes; or derive lane leases from documented `synth` event phases ('lanes:created' with laneDir, 'lanes:disposed'). Store laneDir run-relative (`tmp/synth/lane<k>`) + runId; the sweep reads `<laneDir>/.git` to find the repo to prune."
    },
    {
      "n": 15,
      "severity": "major",
      "where": "§6.7 'lanes reset in withLane's finally (lanes.ts:327) and are disposed by finish()'; lanes.ts:87-89, :293-299, :302-322; src/sandbox/run.ts:243-246",
      "why": "Every lane shell op passes `signal: ctx.signal`; sandbox.run with an already-aborted signal throws or returns killed at once. After pause-now aborts the shared controller, `resetLane` in withLane's finally (:293-299, not :327) and `disposeLanes` (`git worktree remove --force`, :311) cannot run -> LaneError, worktrees stay registered and dirty. finish() does not dispose lanes today (the pool lives in the synthesizer's mem); `git worktree prune` only happens at the next createLanes (:213).",
      "fix": "Give LaneContext an optional `disposeSignal` (fresh AbortController with a 5 s timeout) used by resetLane/disposeLanes when ctx.signal is aborted; call `disposeLanes` from the synthesizer's abort path or release the `lane` lease as `expired` and rely on the sweep. Correct §6.7's claim about finish()."
    },
    {
      "n": 16,
      "severity": "major",
      "where": "§6.4 round cache 'written by LlmSource's arrival path (source.ts:593) through writeFileAtomic'; source.ts:111, :345-356, :588-598",
      "why": "LlmSource has no runDir/fs access; settle() only calls deps.onSample(a). CancelReason is 'commit'|'budget'|'abort' — no 'pause'. `cache?: Json` is restored from synthState, which is written only at commit (buildCheckpointState) — a pause-now step never commits, so the arrived-sample index for the replay can only come from cache/step-<n>.json.llmRound.",
      "fix": "Engine-side onSample writes `cache/llm/<goal>/<round>/<k>.json` via a new store.writeCache; add `LlmSourceDeps.replay?: (goalId, round) => SampleArrival[]` consulted before `run.abort`/dispatch; add 'pause' to CancelReason (or document reuse of 'abort'); the replay entry feeds llmRound from the step cache file, not from synthState."
    },
    {
      "n": 17,
      "severity": "major",
      "where": "§4.3 step 4 inline strict wait ≤ 60 s; G1/M2/M9 harnessMs gate; engine.ts:2470, :2486, :2823 (harnessMs = total − generatorMs − jevMs − execMs − confirmMs)",
      "why": "A wait inside runStep is booked into harnessMs, so a single 5 s strict wait fails the p95 < 50 ms gate by construction, and the wall deadline (armWallDeadline on the shared controller, :1070/:1082) can fire during the wait — acceptable (rule-1 discard) but unstated.",
      "fix": "Add `draft.timing.coordWaitMs` subtracted like confirmMs in all three formulas; optional `StepTiming.coordinateMs`; state that a BudgetError during the wait discards under rule 1 with the cache written."
    },
    {
      "n": 18,
      "severity": "major",
      "where": "§3.4 'takeRunLock consults ledger.foreignLive(runId) through an injected peerLive option'; §3.5 'ledger.open() runs after renderer.firstFrame()'; engine.ts:471-480, :3153, :3217; lock.ts:91-126 (sync)",
      "why": "For `--resume`, takeRunLock runs inside createEngine (:3153), i.e. before the ledger exists in the plain/headless path and before the async mirror fold completes in the TUI path; acquireRunLock must stay synchronous. The doc does not say who supplies the fold or how long createEngine may wait.",
      "fix": "`EngineOptions.coordination?.peerLive?: (runId: string) => PeerInfo | null` supplied by the caller from an already-folded ledger (TUI: after the card; plain: after a bounded ≤ 500 ms fold); createEngine never awaits the ledger; the engine re-checks foreignLive at its first heartbeat and stops with exit 2 (the §4.5 fencing rule) if a live foreign beat appears."
    },
    {
      "n": 19,
      "severity": "medium",
      "where": "§8.3 'Each entry is the WindowEntry shape plus outputRef ... entries 1–2 show output up to 32 KiB'; §8.9 'history ≤ 12 × 32 KiB ≈ 400 KiB in state.json'; types.ts:891 (WindowEntry.output ≤ 600)",
      "why": "Ambiguous whether 32 KiB bodies sit in state.json (then every step fsyncs ~400 KiB, writeStateSync on exit copies it, and the essential-set mirror moves it every checkpoint) or are read from outputs/step-n.txt at prompt build. The resume fold from StepRecord.outcome.exec cannot rebuild 32 KiB bodies either.",
      "fix": "HistoryEntry.output stays ≤ 600 like WindowEntry; entries 1–2 are expanded at prompt build by reading ≤ 2 outputs files (≤ 32 KiB each, memoised per step); state.json stays small; drop the 400 KiB sentence."
    },
    {
      "n": 20,
      "severity": "medium",
      "where": "§4.2 placement 'right after await pendingCheckpoint and before takePreImages'; engine.ts:2310-2328",
      "why": "Between those lines sit the `blocked` discard (:2311) and `checkBudgets(spend_cap, wall_time)` (:2318). The doc does not fix where coordinate sits relative to the budget check, and in jev-on the human review (:2284-2300) already approved the step before any lease is checked.",
      "fix": "Order: pendingCheckpoint await -> blocked check -> coordinate (declare/check/wait) -> budgets -> pre-images; state that an approval given before coordinate is re-asked on replay (defect 4) and that a `wait`/`worktree` decision after an approval is reported as `declined by coordination`."
    },
    {
      "n": 21,
      "severity": "medium",
      "where": "§7.3 step 3 'emits proposal with verdict replay'; types.ts EngineEvent proposal row (`{ type: 'proposal'; step; proposal }`)",
      "why": "The proposal event has no verdict field; W0 item 1 does not list it.",
      "fix": "Additive `verdict?: 'replay'` on the proposal event (W0); plain.ts/TUI print `(replayed)`."
    },
    {
      "n": 22,
      "severity": "medium",
      "where": "§7.2 / §7.3 replay vs engine.ts:2007-2016 pushGeneratorRecord (new at 40c376a)",
      "why": "A sample that ends after its step was discarded is appended to generator.jsonl under that step (`draft.closed`). After pause-now the same step number is replayed or re-run, so generator.jsonl carries rows from two attempts of one step; src/bench/step-records.ts folds by step.",
      "fix": "Cache file records `attempt`; the replayed step's rows carry `attempt + 1` (GeneratorCallRecord.attempt exists); document that (step, attempt) is the key."
    },
    {
      "n": 23,
      "severity": "minor",
      "where": "anchors outside engine.ts",
      "why": "store.ts:264 -> :295 (enqueue); lanes.ts:327 is the free-function wrapper, the reset finally is :293-299 and the inner disposeLanes :302; lanes.ts:213-214 ok; source.ts :74/:350/:593/:792/:807 ok; lock.ts, stop.ts, resume.ts:147/:186, run-id.ts:116-146, atomic.ts:19/:41, seatbelt.ts:102/:104/:157-161/:170/:179-180/:183, defaults.ts:126, gitstate.ts:35/:40-41/:216/:218, runner.ts:348/:441/:506-510, bindings.ts:104, DESIGN.md:1470, index.ts:447 all verified.",
      "fix": "Correct the three."
    },
    {
      "n": 24,
      "severity": "minor",
      "where": "§7.4 end = human_pause + index line + RunMeta.ended",
      "why": "Ordering unspecified: if RunMeta.ended is written after finish() the process can exit (5 s bound / forceExit) with state.json saying human_pause and no ended marker; the picker then shows a paused run.",
      "fix": "`end` calls `this.persist(store.updateMeta({ ended }), 'run.json')` BEFORE pause(); finish awaits pendingPersists; the index line is written by the TUI after run:end as designed."
    }
  ],
  "verified_consistent": [
    "classifyAbort branch + handleStepError rule 1/2/3 path works for AbortError('human_pause') once AbortReason gains it (engine.ts:2657-2690, stop.ts:41-48)",
    "abortStopReason (engine.ts:392-395) already maps a non-timeout abort to 'cancelled' — pause-now samples record correctly",
    "StageName + 'coordinate' is safe for Decision.stage, SynthesisContext.ask, EngineStatus.stage, interrupted.stage; src/tui/pane/model.ts:202 uses Partial<Record<StageName,…>>",
    "CHECKPOINT_FILES additions without a '.' are skipped by fileNamedIn (store.ts:84-93); writeFileAtomic supports mkdir:true for outputs/ and cache/",
    "writeStateSync/exit-handler ordering (engine.ts:888-896, :910-918) accommodates one extra synchronous heartbeat write before releaseLock",
    "docs/DESIGN.md:1470 'no recorded proposal is replayed' — the doc's deviation is real and gated as stated",
    "acquireRunLock is fully synchronous; additive RunLock fields are ignored by parseRunLock (lock.ts:38-45)"
  ],
  "verdict": "REVISE BEFORE W0 — not buildable for the harness half in one day as written. The architecture (single writer per file, advisory-by-default, pause as near-zero-cost stop, two windows) is sound and most anchors were correct at 9c3a7ac, but HEAD has moved (defect 1) and six contract gaps would each cost hours to discover mid-implementation: heartbeat inside the checkpoint IIFE poisons the degraded-checkpoint path (2); Engine.pause() cannot resolve an awaited pane (3); the pause-now stage table is wrong for judge/review and the replayable set names a non-stage (4); the sync pause() cannot 'write then abort' and has no partial-text source (5); lease-conflict blocking mislabels interrupted.stage and lacks stop/exitCode (8); lanes have no path to the ledger and cannot be reset/disposed after the shared abort (14, 15). Fix 1-18 in the doc (≈ half a day of editing), then W0 as planned."
}
```