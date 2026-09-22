# Adversarial re-check of `src/coordination/**` at 62f2064 (read-only)

Reviewer: an Opus subagent of the harness session, 2026-09-22, in a detached worktree. Two probe suites, 17 assertions,
8 defects reproduced. `file:line` are `src/coordination/…` at 62f2064. Previous review:
`review-2026-09-21.md` (B1–B6, M7–M19, minors 20–26); design: `docs/COORDINATION-DESIGN.md` revision 5 (9d1dbae).
Deliberately out of scope (a parallel branch implements them): the dual-directory lease write, `check()` holding-types
only, FenceYield/fenceWake, the `claims` record kind, bootId/clones, the §3.1 layout, `setIdentity({repoKey})`.

## Defects, most severe first

1. **CONFIRMED — trusted devices past `MAX_DEVICES` starve forever (M19 rotation incomplete).** `ledger.ts:810`
   `head` = self + every trusted device in sorted-id order, truncated with no rotation; only `rest` rotates and gets
   `slots = max(0, cap − head.length)` = 0 once `head` fills the cap. Probe: 20 paired devices, 12 `refresh('all')`
   passes → four devices never appear in `fold.live`. The M19 fixture (`ledger.test.ts:398`) plants only untrusted
   devices. Fix: rotate `head` too, or exempt paired devices from the cap and apply it only to `rest`.
2. **CONFIRMED — `ignoreDevice` does not restore the strict fence; the claim at `ledger.ts:115-116` is false.**
   `pickDevices` gets the unfiltered `all` (`:720`) and `fence.complete = false` is derived from
   `devices.length < all.length` (`:724`), both counting ignored subtrees. Probe: 6 junk lease subtrees +
   `refreshFence({maxDevices: 4})` → `complete: false`; after ignoring all six → still `false` → permanent
   `fence:'blind'`. Fix: filter `this.ignored` out of `all` before `pickDevices` and before the comparison.
3. **CONFIRMED (code) — the general scan caps leases at 16 and then sweeps the subtrees it skipped.** `ledger.ts:719`
   `cap = kind === 'leases' ? deviceCap : MAX_DEVICES` with `deviceCap = bounds.maxDevices ?? MAX_DEVICES` (16 for
   `scan('all')`; only `refreshFence` passes 256). `:769-779` then deletes every entry not in `seen` unless
   `this.partial`, which only the time budget sets (`:668`). With > 16 subtrees each 15 s poll drops a rotating subset
   of peers' heartbeats and live exclusive leases from `this.entries`, so advisory `check()` reads `clear` for paths
   a live peer holds. Fix: treat a cap-skipped subtree like a partial one (not `completed`, a `capped` flag honoured
   by the prune loop) and pass `MAX_FENCE_DEVICES` for `leases` in the general scan.
4. **CONFIRMED — B6's bench-lock O_EXCL fix still admits two runners.** `subwork.ts:176-198`: when
   `verdict !== 'free'` the code `unlinkSync(path)` unconditionally, then O_EXCL-creates; the re-judge runs only on
   `EEXIST`, which cannot happen after the unlink. Interleaving: A and B read stale L0 → A unlinks L0, creates LA →
   B (stale verdict) unlinks LA, creates LB → both acquire. Fix: compare-and-swap — re-read and re-`evaluate`
   immediately before the unlink, or unlink only after confirming the file still holds the exact stale record.
5. **CONFIRMED — a hostile `ttlMs` outlives B4's removal of the expiry gate.** `records.ts:308` accepts `ttlMs` up
   to `COUNTER_MAX` (≈ 11.6 days); `isLive` uses `record.ttlMs + slack` (`:554`); `check()` gates only on
   `liveHolder` (`leases.ts:130`). Probe: a foreign heartbeat with `ttlMs: 1e9` plus an `exclusive` lease whose
   `expiresAt` is 10 days past still yields `hard` conflict. Fix: clamp the honoured ttl in `isLive`
   (`min(record.ttlMs, k × HEARTBEAT_TTL_MS)`) or bound `ttlMs` in `checkHeartbeat`.
6. **CONFIRMED — M16's adopt ceiling only buys 1000 stamps, and adoption is not trust-qualified.**
   `records.ts:133` admits any observed `n < COUNTER_MAX − 1000`; `maxStampN` (`fold.ts:272`) folds foreign
   leases/messages/acks with no authority filter. Probe: `observe(999_998_999)` then 1100 `issue()` → 1001 distinct
   values, then flat. `leaseId = ${runId}-${stamp.n}` (`leases.ts:220`) and `id = ${deviceId}-${actor8}-${stamp.n}`
   (`mailbox.ts:96`) then collide: every later `declare` overwrites the previous lease file and `seenIds` dedupe
   (`fold.ts:253`) drops every message after the first. Fix: adopt only from `self`/`trusted` origins and bound the
   adopted delta (e.g. `own + 1e6`).
7. **CONFIRMED — `worktree.ts` reintroduces the M13 colon bug.** `worktree.ts:166` and `:184` use the raw
   `repoKey` while `paths.worktreeFile` (`paths.ts:145`) uses `keyDir(repoKey)`. Probe: `createWorktree` with a
   `ws:` key → ENOENT (mkdir made `worktrees/ws:…/`, the write targeted `worktrees/ws-…/`). Bare-hex keys hide it.
   Fix: `keyDir(repoKey)` at both sites.
8. **CONFIRMED — the shared-dir mirror never bootstraps.** `sync-shared-dir.ts:127` `probe()` stats
   `<sharedDir>/jevcode-commons`, ENOENT → `fail()` → `offline`; `copy()`/`remove()` return early while offline;
   `retry()` re-probes. Nothing ever `mkdir`s the root. Fix: `mkdir(root, DIR_MODE)` inside `probe()` before the
   realpath containment check.
9. **CONFIRMED — a sessionless consumer mints a fresh `actor8` per process.** `ledger.ts:374` → `ids.ts:118`
   `actor8Of(null)` = random. Two handles on one home → two consumer ids, so `inbox/seen/tui-<random>.json` is new
   on every launch: every unexpired broadcast re-toasts on every TUI start and `inbox/seen/` grows one file per
   launch forever (`gc()` walks only `ownEntries()`). Fix: persist the TUI actor8 (e.g. in `machine.json`) and GC
   `inbox/seen/` by mtime.
10. **CONFIRMED (code) — trust is one-way at runtime (M11's mid-run gap).** `unpairDevice` reloads `trustKeys` and
    clears `sigs` (`ledger.ts:1311-1313`), but there is no `pairDevice` on `LedgerHandle` and `trustKeys` is read
    only in `open()` (`:456`). After `trustDevice(...)` a running process keeps that device `unverified` until
    restart, and `sigs` is not cleared so `refresh` will not re-parse. Fix: `pairDevice`/`reloadTrust` mirroring
    `unpairDevice`.

## Lower

- `mailbox.ts:272` `purgeInbox` reconstructs the rel from `m.t`/`m.stamp.n` instead of `e.path`; `removeOwn`
  swallows ENOENT, so `report.removed++` fires when nothing was deleted.
- `records.ts:459` `parseRecord` does not reject unknown keys (an extra `constructor` key parses); no prototype
  pollution is reachable, but arbitrary JSON rides into memory and into the checksum/HMAC canonical text.
- `records.ts:446` `locationMatches('ack')` binds `deviceId`/`stamp.deviceId` only; the `<msgId>` directory
  component is unchecked.
- `claims.ts:104` `rows.slice(-(o.max ?? CLAIMS_MAX))` — `o.max === 0` becomes `slice(-0)` = the whole array.
- `claims.ts:48` `isValidClaim` does not validate `startedAt`'s shape; a forged `""` sorts first in `compareClaim`
  (display only; `forkVerdict.verified` still gates the stop).
- `ledger.ts:721` `devicesSkipped` accumulates across stores × kinds (up to 4× over-reported).
- `ledger.ts:589` a failed `fs.watch` root is re-`add`ed on every 15 s `attachWatchers()` — under EMFILE a silent
  repeating syscall storm.

## Verified as holding

B1 (`enqueueScan`/`scanTail` chaining; `pollGeneration` re-walk covers a mid-pass `setIdentity`); B3 acks (untrusted
ack never deletes a pending targeted message; replay idempotent; cross-msgId copy gains nothing); B5/B6
self-by-location (`originOf` requires `source === null` and the device subtree and `sameHost`; mirror realpath
refusal holds); HMAC path binding (a record's own `keyId` is never consulted); parser bounds (oversize, `Infinity`,
NFC/traversal/option-leading/`laneDir` refusals); M7 verified-only default; M10 time-budget half of the partial-scan
sweep; M17 health split and `fs.watch` ENOSYS/EMFILE → info notice, never `⇄ off`.
