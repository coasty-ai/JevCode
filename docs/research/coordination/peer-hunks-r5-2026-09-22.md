# TUI round-5 hunks against harness-owned files — what landed (2026-09-22)

Source of the request: `docs/research/tui/round-5/harness-session-hunks.patch` on branch `r5-impl`
(`f7d5644`, byte-identical at the branch tip `d1bfef7`). That file is a **request list written as hunks**, not an
applicable patch — two of its three bodies are elided (`{ … }`) and its line citations have drifted from main
(`ContextPolicyOptions` is `src/core/types.ts:2173`, not `:2187`; `openLedger` is synchronous and returns
`LedgerHandle`, not `Promise<LedgerHandle>`). It was therefore implemented against main `c601844`, not applied.

Branch: `peer-hunks-r5`. Harness-owned files only; nothing under `src/tui`, `src/cli`, `src/config`, `src/session`
or `src/chat` was touched.

| Hunk | Outcome |
| --- | --- |
| R5-H1 `publicMessage` | **landed, altered** — placed in `records.ts` and re-exported from the facade; two more members dropped than the peer's sketch named, with reasons |
| R5-H2 `context.kept` | **landed, altered** — the member is the peer's, the ranking pass is new work and carries the four-clause block; one part refused (see 2.4) |
| R5-H3 claim seat | **landed, altered** — `openLedger({ claim })` already existed, so the gap is the post-fold case: `LedgerHandle.reseatClaim()`. One part of the peer's rationale refused (see 3.3) |

---

## 1. R5-H1 — `publicMessage(m): PublicMessage`

**Landed.** `PublicMessage` is declared in `src/coordination/types.ts` beside `Message`; `publicMessage()` lives in
`src/coordination/records.ts` beside `redactRecord` / `finalizeRecord`; both are re-exported from
`src/coordination/index.ts`, together with `DEVICE_ID8_CHARS`. Test:
`test/unit/coordination/public-message.test.ts` (7 cases).

### 1.1 What I changed vs the peer's text

- **Placement.** The peer's hunk put the function body in `index.ts`. `index.ts`'s own header calls it a re-export
  facade ("Re-exports every §12.0 type … and the API exactly as built"); a projection with a body in it would be the
  first exception. The observable is identical — `import { publicMessage } from '../coordination/index.js'` works,
  and the test asserts the facade export is the same function object.
- **Two more members dropped than the sketch named.** The task named `hostKey`, `from.pid`, `from.bootId`. The
  sketch's own interface additionally dropped `from.user`, `v`, `kind`, `stamp`, `expiresAt`, `checksum` and `hmac`
  without arguing them. Every member of `Message` and of `Message['from']` was walked against the design; the result
  is the same key set the peer declared, now with a reason per member on the type declaration. The two that matter:
  - **`hmac`** is an HMAC under this device's paired commons key. TUI-DESIGN-5 §7 row 61 names "claim HMACs"
    explicitly. It is not optional to drop it.
  - **`checksum`** is a sha256 over the record's canonical text, and that text **contains `hostKey`**. `hostKey` is
    `sha8(hostname, username, machineId)` — eight hex characters, ~4.3 × 10⁹ candidates. Publishing the checksum
    beside every other field of the record is a known-plaintext oracle that recovers `hostKey` by exhaustive search
    in seconds. This is the one drop that is a real leak rather than a view rule, and it is the reason the projection
    cannot be "the record minus `hostKey`".

### 1.2 One correction to the peer's premise, for their §7 row 61 text

The phrase "device secret derivative" appears **only** in `docs/TUI-DESIGN-5.md`, and it names exactly one field:
`hostKey`. There is no enumerated derivative list in `docs/COORDINATION-DESIGN.md`. Worse for the strict reading:
COORDINATION-DESIGN §9.1's enable line says the shared folder **does** receive "hostnames, usernames, pids", and
§3.1/§12.0.4 put `hostKey` itself in the published, mirrored `DeviceRecord`. So `from.user` and `from.pid` are
dropped here on the **view** rule (no TUI view carries them — `SessionActivityView` / `SelfIdentityView` are
`deviceId8` + `label`), not on a secrecy proof, and the doc comment says so rather than blurring the two.

### 1.3 Totality

`type` is copied, never switched on, so the projection is total over `MessageType` by construction. The test makes
that checkable rather than asserted: it walks an exhaustive `Record<MessageType, true>` map, so `tsc` fails in the
test the moment a sixteenth member is added to the union, and asserts the projected key set **exactly** (7 keys, or
8 with `by`) plus the `from` key set exactly (4). Verified failing-first: adding `hostKey` back to the projection
fails 3 of the 7 cases.

`deviceId8` is `deviceId.slice(0, 8)`, which is the whole id today (`DEVICE_ID_RE` is 8 base32 chars). The slice is written down so a future widening of `DEVICE_ID_RE` cannot widen this sink by accident.

---

## 2. R5-H2 — `ContextPolicyOptions.kept` and the Jev ranking pass

**Landed.** `kept?: 'code' | 'jev'` on `ContextPolicyOptions` (`src/core/types.ts`, additive and optional, inside the
existing contract block — no header line changed); `ResolvedContextPolicy.kept` + `kept: p?.kept ?? 'code'`
(`src/loop/context/limits.ts`); the pass itself in `src/loop/context/compaction.ts` (`rankKeptCode`, `keptKey`,
`buildKeptRequest`, `rankKept`). Tests: `test/unit/loop/context-kept.test.ts` (22 cases) and a new byte golden in
`test/unit/loop/context-compaction.test.ts`.

### 2.1 `kept: 'code'` is byte-identical — pinned, not asserted

`compactCode` is **not touched**: the pass is a separate function the compactor does not call. The identity is
nonetheless pinned by a literal: `GOLDEN_CODE_SUMMARY` in `context-compaction.test.ts` is the exact summary text of
the file's existing fixture. Under `'code'`, `rankKept` returns `rankKeptCode()`'s list with `requests: 0` and an
asker that is never called (asserted with a recording fake, not by inspection).

### 2.2 What `'jev'` does, and the three deviations from §8.6's literal text

§8.6 asks for "ONE request with ≤ 16 Nouls `keep_<i>` … plus ≤ 16 `still_relevant_<rel>` … state = plan + candidates,
never the transcript … refused in `jev-off`". All of that is implemented. Three deliberate differences:

1. **A `most_needed` Choice rides in the same request.** §8.6 enumerates Nouls only, which would leave the site with
   no escape answer at all. `scripts/jev-contract.mjs` clause 1 and DESIGN §5.4 rule 3 want an escape, and the task
   asks for a fallback "when Jev escapes". The Choice is built by `choice()`, so `ESCAPE_KEY` is guaranteed, and
   §8.6's two Noul sets are exactly its per-option absolute pairs (REPORT §10's "a Choice is relative and always
   picks something; a Noul is absolute and can be low for every candidate"). Cost is one Choice in a request that
   was already being sent. `src/synth/llm/rank.ts` Q17 is the same shape.
2. **Keys are content-derived, not positional.** §8.6 spells `keep_<i>`; REPORT §10 and `rank.ts`'s own comment say
   an order-only key carries a position prior and collapses. `keptKey()` is `fact_<sha6>` / `file_<sha6>` over
   `sha12({kind, text, step})`, so the same candidate gets the same key in every request and two runs stay
   comparable. `still_relevant_<rel>` would also not have been a legal option key (a path has `/` and `.`).
3. **No 0.5 anywhere.** The escape bound is `KEPT_NOUL_FLOOR = 0.3` — the rejection end of DESIGN §5.4 rule 6's
   calibrated 0.3 / 0.7 band.

Escape and fallback, both tested: the code order stands under `'code'` (`fellBackTo: 'policy'`), under `jev-off`
(`'jev-off'`, asserted against `usesJev` over all four modes), with no asker (`'no-asker'`), with nothing askable
(`'nothing-to-ask'`), when the escape outranks every candidate or every Noul is under the floor (`'escaped'`), and
on any throw (`'failed'`).

### 2.3 Jev routes, never gates

`permuteAnswered` reorders **only the answered candidates, and only within the positions they already held**. A
human `/keep` item is never in the batch and never moves; an unanswered candidate holds its code rank; the
`KEPT_MAX` (24) cut is the code's and runs **before** the ask. `node scripts/jev-contract.mjs` accepts the new site
with a four-clause block (the allow-list was not touched).

### 2.4 Refused

**The peer's premise that the config row already exists is wrong on main.** Their hunk says `context.kept` "is landed
as a SETTINGS row (`src/config/defaults.ts`), printed by `jevcode config`, validated by `jevcode config set` and
resolved by `resolveContextConfig`". None of that is on `c601844`: `grep -rn "kept" src/config/` returns no
`context.kept` row, there is no `resolveContextConfig`, `src/config/resolve.ts` never mentions
`ResolvedConfig.context`, and `EngineOptions.contextPolicy` is not referenced anywhere in `src/cli/session.ts`. So
the member now exists and the pass behind it now exists, but **the value still cannot reach the engine from config**
— that half is TUI-owned (TUI-DESIGN-5 decision D-AI option (b)) and is theirs to land.

**Kept-item EXTRACTION was not built.** §8.6 specifies it (failing test ids + assertion lines, `edit applied to X
(1 match)` summaries, declined / blocked reasons, received `handoff`s) and it does not exist anywhere in `src/loop`
today; `CheckpointState.kept` is written by nothing. The hunk asked for the *ranking* pass, so `rankKept` takes
`candidates` and this file records the gap rather than inventing an extractor nobody reviewed. Until an extractor
and an engine call site exist, `rankKept` is reachable only from its test.

---

## 3. R5-H3 — the ledger handle's claim seat

**Landed.** `LedgerHandle.reseatClaim(claim)` + its implementation in `LedgerImpl`, and an expanded doc on
`OpenLedgerOptions.claim`. Test: `test/unit/coordination/claim-seat.test.ts` (12 cases).

### 3.1 The half that already existed

`openLedger` has taken `claim?: Claim` since review blocker 3 (`ledger.ts:447`:
`this.claim = o.claim ?? mintClaim({...})`). "Accept the MINTED claim" therefore needed **no signature change** — it
needed to be said and tested, which it now is: with `openLedger({ claim: minted })` the handle's seat and the beat
the heartbeat writer publishes are the same epoch; with no claim, the handle sits on the epoch-1 identity claim while
the beat carries the minted one, and that disagreement is pinned as its own test so the regression is visible.

### 3.2 The half that did not: `reseatClaim`

The case `OpenLedgerOptions.claim` cannot serve is the one the task names — "a claim readable after the fold".
`nextEpoch(runId)` reads `seenEpochs`, which needs `open()`, so the epoch does not exist when `openLedger` is called.
`reseatClaim` is a seat, not a re-mint, bounded by §14 item 18's holder rule, each bound a `CoordinationError`
(`'not-ours'`) and never a silent no-op:

- `isValidClaim` — epoch in [1, `MAX_CLAIM_EPOCH`], positive pid, ISO `at`;
- same `deviceId` and same `runId` as the handle's current claim, because `parseRecord` binds `claim.runId` to the
  record's `runId` (the rule `setIdentity` re-mints for, review minor 24) — a cross-run seat would make every later
  beat fail its own validator;
- the epoch may never go **down**: the holder is the highest qualified epoch, so a handle that published epoch *n*
  and then seated *n−1* would be telling its peers it lost a race it won. An equal epoch is accepted (idempotent).

No new `CoordinationErrorCode` was minted — those are ratified in §14 item 18 and `'not-ours'` already covers
"this is not this handle's to seat".

### 3.3 Refused

**`createHeartbeatWriter` does NOT force `base.claim === handle.claim`.** The peer's rationale ("the seat and the
beat can never name two epochs") reads as an invariant to enforce at the writer. It cannot be: the §4.7 **bench
presence beat** is written through a run's ledger with the `benchId` as the beat's `runId`
(`test/unit/coordination/heartbeat.test.ts:323` does exactly this), so its claim legitimately names a different run
than the handle's. Enforcing agreement there would refuse a valid record. The agreement is the **run writer's** to
make, at one call, and `reseatClaim` is the verb that makes it — stated in the implementation's doc comment so the
next reader does not re-litigate it.

---

## 4. Gates on the merged tree

```
npx tsc -p tsconfig.json --noEmit          exit 0
node scripts/no-any.mjs                    no-any: ok (src, test, perf, scripts)
node scripts/jev-contract.mjs              jev-contract: ok (33 Jev call site(s): 3 with a four-clause block, 30 allow-listed)
npx vitest run --project unit --maxWorkers=2 test/unit/coordination test/unit/loop test/unit/core
                                           Test Files 76 passed (76) · Tests 1025 passed (1025)
```

Baseline before this branch was `jev-contract: ok (32 Jev call site(s): 2 with a four-clause block, 30 allow-listed)`
— one new site, four-clause, allow-list untouched.

Two environment notes, neither caused by this branch:

- the agent worktree's `node_modules/` is empty, so `test/unit/tui/round2-console.test.tsx:10`'s hardcoded
  `'../../../node_modules/ink/build/components/AnimationContext.js'` import does not resolve and `tsc` fails on it
  before anything else. Symlinking `node_modules/ink` at the parent checkout's copy clears it. The hardcoded
  relative path is worth replacing with a bare `ink/...` specifier so a worktree build is not special.
- the whole `unit` project is 8,628 passed / 1 failed under `--maxWorkers=2`: `test/unit/tui/wizard.test.tsx:474`
  ("one Jev decision at api.typesafe.ai") fails under full-suite load and passes on its own (15/15). It is a
  timing-flaky `await tick(60)` assertion in TUI-owned code, untouched here.
