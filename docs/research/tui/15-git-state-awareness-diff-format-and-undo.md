# 15 — Git state awareness, `/diff` format and `/undo` safety

Research note for the JevCode session TUI (gap-fill topic for 00-SUMMARY §8 item 7 and open question P9).
Written 2026-09-20. Every claim carries its source and the fetch date; measurements were made on this
machine (Apple Silicon, macOS 26 / Darwin 25.6.0, Node 22.23.2, `git version 2.50.1 (Apple Git-155)`) on a
rebuild of the `perf/step-overhead` fixture (70 × 72 `src/pkgN/modM.py` files, 50 × 100 ignored
`node_modules` files, one commit → 5,041 tracked paths) under `/tmp/jev-git15/` (scripts `build.mjs`,
`measure.mjs`, `measure2.mjs`, `watch.mjs`). Nothing in the repo was modified.

## 0. Why this note exists (the gap, restated against the code)

- A57 / 10 §15.7 make `/undo` restore pre-images and run `git checkout -- <path>` for `run` steps *without
  comparing the file's current content to what the step left behind*. If the user (or a later step) edited the
  file after step N, `/undo N` silently destroys that edit. Undoing step N when step N+1 touched the same file is
  unaddressed.
- `isRepo()` (`src/workspace/git.ts:85`) already distinguishes non-git workspaces, and `createWorkspace()`
  (`src/workspace/files.ts`) then skips every porcelain call — so in a non-git workspace `run`-step changes are
  invisible to `changedFiles()` (only file actions are tracked through `touched`) and the `/diff` specified as
  `git diff --stat` (10 §15.9) cannot run. No research file says what the TUI shows in that case.
- `createWorkspace()` already spawns `git status --porcelain=v1 --untracked-files=all -z` once at run start to build
  `snapshotDirty` (files.ts, "Snapshot for changedFiles()"), but that information is never shown to the human. There is
  no run-start dirty-tree notice and the status line (A46) has no git zone, although Gemini shows the branch with
  an `fs.watch` on the git dir (03 §7) and Claude Code / Codex pickers show a branch (10 §3.2).
- `/diff` rendering (unified vs stat, colour-blind-safe signs, untracked, binary, truncation) is 00-SUMMARY gap 7.
- Seatbelt: DESIGN §8 denies writes to `<ws>/.git/config` and `<ws>/.git/hooks` and allows `<ws>` — which is the
  wrong shape for a linked worktree, where the index and HEAD live *outside* `<ws>` (measured §5 below).

## 1. What the harness has today (read 2026-09-20)

| Fact | Where |
| --- | --- |
| Every harness git call goes through `runGit(sandbox, ws, args)`: `git <GIT_BASE_FLAGS> [--no-optional-locks if status] <sub> [--no-ext-diff --no-textconv if diff] <args>` under `GIT_ENV = { GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null', GIT_TERMINAL_PROMPT:'0', GIT_OPTIONAL_LOCKS:'0', LC_ALL:'C' }`, through `sandbox.run()` (scrubbed env, seatbelt when active) | `src/workspace/git.ts:24-84` |
| `GIT_BASE_FLAGS` = `-c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.pager=cat -c core.sshCommand= -c credential.helper= -c diff.external= -c color.ui=false` | `git.ts:32-40` |
| `--no-optional-locks` is placed **before** the subcommand (`extraFlags`) — correct: it is a global `git` option, and `git status --no-optional-locks` is `error: unknown option` (probe, the reference machine) | `git.ts:58-61, 73` |
| Helpers: `isRepo` (`rev-parse --is-inside-work-tree`), `gitDir` (`rev-parse --git-dir`), `showPrefix`, `topLevel`, `lsFiles` (drops modes `120000` and `160000`), `statusPorcelain` (v1, renames carry `from`), `lsFilesTracked`, `applyCheck`/`apply`, `diffAgainst` (bench: `add -A -N` then `diff --binary <base>`) | `git.ts:85-218` |
| `createWorkspace()` at run start: `isRepo` → `showPrefix` → `gitDir` → `statusPorcelain` = **4 serial git spawns** before the first step; `snapshotDirty` holds the pre-run porcelain paths; `statusEntries`/`statusCache` refreshed only by `invalidateCandidates()` after a `run` outcome; `touched` is the non-git source of truth | `files.ts:100-190, 243-258` |
| `Workspace.target()` → `TargetInfo { existsBefore, tracked, createdThisRun, recoverable: tracked \|\| created }` | `files.ts:307-320`, `src/core/types.ts:497-503` |
| `ActionOutcome.executed.changedFiles: string[]`; `CheckpointState.createdThisRun: string[]`; `StepRecord` has no per-file hashes | `types.ts:100-107, 275-299, 624` |
| Edits are atomic (`writeFileAtomic`, mode preserved); patches go through `git apply --check` then `git apply` (all-or-nothing) | `src/workspace/edit.ts`, `src/workspace/patch.ts` |
| Seatbelt profile: `(allow file-write* (subpath <ws>) ...)` then `(deny file-write* (literal <ws>/.git/config) (subpath <ws>/.git/hooks))`; `protectGit?: boolean` toggles the deny block | `src/sandbox/seatbelt.ts:33, 58-72` |
| `EngineEvent` has no workspace/git event; `RunMeta` has no git fields; `WorkspaceInfo = { root, git, hasTests, testCommand }` | `types.ts:491-496, 651-665, 806-839` |
| `Confirmer.confirm(req, { signal })` is the only yes/no primitive; `plain.ts` has `createReadlineConfirmer`, `headerItem`, `formatTranscriptItem` | `types.ts:425-436`, `src/tui/plain.ts:297-447` |
| Budgets: first frame < 300 ms, harness overhead p95 < 50 ms per step, event-loop lag p95 < 5 ms | `docs/DESIGN.md` §12 |

## 2. What the reference tools do

### 2.1 Claude Code — checkpointing, `/rewind`, `/diff`

- "checkpointing automatically captures the state of your code before each prompt you send that starts a turn";
  "Claude Code keeps file snapshots for the 100 most recent checkpoints in a session"; menu "**Restore code and
  conversation** … **Restore conversation** … **Restore code** … **Summarize from here** … **Summarize up to here**
  … **Never mind**"; "The two code restore options appear only when the selected checkpoint has tracked file changes
  to revert." (https://code.claude.com/docs/en/checkpointing, fetched 2026-09-20)
- Boundary: "Checkpointing does not track files modified by Bash commands. For example, if Claude Code runs: `rm
  file.txt` / `mv old.txt new.txt` / `cp source.txt dest.txt` … These file modifications cannot be undone through
  rewind." Also: "Manual changes you make to files outside of Claude Code and edits from other concurrent sessions are
  normally not captured, unless they happen to modify the same files as the current session." — i.e. **the restore
  overwrites whatever is there**; there is no modified-since check in the docs. (same page)
- Skips: "Claude Code skips any tracked path that is a symlink or hard link and shows a `Restored the code, but
  skipped N files` warning. The skipped files keep their current contents." Error reference lists the skip reasons
  "Backup missing — the file wasn't backed up before the changes" and "File could not be updated — Claude Code couldn't
  write to the file during restoration", and a total-failure message "No files were restored"
  (https://code.claude.com/docs/en/errors, fetched 2026-09-20). "Not a replacement for version control" (checkpointing page).
- `/diff`: "Its **Current** view shows your uncommitted changes from git, or, when there are none, what your branch
  adds on top of the default branch. The viewer also has a turn view for each prompt after which Claude edited files,
  showing just those edits. Claude Code builds the turn views from Claude's file edits rather than from git, so a
  change Claude makes through a shell command appears only under Current." and "In the changes `/diff` reads from git,
  a submodule appears as a single entry, and only when the commit it points to changes; edits to files inside the
  submodule don't appear there." Keys: "**Enter**: open the selected file's diff. Scroll it with Up and Down, or PageUp
  and PageDown. **Esc**: return from a file's diff to the list, or close the viewer from the list." The panel "lists the
  changed files with their added and removed line counts"; `Ctrl+X B` cycles "this session's changes, … your
  uncommitted changes as one list, … everything since your branch split from the default branch"
  (https://code.claude.com/docs/en/interactive-mode "Review changes with /diff", fetched 2026-09-20).

### 2.2 Codex — `/diff` and the retired ghost snapshots

- `slash_command.rs:109`: `SlashCommand::Diff => "show git diff (including untracked files)"`
  (https://raw.githubusercontent.com/openai/codex/main/codex-rs/tui/src/slash_command.rs, fetched 2026-09-20).
- `get_git_diff.rs` L1–6 doc: "returns the diff for tracked changes as well as any untracked files. When the current
  directory is not inside a Git repository, the function returns `Ok((false, String::new()))`." Tracked: `["diff",
  "--no-textconv", "--no-ext-diff", "--submodule=short", "--ignore-submodules=dirty", "--color"]` (L73–78);
  untracked: `["ls-files", "--others", "--exclude-standard"]` (L85) then per file `["diff", …, "--color",
  "--no-index", "--", null_device, file]` with `null_device` = `/dev/null` (`NUL` on Windows, L92–112); config
  overrides `core.hooksPath=/dev/null` (L20–22) plus filter-driver neutralisation (`diff_filter_config_overrides`,
  L165); `DIFF_COMMAND_TIMEOUT = 30 s` (L18); repo check `["rev-parse", "--is-inside-work-tree"]` (L221)
  (https://raw.githubusercontent.com/openai/codex/main/codex-rs/tui/src/get_git_diff.rs, fetched 2026-09-20).
- `config/mod.rs`: "/// Compatibility-only config retained so legacy `ghost_snapshot` settings / /// continue to load
  even though snapshots are no longer produced." with `ignore_large_untracked_files: Option<i64>` (default `10 * 1024
  * 1024`), `ignore_large_untracked_dirs: Option<i64>` (default `200`), `disable_warnings: bool`
  (https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/config/mod.rs, fetched 2026-09-20). Codex
  **removed** whole-tree snapshots; its undo is conversation-level backtrack/fork (04 §9, 10 §6).

### 2.3 opencode — shadow snapshot repo

- `snapshot/index.ts`: `const prune = "7.days"` (L23), `const limit = 2 * 1024 * 1024` (L24, untracked files above it
  are excluded via the snapshot repo's `info/exclude`, L172–184, 287); snapshot repo configured with `core.fsmonitor
  false`, `feature.manyFiles true`, `index.version 4`, `core.untrackedCache true` (L331–336), env `GIT_DIR: state.gitdir,
  GIT_WORK_TREE: state.worktree` (L326), objects alternated to the source repo "on huge repos like chromium" (L196–224);
  `track()` = `add --all --sparse --pathspec-from-file=-` + `write-tree` (L149, 341); `restore()` = `read-tree
  <snapshot>` + `checkout-index -a -f` (L386–388); `revert()` = `checkout <hash> -- <file>` per file with batched
  `ls-tree`, and "file did not exist in snapshot, deleting" (L427–441, 516); `if (state.vcs !== "git") return false`
  (L168) — **no snapshots outside git** (https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/snapshot/index.ts,
  fetched 2026-09-20).
- `session/revert.ts`: `assertNotBusy` (L39), `rev.snapshot = session.revert?.snapshot ?? (yield* snap.track())`,
  `snap.restore(...)`, `snap.revert(patches)`, `rev.diff = yield* snap.diff(rev.snapshot)` (L70–73); no
  modified-since check either (https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/revert.ts,
  fetched 2026-09-20).

### 2.4 Gemini CLI — branch watcher and `/restore`

- `useGitBranchName.ts` (94 lines): `git rev-parse --abbrev-ref HEAD`; `if (branch && branch !== 'HEAD')` else
  `git rev-parse --short HEAD` (L18–33); `fs.watch(gitDir, (eventType, filename) => { if (!filename || filename ===
  'HEAD') { … setTimeout(() => { void fetchBranchName(); }, 100); } })` (L54–68) — it watches the **git directory**
  and filters on `HEAD`, with the comment "On some platforms filename may be null, so we refresh in that case too";
  errors "Silently ignore[d] … The branch name will simply not update automatically" (L75–79); cleanup `cancelled =
  true; clearTimeout; watcher?.close()` (L84–90)
  (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/cli/src/ui/hooks/useGitBranchName.ts, fetched 2026-09-20).
- `/restore`: shadow repo at `~/.gemini/history/<project_hash>`, `restore --source <hash> .`, off by default (03 §15,
  https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/checkpointing.md, fetched 2026-09-20 per 03).

### 2.5 aider — dirty commits

- "Aider takes special care before editing files that already have uncommitted changes (dirty files). Aider will first
  commit any preexisting changes with a descriptive commit message." `--no-dirty-commits` will "stop aider from
  committing dirty files before applying its edits"; `--no-auto-commits` … "stop aider from git committing each of its
  changes"; "Aider works best with code that is part of a git repo" and it "asks to create a git repo if you launch it
  in a directory without one" (https://aider.chat/docs/git.html, fetched 2026-09-20). Options page: `--dirty-commits`
  "Enable/disable commits when repo is found dirty (default: True)"; `--auto-commits` "Enable/disable auto commit of LLM
  changes (default: True)"; `--git` "Enable/disable looking for a git repo (default: True)"; `--show-diffs` "Show diffs
  when committing changes (default: False)" (https://aider.chat/docs/config/options.html, fetched 2026-09-20). aider's
  `/undo` is "Undo the last git commit if done by aider" (05 §2) — it works because *every* change is a commit.

## 3. Git facts that constrain the design (installed git 2.50.1 manpages via `man`, and probes, 2026-09-20)

1. **`git stash create`**: "Create a stash entry (which is a regular commit object) and return its object name, without
   storing it anywhere in the ref namespace. This is intended to be useful for scripts." (`git-stash(1)`). Probe: on a
   clean tree it prints nothing and exits 0 (32.6 ms); it **does not include untracked files** (`git show --stat` of the
   stash listed only the 3 tracked files while an untracked file existed); it wrote **12 loose objects for 3 modified
   files** (`.git/objects` 5,114 → 5,126); on an unborn repository: `You do not have the initial commit yet`, exit 1. It
   worked with no user identity under `GIT_CONFIG_GLOBAL=/dev/null`.
2. **`git checkout -- <path>` restores from the INDEX, not HEAD**: "When the <tree-ish> (most often a commit) is not
   given, overwrite working tree with the contents in the index." (`git-checkout(1)`). Probe: after `git add
   src/pkg1/mod1.py` (staged `# dirty`), `checkout -- src/pkg1/mod1.py` left `# dirty` in place; `git restore
   --source=HEAD --worktree -- src/pkg1/mod1.py` restored `VALUE = 1`. `git-restore(1)`: "-s <tree>, --source=<tree>
   Restore the working tree files with the content from the given tree." and "-W, --worktree, -S, --staged Specify the
   restore location. If neither option is specified, by default the working tree is restored." Probe: `git restore
   --source=<stash-create-sha> --worktree -- <path>` restored the pre-run content.
3. Error text for an untracked or missing path: `error: pathspec 'src/pkg5/created_5.py' did not match any file(s)
   known to git`, exit 1 (probe).
4. **`git diff --no-index`**: "This form is to compare the given two paths on the filesystem. You can omit the
   --no-index option when running the command in a working tree controlled by Git and at least one of the paths points
   outside the working tree, or when running the command outside a working tree controlled by Git. This form implies
   --exit-code." (`git-diff(1)`). Probe: exit **1** when different — `runGit` callers must treat exit 1 as success here.
   The manpage's `<path> <path> [<pathspec>...]` directory-pathspec form is **rejected by the 2.50.1 binary**
   (`usage: git diff --no-index [<options>] <path> <path>`, exit 129) although the installed manpage documents it —
   UNVERIFIED which release adds it; do not rely on it. Directory-vs-directory `--stat` works (7.6 ms) but compacts
   paths rename-style (`{run/pre/3/tree => ws}/src/a.py | 3 ++-`, `/dev/null => ws/src/b.py`).
5. **Binary**: `--numstat` "For binary files, outputs two - instead of saying 0 0." (`git-diff(1)`); probe output
   `-\t-\tsrc/pkg1/img.bin`; unified: `Binary files /dev/null and b/src/pkg1/blob.bin differ`; stat: `/dev/null =>
   src/pkg1/blob.bin | Bin 0 -> 10 bytes`.
6. **Stat truncation**: "--stat[=<width>[,<name-width>[,<count>]]] … By giving a third parameter <count>, you can limit
   the output to the first <count> lines, followed by ... if there are more." (`git-diff(1)`); probe `--stat=80,40,5`
   printed 5 rows, ` ...`, then `51 files changed, 50 insertions(+)`. `--shortstat` "Output only the last line".
7. **Colour**: `--color=always` overrides `-c color.ui=false` (probe: `\x1b[1mdiff --git …`); without it no SGR.
   Pager order: "The order of preference is the $GIT_PAGER environment variable, then core.pager configuration, then
   $PAGER, and then the default chosen at compile time (usually less). When the LESS environment variable is unset, Git
   sets it to FRX" (`git-config(1)` core.pager); `GIT_PAGER` "If it is set to an empty string or to the value "cat", Git
   will not launch a pager." (`git(1)`).
8. **Path quoting**: "Without the -z option, pathnames with "unusual" characters are quoted as explained for the
   configuration variable core.quotePath" (`git-status(1)`); probe: unified headers show `"a/…/\303\274n\303\257.py"`
   unless `-c core.quotePath=false`, which prints `a/…/ünï.py`.
9. **Porcelain v2** (`git-status(1)`): headers `# branch.oid <commit> | (initial)`, `# branch.head <branch> |
   (detached)`, `# branch.upstream <upstream-branch>`, `# branch.ab +<ahead> -<behind>`; entries `1 <XY> <sub> <mH>
   <mI> <mW> <hH> <hI> <path>`, `2 … <X><score> <path><sep><origPath>`, `u …`, `? <path>`, `! <path>`; "<sub> A 4
   character field describing the submodule state. "N..." when the entry is not a submodule. "S<c><m><u>" when the
   entry is a submodule."; "When the -z option is given, pathnames are printed as is and without any quoting and lines
   are terminated with a NUL". `--porcelain` "will remain stable across Git versions and regardless of user
   configuration". Probe (dirty fixture): `# branch.oid 7d731c0…␀# branch.head main␀1 M. N... 100644 100644 100644
   <hH> <hI> src/pkg1/mod1.py␀1 .M N... … src/pkg2/mod2.py␀2 R. N... … R100 src/pkg6/renamed6.py␀src/pkg6/mod6.py␀?
   src/pkg4/new_untracked.py␀`; a dirty submodule shows `1 .M S.M. 160000 160000 160000 <h> <h> sub` (v1: ` M sub`).
   Unborn: `# branch.oid (initial)␀# branch.head master␀? a.txt␀`. Detached: `# branch.head (detached)`.
10. **rev-parse**: "--git-common-dir Show $GIT_COMMON_DIR if defined, else $GIT_DIR."; "--absolute-git-dir Like
    --git-dir, but its output is always the canonicalized absolute path."; "--show-superproject-working-tree Show the
    absolute path of the root of the superproject's working tree (if exists) that uses the current repository as its
    submodule." (`git-rev-parse(1)`). `git-worktree(1)` DETAILS: "Within a linked worktree, $GIT_DIR is set to point to
    this private directory (e.g. /path/main/.git/worktrees/test-next in the example) and $GIT_COMMON_DIR is set to point
    back to the main worktree's $GIT_DIR". Probe in a linked worktree: `.git` is a file `gitdir:
    /private/tmp/jev-git15/ws/.git/worktrees/wt`; `--git-path HEAD` → `<gitdir>/HEAD`; `--git-path index` →
    `<gitdir>/index`; `--git-path objects` → `<common>/objects`; branch `wtbranch` while the main tree is on `main`.
    Combined `rev-parse --git-dir --git-common-dir --show-prefix --is-inside-work-tree --abbrev-ref HEAD` is one spawn
    (15.0 ms p50) but on an **unborn** repo `--abbrev-ref HEAD` fails (`fatal: ambiguous argument 'HEAD'`, exit 128)
    after printing the earlier answers (`.git\n.git\n\ntrue\nHEAD\n`) — so the branch must come from `symbolic-ref
    --short -q HEAD` (prints `master`, exit 0 on unborn; exit 1 when detached) or from reading `HEAD` directly.
11. **Detached HEAD**: `rev-parse --abbrev-ref HEAD` prints the literal `HEAD`; `.git/HEAD` holds the raw sha;
    `symbolic-ref -q HEAD` exits 1 (probe) — Gemini's `branch !== 'HEAD'` test is the right guard.
12. **Submodules**: `git checkout -- sub` exits 0 and changes nothing inside the submodule (probe); `--ignore-submodules
    =dirty` hides inner dirt from `diff --stat`; from inside `sub`, `--git-dir` is `<ws>/.git/modules/sub` and
    `--show-superproject-working-tree` is `<ws>`. `lsFiles` already drops mode `160000` (`git.ts:135`).
13. **Non-git**: `rev-parse --is-inside-work-tree` → `fatal: not a git repository (or any of the parent directories):
    .git`, exit 128; `git diff --no-index` works there ("when running the command outside a working tree controlled by
    Git", `git-diff(1)`; probe).

## 4. Measurements (n as shown; p50/p95 in ms; harness flag order and env)

| What | Result |
| --- | --- |
| `git --no-optional-locks status --porcelain=v1 --untracked-files=all -z`, clean 5,041 files | first call 19.3; n=15 p50 **14.0**, p95 15.4 |
| same, `-unormal` / `-uno` | 13.8 / 11.7 p50 (untracked scan is not the cost here) |
| `--porcelain=v2 --branch --untracked-files=all -z` | p50 **13.9**, p95 15.1 — branch/oid/upstream come free |
| same v1 without `--no-optional-locks` | 13.9 p50 (no measurable difference on a warm index) |
| dirty tree (3 modified, 1 staged, 1 rename, 1 untracked) v1 `-uall -z` | 14.1 p50, p95 14.5 |
| `rev-parse --abbrev-ref HEAD` | 12.8 p50 (n=15) |
| combined `rev-parse --git-dir --git-common-dir --show-toplevel --abbrev-ref HEAD` | 15.0 p50, 35.1 p95 (one spawn instead of four ≈ 50–60 ms saved at run start) |
| `git --version` (spawn floor) | 18.0 p50 |
| read `.git/HEAD` + the ref file in-process | **0.0–0.1 ms** |
| `ls-files --others --exclude-standard -z` / `ls-files -s -co --exclude-standard -z` | 10.1 / 10.8 p50 |
| `git stash create`, 3 modified tracked | p50 **44.8**, p95 56.8 (n=10); +12 loose objects |
| `git stash create`, 53 modified tracked | p50 **84.4**, p95 150.7 (n=5) |
| `git stash create`, clean tree | 32.6, prints nothing |
| sha256 (Node `crypto`) of 2 / 10 small changed files | 0.1 / 0.2 ms p50 |
| sha256 of one 1 MiB file | 0.6 ms p50 |
| `git hash-object -- a b` (spawn) | 19.3 p50 — never spawn for hashing |
| 25-step simulation (2 edits/step + 1 created file every 5th step = 50 tracked + 5 untracked): `diff --stat -- <50 paths>` | p50 **36.6**, p95 42.2 |
| same `--numstat -z` / whole-tree `--stat` / unified | 34.9 / 38.3 / 45.4 p50; unified = 8,992 bytes |
| `diff --no-index -- /dev/null <untracked>` ×1 / ×5 (5 spawns) | 21.8 / 111.3 p50 |
| `add -N <5>` + `diff --stat` + `reset -- <5>` (intent-to-add route, **writes the index**) | 86.5 p50 |
| `checkout -- <1 path>` / `restore --source=HEAD --worktree -- <1 path>` | 22.5 / 18.6 p50 |
| `fs.watch(<gitdir>)` filtered on `filename === 'HEAD'`, `git checkout -B` in another process | events 8/8; latency from spawn start p50 **75.4** (min 68.4, max 111.4) of which the `git checkout -q -B` spawn itself is ~27.5 → ≈ 48 ms after git writes HEAD |
| `fs.watch(<gitdir>/HEAD)` (the file) | first event 36.5 p50, **but only 1 event across two HEAD rewrites** — git replaces HEAD with lock+rename, so a file watcher (kqueue on macOS) goes dead after the first change |
| seatbelt, linked worktree, profile allows only `<wt>`: harness `git checkout -- f` | `fatal: Unable to create '/private/tmp/jev-git15/ws/.git/worktrees/wt2/index.lock': Operation not permitted`, exit 128 |
| same profile: `git status --porcelain` / `git stash create` | status OK (exit 0) / `error: could not write index`, exit 1 |
| profile that also allows `<common .git>` (with `config`/`hooks` denied) | checkout OK, stash create OK |
| main workspace under the DESIGN §8-shaped profile: `stash create`, `checkout --`, `diff --stat`, `git config core.fsmonitor false` | OK, OK, OK, `error: could not write config file .git/config: Operation not permitted` exit 4 |

Reading: one status spawn is ~14 ms, comfortably inside the 50 ms harness budget and already paid at run start;
`stash create` is 45–85 ms per step *plus* object litter, i.e. over budget on its own; hashing is free; `/diff` of
a 25-step run is one ~40 ms spawn plus ~22 ms per untracked file.

## 5. Seatbelt × harness git: what breaks and the fix

The DESIGN §8 profile allows writes under `<ws>` and denies `<ws>/.git/config` and `<ws>/.git/hooks`. Measured above:

- **Linked worktree** (`git worktree add`): `<ws>/.git` is a *file*, the per-worktree `HEAD`, `index`, `ORIG_HEAD` live
  in `<common>/worktrees/<name>/` and objects in `<common>/objects` — all outside `<ws>`. Harness `git checkout --`,
  `git restore`, `git stash create`, `git apply` (writes the index? — `git apply` without `--index` does not; verified
  by DESIGN §8 that patches work) and any generator `git commit`/`git add` inside a `run` fail with `Operation not
  permitted` while read-only `status`/`ls-files`/`diff` still work. Today's `protectGit` deny literals
  (`<ws>/.git/config`) also point at a non-existent path, so they protect nothing.
- **Main tree**: the current shape is correct — `stash create`, `checkout --`, `diff` succeed and the config write is
  denied (`error: could not write config file .git/config: Operation not permitted`).
- **Submodule inside the workspace**: its repository is `<common>/modules/<name>/` (inside `<ws>/.git` for a main
  tree, so writable) and its `config` is executable-knob surface just like the top-level one; the current deny does
  not cover it.

Fix (all paths `realpath`ed before insertion, as §8 requires): compute once at run start `gitDir` and `commonDir`
(§6.1), then emit

```
(allow file-write* (subpath "<ws>") (subpath "<gitDir>") (subpath "<commonDir>") …)        ; gitDir/commonDir only when outside <ws>
(deny file-write* (literal "<commonDir>/config") (subpath "<commonDir>/hooks")
  (literal "<gitDir>/config.worktree")                                                       ; extensions.worktreeConfig
  (regex #"^<commonDir-escaped>/modules/.*/config$") (regex #"^<commonDir-escaped>/modules/.*/hooks/"))
```

`ProfileOptions` gains `gitDir?: string; gitCommonDir?: string` (seatbelt.ts:33 area) and `protectGit` keeps its
meaning. Known limit stays as documented: a `run` can still `mv .git .g; echo 'gitdir: .g' > .git` (DESIGN §8), and
defence 2 (scrubbed env + `-c` neutralisers in `runGit`) remains the one that actually holds. A workspace that is a
**subdirectory** of its repository (`showPrefix() !== ''`) already has `.git` outside `<ws>`; today generator
`git commit` cannot work there under seatbelt either — the same `gitDir`/`commonDir` allow fixes it, and the README
sentence "in-workspace writes succeed" should say "and the repository's `.git` directory".

## 6. Decisions and specification

### 6.1 Run-start git probe: one spawn, a `GitState`, a notice-only banner

Replace the four serial spawns in `createWorkspace()` with **two**: (a) `git rev-parse --is-inside-work-tree
--show-prefix --absolute-git-dir --git-common-dir --show-toplevel` (one spawn; all five are safe on unborn repos —
only `--abbrev-ref HEAD` is not, §3.10) and (b) the existing status call switched to `--porcelain=v2 --branch
--untracked-files=all -z` (same 14 ms, §4). Branch and upstream come from the v2 headers; when `# branch.head
(detached)` the short oid is `branch.oid.slice(0, 8)`. No `rev-parse --abbrev-ref`, no `symbolic-ref` spawn.

```ts
// src/workspace/git.ts (new)
export interface GitState {
  repo: boolean;                       // false → everything else null/[] and `reason` set
  reason?: 'not-a-repo' | 'git-missing' | 'bare' | 'timeout';
  gitDir: string | null;               // --absolute-git-dir (realpath)
  commonDir: string | null;            // --git-common-dir  (realpath)
  topLevel: string | null;             // --show-toplevel
  prefix: string;                      // --show-prefix ('' at top level)
  linkedWorktree: boolean;             // gitDir !== commonDir
  head: { kind: 'branch'; name: string } | { kind: 'detached'; oid: string } | { kind: 'unborn'; name: string };
  upstream: string | null; ahead: number | null; behind: number | null;   // # branch.upstream / # branch.ab
  dirty: { modified: number; staged: number; untracked: number; renamed: number; unmerged: number; submodules: number; entries: StatusEntryV2[] };
  probedAt: string; probeMs: number;
}
```

`statusPorcelainV2()` parses the ten line kinds of §3.9 with `-z`; `StatusEntryV2 = { xy, sub, path, from?, hH?, hI?,
mode? }` so `sub[0] === 'S'` (submodule) and `xy[0] !== '.'` (index differs from HEAD) are available to §6.4 without
another spawn. `RunMeta` gains `git: Pick<GitState, 'repo' | 'reason' | 'head' | 'upstream' | 'linkedWorktree' |
'prefix'> & { dirtyAtStart: { modified, staged, untracked } }` (bounded, no paths) — the bench then knows on which
branch a run happened, and `--resume` can warn when `head` differs from the stored one.

**Banner** = one transcript item (`kind: 'workspace'`, level `info`; `warn` only when `dirty.unmerged > 0`), emitted
by the engine as a new `EngineEvent { type: 'workspace'; git: RunMeta['git'] }` right after `run:ready`, rendered
identically by the TUI `<Static>`, `--plain` and `transcript.log` (A49 twins):

```
[run] git main ↑2 · 3 modified · 1 staged · 1 untracked                  (branch, ahead/behind only if upstream)
[run] git detached 7d731c0e · clean
[run] git wtbranch (linked worktree of /Users/me/proj) · clean
[run] git main (unborn, no commits yet) · 2 untracked
[run] git main · in subdirectory pkg/api/ of the repository
[run] git none · not a git repository: changes made by commands are not recoverable, /diff compares against step pre-images only
[run] git none · git not found on PATH: patches, /diff and run-step recovery are unavailable
[run] git main · 412 modified · working tree has unmerged paths (u) — commands may fail on conflict markers
```

Rules: **notice only, never a gate, never a question** (aider's `--dirty-commits` auto-commit is rejected in §8 —
JevCode must not create commits on the user's branch). Numbers are `dirty.*` counts from the snapshot; ASCII twins
`^2 v1` for `↑2 ↓1` when the glyph set is ASCII (06 §13 rule "every coloured token carries a marker or word"). The
banner is the same in screen-reader/`--plain` mode because it is already text. Ordering: `main.tsx` creates the
renderer, then awaits `createEngine()` → `createWorkspace()` (`src/cli/main.tsx:93-98, 193-195`;
`src/loop/engine.ts:1631`) **without** awaiting `renderer.firstFrame()` in between (read 2026-09-20). The git children
are asynchronous spawns, so they do not block Ink's first paint, but nothing today orders them after it; the banner
must therefore be an engine event emitted after `renderer.attach(engine)` (the event bus buffers until attach), and
`perf/first-frame.ts` keeps gating on the header frame, not on the banner. On `--perf-exit-after-first-frame` the
engine is never created, so the two spawns cost the perf gate nothing.

### 6.2 Status-line git zone (A46 left zone, after `mode·stage·spinner`)

- **Source of truth is the file system, not a spawn.** `src/tui/useGitHead.ts`: `fs.watch(gitDir, { persistent:
  false })` filtered on `!filename || filename === 'HEAD'` (Gemini's exact predicate, §2.4; measured: 8/8 events, a
  watcher on the `HEAD` *file* dies after one rename, §4), 100 ms debounce (Gemini's constant), then **read
  `<gitDir>/HEAD` in-process** (`ref: refs/heads/<name>` → branch; 40-hex → detached, show 8 chars; `refs/heads/`
  missing and `packed-refs` lacking it → unborn). 0.0–0.1 ms, zero spawns, zero effect on the loop. `gitDir` is the
  per-worktree dir from §6.1 (in a linked worktree `HEAD` is under `<common>/worktrees/<name>/`, §3.10), so worktrees
  are correct by construction. `persistent: false` so the watcher never keeps the process alive at exit; on
  `EMFILE`/`ENOENT`/error → zone shows the run-start value and stops updating (Gemini's "will simply not update").
- **Dirty counters** in the zone refresh only from data the harness already has: the run-start snapshot, and the
  `statusEntries` refresh `invalidateCandidates()` performs after each `run` outcome (files.ts). No timer-driven `git
  status` — the loop budget belongs to the loop.
- **Rendering**: `⎇ main` / `⎇ 7d731c0e†` (detached, `†` twin word `detached` in `--plain`) / `⎇ main (wt)` /
  `⎇ main ↑2` when upstream exists, then ` · 3~ 1?` (`~` modified incl. staged, `?` untracked, `!` unmerged) only when
  non-zero; ASCII fallback `br main`. Widths: zone ≤ 24 cells at ≥ 100 columns, ≤ 14 below, ≤ 0 (hidden) below 60
  columns (Gemini hides labels under `MIN_TERMINAL_WIDTH_FOR_FULL_LABEL = 100`, 03 §7). Truncate the branch name **by
  grapheme** (`Intl.Segmenter`, the composer's measurer, 07 §4 / A99): keep the *tail* after the last `/`
  (`feature/JIRA-1234-long-name` → `…-long-name`) because prefixes repeat; measure with the shared width function so
  a CJK branch name (`功能/新的分支`) never overflows the row. Colour is additive only (yellow when dirty, red when
  unmerged) and every state has a glyph or word.
- **Not shown**: ahead/behind is refreshed only at run start (it needs a spawn); the zone shows the stale value with no
  indicator rather than spawning — acceptable because the banner carries the time.

### 6.3 Post-images: `post/<step>.json` beside `pre/<step>/`

A57's pre-images stay (`<run>/pre/<step>/<sha256(relpath)>`, atomic, > 1 MiB skipped and noted). Add, per committed
step that has `changedFiles`, **one** file `<run>/post/<step>.json`:

```json
{ "step": 7, "at": "2026-09-20T14:02:11Z",
  "files": { "src/a.py": { "sha256": "…", "bytes": 812, "mode": 420, "source": "edit" },
             "build/out.txt": { "sha256": "…", "bytes": 91, "source": "run", "preImage": false } },
  "skipped": [ { "path": "big.bin", "reason": "size", "bytes": 3145728 } ] }
```

- Computed at `execute` end from `outcome.changedFiles` (file actions know their paths; `run` steps get them from the
  porcelain refresh that `invalidateCandidates()` already does), hashing with `crypto.createHash('sha256')` on the
  bytes just written or read back: 0.1 ms for 2 files, 0.6 ms per MiB (§4). Files > 1 MiB are hashed anyway (0.6 ms)
  but never copied; a deleted file records `{ "deleted": true }`. Written through `writeFileAtomic` before the step's
  `state.json` so a `/undo` after a crash can trust it; it is bounded (≤ changedFiles × ~120 B).
- `run`-step **pre-images without `stash create`**: before `execute` of a `run` action, copy into
  `pre/<step>/` every path that is *currently dirty or untracked-not-ignored in the snapshot/status cache* (the sets
  `snapshotDirty ∪ statusEntries ∪ touched`, all already in memory — no spawn), capped at 200 files / 16 MiB with the
  overflow noted in `post/<step>.json.skipped` as `reason: "cap"`. Rationale: a tracked file that is *not* dirty is
  recoverable from HEAD (worktree == index == HEAD when porcelain lists nothing), so only dirty files need a copy;
  measured cost 0.1 ms per small file, and it works in non-git workspaces for `touched` paths. This replaces the
  `git stash create` idea in 10 §18 Q5 / P9 (measured 45–85 ms per step plus 4+2N loose objects in the user's
  repository, no untracked files, fails on unborn repos; Codex has removed its equivalent, §2.2).
- `StepRecord` is unchanged (bench readers untouched); `steps.jsonl` rows gain nothing. `state.json` gains
  `undoLog: { step, at, restored: string[], skipped: { path, reason }[] }[]` (bounded to 20 entries) so the record of
  what a human reverted survives resume.

### 6.4 `/undo` and `/rewind <step>`: verify before you write

Preconditions (both commands): no run live (`state.done !== null`, opencode `assertNotBusy`), and the composer idle.
`/undo` = the **last committed step with `changedFiles`**; `/undo <n>` for `n` < last is refused with the hint in rule
3 below; `/rewind <n>` = undo steps `last … n` in **reverse order**, each verified as below, stopping at the first
refusal (state stays consistent because each step's undo restores exactly that step's pre-state).

For every `path` in `post[N].files` decide:

| Current file vs `post[N].files[path].sha256` | Decision |
| --- | --- |
| equal | restore (table below) |
| file missing and `post[N]` says `deleted: true` | restore |
| differs, and some later step M > N has `post[M].files[path].sha256 === current` | **refuse**: `src/a.py was changed again by step 9; use /rewind 7 to undo steps 7–9 together` — never partially undo a chain |
| differs, no later step matches | **ask** with `n` default: `src/a.py changed since step 7 (outside JevCode). Overwrite? [y/N]` — one question per file, `a` = yes to all remaining, `s` = skip all remaining, Esc = abort the whole `/undo` (nothing written yet: all checks run before the first write) |
| path is a symlink or hard link (`lstat().isSymbolicLink()` or `nlink > 1`) | skip, reason `link` (Claude Code's rule, §2.1) |
| path resolves outside `<ws>` or into `.git` (`resolveInside(ws, p, 'write')` throws) | skip, reason `escape` |
| `TargetInfo.tracked` is a submodule (`sub[0] === 'S'` in the v2 entry) | skip, reason `submodule` (`git checkout -- sub` is a no-op, §3.12) |

Restore source per file (first match):

1. `pre/<N>/<sha256(relpath)>` exists → `writeFileAtomic(abs, bytes, { mode })` (mode from the pre-image's recorded
   `mode`, so executables stay executable — `edit.ts` already preserves mode).
2. `createdThisRun` has it (or `post[N].files[path].created === true`) and no pre-image → `unlink`, then remove empty
   parent directories up to `<ws>` that the step created (recorded as `createdDirs`).
3. `source === 'run'`, tracked, and the step-start status had **no entry** for it (worktree == index == HEAD at that
   moment, §6.3) → `git restore --source=HEAD --worktree -- <path>` through `runGit` (never `checkout --`, which
   restores from the *index* the command may have changed, §3.2; never `--staged`, the index is the user's).
4. otherwise → skip with `reason: 'not-recoverable'` (Claude Code boundary: "Checkpointing does not track files
   modified by Bash commands", §2.1).

Output (transcript item + `--plain` twin + `undo` line in `sessions/index.jsonl`, 10 §15.5):
`undo step 7: restored 3 files (src/a.py, src/b.py, tests/test_a.py), skipped 1 (build/out.txt: not recoverable —
changed by a command, not tracked by git)`; when nothing was restored: `undo step 7: no files restored (2 skipped: …)`
(Claude Code's two messages, §2.1). The next run's seed gets `HarnessProblem { kind: 'human', text: 'human reverted
step 7: src/a.py, src/b.py, tests/test_a.py' }` (10 §15.7). After a successful `/undo` the `post/<N>.json` is renamed
`post/<N>.undone.json` so a second `/undo` targets step N−1, and `state.undoLog` is appended.

Non-goals: no `git stash`, `git reset`, `git checkout <branch>`, `git clean`; nothing ever touches the index or refs;
`/undo` never reverts the plan or window (that is `/rewind`'s `plan+window` option, 10 §15.7); no auto-commit.

### 6.5 Non-git workspaces (`GitState.repo === false`)

- Banner line from §6.1 says it once. `WorkspaceInfo.git` already exists; the generator prompt should carry the same
  fact (`workspace: not a git repository`) so it does not propose `git` commands.
- Tracking: file actions → `touched` (exists); `run` steps → `changedFiles` is empty (DESIGN §8 non-git), so
  `post/<step>.json` has only file-action entries and `pre/<step>/` for `run` steps contains the `touched` set copy
  (§6.3) — the only recoverable run-step damage is to files the run had itself created or edited.
- `/undo`: rule 1 and rule 2 only; rule 3 is unavailable and says `not recoverable — no git repository`.
- `/diff`: per file with a pre-image, `git diff --no-index --numstat -z -- <pre> <abs>` (exit 1 = differences;
  7–22 ms per file) when a `git` binary exists (`reason !== 'git-missing'`); unified view rewrites the two header lines
  to `--- a/<rel>` / `+++ b/<rel>` (the pre-image's temp path is meaningless to the reader; `--src-prefix` cannot
  do this because it keeps the full path, §3.4). With no `git` at all: an in-process line count (`added = new lines −
  common`, via a plain longest-common-subsequence on line arrays for files ≤ 1 MiB; O(N·D), sub-millisecond for
  source files) feeds the `--stat` rows and the unified view says `git not found: showing before/after sizes only`.

### 6.6 `/diff [step] [--full]`: stat inline, unified in `$PAGER`

Two views, mirroring Claude Code's *turn view* (built from the tool's own edits) and *Current view* (from git) (§2.1):

- **`/diff <step>`** = that step's pre → post exactly: for each `post[step].files[path]` with a pre-image or created
  flag, `git diff --no-index …` between `pre/<step>/<hash>` (or `/dev/null`) and the current file **only if the current
  sha256 equals the recorded post-image**; otherwise the row is marked `(changed since)` and the diff is against the
  recorded state's absence — i.e. the row shows `+?/-?` and a hint to use `/diff`. This is the only view that is
  correct for `patch`/`edit` steps regardless of later edits.
- **`/diff`** (no step) = the run's cumulative change as git sees it: `git diff --numstat -z HEAD -- <changedFiles
  pathspecs…>` for tracked paths (one spawn, ~35 ms for 50 paths, §4) plus, for each untracked path in
  `changedFiles`, `git diff --no-index --numstat -z -- /dev/null <path>` (Codex's method, §2.2; ~22 ms each, so the
  first 20 untracked files are diffed and the rest listed as `?` with sizes only). Paths that were already dirty at
  run start (`snapshotDirty`) get a `†` marker with the legend `† also modified before this run`; submodule entries
  show as one row `sub (submodule, commit changed)` or are omitted when only inner files changed
  (`--ignore-submodules=dirty`, Codex/Claude behaviour). Unborn repositories diff against the empty tree
  (`4b825dc642cb6eb9a060e54bf8d69288fbee4904`) since `HEAD` does not resolve (§3.10).
- **Inline stat block** (default) is one appended `<Static>` item, never a live pane, so it costs one frame and no
  clear (DESIGN §10). Rendered in-process from `--numstat -z` (git's `--stat` is not used: its bar width depends on
  the terminal width at spawn time and its rename compaction is unreadable, §3.4):

  ```
  diff (run 20260920-140211-k7q2m6xa · 12 files · +184 −37 · 2 untracked · 1 binary · 1 skipped)
   M src/a.py            +120 −12  ++++++++--
   M src/b.py             +40 −25  ++++--
   ? src/new_helper.py    +24      ++
   A tests/test_a.py †    +12      +
   B assets/logo.png       Bin 0 → 4.2 KiB
   S vendor/big.min.js    skipped (1.3 MiB > 1 MiB)
   … 3 more files (/diff --all)
  ```

  Signs are the information; colour (green `+`, red `−` from the ANSI palette) is additive (WCAG 1.4.1, 06 §13). The
  bar is at most 10 cells, scaled to the largest row (git's own scaling rule), `+` then `-`; the `M/A/D/R/?/B/S` letter
  column is the `--diff-filter` alphabet plus `?` untracked, `B` binary, `S` skipped. Row cap 40 (`/diff --all` lifts
  it, `--stat=…,<count>` semantics, §3.6), path truncated by grapheme from the *left* (`…/deep/file.py`) to fit
  `columns − 32`. `--plain` prints the same lines; screen-reader mode replaces the bar with nothing and reads
  `120 added, 12 removed`.
- **`/diff --full [step]`** = unified diff in the pager. Build the text with `git diff … --color=always` when colour is
  enabled (`--color=always` beats `-c color.ui=false`, §3.7) plus `-c core.quotePath=false` (§3.8), with
  `--no-ext-diff --no-textconv` (already added by `runGit`), `--submodule=short --ignore-submodules=dirty` (Codex), and
  `-- <pathspecs>` excluding files > 1 MiB (`:(exclude)path`) and binaries (they get a one-line `Binary files … differ`
  anyway). Write it to `<run>/tmp/diff-<seq>.patch` and hand the terminal over with Ink's
  `useApp().suspendTerminal(async () => spawn(pagerCmd, { stdio: ['pipe', 'inherit', 'inherit'] }))` — the primitive
  research 08 §5 verified (raw mode off, cursor shown, bracketed paste off, kitty flags popped, alt screen exited; child
  output stays in scrollback; repaint on resume; **`<Static>` items appended during the suspension are dropped**, so
  engine events must be queued and dispatched after `resume()` — 08 A8). Pager choice follows git's own order
  (`$GIT_PAGER`, then `$PAGER`, then `less`; `core.pager` is *not* consulted because the repo config is attack surface,
  DESIGN §8), run through `/bin/sh -c` like git does, with `LESS=FRX` set only when `LESS` is unset (git's rule, §3.7)
  and `LESSCHARSET=utf-8`; `GIT_PAGER=cat`/`PAGER=cat` or no TTY → the unified text becomes an appended `<Static>` block
  capped at 400 lines with `… N more lines: /export diff <file>`. Keys inside the pager are the pager's (`q` closes,
  Codex's `pager_overlay` also closes on `q`, 04 §9). Ctrl-C reaches the pager as SIGINT (raw mode is off), not the
  run — and `/diff --full` is idle-only anyway.
- Colour-blind safety in the unified view: signs are intrinsic; when colour is on, use git's defaults (they honour
  `color.diff.*`? — no: user config is not loaded, so git's built-in red/green apply); JevCode does not post-process
  git's SGR. The inline stat block is where the design controls colour.

### 6.7 Detached HEAD, unborn, worktree, submodule, subdirectory — exact copy

| State | Banner / zone | `/undo` | `/diff` |
| --- | --- | --- | --- |
| detached | `git detached 7d731c0e · …` / `⎇ 7d731c0e†` | unchanged (`--source=HEAD` still resolves) | unchanged |
| unborn | `git main (unborn, no commits yet)` | rule 3 unavailable: `not recoverable — repository has no commits` | cumulative view diffs against the empty tree; every tracked-but-uncommitted path shows as `A` |
| linked worktree | `git wtbranch (linked worktree of <main tree path>)` | unchanged **once §5's profile fix lands**; until then rule 3 reports `skipped (sandbox denied write to <common>/worktrees/…/index.lock)` verbatim from git's stderr | unchanged |
| submodule dirty | zone counts it as `1~` and the banner adds `· 1 submodule modified` | rows inside a submodule are skipped (`submodule`) | one row `sub (submodule)`; inner files never listed (Claude Code: "edits to files inside the submodule don't appear there") |
| workspace is a subdirectory | `git main · in subdirectory pkg/api/ of the repository` | pathspecs are re-rooted with `fromRepoPath()` (files.ts) — already the rule for `changedFiles` | same |
| `git` binary missing | `git none · git not found on PATH: …` | rules 1–2 only | in-process counts (§6.5) |

## 7. Tests (vitest 5.0.1 + ink-testing-library 4.0.0 are already dev dependencies; pty via `script -q /dev/null`
as in `src/perf/first-frame.ts`)

Unit (`test/unit/workspace/git-state.test.ts`, `undo.test.ts`, `diff.test.ts`, `test/unit/tui/git-zone.test.tsx`;
fixtures built with real `git init` in `mkdtemp` dirs, as `test/unit/workspace/git.test.ts` does today):

1. `statusPorcelainV2` parses the exact probe strings of §3.9 (branch headers, `1`, `2` with the NUL-separated
   `origPath`, `u`, `?`, `!`, submodule `S.M.`), the unborn `(initial)` header, `(detached)`, and a torn/oversized
   output (`truncated: true` → `GitState.reason = 'timeout'`-style degradation, never a throw).
2. `GitState` probe on: plain repo, detached, unborn, linked worktree (`gitDir !== commonDir`, `linkedWorktree ===
   true`), subdirectory (`prefix === 'pkg/api/'`), non-git dir, `PATH` without git (`reason: 'git-missing'`).
3. Banner text for each `GitState` (snapshot tests, ASCII and Unicode glyph sets); `--plain` twin equals the
   `<Static>` text (A49).
4. `useGitHead`: write `ref: refs/heads/x` to a temp `HEAD` via lock+rename (as git does) and assert one update after
   ≤ 100 ms debounce; second rename still updates (dir watcher, not file watcher); watcher errors leave the last value.
5. Grapheme truncation of branch names: `feature/JIRA-1234-very-long-name` → tail-kept form; `功能/新的分支` fits 14
   cells; a name with a ZWJ emoji is never split (07 §4 counts).
6. Post-images: after `edit`, `write`, `patch`, `run` steps, `post/<step>.json` has the right `sha256`, `deleted`,
   `created`, `skipped(size)` entries; the file exists before `state.json` is rewritten (order via a spy).
7. `/undo` decision table: equal hash → restored; later-step overlap → refused with the `/rewind 7` hint and no write;
   external change → confirmer asked, default `n` leaves the file, `y` restores, `s` skips the rest, Esc aborts with
   zero writes; symlink → skipped `link`; submodule → skipped `submodule`; `run`-step tracked-clean → `git restore
   --source=HEAD --worktree` invoked through `runGit` with the neutralising flags (spy on `sandbox.run`, as
   `git.test.ts:93` does); staged-then-modified file → restored from the pre-image, index untouched (`git diff --cached`
   unchanged); non-git → rule 3 unavailable message.
8. `/rewind n` reverses steps in order and stops at the first refusal, leaving earlier steps undone and later intact.
9. `/diff` numstat parsing (`-\t-\t` binary, renames with two NUL-separated paths, unborn empty-tree base), row cap,
   `†` marker for `snapshotDirty` paths, `S` rows for > 1 MiB, left-truncation by grapheme; `/diff <step>` for a
   step whose file changed since (row marked `(changed since)`); non-git per-file `--no-index` with header rewrite;
   exit code 1 accepted for `--no-index`/`--exit-code`, other codes surface as errors.
10. Pager selection: `GIT_PAGER=cat` → inline block; `PAGER` unset → `less` with `LESS=FRX` injected only when unset;
    `LESS` set → untouched; no TTY → inline block.
11. Seatbelt profile snapshot: linked-worktree options emit the `<gitDir>`/`<commonDir>` allows and the
    `config`/`hooks`/`config.worktree`/`modules/*/config` denies; main tree emits today's shape byte-for-byte.

Pty (`test/pty/*.test.ts`, gated like `perf/render-lag`): a mocked run in a temp repo, `rows 24 cols 100`: (a) the
banner appears once in scrollback and never again after a resize; (b) `git checkout -b other` in a second process
updates the zone within 300 ms without any `ESC[2J`/`ESC[3J`; (c) `/diff` appends one `<Static>` block and the
dynamic region stays ≤ `rows − 2`; (d) `/diff --full` with `PAGER=cat` in the pty appends the block, with
`PAGER='sh -c "cat >/tmp/out; echo PAGED"'` the child's `PAGED` line is in the pty transcript *above* the redrawn
frame and typed keys after resume reach the composer (08 §5 probe replicated); (e) `/undo` asks `[y/N]`, a bare Enter
declines, and the file bytes are unchanged; (f) `NO_COLOR=1` capture of the stat block has no `ESC[3` SGR and every
row still carries its `+`/`−` counts. Seatbelt (darwin only, skipped elsewhere): a linked worktree fixture where
harness `git restore` succeeds under the generated profile and `git config core.fsmonitor true` inside a sandboxed
`run` fails with `Operation not permitted`.

## 8. ADOPT

| # | What JevCode should do | Why | Source |
| --- | --- | --- | --- |
| G1 | Run-start `GitState` from **two** spawns: `rev-parse --is-inside-work-tree --show-prefix --absolute-git-dir --git-common-dir --show-toplevel` + `status --porcelain=v2 --branch -uall -z`; drop `isRepo`/`showPrefix`/`gitDir` as separate calls | 4 serial spawns → 2 (~30 ms saved per run start); v2 gives branch/oid/upstream/ab and submodule/index hashes at the same 14 ms; `--abbrev-ref HEAD` breaks on unborn repos | §3.9–3.10, §4 measurements; `files.ts:100-130` |
| G2 | Banner transcript item after `run:ready` with the exact strings of §6.1: branch/detached/unborn/worktree/subdirectory/non-git/git-missing forms, dirty counts, `warn` only for unmerged paths; **notice only** | Users must see a dirty tree before a run edits it; a gate or an auto-commit would change the user's branch (aider does; JevCode must not) | §2.5; §6.1; DESIGN §8 (no harness commits) |
| G3 | Status-line git zone driven by `fs.watch(<gitDir>)` filtered on `HEAD`, 100 ms debounce, reading `HEAD` in-process; dirty counts only from existing status refreshes; grapheme-tail truncation; glyph + word twins | Zero spawns on the loop; file watcher goes dead after one rename (measured), dir watcher fired 8/8; Gemini's proven predicate and constant | §2.4; §4 `fs.watch` rows; 07 §4 |
| G4 | `post/<step>.json` with per-path `sha256`/`bytes`/`mode`/`source`/`deleted`/`created`, written before `state.json`; hash with Node `crypto` (0.1 ms), never `git hash-object` (19 ms spawn) | Enables modified-since and later-step-overlap checks; bounded; no `StepRecord` schema change | §6.3; §4 |
| G5 | Run-step pre-images = copy of the currently dirty/untracked/touched set (cap 200 files / 16 MiB) before `execute` of a `run`; recovery of clean tracked files via `git restore --source=HEAD --worktree` | Only dirty files are unrecoverable from HEAD; O(dirty) not O(tree); works in non-git for `touched`; avoids 45–85 ms and 4+2N loose objects per step | §3.1–3.2, §4 stash rows, §6.3 |
| G6 | `/undo` decision table: equal hash → restore; later-step overlap → refuse with `/rewind N` hint; external change → ask per file with `n` default (`y`/`a`/`s`/Esc); skip links, escapes, submodules; all checks before the first write; name every skipped file with its reason | Claude Code and opencode overwrite blindly; the harness has the data to do better; skip wording follows Claude Code's "Restored the code, but skipped N files" | §2.1, §2.3, §6.4 |
| G7 | Never `git checkout -- <path>` for recovery; use `git restore --source=HEAD --worktree -- <path>` (or the pre-image) and never touch the index or refs | `checkout --` restores from the index, which a `run` may have `git add`ed (measured) | §3.2 |
| G8 | Non-git fallback spelled out: banner sentence, `/undo` rules 1–2 only, `/diff` via `git diff --no-index` per pre-image (exit 1 accepted) or in-process line counts when git is missing | Today nothing says what happens; `--no-index` is documented to work outside a work tree | §3.4, §3.13, §6.5 |
| G9 | `/diff` = inline `<Static>` stat block rendered from `--numstat -z` (letters `M/A/D/R/?/B/S`, `+n −m`, ≤ 10-cell bar, `†` pre-dirty marker, row cap 40, grapheme left-truncation); `/diff <step>` from pre/post images; `/diff --full` = unified text through `$GIT_PAGER`/`$PAGER`/`less` via `suspendTerminal`, `--color=always` + `-c core.quotePath=false`, `LESS=FRX` when unset, inline fallback when pager is `cat` or no TTY | Signs carry the meaning (colour additive); one frame, zero clears; git's own pager rules; Codex's untracked method; Ink's suspension verified by 08 §5 | §2.1–2.2, §3.4–3.8, §6.6; 08 §5, A8–A9 |
| G10 | Seatbelt: allow `<gitDir>` and `<commonDir>` writes when outside `<ws>`; deny `<commonDir>/config`, `<commonDir>/hooks`, `<gitDir>/config.worktree`, `<commonDir>/modules/*/config` and `modules/*/hooks`; `ProfileOptions.gitDir/gitCommonDir` | Harness `restore`/`stash`/generator `commit` fail in linked worktrees today (`index.lock: Operation not permitted` measured); today's literal deny points at a file that does not exist there | §5 |
| G11 | `RunMeta.git` (bounded: repo/reason/head/upstream/linkedWorktree/prefix/dirtyAtStart counts) and `state.undoLog` | Bench and `--resume` can see branch drift and human reverts; picker rows can show the branch | §6.1, §6.3 |
| G12 | Treat exit 1 from `git diff --no-index`/`--exit-code` as success in the `/diff` code path (`runGit` result `ok` is `exitCode === 0`) | "This form implies --exit-code" | §3.4 |
| G13 | Tests of §7, including the pty suspension probe and the darwin seatbelt worktree probe | The three surprises in this note (index-vs-HEAD, dead file watcher, worktree denial) were all found by probing, not reading | §7 |

## 9. REJECT

| What not to do | Why |
| --- | --- |
| `git stash create` before every `run` step (10 §18 Q5 / P9) | 44.8 ms p50 for 3 files, 84.4 ms for 53, over the 50 ms harness budget by itself; writes 4+2N loose objects into the user's `.git/objects` per step; excludes untracked files; fails on unborn repos ("You do not have the initial commit yet"); Codex removed its ghost snapshots ("snapshots are no longer produced") |
| Whole-tree shadow snapshot repo (opencode `write-tree`, Gemini `~/.gemini/history`) | 10 §17 already rejects it for the budget; it also needs alternates/`feature.manyFiles` tuning and a prune job (`7.days`, hourly cleanup) — infrastructure for a benefit the dirty-set pre-images give at O(dirty) |
| aider-style dirty commits or any harness commit/auto-commit on the user's branch | Changes the user's history to make undo easy; JevCode's rule is that the harness never writes refs (DESIGN §8 defence 2 lists only read-only and apply commands) |
| A run-start gate ("tree is dirty, continue? [y/N]") | Punishes the common case; the bench has no human; a notice plus a precise `/undo` is the safer contract |
| `git checkout -- <path>` (A57's wording) as the run-step recovery primitive | Restores from the index, not HEAD (measured); a `run` may have staged its own changes |
| `/undo` without a hash comparison, or a partial undo of a step whose files a later step also changed | Destroys user/later edits silently — the exact gap that motivates this note |
| Timer-driven `git status` for the status zone, or `git rev-parse` per HEAD event | ~14 ms/12.8 ms spawns on the loop for information a `HEAD` read gives in 0.1 ms; the zone's dirty counts already refresh with each `run` outcome |
| `fs.watch` on the `HEAD` **file** | Dies after git's first lock+rename (1 event across 2 rewrites on macOS) |
| `git diff --stat` text pasted into the TUI | Bar width fixed at spawn time (`--stat` "Maximum width defaults to terminal width, or 80 columns if not connected to a terminal"), rename compaction, no room for `†`/`S`/`?` rows; `--numstat -z` + in-process rendering is the same spawn |
| `add -N` intent-to-add to include untracked files in one `diff` (the bench's `diffAgainst` route) | Writes the user's index (86.5 ms incl. reset); Codex's per-file `--no-index /dev/null` route is read-only |
| Loading repo/user git config for pager or colour (`core.pager`, `color.diff.*`) | Repo config is attack surface (DESIGN §8); `GIT_PAGER`/`PAGER` env is the user's own |
| Ink `alternateScreen` for the diff viewer | Instance-wide, breaks the scrollback contract; `suspendTerminal` + `$PAGER` keeps the child's output in scrollback (07 §2.4, 08 §5) |
| The `git diff --no-index <dir> <dir> <pathspec>` form | Documented in the 2.50.1 manpage but rejected by the 2.50.1 binary (exit 129) |
| Colour as the only signal in diff rows | WCAG 1.4.1; the ANSI red/green pair is the worst case for deuteranopia (06 §13) |

## 10. Open questions

1. Should `/undo` of an `edit` step whose target was **already dirty at run start** restore the pre-image (the file as it
   was when the step ran, i.e. keeping the user's earlier uncommitted work) — yes by construction — or offer a second
   option "restore to HEAD"? Proposed: pre-image only; "to HEAD" is `git restore` in the user's shell.
2. Post-image hashing of files > 1 MiB that a `run` step produced (0.6 ms/MiB): cap total hashing per step at 64 MiB and
   record `hashSkipped: true` beyond it? Unmeasured on a real build-output step.
3. `GitState.upstream`/`ahead`/`behind` are run-start only; is a `/status` refresh (one 14 ms spawn on demand) enough,
   or should `run:end` re-probe so the epilogue can say `↑3 after this run`?
4. `RunMeta.git.head` vs `--resume`: warn only, or refuse when the branch differs (a run must "stay comparable with
   itself", DESIGN §9)? Proposed: warn, since the workspace is the real directory and the plan may still apply.
5. The `†` marker and the `(changed since)` row need Jev-side thought: should a `/diff` view ever feed the generator
   (e.g. as `shownFiles` context on the follow-up run), or stay human-only? Human-only proposed.
6. Windows/Linux paths for the same probes (`\\?\` prefixes, inotify semantics of `fs.watch` on a directory with many
   ref updates, `NUL` device) — out of scope for the darwin-first harness but the `useGitHead` hook should be written
   so a failing watcher degrades to the run-start value (Gemini's behaviour).
7. Whether `state.undoLog` should also carry the pre-`/undo` post-image hashes so a `/redo` (opencode `unrevert`) can be
   offered; the pre-images of the undone state are not kept today (the current file *is* the redo source only until the
   next edit).
8. In which git release the `--no-index <path> <path> [<pathspec>…]` form becomes usable (manpage says yes, binary says
   no on 2.50.1) — check the git 2.51 release notes; UNVERIFIED here.

## 11. UNVERIFIED / not fetched

- Gemini `getAbsoluteGitDir()` implementation (imported from `@google/gemini-cli-core` in `useGitBranchName.ts:8`): whether
  it resolves `gitdir:` pointer files and linked worktrees — not fetched; the JevCode design uses `rev-parse
  --absolute-git-dir` instead, so nothing depends on it.
- Codex `SAFE_BARE_REPOSITORY_CONFIG` constant contents and `fsmonitor.git_config_arg()` in `get_git_diff.rs` — only the
  names were read.
- opencode `snapshot/index.ts` line numbers were read from a `curl` of the `dev` branch on 2026-09-20 and may shift.
- Claude Code's actual restore implementation (whether it compares content before writing): only the docs were read;
  the docs describe overwriting and skipping, not comparing.
- Cold-page-cache timings: macOS `purge` needs sudo; every number above is warm-cache. The first-call column (19.3 ms)
  is the closest proxy.
- Linux behaviour of `fs.watch` on a git dir (inotify) and of the seatbelt equivalent (none): not testable here.
