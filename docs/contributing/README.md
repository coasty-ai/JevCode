# Contributing

This page is how to work on this tree: the gates a change must pass, the rules the modules keep, and the two
conventions that exist because ignoring them has already cost time.

Read [Module ownership and import rules](architecture-rules.md) alongside this. It has the dependency rules
that are asserted by a script rather than left to convention, and a map of the system.

## Setting up

```sh
nvm use      # Node 22.23.2, pinned in .nvmrc
npm ci
```

Node 22.12 or newer is required; the launcher refuses anything older with exit code 2. There are **zero runtime
dependencies** — the rendering library and its React peer are bundled at build time — so `npm ci` installs only
the toolchain.

## The gates

One command runs all of them:

```sh
npm run check
```

That is exactly five things, in order:

| step | command | what it enforces |
| --- | --- | --- |
| 1 | `tsc -p tsconfig.json --noEmit` | the TypeScript project typechecks under its strict settings |
| 2 | `node scripts/no-any.mjs` | **no `any` anywhere** in `src/`, `test/`, `perf/` or `scripts/` |
| 3 | `node scripts/jev-contract.mjs` | every decision call site is either annotated or grandfathered, and no question id is one of the forbidden ones |
| 4 | `node scripts/check-doc-links.mjs` | every relative link in `README.md` and `docs/**` resolves to a file that exists |
| 5 | `vitest run --project unit` | the unit suite |

Steps 1 and 2 are both `npm run typecheck`. Steps 3, 4 and 5 are `npm run jev-contract`,
`npm run check:docs` and `npm test`.

Two more suites exist and are not in `npm run check`:

| command | what it runs | why it is separate |
| --- | --- | --- |
| `npm run test:pty` | scenarios driven through a real pseudo-terminal | macOS only, sequential, slow |
| `npm run test:live` | tests that call real APIs | needs keys and spends money; skips with a printed reason when no key is present |

And the performance gate:

```sh
npm run perf         # builds, then measures; exits 1 when any gate fails
```

See [the performance page](../measurements/performance.md) for what it measures and what a release number
needs that a working number does not.

### No `any`, and what counts as one

The check is a line scanner, not a type check, and it is deliberately blunt. It matches `: any`, `as any`,
`<any>`, `any[]`, `Array<any>`, `Record<…, any>` and `Promise<any>`. A line carrying the marker `no-any-ok`
is exempt — use it when a third-party type genuinely forces your hand, and not otherwise.

### A new decision call site carries its own proof

The decision model is a **router, never an authority**. That is not a slogan; it is enforced at build time.

Every call site introduced or moved satisfies four clauses, and proves them in a comment block directly above
the call:

| clause | meaning |
| --- | --- |
| **escape** | code enumerates the options. The choice is built by the builder in `src/jev/questions.ts`, which guarantees the escape option and the paired yes/no questions. Nothing hand-builds a question literal. |
| **guard** | a code guard runs *after* the answer, and it can only tighten. The answer is never the last word. |
| **fallback** | a deterministic code fallback is named at the site, together with the unit test that covers it. |
| **no-gating** | being wrong costs wall-clock, never correctness. A router orders; it does not gate completion or acceptance. |

The block looks like this:

```
// jev-contract: R1 run_first (§3.x)
//   escape: choice() over the code-built scopes — the escape option, argmax only beyond the 0.05 margin
//   guard: the scope-usability check and the code deny-list run after the answer
//   fallback: scopeBuilderFor()'s narrowest code scope, then the full suite; test: test/unit/jev-modes/synth/oracle/scope.test.ts
//   no-gating: ordering only — completion stays a code fact about the harness's own test run
```

Call sites that predate this rule are grandfathered by an allow-list in `scripts/jev-contract.mjs`, **by file
and by count**, each row carrying its reason. A file that grows an extra un-annotated call fails the gate,
which is the point.

**The ratchet is two-sided.** When you convert a grandfathered site to a real four-clause block, you also
**remove or tighten its allow-list row in the same commit**. The lint counts un-annotated sites per file and
fails when a row grandfathers more than the file actually has, so a half-done conversion is caught rather than
silently widening the allowance.

A set of question ids is forbidden outright, anywhere: anything that would make a probability the thing that
approves an action or declares a task done.

Current state of the gate:

```
jev-contract: ok (37 Jev call site(s): 14 with a four-clause block, 23 allow-listed)
```

## Where a change may live

Three directories have hard import rules, three more have ownership rules, and one file is the contract.
Details and the verification commands are in [Module ownership and import rules](architecture-rules.md). The
short version:

- `src/workspace/git.ts` is the only module that spawns git through the sandbox, with one documented exception.
- `src/orchestrate/**`, `src/coordination/**` and `src/import/**` never import the surface or the configuration
  layer. Every environmental fact arrives as an argument.
- `src/import/**` performs no writes at all. Writes go through an injected seam.
- `src/core/types.ts` is the single contract file. Nothing else declares a contract shape.

## Two conventions that exist because ignoring them cost time

### Shared files arrive as hunks, not as concurrent edits

A handful of files are edited by one owner at a time: the step loop's engine, the checkpoint store, the core
types (other than a caller's own contract block), and the shared error module. Work that needs a change in one
of those sends the **exact hunks** it needs, and the owner lands them — or the change is committed alone at a
known hash and the other work rebases over it.

This is not politeness. Two concurrent edits to one engine file in one checkout blocked a merge for an hour
over an uncommitted type block, and shipped a raw line-separator character inside a regular-expression literal
that TypeScript accepts and the bundler does not — taking about forty test files down on a clean checkout while
the shared tree looked green. There is now a hygiene test that scans for exactly that character class, and the
rule is: **an uncommitted edit in a shared file is a merge blocker.**

### Timing assertions on a shared machine

Unit suites run with a bounded worker count, because unbounded concurrent runs manufacture failures in tests
that were green moments earlier. Wall-clock assertions take the **best of N samples**, and some skip themselves
when the load average exceeds the core count.

Two consequences, both binding:

- A gate that still fails best-of-N is a **real** regression, not noise.
- **Release performance numbers come only from `npm run perf` under its quiet-load condition**, never from a
  unit test.

When more than one long job might run on one machine, the convention is a sentinel file: while
`/tmp/jevcode-perf-window-open` exists, nothing that competes for the machine starts.

## Committing

- **Stage explicit paths.** Never `git add -A`. A generated file or a local scratch file in a commit is a real
  cost to the next person.
- **Never `git stash`** in a tree that anything else might be using. Use a temporary commit instead.
- **Branch from current `main`, merge `main` before your final gates, and re-run every gate on the merged
  tree.** A gate run before the merge is a statement about a tree nobody will have.

## Writing a test that proves something

The convention in this tree is to **label a test by what it establishes**, because the labels are not
interchangeable:

| label | meaning |
| --- | --- |
| **failing-first by mechanism** | it fails on the previous source *with the symbol present*, for the reason the fix names. This is the only label that proves the fix does something. |
| **regression pin** | it passes before and must keep passing. |
| **regression pin, labelled a deliberate behaviour change** | the behaviour did change; the test measures the change rather than denying it. |
| **fixture property** | it asserts what the corpus contains, not what the code does. |
| **assertion that a hole is open** | it records a known defect so that closing it is a visible diff. |

A test that fails on the previous source only because a symbol did not exist yet is **not** a failing-first
record, and saying so in the test name is part of the job.

## Docs that must stay current

| file | when it changes |
| --- | --- |
| `CHANGELOG.md` | every release; the curated record, distinct from generated release notes |
| [`docs/DECISIONS.md`](../DECISIONS.md) | whenever a default moves, a claim is withdrawn, or a rule is written down. Regenerate its table of contents with `node scripts/gen-decisions-toc.mjs` |
| the design document your change touches | the as-built sections; a citation that has gone stale is marked stale rather than quietly rewritten |
| [`docs/measurements/performance.md`](../measurements/performance.md) | after every complete `npm run perf`; the numbers are transcribed from `perf/results/latest.json`, which the probe writes. `npm run perf` also rewrites a `## Performance` section of `README.md` when one exists — today's `README.md` has none, and the probe says so rather than failing |

## Related

- [Module ownership and import rules](architecture-rules.md)
- [Releasing](releasing.md)
- [Normative design documents](../design/README.md)
- [Measurements](../measurements/README.md)
