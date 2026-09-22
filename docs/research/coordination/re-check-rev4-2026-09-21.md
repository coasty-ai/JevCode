# Re-check of the former partials — `docs/COORDINATION-DESIGN.md` revision 4 (`cb1a3a0`), 2026-09-21

Scope: items 2, 4, 5, 6 of the blockers re-review plus the setIdentity follow-up. Verdict: **1 (follow-up) RESOLVED · 2 RESOLVED (three
text nits) · 4 PARTIAL · 5 PARTIAL · 6 PARTIAL.**

## 1 follow-up — `setIdentity` — RESOLVED
`setIdentity(patch): Promise<void>`; an added root is walked once (bounded `readdir` + parse on the ledger's promise chain, before the
change notification; a generation counter merges a pass in flight — records keyed by `deviceId/runId` and `leaseId` cannot duplicate);
the engine awaits it after `run:ready` before its first `coordinate`; `label` is in `IdentityPatch`. Benign asymmetry: the walk is the
poll's `MAX_DEVICES`-bounded path while the fence is not — a 17th device's exclusive lease is missing from `check().snapshot` and
surfaces in `appeared` at the fence (F1 yields; conservative).

## 2 — facade write API — RESOLVED (text nits)
Thirteen functions incl. `purgeInbox` (foreign messages marked seen locally, own sent files unlinked; the CLI never deletes directly);
`WorktreeInfo` / `SweepReport` / `GcReport` / `SyncStatus` typed; one `CoordinationError` with a closed 13-code union and the stated
result/throw/count rule; `gc({device})` resolves label | `label#id4` | id8 with `unknown-device` / `ambiguous-device` before any write;
`--i-know-it-is-gone` restored. Nits: (a) `setDeviceLabel(home, label)` has no `Ledger` parameter yet says it calls
`ledger.setIdentity({ label })`; (b) the label form of `gc --device` resolves over `fold.devices` (capped at `MAX_DEVICES`), so the junk
subtrees beyond the cap — §4.5's own remedy for `fence:'blind'` — cannot be named, and there is no bulk form; (c) `ignoreDevice` /
`unignoreDevice` have no rejects; nothing forbids ignoring my own `deviceId` (which would drop my own beats, leases and messages).

## 4 — strict fence — PARTIAL
F1/F2 are normative and hold: "a non-empty `appeared` always yields", `proceed = appeared.length === 0`, the readdir-after-rename proof;
one-sees (A proceeds, B waits for a real release); both-see (both downgrade, `min` over the same set, one re-declares, stable stamps →
no ping-pong); three-writer chain overlap (exactly one re-declares); `fence:'blind'` typed; `keyDir(repoKey ?? wsKey)` fallback present.
Cross-device crash-after-yield: the wake is `ttl + slack` (165 s) > `strictWaitMs` (60 s), so the survivor discards into the
`lease-conflict` pane — the liveness sentence is true same-device only. **Remaining scenario:** the fence, watch roots and `check()`
read a single `leases/*/<keyDir>/` directory while matching accepts a `wsKey` match "whenever either side lacks a `repoKey`"; two runs
in ONE checkout whose key computation diverges (unborn-HEAD/no-origin workspace gaining its first commit between run 1 and run 2, or a
`rev-list --max-parents=0` failure on one side) lease under different `keyDir`s, are mutually invisible, and both proceed. Fix: the
fence/watch enumerate `keyDir(wsKey)` as well as `keyDir(repoKey)` whenever both exist. Nits: the `seen: LeaseSnapshot` the F2 re-declare
passes is unspecified; §4.3 step 2's `check()` over "every live, unexpired lease" would return `conflict` on the peer's yielded `intent`
lease, escaped only by step 4's fiat.

## 5 — authenticated foreign records — PARTIAL
The key model is fixed: per-device keys (`deviceKey`, never mirrored), verification by the PATH `deviceId` only, `verified` never an input
to `ok`, pairwise transport-key exchange (no transitive distribution), the symmetric-HMAC residual stated and scheduled for Ed25519 in W5.
`MAX_CLAIM_EPOCH` 1e9 and the 64-cap (first + newest 63, strictly increasing appends) check out. Missing verb: there is no unpair/revoke
(only `pair --rotate`, which invalidates you to everyone) — removal is hand-editing or the `gc --device --i-know-it-is-gone` tombstone; the
consequences after removal are sound. **Remaining scenario — the same door:** §7.3 step 1(a) and §9.3 qualify a foreign epoch only when
`run.json` "carr[ies] a valid hmac from that device's key", but no `hmac`/`keyId` field is defined on `run.json` or the essential-set
projection (`hmac` exists on the five record kinds only; §9.3 itself says the sha256 envelope is "integrity, not authenticity"). So no
foreign claim can ever be qualified: fail-safe against the planted ceiling, but it silently disables the legitimate refusal M7 asserts;
and the `MAX_CLAIM_EPOCH` bound is attributed to `parseRecord`, which never sees the planted file — it must be restated for the run.json /
essential-set reader. Also `--force-takeback` mints above `max(every epoch it can see, qualified or not) + 1`, so a planted `epoch: 1e9`
makes it mint 1e9+1 — above the parse bound — with no clamp or refusal specified.

## 6 — self by read location / hostKey — PARTIAL
`hostKey = sha8(hostname, user, machineId)`, "a disqualifier only", `claim.deviceId` in the binding list, the mirror realpath rule
re-checked at every `open()` (TOCTOU residual only). Machine ids do collide (macOS `IOPlatformUUID` survives a VM file clone;
`/etc/machine-id` baked into golden images or duplicated by `wsl --export/--import`, where hostname and username also match), and the
unreadable-id fallback re-creates the two-input hash. **Remaining scenario:** in exactly that residual the `duplicate-identity` rule's
first clause cannot fire (equal hostKeys) and its second fires only "while `isPidAlive(pid)` is false" — with the foreign pid alive
locally (clones running the same workload allocate similar pids) the record stays same-device, the verdict is `stale-reused-pid`,
`takeRunLock` replaces A's live `run.lock` (only a MISSING bootId is protected) and two engines co-write one `state.json`; `Message`
carries no `pid`/`bootId`, so for `pause`/`end`/`steer` only the hostKey clause exists and a clone's `pause`/`end` applies with no `[y]`.
Both clones also share one `devices/<hostKey>/` subtree (one `deviceKey`), so hmac cannot separate them; `adoptDevice?` is reachable only
via the dead-pid coincidence. The discriminator that works is beat freshness/arrival (a previous boot of MY machine stops renewing; a live
clone does not), not `isPidAlive`.

## §7 follow-ups — applied as claimed
`outputEvicted` (§8.5); "up to 6 files and ≤ 88 KiB" with the fit computed before the read (§8.3); §8.2 re-costed at ~90.7k chars.
