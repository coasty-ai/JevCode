# 13 — First-run onboarding without keys: in-TUI key entry, provider/auth setup, workspace trust

Research note for the JevCode interactive TUI (chat-style composer on top of the existing engine). Written
2026-09-20. Every external claim carries its URL and the fetch date; `src/...` line references are to the working
tree as read on 2026-09-20. Measurements were made with scratch files under `/tmp/jevonboard/` (listed in §4.0);
nothing in the repo was modified.

Constraints honoured throughout: Node 22.23.2, TypeScript strict / no `any`, ESM, one npm package, runtime deps
`ink` 7.1.1 + `react` 19.3.0 only, esbuild single bundle, first frame < 300 ms with zero network, rendering never
blocks the loop, zero terminal clears after the first frame (rows − 2 budget), keys never in logs, no `useFocus`.

---

## 0. Ten findings that decide the design

1. **The gap is real and lands after the first frame.** `resolveConfig()` validates lazily: `config.generator()` /
   `config.decider()` throw `ConfigError` (`src/config/validate.ts:96-140`) the first time `cli/main.tsx` calls them
   (`buildProvider` → `config.generator()`, `buildDecider` → `config.decider()`, `main.tsx:53-79, 157-158`), i.e. after
   `render(<App/>)` has committed. The error then unmounts the renderer and prints
   `jevcode: generator.apiKey: the anthropic API key is not set (consulted: --api-key (flag), ANTHROPIC_API_KEY / JEVCODE_API_KEY (env), …)`
   with exit 2 (`fatalExit`, `main.tsx:288-293`). Once bare `jevcode` opens a composer (research 10 §15.4), a
   keyless user types a task first and fails second.
2. **Two keys, one fallback.** `decider.apiKey` reads `['JEV_API_KEY', 'OPENROUTER_API_KEY']` (`src/config/defaults.ts:58`);
   the generator key reads the provider-specific name first (`PROVIDER_KEY_ENV`, `resolve.ts:32`, prepended at
   `resolve.ts:243-244`) then `JEVCODE_API_KEY`. So **one `OPENROUTER_API_KEY` satisfies both** when the provider is
   `openrouter`; with `anthropic` the user needs two keys. `--mode jev-only` never validates the generator
   (`main.tsx:162`). The wizard has to know all three shapes.
3. **The safe persistence target already exists and is already sandbox-protected.** `~/.config/jevcode/config.json`
   is the second default config location (`resolve.ts:208`), accepts `apiKey` / `jevApiKey` (or any env name) as keys
   (`defaults.ts:51,58`; `fileKeyToSetting`, `resolve.ts:78-86`), and its path is pushed onto `consultedPaths`
   *before* the existence check (`resolve.ts:208-214`), so it is in `secretPaths` (`resolve.ts:300`) and the seatbelt
   profile denies reads of it to sandboxed commands even on the run that creates it. Codex, Claude Code (Linux
   fallback) and opencode all write their credential file with mode `0600` (§2.1, §2.2, §2.4). No reference tool writes
   a key into the project directory.
4. **Ink 7.1.1 gives a masked field everything it needs without a text-input dependency:** `usePaste` delivers a
   bracketed paste as one string on a channel `useInput` never sees (`node_modules/ink/build/hooks/use-paste.js:1-8`),
   the parser holds an unfinished paste without a flush timer (`input-parser.js:148-157, 174-180`), `useCursor`
   places the real cursor for IME (`hooks/use-cursor.js`), and `<Text>` bullets render the mask. Measured: a 108-char
   bracketed paste arrives as exactly one `usePaste` event, zero key bytes reach the pty output, no placeholder, no
   `<Static>` item (§4.1 A/B/E).
5. **Today's `JEVCODE_TRACE` line would leak a typed or pasted key.** `App.tsx:126` writes
   `tui.useInput input=${JSON.stringify(input)}` per event. Measured with a probe that copies that line: a
   non-bracketed paste puts the whole 108-char key in the trace in one line; typing puts it there as 108 consecutive
   one-character lines that reconstruct the key (§4.1 C/D). The wizard must log kind/length only, and `App.tsx`
   should do so unconditionally.
6. **The wizard does not touch the first frame.** The first frame is still header + status from argv; the wizard
   pane appears only after `resolveConfig()` (post first frame, per the DESIGN §12 ordering contract). Even when the
   wizard *is* the first dynamic pane (scratch bundle), cold first frame is 107 ms median / 119 ms p95 at 40×120,
   versus 121 / 134 ms for `bin/jevcode.js run … --perf-exit-after-first-frame` on the same machine and method (§4.2).
7. **Enter → saved is sub-3 ms end to end:** file written 0.6 ms after Enter, 'saved' frame rendered 2.0 ms after
   (child clock), 2.4–2.9 ms Enter-write → 'saved' bytes on the pty (driver clock); `stat` mode `600` on the file and
   `700` on the directory in all five scenarios (§4.1).
8. **Reference UIs are not a model for masking.** Gemini's `ApiAuthDialog` shows the key in clear
   (`<TextInput>`, no mask prop, only a character filter) and opencode's `/connect` uses `DialogPrompt` with
   `placeholder="API key"` and no mask (§2.3, §2.4). Codex has no in-TUI key entry at all: `printenv OPENAI_API_KEY |
   codex login --with-api-key` (§2.1). Claude Code never asks for a key; it asks you to *approve* an env key (§2.2).
   JevCode should be stricter than all four: masked, redactor-seeded, fingerprint-only in scrollback.
9. **Trust is a separate, per-workspace gate keyed on the repository root, never persisted for `$HOME`.** Claude
   Code keys `hasTrustDialogAccepted` on the git root, holds home-directory trust for the session only, and never
   shows the dialog non-interactively (§2.2). Gemini's dialog title is the sentence to copy: "Do you trust the files
   in this folder?" (§2.3). For JevCode the trusted inputs are `AGENTS.md`/`CLAUDE.md` (research 10 §15.8) and the
   workspace `.env` / `jevcode.json` that the precedence chain already reads.
10. **Non-TTY never prompts.** clig.dev: "Only use prompts or interactive elements if `stdin` is an interactive
    terminal (a TTY)" and "If `--no-input` is passed, don't prompt or do anything interactive" (§2.6). Codex, Gemini
    (`headless … will use your existing authentication … if … cached`) and Claude Code (`-p` never shows trust) all
    agree. JevCode prints the instruction block and exits with the `ConfigError` code 2.

---

## 1. Where JevCode stands today (read 2026-09-20)

### 1.1 Resolution, validation, and where the error surfaces

- Precedence `flag > env > ./.env > <OPEN_ASSIST_PATH>/.env > config file > default`, sources recorded per entry
  (`src/config/resolve.ts:1-9`, `lookup()` `:141-163`). Empty strings count as unset at every layer: "`.env.example`
  ships `ANTHROPIC_API_KEY=`" (`resolve.ts:140`; `.env.example` lines 4-5, 8).
- `validateGenerator`: `if (!keyR || keyR.value.trim().length === 0) throw missing(reader, 'generator.apiKey', \`the ${provider} API key\`)`
  (`validate.ts:107`); `validateDecider`: `throw missing(reader, 'decider.apiKey', 'the Jev API key')` (`:134`). The
  message ends with `(consulted: …)` from `describeSources` (`resolve.ts:165-174`), e.g.
  `--jev-api-key (flag)`, `JEV_API_KEY / OPENROUTER_API_KEY (env)`, `JEV_API_KEY / OPENROUTER_API_KEY (dotenv:/repo/.env)`,
  `jevApiKey (file:/Users/x/.config/jevcode/config.json)`, `no default`.
- `commandRun` order (`main.tsx:81-158`): renderer created and first frame committed → `resolveConfig` →
  `config.limits()` → task → `buildProvider` (generator key checked here unless jev-only / mock) → `buildDecider`
  (Jev key checked). Any throw goes to `catch { await renderer.unmount(); throw e }` and then `fatalExit` →
  `process.stderr.write(\`jevcode: ${err.message}\n\`)`, `process.exit(2)`.
- `jevcode config` (`main.tsx:231-248`) prints the table with secrets as `<source> (sha256:xxxxxxxx)` and the sandbox
  level line; this is the read-only twin the wizard's `/config` should reuse.

### 1.2 Secret handling already available

- `createRedactor(secrets).addSecret(name, value)` returns false below `MIN_SECRET_LENGTH = 8` and dedupes
  (`src/core/redact.ts:28, 70-77`); `SecretSet` seeding includes every secret-looking variable in every loaded
  `.env` and config file (`SECRET_NAME_RE`, `resolve.ts:290-297`). Format patterns `sk-or-v1-…`, `sk-ant-…` exist
  (`redact.ts:43-48`), so even an un-seeded key of those shapes is pattern-redacted.
- `fingerprint(secret)` = first 8 hex of SHA-256 (`src/core/hash.ts:22-24`); `maskEntries` (`config/mask.ts`).
- Atomic writes: `writeFileAtomic(path, data, { mode, mkdir, fsync })` — temp file in the same dir, `rename(2)`
  (`src/core/atomic.ts:19-37`). Note: `mode` is applied at `open(tmp, 'w', mode)`; Node documents that `mode` "sets the
  file mode (permission and sticky bits), but only if the file was created" (https://nodejs.org/docs/latest-v22.x/api/fs.html,
  fetched 2026-09-20). Because the temp file *is* newly created, `0o600` applies; an explicit `chmod` after rename is
  still the belt for a pre-existing config file that was `0644`.
- `.env` parsing: `util.parseEnv` into an isolated map, never `process.env` (`src/config/env.ts:1-5`).

### 1.3 Places a key could leak today

| Sink | Status | Evidence |
| --- | --- | --- |
| `JEVCODE_TRACE` keystroke line | **leaks** if a masked field reuses `useInput` unchanged | `App.tsx:126` `tui.useInput input=${JSON.stringify(input)} ctrl=${key.ctrl}`; measured §4.1 C/D |
| `<Static>` transcript | safe if items carry fingerprints only | `itemsFromEvent` builds items from engine events; the wizard adds its own items (§5.4) |
| `history.jsonl` (proposed, 10 §15.5) | not applicable: wizard input never enters the composer buffer | design rule §5.4 |
| `run.json` / `jevcode config` | safe | `maskEntries` (`mask.ts:16-22`) |
| stderr `ConfigError` message | safe | message names the setting and sources, never the value (`validate.ts:22-28`) |
| `configFile … is not valid JSON` | safe | `sanitiseJsonError` drops V8's quoted fragment (`resolve.ts:93-99`) |
| sandboxed child env | safe | env scrubbing (README "Sandbox guarantees") |

### 1.4 Sandbox availability

`detectSandboxLevel(profile, platform, exists)` returns `'seatbelt'` only when `platform === 'darwin' && exists('/usr/bin/sandbox-exec')`, else `'none'`
(`src/sandbox/seatbelt.ts:118-121`). `jevcode config` already prints the two explanatory sentences for each level
(`main.tsx:246`); the TUI shows nothing about it today.

### 1.5 Plain mode has no masked input primitive

`createReadlineConfirmer` uses `createInterface({ input, output, terminal: false })` (`src/tui/plain.ts:379`); Node's
`readline` echoes typed characters and has no mask option. A plain-mode key prompt therefore needs either raw mode
(`readStream.setRawMode(true)`: "all special processing of characters by the terminal is disabled, including echoing
input characters. Ctrl+C will no longer cause a SIGINT" — https://nodejs.org/docs/latest-v22.x/api/tty.html, fetched
2026-09-20) with its own byte loop, or stdin piping (§5.9).

---

## 2. What the reference tools do (primary sources)

### 2.1 Codex CLI (openai/codex, `codex-rs/login`)

- Storage: `pub(super) fn get_auth_file(codex_home: &Path) -> PathBuf { codex_home.join("auth.json") }`; permissions
  `#[cfg(unix)] { options.mode(0o600); }`; struct `AuthDotJson { auth_mode: Option<AuthMode>, openai_api_key: Option<String>, tokens: Option<TokenData>, last_refresh: …, agent_identity: …, personal_access_token: …, bedrock_api_key: …, bedrock_access_keys: … }`;
  store modes File / Keyring / Auto ("attempts keyring with file fallback") / Ephemeral; `delete_file_if_exists`
  removes the file and returns whether it existed
  (https://raw.githubusercontent.com/openai/codex/main/codex-rs/login/src/auth/storage.rs, 2026-09-20).
- `pub const OPENAI_API_KEY_ENV_VAR: &str = "OPENAI_API_KEY";` `login_with_api_key(codex_home, api_key, store_mode, keyring)` writes
  `AuthDotJson { auth_mode: Some(AuthMode::ApiKey), openai_api_key: Some(api_key.to_string()), … }`; `logout` →
  `storage.delete()`. In `load_auth`: `// API key via env var takes precedence over any other auth method.` guarded by
  `enable_codex_api_key_env && auth_mode_is_allowed(…, AuthMode::ApiKey) && let Some(api_key) = read_codex_api_key_from_env()`
  — the env var read there is `CODEX_API_KEY`, and the branch is gated by a flag
  (https://raw.githubusercontent.com/openai/codex/main/codex-rs/login/src/auth/manager.rs, 2026-09-20).
- Docs (https://developers.openai.com/codex/auth → 308 → https://learn.chatgpt.com/docs/auth, 2026-09-20): "Pipe the key
  to `codex login` through stdin: printenv OPENAI_API_KEY | codex login --with-api-key"; "Codex caches login details
  locally in a plaintext file at `~/.codex/auth.json`"; "`file` stores credentials in `auth.json` under `CODEX_HOME`
  (defaults to `~/.codex`)"; "Treat `~/.codex/auth.json` like a password: it contains access tokens. Don't commit it,
  paste it into tickets, or share it in chat."; headless: "Run `codex login --device-auth`"; "Use
  `cli_auth_credentials_store` to control where the Codex CLI stores cached credentials". `codex login status` and
  `codex logout` exist (same page, summarised by the fetch tool). `codex-rs/core/src/auth.rs` and `docs/authentication.md`
  are gone/redirect (404 and a one-line pointer respectively, 2026-09-20).
- Lesson: **the key is never typed into the TUI** — it arrives on stdin from `printenv`, so it never hits a pty, a
  shell history line or `ps`. That is the non-TUI shape JevCode should copy for `jevcode login`.

### 2.2 Claude Code (docs, 2026-09-20)

- First launch: "On first launch, Claude Code opens a browser window for you to log in. If you've set the
  `ANTHROPIC_API_KEY` environment variable, Claude Code skips the login prompt and asks you to approve the key
  instead." (https://code.claude.com/docs/en/authentication). Precedence item 3: "`ANTHROPIC_API_KEY` … In interactive
  mode, you are prompted once to approve or decline the key, and your choice is remembered. To change it later, use
  the "Use custom API key" toggle in `/config`. The toggle only appears while `ANTHROPIC_API_KEY` is set in your
  environment. In non-interactive mode (`-p`), the key is always used when present." Full order: cloud provider →
  `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` → profiles → `/login` OAuth.
  "Run `unset ANTHROPIC_API_KEY` to fall back to your subscription, and check `/status` to confirm which method is
  active. When a login and an API key are both configured, `/status` marks the credential that isn't in use."
- Storage: "On macOS, credentials are stored in the encrypted macOS Keychain. When the Keychain rejects the write …
  Claude Code stores your login in `~/.claude/.credentials.json` with file mode `0600` instead, the same storage it
  uses on Linux." `CLAUDE_CONFIG_DIR` relocates it. `apiKeyHelper` re-runs every five minutes
  (`CLAUDE_CODE_API_KEY_HELPER_TTL_MS`). `/logout` "also resets your first-launch setup state, so the next time you run
  `claude` it walks you through login and setup again." (same page).
- `~/.claude.json` stores "OAuth session and login state", "Per-project trust decisions (`hasTrustDialogAccepted`)",
  "Theme selection", "Onboarding completion state"; "not encrypted at rest and is protected only by OS file
  permissions" (https://code.claude.com/docs/en/claude-directory). `history.jsonl`: "Every prompt you've typed …
  kept indefinitely … plaintext" (same page) — a reason the wizard field must never feed prompt history.
- Trust: "Trust verification: First-time codebase runs and new MCP servers require trust verification. Note: Trust
  verification is disabled when running non-interactively with the `-p` flag. Note: When you start Claude Code directly
  in your home directory, trust acceptance is held for the current session only and is not written to disk"
  (https://code.claude.com/docs/en/security). "In a repository, Claude Code keys the trust on the git repository root";
  "Claude Code shows the trust dialog in interactive sessions only"; manual escape hatch: set
  `projects["<path>"].hasTrustDialogAccepted` to `true` in `~/.claude.json`; the dialog "lists the rules and directories
  the folder would grant so you can review them first" (https://code.claude.com/docs/en/permissions "Project allow
  rules and workspace trust").
- CLI: `claude auth login` (`--console` "to sign in with Anthropic Console for API usage billing"), `claude auth logout`,
  `claude auth status` "Show authentication status as JSON. Use `--text` for human-readable output. Exits with code 0
  if logged in, 1 if not"; `claude setup-token` "Prints the token to the terminal without saving it"; `--bare`
  "Minimal mode: skip auto-discovery of hooks, skills, custom commands, subagents, plugins, MCP servers, auto memory,
  and CLAUDE.md so scripted calls start faster … Sets `CLAUDE_CODE_SIMPLE`" (https://code.claude.com/docs/en/cli-reference);
  "Bare mode does not read `CLAUDE_CODE_OAUTH_TOKEN`. If your script passes `--bare`, authenticate with
  `ANTHROPIC_API_KEY` or an `apiKeyHelper` instead." (authentication page). `claude doctor` "Print read-only
  installation and settings diagnostics … without starting a session".
- Onboarding order: the theme picker is the first frame of a fresh profile (research 02 §1.6, observed 2026-09-20:
  "Choose the text style that looks best with your terminal"); login follows (quickstart step 2), trust at the first
  run in a codebase (security page). The exact theme → login → trust ordering as one sequence is **inferred from those
  three sources, not stated verbatim anywhere fetched** (UNVERIFIED as a single quote).

### 2.3 Gemini CLI (google-gemini/gemini-cli, `main`, 2026-09-20)

- Schema: `security.auth.selectedType` `{ type: 'string', label: 'Selected Auth Type', … default: undefined as AuthType | undefined, description: 'The currently selected authentication type.', showInDialog: false }`;
  `enforcedType` "The required auth type. If this does not match the selected auth type, the user will be prompted to
  re-authenticate."; `useExternal`; `security.folderTrust.enabled` default `true`, "Setting to track whether Folder
  trust is enabled." (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/cli/src/config/settingsSchema.ts).
- `enum AuthType { LOGIN_WITH_GOOGLE = 'oauth-personal', USE_GEMINI = 'gemini-api-key', USE_VERTEX_AI = 'vertex-ai', LEGACY_CLOUD_SHELL = 'cloud-shell', COMPUTE_ADC = 'compute-default-credentials', GATEWAY = 'gateway' }`;
  key resolution `apiKey || getEnv('GEMINI_API_KEY') || (await loadApiKey()) || undefined`
  (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/core/contentGenerator.ts).
- `AuthDialog.tsx` (moved to `packages/cli/src/ui/auth/`; the old `ui/components/` path is 404): title "Get started",
  "How would you like to authenticate for this project?", "(Use Enter to select)"; items "Sign in with Google", "Use
  Gemini API Key", "Vertex AI", …; Esc without a choice: `"You must select an auth method to proceed. Press Ctrl+C
  twice to exit."`; `GEMINI_API_KEY` pre-selects the key option, `GEMINI_DEFAULT_AUTH_TYPE` sets the default;
  persistence `settings.setValue(scope, 'security.auth.selectedType', authType)`
  (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/cli/src/ui/auth/AuthDialog.tsx).
- `ApiAuthDialog.tsx`: "Enter Gemini API Key", "Please enter your Gemini API key. It will be securely stored in your
  system keychain.", input is a `<TextInput>` with a character filter `text.replace(/[^a-zA-Z0-9_.-]/g, '')` and **no
  mask prop**; "(Press Enter to submit, Esc to cancel, Ctrl+C to clear stored key)"
  (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/cli/src/ui/auth/ApiAuthDialog.tsx).
- `FolderTrustDialog.tsx`: "Do you trust the files in this folder?"; "Trusting a folder allows Gemini CLI to load its
  local configurations, including custom commands, hooks, MCP servers, agent skills, and settings. These configurations
  could execute code on your behalf or change the behavior of the CLI."; options `Trust folder (${dirName})`,
  `Trust parent folder (${parentFolder})`, "Don't trust"; Esc exits with `ExitCodes.FATAL_CANCELLATION_ERROR`; "Gemini
  CLI is restarting to apply the trust changes..." (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/cli/src/ui/components/FolderTrustDialog.tsx).
- Docs: `.env` search "the first `.env` file it finds, searching up from the current directory, then in your home
  directory's `.gemini/.env`"; "Headless mode will use your existing authentication method, if an existing
  authentication credential is cached." (https://geminicli.com/docs/get-started/authentication/).

### 2.4 opencode (anomalyco/opencode, branch `dev`, 2026-09-20)

- `const file = path.join(Global.Path.data, "auth.json")`; write `.writeJson(file, { ...data, [norm]: info }, 0o600)`;
  schema union `Oauth { type: "oauth", refresh, access, expires, accountId?, enterpriseUrl? }`, `Api { type: "api", key, metadata? }`,
  `WellKnown { type: "wellknown", key, token }`; `get/all/set/remove`
  (https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/auth/index.ts).
- Paths: `const app = "opencode"; const data = path.join(xdgData!, app); const cache = …; const config = path.join(xdgConfig!, app); const state = path.join(xdgState!, app);`
  and `config: Flag.OPENCODE_CONFIG_DIR ?? Path.config`; all dirs `fs.mkdir(…, { recursive: true })` with default mode
  (https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/src/global.ts).
- Docs: "`/connect` … also callable as `opencode auth login`"; "stored locally at `~/.local/share/opencode/auth.json`";
  env pickup for `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`; precedence config `options.apiKey` → env → `auth.json`;
  `{env:VAR_NAME}` and `{file:~/path}` substitution in `opencode.json`; `opencode auth list`, `opencode auth logout`
  (https://opencode.ai/docs/providers/, summarised by the fetch tool).
- TUI: `dialog-provider.tsx` titles "Connect a provider", "Select auth method"; key entry via `DialogPrompt` with
  `placeholder="API key"` and no mask; submit `sdk.client.auth.set({ providerID, auth: { type: "api", key: value, … } })`,
  then `sync.bootstrap()`; Esc `dialog.clear()`
  (https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/tui/src/component/dialog-provider.tsx).

### 2.5 aider (2026-09-20)

- `--api-key provider=<key>` "has the effect of setting the environment variable PROVIDER_API_KEY=<key>";
  `--anthropic-api-key`, `--openai-api-key`; YAML `api-key:` list `- gemini=foo` (https://aider.chat/docs/config/api-keys.html).
- `.aider.conf.yml` searched in home, git root, cwd, `--config`; "Files loaded last will take priority"; "You can only
  put OpenAI and Anthropic API keys in the YAML config file. Keys for all APIs can be stored in a .env file"
  (https://aider.chat/docs/config/aider_conf.html). `.env` searched in home, git root, cwd, `--env-file`; "If the
  files above exist, they will be loaded in that order. Files loaded last will take priority."
  (https://aider.chat/docs/config/dotenv.html).
- Lesson: keys on the command line are a documented anti-pattern (§2.6); JevCode's `--api-key`/`--jev-api-key` flags
  exist (`args.ts:73, 79`, help text "prefer the env var") and should stay discouraged, never be the wizard's output.

### 2.6 clig.dev (https://clig.dev/, 2026-09-20)

"Only use prompts or interactive elements if `stdin` is an interactive terminal (a TTY)." — "If `--no-input` is passed,
don't prompt or do anything interactive." — "Do not read secrets directly from flags. When a command accepts a secret,
e.g. via a `--password` flag, the flag value will leak the secret into `ps` output and potentially shell history." —
"Consider accepting sensitive data only via files, e.g. with a `--password-file` flag, or via `stdin`." — "Do not read
secrets from environment variables. While environment variables may be convenient for storing secrets, they have proven
too prone to leakage." — precedence "Flags, The running shell's environment variables, Project-level configuration
(e.g. `.env`), User-level configuration, System wide configuration." — "Follow the XDG-spec." — "Confirm before doing
anything dangerous." No first-run/onboarding guideline exists on the page (checked 2026-09-20). JevCode's documented
env-var keys contradict the "no secrets from env" line; every reference tool reads env keys, so the pragmatic position
is: keep env, prefer the 0600 file, never flags.

### 2.7 Free verification endpoints

- OpenRouter: "To check the rate limit or credits left on an API key, make a GET request to
  `https://openrouter.ai/api/v1/key`." with `Authorization: Bearer <key>`; response `label`, `limit`, `limit_remaining`,
  `usage`, `is_free_tier` (https://openrouter.ai/docs/api-reference/limits, 2026-09-20). Whether the call itself is
  free is not stated (metadata endpoint; UNVERIFIED cost, presumed $0).
- Anthropic: `GET /v1/models` with `anthropic-version: 2023-06-01` and `X-Api-Key`; example
  `curl https://api.anthropic.com/v1/models -H 'anthropic-version: 2023-06-01' -H "X-Api-Key: $ANTHROPIC_API_KEY"`
  (https://platform.claude.com/docs/en/api/models-list → served as /docs/en/api/models/list, 2026-09-20). No pricing is
  attached to the endpoint (it lists models; a bad key is a 401). JevCode already uses raw `fetch` (README
  "Dependencies"), so no SDK is needed for this probe.
- Jev: only a real decisions call verifies the key; input is priced at $0.042 per million tokens, output free
  (`docs/DESIGN.md:3496`), and the client records `costUsd: response.usage.cost` (`src/jev/client.ts:327`). A one-Noul
  probe of a few hundred tokens costs well under $0.0001; that is the number to show before asking `y`.

---

## 3. Ink 7.1.1 facts the masked field relies on (installed source, 2026-09-20)

- `usePaste(handler, { isActive })` calls `setRawMode(true)` and `setBracketedPasteMode(true)`; "`usePaste` and
  `useInput` can be used together in the same component. They operate on separate event channels, so paste content is
  never forwarded to `useInput` handlers when `usePaste` is active." (`node_modules/ink/build/hooks/use-paste.js:1-8, 29-40`).
- Parser: `pasteStart = '\u001B[200~'`, `pasteEnd = '\u001B[201~'`; an unfinished paste returns `pendingFrom(escapeIndex)`
  and `hasPendingEscape()` is false for it, so the escape flush timer never splits a paste (`input-parser.js:148-157, 174-180`).
  Backspace bytes `0x7F`/`0x08` are split into separate events; `\r`, `\n`, `\t` are not, "because they can
  legitimately appear inside pasted text" (`:104-124`).
- `useInput`: a multi-character chunk (fast typing, or paste without bracketed mode) arrives as **one** call with the
  whole string as `input` (`use-input.js:7` doc; measured §4.1 C: one call, `len=108`). `parse-keypress.js` maps
  `127` and `8` to `'backspace'` (`:171-172, 428-435`); `[3~` is `'delete'` (`:56`). Both must clear a character.
- `useCursor().setCursorPosition({x, y} | undefined)` propagates in `useInsertionEffect` to log-update, which appends a
  cursor suffix and shows the cursor only while a position is set (`hooks/use-cursor.js`; `log-update.js:15-55`).
  Coordinates are relative to the dynamic region's origin, so `y` is the pane's row index below `<Static>` output.
- `<Static>` renders only `items.slice(index)` and advances `index` in `useLayoutEffect` (`components/Static.js:10-17`):
  append-only; an item, once committed, is in scrollback for good — which is why the wizard commits fingerprints, never
  keys, and never an interim "N chars" line.
- Screen reader: `this.isScreenReaderEnabled = options.isScreenReaderEnabled ?? process.env['INK_SCREEN_READER'] === 'true'`
  (`ink.js:185-187`); `<Text aria-label>` replaces children, `aria-hidden` drops the node (research 12 §1.1).
- `useFocus` is not needed: the wizard is a mode of the one existing `useInput` (`App.tsx:123-142`), gated by
  `Boolean(isRawModeSupported)` exactly as today.

---

## 4. Measurements (2026-09-20, Apple Silicon, macOS 26 / Darwin 25.6.0, Node 22.23.2)

### 4.0 Method

- Probe app `/tmp/jevonboard/wizard.mjs` (Ink 7.1.1 + React 19.3.0 from the repo's `node_modules`; provider pick →
  masked generator key → masked Jev key → atomic `0600` write → `saved` toast), bundled with the repo's esbuild flags
  (`--bundle --platform=node --format=esm --target=node22 --jsx=automatic --define:process.env.DEV='"false"'
  --alias:react-devtools-core=… --banner:js="import { createRequire … }"`) to `wizard.bundle.mjs` (982 KB), launched by
  `launch.js` (`module.enableCompileCache()` then `import`), like `bin/jevcode.js`.
- pty driver `/tmp/jevonboard/drive.py` (Python `pty.fork`, `TIOCSWINSZ`, timed `os.write`, per-chunk timestamps),
  the pattern from research 07 §8. Key under test: `K = 'sk-or-v1-' + 'a1b2c3d4e5f6'×8 + 'abc'` (108 chars); a second
  108-char key for the Jev field.
- Leak check: `grep -F` for both keys over the pty byte capture, every file under `/tmp/jevonboard` (probe home, trace
  files, timings) excluding the capture, plus `[Pasted` and `saved` markers.
- First frame: `script -q /dev/null sh -c 'stty rows R cols C; exec node …'`, spawn → first appearance of a sentinel in
  the accumulated pty bytes, fresh `NODE_COMPILE_CACHE` per run (`/tmp/jevonboard/ff.mjs`, the `perf/first-frame.ts`
  method, `src/perf/first-frame.ts:30-60`), `JEVCODE_ASSERT_NO_NETWORK=1` (no network attempt was flagged).

### 4.1 Masked entry, paste, leak and mode checks

| # | Scenario | usePaste / useInput events | key bytes in pty output | `[Pasted` | `<Static>` item with key | config mode / dir mode | Enter → file → 'saved' frame (child) | Enter → 'saved' bytes (pty) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 80×24, bracketed paste of 108 chars ×2 | `usePaste len=108` ×2; `useInput return` ×2 | 0 / 0 | 0 | none (items show `sha256:e31150e9`) | 600 / 700 | 0.6 ms / 2.0 ms | 2.5 ms |
| B | 40×8, same | same | 0 / 0 | 0 | none | 600 / 700 | 0.5 ms / 1.9 ms | 2.4 ms |
| C | 80×24, paste **without** brackets (one raw 108-byte chunk) | `useInput text len=108` ×2 | 0 / 0 | 0 | none | 600 / 700 | 0.7 ms / 2.0 ms | 2.9 ms |
| D | 80×24, key typed one byte per 3 ms (108 writes) + one Backspace | `useInput text len=1` ×108 | 0 / 0 | 0 | none | 600 / 700 | 0.6 ms / 1.4 ms | n/a |
| E | 80×24, paste split in two chunks 30 ms apart (`ESC[200~`+50 chars, then 58 chars+`ESC[201~`) | `usePaste len=108` ×1 (not split) | 0 / 0 | 0 | none | 600 / 700 | 0.6 ms / 2.1 ms | 2.8 ms |

- Bullets rendered: 77 at 80 columns (`> ` + 77 `•`, capped at `columns − 3`), 37 at 40 columns; the counter line reads
  `108 chars · Enter saves · Backspace · Ctrl-U clears · paste ok`.
- **Trace leak (the finding):** a copy of today's `App.tsx:126` line written per event produced, in C, one line
  `tui.useInput input="sk-or-v1-a1b2…abc" ctrl=false` — the full key; in D, 113 lines whose consecutive one-character
  `input="x"` values concatenate to the exact key (verified by reconstruction: `contains K1: True`). In A/B/E the naive
  line did **not** see the paste (it went to `usePaste`), which is luck, not safety. A kind/length-only trace
  (`tui.useInput kind=text len=108 masked=true`) leaked nothing in any scenario.
- No `[Pasted #n]`-style placeholder and no `<Static>` item is produced by a paste into the field in any scenario;
  the only committed lines are `[setup] provider: openrouter`, `[setup] generator key: entered (sha256:e31150e9)
  source=wizard`, `[setup] jev key: entered (sha256:66b18104) source=wizard`, `[setup] saved <path> (mode 0600)`.
- `fs.stat`: file `0600`, directory `0700` (`mkdir(…, { recursive: true, mode: 0o700 })` plus `chmod`; umask on this
  machine did not interfere).

### 4.2 First frame with the wizard as the first dynamic pane (cold compile cache)

| Binary | Geometry | Sentinel | Runs | median | p95 |
| --- | --- | --- | --- | --- | --- |
| `bin/jevcode.js run "perf probe" … --perf-exit-after-first-frame` (repo, today) | 40×120 | `step 0/` | 10 | 121.2 ms | 134.0 ms |
| wizard bundle (`launch.js`), provider pane is the first dynamic pane | 40×120 | `Pick the generator provider` | 10 | 107.1 ms | 119.4 ms |
| wizard bundle | 24×80 | same | 5 | 106.1 ms | 112.2 ms |
| wizard bundle | 8×40 | `No API keys` (the longer sentinel wraps at 40 cols) | 5 | 126.1 ms | 175.7 ms |

Gate `p95 < 300 ms` holds with 125–180 ms of margin. The probe is smaller than the real CLI (no config/arg modules), so
the 14 ms difference is not a saving; the point is that a wizard pane in the first dynamic region costs nothing
measurable. In the proposed design the wizard is not even in the first frame (§5.2).

### 4.3 Captured frames (ANSI stripped, from B and A)

80×24 after the provider pick, key field with 108 masked characters (the transcript above the rule is `<Static>`):

```
[setup] provider: openrouter
────────────────────────────────────────────────────────────────────────────────
openrouter API key (generator)
> •••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••
108 chars · Enter saves · Backspace · Ctrl-U clears · paste ok
```

40×8 (rows − 2 = 6 dynamic rows: rule 1 + label 1 + field 1 + hint 2; Ink wrapped the hint):

```
[setup] provider: openrouter
────────────────────────────────────────
openrouter API key (generator)
> •••••••••••••••••••••••••••••••••••••
108 chars · Enter saves · Backspace ·
Ctrl-U clears · paste ok
```

---

## 5. Decision and specification

### 5.1 Trigger and detection (no throw, no network)

- After the first frame, `commandRun` already calls `resolveConfig()`. Add a **pure, non-throwing** probe on the
  resolved config: `config.missingSecrets(mode: EngineMode): SettingName[]` → `['generator.apiKey']`, `['decider.apiKey']`,
  both, or `[]`, reading `entries` exactly as `validateGenerator`/`validateDecider` do (`keyR.value.trim().length === 0`
  counts as missing, `validate.ts:107, 134`), skipping `generator.apiKey` when `mode === 'jev-only'` or
  `flags.mock`/`flags.mockGenerator` (`main.tsx:162`). Nothing else is validated here; a malformed URL still surfaces
  as today's `ConfigError` later.
- Interactive is `stdout.isTTY && stdin.isTTY && !flags.plain` (`main.tsx:82`) **and not** `--no-input` /
  `JEVCODE_NO_INPUT=1` (new; clig §2.6). Only then does the wizard run; otherwise §5.8.
- Both entry points get the wizard: bare `jevcode` (composer) and `jevcode run "task"` on a TTY (the task is kept and
  the run starts after `saved`). `--resume` gets it too (re-resolution needs the key; identity comes from `run.json`).

### 5.2 State machine (one reducer, `src/tui/onboarding.ts`, pure)

```
detect ──missing=[]──────────────────────────────────────────────────────────────▶ trust? ─▶ sandbox ─▶ composer
  │ missing≠[]
  ▼
provider  (skipped when generator.apiKey is present or mode=jev-only; pre-selected from JEVCODE_PROVIDER/--provider)
  │ 1 = anthropic   2 = openrouter
  ▼
generatorKey  (masked; skipped when present)
  │ Enter (≥ 8 chars)
  ▼
jevKey  (masked; when provider=openrouter and the generator key was just entered: "Enter = reuse it for Jev";
  │       skipped when present via JEV_API_KEY/OPENROUTER_API_KEY)
  ▼
save  ─▶ 'saved' toast + <Static> lines (fingerprints, path, mode)
  │
  ▼
verify?  (optional; explicit `y`; shows the request list and the Jev probe cost; `n`/Enter skips)
  │
  ▼
trust  (first run in this workspace: AGENTS.md / CLAUDE.md / ./.env / ./jevcode.json listing; 1 trust · 2 session · 3 no)
  │
  ▼
sandbox  (one committed line: level and what it does/does not cover; no key press)
  │
  ▼
composer  (or: start the argv task)
```

Transitions carry no secrets: the reducer state holds `field: { name: 'generator.apiKey' | 'decider.apiKey', length: number }`
and the buffer lives in a `useRef<string>` inside the component (never in React state, never in the reducer, so a
devtools dump or a state snapshot in a test cannot contain it). `Esc` = clear the field (empty) or step back (one level;
from `provider` it is a no-op with the hint "Ctrl-C quits"); `Ctrl-C` anywhere = §5.8's instruction block to stderr and
exit 2 (`ConfigError` code) — the run has not started, so nothing to checkpoint.

Frames at 80×24 (dynamic region = rows − 2 = 22, but the wizard uses ≤ 5 so the decisions pane stays visible when a
run is live behind `/login`):

```
[run] jevcode | step 0/– starting
────────────────────────────────────────────────────────────────────────────────
No API key found. Pick the generator provider:
  1  anthropic   (ANTHROPIC_API_KEY)          2  openrouter  (OPENROUTER_API_KEY, also serves Jev)
Keys are never shown, logged or echoed · Esc back · Ctrl-C quit (prints the env/file instructions)
step 0/– · setup
```

```
────────────────────────────────────────────────────────────────────────────────
Jev API key (JEV_API_KEY; falls back to OPENROUTER_API_KEY)
> ••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••
108 chars · Enter saves · Backspace · Ctrl-U clears · paste ok · Esc back
step 0/– · setup
```

```
[setup] jev key: entered (sha256:66b18104) source=wizard
[setup] saved ~/.config/jevcode/config.json (mode 0600, dir 0700)
────────────────────────────────────────────────────────────────────────────────
Verify the keys now?  GET openrouter.ai/api/v1/key ($0) · GET api.anthropic.com/v1/models ($0) · 1 Jev decision (~$0.0001)
[y] verify   [n] skip
step 0/– · setup
```

```
────────────────────────────────────────────────────────────────────────────────
Do you trust the files in /Users/x/repo?  (git root; decision stored per repository)
  AGENTS.md (2.1 KiB) → generator system prompt      ./.env (3 vars, 2 secret-looking) → config     jevcode.json (none)
  1  trust   2  this session only   3  don't trust (instruction files ignored; .env still read for keys)
step 0/– · setup
```

At 40×8 (budget 6): status 1 + rule 1 + pane ≤ 4; the provider options stack vertically (`1 anthropic` / `2 openrouter`),
the key hint shrinks to `108 · Enter · ⌫ · ^U · Esc`, the trust listing shows counts only (`AGENTS.md 2.1K · .env 3/2`);
verified shape in §4.3.

### 5.3 Input rules for the masked field

- One `useInput` (existing hook, `App.tsx:123`) routes by `state.onboarding.step`; one `usePaste` at the same level,
  `{ isActive: Boolean(isRawModeSupported) }`. Handlers: `key.return` → submit; `key.backspace || key.delete` → drop one
  code point (`Array.from(buf).slice(0, -1)`); `key.ctrl && input === 'u'` → clear; `key.escape` → clear/back;
  arrows/tab/meta/ctrl → ignored; otherwise `append(sanitize(input))`.
- `sanitize(s)`: strip `ESC[…]` sequences and C0/C1 controls (reuse `sanitizeStream` from `src/tui/plain.ts`), then
  strip **all** whitespace including `\r\n\t` (keys never contain it; terminals without bracketed paste may append the
  trailing newline of a copied line — measured path C receives it in the same chunk). A paste **never submits**; Enter
  does. A multi-character `input` in `useInput` is treated as a paste (path C), same sanitizer.
- Length rule: `MIN_SECRET_LENGTH` (8, `redact.ts:28`) is the floor (the redactor ignores shorter values, so they must
  not be accepted); toast `key too short (8+ characters)`. Prefix hints only warn, never block:
  `anthropic` keys start `sk-ant-`, OpenRouter `sk-or-v1-` (`redact.ts:43-44` patterns); toast
  `this does not look like an anthropic key — Enter again to keep it`.
- On submit: `redactor.addSecret('generator.apiKey' | 'decider.apiKey', value)` **first**, then commit the `<Static>`
  line with `fingerprint(value)`, then clear the ref. `ResolvedConfig.redact` is the same closure the engine and
  renderers hold (`resolve.ts:333`), so the value is redacted everywhere from that instant, including a later
  `ProviderHttpError` body that echoes the header.
- Mask: `'•'.repeat(min(length, columns − 3))` inside `<Box height={1} overflow="hidden">` `<Text wrap="truncate">`;
  `useCursor().setCursorPosition({ x: 2 + shown, y: rowOfField })` while the field is active, `undefined` otherwise
  (IME preedit lands in the field; verified cursor suffix path in `log-update.js`). `--ascii`: `*`.
- Trace gating: `App.tsx:126` becomes
  `tui.useInput kind=<return|backspace|ctrl|escape|text> len=<n> masked=<bool>` always (not only in the wizard); no
  `input` value ever reaches `JEVCODE_TRACE`. `usePaste` logs `tui.usePaste len=<n> masked=<bool>`.
- Never: no `[Pasted #n +k lines]` placeholder (Claude Code's composer behaviour, research 07 §1.1) in this field, no
  `paste-cache`, no `history.jsonl` entry, no `TranscriptItem` for interim lengths, no `key.shift` uppercase logic.

### 5.4 Persistence

- Target: `${XDG_CONFIG_HOME:-~/.config}/jevcode/config.json` (research 09 §11.6; today `join(home, '.config', 'jevcode', 'config.json')`,
  `resolve.ts:208` — add the `XDG_CONFIG_HOME` branch there and in the writer). Write: read existing file if present
  (`readConfigFile`), merge `{ provider, apiKey?, jevApiKey? }` (fileKeys from `defaults.ts:51-58`; never write
  `jevBaseUrl`/models — those stay defaults), `writeFileAtomic(path, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600, mkdir: true })`,
  then `chmod(path, 0o600)` and `chmod(dir, 0o700)` (mode on `open` applies only to created files, Node docs §1.2; the
  directory is created with `mkdir(dir, { recursive: true, mode: 0o700 })`; "on Windows mode is not supported" — print
  `(Windows: protected by your user profile ACL)` there, as Claude Code documents for `%USERPROFILE%\.claude\.credentials.json`).
- Never write `./.env`, `./jevcode.json` or the Open Assist `.env`: the workspace is the *agent's* territory, may be a
  git repo without a `.gitignore` entry, and `secretPaths` protection is weaker there (a `.env` outside the workspace
  is unreadable to commands; one inside it is what Codex/Claude Code warn users not to commit). The `saved` line names
  the file so users who prefer env can copy the two names.
- `--config <file>` / `JEVCODE_CONFIG` present: write to that file instead (it is what the next run reads).
- If a `./jevcode.json` exists (first default, `resolve.ts:208`), the wizard still writes the user file **and** warns
  `./jevcode.json takes precedence for non-secret keys; keys were saved to ~/.config/… — remove any apiKey there`.
- After `saved`, `commandRun` re-runs `resolveConfig(flags, env, cwd)` (the `--resume` branch already does a second
  resolution, `main.tsx:137`) so `config.generator()`/`decider()` see the file with source `file:<path>` and the run
  proceeds with a redactor that also carries the file-sourced secrets. The pre-save redactor's `addSecret` covered the
  window in between.

### 5.5 Env-vs-file conflict copy

Precedence is fixed (`flag > env > dotenv > file`), so a saved key can be **shadowed** later. Rules and copy:

- At every start, when a secret setting resolves from `env`/`dotenv` **and** the config file also holds that key with a
  different fingerprint, commit one `<Static>` line: `[config] generator.apiKey: env ANTHROPIC_API_KEY (sha256:1a2b3c4d)
  overrides file ~/.config/jevcode/config.json (sha256:9f8e7d6c) — unset the variable to use the saved key`. Mirrors
  Claude Code's "your choice is remembered … `unset ANTHROPIC_API_KEY`" without a modal.
- Wizard start when env is set but empty (`ANTHROPIC_API_KEY=` from `.env.example`): message `ANTHROPIC_API_KEY is set
  but empty in ./.env — treated as unset` (the `lookup()` rule, `resolve.ts:140`).
- A 401 during the run when the key came from env: the `ProviderHttpError` path adds a hint line `key source: env
  ANTHROPIC_API_KEY — run /login to save a different key, or unset the variable` (never the value).
- `/config` (read-only, §5.10) shows the `source` column for every setting so the shadowing is always visible.

### 5.6 Optional verification (explicit, priced, after save, abortable)

- Runs only after `saved` (a network failure must not cost the user the keys) and only on `y`. Requests, with a 5 s
  `AbortSignal.timeout` each and `signal` chained to Ctrl-C: OpenRouter `GET https://openrouter.ai/api/v1/key`
  (Bearer; success shows `label` and `limit_remaining` only); Anthropic `GET https://api.anthropic.com/v1/models`
  (`x-api-key`, `anthropic-version: 2023-06-01`; success shows the count and whether the configured `generator.model`
  is in `data[].id`); Jev: one decisions request through `jev/client.ts` with a fixed one-Noul question, shown as
  `~$0.0001` and metered into the run's spend (the client records `usage.cost`).
- Results commit as `<Static>` lines with status only: `[verify] openrouter key ok (label "laptop", $4.12 remaining)`,
  `[verify] anthropic key rejected (401)`, `[verify] jev ok (typesafe/jev-1.13-20260917, 231 ms, $0.00008)`; bodies pass
  `config.redact` and are truncated to one line. A rejected key returns to the corresponding field with the toast
  `rejected — Enter to try another key, n to keep it anyway`.
- Never before the first frame, never automatic (`JEVCODE_ASSERT_NO_NETWORK` stays satisfiable), never in `--plain`.

### 5.7 Workspace trust, sandbox notice, empty composer

- **Trust gate** (new `~/.jevcode/trust.json`, mode 0600, `{ "<realpath of git root or workspace>": { "trusted": true, "at": "<iso>", "files": ["AGENTS.md@sha256:…"] } }`):
  shown on the first interactive run in a workspace whose *untrusted inputs* exist: `AGENTS.md`/`CLAUDE.md` (would
  enter the generator system prompt, research 10 §15.8), `./.env` (secret-looking vars join the SecretSet and keys
  are read from it), `./jevcode.json` (non-secret settings). Options `1 trust · 2 this session only · 3 don't trust`.
  `3` = instruction files ignored (recorded in `run.json.instructions = []`), `.env` **still read** for keys (existing,
  documented behaviour; changing it would break every current user), `jevcode.json` still read (non-secret). Home
  directory as workspace: never persisted (Claude Code rule). Non-TTY/`-p`-equivalent: instruction files skipped with
  one stderr line `AGENTS.md not loaded: workspace not trusted (run interactively once, or pass --trust-workspace)`.
  The listing shows sizes and secret-looking counts, never values.
- **Sandbox notice**: one `<Static>` line at `run:ready` time (it needs `detectSandboxLevel`, post first frame):
  `[sandbox] seatbelt — writes confined to the workspace and run dirs; harness secret files, ~/.ssh, ~/.aws unreadable`
  or `[sandbox] none — sandbox-exec is not available on linux: cwd confinement, env scrubbing, timeout, output cap and
  tree kill only (jevcode config for details)`; reuse the two sentences from `main.tsx:246`. Shown every session
  (cheap, one line); bold on the first run.
- **Empty composer placeholder** (dim, `aria-label="empty prompt"`): `Describe the task… ( / commands · Enter runs ·
  Ctrl-C quits )`; when keys are missing and the wizard was dismissed: `No API key saved — type /login to add one, or set
  OPENROUTER_API_KEY`. The placeholder is a `<Text dimColor>` sibling, never text in the buffer, so it cannot be
  submitted or recorded.

### 5.8 Non-TTY, `--plain`, CI, `--no-input`

No prompt of any kind. `commandRun` prints to stderr and returns `EXIT_CODES.config` (2):

```
jevcode: generator.apiKey: the anthropic API key is not set (consulted: --api-key (flag), ANTHROPIC_API_KEY / JEVCODE_API_KEY (env), …, no default)
To fix, one of:
  export ANTHROPIC_API_KEY=…            # generator (anthropic); OPENROUTER_API_KEY serves both when --provider openrouter
  export JEV_API_KEY=…                  # Jev; falls back to OPENROUTER_API_KEY
  printenv ANTHROPIC_API_KEY | jevcode login --provider anthropic --generator-key-stdin
  jevcode login                         # interactive, masked, saves ~/.config/jevcode/config.json (mode 0600)
Keys are never accepted as command-line arguments in the interactive flow; --api-key exists for scripts (prefer env).
```

The first line is today's `ConfigError` message unchanged (tests that grep it keep passing); the block is appended by
`fatalExit` when `err.setting` is a secret setting and stdin is not a TTY or `--no-input` is set.

### 5.9 Non-TUI equivalents

- `jevcode login [--provider anthropic|openrouter] [--generator-key-stdin] [--jev-key-stdin] [--status] [--verify]`
  - TTY, no `*-stdin` flags: raw-mode masked prompt (own ≤ 60-line byte loop: `setRawMode(true)`, accumulate, `0x7f/0x08`
    delete, `0x15` clear, `0x03` → restore and exit 2, `\r` submit; bracketed paste markers stripped; echo `•`); same
    sanitizer, same length rule, same file writer, same fingerprint-only output. Not `readline` (echoes).
  - Pipe: `printenv OPENROUTER_API_KEY | jevcode login --jev-key-stdin` reads one line, exactly Codex's shape (§2.1);
    both `*-stdin` flags together read two lines. Refuses when stdin is a TTY and a `*-stdin` flag is given without
    piped data? No — reads until newline like Codex; documented.
  - `--status`: prints `generator.apiKey: file:~/.config/jevcode/config.json (sha256:…)` per secret with source, exit 0
    when both resolve, 1 otherwise (Claude Code `claude auth status` convention). Zero network.
  - `--verify`: §5.6 requests, exit 0/5.
- `jevcode logout [--generator] [--jev]`: removes the named keys from the config file (default both), rewrites atomically
  with the same mode, prints what was removed by fingerprint; env-sourced keys are reported, not touched (like Claude
  Code's `/status` marking the credential "that isn't in use").
- `jevcode config set <setting> <value>`: non-secret settings only; a secret setting name is refused with
  `secret settings are set with 'jevcode login' (stdin or masked prompt), never as an argument`. `jevcode config` stays
  the read-only table.
- `--api-key` / `--jev-api-key` flags remain for scripts (help already says "prefer the env var"), are fingerprinted in
  `run.json`, and are never suggested by any wizard copy.

### 5.10 In-session commands and rotation

- `/login` re-enters the wizard at `provider` (or the missing field) while a run may be live behind it: the pane takes
  its rows from the decisions pane first (`computeLayout` order, `App.tsx:43-59`). On `saved`: `addSecret` immediately;
  toast `saved — applies to the next run (this run keeps its key)`, because providers are built once per run from the
  memoised `config.generator()` (`resolve.ts:312-318`) and a mid-run swap would desynchronise `run.json.config`.
- `/logout` = `jevcode logout` semantics plus the toast; the running run is unaffected.
- `/config` = read-only `maskEntries` table with the `source` column (the `jevcode config` renderer, `mask.ts:35-48`),
  in a scrollable overlay capped at rows − 2; secrets as `<source> (sha256:…)`; a `sandbox level` footer line.
- `/trust` re-opens §5.7 for the current workspace; `/doctor` prints the `--status` block plus sandbox level, Node
  version, config path and mode (0600 or a warning), zero network.

### 5.11 Screen-reader and `--ascii` twins

- Screen reader (`--screen-reader` / `JEVCODE_SCREEN_READER` / `INK_SCREEN_READER`, research 12 §1.5): the bullets line
  is `<Text aria-hidden>`, replaced by `<Text aria-label={\`API key field, ${n} characters entered, hidden\`}>`; the
  counter updates only on submit/clear, not per keystroke (each rewrite is re-announced, research 12 §1.1); options are
  numbered lines `1. anthropic  2. openrouter` followed by `Enter selection (1-2):`; no rule line; BEL once when the
  wizard opens and once at `saved`.
- `--ascii` / `JEVCODE_ASCII=1` (00-SUMMARY A90): `*` for `•`, `-` for `─`, `[ok]` for `✓`, `^U`/`Bksp` for `⌫`.
- `--plain` on a TTY: the §5.9 raw-mode prompt inline in the line stream (`[setup] …` lines, same texts).

### 5.12 Layout arithmetic

`computeLayout(rows, pendingConfirm, previewLines)` (`App.tsx:43-59`) gains `wizardRows` allocated **after** status,
rule and live and **before** the decisions pane: provider 3, key field 3, verify 2, trust 4 (2 at < 12 rows), saved 2.
At rows 8: `budget 6 = status 1 + rule 1 + wizard 3–4`, decisions 0, live 0 while the wizard is up (no run yet). At rows
24: wizard ≤ 4 leaves ≥ 12 for decisions when `/login` is used mid-run. Every pane row is a fixed-height
`<Box overflow="hidden">` with `<Text wrap="truncate">` so wrapped hints (as in §4.3 at 40 columns) cannot push past the
budget; below `MIN_COLUMNS = 40` the hint row is dropped first (research 12 §4).

---

## 6. Tests

Unit (vitest, no pty):

1. `onboardingReducer`: `detect` with `missing=[]` → `trust|sandbox|composer`; `['generator.apiKey']` → `provider`;
   `['decider.apiKey']` only → `jevKey` directly; `mode='jev-only'` never asks for the generator key; provider pre-select
   from `--provider`; openrouter + entered generator key → `jevKey` offers reuse and Enter reuses (fingerprints equal).
2. Reducer never holds a secret: `JSON.stringify(state)` after every transition contains neither the test key nor
   any 8+ char substring of it (property test over the §12.4 key-sequence fuzzer).
3. `sanitizeKey`: strips `\r\n\t `, C0/C1, `ESC[200~`/`ESC[201~` remnants; keeps `-_.`; rejects `< 8`; NFC-normalises.
4. `missingSecrets()`: table over env/dotenv/file/flag combinations including empty strings (`.env.example`) and the
   `JEV_API_KEY → OPENROUTER_API_KEY` fallback.
5. `writeConfigSecrets()`: merges with an existing file, preserves unknown keys, mode `0600`/dir `0700` (`fs.stat` on a
   tmp `HOME`), atomic (no `.tmp-*` left), honours `XDG_CONFIG_HOME` and `--config`; a pre-existing `0644` file ends up
   `0600`.
6. `conflictLine()`: env vs file with different fingerprints → one line; same fingerprint → none; empty env → the
   "set but empty" note.
7. `jevcode login --jev-key-stdin` with a piped key: exit 0, file written, stdout contains only fingerprints; `--status`
   exit codes 0/1; `jevcode config set decider.apiKey x` refused with exit 2.
8. Non-TTY `jevcode run "x"` without keys: stderr starts with today's `ConfigError` line, contains the four-line fix
   block, exit 2; with `--no-input` on a fake TTY the same.
9. ink-testing-library frames at rows 8/12/24/40 × columns 40/80/120: dynamic lines ≤ rows − 2 in every wizard step;
   the bullets line never exceeds `columns`; screen-reader render contains `API key field, 108 characters entered` and no
   `•`; `--ascii` contains no non-ASCII.
10. Redactor: after `submit`, `config.redact('Authorization: Bearer <key>')` returns the `[REDACTED:decider.apiKey]`
    marker; a `ProviderHttpError` body containing the key is redacted in the error item.

pty (Python driver, `test/pty/onboarding.test.ts` spawning `python3` like `perf/render-lag.ts` spawns `script`):

11. Bracketed paste of a 108-char key (one chunk; split 30 ms; 20 KB junk paste): no key bytes in the pty capture, no
    `[Pasted`, exactly one `usePaste` in the safe trace, `<Static>` shows `sha256:` only.
12. Non-bracketed paste and 3 ms typing: no key bytes in the capture, in `JEVCODE_TRACE`, in `~/.jevcode/**`, in
    `history.jsonl`, in the run dir; `grep -rF <key>` over `$HOME` finds only `config.json`.
13. Enter → `saved` bytes on the pty < 50 ms (measured 2.4–2.9 ms); `stat` modes; first-frame gate (`perf/first-frame.ts`)
    unchanged with the wizard code bundled; zero `ESC[2J` after the first frame at rows 8 and 40 during the whole flow.
14. Ctrl-C in each step: terminal restored (`?2004l`, cursor shown), exit 2, instruction block on stderr, no file written.
15. Ctrl-Z / fg during the key field: raw mode and bracketed paste re-enabled, buffer intact, one repaint (research 12 §10.1).

---

## ADOPT

| What JevCode should do | Why | Source |
| --- | --- | --- |
| Detect missing secrets with a non-throwing `config.missingSecrets(mode)` after the first frame; keep `ConfigError` for everything else | The first frame stays argv-only (DESIGN §12); validation messages already name settings and sources | `validate.ts:107,134`; `main.tsx:81-158` |
| Masked key field = `<Text>` bullets + `useCursor` + `usePaste` + the existing single `useInput`; buffer in a ref, never in reducer state | Ink 7.1.1 delivers pastes as one event on a separate channel; measured 0 key bytes on the pty, no placeholder, no Static item in 5 scenarios | `use-paste.js:1-8`; `input-parser.js:148-180`; §4.1 |
| Treat a multi-char `useInput` chunk as a paste; strip whitespace and controls; paste never submits | Terminals without bracketed paste deliver the key (and its trailing newline) as one chunk | `use-input.js:7`; §4.1 C |
| Change `App.tsx:126` to log `kind/len/masked` only, always | A copy of today's line leaked the key whole (non-bracketed paste) and as 108 consecutive one-char lines (typing) | §4.1 C/D |
| `redactor.addSecret()` before the Static commit; commit fingerprints only | `addSecret` exists for exactly this ("a key returned by a login flow"); `<Static>` is append-only | `redact.ts:21-22, 70-77`; `Static.js:10-17` |
| Persist to `${XDG_CONFIG_HOME:-~/.config}/jevcode/config.json`, dir `0700`, file `0600`, atomic + `chmod` | Codex `options.mode(0o600)`, Claude Code `.credentials.json` "file mode 0600", opencode `writeJson(…, 0o600)`; path already in `secretPaths` | §2.1, §2.2, §2.4; `resolve.ts:208-214, 300`; `atomic.ts` |
| Never write keys into the workspace (`./.env`, `./jevcode.json`) | Codex: "Don't commit it"; the workspace is the agent's write area; no reference tool does it | §2.1; README "Sandbox guarantees" |
| Two-key flow with "Enter = reuse for Jev" when provider is openrouter; skip fields that already resolve | `JEV_API_KEY` falls back to `OPENROUTER_API_KEY`; jev-only never needs a generator key | `defaults.ts:58`; `main.tsx:162` |
| One-line env-vs-file shadowing notice with both fingerprints and `unset …` hint; `/config` shows sources | Claude Code remembers the env-key approval and tells users to `unset ANTHROPIC_API_KEY`; JevCode's precedence is fixed | §2.2 authentication page; `mask.ts` |
| Optional verification only on explicit `y`, only after save, priced: OpenRouter `GET /api/v1/key`, Anthropic `GET /v1/models`, one Jev decision (~$0.0001), 5 s timeouts | Zero network before the first frame; a failing network must not lose keys; Jev input costs $0.042/M | §2.7; `DESIGN.md:3496`; `jev/client.ts:327` |
| Trust gate per git root, listing `AGENTS.md`/`.env`/`jevcode.json` by size/count, home dir never persisted, never shown non-interactively | Claude Code keys `hasTrustDialogAccepted` on the repo root and holds `$HOME` trust for the session; Gemini lists what trust enables | §2.2 permissions/security; §2.3 FolderTrustDialog; research 10 §15.8 |
| Sandbox level as one Static line at `run:ready` | `detectSandboxLevel` is darwin + `sandbox-exec` only; `jevcode config` already has the copy | `seatbelt.ts:118-121`; `main.tsx:246` |
| Non-TTY / `--plain` / `--no-input`: no prompt; today's `ConfigError` line + a fix block; exit 2 | clig.dev TTY and `--no-input` rules; Codex/Gemini/Claude Code never prompt headless | §2.6; §2.1–2.3 |
| `jevcode login` with `printenv KEY \| jevcode login --*-key-stdin`, a raw-mode masked prompt on a TTY, `--status` (exit 0/1), `jevcode logout`, `config set` refusing secrets | Codex's stdin login is the leak-free non-TUI shape; `claude auth status` exit codes; clig "Do not read secrets directly from flags" | §2.1; §2.2 cli-reference; §2.6 |
| `/login` rotation applies to the next run; toast says so | Providers are built once per run from memoised config; `run.json.config` must stay truthful | `resolve.ts:312-318`; `main.tsx:157-158` |
| Screen-reader twin with `aria-label` counter updated on submit only; `--ascii` glyph table | Ink SR mode re-announces every rewrite; A90 glyph rules | research 12 §1.1, §1.5; 00 A90 |
| Wizard pane budgeted after status/rule/live and before decisions; ≤ 4 rows | rows − 2 discipline; verified frames at 40×8 and 80×24 | `App.tsx:43-59`; §4.3 |

## REJECT

| What not to do | Why |
| --- | --- |
| Show the key in clear while typing (Gemini `ApiAuthDialog`, opencode `DialogPrompt`) | Pty output, screen sharing and terminal scrollback would hold the key; measured masked path costs nothing |
| Collapse a pasted key into a `[Pasted text #1]` placeholder with a `paste-cache/` file (Claude Code composer) | A cache file would hold the key in plaintext "indefinitely" (claude-directory page); the field is not a composer |
| Take keys as positional/flag arguments in the wizard or suggest `--api-key` in copy | clig: leaks into `ps` and shell history; aider's `--api-key provider=key` is the anti-pattern to avoid |
| Write `./.env` or `./jevcode.json` | Inside the agent's writable workspace; may be committed; weaker `secretPaths` story |
| Store in the OS keychain (Codex `Keyring`, Claude Code macOS Keychain, Gemini "system keychain") | Needs a native module or spawning `security`/`secret-tool` — outside ink+react-only and adds a first-use prompt; Claude Code itself falls back to a `0600` file in SSH sessions |
| Verify keys automatically or before the first frame | Violates zero-network-at-launch; the Jev probe costs money; Codex/Claude Code verify at first request only |
| Auto-detect or auto-trust the workspace non-interactively | Claude Code never shows trust for `-p`; silently loading `AGENTS.md` into the system prompt is an injection path (00 §8 item 14) |
| Use `useFocus`/`useFocusManager` for the wizard fields | Research 08 §2.6: Tab/Esc interception; one `useInput` router is enough (measured) |
| Use `readline` for the plain-mode key prompt | It echoes; no mask option in Node 22 |
| Persist the wizard's key field into `history.jsonl` or any `TranscriptItem` text | "keys never appear in logs"; Claude Code's `history.jsonl` is plaintext and kept indefinitely |
| A theme picker as the first-run screen (Claude Code) | Adds a frame and a decision before the user can do anything; JevCode's colours are already label-paired (12 §3.2); `/theme` later if ever |
| Restart the process to apply trust or auth (Gemini "restarting to apply the trust changes") | A second resolve + `addSecret` applies in place; the first frame must not be paid twice |

## OPEN QUESTIONS

1. Should `3 don't trust` also stop reading `./.env` for keys? Today it is the documented key source (README
   "Install"); changing it needs a deprecation note. Proposed: keep reading, show the `dotenv:` source line.
2. `XDG_CONFIG_HOME` support changes the default config path for users who set that variable and already have
   `~/.config/jevcode/config.json`; check both, prefer XDG, warn once?
3. Does OpenRouter's `GET /api/v1/key` consume credits or count against rate limits? Docs are silent (UNVERIFIED).
4. Should the Jev verification use a fixed dated model id or the configured `decider.model` (alias resolution and the
   `JevModelDriftError` first-call rule, `errors.ts:90-102`, apply either way)?
5. Windows: `mode` is unsupported by `fs.mkdir`/`open`; is printing the ACL note enough, or should the wizard refuse to
   save on a world-readable filesystem (detect via `fs.stat` after write)?
6. Reuse-for-Jev default: Enter reuses the OpenRouter key; is a separate `JEV_API_KEY` common enough to make the
   default "ask"? (README documents the fallback as the norm.)
7. Should `--no-input` also imply "decline every review" (06 §16 reads clig that way), or stay onboarding-only?
8. Trust file location: `~/.jevcode/trust.json` (next to runs, inside the seatbelt-protected tree) vs the XDG config
   dir (portable, but readable by sandboxed commands unless added to `secretPaths`).
9. Where does the `[config] … overrides file …` line go in `--plain` — stderr (diagnostic) or the item stream (parity
   with `transcript.log`)?

## UNVERIFIED / not fetched

- Claude Code's exact onboarding sequence as one statement (theme → login → trust); pieced together from 02 §1.6, the
  quickstart and the security page (all 2026-09-20).
- Codex `docs/authentication.md` now only points to https://developers.openai.com/codex/auth (308 to
  learn.chatgpt.com); the summary of `codex login status` / precedence wording there is the fetch tool's paraphrase
  except for the bullet quotes in §2.1. `codex-rs/core/src/auth.rs`: 404 (moved into `codex-rs/login/src/auth/`).
- Gemini `packages/cli/src/ui/components/AuthDialog.tsx`: 404 (moved to `ui/auth/`, fetched there).
- opencode `/connect` docs page (`tui.mdx`) not fetched this pass; `/connect` = `opencode auth login` comes from
  https://opencode.ai/docs/providers/ (2026-09-20) and research 01 §2.7.
- OpenRouter `/api/v1/key` cost; Anthropic `/v1/models` cost (no pricing shown; treated as free listing calls).
- XDG Base Directory spec text is cited through research 09 §7 (fetched 2026-09-20 by that pass), not re-fetched here.
