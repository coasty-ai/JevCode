# Sandbox and security guarantees

A coding agent runs commands you did not type. This page states exactly what a command can and
cannot do, what a file action can and cannot touch, and what JevCode's own git calls are
protected against.

Two things are worth reading even if you skip the rest: **no API key is ever in a command's
environment**, and **no configured secret reaches any file JevCode writes**.

## Every command, on every platform

A command runs through `/bin/sh -c`, in a **detached process group**, with:

- **the working directory fixed** to the workspace;
- **a scrubbed environment**: exactly four variables are carried over from your shell — `PATH`,
  `LANG`, `LC_ALL`, `TERM` — and `PATH` falls back to a standard list if it was unset. `HOME`
  and `TMPDIR` are remapped into the run directory. When the workspace has a Python virtual
  environment, `VIRTUAL_ENV` is set and its `bin` is prepended to `PATH`, which is the same
  effect as activating it. Nothing else is inherited, and no key is in it;
- **a timeout**: 120 s by default, 600 s at most, and always clamped to the remaining wall-time
  budget;
- **an output cap**: a 200 KB head shared across both streams plus a rolling 16 KB tail per
  stream, so the final lines — which is where a test summary lives — survive a flood.
  Exceeding the cap never kills the command; the result records that it was truncated;
- **a three-pass tree kill** on timeout, cancellation, interrupt or termination.

<!-- src/sandbox/run.ts:1-9, :24-35, :112-127, :257, :277 -->

### The tree kill, in detail

Because the shell is its own process group, a signal to the negated group id reaches ordinary
descendants. Anything that deliberately started a new session escapes that group, so a process
snapshot is taken from the harness — never from inside the sandbox profile, where the process
listing tool cannot execute — and the descendant graph is walked from the root, unioning every
process whose group is the root's.

The passes are: snapshot, terminate, wait a grace period, kill. Whatever survives is returned as
**orphans** rather than quietly dropped, so both the transcript and the decider see it.

<!-- src/sandbox/kill.ts:1-10 -->

## On macOS: the profile

Where the system sandbox tool is present, the command additionally runs under a generated
profile. The base is permissive and the denials are specific, because a deny-everything base
breaks ordinary toolchains.

Writes are denied everywhere **except**:

- the workspace;
- the run's own temporary and home directories;
- terminal devices;
- for a linked worktree or a subdirectory workspace, the repository's git directory when it
  lies outside the workspace.

Inside those, four things are still write-denied: the repository's `config`, its `hooks`
directory, and a worktree-local config file. A delegated child gets a stricter profile again
that also denies moving references, rewriting the reference log, repacking packed references
and repointing another worktree's head — because the landing layer pins a commit once and
re-checks that same commit at merge time, and a child able to move a reference in between would
defeat the check.

Reads are denied for JevCode's own secret stores, its configuration directories, `~/.ssh`,
`~/.aws`, `~/.config/gh` and `~/.netrc`. Under the JevCode home — every run's checkpoints and
the benchmark work areas — file contents are unreadable except inside the run's own temporary
and home directories, while directory metadata stays readable so tools can traverse.

`--no-network` denies all network access.

Every path is canonicalised before it enters the profile, because the matcher works on kernel
paths and a symlinked prefix would otherwise silently deny everything beneath it. Later rules
win, so the specific denials sit after the workspace allowance.

<!-- src/sandbox/seatbelt.ts:1-9, :83-84, :44-62 -->

### The four named limits

The sandbox tool used here is deprecated by its vendor, and it is the same mechanism several
other coding agents use. Its limits are known, named, and not worked around:

1. **Reads elsewhere are allowed.** The profile denies writes broadly and reads narrowly.
2. **SSH-based git remotes fail** inside the profile. Use HTTPS remotes.
3. **A few platform binaries refuse to execute** under any profile. That is detected and
   reported as such rather than surfacing as a mysterious failure.
4. **A process that double-forks before the snapshot can escape the tree kill.**

Where the tool is unavailable the level degrades to `none` — working directory, environment
scrubbing, timeout, output cap and tree kill only, with the repository's config and hooks
writable by commands — and `jevcode config` says so in its footer rather than leaving you to
infer it.

<!-- src/sandbox/seatbelt.ts:275-278 detectSandboxLevel; src/cli/config-table.ts:53-56 SANDBOX_FOOTER -->

## File actions never touch the sandbox

Reading, writing, editing and patching files are not commands, and they do not go through the
sandbox at all. They go through a path resolver instead:

- every path is resolved inside the real workspace, with symlinks followed and re-checked;
- `..` traversal and absolute escapes are rejected;
- nothing under the git directory is ever written;
- files recognised as secret stores are never read;
- an edit must match its target text **exactly once**, or it fails rather than guessing;
- writes are atomic;
- a unified diff goes through a validation pass before it is applied — and never with the flags
  that would let it write outside the tree, merge with three-way fallback, or leave partial
  results.

<!-- src/workspace/edit.ts:24-28; src/workspace/patch.ts:14, :169-196; src/workspace/git.ts:211 -->

## JevCode's own git calls

A command can write to the workspace, and the workspace contains `.git/config`. A later
ordinary status or diff would then execute whatever was planted there, with the harness's
environment. So every git call the harness makes runs with:

| Setting | Value |
| --- | --- |
| `GIT_CONFIG_NOSYSTEM` | `1` |
| `GIT_CONFIG_GLOBAL` | `/dev/null` |
| `GIT_TERMINAL_PROMPT` | `0` |
| `GIT_OPTIONAL_LOCKS` | `0` |
| `LC_ALL` | `C` |
| `core.fsmonitor` | `false` |
| `core.hooksPath` | `/dev/null` |
| `core.pager` | `cat` |
| `core.sshCommand` | empty |
| `credential.helper` | empty |
| `diff.external` | empty |
| `color.ui` | `false` |

Git's output is treated as untrusted text: bounded and parsed defensively.

There is one deliberate exception. Two read-only probes run at the very start, before the
sandbox exists, because the profile needs their answers to be built. They run with exactly the
same flags and environment, so the second defence covers them even though the first cannot.

<!-- src/workspace/git.ts:1-13, :28-44 -->

## Redaction

Two layers, applied to every string that leaves the process.

**Exact secrets.** Every configured key — from a flag, a variable, a `.env` file or the
configuration file — is registered with the name of the setting it came from. Any occurrence is
replaced by a marker naming that setting, never the value. A key discovered later, such as one
returned by a sign-in flow, is added to the same set.

**Format patterns.** Seventeen recognised key shapes are matched by format. Eight redact
automatically: OpenRouter, Anthropic, the `sk-` prefix family, Google, GitHub tokens in two
forms, xAI and Fireworks. Nine warn without masking automatically: AWS, Slack in two forms, PEM
blocks, JSON web tokens, Stripe, npm, Hugging Face and GitLab.

There is deliberately **no generic long-token rule**. Forty-character commit hashes, package
integrity hashes and base64 blobs are ordinary output for a coding agent and must survive
intact. A value shorter than eight characters is never registered as an exact secret either.

Everything the checkpoint store serialises passes a deep redaction over string leaves before it
is written, so a secret cannot reach disk through any artefact — not the state file, not a log,
not the transcript, not a step record. The same rule holds for the coordination ledger's
records.

<!-- src/core/redact.ts:1-10, :53, :294-315; src/checkpoint/store.ts:6-8 -->

## The no-secrets-in-any-artefact rule

Stated as one sentence, because it is the guarantee the rest of this page exists to support:

> No configured secret, and no recognised key format, appears in any file JevCode writes, in any
> line it prints, in any request it makes to the decider, or in any support bundle it assembles.

Four consequences follow that you can check yourself:

- the run metadata stores the resolved configuration with every secret replaced by a hash
  fingerprint, and `jevcode config` prints the same fingerprint rather than the value;
- the support bundle passes every copied file through the redactor, includes decider request
  bodies only when you ask, and **sends nothing anywhere** — it writes a directory;
- the machine-readable event stream never contains keystrokes, composer drafts, pasted payloads
  or key material;
- the import engine's value module never retains a substring of a candidate secret, so a
  credential cannot travel even as a prefix.

<!-- src/core/types.ts:1472-1473; src/cli/report.ts:1-7; src/cli/json-stream.ts:10-13;
     src/import/secrets.ts:1-13 -->

## Who approves a command: autonomy

The sandbox above applies to every command in every mode. Whether a human is asked first is the
`autonomy` setting (`--autonomy full|review`, `JEVCODE_AUTONOMY`, `autonomy` in the config file).

**In the default mode, `agent`,** a pure-code classifier (`src/agent/safety.ts`, no model involved)
sorts each command the model sends into `readonly`, `safe`, `destructive` or `unknown`. A
`readonly` command (`ls`, `cat`, `rg`, `git diff`, …, with no output redirect but `/dev/null`)
joins the parallel read batch and takes no pre-images; everything else takes pre-images of what it
may change before it runs.

- **`full` (the default) never asks and never refuses.** Every command runs. A command that
  matches one of the 13 destructive rules — `privilege`, `rm_outside`, `git_discard`,
  `force_push`, `history_rewrite`, `disk`, `fork_bomb`, `remote_exec`, `system_power`,
  `publish`, `exfiltrate`, `outside_write`, `git_internals` — runs too, and its step carries one
  truthful line, `destructive · ran <command> (rule <id>) — …`, ending in one of:
  - `this left the machine; /undo cannot reverse it` — a push, a publish, an upload, a download
    piped into a shell;
  - `/undo restores the workspace` — only for discarding workspace files when every dirty file
    was captured, both images are whole and `HEAD` did not move;
  - `/undo may not restore this` — everything else, because the sandbox and the pre-images
    contain only local workspace effects. On Linux there is no OS profile at all.
- **`review`** shows a y/n card before every destructive or unrecognised command. The card of a
  destructive command is titled with its rule's sentence. A declined command goes back to the
  model as a tool result; five declined destructive cards in one run pause it. Without a
  terminal the card is declined.

Validation that is not an approval holds under both: a path outside the workspace, a secret path
and an edit into `.git/` are errors returned to the model, and nothing runs. The model's system
prompt also asks it not to run destructive commands the task does not need.

**In the legacy modes** the risk stage decides instead: under `full` a review-level verdict is
approved and logged as `[review] auto-approved`, and a block verdict stops the action; under
`review` the card appears. See [Jev routes, never gates](../concepts/jev-routes-never-gates.md).

## What is still on you

- **Reads outside the workspace are allowed.** A command can read files you can read, minus the
  denied set above. Do not run JevCode as a user who can read something you would not want a
  command to read.
- **The degraded level is real.** On a system without the sandbox tool, only the working
  directory, environment scrubbing, timeout, cap and tree kill apply. Check the footer of
  `jevcode config`.
- **Network is allowed unless you deny it.** Pass `--no-network` when the task does not need it.

## Related pages

- [Configuration](configuration.md) — the `sandbox` and `noNetwork` settings.
- [Every JEVCODE_* switch](environment.md) — the four-variable environment a command sees.
- [Import](../architecture/import.md) — the same redaction rule applied to other tools' files.
- [What a run writes](records.md) — every artefact the redactor covers.
