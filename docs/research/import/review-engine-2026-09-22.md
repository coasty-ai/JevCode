# Adversarial review — `import-engine` @ 3a511a0 (read-only)

Reviewer: an independent read-only review, 2026-09-22, in a detached worktree; probes run after the CPU hold.
Baseline: `test/unit/import` + `test/unit/sandbox` + `test/unit/perf/import` = 528 tests pass, so every finding is a
coverage gap. Scope: the harness slot of `docs/IMPORT-DESIGN.md` (`src/import/**`, `src/core/limits.ts`
IMPORT_LIMITS, `src/perf/import.ts`, the seatbelt fragments).

## Defects, most severe first

1. **CONFIRMED — atlas destinations are never wired; every memory row lands in the wrong file.** `index.ts:321-327`
   builds `PlanCandidate` without `destination`, so `plan.ts:608 c.destination` is always `undefined` and `destKind`
   falls back to the class map. Repro: `<repo>/AGENTS.md` → `dest: .jevcode/memory/agents.md`, not `AGENTS.md`.
   `agents-append`, `memory-index`, `memory-local`, `report-only` are dead end to end; the marker/append path,
   `MEMORY.md` and the [G1.5] trust re-pin are unreachable in a real run. Fix:
   `destination: specById(item.artefact)?.destination` on the candidate.
2. **CONFIRMED — undo restores nothing when two rows share one destination.** `apply.ts:549` snapshots per `row.id`;
   both rows record the original file while `apply.jsonl.sha256Before` for row 2 is original+block1. Repro: two
   `append` rows → `AGENTS.md`; undo → `restored: []`, "pre-image does not match". §1 property 9 fails. Fix: snapshot
   once per destination (skip if `pre/<key>` exists); unwind per destination.
3. **CONFIRMED — resume after a crash clobbers the pre-image and applies the row twice.** `apply.ts:534-549` re-runs
   the pre-snapshot for every not-yet-logged row; a SIGKILL in the write→`appendLog` window leaves the destination
   written and the row absent. Repro: apply, truncate `apply.jsonl`, `resumeImport` → a second identical marker block
   and `pre/<row>` overwritten with post-crash bytes. Properties 9 and 10 fail. Fix: never overwrite an existing
   `pre/<key>`; on resume re-evaluate `rerunAction` against the live destination.
4. **CONFIRMED — literal secrets reach `.jevcode/mcp.json` (three paths).** `mcp.ts:242-252`, `:277-287`, `:357`:
   (a) a mixed value `"Bearer sk-ant-… ${SUFFIX}"` takes the reference branch and `continue`s before
   `looksLikeCredential`/`AUTH_HEADER_RE`; (b) `url` never sees `detectSecrets` (`https://user:sk-ant-…@host` written
   verbatim); (c) a plain literal under a non-secret key with no family match is written as-is (rule 8's band not
   applied in `mcp.ts`). Fix: run `detectSecrets`/`looksLikeCredential` on the post-normalisation value and on `url`;
   apply `inBand` to env values.
5. **CONFIRMED — Jev `is_secret` answers are applied to the wrong file.** `plan.ts:975` restarts `bandIndex = 0` per
   file while `index.ts:329` numbers `secret_<i>` globally. Repro: two files, answers `secret_0=0.95`,
   `secret_1=0.05` → both rows `skip:secret` p=0.95; flipped answers demote the real credential. Fix: a plan-wide band
   counter, or key answers by `SecretCandidate.id`.
6. **CONFIRMED — `parseMarkdown` is quadratic; a 390 KiB file takes 36 s.** `parse/markdown.ts:237` `inRegion` is an
   `Array.some` over every region per line, short-circuiting only after 5 headings (never, when headings are in
   fences). 62 KiB → 570 ms, 195 KiB → 17.6 s, 390 KiB → 36 s; the 4 MiB cap leaves it unbounded, and every file is
   parsed twice (`discover.ts:715` and `index.ts:308`). Fix: binary-search sorted regions or a per-line in-fence flag;
   reuse `buildItem`'s parse.
7. **CONFIRMED — a non-UTF-8 destination is corrupted by apply and cannot be undone.** `apply.ts:448` and `:549`
   `toString('utf8')`. Repro: latin-1 `AGENTS.md` byte `e9` → `ef bf bd`; the snapshot is mangled too, so undo refuses.
   Fix: `Buffer` end to end; refuse (not corrupt) a destination that is not valid UTF-8.
8. **CONFIRMED — the nine warn-only secret families are never redacted out of headings.** `markdown.ts:223` defaults to
   `patternRedact` (six families); `discover.ts:476` passes no redactor. Repro: `# rotated key AKIA…` survives into
   the group-II Jev request body and `sources.jsonl`. Also `sameMeaningQuestions` sends headings regardless of
   `--jev-sample`. Fix: `redactSpans(s, detectSecrets(s, exactLayer))` (as `leak.test.ts:109` does for the write seam);
   gate group III on the sample.
9. **CONFIRMED — the report's leak assertion turns a hostile filename into a crash.** `report.ts:334` throws under
   DEBUG (on unless `NODE_ENV=production`); a row whose `source.display` is `docs/AKIA….md` aborts the dry run. Fix:
   redact the rendered text, then assert.
10. **CONFIRMED — `mergedMcp` destroys an existing `mcp.json` it cannot parse.** `apply.ts:486-492`: `parseMcpFile`
    returns `null` unless `v === 1`; `mergeMcpFile(null, …)` drops every existing server. Fix: demote to `review` when
    the file exists but does not parse.
11. **CONFIRMED — rule 1 preempts `skip:self`, `skip:oversize`, `skip:not-text`.** `classify.ts:181-192`: every
    discovered artefact has a spec, so rules 2–6 are unreachable. Masked today by defect 1; once destinations are
    wired the repo's own `AGENTS.md` appends to itself on every run. **Design deviation judged wrong**: §4.4.1 puts the
    atlas class ahead of the identity rules; identity (self / third-party / tool-managed / secret basename / oversize /
    not-text) must run first.

## Lower

- `secrets.ts:275` rule-8 band floor is the medium bucket (2.5 b/c), not 3.2; `ENTROPY_BAND_BITS` unused.
- `secrets.ts:165` `${VAR:-<literal>}` counts as a pure reference and bypasses rules 1, 2 and the band.
- `apply.ts:677-692` undo re-creates a destination the user deleted (§4.7.6 says leave it alone).
- `apply.ts:382` mtime pre-filter never fires (`Date.parse` ms vs fractional `mtimeMs`).
- `plan.ts:1120-1126` `findConflicts` unbucketed O(n²), truncates at `dedupePairs` with no notice.
- `apply.ts:357` `modeFor` honours the render seam's mode unclamped (0o755 possible); clamp to 0644/0600.
- `index.ts:361` `workspaceKey` lacks `realpath` ([G1.3] second-clone comparison).
- `apply.ts:559` `entryMatches` suffix match can drop a user-scope manifest entry.

## Verified as holding

Slug confinement (§1 property 8; `..`, `.`, `CON`, emoji, 400-char → hash fallback; `.git` refused
case-insensitively; symlinked leaf refused). Parsers total (jsonc 200k nesting, unterminated strings, toml junk,
frontmatter never closed, `---` inside a fence, 100 MB jsonl line, sqlite stub). Source re-verification one read,
hashed and rendered from the same buffer. Seatbelt fragments match §2.11 exactly (memory-local read deny after both
re-allows, not gated on `protectGit`). Boundary clean; no child_process/network; `node:fs` only in the read-only seam;
no `any`. Lock/retention: `O_EXCL`, EPERM-as-alive, undo takes the lock, retention never GCs a live manifest's id.
`rerunAction` nine cells correct. Discovery: symlink-out `skip:symlink`, dev:ino cycles, caps return rows so far,
secret basenames never opened, transcripts opt-in and 256 KiB-capped, per-volume case probe.
