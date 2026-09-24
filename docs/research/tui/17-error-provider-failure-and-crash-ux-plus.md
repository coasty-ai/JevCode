# 17 — Error, provider-failure and crash UX, plus where logs live

Research note for the JevCode interactive TUI (gap-fill for 00-SUMMARY §8 item 9, 12 §10, 07 §3.4–3.5, 06 §11,
10 §15.9, 02 §4, 03 §7). Written 2026-09-20. Every claim carries its source and fetch/read date; local reads
are of the working tree at `<repo>` on 2026-09-20 (Node v22.23.2, ink 7.1.1,
react 19.3.0, signal-exit 3.0.7 — `node --version`, `node_modules/*/package.json`, read 2026-09-20). Measurements
were run in `/tmp/jev17` against the built bundle `dist/jevcode.mjs` (mtime 2026-09-20 08:04; note it predates
the `--mode` flag committed 09:08 in `9c17159`, so runs below use `--mock-generator` = jev-on with a mocked
generator and the live decider client pointed at a local mock server; no paid API was called).

Hard constraints respected throughout: runtime deps stay ink + react; zero terminal clears after the first frame;
rendering never blocks the loop; keys never in logs; first frame < 300 ms with zero network.

---

## 0. What exists today (facts that constrain the design)

### 0.1 Error hierarchy and exit codes (`src/errors.ts`, read 2026-09-20)
- `JevCodeError { code: ErrorCode; exitCode; cause }` with codes `config | usage | jev_http | jev_response |
  jev_model_drift | provider_http | generator_response | sandbox | path_escape | secret_path | edit | patch |
  not_found | budget | checkpoint | abort | internal`. `toJSON()` returns `{ name, code, message, exitCode }` — no
  HTTP status, no `retryable`, no side (Jev vs generator). `SerializedError` in `src/core/types.ts:310-315` has the
  same four fields, so the `error` engine event cannot tell a renderer whether a failure was a 429 or a 500.
- `JevHttpError { status; retryable; retryAfterMs; body }`, `ProviderHttpError` (same shape), `IdleTimeoutError extends
  ProviderHttpError` with `phase: 'first_byte' | 'idle'` and `status 0` (`src/provider/sse.ts:22-30`).
- `JevModelDriftError(configured, served, { firstCall })` exits 2 on the first call, 5 later (`errors.ts:95-108`).
- `EXIT_CODES = { ok 0, unexpected 1, config 2, checkpoint 3, budget 4, api 5, sandbox 6, sigint 130, sigterm 143 }`;
  README line 47-49: "Exit codes: 0 complete · 2 configuration/usage · 3 corrupt checkpoint · 4 stopped by a budget
  or directive · 5 API failure after retries · 6 sandbox/path failure · 130 Ctrl-C · 143 SIGTERM (checkpoint written
  first in every case)" (README.md, read 2026-09-20). The last parenthesis is **not true under ENOSPC** (§1.3).

### 0.2 Retry loops emit nothing (`src/jev/client.ts`, `src/provider/sse.ts`, read 2026-09-20)
- Jev: `JEV_RETRY = { attempts: 3, backoffBaseMs: 500, backoffMaxMs: 5000, jitter: 0.25, maxRetryAfterSeconds: 60,
  attemptTimeoutMs: 10_000, validationRetries: 1 }` (`src/jev/types.ts:27-35`). `isRetryableStatus`: 408, 429, 5xx
  except 501. `parseRetryAfterMs` accepts the seconds form only, `0 < v <= 60`. The loop in `ask()` is
  `const waitMs = err.retryAfterMs ?? backoffMs(httpAttempts, random); await sleep(waitMs, opts.signal);` — there is
  no callback, no event, nothing observable between attempts (`client.ts:388-391`). `AskOptions` has only `signal`.
- Generator: `withRetry(deps, signal, attempt)` with `MAX_ATTEMPTS = 3`, `BACKOFF_BASE_MS 500`, `BACKOFF_CAP_MS 8_000`,
  `RETRY_AFTER_CAP_MS 60_000`; honours `retry-after-ms`, `retry-after` (seconds or HTTP-date) and `x-should-retry`
  (`sse.ts:160-223, 289-303`). `RetryContext = { attempt, signal }` — again no observer. Timeouts: first byte 30 s,
  idle 60 s (`FIRST_BYTE_TIMEOUT_MS`, `IDLE_TIMEOUT_MS`, `sse.ts:16-17`).
- Anthropic-specific: `error.type → status` map incl. `overloaded_error: 529`, `rate_limit_error: 429`,
  `authentication_error: 401` for `event: error` frames after a 200 (`src/provider/anthropic.ts:33-45`); a 429 with no
  `retry-after` and `details.error_code === 'enforced_spend_limit_reached'` is forced non-retryable ("keeps failing
  until access resumes", `anthropic.ts:284-294`). OpenRouter: 402 is non-retryable unless
  `metadata.limit_source === 'openrouter_in_flight_budget'` with a Retry-After (`src/provider/openrouter.ts:243-253`).
- Copy leak: a network failure becomes `Jev request failed: ${errorMessage(e)}` where `errorMessage` prefixes
  `e.name` — measured output `Jev request failed: TypeError: fetch failed (getaddrinfo ENOTFOUND jev.invalid)` (§1.5).

### 0.3 How the engine classifies failures (`src/loop/engine.ts`, read 2026-09-20)
- Stage failure (Jev/provider error after retries): the step is committed with `draft.error = { stage, code, message }`,
  an `outcome: failed` for propose/risk/execute, `this.emit({ type: 'error', step, error, fatal: false })`, and
  `consecutiveStageFailures += 1` (`engine.ts:1275-1293`). `CONSECUTIVE_STAGE_FAILURE_LIMIT = 3` (`engine.ts:175`)
  → `stop: 'error'` (`engine.ts:1099-1103`). A failed step still counts toward `max_steps` (§1.4: `--max-steps 1` +
  one 429 burst → exit 4, not 5).
- Action-level errors (`ACTION_ERROR_CODES = ['edit','patch','path_escape','secret_path','not_found']`) are outcomes,
  never exits (`engine.ts:273, 1263-1273`).
- Fatal: anything escaping `main()` → `emit({ type: 'error', …, fatal: true })` then `finish('error')`
  (`engine.ts:529-543`). First-call model drift aborts with the ConfigError exit code (`engine.ts:895-900`); later
  drift is one `transcript warn` line: `jev model alias <cfg> resolved to <served>; pin it with --jev-model <served>
  for reproducible thresholds` (`engine.ts:890`).
- Disk: every persist failure is a **warning only** — `persist()` catches and emits `transcript warn "<what> write
  failed: …"` (`engine.ts:600-611`); `appendStep`/`writeState` failure at commit emits `error` with `fatal: false`
  (`engine.ts:1447-1449`); the final checkpoint has a 5 s bound, after which `forceExit` (`engine.ts:1504-1514`).
  Nothing pauses the run and nothing changes the exit code (§1.3).
- Sandbox level reaches the system prompt and `StepRecord` (`engine.ts:395, 1161`) but **no event carries it to a
  renderer**; `run:ready` is `{ runId, step, maxSteps, task, resumed }` (`engine.ts:551`). Only `jevcode config` prints
  "sandbox level: none (no sandbox-exec: …)" (`src/cli/main.tsx:233`).
- Events a renderer can use today: `transcript { level: 'info'|'warn'|'error'; text }`, `error { step, error:
  SerializedError, fatal }`, `run:end { result }` (`src/core/types.ts:835-837`). No `retry`, no `notice`, no `sandbox`.

### 0.4 What the renderers show (`src/tui/*`, read 2026-09-20)
- `itemsFromEvent`: `error` → `error ${code}: ${message}${fatal ? ' (fatal)' : ''}` at level `error`; `transcript` →
  `${level}: ${text}` for warn/error (`src/tui/plain.ts:259-262`). `itemColor`: red for `error`/`block`, yellow for
  `warn`/`review`, dim otherwise (`src/tui/Transcript.tsx:9-14`). Lines are `[step N] …` / `[run] …`
  (`formatTranscriptItem`, `plain.ts:278`).
- Status line: `step n/max  <spinner> <stage|stopping …|done …>  wall …  tokens …  cost … / cap …[ EXCEEDED]`; the
  spinner is 10 braille frames at 125 ms (`src/tui/StatusLine.tsx:11-12, 34-46`), so an idle wait renders 8 frames/s.
  The stage word stays `starting` until the first `status` event (§1.4).
- `useInput` writes every key to the opt-in trace: `tui.useInput input=${JSON.stringify(input)} …` when
  `JEVCODE_TRACE` is set (`src/tui/App.tsx:125-127`) — the key-logging hazard already flagged in 12 §0.
- `fatalExit(e)` writes `jevcode: ${err.message}` to stderr, the stack only with `JEVCODE_DEBUG=1`, then
  `process.exit(err.exitCode)` — no `renderer.unmount()`, no run id, no resume hint (`src/cli/main.tsx:275-283`).
  In interactive mode nothing is printed after `renderer.unmount()`; only `!interactive` prints
  `stop: <reason> after N steps, $… generator + $… jev; run <id>` (`main.tsx:198`).
- Run dir files: `run.json state.json state.prev.json steps.jsonl decisions.jsonl jev.jsonl generator.jsonl
  transcript.log` (+ `state.corrupt.json` on quarantine) under `<runsDir>/<run-id>/`; `runsDir` defaults to
  `<home>/.jevcode/runs`, `JEVCODE_HOME=<dir>` makes it `<dir>/runs`, `--runs-dir` sets it directly
  (`src/checkpoint/store.ts:29-44`, `src/config/resolve.ts:261-270`, `src/config/defaults.ts:67-68`).
- Log knobs today: `JEVCODE_TRACE=<file>` (README line 250: "opt-in shutdown trace: keystrokes, abort, loop
  boundaries, finish") appended from `client.ts:181-190`, `engine.ts:1569-1575`, `main.tsx:86-88`, `App.tsx:125-127`;
  `JEVCODE_DEBUG=1` (stack on fatal). No `--verbose`, no `--log-file`, no log in the run dir. `--json` exists only for
  `jevcode config` (`src/cli/args.ts:112`).

### 0.5 Ink 7.1.1's built-in error path (installed source, read 2026-09-20)
- `App.js:550`: children are wrapped in `React.createElement(ErrorBoundary, { onError: handleExit }, children)`.
  `ErrorBoundary.js`: `static getDerivedStateFromError(error) { return { error }; }`, `componentDidCatch(error) {
  this.props.onError(error); }`, `render()` returns `<ErrorOverview error={…}/>` once `state.error` is set.
- `ErrorOverview.js` renders ` ERROR ` on a red background, the message, `filePath:line:column`, a code excerpt
  (`code-excerpt`) and the parsed stack (`stack-utils`), in a `<Box padding={1}>` — i.e. the whole stack goes into the
  frame.
- `App.js:141-147` `handleExit`: disables raw mode (`stdin.setRawMode(false); stdin.unref()`) and calls `onExit(error)`;
  `ink.js:295-304` `handleAppExit` → `unmount(error)`; `ink.js:576-580` rejects `exitPromise` when the value is an
  Error; `ink.js:276-277`: "Prevent global unhandled-rejection crashes when app code exits with an error but
  consumers never call waitUntilExit()" → `void this.exitPromise.catch(noop)`. So a render throw **unmounts the UI
  and silently rejects `waitUntilExit()`**; JevCode's `unmount()` does `instance.waitUntilExit().catch(() => undefined)`
  (`App.tsx:246`), so the error is swallowed.
- `ink.js:255`: `this.unsubscribeExit = signalExit(this.unmount, { alwaysLast: false });` — Ink's unmount runs during
  `process.exit()` via signal-exit's patched `process.emit('exit')` (§3.2).
- The reconciler does not set React 19 root `onUncaughtError`/`onCaughtError`/`onRecoverableError` (grep of
  `node_modules/ink/build/reconciler.js`, 0 hits, 2026-09-20), so Ink's boundary is the only one unless we add ours.
- `render()` has no option to disable the internal boundary (readme sections `waitUntilExit()`, `clear()`,
  `exit(errorOrResult)`: "`exit(error)` rejects when `error` is an `Error`", `node_modules/ink/readme.md:1905-1915,
  2880-2926`, read 2026-09-20).

---

## 1. Measurements (all 2026-09-20, `/tmp/jev17`, macOS 25.6, `script -q` pty, `stty rows R cols C`)

### 1.1 Ink render throw (the `JEVCODE_FAULT=render` scenario) — `throw2.mjs`
A component under `<Static>` + a live row + a status row, `useInput` active (raw mode on), throws in render at
+400 ms while an interval keeps the loop alive (stands in for the engine).

| rows | bytes | `ESC[2J` | `ESC[3J` | `?2026h` frames | last frame lines | `?25h` | stdin.isRaw before → after | `waitUntilExit()` | process |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 24 | 2579 | **1** | **1** | 2 | **42** | 2 | true → **false** | rejected `injected render fault` | alive at +2 s, exit 0 when the loop drained |
| 12 | 2579 | **1** | **1** | 2 | 42 | 2 | true → false | rejected | same |

Reading: the ErrorOverview frame (message + excerpt + 10 stack frames) is 42 rows, taller than both viewports, so Ink
takes the `clearTerminal` path (`ESC[2J ESC[3J ESC[H`: clears the screen **and scrollback**) — a direct violation of
the zero-clear rule — then leaves the terminal in cooked mode with the engine still running headless. The two
`?25h` are Ink's `log.done()` and cli-cursor's restore (matches 12 §10).

### 1.2 `fatalExit` path: `process.exit(1)` while Ink holds raw mode — `exit3.mjs`
| mode | `stty -a` after exit | `?25h` | `?2004l` | `ESC[2J` | exit |
| --- | --- | --- | --- | --- | --- |
| `process.exit(1)` from a timer | `icanon isig iexten echo …` (cooked restored) | 2 | 0 | 0 | 1 |
| throw in a timer → `uncaughtException` handler writes `jevcode: …` then `process.exit(1)` | cooked restored; `RAW_AT_FATAL=true` at handler time | 2 | 0 | 0 | 1 |

Reading: signal-exit runs Ink's synchronous `unmount` inside `process.exit()` and raw mode is off by the time the
shell prompt returns, so 12 §10's fear ("if Ink itself threw mid-render the tree may be inconsistent") did not
reproduce for the timer/uncaught path; the real defects are (a) the message is written **before** Ink's final frame
and with raw mode still on (`RAW_AT_FATAL=true`), (b) no bracketed-paste reset is emitted because the run never
enabled it (once the composer enables 2004h this becomes load-bearing), (c) nothing about the run is printed.

### 1.3 ENOSPC on the runs dir — 1 MiB HFS+ image (`hdiutil create -size 1m -fs HFS+`, mounted at `/Volumes/jevram`,
filled to 40 KiB free), `jevcode run "add a greeting" --mock --mock-steps 12 --plain --runs-dir /Volumes/jevram/runs`
- Exit code **0**; stderr `stop: complete after 12 steps, $0.0000 generator + $0.0026 jev; run 20260920-191435-fzcvi4vc`.
- 317 stdout lines, **202** of them `write failed`/ENOSPC lines, e.g. `[step 1] error checkpoint: append to steps.jsonl
  failed: ENOSPC: no space left on device, write (/Volumes/jevram/runs/20260920-191435-fzcvi4vc)` and repeated
  `[step 3] warn: decisions.jsonl write failed: append to decisions.jsonl failed: ENOSPC: …` (same line up to 6× per step).
- Run dir afterwards: `steps.jsonl` **0 bytes**, `transcript.log` 4096 bytes (truncated), `decisions.jsonl` 20480,
  `run.json` 2247, **no `state.json` and no `state.prev.json`**.
- `jevcode run --resume 20260920-191435-fzcvi4vc --runs-dir /Volumes/jevram/runs --mock --plain` → exit **3**,
  `jevcode: no usable checkpoint: state.json missing; state.prev.json missing (/Volumes/jevram/runs/…)`.
Reading: the README promise "checkpoint written first in every case" and exit 0 both fail; the user gets a wall of
identical yellow lines and a "complete" run that cannot be resumed.

### 1.4 429 with `Retry-After: 12` (local mock, body `{"error":{"message":"Rate limit exceeded: free-models-per-min. Add credits or wait.","code":429}}`)
TUI, `rows 24 cols 110`, `--mock-generator --jev-base-url http://127.0.0.1:<port> --max-steps 1`:
- Server saw requests at **+0.95 s, +12.96 s, +24.96 s** — `Retry-After` honoured to the second, 3 attempts.
- **195 frames in 24.3 s; 8 frames in every 1-second bucket** (`?2026h` counted per chunk time), `ESC[2J` = 0.
- The only status-line text for 24 s: `step 0/1  ⠋ starting` (spinner cycling). No retry, no countdown, no cause.
- Then `[step 1] error jev_http: Jev HTTP 429: Rate limit exceeded: free-models-per-min. Add credits or wait.`,
  `[run] budget max_steps reached at step start`, `step 1/1 ⠙ intent wall 24s/30m …`, `CHILD_EXIT=4`.
Plain, default limits: 9 requests over 72.9 s (3 steps × 3 attempts, 12 s apart), exit **5** after 72 s, last lines
`[run] warn: stop: error at step 3` / `[run] end error steps=3 wall=1m12s cost=$0.000 (gen $0.000, jev $0.000)
error=jev_http: Jev HTTP 429: …`; stderr `stop: error after 3 steps, $0.0000 generator + $0.0000 jev; run
20260920-191506-5gnampki` — no path, no resume command.

### 1.5 401, DNS-offline, config error (plain)
- 401 (`{"error":{"message":"User not found.","code":401}}`): three requests within **71 ms**, three
  `[step 1..3] error jev_http: Jev HTTP 401: User not found.` items, exit 5 at ~1 s. A bad key burns three steps and
  is reported as an API failure, not a configuration problem; no env-var name is suggested.
- `--jev-base-url http://jev.invalid/`: `[step 1] error jev_http: Jev request failed: TypeError: fetch failed
  (getaddrinfo ENOTFOUND jev.invalid)` after 3 attempts (~1 s of backoff), exit 4 with `--max-steps 1`.
- `--config /tmp/jev17/nonexistent.json`: exit 2, `jevcode: configFile: /tmp/jev17/nonexistent.json (from flag) does
  not exist`, printed by `fatalExit` after the TUI/plain header line `[run] jevcode task: … | step 0/– starting`.
- Missing-key copy shape (not reached in the run above because the config check fired first): `missing()` builds
  `${name}: ${what} is not set (consulted: <sources>)` (`src/config/validate.ts:18-25`).

---

## 2. Reference CLIs (what they show and where they log)

### 2.1 Claude Code (docs, fetched 2026-09-20)
- Error copy (https://code.claude.com/docs/en/errors): `API Error: 401 Invalid authentication credentials`, `Not logged
  in · Please run /login`, `Request rejected (429)`, `Server is temporarily limiting requests`, `You've hit your session
  limit`, `Credit balance is too low`, `API Error: Repeated 529 Overloaded errors`, `Server error mid-response. The
  response above may be incomplete.`, `Unable to connect to API`, `Connection refused —` / `Can't reach the API server
  —` / `No internet route —` / `Couldn't connect through your proxy` / `Connection dropped` "(each with error code in
  parentheses)", `Request timed out`, `API Error: No response from API`, `Waiting for API response · will retry in`,
  `Connection lost mid-response` / `Your computer went to sleep mid-response` / `The response stopped arriving`,
  `Model ... is not a recognized model id`, `Claude Code process exited with code N` (wrapper/IDE message).
- Retry event for machine consumers (https://code.claude.com/docs/en/headless): "When an API request fails with a
  retryable error, Claude Code emits a `system/api_retry` event before retrying" with fields `attempt` (from 1),
  `max_retries`, `retry_delay_ms`, `error_status` (int or null), optional `no_response { waited_ms, retry_wait_ms }`,
  `error` category: `authentication_failed, oauth_org_not_allowed, account_on_hold, billing_error, rate_limit,
  overloaded, invalid_request, model_not_found, server_error, max_output_tokens, cloud_credential_error, unknown`,
  `uuid`, `session_id`; "You can use the event to show retry progress in your own interface." Exit: "exits with code 0
  on success and a non-zero code when the run fails"; SIGTERM → 143.
- `/bug`: "Report a bug or share your conversation. You choose how much session history to include and confirm on a
  consent screen before anything is sent. … on a third-party provider, or without Anthropic credentials, Claude Code
  writes the report to a local archive under `~/.claude/feedback-bundles/` that you forward yourself." `/feedback` is
  its sibling; `/doctor` "Run a setup checkup that diagnoses issues and can fix them"; `/debug` "Enable debug logging
  for the current session … Debug logging is off by default unless you started with `claude --debug`"; `/heapdump`
  writes to `~/Desktop` and warns "The `.heapsnapshot` file contains every string in the process, including your full
  conversation and credentials" (https://code.claude.com/docs/en/commands).
- Log location: `~/.claude/debug/<session-id>.txt` ("read the server's stderr in the debug log at
  `~/.claude/debug/<session-id>.txt`", https://code.claude.com/docs/en/debug-your-config); flags `--debug` ("Enable
  debug mode with optional category filtering, such as `--debug='mcp,startup'` or `--debug='!1p'`") and `--debug-file
  <path>` ("Write debug logs to a specific file path. Implicitly enables debug mode. Takes precedence over
  `CLAUDE_CODE_DEBUG_LOGS_DIR`") (https://code.claude.com/docs/en/cli-reference). `API_TIMEOUT_MS` "default: 600000"
  (https://code.claude.com/docs/en/env-vars). Troubleshooting index routes `API Error: 5xx`, `529 Overloaded`, `429` to
  the error reference and says "run `/doctor` … If `claude` won't start at all, run `claude doctor` from your shell"
  (https://code.claude.com/docs/en/troubleshooting).

### 2.2 Codex (fetched 2026-09-20)
- Logging: "The TUI defaults to `RUST_LOG=codex_core=info,codex_tui=info,codex_rmcp_client=info` and log messages are
  written to `~/.codex/log/codex-tui.log`" … `tail -F ~/.codex/log/codex-tui.log`; `codex exec` "defaults to
  `RUST_LOG=error`, but messages are printed inline" (https://raw.githubusercontent.com/openai/codex/rust-v0.63.0/docs/advanced.md).
  Current source: `const TUI_LOG_FILE_NAME: &str = "codex-tui.log";` and a startup cleanup "Shared append-only TUI logs
  could grow without bound … startup cleanup is best effort" (`remove_legacy_tui_log_file`,
  https://raw.githubusercontent.com/openai/codex/main/codex-rs/tui/src/lib.rs lines 271, 363-366). `CODEX_HOME`
  "Default: `~/.codex` … root directory for Codex state, including configuration, authentication, logs, sessions"
  (https://learn.chatgpt.com/docs/config-file/environment-variables). `codex --debug`: **UNVERIFIED** — not found in
  `docs/config.md`, `docs/advanced.md` or the env-var page fetched; only `RUST_LOG` is documented.
- Lost logs on fast exit: issue #2248 "Messages are not written to codex-tui.log if Codex exits too quickly" — the
  `non_blocking()` `WorkerGuard` "is assigned to a variable but never used", so buffered lines are dropped
  (https://github.com/openai/codex/issues/2248).
- Panic hook: `std::panic::set_hook(Box::new(move |info| { let _ = tui::restore_after_exit(); tracing::error!("panic:
  {info}"); prev_hook(info); }));` — restore terminal first, log, then the default report (lib.rs lines 1105-1114).
- Retry copy: `"Reconnecting... waiting for network"`, `"Reconnecting... {retry_count}/{max_retries}"`, `"Falling back
  from WebSockets to HTTPS transport. {err:#}"`; connection backoff doubles from 5 s, capped at 60 s
  (https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/responses_retry.rs lines 73-109). Config:
  `stream_max_retries` "Defaults to `5`", `request_max_retries` "Defaults to `4`", `stream_idle_timeout_ms` "Defaults to
  `300_000` (5 minutes)" (https://raw.githubusercontent.com/openai/codex/rust-v0.63.0/docs/config.md). Issue #4161
  "Stream retry does not honor 'Try again in x seconds' delays; falls back to exponential backoff" — precedent for
  parsing provider hints and showing the real wait (https://github.com/openai/codex/issues/4161). Issue #22726 "CLI TUI
  remains visually corrupted after stream disconnect" — precedent for repainting after a failed retry
  (https://github.com/openai/codex/issues/22726).

### 2.3 Gemini CLI (fetched 2026-09-20)
- `/bug`: "File an issue about Gemini CLI. By default, the issue is filed within the GitHub repository for Gemini CLI."
  `/about`: "Show version info. Share this information when filing issues." `/stats`; `/chat … debug` "Export the most
  recent API request as a JSON payload" (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/reference/commands.md).
- `--debug`: "Enables debug mode for this session, providing more verbose output. Open the debug console with F12 to
  see the additional logging." `ui.errorVerbosity`: "Controls whether recoverable errors are hidden (low) or fully
  shown (full)", default `"low"`; `general.debugKeystrokeLogging` default `false`; `advanced.bugCommand`
  "Configuration for the bug report command"; `telemetry.outfile` / `GEMINI_TELEMETRY_OUTFILE`
  (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/reference/configuration.md).
- Footer error count: `const showErrorSummary = !showErrorDetails && errorCount > 0 && (isFullErrorVerbosity ||
  debugMode || isDevelopment);` → `<ConsoleSummaryDisplay errorCount={errorCount} />` (width 12); sandbox strings
  `"untrusted"`, `"current process"`, `"all tools"`, `"no sandbox"`
  (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/cli/src/ui/components/Footer.tsx).

### 2.4 opencode (fetched 2026-09-20)
- Logs: macOS/Linux `~/.local/share/opencode/log/`, Windows `%USERPROFILE%\.local\share\opencode\log`; "the most recent
  10 log files" are kept; `--log-level DEBUG` and `--print-logs` (to the terminal)
  (https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/troubleshooting.mdx).
  `Path.log = path.join(data, "log")` (https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/src/global.ts).
- Retry helper: transient-message list (`"econnreset"`, `"econnrefused"`, `"etimedout"`, `"socket hang up"`, …),
  `const wait = Math.min(delay * Math.pow(factor, attempt), maxDelay)`, `attempts = 3`, **no retry-after parsing and
  no UI progress callback** (https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/src/util/retry.ts).
  The dedicated `log.ts` module was not located under `packages/opencode/src/util`, `packages/core/src/util` or
  `packages/core/src` (GitHub contents API listings, 2026-09-20) — **UNVERIFIED** file path; the docs above are the source.

---

## 3. Platform facts the design leans on

### 3.1 Provider error semantics (fetched 2026-09-20)
- Anthropic (https://platform.claude.com/docs/en/api/errors): 401 `authentication_error` "There's an issue with your
  API key (for example, it's malformed, revoked, or expired…)"; 402 `billing_error`; 403 `permission_error`; 429
  `rate_limit_error` "… A tier spend-cap 429 has no `retry-after` header and keeps failing until access resumes";
  500 `api_error` "Retry the request with exponential backoff; if the error persists, contact support with the request
  ID"; 504 `timeout_error`; 529 `overloaded_error` "The API is temporarily overloaded." "The official SDKs automatically
  retry transient failures … twice by default, honoring the `retry-after` header". Every response has a `request-id`
  header (`req_…`) and error bodies carry `request_id` — worth surfacing in the error item and log. Mid-stream: "an
  error can occur after the API returns a 200 response."
- OpenRouter (https://openrouter.ai/docs/api-reference/errors): 401 "Invalid credentials (OAuth session expired,
  disabled/invalid API key)", 402 "Your account or API key has insufficient credits. Add more credits and retry the
  request.", 403 "Forbidden (insufficient permissions, guardrail block, or moderation flag)", 408, 429 "You are being
  rate limited", 502 "Your chosen model is down or we received an invalid response from it", 503 "There is no available
  model provider that meets your routing requirements"; shape `{ error: { code, message, metadata? } }`; streaming:
  "the status stays `200` even when every provider fails — the last error reaches you in the response body".

### 3.2 Process exit ordering (fetched 2026-09-20)
- Node: "'uncaughtException' is a crude mechanism … It is not safe to resume normal operation after
  'uncaughtException'"; `'exit'` listeners "must only perform synchronous operations"; "Calling `process.exit()` will
  force the process to exit as quickly as possible even if there are still asynchronous operations pending … including
  I/O operations to `process.stdout` and `process.stderr`"; "Rather than calling `process.exit()` directly, the code
  should set the `process.exitCode`"; SIGINT/SIGTERM "default handlers … reset the terminal mode before exiting with
  code `128 + signal number`. If one of these signals has a listener installed, its default behavior will be removed"
  (https://nodejs.org/docs/latest-v22.x/api/process.html). "A note on process I/O": writes to `process.stdout`/`process.stderr` are "Files: _synchronous_ on Windows and POSIX · TTYs (Terminals): _asynchronous_ on Windows, _synchronous_ on POSIX · Pipes (and sockets): _synchronous_ on Windows, _asynchronous_ on POSIX" and "not written at all if `process.exit()` is called before an asynchronous write completes" (https://raw.githubusercontent.com/nodejs/node/v22.x/doc/api/process.md lines 4180-4199, fetched 2026-09-20). Consequence: on macOS/Linux the epilogue is safe on a TTY but **lost on a pipe** (CI capture, `2>err.log` is a file and fine) unless written with `fs.writeSync(2, …)` before `process.exit()`.
- signal-exit 3.0.7 patches `process.reallyExit` and `process.emit`; on `process.exit()` the patched emit runs
  `emit('exit', process.exitCode, null)` then `afterexit`; `alwaysLast: true` registers on `afterexit`
  (https://raw.githubusercontent.com/tapjs/signal-exit/v3.0.7/index.js). Ink registers with `alwaysLast: false`, so
  Ink's unmount runs in the `exit` phase — before any `alwaysLast` handler JevCode might add, and before the process'
  own `'exit'` listeners registered later (measured §1.2: cooked mode restored).
- React: error boundaries do not catch "Event handlers", "Asynchronous code (e.g. `setTimeout` …)", "Server side
  rendering", "Errors thrown in the error boundary itself"; `static getDerivedStateFromError` "should be a pure
  function", `componentDidCatch(error, info)` is for side effects and "receives … `componentStack`"
  (https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary). Boundaries must be
  class components — Ink's own comment: "Error boundary must be a class component since getDerivedStateFromError and
  componentDidCatch are not available as hooks" (`ErrorBoundary.js`).

---

## 4. Design

### 4.1 Severity model → surface map
Five severities, six surfaces. A surface never grows the dynamic region beyond the §10 budget; anything the user must
not miss also lands in `<Static>` (06 §11 rule; toast times from lazygit "time.Second*4 … time.Second*2", 06 §11).

| severity | when | status-zone word (left zone, 06 §17) | toast (replaces left zone) | `<Static>` item | live region (≤ 2 rows) | blocking pane | log level |
| --- | --- | --- | --- | --- | --- | --- | --- |
| info | budget notices, `resumed at step N`, replan | — | — | dim `[step n] …` | — | — | info |
| notice (self-healing) | retry in progress, DNS retry, idle-timeout reconnect, alias resolved | `retrying 2/3`, `offline`, `reconnecting` | 2 s `✓ jev back` when it heals | only if the retry chain **failed** (becomes error) or lasted > 10 s (`warning: jev retried 3× over 25 s (HTTP 429)`) | countdown row §4.3 | — | info (+ warn if > 10 s) |
| warning | non-fatal step failure with retry exhausted, drift after first call, one persist failure, candidate refresh failed, sandbox degraded | `!1` counter (Gemini `ConsoleSummaryDisplay` pattern, 03 §7) until `/errors` or Ctrl-O acknowledges | 2 s `! <short>` | yellow `warning: …` | — | — | warn |
| error | `error` event `fatal:false` (stage failed, step committed with error) | `!n` counter | 4 s `! <code>: <short>` | red `error <code>: …` with `request-id` when known | — | — | error |
| blocking | needs a human: 401/403 key, spend cap (Anthropic `enforced_spend_limit_reached`, OpenRouter 402), checkpoint degraded (ENOSPC/EACCES…), first-call drift, sandbox `seatbelt` requested but unavailable | `paused: <reason>` | — | red item when entered and dim item when resolved | — | yes §4.5–4.7 (takes the decisions rows first, like `Confirm`) | error |
| fatal | `error` event `fatal:true`, `run:end` with `stopReason 'error'`, `uncaughtException` | `done error` (bold yellow as today) | — | `[run] end error …` (exists) | cleared | — | error + epilogue §4.8 |

Plain twin: every surface except toast/countdown is already a line (`--plain` prints the same items); countdown and
toast become one-shot lines (§4.11). Screen-reader twin: the status-zone word is announced only on change (12 §1.5).

### 4.2 New engine events (contract additions, `src/core/types.ts`)
```
| { type: 'retry'; side: 'jev' | 'generator'; step: number | null; stage: StageName | null;
    attempt: number; maxAttempts: number; waitMs: number; retryAfter: boolean;
    cause: { kind: 'http' | 'network' | 'timeout' | 'invalid' | 'stream'; status: number | null; code: string | null; message: string } }
| { type: 'retry:settled'; side; step; attempts: number; ok: boolean; totalWaitMs: number }
| { type: 'notice'; step: number | null; kind: 'offline' | 'online' | 'checkpoint:degraded' | 'checkpoint:restored' | 'sandbox' | 'drift'; text: string; detail?: Json }
| { type: 'run:ready'; …; sandbox: SandboxLevel; noNetwork: boolean }          // extend the existing event
```
Plumbing (no new deps): `AskOptions.onRetry?: (r: RetryInfo) => void` consumed at `client.ts:388-391` before
`sleep(waitMs)`; `GenerateOptions.onRetry?` consumed in `withRetry` (`sse.ts:299-301`) before `deps.sleep(delay)`. The
engine forwards to `emit({ type: 'retry', … })`; renderer callbacks already cannot throw into the loop because
`events.emit` isolates listener errors (`engine.ts:393`). `message` is the already-redacted, ≤ 200-char `errorHint`
(`client.ts:100-111`) — never the body. `cause.code` carries `ENOTFOUND | EAI_AGAIN | ECONNREFUSED | ECONNRESET |
ETIMEDOUT | ENETUNREACH | EHOSTUNREACH` from `e.cause.code` when the fetch failed (Node's `fetch failed` wraps the
undici cause), replacing the `TypeError:` prefix leak (§1.5). Extend `SerializedError` with optional `status`,
`retryable`, `side`, `requestId` so the `error` item and `--json` can say *what kind* of failure it was; `toJSON()` of
`JevHttpError`/`ProviderHttpError` fills them.

### 4.3 Retry countdown row (inside the ≤ 2-row live region)
- Format (fixed width classes, no colour-only meaning):
  `jev: retrying 2/3 in 12 s · HTTP 429 rate limited (Retry-After)` /
  `generator: retrying 1/3 in 4 s · idle 60 s, no data` /
  `jev: retrying 3/3 in 2 s · network ENOTFOUND openrouter.ai` .
  Second row (only when the first attempt cause differs): `last: HTTP 529 overloaded · request-id req_…`.
- Tick: one `live` dispatch per second (a `setInterval(1000)` owned by the reducer hook, cleared on `retry:settled`),
  so the row costs **1 frame/s**; the spinner keeps its 8 fps only while `reducedMotion` is off (12 §2). Reduced-motion
  twin: spinner frozen, countdown still 1 Hz (≤ 4/s budget met; measured baseline without the row is 8 fps, §1.4).
  No sub-second animation, no progress bar.
- Status-zone word `retrying 2/3` (left zone) for the duration; on `retry:settled ok:true` a 2 s `✓ jev back` toast; on
  `ok:false` the existing `error` item follows and the row clears in the same reducer action (same rule as `proposal`
  clearing the live buffer, `useEngine.tsx:100-108`).
- Long waits: `Retry-After` is capped at 60 s (`JEV_RETRY.maxRetryAfterSeconds`, `RETRY_AFTER_CAP_MS`), so the row never
  shows more than `60 s`; a retry chain > 10 s also writes one `warning:` Static line at settle (§4.1) so scrollback
  explains the gap in the wall clock.
- Keys during a retry: `Esc` = pause at the next boundary as designed in 10 §15.4 (the sleep is abortable —
  `sleep(ms, signal)` rejects on abort, `src/core/time.ts:44-52`); `r` = retry now (new: `AbortSignal`-free
  `wake()` on the retry sleep — implement as a second signal `opts.wake` or resolve the sleep early via a shared
  `EventTarget`; keep it out of v1 if it complicates the client, see OPEN QUESTIONS).
- Plain twin: `[step 1] warn: jev retry 2/3 in 12 s (HTTP 429 rate limited)` one line per attempt, no countdown.
  Screen-reader twin: announce once per attempt (same line), never per tick.

### 4.4 Offline / no-network banner
- Classify from `cause.code`: `ENOTFOUND | EAI_AGAIN` → `offline: DNS lookup failed for <host>`; `ENETUNREACH |
  EHOSTUNREACH | ECONNREFUSED` → `offline: cannot reach <host>`; `ETIMEDOUT`/`TimeoutError` → `no response from <host>
  in 10 s`. Host is `new URL(cfg.baseUrl).host` — never the full URL (query strings could carry secrets).
- Surface: status-zone word `offline` + the countdown row (`jev: retrying 2/3 in 1 s · network ENOTFOUND …`). After the
  chain fails: red `error jev_http: offline — DNS lookup failed for openrouter.ai (ENOTFOUND)`; `notice online` → toast
  `✓ network back` on the next successful call.
- `--no-network` is **not** offline: it "deny[s] network to sandboxed commands" (`args.ts:99`; README) and does not touch
  Jev/provider calls. Show it as a status-zone badge `sandbox: no-net` from the extended `run:ready.noNetwork`, and
  when a `run` action fails with a network-looking error under `--no-network`, the outcome line appends `(sandbox
  network denied by --no-network)` so the user does not misread it as an outage.
- Do not probe connectivity (no extra requests, zero network at launch); the banner is derived from failures only.

### 4.5 401/403 → onboarding pane (and the "burn three steps in 71 ms" fix)
- Engine rule (mirrors first-call drift, `engine.ts:895-900`): a `JevHttpError`/`ProviderHttpError` with status 401 or
  403 on the **first successful-or-not call of the run** for that side stops the run immediately with
  `exitCode 2` (`ConfigError` semantics) instead of committing a failed step; later 401s (key revoked mid-run) are a
  blocking pause, not three failed steps. Measured today: 3 requests in 71 ms, exit 5 (§1.5).
- Pane (blocking, replaces decisions rows, ≤ 8 rows, `Confirm`-style header):
  ```
  jev: key rejected (HTTP 401 — "User not found.")
  Set the decider key and retry. Consulted: --jev-api-key, OPENROUTER_API_KEY, ./.env, ~/.config/jevcode/config.json
  The key is never printed or logged.
  [r] retry with the current key   [q] stop (exit 2)   /keys for help
  ```
  The consulted list is `SettingReader.sources()` (`validate.ts:10-14`) — the same text `missing()` uses, so the
  pane and the `ConfigError` line agree. `q` in one-shot mode exits 2 with the epilogue; in session mode the composer
  reopens with `/keys` help.
- Entering a key inside the TUI (masked composer, process-memory only, never in `history.jsonl`) is gap 11 in
  00-SUMMARY and stays an OPEN QUESTION; v1 tells the user which variable to set in another shell and offers `[r]`.
- Anthropic key on the generator side: same pane with `ANTHROPIC_API_KEY`; the error copy quotes the provider's
  `error.message` clipped to 120 chars (Claude Code prints `API Error: 401 Invalid authentication credentials`).

### 4.6 429 / 402 / 5xx / 529 / drift / sandbox
- 429 with `Retry-After` or 5xx/529: notice → countdown row → (if exhausted) `error` item. After **one** exhausted
  chain with zero actions executed in the step, do not commit a failed step and start another 24 s of silence: enter
  `paused: jev unreachable` (blocking) with an auto-retry countdown `retrying in 30 s (auto, doubles to 5 min) · [r] now
  [q] stop`; the step is discarded (§9.1 rule 1 point). Measured cost today: 72 s and exit 5 for a transient outage,
  or `budget max_steps` masking the real cause (§1.4). Non-interactive (`--plain` on a pipe, bench) keeps the current
  three-failures rule so CI never hangs; document the difference in the exit-code table (§4.9).
- 429 spend cap (Anthropic `enforced_spend_limit_reached`, no `retry-after`) and OpenRouter 402: blocking pane
  `provider: spend limit reached — "<message>" · this keeps failing until access resumes · [q] stop (exit 5)`; no auto
  retry. Anthropic's own words: "keeps failing until access resumes" (§3.1).
- Anthropic `event: error` after a 200 and OpenRouter's 200-with-error-body are already mapped to statuses
  (`anthropic.ts:118-127`, `openrouter.ts`); they take the same path — the countdown row says `stream error 529
  overloaded`.
- Jev model alias drift after the first call: warning item (exists) + 4 s toast `! jev alias resolved to
  jev-1.13-20260917` + `/jev` shows `configured / resolved / drift@step` (10 §15.9 `/jev` row). First-call drift keeps
  exit 2 and gets a pane variant: `jev: served "<served>" but --jev-model is "<configured>" · [p] pin --jev-model <served>
  for the next run  [q] stop`.
- Sandbox: `run:ready.sandbox` → status-zone badge `sandbox: seatbelt` (dim) or `sandbox: none` (yellow; Gemini renders
  `'no sandbox'` in `theme.status.error`, 03 §7) plus one `warning:` item at run start when profile `auto` degraded:
  reuse the copy from `commandConfig` ("no sandbox-exec: cwd confinement, env scrubbing, timeout, output cap and tree
  kill only; .git/config and .git/hooks are writable by commands", `main.tsx:233`). Profile `seatbelt` explicitly
  requested but unavailable → `SandboxError` today (exit 6): make it a blocking pane in session mode.

### 4.7 Disk errors (ENOSPC/EACCES/EROFS/EDQUOT/EIO/EMFILE on the run dir)
- Classify in `persist()` and the commit checkpoint (`engine.ts:600-611, 1441-1450`) by `e.code`; emit `notice
  checkpoint:degraded { file, code, path }` **once per (file, code)** and keep a counter — measured 202 identical lines
  in 12 steps (§1.3) become one red item `error checkpoint: steps.jsonl — ENOSPC: no space left on device
  (/Volumes/jevram/runs/<id>)` + status-zone `disk ×202`.
- Pause at the step boundary (10 §15.4 `pauseRequested`, rule-1 point) with a blocking pane:
  ```
  checkpoint degraded: ENOSPC on /Volumes/jevram/runs/20260920-191435-fzcvi4vc
  state.json could not be written since step 1 — the run cannot be resumed from here.
  [r] retry the write   [c] continue without checkpoints   [q] stop now (exit 3)
  ```
  `[r]` re-runs `writeState(snapshot)`; success → `notice checkpoint:restored`, toast `✓ checkpoint restored`, run
  continues. `[c]` sets `checkpointDegraded = true`, which changes the **exit code of a later stop**: `complete` with a
  missing/stale `state.json` exits **3**, never 0, and the epilogue says `state.json missing — not resumable` (measured
  today: exit 0, then `--resume` fails with exit 3, §1.3). The `transcript.log` failure keeps the UI intact and is
  logged only to `JEVCODE_LOG` if that lives on another volume (§4.10); when both share the volume, the pane is the record.
- `EACCES`/`EPERM`/`EROFS` on `~/.jevcode` at launch (before the run dir exists) is a `ConfigError` today; add the
  path and the fix to the copy: `runsDir: /Users/x/.jevcode/runs is not writable (EACCES) — chown it or pass --runs-dir`.
- Never `process.exit` from the disk path; the 5 s final-checkpoint bound (`SHUTDOWN_CHECKPOINT_BOUND_MS`) stays.

### 4.8 Ink render-error boundary and the crash epilogue
- Add `class PaneBoundary extends React.Component<{ pane: string; onError(e, info) }, { failed: boolean }>` in
  `src/tui/PaneBoundary.tsx` (class is mandatory, §3.2) and wrap **each dynamic pane separately** (`live`, `Decisions`,
  `Confirm`, `StatusLine`) plus the `<Static>` child renderer. Fallback = one row: `ui: decisions pane failed to render
  (TypeError) — run continues; details in <log>`; `componentDidCatch` logs the redacted stack + `componentStack` to
  `JEVCODE_LOG` and dispatches a `transcript error` item through the bus (renderer-only, never through the engine).
  The boundary sits *below* `<App>` so the one `useInput` hook keeps working; Ink's `InternalErrorBoundary` must
  never fire — measured: it prints 42 rows, emits `ESC[2J ESC[3J` (clears screen **and scrollback**), drops raw mode
  and unmounts while the engine runs on (§1.1). A failed `StatusLine` falls back to the plain `formatStatusLine`
  string inside a bare `<Text>`; a failed `Confirm` must **decline** the pending request via `confirmer.resolve(id,
  false)` so the engine never waits on a pane that cannot draw.
- Fault-injection hook for tests (dev-only, gated by `process.env.JEVCODE_FAULT`): `render:<pane>` throws once in
  that pane's render on the next event, `persist:ENOSPC` makes `persist()` reject once, `jev:429:12` makes the mock
  decider answer 429 with `Retry-After: 12` once. Gate: pty test asserts `ESC[2J` = 0 and the fallback row present.
- Boundaries do not catch errors in effects/timers/handlers (§3.2), so `fatalExit` stays the last resort, re-ordered:
  1. `process.exitCode = err.exitCode` (Node's advice) and `aborting` guard (idempotent).
  2. Synchronous terminal restore **before anything is printed**: `stdin.isTTY && stdin.setRawMode(false)`;
     `fs.writeSync(1, '\x1b[?2004l\x1b[?25h')` (+ `'\x1b[<u'` once kitty is enabled) — no `ESC c`, no `ESC[2J`
     (07 §3.5, 12 §10; Codex restores in its panic hook first, §2.2). Measured: the message is currently written while
     `isRaw === true` (§1.2).
  3. `engine?.abort('error')` so the engine's `process.on('exit')` last-resort writes `state.json` synchronously
     (DESIGN §11), then `renderer.unmount()` raced with `UNMOUNT_TIMEOUT_MS` (2 s) — bounded because resuming after
     `uncaughtException` is unsafe (Node, §3.2).
  4. Epilogue via `fs.writeSync(2, …)` (see the I/O note in §3.2), then `process.exit(process.exitCode)`.
- Epilogue (both one-shot modes, ≤ 6 lines, after the last frame, stderr):
  ```
  jevcode: stopped — jev_http: Jev HTTP 429: Rate limit exceeded: free-models-per-min (exit 5)
    run       20260920-191506-5gnampki
    files     ~/.jevcode/runs/20260920-191506-5gnampki/  (transcript.log, state.json, jevcode.log)
    resume    jevcode run --resume 20260920-191506-5gnampki
    report    jevcode report 20260920-191506-5gnampki   (writes a redacted bundle locally; nothing is sent)
  ```
  Variants: `state.json missing — not resumable` replaces the resume line after a degraded checkpoint; for
  `ConfigError` before a run dir exists: `jevcode: <message> (exit 2)` + `help: jevcode run --help`; for
  `human_abort`/`signal`: `stopped by Ctrl-C after step 3 — checkpoint written (exit 130)` + resume line. Session mode
  (process stays alive, 10 §15.4): the same block is a `<Static>` item and the composer reopens; the epilogue is
  printed only when the process exits. `JEVCODE_DEBUG=1` appends the stack after the block, never inside a frame.
- SIGHUP/EIO/EPIPE: keep 07 §3.4 (A81): `'error'` listeners on stdin/stdout/stderr installed before SIGHUP logic;
  on a dead terminal write the checkpoint, **skip the epilogue** (writing to a dead pty is what crashed the process
  in the measurement), exit 129.

### 4.9 Exit-code table for session mode
| situation | one-shot `jevcode run "task"` (today, kept) | session TUI `jevcode` (process outlives runs) |
| --- | --- | --- |
| run complete | 0 | run:end item `exit 0`; process continues |
| budget/directive/`human_pause` | 4 | item `exit 4`; composer reopens |
| ConfigError/usage at launch | 2 | 2 (nothing to keep alive) |
| 401/403 first call, first-call drift | **2** (new; today 5) | blocking pane → `[q]` = item `exit 2`, process continues |
| API failure after retries (3 failed steps / spend cap `[q]`) | 5 | item `exit 5` |
| checkpoint degraded and stop | **3** (new; today 0) | item `exit 3` + not-resumable notice |
| sandbox/path abort | 6 | item `exit 6` |
| Ctrl-C ×2 within 1.5 s / SIGINT | 130 | 130 (process exits; per 06 §17 double-press) |
| SIGTERM | 143 | 143 |
| SIGHUP / EIO on the terminal | 129 | 129 |
| `uncaughtException`/render fault escalated | 1 (epilogue) | 1 |
| `/exit`, Ctrl-D on empty composer | — | **0 always** (leaving is not a failure); `--exit-code=last-run` opt-in for scripts |
The `--json` stream carries `exitCode` on every `run:end`, so a wrapper never needs the process code in session mode.

### 4.10 Logs: `JEVCODE_LOG`, `--verbose`, redaction, retention, the `/bug` twin
- One file per run: `<runDir>/jevcode.log` (run-scoped like Claude Code's `~/.claude/debug/<session-id>.txt` and
  next to `transcript.log`, so `jevcode report` bundles both). Pre-run failures (config, usage) and session-level
  events go to `~/.jevcode/logs/jevcode-<pid>-<yyyymmdd-hhmmss>.log`; keep the newest 10 files there (opencode rule,
  §2.4). Never stdout/stderr while Ink is mounted (`patchConsole: false` means any stray write corrupts the frame).
- Levels: `error | warn | info | debug | trace`. Default file level `info` (retry/notice/error/run lifecycle, one line
  each, ≤ 512 chars). `--verbose` (or `JEVCODE_LOG_LEVEL=debug`) adds decisions, request hashes, latencies, checkpoint
  timings; `trace` absorbs today's `JEVCODE_TRACE` lines (keep `JEVCODE_TRACE=<file>` as an alias that sets
  `JEVCODE_LOG=<file>` + level trace). `--verbose` never changes the frame; the in-TUI twin is Ctrl-O/`/errors`, which
  expands the last N warnings/errors as `<Static>` items (Claude Code's `Ctrl+O` verbose transcript, 02 A-row 711).
- Line format: `2026-09-20T19:15:06.123Z warn  jev.retry step=1 attempt=2/3 wait=12000 status=429 msg="Rate limit …"`
  — key=value, no JSON escaping surprises, greppable; the same `redact` from `resolveConfig` (`config.redact`) wraps
  every message and every `detail`; keys, bodies and prompts never enter the file (`JEV_ERROR_BODY_MAX`-clipped hints
  only). Keystrokes: log a **category** only (`key printable`, `key ctrl-c`, `paste 812 chars`) — fix `App.tsx:126`
  before the composer lands (12 §0).
- Writes: `warn`+ with `appendFileSync` (Codex #2248 lost buffered lines on fast exit, §2.2); `info`- through a small
  buffer flushed every 250 ms and in the `'exit'` handler synchronously. Disk failure of the log itself is swallowed
  (never a second error path), and the log is skipped when it shares a degraded volume with the run dir (§4.7). Cap
  the file at 8 MiB with one rotation (`jevcode.log.1`).
- `/bug` twin, no network: `jevcode report <run-id>` (CLI) and `/report` (TUI) write
  `~/.jevcode/reports/<run-id>/` containing `run.json` (secrets are already fingerprints, `config.record()`),
  `transcript.log`, `jevcode.log`, `steps.jsonl` tail (last 20), `jevcode config --json`, `versions.txt` (node,
  jevcode, ink, terminal `TERM`/`TERM_PROGRAM`, rows×cols), and `README.txt` with the GitHub issues URL — the
  Claude Code pattern of a local archive "that you forward yourself" (§2.1) and Gemini's `/about` "Share this
  information when filing issues" (§2.3). Everything passes `redact`; the report never includes `jev.jsonl`
  request bodies (they contain workspace text) unless `--include-requests` is passed.

### 4.11 `--json` (run mode) event schema for errors and retries
NDJSON, one `EngineEvent` per line plus `t` (ISO) and `runId`; error-relevant lines:
```
{"t":"…","runId":"…","type":"retry","side":"jev","step":1,"stage":"intent","attempt":2,"maxAttempts":3,"waitMs":12000,"retryAfter":true,"cause":{"kind":"http","status":429,"code":null,"message":"Rate limit exceeded: free-models-per-min"}}
{"t":"…","runId":"…","type":"retry:settled","side":"jev","step":1,"attempts":3,"ok":false,"totalWaitMs":24000}
{"t":"…","runId":"…","type":"error","step":1,"fatal":false,"error":{"name":"JevHttpError","code":"jev_http","message":"Jev HTTP 429: …","exitCode":5,"status":429,"retryable":true,"side":"jev","requestId":null},"hint":"rate limited; the run pauses after one exhausted retry chain"}
{"t":"…","runId":"…","type":"notice","step":2,"kind":"checkpoint:degraded","text":"steps.jsonl: ENOSPC","detail":{"file":"steps.jsonl","code":"ENOSPC","path":"/Volumes/jevram/runs/…"}}
{"t":"…","runId":"…","type":"run:end","result":{…,"stopReason":"error","error":{…}},"exitCode":5,"resumable":true,"paths":{"runDir":"…","transcript":"…/transcript.log","log":"…/jevcode.log"}}
```
Mirrors Claude Code's `system/api_retry` (`attempt`, `max_retries`, `retry_delay_ms`, `error_status`, `error`
category) with JevCode's typed `code` instead of a free category. Unknown `type`s must be ignored by consumers
(same rule the providers apply to their SSE, `src/provider/types.ts` header). `--json` implies `--plain`-style
non-interactive mode: no countdown ticks are emitted (the `retry` line carries `waitMs`).

### 4.12 Plain and screen-reader twins
| TUI surface | `--plain` line | `--screen-reader` (Ink `<Static>` + one input line, 12 §1.5) |
| --- | --- | --- |
| countdown row (1 Hz) | `[step 1] warn: jev retry 2/3 in 12 s (HTTP 429 rate limited)` once per attempt | same line, announced once per attempt |
| status-zone `retrying 2/3` / `offline` / `paused: disk` | (folded into the lines above) | announce on change only: `status: retrying 2 of 3` |
| toast `✓ jev back` (2 s) / `! error` (4 s) | `[step 1] info: jev back after 3 attempts (25 s)` | same, as a Static line |
| red `error jev_http: …` item | identical (already shared) | identical, prefixed `error:` (A98) |
| `!n` counter | none (every line is already printed) | `n errors so far` appended to the status announcement |
| blocking pane | `readline` question `checkpoint degraded (ENOSPC on …). [r]etry / [c]ontinue / [q]uit:` with the abort signal, `createInterface({ terminal: false })` on a pipe → immediate `q` (DESIGN §10 plain confirmer rules) | pane text as consecutive Static lines + the same one-key prompt |
| epilogue | identical block on stderr | identical |

### 4.13 Tests to add (no new devDeps; layers from 12 §12)
- Unit (vitest, `ink-testing-library`): reducer `retry` → live row text and 1 Hz tick; `retry:settled` clears the row
  in the same action; `PaneBoundary` fallback row via a throwing child; dedupe of `checkpoint:degraded`; exit-code table
  as a pure function `exitCodeFor(stop, result, degraded)`.
- pty (`script`, as `perf/render-lag.ts`): `JEVCODE_FAULT=render:decisions` → `ESC[2J` = 0, fallback row present,
  keys still handled (send `y` to a pending confirm); `JEVCODE_FAULT=jev:429:12` with `--mock` → server-less countdown
  row visible at 1 fps ± 1 in the wait window and 8 fps spinner unchanged; reduced-motion twin ≤ 4 fps.
- Disk: the `hdiutil` 1 MiB image script from §1.3 as an opt-in macOS test (`JEVCODE_TEST_RAMDISK=1`), asserting the
  pane, exit 3 on `[q]`, and that a resumed run after `[r]` succeeds; a portable variant injects `ENOSPC` through
  `JEVCODE_FAULT=persist:ENOSPC`.
- Crash: `exit3.mjs`-style child with `uncaughtException` in a pty; assert `stty -a` shows `icanon echo`, the epilogue's
  five lines are present **after** the last frame bytes, and `state.json` exists.

---

## ADOPT

| # | What JevCode should do | Why | Source |
| --- | --- | --- | --- |
| A1 | Add `onRetry` callbacks in `ask()`/`withRetry` and a `retry`/`retry:settled` engine event; render a 1 Hz countdown row `jev: retrying 2/3 in 12 s · HTTP 429 rate limited (Retry-After)` in the live region | Measured: 24 s of `step 0/1 ⠋ starting` with no explanation; Claude Code emits `system/api_retry` with `attempt/max_retries/retry_delay_ms`; Codex prints `Reconnecting... {retry_count}/{max_retries}` | §1.4; `client.ts:388-391`; https://code.claude.com/docs/en/headless; responses_retry.rs (2026-09-20) |
| A2 | Own `PaneBoundary` class per dynamic pane with a one-row fallback; Ink's `InternalErrorBoundary` must never fire | Measured: Ink's overview is 42 rows → `ESC[2J ESC[3J` (screen + scrollback cleared), raw mode dropped, engine keeps running headless, error swallowed by `waitUntilExit().catch` | §1.1; `App.js:550`, `ErrorBoundary.js`, `ink.js:276-277, 295-304` |
| A3 | Re-order `fatalExit`: exitCode → sync terminal restore (`setRawMode(false)`, `?2004l ?25h`) → `engine.abort('error')` → bounded unmount → epilogue via `fs.writeSync(2)` → exit | Node: `process.exit` forces exit before pending stdout/stderr I/O; message is written while `isRaw === true` today | §1.2; §3.2; `main.tsx:275-283` |
| A4 | Crash/stop epilogue after the last frame: message + exit code, run id, run dir with `transcript.log`/`state.json`/`jevcode.log`, `jevcode run --resume <id>`, `jevcode report <id>` | Today interactive mode prints nothing after unmount; plain prints `stop: … run <id>` with no path or command | `main.tsx:198`; §1.4 |
| A5 | Disk errors: dedupe to one item + counter, pause at the step boundary with `[r] retry [c] continue [q] stop`, and exit 3 (never 0) when `state.json` could not be written | Measured: 202 identical lines, `steps.jsonl` 0 B, no `state.json`, exit 0, then `--resume` exits 3 | §1.3; `engine.ts:600-611, 1447-1449`; 10 §15.4 |
| A6 | 401/403 on the first call → stop with exit 2 and an onboarding pane listing the consulted sources; later 401 → blocking pause | Measured: three failed steps in 71 ms reported as exit 5; Claude Code routes to `/login` (`Not logged in · Please run /login`) | §1.5; `validate.ts:10-25`; https://code.claude.com/docs/en/errors |
| A7 | After one exhausted retry chain with no action executed, pause (`paused: jev unreachable`, auto-retry 30 s→5 min) instead of committing three failed steps | Measured: 72 s and exit 5 for a transient 429; with `--max-steps 1` the cause is masked as `budget max_steps` (exit 4) | §1.4; `engine.ts:175, 1099-1103` |
| A8 | Spend-cap 429 (`enforced_spend_limit_reached`) and OpenRouter 402 are blocking panes, not retries | Anthropic: "keeps failing until access resumes"; OpenRouter 402 "Add more credits and retry" | §3.1; `anthropic.ts:284-294`; `openrouter.ts:243-253` |
| A9 | Map network `cause.code` (ENOTFOUND/EAI_AGAIN/ECONNREFUSED/…) to `offline: …` copy and a status-zone `offline` word; keep `--no-network` as a distinct `sandbox: no-net` badge | Current copy leaks `TypeError: fetch failed (getaddrinfo ENOTFOUND …)`; `--no-network` only affects sandboxed commands | §1.5; `client.ts:87-93`; `args.ts:99` |
| A10 | Extend `run:ready` with `sandbox` and `noNetwork`; show `sandbox: none` in yellow plus one warning item when `auto` degraded | The level never reaches a renderer today; Gemini renders `no sandbox` in the error colour | `engine.ts:551, 1161`; Footer.tsx (2026-09-20) |
| A11 | `JEVCODE_LOG` file per run (`<runDir>/jevcode.log`, `~/.jevcode/logs/` before a run, keep 10), levels, key=value lines, `redact` on every line, keystroke *categories* only, sync writes for warn+, never stdout | Claude Code `~/.claude/debug/<session-id>.txt`; Codex `~/.codex/log/codex-tui.log` + #2248 lost lines; opencode keeps "the most recent 10 log files"; `App.tsx:126` logs raw keys | §2.1–2.4; 12 §0 |
| A12 | `--verbose` = debug level to the file only; the in-frame twin is Ctrl-O/`/errors` expanding recent warnings as Static items | Gemini `--debug` opens a separate console (F12) and `ui.errorVerbosity low|full`; Claude Code Ctrl+O | configuration.md (2026-09-20); 02 row 711 |
| A13 | `jevcode report <run-id>` / `/report`: local redacted bundle, nothing sent | Claude Code `/bug` writes to `~/.claude/feedback-bundles/` when it cannot send; Gemini `/about` for issue info | https://code.claude.com/docs/en/commands; commands.md (2026-09-20) |
| A14 | Extend `SerializedError` with `status`, `retryable`, `side`, `requestId`; include Anthropic `request-id` in error items and logs | Renderers cannot tell 429 from 500 today; Anthropic asks for the request ID when contacting support | `types.ts:310-315`; §3.1 |
| A15 | `--json` run stream with `retry`, `error`, `notice`, `run:end.exitCode/paths/resumable` lines; consumers ignore unknown types | Claude Code `system/api_retry` and `result` precedent | §4.11 |
| A16 | Toast timings 2 s (info/warn) / 4 s (error) replacing the status left zone; `!n` counter until acknowledged | lazygit `time.Second*4 … time.Second*2`; Gemini `ConsoleSummaryDisplay` gated on `errorCount > 0` | 06 §11; Footer.tsx |
| A17 | Fault-injection env `JEVCODE_FAULT=render:<pane>|persist:ENOSPC|jev:429:12` for pty tests; gate `ESC[2J` = 0 | Makes the three measured failures reproducible in CI without hdiutil or a server | §1.1, §1.3, §1.4 |

## REJECT

| # | What not to do | Why |
| --- | --- | --- |
| R1 | Letting Ink's `ErrorOverview` render (stack in the frame) | 42 rows → `clearTerminal` (`ESC[2J ESC[3J`), scrollback erased, raw mode dropped, engine continues headless (§1.1) |
| R2 | Modal/floating error dialogs or a multi-row banner | Violates the `rows − 2` height budget; blocking panes take the decisions rows exactly like `Confirm` (DESIGN §10) |
| R3 | Per-tick sub-second countdown or a progress bar for retries | Baseline is already 8 fps from the spinner; a 1 Hz row is enough and meets the ≤ 4/s reduced-motion twin (§1.4, 12 §2) |
| R4 | `ESC c` (RIS) or `ESC[2J` in `fatalExit`/crash restore | Zero-clear rule; the terminal was already restored by signal-exit + libuv in the measured path (§1.2); 07 §3.5 |
| R5 | Printing the fatal message before unmount / while raw mode is on, or with `process.stderr.write` immediately followed by `process.exit` | Measured `RAW_AT_FATAL=true`; Node: `process.exit` may drop pending stdio writes (§3.2) |
| R6 | Continuing to exit 0 (and print "complete") after `state.json` failed to write | The run is not resumable (`--resume` → exit 3); README promises the checkpoint is written first (§1.3) |
| R7 | One transcript line per failed write | 202 lines in 12 steps (§1.3) — dedupe + counter |
| R8 | Treating 401/403 as a retryable or step-level failure | Three steps burned in 71 ms; it is configuration, exit 2, onboarding (§1.5) |
| R9 | Probing the network at launch or on a timer to show an "offline" banner | Zero network before the first frame is a hard constraint; derive the state from failures only |
| R10 | Logging to stdout/stderr while Ink is mounted, or logging raw keystrokes/bodies/prompts | `patchConsole: false` frames corrupt; keys-never-in-logs constraint; `App.tsx:126` already at risk (12 §0) |
| R11 | An async-buffered logger without a synchronous flush for warn+ | Codex #2248: buffered lines lost when the process exits quickly |
| R12 | Sending reports over the network or embedding `jev.jsonl` bodies by default | No network dependency for support; workspace text in request bodies; Claude Code's local-archive pattern suffices |
| R13 | Auto-retrying spend-cap 429/402 | "keeps failing until access resumes" (Anthropic); wastes wall time and hides the real fix |
| R14 | Parsing natural-language "try again in N seconds" from bodies in v1 | Codex #4161 shows the provider-phrase zoo; headers (`Retry-After`, `retry-after-ms`) are already honoured — add the parser only when a provider is observed sending hints without headers |
| R15 | Making `/exit` return the last run's exit code by default | Leaving a session is not a failure; scripts have `--json run:end.exitCode` (§4.9) |

## OPEN QUESTIONS

1. Entering/rotating a key inside the TUI after a 401 (masked composer, memory-only) — 00-SUMMARY gap 11; v1 shows the
   variable names and `[r]`. Does the composer ever accept a secret at all?
2. `[r] retry now` during a retry sleep needs an early-wake path in `client.ts`/`sse.ts` (a second signal or a shared
   waker); is it worth the client-surface change in v1, or is `Esc`-pause + `/resume` enough?
3. Auto-retry pacing for `paused: jev unreachable` (30 s doubling to 5 min proposed) and whether the bench/plain
   non-interactive path should ever pause (proposal: never; keep three-failures → exit 5).
4. Should a run that finished `complete` with a degraded checkpoint exit 3 or 4? Proposal: 3 (`checkpoint`), because
   the defect is the artefact, not the budget — needs a DESIGN §11 edit.
5. Where does the per-run log go when the run dir itself is unwritable — `~/.jevcode/logs/` fallback (proposed) or
   `os.tmpdir()`? And the retention rule for `<runDir>/jevcode.log` (no automatic deletion, like runs; 10 §15.5).
6. Codex `codex --debug` and opencode's `log.ts` location remain UNVERIFIED (not found in the fetched docs/listings);
   the documented `RUST_LOG`/`~/.codex/log/codex-tui.log` and `~/.local/share/opencode/log/` suffice for the design.
7. Should `retry` events be persisted (`jev.jsonl` already records paid requests; failed attempts are not) — useful for
   `/jev` latency p50/p95 honesty, but grows the file during outages.
8. The `!n` error counter: acknowledge on Ctrl-O only, or also on the next successful step?
9. Bracketed paste / kitty restore strings in `fatalExit` become load-bearing once the composer enables them
   (`?2004h` = 0 in every current capture, 12 §0); confirm the exact set with 07 §3.1 when the composer lands.
10. Whether the ENOSPC pty test should stay macOS-only (`hdiutil`) or use the `JEVCODE_FAULT=persist:ENOSPC` twin only.

---

## Verification log (2026-09-20)
- Local reads: `src/errors.ts`, `src/jev/client.ts`, `src/jev/types.ts`, `src/provider/{types,sse,anthropic,openrouter}.ts`,
  `src/cli/{main.tsx,args.ts}`, `src/tui/{App.tsx,useEngine.tsx,plain.ts,StatusLine.tsx,Transcript.tsx}`,
  `src/loop/engine.ts`, `src/checkpoint/{store,resume}.ts`, `src/config/{resolve,validate,defaults}.ts`,
  `src/core/types.ts`, `README.md`, `docs/DESIGN.md` §10–§12, `docs/STATUS.md`, research 00 §8, 02 §4, 03 §7, 06 §11,
  07 §3.4–3.5, 10 §15.4–15.9, 12 §0/§10/§11; `node_modules/ink/build/{ink.js,components/App.js,components/ErrorBoundary.js,
  components/ErrorOverview.js,reconciler.js}`, `node_modules/ink/readme.md`, `node_modules/signal-exit/package.json`.
- Fetched: nodejs.org process docs (v22.x), raw `nodejs/node` `doc/api/process.md` (v22.x), signal-exit v3.0.7 `index.js`,
  react.dev Component reference, platform.claude.com API errors, code.claude.com errors/commands/cli-reference/
  troubleshooting/debug-your-config/headless/env-vars, openrouter.ai errors, openai/codex `docs/advanced.md` (rust-v0.63.0),
  `docs/config.md` (rust-v0.63.0 and main), `codex-rs/tui/src/lib.rs`, `codex-rs/core/src/responses_retry.rs`,
  `codex-rs/core/src/client.rs`, issues #2248/#4161 (+ #22726 via search), learn.chatgpt.com env vars,
  google-gemini/gemini-cli `docs/reference/{commands,configuration}.md`, `docs/cli/cli-reference.md`,
  `packages/cli/src/ui/components/Footer.tsx`, anomalyco/opencode `packages/web/src/content/docs/troubleshooting.mdx`,
  `packages/core/src/global.ts`, `packages/core/src/util/retry.ts` (+ GitHub contents API listings).
- Fetch failures: `google-gemini/gemini-cli/docs/cli/commands.md` and `docs/get-started/configuration.md` (404 —
  docs moved to `docs/reference/`), `anomalyco/opencode/packages/opencode/src/util/log.ts` (404), `openai/codex/docs/advanced.md`
  on `main` (404; the rust-v0.63.0 tag was used), docs.anthropic.com → redirected to platform.claude.com (followed).
- Scratch: `/tmp/jev17/{throw.mjs,throw2.mjs,exit3.mjs,srv429.mjs,srv401.mjs,pty429.mjs,runto.mjs,ram.dmg}` and the
  `*.log`/`*.err`/`*.out` captures named in §1.
