# Merge queue — the unmerged branches both sessions can see

**What this file is for.** Two Claude sessions share this checkout (the harness session and the TUI session) and
neither can read the other's memory. Until 2026-09-22 the branch state lived only in a private memory file, so
`r5-impl` — **167 files, +39,278 / −3,545 against `main`, the largest unmerged work in the tree** — was invisible to
anyone reading `docs/`. A reviewer who does not know it exists plans a refactor of `src/core/types.ts` that will
cost somebody a 130-line rebase.

**The rule.** *A branch that is not in this table does not exist as far as the other session is concerned.* Append a
row when you create a branch you intend to merge; delete the row in the merge commit that lands it. One row per
branch, and the `conflicts on` column is the part other people read — be specific (file **and** the hunk or symbol),
because a path alone does not tell the other session whether their edit collides.

Ownership of files is `docs/DECISIONS.md` 2026-09-22 "Harness-owned files touched by the TUI session arrive as
hunks" (the delimited three-bucket partition). This file records *branches*; that entry records *files*.

## Unmerged branches

| Branch | Owner session | Contents | Base commit | Gates passed | Conflicts on |
| --- | --- | --- | --- | --- | --- |
| `r5-impl` | TUI | TUI round 5 as implemented: the coordination surface (`/who`, `/pause`/`/end` targets, messaging, the peers zone), the context meter and `/context` `/compact`, the agents tab and manifest card, the import overlay and `jevcode import`, the provider/model picker and `jevcode models` (`docs/TUI-DESIGN-5.md`). 167 files, **+39,278 / −3,545**; 59 under `src/`, of which all but three are TUI-owned (`src/core/types.ts`, `src/undo/plan.ts`, `scripts/gen-docs.mjs`) | `c601844` (2026-09-22) — merged forward once at `d1bfef7`, so it is **behind `main` by the whole LLM-loop wave, oos-iter-4 and `peer-hunks-r5`** | the branch's own; NOT re-run against `main` @ `d297b29` | **`src/core/types.ts` (+130 / −12)** — the contract block, around `ProviderName` / `Provider` at `:994`; a rebase over the three round-5 hunks the harness has ALREADY landed on `main` (`rankKept` in `src/loop/context/compaction.ts`, `publicMessage` in `src/coordination/records.ts:206`, `LedgerHandle.reseatClaim` in `src/coordination/ledger.ts:276` — see `64f0474`), which must be dropped from the branch rather than merged twice. Also `scripts/gen-docs.mjs`, `src/undo/plan.ts`, `docs/DECISIONS.md`, `docs/STATUS.md`, `README.md`, `CHANGELOG.md` and the three `completions/` files (regenerate, never merge) |
| `finish-A` … `finish-F` | harness | the 2026-09-22 finishing pass, one slot per branch, disjoint file lists by construction | `d297b29` | per slot, in each slot's report | disjoint by slot assignment; the integrator reconciles `docs/DECISIONS.md` and `docs/STATUS.md` if two slots both append |

## Forward bundle budget

Recorded here so the next landing is not a surprise gate raise. `scripts/check-pack.mjs` gates the **unpacked**
size and the tarball; **the two constants live in that script and are restated in no document**, here included —
`docs/RELEASE.md` shed a hand-copied figure that had survived two raises of the real gate, and the first draft of
this table immediately re-created the same drift by writing `UNPACKED_MAX` out as a literal and deriving a headroom
from it (found by the finishing pass's own review, corrected 2026-09-22). Run `node scripts/check-pack.mjs`: its
pass line prints the measured size against the gate, which is the only pair that cannot go stale.
`test/unit/hygiene/doc-claims.test.ts` fails on any figure printed beside `UNPACKED_MAX` or `TARBALL_MAX` in any
document that is not the script's own value.

| Item | Bytes | Note |
| --- | --- | --- |
| last measured unpacked size | 3,003,627 | `docs/STATUS.md`, against the gate raised at `ca8e71c` |
| the gate | `UNPACKED_MAX` in `scripts/check-pack.mjs` | deliberately not restated; headroom = that constant − the measured size, and the script prints both |
| `r5-impl` forward: `src/models/**` | ≈ **42 KB** bundled (139,479 B of source) | all **13** modules in the directory — `cache`, `format`, `http`, `index`, `list`, `parse`, `pricing`, `providers`, `recommend`, `search`, `static`, `types`, `verify` (the byte figure is `cat src/models/*.ts \| wc -c`, so it counts all 13; the first draft named ten of them beside it) |
| `r5-impl` forward: the five adapters + the provider registry | ≈ **51 KB** bundled (101,888 B of source) | `src/provider/{openai,gemini,xai,fireworks,openai-compat}.ts` + `registry.ts` |
| `r5-impl` forward, total | ≈ **93 KB** | the whole of round 5's wiring cost; compare it against the headroom the script prints, not against a number copied into this table |

**Why this is "forward" when the files are already on `main`.** All 19 of them — 13 under `src/models/`, the five
adapters and `registry.ts` — are in the tree today — they landed
with the models catalogue and R14 (`d397b8f`) — but **nothing under `src/` imports them**: there is no importer of
`src/models/**` outside `src/models/**`, and `src/provider/registry.ts` has no importer at all (the only
`registry.js` imports in the tree resolve to `src/tui/commands/registry.ts`). esbuild therefore tree-shakes every
one of them out of `dist/jevcode.mjs`, which is why the last measured 3,003,627 does **not** contain them. Round 5
is what wires them in (`src/cli/models.ts`, the provider/model picker), so that is the landing where they are paid
for, for the first time.

Two things that make the projection safe to trust and one that does not:

- The bundle is minified with `keepNames` (`scripts/build.mjs`), so source bytes over-estimate bundle bytes; the
  numbers above are the pessimistic direction.
- **Anything that adds a runtime dependency invalidates this table**, because the unpacked figure is dominated by
  the inlined ink + react tree, not by our own source. The package has 0 dependencies today and
  `scripts/check-pack.mjs` asserts the file allowlist, not the dependency count — check `npm ls --prod` by hand
  before assuming.
- A `package.json` edit obliges `node scripts/gen-docs.mjs` (the man page's `.TH` date keys off the `package.json`
  blob — `docs/HARNESS-NEXT-DESIGN.md` §9.1, `cb14172`).

## Landed (kept briefly, then deleted)

| Branch | Landed at | Note |
| --- | --- | --- |
| `llm-loop-seam` | `d297b29` | the post-C router engine seam; `docs/DECISIONS.md`'s "still owed" clause was struck with it |
| `oos-iter-4` | `856023a` | replace-site ranking without a Jev ranking |
| `peer-hunks-r5` | `64f0474` | the three TUI round-5 requests against harness files — the reason `r5-impl` must drop those hunks on rebase |
| `warm-plane-fix-2` | `0556f1a` | the four harness defects iteration 2 found, incl. persisting `timing.jevWallMs` |
