# 16. Secrets typed or pasted into the composer: pre-submit check, `@`-mention denylist, history and clipboard payloads

Research for the JevCode chat-style TUI (gap-fill topic, 2026-09-20). Scope: what happens to a secret that a human
types or pastes into the composer, mentions with `@`, recalls from history, or copies out with `/copy`. Every
claim carries its source and fetch date; local files are cited by path and were read on 2026-09-20. Measurements
were made under `/tmp/jev-secrets` with the repo's own `tsx`, Node v22.23.2 and `ink` 7.1.1 from
`/Users/prateekjannu/Documents/vscode/JevCode/node_modules`.

Verdict in one paragraph. `src/core/redact.ts` is already the right engine (exact set + format patterns +
`addSecret`); what is missing is *when it is fed* and *which sinks the composer adds*. The composer adds five sinks
that today's run monitor does not have: the provider request (by design raw), `history.jsonl`, the `ui.json`
draft, the clipboard payload, and the `--json` stream; plus one that already exists but has no composer rule, the
`JEVCODE_TRACE` keystroke line in `src/tui/App.tsx`. The decision below is: a pre-submit detector that reuses the
same pattern families, `addSecret` on `y`, paste payloads kept in a React ref and stored on disk only as
`[Pasted #n, k lines, sha256]`, the `@` denylist reusing `isSecretBasename()` from `src/sandbox/paths.ts`,
`redact` on every clipboard/OSC 52 byte, and prompt history **on by default but written only through `redact`**
(opt-out `--no-history`), because after `addSecret` the history file can no longer contain what the detector saw,
and pastes never enter it at all.

---

## 1. What exists today (repo facts that constrain the design)

### 1.1 `src/core/redact.ts` (read 2026-09-20)

- Two layers: "exact secret strings known from configuration (replaced with the name of the setting or variable they
  came from), then format patterns for keys we did not configure but recognise. There is deliberately no generic
  long-token rule: 40-hex git SHAs, npm integrity hashes and base64 blobs are ordinary output for a coding agent and
  must survive intact." (`src/core/redact.ts` header comment).
- `export const MIN_SECRET_LENGTH = 8;` — "Values shorter than this are ignored: redacting them would mangle
  ordinary output."
- `export const SECRET_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;` — "Variable names in a loaded .env
  whose values join the SecretSet even when JevCode never reads them." (`src/config/env.ts` only parses; the RE
  lives in `redact.ts` and is applied in `src/config/resolve.ts:296-297`: `for (const d of layers.dotenvs) for
  (const [k, v] of d.vars) if (SECRET_NAME_RE.test(k)) secrets.push({ name: k, value: v });` and the same for the
  config file).
- `FORMAT_PATTERNS` (verbatim):
  `/(?<![A-Za-z0-9])sk-or-v1-[A-Za-z0-9]{20,}/g`, `/(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}/g`,
  `/(?<![A-Za-z0-9])sk-(?:proj-|live_|test_)?[A-Za-z0-9_-]{20,}/g`, `/(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g`,
  `/(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36,}/g`, `/(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{22,}/g`; the
  lookbehind exists because "`disk-usage-report-2026-09-19-final` contains `sk-` + 20 safe chars and a base64 blob
  can contain `AIza` mid-stream" (comment above the array). `HEADER_PATTERN =
  /(authorization:\s*bearer|x-api-key:)\s*(?!\[REDACTED:)\S+/gi` keeps the header name and drops the value.
- `patternRedact(s)` is "safe to use before `resolveConfig()` has run"; `createRedactor(secrets)` adds exact
  entries "Longest first so a key that contains another key as a substring is named correctly", de-duplicates by
  value, and exposes `addSecret(name, value): boolean` ("Returns false when ignored (too short)") and `size`.
- `test/unit/config/redact.test.ts:54-68` pins the boundary policy: `'disk-usage-report-2026-09-19-final.txt'`,
  `'sha512-QUl6YUFJemFAIzaQUl6…'`, `'highs_abcdefghijklmnopqrstuvwxyz0123456789'` must survive, and every
  separator in `['=', ' ', '"', "'", ':', '(', ',', '\t', '\n']` before a key must trigger.

### 1.2 Secret files (`src/sandbox/paths.ts`, `src/workspace/candidates.ts`, read 2026-09-20)

- `const SECRET_BASENAMES = new Set(['.env', '.netrc']); const SECRET_PATTERNS: readonly RegExp[] = [/^\.env\..+$/,
  /\.pem$/i, /\.key$/i, /^id_[a-z0-9_-]+(\.pub)?$/i]; const SECRET_EXCEPTIONS = new Set(['.env.example']);` with
  `isSecretBasename(name)` "Basename rule shared by candidates and the seatbelt read denials" and
  `isSecretPath(ws, p, secretPaths)` which also matches the configured `secretPaths` (every consulted `.env`/config
  path, `src/config/resolve.ts:300`) as a prefix.
- `createCandidateCache` drops a path when `deps.isSecret(rel, canonical)` is true for *either* the relative or the
  canonical path (`src/workspace/candidates.ts:127`; `src/workspace/files.ts:88` builds `isSecret` from both), so a
  workspace symlink to `~/.ssh/id_ed25519` is excluded by its canonical basename. `WALK_SKIP_DIRS` contains
  `.git`, so the readdir walk never lists `.git/**`; the git listing (`git ls-files`-style) never does either.
- Consequence for `@`: the completion source (the candidate list) already excludes `.env`, `.env.*`, `*.pem`,
  `*.key`, `id_*`, `.netrc` and `.git/**` **by construction**; the denylist question is only about a path typed in
  full, and about the names the brief adds (`*credential*`, `.npmrc`).

### 1.3 Where the task string goes today (the composer inherits every one of these sinks)

- `Engine.emit()` runs `redactDeep(e, this.redact)` on every event before `recordTranscript` and the bus
  (`src/loop/engine.ts:577-581`), so `run:start { task }` reaches `transcript.log` as
  `[run] start <id> mode=… task: <clip(oneLine(task), 160)>` (`src/tui/plain.ts:68,222`, `TASK_MAX = 160`) already
  redacted, and `oneLine` runs `sanitizeStream` (drops C0/ESC/C1, `src/tui/plain.ts:80-87`).
- Every checkpoint write passes `redactDeep` (`src/checkpoint/store.ts:69-77,223,266,279,372`) and every
  `transcript.log` line passes `redact(line)` (`store.ts:418`), so `run.json.task`, `state.json`, `steps.jsonl`
  are covered for *known* secrets.
- Jev state is redacted (`src/loop/state.ts:115` `return redactJson(state, input.redact)`); context file contents
  are redacted before the generator sees them (`src/loop/stages/context.ts:109` `content: ctx.redact(view.content)`);
  command output is redacted at the source (`src/loop/stages/execute.ts:79,112,116`). The task text itself is passed
  raw into `StageContext.task` / `PromptInput.task` (`src/loop/engine.ts:737,846,1179`); `src/provider/prompts.ts` contains no `redact` call and renders it verbatim: `sections.push(`# Step ${input.step}\n\n## Task\n${clip(input.task, PROMPT_LIMITS.taskChars)}`)` with `taskChars: 12_000` (`prompts.ts:19,247`, read 2026-09-20), so today the generator receives the **raw** task text, clipped to 12,000 characters — which also bounds how much of a pasted chip the generator can ever see.
- Measured: **0** `you:` lines in 192 local `transcript.log` files (20,045 lines) — the composer sink does not exist
  yet, so nothing below is retrofitting; it is new surface.
- `src/tui/App.tsx:126-129`: when `JEVCODE_TRACE` is set the `useInput` handler appends
  `tui.useInput input=${JSON.stringify(input)} ctrl=${key.ctrl}` to a file. For the run monitor this logs `y`/`n`;
  for a composer it would log **every typed character of a secret**. Research 12 §0/§11 already lists "fix the
  `JEVCODE_TRACE` line" (`docs/research/tui/12-accessibility-robustness-testing.md` §11 (b)).

### 1.4 What the earlier research left unreconciled (why this file exists)

- `00-SUMMARY.md` A60 proposes `~/.jevcode/history.jsonl … passed through `config.redact` before write … opt-out
  `JEVCODE_NO_HISTORY=1` / `--no-history` (opt-in vs opt-out unresolved, see §4 C19)`; C19 records "Open product
  decision … Record in the design with the chosen default and a heuristic secret filter (05 §17 Q8)"; P19 asks for
  the "heuristic secret filter (`sk-…`, `ghp_…`)" as if none existed. `05-other-agent-tuis.md` §17 Q8: "prompts
  typed by the human may contain secrets not in the redactor's seed set; is a heuristic (`sk-…`, `ghp_…`) plus
  `--no-history` enough?" None of them cites `patternRedact`, which is that heuristic.
- `06-tui-conventions.md` §17.2 has the whole `@` policy in one cell: "`@` | File-path completion
  (workspace-scoped, respects secret-file denylist)". `00-SUMMARY.md` gap 11: "entering or rotating provider keys
  from the TUI, and a secret-file denylist for `@` mentions (06 §17.2 mentions one) are not [covered]".
- A86: `/copy [last|proposal|diff] … 64 KiB cap, redacted payload; never OSC 52 read (`?`)` — "redacted" without
  saying by which function or whether the pasted-chip content is included.
- A4: pastes "collapse … into `[Pasted #n, k lines]` kept in memory (never logs) and expanded at submit"; 12 §10
  adds "add the *composer draft* to the checkpoint-adjacent `ui.json` (not `state.json`) so `--resume` can restore
  an unsent prompt; never store keystroke history" — the two together leave the chip content's disk lifecycle
  undefined.
- A61 / 10 §15.10: "`jevcode run --plain --json` = redacted `EngineEvent` NDJSON" — no wording of the guarantee.

---

## 2. External practice (fetched 2026-09-20)

### 2.1 gitleaks default rules (`https://raw.githubusercontent.com/gitleaks/gitleaks/master/config/gitleaks.toml`, fetched 2026-09-20)

The downloaded file has 3,209 lines and **222** `[[rules]]` blocks (`grep -c '^\[\[rules\]\]'`; the WebFetch
summariser reported 389, which the local count contradicts — the local count is authoritative). Rules relevant to
a coding-agent composer, regex verbatim:

| id | regex |
| --- | --- |
| `aws-access-token` | `\b((?:A3T[A-Z0-9]\|AKIA\|ASIA\|ABIA\|ACCA)[A-Z2-7]{16})\b` |
| `github-pat` / `github-oauth` / `github-app-token` / `github-refresh-token` | `ghp_[0-9a-zA-Z]{36}` / `gho_[0-9a-zA-Z]{36}` / `(?:ghu\|ghs)_[0-9a-zA-Z]{36}` / `ghr_[0-9a-zA-Z]{36}` |
| `github-fine-grained-pat` | `github_pat_\w{82}` |
| `anthropic-api-key` / `anthropic-admin-api-key` | `\b(sk-ant-api03-[a-zA-Z0-9_\-]{93}AA)(?:[\x60'"\s;]\|\\[nr]\|$)` / `\b(sk-ant-admin01-[a-zA-Z0-9_\-]{93}AA)…` |
| `openai-api-key` | `\b(sk-(?:proj\|svcacct\|admin)-(?:[A-Za-z0-9_-]{74}\|[A-Za-z0-9_-]{58})T3BlbkFJ(?:[A-Za-z0-9_-]{74}\|[A-Za-z0-9_-]{58})\b\|sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})…` |
| `gcp-api-key` | `\b(AIza[\w-]{35})(?:[\x60'"\s;]\|\\[nr]\|$)` |
| `slack-bot-token` / `slack-user-token` | `xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*` / `xox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34}` |
| `slack-webhook-url` | `(?:https?://)?hooks.slack.com/(?:services\|workflows\|triggers)/[A-Za-z0-9+/]{43,56}` |
| `private-key` | `(?i)-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S-]{64,}?KEY(?: BLOCK)?-----` |
| `jwt` (entropy 3) | `\b(ey[a-zA-Z0-9]{17,}\.ey[a-zA-Z0-9\/\\_-]{17,}\.(?:[a-zA-Z0-9\/\\_-]{10,}={0,2})?)(?:[\x60'"\s;]\|\\[nr]\|$)` |
| `stripe-access-token` | `\b((?:sk\|rk)_(?:test\|live\|prod)_[a-zA-Z0-9]{10,99})…` |
| `npm-access-token` / `huggingface-access-token` | `(?i)\b(npm_[a-z0-9]{36})…` / `\b(hf_(?i:[a-z]{34}))…` |
| `generic-api-key` (entropy 3.5) | `(?i)[\w.-]{0,50}?(?:access\|auth\|(?-i:[Aa]pi\|API)\|credential\|creds\|key\|passw(?:or)?d\|secret\|token)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=\|>\|:{1,3}=\|\|\|\|:\|=>\|\?=\|,)[\x60'"\s=]{0,5}([\w.=-]{10,150}\|[a-z0-9][a-z0-9+/]{11,}={0,3})(?:[\x60'"\s;]\|\\[nr]\|$)` |

There is **no `openrouter` rule** (grep for `openrouter` finds nothing), so JevCode's `sk-or-v1-` family is a
local addition worth keeping. The global `[allowlist]` shows what gitleaks treats as non-secrets: `regexes` such
as `'''(?i)^true|false|null$'''`, `'''^\$(?:[A-Z_]+|[a-z_]+)$'''`, `'''^\{\{[ \t]*[\w ().|]+[ \t]*}}$'''`,
`'''^/Users/(?i)[a-z0-9]+/[\w .-/]+$'''`, and `stopwords = ["014df517-39d1-4453-b7b3-9930c563627c",
"abcdefghijklmnopqrstuvwxyz"]`; `paths` allowlist `node_modules`, lockfiles, `go.sum`, `.git`. Note gitleaks'
Anthropic rule requires the exact `sk-ant-api03-…{93}AA` shape (108 chars) while JevCode's `sk-ant-[A-Za-z0-9_-]{20,}`
is deliberately looser (it also catches the `sk-ant-oat01-` OAuth shape and truncated pastes); keep the looser one
for *redaction* and use the strict shapes only to label the family in the warning.

### 2.2 trufflehog detectors (fetched 2026-09-20)

- `https://api.github.com/repos/trufflesecurity/trufflehog/contents/pkg/detectors?per_page=1000` lists **886**
  directory entries (`grep -c '"type": "dir"'`).
- AWS: `idPat = regexp.MustCompile(`\b((?:AKIA|ABIA|ACCA)[A-Z0-9]{16})\b`)`
  (`https://raw.githubusercontent.com/trufflesecurity/trufflehog/main/pkg/detectors/aws/access_keys/accesskey.go`
  line 78) and `SecretPat = regexp.MustCompile(`(?:[^A-Za-z0-9+/]|\A)([A-Za-z0-9+/]{40})(?:[^A-Za-z0-9+/]|\z)`)`
  (`…/pkg/detectors/aws/common.go` line 16) — the 40-char secret half is indistinguishable from a git SHA-1 and is
  only reported by trufflehog because it *verifies* against AWS; JevCode cannot verify and must not adopt that half.
- GitHub v2: `\b((?:ghp|gho|ghu|ghs|ghr|github_pat)_[a-zA-Z0-9_]{36,255})\b`
  (`…/pkg/detectors/github/v2/github.go`, fetched 2026-09-20).
- Slack: `xoxb\-[0-9]{10,13}\-[0-9]{10,13}[a-zA-Z0-9\-]*`, `xoxp\-…`, `xoxa\-…`, `xoxr\-…` (`…/pkg/detectors/slack/slack.go`).
- Private key: `(?i)-----\s*?BEGIN[ A-Z0-9_-]*?PRIVATE KEY\s*?-----[\s\S]*?----\s*?END[ A-Z0-9_-]*? PRIVATE KEY\s*?-----`
  (`…/pkg/detectors/privatekey/privatekey.go`).
- JWT: `\b((?:eyJ|ewogIC|ewoid)[A-Za-z0-9_-]{12,}={0,2}\.(?:eyJ|ewo)[A-Za-z0-9_-]{12,}={0,2}\.[A-Za-z0-9_-]{12,})\b`
  (`…/pkg/detectors/jwt/jwt.go`).

### 2.3 Claude Code (fetched 2026-09-20)

- `https://code.claude.com/docs/en/env-vars`: "`CLAUDE_CODE_SKIP_PROMPT_HISTORY` | Set to `1` to prevent Claude Code
  from recording your prompts in the local history file at `~/.claude/history`. Useful for sensitive work or demos.
  Even when skipped, prompts are still sent to the model and may be retained by Anthropic per the Privacy Policy".
  So the default is **opt-out** (history on).
- `https://code.claude.com/docs/en/claude-directory`: "`~/.claude/history.jsonl` Every prompt you've typed, with
  timestamp and project path. Used for up-arrow recall, `Ctrl+R` history search, and `!` shell-command completion";
  "`~/.claude/paste-cache/` Contents of large pastes"; cleanup "The default is 30 days and the minimum is 1" via
  `cleanupPeriodDays`, and `paste-cache/` is on the swept list while `history.jsonl` is not; `.credentials.json`
  "stored in plaintext with only OS file permissions as protection" (mode `0600` per
  `https://code.claude.com/docs/en/iam`: "On Linux, credentials are stored in `~/.claude/.credentials.json` with
  file mode `0600`").
- `https://code.claude.com/docs/en/terminal-config` "Paste large content": "When you paste more than 800 characters
  or more than three lines into the prompt, Claude Code collapses the input to a placeholder such as `[Pasted text
  #1 +120 lines]` … Claude Code still sends the full content when you submit." "Claude Code keeps the collapsed
  content under `~/.claude/paste-cache/`, so when you recall a prompt from command history and resubmit it, Claude
  Code sends the full pasted content again". "When you submit such a prompt [cache gone], Claude Code never sends
  the literal `[Pasted text #N]` string … In a shell mode command or a `/` command, where the removal would change
  what runs, and in any prompt the removal leaves empty, Claude Code cancels the submission".
- `https://code.claude.com/docs/en/interactive-mode` "Command history": "Input history is stored per working
  directory"; "Submitting the same prompt twice in a row records one history entry".
- `https://code.claude.com/docs/en/settings`: the canonical example "to … stop it reading `.env` files" is a user
  rule, not a default: `"deny": ["Read(./.env)", "Read(./.env.*)"]`.
- Net: Claude Code persists pasted **content** to disk and relies on a 30-day sweep; nothing in these pages
  describes a heuristic secret filter on history (UNVERIFIED whether one exists in the binary).

### 2.4 Gemini CLI (fetched 2026-09-20)

- `https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/gemini-ignore.md`: "Adding paths to
  your `.geminiignore` file will exclude them from tools that support this feature"; "when you use the `@` command
  to share files, any paths in your `.geminiignore` file will be automatically excluded"; gitignore syntax ("`!`
  negates a pattern"); "To apply the changes, you must restart your Gemini CLI session"; example `apikeys.txt`.
- `https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/reference/configuration.md`:
  "`context.fileFiltering.respectGitIgnore` (boolean) … Default: `true`", "`context.fileFiltering.respectGeminiIgnore`
  … Default: `true`", "`context.fileFiltering.customIgnoreFilePaths` (array): Additional ignore file paths to
  respect. These files take precedence over .geminiignore and .gitignore". No built-in `.env` rule is documented.

### 2.5 Codex CLI (fetched 2026-09-20)

- `https://raw.githubusercontent.com/openai/codex/main/docs/config.md` is a 15-line stub pointing at
  `https://developers.openai.com/codex/config-reference`, which 308-redirects to
  `https://learn.chatgpt.com/docs/config-file/config-reference`. That page: "`shell_environment_policy.ignore_default_excludes`
  Keep variables containing KEY, SECRET, or TOKEN before other filters run (default: true). Set to false to apply
  automatic secret-name exclusions."; "`shell_environment_policy.exclude` Legacy environment-variable exclusion
  patterns. Use shell_environment_policy.filters for new configuration"; "`history.persistence` Control whether
  Codex saves session transcripts to history.jsonl." with values `"save-all" | "none"`; "`history.max_bytes` If
  set, caps the history file size in bytes by dropping oldest entries." The KEY/SECRET/TOKEN name family is the
  same idea as JevCode's `SECRET_NAME_RE`, applied to the *child environment* — JevCode already scrubs the child
  environment entirely (README "Sandbox guarantees", read 2026-09-20).
- `https://raw.githubusercontent.com/openai/codex/main/docs/sandbox.md` is a 3-line stub; no ignore-file option
  appears in the config reference. **UNVERIFIED**: Codex `.git` read-only rule and any `.codexignore` (tried both
  URLs above).

### 2.6 opencode (fetched 2026-09-20)

`https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/permissions.mdx` lines
172-186: "`read` is `"allow"`, but `.env` files are denied by default:" followed by
`"read": { "*": "allow", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow" }`, with rules "evaluated
by pattern match, with the last matching rule winning". This is the same shape as JevCode's
`SECRET_BASENAMES`/`SECRET_EXCEPTIONS` (`.env.example` allowed), but opencode has no `*.pem`/`id_*`/`.netrc`
default and no override UI beyond editing the config.

### 2.7 Ink 7.1.1 paste pipeline (local `node_modules/ink/build`, read 2026-09-20)

- `input-parser.js`: `const pasteStart = '\u001B[200~'; const pasteEnd = '\u001B[201~';` … `events.push({ paste:
  input.slice(afterStart, endIndex) });` — a bracketed paste is one event holding the whole payload; "Other control
  characters like `\r` and `\t` are NOT split because they can legitimately appear inside pasted text."
- `components/App.js:188-192`: `if (internal_eventEmitter.current.listenerCount('paste') === 0) {
  emitInput(event.paste); } … internal_eventEmitter.current.emit('paste', event.paste);` — with **no** `usePaste`
  listener the payload is delivered to `useInput` as one chunk (this is why A4's "multi-char chunk = paste" works
  when bracketed paste is absent). `hooks/use-paste.js`: "Bracketed paste mode (`\x1b[?2004h`) is automatically
  enabled while the hook is active"; `usePaste` and `useInput` "operate on separate event channels".
- `ink.d.ts`: `export type RenderMetrics = { renderTime: number; }` via `render({ onRender })` — used for §3.3.

---

## 3. Measurements (2026-09-20, Apple Silicon, Node v22.23.2; scripts `/tmp/jev-secrets/{bench-redact,fp,render}.mts`)

### 3.1 Redaction cost on composer-sized inputs

Corpus per size: interleaved TS source, lockfile `integrity` lines, `git log` lines with 40-hex SHAs, and a base64
blob containing `AIza` mid-stream (the §1.1 survivors). Medians over 30 runs after 5 warm-ups; p95 in parentheses.

| operation | 64 KB | 256 KB |
| --- | --- | --- |
| `patternRedact`, no secret | 0.082 ms (0.084) | 0.334 ms (0.345) |
| `patternRedact`, 1 `sk-ant-` key embedded | 0.082 ms (2.317) | 0.377 ms (6.544) |
| `createRedactor([1 exact]).redact` | 0.082 ms (2.628) | 0.369 ms (6.313) |
| `redact` with 51 exact entries (50 added via `addSecret`) | 0.358 ms (0.590) | 1.645 ms (84.3, single GC outlier) |
| `patternRedact` + 8 extra families (§4.1) | 0.162 ms (7.240) | 0.632 ms (24.6) |
| `patternRedact` on `"sk-x "` repeated (prefix-heavy adversarial) | 0.169 ms (0.254) | 0.656 ms (11.9) |
| `sha256` (for the chip) | 0.030 ms | 0.114 ms |
| `patternRedact` on a 2 KB typed prompt (per-keystroke budget) | 0.003 ms (0.006) | — |
| detect-only (`.test()` of the 6 current families) on 2 KB | < 0.001 ms | — |

Reading: a 256 KB paste costs a third of a millisecond to scan, i.e. below one Ink frame at 20 fps (50 ms) by two
orders of magnitude; the pre-submit check can run on **every** buffer change, not only at Enter, and the p95 spikes
are GC, not regex backtracking (the adversarial prefix-heavy input stays under 1 ms median). Fifty `addSecret`
calls make `redact` ~5× slower on large strings (each exact entry is an `includes` + `split/join`); a session that
adds hundreds of composer secrets should cap the composer-added set (proposal: 64 entries, oldest evicted, §4.2).

### 3.2 False-positive rate over real local text

| corpus | size | hits: 6 current families | header rule | 8 extra families (AKIA, xox, webhook, PEM, JWT×2, stripe, npm_/hf_) | gitleaks `generic-api-key` (entropy ≥ 3.5 applied) |
| --- | --- | --- | --- | --- | --- |
| `~/.jevcode/runs/*/transcript.log`, 199 runs | 20,045 lines, 2.4 MB | 0 | 0 | 0 | 0 |
| unique task texts from those runs (human/bench-authored prompts) | 86 | 0 | 0 | 0 | 0 |
| `steps.jsonl` sample (generator messages, plans, command output) | 42.4 MB | 0 | 0 | 0 | 0 |
| repo `docs/**/*.md` + `src` + `test` (prose + code) | 370 files, 5.1 MB | 45 (all deliberate fixtures in `test/`, e.g. `'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123'`) | 9 — **all false positives** in docs prose, e.g. ``Authorization: Bearer`, `Content-`` where `\S+` captured `` `Content- `` (`patternRedact` changed 602 bytes of docs) | 0 | 47 (≈ 9 per MB of prose, e.g. `metadata = {"n_episodes", "api_request_times_msec"`) |

Reading: the current six format families plus the eight gitleaks/trufflehog families produce **zero** hits on
~50 MB of real agent text, so they are safe as a *blocking* pre-submit warning. The header rule is fine as a
redactor (over-redacting a doc excerpt is harmless) but must **not** drive the warning row (it fires on prose that
quotes header names). `generic-api-key` is unusable for either purpose (~9 FP/MB) — gitleaks only ships it with a
389-word stopword list and file-path allowlists; a composer has neither.

### 3.3 Render cost of the pre-submit warning row

Ink `render()` into a fake 120×40 TTY stream, `onRender` `renderTime` over 202 frames of a composer (rule row, 3-row
input, status row) with a 2 KB prompt containing an `sk-or-v1-` key:

| variant | `renderTime` median | p95 | bytes/frame |
| --- | --- | --- | --- |
| composer without warning row | 0.563 ms | 0.888 ms | 152 |
| composer with the row `Looks like this contains a secret (sk-…). Send anyway? y/N` | 0.617 ms | 0.798 ms | 170 |
| row toggled on/off every frame | 0.422 ms | 0.560 ms | wall 1.003 ms/frame |

Reading: ≈ +0.05 ms and +18 bytes per frame; a one-row `<Box height={1} overflow="hidden">` fits the §10 height
budget (take the row from the decisions pane, which "shrinks first", `src/tui/App.tsx computeLayout`). Not a pty
measurement (fake stream) — `perf/render-lag.ts` remains the gate.

---

## 4. Decision and specification

### 4.1 Pre-submit check (`detectSecrets`, new export in `src/core/redact.ts`)

- API: `export interface SecretHit { family: string; start: number; end: number; }` and
  `export function detectSecrets(s: string, exact?: Redactor): readonly SecretHit[]`. Families = the six
  `FORMAT_PATTERNS` plus `WARN_ONLY_PATTERNS` (not used for redaction, only for the warning, all measured at 0 FP in
  §3.2): AWS `/\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/`, Slack
  `/(?<![A-Za-z0-9])xox[abpers]-[0-9]{8,13}-[A-Za-z0-9-]{10,}/`, Slack webhook
  `/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{43,56}/`, PEM header
  `/-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/`, JWT
  `/\bey[a-zA-Z0-9]{17,}\.ey[a-zA-Z0-9/_-]{17,}\.[a-zA-Z0-9/_-]{10,}={0,2}/`, Stripe
  `/(?<![A-Za-z0-9])(?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99}\b/`, npm `/(?<![A-Za-z0-9])npm_[a-zA-Z0-9]{36}\b/`,
  Hugging Face `/(?<![A-Za-z0-9])hf_[A-Za-z]{34}\b/`. The `HEADER_PATTERN` is **excluded** from detection (§3.2).
  `exact` present ⇒ also `exact.redact(s) !== s` ⇒ a hit labelled with the entry name (e.g. `OPENROUTER_API_KEY`),
  so pasting your own configured key is caught even when its format is unknown.
- Family label = the literal prefix that matched, truncated to the family's fixed prefix plus `…` and never more
  than 6 characters of the secret: `sk-…`, `sk-ant-…`, `AIza…`, `ghp_…`, `github_pat_…`, `AKIA…`, `xoxb-…`,
  `-----BEGIN…`, `eyJ…`, `npm_…`. For an exact hit: `your OPENROUTER_API_KEY`.
- Copy (one row, `<Text color="yellow" wrap="truncate">`): `Looks like this contains a secret (sk-…). Send anyway? y/N`;
  plural `Looks like this contains 3 secrets (sk-…, ghp_…, AKIA…). Send anyway? y/N`; exact
  `Looks like this contains your OPENROUTER_API_KEY. Send anyway? y/N`.
- Key contract (in the composer's `useInput`, gated by `mode === 'confirm-secret'`): `input === 'y' || input ===
  'Y'` sends; `key.return`, `key.escape`, `n`, `N` and **any other key** dismiss the row, keep the draft and hand
  the key to the composer normally (so a reflexive Enter cannot send, and a typist who keeps typing is not
  confirming); Ctrl-C keeps the existing `onAbort('human_abort')` semantics. No timeout, no default-yes, never
  remembered ("always" is refused for the same reason 11 §4j refuses remembered approvals).
- When it runs: `detectSecrets` on every buffer change (0.003 ms at 2 KB, §3.1) to drive a dim in-composer marker
  (`⚠ secret?` at the end of the status row), and again at Enter to gate. The expanded paste chips are included in
  the scanned text (a paste is the most common way a key arrives). A `!` shell line or `/` command goes through the
  same gate (Claude Code cancels rather than mutates, §2.3; JevCode never mutates the text either).
- Plain/`--plain` mode: the same check prints `jevcode: looks like this contains a secret (sk-…); type y to send, anything else to cancel:`
  via the readline confirmer (`tui/plain.ts createReadlineConfirmer`); on a non-TTY stdin the submission is
  **cancelled** (exit-code path `2` usage) — scripts must not be able to leak a key by accident.

### 4.2 On `y`: `addSecret` so every downstream artefact masks it

- Before the text leaves the composer: for each hit whose span is ≥ `MIN_SECRET_LENGTH` (8),
  `config.redact.addSecret(`composer#${n}`, span)`; markers then read `[REDACTED:composer#1]`. For a PEM hit the
  span is the whole `-----BEGIN…-----END … PRIVATE KEY-----` block (use the trufflehog end-anchored form for the span
  extraction, §2.2), so the base64 body is masked too, not just the header.
- Because the engine redacts at `emit` (§1.3) and the checkpoint store redacts every write, the same `y` covers
  `transcript.log` (`[turn n] you: … [REDACTED:composer#1] …`), `steps.jsonl` (the four-step window carries the
  prompt), `run.json.task`, `state.json`, Jev state (`state.ts:115`), the `--json` stream, the `<Static>` row and
  `--plain` line (all three render `itemsFromEvent` of the already-redacted event), the Ink live region
  (`appendTail` → `sanitizeStream`; the delta text itself comes from the generator, whose echo of the key is now
  masked), provider/Jev **error bodies** (`anthropic.ts:125`, `client.ts:224`), and `history.jsonl` (§4.6).
- The provider **request** is the one sink that intentionally carries the raw text — that is what "send" means.
  Today `PromptInput.task` is not redacted (§1.3), so the composer text is delivered raw by the existing path; do
  not route it through `redact` before the request, or `y` would silently send `[REDACTED:composer#1]` to Claude.
  Record the choice as a transcript item `secret-ack` (`[turn n] sent 1 secret (sk-…) to the generator on request`)
  so the audit trail says the human chose it. Note context *files* and command output are redacted before the
  generator sees them (`context.ts:109`, `execute.ts:116`), so a key that entered via `y` reappears to the generator
  only in the human turn itself.
- Cap: `composer#` entries are bounded at 64 per process (oldest evicted, `Redactor` gains `dropSecret(name)`), given
  the 5× slowdown at 51 entries on 256 KB strings (§3.1); a normal session adds 0-2.
- On `N`/dismiss: nothing is added; a hint line under the composer for one frame: `Tip: put it in .env and refer to
  it by name; JevCode never reads .env into a prompt` (the README "Configuration" flow, read 2026-09-20).

### 4.3 Paste placeholder lifecycle (`[Pasted #n, k lines]`)

- Content lives in a `useRef<Map<number, PasteBlob>>()` inside the composer (`PasteBlob = { text: string; lines:
  number; bytes: number; sha256: string }`), never in React state, never in the reducer, never in an `EngineEvent`.
  It is expanded into the submission string at Enter, after `sanitizeStream` (`plain.ts:80`) and the §4.1 gate.
- Thresholds as A4: collapse when > 3 lines or > 800 chars (Claude Code's numbers, §2.3; Ink delivers the payload
  as one event, §2.7). Hard cap 1 MiB per paste (parity with `MAX_CANDIDATE_BYTES`, `candidates.ts:15`): larger
  pastes are refused with a toast `paste of 3.2 MB refused (limit 1 MiB); write it to a file and @-mention it`.
- `ui.json` (checkpoint-adjacent, 12 §10) stores the draft as `{ text, cursor, chips: [{ n, lines, bytes, sha256 }] }`
  where `text` has already passed `config.redact` **and** `detectSecrets` spans replaced by `[REDACTED:draft]`, so an
  unsent secret never reaches disk even before `y`. Chip **content is never written** — no `paste-cache/`
  equivalent. `ui.json` is written at checkpoint boundaries and at shutdown (§11 sequence), never per keystroke, so it
  is not a keystroke log by construction.
- On `--resume` the chips render as `[Pasted #1, 120 lines — not restored]`; submitting a draft that still holds an
  unrestored chip is **cancelled** with `remove [Pasted #1] or paste again` (Claude Code's rule for `!`/`/`
  commands generalised: JevCode never sends the literal chip and never silently drops it).
- History (§4.6) stores the chip *label* only: `[Pasted #1, 120 lines, sha256:9f86d081]` — the hash lets a user
  recognise "that log I pasted" without the bytes existing anywhere.

### 4.4 `@`-mention denylist and its override

- Single rule: `isSecretPath()` in `src/sandbox/paths.ts` (§1.2), extended with `/credential/i` on the basename
  (matches `credentials`, `.git-credentials`, `aws_credentials.json`), `.npmrc`, `.pypirc`, and `/\.(p12|pfx|jks)$/i`;
  plus an `@`-only rule `rel.startsWith('.git/')` (reads of `.git/**` are allowed to the harness — only writes are
  denied, `paths.ts` `mode === 'write'` branch — but `.git/config` can hold `https://user:token@host` remotes and
  must not be attachable). Resulting `@` denylist: `.env`, `.env.*` (except `.env.example`), `*.pem`, `*.key`,
  `id_*` (incl. `.pub`), `.netrc`, `*credential*`, `.npmrc`, `.pypirc`, `*.p12|pfx|jks`, `.git/**`, and every
  configured `secretPaths` prefix.
- Completion never offers a denied path (the candidate list already excludes them, §1.2). A path typed in full
  shows one row: `.env is on the secret denylist; JevCode never reads it. Start with --allow-secret-mention to
  override.` and the mention is dropped from the submission (the text `@.env` stays as literal words).
- Override: `--allow-secret-mention` (run flag; `JEVCODE_ALLOW_SECRET_MENTION=1`), default off. With it, an explicit
  `@.env` shows the §4.1-style row `.env is a secret file (124 bytes). Attach anyway? y/N`; on `y` the file is read
  through a dedicated `workspace.readSecretForMention(rel)` that bypasses `assertNotSecret` **only for this call**
  (the generator's `read` action keeps `SecretPathError`), every `KEY=value` line whose key matches
  `SECRET_NAME_RE` is `addSecret`'ed as `mention:<KEY>` before the text leaves the composer, and PEM bodies are added
  whole. Rationale for shipping an override at all: a user asking "why does my `.env.production` fail to parse"
  has a legitimate need, and the seatbelt profile already denies the harness's own `.env` paths to *commands*
  (README "Sandbox guarantees"), so this is a human-only, per-mention, flag-gated path.
- `.gitignore`/`.jevcodeignore`: not adopted for v1 — Gemini needs a restart to reload `.geminiignore` (§2.4) and
  JevCode's candidate cache already honours the git listing (`gitList`, `candidates.ts:36`), so ignored files are
  not offered; a `.jevcodeignore` is an OPEN QUESTION.

### 4.5 `/copy` and OSC 52 payloads

- Payload pipeline: `text = config.redact(sanitizeStream(source))` → cap 64 KiB (A86) → native tool (`pbcopy`,
  `wl-copy`, `xclip -selection clipboard`, `xsel --clipboard --input`) → OSC 52 only with `--osc52`/`ui.osc52`,
  `\x1b]52;c;<base64>\x07`, tmux `\x1bPtmux;\x1b<seq>\x1b\\` with doubled ESC (07 §2.5, 12 §9, read 2026-09-20).
  Never `\x1b]52;c;?\x07` (read).
- Sources `/copy last|proposal|diff` are transcript items, which are already redacted at `emit`; running `redact`
  again is idempotent (`redact.test.ts:95` "is idempotent and stable") and costs 0.08 ms per 64 KB (§3.1). `/copy
  draft` (the unsent composer text) is the case that needs it: the draft is not an event and may hold a not-yet-acked
  secret, so the clipboard gets the redacted form and the row `copied with 1 secret masked` says so.
- Chip content is included in `/copy draft` only in its redacted, sanitised form; the user can always re-paste from
  the source application.

### 4.6 Prompt history: on by default, written only through `redact` (opt-out)

- File: `~/.jevcode/history.jsonl`, one line per submission `{ t, workspace, kind: 'prompt' | 'steer' | 'command',
  text }`; `text = config.redact(expandChipsAsLabels(sanitizeStream(draft)))` written **after** §4.2 `addSecret`, so
  anything the detector flagged is a marker in the file; pastes are labels (§4.3); entries > 4 KiB truncated with
  `…`; consecutive duplicates dropped (Claude Code, §2.3); 1,000-entry cap with an atomic rewrite when exceeded
  (opencode rewrites `prompt-history.jsonl` on load, `01-opencode.md` §1 line 103-104, read 2026-09-20); torn last
  line tolerated like `steps.jsonl`. Not written when `source !== 'cli'` (bench/perf), like the sessions index (10
  §15.5). Reads filter by `workspace`; `Ctrl-A` widens (10 §15.6).
- Opt-out: `--no-history` / `JEVCODE_NO_HISTORY=1` (A60) skips writes; `/history clear` truncates the file; reads
  still work when writing is off. Justification for opt-out rather than 12 §11's opt-in:
  1. Every surveyed tool defaults to on: Claude Code (`CLAUDE_CODE_SKIP_PROMPT_HISTORY` exists to turn it *off*,
     §2.3), opencode (50-entry JSONL, `01` §1), Codex (`history.persistence` `save-all|none`, §2.5), Gemini (shell
     history file `MAX_HISTORY_LENGTH = 100`, `03` §14 lines 293-294). Users expect Up-arrow recall across sessions.
  2. "Keys never appear in logs" (README) is a statement about *what is written*, not about *whether a file exists*.
     The history line is produced by the same `redact` that produces `transcript.log`, after the same `addSecret`,
     and unlike Claude Code it never stores paste bodies. An opt-in default would not protect the user who does not
     know the flag — exactly the user who pastes a key — while costing everyone else recall.
  3. The residual case (a secret of unknown format, typed inline, that the user neither flagged nor configured) is
     the same residual `transcript.log` has today; history adds no new class of leak.
- `/steer` messages are historised in the same file (`kind: 'steer'`) so `Ctrl-R` finds them; slash commands are
  historised as typed (`kind: 'command'`) — no command takes a secret argument today, and any future key-entry
  command must use a masked field that is excluded (OPEN QUESTION 4).

### 4.7 `--json` redaction guarantee (wording for `docs/DESIGN.md` §10 and `--help`)

> Every string in the `--json` stream is the `EngineEvent` after `config.redact`: exact values of configured
> secrets (flags, environment, every loaded `.env`, the config file), values the human confirmed with `Send anyway`,
> and the recognised key formats (`sk-or-v1-`, `sk-ant-`, `sk-`, `AIza`, `gh?_`, `github_pat_`, header values) are
> replaced by `[REDACTED:<name>]` or `[REDACTED:pattern]`. The stream never contains keystrokes, composer drafts,
> or pasted payloads; a human turn appears as one `user` event holding the redacted submitted text. Redaction is
> exact for configured and confirmed values and pattern-based for everything else; a secret of an unrecognised
> format that the human typed inline and that no detector flagged is passed through, as it is in `transcript.log`.

Also update README "Keys never appear in logs, results, checkpoints or subprocess environments" to append "or in
prompt history, clipboard payloads and the `--json` stream; a human turn is redacted after the `Send anyway`
confirmation".

### 4.8 `JEVCODE_TRACE` must stop logging bytes

Replace `input=${JSON.stringify(input)}` (`src/tui/App.tsx:127`) with a key *class*: `ctrl-c`, `y`, `n`, `enter`,
`esc`, `printable(len=1)`, `paste(len=N)`; the composer's own trace never logs its buffer. Test: drive a fixture
run with the canary typed and assert the trace file has zero canary bytes.

### 4.9 Tests asserting zero secret bytes in every artefact

- `test/unit/tui/composer-secrets.test.ts` (ink-testing-library): type a canary `sk-ant-CANARYxxxxxxxxxxxxxxxxxxxxx`,
  assert the row text `Looks like this contains a secret (sk-ant-…). Send anyway? y/N`; press Enter → draft intact,
  nothing submitted; press `n` → dismissed; press `y` → submitted once and `redact.size` grew by 1.
- `test/unit/loop/secret-artefacts.test.ts`: `createEngine` with `MockProvider`/`MockJev` and a `task` holding the
  canary plus a PEM block after a simulated `y`; after `run()` read `transcript.log`, `steps.jsonl`, `run.json`,
  `state.json`, `state.prev.json`, `decisions.jsonl`, `jev.jsonl`, `generator.jsonl`, `history.jsonl`, `ui.json`,
  the `--plain` stdout, the `--json` stdout, and every Ink frame (`lastFrame()` history), and assert
  `Buffer.indexOf(canary) === -1` and `indexOf(pemBase64Body) === -1` in each; assert the mocked provider *did*
  receive the raw canary (the one intended sink); assert Jev's recorded `state` did not.
- `test/unit/core/detect-secrets.test.ts`: each family in isolation; `HEADER_PATTERN` produces no hit; the §1.1
  survivors (`disk-usage-report…`, `sha512-…`, `highs_…`, 40-hex SHA, a JSON with `"api_request_times_msec"`)
  produce no hit; a 256 KB fixture scans in < 5 ms (guard against catastrophic backtracking, §3.1).
- `test/unit/tui/paste-chip.test.ts`: `ui.json` after a 120-line paste contains the chip object and **not** the
  content; resume with the blob missing → submission cancelled with the exact message.
- `test/unit/workspace/mention-denylist.test.ts`: every name in §4.4 is denied; `.env.example` is allowed; `.git/config`
  denied for `@` but readable by the harness; with `--allow-secret-mention` the `y` path adds `mention:<KEY>`
  entries for `KEY=`, `TOKEN=`, `SECRET=` lines and not for `NODE_ENV=`.
- `test/unit/tui/copy.test.ts`: a clipboard stub receives `config.redact(sanitizeStream(x))`, capped at 64 KiB; the
  OSC 52 writer is not invoked without `--osc52`; the sequence never contains `;?`.
- pty (`perf/`-style, `script -q /dev/null`): after a bracketed paste of 20 KB containing a `ghp_` token, the pty
  transcript (what the terminal showed) contains the chip label and never the token (the composer echoes the chip,
  not the payload); `\x1b[2J` count stays 0 with the warning row shown at rows 12 and 40.

---

## ADOPT

| # | What JevCode should do | Why | Source |
| --- | --- | --- | --- |
| A1 | `detectSecrets()` beside `patternRedact()` in `src/core/redact.ts`: the six `FORMAT_PATTERNS` + AWS `AKIA…`, Slack `xox…`/webhook, PEM `-----BEGIN…PRIVATE KEY-----`, JWT `eyJ….eyJ…`, Stripe `sk_live_`, `npm_`, `hf_`; header rule excluded; exact-set membership included | 0 false positives on 50 MB of real agent text; header rule mis-fires on prose | §3.2; gitleaks.toml and trufflehog files (fetched 2026-09-20) |
| A2 | Pre-submit row `Looks like this contains a secret (sk-…). Send anyway? y/N`; only `y`/`Y` sends; Enter/Esc/`n`/any key keeps the draft; never remembered; non-TTY cancels | Cheapest possible gate (+0.05 ms/frame, 1 row) and no default-yes | §3.3; 06 §12 safe defaults; 11 §4j |
| A3 | On `y`, `addSecret('composer#n', span)` before submit (PEM: whole block); cap 64 composer entries | Engine `emit` and the store already redact every sink, so one call masks transcript, checkpoints, Jev state, `--json`, errors, history | `src/loop/engine.ts:577`, `src/checkpoint/store.ts:69-77`, `src/loop/state.ts:115` (read 2026-09-20) |
| A4 | Keep sending the human turn raw to the provider (do not redact `PromptInput.task`); log a `secret-ack` transcript item | "Send anyway" must mean send; the audit line records the human's choice | §1.3; §4.2 |
| A5 | Paste payloads in a `useRef` map; `ui.json` stores `[Pasted #n, k lines, sha256]` only; text in `ui.json` pre-redacted with `[REDACTED:draft]`; 1 MiB paste cap; unrestored chip ⇒ cancel submission | Claude Code's `paste-cache/` keeps bodies on disk for 30 days; JevCode keeps none | terminal-config, claude-directory (fetched 2026-09-20); `candidates.ts:15` |
| A6 | `@` denylist = `isSecretPath()` + `*credential*`, `.npmrc`, `.pypirc`, `*.p12/pfx/jks`, `.git/**`; completion never lists them; `--allow-secret-mention` + per-mention `y/N` + `addSecret` of `SECRET_NAME_RE` lines | One rule shared with the seatbelt and the candidate list; opencode denies `*.env`/`*.env.*` by default | `src/sandbox/paths.ts:107-133`; opencode permissions.mdx 172-186 (fetched 2026-09-20) |
| A7 | `/copy` payload = `config.redact(sanitizeStream(x))`, 64 KiB cap, native tool first, OSC 52 write only with `--osc52`, tmux DCS wrap, never `?` | Idempotent redaction is free (0.08 ms/64 KB); the draft is the only unredacted source | §3.1; 12 §9; 07 §2.5 |
| A8 | History **on by default**, `~/.jevcode/history.jsonl`, written only through `redact` after `addSecret`, chips as labels, 4 KiB/entry, 1,000 entries, per-workspace filter, `--no-history`/`JEVCODE_NO_HISTORY=1`, `/history clear`, not for bench/perf | All four surveyed tools default on; the file cannot contain what the detector saw; pastes never enter it | env-vars, interactive-mode (fetched 2026-09-20); 01 §1; learn.chatgpt.com config reference (fetched 2026-09-20) |
| A9 | `--json` guarantee wording of §4.7 in DESIGN §10 and `--help`; README sentence extended | Scripts consuming the stream need a stated contract, including the honest residual | A61; 10 §15.10 |
| A10 | `JEVCODE_TRACE` logs key classes, never `input` bytes | A composer turns the trace into a keystroke log | `src/tui/App.tsx:127`; 12 §0 |
| A11 | The §4.9 test set, including the artefact sweep for canary + PEM body across 13 sinks and the pty echo check | "zero secret bytes in every artefact" must be asserted, not asserted-by-design | §4.9 |
| A12 | Run `detectSecrets` on every buffer change for a dim `⚠ secret?` marker, gate at Enter | 0.003 ms per 2 KB; the marker warns before the user reaches Enter | §3.1 |

## REJECT

| What not to do | Why |
| --- | --- |
| gitleaks `generic-api-key` (keyword + entropy) in the composer or the redactor | 47 hits / 5.1 MB of prose (≈ 9 FP/MB) even with entropy ≥ 3.5; gitleaks only ships it with a 389-word stopword list and path allowlists (§2.1, §3.2) |
| trufflehog's AWS `SecretPat` `[A-Za-z0-9+/]{40}` or any generic 40-hex / base64 rule | Indistinguishable from git SHA-1s and integrity hashes; trufflehog only reports it after live verification (§2.2); §1.1 policy |
| Driving the warning from `HEADER_PATTERN` | Fires on docs prose that quotes `Authorization: Bearer` (9/9 FP, §3.2) |
| Enter as "yes", a default-yes, a timeout, or "always send" | Violates the brief and 11 §4j's no-remembered-approval rule; Enter is the key the user just pressed |
| Redacting the human turn before the provider request | Would make `y` silently send `[REDACTED:composer#1]` to the generator (§4.2) |
| A `paste-cache/` on disk (Claude Code model) or storing chip bodies in `ui.json`/history | Bodies on disk for 30 days is precisely the leak class; a sha256 label gives the recall cue without the bytes (§2.3, §4.3) |
| Writing `ui.json` per keystroke | Turns the draft checkpoint into a keystroke log; write at checkpoint boundaries and shutdown only (12 §10) |
| Opt-in history (12 §11's reading) | Protects only users who know the flag; the redaction argument is satisfied by construction (§4.6) |
| `.jevcodeignore` / gitignore-style denylist for v1 | Gemini shows the cost (restart to reload); the candidate cache already follows the git listing; the basename rule is one function (§4.4) |
| OSC 52 read (`\x1b]52;c;?`) or automatic OSC 52 write | Read prompts or is denied; write is a clipboard-injection vector if ever fed untrusted text (12 §9, 07 §2.5) |
| Attaching secret files silently under the override | Every mention still asks `y/N`; only the read-path bypass is flag-gated (§4.4) |
| Sending on non-TTY stdin when a hit is present | A script that pipes a key must fail loudly rather than leak (§4.1) |

## OPEN QUESTIONS

1. **Exactness of the `sk-` family.** JevCode's `sk-…{20,}` catches OpenAI, Anthropic, OpenRouter, Stripe and any
   future `sk-` vendor but also a hypothetical `sk-` identifier a project uses (none seen in 50 MB); should the
   warning label distinguish `sk-proj-…` (OpenAI, gitleaks `T3BlbkFJ` marker) from generic `sk-…`?
2. **`addSecret` scope across resume.** Composer-added entries live in the process; after `--resume` the new
   process's redactor no longer knows them, so a later `exec:output` echoing the key would not be masked. Persist
   `composer#` *fingerprints* (sha256 prefix, as `run.json` does for configured keys) — cannot rebuild the value; or
   persist the values encrypted? Or accept and document.
3. **Should `y` also offer `w` = "write it to `.env` as `<NAME>=…` and send the name instead"?** It matches the tip in
   §4.2 and keeps the key out of the provider entirely, but writing `.env` from the TUI is a new write sink.
4. **Key entry/rotation from the TUI** (`00-SUMMARY.md` gap 11): if a `/login`-style command ever exists, its input
   must be a masked field, excluded from history and trace, and go straight to `addSecret`; not designed here.
5. **Chip hash on resume**: is showing `sha256:9f86d081` in history useful to humans, or noise? Alternative: first
   line of the paste, redacted and clipped to 40 chars.
6. **Codex `.git`/ignore behaviour** remains UNVERIFIED (both docs URLs are stubs); irrelevant to the decision but
   the comparison table in 00-SUMMARY should say "not documented" rather than guess.
7. **False positives on real user prompts**: the local corpus has 86 prompts, all bench-authored; a week of real
   composer use should be re-scanned (the `fp.mts` script under `/tmp/jev-secrets` reads `history.jsonl` once it
   exists) before the extra families are promoted from warn-only to redacting.
8. **`--json` consumers and `secret-ack`**: should the ack event carry the family labels (`sk-…`) or nothing beyond
   the count? Labels are ≤ 6 chars of prefix, never the value, but a strict reading of "never contains keystrokes"
   argues for the count only.
9. **Paste cap vs prompt clip.** The generator prompt clips the human turn at `PROMPT_LIMITS.taskChars = 12_000` characters (`src/provider/prompts.ts:19,247`), while §4.3 allows a 1 MiB paste; a long paste is therefore silently truncated for the generator (Jev state has its own bounds, `state.ts`). Either lower the paste cap to match, or make the composer say `only the first 12,000 characters reach the generator; @-mention a file for more` when a submission exceeds it.
