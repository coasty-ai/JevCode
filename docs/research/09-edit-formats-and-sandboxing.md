# 09 — Edit formats and process sandboxing (macOS, no Docker)

Research date: 2026-09-19. Every claim carries its source URL and fetch date. Local experiments were run on this
machine (Darwin 25.6.0 = macOS 26.6.2 build 25G83 per `sw_vers`, `git version 2.50.1 (Apple Git-155)`, `patch 2.0-12u11-Apple`, Node `v22.23.2`) and are marked
LOCAL TEST. Anything not confirmed is marked UNVERIFIED.

## 0. Versions seen today

| Artifact | Version / value | Source (fetched 2026-09-19) |
|---|---|---|
| `ink` | `7.1.1`, MIT, `engines.node: ">=22"` | https://registry.npmjs.org/ink/latest |
| `@anthropic-ai/sandbox-runtime` | `0.0.77`, Apache-2.0, `engines.node: ">=20.11.0"`, bin `srt` | https://registry.npmjs.org/@anthropic-ai/sandbox-runtime/latest |
| `swebench` (PyPI) | `5.0.2`, `requires_python >=3.10` | https://pypi.org/pypi/swebench/json |
| Anthropic text editor tool | `type: "text_editor_20250728"`, `name: "str_replace_based_edit_tool"` (Claude 4+) | https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool |
| macOS `sandbox-exec` | man page header: "execute within a sandbox (DEPRECATED)", dated "March 9, 2017" | `man sandbox-exec` (LOCAL) |

## 1. Edit formats and measured reliability

### 1.1 Aider (the only public head-to-head benchmark of edit formats)

Aider's format catalogue (https://aider.chat/docs/more/edit-formats.html, fetched 2026-09-19):

| Format | Aider's description (quoted) | Who uses it |
|---|---|---|
| `whole` | "The LLM is instructed to return a full, updated copy of each source file that needs changes" ... "slow and costly because the LLM has to return the _entire file_" | weak models |
| `diff` | "the model only needs to return parts of the file which have changes" — SEARCH/REPLACE blocks with merge-conflict-style markers | **all Claude models** (see below) |
| `diff-fenced` | "the file path is placed inside the fence" — "primarily used with the Gemini family of models, which often fail to conform to the fencing approach specified in the diff format" | Gemini |
| `udiff` | "Based on the widely used unified diff format, but modified and simplified" — "mainly used to the GPT-4 Turbo family of models, because it reduced their 'lazy coding' tendencies" | GPT-4 Turbo era |
| `editor-diff` / `editor-whole` | "Streamlined versions ... intended to be used with `--editor-edit-format` when using architect mode" | editor role |

What Aider actually configures for Claude (https://raw.githubusercontent.com/Aider-AI/aider/main/aider/resources/model-settings.yml,
fetched 2026-09-19): every `claude-sonnet-4*`, `claude-opus-4*`, `claude-3-7-sonnet*`, `claude-sonnet-4-5*` entry has
`edit_format: diff`; the file has 289 `edit_format: diff` entries vs 35 `diff-fenced`, 4 `udiff`, 4 `whole`. No Claude
entry uses `udiff`. Claude entries also set `editor_edit_format: editor-diff` when used as an editor.

Polyglot leaderboard (https://aider.chat/docs/leaderboards/, page says "Last Updated: November 20, 2025", fetched 2026-09-19).
"Format accuracy" = percent of responses that used the edit format correctly:

| Model | Correct | Correct edit format | Format |
|---|---|---|---|
| claude-opus-4-20250514 (32k thinking) | 72.0% | 97.3% | diff |
| claude-sonnet-4-20250514 (32k thinking) | 61.3% | 97.3% | diff |
| claude-sonnet-4-20250514 (no thinking) | 56.4% | 98.2% | diff |
| claude-3-5-sonnet-20241022 | 51.6% | 99.6% | diff |
| gpt-5 (high) | 88.0% | 91.6% | diff |

Older code-editing leaderboard (https://aider.chat/docs/leaderboards/edit.html, "Last updated April 12, 2025", fetched 2026-09-19):
"Claude 3.5 Sonnet (latest)" 84.2% correct, 99.2% correct edit format, `diff`. Takeaway: Claude-class models emit
exact-match search/replace blocks correctly ~97-99.6% of the time; the residual 1-3% is what our retry path must absorb.

Lazy coding and udiff (https://aider.chat/2023/12/21/unified-diffs.html, fetched 2026-09-19): GPT-4 Turbo "scored 20% as a
baseline" with SEARCH/REPLACE and unified diffs "raised the score to 61%"; laziness ("…add logic here…" comments) dropped
from 12 tasks to 4. Design rules quoted: "FAMILIAR", "SIMPLE ... avoids escaping, syntactic overhead and brittle specifiers",
"HIGH LEVEL", "FLEXIBLE"; aider tells the model "not to include line numbers" and treats hunks as search-and-replace.
This was a GPT-4-Turbo-specific fix; Aider never moved Claude to udiff (model-settings.yml above).

Code inside JSON hurts (https://aider.chat/2024/08/14/code-in-json.html, fetched 2026-09-19): "LLMs are bad at returning code
in structured JSON responses"; Claude 3.5 Sonnet "suffered the worst harm from JSON wrapping"; "it seems premature to consider
switching from plain text to JSON-wrapped code at this time." Implication for JevCode: let the generator emit edits as
plain text blocks (or native tool_use with string params), not hand-rolled JSON containing code.

Architect/editor (https://aider.chat/2024/09/26/architect.html, fetched 2026-09-19): o1-preview architect + Sonnet editor
(diff) 82.7%; Sonnet architect + Sonnet editor 80.5% vs Sonnet solo 77.4%. Sonnet is a strong *editor* in `diff` format.

### 1.2 Anthropic text editor tool (the canonical str_replace spec)

Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool (fetched 2026-09-19).

| Date | Type | Note (quoted) |
|---|---|---|
| 2025-07-28 | `text_editor_20250728` | "fixes some issues and adds an optional `max_characters` parameter. It is otherwise identical to `text_editor_20250429`"; page also says "The tool type is `type: \"text_editor_20250728\"` for Claude 4 and later models." |
| 2025-04-29 | `text_editor_20250429` | "the text editor tool for Claude 4. This version removes the `undo_edit` command" ; name is `str_replace_based_edit_tool` |
| 2025-03-13 | `text_editor_20250124` | "optimized for Claude Sonnet 3.7 but has identical capabilities to the previous version" (tool name `str_replace_editor` — not stated on this page; inferred from the 2025-04-29 note "The tool name has been updated" and SWE-agent's `str_replace_editor` tool, which cites Anthropic's quickstart) |
| 2024-10-22 | `text_editor_20241022` | "Initial release of the text editor tool with Claude Sonnet 3.5 (retired ...)"; commands `view`, `create`, `str_replace`, `insert`, `undo_edit` |

Parameters (quoted): `view` → `path`, `view_range` ("two integers ... 1-indexed, and -1 for the end line means read to the
end of the file"); `str_replace` → `old_str` ("must match exactly, including whitespace and indentation"), `new_str`;
`create` → `file_text`; `insert` → `insert_line` ("0 for beginning of file"), `new_str`. The doc's example success result is
"Successfully replaced text at exactly one location." The `view` output has line numbers prepended ("1: def is_prime(n):").

### 1.3 SWE-agent `str_replace_editor` (reference implementation of the spec)

Config: https://raw.githubusercontent.com/SWE-agent/SWE-agent/main/tools/edit_anthropic/config.yaml (fetched 2026-09-19):
"The `old_str` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of
whitespaces!" and "If the `old_str` parameter is not unique in the file, the replacement will not be performed."
Implementation: https://raw.githubusercontent.com/SWE-agent/SWE-agent/main/tools/edit_anthropic/bin/str_replace_editor
(fetched 2026-09-19) uses `file_content.count(old_str)`; 0 → "No replacement was performed, old_str `{}` did not appear
verbatim in {}."; >1 → "No replacement was performed. Multiple occurrences of old_str `{}` in lines {}. Please ensure it
is unique"; equal strings → "old_str ... is the same as new_str". Copy these three error strings; they are what Claude has
been trained to recover from.

### 1.4 mini-swe-agent: bash-only (heredoc + sed)

https://raw.githubusercontent.com/SWE-agent/mini-swe-agent/main/README.md and
.../src/minisweagent/config/default.yaml (fetched 2026-09-19). "Does not have any tools other than bash — it doesn't even
need to use the tool-calling interface"; "Executes actions with `subprocess.run` — every action is completely independent".
The prompt teaches `cat <<'EOF' > newfile.py ... EOF` for creation and `sed -i 's/old/new/g' file` for edits, with a
Darwin special case: "You are on MacOS. For all the below examples, you need to use `sed -i ''` instead of `sed -i`."
README claims ">74% on the SWE-bench verified benchmark". Lesson: a `run` action alone is a viable editing path, but sed is
regex-based (escaping hazards) — we keep exact-match `edit` as the primary and allow heredoc/sed only via `run`.

### 1.5 OpenHands file editor and apply_patch

https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/openhands-tools/openhands/tools/file_editor/definition.py
(fetched 2026-09-19): commands `Literal["view", "create", "str_replace", "insert", "undo_edit"]`; rules quoted: "1. EXACT
MATCHING: The `old_str` parameter must match EXACTLY one or more consecutive lines ... The tool will fail if `old_str`
matches multiple locations"; "2. UNIQUENESS ... If not unique, the replacement will not be performed"; "3. REPLACEMENT ...
Both strings must be different." editor.py returns a snippet of the edited region (`SNIPPET_CONTEXT_WINDOW`) after each
edit — worth copying (cheap self-verification for the model). OpenHands also ships an `apply_patch` tool
(.../tools/apply_patch/definition.py, fetched 2026-09-19): "Input must start with '*** Begin Patch' and end with
'*** End Patch'." UNVERIFIED: the older monolithic-repo "LLM-based editing" (`edit_file` draft editor) — on 2026-09-19 the paths
`openhands/agenthub/codeact_agent/tools/{llm_based_edit.py,str_replace_editor.py,__init__.py}` and
`openhands/agenthub/codeact_agent/function_calling.py` all returned 404 on `main` of both `All-Hands-AI/OpenHands` and
`OpenHands/OpenHands` (SWE-agent's config.yaml still links the latter path, so it existed at some point). The SDK tool
directory (https://github.com/OpenHands/software-agent-sdk/tree/main/openhands-tools/openhands/tools, fetched 2026-09-19:
apply_patch, ask_oracle, browser_use, delegate, file_editor, gemini, glob, grep, planning_file_editor, preset, task,
task_tracker, terminal, tom_consult, utils, workflow) contains no LLM-rewrite editor.

### 1.6 Codex CLI `apply_patch` (V4A)

Grammar from https://raw.githubusercontent.com/openai/codex/main/codex-rs/apply-patch/src/parser.rs (fetched 2026-09-19):
`"*** Begin Patch" LF`, hunks `"*** Add File: " filename`, `"*** Delete File: " filename`, `"*** Update File: " filename`
optionally followed by `"*** Move to: " filename`, change context `("@@" | "@@ " /(.+)/)`, `"*** End of File"`, then
`"*** End Patch"`. Errors: "The first line of the patch must be '*** Begin Patch'" / "The last line ... '*** End Patch'".
Matching (`seek_sequence.rs`, fetched 2026-09-19): "Matches are attempted with decreasing strictness: exact match, then
ignoring trailing whitespace, then ignoring leading and trailing whitespace", plus a pass that normalises "common Unicode
punctuation to their ASCII equivalents". Name and rationale from OpenAI's GPT-4.1 prompting guide
(https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide, fetched 2026-09-19): "V4A diff format"; "we do not
use line numbers in this diff format, as the context is enough to uniquely identify code"; "By default, show 3 lines of
code immediately above and 3 lines immediately below each change"; "If 3 lines of context is insufficient ... use the @@
operator to indicate the class or function". UNVERIFIED: `codex-rs/apply-patch/apply_patch_tool_instructions.md` — 404 on 2026-09-19 at that path and at eight
guessed alternates (`codex-rs/prompts/templates/`, `codex-rs/core/prompt_with_apply_patch_instructions.md`,
`codex-rs/core/src/tools/`, `codex-rs/core/src/tools/handlers/`, `codex-rs/core/templates/`,
`codex-rs/core/templates/model_instructions/`, `codex-rs/tools/src/`, `codex-rs/apply-patch/src/`); GitHub directory
listings of `codex-rs/apply-patch` (only `src/`, `tests/`, `BUILD.bazel`, `Cargo.toml`), `codex-rs/core/src/tools` and
`codex-rs/core/templates/model_instructions` show no such file; the unauthenticated GitHub API was rate-limited and web
search indexes still point at the stale paths. The V4A grammar in `parser.rs` above is the authoritative source anyway.

### 1.7 Claude Code `Edit`

https://code.claude.com/docs/en/tools-reference.md (fetched 2026-09-19): "The Edit tool performs exact string replacement.
It takes an `old_string` and a `new_string` ... It doesn't use regex or fuzzy matching." "**Uniqueness**: `old_string` must
appear exactly once. When it appears more than once, Claude either supplies a longer string with enough surrounding context
to pin down one occurrence, or sets `replace_all: true`." Also: a stale `old_string` forces a re-read before editing
("requires Claude Code v2.1.208 or later" for the relaxed unread-file handling).

### 1.8 Recommendation for JevCode's action schema

Every production Claude harness (Anthropic tool, SWE-agent, OpenHands, Claude Code) converged on exact-match, unique
`old`/`new` replacement; Aider measures ~97-99.6% format compliance for Claude in the equivalent `diff` format; unified
diffs were a GPT-4-Turbo workaround. Proposed discriminated union (TypeScript):

```ts
type Action =
  | { kind: 'read';  file: string; range?: [start: number, end: number] }          // 1-indexed, end=-1 → EOF (mirrors view_range)
  | { kind: 'edit';  file: string; old: string; new: string; replaceAll?: boolean } // exact match; count must be 1 unless replaceAll
  | { kind: 'write'; file: string; content: string }                               // create/overwrite whole file
  | { kind: 'patch'; unifiedDiff: string }                                          // fallback: git apply --check first
  | { kind: 'run';   cmd: string; timeoutMs: number; maxOutputBytes?: number }
  | { kind: 'done';  summary: string };
```

| Action | Applier rule | Jev risk input | "patch fails to apply" test |
|---|---|---|---|
| `read` | reject paths outside workspace realpath; number lines like `cat -n` | ~0 (read-only) | n/a |
| `edit` | `count(old)`; 0 → SWE-agent error "did not appear verbatim"; >1 → "Multiple occurrences ... in lines N,M" + `replaceAll` hint; `old===new` → error; return ±4-line snippet | low; scales with `new.length`, path under `.git/`, `.env` | unit-test 0/1/n matches, CRLF, trailing-whitespace drift; re-run generator with the error text |
| `write` | create dirs; refuse if file exists and was not read this episode (Claude Code rule) | medium (whole-file overwrite, "lazy coding" truncation risk: check for "..." / "rest unchanged" markers) | compare size vs prior; flag >50% shrink |
| `patch` | `git apply --check` then `git apply`; never `--unsafe-paths` | medium-high (multi-file, silent hunk offset) | fixture patches with wrong context, `--unified=0`, `../` paths, symlink targets (section 2) |
| `run` | detached process group, timeout, byte cap, cwd = workspace | Jev scores `cmd` text (rm -rf, git push, curl | sh, sudo) | timeout and cap behaviour tested (section 3.4) |
| `done` | require clean `git diff --stat` summary in checkpoint | 0 | n/a |

Keep `edit` as the default the generator prompt teaches; `patch` exists only for the SWE-bench submission path (the harness
consumes a unified diff, produced by `git diff` on our side, not by the model).

## 2. Applying unified diffs with no dependencies

### 2.1 `git apply` flags (https://raw.githubusercontent.com/git/git/master/Documentation/git-apply.adoc, fetched 2026-09-19)

| Flag | Doc text (quoted) |
|---|---|
| `--check` | "Instead of applying the patch, see if the patch is applicable to the current working tree and/or the index file and detects errors. Turns off 'apply'." |
| `--3way` | "Attempt 3-way merge if the patch records the identity of blobs ... possibly leaving the conflict markers in the files ... implies the `--index` option ... incompatible with the `--reject` option." |
| `--reject` | "by default fails the whole patch and does not touch the working tree when some of the hunks do not apply. This option makes it apply the parts ... and leave the rejected hunks in corresponding `*.rej` files." |
| `--unidiff-zero` | "expects ... at least one line of context ... breaks down when applying a diff generated with `--unified=0`. To bypass these checks use `--unidiff-zero`." ("usage of context-free patches is discouraged") |
| `--recount` | "Do not trust the line counts in the hunk headers, but infer them by inspecting the patch" — useful for LLM-written hunks with wrong `@@ -a,b +c,d @@` counts. |
| `--directory=<root>` | "Prepend _<root>_ to all filenames. If a `-p` argument was also passed, it is applied before prepending the new root." |
| `--unsafe-paths` | "By default, a patch that affects outside the working area ... is rejected as a mistake (or a mischief)." "has no effect when `--index` or `--cached` is in use." |
| `--allow-empty` | "Don't return an error for patches containing no diff." |

Also: "Without these options [`--index`/`--cached`], the command applies the patch only to files, and does not require them to
be in a Git repository." So `git apply` works as a dependency-free patcher even in a non-repo tmp dir.

### 2.2 LOCAL TEST 2026-09-19 — path escapes (git 2.50.1 Apple Git-155)

| Patch target | Command | Result |
|---|---|---|
| `b/../outside/evil.txt` (inside repo) | `git apply --check` | `error: invalid path '../outside/evil.txt'`, exit 128 |
| same | `git apply --check --unsafe-paths` | exit 0 (would escape) — **never pass `--unsafe-paths`** |
| `/tmp/gatest/outside/abs.txt` (absolute path on the `+++` line) | `git apply` (default `-p1`) | exit 0 but **no escape**: git stripped the leading component and created `./tmp/gatest/outside/abs.txt` inside the repo; `/tmp/gatest/outside/` stayed empty. With `-p0`: `error: invalid path '/tmp/gatest/outside/abs.txt'`, exit 128 |
| `b/link/x.txt` where `link -> ../outside` (tracked symlink) | `git apply --check` | `error: affected file 'link/x.txt' is beyond a symbolic link`, exit 1 |
| `b/link2/y.txt` where `link2` is an untracked symlink | `git apply` | same error, exit 1, nothing written outside |
| `../outside/evil.txt` from a non-repo cwd | `git apply --check` | `error: invalid path`, exit 128; with `--unsafe-paths` exit 0 |

Conclusion: `git apply` (without `--unsafe-paths`) rejects `../`, absolute (`-p0`) and symlink-traversing paths, and
silently re-roots `-p1`-stripped absolute paths inside the tree (which creates junk directories rather than escaping).
JevCode should still parse `+++ `/`--- ` headers and reject absolute or `..` paths up front so the model gets a clear error
instead of a stray `tmp/...` directory. Prefer `edit`/`write` (which we validate ourselves) over `patch`.

### 2.3 macOS `patch` (BSD) — `man patch`, LOCAL 2026-09-19, `patch 2.0-12u11-Apple`

Quoted: "-C, --check, --dry-run  Checks that the patch would apply cleanly, but does not modify anything."; "-F max-fuzz,
--fuzz max-fuzz ... causes patch to ignore up to that many lines in looking for places to install a hunk. Note that a larger
fuzz factor increases the odds of a faulty patch. The default fuzz factor is 2"; "-t, --batch Similar to -f, in that it
suppresses questions"; "-p strip-count, --strip strip-count"; "-d directory, --directory directory". Rejected hunks go to
`*.rej`. BSD patch supports `--fuzz`, `--batch`, `--forward`, `-p1`, `-i` — the SWE-bench fallback line runs unchanged on
macOS. The man page also documents `-i patchfile, --input patchfile`, `-N, --forward`, and the GNU-style
`--no-backup-if-mismatch`. Caveat: the man page says the fuzz factor "may not be set to more than the number of lines of
context in the context diff, ordinarily 3", yet LOCAL TEST 2026-09-19 `patch --batch --forward --fuzz=5 -p1 -i p.diff` on a
3-line-context unified diff exited 0 and applied (also with one drifted context line, and with `--dry-run`), so `--fuzz=5`
is accepted (effectively clamped), not rejected.

### 2.4 SWE-bench harness apply strategy

https://raw.githubusercontent.com/SWE-bench/SWE-bench/main/swebench/harness/run_evaluation.py lines 54-59 (fetched 2026-09-19):

```python
GIT_APPLY_CMDS = [
    "git apply --verbose",
    "git apply --verbose --3way",
    "git apply --verbose --reject",
    "patch --batch --forward --fuzz=5 -p1 -i",
]
```

Between attempts the harness resets: `git checkout -- . ; git clean -fd` (comment: "a failed attempt (notably --reject)
leaves partial state behind"). Our SWE-bench runner should produce `git diff` output from a clean tree, then self-check with
`git apply --check` in a fresh checkout — if it applies with the first command locally, the harness will accept it.

## 3. Process sandboxing on macOS without Docker

### 3.1 `sandbox-exec` status and who uses it

`man sandbox-exec` (LOCAL 2026-09-19): "The sandbox-exec command is DEPRECATED. Developers who wish to sandbox an app should
instead adopt the App Sandbox feature". Options: `-f profile-file`, `-n profile-name`, `-p profile-string`, `-D key=value`.
Despite deprecation it still ships on Darwin 25.6.0 and is the basis of:

- Claude Code: "On macOS, there is nothing to install: sandboxing uses the built-in Seatbelt framework." Default write scope:
  "read and write access to the current working directory and its subdirectories, any directories you've added ... plus the
  session temp directory that `$TMPDIR` points to" (https://code.claude.com/docs/en/sandboxing.md, fetched 2026-09-19).
  Linux uses `bubblewrap` + `socat`; optional seccomp filter via `npm install -g @anthropic-ai/sandbox-runtime`.
- Codex CLI: "On macOS, sandboxing works out of the box using the built-in Seatbelt framework"; modes `read-only`,
  `workspace-write`, `danger-full-access` (https://learn.chatgpt.com/docs/sandboxing, redirect of
  developers.openai.com/codex/concepts/sandboxing, fetched 2026-09-19). Base policy:
  https://raw.githubusercontent.com/openai/codex/main/codex-rs/sandboxing/src/seatbelt_base_policy.sbpl (fetched 2026-09-19;
  note the path moved from `codex-rs/core/src/`): `(deny default)`, `(allow process-exec)`, `(allow process-fork)`,
  `(allow signal (target same-sandbox))`, `(allow process-info* (target same-sandbox))`, `/dev/null` write, an explicit
  `sysctl-read` allow-list (plus `sysctl-write kern.grade_cputype` for Java), `(allow pseudo-tty)`, `/dev/ptmx` and
  `/dev/ttys[0-9]+` rules, `(allow ipc-posix-sem)` ("Needed for python multiprocessing on MacOS for the SemLock") and a
  narrow POSIX shm rule for PyTorch/libomp. Writable roots are appended at runtime.
- Gemini CLI: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/cli/src/utils/sandbox-macos-permissive-open.sb
  (fetched 2026-09-19): `(deny default)`, `(allow file-read*)`, `(allow file-write* (subpath (param "TARGET_DIR"))
  (subpath (param "TMP_DIR")) (subpath (param "CACHE_DIR")) ... (literal "/dev/stdout") (literal "/dev/stderr")
  (literal "/dev/null") (literal "/dev/ptmx") (regex #"^/dev/ttys[0-9]*$"))`, `(allow network-outbound)`, explicit
  `mach-lookup` list for DNS/trustd, and — directly relevant to an Ink TUI — `(allow file-ioctl (regex #"^/dev/tty.*"))`
  under the two comment lines ";; enable terminal access required by ink" / ";; fixes setRawMode EPERM failure (at node:tty:81:24)". Docs
  (https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/sandbox.md, fetched 2026-09-19): profiles selected by
  `SEATBELT_PROFILE` (`permissive-open` default, `permissive-proxied`, `restrictive-open`, `restrictive-proxied`,
  `strict-open`, `strict-proxied`), enabled with `GEMINI_SANDBOX=sandbox-exec`; permissive-open "confines writes to the
  project directory while allowing broad file reads and network access."

### 3.2 A minimal write-confining policy (LOCAL TEST 2026-09-19, passed)

```scheme
(version 1)
(deny default)
(allow process-exec) (allow process-fork)
(allow file-read*)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup)
(allow file-write* (subpath (param "WS")))
(allow file-write* (subpath "/private/tmp") (subpath "/private/var/folders"))
(allow file-write-data (literal "/dev/null") (literal "/dev/tty"))
```

Invoked as `sandbox-exec -D WS="$(cd ws && pwd -P)" -f policy.sb /bin/sh -c '...'`. Results: write inside WS → exit 0;
`touch ~/Documents/.../escape` → "Operation not permitted", exit 1, file absent; `curl https://example.com` → "Could not
resolve host" (no `network-outbound`, so network is off by default); `python3` ran. Gotchas: `subpath` needs the *real*
path (`/private/tmp`, not `/tmp`), so always `fs.realpathSync` the workspace before `-D`; `$TMPDIR` on macOS lives under
`/private/var/folders`, which must be allowed or most toolchains fail; add Gemini's `file-ioctl` tty rule if a sandboxed
child must be interactive.

Limitations: deprecated and undocumented (profiles are reverse-engineered from Chromium/Apple; Codex and Gemini both cite
`source.chromium.org/.../sandbox/policy/mac/common.sb`); Apple may remove it; no per-domain network filter (only
allow/deny outbound, or a localhost proxy port as `srt` does); `.git/` inside the workspace is writable unless you add
`(deny file-write* (subpath ".../.git/hooks") (literal ".../.git/config"))` as Claude Code does ("`hooks` and `config` inside
`.git`" are denied, code.claude.com/docs/en/sandboxing.md, fetched 2026-09-19); processes can still read `~/.ssh` and
`.env` unless you add `deny file-read*` (Gemini denies `(regex #"/\.env($|\..*)")`). JevCode should at minimum deny reads
of its own `.env` and writes to `.git/hooks`.

### 3.3 Fallback without sandbox-exec: cwd confinement + timeout + output cap + process-group kill

Node semantics (https://nodejs.org/api/child_process.html, fetched 2026-09-19): "if `options.detached` is set to `true`,
the child process will be made the leader of a new process group and session"; `subprocess.kill()` signals only the direct
child ("On Linux, child processes of child processes will not be terminated when attempting to kill their parent. This is
likely to happen when running a new process in a shell or with the use of the `shell` option of `ChildProcess`" — the doc
says "On Linux", but the LOCAL TEST below shows the same on macOS); `timeout` ("**Default:** `undefined`") and `killSignal` ("**Default:** `'SIGTERM'`") exist on spawn;
`exec`/`execFile` `maxBuffer` "**Default:** `1024 * 1024`" and "If exceeded, the child process is terminated and any output
is truncated." Kill a whole group with `process.kill(-pid, 'SIGKILL')` (negative pid = group).

LOCAL TEST 2026-09-19 (Node v22.23.2): `spawn('/bin/sh', ['-c','sleep 300 & sleep 300 & wait'], {detached:true})` →
`pgrep -g <pid>` = 3 processes; `process.kill(-pid,'SIGKILL')` → 0 remaining. Output cap: `yes | head -c 50000000` with a
`data` listener counting bytes and killing the group at 1,000,000 → child ended with `signal SIGKILL` after 1,114,112 bytes
seen (one extra chunk arrives after the threshold; truncate the buffer to the cap before showing it to the model).

Recipe: `spawn(cmd, {cwd: workspaceRealPath, detached: true, stdio: ['ignore','pipe','pipe'], env: scrubbed})`; start
`setTimeout(() => process.kill(-child.pid, 'SIGKILL'), timeoutMs)`; on `data` accumulate up to `maxOutputBytes` then kill;
always `clearTimeout` on `close`. If `process.kill(-pid)` throws `ESRCH` the group is already gone. A `pkill -P <pid>` walk is
only needed if you did not use `detached` (children reparented to launchd are otherwise lost). Do **not** `unref()` — we
want to await exit. This fallback gives no filesystem confinement beyond `cwd`; Jev's risk score must be the guard.

### 3.4 `@anthropic-ai/sandbox-runtime` (srt)

npm (fetched 2026-09-19): `0.0.77`, Apache-2.0, `node >=20.11.0`, deps `zod ^3.24.1`, `commander ^12.1.0`,
`node-forge ^1.4.0`, `@pondwader/socks5-server ^1.0.10`. README (https://raw.githubusercontent.com/anthropic-experimental/sandbox-runtime/main/README.md,
fetched 2026-09-19): "uses native OS sandboxing primitives (`sandbox-exec` on macOS, `bubblewrap` on Linux) and proxy-based
network filtering"; "**Beta Research Preview** ... APIs and configuration formats may evolve"; settings file
`~/.srt-settings.json` with `filesystem.{denyRead,allowRead,allowWrite,denyWrite}` and `network.{allowedDomains,deniedDomains}`;
"Write (allow-only pattern): By default, write access is denied everywhere"; on macOS "The Seatbelt profile allows
communication only to a specific localhost port. The proxies listen on this port". Usable as CLI (`srt <cmd>`) or library
(`main: ./dist/index.js`). Claude Code docs: "wraps an entire process in the same Seatbelt or bubblewrap isolation that the
built-in Bash sandbox uses" (https://code.claude.com/docs/en/sandbox-environments.md, fetched 2026-09-19); Anthropic
reported "sandboxing safely reduces permission prompts by 84%" (https://www.anthropic.com/engineering/claude-code-sandboxing,
dated October 20, 2025, fetched 2026-09-19).

Trade-off for JevCode (zero deps beyond Ink): srt adds 4 runtime deps (zod, commander, node-forge, a SOCKS server), is
`0.0.x`/beta with a mutable config schema, and its main value over a hand-written `.sb` file is the domain-level network
proxy. Recommendation: do not depend on it; generate our own ~15-line Seatbelt profile (3.2) with `-D` params, keep network
either fully on or fully off per Jev decision, and document `srt` as an optional external wrapper
(`npx @anthropic-ai/sandbox-runtime jevcode ...`) for users who want domain allowlists.

## 4. Cancellation semantics (Ctrl-C, child groups, checkpoints)

- Ink (https://raw.githubusercontent.com/vadimdemedes/ink/master/readme.md, fetched 2026-09-19): `render()` option
  `exitOnCtrlC` — "Configure whether Ink should listen for Ctrl+C keyboard input and exit the app", default `true`; Ink puts
  stdin in raw mode ("you should use Ink's `setRawMode` instead of `process.stdin.setRawMode`"), which means **the kernel does
  not deliver SIGINT on Ctrl-C while the TUI is active** — Ink sees the `\x03` byte and calls exit. Use `useApp().exit(value)`
  and `instance.waitUntilExit()` (README: "`exit()` resolves with `undefined`", "`exit(error)` rejects when `error` is an
  `Error`", "`exit(value)` resolves with `value`"). Set `exitOnCtrlC: false` and handle
  Ctrl-C in `useInput` so we can run async cleanup (kill child group, write checkpoint) before unmounting.
- Node process events (https://nodejs.org/api/process.html, fetched 2026-09-19): "`'SIGTERM'` and `'SIGINT'` have default
  handlers on non-Windows platforms that reset the terminal mode before exiting with code `128 + signal number`. If one of
  these signals has a listener installed, its default behavior will be removed." `'exit'` listeners "**must** only perform
  **synchronous** operations". `'beforeExit'` "is emitted when Node.js empties its event loop" and is NOT emitted on
  `process.exit()` or uncaught exceptions — unsuitable for checkpointing. "`'SIGKILL'` cannot have a listener installed".
  Prefer setting `process.exitCode` over `process.exit()` because stdout writes "may occur over multiple ticks".
- Recipe: a single `shutdown(reason)` function, idempotent, invoked from (a) Ink `useInput` on Ctrl-C, (b)
  `process.once('SIGINT')` / `process.once('SIGTERM')` (covers `kill` from outside and non-TTY runs), and (c)
  `process.on('uncaughtException')`. It (1) sets a cancelled flag so the loop stops issuing new actions, (2)
  `process.kill(-childPid,'SIGTERM')`, then SIGKILL after ~2 s, (3) `await writeCheckpoint()` using
  `fs.promises.writeFile(tmp)` + `rename` (atomic), bounded by `Promise.race` with a 5 s timer, (4) restores the terminal via
  Ink unmount, (5) sets `process.exitCode = 130` and lets the loop drain. Also write a checkpoint synchronously with
  `fs.writeFileSync` in the `'exit'` handler as a last resort (sync-only is allowed there). A second Ctrl-C during shutdown
  should `process.exit(130)` immediately (escape hatch). When JevCode is itself run under `sandbox-exec`/`srt`, the
  Seatbelt profile must allow `(allow signal (target same-sandbox))` (Codex) or `(target self)` for the group kill to work.

## 5. Open items / UNVERIFIED

- Codex `apply_patch_tool_instructions.md` current location (404 at nine paths and absent from three GitHub directory
  listings on 2026-09-19; unauthenticated API rate-limited). Grammar is taken from `parser.rs` instead.
- OpenHands' legacy LLM-based `edit_file` tool (monolith paths 404 on both GitHub orgs; SDK tool directory has no such tool).
- Whether `sandbox-exec` will survive the next macOS major; no Apple statement found beyond the man page DEPRECATED notice.

## Verification log (2026-09-19)

Independent re-check by an adversarial pass on 2026-09-19. Every URL in this document was re-fetched (curl for raw
GitHub / registry JSON, page fetch for docs) and every LOCAL TEST was re-run on this machine.

Confirmed unchanged (no edit needed): `ink` 7.1.1 / MIT / node >=22; `@anthropic-ai/sandbox-runtime` 0.0.77 / Apache-2.0 /
node >=20.11.0 / bin `srt` -> `dist/cli.js` / deps zod ^3.24.1, commander ^12.1.0, node-forge ^1.4.0,
@pondwader/socks5-server ^1.0.10; `swebench` 5.0.2 / >=3.10; `text_editor_20250728` + `str_replace_based_edit_tool` and the
four dated versions (July 28 2025, April 29 2025, March 13 2025, October 22 2024); `sandbox-exec` man page "(DEPRECATED)",
"March 9, 2017"; aider model-settings.yml counts 289 diff / 35 diff-fenced / 4 udiff / 4 whole and every Claude 3.7/4/4.5/4.6/4.7
entry `edit_format: diff` (+ `editor_edit_format: editor-diff`); polyglot leaderboard "Last Updated: November 20, 2025" and
all five quoted rows (72.0/97.3, 61.3/97.3, 56.4/98.2, 51.6/99.6, gpt-5 high 88.0/91.6); edit leaderboard "April 12, 2025",
84.2%/99.2%; unified-diffs post 20% -> 61%, 12 -> 4 lazy tasks; code-in-json quotes; architect post 82.7/80.5/77.4;
GPT-4.1 guide V4A quotes; SWE-agent error strings (lines 526, 532, 537 of `str_replace_editor`) and config.yaml quotes;
mini-swe-agent ">74%", `subprocess.run`, `sed -i ''` Darwin note; OpenHands SDK `file_editor` rules and `apply_patch`
"Input must start with '*** Begin Patch' and end with '*** End Patch'."; Codex `parser.rs` markers and error strings,
`seek_sequence.rs` strictness ladder + Unicode-punctuation pass; `seatbelt_base_policy.sbpl` at `codex-rs/sandboxing/src/`
(old `codex-rs/core/src/` path 404); Gemini `sandbox-macos-permissive-open.sb` rules (file-write* list, network-outbound,
mach-lookup list, `.env` read/write deny, file-ioctl tty rule) and docs (six `SEATBELT_PROFILE` values, `permissive-open`
default, `GEMINI_SANDBOX=sandbox-exec`); SWE-bench `GIT_APPLY_CMDS` at lines 54-58 (list closes line 59), reset command and
comment at lines 303-306; all eight `git apply` flag quotes and the "does not require them to be in a Git repository"
sentence; Claude Code tools-reference Edit quotes incl. "v2.1.208"; sandboxing.md default write scope, `.git` `hooks`/`config`
deny, bubblewrap + socat, optional seccomp via `npm install -g @anthropic-ai/sandbox-runtime`; sandbox-environments.md
"wraps an entire process in the same Seatbelt or bubblewrap isolation that the built-in Bash sandbox uses"; Anthropic blog
dated October 20, 2025, "reduces permission prompts by 84%"; Codex sandboxing doc (developers.openai.com 308 ->
learn.chatgpt.com/docs/sandboxing) Seatbelt sentence and three modes; Node child_process/process quotes (detached group
leader, maxBuffer 1024*1024, killSignal SIGTERM, SIGINT/SIGTERM default handler removal, sync-only `exit`, `beforeExit`
not on `process.exit()`, SIGKILL no listener, multiple-ticks); Ink `exitOnCtrlC` default true and `setRawMode` sentence.

LOCAL TESTS re-run 2026-09-19 with identical results: `git apply` `../` -> "invalid path" exit 128, `--unsafe-paths` exit 0,
absolute `+++` path with `-p1` re-rooted to `./tmp/gatest/outside/abs.txt` inside the repo (outside dir stayed empty), `-p0`
-> exit 128, tracked and untracked symlink -> "is beyond a symbolic link" exit 1, non-repo cwd same; 10-line Seatbelt profile
-> WS write ok, `~/Documents` write "Operation not permitted" exit 1, curl "Could not resolve host", python3 ran. Realpath rule confirmed
directly: with `-D WS=/tmp/wslink` (a symlink to `~/sbws_test`) writes to `~/sbws_test/a.txt` and `/tmp/wslink/b.txt` were both
"Operation not permitted" (exit 1); with `-D WS="$(pwd -P)"` the same write exited 0. Node v22.23.2 group kill 3 -> 0, byte cap
fired at 1,114,112 bytes for a 1,000,000 cap.

Corrections made:
1. Header: added the `sw_vers` product version (macOS 26.6.2, build 25G83) next to Darwin 25.6.0.
2. 1.2: the `str_replace_editor` name for `text_editor_20250124` is not stated on the Anthropic page; marked as inferred.
   Expanded the 2025-07-28 and 2024-10-22 quotes to the page's actual wording ("fixes some issues and adds ...", "Initial
   release ... with Claude Sonnet 3.5 (retired ...)").
3. 1.5: replaced the vague OpenHands UNVERIFIED note with the exact paths tried (404 on both GitHub orgs) and the verified SDK
   tool directory listing.
4. 1.6 and 5: Codex `apply_patch_tool_instructions.md` still UNVERIFIED; recorded nine 404 paths and three directory
   listings that do not contain it.
5. 2.3: rewrote a garbled sentence about `-i`/`--dry-run`/`--no-backup-if-mismatch`; added the man page's "may not be set to
   more than ... ordinarily 3" fuzz caveat plus a LOCAL TEST showing `--fuzz=5` is nevertheless accepted (exit 0).
6. 3.1: Codex base policy summary corrected — added `process-info*`, `sysctl-write kern.grade_cputype`; POSIX sem is for
   Python multiprocessing, the shm rule is for PyTorch/libomp (not "sem/shm for Python multiprocessing").
7. 3.1: Gemini `file-ioctl` comment quoted as its two actual lines including "(at node:tty:81:24)".
8. 3.3: Node "child processes of child processes" quote restored to the doc's wording, including its "On Linux" qualifier.
9. 4: Ink `waitUntilExit` quote corrected to the README's three bullet phrasings.

Refuted: none of the numeric/version claims were wrong. Still unverified: Codex instructions-file location; OpenHands
legacy `edit_file` tool history; Apple's plans for `sandbox-exec` beyond the man-page notice.
